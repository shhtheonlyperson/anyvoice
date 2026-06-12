"""YouTube reference import: URL parsing, section download, caption planning.

Python port of lib/youtube-import.ts so the ComfyUI pipeline behaves exactly
like the web app's /api/voice-profile/enroll/youtube route: parse the URL
(+ t/start param), download just the needed audio section and subtitles via
yt-dlp, chunk overlapping captions into 6–18s reference segments aligned to cue
boundaries, and fall back to fixed-length slices + ASR when captions are
missing.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse, parse_qs

from . import env

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _js_round(value: float) -> int:
    """JS Math.round (half away from zero for positives) — Python's round()
    uses banker's rounding and would drift from the web app on .5 values."""
    import math

    return math.floor(value + 0.5)

# Reference window length and the enrollment 6–20s sweet spot.
DEFAULT_WINDOW_SEC = 12
MIN_WINDOW_SEC = 6
MAX_WINDOW_SEC = 20

# Scan window: grab a longer span and auto-chunk it into several clips.
DEFAULT_SCAN_SEC = 180
MIN_SCAN_SEC = 30
MAX_SCAN_SEC = 300
# Per-clip duration band used when chunking the scan window.
SEGMENT_TARGET_SEC = 14
SEGMENT_MIN_SEC = 6
SEGMENT_MAX_SEC = 18


class YoutubeImportError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ParsedYoutubeUrl:
    video_id: str
    start_seconds: int


@dataclass
class VttCue:
    start: float
    end: float
    text: str


@dataclass
class PlannedSegment:
    start: float  # absolute video time, seconds
    end: float
    text: str


@dataclass
class RunResult:
    code: int | None
    stdout: str
    stderr: str
    spawn_error: Exception | None = None


def parse_time_param(value: str | None) -> int:
    """'300' | '300s' | '5m0s' | '1h2m3s' | '5:00' | '1:05:00' → seconds (0 on junk)."""
    if value is None:
        return 0
    raw = str(value).strip().lower()
    if not raw:
        return 0
    if re.fullmatch(r"\d+", raw):
        return int(raw)
    if re.fullmatch(r"\d+s", raw):
        return int(raw[:-1])
    if ":" in raw:
        parts = raw.split(":")
        if len(parts) > 3 or any(not re.fullmatch(r"\d+", p) for p in parts):
            return 0
        seconds = 0
        for part in parts:
            seconds = seconds * 60 + int(part)
        return seconds
    match = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", raw)
    if not match or not any(match.groups()):
        return 0
    h, m, s = (int(g) if g else 0 for g in match.groups())
    return h * 3600 + m * 60 + s


def parse_youtube_url(raw: str) -> ParsedYoutubeUrl | None:
    """watch / youtu.be / shorts / embed / v forms → (videoId, startSeconds)."""
    if not raw or not isinstance(raw, str):
        return None
    try:
        url = urlparse(raw.strip())
    except ValueError:
        return None
    if url.scheme not in ("http", "https") or not url.hostname:
        return None
    host = url.hostname.removeprefix("www.")
    query = parse_qs(url.query)

    video_id: str | None = None
    if host == "youtu.be":
        path = url.path.lstrip("/")
        video_id = path.split("/")[0] or None
    elif host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        if url.path == "/watch":
            video_id = (query.get("v") or [None])[0]
        else:
            match = re.match(r"^/(?:shorts|embed|v)/([^/]+)", url.path)
            video_id = match.group(1) if match else None
    if not video_id or not VIDEO_ID.fullmatch(video_id):
        return None

    t_value = (query.get("t") or query.get("start") or [None])[0]
    return ParsedYoutubeUrl(video_id=video_id, start_seconds=parse_time_param(t_value))


def clamp_scan_window(start: float, duration_seconds: float | None = None) -> tuple[int, int]:
    """Clamp the scan window (default 180s, 30–300s)."""
    safe_start = max(0, int(start or 0))
    requested = duration_seconds if duration_seconds and duration_seconds > 0 else DEFAULT_SCAN_SEC
    window = min(MAX_SCAN_SEC, max(MIN_SCAN_SEC, _js_round(requested)))
    return safe_start, safe_start + window


def _parse_vtt_timestamp(value: str) -> float | None:
    match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?", value.strip())
    if not match:
        return None
    h, mm, ss, ms = match.groups()
    return int(h or 0) * 3600 + int(mm) * 60 + int(ss) + (float(f"0.{ms}") if ms else 0.0)


def _clean_cue_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    for entity, replacement in (
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
        ("&#39;", "'"), ("&apos;", "'"), ("&quot;", '"'),
    ):
        text = text.replace(entity, replacement)
    return re.sub(r"\s+", " ", text).strip()


def parse_vtt(content: str) -> list[VttCue]:
    cues: list[VttCue] = []
    blocks = re.split(r"\n\n+", content.replace("\r\n", "\n"))
    for block in blocks:
        lines = block.split("\n")
        timing_index = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if timing_index is None:
            continue
        start_raw, _, end_raw = lines[timing_index].partition("-->")
        start = _parse_vtt_timestamp(start_raw)
        end_token = end_raw.strip().split()[0] if end_raw.strip() else ""
        end = _parse_vtt_timestamp(end_token)
        if start is None or end is None:
            continue
        text = _clean_cue_text(" ".join(lines[timing_index + 1 :]))
        if text:
            cues.append(VttCue(start=start, end=end, text=text))
    return cues


def plan_segments(
    cues: list[VttCue],
    window_start: float,
    window_end: float,
    target: float = SEGMENT_TARGET_SEC,
    seg_min: float = SEGMENT_MIN_SEC,
    seg_max: float = SEGMENT_MAX_SEC,
) -> list[PlannedSegment]:
    """Chunk overlapping cues into caption-aligned ~6–18s segments, deduping the
    rolling-duplicate lines YouTube auto-captions emit. [] → caller falls back
    to fixed-length ASR slicing."""
    picked = sorted(
        (c for c in cues if c.end > window_start and c.start < window_end),
        key=lambda c: c.start,
    )
    if not picked:
        return []

    segments: list[PlannedSegment] = []
    cur_start: float | None = None
    cur_end = 0.0
    cur_texts: list[str] = []

    def add_text(text: str) -> None:
        last = cur_texts[-1] if cur_texts else None
        if text == last:
            return
        if last and (last.endswith(text) or text.startswith(last)):
            cur_texts[-1] = text if len(text) >= len(last) else last
            return
        cur_texts.append(text)

    def flush() -> None:
        nonlocal cur_start, cur_end, cur_texts
        if cur_start is None:
            return
        end = min(cur_end, cur_start + seg_max)
        text = re.sub(r"\s+", " ", " ".join(cur_texts)).strip()
        if text:
            segments.append(PlannedSegment(start=cur_start, end=end, text=text))
        cur_start = None
        cur_end = 0.0
        cur_texts = []

    for cue in picked:
        c_start = max(cue.start, window_start)
        c_end = min(cue.end, window_end)
        if cur_start is not None and c_end - cur_start > seg_max:
            flush()
        if cur_start is None:
            cur_start = c_start
        cur_end = c_end
        add_text(cue.text)
        if cur_end - cur_start >= target:
            flush()
    flush()

    # Merge a too-short trailing segment into the previous one when possible;
    # otherwise drop sub-min fragments (too short for the analyzer).
    usable: list[PlannedSegment] = []
    for seg in segments:
        if seg.end - seg.start >= seg_min:
            usable.append(seg)
            continue
        prev = usable[-1] if usable else None
        if prev and seg.end - prev.start <= seg_max:
            prev.end = seg.end
            prev.text = re.sub(r"\s+", " ", f"{prev.text} {seg.text}").strip()
    return usable


def select_cues_text(cues: list[VttCue], window_start: float, window_end: float) -> str:
    """Concatenate overlapping cues into one transcript, deduping rolled lines."""
    picked = sorted(
        (c for c in cues if c.end > window_start and c.start < window_end),
        key=lambda c: c.start,
    )
    out: list[str] = []
    for cue in picked:
        last = out[-1] if out else None
        if cue.text == last:
            continue
        if last and (last.endswith(cue.text) or cue.text.startswith(last)):
            out[-1] = cue.text if len(cue.text) >= len(last) else last
            continue
        out.append(cue.text)
    return re.sub(r"\s+", " ", " ".join(out)).strip()


def pick_subtitle_file(files: list[str]) -> tuple[str, str] | None:
    """Best subtitle file: manual Traditional first, then any zh, then any. → (path, lang)"""
    vtts = [f for f in files if f.lower().endswith(".vtt")]
    if not vtts:
        return None

    def lang(f: str) -> str:
        match = re.search(r"\.([A-Za-z-]+)\.vtt$", f, re.IGNORECASE)
        return (match.group(1) if match else "").lower()

    def score(f: str) -> int:
        l = lang(f)
        if l in ("zh-hant", "zh-tw"):
            return 0
        if l.startswith("zh"):
            return 1
        if l:
            return 2
        return 3

    best = sorted(vtts, key=score)[0]
    return best, lang(best)


def plan_fixed_slices(
    window_seconds: float,
    target: float = SEGMENT_TARGET_SEC,
    seg_min: float = SEGMENT_MIN_SEC,
    seg_max: float = SEGMENT_MAX_SEC,
) -> list[tuple[float, float]]:
    """No captions: fixed ~target-second (rel_start, duration) slices for ASR."""
    span = max(0, int(window_seconds))
    if span < seg_min:
        return []
    count = max(1, _js_round(span / target))
    size = min(seg_max, max(seg_min, span // count))
    slices: list[tuple[float, float]] = []
    offset = 0.0
    while offset + seg_min <= span:
        slices.append((offset, min(size, span - offset)))
        offset += size
    return slices


def slice_audio_segment(
    src_wav: Path,
    rel_start: float,
    duration: float,
    out_path: Path,
    timeout_sec: float = 30.0,
) -> None:
    """Extract [rel_start, rel_start+duration] as 16k mono pcm_s16le wav."""
    ffmpeg = env.ffmpeg_path()
    args = [
        ffmpeg, "-y",
        "-ss", str(max(0.0, rel_start)),
        "-t", str(max(0.1, duration)),
        "-i", str(src_wav),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(out_path),
    ]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout_sec)
    except FileNotFoundError:
        raise YoutubeImportError("ffmpeg is not installed: brew install ffmpeg", 500)
    except subprocess.TimeoutExpired:
        raise YoutubeImportError("ffmpeg slice timed out", 502)
    if proc.returncode != 0:
        detail = (proc.stderr.strip() or proc.stdout.strip())[:200]
        raise YoutubeImportError(f"ffmpeg slice failed: {detail}", 502)


def _run_ytdlp(args: list[str], timeout_sec: float) -> RunResult:
    binary = env.ytdlp_path()
    try:
        proc = subprocess.run([binary, *args], capture_output=True, text=True, timeout=timeout_sec)
    except FileNotFoundError as exc:
        return RunResult(code=None, stdout="", stderr="", spawn_error=exc)
    except subprocess.TimeoutExpired as exc:
        return RunResult(
            code=None,
            stdout=(exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            stderr="yt-dlp timed out",
        )
    return RunResult(code=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def _friendly_ytdlp_error(result: RunResult) -> YoutubeImportError:
    if isinstance(result.spawn_error, FileNotFoundError):
        return YoutubeImportError("yt-dlp is not installed: brew install yt-dlp", 500)
    detail = f"{result.stderr}\n{result.stdout}"
    if re.search(r"Sign in to confirm|age|inappropriate", detail, re.IGNORECASE):
        return YoutubeImportError("this video is age-restricted and cannot be imported", 422)
    if re.search(r"not available in your country|geo|region", detail, re.IGNORECASE):
        return YoutubeImportError("this video is region-locked and cannot be imported", 422)
    if re.search(r"Private video|members-only|Join this channel|login|cookies", detail, re.IGNORECASE):
        return YoutubeImportError("this video is private or members-only and cannot be imported", 422)
    if re.search(r"Video unavailable|does not exist|Incomplete YouTube ID", detail, re.IGNORECASE):
        return YoutubeImportError("this video is unavailable", 404)
    trimmed = result.stderr.strip() or result.stdout.strip()
    return YoutubeImportError(
        f"yt-dlp failed: {trimmed[:300]}" if trimmed else "yt-dlp failed", 502
    )


def download_youtube_reference(
    video_id: str,
    start: int,
    end: int,
    run_dir: Path,
    timeout_sec: float = 90.0,
) -> tuple[Path, list[Path]]:
    """Download the [start, end] audio section (wav) + subtitles into run_dir.

    Two passes so a subtitle failure does not lose the audio and vice versa.
    Returns (wav_path, subtitle_files). Raises YoutubeImportError on failure.
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    ffmpeg = env.ffmpeg_path()

    # Pass A: section audio -> wav.
    audio_result = _run_ytdlp(
        [
            "--download-sections", f"*{start}-{end}",
            "--force-keyframes-at-cuts",
            "-f", "bestaudio/best",
            "-x", "--audio-format", "wav",
            "--no-playlist", "--no-progress",
            "--ffmpeg-location", ffmpeg,
            "-o", str(run_dir / "youtube-section.%(ext)s"),
            url,
        ],
        timeout_sec,
    )
    if audio_result.code != 0:
        raise _friendly_ytdlp_error(audio_result)

    # Pass B: subtitles only (best-effort — missing captions are not fatal).
    _run_ytdlp(
        [
            "--skip-download",
            "--write-auto-subs", "--write-subs",
            "--sub-langs", "zh-Hant,zh-TW,zh-Hans,zh-CN,zh.*,zh,en.*,en",
            "--sub-format", "vtt", "--convert-subs", "vtt",
            "--no-playlist",
            "--ffmpeg-location", ffmpeg,
            "-o", str(run_dir / "youtube"),
            url,
        ],
        timeout_sec,
    )

    wav_path = run_dir / "youtube-section.wav"
    if not wav_path.exists():
        raise YoutubeImportError("yt-dlp produced no audio for the requested section", 502)
    subtitle_files = sorted(
        p for p in run_dir.iterdir()
        if p.name.startswith("youtube") and p.name.lower().endswith(".vtt")
    )
    return wav_path, subtitle_files


def transcribe_audio_file(audio_path: Path, language: str = "zh", timeout_sec: float = 600.0) -> str:
    """ASR fallback via scripts/transcribe_audio_anyvoice.py. '' on failure so
    the caller can degrade gracefully."""
    python = env.asr_python()
    script = env.repo_root() / "scripts" / "transcribe_audio_anyvoice.py"
    args = [
        python, str(script),
        "--audio", str(audio_path),
        "--language", language,
        "--model", env.asr_model(),
    ]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout_sec, cwd=env.repo_root()
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0 or not proc.stdout.strip():
        return ""
    try:
        parsed = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return ""
    return str(parsed.get("transcript") or "").strip()


@dataclass
class ImportedClip:
    wav_path: Path
    transcript: str
    rel_start: float
    duration: float


def gate_and_slice_planned(
    planned: list[tuple[float, float, str]],
    section_wav: Path,
    base_run_dir: Path,
    max_clips: int = 10,
    convert: Callable[[str], str] | None = None,
    gate: Callable[[str], list[str]] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
    check_interrupted: Callable[[], None] | None = None,
) -> tuple[list[ImportedClip], list[dict]]:
    """Shared clip-finishing core: convert each planned (rel_start, duration,
    transcript) through OpenCC, apply the strict zh-Hant gate, and slice passing
    clips to 16k mono wavs. Like the web route, only the first max_clips planned
    segments are considered — gated-out clips are not back-filled."""
    convert = convert or (lambda text: text)
    gate = gate or (lambda text: [])
    clips: list[ImportedClip] = []
    skipped: list[dict] = []
    for rel_start, duration, raw_text in planned[:max_clips]:
        if check_interrupted:
            check_interrupted()
        transcript = convert(raw_text).strip()
        if not transcript:
            skipped.append({"reason": "empty", "transcript": raw_text})
            continue
        errors = gate(transcript)
        if errors:
            # Same catch-all as the web route: only unproven keeps its own
            # label; simplified/mixed AND non-Chinese both map to
            # simplified_or_mixed so comfy and web sidecars agree.
            reason = (
                "unproven_chinese_script"
                if "unproven_chinese_script" in errors
                else "simplified_or_mixed"
            )
            skipped.append({"reason": reason, "transcript": transcript})
            continue
        clip_path = base_run_dir / f"clip-{len(clips):03d}.wav"
        slice_audio_segment(section_wav, rel_start, duration, clip_path)
        clips.append(
            ImportedClip(wav_path=clip_path, transcript=transcript, rel_start=rel_start, duration=duration)
        )
        if on_progress:
            on_progress(75 + round(20 * len(clips) / max_clips), 100, f"sliced clip {len(clips)}")
    return clips, skipped


@dataclass
class YoutubeImportResult:
    base_run_dir: Path
    section_wav: Path
    clips: list[ImportedClip]
    skipped: list[dict]
    transcript_source: str  # override | captions | asr
    subtitle_lang: str | None
    video_id: str
    start_seconds: int
    end_seconds: int


def import_youtube_reference(
    url: str,
    start_seconds: int | None = None,
    scan_seconds: float | None = None,
    transcript_override: str = "",
    language: str = "zh",
    max_clips: int = 10,
    convert_simplified: Callable[[str], str] | None = None,
    strict_script_errors: Callable[[str], list[str]] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
    check_interrupted: Callable[[], None] | None = None,
) -> YoutubeImportResult:
    """The full ingest pipeline of the enroll/youtube route, minus enrollment:
    download section + captions, plan clip segments (override | captions | ASR),
    convert Simplified→Traditional, apply the strict zh-Hant gate, and slice
    16k mono clip wavs into the base run dir."""

    def progress(done: int, total: int, message: str) -> None:
        if on_progress:
            on_progress(done, total, message)

    def interrupted() -> None:
        if check_interrupted:
            check_interrupted()

    parsed = parse_youtube_url(url)
    if parsed is None:
        raise YoutubeImportError("valid YouTube URL required", 400)
    start = parsed.start_seconds if start_seconds is None or start_seconds < 0 else int(start_seconds)
    window_start, window_end = clamp_scan_window(start, scan_seconds)

    base_run_dir = env.runs_root() / env.new_job_id()
    base_run_dir.mkdir(parents=True, exist_ok=False)

    progress(0, 100, "downloading audio section")
    section_wav, subtitle_files = download_youtube_reference(
        parsed.video_id, window_start, window_end, base_run_dir
    )
    interrupted()
    progress(25, 100, "planning clips")

    window_span = window_end - window_start
    planned: list[tuple[float, float, str]] = []  # (rel_start, duration, transcript)
    transcript_source = "captions"
    subtitle_lang: str | None = None

    if transcript_override.strip():
        transcript_source = "override"
        planned.append((0.0, min(SEGMENT_MAX_SEC, window_span), transcript_override.strip()))
    else:
        picked = pick_subtitle_file([str(p) for p in subtitle_files])
        cues: list[VttCue] = []
        if picked:
            subtitle_path, subtitle_lang = picked
            cues = parse_vtt(Path(subtitle_path).read_text(encoding="utf-8"))
        segments = plan_segments(cues, window_start, window_end) if cues else []
        if segments:
            transcript_source = "captions"
            for seg in segments:
                planned.append((seg.start - window_start, seg.end - seg.start, seg.text))
        else:
            transcript_source = "asr"
            slices = plan_fixed_slices(window_span)[:max_clips]
            total = len(slices) or 1
            for index, (rel_start, duration) in enumerate(slices):
                interrupted()
                slice_path = base_run_dir / f"asr-slice-{int(rel_start)}.wav"
                slice_audio_segment(section_wav, rel_start, duration, slice_path)
                text = transcribe_audio_file(slice_path, language=language)
                progress(25 + round(50 * (index + 1) / total), 100, f"transcribing slice {index + 1}/{total}")
                if text:
                    planned.append((rel_start, duration, text))

    if not planned:
        raise YoutubeImportError(
            "no captions found and transcription failed — provide a transcript override",
            422,
        )

    clips, skipped = gate_and_slice_planned(
        planned,
        section_wav,
        base_run_dir,
        max_clips=max_clips,
        convert=convert_simplified,
        gate=strict_script_errors,
        on_progress=on_progress,
        check_interrupted=check_interrupted,
    )

    result = YoutubeImportResult(
        base_run_dir=base_run_dir,
        section_wav=section_wav,
        clips=clips,
        skipped=skipped,
        transcript_source=transcript_source,
        subtitle_lang=subtitle_lang,
        video_id=parsed.video_id,
        start_seconds=window_start,
        end_seconds=window_end,
    )

    provenance = {
        "url": url,
        "videoId": parsed.video_id,
        "startSeconds": window_start,
        "endSeconds": window_end,
        "transcriptSource": transcript_source,
        "subtitleLang": subtitle_lang,
        "clips": [
            {
                "wav": clip.wav_path.name,
                "durationSec": clip.duration,
                "transcript": clip.transcript,
                "relStart": clip.rel_start,
            }
            for clip in clips
        ],
        "skipped": skipped,
        "importedAt": _utc_now_iso(),
        "importedVia": "comfyui-anyvoice",
    }
    (base_run_dir / "youtube-import.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    progress(100, 100, "import complete")
    return result

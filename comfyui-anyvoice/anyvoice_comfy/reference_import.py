"""Reference import from a local audio source (uploaded file or mic recording).

Bridges any ComfyUI AUDIO (LoadAudio: mp3/m4a/wav/mp4…; RecordAudio: browser
mic) into the same clip pipeline the YouTube path uses: plan clip segments,
convert transcripts with OpenCC, apply the strict zh-Hant gate, and slice 16k
mono reference wavs into a run dir. Mirrors the web app's upload/freeform rules:
a typed transcript covers a short (≤20s) clip; longer audio is auto-chunked and
Whisper-transcribed like the no-captions YouTube fallback.
"""

from __future__ import annotations

import json
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import env
from .youtube import (
    MAX_SCAN_SEC,
    MAX_WINDOW_SEC,
    MIN_WINDOW_SEC,
    SEGMENT_MAX_SEC,
    ImportedClip,
    _utc_now_iso,
    gate_and_slice_planned,
    plan_fixed_slices,
    slice_audio_segment,
    transcribe_audio_file,
)


class ReferenceImportError(RuntimeError):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class AudioImportResult:
    base_run_dir: Path
    source_wav: Path
    clips: list[ImportedClip]
    skipped: list[dict]
    transcript_source: str  # provided | asr
    duration_sec: float
    truncated_at_sec: float | None


def wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        return handle.getnframes() / float(rate) if rate else 0.0


def import_audio_reference(
    source_wav: Path,
    transcript: str = "",
    auto_transcribe: bool = True,
    language: str = "zh",
    max_clips: int = 10,
    source_kind: str = "uploaded",
    original_duration_sec: float | None = None,
    convert_simplified: Callable[[str], str] | None = None,
    strict_script_errors: Callable[[str], list[str]] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
    check_interrupted: Callable[[], None] | None = None,
) -> AudioImportResult:
    """source_wav must already live inside the base run dir (the node writes the
    AUDIO tensor there, possibly pre-truncated — pass original_duration_sec for
    honest provenance). Plans clips, gates transcripts, slices 16k mono wavs,
    and writes the audio-import.json provenance sidecar.

    A typed transcript is taken verbatim (the strict gate rejects Simplified —
    the web upload/scripted/freeform rule); OpenCC conversion only applies to
    ASR output, which Whisper often emits in Simplified."""

    def progress(done: int, total: int, message: str) -> None:
        if on_progress:
            on_progress(done, total, message)

    base_run_dir = source_wav.parent
    duration = wav_duration_seconds(source_wav)
    original_duration = original_duration_sec if original_duration_sec and original_duration_sec > duration else duration
    transcript = (transcript or "").strip()

    if duration < MIN_WINDOW_SEC:
        raise ReferenceImportError(
            f"reference audio is {duration:.1f}s — at least {MIN_WINDOW_SEC}s is required "
            f"for an eligible clip (6–20s sweet spot)"
        )

    truncated_at: float | None = duration if original_duration > duration else None
    planned: list[tuple[float, float, str]] = []  # (rel_start, duration, transcript)
    apply_conversion = False
    if transcript:
        transcript_source = "provided"
        # A short take fits the 6–20s enrollment band whole, so the typed
        # transcript covers all of it (web upload semantics — no truncation).
        # Only longer audio falls back to head-of-clip semantics like the
        # YouTube transcript_override.
        clip_duration = duration if duration <= MAX_WINDOW_SEC else SEGMENT_MAX_SEC
        planned.append((0.0, clip_duration, transcript))
    else:
        if not auto_transcribe:
            raise ReferenceImportError(
                "a transcript is required when auto_transcribe is off "
                "(the VoxCPM2 contract needs a verified reference transcript)"
            )
        transcript_source = "asr"
        apply_conversion = True
        span = duration
        if span > MAX_SCAN_SEC:
            truncated_at = float(MAX_SCAN_SEC)
            span = float(MAX_SCAN_SEC)
        slices = plan_fixed_slices(span)[:max_clips]
        total = len(slices) or 1
        for index, (rel_start, slice_duration) in enumerate(slices):
            if check_interrupted:
                check_interrupted()
            slice_path = base_run_dir / f"asr-slice-{int(rel_start)}.wav"
            slice_audio_segment(source_wav, rel_start, slice_duration, slice_path)
            text = transcribe_audio_file(slice_path, language=language)
            progress(10 + round(60 * (index + 1) / total), 100, f"transcribing slice {index + 1}/{total}")
            if text:
                planned.append((rel_start, slice_duration, text))
        if not planned:
            raise ReferenceImportError(
                "transcription produced no text — type the transcript instead"
            )

    clips, skipped = gate_and_slice_planned(
        planned,
        source_wav,
        base_run_dir,
        max_clips=max_clips,
        convert=convert_simplified if apply_conversion else None,
        gate=strict_script_errors,
        on_progress=on_progress,
        check_interrupted=check_interrupted,
    )

    result = AudioImportResult(
        base_run_dir=base_run_dir,
        source_wav=source_wav,
        clips=clips,
        skipped=skipped,
        transcript_source=transcript_source,
        duration_sec=duration,
        truncated_at_sec=truncated_at,
    )

    provenance = {
        "source": "audio",
        "sourceKind": source_kind,
        "originalDurationSec": round(original_duration, 3),
        "truncatedAtSec": truncated_at,
        "transcriptSource": transcript_source,
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
    (base_run_dir / "audio-import.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    progress(100, 100, "import complete")
    return result

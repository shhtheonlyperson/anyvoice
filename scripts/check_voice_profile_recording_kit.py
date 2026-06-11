from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import shutil
import shlex
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any

from anyvoice_python_env import resolve_analyzer_python
from build_voice_profile import (
    CHINESE_SCRIPT_MARKER_PAIRS,
    PRODUCT_PRONUNCIATION_PRESET_IDS,
    REQUIRED_COVERAGE_FEATURES,
    REQUIRED_PRONUNCIATION_PRESET_IDS,
    detect_chinese_script,
    pronunciation_preset_ids,
    strict_traditional_script_errors,
    transcript_coverage_features,
)
from import_voice_profile_clips import field, load_json, load_manifest, normalized_transcript, resolve_audio_path


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_resolved_path(left: str, right: Path) -> bool:
    if not left.strip():
        return False
    return Path(left).expanduser().resolve(strict=False) == right.resolve(strict=False)


def probe_audio_duration(path: Path) -> tuple[float | None, str | None]:
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as handle:
                frames = handle.getnframes()
                rate = handle.getframerate()
            if rate > 0:
                return round(frames / rate, 3), None
        except Exception as exc:  # noqa: BLE001
            return None, f"wav_duration_unreadable:{exc}"

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None, "ffprobe_unavailable"
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None, f"ffprobe_failed:{proc.stderr.strip() or proc.stdout.strip() or proc.returncode}"
    try:
        duration = float(proc.stdout.strip())
    except ValueError:
        return None, "ffprobe_duration_invalid"
    if duration <= 0:
        return None, "audio_duration_invalid"
    return round(duration, 3), None


def active_voice_from_pcm(
    *,
    raw: bytes,
    sample_width: int,
    channels: int,
    frame_rate: int,
    threshold: float,
    window_ms: float,
) -> tuple[float | None, str | None]:
    if sample_width != 2 or channels <= 0 or frame_rate <= 0 or not raw:
        return None, "audio_voice_activity_unsupported"

    usable_bytes = len(raw) - (len(raw) % sample_width)
    if usable_bytes <= 0:
        return None, "audio_voice_activity_unsupported"

    samples = array.array("h")
    samples.frombytes(raw[:usable_bytes])
    if sys.byteorder != "little":
        samples.byteswap()

    frame_samples = max(1, channels)
    frames = len(samples) // frame_samples
    if frames <= 0:
        return None, "audio_voice_activity_unsupported"

    window_frames = max(1, int(frame_rate * window_ms / 1000.0))
    active_frames = 0
    for start_frame in range(0, frames, window_frames):
        end_frame = min(frames, start_frame + window_frames)
        start = start_frame * frame_samples
        end = end_frame * frame_samples
        window = samples[start:end]
        if not window:
            continue
        rms = math.sqrt(sum(float(value) * float(value) for value in window) / len(window)) / 32768.0
        if rms >= threshold:
            active_frames += end_frame - start_frame
    return round(active_frames / frame_rate, 3), None


def level_quality_from_pcm(
    *,
    raw: bytes,
    sample_width: int,
    channels: int,
    frame_rate: int,
) -> tuple[dict[str, Any] | None, str | None]:
    if sample_width != 2 or channels <= 0 or frame_rate <= 0 or not raw:
        return None, "audio_level_quality_unsupported"

    usable_bytes = len(raw) - (len(raw) % sample_width)
    if usable_bytes <= 0:
        return None, "audio_level_quality_unsupported"

    samples = array.array("h")
    samples.frombytes(raw[:usable_bytes])
    if sys.byteorder != "little":
        samples.byteswap()

    frame_samples = max(1, channels)
    frames = len(samples) // frame_samples
    if frames <= 0:
        return None, "audio_level_quality_unsupported"

    peak = 0
    clipped = 0
    for start in range(0, frames * frame_samples, frame_samples):
        if frame_samples == 1:
            value = samples[start]
        else:
            value = int(sum(samples[start : start + frame_samples]) / frame_samples)
        abs_value = abs(value)
        peak = max(peak, abs_value)
        if abs_value >= 32440:
            clipped += 1

    return {
        "peakAmplitude": round(peak / 32768.0, 5),
        "clippingRatio": round(clipped / frames, 5),
    }, None


def probe_wav_active_voice(path: Path, *, threshold: float = 0.012, window_ms: float = 20.0) -> tuple[float | None, str | None]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            frame_rate = handle.getframerate()
            frames = handle.getnframes()
            raw = handle.readframes(frames)
    except Exception as exc:  # noqa: BLE001
        return None, f"wav_voice_activity_unreadable:{exc}"

    if frames <= 0:
        return None, "wav_voice_activity_unsupported"
    return active_voice_from_pcm(
        raw=raw,
        sample_width=sample_width,
        channels=channels,
        frame_rate=frame_rate,
        threshold=threshold,
        window_ms=window_ms,
    )


def probe_wav_level_quality(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            frame_rate = handle.getframerate()
            frames = handle.getnframes()
            raw = handle.readframes(frames)
    except Exception as exc:  # noqa: BLE001
        return None, f"wav_level_quality_unreadable:{exc}"

    if frames <= 0:
        return None, "wav_level_quality_unsupported"
    return level_quality_from_pcm(
        raw=raw,
        sample_width=sample_width,
        channels=channels,
        frame_rate=frame_rate,
    )


def probe_decoded_active_voice(path: Path, *, threshold: float = 0.012, window_ms: float = 20.0) -> tuple[float | None, str | None]:
    if path.suffix.lower() == ".wav":
        return probe_wav_active_voice(path, threshold=threshold, window_ms=window_ms)

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None, "ffmpeg_unavailable"
    proc = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", errors="replace").strip() or str(proc.returncode)
        return None, f"ffmpeg_decode_failed:{detail}"
    return active_voice_from_pcm(
        raw=proc.stdout,
        sample_width=2,
        channels=1,
        frame_rate=16000,
        threshold=threshold,
        window_ms=window_ms,
    )


def probe_decoded_level_quality(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    if path.suffix.lower() == ".wav":
        return probe_wav_level_quality(path)

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None, "ffmpeg_unavailable"
    proc = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", errors="replace").strip() or str(proc.returncode)
        return None, f"ffmpeg_decode_failed:{detail}"
    return level_quality_from_pcm(
        raw=proc.stdout,
        sample_width=2,
        channels=1,
        frame_rate=16000,
    )


def chinese_script_marker_hits(text: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for traditional, simplified in CHINESE_SCRIPT_MARKER_PAIRS:
        traditional_count = text.count(traditional)
        simplified_count = text.count(simplified)
        if traditional_count or simplified_count:
            hits.append(
                {
                    "traditional": traditional,
                    "simplified": simplified,
                    "traditionalCount": traditional_count,
                    "simplifiedCount": simplified_count,
                }
            )
    return hits


def manifest_metadata(path: Path) -> dict[str, Any]:
    if path.suffix.lower() != ".json":
        return {}
    parsed = load_json(path)
    return parsed if isinstance(parsed, dict) else {}


def manifest_required_clips(metadata: dict[str, Any], row_count: int) -> int:
    required_clips = metadata.get("requiredClips")
    if isinstance(required_clips, int) and required_clips > 0:
        return required_clips
    prompt_set = str(metadata.get("promptSet") or "").strip().lower()
    if prompt_set in {"extended", "custom"} and row_count > 0:
        return row_count
    return 5


def manifest_required_pronunciation_preset_ids(metadata: dict[str, Any]) -> list[str]:
    prompt_set = str(metadata.get("promptSet") or "").strip().lower()
    return PRODUCT_PRONUNCIATION_PRESET_IDS if prompt_set == "extended" else REQUIRED_PRONUNCIATION_PRESET_IDS


def prompt_path_for_row(row: dict[str, Any], clip_id: str, manifest_dir: Path) -> tuple[Path, bool]:
    raw_prompt = field(row, ("promptPath", "promptFile"))
    if raw_prompt:
        return resolve_audio_path(raw_prompt, manifest_dir), True
    return manifest_dir / "prompts" / f"{clip_id}.txt", False


def positive_float_field(row: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        raw_value = row.get(key)
        if raw_value is None or raw_value == "":
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return None


def clip_row(
    row: dict[str, Any],
    index: int,
    manifest_dir: Path,
    *,
    min_duration_sec: float,
    max_duration_sec: float,
    min_active_voice_sec: float,
    active_voice_threshold: float,
    target_duration_tolerance_sec: float,
    min_peak_amplitude: float,
    max_clipping_ratio: float,
) -> dict[str, Any]:
    raw_audio = field(row, ("audioPath", "audio", "path", "file"))
    transcript = normalized_transcript(field(row, ("transcript", "promptTranscript", "text")))
    clip_id = field(row, ("id", "runId", "sourceRunId")) or f"clip-{index:02d}"
    source_kind = str(field(row, ("sourceKind",)) or "").strip().lower()
    duration_target_sec = positive_float_field(row, ("durationTargetSec", "recommendedDurationSec"))
    min_target_duration_sec = max(min_duration_sec, duration_target_sec - target_duration_tolerance_sec) if duration_target_sec else None
    prompt_path, prompt_path_explicit = prompt_path_for_row(row, str(clip_id), manifest_dir)
    prompt_exists = prompt_path.exists()
    prompt_text = ""
    audio_path = resolve_audio_path(raw_audio, manifest_dir) if raw_audio else None
    recording_metadata_path = audio_path.with_name(f"{audio_path.name}.recording.json") if audio_path else None
    recording_metadata_exists = bool(recording_metadata_path and recording_metadata_path.exists())
    recording_metadata_transcript = ""
    recording_metadata_transcript_sha256 = ""
    recording_metadata_audio_path = ""
    recording_metadata_audio_sha256 = ""
    audio_sha256 = ""
    exists = bool(audio_path and audio_path.exists())
    size = audio_path.stat().st_size if exists and audio_path else 0
    duration_sec: float | None = None
    active_voice_sec: float | None = None
    level_quality: dict[str, Any] | None = None
    errors: list[str] = []
    if not raw_audio:
        errors.append("missing_audio_path")
    elif not exists:
        errors.append("audio_file_missing")
    elif size <= 0:
        errors.append("audio_file_empty")
    else:
        try:
            audio_sha256 = file_sha256(audio_path)
        except OSError:
            errors.append("audio_file_hash_unreadable")
        duration_sec, duration_error = probe_audio_duration(audio_path)
        if duration_error:
            errors.append("audio_duration_unreadable")
        elif duration_sec is not None and duration_sec < min_duration_sec:
            errors.append("audio_too_short")
        elif duration_sec is not None and duration_sec > max_duration_sec:
            errors.append("audio_too_long")
        if (
            duration_sec is not None
            and min_target_duration_sec is not None
            and "audio_too_short" not in errors
            and "audio_too_long" not in errors
            and duration_sec < min_target_duration_sec
        ):
            errors.append("audio_below_target_duration")
        if audio_path and "audio_duration_unreadable" not in errors:
            active_voice_sec, active_voice_error = probe_decoded_active_voice(audio_path, threshold=active_voice_threshold)
            if active_voice_error:
                errors.append("audio_voice_activity_unreadable")
            elif active_voice_sec is not None and active_voice_sec < min_active_voice_sec:
                errors.append("audio_low_voice_activity")
            level_quality, level_quality_error = probe_decoded_level_quality(audio_path)
            if level_quality_error:
                errors.append("audio_level_quality_unreadable")
            elif level_quality:
                if float(level_quality.get("peakAmplitude") or 0.0) < min_peak_amplitude:
                    errors.append("audio_too_quiet")
                if float(level_quality.get("clippingRatio") or 0.0) > max_clipping_ratio:
                    errors.append("audio_clipping_detected")
    if not transcript:
        errors.append("missing_transcript")
    transcript_script = detect_chinese_script(transcript) if transcript else ""
    script_marker_hits = chinese_script_marker_hits(transcript) if transcript else []
    if transcript:
        errors.extend(strict_traditional_script_errors(transcript))
    if source_kind and source_kind != "scripted":
        errors.append("unexpected_source_kind")
    if prompt_exists:
        try:
            prompt_text = normalized_transcript(prompt_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            errors.append("prompt_file_unreadable")
        else:
            if transcript and prompt_text != transcript:
                errors.append("prompt_transcript_mismatch")
    elif prompt_path_explicit or (manifest_dir / "prompts").exists():
        errors.append("prompt_file_missing")
    if recording_metadata_exists and recording_metadata_path:
        try:
            metadata = json.loads(recording_metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                raise ValueError("metadata root is not an object")
        except Exception:  # noqa: BLE001
            errors.append("recording_metadata_unreadable")
        else:
            recording_metadata_transcript = normalized_transcript(
                str(metadata.get("transcript") or metadata.get("manifestTranscript") or "")
            )
            recording_metadata_transcript_sha256 = str(
                metadata.get("transcriptSha256") or metadata.get("manifestTranscriptSha256") or ""
            ).strip().lower()
            recording_metadata_audio_path = str(
                metadata.get("audioPath") or metadata.get("manifestAudioPath") or ""
            ).strip()
            recording_metadata_audio_sha256 = str(
                metadata.get("audioSha256") or metadata.get("audioFileSha256") or metadata.get("manifestAudioSha256") or ""
            ).strip().lower()
            expected_transcript_sha256 = text_sha256(transcript) if transcript else ""
            if not recording_metadata_transcript_sha256:
                errors.append("recording_metadata_transcript_hash_missing")
            elif expected_transcript_sha256 and recording_metadata_transcript_sha256 != expected_transcript_sha256:
                errors.append("recording_metadata_transcript_mismatch")
            elif recording_metadata_transcript and transcript and recording_metadata_transcript != transcript:
                errors.append("recording_metadata_transcript_mismatch")
            if audio_path:
                if not recording_metadata_audio_path:
                    errors.append("recording_metadata_audio_path_missing")
                elif not same_resolved_path(recording_metadata_audio_path, audio_path):
                    errors.append("recording_metadata_audio_path_mismatch")
            if audio_sha256:
                if not recording_metadata_audio_sha256:
                    errors.append("recording_metadata_audio_hash_missing")
                elif recording_metadata_audio_sha256 != audio_sha256:
                    errors.append("recording_metadata_audio_hash_mismatch")

    return {
        "index": index,
        "id": clip_id,
        "audioPath": str(audio_path) if audio_path else "",
        "audioExists": exists,
        "audioBytes": size,
        "audioSha256": audio_sha256,
        "durationSec": duration_sec,
        "durationTargetSec": duration_target_sec,
        "minTargetDurationSec": min_target_duration_sec,
        "targetDurationToleranceSec": target_duration_tolerance_sec,
        "audioLevelQuality": level_quality,
        "minPeakAmplitude": min_peak_amplitude,
        "maxClippingRatio": max_clipping_ratio,
        "activeVoiceSec": active_voice_sec,
        "transcript": transcript,
        "transcriptScript": transcript_script,
        "scriptMarkerHits": script_marker_hits,
        "sourceKind": source_kind,
        "promptPath": str(prompt_path),
        "promptExists": prompt_exists,
        "promptTranscript": prompt_text,
        "recordingMetadataPath": str(recording_metadata_path) if recording_metadata_path else "",
        "recordingMetadataExists": recording_metadata_exists,
        "recordingMetadataTranscript": recording_metadata_transcript,
        "recordingMetadataTranscriptSha256": recording_metadata_transcript_sha256,
        "recordingMetadataAudioPath": recording_metadata_audio_path,
        "recordingMetadataAudioSha256": recording_metadata_audio_sha256,
        "expectedTranscriptSha256": text_sha256(transcript) if transcript else "",
        "coverageFeatures": transcript_coverage_features(transcript) if transcript else [],
        "pronunciationPresetIds": pronunciation_preset_ids(transcript) if transcript else [],
        "errors": errors,
    }


def check_manifest(
    *,
    manifest_path: Path,
    min_clips: int | None,
    min_duration_sec: float,
    max_duration_sec: float,
    min_active_voice_sec: float,
    active_voice_threshold: float,
    target_duration_tolerance_sec: float,
    min_peak_amplitude: float,
    max_clipping_ratio: float,
    required_coverage: list[str],
    profile_id: str,
) -> dict[str, Any]:
    rows = load_manifest(manifest_path)
    metadata = manifest_metadata(manifest_path)
    clips = [
        clip_row(
            row,
            index,
            manifest_path.parent,
            min_duration_sec=min_duration_sec,
            max_duration_sec=max_duration_sec,
            min_active_voice_sec=min_active_voice_sec,
            active_voice_threshold=active_voice_threshold,
            target_duration_tolerance_sec=target_duration_tolerance_sec,
            min_peak_amplitude=min_peak_amplitude,
            max_clipping_ratio=max_clipping_ratio,
        )
        for index, row in enumerate(rows, start=1)
    ]
    effective_min_clips = min_clips if min_clips is not None else manifest_required_clips(metadata, len(clips))
    covered = sorted({feature for clip in clips for feature in clip["coverageFeatures"]})
    missing_coverage = [feature for feature in required_coverage if feature not in covered]
    required_pronunciation_preset_ids = manifest_required_pronunciation_preset_ids(metadata)
    covered_pronunciation_preset_ids = sorted(
        {preset_id for clip in clips for preset_id in clip["pronunciationPresetIds"]}
    )
    missing_pronunciation_preset_ids = [
        preset_id for preset_id in required_pronunciation_preset_ids if preset_id not in covered_pronunciation_preset_ids
    ]
    audio_error_reasons = {"missing_audio_path", "audio_file_missing", "audio_file_empty", "audio_file_hash_unreadable"}
    duration_error_reasons = {"audio_duration_unreadable", "audio_too_short", "audio_too_long"}
    target_duration_error_reasons = {"audio_below_target_duration"}
    active_voice_error_reasons = {"audio_voice_activity_unreadable", "audio_low_voice_activity"}
    level_quality_error_reasons = {"audio_level_quality_unreadable", "audio_too_quiet", "audio_clipping_detected"}
    transcript_error_reasons = {"missing_transcript", "invalid_chinese_script", "unproven_chinese_script", "missing_chinese_script"}
    source_kind_error_reasons = {"unexpected_source_kind"}
    prompt_file_error_reasons = {"prompt_file_missing", "prompt_file_unreadable", "prompt_transcript_mismatch"}
    recording_metadata_error_reasons = {
        "recording_metadata_unreadable",
        "recording_metadata_transcript_hash_missing",
        "recording_metadata_transcript_mismatch",
        "recording_metadata_audio_path_missing",
        "recording_metadata_audio_path_mismatch",
        "recording_metadata_audio_hash_missing",
        "recording_metadata_audio_hash_mismatch",
    }
    audio_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "errors": [error for error in clip["errors"] if error in audio_error_reasons],
        }
        for clip in clips
        if any(error in audio_error_reasons for error in clip["errors"])
    ]
    duration_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "durationSec": clip["durationSec"],
            "errors": [error for error in clip["errors"] if error in duration_error_reasons],
        }
        for clip in clips
        if any(error in duration_error_reasons for error in clip["errors"])
    ]
    active_voice_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "durationSec": clip["durationSec"],
            "activeVoiceSec": clip["activeVoiceSec"],
            "errors": [error for error in clip["errors"] if error in active_voice_error_reasons],
        }
        for clip in clips
        if any(error in active_voice_error_reasons for error in clip["errors"])
    ]
    target_duration_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "durationSec": clip["durationSec"],
            "durationTargetSec": clip["durationTargetSec"],
            "minTargetDurationSec": clip["minTargetDurationSec"],
            "targetDurationToleranceSec": clip["targetDurationToleranceSec"],
            "errors": [error for error in clip["errors"] if error in target_duration_error_reasons],
        }
        for clip in clips
        if any(error in target_duration_error_reasons for error in clip["errors"])
    ]
    level_quality_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "audioLevelQuality": clip["audioLevelQuality"],
            "minPeakAmplitude": clip["minPeakAmplitude"],
            "maxClippingRatio": clip["maxClippingRatio"],
            "errors": [error for error in clip["errors"] if error in level_quality_error_reasons],
        }
        for clip in clips
        if any(error in level_quality_error_reasons for error in clip["errors"])
    ]
    transcript_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "transcriptScript": clip["transcriptScript"],
            "scriptMarkerHits": clip["scriptMarkerHits"],
            "errors": [error for error in clip["errors"] if error in transcript_error_reasons],
        }
        for clip in clips
        if any(error in transcript_error_reasons for error in clip["errors"])
    ]
    source_kind_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "sourceKind": clip["sourceKind"],
            "errors": [error for error in clip["errors"] if error in source_kind_error_reasons],
        }
        for clip in clips
        if any(error in source_kind_error_reasons for error in clip["errors"])
    ]
    prompt_file_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "promptPath": clip["promptPath"],
            "transcript": clip["transcript"],
            "promptTranscript": clip["promptTranscript"],
            "errors": [error for error in clip["errors"] if error in prompt_file_error_reasons],
        }
        for clip in clips
        if any(error in prompt_file_error_reasons for error in clip["errors"])
    ]
    recording_metadata_errors = [
        {
            "index": clip["index"],
            "id": clip["id"],
            "audioPath": clip["audioPath"],
            "recordingMetadataPath": clip["recordingMetadataPath"],
            "recordingMetadataTranscriptSha256": clip["recordingMetadataTranscriptSha256"],
            "recordingMetadataAudioPath": clip["recordingMetadataAudioPath"],
            "recordingMetadataAudioSha256": clip["recordingMetadataAudioSha256"],
            "expectedAudioSha256": clip["audioSha256"],
            "expectedTranscriptSha256": clip["expectedTranscriptSha256"],
            "errors": [error for error in clip["errors"] if error in recording_metadata_error_reasons],
        }
        for clip in clips
        if any(error in recording_metadata_error_reasons for error in clip["errors"])
    ]
    prompt_files_checked = sum(1 for clip in clips if clip["promptExists"])
    recording_metadata_checked = sum(1 for clip in clips if clip["recordingMetadataExists"])
    enough_clips = len(clips) >= effective_min_clips
    status = (
        "ready_to_import"
        if (
            enough_clips
            and not audio_errors
            and not duration_errors
            and not target_duration_errors
            and not active_voice_errors
            and not level_quality_errors
            and not transcript_errors
            and not source_kind_errors
            and not prompt_file_errors
            and not recording_metadata_errors
            and not missing_coverage
            and not missing_pronunciation_preset_ids
        )
        else "incomplete"
    )
    return {
        "status": status,
        "manifest": str(manifest_path),
        "profileId": profile_id,
        "summary": {
            "clips": len(clips),
            "minClips": effective_min_clips,
            "promptSet": metadata.get("promptSet") if isinstance(metadata.get("promptSet"), str) else None,
            "requiredClipsSource": "argument" if min_clips is not None else "manifest",
            "minDurationSec": min_duration_sec,
            "maxDurationSec": max_duration_sec,
            "minActiveVoiceSec": min_active_voice_sec,
            "activeVoiceThreshold": active_voice_threshold,
            "targetDurationToleranceSec": target_duration_tolerance_sec,
            "minPeakAmplitude": min_peak_amplitude,
            "maxClippingRatio": max_clipping_ratio,
            "audioFilesPresent": sum(1 for clip in clips if clip["audioExists"] and clip["audioBytes"] > 0),
            "audioFilesWithinDuration": sum(
                1
                for clip in clips
                if clip["audioExists"]
                and clip["audioBytes"] > 0
                and clip["durationSec"] is not None
                and not any(error in duration_error_reasons for error in clip["errors"])
            ),
            "audioFilesWithActiveVoice": sum(
                1
                for clip in clips
                if clip["audioExists"]
                and clip["audioBytes"] > 0
                and clip["activeVoiceSec"] is not None
                and not any(error in active_voice_error_reasons for error in clip["errors"])
            ),
            "audioFilesWithinTargetDuration": sum(
                1
                for clip in clips
                if clip["audioExists"]
                and clip["audioBytes"] > 0
                and clip["durationTargetSec"] is not None
                and not any(error in target_duration_error_reasons for error in clip["errors"])
            ),
            "audioFilesPassingLevelQuality": sum(
                1
                for clip in clips
                if clip["audioExists"]
                and clip["audioBytes"] > 0
                and clip["audioLevelQuality"] is not None
                and not any(error in level_quality_error_reasons for error in clip["errors"])
            ),
            "promptFilesChecked": prompt_files_checked,
            "recordingMetadataChecked": recording_metadata_checked,
            "coveredFeatures": covered,
            "missingCoverageFeatures": missing_coverage,
            "requiredPronunciationPresetIds": required_pronunciation_preset_ids,
            "coveredPronunciationPresetIds": covered_pronunciation_preset_ids,
            "missingPronunciationPresetIds": missing_pronunciation_preset_ids,
        },
        "checks": [
            {
                "check": "clip_count",
                "ok": enough_clips,
                "message": f"{len(clips)} clips listed / {effective_min_clips} required",
            },
            {
                "check": "audio_files",
                "ok": not audio_errors,
                "message": "all listed recordings exist" if not audio_errors else f"{len(audio_errors)} clip(s) need audio files",
                "details": {"rows": audio_errors} if audio_errors else {},
            },
            {
                "check": "audio_duration",
                "ok": not duration_errors,
                "message": f"all recordings are {min_duration_sec:g}-{max_duration_sec:g} seconds"
                if not duration_errors
                else f"{len(duration_errors)} clip(s) outside the {min_duration_sec:g}-{max_duration_sec:g}s duration gate",
                "details": {"rows": duration_errors} if duration_errors else {},
            },
            {
                "check": "audio_target_duration",
                "ok": not target_duration_errors,
                "message": "all recordings meet their per-prompt duration targets"
                if not target_duration_errors
                else f"{len(target_duration_errors)} clip(s) are too rushed for their prompt target",
                "details": {"rows": target_duration_errors} if target_duration_errors else {},
            },
            {
                "check": "audio_voice_activity",
                "ok": not active_voice_errors,
                "message": f"all recordings have at least {min_active_voice_sec:g}s active voice"
                if not active_voice_errors
                else f"{len(active_voice_errors)} clip(s) below the {min_active_voice_sec:g}s active-voice gate",
                "details": {"rows": active_voice_errors} if active_voice_errors else {},
            },
            {
                "check": "audio_level_quality",
                "ok": not level_quality_errors,
                "message": "all recordings have usable levels without clipping"
                if not level_quality_errors
                else f"{len(level_quality_errors)} clip(s) have clipping, unreadable levels, or too little gain",
                "details": {"rows": level_quality_errors} if level_quality_errors else {},
            },
            {
                "check": "transcripts",
                "ok": not transcript_errors,
                "message": "all transcripts are present and strict Traditional Chinese"
                if not transcript_errors
                else f"{len(transcript_errors)} clip(s) need transcript fixes",
                "details": {"rows": transcript_errors} if transcript_errors else {},
            },
            {
                "check": "source_kind",
                "ok": not source_kind_errors,
                "message": "all explicit recording-kit sources are scripted"
                if not source_kind_errors
                else f"{len(source_kind_errors)} clip(s) have non-scripted sourceKind",
                "details": {"rows": source_kind_errors} if source_kind_errors else {},
            },
            {
                "check": "prompt_files",
                "ok": not prompt_file_errors,
                "message": f"{prompt_files_checked} prompt file(s) match manifest transcripts"
                if not prompt_file_errors
                else f"{len(prompt_file_errors)} clip(s) have stale or missing prompt files",
                "details": {"rows": prompt_file_errors} if prompt_file_errors else {},
            },
            {
                "check": "recording_metadata",
                "ok": not recording_metadata_errors,
                "message": f"{recording_metadata_checked} recording sidecar(s) match manifest transcripts"
                if not recording_metadata_errors
                else f"{len(recording_metadata_errors)} clip(s) have stale or unreadable recording sidecars",
                "details": {"rows": recording_metadata_errors} if recording_metadata_errors else {},
            },
            {
                "check": "coverage",
                "ok": not missing_coverage,
                "message": "all required transcript coverage is present"
                if not missing_coverage
                else f"missing coverage: {', '.join(missing_coverage)}",
                "details": {"requiredCoverageFeatures": required_coverage, "coveredFeatures": covered},
            },
            {
                "check": "pronunciation_presets",
                "ok": not missing_pronunciation_preset_ids,
                "message": "all required pronunciation presets are covered"
                if not missing_pronunciation_preset_ids
                else f"missing pronunciation presets: {', '.join(missing_pronunciation_preset_ids)}",
                "details": {
                    "requiredPronunciationPresetIds": required_pronunciation_preset_ids,
                    "coveredPronunciationPresetIds": covered_pronunciation_preset_ids,
                },
            },
        ],
        "clips": clips,
        "nextCommands": {
            "recordProfileKit": command([
                "python3",
                "scripts/record_voice_profile_recording_kit.py",
                "--manifest",
                str(manifest_path),
                "--open-cue-sheet",
                "--check",
                "--countdown-sec",
                "2",
                "--write-metadata",
                "--auto-duration",
            ]),
            "importProfileClips": command([
                resolve_analyzer_python(),
                "scripts/import_voice_profile_clips.py",
                "--manifest",
                str(manifest_path),
                "--build-profile",
            ]),
            "verifyProfile": command([
                "python3",
                "scripts/verify_voice_profile_ready.py",
                "--profile-json",
                f".anyvoice/voices/{profile_id}/profile.json",
            ]),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Check an AnyVoice recording kit before importing it into a digital voice profile.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--min-clips", type=int, help="Override manifest requiredClips. Defaults to generated manifest metadata or 5.")
    parser.add_argument("--min-duration-sec", type=float, default=6.0)
    parser.add_argument("--max-duration-sec", type=float, default=20.0)
    parser.add_argument("--min-active-voice-sec", type=float, default=5.2)
    parser.add_argument(
        "--active-voice-threshold",
        type=float,
        default=0.006,
        help="RMS threshold for active-voice windows. The default is calibrated for quiet but usable local microphone recordings.",
    )
    parser.add_argument(
        "--target-duration-tolerance-sec",
        type=float,
        default=2.0,
        help="Allow this many seconds below each manifest durationTargetSec/recommendedDurationSec before flagging a rushed take.",
    )
    parser.add_argument("--min-peak-amplitude", type=float, default=0.05)
    parser.add_argument("--max-clipping-ratio", type=float, default=0.001)
    parser.add_argument("--required-coverage", default=",".join(REQUIRED_COVERAGE_FEATURES))
    args = parser.parse_args()

    required_coverage = [item.strip() for item in args.required_coverage.split(",") if item.strip()]
    report = check_manifest(
        manifest_path=Path(args.manifest).expanduser().resolve(),
        min_clips=args.min_clips,
        min_duration_sec=args.min_duration_sec,
        max_duration_sec=args.max_duration_sec,
        min_active_voice_sec=args.min_active_voice_sec,
        active_voice_threshold=max(0.0, args.active_voice_threshold),
        target_duration_tolerance_sec=max(0.0, args.target_duration_tolerance_sec),
        min_peak_amplitude=max(0.0, args.min_peak_amplitude),
        max_clipping_ratio=max(0.0, args.max_clipping_ratio),
        required_coverage=required_coverage,
        profile_id=args.profile_id,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if report["status"] != "ready_to_import":
        raise SystemExit(2)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


def ensure_parent(path: str | Path) -> Path:
    resolved = Path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def find_ffmpeg() -> str | None:
    configured = os.environ.get("ANYVOICE_FFMPEG_PATH") or os.environ.get("FFMPEG_PATH")
    if configured and Path(configured).exists():
        return configured

    discovered = shutil.which("ffmpeg")
    if discovered:
        return discovered

    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"):
        if Path(candidate).exists():
            return candidate

    return None


# silenceremove with stop_periods=1 truncates at the first internal pause (a breath
# between phrases), collapsing a 14 s read into ~0.4 s and producing false "too short"
# rejections on clean audio. The areverse trick trims leading + trailing silence only,
# preserving every pause inside the speech.
_TRIM_LEADING_SILENCE = (
    "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB:detection=peak"
)
FFMPEG_FILTER_CHAIN = (
    "highpass=f=80,"
    "lowpass=f=8000,"
    f"{_TRIM_LEADING_SILENCE},areverse,{_TRIM_LEADING_SILENCE},areverse,"
    "loudnorm=I=-23:LRA=11:TP=-1.5"
)


def convert_reference_audio(input_path: Path, run_dir: Path) -> Path:
    output_path = run_dir / "reference_16k_mono.wav"
    if input_path.resolve() == output_path.resolve():
        return input_path

    ffmpeg = find_ffmpeg()

    if ffmpeg:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(input_path),
                "-af",
                FFMPEG_FILTER_CHAIN,
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output_path),
            ],
            check=True,
        )
        return output_path

    if input_path.suffix.lower() == ".wav":
        return input_path

    raise RuntimeError("ffmpeg is required to preprocess non-wav reference audio.")


def _frame_rms(samples: np.ndarray, sr: int, window_ms: float = 20.0) -> np.ndarray:
    win = max(1, int(sr * window_ms / 1000.0))
    if samples.size < win:
        return np.array([float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)) or 0.0)])
    n_frames = samples.size // win
    trimmed = samples[: n_frames * win].astype(np.float64)
    frames = trimmed.reshape(n_frames, win)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)


def _to_db(x: float) -> float:
    return 20.0 * math.log10(max(x, 1e-10))


def analyze_reference_quality(wav_path: Path) -> dict[str, Any]:
    warnings: list[str] = []
    try:
        data, sr = sf.read(str(wav_path), always_2d=False)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"read_failed:{exc}")
        return {
            "grade": "D",
            "durationSec": 0.0,
            "snrDb": None,
            "clippingRatio": 0.0,
            "vadActiveRatio": 0.0,
            "warnings": warnings,
        }

    if data.ndim > 1:
        data = data.mean(axis=1)
    data = data.astype(np.float32, copy=False)

    duration = float(data.size) / float(sr) if sr else 0.0
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    clipping_ratio = float(np.mean(np.abs(data) >= 0.99)) if data.size else 0.0
    rms = _frame_rms(data, sr, window_ms=20.0)

    if rms.size:
        noise_floor = float(np.percentile(rms, 30))
        threshold = noise_floor * (10 ** (6.0 / 20.0))
        vad_active_ratio = float(np.mean(rms >= threshold))
    else:
        vad_active_ratio = 0.0

    if rms.size >= 4:
        signal = float(np.percentile(rms, 90))
        noise = float(np.percentile(rms, 10))
        snr_db: float | None = _to_db(signal) - _to_db(noise) if noise > 0 and signal > 0 else None
    else:
        snr_db = None

    if duration < 3.0:
        warnings.append("short_clip")
    if duration > 30.0:
        warnings.append("long_clip")
    if clipping_ratio > 0.001:
        warnings.append("clipping_detected")
    if vad_active_ratio < 0.3:
        warnings.append("low_voice_activity")
    if snr_db is not None and snr_db < 10.0:
        warnings.append("low_snr")
    if peak < 0.05:
        warnings.append("very_quiet")

    def grade() -> str:
        snr_val = snr_db if snr_db is not None else -math.inf
        if 6.0 <= duration <= 20.0 and snr_val >= 25.0 and clipping_ratio <= 0.001 and vad_active_ratio >= 0.65:
            return "A"
        if 4.0 <= duration <= 25.0 and snr_val >= 18.0 and clipping_ratio <= 0.01 and vad_active_ratio >= 0.5:
            return "B"
        if 3.0 <= duration <= 30.0 and snr_val >= 10.0 and clipping_ratio <= 0.05 and vad_active_ratio >= 0.3:
            return "C"
        return "D"

    return {
        "grade": grade(),
        "durationSec": round(duration, 3),
        "snrDb": round(snr_db, 2) if snr_db is not None else None,
        "clippingRatio": round(clipping_ratio, 5),
        "vadActiveRatio": round(vad_active_ratio, 4),
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze an AnyVoice profile enrollment reference clip.")
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument("--prompt-text-file", required=True)
    parser.add_argument("--metadata-output", required=True)
    parser.add_argument("--model-id", default="openbmb/VoxCPM2")
    parser.add_argument("--source-kind", default="uploaded")
    args = parser.parse_args()

    reference_input = Path(args.reference_audio)
    if not reference_input.exists():
        raise FileNotFoundError(f"reference audio not found: {reference_input}")

    prompt_text = Path(args.prompt_text_file).read_text(encoding="utf-8").strip()
    if not prompt_text:
        raise ValueError("Reference transcript must not be empty.")

    run_dir = Path(args.metadata_output).resolve().parent
    run_dir.mkdir(parents=True, exist_ok=True)
    reference_wav = convert_reference_audio(reference_input, run_dir)
    reference_quality = analyze_reference_quality(reference_wav)
    metadata: dict[str, Any] = {
        "model_id": args.model_id,
        "mode": "profile_enrollment",
        "source_kind": args.source_kind,
        "reference_audio": str(reference_input),
        "converted_reference_audio": str(reference_wav),
        "prompt_text_present": True,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "referenceQuality": reference_quality,
    }
    ensure_parent(args.metadata_output).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

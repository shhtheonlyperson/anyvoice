from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from voxcpm import VoxCPM


def read_text_arg(value: str | None, file_path: str | None) -> str:
    if value and file_path:
        raise ValueError("Provide --text or --text-file, not both.")
    if file_path:
        return Path(file_path).read_text(encoding="utf-8").strip()
    if value:
        return value.strip()
    raise ValueError("Text is required.")


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


# Filter chain explained:
# - highpass 80 Hz: kill rumble/HVAC
# - lowpass 8000 Hz: trim hiss above speech band (we resample to 16 kHz anyway)
# - silenceremove: strip leading + trailing silence, threshold -40 dB, 0.1 s pad
# - loudnorm: EBU R128 normalize to I=-23 LUFS, LRA=11, TP=-1.5 dBTP
FFMPEG_FILTER_CHAIN = (
    "highpass=f=80,"
    "lowpass=f=8000,"
    "silenceremove="
    "start_periods=1:start_duration=0.1:start_threshold=-40dB:"
    "stop_periods=1:stop_duration=0.1:stop_threshold=-40dB:"
    "detection=peak,"
    "loudnorm=I=-23:LRA=11:TP=-1.5"
)


def convert_reference_audio(input_path: Path, run_dir: Path) -> Path:
    output_path = run_dir / "reference_16k_mono.wav"
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

    # No ffmpeg: best-effort fallback. Only safe for wav inputs.
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
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    return rms


def _to_db(x: float) -> float:
    return 20.0 * math.log10(max(x, 1e-10))


def analyze_reference_quality(wav_path: Path) -> dict[str, Any]:
    """Compute duration / clipping / VAD-active-ratio / SNR-ish for a reference clip.

    Always returns a dict — never raises for "bad quality"; just grades it.
    """
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
    clip_threshold = 0.99
    clipping_ratio = float(np.mean(np.abs(data) >= clip_threshold)) if data.size else 0.0

    rms = _frame_rms(data, sr, window_ms=20.0)

    if rms.size:
        noise_floor = float(np.percentile(rms, 30))
        threshold = noise_floor * (10 ** (6.0 / 20.0))  # +6 dB
        vad_active_ratio = float(np.mean(rms >= threshold))
    else:
        vad_active_ratio = 0.0

    if rms.size >= 4:
        signal = float(np.percentile(rms, 90))
        noise = float(np.percentile(rms, 10))
        if noise > 0 and signal > 0:
            snr_db: float | None = _to_db(signal) - _to_db(noise)
        else:
            snr_db = None
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
        if (
            6.0 <= duration <= 20.0
            and snr_val >= 25.0
            and clipping_ratio <= 0.001
            and vad_active_ratio >= 0.65
        ):
            return "A"
        if (
            4.0 <= duration <= 25.0
            and snr_val >= 18.0
            and clipping_ratio <= 0.01
            and vad_active_ratio >= 0.5
        ):
            return "B"
        if (
            3.0 <= duration <= 30.0
            and snr_val >= 10.0
            and clipping_ratio <= 0.05
            and vad_active_ratio >= 0.3
        ):
            return "C"
        return "D"

    return {
        "grade": grade(),
        "durationSec": round(duration, 3),
        "snrDb": (round(snr_db, 2) if snr_db is not None else None),
        "clippingRatio": round(clipping_ratio, 5),
        "vadActiveRatio": round(vad_active_ratio, 4),
        "warnings": warnings,
    }


QUALITY_PRESETS: dict[str, dict[str, Any]] = {
    "speed": {"timesteps": 10, "cfg": 2.0, "denoise": "off"},
    "balanced": {"timesteps": 25, "cfg": 2.5, "denoise": "auto"},
    "quality": {"timesteps": 40, "cfg": 3.0, "denoise": "on"},
}


def should_enable_optimize(requested: bool) -> tuple[bool, str]:
    if not requested:
        return False, "disabled_by_flag"

    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        return False, f"torch_unavailable:{exc}"

    if torch.cuda.is_available():
        return True, "cuda_available"
    return False, "disabled_on_non_cuda"


def _flag_was_passed(argv: list[str], *names: str) -> bool:
    for token in argv:
        for name in names:
            if token == name or token.startswith(name + "="):
                return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Synthesize speech from a voice reference + verified transcript "
            "with VoxCPM2 (ultimate mode only)."
        )
    )
    parser.add_argument("--text")
    parser.add_argument("--text-file")
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument(
        "--prompt-text",
        help="Verified transcript of the reference clip. Required (or --prompt-text-file).",
    )
    parser.add_argument("--prompt-text-file")
    parser.add_argument("--model-id", default="openbmb/VoxCPM2")
    parser.add_argument("--cache-dir")
    parser.add_argument("--cfg-value", type=float, default=2.0)
    parser.add_argument("--inference-timesteps", type=int, default=10)
    parser.add_argument("--min-len", type=int, default=2)
    parser.add_argument("--max-len", type=int, default=4096)
    parser.add_argument("--normalize", action="store_true")
    parser.add_argument("--denoise", action="store_true")
    parser.add_argument("--load-denoiser", action="store_true", default=True)
    parser.add_argument(
        "--no-load-denoiser",
        dest="load_denoiser",
        action="store_false",
        help="Skip loading the denoiser model.",
    )
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--no-optimize", action="store_true")
    parser.add_argument(
        "--quality",
        choices=("speed", "balanced", "quality"),
        default="balanced",
        help="Quality preset; sets timesteps/cfg/denoise unless overridden by explicit flags.",
    )
    parser.add_argument("--metadata-output")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    argv = sys.argv[1:]
    cfg_explicit = _flag_was_passed(argv, "--cfg-value")
    timesteps_explicit = _flag_was_passed(argv, "--inference-timesteps")
    denoise_explicit = _flag_was_passed(argv, "--denoise")

    run_dir = Path(args.output).resolve().parent
    run_dir.mkdir(parents=True, exist_ok=True)

    text = read_text_arg(args.text, args.text_file)

    if args.prompt_text and args.prompt_text_file:
        raise ValueError("Provide --prompt-text or --prompt-text-file, not both.")
    if args.prompt_text:
        prompt_text = args.prompt_text.strip()
    elif args.prompt_text_file:
        prompt_text = Path(args.prompt_text_file).read_text(encoding="utf-8").strip()
    else:
        raise ValueError(
            "Reference transcript is required: pass --prompt-text or --prompt-text-file."
        )
    if not prompt_text:
        raise ValueError("Reference transcript must not be empty.")

    reference_input = Path(args.reference_audio)
    if not reference_input.exists():
        raise FileNotFoundError(f"reference audio not found: {reference_input}")

    reference_wav = convert_reference_audio(reference_input, run_dir)
    reference_quality = analyze_reference_quality(reference_wav)

    preset = QUALITY_PRESETS[args.quality]
    effective_timesteps = (
        args.inference_timesteps if timesteps_explicit else int(preset["timesteps"])
    )
    effective_cfg = args.cfg_value if cfg_explicit else float(preset["cfg"])

    if denoise_explicit:
        effective_denoise = bool(args.denoise)
    else:
        mode = preset["denoise"]
        if mode == "on":
            effective_denoise = True
        elif mode == "off":
            effective_denoise = False
        else:  # auto
            snr = reference_quality.get("snrDb")
            effective_denoise = bool(snr is not None and snr < 18.0)

    optimize_requested = not args.no_optimize
    optimize_enabled, optimize_reason = should_enable_optimize(optimize_requested)
    if optimize_requested and not optimize_enabled:
        print(f"VoxCPM optimize disabled: {optimize_reason}", file=sys.stderr)

    model = VoxCPM.from_pretrained(
        args.model_id,
        load_denoiser=args.load_denoiser,
        cache_dir=args.cache_dir,
        local_files_only=args.local_files_only,
        optimize=optimize_enabled,
    )

    wav = model.generate(
        text=text,
        prompt_wav_path=str(reference_wav),
        prompt_text=prompt_text,
        reference_wav_path=str(reference_wav),
        cfg_value=effective_cfg,
        inference_timesteps=effective_timesteps,
        min_len=args.min_len,
        max_len=args.max_len,
        normalize=args.normalize,
        denoise=effective_denoise,
    )

    output_path = ensure_parent(args.output)
    sf.write(str(output_path), wav, model.tts_model.sample_rate)

    metadata: dict[str, Any] = {
        "model_id": args.model_id,
        "mode": "ultimate",
        "reference_audio": str(reference_input),
        "converted_reference_audio": str(reference_wav),
        "prompt_text_present": True,
        "char_count": len(text),
        "cfg_value": effective_cfg,
        "inference_timesteps": effective_timesteps,
        "sample_rate": model.tts_model.sample_rate,
        "optimize_requested": optimize_requested,
        "optimize_enabled": optimize_enabled,
        "optimize_reason": optimize_reason,
        "output": str(output_path),
        "referenceQuality": reference_quality,
        "effectiveParams": {
            "timesteps": effective_timesteps,
            "cfgValue": effective_cfg,
            "denoise": effective_denoise,
            "qualityPreset": args.quality,
        },
    }

    if args.metadata_output:
        ensure_parent(args.metadata_output).write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()

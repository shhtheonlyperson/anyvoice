from __future__ import annotations

import argparse
import json
import math
import os
import random
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


def read_json_file(file_path: str | None) -> dict[str, Any] | None:
    if not file_path:
        return None
    path = Path(file_path)
    if not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"read_failed:{exc}"}
    return parsed if isinstance(parsed, dict) else {"error": "json_root_not_object"}


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
# - silenceremove (areverse trick): strip leading + trailing silence ONLY.
#   A single silenceremove with stop_periods=1 truncates at the first internal
#   pause (a breath between phrases), collapsing a 14 s read into ~0.4 s. Trimming
#   the start, reversing, trimming the start again, and reversing back removes both
#   ends while preserving every pause inside the speech.
# - loudnorm: EBU R128 normalize to I=-23 LUFS, LRA=11, TP=-1.5 dBTP
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


def trim_leading_artifact(wav: np.ndarray, sr: int) -> np.ndarray:
    """Drop VoxCPM2's start-of-generation artifact.

    The model often emits a short phantom syllable (e.g. a stray "奏") in the
    first ~200ms, followed by a clear silence gap, before the real speech. We
    detect that "short leading burst + gap" pattern and cut to the real onset.
    Conservative thresholds avoid trimming a genuine short leading word: the
    burst must start almost immediately, be brief, and be followed by a
    substantial silence gap with real audio after it.
    """
    x = np.asarray(wav)
    mono = x.mean(axis=1) if x.ndim > 1 else x
    if mono.size < sr // 2:
        return wav
    win = max(1, int(sr * 0.02))
    n = mono.size // win
    if n < 8:
        return wav
    rms = np.sqrt(np.mean(mono[: n * win].astype(np.float64).reshape(n, win) ** 2, axis=1) + 1e-12)
    thr = max(0.02, float(rms.max()) * 0.18)
    active = rms >= thr
    if not active.any():
        return wav
    start = int(np.argmax(active))
    if start * win / sr > 0.12:  # no immediate leading burst — leave as is
        return wav
    end = start
    while end < n and active[end]:
        end += 1
    burst_len = (end - start) * win / sr
    gap = end
    while gap < n and not active[gap]:
        gap += 1
    gap_len = (gap - end) * win / sr
    # short burst (<0.35s) + meaningful gap (>0.15s) + speech remaining after
    if burst_len < 0.35 and gap_len > 0.15 and gap < n:
        cut = gap * win
        return wav[cut:] if x.ndim == 1 else wav[cut:, :]
    return wav


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
    # Brenda Voice's stable VoxCPM2 lane uses low CFG and few steps
    # (cfg=2.0, steps=8). In AnyVoice, arbitrary user references make
    # forced denoise risky, so balanced/quality only denoise noisy clips.
    "speed": {"timesteps": 6, "cfg": 1.8, "denoise": "off"},
    "balanced": {"timesteps": 8, "cfg": 2.0, "denoise": "auto"},
    "quality": {"timesteps": 10, "cfg": 2.0, "denoise": "auto"},
}


def default_stability_seed() -> int | None:
    value = os.environ.get("ANYVOICE_STABILITY_SEED", "1337").strip().lower()
    if value in {"", "off", "none", "random"}:
        return None
    try:
        seed = int(value)
    except ValueError:
        return 1337
    return seed if 0 <= seed <= 2_147_483_647 else 1337


def apply_stability_seed(seed: int | None) -> dict[str, Any]:
    if seed is None:
        return {
            "seed": None,
            "enabled": False,
            "backends": [],
        }

    random.seed(seed)
    np.random.seed(seed % (2**32 - 1))
    backends = ["python_random", "numpy"]
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
            backends.append("torch_cuda")
        if getattr(torch.backends, "mps", None) is not None:
            backends.append("torch_mps")
        backends.append("torch")
    except Exception as exc:  # noqa: BLE001
        return {
            "seed": seed,
            "enabled": True,
            "backends": backends,
            "warning": f"torch_seed_unavailable:{exc}",
        }

    return {
        "seed": seed,
        "enabled": True,
        "backends": backends,
    }


def default_clone_mode() -> str:
    value = os.environ.get("ANYVOICE_VOXCPM_CLONE_MODE", "hifi").strip().lower()
    return value if value in {"hifi", "prompt"} else "hifi"


def default_lora_path() -> str:
    return os.environ.get("ANYVOICE_VOXCPM_LORA_PATH", "").strip()


def normalize_lora_path(value: str | None) -> str | None:
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"LoRA weights not found: {path}")
    return str(path.resolve())


def build_lora_config(
    *,
    lora_path: str | None,
    lora_r: int,
    lora_alpha: int,
    lora_dropout: float,
    lora_disable_lm: bool,
    lora_disable_dit: bool,
    lora_enable_proj: bool,
) -> Any | None:
    if not lora_path:
        return None
    if lora_r <= 0:
        raise ValueError("--lora-r must be a positive integer")
    if lora_alpha <= 0:
        raise ValueError("--lora-alpha must be a positive integer")
    if not 0.0 <= lora_dropout <= 1.0:
        raise ValueError("--lora-dropout must be between 0.0 and 1.0")
    from voxcpm.model.voxcpm import LoRAConfig

    return LoRAConfig(
        enable_lm=not lora_disable_lm,
        enable_dit=not lora_disable_dit,
        enable_proj=lora_enable_proj,
        r=lora_r,
        alpha=lora_alpha,
        dropout=lora_dropout,
    )


def lora_config_metadata(lora_config: Any | None) -> dict[str, Any] | None:
    if lora_config is None:
        return None
    return {
        "r": getattr(lora_config, "r", None),
        "alpha": getattr(lora_config, "alpha", None),
        "dropout": getattr(lora_config, "dropout", None),
        "enableLm": getattr(lora_config, "enable_lm", None),
        "enableDit": getattr(lora_config, "enable_dit", None),
        "enableProj": getattr(lora_config, "enable_proj", None),
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


def emit_progress(enabled: bool, phase: str, message: str | None = None, **fields: Any) -> None:
    if not enabled:
        return
    payload: dict[str, Any] = {"type": "progress", "phase": phase}
    if message:
        payload["message"] = message
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


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
    parser.add_argument(
        "--seed",
        type=int,
        default=default_stability_seed(),
        help="Stability seed for Python, NumPy, and Torch RNGs. Set ANYVOICE_STABILITY_SEED=off to disable the default.",
    )
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
    parser.add_argument(
        "--clone-mode",
        choices=("hifi", "prompt"),
        default=default_clone_mode(),
        help=(
            "VoxCPM2 clone call path. hifi passes prompt_wav_path + prompt_text + "
            "reference_wav_path. prompt keeps the older prompt-only path for A/B rollback."
        ),
    )
    parser.add_argument(
        "--lora-path",
        default=default_lora_path(),
        help="Optional VoxCPM LoRA weights path. Also configurable with ANYVOICE_VOXCPM_LORA_PATH.",
    )
    parser.add_argument("--lora-r", type=int, default=32, help="LoRA rank when --lora-path is set.")
    parser.add_argument("--lora-alpha", type=int, default=16, help="LoRA alpha when --lora-path is set.")
    parser.add_argument("--lora-dropout", type=float, default=0.0, help="LoRA dropout when --lora-path is set.")
    parser.add_argument("--lora-disable-lm", action="store_true", help="Disable LoRA on LM layers.")
    parser.add_argument("--lora-disable-dit", action="store_true", help="Disable LoRA on DiT layers.")
    parser.add_argument("--lora-enable-proj", action="store_true", help="Enable LoRA on projection layers.")
    parser.add_argument("--metadata-output")
    parser.add_argument(
        "--text-prep-file",
        help="Optional JSON file describing raw/model text preparation.",
    )
    parser.add_argument(
        "--progress-jsonl",
        action="store_true",
        help="Emit newline-delimited JSON progress events to stdout.",
    )
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    argv = sys.argv[1:]
    cfg_explicit = _flag_was_passed(argv, "--cfg-value")
    timesteps_explicit = _flag_was_passed(argv, "--inference-timesteps")
    denoise_explicit = _flag_was_passed(argv, "--denoise")

    run_dir = Path(args.output).resolve().parent
    run_dir.mkdir(parents=True, exist_ok=True)

    text = read_text_arg(args.text, args.text_file)
    text_preparation = read_json_file(args.text_prep_file)

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
    if args.seed is not None and not 0 <= args.seed <= 2_147_483_647:
        raise ValueError("--seed must be between 0 and 2147483647, or omit it")

    reference_input = Path(args.reference_audio)
    if not reference_input.exists():
        raise FileNotFoundError(f"reference audio not found: {reference_input}")

    emit_progress(args.progress_jsonl, "reference_preprocessing", "Preparing reference audio")
    reference_wav = convert_reference_audio(reference_input, run_dir)
    reference_quality = analyze_reference_quality(reference_wav)
    emit_progress(
        args.progress_jsonl,
        "reference_analyzed",
        "Reference audio analyzed",
        referenceQuality=reference_quality,
    )

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

    lora_path = normalize_lora_path(args.lora_path)
    lora_config = build_lora_config(
        lora_path=lora_path,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        lora_disable_lm=args.lora_disable_lm,
        lora_disable_dit=args.lora_disable_dit,
        lora_enable_proj=args.lora_enable_proj,
    )
    lora_meta = lora_config_metadata(lora_config)

    emit_progress(args.progress_jsonl, "model_loading", "Loading VoxCPM2")
    model = VoxCPM.from_pretrained(
        args.model_id,
        load_denoiser=args.load_denoiser,
        cache_dir=args.cache_dir,
        local_files_only=args.local_files_only,
        optimize=optimize_enabled,
        lora_config=lora_config,
        lora_weights_path=lora_path,
    )
    emit_progress(args.progress_jsonl, "model_ready", "VoxCPM2 ready")

    effective_params = {
        "timesteps": effective_timesteps,
        "cfgValue": effective_cfg,
        "denoise": effective_denoise,
        "qualityPreset": args.quality,
        "cloneMode": args.clone_mode,
        "stabilitySeed": args.seed,
        "loraEnabled": bool(lora_path),
        "loraPath": lora_path,
    }
    if lora_meta is not None:
        effective_params["loraConfig"] = lora_meta

    emit_progress(
        args.progress_jsonl,
        "synthesis_started",
        "Synthesizing voice",
        effectiveParams=effective_params,
    )
    seed_metadata = apply_stability_seed(args.seed)
    generate_kwargs: dict[str, Any] = {
        "text": text,
        "prompt_wav_path": str(reference_wav),
        "prompt_text": prompt_text,
        "cfg_value": effective_cfg,
        "inference_timesteps": effective_timesteps,
        "min_len": args.min_len,
        "max_len": args.max_len,
        "normalize": args.normalize,
        "denoise": effective_denoise,
    }
    if args.clone_mode == "hifi":
        # Hi-Fi mode: prompt audio/text anchors pronunciation alignment, while
        # reference_wav_path anchors speaker timbre. Brenda's stable path uses
        # this combination; prompt mode remains available for A/B rollback.
        generate_kwargs["reference_wav_path"] = str(reference_wav)

    wav = model.generate(**generate_kwargs)
    wav = trim_leading_artifact(wav, model.tts_model.sample_rate)

    output_path = ensure_parent(args.output)
    sf.write(str(output_path), wav, model.tts_model.sample_rate)
    emit_progress(args.progress_jsonl, "audio_ready", "Audio written")

    metadata: dict[str, Any] = {
        "model_id": args.model_id,
        "mode": "ultimate",
        "reference_audio": str(reference_input),
        "converted_reference_audio": str(reference_wav),
        "clone_mode": args.clone_mode,
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
        "effectiveParams": effective_params,
        "determinism": seed_metadata,
        "lora": {
            "enabled": bool(lora_path),
            "path": lora_path,
            "config": lora_meta,
        },
    }
    if text_preparation is not None:
        metadata["textPreparation"] = text_preparation

    if args.metadata_output:
        ensure_parent(args.metadata_output).write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    if args.progress_jsonl:
        print(json.dumps({"type": "metadata", "metadata": metadata}, ensure_ascii=False), flush=True)
    else:
        print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()

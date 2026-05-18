from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

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


def convert_reference_audio(input_path: Path, run_dir: Path) -> Path:
    output_path = run_dir / "reference_16k_mono.wav"
    ffmpeg = shutil.which("ffmpeg")

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

    raise RuntimeError("ffmpeg is required to use non-wav reference audio.")


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize speech from any permitted voice reference with VoxCPM2.")
    parser.add_argument("--text")
    parser.add_argument("--text-file")
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument("--prompt-text")
    parser.add_argument("--prompt-text-file")
    parser.add_argument("--style")
    parser.add_argument("--model-id", default="openbmb/VoxCPM2")
    parser.add_argument("--cache-dir")
    parser.add_argument("--cfg-value", type=float, default=2.0)
    parser.add_argument("--inference-timesteps", type=int, default=10)
    parser.add_argument("--min-len", type=int, default=2)
    parser.add_argument("--max-len", type=int, default=4096)
    parser.add_argument("--normalize", action="store_true")
    parser.add_argument("--denoise", action="store_true")
    parser.add_argument("--load-denoiser", action="store_true")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--no-optimize", action="store_true")
    parser.add_argument("--metadata-output")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    run_dir = Path(args.output).resolve().parent
    run_dir.mkdir(parents=True, exist_ok=True)

    text = read_text_arg(args.text, args.text_file)
    style = (args.style or "").strip()
    if style:
        text = f"({style}){text}"

    prompt_text = None
    if args.prompt_text and args.prompt_text_file:
        raise ValueError("Provide --prompt-text or --prompt-text-file, not both.")
    if args.prompt_text:
        prompt_text = args.prompt_text.strip()
    elif args.prompt_text_file:
        prompt_text = Path(args.prompt_text_file).read_text(encoding="utf-8").strip()

    reference_input = Path(args.reference_audio)
    if not reference_input.exists():
        raise FileNotFoundError(f"reference audio not found: {reference_input}")

    reference_wav = convert_reference_audio(reference_input, run_dir)
    prompt_wav_path = str(reference_wav) if prompt_text else None

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
        prompt_wav_path=prompt_wav_path,
        prompt_text=prompt_text,
        reference_wav_path=str(reference_wav),
        cfg_value=args.cfg_value,
        inference_timesteps=args.inference_timesteps,
        min_len=args.min_len,
        max_len=args.max_len,
        normalize=args.normalize,
        denoise=args.denoise,
    )

    output_path = ensure_parent(args.output)
    sf.write(str(output_path), wav, model.tts_model.sample_rate)

    metadata = {
        "model_id": args.model_id,
        "mode": "ultimate" if prompt_text else "reference",
        "reference_audio": str(reference_input),
        "converted_reference_audio": str(reference_wav),
        "prompt_text_present": bool(prompt_text),
        "style_present": bool(style),
        "char_count": len(text),
        "cfg_value": args.cfg_value,
        "inference_timesteps": args.inference_timesteps,
        "sample_rate": model.tts_model.sample_rate,
        "optimize_requested": optimize_requested,
        "optimize_enabled": optimize_enabled,
        "optimize_reason": optimize_reason,
        "output": str(output_path),
    }

    if args.metadata_output:
        ensure_parent(args.metadata_output).write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()

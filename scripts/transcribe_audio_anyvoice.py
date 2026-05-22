"""Transcribe a single audio file to text (JSON on stdout).

Backend preference (auto): MLX Whisper (Apple Silicon GPU — large-v3 quality at
a fraction of the CPU time), then faster-whisper, then the whisper CLI. The
faster-whisper / whisper-cli backends are reused from transcribe_voice_regression.

Used by the YouTube import path to auto-fill a reference transcript when the
video has no usable captions.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import transcribe_voice_regression as asr

# Default MLX repo — large-v3 quality, runs on the Apple Silicon GPU.
DEFAULT_MLX_REPO = "mlx-community/whisper-large-v3-mlx"


def mlx_available() -> bool:
    return importlib.util.find_spec("mlx_whisper") is not None


def transcribe_mlx(audio_path: Path, repo: str, language: str | None) -> dict:
    import mlx_whisper

    result = mlx_whisper.transcribe(str(audio_path), path_or_hf_repo=repo, language=language or None)
    return {
        "transcript": str(result.get("text") or "").strip(),
        "backend": "mlx-whisper",
        "language": result.get("language") or language,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe one audio file to JSON {transcript, language, backend}.")
    parser.add_argument("--audio", required=True, help="Path to the audio file (wav/mp3/m4a/…).")
    parser.add_argument("--backend", choices=("auto", "mlx", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--model", default="large-v3", help="faster-whisper / whisper-cli model name or path.")
    parser.add_argument("--mlx-repo", default=DEFAULT_MLX_REPO, help="HF repo for the MLX Whisper backend.")
    parser.add_argument("--language", default="zh", help="Language code. Empty string auto-detects.")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    audio_path = Path(args.audio).expanduser().resolve()
    if not audio_path.exists():
        raise SystemExit(f"audio not found: {audio_path}")

    language = args.language or None

    if args.backend in ("auto", "mlx") and mlx_available():
        result = transcribe_mlx(audio_path, args.mlx_repo, language)
    else:
        backend = asr.resolve_backend("auto" if args.backend == "mlx" else args.backend)
        transcribe = asr.transcriber_for_backend(
            backend,
            SimpleNamespace(
                model=args.model,
                language=language,
                device=args.device,
                compute_type=args.compute_type,
                beam_size=args.beam_size,
                vad_filter=True,
                fp16=None,
            ),
        )
        result = transcribe(audio_path)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

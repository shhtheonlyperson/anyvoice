"""Transcribe a single audio file to text (JSON on stdout).

Reuses the ASR backends from transcribe_voice_regression.py (faster-whisper,
falling back to the whisper CLI). Used by the YouTube import path to auto-fill
a reference transcript when the video has no usable captions.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import transcribe_voice_regression as asr


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe one audio file to JSON {transcript, language, backend}.")
    parser.add_argument("--audio", required=True, help="Path to the audio file (wav/mp3/m4a/…).")
    parser.add_argument("--backend", choices=("auto", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--model", default="large-v3", help="Whisper model name or local path.")
    parser.add_argument("--language", default="zh", help="Language code. Empty string auto-detects.")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    audio_path = Path(args.audio).expanduser().resolve()
    if not audio_path.exists():
        raise SystemExit(f"audio not found: {audio_path}")

    backend = asr.resolve_backend(args.backend)
    transcribe = asr.transcriber_for_backend(
        backend,
        SimpleNamespace(
            model=args.model,
            language=args.language or None,
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

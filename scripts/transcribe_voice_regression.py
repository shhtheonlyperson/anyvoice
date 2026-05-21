from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON: {path}: {exc}") from exc


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def report_renders(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    groups = report.get("groups")
    if not isinstance(groups, list):
        raise SystemExit("report does not contain groups[]")
    for group in groups:
        if not isinstance(group, dict):
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            output_wav = str(render.get("outputWav") or "").strip()
            if not output_wav:
                continue
            rows.append(
                {
                    "cloneMode": group.get("cloneMode") or render.get("cloneMode"),
                    "caseId": case.get("id") or render.get("caseId"),
                    "repeat": render.get("repeat"),
                    "outputWav": output_wav,
                    "targetText": case.get("text"),
                    "status": render.get("status"),
                }
            )
    return rows


def resolve_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import faster_whisper  # noqa: F401

        return "faster-whisper"
    except ImportError:
        pass
    if shutil.which("whisper"):
        return "whisper-cli"
    raise SystemExit(
        "no ASR backend found: install faster-whisper in this Python env or make the whisper CLI available"
    )


def backend_status() -> dict[str, Any]:
    faster_whisper_available = importlib.util.find_spec("faster_whisper") is not None
    whisper_cli = shutil.which("whisper")
    selected = "faster-whisper" if faster_whisper_available else ("whisper-cli" if whisper_cli else "unavailable")
    return {
        "version": 1,
        "selectedAutoBackend": selected,
        "backends": {
            "faster-whisper": {
                "available": faster_whisper_available,
                "kind": "local_asr",
                "reason": "installed" if faster_whisper_available else "missing Python package: faster_whisper",
            },
            "whisper-cli": {
                "available": bool(whisper_cli),
                "kind": "cli_asr",
                "path": whisper_cli,
                "reason": "installed" if whisper_cli else "whisper CLI not found on PATH",
            },
        },
    }


def transcribe_with_faster_whisper(args: argparse.Namespace) -> Callable[[Path], dict[str, Any]]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit("faster-whisper is not installed in this Python env") from exc

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    def transcribe(path: Path) -> dict[str, Any]:
        segments, info = model.transcribe(
            str(path),
            language=args.language,
            task="transcribe",
            beam_size=args.beam_size,
            vad_filter=args.vad_filter,
        )
        text = "".join(segment.text for segment in segments).strip()
        return {
            "transcript": text,
            "backend": "faster-whisper",
            "language": getattr(info, "language", args.language),
            "languageProbability": getattr(info, "language_probability", None),
        }

    return transcribe


def transcribe_with_whisper_cli(args: argparse.Namespace) -> Callable[[Path], dict[str, Any]]:
    whisper = shutil.which("whisper")
    if not whisper:
        raise SystemExit("whisper CLI is not available on PATH")

    def transcribe(path: Path) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="anyvoice-whisper-") as tmp:
            out_dir = Path(tmp)
            cmd = [
                whisper,
                str(path),
                "--model",
                args.model,
                "--output_dir",
                str(out_dir),
                "--output_format",
                "json",
                "--verbose",
                "False",
                "--task",
                "transcribe",
            ]
            if args.device:
                cmd.extend(["--device", args.device])
            if args.language:
                cmd.extend(["--language", args.language])
            if args.fp16 is not None:
                cmd.extend(["--fp16", "True" if args.fp16 else "False"])
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "whisper CLI failed")
            output_json = out_dir / f"{path.stem}.json"
            payload = load_json(output_json)
            return {
                "transcript": str(payload.get("text") or "").strip(),
                "backend": "whisper-cli",
                "language": payload.get("language") or args.language,
            }

    return transcribe


def transcriber_for_backend(backend: str, args: argparse.Namespace) -> Callable[[Path], dict[str, Any]]:
    if backend == "faster-whisper":
        return transcribe_with_faster_whisper(args)
    if backend == "whisper-cli":
        return transcribe_with_whisper_cli(args)
    raise SystemExit(f"unknown ASR backend: {backend}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe AnyVoice regression render WAVs into a scorer-compatible ASR JSON file.")
    parser.add_argument("report", nargs="?", help="AnyVoice voice_clone_regression.py report.json")
    parser.add_argument("--out", help="ASR JSON path. Defaults to <report-dir>/asr.json.")
    parser.add_argument("--list-backends", action="store_true", help="Print ASR backend availability JSON and exit.")
    parser.add_argument("--backend", choices=("auto", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--model", default="large-v3", help="Whisper model name or local path.")
    parser.add_argument("--language", default="zh", help="Whisper language code. Use empty string for auto detection.")
    parser.add_argument("--device", default="auto", help="ASR device. For whisper-cli, use cpu/cuda/mps as supported by that install.")
    parser.add_argument("--compute-type", default="default", help="faster-whisper compute_type.")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", action="store_true")
    parser.add_argument("--fp16", choices=("true", "false"), help="whisper-cli fp16 flag. Defaults to the CLI's own default.")
    parser.add_argument("--limit", type=int, help="Transcribe only the first N renders.")
    parser.add_argument("--dry-run", action="store_true", help="Write planned rows without invoking ASR.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if any render cannot be transcribed.")
    args = parser.parse_args()
    if args.list_backends:
        print(json.dumps(backend_status(), ensure_ascii=False, sort_keys=True))
        return
    if not args.report:
        raise SystemExit("report is required unless --list-backends is used")

    args.language = args.language or None
    args.fp16 = None if args.fp16 is None else args.fp16 == "true"

    report_path = Path(args.report).expanduser().resolve()
    report = load_json(report_path)
    rows = report_renders(report if isinstance(report, dict) else {})
    if args.limit is not None:
        rows = rows[: max(0, args.limit)]
    if not rows:
        raise SystemExit("no render WAVs found in report")

    backend = "dry-run" if args.dry_run else resolve_backend(args.backend)
    transcribe: Callable[[Path], dict[str, Any]] | None = None
    if not args.dry_run:
        transcribe = transcriber_for_backend(backend, args)

    transcript_rows: list[dict[str, Any]] = []
    failures = 0
    for row in rows:
        output_wav = Path(str(row["outputWav"])).expanduser()
        transcript_row = {**row, "transcript": None, "error": None}
        if args.dry_run:
            transcript_rows.append(transcript_row)
            continue
        if not output_wav.exists():
            transcript_row["error"] = f"missing audio: {output_wav}"
            failures += 1
            transcript_rows.append(transcript_row)
            continue
        try:
            if transcribe is None:
                raise RuntimeError("ASR backend unavailable")
            result = transcribe(output_wav)
            transcript_row.update(result)
        except Exception as exc:  # noqa: BLE001
            transcript_row["error"] = str(exc)
            failures += 1
        transcript_rows.append(transcript_row)

    payload = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceReport": str(report_path),
        "backend": backend,
        "model": args.model,
        "language": args.language,
        "dryRun": args.dry_run,
        "transcripts": transcript_rows,
        "summary": {
            "total": len(transcript_rows),
            "transcribed": sum(1 for row in transcript_rows if row.get("transcript")),
            "failed": failures,
        },
    }
    out_path = Path(args.out).expanduser().resolve() if args.out else report_path.parent / "asr.json"
    write_json(out_path, payload)
    print(json.dumps({"asrJson": str(out_path), **payload["summary"], "backend": backend}, ensure_ascii=False))
    if args.strict and failures:
        sys.exit(2)


if __name__ == "__main__":
    main()

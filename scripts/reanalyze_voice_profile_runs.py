from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_voice_profile import (
    DEFAULT_RUNS_DIR,
    DEFAULT_VOICES_DIR,
    build_profile,
    is_profile_generated_run,
    is_sample_source_run,
    load_json,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ANALYZER = REPO_ROOT / "scripts" / "analyze_voice_reference.py"


def env_file_value(name: str) -> str | None:
    for env_file in (REPO_ROOT / ".env.local", REPO_ROOT / ".env"):
        if not env_file.exists():
            continue
        for raw_line in env_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() != name:
                continue
            return value.strip().strip("'\"")
    return None


def prompt_text_file_for_run(run_dir: Path) -> Path | None:
    for name in ("prompt-transcript.raw.txt", "prompt-transcript.txt"):
        path = run_dir / name
        if path.exists() and path.read_text(encoding="utf-8").strip():
            return path
    return None


def reference_audio_for_analysis(run_dir: Path) -> Path | None:
    for candidate in sorted(run_dir.glob("reference.*")):
        if not candidate.name.startswith("reference_"):
            return candidate
    converted = run_dir / "reference_16k_mono.wav"
    if converted.exists():
        return converted
    return None


def source_kind_for_run(run_dir: Path) -> str:
    request = load_json(run_dir / "request.json") or {}
    reference_source = request.get("referenceSource")
    value = request.get("sourceKind")
    if not isinstance(value, str) and isinstance(reference_source, dict):
        value = reference_source.get("kind")
    if isinstance(value, str) and value in {"scripted", "freeform", "uploaded", "profile", "sample"}:
        return value
    metadata = load_json(run_dir / "metadata.json") or {}
    value = metadata.get("source_kind") or metadata.get("sourceKind")
    return value if isinstance(value, str) and value else "uploaded"


def existing_quality(run_dir: Path) -> dict[str, Any] | None:
    metadata = load_json(run_dir / "metadata.json")
    if not metadata:
        return None
    quality = metadata.get("referenceQuality")
    return quality if isinstance(quality, dict) else None


def compact_quality(quality: dict[str, Any]) -> dict[str, Any]:
    return {
        "grade": quality.get("grade"),
        "durationSec": quality.get("durationSec"),
        "warnings": quality.get("warnings") if isinstance(quality.get("warnings"), list) else [],
    }


def run_analyzer(
    *,
    python: str,
    analyzer: Path,
    run_dir: Path,
    reference_audio: Path,
    prompt_text_file: Path,
    model_id: str,
    source_kind: str,
) -> dict[str, Any]:
    tmp_metadata = run_dir / ".reference-quality.tmp.json"
    if tmp_metadata.exists():
        tmp_metadata.unlink()

    try:
        subprocess.run(
            [
                python,
                str(analyzer),
                "--reference-audio",
                str(reference_audio),
                "--prompt-text-file",
                str(prompt_text_file),
                "--metadata-output",
                str(tmp_metadata),
                "--model-id",
                model_id,
                "--source-kind",
                source_kind,
            ],
            cwd=str(REPO_ROOT),
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        parsed = load_json(tmp_metadata)
    finally:
        try:
            tmp_metadata.unlink()
        except FileNotFoundError:
            pass
    if not parsed or not isinstance(parsed.get("referenceQuality"), dict):
        raise RuntimeError("analyzer did not return referenceQuality")
    return parsed


def merge_analyzer_metadata(run_dir: Path, analyzer_metadata: dict[str, Any], analyzer: Path) -> dict[str, Any]:
    metadata_path = run_dir / "metadata.json"
    metadata = load_json(metadata_path) or {}
    quality = analyzer_metadata["referenceQuality"]
    merged = dict(metadata)
    for key in ("model_id", "reference_audio", "converted_reference_audio", "prompt_text_present"):
        if key not in merged and key in analyzer_metadata:
            merged[key] = analyzer_metadata[key]
    merged["referenceQuality"] = quality
    merged["referenceQualitySource"] = {
        "kind": "reanalyzed",
        "analyzer": str(analyzer),
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
    }
    metadata_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return quality


def build_profile_after_reanalysis(args: argparse.Namespace) -> dict[str, Any]:
    profile_args = argparse.Namespace(
        runs_dir=args.runs_dir,
        profile_id=args.profile_id,
        out_dir=args.out_dir,
        min_clips=args.min_clips,
        max_clips=args.max_clips,
        max_rejections=args.max_rejections,
        min_duration_sec=args.min_duration_sec,
        max_duration_sec=args.max_duration_sec,
        copy_clips=args.copy_clips,
    )
    profile = build_profile(profile_args)
    out_dir = Path(args.out_dir)
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "profile": str(out_dir / "profile.json"),
        "status": profile["status"],
        "eligibleClips": profile["summary"]["eligibleClips"],
        "selectedClips": profile["summary"]["selectedClips"],
        "remainingClipsNeeded": profile["summary"]["remainingClipsNeeded"],
        "dryRun": args.dry_run,
    }


def reanalyze_runs(args: argparse.Namespace) -> dict[str, Any]:
    runs_dir = Path(args.runs_dir)
    analyzer = Path(args.analyzer).resolve()
    python = (
        args.python
        or os.environ.get("ANYVOICE_VOXCPM_PYTHON")
        or env_file_value("ANYVOICE_VOXCPM_PYTHON")
        or os.environ.get("PYTHON")
        or env_file_value("PYTHON")
        or sys.executable
    )
    rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    skipped: dict[str, int] = {
        "already_analyzed": 0,
        "profile_generated": 0,
        "sample_source": 0,
        "missing_audio": 0,
        "missing_transcript": 0,
        "not_directory": 0,
    }

    entries = sorted(runs_dir.iterdir() if runs_dir.exists() else [])
    scanned = 0
    for run_dir in entries:
        if not run_dir.is_dir():
            skipped["not_directory"] += 1
            continue
        scanned += 1
        if is_profile_generated_run(run_dir):
            skipped["profile_generated"] += 1
            continue
        if is_sample_source_run(run_dir):
            skipped["sample_source"] += 1
            continue
        if existing_quality(run_dir) and not args.force:
            skipped["already_analyzed"] += 1
            continue

        reference_audio = reference_audio_for_analysis(run_dir)
        if not reference_audio:
            skipped["missing_audio"] += 1
            continue
        prompt_text_file = prompt_text_file_for_run(run_dir)
        if not prompt_text_file:
            skipped["missing_transcript"] += 1
            continue

        source_kind = source_kind_for_run(run_dir)
        row = {
            "sourceRunId": run_dir.name,
            "metadataPath": str(run_dir / "metadata.json"),
            "referenceAudio": str(reference_audio),
            "promptTextFile": str(prompt_text_file),
            "sourceKind": source_kind,
        }
        if args.dry_run:
            rows.append({**row, "status": "planned"})
            continue

        metadata = load_json(run_dir / "metadata.json") or {}
        model_id = str(metadata.get("model_id") or os.environ.get("ANYVOICE_MODEL_ID") or "openbmb/VoxCPM2")
        try:
            analyzer_metadata = run_analyzer(
                python=python,
                analyzer=analyzer,
                run_dir=run_dir,
                reference_audio=reference_audio,
                prompt_text_file=prompt_text_file,
                model_id=model_id,
                source_kind=source_kind,
            )
            quality = merge_analyzer_metadata(run_dir, analyzer_metadata, analyzer)
            rows.append({**row, "status": "updated", "quality": compact_quality(quality)})
        except subprocess.CalledProcessError as exc:
            message = (exc.stderr or exc.stdout or str(exc)).strip()
            failures.append({"sourceRunId": run_dir.name, "message": message})
        except Exception as exc:  # noqa: BLE001
            failures.append({"sourceRunId": run_dir.name, "message": str(exc)})

    result: dict[str, Any] = {
        "status": "completed_with_errors" if failures else "completed",
        "runsDir": str(runs_dir),
        "analyzer": str(analyzer),
        "python": python,
        "dryRun": args.dry_run,
        "force": args.force,
        "scanned": scanned,
        "plannedOrUpdated": len(rows),
        "skipped": skipped,
        "runs": rows,
        "failures": failures,
    }
    if args.build_profile:
        result["profile"] = build_profile_after_reanalysis(args)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill referenceQuality metadata for existing AnyVoice recordings.")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    parser.add_argument("--analyzer", default=str(DEFAULT_ANALYZER))
    parser.add_argument("--python", default="")
    parser.add_argument("--force", action="store_true", help="Re-run the analyzer even when metadata.referenceQuality already exists.")
    parser.add_argument("--dry-run", action="store_true", help="List runs that would be analyzed without writing metadata.")
    parser.add_argument("--build-profile", action="store_true", help="Rebuild the profile manifest after reanalysis.")
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--out-dir", default=str(DEFAULT_VOICES_DIR / "local-default"))
    parser.add_argument("--min-clips", type=int, default=5)
    parser.add_argument("--max-clips", type=int, default=10)
    parser.add_argument("--max-rejections", type=int, default=50)
    parser.add_argument("--min-duration-sec", type=float, default=6.0)
    parser.add_argument("--max-duration-sec", type=float, default=20.0)
    parser.add_argument("--copy-clips", action="store_true")
    args = parser.parse_args()

    result = reanalyze_runs(args)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if result.get("status") == "completed_with_errors":
        sys.exit(2)


if __name__ == "__main__":
    main()

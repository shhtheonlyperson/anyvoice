from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_voice_profile import detect_chinese_script, strict_traditional_script_errors


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNS_DIR = REPO_ROOT / ".anyvoice" / "runs"
DEFAULT_VOICES_DIR = REPO_ROOT / ".anyvoice" / "voices"
DEFAULT_ANALYZER = REPO_ROOT / "scripts" / "analyze_voice_reference.py"
DEFAULT_MODEL_ID = "openbmb/VoxCPM2"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path}: {exc}") from exc


def load_manifest(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    rows: list[dict[str, Any]] = []
    if suffix == ".jsonl":
        for line_no, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            line = raw_line.strip()
            if not line:
                continue
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise SystemExit(f"manifest JSONL row {line_no} is not an object: {path}")
            rows.append(parsed)
        return rows
    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as handle:
            return [dict(row) for row in csv.DictReader(handle)]

    parsed = load_json(path)
    if isinstance(parsed, dict) and isinstance(parsed.get("clips"), list):
        parsed = parsed["clips"]
    if not isinstance(parsed, list):
        raise SystemExit("manifest must be a JSON list, { clips: [...] }, JSONL, or CSV")
    for index, row in enumerate(parsed, start=1):
        if not isinstance(row, dict):
            raise SystemExit(f"manifest row {index} is not an object")
        rows.append(row)
    return rows


def field(row: dict[str, Any], names: tuple[str, ...]) -> str:
    for name in names:
        value = row.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def normalized_transcript(value: str) -> str:
    return "\n".join(" ".join(line.split()) for line in value.splitlines()).strip()


def safe_id(value: str) -> str:
    chars = [char if char.isalnum() or char in {"-", "_"} else "-" for char in value.strip()]
    compact = "-".join("".join(chars).split("-"))
    return compact[:60] or "clip"


def unique_run_id(runs_dir: Path, requested: str) -> str:
    base = safe_id(requested)
    candidate = base
    suffix = 2
    while (runs_dir / candidate).exists():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def resolve_audio_path(raw_path: str, manifest_dir: Path) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = manifest_dir / audio_path
    return audio_path.resolve()


def manifest_quality(row: dict[str, Any]) -> dict[str, Any] | None:
    raw = row.get("quality") or row.get("referenceQuality")
    if not isinstance(raw, dict):
        return None
    grade = str(raw.get("grade") or "").upper()
    duration = raw.get("durationSec")
    if grade not in {"A", "B", "C", "D"} or not isinstance(duration, (int, float)):
        return None
    return {
        "grade": grade,
        "durationSec": round(float(duration), 3),
        "snrDb": raw.get("snrDb") if isinstance(raw.get("snrDb"), (int, float)) else None,
        "clippingRatio": float(raw.get("clippingRatio") or 0.0),
        "vadActiveRatio": float(raw.get("vadActiveRatio") or 0.0),
        "warnings": [str(item) for item in raw.get("warnings", [])] if isinstance(raw.get("warnings"), list) else [],
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def attach_recording_kit_clip_id(metadata_path: Path, recording_kit_clip_id: str) -> None:
    metadata = load_json(metadata_path)
    if not isinstance(metadata, dict):
        return
    metadata["recording_kit_clip_id"] = recording_kit_clip_id
    write_json(metadata_path, metadata)


def run_analyzer(
    *,
    analyzer_python: str,
    reference_path: Path,
    prompt_path: Path,
    metadata_path: Path,
    model_id: str,
    source_kind: str,
) -> None:
    proc = subprocess.run(
        [
            analyzer_python,
            str(DEFAULT_ANALYZER),
            "--reference-audio",
            str(reference_path),
            "--prompt-text-file",
            str(prompt_path),
            "--metadata-output",
            str(metadata_path),
            "--model-id",
            model_id,
            "--source-kind",
            source_kind,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"analyzer exited with {proc.returncode}"
        if "No module named 'soundfile'" in detail or "No module named 'numpy'" in detail:
            raise RuntimeError(
                "profile analyzer dependencies are missing: pass --analyzer-python pointing to the VoxCPM Python environment with numpy and soundfile installed"
            )
        raise RuntimeError(detail)


def import_row(
    *,
    row: dict[str, Any],
    index: int,
    manifest_dir: Path,
    runs_dir: Path,
    run_prefix: str,
    model_id: str,
    source_kind_default: str,
    analyzer_python: str,
    trust_manifest_quality: bool,
    manifest_quality_reason: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    raw_audio = field(row, ("audioPath", "audio", "path", "file"))
    transcript = normalized_transcript(field(row, ("transcript", "promptTranscript", "text")))
    if not raw_audio:
        raise SystemExit(f"manifest row {index} is missing audioPath/audio/path/file")
    if not transcript:
        raise SystemExit(f"manifest row {index} is missing transcript/promptTranscript/text")
    transcript_script = detect_chinese_script(transcript)
    script_errors = strict_traditional_script_errors(transcript)
    if script_errors:
        raise SystemExit(
            f"manifest row {index} transcript must use Traditional Chinese; "
            f"Simplified, mixed, or unproven Chinese clips are not accepted for the Traditional Mandarin voice profile "
            f"(detected {transcript_script}; errors={','.join(script_errors)})"
        )
    audio_path = resolve_audio_path(raw_audio, manifest_dir)
    if not audio_path.exists():
        raise SystemExit(f"manifest row {index} audio not found: {audio_path}")

    requested_id = field(row, ("id", "runId", "sourceRunId")) or f"{run_prefix}-{index:03d}"
    recording_kit_clip_id = requested_id
    run_id = unique_run_id(runs_dir, requested_id)
    source_kind = field(row, ("sourceKind",)) or source_kind_default
    run_dir = runs_dir / run_id
    suffix = audio_path.suffix or ".wav"
    reference_path = run_dir / f"reference{suffix}"
    prompt_path = run_dir / "prompt-transcript.txt"
    prompt_raw_path = run_dir / "prompt-transcript.raw.txt"
    metadata_path = run_dir / "metadata.json"

    result = {
        "runId": run_id,
        "audioPath": str(audio_path),
        "transcript": transcript,
        "transcriptScript": transcript_script,
        "sourceKind": source_kind,
        "recordingKitClipId": recording_kit_clip_id,
        "status": "planned" if dry_run else "imported",
    }
    if dry_run:
        return result

    run_dir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(audio_path, reference_path)
    prompt_path.write_text(transcript, encoding="utf-8")
    prompt_raw_path.write_text(transcript, encoding="utf-8")
    write_json(
        run_dir / "text-prep.json",
        {"version": 1, "promptTranscript": {"raw": transcript, "model": transcript, "warnings": []}},
    )
    write_json(
        run_dir / "request.json",
        {
            "status": "profile_enrollment",
            "modelId": model_id,
            "voiceName": audio_path.name,
            "voiceType": "",
            "voiceSize": audio_path.stat().st_size,
            "sourceKind": source_kind,
            "referenceSource": {"kind": source_kind},
            "importSource": str(audio_path),
            "recordingKitClipId": recording_kit_clip_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "textPreparation": {
                "promptTranscript": {"raw": transcript, "model": transcript, "warnings": []},
            },
        },
    )

    trusted_quality = manifest_quality(row) if trust_manifest_quality else None
    if trusted_quality:
        write_json(
            metadata_path,
            {
                "model_id": model_id,
                "mode": "profile_enrollment",
                "source_kind": source_kind,
                "recording_kit_clip_id": recording_kit_clip_id,
                "reference_audio": str(reference_path),
                "prompt_text_present": True,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "referenceQuality": trusted_quality,
                "referenceQualitySource": {
                    "kind": "trusted_manifest",
                    "reason": manifest_quality_reason,
                },
            },
        )
    else:
        run_analyzer(
            analyzer_python=analyzer_python,
            reference_path=reference_path,
            prompt_path=prompt_path,
            metadata_path=metadata_path,
            model_id=model_id,
            source_kind=source_kind,
        )
        attach_recording_kit_clip_id(metadata_path, recording_kit_clip_id)

    metadata = load_json(metadata_path)
    if isinstance(metadata, dict):
        result["referenceQuality"] = metadata.get("referenceQuality")
    return result


def build_profile(runs_dir: Path, voices_dir: Path, profile_id: str) -> dict[str, Any]:
    out_dir = voices_dir / profile_id
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "build_voice_profile.py"),
            "--runs-dir",
            str(runs_dir),
            "--out-dir",
            str(out_dir),
            "--profile-id",
            profile_id,
            "--copy-clips",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"profile builder exited with {proc.returncode}"
        raise RuntimeError(detail)
    parsed = json.loads(proc.stdout)
    return parsed if isinstance(parsed, dict) else {"profile": str(out_dir / "profile.json")}


def main() -> None:
    parser = argparse.ArgumentParser(description="Batch-import consented AnyVoice enrollment clips from a manifest into local profile run evidence.")
    parser.add_argument("--manifest", required=True, help="JSON/JSONL/CSV rows with audioPath and transcript.")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    parser.add_argument("--voices-dir", default=str(DEFAULT_VOICES_DIR))
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--source-kind", choices=("scripted", "freeform", "uploaded"), default="uploaded")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--analyzer-python", default="")
    parser.add_argument("--trust-manifest-quality", action="store_true", help="Use per-row quality/referenceQuality instead of running the analyzer. Intended only for already-analyzed migration manifests.")
    parser.add_argument("--allow-unsafe-trust-manifest-quality", action="store_true", help="Allow --trust-manifest-quality for migration/debug imports. Requires --unsafe-manifest-quality-reason.")
    parser.add_argument("--unsafe-manifest-quality-reason", default="", help="Required reason when trusting manifest quality instead of analyzing audio.")
    parser.add_argument("--build-profile", action="store_true", help="Rebuild .anyvoice/voices/<profile-id>/profile.json after import.")
    parser.add_argument("--run-prefix", default=f"import-{utc_stamp()}")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    rows = load_manifest(manifest_path)
    manifest_quality_reason = args.unsafe_manifest_quality_reason.strip()
    if args.trust_manifest_quality and (not args.allow_unsafe_trust_manifest_quality or not manifest_quality_reason):
        print(
            json.dumps(
                {
                    "status": "unsafe_trust_manifest_quality_blocked",
                    "manifest": str(manifest_path),
                    "manifestQuality": {
                        "trusted": True,
                        "acceptedUnsafeTrust": False,
                        "reason": None,
                        "requiredFlags": [
                            "--allow-unsafe-trust-manifest-quality",
                            "--unsafe-manifest-quality-reason",
                        ],
                    },
                    "imported": 0,
                    "dryRun": args.dry_run,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)
    runs_dir = Path(args.runs_dir).expanduser().resolve()
    voices_dir = Path(args.voices_dir).expanduser().resolve()
    brenda_python = Path("/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python")
    analyzer_python = (
        args.analyzer_python
        or os.environ.get("ANYVOICE_VOXCPM_PYTHON")
        or (str(brenda_python) if brenda_python.exists() else sys.executable)
    )

    imported: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        imported.append(
            import_row(
                row=row,
                index=index,
                manifest_dir=manifest_path.parent,
                runs_dir=runs_dir,
                run_prefix=args.run_prefix,
                model_id=args.model_id,
                source_kind_default=args.source_kind,
                analyzer_python=analyzer_python,
                trust_manifest_quality=args.trust_manifest_quality,
                manifest_quality_reason=manifest_quality_reason if args.trust_manifest_quality else None,
                dry_run=args.dry_run,
            )
        )

    profile = None
    if args.build_profile and not args.dry_run:
        profile = build_profile(runs_dir, voices_dir, args.profile_id)

    print(
        json.dumps(
            {
                "status": "planned" if args.dry_run else "imported",
                "manifest": str(manifest_path),
                "runsDir": str(runs_dir),
                "voicesDir": str(voices_dir),
                "profileId": args.profile_id,
                "manifestQuality": {
                    "trusted": bool(args.trust_manifest_quality),
                    "acceptedUnsafeTrust": bool(args.trust_manifest_quality and args.allow_unsafe_trust_manifest_quality),
                    "reason": manifest_quality_reason if args.trust_manifest_quality else None,
                },
                "imported": len(imported),
                "clips": imported,
                "profile": profile,
                "dryRun": args.dry_run,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

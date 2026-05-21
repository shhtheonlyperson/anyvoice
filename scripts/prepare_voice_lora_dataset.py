from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from verify_voice_profile_ready import readiness_report as verify_profile_readiness_report


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
DEFAULT_OUT_ROOT = REPO_ROOT / "generated" / "voice-lora-datasets"
DEFAULT_LORA_MIN_CLIPS = 10
DEFAULT_LORA_MIN_TOTAL_DURATION_SEC = 60.0
PRODUCT_PROOF_SPEAKER_BACKEND = "speechbrain-ecapa"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} is not a JSON object: {path}")
    return payload


def load_profile(path: Path) -> dict[str, Any]:
    return load_json_object(path, "voice profile")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def same_resolved_path(raw_path: Any, expected_path: Path) -> bool:
    return isinstance(raw_path, str) and Path(raw_path).expanduser().resolve() == expected_path.resolve()


def profile_clips(profile: dict[str, Any]) -> list[dict[str, Any]]:
    clips = profile.get("clips")
    return [clip for clip in clips if isinstance(clip, dict)] if isinstance(clips, list) else []


def summary_int(profile: dict[str, Any], key: str, fallback: int) -> int:
    summary = profile.get("summary")
    if isinstance(summary, dict) and isinstance(summary.get(key), int):
        return int(summary[key])
    return fallback


def requirement_int(profile: dict[str, Any], key: str, fallback: int) -> int:
    requirements = profile.get("requirements")
    if isinstance(requirements, dict) and isinstance(requirements.get(key), int):
        return int(requirements[key])
    return fallback


def require_ready_profile(profile_path: Path, profile: dict[str, Any], min_clips: int) -> None:
    clips = profile_clips(profile)
    selected = summary_int(profile, "selectedClips", len(clips))
    eligible = summary_int(profile, "eligibleClips", selected)
    remaining = summary_int(profile, "remainingClipsNeeded", max(0, min_clips - selected))
    if profile.get("status") == "ready" and selected >= min_clips and len(clips) >= min_clips:
        return
    raise SystemExit(
        "voice profile is not ready for LoRA dataset export: "
        f"{selected} selected / {eligible} eligible; "
        f"{remaining} more qualified reference clips needed ({profile_path})"
    )


def resolve_audio_path(profile_path: Path, raw_path: str) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = profile_path.parent / audio_path
    return audio_path.resolve()


def clip_duration(clip: dict[str, Any]) -> float:
    quality = clip.get("quality")
    if isinstance(quality, dict) and isinstance(quality.get("durationSec"), (int, float)):
        return float(quality["durationSec"])
    return 0.0


def clip_grade(clip: dict[str, Any]) -> str:
    quality = clip.get("quality")
    if isinstance(quality, dict) and isinstance(quality.get("grade"), str):
        return str(quality["grade"]).upper()
    return "UNKNOWN"


def validate_clips(profile_path: Path, clips: list[dict[str, Any]], min_total_duration_sec: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    total_duration = 0.0

    for index, clip in enumerate(clips, start=1):
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        transcript = str(clip.get("transcriptRaw") or "").strip()
        raw_audio_path = str(clip.get("audioPath") or "").strip()
        if not source_run_id:
            raise SystemExit(f"profile clip #{index} is missing sourceRunId ({profile_path})")
        if not transcript:
            raise SystemExit(f"profile clip {source_run_id} is missing transcriptRaw ({profile_path})")
        if not raw_audio_path:
            raise SystemExit(f"profile clip {source_run_id} is missing audioPath ({profile_path})")
        audio_path = resolve_audio_path(profile_path, raw_audio_path)
        if not audio_path.exists():
            raise SystemExit(f"profile clip audio is missing: {audio_path}")
        total_duration += clip_duration(clip)
        rows.append({**clip, "audioPath": str(audio_path), "transcriptRaw": transcript})

    if total_duration < min_total_duration_sec:
        raise SystemExit(
            f"profile audio duration is too short for LoRA dataset export: "
            f"{total_duration:.3f}s < {min_total_duration_sec:.3f}s"
        )
    return rows


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_transcript_validation(
    *,
    profile_path: Path,
    rows: list[dict[str, Any]],
    validation_path: Path,
) -> None:
    payload = load_json_object(validation_path, "transcript validation JSON")
    if not same_resolved_path(payload.get("profile"), profile_path):
        raise SystemExit(
            "transcript validation JSON does not match the profile: "
            f"{validation_path} is for {payload.get('profile')!r}, expected {profile_path}"
        )
    if payload.get("status") != "pass":
        raise SystemExit(
            f"transcript validation JSON status is {payload.get('status')!r}; expected 'pass' ({validation_path})"
        )

    by_source = {str(row.get("sourceRunId") or ""): row for row in transcript_validation_rows(payload) if row.get("sourceRunId")}
    missing: list[str] = []
    failed: list[dict[str, Any]] = []
    for row in rows:
        source_run_id = str(row.get("sourceRunId") or "").strip()
        validation_row = by_source.get(source_run_id)
        if not validation_row:
            missing.append(source_run_id)
            continue
        if validation_row.get("verdict") != "pass":
            failed.append(
                {
                    "sourceRunId": source_run_id,
                    "verdict": validation_row.get("verdict"),
                    "cer": validation_row.get("cer"),
                    "wer": validation_row.get("wer"),
                    "error": validation_row.get("error"),
                }
            )
    if missing or failed:
        raise SystemExit(
            "transcript validation JSON does not pass every selected profile clip: "
            f"{len(missing)} missing, {len(failed)} failed ({validation_path})"
        )


def require_strict_ready_profile(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    transcript_validation_json: Path,
    min_clips: int,
    min_total_duration_sec: float,
) -> dict[str, Any]:
    report = verify_profile_readiness_report(
        profile_path=profile_path,
        profile=profile,
        min_clips_override=min_clips,
        min_total_duration_sec=min_total_duration_sec,
        check_audio_exists=True,
        audio_exists_bypass_reason=None,
        transcript_validation_json=transcript_validation_json,
        require_transcript_validation=True,
    )
    if report.get("status") == "ready":
        return report
    failed = [
        f"{row.get('check')}: {row.get('message')}"
        for row in report.get("checks", [])
        if isinstance(row, dict) and row.get("ok") is not True
    ]
    detail = "; ".join(failed[:6]) or "strict verifier returned blocked"
    raise SystemExit(
        "LoRA dataset export requires strict ready profile proof before writing: "
        f"{detail} ({profile_path})"
    )


def is_product_proof_quality_gate(payload: dict[str, Any]) -> bool:
    inputs = payload.get("inputs")
    proofs = payload.get("proofs")
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    speaker = proofs.get("speakerBackendRequirement")
    speaker_ok = (
        isinstance(speaker, dict)
        and speaker.get("required") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker.get("selected") == PRODUCT_PROOF_SPEAKER_BACKEND
    )
    commands = payload.get("commands") if isinstance(payload.get("commands"), dict) else {}
    score_command = str(commands.get("score") or "") if isinstance(commands, dict) else ""
    return (
        inputs.get("cloneMode") == "both"
        and inputs.get("requireSpeakerBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker_ok
        and "require-paired-improvement" in score_command
    )


def validate_quality_gate(*, profile_path: Path, quality_gate_path: Path, require_product_proof: bool) -> None:
    payload = load_json_object(quality_gate_path, "quality gate JSON")
    inputs = payload.get("inputs")
    if not isinstance(inputs, dict) or not same_resolved_path(inputs.get("profileJson"), profile_path):
        profile_json = inputs.get("profileJson") if isinstance(inputs, dict) else None
        raise SystemExit(
            "quality gate JSON does not match the profile: "
            f"{quality_gate_path} is for {profile_json!r}, expected {profile_path}"
        )
    if payload.get("status") != "pass" or payload.get("dryRun") is not False:
        raise SystemExit(
            "quality gate JSON must be a non-dry-run pass: "
            f"status={payload.get('status')!r}, dryRun={payload.get('dryRun')!r} ({quality_gate_path})"
        )
    proofs = payload.get("proofs")
    if not isinstance(proofs, dict):
        raise SystemExit(f"quality gate JSON is missing proof metadata ({quality_gate_path})")
    if (
        inputs.get("skipProfileVerify") is True
        or proofs.get("profileVerifyRequired") is not True
        or proofs.get("profileVerifyPassed") is not True
    ):
        raise SystemExit(f"quality gate JSON did not prove profile verification passed ({quality_gate_path})")
    if (
        inputs.get("skipTranscriptValidation") is True
        or proofs.get("transcriptValidationRequired") is not True
        or proofs.get("transcriptValidationPassed") is not True
    ):
        raise SystemExit(f"quality gate JSON did not prove transcript validation passed ({quality_gate_path})")
    if require_product_proof and not is_product_proof_quality_gate(payload):
        raise SystemExit(
            "quality gate JSON is not a paired product-proof gate: expected clone-mode both, "
            f"required speaker backend {PRODUCT_PROOF_SPEAKER_BACKEND}, and paired improvement scoring ({quality_gate_path})"
        )


def unsafe_bypass_reason(args: argparse.Namespace) -> str | None:
    if not (args.skip_transcript_validation or args.skip_quality_gate):
        return None
    reason = str(args.unsafe_bypass_reason or "").strip()
    if args.dry_run:
        return reason or "dry-run only"
    if args.allow_unsafe_export and reason:
        return reason
    raise SystemExit(
        "unsafe LoRA dataset proof bypass refused: skip flags can only write files with "
        "--allow-unsafe-export and --unsafe-bypass-reason. Use --dry-run for migration planning."
    )


def split_rows(rows: list[dict[str, Any]], val_ratio: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(rows) <= 1:
        return rows, []
    val_count = max(1, min(len(rows) - 1, round(len(rows) * val_ratio)))
    train_count = len(rows) - val_count
    return rows[:train_count], rows[train_count:]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )


def row_for_clip(
    *,
    clip: dict[str, Any],
    split: str,
    speaker_id: str,
    dataset_audio_path: Path | None,
) -> dict[str, Any]:
    profile_audio_path = Path(clip["audioPath"])
    audio_path = dataset_audio_path or profile_audio_path
    transcript = str(clip["transcriptRaw"])
    return {
        "audio": str(audio_path),
        "audioSha256": sha256_file(audio_path),
        "text": transcript,
        "transcriptSha256": sha256_text(transcript),
        "speaker": speaker_id,
        "split": split,
        "sourceRunId": clip.get("sourceRunId"),
        "profileAudioPath": str(profile_audio_path),
        "durationSec": clip_duration(clip),
        "grade": clip_grade(clip),
        "transcriptScript": clip.get("transcriptScript"),
        "modelId": clip.get("modelId"),
        "cloneMode": clip.get("cloneMode"),
        "consentSource": "anyvoice_profile_enrollment",
    }


def materialize_dataset(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    rows: list[dict[str, Any]],
    out_dir: Path,
    copy_audio: bool,
    val_ratio: float,
    transcript_validation_json: Path | None,
    quality_gate_json: Path | None,
    strict_profile_proof: dict[str, Any] | None,
    product_proof_quality_gate_required: bool,
    proof_bypass_reason: str | None,
    skipped_transcript_validation: bool,
    skipped_quality_gate: bool,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = out_dir / "audio"
    if copy_audio:
        audio_dir.mkdir(parents=True, exist_ok=True)

    speaker_id = str(profile.get("voiceProfileId") or profile_path.parent.name or "local-default")
    train_source, val_source = split_rows(rows, val_ratio)
    manifests: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "all": []}

    for split, split_rows_source in (("train", train_source), ("val", val_source)):
        for index, clip in enumerate(split_rows_source, start=1):
            dataset_audio_path: Path | None = None
            if copy_audio:
                src = Path(clip["audioPath"])
                suffix = src.suffix or ".wav"
                dataset_audio_path = audio_dir / f"{split}-{index:03d}-{clip['sourceRunId']}{suffix}"
                shutil.copy2(src, dataset_audio_path)
            row = row_for_clip(
                clip=clip,
                split=split,
                speaker_id=speaker_id,
                dataset_audio_path=dataset_audio_path,
            )
            manifests[split].append(row)
            manifests["all"].append(row)

    write_jsonl(out_dir / "manifest.train.jsonl", manifests["train"])
    write_jsonl(out_dir / "manifest.val.jsonl", manifests["val"])
    write_jsonl(out_dir / "manifest.all.jsonl", manifests["all"])

    metadata = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "profilePath": str(profile_path),
        "voiceProfileId": speaker_id,
        "profileStatus": profile.get("status"),
        "copyAudio": copy_audio,
        "trainClips": len(manifests["train"]),
        "valClips": len(manifests["val"]),
        "totalClips": len(manifests["all"]),
        "totalDurationSec": round(sum(float(row["durationSec"]) for row in manifests["all"]), 3),
        "proofs": {
            "transcriptValidationJson": str(transcript_validation_json) if transcript_validation_json else None,
            "qualityGateJson": str(quality_gate_json) if quality_gate_json else None,
            "productProofQualityGateRequired": product_proof_quality_gate_required,
            "strictProfileProof": strict_profile_proof,
            "bypass": {
                "transcriptValidationSkipped": skipped_transcript_validation,
                "qualityGateSkipped": skipped_quality_gate,
                "unsafeExport": proof_bypass_reason is not None,
                "reason": proof_bypass_reason,
            },
        },
        "manifests": {
            "train": str(out_dir / "manifest.train.jsonl"),
            "val": str(out_dir / "manifest.val.jsonl"),
            "all": str(out_dir / "manifest.all.jsonl"),
        },
        "notes": [
            "This export is gated by profile ASR transcript validation and a non-dry-run quality gate unless an unsafe bypass is explicitly acknowledged.",
            "When productProofQualityGateRequired is true, the quality gate must be the paired prompt-vs-hifi product proof with the required speaker backend.",
            "Use transcript text exactly as recorded; do not apply target-text pronunciation overrides to training transcripts.",
            "This export is a dataset handoff for per-speaker LoRA experiments; it does not train or validate a LoRA by itself.",
        ],
        "nextCommands": {
            "trainingJob": (
                "python3 scripts/prepare_voxcpm_lora_training_job.py "
                f"--dataset-json {out_dir / 'dataset.json'}"
            ),
        },
    }
    (out_dir / "dataset.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return metadata


def default_out_dir(profile: dict[str, Any]) -> Path:
    profile_id = str(profile.get("voiceProfileId") or "local-default")
    return DEFAULT_OUT_ROOT / f"{profile_id}-{utc_stamp()}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a gated AnyVoice LoRA training dataset manifest from a ready voice profile.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--out-dir", help="Output directory. Defaults to generated/voice-lora-datasets/<profile-id>-<timestamp>.")
    parser.add_argument("--copy-audio", action="store_true", help="Copy clips into the dataset directory instead of referencing profile paths.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and summarize without writing dataset files.")
    parser.add_argument("--transcript-validation-json", help="Passing profile transcript-validation report. Defaults to <profile-dir>/transcript-validation.json.")
    parser.add_argument("--quality-gate-json", help="Passing non-dry-run quality-gate report for this profile.")
    parser.add_argument(
        "--require-product-proof-quality-gate",
        action="store_true",
        help="Require --quality-gate-json to be the paired product proof gate, not a hifi-only quality gate.",
    )
    parser.add_argument("--skip-transcript-validation", action="store_true", help="Explicitly bypass transcript-validation proof checks for migration/debug handoffs.")
    parser.add_argument("--skip-quality-gate", action="store_true", help="Explicitly bypass quality-gate proof checks for migration/debug handoffs.")
    parser.add_argument("--allow-unsafe-export", action="store_true", help="Allow writing a LoRA dataset while proof skip flags are set. Requires --unsafe-bypass-reason.")
    parser.add_argument("--unsafe-bypass-reason", help="Required reason when writing a dataset with transcript/quality proof skip flags.")
    parser.add_argument("--min-clips", type=int, default=DEFAULT_LORA_MIN_CLIPS, help="Minimum selected profile clips required for LoRA export.")
    parser.add_argument("--min-total-duration-sec", type=float, default=DEFAULT_LORA_MIN_TOTAL_DURATION_SEC)
    parser.add_argument("--val-ratio", type=float, default=0.2)
    args = parser.parse_args()

    profile_path = Path(args.profile_json).expanduser().resolve()
    profile = load_profile(profile_path)
    min_clips = args.min_clips
    require_ready_profile(profile_path, profile, min_clips)
    rows = validate_clips(profile_path, profile_clips(profile)[: requirement_int(profile, "maxClips", 10)], args.min_total_duration_sec)
    proof_bypass_reason = unsafe_bypass_reason(args)
    transcript_validation_json = None
    strict_profile_proof: dict[str, Any] | None = None
    if not args.skip_transcript_validation:
        transcript_validation_json = (
            Path(args.transcript_validation_json).expanduser().resolve()
            if args.transcript_validation_json
            else (profile_path.parent / "transcript-validation.json").resolve()
        )
        validate_transcript_validation(
            profile_path=profile_path,
            rows=rows,
            validation_path=transcript_validation_json,
        )
        strict_report = require_strict_ready_profile(
            profile_path=profile_path,
            profile=profile,
            transcript_validation_json=transcript_validation_json,
            min_clips=min_clips,
            min_total_duration_sec=args.min_total_duration_sec,
        )
        summary = strict_report.get("summary") if isinstance(strict_report.get("summary"), dict) else {}
        strict_profile_proof = {
            "status": "strict_ready",
            "transcriptValidationJson": str(transcript_validation_json),
            "summary": {
                "selectedClips": summary.get("selectedClips"),
                "totalDurationSec": summary.get("totalDurationSec"),
                "missingCoverageFeatures": summary.get("missingCoverageFeatures"),
            },
        }
    quality_gate_json = None
    if not args.skip_quality_gate:
        if not args.quality_gate_json:
            raise SystemExit("quality gate JSON is required; pass --quality-gate-json or --skip-quality-gate")
        quality_gate_json = Path(args.quality_gate_json).expanduser().resolve()
        validate_quality_gate(
            profile_path=profile_path,
            quality_gate_path=quality_gate_json,
            require_product_proof=args.require_product_proof_quality_gate,
        )
    train_rows, val_rows = split_rows(rows, args.val_ratio)
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else default_out_dir(profile)

    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "ready",
                    "profile": str(profile_path),
                    "outDir": str(out_dir),
                    "voiceProfileId": profile.get("voiceProfileId"),
                    "trainClips": len(train_rows),
                    "valClips": len(val_rows),
                    "totalClips": len(rows),
                    "totalDurationSec": round(sum(clip_duration(clip) for clip in rows), 3),
                    "proofs": {
                        "transcriptValidationJson": str(transcript_validation_json) if transcript_validation_json else None,
                        "qualityGateJson": str(quality_gate_json) if quality_gate_json else None,
                        "productProofQualityGateRequired": args.require_product_proof_quality_gate,
                        "strictProfileProof": strict_profile_proof,
                        "bypass": {
                            "transcriptValidationSkipped": args.skip_transcript_validation,
                            "qualityGateSkipped": args.skip_quality_gate,
                            "unsafeExport": proof_bypass_reason is not None and not args.dry_run,
                            "reason": proof_bypass_reason,
                        },
                    },
                    "dryRun": True,
                },
                ensure_ascii=False,
            )
        )
        return

    metadata = materialize_dataset(
        profile_path=profile_path,
        profile=profile,
        rows=rows,
        out_dir=out_dir,
        copy_audio=args.copy_audio,
        val_ratio=args.val_ratio,
        transcript_validation_json=transcript_validation_json,
        quality_gate_json=quality_gate_json,
        strict_profile_proof=strict_profile_proof,
        product_proof_quality_gate_required=args.require_product_proof_quality_gate,
        proof_bypass_reason=proof_bypass_reason,
        skipped_transcript_validation=args.skip_transcript_validation,
        skipped_quality_gate=args.skip_quality_gate,
    )
    print(json.dumps({"status": "written", "dataset": str(out_dir / "dataset.json"), **metadata}, ensure_ascii=False))


if __name__ == "__main__":
    main()

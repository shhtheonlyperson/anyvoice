from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_ROOT = REPO_ROOT / "generated" / "voice-lora-training-jobs"
DEFAULT_LORA_MIN_CLIPS = 10
DEFAULT_LORA_MIN_TOTAL_DURATION_SEC = 60.0
PRODUCT_PROOF_SPEAKER_BACKEND = "speechbrain-ecapa"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} is not a JSON object: {path}")
    return payload


def shell_join(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def resolve_path(raw_path: str, base_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def same_resolved_path(raw_path: Any, expected_path: Path, base_dir: Path) -> bool:
    return isinstance(raw_path, str) and resolve_path(raw_path, base_dir) == expected_path.resolve()


def require_string(payload: dict[str, Any], key: str, label: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"{label} is missing required string field: {key}")
    return value.strip()


def manifest_path(dataset: dict[str, Any], dataset_path: Path, key: str) -> Path:
    manifests = dataset.get("manifests")
    if not isinstance(manifests, dict):
        raise SystemExit(f"dataset is missing manifests object: {dataset_path}")
    raw_path = manifests.get(key)
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"dataset is missing manifests.{key}: {dataset_path}")
    return resolve_path(raw_path, dataset_path.parent)


def load_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc

    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{label} row {line_no} is not valid JSON: {path}: {exc}") from exc
        if not isinstance(row, dict):
            raise SystemExit(f"{label} row {line_no} is not an object: {path}")
        rows.append(row)
    if not rows:
        raise SystemExit(f"{label} has no rows: {path}")
    return rows


def row_duration(row: dict[str, Any], label: str, index: int) -> float:
    value = row.get("durationSec")
    if not isinstance(value, (int, float)) or float(value) <= 0:
        raise SystemExit(f"{label} row {index} has invalid durationSec")
    return float(value)


def validate_rows(
    *,
    rows: list[dict[str, Any]],
    label: str,
    manifest_dir: Path,
) -> float:
    total_duration = 0.0
    for index, row in enumerate(rows, start=1):
        raw_audio = require_string(row, "audio", f"{label} row {index}")
        text = require_string(row, "text", f"{label} row {index}")
        require_string(row, "sourceRunId", f"{label} row {index}")
        audio_sha256 = require_string(row, "audioSha256", f"{label} row {index}")
        transcript_sha256 = require_string(row, "transcriptSha256", f"{label} row {index}")
        profile_audio = require_string(row, "profileAudioPath", f"{label} row {index}")
        if len(text) < 2:
            raise SystemExit(f"{label} row {index} text is too short")
        audio_path = resolve_path(raw_audio, manifest_dir)
        if not audio_path.exists():
            raise SystemExit(f"{label} row {index} audio not found: {audio_path}")
        if sha256_file(audio_path) != audio_sha256:
            raise SystemExit(f"{label} row {index} audioSha256 mismatch: {audio_path}")
        if sha256_text(text) != transcript_sha256:
            raise SystemExit(f"{label} row {index} transcriptSha256 mismatch")
        if not Path(profile_audio).expanduser().is_absolute():
            raise SystemExit(f"{label} row {index} profileAudioPath must be absolute")
        total_duration += row_duration(row, label, index)
    return total_duration


def resolve_optional_proof_path(raw_path: Any, dataset_path: Path, key: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"LoRA dataset is missing required proof path: proofs.{key} ({dataset_path})")
    proof_path = resolve_path(raw_path, dataset_path.parent)
    if not proof_path.exists():
        raise SystemExit(f"LoRA dataset proof file is missing: {proof_path}")
    return proof_path


def dataset_profile_path(dataset: dict[str, Any], dataset_path: Path) -> Path | None:
    raw_path = dataset.get("profilePath")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    return resolve_path(raw_path, dataset_path.parent)


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_transcript_validation_proof(
    proof_path: Path,
    profile_path: Path | None,
    all_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = load_json(proof_path, "transcript validation proof")
    if payload.get("status") != "pass":
        raise SystemExit(
            f"transcript validation proof must have status='pass': "
            f"status={payload.get('status')!r} ({proof_path})"
        )
    if profile_path and not same_resolved_path(payload.get("profile"), profile_path, proof_path.parent):
        raise SystemExit(
            "transcript validation proof does not match the LoRA dataset profile: "
            f"{payload.get('profile')!r} != {profile_path} ({proof_path})"
        )
    by_source = {
        str(row.get("sourceRunId") or ""): row
        for row in transcript_validation_rows(payload)
        if row.get("sourceRunId")
    }
    missing: list[str] = []
    failed: list[str] = []
    stale: list[dict[str, Any]] = []
    for index, row in enumerate(all_rows, start=1):
        source_run_id = str(row.get("sourceRunId") or "").strip()
        validation_row = by_source.get(source_run_id)
        if not validation_row:
            missing.append(source_run_id or f"row-{index}")
            continue
        if validation_row.get("verdict") != "pass":
            failed.append(source_run_id)
        expected_transcript = str(row.get("text") or "")
        profile_audio_path = Path(str(row.get("profileAudioPath") or "")).expanduser()
        errors: list[str] = []
        if validation_row.get("expectedTranscript") != expected_transcript:
            errors.append("expected_transcript_mismatch")
        if not same_resolved_path(validation_row.get("audioPath"), profile_audio_path, proof_path.parent):
            errors.append("profile_audio_path_mismatch")
        if errors:
            stale.append(
                {
                    "sourceRunId": source_run_id,
                    "errors": errors,
                }
            )
    if missing or failed or stale:
        raise SystemExit(
            "transcript validation proof does not match every LoRA dataset row: "
            f"{len(missing)} missing, {len(failed)} failed, {len(stale)} stale ({proof_path})"
        )
    return {
        "validatedRows": len(all_rows),
        "transcriptValidationClips": len(by_source),
    }


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


def validate_quality_gate_proof(proof_path: Path, profile_path: Path | None) -> None:
    payload = load_json(proof_path, "quality gate proof")
    if payload.get("status") != "pass" or payload.get("dryRun") is not False:
        raise SystemExit(
            "quality gate proof must be a non-dry-run pass: "
            f"status={payload.get('status')!r}, dryRun={payload.get('dryRun')!r} ({proof_path})"
        )
    inputs = payload.get("inputs")
    if profile_path and (
        not isinstance(inputs, dict)
        or not same_resolved_path(inputs.get("profileJson"), profile_path, proof_path.parent)
    ):
        profile_json = inputs.get("profileJson") if isinstance(inputs, dict) else None
        raise SystemExit(
            "quality gate proof does not match the LoRA dataset profile: "
            f"{profile_json!r} != {profile_path} ({proof_path})"
        )
    proofs = payload.get("proofs")
    if not isinstance(proofs, dict):
        raise SystemExit(f"quality gate proof is missing proof metadata ({proof_path})")
    if not isinstance(inputs, dict):
        raise SystemExit(f"quality gate proof is missing input metadata ({proof_path})")
    if (
        inputs.get("skipProfileVerify") is True
        or proofs.get("profileVerifyRequired") is not True
        or proofs.get("profileVerifyPassed") is not True
    ):
        raise SystemExit(f"quality gate proof did not prove profile verification passed ({proof_path})")
    if (
        inputs.get("skipTranscriptValidation") is True
        or proofs.get("transcriptValidationRequired") is not True
        or proofs.get("transcriptValidationPassed") is not True
    ):
        raise SystemExit(f"quality gate proof did not prove transcript validation passed ({proof_path})")
    if not is_product_proof_quality_gate(payload):
        raise SystemExit(
            "quality gate proof is not a paired product-proof gate: expected clone-mode both, "
            f"required speaker backend {PRODUCT_PROOF_SPEAKER_BACKEND}, and paired improvement scoring ({proof_path})"
        )


def validate_dataset_proofs(
    *,
    dataset: dict[str, Any],
    dataset_path: Path,
    all_rows: list[dict[str, Any]],
    allow_unsafe_dataset: bool,
    unsafe_dataset_reason: str,
) -> dict[str, Any]:
    proofs = dataset.get("proofs")
    if not isinstance(proofs, dict):
        raise SystemExit(f"LoRA dataset is missing proof metadata: {dataset_path}")
    bypass = proofs.get("bypass") if isinstance(proofs.get("bypass"), dict) else {}
    bypass_flags = {
        "transcriptValidationSkipped": bypass.get("transcriptValidationSkipped") is True,
        "qualityGateSkipped": bypass.get("qualityGateSkipped") is True,
        "unsafeExport": bypass.get("unsafeExport") is True,
    }
    dataset_bypass_reason = str(bypass.get("reason") or "").strip()
    accepted_reason = unsafe_dataset_reason.strip()
    if any(bypass_flags.values()):
        if not allow_unsafe_dataset or not accepted_reason:
            raise SystemExit(
                "LoRA dataset was exported with unsafe proof bypasses; pass "
                "--allow-unsafe-dataset and --unsafe-dataset-reason to prepare a migration/debug training handoff."
            )
        return {
            **bypass_flags,
            "acceptedUnsafeDataset": True,
            "acceptedUnsafeDatasetReason": accepted_reason,
            "datasetBypassReason": dataset_bypass_reason or None,
            "transcriptValidationJson": proofs.get("transcriptValidationJson"),
            "qualityGateJson": proofs.get("qualityGateJson"),
        }

    profile_path = dataset_profile_path(dataset, dataset_path)
    transcript_validation_json = resolve_optional_proof_path(
        proofs.get("transcriptValidationJson"),
        dataset_path,
        "transcriptValidationJson",
    )
    quality_gate_json = resolve_optional_proof_path(
        proofs.get("qualityGateJson"),
        dataset_path,
        "qualityGateJson",
    )
    transcript_row_proof = validate_transcript_validation_proof(transcript_validation_json, profile_path, all_rows)
    validate_quality_gate_proof(quality_gate_json, profile_path)
    return {
        **bypass_flags,
        "acceptedUnsafeDataset": False,
        "acceptedUnsafeDatasetReason": None,
        "datasetBypassReason": None,
        "transcriptValidationJson": str(transcript_validation_json),
        "transcriptValidationRows": transcript_row_proof,
        "qualityGateJson": str(quality_gate_json),
        "productProofQualityGateRequired": True,
    }


def validate_dataset(
    *,
    dataset_path: Path,
    min_clips: int,
    min_total_duration_sec: float,
    require_val: bool,
) -> dict[str, Any]:
    dataset = load_json(dataset_path, "LoRA dataset")
    train_manifest = manifest_path(dataset, dataset_path, "train")
    val_manifest = manifest_path(dataset, dataset_path, "val")
    all_manifest = manifest_path(dataset, dataset_path, "all")

    train_rows = load_jsonl(train_manifest, "train manifest")
    val_rows = load_jsonl(val_manifest, "validation manifest") if val_manifest.exists() else []
    all_rows = load_jsonl(all_manifest, "all manifest")
    if require_val and not val_rows:
        raise SystemExit(f"validation manifest has no rows: {val_manifest}")

    train_duration = validate_rows(rows=train_rows, label="train manifest", manifest_dir=train_manifest.parent)
    val_duration = (
        validate_rows(rows=val_rows, label="validation manifest", manifest_dir=val_manifest.parent) if val_rows else 0.0
    )
    all_duration = validate_rows(rows=all_rows, label="all manifest", manifest_dir=all_manifest.parent)

    if len(all_rows) < min_clips:
        raise SystemExit(f"LoRA dataset has too few clips: {len(all_rows)} < {min_clips}")
    if all_duration < min_total_duration_sec:
        raise SystemExit(
            f"LoRA dataset duration is too short: {all_duration:.3f}s < {min_total_duration_sec:.3f}s"
        )

    return {
        "dataset": dataset,
        "trainManifest": train_manifest,
        "valManifest": val_manifest,
        "allManifest": all_manifest,
        "trainRows": train_rows,
        "valRows": val_rows,
        "allRows": all_rows,
        "trainDurationSec": train_duration,
        "valDurationSec": val_duration,
        "totalDurationSec": all_duration,
    }


def default_out_dir(dataset: dict[str, Any]) -> Path:
    profile_id = str(dataset.get("voiceProfileId") or "local-default")
    return DEFAULT_OUT_ROOT / f"{profile_id}-{utc_stamp()}"


def next_commands(*, adapter_path: Path, profile_path: str | None, config_path: Path) -> dict[str, str]:
    profile_arg = profile_path or ".anyvoice/voices/local-default/profile.json"
    return {
        "train": shell_join(["bash", str(config_path.parent / "train.sh")]),
        "verifyAdapter": shell_join(
            [
                "python3",
                "scripts/verify_voxcpm_lora_adapter.py",
                "--train-config",
                str(config_path),
                "--adapter-path",
                str(adapter_path),
                "--require-readable-checkpoint",
            ]
        ),
        "useAdapter": (
            f"ANYVOICE_VOXCPM_LORA_PATH={shlex.quote(str(adapter_path))} "
            "ANYVOICE_ENABLE_LOCAL_VOXCPM=1 ANYVOICE_STUB=0 npm run dev"
        ),
        "qualityGateDryRun": shell_join(
            [
                "python3",
                "scripts/run_voice_quality_gate.py",
                "--profile-json",
                profile_arg,
                "--quality",
                "balanced",
                "--clone-mode",
                "hifi",
                "--dry-run",
            ]
        ),
        "profileVerify": shell_join(
            [
                "python3",
                "scripts/verify_voice_profile_ready.py",
                "--profile-json",
                profile_arg,
                "--require-transcript-validation",
            ]
        ),
    }


def train_script_text(*, config_path: Path, adapter_path: Path, trainer_command: str | None) -> str:
    embedded_command = shlex.quote(trainer_command or "")
    verify_script = shlex.quote(str(REPO_ROOT / "scripts" / "verify_voxcpm_lora_adapter.py"))
    return f"""#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${{1:-$PWD/{config_path.name}}}"
OUTPUT_DIR="$PWD/output"
ADAPTER_PATH="$OUTPUT_DIR/{adapter_path.name}"
DEFAULT_TRAINER_COMMAND={embedded_command}
TRAINER_COMMAND="${{ANYVOICE_VOXCPM_TRAINER_COMMAND:-$DEFAULT_TRAINER_COMMAND}}"

if [[ -z "$TRAINER_COMMAND" ]]; then
  cat >&2 <<'MSG'
No VoxCPM LoRA trainer command is configured.

This job is a validated handoff: manifests, LoRA hyperparameters, expected
adapter path, and post-train AnyVoice commands are in train_config.json.

Set ANYVOICE_VOXCPM_TRAINER_COMMAND or regenerate with --trainer-command.
Supported placeholders: {{config}}, {{output_dir}}, {{adapter_path}},
{{train_manifest}}, {{val_manifest}}.
MSG
  exit 2
fi

mkdir -p "$OUTPUT_DIR"
TRAINER_COMMAND=$(python3 - "$TRAINER_COMMAND" "$CONFIG" "$OUTPUT_DIR" "$ADAPTER_PATH" <<'PY'
import json
import shlex
import sys
from pathlib import Path

template, config, output_dir, adapter_path = sys.argv[1:5]
payload = json.loads(Path(config).read_text(encoding="utf-8"))
manifests = payload.get("manifests", {{}})
values = {{
    "config": config,
    "output_dir": output_dir,
    "adapter_path": adapter_path,
    "train_manifest": str(manifests.get("train", "")),
    "val_manifest": str(manifests.get("val", "")),
}}
command = template
for key, value in values.items():
    command = command.replace("{{" + key + "}}", shlex.quote(value))
print(command)
PY
)
echo "$TRAINER_COMMAND"
eval "$TRAINER_COMMAND"

if [[ ! -f "$ADAPTER_PATH" ]]; then
  echo "trainer finished but expected LoRA weights were not written: $ADAPTER_PATH" >&2
  exit 3
fi

python3 {verify_script} --train-config "$CONFIG" --adapter-path "$ADAPTER_PATH" --out "$OUTPUT_DIR/adapter-proof.json"
"""


def readme_text(*, config: dict[str, Any]) -> str:
    next_cmds = config["nextCommands"]
    trainer_status = config["trainer"]["status"]
    return f"""# VoxCPM LoRA Training Job

Status: `{trainer_status}`

This directory was generated from a gated AnyVoice LoRA dataset. It does not
prove a digital clone by itself; it keeps the trainer handoff, adapter path, and
post-training verification commands reproducible.

## Files

- `train_config.json`: dataset, LoRA hyperparameters, package expectations, and next commands.
- `train.sh`: wrapper for an external VoxCPM LoRA trainer command.
- `output/lora_weights.ckpt`: expected adapter output path.

## Train

If you have a trainer command:

```bash
ANYVOICE_VOXCPM_TRAINER_COMMAND='python /path/to/train_voxcpm_lora.py --config {{config}} --output-dir {{output_dir}}' ./train.sh
```

Without a configured trainer, `./train.sh` exits before doing training.

## Use The Adapter

```bash
{next_cmds["useAdapter"]}
```

## Verify

```bash
{next_cmds["verifyAdapter"]}
{next_cmds["profileVerify"]}
{next_cmds["qualityGateDryRun"]}
```
"""


def build_config(
    *,
    dataset_path: Path,
    validation: dict[str, Any],
    proof_validation: dict[str, Any],
    out_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    dataset = validation["dataset"]
    adapter_path = out_dir / "output" / "lora_weights.ckpt"
    config_path = out_dir / "train_config.json"
    profile_path = dataset.get("profilePath") if isinstance(dataset.get("profilePath"), str) else None
    trainer_status = "ready" if args.trainer_command else "needs_trainer_command"
    return {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "datasetJson": str(dataset_path),
        "voiceProfileId": dataset.get("voiceProfileId"),
        "profilePath": profile_path,
        "dataset": {
            "totalClips": len(validation["allRows"]),
            "trainClips": len(validation["trainRows"]),
            "valClips": len(validation["valRows"]),
            "trainDurationSec": round(float(validation["trainDurationSec"]), 3),
            "valDurationSec": round(float(validation["valDurationSec"]), 3),
            "totalDurationSec": round(float(validation["totalDurationSec"]), 3),
            "minClips": args.min_clips,
            "minTotalDurationSec": args.min_total_duration_sec,
        },
        "datasetProofs": proof_validation,
        "manifests": {
            "train": str(validation["trainManifest"]),
            "val": str(validation["valManifest"]),
            "all": str(validation["allManifest"]),
            "textColumn": "text",
            "audioColumn": "audio",
            "datasetIdColumn": "dataset_id",
        },
        "voxcpmPackage": {
            "requiredRuntime": "voxcpm>=2.0.2",
            "knownEntryPoint": "voxcpm",
            "trainingUtilities": [
                "voxcpm.training.load_audio_text_datasets",
                "voxcpm.training.HFVoxCPMDataset",
                "voxcpm.training.BatchProcessor",
            ],
            "trainerCli": None,
            "note": "The installed package exposes LoRA load/runtime support and training utilities, but no packaged train CLI.",
        },
        "lora": {
            "rank": args.lora_r,
            "alpha": args.lora_alpha,
            "dropout": args.lora_dropout,
            "enableLm": not args.lora_disable_lm,
            "enableDit": not args.lora_disable_dit,
            "enableProj": args.lora_enable_proj,
            "expectedWeights": str(adapter_path),
            "adapterProof": str(out_dir / "output" / "adapter-proof.json"),
            "runtimeEnv": f"ANYVOICE_VOXCPM_LORA_PATH={adapter_path}",
        },
        "trainer": {
            "status": trainer_status,
            "commandTemplate": args.trainer_command,
            "epochs": args.epochs,
            "learningRate": args.learning_rate,
            "batchSize": args.batch_size,
            "gradientAccumulationSteps": args.gradient_accumulation_steps,
            "seed": args.seed,
            "outputDir": str(out_dir / "output"),
            "trainScript": str(out_dir / "train.sh"),
        },
        "nextCommands": next_commands(adapter_path=adapter_path, profile_path=profile_path, config_path=config_path),
        "notes": [
            "Do not train on generated profile outputs; this job expects consented enrollment clips exported by prepare_voice_lora_dataset.py.",
            "Keep transcript text exactly as recorded. Pronunciation overrides belong in evaluation prompts, not training transcripts.",
            "After training, compare LoRA output against zero-shot profile mode before making it the default.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a validated VoxCPM LoRA training job handoff from an AnyVoice LoRA dataset.")
    parser.add_argument("--dataset-json", required=True, help="Path to dataset.json produced by prepare_voice_lora_dataset.py.")
    parser.add_argument("--out-dir", help="Output directory. Defaults to generated/voice-lora-training-jobs/<profile-id>-<timestamp>.")
    parser.add_argument("--trainer-command", help="Optional trainer command template for train.sh. Supports {config}, {output_dir}, {adapter_path}, {train_manifest}, {val_manifest}.")
    parser.add_argument("--min-clips", type=int, default=DEFAULT_LORA_MIN_CLIPS)
    parser.add_argument("--min-total-duration-sec", type=float, default=DEFAULT_LORA_MIN_TOTAL_DURATION_SEC)
    parser.add_argument("--allow-empty-val", action="store_true")
    parser.add_argument("--allow-unsafe-dataset", action="store_true", help="Allow a dataset that was exported with proof bypasses. Requires --unsafe-dataset-reason.")
    parser.add_argument("--unsafe-dataset-reason", default="", help="Required reason when preparing a training job from an unsafe-bypassed dataset.")
    parser.add_argument("--lora-r", type=int, default=32)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.0)
    parser.add_argument("--lora-disable-lm", action="store_true")
    parser.add_argument("--lora-disable-dit", action="store_true")
    parser.add_argument("--lora-enable-proj", action="store_true")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()

    if args.lora_r <= 0:
        raise SystemExit("--lora-r must be positive")
    if args.lora_alpha <= 0:
        raise SystemExit("--lora-alpha must be positive")
    if not 0.0 <= args.lora_dropout <= 1.0:
        raise SystemExit("--lora-dropout must be between 0.0 and 1.0")

    dataset_path = Path(args.dataset_json).expanduser().resolve()
    validation = validate_dataset(
        dataset_path=dataset_path,
        min_clips=args.min_clips,
        min_total_duration_sec=args.min_total_duration_sec,
        require_val=not args.allow_empty_val,
    )
    proof_validation = validate_dataset_proofs(
        dataset=validation["dataset"],
        dataset_path=dataset_path,
        all_rows=validation["allRows"],
        allow_unsafe_dataset=args.allow_unsafe_dataset,
        unsafe_dataset_reason=args.unsafe_dataset_reason,
    )
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else default_out_dir(validation["dataset"]).resolve()
    config = build_config(
        dataset_path=dataset_path,
        validation=validation,
        proof_validation=proof_validation,
        out_dir=out_dir,
        args=args,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    config_path = out_dir / "train_config.json"
    adapter_path = out_dir / "output" / "lora_weights.ckpt"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "README.md").write_text(readme_text(config=config), encoding="utf-8")
    train_script = out_dir / "train.sh"
    train_script.write_text(
        train_script_text(config_path=config_path, adapter_path=adapter_path, trainer_command=args.trainer_command),
        encoding="utf-8",
    )
    os.chmod(train_script, 0o755)

    print(
        json.dumps(
            {
                "status": "written",
                "job": str(config_path),
                "trainScript": str(train_script),
                "trainerStatus": config["trainer"]["status"],
                "expectedWeights": str(adapter_path),
                "nextCommands": config["nextCommands"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent


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


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def resolve_path(raw_path: str, base_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def resolve_optional_path(raw_path: Any, base_dir: Path) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False)


def same_resolved_path(raw_path: Any, expected: Path, base_dir: Path) -> bool:
    path = resolve_optional_path(raw_path, base_dir)
    return path is not None and path == expected.resolve(strict=False)


def resolve_adapter_path(raw_path: str, base_dir: Path) -> Path:
    path = resolve_path(raw_path, base_dir)
    if path.is_dir():
        path = path / "lora_weights.ckpt"
    return path.resolve()


def require_dict(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise SystemExit(f"{label} is missing object field: {key}")
    return value


def validate_train_config_manifest_binding(config: dict[str, Any], config_path: Path) -> None:
    dataset_json = config.get("datasetJson")
    if not isinstance(dataset_json, str) or not dataset_json.strip():
        raise SystemExit(f"LoRA train config is missing datasetJson: {config_path}")
    dataset_path = resolve_path(dataset_json, config_path.parent)
    dataset = load_json(dataset_path, "LoRA dataset")
    config_manifests = require_dict(config, "manifests", "LoRA train config")
    dataset_manifests = require_dict(dataset, "manifests", "LoRA dataset")
    errors: list[str] = []
    for key in ("train", "val", "all"):
        expected_raw = dataset_manifests.get(key)
        actual_raw = config_manifests.get(key)
        if not isinstance(expected_raw, str) or not expected_raw.strip():
            errors.append(f"dataset.manifests.{key}_missing")
            continue
        expected_path = resolve_path(expected_raw, dataset_path.parent)
        if not same_resolved_path(actual_raw, expected_path, config_path.parent):
            errors.append(f"manifests.{key}_mismatch")
            continue
        if not expected_path.exists():
            errors.append(f"manifests.{key}_missing_file")
    if errors:
        raise SystemExit(
            "LoRA train config manifest paths do not match dataset.json: "
            + ", ".join(errors)
            + f" ({config_path})"
        )


def profile_evidence_errors(
    label: str,
    value: Any,
    *,
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> list[str]:
    evidence = value if isinstance(value, dict) else {}
    errors: list[str] = []
    if voice_profile_id and evidence.get("voiceProfileId") != voice_profile_id:
        errors.append(f"{label}.voiceProfileId")
    if profile_sha256 and evidence.get("profileSha256") != profile_sha256:
        errors.append(f"{label}.profileSha256")
    return errors


def group_profile_evidence_errors(
    root_label: str,
    groups: Any,
    *,
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> tuple[list[str], int]:
    if not isinstance(groups, list):
        return [f"{root_label}.groups"], 0

    errors: list[str] = []
    matched_renders = 0
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        group_label = f"{root_label}.groups[{group_index}]"
        errors.extend(
            profile_evidence_errors(
                group_label,
                group,
                voice_profile_id=voice_profile_id,
                profile_sha256=profile_sha256,
            )
        )
        renders = group.get("renders")
        if not isinstance(renders, list):
            continue
        for render_index, render in enumerate(renders):
            if not isinstance(render, dict):
                continue
            matched_renders += 1
            errors.extend(
                profile_evidence_errors(
                    f"{group_label}.renders[{render_index}]",
                    render,
                    voice_profile_id=voice_profile_id,
                    profile_sha256=profile_sha256,
                )
            )
    return errors, matched_renders


def validate_report_score_profile_evidence(
    *,
    report: dict[str, Any],
    score: dict[str, Any],
    voice_profile_id: str | None,
    profile_sha256: str | None,
    label: str,
) -> None:
    errors: list[str] = []
    errors.extend(
        profile_evidence_errors(
            "score.voiceProfile",
            score.get("voiceProfile"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
    )
    score_errors, score_render_count = group_profile_evidence_errors(
        "score",
        score.get("groups"),
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
    )
    errors.extend(score_errors)
    if score_render_count <= 0:
        errors.append("score.profile_render_evidence")

    errors.extend(
        profile_evidence_errors(
            "sourceReport.voiceProfile",
            report.get("voiceProfile"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
    )
    report_errors, report_render_count = group_profile_evidence_errors(
        "sourceReport",
        report.get("groups"),
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
    )
    errors.extend(report_errors)
    if report_render_count <= 0:
        errors.append("sourceReport.profile_render_evidence")

    if errors:
        raise SystemExit(f"{label} profile evidence does not match the current profile: {', '.join(errors)}")


def validate_quality_gate_artifact_proof(
    *,
    payload: dict[str, Any],
    proof_path: Path,
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> None:
    proofs = payload.get("proofs") if isinstance(payload.get("proofs"), dict) else {}
    paths = payload.get("paths") if isinstance(payload.get("paths"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    resolved: dict[str, tuple[Path, str]] = {}

    for key in ("report", "asr", "speaker", "score"):
        path = resolve_optional_path(paths.get(key), proof_path.parent)
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else None
        if path is None:
            raise SystemExit(f"quality gate proof is missing {key} artifact path ({proof_path})")
        if artifact is None:
            raise SystemExit(f"quality gate proof is missing {key} artifact metadata ({proof_path})")
        artifact_path = resolve_optional_path(artifact.get("path"), proof_path.parent)
        if artifact_path is None or artifact_path != path:
            raise SystemExit(f"quality gate proof {key} artifact path does not match paths.{key} ({proof_path})")
        proof_sha256 = artifact.get("sha256")
        if not isinstance(proof_sha256, str) or not proof_sha256.strip():
            raise SystemExit(f"quality gate proof is missing {key} artifact SHA-256 ({proof_path})")
        try:
            actual_sha256 = sha256_file(path)
        except OSError as exc:
            raise SystemExit(f"quality gate proof {key} artifact is missing or unreadable: {path}") from exc
        if actual_sha256 != proof_sha256:
            raise SystemExit(
                f"quality gate proof {key} artifact SHA-256 no longer matches the file: "
                f"{path} ({proof_path})"
            )
        resolved[key] = (path, actual_sha256)

    score_path, _score_sha256 = resolved["score"]
    score = load_json(score_path, "quality gate score JSON")
    if score.get("verdict") != "pass":
        raise SystemExit(f"quality gate score JSON verdict is {score.get('verdict')!r}; expected 'pass' ({score_path})")
    report_path, report_sha256 = resolved["report"]
    report = load_json(report_path, "quality gate source report JSON")
    asr_path, asr_sha256 = resolved["asr"]
    speaker_path, speaker_sha256 = resolved["speaker"]
    if not same_resolved_path(score.get("sourceReport"), report_path, score_path.parent):
        raise SystemExit(f"quality gate score JSON sourceReport does not match paths.report ({score_path})")
    if score.get("sourceReportSha256") != report_sha256:
        raise SystemExit(f"quality gate score JSON sourceReportSha256 no longer matches paths.report ({score_path})")
    if not same_resolved_path(score.get("asrJson"), asr_path, score_path.parent):
        raise SystemExit(f"quality gate score JSON asrJson does not match paths.asr ({score_path})")
    if score.get("asrJsonSha256") != asr_sha256:
        raise SystemExit(f"quality gate score JSON asrJsonSha256 no longer matches paths.asr ({score_path})")
    if not same_resolved_path(score.get("speakerJson"), speaker_path, score_path.parent):
        raise SystemExit(f"quality gate score JSON speakerJson does not match paths.speaker ({score_path})")
    if score.get("speakerJsonSha256") != speaker_sha256:
        raise SystemExit(f"quality gate score JSON speakerJsonSha256 no longer matches paths.speaker ({score_path})")
    validate_report_score_profile_evidence(
        report=report,
        score=score,
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
        label="quality gate score/report",
    )


def validate_quality_gate_reference(
    proofs: dict[str, Any],
    *,
    base_dir: Path,
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> None:
    raw_path = proofs.get("qualityGateJson")
    proof_path = resolve_optional_path(raw_path, base_dir)
    if proof_path is None:
        raise SystemExit("LoRA train config dataset proof is missing qualityGateJson")
    proof_sha256 = proofs.get("qualityGateSha256")
    if not isinstance(proof_sha256, str) or not proof_sha256.strip():
        raise SystemExit("LoRA train config dataset proof is missing qualityGateSha256")
    try:
        actual_sha256 = sha256_file(proof_path)
    except OSError as exc:
        raise SystemExit(f"LoRA train config dataset quality gate file is missing or unreadable: {proof_path}") from exc
    if actual_sha256 != proof_sha256:
        raise SystemExit(
            "LoRA train config dataset qualityGateSha256 no longer matches the referenced file: "
            f"{proof_path}"
        )
    payload = load_json(proof_path, "LoRA train config dataset quality gate proof")
    validate_quality_gate_artifact_proof(
        payload=payload,
        proof_path=proof_path,
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
    )


def validate_dataset_proof_contract(
    proofs: dict[str, Any],
    *,
    allow_unsafe_dataset: bool,
    profile_path: Path | None,
    train_config_voice_profile_id: Any,
    base_dir: Path,
) -> None:
    unsafe_flags = {
        "acceptedUnsafeDataset": proofs.get("acceptedUnsafeDataset") is True,
        "transcriptValidationSkipped": proofs.get("transcriptValidationSkipped") is True,
        "qualityGateSkipped": proofs.get("qualityGateSkipped") is True,
        "unsafeExport": proofs.get("unsafeExport") is True,
    }
    if any(unsafe_flags.values()):
        if not allow_unsafe_dataset:
            raise SystemExit("adapter comes from an unsafe-bypassed dataset; pass --allow-unsafe-dataset to acknowledge it")
        return
    if proofs.get("productProofQualityGateRequired") is not True:
        raise SystemExit(
            "LoRA train config did not preserve paired product-proof dataset evidence: "
            "datasetProofs.productProofQualityGateRequired must be true"
        )
    if profile_path is None:
        raise SystemExit("LoRA train config is missing profilePath; cannot verify dataset profile SHA-256")
    profile = load_json(profile_path, "voice profile")
    expected_profile_sha256 = canonical_profile_sha256(profile)
    if proofs.get("profileSha256") != expected_profile_sha256:
        raise SystemExit(
            "LoRA train config dataset profile SHA-256 does not match the current voice profile: "
            f"datasetProofs.profileSha256={proofs.get('profileSha256')!r}, expected {expected_profile_sha256}"
        )
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip() or None
    if voice_profile_id and train_config_voice_profile_id != voice_profile_id:
        raise SystemExit(
            "LoRA train config voiceProfileId does not match profilePath: "
            f"voiceProfileId={train_config_voice_profile_id!r}, expected {voice_profile_id}"
        )
    validate_quality_gate_reference(
        proofs,
        base_dir=base_dir,
        voice_profile_id=voice_profile_id,
        profile_sha256=expected_profile_sha256,
    )


def inspect_checkpoint(path: Path, *, require_readable: bool) -> dict[str, Any]:
    suffix = path.suffix.lower()
    loader = "torch"
    try:
        if suffix == ".safetensors":
            from safetensors.torch import load_file  # type: ignore

            state = load_file(str(path), device="cpu")
            loader = "safetensors"
        else:
            import torch  # type: ignore

            state = torch.load(str(path), map_location="cpu")
    except ModuleNotFoundError as exc:
        if require_readable:
            raise SystemExit(f"checkpoint inspection dependency is missing: {exc.name}") from exc
        return {
            "status": "unavailable",
            "loader": loader,
            "reason": f"missing_dependency:{exc.name}",
            "loraParameterKeys": None,
        }
    except Exception as exc:
        if require_readable:
            raise SystemExit(f"checkpoint could not be read: {path}: {exc}") from exc
        return {
            "status": "unreadable",
            "loader": loader,
            "reason": str(exc),
            "loraParameterKeys": None,
        }

    if isinstance(state, dict):
        candidates = state.get("state_dict") if isinstance(state.get("state_dict"), dict) else state
        keys = [str(key) for key in candidates.keys()] if isinstance(candidates, dict) else []
    else:
        keys = []
    lora_keys = sorted(key for key in keys if "lora_A" in key or "lora_B" in key)
    if not lora_keys:
        raise SystemExit(f"checkpoint is readable but contains no LoRA parameter keys: {path}")
    return {
        "status": "readable",
        "loader": loader,
        "parameterKeyCount": len(keys),
        "loraParameterKeyCount": len(lora_keys),
        "loraParameterKeys": lora_keys[:20],
    }


def unsafe_dataset_proof_flags(proofs: dict[str, Any]) -> dict[str, bool]:
    return {
        "acceptedUnsafeDataset": proofs.get("acceptedUnsafeDataset") is True,
        "transcriptValidationSkipped": proofs.get("transcriptValidationSkipped") is True,
        "qualityGateSkipped": proofs.get("qualityGateSkipped") is True,
        "unsafeExport": proofs.get("unsafeExport") is True,
    }


def transcript_validation_path_for_command(proofs: dict[str, Any], base_dir: Path) -> Path | None:
    if any(unsafe_dataset_proof_flags(proofs).values()):
        return None
    raw_path = proofs.get("transcriptValidationJson")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    return resolve_path(raw_path, base_dir)


def next_commands(*, adapter_path: Path, profile_path: str | None, transcript_validation_json: Path | None) -> dict[str, str]:
    profile_arg = profile_path or ".anyvoice/voices/local-default/profile.json"
    env_prefix = f"ANYVOICE_VOXCPM_LORA_PATH={shlex.quote(str(adapter_path))}"
    quality_gate = [
        "python3",
        "scripts/run_voice_quality_gate.py",
        "--profile-json",
        profile_arg,
        "--quality",
        "balanced",
        "--clone-mode",
        "hifi",
        "--require-speaker-backend",
        "speechbrain-ecapa",
        "--repeats",
        "3",
    ]
    if transcript_validation_json:
        quality_gate.extend(["--transcript-validation-json", str(transcript_validation_json)])
    return {
        "useAdapter": f"{env_prefix} ANYVOICE_ENABLE_LOCAL_VOXCPM=1 ANYVOICE_STUB=0 npm run dev",
        "qualityGateWithAdapterDryRun": f"{env_prefix} {shell_join([*quality_gate, '--dry-run'])}",
        "qualityGateWithAdapter": f"{env_prefix} {shell_join(quality_gate)}",
    }


def verify(
    *,
    config_path: Path,
    adapter_path: Path | None,
    min_bytes: int,
    require_readable_checkpoint: bool,
    allow_unsafe_dataset: bool,
) -> dict[str, Any]:
    config = load_json(config_path, "LoRA train config")
    lora = require_dict(config, "lora", "LoRA train config")
    dataset = require_dict(config, "dataset", "LoRA train config")
    proofs = require_dict(config, "datasetProofs", "LoRA train config")
    validate_train_config_manifest_binding(config, config_path)
    expected_raw = lora.get("expectedWeights")
    if not isinstance(expected_raw, str) or not expected_raw.strip():
        raise SystemExit(f"LoRA train config is missing lora.expectedWeights: {config_path}")
    expected_path = resolve_adapter_path(expected_raw, config_path.parent)
    actual_path = resolve_adapter_path(str(adapter_path), config_path.parent) if adapter_path else expected_path
    if actual_path != expected_path:
        raise SystemExit(f"adapter path does not match train config: {actual_path} != {expected_path}")
    profile_path = config.get("profilePath") if isinstance(config.get("profilePath"), str) else None
    profile_file = resolve_path(profile_path, config_path.parent) if profile_path else None
    validate_dataset_proof_contract(
        proofs,
        allow_unsafe_dataset=allow_unsafe_dataset,
        profile_path=profile_file,
        train_config_voice_profile_id=config.get("voiceProfileId"),
        base_dir=config_path.parent,
    )
    if not actual_path.exists() or not actual_path.is_file():
        raise SystemExit(f"LoRA adapter file is missing: {actual_path}")
    size = actual_path.stat().st_size
    if size < min_bytes:
        raise SystemExit(f"LoRA adapter file is too small: {size} < {min_bytes} bytes")
    total_clips = dataset.get("totalClips")
    total_duration = dataset.get("totalDurationSec")
    min_clips = dataset.get("minClips")
    min_duration = dataset.get("minTotalDurationSec")
    if not isinstance(total_clips, int) or not isinstance(min_clips, int) or total_clips < min_clips:
        raise SystemExit("LoRA train config dataset clip count is below its minimum")
    if (
        not isinstance(total_duration, (int, float))
        or not isinstance(min_duration, (int, float))
        or float(total_duration) < float(min_duration)
    ):
        raise SystemExit("LoRA train config dataset duration is below its minimum")

    checkpoint = inspect_checkpoint(actual_path, require_readable=require_readable_checkpoint)
    transcript_validation_json = transcript_validation_path_for_command(proofs, config_path.parent)
    status = "pass" if checkpoint.get("status") == "readable" else "metadata_pass"
    return {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "adapter": {
            "path": str(actual_path),
            "bytes": size,
            "sha256": sha256_file(actual_path),
        },
        "trainConfig": str(config_path),
        "trainConfigSha256": sha256_file(config_path),
        "voiceProfileId": config.get("voiceProfileId"),
        "profilePath": profile_path,
        "dataset": dataset,
        "datasetProofs": proofs,
        "lora": {
            "rank": lora.get("rank"),
            "alpha": lora.get("alpha"),
            "dropout": lora.get("dropout"),
            "enableLm": lora.get("enableLm"),
            "enableDit": lora.get("enableDit"),
            "enableProj": lora.get("enableProj"),
        },
        "checkpoint": checkpoint,
        "nextCommands": next_commands(
            adapter_path=actual_path,
            profile_path=profile_path,
            transcript_validation_json=transcript_validation_json,
        ),
        "warnings": []
        if checkpoint.get("status") == "readable"
        else [
            "Adapter file metadata passed, but checkpoint tensor keys were not inspected in this Python environment.",
            "Run again with the VoxCPM/Torch environment and --require-readable-checkpoint before treating this as final proof.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a trained VoxCPM LoRA adapter against an AnyVoice training job config.")
    parser.add_argument("--train-config", required=True, help="Path to train_config.json from prepare_voxcpm_lora_training_job.py.")
    parser.add_argument("--adapter-path", help="Adapter file or directory. Defaults to lora.expectedWeights from train_config.json.")
    parser.add_argument("--out", help="Optional JSON proof output path. Defaults to <adapter-dir>/adapter-proof.json.")
    parser.add_argument("--min-bytes", type=int, default=1)
    parser.add_argument("--require-readable-checkpoint", action="store_true", help="Require torch/safetensors checkpoint inspection and LoRA parameter keys.")
    parser.add_argument("--allow-unsafe-dataset", action="store_true", help="Acknowledge that the training job came from an unsafe-bypassed dataset.")
    args = parser.parse_args()
    if args.min_bytes <= 0:
        raise SystemExit("--min-bytes must be positive")

    config_path = Path(args.train_config).expanduser().resolve()
    adapter_path = Path(args.adapter_path).expanduser().resolve() if args.adapter_path else None
    payload = verify(
        config_path=config_path,
        adapter_path=adapter_path,
        min_bytes=args.min_bytes,
        require_readable_checkpoint=args.require_readable_checkpoint,
        allow_unsafe_dataset=args.allow_unsafe_dataset,
    )
    out_path = Path(args.out).expanduser().resolve() if args.out else Path(payload["adapter"]["path"]).with_name("adapter-proof.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    payload["proofJson"] = str(out_path)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from voice_profile_next_step import transcript_validation_rows_match_profile


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
PRODUCT_SPEAKER_BACKEND = "speechbrain-ecapa"


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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def same_path(raw_path: Any, expected: Path, base_dir: Path | None = None) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path.resolve(strict=False) == expected.resolve(strict=False)


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value.lower())


def resolve_render_output_path(render: dict[str, Any], report_path: Path) -> Path | None:
    raw_path = render.get("outputWav")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = report_path.parent / path
    return path.resolve(strict=False)


def resolve_quality_gate_proof_path(raw_path: Any, quality_gate_path: Path) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = quality_gate_path.parent / path
    return path.resolve(strict=False)


def quality_gate_transcript_validation_paths(
    *,
    inputs: dict[str, Any],
    proofs: dict[str, Any],
    paths: dict[str, Any],
    quality_gate_path: Path,
) -> list[Path]:
    resolved: list[Path] = []
    for raw_path in (
        proofs.get("transcriptValidationJson"),
        inputs.get("transcriptValidationJson"),
        paths.get("profileTranscriptValidation"),
    ):
        path = resolve_quality_gate_proof_path(raw_path, quality_gate_path)
        if path is not None:
            resolved.append(path)
    return resolved


def quality_gate_transcript_validation_sha256s(*, inputs: dict[str, Any], proofs: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for raw_value in (
        proofs.get("transcriptValidationSha256"),
        inputs.get("transcriptValidationSha256"),
    ):
        if isinstance(raw_value, str) and raw_value.strip():
            values.append(raw_value.strip())
    return values


def adapter_path_from_proof(proof: dict[str, Any], proof_path: Path) -> Path:
    adapter = proof.get("adapter") if isinstance(proof.get("adapter"), dict) else {}
    raw_path = adapter.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"adapter proof does not name adapter.path: {proof_path}")
    adapter_path = Path(raw_path).expanduser()
    if not adapter_path.is_absolute():
        adapter_path = proof_path.parent / adapter_path
    return adapter_path.resolve(strict=False)


def train_config_path_from_proof(proof: dict[str, Any], proof_path: Path) -> Path:
    raw_path = proof.get("trainConfig")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise SystemExit(f"adapter proof is missing trainConfig evidence: {proof_path}")
    train_config_path = Path(raw_path).expanduser()
    if not train_config_path.is_absolute():
        train_config_path = proof_path.parent / train_config_path
    train_config_path = train_config_path.resolve(strict=False)
    if not train_config_path.is_file():
        raise SystemExit(f"adapter proof trainConfig file is missing: {train_config_path}")
    return train_config_path


def resolve_config_path(raw_path: Any, base_dir: Path) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False)


def require_dict(payload: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise SystemExit(f"{label} is missing object field: {key}")
    return value


def validate_train_config_manifest_binding(train_config_path: Path) -> None:
    config = load_json(train_config_path, "LoRA train config")
    dataset_path = resolve_config_path(config.get("datasetJson"), train_config_path.parent)
    if dataset_path is None:
        raise SystemExit(f"LoRA train config is missing datasetJson: {train_config_path}")
    dataset = load_json(dataset_path, "LoRA dataset")
    config_manifests = require_dict(config, "manifests", "LoRA train config")
    dataset_manifests = require_dict(dataset, "manifests", "LoRA dataset")
    errors: list[str] = []
    for key in ("train", "val", "all"):
        expected_path = resolve_config_path(dataset_manifests.get(key), dataset_path.parent)
        if expected_path is None:
            errors.append(f"dataset.manifests.{key}_missing")
            continue
        if not same_path(config_manifests.get(key), expected_path, train_config_path.parent):
            errors.append(f"manifests.{key}_mismatch")
            continue
        if not expected_path.exists():
            errors.append(f"manifests.{key}_missing_file")
    if errors:
        raise SystemExit(
            "LoRA train config manifest paths do not match dataset.json: "
            + ", ".join(errors)
            + f" ({train_config_path})"
        )


def validate_adapter_proof(
    *,
    proof_path: Path,
    proof: dict[str, Any],
    profile_path: Path,
    profile_sha256: str,
) -> tuple[Path, int, str, Path]:
    if proof.get("status") != "pass":
        raise SystemExit(f"adapter proof must have status=pass before applying: {proof_path}")
    checkpoint = proof.get("checkpoint") if isinstance(proof.get("checkpoint"), dict) else {}
    if checkpoint.get("status") != "readable":
        raise SystemExit(f"adapter proof must include readable checkpoint inspection evidence: {proof_path}")
    lora_key_count = checkpoint.get("loraParameterKeyCount")
    if not isinstance(lora_key_count, int) or lora_key_count <= 0:
        raise SystemExit(f"adapter proof must include positive LoRA parameter key evidence: {proof_path}")
    if not same_path(proof.get("profilePath"), profile_path, proof_path.parent):
        raise SystemExit(f"adapter proof does not match profile: {proof.get('profilePath')!r} != {profile_path}")
    dataset_proofs = proof.get("datasetProofs") if isinstance(proof.get("datasetProofs"), dict) else {}
    if dataset_proofs.get("productProofQualityGateRequired") is not True:
        raise SystemExit("adapter proof does not preserve paired product-proof dataset evidence")
    if dataset_proofs.get("profileSha256") != profile_sha256:
        raise SystemExit(
            "adapter proof dataset profile hash does not match this profile: "
            f"profileSha256={dataset_proofs.get('profileSha256')!r}, expected {profile_sha256}"
        )
    train_config_path = train_config_path_from_proof(proof, proof_path)
    expected_train_config_sha256 = proof.get("trainConfigSha256")
    actual_train_config_sha256 = sha256_file(train_config_path)
    if expected_train_config_sha256 != actual_train_config_sha256:
        raise SystemExit(
            "adapter proof trainConfigSha256 does not match trainConfig: "
            f"trainConfigSha256={expected_train_config_sha256!r}, expected {actual_train_config_sha256}"
        )
    validate_train_config_manifest_binding(train_config_path)
    adapter_path = adapter_path_from_proof(proof, proof_path)
    if not adapter_path.is_file():
        raise SystemExit(f"LoRA adapter file is missing: {adapter_path}")
    adapter = proof.get("adapter") if isinstance(proof.get("adapter"), dict) else {}
    expected_bytes = adapter.get("bytes")
    expected_sha = adapter.get("sha256")
    actual_bytes = adapter_path.stat().st_size
    actual_sha = sha256_file(adapter_path)
    if expected_bytes != actual_bytes:
        raise SystemExit(f"adapter byte count changed after proof: {expected_bytes} != {actual_bytes}")
    if expected_sha != actual_sha:
        raise SystemExit(f"adapter SHA-256 changed after proof: {expected_sha} != {actual_sha}")
    return adapter_path, actual_bytes, actual_sha, train_config_path


def validate_quality_gate_transcript_proof(
    *,
    quality_gate_path: Path,
    quality_gate: dict[str, Any],
    profile: dict[str, Any],
    profile_path: Path,
    profile_sha256: str,
) -> None:
    inputs = quality_gate.get("inputs") if isinstance(quality_gate.get("inputs"), dict) else {}
    proofs = quality_gate.get("proofs") if isinstance(quality_gate.get("proofs"), dict) else {}
    paths = quality_gate.get("paths") if isinstance(quality_gate.get("paths"), dict) else {}
    proof_paths = quality_gate_transcript_validation_paths(
        inputs=inputs,
        proofs=proofs,
        paths=paths,
        quality_gate_path=quality_gate_path,
    )
    if not proof_paths:
        raise SystemExit(f"LoRA quality gate is missing transcript validation proof path: {quality_gate_path}")
    transcript_validation_path = proof_paths[0]
    if any(path != transcript_validation_path for path in proof_paths[1:]):
        raise SystemExit(f"LoRA quality gate transcript validation proof paths disagree: {quality_gate_path}")
    proof_sha256s = quality_gate_transcript_validation_sha256s(inputs=inputs, proofs=proofs)
    if not proof_sha256s or any(value != proof_sha256s[0] for value in proof_sha256s[1:]):
        raise SystemExit(f"LoRA quality gate is missing or has inconsistent transcript validation SHA-256 proof: {quality_gate_path}")
    if sha256_file(transcript_validation_path) != proof_sha256s[0]:
        raise SystemExit(
            "LoRA quality gate transcript validation proof SHA-256 no longer matches the file: "
            f"{transcript_validation_path} ({quality_gate_path})"
        )
    transcript_validation = load_json(transcript_validation_path, "LoRA quality gate transcript validation JSON")
    if transcript_validation.get("status") != "pass":
        raise SystemExit(
            "LoRA quality gate transcript validation proof is not passing: "
            f"status={transcript_validation.get('status')!r} ({transcript_validation_path})"
        )
    if not same_path(transcript_validation.get("profile"), profile_path, transcript_validation_path.parent):
        raise SystemExit(
            "LoRA quality gate transcript validation proof does not match profile: "
            f"{transcript_validation.get('profile')!r} != {profile_path}"
        )
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip()
    if voice_profile_id and transcript_validation.get("voiceProfileId") != voice_profile_id:
        raise SystemExit(
            "LoRA quality gate transcript validation proof is bound to the wrong voice profile: "
            f"voiceProfileId={transcript_validation.get('voiceProfileId')!r}, expected {voice_profile_id}"
        )
    if transcript_validation.get("profileSha256") != profile_sha256:
        raise SystemExit(
            "LoRA quality gate transcript validation proof is stale for this profile: "
            f"profileSha256={transcript_validation.get('profileSha256')!r}, expected {profile_sha256}"
        )
    if not transcript_validation_rows_match_profile(profile_path, profile, transcript_validation_path, transcript_validation):
        raise SystemExit(
            "LoRA quality gate transcript validation proof rows do not match this profile: "
            f"{transcript_validation_path} ({quality_gate_path})"
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


def ready_render_output_evidence_errors(root_label: str, groups: Any, evidence_json_path: Path) -> list[str]:
    errors: list[str] = []
    if not isinstance(groups, list):
        return [f"{root_label}.groups"]
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or group_index)
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render_index, render in enumerate(renders):
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            repeat = render.get("repeat")
            render_label = (
                f"{root_label}/{case_id}#r{repeat}" if repeat is not None else f"{root_label}/{case_id}#{render_index}"
            )
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                errors.append(f"ready_render_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                errors.append(f"ready_render_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                errors.append(f"ready_render_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, evidence_json_path)
            if output_path is None:
                errors.append(f"ready_render_output_path_missing:{render_label}")
                continue
            try:
                actual_bytes = output_path.stat().st_size
                actual_sha256 = sha256_file(output_path)
            except OSError:
                errors.append(f"ready_render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                errors.append(f"ready_render_output_bytes_mismatch:{render_label}")
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                errors.append(f"ready_render_output_sha256_mismatch:{render_label}")
    return errors


def render_effective_params(render: dict[str, Any]) -> dict[str, Any] | None:
    candidates: list[Any] = [
        render.get("metadataJson"),
        render.get("hotWorkerMetadata"),
        render,
    ]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        effective = candidate.get("effectiveParams")
        if isinstance(effective, dict):
            return effective
    return None


def lora_render_evidence_errors(report: dict[str, Any], adapter_path: Path, report_path: Path) -> list[str]:
    errors: list[str] = []
    matched_renders = 0
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if str(group.get("cloneMode") or "") != "hifi":
            continue
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"hifi/{case_id}".strip("/") or "hifi"
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            matched_renders += 1
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            effective = render_effective_params(render)
            if effective is None:
                errors.append(f"source_report_render_lora_effective_params_missing:{render_label}")
                continue
            if effective.get("loraEnabled") is not True:
                errors.append(f"source_report_render_lora_enabled_missing:{render_label}")
            if not same_path(effective.get("loraPath"), adapter_path, report_path.parent):
                errors.append(f"source_report_render_lora_path_mismatch:{render_label}")
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                errors.append(f"source_report_render_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                errors.append(f"source_report_render_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                errors.append(f"source_report_render_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, report_path)
            if output_path is None:
                errors.append(f"source_report_render_output_path_missing:{render_label}")
                continue
            try:
                actual_bytes = output_path.stat().st_size
                actual_sha256 = sha256_file(output_path)
            except OSError:
                errors.append(f"source_report_render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                errors.append(f"source_report_render_output_bytes_mismatch:{render_label}")
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                errors.append(f"source_report_render_output_sha256_mismatch:{render_label}")
    if matched_renders <= 0:
        errors.append("source_report_lora_render_evidence_missing")
    return errors


def score_speaker_identity_proof_errors(score: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    thresholds = score.get("thresholds") if isinstance(score.get("thresholds"), dict) else {}
    if thresholds.get("requireProfileReferenceSimilarity") is not True:
        errors.append("score_threshold_profile_reference_similarity_missing")
    groups = score.get("groups")
    if not isinstance(groups, list) or not groups:
        return [*errors, "score_groups_missing"]
    for index, group in enumerate(groups):
        label = f"score.groups[{index}]"
        if not isinstance(group, dict):
            errors.append(f"{label}.invalid")
            continue
        render_count = group.get("renderCount")
        if not isinstance(render_count, int) or render_count <= 0:
            errors.append(f"{label}.render_count_invalid")
        if group.get("verdict") != "pass":
            errors.append(f"{label}.verdict_not_pass")
        if group.get("speakerIdentityVerdict") != "pass":
            errors.append(f"{label}.speaker_identity_verdict_not_pass")
        identity = group.get("speakerIdentity") if isinstance(group.get("speakerIdentity"), dict) else None
        if not isinstance(identity, dict):
            errors.append(f"{label}.speaker_identity_missing")
            continue
        if identity.get("verdict") != "pass":
            errors.append(f"{label}.speaker_identity_detail_not_pass")
        if identity.get("requireProfileReferenceSimilarity") is not True:
            errors.append(f"{label}.profile_reference_similarity_not_required")
        if identity.get("profileReferenceEvaluatedRenders") != render_count:
            errors.append(f"{label}.profile_reference_render_count_mismatch")
    return errors


def validate_quality_gate_artifact_proof(
    *,
    quality_gate_path: Path,
    quality_gate: dict[str, Any],
    voice_profile_id: str | None,
    profile_sha256: str | None,
    adapter_path: Path,
) -> None:
    proofs = quality_gate.get("proofs") if isinstance(quality_gate.get("proofs"), dict) else {}
    paths = quality_gate.get("paths") if isinstance(quality_gate.get("paths"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    resolved: dict[str, tuple[Path, str]] = {}

    for key in ("report", "asr", "speaker", "score"):
        path = resolve_quality_gate_proof_path(paths.get(key), quality_gate_path)
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else None
        if path is None:
            raise SystemExit(f"LoRA quality gate proof is missing {key} artifact path: {quality_gate_path}")
        if artifact is None:
            raise SystemExit(f"LoRA quality gate proof is missing {key} artifact metadata: {quality_gate_path}")
        artifact_path = resolve_quality_gate_proof_path(artifact.get("path"), quality_gate_path)
        if artifact_path is None or artifact_path != path:
            raise SystemExit(f"LoRA quality gate proof {key} artifact path does not match paths.{key}: {quality_gate_path}")
        proof_sha256 = artifact.get("sha256")
        if not isinstance(proof_sha256, str) or not proof_sha256.strip():
            raise SystemExit(f"LoRA quality gate proof is missing {key} artifact SHA-256: {quality_gate_path}")
        try:
            actual_sha256 = sha256_file(path)
        except OSError as exc:
            raise SystemExit(f"LoRA quality gate proof {key} artifact is missing or unreadable: {path}") from exc
        if actual_sha256 != proof_sha256:
            raise SystemExit(
                f"LoRA quality gate proof {key} artifact SHA-256 no longer matches the file: "
                f"{path} ({quality_gate_path})"
            )
        resolved[key] = (path, actual_sha256)

    score_path, _score_sha256 = resolved["score"]
    score = load_json(score_path, "LoRA quality gate score JSON")
    if score.get("verdict") != "pass":
        raise SystemExit(f"LoRA quality gate score JSON verdict is {score.get('verdict')!r}; expected 'pass' ({score_path})")
    score_speaker_errors = score_speaker_identity_proof_errors(score)
    if score_speaker_errors:
        raise SystemExit(
            "LoRA quality gate score JSON does not prove strict speaker identity: "
            + ", ".join(score_speaker_errors)
        )
    report_path, report_sha256 = resolved["report"]
    report = load_json(report_path, "LoRA quality gate source report JSON")
    asr_path, asr_sha256 = resolved["asr"]
    speaker_path, speaker_sha256 = resolved["speaker"]
    if not same_path(score.get("sourceReport"), report_path, score_path.parent):
        raise SystemExit(f"LoRA quality gate score JSON sourceReport does not match paths.report ({score_path})")
    if score.get("sourceReportSha256") != report_sha256:
        raise SystemExit(f"LoRA quality gate score JSON sourceReportSha256 no longer matches paths.report ({score_path})")
    if not same_path(score.get("asrJson"), asr_path, score_path.parent):
        raise SystemExit(f"LoRA quality gate score JSON asrJson does not match paths.asr ({score_path})")
    if score.get("asrJsonSha256") != asr_sha256:
        raise SystemExit(f"LoRA quality gate score JSON asrJsonSha256 no longer matches paths.asr ({score_path})")
    if not same_path(score.get("speakerJson"), speaker_path, score_path.parent):
        raise SystemExit(f"LoRA quality gate score JSON speakerJson does not match paths.speaker ({score_path})")
    if score.get("speakerJsonSha256") != speaker_sha256:
        raise SystemExit(f"LoRA quality gate score JSON speakerJsonSha256 no longer matches paths.speaker ({score_path})")
    validate_report_score_profile_evidence(
        report=report,
        score=score,
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
        label="LoRA quality gate score/report",
    )
    lora_errors = lora_render_evidence_errors(report, adapter_path, report_path)
    if lora_errors:
        raise SystemExit(
            "LoRA quality gate source report does not prove the verified adapter was loaded: "
            + ", ".join(lora_errors)
        )
    output_errors = ready_render_output_evidence_errors("score", score.get("groups"), score_path)
    output_errors.extend(ready_render_output_evidence_errors("sourceReport", report.get("groups"), report_path))
    if output_errors:
        raise SystemExit(
            "LoRA quality gate score/report does not prove ready render output files: "
            + ", ".join(output_errors)
        )


def validate_quality_gate(
    *,
    quality_gate_path: Path,
    quality_gate: dict[str, Any],
    profile: dict[str, Any],
    profile_path: Path,
    profile_sha256: str,
    adapter_path: Path,
    adapter_bytes: int,
    adapter_sha256: str,
) -> None:
    inputs = quality_gate.get("inputs") if isinstance(quality_gate.get("inputs"), dict) else {}
    proofs = quality_gate.get("proofs") if isinstance(quality_gate.get("proofs"), dict) else {}
    speaker = proofs.get("speakerBackendRequirement") if isinstance(proofs.get("speakerBackendRequirement"), dict) else {}
    adapter = proofs.get("loraAdapter") if isinstance(proofs.get("loraAdapter"), dict) else {}
    if quality_gate.get("status") != "pass" or quality_gate.get("dryRun") is not False:
        raise SystemExit(f"LoRA quality gate must be a non-dry-run pass: {quality_gate_path}")
    if not same_path(inputs.get("profileJson"), profile_path, quality_gate_path.parent):
        raise SystemExit(f"LoRA quality gate does not match profile: {inputs.get('profileJson')!r} != {profile_path}")
    if inputs.get("profileSha256") != profile_sha256:
        raise SystemExit(
            "LoRA quality gate is stale for this profile: "
            f"profileSha256={inputs.get('profileSha256')!r}, expected {profile_sha256}"
        )
    if inputs.get("cloneMode") != "hifi" or inputs.get("requireSpeakerBackend") != PRODUCT_SPEAKER_BACKEND:
        raise SystemExit("LoRA quality gate must be hifi and require speechbrain-ecapa")
    if (
        inputs.get("skipProfileVerify") is True
        or proofs.get("profileVerifyRequired") is not True
        or proofs.get("profileVerifyPassed") is not True
        or proofs.get("profileVerifySkipped") is True
    ):
        raise SystemExit("LoRA quality gate did not prove strict profile verification passed")
    if (
        inputs.get("skipTranscriptValidation") is True
        or proofs.get("transcriptValidationRequired") is not True
        or proofs.get("transcriptValidationPassed") is not True
        or proofs.get("transcriptValidationSkipped") is True
    ):
        raise SystemExit("LoRA quality gate did not prove transcript validation passed")
    validate_quality_gate_transcript_proof(
        quality_gate_path=quality_gate_path,
        quality_gate=quality_gate,
        profile=profile,
        profile_path=profile_path,
        profile_sha256=profile_sha256,
    )
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip() or None
    validate_quality_gate_artifact_proof(
        quality_gate_path=quality_gate_path,
        quality_gate=quality_gate,
        voice_profile_id=voice_profile_id,
        profile_sha256=profile_sha256,
        adapter_path=adapter_path,
    )
    if not same_path(inputs.get("loraPath"), adapter_path, quality_gate_path.parent):
        raise SystemExit(f"LoRA quality gate did not load the verified adapter: {inputs.get('loraPath')!r}")
    if speaker.get("selected") != PRODUCT_SPEAKER_BACKEND or speaker.get("required") != PRODUCT_SPEAKER_BACKEND:
        raise SystemExit("LoRA quality gate did not prove speechbrain-ecapa speaker verification")
    if (
        adapter.get("exists") is not True
        or not same_path(adapter.get("path"), adapter_path, quality_gate_path.parent)
        or adapter.get("bytes") != adapter_bytes
        or adapter.get("sha256") != adapter_sha256
    ):
        raise SystemExit("LoRA quality gate adapter proof does not match the verified adapter file")


def quality_gate_policy_summary(quality_gate: dict[str, Any]) -> dict[str, Any]:
    inputs = quality_gate.get("inputs") if isinstance(quality_gate.get("inputs"), dict) else {}
    proofs = quality_gate.get("proofs") if isinstance(quality_gate.get("proofs"), dict) else {}
    speaker = proofs.get("speakerBackendRequirement") if isinstance(proofs.get("speakerBackendRequirement"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    artifact_summary: dict[str, Any] = {}
    for key in ("report", "asr", "speaker", "score"):
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else {}
        artifact_summary[key] = {
            "path": artifact.get("path"),
            "sha256": artifact.get("sha256"),
        }
    return {
        "status": quality_gate.get("status"),
        "dryRun": quality_gate.get("dryRun"),
        "cloneMode": inputs.get("cloneMode"),
        "speakerBackend": speaker.get("selected"),
        "requiredSpeakerBackend": speaker.get("required"),
        "profileVerifyRequired": proofs.get("profileVerifyRequired"),
        "profileVerifyPassed": proofs.get("profileVerifyPassed"),
        "profileVerifySkipped": proofs.get("profileVerifySkipped"),
        "transcriptValidationRequired": proofs.get("transcriptValidationRequired"),
        "transcriptValidationPassed": proofs.get("transcriptValidationPassed"),
        "transcriptValidationSkipped": proofs.get("transcriptValidationSkipped"),
        "transcriptValidationJson": proofs.get("transcriptValidationJson") or inputs.get("transcriptValidationJson"),
        "transcriptValidationSha256": proofs.get("transcriptValidationSha256") or inputs.get("transcriptValidationSha256"),
        "artifacts": artifact_summary,
    }


def build_policy(
    *,
    profile: dict[str, Any],
    profile_path: Path,
    proof_path: Path,
    proof: dict[str, Any],
    quality_gate_path: Path,
    quality_gate: dict[str, Any],
    adapter_path: Path,
    adapter_bytes: int,
    adapter_sha256: str,
    train_config_path: Path,
) -> dict[str, Any]:
    return {
        "version": 1,
        "status": "accepted",
        "appliedAt": datetime.now(timezone.utc).isoformat(),
        "profileJson": str(profile_path),
        "voiceProfileId": str(profile.get("voiceProfileId") or ""),
        "profileSha256": canonical_profile_sha256(profile),
        "path": str(adapter_path),
        "bytes": adapter_bytes,
        "sha256": adapter_sha256,
        "adapterProofJson": str(proof_path),
        "adapterProofSha256": sha256_file(proof_path),
        "qualityGateJson": str(quality_gate_path),
        "qualityGateSha256": sha256_file(quality_gate_path),
        "trainConfig": str(train_config_path),
        "trainConfigSha256": sha256_file(train_config_path),
        "qualityGateProof": quality_gate_policy_summary(quality_gate),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply a verified VoxCPM LoRA adapter to a voice profile manifest.")
    parser.add_argument("adapter_proof_json")
    parser.add_argument("--quality-gate-json", required=True)
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    proof_path = Path(args.adapter_proof_json).expanduser().resolve(strict=False)
    quality_gate_path = Path(args.quality_gate_json).expanduser().resolve(strict=False)
    profile_path = Path(args.profile_json).expanduser().resolve(strict=False)
    proof = load_json(proof_path, "adapter proof JSON")
    quality_gate = load_json(quality_gate_path, "LoRA quality gate JSON")
    profile = load_json(profile_path, "voice profile")
    profile_sha256 = canonical_profile_sha256(profile)

    adapter_path, adapter_bytes, adapter_sha256, train_config_path = validate_adapter_proof(
        proof_path=proof_path,
        proof=proof,
        profile_path=profile_path,
        profile_sha256=profile_sha256,
    )
    validate_quality_gate(
        quality_gate_path=quality_gate_path,
        quality_gate=quality_gate,
        profile=profile,
        profile_path=profile_path,
        profile_sha256=profile_sha256,
        adapter_path=adapter_path,
        adapter_bytes=adapter_bytes,
        adapter_sha256=adapter_sha256,
    )
    policy = build_policy(
        profile=profile,
        profile_path=profile_path,
        proof_path=proof_path,
        proof=proof,
        quality_gate_path=quality_gate_path,
        quality_gate=quality_gate,
        adapter_path=adapter_path,
        adapter_bytes=adapter_bytes,
        adapter_sha256=adapter_sha256,
        train_config_path=train_config_path,
    )
    if not args.dry_run:
        profile["loraPath"] = str(adapter_path)
        profile["loraAdapter"] = policy
        write_json(profile_path, profile)
    print(
        json.dumps(
            {
                "status": "validated" if args.dry_run else "applied",
                "profileJson": str(profile_path),
                "loraPath": str(adapter_path),
                "adapterSha256": adapter_sha256,
                "qualityGateJson": str(quality_gate_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

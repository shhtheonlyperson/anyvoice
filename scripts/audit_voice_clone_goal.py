from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from voice_profile_next_step import (
    DEFAULT_KIT_MANIFEST,
    DEFAULT_PROFILE_JSON,
    PRODUCT_PROOF_ASR_BACKEND,
    PRODUCT_PROOF_SPEAKER_BACKEND,
    commands as next_step_commands,
    latest_transcript_validation_for_profile,
    pending_external_recording_sources,
    product_proof_asr_backend,
    product_proof_speaker_backend,
    quality_gate_full_eval_inputs,
    quality_gate_root,
    strict_profile_quality_gate_passed,
    transcript_validation_rows_match_profile,
)
from prepare_voxcpm_lora_training_job import (
    validate_trainer_command_resolution,
    validate_trainer_command_template,
    validate_dataset as validate_lora_dataset_files,
    validate_dataset_proofs as validate_lora_dataset_proofs,
)
from select_voice_backend_candidate import evaluate_selection


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LORA_DATASET_ROOT = REPO_ROOT / "generated" / "voice-lora-datasets"
DEFAULT_LORA_TRAINING_JOB_ROOT = REPO_ROOT / "generated" / "voice-lora-training-jobs"
DEFAULT_BACKEND_SELECTION_ROOT = REPO_ROOT / "generated" / "voice-backend-shootouts"
PRODUCT_CAPTURE_CLIPS = 7
PRODUCT_CAPTURE_DURATION_SEC = 60.0
PRODUCT_PRONUNCIATION_PRESETS = [
    ("polyphone:chongqing", ["重慶", "重庆"]),
    ("polyphone:bank", ["銀行", "银行"]),
    ("polyphone:role", ["角色"]),
    ("polyphone:music", ["音樂", "音乐"]),
    ("polyphone:changle", ["長樂", "长乐"]),
    ("brand:anyvoice", ["AnyVoice"]),
]
PRODUCT_PRONUNCIATION_PRESET_IDS = [preset_id for preset_id, _terms in PRODUCT_PRONUNCIATION_PRESETS]
COMPLETION_REQUIREMENTS: list[tuple[str, str]] = [
    ("recording_kit", "7-clip product capture depth exists or extended recording kit passes the pre-import check"),
    ("strict_profile", "strict profile verifier passes with current ASR transcript-validation evidence"),
    ("capture_depth", "profile has at least 7 selected clips, 60 seconds of audio, and current product pronunciation preset coverage"),
    ("proof_environment", "Faster-Whisper ASR and speechbrain-ecapa speaker-verification backends are available in the configured Python environments"),
    ("quality_gate", "non-dry-run hifi quality gate passes with current profile, transcript, ASR, speaker, and artifact proofs"),
    ("product_10x_proof", "paired prompt-vs-hifi product proof passes with required speechbrain-ecapa speaker verification"),
    ("subjective_review", "blind A/B review is exported for the product report, has no rerender requests, and does not prefer baseline over hifi"),
    ("lora_dataset", "consented LoRA dataset export is bound to current profile, transcript validation, product proof, and row hashes"),
    ("lora_training_job", "LoRA training job has a valid trainer command or readable adapter proof bound to the current dataset/profile"),
    ("lora_adapter", "LoRA adapter proof verifies a readable adapter file with byte and SHA-256 evidence"),
    ("lora_quality_gate", "non-dry-run quality gate passes with the verified LoRA adapter loaded and applied to the profile"),
]
OPTIONAL_STAGE_IDS = {"backend_selection"}
COMPLETION_REQUIREMENT_EVIDENCE_KEYS: dict[str, tuple[str, ...]] = {
    "recording_kit": (
        "path",
        "clipCount",
        "selectedClips",
        "totalDurationSec",
        "recommendedClips",
        "recommendedDurationSec",
        "recommendedPromptSet",
        "requiredPronunciationPresetIds",
        "missingPronunciationPresetIds",
        "missingClips",
        "pendingExternalRecordings",
        "pendingExternalRecordingCount",
        "missingExternalRecordingSourceCount",
        "firstMissingClip",
        "firstFailedClip",
        "recordingPreflight",
    ),
    "strict_profile": (
        "path",
        "transcriptValidationJson",
        "summary",
        "failedChecks",
    ),
    "capture_depth": (
        "selectedClips",
        "totalDurationSec",
        "recommendedClips",
        "recommendedDurationSec",
        "requiredPronunciationPresetIds",
        "missingPronunciationPresetIds",
    ),
    "proof_environment": ("asr", "speaker", "missingBackends", "checkCommands"),
    "quality_gate": (
        "qualityGateJson",
        "createdAt",
        "gateStatus",
        "dryRun",
        "transcriptValidationProof",
        "artifactProof",
    ),
    "product_10x_proof": (
        "qualityGateJson",
        "createdAt",
        "transcriptValidationProof",
        "artifactProof",
    ),
    "subjective_review": (
        "report",
        "reviewJson",
        "expectedReviewJson",
        "stats",
        "missingChoices",
        "invalidChoices",
        "ambiguousRounds",
    ),
    "lora_dataset": (
        "datasetJson",
        "totalClips",
        "totalDurationSec",
        "recommendedClips",
        "recommendedDurationSec",
        "proofs",
        "datasetProofValidation",
        "datasetValidationError",
        "productQualityGateOk",
    ),
    "lora_training_job": (
        "trainConfig",
        "datasetJson",
        "datasetBindingErrors",
        "datasetProofValidation",
        "datasetValidationError",
        "trainerStatus",
        "trainerCommandConfigured",
        "trainerCommandValid",
        "trainerCommandSource",
        "trainScript",
        "expectedWeights",
        "adapterProof",
        "adapterProofStatus",
        "adapterProofBindingErrors",
    ),
    "lora_adapter": (
        "adapterProof",
        "adapterPath",
        "adapterSha256",
        "adapterStatus",
        "trainConfig",
    ),
    "lora_quality_gate": (
        "qualityGateJson",
        "createdAt",
        "adapterProof",
        "adapterPath",
        "adapterSha256",
        "transcriptValidationProof",
        "artifactProof",
        "loraAdapterPolicy",
        "applyCommand",
    ),
    "backend_selection": (
        "selectionJson",
        "scoreJson",
        "baselineCloneMode",
        "candidateCloneMode",
        "subjectiveReview",
        "candidate",
        "preferredBackendPolicy",
        "evidence",
        "applyCommand",
    ),
}


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return payload if isinstance(payload, dict) else None


def run_json(command: list[str]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    proc = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    meta = {
        "command": command,
        "exitCode": proc.returncode,
        "stderr": proc.stderr.strip() or None,
    }
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else None
    except json.JSONDecodeError:
        meta["stdoutText"] = proc.stdout.strip() or None
        return None, meta
    return payload if isinstance(payload, dict) else None, meta


def same_path(raw: Any, expected: Path, base_dir: Path | None = None) -> bool:
    if not isinstance(raw, str) or not raw.strip():
        return False
    path = Path(raw).expanduser()
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path.resolve() == expected.resolve()


def same_path_from_bases(raw: Any, raw_base_dir: Path, expected: Any, expected_base_dir: Path) -> bool:
    if not isinstance(raw, str) or not raw.strip():
        return False
    if not isinstance(expected, str) or not expected.strip():
        return False
    raw_path = Path(raw).expanduser()
    expected_path = Path(expected).expanduser()
    if not raw_path.is_absolute():
        raw_path = raw_base_dir / raw_path
    if not expected_path.is_absolute():
        expected_path = expected_base_dir / expected_path
    return raw_path.resolve() == expected_path.resolve()


def resolve_config_path(raw: Any, base_dir: Path) -> Path | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def stage(stage_id: str, status: str, message: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": stage_id,
        "status": status,
        "ok": status == "pass",
        "message": message,
        **{key: value for key, value in extra.items() if value is not None},
    }


def completion_requirement_evidence(row: dict[str, Any]) -> dict[str, Any]:
    stage_id = str(row.get("id") or "")
    keys = COMPLETION_REQUIREMENT_EVIDENCE_KEYS.get(stage_id, ())
    return {key: row[key] for key in keys if key in row}


def completion_requirements(stages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_stage_id = {str(row.get("id") or ""): row for row in stages if isinstance(row, dict)}
    requirements: list[dict[str, Any]] = []
    for order, (stage_id, requirement) in enumerate(COMPLETION_REQUIREMENTS, start=1):
        row = by_stage_id.get(stage_id)
        if row is None:
            requirements.append(
                {
                    "id": stage_id,
                    "stageId": stage_id,
                    "order": order,
                    "requirement": requirement,
                    "status": "missing",
                    "ok": False,
                    "message": "audit stage did not run",
                    "evidence": {},
                }
            )
            continue
        status = str(row.get("status") or "missing")
        requirements.append(
            {
                "id": stage_id,
                "stageId": stage_id,
                "order": order,
                "requirement": requirement,
                "status": status,
                "ok": status == "pass",
                "message": row.get("message"),
                "evidence": completion_requirement_evidence(row),
            }
        )
    return requirements


def profile_has_preferred_backend_policy(profile: Path) -> bool:
    payload = load_json(profile)
    return isinstance(payload, dict) and isinstance(payload.get("preferredBackend"), dict)


def optional_stage_blocks_completion(row: dict[str, Any], profile: Path) -> bool:
    stage_id = str(row.get("id") or "")
    if stage_id != "backend_selection":
        return False
    if row.get("status") == "pass":
        return False
    return profile_has_preferred_backend_policy(profile)


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts)


def file_sha256(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_policy_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def lora_quality_gate_summary_matches_gate(
    summary: Any,
    gate: dict[str, Any],
    summary_base_dir: Path,
    gate_base_dir: Path,
) -> bool:
    if summary is None:
        return True
    if not isinstance(summary, dict):
        return False
    inputs = gate.get("inputs") if isinstance(gate.get("inputs"), dict) else {}
    proofs = gate.get("proofs") if isinstance(gate.get("proofs"), dict) else {}
    speaker = proofs.get("speakerBackendRequirement") if isinstance(proofs.get("speakerBackendRequirement"), dict) else {}
    expected_fields = {
        "status": gate.get("status"),
        "dryRun": gate.get("dryRun"),
        "cloneMode": inputs.get("cloneMode"),
        "speakerBackend": speaker.get("selected"),
        "requiredSpeakerBackend": speaker.get("required"),
        "profileVerifyRequired": proofs.get("profileVerifyRequired"),
        "profileVerifyPassed": proofs.get("profileVerifyPassed"),
        "profileVerifySkipped": proofs.get("profileVerifySkipped"),
        "transcriptValidationRequired": proofs.get("transcriptValidationRequired"),
        "transcriptValidationPassed": proofs.get("transcriptValidationPassed"),
        "transcriptValidationSkipped": proofs.get("transcriptValidationSkipped"),
        "transcriptValidationSha256": proofs.get("transcriptValidationSha256") or inputs.get("transcriptValidationSha256"),
    }
    if any(summary.get(key) != expected for key, expected in expected_fields.items()):
        return False
    transcript_validation_json = proofs.get("transcriptValidationJson") or inputs.get("transcriptValidationJson")
    if isinstance(transcript_validation_json, str) and transcript_validation_json.strip():
        if not same_path_from_bases(
            summary.get("transcriptValidationJson"),
            summary_base_dir,
            transcript_validation_json,
            gate_base_dir,
        ):
            return False
    elif summary.get("transcriptValidationJson") != transcript_validation_json:
        return False
    summary_artifacts = summary.get("artifacts") if isinstance(summary.get("artifacts"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    for key in ("report", "asr", "speaker", "score"):
        summary_artifact = summary_artifacts.get(key) if isinstance(summary_artifacts.get(key), dict) else {}
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else {}
        artifact_path = artifact.get("path")
        if isinstance(artifact_path, str) and artifact_path.strip():
            if not same_path_from_bases(summary_artifact.get("path"), summary_base_dir, artifact_path, gate_base_dir):
                return False
        elif summary_artifact.get("path") != artifact_path:
            return False
        if summary_artifact.get("sha256") != artifact.get("sha256"):
            return False
    return True


def backend_subjective_review_summary_matches(
    summary: Any,
    expected: dict[str, Any],
    summary_base_dir: Path,
    expected_base_dir: Path,
) -> bool:
    if summary is None:
        return True
    if not isinstance(summary, dict):
        return False
    for key in ("reviewJson", "report"):
        expected_path = expected.get(key)
        if isinstance(expected_path, str) and expected_path.strip():
            if not same_path_from_bases(summary.get(key), summary_base_dir, expected_path, expected_base_dir):
                return False
        elif summary.get(key) != expected_path:
            return False
    for key in ("status", "reasons", "stats", "reviewStats", "statMismatches", "missingChoices", "invalidChoices"):
        if summary.get(key) != expected.get(key):
            return False
    return True


def profile_sha256_for_path(profile: Path) -> str | None:
    payload = load_json(profile)
    return canonical_profile_sha256(payload) if payload else None


def quality_gate_profile_sha_matches(inputs: dict[str, Any], profile: Path) -> bool:
    expected = profile_sha256_for_path(profile)
    return bool(expected and inputs.get("profileSha256") == expected)


def profile_evidence_errors(
    label: str,
    value: Any,
    *,
    voice_profile_id: str | None,
    profile_sha256: str | None,
    require: bool = True,
) -> list[str]:
    evidence = value if isinstance(value, dict) else {}
    errors: list[str] = []
    if voice_profile_id:
        actual_voice_profile_id = str(evidence.get("voiceProfileId") or "").strip()
        if actual_voice_profile_id:
            if actual_voice_profile_id != voice_profile_id:
                errors.append(f"{label}.voiceProfileId")
        elif require:
            errors.append(f"{label}.voiceProfileId")
    if profile_sha256:
        actual_profile_sha256 = str(evidence.get("profileSha256") or "").strip()
        if actual_profile_sha256:
            if actual_profile_sha256 != profile_sha256:
                errors.append(f"{label}.profileSha256")
        elif require:
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
                require=False,
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


def report_score_profile_evidence_errors(
    *,
    report: dict[str, Any],
    score: dict[str, Any],
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> list[str]:
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


def source_report_lora_render_evidence_errors(
    *,
    report: dict[str, Any],
    adapter_path: Path,
    report_path: Path,
) -> list[str]:
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
            actual_sha256 = file_sha256(output_path)
            try:
                actual_bytes = output_path.stat().st_size
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


def source_report_render_output_evidence_errors(report: dict[str, Any], report_path: Path) -> list[str]:
    errors: list[str] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
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
            actual_sha256 = file_sha256(output_path)
            try:
                actual_bytes = output_path.stat().st_size
            except OSError:
                errors.append(f"source_report_render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                errors.append(f"source_report_render_output_bytes_mismatch:{render_label}")
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                errors.append(f"source_report_render_output_sha256_mismatch:{render_label}")
    return errors


def score_render_output_evidence_errors(score: dict[str, Any], score_path: Path) -> list[str]:
    errors: list[str] = []
    groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        case_id = str(group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                errors.append(f"score_render_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                errors.append(f"score_render_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                errors.append(f"score_render_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, score_path)
            if output_path is None:
                errors.append(f"score_render_output_path_missing:{render_label}")
                continue
            actual_sha256 = file_sha256(output_path)
            try:
                actual_bytes = output_path.stat().st_size
            except OSError:
                errors.append(f"score_render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                errors.append(f"score_render_output_bytes_mismatch:{render_label}")
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                errors.append(f"score_render_output_sha256_mismatch:{render_label}")
    return errors


def source_report_profile_evidence_errors(
    *,
    report: dict[str, Any],
    voice_profile_id: str | None,
    profile_sha256: str | None,
) -> list[str]:
    errors: list[str] = []
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
    return errors


def string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if isinstance(item, str) and item.strip()]
    return []


def pronunciation_preset_ids_from_text(text: str) -> set[str]:
    return {
        preset_id
        for preset_id, terms in PRODUCT_PRONUNCIATION_PRESETS
        if any(term in text for term in terms)
    }


def clip_pronunciation_preset_ids(clip: dict[str, Any]) -> set[str]:
    ids = pronunciation_preset_ids_from_text(str(clip.get("transcriptRaw") or ""))
    raw = clip.get("pronunciationPresetIds")
    if isinstance(raw, list):
        ids.update(str(item) for item in raw if isinstance(item, str) and item)
    return ids


def profile_pronunciation_preset_ids(profile_payload: dict[str, Any]) -> set[str]:
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    ids: set[str] = set()
    for clip in clips:
        if isinstance(clip, dict):
            ids.update(clip_pronunciation_preset_ids(clip))
    return ids


def product_capture_depth_evidence(profile: Path) -> dict[str, Any]:
    profile_payload = load_json(profile)
    if not profile_payload:
        return {
            "profileLoaded": False,
            "hasProductCaptureDepth": False,
            "selectedClips": 0,
            "totalDurationSec": 0.0,
            "recommendedClips": PRODUCT_CAPTURE_CLIPS,
            "recommendedDurationSec": PRODUCT_CAPTURE_DURATION_SEC,
            "requiredPronunciationPresetIds": PRODUCT_PRONUNCIATION_PRESET_IDS,
            "missingPronunciationPresetIds": PRODUCT_PRONUNCIATION_PRESET_IDS,
        }
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    summary = profile_payload.get("summary") if isinstance(profile_payload.get("summary"), dict) else {}
    selected = summary.get("selectedClips")
    selected_clips = int(selected) if isinstance(selected, int) else len(clips)
    total_duration = round(profile_capture_duration(profile_payload), 3)
    covered_ids = profile_pronunciation_preset_ids(profile_payload)
    covered_preset_ids = [preset_id for preset_id in PRODUCT_PRONUNCIATION_PRESET_IDS if preset_id in covered_ids]
    missing_ids = [preset_id for preset_id in PRODUCT_PRONUNCIATION_PRESET_IDS if preset_id not in covered_ids]
    return {
        "profileLoaded": True,
        "hasProductCaptureDepth": selected_clips >= PRODUCT_CAPTURE_CLIPS
        and total_duration >= PRODUCT_CAPTURE_DURATION_SEC
        and not missing_ids,
        "selectedClips": selected_clips,
        "totalDurationSec": total_duration,
        "recommendedClips": PRODUCT_CAPTURE_CLIPS,
        "recommendedDurationSec": PRODUCT_CAPTURE_DURATION_SEC,
        "coveredPronunciationPresetIds": covered_preset_ids,
        "requiredPronunciationPresetIds": PRODUCT_PRONUNCIATION_PRESET_IDS,
        "missingPronunciationPresetIds": missing_ids,
    }


def profile_has_product_capture_depth(profile: Path) -> tuple[bool, int, float]:
    evidence = product_capture_depth_evidence(profile)
    return (
        bool(evidence["hasProductCaptureDepth"]),
        int(evidence["selectedClips"]),
        float(evidence["totalDurationSec"]),
    )


def first_missing_recording_clip(
    payload: dict[str, Any],
    missing_clips: list[str],
    *,
    profile_id: str,
    manifest: Path,
) -> dict[str, Any] | None:
    if not missing_clips:
        return None
    first_id = missing_clips[0]
    clips = payload.get("clips") if isinstance(payload.get("clips"), list) else []
    clip = next((row for row in clips if isinstance(row, dict) and str(row.get("id") or "") == first_id), None)
    if clip is None:
        return {
            "id": first_id,
            "recordCommand": record_profile_kit_focused_clip_command(profile_id, manifest, first_id),
        }
    return {
        "id": first_id,
        "index": clip.get("index"),
        "audioPath": clip.get("audioPath"),
        "promptPath": clip.get("promptPath"),
        "transcript": clip.get("transcript"),
        "coverageFeatures": string_list(clip.get("coverageFeatures")),
        "errors": string_list(clip.get("errors")),
        "recordCommand": record_profile_kit_focused_clip_command(profile_id, manifest, first_id),
    }


def recording_kit_failed_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    checks = payload.get("checks") if isinstance(payload.get("checks"), list) else []
    failed_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    order: list[tuple[str, str]] = []
    for check in checks:
        if not isinstance(check, dict) or check.get("ok") is True:
            continue
        check_id = str(check.get("check") or "")
        details = check.get("details") if isinstance(check.get("details"), dict) else {}
        rows = details.get("rows") if isinstance(details.get("rows"), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            clip_id = str(row.get("id") or "")
            audio_path = str(row.get("audioPath") or "")
            key = (clip_id, audio_path)
            if key not in failed_by_key:
                failed_by_key[key] = {
                    "id": clip_id,
                    "index": row.get("index"),
                    "audioPath": audio_path,
                    "checks": [],
                    "errors": [],
                }
                order.append(key)
            failed = failed_by_key[key]
            if check_id:
                failed["checks"].append(check_id)
            for error in string_list(row.get("errors")):
                if error not in failed["errors"]:
                    failed["errors"].append(error)
    return [failed_by_key[key] for key in order]


def recording_preflight_for_kit(manifest: Path, profile_id: str) -> dict[str, Any]:
    payload, meta = run_json(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "record_voice_profile_recording_kit.py"),
            "--manifest",
            str(manifest),
            "--preflight",
            "--auto-duration",
            "--profile-id",
            profile_id,
        ]
    )
    if not payload:
        return {
            "status": "blocked",
            "ok": False,
            "message": "recording preflight did not return JSON",
            "run": meta,
        }
    status = str(payload.get("status") or "")
    return {
        "status": status,
        "ok": status in {"ready_to_record", "all_recordings_present"},
        "message": payload.get("message"),
        "recorder": payload.get("recorder") if isinstance(payload.get("recorder"), dict) else None,
        "recordingGuidance": payload.get("recordingGuidance") if isinstance(payload.get("recordingGuidance"), dict) else None,
        "summary": payload.get("summary") if isinstance(payload.get("summary"), dict) else None,
        "run": meta,
    }


def audit_recording_kit(manifest: Path, profile_id: str, profile: Path) -> dict[str, Any]:
    capture_depth = product_capture_depth_evidence(profile)
    has_capture_depth = bool(capture_depth["hasProductCaptureDepth"])
    if not manifest.exists():
        if has_capture_depth:
            return stage(
                "recording_kit",
                "pass",
                "profile already has temporary 7-clip product capture depth, so recording kit import evidence is no longer required",
                path=str(manifest),
                **capture_depth,
            )
        return stage(
            "recording_kit",
            "missing",
            "recording kit manifest is missing",
            path=str(manifest),
            recommendedClips=PRODUCT_CAPTURE_CLIPS,
            recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
            recommendedPromptSet="extended",
            missingPronunciationPresetIds=capture_depth["missingPronunciationPresetIds"],
            requiredPronunciationPresetIds=capture_depth["requiredPronunciationPresetIds"],
        )
    payload, meta = run_json(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "check_voice_profile_recording_kit.py"),
            "--manifest",
            str(manifest),
            "--profile-id",
            profile_id,
        ]
    )
    if not payload:
        if has_capture_depth:
            return stage(
                "recording_kit",
                "pass",
                "profile already has temporary 7-clip product capture depth, so recording kit check output is no longer required",
                path=str(manifest),
                **capture_depth,
                run=meta,
            )
        return stage("recording_kit", "blocked", "recording kit check did not return JSON", run=meta)
    status = "pass" if payload.get("status") == "ready_to_import" else "blocked"
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else None
    missing_clips: list[str] = []
    checks = payload.get("checks") if isinstance(payload.get("checks"), list) else []
    audio_check: dict[str, Any] | None = None
    for check in checks:
        if not isinstance(check, dict) or check.get("check") != "audio_files":
            continue
        audio_check = check
        details = check.get("details") if isinstance(check.get("details"), dict) else {}
        rows = details.get("rows") if isinstance(details.get("rows"), list) else []
        missing_clips = [
            str(row.get("id"))
            for row in rows
            if isinstance(row, dict)
            and "audio_file_missing" in [str(error) for error in (row.get("errors") if isinstance(row.get("errors"), list) else [])]
        ]
    raw_status = str(payload.get("status") or "")
    first_missing_clip = first_missing_recording_clip(payload, missing_clips, profile_id=profile_id, manifest=manifest)
    failed_clips = recording_kit_failed_rows(payload)
    pending_external_recordings = pending_external_recording_sources(audio_check, manifest)
    pending_external_count = len(pending_external_recordings)
    missing_external_source_count = max(0, len(missing_clips) - pending_external_count)
    recording_preflight = recording_preflight_for_kit(manifest, profile_id) if status != "pass" else None
    if status == "pass":
        message = "recording kit is ready to import"
    elif raw_status == "incomplete":
        message = "recording kit is incomplete"
    else:
        message = raw_status or "recording kit is not ready"
    if status != "pass" and has_capture_depth:
        return stage(
            "recording_kit",
            "pass",
            "profile already has temporary 7-clip product capture depth, so stale recording kit state does not block completion",
            path=str(manifest),
            clipCount=summary.get("clips") if summary else None,
            **capture_depth,
            summary=summary,
            run=meta,
        )
    return stage(
        "recording_kit",
        status,
        message,
        path=str(manifest),
        clipCount=summary.get("clips") if summary else None,
        selectedClips=capture_depth["selectedClips"],
        totalDurationSec=capture_depth["totalDurationSec"],
        recommendedClips=PRODUCT_CAPTURE_CLIPS,
        recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
        recommendedPromptSet="extended" if summary and isinstance(summary.get("clips"), int) and summary.get("clips") < PRODUCT_CAPTURE_CLIPS else None,
        missingPronunciationPresetIds=capture_depth["missingPronunciationPresetIds"],
        requiredPronunciationPresetIds=capture_depth["requiredPronunciationPresetIds"],
        summary=summary,
        missingClips=missing_clips,
        pendingExternalRecordings=pending_external_recordings,
        pendingExternalRecordingCount=pending_external_count,
        missingExternalRecordingSourceCount=missing_external_source_count,
        firstMissingClip=first_missing_clip,
        failedClips=failed_clips,
        firstFailedClip=failed_clips[0] if failed_clips else None,
        recordingPreflight=recording_preflight,
        run=meta,
    )


def audit_strict_profile(profile: Path, transcript_validation: Path | None) -> dict[str, Any]:
    if not profile.exists():
        return stage("strict_profile", "missing", "voice profile JSON is missing", path=str(profile))
    command = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "verify_voice_profile_ready.py"),
        "--profile-json",
        str(profile),
        "--require-transcript-validation",
    ]
    if transcript_validation:
        command.extend(["--transcript-validation-json", str(transcript_validation)])
    payload, meta = run_json(command)
    if not payload:
        return stage("strict_profile", "blocked", "strict profile verifier did not return JSON", run=meta)
    status = "pass" if payload.get("status") == "ready" else "blocked"
    failed = [
        {"check": row.get("check"), "message": row.get("message")}
        for row in (payload.get("checks") if isinstance(payload.get("checks"), list) else [])
        if isinstance(row, dict) and row.get("ok") is not True
    ]
    message = "strict profile verifier passed" if status == "pass" else "strict profile verifier is blocked"
    return stage(
        "strict_profile",
        status,
        message,
        path=str(profile),
        transcriptValidationJson=str(transcript_validation) if transcript_validation else None,
        summary=payload.get("summary") if isinstance(payload.get("summary"), dict) else None,
        failedChecks=failed,
        run=meta,
    )


def profile_capture_duration(profile_payload: dict[str, Any]) -> float:
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    total = 0.0
    for clip in clips:
        if not isinstance(clip, dict):
            continue
        quality = clip.get("quality") if isinstance(clip.get("quality"), dict) else {}
        duration = quality.get("durationSec")
        if isinstance(duration, (int, float)):
            total += float(duration)
    return total


def audit_capture_depth(profile: Path) -> dict[str, Any]:
    capture_depth = product_capture_depth_evidence(profile)
    if not capture_depth["profileLoaded"]:
        return stage(
            "capture_depth",
            "missing",
            "voice profile JSON is missing, so capture depth cannot be audited",
            recommendedClips=PRODUCT_CAPTURE_CLIPS,
            recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
            requiredPronunciationPresetIds=PRODUCT_PRONUNCIATION_PRESET_IDS,
            missingPronunciationPresetIds=PRODUCT_PRONUNCIATION_PRESET_IDS,
        )
    ok = bool(capture_depth["hasProductCaptureDepth"])
    missing_reasons = []
    if int(capture_depth["selectedClips"]) < PRODUCT_CAPTURE_CLIPS:
        missing_reasons.append(f"selected clips {capture_depth['selectedClips']}/{PRODUCT_CAPTURE_CLIPS}")
    if float(capture_depth["totalDurationSec"]) < PRODUCT_CAPTURE_DURATION_SEC:
        missing_reasons.append(f"duration {capture_depth['totalDurationSec']}/{PRODUCT_CAPTURE_DURATION_SEC}s")
    missing_presets = capture_depth["missingPronunciationPresetIds"]
    if missing_presets:
        missing_reasons.append(f"missing pronunciation presets: {', '.join(missing_presets)}")
    return stage(
        "capture_depth",
        "pass" if ok else "blocked",
        "profile has temporary 7-clip product capture depth"
        if ok
        else "profile is missing temporary 7-clip product capture depth: "
        + "; ".join(missing_reasons)
        + ". Record more guided clips; the 10-clip extended kit remains the final clone target",
        **capture_depth,
    )


def audit_proof_environment() -> dict[str, Any]:
    asr = product_proof_asr_backend()
    speaker = product_proof_speaker_backend()
    asr_ready = asr.get("available") is True and asr.get("requiredBackend") == PRODUCT_PROOF_ASR_BACKEND
    speaker_ready = speaker.get("available") is True and speaker.get("requiredBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
    if asr_ready and speaker_ready:
        return stage(
            "proof_environment",
            "pass",
            "ASR and product speaker-verification backends are ready",
            asr=asr,
            speaker=speaker,
            checkCommands=[asr.get("checkCommand"), speaker.get("checkCommand")],
        )
    missing = []
    if not asr_ready:
        missing.append(PRODUCT_PROOF_ASR_BACKEND)
    if not speaker_ready:
        missing.append(PRODUCT_PROOF_SPEAKER_BACKEND)
    return stage(
        "proof_environment",
        "blocked",
        "proof backend setup is incomplete",
        missingBackends=missing,
        asr=asr,
        speaker=speaker,
        checkCommands=[asr.get("checkCommand"), speaker.get("checkCommand")],
    )


def product_quality_gate_passed(report: dict[str, Any] | None) -> bool:
    if not strict_profile_quality_gate_passed(report):
        return False
    artifact_proof = report.get("artifactProof")
    if not isinstance(artifact_proof, dict) or artifact_proof.get("ok") is not True:
        return False
    inputs = report.get("inputs")
    proofs = report.get("proofs")
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    if isinstance(inputs.get("loraPath"), str) and str(inputs.get("loraPath")).strip():
        return False
    transcript_validation = report.get("transcriptValidationProof")
    if isinstance(transcript_validation, dict) and transcript_validation.get("ok") is not True:
        return False
    speaker = proofs.get("speakerBackendRequirement")
    speaker_ok = (
        isinstance(speaker, dict)
        and speaker.get("required") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker.get("selected") == PRODUCT_PROOF_SPEAKER_BACKEND
    )
    return (
        inputs.get("cloneMode") == "both"
        and inputs.get("requireSpeakerBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker_ok
        and product_paired_improvement_passed(report)
    )


def product_paired_improvement_passed(report: dict[str, Any]) -> bool:
    quality_gate_path = (
        Path(str(report.get("json"))).expanduser().resolve(strict=False)
        if isinstance(report.get("json"), str) and str(report.get("json")).strip()
        else None
    )
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    score_path = resolve_quality_gate_proof_path(paths.get("score"), quality_gate_path) if quality_gate_path else None
    score = load_json(score_path) if score_path else None
    if not score:
        return False
    paired = score.get("pairedComparison") if isinstance(score.get("pairedComparison"), dict) else None
    if not paired or paired.get("verdict") != "pass":
        return False
    if paired.get("baselineCloneMode") != "prompt" or paired.get("candidateCloneMode") != "hifi":
        return False
    min_reduction = paired.get("minReductionPct")
    if not isinstance(min_reduction, (int, float)):
        min_reduction = 50.0
    summary = paired.get("summary") if isinstance(paired.get("summary"), dict) else {}
    pairs = paired.get("pairs") if isinstance(paired.get("pairs"), list) else []
    pair_count = summary.get("pairs")
    passing_pairs = summary.get("passingPairs")
    review_pairs = summary.get("reviewPairs")
    if not isinstance(pair_count, int) or pair_count <= 0 or len(pairs) != pair_count:
        return False
    if passing_pairs != pair_count or review_pairs != 0:
        return False
    if summary.get("blockingPairs") not in {None, 0}:
        return False
    paired_reasons = paired.get("reasons")
    if isinstance(paired_reasons, list) and paired_reasons:
        return False
    reduction_values = [
        float(value)
        for key in ("avgCerReductionPct", "avgWerReductionPct")
        for value in [summary.get(key)]
        if isinstance(value, (int, float))
    ]
    if not reduction_values or max(reduction_values) < float(min_reduction):
        return False
    speaker_delta = summary.get("avgSpeakerSimilarityDelta")
    if not isinstance(speaker_delta, (int, float)) or float(speaker_delta) < 0:
        return False
    latency = summary.get("avgLatencyRegressionPct")
    latency_limit = None
    for row in pairs:
        if isinstance(row, dict) and isinstance(row.get("maxLatencyRegressionPct"), (int, float)):
            latency_limit = float(row["maxLatencyRegressionPct"])
            break
    if latency_limit is None:
        latency_limit = 0.0
    if not isinstance(latency, (int, float)) or float(latency) > latency_limit:
        return False
    for row in pairs:
        if not isinstance(row, dict) or row.get("verdict") != "pass":
            return False
        if row.get("baselineCloneMode") != "prompt" or row.get("candidateCloneMode") != "hifi":
            return False
        blocking_reasons = row.get("blockingReasons")
        if isinstance(blocking_reasons, list) and blocking_reasons:
            return False
        row_speaker_delta = row.get("speakerSimilarityDelta")
        if not isinstance(row_speaker_delta, (int, float)):
            return False
    return True


def lora_quality_gate_passed(
    report: dict[str, Any] | None,
    adapter_path: Path,
    adapter_sha256: str,
    adapter_bytes: int,
) -> bool:
    if not strict_profile_quality_gate_passed(report):
        return False
    artifact_proof = report.get("artifactProof")
    if not isinstance(artifact_proof, dict) or artifact_proof.get("ok") is not True:
        return False
    inputs = report.get("inputs") if isinstance(report, dict) else None
    proofs = report.get("proofs") if isinstance(report, dict) else None
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    speaker = proofs.get("speakerBackendRequirement")
    adapter = proofs.get("loraAdapter")
    quality_gate_path = (
        Path(str(report.get("json"))).expanduser().resolve(strict=False)
        if isinstance(report.get("json"), str) and str(report.get("json")).strip()
        else None
    )
    quality_gate_base = quality_gate_path.parent if quality_gate_path else None
    speaker_ok = (
        isinstance(speaker, dict)
        and speaker.get("required") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker.get("selected") == PRODUCT_PROOF_SPEAKER_BACKEND
    )
    adapter_ok = (
        isinstance(adapter, dict)
        and adapter.get("exists") is True
        and same_path(adapter.get("path"), adapter_path, quality_gate_base)
        and adapter.get("sha256") == adapter_sha256
        and adapter.get("bytes") == adapter_bytes
    )
    transcript_validation = report.get("transcriptValidationProof")
    transcript_validation_ok = (
        isinstance(transcript_validation, dict)
        and transcript_validation.get("ok") is True
    )
    return (
        inputs.get("cloneMode") == "hifi"
        and same_path(inputs.get("loraPath"), adapter_path, quality_gate_base)
        and inputs.get("requireSpeakerBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker_ok
        and adapter_ok
        and transcript_validation_ok
    )


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


def quality_gate_transcript_validation_proof_status(
    report: dict[str, Any],
    profile: Path,
    expected_profile_sha256: str,
) -> dict[str, Any]:
    report_json = report.get("json")
    quality_gate_path = (
        Path(report_json).expanduser().resolve(strict=False)
        if isinstance(report_json, str) and report_json.strip()
        else None
    )
    inputs = report.get("inputs") if isinstance(report.get("inputs"), dict) else {}
    proofs = report.get("proofs") if isinstance(report.get("proofs"), dict) else {}
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    errors: list[str] = []
    proof_paths: list[Path] = []
    proof_sha256s = quality_gate_transcript_validation_sha256s(inputs=inputs, proofs=proofs)
    actual_sha256: str | None = None
    validation_profile_sha256: Any = None
    transcript_validation_path: Path | None = None

    if quality_gate_path is None:
        errors.append("missing_quality_gate_json_path")
    else:
        proof_paths = quality_gate_transcript_validation_paths(
            inputs=inputs,
            proofs=proofs,
            paths=paths,
            quality_gate_path=quality_gate_path,
        )
        if not proof_paths:
            errors.append("missing_transcript_validation_path")
        else:
            transcript_validation_path = proof_paths[0]
            if any(path != transcript_validation_path for path in proof_paths[1:]):
                errors.append("transcript_validation_paths_disagree")

    if not proof_sha256s:
        errors.append("missing_transcript_validation_sha256")
    elif any(value != proof_sha256s[0] for value in proof_sha256s[1:]):
        errors.append("transcript_validation_sha256s_disagree")

    validation = load_json(transcript_validation_path) if transcript_validation_path else None
    if transcript_validation_path:
        actual_sha256 = file_sha256(transcript_validation_path)
        if actual_sha256 is None:
            errors.append("transcript_validation_json_missing")
        elif proof_sha256s and actual_sha256 != proof_sha256s[0]:
            errors.append("transcript_validation_sha256_mismatch")
    if transcript_validation_path and validation is None:
        errors.append("transcript_validation_json_unreadable")
    if validation:
        validation_profile_sha256 = validation.get("profileSha256")
        expected_voice_profile_id = str(_dict_field(load_json(profile)).get("voiceProfileId") or "").strip()
        validation_voice_profile_id = validation.get("voiceProfileId")
        if validation.get("status") != "pass":
            errors.append("transcript_validation_not_passing")
        if not same_path(validation.get("profile"), profile, transcript_validation_path.parent if transcript_validation_path else None):
            errors.append("transcript_validation_profile_mismatch")
        if expected_voice_profile_id:
            if not isinstance(validation_voice_profile_id, str) or not validation_voice_profile_id.strip():
                errors.append("transcript_validation_voice_profile_id_missing")
            elif validation_voice_profile_id != expected_voice_profile_id:
                errors.append("transcript_validation_voice_profile_id_stale")
        if not isinstance(validation_profile_sha256, str) or not validation_profile_sha256.strip():
            errors.append("transcript_validation_profile_sha256_missing")
        elif validation_profile_sha256 != expected_profile_sha256:
            errors.append("transcript_validation_profile_sha256_stale")
        profile_payload = load_json(profile)
        if not profile_payload:
            errors.append("profile_json_unreadable")
        elif transcript_validation_path and not transcript_validation_rows_match_profile(profile, profile_payload, transcript_validation_path, validation):
            errors.append("transcript_validation_rows_mismatch")

    return {
        "ok": not errors,
        "reason": "pass" if not errors else errors[0],
        "errors": errors,
        "transcriptValidationJson": str(transcript_validation_path) if transcript_validation_path else None,
        "transcriptValidationSha256": actual_sha256,
        "proofTranscriptValidationSha256": proof_sha256s[0] if proof_sha256s else None,
        "transcriptValidationProfileSha256": validation_profile_sha256,
        "expectedProfileSha256": expected_profile_sha256,
        "proofPaths": [str(path) for path in proof_paths],
    }


def attach_quality_gate_transcript_validation_proof(report: dict[str, Any], profile: Path) -> dict[str, Any]:
    expected_profile_sha256 = profile_sha256_for_path(profile)
    if expected_profile_sha256:
        report["transcriptValidationProof"] = quality_gate_transcript_validation_proof_status(
            report,
            profile,
            expected_profile_sha256,
        )
    return report


def quality_gate_artifact_proof_status(report: dict[str, Any], profile: Path | None = None) -> dict[str, Any]:
    report_json = report.get("json")
    quality_gate_path = (
        Path(report_json).expanduser().resolve(strict=False)
        if isinstance(report_json, str) and report_json.strip()
        else None
    )
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    proofs = report.get("proofs") if isinstance(report.get("proofs"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    errors: list[str] = []
    resolved: dict[str, dict[str, Any]] = {}

    if quality_gate_path is None:
        errors.append("missing_quality_gate_json_path")

    for key in ("report", "asr", "speaker", "score"):
        raw_path = paths.get(key)
        path = resolve_quality_gate_proof_path(raw_path, quality_gate_path) if quality_gate_path else None
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else None
        if path is None:
            errors.append(f"{key}_path_missing")
        if artifact is None:
            errors.append(f"{key}_artifact_evidence_missing")
            continue

        artifact_path = (
            resolve_quality_gate_proof_path(artifact.get("path"), quality_gate_path)
            if quality_gate_path
            else None
        )
        if artifact_path is None:
            errors.append(f"{key}_artifact_path_missing")
        elif path is not None and artifact_path != path:
            errors.append(f"{key}_artifact_path_mismatch")

        proof_sha256 = artifact.get("sha256")
        if not isinstance(proof_sha256, str) or not proof_sha256.strip():
            errors.append(f"{key}_sha256_missing")

        actual_sha256 = file_sha256(path) if path is not None else None
        if path is not None and actual_sha256 is None:
            errors.append(f"{key}_artifact_missing")
        elif isinstance(proof_sha256, str) and proof_sha256.strip() and actual_sha256 != proof_sha256:
            errors.append(f"{key}_sha256_mismatch")

        if path is not None:
            resolved[key] = {
                "path": str(path),
                "sha256": actual_sha256,
                "proofSha256": proof_sha256 if isinstance(proof_sha256, str) else None,
            }

    score_path = Path(resolved["score"]["path"]) if "score" in resolved else None
    score = load_json(score_path) if score_path else None
    if score_path and not score:
        errors.append("score_json_unreadable")
    source_report_path = Path(resolved["report"]["path"]) if "report" in resolved else None
    source_report = load_json(source_report_path) if source_report_path else None
    if source_report_path and not source_report:
        errors.append("source_report_json_unreadable")
    if source_report and source_report_path:
        render_output_errors = source_report_render_output_evidence_errors(source_report, source_report_path)
        if render_output_errors:
            errors.append("source_report_render_output_proof_missing")
            errors.extend(render_output_errors)
    score_verdict = None
    score_summary = None
    score_review_groups: list[dict[str, Any]] = []
    if score:
        score_verdict = score.get("verdict")
        score_summary = score.get("summary") if isinstance(score.get("summary"), dict) else None
        score_review_groups = quality_gate_score_review_groups(score)
        if score.get("verdict") != "pass":
            errors.append("score_verdict_not_pass")
        errors.extend(score_speaker_identity_proof_errors(score))
        expected_report = resolved.get("report")
        if expected_report:
            if not same_path(score.get("sourceReport"), Path(expected_report["path"]), score_path.parent):
                errors.append("score_source_report_path_mismatch")
            if score.get("sourceReportSha256") != expected_report.get("sha256"):
                errors.append("score_source_report_sha256_mismatch")
        expected_asr = resolved.get("asr")
        if expected_asr:
            if not same_path(score.get("asrJson"), Path(expected_asr["path"]), score_path.parent):
                errors.append("score_asr_path_mismatch")
            if score.get("asrJsonSha256") != expected_asr.get("sha256"):
                errors.append("score_asr_sha256_mismatch")
        expected_speaker = resolved.get("speaker")
        if expected_speaker:
            if not same_path(score.get("speakerJson"), Path(expected_speaker["path"]), score_path.parent):
                errors.append("score_speaker_path_mismatch")
            if score.get("speakerJsonSha256") != expected_speaker.get("sha256"):
                errors.append("score_speaker_sha256_mismatch")

    inputs = report.get("inputs") if isinstance(report.get("inputs"), dict) else {}
    profile_path = profile
    if profile_path is None and quality_gate_path is not None:
        profile_path = resolve_quality_gate_proof_path(inputs.get("profileJson"), quality_gate_path)
    profile_payload = load_json(profile_path) if profile_path else None
    if profile_path and not profile_payload:
        errors.append("profile_json_unreadable")
    if score and source_report and profile_payload:
        voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip() or None
        expected_profile_sha256 = canonical_profile_sha256(profile_payload)
        errors.extend(
            report_score_profile_evidence_errors(
                report=source_report,
                score=score,
                voice_profile_id=voice_profile_id,
                profile_sha256=expected_profile_sha256,
            )
        )
    lora_path = resolve_quality_gate_proof_path(inputs.get("loraPath"), quality_gate_path) if quality_gate_path else None
    if source_report and source_report_path and lora_path:
        errors.extend(
            source_report_lora_render_evidence_errors(
                report=source_report,
                adapter_path=lora_path,
                report_path=source_report_path,
            )
        )

    return {
        "ok": not errors,
        "reason": "pass" if not errors else errors[0],
        "errors": errors,
        "artifacts": resolved,
        "scoreVerdict": score_verdict,
        "scoreSummary": score_summary,
        "scoreReviewGroups": score_review_groups,
    }


def attach_quality_gate_artifact_proof(report: dict[str, Any], profile: Path | None = None) -> dict[str, Any]:
    report["artifactProof"] = quality_gate_artifact_proof_status(report, profile)
    return report


def attach_quality_gate_proofs(report: dict[str, Any], profile: Path) -> dict[str, Any]:
    attach_quality_gate_transcript_validation_proof(report, profile)
    attach_quality_gate_artifact_proof(report, profile)
    return report


def quality_gate_score_review_groups(score: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("verdict") == "pass":
            continue
        speaker_identity = group.get("speakerIdentity") if isinstance(group.get("speakerIdentity"), dict) else {}
        profile_reference = group.get("profileReference") if isinstance(group.get("profileReference"), dict) else {}
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        asr_samples = [
            {
                "repeat": render.get("repeat"),
                "asrTranscript": render.get("asrTranscript"),
                "scoringTarget": (render.get("scoringTarget") or {}).get("text")
                if isinstance(render.get("scoringTarget"), dict)
                else None,
            }
            for render in renders[:3]
            if isinstance(render, dict)
        ]
        rows.append(
            {
                "caseId": group.get("caseId") or (group.get("case") or {}).get("id")
                if isinstance(group.get("case"), dict)
                else group.get("caseId"),
                "cloneMode": group.get("cloneMode"),
                "verdict": group.get("verdict"),
                "pronunciationVerdict": group.get("pronunciationVerdict"),
                "speakerIdentityVerdict": group.get("speakerIdentityVerdict"),
                "profileReferenceVerdict": group.get("profileReferenceVerdict"),
                "avgCer": group.get("avgCer"),
                "avgWer": group.get("avgWer"),
                "minSpeakerSimilarityObserved": speaker_identity.get("minSpeakerSimilarityObserved"),
                "speakerReasons": speaker_identity.get("reasons"),
                "profileReference": profile_reference,
                "asrSamples": asr_samples,
            }
        )
    return rows[:10]


def quality_gate_score_review_message(artifact_proof: dict[str, Any]) -> str:
    summary = artifact_proof.get("scoreSummary") if isinstance(artifact_proof.get("scoreSummary"), dict) else {}
    parts: list[str] = []
    groups = summary.get("groups")
    passing_groups = summary.get("passingGroups")
    if isinstance(groups, int) and isinstance(passing_groups, int):
        parts.append(f"passingGroups={passing_groups}/{groups}")
    for key in (
        "speakerReviewGroups",
        "profileReferenceReviewGroups",
        "missingAsrGroups",
        "stabilityReviewGroups",
        "audioQualityReviewGroups",
    ):
        value = summary.get(key)
        if isinstance(value, int) and value:
            parts.append(f"{key}={value}")
    suffix = f": {', '.join(parts)}" if parts else ""
    return f"latest quality gate score is {artifact_proof.get('scoreVerdict') or 'not pass'}{suffix}"


def quality_gate_artifact_proof_score_not_pass(artifact_proof: dict[str, Any]) -> bool:
    errors = artifact_proof.get("errors") if isinstance(artifact_proof.get("errors"), list) else []
    return artifact_proof.get("reason") == "score_verdict_not_pass" or "score_verdict_not_pass" in errors


def latest_product_quality_gate(profile: Path, *, require_pass: bool = True) -> dict[str, Any] | None:
    root = quality_gate_root()
    expected_profile_sha256 = profile_sha256_for_path(profile)
    if not expected_profile_sha256:
        return None
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    try:
        candidates = list(root.glob("*/quality-gate.json"))
        if (root / "quality-gate.json").is_file():
            candidates.append(root / "quality-gate.json")
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        inputs = payload.get("inputs") if payload else None
        if not isinstance(payload, dict) or not isinstance(inputs, dict):
            continue
        if not same_path(inputs.get("profileJson"), profile, path.parent):
            continue
        if inputs.get("profileSha256") != expected_profile_sha256:
            continue
        if not quality_gate_full_eval_inputs(inputs):
            continue
        if inputs.get("cloneMode") != "both":
            continue
        report = {
            "json": str(path.resolve()),
            "createdAt": str(payload.get("createdAt") or ""),
            "status": payload.get("status"),
            "dryRun": payload.get("dryRun") if isinstance(payload.get("dryRun"), bool) else None,
            "inputs": inputs,
            "proofs": payload.get("proofs") if isinstance(payload.get("proofs"), dict) else None,
            "commands": payload.get("commands") if isinstance(payload.get("commands"), dict) else None,
            "paths": payload.get("paths") if isinstance(payload.get("paths"), dict) else None,
        }
        attach_quality_gate_proofs(report, profile)
        if not require_pass or product_quality_gate_passed(report):
            matches.append((str(report["createdAt"]), path.resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def latest_absolute_quality_gate(profile: Path) -> dict[str, Any] | None:
    root = quality_gate_root()
    expected_profile_sha256 = profile_sha256_for_path(profile)
    if not expected_profile_sha256:
        return None
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    try:
        candidates = list(root.glob("*/quality-gate.json"))
        if (root / "quality-gate.json").is_file():
            candidates.append(root / "quality-gate.json")
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        inputs = payload.get("inputs") if payload else None
        if not isinstance(payload, dict) or not isinstance(inputs, dict):
            continue
        if not same_path(inputs.get("profileJson"), profile, path.parent):
            continue
        if inputs.get("profileSha256") != expected_profile_sha256:
            continue
        if not quality_gate_full_eval_inputs(inputs):
            continue
        if inputs.get("cloneMode") != "hifi":
            continue
        if isinstance(inputs.get("loraPath"), str) and str(inputs.get("loraPath")).strip():
            continue
        report = {
            "json": str(path.resolve()),
            "createdAt": str(payload.get("createdAt") or ""),
            "status": payload.get("status"),
            "dryRun": payload.get("dryRun") if isinstance(payload.get("dryRun"), bool) else None,
            "inputs": inputs,
            "proofs": payload.get("proofs") if isinstance(payload.get("proofs"), dict) else None,
            "commands": payload.get("commands") if isinstance(payload.get("commands"), dict) else None,
            "paths": payload.get("paths") if isinstance(payload.get("paths"), dict) else None,
        }
        matches.append((str(report["createdAt"]), path.resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def latest_lora_quality_gate(
    profile: Path,
    adapter_path: Path,
    adapter_sha256: str,
    adapter_bytes: int,
    *,
    require_pass: bool = True,
) -> dict[str, Any] | None:
    root = quality_gate_root()
    expected_profile_sha256 = profile_sha256_for_path(profile)
    if not expected_profile_sha256:
        return None
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    try:
        candidates = list(root.glob("*/quality-gate.json"))
        if (root / "quality-gate.json").is_file():
            candidates.append(root / "quality-gate.json")
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        inputs = payload.get("inputs") if payload else None
        if not isinstance(payload, dict) or not isinstance(inputs, dict):
            continue
        if not same_path(inputs.get("profileJson"), profile, path.parent):
            continue
        if inputs.get("profileSha256") != expected_profile_sha256:
            continue
        if not quality_gate_full_eval_inputs(inputs):
            continue
        report = {
            "json": str(path.resolve()),
            "createdAt": str(payload.get("createdAt") or ""),
            "status": payload.get("status"),
            "dryRun": payload.get("dryRun") if isinstance(payload.get("dryRun"), bool) else None,
            "inputs": inputs,
            "proofs": payload.get("proofs") if isinstance(payload.get("proofs"), dict) else None,
            "commands": payload.get("commands") if isinstance(payload.get("commands"), dict) else None,
            "paths": payload.get("paths") if isinstance(payload.get("paths"), dict) else None,
        }
        attach_quality_gate_proofs(report, profile)
        if not same_path(inputs.get("loraPath"), adapter_path, path.parent):
            continue
        if not require_pass or lora_quality_gate_passed(report, adapter_path, adapter_sha256, adapter_bytes):
            matches.append((str(report["createdAt"]), path.resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def audit_quality_gate(profile: Path, report: dict[str, Any] | None = None) -> dict[str, Any]:
    report = report or latest_absolute_quality_gate(profile)
    if report:
        attach_quality_gate_proofs(report, profile)
        transcript_validation_proof = report.get("transcriptValidationProof")
        if isinstance(transcript_validation_proof, dict) and transcript_validation_proof.get("ok") is not True:
            return stage(
                "quality_gate",
                "blocked",
                "latest quality gate transcript validation proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                gateStatus=report.get("status"),
                dryRun=report.get("dryRun"),
                transcriptValidationProof=transcript_validation_proof,
            )
        artifact_proof = report.get("artifactProof")
        if isinstance(artifact_proof, dict) and artifact_proof.get("ok") is not True:
            if quality_gate_artifact_proof_score_not_pass(artifact_proof):
                return stage(
                    "quality_gate",
                    "blocked",
                    quality_gate_score_review_message(artifact_proof),
                    qualityGateJson=report.get("json"),
                    createdAt=report.get("createdAt"),
                    gateStatus=report.get("status"),
                    dryRun=report.get("dryRun"),
                    artifactProof=artifact_proof,
                )
            return stage(
                "quality_gate",
                "blocked",
                "latest quality gate artifact proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                gateStatus=report.get("status"),
                dryRun=report.get("dryRun"),
                artifactProof=artifact_proof,
            )
    if strict_profile_quality_gate_passed(report):
        return stage(
            "quality_gate",
            "pass",
            "latest matching non-dry-run quality gate passed",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
            transcriptValidationProof=report.get("transcriptValidationProof"),
            artifactProof=report.get("artifactProof"),
        )
    if report:
        return stage(
            "quality_gate",
            "blocked",
            "latest quality gate is not a usable non-dry-run strict-profile pass",
            qualityGateJson=report.get("json"),
            gateStatus=report.get("status"),
            dryRun=report.get("dryRun"),
            inputs=report.get("inputs"),
            proofs=report.get("proofs"),
        )
    return stage("quality_gate", "missing", "no matching quality-gate.json found")


def audit_product_proof(profile: Path, report: dict[str, Any] | None = None) -> dict[str, Any]:
    report = report or latest_product_quality_gate(profile)
    if report:
        return stage(
            "product_10x_proof",
            "pass",
            "paired prompt-vs-hifi product proof passed with required speaker backend",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
            transcriptValidationProof=report.get("transcriptValidationProof"),
            artifactProof=report.get("artifactProof"),
        )
    report = latest_product_quality_gate(profile, require_pass=False)
    if report:
        transcript_validation_proof = report.get("transcriptValidationProof")
        if isinstance(transcript_validation_proof, dict) and transcript_validation_proof.get("ok") is not True:
            return stage(
                "product_10x_proof",
                "blocked",
                "latest paired product quality gate transcript validation proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                transcriptValidationProof=transcript_validation_proof,
            )
        artifact_proof = report.get("artifactProof")
        if isinstance(artifact_proof, dict) and artifact_proof.get("ok") is not True:
            if quality_gate_artifact_proof_score_not_pass(artifact_proof):
                return stage(
                    "product_10x_proof",
                    "blocked",
                    quality_gate_score_review_message(artifact_proof),
                    qualityGateJson=report.get("json"),
                    createdAt=report.get("createdAt"),
                    artifactProof=artifact_proof,
                )
            return stage(
                "product_10x_proof",
                "blocked",
                "latest paired product quality gate artifact proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                artifactProof=artifact_proof,
            )
    return stage(
        "product_10x_proof",
        "missing",
        "no passing paired product quality gate with speechbrain-ecapa was found",
    )


def blind_order_key(case_id: str, repeat: int, clone_mode: str, output_wav: str) -> str:
    token = f"{case_id}\0{repeat}\0{clone_mode}\0{output_wav}".encode("utf-8")
    return hashlib.sha256(token).hexdigest()


def resolved_report_audio_path(raw_path: str, report_path: Path) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = report_path.parent / audio_path
    return audio_path.resolve()


def build_subjective_review_rounds(report: dict[str, Any], report_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rounds: dict[tuple[str, int], dict[str, Any]] = {}
    order: list[tuple[str, int]] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        case = group.get("case")
        renders = group.get("renders")
        if not isinstance(case, dict) or not isinstance(renders, list):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        if clone_mode not in {"prompt", "hifi"}:
            continue
        case_id = str(case.get("id") or "case")
        for render in renders:
            if not isinstance(render, dict):
                continue
            if render.get("status") != "ready":
                continue
            output_wav = render.get("outputWav")
            if not isinstance(output_wav, str) or not output_wav.strip():
                continue
            audio_path = resolved_report_audio_path(output_wav, report_path)
            try:
                if not audio_path.is_file() or audio_path.stat().st_size <= 0:
                    continue
            except OSError:
                continue
            repeat = int(render.get("repeat") or 1)
            key = (case_id, repeat)
            if key not in rounds:
                rounds[key] = {"caseId": case_id, "repeat": repeat, "samples": []}
                order.append(key)
            rounds[key]["samples"].append(
                {
                    "cloneMode": clone_mode or str(render.get("cloneMode") or ""),
                    "outputWav": output_wav,
                }
            )

    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result: list[dict[str, Any]] = []
    ambiguous_rounds: list[dict[str, Any]] = []
    for key in order:
        item = rounds[key]
        samples = item["samples"]
        clone_modes = {str(sample.get("cloneMode") or "") for sample in samples}
        if not {"prompt", "hifi"}.issubset(clone_modes):
            continue
        case_id = str(item["caseId"])
        repeat = int(item["repeat"])
        sample_counts = {
            "prompt": sum(1 for sample in samples if sample.get("cloneMode") == "prompt"),
            "hifi": sum(1 for sample in samples if sample.get("cloneMode") == "hifi"),
        }
        if sample_counts["prompt"] != 1 or sample_counts["hifi"] != 1:
            ambiguous_rounds.append(
                {
                    "caseId": case_id,
                    "repeat": repeat,
                    "sampleCounts": sample_counts,
                }
            )
            continue
        ordered = sorted(
            samples,
            key=lambda sample: blind_order_key(
                case_id,
                repeat,
                str(sample.get("cloneMode") or ""),
                str(sample.get("outputWav") or ""),
            ),
        )
        label_by_mode = {
            str(sample.get("cloneMode") or ""): labels[index]
            for index, sample in enumerate(ordered)
            if index < len(labels)
        }
        result.append(
            {
                "caseId": case_id,
                "repeat": repeat,
                "choiceKey": f"winner-{case_id}-r{repeat:02d}",
                "candidateLabel": label_by_mode.get("hifi"),
                "baselineLabel": label_by_mode.get("prompt"),
            }
        )
    return result, ambiguous_rounds


def review_json_candidates(product_report: dict[str, Any], report_path: Path) -> list[Path]:
    paths = product_report.get("paths") if isinstance(product_report.get("paths"), dict) else {}
    explicit = paths.get("subjectiveReview") or paths.get("review")
    candidates: list[Path] = []
    if isinstance(explicit, str) and explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.extend(
        [
            report_path.with_suffix(".review.json"),
            report_path.parent / "review.json",
            report_path.parent / "subjective-review.json",
            report_path.parent / "subjective_review.json",
        ]
    )
    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = candidate.resolve(strict=False)
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(resolved)
    return deduped


def review_choice_keys_with_value(review: dict[str, Any], value: str) -> list[str]:
    choices = review.get("choices") if isinstance(review.get("choices"), dict) else {}
    keys = [
        str(key)
        for key, choice in choices.items()
        if isinstance(key, str) and key.startswith("winner-") and choice == value
    ]
    return sorted(keys)


def latest_replacement_subjective_report(base_report_path: Path, rerender_choice_keys: list[str]) -> dict[str, Path] | None:
    if not rerender_choice_keys:
        return None
    expected_keys = set(rerender_choice_keys)
    root = quality_gate_root()
    matches: list[tuple[str, Path, Path, Path | None]] = []
    try:
        candidates = list(root.glob("*/report.json"))
    except OSError:
        return None
    for report_path in candidates:
        report_path = report_path.resolve(strict=False)
        if report_path == base_report_path.resolve(strict=False):
            continue
        report = load_json(report_path)
        if not isinstance(report, dict):
            continue
        rounds, ambiguous_rounds = build_subjective_review_rounds(report, report_path)
        if ambiguous_rounds:
            continue
        choice_keys = {str(row.get("choiceKey") or "") for row in rounds}
        if choice_keys != expected_keys:
            continue
        html_path = report_path.with_suffix(".html")
        if not html_path.is_file():
            continue
        review_path = next(
            (
                candidate
                for candidate in (
                    report_path.with_suffix(".review.json"),
                    report_path.parent / "review.json",
                    report_path.parent / "subjective-review.json",
                    report_path.parent / "subjective_review.json",
                )
                if candidate.is_file()
            ),
            None,
        )
        created_at = str(report.get("createdAt") or "")
        matches.append((created_at, report_path, html_path, review_path))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    _, report_path, html_path, review_path = matches[0]
    result = {"report": report_path, "html": html_path}
    if review_path is not None:
        result["review"] = review_path
    return result


def subjective_review_next_command(report_path: Path, review_path: Path) -> str:
    review = load_json(review_path)
    rerender_choice_keys = review_choice_keys_with_value(review, "rerender") if isinstance(review, dict) else []
    replacement = latest_replacement_subjective_report(report_path, rerender_choice_keys)
    if replacement:
        replacement_review = replacement.get("review")
        if replacement_review:
            return shell_join(
                [
                    "python3",
                    "scripts/merge_voice_subjective_reviews.py",
                    "--base-review",
                    str(review_path),
                    "--base-report",
                    str(report_path),
                    "--replacement-review",
                    str(replacement_review),
                    "--replacement-report",
                    str(replacement["report"]),
                    "--out",
                    str(report_path.with_suffix(".review.json")),
                    "--fill-missing",
                    "tie",
                ]
            )
        return shell_join(
            [
                "npm",
                "run",
                "voice:clone:review",
                "--",
                "--report-html",
                str(replacement["html"]),
                "--port",
                "8768",
            ]
        )
    return shell_join(
        [
            "python3",
            "scripts/triage_voice_subjective_review.py",
            "--review-json",
            str(review_path),
            "--report-json",
            str(report_path),
            "--out",
            str(review_path.parent / "subjective-review-triage.json"),
        ]
    )


def audit_subjective_review(product_report: dict[str, Any] | None) -> dict[str, Any]:
    if not product_report:
        return stage(
            "subjective_review",
            "missing",
            "no paired product quality gate exists, so no blind review can be audited",
        )
    paths = product_report.get("paths") if isinstance(product_report.get("paths"), dict) else {}
    report_raw = paths.get("report")
    if not isinstance(report_raw, str) or not report_raw:
        return stage("subjective_review", "missing", "product quality gate does not name a regression report")
    report_path = Path(report_raw).expanduser().resolve()
    report = load_json(report_path)
    if not report:
        return stage("subjective_review", "missing", "product regression report JSON is missing", report=str(report_path))

    candidates = review_json_candidates(product_report, report_path)
    review_path = next((candidate for candidate in candidates if candidate.exists()), None)
    if not review_path:
        return stage(
            "subjective_review",
            "missing",
            "blind A/B review JSON is missing",
            report=str(report_path),
            expectedReviewJson=[str(candidate) for candidate in candidates],
        )
    review = load_json(review_path)
    if not isinstance(review, dict):
        return stage("subjective_review", "blocked", "blind review JSON is not an object", reviewJson=str(review_path))
    expected_report_sha = file_sha256(report_path)
    review_report_sha = review.get("reportSha256")
    if not isinstance(review_report_sha, str) or not review_report_sha.strip():
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON is missing reportSha256; export it from the matching report.html",
            report=str(report_path),
            reviewJson=str(review_path),
            expectedReportSha256=expected_report_sha,
        )
    if expected_report_sha and review_report_sha.strip().lower() != expected_report_sha.lower():
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON does not match the product regression report hash",
            report=str(report_path),
            reviewJson=str(review_path),
            expectedReportSha256=expected_report_sha,
            reviewReportSha256=review_report_sha,
        )
    review_report_raw = review.get("reportPath") or review.get("report")
    if not isinstance(review_report_raw, str) or not review_report_raw.strip():
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON is missing reportPath; export it from the matching report.html",
            report=str(report_path),
            reviewJson=str(review_path),
            expectedReportSha256=expected_report_sha,
        )
    if not same_path(review_report_raw, report_path, review_path.parent):
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON does not point at the audited product regression report",
            report=str(report_path),
            reviewJson=str(review_path),
            reviewReportPath=review_report_raw,
            expectedReportPath=str(report_path),
            expectedReportSha256=expected_report_sha,
        )
    choices = review.get("choices") if isinstance(review, dict) and isinstance(review.get("choices"), dict) else None
    if not isinstance(choices, dict):
        return stage("subjective_review", "blocked", "blind review JSON does not contain choices", reviewJson=str(review_path))

    rounds, ambiguous_rounds = build_subjective_review_rounds(report, report_path)
    if ambiguous_rounds:
        return stage(
            "subjective_review",
            "blocked",
            "product regression report has ambiguous prompt-vs-hifi blind rounds",
            report=str(report_path),
            reviewJson=str(review_path),
            ambiguousRounds=ambiguous_rounds,
        )
    if not rounds:
        return stage(
            "subjective_review",
            "blocked",
            "product regression report has no prompt-vs-hifi blind rounds",
            report=str(report_path),
            reviewJson=str(review_path),
        )

    selected_scope = review.get("reviewScope") == "selected"
    minimum_reviewed_rounds = min(7, len(rounds)) if selected_scope else len(rounds)
    declared_minimum = review.get("minimumReviewedRounds")
    if selected_scope and declared_minimum != minimum_reviewed_rounds:
        return stage(
            "subjective_review",
            "blocked",
            "selected blind review JSON has the wrong minimumReviewedRounds",
            report=str(report_path),
            reviewJson=str(review_path),
            expectedMinimumReviewedRounds=minimum_reviewed_rounds,
            reviewMinimumReviewedRounds=declared_minimum,
        )

    candidate_wins = 0
    baseline_wins = 0
    ties = 0
    rerenders = 0
    missing_choices: list[str] = []
    invalid_choices: list[dict[str, Any]] = []
    reviewed = 0
    for round_item in rounds:
        key = str(round_item["choiceKey"])
        value = choices.get(key)
        if not isinstance(value, str) or not value:
            if not selected_scope:
                missing_choices.append(key)
            continue
        reviewed += 1
        if value == "rerender":
            rerenders += 1
        elif value == "tie":
            ties += 1
        elif value == round_item.get("candidateLabel"):
            candidate_wins += 1
        elif value == round_item.get("baselineLabel"):
            baseline_wins += 1
        else:
            invalid_choices.append({"choiceKey": key, "value": value})

    if selected_scope and reviewed < minimum_reviewed_rounds:
        for round_item in rounds:
            key = str(round_item["choiceKey"])
            value = choices.get(key)
            if not isinstance(value, str) or not value:
                missing_choices.append(key)
            if len(missing_choices) >= minimum_reviewed_rounds - reviewed:
                break
    total_report_rounds = len(rounds)
    total = reviewed if selected_scope else total_report_rounds
    candidate_win_rate = candidate_wins / total if total else 0
    stats = {
        "rounds": total,
        "reviewedRounds": reviewed,
        "candidateWins": candidate_wins,
        "baselineWins": baseline_wins,
        "ties": ties,
        "rerenders": rerenders,
        "candidateWinRate": round(candidate_win_rate, 4),
        "minCandidateWinRate": 0.8,
        "reportSha256": expected_report_sha,
    }
    if selected_scope:
        stats["totalReportRounds"] = total_report_rounds
        stats["minimumReviewedRounds"] = minimum_reviewed_rounds
    if missing_choices or invalid_choices or rerenders:
        return stage(
            "subjective_review",
            "blocked",
            "blind A/B review is incomplete or asks for rerender",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
            missingChoices=missing_choices,
            invalidChoices=invalid_choices,
        )
    if baseline_wins > candidate_wins:
        return stage(
            "subjective_review",
            "blocked",
            "baseline was preferred over the hifi candidate in blind review",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
        )
    review_reasons = review.get("reasons") if isinstance(review.get("reasons"), list) else []
    legacy_preference_only_review = (
        review.get("status") == "review"
        and review_reasons
        and all(reason == "subjective_review_candidate_win_rate_below_threshold" for reason in review_reasons)
    )
    if review.get("status") != "pass" and not legacy_preference_only_review:
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON must declare status='pass' after export",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
            reviewStatus=review.get("status"),
        )
    declared_stats = review.get("stats") if isinstance(review.get("stats"), dict) else None
    if not isinstance(declared_stats, dict):
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON is missing exported stats",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
        )
    stat_mismatches: list[dict[str, Any]] = []
    for key, expected in stats.items():
        actual = declared_stats.get(key)
        if actual != expected:
            stat_mismatches.append({"field": key, "expected": expected, "actual": actual})
    if stat_mismatches:
        return stage(
            "subjective_review",
            "blocked",
            "blind review JSON stats do not match recomputed review state",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
            reviewStats=declared_stats,
            statMismatches=stat_mismatches,
        )
    return stage(
        "subjective_review",
        "pass",
        "subjective blind A/B review passed the no-regression bar",
        report=str(report_path),
        reviewJson=str(review_path),
        stats=stats,
    )


def latest_matching_json(root: Path, pattern: str, predicate: Any) -> tuple[Path, dict[str, Any]] | None:
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    try:
        candidates = list(root.glob(pattern))
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        if not payload or not predicate(payload, path):
            continue
        matches.append((str(payload.get("createdAt") or path.stat().st_mtime), path.resolve(), payload))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    _, path, payload = matches[0]
    return path, payload


def _dict_field(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def artifact_profile_binding_rank(payload: dict[str, Any], profile: Path) -> int:
    profile_payload = load_json(profile)
    if not profile_payload:
        return 2
    expected_voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip()
    expected_profile_sha256 = canonical_profile_sha256(profile_payload)
    nested_profile = _dict_field(payload.get("voiceProfile"))
    dataset_proofs = _dict_field(payload.get("datasetProofs"))
    proof_metadata = _dict_field(payload.get("proofs"))
    voice_profile_ids = [
        str(value).strip()
        for value in [
            payload.get("voiceProfileId"),
            nested_profile.get("voiceProfileId"),
        ]
        if isinstance(value, str) and str(value).strip()
    ]
    profile_sha256s = [
        str(value).strip()
        for value in [
            payload.get("profileSha256"),
            nested_profile.get("profileSha256"),
            dataset_proofs.get("profileSha256"),
            proof_metadata.get("profileSha256"),
        ]
        if isinstance(value, str) and str(value).strip()
    ]
    if any(value != expected_voice_profile_id for value in voice_profile_ids if expected_voice_profile_id):
        return 3
    if any(value != expected_profile_sha256 for value in profile_sha256s):
        return 3
    if expected_voice_profile_id and expected_voice_profile_id in voice_profile_ids and expected_profile_sha256 in profile_sha256s:
        return 0
    if expected_voice_profile_id and expected_voice_profile_id in voice_profile_ids:
        return 1
    if expected_profile_sha256 in profile_sha256s:
        return 1
    return 2


def latest_profile_matching_json(root: Path, pattern: str, profile: Path, predicate: Any) -> tuple[Path, dict[str, Any]] | None:
    matches: list[tuple[int, str, Path, dict[str, Any]]] = []
    try:
        candidates = list(root.glob(pattern))
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        if not payload or not predicate(payload, path):
            continue
        matches.append((artifact_profile_binding_rank(payload, profile), str(payload.get("createdAt") or path.stat().st_mtime), path.resolve(), payload))
    if not matches:
        return None
    matches.sort(key=lambda row: row[1], reverse=True)
    matches.sort(key=lambda row: row[0])
    _rank, _created_at, path, payload = matches[0]
    return path, payload


def audit_lora_dataset(profile: Path, root: Path) -> dict[str, Any]:
    match = latest_profile_matching_json(
        root,
        "**/dataset.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    if not match:
        return stage("lora_dataset", "missing", "no LoRA dataset export found", root=str(root))
    path, payload = match
    proofs = payload.get("proofs") if isinstance(payload.get("proofs"), dict) else {}
    bypass = proofs.get("bypass") if isinstance(proofs.get("bypass"), dict) else {}
    transcript_json = proofs.get("transcriptValidationJson")
    quality_json = proofs.get("qualityGateJson")
    transcript_path = resolve_config_path(transcript_json, path.parent)
    quality_path = resolve_config_path(quality_json, path.parent)
    quality_gate_report: dict[str, Any] | None = None
    if quality_path and quality_path.exists():
        quality_payload = load_json(quality_path)
        if isinstance(quality_payload, dict):
            quality_gate_report = {
                "json": str(quality_path),
                "createdAt": str(quality_payload.get("createdAt") or ""),
                "status": quality_payload.get("status"),
                "dryRun": quality_payload.get("dryRun") if isinstance(quality_payload.get("dryRun"), bool) else None,
                "inputs": quality_payload.get("inputs") if isinstance(quality_payload.get("inputs"), dict) else None,
                "proofs": quality_payload.get("proofs") if isinstance(quality_payload.get("proofs"), dict) else None,
                "commands": quality_payload.get("commands") if isinstance(quality_payload.get("commands"), dict) else None,
                "paths": quality_payload.get("paths") if isinstance(quality_payload.get("paths"), dict) else None,
            }
            attach_quality_gate_proofs(quality_gate_report, profile)
    product_quality_gate_ok = bool(
        quality_gate_report
        and isinstance(quality_gate_report.get("inputs"), dict)
        and quality_path
        and same_path(quality_gate_report["inputs"].get("profileJson"), profile, quality_path.parent)
        and quality_gate_profile_sha_matches(quality_gate_report["inputs"], profile)
        and product_quality_gate_passed(quality_gate_report)
    )
    dataset_validation: dict[str, Any] | None = None
    dataset_proof_validation: dict[str, Any] | None = None
    dataset_validation_error: str | None = None
    try:
        dataset_validation = validate_lora_dataset_files(
            dataset_path=path,
            min_clips=PRODUCT_CAPTURE_CLIPS,
            min_total_duration_sec=PRODUCT_CAPTURE_DURATION_SEC,
            require_val=True,
        )
        dataset_proof_validation = validate_lora_dataset_proofs(
            dataset=dataset_validation["dataset"],
            dataset_path=path,
            all_rows=dataset_validation["allRows"],
            allow_unsafe_dataset=False,
            unsafe_dataset_reason="",
        )
    except SystemExit as exc:
        dataset_validation_error = str(exc)
    ok = (
        dataset_validation is not None
        and dataset_proof_validation is not None
        and transcript_path is not None
        and transcript_path.exists()
        and quality_path is not None
        and quality_path.exists()
        and product_quality_gate_ok
        and bypass.get("unsafeExport") is not True
        and isinstance(payload.get("totalClips"), int)
        and int(payload.get("totalClips")) >= PRODUCT_CAPTURE_CLIPS
        and isinstance(payload.get("totalDurationSec"), (int, float))
        and float(payload.get("totalDurationSec")) >= PRODUCT_CAPTURE_DURATION_SEC
    )
    return stage(
        "lora_dataset",
        "pass" if ok else "blocked",
        "LoRA dataset handoff is ready"
        if ok
        else "LoRA dataset exists but manifests, row hashes, proof metadata, or 10-clip capture depth are incomplete",
        datasetJson=str(path),
        totalClips=len(dataset_validation["allRows"]) if dataset_validation else payload.get("totalClips"),
        totalDurationSec=round(float(dataset_validation["totalDurationSec"]), 3) if dataset_validation else payload.get("totalDurationSec"),
        recommendedClips=PRODUCT_CAPTURE_CLIPS,
        recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
        proofs=proofs,
        transcriptValidationJson=str(transcript_path) if transcript_path else None,
        qualityGateJson=str(quality_path) if quality_path else None,
        datasetProofValidation=dataset_proof_validation,
        datasetValidationError=dataset_validation_error,
        productQualityGateOk=product_quality_gate_ok,
    )


def training_config_dataset_json(path: Path, payload: dict[str, Any]) -> Path | None:
    raw = payload.get("datasetJson")
    if not isinstance(raw, str) or not raw.strip():
        dataset = payload.get("dataset") if isinstance(payload.get("dataset"), dict) else {}
        raw = dataset.get("json")
    return resolve_config_path(raw, path.parent)


def config_path_matches(raw: Any, expected: Any, base_dir: Path) -> bool:
    actual = resolve_config_path(raw, base_dir)
    if actual is None or not isinstance(expected, str) or not expected.strip():
        return False
    return actual == Path(expected).expanduser().resolve()


def config_path_matches_path(raw: Any, expected: Path, base_dir: Path) -> bool:
    actual = resolve_config_path(raw, base_dir)
    return actual is not None and actual == expected.expanduser().resolve()


def training_dataset_binding_status(path: Path, payload: dict[str, Any], profile: Path) -> dict[str, Any]:
    errors: list[str] = []
    dataset_validation: dict[str, Any] | None = None
    dataset_proof_validation: dict[str, Any] | None = None
    validation_error: str | None = None
    dataset_path = training_config_dataset_json(path, payload)
    if dataset_path is None:
        errors.append("missing_dataset_json")
    else:
        try:
            dataset_validation = validate_lora_dataset_files(
                dataset_path=dataset_path,
                min_clips=PRODUCT_CAPTURE_CLIPS,
                min_total_duration_sec=PRODUCT_CAPTURE_DURATION_SEC,
                require_val=True,
            )
            dataset_proof_validation = validate_lora_dataset_proofs(
                dataset=dataset_validation["dataset"],
                dataset_path=dataset_path,
                all_rows=dataset_validation["allRows"],
                allow_unsafe_dataset=False,
                unsafe_dataset_reason="",
            )
        except SystemExit as exc:
            validation_error = str(exc)
            errors.append("dataset_validation_failed")

    dataset_payload = dataset_validation["dataset"] if dataset_validation else {}
    if dataset_payload and dataset_path is not None and not same_path(dataset_payload.get("profilePath"), profile, dataset_path.parent):
        errors.append("dataset_profile_mismatch")

    config_proofs = payload.get("datasetProofs") if isinstance(payload.get("datasetProofs"), dict) else {}
    if not config_proofs:
        errors.append("missing_dataset_proofs")
    if dataset_proof_validation:
        for key in ("profileSha256", "transcriptValidationSha256", "qualityGateSha256"):
            if config_proofs.get(key) != dataset_proof_validation.get(key):
                errors.append(f"datasetProofs.{key}_mismatch")
        for key in ("transcriptValidationJson", "qualityGateJson"):
            if not config_path_matches(config_proofs.get(key), dataset_proof_validation.get(key), path.parent):
                errors.append(f"datasetProofs.{key}_mismatch")
        if config_proofs.get("acceptedUnsafeDataset") is not False:
            errors.append("datasetProofs.acceptedUnsafeDataset_mismatch")
        if config_proofs.get("productProofQualityGateRequired") is not True:
            errors.append("datasetProofs.productProofQualityGateRequired_mismatch")

    dataset_summary = payload.get("dataset") if isinstance(payload.get("dataset"), dict) else {}
    if dataset_validation:
        config_manifests = payload.get("manifests") if isinstance(payload.get("manifests"), dict) else {}
        for key, validation_key in (
            ("train", "trainManifest"),
            ("val", "valManifest"),
            ("all", "allManifest"),
        ):
            expected_manifest = dataset_validation.get(validation_key)
            if not isinstance(expected_manifest, Path) or not config_path_matches_path(config_manifests.get(key), expected_manifest, path.parent):
                errors.append(f"manifests.{key}_mismatch")
        if dataset_summary.get("trainClips") != len(dataset_validation["trainRows"]):
            errors.append("dataset.trainClips_mismatch")
        if dataset_summary.get("valClips") != len(dataset_validation["valRows"]):
            errors.append("dataset.valClips_mismatch")
        if dataset_summary.get("totalClips") != len(dataset_validation["allRows"]):
            errors.append("dataset.totalClips_mismatch")
        for key, validation_key in (
            ("trainDurationSec", "trainDurationSec"),
            ("valDurationSec", "valDurationSec"),
        ):
            declared_duration = dataset_summary.get(key)
            if (
                not isinstance(declared_duration, (int, float))
                or abs(float(declared_duration) - float(dataset_validation[validation_key])) > 0.001
            ):
                errors.append(f"dataset.{key}_mismatch")
        declared_duration = dataset_summary.get("totalDurationSec")
        if not isinstance(declared_duration, (int, float)) or abs(float(declared_duration) - float(dataset_validation["totalDurationSec"])) > 0.001:
            errors.append("dataset.totalDurationSec_mismatch")

    return {
        "ok": not errors,
        "errors": errors,
        "datasetJson": str(dataset_path) if dataset_path else None,
        "datasetProofValidation": dataset_proof_validation,
        "datasetValidationError": validation_error,
    }


def audit_lora_training_job(profile: Path, root: Path) -> dict[str, Any]:
    match = latest_profile_matching_json(
        root,
        "**/train_config.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    if not match:
        return stage("lora_training_job", "missing", "no LoRA training job config found", root=str(root))
    path, payload = match
    lora = payload.get("lora") if isinstance(payload.get("lora"), dict) else {}
    trainer = payload.get("trainer") if isinstance(payload.get("trainer"), dict) else {}
    adapter_proof = lora.get("adapterProof")
    proof_path = resolve_config_path(adapter_proof, path.parent)
    proof = load_json(proof_path) if proof_path else None
    proof_status = str(proof.get("status") or "") if proof else ""
    dataset_binding = training_dataset_binding_status(path, payload, profile)
    env_trainer_template = str(os.environ.get("ANYVOICE_VOXCPM_TRAINER_COMMAND") or "").strip()
    config_trainer_template = trainer.get("commandTemplate") if isinstance(trainer.get("commandTemplate"), str) else ""
    env_trainer_command = bool(env_trainer_template)
    config_trainer_command = bool(str(config_trainer_template).strip())
    trainer_validation_error: str | None = None
    trainer_resolution_error: str | None = None
    trainer_resolution: dict[str, Any] | None = None
    env_trainer_valid = False
    config_trainer_valid = False
    env_trainer_template_valid = False
    config_trainer_template_valid = False
    manifests = payload.get("manifests") if isinstance(payload.get("manifests"), dict) else {}
    output_dir = resolve_config_path(trainer.get("outputDir"), path.parent)
    adapter_path = resolve_config_path(lora.get("expectedWeights"), path.parent)
    train_manifest = resolve_config_path(manifests.get("train"), path.parent)
    val_manifest = resolve_config_path(manifests.get("val"), path.parent)

    def validate_configured_trainer_command(template: str, source: str) -> bool:
        nonlocal trainer_validation_error, trainer_resolution_error, trainer_resolution
        try:
            validate_trainer_command_template(template, source=source)
        except SystemExit as exc:
            trainer_validation_error = trainer_validation_error or str(exc)
            return False
        if not (output_dir and adapter_path and train_manifest and val_manifest):
            trainer_resolution_error = trainer_resolution_error or "train config is missing command path context"
            return False
        resolution = validate_trainer_command_resolution(
            template,
            config=path,
            output_dir=output_dir,
            adapter_path=adapter_path,
            train_manifest=train_manifest,
            val_manifest=val_manifest,
            base_dir=path.parent,
            source=source,
        )
        trainer_resolution = resolution
        if resolution.get("status") != "pass":
            errors = resolution.get("errors") if isinstance(resolution.get("errors"), list) else []
            trainer_resolution_error = trainer_resolution_error or ", ".join(str(error) for error in errors)
            return False
        return True

    if env_trainer_command:
        try:
            validate_trainer_command_template(env_trainer_template, source="env:ANYVOICE_VOXCPM_TRAINER_COMMAND")
            env_trainer_template_valid = True
        except SystemExit:
            env_trainer_template_valid = False
        env_trainer_valid = validate_configured_trainer_command(
            env_trainer_template,
            "env:ANYVOICE_VOXCPM_TRAINER_COMMAND",
        )
    if config_trainer_command:
        try:
            validate_trainer_command_template(config_trainer_template, source="train_config.trainer.commandTemplate")
            config_trainer_template_valid = True
        except SystemExit:
            config_trainer_template_valid = False
        config_trainer_valid = validate_configured_trainer_command(
            config_trainer_template,
            "train_config.trainer.commandTemplate",
        )
    trainer_ready = trainer.get("status") == "ready" and config_trainer_valid
    command_configured = config_trainer_command or env_trainer_command
    command_valid = trainer_ready or env_trainer_valid
    command_template_valid = (
        (config_trainer_command and config_trainer_template_valid)
        or (env_trainer_command and env_trainer_template_valid)
    )
    if proof_status in {"pass", "metadata_pass"}:
        proof_binding_errors: list[str] = []
        if not same_path(proof.get("trainConfig"), path, proof_path.parent if proof_path else None):
            proof_binding_errors.append("train_config_mismatch")
        expected_train_config_sha256 = file_sha256(path)
        if proof.get("trainConfigSha256") != expected_train_config_sha256:
            proof_binding_errors.append("train_config_sha256_mismatch")
        if not same_path(proof.get("profilePath"), profile, proof_path.parent if proof_path else None):
            proof_binding_errors.append("profile_path_mismatch")
        if proof_binding_errors:
            return stage(
                "lora_training_job",
                "blocked",
                "LoRA training job adapter proof does not match the current training config or audited profile",
                trainConfig=str(path),
                trainerStatus=trainer.get("status"),
                trainerCommandConfigured=command_configured,
                trainerCommandValid=command_template_valid,
                trainerCommandResolved=command_valid,
                trainerCommandResolution=trainer_resolution,
                trainScript=trainer.get("trainScript"),
                expectedWeights=lora.get("expectedWeights"),
                adapterProof=str(proof_path) if proof_path else None,
                adapterProofStatus=proof_status,
                adapterProofBindingErrors=proof_binding_errors,
                proofTrainConfig=proof.get("trainConfig"),
                proofTrainConfigSha256=proof.get("trainConfigSha256"),
                expectedTrainConfigSha256=expected_train_config_sha256,
                proofProfileJson=proof.get("profilePath"),
            )
    if dataset_binding["ok"] is not True:
        return stage(
            "lora_training_job",
            "blocked",
            "LoRA training job dataset proof metadata does not match the current dataset/profile evidence",
            trainConfig=str(path),
            datasetJson=dataset_binding.get("datasetJson"),
            datasetBindingErrors=dataset_binding["errors"],
            datasetProofValidation=dataset_binding.get("datasetProofValidation"),
            datasetValidationError=dataset_binding.get("datasetValidationError"),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainerCommandValid=command_template_valid,
            trainerCommandResolved=command_valid,
            trainerCommandResolution=trainer_resolution,
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
            adapterProofStatus=proof_status or None,
        )
    if proof_status == "pass":
        return stage(
            "lora_training_job",
            "pass",
            "LoRA training job has readable adapter proof evidence",
            trainConfig=str(path),
            datasetJson=dataset_binding.get("datasetJson"),
            datasetProofValidation=dataset_binding.get("datasetProofValidation"),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainerCommandValid=command_valid,
            trainerCommandResolution=trainer_resolution,
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
            adapterProofStatus=proof_status,
        )
    if proof_status == "metadata_pass":
        return stage(
            "lora_training_job",
            "partial",
            "LoRA training job has metadata-only adapter proof; readable checkpoint verification is still required",
            trainConfig=str(path),
            datasetJson=dataset_binding.get("datasetJson"),
            datasetProofValidation=dataset_binding.get("datasetProofValidation"),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainerCommandValid=command_valid,
            trainerCommandResolution=trainer_resolution,
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
            adapterProofStatus=proof_status,
        )
    if command_configured and command_valid:
        return stage(
            "lora_training_job",
            "pass",
            "LoRA training job is ready to run",
            trainConfig=str(path),
            datasetJson=dataset_binding.get("datasetJson"),
            datasetProofValidation=dataset_binding.get("datasetProofValidation"),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainerCommandValid=True,
            trainerCommandResolution=trainer_resolution,
            trainerCommandSource="env:ANYVOICE_VOXCPM_TRAINER_COMMAND" if env_trainer_command and not trainer_ready else "train_config",
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
        )
    if command_configured and not command_valid:
        return stage(
            "lora_training_job",
            "blocked",
            "LoRA training job has a trainer command, but the command template is invalid",
            trainConfig=str(path),
            datasetJson=dataset_binding.get("datasetJson"),
            datasetProofValidation=dataset_binding.get("datasetProofValidation"),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=True,
            trainerCommandValid=False,
            trainerCommandValidationError=trainer_validation_error,
            trainerCommandResolutionError=trainer_resolution_error,
            trainerCommandResolution=trainer_resolution,
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
            adapterProofStatus=proof_status or None,
        )
    return stage(
        "lora_training_job",
        "blocked",
        "LoRA training job exists but has no trainer command or adapter proof",
        trainConfig=str(path),
        datasetJson=dataset_binding.get("datasetJson"),
        datasetProofValidation=dataset_binding.get("datasetProofValidation"),
        trainerStatus=trainer.get("status"),
        trainerCommandConfigured=False,
        trainScript=trainer.get("trainScript"),
        expectedWeights=lora.get("expectedWeights"),
        adapterProof=str(proof_path) if proof_path else None,
        adapterProofStatus=proof_status or None,
    )


def audit_lora_adapter(profile: Path, training_root: Path) -> dict[str, Any]:
    training = latest_profile_matching_json(
        training_root,
        "**/train_config.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    if not training:
        return stage("lora_adapter", "missing", "no training job exists, so no adapter proof can be checked")
    config_path, config = training
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    proof_path = resolve_config_path(lora.get("adapterProof"), config_path.parent)
    if not proof_path:
        return stage("lora_adapter", "missing", "training config does not name adapterProof")
    proof = load_json(proof_path)
    if not proof:
        return stage("lora_adapter", "missing", "adapter proof JSON is missing", adapterProof=str(proof_path))
    status = str(proof.get("status") or "")
    if status in {"pass", "metadata_pass"}:
        expected_train_config_sha256 = file_sha256(config_path)
        if not same_path(proof.get("trainConfig"), config_path, proof_path.parent):
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof does not match the current training config",
                adapterProof=str(proof_path),
                trainConfig=str(config_path),
                proofTrainConfig=proof.get("trainConfig"),
            )
        if proof.get("trainConfigSha256") != expected_train_config_sha256:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof train config hash no longer matches the current training config",
                adapterProof=str(proof_path),
                trainConfig=str(config_path),
                proofTrainConfigSha256=proof.get("trainConfigSha256"),
                expectedTrainConfigSha256=expected_train_config_sha256,
            )
    if status == "pass":
        checkpoint = proof.get("checkpoint") if isinstance(proof.get("checkpoint"), dict) else {}
        if checkpoint.get("status") != "readable":
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof is marked pass but does not include readable checkpoint inspection evidence",
                adapterProof=str(proof_path),
                checkpoint=checkpoint,
            )
        lora_key_count = checkpoint.get("loraParameterKeyCount")
        if not isinstance(lora_key_count, int) or lora_key_count <= 0:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof is marked pass but does not include positive LoRA parameter key evidence",
                adapterProof=str(proof_path),
                checkpoint=checkpoint,
            )
        proofs = proof.get("datasetProofs") if isinstance(proof.get("datasetProofs"), dict) else {}
        if proofs.get("productProofQualityGateRequired") is not True:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof does not preserve paired product-proof dataset evidence",
                adapterProof=str(proof_path),
            )
        expected_profile_sha256 = profile_sha256_for_path(profile)
        if proofs.get("profileSha256") != expected_profile_sha256:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof dataset profile hash does not match the audited voice profile",
                adapterProof=str(proof_path),
                proofProfileSha256=proofs.get("profileSha256"),
                expectedProfileSha256=expected_profile_sha256,
            )
        if not same_path(proof.get("profilePath"), profile, proof_path.parent):
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof does not match the audited voice profile",
                adapterProof=str(proof_path),
                profileJson=str(profile),
                proofProfileJson=proof.get("profilePath"),
            )
        adapter_path = adapter_path_from_proof_or_config(proof, config, config_path.parent, proof_path.parent)
        if not adapter_path:
            return stage("lora_adapter", "blocked", "adapter proof does not name a LoRA adapter path", adapterProof=str(proof_path))
        if not adapter_path.exists() or not adapter_path.is_file():
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof points at a missing LoRA adapter file",
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
            )
        adapter = proof.get("adapter") if isinstance(proof.get("adapter"), dict) else {}
        expected_bytes = adapter.get("bytes")
        actual_bytes = adapter_path.stat().st_size
        if not isinstance(expected_bytes, int) or expected_bytes <= 0:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof must include a positive adapter byte count",
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
                actualBytes=actual_bytes,
            )
        if expected_bytes != actual_bytes:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter file byte count no longer matches adapter proof",
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
                expectedBytes=expected_bytes,
                actualBytes=actual_bytes,
            )
        expected_sha = adapter.get("sha256")
        actual_sha = file_sha256(adapter_path)
        if not isinstance(expected_sha, str) or not expected_sha:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof must include adapter SHA-256",
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
                actualSha256=actual_sha,
            )
        if actual_sha != expected_sha:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter file SHA-256 no longer matches adapter proof",
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
                expectedSha256=expected_sha,
                actualSha256=actual_sha,
            )
        return stage(
            "lora_adapter",
            "pass",
            "readable LoRA adapter proof passed and matches the current adapter file",
            adapterProof=str(proof_path),
            adapterPath=str(adapter_path),
            adapterSha256=actual_sha,
        )
    if status == "metadata_pass":
        return stage(
            "lora_adapter",
            "partial",
            "adapter metadata passed, but checkpoint tensor keys were not inspected",
            adapterProof=str(proof_path),
            warnings=proof.get("warnings"),
        )
    return stage("lora_adapter", "blocked", "adapter proof is not passing", adapterProof=str(proof_path), adapterStatus=status)


def adapter_path_from_proof_or_config(
    proof: dict[str, Any] | None,
    config: dict[str, Any],
    config_dir: Path,
    proof_dir: Path | None = None,
) -> Path | None:
    adapter = proof.get("adapter") if proof and isinstance(proof.get("adapter"), dict) else {}
    raw_path = adapter.get("path") if isinstance(adapter, dict) else None
    if isinstance(raw_path, str) and raw_path.strip():
        path = Path(raw_path).expanduser()
        if not path.is_absolute() and proof_dir is not None:
            path = proof_dir / path
        return path.resolve()
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    return resolve_config_path(lora.get("expectedWeights"), config_dir)


def profile_lora_adapter_policy_status(
    profile_path: Path,
    *,
    adapter_path: Path,
    adapter_sha256: str,
    adapter_bytes: int,
    adapter_proof_path: Path,
    quality_gate_path: Path,
    train_config_path: Path,
) -> dict[str, Any]:
    profile = load_json(profile_path)
    policy = profile.get("loraAdapter") if isinstance(profile, dict) else None
    if not isinstance(policy, dict):
        return {
            "ok": False,
            "reason": "missing_lora_adapter_policy",
        }
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip() if isinstance(profile, dict) else ""
    errors: list[str] = []
    profile_base = profile_path.parent
    if profile.get("loraPath") is None or not same_path(profile.get("loraPath"), adapter_path, profile_base):
        errors.append("profile_lora_path_mismatch")
    if policy.get("status") != "accepted":
        errors.append("policy_status_not_accepted")
    if policy.get("voiceProfileId") != voice_profile_id:
        errors.append("voice_profile_id_mismatch")
    if not same_path(policy.get("profileJson"), profile_path, profile_base):
        errors.append("profile_path_mismatch")
    if policy.get("profileSha256") != canonical_profile_sha256(profile):
        errors.append("profile_sha256_mismatch")
    if not same_path(policy.get("path"), adapter_path, profile_base):
        errors.append("adapter_path_mismatch")
    if policy.get("bytes") != adapter_bytes:
        errors.append("adapter_bytes_mismatch")
    if policy.get("sha256") != adapter_sha256:
        errors.append("adapter_sha256_mismatch")
    if not same_path(policy.get("adapterProofJson"), adapter_proof_path, profile_base):
        errors.append("adapter_proof_path_mismatch")
    if policy.get("adapterProofSha256") != file_sha256(adapter_proof_path):
        errors.append("adapter_proof_sha256_mismatch")
    if not same_path(policy.get("qualityGateJson"), quality_gate_path, profile_base):
        errors.append("quality_gate_path_mismatch")
    if policy.get("qualityGateSha256") != file_sha256(quality_gate_path):
        errors.append("quality_gate_sha256_mismatch")
    quality_gate = load_json(quality_gate_path)
    if "qualityGateProof" in policy and (
        not quality_gate
        or not lora_quality_gate_summary_matches_gate(
            policy.get("qualityGateProof"),
            quality_gate,
            profile_base,
            quality_gate_path.parent,
        )
    ):
        errors.append("quality_gate_proof_summary_mismatch")
    if not same_path(policy.get("trainConfig"), train_config_path, profile_base):
        errors.append("train_config_path_mismatch")
    if policy.get("trainConfigSha256") != file_sha256(train_config_path):
        errors.append("train_config_sha256_mismatch")
    return {
        "ok": not errors,
        "reason": "pass" if not errors else "policy_does_not_match_current_lora_evidence",
        "errors": errors,
        "policy": policy,
    }


def audit_lora_quality_gate(profile: Path, training_root: Path) -> dict[str, Any]:
    training = latest_profile_matching_json(
        training_root,
        "**/train_config.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    if not training:
        return stage("lora_quality_gate", "missing", "no training job exists, so no LoRA quality gate can be checked")
    config_path, config = training
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    proof_path = resolve_config_path(lora.get("adapterProof"), config_path.parent)
    proof = load_json(proof_path) if proof_path else None
    if not proof or proof.get("status") != "pass":
        return stage(
            "lora_quality_gate",
            "missing",
            "readable adapter proof must pass before LoRA quality can be measured",
            adapterProof=str(proof_path) if proof_path else None,
        )
    adapter_path = adapter_path_from_proof_or_config(proof, config, config_path.parent, proof_path.parent if proof_path else None)
    if not adapter_path:
        return stage("lora_quality_gate", "missing", "adapter path is missing from proof and training config")
    adapter = proof.get("adapter") if isinstance(proof.get("adapter"), dict) else {}
    adapter_sha256 = adapter.get("sha256") if isinstance(adapter.get("sha256"), str) else None
    adapter_bytes = adapter.get("bytes") if isinstance(adapter.get("bytes"), int) else None
    if not adapter_sha256 or adapter_bytes is None:
        return stage(
            "lora_quality_gate",
            "missing",
            "adapter proof must include byte count and SHA-256 before LoRA quality can be measured",
            adapterProof=str(proof_path) if proof_path else None,
        )
    report = latest_lora_quality_gate(profile, adapter_path, adapter_sha256, adapter_bytes)
    if report:
        report_json = report.get("json")
        report_path = Path(str(report_json)).expanduser().resolve(strict=False) if isinstance(report_json, str) else None
        policy_status = (
            profile_lora_adapter_policy_status(
                profile,
                adapter_path=adapter_path,
                adapter_sha256=adapter_sha256,
                adapter_bytes=adapter_bytes,
                adapter_proof_path=proof_path,
                quality_gate_path=report_path,
                train_config_path=config_path,
            )
            if report_path
            else {"ok": False, "reason": "missing_quality_gate_json_path"}
        )
        if not policy_status.get("ok"):
            return stage(
                "lora_quality_gate",
                "blocked",
                "verified LoRA adapter quality gate has not been applied to the audited voice profile",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                adapterProof=str(proof_path),
                adapterPath=str(adapter_path),
                adapterSha256=adapter_sha256,
                loraAdapterPolicy=policy_status,
                applyCommand=shell_join(
                    [
                        "python3",
                        "scripts/apply_voxcpm_lora_adapter.py",
                        str(proof_path),
                        "--quality-gate-json",
                        str(report_path) if report_path else str(report.get("json")),
                        "--profile-json",
                        str(profile),
                    ]
                ),
            )
        return stage(
            "lora_quality_gate",
            "pass",
            "LoRA adapter quality gate passed with the verified adapter file loaded",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
            adapterPath=str(adapter_path),
            adapterSha256=adapter_sha256,
            transcriptValidationProof=report.get("transcriptValidationProof"),
            artifactProof=report.get("artifactProof"),
            loraAdapterPolicy=policy_status.get("policy"),
        )
    report = latest_lora_quality_gate(profile, adapter_path, adapter_sha256, adapter_bytes, require_pass=False)
    if report:
        transcript_validation_proof = report.get("transcriptValidationProof")
        if isinstance(transcript_validation_proof, dict) and transcript_validation_proof.get("ok") is not True:
            return stage(
                "lora_quality_gate",
                "blocked",
                "latest LoRA quality gate transcript validation proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                adapterPath=str(adapter_path),
                expectedAdapterSha256=adapter_sha256,
                transcriptValidationProof=transcript_validation_proof,
            )
        artifact_proof = report.get("artifactProof")
        if isinstance(artifact_proof, dict) and artifact_proof.get("ok") is not True:
            if quality_gate_artifact_proof_score_not_pass(artifact_proof):
                return stage(
                    "lora_quality_gate",
                    "blocked",
                    quality_gate_score_review_message(artifact_proof),
                    qualityGateJson=report.get("json"),
                    createdAt=report.get("createdAt"),
                    adapterPath=str(adapter_path),
                    expectedAdapterSha256=adapter_sha256,
                    artifactProof=artifact_proof,
                )
            return stage(
                "lora_quality_gate",
                "blocked",
                "latest LoRA quality gate artifact proof is stale or incomplete",
                qualityGateJson=report.get("json"),
                createdAt=report.get("createdAt"),
                adapterPath=str(adapter_path),
                expectedAdapterSha256=adapter_sha256,
                artifactProof=artifact_proof,
            )
        proofs = report.get("proofs") if isinstance(report.get("proofs"), dict) else {}
        report_adapter = proofs.get("loraAdapter") if isinstance(proofs, dict) else None
        return stage(
            "lora_quality_gate",
            "blocked",
            "latest LoRA quality gate does not prove it used the verified adapter file",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
            adapterPath=str(adapter_path),
            expectedAdapterSha256=adapter_sha256,
            qualityGateAdapterSha256=report_adapter.get("sha256") if isinstance(report_adapter, dict) else None,
        )
    return stage(
        "lora_quality_gate",
        "missing",
        "no passing non-dry-run quality gate was found with the verified LoRA adapter file loaded",
        adapterPath=str(adapter_path),
    )


def latest_backend_selection(root: Path, profile: Path | None = None) -> tuple[Path, dict[str, Any]] | None:
    matches: list[tuple[int, str, Path, dict[str, Any]]] = []
    expected_voice_profile_id = ""
    if profile is not None:
        profile_payload = load_json(profile)
        expected_voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip() if profile_payload else ""
    try:
        candidates = [
            path
            for pattern in ("**/*.selection.json", "**/*.backend-selection.json")
            for path in root.glob(pattern)
        ]
    except OSError:
        return None
    for path in candidates:
        payload = load_json(path)
        if not payload:
            continue
        if payload.get("verdict") != "accept" or payload.get("accepted") is not True:
            continue
        selection_profile = payload.get("voiceProfile") if isinstance(payload.get("voiceProfile"), dict) else {}
        selection_voice_profile_id = str(selection_profile.get("voiceProfileId") or "").strip()
        if (
            expected_voice_profile_id
            and selection_voice_profile_id
            and selection_voice_profile_id != expected_voice_profile_id
        ):
            continue
        profile_rank = 0
        if expected_voice_profile_id and selection_voice_profile_id != expected_voice_profile_id:
            profile_rank = 1
        matches.append((profile_rank, str(payload.get("createdAt") or path.stat().st_mtime), path.resolve(), payload))
    if not matches:
        return None
    matches.sort(key=lambda row: row[1], reverse=True)
    matches.sort(key=lambda row: row[0])
    _, _, path, payload = matches[0]
    return path, payload


def latest_backend_shootout_render_plan(root: Path, profile: Path) -> dict[str, Any] | None:
    expected_profile_sha256 = profile_sha256_for_path(profile)
    if not expected_profile_sha256:
        return None
    try:
        candidates = list(root.glob("**/manifest.json"))
    except OSError:
        return None
    matches: list[tuple[float, Path, dict[str, Any]]] = []
    for path in candidates:
        payload = load_json(path)
        renders = payload.get("renders") if isinstance(payload, dict) and isinstance(payload.get("renders"), list) else []
        if not renders:
            continue
        if not any(
            isinstance(render, dict)
            and render.get("profileSha256") == expected_profile_sha256
            and str(render.get("voiceProfileId") or "").strip()
            for render in renders
        ):
            continue
        render_script = path.parent / "render.sh"
        if render_script.is_file():
            matching_renders = [
                render
                for render in renders
                if isinstance(render, dict)
                and render.get("profileSha256") == expected_profile_sha256
                and str(render.get("voiceProfileId") or "").strip()
            ]
            output_paths = [
                Path(str(render.get("outputWav"))).expanduser()
                for render in matching_renders
                if isinstance(render.get("outputWav"), str) and str(render.get("outputWav")).strip()
            ]
            rendered_count = sum(1 for output_path in output_paths if output_path.is_file())
            missing_renders = [
                render
                for render in matching_renders
                if isinstance(render.get("outputWav"), str)
                and str(render.get("outputWav")).strip()
                and not Path(str(render.get("outputWav"))).expanduser().is_file()
            ]
            renderer_envs = sorted(
                {
                    str(render.get("commandTemplateEnv") or "").strip()
                    for render in matching_renders
                    if str(render.get("commandTemplateEnv") or "").strip()
                }
            )
            missing_renderer_envs = sorted(
                {
                    str(render.get("commandTemplateEnv") or "").strip()
                    for render in missing_renders
                    if str(render.get("commandTemplateEnv") or "").strip()
                }
            )
            fallback_envs = sorted(
                {
                    str(render.get("commandTemplateFallbackEnv") or "").strip()
                    for render in matching_renders
                    if str(render.get("commandTemplateFallbackEnv") or "").strip()
                }
            )
            fallback_env = fallback_envs[0] if len(fallback_envs) == 1 else "ANYVOICE_BACKEND_RENDER_COMMAND"
            renderer_env = renderer_envs[0] if len(renderer_envs) == 1 else fallback_env
            fallback_configured = bool(os.environ.get(fallback_env, "").strip())
            configured_missing_envs = [
                env_name for env_name in missing_renderer_envs if os.environ.get(env_name, "").strip()
            ]
            renderer_command_configured = (
                fallback_configured
                or (bool(missing_renderer_envs) and len(configured_missing_envs) == len(missing_renderer_envs))
                or (not missing_renders and bool(renderer_envs or fallback_env))
            )
            plan = {
                "manifest": str(path.resolve()),
                "renderScript": str(render_script.resolve()),
                "totalRenders": len(matching_renders),
                "renderedRenders": rendered_count,
                "missingRenders": max(0, len(matching_renders) - rendered_count),
                "rendererCommandEnv": renderer_env,
                "rendererCommandEnvs": renderer_envs,
                "missingRendererCommandEnvs": missing_renderer_envs,
                "rendererCommandFallbackEnv": fallback_env,
                "rendererCommandConfigured": renderer_command_configured,
                "rendererStatus": "ready_to_render" if renderer_command_configured else "needs_renderer_command",
            }
            preflight_command = [
                sys.executable,
                str(REPO_ROOT / "scripts" / "render_voice_backend_job.py"),
                "--preflight",
                "--manifest",
                str(path.resolve()),
            ]
            preflight, preflight_run = run_json(preflight_command)
            plan["rendererPreflightCommand"] = shell_join(preflight_command)
            plan["rendererPreflightRun"] = preflight_run
            if isinstance(preflight, dict):
                plan["rendererPreflight"] = preflight
            matches.append((path.stat().st_mtime, render_script.resolve(), plan))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def latest_backend_shootout_render_command(root: Path, profile: Path) -> str | None:
    plan = latest_backend_shootout_render_plan(root, profile)
    command = plan.get("renderScript") if isinstance(plan, dict) else None
    return command if isinstance(command, str) and command.strip() else None


def score_renders_for_mode(score: dict[str, Any], clone_mode: str) -> list[dict[str, Any]]:
    groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    renders: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, dict) or str(group.get("cloneMode") or "") != clone_mode:
            continue
        for render in group.get("renders", []):
            if isinstance(render, dict):
                renders.append(render)
    return renders


def score_renders_match_profile(score: dict[str, Any], profile: Path) -> bool:
    profile_json = load_json(profile)
    voice_profile_id = str(profile_json.get("voiceProfileId") or "").strip() if profile_json else ""
    if not voice_profile_id:
        return False
    profile_sha256 = canonical_profile_sha256(profile_json)
    score_profile = score.get("voiceProfile") if isinstance(score.get("voiceProfile"), dict) else {}
    if score_profile.get("voiceProfileId") != voice_profile_id:
        return False
    if score_profile.get("profileSha256") != profile_sha256:
        return False
    matched = 0
    for group in score.get("groups", []) if isinstance(score.get("groups"), list) else []:
        if not isinstance(group, dict):
            continue
        if group.get("voiceProfileId") != voice_profile_id:
            return False
        if group.get("profileSha256") != profile_sha256:
            return False
        for render in group.get("renders", []):
            if not isinstance(render, dict):
                continue
            if render.get("voiceProfileId") != voice_profile_id:
                return False
            if render.get("profileSha256") != profile_sha256:
                return False
            matched += 1
    return matched > 0


def backend_selection_matches_profile(selection: dict[str, Any], profile: Path) -> dict[str, Any]:
    profile_json = load_json(profile)
    voice_profile_id = str(profile_json.get("voiceProfileId") or "").strip() if profile_json else ""
    if not voice_profile_id or not profile_json:
        return {"ok": False, "reason": "profile_missing_voice_profile_id"}
    expected_profile_sha256 = canonical_profile_sha256(profile_json)
    selection_profile = selection.get("voiceProfile") if isinstance(selection.get("voiceProfile"), dict) else None
    if not isinstance(selection_profile, dict):
        return {
            "ok": False,
            "reason": "selection_missing_voice_profile_evidence",
            "expectedVoiceProfileId": voice_profile_id,
            "expectedProfileSha256": expected_profile_sha256,
        }
    errors: list[str] = []
    if selection_profile.get("voiceProfileId") != voice_profile_id:
        errors.append("voice_profile_id_mismatch")
    if selection_profile.get("profileSha256") != expected_profile_sha256:
        errors.append("profile_sha256_mismatch")
    return {
        "ok": not errors,
        "reason": "pass" if not errors else "selection_does_not_match_current_profile",
        "errors": errors,
        "selectionVoiceProfile": selection_profile,
        "expectedVoiceProfileId": voice_profile_id,
        "expectedProfileSha256": expected_profile_sha256,
    }


def backend_review_source_report_errors(
    *,
    review_path: Path | None,
    source_report_path: Path | None,
    source_report_sha256: str | None,
) -> list[str]:
    errors: list[str] = []
    if review_path is None or source_report_path is None:
        return errors
    review = load_json(review_path)
    if not review:
        return ["review_json_unreadable"]
    if not same_path(review.get("reportPath") or review.get("report"), source_report_path, review_path.parent):
        errors.append("review_source_report_path_mismatch")
    review_report_sha256 = review.get("reportSha256")
    if not isinstance(review_report_sha256, str) or not review_report_sha256.strip():
        errors.append("review_source_report_sha256_missing")
    elif source_report_sha256 and review_report_sha256.strip().lower() != source_report_sha256.lower():
        errors.append("review_source_report_sha256_mismatch")
    choices = review.get("choices")
    if not isinstance(choices, dict) or not choices:
        errors.append("review_choices_missing")
    return errors


def backend_selection_evidence_status(
    selection: dict[str, Any],
    *,
    selection_path: Path,
    score_path: Path,
    score: dict[str, Any],
    profile: Path,
) -> dict[str, Any]:
    errors: list[str] = []

    expected_score_sha = file_sha256(score_path)
    if not isinstance(selection.get("scoreSha256"), str) or not selection.get("scoreSha256"):
        errors.append("score_sha256_missing")
    elif selection.get("scoreSha256") != expected_score_sha:
        errors.append("score_sha256_mismatch")

    review_path = None
    review_raw = selection.get("reviewJson")
    if not isinstance(review_raw, str) or not review_raw.strip():
        errors.append("review_path_missing")
    else:
        review_path = Path(review_raw).expanduser()
        if not review_path.is_absolute():
            review_path = (selection_path.parent / review_path).resolve()
        expected_review_sha = file_sha256(review_path)
        if not isinstance(selection.get("reviewSha256"), str) or not selection.get("reviewSha256"):
            errors.append("review_sha256_missing")
        elif selection.get("reviewSha256") != expected_review_sha:
            errors.append("review_sha256_mismatch")

    source_report_path = None
    source_report_raw = selection.get("sourceReport")
    if not isinstance(source_report_raw, str) or not source_report_raw.strip():
        errors.append("source_report_path_missing")
    else:
        source_report_path = Path(source_report_raw).expanduser()
        if not source_report_path.is_absolute():
            source_report_path = (selection_path.parent / source_report_path).resolve()
        expected_source_report_sha = file_sha256(source_report_path)
        if not isinstance(selection.get("sourceReportSha256"), str) or not selection.get("sourceReportSha256"):
            errors.append("source_report_sha256_missing")
        elif selection.get("sourceReportSha256") != expected_source_report_sha:
            errors.append("source_report_sha256_mismatch")
        if not same_path(score.get("sourceReport"), source_report_path, score_path.parent):
            errors.append("source_report_score_path_mismatch")
        if not isinstance(score.get("sourceReportSha256"), str) or not score.get("sourceReportSha256"):
            errors.append("source_report_score_sha256_missing")
        elif score.get("sourceReportSha256") != selection.get("sourceReportSha256"):
            errors.append("source_report_score_sha256_mismatch")
        source_report = load_json(source_report_path)
        if not source_report:
            errors.append("source_report_json_unreadable")
        profile_payload = load_json(profile)
        if not profile_payload:
            errors.append("profile_json_unreadable")
        if source_report and profile_payload:
            voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip() or None
            errors.extend(
                source_report_profile_evidence_errors(
                    report=source_report,
                    voice_profile_id=voice_profile_id,
                    profile_sha256=canonical_profile_sha256(profile_payload),
                )
            )

    errors.extend(
        backend_review_source_report_errors(
            review_path=review_path,
            source_report_path=source_report_path,
            source_report_sha256=file_sha256(source_report_path) if source_report_path else None,
        )
    )

    return {
        "ok": not errors,
        "reason": "pass" if not errors else "selection_evidence_hashes_do_not_match",
        "errors": errors,
        "scoreJson": str(score_path),
        "scoreSha256": expected_score_sha,
        "reviewJson": str(review_path) if review_path else None,
        "reviewSha256": file_sha256(review_path) if review_path else None,
        "sourceReport": str(source_report_path) if source_report_path else None,
        "sourceReportSha256": file_sha256(source_report_path) if source_report_path else None,
    }


def same_optional_path(raw_path: Any, expected_path: Path | None) -> bool:
    if expected_path is None:
        return raw_path in {None, ""}
    return same_path(raw_path, expected_path)


def profile_backend_policy_status(
    profile_path: Path,
    *,
    selection_path: Path,
    score_path: Path,
    review_path: Path | None,
    source_report_path: Path | None,
    subjective_review: dict[str, Any] | None,
    baseline: str,
    candidate: str,
) -> dict[str, Any]:
    profile = load_json(profile_path)
    policy = profile.get("preferredBackend") if isinstance(profile, dict) else None
    if not isinstance(policy, dict):
        return {
            "ok": False,
            "reason": "missing_preferred_backend_policy",
        }
    voice_profile_id = str(profile.get("voiceProfileId") or "").strip() if isinstance(profile, dict) else ""
    errors: list[str] = []
    profile_base = profile_path.parent
    if policy.get("status") != "accepted":
        errors.append("policy_status_not_accepted")
    if policy.get("voiceProfileId") != voice_profile_id:
        errors.append("voice_profile_id_mismatch")
    if not same_path(policy.get("profileJson"), profile_path, profile_base):
        errors.append("profile_path_mismatch")
    if policy.get("profileSha256") != canonical_profile_sha256(profile):
        errors.append("profile_sha256_mismatch")
    if policy.get("backend") != candidate:
        errors.append("backend_mismatch")
    if policy.get("baselineBackend") != baseline:
        errors.append("baseline_backend_mismatch")
    if not same_path(policy.get("selectionJson"), selection_path, profile_base):
        errors.append("selection_path_mismatch")
    if not same_path(policy.get("scoreJson"), score_path, profile_base):
        errors.append("score_path_mismatch")
    if review_path is None:
        errors.append("review_evidence_missing")
    elif not same_path(policy.get("reviewJson"), review_path, profile_base):
        errors.append("review_path_mismatch")
    if source_report_path is None:
        errors.append("source_report_evidence_missing")
    elif not same_path(policy.get("sourceReport"), source_report_path, profile_base):
        errors.append("source_report_path_mismatch")
    expected_subjective = subjective_review if isinstance(subjective_review, dict) else {}
    if "subjectiveReview" in policy and not backend_subjective_review_summary_matches(
        policy.get("subjectiveReview"),
        expected_subjective,
        profile_base,
        selection_path.parent,
    ):
        errors.append("subjective_review_summary_mismatch")
    checks = [
        ("selectionSha256", selection_path, "selection_sha256_mismatch"),
        ("scoreSha256", score_path, "score_sha256_mismatch"),
    ]
    if review_path is not None:
        checks.append(("reviewSha256", review_path, "review_sha256_mismatch"))
    if source_report_path is not None:
        checks.append(("sourceReportSha256", source_report_path, "source_report_sha256_mismatch"))
    for field, path, error in checks:
        expected_sha = file_sha256(path)
        if not isinstance(policy.get(field), str) or policy.get(field) != expected_sha:
            errors.append(error)
    return {
        "ok": not errors,
        "reason": "pass" if not errors else "policy_does_not_match_current_selection",
        "errors": errors,
        "policy": policy,
    }


def audit_backend_selection(profile: Path, root: Path) -> dict[str, Any]:
    selection = latest_backend_selection(root, profile)
    if not selection:
        return stage(
            "backend_selection",
            "missing",
            "no accepted backend selection proof found",
            root=str(root),
        )
    proof_path, proof = selection
    score_raw = proof.get("scoreJson")
    if not isinstance(score_raw, str) or not score_raw.strip():
        return stage("backend_selection", "blocked", "backend selection proof does not name scoreJson", selectionJson=str(proof_path))
    score_path = Path(score_raw).expanduser()
    if not score_path.is_absolute():
        score_path = (proof_path.parent / score_path).resolve()
    score = load_json(score_path)
    if not score:
        return stage(
            "backend_selection",
            "blocked",
            "backend selection score JSON is missing or invalid",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
        )
    baseline = str(proof.get("baselineCloneMode") or "voxcpm2-hifi")
    candidate = str(proof.get("candidateCloneMode") or "")
    if not candidate:
        return stage("backend_selection", "blocked", "backend selection proof does not name a candidate backend", selectionJson=str(proof_path))
    selection_profile_status = backend_selection_matches_profile(proof, profile)
    if not selection_profile_status.get("ok"):
        return stage(
            "backend_selection",
            "blocked",
            "backend selection proof does not match the audited voice profile",
            selectionJson=str(proof_path),
            profileJson=str(profile),
            selectionProfile=selection_profile_status,
        )
    evidence_status = backend_selection_evidence_status(
        proof,
        selection_path=proof_path,
        score_path=score_path,
        score=score,
        profile=profile,
    )
    if not evidence_status.get("ok"):
        return stage(
            "backend_selection",
            "blocked",
            "backend selection proof evidence hashes no longer match current files",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
            evidence=evidence_status,
        )
    review_path = Path(str(evidence_status["reviewJson"])).expanduser().resolve(strict=False)
    recomputed = evaluate_selection(
        score,
        score_path=score_path,
        baseline_clone_mode=baseline,
        candidate_clone_mode=candidate,
        require_external_candidate=True,
        review_path=review_path,
    )
    if recomputed.get("verdict") != "accept":
        return stage(
            "backend_selection",
            "blocked",
            "backend selection proof no longer recomputes as accepted",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
            candidateCloneMode=candidate,
            reasons=recomputed.get("reasons"),
        )
    score_render_errors = score_render_output_evidence_errors(score, score_path)
    if score_render_errors:
        return stage(
            "backend_selection",
            "blocked",
            "backend selection score does not prove current ready render output files",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
            candidateCloneMode=candidate,
            scoreRenderProof={
                "ok": False,
                "reason": score_render_errors[0],
                "errors": score_render_errors,
            },
        )
    if not score_renders_match_profile(score, profile):
        return stage(
            "backend_selection",
            "blocked",
            "backend selection score does not match the audited voice profile",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
            profileJson=str(profile),
        )
    subjective = recomputed.get("subjectiveReview") if isinstance(recomputed.get("subjectiveReview"), dict) else {}
    recomputed_review_path = None
    if isinstance(subjective.get("reviewJson"), str) and subjective.get("reviewJson"):
        recomputed_review_path = Path(str(subjective["reviewJson"])).expanduser().resolve(strict=False)
    recomputed_source_report = None
    if isinstance(subjective.get("report"), str) and subjective.get("report"):
        recomputed_source_report = Path(str(subjective["report"])).expanduser().resolve(strict=False)
    policy_status = profile_backend_policy_status(
        profile,
        selection_path=proof_path,
        score_path=score_path,
        review_path=recomputed_review_path,
        source_report_path=recomputed_source_report,
        subjective_review=subjective,
        baseline=baseline,
        candidate=candidate,
    )
    if not policy_status.get("ok"):
        return stage(
            "backend_selection",
            "blocked",
            "accepted backend selection has not been applied to the audited voice profile",
            selectionJson=str(proof_path),
            scoreJson=str(score_path),
            profileJson=str(profile),
            candidateCloneMode=candidate,
            preferredBackendPolicy=policy_status,
            applyCommand=shell_join(
                [
                    "python3",
                    "scripts/apply_voice_backend_selection.py",
                    str(proof_path),
                    "--profile-json",
                    str(profile),
                ]
            ),
        )
    return stage(
        "backend_selection",
        "pass",
        "accepted backend selection proof passed and is applied to the audited voice profile",
        selectionJson=str(proof_path),
        scoreJson=str(score_path),
        baselineCloneMode=baseline,
        candidateCloneMode=candidate,
        subjectiveReview=recomputed.get("subjectiveReview"),
        candidate=recomputed.get("candidate"),
        preferredBackendPolicy=policy_status.get("policy"),
    )


def record_profile_kit_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--auto-duration",
            "--microphone-smoke-sec",
            "2",
            "--profile-id",
            profile_id,
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--check",
        ]
    )


def record_profile_kit_focused_clip_command(profile_id: str, kit_manifest: Path, clip_id: str) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--clip",
            clip_id,
            "--profile-id",
            profile_id,
            "--open-cue-sheet",
            "--auto-duration",
            "--microphone-smoke-sec",
            "2",
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--check-selected",
        ]
    )


def record_profile_kit_focused_clips_command(profile_id: str, kit_manifest: Path, clip_ids: list[str]) -> str | None:
    clean_clip_ids: list[str] = []
    for clip_id in clip_ids:
        if clip_id and clip_id not in clean_clip_ids:
            clean_clip_ids.append(clip_id)
    if not clean_clip_ids:
        return None
    clip_args: list[str] = []
    for clip_id in clean_clip_ids:
        clip_args.extend(["--clip", clip_id])
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            *clip_args,
            "--profile-id",
            profile_id,
            "--open-cue-sheet",
            "--auto-duration",
            "--microphone-smoke-sec",
            "2",
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--check-selected",
        ]
    )


def record_profile_kit_brief_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--preflight",
            "--brief",
            "--auto-duration",
            "--profile-id",
            profile_id,
        ]
    )


def record_profile_kit_microphone_smoke_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--preflight",
            "--brief",
            "--microphone-smoke-sec",
            "2",
            "--auto-duration",
            "--profile-id",
            profile_id,
        ]
    )


def normalize_external_recordings_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/normalize_voice_profile_recording_kit_audio.py",
            "--manifest",
            str(kit_manifest),
            "--check",
            "--profile-id",
            profile_id,
        ]
    )


def normalize_present_external_recordings_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/normalize_voice_profile_recording_kit_audio.py",
            "--manifest",
            str(kit_manifest),
            "--only-present",
            "--profile-id",
            profile_id,
        ]
    )


def record_profile_kit_open_cue_sheet_command(kit_manifest: Path) -> str:
    return shell_join(["python3", "-m", "webbrowser", "-t", (kit_manifest.parent / "cue-sheet.html").resolve().as_uri()])


def record_profile_kit_product_proof_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--auto-duration",
            "--microphone-smoke-sec",
            "2",
            "--profile-id",
            profile_id,
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--check",
            "--run-product-proof-after-check",
        ]
    )


def record_profile_kit_lora_handoff_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(kit_manifest),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--auto-duration",
            "--microphone-smoke-sec",
            "2",
            "--profile-id",
            profile_id,
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--check",
            "--prepare-lora-after-product-proof",
        ]
    )


def prepare_extended_recording_kit_command(profile_id: str, kit_manifest: Path) -> str:
    return shell_join(
        [
            "python3",
            "scripts/prepare_voice_profile_recording_kit.py",
            "--prompt-set",
            "extended",
            "--profile-id",
            profile_id,
            "--out-dir",
            str(kit_manifest.parent),
        ]
    )


def next_step_command(profile_id: str, kit_manifest: Path, profile: Path, *, allow_lora_export: bool = False) -> str:
    parts = [
        "python3",
        "scripts/voice_profile_next_step.py",
        "--profile-json",
        str(profile),
        "--kit-manifest",
        str(kit_manifest),
        "--profile-id",
        profile_id,
        "--run",
        "--auto-advance",
        "--allow-enroll",
        "--allow-expensive",
        "--max-steps",
        "3",
    ]
    if allow_lora_export:
        parts.append("--allow-lora-export")
    else:
        parts.append("--stop-before-lora")
    return shell_join(parts)


def quality_gate_needs_profile_reference_recording(blocker: dict[str, Any]) -> bool:
    artifact_proof = blocker.get("artifactProof") if isinstance(blocker.get("artifactProof"), dict) else {}
    summary = artifact_proof.get("scoreSummary") if isinstance(artifact_proof.get("scoreSummary"), dict) else {}
    profile_reference_reviews = summary.get("profileReferenceReviewGroups")
    return isinstance(profile_reference_reviews, int) and profile_reference_reviews > 0


def quality_gate_needs_backend_or_lora_route(blocker: dict[str, Any]) -> bool:
    if not isinstance(blocker, dict) or blocker.get("id") != "quality_gate":
        return False
    if quality_gate_needs_profile_reference_recording(blocker):
        return False
    artifact_proof = blocker.get("artifactProof") if isinstance(blocker.get("artifactProof"), dict) else {}
    groups = artifact_proof.get("scoreReviewGroups") if isinstance(artifact_proof.get("scoreReviewGroups"), list) else []
    if not groups:
        return False
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("pronunciationVerdict") == "review" or group.get("speakerIdentityVerdict") == "review":
            return True
    return False


def quality_gate_missing_profile_reference_preset_ids(blocker: dict[str, Any]) -> list[str]:
    artifact_proof = blocker.get("artifactProof") if isinstance(blocker.get("artifactProof"), dict) else {}
    groups = artifact_proof.get("scoreReviewGroups") if isinstance(artifact_proof.get("scoreReviewGroups"), list) else []
    missing_ids: list[str] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        profile_reference = group.get("profileReference") if isinstance(group.get("profileReference"), dict) else {}
        missing_by_render = (
            profile_reference.get("missingByRender")
            if isinstance(profile_reference.get("missingByRender"), list)
            else []
        )
        for row in missing_by_render:
            if not isinstance(row, dict):
                continue
            for preset_id in string_list(row.get("missingPronunciationPresetIds")):
                if preset_id not in missing_ids:
                    missing_ids.append(preset_id)
    return missing_ids


def profile_reference_recording_commands(
    *,
    blocker: dict[str, Any] | None,
    profile_id: str,
    kit_manifest: Path,
) -> list[dict[str, Any]]:
    if not isinstance(blocker, dict) or not quality_gate_needs_profile_reference_recording(blocker):
        return []
    if not kit_manifest.exists():
        return []
    payload = load_json(kit_manifest)
    clips = payload.get("clips") if isinstance(payload, dict) and isinstance(payload.get("clips"), list) else []
    rows: list[dict[str, Any]] = []
    seen_clip_ids: set[str] = set()
    for preset_id in quality_gate_missing_profile_reference_preset_ids(blocker):
        matching_clip = next(
            (
                clip
                for clip in clips
                if isinstance(clip, dict)
                and preset_id in set(string_list(clip.get("pronunciationPresetIds")))
                and isinstance(clip.get("id"), str)
                and str(clip.get("id")).strip()
            ),
            None,
        )
        if not matching_clip:
            continue
        clip_id = str(matching_clip["id"])
        if clip_id in seen_clip_ids:
            continue
        seen_clip_ids.add(clip_id)
        rows.append(
            {
                "presetId": preset_id,
                "clipId": clip_id,
                "transcript": matching_clip.get("transcript"),
                "recordCommand": record_profile_kit_focused_clip_command(profile_id, kit_manifest, clip_id),
            }
        )
    return rows


def profile_reference_recording_batch_command(
    *,
    blocker: dict[str, Any] | None,
    profile_id: str,
    kit_manifest: Path,
) -> str | None:
    rows = profile_reference_recording_commands(blocker=blocker, profile_id=profile_id, kit_manifest=kit_manifest)
    clip_ids = [str(row["clipId"]) for row in rows if isinstance(row.get("clipId"), str) and row.get("clipId")]
    return record_profile_kit_focused_clips_command(profile_id, kit_manifest, clip_ids)


def post_profile_reference_recording_proof_command(
    *,
    blocker: dict[str, Any] | None,
    profile_id: str,
    kit_manifest: Path,
    profile: Path,
) -> str | None:
    if not profile_reference_recording_commands(blocker=blocker, profile_id=profile_id, kit_manifest=kit_manifest):
        return None
    return next_step_command(profile_id, kit_manifest, profile)


def quality_gate_probe_commands(blocker: dict[str, Any] | None, base_quality_gate_command: str | None) -> list[dict[str, Any]]:
    if not isinstance(blocker, dict) or blocker.get("id") != "quality_gate":
        return []
    if not isinstance(base_quality_gate_command, str) or not base_quality_gate_command.strip():
        return []
    artifact_proof = blocker.get("artifactProof") if isinstance(blocker.get("artifactProof"), dict) else {}
    groups = artifact_proof.get("scoreReviewGroups") if isinstance(artifact_proof.get("scoreReviewGroups"), list) else []
    rows: list[dict[str, Any]] = []
    seen_case_ids: set[str] = set()
    for group in groups:
        if not isinstance(group, dict):
            continue
        case_id = str(group.get("caseId") or "").strip()
        if not case_id or case_id in seen_case_ids:
            continue
        seen_case_ids.add(case_id)
        rows.append(
            {
                "caseId": case_id,
                "verdict": group.get("verdict"),
                "pronunciationVerdict": group.get("pronunciationVerdict"),
                "speakerIdentityVerdict": group.get("speakerIdentityVerdict"),
                "profileReferenceVerdict": group.get("profileReferenceVerdict"),
                "asrSamples": group.get("asrSamples") if isinstance(group.get("asrSamples"), list) else [],
                "command": f"{base_quality_gate_command} --case {shlex.quote(case_id)}",
                "proofScope": "partial_case_probe_not_full_completion_gate",
            }
        )
    return rows


def quality_gate_repair_actions(
    *,
    blocker: dict[str, Any] | None,
    profile_id: str,
    kit_manifest: Path,
    profile: Path,
    base_quality_gate_command: str | None,
    backend_shootout_command: str | None = None,
    backend_shootout_render_command: str | None = None,
    backend_shootout_render_plan: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(blocker, dict) or blocker.get("id") != "quality_gate":
        return []
    actions: list[dict[str, Any]] = []
    batch_command = profile_reference_recording_batch_command(
        blocker=blocker,
        profile_id=profile_id,
        kit_manifest=kit_manifest,
    )
    profile_reference_rows = profile_reference_recording_commands(
        blocker=blocker,
        profile_id=profile_id,
        kit_manifest=kit_manifest,
    )
    if batch_command:
        actions.append(
            {
                "kind": "record_profile_reference_batch",
                "priority": 1,
                "status": "ready",
                "reason": "quality gate is missing profile-reference coverage for review groups",
                "command": batch_command,
                "clipIds": [row.get("clipId") for row in profile_reference_rows if isinstance(row.get("clipId"), str)],
                "presetIds": [
                    row.get("presetId") for row in profile_reference_rows if isinstance(row.get("presetId"), str)
                ],
            }
        )
        proof_command = post_profile_reference_recording_proof_command(
            blocker=blocker,
            profile_id=profile_id,
            kit_manifest=kit_manifest,
            profile=profile,
        )
        if proof_command:
            actions.append(
                {
                    "kind": "rerun_profile_reference_proof",
                    "priority": 2,
                    "status": "waiting",
                    "reason": "refresh profile proof chain after recording the missing reference clips",
                    "command": proof_command,
                    "dependsOn": "record_profile_reference_batch",
                }
            )
    if not batch_command and quality_gate_needs_backend_or_lora_route(blocker):
        render_plan_complete = (
            isinstance(backend_shootout_render_plan, dict)
            and int(backend_shootout_render_plan.get("missingRenders") or 0) <= 0
            and str(backend_shootout_render_plan.get("rendererStatus") or "") == "ready_to_render"
        )
        if render_plan_complete:
            command = None
        else:
            command = (
                backend_shootout_render_command
                if isinstance(backend_shootout_render_command, str) and backend_shootout_render_command.strip()
                else backend_shootout_command
            )
        kind = "render_backend_shootout" if command == backend_shootout_render_command else ("prepare_backend_shootout" if command else "")
        reason = (
            (
                "backend shootout plan is ready but needs renderer command configuration"
                if isinstance(backend_shootout_render_plan, dict)
                and backend_shootout_render_plan.get("rendererStatus") == "needs_renderer_command"
                else "a backend shootout plan already exists for this profile; render those planned jobs next"
            )
            if kind == "render_backend_shootout"
            else "remaining quality-gate failures are pronunciation/speaker model-capability reviews, not profile-reference coverage gaps"
        )
    else:
        command = None
        kind = ""
        reason = ""
    if isinstance(command, str) and command.strip():
        action = {
            "kind": kind,
            "priority": 1,
            "status": "ready",
            "reason": reason,
            "command": command,
        }
        if kind == "render_backend_shootout" and isinstance(backend_shootout_render_plan, dict):
            action["rendererStatus"] = backend_shootout_render_plan.get("rendererStatus")
            action["rendererCommandEnv"] = backend_shootout_render_plan.get("rendererCommandEnv")
            action["rendererCommandEnvs"] = backend_shootout_render_plan.get("rendererCommandEnvs")
            action["missingRendererCommandEnvs"] = backend_shootout_render_plan.get("missingRendererCommandEnvs")
            action["rendererCommandFallbackEnv"] = backend_shootout_render_plan.get("rendererCommandFallbackEnv")
            action["rendererCommandConfigured"] = backend_shootout_render_plan.get("rendererCommandConfigured")
            action["rendererPreflightCommand"] = backend_shootout_render_plan.get("rendererPreflightCommand")
            action["rendererPreflight"] = backend_shootout_render_plan.get("rendererPreflight")
            action["manifest"] = backend_shootout_render_plan.get("manifest")
            action["totalRenders"] = backend_shootout_render_plan.get("totalRenders")
            action["renderedRenders"] = backend_shootout_render_plan.get("renderedRenders")
            action["missingRenders"] = backend_shootout_render_plan.get("missingRenders")
        actions.append(action)
    probe_priority = 3 if batch_command else (2 if actions else 1)
    for row in quality_gate_probe_commands(blocker, base_quality_gate_command):
        actions.append(
            {
                "kind": "run_quality_probe",
                "priority": probe_priority,
                "status": "waiting" if batch_command else "ready",
                "reason": "re-render and rescore this failing case after the preceding repair actions",
                "caseId": row.get("caseId"),
                "command": row.get("command"),
                "proofScope": row.get("proofScope"),
                "verdict": row.get("verdict"),
                "pronunciationVerdict": row.get("pronunciationVerdict"),
                "speakerIdentityVerdict": row.get("speakerIdentityVerdict"),
                "profileReferenceVerdict": row.get("profileReferenceVerdict"),
                "blockedUntil": "rerun_profile_reference_proof" if batch_command else None,
                "asrSamples": row.get("asrSamples") if isinstance(row.get("asrSamples"), list) else [],
            }
        )
    return actions


def quality_gate_profile_reference_recording_command(profile_id: str, kit_manifest: Path, blocker: dict[str, Any]) -> str:
    if kit_manifest.exists():
        batch_command = profile_reference_recording_batch_command(
            blocker=blocker,
            profile_id=profile_id,
            kit_manifest=kit_manifest,
        )
        if batch_command:
            return batch_command
        return record_profile_kit_command(profile_id, kit_manifest)
    return prepare_extended_recording_kit_command(profile_id, kit_manifest)


def latest_lora_dataset_json(profile: Path, root: Path) -> Path | None:
    match = latest_profile_matching_json(
        root,
        "**/dataset.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    return match[0] if match else None


def latest_lora_train_config(profile: Path, root: Path) -> Path | None:
    match = latest_profile_matching_json(
        root,
        "**/train_config.json",
        profile,
        lambda payload, _path: same_path(payload.get("profilePath"), profile, _path.parent),
    )
    return match[0] if match else None


def next_command_for_blocker(
    *,
    blocker: dict[str, Any] | None,
    profile_id: str,
    kit_manifest: Path,
    profile: Path,
    transcript_validation: Path | None,
    quality_report: dict[str, Any] | None,
    product_report: dict[str, Any] | None,
    dataset_root: Path,
    training_root: Path,
    backend_selection_root: Path,
    backend_shootout_render_command: str | None = None,
) -> str | None:
    if not blocker:
        return None
    blocker_id = str(blocker.get("id") or "")
    quality_gate_json = (
        Path(str(product_report["json"])).expanduser().resolve()
        if isinstance(product_report, dict)
        and product_quality_gate_passed(product_report)
        and isinstance(product_report.get("json"), str)
        else None
    )
    cmd_map = next_step_commands(
        profile_path=profile,
        kit_manifest=kit_manifest,
        profile_id=profile_id,
        transcript_validation_json=transcript_validation,
        transcript_asr_json=None,
        quality_gate_json=quality_gate_json,
        record_countdown_sec=2,
    )
    if blocker_id == "recording_kit":
        if blocker.get("recommendedPromptSet") == "extended":
            return prepare_extended_recording_kit_command(profile_id, kit_manifest)
        pending_external = blocker.get("pendingExternalRecordings")
        if isinstance(pending_external, list) and pending_external:
            missing_source_count = blocker.get("missingExternalRecordingSourceCount")
            if isinstance(missing_source_count, int) and missing_source_count <= 0:
                return normalize_external_recordings_command(profile_id, kit_manifest)
            return normalize_present_external_recordings_command(profile_id, kit_manifest)
        return record_profile_kit_command(profile_id, kit_manifest)
    if blocker_id == "strict_profile":
        return next_step_command(profile_id, kit_manifest, profile)
    if blocker_id == "capture_depth":
        return prepare_extended_recording_kit_command(profile_id, kit_manifest)
    if blocker_id == "proof_environment":
        checks = blocker.get("checkCommands") if isinstance(blocker.get("checkCommands"), list) else []
        commands = [str(item) for item in checks if isinstance(item, str) and item.strip()]
        return " && ".join(commands) if commands else next_step_command(profile_id, kit_manifest, profile)
    if blocker_id == "quality_gate":
        if quality_gate_needs_profile_reference_recording(blocker):
            return quality_gate_profile_reference_recording_command(profile_id, kit_manifest, blocker)
        if quality_gate_needs_backend_or_lora_route(blocker):
            render_plan = latest_backend_shootout_render_plan(backend_selection_root, profile)
            render_plan_complete = (
                isinstance(render_plan, dict)
                and int(render_plan.get("missingRenders") or 0) <= 0
                and str(render_plan.get("rendererStatus") or "") == "ready_to_render"
            )
            if render_plan_complete:
                return cmd_map["qualityGate"]
            render_command = (
                backend_shootout_render_command
                if isinstance(backend_shootout_render_command, str) and backend_shootout_render_command.strip()
                else latest_backend_shootout_render_command(backend_selection_root, profile)
            )
            if render_command:
                return render_command
            return cmd_map["prepareBackendShootout"]
        return cmd_map["qualityGate"]
    if blocker_id == "product_10x_proof":
        return cmd_map["qualityGateProductProof"]
    if blocker_id == "subjective_review":
        report_raw = blocker.get("report")
        report_path = Path(str(report_raw)).expanduser().resolve() if isinstance(report_raw, str) and report_raw else None
        review_raw = blocker.get("reviewJson")
        review_path_existing = Path(str(review_raw)).expanduser().resolve() if isinstance(review_raw, str) and review_raw else None
        if review_path_existing and report_path:
            return subjective_review_next_command(report_path, review_path_existing)
        if report_path is None and product_report and isinstance(product_report.get("paths"), dict):
            raw = product_report["paths"].get("report")
            if isinstance(raw, str) and raw:
                report_path = Path(raw).expanduser().resolve()
        review_candidates = blocker.get("expectedReviewJson") if isinstance(blocker.get("expectedReviewJson"), list) else []
        review_path = str(review_candidates[0]) if review_candidates else (str(report_path.parent / "review.json") if report_path else "review.json")
        html_path = str(report_path.with_suffix(".html")) if report_path else "the product proof report.html"
        if report_path:
            return shell_join(
                [
                    "npm",
                    "run",
                    "voice:clone:review",
                    "--",
                    "--report-html",
                    html_path,
                ]
            )
        return f"open {shlex.quote(html_path)}; export review JSON and save it as {shlex.quote(review_path)}"
    if blocker_id == "lora_dataset":
        if transcript_validation and quality_gate_json:
            return shell_join(
                [
                    "python3",
                    "scripts/prepare_voice_lora_dataset.py",
                    "--profile-json",
                    str(profile),
                    "--transcript-validation-json",
                    str(transcript_validation),
                    "--quality-gate-json",
                    str(quality_gate_json),
                    "--require-product-proof-quality-gate",
                    "--min-clips",
                    str(PRODUCT_CAPTURE_CLIPS),
                    "--min-total-duration-sec",
                    str(PRODUCT_CAPTURE_DURATION_SEC),
                ]
            )
        return next_step_command(profile_id, kit_manifest, profile, allow_lora_export=True)
    if blocker_id == "lora_training_job":
        if blocker.get("datasetBindingErrors"):
            dataset_json_raw = blocker.get("datasetJson")
            dataset_json = Path(str(dataset_json_raw)).expanduser().resolve() if isinstance(dataset_json_raw, str) and dataset_json_raw else latest_lora_dataset_json(profile, dataset_root)
            if dataset_json:
                return shell_join(
                    [
                        "python3",
                        "scripts/prepare_voxcpm_lora_training_job.py",
                        "--dataset-json",
                        str(dataset_json),
                        "--min-clips",
                        str(PRODUCT_CAPTURE_CLIPS),
                        "--min-total-duration-sec",
                        str(PRODUCT_CAPTURE_DURATION_SEC),
                    ]
                )
        if (
            blocker.get("adapterProofStatus") in {"metadata_pass", "pass"}
            and isinstance(blocker.get("trainConfig"), str)
            and (blocker.get("adapterProofStatus") == "metadata_pass" or blocker.get("adapterProofBindingErrors"))
        ):
            return shell_join(
                [
                    "python3",
                    "scripts/verify_voxcpm_lora_adapter.py",
                    "--train-config",
                    str(blocker["trainConfig"]),
                    "--require-readable-checkpoint",
                ]
            )
        dataset_json = latest_lora_dataset_json(profile, dataset_root)
        train_script = blocker.get("trainScript")
        if isinstance(train_script, str) and train_script.strip():
            if blocker.get("trainerCommandConfigured") is False:
                train_config = blocker.get("trainConfig")
                if isinstance(train_config, str) and train_config.strip():
                    return shell_join(
                        [
                            "python3",
                            "scripts/check_voxcpm_lora_trainer.py",
                            "--train-config",
                            train_config,
                        ]
                    )
                return shell_join(["bash", train_script])
            return shell_join(["bash", train_script])
        if dataset_json:
            return shell_join(
                [
                    "python3",
                    "scripts/prepare_voxcpm_lora_training_job.py",
                    "--dataset-json",
                    str(dataset_json),
                    "--min-clips",
                    str(PRODUCT_CAPTURE_CLIPS),
                    "--min-total-duration-sec",
                    str(PRODUCT_CAPTURE_DURATION_SEC),
                ]
            )
        return next_step_command(profile_id, kit_manifest, profile, allow_lora_export=True)
    if blocker_id == "lora_adapter":
        train_config = latest_lora_train_config(profile, training_root)
        if train_config:
            return shell_join(
                [
                    "python3",
                    "scripts/verify_voxcpm_lora_adapter.py",
                    "--train-config",
                    str(train_config),
                    "--require-readable-checkpoint",
                ]
            )
        return None
    if blocker_id == "lora_quality_gate":
        apply_command = blocker.get("applyCommand")
        if isinstance(apply_command, str) and apply_command.strip():
            return apply_command
        train_config = latest_lora_train_config(profile, training_root)
        config = load_json(train_config) if train_config else None
        if config and train_config:
            lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
            proof_path = resolve_config_path(lora.get("adapterProof"), train_config.parent)
            proof = load_json(proof_path) if proof_path else None
            adapter_path = adapter_path_from_proof_or_config(
                proof,
                config,
                train_config.parent,
                proof_path.parent if proof_path else None,
            )
            if proof and isinstance(proof.get("nextCommands"), dict):
                command_text = proof["nextCommands"].get("qualityGateWithAdapter")
                if isinstance(command_text, str) and command_text.strip():
                    return command_text
            if adapter_path:
                proof_metadata = proof.get("datasetProofs") if isinstance(proof, dict) and isinstance(proof.get("datasetProofs"), dict) else {}
                config_metadata = (
                    config.get("datasetProofs")
                    if isinstance(config.get("datasetProofs"), dict)
                    else {}
                )
                transcript_validation_json = resolve_config_path(
                    proof_metadata.get("transcriptValidationJson") or config_metadata.get("transcriptValidationJson"),
                    train_config.parent,
                )
                transcript_validation_args = (
                    ["--transcript-validation-json", str(transcript_validation_json)]
                    if transcript_validation_json
                    else []
                )
                return (
                    f"ANYVOICE_VOXCPM_LORA_PATH={shlex.quote(str(adapter_path))} "
                    + shell_join(
                        [
                            "python3",
                            "scripts/run_voice_quality_gate.py",
                            "--profile-json",
                            str(profile),
                            "--quality",
                            "balanced",
                            "--clone-mode",
                            "hifi",
                            "--require-speaker-backend",
                            PRODUCT_PROOF_SPEAKER_BACKEND,
                            "--repeats",
                            "3",
                            *transcript_validation_args,
                        ]
                    )
                )
        return None
    if blocker_id == "backend_selection":
        apply_command = blocker.get("applyCommand")
        if isinstance(apply_command, str) and apply_command.strip():
            return apply_command
        return cmd_map["prepareBackendShootout"]
    return None


def proof_environment_command(stages: list[dict[str, Any]]) -> str | None:
    proof_stage = next((stage for stage in stages if stage.get("id") == "proof_environment"), None)
    if not proof_stage or proof_stage.get("status") == "pass":
        return None
    checks = proof_stage.get("checkCommands") if isinstance(proof_stage.get("checkCommands"), list) else []
    commands = [str(item) for item in checks if isinstance(item, str) and item.strip()]
    return " && ".join(commands) if commands else None


def brief_command_for_blocker(*, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path) -> str | None:
    if not blocker:
        return None
    if str(blocker.get("id") or "") == "recording_kit" and kit_manifest.exists() and blocker.get("recommendedPromptSet") != "extended":
        return record_profile_kit_brief_command(profile_id, kit_manifest)
    return None


def open_cue_sheet_command_for_blocker(*, blocker: dict[str, Any] | None, kit_manifest: Path) -> str | None:
    if not blocker:
        return None
    cue_sheet = kit_manifest.parent / "cue-sheet.html"
    if str(blocker.get("id") or "") == "recording_kit" and cue_sheet.exists() and blocker.get("recommendedPromptSet") != "extended":
        return record_profile_kit_open_cue_sheet_command(kit_manifest)
    if str(blocker.get("id") or "") == "quality_gate" and cue_sheet.exists() and quality_gate_needs_profile_reference_recording(blocker):
        return record_profile_kit_open_cue_sheet_command(kit_manifest)
    return None


def microphone_smoke_command_for_blocker(*, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path) -> str | None:
    if not blocker:
        return None
    if str(blocker.get("id") or "") == "recording_kit" and kit_manifest.exists() and blocker.get("recommendedPromptSet") != "extended":
        return record_profile_kit_microphone_smoke_command(profile_id, kit_manifest)
    return None


def normalize_external_recordings_command_for_blocker(
    *, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path
) -> str | None:
    if not blocker:
        return None
    if str(blocker.get("id") or "") == "recording_kit" and kit_manifest.exists() and blocker.get("recommendedPromptSet") != "extended":
        return normalize_external_recordings_command(profile_id, kit_manifest)
    return None


def normalize_present_external_recordings_command_for_blocker(
    *, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path
) -> str | None:
    if not blocker:
        return None
    if (
        str(blocker.get("id") or "") == "recording_kit"
        and kit_manifest.exists()
        and blocker.get("recommendedPromptSet") != "extended"
        and isinstance(blocker.get("pendingExternalRecordings"), list)
        and blocker.get("pendingExternalRecordings")
    ):
        return normalize_present_external_recordings_command(profile_id, kit_manifest)
    return None


def product_proof_command_for_blocker(*, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path) -> str | None:
    if not blocker:
        return None
    if str(blocker.get("id") or "") == "recording_kit" and kit_manifest.exists() and blocker.get("recommendedPromptSet") != "extended":
        return record_profile_kit_product_proof_command(profile_id, kit_manifest)
    return None


def lora_handoff_command_for_blocker(*, blocker: dict[str, Any] | None, profile_id: str, kit_manifest: Path) -> str | None:
    if not blocker:
        return None
    if str(blocker.get("id") or "") == "recording_kit" and kit_manifest.exists() and blocker.get("recommendedPromptSet") != "extended":
        return record_profile_kit_lora_handoff_command(profile_id, kit_manifest)
    return None


def brief_backend_line(label: str, payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    available = payload.get("available")
    selected = payload.get("selectedAutoBackend")
    required = payload.get("requiredBackend")
    backend = required or selected
    state = "ready" if available is True else "missing"
    if backend:
        line = f"- {label}: {state} ({backend})"
    else:
        line = f"- {label}: {state}"
    reason = payload.get("reason")
    if available is not True and isinstance(reason, str) and reason.strip():
        line = f"{line} - {reason.strip()}"
    return line


def print_command_line(lines: list[str], label: str, command: Any) -> None:
    if isinstance(command, str) and command.strip():
        lines.append(f"- {label}: {command.strip()}")


def brief_number(value: Any, fallback: int | float) -> str:
    raw = value if isinstance(value, (int, float)) else fallback
    if isinstance(raw, int):
        return str(raw)
    return f"{float(raw):.3f}".rstrip("0").rstrip(".")


def brief_capture_depth_lines(blocker: dict[str, Any]) -> list[str]:
    selected = blocker.get("selectedClips")
    recommended = blocker.get("recommendedClips")
    duration = blocker.get("totalDurationSec")
    recommended_duration = blocker.get("recommendedDurationSec")
    missing_presets = string_list(blocker.get("missingPronunciationPresetIds"))
    lines: list[str] = []
    if isinstance(selected, (int, float)) or isinstance(recommended, (int, float)):
        lines.append(
            "Capture depth: "
            f"{brief_number(selected, 0)}/{brief_number(recommended, PRODUCT_CAPTURE_CLIPS)} clips"
        )
    if isinstance(duration, (int, float)) or isinstance(recommended_duration, (int, float)):
        lines.append(
            "Capture duration: "
            f"{brief_number(duration, 0)}/{brief_number(recommended_duration, PRODUCT_CAPTURE_DURATION_SEC)}s"
        )
    if missing_presets:
        lines.append(f"Missing pronunciation coverage: {', '.join(missing_presets)}")
    return lines


def print_brief(payload: dict[str, Any]) -> None:
    lines = [
        f"Status: {payload['status']}",
        f"Profile: {payload['profileJson']}",
        f"Kit: {payload['kitManifest']}",
    ]
    blocker = payload.get("firstBlocker")
    if isinstance(blocker, dict):
        lines.append(f"First blocker: {blocker.get('id')} - {blocker.get('status')}")
        message = blocker.get("message")
        if isinstance(message, str) and message.strip():
            lines.append(f"Message: {message.strip()}")
        missing_clips = blocker.get("missingClips")
        if isinstance(missing_clips, list) and missing_clips:
            lines.append(f"Missing clips: {', '.join(str(clip) for clip in missing_clips)}")
        capture_depth_lines = brief_capture_depth_lines(blocker)
        if capture_depth_lines:
            lines.extend(["", *capture_depth_lines])
        first_clip = blocker.get("firstMissingClip")
        if isinstance(first_clip, dict):
            clip_id = str(first_clip.get("id") or "").strip()
            if clip_id:
                lines.extend(["", f"Next missing clip: {clip_id}"])
            transcript = str(first_clip.get("transcript") or "").strip()
            if transcript:
                lines.append(f"Transcript: {transcript}")
        preflight = blocker.get("recordingPreflight")
        if isinstance(preflight, dict):
            lines.extend(["", f"Recording preflight: {preflight.get('status') or 'unknown'}"])
            message = str(preflight.get("message") or "").strip()
            if message:
                lines.append(f"Preflight message: {message}")
            recorder = preflight.get("recorder") if isinstance(preflight.get("recorder"), dict) else {}
            if recorder:
                configured = "yes" if recorder.get("configured") else "no"
                source = str(recorder.get("source") or "unknown")
                lines.append(f"Recorder: {configured} ({source})")
            guidance = preflight.get("recordingGuidance") if isinstance(preflight.get("recordingGuidance"), dict) else {}
            if guidance:
                if guidance.get("durationMode") == "auto":
                    target = "auto per clip"
                else:
                    target = f"{guidance.get('targetDurationSec')}s per clip"
                lines.append(
                    "Target: "
                    f"{target}, "
                    f"{guidance.get('minDurationSec')}-{guidance.get('maxDurationSec')}s allowed, "
                    f">={guidance.get('minActiveVoiceSec')}s active voice"
                )
    else:
        lines.append("First blocker: none")

    command_lines: list[str] = []
    print_command_line(command_lines, "Open cue sheet", payload.get("nextOpenCueSheetCommand"))
    print_command_line(command_lines, "Mic smoke test", payload.get("nextMicrophoneSmokeTestCommand"))
    print_command_line(command_lines, "Preflight brief", payload.get("nextBriefCommand"))
    print_command_line(command_lines, "Normalize phone files", payload.get("nextNormalizeExternalRecordingsCommand"))
    print_command_line(command_lines, "Normalize present phone files", payload.get("nextNormalizePresentExternalRecordingsCommand"))
    if isinstance(blocker, dict) and isinstance(blocker.get("firstMissingClip"), dict):
        print_command_line(command_lines, "Focused clip command", blocker["firstMissingClip"].get("recordCommand"))
    next_command_label = (
        "Normalize present phone files"
        if isinstance(blocker, dict)
        and blocker.get("id") == "recording_kit"
        and isinstance(blocker.get("pendingExternalRecordings"), list)
        and blocker.get("pendingExternalRecordings")
        else ("Record missing clips" if isinstance(blocker, dict) and blocker.get("id") == "recording_kit" else "Next command")
    )
    print_command_line(command_lines, next_command_label, payload.get("nextCommand"))
    print_command_line(command_lines, "Product proof after recording", payload.get("nextProductProofCommand"))
    print_command_line(command_lines, "LoRA handoff after product proof", payload.get("nextLoraHandoffCommand"))
    print_command_line(command_lines, "Proof environment check", payload.get("nextProofEnvironmentCommand"))
    profile_reference_commands = (
        payload.get("nextProfileReferenceRecordingCommands")
        if isinstance(payload.get("nextProfileReferenceRecordingCommands"), list)
        else []
    )
    print_command_line(command_lines, "Profile reference batch", payload.get("nextProfileReferenceRecordingBatchCommand"))
    print_command_line(
        command_lines,
        "Post profile-reference proof",
        payload.get("nextPostProfileReferenceRecordingProofCommand"),
    )
    for index, row in enumerate(profile_reference_commands, start=1):
        if not isinstance(row, dict):
            continue
        label = f"Profile reference clip {index}"
        preset_id = row.get("presetId")
        clip_id = row.get("clipId")
        details = " / ".join(str(value) for value in (preset_id, clip_id) if isinstance(value, str) and value)
        print_command_line(command_lines, f"{label} ({details})" if details else label, row.get("recordCommand"))
    quality_gate_probes = (
        payload.get("nextQualityGateProbeCommands")
        if isinstance(payload.get("nextQualityGateProbeCommands"), list)
        else []
    )
    for index, row in enumerate(quality_gate_probes, start=1):
        if not isinstance(row, dict):
            continue
        case_id = row.get("caseId")
        label = f"Quality probe {index}"
        print_command_line(command_lines, f"{label} ({case_id})" if isinstance(case_id, str) and case_id else label, row.get("command"))
    repair_actions = (
        payload.get("nextQualityGateRepairActions")
        if isinstance(payload.get("nextQualityGateRepairActions"), list)
        else []
    )
    repair_lines: list[str] = []
    for row in repair_actions:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "repair")
        priority = row.get("priority")
        case_id = row.get("caseId")
        status = row.get("status")
        suffix = f" ({case_id})" if isinstance(case_id, str) and case_id else ""
        label = f"P{priority} {kind}{suffix}" if isinstance(priority, int) else f"{kind}{suffix}"
        if isinstance(status, str) and status.strip():
            label = f"{label} [{status.strip()}]"
        print_command_line(repair_lines, label, row.get("command"))
        blocked_until = row.get("blockedUntil")
        if isinstance(blocked_until, str) and blocked_until.strip():
            repair_lines.append(f"  blockedUntil: {blocked_until.strip()}")
        proof_scope = row.get("proofScope")
        if isinstance(proof_scope, str) and proof_scope.strip():
            repair_lines.append(f"  scope: {proof_scope.strip()}")
        renderer_status = row.get("rendererStatus")
        renderer_env = row.get("rendererCommandEnv")
        if isinstance(renderer_status, str) and renderer_status.strip():
            details = renderer_status.strip()
            missing_envs = row.get("missingRendererCommandEnvs")
            if isinstance(missing_envs, list) and missing_envs:
                env_text = ", ".join(str(env) for env in missing_envs if isinstance(env, str) and env.strip())
                if env_text:
                    details = f"{details}; missing envs: {env_text}"
            elif isinstance(renderer_env, str) and renderer_env.strip():
                details = f"{details}; env: {renderer_env.strip()}"
            total_renders = row.get("totalRenders")
            missing_renders = row.get("missingRenders")
            if isinstance(total_renders, int) and isinstance(missing_renders, int):
                details = f"{details}; missing: {missing_renders}/{total_renders}"
            repair_lines.append(f"  renderer: {details}")
        preflight = row.get("rendererPreflight")
        if isinstance(preflight, dict):
            blocking = preflight.get("blockingBackends")
            if isinstance(blocking, list) and blocking:
                repair_lines.append(
                    "  preflight blockers: "
                    + ", ".join(str(item) for item in blocking if isinstance(item, str) and item.strip())
                )
            backend_rows = preflight.get("backends")
            if isinstance(backend_rows, list):
                for backend_row in backend_rows:
                    if not isinstance(backend_row, dict):
                        continue
                    missing = backend_row.get("missingRenders")
                    status_value = backend_row.get("status")
                    backend_name = backend_row.get("backend")
                    if not missing or not isinstance(backend_name, str) or not isinstance(status_value, str):
                        continue
                    repair_lines.append(f"  - {backend_name}: {status_value}")
    if repair_lines:
        lines.extend(["", "Quality gate repair queue:", *repair_lines])
    if command_lines:
        lines.extend(["", "Commands:", *command_lines])

    stages = payload.get("stages") if isinstance(payload.get("stages"), list) else []
    proof_stage = next((stage for stage in stages if isinstance(stage, dict) and stage.get("id") == "proof_environment"), None)
    if isinstance(proof_stage, dict):
        backend_lines = [
            line
            for line in [
                brief_backend_line("ASR", proof_stage.get("asr")),
                brief_backend_line("Speaker", proof_stage.get("speaker")),
            ]
            if line
        ]
        if backend_lines:
            lines.extend(["", "Proof environment:", *backend_lines])

    if stages:
        lines.extend(["", "Stages:"])
        for row in stages:
            if not isinstance(row, dict):
                continue
            lines.append(f"- {row.get('id')}: {row.get('status')}")

    print("\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit whether AnyVoice has reached the 10x digital-voice-clone completion bar.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--kit-manifest", default=str(DEFAULT_KIT_MANIFEST))
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--lora-dataset-root", default=str(DEFAULT_LORA_DATASET_ROOT))
    parser.add_argument("--lora-training-job-root", default=str(DEFAULT_LORA_TRAINING_JOB_ROOT))
    parser.add_argument("--backend-selection-root", default=str(DEFAULT_BACKEND_SELECTION_ROOT))
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON. This is the default unless --brief is used.")
    parser.add_argument("--brief", action="store_true", help="Print a compact operator checklist instead of JSON.")
    parser.add_argument("--fail-unless-complete", action="store_true")
    args = parser.parse_args()
    if args.brief and args.json:
        parser.error("--brief and --json cannot be used together")

    profile = Path(args.profile_json).expanduser().resolve()
    kit_manifest = Path(args.kit_manifest).expanduser().resolve()
    transcript_validation = latest_transcript_validation_for_profile(profile) if profile.exists() else None
    dataset_root = Path(args.lora_dataset_root).expanduser().resolve()
    training_root = Path(args.lora_training_job_root).expanduser().resolve()
    backend_selection_root = Path(args.backend_selection_root).expanduser().resolve()
    quality_report = latest_absolute_quality_gate(profile)
    product_report = latest_product_quality_gate(profile)

    stages = [
        audit_recording_kit(kit_manifest, args.profile_id, profile),
        audit_strict_profile(profile, transcript_validation),
        audit_capture_depth(profile),
        audit_proof_environment(),
        audit_quality_gate(profile, quality_report),
        audit_product_proof(profile, product_report),
        audit_subjective_review(product_report),
        audit_lora_dataset(profile, dataset_root),
        audit_lora_training_job(profile, training_root),
        audit_lora_adapter(profile, training_root),
        audit_lora_quality_gate(profile, training_root),
        audit_backend_selection(profile, backend_selection_root),
    ]
    requirements = completion_requirements(stages)
    first_incomplete_requirement = next((row for row in requirements if row.get("ok") is not True), None)
    required_stage_ids = {str(row.get("stageId") or row.get("id") or "") for row in requirements}
    optional_stages = [row for row in stages if str(row.get("id") or "") in OPTIONAL_STAGE_IDS]
    first_required_blocker = next(
        (
            row
            for row in stages
            if str(row.get("id") or "") in required_stage_ids and row.get("status") != "pass"
        ),
        None,
    )
    first_optional_issue = next((row for row in optional_stages if row.get("status") != "pass"), None)
    first_completion_blocking_optional_issue = next(
        (row for row in optional_stages if optional_stage_blocks_completion(row, profile)),
        None,
    )
    complete = first_incomplete_requirement is None and first_completion_blocking_optional_issue is None
    first_blocker = first_required_blocker or first_completion_blocking_optional_issue
    backend_shootout_render_plan = latest_backend_shootout_render_plan(backend_selection_root, profile)
    backend_shootout_render_command = (
        str(backend_shootout_render_plan.get("renderScript"))
        if isinstance(backend_shootout_render_plan, dict)
        and isinstance(backend_shootout_render_plan.get("renderScript"), str)
        and str(backend_shootout_render_plan.get("renderScript")).strip()
        else None
    )
    command_map = next_step_commands(
        profile_path=profile,
        kit_manifest=kit_manifest,
        profile_id=args.profile_id,
        transcript_validation_json=transcript_validation,
        transcript_asr_json=None,
        quality_gate_json=Path(str(product_report["json"])).expanduser().resolve()
        if isinstance(product_report, dict)
        and product_quality_gate_passed(product_report)
        and isinstance(product_report.get("json"), str)
        else None,
        record_countdown_sec=2,
    )
    payload = {
        "status": "complete" if complete else "blocked",
        "complete": complete,
        "profileJson": str(profile),
        "kitManifest": str(kit_manifest),
        "stages": stages,
        "completionRequirements": requirements,
        "optionalStages": optional_stages,
        "firstBlocker": first_blocker,
        "firstIncompleteRequirement": first_incomplete_requirement,
        "firstOptionalIssue": first_optional_issue,
        "firstCompletionBlockingOptionalIssue": first_completion_blocking_optional_issue,
        "backendShootoutRendererStatus": backend_shootout_render_plan,
        "nextCommand": None
        if complete
        else next_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
            profile=profile,
            transcript_validation=transcript_validation,
            quality_report=quality_report,
            product_report=product_report,
            dataset_root=dataset_root,
            training_root=training_root,
            backend_selection_root=backend_selection_root,
            backend_shootout_render_command=backend_shootout_render_command,
        ),
        "nextBriefCommand": None
        if complete
        else brief_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextOpenCueSheetCommand": None
        if complete
        else open_cue_sheet_command_for_blocker(
            blocker=first_blocker,
            kit_manifest=kit_manifest,
        ),
        "nextProfileReferenceRecordingCommands": []
        if complete
        else profile_reference_recording_commands(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextProfileReferenceRecordingBatchCommand": None
        if complete
        else profile_reference_recording_batch_command(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextPostProfileReferenceRecordingProofCommand": None
        if complete
        else post_profile_reference_recording_proof_command(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
            profile=profile,
        ),
        "nextQualityGateProbeCommands": []
        if complete
        else quality_gate_probe_commands(first_blocker, command_map.get("qualityGate")),
        "nextQualityGateRepairActions": []
        if complete
        else quality_gate_repair_actions(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
            profile=profile,
            base_quality_gate_command=command_map.get("qualityGate"),
            backend_shootout_command=command_map.get("prepareBackendShootout"),
            backend_shootout_render_command=backend_shootout_render_command,
            backend_shootout_render_plan=backend_shootout_render_plan,
        ),
        "nextMicrophoneSmokeTestCommand": None
        if complete
        else microphone_smoke_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextNormalizeExternalRecordingsCommand": None
        if complete
        else normalize_external_recordings_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextNormalizePresentExternalRecordingsCommand": None
        if complete
        else normalize_present_external_recordings_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextProductProofCommand": None
        if complete
        else product_proof_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
        "nextProofEnvironmentCommand": None if complete else proof_environment_command(stages),
        "nextLoraHandoffCommand": None
        if complete
        else lora_handoff_command_for_blocker(
            blocker=first_blocker,
            profile_id=args.profile_id,
            kit_manifest=kit_manifest,
        ),
    }
    if args.brief:
        print_brief(payload)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if args.fail_unless_complete and not complete:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

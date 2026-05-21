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
    latest_quality_gate_for_profile,
    latest_transcript_validation_for_profile,
    product_proof_asr_backend,
    product_proof_speaker_backend,
    quality_gate_root,
    strict_profile_quality_gate_passed,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LORA_DATASET_ROOT = REPO_ROOT / "generated" / "voice-lora-datasets"
DEFAULT_LORA_TRAINING_JOB_ROOT = REPO_ROOT / "generated" / "voice-lora-training-jobs"
PRODUCT_CAPTURE_CLIPS = 10
PRODUCT_CAPTURE_DURATION_SEC = 60.0
PRODUCT_PRONUNCIATION_PRESETS = [
    ("polyphone:chongqing", ["重慶", "重庆"]),
    ("polyphone:bank", ["銀行", "银行"]),
    ("polyphone:role", ["角色"]),
    ("polyphone:music", ["音樂", "音乐"]),
    ("polyphone:changle", ["長樂", "长乐"]),
    ("polyphone:bank-president", ["行長", "行长"]),
    ("brand:anyvoice", ["AnyVoice"]),
    ("brand:voxcpm2", ["VoxCPM2"]),
]
PRODUCT_PRONUNCIATION_PRESET_IDS = [preset_id for preset_id, _terms in PRODUCT_PRONUNCIATION_PRESETS]


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


def same_path(raw: Any, expected: Path) -> bool:
    return isinstance(raw, str) and Path(raw).expanduser().resolve() == expected.resolve()


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
    raw = clip.get("pronunciationPresetIds")
    if isinstance(raw, list):
        return {str(item) for item in raw if isinstance(item, str) and item}
    return pronunciation_preset_ids_from_text(str(clip.get("transcriptRaw") or ""))


def profile_pronunciation_preset_ids(profile_payload: dict[str, Any]) -> set[str]:
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    ids: set[str] = set()
    for clip in clips:
        if isinstance(clip, dict):
            ids.update(clip_pronunciation_preset_ids(clip))
    return ids


def profile_has_product_capture_depth(profile: Path) -> tuple[bool, int, float]:
    profile_payload = load_json(profile)
    if not profile_payload:
        return False, 0, 0.0
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    summary = profile_payload.get("summary") if isinstance(profile_payload.get("summary"), dict) else {}
    selected = summary.get("selectedClips")
    selected_clips = int(selected) if isinstance(selected, int) else len(clips)
    total_duration = round(profile_capture_duration(profile_payload), 3)
    covered_ids = profile_pronunciation_preset_ids(profile_payload)
    missing_ids = [preset_id for preset_id in PRODUCT_PRONUNCIATION_PRESET_IDS if preset_id not in covered_ids]
    return (
        selected_clips >= PRODUCT_CAPTURE_CLIPS and total_duration >= PRODUCT_CAPTURE_DURATION_SEC and not missing_ids,
        selected_clips,
        total_duration,
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
    has_capture_depth, selected_clips, total_duration = profile_has_product_capture_depth(profile)
    if not manifest.exists():
        if has_capture_depth:
            return stage(
                "recording_kit",
                "pass",
                "profile already has 10x capture depth, so recording kit import evidence is no longer required",
                path=str(manifest),
                selectedClips=selected_clips,
                totalDurationSec=total_duration,
                recommendedClips=PRODUCT_CAPTURE_CLIPS,
            )
        return stage(
            "recording_kit",
            "missing",
            "recording kit manifest is missing",
            path=str(manifest),
            recommendedClips=PRODUCT_CAPTURE_CLIPS,
            recommendedPromptSet="extended",
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
                "profile already has 10x capture depth, so recording kit check output is no longer required",
                path=str(manifest),
                selectedClips=selected_clips,
                totalDurationSec=total_duration,
                recommendedClips=PRODUCT_CAPTURE_CLIPS,
                run=meta,
            )
        return stage("recording_kit", "blocked", "recording kit check did not return JSON", run=meta)
    status = "pass" if payload.get("status") == "ready_to_import" else "blocked"
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else None
    missing_clips: list[str] = []
    checks = payload.get("checks") if isinstance(payload.get("checks"), list) else []
    for check in checks:
        if not isinstance(check, dict) or check.get("check") != "audio_files":
            continue
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
            "profile already has 10x capture depth, so stale recording kit state does not block completion",
            path=str(manifest),
            clipCount=summary.get("clips") if summary else None,
            selectedClips=selected_clips,
            totalDurationSec=total_duration,
            recommendedClips=PRODUCT_CAPTURE_CLIPS,
            summary=summary,
            run=meta,
        )
    return stage(
        "recording_kit",
        status,
        message,
        path=str(manifest),
        clipCount=summary.get("clips") if summary else None,
        recommendedClips=PRODUCT_CAPTURE_CLIPS,
        recommendedPromptSet="extended" if summary and isinstance(summary.get("clips"), int) and summary.get("clips") < PRODUCT_CAPTURE_CLIPS else None,
        summary=summary,
        missingClips=missing_clips,
        firstMissingClip=first_missing_clip,
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
    profile_payload = load_json(profile)
    if not profile_payload:
        return stage(
            "capture_depth",
            "missing",
            "voice profile JSON is missing, so capture depth cannot be audited",
            recommendedClips=PRODUCT_CAPTURE_CLIPS,
            recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
        )
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    summary = profile_payload.get("summary") if isinstance(profile_payload.get("summary"), dict) else {}
    selected = summary.get("selectedClips")
    selected_clips = int(selected) if isinstance(selected, int) else len(clips)
    total_duration = round(profile_capture_duration(profile_payload), 3)
    covered_ids = profile_pronunciation_preset_ids(profile_payload)
    missing_pronunciation_preset_ids = [
        preset_id for preset_id in PRODUCT_PRONUNCIATION_PRESET_IDS if preset_id not in covered_ids
    ]
    ok = (
        selected_clips >= PRODUCT_CAPTURE_CLIPS
        and total_duration >= PRODUCT_CAPTURE_DURATION_SEC
        and not missing_pronunciation_preset_ids
    )
    return stage(
        "capture_depth",
        "pass" if ok else "blocked",
        "profile has 10x capture depth"
        if ok
        else "profile has only minimum capture depth or missing exact pronunciation preset coverage; record the extended 10-clip kit for a stable 10x clone",
        selectedClips=selected_clips,
        totalDurationSec=total_duration,
        recommendedClips=PRODUCT_CAPTURE_CLIPS,
        recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
        requiredPronunciationPresetIds=PRODUCT_PRONUNCIATION_PRESET_IDS,
        missingPronunciationPresetIds=missing_pronunciation_preset_ids,
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
    if not report or report.get("status") != "pass" or report.get("dryRun") is not False:
        return False
    inputs = report.get("inputs")
    proofs = report.get("proofs")
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
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
        and "require-paired-improvement" in str(report.get("commands", {}).get("score") if isinstance(report.get("commands"), dict) else "")
    )


def lora_quality_gate_passed(report: dict[str, Any] | None, adapter_path: Path) -> bool:
    if not strict_profile_quality_gate_passed(report):
        return False
    inputs = report.get("inputs") if isinstance(report, dict) else None
    proofs = report.get("proofs") if isinstance(report, dict) else None
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    speaker = proofs.get("speakerBackendRequirement")
    speaker_ok = (
        isinstance(speaker, dict)
        and speaker.get("required") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker.get("selected") == PRODUCT_PROOF_SPEAKER_BACKEND
    )
    return (
        inputs.get("cloneMode") == "hifi"
        and same_path(inputs.get("loraPath"), adapter_path)
        and inputs.get("requireSpeakerBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker_ok
    )


def latest_product_quality_gate(profile: Path) -> dict[str, Any] | None:
    root = quality_gate_root()
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
        if not same_path(inputs.get("profileJson"), profile):
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
        if product_quality_gate_passed(report):
            matches.append((str(report["createdAt"]), path.resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def latest_lora_quality_gate(profile: Path, adapter_path: Path) -> dict[str, Any] | None:
    root = quality_gate_root()
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
        if not same_path(inputs.get("profileJson"), profile):
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
        if lora_quality_gate_passed(report, adapter_path):
            matches.append((str(report["createdAt"]), path.resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def audit_quality_gate(profile: Path, report: dict[str, Any] | None = None) -> dict[str, Any]:
    report = report or latest_quality_gate_for_profile(profile)
    if strict_profile_quality_gate_passed(report):
        return stage(
            "quality_gate",
            "pass",
            "latest matching non-dry-run quality gate passed",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
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
        )
    return stage(
        "product_10x_proof",
        "missing",
        "no passing paired product quality gate with speechbrain-ecapa was found",
    )


def blind_order_key(case_id: str, repeat: int, clone_mode: str, output_wav: str) -> str:
    token = f"{case_id}\0{repeat}\0{clone_mode}\0{output_wav}".encode("utf-8")
    return hashlib.sha256(token).hexdigest()


def build_subjective_review_rounds(report: dict[str, Any]) -> list[dict[str, Any]]:
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
            repeat = int(render.get("repeat") or 1)
            key = (case_id, repeat)
            if key not in rounds:
                rounds[key] = {"caseId": case_id, "repeat": repeat, "samples": []}
                order.append(key)
            rounds[key]["samples"].append(
                {
                    "cloneMode": clone_mode or str(render.get("cloneMode") or ""),
                    "outputWav": str(render.get("outputWav") or ""),
                }
            )

    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    result: list[dict[str, Any]] = []
    for key in order:
        item = rounds[key]
        samples = item["samples"]
        clone_modes = {str(sample.get("cloneMode") or "") for sample in samples}
        if not {"prompt", "hifi"}.issubset(clone_modes):
            continue
        case_id = str(item["caseId"])
        repeat = int(item["repeat"])
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
    return result


def review_json_candidates(product_report: dict[str, Any], report_path: Path) -> list[Path]:
    paths = product_report.get("paths") if isinstance(product_report.get("paths"), dict) else {}
    explicit = paths.get("subjectiveReview") or paths.get("review")
    candidates: list[Path] = []
    if isinstance(explicit, str) and explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.extend(
        [
            report_path.parent / "review.json",
            report_path.with_suffix(".review.json"),
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
    choices = review.get("choices") if isinstance(review, dict) and isinstance(review.get("choices"), dict) else None
    if not isinstance(choices, dict):
        return stage("subjective_review", "blocked", "blind review JSON does not contain choices", reviewJson=str(review_path))

    rounds = build_subjective_review_rounds(report)
    if not rounds:
        return stage(
            "subjective_review",
            "blocked",
            "product regression report has no prompt-vs-hifi blind rounds",
            report=str(report_path),
            reviewJson=str(review_path),
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

    total = len(rounds)
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
    if candidate_win_rate < 0.8:
        return stage(
            "subjective_review",
            "blocked",
            "hifi candidate did not reach the 80% blind preference bar",
            report=str(report_path),
            reviewJson=str(review_path),
            stats=stats,
        )
    return stage(
        "subjective_review",
        "pass",
        "subjective blind A/B review passed the 80% preference bar",
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


def audit_lora_dataset(profile: Path, root: Path) -> dict[str, Any]:
    match = latest_matching_json(
        root,
        "**/dataset.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
    )
    if not match:
        return stage("lora_dataset", "missing", "no LoRA dataset export found", root=str(root))
    path, payload = match
    proofs = payload.get("proofs") if isinstance(payload.get("proofs"), dict) else {}
    bypass = proofs.get("bypass") if isinstance(proofs.get("bypass"), dict) else {}
    transcript_json = proofs.get("transcriptValidationJson")
    quality_json = proofs.get("qualityGateJson")
    quality_gate_report: dict[str, Any] | None = None
    if isinstance(quality_json, str) and Path(quality_json).expanduser().exists():
        quality_path = Path(quality_json).expanduser().resolve()
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
    product_quality_gate_ok = bool(
        quality_gate_report
        and isinstance(quality_gate_report.get("inputs"), dict)
        and same_path(quality_gate_report["inputs"].get("profileJson"), profile)
        and product_quality_gate_passed(quality_gate_report)
    )
    ok = (
        isinstance(transcript_json, str)
        and Path(transcript_json).expanduser().exists()
        and isinstance(quality_json, str)
        and Path(quality_json).expanduser().exists()
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
        else "LoRA dataset exists but proof metadata or 10-clip capture depth is incomplete",
        datasetJson=str(path),
        totalClips=payload.get("totalClips"),
        totalDurationSec=payload.get("totalDurationSec"),
        recommendedClips=PRODUCT_CAPTURE_CLIPS,
        recommendedDurationSec=PRODUCT_CAPTURE_DURATION_SEC,
        proofs=proofs,
        productQualityGateOk=product_quality_gate_ok,
    )


def audit_lora_training_job(profile: Path, root: Path) -> dict[str, Any]:
    match = latest_matching_json(
        root,
        "**/train_config.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
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
    env_trainer_command = bool(str(os.environ.get("ANYVOICE_VOXCPM_TRAINER_COMMAND") or "").strip())
    config_trainer_command = isinstance(trainer.get("commandTemplate"), str) and bool(str(trainer.get("commandTemplate")).strip())
    trainer_ready = trainer.get("status") == "ready" and config_trainer_command
    command_configured = trainer_ready or env_trainer_command
    if proof_status in {"pass", "metadata_pass"}:
        return stage(
            "lora_training_job",
            "pass",
            "LoRA training job has adapter proof evidence",
            trainConfig=str(path),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
            adapterProofStatus=proof_status,
        )
    if command_configured:
        return stage(
            "lora_training_job",
            "pass",
            "LoRA training job is ready to run",
            trainConfig=str(path),
            trainerStatus=trainer.get("status"),
            trainerCommandConfigured=command_configured,
            trainerCommandSource="env:ANYVOICE_VOXCPM_TRAINER_COMMAND" if env_trainer_command and not trainer_ready else "train_config",
            trainScript=trainer.get("trainScript"),
            expectedWeights=lora.get("expectedWeights"),
            adapterProof=str(proof_path) if proof_path else None,
        )
    return stage(
        "lora_training_job",
        "blocked",
        "LoRA training job exists but has no trainer command or adapter proof",
        trainConfig=str(path),
        trainerStatus=trainer.get("status"),
        trainerCommandConfigured=False,
        trainScript=trainer.get("trainScript"),
        expectedWeights=lora.get("expectedWeights"),
        adapterProof=str(proof_path) if proof_path else None,
        adapterProofStatus=proof_status or None,
    )


def audit_lora_adapter(profile: Path, training_root: Path) -> dict[str, Any]:
    training = latest_matching_json(
        training_root,
        "**/train_config.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
    )
    if not training:
        return stage("lora_adapter", "missing", "no training job exists, so no adapter proof can be checked")
    _config_path, config = training
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    proof_path = Path(str(lora.get("adapterProof") or "")).expanduser()
    if not str(proof_path):
        return stage("lora_adapter", "missing", "training config does not name adapterProof")
    proof = load_json(proof_path)
    if not proof:
        return stage("lora_adapter", "missing", "adapter proof JSON is missing", adapterProof=str(proof_path))
    status = str(proof.get("status") or "")
    if status == "pass":
        proofs = proof.get("datasetProofs") if isinstance(proof.get("datasetProofs"), dict) else {}
        if proofs.get("productProofQualityGateRequired") is not True:
            return stage(
                "lora_adapter",
                "blocked",
                "adapter proof does not preserve paired product-proof dataset evidence",
                adapterProof=str(proof_path),
            )
        return stage("lora_adapter", "pass", "readable LoRA adapter proof passed", adapterProof=str(proof_path))
    if status == "metadata_pass":
        return stage(
            "lora_adapter",
            "partial",
            "adapter metadata passed, but checkpoint tensor keys were not inspected",
            adapterProof=str(proof_path),
            warnings=proof.get("warnings"),
        )
    return stage("lora_adapter", "blocked", "adapter proof is not passing", adapterProof=str(proof_path), adapterStatus=status)


def adapter_path_from_proof_or_config(proof: dict[str, Any] | None, config: dict[str, Any], config_dir: Path) -> Path | None:
    adapter = proof.get("adapter") if proof and isinstance(proof.get("adapter"), dict) else {}
    raw_path = adapter.get("path") if isinstance(adapter, dict) else None
    if isinstance(raw_path, str) and raw_path.strip():
        return Path(raw_path).expanduser().resolve()
    lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
    return resolve_config_path(lora.get("expectedWeights"), config_dir)


def audit_lora_quality_gate(profile: Path, training_root: Path) -> dict[str, Any]:
    training = latest_matching_json(
        training_root,
        "**/train_config.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
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
    adapter_path = adapter_path_from_proof_or_config(proof, config, config_path.parent)
    if not adapter_path:
        return stage("lora_quality_gate", "missing", "adapter path is missing from proof and training config")
    report = latest_lora_quality_gate(profile, adapter_path)
    if report:
        return stage(
            "lora_quality_gate",
            "pass",
            "LoRA adapter quality gate passed with the verified adapter loaded",
            qualityGateJson=report.get("json"),
            createdAt=report.get("createdAt"),
            adapterPath=str(adapter_path),
        )
    return stage(
        "lora_quality_gate",
        "missing",
        "no passing non-dry-run quality gate was found with the verified LoRA adapter loaded",
        adapterPath=str(adapter_path),
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


def latest_lora_dataset_json(profile: Path, root: Path) -> Path | None:
    match = latest_matching_json(
        root,
        "**/dataset.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
    )
    return match[0] if match else None


def latest_lora_train_config(profile: Path, root: Path) -> Path | None:
    match = latest_matching_json(
        root,
        "**/train_config.json",
        lambda payload, _path: same_path(payload.get("profilePath"), profile),
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
        return cmd_map["qualityGate"]
    if blocker_id == "product_10x_proof":
        return cmd_map["qualityGateProductProof"]
    if blocker_id == "subjective_review":
        report_raw = blocker.get("report")
        report_path = Path(str(report_raw)).expanduser().resolve() if isinstance(report_raw, str) and report_raw else None
        if report_path is None and product_report and isinstance(product_report.get("paths"), dict):
            raw = product_report["paths"].get("report")
            if isinstance(raw, str) and raw:
                report_path = Path(raw).expanduser().resolve()
        review_candidates = blocker.get("expectedReviewJson") if isinstance(blocker.get("expectedReviewJson"), list) else []
        review_path = str(review_candidates[0]) if review_candidates else (str(report_path.parent / "review.json") if report_path else "review.json")
        html_path = str(report_path.with_suffix(".html")) if report_path else "the product proof report.html"
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
        dataset_json = latest_lora_dataset_json(profile, dataset_root)
        train_script = blocker.get("trainScript")
        if isinstance(train_script, str) and train_script.strip():
            if blocker.get("trainerCommandConfigured") is False:
                return (
                    "ANYVOICE_VOXCPM_TRAINER_COMMAND='python /path/to/train_voxcpm_lora.py "
                    "--config {config} --output-dir {output_dir} --adapter {adapter_path}' "
                    + shell_join(["bash", train_script])
                )
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
        train_config = latest_lora_train_config(profile, training_root)
        config = load_json(train_config) if train_config else None
        if config and train_config:
            lora = config.get("lora") if isinstance(config.get("lora"), dict) else {}
            proof_path = resolve_config_path(lora.get("adapterProof"), train_config.parent)
            proof = load_json(proof_path) if proof_path else None
            adapter_path = adapter_path_from_proof_or_config(proof, config, train_config.parent)
            if proof and isinstance(proof.get("nextCommands"), dict):
                command_text = proof["nextCommands"].get("qualityGateWithAdapter")
                if isinstance(command_text, str) and command_text.strip():
                    return command_text
            if adapter_path:
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
                        ]
                    )
                )
        return None
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
    if isinstance(blocker, dict) and isinstance(blocker.get("firstMissingClip"), dict):
        print_command_line(command_lines, "Focused clip command", blocker["firstMissingClip"].get("recordCommand"))
    next_command_label = "Record missing clips" if isinstance(blocker, dict) and blocker.get("id") == "recording_kit" else "Next command"
    print_command_line(command_lines, next_command_label, payload.get("nextCommand"))
    print_command_line(command_lines, "Product proof after recording", payload.get("nextProductProofCommand"))
    print_command_line(command_lines, "LoRA handoff after product proof", payload.get("nextLoraHandoffCommand"))
    print_command_line(command_lines, "Proof environment check", payload.get("nextProofEnvironmentCommand"))
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
    parser.add_argument("--brief", action="store_true", help="Print a compact operator checklist instead of JSON.")
    parser.add_argument("--fail-unless-complete", action="store_true")
    args = parser.parse_args()

    profile = Path(args.profile_json).expanduser().resolve()
    kit_manifest = Path(args.kit_manifest).expanduser().resolve()
    transcript_validation = latest_transcript_validation_for_profile(profile) if profile.exists() else None
    dataset_root = Path(args.lora_dataset_root).expanduser().resolve()
    training_root = Path(args.lora_training_job_root).expanduser().resolve()
    quality_report = latest_quality_gate_for_profile(profile)
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
    ]
    complete = all(row["status"] == "pass" for row in stages)
    first_blocker = next((row for row in stages if row["status"] != "pass"), None)
    payload = {
        "status": "complete" if complete else "blocked",
        "complete": complete,
        "profileJson": str(profile),
        "kitManifest": str(kit_manifest),
        "stages": stages,
        "firstBlocker": first_blocker,
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

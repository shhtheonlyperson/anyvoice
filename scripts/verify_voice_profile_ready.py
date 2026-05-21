from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any

from build_voice_profile import (
    CHINESE_SCRIPT_MARKER_PAIRS,
    REQUIRED_PRONUNCIATION_PRESET_IDS,
    detect_chinese_script,
    pronunciation_preset_ids,
    strict_traditional_script_errors,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
DEFAULT_REQUIRED_COVERAGE_FEATURES = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"]
DEFAULT_PASSING_GRADES = ["A", "B"]
PRODUCT_CAPTURE_CLIPS = 10
PRODUCT_CAPTURE_DURATION_SEC = 60.0
PRODUCT_PROMPT_SET = "extended"


def load_profile(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"voice profile not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"voice profile is not valid JSON: {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise SystemExit(f"voice profile is not a JSON object: {path}")
    return parsed


def profile_clips(profile: dict[str, Any]) -> list[dict[str, Any]]:
    clips = profile.get("clips")
    return [clip for clip in clips if isinstance(clip, dict)] if isinstance(clips, list) else []


def dict_value(profile: dict[str, Any], parent: str, key: str) -> Any:
    value = profile.get(parent)
    if isinstance(value, dict):
        return value.get(key)
    return None


def int_value(profile: dict[str, Any], parent: str, key: str, fallback: int) -> int:
    value = dict_value(profile, parent, key)
    return int(value) if isinstance(value, int) else fallback


def float_value(profile: dict[str, Any], parent: str, key: str, fallback: float) -> float:
    value = dict_value(profile, parent, key)
    return float(value) if isinstance(value, (int, float)) else fallback


def string_list_value(profile: dict[str, Any], parent: str, key: str, fallback: list[str]) -> list[str]:
    value = dict_value(profile, parent, key)
    if isinstance(value, list):
        strings = [str(item) for item in value if isinstance(item, str)]
        if strings:
            return strings
    return fallback


def diagnostics_missing_coverage(profile: dict[str, Any]) -> list[str]:
    value = dict_value(profile, "diagnostics", "missingCoverageFeatures")
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, str)]
    return []


def diagnostics_missing_pronunciation_preset_ids(profile: dict[str, Any]) -> list[str]:
    value = dict_value(profile, "diagnostics", "missingPronunciationPresetIds")
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, str)]
    return []


def diagnostics_rejection_reasons(profile: dict[str, Any]) -> list[dict[str, Any]]:
    value = dict_value(profile, "diagnostics", "rejectionReasons")
    if not isinstance(value, list):
        return []
    reasons: list[dict[str, Any]] = []
    for row in value:
        if not isinstance(row, dict):
            continue
        reason = row.get("reason")
        count = row.get("count")
        if isinstance(reason, str) and isinstance(count, int):
            reasons.append({"reason": reason, "count": count})
    return reasons


def clip_coverage(clips: list[dict[str, Any]]) -> set[str]:
    features: set[str] = set()
    for clip in clips:
        raw = clip.get("coverageFeatures")
        if isinstance(raw, list):
            features.update(str(item) for item in raw if isinstance(item, str))
    return features


def clip_pronunciation_preset_ids(clip: dict[str, Any]) -> set[str]:
    raw = clip.get("pronunciationPresetIds")
    if isinstance(raw, list):
        return {str(item) for item in raw if isinstance(item, str)}
    return set(pronunciation_preset_ids(str(clip.get("transcriptRaw") or "")))


def profile_pronunciation_preset_ids(clips: list[dict[str, Any]]) -> set[str]:
    presets: set[str] = set()
    for clip in clips:
        presets.update(clip_pronunciation_preset_ids(clip))
    return presets


def chinese_script_marker_hits(text: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for traditional, simplified in CHINESE_SCRIPT_MARKER_PAIRS:
        traditional_count = text.count(traditional)
        simplified_count = text.count(simplified)
        if traditional_count or simplified_count:
            hits.append(
                {
                    "traditional": traditional,
                    "simplified": simplified,
                    "traditionalCount": traditional_count,
                    "simplifiedCount": simplified_count,
                }
            )
    return hits


def selected_clip_source_kind(clip: dict[str, Any]) -> str:
    source_kind = clip.get("sourceKind")
    if isinstance(source_kind, str) and source_kind.strip():
        return source_kind.strip().lower()
    reference_source = clip.get("referenceSource")
    if isinstance(reference_source, dict):
        reference_kind = reference_source.get("kind")
        if isinstance(reference_kind, str) and reference_kind.strip():
            return reference_kind.strip().lower()
    return ""


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def same_resolved_path(raw_path: Any, expected_path: Path, base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve() == expected_path.resolve()


def check_transcript_validation(
    profile_path: Path,
    selected_clips: list[dict[str, Any]],
    profile_id: str,
    transcript_validation_json: Path | None,
    require_transcript_validation: bool,
) -> dict[str, Any] | None:
    if not transcript_validation_json:
        if not require_transcript_validation:
            return None
        return check(
            "transcript_validation",
            False,
            "transcript validation is required; run scripts/validate_voice_profile_transcripts.py",
        )

    payload = load_profile(transcript_validation_json)
    profile_matches = same_resolved_path(payload.get("profile"), profile_path, transcript_validation_json.parent)
    rows = transcript_validation_rows(payload)
    by_source = {str(row.get("sourceRunId") or ""): row for row in rows if row.get("sourceRunId")}
    missing: list[str] = []
    failed: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    for clip in selected_clips:
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        row = by_source.get(source_run_id)
        if not row:
            missing.append(source_run_id or "<missing sourceRunId>")
            continue
        expected_transcript = str(clip.get("transcriptRaw") or "").strip()
        raw_audio_path = str(clip.get("audioPath") or "").strip()
        expected_audio_path = resolve_audio_path(profile_path, raw_audio_path) if raw_audio_path else None
        stale_errors: list[str] = []
        if row.get("expectedTranscript") != expected_transcript:
            stale_errors.append("expected_transcript_mismatch")
        if expected_audio_path is None or not same_resolved_path(
            row.get("audioPath"),
            expected_audio_path,
            transcript_validation_json.parent,
        ):
            stale_errors.append("audio_path_mismatch")
        if stale_errors:
            stale.append(
                {
                    "sourceRunId": source_run_id,
                    "errors": stale_errors,
                    "validationAudioPath": row.get("audioPath"),
                    "profileAudioPath": str(expected_audio_path) if expected_audio_path else None,
                }
            )
        if row.get("verdict") != "pass":
            repair_clip_id = profile_clip_repair_id(clip)
            failed_row = {
                "sourceRunId": source_run_id,
                "repairClipId": repair_clip_id,
                "verdict": row.get("verdict"),
                "cer": row.get("cer"),
                "wer": row.get("wer"),
                "error": row.get("error"),
            }
            repair_command = transcript_repair_command(profile_id, repair_clip_id)
            if repair_command:
                failed_row["repairCommand"] = repair_command
            failed.append(failed_row)
    ok = profile_matches and not missing and not failed and not stale and payload.get("status") == "pass"
    return check(
        "transcript_validation",
        ok,
        "ASR transcript validation passed for selected clips"
        if ok
        else "ASR transcript validation is missing, failed, or stale for selected clips",
        {
            "validationJson": str(transcript_validation_json),
            "profile": payload.get("profile"),
            "profileMatches": profile_matches,
            "missing": missing,
            "failed": failed[:10],
            "stale": stale[:10],
            "status": payload.get("status"),
            "summary": payload.get("summary"),
        },
    )


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


def resolve_audio_path(profile_path: Path, raw_path: str) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = profile_path.parent / audio_path
    return audio_path.resolve()


def check(name: str, ok: bool, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {"check": name, "ok": ok, "message": message}
    if details:
        row["details"] = details
    return row


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def current_recording_kit_dir(profile_id: str) -> str:
    return f"generated/voice-profile-recording-kits/{profile_id}-current"


def current_recording_kit_manifest(profile_id: str) -> str:
    return f"{current_recording_kit_dir(profile_id)}/manifest.json"


def transcript_repair_command(profile_id: str, source_run_id: str) -> str | None:
    clip_id = source_run_id.strip()
    if not clip_id:
        return None
    return command(
        [
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            current_recording_kit_manifest(profile_id),
            "--clip",
            clip_id,
            "--open-cue-sheet",
            "--profile-id",
            profile_id,
            "--countdown-sec",
            "2",
            "--write-metadata",
            "--overwrite",
            "--check-selected",
        ]
    )


def profile_clip_repair_id(clip: dict[str, Any]) -> str:
    for key in ("recordingKitClipId", "recording_kit_clip_id", "manifestClipId"):
        value = clip.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return str(clip.get("sourceRunId") or "").strip()


def local_env_value(key: str) -> str:
    if key in os.environ:
        return os.environ.get(key, "").strip()
    env_path = REPO_ROOT / ".env.local"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() != key:
            continue
        return value.strip().strip('"').strip("'")
    return ""


def default_asr_python() -> str:
    return local_env_value("ANYVOICE_ASR_PYTHON") or local_env_value("ANYVOICE_VOXCPM_PYTHON") or "python3"


def recording_prescription(
    *,
    status: str,
    min_clips: int,
    selected_count: int,
    eligible_count: int,
    min_clip_duration: float,
    max_clip_duration: float,
    missing_coverage: list[str],
    missing_pronunciation_preset_ids: list[str],
    rejection_reasons: list[dict[str, Any]],
) -> dict[str, Any]:
    recommended_duration = min(max_clip_duration, max(min_clip_duration + 2, 8.0))
    active_voice_target = min(min_clip_duration, recommended_duration * 0.65)
    clips_needed = max(0, min_clips - selected_count)
    top_rejection = rejection_reasons[0]["reason"] if rejection_reasons else ""
    if status == "ready":
        message = "Profile is ready. Run regression and transcript validation before trusting production use."
    elif top_rejection == "too_short" or (clips_needed > 0 and selected_count == 0):
        message = (
            f"Record {clips_needed or min_clips} full guided profile clips; target {recommended_duration:.0f}-{max_clip_duration:.0f}s "
            f"each with at least {active_voice_target:.1f}s active voice."
        )
    else:
        message = (
            f"Record {clips_needed} more qualified profile clip(s) and fill missing coverage: "
            f"{', '.join([*missing_coverage, *missing_pronunciation_preset_ids]) if missing_coverage or missing_pronunciation_preset_ids else 'none'}."
        )
    return {
        "status": "satisfied" if status == "ready" else "needs_recording",
        "clipsNeeded": clips_needed,
        "selectedClips": selected_count,
        "eligibleClips": eligible_count,
        "durationSec": {
            "min": min_clip_duration,
            "recommended": recommended_duration,
            "max": max_clip_duration,
            "activeVoiceTarget": round(active_voice_target, 1),
        },
        "missingCoverageFeatures": missing_coverage,
        "missingPronunciationPresetIds": missing_pronunciation_preset_ids,
        "topRejectionReasons": rejection_reasons[:5],
        "promptManifest": "examples/voice_profile_import_manifest.extended.zh-Hant.json",
        "message": message,
    }


def readiness_report(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    min_clips_override: int | None,
    min_total_duration_sec: float,
    check_audio_exists: bool,
    audio_exists_bypass_reason: str | None,
    transcript_validation_json: Path | None,
    require_transcript_validation: bool,
) -> dict[str, Any]:
    clips = profile_clips(profile)
    min_clips = min_clips_override or int_value(profile, "requirements", "minClips", 5)
    max_clips = int_value(profile, "requirements", "maxClips", 10)
    min_clip_duration = float_value(profile, "requirements", "minDurationSec", 6.0)
    max_clip_duration = float_value(profile, "requirements", "maxDurationSec", 20.0)
    passing_grades = {grade.upper() for grade in string_list_value(profile, "requirements", "passingGrades", DEFAULT_PASSING_GRADES)}
    required_coverage = string_list_value(
        profile,
        "requirements",
        "requiredCoverageFeatures",
        DEFAULT_REQUIRED_COVERAGE_FEATURES,
    )
    required_pronunciation_preset_ids = string_list_value(
        profile,
        "requirements",
        "requiredPronunciationPresetIds",
        REQUIRED_PRONUNCIATION_PRESET_IDS,
    )
    selected_clips = clips[:max_clips]
    selected_count = int_value(profile, "summary", "selectedClips", len(selected_clips))
    eligible_count = int_value(profile, "summary", "eligibleClips", selected_count)
    voice_profile_id = str(profile.get("voiceProfileId") or "local-default")
    total_duration = round(sum(clip_duration(clip) for clip in selected_clips), 3)
    covered_features = clip_coverage(selected_clips)
    computed_missing_coverage = [feature for feature in required_coverage if feature not in covered_features]
    declared_missing_coverage = diagnostics_missing_coverage(profile)
    missing_coverage = sorted(set(computed_missing_coverage + declared_missing_coverage))
    covered_pronunciation_preset_ids = profile_pronunciation_preset_ids(selected_clips)
    computed_missing_pronunciation_preset_ids = [
        preset_id for preset_id in required_pronunciation_preset_ids if preset_id not in covered_pronunciation_preset_ids
    ]
    declared_missing_pronunciation_preset_ids = diagnostics_missing_pronunciation_preset_ids(profile)
    missing_pronunciation_preset_ids = sorted(
        set(computed_missing_pronunciation_preset_ids + declared_missing_pronunciation_preset_ids)
    )
    rejection_reasons = diagnostics_rejection_reasons(profile)

    checks: list[dict[str, Any]] = []
    checks.append(
        check(
            "profile_status",
            profile.get("status") == "ready",
            f"profile status is {profile.get('status') or 'missing'}",
        )
    )
    checks.append(
        check(
            "clip_count",
            selected_count >= min_clips and len(selected_clips) >= min_clips,
            f"{selected_count} selected / {eligible_count} eligible, {len(selected_clips)} manifest clips",
            {"minClips": min_clips},
        )
    )
    checks.append(
        check(
            "coverage",
            not missing_coverage,
            "all required pronunciation coverage is present" if not missing_coverage else f"missing coverage: {', '.join(missing_coverage)}",
            {"requiredCoverageFeatures": required_coverage, "coveredFeatures": sorted(covered_features)},
        )
    )
    checks.append(
        check(
            "pronunciation_presets",
            not missing_pronunciation_preset_ids,
            "all required pronunciation presets are covered"
            if not missing_pronunciation_preset_ids
            else f"missing pronunciation presets: {', '.join(missing_pronunciation_preset_ids)}",
            {
                "requiredPronunciationPresetIds": required_pronunciation_preset_ids,
                "coveredPronunciationPresetIds": sorted(covered_pronunciation_preset_ids),
            },
        )
    )
    checks.append(
        check(
            "total_duration",
            total_duration >= min_total_duration_sec,
            f"{total_duration:.3f}s selected audio / {min_total_duration_sec:.3f}s required",
        )
    )

    bad_clips: list[dict[str, Any]] = []
    missing_audio: list[dict[str, Any]] = []
    for index, clip in enumerate(selected_clips, start=1):
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        transcript = str(clip.get("transcriptRaw") or "").strip()
        declared_transcript_script = str(clip.get("transcriptScript") or "").strip()
        transcript_script = detect_chinese_script(transcript) if transcript else ""
        source_kind = selected_clip_source_kind(clip)
        raw_audio_path = str(clip.get("audioPath") or "").strip()
        grade = clip_grade(clip)
        duration = clip_duration(clip)
        clip_errors: list[str] = []
        if not source_run_id:
            clip_errors.append("missing_source_run_id")
        if not transcript:
            clip_errors.append("missing_transcript")
        else:
            clip_errors.extend(strict_traditional_script_errors(transcript))
        if declared_transcript_script and declared_transcript_script != transcript_script:
            clip_errors.append("transcript_script_mismatch")
        if not source_kind:
            clip_errors.append("missing_source_kind")
        elif source_kind not in {"scripted", "freeform", "uploaded"}:
            clip_errors.append("invalid_source_kind")
        if grade not in passing_grades:
            clip_errors.append(f"grade_{grade.lower()}")
        if duration < min_clip_duration:
            clip_errors.append("too_short")
        if duration > max_clip_duration:
            clip_errors.append("too_long")
        if not raw_audio_path:
            clip_errors.append("missing_audio_path")
        elif check_audio_exists:
            audio_path = resolve_audio_path(profile_path, raw_audio_path)
            if not audio_path.exists():
                missing_audio.append({"index": index, "sourceRunId": source_run_id or None, "audioPath": str(audio_path)})
        if clip_errors:
            bad_clips.append(
                {
                    "index": index,
                    "sourceRunId": source_run_id or None,
                    "sourceKind": source_kind or None,
                    "transcriptScript": transcript_script or None,
                    "declaredTranscriptScript": declared_transcript_script or None,
                    "scriptMarkerHits": chinese_script_marker_hits(transcript) if transcript else [],
                    "errors": clip_errors,
                }
            )

    checks.append(
        check(
            "clip_integrity",
            not bad_clips,
            "selected clips have source ids, user-recorded provenance, strict zh-Hant transcripts, passing grades, and valid durations"
            if not bad_clips
            else f"{len(bad_clips)} selected clip(s) failed integrity checks",
            {"badClips": bad_clips[:10]} if bad_clips else None,
        )
    )
    if check_audio_exists:
        checks.append(
            check(
                "audio_files",
                not missing_audio,
                "selected clip audio files exist" if not missing_audio else f"{len(missing_audio)} selected clip audio file(s) are missing",
                {"missingAudio": missing_audio[:10]} if missing_audio else None,
            )
        )
    else:
        checks.append(
            check(
                "audio_files",
                True,
                "selected clip audio file existence check skipped for migration/debug",
                {
                    "skipped": True,
                    "acceptedUnsafeBypass": True,
                    "reason": audio_exists_bypass_reason,
                },
            )
        )
    transcript_validation_check = check_transcript_validation(
        profile_path,
        selected_clips,
        voice_profile_id,
        transcript_validation_json,
        require_transcript_validation,
    )
    if transcript_validation_check:
        checks.append(transcript_validation_check)

    ready = all(row["ok"] for row in checks)
    profile_arg = str(profile_path)
    profile_transcript_validation_arg = str(profile_path.parent / "transcript-validation.json")
    effective_transcript_validation_arg = str(transcript_validation_json) if transcript_validation_json else profile_transcript_validation_arg
    asr_python = default_asr_python()
    quality_gate_command = [
        "python3",
        "scripts/run_voice_quality_gate.py",
        "--profile-json",
        profile_arg,
        "--clone-mode",
        "hifi",
        "--repeats",
        "3",
        "--asr-python",
        asr_python,
    ]
    if transcript_validation_json:
        quality_gate_command.extend(["--transcript-validation-json", str(transcript_validation_json)])
    status = "ready" if ready else "blocked"
    return {
        "status": status,
        "profile": profile_arg,
        "voiceProfileId": voice_profile_id,
        "summary": {
            "selectedClips": selected_count,
            "eligibleClips": eligible_count,
            "manifestClips": len(selected_clips),
            "totalDurationSec": total_duration,
            "missingCoverageFeatures": missing_coverage,
            "missingPronunciationPresetIds": missing_pronunciation_preset_ids,
            "minClips": min_clips,
            "minTotalDurationSec": min_total_duration_sec,
        },
        "audioFileCheck": {
            "skipped": not check_audio_exists,
            "acceptedUnsafeBypass": bool(not check_audio_exists and audio_exists_bypass_reason),
            "reason": audio_exists_bypass_reason if not check_audio_exists else None,
        },
        "checks": checks,
        "recordingPrescription": recording_prescription(
            status=status,
            min_clips=min_clips,
            selected_count=selected_count,
            eligible_count=eligible_count,
            min_clip_duration=min_clip_duration,
            max_clip_duration=max_clip_duration,
            missing_coverage=missing_coverage,
            missing_pronunciation_preset_ids=missing_pronunciation_preset_ids,
            rejection_reasons=rejection_reasons,
        ),
        "nextCommands": {
            "profileNextStep": command([
                "python3",
                "scripts/voice_profile_next_step.py",
                "--profile-json",
                profile_arg,
            ]),
            "buildProfile": command(["python3", "scripts/build_voice_profile.py", "--copy-clips"]),
            "recordingKit": command([
                "python3",
                "scripts/prepare_voice_profile_recording_kit.py",
                "--prompt-set",
                PRODUCT_PROMPT_SET,
                "--profile-id",
                voice_profile_id,
                "--out-dir",
                current_recording_kit_dir(voice_profile_id),
            ]),
            "enrollProfileKit": command([
                "python3",
                "scripts/enroll_voice_profile_kit.py",
                "--manifest",
                "generated/voice-profile-recording-kits/<kit>/manifest.json",
            ]),
            "importProfileClips": command([
                "python3",
                "scripts/import_voice_profile_clips.py",
                "--manifest",
                "examples/voice_profile_import_manifest.example.json",
                "--build-profile",
            ]),
            "qualityGate": command(quality_gate_command),
            "regression": command([
                "python3",
                "scripts/voice_clone_regression.py",
                "--profile-json",
                profile_arg,
                "--clone-mode",
                "hifi",
                "--repeats",
                "3",
            ]),
            "backendShootout": command([
                "python3",
                "scripts/prepare_voice_backend_shootout.py",
                "--profile-json",
                profile_arg,
                "--transcript-validation-json",
                effective_transcript_validation_arg,
                "--backend",
                "indextts2",
                "--backend",
                "f5-tts",
                "--repeats",
                "3",
            ]),
            "registerBackendRenders": command([
                "python3",
                "scripts/register_voice_backend_renders.py",
                "generated/voice-backend-shootouts/<timestamp>/manifest.json",
                "--out-dir",
                "generated/voice-backend-shootouts/<timestamp>/registered-report",
            ]),
            "speakerSimilarity": command([
                "python3",
                "scripts/score_speaker_similarity.py",
                "generated/voice-regression/<timestamp>/report.json",
                "--out",
                "generated/voice-regression/<timestamp>/speaker.json",
                "--strict",
            ]),
            "score": command([
                "python3",
                "scripts/score_voice_regression.py",
                "generated/voice-regression/<timestamp>/report.json",
                "--asr-json",
                "generated/voice-regression/<timestamp>/asr.json",
                "--speaker-json",
                "generated/voice-regression/<timestamp>/speaker.json",
                "--out",
                "generated/voice-regression/<timestamp>/score.json",
                "--strict",
            ]),
            "validateTranscripts": command([
                asr_python,
                "scripts/validate_voice_profile_transcripts.py",
                "--profile-json",
                profile_arg,
                "--out",
                profile_transcript_validation_arg,
                "--strict",
            ]),
            "verifyProfileStrict": command([
                "python3",
                "scripts/verify_voice_profile_ready.py",
                "--profile-json",
                profile_arg,
                "--transcript-validation-json",
                effective_transcript_validation_arg,
                "--require-transcript-validation",
            ]),
            "loraDataset": command([
                "python3",
                "scripts/prepare_voice_lora_dataset.py",
                "--profile-json",
                profile_arg,
                "--transcript-validation-json",
                effective_transcript_validation_arg,
                "--quality-gate-json",
                "generated/voice-regression/<timestamp>/quality-gate.json",
                "--require-product-proof-quality-gate",
                "--min-clips",
                str(PRODUCT_CAPTURE_CLIPS),
                "--min-total-duration-sec",
                str(PRODUCT_CAPTURE_DURATION_SEC),
                "--copy-audio",
            ]),
        },
    }


def print_human(report: dict[str, Any]) -> None:
    summary = report["summary"]
    print(f"Voice profile: {report['status']} ({report['profile']})")
    print(
        f"Clips: {summary['selectedClips']} selected / {summary['eligibleClips']} eligible; "
        f"duration: {summary['totalDurationSec']:.3f}s"
    )
    if summary["missingCoverageFeatures"]:
        print(f"Missing coverage: {', '.join(summary['missingCoverageFeatures'])}")
    if summary.get("missingPronunciationPresetIds"):
        print(f"Missing pronunciation presets: {', '.join(summary['missingPronunciationPresetIds'])}")
    for row in report["checks"]:
        marker = "PASS" if row["ok"] else "FAIL"
        print(f"- {marker} {row['check']}: {row['message']}")
    prescription = report.get("recordingPrescription")
    if report["status"] != "ready" and isinstance(prescription, dict):
        print("\nNext recording:")
        print(f"- {prescription.get('message')}")
        print(f"- Prompt manifest: {prescription.get('promptManifest')}")
        print(f"- Kit command: {report['nextCommands']['recordingKit']}")
    if report["status"] == "ready":
        print("\nNext:")
        print(report["nextCommands"]["qualityGate"])
        print(report["nextCommands"]["regression"])
        print(report["nextCommands"]["loraDataset"])
        print(report["nextCommands"]["backendShootout"])


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify an AnyVoice profile is ready for repeatable digital-voice regression and LoRA dataset export.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--min-clips", type=int, help="Override the profile minClips requirement.")
    parser.add_argument("--min-total-duration-sec", type=float, default=30.0)
    parser.add_argument("--transcript-validation-json", help="ASR validation report from scripts/validate_voice_profile_transcripts.py.")
    parser.add_argument("--require-transcript-validation", action="store_true", help="Fail unless selected profile clips have passing ASR transcript validation.")
    parser.add_argument("--skip-audio-exists", action="store_true", help="Do not check that selected clip audio paths exist on disk.")
    parser.add_argument("--allow-unsafe-audio-exists-bypass", action="store_true", help="Allow --skip-audio-exists for migration/debug verification. Requires --unsafe-audio-exists-bypass-reason.")
    parser.add_argument("--unsafe-audio-exists-bypass-reason", default="", help="Required reason when bypassing selected clip audio file existence checks.")
    parser.add_argument("--human", action="store_true", help="Print a concise human-readable report instead of JSON.")
    args = parser.parse_args()

    profile_path = Path(args.profile_json).expanduser().resolve()
    unsafe_audio_reason = args.unsafe_audio_exists_bypass_reason.strip()
    if args.skip_audio_exists and (not args.allow_unsafe_audio_exists_bypass or not unsafe_audio_reason):
        print(
            json.dumps(
                {
                    "status": "unsafe_audio_exists_bypass_blocked",
                    "profile": str(profile_path),
                    "audioFileCheck": {
                        "skipped": True,
                        "acceptedUnsafeBypass": False,
                        "reason": None,
                        "requiredFlags": [
                            "--allow-unsafe-audio-exists-bypass",
                            "--unsafe-audio-exists-bypass-reason",
                        ],
                    },
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)
    profile = load_profile(profile_path)
    report = readiness_report(
        profile_path=profile_path,
        profile=profile,
        min_clips_override=args.min_clips,
        min_total_duration_sec=args.min_total_duration_sec,
        check_audio_exists=not args.skip_audio_exists,
        audio_exists_bypass_reason=unsafe_audio_reason if args.skip_audio_exists else None,
        transcript_validation_json=Path(args.transcript_validation_json).expanduser().resolve() if args.transcript_validation_json else None,
        require_transcript_validation=args.require_transcript_validation,
    )
    if args.human:
        print_human(report)
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if report["status"] != "ready":
        sys.exit(2)


if __name__ == "__main__":
    main()

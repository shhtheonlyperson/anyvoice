from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
DEFAULT_KIT_MANIFEST = REPO_ROOT / "generated" / "voice-profile-recording-kits" / "local-default-current" / "manifest.json"
DEFAULT_TRANSCRIPT_VALIDATION_ROOT = REPO_ROOT / "generated" / "voice-profile-transcript-validation"
DEFAULT_QUALITY_GATE_ROOT = REPO_ROOT / "generated" / "voice-regression"
PRODUCT_PROOF_SPEAKER_BACKEND = "speechbrain-ecapa"
PRODUCT_PROOF_ASR_BACKEND = "faster-whisper"
PRODUCT_CAPTURE_CLIPS = 10
PRODUCT_CAPTURE_DURATION_SEC = 60.0
PRODUCT_PROMPT_SET = "extended"


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


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def py_script(script_name: str, args: list[str]) -> list[str]:
    return [sys.executable, str(REPO_ROOT / "scripts" / script_name), *args]


def user_py_script(script_name: str, args: list[str]) -> str:
    return command(["python3", f"scripts/{script_name}", *args])


def user_python_script(python_executable: str, script_name: str, args: list[str]) -> str:
    return command([python_executable, f"scripts/{script_name}", *args])


def load_json_stdout(proc: subprocess.CompletedProcess[str]) -> dict[str, Any] | None:
    if not proc.stdout.strip():
        return None
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def load_json_file(path: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return parsed if isinstance(parsed, dict) else None


def transcript_validation_root() -> Path:
    configured = Path(os.environ.get("ANYVOICE_TRANSCRIPT_VALIDATION_ROOT", str(DEFAULT_TRANSCRIPT_VALIDATION_ROOT)))
    return configured.expanduser().resolve()


def quality_gate_root() -> Path:
    configured = Path(os.environ.get("ANYVOICE_QUALITY_GATE_ROOT", str(DEFAULT_QUALITY_GATE_ROOT)))
    return configured.expanduser().resolve()


def default_stability_seed() -> int | None:
    value = (local_env_value("ANYVOICE_STABILITY_SEED") or "1337").strip().lower()
    if value in {"", "off", "none", "random"}:
        return None
    try:
        seed = int(value)
    except ValueError:
        return 1337
    return seed if 0 <= seed <= 2_147_483_647 else 1337


def default_speaker_python() -> str:
    return local_env_value("ANYVOICE_SPEAKER_PYTHON") or local_env_value("ANYVOICE_VOXCPM_PYTHON") or sys.executable


def default_asr_python() -> str:
    return local_env_value("ANYVOICE_ASR_PYTHON") or local_env_value("ANYVOICE_VOXCPM_PYTHON") or sys.executable


def latest_transcript_validation_for_profile(profile_path: Path) -> Path | None:
    normalized_profile = profile_path.resolve()
    matches: list[tuple[str, Path]] = []
    seen: set[Path] = set()

    def add_candidate(path: Path) -> None:
        resolved = path.expanduser().resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        payload = load_json_file(resolved)
        if not payload:
            return
        raw_profile = payload.get("profile")
        if not isinstance(raw_profile, str) or Path(raw_profile).expanduser().resolve() != normalized_profile:
            return
        created_at = str(payload.get("createdAt") or "")
        matches.append((created_at, resolved))

    add_candidate(normalized_profile.parent / "transcript-validation.json")
    root = transcript_validation_root()
    try:
        for path in root.iterdir():
            if path.is_file() and path.suffix == ".json":
                add_candidate(path)
    except OSError:
        pass
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][1]


def latest_quality_gate_for_profile(profile_path: Path) -> dict[str, Any] | None:
    normalized_profile = profile_path.resolve()
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    root = quality_gate_root()
    try:
        candidates = list(root.glob("*/quality-gate.json"))
        if (root / "quality-gate.json").is_file():
            candidates.append(root / "quality-gate.json")
    except OSError:
        return None
    for path in candidates:
        payload = load_json_file(path)
        if not payload:
            continue
        inputs = payload.get("inputs")
        if not isinstance(inputs, dict):
            continue
        raw_profile = inputs.get("profileJson")
        if not isinstance(raw_profile, str) or Path(raw_profile).expanduser().resolve() != normalized_profile:
            continue
        created_at = str(payload.get("createdAt") or "")
        matches.append((created_at, path.expanduser().resolve(), payload))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    created_at, path, payload = matches[0]
    return {
        "json": str(path),
        "createdAt": created_at,
        "status": payload.get("status"),
        "dryRun": payload.get("dryRun") if isinstance(payload.get("dryRun"), bool) else None,
        "paths": payload.get("paths") if isinstance(payload.get("paths"), dict) else None,
        "inputs": payload.get("inputs") if isinstance(payload.get("inputs"), dict) else None,
        "proofs": payload.get("proofs") if isinstance(payload.get("proofs"), dict) else None,
        "commands": payload.get("commands") if isinstance(payload.get("commands"), dict) else None,
    }


def strict_profile_quality_gate_passed(report: dict[str, Any] | None) -> bool:
    if not report or report.get("status") != "pass" or report.get("dryRun") is not False:
        return False
    inputs = report.get("inputs")
    proofs = report.get("proofs")
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    return (
        inputs.get("skipProfileVerify") is not True
        and inputs.get("skipTranscriptValidation") is not True
        and proofs.get("profileVerifyRequired") is True
        and proofs.get("profileVerifyPassed") is True
        and proofs.get("transcriptValidationRequired") is True
        and proofs.get("transcriptValidationPassed") is True
    )


def product_quality_gate_passed(report: dict[str, Any] | None) -> bool:
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
    commands = report.get("commands") if isinstance(report.get("commands"), dict) else {}
    score_command = str(commands.get("score") or "") if isinstance(commands, dict) else ""
    return (
        inputs.get("cloneMode") == "both"
        and inputs.get("requireSpeakerBackend") == PRODUCT_PROOF_SPEAKER_BACKEND
        and speaker_ok
        and "require-paired-improvement" in score_command
    )


def latest_product_quality_gate_for_profile(profile_path: Path) -> dict[str, Any] | None:
    normalized_profile = profile_path.resolve()
    matches: list[tuple[str, Path, dict[str, Any]]] = []
    root = quality_gate_root()
    try:
        candidates = list(root.glob("*/quality-gate.json"))
        if (root / "quality-gate.json").is_file():
            candidates.append(root / "quality-gate.json")
    except OSError:
        return None
    for path in candidates:
        payload = load_json_file(path)
        if not payload:
            continue
        inputs = payload.get("inputs")
        if not isinstance(inputs, dict):
            continue
        raw_profile = inputs.get("profileJson")
        if not isinstance(raw_profile, str) or Path(raw_profile).expanduser().resolve() != normalized_profile:
            continue
        report = {
            "json": str(path.expanduser().resolve()),
            "createdAt": str(payload.get("createdAt") or ""),
            "status": payload.get("status"),
            "dryRun": payload.get("dryRun") if isinstance(payload.get("dryRun"), bool) else None,
            "paths": payload.get("paths") if isinstance(payload.get("paths"), dict) else None,
            "inputs": inputs,
            "proofs": payload.get("proofs") if isinstance(payload.get("proofs"), dict) else None,
            "commands": payload.get("commands") if isinstance(payload.get("commands"), dict) else None,
        }
        if product_quality_gate_passed(report):
            matches.append((str(report["createdAt"]), path.expanduser().resolve(), report))
    if not matches:
        return None
    matches.sort(key=lambda row: row[0], reverse=True)
    return matches[0][2]


def run_json(command_parts: list[str]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    try:
        proc = subprocess.run(
            command_parts,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        return None, {
            "command": command_parts,
            "exitCode": 127,
            "stderr": str(exc),
            "stdoutText": None,
        }
    meta = {
        "command": command_parts,
        "exitCode": proc.returncode,
        "stderr": proc.stderr.strip() or None,
        "stdoutText": proc.stdout.strip() if proc.stdout.strip() and not proc.stdout.strip().startswith("{") else None,
    }
    return load_json_stdout(proc), meta


def json_or_text(value: str) -> Any:
    if not value.strip():
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value.strip()


def run_shell_command(command_text: str, *, inherit_stderr: bool = False) -> dict[str, Any]:
    proc = subprocess.run(
        command_text,
        cwd=REPO_ROOT,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=None if inherit_stderr else subprocess.PIPE,
        text=True,
        check=False,
    )
    return {
        "command": command_text,
        "exitCode": proc.returncode,
        "stdout": json_or_text(proc.stdout),
        "stderr": proc.stderr.strip() if proc.stderr else None,
    }


def speaker_backend_report() -> tuple[dict[str, Any] | None, dict[str, Any]]:
    override = os.environ.get("ANYVOICE_SPEAKER_BACKENDS_JSON", "").strip()
    if override:
        try:
            if override.startswith("{"):
                parsed = json.loads(override)
            else:
                parsed = load_json_file(Path(override).expanduser().resolve())
        except json.JSONDecodeError:
            parsed = None
        return parsed if isinstance(parsed, dict) else None, {
            "command": ["ANYVOICE_SPEAKER_BACKENDS_JSON"],
            "exitCode": 0 if isinstance(parsed, dict) else 2,
            "stderr": None if isinstance(parsed, dict) else "invalid speaker backend override JSON",
            "stdoutText": None,
        }
    speaker_python = default_speaker_python()
    return run_json([speaker_python, str(REPO_ROOT / "scripts" / "score_speaker_similarity.py"), "--list-backends"])


def product_proof_speaker_backend() -> dict[str, Any]:
    speaker_python = default_speaker_python()
    report, meta = speaker_backend_report()
    backends = report.get("backends") if isinstance(report, dict) else None
    selected_auto = report.get("selectedAutoBackend") if isinstance(report, dict) else None
    required = backends.get(PRODUCT_PROOF_SPEAKER_BACKEND) if isinstance(backends, dict) else None
    required = required if isinstance(required, dict) else {}
    available = required.get("available") is True
    reason = str(required.get("reason") or meta.get("stderr") or "speaker backend availability could not be checked")
    return {
        "status": "ready" if available else "missing",
        "available": available,
        "requiredBackend": PRODUCT_PROOF_SPEAKER_BACKEND,
        "speakerPython": speaker_python,
        "selectedAutoBackend": selected_auto if isinstance(selected_auto, str) else None,
        "reason": reason,
        "checkCommand": command([speaker_python, "scripts/score_speaker_similarity.py", "--list-backends"]),
        "setupHint": (
            "Install speechbrain, torch, and torchaudio in the Python environment used by the quality gate, "
            "then rerun the backend check before making a 10x/product claim."
        ),
        "backends": backends if isinstance(backends, dict) else None,
        "run": meta,
    }


def asr_backend_report() -> tuple[dict[str, Any] | None, dict[str, Any]]:
    override = os.environ.get("ANYVOICE_ASR_BACKENDS_JSON", "").strip()
    if override:
        try:
            if override.startswith("{"):
                parsed = json.loads(override)
            else:
                parsed = load_json_file(Path(override).expanduser().resolve())
        except json.JSONDecodeError:
            parsed = None
        return parsed if isinstance(parsed, dict) else None, {
            "command": ["ANYVOICE_ASR_BACKENDS_JSON"],
            "exitCode": 0 if isinstance(parsed, dict) else 2,
            "stderr": None if isinstance(parsed, dict) else "invalid ASR backend override JSON",
            "stdoutText": None,
        }
    asr_python = default_asr_python()
    return run_json([asr_python, str(REPO_ROOT / "scripts" / "transcribe_voice_regression.py"), "--list-backends"])


def product_proof_asr_backend() -> dict[str, Any]:
    asr_python = default_asr_python()
    report, meta = asr_backend_report()
    backends = report.get("backends") if isinstance(report, dict) else None
    selected_auto = report.get("selectedAutoBackend") if isinstance(report, dict) else None
    required = backends.get(PRODUCT_PROOF_ASR_BACKEND) if isinstance(backends, dict) else None
    required = required if isinstance(required, dict) else {}
    available = required.get("available") is True
    reason = str(required.get("reason") or meta.get("stderr") or "ASR backend availability could not be checked")
    return {
        "status": "ready" if available else "missing",
        "available": available,
        "requiredBackend": PRODUCT_PROOF_ASR_BACKEND,
        "asrPython": asr_python,
        "selectedAutoBackend": selected_auto if isinstance(selected_auto, str) else None,
        "reason": reason,
        "checkCommand": command([asr_python, "scripts/transcribe_voice_regression.py", "--list-backends"]),
        "setupHint": (
            "Install faster-whisper in the Python environment used by transcript validation, "
            "then rerun the backend check before making a 10x/product pronunciation claim."
        ),
        "backends": backends if isinstance(backends, dict) else None,
        "run": meta,
    }


def report_check(report: dict[str, Any] | None, name: str) -> dict[str, Any] | None:
    if not report:
        return None
    checks = report.get("checks")
    if not isinstance(checks, list):
        return None
    for row in checks:
        if isinstance(row, dict) and row.get("check") == name:
            return row
    return None


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, str) and str(item).strip()]


def check_detail_rows(check: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(check, dict):
        return []
    details = check.get("details")
    if not isinstance(details, dict):
        return []
    rows = details.get("rows")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def transcript_failed_rows(check: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(check, dict):
        return []
    details = check.get("details")
    if not isinstance(details, dict):
        return []
    rows = details.get("failed")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def transcript_failed_by_clip(check: dict[str, Any] | None) -> dict[str, list[str]]:
    issues: dict[str, list[str]] = {}
    for row in transcript_failed_rows(check):
        clip_id = str(row.get("repairClipId") or row.get("sourceRunId") or row.get("id") or "").strip()
        if not clip_id:
            continue
        verdict = str(row.get("verdict") or "failed").strip() or "failed"
        clip_issues = [f"transcript_validation_{verdict}"]
        error = str(row.get("error") or "").strip()
        if error:
            clip_issues.append(error)
        issues[clip_id] = clip_issues
    return issues


def resolve_manifest_path(raw_path: str, manifest_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    return path.resolve() if path.is_absolute() else (manifest_dir / path).resolve()


def per_clip_recording_commands(
    *,
    manifest_path: Path,
    profile_id: str,
    clip_id: str,
    record_countdown_sec: int,
) -> dict[str, str]:
    base = ["--manifest", str(manifest_path), "--clip", clip_id, "--profile-id", profile_id]
    return {
        "rehearseCommand": user_py_script(
            "record_voice_profile_recording_kit.py",
            [*base, "--rehearse", "--no-default-recorder", "--auto-duration"],
        ),
        "preflightCommand": user_py_script(
            "record_voice_profile_recording_kit.py",
            [*base, "--preflight", "--auto-duration"],
        ),
        "recordCommand": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                *base,
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--check-selected",
            ],
        ),
        "repairCommand": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                *base,
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--overwrite",
                "--check-selected",
            ],
        ),
        "repairCommandNonInteractive": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                *base,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--overwrite",
                "--check-selected",
                "--yes",
            ],
        ),
    }


def recording_brief(
    manifest_path: Path,
    kit_report: dict[str, Any] | None,
    *,
    profile_id: str,
    record_countdown_sec: int,
    transcript_issues_by_id: dict[str, list[str]] | None = None,
) -> dict[str, Any] | None:
    manifest = load_json_file(manifest_path)
    if not manifest:
        return None
    rows = manifest.get("clips")
    if not isinstance(rows, list):
        return None

    audio_errors_by_id: dict[str, list[str]] = {}
    audio_check = report_check(kit_report, "audio_files")
    for row in check_detail_rows(audio_check):
        clip_id = str(row.get("id") or "").strip()
        if not clip_id:
            continue
        audio_errors_by_id[clip_id] = string_list(row.get("errors"))

    audio_quality_by_id: dict[str, dict[str, Any]] = {}
    for check in [report_check(kit_report, "audio_duration"), report_check(kit_report, "audio_voice_activity")]:
        for row in check_detail_rows(check):
            clip_id = str(row.get("id") or "").strip()
            if not clip_id:
                continue
            existing = audio_quality_by_id.setdefault(clip_id, {"errors": []})
            existing["errors"].extend(string_list(row.get("errors")))
            for key in ["durationSec", "activeVoiceSec"]:
                if row.get(key) is not None:
                    existing[key] = row.get(key)

    clips: list[dict[str, Any]] = []
    clips_needing_audio: list[str] = []
    clips_needing_rerecord: list[str] = []
    transcript_issues_by_id = transcript_issues_by_id or {}
    manifest_dir = manifest_path.parent
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            continue
        clip_id = str(row.get("id") or row.get("runId") or row.get("sourceRunId") or f"profile-clip-{index:02d}").strip()
        raw_audio = str(row.get("audioPath") or row.get("audio") or row.get("path") or row.get("file") or "").strip()
        audio_path = resolve_manifest_path(raw_audio, manifest_dir) if raw_audio else None
        audio_errors = audio_errors_by_id.get(clip_id, [])
        needs_audio = (not audio_path or not audio_path.exists()) or any(
            error in {"missing_audio_path", "audio_file_missing", "audio_file_empty"} for error in audio_errors
        )
        audio_quality = audio_quality_by_id.get(clip_id, {})
        quality_errors = string_list(audio_quality.get("errors"))
        transcript_errors = transcript_issues_by_id.get(clip_id, [])
        needs_rerecord = bool(quality_errors or transcript_errors)
        if needs_audio:
            clips_needing_audio.append(clip_id)
        if needs_rerecord:
            clips_needing_rerecord.append(clip_id)
        clips.append(
            {
                "index": index,
                "id": clip_id,
                "audioPath": str(audio_path) if audio_path else "",
                "needsAudio": needs_audio,
                "needsRerecord": needs_rerecord,
                "recordingIssues": [*audio_errors, *quality_errors, *transcript_errors],
                "durationSec": audio_quality.get("durationSec"),
                "activeVoiceSec": audio_quality.get("activeVoiceSec"),
                "transcript": str(row.get("transcript") or row.get("promptTranscript") or row.get("text") or "").strip(),
                "transcriptScript": str(row.get("transcriptScript") or "").strip(),
                "coverageFeatures": string_list(row.get("coverageFeatures")),
                "pronunciationNotes": string_list(row.get("pronunciationNotes") or row.get("pronunciationGuide") or row.get("readingNotes")),
                **per_clip_recording_commands(
                    manifest_path=manifest_path,
                    profile_id=profile_id,
                    clip_id=clip_id,
                    record_countdown_sec=record_countdown_sec,
                ),
            }
        )

    return {
        "manifest": str(manifest_path),
        "clips": clips,
        "clipsNeedingAudio": clips_needing_audio,
        "clipsNeedingRerecord": clips_needing_rerecord,
        "clipsNeedingAttention": [clip["id"] for clip in clips if clip.get("needsAudio") or clip.get("needsRerecord")],
        "pronunciationNotePolicy": "Use pronunciation notes only as rehearsal guidance; do not read notes into the transcript.",
        "guidance": [
            "Read the transcript exactly.",
            "Use strict Traditional Chinese.",
            "Keep microphone distance and volume stable.",
            "Record in a quiet room without echo.",
        ],
    }


def commands(
    *,
    profile_path: Path,
    kit_manifest: Path,
    profile_id: str,
    transcript_validation_json: Path | None,
    transcript_asr_json: Path | None,
    quality_gate_json: Path | None,
    record_countdown_sec: int,
) -> dict[str, str]:
    transcript_validation_out = profile_path.parent / "transcript-validation.json"
    verify_profile_args = ["--profile-json", str(profile_path), "--require-transcript-validation"]
    quality_gate_common_args = ["--profile-json", str(profile_path), "--repeats", "3"]
    quality_gate_args = [*quality_gate_common_args, "--clone-mode", "hifi"]
    quality_gate_product_args = [
        *quality_gate_common_args,
        "--clone-mode",
        "both",
        "--require-speaker-backend",
        "speechbrain-ecapa",
    ]
    synthesis_python = local_env_value("ANYVOICE_VOXCPM_PYTHON")
    asr_python = default_asr_python()
    speaker_python = default_speaker_python()
    hot_worker_url = local_env_value("ANYVOICE_HOT_WORKER_URL")
    model_id = local_env_value("ANYVOICE_MODEL_ID")
    if synthesis_python:
        quality_gate_args.extend(["--synthesis-python", synthesis_python])
        quality_gate_product_args.extend(["--synthesis-python", synthesis_python])
    if asr_python:
        quality_gate_args.extend(["--asr-python", asr_python])
        quality_gate_product_args.extend(["--asr-python", asr_python])
    if speaker_python:
        quality_gate_args.extend(["--speaker-python", speaker_python])
        quality_gate_product_args.extend(["--speaker-python", speaker_python])
    if hot_worker_url:
        quality_gate_args.extend(["--hot-worker-url", hot_worker_url])
        quality_gate_product_args.extend(["--hot-worker-url", hot_worker_url])
    if model_id:
        quality_gate_args.extend(["--model-id", model_id])
        quality_gate_product_args.extend(["--model-id", model_id])
    stability_seed = default_stability_seed()
    if stability_seed is not None:
        quality_gate_args.extend(["--seed", str(stability_seed)])
        quality_gate_product_args.extend(["--seed", str(stability_seed)])
    if transcript_validation_json:
        verify_profile_args.extend(["--transcript-validation-json", str(transcript_validation_json)])
        quality_gate_args.extend(["--transcript-validation-json", str(transcript_validation_json)])
        quality_gate_product_args.extend(["--transcript-validation-json", str(transcript_validation_json)])
    validate_transcript_args = [
        "--profile-json",
        str(profile_path),
        "--out",
        str(transcript_validation_out),
        "--strict",
    ]
    if transcript_asr_json:
        validate_transcript_args.extend(["--asr-json", str(transcript_asr_json)])
    enroll_validate_args = [
        "--manifest",
        str(kit_manifest),
        "--profile-id",
        profile_id,
        "--validate-transcripts",
        "--transcript-python",
        asr_python,
    ]
    if transcript_asr_json:
        enroll_validate_args.extend(["--transcript-asr-json", str(transcript_asr_json)])
    lora_dataset_args = [
        "--profile-json",
        str(profile_path),
        "--min-clips",
        str(PRODUCT_CAPTURE_CLIPS),
        "--min-total-duration-sec",
        str(PRODUCT_CAPTURE_DURATION_SEC),
        "--require-product-proof-quality-gate",
        "--copy-audio",
    ]
    if transcript_validation_json:
        lora_dataset_args.extend(["--transcript-validation-json", str(transcript_validation_json)])
    if quality_gate_json:
        lora_dataset_args.extend(["--quality-gate-json", str(quality_gate_json)])
    backend_shootout_args = [
        "--profile-json",
        str(profile_path),
        "--backend",
        "indextts2",
        "--backend",
        "f5-tts",
        "--repeats",
        "3",
    ]
    if transcript_validation_json:
        backend_shootout_args.extend(["--transcript-validation-json", str(transcript_validation_json)])
    prove_recorded_kit_args = [
        "--profile-json",
        str(profile_path),
        "--kit-manifest",
        str(kit_manifest),
        "--profile-id",
        profile_id,
        "--record-countdown-sec",
        str(record_countdown_sec),
        "--run",
        "--auto-advance",
        "--allow-enroll",
        "--allow-expensive",
        "--stop-before-lora",
        "--max-steps",
        "3",
    ]
    if transcript_asr_json:
        prove_recorded_kit_args.extend(["--transcript-asr-json", str(transcript_asr_json)])
    return {
        "prepareRecordingKit": user_py_script(
            "prepare_voice_profile_recording_kit.py",
            ["--prompt-set", PRODUCT_PROMPT_SET, "--out-dir", str(kit_manifest.parent), "--profile-id", profile_id],
        ),
        "preflightRecordingKit": user_py_script(
            "record_voice_profile_recording_kit.py",
            ["--manifest", str(kit_manifest), "--preflight", "--auto-duration", "--profile-id", profile_id],
        ),
        "microphoneSmokeTestRecordingKit": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--preflight",
                "--brief",
                "--microphone-smoke-sec",
                "2",
                "--auto-duration",
                "--profile-id",
                profile_id,
            ],
        ),
        "rehearseRecordingKit": user_py_script(
            "record_voice_profile_recording_kit.py",
            ["--manifest", str(kit_manifest), "--rehearse", "--no-default-recorder", "--auto-duration", "--profile-id", profile_id],
        ),
        "recordProfileKit": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--check",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
            ],
        ),
        "recordNextMissingClip": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--next-missing",
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--check-selected",
            ],
        ),
        "recordMissingUntilComplete": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--record-missing-until-complete",
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--check",
            ],
        ),
        "recordProfileKitAndProve": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--record-missing-until-complete",
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--run-proof-after-check",
            ],
        ),
        "recordProfileKitAndProductProof": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--record-missing-until-complete",
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--run-product-proof-after-check",
            ],
        ),
        "recordProfileKitToLoraHandoff": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--record-missing-until-complete",
                "--open-cue-sheet",
                "--microphone-smoke-sec",
                "2",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--prepare-lora-after-product-proof",
            ],
        ),
        "recordProfileKitNonInteractive": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--check",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--yes",
            ],
        ),
        "recordNextMissingClipNonInteractive": user_py_script(
            "record_voice_profile_recording_kit.py",
            [
                "--manifest",
                str(kit_manifest),
                "--next-missing",
                "--profile-id",
                profile_id,
                "--countdown-sec",
                str(record_countdown_sec),
                "--write-metadata",
                "--auto-duration",
                "--check-selected",
                "--yes",
            ],
        ),
        "checkRecordingKit": user_py_script(
            "check_voice_profile_recording_kit.py",
            ["--manifest", str(kit_manifest), "--profile-id", profile_id],
        ),
        "enrollProfileKit": user_py_script(
            "enroll_voice_profile_kit.py",
            ["--manifest", str(kit_manifest), "--profile-id", profile_id],
        ),
        "enrollProfileKitAndValidate": user_py_script(
            "enroll_voice_profile_kit.py",
            enroll_validate_args,
        ),
        "verifyProfileStrict": user_py_script(
            "verify_voice_profile_ready.py",
            verify_profile_args,
        ),
        "validateTranscripts": user_python_script(
            asr_python,
            "validate_voice_profile_transcripts.py",
            validate_transcript_args,
        ),
        "qualityGate": user_py_script(
            "run_voice_quality_gate.py",
            quality_gate_args,
        ),
        "qualityGateProductProof": user_py_script(
            "run_voice_quality_gate.py",
            quality_gate_product_args,
        ),
        "prepareLoraDataset": user_py_script(
            "prepare_voice_lora_dataset.py",
            lora_dataset_args,
        ),
        "prepareLoraTrainingJob": user_py_script(
            "prepare_voxcpm_lora_training_job.py",
            [
                "--dataset-json",
                "generated/voice-lora-datasets/<profile-id>-<timestamp>/dataset.json",
                "--min-clips",
                str(PRODUCT_CAPTURE_CLIPS),
                "--min-total-duration-sec",
                str(PRODUCT_CAPTURE_DURATION_SEC),
            ],
        ),
        "prepareBackendShootout": user_py_script(
            "prepare_voice_backend_shootout.py",
            backend_shootout_args,
        ),
        "registerBackendRenders": user_py_script(
            "register_voice_backend_renders.py",
            [
                "generated/voice-backend-shootouts/<timestamp>/manifest.json",
                "--out-dir",
                "generated/voice-backend-shootouts/<timestamp>/registered-report",
            ],
        ),
        "proveRecordedKit": user_py_script(
            "voice_profile_next_step.py",
            prove_recorded_kit_args,
        ),
    }


def artifact_status(path: Path | None) -> str:
    if not path:
        return "planned"
    return "present" if path.exists() else "missing"


def post_recording_proof_plan(
    *,
    profile_path: Path,
    kit_manifest: Path,
    transcript_validation_json: Path | None,
    quality_gate_report: dict[str, Any] | None,
    product_asr_backend: dict[str, Any],
    product_speaker_backend: dict[str, Any],
    cmds: dict[str, str],
) -> dict[str, Any]:
    planned_transcript_validation_json = transcript_validation_json or profile_path.parent / "transcript-validation.json"
    quality_gate_json: Path | None = None
    if quality_gate_report and isinstance(quality_gate_report.get("json"), str):
        quality_gate_json = Path(str(quality_gate_report["json"])).expanduser().resolve()
    return {
        "policy": "Do not make the digital voice default until the strict profile verifier, ASR transcript validation, and a non-dry-run quality gate all pass.",
        "recommendedCommand": cmds["proveRecordedKit"],
        "manualCommands": [
            cmds["checkRecordingKit"],
            cmds["enrollProfileKitAndValidate"],
            cmds["verifyProfileStrict"],
            cmds["qualityGate"],
        ],
        "productProofCommand": cmds["qualityGateProductProof"],
        "productProofAsrBackend": product_asr_backend,
        "productProofSpeakerBackend": product_speaker_backend,
        "artifacts": [
            {
                "id": "recording_kit_manifest",
                "path": str(kit_manifest),
                "status": artifact_status(kit_manifest),
                "purpose": "fixed transcript/audio pairing for the ten profile clips",
            },
            {
                "id": "profile_json",
                "path": str(profile_path),
                "status": artifact_status(profile_path),
                "purpose": "selected user-recorded voice profile clips",
            },
            {
                "id": "transcript_validation_json",
                "path": str(planned_transcript_validation_json),
                "status": artifact_status(planned_transcript_validation_json),
                "purpose": "ASR proof that each recording matches its exact Traditional Chinese transcript",
            },
            {
                "id": "quality_gate_json",
                "path": str(quality_gate_json) if quality_gate_json else None,
                "pathPattern": str(quality_gate_root() / "<timestamp>" / "quality-gate.json"),
                "status": artifact_status(quality_gate_json),
                "purpose": "non-dry-run regression proof before LoRA export or default use",
            },
        ],
        "gates": [
            {
                "id": "recording_kit_check",
                "command": cmds["checkRecordingKit"],
                "required": True,
                "blocks": "enrollment",
            },
            {
                "id": "enroll_profile_kit",
                "command": cmds["enrollProfileKitAndValidate"],
                "required": True,
                "blocks": "strict_profile_verification",
            },
            {
                "id": "verify_profile_strict",
                "command": cmds["verifyProfileStrict"],
                "required": True,
                "blocks": "quality_gate",
            },
            {
                "id": "run_quality_gate",
                "command": cmds["qualityGate"],
                "required": True,
                "blocks": "product_proof",
            },
            {
                "id": "run_product_proof_quality_gate",
                "command": cmds["qualityGateProductProof"],
                "required": True,
                "blocks": "lora_dataset_export",
            },
        ],
    }


def next_action(
    *,
    profile_report: dict[str, Any] | None,
    kit_report: dict[str, Any] | None,
    quality_gate_report: dict[str, Any] | None,
    product_quality_gate_report: dict[str, Any] | None,
    profile_exists: bool,
    kit_exists: bool,
    cmds: dict[str, str],
    kit_manifest: Path,
    profile_id: str,
    record_countdown_sec: int,
) -> dict[str, Any]:
    if profile_report and profile_report.get("status") == "ready":
        if product_quality_gate_passed(product_quality_gate_report):
            return {
                "id": "prepare_lora_dataset",
                "phase": "lora_dataset",
                "status": "ready_for_lora_dataset",
                "command": cmds["prepareLoraDataset"],
                "secondaryCommands": [
                    cmds["prepareLoraTrainingJob"],
                    cmds["prepareBackendShootout"],
                    cmds["registerBackendRenders"],
                ],
                "reason": "strict profile and paired product proof passed; export the consented LoRA dataset next",
            }
        if strict_profile_quality_gate_passed(quality_gate_report):
            return {
                "id": "run_product_proof_quality_gate",
                "phase": "product_proof",
                "status": "ready_for_product_proof",
                "command": cmds["qualityGateProductProof"],
                "secondaryCommands": [
                    cmds["prepareBackendShootout"],
                    cmds["prepareLoraDataset"],
                    cmds["prepareLoraTrainingJob"],
                ],
                "reason": "hifi quality gate passed; run the paired product proof before LoRA handoff",
            }
        return {
            "id": "run_quality_gate",
            "phase": "quality_gate",
            "status": "ready_for_quality_gate",
            "command": cmds["qualityGate"],
            "secondaryCommands": [
                cmds["qualityGateProductProof"],
                cmds["prepareBackendShootout"],
                cmds["prepareLoraDataset"],
                cmds["prepareLoraTrainingJob"],
            ],
            "reason": "strict profile verifier passed; prove quality before making the digital voice default",
        }

    transcript_check = report_check(profile_report, "transcript_validation")
    if profile_report and transcript_check and transcript_check.get("ok") is False:
        other_failed = [
            row.get("check")
            for row in profile_report.get("checks", [])
            if isinstance(row, dict) and row.get("check") != "transcript_validation" and row.get("ok") is False
        ]
        if not other_failed:
            failed_rows = transcript_failed_rows(transcript_check)
            first_failed_source_run_id = str(failed_rows[0].get("sourceRunId") or "").strip() if failed_rows else ""
            first_failed_clip_id = str(failed_rows[0].get("repairClipId") or failed_rows[0].get("sourceRunId") or failed_rows[0].get("id") or "").strip() if failed_rows else ""
            repair_commands = (
                per_clip_recording_commands(
                    manifest_path=kit_manifest,
                    profile_id=profile_id,
                    clip_id=first_failed_clip_id,
                    record_countdown_sec=record_countdown_sec,
                )
                if first_failed_clip_id
                else {}
            )
            if repair_commands:
                return {
                    "id": "fix_transcript_validation_clip",
                    "phase": "transcript_validation",
                    "status": "needs_transcript_rerecord",
                    "command": repair_commands["repairCommand"],
                    "nonInteractiveCommand": repair_commands["repairCommandNonInteractive"],
                    "failedClip": first_failed_clip_id,
                    "failedSourceRunId": first_failed_source_run_id or None,
                    "failedClipErrors": [f"transcript_validation_{failed_rows[0].get('verdict') or 'failed'}"],
                    "secondaryCommands": [
                        repair_commands["rehearseCommand"],
                        cmds["validateTranscripts"],
                        cmds["verifyProfileStrict"],
                        cmds["qualityGate"],
                    ],
                    "reason": "ASR transcript validation failed for a selected clip; re-record that exact scripted clip, then validate again",
                }
            return {
                "id": "validate_transcripts",
                "phase": "transcript_validation",
                "status": "needs_transcript_validation",
                "command": cmds["validateTranscripts"],
                "secondaryCommands": [cmds["verifyProfileStrict"], cmds["qualityGate"]],
                "reason": "profile clips are otherwise ready, but ASR transcript validation is missing or failed",
            }

    if kit_exists and kit_report and kit_report.get("status") == "ready_to_import":
        return {
            "id": "enroll_profile_kit",
            "phase": "enrollment",
            "status": "ready_to_enroll",
            "command": cmds["enrollProfileKit"],
            "secondaryCommands": [cmds["enrollProfileKitAndValidate"], cmds["verifyProfileStrict"], cmds["qualityGate"]],
            "reason": "recording kit audio/transcripts pass pre-import checks; import next, or use the validate command to prove transcript alignment in one shot",
        }

    if kit_exists and kit_report:
        audio_check = report_check(kit_report, "audio_files")
        duration_check = report_check(kit_report, "audio_duration")
        active_check = report_check(kit_report, "audio_voice_activity")
        transcript_check = report_check(kit_report, "transcripts")
        source_kind_check = report_check(kit_report, "source_kind")
        prompt_file_check = report_check(kit_report, "prompt_files")
        recording_metadata_check = report_check(kit_report, "recording_metadata")
        coverage_check = report_check(kit_report, "coverage")
        blocked_metadata = [
            row
            for row in [transcript_check, source_kind_check, prompt_file_check, recording_metadata_check, coverage_check]
            if row and row.get("ok") is False
        ]
        if blocked_metadata:
            return {
                "id": "fix_recording_kit_metadata",
                "phase": "recording_kit",
                "status": "needs_recording_kit_fix",
                "command": cmds["checkRecordingKit"],
                "secondaryCommands": [
                    cmds["rehearseRecordingKit"],
                    cmds["preflightRecordingKit"],
                    cmds["microphoneSmokeTestRecordingKit"],
                    cmds["prepareRecordingKit"],
                    cmds["recordProfileKit"],
                ],
                "reason": "; ".join(str(row.get("message") or row.get("check")) for row in blocked_metadata),
            }
        if audio_check and audio_check.get("ok") is False:
            return {
                "id": "record_profile_kit",
                "phase": "recording",
                "status": "needs_recording",
                "command": cmds["recordMissingUntilComplete"],
                "secondaryCommands": [
                    cmds["recordNextMissingClip"],
                    cmds["rehearseRecordingKit"],
                    cmds["preflightRecordingKit"],
                    cmds["microphoneSmokeTestRecordingKit"],
                    cmds["recordProfileKitAndProve"],
                    cmds["recordProfileKitAndProductProof"],
                    cmds["recordProfileKitToLoraHandoff"],
                    cmds["recordProfileKit"],
                    cmds["checkRecordingKit"],
                    cmds["enrollProfileKitAndValidate"],
                ],
                "reason": str(audio_check.get("message") or "recording kit is missing audio files"),
            }
        failed_audio_quality = [
            row
            for row in [duration_check, active_check]
            if row and row.get("ok") is False
        ]
        if failed_audio_quality:
            failed_rows: list[dict[str, Any]] = []
            for check in failed_audio_quality:
                failed_rows.extend(check_detail_rows(check))
            first_failed_clip_id = str(failed_rows[0].get("id") or "").strip() if failed_rows else ""
            repair_commands = (
                per_clip_recording_commands(
                    manifest_path=kit_manifest,
                    profile_id=profile_id,
                    clip_id=first_failed_clip_id,
                    record_countdown_sec=record_countdown_sec,
                )
                if first_failed_clip_id
                else {}
            )
            return {
                "id": "fix_recording_kit",
                "phase": "recording_quality",
                "status": "needs_recording_fix",
                "command": repair_commands.get("repairCommand") or cmds["recordProfileKit"],
                "nonInteractiveCommand": repair_commands.get("repairCommandNonInteractive"),
                "failedClip": first_failed_clip_id or None,
                "failedClipErrors": string_list(failed_rows[0].get("errors")) if failed_rows else [],
                "secondaryCommands": [
                    cmds["rehearseRecordingKit"],
                    cmds["preflightRecordingKit"],
                    cmds["microphoneSmokeTestRecordingKit"],
                    cmds["recordProfileKitAndProve"],
                    cmds["recordProfileKitAndProductProof"],
                    cmds["recordProfileKitToLoraHandoff"],
                    cmds["recordProfileKit"],
                    cmds["checkRecordingKit"],
                    cmds["enrollProfileKitAndValidate"],
                ],
                "reason": "; ".join(str(row.get("message") or row.get("check")) for row in failed_audio_quality),
            }

    if not kit_exists:
        return {
            "id": "prepare_recording_kit",
            "phase": "recording_kit",
            "status": "needs_recording_kit",
            "command": cmds["prepareRecordingKit"],
            "secondaryCommands": [
                cmds["rehearseRecordingKit"],
                cmds["preflightRecordingKit"],
                cmds["microphoneSmokeTestRecordingKit"],
                cmds["recordProfileKit"],
                cmds["enrollProfileKitAndValidate"],
            ],
            "reason": "recording kit manifest is missing",
        }

    if not profile_exists:
        return {
            "id": "check_recording_kit",
            "phase": "recording_kit",
            "status": "profile_missing",
            "command": cmds["checkRecordingKit"],
            "secondaryCommands": [
                cmds["rehearseRecordingKit"],
                cmds["preflightRecordingKit"],
                cmds["microphoneSmokeTestRecordingKit"],
                cmds["recordProfileKit"],
                cmds["enrollProfileKitAndValidate"],
            ],
            "reason": "profile manifest is missing; inspect the recording kit before enrollment",
        }

    return {
        "id": "inspect_profile",
        "phase": "diagnosis",
        "status": "blocked",
        "command": cmds["verifyProfileStrict"],
        "secondaryCommands": [
            cmds["checkRecordingKit"],
            cmds["rehearseRecordingKit"],
            cmds["preflightRecordingKit"],
            cmds["microphoneSmokeTestRecordingKit"],
            cmds["recordProfileKit"],
            cmds["enrollProfileKitAndValidate"],
        ],
        "reason": "profile and kit are blocked in a way that needs inspecting the verifier output",
    }


def run_action(
    action: dict[str, Any],
    cmds: dict[str, str],
    *,
    allow_recording: bool,
    allow_enroll: bool,
    allow_expensive: bool,
    allow_lora_export: bool,
) -> tuple[dict[str, Any], int]:
    action_id = str(action.get("id") or "")
    recording_action_ids = {"record_profile_kit", "fix_recording_kit", "fix_transcript_validation_clip"}
    if action_id in recording_action_ids and not allow_recording:
        result = run_shell_command(cmds["preflightRecordingKit"])
        return (
            {
                "status": "ran_preflight_instead_of_recording",
                "reason": "recording requires --allow-recording; ran no-microphone preflight instead",
                "actionId": action_id,
                "command": cmds["preflightRecordingKit"],
                "result": result,
            },
            result["exitCode"],
        )
    if action_id in {"enroll_profile_kit"} and not allow_enroll:
        return (
            {
                "status": "blocked_by_safety",
                "reason": "enrollment writes profile/run evidence and requires --allow-enroll",
                "actionId": action_id,
                "command": action.get("command"),
            },
            2,
        )
    if action_id in {"validate_transcripts", "run_quality_gate", "run_product_proof_quality_gate"} and not allow_expensive:
        return (
            {
                "status": "blocked_by_safety",
                "reason": "ASR/quality-gate work can be slow and requires --allow-expensive",
                "actionId": action_id,
                "command": action.get("command"),
            },
            2,
        )
    if action_id == "prepare_lora_dataset" and not allow_lora_export:
        return (
            {
                "status": "blocked_by_safety",
                "reason": "LoRA dataset export copies consented voice audio and requires --allow-lora-export",
                "actionId": action_id,
                "command": action.get("command"),
            },
            2,
        )

    command_text = str(action.get("command") or "")
    inherit_stderr = False
    if action_id in recording_action_ids:
        if sys.stdin.isatty():
            inherit_stderr = True
        else:
            if action_id == "record_profile_kit":
                command_text = cmds["recordNextMissingClipNonInteractive"]
            else:
                command_text = str(action.get("nonInteractiveCommand") or cmds["recordProfileKitNonInteractive"])
    result = run_shell_command(command_text, inherit_stderr=inherit_stderr)
    return (
        {
            "status": "ran",
            "actionId": action_id,
            "command": command_text,
            "result": result,
        },
        result["exitCode"],
    )


def evaluate_state(
    *,
    profile_path: Path,
    kit_manifest: Path,
    profile_id: str,
    transcript_validation_json: str | None,
    transcript_asr_json: str | None,
    record_countdown_sec: int,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, str]]:
    profile_exists = profile_path.exists()
    kit_exists = kit_manifest.exists()
    quality_gate_report = latest_quality_gate_for_profile(profile_path)
    product_quality_gate_report = latest_product_quality_gate_for_profile(profile_path)
    product_speaker_backend = product_proof_speaker_backend()
    product_asr_backend = product_proof_asr_backend()
    effective_quality_gate_json = (
        Path(str(product_quality_gate_report.get("json"))).expanduser().resolve()
        if product_quality_gate_passed(product_quality_gate_report)
        and isinstance(product_quality_gate_report.get("json"), str)
        else None
    )
    effective_transcript_validation_json = (
        Path(transcript_validation_json).expanduser().resolve()
        if transcript_validation_json
        else latest_transcript_validation_for_profile(profile_path)
    )
    effective_transcript_asr_json = Path(transcript_asr_json).expanduser().resolve() if transcript_asr_json else None
    cmds = commands(
        profile_path=profile_path,
        kit_manifest=kit_manifest,
        profile_id=profile_id,
        transcript_validation_json=effective_transcript_validation_json,
        transcript_asr_json=effective_transcript_asr_json,
        quality_gate_json=effective_quality_gate_json,
        record_countdown_sec=record_countdown_sec,
    )

    profile_report: dict[str, Any] | None = None
    profile_meta: dict[str, Any] | None = None
    if profile_exists:
        verify_args = ["--profile-json", str(profile_path), "--require-transcript-validation"]
        if effective_transcript_validation_json:
            verify_args.extend(["--transcript-validation-json", str(effective_transcript_validation_json)])
        profile_report, profile_meta = run_json(py_script("verify_voice_profile_ready.py", verify_args))

    kit_report: dict[str, Any] | None = None
    kit_meta: dict[str, Any] | None = None
    if kit_exists:
        kit_report, kit_meta = run_json(
            py_script(
                "check_voice_profile_recording_kit.py",
                ["--manifest", str(kit_manifest), "--profile-id", profile_id],
            )
        )

    action = next_action(
        profile_report=profile_report,
        kit_report=kit_report,
        quality_gate_report=quality_gate_report,
        product_quality_gate_report=product_quality_gate_report,
        profile_exists=profile_exists,
        kit_exists=kit_exists,
        cmds=cmds,
        kit_manifest=kit_manifest,
        profile_id=profile_id,
        record_countdown_sec=record_countdown_sec,
    )
    brief = (
        recording_brief(
            kit_manifest,
            kit_report,
            profile_id=profile_id,
            record_countdown_sec=record_countdown_sec,
            transcript_issues_by_id=transcript_failed_by_clip(report_check(profile_report, "transcript_validation")),
        )
        if kit_exists
        else None
    )
    payload = {
        "status": action["status"],
        "phase": action["phase"],
        "nextAction": action,
        "profile": {
            "path": str(profile_path),
            "exists": profile_exists,
            "status": profile_report.get("status") if profile_report else "missing",
            "summary": profile_report.get("summary") if profile_report else None,
            "checks": profile_report.get("checks") if profile_report else None,
            "run": profile_meta,
        },
        "recordingKit": {
            "manifest": str(kit_manifest),
            "exists": kit_exists,
            "status": kit_report.get("status") if kit_report else "missing",
            "summary": kit_report.get("summary") if kit_report else None,
            "checks": kit_report.get("checks") if kit_report else None,
            "run": kit_meta,
        },
        "commands": cmds,
        "transcriptValidation": {
            "json": str(effective_transcript_validation_json) if effective_transcript_validation_json else None,
            "asrJson": str(effective_transcript_asr_json) if effective_transcript_asr_json else None,
        },
        "qualityGate": quality_gate_report,
        "productQualityGate": product_quality_gate_report,
        "productProofReadiness": {
            "asrBackend": product_asr_backend,
            "speakerBackend": product_speaker_backend,
        },
        "postRecordingProofPlan": post_recording_proof_plan(
            profile_path=profile_path,
            kit_manifest=kit_manifest,
            transcript_validation_json=effective_transcript_validation_json,
            quality_gate_report=quality_gate_report,
            product_asr_backend=product_asr_backend,
            product_speaker_backend=product_speaker_backend,
            cmds=cmds,
        ),
    }
    if brief:
        payload["recordingBrief"] = brief
        payload["missingRecordingClips"] = brief.get("clipsNeedingAudio", [])
    return payload, action, cmds


def shorten(value: Any, max_chars: int = 160) -> str:
    text = str(value or "").strip().replace("\n", " ")
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 3].rstrip()}..."


def brief_backend_line(label: str, backend: dict[str, Any] | None) -> str:
    backend = backend if isinstance(backend, dict) else {}
    status = str(backend.get("status") or "unknown")
    required = str(backend.get("requiredBackend") or "unknown")
    python_key = "asrPython" if "asrPython" in backend else "speakerPython"
    python_value = str(backend.get(python_key) or "")
    suffix = f" via {python_value}" if python_value else ""
    return f"- {label}: {status} ({required}){suffix}"


def first_recording_brief_clip(recording_brief_payload: dict[str, Any]) -> dict[str, Any] | None:
    clips = recording_brief_payload.get("clips")
    if not isinstance(clips, list):
        return None
    attention = set(string_list(recording_brief_payload.get("clipsNeedingAttention")))
    for clip in clips:
        if isinstance(clip, dict) and str(clip.get("id") or "") in attention:
            return clip
    return clips[0] if clips and isinstance(clips[0], dict) else None


def format_brief(payload: dict[str, Any]) -> str:
    action = payload.get("nextAction") if isinstance(payload.get("nextAction"), dict) else {}
    action = action if isinstance(action, dict) else {}
    commands_payload = payload.get("commands") if isinstance(payload.get("commands"), dict) else {}
    commands_payload = commands_payload if isinstance(commands_payload, dict) else {}
    lines = [
        f"Status: {payload.get('status')}",
        f"Phase: {payload.get('phase')}",
        f"Next action: {action.get('id') or 'unknown'}",
    ]
    reason = str(action.get("reason") or "").strip()
    if reason:
        lines.append(f"Reason: {reason}")
    command_text = str(action.get("command") or "").strip()
    if command_text:
        lines.extend(["", "Next command:", command_text])

    recording_brief_payload = payload.get("recordingBrief")
    if isinstance(recording_brief_payload, dict):
        missing_audio = string_list(recording_brief_payload.get("clipsNeedingAudio"))
        rerecord = string_list(recording_brief_payload.get("clipsNeedingRerecord"))
        attention = string_list(recording_brief_payload.get("clipsNeedingAttention"))
        if missing_audio:
            lines.append(f"Missing audio clips: {', '.join(missing_audio)}")
        if rerecord:
            lines.append(f"Clips needing rerecord: {', '.join(rerecord)}")
        if attention:
            lines.append(f"Clips needing attention: {', '.join(attention)}")
        first_clip = first_recording_brief_clip(recording_brief_payload)
        if first_clip:
            lines.extend(["", f"First clip: {first_clip.get('id') or first_clip.get('index')}"])
            transcript = shorten(first_clip.get("transcript"), 180)
            if transcript:
                lines.append(f"Transcript: {transcript}")
            notes = string_list(first_clip.get("pronunciationNotes"))
            if notes:
                lines.append(f"Pronunciation notes: {'; '.join(notes)}")
            clip_command_key = "repairCommand" if first_clip.get("needsRerecord") else "recordCommand"
            clip_command = str(first_clip.get(clip_command_key) or first_clip.get("recordCommand") or "").strip()
            if clip_command:
                lines.extend(["", "Focused clip command:", clip_command])

    if commands_payload:
        command_rows = [
            ("Open/check mic", "microphoneSmokeTestRecordingKit"),
            ("Preflight", "preflightRecordingKit"),
            ("Record missing clips", "recordMissingUntilComplete"),
            ("Record and prove", "recordProfileKitAndProve"),
            ("Product proof after recording", "recordProfileKitAndProductProof"),
            ("LoRA handoff after product proof", "recordProfileKitToLoraHandoff"),
        ]
        lines.append("")
        for label, key in command_rows:
            value = str(commands_payload.get(key) or "").strip()
            if value:
                lines.extend([f"{label}:", value])

    readiness = payload.get("productProofReadiness")
    if isinstance(readiness, dict):
        lines.extend(
            [
                "",
                "Proof backend readiness:",
                brief_backend_line("ASR", readiness.get("asrBackend") if isinstance(readiness.get("asrBackend"), dict) else None),
                brief_backend_line(
                    "Speaker",
                    readiness.get("speakerBackend") if isinstance(readiness.get("speakerBackend"), dict) else None,
                ),
            ]
        )

    proof_plan = payload.get("postRecordingProofPlan")
    if isinstance(proof_plan, dict):
        recommended = str(proof_plan.get("recommendedCommand") or "").strip()
        product = str(proof_plan.get("productProofCommand") or "").strip()
        if recommended:
            lines.extend(["", "Proof chain command:", recommended])
        if product:
            lines.extend(["Product 10x proof command:", product])

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Print the next concrete AnyVoice digital-profile step from current profile and recording-kit state.")
    parser.add_argument("--profile-json", default=str(DEFAULT_PROFILE_JSON))
    parser.add_argument("--kit-manifest", default=str(DEFAULT_KIT_MANIFEST))
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--transcript-validation-json", help="Existing transcript-validation JSON to pass into the strict verifier.")
    parser.add_argument("--transcript-asr-json", help="External ASR JSON to pass into validate_voice_profile_transcripts.py when --run reaches transcript validation.")
    parser.add_argument("--brief", action="store_true", help="Print a compact terminal checklist instead of JSON.")
    parser.add_argument("--fail-unless-ready", action="store_true", help="Exit 2 unless the strict profile is ready for the quality gate.")
    parser.add_argument("--run", action="store_true", help="Run the safe next step. Recording/enrollment/expensive phases require explicit allow flags.")
    parser.add_argument("--auto-advance", action="store_true", help="With --run, re-evaluate and continue through permitted phases until blocked or ready.")
    parser.add_argument("--max-steps", type=int, default=4, help="Maximum --auto-advance run steps.")
    parser.add_argument("--record-countdown-sec", type=int, default=2, help="Countdown used by the generated recording command.")
    parser.add_argument("--allow-recording", action="store_true", help="Allow --run to invoke the microphone recording command.")
    parser.add_argument("--allow-enroll", action="store_true", help="Allow --run to import/analyze clips and write profile evidence.")
    parser.add_argument("--allow-expensive", action="store_true", help="Allow --run to launch ASR transcript validation or quality-gate rendering.")
    parser.add_argument("--allow-lora-export", action="store_true", help="Allow --run to export the consented LoRA dataset after all proof gates pass.")
    parser.add_argument("--stop-before-lora", action="store_true", help="With --run --auto-advance, stop once the LoRA dataset export becomes the next action.")
    args = parser.parse_args()
    if args.max_steps <= 0:
        raise SystemExit("--max-steps must be positive")
    if args.record_countdown_sec < 0:
        raise SystemExit("--record-countdown-sec must be zero or positive")

    profile_path = Path(args.profile_json).expanduser().resolve()
    kit_manifest = Path(args.kit_manifest).expanduser().resolve()
    initial_payload, action, cmds = evaluate_state(
        profile_path=profile_path,
        kit_manifest=kit_manifest,
        profile_id=args.profile_id,
        transcript_validation_json=args.transcript_validation_json,
        transcript_asr_json=args.transcript_asr_json,
        record_countdown_sec=args.record_countdown_sec,
    )
    payload = initial_payload
    exit_code = 0
    if args.run:
        runs: list[dict[str, Any]] = []
        current_action = action
        current_cmds = cmds
        current_payload = payload
        for step_index in range(args.max_steps if args.auto_advance else 1):
            if args.stop_before_lora and current_action.get("id") == "prepare_lora_dataset":
                break
            previous_action_id = str(current_action.get("id") or "")
            previous_status = str(current_payload.get("status") or "")
            previous_missing_recordings = current_payload.get("missingRecordingClips")
            run_payload, exit_code = run_action(
                current_action,
                current_cmds,
                allow_recording=args.allow_recording,
                allow_enroll=args.allow_enroll,
                allow_expensive=args.allow_expensive,
                allow_lora_export=args.allow_lora_export,
            )
            run_payload["step"] = step_index + 1
            runs.append(run_payload)
            if exit_code != 0 or not args.auto_advance:
                break
            if run_payload.get("status") == "ran_preflight_instead_of_recording":
                break
            current_payload, current_action, current_cmds = evaluate_state(
                profile_path=profile_path,
                kit_manifest=kit_manifest,
                profile_id=args.profile_id,
                transcript_validation_json=args.transcript_validation_json,
                transcript_asr_json=args.transcript_asr_json,
                record_countdown_sec=args.record_countdown_sec,
            )
            if (
                current_action.get("id") == previous_action_id
                and current_payload.get("status") == previous_status
                and current_payload.get("missingRecordingClips") == previous_missing_recordings
            ):
                break
        payload = current_payload
        payload["initialStatus"] = initial_payload["status"]
        payload["initialAction"] = initial_payload["nextAction"]
        if runs:
            payload["run"] = runs[0]
            payload["runs"] = runs
    brief_text = format_brief(payload)
    payload["brief"] = brief_text
    if args.brief:
        print(brief_text)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    if exit_code != 0:
        raise SystemExit(exit_code)
    if args.fail_unless_ready and payload["status"] not in {"ready_for_quality_gate", "ready_for_product_proof", "ready_for_lora_dataset"}:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from voice_clone_regression import default_stability_seed

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVAL_SET = REPO_ROOT / "examples" / "voice_clone_eval_set.json"
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
SCRIPT_DIR = REPO_ROOT / "scripts"


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


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def shell_join(cmd: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(part) for part in cmd)


def run_step(name: str, cmd: list[str]) -> dict[str, Any]:
    started = datetime.now(timezone.utc).isoformat()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "name": name,
        "command": shell_join(cmd),
        "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "returnCode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
    }


def parse_json_stdout(step: dict[str, Any]) -> dict[str, Any] | None:
    stdout = str(step.get("stdout") or "").strip()
    if not stdout:
        return None
    last_line = stdout.splitlines()[-1]
    try:
        parsed = json.loads(last_line)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def speaker_python_default(synthesis_python: str) -> str:
    return local_env_value("ANYVOICE_SPEAKER_PYTHON") or synthesis_python or sys.executable


def asr_python_default(synthesis_python: str) -> str:
    return local_env_value("ANYVOICE_ASR_PYTHON") or synthesis_python or sys.executable


def resolved_env_path(key: str) -> str | None:
    value = local_env_value(key)
    return str(Path(value).expanduser().resolve()) if value else None


def file_sha256(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def load_json_object(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return payload if isinstance(payload, dict) else None


def canonical_profile_sha256(profile_path: Path | None) -> str | None:
    if profile_path is None:
        return None
    profile = load_json_object(profile_path)
    if not profile:
        return None
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def lora_adapter_evidence(lora_path: str | None) -> dict[str, Any] | None:
    if not lora_path:
        return None
    path = Path(lora_path)
    evidence: dict[str, Any] = {"path": str(path)}
    try:
        stat_result = path.stat()
    except OSError as exc:
        return {**evidence, "exists": False, "error": str(exc)}
    return {
        **evidence,
        "exists": True,
        "bytes": stat_result.st_size,
        "sha256": file_sha256(path),
    }


def artifact_evidence(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "sha256": file_sha256(path),
    }


def speaker_backend_status(speaker_python: str) -> tuple[dict[str, Any], dict[str, Any]]:
    cmd = [speaker_python, str(SCRIPT_DIR / "score_speaker_similarity.py"), "--list-backends"]
    step = run_step("speaker_backend_check", cmd)
    parsed = parse_json_stdout(step)
    if not parsed:
        return (
            {
                "version": 1,
                "selectedAutoBackend": "unavailable",
                "backends": {},
                "error": step.get("stderr") or step.get("stdout") or "speaker backend check did not return JSON",
            },
            step,
        )
    return parsed, step


def select_speaker_backend(requested: str, status: dict[str, Any]) -> str:
    if requested != "auto":
        return requested
    selected = status.get("selectedAutoBackend")
    if isinstance(selected, str) and selected:
        return selected
    backends = status.get("backends")
    if not isinstance(backends, dict):
        return "unavailable"
    for backend in ("speechbrain-ecapa", "resemblyzer", "mfcc-cosine"):
        details = backends.get(backend)
        if isinstance(details, dict) and details.get("available") is True:
            return backend
    return "unavailable"


def step_passed(steps: list[dict[str, Any]], name: str) -> bool:
    return any(step.get("name") == name and step.get("returnCode") == 0 for step in steps)


def append_common_regression_args(cmd: list[str], args: argparse.Namespace) -> None:
    cmd.extend(["--eval-set", str(Path(args.eval_set).expanduser())])
    cmd.extend(["--out-dir", str(args.out_dir)])
    cmd.extend(["--python", args.synthesis_python])
    cmd.extend(["--model-id", args.model_id])
    cmd.extend(["--quality", args.quality])
    cmd.extend(["--clone-mode", args.clone_mode])
    cmd.extend(["--repeats", str(args.repeats)])
    if args.seed is not None:
        cmd.extend(["--seed", str(args.seed)])
    if args.hot_worker_url:
        cmd.extend(["--hot-worker-url", args.hot_worker_url])
    for case_id in args.case:
        cmd.extend(["--case", case_id])
    for tag in args.tag:
        cmd.extend(["--tag", tag])
    if args.max_cases is not None:
        cmd.extend(["--max-cases", str(args.max_cases)])
    if args.profile_json:
        cmd.extend(["--profile-json", str(Path(args.profile_json).expanduser())])
    if args.reference_audio:
        cmd.extend(["--reference-audio", str(Path(args.reference_audio).expanduser())])
    if args.prompt_text:
        cmd.extend(["--prompt-text", args.prompt_text])
    if args.prompt_text_file:
        cmd.extend(["--prompt-text-file", str(Path(args.prompt_text_file).expanduser())])
    if args.dry_run:
        cmd.append("--dry-run")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the AnyVoice digital-voice quality gate: render, ASR, speaker identity, and strict scoring.")
    parser.add_argument("--eval-set", default=str(DEFAULT_EVAL_SET))
    parser.add_argument("--profile-json", help=f"Use a ready digital voice profile. Default profile path: {DEFAULT_PROFILE_JSON}")
    parser.add_argument("--reference-audio", help="Reference voice clip used for every case.")
    parser.add_argument("--prompt-text", help="Exact transcript for --reference-audio.")
    parser.add_argument("--prompt-text-file", help="File containing the exact transcript for --reference-audio.")
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "generated" / "voice-regression" / utc_stamp()))
    parser.add_argument("--synthesis-python", default=local_env_value("ANYVOICE_VOXCPM_PYTHON") or sys.executable, help="Python interpreter used by voice_clone_regression.py for VoxCPM synthesis.")
    parser.add_argument("--asr-python", default="", help="Python interpreter used for profile transcript validation and regression ASR. Defaults to ANYVOICE_ASR_PYTHON, then --synthesis-python.")
    parser.add_argument("--speaker-python", default="", help="Python interpreter used for speaker similarity backends. Defaults to ANYVOICE_SPEAKER_PYTHON, then --synthesis-python.")
    parser.add_argument("--hot-worker-url", default=local_env_value("ANYVOICE_HOT_WORKER_URL") or "", help="Use the already-loaded hot worker for rendering.")
    parser.add_argument("--model-id", default=local_env_value("ANYVOICE_MODEL_ID") or "openbmb/VoxCPM2")
    parser.add_argument("--quality", choices=("speed", "balanced", "quality"), default="balanced")
    parser.add_argument("--clone-mode", choices=("hifi", "prompt", "both"), default="hifi")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=default_stability_seed(), help="Stability seed for regression renders. Set ANYVOICE_STABILITY_SEED=off to disable.")
    parser.add_argument("--case", action="append", default=[], help="Eval case id to render. Can be passed multiple times.")
    parser.add_argument("--tag", action="append", default=[], help="Render cases containing this tag. Can be passed multiple times.")
    parser.add_argument("--max-cases", type=int, help="Limit selected cases after filters.")
    parser.add_argument("--asr-backend", choices=("auto", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--asr-model", default="large-v3")
    parser.add_argument("--asr-language", default="zh")
    parser.add_argument("--asr-device", default="auto")
    parser.add_argument("--asr-compute-type", default="default")
    parser.add_argument("--speaker-backend", choices=("auto", "mfcc-cosine", "resemblyzer", "speechbrain-ecapa"), default="auto")
    parser.add_argument("--speaker-model", help="Optional model name/path for model-based speaker backends.")
    parser.add_argument("--require-speaker-backend", choices=("mfcc-cosine", "resemblyzer", "speechbrain-ecapa"), help="Fail before rendering unless the selected speaker backend matches this backend.")
    parser.add_argument("--min-speaker-similarity", type=float, default=0.72)
    parser.add_argument("--baseline-score", help="Optional previous score JSON for relative CER/WER reduction.")
    parser.add_argument("--min-reduction-pct", type=float, default=50.0)
    parser.add_argument("--skip-profile-verify", action="store_true", help="Do not run verify_voice_profile_ready.py before profile-based gates.")
    parser.add_argument("--transcript-validation-json", help="Use an existing profile transcript-validation report.")
    parser.add_argument("--skip-transcript-validation", action="store_true", help="Do not require ASR transcript validation before profile-based gates.")
    parser.add_argument("--allow-unsafe-profile-gate-bypass", action="store_true", help="Allow profile-readiness or transcript-validation skips for migration/debug gates. Requires --unsafe-profile-gate-bypass-reason.")
    parser.add_argument("--unsafe-profile-gate-bypass-reason", default="", help="Required reason when bypassing profile readiness or transcript validation in a profile quality gate.")
    parser.add_argument("--dry-run", action="store_true", help="Create report/asr/speaker planning artifacts without rendering, transcribing, or scoring.")
    args = parser.parse_args()
    if args.seed is not None and not 0 <= args.seed <= 2_147_483_647:
        raise SystemExit("--seed must be between 0 and 2147483647, or omitted")
    args.asr_python = args.asr_python or asr_python_default(args.synthesis_python)
    args.speaker_python = args.speaker_python or speaker_python_default(args.synthesis_python)

    if args.profile_json and (args.reference_audio or args.prompt_text or args.prompt_text_file):
        raise SystemExit("Use either --profile-json or --reference-audio/--prompt-text*, not both.")

    speaker_status, speaker_backend_check = speaker_backend_status(args.speaker_python)
    speaker_backends = speaker_status.get("backends") if isinstance(speaker_status.get("backends"), dict) else {}
    selected_speaker_backend = select_speaker_backend(args.speaker_backend, speaker_status)
    speaker_backend_requirement = {
        "requested": args.speaker_backend,
        "selected": selected_speaker_backend,
        "required": args.require_speaker_backend,
        "availability": speaker_backends,
        "speakerPython": args.speaker_python,
        "check": speaker_backend_check,
    }
    selected_backend_info = speaker_backends.get(selected_speaker_backend, {}) if isinstance(speaker_backends, dict) else {}
    if args.require_speaker_backend and selected_speaker_backend != args.require_speaker_backend:
        print(
            json.dumps(
                {
                    "status": "speaker_backend_requirement_blocked",
                    "speakerBackendRequirement": speaker_backend_requirement,
                    "reason": f"selected speaker backend {selected_speaker_backend} does not match required backend {args.require_speaker_backend}",
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)
    if not args.dry_run and selected_backend_info.get("available") is not True:
        print(
            json.dumps(
                {
                    "status": "speaker_backend_unavailable",
                    "speakerBackendRequirement": speaker_backend_requirement,
                    "reason": selected_backend_info.get("reason"),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    unsafe_profile_gate_bypass_reason = args.unsafe_profile_gate_bypass_reason.strip()
    profile_gate_bypasses = []
    if args.profile_json and args.skip_profile_verify:
        profile_gate_bypasses.append("profile_verify")
    if args.profile_json and args.skip_transcript_validation:
        profile_gate_bypasses.append("transcript_validation")
    if profile_gate_bypasses and (not args.allow_unsafe_profile_gate_bypass or not unsafe_profile_gate_bypass_reason):
        print(
            json.dumps(
                {
                    "status": "unsafe_profile_gate_bypass_blocked",
                    "profileJson": str(Path(args.profile_json).expanduser().resolve()) if args.profile_json else None,
                    "profileGateBypass": {
                        "requested": profile_gate_bypasses,
                        "acceptedUnsafeBypass": False,
                        "reason": None,
                        "requiredFlags": [
                            "--allow-unsafe-profile-gate-bypass",
                            "--unsafe-profile-gate-bypass-reason",
                        ],
                    },
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    out_dir = Path(args.out_dir).expanduser().resolve()
    args.out_dir = str(out_dir)
    report_path = out_dir / "report.json"
    asr_path = out_dir / "asr.json"
    speaker_path = out_dir / "speaker.json"
    score_path = out_dir / "score.json"
    transcript_validation_path = out_dir / "profile-transcript-validation.json"
    gate_path = out_dir / "quality-gate.json"
    out_dir.mkdir(parents=True, exist_ok=True)

    steps: list[dict[str, Any]] = []
    status = "pass"

    if args.profile_json and not args.skip_profile_verify:
        verify_cmd = [
            sys.executable,
            str(SCRIPT_DIR / "verify_voice_profile_ready.py"),
            "--profile-json",
            str(Path(args.profile_json).expanduser()),
        ]
        step = run_step("profile_verify", verify_cmd)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    profile_transcript_validation_json: Path | None = None
    if args.profile_json and not args.skip_transcript_validation and status == "pass":
        profile_transcript_validation_json = (
            Path(args.transcript_validation_json).expanduser().resolve()
            if args.transcript_validation_json
            else transcript_validation_path
        )
        if not args.transcript_validation_json:
            transcript_validation_cmd = [
                args.asr_python,
                str(SCRIPT_DIR / "validate_voice_profile_transcripts.py"),
                "--profile-json",
                str(Path(args.profile_json).expanduser()),
                "--out",
                str(profile_transcript_validation_json),
                "--backend",
                args.asr_backend,
                "--model",
                args.asr_model,
                "--language",
                args.asr_language,
                "--device",
                args.asr_device,
                "--compute-type",
                args.asr_compute_type,
            ]
            if args.dry_run:
                transcript_validation_cmd.append("--dry-run")
            else:
                transcript_validation_cmd.append("--strict")
            step = run_step("profile_transcript_validation", transcript_validation_cmd)
            steps.append(step)
            if step["returnCode"] != 0:
                status = "failed"

    if args.profile_json and not args.skip_profile_verify and not args.skip_transcript_validation and status == "pass" and not args.dry_run:
        verify_cmd = [
            sys.executable,
            str(SCRIPT_DIR / "verify_voice_profile_ready.py"),
            "--profile-json",
            str(Path(args.profile_json).expanduser()),
        ]
        verify_cmd.append("--require-transcript-validation")
        if profile_transcript_validation_json:
            verify_cmd.extend(["--transcript-validation-json", str(profile_transcript_validation_json)])
        step = run_step("profile_verify_transcripts", verify_cmd)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    if status == "pass":
        regression_cmd = [sys.executable, str(SCRIPT_DIR / "voice_clone_regression.py")]
        append_common_regression_args(regression_cmd, args)
        if args.profile_json and profile_transcript_validation_json and not args.skip_transcript_validation:
            regression_cmd.extend(["--transcript-validation-json", str(profile_transcript_validation_json)])
        if args.profile_json and profile_gate_bypasses:
            regression_cmd.extend(
                [
                    "--skip-strict-profile-proof",
                    "--allow-unsafe-profile-proof-bypass",
                    "--unsafe-profile-proof-bypass-reason",
                    unsafe_profile_gate_bypass_reason,
                ]
            )
        step = run_step("regression", regression_cmd)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    if status == "pass":
        asr_cmd = [
            args.asr_python,
            str(SCRIPT_DIR / "transcribe_voice_regression.py"),
            str(report_path),
            "--out",
            str(asr_path),
            "--backend",
            args.asr_backend,
            "--model",
            args.asr_model,
            "--language",
            args.asr_language,
            "--device",
            args.asr_device,
            "--compute-type",
            args.asr_compute_type,
            "--strict",
        ]
        if args.dry_run:
            asr_cmd.append("--dry-run")
        step = run_step("asr", asr_cmd)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    if status == "pass":
        speaker_cmd = [
            args.speaker_python,
            str(SCRIPT_DIR / "score_speaker_similarity.py"),
            str(report_path),
            "--out",
            str(speaker_path),
            "--backend",
            args.speaker_backend,
            "--strict",
        ]
        if args.speaker_model:
            speaker_cmd.extend(["--model", args.speaker_model])
        if args.profile_json:
            speaker_cmd.extend(["--profile-json", str(Path(args.profile_json).expanduser())])
        if args.dry_run:
            speaker_cmd.append("--dry-run")
        step = run_step("speaker_similarity", speaker_cmd)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    if args.dry_run and status == "pass":
        status = "planned"

    score_command = [
        sys.executable,
        str(SCRIPT_DIR / "score_voice_regression.py"),
        str(report_path),
        "--asr-json",
        str(asr_path),
        "--speaker-json",
        str(speaker_path),
        "--out",
        str(score_path),
        "--min-speaker-similarity",
        str(args.min_speaker_similarity),
        "--min-reduction-pct",
        str(args.min_reduction_pct),
        "--strict",
    ]
    if args.baseline_score:
        score_command.extend(["--baseline-score", str(Path(args.baseline_score).expanduser())])
    if args.clone_mode == "both":
        score_command.extend(
            [
                "--baseline-clone-mode",
                "prompt",
                "--candidate-clone-mode",
                "hifi",
                "--min-paired-reduction-pct",
                str(args.min_reduction_pct),
                "--require-paired-improvement",
            ]
        )

    if status == "pass":
        step = run_step("score", score_command)
        steps.append(step)
        if step["returnCode"] != 0:
            status = "failed"

    parsed_outputs = {step["name"]: parse_json_stdout(step) for step in steps}
    profile_path = Path(args.profile_json).expanduser().resolve() if args.profile_json else None
    profile_json = str(profile_path) if profile_path else None
    profile_sha256 = canonical_profile_sha256(profile_path)
    transcript_validation_sha256 = file_sha256(profile_transcript_validation_json) if profile_transcript_validation_json else None
    reference_audio = str(Path(args.reference_audio).expanduser().resolve()) if args.reference_audio else None
    prompt_text_file = str(Path(args.prompt_text_file).expanduser().resolve()) if args.prompt_text_file else None
    lora_path = resolved_env_path("ANYVOICE_VOXCPM_LORA_PATH")
    profile_gate = bool(args.profile_json)
    profile_verify_required = profile_gate and not args.skip_profile_verify
    transcript_validation_required = profile_gate and not args.skip_transcript_validation
    profile_verify_skipped = profile_gate and args.skip_profile_verify
    transcript_validation_skipped = profile_gate and args.skip_transcript_validation
    strict_profile_proof_required = profile_gate and not profile_gate_bypasses
    strict_profile_proof_passed = (
        (not profile_gate)
        or (
            strict_profile_proof_required
            and step_passed(steps, "regression")
        )
    )
    profile_gate_bypass = {
        "requested": profile_gate_bypasses,
        "acceptedUnsafeBypass": bool(profile_gate_bypasses and args.allow_unsafe_profile_gate_bypass),
        "reason": unsafe_profile_gate_bypass_reason if profile_gate_bypasses else None,
    }
    gate = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "dryRun": args.dry_run,
        "inputs": {
            "profileJson": profile_json,
            "profileSha256": profile_sha256,
            "referenceAudio": reference_audio,
            "promptTextFile": prompt_text_file,
            "cloneMode": args.clone_mode,
            "quality": args.quality,
            "repeats": args.repeats,
            "synthesisPython": args.synthesis_python,
            "asrPython": args.asr_python,
            "speakerPython": args.speaker_python,
            "hotWorkerUrl": args.hot_worker_url or None,
            "modelId": args.model_id,
            "loraPath": lora_path,
            "stabilitySeed": args.seed,
            "evalSet": str(Path(args.eval_set).expanduser().resolve()),
            "case": args.case,
            "tag": args.tag,
            "maxCases": args.max_cases,
            "transcriptValidationJson": str(profile_transcript_validation_json) if profile_transcript_validation_json else None,
            "transcriptValidationSha256": transcript_validation_sha256,
            "skipProfileVerify": args.skip_profile_verify,
            "skipTranscriptValidation": args.skip_transcript_validation,
            "profileGateBypass": profile_gate_bypass,
            "speakerBackend": args.speaker_backend,
            "selectedSpeakerBackend": selected_speaker_backend,
            "requireSpeakerBackend": args.require_speaker_backend,
            "minSpeakerSimilarity": args.min_speaker_similarity,
            "baselineScore": str(Path(args.baseline_score).expanduser().resolve()) if args.baseline_score else None,
            "minReductionPct": args.min_reduction_pct,
        },
        "proofs": {
            "profileVerifyRequired": profile_verify_required,
            "profileVerifySkipped": profile_verify_skipped,
            "profileVerifyPassed": (not profile_gate) or (profile_verify_required and step_passed(steps, "profile_verify")),
            "transcriptValidationRequired": transcript_validation_required,
            "transcriptValidationSkipped": transcript_validation_skipped,
            "transcriptValidationJson": str(profile_transcript_validation_json) if profile_transcript_validation_json else None,
            "transcriptValidationSha256": transcript_validation_sha256,
            "transcriptValidationPassed": (
                (not profile_gate)
                or (
                    transcript_validation_required
                    and (
                        step_passed(steps, "profile_verify_transcripts")
                        or (bool(args.transcript_validation_json) and strict_profile_proof_passed)
                    )
                )
            ),
            "strictProfileProofRequired": strict_profile_proof_required,
            "strictProfileProofPassed": strict_profile_proof_passed,
            "speakerBackendRequirement": speaker_backend_requirement,
            "loraAdapter": lora_adapter_evidence(lora_path),
            "artifacts": {
                "report": artifact_evidence(report_path),
                "asr": artifact_evidence(asr_path),
                "speaker": artifact_evidence(speaker_path),
                "score": artifact_evidence(score_path),
            },
        },
        "paths": {
            "outDir": str(out_dir),
            "report": str(report_path),
            "asr": str(asr_path),
            "speaker": str(speaker_path),
            "score": str(score_path),
            "profileTranscriptValidation": str(profile_transcript_validation_json) if profile_transcript_validation_json else None,
            "qualityGate": str(gate_path),
        },
        "commands": {
            "score": shell_join(score_command),
        },
        "steps": steps,
        "outputs": parsed_outputs,
    }
    write_json(gate_path, gate)
    print(
        json.dumps(
            {
                "status": status,
                "qualityGate": str(gate_path),
                "report": str(report_path),
                "asr": str(asr_path),
                "speaker": str(speaker_path),
                "score": str(score_path),
            },
            ensure_ascii=False,
        )
    )
    if status == "failed":
        sys.exit(2)


if __name__ == "__main__":
    main()

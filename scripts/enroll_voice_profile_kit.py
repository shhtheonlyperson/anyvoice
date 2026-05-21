from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNS_DIR = REPO_ROOT / ".anyvoice" / "runs"
DEFAULT_VOICES_DIR = REPO_ROOT / ".anyvoice" / "voices"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_or_text(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return stdout.strip()


def run_step(name: str, command: list[str]) -> dict[str, Any]:
    started_at = utc_now()
    proc = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    return {
        "name": name,
        "command": command,
        "exitCode": proc.returncode,
        "startedAt": started_at,
        "completedAt": utc_now(),
        "stdout": json_or_text(proc.stdout.strip()) if proc.stdout.strip() else None,
        "stderr": proc.stderr.strip() or None,
    }


def profile_path(voices_dir: Path, profile_id: str) -> Path:
    return voices_dir / profile_id / "profile.json"


def default_analyzer_python() -> str:
    brenda_python = Path("/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python")
    return str(brenda_python) if brenda_python.exists() else sys.executable


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


def default_transcript_python(analyzer_python: str) -> str:
    return local_env_value("ANYVOICE_ASR_PYTHON") or local_env_value("ANYVOICE_VOXCPM_PYTHON") or analyzer_python or sys.executable


def main() -> None:
    parser = argparse.ArgumentParser(description="Check, import, and verify an AnyVoice recording kit as a reusable digital voice profile.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", help="Path to a recording kit manifest.json.")
    source.add_argument("--kit-dir", help="Recording kit directory containing manifest.json.")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    parser.add_argument("--voices-dir", default=str(DEFAULT_VOICES_DIR))
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--source-kind", choices=("scripted", "freeform", "uploaded"), default="scripted")
    parser.add_argument("--analyzer-python", default="")
    parser.add_argument("--transcript-python", default="", help="Python interpreter used for ASR transcript validation. Defaults to ANYVOICE_ASR_PYTHON, then ANYVOICE_VOXCPM_PYTHON, then --analyzer-python.")
    parser.add_argument("--trust-manifest-quality", action="store_true", help="Use manifest quality values instead of analyzing audio. Intended only for already-analyzed tests/migrations.")
    parser.add_argument("--allow-unsafe-trust-manifest-quality", action="store_true", help="Allow --trust-manifest-quality for migration/debug imports. Requires --unsafe-manifest-quality-reason.")
    parser.add_argument("--unsafe-manifest-quality-reason", default="", help="Required reason when trusting manifest quality instead of analyzing audio.")
    parser.add_argument("--skip-kit-check", action="store_true", help="Import without the preflight recording kit check.")
    parser.add_argument("--allow-unsafe-skip-kit-check", action="store_true", help="Allow --skip-kit-check for migration/debug imports. Requires --unsafe-skip-kit-check-reason.")
    parser.add_argument("--unsafe-skip-kit-check-reason", default="", help="Required reason when bypassing the recording-kit preflight check.")
    parser.add_argument("--validate-transcripts", action="store_true", help="Run ASR transcript validation after import and require it in the final verifier.")
    parser.add_argument("--transcript-validation-json", help="Existing ASR validation report to require in the final verifier.")
    parser.add_argument("--transcript-asr-json", help="External ASR JSON for validate_voice_profile_transcripts.py.")
    parser.add_argument("--transcript-backend", choices=("auto", "faster-whisper", "whisper-cli"), default="auto")
    parser.add_argument("--transcript-model", default="large-v3")
    parser.add_argument("--require-transcript-validation", action="store_true", help="Fail final verification unless ASR transcript validation is present and passing.")
    args = parser.parse_args()

    manifest_path = (
        Path(args.kit_dir).expanduser().resolve() / "manifest.json"
        if args.kit_dir
        else Path(args.manifest).expanduser().resolve()
    )
    runs_dir = Path(args.runs_dir).expanduser().resolve()
    voices_dir = Path(args.voices_dir).expanduser().resolve()
    resolved_profile_path = profile_path(voices_dir, args.profile_id)
    transcript_python = args.transcript_python or default_transcript_python(args.analyzer_python)
    unsafe_skip_reason = args.unsafe_skip_kit_check_reason.strip()
    unsafe_quality_reason = args.unsafe_manifest_quality_reason.strip()

    steps: list[dict[str, Any]] = []
    if args.trust_manifest_quality and (not args.allow_unsafe_trust_manifest_quality or not unsafe_quality_reason):
        print(
            json.dumps(
                {
                    "status": "unsafe_trust_manifest_quality_blocked",
                    "manifest": str(manifest_path),
                    "profileJson": str(resolved_profile_path),
                    "manifestQuality": {
                        "trusted": True,
                        "acceptedUnsafeTrust": False,
                        "reason": None,
                        "requiredFlags": [
                            "--allow-unsafe-trust-manifest-quality",
                            "--unsafe-manifest-quality-reason",
                        ],
                    },
                    "steps": steps,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    if args.skip_kit_check and (not args.allow_unsafe_skip_kit_check or not unsafe_skip_reason):
        print(
            json.dumps(
                {
                    "status": "unsafe_skip_kit_check_blocked",
                    "manifest": str(manifest_path),
                    "profileJson": str(resolved_profile_path),
                    "kitCheck": {
                        "skipped": True,
                        "acceptedUnsafeSkip": False,
                        "reason": None,
                        "requiredFlags": ["--allow-unsafe-skip-kit-check", "--unsafe-skip-kit-check-reason"],
                    },
                    "steps": steps,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    kit_check_status = {
        "skipped": bool(args.skip_kit_check),
        "acceptedUnsafeSkip": bool(args.skip_kit_check and args.allow_unsafe_skip_kit_check),
        "reason": unsafe_skip_reason if args.skip_kit_check else None,
    }
    manifest_quality_status = {
        "trusted": bool(args.trust_manifest_quality),
        "acceptedUnsafeTrust": bool(args.trust_manifest_quality and args.allow_unsafe_trust_manifest_quality),
        "reason": unsafe_quality_reason if args.trust_manifest_quality else None,
    }
    if not args.skip_kit_check:
        steps.append(
            run_step(
                "recording_kit_check",
                [
                    sys.executable,
                    str(REPO_ROOT / "scripts" / "check_voice_profile_recording_kit.py"),
                    "--manifest",
                    str(manifest_path),
                    "--profile-id",
                    args.profile_id,
                ],
            )
        )
        if steps[-1]["exitCode"] != 0:
            print(
                json.dumps(
                    {
                        "status": "incomplete_recording_kit",
                        "manifest": str(manifest_path),
                        "profileJson": str(resolved_profile_path),
                        "kitCheck": kit_check_status,
                        "manifestQuality": manifest_quality_status,
                        "steps": steps,
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
            )
            raise SystemExit(2)

    import_cmd = [
        args.analyzer_python or default_analyzer_python(),
        str(REPO_ROOT / "scripts" / "import_voice_profile_clips.py"),
        "--manifest",
        str(manifest_path),
        "--runs-dir",
        str(runs_dir),
        "--voices-dir",
        str(voices_dir),
        "--profile-id",
        args.profile_id,
        "--source-kind",
        args.source_kind,
        "--build-profile",
    ]
    if args.analyzer_python:
        import_cmd.extend(["--analyzer-python", args.analyzer_python])
    if args.trust_manifest_quality:
        import_cmd.append("--trust-manifest-quality")
        import_cmd.extend([
            "--allow-unsafe-trust-manifest-quality",
            "--unsafe-manifest-quality-reason",
            unsafe_quality_reason,
        ])
    steps.append(run_step("import_profile_clips", import_cmd))
    if steps[-1]["exitCode"] != 0:
        print(
            json.dumps(
                {
                    "status": "import_failed",
                    "manifest": str(manifest_path),
                    "profileJson": str(resolved_profile_path),
                    "kitCheck": kit_check_status,
                    "manifestQuality": manifest_quality_status,
                    "steps": steps,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(1)

    transcript_validation_json = (
        Path(args.transcript_validation_json).expanduser().resolve()
        if args.transcript_validation_json
        else None
    )
    if args.validate_transcripts:
        transcript_validation_json = resolved_profile_path.parent / "transcript-validation.json"
        validation_cmd = [
            transcript_python,
            str(REPO_ROOT / "scripts" / "validate_voice_profile_transcripts.py"),
            "--profile-json",
            str(resolved_profile_path),
            "--out",
            str(transcript_validation_json),
            "--backend",
            args.transcript_backend,
            "--model",
            args.transcript_model,
            "--strict",
        ]
        if args.transcript_asr_json:
            validation_cmd.extend(["--asr-json", str(Path(args.transcript_asr_json).expanduser().resolve())])
        steps.append(run_step("validate_profile_transcripts", validation_cmd))
        if steps[-1]["exitCode"] != 0:
            print(
                json.dumps(
                    {
                        "status": "transcript_validation_failed",
                        "manifest": str(manifest_path),
                        "profileJson": str(resolved_profile_path),
                        "transcriptValidationJson": str(transcript_validation_json),
                        "transcriptPython": transcript_python,
                        "kitCheck": kit_check_status,
                        "manifestQuality": manifest_quality_status,
                        "steps": steps,
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
            )
            raise SystemExit(2)

    verify_cmd = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "verify_voice_profile_ready.py"),
        "--profile-json",
        str(resolved_profile_path),
    ]
    if transcript_validation_json:
        verify_cmd.extend(["--transcript-validation-json", str(transcript_validation_json)])
    if args.require_transcript_validation or args.validate_transcripts or transcript_validation_json:
        verify_cmd.append("--require-transcript-validation")

    steps.append(run_step("verify_voice_profile", verify_cmd))
    verify_ok = steps[-1]["exitCode"] == 0
    print(
        json.dumps(
            {
                "status": "ready" if verify_ok else "profile_blocked",
                "manifest": str(manifest_path),
                "profileJson": str(resolved_profile_path),
                "transcriptValidationJson": str(transcript_validation_json) if transcript_validation_json else None,
                "transcriptPython": transcript_python if args.validate_transcripts else None,
                "kitCheck": kit_check_status,
                "manifestQuality": manifest_quality_status,
                "steps": steps,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    if not verify_ok:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

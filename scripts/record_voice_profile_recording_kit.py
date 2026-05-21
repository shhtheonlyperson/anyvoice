from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_voice_profile import (
    CHINESE_SCRIPT_MARKER_PAIRS,
    PRODUCT_PRONUNCIATION_PRESET_IDS,
    REQUIRED_COVERAGE_FEATURES,
    REQUIRED_PRONUNCIATION_PRESET_IDS,
    detect_chinese_script,
    pronunciation_preset_ids,
    strict_traditional_script_errors,
    transcript_coverage_features,
)
from check_voice_profile_recording_kit import probe_decoded_level_quality
from import_voice_profile_clips import field, load_json, load_manifest, normalized_transcript, resolve_audio_path
from voice_profile_duration import (
    MAX_PROFILE_DURATION_SEC,
    MIN_ACTIVE_VOICE_SEC,
    MIN_PROFILE_DURATION_SEC,
    clamp_duration_sec,
    recommended_duration_sec,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
MICROPHONE_SMOKE_MIN_PEAK_AMPLITUDE = 0.05
MICROPHONE_SMOKE_MAX_CLIPPING_RATIO = 0.001


def utc_stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def command(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


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
    return local_env_value("ANYVOICE_ASR_PYTHON") or local_env_value("ANYVOICE_VOXCPM_PYTHON") or sys.executable


def recording_guidance(duration_sec: float, *, duration_mode: str = "fixed") -> dict[str, Any]:
    payload: dict[str, Any] = {
        "durationMode": duration_mode,
        "minDurationSec": MIN_PROFILE_DURATION_SEC,
        "maxDurationSec": MAX_PROFILE_DURATION_SEC,
        "minActiveVoiceSec": MIN_ACTIVE_VOICE_SEC,
        "checklist": [
            "read the prompt exactly",
            "use strict Traditional Chinese",
            "keep a stable microphone distance",
            "record in a quiet room without echo",
            "avoid long silent pauses",
        ],
    }
    if duration_mode == "auto":
        payload["targetDurationSec"] = None
        payload["targetDurationLabel"] = "auto per clip"
    else:
        payload["targetDurationSec"] = duration_sec
    return payload


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


def manifest_metadata(path: Path) -> dict[str, Any]:
    if path.suffix.lower() != ".json":
        return {}
    parsed = load_json(path)
    return parsed if isinstance(parsed, dict) else {}


def manifest_required_pronunciation_preset_ids(metadata: dict[str, Any]) -> list[str]:
    prompt_set = str(metadata.get("promptSet") or "").strip().lower()
    return PRODUCT_PRONUNCIATION_PRESET_IDS if prompt_set == "extended" else REQUIRED_PRONUNCIATION_PRESET_IDS


def kit_paths(manifest_path: Path) -> dict[str, Any]:
    cue_sheet = manifest_path.parent / "cue-sheet.html"
    return {
        "kit": str(manifest_path.parent),
        "prompts": str(manifest_path.parent / "prompts"),
        "recordings": str(manifest_path.parent / "recordings"),
        "cueSheetHtml": str(cue_sheet) if cue_sheet.exists() else None,
        "openCueSheetCommand": cue_sheet_open_command(cue_sheet) if cue_sheet.exists() else None,
    }


def cue_sheet_open_command(cue_sheet: Path) -> str:
    return command(["python3", "-m", "webbrowser", "-t", cue_sheet.resolve().as_uri()])


def open_cue_sheet(manifest_path: Path) -> dict[str, Any]:
    cue_sheet = manifest_path.parent / "cue-sheet.html"
    payload: dict[str, Any] = {
        "requested": True,
        "path": str(cue_sheet),
        "exists": cue_sheet.exists(),
        "command": cue_sheet_open_command(cue_sheet),
    }
    if not cue_sheet.exists():
        return {**payload, "status": "missing"}

    proc = subprocess.run(
        [sys.executable, "-m", "webbrowser", "-t", cue_sheet.resolve().as_uri()],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        **payload,
        "status": "opened" if proc.returncode == 0 else "failed",
        "exitCode": proc.returncode,
        "stdout": proc.stdout.strip() or None,
        "stderr": proc.stderr.strip() or None,
    }


def render_template(template: str, values: dict[str, str]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", shlex.quote(value))
    return rendered


def rendered_recorder_command(template: str, spec: dict[str, Any], *, duration_sec: float) -> str:
    return render_template(
        template,
        {
            "audio_path": str(spec["audioPath"]),
            "duration": f"{duration_sec:g}",
            "index": str(spec["index"]),
            "id": str(spec["id"]),
            "prompt_path": str(spec["promptPath"]),
            "transcript": str(spec["transcript"]),
        },
    )


def profile_json_path(profile_id: str) -> Path:
    return REPO_ROOT / ".anyvoice" / "voices" / profile_id / "profile.json"


def proof_command_values(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
) -> dict[str, str]:
    return {
        "manifest": str(manifest_path),
        "kit_manifest": str(manifest_path),
        "profile_id": profile_id,
        "profile_json": str(profile_json_path(profile_id)),
        "record_countdown_sec": str(record_countdown_sec),
    }


def default_after_recording_proof_command(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
) -> str:
    return command(
        [
            "python3",
            "scripts/voice_profile_next_step.py",
            "--profile-json",
            str(profile_json_path(profile_id)),
            "--kit-manifest",
            str(manifest_path),
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
    )


def after_recording_proof_command(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
    template: str | None,
) -> str:
    if template and template.strip():
        return render_template(
            template.strip(),
            proof_command_values(
                manifest_path,
                profile_id,
                record_countdown_sec=record_countdown_sec,
            ),
        )
    return default_after_recording_proof_command(
        manifest_path,
        profile_id,
        record_countdown_sec=record_countdown_sec,
    )


def product_proof_command_from_next_step(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
) -> tuple[str | None, dict[str, Any]]:
    command_parts = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "voice_profile_next_step.py"),
        "--profile-json",
        str(profile_json_path(profile_id)),
        "--kit-manifest",
        str(manifest_path),
        "--profile-id",
        profile_id,
        "--record-countdown-sec",
        str(record_countdown_sec),
    ]
    proc = subprocess.run(
        command_parts,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    meta: dict[str, Any] = {
        "command": command(command_parts),
        "exitCode": proc.returncode,
        "stderr": proc.stderr.strip() or None,
    }
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        meta["stdout"] = proc.stdout.strip() or None
        return None, meta
    proof_plan = payload.get("postRecordingProofPlan") if isinstance(payload, dict) else None
    command_text = proof_plan.get("productProofCommand") if isinstance(proof_plan, dict) else None
    if not isinstance(command_text, str) or not command_text.strip():
        command_text = payload.get("commands", {}).get("qualityGateProductProof") if isinstance(payload, dict) and isinstance(payload.get("commands"), dict) else None
    meta["status"] = payload.get("status") if isinstance(payload, dict) else None
    return (command_text.strip() if isinstance(command_text, str) and command_text.strip() else None), meta


def next_step_command(
    manifest_path: Path,
    profile_id: str,
    command_key: str,
    *,
    record_countdown_sec: int,
) -> tuple[str | None, dict[str, Any]]:
    command_parts = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "voice_profile_next_step.py"),
        "--profile-json",
        str(profile_json_path(profile_id)),
        "--kit-manifest",
        str(manifest_path),
        "--profile-id",
        profile_id,
        "--record-countdown-sec",
        str(record_countdown_sec),
    ]
    proc = subprocess.run(
        command_parts,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    meta: dict[str, Any] = {
        "command": command(command_parts),
        "exitCode": proc.returncode,
        "stderr": proc.stderr.strip() or None,
        "commandKey": command_key,
    }
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        meta["stdout"] = proc.stdout.strip() or None
        return None, meta
    commands = payload.get("commands") if isinstance(payload, dict) else None
    command_text = commands.get(command_key) if isinstance(commands, dict) else None
    meta["status"] = payload.get("status") if isinstance(payload, dict) else None
    meta["nextAction"] = payload.get("nextAction") if isinstance(payload.get("nextAction"), dict) else None
    return (command_text.strip() if isinstance(command_text, str) and command_text.strip() else None), meta


def after_recording_product_proof_command(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
    template: str | None,
) -> tuple[str | None, dict[str, Any] | None]:
    if template and template.strip():
        return (
            render_template(
                template.strip(),
                proof_command_values(
                    manifest_path,
                    profile_id,
                    record_countdown_sec=record_countdown_sec,
                ),
            ),
            None,
        )
    command_text, meta = product_proof_command_from_next_step(
        manifest_path,
        profile_id,
        record_countdown_sec=record_countdown_sec,
    )
    return command_text, meta


def lora_dataset_command_after_product_proof(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int,
    template: str | None,
) -> tuple[str | None, dict[str, Any] | None]:
    if template and template.strip():
        return (
            render_template(
                template.strip(),
                proof_command_values(
                    manifest_path,
                    profile_id,
                    record_countdown_sec=record_countdown_sec,
                ),
            ),
            None,
        )
    command_text, meta = next_step_command(
        manifest_path,
        profile_id,
        "prepareLoraDataset",
        record_countdown_sec=record_countdown_sec,
    )
    return command_text, meta


def default_recorder_template(*, no_default: bool) -> tuple[str, str]:
    env_template = os.environ.get("ANYVOICE_RECORDER_COMMAND", "").strip()
    if env_template:
        return env_template, "env:ANYVOICE_RECORDER_COMMAND"
    if no_default:
        return "", "disabled"

    rec = shutil.which("rec")
    if rec:
        return f"{shlex.quote(rec)} -q -r 16000 -c 1 -b 16 {{audio_path}} trim 0 {{duration}}", "sox:rec"

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg and platform.system() == "Darwin":
        return (
            f"{shlex.quote(ffmpeg)} -hide_banner -loglevel error -y "
            "-f avfoundation -i :0 -t {{duration}} -ar 16000 -ac 1 {{audio_path}}"
        ), "ffmpeg:avfoundation"

    return "", "missing"


def clip_specs(manifest_path: Path) -> list[dict[str, Any]]:
    rows = load_manifest(manifest_path)
    specs: list[dict[str, Any]] = []
    prompts_dir = manifest_path.parent / "prompts"
    for index, row in enumerate(rows, start=1):
        raw_audio = field(row, ("audioPath", "audio", "path", "file"))
        if not raw_audio:
            raise SystemExit(f"manifest row {index} is missing audioPath/audio/path/file")
        transcript = normalized_transcript(field(row, ("transcript", "promptTranscript", "text")))
        if not transcript:
            raise SystemExit(f"manifest row {index} is missing transcript/promptTranscript/text")
        transcript_script = detect_chinese_script(transcript)
        transcript_errors = strict_traditional_script_errors(transcript)
        clip_id = field(row, ("id", "runId", "sourceRunId")) or f"profile-clip-{index:02d}"
        audio_path = resolve_audio_path(raw_audio, manifest_path.parent)
        prompt_path = manifest_path.parent / "prompts" / f"{clip_id}.txt"
        prompt_exists = prompt_path.exists()
        prompt_text = ""
        prompt_errors: list[str] = []
        if prompt_exists:
            try:
                prompt_text = normalized_transcript(prompt_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                prompt_errors.append("prompt_file_unreadable")
            else:
                if prompt_text != transcript:
                    prompt_errors.append("prompt_transcript_mismatch")
        elif prompts_dir.exists():
            prompt_errors.append("prompt_file_missing")
        pronunciation_notes = [
            str(item).strip()
            for item in row.get("pronunciationNotes", [])
            if isinstance(row.get("pronunciationNotes"), list) and isinstance(item, str) and str(item).strip()
        ]
        specs.append(
            {
                "index": index,
                "id": clip_id,
                "audioPath": audio_path,
                "promptPath": prompt_path,
                "promptExists": prompt_exists,
                "promptTranscript": prompt_text,
                "promptErrors": prompt_errors,
                "transcript": transcript,
                "transcriptScript": transcript_script,
                "scriptMarkerHits": chinese_script_marker_hits(transcript),
                "transcriptErrors": transcript_errors,
                "transcriptSha256": text_sha256(transcript),
                "pronunciationPresetIds": pronunciation_preset_ids(transcript),
                "pronunciationNotes": pronunciation_notes,
                "recommendedDurationSec": recommended_duration_sec(transcript),
            }
        )
    return specs


def select_clips(specs: list[dict[str, Any]], selectors: list[str]) -> list[dict[str, Any]]:
    if not selectors:
        return specs
    selected: list[dict[str, Any]] = []
    missing: list[str] = []
    for selector in selectors:
        match = next(
            (
                spec
                for spec in specs
                if selector == str(spec["index"]) or selector == spec["id"]
            ),
            None,
        )
        if match:
            selected.append(match)
        else:
            missing.append(selector)
    if missing:
        raise SystemExit(f"clip selector(s) not found in manifest: {', '.join(missing)}")
    return selected


def audio_file_present(spec: dict[str, Any]) -> bool:
    audio_path: Path = spec["audioPath"]
    return audio_path.exists() and audio_path.stat().st_size > 0


def select_next_missing_clip(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for spec in specs:
        if not audio_file_present(spec):
            return [spec]
    return []


def select_missing_clips(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [spec for spec in specs if not audio_file_present(spec)]


def write_metadata(spec: dict[str, Any], *, recorder_command: str, duration_sec: float) -> Path:
    metadata_path = spec["audioPath"].with_name(f"{spec['audioPath'].name}.recording.json")
    prompt_transcript = str(spec.get("promptTranscript") or "")
    metadata_path.write_text(
        json.dumps(
            {
                "recordedAt": utc_stamp(),
                "id": spec["id"],
                "index": spec["index"],
                "audioPath": str(spec["audioPath"]),
                "promptPath": str(spec["promptPath"]),
                "transcript": spec["transcript"],
                "transcriptSha256": spec["transcriptSha256"],
                "promptTranscript": prompt_transcript,
                "promptTranscriptSha256": text_sha256(prompt_transcript) if prompt_transcript else None,
                "pronunciationPresetIds": spec.get("pronunciationPresetIds", []),
                "pronunciationNotes": spec.get("pronunciationNotes", []),
                "durationTargetSec": duration_sec,
                "recorderCommand": recorder_command,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return metadata_path


def clip_duration_sec(spec: dict[str, Any], args: argparse.Namespace) -> float:
    if getattr(args, "auto_duration", False):
        return float(spec.get("recommendedDurationSec") or recommended_duration_sec(str(spec.get("transcript") or "")))
    return float(args.duration_sec)


def recording_metadata_state(spec: dict[str, Any]) -> dict[str, Any]:
    metadata_path = spec["audioPath"].with_name(f"{spec['audioPath'].name}.recording.json")
    exists = metadata_path.exists()
    transcript = ""
    transcript_sha256 = ""
    errors: list[str] = []
    if exists:
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                raise ValueError("metadata root is not an object")
        except Exception:  # noqa: BLE001
            errors.append("recording_metadata_unreadable")
        else:
            transcript = normalized_transcript(
                str(metadata.get("transcript") or metadata.get("manifestTranscript") or "")
            )
            transcript_sha256 = str(
                metadata.get("transcriptSha256") or metadata.get("manifestTranscriptSha256") or ""
            ).strip().lower()
            expected_sha256 = str(spec["transcriptSha256"])
            if not transcript_sha256:
                errors.append("recording_metadata_transcript_hash_missing")
            elif transcript_sha256 != expected_sha256:
                errors.append("recording_metadata_transcript_mismatch")
            elif transcript and transcript != spec["transcript"]:
                errors.append("recording_metadata_transcript_mismatch")
    return {
        "path": str(metadata_path),
        "exists": exists,
        "transcript": transcript,
        "transcriptSha256": transcript_sha256,
        "expectedTranscriptSha256": spec["transcriptSha256"],
        "errors": errors,
    }


def record_clip(
    spec: dict[str, Any],
    *,
    args: argparse.Namespace,
    recorder_template: str,
) -> dict[str, Any]:
    audio_path: Path = spec["audioPath"]
    existing_bytes = audio_path.stat().st_size if audio_path.exists() else 0
    if existing_bytes > 0 and not args.overwrite:
        return {
            "id": spec["id"],
            "index": spec["index"],
            "audioPath": str(audio_path),
            "status": "skipped_existing",
            "audioBytes": existing_bytes,
        }

    audio_path.parent.mkdir(parents=True, exist_ok=True)
    duration_sec = clip_duration_sec(spec, args)
    recorder_command = rendered_recorder_command(recorder_template, spec, duration_sec=duration_sec)
    print(f"\n[{spec['index']}] {spec['id']}", file=sys.stderr)
    print(spec["transcript"], file=sys.stderr)
    if spec.get("pronunciationNotes"):
        print("Pronunciation notes:", file=sys.stderr)
        for note in spec["pronunciationNotes"]:
            print(f"- {note}", file=sys.stderr)
    print(f"Output: {audio_path}", file=sys.stderr)
    print(f"Target: {duration_sec:g}s", file=sys.stderr)
    if not args.yes:
        print("Press Enter to start recording, or Ctrl-C to stop...", file=sys.stderr)
        input()
    if args.countdown_sec > 0:
        for seconds_left in range(int(args.countdown_sec), 0, -1):
            print(f"Recording starts in {seconds_left}...", file=sys.stderr)
            time.sleep(1)

    proc = subprocess.run(
        recorder_command,
        cwd=str(REPO_ROOT),
        shell=True,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return {
            "id": spec["id"],
            "index": spec["index"],
            "audioPath": str(audio_path),
            "status": "recorder_failed",
            "exitCode": proc.returncode,
            "command": recorder_command,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }

    if not audio_path.exists() or audio_path.stat().st_size <= 0:
        return {
            "id": spec["id"],
            "index": spec["index"],
            "audioPath": str(audio_path),
            "status": "output_missing",
            "command": recorder_command,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }

    result = {
        "id": spec["id"],
        "index": spec["index"],
        "audioPath": str(audio_path),
        "status": "recorded",
        "audioBytes": audio_path.stat().st_size,
        "command": recorder_command,
        "durationMode": "auto" if getattr(args, "auto_duration", False) else "fixed",
        "durationTargetSec": duration_sec,
    }
    if args.write_metadata:
        metadata_path = write_metadata(spec, recorder_command=recorder_command, duration_sec=duration_sec)
        result["recordingMetadataPath"] = str(metadata_path)
    return result


def run_microphone_smoke_test(
    clips: list[dict[str, Any]],
    *,
    recorder_template: str,
    duration_sec: float,
) -> dict[str, Any]:
    if not clips:
        return {
            "status": "skipped",
            "reason": "no selected clips available for microphone smoke test",
            "durationSec": duration_sec,
        }
    clip = next((row for row in clips if row.get("action") == "record"), clips[0])
    with tempfile.TemporaryDirectory(prefix="anyvoice-mic-smoke-") as tmp_dir:
        audio_path = Path(tmp_dir) / "microphone-smoke.wav"
        smoke_spec = {
            **clip,
            "audioPath": audio_path,
            "promptPath": Path(str(clip.get("promptPath") or audio_path.with_suffix(".txt"))),
            "transcript": str(clip.get("transcript") or ""),
        }
        recorder_command = rendered_recorder_command(recorder_template, smoke_spec, duration_sec=duration_sec)
        proc = subprocess.run(
            recorder_command,
            cwd=str(REPO_ROOT),
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        exists = audio_path.exists()
        audio_bytes = audio_path.stat().st_size if exists else 0
        audio_level_quality = None
        level_quality_error = None
        errors: list[str] = []
        if exists and audio_bytes > 0:
            audio_level_quality, level_quality_error = probe_decoded_level_quality(audio_path)
            if level_quality_error or audio_level_quality is None:
                errors.append("audio_level_quality_unreadable")
            else:
                peak = audio_level_quality.get("peakAmplitude")
                clipping_ratio = audio_level_quality.get("clippingRatio")
                if isinstance(peak, (int, float)) and float(peak) < MICROPHONE_SMOKE_MIN_PEAK_AMPLITUDE:
                    errors.append("audio_too_quiet")
                if isinstance(clipping_ratio, (int, float)) and float(clipping_ratio) > MICROPHONE_SMOKE_MAX_CLIPPING_RATIO:
                    errors.append("audio_clipping_detected")
        passed = proc.returncode == 0 and audio_bytes > 0 and not errors
        return {
            "status": "passed" if passed else "failed",
            "durationSec": duration_sec,
            "clipId": clip.get("id"),
            "command": recorder_command,
            "exitCode": proc.returncode,
            "audioBytes": audio_bytes,
            "audioLevelQuality": audio_level_quality,
            "levelQualityError": level_quality_error,
            "minPeakAmplitude": MICROPHONE_SMOKE_MIN_PEAK_AMPLITUDE,
            "maxClippingRatio": MICROPHONE_SMOKE_MAX_CLIPPING_RATIO,
            "errors": errors,
            "keptAudio": False,
            "stdout": proc.stdout.strip() or None,
            "stderr": proc.stderr.strip() or None,
        }


def run_kit_check(manifest_path: Path, profile_id: str) -> tuple[dict[str, Any] | None, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "check_voice_profile_recording_kit.py"),
            "--manifest",
            str(manifest_path),
            "--profile-id",
            profile_id,
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        return json.loads(proc.stdout), proc.stderr.strip()
    except json.JSONDecodeError:
        return None, proc.stderr.strip() or proc.stdout.strip()


def check_detail_rows(check: dict[str, Any]) -> list[dict[str, Any]]:
    details = check.get("details")
    if not isinstance(details, dict):
        return []
    rows = details.get("rows")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def selected_clip_check_payload(check_report: dict[str, Any] | None, specs: list[dict[str, Any]]) -> dict[str, Any]:
    selected_ids = [str(spec["id"]) for spec in specs]
    selected_id_set = set(selected_ids)
    if not check_report:
        return {
            "ok": False,
            "selectedClipIds": selected_ids,
            "failures": [{"check": "recording_kit_check", "message": "recording kit check did not return JSON"}],
        }

    failures: list[dict[str, Any]] = []
    checks = check_report.get("checks") if isinstance(check_report.get("checks"), list) else []
    selected_row_checks = {
        "audio_files",
        "audio_duration",
        "audio_target_duration",
        "audio_voice_activity",
        "audio_level_quality",
        "transcripts",
        "source_kind",
        "prompt_files",
        "recording_metadata",
    }
    for check in checks:
        if not isinstance(check, dict):
            continue
        check_name = str(check.get("check") or "")
        if check_name not in selected_row_checks:
            continue
        for row in check_detail_rows(check):
            clip_id = str(row.get("id") or "").strip()
            if clip_id not in selected_id_set:
                continue
            raw_errors = row.get("errors")
            errors = [str(error) for error in raw_errors] if isinstance(raw_errors, list) else []
            if not errors:
                continue
            failures.append(
                {
                    "check": check_name,
                    "id": clip_id,
                    "errors": errors,
                    "durationSec": row.get("durationSec"),
                    "durationTargetSec": row.get("durationTargetSec"),
                    "minTargetDurationSec": row.get("minTargetDurationSec"),
                    "targetDurationToleranceSec": row.get("targetDurationToleranceSec"),
                    "activeVoiceSec": row.get("activeVoiceSec"),
                    "audioLevelQuality": row.get("audioLevelQuality"),
                    "minPeakAmplitude": row.get("minPeakAmplitude"),
                    "maxClippingRatio": row.get("maxClippingRatio"),
                    "audioPath": row.get("audioPath"),
                }
            )
    failed_ids = sorted({str(failure.get("id")) for failure in failures if failure.get("id")})
    return {
        "ok": not failures,
        "selectedClipIds": selected_ids,
        "failedClipIds": failed_ids,
        "failures": failures,
    }


def status_counts(results: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for result in results:
        status = str(result.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def nearest_existing_parent(path: Path) -> Path:
    parent = path.parent
    while not parent.exists() and parent.parent != parent:
        parent = parent.parent
    return parent


def write_access(path: Path) -> dict[str, Any]:
    parent = nearest_existing_parent(path)
    return {
        "path": str(path),
        "nearestExistingParent": str(parent),
        "parentExists": path.parent.exists(),
        "parentCreatable": parent.exists() and os.access(parent, os.W_OK),
    }


def build_plan_clips(
    specs: list[dict[str, Any]],
    *,
    recorder_configured: bool,
    recorder_template: str,
    duration_sec: float,
    auto_duration: bool,
    overwrite: bool,
) -> list[dict[str, Any]]:
    rows = []
    for spec in specs:
        audio_path: Path = spec["audioPath"]
        exists = audio_file_present(spec)
        recording_metadata = recording_metadata_state(spec)
        target_duration_sec = float(spec.get("recommendedDurationSec") if auto_duration else duration_sec)
        row: dict[str, Any] = {
            "id": spec["id"],
            "index": spec["index"],
            "audioPath": str(audio_path),
            "promptPath": str(spec["promptPath"]),
            "promptExists": spec["promptExists"],
            "promptTranscript": spec["promptTranscript"],
            "promptErrors": spec["promptErrors"],
            "coverageFeatures": transcript_coverage_features(spec["transcript"]),
            "pronunciationPresetIds": spec["pronunciationPresetIds"],
            "pronunciationNotes": spec["pronunciationNotes"],
            "transcriptScript": spec["transcriptScript"],
            "scriptMarkerHits": spec["scriptMarkerHits"],
            "transcriptErrors": spec["transcriptErrors"],
            "exists": exists,
            "action": "record" if overwrite or not exists else "skip_existing",
            "writeAccess": write_access(audio_path),
            "transcript": spec["transcript"],
            "transcriptSha256": spec["transcriptSha256"],
            "recommendedDurationSec": spec["recommendedDurationSec"],
            "durationMode": "auto" if auto_duration else "fixed",
            "durationTargetSec": target_duration_sec,
            "recordingMetadataPath": recording_metadata["path"],
            "recordingMetadataExists": recording_metadata["exists"],
            "recordingMetadataTranscriptSha256": recording_metadata["transcriptSha256"],
            "expectedTranscriptSha256": recording_metadata["expectedTranscriptSha256"],
            "recordingMetadataErrors": recording_metadata["errors"],
        }
        if recorder_configured:
            row["commandPreview"] = rendered_recorder_command(recorder_template, spec, duration_sec=target_duration_sec)
        rows.append(row)
    return rows


def pronunciation_preset_summary(base_payload: dict[str, Any]) -> dict[str, Any]:
    clips = base_payload["clips"]
    manifest_metadata_payload = base_payload.get("manifestMetadata")
    metadata = manifest_metadata_payload if isinstance(manifest_metadata_payload, dict) else {}
    required = manifest_required_pronunciation_preset_ids(metadata)
    covered = sorted({preset_id for clip in clips for preset_id in clip.get("pronunciationPresetIds", [])})
    return {
        "requiredPronunciationPresetIds": required,
        "coveredPronunciationPresetIds": covered,
        "missingPronunciationPresetIds": [preset_id for preset_id in required if preset_id not in covered],
    }


def preflight_payload(
    base_payload: dict[str, Any],
    *,
    recorder_configured: bool,
    recorder_template: str,
    microphone_smoke_sec: float,
) -> tuple[dict[str, Any], int]:
    clips = base_payload["clips"]
    to_record = [clip for clip in clips if clip["action"] == "record"]
    prompt_blocked = [clip for clip in clips if clip.get("promptErrors")]
    transcript_blocked = [clip for clip in clips if clip.get("transcriptErrors")]
    metadata_blocked = [
        clip
        for clip in clips
        if clip["action"] == "skip_existing" and clip.get("recordingMetadataErrors")
    ]
    blocked_writes = [
        clip
        for clip in to_record
        if not clip.get("writeAccess", {}).get("parentCreatable")
    ]
    summary = {
        "clips": len(clips),
        "existing": sum(1 for clip in clips if clip["exists"]),
        "toRecord": len(to_record),
        "toSkipExisting": sum(1 for clip in clips if clip["action"] == "skip_existing"),
        "promptBlocked": len(prompt_blocked),
        "transcriptBlocked": len(transcript_blocked),
        "recordingMetadataChecked": sum(1 for clip in clips if clip.get("recordingMetadataExists")),
        "recordingMetadataBlocked": len(metadata_blocked),
        "writeBlocked": len(blocked_writes),
        **pronunciation_preset_summary(base_payload),
    }
    if prompt_blocked:
        return (
            {
                "status": "blocked",
                "message": "one or more prompt files do not match the recording manifest",
                "summary": summary,
                **base_payload,
            },
            2,
        )
    if transcript_blocked:
        return (
            {
                "status": "blocked",
                "message": "one or more recording transcripts use Simplified or mixed Chinese; fix the manifest before recording",
                "summary": summary,
                **base_payload,
            },
            2,
        )
    if metadata_blocked:
        return (
            {
                "status": "blocked",
                "message": "one or more existing recording sidecars do not match the recording manifest",
                "summary": summary,
                **base_payload,
            },
            2,
        )
    if blocked_writes:
        return (
            {
                "status": "blocked",
                "message": "one or more recording directories are not writable",
                "summary": summary,
                **base_payload,
            },
            2,
        )
    if to_record and not recorder_configured:
        return (
            {
                "status": "blocked",
                "message": "no recorder command configured; install sox/rec or ffmpeg, set ANYVOICE_RECORDER_COMMAND, or pass --recorder-command",
                "summary": summary,
                **base_payload,
            },
            2,
        )
    if microphone_smoke_sec > 0 and recorder_configured:
        smoke_test = run_microphone_smoke_test(
            clips,
            recorder_template=recorder_template,
            duration_sec=microphone_smoke_sec,
        )
        base_payload["microphoneSmokeTest"] = smoke_test
        if smoke_test["status"] != "passed":
            return (
                {
                    "status": "blocked",
                    "message": "microphone smoke test failed; fix recorder permissions, device, or input level before recording the full kit",
                    "summary": summary,
                    **base_payload,
                },
                2,
            )
    if not to_record:
        return (
            {
                "status": "all_recordings_present",
                "message": "all selected clips already have non-empty audio files",
                "summary": summary,
                **base_payload,
            },
            0,
        )
    return (
        {
            "status": "ready_to_record",
            "message": f"{len(to_record)} clip(s) will be recorded",
            "summary": summary,
            **base_payload,
        },
        0,
    )


def rehearsal_payload(base_payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    clips = base_payload["clips"]
    prompt_blocked = [clip for clip in clips if clip.get("promptErrors")]
    transcript_blocked = [clip for clip in clips if clip.get("transcriptErrors")]
    covered = sorted({feature for clip in clips for feature in clip.get("coverageFeatures", [])})
    missing_coverage = [feature for feature in REQUIRED_COVERAGE_FEATURES if feature not in covered]
    summary = {
        "clips": len(clips),
        "existing": sum(1 for clip in clips if clip["exists"]),
        "promptBlocked": len(prompt_blocked),
        "transcriptBlocked": len(transcript_blocked),
        "coveredFeatures": covered,
        "missingCoverageFeatures": missing_coverage,
        **pronunciation_preset_summary(base_payload),
    }
    status = "blocked" if prompt_blocked or transcript_blocked else "ready_to_rehearse"
    message = (
        "one or more prompt files do not match the recording manifest"
        if prompt_blocked
        else "one or more recording transcripts use Simplified or mixed Chinese; fix the manifest before recording"
        if transcript_blocked
        else "read these prompts exactly before recording"
    )
    return (
        {
            "status": status,
            "message": message,
            "summary": summary,
            **base_payload,
        },
        2 if prompt_blocked or transcript_blocked else 0,
    )


def run_after_recording_proof(command_text: str) -> dict[str, Any]:
    proc = subprocess.run(
        command_text,
        cwd=str(REPO_ROOT),
        shell=True,
        capture_output=True,
        text=True,
        check=False,
    )
    stdout_text = proc.stdout.strip()
    stderr_text = proc.stderr.strip()
    try:
        stdout: Any = json.loads(stdout_text) if stdout_text else None
    except json.JSONDecodeError:
        stdout = stdout_text
    return {
        "status": "passed" if proc.returncode == 0 else "failed",
        "command": command_text,
        "exitCode": proc.returncode,
        "stdout": stdout,
        "stderr": stderr_text or None,
    }


def clip_list(items: list[str], *, max_items: int = 6) -> str:
    if len(items) <= max_items:
        return ", ".join(items)
    visible = ", ".join(items[:max_items])
    return f"{visible}, ... (+{len(items) - max_items} more)"


def render_brief(payload: dict[str, Any]) -> str:
    lines: list[str] = []
    status = str(payload.get("status") or "unknown")
    message = str(payload.get("message") or "").strip()
    lines.append(f"Status: {status}")
    if message:
        lines.append(f"Message: {message}")

    metadata = payload.get("manifestMetadata") if isinstance(payload.get("manifestMetadata"), dict) else {}
    prompt_set = metadata.get("promptSet")
    required_clips = metadata.get("requiredClips")
    lines.append(f"Manifest: {payload.get('manifest')}")
    if payload.get("kit"):
        lines.append(f"Kit: {payload.get('kit')}")
    if prompt_set or required_clips:
        parts = []
        if prompt_set:
            parts.append(f"promptSet={prompt_set}")
        if required_clips:
            parts.append(f"requiredClips={required_clips}")
        lines.append(f"Kit metadata: {', '.join(parts)}")
    if payload.get("cueSheetHtml"):
        lines.append(f"Cue sheet: {payload.get('cueSheetHtml')}")
    if payload.get("openCueSheetCommand"):
        lines.append(f"Open cue sheet: {payload.get('openCueSheetCommand')}")
    if payload.get("recordings"):
        lines.append(f"Recordings: {payload.get('recordings')}")

    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    if summary:
        summary_bits = []
        for key in ("clips", "existing", "toRecord", "toSkipExisting", "promptBlocked", "transcriptBlocked", "recordingMetadataBlocked", "writeBlocked"):
            value = summary.get(key)
            if isinstance(value, int):
                summary_bits.append(f"{key}={value}")
        if summary_bits:
            lines.append(f"Summary: {', '.join(summary_bits)}")
        missing_presets = summary.get("missingPronunciationPresetIds")
        if isinstance(missing_presets, list) and missing_presets:
            lines.append(f"Missing pronunciation presets: {clip_list([str(item) for item in missing_presets])}")

    recorder = payload.get("recorder") if isinstance(payload.get("recorder"), dict) else {}
    if recorder:
        configured = "yes" if recorder.get("configured") else "no"
        source = recorder.get("source") or "unknown"
        lines.append(f"Recorder: {configured} ({source})")
    smoke_test = payload.get("microphoneSmokeTest") if isinstance(payload.get("microphoneSmokeTest"), dict) else {}
    if smoke_test:
        status_text = smoke_test.get("status") or "unknown"
        bytes_text = smoke_test.get("audioBytes")
        suffix = f", bytes={bytes_text}" if isinstance(bytes_text, int) else ""
        raw_errors = smoke_test.get("errors")
        errors = [str(error) for error in raw_errors] if isinstance(raw_errors, list) else []
        if errors:
            suffix = f"{suffix}, errors={clip_list(errors, max_items=3)}"
        level = smoke_test.get("audioLevelQuality") if isinstance(smoke_test.get("audioLevelQuality"), dict) else {}
        if isinstance(level.get("peakAmplitude"), (int, float)) and isinstance(level.get("clippingRatio"), (int, float)):
            suffix = f"{suffix}, peak={level['peakAmplitude']}, clipping={level['clippingRatio']}"
        lines.append(f"Microphone smoke test: {status_text}{suffix}")

    guidance = payload.get("recordingGuidance") if isinstance(payload.get("recordingGuidance"), dict) else {}
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

    clips = payload.get("clips") if isinstance(payload.get("clips"), list) else []
    record_clips = [clip for clip in clips if isinstance(clip, dict) and clip.get("action") == "record"]
    blocked_clips = [
        clip
        for clip in clips
        if isinstance(clip, dict)
        and (clip.get("promptErrors") or clip.get("transcriptErrors") or clip.get("recordingMetadataErrors"))
    ]
    if record_clips:
        ids = [str(clip.get("id")) for clip in record_clips if clip.get("id")]
        lines.append(f"To record: {clip_list(ids)}")
        first = record_clips[0]
        lines.append("Next clip:")
        lines.append(f"- {first.get('id')} -> {first.get('audioPath')}")
        if isinstance(first.get("durationTargetSec"), (int, float)):
            lines.append(f"  Target: {first.get('durationTargetSec'):g}s")
        prompt = str(first.get("promptTranscript") or first.get("transcript") or "").strip()
        if prompt:
            lines.append(f"  Prompt: {prompt}")
        notes = [str(note) for note in first.get("pronunciationNotes", []) if isinstance(note, str)] if isinstance(first.get("pronunciationNotes"), list) else []
        if notes:
            lines.append(f"  Notes: {clip_list(notes, max_items=3)}")
    elif clips:
        lines.append("To record: none")
    if blocked_clips:
        ids = [str(clip.get("id")) for clip in blocked_clips if isinstance(clip, dict) and clip.get("id")]
        lines.append(f"Blocked clips: {clip_list(ids)}")

    commands = payload.get("nextCommands") if isinstance(payload.get("nextCommands"), dict) else {}
    command_rows = [
        ("openCueSheet", "Open cue sheet"),
        ("rehearse", "Rehearse"),
        ("preflightBrief", "Preflight brief"),
        ("microphoneSmokeTest", "Microphone smoke test"),
        ("recordNextMissing", "Record next missing + check"),
        ("recordMissingUntilComplete", "Record all missing + check"),
        ("recordAndProve", "Record + proof"),
        ("recordProveAndProductProof", "Record + product proof"),
        ("recordProveProductProofAndLoraHandoff", "Record + product proof + LoRA handoff"),
    ]
    available_commands = [(label, commands[key]) for key, label in command_rows if isinstance(commands.get(key), str)]
    if available_commands:
        lines.append("Commands:")
        for label, text in available_commands:
            lines.append(f"- {label}: {text}")

    return "\n".join(lines) + "\n"


def print_report(payload: dict[str, Any], *, brief: bool) -> None:
    if brief:
        print(render_brief(payload), end="")
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def next_commands(
    manifest_path: Path,
    profile_id: str,
    *,
    record_countdown_sec: int = 2,
    auto_duration: bool = True,
) -> dict[str, str]:
    duration_args = ["--auto-duration"] if auto_duration else []
    smoke_args = ["--microphone-smoke-sec", "2"]
    commands = {
        "rehearse": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--rehearse",
            "--no-default-recorder",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "preflight": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--preflight",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "preflightBrief": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--preflight",
            "--brief",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "microphoneSmokeTest": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--preflight",
            "--brief",
            "--microphone-smoke-sec",
            "2",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "record": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--open-cue-sheet",
            *smoke_args,
            "--check",
            "--countdown-sec",
            str(record_countdown_sec),
            "--write-metadata",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "recordNextMissing": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--next-missing",
            "--open-cue-sheet",
            "--countdown-sec",
            str(record_countdown_sec),
            *smoke_args,
            "--write-metadata",
            "--check-selected",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "recordMissingUntilComplete": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--countdown-sec",
            str(record_countdown_sec),
            *smoke_args,
            "--write-metadata",
            "--check",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "recordAndProve": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--countdown-sec",
            str(record_countdown_sec),
            *smoke_args,
            "--write-metadata",
            "--check",
            "--run-proof-after-check",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "recordProveAndProductProof": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--countdown-sec",
            str(record_countdown_sec),
            *smoke_args,
            "--write-metadata",
            "--check",
            "--run-product-proof-after-check",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "recordProveProductProofAndLoraHandoff": command([
            "python3",
            "scripts/record_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--record-missing-until-complete",
            "--open-cue-sheet",
            "--countdown-sec",
            str(record_countdown_sec),
            *smoke_args,
            "--write-metadata",
            "--check",
            "--prepare-lora-after-product-proof",
            *duration_args,
            "--profile-id",
            profile_id,
        ]),
        "check": command([
            "python3",
            "scripts/check_voice_profile_recording_kit.py",
            "--manifest",
            str(manifest_path),
            "--profile-id",
            profile_id,
        ]),
        "enroll": command([
            "python3",
            "scripts/enroll_voice_profile_kit.py",
            "--manifest",
            str(manifest_path),
            "--profile-id",
            profile_id,
        ]),
        "enrollAndValidate": command([
            "python3",
            "scripts/enroll_voice_profile_kit.py",
            "--manifest",
            str(manifest_path),
            "--profile-id",
            profile_id,
            "--validate-transcripts",
            "--transcript-python",
            default_asr_python(),
        ]),
    }
    cue_sheet = manifest_path.parent / "cue-sheet.html"
    if cue_sheet.exists():
        commands["openCueSheet"] = cue_sheet_open_command(cue_sheet)
    return commands


def main() -> None:
    parser = argparse.ArgumentParser(description="Record guided AnyVoice profile-kit prompts into the WAV paths expected by manifest.json.")
    parser.add_argument("--manifest", required=True, help="Recording kit manifest.json produced by prepare_voice_profile_recording_kit.py.")
    parser.add_argument("--clip", action="append", default=[], help="Record only a 1-based index or clip id. Can be repeated.")
    parser.add_argument("--next-missing", action="store_true", help="Record only the first selected clip whose audio file is missing or empty.")
    parser.add_argument("--record-missing-until-complete", action="store_true", help="Record each selected missing clip one at a time, validating each take before continuing.")
    parser.add_argument("--duration-sec", type=float, default=9.0, help="Target recording duration for each clip.")
    parser.add_argument("--auto-duration", action="store_true", help="Use transcript-aware per-clip recording targets between 6 and 20 seconds.")
    parser.add_argument("--allow-out-of-range-duration", action="store_true", help="Allow a recording target outside the 6-20s profile gate for debugging.")
    parser.add_argument("--recorder-command", help="Recorder command template. Supports {audio_path}, {duration}, {index}, {id}, {prompt_path}, {transcript}.")
    parser.add_argument("--no-default-recorder", action="store_true", help="Do not auto-detect rec/ffmpeg or ANYVOICE_RECORDER_COMMAND.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite non-empty audio files instead of skipping them.")
    parser.add_argument("--yes", action="store_true", help="Do not wait for Enter before each recording.")
    parser.add_argument("--open-cue-sheet", action="store_true", help="Open cue-sheet.html in the default browser before the first recording.")
    parser.add_argument("--countdown-sec", type=int, default=0, help="Countdown after Enter before starting each recording.")
    parser.add_argument("--rehearse", action="store_true", help="Print a no-microphone cue sheet with exact prompts and coverage.")
    parser.add_argument("--preflight", action="store_true", help="Validate recorder/backend, missing files, and writable paths without recording.")
    parser.add_argument("--microphone-smoke-sec", type=float, default=0.0, help="Record a temporary throwaway clip for this many seconds to prove microphone capture and levels before preflight or recording.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned clips and commands without recording.")
    parser.add_argument("--brief", action="store_true", help="Print compact human-readable output for --rehearse, --preflight, or --dry-run instead of JSON.")
    parser.add_argument("--check", action="store_true", help="Run check_voice_profile_recording_kit.py after recording.")
    parser.add_argument("--check-selected", action="store_true", help="After recording, validate selected clips only; missing other kit clips do not fail this mode.")
    parser.add_argument("--run-proof-after-check", action="store_true", help="After a passing kit check, run the no-microphone enrollment/transcript/quality proof chain.")
    parser.add_argument("--proof-command", help="Override the after-check proof command template. Supports {manifest}, {kit_manifest}, {profile_id}, {profile_json}, {record_countdown_sec}.")
    parser.add_argument("--run-product-proof-after-check", action="store_true", help="After the normal proof chain passes, run the stricter paired 10x/product proof gate.")
    parser.add_argument("--product-proof-command", help="Override the 10x/product proof command template. Supports {manifest}, {kit_manifest}, {profile_id}, {profile_json}, {record_countdown_sec}.")
    parser.add_argument("--prepare-lora-after-product-proof", action="store_true", help="After the stricter product proof passes, export the consented LoRA dataset handoff.")
    parser.add_argument("--lora-dataset-command", help="Override the LoRA dataset export command template. Supports {manifest}, {kit_manifest}, {profile_id}, {profile_json}, {record_countdown_sec}.")
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--write-metadata", action="store_true", help="Write <audio>.recording.json sidecars with recording metadata.")
    args = parser.parse_args()

    if args.record_missing_until_complete and args.next_missing:
        raise SystemExit("--record-missing-until-complete cannot be combined with --next-missing")
    if args.brief and not (args.rehearse or args.preflight or args.dry_run):
        raise SystemExit("--brief can only be used with --rehearse, --preflight, or --dry-run")
    if args.microphone_smoke_sec < 0:
        raise SystemExit("--microphone-smoke-sec must be zero or positive")
    if args.duration_sec <= 0:
        raise SystemExit("--duration-sec must be positive")
    if (
        not args.auto_duration
        and not args.allow_out_of_range_duration
        and not (MIN_PROFILE_DURATION_SEC <= args.duration_sec <= MAX_PROFILE_DURATION_SEC)
    ):
        raise SystemExit(
            f"--duration-sec must be between {MIN_PROFILE_DURATION_SEC:g} and {MAX_PROFILE_DURATION_SEC:g} "
            "for profile enrollment; pass --allow-out-of-range-duration only for debugging"
        )
    if args.countdown_sec < 0:
        raise SystemExit("--countdown-sec must be zero or positive")
    if args.prepare_lora_after_product_proof:
        args.run_product_proof_after_check = True
    if args.run_product_proof_after_check:
        args.run_proof_after_check = True
    if args.run_proof_after_check:
        args.check = True

    manifest_path = Path(args.manifest).expanduser().resolve()
    selected_specs = select_clips(clip_specs(manifest_path), args.clip)
    if args.record_missing_until_complete:
        specs = select_missing_clips(selected_specs)
    elif args.next_missing:
        specs = select_next_missing_clip(selected_specs)
    else:
        specs = selected_specs
    recorder_template = args.recorder_command.strip() if isinstance(args.recorder_command, str) and args.recorder_command.strip() else ""
    recorder_source = "argument" if recorder_template else ""
    if not recorder_template:
        recorder_template, recorder_source = default_recorder_template(no_default=args.no_default_recorder)
    recorder_configured = bool(recorder_template)

    metadata = manifest_metadata(manifest_path)
    required_clips = metadata.get("requiredClips")
    plan_clips = build_plan_clips(
        specs,
        recorder_configured=recorder_configured,
        recorder_template=recorder_template,
        duration_sec=args.duration_sec,
        auto_duration=args.auto_duration,
        overwrite=args.overwrite,
    )
    duration_mode = "auto" if args.auto_duration else "fixed"

    base_payload: dict[str, Any] = {
        "manifest": str(manifest_path),
        **kit_paths(manifest_path),
        "manifestMetadata": {
            "promptSet": metadata.get("promptSet") if isinstance(metadata.get("promptSet"), str) else None,
            "requiredClips": required_clips if isinstance(required_clips, int) else None,
        },
        "durationSec": args.duration_sec,
        "durationMode": duration_mode,
        "countdownSec": args.countdown_sec,
        "recordingGuidance": recording_guidance(args.duration_sec, duration_mode=duration_mode),
        "selection": {
            "mode": (
                "record_missing_until_complete"
                if args.record_missing_until_complete
                else "next_missing"
                if args.next_missing
                else "clip"
                if args.clip
                else "all"
            ),
            "selectors": args.clip,
            "requestedClips": len(selected_specs),
            "selectedClips": len(specs),
            "selectedClipIds": [str(spec["id"]) for spec in specs],
        },
        "recorder": {
            "configured": recorder_configured,
            "source": recorder_source,
            "template": recorder_template or None,
        },
        "clips": plan_clips,
        "nextCommands": next_commands(manifest_path, args.profile_id, record_countdown_sec=args.countdown_sec or 2),
    }

    if args.rehearse:
        payload, exit_code = rehearsal_payload(base_payload)
        print_report(payload, brief=args.brief)
        if exit_code != 0:
            raise SystemExit(exit_code)
        return

    if args.preflight:
        payload, exit_code = preflight_payload(
            base_payload,
            recorder_configured=recorder_configured,
            recorder_template=recorder_template,
            microphone_smoke_sec=args.microphone_smoke_sec,
        )
        print_report(payload, brief=args.brief)
        if exit_code != 0:
            raise SystemExit(exit_code)
        return

    if args.dry_run:
        print_report({"status": "dry_run", **base_payload}, brief=args.brief)
        return

    prompt_blocked = [clip for clip in plan_clips if clip.get("promptErrors")]
    if prompt_blocked:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "message": "one or more prompt files do not match the recording manifest",
                    "summary": {
                        "clips": len(plan_clips),
                        "promptBlocked": len(prompt_blocked),
                    },
                    **base_payload,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)
    transcript_blocked = [clip for clip in plan_clips if clip.get("transcriptErrors")]
    if transcript_blocked:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "message": "one or more recording transcripts use Simplified or mixed Chinese; fix the manifest before recording",
                    "summary": {
                        "clips": len(plan_clips),
                        "transcriptBlocked": len(transcript_blocked),
                    },
                    **base_payload,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    needs_recorder = any(clip.get("action") == "record" for clip in plan_clips)
    if needs_recorder and not recorder_configured:
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "message": "no recorder command configured; install sox/rec or ffmpeg, set ANYVOICE_RECORDER_COMMAND, or pass --recorder-command",
                    **base_payload,
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)
    if needs_recorder and args.microphone_smoke_sec > 0:
        smoke_test = run_microphone_smoke_test(
            plan_clips,
            recorder_template=recorder_template,
            duration_sec=args.microphone_smoke_sec,
        )
        base_payload["microphoneSmokeTest"] = smoke_test
        if smoke_test["status"] != "passed":
            print(
                json.dumps(
                    {
                        "status": "microphone_smoke_failed",
                        "message": "microphone smoke test failed; fix recorder permissions, device, or input level before recording the full kit",
                        **base_payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
            )
            raise SystemExit(2)
    cue_sheet_review: dict[str, Any] | None = None
    if needs_recorder and args.open_cue_sheet:
        cue_sheet_review = open_cue_sheet(manifest_path)
        base_payload["cueSheetReview"] = cue_sheet_review
        if cue_sheet_review.get("status") != "opened":
            print(
                json.dumps(
                    {
                        "status": "cue_sheet_open_failed",
                        "message": "cue sheet could not be opened before recording",
                        **base_payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
            )
            raise SystemExit(2)

    results: list[dict[str, Any]] = []
    per_clip_checks: list[dict[str, Any]] = []
    last_check_report: dict[str, Any] | None = None
    last_check_error = ""
    if args.record_missing_until_complete:
        for spec in specs:
            result = record_clip(spec, args=args, recorder_template=recorder_template)
            results.append(result)
            if result.get("status") in {"recorder_failed", "output_missing"}:
                break
            check_report, check_error = run_kit_check(manifest_path, args.profile_id)
            last_check_report = check_report
            last_check_error = check_error
            selected_check = selected_clip_check_payload(check_report, [spec])
            per_clip_checks.append(
                {
                    "id": spec["id"],
                    "checkReportStatus": check_report.get("status") if isinstance(check_report, dict) else None,
                    "selectedCheck": selected_check,
                    **({"checkError": check_error} if check_error else {}),
                }
            )
            if not selected_check["ok"]:
                break
    else:
        results = [record_clip(spec, args=args, recorder_template=recorder_template) for spec in specs]
    counts = status_counts(results)
    payload: dict[str, Any] = {
        "status": "all_recordings_present" if not specs else "recorded",
        **base_payload,
        "summary": {
            "requestedClips": len(specs),
            "recorded": counts.get("recorded", 0),
            "skippedExisting": counts.get("skipped_existing", 0),
            "failed": counts.get("recorder_failed", 0) + counts.get("output_missing", 0),
        },
        "results": results,
    }
    if per_clip_checks:
        payload["perClipChecks"] = per_clip_checks
    selected_failure = next(
        (
            row
            for row in per_clip_checks
            if isinstance(row.get("selectedCheck"), dict) and row["selectedCheck"].get("ok") is False
        ),
        None,
    )
    if last_check_report is not None:
        payload["checkReport"] = last_check_report
    if last_check_error:
        payload["checkError"] = last_check_error
    if counts.get("recorder_failed", 0) > 0:
        payload["status"] = "record_failed"
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        raise SystemExit(3)
    if counts.get("output_missing", 0) > 0:
        payload["status"] = "output_missing"
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        raise SystemExit(4)
    if selected_failure:
        payload["status"] = "selected_check_failed"
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        raise SystemExit(5)
    if args.record_missing_until_complete:
        payload["status"] = "missing_recordings_ready" if specs else "all_recordings_present"

    if args.check or args.check_selected:
        check_report, check_error = run_kit_check(manifest_path, args.profile_id)
        payload["checkReport"] = check_report
        if check_error:
            payload["checkError"] = check_error
        selected_check = selected_clip_check_payload(check_report, specs)
        if args.check_selected:
            payload["selectedCheck"] = selected_check
            if not selected_check["ok"]:
                payload["status"] = "selected_check_failed"
                print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
                raise SystemExit(5)
            payload["status"] = "selected_recording_ready" if specs else "all_recordings_present"
        if args.check and (not check_report or check_report.get("status") != "ready_to_import"):
            payload["status"] = "check_failed"
            print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
            raise SystemExit(5)
        if args.check:
            payload["status"] = "ready_to_import"

    if args.run_proof_after_check:
        proof_command = after_recording_proof_command(
            manifest_path,
            args.profile_id,
            record_countdown_sec=args.countdown_sec,
            template=args.proof_command,
        )
        proof_run = run_after_recording_proof(proof_command)
        payload["proofRun"] = proof_run
        if proof_run["exitCode"] != 0:
            payload["status"] = "proof_failed"
            print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
            raise SystemExit(6)
        payload["status"] = "proof_ready"
        if args.run_product_proof_after_check:
            product_command, product_command_report = after_recording_product_proof_command(
                manifest_path,
                args.profile_id,
                record_countdown_sec=args.countdown_sec,
                template=args.product_proof_command,
            )
            if product_command_report:
                payload["productProofCommandReport"] = product_command_report
            if not product_command:
                payload["status"] = "product_proof_command_failed"
                print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
                raise SystemExit(7)
            product_proof_run = run_after_recording_proof(product_command)
            payload["productProofRun"] = product_proof_run
            if product_proof_run["exitCode"] != 0:
                payload["status"] = "product_proof_failed"
                print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
                raise SystemExit(7)
            payload["status"] = "product_proof_ready"
            if args.prepare_lora_after_product_proof:
                lora_command, lora_command_report = lora_dataset_command_after_product_proof(
                    manifest_path,
                    args.profile_id,
                    record_countdown_sec=args.countdown_sec,
                    template=args.lora_dataset_command,
                )
                if lora_command_report:
                    payload["loraDatasetCommandReport"] = lora_command_report
                if not lora_command:
                    payload["status"] = "lora_handoff_command_failed"
                    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
                    raise SystemExit(8)
                lora_dataset_run = run_after_recording_proof(lora_command)
                payload["loraDatasetRun"] = lora_dataset_run
                if lora_dataset_run["exitCode"] != 0:
                    payload["status"] = "lora_handoff_failed"
                    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
                    raise SystemExit(8)
                payload["status"] = "lora_handoff_ready"

    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

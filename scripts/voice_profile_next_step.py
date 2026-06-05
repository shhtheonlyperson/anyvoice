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

from build_voice_profile import REQUIRED_PRONUNCIATION_PRESET_IDS, pronunciation_preset_ids


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
DEFAULT_KIT_MANIFEST = REPO_ROOT / "generated" / "voice-profile-recording-kits" / "local-default-current" / "manifest.json"
DEFAULT_TRANSCRIPT_VALIDATION_ROOT = REPO_ROOT / "generated" / "voice-profile-transcript-validation"
DEFAULT_QUALITY_GATE_ROOT = REPO_ROOT / "generated" / "voice-regression"
PRODUCT_PROOF_SPEAKER_BACKEND = "speechbrain-ecapa"
PRODUCT_PROOF_ASR_BACKEND = "faster-whisper"
PRODUCT_CAPTURE_CLIPS = 7
PRODUCT_CAPTURE_DURATION_SEC = 60.0
PRODUCT_PROMPT_SET = "extended"
PRODUCT_PRONUNCIATION_PRESET_IDS = REQUIRED_PRONUNCIATION_PRESET_IDS
EXTERNAL_RECORDING_SOURCE_EXTENSIONS = [
    ".wav",
    ".m4a",
    ".mp3",
    ".webm",
    ".aac",
    ".caf",
    ".aiff",
    ".aif",
    ".flac",
    ".ogg",
    ".opus",
]
EXTERNAL_RECORDING_SOURCE_STEM_SUFFIXES = ["", ".source", ".export", "-source", "-export"]


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


def file_sha256(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


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


def profile_clip_pronunciation_preset_ids(clip: dict[str, Any]) -> set[str]:
    ids = set(pronunciation_preset_ids(str(clip.get("transcriptRaw") or "")))
    raw = clip.get("pronunciationPresetIds")
    if isinstance(raw, list):
        ids.update(str(item) for item in raw if isinstance(item, str) and item)
    return ids


def profile_product_capture_depth(profile_path: Path) -> dict[str, Any]:
    profile_payload = load_json_file(profile_path)
    if not profile_payload:
        return {
            "ok": False,
            "selectedClips": 0,
            "totalDurationSec": 0.0,
            "missingPronunciationPresetIds": PRODUCT_PRONUNCIATION_PRESET_IDS,
        }
    clips = profile_payload.get("clips") if isinstance(profile_payload.get("clips"), list) else []
    summary = profile_payload.get("summary") if isinstance(profile_payload.get("summary"), dict) else {}
    selected = summary.get("selectedClips")
    selected_clips = int(selected) if isinstance(selected, int) else len(clips)
    total_duration = round(profile_capture_duration(profile_payload), 3)
    covered_ids: set[str] = set()
    for clip in clips:
        if isinstance(clip, dict):
            covered_ids.update(profile_clip_pronunciation_preset_ids(clip))
    missing_ids = [preset_id for preset_id in PRODUCT_PRONUNCIATION_PRESET_IDS if preset_id not in covered_ids]
    return {
        "ok": selected_clips >= PRODUCT_CAPTURE_CLIPS
        and total_duration >= PRODUCT_CAPTURE_DURATION_SEC
        and not missing_ids,
        "selectedClips": selected_clips,
        "totalDurationSec": total_duration,
        "missingPronunciationPresetIds": missing_ids,
    }


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def profile_sha256_for_path(profile_path: Path) -> str | None:
    profile = load_json_file(profile_path)
    return canonical_profile_sha256(profile) if profile else None


def profile_clips(profile_payload: dict[str, Any]) -> list[dict[str, Any]]:
    clips = profile_payload.get("clips")
    return [clip for clip in clips if isinstance(clip, dict)] if isinstance(clips, list) else []


def selected_profile_clips(profile_payload: dict[str, Any]) -> list[dict[str, Any]]:
    requirements = profile_payload.get("requirements") if isinstance(profile_payload.get("requirements"), dict) else {}
    max_clips = requirements.get("maxClips")
    if not isinstance(max_clips, int) or max_clips <= 0:
        max_clips = 10
    return profile_clips(profile_payload)[:max_clips]


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def resolve_profile_audio_path(profile_path: Path, raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = profile_path.parent / path
    return path.resolve(strict=False)


def same_resolved_path(raw_path: Any, expected_path: Path, base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False) == expected_path.resolve(strict=False)


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value.lower())


def resolve_render_output_path(render: dict[str, Any], report_path: Path) -> Path | None:
    raw_path = render.get("outputWav")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    output_path = Path(raw_path).expanduser()
    if not output_path.is_absolute():
        output_path = report_path.parent / output_path
    return output_path.resolve(strict=False)


def source_report_render_output_evidence_matches(report: dict[str, Any], report_path: Path) -> bool:
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                return False
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                return False
            if not valid_sha256(render.get("outputSha256")):
                return False
            output_path = resolve_render_output_path(render, report_path)
            if output_path is None:
                return False
            actual_sha256 = file_sha256(output_path)
            try:
                actual_bytes = output_path.stat().st_size
            except OSError:
                return False
            if int(render["outputBytes"]) != actual_bytes:
                return False
            if render.get("outputSha256") != actual_sha256:
                return False
    return True


def transcript_validation_rows_match_profile(profile_path: Path, profile_payload: dict[str, Any], validation_path: Path, validation_payload: dict[str, Any]) -> bool:
    rows = transcript_validation_rows(validation_payload)
    by_source = {str(row.get("sourceRunId") or ""): row for row in rows if row.get("sourceRunId")}
    for clip in selected_profile_clips(profile_payload):
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        row = by_source.get(source_run_id)
        if not row or row.get("verdict") != "pass":
            return False
        if row.get("expectedTranscript") != str(clip.get("transcriptRaw") or "").strip():
            return False
        raw_audio_path = str(clip.get("audioPath") or "").strip()
        if not raw_audio_path:
            return False
        if not same_resolved_path(row.get("audioPath"), resolve_profile_audio_path(profile_path, raw_audio_path), validation_path.parent):
            return False
    return True


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
    expected_profile_sha256 = profile_sha256_for_path(normalized_profile)
    matches: list[tuple[int, str, Path]] = []
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
        if not same_resolved_path(raw_profile, normalized_profile, resolved.parent):
            return
        validation_profile_sha256 = payload.get("profileSha256")
        profile_rank = 1
        if isinstance(validation_profile_sha256, str) and validation_profile_sha256.strip():
            profile_rank = 0 if expected_profile_sha256 and validation_profile_sha256 == expected_profile_sha256 else 2
        created_at = str(payload.get("createdAt") or "")
        matches.append((profile_rank, created_at, resolved))

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
    matches.sort(key=lambda row: row[1], reverse=True)
    matches.sort(key=lambda row: row[0])
    return matches[0][2]


def latest_quality_gate_for_profile(profile_path: Path) -> dict[str, Any] | None:
    normalized_profile = profile_path.resolve()
    expected_profile_sha256 = profile_sha256_for_path(normalized_profile)
    if not expected_profile_sha256:
        return None
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
        if not same_resolved_path(raw_profile, normalized_profile, path.parent):
            continue
        if inputs.get("profileSha256") != expected_profile_sha256:
            continue
        if isinstance(inputs.get("loraPath"), str) and str(inputs.get("loraPath")).strip():
            continue
        if not quality_gate_full_eval_inputs(inputs):
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


def quality_gate_score_path(report: dict[str, Any] | None) -> Path | None:
    if not isinstance(report, dict):
        return None
    gate_json = report.get("json")
    if not isinstance(gate_json, str) or not gate_json.strip():
        return None
    paths = report.get("paths")
    if not isinstance(paths, dict):
        return None
    return resolve_quality_gate_path(paths.get("score"), gate_json)


def quality_gate_missing_profile_reference_preset_ids(report: dict[str, Any] | None) -> list[str]:
    score_path = quality_gate_score_path(report)
    if not score_path:
        return []
    score = load_json_file(score_path)
    if not score:
        return []
    summary = score.get("summary") if isinstance(score.get("summary"), dict) else {}
    profile_reference_reviews = summary.get("profileReferenceReviewGroups")
    if not isinstance(profile_reference_reviews, int) or profile_reference_reviews <= 0:
        return []
    groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    missing_ids: list[str] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("verdict") == "pass":
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


def profile_reference_repair_clips(kit_manifest: Path, preset_ids: list[str]) -> list[dict[str, Any]]:
    if not preset_ids:
        return []
    payload = load_json_file(kit_manifest)
    clips = payload.get("clips") if isinstance(payload, dict) and isinstance(payload.get("clips"), list) else []
    rows: list[dict[str, Any]] = []
    seen_clip_ids: set[str] = set()
    for preset_id in preset_ids:
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
        clip_id = str(matching_clip["id"]).strip()
        if clip_id in seen_clip_ids:
            continue
        seen_clip_ids.add(clip_id)
        rows.append(
            {
                "presetId": preset_id,
                "clipId": clip_id,
                "transcript": matching_clip.get("transcript"),
            }
        )
    return rows


def profile_reference_recording_command(
    *,
    kit_manifest: Path,
    profile_id: str,
    clip_ids: list[str],
    record_countdown_sec: int,
    non_interactive: bool = False,
) -> str:
    args = ["--manifest", str(kit_manifest)]
    for clip_id in clip_ids:
        args.extend(["--clip", clip_id])
    args.extend(
        [
            "--profile-id",
            profile_id,
            "--auto-duration",
            "--countdown-sec",
            str(record_countdown_sec),
            "--write-metadata",
            "--check-selected",
        ]
    )
    if non_interactive:
        args.append("--yes")
    else:
        args.extend(["--open-cue-sheet", "--microphone-smoke-sec", "2"])
    return user_py_script("record_voice_profile_recording_kit.py", args)


def quality_gate_full_eval_inputs(inputs: dict[str, Any]) -> bool:
    cases = inputs.get("case")
    tags = inputs.get("tag")
    if isinstance(cases, list) and cases:
        return False
    if isinstance(tags, list) and tags:
        return False
    if isinstance(cases, str) and cases.strip():
        return False
    if isinstance(tags, str) and tags.strip():
        return False
    return inputs.get("maxCases") is None


def resolve_quality_gate_path(raw_path: Any, gate_json: str | None) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    if not path.is_absolute() and gate_json:
        path = Path(gate_json).expanduser().resolve(strict=False).parent / path
    return path.resolve(strict=False)


def quality_gate_transcript_validation_paths(inputs: dict[str, Any], proofs: dict[str, Any], paths: dict[str, Any], gate_json: str | None) -> list[Path]:
    resolved: list[Path] = []
    for raw_path in (
        proofs.get("transcriptValidationJson"),
        inputs.get("transcriptValidationJson"),
        paths.get("profileTranscriptValidation"),
    ):
        path = resolve_quality_gate_path(raw_path, gate_json)
        if path is not None:
            resolved.append(path)
    return resolved


def quality_gate_transcript_validation_sha256s(inputs: dict[str, Any], proofs: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for raw_value in (
        proofs.get("transcriptValidationSha256"),
        inputs.get("transcriptValidationSha256"),
    ):
        if isinstance(raw_value, str) and raw_value.strip():
            values.append(raw_value.strip())
    return values


def quality_gate_transcript_validation_passed(report: dict[str, Any], inputs: dict[str, Any], proofs: dict[str, Any]) -> bool:
    profile_json = inputs.get("profileJson")
    if not isinstance(profile_json, str) or not profile_json.strip():
        return False
    gate_json = report.get("json") if isinstance(report.get("json"), str) else None
    gate_base = Path(gate_json).expanduser().resolve(strict=False).parent if gate_json else Path.cwd()
    profile_path = (Path(profile_json).expanduser() if Path(profile_json).expanduser().is_absolute() else gate_base / Path(profile_json).expanduser()).resolve(strict=False)
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    proof_paths = quality_gate_transcript_validation_paths(inputs, proofs, paths, gate_json)
    if not proof_paths:
        return False
    proof_path = proof_paths[0]
    if any(path != proof_path for path in proof_paths[1:]):
        return False
    proof_sha256s = quality_gate_transcript_validation_sha256s(inputs, proofs)
    if not proof_sha256s or any(value != proof_sha256s[0] for value in proof_sha256s[1:]):
        return False
    if file_sha256(proof_path) != proof_sha256s[0]:
        return False
    payload = load_json_file(proof_path)
    if not payload or payload.get("status") != "pass":
        return False
    raw_profile = payload.get("profile")
    if not same_resolved_path(raw_profile, profile_path, proof_path.parent):
        return False
    expected_profile_sha256 = profile_sha256_for_path(profile_path)
    validation_profile_sha256 = payload.get("profileSha256")
    if (
        expected_profile_sha256 is None
        or not isinstance(validation_profile_sha256, str)
        or not validation_profile_sha256.strip()
        or validation_profile_sha256 != expected_profile_sha256
    ):
        return False
    profile_payload = load_json_file(profile_path)
    expected_voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip() if profile_payload else ""
    if expected_voice_profile_id and payload.get("voiceProfileId") != expected_voice_profile_id:
        return False
    return bool(profile_payload and transcript_validation_rows_match_profile(profile_path, profile_payload, proof_path, payload))


def quality_gate_artifacts_passed(report: dict[str, Any], proofs: dict[str, Any]) -> bool:
    gate_json = report.get("json") if isinstance(report.get("json"), str) else None
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    resolved: dict[str, tuple[Path, str]] = {}

    for key in ("report", "asr", "speaker", "score"):
        path = resolve_quality_gate_path(paths.get(key), gate_json)
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else None
        if path is None or artifact is None:
            return False
        artifact_path = resolve_quality_gate_path(artifact.get("path"), gate_json)
        if artifact_path is None or artifact_path != path:
            return False
        proof_sha256 = artifact.get("sha256")
        if not isinstance(proof_sha256, str) or not proof_sha256.strip():
            return False
        actual_sha256 = file_sha256(path)
        if actual_sha256 != proof_sha256:
            return False
        resolved[key] = (path, actual_sha256)

    score_path, _score_sha256 = resolved["score"]
    score = load_json_file(score_path)
    if not score or score.get("verdict") != "pass":
        return False
    thresholds = score.get("thresholds") if isinstance(score.get("thresholds"), dict) else {}
    if thresholds.get("requireProfileReferenceSimilarity") is not True:
        return False
    score_groups = score.get("groups") if isinstance(score.get("groups"), list) else []
    if not score_groups:
        return False
    for group in score_groups:
        if not isinstance(group, dict):
            return False
        render_count = group.get("renderCount")
        if not isinstance(render_count, int) or render_count <= 0:
            return False
        if group.get("verdict") != "pass":
            return False
        if group.get("speakerIdentityVerdict") != "pass":
            return False
        identity = group.get("speakerIdentity") if isinstance(group.get("speakerIdentity"), dict) else {}
        if identity.get("verdict") != "pass":
            return False
        if identity.get("requireProfileReferenceSimilarity") is not True:
            return False
        if identity.get("profileReferenceEvaluatedRenders") != render_count:
            return False

    report_path, report_sha256 = resolved["report"]
    asr_path, asr_sha256 = resolved["asr"]
    speaker_path, speaker_sha256 = resolved["speaker"]
    inputs = report.get("inputs") if isinstance(report.get("inputs"), dict) else {}
    profile_path = resolve_quality_gate_path(inputs.get("profileJson"), gate_json)
    profile_payload = load_json_file(profile_path) if profile_path else None
    source_report = load_json_file(report_path)
    if not (
        same_resolved_path(score.get("sourceReport"), report_path, score_path.parent)
        and score.get("sourceReportSha256") == report_sha256
        and same_resolved_path(score.get("asrJson"), asr_path, score_path.parent)
        and score.get("asrJsonSha256") == asr_sha256
        and same_resolved_path(score.get("speakerJson"), speaker_path, score_path.parent)
        and score.get("speakerJsonSha256") == speaker_sha256
        and bool(profile_payload and source_report)
        and report_score_profile_evidence_matches(source_report, score, profile_payload)
        and source_report_render_output_evidence_matches(source_report, report_path)
    ):
        return False

    inputs = report.get("inputs") if isinstance(report.get("inputs"), dict) else {}
    lora_path = resolve_quality_gate_path(inputs.get("loraPath"), gate_json)
    return not lora_path or source_report_lora_render_evidence_matches(source_report, lora_path, report_path)


def product_paired_improvement_passed(report: dict[str, Any]) -> bool:
    gate_json = report.get("json") if isinstance(report.get("json"), str) else None
    paths = report.get("paths") if isinstance(report.get("paths"), dict) else {}
    score_path = resolve_quality_gate_path(paths.get("score"), gate_json)
    score = load_json_file(score_path) if score_path else None
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
    for key in ("avgCerReductionPct", "avgWerReductionPct"):
        value = summary.get(key)
        if not isinstance(value, (int, float)) or float(value) < float(min_reduction):
            return False
    latency = summary.get("avgLatencyRegressionPct")
    if not isinstance(latency, (int, float)) or float(latency) > 0:
        return False
    for row in pairs:
        if not isinstance(row, dict) or row.get("verdict") != "pass":
            return False
        if row.get("baselineCloneMode") != "prompt" or row.get("candidateCloneMode") != "hifi":
            return False
        for key in ("cerReductionPct", "werReductionPct"):
            value = row.get(key)
            if not isinstance(value, (int, float)) or float(value) < float(min_reduction):
                return False
        speaker_delta = row.get("speakerSimilarityDelta")
        if not isinstance(speaker_delta, (int, float)) or float(speaker_delta) < 0:
            return False
        row_latency = row.get("latencyRegressionPct")
        if row.get("latencyVerdict") != "pass" or not isinstance(row_latency, (int, float)) or float(row_latency) > 0:
            return False
    return True


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


def source_report_lora_render_evidence_matches(report: dict[str, Any], adapter_path: Path, report_path: Path) -> bool:
    matched_renders = 0
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict) or str(group.get("cloneMode") or "") != "hifi":
            continue
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            matched_renders += 1
            effective = render_effective_params(render)
            if effective is None:
                return False
            if effective.get("loraEnabled") is not True:
                return False
            if not same_resolved_path(effective.get("loraPath"), adapter_path, report_path.parent):
                return False
    return matched_renders > 0


def profile_evidence_matches(value: Any, *, voice_profile_id: str | None, profile_sha256: str | None, require: bool = True) -> bool:
    if not isinstance(value, dict):
        return False
    if voice_profile_id:
        actual_voice_profile_id = str(value.get("voiceProfileId") or "").strip()
        if actual_voice_profile_id:
            if actual_voice_profile_id != voice_profile_id:
                return False
        elif require:
            return False
    if profile_sha256:
        actual_profile_sha256 = str(value.get("profileSha256") or "").strip()
        if actual_profile_sha256:
            if actual_profile_sha256 != profile_sha256:
                return False
        elif require:
            return False
    return True


def group_profile_evidence_matches(groups: Any, *, voice_profile_id: str | None, profile_sha256: str | None) -> bool:
    if not isinstance(groups, list):
        return False
    matched_renders = 0
    for group in groups:
        if not isinstance(group, dict):
            return False
        if not profile_evidence_matches(group, voice_profile_id=voice_profile_id, profile_sha256=profile_sha256, require=False):
            return False
        renders = group.get("renders")
        if not isinstance(renders, list):
            return False
        for render in renders:
            if not isinstance(render, dict):
                return False
            matched_renders += 1
            if not profile_evidence_matches(render, voice_profile_id=voice_profile_id, profile_sha256=profile_sha256):
                return False
    return matched_renders > 0


def report_score_profile_evidence_matches(report: dict[str, Any], score: dict[str, Any], profile_payload: dict[str, Any]) -> bool:
    voice_profile_id = str(profile_payload.get("voiceProfileId") or "").strip() or None
    profile_sha256 = canonical_profile_sha256(profile_payload)
    return (
        profile_evidence_matches(
            score.get("voiceProfile"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
        and group_profile_evidence_matches(
            score.get("groups"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
        and profile_evidence_matches(
            report.get("voiceProfile"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
        and group_profile_evidence_matches(
            report.get("groups"),
            voice_profile_id=voice_profile_id,
            profile_sha256=profile_sha256,
        )
    )


def strict_profile_quality_gate_passed(report: dict[str, Any] | None) -> bool:
    if not report or report.get("status") != "pass" or report.get("dryRun") is not False:
        return False
    inputs = report.get("inputs")
    proofs = report.get("proofs")
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    return (
        quality_gate_full_eval_inputs(inputs)
        and
        inputs.get("skipProfileVerify") is not True
        and inputs.get("skipTranscriptValidation") is not True
        and proofs.get("profileVerifyRequired") is True
        and proofs.get("profileVerifyPassed") is True
        and proofs.get("profileVerifySkipped") is not True
        and proofs.get("transcriptValidationRequired") is True
        and proofs.get("transcriptValidationPassed") is True
        and proofs.get("transcriptValidationSkipped") is not True
        and quality_gate_transcript_validation_passed(report, inputs, proofs)
        and quality_gate_artifacts_passed(report, proofs)
    )


def product_quality_gate_passed(report: dict[str, Any] | None) -> bool:
    if not strict_profile_quality_gate_passed(report):
        return False
    inputs = report.get("inputs") if isinstance(report, dict) else None
    proofs = report.get("proofs") if isinstance(report, dict) else None
    if not isinstance(inputs, dict) or not isinstance(proofs, dict):
        return False
    if isinstance(inputs.get("loraPath"), str) and str(inputs.get("loraPath")).strip():
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


def latest_product_quality_gate_for_profile(profile_path: Path) -> dict[str, Any] | None:
    normalized_profile = profile_path.resolve()
    expected_profile_sha256 = profile_sha256_for_path(normalized_profile)
    if not expected_profile_sha256:
        return None
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
        if not same_resolved_path(raw_profile, normalized_profile, path.parent):
            continue
        if inputs.get("profileSha256") != expected_profile_sha256:
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


def pending_external_recording_sources(audio_check: dict[str, Any] | None, kit_manifest: Path) -> list[dict[str, Any]]:
    source_dir = kit_manifest.parent / "recordings"
    pending: list[dict[str, Any]] = []
    for row in check_detail_rows(audio_check):
        raw_errors = row.get("errors")
        errors = [str(error) for error in raw_errors] if isinstance(raw_errors, list) else []
        if "audio_file_missing" not in errors:
            continue
        raw_audio_path = row.get("audioPath")
        if not isinstance(raw_audio_path, str) or not raw_audio_path.strip():
            continue
        target_path = Path(raw_audio_path).expanduser().resolve(strict=False)
        clip_id = str(row.get("id") or "").strip()
        stems = [target_path.stem, clip_id]
        seen: set[Path] = set()
        source_path: Path | None = None
        for stem in stems:
            if not stem:
                continue
            for suffix in EXTERNAL_RECORDING_SOURCE_STEM_SUFFIXES:
                for extension in EXTERNAL_RECORDING_SOURCE_EXTENSIONS:
                    candidate = (source_dir / f"{stem}{suffix}{extension}").expanduser().resolve(strict=False)
                    if candidate in seen or candidate == target_path:
                        continue
                    seen.add(candidate)
                    if candidate.exists() and candidate.is_file() and candidate.stat().st_size > 0:
                        source_path = candidate
                        break
                if source_path is not None:
                    break
            if source_path is not None:
                break
        if source_path is None:
            continue
        pending.append(
            {
                "id": clip_id or target_path.stem,
                "index": row.get("index"),
                "audioPath": str(target_path),
                "sourceAudioPath": str(source_path),
            }
        )
    return pending


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
        "voxcpm2-hifi",
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
                "--check",
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
                "--check",
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
                "--check",
                "--prepare-lora-after-product-proof",
            ],
        ),
        "normalizeExternalRecordings": user_py_script(
            "normalize_voice_profile_recording_kit_audio.py",
            ["--manifest", str(kit_manifest), "--check", "--profile-id", profile_id],
        ),
        "normalizePresentExternalRecordings": user_py_script(
            "normalize_voice_profile_recording_kit_audio.py",
            ["--manifest", str(kit_manifest), "--only-present", "--profile-id", profile_id],
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


def recording_kit_action(
    *,
    kit_report: dict[str, Any] | None,
    profile_exists: bool,
    kit_exists: bool,
    cmds: dict[str, str],
    kit_manifest: Path,
    profile_id: str,
    record_countdown_sec: int,
) -> dict[str, Any] | None:
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
            missing_audio_rows = [
                row
                for row in check_detail_rows(audio_check)
                if "audio_file_missing" in string_list(row.get("errors"))
            ]
            pending_external = pending_external_recording_sources(audio_check, kit_manifest)
            if missing_audio_rows and len(pending_external) == len(missing_audio_rows):
                return {
                    "id": "normalize_external_recordings",
                    "phase": "recording_import",
                    "status": "needs_external_recording_normalization",
                    "command": cmds["normalizeExternalRecordings"],
                    "secondaryCommands": [
                        cmds["checkRecordingKit"],
                        cmds["enrollProfileKitAndValidate"],
                        cmds["recordMissingUntilComplete"],
                    ],
                    "pendingExternalRecordings": pending_external,
                    "reason": f"{len(pending_external)} external recording file(s) are present; normalize them into the fixed kit WAV paths before enrollment",
                }
            if pending_external:
                return {
                    "id": "normalize_partial_external_recordings",
                    "phase": "recording_import",
                    "status": "needs_partial_external_recording_normalization",
                    "command": cmds["normalizePresentExternalRecordings"],
                    "secondaryCommands": [
                        cmds["recordMissingUntilComplete"],
                        cmds["normalizeExternalRecordings"],
                        cmds["checkRecordingKit"],
                        cmds["enrollProfileKitAndValidate"],
                    ],
                    "pendingExternalRecordings": pending_external,
                    "missingRecordingClips": [
                        str(row.get("id") or "")
                        for row in missing_audio_rows
                        if str(row.get("id") or "").strip()
                    ],
                    "reason": f"{len(pending_external)} external recording file(s) are present, but {len(missing_audio_rows) - len(pending_external)} missing WAV source(s) still need recording",
                }
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
                    cmds["normalizeExternalRecordings"],
                    cmds["recordProfileKit"],
                    cmds["checkRecordingKit"],
                    cmds["enrollProfileKitAndValidate"],
                ],
                "pendingExternalRecordings": pending_external,
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

    return None


def next_action(
    *,
    profile_report: dict[str, Any] | None,
    kit_report: dict[str, Any] | None,
    quality_gate_report: dict[str, Any] | None,
    product_quality_gate_report: dict[str, Any] | None,
    profile_path: Path,
    profile_exists: bool,
    kit_exists: bool,
    cmds: dict[str, str],
    kit_manifest: Path,
    profile_id: str,
    record_countdown_sec: int,
) -> dict[str, Any]:
    product_depth = profile_product_capture_depth(profile_path) if profile_exists else {
        "ok": False,
        "selectedClips": 0,
        "totalDurationSec": 0.0,
        "missingPronunciationPresetIds": PRODUCT_PRONUNCIATION_PRESET_IDS,
    }
    if kit_exists and kit_report and not product_depth.get("ok"):
        action = recording_kit_action(
            kit_report=kit_report,
            profile_exists=profile_exists,
            kit_exists=kit_exists,
            cmds=cmds,
            kit_manifest=kit_manifest,
            profile_id=profile_id,
            record_countdown_sec=record_countdown_sec,
        )
        if action and (action.get("id") != "enroll_profile_kit" or not profile_exists):
            action["productCaptureDepth"] = product_depth
            return action

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
        missing_reference_presets = quality_gate_missing_profile_reference_preset_ids(quality_gate_report)
        repair_clips = profile_reference_repair_clips(kit_manifest, missing_reference_presets)
        if repair_clips:
            clip_ids = [str(row["clipId"]) for row in repair_clips if isinstance(row.get("clipId"), str)]
            return {
                "id": "record_quality_gate_profile_reference",
                "phase": "quality_gate_repair",
                "status": "needs_profile_reference_recording",
                "command": profile_reference_recording_command(
                    kit_manifest=kit_manifest,
                    profile_id=profile_id,
                    clip_ids=clip_ids,
                    record_countdown_sec=record_countdown_sec,
                ),
                "nonInteractiveCommand": profile_reference_recording_command(
                    kit_manifest=kit_manifest,
                    profile_id=profile_id,
                    clip_ids=clip_ids,
                    record_countdown_sec=record_countdown_sec,
                    non_interactive=True,
                ),
                "secondaryCommands": [
                    cmds["proveRecordedKit"],
                    cmds["qualityGate"],
                ],
                "profileReferenceRepair": {
                    "presetIds": missing_reference_presets,
                    "clipIds": clip_ids,
                    "clips": repair_clips,
                    "sourceQualityGateJson": quality_gate_report.get("json") if isinstance(quality_gate_report, dict) else None,
                    "sourceScoreJson": str(quality_gate_score_path(quality_gate_report))
                    if quality_gate_score_path(quality_gate_report)
                    else None,
                },
                "reason": "latest hifi quality gate is blocked by missing profile-reference coverage; record the focused reference clips before rerunning the proof chain",
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

    action = recording_kit_action(
        kit_report=kit_report,
        profile_exists=profile_exists,
        kit_exists=kit_exists,
        cmds=cmds,
        kit_manifest=kit_manifest,
        profile_id=profile_id,
        record_countdown_sec=record_countdown_sec,
    )
    if action:
        if not product_depth.get("ok"):
            action["productCaptureDepth"] = product_depth
        return action

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
    recording_action_ids = {
        "record_profile_kit",
        "fix_recording_kit",
        "fix_transcript_validation_clip",
        "record_quality_gate_profile_reference",
    }
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
        profile_path=profile_path,
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
    if brief and action.get("id") != "record_quality_gate_profile_reference":
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


def brief_number(value: Any, fallback: int | float) -> str:
    raw = value if isinstance(value, (int, float)) else fallback
    if isinstance(raw, int):
        return str(raw)
    return f"{float(raw):.3f}".rstrip("0").rstrip(".")


def product_capture_depth_brief_lines(payload: dict[str, Any]) -> list[str]:
    action = payload.get("nextAction") if isinstance(payload.get("nextAction"), dict) else {}
    capture_depth = action.get("productCaptureDepth") if isinstance(action, dict) else None
    if not isinstance(capture_depth, dict):
        return []
    selected = capture_depth.get("selectedClips")
    duration = capture_depth.get("totalDurationSec")
    missing_presets = string_list(capture_depth.get("missingPronunciationPresetIds"))
    lines = [
        "Capture depth: "
        f"{brief_number(selected, 0)}/{brief_number(PRODUCT_CAPTURE_CLIPS, PRODUCT_CAPTURE_CLIPS)} clips",
        "Capture duration: "
        f"{brief_number(duration, 0)}/{brief_number(PRODUCT_CAPTURE_DURATION_SEC, PRODUCT_CAPTURE_DURATION_SEC)}s",
    ]
    if missing_presets:
        lines.append(f"Missing pronunciation coverage: {', '.join(missing_presets)}")
    return lines


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
    capture_depth_lines = product_capture_depth_brief_lines(payload)
    if capture_depth_lines:
        lines.extend(["", *capture_depth_lines])
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

    if commands_payload and action.get("id") != "record_quality_gate_profile_reference":
        command_rows = [
            ("Open/check mic", "microphoneSmokeTestRecordingKit"),
            ("Preflight", "preflightRecordingKit"),
            ("Record missing clips", "recordMissingUntilComplete"),
            ("Normalize phone files", "normalizeExternalRecordings"),
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
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON. This is the default unless --brief is used.")
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
    if args.brief and args.json:
        parser.error("--brief and --json cannot be used together")
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

"""Profile enrollment: run-dir artifacts, analyzer grading, profile manifest.

Writes the exact artifact layout lib/profile-enrollment.ts produces — including
the `voiceProfileId` tag in request.json that the web app uses to attribute
clips to a profile — so voices enrolled from ComfyUI appear in the AnyVoice web
app and vice versa. Run dirs are the source of truth; profile.json is a derived
cache the web app recomputes on its own.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import env
from .textgate import detect_chinese_script

PASSING_GRADES = ("A", "B")
GRADE_RANK = {"A": 0, "B": 1, "C": 2, "D": 3}

# Mirrors IMPORTED_PROFILE_REQUIREMENTS in lib/voice-profile.ts — the lenient
# tier every non-default (imported) profile is held to.
IMPORTED_PROFILE_REQUIREMENTS = {
    "minClips": 1,
    "maxClips": 10,
    "minDurationSec": 6,
    "maxDurationSec": 20,
    "passingGrades": sorted(PASSING_GRADES),
    "requiredCoverageFeatures": [],
    "requiredPronunciationPresetIds": [],
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def voice_profile_hash_from_id(profile_id: str) -> int:
    """FNV-1a folded to 16 bits — port of voiceProfileHashFromId (VoiceMark seed)."""
    h = 0x811C9DC5
    for ch in profile_id:
        h ^= ord(ch) & 0xFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    return ((h >> 16) ^ h) & 0xFFFF or 0x4A7D


@dataclass
class EnrolledClip:
    run_id: str
    run_dir: Path
    transcript: str
    reference_quality: dict
    source_kind: str = "uploaded"

    @property
    def grade(self) -> str:
        return str(self.reference_quality.get("grade") or "D")

    @property
    def duration_sec(self) -> float:
        try:
            return float(self.reference_quality.get("durationSec") or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def audio_path(self) -> Path:
        """Analyzer-normalized 16k mono wav when present (the synthesis-preferred
        reference, mirroring lib/voice-profile.ts referenceAudioPath)."""
        normalized = self.run_dir / "reference_16k_mono.wav"
        if normalized.exists():
            return normalized
        return self.run_dir / "reference.wav"


class EnrollmentError(RuntimeError):
    pass


def write_enrollment_run(
    run_dir: Path,
    clip_wav: Path,
    transcript: str,
    profile_id: str,
    model_id: str,
    source_kind: str = "uploaded",
) -> None:
    """Write the enrollment artifact set lib/profile-enrollment.ts writes."""
    run_dir.mkdir(parents=True, exist_ok=False)
    reference_path = run_dir / "reference.wav"
    shutil.copy2(clip_wav, reference_path)
    (run_dir / "prompt-transcript.txt").write_text(transcript, encoding="utf-8")
    (run_dir / "prompt-transcript.raw.txt").write_text(transcript, encoding="utf-8")
    text_prep = {"version": 1, "promptTranscript": {"raw": transcript, "model": transcript, "warnings": []}}
    (run_dir / "text-prep.json").write_text(
        json.dumps(text_prep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    request = {
        "status": "profile_enrollment",
        "modelId": model_id,
        "voiceName": clip_wav.name,
        "voiceType": "audio/wav",
        "voiceSize": reference_path.stat().st_size,
        "sourceKind": source_kind,
        "referenceSource": {"kind": source_kind},
        "voiceProfileId": profile_id,
        "createdAt": utc_now_iso(),
        "textPreparation": {"promptTranscript": text_prep["promptTranscript"]},
    }
    (run_dir / "request.json").write_text(
        json.dumps(request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def run_analyzer(run_dir: Path, model_id: str, source_kind: str = "uploaded", timeout_sec: float = 120.0) -> dict:
    """scripts/analyze_voice_reference.py: normalize to 16k mono + grade A–D."""
    python = env.voxcpm_python()
    script = env.repo_root() / "scripts" / "analyze_voice_reference.py"
    metadata_path = run_dir / "metadata.json"
    args = [
        python, str(script),
        "--reference-audio", str(run_dir / "reference.wav"),
        "--prompt-text-file", str(run_dir / "prompt-transcript.txt"),
        "--metadata-output", str(metadata_path),
        "--model-id", model_id,
        "--source-kind", source_kind,
    ]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout_sec, cwd=env.repo_root()
        )
    except FileNotFoundError:
        raise EnrollmentError(
            f"analyzer python not found: {python} — set ANYVOICE_VOXCPM_PYTHON"
        )
    except subprocess.TimeoutExpired:
        raise EnrollmentError("voice reference analyzer timed out")
    if proc.stderr.strip():
        (run_dir / "analyzer.log").write_text(proc.stderr, encoding="utf-8")
    if proc.returncode != 0 or not metadata_path.exists():
        detail = (proc.stderr.strip() or proc.stdout.strip())[:300]
        raise EnrollmentError(f"voice reference analyzer failed: {detail}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    quality = metadata.get("referenceQuality")
    if not isinstance(quality, dict):
        raise EnrollmentError("analyzer produced no referenceQuality")
    return quality


def ensure_profile_meta(profile_id: str, display_name: str) -> Path:
    """Create <voices>/<id>/meta.json if missing. No userId → the web app treats
    it as a legacy/shared profile and lists it for the local user."""
    profile_dir = env.voices_root() / profile_id
    profile_dir.mkdir(parents=True, exist_ok=True)
    meta_path = profile_dir / "meta.json"
    if not meta_path.exists():
        meta = {
            "id": profile_id,
            "displayName": display_name,
            "createdAt": utc_now_iso(),
            "hash": voice_profile_hash_from_id(profile_id),
        }
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return profile_dir


def clip_rejection_reasons(clip: EnrolledClip) -> list[str]:
    """Imported-tier eligibility, mirroring lib/voice-profile.ts rejectionReasons:
    grade A/B, 6–20s duration, no analyzer warnings, proven zh-Hant transcript."""
    reasons: list[str] = []
    if clip.grade not in PASSING_GRADES:
        reasons.append(f"grade_{clip.grade.lower()}")
    duration = clip.duration_sec
    if duration < IMPORTED_PROFILE_REQUIREMENTS["minDurationSec"]:
        reasons.append("too_short")
    elif duration > IMPORTED_PROFILE_REQUIREMENTS["maxDurationSec"]:
        reasons.append("too_long")
    warnings = clip.reference_quality.get("warnings") or []
    reasons.extend(str(w) for w in warnings)
    script = detect_chinese_script(clip.transcript)
    if script != "zh_hant":
        reasons.append(f"transcript_script_{script}")
    return reasons


def select_clips(clips: list[EnrolledClip], max_clips: int = 10) -> tuple[list[EnrolledClip], list[tuple[EnrolledClip, list[str]]]]:
    """Eligible clips ranked by grade then closeness to the ~12s sweet spot,
    deduped by transcript, capped at max_clips."""
    eligible: list[EnrolledClip] = []
    rejected: list[tuple[EnrolledClip, list[str]]] = []
    for clip in clips:
        reasons = clip_rejection_reasons(clip)
        if reasons:
            rejected.append((clip, reasons))
        else:
            eligible.append(clip)
    eligible.sort(key=lambda c: (GRADE_RANK.get(c.grade, 9), abs(c.duration_sec - 12.0)))
    seen_transcripts: set[str] = set()
    selected: list[EnrolledClip] = []
    for clip in eligible:
        key = "".join(clip.transcript.split())
        if key in seen_transcripts:
            rejected.append((clip, ["duplicate_transcript"]))
            continue
        seen_transcripts.add(key)
        selected.append(clip)
        if len(selected) >= max_clips:
            break
    return selected, rejected


def persist_profile_manifest(
    profile_id: str,
    selected: list[EnrolledClip],
    rejected: list[tuple[EnrolledClip, list[str]]],
    model_id: str,
) -> Path:
    """Write <voices>/<id>/profile.json + clips/NNN.wav copies.

    Honest derived cache in the lib/voice-profile.ts shape; the web app
    recomputes summaries from the tagged run dirs whenever it lists or
    generates, so this only needs to exist and be truthful.
    """
    profile_dir = env.voices_root() / profile_id
    clips_dir = profile_dir / "clips"
    if clips_dir.exists():
        shutil.rmtree(clips_dir)
    clips_dir.mkdir(parents=True)

    manifest_clips = []
    for index, clip in enumerate(selected, start=1):
        copied = clips_dir / f"{index:03d}.wav"
        shutil.copy2(clip.audio_path(), copied)
        manifest_clips.append(
            {
                "sourceRunId": clip.run_id,
                "voiceProfileId": profile_id,
                "audioPath": str(copied),
                "transcriptRaw": clip.transcript,
                "targetText": clip.transcript,
                "transcriptScript": detect_chinese_script(clip.transcript),
                "quality": clip.reference_quality,
                "coverageFeatures": [],
                "pronunciationPresetIds": [],
                "sourceKind": clip.source_kind,
                "modelId": model_id,
            }
        )

    usable = len(selected) >= 1
    meets_requirements = len(selected) >= IMPORTED_PROFILE_REQUIREMENTS["minClips"]
    manifest = {
        "version": 1,
        "voiceProfileId": profile_id,
        "status": "ready" if meets_requirements else "needs_enrollment",
        "usable": usable,
        "studioGrade": False,
        "createdAt": utc_now_iso(),
        "requirements": IMPORTED_PROFILE_REQUIREMENTS,
        "summary": {
            "eligibleClips": len(selected),
            "selectedClips": len(selected),
            "rejectedClips": len(rejected),
            "remainingClipsNeeded": max(0, IMPORTED_PROFILE_REQUIREMENTS["minClips"] - len(selected)),
        },
        "preferredPromptClipId": selected[0].run_id if selected else None,
        "referenceClipIds": [clip.run_id for clip in selected],
        "diagnostics": {"builder": "comfyui-anyvoice"},
        "clips": manifest_clips,
        "rejectedClips": [
            {
                "sourceRunId": clip.run_id,
                "voiceProfileId": profile_id,
                "transcriptRaw": clip.transcript,
                "quality": clip.reference_quality,
                "rejectionReasons": reasons,
            }
            for clip, reasons in rejected
        ],
    }
    manifest_path = profile_dir / "profile.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def enroll_clips(
    clip_specs: list[tuple[Path, str]],
    profile_id: str,
    display_name: str,
    model_id: str | None = None,
    max_clips: int = 10,
    on_progress: Callable[[int, int, str], None] | None = None,
    check_interrupted: Callable[[], None] | None = None,
) -> tuple[list[EnrolledClip], list[tuple[EnrolledClip, list[str]]], Path]:
    """Enroll (wav, transcript) clips into runs + profile. Returns
    (selected, rejected, manifest_path)."""
    resolved_model_id = model_id or env.model_id()
    ensure_profile_meta(profile_id, display_name)
    runs = env.runs_root()
    enrolled: list[EnrolledClip] = []
    total = len(clip_specs)
    for index, (clip_wav, transcript) in enumerate(clip_specs):
        if check_interrupted:
            check_interrupted()
        run_id = env.new_job_id()
        run_dir = runs / run_id
        write_enrollment_run(run_dir, clip_wav, transcript, profile_id, resolved_model_id)
        quality = run_analyzer(run_dir, resolved_model_id)
        enrolled.append(
            EnrolledClip(run_id=run_id, run_dir=run_dir, transcript=transcript, reference_quality=quality)
        )
        if on_progress:
            grade = quality.get("grade")
            on_progress(index + 1, total, f"clip {index + 1}/{total} graded {grade}")
    selected, rejected = select_clips(enrolled, max_clips=max_clips)
    manifest_path = persist_profile_manifest(profile_id, selected, rejected, resolved_model_id)
    return selected, rejected, manifest_path

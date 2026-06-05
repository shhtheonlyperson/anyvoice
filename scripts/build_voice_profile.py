from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNS_DIR = REPO_ROOT / ".anyvoice" / "runs"
DEFAULT_VOICES_DIR = REPO_ROOT / ".anyvoice" / "voices"
PASSING_GRADES = {"A", "B"}
CHINESE_SCRIPT_MARKER_PAIRS = [
    ("體", "体"),
    ("灣", "湾"),
    ("國", "国"),
    ("語", "语"),
    ("聲", "声"),
    ("錄", "录"),
    ("製", "制"),
    ("發", "发"),
    ("個", "个"),
    ("這", "这"),
    ("裡", "里"),
    ("麼", "么"),
    ("為", "为"),
    ("與", "与"),
    ("對", "对"),
    ("講", "讲"),
    ("說", "说"),
    ("話", "话"),
    ("請", "请"),
    ("測", "测"),
    ("試", "试"),
    ("變", "变"),
    ("讓", "让"),
    ("還", "还"),
    ("們", "们"),
    ("時", "时"),
    ("間", "间"),
    ("問", "问"),
    ("寫", "写"),
    ("應", "应"),
    ("實", "实"),
    ("驗", "验"),
    ("簡", "简"),
    ("樣", "样"),
    ("長", "长"),
    ("樂", "乐"),
    ("讀", "读"),
    ("錯", "错"),
    ("聽", "听"),
    ("覺", "觉"),
    ("後", "后"),
    ("會", "会"),
    ("標", "标"),
    ("準", "准"),
    ("穩", "稳"),
    ("銀", "银"),
    ("慶", "庆"),
    ("數", "数"),
    ("網", "网"),
    ("頁", "页"),
    ("電", "电"),
    ("腦", "脑"),
    ("開", "开"),
    ("關", "关"),
    ("雲", "云"),
    ("廣", "广"),
    ("環", "环"),
    ("麥", "麦"),
    ("遠", "远"),
    ("傳", "传"),
    ("鳥", "鸟"),
    ("顯", "显"),
    ("來", "来"),
    ("將", "将"),
    ("過", "过"),
    ("從", "从"),
    ("練", "练"),
    ("習", "习"),
    ("質", "质"),
    ("選", "选"),
    ("擇", "择"),
]
TRADITIONAL_MARKERS = {traditional for traditional, _ in CHINESE_SCRIPT_MARKER_PAIRS}
SIMPLIFIED_MARKERS = {simplified for _, simplified in CHINESE_SCRIPT_MARKER_PAIRS}
PRONUNCIATION_PRESETS = [
    ("polyphone:chongqing", ["重慶", "重庆"]),
    ("polyphone:bank", ["銀行", "银行"]),
    ("polyphone:role", ["角色"]),
    ("polyphone:music", ["音樂", "音乐"]),
    ("polyphone:changle", ["長樂", "长乐"]),
    ("polyphone:bank-president", ["行長", "行长"]),
    ("polyphone:grow-up", ["長大", "长大"]),
    ("polyphone:ganjing", ["乾淨"]),
    ("brand:anyvoice", ["AnyVoice"]),
    ("brand:voxcpm2", ["VoxCPM2"]),
]
POLYPHONE_TERMS = [term for preset_id, terms in PRONUNCIATION_PRESETS if preset_id.startswith("polyphone:") for term in terms]
REQUIRED_COVERAGE_FEATURES = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"]
REQUIRED_PRONUNCIATION_PRESET_IDS = [
    "polyphone:chongqing",
    "polyphone:bank",
    "polyphone:role",
    "polyphone:music",
    "polyphone:changle",
    "brand:anyvoice",
]
PRODUCT_PRONUNCIATION_PRESET_IDS = [
    *REQUIRED_PRONUNCIATION_PRESET_IDS,
    "polyphone:bank-president",
    "brand:voxcpm2",
]
EXTERNAL_PREFERRED_BACKENDS = {"indextts2", "f5-tts", "fishaudio-s2-pro"}


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def reference_audio_for_run(run_dir: Path) -> Path | None:
    preferred = run_dir / "reference_16k_mono.wav"
    if preferred.exists():
        return preferred
    for candidate in sorted(run_dir.glob("reference.*")):
        if candidate.name.startswith("reference_"):
            continue
        return candidate
    return None


def prompt_text_for_run(run_dir: Path) -> str:
    for name in ("prompt-transcript.raw.txt", "prompt-transcript.txt"):
        path = run_dir / name
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
    return ""


def target_text_for_run(run_dir: Path) -> str:
    for name in ("target.raw.txt", "target.txt"):
        path = run_dir / name
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
    return ""


def detect_chinese_script(text: str) -> str:
    traditional = sum(1 for ch in text if ch in TRADITIONAL_MARKERS)
    simplified = sum(1 for ch in text if ch in SIMPLIFIED_MARKERS)
    if traditional and simplified:
        return "mixed_zh"
    if traditional:
        return "zh_hant"
    if simplified:
        return "zh_hans"
    if any(0x4E00 <= ord(ch) <= 0x9FFF for ch in text):
        return "zh_unknown"
    return "non_zh"


def strict_traditional_script_errors(text: str) -> list[str]:
    script = detect_chinese_script(text)
    if script == "zh_hant":
        return []
    if script in {"zh_hans", "mixed_zh"}:
        return ["invalid_chinese_script"]
    if script == "zh_unknown":
        return ["unproven_chinese_script"]
    return ["missing_chinese_script"]


def transcript_coverage_features(text: str) -> list[str]:
    features: set[str] = set()
    script = detect_chinese_script(text)
    if script == "zh_hant":
        features.add("zh_hant")
    if any(ch.isascii() and ch.isalpha() for ch in text):
        features.add("latin_terms")
    if any(ch.isdigit() for ch in text):
        features.add("numbers_dates")
    if any(marker in text for marker in ("年", "月", "日", "號", "點", "分", "秒", "百分")):
        if any(ch in "零〇一二三四五六七八九十百千兩" for ch in text):
            features.add("numbers_dates")
    if any(term in text for term in POLYPHONE_TERMS):
        features.add("polyphones")
    punctuation_count = sum(1 for ch in text if ch in "，。、！？；：,.!?;:")
    if punctuation_count >= 2:
        features.add("punctuation_rhythm")
    return sorted(features)


def pronunciation_preset_ids(text: str) -> list[str]:
    return [
        preset_id
        for preset_id, terms in PRONUNCIATION_PRESETS
        if any(term in text for term in terms)
    ]


def is_profile_generated_run(run_dir: Path) -> bool:
    request = load_json(run_dir / "request.json")
    if not request:
        return False
    reference_source = request.get("referenceSource")
    return request.get("sourceKind") == "profile" or (
        isinstance(reference_source, dict) and reference_source.get("kind") == "profile"
    )


def is_sample_source_run(run_dir: Path) -> bool:
    request = load_json(run_dir / "request.json")
    if not request:
        return False
    reference_source = request.get("referenceSource")
    return request.get("sourceKind") == "sample" or (
        isinstance(reference_source, dict) and reference_source.get("kind") == "sample"
    )


def source_kind_for_run(run_dir: Path) -> str:
    request = load_json(run_dir / "request.json") or {}
    source_kind = request.get("sourceKind")
    if isinstance(source_kind, str) and source_kind.strip():
        return source_kind.strip()
    reference_source = request.get("referenceSource")
    if isinstance(reference_source, dict):
        reference_kind = reference_source.get("kind")
        if isinstance(reference_kind, str) and reference_kind.strip():
            return reference_kind.strip()
    return "uploaded"


def recording_kit_clip_id_for_run(run_dir: Path, metadata: dict[str, Any]) -> str | None:
    request = load_json(run_dir / "request.json") or {}
    for value in (
        request.get("recordingKitClipId"),
        request.get("manifestClipId"),
        metadata.get("recording_kit_clip_id"),
        metadata.get("manifest_clip_id"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def rejection_reasons(quality: dict[str, Any], min_duration: float, max_duration: float, transcript_script: str) -> list[str]:
    reasons: list[str] = []
    grade = str(quality.get("grade") or "D").upper()
    duration = float(quality.get("durationSec") or 0.0)
    if transcript_script != "zh_hant":
        if transcript_script in {"zh_hans", "mixed_zh"}:
            reasons.append("invalid_chinese_script")
        elif transcript_script == "zh_unknown":
            reasons.append("unproven_chinese_script")
        else:
            reasons.append("missing_chinese_script")
    if grade not in PASSING_GRADES:
        reasons.append(f"grade_{grade.lower()}")
    if duration < min_duration:
        reasons.append("too_short")
    if duration > max_duration:
        reasons.append("too_long")
    for warning in quality.get("warnings") or []:
        if isinstance(warning, str):
            reasons.append(warning)
    return sorted(set(reasons))


def transcript_diversity_key(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    chars = [char for char in normalized if char.isalnum()]
    return "".join(chars) or normalized.strip()


def eligible_sort_key(row: dict[str, Any]) -> tuple[int, float, str]:
    quality = row.get("quality") if isinstance(row.get("quality"), dict) else {}
    grade = str(quality.get("grade") or "D").upper()
    duration = float(quality.get("durationSec") or 0.0)
    return (0 if grade == "A" else 1, -duration, str(row.get("sourceRunId") or ""))


def enforce_transcript_diversity(
    candidates: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in candidates:
        key = transcript_diversity_key(str(row.get("transcriptRaw") or ""))
        groups.setdefault(key, []).append(row)

    eligible: list[dict[str, Any]] = []
    for group in groups.values():
        sorted_group = sorted(group, key=eligible_sort_key)
        eligible.append(sorted_group[0])
        for duplicate in sorted_group[1:]:
            rejected.append({**duplicate, "reasons": ["duplicate_transcript"]})
    return eligible


def clip_feature_set(clip: dict[str, Any]) -> set[str]:
    raw_features = clip.get("coverageFeatures")
    return {str(feature) for feature in raw_features if isinstance(feature, str)} if isinstance(raw_features, list) else set()


def clip_pronunciation_preset_set(clip: dict[str, Any]) -> set[str]:
    preset_ids = set(pronunciation_preset_ids(str(clip.get("transcriptRaw") or "")))
    raw_ids = clip.get("pronunciationPresetIds")
    if isinstance(raw_ids, list):
        preset_ids.update(str(preset_id) for preset_id in raw_ids if isinstance(preset_id, str))
    return preset_ids


def select_profile_clips(
    eligible: list[dict[str, Any]],
    required_coverage_features: list[str],
    required_pronunciation_preset_ids: list[str],
    max_clips: int,
) -> list[dict[str, Any]]:
    remaining = sorted(eligible, key=eligible_sort_key)
    selected: list[dict[str, Any]] = []
    missing = set(required_coverage_features)
    missing_presets = set(required_pronunciation_preset_ids)

    while (missing or missing_presets) and len(selected) < max_clips:
        candidates = [
            clip
            for clip in remaining
            if clip_feature_set(clip) & missing or clip_pronunciation_preset_set(clip) & missing_presets
        ]
        if not candidates:
            break
        best = sorted(
            candidates,
            key=lambda clip: (
                -len(clip_pronunciation_preset_set(clip) & missing_presets),
                -len(clip_feature_set(clip) & missing),
                *eligible_sort_key(clip),
            ),
        )[0]
        selected.append(best)
        remaining.remove(best)
        missing -= clip_feature_set(best)
        missing_presets -= clip_pronunciation_preset_set(best)

    for clip in remaining:
        if len(selected) >= max_clips:
            break
        selected.append(clip)

    return sorted(selected, key=eligible_sort_key)


def scan_runs(runs_dir: Path, min_duration: float, max_duration: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    for run_dir in sorted(runs_dir.iterdir() if runs_dir.exists() else []):
        if not run_dir.is_dir():
            continue
        if is_profile_generated_run(run_dir) or is_sample_source_run(run_dir):
            continue
        metadata = load_json(run_dir / "metadata.json")
        if not metadata:
            continue
        quality = metadata.get("referenceQuality")
        if not isinstance(quality, dict):
            continue
        audio = reference_audio_for_run(run_dir)
        transcript = prompt_text_for_run(run_dir)
        if not audio or not transcript:
            continue

        transcript_script = detect_chinese_script(transcript)
        row = {
            "sourceRunId": run_dir.name,
            "audioPath": str(audio),
            "transcriptRaw": transcript,
            "transcriptScript": transcript_script,
            "coverageFeatures": transcript_coverage_features(transcript),
            "pronunciationPresetIds": pronunciation_preset_ids(transcript),
            "recordingKitClipId": recording_kit_clip_id_for_run(run_dir, metadata),
            "targetText": target_text_for_run(run_dir),
            "quality": quality,
            "sourceKind": source_kind_for_run(run_dir),
            "modelId": metadata.get("model_id"),
            "cloneMode": metadata.get("clone_mode"),
            "createdFromOutput": str(run_dir / "output.wav") if (run_dir / "output.wav").exists() else None,
        }
        reasons = rejection_reasons(quality, min_duration, max_duration, transcript_script)
        if reasons:
            rejected.append({**row, "reasons": reasons})
        else:
            candidates.append(row)

    eligible = enforce_transcript_diversity(candidates, rejected)
    eligible.sort(key=eligible_sort_key)
    rejected.sort(key=lambda row: (row["quality"].get("durationSec") or 0), reverse=True)
    return eligible, rejected


def copy_eligible_clips(profile_dir: Path, clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clips_dir = profile_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    copied: list[dict[str, Any]] = []
    for index, clip in enumerate(clips, start=1):
        src = Path(clip["audioPath"])
        dst = clips_dir / f"{index:03d}{src.suffix or '.wav'}"
        shutil.copy2(src, dst)
        copied.append({**clip, "audioPath": str(dst)})
    return copied


def count_by(values: list[str]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return [
        {"value": value, "count": count}
        for value, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def diagnostics(
    eligible: list[dict[str, Any]],
    clips: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
    missing_coverage_features: list[str],
    missing_pronunciation_preset_ids: list[str],
) -> dict[str, Any]:
    def normalized_reason(reason: str) -> str:
        if reason == "short_clip":
            return "too_short"
        if reason == "long_clip":
            return "too_long"
        return reason

    reasons: list[str] = []
    for clip in rejected:
        reasons.extend(sorted({normalized_reason(str(reason)) for reason in clip.get("reasons", [])}))

    return {
        "eligibleTranscriptScripts": [
            {"script": item["value"], "count": item["count"]}
            for item in count_by([str(clip.get("transcriptScript") or "") for clip in eligible])
            if item["value"]
        ],
        "coverageFeatures": [
            {"feature": item["value"], "count": item["count"]}
            for item in count_by([
                str(feature)
                for clip in clips
                for feature in clip.get("coverageFeatures", [])
            ])
            if item["value"]
        ],
        "missingCoverageFeatures": missing_coverage_features,
        "pronunciationPresetIds": [
            {"presetId": item["value"], "count": item["count"]}
            for item in count_by([
                str(preset_id)
                for clip in clips
                for preset_id in clip_pronunciation_preset_set(clip)
            ])
            if item["value"]
        ],
        "missingPronunciationPresetIds": missing_pronunciation_preset_ids,
        "selectedGrades": [
            {"grade": item["value"], "count": item["count"]}
            for item in count_by([str((clip.get("quality") or {}).get("grade") or "") for clip in clips])
            if item["value"]
        ],
        "rejectionReasons": [
            {"reason": item["value"], "count": item["count"]}
            for item in count_by(reasons)
            if item["value"]
        ],
        "topRejectedClips": [
            {
                "sourceRunId": clip.get("sourceRunId"),
                "grade": (clip.get("quality") or {}).get("grade"),
                "durationSec": (clip.get("quality") or {}).get("durationSec"),
                "reasons": clip.get("reasons", []),
            }
            for clip in rejected[:5]
        ],
    }


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


def backend_subjective_review_summary_matches(summary: Any, expected: dict[str, Any], summary_base_dir: Path, expected_base_dir: Path) -> bool:
    if summary is None:
        return True
    if not isinstance(summary, dict):
        return False
    for key in ("reviewJson", "report"):
        expected_path = expected.get(key)
        if isinstance(expected_path, str) and expected_path.strip():
            if not same_policy_path_from_bases(summary.get(key), summary_base_dir, expected_path, expected_base_dir):
                return False
        elif summary.get(key) != expected_path:
            return False
    for key in ("status", "reasons", "stats", "reviewStats", "statMismatches", "missingChoices", "invalidChoices"):
        if summary.get(key) != expected.get(key):
            return False
    return True


def non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


def sha256_file(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def external_preferred_backend(value: Any) -> bool:
    return isinstance(value, str) and value.strip() in EXTERNAL_PREFERRED_BACKENDS


def resolve_policy_path(raw_path: str, base_dir: Path) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def policy_file_matches(raw_path: Any, expected_sha256: Any, base_dir: Path, expected_bytes: Any = None) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip() or not valid_sha256(expected_sha256):
        return False
    path = resolve_policy_path(raw_path, base_dir)
    try:
        if expected_bytes is not None:
            if not isinstance(expected_bytes, int) or expected_bytes <= 0:
                return False
            if path.stat().st_size != expected_bytes:
                return False
    except OSError:
        return False
    return sha256_file(path) == expected_sha256


def file_digest(raw_path: Any, base_dir: Path) -> dict[str, Any] | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = resolve_policy_path(raw_path, base_dir)
    try:
        size = path.stat().st_size
    except OSError:
        return None
    digest = sha256_file(path)
    if not digest:
        return None
    return {"path": path, "sha256": digest, "bytes": size}


def ready_render_outputs_match(groups: Any, evidence_dir: Path) -> bool:
    if not isinstance(groups, list):
        return False
    for group in groups:
        if not isinstance(group, dict):
            continue
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                return False
            if not isinstance(render.get("outputBytes"), int) or render["outputBytes"] <= 0:
                return False
            if not valid_sha256(render.get("outputSha256")):
                return False
            actual = file_digest(render.get("outputWav"), evidence_dir)
            if not actual:
                return False
            if actual["bytes"] != render.get("outputBytes"):
                return False
            if actual["sha256"] != render.get("outputSha256"):
                return False
    return True


def adapter_proof_matches_lora_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    raw_path = policy.get("adapterProofJson")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    payload = load_json(resolve_policy_path(raw_path, base_dir))
    if not payload or payload.get("status") != "pass":
        return False
    checkpoint = payload.get("checkpoint") if isinstance(payload.get("checkpoint"), dict) else {}
    if checkpoint.get("status") != "readable":
        return False
    lora_key_count = checkpoint.get("loraParameterKeyCount")
    if not isinstance(lora_key_count, int) or lora_key_count <= 0:
        return False
    return same_policy_path(payload.get("trainConfig"), policy.get("trainConfig"), base_dir) and (
        payload.get("trainConfigSha256") == policy.get("trainConfigSha256")
    )


def same_policy_path(raw_path: Any, expected_path: Any, base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    if not isinstance(expected_path, str) or not expected_path.strip():
        return False
    return resolve_policy_path(raw_path, base_dir) == resolve_policy_path(expected_path, base_dir)


def same_policy_path_from_bases(raw_path: Any, raw_base_dir: Path, expected_path: Any, expected_base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    if not isinstance(expected_path, str) or not expected_path.strip():
        return False
    return resolve_policy_path(raw_path, raw_base_dir) == resolve_policy_path(expected_path, expected_base_dir)


def same_evidence_path_as_policy(raw_path: Any, raw_base_dir: Path, expected_path: Any, expected_base_dir: Path) -> bool:
    return same_policy_path_from_bases(raw_path, raw_base_dir, expected_path, expected_base_dir) or same_policy_path_from_bases(
        raw_path, expected_base_dir, expected_path, expected_base_dir
    )


def quality_gate_proof_summary_matches_gate(
    policy: dict[str, Any],
    payload: dict[str, Any],
    policy_base_dir: Path,
    gate_base_dir: Path,
) -> bool:
    if "qualityGateProof" not in policy:
        return True
    summary = policy.get("qualityGateProof")
    if not isinstance(summary, dict):
        return False
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    proofs = payload.get("proofs") if isinstance(payload.get("proofs"), dict) else {}
    speaker = proofs.get("speakerBackendRequirement") if isinstance(proofs.get("speakerBackendRequirement"), dict) else {}
    expected_fields = {
        "status": payload.get("status"),
        "dryRun": payload.get("dryRun"),
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
        if not same_policy_path_from_bases(
            summary.get("transcriptValidationJson"),
            policy_base_dir,
            transcript_validation_json,
            gate_base_dir,
        ):
            return False
    elif summary.get("transcriptValidationJson") != transcript_validation_json:
        return False
    summary_artifacts = summary.get("artifacts") if isinstance(summary.get("artifacts"), dict) else {}
    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    for key in ["report", "asr", "speaker", "score"]:
        summary_artifact = summary_artifacts.get(key) if isinstance(summary_artifacts.get(key), dict) else {}
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else {}
        artifact_path = artifact.get("path")
        if isinstance(artifact_path, str) and artifact_path.strip():
            if not same_policy_path_from_bases(summary_artifact.get("path"), policy_base_dir, artifact_path, gate_base_dir):
                return False
        elif summary_artifact.get("path") != artifact_path:
            return False
        if summary_artifact.get("sha256") != artifact.get("sha256"):
            return False
    return True


def quality_gate_matches_lora_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    raw_path = policy.get("qualityGateJson")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    gate_path = resolve_policy_path(raw_path, base_dir)
    payload = load_json(gate_path)
    if not payload or payload.get("status") != "pass" or payload.get("dryRun") is not False:
        return False
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    proofs = payload.get("proofs") if isinstance(payload.get("proofs"), dict) else {}
    paths = payload.get("paths") if isinstance(payload.get("paths"), dict) else {}
    speaker = proofs.get("speakerBackendRequirement") if isinstance(proofs.get("speakerBackendRequirement"), dict) else {}
    adapter = proofs.get("loraAdapter") if isinstance(proofs.get("loraAdapter"), dict) else {}
    gate_dir = gate_path.parent
    if not quality_gate_proof_summary_matches_gate(policy, payload, base_dir, gate_dir):
        return False
    if not same_policy_path_from_bases(inputs.get("profileJson"), gate_dir, policy.get("profileJson"), base_dir):
        return False
    if inputs.get("profileSha256") != policy.get("profileSha256"):
        return False
    if inputs.get("cloneMode") != "hifi":
        return False
    if inputs.get("requireSpeakerBackend") != "speechbrain-ecapa":
        return False
    if inputs.get("skipProfileVerify") is True or inputs.get("skipTranscriptValidation") is True:
        return False
    if proofs.get("profileVerifyRequired") is not True or proofs.get("profileVerifyPassed") is not True:
        return False
    if proofs.get("profileVerifySkipped") is True:
        return False
    if proofs.get("transcriptValidationRequired") is not True or proofs.get("transcriptValidationPassed") is not True:
        return False
    if proofs.get("transcriptValidationSkipped") is True:
        return False
    if not same_policy_path_from_bases(inputs.get("loraPath"), gate_dir, policy.get("path"), base_dir):
        return False
    if speaker.get("selected") != "speechbrain-ecapa" or speaker.get("required") != "speechbrain-ecapa":
        return False
    if adapter.get("exists") is not True:
        return False
    if not same_policy_path_from_bases(adapter.get("path"), gate_dir, policy.get("path"), base_dir):
        return False
    if adapter.get("bytes") != policy.get("bytes"):
        return False
    if adapter.get("sha256") != policy.get("sha256"):
        return False

    transcript_path_raw = (
        proofs.get("transcriptValidationJson")
        or inputs.get("transcriptValidationJson")
        or paths.get("profileTranscriptValidation")
    )
    transcript_sha256 = proofs.get("transcriptValidationSha256") or inputs.get("transcriptValidationSha256")
    if not policy_file_matches(transcript_path_raw, transcript_sha256, gate_dir):
        return False
    transcript_path = resolve_policy_path(transcript_path_raw, gate_dir)
    transcript = load_json(transcript_path)
    if not transcript or transcript.get("status") != "pass":
        return False
    if not same_policy_path_from_bases(transcript.get("profile"), transcript_path.parent, policy.get("profileJson"), base_dir):
        return False
    if transcript.get("voiceProfileId") != policy.get("voiceProfileId"):
        return False
    if transcript.get("profileSha256") != policy.get("profileSha256"):
        return False

    artifacts = proofs.get("artifacts") if isinstance(proofs.get("artifacts"), dict) else {}
    resolved_artifacts: dict[str, dict[str, Any]] = {}
    for key in ["report", "asr", "speaker", "score"]:
        artifact = artifacts.get(key) if isinstance(artifacts.get(key), dict) else {}
        if not isinstance(paths.get(key), str) or not paths.get(key).strip():
            return False
        if not same_policy_path_from_bases(artifact.get("path"), gate_dir, paths.get(key), gate_dir):
            return False
        if not valid_sha256(artifact.get("sha256")):
            return False
        artifact_path = resolve_policy_path(paths.get(key), gate_dir)
        if sha256_file(artifact_path) != artifact.get("sha256"):
            return False
        resolved_artifacts[key] = {"path": artifact_path, "sha256": artifact.get("sha256")}

    score = load_json(resolved_artifacts["score"]["path"])
    report = load_json(resolved_artifacts["report"]["path"])
    if not score or not report or score.get("verdict") != "pass":
        return False
    score_dir = resolved_artifacts["score"]["path"].parent
    report_dir = resolved_artifacts["report"]["path"].parent
    if not same_policy_path_from_bases(score.get("sourceReport"), score_dir, str(resolved_artifacts["report"]["path"]), gate_dir):
        return False
    if score.get("sourceReportSha256") != resolved_artifacts["report"]["sha256"]:
        return False
    if not same_policy_path_from_bases(score.get("asrJson"), score_dir, str(resolved_artifacts["asr"]["path"]), gate_dir):
        return False
    if score.get("asrJsonSha256") != resolved_artifacts["asr"]["sha256"]:
        return False
    if not same_policy_path_from_bases(score.get("speakerJson"), score_dir, str(resolved_artifacts["speaker"]["path"]), gate_dir):
        return False
    if score.get("speakerJsonSha256") != resolved_artifacts["speaker"]["sha256"]:
        return False
    if not ready_render_outputs_match(score.get("groups"), score_dir):
        return False
    if not ready_render_outputs_match(report.get("groups"), report_dir):
        return False

    matched_lora_render = 0
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict) or group.get("cloneMode") != "hifi":
            continue
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            metadata = render.get("metadataJson") if isinstance(render.get("metadataJson"), dict) else {}
            hot_worker_metadata = render.get("hotWorkerMetadata") if isinstance(render.get("hotWorkerMetadata"), dict) else {}
            effective = (
                metadata.get("effectiveParams")
                if isinstance(metadata.get("effectiveParams"), dict)
                else hot_worker_metadata.get("effectiveParams")
                if isinstance(hot_worker_metadata.get("effectiveParams"), dict)
                else render.get("effectiveParams")
                if isinstance(render.get("effectiveParams"), dict)
                else {}
            )
            if effective.get("loraEnabled") is not True:
                return False
            if not same_policy_path_from_bases(effective.get("loraPath"), report_dir, policy.get("path"), base_dir):
                return False
            matched_lora_render += 1
    return matched_lora_render > 0


def preferred_backend_selection_matches_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    selection_path = resolve_policy_path(policy.get("selectionJson"), base_dir)
    payload = load_json(selection_path)
    if not payload or payload.get("verdict") != "accept" or payload.get("accepted") is not True:
        return False
    subjective = payload.get("subjectiveReview") if isinstance(payload.get("subjectiveReview"), dict) else {}
    stats = subjective.get("stats") if isinstance(subjective.get("stats"), dict) else {}
    reasons = subjective.get("reasons") if isinstance(subjective.get("reasons"), list) else []
    missing_choices = subjective.get("missingChoices") if isinstance(subjective.get("missingChoices"), list) else []
    invalid_choices = subjective.get("invalidChoices") if isinstance(subjective.get("invalidChoices"), list) else []
    rounds = stats.get("rounds")
    reviewed_rounds = stats.get("reviewedRounds")
    candidate_win_rate = stats.get("candidateWinRate")
    baseline_wins = stats.get("baselineWins")
    if subjective.get("status") != "pass":
        return False
    if reasons or missing_choices or invalid_choices:
        return False
    if not isinstance(rounds, (int, float)) or rounds <= 0:
        return False
    if reviewed_rounds != rounds:
        return False
    if stats.get("rerenders") != 0:
        return False
    if not isinstance(candidate_win_rate, (int, float)):
        return False
    candidate_wins = stats.get("candidateWins")
    if not isinstance(candidate_wins, (int, float)):
        return False
    if not isinstance(baseline_wins, (int, float)) or baseline_wins > candidate_wins:
        return False
    if "subjectiveReview" in policy and not backend_subjective_review_summary_matches(policy.get("subjectiveReview"), subjective, base_dir, selection_path.parent):
        return False
    if payload.get("candidateCloneMode") != policy.get("backend"):
        return False
    if payload.get("baselineCloneMode") != policy.get("baselineBackend"):
        return False
    selection_profile = payload.get("voiceProfile") if isinstance(payload.get("voiceProfile"), dict) else {}
    if selection_profile.get("voiceProfileId") != policy.get("voiceProfileId"):
        return False
    if selection_profile.get("profileSha256") != policy.get("profileSha256"):
        return False
    if not same_evidence_path_as_policy(payload.get("scoreJson"), selection_path.parent, policy.get("scoreJson"), base_dir):
        return False
    if payload.get("scoreSha256") != policy.get("scoreSha256"):
        return False
    if not same_evidence_path_as_policy(payload.get("reviewJson"), selection_path.parent, policy.get("reviewJson"), base_dir):
        return False
    if payload.get("reviewSha256") != policy.get("reviewSha256"):
        return False
    if not same_evidence_path_as_policy(payload.get("sourceReport"), selection_path.parent, policy.get("sourceReport"), base_dir):
        return False
    if payload.get("sourceReportSha256") != policy.get("sourceReportSha256"):
        return False
    return True


def preferred_backend_score_matches_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    score_path = resolve_policy_path(policy.get("scoreJson"), base_dir)
    payload = load_json(score_path)
    if not payload or payload.get("verdict") != "pass":
        return False
    score_dir = score_path.parent
    if not same_evidence_path_as_policy(payload.get("sourceReport"), score_dir, policy.get("sourceReport"), base_dir):
        return False
    if payload.get("sourceReportSha256") != policy.get("sourceReportSha256"):
        return False
    voice_profile = payload.get("voiceProfile") if isinstance(payload.get("voiceProfile"), dict) else {}
    if voice_profile.get("voiceProfileId") != policy.get("voiceProfileId"):
        return False
    if voice_profile.get("profileSha256") != policy.get("profileSha256"):
        return False
    groups = payload.get("groups") if isinstance(payload.get("groups"), list) else []
    matched_renders = 0
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("cloneMode") not in {policy.get("backend"), policy.get("baselineBackend")}:
            continue
        if group.get("voiceProfileId") != policy.get("voiceProfileId"):
            return False
        if group.get("profileSha256") != policy.get("profileSha256"):
            return False
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            if render.get("voiceProfileId") != policy.get("voiceProfileId"):
                return False
            if render.get("profileSha256") != policy.get("profileSha256"):
                return False
            if render.get("status") != "ready":
                continue
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                return False
            if not isinstance(render.get("outputBytes"), int) or render["outputBytes"] <= 0:
                return False
            if not valid_sha256(render.get("outputSha256")):
                return False
            output_wav = render.get("outputWav")
            if not isinstance(output_wav, str) or not output_wav.strip():
                return False
            output_path = resolve_policy_path(output_wav, score_dir)
            try:
                if output_path.stat().st_size != render["outputBytes"]:
                    return False
            except OSError:
                return False
            if sha256_file(output_path) != render.get("outputSha256"):
                return False
            matched_renders += 1
    return matched_renders > 0


def preferred_backend_review_matches_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    selection = load_json(resolve_policy_path(policy.get("selectionJson"), base_dir))
    review_path = resolve_policy_path(policy.get("reviewJson"), base_dir)
    payload = load_json(review_path)
    if not selection or not payload or payload.get("status") != "pass":
        return False
    subjective = selection.get("subjectiveReview") if isinstance(selection.get("subjectiveReview"), dict) else {}
    subjective_stats = subjective.get("stats") if isinstance(subjective.get("stats"), dict) else {}
    review_stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
    report_path = payload.get("reportPath") or payload.get("report")
    if not same_evidence_path_as_policy(report_path, review_path.parent, policy.get("sourceReport"), base_dir):
        return False
    if payload.get("reportSha256") != policy.get("sourceReportSha256"):
        return False
    if review_stats.get("reportSha256") != policy.get("sourceReportSha256"):
        return False
    stat_fields = [
        "rounds",
        "reviewedRounds",
        "candidateWins",
        "baselineWins",
        "ties",
        "rerenders",
        "candidateWinRate",
        "minCandidateWinRate",
    ]
    if any(review_stats.get(field) != subjective_stats.get(field) for field in stat_fields):
        return False
    choices = payload.get("choices") if isinstance(payload.get("choices"), dict) else {}
    return len(choices) > 0


def preferred_backend_source_report_matches_policy(policy: dict[str, Any], base_dir: Path) -> bool:
    payload = load_json(resolve_policy_path(policy.get("sourceReport"), base_dir))
    voice_profile = payload.get("voiceProfile") if isinstance(payload.get("voiceProfile"), dict) else {}
    if voice_profile.get("voiceProfileId") != policy.get("voiceProfileId"):
        return False
    if voice_profile.get("profileSha256") != policy.get("profileSha256"):
        return False
    groups = payload.get("groups") if isinstance(payload.get("groups"), list) else []
    report_dir = resolve_policy_path(policy.get("sourceReport"), base_dir).parent
    matched = 0
    for group in groups:
        if not isinstance(group, dict) or group.get("cloneMode") != policy.get("backend"):
            continue
        if group.get("voiceProfileId") != policy.get("voiceProfileId"):
            return False
        if group.get("profileSha256") != policy.get("profileSha256"):
            return False
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            if render.get("voiceProfileId") != policy.get("voiceProfileId"):
                return False
            if render.get("profileSha256") != policy.get("profileSha256"):
                return False
            if render.get("externalBackend") is not True:
                return False
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                return False
            if not isinstance(render.get("outputBytes"), int) or render["outputBytes"] <= 0:
                return False
            if not valid_sha256(render.get("outputSha256")):
                return False
            output_wav = render.get("outputWav")
            if not isinstance(output_wav, str) or not output_wav.strip():
                return False
            output_path = resolve_policy_path(output_wav, report_dir)
            try:
                if output_path.stat().st_size != render["outputBytes"]:
                    return False
            except OSError:
                return False
            if sha256_file(output_path) != render.get("outputSha256"):
                return False
            matched += 1
    return matched > 0


def matching_preferred_backend_policy(out_file: Path, profile: dict[str, Any]) -> dict[str, Any] | None:
    try:
        existing = json.loads(out_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(existing, dict):
        return None
    policy = existing.get("preferredBackend")
    if not isinstance(policy, dict) or policy.get("status") != "accepted":
        return None
    if policy.get("voiceProfileId") != profile.get("voiceProfileId"):
        return None
    raw_profile_json = policy.get("profileJson")
    if not isinstance(raw_profile_json, str) or resolve_policy_path(raw_profile_json, out_file.parent) != out_file.resolve():
        return None
    if policy.get("profileSha256") != canonical_profile_sha256(profile):
        return None
    required_strings = [
        "backend",
        "baselineBackend",
        "selectionJson",
        "scoreJson",
        "reviewJson",
        "sourceReport",
    ]
    if any(not non_empty_string(policy.get(field)) for field in required_strings):
        return None
    if not external_preferred_backend(policy.get("backend")):
        return None
    if policy.get("baselineBackend") != "voxcpm2-hifi":
        return None
    required_hashes = [
        "selectionSha256",
        "scoreSha256",
        "reviewSha256",
        "sourceReportSha256",
    ]
    if any(not valid_sha256(policy.get(field)) for field in required_hashes):
        return None
    if not policy_file_matches(policy.get("selectionJson"), policy.get("selectionSha256"), out_file.parent):
        return None
    if not policy_file_matches(policy.get("scoreJson"), policy.get("scoreSha256"), out_file.parent):
        return None
    if not policy_file_matches(policy.get("reviewJson"), policy.get("reviewSha256"), out_file.parent):
        return None
    if not policy_file_matches(policy.get("sourceReport"), policy.get("sourceReportSha256"), out_file.parent):
        return None
    if not preferred_backend_selection_matches_policy(policy, out_file.parent):
        return None
    if not preferred_backend_score_matches_policy(policy, out_file.parent):
        return None
    if not preferred_backend_review_matches_policy(policy, out_file.parent):
        return None
    if not preferred_backend_source_report_matches_policy(policy, out_file.parent):
        return None
    return policy


def matching_lora_adapter_policy(out_file: Path, profile: dict[str, Any]) -> dict[str, Any] | None:
    try:
        existing = json.loads(out_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(existing, dict):
        return None
    policy = existing.get("loraAdapter")
    if not isinstance(policy, dict) or policy.get("status") != "accepted":
        return None
    if policy.get("voiceProfileId") != profile.get("voiceProfileId"):
        return None
    raw_profile_json = policy.get("profileJson")
    if not isinstance(raw_profile_json, str) or resolve_policy_path(raw_profile_json, out_file.parent) != out_file.resolve():
        return None
    if policy.get("profileSha256") != canonical_profile_sha256(profile):
        return None
    required_strings = [
        "path",
        "adapterProofJson",
        "qualityGateJson",
        "trainConfig",
    ]
    if any(not non_empty_string(policy.get(field)) for field in required_strings):
        return None
    if not isinstance(policy.get("bytes"), int) or policy["bytes"] <= 0:
        return None
    required_hashes = [
        "sha256",
        "adapterProofSha256",
        "qualityGateSha256",
        "trainConfigSha256",
    ]
    if any(not valid_sha256(policy.get(field)) for field in required_hashes):
        return None
    if not policy_file_matches(policy.get("path"), policy.get("sha256"), out_file.parent, policy.get("bytes")):
        return None
    if not policy_file_matches(policy.get("adapterProofJson"), policy.get("adapterProofSha256"), out_file.parent):
        return None
    if not adapter_proof_matches_lora_policy(policy, out_file.parent):
        return None
    if not policy_file_matches(policy.get("qualityGateJson"), policy.get("qualityGateSha256"), out_file.parent):
        return None
    if not quality_gate_matches_lora_policy(policy, out_file.parent):
        return None
    if not policy_file_matches(policy.get("trainConfig"), policy.get("trainConfigSha256"), out_file.parent):
        return None
    return policy


def build_profile(args: argparse.Namespace) -> dict[str, Any]:
    eligible, rejected = scan_runs(Path(args.runs_dir), args.min_duration_sec, args.max_duration_sec)
    selected = select_profile_clips(eligible, REQUIRED_COVERAGE_FEATURES, REQUIRED_PRONUNCIATION_PRESET_IDS, args.max_clips)
    profile_dir = Path(args.out_dir)
    clips = copy_eligible_clips(profile_dir, selected) if args.copy_clips and selected else selected
    covered_features = {str(feature) for clip in clips for feature in clip.get("coverageFeatures", [])}
    missing_coverage_features = [
        feature for feature in REQUIRED_COVERAGE_FEATURES if feature not in covered_features
    ]
    covered_pronunciation_preset_ids = {preset_id for clip in clips for preset_id in clip_pronunciation_preset_set(clip)}
    missing_pronunciation_preset_ids = [
        preset_id for preset_id in REQUIRED_PRONUNCIATION_PRESET_IDS if preset_id not in covered_pronunciation_preset_ids
    ]
    status = (
        "ready"
        if len(clips) >= args.min_clips and not missing_coverage_features and not missing_pronunciation_preset_ids
        else "needs_enrollment"
    )

    return {
      "version": 1,
      "voiceProfileId": args.profile_id,
      "status": status,
      "createdAt": datetime.now(timezone.utc).isoformat(),
      "requirements": {
        "minClips": args.min_clips,
        "maxClips": args.max_clips,
        "minDurationSec": args.min_duration_sec,
        "maxDurationSec": args.max_duration_sec,
        "passingGrades": sorted(PASSING_GRADES),
        "requiredCoverageFeatures": REQUIRED_COVERAGE_FEATURES,
        "requiredPronunciationPresetIds": REQUIRED_PRONUNCIATION_PRESET_IDS,
      },
      "summary": {
        "eligibleClips": len(eligible),
        "selectedClips": len(clips),
        "rejectedClips": len(rejected),
        "remainingClipsNeeded": 0 if status == "ready" else max(0, args.min_clips - len(clips), 1 if missing_coverage_features or missing_pronunciation_preset_ids else 0),
      },
      "preferredPromptClipId": clips[0]["sourceRunId"] if clips else None,
      "referenceClipIds": [clip["sourceRunId"] for clip in clips],
      "diagnostics": diagnostics(eligible, clips, rejected, missing_coverage_features, missing_pronunciation_preset_ids),
      "loraPath": None,
      "clips": clips,
      "rejectedClips": rejected[: args.max_rejections],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build an AnyVoice digital voice profile manifest from local runs.")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    parser.add_argument("--profile-id", default="local-default")
    parser.add_argument("--out-dir", default=str(DEFAULT_VOICES_DIR / "local-default"))
    parser.add_argument("--min-clips", type=int, default=5)
    parser.add_argument("--max-clips", type=int, default=10)
    parser.add_argument("--max-rejections", type=int, default=50)
    parser.add_argument("--min-duration-sec", type=float, default=6.0)
    parser.add_argument("--max-duration-sec", type=float, default=20.0)
    parser.add_argument("--copy-clips", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    profile = build_profile(args)
    out_dir = Path(args.out_dir)
    out_file = out_dir / "profile.json"
    if profile.get("status") == "ready":
        preferred_backend = matching_preferred_backend_policy(out_file, profile)
        if preferred_backend:
            profile["preferredBackend"] = preferred_backend
        lora_adapter = matching_lora_adapter_policy(out_file, profile)
        if lora_adapter:
            profile["loraPath"] = lora_adapter["path"]
            profile["loraAdapter"] = lora_adapter

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "profile": str(out_file),
                "status": profile["status"],
                "eligibleClips": profile["summary"]["eligibleClips"],
                "selectedClips": profile["summary"]["selectedClips"],
                "remainingClipsNeeded": profile["summary"]["remainingClipsNeeded"],
                "dryRun": args.dry_run,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

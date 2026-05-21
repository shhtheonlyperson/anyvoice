from __future__ import annotations

import argparse
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
    raw_ids = clip.get("pronunciationPresetIds")
    if isinstance(raw_ids, list):
        return {str(preset_id) for preset_id in raw_ids if isinstance(preset_id, str)}
    return set(pronunciation_preset_ids(str(clip.get("transcriptRaw") or "")))


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

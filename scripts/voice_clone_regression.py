from __future__ import annotations

import argparse
import array
import hashlib
import html
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from verify_voice_profile_ready import readiness_report as verify_profile_readiness_report


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EVAL_SET = REPO_ROOT / "examples" / "voice_clone_eval_set.json"
DEFAULT_PROFILE_JSON = REPO_ROOT / ".anyvoice" / "voices" / "local-default" / "profile.json"
SYNTH_SCRIPT = REPO_ROOT / "scripts" / "synthesize_voxcpm_anyvoice.py"
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
REQUIRED_COVERAGE_FEATURES = [
    "zh_hant",
    "numbers_dates",
    "latin_terms",
    "polyphones",
    "punctuation_rhythm",
]
POLYPHONE_GROUPS = [
    {"terms": ["重慶", "重庆"], "replacement": "重 慶", "presetId": "polyphone:chongqing"},
    {"terms": ["銀行", "银行"], "replacement": "銀 行", "presetId": "polyphone:bank"},
    {"terms": ["角色"], "replacement": "角 色", "presetId": "polyphone:role"},
    {"terms": ["音樂", "音乐"], "replacement": "音 樂", "presetId": "polyphone:music"},
    {"terms": ["長樂", "长乐"], "replacement": "長 樂", "presetId": "polyphone:changle"},
    {"terms": ["行長", "行长"], "replacement": "行 長", "presetId": "polyphone:bank-president"},
    {"terms": ["長大", "长大"], "replacement": "長 大", "presetId": "polyphone:grow-up"},
    {"terms": ["乾淨"], "replacement": "甘淨", "presetId": "polyphone:ganjing"},
]
POLYPHONE_TERMS = [term for group in POLYPHONE_GROUPS for term in group["terms"]]
PRONUNCIATION_DELIMITERS = ["=>", "->", "＝", "=", "：", ":"]
PRONUNCIATION_READING_KINDS = {"pinyin", "zhuyin", "reading"}
PRONUNCIATION_KINDS = {"polyphone", "brand", "pinyin", "zhuyin", "reading", "custom"}
MAX_PRONUNCIATION_OVERRIDES = 20
MAX_PRONUNCIATION_TERM_CHARS = 32
MAX_PRONUNCIATION_REPLACEMENT_CHARS = 80
PRONUNCIATION_SUGGESTIONS = [
    *[
        {
            "term": term,
            "replacement": str(group["replacement"]),
            "reason": "polyphone",
            "kind": "polyphone",
            "source": "preset",
            "presetId": str(group["presetId"]),
        }
        for group in POLYPHONE_GROUPS
        for term in group["terms"]
    ],
    {
        "term": "AnyVoice",
        "replacement": "Any Voice",
        "reason": "brand",
        "kind": "brand",
        "source": "preset",
        "presetId": "brand:anyvoice",
    },
    {
        "term": "VoxCPM2",
        "replacement": "Vox C P M two",
        "reason": "brand",
        "kind": "brand",
        "source": "preset",
        "presetId": "brand:voxcpm2",
    },
]


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def canonical_profile_sha256(profile: dict[str, Any]) -> str:
    payload = dict(profile)
    payload.pop("createdAt", None)
    payload.pop("loraPath", None)
    payload.pop("loraAdapter", None)
    payload.pop("preferredBackend", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def default_stability_seed() -> int | None:
    value = os.environ.get("ANYVOICE_STABILITY_SEED", "1337").strip().lower()
    if value in {"", "off", "none", "random"}:
        return None
    try:
        seed = int(value)
    except ValueError:
        return 1337
    return seed if 0 <= seed <= 2_147_483_647 else 1337


def load_eval_set(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        raise RuntimeError(f"No cases found in {path}")
    for case in cases:
        if not isinstance(case.get("id"), str) or not isinstance(case.get("text"), str):
            raise RuntimeError(f"Invalid case in {path}: {case!r}")
    return cases


def select_cases(cases: list[dict[str, Any]], case_ids: list[str], tags: list[str], max_cases: int | None) -> list[dict[str, Any]]:
    selected = cases
    if case_ids:
        requested = set(case_ids)
        selected = [case for case in selected if case["id"] in requested]
        missing = requested.difference({case["id"] for case in selected})
        if missing:
            raise RuntimeError(f"Unknown eval case id(s): {', '.join(sorted(missing))}")
    if tags:
        requested_tags = set(tags)
        selected = [
            case
            for case in selected
            if requested_tags.intersection(set(case.get("tags") or []))
        ]
    if max_cases is not None:
        selected = selected[: max(1, max_cases)]
    if not selected:
        raise RuntimeError("No eval cases selected")
    return selected


def read_prompt_text(prompt_text: str | None, prompt_text_file: str | None) -> str:
    if prompt_text and prompt_text_file:
        raise ValueError("Provide --prompt-text or --prompt-text-file, not both.")
    if prompt_text_file:
        return Path(prompt_text_file).read_text(encoding="utf-8").strip()
    if prompt_text:
        return prompt_text.strip()
    return ""


def clone_modes(value: str) -> list[str]:
    if value == "both":
        return ["prompt", "hifi"]
    return [value]


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


def detect_voice_profile_coverage_features(text: str) -> list[str]:
    features: set[str] = set()
    script = detect_chinese_script(text)
    if script == "zh_hant":
        features.add("zh_hant")
    if re.search(r"[A-Za-z]", text):
        features.add("latin_terms")
    if re.search(r"\d", text) or re.search(r"[零〇一二三四五六七八九十百千兩]+(?:年|月|日|號|點|分|秒|百分)", text):
        features.add("numbers_dates")
    if any(term in text for term in POLYPHONE_TERMS):
        features.add("polyphones")
    punctuation_count = sum(1 for char in text if re.match(r"[，。、！？；：,.!?;:]", char))
    if punctuation_count >= 2:
        features.add("punctuation_rhythm")
    return sorted(features)


def pronunciation_preset_ids(text: str) -> list[str]:
    seen: set[str] = set()
    ids: list[str] = []
    for suggestion in PRONUNCIATION_SUGGESTIONS:
        term = str(suggestion["term"])
        preset_id = str(suggestion["presetId"])
        if term not in text or preset_id in seen:
            continue
        seen.add(preset_id)
        ids.append(preset_id)
    return ids


def normalize_full_width_alnum(value: str) -> tuple[str, bool]:
    changed = False
    chars: list[str] = []
    for ch in value:
        code = ord(ch)
        if code == 0x3000:
            chars.append(" ")
            changed = True
            continue
        if 0xFF10 <= code <= 0xFF19 or 0xFF21 <= code <= 0xFF3A or 0xFF41 <= code <= 0xFF5A:
            chars.append(chr(code - 0xFEE0))
            changed = True
            continue
        chars.append(ch)
    return "".join(chars), changed


def compact_whitespace(value: str) -> str:
    import re

    text = re.sub(r"[ \t\f\v]+", " ", value)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def suggest_pronunciation_overrides(text: str, existing: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    seen = {str(override.get("term") or "") for override in existing or []}
    suggestions: list[dict[str, Any]] = []
    for suggestion in PRONUNCIATION_SUGGESTIONS:
        term = str(suggestion["term"])
        if term in seen or term not in text:
            continue
        seen.add(term)
        suggestions.append(dict(suggestion))
    return suggestions


def split_override_line(line: str) -> tuple[str, str, str | None] | None:
    value = line.strip()
    kind: str | None = None
    prefix = re.match(r"^(pinyin|zhuyin|reading)\s*[:：]\s*", value, flags=re.IGNORECASE)
    if prefix:
        kind = prefix.group(1).lower()
        value = value[prefix.end() :]

    for delimiter in PRONUNCIATION_DELIMITERS:
        index = value.find(delimiter)
        if index < 0:
            continue
        raw_term = value[:index].strip()
        suffix = re.match(r"^(.*)\[(pinyin|zhuyin|reading)\]$", raw_term, flags=re.IGNORECASE)
        if suffix:
            raw_term = suffix.group(1).strip()
            kind = kind or suffix.group(2).lower()
        return raw_term, value[index + len(delimiter) :].strip(), kind
    return None


def annotate_pronunciation_override(term: str, replacement: str, kind: str | None = None) -> dict[str, Any]:
    if kind in PRONUNCIATION_READING_KINDS:
        return {
            "term": term,
            "replacement": replacement,
            "kind": kind,
            "source": "custom",
        }
    for suggestion in PRONUNCIATION_SUGGESTIONS:
        if suggestion["term"] == term and suggestion["replacement"] == replacement:
            return dict(suggestion)
    return {
        "term": term,
        "replacement": replacement,
        "kind": kind if kind in PRONUNCIATION_KINDS else "custom",
        "source": "custom",
    }


def require_pronunciation_override(
    *,
    term: str,
    replacement: str,
    kind: str | None,
    source_label: str,
    seen: set[str],
) -> dict[str, Any]:
    if not term:
        raise SystemExit(f"{source_label} pronunciation override is missing term")
    if not replacement:
        raise SystemExit(f"{source_label} pronunciation override for {term!r} is missing replacement")
    if kind is not None and kind not in PRONUNCIATION_KINDS:
        raise SystemExit(f"{source_label} pronunciation override for {term!r} has unsupported kind: {kind}")
    if len(term) > MAX_PRONUNCIATION_TERM_CHARS:
        raise SystemExit(f"{source_label} pronunciation override term is too long: {term!r}")
    if len(replacement) > MAX_PRONUNCIATION_REPLACEMENT_CHARS:
        raise SystemExit(f"{source_label} pronunciation override replacement is too long for {term!r}")
    if term in seen:
        raise SystemExit(f"{source_label} pronunciation override duplicates term: {term}")
    seen.add(term)
    return annotate_pronunciation_override(term, replacement, kind)


def pronunciation_overrides_from_case(case: dict[str, Any]) -> list[dict[str, Any]]:
    raw = case.get("pronunciationOverrides")
    if raw in (None, "", []):
        return []

    case_id = str(case.get("id") or "<case>")
    source_label = f"eval case {case_id}"
    overrides: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_line(line: str, line_index: int) -> None:
        value = line.strip()
        if not value or value.startswith("#"):
            return
        split = split_override_line(value)
        if split is None:
            raise SystemExit(f"{source_label} pronunciation override line {line_index} has invalid format")
        term, replacement, kind = split
        overrides.append(
            require_pronunciation_override(
                term=term,
                replacement=replacement,
                kind=kind,
                source_label=source_label,
                seen=seen,
            )
        )

    if isinstance(raw, str):
        for index, line in enumerate(raw.splitlines(), start=1):
            add_line(line, index)
    elif isinstance(raw, list):
        for index, item in enumerate(raw, start=1):
            if isinstance(item, str):
                add_line(item, index)
                continue
            if isinstance(item, dict):
                term = str(item.get("term") or "").strip()
                replacement = str(item.get("replacement") or item.get("model") or item.get("reading") or "").strip()
                kind_raw = item.get("kind")
                kind = str(kind_raw).strip().lower() if isinstance(kind_raw, str) and kind_raw.strip() else None
                override = require_pronunciation_override(
                    term=term,
                    replacement=replacement,
                    kind=kind,
                    source_label=source_label,
                    seen=seen,
                )
                if isinstance(item.get("presetId"), str):
                    override["presetId"] = item["presetId"]
                overrides.append(override)
                continue
            raise SystemExit(f"{source_label} pronunciation override entry {index} must be string or object")
    elif isinstance(raw, dict):
        for term, replacement in raw.items():
            overrides.append(
                require_pronunciation_override(
                    term=str(term).strip(),
                    replacement=str(replacement).strip(),
                    kind=None,
                    source_label=source_label,
                    seen=seen,
                )
            )
    else:
        raise SystemExit(f"{source_label} pronunciationOverrides must be a string, object, or list")

    if len(overrides) > MAX_PRONUNCIATION_OVERRIDES:
        raise SystemExit(f"{source_label} has too many pronunciation overrides")
    return overrides


def apply_pronunciation_overrides(text: str, overrides: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    next_text = text
    applied: list[dict[str, Any]] = []
    for override in sorted(overrides, key=lambda item: len(str(item.get("term") or "")), reverse=True):
        term = str(override.get("term") or "")
        replacement = str(override.get("replacement") or "")
        if not term:
            continue
        count = next_text.count(term)
        if count <= 0:
            continue
        next_text = next_text.replace(term, replacement)
        applied.append({**override, "count": count})
    return next_text, applied


def prepare_voice_text(
    raw: str,
    *,
    auto_apply_presets: bool = False,
    pronunciation_overrides: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    operations: list[str] = []
    warnings: list[str] = []
    detected_script = detect_chinese_script(raw)

    line_normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    if line_normalized != raw:
        operations.append("normalize_line_endings")

    full_width, full_width_changed = normalize_full_width_alnum(line_normalized)
    if full_width_changed:
        operations.append("normalize_fullwidth_alnum")

    compact = compact_whitespace(full_width)
    if compact != full_width:
        operations.append("trim_and_compact_whitespace")

    explicit_overrides = pronunciation_overrides or []
    auto_overrides = suggest_pronunciation_overrides(compact, explicit_overrides) if auto_apply_presets else []
    model_text, applied = apply_pronunciation_overrides(compact, [*explicit_overrides, *auto_overrides])
    if auto_overrides and any(applied_item["term"] == override["term"] for override in auto_overrides for applied_item in applied):
        operations.append("auto_apply_pronunciation_presets")
    if applied:
        operations.append("apply_pronunciation_overrides")
    for override in explicit_overrides:
        term = str(override.get("term") or "")
        if term and not any(applied_item["term"] == term for applied_item in applied):
            warnings.append(f"pronunciation_override_not_applied:{term}")

    if detected_script in {"zh_hans", "mixed_zh"}:
        warnings.append("simplified_or_mixed_chinese_detected_preserved")

    return {
        "raw": raw,
        "model": model_text,
        "policy": "preserve_zh_hant",
        "detectedScript": detected_script,
        "operations": operations,
        "warnings": warnings,
        "pronunciationOverrides": applied,
    }


def script_score(target_script: str, clip_script: str) -> int:
    if target_script == clip_script:
        return 0
    if target_script in {"zh_hant", "zh_hans", "mixed_zh"}:
        if clip_script == "zh_unknown":
            return 1
        if clip_script in {"zh_hant", "zh_hans", "mixed_zh"}:
            return 2
    if target_script == "zh_unknown" and clip_script in {"zh_hant", "zh_hans", "mixed_zh"}:
        return 1
    return 3


def load_profile(path: Path) -> dict[str, Any]:
    try:
        profile = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"voice profile not found: {path}") from exc
    if not isinstance(profile, dict):
        raise SystemExit(f"voice profile is not a JSON object: {path}")
    return profile


def profile_summary_value(profile: dict[str, Any], key: str, fallback: int) -> int:
    summary = profile.get("summary")
    if isinstance(summary, dict):
        value = summary.get(key)
        if isinstance(value, int):
            return value
    return fallback


def profile_clips(profile: dict[str, Any]) -> list[dict[str, Any]]:
    clips = profile.get("clips")
    return [clip for clip in clips if isinstance(clip, dict)] if isinstance(clips, list) else []


def require_ready_profile(profile_path: Path, profile: dict[str, Any]) -> None:
    clips = profile_clips(profile)
    if profile.get("status") == "ready" and clips:
        return
    selected = profile_summary_value(profile, "selectedClips", len(clips))
    remaining = profile_summary_value(profile, "remainingClipsNeeded", 0 if clips else 5)
    eligible = profile_summary_value(profile, "eligibleClips", selected)
    raise SystemExit(
        "voice profile is not ready: "
        f"{selected} selected / {eligible} eligible; "
        f"{remaining} more qualified reference clips needed ({profile_path})"
    )


def require_profile_target_scripts(cases: list[dict[str, Any]]) -> None:
    failures: list[str] = []
    for case in cases:
        text = str(case.get("text") or "")
        script = detect_chinese_script(text)
        if script in {"zh_hans", "mixed_zh", "zh_unknown"}:
            failures.append(f"{case.get('id') or '<case>'}:{script}")
    if failures:
        raise SystemExit(
            "profile-based regression requires clear Traditional Chinese target text; "
            f"non-strict Chinese case(s): {', '.join(failures)}"
        )


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"{label} not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} is not a JSON object: {path}")
    return payload


def same_resolved_path(raw_path: Any, expected_path: Path, base_dir: Path) -> bool:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve(strict=False) == expected_path.resolve(strict=False)


def transcript_validation_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("clips")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def validate_profile_transcript_validation(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    transcript_validation_json: Path,
) -> None:
    payload = load_json_object(transcript_validation_json, "transcript validation JSON")
    if payload.get("status") != "pass":
        raise SystemExit(
            "transcript validation JSON must pass before profile regression: "
            f"status={payload.get('status')!r} ({transcript_validation_json})"
        )
    if not same_resolved_path(payload.get("profile"), profile_path, transcript_validation_json.parent):
        raise SystemExit(
            "transcript validation JSON does not match the regression profile: "
            f"{payload.get('profile')!r} != {profile_path} ({transcript_validation_json})"
        )
    by_source = {str(row.get("sourceRunId") or ""): row for row in transcript_validation_rows(payload) if row.get("sourceRunId")}
    missing: list[str] = []
    failed: list[str] = []
    for clip in profile_clips(profile):
        source_run_id = str(clip.get("sourceRunId") or "").strip()
        if not source_run_id:
            continue
        row = by_source.get(source_run_id)
        if not row:
            missing.append(source_run_id)
        elif row.get("verdict") != "pass":
            failed.append(source_run_id)
    if missing or failed:
        raise SystemExit(
            "transcript validation JSON does not pass every selected profile clip before regression: "
            f"{len(missing)} missing, {len(failed)} failed ({transcript_validation_json})"
        )


def require_strict_ready_profile(
    *,
    profile_path: Path,
    profile: dict[str, Any],
    transcript_validation_json: Path,
) -> None:
    report = verify_profile_readiness_report(
        profile_path=profile_path,
        profile=profile,
        min_clips_override=None,
        min_total_duration_sec=30.0,
        check_audio_exists=True,
        audio_exists_bypass_reason=None,
        transcript_validation_json=transcript_validation_json,
        require_transcript_validation=True,
    )
    if report.get("status") == "ready":
        return
    failed = [
        f"{row.get('check')}: {row.get('message')}"
        for row in report.get("checks", [])
        if isinstance(row, dict) and row.get("ok") is not True
    ]
    detail = "; ".join(failed[:6]) or "strict verifier returned blocked"
    raise SystemExit(
        "profile regression requires strict ready profile proof before rendering: "
        f"{detail} ({profile_path})"
    )


def resolve_profile_audio_path(profile_path: Path, raw_path: str) -> Path:
    audio_path = Path(raw_path).expanduser()
    if not audio_path.is_absolute():
        audio_path = profile_path.parent / audio_path
    return audio_path.resolve()


def coverage_selection_score(target_features: list[str], clip_features: list[str]) -> dict[str, Any]:
    clip_feature_set = set(clip_features)
    matched = [feature for feature in target_features if feature in clip_feature_set]
    return {
        "missing": len(target_features) - len(matched),
        "matched": matched,
    }


def clip_coverage_features(clip: dict[str, Any]) -> list[str]:
    raw = clip.get("coverageFeatures")
    if isinstance(raw, list):
        return sorted(str(feature) for feature in raw if str(feature) in REQUIRED_COVERAGE_FEATURES)
    return detect_voice_profile_coverage_features(str(clip.get("transcriptRaw") or ""))


def clip_pronunciation_preset_ids(clip: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    ids: list[str] = []
    raw = clip.get("pronunciationPresetIds")
    if isinstance(raw, list):
        for preset_id in raw:
            if not isinstance(preset_id, str) or not preset_id or preset_id in seen:
                continue
            seen.add(preset_id)
            ids.append(preset_id)
    for preset_id in pronunciation_preset_ids(str(clip.get("transcriptRaw") or "")):
        if preset_id in seen:
            continue
        seen.add(preset_id)
        ids.append(preset_id)
    return ids


def select_profile_clip(profile: dict[str, Any], target_text: str) -> dict[str, Any]:
    clips = profile_clips(profile)
    target_script = detect_chinese_script(target_text)
    target_coverage_features = detect_voice_profile_coverage_features(target_text)
    target_pronunciation_preset_ids = pronunciation_preset_ids(target_text)

    def pronunciation_score(clip: dict[str, Any]) -> dict[str, Any]:
        clip_ids = set(clip_pronunciation_preset_ids(clip))
        matched = [preset_id for preset_id in target_pronunciation_preset_ids if preset_id in clip_ids]
        return {
            "missing": len(target_pronunciation_preset_ids) - len(matched),
            "matched": matched,
            "priority": sum(target_pronunciation_preset_ids.index(preset_id) for preset_id in matched),
        }

    def clip_sort_key(item: tuple[int, dict[str, Any]]) -> tuple[int, int, int, int, int, int, int]:
        index, clip = item
        transcript = str(clip.get("transcriptRaw") or "")
        clip_script = str(clip.get("transcriptScript") or detect_chinese_script(transcript))
        coverage = coverage_selection_score(target_coverage_features, clip_coverage_features(clip))
        pronunciation = pronunciation_score(clip)
        return (
            script_score(target_script, clip_script),
            int(pronunciation["missing"]),
            int(pronunciation["priority"]) if pronunciation["matched"] else 0,
            coverage["missing"],
            -len(pronunciation["matched"]),
            -len(coverage["matched"]),
            index,
        )

    _, clip = sorted(enumerate(clips), key=clip_sort_key)[0]
    coverage = coverage_selection_score(target_coverage_features, clip_coverage_features(clip))
    pronunciation = pronunciation_score(clip)
    return {
        "clip": clip,
        "targetCoverageFeatures": target_coverage_features,
        "matchedCoverageFeatures": coverage["matched"],
        "targetPronunciationPresetIds": target_pronunciation_preset_ids,
        "matchedPronunciationPresetIds": pronunciation["matched"],
    }


def profile_pronunciation_preset_ids(profile: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    ids: list[str] = []
    for clip in profile_clips(profile):
        for preset_id in clip_pronunciation_preset_ids(clip):
            if preset_id in seen:
                continue
            seen.add(preset_id)
            ids.append(preset_id)
    return ids


def reference_for_case(
    *,
    case: dict[str, Any],
    reference_audio: str,
    prompt_text: str,
    profile_path: Path | None,
    profile: dict[str, Any] | None,
    dry_run: bool,
) -> dict[str, Any]:
    if not profile:
        return {
            "referenceAudio": reference_audio,
            "promptText": prompt_text,
            "profileClipId": None,
            "voiceProfileId": None,
            "profileSha256": None,
        }

    if profile_path is None:
        raise RuntimeError("profile_path is required when profile is set")
    selection = select_profile_clip(profile, case["text"])
    clip = selection["clip"]
    source_run_id = str(clip.get("sourceRunId") or "")
    transcript = str(clip.get("transcriptRaw") or "").strip()
    raw_audio_path = str(clip.get("audioPath") or "")
    if not source_run_id:
        raise SystemExit(f"profile clip is missing sourceRunId ({profile_path})")
    if not raw_audio_path:
        raise SystemExit(f"profile clip {source_run_id} is missing audioPath ({profile_path})")
    if not transcript:
        raise SystemExit(f"profile clip {source_run_id} is missing transcriptRaw ({profile_path})")

    audio_path = resolve_profile_audio_path(profile_path, raw_audio_path)
    if not dry_run and not audio_path.exists():
        raise SystemExit(f"profile clip audio is missing: {audio_path}")

    return {
        "referenceAudio": str(audio_path),
        "promptText": transcript,
        "profileClipId": source_run_id,
        "voiceProfileId": str(profile.get("voiceProfileId") or ""),
        "profileSha256": canonical_profile_sha256(profile),
        "targetCoverageFeatures": selection["targetCoverageFeatures"],
        "matchedCoverageFeatures": selection["matchedCoverageFeatures"],
        "targetPronunciationPresetIds": selection["targetPronunciationPresetIds"],
        "matchedPronunciationPresetIds": selection["matchedPronunciationPresetIds"],
        "profilePronunciationPresetIds": profile_pronunciation_preset_ids(profile),
    }


def shell_join(cmd: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(part) for part in cmd)


def hot_worker_clone_url(base_url: str) -> str:
    value = base_url.rstrip("/")
    if value.endswith("/clone"):
        return value
    return f"{value}/clone"


def call_hot_worker(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        hot_worker_clone_url(url),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    metadata: dict[str, Any] = {}
    try:
        with urllib.request.urlopen(request, timeout=None) as response:  # noqa: S310
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                event = json.loads(line)
                if event.get("type") == "error":
                    raise RuntimeError(str(event.get("traceback") or event.get("message") or "hot worker error"))
                if event.get("type") == "metadata" and isinstance(event.get("metadata"), dict):
                    metadata = event["metadata"]
    except urllib.error.URLError as exc:
        raise RuntimeError(f"hot worker request failed: {exc}") from exc
    return metadata


def load_wav(path: Path) -> tuple[Any, int]:
    import numpy as np

    try:
        import soundfile as sf

        data, sr = sf.read(str(path), always_2d=False, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return np.asarray(data, dtype="float32"), int(sr)
    except ModuleNotFoundError:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sr = handle.getframerate()
            frames = handle.getnframes()
            raw = handle.readframes(frames)
        if sample_width != 2 or channels <= 0 or sr <= 0:
            raise RuntimeError("wave fallback only supports 16-bit PCM WAV")
        usable_bytes = len(raw) - (len(raw) % sample_width)
        samples = array.array("h")
        samples.frombytes(raw[:usable_bytes])
        if sys.byteorder != "little":
            samples.byteswap()
        if channels > 1:
            values = [
                sum(samples[index : index + channels]) / float(channels)
                for index in range(0, len(samples) - (len(samples) % channels), channels)
            ]
        else:
            values = samples
        return np.asarray(values, dtype="float32") / 32768.0, int(sr)


def wav_metrics(path: Path) -> dict[str, Any]:
    try:
        import numpy as np

        data, sr = load_wav(path)
        if data.size == 0 or sr <= 0:
            return {"available": False, "reason": "empty_audio"}
        peak = float(np.max(np.abs(data)))
        rms = float(np.sqrt(np.mean(data * data) + 1e-12))
        return {
            "available": True,
            "sampleRate": sr,
            "durationSec": round(float(data.size) / float(sr), 3),
            "peak": round(peak, 6),
            "rmsDbfs": round(20.0 * math.log10(max(rms, 1e-12)), 3),
            "clippingRatio": round(float(np.mean(np.abs(data) >= 0.99)), 6),
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": str(exc)}


def pairwise_corr(a_path: Path, b_path: Path) -> float | None:
    try:
        import numpy as np

        a, sr_a = load_wav(a_path)
        b, sr_b = load_wav(b_path)
        if sr_a != sr_b:
            return None
        n = min(a.size, b.size)
        if n < sr_a:
            return None
        a = a[:n]
        b = b[:n]
        if float(np.std(a)) < 1e-8 or float(np.std(b)) < 1e-8:
            return None
        return round(float(np.corrcoef(a, b)[0, 1]), 4)
    except Exception:
        return None


def stability_summary(rows: list[dict[str, Any]], min_successful_repeats: int = 3) -> dict[str, Any]:
    usable = [row for row in rows if row.get("audioMetrics", {}).get("available")]
    if len(usable) < min_successful_repeats:
        return {
            "verdict": "review",
            "reason": "need_three_successful_repeats",
            "successfulRepeats": len(usable),
            "minSuccessfulRepeats": min_successful_repeats,
        }

    durations = [float(row["audioMetrics"]["durationSec"]) for row in usable]
    rms_values = [float(row["audioMetrics"]["rmsDbfs"]) for row in usable]
    duration_avg = sum(durations) / len(durations)
    duration_span_pct = (max(durations) - min(durations)) / max(duration_avg, 1e-6) * 100.0
    rms_span_db = max(rms_values) - min(rms_values)

    corrs: list[float] = []
    for i, row_a in enumerate(usable):
        for row_b in usable[i + 1 :]:
            corr = pairwise_corr(Path(row_a["outputWav"]), Path(row_b["outputWav"]))
            if corr is not None:
                corrs.append(corr)

    min_corr = min(corrs) if corrs else None
    review_reasons: list[str] = []
    if duration_span_pct > 12.0:
        review_reasons.append("duration_varies")
    if rms_span_db > 3.0:
        review_reasons.append("loudness_varies")
    if min_corr is not None and min_corr < 0.75:
        review_reasons.append("waveform_varies")

    return {
        "verdict": "review" if review_reasons else "pass",
        "reviewReasons": review_reasons,
        "durationSpanPct": round(duration_span_pct, 3),
        "rmsSpanDb": round(rms_span_db, 3),
        "minPairwiseWaveformCorr": min_corr,
        "successfulRepeats": len(usable),
        "minSuccessfulRepeats": min_successful_repeats,
    }


def relative_output_path(report_path: Path, output_path: str) -> str:
    path = Path(output_path)
    try:
        return str(path.relative_to(report_path.parent))
    except ValueError:
        return str(path)


def blind_order_key(case_id: str, repeat: int, clone_mode: str, output_wav: str) -> str:
    token = f"{case_id}\0{repeat}\0{clone_mode}\0{output_wav}".encode("utf-8")
    return hashlib.sha256(token).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_blind_rounds(report: dict[str, Any]) -> list[dict[str, Any]]:
    rounds: dict[tuple[str, int], dict[str, Any]] = {}
    order: list[tuple[str, int]] = []
    for group in report.get("groups", []):
        if not isinstance(group, dict):
            continue
        case = group.get("case")
        if not isinstance(case, dict):
            continue
        case_id = str(case.get("id") or "case")
        clone_mode = str(group.get("cloneMode") or "")
        stability = group.get("stability") if isinstance(group.get("stability"), dict) else {}
        renders = group.get("renders")
        if not isinstance(renders, list):
            continue
        for render in renders:
            if not isinstance(render, dict):
                continue
            repeat = int(render.get("repeat") or 1)
            key = (case_id, repeat)
            if key not in rounds:
                rounds[key] = {
                    "case": case,
                    "repeat": repeat,
                    "samples": [],
                }
                order.append(key)
            rounds[key]["samples"].append(
                {
                    "cloneMode": clone_mode or str(render.get("cloneMode") or ""),
                    "render": render,
                    "stability": stability,
                }
            )

    result: list[dict[str, Any]] = []
    for key in order:
        item = rounds[key]
        case = item["case"]
        repeat = item["repeat"]
        case_id = str(case.get("id") or "case")
        item["samples"] = sorted(
            item["samples"],
            key=lambda sample: blind_order_key(
                case_id,
                repeat,
                str(sample.get("cloneMode") or ""),
                str(sample.get("render", {}).get("outputWav") or ""),
            ),
        )
        result.append(item)
    return result


def write_html_report(report_path: Path, report: dict[str, Any]) -> Path:
    html_path = report_path.with_suffix(".html")
    expected_review_path = report_path.parent / "review.json"
    blind_rounds = build_blind_rounds(report)
    review_rounds: list[dict[str, Any]] = []
    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for round_item in blind_rounds:
        case = round_item["case"]
        case_id = str(case.get("id") or "case")
        repeat = int(round_item["repeat"])
        round_meta: dict[str, Any] = {
            "choiceKey": f"winner-{case_id}-r{repeat:02d}",
            "caseId": case_id,
            "repeat": repeat,
            "candidateLabel": None,
            "baselineLabel": None,
        }
        for index, sample in enumerate(round_item["samples"]):
            label = labels[index]
            clone_mode = str(sample.get("cloneMode") or "")
            if clone_mode == "hifi":
                round_meta["candidateLabel"] = label
            elif clone_mode == "prompt":
                round_meta["baselineLabel"] = label
        review_rounds.append(round_meta)
    review_metadata = {
        "version": 1,
        "reportPath": str(report_path.resolve()),
        "reportSha256": file_sha256(report_path),
        "expectedSaveAs": str(expected_review_path.resolve()),
        "choiceKeys": [str(round_item["choiceKey"]) for round_item in review_rounds],
        "rounds": review_rounds,
    }
    rows: list[str] = []
    for round_item in blind_rounds:
        case = round_item["case"]
        case_id = str(case.get("id") or "case")
        repeat = int(round_item["repeat"])
        samples = round_item["samples"]
        winner_name = f"winner-{case_id}-r{repeat:02d}"
        notes_name = f"notes-{case_id}-r{repeat:02d}"
        rows.append(
            "<section class='case-review'>"
            f"<h2>{html.escape(case_id)}</h2>"
            f"<p class='target'>{html.escape(str(case.get('text') or ''))}</p>"
            f"<fieldset data-case-id='{html.escape(case_id, quote=True)}' data-repeat='{repeat}' "
            f"data-choice-key='{html.escape(winner_name, quote=True)}'>"
            f"<legend>Round {repeat}</legend>"
            "<div class='samples'>"
        )
        for index, sample in enumerate(samples):
            label = labels[index]
            render = sample["render"]
            rel = relative_output_path(report_path, str(render.get("outputWav") or ""))
            status = str(render.get("status") or "unknown")
            rows.append(
                "<article class='sample'>"
                f"<h3>Sample {label}</h3>"
                f"<audio controls src='{html.escape(rel, quote=True)}'></audio>"
                f"<label><input type='radio' name='{html.escape(winner_name, quote=True)}' "
                f"value='{label}'> Best overall</label>"
                f"<small>Status: {html.escape(status)}</small>"
                "</article>"
            )
        rows.append("</div><div class='review-actions'>")
        rows.append(
            f"<label><input type='radio' name='{html.escape(winner_name, quote=True)}' value='tie'> Tie / no clear winner</label>"
            f"<label><input type='radio' name='{html.escape(winner_name, quote=True)}' value='rerender'> Needs rerender</label>"
            f"<textarea name='{html.escape(notes_name, quote=True)}' rows='2' "
            "placeholder='Notes: pronunciation, speaker identity, stability'></textarea>"
        )
        rows.append("</div><details class='answer-key'><summary>Reveal key after listening</summary><ul>")
        for index, sample in enumerate(samples):
            label = labels[index]
            render = sample["render"]
            stability = sample.get("stability") or {}
            metrics = render.get("audioMetrics") if isinstance(render.get("audioMetrics"), dict) else {}
            duration = metrics.get("durationSec", "--")
            rows.append(
                "<li>"
                f"Sample {label}: {html.escape(str(sample.get('cloneMode') or 'unknown'))}; "
                f"repeat {html.escape(str(render.get('repeat') or repeat))}; "
                f"stability {html.escape(str(stability.get('verdict') or 'unknown'))}; "
                f"duration {html.escape(str(duration))}s"
                "</li>"
            )
        rows.append("</ul></details></fieldset></section>")

    html_path.write_text(
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AnyVoice Blind A/B Review</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1120px; margin: 32px auto; padding: 0 20px; line-height: 1.5; }
    section { border-top: 1px solid #ddd; padding: 20px 0; }
    h1, h2, h3 { margin: 0 0 8px; }
    fieldset { border: 1px solid #d8d8d8; border-radius: 8px; padding: 16px; }
    fieldset.current-round { border-color: #0a7; box-shadow: 0 0 0 2px color-mix(in srgb, #0a7 24%, transparent); }
    legend { padding: 0 6px; font-weight: 700; }
    .target { font-size: 18px; }
    .samples { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 12px 0; }
    .sample { display: grid; gap: 10px; border: 1px solid #ddd; border-radius: 8px; padding: 14px; }
    .sample small { opacity: 0.72; }
    .review-actions { display: grid; gap: 10px; margin-top: 12px; }
    textarea { width: 100%; box-sizing: border-box; font: inherit; }
    details { margin-top: 12px; }
    summary { cursor: pointer; font-weight: 700; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
    button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid #ccc; cursor: pointer; }
    .review-summary { position: sticky; top: 0; z-index: 1; display: grid; gap: 8px; border: 1px solid #d8d8d8; border-radius: 8px; padding: 12px; margin: 18px 0; background: Canvas; }
    .review-summary strong { font-size: 16px; }
    .review-meter { height: 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 12%, Canvas); overflow: hidden; }
    .review-meter span { display: block; height: 100%; width: 0%; background: #0a7; transition: width 160ms ease; }
    .review-progress-detail { font-size: 14px; opacity: 0.78; }
    #review-json { min-height: 160px; }
    #save-status { min-height: 1.4em; font-size: 14px; opacity: 0.78; }
    audio { width: 100%; }
  </style>
</head>
<body>
  <h1>AnyVoice Blind A/B Review</h1>
  <p>Listen before opening the reveal key. The sibling JSON contains the metrics; this page captures subjective pronunciation, speaker identity, and stability preference.</p>
  <p><strong>Expected save path:</strong> <code>""" + html.escape(str(expected_review_path.resolve())) + """</code></p>
  <aside class="review-summary" aria-live="polite">
    <strong id="review-progress-title">0 / 0 rounds reviewed</strong>
    <div class="review-meter" aria-hidden="true"><span id="review-progress-bar"></span></div>
    <div id="review-progress-detail" class="review-progress-detail"></div>
  </aside>
  <form id="review-form">
"""
        + "\n".join(rows)
        + """
    <div class="toolbar">
      <button type="button" id="export-review">Export review JSON</button>
      <button type="button" id="save-review">Save review.json</button>
      <button type="button" id="download-review">Download review.json</button>
      <button type="button" id="next-unanswered">Next unanswered</button>
      <button type="reset">Clear choices</button>
    </div>
    <p id="save-status"></p>
    <textarea id="review-json" readonly placeholder="Review JSON appears here after export."></textarea>
  </form>
  <script>
    const form = document.getElementById("review-form");
    const output = document.getElementById("review-json");
    const saveStatus = document.getElementById("save-status");
    const progressTitle = document.getElementById("review-progress-title");
    const progressDetail = document.getElementById("review-progress-detail");
    const progressBar = document.getElementById("review-progress-bar");
    const storageKey = `anyvoice-review:${location.pathname}`;
    const reviewMetadata = """ + json.dumps(review_metadata, ensure_ascii=False) + """;
    const minimumReviewedRounds = Math.min(7, (reviewMetadata.rounds || []).length);
    let lastAutoSavedPayloadKey = "";

    function collect() {
      const data = {};
      for (const [key, value] of new FormData(form).entries()) {
        data[key] = value;
      }
      return data;
    }

    function restore() {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
        for (const [key, value] of Object.entries(saved)) {
          const radio = form.querySelector(`input[type="radio"][name="${CSS.escape(key)}"][value="${CSS.escape(String(value))}"]`);
          if (radio) radio.checked = true;
          const field = form.querySelector(`textarea[name="${CSS.escape(key)}"]`);
          if (field) field.value = String(value);
        }
      } catch {}
    }

    function fieldsetForChoice(choiceKey) {
      return form.querySelector(`fieldset[data-choice-key="${CSS.escape(String(choiceKey))}"]`);
    }

    function currentMissingKey() {
      return reviewStats(collect()).missingChoices[0] || null;
    }

    function setCurrentRound(choiceKey) {
      for (const fieldset of form.querySelectorAll("fieldset.current-round")) {
        fieldset.classList.remove("current-round");
      }
      const fieldset = choiceKey ? fieldsetForChoice(choiceKey) : null;
      if (fieldset) fieldset.classList.add("current-round");
      return fieldset;
    }

    function goToChoice(choiceKey) {
      const fieldset = setCurrentRound(choiceKey);
      if (fieldset) fieldset.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    function goToNextUnanswered() {
      goToChoice(currentMissingKey());
    }

    function chooseCurrent(value) {
      const key = currentMissingKey();
      if (!key) return;
      const fieldset = fieldsetForChoice(key);
      if (!fieldset) return;
      const input = fieldset.querySelector(`input[type="radio"][name="${CSS.escape(key)}"][value="${CSS.escape(value)}"]`);
      if (!input) return;
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      goToNextUnanswered();
    }

    function pauseAllAudio() {
      for (const audio of form.querySelectorAll("audio")) {
        audio.pause();
      }
    }

    function playCurrentSample(index) {
      const key = currentMissingKey();
      const fieldset = key ? fieldsetForChoice(key) : form.querySelector("fieldset.current-round");
      if (!fieldset) return;
      const samples = [...fieldset.querySelectorAll("audio")];
      const audio = samples[index];
      if (!audio) return;
      pauseAllAudio();
      void audio.play();
    }

    function reviewStats(choices) {
      let candidateWins = 0;
      let baselineWins = 0;
      let ties = 0;
      let rerenders = 0;
      let reviewedRounds = 0;
      const missingChoices = [];
      const unreviewedChoices = [];
      const invalidChoices = [];
      for (const round of reviewMetadata.rounds || []) {
        const key = String(round.choiceKey || "");
        const value = choices[key];
        if (!value) {
          unreviewedChoices.push(key);
          continue;
        }
        reviewedRounds += 1;
        if (value === "rerender") rerenders += 1;
        else if (value === "tie") ties += 1;
        else if (value === round.candidateLabel) candidateWins += 1;
        else if (value === round.baselineLabel) baselineWins += 1;
        else invalidChoices.push({ choiceKey: key, value });
      }
      if (reviewedRounds < minimumReviewedRounds) {
        missingChoices.push(...unreviewedChoices.slice(0, minimumReviewedRounds - reviewedRounds));
      }
      const totalReportRounds = (reviewMetadata.rounds || []).length;
      const rounds = reviewedRounds;
      const candidateWinRate = rounds ? Math.round((candidateWins / rounds) * 10000) / 10000 : 0;
      return {
        stats: {
          rounds,
          reviewedRounds,
          candidateWins,
          baselineWins,
          ties,
          rerenders,
          candidateWinRate,
          minCandidateWinRate: 0.8,
          reportSha256: reviewMetadata.reportSha256,
          totalReportRounds,
          minimumReviewedRounds,
        },
        missingChoices,
        unreviewedChoices,
        invalidChoices,
      };
    }
    function updateProgress() {
      const payload = reviewPayload();
      const stats = payload.stats;
      const remaining = payload.missingChoices.length;
      const pct = stats.minimumReviewedRounds ? Math.min(100, Math.round((stats.reviewedRounds / stats.minimumReviewedRounds) * 100)) : 0;
      progressTitle.textContent = `${stats.reviewedRounds} / ${stats.minimumReviewedRounds} minimum rounds reviewed`;
      progressBar.style.width = `${pct}%`;
      const winRatePct = Math.round(stats.candidateWinRate * 100);
      const passText = payload.status === "pass" ? "ready to save" : `${remaining} needed, candidate wins ${stats.candidateWins}, baseline wins ${stats.baselineWins}, candidate win rate ${winRatePct}%`;
      progressDetail.textContent = `${passText}. ${stats.totalReportRounds} total rounds exist; this export records selected rounds only. Draft choices are saved in this browser.`;
      output.value = JSON.stringify(payload, null, 2);
      setCurrentRound(payload.missingChoices[0] || null);
      maybeAutoSave(payload);
      return payload;
    }
    function reviewPayload() {
      const choices = collect();
      const summary = reviewStats(choices);
      const reasons = [];
      if (summary.missingChoices.length || summary.invalidChoices.length || summary.stats.rerenders) {
        reasons.push("subjective_review_incomplete_or_rerender");
      }
      if (summary.stats.baselineWins > summary.stats.candidateWins) {
        reasons.push("subjective_review_baseline_preferred_over_candidate");
      }
      return {
        version: 1,
        reviewScope: "selected",
        minimumReviewedRounds,
        status: reasons.length ? "review" : "pass",
        reasons,
        report: reviewMetadata.reportPath,
        reportPath: reviewMetadata.reportPath,
        reportSha256: reviewMetadata.reportSha256,
        expectedSaveAs: reviewMetadata.expectedSaveAs,
        choiceKeys: reviewMetadata.choiceKeys,
        reviewedAt: new Date().toISOString(),
        stats: summary.stats,
        missingChoices: summary.missingChoices,
        invalidChoices: summary.invalidChoices,
        choices,
      };
    }
    function exportReview() {
      const text = JSON.stringify(updateProgress(), null, 2);
      output.value = text;
      return text;
    }
    async function saveReview({ auto = false } = {}) {
      const text = exportReview();
      saveStatus.textContent = auto ? "Auto-saving..." : "Saving...";
      try {
        const response = await fetch("/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text + "\\n",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        saveStatus.textContent = `${auto ? "Auto-saved" : "Saved"} ${payload.path || reviewMetadata.expectedSaveAs}`;
      } catch (error) {
        saveStatus.textContent = `Save failed: ${error && error.message ? error.message : error}. Use Download review.json instead.`;
      }
    }
    function maybeAutoSave(payload) {
      if (!payload || payload.status !== "pass") return;
      const payloadKey = JSON.stringify({
        status: payload.status,
        choices: payload.choices,
        stats: payload.stats,
        reportSha256: payload.reportSha256,
      });
      if (payloadKey === lastAutoSavedPayloadKey) return;
      lastAutoSavedPayloadKey = payloadKey;
      void saveReview({ auto: true });
    }
    form.addEventListener("input", () => {
      localStorage.setItem(storageKey, JSON.stringify(collect()));
      updateProgress();
    });
    form.addEventListener("reset", () => {
      setTimeout(() => {
        localStorage.removeItem(storageKey);
        output.value = "";
        updateProgress();
      }, 0);
    });
    document.getElementById("export-review").addEventListener("click", () => {
      exportReview();
    });
    document.getElementById("save-review").addEventListener("click", () => {
      void saveReview();
    });
    document.getElementById("download-review").addEventListener("click", () => {
      const text = exportReview();
      const blob = new Blob([text + "\\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "review.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
    document.getElementById("next-unanswered").addEventListener("click", () => {
      goToNextUnanswered();
    });
    document.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "a") chooseCurrent("A");
      else if (key === "b") chooseCurrent("B");
      else if (key === "t") chooseCurrent("tie");
      else if (key === "r") chooseCurrent("rerender");
      else if (key === "n") goToNextUnanswered();
      else if (key === "s") void saveReview();
      else if (key === "1") playCurrentSample(0);
      else if (key === "2") playCurrentSample(1);
      else if (key === "p") pauseAllAudio();
      else return;
      event.preventDefault();
    });
    restore();
    updateProgress();
  </script>
</body>
</html>
""",
        encoding="utf-8",
    )
    return html_path


def render_failures(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for group in groups:
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict):
                continue
            status = str(render.get("status") or "")
            missing_output = bool(render.get("missingOutput"))
            output_exists = render.get("outputExists")
            if status == "ready" and not missing_output and output_exists is not False:
                continue
            failures.append(
                {
                    "caseId": case.get("id"),
                    "cloneMode": group.get("cloneMode"),
                    "repeat": render.get("repeat"),
                    "status": status,
                    "message": render.get("message"),
                    "outputWav": render.get("outputWav"),
                    "missingOutput": missing_output,
                }
            )
    return failures


def render_case(
    *,
    python: str,
    case: dict[str, Any],
    out_dir: Path,
    reference_audio: str,
    prompt_text: str,
    model_id: str,
    quality: str,
    clone_mode: str,
    repeat: int,
    dry_run: bool,
    hot_worker_url: str | None,
    stability_seed: int | None,
    profile_clip_id: str | None,
    voice_profile_id: str | None,
    profile_sha256: str | None,
    target_coverage_features: list[str] | None,
    matched_coverage_features: list[str] | None,
    target_pronunciation_preset_ids: list[str] | None,
    matched_pronunciation_preset_ids: list[str] | None,
    profile_pronunciation_preset_ids: list[str] | None,
) -> dict[str, Any]:
    repeat_dir = out_dir / clone_mode / case["id"] / f"r{repeat:02d}"
    repeat_dir.mkdir(parents=True, exist_ok=True)
    text_file = repeat_dir / "target.txt"
    text_raw_file = repeat_dir / "target.raw.txt"
    prompt_file = repeat_dir / "reference_prompt.txt"
    prompt_raw_file = repeat_dir / "reference_prompt.raw.txt"
    text_prep_file = repeat_dir / "text-prep.json"
    output_wav = repeat_dir / "output.wav"
    metadata_file = repeat_dir / "metadata.json"
    pronunciation_overrides = pronunciation_overrides_from_case(case)
    text_preparation = {
        "version": 1,
        "targetText": prepare_voice_text(
            str(case["text"]),
            auto_apply_presets=True,
            pronunciation_overrides=pronunciation_overrides,
        ),
        "promptTranscript": prepare_voice_text(prompt_text),
    }
    text_file.write_text(str(text_preparation["targetText"]["model"]).rstrip() + "\n", encoding="utf-8")
    text_raw_file.write_text(str(text_preparation["targetText"]["raw"]).rstrip() + "\n", encoding="utf-8")
    prompt_file.write_text(str(text_preparation["promptTranscript"]["model"]).rstrip() + "\n", encoding="utf-8")
    prompt_raw_file.write_text(str(text_preparation["promptTranscript"]["raw"]).rstrip() + "\n", encoding="utf-8")
    text_prep_file.write_text(json.dumps(text_preparation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    cmd = [
        python,
        str(SYNTH_SCRIPT),
        "--text-file",
        str(text_file),
        "--reference-audio",
        reference_audio,
        "--prompt-text-file",
        str(prompt_file),
        "--model-id",
        model_id,
        "--quality",
        quality,
        "--clone-mode",
        clone_mode,
        "--metadata-output",
        str(metadata_file),
        "--text-prep-file",
        str(text_prep_file),
        "--output",
        str(output_wav),
    ]
    if stability_seed is not None:
        cmd.extend(["--seed", str(stability_seed)])

    result: dict[str, Any] = {
        "caseId": case["id"],
        "cloneMode": clone_mode,
        "repeat": repeat,
        "command": (
            f"POST {hot_worker_clone_url(hot_worker_url)}"
            if hot_worker_url
            else shell_join(cmd)
        ),
        "referenceAudio": reference_audio,
        "targetTextFile": str(text_file),
        "targetTextRawFile": str(text_raw_file),
        "promptTextFile": str(prompt_file),
        "promptTextRawFile": str(prompt_raw_file),
        "textPrepFile": str(text_prep_file),
        "textPreparation": text_preparation,
        "stabilitySeed": stability_seed,
        "profileClipId": profile_clip_id,
        "voiceProfileId": voice_profile_id,
        "profileSha256": profile_sha256,
        "targetCoverageFeatures": target_coverage_features,
        "matchedCoverageFeatures": matched_coverage_features,
        "targetPronunciationPresetIds": target_pronunciation_preset_ids,
        "matchedPronunciationPresetIds": matched_pronunciation_preset_ids,
        "profilePronunciationPresetIds": profile_pronunciation_preset_ids,
        "outputWav": str(output_wav),
        "metadata": str(metadata_file),
        "status": "dry_run" if dry_run else "pending",
    }
    if dry_run:
        return result

    started_at = time.perf_counter()
    if hot_worker_url:
        try:
            metadata = call_hot_worker(
                hot_worker_url,
                {
                    "textFile": str(text_file),
                    "referenceAudio": reference_audio,
                    "promptTextFile": str(prompt_file),
                    "textPrepFile": str(text_prep_file),
                    "modelId": model_id,
                    "quality": quality,
                    "cloneMode": clone_mode,
                    "stabilitySeed": stability_seed,
                    "metadataOutput": str(metadata_file),
                    "output": str(output_wav),
                },
            )
            result["hotWorkerMetadata"] = metadata
        except Exception as exc:  # noqa: BLE001
            result["renderSeconds"] = round(time.perf_counter() - started_at, 3)
            result["status"] = "error"
            result["message"] = str(exc)
            return result
    else:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        result["renderSeconds"] = round(time.perf_counter() - started_at, 3)
        result["returnCode"] = proc.returncode
        result["stderr"] = proc.stderr[-4000:]
        if proc.returncode != 0:
            result["status"] = "error"
            result["message"] = proc.stderr.strip() or proc.stdout.strip() or "render failed"
            return result
    if "renderSeconds" not in result:
        result["renderSeconds"] = round(time.perf_counter() - started_at, 3)

    result["status"] = "ready"
    result["outputExists"] = output_wav.exists()
    result["missingOutput"] = not output_wav.exists()
    result["outputBytes"] = output_wav.stat().st_size if output_wav.exists() else None
    result["outputSha256"] = file_sha256(output_wav) if output_wav.exists() else None
    result["audioMetrics"] = wav_metrics(output_wav)
    try:
        result["metadataJson"] = json.loads(metadata_file.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        result["metadataReadError"] = str(exc)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Render and score AnyVoice voice-clone regression cases.")
    parser.add_argument("--eval-set", default=str(DEFAULT_EVAL_SET))
    parser.add_argument(
        "--profile-json",
        help=f"Use a ready digital voice profile manifest instead of --reference-audio. Default profile path: {DEFAULT_PROFILE_JSON}",
    )
    parser.add_argument(
        "--transcript-validation-json",
        help="Passing ASR transcript-validation report for --profile-json. Defaults to <profile-dir>/transcript-validation.json.",
    )
    parser.add_argument(
        "--skip-strict-profile-proof",
        action="store_true",
        help="Do not require strict profile readiness/transcript-validation proof before profile regression.",
    )
    parser.add_argument(
        "--allow-unsafe-profile-proof-bypass",
        action="store_true",
        help="Allow --skip-strict-profile-proof for migration/debug runs. Requires --unsafe-profile-proof-bypass-reason.",
    )
    parser.add_argument(
        "--unsafe-profile-proof-bypass-reason",
        default="",
        help="Required reason when bypassing strict profile proof for profile regression.",
    )
    parser.add_argument("--reference-audio", help="Reference voice clip used for every case.")
    parser.add_argument("--prompt-text", help="Exact transcript for --reference-audio.")
    parser.add_argument("--prompt-text-file", help="File containing the exact transcript for --reference-audio.")
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "generated" / "voice-regression" / utc_stamp()))
    parser.add_argument("--report", help="Report JSON path. Defaults to <out-dir>/report.json.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--hot-worker-url", help="Use the already-loaded hot worker instead of spawning Python per render.")
    parser.add_argument("--model-id", default="openbmb/VoxCPM2")
    parser.add_argument("--quality", choices=("speed", "balanced", "quality"), default="balanced")
    parser.add_argument("--seed", type=int, default=default_stability_seed(), help="Stability seed for repeated renders. Set ANYVOICE_STABILITY_SEED=off to disable.")
    parser.add_argument("--clone-mode", choices=("hifi", "prompt", "both"), default="both")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument(
        "--case",
        action="append",
        default=[],
        help="Eval case id to render. Can be passed multiple times.",
    )
    parser.add_argument(
        "--tag",
        action="append",
        default=[],
        help="Render cases containing this tag. Can be passed multiple times.",
    )
    parser.add_argument("--max-cases", type=int, help="Limit selected cases after filters.")
    parser.add_argument("--dry-run", action="store_true", help="Write commands/report without invoking VoxCPM2.")
    args = parser.parse_args()
    if args.seed is not None and not 0 <= args.seed <= 2_147_483_647:
        raise SystemExit("--seed must be between 0 and 2147483647, or omitted")

    if args.profile_json and (args.reference_audio or args.prompt_text or args.prompt_text_file):
        raise SystemExit("Use either --profile-json or --reference-audio/--prompt-text*, not both.")
    if not args.profile_json and (args.transcript_validation_json or args.skip_strict_profile_proof):
        raise SystemExit("--transcript-validation-json and --skip-strict-profile-proof require --profile-json")
    unsafe_profile_proof_bypass_reason = args.unsafe_profile_proof_bypass_reason.strip()
    if args.profile_json and args.skip_strict_profile_proof and (
        not args.allow_unsafe_profile_proof_bypass or not unsafe_profile_proof_bypass_reason
    ):
        print(
            json.dumps(
                {
                    "status": "unsafe_profile_proof_bypass_blocked",
                    "profileJson": str(Path(args.profile_json).expanduser().resolve()),
                    "profileProofBypass": {
                        "requested": ["strict_profile_proof"],
                        "acceptedUnsafeBypass": False,
                        "reason": None,
                        "requiredFlags": [
                            "--allow-unsafe-profile-proof-bypass",
                            "--unsafe-profile-proof-bypass-reason",
                        ],
                    },
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        raise SystemExit(2)

    profile_path: Path | None = Path(args.profile_json).expanduser().resolve() if args.profile_json else None
    profile = load_profile(profile_path) if profile_path else None
    transcript_validation_json: Path | None = None
    profile_proof: dict[str, Any] | None = None

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = Path(args.report) if args.report else out_dir / "report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)

    prompt_text = "" if profile else read_prompt_text(args.prompt_text, args.prompt_text_file)

    if not profile and not args.dry_run:
        if not args.reference_audio:
            raise SystemExit("--reference-audio is required unless --dry-run is set")
        if not prompt_text:
            raise SystemExit("--prompt-text or --prompt-text-file is required unless --dry-run is set")

    reference_audio = str(Path(args.reference_audio).expanduser().resolve()) if args.reference_audio else "<reference-audio>"
    explicit_prompt_text = prompt_text or "<exact reference transcript>"

    cases = select_cases(load_eval_set(Path(args.eval_set)), args.case, args.tag, args.max_cases)
    if profile and profile_path:
        require_profile_target_scripts(cases)
        require_ready_profile(profile_path, profile)
        transcript_validation_json = (
            Path(args.transcript_validation_json).expanduser().resolve()
            if args.transcript_validation_json
            else (profile_path.parent / "transcript-validation.json").resolve()
        )
        if args.skip_strict_profile_proof:
            profile_proof = {
                "status": "unsafe_bypassed",
                "strictProfileProofRequired": False,
                "transcriptValidationJson": str(transcript_validation_json),
                "profileProofBypass": {
                    "requested": ["strict_profile_proof"],
                    "acceptedUnsafeBypass": True,
                    "reason": unsafe_profile_proof_bypass_reason,
                },
            }
        else:
            validate_profile_transcript_validation(
                profile_path=profile_path,
                profile=profile,
                transcript_validation_json=transcript_validation_json,
            )
            require_strict_ready_profile(
                profile_path=profile_path,
                profile=profile,
                transcript_validation_json=transcript_validation_json,
            )
            profile_proof = {
                "status": "strict_ready",
                "strictProfileProofRequired": True,
                "transcriptValidationJson": str(transcript_validation_json),
            }
    groups: list[dict[str, Any]] = []

    for mode in clone_modes(args.clone_mode):
        for case in cases:
            reference = reference_for_case(
                case=case,
                reference_audio=reference_audio,
                prompt_text=explicit_prompt_text,
                profile_path=profile_path,
                profile=profile,
                dry_run=args.dry_run,
            )
            renders = [
                render_case(
                    python=args.python,
                    case=case,
                    out_dir=out_dir,
                    reference_audio=reference["referenceAudio"],
                    prompt_text=reference["promptText"],
                    model_id=args.model_id,
                    quality=args.quality,
                    clone_mode=mode,
                    repeat=repeat,
                    dry_run=args.dry_run,
                    hot_worker_url=args.hot_worker_url,
                    stability_seed=args.seed,
                    profile_clip_id=reference["profileClipId"],
                    voice_profile_id=reference["voiceProfileId"],
                    profile_sha256=reference.get("profileSha256"),
                    target_coverage_features=reference.get("targetCoverageFeatures"),
                    matched_coverage_features=reference.get("matchedCoverageFeatures"),
                    target_pronunciation_preset_ids=reference.get("targetPronunciationPresetIds"),
                    matched_pronunciation_preset_ids=reference.get("matchedPronunciationPresetIds"),
                    profile_pronunciation_preset_ids=reference.get("profilePronunciationPresetIds"),
                )
                for repeat in range(1, max(1, args.repeats) + 1)
            ]
            groups.append(
                {
                    "cloneMode": mode,
                    "voiceProfileId": reference.get("voiceProfileId"),
                    "profileSha256": reference.get("profileSha256"),
                    "case": case,
                    "renders": renders,
                    "stability": {} if args.dry_run else stability_summary(renders),
                }
            )

    report = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evalSet": str(Path(args.eval_set)),
        "referenceAudio": reference_audio if not profile else None,
        "voiceProfile": {
            "path": str(profile_path),
            "voiceProfileId": profile.get("voiceProfileId"),
            "profileSha256": canonical_profile_sha256(profile),
            "referenceClipIds": profile.get("referenceClipIds"),
            "profileProof": profile_proof,
        } if profile and profile_path else None,
        "quality": args.quality,
        "stabilitySeed": args.seed,
        "cloneMode": args.clone_mode,
        "hotWorkerUrl": args.hot_worker_url or None,
        "repeats": max(1, args.repeats),
        "caseIds": [case["id"] for case in cases],
        "dryRun": args.dry_run,
        "groups": groups,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    html_path = write_html_report(report_path, report)

    payload = {"report": str(report_path), "html": str(html_path), "groups": len(groups)}
    failures = [] if args.dry_run else render_failures(groups)
    if failures:
        print(
            json.dumps(
                {
                    **payload,
                    "status": "error",
                    "failedRenders": len(failures),
                    "failures": failures[:10],
                },
                ensure_ascii=False,
            )
        )
        raise SystemExit(2)

    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()

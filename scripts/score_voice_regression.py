from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON: {path}: {exc}") from exc


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def validate_report_render_output_evidence(report: dict[str, Any], report_path: Path) -> None:
    errors: list[str] = []
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        clone_mode = str(group.get("cloneMode") or "")
        case = group.get("case") if isinstance(group.get("case"), dict) else {}
        case_id = str(case.get("id") or group.get("caseId") or "")
        group_label = f"{clone_mode}/{case_id}".strip("/") or clone_mode or case_id or "group"
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if not isinstance(render, dict) or render.get("status") != "ready":
                continue
            has_output_proof = any(key in render for key in ("outputExists", "missingOutput", "outputBytes", "outputSha256"))
            if not has_output_proof:
                continue
            repeat = render.get("repeat")
            render_label = f"{group_label}#r{repeat}" if repeat is not None else group_label
            if render.get("outputExists") is not True or render.get("missingOutput") is True:
                errors.append(f"render_output_missing:{render_label}")
            if not isinstance(render.get("outputBytes"), int) or int(render.get("outputBytes") or 0) <= 0:
                errors.append(f"render_output_bytes_missing:{render_label}")
            if not valid_sha256(render.get("outputSha256")):
                errors.append(f"render_output_sha256_missing:{render_label}")
            output_path = resolve_render_output_path(render, report_path)
            if output_path is None:
                errors.append(f"render_output_path_missing:{render_label}")
                continue
            try:
                actual_bytes = output_path.stat().st_size
                actual_sha256 = sha256_file(output_path)
            except OSError:
                errors.append(f"render_output_file_missing:{render_label}")
                continue
            if isinstance(render.get("outputBytes"), int) and int(render["outputBytes"]) != actual_bytes:
                errors.append(f"render_output_bytes_mismatch:{render_label}")
            if valid_sha256(render.get("outputSha256")) and render.get("outputSha256") != actual_sha256:
                errors.append(f"render_output_sha256_mismatch:{render_label}")
    if errors:
        raise SystemExit("report render output evidence is stale or incomplete: " + ", ".join(errors))


def is_cjk(char: str) -> bool:
    code = ord(char)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x20000 <= code <= 0x2A6DF
        or 0x2A700 <= code <= 0x2B73F
        or 0x2B740 <= code <= 0x2B81F
        or 0x2B820 <= code <= 0x2CEAF
    )


def is_word_char(char: str) -> bool:
    return char.isalnum() or is_cjk(char)


SIMPLIFIED_TO_TRADITIONAL = str.maketrans(
    {
        "这": "這",
        "个": "個",
        "专": "專",
        "为": "為",
        "与": "與",
        "对": "對",
        "国": "國",
        "语": "語",
        "声": "聲",
        "录": "錄",
        "制": "製",
        "样": "樣",
        "听": "聽",
        "说": "說",
        "读": "讀",
        "试": "試",
        "帮": "幫",
        "测": "測",
        "结": "結",
        "简": "簡",
        "报": "報",
        "错": "錯",
        "觉": "覺",
        "发": "發",
        "变": "變",
        "产": "產",
        "财": "財",
        "范": "範",
        "标": "標",
        "盘": "盤",
        "准": "準",
        "剧": "句",
        "经": "經",
        "现": "現",
        "连": "連",
        "续": "續",
        "稳": "穩",
        "数": "數",
        "质": "質",
        "够": "夠",
        "应": "應",
        "该": "該",
        "净": "淨",
        "长": "長",
        "涨": "漲",
        "乐": "樂",
        "点": "點",
        "欢": "歡",
        "银": "銀",
        "庆": "慶",
        "台": "台",
        "湾": "灣",
        "纽": "紐",
        "约": "約",
        "订": "訂",
        "单": "單",
        "编": "編",
        "号": "號",
        "请": "請",
        "复": "覆",
        "体": "體",
        "夹": "夾",
        "杂": "雜",
        "来": "來",
        "译": "譯",
        "妈": "媽",
        "骂": "罵",
        "马": "馬",
        "吗": "嗎",
        "买": "買",
        "卖": "賣",
        "难": "難",
        "没": "沒",
        "么": "麼",
    }
)
ZH_PHRASE_EQUIVALENTS = {
    "干净": "乾淨",
    "干淨": "乾淨",
}
ZH_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
ZH_DIGIT_CHARS = "".join(ZH_DIGITS)


def chinese_digits_to_int(value: str) -> int | None:
    if not value:
        return None
    if value == "十":
        return 10
    if "十" in value:
        head, _, tail = value.partition("十")
        if "十" in tail:
            return None
        tens = ZH_DIGITS.get(head, 1) if head else 1
        ones = ZH_DIGITS.get(tail, 0) if tail else 0
        return tens * 10 + ones
    digits: list[str] = []
    for char in value:
        digit = ZH_DIGITS.get(char)
        if digit is None:
            return None
        digits.append(str(digit))
    return int("".join(digits)) if digits else None


def normalize_chinese_date_numbers(text: str) -> str:
    digit_pattern = f"[{re.escape(ZH_DIGIT_CHARS)}十]+"

    def replace_year(match: re.Match[str]) -> str:
        raw = match.group(1)
        value = chinese_digits_to_int(raw)
        return f"{value}年" if value is not None and len(str(value)) == 4 else match.group(0)

    def replace_month_day(match: re.Match[str]) -> str:
        raw = match.group(1)
        suffix = match.group(2)
        value = chinese_digits_to_int(raw)
        return f"{value}{suffix}" if value is not None else match.group(0)

    text = re.sub(f"({digit_pattern})年", replace_year, text)
    text = re.sub(f"({digit_pattern})(月|日|號|号)", replace_month_day, text)
    text = re.sub(f"({digit_pattern})(點|点|時|时)", replace_month_day, text)

    def replace_latin_number(match: re.Match[str]) -> str:
        prefix = match.group(1)
        raw = match.group(2)
        value = chinese_digits_to_int(raw)
        return f"{prefix}{value}" if value is not None else match.group(0)

    text = re.sub(f"([a-z])\\s*({digit_pattern})", replace_latin_number, text)
    return text

TEXT_SCORING_POLICY = {
    "unicode": "NFKC",
    "case": "lower",
    "zhScriptEquivalence": "common_simplified_to_traditional",
    "numericEquivalence": "zh_spoken_dates_serials_and_times",
    "brandEquivalence": "common_asr_brand_variants",
    "pronunciationPresetEquivalence": "score_best_of_raw_target_and_model_facing_target",
    "asrEquivalenceAliases": "case_level_aliases_for_known_asr_text_ambiguity",
}
MAX_SPEAKER_SIMILARITY_REGRESSION = 0.03

BRAND_EQUIVALENTS = {
    # faster-whisper commonly truncates the final consonant cluster here.
    "testfly": "testflight",
}


def normalize_brand_variants(text: str) -> str:
    text = re.sub(r"(?<![a-z0-9])vox[\s,，、._-]+cpm[\s,，、._-]*2(?![a-z0-9])", "voxcpm2", text)
    for raw, canonical in BRAND_EQUIVALENTS.items():
        text = re.sub(rf"(?<![a-z0-9]){re.escape(raw)}(?![a-z0-9])", canonical, text)
    return text


def fold_zh_script_equivalence(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).lower()
    for raw, canonical in ZH_PHRASE_EQUIVALENTS.items():
        normalized = normalized.replace(raw, canonical)
    normalized = normalized.translate(SIMPLIFIED_TO_TRADITIONAL)
    for raw, canonical in ZH_PHRASE_EQUIVALENTS.items():
        normalized = normalized.replace(raw, canonical)
    normalized = normalize_chinese_date_numbers(normalized)
    return normalize_brand_variants(normalized)


def normalize_for_cer(text: str) -> list[str]:
    normalized = fold_zh_script_equivalence(text)
    return [char for char in normalized if is_word_char(char)]


def tokenize_for_wer(text: str) -> list[str]:
    normalized = fold_zh_script_equivalence(text)
    tokens: list[str] = []
    latin_buffer: list[str] = []

    def flush_latin() -> None:
        if latin_buffer:
            tokens.append("".join(latin_buffer))
            latin_buffer.clear()

    for char in normalized:
        if is_cjk(char):
            flush_latin()
            tokens.append(char)
        elif char.isalnum():
            latin_buffer.append(char)
        else:
            flush_latin()
    flush_latin()
    return tokens


def edit_distance(a: list[str], b: list[str]) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, item_a in enumerate(a, start=1):
        current = [i]
        for j, item_b in enumerate(b, start=1):
            cost = 0 if item_a == item_b else 1
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
            )
        previous = current
    return previous[-1]


def error_rate(reference: list[str], hypothesis: list[str]) -> dict[str, Any]:
    distance = edit_distance(reference, hypothesis)
    denominator = max(len(reference), 1)
    return {
        "distance": distance,
        "referenceLength": len(reference),
        "hypothesisLength": len(hypothesis),
        "rate": round(distance / denominator, 6),
    }


def target_text_candidates(render: dict[str, Any], group: dict[str, Any]) -> list[dict[str, str]]:
    case = group.get("case") if isinstance(group.get("case"), dict) else {}
    raw_target = str(case.get("text") or "")
    candidates = [{"kind": "raw", "text": raw_target}]
    text_preparation = render.get("textPreparation")
    if isinstance(text_preparation, dict):
        target_preparation = text_preparation.get("targetText")
        if isinstance(target_preparation, dict):
            model_target = target_preparation.get("model")
            if isinstance(model_target, str) and model_target and model_target != raw_target:
                candidates.append({"kind": "model", "text": model_target})
    aliases = case.get("asrEquivalenceAliases")
    if isinstance(aliases, list):
        seen = {raw_target}
        for index, alias in enumerate(aliases, start=1):
            text = ""
            if isinstance(alias, str):
                text = alias
            elif isinstance(alias, dict) and isinstance(alias.get("text"), str):
                text = alias["text"]
            text = text.strip()
            if not text or text in seen:
                continue
            seen.add(text)
            candidates.append({"kind": f"asr_alias:{index}", "text": text})
    return candidates


def score_text_candidates(
    candidates: list[dict[str, str]],
    transcript: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    scored: list[dict[str, Any]] = []
    for candidate in candidates:
        text = candidate["text"]
        cer = error_rate(normalize_for_cer(text), normalize_for_cer(transcript))
        wer = error_rate(tokenize_for_wer(text), tokenize_for_wer(transcript))
        scored.append(
            {
                "kind": candidate["kind"],
                "text": text,
                "cer": cer,
                "wer": wer,
            }
        )
    best = min(
        scored,
        key=lambda row: (
            float(row["cer"]["rate"]),
            float(row["wer"]["rate"]),
            0 if row["kind"] == "raw" else 1,
        ),
    )
    return best, scored


def transcript_from_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("transcript", "asrTranscript", "text", "hypothesis"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
    return None


def add_transcript_key(index: dict[str, str], key: str | None, transcript: str) -> None:
    if not key:
        return
    index[key] = transcript
    path = Path(key)
    index[path.name] = transcript
    try:
        index[str(path.expanduser().resolve(strict=False))] = transcript
    except RuntimeError:
        pass


def load_asr_index(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    data = load_json(path)
    if isinstance(data, dict) and "transcripts" in data:
        data = data["transcripts"]

    index: dict[str, str] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            transcript = transcript_from_value(value)
            if transcript is not None:
                add_transcript_key(index, str(key), transcript)
        return index

    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            transcript = transcript_from_value(row)
            if transcript is None:
                continue
            for key in ("outputWav", "wav", "audio", "path"):
                raw_key = row.get(key)
                if isinstance(raw_key, str):
                    add_transcript_key(index, raw_key, transcript)
            case_id = row.get("caseId") or row.get("case")
            clone_mode = row.get("cloneMode")
            repeat = row.get("repeat")
            if isinstance(case_id, str):
                add_transcript_key(index, case_id, transcript)
                if repeat is not None:
                    add_transcript_key(index, f"{case_id}#{repeat}", transcript)
                    add_transcript_key(index, f"{case_id}:r{int(repeat):02d}", transcript)
                if isinstance(clone_mode, str):
                    add_transcript_key(index, f"{clone_mode}/{case_id}", transcript)
                    if repeat is not None:
                        add_transcript_key(index, f"{clone_mode}/{case_id}/r{int(repeat):02d}", transcript)
        return index

    raise SystemExit(f"unsupported ASR JSON shape: {path}")


def similarity_from_value(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        for key in ("speakerSimilarity", "similarity", "cosine", "score"):
            candidate = value.get(key)
            if isinstance(candidate, (int, float)):
                return float(candidate)
    return None


def add_similarity_key(index: dict[str, float], key: str | None, similarity: float) -> None:
    if not key:
        return
    index[key] = similarity
    path = Path(key)
    index[path.name] = similarity
    try:
        index[str(path.expanduser().resolve(strict=False))] = similarity
    except RuntimeError:
        pass


def load_speaker_similarity_index(path: Path | None) -> dict[str, float]:
    if path is None:
        return {}
    data = load_json(path)
    if isinstance(data, dict) and "similarities" in data:
        data = data["similarities"]

    index: dict[str, float] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            similarity = similarity_from_value(value)
            if similarity is not None:
                add_similarity_key(index, str(key), similarity)
        return index

    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            similarity = similarity_from_value(row)
            if similarity is None:
                continue
            for key in ("outputWav", "wav", "audio", "path"):
                raw_key = row.get(key)
                if isinstance(raw_key, str):
                    add_similarity_key(index, raw_key, similarity)
            case_id = row.get("caseId") or row.get("case")
            clone_mode = row.get("cloneMode")
            repeat = row.get("repeat")
            if isinstance(case_id, str):
                add_similarity_key(index, case_id, similarity)
                if repeat is not None:
                    add_similarity_key(index, f"{case_id}#{repeat}", similarity)
                    add_similarity_key(index, f"{case_id}:r{int(repeat):02d}", similarity)
                if isinstance(clone_mode, str):
                    add_similarity_key(index, f"{clone_mode}/{case_id}", similarity)
                    if repeat is not None:
                        add_similarity_key(index, f"{clone_mode}/{case_id}/r{int(repeat):02d}", similarity)
        return index

    raise SystemExit(f"unsupported speaker similarity JSON shape: {path}")


def profile_similarity_from_value(value: Any) -> float | None:
    if isinstance(value, dict):
        candidate = value.get("profileSpeakerSimilarityMin")
        if isinstance(candidate, (int, float)):
            return float(candidate)
    return None


def load_profile_speaker_similarity_index(path: Path | None) -> dict[str, float]:
    if path is None:
        return {}
    data = load_json(path)
    if isinstance(data, dict) and "similarities" in data:
        data = data["similarities"]

    index: dict[str, float] = {}
    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            similarity = profile_similarity_from_value(row)
            if similarity is None:
                continue
            for key in ("outputWav", "wav", "audio", "path"):
                raw_key = row.get(key)
                if isinstance(raw_key, str):
                    add_similarity_key(index, raw_key, similarity)
            case_id = row.get("caseId") or row.get("case")
            clone_mode = row.get("cloneMode")
            repeat = row.get("repeat")
            if isinstance(case_id, str):
                add_similarity_key(index, case_id, similarity)
                if repeat is not None:
                    add_similarity_key(index, f"{case_id}#{repeat}", similarity)
                    add_similarity_key(index, f"{case_id}:r{int(repeat):02d}", similarity)
                if isinstance(clone_mode, str):
                    add_similarity_key(index, f"{clone_mode}/{case_id}", similarity)
                    if repeat is not None:
                        add_similarity_key(index, f"{clone_mode}/{case_id}/r{int(repeat):02d}", similarity)
        return index
    if isinstance(data, dict):
        return index
    raise SystemExit(f"unsupported speaker similarity JSON shape: {path}")


def find_transcript(render: dict[str, Any], group: dict[str, Any], asr_index: dict[str, str]) -> str | None:
    inline = transcript_from_value(render.get("asrTranscript"))
    if inline is not None:
        return inline
    transcript_file = render.get("asrTranscriptFile")
    if isinstance(transcript_file, str):
        file_path = Path(transcript_file)
        if file_path.exists():
            return file_path.read_text(encoding="utf-8").strip()

    case = group.get("case") if isinstance(group.get("case"), dict) else {}
    case_id = str(case.get("id") or render.get("caseId") or "")
    clone_mode = str(group.get("cloneMode") or render.get("cloneMode") or "")
    repeat = render.get("repeat")
    output_wav = str(render.get("outputWav") or "")
    keys = [
        output_wav,
        Path(output_wav).name if output_wav else "",
        str(Path(output_wav).expanduser().resolve(strict=False)) if output_wav else "",
        f"{clone_mode}/{case_id}/r{int(repeat):02d}" if clone_mode and case_id and repeat is not None else "",
        f"{case_id}:r{int(repeat):02d}" if case_id and repeat is not None else "",
        f"{case_id}#{repeat}" if case_id and repeat is not None else "",
        f"{clone_mode}/{case_id}" if clone_mode and case_id else "",
        case_id,
    ]
    for key in keys:
        if key and key in asr_index:
            return asr_index[key]
    return None


def find_speaker_similarity(render: dict[str, Any], group: dict[str, Any], speaker_index: dict[str, float]) -> float | None:
    if not speaker_index:
        return None
    case = group.get("case") if isinstance(group.get("case"), dict) else {}
    case_id = str(case.get("id") or render.get("caseId") or "")
    clone_mode = str(group.get("cloneMode") or render.get("cloneMode") or "")
    repeat = render.get("repeat")
    output_wav = str(render.get("outputWav") or "")
    keys = [
        output_wav,
        Path(output_wav).name if output_wav else "",
        str(Path(output_wav).expanduser().resolve(strict=False)) if output_wav else "",
        f"{clone_mode}/{case_id}/r{int(repeat):02d}" if clone_mode and case_id and repeat is not None else "",
        f"{case_id}:r{int(repeat):02d}" if case_id and repeat is not None else "",
        f"{case_id}#{repeat}" if case_id and repeat is not None else "",
        f"{clone_mode}/{case_id}" if clone_mode and case_id else "",
        case_id,
    ]
    for key in keys:
        if key and key in speaker_index:
            return speaker_index[key]
    return None


def find_profile_speaker_similarity(render: dict[str, Any], group: dict[str, Any], speaker_index: dict[str, float]) -> float | None:
    return find_speaker_similarity(render, group, speaker_index)


def score_render(
    render: dict[str, Any],
    group: dict[str, Any],
    asr_index: dict[str, str],
    speaker_index: dict[str, float],
    profile_speaker_index: dict[str, float],
) -> dict[str, Any]:
    case = group.get("case") if isinstance(group.get("case"), dict) else {}
    transcript = find_transcript(render, group, asr_index)
    speaker_similarity = find_speaker_similarity(render, group, speaker_index)
    profile_speaker_similarity = find_profile_speaker_similarity(render, group, profile_speaker_index)
    row: dict[str, Any] = {
        "cloneMode": group.get("cloneMode"),
        "caseId": case.get("id") or render.get("caseId"),
        "repeat": render.get("repeat"),
        "outputWav": render.get("outputWav"),
        "voiceProfileId": render.get("voiceProfileId"),
        "profileSha256": render.get("profileSha256"),
        "profileClipId": render.get("profileClipId"),
        "referenceAudio": render.get("referenceAudio"),
        "status": render.get("status"),
        "externalBackend": render.get("externalBackend") is True,
        "hasAsr": transcript is not None,
        "hasSpeakerSimilarity": speaker_similarity is not None,
    }
    for key in ("outputExists", "missingOutput", "outputBytes", "outputSha256", "rendererStatus"):
        if key in render:
            row[key] = render.get(key)
    if isinstance(render.get("renderSeconds"), (int, float)):
        row["renderSeconds"] = round(float(render["renderSeconds"]), 3)
    if isinstance(render.get("audioMetrics"), dict):
        row["audioMetrics"] = render["audioMetrics"]
    for key in (
        "targetPronunciationPresetIds",
        "matchedPronunciationPresetIds",
        "profilePronunciationPresetIds",
        "targetCoverageFeatures",
        "matchedCoverageFeatures",
    ):
        if isinstance(render.get(key), list):
            row[key] = [str(item) for item in render[key] if isinstance(item, str)]
    if speaker_similarity is not None:
        row["speakerSimilarity"] = round(speaker_similarity, 6)
        row["speakerSimilarityForVerdict"] = round(speaker_similarity, 6)
    if profile_speaker_similarity is not None:
        row["profileSpeakerSimilarityMin"] = round(profile_speaker_similarity, 6)
        if "speakerSimilarityForVerdict" not in row:
            row["speakerSimilarityForVerdict"] = round(profile_speaker_similarity, 6)
    if transcript is None:
        row["pronunciationVerdict"] = "missing_asr"
        return row

    best_target, target_scores = score_text_candidates(target_text_candidates(render, group), transcript)
    row.update(
        {
            "asrTranscript": transcript,
            "scoringTarget": {
                "kind": best_target["kind"],
                "text": best_target["text"],
            },
            "targetCandidates": target_scores,
            "cer": best_target["cer"],
            "wer": best_target["wer"],
        }
    )
    return row


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value if isinstance(item, str)] if isinstance(value, list) else []


def profile_reference_verdict(renders: list[dict[str, Any]]) -> dict[str, Any]:
    missing_by_render: list[dict[str, Any]] = []
    covered_by_profile_only: list[dict[str, Any]] = []
    evaluated = 0
    for render in renders:
        target_ids = string_list(render.get("targetPronunciationPresetIds"))
        if not target_ids:
            continue
        evaluated += 1
        matched_ids = set(string_list(render.get("matchedPronunciationPresetIds")))
        profile_ids = set(string_list(render.get("profilePronunciationPresetIds")))
        missing = [
            preset_id
            for preset_id in target_ids
            if preset_id not in matched_ids and (not profile_ids or preset_id not in profile_ids)
        ]
        profile_only = [
            preset_id
            for preset_id in target_ids
            if preset_id not in matched_ids and profile_ids and preset_id in profile_ids
        ]
        if missing:
            missing_by_render.append(
                {
                    "caseId": render.get("caseId"),
                    "repeat": render.get("repeat"),
                    "profileClipId": render.get("profileClipId"),
                    "missingPronunciationPresetIds": missing,
                }
            )
        if profile_only:
            covered_by_profile_only.append(
                {
                    "caseId": render.get("caseId"),
                    "repeat": render.get("repeat"),
                    "profileClipId": render.get("profileClipId"),
                    "profileCoveredPronunciationPresetIds": profile_only,
                }
            )

    if evaluated == 0:
        return {
            "verdict": "not_evaluated",
            "evaluatedRenders": 0,
            "missingByRender": [],
            "coveredByProfileOnly": [],
        }
    return {
        "verdict": "pass" if not missing_by_render else "review",
        "evaluatedRenders": evaluated,
        "missingByRender": missing_by_render,
        "coveredByProfileOnly": covered_by_profile_only,
    }


def average(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def verdict_from_thresholds(
    *,
    avg_cer: float | None,
    avg_wer: float | None,
    matched_renders: int,
    total_renders: int,
    max_cer: float,
    max_wer: float,
) -> str:
    if total_renders == 0:
        return "review"
    if matched_renders == 0:
        return "missing_asr"
    if matched_renders < total_renders:
        return "review"
    if avg_cer is None or avg_wer is None:
        return "review"
    if avg_cer <= max_cer and avg_wer <= max_wer:
        return "pass"
    return "review"


def stability_verdict(
    group: dict[str, Any],
    max_duration_span_pct: float,
    max_rms_span_db: float,
    min_waveform_corr: float,
    min_successful_repeats: int,
) -> dict[str, Any]:
    raw = group.get("stability")
    if not isinstance(raw, dict) or not raw:
        return {
            "verdict": "review",
            "reasons": ["missing_stability_metrics"],
        }

    reasons: list[str] = []
    renders = group.get("renders") if isinstance(group.get("renders"), list) else []
    successful_repeat_ids = {
        render.get("repeat")
        for render in renders
        if isinstance(render, dict)
        and render.get("status") == "ready"
        and isinstance(render.get("audioMetrics"), dict)
        and render["audioMetrics"].get("available") is not False
    }
    successful_repeat_ids.discard(None)
    successful_repeats = len(successful_repeat_ids)
    if successful_repeats < min_successful_repeats:
        reasons.append("too_few_successful_repeats")

    duration = raw.get("durationSpanPct")
    rms = raw.get("rmsSpanDb")
    corr = raw.get("minPairwiseWaveformCorr")
    if not isinstance(duration, (int, float)):
        reasons.append("missing_duration_span_pct")
    elif float(duration) > max_duration_span_pct:
        reasons.append("duration_varies")
    if not isinstance(rms, (int, float)):
        reasons.append("missing_rms_span_db")
    elif float(rms) > max_rms_span_db:
        reasons.append("loudness_varies")
    if not isinstance(corr, (int, float)):
        reasons.append("missing_waveform_correlation")
    elif float(corr) < min_waveform_corr:
        reasons.append("waveform_varies")
    if raw.get("verdict") == "review" and not reasons:
        raw_reasons = raw.get("reviewReasons")
        if isinstance(raw_reasons, list):
            reasons.extend(str(reason) for reason in raw_reasons)
        elif isinstance(raw.get("reason"), str):
            reasons.append(str(raw["reason"]))

    return {
        "verdict": "review" if reasons else "pass",
        "reasons": reasons,
        "durationSpanPct": duration,
        "rmsSpanDb": rms,
        "minPairwiseWaveformCorr": corr,
        "successfulRepeats": successful_repeats,
        "minSuccessfulRepeats": min_successful_repeats,
    }


def speaker_similarity_verdict(
    render_scores: list[dict[str, Any]],
    min_speaker_similarity: float,
    require_speaker_similarity: bool,
    require_profile_reference_similarity: bool,
) -> dict[str, Any]:
    values = [
        float(row.get("speakerSimilarityForVerdict", row.get("speakerSimilarity")))
        for row in render_scores
        if isinstance(row.get("speakerSimilarityForVerdict", row.get("speakerSimilarity")), (int, float))
    ]
    if not values and not require_speaker_similarity:
        return {
            "verdict": "not_evaluated",
            "reason": "no_speaker_similarity_json",
            "minSpeakerSimilarity": min_speaker_similarity,
        }
    if not values:
        return {
            "verdict": "missing_speaker_similarity",
            "reason": "no_matched_speaker_scores",
            "minSpeakerSimilarity": min_speaker_similarity,
        }

    avg_similarity = average(values)
    min_similarity = round(min(values), 6)
    missing = max(0, len(render_scores) - len(values))
    reasons: list[str] = []
    if missing:
        reasons.append("missing_render_similarity")
    profile_reference_evaluated = sum(
        1 for row in render_scores if isinstance(row.get("profileSpeakerSimilarityMin"), (int, float))
    )
    if require_profile_reference_similarity and profile_reference_evaluated < len(render_scores):
        reasons.append("missing_profile_reference_similarity")
    if min_similarity < min_speaker_similarity:
        reasons.append("speaker_similarity_below_threshold")

    return {
        "verdict": "pass" if not reasons else "review",
        "reasons": reasons,
        "avgSpeakerSimilarity": avg_similarity,
        "minSpeakerSimilarityObserved": min_similarity,
        "minSpeakerSimilarity": min_speaker_similarity,
        "matchedRenders": len(values),
        "totalRenders": len(render_scores),
        "profileReferenceEvaluatedRenders": profile_reference_evaluated,
        "requireProfileReferenceSimilarity": require_profile_reference_similarity,
    }


def audio_quality_verdict(render_scores: list[dict[str, Any]], max_clipping_ratio: float) -> dict[str, Any]:
    missing_metrics: list[dict[str, Any]] = []
    missing_clipping: list[dict[str, Any]] = []
    clipped: list[dict[str, Any]] = []
    clipping_values: list[float] = []
    for row in render_scores:
        label = {"caseId": row.get("caseId"), "repeat": row.get("repeat"), "cloneMode": row.get("cloneMode")}
        metrics = row.get("audioMetrics") if isinstance(row.get("audioMetrics"), dict) else None
        if not metrics or metrics.get("available") is not True:
            missing_metrics.append(label)
            continue
        clipping = metrics.get("clippingRatio")
        if not isinstance(clipping, (int, float)):
            missing_clipping.append(label)
            continue
        clipping_value = float(clipping)
        clipping_values.append(clipping_value)
        if clipping_value > max_clipping_ratio:
            clipped.append({**label, "clippingRatio": round(clipping_value, 6)})

    reasons: list[str] = []
    if missing_metrics:
        reasons.append("missing_audio_metrics")
    if missing_clipping:
        reasons.append("missing_clipping_ratio")
    if clipped:
        reasons.append("clipping_above_threshold")
    return {
        "verdict": "pass" if not reasons else "review",
        "reasons": reasons,
        "maxClippingRatio": round(max(clipping_values), 6) if clipping_values else None,
        "maxAllowedClippingRatio": max_clipping_ratio,
        "missingMetrics": missing_metrics,
        "missingClippingRatio": missing_clipping,
        "clippedRenders": clipped,
        "evaluatedRenders": len(clipping_values),
        "totalRenders": len(render_scores),
    }


def score_group(
    group: dict[str, Any],
    asr_index: dict[str, str],
    speaker_index: dict[str, float],
    profile_speaker_index: dict[str, float],
    args: argparse.Namespace,
) -> dict[str, Any]:
    renders = [row for row in group.get("renders", []) if isinstance(row, dict)]
    render_scores = [score_render(render, group, asr_index, speaker_index, profile_speaker_index) for render in renders]
    cer_values = [
        float(row["cer"]["rate"])
        for row in render_scores
        if isinstance(row.get("cer"), dict) and isinstance(row["cer"].get("rate"), (int, float))
    ]
    wer_values = [
        float(row["wer"]["rate"])
        for row in render_scores
        if isinstance(row.get("wer"), dict) and isinstance(row["wer"].get("rate"), (int, float))
    ]
    avg_cer = average(cer_values)
    avg_wer = average(wer_values)
    render_seconds_values = [
        float(row["renderSeconds"])
        for row in render_scores
        if isinstance(row.get("renderSeconds"), (int, float))
    ]
    avg_render_seconds = average(render_seconds_values)
    pronunciation_verdict = verdict_from_thresholds(
        avg_cer=avg_cer,
        avg_wer=avg_wer,
        matched_renders=len(cer_values),
        total_renders=len(render_scores),
        max_cer=args.max_cer,
        max_wer=args.max_wer,
    )
    stability = stability_verdict(
        group,
        args.max_duration_span_pct,
        args.max_rms_span_db,
        args.min_waveform_corr,
        args.min_stability_repeats,
    )
    speaker_identity = speaker_similarity_verdict(
        render_scores,
        args.min_speaker_similarity,
        args.require_speaker_similarity,
        args.require_profile_reference_similarity,
    )
    speaker_blocks = speaker_identity["verdict"] not in {"pass", "not_evaluated"}
    audio_quality = audio_quality_verdict(render_scores, args.max_clipping_ratio)
    audio_quality_blocks = audio_quality["verdict"] != "pass"
    profile_reference = profile_reference_verdict(renders)
    profile_reference_blocks = profile_reference["verdict"] == "review"
    verdict = (
        "pass"
        if pronunciation_verdict == "pass"
        and stability["verdict"] == "pass"
        and not speaker_blocks
        and not audio_quality_blocks
        and not profile_reference_blocks
        else "review"
    )
    if pronunciation_verdict == "missing_asr":
        verdict = "missing_asr"

    case = group.get("case") if isinstance(group.get("case"), dict) else {}
    return {
        "cloneMode": group.get("cloneMode"),
        "caseId": case.get("id"),
        "voiceProfileId": next(
            (str(render.get("voiceProfileId")) for render in renders if isinstance(render.get("voiceProfileId"), str)),
            None,
        ),
        "profileSha256": next(
            (str(render.get("profileSha256")) for render in renders if isinstance(render.get("profileSha256"), str)),
            None,
        ),
        "locale": case.get("locale"),
        "tags": case.get("tags"),
        "renderCount": len(render_scores),
        "asrMatchedRenders": len(cer_values),
        "pronunciationVerdict": pronunciation_verdict,
        "stabilityVerdict": stability["verdict"],
        "speakerIdentityVerdict": speaker_identity["verdict"],
        "audioQualityVerdict": audio_quality["verdict"],
        "profileReferenceVerdict": profile_reference["verdict"],
        "verdict": verdict,
        "avgCer": avg_cer,
        "maxCer": max(cer_values) if cer_values else None,
        "avgWer": avg_wer,
        "maxWer": max(wer_values) if wer_values else None,
        "avgRenderSeconds": avg_render_seconds,
        "maxRenderSeconds": max(render_seconds_values) if render_seconds_values else None,
        "stability": stability,
        "speakerIdentity": speaker_identity,
        "audioQuality": audio_quality,
        "profileReference": profile_reference,
        "renders": render_scores,
    }


def relative_reduction(baseline: float | None, current: float | None) -> float | None:
    if baseline is None or current is None:
        return None
    if baseline <= 0:
        return None
    return round((baseline - current) / baseline * 100.0, 3)


def relative_regression(baseline: float | None, current: float | None) -> float | None:
    if baseline is None or current is None:
        return None
    if baseline <= 0:
        return None
    return round((current - baseline) / baseline * 100.0, 3)


def aggregate(groups: list[dict[str, Any]]) -> dict[str, Any]:
    cer_values = [float(group["avgCer"]) for group in groups if isinstance(group.get("avgCer"), (int, float))]
    wer_values = [float(group["avgWer"]) for group in groups if isinstance(group.get("avgWer"), (int, float))]
    speaker_values = [
        float(identity["avgSpeakerSimilarity"])
        for group in groups
        for identity in [group.get("speakerIdentity")]
        if isinstance(identity, dict) and isinstance(identity.get("avgSpeakerSimilarity"), (int, float))
    ]
    render_seconds_values = [
        float(group["avgRenderSeconds"])
        for group in groups
        if isinstance(group.get("avgRenderSeconds"), (int, float))
    ]
    return {
        "groups": len(groups),
        "passingGroups": sum(1 for group in groups if group.get("verdict") == "pass"),
        "missingAsrGroups": sum(1 for group in groups if group.get("pronunciationVerdict") == "missing_asr"),
        "stabilityReviewGroups": sum(1 for group in groups if group.get("stabilityVerdict") != "pass"),
        "speakerReviewGroups": sum(1 for group in groups if group.get("speakerIdentityVerdict") not in {"pass", "not_evaluated"}),
        "audioQualityReviewGroups": sum(1 for group in groups if group.get("audioQualityVerdict") != "pass"),
        "profileReferenceReviewGroups": sum(1 for group in groups if group.get("profileReferenceVerdict") == "review"),
        "speakerEvaluatedGroups": sum(1 for group in groups if group.get("speakerIdentityVerdict") != "not_evaluated"),
        "avgSpeakerSimilarity": average(speaker_values),
        "avgCer": average(cer_values),
        "avgWer": average(wer_values),
        "avgRenderSeconds": average(render_seconds_values),
    }


def compare_to_baseline(current: dict[str, Any], baseline_score: dict[str, Any], min_reduction_pct: float) -> dict[str, Any]:
    current_summary = current.get("summary") if isinstance(current.get("summary"), dict) else {}
    baseline_summary = baseline_score.get("summary") if isinstance(baseline_score.get("summary"), dict) else {}
    cer_reduction = relative_reduction(
        baseline_summary.get("avgCer") if isinstance(baseline_summary.get("avgCer"), (int, float)) else None,
        current_summary.get("avgCer") if isinstance(current_summary.get("avgCer"), (int, float)) else None,
    )
    wer_reduction = relative_reduction(
        baseline_summary.get("avgWer") if isinstance(baseline_summary.get("avgWer"), (int, float)) else None,
        current_summary.get("avgWer") if isinstance(current_summary.get("avgWer"), (int, float)) else None,
    )
    reductions = [value for value in (cer_reduction, wer_reduction) if value is not None]
    verdict = "review"
    if reductions and all(value >= min_reduction_pct for value in reductions):
        verdict = "pass"
    return {
        "verdict": verdict,
        "minReductionPct": min_reduction_pct,
        "cerReductionPct": cer_reduction,
        "werReductionPct": wer_reduction,
        "baselineAvgCer": baseline_summary.get("avgCer"),
        "currentAvgCer": current_summary.get("avgCer"),
        "baselineAvgWer": baseline_summary.get("avgWer"),
        "currentAvgWer": current_summary.get("avgWer"),
    }


def paired_clone_mode_comparison(
    groups: list[dict[str, Any]],
    baseline_clone_mode: str,
    candidate_clone_mode: str,
    min_reduction_pct: float,
    max_latency_regression_pct: float,
) -> dict[str, Any]:
    by_mode_case = {
        (str(group.get("cloneMode") or ""), str(group.get("caseId") or "")): group
        for group in groups
        if group.get("caseId")
    }
    case_ids = sorted({
        str(group.get("caseId"))
        for group in groups
        if group.get("caseId") and group.get("cloneMode") in {baseline_clone_mode, candidate_clone_mode}
    })
    pairs: list[dict[str, Any]] = []
    for case_id in case_ids:
        baseline = by_mode_case.get((baseline_clone_mode, case_id))
        candidate = by_mode_case.get((candidate_clone_mode, case_id))
        row: dict[str, Any] = {
            "caseId": case_id,
            "baselineCloneMode": baseline_clone_mode,
            "candidateCloneMode": candidate_clone_mode,
            "verdict": "review",
            "reasons": [],
        }
        reasons = row["reasons"]
        if baseline is None:
            reasons.append("missing_baseline_group")
        if candidate is None:
            reasons.append("missing_candidate_group")
        if baseline is None or candidate is None:
            pairs.append(row)
            continue

        candidate_verdict = candidate.get("verdict")
        if candidate_verdict != "pass":
            reasons.append("candidate_group_not_pass")

        baseline_cer = baseline.get("avgCer") if isinstance(baseline.get("avgCer"), (int, float)) else None
        candidate_cer = candidate.get("avgCer") if isinstance(candidate.get("avgCer"), (int, float)) else None
        baseline_wer = baseline.get("avgWer") if isinstance(baseline.get("avgWer"), (int, float)) else None
        candidate_wer = candidate.get("avgWer") if isinstance(candidate.get("avgWer"), (int, float)) else None
        cer_reduction = relative_reduction(baseline_cer, candidate_cer)
        wer_reduction = relative_reduction(baseline_wer, candidate_wer)
        cer_regressed = (
            baseline_cer is not None
            and candidate_cer is not None
            and candidate_cer > baseline_cer
        )
        wer_regressed = (
            baseline_wer is not None
            and candidate_wer is not None
            and candidate_wer > baseline_wer
        )
        if baseline_cer is None or candidate_cer is None:
            reasons.append("cer_delta_not_measurable")
        elif cer_regressed:
            reasons.append("cer_regressed")
        elif cer_reduction is None:
            reasons.append("cer_baseline_at_ceiling")
        elif cer_reduction < min_reduction_pct:
            reasons.append("cer_reduction_below_threshold")
        if baseline_wer is None or candidate_wer is None:
            reasons.append("wer_delta_not_measurable")
        elif wer_regressed:
            reasons.append("wer_regressed")
        elif wer_reduction is None:
            reasons.append("wer_baseline_at_ceiling")
        elif wer_reduction < min_reduction_pct:
            reasons.append("wer_reduction_below_threshold")

        baseline_identity = baseline.get("speakerIdentity") if isinstance(baseline.get("speakerIdentity"), dict) else {}
        candidate_identity = candidate.get("speakerIdentity") if isinstance(candidate.get("speakerIdentity"), dict) else {}
        baseline_speaker = baseline_identity.get("avgSpeakerSimilarity")
        candidate_speaker = candidate_identity.get("avgSpeakerSimilarity")
        speaker_delta = None
        if isinstance(baseline_speaker, (int, float)) and isinstance(candidate_speaker, (int, float)):
            speaker_delta = round(float(candidate_speaker) - float(baseline_speaker), 6)
            if speaker_delta < -MAX_SPEAKER_SIMILARITY_REGRESSION:
                reasons.append("speaker_similarity_materially_regressed")
        else:
            reasons.append("speaker_similarity_delta_not_measurable")

        baseline_latency = baseline.get("avgRenderSeconds") if isinstance(baseline.get("avgRenderSeconds"), (int, float)) else None
        candidate_latency = candidate.get("avgRenderSeconds") if isinstance(candidate.get("avgRenderSeconds"), (int, float)) else None
        latency_regression = relative_regression(baseline_latency, candidate_latency)
        latency_verdict = "pass"
        if latency_regression is None:
            latency_verdict = "review"
            reasons.append("latency_not_measurable")
        elif latency_regression > max_latency_regression_pct:
            latency_verdict = "review"
            reasons.append("latency_regressed")

        pair_blocking_reasons = [
            reason
            for reason in reasons
            if reason
            not in {
                "cer_baseline_at_ceiling",
                "wer_baseline_at_ceiling",
                "cer_reduction_below_threshold",
                "wer_reduction_below_threshold",
                "latency_regressed",
            }
        ]
        row.update(
            {
                "baselineAvgCer": baseline_cer,
                "candidateAvgCer": candidate_cer,
                "candidateGroupVerdict": candidate_verdict,
                "cerReductionPct": cer_reduction,
                "baselineAvgWer": baseline_wer,
                "candidateAvgWer": candidate_wer,
                "werReductionPct": wer_reduction,
                "speakerSimilarityDelta": speaker_delta,
                "baselineAvgRenderSeconds": baseline_latency,
                "candidateAvgRenderSeconds": candidate_latency,
                "latencyRegressionPct": latency_regression,
                "maxLatencyRegressionPct": max_latency_regression_pct,
                "latencyVerdict": latency_verdict,
                "verdict": "pass" if not pair_blocking_reasons else "review",
                "blockingReasons": pair_blocking_reasons,
            }
        )
        pairs.append(row)

    cer_reductions = [float(row["cerReductionPct"]) for row in pairs if isinstance(row.get("cerReductionPct"), (int, float))]
    wer_reductions = [float(row["werReductionPct"]) for row in pairs if isinstance(row.get("werReductionPct"), (int, float))]
    latency_regressions = [
        float(row["latencyRegressionPct"])
        for row in pairs
        if isinstance(row.get("latencyRegressionPct"), (int, float))
    ]
    speaker_deltas = [
        float(row["speakerSimilarityDelta"])
        for row in pairs
        if isinstance(row.get("speakerSimilarityDelta"), (int, float))
    ]
    candidate_failures = [
        row for row in pairs if row.get("candidateGroupVerdict") != "pass"
    ]
    blocking_pairs = [
        row for row in pairs if row.get("blockingReasons")
    ]
    cer_regressed_pairs = [
        row for row in pairs if "cer_regressed" in row.get("blockingReasons", [])
    ]
    wer_regressed_pairs = [
        row for row in pairs if "wer_regressed" in row.get("blockingReasons", [])
    ]
    materially_speaker_regressed_pairs = [
        row for row in pairs if "speaker_similarity_materially_regressed" in row.get("blockingReasons", [])
    ]
    avg_cer_reduction = average(cer_reductions)
    avg_wer_reduction = average(wer_reductions)
    avg_latency_regression = average(latency_regressions)
    avg_speaker_delta = average(speaker_deltas)
    aggregate_reasons: list[str] = []
    if not pairs:
        aggregate_reasons.append("no_pairs")
    if candidate_failures:
        aggregate_reasons.append("candidate_group_not_pass")
    if len(speaker_deltas) < len(pairs):
        aggregate_reasons.append("speaker_similarity_delta_not_measurable")
    if materially_speaker_regressed_pairs or (
        avg_speaker_delta is not None and avg_speaker_delta < -MAX_SPEAKER_SIMILARITY_REGRESSION
    ):
        aggregate_reasons.append("speaker_similarity_materially_regressed")
    if cer_regressed_pairs:
        aggregate_reasons.append("cer_regressed")
    if wer_regressed_pairs:
        aggregate_reasons.append("wer_regressed")
    if avg_latency_regression is None:
        aggregate_reasons.append("latency_not_measurable")
    elif avg_latency_regression > max_latency_regression_pct:
        aggregate_reasons.append("latency_regressed")
    reduction_metrics = [
        value
        for value in (avg_cer_reduction, avg_wer_reduction)
        if isinstance(value, (int, float))
    ]
    if not reduction_metrics:
        aggregate_reasons.append("paired_reduction_not_measurable")
    elif max(reduction_metrics) < min_reduction_pct:
        aggregate_reasons.append("paired_reduction_below_threshold")
    verdict = "pass" if pairs and not aggregate_reasons else "review"
    return {
        "verdict": verdict,
        "reasons": aggregate_reasons,
        "baselineCloneMode": baseline_clone_mode,
        "candidateCloneMode": candidate_clone_mode,
        "minReductionPct": min_reduction_pct,
        "pairs": pairs,
        "summary": {
            "pairs": len(pairs),
            "passingPairs": sum(1 for row in pairs if row.get("verdict") == "pass"),
            "reviewPairs": sum(1 for row in pairs if row.get("verdict") != "pass"),
            "blockingPairs": len(blocking_pairs),
            "avgCerReductionPct": avg_cer_reduction,
            "avgWerReductionPct": avg_wer_reduction,
            "avgLatencyRegressionPct": avg_latency_regression,
            "avgSpeakerSimilarityDelta": avg_speaker_delta,
        },
    }


def final_verdict(
    groups: list[dict[str, Any]],
    baseline: dict[str, Any] | None,
    paired_comparison: dict[str, Any] | None,
    require_paired_improvement: bool,
) -> str:
    verdict_groups = groups
    if require_paired_improvement and paired_comparison:
        baseline_mode = paired_comparison.get("baselineCloneMode")
        verdict_groups = [group for group in groups if group.get("cloneMode") != baseline_mode]

    if not verdict_groups:
        return "review"
    if any(group.get("pronunciationVerdict") == "missing_asr" for group in verdict_groups):
        return "review"
    if any(group.get("verdict") != "pass" for group in verdict_groups):
        return "review"
    if baseline and baseline.get("verdict") != "pass":
        return "review"
    if require_paired_improvement and (not paired_comparison or paired_comparison.get("verdict") != "pass"):
        return "review"
    return "pass"


def report_requires_profile_reference_similarity(report: dict[str, Any]) -> bool:
    voice_profile = report.get("voiceProfile")
    if isinstance(voice_profile, dict) and str(voice_profile.get("voiceProfileId") or "").strip():
        return True
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if isinstance(group.get("voiceProfileId"), str) and str(group.get("voiceProfileId") or "").strip():
            return True
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render in renders:
            if isinstance(render, dict) and isinstance(render.get("voiceProfileId"), str) and str(render.get("voiceProfileId") or "").strip():
                return True
    return False


def validate_report_profile_binding(report: dict[str, Any]) -> dict[str, str] | None:
    voice_profile = report.get("voiceProfile") if isinstance(report.get("voiceProfile"), dict) else {}
    ids = {str(voice_profile.get("voiceProfileId") or "").strip()} if voice_profile.get("voiceProfileId") else set()
    hashes = {str(voice_profile.get("profileSha256") or "").strip()} if voice_profile.get("profileSha256") else set()
    groups = report.get("groups") if isinstance(report.get("groups"), list) else []
    for group in groups:
        if not isinstance(group, dict):
            continue
        if group.get("voiceProfileId"):
            ids.add(str(group.get("voiceProfileId") or "").strip())
        if group.get("profileSha256"):
            hashes.add(str(group.get("profileSha256") or "").strip())
        for render in group.get("renders") if isinstance(group.get("renders"), list) else []:
            if not isinstance(render, dict):
                continue
            if render.get("voiceProfileId"):
                ids.add(str(render.get("voiceProfileId") or "").strip())
            if render.get("profileSha256"):
                hashes.add(str(render.get("profileSha256") or "").strip())
    ids.discard("")
    hashes.discard("")
    if not ids and not hashes:
        return None
    if len(ids) != 1 or len(hashes) != 1:
        raise SystemExit("profile-bound report has mixed or incomplete voiceProfileId/profileSha256 evidence")

    expected = {"voiceProfileId": next(iter(ids)), "profileSha256": next(iter(hashes))}
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict):
            continue
        if group.get("voiceProfileId") and group.get("voiceProfileId") != expected["voiceProfileId"]:
            raise SystemExit(f"profile-bound report group {group_index} voiceProfileId does not match report profile")
        if group.get("profileSha256") and group.get("profileSha256") != expected["profileSha256"]:
            raise SystemExit(f"profile-bound report group {group_index} profileSha256 does not match report profile")
        renders = group.get("renders") if isinstance(group.get("renders"), list) else []
        for render_index, render in enumerate(renders):
            if not isinstance(render, dict):
                continue
            if render.get("voiceProfileId") != expected["voiceProfileId"]:
                raise SystemExit(
                    f"profile-bound report group {group_index} render {render_index} voiceProfileId does not match report profile"
                )
            if render.get("profileSha256") != expected["profileSha256"]:
                raise SystemExit(
                    f"profile-bound report group {group_index} render {render_index} profileSha256 does not match report profile"
                )
    return expected


def main() -> None:
    parser = argparse.ArgumentParser(description="Score an AnyVoice voice regression report with ASR CER/WER, repeat stability, and optional speaker identity gates.")
    parser.add_argument("report", help="AnyVoice voice_clone_regression.py report.json")
    parser.add_argument("--asr-json", help="Optional ASR transcript JSON keyed by outputWav, basename, caseId, or cloneMode/caseId/rNN.")
    parser.add_argument("--speaker-json", help="Optional speaker similarity JSON keyed by outputWav, basename, caseId, or cloneMode/caseId/rNN.")
    parser.add_argument("--out", help="Score JSON path. Defaults to <report>.score.json.")
    parser.add_argument("--baseline-score", help="Optional previous score JSON for relative CER/WER reduction.")
    parser.add_argument("--min-reduction-pct", type=float, default=50.0)
    parser.add_argument("--baseline-clone-mode", help="Compare this clone mode as the in-report baseline, usually prompt.")
    parser.add_argument("--candidate-clone-mode", help="Compare this clone mode as the in-report candidate, usually hifi.")
    parser.add_argument("--min-paired-reduction-pct", type=float, default=50.0)
    parser.add_argument("--max-paired-latency-regression-pct", type=float, default=10.0)
    parser.add_argument("--require-paired-improvement", action="store_true", help="Strictly require candidate clone mode to beat baseline clone mode in the same report.")
    parser.add_argument("--max-cer", type=float, default=0.12)
    parser.add_argument("--max-wer", type=float, default=0.25)
    parser.add_argument("--max-duration-span-pct", type=float, default=12.0)
    parser.add_argument("--max-rms-span-db", type=float, default=3.0)
    parser.add_argument("--min-waveform-corr", type=float, default=0.75)
    parser.add_argument("--min-stability-repeats", type=int, default=3)
    parser.add_argument("--max-clipping-ratio", type=float, default=0.001)
    parser.add_argument("--min-speaker-similarity", type=float, default=0.72)
    parser.add_argument("--require-speaker-similarity", action="store_true", help="Exit review unless every render has speaker similarity at or above the threshold.")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero unless the final verdict is pass.")
    args = parser.parse_args()

    report_path = Path(args.report).expanduser().resolve()
    report = load_json(report_path)
    groups_raw = report.get("groups") if isinstance(report, dict) else None
    if not isinstance(groups_raw, list):
        raise SystemExit(f"report does not look like an AnyVoice regression report: {report_path}")
    validate_report_render_output_evidence(report, report_path)
    voice_profile = validate_report_profile_binding(report)

    asr_index = load_asr_index(Path(args.asr_json).expanduser().resolve() if args.asr_json else None)
    speaker_json_path = Path(args.speaker_json).expanduser().resolve() if args.speaker_json else None
    speaker_index = load_speaker_similarity_index(speaker_json_path)
    profile_speaker_index = load_profile_speaker_similarity_index(speaker_json_path)
    if args.speaker_json:
        args.require_speaker_similarity = True
    args.require_profile_reference_similarity = bool(args.require_speaker_similarity and report_requires_profile_reference_similarity(report))
    groups = [score_group(group, asr_index, speaker_index, profile_speaker_index, args) for group in groups_raw if isinstance(group, dict)]
    score: dict[str, Any] = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceReport": str(report_path),
        "sourceReportSha256": sha256_file(report_path),
        "voiceProfile": voice_profile,
        "asrJson": str(Path(args.asr_json).expanduser().resolve()) if args.asr_json else None,
        "asrJsonSha256": sha256_file(Path(args.asr_json).expanduser().resolve()) if args.asr_json else None,
        "speakerJson": str(Path(args.speaker_json).expanduser().resolve()) if args.speaker_json else None,
        "speakerJsonSha256": sha256_file(Path(args.speaker_json).expanduser().resolve()) if args.speaker_json else None,
        "thresholds": {
            "maxCer": args.max_cer,
            "maxWer": args.max_wer,
            "maxDurationSpanPct": args.max_duration_span_pct,
            "maxRmsSpanDb": args.max_rms_span_db,
            "minWaveformCorr": args.min_waveform_corr,
            "minStabilityRepeats": args.min_stability_repeats,
            "maxClippingRatio": args.max_clipping_ratio,
            "minSpeakerSimilarity": args.min_speaker_similarity,
            "requireSpeakerSimilarity": args.require_speaker_similarity,
            "requireProfileReferenceSimilarity": args.require_profile_reference_similarity,
            "minReductionPct": args.min_reduction_pct,
            "minPairedReductionPct": args.min_paired_reduction_pct,
            "maxPairedLatencyRegressionPct": args.max_paired_latency_regression_pct,
        },
        "textScoringPolicy": TEXT_SCORING_POLICY,
        "summary": aggregate(groups),
        "groups": groups,
    }
    baseline_comparison = None
    if args.baseline_score:
        baseline_comparison = compare_to_baseline(score, load_json(Path(args.baseline_score).expanduser().resolve()), args.min_reduction_pct)
        score["baselineComparison"] = baseline_comparison
    paired_comparison = None
    if args.baseline_clone_mode or args.candidate_clone_mode:
        if not args.baseline_clone_mode or not args.candidate_clone_mode:
            raise SystemExit("--baseline-clone-mode and --candidate-clone-mode must be used together")
        paired_comparison = paired_clone_mode_comparison(
            groups,
            args.baseline_clone_mode,
            args.candidate_clone_mode,
            args.min_paired_reduction_pct,
            args.max_paired_latency_regression_pct,
        )
        score["pairedComparison"] = paired_comparison
    score["verdict"] = final_verdict(groups, baseline_comparison, paired_comparison, args.require_paired_improvement)

    out_path = Path(args.out).expanduser().resolve() if args.out else report_path.with_suffix(".score.json")
    write_json(out_path, score)
    print(
        json.dumps(
            {
                "verdict": score["verdict"],
                "score": str(out_path),
                "avgCer": score["summary"]["avgCer"],
                "avgWer": score["summary"]["avgWer"],
                "avgSpeakerSimilarity": score["summary"]["avgSpeakerSimilarity"],
                "avgRenderSeconds": score["summary"]["avgRenderSeconds"],
                "groups": score["summary"]["groups"],
                "missingAsrGroups": score["summary"]["missingAsrGroups"],
                "stabilityReviewGroups": score["summary"]["stabilityReviewGroups"],
                "speakerReviewGroups": score["summary"]["speakerReviewGroups"],
                "audioQualityReviewGroups": score["summary"]["audioQualityReviewGroups"],
                "profileReferenceReviewGroups": score["summary"]["profileReferenceReviewGroups"],
                "pairedComparisonVerdict": paired_comparison.get("verdict") if paired_comparison else None,
            },
            ensure_ascii=False,
        )
    )
    if args.strict and score["verdict"] != "pass":
        sys.exit(2)


if __name__ == "__main__":
    main()

"""Traditional-Chinese script detection and conversion.

Faithful port of the marker-based detector in lib/text-prep.ts
(CHINESE_SCRIPT_MARKER_PAIRS / analyzeChineseScript / the two gate tiers), plus
the OpenCC Simplified→Traditional(Taiwan, phrases) conversion the YouTube
enroll route applies before gating (opencc-js cn→twp ≙ OpenCC s2twp).
"""

from __future__ import annotations

# [traditional, simplified] pairs — keep byte-for-byte in sync with
# lib/text-prep.ts CHINESE_SCRIPT_MARKER_PAIRS.
CHINESE_SCRIPT_MARKER_PAIRS: list[tuple[str, str]] = [
    ("體", "体"), ("灣", "湾"), ("國", "国"), ("語", "语"), ("聲", "声"),
    ("錄", "录"), ("製", "制"), ("發", "发"), ("個", "个"), ("這", "这"),
    ("裡", "里"), ("麼", "么"), ("為", "为"), ("與", "与"), ("對", "对"),
    ("講", "讲"), ("說", "说"), ("話", "话"), ("請", "请"), ("測", "测"),
    ("試", "试"), ("變", "变"), ("讓", "让"), ("還", "还"), ("們", "们"),
    ("時", "时"), ("間", "间"), ("問", "问"), ("寫", "写"), ("應", "应"),
    ("實", "实"), ("驗", "验"), ("簡", "简"), ("樣", "样"), ("長", "长"),
    ("樂", "乐"), ("讀", "读"), ("錯", "错"), ("聽", "听"), ("覺", "觉"),
    ("後", "后"), ("會", "会"), ("標", "标"), ("準", "准"), ("穩", "稳"),
    ("銀", "银"), ("慶", "庆"), ("數", "数"), ("網", "网"), ("頁", "页"),
    ("電", "电"), ("腦", "脑"), ("開", "开"), ("關", "关"), ("雲", "云"),
    ("廣", "广"), ("環", "环"), ("麥", "麦"), ("遠", "远"), ("傳", "传"),
    ("鳥", "鸟"), ("顯", "显"), ("來", "来"), ("將", "将"), ("過", "过"),
    ("從", "从"), ("練", "练"), ("習", "习"), ("質", "质"), ("選", "选"),
    ("擇", "择"),
]


def has_cjk(text: str) -> bool:
    return any(0x4E00 <= ord(ch) <= 0x9FFF for ch in text)


def detect_chinese_script(text: str) -> str:
    """zh_hant | zh_hans | mixed_zh | zh_unknown | non_zh — port of analyzeChineseScript."""
    traditional = sum(text.count(t) for t, _ in CHINESE_SCRIPT_MARKER_PAIRS)
    simplified = sum(text.count(s) for _, s in CHINESE_SCRIPT_MARKER_PAIRS)
    if traditional > 0 and simplified > 0:
        return "mixed_zh"
    if traditional > 0:
        return "zh_hant"
    if simplified > 0:
        return "zh_hans"
    return "zh_unknown" if has_cjk(text) else "non_zh"


def strict_traditional_chinese_script_errors(text: str) -> list[str]:
    """Enrollment-tier gate: only proven Traditional Chinese passes."""
    script = detect_chinese_script(text)
    if script == "zh_hant":
        return []
    if script in ("zh_hans", "mixed_zh"):
        return ["invalid_chinese_script"]
    if script == "zh_unknown":
        return ["unproven_chinese_script"]
    return ["missing_chinese_script"]


def simplified_or_mixed_chinese_script_errors(text: str) -> list[str]:
    """Generation-tier gate: block only Simplified / mixed scripts."""
    script = detect_chinese_script(text)
    if script in ("zh_hans", "mixed_zh"):
        return ["invalid_chinese_script"]
    return []


_s2twp_converter = None


def simplified_to_traditional(text: str) -> str:
    """Simplified → Traditional (Taiwan + phrases). Idempotent on zh-Hant text.

    Uses OpenCC s2twp, the Python equivalent of the web app's opencc-js
    cn→twp converter. Requires the `opencc` package (see requirements.txt:
    opencc-python-reimplemented).
    """
    if not text:
        return text
    global _s2twp_converter
    if _s2twp_converter is None:
        try:
            from opencc import OpenCC
        except ImportError as exc:
            raise RuntimeError(
                "OpenCC is required for Simplified→Traditional conversion. "
                "Install the pack requirements into the ComfyUI Python: "
                "pip install -r comfyui-anyvoice/requirements.txt"
            ) from exc
        _s2twp_converter = OpenCC("s2twp")
    return _s2twp_converter.convert(text)

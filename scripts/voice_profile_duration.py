from __future__ import annotations

import re


MIN_PROFILE_DURATION_SEC = 6.0
MAX_PROFILE_DURATION_SEC = 20.0
MIN_ACTIVE_VOICE_SEC = 5.2

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
LATIN_DIGIT_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
PUNCTUATION_RE = re.compile(r"[，。！？、；：,.!?;:]")


def clamp_duration_sec(duration_sec: float) -> float:
    return max(MIN_PROFILE_DURATION_SEC, min(MAX_PROFILE_DURATION_SEC, duration_sec))


def recommended_duration_sec(transcript: str) -> int:
    cjk_count = len(CJK_RE.findall(transcript))
    latin_digit_tokens = len(LATIN_DIGIT_TOKEN_RE.findall(transcript))
    punctuation_count = len(PUNCTUATION_RE.findall(transcript))
    estimated = round((cjk_count / 4.2) + (latin_digit_tokens * 0.45) + (punctuation_count * 0.35) + 1.5)
    return int(clamp_duration_sec(float(estimated)))

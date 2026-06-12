"""Parity tests for the lib/text-prep.ts script-detection port + OpenCC."""

import pytest

from anyvoice_comfy.textgate import (
    detect_chinese_script,
    simplified_or_mixed_chinese_script_errors,
    simplified_to_traditional,
    strict_traditional_chinese_script_errors,
)


class TestDetectChineseScript:
    def test_traditional(self):
        assert detect_chinese_script("這是繁體中文的測試") == "zh_hant"

    def test_simplified(self):
        assert detect_chinese_script("这是简体中文的测试") == "zh_hans"

    def test_mixed(self):
        assert detect_chinese_script("這是简体混合") == "mixed_zh"

    def test_unknown_shared_forms(self):
        # CJK with no distinctive markers either way.
        assert detect_chinese_script("早安你好") == "zh_unknown"

    def test_non_chinese(self):
        assert detect_chinese_script("hello world") == "non_zh"


class TestStrictGate:
    def test_passes_traditional(self):
        assert strict_traditional_chinese_script_errors("這是繁體測試") == []

    def test_blocks_simplified_and_mixed(self):
        assert strict_traditional_chinese_script_errors("这是测试") == ["invalid_chinese_script"]
        assert strict_traditional_chinese_script_errors("這是测试") == ["invalid_chinese_script"]

    def test_blocks_unproven_and_non_chinese(self):
        assert strict_traditional_chinese_script_errors("早安你好") == ["unproven_chinese_script"]
        assert strict_traditional_chinese_script_errors("hello") == ["missing_chinese_script"]


class TestGenerationGate:
    def test_allows_unknown_and_english(self):
        assert simplified_or_mixed_chinese_script_errors("早安你好") == []
        assert simplified_or_mixed_chinese_script_errors("hello") == []

    def test_blocks_simplified(self):
        assert simplified_or_mixed_chinese_script_errors("这是测试") == ["invalid_chinese_script"]


class TestOpenCC:
    def test_converts_simplified_to_taiwan_traditional(self):
        pytest.importorskip("opencc")
        converted = simplified_to_traditional("这是简体中文的测试")
        assert detect_chinese_script(converted) == "zh_hant"
        assert "這" in converted

    def test_idempotent_on_traditional(self):
        pytest.importorskip("opencc")
        text = "這是繁體中文的測試"
        assert simplified_to_traditional(text) == text

    def test_empty_passthrough(self):
        assert simplified_to_traditional("") == ""

import { describe, expect, it } from "vitest";
import {
  analyzeChineseScript,
  detectPronunciationPresetHits,
  detectPronunciationPresetIds,
  detectChineseScript,
  detectVoiceProfileCoverageFeatures,
  parsePronunciationOverrides,
  prepareVoiceText,
  strictTraditionalChineseScriptErrors,
  suggestKnownTraditionalChineseText,
  suggestPronunciationOverrides,
} from "@/lib/text-prep";

describe("voice text preparation", () => {
  it("preserves Traditional Chinese while normalizing model-safe alphanumerics", () => {
    const prepared = prepareVoiceText("  請在２０２６年回覆 AnyVoice　測試  ");
    expect(prepared.policy).toBe("preserve_zh_hant");
    expect(prepared.detectedScript).toBe("zh_hant");
    expect(prepared.model).toBe("請在2026年回覆 AnyVoice 測試");
    expect(prepared.operations).toContain("normalize_fullwidth_alnum");
    expect(prepared.warnings).toEqual([]);
  });

  it("warns when Simplified or mixed Chinese is present but does not convert it", () => {
    const prepared = prepareVoiceText("这个声音要穩定");
    expect(prepared.model).toBe("这个声音要穩定");
    expect(prepared.detectedScript).toBe("mixed_zh");
    expect(prepared.scriptDiagnostics).toMatchObject({
      detectedScript: "mixed_zh",
      simplifiedMarkerCount: 3,
      traditionalMarkerCount: 1,
    });
    expect(prepared.warnings).toContain("simplified_or_mixed_chinese_detected_preserved");
  });

  it("reports exact script markers so script drift is debuggable", () => {
    const diagnostics = analyzeChineseScript("请用我的数位聲音說这句话。");
    expect(diagnostics.detectedScript).toBe("mixed_zh");
    expect(diagnostics.simplifiedMarkers).toEqual([
      { char: "这", counterpart: "這", count: 1 },
      { char: "话", counterpart: "話", count: 1 },
      { char: "请", counterpart: "請", count: 1 },
      { char: "数", counterpart: "數", count: 1 },
    ]);
    expect(diagnostics.traditionalMarkers).toEqual([
      { char: "聲", counterpart: "声", count: 1 },
      { char: "說", counterpart: "说", count: 1 },
    ]);
  });

  it("suggests a reviewable Traditional Chinese repair from known Simplified markers", () => {
    const fix = suggestKnownTraditionalChineseText("请用我的数位声音说这句话。");
    expect(fix).toMatchObject({
      text: "請用我的數位聲音說這句話。",
      replacements: expect.arrayContaining([
        { simplified: "请", traditional: "請", count: 1 },
        { simplified: "数", traditional: "數", count: 1 },
        { simplified: "声", traditional: "聲", count: 1 },
        { simplified: "说", traditional: "說", count: 1 },
        { simplified: "这", traditional: "這", count: 1 },
        { simplified: "话", traditional: "話", count: 1 },
      ]),
    });
    expect(suggestKnownTraditionalChineseText("請用我的聲音說這句話。")).toBeNull();
  });

  it("detects broad script classes without claiming OpenCC-level certainty", () => {
    expect(detectChineseScript("這是繁體中文測試")).toBe("zh_hant");
    expect(detectChineseScript("这是简体中文测试")).toBe("zh_hans");
    expect(detectChineseScript("我想说话。")).toBe("zh_hans");
    expect(detectChineseScript("請用我的聲音说话。")).toBe("mixed_zh");
    expect(detectChineseScript("銀行")).toBe("zh_hant");
    expect(detectChineseScript("银行")).toBe("zh_hans");
    expect(detectChineseScript("中文")).toBe("zh_unknown");
    expect(detectChineseScript("hello")).toBe("non_zh");
  });

  it("names non-strict Traditional Chinese blockers for profile enrollment", () => {
    expect(strictTraditionalChineseScriptErrors("請錄製穩定聲音。")).toEqual([]);
    expect(strictTraditionalChineseScriptErrors("这个聲音要穩定。")).toEqual(["invalid_chinese_script"]);
    expect(strictTraditionalChineseScriptErrors("中文音色自然。")).toEqual(["unproven_chinese_script"]);
    expect(strictTraditionalChineseScriptErrors("hello")).toEqual(["missing_chinese_script"]);
  });

  it("detects voice-profile coverage features for guided enrollment", () => {
    const features = detectVoiceProfileCoverageFeatures(
      "今天是二零二六年五月十九日，Brenda 和 AnyVoice 會把重慶、銀行、角色、音樂和長樂讀準。",
    );
    expect(features).toEqual([
      "latin_terms",
      "numbers_dates",
      "polyphones",
      "punctuation_rhythm",
      "zh_hant",
    ]);
  });

  it("does not count Simplified or mixed Chinese as zh-Hant profile coverage", () => {
    expect(detectVoiceProfileCoverageFeatures("这个声音要穩定。")).not.toContain("zh_hant");
    expect(detectVoiceProfileCoverageFeatures("这个声音要稳定。")).not.toContain("zh_hant");
    expect(detectVoiceProfileCoverageFeatures("银行和重庆都要读准。")).not.toContain("zh_hant");
    expect(detectVoiceProfileCoverageFeatures("银行和重庆都要读准。")).toContain("polyphones");
  });

  it("does not count generic measure words as numbers/date coverage", () => {
    expect(detectVoiceProfileCoverageFeatures("你好，我正在錄製一段聲音樣本。")).toEqual([
      "punctuation_rhythm",
      "zh_hant",
    ]);
    expect(detectVoiceProfileCoverageFeatures("今天是二零二六年五月十九日。")).toContain("numbers_dates");
  });

  it("parses pronunciation overrides from line-based term replacements", () => {
    const parsed = parsePronunciationOverrides(
      "重慶=重慶\n重庆 -> 重 慶\n角色 -> 角 色\n# comment\nAnyVoice: Any Voice\npinyin:行長=xing2 zhang3\n音樂[zhuyin]=ㄧㄣ ㄩㄝˋ",
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.overrides).toEqual([
      { term: "重慶", replacement: "重慶", kind: "custom", source: "custom" },
      { term: "重庆", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing" },
      { term: "角色", replacement: "角 色", kind: "polyphone", source: "preset", presetId: "polyphone:role" },
      { term: "AnyVoice", replacement: "Any Voice", kind: "brand", source: "preset", presetId: "brand:anyvoice" },
      { term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom" },
      { term: "音樂", replacement: "ㄧㄣ ㄩㄝˋ", kind: "zhuyin", source: "custom" },
    ]);
  });

  it("rejects malformed pronunciation overrides with line numbers", () => {
    const parsed = parsePronunciationOverrides("重慶\n角色=");
    expect(parsed.overrides).toEqual([]);
    expect(parsed.rejected).toEqual([
      { line: 1, value: "重慶", reason: "invalid_format" },
      { line: 2, value: "角色=", reason: "empty_replacement" },
    ]);
  });

  it("applies pronunciation overrides only to model-facing text", () => {
    const prepared = prepareVoiceText("重慶和角色都容易讀錯。", {
      pronunciationOverrides: [
        { term: "重慶", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing" },
        { term: "角色", replacement: "角 色", kind: "polyphone", source: "preset", presetId: "polyphone:role" },
        { term: "不存在", replacement: "不存在", kind: "custom", source: "custom" },
      ],
    });
    expect(prepared.raw).toBe("重慶和角色都容易讀錯。");
    expect(prepared.model).toBe("重 慶和角 色都容易讀錯。");
    expect(prepared.operations).toContain("apply_pronunciation_overrides");
    expect(prepared.pronunciationOverrides).toEqual([
      { term: "重慶", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing", count: 1 },
      { term: "角色", replacement: "角 色", kind: "polyphone", source: "preset", presetId: "polyphone:role", count: 1 },
    ]);
    expect(prepared.warnings).toContain("pronunciation_override_not_applied:不存在");
  });

  it("applies explicit pinyin and reading overrides as user-supplied model text", () => {
    const parsed = parsePronunciationOverrides("pinyin:行長=xing2 zhang3\n長樂[reading]=chang2 le4");
    const prepared = prepareVoiceText("行長和長樂都容易讀錯。", {
      pronunciationOverrides: parsed.overrides,
    });

    expect(prepared.raw).toBe("行長和長樂都容易讀錯。");
    expect(prepared.model).toBe("xing2 zhang3和chang2 le4都容易讀錯。");
    expect(prepared.pronunciationOverrides).toEqual([
      { term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom", count: 1 },
      { term: "長樂", replacement: "chang2 le4", kind: "reading", source: "custom", count: 1 },
    ]);
  });

  it("suggests known risky pronunciation replacements from target text", () => {
    expect(suggestPronunciationOverrides("請把重庆、银行、角色和 AnyVoice 唸準。")).toEqual([
      { term: "重庆", replacement: "重 慶", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing" },
      { term: "银行", replacement: "銀 行", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:bank" },
      { term: "角色", replacement: "角 色", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:role" },
      { term: "AnyVoice", replacement: "Any Voice", reason: "brand", kind: "brand", source: "preset", presetId: "brand:anyvoice" },
    ]);
  });

  it("detects exact pronunciation preset ids for target/reference matching", () => {
    expect(detectPronunciationPresetIds("請把行長、長樂、AnyVoice 和 VoxCPM2 讀準。")).toEqual([
      "polyphone:changle",
      "polyphone:bank-president",
      "brand:anyvoice",
      "brand:voxcpm2",
    ]);
    expect(detectPronunciationPresetHits("請把行長和長樂讀準。")).toEqual([
      { term: "長樂", replacement: "長 樂", kind: "polyphone", presetId: "polyphone:changle" },
      { term: "行長", replacement: "行 長", kind: "polyphone", presetId: "polyphone:bank-president" },
    ]);
  });

  it("can auto-apply safe preset pronunciation replacements to model-facing text", () => {
    const prepared = prepareVoiceText("請把重慶、銀行和 AnyVoice 唸準。", {
      autoApplyPresetPronunciations: true,
    });
    expect(prepared.raw).toBe("請把重慶、銀行和 AnyVoice 唸準。");
    expect(prepared.model).toBe("請把重 慶、銀 行和 Any Voice 唸準。");
    expect(prepared.operations).toContain("auto_apply_pronunciation_presets");
    expect(prepared.operations).toContain("apply_pronunciation_overrides");
    expect(prepared.pronunciationOverrides).toEqual([
      { term: "AnyVoice", replacement: "Any Voice", reason: "brand", kind: "brand", source: "preset", presetId: "brand:anyvoice", count: 1 },
      { term: "重慶", replacement: "重 慶", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing", count: 1 },
      { term: "銀行", replacement: "銀 行", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:bank", count: 1 },
    ]);
  });

  it("does not suggest replacements already supplied by the user", () => {
    expect(suggestPronunciationOverrides("重慶和角色", [{ term: "重慶", replacement: "重 慶" }])).toEqual([
      { term: "角色", replacement: "角 色", reason: "polyphone", kind: "polyphone", source: "preset", presetId: "polyphone:role" },
    ]);
  });
});

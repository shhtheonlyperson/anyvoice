export type VoiceTextScriptPolicy = "preserve_zh_hant";
export type DetectedChineseScript = "zh_hant" | "zh_hans" | "mixed_zh" | "zh_unknown" | "non_zh";
export type VoiceProfileCoverageFeature =
  | "zh_hant"
  | "numbers_dates"
  | "latin_terms"
  | "polyphones"
  | "punctuation_rhythm";
export type PronunciationOverrideKind = "polyphone" | "brand" | "pinyin" | "zhuyin" | "reading" | "custom";
export type PronunciationOverrideSource = "preset" | "custom";

export interface PronunciationOverride {
  term: string;
  replacement: string;
  kind?: PronunciationOverrideKind;
  source?: PronunciationOverrideSource;
  presetId?: string;
}

export type PronunciationSuggestionReason = "polyphone" | "brand";

export interface PronunciationSuggestion extends PronunciationOverride {
  reason: PronunciationSuggestionReason;
  kind: Exclude<PronunciationOverrideKind, "custom">;
  source: "preset";
  presetId: string;
}

export interface PronunciationPresetHit {
  term: string;
  presetId: string;
  kind: Exclude<PronunciationOverrideKind, "custom">;
  replacement: string;
}

export interface AppliedPronunciationOverride extends PronunciationOverride {
  count: number;
}

export interface ChineseScriptMarkerHit {
  char: string;
  count: number;
  counterpart: string;
}

export interface ChineseScriptDiagnostics {
  detectedScript: DetectedChineseScript;
  hasChinese: boolean;
  traditionalMarkerCount: number;
  simplifiedMarkerCount: number;
  traditionalMarkers: ChineseScriptMarkerHit[];
  simplifiedMarkers: ChineseScriptMarkerHit[];
}

export interface KnownTraditionalChineseFix {
  text: string;
  replacements: Array<{
    simplified: string;
    traditional: string;
    count: number;
  }>;
}

export interface RejectedPronunciationOverride {
  line: number;
  value: string;
  reason: "invalid_format" | "empty_term" | "empty_replacement" | "term_too_long" | "replacement_too_long" | "duplicate_term" | "too_many";
}

export interface PronunciationOverrideParseResult {
  overrides: PronunciationOverride[];
  rejected: RejectedPronunciationOverride[];
}

export interface PreparedVoiceText {
  raw: string;
  model: string;
  policy: VoiceTextScriptPolicy;
  detectedScript: DetectedChineseScript;
  scriptDiagnostics: ChineseScriptDiagnostics;
  operations: string[];
  warnings: string[];
  pronunciationOverrides: AppliedPronunciationOverride[];
}

const CHINESE_SCRIPT_MARKER_PAIRS = [
  ["體", "体"],
  ["灣", "湾"],
  ["國", "国"],
  ["語", "语"],
  ["聲", "声"],
  ["錄", "录"],
  ["製", "制"],
  ["發", "发"],
  ["個", "个"],
  ["這", "这"],
  ["裡", "里"],
  ["麼", "么"],
  ["為", "为"],
  ["與", "与"],
  ["對", "对"],
  ["講", "讲"],
  ["說", "说"],
  ["話", "话"],
  ["請", "请"],
  ["測", "测"],
  ["試", "试"],
  ["變", "变"],
  ["讓", "让"],
  ["還", "还"],
  ["們", "们"],
  ["時", "时"],
  ["間", "间"],
  ["問", "问"],
  ["寫", "写"],
  ["應", "应"],
  ["實", "实"],
  ["驗", "验"],
  ["簡", "简"],
  ["樣", "样"],
  ["長", "长"],
  ["樂", "乐"],
  ["讀", "读"],
  ["錯", "错"],
  ["聽", "听"],
  ["覺", "觉"],
  ["後", "后"],
  ["會", "会"],
  ["標", "标"],
  ["準", "准"],
  ["穩", "稳"],
  ["銀", "银"],
  ["慶", "庆"],
  ["數", "数"],
  ["網", "网"],
  ["頁", "页"],
  ["電", "电"],
  ["腦", "脑"],
  ["開", "开"],
  ["關", "关"],
  ["雲", "云"],
  ["廣", "广"],
  ["環", "环"],
  ["麥", "麦"],
  ["遠", "远"],
  ["傳", "传"],
  ["鳥", "鸟"],
  ["顯", "显"],
  ["來", "来"],
  ["將", "将"],
  ["過", "过"],
  ["從", "从"],
  ["練", "练"],
  ["習", "习"],
  ["質", "质"],
  ["選", "选"],
  ["擇", "择"],
] as const;

const MAX_PRONUNCIATION_OVERRIDES = 20;
const MAX_PRONUNCIATION_TERM_CHARS = 32;
const MAX_PRONUNCIATION_REPLACEMENT_CHARS = 80;
const PRONUNCIATION_DELIMITERS = ["=>", "->", "＝", "=", "：", ":"];
const POLYPHONE_GROUPS = [
  { terms: ["重慶", "重庆"], replacement: "重 慶", presetId: "polyphone:chongqing" },
  { terms: ["銀行", "银行"], replacement: "銀 行", presetId: "polyphone:bank" },
  { terms: ["角色"], replacement: "角 色", presetId: "polyphone:role" },
  { terms: ["音樂", "音乐"], replacement: "音 樂", presetId: "polyphone:music" },
  { terms: ["長樂", "长乐"], replacement: "長 樂", presetId: "polyphone:changle" },
  { terms: ["行長", "行长"], replacement: "行 長", presetId: "polyphone:bank-president" },
  { terms: ["長大", "长大"], replacement: "長 大", presetId: "polyphone:grow-up" },
] as const;

const POLYPHONE_TERMS = POLYPHONE_GROUPS.flatMap((group) => [...group.terms]);
export const REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS = [
  "polyphone:chongqing",
  "polyphone:bank",
  "polyphone:role",
  "polyphone:music",
  "polyphone:changle",
  "brand:anyvoice",
] as const;
export const PRODUCT_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS = [
  ...REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  "polyphone:bank-president",
  "brand:voxcpm2",
] as const;
const PRONUNCIATION_SUGGESTIONS: PronunciationSuggestion[] = [
  ...POLYPHONE_GROUPS.flatMap((group) =>
    group.terms.map((term) => ({
      term,
      replacement: group.replacement,
      reason: "polyphone" as const,
      kind: "polyphone" as const,
      source: "preset" as const,
      presetId: group.presetId,
    })),
  ),
  { term: "AnyVoice", replacement: "Any Voice", reason: "brand", kind: "brand", source: "preset", presetId: "brand:anyvoice" },
  { term: "VoxCPM2", replacement: "Vox C P M two", reason: "brand", kind: "brand", source: "preset", presetId: "brand:voxcpm2" },
];

function hasCjk(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0x4e00 && code <= 0x9fff) return true;
  }
  return false;
}

export function detectChineseScript(text: string): DetectedChineseScript {
  return analyzeChineseScript(text).detectedScript;
}

export function strictTraditionalChineseScriptErrors(text: string): string[] {
  const script = detectChineseScript(text);
  if (script === "zh_hant") return [];
  if (script === "zh_hans" || script === "mixed_zh") return ["invalid_chinese_script"];
  if (script === "zh_unknown") return ["unproven_chinese_script"];
  return ["missing_chinese_script"];
}

/**
 * Ingest-tier gate: block only Simplified / mixed scripts (the real Mandarin
 * safety hazard). Unlike {@link strictTraditionalChineseScriptErrors}, this
 * ALLOWS `zh_unknown` (CJK with no Simplified markers and no distinctive
 * Traditional markers, e.g. 早安你好) so short clean Traditional clips can
 * enroll to a Usable voice. The studio-grade tier still requires proven
 * Traditional via the `zh_hant` coverage feature, so this does not let a voice
 * reach studio-grade on shared-form text.
 */
export function simplifiedOrMixedChineseScriptErrors(text: string): string[] {
  const script = detectChineseScript(text);
  if (script === "zh_hans" || script === "mixed_zh") return ["invalid_chinese_script"];
  return [];
}

function countMarkers(
  text: string,
  script: "traditional" | "simplified",
): { count: number; markers: ChineseScriptMarkerHit[] } {
  const index = script === "traditional" ? 0 : 1;
  const counterpartIndex = script === "traditional" ? 1 : 0;
  let count = 0;
  const markers: ChineseScriptMarkerHit[] = [];

  for (const pair of CHINESE_SCRIPT_MARKER_PAIRS) {
    const char = pair[index];
    const charCount = Array.from(text).filter((item) => item === char).length;
    if (charCount <= 0) continue;
    count += charCount;
    markers.push({
      char,
      count: charCount,
      counterpart: pair[counterpartIndex],
    });
  }

  return { count, markers };
}

export function analyzeChineseScript(text: string): ChineseScriptDiagnostics {
  let traditional = 0;
  let simplified = 0;
  const traditionalMarkerCounts = countMarkers(text, "traditional");
  const simplifiedMarkerCounts = countMarkers(text, "simplified");

  traditional = traditionalMarkerCounts.count;
  simplified = simplifiedMarkerCounts.count;

  const hasChinese = hasCjk(text);
  const detectedScript =
    traditional > 0 && simplified > 0
      ? "mixed_zh"
      : traditional > 0
        ? "zh_hant"
        : simplified > 0
          ? "zh_hans"
          : hasChinese
            ? "zh_unknown"
            : "non_zh";

  return {
    detectedScript,
    hasChinese,
    traditionalMarkerCount: traditional,
    simplifiedMarkerCount: simplified,
    traditionalMarkers: traditionalMarkerCounts.markers,
    simplifiedMarkers: simplifiedMarkerCounts.markers,
  };
}

export function suggestKnownTraditionalChineseText(text: string): KnownTraditionalChineseFix | null {
  let next = text;
  const replacements: KnownTraditionalChineseFix["replacements"] = [];

  for (const [traditional, simplified] of CHINESE_SCRIPT_MARKER_PAIRS) {
    const count = Array.from(next).filter((char) => char === simplified).length;
    if (count <= 0) continue;
    next = next.split(simplified).join(traditional);
    replacements.push({ simplified, traditional, count });
  }

  return replacements.length > 0 ? { text: next, replacements } : null;
}

export function detectVoiceProfileCoverageFeatures(text: string): VoiceProfileCoverageFeature[] {
  const features = new Set<VoiceProfileCoverageFeature>();
  const script = detectChineseScript(text);
  if (script === "zh_hant") features.add("zh_hant");
  if (/[A-Za-z]/.test(text)) features.add("latin_terms");
  if (
    /\d/.test(text) ||
    /[零〇一二三四五六七八九十百千兩]+(?:年|月|日|號|點|分|秒|百分)/.test(text)
  ) {
    features.add("numbers_dates");
  }
  if (POLYPHONE_TERMS.some((term) => text.includes(term))) features.add("polyphones");
  const punctuationCount = Array.from(text).filter((char) => /[，。、！？；：,.!?;:]/.test(char)).length;
  if (punctuationCount >= 2) features.add("punctuation_rhythm");
  return [...features].sort();
}

function normalizeFullWidthAlnum(value: string): { text: string; changed: boolean } {
  let changed = false;
  let text = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) {
      text += " ";
      changed = true;
      continue;
    }
    if (
      code !== undefined &&
      ((code >= 0xff10 && code <= 0xff19) ||
        (code >= 0xff21 && code <= 0xff3a) ||
        (code >= 0xff41 && code <= 0xff5a))
    ) {
      text += String.fromCodePoint(code - 0xfee0);
      changed = true;
      continue;
    }
    text += ch;
  }
  return { text, changed };
}

function splitOverrideLine(line: string): { term: string; replacement: string; kind?: PronunciationOverrideKind } | null {
  let value = line;
  let kind: PronunciationOverrideKind | undefined;
  const prefixMatch = value.match(/^(pinyin|zhuyin|reading)\s*[:：]\s*/i);
  if (prefixMatch) {
    kind = prefixMatch[1].toLowerCase() as PronunciationOverrideKind;
    value = value.slice(prefixMatch[0].length);
  }

  for (const delimiter of PRONUNCIATION_DELIMITERS) {
    const index = value.indexOf(delimiter);
    if (index < 0) continue;
    const rawTerm = value.slice(0, index).trim();
    const suffixMatch = rawTerm.match(/^(.*)\[(pinyin|zhuyin|reading)\]$/i);
    return {
      term: (suffixMatch ? suffixMatch[1] : rawTerm).trim(),
      replacement: value.slice(index + delimiter.length).trim(),
      kind: kind ?? (suffixMatch?.[2].toLowerCase() as PronunciationOverrideKind | undefined),
    };
  }
  return null;
}

function annotatePronunciationOverride(
  term: string,
  replacement: string,
  kind?: PronunciationOverrideKind,
): PronunciationOverride {
  if (kind === "pinyin" || kind === "zhuyin" || kind === "reading") {
    return {
      term,
      replacement,
      kind,
      source: "custom",
    };
  }

  const preset = PRONUNCIATION_SUGGESTIONS.find(
    (suggestion) => suggestion.term === term && suggestion.replacement === replacement,
  );
  if (preset) {
    return {
      term,
      replacement,
      kind: preset.kind,
      source: "preset",
      presetId: preset.presetId,
    };
  }
  return {
    term,
    replacement,
    kind: "custom",
    source: "custom",
  };
}

function serializedOverridePrefix(kind: PronunciationOverrideKind | undefined): string {
  return kind === "pinyin" || kind === "zhuyin" || kind === "reading" ? `${kind}:` : "";
}

export function serializePronunciationOverride(override: PronunciationOverride): string {
  return `${serializedOverridePrefix(override.kind)}${override.term}=${override.replacement}`;
}

export function parsePronunciationOverrides(raw: string): PronunciationOverrideParseResult {
  const overrides: PronunciationOverride[] = [];
  const rejected: RejectedPronunciationOverride[] = [];
  const seen = new Set<string>();

  raw.split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value || value.startsWith("#")) return;
    if (overrides.length >= MAX_PRONUNCIATION_OVERRIDES) {
      rejected.push({ line: index + 1, value, reason: "too_many" });
      return;
    }

    const split = splitOverrideLine(value);
    if (!split) {
      rejected.push({ line: index + 1, value, reason: "invalid_format" });
      return;
    }
    if (!split.term) {
      rejected.push({ line: index + 1, value, reason: "empty_term" });
      return;
    }
    if (!split.replacement) {
      rejected.push({ line: index + 1, value, reason: "empty_replacement" });
      return;
    }
    if ([...split.term].length > MAX_PRONUNCIATION_TERM_CHARS) {
      rejected.push({ line: index + 1, value, reason: "term_too_long" });
      return;
    }
    if ([...split.replacement].length > MAX_PRONUNCIATION_REPLACEMENT_CHARS) {
      rejected.push({ line: index + 1, value, reason: "replacement_too_long" });
      return;
    }
    if (seen.has(split.term)) {
      rejected.push({ line: index + 1, value, reason: "duplicate_term" });
      return;
    }

    seen.add(split.term);
    overrides.push(annotatePronunciationOverride(split.term, split.replacement, split.kind));
  });

  return { overrides, rejected };
}

export function suggestPronunciationOverrides(
  text: string,
  existing: PronunciationOverride[] = [],
): PronunciationSuggestion[] {
  const seen = new Set(existing.map((override) => override.term));
  const suggestions: PronunciationSuggestion[] = [];
  for (const suggestion of PRONUNCIATION_SUGGESTIONS) {
    if (seen.has(suggestion.term) || !text.includes(suggestion.term)) continue;
    seen.add(suggestion.term);
    suggestions.push(suggestion);
  }
  return suggestions;
}

export function detectPronunciationPresetHits(text: string): PronunciationPresetHit[] {
  const seen = new Set<string>();
  const hits: PronunciationPresetHit[] = [];
  for (const suggestion of PRONUNCIATION_SUGGESTIONS) {
    if (!text.includes(suggestion.term) || seen.has(suggestion.presetId)) continue;
    seen.add(suggestion.presetId);
    hits.push({
      term: suggestion.term,
      presetId: suggestion.presetId,
      kind: suggestion.kind,
      replacement: suggestion.replacement,
    });
  }
  return hits;
}

export function detectPronunciationPresetIds(text: string): string[] {
  return detectPronunciationPresetHits(text).map((hit) => hit.presetId);
}

function applyPronunciationOverrides(
  text: string,
  overrides: PronunciationOverride[] | undefined,
): { text: string; applied: AppliedPronunciationOverride[] } {
  if (!overrides?.length) return { text, applied: [] };

  let next = text;
  const applied: AppliedPronunciationOverride[] = [];
  const ordered = [...overrides].sort((a, b) => [...b.term].length - [...a.term].length);
  for (const override of ordered) {
    const parts = next.split(override.term);
    const count = parts.length - 1;
    if (count <= 0) continue;
    next = parts.join(override.replacement);
    applied.push({ ...override, count });
  }
  return { text: next, applied };
}

export function prepareVoiceText(
  raw: string,
  options: { pronunciationOverrides?: PronunciationOverride[]; autoApplyPresetPronunciations?: boolean } = {},
): PreparedVoiceText {
  const operations: string[] = [];
  const warnings: string[] = [];
  const scriptDiagnostics = analyzeChineseScript(raw);
  const detectedScript = scriptDiagnostics.detectedScript;

  const lineNormalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (lineNormalized !== raw) operations.push("normalize_line_endings");

  const fullWidth = normalizeFullWidthAlnum(lineNormalized);
  if (fullWidth.changed) operations.push("normalize_fullwidth_alnum");

  const compactSpaces = fullWidth.text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compactSpaces !== fullWidth.text) operations.push("trim_and_compact_whitespace");

  const explicitOverrides = options.pronunciationOverrides ?? [];
  const autoPresetOverrides = options.autoApplyPresetPronunciations
    ? suggestPronunciationOverrides(compactSpaces, explicitOverrides)
    : [];
  const overrideResult = applyPronunciationOverrides(compactSpaces, [
    ...explicitOverrides,
    ...autoPresetOverrides,
  ]);
  if (autoPresetOverrides.some((override) => overrideResult.applied.some((applied) => applied.term === override.term))) {
    operations.push("auto_apply_pronunciation_presets");
  }
  if (overrideResult.applied.length > 0) operations.push("apply_pronunciation_overrides");
  for (const override of explicitOverrides) {
    if (!overrideResult.applied.some((applied) => applied.term === override.term)) {
      warnings.push(`pronunciation_override_not_applied:${override.term}`);
    }
  }

  if (detectedScript === "zh_hans" || detectedScript === "mixed_zh") {
    warnings.push("simplified_or_mixed_chinese_detected_preserved");
  }

  return {
    raw,
    model: overrideResult.text,
    policy: "preserve_zh_hant",
    detectedScript,
    scriptDiagnostics,
    operations,
    warnings,
    pronunciationOverrides: overrideResult.applied,
  };
}

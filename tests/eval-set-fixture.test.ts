import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface EvalCase {
  id: string;
  locale: string;
  tags?: string[];
  text: string;
  pronunciationOverrides?: Array<string | { term?: string; replacement?: string; kind?: string }>;
  asrEquivalenceAliases?: Array<{ text?: string; reason?: string }>;
  reviewerPronunciationTargets?: Array<{ term?: string; pinyin?: string; zhuyin?: string; reject?: string }>;
  subjectiveReviewNotes?: Array<{ source?: string; note?: string }>;
  source?: {
    kind?: string;
    runIds?: string[];
    reason?: string;
  };
}

async function loadEvalCases(): Promise<EvalCase[]> {
  const evalSetPath = path.join(process.cwd(), "examples", "voice_clone_eval_set.json");
  const parsed = JSON.parse(await readFile(evalSetPath, "utf-8")) as { cases?: EvalCase[] };
  return parsed.cases ?? [];
}

describe("voice clone eval set fixture", () => {
  it("keeps stable unique case ids and required plan coverage", async () => {
    const cases = await loadEvalCases();
    const ids = cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "zh_hant_short_identity",
        "zh_hant_paragraph",
        "zh_hant_numbers_dates",
        "zh_hant_polyphones",
        "mixed_en_zh_models",
        "history_failed_self_voice",
      ]),
    );
  });

  it("includes a user-provided failing sentence from local history with provenance", async () => {
    const cases = await loadEvalCases();
    const historyCase = cases.find((item) => item.id === "history_failed_self_voice");

    expect(historyCase).toMatchObject({
      locale: "zh-Hant",
      text: "你好，這是我的聲音。",
      source: {
        kind: "local_run_history",
      },
    });
    expect(historyCase?.tags).toEqual(expect.arrayContaining(["history", "failure", "identity"]));
    expect(historyCase?.source?.runIds).toEqual(expect.arrayContaining(["Xutn2Tkeoa", "xnm1LpUCeD"]));
    expect(historyCase?.source?.reason).toMatch(/failed/);
  });

  it("keeps reviewer-derived pronunciation corrections from the 20260604 blind review", async () => {
    const cases = await loadEvalCases();
    const paragraph = cases.find((item) => item.id === "zh_hant_paragraph");
    const custom = cases.find((item) => item.id === "zh_hant_custom_readings");
    const tone = cases.find((item) => item.id === "zh_hant_tone_contrast");
    const history = cases.find((item) => item.id === "history_failed_self_voice");

    expect(paragraph?.pronunciationOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "乾淨", replacement: "甘淨" }),
      ]),
    );
    expect(paragraph?.reviewerPronunciationTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "乾淨", pinyin: "gānjìng", reject: "qiānjìng" }),
      ]),
    );
    expect(custom?.pronunciationOverrides).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "重試", replacement: "重新測試" }),
      ]),
    );
    expect(custom?.asrEquivalenceAliases?.[0]?.text).toContain("重試");
    expect(custom?.asrEquivalenceAliases?.[0]?.text).not.toContain("重新測試");
    expect(tone?.reviewerPronunciationTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "媽媽罵馬嗎", zhuyin: "ㄇㄚ ˙ㄇㄚ ㄇㄚˋ ㄇㄚˇ ㄇㄚ˙" }),
        expect.objectContaining({ term: "買賣慢慢來", zhuyin: "ㄇㄞˇ ㄇㄞˋ ㄇㄢˋ ㄇㄢˋ ㄌㄞˊ" }),
      ]),
    );
    expect(history?.subjectiveReviewNotes?.[0]?.note).toContain("leading extra syllable");
  });
});

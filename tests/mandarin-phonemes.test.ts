import { describe, expect, it } from "vitest";
import {
  coverageFromTexts,
  decomposeSyllable,
  phonemesInText,
  FINALS,
  INITIALS,
  INVENTORY_TOTAL,
  TONES,
} from "@/lib/mandarin-phonemes";

describe("decomposeSyllable — tricky pinyin cases", () => {
  it("syllabic -i after zh/ch/sh/r maps to the buzz final i_", () => {
    expect(decomposeSyllable("zhi1")).toEqual({ initial: "zh", final: "i_", tone: "1" });
    expect(decomposeSyllable("chi2")).toEqual({ initial: "ch", final: "i_", tone: "2" });
    expect(decomposeSyllable("shi4")).toEqual({ initial: "sh", final: "i_", tone: "4" });
    expect(decomposeSyllable("ri4")).toEqual({ initial: "r", final: "i_", tone: "4" });
    // and after z/c/s
    expect(decomposeSyllable("zi3")).toEqual({ initial: "z", final: "i_", tone: "3" });
    expect(decomposeSyllable("ci2")).toEqual({ initial: "c", final: "i_", tone: "2" });
    expect(decomposeSyllable("si1")).toEqual({ initial: "s", final: "i_", tone: "1" });
  });

  it("a true -i vowel (bi/mi/li) stays the plain final i", () => {
    expect(decomposeSyllable("bi4")).toEqual({ initial: "b", final: "i", tone: "4" });
    expect(decomposeSyllable("li3")).toEqual({ initial: "l", final: "i", tone: "3" });
  });

  it("ü-series: yu/yue/yuan/yun are zero-initial ü finals", () => {
    expect(decomposeSyllable("yu2")).toEqual({ initial: "∅", final: "ü", tone: "2" });
    expect(decomposeSyllable("yue4")).toEqual({ initial: "∅", final: "üe", tone: "4" });
    expect(decomposeSyllable("yuan2")).toEqual({ initial: "∅", final: "üan", tone: "2" });
    expect(decomposeSyllable("yun4")).toEqual({ initial: "∅", final: "ün", tone: "4" });
  });

  it("j/q/x + u is phonemically ü (ju/qu/xu, xun → ün)", () => {
    expect(decomposeSyllable("ju2")).toEqual({ initial: "j", final: "ü", tone: "2" });
    expect(decomposeSyllable("qu4")).toEqual({ initial: "q", final: "ü", tone: "4" });
    expect(decomposeSyllable("xue2")).toEqual({ initial: "x", final: "üe", tone: "2" });
    expect(decomposeSyllable("xun4")).toEqual({ initial: "x", final: "ün", tone: "4" });
    expect(decomposeSyllable("qun2")).toEqual({ initial: "q", final: "ün", tone: "2" });
  });

  it("nü/lü (pinyin-pro 'v') normalise to ü", () => {
    expect(decomposeSyllable("nv3")).toEqual({ initial: "n", final: "ü", tone: "3" });
    expect(decomposeSyllable("lv4")).toEqual({ initial: "l", final: "ü", tone: "4" });
  });

  it("w-series: wu/wei map to zero-initial u/uei", () => {
    expect(decomposeSyllable("wu4")).toEqual({ initial: "∅", final: "u", tone: "4" });
    expect(decomposeSyllable("wei1")).toEqual({ initial: "∅", final: "uei", tone: "1" });
    expect(decomposeSyllable("weng1")).toEqual({ initial: "∅", final: "ueng", tone: "1" });
  });

  it("er is a standalone final with zero initial", () => {
    expect(decomposeSyllable("er2")).toEqual({ initial: "∅", final: "er", tone: "2" });
  });

  it("nasal -ng finals are folded into their parent finals", () => {
    expect(decomposeSyllable("zhong4")).toEqual({ initial: "zh", final: "ong", tone: "4" });
    expect(decomposeSyllable("yang2")).toEqual({ initial: "∅", final: "iang", tone: "2" });
    expect(decomposeSyllable("ying2")).toEqual({ initial: "∅", final: "ing", tone: "2" });
  });

  it("spelling shorthands: -ui/-iu/-un expand to -uei/-iou/-uen", () => {
    expect(decomposeSyllable("gui1")).toEqual({ initial: "g", final: "uei", tone: "1" });
    expect(decomposeSyllable("liu2")).toEqual({ initial: "l", final: "iou", tone: "2" });
    expect(decomposeSyllable("dun4")).toEqual({ initial: "d", final: "uen", tone: "4" });
  });

  it("neutral tone (digit 0) maps to 'neutral'", () => {
    expect(decomposeSyllable("de0")).toEqual({ initial: "d", final: "e", tone: "neutral" });
    expect(decomposeSyllable("ma0")).toEqual({ initial: "m", final: "a", tone: "neutral" });
  });

  it("rejects non-syllable input", () => {
    expect(decomposeSyllable("")).toBeNull();
    expect(decomposeSyllable("123")).toBeNull();
    expect(decomposeSyllable("?!")).toBeNull();
  });
});

describe("phonemesInText", () => {
  it("ignores Latin, digits and punctuation gracefully", () => {
    const p = phonemesInText("Hello AnyVoice 2026, OK?!");
    expect(p.initials.size).toBe(0);
    expect(p.finals.size).toBe(0);
    expect(p.tones.size).toBe(0);
  });

  it("extracts initials/finals/tones from mixed Han + Latin text", () => {
    // 你(ni3) 好(hao3) — n, i, ao, tone 3.
    const p = phonemesInText("你好 Google");
    expect(p.initials.has("n")).toBe(true);
    expect(p.finals.has("i")).toBe(true);
    expect(p.finals.has("ao")).toBe(true);
    expect(p.tones.has("3")).toBe(true);
  });

  it("handles empty input", () => {
    const p = phonemesInText("");
    expect(p.initials.size).toBe(0);
  });
});

describe("coverageFromTexts", () => {
  it("reports the canonical inventory total", () => {
    const cov = coverageFromTexts([]);
    expect(cov.total).toBe(INVENTORY_TOTAL);
    expect(INVENTORY_TOTAL).toBe(INITIALS.length + FINALS.length + TONES.length);
  });

  it("union across texts is incremental (covered never shrinks)", () => {
    const one = coverageFromTexts(["重慶"]);
    const two = coverageFromTexts(["重慶", "銀行音樂"]);
    expect(two.covered).toBeGreaterThanOrEqual(one.covered);
  });

  it("returns covered phonemes in canonical inventory order", () => {
    const cov = coverageFromTexts(["你好嗎重慶銀行角色音樂長樂"]);
    const order = (xs: readonly string[], full: readonly string[]) =>
      xs.every((x, i) => i === 0 || full.indexOf(x) > full.indexOf(xs[i - 1]));
    expect(order(cov.initials, INITIALS)).toBe(true);
    expect(order(cov.finals, FINALS)).toBe(true);
  });
});

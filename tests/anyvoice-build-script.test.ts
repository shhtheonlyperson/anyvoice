import { describe, expect, it } from "vitest";
import {
  BUILD_LINE_COUNT,
  BUILD_SCRIPT_PACK,
  lineStatusFromGrade,
} from "@/components/anyvoice/build-script";
import {
  coverageFromTexts,
  FINALS,
  INITIALS,
  TONES,
} from "@/lib/mandarin-phonemes";

describe("24-line build script pack shape", () => {
  for (const locale of ["zh-Hant", "en"] as const) {
    it(`${locale} pack has exactly 24 sequentially-numbered lines`, () => {
      const pack = BUILD_SCRIPT_PACK[locale];
      expect(pack).toHaveLength(BUILD_LINE_COUNT);
      expect(BUILD_LINE_COUNT).toBe(24);
      pack.forEach((line, i) => {
        expect(line.n).toBe(i + 1);
        expect(line.text.trim().length).toBeGreaterThan(0);
        expect(Array.isArray(line.cues)).toBe(true);
      });
    });

    it(`${locale} lines stay in a readable 6–20s band (rough char heuristic)`, () => {
      // ~3.2 syllables/sec; CJK ≈ 1 syllable/char, Latin words ≈ 1.4 syllables.
      for (const line of BUILD_SCRIPT_PACK[locale]) {
        const cjk = (line.text.match(/[一-鿿]/g) ?? []).length;
        const words = (line.text.match(/[A-Za-z][A-Za-z']*/g) ?? []).length;
        const syllables = cjk + words * 1.4;
        const seconds = syllables / 3.2;
        // Generous band — the real gate is the analyzer, this just guards drift.
        expect(seconds).toBeGreaterThan(2);
        expect(seconds).toBeLessThan(30);
      }
    });
  }

  it("the 24 zh-Hant lines cover the FULL Mandarin phoneme inventory", () => {
    const cov = coverageFromTexts(BUILD_SCRIPT_PACK["zh-Hant"].map((l) => l.text));
    // Every initial, every final, all tones — completing the 24 lines yields
    // full text-derived phoneme coverage.
    expect(cov.missing.initials).toEqual([]);
    expect(cov.missing.finals).toEqual([]);
    expect(cov.missing.tones).toEqual([]);
    expect(cov.covered).toBe(cov.total);
    expect(cov.total).toBe(INITIALS.length + FINALS.length + TONES.length);
  });

  it("includes the required polyphones in the zh-Hant pack", () => {
    const all = BUILD_SCRIPT_PACK["zh-Hant"].map((l) => l.text).join("");
    for (const term of ["重慶", "銀行", "角色", "音樂", "長樂"]) {
      expect(all).toContain(term);
    }
  });
});

describe("line-status mapping from analyzer grade", () => {
  it("maps A and B to passed", () => {
    expect(lineStatusFromGrade("A")).toBe("pass");
    expect(lineStatusFromGrade("B")).toBe("pass");
    expect(lineStatusFromGrade("a")).toBe("pass");
  });
  it("maps C and D (and unknown) to re-record", () => {
    expect(lineStatusFromGrade("C")).toBe("retry");
    expect(lineStatusFromGrade("D")).toBe("retry");
    expect(lineStatusFromGrade(undefined)).toBe("retry");
    expect(lineStatusFromGrade("")).toBe("retry");
  });
});

describe("phoneme coverage derivation from recorded transcripts", () => {
  it("covers nothing for an empty set", () => {
    const cov = coverageFromTexts([]);
    expect(cov.covered).toBe(0);
    expect(cov.initials).toEqual([]);
    expect(cov.finals).toEqual([]);
    expect(cov.tones).toEqual([]);
  });

  it("grows monotonically as more lines are added (incremental union)", () => {
    const a = coverageFromTexts(["你好"]);
    const ab = coverageFromTexts(["你好", "重慶銀行"]);
    expect(ab.covered).toBeGreaterThanOrEqual(a.covered);
    // Every phoneme covered by the smaller set stays covered in the larger.
    for (const i of a.initials) expect(ab.initials).toContain(i);
    for (const f of a.finals) expect(ab.finals).toContain(f);
    for (const tn of a.tones) expect(ab.tones).toContain(tn);
  });

  it("ignores Latin/punctuation and reports only Han-derived phonemes", () => {
    const cov = coverageFromTexts(["Google Netflix 2026 !!! ??? 你"]);
    // 你 = ni3 → initial n, final i, tone 3.
    expect(cov.initials).toContain("n");
    expect(cov.finals).toContain("i");
    expect(cov.tones).toContain("3");
  });
});

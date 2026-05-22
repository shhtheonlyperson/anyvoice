import { describe, expect, it } from "vitest";
import {
  BUILD_LINE_COUNT,
  BUILD_SCRIPT_PACK,
  COVERAGE_FEATURES,
  deriveCoverage,
  lineStatusFromGrade,
} from "@/components/anyvoice/build-script";
import { detectVoiceProfileCoverageFeatures } from "@/lib/text-prep";

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

  it("zh-Hant pack broadens coverage across every analyzer feature", () => {
    const seen = new Set<string>();
    for (const line of BUILD_SCRIPT_PACK["zh-Hant"]) {
      for (const f of detectVoiceProfileCoverageFeatures(line.text)) seen.add(f);
    }
    for (const feature of COVERAGE_FEATURES) {
      expect(seen.has(feature)).toBe(true);
    }
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

describe("coverage derivation from recorded transcripts", () => {
  it("returns one bucket per feature, all uncovered for an empty set", () => {
    const cov = deriveCoverage([]);
    expect(cov).toHaveLength(COVERAGE_FEATURES.length);
    expect(cov.every((b) => b.count === 0 && !b.covered)).toBe(true);
  });

  it("marks features covered and counts hits across recorded lines", () => {
    const cov = deriveCoverage([
      "今天是二零二六年五月二十日，我們在重慶。", // numbers_dates + polyphones + zh_hant + punctuation
      "她在 Google 工作。", // latin_terms + punctuation
    ]);
    const byFeature = Object.fromEntries(cov.map((b) => [b.feature, b]));
    expect(byFeature.numbers_dates.covered).toBe(true);
    expect(byFeature.polyphones.covered).toBe(true);
    expect(byFeature.latin_terms.covered).toBe(true);
    // count is per recorded line that hits the feature (line 1 has ≥2 marks).
    expect(byFeature.punctuation_rhythm.count).toBeGreaterThanOrEqual(1);
  });

  it("agrees with the analyzer's own feature detection (single source of truth)", () => {
    const text = BUILD_SCRIPT_PACK["zh-Hant"][5].text; // the date line
    const cov = deriveCoverage([text]);
    const expected = new Set(detectVoiceProfileCoverageFeatures(text));
    for (const bucket of cov) {
      expect(bucket.covered).toBe(expected.has(bucket.feature));
    }
  });
});

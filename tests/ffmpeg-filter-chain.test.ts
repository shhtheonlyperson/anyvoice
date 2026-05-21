import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for the silence-truncation bug: a single silenceremove with
// stop_periods=1 truncates the reference at the first internal pause (a breath),
// collapsing a ~14s read into ~0.4s — in both the analyzer (false "too short"
// rejections) and the synthesis path (degraded VoxCPM2 clone). The fix trims
// only leading + trailing silence via the areverse trick.
const SCRIPTS = ["analyze_voice_reference.py", "synthesize_voxcpm_anyvoice.py"];

describe("ffmpeg reference filter chain", () => {
  for (const script of SCRIPTS) {
    const raw = readFileSync(path.join(process.cwd(), "scripts", script), "utf-8");
    // strip Python comment lines so the bug explanation doesn't trip the guard
    const source = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    it(`${script} never truncates the reference at internal pauses (no stop_periods)`, () => {
      expect(source).not.toContain("stop_periods");
    });

    it(`${script} trims only head/tail silence via the areverse trick`, () => {
      expect(source).toContain("areverse");
      expect(source).toContain("silenceremove=start_periods=1");
    });
  }
});

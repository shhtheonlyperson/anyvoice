import { describe, expect, it } from "vitest";
import { buildProfileScriptPlan, selectNextProfileRecordingScript, selectNextProfileScript } from "@/lib/profile-guidance";

const scripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
  "今天是二零二六年五月十九日，我會清楚讀完。",
  "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。",
  "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。",
];

describe("selectNextProfileScript", () => {
  it("prioritizes the first missing coverage feature", () => {
    const next = selectNextProfileScript({
      scripts,
      missingCoverageFeatures: ["latin_terms", "polyphones"],
      eligibleClips: 0,
    });

    expect(next?.index).toBe(2);
    expect(next?.primaryFeature).toBe("latin_terms");
    expect(next?.text).toContain("AnyVoice");
  });

  it("falls back to enrollment order when no coverage feature is missing", () => {
    const next = selectNextProfileScript({
      scripts,
      missingCoverageFeatures: [],
      eligibleClips: 1,
    });

    expect(next?.index).toBe(1);
    expect(next?.text).toContain("二零二六年");
  });

  it("skips prompts already saved as browser drafts", () => {
    const next = selectNextProfileRecordingScript({
      scripts,
      missingCoverageFeatures: [],
      eligibleClips: 0,
      draftIndices: [0],
    });

    expect(next?.index).toBe(1);
    expect(next?.text).toContain("二零二六年");
  });

  it("returns no next recording when every prompt has a draft", () => {
    const next = selectNextProfileRecordingScript({
      scripts,
      missingCoverageFeatures: [],
      eligibleClips: 0,
      draftIndices: scripts.map((_, index) => index),
    });

    expect(next).toBeNull();
  });

  it("maps fixed profile scripts to accepted, rejected, and missing enrollment states", () => {
    const plan = buildProfileScriptPlan({
      scripts,
      acceptedClips: [
        {
          sourceRunId: "clip-1",
          transcriptRaw: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
        },
      ],
      rejectedClips: [
        {
          sourceRunId: "too-short",
          transcriptRaw: "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。",
          reasons: ["too_short"],
        },
      ],
      missingCoverageFeatures: ["latin_terms", "polyphones"],
    });

    expect(plan.map((item) => item.status)).toEqual(["accepted", "missing", "rejected", "missing"]);
    expect(plan[0]).toMatchObject({ sourceRunId: "clip-1", reasons: [] });
    expect(plan[2]).toMatchObject({ sourceRunId: "too-short", reasons: ["too_short"] });
    expect(plan[2].primaryFeature).toBe("latin_terms");
  });
});

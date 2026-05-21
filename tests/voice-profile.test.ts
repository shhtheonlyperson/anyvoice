import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVoiceProfileSummary, selectVoiceProfileClipForTarget } from "@/lib/voice-profile";

let tmpRoot: string;
const profileTranscriptFixtures = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

async function writeRun(
  id: string,
  quality: { grade: string; durationSec: number; warnings?: string[] },
  options: { transcript?: string; sourceKind?: string } = {},
) {
  const runDir = path.join(tmpRoot, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3]));
  await writeFile(
    path.join(runDir, "prompt-transcript.txt"),
    options.transcript ?? profileTranscriptFixtures[Number(id.replace(/\D/g, "")) - 1] ?? `請錄製聲音樣本 ${id}。`,
    "utf-8",
  );
  await writeFile(path.join(runDir, "target.txt"), "target words", "utf-8");
  if (options.sourceKind) {
    await writeFile(
      path.join(runDir, "request.json"),
      JSON.stringify({ sourceKind: options.sourceKind, referenceSource: { kind: options.sourceKind } }),
      "utf-8",
    );
  }
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify({
      model_id: "openbmb/VoxCPM2",
      clone_mode: "hifi",
      referenceQuality: {
        snrDb: 24,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        ...quality,
        warnings: quality.warnings ?? [],
      },
    }),
    "utf-8",
  );
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("buildVoiceProfileSummary", () => {
  it("marks profiles ready when enough A/B duration-qualified clips exist", async () => {
    await Promise.all([
      writeRun("clip1", { grade: "A", durationSec: 8 }),
      writeRun("clip2", { grade: "A", durationSec: 9 }),
      writeRun("clip3", { grade: "B", durationSec: 10 }),
      writeRun("clip4", { grade: "B", durationSec: 11 }),
      writeRun("clip5", { grade: "A", durationSec: 12 }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.status).toBe("ready");
    expect(profile.summary.selectedClips).toBe(5);
    expect(profile.summary.remainingClipsNeeded).toBe(0);
    expect(profile.referenceClipIds).toHaveLength(5);
    expect(profile.clips[0].transcriptScript).toBe("zh_hant");
    expect(profile.diagnostics.selectedGrades).toEqual([
      { grade: "A", count: 3 },
      { grade: "B", count: 2 },
    ]);
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
  });

  it("rejects short or low-grade clips and reports remaining enrollment need", async () => {
    await Promise.all([
      writeRun("short", { grade: "A", durationSec: 2, warnings: ["short_clip"] }),
      writeRun("bad-grade", { grade: "D", durationSec: 8 }),
      writeRun("usable", { grade: "B", durationSec: 8 }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.status).toBe("needs_enrollment");
    expect(profile.summary.eligibleClips).toBe(1);
    expect(profile.summary.rejectedClips).toBe(2);
    expect(profile.summary.remainingClipsNeeded).toBe(4);
    expect(profile.rejectedClips.find((clip) => clip.sourceRunId === "short")?.reasons).toContain("too_short");
    expect(profile.rejectedClips.find((clip) => clip.sourceRunId === "bad-grade")?.reasons).toContain("grade_d");
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([
        { reason: "grade_d", count: 1 },
        { reason: "too_short", count: 1 },
      ]),
    );
    expect(profile.diagnostics.topRejectedClips[0].sourceRunId).toBe("bad-grade");
  });

  it("rejects Simplified or mixed Chinese transcripts before profile selection", async () => {
    await Promise.all([
      writeRun("mixed-1", { grade: "A", durationSec: 8 }, { transcript: "这个聲音樣本很穩定。" }),
      writeRun("simplified-1", { grade: "A", durationSec: 8 }, { transcript: "这是第一个声音样本。" }),
      writeRun("usable", { grade: "A", durationSec: 8 }, { transcript: "請錄製真實聲音。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.status).toBe("needs_enrollment");
    expect(profile.summary.eligibleClips).toBe(1);
    expect(profile.clips.map((clip) => clip.sourceRunId)).toEqual(["usable"]);
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "mixed-1",
          transcriptScript: "mixed_zh",
          reasons: ["invalid_chinese_script"],
        }),
        expect.objectContaining({
          sourceRunId: "simplified-1",
          transcriptScript: "zh_hans",
          reasons: ["invalid_chinese_script"],
        }),
      ]),
    );
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([{ reason: "invalid_chinese_script", count: 2 }]),
    );
  });

  it("rejects Chinese transcripts without clear Traditional marker evidence before profile selection", async () => {
    await Promise.all([
      writeRun("unproven", { grade: "A", durationSec: 8 }, { transcript: "中文音色自然。" }),
      writeRun("usable", { grade: "A", durationSec: 8 }, { transcript: "請錄製真實聲音。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.status).toBe("needs_enrollment");
    expect(profile.clips.map((clip) => clip.sourceRunId)).toEqual(["usable"]);
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "unproven",
          transcriptScript: "zh_unknown",
          reasons: ["unproven_chinese_script"],
        }),
      ]),
    );
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([{ reason: "unproven_chinese_script", count: 1 }]),
    );
  });

  it("keeps only the best clip for duplicate transcripts", async () => {
    await Promise.all([
      writeRun("same-a", { grade: "B", durationSec: 8 }, { transcript: "同一句聲音樣本。" }),
      writeRun("same-b", { grade: "A", durationSec: 10 }, { transcript: "同一句聲音樣本。" }),
      writeRun("same-c", { grade: "A", durationSec: 9 }, { transcript: "同一句聲音樣本。" }),
      writeRun("unique-1", { grade: "A", durationSec: 8 }, { transcript: "第二句聲音樣本。" }),
      writeRun("unique-2", { grade: "A", durationSec: 8 }, { transcript: "今天是二零二六年五月十九日，我會清楚讀完。" }),
      writeRun("unique-3", { grade: "A", durationSec: 8 }, { transcript: "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。" }),
      writeRun("unique-4", { grade: "A", durationSec: 8 }, { transcript: "我會保持停頓、節奏，讓聲音自然、乾淨。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.status).toBe("ready");
    expect(profile.summary.eligibleClips).toBe(5);
    expect(profile.summary.rejectedClips).toBe(2);
    expect(profile.clips.map((clip) => clip.sourceRunId)).toContain("same-b");
    expect(profile.rejectedClips.filter((clip) => clip.reasons.includes("duplicate_transcript"))).toHaveLength(2);
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([{ reason: "duplicate_transcript", count: 2 }]),
    );
  });

  it("keeps the profile not ready until required pronunciation coverage exists", async () => {
    await Promise.all([
      writeRun("plain-1", { grade: "A", durationSec: 8 }, { transcript: "這是第一段普通聲音樣本。" }),
      writeRun("plain-2", { grade: "A", durationSec: 8 }, { transcript: "這是第二段普通聲音樣本。" }),
      writeRun("plain-3", { grade: "A", durationSec: 8 }, { transcript: "這是第三段普通聲音樣本。" }),
      writeRun("plain-4", { grade: "A", durationSec: 8 }, { transcript: "這是第四段普通聲音樣本。" }),
      writeRun("plain-5", { grade: "A", durationSec: 8 }, { transcript: "這是第五段普通聲音樣本。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.summary.selectedClips).toBe(5);
    expect(profile.status).toBe("needs_enrollment");
    expect(profile.summary.remainingClipsNeeded).toBe(1);
    expect(profile.diagnostics.missingCoverageFeatures).toEqual(
      expect.arrayContaining(["latin_terms", "polyphones", "punctuation_rhythm"]),
    );
  });

  it("keeps the profile not ready until exact required pronunciation presets are covered", async () => {
    await Promise.all([
      writeRun("subset-1", { grade: "A", durationSec: 8 }, { transcript: "這是第一段 AnyVoice、重慶、銀行，二零二六年五月十九日。" }),
      writeRun("subset-2", { grade: "A", durationSec: 8 }, { transcript: "這是第二段 AnyVoice、重慶、銀行，二零二六年五月十九日。" }),
      writeRun("subset-3", { grade: "A", durationSec: 8 }, { transcript: "這是第三段 AnyVoice、重慶、銀行，二零二六年五月十九日。" }),
      writeRun("subset-4", { grade: "A", durationSec: 8 }, { transcript: "這是第四段 AnyVoice、重慶、銀行，二零二六年五月十九日。" }),
      writeRun("subset-5", { grade: "A", durationSec: 8 }, { transcript: "這是第五段 AnyVoice、重慶、銀行，二零二六年五月十九日。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.summary.selectedClips).toBe(5);
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.status).toBe("needs_enrollment");
    expect(profile.diagnostics.missingPronunciationPresetIds).toEqual([
      "polyphone:role",
      "polyphone:music",
      "polyphone:changle",
    ]);
  });

  it("keeps lower-ranked eligible clips when they are needed for pronunciation coverage", async () => {
    await Promise.all([
      writeRun("plain-12", { grade: "A", durationSec: 12 }, { transcript: "你好，我正在錄製聲音樣本。春天的陽光灑在湖面上，世界很安靜。" }),
      writeRun("plain-11", { grade: "A", durationSec: 11 }, { transcript: "請確認錄音環境安靜，沒有回音，也不要離麥克風太近。" }),
      writeRun("rhythm-10", { grade: "A", durationSec: 10 }, { transcript: "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。" }),
      writeRun("date-9", { grade: "A", durationSec: 9 }, { transcript: "今天是二零二六年五月十九日，我會清楚讀完。" }),
      writeRun("english-8", { grade: "A", durationSec: 8 }, { transcript: "我會把 Brenda 與 AnyVoice 的名稱讀清楚。" }),
      writeRun("polyphone-7", { grade: "A", durationSec: 7 }, { transcript: "重慶、銀行、角色、音樂和長樂，這些詞都要讀準。" }),
    ]);

    const profile = await buildVoiceProfileSummary({
      env: { ANYVOICE_RUNS_DIR: tmpRoot },
      requirements: {
        minClips: 5,
        maxClips: 5,
        minDurationSec: 6,
        maxDurationSec: 20,
        passingGrades: ["A", "B"],
        requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
        requiredPronunciationPresetIds: [
          "polyphone:chongqing",
          "polyphone:bank",
          "polyphone:role",
          "polyphone:music",
          "polyphone:changle",
          "brand:anyvoice",
        ],
      },
    });

    expect(profile.status).toBe("ready");
    expect(profile.referenceClipIds).toContain("polyphone-7");
    expect(profile.referenceClipIds).toContain("english-8");
    expect(profile.referenceClipIds).toContain("date-9");
    expect(profile.referenceClipIds).not.toContain("rhythm-10");
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.clips[0].sourceRunId).toBe("plain-12");
  });

  it("selects the profile clip whose transcript covers risky target pronunciation features", async () => {
    await Promise.all([
      writeRun("plain-long", { grade: "A", durationSec: 12 }, { transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。" }),
      writeRun("date", { grade: "A", durationSec: 11 }, { transcript: "今天是二零二六年五月十九日，我會清楚讀完。" }),
      writeRun("terms", { grade: "A", durationSec: 8 }, { transcript: "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。" }),
      writeRun("rhythm", { grade: "A", durationSec: 10 }, { transcript: "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。" }),
      writeRun("clean", { grade: "A", durationSec: 9 }, { transcript: "請確認錄音環境安靜、沒有回音，也不要離麥克風太近。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });
    const selection = selectVoiceProfileClipForTarget(profile, "請用我的聲音說 AnyVoice 和重慶。");

    expect(profile.status).toBe("ready");
    expect(profile.clips[0].sourceRunId).toBe("plain-long");
    expect(selection?.clip.sourceRunId).toBe("terms");
    expect(selection?.targetCoverageFeatures).toEqual(expect.arrayContaining(["latin_terms", "polyphones"]));
    expect(selection?.matchedCoverageFeatures).toEqual(expect.arrayContaining(["latin_terms", "polyphones"]));
    expect(selection?.targetPronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "brand:anyvoice",
    ]);
    expect(selection?.matchedPronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "brand:anyvoice",
    ]);
  });

  it("prefers a profile clip with the exact risky pronunciation term, not just generic polyphone coverage", async () => {
    await Promise.all([
      writeRun("plain-long", { grade: "A", durationSec: 12 }, { transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。" }),
      writeRun("generic-polyphones", { grade: "A", durationSec: 11 }, { transcript: "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。" }),
      writeRun("bank-president", { grade: "A", durationSec: 7 }, { transcript: "請把行長這個詞讀成銀行的行、長官的長，保持清楚自然。" }),
      writeRun("numbers", { grade: "A", durationSec: 10 }, { transcript: "今天是二零二六年五月十九日，我會清楚讀完。" }),
      writeRun("rhythm", { grade: "A", durationSec: 9 }, { transcript: "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });
    const selection = selectVoiceProfileClipForTarget(profile, "請用我的聲音說行長今天會開會。");

    expect(profile.status).toBe("ready");
    expect(profile.clips[0].sourceRunId).toBe("plain-long");
    expect(selection?.clip.sourceRunId).toBe("bank-president");
    expect(selection?.targetPronunciationPresetIds).toEqual(["polyphone:bank-president"]);
    expect(selection?.matchedPronunciationPresetIds).toEqual(["polyphone:bank-president"]);
  });

  it("does not let profile-generated runs enroll themselves again", async () => {
    await Promise.all([
      writeRun("profile-output", { grade: "A", durationSec: 9 }, { sourceKind: "profile" }),
      writeRun("real-recording", { grade: "A", durationSec: 9 }, { transcript: "請錄製真實聲音。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.summary.eligibleClips).toBe(1);
    expect(profile.clips[0].sourceRunId).toBe("real-recording");
    expect(profile.clips[0].transcriptScript).toBe("zh_hant");
    expect(profile.diagnostics.eligibleTranscriptScripts).toEqual([{ script: "zh_hant", count: 1 }]);
  });

  it("does not let sample voice runs enroll into the user's profile", async () => {
    await Promise.all([
      writeRun("sample-output", { grade: "A", durationSec: 9 }, { sourceKind: "sample" }),
      writeRun("real-recording", { grade: "A", durationSec: 9 }, { transcript: "請錄製真實聲音。" }),
    ]);

    const profile = await buildVoiceProfileSummary({ env: { ANYVOICE_RUNS_DIR: tmpRoot } });

    expect(profile.summary.eligibleClips).toBe(1);
    expect(profile.clips[0].sourceRunId).toBe("real-recording");
  });
});

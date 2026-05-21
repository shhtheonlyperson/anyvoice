// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "build_voice_profile.py");

let tmpRoot: string;

async function writeRun(id: string, transcript: string, durationSec = 8): Promise<void> {
  const runDir = path.join(tmpRoot, "runs", id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(runDir, "prompt-transcript.raw.txt"), transcript, "utf-8");
  await writeFile(path.join(runDir, "metadata.json"), JSON.stringify({
    referenceQuality: {
      grade: "A",
      durationSec,
      snrDb: 24,
      clippingRatio: 0,
      vadActiveRatio: 0.8,
      warnings: [],
    },
  }), "utf-8");
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-build-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("build_voice_profile.py", () => {
  it("does not let mixed Chinese transcripts satisfy zh-Hant coverage", async () => {
    await writeRun("mixed-1", "这个聲音樣本很穩定。春天的陽光灑在湖面上，世界顯得安靜。");
    await writeRun("mixed-2", "今天是二零二六年五月十九日，我会用自然速度，把每一句話清楚讀完。");
    await writeRun("mixed-3", "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準，这个名字要清楚。");
    await writeRun("mixed-4", "我会保持停頓、節奏，讓聲音自然、乾淨。");
    await writeRun("mixed-5", "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，这个聲音要自然。");

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("needs_enrollment");
    expect(summary.eligibleClips).toBe(0);
    expect(summary.selectedClips).toBe(0);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toContain("zh_hant");
    expect(profile.diagnostics.coverageFeatures).toEqual([]);
    expect(profile.diagnostics.eligibleTranscriptScripts).toEqual([]);
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "invalid_chinese_script", count: 5 })]),
    );
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "mixed-1",
          transcriptScript: "mixed_zh",
          reasons: ["invalid_chinese_script"],
        }),
      ]),
    );
  });

  it("does not count generic measure words as numbers/date coverage", async () => {
    await writeRun("measure-word", "你好，我正在錄製一段聲音樣本。");

    const outDir = path.join(tmpRoot, "profile");
    await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.clips[0].coverageFeatures).toEqual(["punctuation_rhythm", "zh_hant"]);
    expect(profile.clips[0].sourceKind).toBe("uploaded");
    expect(profile.diagnostics.missingCoverageFeatures).toContain("numbers_dates");
  });

  it("keeps the profile not ready when broad polyphone coverage lacks exact required pronunciation presets", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`subset-${index}`, `這是第 ${index} 段 AnyVoice、重慶、銀行，二零二六年五月十九日。`);
    }

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("needs_enrollment");

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.diagnostics.missingPronunciationPresetIds).toEqual([
      "polyphone:role",
      "polyphone:music",
      "polyphone:changle",
    ]);
  });

  it("rejects duplicate transcripts and keeps the best matching clip", async () => {
    await writeRun("same-a", "同一句聲音樣本。", 8);
    await writeRun("same-b", "同一句聲音樣本。", 10);
    await writeRun("unique-1", "第二句聲音樣本。", 8);
    await writeRun("unique-2", "今天是二零二六年五月十九日，我會清楚讀完。", 8);
    await writeRun("unique-3", "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。", 8);
    await writeRun("unique-4", "我會保持停頓、節奏，讓聲音自然、乾淨。", 8);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("ready");
    expect(summary.eligibleClips).toBe(5);
    expect(summary.selectedClips).toBe(5);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.referenceClipIds).toContain("same-b");
    expect(profile.referenceClipIds).not.toContain("same-a");
    expect(profile.clips.find((clip: { sourceRunId: string }) => clip.sourceRunId === "unique-3")?.pronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "polyphone:bank",
      "polyphone:role",
      "polyphone:music",
      "polyphone:changle",
      "brand:anyvoice",
    ]);
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "same-a",
          reasons: ["duplicate_transcript"],
        }),
      ]),
    );
  });

  it("keeps lower-ranked eligible clips when they are needed for pronunciation coverage", async () => {
    await writeRun("plain-12", "你好，我正在錄製聲音樣本。春天的陽光灑在湖面上，世界顯得安靜。", 12);
    await writeRun("plain-11", "請確認錄音環境安靜，沒有回音，也不要離麥克風太近。", 11);
    await writeRun("rhythm-10", "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。", 10);
    await writeRun("date-9", "今天是二零二六年五月十九日，我會清楚讀完。", 9);
    await writeRun("english-8", "我會把 Brenda 與 AnyVoice 的名稱讀清楚。", 8);
    await writeRun("polyphone-7", "重慶、銀行、角色、音樂和長樂，這些詞都要讀準。", 7);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
      "--max-clips",
      "5",
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("ready");
    expect(summary.selectedClips).toBe(5);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.referenceClipIds).toContain("polyphone-7");
    expect(profile.referenceClipIds).toContain("english-8");
    expect(profile.referenceClipIds).toContain("date-9");
    expect(profile.referenceClipIds).not.toContain("rhythm-10");
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.diagnostics.coverageFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "polyphones" }),
        expect.objectContaining({ feature: "latin_terms" }),
        expect.objectContaining({ feature: "numbers_dates" }),
        expect.objectContaining({ feature: "punctuation_rhythm" }),
        expect.objectContaining({ feature: "zh_hant" }),
      ]),
    );
  });

  it("skips sample-source runs when building the user voice profile", async () => {
    await writeRun("sample-output", "示範聲音不能加入聲音檔案。", 8);
    await writeFile(
      path.join(tmpRoot, "runs", "sample-output", "request.json"),
      JSON.stringify({ sourceKind: "sample", referenceSource: { kind: "sample" } }),
      "utf-8",
    );
    await writeRun("real-recording", "請錄製真實聲音。", 8);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.eligibleClips).toBe(1);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.referenceClipIds).toEqual(["real-recording"]);
  });
});

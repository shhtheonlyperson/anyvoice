// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "validate_voice_profile_transcripts.py");

let tmpRoot: string;

async function writeProfile(): Promise<{ profilePath: string; asrPath: string }> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const clips = [];
  const transcripts = [
    "你好，我正在錄製一段聲音樣本。",
    "今天是二零二六年五月十九日。",
  ];
  for (let index = 0; index < transcripts.length; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index + 1}.wav`);
    await writeFile(audioPath, Buffer.from([index + 1, index + 2, index + 3]));
    clips.push({
      sourceRunId: `clip-${index + 1}`,
      audioPath,
      transcriptRaw: transcripts[index],
      transcriptScript: "zh_hant",
      coverageFeatures: ["zh_hant"],
      quality: {
        grade: "A",
        durationSec: 8,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    });
  }
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify({
      version: 1,
      voiceProfileId: "local-test",
      status: "ready",
      requirements: { maxClips: 10 },
      clips,
    }, null, 2)}\n`,
    "utf-8",
  );
  const asrPath = path.join(tmpRoot, "asr.json");
  await writeFile(
    asrPath,
    `${JSON.stringify({
      transcripts: clips.map((clip) => ({
        sourceRunId: clip.sourceRunId,
        audioPath: clip.audioPath,
        transcript: clip.transcriptRaw,
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
  return { profilePath, asrPath };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-transcript-validation-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("validate_voice_profile_transcripts.py", () => {
  it("passes selected profile clips when ASR matches the reference transcripts", async () => {
    const { profilePath, asrPath } = await writeProfile();
    const outPath = path.join(tmpRoot, "validation.json");
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--asr-json",
      asrPath,
      "--out",
      outPath,
      "--strict",
    ]);

    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      status: "pass",
      total: 2,
      passed: 2,
      failed: 0,
      backend: "external-asr",
    });
    await expect(stat(outPath)).resolves.toMatchObject({ size: expect.any(Number) });
    const report = JSON.parse(await readFile(outPath, "utf-8"));
    expect(report.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.clips.every((clip: { verdict: string }) => clip.verdict === "pass")).toBe(true);
  });

  it("does not fail profile validation only because ASR returns Simplified Chinese glyphs", async () => {
    const { profilePath, asrPath } = await writeProfile();
    const asr = JSON.parse(await readFile(asrPath, "utf-8"));
    asr.transcripts[0].transcript = "你好，我正在录制一段声音样本。";
    asr.transcripts[1].transcript = "今天是二零二六年五月十九日。";
    await writeFile(asrPath, `${JSON.stringify(asr, null, 2)}\n`, "utf-8");
    const outPath = path.join(tmpRoot, "simplified-asr-validation.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--asr-json",
      asrPath,
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "pass",
      total: 2,
      passed: 2,
      failed: 0,
    });
    const report = JSON.parse(await readFile(outPath, "utf-8"));
    expect(report.textScoringPolicy.zhScriptEquivalence).toBe("common_simplified_to_traditional");
  });

  it("does not fail profile validation only because ASR returns Arabic date digits", async () => {
    const { profilePath, asrPath } = await writeProfile();
    const asr = JSON.parse(await readFile(asrPath, "utf-8"));
    asr.transcripts[1].transcript = "今天是2026年5月19日。";
    await writeFile(asrPath, `${JSON.stringify(asr, null, 2)}\n`, "utf-8");
    const outPath = path.join(tmpRoot, "arabic-date-validation.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--asr-json",
      asrPath,
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "pass",
      total: 2,
      passed: 2,
      failed: 0,
    });
  });

  it("does not fail profile validation only because ASR truncates a known brand name", async () => {
    const { profilePath, asrPath } = await writeProfile();
    const profile = JSON.parse(await readFile(profilePath, "utf-8"));
    profile.clips[0].transcriptRaw = "遇到英文或產品名稱時，例如 OpenAI、Mac Studio、VoxCPM2 和 TestFlight，我會用平常說話的方式讀出來。";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
    const asr = JSON.parse(await readFile(asrPath, "utf-8"));
    asr.transcripts[0].transcript = "遇到英文或产品名称时,例如OpenAI, MacStudio, VoxCPM2和TestFly,我会用平常说话的方式读出来。";
    await writeFile(asrPath, `${JSON.stringify(asr, null, 2)}\n`, "utf-8");
    const outPath = path.join(tmpRoot, "brand-asr-validation.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--asr-json",
      asrPath,
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "pass",
      total: 2,
      passed: 2,
      failed: 0,
    });
    const report = JSON.parse(await readFile(outPath, "utf-8"));
    expect(report.textScoringPolicy.brandEquivalence).toBe("common_asr_brand_variants");
  });

  it("fails strict validation when ASR contradicts a profile transcript", async () => {
    const { profilePath, asrPath } = await writeProfile();
    const asr = JSON.parse(await readFile(asrPath, "utf-8"));
    asr.transcripts[0].transcript = "完全不同的句子";
    await writeFile(asrPath, `${JSON.stringify(asr, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--asr-json",
        asrPath,
        "--out",
        path.join(tmpRoot, "bad-validation.json"),
        "--strict",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "blocked"'),
    });
  });
});

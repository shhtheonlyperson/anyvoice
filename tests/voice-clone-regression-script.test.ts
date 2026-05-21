// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "voice_clone_regression.py");

let tmpRoot: string;
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-regression-script-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeTranscriptValidation(
  profilePath: string,
  sourceRunIds: string[],
  { status = "pass", failedSourceRunId = "" }: { status?: string; failedSourceRunId?: string } = {},
): Promise<string> {
  const validationPath = path.join(path.dirname(profilePath), "transcript-validation.json");
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const clipById = new Map(profile.clips.map((clip) => [clip.sourceRunId, clip]));
  await writeFile(
    validationPath,
    `${JSON.stringify({
      version: 1,
      profile: profilePath,
      status,
      summary: {
        total: sourceRunIds.length,
        passed: sourceRunIds.filter((id) => id !== failedSourceRunId).length,
        failed: failedSourceRunId ? 1 : 0,
      },
      clips: sourceRunIds.map((sourceRunId) => {
        const clip = clipById.get(sourceRunId);
        return {
          sourceRunId,
          expectedTranscript: clip?.transcriptRaw ?? "",
          audioPath: clip?.audioPath ?? "",
          verdict: sourceRunId === failedSourceRunId ? "fail" : "pass",
          cer: { rate: sourceRunId === failedSourceRunId ? 0.4 : 0 },
          wer: { rate: sourceRunId === failedSourceRunId ? 0.4 : 0 },
        };
      }),
    }, null, 2)}\n`,
    "utf-8",
  );
  return validationPath;
}

async function writeStrictReadyProfile(name = "profile-match"): Promise<{
  profilePath: string;
  transcriptValidation: string;
  sourceRunIds: string[];
}> {
  const profileDir = path.join(tmpRoot, name);
  await mkdir(profileDir, { recursive: true });
  const clipSpecs = [
    {
      sourceRunId: "plain",
      transcriptRaw: "你好，我正在錄製一段穩定聲音樣本。世界很安靜。",
      coverageFeatures: ["zh_hant", "punctuation_rhythm"],
    },
    {
      sourceRunId: "terms",
      transcriptRaw: "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。",
      coverageFeatures: ["zh_hant", "latin_terms", "polyphones", "punctuation_rhythm"],
    },
    {
      sourceRunId: "bank-president",
      transcriptRaw: "請把行長這個詞讀成銀行的行、長官的長，保持清楚自然。",
      coverageFeatures: ["zh_hant", "polyphones", "punctuation_rhythm"],
    },
    {
      sourceRunId: "numbers",
      transcriptRaw: "這是二零二六年五月十九日，下午三點二十分，請保持穩定。",
      coverageFeatures: ["zh_hant", "numbers_dates", "punctuation_rhythm"],
    },
    {
      sourceRunId: "rhythm",
      transcriptRaw: "請保持自然停頓，先慢一點，再回到平常速度。",
      coverageFeatures: ["zh_hant", "punctuation_rhythm"],
    },
    {
      sourceRunId: "steady",
      transcriptRaw: "這段聲音要穩定、清楚、不要忽快忽慢。",
      coverageFeatures: ["zh_hant", "punctuation_rhythm"],
    },
  ];
  const clips = [];
  for (let index = 0; index < clipSpecs.length; index += 1) {
    const spec = clipSpecs[index];
    const audioPath = path.join(profileDir, `${spec.sourceRunId}.wav`);
    await writeFile(audioPath, Buffer.from([index + 1, index + 2, index + 3]));
    clips.push({
      ...spec,
      audioPath,
      transcriptScript: "zh_hant",
      sourceKind: "scripted",
      quality: {
        grade: index === clipSpecs.length - 1 ? "B" : "A",
        durationSec: 7,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    });
  }
  const sourceRunIds = clipSpecs.map((clip) => clip.sourceRunId);
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify({
      version: 1,
      voiceProfileId: "local-test",
      status: "ready",
      requirements: {
        minClips: 5,
        maxClips: 10,
        minDurationSec: 6,
        maxDurationSec: 20,
        passingGrades: ["A", "B"],
        requiredCoverageFeatures: coverage,
      },
      summary: { selectedClips: sourceRunIds.length, eligibleClips: sourceRunIds.length, rejectedClips: 0, remainingClipsNeeded: 0 },
      diagnostics: { missingCoverageFeatures: [] },
      referenceClipIds: sourceRunIds,
      preferredPromptClipId: "plain",
      clips,
      rejectedClips: [],
      loraPath: null,
    }, null, 2)}\n`,
    "utf-8",
  );
  const transcriptValidation = await writeTranscriptValidation(profilePath, sourceRunIds);
  return { profilePath, transcriptValidation, sourceRunIds };
}

describe("voice_clone_regression.py", () => {
  it("writes a blind A/B review HTML report for paired prompt and hifi renders", async () => {
    const { stdout } = await execFileAsync(python, [
      script,
      "--dry-run",
      "--clone-mode",
      "both",
      "--repeats",
      "1",
      "--case",
      "zh_hant_polyphones",
      "--out-dir",
      tmpRoot,
    ]);
    const payload = JSON.parse(stdout) as { report: string; html: string; groups: number };
    expect(payload.groups).toBe(2);

    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    expect(report.groups.map((group: { cloneMode: string }) => group.cloneMode).sort()).toEqual(["hifi", "prompt"]);
    const firstRender = report.groups[0].renders[0];
    expect(report.stabilitySeed).toBe(1337);
    expect(firstRender.stabilitySeed).toBe(1337);
    expect(firstRender.command).toContain("--seed 1337");
    expect(firstRender.textPreparation.targetText.model).toBe(
      "重 慶、銀 行、角 色、音 樂、長 樂這幾個詞，不要因為上下文不夠清楚就讀錯。",
    );
    expect(firstRender.textPreparation.targetText.operations).toContain("auto_apply_pronunciation_presets");
    expect(firstRender.targetTextRawFile).toMatch(/target\.raw\.txt$/);
    expect(firstRender.textPrepFile).toMatch(/text-prep\.json$/);
    await expect(readFile(firstRender.targetTextRawFile, "utf-8")).resolves.toContain("重慶、銀行、角色、音樂、長樂");
    await expect(readFile(firstRender.targetTextFile, "utf-8")).resolves.toContain("重 慶、銀 行、角 色、音 樂、長 樂");
    const textPrep = JSON.parse(await readFile(firstRender.textPrepFile, "utf-8"));
    expect(textPrep.targetText.pronunciationOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "重慶", replacement: "重 慶", presetId: "polyphone:chongqing" }),
        expect.objectContaining({ term: "銀行", replacement: "銀 行", presetId: "polyphone:bank" }),
      ]),
    );

    const html = await readFile(payload.html, "utf-8");
    expect(html).toContain("AnyVoice Blind A/B Review");
    expect(html).toContain("Sample A");
    expect(html).toContain("Sample B");
    expect(html).toContain("Best overall");
    expect(html).toContain("Tie / no clear winner");
    expect(html).toContain("Export review JSON");
    expect(html).toContain("Download review.json");
    expect(html).toContain("reportSha256");
    expect(html).toContain("expectedSaveAs");
    expect(html).toContain(path.join(tmpRoot, "review.json"));
    expect(html).toContain("Reveal key after listening");
    expect(html).not.toContain("prompt / zh_hant_polyphones");
    expect(html).not.toContain("hifi / zh_hant_polyphones");
  });

  it("rejects Simplified or mixed Chinese eval cases for profile-based regression", async () => {
    const profileDir = path.join(tmpRoot, "profile");
    await mkdir(profileDir, { recursive: true });
    const profilePath = path.join(profileDir, "profile.json");
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-test",
        referenceClipIds: ["clip-1"],
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: "clip-1.wav",
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const evalPath = path.join(tmpRoot, "eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "simplified-polyphone",
            text: "请用我的声音说银行和重庆。",
            tags: ["polyphone"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--profile-json",
        profilePath,
        "--eval-set",
        evalPath,
        "--out-dir",
        path.join(tmpRoot, "out"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires clear Traditional Chinese target text"),
    });
  });

  it("rejects Simplified target cases that only use common speech markers", async () => {
    const profileDir = path.join(tmpRoot, "profile-common-simplified");
    await mkdir(profileDir, { recursive: true });
    const profilePath = path.join(profileDir, "profile.json");
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-test",
        referenceClipIds: ["clip-1"],
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: "clip-1.wav",
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const evalPath = path.join(tmpRoot, "speech-marker-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "simplified-speech-marker",
            text: "我想说话。",
            tags: ["script-risk"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--profile-json",
        profilePath,
        "--eval-set",
        evalPath,
        "--out-dir",
        path.join(tmpRoot, "speech-marker-out"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires clear Traditional Chinese target text"),
    });
  });

  it("rejects unproven Chinese target cases for profile-based regression", async () => {
    const profileDir = path.join(tmpRoot, "profile-unproven-target");
    await mkdir(profileDir, { recursive: true });
    const profilePath = path.join(profileDir, "profile.json");
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-test",
        referenceClipIds: ["clip-1"],
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: "clip-1.wav",
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const evalPath = path.join(tmpRoot, "unproven-target-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "unproven-chinese",
            text: "中文音色自然。",
            tags: ["script-risk"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--profile-json",
        profilePath,
        "--eval-set",
        evalPath,
        "--out-dir",
        path.join(tmpRoot, "unproven-target-out"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("clear Traditional Chinese target text"),
    });
  });

  it("selects the profile reference clip that matches target pronunciation coverage", async () => {
    const { profilePath, transcriptValidation } = await writeStrictReadyProfile();
    const evalPath = path.join(tmpRoot, "coverage-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "target-risky-terms",
            text: "請用我的聲音說 AnyVoice 和重慶。",
            tags: ["polyphone", "mixed-language"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--dry-run",
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--eval-set",
      evalPath,
      "--clone-mode",
      "hifi",
      "--repeats",
      "1",
      "--out-dir",
      path.join(tmpRoot, "coverage-out"),
    ]);

    const payload = JSON.parse(stdout);
    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    const render = report.groups[0].renders[0];
    expect(render.profileClipId).toBe("terms");
    expect(render.promptTextFile).toMatch(/reference_prompt\.txt$/);
    await expect(readFile(render.promptTextFile, "utf-8")).resolves.toContain("AnyVoice");
    expect(render.targetCoverageFeatures).toEqual(expect.arrayContaining(["latin_terms", "polyphones"]));
    expect(render.matchedCoverageFeatures).toEqual(expect.arrayContaining(["latin_terms", "polyphones"]));
    expect(render.targetPronunciationPresetIds).toEqual(["polyphone:chongqing", "brand:anyvoice"]);
    expect(render.matchedPronunciationPresetIds).toEqual(["polyphone:chongqing", "brand:anyvoice"]);
    expect(report.voiceProfile.profileProof).toMatchObject({
      status: "strict_ready",
      strictProfileProofRequired: true,
      transcriptValidationJson: await realpath(transcriptValidation),
    });
  });

  it("selects exact profile pronunciation preset coverage over generic polyphone coverage", async () => {
    const { profilePath, transcriptValidation } = await writeStrictReadyProfile("profile-exact-pronunciation");
    const evalPath = path.join(tmpRoot, "exact-pronunciation-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "target-bank-president",
            text: "請用我的聲音說行長今天會開會。",
            tags: ["polyphone"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--dry-run",
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--eval-set",
      evalPath,
      "--clone-mode",
      "hifi",
      "--repeats",
      "1",
      "--out-dir",
      path.join(tmpRoot, "exact-pronunciation-out"),
    ]);

    const payload = JSON.parse(stdout);
    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    const render = report.groups[0].renders[0];
    expect(render.profileClipId).toBe("bank-president");
    expect(render.targetPronunciationPresetIds).toEqual(["polyphone:bank-president"]);
    expect(render.matchedPronunciationPresetIds).toEqual(["polyphone:bank-president"]);
    await expect(readFile(render.promptTextFile, "utf-8")).resolves.toContain("行長");
  });

  it("requires strict profile readiness before profile-based regression", async () => {
    const clipAudio = path.join(tmpRoot, "single-clip.wav");
    const profilePath = path.join(tmpRoot, "single-profile.json");
    await writeFile(clipAudio, Buffer.from([1, 2, 3]));
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-test",
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: clipAudio,
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
            sourceKind: "scripted",
            coverageFeatures: ["zh_hant"],
            quality: { grade: "A", durationSec: 8, warnings: [] },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const transcriptValidation = await writeTranscriptValidation(profilePath, ["clip-1"]);

    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--case",
        "zh_hant_polyphones",
        "--out-dir",
        path.join(tmpRoot, "single-profile-out"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires strict ready profile proof"),
    });
  });

  it("applies eval-case custom pronunciation repairs to model-facing regression text", async () => {
    const evalPath = path.join(tmpRoot, "repair-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "custom-readings",
            text: "這次請把行長、長樂和 TSMC 的讀法固定下來。",
            tags: ["repair"],
            pronunciationOverrides: [
              "pinyin:行長=xing2 zhang3",
              "長樂[reading]=chang2 le4",
              { term: "TSMC", replacement: "T S M C", kind: "brand" },
            ],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--dry-run",
      "--eval-set",
      evalPath,
      "--case",
      "custom-readings",
      "--clone-mode",
      "hifi",
      "--repeats",
      "1",
      "--out-dir",
      path.join(tmpRoot, "repair-out"),
    ]);

    const payload = JSON.parse(stdout);
    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    const render = report.groups[0].renders[0];
    expect(render.stabilitySeed).toBe(1337);
    expect(render.textPreparation.targetText.model).toBe(
      "這次請把xing2 zhang3、chang2 le4和 T S M C 的讀法固定下來。",
    );
    expect(render.textPreparation.targetText.pronunciationOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom" }),
        expect.objectContaining({ term: "長樂", replacement: "chang2 le4", kind: "reading", source: "custom" }),
        expect.objectContaining({ term: "TSMC", replacement: "T S M C", kind: "brand", source: "custom" }),
      ]),
    );
    await expect(readFile(render.targetTextRawFile, "utf-8")).resolves.toContain("行長、長樂和 TSMC");
    await expect(readFile(render.targetTextFile, "utf-8")).resolves.toContain("xing2 zhang3、chang2 le4和 T S M C");
  });
});

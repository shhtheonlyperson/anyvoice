// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "score_voice_regression.py");

let tmpRoot: string;

function reportJson({
  text = "重慶、角色和 AnyVoice 都要讀準。",
  stability = {
    verdict: "pass",
    durationSpanPct: 1.5,
    rmsSpanDb: 0.4,
    minPairwiseWaveformCorr: 0.92,
  },
}: {
  text?: string;
  stability?: Record<string, unknown>;
} = {}) {
  return {
    version: 1,
    groups: [
      {
        cloneMode: "hifi",
        case: {
          id: "zh_hant_polyphones",
          locale: "zh-Hant",
          tags: ["polyphone"],
          text,
        },
        stability,
        renders: [
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 1,
            status: "ready",
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r01", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 2,
            status: "ready",
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r02", "output.wav"),
          },
        ],
      },
    ],
  };
}

function pairedReportJson() {
  const base = reportJson({ text: "重慶角色" }).groups[0];
  return {
    version: 1,
    groups: [
      {
        ...base,
        cloneMode: "prompt",
        renders: [
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "prompt",
            repeat: 1,
            status: "ready",
            outputWav: path.join(tmpRoot, "prompt", "zh_hant_polyphones", "r01", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "prompt",
            repeat: 2,
            status: "ready",
            outputWav: path.join(tmpRoot, "prompt", "zh_hant_polyphones", "r02", "output.wav"),
          },
        ],
      },
      {
        ...base,
        cloneMode: "hifi",
        renders: [
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 1,
            status: "ready",
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r01", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 2,
            status: "ready",
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r02", "output.wav"),
          },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-score-regression-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("score_voice_regression.py", () => {
  it("scores ASR CER/WER and repeat stability as a pass", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      avgCer: 0,
      avgWer: 0,
      missingAsrGroups: 0,
      stabilityReviewGroups: 0,
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.verdict).toBe("pass");
    expect(score.groups[0]).toMatchObject({
      pronunciationVerdict: "pass",
      stabilityVerdict: "pass",
      avgCer: 0,
      avgWer: 0,
    });
  });

  it("treats Simplified Chinese ASR glyphs as script-equivalent for pronunciation scoring", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重庆、角色和 AnyVoice 都要读准。",
          "hifi/zh_hant_polyphones/r02": "重庆、角色和 AnyVoice 都要读准。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      avgCer: 0,
      avgWer: 0,
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.textScoringPolicy.zhScriptEquivalence).toBe("common_simplified_to_traditional");
  });

  it("blocks strict scores when the selected profile reference misses exact pronunciation preset coverage", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const report = reportJson({ text: "請用我的聲音說行長今天會開會。" });
    for (const render of report.groups[0].renders) {
      Object.assign(render, {
        profileClipId: "generic-polyphones",
        targetPronunciationPresetIds: ["polyphone:bank-president"],
        matchedPronunciationPresetIds: ["polyphone:chongqing"],
      });
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "請用我的聲音說行長今天會開會。",
          "hifi/zh_hant_polyphones/r02": "請用我的聲音說行長今天會開會。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--strict"]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"profileReferenceReviewGroups": 1'),
    });
  });

  it("scores model-facing pronunciation preset text as equivalent to the raw target", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score.json");
    const report = reportJson({ text: "請整理 VoxCPM2 的測試結果。" });
    for (const render of report.groups[0].renders) {
      (render as Record<string, unknown>).textPreparation = {
        targetText: {
          raw: "請整理 VoxCPM2 的測試結果。",
          model: "請整理 Vox C P M two 的測試結果。",
          pronunciationOverrides: [
            {
              term: "VoxCPM2",
              replacement: "Vox C P M two",
              kind: "brand",
              source: "preset",
              presetId: "brand:voxcpm2",
              count: 1,
            },
          ],
        },
      };
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "請整理 Vox C P M two 的測試結果。",
          "hifi/zh_hant_polyphones/r02": "請整理 Vox C P M two 的測試結果。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      avgCer: 0,
      avgWer: 0,
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.textScoringPolicy.pronunciationPresetEquivalence).toBe(
      "score_best_of_raw_target_and_model_facing_target",
    );
    expect(score.groups[0].renders[0]).toMatchObject({
      scoringTarget: {
        kind: "model",
        text: "請整理 Vox C P M two 的測試結果。",
      },
      cer: { rate: 0 },
      wer: { rate: 0 },
    });
    expect(score.groups[0].renders[0].targetCandidates).toHaveLength(2);
  });

  it("marks missing ASR as review and strict exits non-zero", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(), null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, reportPath, "--strict"])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"missingAsrGroups": 1'),
    });
  });

  it("compares current pronunciation score against a baseline score", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const baselinePath = path.join(tmpRoot, "baseline.score.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson({ text: "重慶角色" }), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      baselinePath,
      `${JSON.stringify(
        {
          version: 1,
          verdict: "review",
          summary: {
            avgCer: 0.5,
            avgWer: 0.5,
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--baseline-score", baselinePath, "--out", outPath]);
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.baselineComparison).toMatchObject({
      verdict: "pass",
      cerReductionPct: 100,
      werReductionPct: 100,
    });
    expect(score.verdict).toBe("pass");
  });

  it("can require hifi to beat prompt in the same paired regression report", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      reportPath,
      "--asr-json",
      asrPath,
      "--out",
      outPath,
      "--baseline-clone-mode",
      "prompt",
      "--candidate-clone-mode",
      "hifi",
      "--require-paired-improvement",
      "--strict",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      pairedComparisonVerdict: "pass",
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison).toMatchObject({
      verdict: "pass",
      summary: {
        pairs: 1,
        passingPairs: 1,
        avgCerReductionPct: 100,
        avgWerReductionPct: 100,
      },
    });
  });

  it("fails strict paired comparison when hifi does not improve enough over prompt", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶脚色",
          "hifi/zh_hant_polyphones/r02": "重慶脚色",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        reportPath,
        "--asr-json",
        asrPath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "hifi",
        "--min-paired-reduction-pct",
        "75",
        "--require-paired-improvement",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"pairedComparisonVerdict": "review"'),
    });
  });

  it("adds speaker identity to the strict pass gate when speaker similarity is provided", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const speakerPath = path.join(tmpRoot, "speaker.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      speakerPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": 0.84,
          "hifi/zh_hant_polyphones/r02": 0.82,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      reportPath,
      "--asr-json",
      asrPath,
      "--speaker-json",
      speakerPath,
      "--out",
      outPath,
      "--strict",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      avgSpeakerSimilarity: 0.83,
      speakerReviewGroups: 0,
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0]).toMatchObject({
      speakerIdentityVerdict: "pass",
      speakerIdentity: {
        avgSpeakerSimilarity: 0.83,
        minSpeakerSimilarityObserved: 0.82,
      },
    });
  });

  it("rejects strict scores when speaker similarity is below the identity threshold", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const speakerPath = path.join(tmpRoot, "speaker.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      speakerPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": 0.84,
          "hifi/zh_hant_polyphones/r02": 0.61,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        reportPath,
        "--asr-json",
        asrPath,
        "--speaker-json",
        speakerPath,
        "--min-speaker-similarity",
        "0.72",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"speakerReviewGroups": 1'),
    });
  });
});

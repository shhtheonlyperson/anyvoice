// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "score_voice_regression.py");

let tmpRoot: string;

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function audioMetrics({ durationSec = 1.2, clippingRatio = 0 }: { durationSec?: number; clippingRatio?: number } = {}) {
  return {
    available: true,
    sampleRate: 24000,
    durationSec,
    peak: clippingRatio > 0 ? 0.999 : 0.42,
    rmsDbfs: -18.5,
    clippingRatio,
  };
}

async function writeRenderOutputProofs(report: ReturnType<typeof reportJson>, audio = Buffer.from("render wav bytes\n")) {
  for (const group of report.groups) {
    for (const render of group.renders as Array<Record<string, unknown> & { outputWav: string }>) {
      await mkdir(path.dirname(render.outputWav), { recursive: true });
      await writeFile(render.outputWav, audio);
      render.outputExists = true;
      render.missingOutput = false;
      render.outputBytes = audio.byteLength;
      render.outputSha256 = sha256Buffer(audio);
    }
  }
}

function reportJson({
  text = "重慶、角色和 AnyVoice 都要讀準。",
  stability = {
    verdict: "pass",
    durationSpanPct: 1.5,
    rmsSpanDb: 0.4,
    minPairwiseWaveformCorr: 0.92,
  },
  voiceProfile = false,
}: {
  text?: string;
  stability?: Record<string, unknown>;
  voiceProfile?: boolean;
} = {}) {
  return {
    version: 1,
    ...(voiceProfile ? { voiceProfile: { voiceProfileId: "local-test", profileSha256: "f".repeat(64) } } : {}),
    groups: [
      {
        cloneMode: "hifi",
        ...(voiceProfile ? { voiceProfileId: "local-test", profileSha256: "f".repeat(64) } : {}),
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
            renderSeconds: 8.2,
            audioMetrics: audioMetrics({ durationSec: 1.2 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r01", "output.wav"),
            ...(voiceProfile ? { voiceProfileId: "local-test", profileSha256: "f".repeat(64), profileClipId: "profile-clip-01" } : {}),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 2,
            status: "ready",
            renderSeconds: 8.4,
            audioMetrics: audioMetrics({ durationSec: 1.22 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r02", "output.wav"),
            ...(voiceProfile ? { voiceProfileId: "local-test", profileSha256: "f".repeat(64), profileClipId: "profile-clip-01" } : {}),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 3,
            status: "ready",
            renderSeconds: 8.3,
            audioMetrics: audioMetrics({ durationSec: 1.21 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r03", "output.wav"),
            ...(voiceProfile ? { voiceProfileId: "local-test", profileSha256: "f".repeat(64), profileClipId: "profile-clip-01" } : {}),
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
            renderSeconds: 10.1,
            audioMetrics: audioMetrics({ durationSec: 1.4 }),
            outputWav: path.join(tmpRoot, "prompt", "zh_hant_polyphones", "r01", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "prompt",
            repeat: 2,
            status: "ready",
            renderSeconds: 10.3,
            audioMetrics: audioMetrics({ durationSec: 1.42 }),
            outputWav: path.join(tmpRoot, "prompt", "zh_hant_polyphones", "r02", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "prompt",
            repeat: 3,
            status: "ready",
            renderSeconds: 10.2,
            audioMetrics: audioMetrics({ durationSec: 1.41 }),
            outputWav: path.join(tmpRoot, "prompt", "zh_hant_polyphones", "r03", "output.wav"),
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
            renderSeconds: 9.2,
            audioMetrics: audioMetrics({ durationSec: 1.3 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r01", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 2,
            status: "ready",
            renderSeconds: 9.4,
            audioMetrics: audioMetrics({ durationSec: 1.31 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r02", "output.wav"),
          },
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat: 3,
            status: "ready",
            renderSeconds: 9.3,
            audioMetrics: audioMetrics({ durationSec: 1.305 }),
            outputWav: path.join(tmpRoot, "hifi", "zh_hant_polyphones", "r03", "output.wav"),
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
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
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
    expect(score.sourceReportSha256).toBe(sha256Buffer(await readFile(reportPath)));
    expect(score.asrJsonSha256).toBe(sha256Buffer(await readFile(asrPath)));
    expect(score.speakerJsonSha256).toBeNull();
    expect(score.verdict).toBe("pass");
    expect(score.groups[0]).toMatchObject({
      pronunciationVerdict: "pass",
      stabilityVerdict: "pass",
      avgCer: 0,
      avgWer: 0,
    });
  });

  it("blocks strict scores when a render clips above the audio-quality threshold", async () => {
    const reportPath = path.join(tmpRoot, "clipped-report.json");
    const asrPath = path.join(tmpRoot, "clipped-asr.json");
    const outPath = path.join(tmpRoot, "clipped-score.json");
    const report = reportJson();
    report.groups[0].renders[0].audioMetrics = audioMetrics({ durationSec: 1.2, clippingRatio: 0.02 });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"audioQualityReviewGroups": 1'),
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0]).toMatchObject({
      audioQualityVerdict: "review",
      audioQuality: {
        maxClippingRatio: 0.02,
        reasons: expect.arrayContaining(["clipping_above_threshold"]),
      },
    });
  });

  it("blocks strict scores when stability has fewer than three successful repeats", async () => {
    const reportPath = path.join(tmpRoot, "two-repeat-report.json");
    const asrPath = path.join(tmpRoot, "two-repeat-asr.json");
    const outPath = path.join(tmpRoot, "two-repeat-score.json");
    const report = reportJson();
    report.groups[0].renders = report.groups[0].renders.slice(0, 2);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
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

    await expect(execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"stabilityReviewGroups": 1'),
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0]).toMatchObject({
      stabilityVerdict: "review",
      stability: {
        successfulRepeats: 2,
        minSuccessfulRepeats: 3,
        reasons: expect.arrayContaining(["too_few_successful_repeats"]),
      },
    });
  });

  it("blocks strict scores when stability verdict lacks measured metrics", async () => {
    const reportPath = path.join(tmpRoot, "missing-stability-metrics-report.json");
    const asrPath = path.join(tmpRoot, "missing-stability-metrics-asr.json");
    const outPath = path.join(tmpRoot, "missing-stability-metrics-score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson({ stability: { verdict: "pass" } }), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"stabilityReviewGroups": 1'),
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0]).toMatchObject({
      stabilityVerdict: "review",
      stability: {
        reasons: expect.arrayContaining([
          "missing_duration_span_pct",
          "missing_rms_span_db",
          "missing_waveform_correlation",
        ]),
      },
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
          "hifi/zh_hant_polyphones/r03": "重庆、角色和 AnyVoice 都要读准。",
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

  it("treats ASR 干净 as equivalent to target 乾淨 for pronunciation scoring", async () => {
    const reportPath = path.join(tmpRoot, "ganjing-report.json");
    const asrPath = path.join(tmpRoot, "ganjing-asr.json");
    const outPath = path.join(tmpRoot, "ganjing-score.json");
    const report = reportJson({
      text: "如果今天的錄音品質夠乾淨，這個聲音應該要自然、穩定，而且每一次重新產生都聽起來像同一個人。",
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "如果今天的录音品质够干净这个声音应该要自然稳定而且每一次重新产生都听起来像同一个人",
          "hifi/zh_hant_polyphones/r02": "如果今天的录音品质够干净这个声音应该要自然稳定而且每一次重新产生都听起来像同一个人",
          "hifi/zh_hant_polyphones/r03": "如果今天的录音品质够干净这个声音应该要自然稳定而且每一次重新产生都听起来像同一个人",
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
    expect(score.groups[0].renders[0].cer.rate).toBe(0);
    expect(score.groups[0].renders[0].wer.rate).toBe(0);
  });

  it("treats common Taiwan term Simplified ASR glyphs as script-equivalent", async () => {
    const reportPath = path.join(tmpRoot, "tw-terms-report.json");
    const asrPath = path.join(tmpRoot, "tw-terms-asr.json");
    const outPath = path.join(tmpRoot, "tw-terms-score.json");
    const report = reportJson({
      text: "這個專案要支援繁體中文、台灣用語，以及自然的英文夾雜，不要聽起來像生硬翻譯。",
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "这个专案要支援繁体中文、台湾用语以及自然的英文夹杂不要听起来像生硬翻译",
          "hifi/zh_hant_polyphones/r02": "这个专案要支援繁体中文、台湾用语以及自然的英文夹杂不要听起来像生硬翻译",
          "hifi/zh_hant_polyphones/r03": "这个专案要支援繁体中文、台湾用语以及自然的英文夹杂不要听起来像生硬翻译",
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
  });

  it("treats Chinese spoken dates, serial numbers, and times as numeric-equivalent", async () => {
    const reportPath = path.join(tmpRoot, "numeric-report.json");
    const asrPath = path.join(tmpRoot, "numeric-asr.json");
    const outPath = path.join(tmpRoot, "numeric-score.json");
    const report = reportJson({
      text: "今天是二零二六年五月十九日，訂單編號是 A 一七三九，請在下午三點半以前回覆。",
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "今天是2026年5月19日订单编号是A1739请在下午3点半以前回复",
          "hifi/zh_hant_polyphones/r02": "今天是2026年5月19日订单编号是A1739请在下午3点半以前回复",
          "hifi/zh_hant_polyphones/r03": "今天是2026年5月19日订单编号是A1739请在下午3点半以前回复",
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
    expect(score.textScoringPolicy.numericEquivalence).toBe("zh_spoken_dates_serials_and_times");
  });

  it("treats VoxCPM2 split by ASR punctuation as the same brand token", async () => {
    const reportPath = path.join(tmpRoot, "mixed-brand-report.json");
    const asrPath = path.join(tmpRoot, "mixed-brand-asr.json");
    const outPath = path.join(tmpRoot, "mixed-brand-score.json");
    const report = reportJson({
      text: "請幫我把 AnyVoice、VoxCPM2 和 Brenda 的測試結果整理成一份簡短報告。",
    });
    report.groups[0].case.id = "mixed_en_zh_models";
    for (const render of report.groups[0].renders) {
      render.caseId = "mixed_en_zh_models";
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/mixed_en_zh_models/r01": "请帮我把Anyvoice,Vox,CPM2和Brenda的测试结果整理成一份简短报告",
          "hifi/mixed_en_zh_models/r02": "请帮我把Anyvoice,Vox,CPM2和Brenda的测试结果整理成一份简短报告",
          "hifi/mixed_en_zh_models/r03": "请帮我把Anyvoice,Vox,CPM2和Brenda的测试结果整理成一份简短报告",
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
    expect(score.groups[0].renders[0]).toMatchObject({
      scoringTarget: {
        kind: "raw",
        text: "請幫我把 AnyVoice、VoxCPM2 和 Brenda 的測試結果整理成一份簡短報告。",
      },
      cer: { rate: 0 },
      wer: { rate: 0 },
    });
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
          "hifi/zh_hant_polyphones/r03": "請用我的聲音說行長今天會開會。",
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

  it("does not block strict scores when a target preset is covered elsewhere in the profile", async () => {
    const reportPath = path.join(tmpRoot, "profile-wide-reference-report.json");
    const asrPath = path.join(tmpRoot, "profile-wide-reference-asr.json");
    const outPath = path.join(tmpRoot, "profile-wide-reference-score.json");
    const report = reportJson({ text: "請整理 AnyVoice 和 VoxCPM2 的測試結果。" });
    for (const render of report.groups[0].renders) {
      Object.assign(render, {
        profileClipId: "anyvoice-reference",
        targetPronunciationPresetIds: ["brand:anyvoice", "brand:voxcpm2"],
        matchedPronunciationPresetIds: ["brand:anyvoice"],
        profilePronunciationPresetIds: ["brand:anyvoice", "brand:voxcpm2"],
      });
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "請整理 AnyVoice 和 VoxCPM2 的測試結果。",
          "hifi/zh_hant_polyphones/r02": "請整理 AnyVoice 和 VoxCPM2 的測試結果。",
          "hifi/zh_hant_polyphones/r03": "請整理 AnyVoice 和 VoxCPM2 的測試結果。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--out", outPath, "--strict"]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.summary.profileReferenceReviewGroups).toBe(0);
    expect(score.groups[0].profileReference).toMatchObject({
      verdict: "pass",
      coveredByProfileOnly: expect.arrayContaining([
        expect.objectContaining({
          profileCoveredPronunciationPresetIds: ["brand:voxcpm2"],
        }),
      ]),
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
          "hifi/zh_hant_polyphones/r03": "請整理 Vox C P M two 的測試結果。",
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

  it("scores explicit ASR equivalence aliases for known homophone ambiguity", async () => {
    const reportPath = path.join(tmpRoot, "asr-alias-report.json");
    const asrPath = path.join(tmpRoot, "asr-alias.json");
    const outPath = path.join(tmpRoot, "asr-alias-score.json");
    const report = reportJson({
      text: "這次請把行長、長樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
    });
    report.groups[0].case.asrEquivalenceAliases = [
      {
        text: "這次請把航長、常樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
        reason: "ASR homophone ambiguity",
      },
    ];
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "這次請把航長、常樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
          "hifi/zh_hant_polyphones/r02": "這次請把航長、常樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
          "hifi/zh_hant_polyphones/r03": "這次請把航長、常樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
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
    expect(score.textScoringPolicy.asrEquivalenceAliases).toBe("case_level_aliases_for_known_asr_text_ambiguity");
    expect(score.groups[0].renders[0]).toMatchObject({
      scoringTarget: {
        kind: "asr_alias:1",
        text: "這次請把航長、常樂和 TSMC 的讀法固定下來，不要每次重試都變得不一樣。",
      },
      cer: { rate: 0 },
      wer: { rate: 0 },
    });
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
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
    const speakerPath = path.join(tmpRoot, "speaker.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
          "prompt/zh_hant_polyphones/r01": 0.81,
          "prompt/zh_hant_polyphones/r02": 0.8,
          "prompt/zh_hant_polyphones/r03": 0.805,
          "hifi/zh_hant_polyphones/r01": 0.84,
          "hifi/zh_hant_polyphones/r02": 0.83,
          "hifi/zh_hant_polyphones/r03": 0.835,
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
        avgLatencyRegressionPct: -8.824,
      },
    });
    expect(score.pairedComparison.pairs[0]).toMatchObject({
      speakerSimilarityDelta: 0.03,
    });
  });

  it("allows negligible paired speaker similarity noise while blocking material regression", async () => {
    const reportPath = path.join(tmpRoot, "speaker-noise-report.json");
    const asrPath = path.join(tmpRoot, "speaker-noise-asr.json");
    const speakerPath = path.join(tmpRoot, "speaker-noise-speaker.json");
    const outPath = path.join(tmpRoot, "speaker-noise-score.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
          "prompt/zh_hant_polyphones/r01": 0.81,
          "prompt/zh_hant_polyphones/r02": 0.8,
          "prompt/zh_hant_polyphones/r03": 0.805,
          "hifi/zh_hant_polyphones/r01": 0.806,
          "hifi/zh_hant_polyphones/r02": 0.797,
          "hifi/zh_hant_polyphones/r03": 0.801,
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
    expect(score.pairedComparison.summary.avgSpeakerSimilarityDelta).toBe(-0.003667);
    expect(score.pairedComparison.reasons).not.toContain("speaker_similarity_materially_regressed");
  });

  it("fails strict paired comparison when aggregate speaker similarity materially regresses", async () => {
    const reportPath = path.join(tmpRoot, "speaker-regression-report.json");
    const asrPath = path.join(tmpRoot, "speaker-regression-asr.json");
    const speakerPath = path.join(tmpRoot, "speaker-regression-speaker.json");
    const outPath = path.join(tmpRoot, "speaker-regression-score.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
          "prompt/zh_hant_polyphones/r01": 0.81,
          "prompt/zh_hant_polyphones/r02": 0.8,
          "prompt/zh_hant_polyphones/r03": 0.805,
          "hifi/zh_hant_polyphones/r01": 0.75,
          "hifi/zh_hant_polyphones/r02": 0.755,
          "hifi/zh_hant_polyphones/r03": 0.752,
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
        "--out",
        outPath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "hifi",
        "--require-paired-improvement",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"pairedComparisonVerdict": "review"'),
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison).toMatchObject({
      verdict: "review",
      reasons: ["speaker_similarity_materially_regressed"],
    });
  });

  it("fails strict paired comparison when speaker similarity delta is not measurable", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score-missing-paired-speaker.json");
    await writeFile(reportPath, `${JSON.stringify(pairedReportJson(), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
        "--out",
        outPath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "hifi",
        "--require-paired-improvement",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"pairedComparisonVerdict": "review"'),
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison.pairs[0]).toMatchObject({
      speakerSimilarityDelta: null,
      reasons: expect.arrayContaining(["speaker_similarity_delta_not_measurable"]),
    });
  });

  it("fails strict paired comparison when the candidate is slower than the baseline", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score-latency.json");
    const report = pairedReportJson();
    for (const group of report.groups) {
      for (const render of group.renders) {
        render.renderSeconds = group.cloneMode === "hifi" ? 12.5 : 10.0;
      }
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
        "--out",
        outPath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "hifi",
        "--require-paired-improvement",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"pairedComparisonVerdict": "review"'),
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison.pairs[0]).toMatchObject({
      latencyVerdict: "review",
      latencyRegressionPct: 25,
      reasons: expect.arrayContaining(["latency_regressed"]),
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
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶脚色",
          "hifi/zh_hant_polyphones/r02": "重慶脚色",
          "hifi/zh_hant_polyphones/r03": "重慶脚色",
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

  it("fails paired comparison when the candidate group itself does not pass", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const outPath = path.join(tmpRoot, "score-candidate-group.json");
    const report = pairedReportJson();
    const hifi = report.groups.find((group) => group.cloneMode === "hifi");
    for (const render of hifi?.renders ?? []) {
      render.audioMetrics = audioMetrics({ durationSec: 1.3, clippingRatio: 0.01 });
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "prompt/zh_hant_polyphones/r01": "重庆脚色",
          "prompt/zh_hant_polyphones/r02": "重庆脚色",
          "prompt/zh_hant_polyphones/r03": "重庆脚色",
          "hifi/zh_hant_polyphones/r01": "重慶角色",
          "hifi/zh_hant_polyphones/r02": "重慶角色",
          "hifi/zh_hant_polyphones/r03": "重慶角色",
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
        "--out",
        outPath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "hifi",
        "--require-paired-improvement",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"pairedComparisonVerdict": "review"'),
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison.pairs[0]).toMatchObject({
      candidateGroupVerdict: "review",
      reasons: expect.arrayContaining(["candidate_group_not_pass"]),
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
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
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
          "hifi/zh_hant_polyphones/r03": 0.83,
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
        requireProfileReferenceSimilarity: false,
      },
    });
  });

  it("requires enrollment-set speaker similarity for profile-bound strict scores", async () => {
    const reportPath = path.join(tmpRoot, "profile-report.json");
    const asrPath = path.join(tmpRoot, "profile-asr.json");
    const speakerPath = path.join(tmpRoot, "profile-speaker.json");
    const outPath = path.join(tmpRoot, "profile-score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson({ voiceProfile: true }), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
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
          "hifi/zh_hant_polyphones/r03": 0.83,
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
        "--out",
        outPath,
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"speakerReviewGroups": 1'),
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.thresholds.requireProfileReferenceSimilarity).toBe(true);
    expect(score.groups[0]).toMatchObject({
      speakerIdentityVerdict: "review",
      speakerIdentity: {
        requireProfileReferenceSimilarity: true,
        profileReferenceEvaluatedRenders: 0,
        reasons: expect.arrayContaining(["missing_profile_reference_similarity"]),
      },
    });
  });

  it("passes profile-bound strict scores when every render has enrollment-set speaker similarity", async () => {
    const reportPath = path.join(tmpRoot, "profile-report-pass.json");
    const asrPath = path.join(tmpRoot, "profile-asr-pass.json");
    const speakerPath = path.join(tmpRoot, "profile-speaker-pass.json");
    const outPath = path.join(tmpRoot, "profile-score-pass.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson({ voiceProfile: true }), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
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
          similarities: [
            {
              cloneMode: "hifi",
              caseId: "zh_hant_polyphones",
              repeat: 1,
              speakerSimilarity: 0.84,
              profileSpeakerSimilarityMin: 0.81,
            },
            {
              cloneMode: "hifi",
              caseId: "zh_hant_polyphones",
              repeat: 2,
              speakerSimilarity: 0.82,
              profileSpeakerSimilarityMin: 0.8,
            },
            {
              cloneMode: "hifi",
              caseId: "zh_hant_polyphones",
              repeat: 3,
              speakerSimilarity: 0.83,
              profileSpeakerSimilarityMin: 0.79,
            },
          ],
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
      speakerReviewGroups: 0,
    });

    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0]).toMatchObject({
      speakerIdentityVerdict: "pass",
      speakerIdentity: {
        requireProfileReferenceSimilarity: true,
        profileReferenceEvaluatedRenders: 3,
        minSpeakerSimilarityObserved: 0.82,
      },
    });
  });

  it("does not let low cross-profile-reference minima override the selected reference speaker verdict", async () => {
    const reportPath = path.join(tmpRoot, "profile-low-cross-ref-pass.json");
    const asrPath = path.join(tmpRoot, "profile-low-cross-ref-asr.json");
    const speakerPath = path.join(tmpRoot, "profile-low-cross-ref-speaker.json");
    const outPath = path.join(tmpRoot, "profile-low-cross-ref-score.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson({ voiceProfile: true }), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify({
        "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
        "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
        "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      speakerPath,
      `${JSON.stringify({
        similarities: [1, 2, 3].map((repeat) => ({
          cloneMode: "hifi",
          caseId: "zh_hant_polyphones",
          repeat,
          speakerSimilarity: 0.83,
          profileSpeakerSimilarityMin: 0.18,
        })),
      }, null, 2)}\n`,
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

    expect(JSON.parse(stdout)).toMatchObject({ verdict: "pass", speakerReviewGroups: 0 });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.groups[0].speakerIdentity).toMatchObject({
      minSpeakerSimilarityObserved: 0.83,
      profileReferenceEvaluatedRenders: 3,
    });
    expect(score.groups[0].renders[0]).toMatchObject({
      speakerSimilarity: 0.83,
      speakerSimilarityForVerdict: 0.83,
      profileSpeakerSimilarityMin: 0.18,
    });
  });

  it("rejects profile-bound reports when a render is missing profile evidence", async () => {
    const reportPath = path.join(tmpRoot, "profile-missing-render-evidence.json");
    const report = reportJson({ voiceProfile: true });
    delete report.groups[0].renders[1].profileSha256;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, reportPath, "--strict"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("profile-bound report group 0 render 1 profileSha256 does not match report profile"),
    });
  });

  it("accepts profile-bound reports that carry profile evidence only on renders", async () => {
    const reportPath = path.join(tmpRoot, "profile-render-only-evidence.json");
    const asrPath = path.join(tmpRoot, "profile-render-only-asr.json");
    const speakerPath = path.join(tmpRoot, "profile-render-only-speaker.json");
    const outPath = path.join(tmpRoot, "profile-render-only-score.json");
    const report = reportJson({ voiceProfile: true });
    delete report.voiceProfile;
    delete report.groups[0].voiceProfileId;
    delete report.groups[0].profileSha256;
    await writeRenderOutputProofs(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          transcripts: Object.fromEntries(
            report.groups[0].renders.map((render: { outputWav: string }) => [render.outputWav, report.groups[0].case.text]),
          ),
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
          similarities: report.groups[0].renders.map((render: { cloneMode: string; caseId: string; repeat: number }) => ({
            cloneMode: render.cloneMode,
            caseId: render.caseId,
            repeat: render.repeat,
            speakerSimilarity: 0.83,
            profileSpeakerSimilarityMin: 0.79,
          })),
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
    });
  });

  it("rejects profile-bound reports with mixed render profile hashes", async () => {
    const reportPath = path.join(tmpRoot, "profile-mixed-render-evidence.json");
    const report = reportJson({ voiceProfile: true });
    report.groups[0].renders[2].profileSha256 = "e".repeat(64);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, reportPath, "--strict"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("profile-bound report has mixed or incomplete voiceProfileId/profileSha256 evidence"),
    });
  });

  it("rejects reports whose render output hash evidence is stale", async () => {
    const reportPath = path.join(tmpRoot, "stale-render-output-report.json");
    const asrPath = path.join(tmpRoot, "stale-render-output-asr.json");
    const report = reportJson();
    await writeRenderOutputProofs(report);
    await writeFile(report.groups[0].renders[0].outputWav, Buffer.from("changed render wav bytes\n"));
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "hifi/zh_hant_polyphones/r01": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r02": "重慶、角色和 AnyVoice 都要讀準。",
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, reportPath, "--asr-json", asrPath, "--strict"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("render_output_sha256_mismatch:hifi/zh_hant_polyphones#r1"),
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
          "hifi/zh_hant_polyphones/r03": "重慶、角色和 AnyVoice 都要讀準。",
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
          "hifi/zh_hant_polyphones/r03": 0.83,
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

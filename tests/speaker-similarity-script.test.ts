// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "score_speaker_similarity.py");
const scoreScript = path.join(process.cwd(), "scripts", "score_voice_regression.py");

let tmpRoot: string;

function wavBuffer(frequency = 220, seconds = 1, sampleRate = 16000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 16000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
}

function reportJson(referenceAudio: string | null, outputWav: string) {
  return {
    version: 1,
    groups: [
      {
        cloneMode: "hifi",
        case: {
          id: "zh_hant_identity",
          text: "這段聲音要像同一個人。",
        },
        stability: {
          verdict: "pass",
          durationSpanPct: 0,
          rmsSpanDb: 0,
          minPairwiseWaveformCorr: 1,
        },
        renders: [
          {
            caseId: "zh_hant_identity",
            cloneMode: "hifi",
            repeat: 1,
            status: "ready",
            outputWav,
            ...(referenceAudio ? { referenceAudio } : {}),
          },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-speaker-similarity-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("score_speaker_similarity.py", () => {
  it("reports speaker backend availability without requiring a regression report", async () => {
    const { stdout } = await execFileAsync(python, [script, "--list-backends"]);
    const payload = JSON.parse(stdout);
    expect(["mfcc-cosine", "resemblyzer", "speechbrain-ecapa"]).toContain(payload.selectedAutoBackend);
    expect(payload.backends["mfcc-cosine"]).toMatchObject({
      available: true,
      kind: "local_proxy",
    });
    expect(payload.backends["speechbrain-ecapa"].kind).toBe("speaker_verification");
    expect(payload.recommendation).toContain("speechbrain-ecapa");
  });

  it("writes planned speaker similarity rows in dry-run mode", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const outPath = path.join(tmpRoot, "speaker.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson("reference.wav", "output.wav"), null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(python, [script, reportPath, "--dry-run", "--out", outPath]);
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "dry-run",
      total: 1,
      scored: 0,
      failed: 0,
    });

    const speaker = JSON.parse(await readFile(outPath, "utf-8"));
    expect(speaker.similarities[0]).toMatchObject({
      cloneMode: "hifi",
      caseId: "zh_hant_identity",
      repeat: 1,
      speakerSimilarity: null,
    });
  });

  it("scores identical WAVs and produces scorer-compatible speaker JSON", async () => {
    const referencePath = path.join(tmpRoot, "reference.wav");
    const outputPath = path.join(tmpRoot, "output.wav");
    const reportPath = path.join(tmpRoot, "report.json");
    const speakerPath = path.join(tmpRoot, "speaker.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const scorePath = path.join(tmpRoot, "score.json");
    const audio = wavBuffer(240);
    await writeFile(referencePath, audio);
    await writeFile(outputPath, audio);
    await writeFile(reportPath, `${JSON.stringify(reportJson(referencePath, outputPath), null, 2)}\n`, "utf-8");
    await writeFile(
      asrPath,
      `${JSON.stringify({ "hifi/zh_hant_identity/r01": "這段聲音要像同一個人。" }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, reportPath, "--backend", "mfcc-cosine", "--out", speakerPath, "--strict"]);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      backend: "mfcc-cosine",
      total: 1,
      scored: 1,
      failed: 0,
    });
    expect(summary.avgSpeakerSimilarity).toBeGreaterThan(0.99);

    const speaker = JSON.parse(await readFile(speakerPath, "utf-8"));
    const resolvedOutputPath = await realpath(outputPath);
    const resolvedReferencePath = await realpath(referencePath);
    expect(speaker.similarities[0]).toMatchObject({
      outputWav: resolvedOutputPath,
      referenceAudio: resolvedReferencePath,
      backend: "mfcc-cosine",
    });
    expect(speaker.similarities[0].speakerSimilarity).toBeGreaterThan(0.99);

    await execFileAsync(python, [
      scoreScript,
      reportPath,
      "--asr-json",
      asrPath,
      "--speaker-json",
      speakerPath,
      "--out",
      scorePath,
      "--strict",
    ]);
    const score = JSON.parse(await readFile(scorePath, "utf-8"));
    expect(score).toMatchObject({
      verdict: "pass",
      summary: {
        speakerReviewGroups: 0,
      },
    });
  });

  it("fails strict mode when the regression report does not identify reference audio", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(null, path.join(tmpRoot, "output.wav")), null, 2)}\n`, "utf-8");

    await expect(execFileAsync(python, [script, reportPath, "--backend", "mfcc-cosine", "--strict"])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"failed": 1'),
    });
  });
});

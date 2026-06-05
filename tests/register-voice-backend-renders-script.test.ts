// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "register_voice_backend_renders.py");
const scoreScript = path.join(process.cwd(), "scripts", "score_voice_regression.py");

let tmpRoot: string;

function wavBuffer(durationSec: number): Buffer {
  const sampleRate = 8000;
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
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
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? 9000 : -9000, 44 + index * 2);
  }
  return buffer;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-register-backend-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("register_voice_backend_renders.py", () => {
  it("turns external backend renders into a blind AnyVoice regression report", async () => {
    const manifestPath = path.join(tmpRoot, "renders.json");
    const outDir = path.join(tmpRoot, "registered");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          backends: [
            {
              backend: "voxcpm2-hifi",
              referenceAudio: "reference.wav",
              promptText: "這是參考音逐字稿。",
              renders: [{ caseId: "zh_hant_polyphones", repeat: 1, outputWav: "voxcpm2.wav", stabilitySeed: 1337 }],
            },
            {
              backend: "indextts2",
              referenceAudio: "reference.wav",
              promptText: "這是參考音逐字稿。",
              renders: [
                {
                  caseId: "zh_hant_polyphones",
                  repeat: 1,
                  outputWav: "indextts2.wav",
                  metadataJson: { engine: "IndexTTS2" },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, manifestPath, "--dry-run", "--out-dir", outDir]);
    const payload = JSON.parse(stdout) as { report: string; html: string; groups: number; renders: number };
    expect(payload).toMatchObject({ groups: 2, renders: 2 });

    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    expect(report.groups.map((group: { cloneMode: string }) => group.cloneMode).sort()).toEqual(["indextts2", "voxcpm2-hifi"]);
    expect(report.groups[0].case.text).toContain("重慶");
    const seededRender = report.groups
      .flatMap((group: { renders: Array<Record<string, unknown>> }) => group.renders)
      .find((render: Record<string, unknown>) => render.stabilitySeed === 1337);
    expect(seededRender).toMatchObject({
      externalBackend: true,
      status: "dry_run",
      stabilitySeed: 1337,
    });

    const html = await readFile(payload.html, "utf-8");
    expect(html).toContain("AnyVoice Blind A/B Review");
    expect(html).toContain("Sample A");
    expect(html).toContain("Sample B");
    expect(html).toContain("Reveal key after listening");
    expect(html).not.toContain("voxcpm2-hifi / zh_hant_polyphones");
    expect(html).not.toContain("indextts2 / zh_hant_polyphones");
  });

  it("records byte and SHA-256 evidence for registered backend WAVs", async () => {
    const manifestPath = path.join(tmpRoot, "rendered.json");
    const outDir = path.join(tmpRoot, "rendered-registered");
    const audio = wavBuffer(0.25);
    const profileSha256 = "f".repeat(64);
    await writeFile(path.join(tmpRoot, "indextts2.wav"), audio);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "indextts2",
            caseId: "zh_hant_polyphones",
            voiceProfileId: "local-test",
            profileSha256,
            outputWav: "indextts2.wav",
            rendererStatus: "ready",
            renderSeconds: 8.75,
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, manifestPath, "--out-dir", outDir]);
    const payload = JSON.parse(stdout) as { report: string; summary: { readyRenders: number; hashedRenders: number; missingRenders: number } };
    expect(payload.summary).toMatchObject({ readyRenders: 1, hashedRenders: 1, missingRenders: 0 });

    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    expect(report.summary).toMatchObject({ readyRenders: 1, hashedRenders: 1, missingRenders: 0 });
    expect(report.voiceProfile).toMatchObject({
      voiceProfileId: "local-test",
      profileSha256,
    });
    expect(report.groups[0]).toMatchObject({
      voiceProfileId: "local-test",
      profileSha256,
    });
    expect(report.groups[0].renders[0]).toMatchObject({
      status: "ready",
      voiceProfileId: "local-test",
      profileSha256,
      rendererStatus: "ready",
      outputExists: true,
      missingOutput: false,
      outputBytes: audio.byteLength,
      outputSha256: createHash("sha256").update(audio).digest("hex"),
      renderSeconds: 8.75,
      audioMetrics: expect.any(Object),
    });
  });

  it("rejects external render metadata that conflicts with the manifest backend", async () => {
    const manifestPath = path.join(tmpRoot, "conflicting-metadata.json");
    await writeFile(path.join(tmpRoot, "indextts2.wav"), wavBuffer(0.25));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "indextts2",
            caseId: "zh_hant_polyphones",
            voiceProfileId: "local-test",
            profileSha256: "f".repeat(64),
            outputWav: "indextts2.wav",
            metadataJson: {
              voiceBackend: "f5-tts",
            },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, manifestPath, "--out-dir", tmpRoot])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("backend render metadata conflicts with manifest backend"),
    });
  });

  it("marks allowed missing backend outputs as missing instead of ready", async () => {
    const manifestPath = path.join(tmpRoot, "missing-output.json");
    const outDir = path.join(tmpRoot, "missing-registered");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "indextts2",
            caseId: "zh_hant_polyphones",
            outputWav: "missing.wav",
            rendererStatus: "needs_renderer_command",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [script, manifestPath, "--allow-missing", "--out-dir", outDir]);
    const payload = JSON.parse(stdout) as { report: string; summary: { readyRenders: number; hashedRenders: number; missingRenders: number } };
    expect(payload.summary).toMatchObject({ readyRenders: 0, hashedRenders: 0, missingRenders: 1 });

    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    expect(report.groups[0].renders[0]).toMatchObject({
      status: "missing",
      rendererStatus: "needs_renderer_command",
      outputExists: false,
      missingOutput: true,
      outputBytes: null,
      outputSha256: null,
    });
    expect(report.groups[0].renders[0]).not.toHaveProperty("audioMetrics");
  });

  it("rejects ready backend renders without profile binding evidence", async () => {
    const manifestPath = path.join(tmpRoot, "missing-profile.json");
    await writeFile(path.join(tmpRoot, "indextts2.wav"), wavBuffer(0.25));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "indextts2",
            caseId: "zh_hant_polyphones",
            outputWav: "indextts2.wav",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, manifestPath, "--out-dir", tmpRoot])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ready backend render rows must include voiceProfileId and profileSha256"),
    });
  });

  it("rejects ready backend renders bound to mixed profile hashes", async () => {
    const manifestPath = path.join(tmpRoot, "mixed-profile.json");
    await writeFile(path.join(tmpRoot, "voxcpm2.wav"), wavBuffer(0.25));
    await writeFile(path.join(tmpRoot, "indextts2.wav"), wavBuffer(0.25));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "voxcpm2-hifi",
            caseId: "zh_hant_polyphones",
            voiceProfileId: "local-test",
            profileSha256: "f".repeat(64),
            outputWav: "voxcpm2.wav",
          },
          {
            backend: "indextts2",
            caseId: "zh_hant_polyphones",
            voiceProfileId: "local-test",
            profileSha256: "e".repeat(64),
            outputWav: "indextts2.wav",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, manifestPath, "--out-dir", tmpRoot])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ready backend render rows must be bound to exactly one voiceProfileId/profileSha256"),
    });
  });

  it("lets the scorer compare arbitrary backend ids with paired improvement gates", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
    const speakerPath = path.join(tmpRoot, "speaker.json");
    const outPath = path.join(tmpRoot, "score.json");
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          version: 1,
          groups: [
            {
              cloneMode: "voxcpm2-hifi",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              stability: { verdict: "pass", durationSpanPct: 0, rmsSpanDb: 0, minPairwiseWaveformCorr: 1 },
              renders: [
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "voxcpm2-hifi",
                  repeat: 1,
                  status: "ready",
                  outputWav: "voxcpm2-r01.wav",
                  renderSeconds: 10.2,
                  audioMetrics: { available: true, durationSec: 1.3, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "voxcpm2-hifi",
                  repeat: 2,
                  status: "ready",
                  outputWav: "voxcpm2-r02.wav",
                  renderSeconds: 10.3,
                  audioMetrics: { available: true, durationSec: 1.31, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "voxcpm2-hifi",
                  repeat: 3,
                  status: "ready",
                  outputWav: "voxcpm2-r03.wav",
                  renderSeconds: 10.1,
                  audioMetrics: { available: true, durationSec: 1.29, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
              ],
            },
            {
              cloneMode: "indextts2",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              stability: { verdict: "pass", durationSpanPct: 0, rmsSpanDb: 0, minPairwiseWaveformCorr: 1 },
              renders: [
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "indextts2",
                  repeat: 1,
                  status: "ready",
                  outputWav: "indextts2-r01.wav",
                  renderSeconds: 9.1,
                  audioMetrics: { available: true, durationSec: 1.2, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "indextts2",
                  repeat: 2,
                  status: "ready",
                  outputWav: "indextts2-r02.wav",
                  renderSeconds: 9.2,
                  audioMetrics: { available: true, durationSec: 1.21, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
                {
                  caseId: "zh_hant_polyphones",
                  cloneMode: "indextts2",
                  repeat: 3,
                  status: "ready",
                  outputWav: "indextts2-r03.wav",
                  renderSeconds: 9.0,
                  audioMetrics: { available: true, durationSec: 1.19, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      asrPath,
      `${JSON.stringify(
        {
          "voxcpm2-hifi/zh_hant_polyphones/r01": "重庆脚色",
          "voxcpm2-hifi/zh_hant_polyphones/r02": "重庆脚色",
          "voxcpm2-hifi/zh_hant_polyphones/r03": "重庆脚色",
          "indextts2/zh_hant_polyphones/r01": "重慶角色",
          "indextts2/zh_hant_polyphones/r02": "重慶角色",
          "indextts2/zh_hant_polyphones/r03": "重慶角色",
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
          "voxcpm2-hifi/zh_hant_polyphones/r01": 0.81,
          "voxcpm2-hifi/zh_hant_polyphones/r02": 0.8,
          "voxcpm2-hifi/zh_hant_polyphones/r03": 0.805,
          "indextts2/zh_hant_polyphones/r01": 0.86,
          "indextts2/zh_hant_polyphones/r02": 0.85,
          "indextts2/zh_hant_polyphones/r03": 0.855,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      scoreScript,
      reportPath,
      "--asr-json",
      asrPath,
      "--speaker-json",
      speakerPath,
      "--baseline-clone-mode",
      "voxcpm2-hifi",
      "--candidate-clone-mode",
      "indextts2",
      "--require-paired-improvement",
      "--out",
      outPath,
      "--strict",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "pass",
      pairedComparisonVerdict: "pass",
    });
    const score = JSON.parse(await readFile(outPath, "utf-8"));
    expect(score.pairedComparison.pairs[0]).toMatchObject({
      latencyVerdict: "pass",
      latencyRegressionPct: -10.784,
      speakerSimilarityDelta: 0.05,
    });
  });

  it("reconstructs text preparation from eval-case custom repairs when external manifests omit it", async () => {
    const evalPath = path.join(tmpRoot, "repair-eval.json");
    const manifestPath = path.join(tmpRoot, "repair-renders.json");
    const outDir = path.join(tmpRoot, "repair-registered");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "repair-case",
            text: "請讓行長和長樂的讀法固定。",
            pronunciationOverrides: ["pinyin:行長=xing2 zhang3", "長樂[reading]=chang2 le4"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        renders: [
          {
            backend: "indextts2",
            caseId: "repair-case",
            outputWav: "repair.wav",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      manifestPath,
      "--eval-set",
      evalPath,
      "--dry-run",
      "--out-dir",
      outDir,
    ]);
    const payload = JSON.parse(stdout) as { report: string };
    const report = JSON.parse(await readFile(payload.report, "utf-8"));
    expect(report.groups[0].renders[0].textPreparation.targetText).toMatchObject({
      raw: "請讓行長和長樂的讀法固定。",
      model: "請讓xing2 zhang3和chang2 le4的讀法固定。",
    });
  });

  it("rejects unknown eval case ids before writing a report", async () => {
    const manifestPath = path.join(tmpRoot, "bad.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ renders: [{ backend: "indextts2", caseId: "missing_case", outputWav: "x.wav" }] })}\n`,
      "utf-8",
    );

    await expect(execFileAsync(python, [script, manifestPath, "--dry-run", "--out-dir", tmpRoot])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("unknown eval case id"),
    });
  });
});

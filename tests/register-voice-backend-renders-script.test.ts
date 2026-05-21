// @vitest-environment node
import { execFile } from "node:child_process";
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

  it("lets the scorer compare arbitrary backend ids with paired improvement gates", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const asrPath = path.join(tmpRoot, "asr.json");
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
              renders: [{ caseId: "zh_hant_polyphones", cloneMode: "voxcpm2-hifi", repeat: 1, status: "ready", outputWav: "voxcpm2.wav" }],
            },
            {
              cloneMode: "indextts2",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              stability: { verdict: "pass", durationSpanPct: 0, rmsSpanDb: 0, minPairwiseWaveformCorr: 1 },
              renders: [{ caseId: "zh_hant_polyphones", cloneMode: "indextts2", repeat: 1, status: "ready", outputWav: "indextts2.wav" }],
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
          "indextts2/zh_hant_polyphones/r01": "重慶角色",
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

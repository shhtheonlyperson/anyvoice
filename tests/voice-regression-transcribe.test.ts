// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "transcribe_voice_regression.py");
const scoreScript = path.join(process.cwd(), "scripts", "score_voice_regression.py");

let tmpRoot: string;

function reportJson(outputWav: string) {
  return {
    version: 1,
    groups: [
      {
        cloneMode: "hifi",
        case: {
          id: "zh_hant_polyphones",
          text: "重慶角色",
        },
        stability: {
          verdict: "pass",
          durationSpanPct: 1.2,
          rmsSpanDb: 0.5,
          minPairwiseWaveformCorr: 0.91,
        },
        renders: [
          ...[1, 2, 3].map((repeat) => ({
            caseId: "zh_hant_polyphones",
            cloneMode: "hifi",
            repeat,
            status: "ready",
            outputWav,
            audioMetrics: {
              available: true,
              durationSec: 1,
              clippingRatio: 0,
              rmsDbfs: -18,
              peak: 0.4,
            },
          })),
        ],
      },
    ],
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-transcribe-regression-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("transcribe_voice_regression.py", () => {
  it("reports ASR backend availability without a report file", async () => {
    const { stdout } = await execFileAsync(python, [script, "--list-backends"]);
    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      version: 1,
      selectedAutoBackend: expect.any(String),
      backends: {
        "faster-whisper": {
          available: expect.any(Boolean),
          kind: "local_asr",
        },
        "whisper-cli": {
          available: expect.any(Boolean),
          kind: "cli_asr",
        },
      },
    });
  });

  it("writes planned ASR rows in dry-run mode", async () => {
    const reportPath = path.join(tmpRoot, "report.json");
    const outPath = path.join(tmpRoot, "asr.json");
    await writeFile(reportPath, `${JSON.stringify(reportJson(path.join(tmpRoot, "missing.wav")), null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(python, [script, reportPath, "--dry-run", "--out", outPath]);
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "dry-run",
      total: 3,
      transcribed: 0,
      failed: 0,
    });

    const asr = JSON.parse(await readFile(outPath, "utf-8"));
    expect(asr.transcripts[0]).toMatchObject({
      cloneMode: "hifi",
      caseId: "zh_hant_polyphones",
      repeat: 1,
      transcript: null,
    });
  });

  it("uses the whisper CLI backend and writes scorer-compatible transcripts", async () => {
    const wavPath = path.join(tmpRoot, "output.wav");
    const reportPath = path.join(tmpRoot, "report.json");
    const outPath = path.join(tmpRoot, "asr.json");
    const fakeBinDir = path.join(tmpRoot, "bin");
    const fakeWhisper = path.join(fakeBinDir, "whisper");
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(wavPath, Buffer.from([1, 2, 3, 4]));
    await writeFile(reportPath, `${JSON.stringify(reportJson(wavPath), null, 2)}\n`, "utf-8");
    await writeFile(
      fakeWhisper,
      `#!/usr/bin/env python3
import json
import sys
from pathlib import Path

out_dir = Path(".")
audio = None
skip_next = False
value_options = {"--model", "--device", "--output_dir", "-o", "--output_format", "-f", "--language", "--verbose", "--task", "--fp16"}
for index, arg in enumerate(sys.argv[1:]):
    if skip_next:
        skip_next = False
        continue
    if arg in {"--output_dir", "-o"}:
        out_dir = Path(sys.argv[index + 2])
        skip_next = True
        continue
    if arg in value_options:
        skip_next = True
        continue
    if not arg.startswith("-"):
        audio = Path(arg)
if audio is None:
    raise SystemExit("missing audio")
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / f"{audio.stem}.json").write_text(json.dumps({"text": "重慶角色", "language": "zh"}, ensure_ascii=False), encoding="utf-8")
`,
      "utf-8",
    );
    await chmod(fakeWhisper, 0o755);

    const { stdout } = await execFileAsync(
      python,
      [script, reportPath, "--backend", "whisper-cli", "--model", "tiny", "--device", "cpu", "--out", outPath, "--strict"],
      {
        env: {
          ...process.env,
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "whisper-cli",
      total: 3,
      transcribed: 3,
      failed: 0,
    });

    const asr = JSON.parse(await readFile(outPath, "utf-8"));
    expect(asr.transcripts[0]).toMatchObject({
      outputWav: wavPath,
      transcript: "重慶角色",
      backend: "whisper-cli",
      language: "zh",
    });

    const scorePath = path.join(tmpRoot, "score.json");
    await execFileAsync(python, [scoreScript, reportPath, "--asr-json", outPath, "--out", scorePath, "--strict"]);
    const score = JSON.parse(await readFile(scorePath, "utf-8"));
    expect(score).toMatchObject({
      verdict: "pass",
      summary: {
        avgCer: 0,
        avgWer: 0,
      },
    });
  });
});

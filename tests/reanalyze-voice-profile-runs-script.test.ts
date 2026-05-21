// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const reanalyzeScript = path.join(process.cwd(), "scripts", "reanalyze_voice_profile_runs.py");
const buildScript = path.join(process.cwd(), "scripts", "build_voice_profile.py");

let tmpRoot: string;

async function writeFakeAnalyzer(): Promise<string> {
  const analyzer = path.join(tmpRoot, "fake_analyzer.py");
  await writeFile(
    analyzer,
    [
      "import argparse, json",
      "from pathlib import Path",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--reference-audio')",
      "parser.add_argument('--prompt-text-file')",
      "parser.add_argument('--metadata-output')",
      "parser.add_argument('--model-id')",
      "parser.add_argument('--source-kind')",
      "args = parser.parse_args()",
      "Path(args.metadata_output).write_text(json.dumps({",
      "  'model_id': args.model_id,",
      "  'reference_audio': args.reference_audio,",
      "  'converted_reference_audio': str(Path(args.metadata_output).parent / 'reference_16k_mono.wav'),",
      "  'prompt_text_present': True,",
      "  'referenceQuality': {",
      "    'grade': 'A',",
      "    'durationSec': 8,",
      "    'snrDb': 28,",
      "    'clippingRatio': 0,",
      "    'vadActiveRatio': 0.8,",
      "    'warnings': [],",
      "  },",
      "}, ensure_ascii=False), encoding='utf-8')",
    ].join("\n"),
    "utf-8",
  );
  return analyzer;
}

async function writeFailingAnalyzer(): Promise<string> {
  const analyzer = path.join(tmpRoot, "failing_analyzer.py");
  await writeFile(
    analyzer,
    [
      "import argparse, sys",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--reference-audio')",
      "parser.add_argument('--prompt-text-file')",
      "parser.add_argument('--metadata-output')",
      "parser.add_argument('--model-id')",
      "parser.add_argument('--source-kind')",
      "args = parser.parse_args()",
      "print('invalid audio fixture', file=sys.stderr)",
      "sys.exit(3)",
    ].join("\n"),
    "utf-8",
  );
  return analyzer;
}

async function writeRun(
  id: string,
  options: {
    transcript?: string;
    reference?: boolean;
    metadata?: Record<string, unknown>;
    sourceKind?: string;
  } = {},
): Promise<void> {
  const runDir = path.join(tmpRoot, "runs", id);
  await mkdir(runDir, { recursive: true });
  if (options.reference !== false) {
    await writeFile(path.join(runDir, "reference.wav"), Buffer.from([1, 2, 3]));
  }
  if (options.transcript !== undefined) {
    await writeFile(path.join(runDir, "prompt-transcript.raw.txt"), options.transcript, "utf-8");
  }
  if (options.metadata) {
    await writeFile(path.join(runDir, "metadata.json"), JSON.stringify(options.metadata), "utf-8");
  }
  if (options.sourceKind) {
    await writeFile(
      path.join(runDir, "request.json"),
      JSON.stringify({ sourceKind: options.sourceKind, referenceSource: { kind: options.sourceKind } }),
      "utf-8",
    );
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-reanalyze-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("reanalyze_voice_profile_runs.py", () => {
  it("backfills referenceQuality while preserving existing metadata", async () => {
    const analyzer = await writeFakeAnalyzer();
    await writeRun("usable", {
      transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
      metadata: { model_id: "old-model", keep: "existing" },
    });
    await writeRun("already", {
      transcript: "已經分析過的聲音樣本。",
      metadata: {
        referenceQuality: {
          grade: "D",
          durationSec: 2,
          snrDb: 4,
          clippingRatio: 0,
          vadActiveRatio: 0.2,
          warnings: ["short_clip"],
        },
      },
    });
    await writeRun("profile-output", {
      transcript: "數位聲音輸出的片段不能再加入。",
      sourceKind: "profile",
    });
    await writeRun("sample-output", {
      transcript: "示範聲音不能加入。",
      sourceKind: "sample",
    });
    await writeRun("missing-transcript");
    await writeRun("missing-audio", { transcript: "沒有音檔。", reference: false });

    const { stdout } = await execFileAsync(python, [
      reanalyzeScript,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--analyzer",
      analyzer,
      "--python",
      python,
    ]);
    const result = JSON.parse(stdout) as {
      plannedOrUpdated: number;
      skipped: Record<string, number>;
      runs: Array<{ sourceRunId: string; status: string; quality: { grade: string; durationSec: number } }>;
    };

    expect(result.plannedOrUpdated).toBe(1);
    expect(result.runs).toEqual([
      expect.objectContaining({
        sourceRunId: "usable",
        status: "updated",
        quality: expect.objectContaining({ grade: "A", durationSec: 8 }),
      }),
    ]);
    expect(result.skipped.already_analyzed).toBe(1);
    expect(result.skipped.profile_generated).toBe(1);
    expect(result.skipped.sample_source).toBe(1);
    expect(result.skipped.missing_transcript).toBe(1);
    expect(result.skipped.missing_audio).toBe(1);

    const metadata = JSON.parse(await readFile(path.join(tmpRoot, "runs", "usable", "metadata.json"), "utf-8"));
    expect(metadata.keep).toBe("existing");
    expect(metadata.model_id).toBe("old-model");
    expect(metadata.referenceQuality).toMatchObject({ grade: "A", durationSec: 8 });
    expect(metadata.referenceQualitySource).toMatchObject({ kind: "reanalyzed" });

    const { stdout: buildStdout } = await execFileAsync(python, [
      buildScript,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      path.join(tmpRoot, "profile"),
      "--dry-run",
    ]);
    expect(JSON.parse(buildStdout)).toMatchObject({ eligibleClips: 1, selectedClips: 1 });
  });

  it("can plan reanalysis without writing metadata", async () => {
    const analyzer = await writeFakeAnalyzer();
    await writeRun("planned", {
      transcript: "這是一段等待重掃的錄音。",
      metadata: { model_id: "old-model" },
    });

    const { stdout } = await execFileAsync(python, [
      reanalyzeScript,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--analyzer",
      analyzer,
      "--python",
      python,
      "--dry-run",
    ]);
    const result = JSON.parse(stdout) as { plannedOrUpdated: number; runs: Array<{ status: string }> };

    expect(result.plannedOrUpdated).toBe(1);
    expect(result.runs[0].status).toBe("planned");
    const metadata = JSON.parse(await readFile(path.join(tmpRoot, "runs", "planned", "metadata.json"), "utf-8"));
    expect(metadata.referenceQuality).toBeUndefined();
  });

  it("exits non-zero when candidate reanalysis fails but still prints the structured report", async () => {
    const analyzer = await writeFailingAnalyzer();
    await writeRun("broken", {
      transcript: "這是一段壞掉的舊錄音。",
      metadata: { model_id: "old-model" },
    });

    await expect(
      execFileAsync(python, [
        reanalyzeScript,
        "--runs-dir",
        path.join(tmpRoot, "runs"),
        "--analyzer",
        analyzer,
        "--python",
        python,
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "completed_with_errors"'),
    });

    try {
      await execFileAsync(python, [
        reanalyzeScript,
        "--runs-dir",
        path.join(tmpRoot, "runs"),
        "--analyzer",
        analyzer,
        "--python",
        python,
      ]);
      throw new Error("expected reanalysis failure");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({
        status: "completed_with_errors",
        plannedOrUpdated: 0,
      });
      expect(payload.failures).toEqual([
        expect.objectContaining({
          sourceRunId: "broken",
          message: expect.stringContaining("invalid audio fixture"),
        }),
      ]);
    }
  });
});

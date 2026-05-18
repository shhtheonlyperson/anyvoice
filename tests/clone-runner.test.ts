// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    default: actual,
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import {
  recordCloneError,
  recordWorkerMissingRun,
  runLocalClone,
  workerMissingPayload,
} from "@/lib/clone-runner";
import type { CloneInput } from "@/lib/clone-request";

const spawnMock = vi.mocked(spawn);

let tmpRoot: string;
const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalVercel = process.env.VERCEL;
const originalModel = process.env.ANYVOICE_MODEL_ID;

function makeInput(overrides: Partial<CloneInput> = {}): CloneInput {
  return {
    voice: new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" }),
    targetText: "hello world",
    promptTranscript: "hello world",
    quality: "balanced",
    ...overrides,
  };
}

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeSuccess(metadataPayload: unknown): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // Write metadata file before close fires
  setTimeout(async () => {
    // find metadata path from args (passed in spawn call)
    const call = spawnMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const metaIdx = args.indexOf("--metadata-output");
    const outIdx = args.indexOf("--output");
    if (metaIdx >= 0) {
      await writeFile(args[metaIdx + 1], JSON.stringify(metadataPayload), "utf-8");
    }
    if (outIdx >= 0) {
      await writeFile(args[outIdx + 1], Buffer.from([0, 0]), null);
    }
    proc.stderr.emit("data", Buffer.from("synth ok"));
    proc.emit("close", 0);
  }, 0);
  return proc;
}

function fakeFailure(code: number, stderr: string): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(() => {
    proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
  }, 0);
  return proc;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-runner-"));
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
  delete process.env.VERCEL;
  spawnMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  if (originalRunsDir === undefined) delete process.env.ANYVOICE_RUNS_DIR;
  else process.env.ANYVOICE_RUNS_DIR = originalRunsDir;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  if (originalModel === undefined) delete process.env.ANYVOICE_MODEL_ID;
  else process.env.ANYVOICE_MODEL_ID = originalModel;
});

describe("workerMissingPayload", () => {
  it("returns the standard shape with the configured model", () => {
    process.env.ANYVOICE_MODEL_ID = "custom/Model";
    const payload = workerMissingPayload("job-abc");
    expect(payload.status).toBe("needs_worker");
    expect(payload.jobId).toBe("job-abc");
    expect(payload.modelId).toBe("custom/Model");
    expect(payload.message).toMatch(/VoxCPM2/);
  });

  it("defaults the model when env is unset", () => {
    delete process.env.ANYVOICE_MODEL_ID;
    const payload = workerMissingPayload("j");
    expect(payload.modelId).toBe("openbmb/VoxCPM2");
  });
});

describe("recordWorkerMissingRun", () => {
  it("writes input files and request.json", async () => {
    const jobId = "jobMiss1";
    const input = makeInput({ promptTranscript: "transcript text" });
    await recordWorkerMissingRun(jobId, input);
    const runDir = path.join(tmpRoot, jobId);
    const requestText = await readFile(path.join(runDir, "request.json"), "utf-8");
    const parsed = JSON.parse(requestText);
    expect(parsed.status).toBe("needs_worker");
    expect(parsed.voiceName).toBe("ref.wav");
    expect(parsed.quality).toBe("balanced");

    const targetText = await readFile(path.join(runDir, "target.txt"), "utf-8");
    expect(targetText).toBe("hello world");
    const prompt = await readFile(path.join(runDir, "prompt-transcript.txt"), "utf-8");
    expect(prompt).toBe("transcript text");
  });

  it("always writes the prompt transcript file (required field)", async () => {
    const jobId = "jobMiss2";
    await recordWorkerMissingRun(jobId, makeInput());
    const runDir = path.join(tmpRoot, jobId);
    const prompt = await readFile(path.join(runDir, "prompt-transcript.txt"), "utf-8");
    expect(prompt).toBe("hello world");
  });

  it("uses mp3 extension when type indicates mpeg", async () => {
    const jobId = "jobMp3";
    const input = makeInput({
      voice: new File([new Uint8Array([1])], "noext", { type: "audio/mpeg" }),
    });
    await recordWorkerMissingRun(jobId, input);
    const refFile = await readFile(path.join(tmpRoot, jobId, "reference.mp3"));
    expect(refFile.byteLength).toBeGreaterThan(0);
  });

  it("falls back to .audio extension for unknown types", async () => {
    const jobId = "jobUnknown";
    const input = makeInput({
      voice: new File([new Uint8Array([9])], "noext", { type: "audio/unknown" }),
    });
    await recordWorkerMissingRun(jobId, input);
    const refFile = await readFile(path.join(tmpRoot, jobId, "reference.audio"));
    expect(refFile.byteLength).toBeGreaterThan(0);
  });
});

describe("recordCloneError", () => {
  it("writes an error.txt under the run dir", async () => {
    await recordCloneError("errJob", "boom");
    const text = await readFile(path.join(tmpRoot, "errJob", "error.txt"), "utf-8");
    expect(text).toBe("boom");
  });
});

describe("runLocalClone", () => {
  it("returns a ready payload with parsed metadata", async () => {
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: {
          grade: "a",
          durationSec: 8.5,
          snrDb: 22.1,
          clippingRatio: 0.01,
          vadActiveRatio: 0.9,
          warnings: ["warn-one"],
        },
        effectiveParams: {
          timesteps: 50,
          cfgValue: 1.5,
          denoise: true,
          qualityPreset: "quality",
        },
      }) as never,
    );
    const result = await runLocalClone("jobOK", makeInput());
    expect(result.status).toBe("ready");
    expect(result.jobId).toBe("jobOK");
    expect(result.audioUrl).toBe("/api/runs/jobOK/audio");
    expect(result.referenceQuality.grade).toBe("A");
    expect(result.referenceQuality.warnings).toContain("warn-one");
    expect(result.effectiveParams.timesteps).toBe(50);
    expect(result.effectiveParams.qualityPreset).toBe("quality");
    expect(result.effectiveParams.denoise).toBe(true);
  });

  it("accepts snake_case metadata keys and defaults missing fields", async () => {
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: {
          grade: "Z", // invalid -> falls back to C
          duration_sec: 4,
          snr_db: 12,
          clipping_ratio: 0.2,
          vad_active_ratio: 0.5,
          warnings: ["x", 5, "y"], // mixed -> filters non-strings
        },
        effectiveParams: {
          timesteps: "bad", // invalid -> 0
          cfg_value: 2.0,
          denoise: 0,
          quality_preset: "speed",
        },
      }) as never,
    );
    const result = await runLocalClone("jobSnake", makeInput({ quality: "speed" }));
    expect(result.referenceQuality.grade).toBe("C");
    expect(result.referenceQuality.warnings).toEqual(["x", "y"]);
    expect(result.referenceQuality.durationSec).toBe(4);
    expect(result.effectiveParams.timesteps).toBe(0);
    expect(result.effectiveParams.cfgValue).toBe(2.0);
    expect(result.effectiveParams.denoise).toBe(false);
    expect(result.effectiveParams.qualityPreset).toBe("speed");
  });

  it("returns sensible defaults when metadata file is missing/invalid", async () => {
    spawnMock.mockImplementation(() => {
      // Success but write invalid JSON
      const proc = new EventEmitter() as FakeProcess;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(async () => {
        const call = spawnMock.mock.calls.at(-1)!;
        const args = call[1] as string[];
        const metaIdx = args.indexOf("--metadata-output");
        const outIdx = args.indexOf("--output");
        if (metaIdx >= 0) {
          await writeFile(args[metaIdx + 1], "not-json", "utf-8");
        }
        if (outIdx >= 0) {
          await writeFile(args[outIdx + 1], Buffer.from([0]), null);
        }
        proc.emit("close", 0);
      }, 0);
      return proc as never;
    });
    const result = await runLocalClone("jobBadMeta", makeInput());
    expect(result.referenceQuality.grade).toBe("C");
    expect(result.referenceQuality.durationSec).toBe(0);
    expect(result.effectiveParams.qualityPreset).toBe("balanced");
  });

  it("rejects when the spawned process exits non-zero", async () => {
    spawnMock.mockImplementation(() => fakeFailure(1, "model crashed") as never);
    await expect(runLocalClone("jobFail", makeInput())).rejects.toThrow(/model crashed/);
  });

  it("always passes --prompt-text-file to python (transcript is required)", async () => {
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
      }) as never,
    );
    await runLocalClone("jobArgs", makeInput({ promptTranscript: "transcript here" }));
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--prompt-text-file");
    expect(args).toContain("--quality");
  });
});

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
  enrollVoiceProfileClip,
  isVoiceProfileEnrollmentError,
  parseVoiceProfileEnrollmentForm,
} from "@/lib/profile-enrollment";

const spawnMock = vi.mocked(spawn);

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

let tmpRoot: string;
const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalPython = process.env.ANYVOICE_VOXCPM_PYTHON;

function fakeSuccess(metadataPayload: unknown): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(async () => {
    const call = spawnMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const metaIdx = args.indexOf("--metadata-output");
    if (metaIdx >= 0) {
      await writeFile(args[metaIdx + 1], JSON.stringify(metadataPayload), "utf-8");
    }
    proc.stdout.emit("data", Buffer.from(JSON.stringify(metadataPayload)));
    proc.emit("close", 0);
  }, 0);
  return proc;
}

function form(overrides: Record<string, string | Blob> = {}): FormData {
  const data = new FormData();
  data.set("voice", new File([new Uint8Array([1, 2, 3])], "enroll.wav", { type: "audio/wav" }));
  data.set("promptTranscript", "請錄製穩定聲音。");
  data.set("sourceKind", "scripted");
  data.set("consent", "yes");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-enrollment-"));
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
  process.env.ANYVOICE_VOXCPM_PYTHON = "/tmp/voxcpm-python";
  spawnMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  if (originalRunsDir === undefined) delete process.env.ANYVOICE_RUNS_DIR;
  else process.env.ANYVOICE_RUNS_DIR = originalRunsDir;
  if (originalPython === undefined) delete process.env.ANYVOICE_VOXCPM_PYTHON;
  else process.env.ANYVOICE_VOXCPM_PYTHON = originalPython;
});

describe("profile enrollment", () => {
  it("validates required enrollment fields", () => {
    const missingTranscript = form({ promptTranscript: "" });
    const result = parseVoiceProfileEnrollmentForm(missingTranscript);
    expect(isVoiceProfileEnrollmentError(result)).toBe(true);
    if (!isVoiceProfileEnrollmentError(result)) throw new Error("expected error");
    expect(result.statusCode).toBe(400);
  });

  it("rejects sample audio as profile enrollment input", () => {
    const result = parseVoiceProfileEnrollmentForm(form({ sourceKind: "sample" }));
    expect(isVoiceProfileEnrollmentError(result)).toBe(true);
    if (!isVoiceProfileEnrollmentError(result)) throw new Error("expected error");
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/user recordings|user-uploaded/);
  });

  it("rejects Simplified or mixed Chinese transcripts before analyzer work", () => {
    const result = parseVoiceProfileEnrollmentForm(form({ promptTranscript: "这个聲音要穩定。" }));
    expect(isVoiceProfileEnrollmentError(result)).toBe(true);
    if (!isVoiceProfileEnrollmentError(result)) throw new Error("expected error");
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/Traditional Chinese|mixed Chinese/);
  });

  it("rejects Chinese transcripts without clear Traditional marker evidence before analyzer work", () => {
    const result = parseVoiceProfileEnrollmentForm(form({ promptTranscript: "中文音色自然。" }));
    expect(isVoiceProfileEnrollmentError(result)).toBe(true);
    if (!isVoiceProfileEnrollmentError(result)) throw new Error("expected error");
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/unproven|zh-Hant|Traditional Chinese/);
  });

  it("writes enrollment run files and parses analyzer quality", async () => {
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        mode: "profile_enrollment",
        referenceQuality: {
          grade: "B",
          durationSec: 7.5,
          snrDb: 22,
          clippingRatio: 0,
          vadActiveRatio: 0.7,
          warnings: [],
        },
      }) as never,
    );

    const input = parseVoiceProfileEnrollmentForm(form());
    expect(isVoiceProfileEnrollmentError(input)).toBe(false);
    if (isVoiceProfileEnrollmentError(input)) throw new Error("expected input");
    const result = await enrollVoiceProfileClip("enrollJob1", input);

    expect(result.status).toBe("enrolled");
    expect(result.referenceQuality.grade).toBe("B");
    const runDir = path.join(tmpRoot, "enrollJob1");
    const request = JSON.parse(await readFile(path.join(runDir, "request.json"), "utf-8"));
    expect(request.status).toBe("profile_enrollment");
    expect(request.sourceKind).toBe("scripted");
    expect(request.referenceSource.kind).toBe("scripted");
    expect(await readFile(path.join(runDir, "prompt-transcript.raw.txt"), "utf-8")).toBe("請錄製穩定聲音。");

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(spawnMock.mock.calls[0][0]).toBe("/tmp/voxcpm-python");
    expect(args[0]).toMatch(/scripts\/analyze_voice_reference\.py$/);
    expect(args).toContain("--metadata-output");
  });
});

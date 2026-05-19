// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "@/lib/clone-request";
import type { CloneProgressCallback } from "@/lib/clone-runner";

vi.mock("@/lib/clone-runner", () => ({
  runLocalCloneWithProgress: vi.fn(),
  recordCloneError: vi.fn(),
  recordWorkerMissingRun: vi.fn(),
  workerMissingPayload: vi.fn((jobId: string) => ({
    status: "needs_worker",
    jobId,
    modelId: "openbmb/VoxCPM2",
    message: "needs worker",
  })),
}));

vi.mock("nanoid", () => ({ nanoid: () => "stream-job-id" }));

import { POST } from "@/app/api/clone/stream/route";
import { recordWorkerMissingRun, runLocalCloneWithProgress } from "@/lib/clone-runner";

const runProgressMock = vi.mocked(runLocalCloneWithProgress);
const recordMissingMock = vi.mocked(recordWorkerMissingRun);
const originalEnv = { ...process.env };

function buildForm(overrides: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  form.set("voice", new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" }));
  form.set("targetText", "hello world");
  form.set("promptTranscript", "hello world");
  form.set("quality", "quality");
  form.set("consent", "yes");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

function makeReq(form?: FormData): import("next/server").NextRequest {
  return new Request("http://localhost/api/clone/stream", {
    method: "POST",
    body: form,
  }) as unknown as import("next/server").NextRequest;
}

async function readJsonLines(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_WORKER_URL;
  delete process.env.ANYVOICE_WORKER_TOKEN;
  delete process.env.ANYVOICE_STUB;
  process.env.ANYVOICE_ENABLE_LOCAL_VOXCPM = "1";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
  vi.unstubAllGlobals();
});

describe("POST /api/clone/stream", () => {
  it("streams progress events and the final ready payload", async () => {
    runProgressMock.mockImplementation(
      async (jobId: string, input: CloneInput, onProgress?: CloneProgressCallback) => {
        onProgress?.({
          status: "progress",
          jobId,
          modelId: "openbmb/VoxCPM2",
          phase: "reference_analyzed",
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 24,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
        });
        return {
          status: "ready",
          jobId,
          modelId: "openbmb/VoxCPM2",
          audioUrl: `/api/runs/${jobId}/audio`,
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 24,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          targetLanguage: "en",
          effectiveParams: { timesteps: 40, cfgValue: 3, denoise: false, qualityPreset: input.quality },
        };
      },
    );

    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const lines = await readJsonLines(res);
    expect(lines.map((line) => line.status)).toEqual(["progress", "ready"]);
    expect(lines[0].phase).toBe("reference_analyzed");
    expect(lines[1].audioUrl).toBe("/api/runs/stream-job-id/audio");
    expect(runProgressMock).toHaveBeenCalledTimes(1);
  });

  it("streams needs_worker when local inference is unavailable", async () => {
    process.env.ANYVOICE_STUB = "1";
    const res = await POST(makeReq(buildForm()));
    const lines = await readJsonLines(res);

    expect(lines.map((line) => line.status)).toEqual(["progress", "needs_worker"]);
    expect(recordMissingMock).toHaveBeenCalledTimes(1);
  });

  it("forwards stream requests to the worker stream endpoint", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    const fetchMock = vi.fn(async () =>
      new Response('{"status":"progress","phase":"queued"}\n{"status":"ready","jobId":"wjob"}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeReq(buildForm({ quality: "speed" })));
    const body = await res.text();

    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(body).toContain('"jobId":"wjob"');
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example/api/local-worker/clone/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

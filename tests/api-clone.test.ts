// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clone-runner", () => ({
  runLocalClone: vi.fn(),
  recordCloneError: vi.fn(),
  recordWorkerMissingRun: vi.fn(),
  workerMissingPayload: vi.fn((jobId: string) => ({
    status: "needs_worker",
    jobId,
    modelId: "openbmb/VoxCPM2",
    message: "needs worker",
  })),
}));

vi.mock("nanoid", () => ({ nanoid: () => "test-job-id" }));

import { POST } from "@/app/api/clone/route";
import {
  recordCloneError,
  recordWorkerMissingRun,
  runLocalClone,
  workerMissingPayload,
} from "@/lib/clone-runner";

const runMock = vi.mocked(runLocalClone);
const recordErrMock = vi.mocked(recordCloneError);
const recordMissingMock = vi.mocked(recordWorkerMissingRun);
const missingPayloadMock = vi.mocked(workerMissingPayload);

const originalEnv = { ...process.env };

function buildForm(overrides: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  const voice = new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" });
  form.set("voice", voice);
  form.set("targetText", "hello world");
  form.set("consent", "yes");
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  return form;
}

function makeReq(form?: FormData, init?: RequestInit): import("next/server").NextRequest {
  const body = form;
  return new Request("http://localhost/api/clone", {
    method: "POST",
    body,
    ...init,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset env to non-vercel, no worker proxy, stub OFF, local voxcpm ON
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_WORKER_URL;
  delete process.env.ANYVOICE_WORKER_TOKEN;
  delete process.env.ANYVOICE_STUB;
  process.env.ANYVOICE_ENABLE_LOCAL_VOXCPM = "1";
});

afterEach(() => {
  // restore env
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/clone", () => {
  it("returns 400 when body is not multipart form", async () => {
    const req = new Request("http://localhost/api/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not a form",
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/multipart/);
  });

  it("returns 400 for missing voice", async () => {
    const form = new FormData();
    form.set("targetText", "hello");
    form.set("consent", "yes");
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
  });

  it("returns ready payload on success path", async () => {
    runMock.mockResolvedValue({
      status: "ready",
      jobId: "test-job-id",
      modelId: "openbmb/VoxCPM2",
      mode: "reference",
      audioUrl: "/api/runs/test-job-id/audio",
      referenceQuality: {
        grade: "B",
        durationSec: 5,
        snrDb: 25,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      referenceTranscript: null,
      referenceLanguage: null,
      targetLanguage: "en",
      effectiveParams: { timesteps: 32, cfgValue: 1.2, denoise: false, qualityPreset: "balanced" },
    });
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.jobId).toBe("test-job-id");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("returns needs_worker shape when stub is on", async () => {
    process.env.ANYVOICE_STUB = "1";
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_worker");
    expect(recordMissingMock).toHaveBeenCalled();
    expect(missingPayloadMock).toHaveBeenCalledWith("test-job-id");
  });

  it("records error and returns 500 when the runner throws", async () => {
    runMock.mockRejectedValue(new Error("model exploded"));
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toBe("model exploded");
    expect(body.jobId).toBe("test-job-id");
    expect(recordErrMock).toHaveBeenCalledWith("test-job-id", "model exploded");
  });

  it("returns 500 when worker URL is configured but invalid", async () => {
    process.env.ANYVOICE_WORKER_URL = "not-a-url";
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toMatch(/ANYVOICE_WORKER_URL/);
  });

  it("returns 500 when worker URL is set but token missing", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toMatch(/ANYVOICE_WORKER_TOKEN/);
  });

  it("forwards to worker and returns JSON body when proxy is configured", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ready", jobId: "wjob" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBe("wjob");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example/api/local-worker/clone",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("returns 502 when worker fetch throws", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe("network down");
    vi.unstubAllGlobals();
  });

  it("returns 502 when worker returns non-json success", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("plain text body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ));
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });
});

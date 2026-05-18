// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clone-runner", () => ({
  runLocalClone: vi.fn(),
  recordCloneError: vi.fn(),
}));

vi.mock("nanoid", () => ({ nanoid: () => "lw-job-id" }));

import { POST } from "@/app/api/local-worker/clone/route";
import { recordCloneError, runLocalClone } from "@/lib/clone-runner";

const runMock = vi.mocked(runLocalClone);
const recordErrMock = vi.mocked(recordCloneError);

const originalEnv = { ...process.env };

function buildForm(): FormData {
  const form = new FormData();
  form.set("voice", new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }));
  form.set("targetText", "hello");
  form.set("consent", "yes");
  return form;
}

function makeReq(form?: FormData, headers: Record<string, string> = {}): import("next/server").NextRequest {
  return new Request("http://localhost/api/local-worker/clone", {
    method: "POST",
    body: form,
    headers,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_STUB;
  process.env.ANYVOICE_ENABLE_LOCAL_VOXCPM = "1";
  process.env.ANYVOICE_WORKER_TOKEN = "secret";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/local-worker/clone", () => {
  it("returns 503 when token is not configured", async () => {
    delete process.env.ANYVOICE_WORKER_TOKEN;
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer x" }));
    expect(res.status).toBe(503);
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 503 when local voxcpm is not enabled", async () => {
    delete process.env.ANYVOICE_ENABLE_LOCAL_VOXCPM;
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer secret" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toMatch(/local VoxCPM2 worker/);
  });

  it("returns 400 when body is not multipart", async () => {
    const req = new Request("http://localhost/api/local-worker/clone", {
      method: "POST",
      body: "nope",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 from parser when form is invalid", async () => {
    const form = new FormData();
    form.set("targetText", "hi");
    form.set("consent", "yes");
    const res = await POST(makeReq(form, { authorization: "Bearer secret" }));
    expect(res.status).toBe(400);
  });

  it("returns ready payload on success", async () => {
    runMock.mockResolvedValue({
      status: "ready",
      jobId: "lw-job-id",
      modelId: "openbmb/VoxCPM2",
      mode: "reference",
      audioUrl: "/api/runs/lw-job-id/audio",
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
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
  });

  it("returns 500 and records error when runner throws", async () => {
    runMock.mockRejectedValue(new Error("synth fail"));
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer secret" }));
    expect(res.status).toBe(500);
    expect(recordErrMock).toHaveBeenCalledWith("lw-job-id", "synth fail");
  });
});

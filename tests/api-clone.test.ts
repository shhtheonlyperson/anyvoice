// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

vi.mock("@/lib/run-history", () => ({
  createReadyHistoryRecord: vi.fn(() => ({ id: "ready-history" })),
  createWorkerMissingHistoryRecord: vi.fn(() => ({ id: "missing-history" })),
  createErrorHistoryRecord: vi.fn(() => ({ id: "error-history" })),
  saveRunHistory: vi.fn(async () => {}),
}));

vi.mock("nanoid", () => ({ nanoid: () => "test-job-id" }));

import { POST } from "@/app/api/clone/route";
import {
  recordCloneError,
  recordWorkerMissingRun,
  runLocalClone,
  workerMissingPayload,
} from "@/lib/clone-runner";
import { persistVoiceProfileManifest, voiceProfileManifestPath, type VoiceProfileSummary } from "@/lib/voice-profile";
import { saveRunHistory } from "@/lib/run-history";

const runMock = vi.mocked(runLocalClone);
const recordErrMock = vi.mocked(recordCloneError);
const recordMissingMock = vi.mocked(recordWorkerMissingRun);
const missingPayloadMock = vi.mocked(workerMissingPayload);
const saveHistoryMock = vi.mocked(saveRunHistory);

const originalEnv = { ...process.env };

function buildForm(overrides: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  const voice = new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" });
  form.set("voice", voice);
  form.set("targetText", "hello world");
  form.set("promptTranscript", "hello world");
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

const profileTranscriptFixtures = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

async function writeEligibleProfileRun(
  root: string,
  id: string,
  transcript = profileTranscriptFixtures[Number(id.replace(/\D/g, "")) - 1] ?? `請錄製穩定聲音 ${id}。`,
) {
  const runDir = path.join(root, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(runDir, "prompt-transcript.raw.txt"), transcript, "utf-8");
  await writeFile(path.join(runDir, "target.raw.txt"), "target", "utf-8");
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify({
      referenceQuality: {
        grade: "A",
        durationSec: 8,
        snrDb: 24,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    }),
    "utf-8",
  );
}

async function writePassingProfileValidation(validationRoot: string, profile: VoiceProfileSummary) {
  await mkdir(validationRoot, { recursive: true });
  await writeFile(
    path.join(validationRoot, "local-default.json"),
    `${JSON.stringify(
      {
        createdAt: "2026-05-19T00:00:00.000Z",
        profile: voiceProfileManifestPath("local-default"),
        status: "pass",
        summary: { total: profile.clips.length, passed: profile.clips.length, failed: 0 },
        clips: profile.clips.map((clip) => ({
          sourceRunId: clip.sourceRunId,
          expectedTranscript: clip.transcriptRaw,
          audioPath: clip.audioPath,
          verdict: "pass",
          cer: { rate: 0 },
          wer: { rate: 0 },
        })),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
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
      audioUrl: "/api/runs/test-job-id/audio",
      referenceQuality: {
        grade: "B",
        durationSec: 5,
        snrDb: 25,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      targetLanguage: "en",
      effectiveParams: { timesteps: 32, cfgValue: 1.2, denoise: false, qualityPreset: "balanced", cloneMode: "hifi" },
    });
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.jobId).toBe("test-job-id");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(saveHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("can synthesize from a ready voice profile without an uploaded voice", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-api-profile-clone-"));
    const validationRoot = path.join(profileRoot, "transcript-validation");
    process.env.ANYVOICE_RUNS_DIR = profileRoot;
    process.env.ANYVOICE_VOICE_PROFILE_ROOT = path.join(profileRoot, "voices");
    process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = validationRoot;
    try {
      await Promise.all(Array.from({ length: 5 }, (_, index) => writeEligibleProfileRun(profileRoot, `clip-${index + 1}`)));
      const profile = await persistVoiceProfileManifest({ profileId: "local-default" });
      await writePassingProfileValidation(validationRoot, profile);
      runMock.mockResolvedValue({
        status: "ready",
        jobId: "test-job-id",
        modelId: "openbmb/VoxCPM2",
        audioUrl: "/api/runs/test-job-id/audio",
        referenceQuality: {
          grade: "A",
          durationSec: 8,
          snrDb: 25,
          clippingRatio: 0,
          vadActiveRatio: 0.8,
          warnings: [],
        },
        targetLanguage: "zh",
        effectiveParams: { timesteps: 32, cfgValue: 1.2, denoise: false, qualityPreset: "balanced", cloneMode: "hifi" },
      });

      const form = new FormData();
      form.set("useVoiceProfile", "yes");
      form.set("targetText", "請用我的數位聲音說這句。");
      form.set("consent", "yes");
      const res = await POST(makeReq(form));

      expect(res.status).toBe(200);
      expect(runMock).toHaveBeenCalledTimes(1);
      const input = runMock.mock.calls[0][1];
      expect(input.sourceKind).toBe("profile");
      expect(input.promptTranscript).toBe(profileTranscriptFixtures[0]);
      expect(input.profileReference?.referenceClipIds).toHaveLength(5);
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  it("returns needs_worker shape when stub is on", async () => {
    process.env.ANYVOICE_STUB = "1";
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("needs_worker");
    expect(recordMissingMock).toHaveBeenCalled();
    expect(missingPayloadMock).toHaveBeenCalledWith("test-job-id");
    expect(saveHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("records error and returns 500 when the runner throws", async () => {
    runMock.mockRejectedValue(new Error("model exploded"));
    const res = await POST(makeReq(buildForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toBe("model exploded");
    expect(body.jobId).toBe("test-job-id");
    expect(recordErrMock).toHaveBeenCalledWith("test-job-id", "model exploded");
    expect(saveHistoryMock).toHaveBeenCalledTimes(1);
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

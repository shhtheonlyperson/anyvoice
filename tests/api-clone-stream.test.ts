// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

vi.mock("@/lib/run-history", () => ({
  createReadyHistoryRecord: vi.fn(() => ({ id: "ready-history" })),
  createWorkerMissingHistoryRecord: vi.fn(() => ({ id: "missing-history" })),
  createErrorHistoryRecord: vi.fn(() => ({ id: "error-history" })),
  saveRunHistory: vi.fn(async () => {}),
}));

vi.mock("nanoid", () => ({ nanoid: () => "stream-job-id" }));

import { POST } from "@/app/api/clone/stream/route";
import { recordWorkerMissingRun, runLocalCloneWithProgress } from "@/lib/clone-runner";
import { persistVoiceProfileManifest, voiceProfileManifestPath, type VoiceProfileSummary } from "@/lib/voice-profile";
import { saveRunHistory } from "@/lib/run-history";

const runProgressMock = vi.mocked(runLocalCloneWithProgress);
const recordMissingMock = vi.mocked(recordWorkerMissingRun);
const saveHistoryMock = vi.mocked(saveRunHistory);
const originalEnv = { ...process.env };
const profileTranscriptFixtures = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

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

async function writeEligibleProfileRun(root: string, id: string) {
  const runDir = path.join(root, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3, 4]));
  await writeFile(
    path.join(runDir, "prompt-transcript.raw.txt"),
    profileTranscriptFixtures[Number(id.replace(/\D/g, "")) - 1] ?? `請錄製穩定聲音 ${id}。`,
    "utf-8",
  );
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
          effectiveParams: { timesteps: 40, cfgValue: 3, denoise: false, qualityPreset: input.quality, cloneMode: "hifi" },
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
    expect(saveHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("streams needs_worker when local inference is unavailable", async () => {
    process.env.ANYVOICE_STUB = "1";
    const res = await POST(makeReq(buildForm()));
    const lines = await readJsonLines(res);

    expect(lines.map((line) => line.status)).toEqual(["progress", "needs_worker"]);
    expect(recordMissingMock).toHaveBeenCalledTimes(1);
    expect(saveHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("streams synthesis from a ready profile without requiring an uploaded voice", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-api-profile-stream-"));
    const validationRoot = path.join(profileRoot, "transcript-validation");
    process.env.ANYVOICE_RUNS_DIR = profileRoot;
    process.env.ANYVOICE_VOICE_PROFILE_ROOT = path.join(profileRoot, "voices");
    process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = validationRoot;
    try {
      await Promise.all(Array.from({ length: 5 }, (_, index) => writeEligibleProfileRun(profileRoot, `clip-${index + 1}`)));
      const profile = await persistVoiceProfileManifest({ profileId: "local-default" });
      await writePassingProfileValidation(validationRoot, profile);
      runProgressMock.mockImplementation(
        async (jobId: string, input: CloneInput, onProgress?: CloneProgressCallback) => {
          expect(input.sourceKind).toBe("profile");
          expect(input.promptTranscript).toBe(profileTranscriptFixtures[0]);
          expect(input.profileReference?.referenceClipIds).toHaveLength(5);
          onProgress?.({ status: "progress", jobId, modelId: "openbmb/VoxCPM2", phase: "synthesis_started" });
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
            targetLanguage: "zh",
            effectiveParams: { timesteps: 40, cfgValue: 3, denoise: false, qualityPreset: input.quality, cloneMode: "hifi" },
          };
        },
      );

      const form = new FormData();
      form.set("useVoiceProfile", "yes");
      form.set("targetText", "請用我的數位聲音說這句。");
      form.set("consent", "yes");
      const res = await POST(makeReq(form));
      const lines = await readJsonLines(res);

      expect(lines.map((line) => line.status)).toEqual(["progress", "ready"]);
      expect(runProgressMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
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

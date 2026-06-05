// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "@/lib/clone-request";

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
let tmpRoot: string;

function writeProofFile(filePath: string, contents: string | Buffer): { path: string; sha256: string; bytes: number } {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  return {
    path: filePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
  };
}

function completeInternalProfileReference(): NonNullable<CloneInput["profileReference"]> {
  const profile = writeProofFile(path.join(tmpRoot, "profile", "profile.json"), JSON.stringify({ voiceProfileId: "local-test" }));
  const adapter = writeProofFile(path.join(tmpRoot, "lora", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
  const adapterProof = writeProofFile(path.join(tmpRoot, "proof", "adapter-proof.json"), JSON.stringify({ status: "accepted" }));
  const qualityGate = writeProofFile(path.join(tmpRoot, "proof", "lora-quality-gate.json"), JSON.stringify({ status: "accepted" }));
  const trainConfig = writeProofFile(path.join(tmpRoot, "proof", "train-config.json"), JSON.stringify({ rank: 8 }));
  const selection = writeProofFile(path.join(tmpRoot, "backend", "selection.json"), JSON.stringify({ backend: "indextts2" }));
  const score = writeProofFile(path.join(tmpRoot, "backend", "score.json"), JSON.stringify({ score: 0.91 }));
  const review = writeProofFile(path.join(tmpRoot, "backend", "review.json"), JSON.stringify({ accepted: true }));
  const backendOutput = writeProofFile(path.join(tmpRoot, "backend", "indextts2-r01.wav"), Buffer.from([9, 8, 7, 6]));
  const sourceReport = writeProofFile(
    path.join(tmpRoot, "backend", "report.json"),
    JSON.stringify({
      version: 1,
      baselineBackend: "voxcpm2-hifi",
      voiceProfile: { voiceProfileId: "local-test", profileSha256: profile.sha256 },
      groups: [
        {
          voiceProfileId: "local-test",
          profileSha256: profile.sha256,
          cloneMode: "indextts2",
          renders: [
            {
              voiceProfileId: "local-test",
              profileSha256: profile.sha256,
              cloneMode: "indextts2",
              externalBackend: true,
              status: "ready",
              outputWav: backendOutput.path,
              outputExists: true,
              missingOutput: false,
              outputBytes: backendOutput.bytes,
              outputSha256: backendOutput.sha256,
            },
          ],
        },
      ],
    }),
  );

  return {
    voiceProfileId: "local-test",
    sourceRunId: "clip-1",
    referenceClipIds: ["clip-1"],
    audioPath: path.join(tmpRoot, "profile", "clip-1.wav"),
    loraPath: adapter.path,
    loraAdapter: {
      version: 1,
      status: "accepted",
      profileJson: profile.path,
      voiceProfileId: "local-test",
      profileSha256: profile.sha256,
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: qualityGate.path,
      qualityGateSha256: qualityGate.sha256,
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    },
    preferredBackend: {
      version: 1,
      status: "accepted",
      profileJson: profile.path,
      voiceProfileId: "local-test",
      profileSha256: profile.sha256,
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: selection.path,
      selectionSha256: selection.sha256,
      scoreJson: score.path,
      scoreSha256: score.sha256,
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: sourceReport.path,
      sourceReportSha256: sourceReport.sha256,
    },
  };
}

function buildForm(): FormData {
  const form = new FormData();
  form.set("voice", new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }));
  form.set("targetText", "hello");
  form.set("promptTranscript", "hello");
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "anyvoice-api-local-worker-"));
  vi.clearAllMocks();
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_STUB;
  process.env.ANYVOICE_ENABLE_LOCAL_VOXCPM = "1";
  process.env.ANYVOICE_WORKER_TOKEN = "secret";
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
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
      audioUrl: "/api/runs/lw-job-id/audio",
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
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
  });

  it("preserves authenticated internal profile policy", async () => {
    runMock.mockResolvedValue({
      status: "ready",
      jobId: "lw-job-id",
      modelId: "openbmb/VoxCPM2",
      audioUrl: "/api/runs/lw-job-id/audio",
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
    const form = buildForm();
    const profileReference = completeInternalProfileReference();
    form.set("sourceKind", "profile");
    form.set(
      "internalProfileReferenceJson",
      JSON.stringify(profileReference),
    );

    const res = await POST(makeReq(form, { authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    const input = runMock.mock.calls[0][1];
    expect(input.profileReference).toMatchObject({
      voiceProfileId: "local-test",
      sourceRunId: "clip-1",
      loraPath: profileReference.loraPath,
      loraAdapter: {
        profileSha256: profileReference.loraAdapter?.profileSha256,
        adapterProofSha256: profileReference.loraAdapter?.adapterProofSha256,
        qualityGateSha256: profileReference.loraAdapter?.qualityGateSha256,
        trainConfigSha256: profileReference.loraAdapter?.trainConfigSha256,
      },
      preferredBackend: {
        backend: "indextts2",
        profileSha256: profileReference.preferredBackend?.profileSha256,
        selectionSha256: profileReference.preferredBackend?.selectionSha256,
        scoreSha256: profileReference.preferredBackend?.scoreSha256,
        reviewSha256: profileReference.preferredBackend?.reviewSha256,
        sourceReportSha256: profileReference.preferredBackend?.sourceReportSha256,
      },
    });
  });

  it("rejects internal preferred backend policies without source render output proof", async () => {
    const form = buildForm();
    const profileReference = completeInternalProfileReference();
    const weakReport = writeProofFile(
      profileReference.preferredBackend?.sourceReport ?? path.join(tmpRoot, "backend", "report.json"),
      JSON.stringify({
        voiceProfile: {
          voiceProfileId: profileReference.voiceProfileId,
          profileSha256: profileReference.preferredBackend?.profileSha256,
        },
        groups: [],
      }),
    );
    if (profileReference.preferredBackend) {
      profileReference.preferredBackend.sourceReportSha256 = weakReport.sha256;
    }
    form.set("sourceKind", "profile");
    form.set("internalProfileReferenceJson", JSON.stringify(profileReference));

    const res = await POST(makeReq(form, { authorization: "Bearer secret" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: "error",
      message: expect.stringContaining("preferredBackend.sourceReport_render_output_proof"),
    });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 500 and records error when runner throws", async () => {
    runMock.mockRejectedValue(new Error("synth fail"));
    const res = await POST(makeReq(buildForm(), { authorization: "Bearer secret" }));
    expect(res.status).toBe(500);
    expect(recordErrMock).toHaveBeenCalledWith("lw-job-id", "synth fail");
  });
});

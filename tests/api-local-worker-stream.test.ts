// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "@/lib/clone-request";
import type { CloneProgressCallback } from "@/lib/clone-runner";

vi.mock("@/lib/clone-runner", () => ({
  runLocalCloneWithProgress: vi.fn(),
  recordCloneError: vi.fn(),
}));

vi.mock("nanoid", () => ({ nanoid: () => "lw-stream-job-id" }));

import { POST } from "@/app/api/local-worker/clone/stream/route";
import { runLocalCloneWithProgress } from "@/lib/clone-runner";

const runProgressMock = vi.mocked(runLocalCloneWithProgress);
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
  const adapter = writeProofFile(path.join(tmpRoot, "profile-lora", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
  const adapterProof = writeProofFile(path.join(tmpRoot, "proof", "adapter-proof.json"), JSON.stringify({ status: "accepted" }));
  const qualityGate = writeProofFile(path.join(tmpRoot, "proof", "lora-quality-gate.json"), JSON.stringify({ status: "accepted" }));
  const trainConfig = writeProofFile(path.join(tmpRoot, "proof", "train_config.json"), JSON.stringify({ rank: 8 }));
  const selection = writeProofFile(path.join(tmpRoot, "backend", "selection.json"), JSON.stringify({ backend: "indextts2" }));
  const score = writeProofFile(path.join(tmpRoot, "backend", "score.json"), JSON.stringify({ score: 0.91 }));
  const review = writeProofFile(path.join(tmpRoot, "backend", "review.json"), JSON.stringify({ accepted: true }));
  const output = writeProofFile(path.join(tmpRoot, "backend", "indextts2-r01.wav"), Buffer.from([9, 8, 7, 6]));
  const sourceReport = writeProofFile(
    path.join(tmpRoot, "backend", "report.json"),
    JSON.stringify({
      version: 1,
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
              outputWav: output.path,
              outputExists: true,
              missingOutput: false,
              outputBytes: output.bytes,
              outputSha256: output.sha256,
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
  return new Request("http://localhost/api/local-worker/clone/stream", {
    method: "POST",
    body: form,
    headers,
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "anyvoice-api-local-worker-stream-"));
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

describe("POST /api/local-worker/clone/stream", () => {
  it("preserves authenticated internal profile policy", async () => {
    const profileReference = completeInternalProfileReference();
    runProgressMock.mockImplementation(
      async (jobId: string, input: CloneInput, onProgress?: CloneProgressCallback) => {
        expect(input.profileReference).toMatchObject({
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          loraPath: profileReference.loraPath,
          loraAdapter: {
            profileSha256: profileReference.loraAdapter?.profileSha256,
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
        onProgress?.({ status: "progress", jobId, modelId: "openbmb/VoxCPM2", phase: "synthesis_started" });
        return {
          status: "ready",
          jobId,
          modelId: "openbmb/VoxCPM2",
          audioUrl: `/api/runs/${jobId}/audio`,
          referenceQuality: {
            grade: "B",
            durationSec: 5,
            snrDb: 25,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          targetLanguage: "en",
          effectiveParams: { timesteps: 32, cfgValue: 1.2, denoise: false, qualityPreset: input.quality, cloneMode: "hifi" },
        };
      },
    );
    const form = buildForm();
    form.set("sourceKind", "profile");
    form.set("internalProfileReferenceJson", JSON.stringify(profileReference));

    const res = await POST(makeReq(form, { authorization: "Bearer secret" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = await readJsonLines(res);
    expect(lines.map((line) => line.status)).toEqual(["progress", "ready"]);
    expect(runProgressMock).toHaveBeenCalledTimes(1);
  });
});

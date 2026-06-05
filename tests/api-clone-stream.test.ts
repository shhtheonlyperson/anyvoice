// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput } from "@/lib/clone-request";
import type { CloneProgressCallback } from "@/lib/clone-runner";

vi.mock("@/lib/clone-runner", () => ({
  hasPreferredExternalProfileBackend: vi.fn(() => false),
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
import {
  canonicalVoiceProfileSha256,
  persistVoiceProfileManifest,
  voiceProfileManifestPath,
  type VoiceProfileSummary,
} from "@/lib/voice-profile";
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

function forgedInternalProfileReference(): string {
  return JSON.stringify({
    voiceProfileId: "forged-profile",
    sourceRunId: "forged-run",
    referenceClipIds: ["forged-run"],
    audioPath: "/tmp/forged-profile/ref.wav",
    preferredBackend: {
      version: 1,
      status: "accepted",
      profileJson: "/tmp/forged-profile/profile.json",
      voiceProfileId: "forged-profile",
      profileSha256: "c".repeat(64),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: "/tmp/forged-selection.json",
      selectionSha256: "a".repeat(64),
      scoreJson: "/tmp/forged-score.json",
      scoreSha256: "b".repeat(64),
      reviewJson: "/tmp/forged-review.json",
      reviewSha256: "d".repeat(64),
      sourceReport: "/tmp/forged-report.json",
      sourceReportSha256: "e".repeat(64),
    },
  });
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
        voiceProfileId: profile.voiceProfileId,
        profileSha256: canonicalVoiceProfileSha256(profile),
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

async function applyProfileRuntimePolicies() {
  const profilePath = voiceProfileManifestPath("local-default");
  const profileDir = path.dirname(profilePath);
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as Record<string, unknown>;
  const profileSha256 = canonicalVoiceProfileSha256(profile as Partial<VoiceProfileSummary>);

  const writePolicyFile = async (relativePath: string, contents: string | Buffer) => {
    const filePath = path.join(profileDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, typeof contents === "string" ? "utf-8" : null);
    return {
      path: filePath,
      bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  };
  const adapter = await writePolicyFile("adapters/lora_weights.ckpt", Buffer.from([1, 2, 3, 4]));
  const trainConfig = await writePolicyFile("training/train_config.json", '{"trainer":{"status":"ready"}}\n');
  const adapterProof = await writePolicyFile(
    "proofs/adapter-proof.json",
    `${JSON.stringify({
      status: "pass",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
      checkpoint: {
        status: "readable",
        loraParameterKeyCount: 2,
        loraParameterKeys: ["encoder.lora_A.weight", "encoder.lora_B.weight"],
      },
    })}\n`,
  );
  const backendOutput = await writePolicyFile("renders/indextts2.wav", Buffer.from("candidate wav\n"));
  const baselineOutput = await writePolicyFile("renders/voxcpm2-hifi.wav", Buffer.from("baseline wav\n"));
  const loraOutput = await writePolicyFile("renders/lora.wav", Buffer.from("lora wav\n"));
  const loraReport = await writePolicyFile(
    "proofs/lora-report.json",
    `${JSON.stringify({
      version: 1,
      voiceProfile: {
        voiceProfileId: "local-default",
        profileSha256,
      },
      groups: [
        {
          cloneMode: "hifi",
          voiceProfileId: "local-default",
          profileSha256,
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: loraOutput.path,
              outputBytes: loraOutput.bytes,
              outputSha256: loraOutput.sha256,
              voiceProfileId: "local-default",
              profileSha256,
              metadataJson: {
                effectiveParams: {
                  loraEnabled: true,
                  loraPath: adapter.path,
                },
              },
            },
          ],
        },
      ],
    })}\n`,
  );
  const loraAsr = await writePolicyFile("proofs/lora-asr.json", '{"status":"pass"}\n');
  const loraSpeaker = await writePolicyFile("proofs/lora-speaker.json", '{"status":"pass"}\n');
  const loraScore = await writePolicyFile(
    "proofs/lora-score.json",
    `${JSON.stringify({
      verdict: "pass",
      sourceReport: loraReport.path,
      sourceReportSha256: loraReport.sha256,
      asrJson: loraAsr.path,
      asrJsonSha256: loraAsr.sha256,
      speakerJson: loraSpeaker.path,
      speakerJsonSha256: loraSpeaker.sha256,
      voiceProfile: {
        voiceProfileId: "local-default",
        profileSha256,
      },
      groups: [
        {
          cloneMode: "hifi",
          voiceProfileId: "local-default",
          profileSha256,
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: loraOutput.path,
              outputBytes: loraOutput.bytes,
              outputSha256: loraOutput.sha256,
              voiceProfileId: "local-default",
              profileSha256,
            },
          ],
        },
      ],
    })}\n`,
  );
  const transcriptValidation = path.join(process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT ?? profileDir, "local-default.json");
  const transcriptValidationBytes = await readFile(transcriptValidation);
  const transcriptValidationSha256 = createHash("sha256").update(transcriptValidationBytes).digest("hex");

  profile.loraPath = adapter.path;
  profile.loraAdapter = {
    version: 1,
    status: "accepted",
    profileJson: profilePath,
    voiceProfileId: "local-default",
    profileSha256,
    path: profile.loraPath,
    bytes: adapter.bytes,
    sha256: adapter.sha256,
    adapterProofJson: adapterProof.path,
    adapterProofSha256: adapterProof.sha256,
    qualityGateJson: path.join(profileDir, "proofs/lora-quality-gate.json"),
    qualityGateSha256: "",
    trainConfig: trainConfig.path,
    trainConfigSha256: trainConfig.sha256,
  };
  const qualityGate = await writePolicyFile(
    "proofs/lora-quality-gate.json",
    `${JSON.stringify({
      status: "pass",
      dryRun: false,
      inputs: {
        profileJson: profilePath,
        profileSha256,
        cloneMode: "hifi",
        requireSpeakerBackend: "speechbrain-ecapa",
        skipProfileVerify: false,
        skipTranscriptValidation: false,
        loraPath: adapter.path,
        transcriptValidationJson: transcriptValidation,
        transcriptValidationSha256,
      },
      paths: {
        report: loraReport.path,
        asr: loraAsr.path,
        speaker: loraSpeaker.path,
        score: loraScore.path,
      },
      proofs: {
        profileVerifyRequired: true,
        profileVerifyPassed: true,
        profileVerifySkipped: false,
        transcriptValidationRequired: true,
        transcriptValidationPassed: true,
        transcriptValidationSkipped: false,
        transcriptValidationJson: transcriptValidation,
        transcriptValidationSha256,
        speakerBackendRequirement: {
          selected: "speechbrain-ecapa",
          required: "speechbrain-ecapa",
        },
        loraAdapter: {
          exists: true,
          path: adapter.path,
          bytes: adapter.bytes,
          sha256: adapter.sha256,
        },
        artifacts: {
          report: { path: loraReport.path, sha256: loraReport.sha256 },
          asr: { path: loraAsr.path, sha256: loraAsr.sha256 },
          speaker: { path: loraSpeaker.path, sha256: loraSpeaker.sha256 },
          score: { path: loraScore.path, sha256: loraScore.sha256 },
        },
      },
    })}\n`,
  );
  (profile.loraAdapter as Record<string, unknown>).qualityGateSha256 = qualityGate.sha256;
  profile.preferredBackend = {
    version: 1,
    status: "accepted",
    profileJson: profilePath,
    voiceProfileId: "local-default",
    profileSha256,
    backend: "indextts2",
    baselineBackend: "voxcpm2-hifi",
    selectionJson: path.join(profileDir, "proofs/selection.json"),
    selectionSha256: "",
    scoreJson: path.join(profileDir, "proofs/score.json"),
    scoreSha256: "",
    reviewJson: path.join(profileDir, "proofs/review.json"),
    reviewSha256: "",
    sourceReport: path.join(profileDir, "proofs/source-report.json"),
    sourceReportSha256: "",
  };
  const preferredBackend = profile.preferredBackend as Record<string, unknown>;
  const report = await writePolicyFile(
    "proofs/source-report.json",
    `${JSON.stringify({
      version: 1,
      voiceProfile: {
        voiceProfileId: preferredBackend.voiceProfileId,
        profileSha256: preferredBackend.profileSha256,
      },
      groups: [
        {
          cloneMode: preferredBackend.backend,
          voiceProfileId: preferredBackend.voiceProfileId,
          profileSha256: preferredBackend.profileSha256,
          renders: [
            {
              status: "ready",
              externalBackend: true,
              outputExists: true,
              missingOutput: false,
              outputWav: backendOutput.path,
              outputBytes: backendOutput.bytes,
              outputSha256: backendOutput.sha256,
              voiceProfileId: preferredBackend.voiceProfileId,
              profileSha256: preferredBackend.profileSha256,
            },
          ],
        },
      ],
    })}\n`,
  );
  preferredBackend.sourceReportSha256 = report.sha256;
  const review = await writePolicyFile(
    "proofs/review.json",
    `${JSON.stringify({
      version: 1,
      status: "pass",
      reportPath: preferredBackend.sourceReport,
      reportSha256: preferredBackend.sourceReportSha256,
      stats: {
        reportSha256: preferredBackend.sourceReportSha256,
        rounds: 5,
        reviewedRounds: 5,
        candidateWins: 4,
        baselineWins: 1,
        ties: 0,
        rerenders: 0,
        candidateWinRate: 0.8,
        minCandidateWinRate: 0.8,
      },
      choices: {
        "winner-smoke-r01": "A",
      },
    })}\n`,
  );
  preferredBackend.reviewSha256 = review.sha256;
  const score = await writePolicyFile(
    "proofs/score.json",
    `${JSON.stringify({
      verdict: "pass",
      sourceReport: preferredBackend.sourceReport,
      sourceReportSha256: preferredBackend.sourceReportSha256,
      voiceProfile: {
        voiceProfileId: preferredBackend.voiceProfileId,
        profileSha256: preferredBackend.profileSha256,
      },
      groups: [
        {
          cloneMode: preferredBackend.baselineBackend,
          voiceProfileId: preferredBackend.voiceProfileId,
          profileSha256: preferredBackend.profileSha256,
          renders: [
            {
              voiceProfileId: preferredBackend.voiceProfileId,
              profileSha256: preferredBackend.profileSha256,
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: baselineOutput.path,
              outputBytes: baselineOutput.bytes,
              outputSha256: baselineOutput.sha256,
            },
          ],
        },
        {
          cloneMode: preferredBackend.backend,
          voiceProfileId: preferredBackend.voiceProfileId,
          profileSha256: preferredBackend.profileSha256,
          renders: [
            {
              voiceProfileId: preferredBackend.voiceProfileId,
              profileSha256: preferredBackend.profileSha256,
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: backendOutput.path,
              outputBytes: backendOutput.bytes,
              outputSha256: backendOutput.sha256,
            },
          ],
        },
      ],
    })}\n`,
  );
  preferredBackend.scoreSha256 = score.sha256;
  const selection = await writePolicyFile(
    "proofs/selection.json",
    `${JSON.stringify({
      verdict: "accept",
      accepted: true,
      baselineCloneMode: preferredBackend.baselineBackend,
      candidateCloneMode: preferredBackend.backend,
      voiceProfile: {
        voiceProfileId: preferredBackend.voiceProfileId,
        profileSha256: preferredBackend.profileSha256,
      },
      scoreJson: preferredBackend.scoreJson,
      scoreSha256: preferredBackend.scoreSha256,
      reviewJson: preferredBackend.reviewJson,
      reviewSha256: preferredBackend.reviewSha256,
      sourceReport: preferredBackend.sourceReport,
      sourceReportSha256: preferredBackend.sourceReportSha256,
      subjectiveReview: {
        status: "pass",
        reasons: [],
        missingChoices: [],
        invalidChoices: [],
        stats: {
          rounds: 5,
          reviewedRounds: 5,
          candidateWins: 4,
          baselineWins: 1,
          ties: 0,
          candidateWinRate: 0.8,
          minCandidateWinRate: 0.8,
          rerenders: 0,
        },
      },
    })}\n`,
  );
  preferredBackend.selectionSha256 = selection.sha256;
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
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
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("internalProfileReferenceJson")).toBeNull();
      return new Response('{"status":"progress","phase":"queued"}\n{"status":"ready","jobId":"wjob"}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeReq(buildForm({
      quality: "speed",
      sourceKind: "profile",
      internalProfileReferenceJson: forgedInternalProfileReference(),
    })));
    const body = await res.text();

    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(body).toContain('"jobId":"wjob"');
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example/api/local-worker/clone/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("preserves profile LoRA and preferred backend policy when forwarding stream requests", async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-api-profile-stream-proxy-"));
    const validationRoot = path.join(profileRoot, "transcript-validation");
    process.env.ANYVOICE_RUNS_DIR = profileRoot;
    process.env.ANYVOICE_VOICE_PROFILE_ROOT = path.join(profileRoot, "voices");
    process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = validationRoot;
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    try {
      await Promise.all(Array.from({ length: 5 }, (_, index) => writeEligibleProfileRun(profileRoot, `clip-${index + 1}`)));
      const profile = await persistVoiceProfileManifest({ profileId: "local-default" });
      await writePassingProfileValidation(validationRoot, profile);
      await applyProfileRuntimePolicies();

      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        const forwarded = body as FormData;
        const rawReference = forwarded.get("internalProfileReferenceJson");
        expect(rawReference).toEqual(expect.any(String));
        const reference = JSON.parse(String(rawReference)) as {
          loraPath?: string | null;
          loraAdapter?: { profileSha256?: string; qualityGateSha256?: string; trainConfigSha256?: string };
          preferredBackend?: {
            backend?: string;
            profileSha256?: string;
            selectionSha256?: string;
            scoreSha256?: string;
            reviewSha256?: string;
            sourceReportSha256?: string;
          };
        };
        expect(reference.loraPath).toMatch(/adapters\/lora_weights\.ckpt$/);
        expect(reference.loraAdapter).toMatchObject({
          profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          adapterProofSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          qualityGateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          trainConfigSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(reference.preferredBackend).toMatchObject({
          backend: "indextts2",
          profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          scoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        return new Response('{"status":"ready","jobId":"wjob"}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const form = new FormData();
      form.set("useVoiceProfile", "yes");
      form.set("targetText", "請用我的數位聲音說這句。");
      form.set("consent", "yes");
      const res = await POST(makeReq(form));
      const body = await res.text();

      expect(res.status, body).toBe(200);
      expect(body).toContain('"jobId":"wjob"');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });
});

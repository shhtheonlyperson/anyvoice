// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  planTargetChunks,
  recordCloneError,
  recordWorkerMissingRun,
  runLocalClone,
  runLocalCloneWithProgress,
  synthesizeSegment,
  workerMissingPayload,
} from "@/lib/clone-runner";
import type { CloneInput } from "@/lib/clone-request";
import { canonicalVoiceProfileSha256 } from "@/lib/voice-profile";

const spawnMock = vi.mocked(spawn);

let tmpRoot: string;
const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalVercel = process.env.VERCEL;
const originalModel = process.env.ANYVOICE_MODEL_ID;
const originalHotWorkerUrl = process.env.ANYVOICE_HOT_WORKER_URL;
const originalCloneMode = process.env.ANYVOICE_VOXCPM_CLONE_MODE;
const originalLoraPath = process.env.ANYVOICE_VOXCPM_LORA_PATH;
const originalStabilitySeed = process.env.ANYVOICE_STABILITY_SEED;
const originalProfileBackendMode = process.env.ANYVOICE_PROFILE_BACKEND_MODE;
const originalProfileBackendRenderCommand = process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND;
const originalBackendRenderCommand = process.env.ANYVOICE_BACKEND_RENDER_COMMAND;

function makeInput(overrides: Partial<CloneInput> = {}): CloneInput {
  return {
    voice: new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" }),
    targetText: "hello world",
    promptTranscript: "hello world",
    quality: "balanced",
    ...overrides,
  };
}

function preferredBackendPolicy(
  overrides: Partial<NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]>> = {},
): NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]> {
  return {
    version: 1,
    status: "accepted",
    profileJson: "/tmp/profile/profile.json",
    voiceProfileId: "local-test",
    profileSha256: "c".repeat(64),
    backend: "indextts2",
    baselineBackend: "voxcpm2-hifi",
    selectionJson: "/tmp/selection.json",
    selectionSha256: "a".repeat(64),
    scoreJson: "/tmp/score.json",
    scoreSha256: "b".repeat(64),
    reviewJson: "/tmp/review.json",
    reviewSha256: "d".repeat(64),
    sourceReport: "/tmp/report.json",
    sourceReportSha256: "e".repeat(64),
    ...overrides,
  };
}

function acceptedBackendSubjectiveReview(): Record<string, unknown> {
  return {
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
      rerenders: 0,
      candidateWinRate: 0.8,
      minCandidateWinRate: 0.8,
    },
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function writeEvidenceArtifact(name: string, data: Buffer | string): Promise<{ path: string; sha256: string; bytes: number }> {
  const evidenceDir = path.join(tmpRoot, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const filePath = path.join(evidenceDir, name);
  await writeFile(filePath, data, typeof data === "string" ? "utf-8" : null);
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  return { path: filePath, sha256: sha256(data), bytes };
}

async function evidenceFileSha256(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

async function writeProfileEvidenceArtifact(): Promise<{ path: string; sha256: string }> {
  const profile: Record<string, unknown> = {
    version: 1,
    voiceProfileId: "local-test",
    status: "ready",
    summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 0, remainingClipsNeeded: 0 },
    clips: [{ sourceRunId: "clip-1", audioPath: "/tmp/profile/clip-1.wav", transcriptRaw: "hello world" }],
  };
  const evidence = await writeEvidenceArtifact("profile.json", `${JSON.stringify(profile, null, 2)}\n`);
  return { path: evidence.path, sha256: canonicalVoiceProfileSha256(profile) };
}

async function preferredBackendPolicyWithArtifacts(
  overrides: Partial<NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]>> = {},
): Promise<NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]>> {
  const profile = await writeProfileEvidenceArtifact();
  const backend = overrides.backend ?? "indextts2";
  const baselineBackend = overrides.baselineBackend ?? "voxcpm2-hifi";
  const profileEvidence = { voiceProfileId: "local-test", profileSha256: profile.sha256 };
  const baselineWav = await writeEvidenceArtifact("baseline.wav", Buffer.from([0, 1, 0, 1]));
  const candidateWav = await writeEvidenceArtifact("candidate.wav", Buffer.from([1, 2, 3, 4]));
  const sourceReport = await writeEvidenceArtifact(
    "backend-report.json",
    JSON.stringify({
      version: 1,
      voiceProfile: profileEvidence,
      groups: [
        {
          cloneMode: baselineBackend,
          case: { id: "smoke", text: "hello world" },
          caseId: "smoke",
          ...profileEvidence,
          renders: [{ repeat: 1, status: "ready", outputWav: "baseline.wav", ...profileEvidence }],
        },
        {
          cloneMode: backend,
          case: { id: "smoke", text: "hello world" },
          caseId: "smoke",
          ...profileEvidence,
          renders: [
            {
              repeat: 1,
              status: "ready",
              outputWav: candidateWav.path,
              externalBackend: true,
              outputExists: true,
              missingOutput: false,
              outputBytes: candidateWav.bytes,
              outputSha256: candidateWav.sha256,
              ...profileEvidence,
            },
          ],
        },
      ],
    }),
  );
  const score = await writeEvidenceArtifact(
    "backend-score.json",
    JSON.stringify({
      version: 1,
      verdict: "pass",
      sourceReport: sourceReport.path,
      sourceReportSha256: sourceReport.sha256,
      voiceProfile: profileEvidence,
      groups: [
        {
          cloneMode: baselineBackend,
          caseId: "smoke",
          verdict: "pass",
          pronunciationVerdict: "pass",
          stabilityVerdict: "pass",
          speakerIdentityVerdict: "pass",
          audioQualityVerdict: "pass",
          speakerIdentity: { verdict: "pass", avgSpeakerSimilarity: 0.8 },
          ...profileEvidence,
          renders: [
            {
              repeat: 1,
              caseId: "smoke",
              status: "ready",
              outputWav: baselineWav.path,
              outputExists: true,
              missingOutput: false,
              outputBytes: baselineWav.bytes,
              outputSha256: baselineWav.sha256,
              ...profileEvidence,
            },
          ],
        },
        {
          cloneMode: backend,
          caseId: "smoke",
          verdict: "pass",
          pronunciationVerdict: "pass",
          stabilityVerdict: "pass",
          speakerIdentityVerdict: "pass",
          audioQualityVerdict: "pass",
          speakerIdentity: { verdict: "pass", avgSpeakerSimilarity: 0.9 },
          ...profileEvidence,
          renders: [
            {
              repeat: 1,
              caseId: "smoke",
              status: "ready",
              externalBackend: true,
              outputExists: true,
              missingOutput: false,
              outputWav: candidateWav.path,
              outputBytes: candidateWav.bytes,
              outputSha256: candidateWav.sha256,
              ...profileEvidence,
            },
          ],
        },
      ],
    }),
  );
  const review = await writeEvidenceArtifact(
    "backend-review.json",
    JSON.stringify({
      status: "pass",
      reportPath: sourceReport.path,
      reportSha256: sourceReport.sha256,
      stats: {
        rounds: 5,
        reviewedRounds: 5,
        candidateWins: 4,
        baselineWins: 1,
        ties: 0,
        rerenders: 0,
        candidateWinRate: 0.8,
        minCandidateWinRate: 0.8,
        reportSha256: sourceReport.sha256,
      },
      choices: { "winner-smoke-r01": "A" },
    }),
  );
  const selection = await writeEvidenceArtifact(
    "backend-selection.json",
    JSON.stringify({
      verdict: "accept",
      accepted: true,
      baselineCloneMode: baselineBackend,
      candidateCloneMode: backend,
      voiceProfile: profileEvidence,
      scoreJson: score.path,
      scoreSha256: score.sha256,
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: sourceReport.path,
      sourceReportSha256: sourceReport.sha256,
      subjectiveReview: acceptedBackendSubjectiveReview(),
    }),
  );
  return preferredBackendPolicy({
    profileJson: profile.path,
    profileSha256: profile.sha256,
    backend,
    baselineBackend,
    selectionJson: selection.path,
    selectionSha256: selection.sha256,
    scoreJson: score.path,
    scoreSha256: score.sha256,
    reviewJson: review.path,
    reviewSha256: review.sha256,
    sourceReport: sourceReport.path,
    sourceReportSha256: sourceReport.sha256,
    subjectiveReview: acceptedBackendSubjectiveReview(),
    ...overrides,
  });
}

async function rebindPreferredBackendPolicyArtifacts(
  preferredBackend: NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]>,
): Promise<void> {
  const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as Record<string, unknown>;
  const selection = JSON.parse(await readFile(preferredBackend.selectionJson!, "utf-8")) as Record<string, unknown>;
  const sourceReportSha256 = await evidenceFileSha256(preferredBackend.sourceReport!);
  score.sourceReportSha256 = sourceReportSha256;
  await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
  const scoreSha256 = await evidenceFileSha256(preferredBackend.scoreJson!);
  selection.sourceReportSha256 = sourceReportSha256;
  selection.scoreSha256 = scoreSha256;
  await writeFile(preferredBackend.selectionJson!, JSON.stringify(selection), "utf-8");
  preferredBackend.sourceReportSha256 = sourceReportSha256;
  preferredBackend.scoreSha256 = scoreSha256;
  preferredBackend.selectionSha256 = await evidenceFileSha256(preferredBackend.selectionJson!);
}

async function loraAdapterPolicyWithArtifacts(
  overrides: Partial<NonNullable<NonNullable<CloneInput["profileReference"]>["loraAdapter"]>> = {},
): Promise<NonNullable<NonNullable<CloneInput["profileReference"]>["loraAdapter"]>> {
  const profile = await writeProfileEvidenceArtifact();
  const adapter = await writeEvidenceArtifact("lora_weights.ckpt", Buffer.from([9, 8, 7, 6]));
  const trainConfig = await writeEvidenceArtifact("train_config.json", JSON.stringify({ trainer: { status: "ready" } }));
  const loraRender = await writeEvidenceArtifact("lora-r01.wav", Buffer.from([4, 3, 2, 1]));
  const adapterProof = await writeEvidenceArtifact(
    "adapter-proof.json",
    JSON.stringify({
      status: "pass",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
      checkpoint: {
        status: "readable",
        loraParameterKeyCount: 2,
        loraParameterKeys: ["encoder.lora_A.weight", "encoder.lora_B.weight"],
      },
    }),
  );
  const profileEvidence = { voiceProfileId: "local-test", profileSha256: profile.sha256 };
  const report = await writeEvidenceArtifact(
    "lora-report.json",
    JSON.stringify({
      version: 1,
      voiceProfile: profileEvidence,
      groups: [
        {
          ...profileEvidence,
          cloneMode: "hifi",
          case: { id: "smoke", text: "hello world" },
          renders: [
            {
              ...profileEvidence,
              repeat: 1,
              status: "ready",
              outputWav: "lora-r01.wav",
              outputExists: true,
              missingOutput: false,
              outputBytes: loraRender.bytes,
              outputSha256: loraRender.sha256,
              effectiveParams: {
                loraEnabled: true,
                loraPath: adapter.path,
              },
            },
          ],
        },
      ],
    }),
  );
  const asr = await writeEvidenceArtifact("lora-asr.json", JSON.stringify({ "hifi/smoke/r01": "hello world" }));
  const speaker = await writeEvidenceArtifact(
    "lora-speaker.json",
    JSON.stringify({ version: 1, backend: "speechbrain-ecapa", summary: { total: 1, scored: 1, failed: 0 } }),
  );
  const transcriptValidation = await writeEvidenceArtifact(
    "profile-transcript-validation.json",
    JSON.stringify({
      status: "pass",
      profile: profile.path,
      voiceProfileId: "local-test",
      profileSha256: profile.sha256,
      clips: [
        {
          sourceRunId: "clip-1",
          audioPath: "/tmp/profile/clip-1.wav",
          expectedTranscript: "hello world",
          verdict: "pass",
        },
      ],
    }),
  );
  const score = await writeEvidenceArtifact(
    "lora-score.json",
    JSON.stringify({
      version: 1,
      verdict: "pass",
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
      asrJson: asr.path,
      asrJsonSha256: asr.sha256,
      speakerJson: speaker.path,
      speakerJsonSha256: speaker.sha256,
      thresholds: {
        requireSpeakerSimilarity: true,
        requireProfileReferenceSimilarity: true,
      },
      voiceProfile: profileEvidence,
      groups: [
        {
          ...profileEvidence,
          cloneMode: "hifi",
          renderCount: 1,
          verdict: "pass",
          speakerIdentityVerdict: "pass",
          speakerIdentity: {
            verdict: "pass",
            avgSpeakerSimilarity: 0.9,
            profileReferenceEvaluatedRenders: 1,
            requireProfileReferenceSimilarity: true,
          },
          renders: [
            {
              ...profileEvidence,
              repeat: 1,
              status: "ready",
              outputWav: loraRender.path,
              outputExists: true,
              missingOutput: false,
              outputBytes: loraRender.bytes,
              outputSha256: loraRender.sha256,
            },
          ],
        },
      ],
      summary: { avgCer: 0, avgWer: 0, avgSpeakerSimilarity: 0.9 },
    }),
  );
  const qualityGate = await writeEvidenceArtifact(
    "lora-quality-gate.json",
    JSON.stringify({
      version: 1,
      status: "pass",
      dryRun: false,
      inputs: {
        profileJson: profile.path,
        profileSha256: profile.sha256,
        cloneMode: "hifi",
        loraPath: adapter.path,
        requireSpeakerBackend: "speechbrain-ecapa",
        skipProfileVerify: false,
        skipTranscriptValidation: false,
        transcriptValidationJson: transcriptValidation.path,
        transcriptValidationSha256: transcriptValidation.sha256,
      },
      proofs: {
        speakerBackendRequirement: { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" },
        loraAdapter: { path: adapter.path, exists: true, bytes: adapter.bytes, sha256: adapter.sha256 },
        profileVerifyRequired: true,
        profileVerifySkipped: false,
        profileVerifyPassed: true,
        transcriptValidationRequired: true,
        transcriptValidationSkipped: false,
        transcriptValidationJson: transcriptValidation.path,
        transcriptValidationSha256: transcriptValidation.sha256,
        transcriptValidationPassed: true,
        artifacts: {
          report: { path: report.path, sha256: report.sha256 },
          asr: { path: asr.path, sha256: asr.sha256 },
          speaker: { path: speaker.path, sha256: speaker.sha256 },
          score: { path: score.path, sha256: score.sha256 },
        },
      },
      paths: {
        report: report.path,
        asr: asr.path,
        speaker: speaker.path,
        score: score.path,
        profileTranscriptValidation: transcriptValidation.path,
      },
    }),
  );
  return {
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
    qualityGateProof: {
      status: "pass",
      dryRun: false,
      cloneMode: "hifi",
      speakerBackend: "speechbrain-ecapa",
      requiredSpeakerBackend: "speechbrain-ecapa",
      profileVerifyRequired: true,
      profileVerifyPassed: true,
      profileVerifySkipped: false,
      transcriptValidationRequired: true,
      transcriptValidationPassed: true,
      transcriptValidationSkipped: false,
      transcriptValidationJson: transcriptValidation.path,
      transcriptValidationSha256: transcriptValidation.sha256,
      artifacts: {
        report: { path: report.path, sha256: report.sha256 },
        asr: { path: asr.path, sha256: asr.sha256 },
        speaker: { path: speaker.path, sha256: speaker.sha256 },
        score: { path: score.path, sha256: score.sha256 },
      },
    },
    ...overrides,
  };
}

async function rebindLoraQualityGateArtifacts(
  loraAdapter: NonNullable<NonNullable<CloneInput["profileReference"]>["loraAdapter"]>,
): Promise<void> {
  const gate = JSON.parse(await readFile(loraAdapter.qualityGateJson!, "utf-8")) as {
    paths: { report: string; score: string };
    proofs: { artifacts: { report: { sha256: string }; score: { sha256: string } } };
  };
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8")) as Record<string, unknown>;
  const reportSha256 = await evidenceFileSha256(gate.paths.report);
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, JSON.stringify(score), "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
  await writeFile(loraAdapter.qualityGateJson!, JSON.stringify(gate), "utf-8");
  loraAdapter.qualityGateSha256 = await evidenceFileSha256(loraAdapter.qualityGateJson!);
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

function fakeExternalRenderer(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(async () => {
    const call = spawnMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const command = args[1] || "";
    const outMatch = command.match(/--out '([^']+)'/);
    if (outMatch) {
      await writeFile(outMatch[1], Buffer.from([1, 2, 3, 4]), null);
    }
    proc.stdout.emit("data", Buffer.from("external ok"));
    proc.emit("close", 0);
  }, 0);
  return proc;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-runner-"));
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_HOT_WORKER_URL;
  delete process.env.ANYVOICE_VOXCPM_LORA_PATH;
  delete process.env.ANYVOICE_STABILITY_SEED;
  delete process.env.ANYVOICE_PROFILE_BACKEND_MODE;
  delete process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND;
  delete process.env.ANYVOICE_BACKEND_RENDER_COMMAND;
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
  if (originalHotWorkerUrl === undefined) delete process.env.ANYVOICE_HOT_WORKER_URL;
  else process.env.ANYVOICE_HOT_WORKER_URL = originalHotWorkerUrl;
  if (originalCloneMode === undefined) delete process.env.ANYVOICE_VOXCPM_CLONE_MODE;
  else process.env.ANYVOICE_VOXCPM_CLONE_MODE = originalCloneMode;
  if (originalLoraPath === undefined) delete process.env.ANYVOICE_VOXCPM_LORA_PATH;
  else process.env.ANYVOICE_VOXCPM_LORA_PATH = originalLoraPath;
  if (originalStabilitySeed === undefined) delete process.env.ANYVOICE_STABILITY_SEED;
  else process.env.ANYVOICE_STABILITY_SEED = originalStabilitySeed;
  if (originalProfileBackendMode === undefined) delete process.env.ANYVOICE_PROFILE_BACKEND_MODE;
  else process.env.ANYVOICE_PROFILE_BACKEND_MODE = originalProfileBackendMode;
  if (originalProfileBackendRenderCommand === undefined) delete process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND;
  else process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND = originalProfileBackendRenderCommand;
  if (originalBackendRenderCommand === undefined) delete process.env.ANYVOICE_BACKEND_RENDER_COMMAND;
  else process.env.ANYVOICE_BACKEND_RENDER_COMMAND = originalBackendRenderCommand;
  vi.unstubAllGlobals();
});

describe("planTargetChunks", () => {
  it("keeps short text as a single pass", () => {
    expect(planTargetChunks("你好，這是一句短短的測試。")).toHaveLength(1);
    expect(planTargetChunks("hello world")).toEqual(["hello world"]);
  });

  it("splits long text into multiple sentence-packed chunks", () => {
    const sentence = "這是一段用來測試長文切分的句子，內容必須夠長才能超過單次合成的字數上限。";
    const long = Array.from({ length: 8 }, () => sentence).join("");
    const chunks = planTargetChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the single-pass ceiling (with a small packing margin).
    expect(chunks.every((c) => c.length <= 220 * 1.5)).toBe(true);
    // Nothing is dropped.
    expect(chunks.join("").length).toBeGreaterThanOrEqual(long.length - chunks.length);
  });

  it("never returns an empty plan", () => {
    expect(planTargetChunks("").length).toBeGreaterThanOrEqual(1);
  });
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
    expect(parsed.stabilitySeed).toBe(1337);
    expect(parsed.textPreparation.targetText.model).toBe("hello world");

    const targetText = await readFile(path.join(runDir, "target.txt"), "utf-8");
    expect(targetText).toBe("hello world");
    const targetRaw = await readFile(path.join(runDir, "target.raw.txt"), "utf-8");
    expect(targetRaw).toBe("hello world");
    const prompt = await readFile(path.join(runDir, "prompt-transcript.txt"), "utf-8");
    expect(prompt).toBe("transcript text");
    const textPrep = JSON.parse(await readFile(path.join(runDir, "text-prep.json"), "utf-8"));
    expect(textPrep.targetText.policy).toBe("preserve_zh_hant");
  });

  it("writes pronunciation overrides into model text and request metadata", async () => {
    const jobId = "jobPron";
    await recordWorkerMissingRun(
      jobId,
      makeInput({
        targetText: "重慶、AnyVoice 和行長都要讀準。",
        pronunciationOverrides: [
          { term: "重慶", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing" },
          { term: "AnyVoice", replacement: "Any Voice", kind: "brand", source: "preset", presetId: "brand:anyvoice" },
          { term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom" },
        ],
      }),
    );
    const runDir = path.join(tmpRoot, jobId);
    await expect(readFile(path.join(runDir, "target.raw.txt"), "utf-8")).resolves.toBe("重慶、AnyVoice 和行長都要讀準。");
    await expect(readFile(path.join(runDir, "target.txt"), "utf-8")).resolves.toBe("重 慶、Any Voice 和xing2 zhang3都要讀準。");
    const textPrep = JSON.parse(await readFile(path.join(runDir, "text-prep.json"), "utf-8"));
    expect(textPrep.targetText.pronunciationOverrides).toEqual([
      { term: "AnyVoice", replacement: "Any Voice", kind: "brand", source: "preset", presetId: "brand:anyvoice", count: 1 },
      { term: "重慶", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing", count: 1 },
      { term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom", count: 1 },
    ]);
    const request = JSON.parse(await readFile(path.join(runDir, "request.json"), "utf-8"));
    expect(request.pronunciationOverrides).toEqual([
      { term: "重慶", replacement: "重 慶", kind: "polyphone", source: "preset", presetId: "polyphone:chongqing" },
      { term: "AnyVoice", replacement: "Any Voice", kind: "brand", source: "preset", presetId: "brand:anyvoice" },
      { term: "行長", replacement: "xing2 zhang3", kind: "pinyin", source: "custom" },
    ]);
  });

  it("auto-applies known pronunciation presets to generated target text", async () => {
    const jobId = "jobAutoPron";
    await recordWorkerMissingRun(
      jobId,
      makeInput({
        targetText: "請用我的聲音說重慶、銀行和 VoxCPM2。",
        promptTranscript: "請用我的聲音說這句話。",
      }),
    );
    const runDir = path.join(tmpRoot, jobId);
    await expect(readFile(path.join(runDir, "target.raw.txt"), "utf-8")).resolves.toBe(
      "請用我的聲音說重慶、銀行和 VoxCPM2。",
    );
    await expect(readFile(path.join(runDir, "target.txt"), "utf-8")).resolves.toBe(
      "請用我的聲音說重 慶、銀 行和 Vox C P M two。",
    );
    const prompt = await readFile(path.join(runDir, "prompt-transcript.txt"), "utf-8");
    expect(prompt).toBe("請用我的聲音說這句話。");
    const textPrep = JSON.parse(await readFile(path.join(runDir, "text-prep.json"), "utf-8"));
    expect(textPrep.targetText.operations).toContain("auto_apply_pronunciation_presets");
    expect(textPrep.targetText.pronunciationOverrides).toEqual([
      {
        term: "VoxCPM2",
        replacement: "Vox C P M two",
        reason: "brand",
        kind: "brand",
        source: "preset",
        presetId: "brand:voxcpm2",
        count: 1,
      },
      {
        term: "重慶",
        replacement: "重 慶",
        reason: "polyphone",
        kind: "polyphone",
        source: "preset",
        presetId: "polyphone:chongqing",
        count: 1,
      },
      {
        term: "銀行",
        replacement: "銀 行",
        reason: "polyphone",
        kind: "polyphone",
        source: "preset",
        presetId: "polyphone:bank",
        count: 1,
      },
    ]);
    expect(textPrep.promptTranscript.operations).not.toContain("auto_apply_pronunciation_presets");
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
          cloneMode: "hifi",
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
          clone_mode: "hifi",
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
    expect(args).toContain("--text-prep-file");
    expect(args).toContain("--quality");
    expect(args).toContain("--seed");
    expect(args[args.indexOf("--seed") + 1]).toBe("1337");
    expect(args).toContain("--clone-mode");
    expect(args[args.indexOf("--clone-mode") + 1]).toBe("hifi");
  });

  it("can pass the prompt-only clone mode for rollback A/B tests", async () => {
    process.env.ANYVOICE_VOXCPM_CLONE_MODE = "prompt";
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: { timesteps: 8, cfgValue: 2, denoise: false, qualityPreset: "balanced", cloneMode: "prompt" },
      }) as never,
    );
    const result = await runLocalClone("jobPrompt", makeInput());
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--clone-mode") + 1]).toBe("prompt");
    expect(result.effectiveParams.cloneMode).toBe("prompt");
  });

  it("can disable the stability seed for exploratory one-shot renders", async () => {
    process.env.ANYVOICE_STABILITY_SEED = "off";
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: { timesteps: 8, cfgValue: 2, denoise: false, qualityPreset: "balanced", cloneMode: "hifi" },
      }) as never,
    );
    await runLocalClone("jobNoSeed", makeInput());
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("--seed");
    const request = JSON.parse(await readFile(path.join(tmpRoot, "jobNoSeed", "request.json"), "utf-8"));
    expect(request.stabilitySeed).toBeNull();
  });

  it("keeps full text-prep metadata after long-text chunked synthesis", async () => {
    const sentence = "請把重慶和 AnyVoice 讀準，並且保持穩定節奏。";
    const longTarget = Array.from({ length: 16 }, () => sentence).join("");
    expect(planTargetChunks(longTarget).length).toBeGreaterThan(1);
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: { timesteps: 8, cfgValue: 2, denoise: false, qualityPreset: "balanced", cloneMode: "hifi" },
        textPreparation: {
          targetText: { raw: "first chunk only", model: "first chunk only" },
          promptTranscript: { raw: "hello world", model: "hello world" },
        },
      }) as never,
    );

    await runLocalClone("jobChunked", makeInput({ targetText: longTarget }));

    const metadata = JSON.parse(await readFile(path.join(tmpRoot, "jobChunked", "metadata.json"), "utf-8"));
    expect(metadata.textPreparation.targetText.raw).toBe(longTarget);
    expect(metadata.textPreparation.targetText.model).toContain("重 慶");
    expect(metadata.textPreparation.targetText.model).toContain("Any Voice");
    expect(metadata.chunkedSynthesis).toMatchObject({
      version: 1,
      maxSinglePassChars: 220,
    });
    expect(metadata.chunkedSynthesis.chunks.length).toBeGreaterThan(1);
    expect(metadata.chunkedSynthesis.chunks[0]).toMatchObject({
      index: 0,
      textPrepFile: expect.stringContaining("chunk-000.prep.json"),
      outputWav: expect.stringContaining("chunk-000.wav"),
    });
  });

  it("surfaces hot worker error events during long-text chunked synthesis", async () => {
    process.env.ANYVOICE_HOT_WORKER_URL = "http://127.0.0.1:8765";
    const longTarget = Array.from(
      { length: 12 },
      () => "這是一段很長的測試文字，用來觸發分段合成，並驗證熱工作站錯誤會被傳回。",
    ).join("");
    expect(planTargetChunks(longTarget).length).toBeGreaterThan(1);
    const fetchMock = vi.fn(async () =>
      new Response(`${JSON.stringify({ type: "error", message: "chunk crashed" })}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runLocalClone("jobChunkedHotError", makeInput({ targetText: longTarget }))).rejects.toThrow(
      /chunk crashed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("passes a configured VoxCPM LoRA path to the one-shot Python worker", async () => {
    process.env.ANYVOICE_VOXCPM_LORA_PATH = "/tmp/voice-lora/lora_weights.ckpt";
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: {
          timesteps: 8,
          cfgValue: 2,
          denoise: false,
          qualityPreset: "balanced",
          cloneMode: "hifi",
          loraEnabled: true,
          loraPath: "/tmp/voice-lora/lora_weights.ckpt",
        },
      }) as never,
    );
    const result = await runLocalClone("jobLora", makeInput());
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--lora-path");
    expect(args[args.indexOf("--lora-path") + 1]).toBe("/tmp/voice-lora/lora_weights.ckpt");
    expect(result.effectiveParams.loraEnabled).toBe(true);
    expect(result.effectiveParams.loraPath).toBe("/tmp/voice-lora/lora_weights.ckpt");
  });

  it("prefers an applied profile LoRA adapter over the global env path", async () => {
    process.env.ANYVOICE_VOXCPM_LORA_PATH = "/tmp/global-lora/lora_weights.ckpt";
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: {
          timesteps: 8,
          cfgValue: 2,
          denoise: false,
          qualityPreset: "balanced",
          cloneMode: "hifi",
          loraEnabled: true,
          loraPath: loraAdapter.path,
        },
      }) as never,
    );
    const result = await runLocalClone(
      "jobProfileLora",
      makeInput({
        sourceKind: "profile",
        profileReference: {
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          referenceClipIds: ["clip-1"],
          audioPath: "/tmp/profile/clip-1.wav",
          loraPath: loraAdapter.path,
          loraAdapter,
        },
      }),
    );
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--lora-path");
    expect(args[args.indexOf("--lora-path") + 1]).toBe(loraAdapter.path);
    expect(result.effectiveParams.loraPath).toBe(loraAdapter.path);
  });

  it("accepts profile LoRA adapter policies whose adapter path is relative to cwd", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const absoluteLoraPath = loraAdapter.path;
    loraAdapter.path = path.relative(process.cwd(), absoluteLoraPath);
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: {
          timesteps: 8,
          cfgValue: 2,
          denoise: false,
          qualityPreset: "balanced",
          cloneMode: "hifi",
          loraEnabled: true,
          loraPath: absoluteLoraPath,
        },
      }) as never,
    );

    const result = await runLocalClone(
      "jobProfileLoraRelativePolicyPath",
      makeInput({
        sourceKind: "profile",
        profileReference: {
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          referenceClipIds: ["clip-1"],
          audioPath: "/tmp/profile/clip-1.wav",
          loraPath: absoluteLoraPath,
          loraAdapter,
        },
      }),
    );

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--lora-path");
    expect(args[args.indexOf("--lora-path") + 1]).toBe(absoluteLoraPath);
    expect(result.effectiveParams.loraPath).toBe(absoluteLoraPath);
  });

  it("accepts profile LoRA adapter policies with portable quality gate proof summary paths before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const proof = loraAdapter.qualityGateProof as {
      transcriptValidationJson: string;
      artifacts: Record<string, { path: string; sha256: string }>;
    };
    proof.transcriptValidationJson = path.relative(process.cwd(), proof.transcriptValidationJson);
    for (const key of ["report", "asr", "speaker", "score"]) {
      proof.artifacts[key].path = path.relative(process.cwd(), proof.artifacts[key].path);
    }
    spawnMock.mockImplementation(() =>
      fakeSuccess({
        referenceQuality: { grade: "B", durationSec: 6, snrDb: 25, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
        effectiveParams: {
          timesteps: 8,
          cfgValue: 2,
          denoise: false,
          qualityPreset: "balanced",
          cloneMode: "hifi",
          loraEnabled: true,
          loraPath: loraAdapter.path,
        },
      }) as never,
    );

    const result = await runLocalClone(
      "jobProfileLoraPortableSummary",
      makeInput({
        sourceKind: "profile",
        profileReference: {
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          referenceClipIds: ["clip-1"],
          audioPath: "/tmp/profile/clip-1.wav",
          loraPath: loraAdapter.path,
          loraAdapter,
        },
      }),
    );

    expect(spawnMock).toHaveBeenCalled();
    expect(result.effectiveParams.loraPath).toBe(loraAdapter.path);
  });

  it("rejects stale profile LoRA adapter evidence before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts({ trainConfigSha256: "0".repeat(64) });
    await expect(
      runLocalClone(
        "jobStaleProfileLora",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/loraAdapter\.trainConfigSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects stale profile LoRA quality gate proof summaries before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts({
      qualityGateProof: {
        status: "pass",
        dryRun: false,
        cloneMode: "hifi",
        speakerBackend: "mfcc-cosine",
        requiredSpeakerBackend: "speechbrain-ecapa",
      },
    });
    await expect(
      runLocalClone(
        "jobStaleProfileLoraSummary",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/loraAdapter\.qualityGateProof_matches_qualityGate/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter proofs without readable checkpoint evidence before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    await writeFile(loraAdapter.adapterProofJson!, JSON.stringify({ status: "pass" }), "utf-8");
    loraAdapter.adapterProofSha256 = await evidenceFileSha256(loraAdapter.adapterProofJson!);

    await expect(
      runLocalClone(
        "jobWeakProfileLoraAdapterProof",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/adapterProof\.checkpoint\.status=readable/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter proofs not bound to the applied train config before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const proof = JSON.parse(await readFile(loraAdapter.adapterProofJson!, "utf-8")) as Record<string, unknown>;
    proof.trainConfigSha256 = "0".repeat(64);
    await writeFile(loraAdapter.adapterProofJson!, JSON.stringify(proof), "utf-8");
    loraAdapter.adapterProofSha256 = await evidenceFileSha256(loraAdapter.adapterProofJson!);

    await expect(
      runLocalClone(
        "jobUnboundProfileLoraAdapterProof",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/adapterProof\.trainConfigSha256_matches_policy/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies bound to a stale profile hash before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts({ profileSha256: "0".repeat(64) });
    await expect(
      runLocalClone(
        "jobStaleProfileHashLora",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/profile LoRA adapter profile evidence is stale or missing: profileSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate artifact changed before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { asr: string };
    };
    await writeFile(gate.paths.asr, JSON.stringify({ stale: "changed after apply" }), "utf-8");

    await expect(
      runLocalClone(
        "jobStaleProfileLoraGateArtifact",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/profile LoRA adapter quality gate proof is stale or missing: asr: artifact\.sha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate score consumed a stale ASR hash before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { score: string };
      proofs: { artifacts: { score: { sha256: string } } };
    };
    const scorePayload = JSON.parse(await readFile(gate.paths.score, "utf-8")) as { asrJsonSha256: string };
    scorePayload.asrJsonSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, JSON.stringify(scorePayload), "utf-8");
    gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobStaleProfileLoraGateScore",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/score\.asrJsonSha256_matches_paths\.asr/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate score omits ready render output proof before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { score: string };
      proofs: { artifacts: { score: { sha256: string } } };
    };
    const scorePayload = JSON.parse(await readFile(gate.paths.score, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    const render = scorePayload.groups[0].renders[0];
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
    await writeFile(gate.paths.score, JSON.stringify(scorePayload), "utf-8");
    gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateScoreMissingOutputProof",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/score\.groups\[0\]\.renders\[0\]\.outputExists=true/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose source report render output hash is stale before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { report: string };
    };
    const reportPayload = JSON.parse(await readFile(gate.paths.report, "utf-8")) as {
      groups: Array<{ renders: Array<{ outputWav: string }> }>;
    };
    const renderOutput = path.resolve(path.dirname(gate.paths.report), reportPayload.groups[0].renders[0].outputWav);
    await writeFile(renderOutput, Buffer.from("changed after gate passed\n"));

    await expect(
      runLocalClone(
        "jobProfileLoraGateReportStaleOutputProof",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.groups\[0\]\.renders\[0\]\.outputBytes_matches_file/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate score lacks strict speaker proof before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { score: string };
      proofs: { artifacts: { score: { sha256: string } } };
    };
    const scorePayload = JSON.parse(await readFile(gate.paths.score, "utf-8")) as {
      groups: Array<{
        verdict?: string;
        speakerIdentityVerdict?: string;
        speakerIdentity?: { verdict?: string };
      }>;
    };
    scorePayload.groups[0].verdict = "review";
    scorePayload.groups[0].speakerIdentityVerdict = "review";
    scorePayload.groups[0].speakerIdentity = { verdict: "review" };
    await writeFile(gate.paths.score, JSON.stringify(scorePayload), "utf-8");
    gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobWeakProfileLoraGateScoreSpeakerProof",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/score\.groups\[0\]\.speakerIdentityVerdict=pass/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate score carries stale profile evidence before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { score: string };
      proofs: { artifacts: { score: { sha256: string } } };
    };
    const scorePayload = JSON.parse(await readFile(gate.paths.score, "utf-8")) as {
      voiceProfile: { profileSha256: string };
    };
    scorePayload.voiceProfile.profileSha256 = "0".repeat(64);
    await writeFile(gate.paths.score, JSON.stringify(scorePayload), "utf-8");
    gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobStaleProfileLoraGateScoreEvidence",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/score\.voiceProfile\.profileSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate report carries stale profile evidence before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { report: string; score: string };
      proofs: { artifacts: { report: { sha256: string }; score: { sha256: string } } };
    };
    const reportPayload = JSON.parse(await readFile(gate.paths.report, "utf-8")) as {
      groups: Array<{ renders: Array<{ voiceProfileId: string }> }>;
    };
    reportPayload.groups[0].renders[0].voiceProfileId = "other-profile";
    await writeFile(gate.paths.report, JSON.stringify(reportPayload), "utf-8");
    const reportSha256 = await evidenceFileSha256(gate.paths.report);
    const scorePayload = JSON.parse(await readFile(gate.paths.score, "utf-8")) as { sourceReportSha256: string };
    scorePayload.sourceReportSha256 = reportSha256;
    await writeFile(gate.paths.score, JSON.stringify(scorePayload), "utf-8");
    gate.proofs.artifacts.report.sha256 = reportSha256;
    gate.proofs.artifacts.score.sha256 = await evidenceFileSha256(gate.paths.score);
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobStaleProfileLoraGateReportEvidence",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.groups\[0\]\.renders\[0\]\.voiceProfileId/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose source report does not prove the adapter was loaded before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      paths: { report: string };
    };
    const reportPayload = JSON.parse(await readFile(gate.paths.report, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    delete reportPayload.groups[0].renders[0].effectiveParams;
    await writeFile(gate.paths.report, JSON.stringify(reportPayload), "utf-8");
    await rebindLoraQualityGateArtifacts(loraAdapter);

    await expect(
      runLocalClone(
        "jobProfileLoraGateMissingRenderEvidence",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.groups\[0\]\.renders\[0\]\.effectiveParams/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate skipped transcript validation before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      proofs: {
        transcriptValidationRequired?: boolean;
        transcriptValidationSkipped?: boolean;
        transcriptValidationPassed?: boolean;
      };
    };
    gate.proofs.transcriptValidationRequired = false;
    gate.proofs.transcriptValidationSkipped = true;
    gate.proofs.transcriptValidationPassed = false;
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateSkippedTranscriptValidation",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/transcriptValidationRequired=true/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate input disabled transcript validation before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      inputs: {
        skipTranscriptValidation?: boolean;
      };
    };
    gate.inputs.skipTranscriptValidation = true;
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateInputSkippedTranscriptValidation",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/inputs\.skipTranscriptValidation=false/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose quality gate skipped profile verification before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      inputs: {
        skipProfileVerify?: boolean;
      };
      proofs: {
        profileVerifyRequired?: boolean;
        profileVerifySkipped?: boolean;
        profileVerifyPassed?: boolean;
      };
    };
    gate.inputs.skipProfileVerify = true;
    gate.proofs.profileVerifyRequired = false;
    gate.proofs.profileVerifySkipped = true;
    gate.proofs.profileVerifyPassed = false;
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateSkippedProfileVerify",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/profileVerifyRequired=true/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose transcript validation rows are stale before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      inputs: { transcriptValidationSha256: string };
      proofs: { transcriptValidationSha256: string };
      paths: { profileTranscriptValidation: string };
    };
    const validation = JSON.parse(await readFile(gate.paths.profileTranscriptValidation, "utf-8")) as {
      clips: Array<{ expectedTranscript: string }>;
    };
    validation.clips[0].expectedTranscript = "changed transcript";
    await writeFile(gate.paths.profileTranscriptValidation, JSON.stringify(validation), "utf-8");
    const validationSha256 = await evidenceFileSha256(gate.paths.profileTranscriptValidation);
    gate.inputs.transcriptValidationSha256 = validationSha256;
    gate.proofs.transcriptValidationSha256 = validationSha256;
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateStaleTranscriptRows",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/transcriptValidation\.rows_match_profile/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects profile LoRA adapter policies whose transcript validation profile id is stale before spawning", async () => {
    const loraAdapter = await loraAdapterPolicyWithArtifacts();
    const qualityGateJson = loraAdapter.qualityGateJson!;
    const gate = JSON.parse(await readFile(qualityGateJson, "utf-8")) as {
      inputs: { transcriptValidationSha256: string };
      proofs: { transcriptValidationSha256: string };
      paths: { profileTranscriptValidation: string };
    };
    const validation = JSON.parse(await readFile(gate.paths.profileTranscriptValidation, "utf-8")) as {
      voiceProfileId: string;
    };
    validation.voiceProfileId = "other-profile";
    await writeFile(gate.paths.profileTranscriptValidation, JSON.stringify(validation), "utf-8");
    const validationSha256 = await evidenceFileSha256(gate.paths.profileTranscriptValidation);
    gate.inputs.transcriptValidationSha256 = validationSha256;
    gate.proofs.transcriptValidationSha256 = validationSha256;
    await writeFile(qualityGateJson, JSON.stringify(gate), "utf-8");
    loraAdapter.qualityGateSha256 = await evidenceFileSha256(qualityGateJson);

    await expect(
      runLocalClone(
        "jobProfileLoraGateStaleTranscriptProfileId",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: loraAdapter.path,
            loraAdapter,
          },
        }),
      ),
    ).rejects.toThrow(/transcriptValidation\.voiceProfileId_matches_policy/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete profile LoRA adapter policies before spawning", async () => {
    await expect(
      runLocalClone(
        "jobIncompleteProfileLora",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: "/tmp/profile-lora/lora_weights.ckpt",
            loraAdapter: {
              status: "accepted",
              path: "/tmp/profile-lora/lora_weights.ckpt",
              sha256: "a".repeat(64),
              trainConfig: "/tmp/train_config.json",
              trainConfigSha256: "3".repeat(64),
            },
          },
        }),
      ),
    ).rejects.toThrow(/loraAdapter\.adapterProofJson/);
    await expect(
      runLocalClone(
        "jobMissingProfileLoraTrainConfig",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            loraPath: "/tmp/profile-lora/lora_weights.ckpt",
            loraAdapter: {
              status: "accepted",
              profileJson: "/tmp/profile/profile.json",
              voiceProfileId: "local-test",
              profileSha256: "c".repeat(64),
              path: "/tmp/profile-lora/lora_weights.ckpt",
              bytes: 123,
              sha256: "a".repeat(64),
              adapterProofJson: "/tmp/adapter-proof.json",
              adapterProofSha256: "1".repeat(64),
              qualityGateJson: "/tmp/lora-quality-gate.json",
              qualityGateSha256: "2".repeat(64),
            } as NonNullable<NonNullable<CloneInput["profileReference"]>["loraAdapter"]>,
          },
        }),
      ),
    ).rejects.toThrow(/loraAdapter\.trainConfig/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs an applied external profile backend through the renderer command contract", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --text-file {target_text_file} --reference {reference_audio} --prompt {prompt_text_file} --seed {seed} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    spawnMock.mockImplementation((command) => {
      if (command === "/bin/sh") return fakeExternalRenderer() as never;
      return fakeFailure(1, "ffmpeg unavailable") as never;
    });

    const result = await runLocalClone(
      "jobExternal",
      makeInput({
        sourceKind: "profile",
        targetText: "請把重慶和 AnyVoice 讀準。",
        profileReference: {
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          referenceClipIds: ["clip-1"],
          audioPath: "/tmp/profile/clip-1.wav",
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 28,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          preferredBackend: {
            ...preferredBackend,
          },
        },
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.referenceQuality.grade).toBe("A");
    expect(result.effectiveParams.voiceBackend).toBe("indextts2");
    expect(result.effectiveParams.backendBaselineBackend).toBe("voxcpm2-hifi");
    expect(result.effectiveParams.backendSelectionJson).toBe(preferredBackend.selectionJson);
    expect(result.effectiveParams.backendSelectionSha256).toBe(preferredBackend.selectionSha256);
    expect(result.effectiveParams.backendReviewJson).toBe(preferredBackend.reviewJson);
    expect(result.effectiveParams.backendReviewSha256).toBe(preferredBackend.reviewSha256);
    expect(result.effectiveParams.backendSourceReport).toBe(preferredBackend.sourceReport);
    expect(result.effectiveParams.backendSourceReportSha256).toBe(preferredBackend.sourceReportSha256);
    const shellCall = spawnMock.mock.calls.find((call) => call[0] === "/bin/sh");
    expect(shellCall).toBeTruthy();
    const shellCommand = (shellCall?.[1] as string[])[1];
    expect(shellCommand).toContain("--backend 'indextts2'");
    expect(shellCommand).toContain("--text-file '");
    expect(shellCommand).toContain("--reference '");
    expect(shellCommand).toContain("--prompt '");
    const request = JSON.parse(await readFile(path.join(tmpRoot, "jobExternal", "request.json"), "utf-8"));
    expect(request.referenceSource.preferredBackend).toMatchObject({
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionSha256: preferredBackend.selectionSha256,
      reviewSha256: preferredBackend.reviewSha256,
      sourceReportSha256: preferredBackend.sourceReportSha256,
    });
    const metadata = JSON.parse(await readFile(path.join(tmpRoot, "jobExternal", "metadata.json"), "utf-8"));
    expect(metadata.textPreparation.targetText.raw).toBe("請把重慶和 AnyVoice 讀準。");
    expect(metadata.textPreparation.targetText.model).toContain("重 慶");
    expect(metadata.textPreparation.targetText.model).toContain("Any Voice");
    expect(metadata.textPreparation.promptTranscript.model).toBe("hello world");
    expect(metadata.externalBackend).toMatchObject({
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      reviewJson: preferredBackend.reviewJson,
      reviewSha256: preferredBackend.reviewSha256,
      sourceReport: preferredBackend.sourceReport,
      sourceReportSha256: preferredBackend.sourceReportSha256,
    });
  });

  it("can try VoxCPM2 first and fall back to an accepted external profile backend", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_MODE = "voxcpm-first";
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --text-file {target_text_file} --reference {reference_audio} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({ backend: "f5-tts" });
    spawnMock.mockImplementation((command) => {
      if (command === "/bin/sh") return fakeExternalRenderer() as never;
      if (command === "ffmpeg") return fakeFailure(1, "ffmpeg unavailable") as never;
      return fakeFailure(1, "voxcpm crashed") as never;
    });

    const result = await runLocalClone(
      "jobExternalFallback",
      makeInput({
        sourceKind: "profile",
        profileReference: {
          voiceProfileId: "local-test",
          sourceRunId: "clip-1",
          referenceClipIds: ["clip-1"],
          audioPath: "/tmp/profile/clip-1.wav",
          preferredBackend: {
            ...preferredBackend,
          },
        },
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.effectiveParams.voiceBackend).toBe("f5-tts");
    expect(result.effectiveParams.backendBaselineBackend).toBe("voxcpm2-hifi");
    expect(result.effectiveParams.backendFallbackFrom).toBe("voxcpm2-hifi");
    expect(result.effectiveParams.backendFallbackReason).toContain("voxcpm crashed");
    expect(spawnMock.mock.calls[0][0]).not.toBe("/bin/sh");
    expect(spawnMock.mock.calls.some((call) => call[0] === "/bin/sh")).toBe(true);
    const fallbackError = await readFile(path.join(tmpRoot, "jobExternalFallback", "voxcpm-fallback-error.txt"), "utf-8");
    expect(fallbackError).toContain("voxcpm crashed");
    const metadata = JSON.parse(await readFile(path.join(tmpRoot, "jobExternalFallback", "metadata.json"), "utf-8"));
    expect(metadata.externalBackend).toMatchObject({
      backend: "f5-tts",
      baselineBackend: "voxcpm2-hifi",
      reviewJson: preferredBackend.reviewJson,
      reviewSha256: preferredBackend.reviewSha256,
      sourceReport: preferredBackend.sourceReport,
      sourceReportSha256: preferredBackend.sourceReportSha256,
      fallbackFrom: "voxcpm2-hifi",
    });
  });

  it("fails clearly when a selected external profile backend has no renderer command", async () => {
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    await expect(
      runLocalClone(
        "jobNoExternalCommand",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND|ANYVOICE_BACKEND_RENDER_COMMAND/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts portable subjective review summary paths before renderer execution", async () => {
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const selection = JSON.parse(await readFile(preferredBackend.selectionJson!, "utf-8")) as Record<string, unknown>;
    selection.subjectiveReview = {
      ...(selection.subjectiveReview as Record<string, unknown>),
      reviewJson: preferredBackend.reviewJson,
      report: preferredBackend.sourceReport,
    };
    const selectionJson = JSON.stringify(selection);
    await writeFile(preferredBackend.selectionJson!, selectionJson, "utf-8");
    preferredBackend.selectionSha256 = sha256(selectionJson);
    preferredBackend.subjectiveReview = {
      ...acceptedBackendSubjectiveReview(),
      reviewJson: path.relative(process.cwd(), preferredBackend.reviewJson!),
      report: path.relative(process.cwd(), preferredBackend.sourceReport!),
    };

    await expect(
      runLocalClone(
        "jobPortableExternalSummary",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND|ANYVOICE_BACKEND_RENDER_COMMAND/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects unsafe or unknown external renderer placeholders", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND = "python render.py --out {output_wav} --bad {unknown}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    await expect(
      runLocalClone(
        "jobBadExternalTemplate",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/unknown profile backend renderer placeholder/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects stale external backend evidence before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({ selectionSha256: "0".repeat(64) });
    await expect(
      runLocalClone(
        "jobStaleExternalPolicy",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/preferredBackend\.selectionSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend score proofs with stale source report hashes before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as Record<string, unknown>;
    score.sourceReportSha256 = "0".repeat(64);
    await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
    preferredBackend.scoreSha256 = await evidenceFileSha256(preferredBackend.scoreJson!);

    await expect(
      runLocalClone(
        "jobStaleExternalScoreSourceHash",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/score\.sourceReportSha256_matches_policy/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend review proofs with stale source report hashes before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const review = JSON.parse(await readFile(preferredBackend.reviewJson!, "utf-8")) as Record<string, unknown>;
    review.reportSha256 = "0".repeat(64);
    await writeFile(preferredBackend.reviewJson!, JSON.stringify(review), "utf-8");
    preferredBackend.reviewSha256 = await evidenceFileSha256(preferredBackend.reviewJson!);
    const selection = JSON.parse(await readFile(preferredBackend.selectionJson!, "utf-8")) as Record<string, unknown>;
    selection.reviewSha256 = preferredBackend.reviewSha256;
    await writeFile(preferredBackend.selectionJson!, JSON.stringify(selection), "utf-8");
    preferredBackend.selectionSha256 = await evidenceFileSha256(preferredBackend.selectionJson!);

    await expect(
      runLocalClone(
        "jobStaleExternalReviewSourceHash",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/review\.reportSha256_matches_policy/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend review proofs without exported pass status before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const review = JSON.parse(await readFile(preferredBackend.reviewJson!, "utf-8")) as Record<string, unknown>;
    delete review.status;
    await writeFile(preferredBackend.reviewJson!, JSON.stringify(review), "utf-8");
    preferredBackend.reviewSha256 = await evidenceFileSha256(preferredBackend.reviewJson!);
    const selection = JSON.parse(await readFile(preferredBackend.selectionJson!, "utf-8")) as Record<string, unknown>;
    selection.reviewSha256 = preferredBackend.reviewSha256;
    await writeFile(preferredBackend.selectionJson!, JSON.stringify(selection), "utf-8");
    preferredBackend.selectionSha256 = await evidenceFileSha256(preferredBackend.selectionJson!);

    await expect(
      runLocalClone(
        "jobReviewStatusMissing",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/review\.status=pass/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend score proofs whose baseline group did not pass before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as {
      groups: Array<{
        verdict?: string;
        speakerIdentityVerdict?: string;
        speakerIdentity?: { verdict?: string };
      }>;
    };
    score.groups[0].verdict = "review";
    score.groups[0].speakerIdentityVerdict = "review";
    score.groups[0].speakerIdentity = { verdict: "review" };
    await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
    await rebindPreferredBackendPolicyArtifacts(preferredBackend);

    await expect(
      runLocalClone(
        "jobExternalScoreBaselineReview",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/score\.baseline\.groups\[0\]\.verdict=pass/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend score proofs with stale render profile hashes before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    score.groups[0].renders[0].profileSha256 = "0".repeat(64);
    await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
    preferredBackend.scoreSha256 = await evidenceFileSha256(preferredBackend.scoreJson!);

    await expect(
      runLocalClone(
        "jobStaleExternalScoreRenderProfileHash",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/score\.groups\[0\]\.renders\[0\]\.profileSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend score proofs without ready render output files before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    delete score.groups[0].renders[0].outputExists;
    delete score.groups[0].renders[0].missingOutput;
    delete score.groups[0].renders[0].outputWav;
    delete score.groups[0].renders[0].outputBytes;
    delete score.groups[0].renders[0].outputSha256;
    await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
    await rebindPreferredBackendPolicyArtifacts(preferredBackend);

    await expect(
      runLocalClone(
        "jobMissingExternalScoreRenderOutput",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/score\.groups\[0\]\.renders\[0\]\.outputExists=true/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend source reports with stale profile bindings before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const score = JSON.parse(await readFile(preferredBackend.scoreJson!, "utf-8")) as Record<string, unknown>;
    const sourceReport = JSON.parse(await readFile(preferredBackend.sourceReport!, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    sourceReport.groups[1].renders[0].voiceProfileId = "other-profile";
    await writeFile(preferredBackend.sourceReport!, JSON.stringify(sourceReport), "utf-8");
    preferredBackend.sourceReportSha256 = await evidenceFileSha256(preferredBackend.sourceReport!);
    score.sourceReportSha256 = preferredBackend.sourceReportSha256;
    await writeFile(preferredBackend.scoreJson!, JSON.stringify(score), "utf-8");
    preferredBackend.scoreSha256 = await evidenceFileSha256(preferredBackend.scoreJson!);

    await expect(
      runLocalClone(
        "jobStaleExternalSourceReportProfile",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.groups\[1\]\.renders\[0\]\.voiceProfileId/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend source reports without candidate render file evidence before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const sourceReport = JSON.parse(await readFile(preferredBackend.sourceReport!, "utf-8")) as {
      groups: Array<{ renders: Array<Record<string, unknown>> }>;
    };
    const candidateRender = sourceReport.groups[1].renders[0];
    delete candidateRender.externalBackend;
    delete candidateRender.outputExists;
    delete candidateRender.outputBytes;
    delete candidateRender.outputSha256;
    await writeFile(preferredBackend.sourceReport!, JSON.stringify(sourceReport), "utf-8");
    await rebindPreferredBackendPolicyArtifacts(preferredBackend);

    await expect(
      runLocalClone(
        "jobExternalSourceReportMissingRenderEvidence",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.groups\[1\]\.renders\[0\]\.externalBackend=true/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies whose selection proof accepted a different backend", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const acceptedIndextts2 = await preferredBackendPolicyWithArtifacts();
    const mismatchedPolicy = {
      ...acceptedIndextts2,
      backend: "f5-tts",
    };

    await expect(
      runLocalClone(
        "jobWrongExternalBackend",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend: mismatchedPolicy,
          },
        }),
      ),
    ).rejects.toThrow(/sourceReport\.candidate_ready_renders/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies whose accepted selection lacks passing subjective review", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts();
    const selection = JSON.parse(await readFile(preferredBackend.selectionJson!, "utf-8")) as {
      subjectiveReview: { status: string; reasons: string[]; stats: { candidateWinRate: number } };
    };
    selection.subjectiveReview.status = "fail";
    selection.subjectiveReview.reasons = ["subjective_review_candidate_win_rate_below_threshold"];
    selection.subjectiveReview.stats.candidateWinRate = 0.6;
    await writeFile(preferredBackend.selectionJson!, JSON.stringify(selection), "utf-8");
    preferredBackend.selectionSha256 = await evidenceFileSha256(preferredBackend.selectionJson!);

    await expect(
      runLocalClone(
        "jobExternalSelectionSubjectiveFail",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/selection\.subjectiveReview\.status=pass/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies whose persisted subjective review summary is stale", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({
      subjectiveReview: { ...acceptedBackendSubjectiveReview(), status: "fail" },
    });

    await expect(
      runLocalClone(
        "jobExternalSelectionSubjectiveSummaryStale",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/preferredBackend\.subjectiveReview_matches_selection/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported external backend policies before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({ backend: "made-up-backend" });

    await expect(
      runLocalClone(
        "jobUnsupportedExternalBackend",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/profile preferred backend made-up-backend is unsupported/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies that were not measured against voxcpm2-hifi", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({ baselineBackend: "prompt" });

    await expect(
      runLocalClone(
        "jobWrongExternalBaseline",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/preferredBackend\.baselineBackend expected voxcpm2-hifi but found prompt/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies bound to a stale profile hash before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    const preferredBackend = await preferredBackendPolicyWithArtifacts({ profileSha256: "0".repeat(64) });
    await expect(
      runLocalClone(
        "jobStaleExternalProfileHash",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend,
          },
        }),
      ),
    ).rejects.toThrow(/profile preferred backend indextts2 profile evidence is stale or missing: profileSha256/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete external profile backend policies before spawning a renderer", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    await expect(
      runLocalClone(
        "jobIncompleteExternalPolicy",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend: {
              status: "accepted",
              backend: "indextts2",
            } as NonNullable<NonNullable<CloneInput["profileReference"]>["preferredBackend"]>,
          },
        }),
      ),
    ).rejects.toThrow(/evidence policy is incomplete/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects metrics-only external backend policies without subjective review proof", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    await expect(
      runLocalClone(
        "jobMetricsOnlyExternalPolicy",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend: preferredBackendPolicy({ reviewJson: null }),
          },
        }),
      ),
    ).rejects.toThrow(/preferredBackend\.reviewJson/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects external backend policies without baseline backend evidence", async () => {
    process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND =
      "python render_backend.py --backend {backend} --reference {reference_audio} --text-file {target_text_file} --out {output_wav}";
    await expect(
      runLocalClone(
        "jobNoBaselineExternalPolicy",
        makeInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1"],
            audioPath: "/tmp/profile/clip-1.wav",
            preferredBackend: preferredBackendPolicy({ baselineBackend: "" }),
          },
        }),
      ),
    ).rejects.toThrow(/preferredBackend\.baselineBackend/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses a configured hot worker instead of spawning per-request Python", async () => {
    process.env.ANYVOICE_HOT_WORKER_URL = "http://127.0.0.1:8765";
    process.env.ANYVOICE_VOXCPM_LORA_PATH = "/tmp/voice-lora/lora_weights.ckpt";
    const progressPhases: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.cloneMode).toBe("hifi");
      expect(body.loraPath).toBe("/tmp/voice-lora/lora_weights.ckpt");
      expect(body.stabilitySeed).toBe(1337);
      expect(body.textPrepFile).toMatch(/text-prep\.json$/);
      await writeFile(
        body.metadataOutput,
        JSON.stringify({
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 28,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          effectiveParams: {
            timesteps: 40,
            cfgValue: 3,
            denoise: true,
            qualityPreset: "quality",
            cloneMode: "hifi",
            stabilitySeed: 1337,
          },
          hotWorker: { reusedHotModel: true },
        }),
        "utf-8",
      );
      await writeFile(body.output, Buffer.from([1, 2, 3]), null);
      return new Response(
        [
          JSON.stringify({ type: "progress", phase: "model_ready", reusedHotModel: true }),
          JSON.stringify({ type: "progress", phase: "synthesis_started" }),
          JSON.stringify({ type: "completed", payload: { ok: true } }),
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLocalCloneWithProgress(
      "jobHot",
      makeInput({ quality: "quality" }),
      (payload) => progressPhases.push(payload.phase),
    );

    expect(result.status).toBe("ready");
    expect(result.referenceQuality.grade).toBe("A");
    expect(result.effectiveParams.qualityPreset).toBe("quality");
    expect(result.effectiveParams.stabilitySeed).toBe(1337);
    expect(progressPhases).toContain("model_ready");
    expect(progressPhases).toContain("synthesis_started");
    // Hot worker handles synthesis: no per-request Python is spawned. (A best-effort
    // ffmpeg compression transcode may spawn, which is fine.)
    const synthesisSpawns = spawnMock.mock.calls.filter(
      ([cmd, args]) =>
        String(cmd).includes("python") ||
        (Array.isArray(args) && args.some((a) => String(a).includes("synthesize_voxcpm"))),
    );
    expect(synthesisSpawns).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/clone",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces hot worker error events during segment synthesis", async () => {
    process.env.ANYVOICE_HOT_WORKER_URL = "http://127.0.0.1:8765";
    const referenceAudioPath = path.join(tmpRoot, "segment-ref.wav");
    await writeFile(referenceAudioPath, Buffer.from([1, 2, 3, 4]), null);
    const fetchMock = vi.fn(async () =>
      new Response(`${JSON.stringify({ type: "error", message: "segment crashed" })}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesizeSegment({
        targetText: "hello segment",
        referenceAudioPath,
        promptTranscript: "hello prompt",
        workDir: path.join(tmpRoot, "segment-work"),
        outputM4aPath: path.join(tmpRoot, "segment.m4a"),
        quality: "balanced",
      }),
    ).rejects.toThrow(/segment crashed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

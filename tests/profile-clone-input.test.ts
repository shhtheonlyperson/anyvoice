// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloneInputError } from "@/lib/clone-request";
import { parseCloneFormWithProfile, wantsVoiceProfile } from "@/lib/profile-clone-input";
import {
  canonicalVoiceProfileSha256,
  loadVoiceProfileManifest,
  persistVoiceProfileManifest,
  voiceProfileManifestPath,
  type VoiceProfileSummary,
} from "@/lib/voice-profile";

let tmpRoot: string;
let profileRoot: string;
let transcriptValidationRoot: string;
const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalProfileRoot = process.env.ANYVOICE_VOICE_PROFILE_ROOT;
const originalTranscriptValidationRoot = process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT;
const backendBaselineAudio = Buffer.from("baseline wav\n");
const backendCandidateAudio = Buffer.from("candidate wav\n");
const loraRenderAudio = Buffer.from("lora render wav\n");
const profileTranscriptFixtures = [
  "請用繁體中文錄製穩定聲音。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

function resolvePolicyFixturePath(rawPath: unknown, baseDir: string): string | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  return path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(baseDir, rawPath));
}

async function writePolicyFixtureFile(rawPath: unknown, baseDir: string, contents: string | Buffer): Promise<{ path: string; sha256: string; bytes: number } | null> {
  const filePath = resolvePolicyFixturePath(rawPath, baseDir);
  if (!filePath) return null;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, typeof contents === "string" ? "utf-8" : null);
  const bytes = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
  return {
    path: filePath,
    bytes,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function readableLoraAdapterProofJson(trainConfig: string, trainConfigSha256: string): string {
  return `${JSON.stringify({
    status: "pass",
    trainConfig,
    trainConfigSha256,
    checkpoint: {
      status: "readable",
      loraParameterKeyCount: 2,
      loraParameterKeys: ["encoder.lora_A.weight", "encoder.lora_B.weight"],
    },
  })}\n`;
}

function acceptedLoraQualityGateJson(
  policy: NonNullable<VoiceProfileSummary["loraAdapter"]>,
  baseDir: string,
  proof?: {
    transcriptValidation: { path: string; sha256: string };
    report: { path: string; sha256: string };
    asr: { path: string; sha256: string };
    speaker: { path: string; sha256: string };
    score: { path: string; sha256: string };
  },
): string {
  const profileJson = resolvePolicyFixturePath(policy.profileJson, baseDir) ?? policy.profileJson;
  const loraPath = resolvePolicyFixturePath(policy.path, baseDir) ?? policy.path;
  return `${JSON.stringify({
    status: "pass",
    dryRun: false,
    inputs: {
      profileJson,
      profileSha256: policy.profileSha256,
      cloneMode: "hifi",
      requireSpeakerBackend: "speechbrain-ecapa",
      skipProfileVerify: false,
      skipTranscriptValidation: false,
      loraPath,
      transcriptValidationJson: proof?.transcriptValidation.path,
      transcriptValidationSha256: proof?.transcriptValidation.sha256,
    },
    paths: proof ? {
      report: proof.report.path,
      asr: proof.asr.path,
      speaker: proof.speaker.path,
      score: proof.score.path,
      profileTranscriptValidation: proof.transcriptValidation.path,
    } : undefined,
    proofs: {
      artifacts: proof ? {
        report: { path: proof.report.path, sha256: proof.report.sha256 },
        asr: { path: proof.asr.path, sha256: proof.asr.sha256 },
        speaker: { path: proof.speaker.path, sha256: proof.speaker.sha256 },
        score: { path: proof.score.path, sha256: proof.score.sha256 },
      } : undefined,
      transcriptValidationJson: proof?.transcriptValidation.path,
      transcriptValidationSha256: proof?.transcriptValidation.sha256,
      profileVerifyRequired: true,
      profileVerifySkipped: false,
      profileVerifyPassed: true,
      transcriptValidationRequired: true,
      transcriptValidationSkipped: false,
      transcriptValidationPassed: true,
      speakerBackendRequirement: {
        selected: "speechbrain-ecapa",
        required: "speechbrain-ecapa",
      },
      loraAdapter: {
        exists: true,
        path: loraPath,
        bytes: policy.bytes,
        sha256: policy.sha256,
      },
    },
  })}\n`;
}

function loraQualityGateProofSummary(proof: {
  transcriptValidation: { path: string; sha256: string };
  report: { path: string; sha256: string };
  asr: { path: string; sha256: string };
  speaker: { path: string; sha256: string };
  score: { path: string; sha256: string };
}): Record<string, unknown> {
  return {
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
    transcriptValidationJson: proof.transcriptValidation.path,
    transcriptValidationSha256: proof.transcriptValidation.sha256,
    artifacts: {
      report: { path: proof.report.path, sha256: proof.report.sha256 },
      asr: { path: proof.asr.path, sha256: proof.asr.sha256 },
      speaker: { path: proof.speaker.path, sha256: proof.speaker.sha256 },
      score: { path: proof.score.path, sha256: proof.score.sha256 },
    },
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

function acceptedBackendSelectionJson(policy: NonNullable<VoiceProfileSummary["preferredBackend"]>): string {
  return `${JSON.stringify({
    verdict: "accept",
    accepted: true,
    baselineCloneMode: policy.baselineBackend,
    candidateCloneMode: policy.backend,
    voiceProfile: {
      voiceProfileId: policy.voiceProfileId,
      profileSha256: policy.profileSha256,
    },
    scoreJson: policy.scoreJson,
    scoreSha256: policy.scoreSha256,
    reviewJson: policy.reviewJson,
    reviewSha256: policy.reviewSha256,
    sourceReport: policy.sourceReport,
    sourceReportSha256: policy.sourceReportSha256,
    subjectiveReview: acceptedBackendSubjectiveReview(),
  })}\n`;
}

function acceptedBackendScoreJson(
  policy: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  outputs?: {
    baseline: { path: string; sha256: string; bytes: number };
    candidate: { path: string; sha256: string; bytes: number };
  },
): string {
  const profileDir = path.dirname(path.dirname(String(policy.sourceReport || policy.scoreJson || ".")));
  const baseline = outputs?.baseline ?? {
    path: path.join(profileDir, "renders", "voxcpm2.wav"),
    bytes: backendBaselineAudio.byteLength,
    sha256: createHash("sha256").update(backendBaselineAudio).digest("hex"),
  };
  const candidate = outputs?.candidate ?? {
    path: path.join(profileDir, "renders", "indextts2.wav"),
    bytes: backendCandidateAudio.byteLength,
    sha256: createHash("sha256").update(backendCandidateAudio).digest("hex"),
  };
  return `${JSON.stringify({
    verdict: "pass",
    sourceReport: policy.sourceReport,
    sourceReportSha256: policy.sourceReportSha256,
    voiceProfile: {
      voiceProfileId: policy.voiceProfileId,
      profileSha256: policy.profileSha256,
    },
    groups: [
      {
        cloneMode: policy.baselineBackend,
        voiceProfileId: policy.voiceProfileId,
        profileSha256: policy.profileSha256,
        renders: [
          {
            status: "ready",
            voiceProfileId: policy.voiceProfileId,
            profileSha256: policy.profileSha256,
            outputExists: true,
            missingOutput: false,
            outputWav: baseline.path,
            outputBytes: baseline.bytes,
            outputSha256: baseline.sha256,
          },
        ],
      },
      {
        cloneMode: policy.backend,
        voiceProfileId: policy.voiceProfileId,
        profileSha256: policy.profileSha256,
        renders: [
          {
            status: "ready",
            voiceProfileId: policy.voiceProfileId,
            profileSha256: policy.profileSha256,
            outputExists: true,
            missingOutput: false,
            outputWav: candidate.path,
            outputBytes: candidate.bytes,
            outputSha256: candidate.sha256,
          },
        ],
      },
    ],
  })}\n`;
}

function acceptedBackendReviewJson(policy: NonNullable<VoiceProfileSummary["preferredBackend"]>): string {
  return `${JSON.stringify({
    version: 1,
    status: "pass",
    reportPath: policy.sourceReport,
    reportSha256: policy.sourceReportSha256,
    stats: {
      rounds: 5,
      reviewedRounds: 5,
      candidateWins: 4,
      baselineWins: 1,
      ties: 0,
      rerenders: 0,
      candidateWinRate: 0.8,
      minCandidateWinRate: 0.8,
      reportSha256: policy.sourceReportSha256,
    },
    choices: {
      "winner-smoke-r01": "A",
    },
  })}\n`;
}

function acceptedBackendSourceReportJson(
  policy: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  output: { path: string; sha256: string; bytes: number },
): string {
  return `${JSON.stringify({
    version: 1,
    voiceProfile: {
      voiceProfileId: policy.voiceProfileId,
      profileSha256: policy.profileSha256,
    },
    groups: [
      {
        cloneMode: policy.backend,
        voiceProfileId: policy.voiceProfileId,
        profileSha256: policy.profileSha256,
        renders: [
          {
            status: "ready",
            externalBackend: true,
            outputExists: true,
            missingOutput: false,
            outputWav: output.path,
            outputBytes: output.bytes,
            outputSha256: output.sha256,
            voiceProfileId: policy.voiceProfileId,
            profileSha256: policy.profileSha256,
          },
        ],
      },
    ],
  })}\n`;
}

async function writeRun(
  id: string,
  {
    transcript = profileTranscriptFixtures[Number(id.replace(/\D/g, "")) - 1] ?? `你好，這是我的穩定聲音 ${id}。`,
    grade = "A",
    durationSec = 8,
    sourceKind = "scripted",
  }: {
    transcript?: string;
    grade?: string;
    durationSec?: number;
    sourceKind?: string;
  } = {},
) {
  const runDir = path.join(tmpRoot, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(runDir, "prompt-transcript.raw.txt"), transcript, "utf-8");
  await writeFile(path.join(runDir, "target.raw.txt"), "target", "utf-8");
  await writeFile(
    path.join(runDir, "request.json"),
    JSON.stringify({ sourceKind, referenceSource: { kind: sourceKind } }),
    "utf-8",
  );
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify({
      model_id: "openbmb/VoxCPM2",
      clone_mode: "hifi",
      referenceQuality: {
        grade,
        durationSec,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.82,
        warnings: [],
      },
    }),
    "utf-8",
  );
}

async function writeStrictReadyProfile({ validationStatus = "pass" }: { validationStatus?: "pass" | "blocked" } = {}): Promise<VoiceProfileSummary> {
  const profile = await persistVoiceProfileManifest({ profileId: "local-default" });
  await mkdir(transcriptValidationRoot, { recursive: true });
  const profilePath = voiceProfileManifestPath("local-default");
  await writeFile(
    path.join(transcriptValidationRoot, "local-default.json"),
    `${JSON.stringify(
      {
        createdAt: "2026-05-19T00:00:00.000Z",
        profile: profilePath,
        profileSha256: canonicalVoiceProfileSha256(profile),
        status: validationStatus,
        summary: {
          total: profile.clips.length,
          passed: validationStatus === "pass" ? profile.clips.length : profile.clips.length - 1,
          failed: validationStatus === "pass" ? 0 : 1,
        },
        clips: profile.clips.map((clip, index) => ({
          sourceRunId: clip.sourceRunId,
          expectedTranscript: clip.transcriptRaw,
          audioPath: clip.audioPath,
          verdict: validationStatus === "blocked" && index === 0 ? "fail" : "pass",
          cer: { rate: validationStatus === "blocked" && index === 0 ? 0.25 : 0 },
          wer: { rate: validationStatus === "blocked" && index === 0 ? 0.25 : 0 },
        })),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return profile;
}

async function applyPreferredBackendToPersistedProfile(
  overrides: Record<string, unknown> = {},
) {
  const profilePath = voiceProfileManifestPath("local-default");
  const profileDir = path.dirname(profilePath);
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  profile.preferredBackend = {
    version: 1,
    status: "accepted",
    profileJson: profilePath,
    voiceProfileId: "local-default",
    profileSha256: canonicalVoiceProfileSha256(profile),
    backend: "indextts2",
    baselineBackend: "voxcpm2-hifi",
    selectionJson: path.join(profileDir, "proofs", "selection.json"),
    selectionSha256: "",
    scoreJson: path.join(profileDir, "proofs", "score.json"),
    scoreSha256: "",
    reviewJson: path.join(profileDir, "proofs", "review.json"),
    reviewSha256: "",
    sourceReport: path.join(profileDir, "proofs", "source-report.json"),
    sourceReportSha256: "",
    ...overrides,
  };
  const baselineOutput = await writePolicyFixtureFile(path.join(profileDir, "renders", "voxcpm2.wav"), profileDir, backendBaselineAudio);
  const output = await writePolicyFixtureFile(path.join(profileDir, "renders", "indextts2.wav"), profileDir, backendCandidateAudio);
  const report = await writePolicyFixtureFile(
    profile.preferredBackend.sourceReport,
    profileDir,
    acceptedBackendSourceReportJson(profile.preferredBackend, output ?? { path: "", sha256: "", bytes: 0 }),
  );
  if (!Object.hasOwn(overrides, "sourceReportSha256")) profile.preferredBackend.sourceReportSha256 = report?.sha256 ?? profile.preferredBackend.sourceReportSha256;
  const review = await writePolicyFixtureFile(
    profile.preferredBackend.reviewJson,
    profileDir,
    acceptedBackendReviewJson(profile.preferredBackend),
  );
  if (!Object.hasOwn(overrides, "reviewSha256")) profile.preferredBackend.reviewSha256 = review?.sha256 ?? profile.preferredBackend.reviewSha256;
  const score = await writePolicyFixtureFile(
    profile.preferredBackend.scoreJson,
    profileDir,
    acceptedBackendScoreJson(
      profile.preferredBackend,
      baselineOutput && output ? { baseline: baselineOutput, candidate: output } : undefined,
    ),
  );
  if (!Object.hasOwn(overrides, "scoreSha256")) profile.preferredBackend.scoreSha256 = score?.sha256 ?? profile.preferredBackend.scoreSha256;
  const selection = await writePolicyFixtureFile(
    profile.preferredBackend.selectionJson,
    profileDir,
    acceptedBackendSelectionJson(profile.preferredBackend),
  );
  if (!Object.hasOwn(overrides, "selectionSha256")) profile.preferredBackend.selectionSha256 = selection?.sha256 ?? profile.preferredBackend.selectionSha256;
  if (!Object.hasOwn(overrides, "subjectiveReview")) {
    profile.preferredBackend.subjectiveReview = acceptedBackendSubjectiveReview();
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

async function applyLoraAdapterToPersistedProfile(
  overrides: Record<string, unknown> = {},
) {
  const profilePath = voiceProfileManifestPath("local-default");
  const profileDir = path.dirname(profilePath);
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  profile.loraPath = path.join(profileDir, "adapters", "lora_weights.ckpt");
  profile.loraAdapter = {
    version: 1,
    status: "accepted",
    profileJson: profilePath,
    voiceProfileId: "local-default",
    profileSha256: canonicalVoiceProfileSha256(profile),
    path: profile.loraPath,
    bytes: 0,
    sha256: "",
    adapterProofJson: path.join(profileDir, "proofs", "adapter-proof.json"),
    adapterProofSha256: "",
    qualityGateJson: path.join(profileDir, "proofs", "lora-quality-gate.json"),
    qualityGateSha256: "",
    trainConfig: path.join(profileDir, "training", "train_config.json"),
    trainConfigSha256: "",
    ...overrides,
  };
  const adapter = await writePolicyFixtureFile(profile.loraAdapter.path, profileDir, Buffer.from([1, 2, 3, 4]));
  const trainConfig = await writePolicyFixtureFile(profile.loraAdapter.trainConfig, profileDir, '{"trainer":{"status":"ready"}}\n');
  if (!Object.hasOwn(overrides, "bytes")) profile.loraAdapter.bytes = adapter?.bytes ?? profile.loraAdapter.bytes;
  if (!Object.hasOwn(overrides, "sha256")) profile.loraAdapter.sha256 = adapter?.sha256 ?? profile.loraAdapter.sha256;
  if (!Object.hasOwn(overrides, "trainConfigSha256")) profile.loraAdapter.trainConfigSha256 = trainConfig?.sha256 ?? profile.loraAdapter.trainConfigSha256;
  const adapterProof = await writePolicyFixtureFile(
    profile.loraAdapter.adapterProofJson,
    profileDir,
    readableLoraAdapterProofJson(profile.loraAdapter.trainConfig, profile.loraAdapter.trainConfigSha256),
  );
  if (!Object.hasOwn(overrides, "adapterProofSha256")) profile.loraAdapter.adapterProofSha256 = adapterProof?.sha256 ?? profile.loraAdapter.adapterProofSha256;
  const loraOutput = await writePolicyFixtureFile(path.join(profileDir, "renders", "lora-hifi.wav"), profileDir, loraRenderAudio);
  const transcriptValidation = await writePolicyFixtureFile(
    path.join(profileDir, "proofs", "profile-transcript-validation.json"),
    profileDir,
    `${JSON.stringify({
      status: "pass",
      profile: profilePath,
      voiceProfileId: profile.loraAdapter.voiceProfileId,
      profileSha256: profile.loraAdapter.profileSha256,
    })}\n`,
  );
  const asr = await writePolicyFixtureFile(path.join(profileDir, "proofs", "lora-asr.json"), profileDir, '{"status":"pass"}\n');
  const speaker = await writePolicyFixtureFile(path.join(profileDir, "proofs", "lora-speaker.json"), profileDir, '{"status":"pass"}\n');
  const report = await writePolicyFixtureFile(
    path.join(profileDir, "proofs", "lora-source-report.json"),
    profileDir,
    `${JSON.stringify({
      voiceProfile: {
        voiceProfileId: profile.loraAdapter.voiceProfileId,
        profileSha256: profile.loraAdapter.profileSha256,
      },
      groups: [
        {
          cloneMode: "hifi",
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: loraOutput?.path,
              outputBytes: loraOutput?.bytes,
              outputSha256: loraOutput?.sha256,
              metadataJson: {
                effectiveParams: {
                  loraEnabled: true,
                  loraPath: resolvePolicyFixturePath(profile.loraAdapter.path, profileDir),
                },
              },
            },
          ],
        },
      ],
    })}\n`,
  );
  const score = await writePolicyFixtureFile(
    path.join(profileDir, "proofs", "lora-score.json"),
    profileDir,
    `${JSON.stringify({
      verdict: "pass",
      sourceReport: report?.path,
      sourceReportSha256: report?.sha256,
      asrJson: asr?.path,
      asrJsonSha256: asr?.sha256,
      speakerJson: speaker?.path,
      speakerJsonSha256: speaker?.sha256,
      groups: [
        {
          cloneMode: "hifi",
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: loraOutput?.path,
              outputBytes: loraOutput?.bytes,
              outputSha256: loraOutput?.sha256,
            },
          ],
        },
      ],
    })}\n`,
  );
  const qualityGate = await writePolicyFixtureFile(
    profile.loraAdapter.qualityGateJson,
    profileDir,
    acceptedLoraQualityGateJson(profile.loraAdapter, profileDir, {
      transcriptValidation: transcriptValidation ?? { path: "", sha256: "" },
      report: report ?? { path: "", sha256: "" },
      asr: asr ?? { path: "", sha256: "" },
      speaker: speaker ?? { path: "", sha256: "" },
      score: score ?? { path: "", sha256: "" },
    }),
  );
  if (!Object.hasOwn(overrides, "qualityGateSha256")) profile.loraAdapter.qualityGateSha256 = qualityGate?.sha256 ?? profile.loraAdapter.qualityGateSha256;
  if (!Object.hasOwn(overrides, "qualityGateProof")) {
    profile.loraAdapter.qualityGateProof = loraQualityGateProofSummary({
      transcriptValidation: transcriptValidation ?? { path: "", sha256: "" },
      report: report ?? { path: "", sha256: "" },
      asr: asr ?? { path: "", sha256: "" },
      speaker: speaker ?? { path: "", sha256: "" },
      score: score ?? { path: "", sha256: "" },
    });
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

function profileForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("useVoiceProfile", "yes");
  form.set("targetText", "請用我的聲音說這句話。");
  form.set("quality", "balanced");
  form.set("consent", "yes");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-input-"));
  profileRoot = path.join(tmpRoot, "voices");
  transcriptValidationRoot = path.join(tmpRoot, "transcript-validation");
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
  process.env.ANYVOICE_VOICE_PROFILE_ROOT = profileRoot;
  process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = transcriptValidationRoot;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  if (originalRunsDir === undefined) delete process.env.ANYVOICE_RUNS_DIR;
  else process.env.ANYVOICE_RUNS_DIR = originalRunsDir;
  if (originalProfileRoot === undefined) delete process.env.ANYVOICE_VOICE_PROFILE_ROOT;
  else process.env.ANYVOICE_VOICE_PROFILE_ROOT = originalProfileRoot;
  if (originalTranscriptValidationRoot === undefined) delete process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT;
  else process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = originalTranscriptValidationRoot;
});

describe("parseCloneFormWithProfile", () => {
  it("detects profile requests from the form", () => {
    expect(wantsVoiceProfile(profileForm())).toBe(true);
    const form = new FormData();
    form.set("referenceMode", "profile");
    expect(wantsVoiceProfile(form)).toBe(true);
  });

  it("resolves a ready profile to a concrete reference file and transcript", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.sourceKind).toBe("profile");
    expect(input.voice.name).toMatch(/^voice-profile-run-/);
    expect(input.voice.type).toBe("audio/wav");
    expect(input.promptTranscript).toContain("繁體中文");
    expect(input.profileReference?.voiceProfileId).toBe("local-default");
    expect(input.profileReference?.referenceClipIds).toHaveLength(5);
  });

  it("carries an applied preferred backend from the strict persisted profile into clone input", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toMatchObject({
      status: "accepted",
      backend: "indextts2",
    });
    expect(input.profileReference?.preferredBackend?.selectionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.profileReference?.preferredBackend?.reviewSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.profileReference?.preferredBackend?.sourceReportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.profileReference?.referenceQuality?.grade).toBe("A");
  });

  it("carries an applied preferred backend with portable subjective review summary paths", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const score = JSON.parse(await readFile(profile.preferredBackend.scoreJson, "utf-8"));
    score.sourceReport = path.relative(path.dirname(profile.preferredBackend.scoreJson), profile.preferredBackend.sourceReport);
    const scoreJson = `${JSON.stringify(score, null, 2)}\n`;
    await writeFile(profile.preferredBackend.scoreJson, scoreJson, "utf-8");
    profile.preferredBackend.scoreSha256 = createHash("sha256").update(scoreJson).digest("hex");
    const review = JSON.parse(await readFile(profile.preferredBackend.reviewJson, "utf-8"));
    review.reportPath = path.relative(path.dirname(profile.preferredBackend.reviewJson), profile.preferredBackend.sourceReport);
    const reviewJson = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(profile.preferredBackend.reviewJson, reviewJson, "utf-8");
    profile.preferredBackend.reviewSha256 = createHash("sha256").update(reviewJson).digest("hex");
    const selection = JSON.parse(await readFile(profile.preferredBackend.selectionJson, "utf-8"));
    selection.scoreJson = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.scoreJson);
    selection.scoreSha256 = profile.preferredBackend.scoreSha256;
    selection.reviewJson = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.reviewJson);
    selection.reviewSha256 = profile.preferredBackend.reviewSha256;
    selection.sourceReport = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.sourceReport);
    selection.subjectiveReview = {
      ...selection.subjectiveReview,
      reviewJson: profile.preferredBackend.reviewJson,
      report: profile.preferredBackend.sourceReport,
    };
    const selectionJson = `${JSON.stringify(selection, null, 2)}\n`;
    await writeFile(profile.preferredBackend.selectionJson, selectionJson, "utf-8");
    profile.preferredBackend.selectionSha256 = createHash("sha256").update(selectionJson).digest("hex");
    profile.preferredBackend.subjectiveReview = {
      ...(profile.preferredBackend.subjectiveReview as Record<string, unknown>),
      reviewJson: path.relative(profileDir, profile.preferredBackend.reviewJson),
      report: path.relative(profileDir, profile.preferredBackend.sourceReport),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toMatchObject({
      status: "accepted",
      backend: "indextts2",
    });
  });

  it("does not carry a preferred backend whose persisted subjective review summary is stale", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    profile.preferredBackend.subjectiveReview = {
      ...(profile.preferredBackend.subjectiveReview as Record<string, unknown>),
      status: "fail",
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("normalizes relative persisted preferred backend paths before clone input", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({
      profileJson: "profile.json",
      selectionJson: "proofs/selection.json",
      scoreJson: "proofs/score.json",
      reviewJson: "proofs/review.json",
      sourceReport: "proofs/source-report.json",
    });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    const profilePath = await realpath(voiceProfileManifestPath("local-default"));
    const profileDir = path.dirname(profilePath);
    expect(input.profileReference?.preferredBackend).toMatchObject({
      status: "accepted",
      profileJson: profilePath,
      selectionJson: path.join(profileDir, "proofs", "selection.json"),
      scoreJson: path.join(profileDir, "proofs", "score.json"),
      reviewJson: path.join(profileDir, "proofs", "review.json"),
      sourceReport: path.join(profileDir, "proofs", "source-report.json"),
    });
  });

  it("does not carry a stale preferred backend whose profile hash no longer matches", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ profileSha256: "0".repeat(64) });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry an incomplete preferred backend without subjective review report proof", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ sourceReport: null, sourceReportSha256: null });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose accepted selection proof does not bind its artifacts", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const selection = await writePolicyFixtureFile(profile.preferredBackend.selectionJson, profileDir, '{"verdict":"accept","accepted":true}\n');
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose accepted selection proof lacks passing subjective review", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const selectionPayload = JSON.parse(acceptedBackendSelectionJson(profile.preferredBackend));
    selectionPayload.subjectiveReview.status = "fail";
    selectionPayload.subjectiveReview.reasons = ["subjective_review_candidate_win_rate_below_threshold"];
    selectionPayload.subjectiveReview.stats.candidateWinRate = 0.6;
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      `${JSON.stringify(selectionPayload)}\n`,
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose review export lacks pass status", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const reviewPayload = JSON.parse(await readFile(profile.preferredBackend.reviewJson, "utf-8"));
    delete reviewPayload.status;
    const reviewJson = `${JSON.stringify(reviewPayload)}\n`;
    await writeFile(profile.preferredBackend.reviewJson, reviewJson, "utf-8");
    profile.preferredBackend.reviewSha256 = createHash("sha256").update(reviewJson).digest("hex");
    const selectionPayload = JSON.parse(await readFile(profile.preferredBackend.selectionJson, "utf-8"));
    selectionPayload.reviewSha256 = profile.preferredBackend.reviewSha256;
    const selectionJson = `${JSON.stringify(selectionPayload)}\n`;
    await writeFile(profile.preferredBackend.selectionJson, selectionJson, "utf-8");
    profile.preferredBackend.selectionSha256 = createHash("sha256").update(selectionJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose score proof does not bind its source report", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const score = await writePolicyFixtureFile(
      profile.preferredBackend.scoreJson,
      profileDir,
      acceptedBackendScoreJson({ ...profile.preferredBackend, sourceReportSha256: "0".repeat(64) }),
    );
    profile.preferredBackend.scoreSha256 = score?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose score proof is bound to a stale profile", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const scorePayload = JSON.parse(acceptedBackendScoreJson(profile.preferredBackend));
    scorePayload.groups[1].renders[0].profileSha256 = "0".repeat(64);
    const score = await writePolicyFixtureFile(
      profile.preferredBackend.scoreJson,
      profileDir,
      `${JSON.stringify(scorePayload)}\n`,
    );
    profile.preferredBackend.scoreSha256 = score?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose score omits ready render output proof", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const scorePayload = JSON.parse(acceptedBackendScoreJson(profile.preferredBackend));
    delete scorePayload.groups[0].renders[0].outputExists;
    delete scorePayload.groups[0].renders[0].missingOutput;
    delete scorePayload.groups[0].renders[0].outputWav;
    delete scorePayload.groups[0].renders[0].outputBytes;
    delete scorePayload.groups[0].renders[0].outputSha256;
    const score = await writePolicyFixtureFile(
      profile.preferredBackend.scoreJson,
      profileDir,
      `${JSON.stringify(scorePayload)}\n`,
    );
    profile.preferredBackend.scoreSha256 = score?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose review proof does not bind its source report", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const review = await writePolicyFixtureFile(
      profile.preferredBackend.reviewJson,
      profileDir,
      acceptedBackendReviewJson({ ...profile.preferredBackend, sourceReportSha256: "0".repeat(64) }),
    );
    profile.preferredBackend.reviewSha256 = review?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose source report lacks current external render evidence", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const weakReport = `${JSON.stringify({
      groups: [
        {
          cloneMode: "indextts2",
          renders: [{ status: "ready", outputWav: "renders/missing.wav" }],
        },
      ],
    })}\n`;
    await writeFile(profile.preferredBackend.sourceReport, weakReport, "utf-8");
    profile.preferredBackend.sourceReportSha256 = createHash("sha256").update(weakReport).digest("hex");
    const score = await writePolicyFixtureFile(
      profile.preferredBackend.scoreJson,
      path.dirname(profilePath),
      acceptedBackendScoreJson(profile.preferredBackend),
    );
    profile.preferredBackend.scoreSha256 = score?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      path.dirname(profilePath),
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred backend whose source report is bound to a stale profile", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profileDir = path.dirname(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.preferredBackend) throw new Error("expected preferred backend fixture");
    const output = await writePolicyFixtureFile(path.join(profileDir, "renders", "indextts2.wav"), profileDir, Buffer.from("candidate wav\n"));
    const reportPayload = JSON.parse(
      acceptedBackendSourceReportJson(profile.preferredBackend, output ?? { path: "", sha256: "", bytes: 0 }),
    );
    reportPayload.voiceProfile.profileSha256 = "0".repeat(64);
    reportPayload.groups[0].profileSha256 = "0".repeat(64);
    reportPayload.groups[0].renders[0].profileSha256 = "0".repeat(64);
    const report = await writePolicyFixtureFile(
      profile.preferredBackend.sourceReport,
      profileDir,
      `${JSON.stringify(reportPayload)}\n`,
    );
    profile.preferredBackend.sourceReportSha256 = report?.sha256 ?? "";
    const review = await writePolicyFixtureFile(
      profile.preferredBackend.reviewJson,
      profileDir,
      acceptedBackendReviewJson(profile.preferredBackend),
    );
    profile.preferredBackend.reviewSha256 = review?.sha256 ?? "";
    const score = await writePolicyFixtureFile(
      profile.preferredBackend.scoreJson,
      profileDir,
      acceptedBackendScoreJson(profile.preferredBackend),
    );
    profile.preferredBackend.scoreSha256 = score?.sha256 ?? "";
    const selection = await writePolicyFixtureFile(
      profile.preferredBackend.selectionJson,
      profileDir,
      acceptedBackendSelectionJson(profile.preferredBackend),
    );
    profile.preferredBackend.selectionSha256 = selection?.sha256 ?? "";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry an incomplete preferred backend without baseline backend proof", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ baselineBackend: "" });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a preferred external backend measured against a non-hifi baseline", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ baselineBackend: "prompt" });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry a native backend through preferredBackend policy", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ backend: "voxcpm2-hifi" });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("does not carry an unsupported backend through preferredBackend policy", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile({ backend: "made-up-backend" });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("carries an applied LoRA adapter from the strict persisted profile into clone input", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    const profilePath = await realpath(voiceProfileManifestPath("local-default"));
    const expectedLoraPath = await realpath(path.join(path.dirname(profilePath), "adapters", "lora_weights.ckpt"));
    expect(await realpath(input.profileReference?.loraPath ?? "")).toBe(expectedLoraPath);
    expect(input.profileReference?.loraAdapter).toMatchObject({
      status: "accepted",
    });
    expect(await realpath(input.profileReference?.loraAdapter?.path ?? "")).toBe(expectedLoraPath);
    expect(input.profileReference?.loraAdapter?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.profileReference?.loraAdapter?.trainConfigSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("carries an applied LoRA adapter with profile-relative quality gate proof summary paths", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter?.qualityGateProof) throw new Error("expected LoRA proof summary");
    const profileDir = path.dirname(await realpath(profilePath));
    const proof = profile.loraAdapter.qualityGateProof as {
      transcriptValidationJson: string;
      artifacts: Record<string, { path: string; sha256: string }>;
    };
    proof.transcriptValidationJson = path.relative(profileDir, await realpath(proof.transcriptValidationJson));
    for (const key of ["report", "asr", "speaker", "score"]) {
      proof.artifacts[key].path = path.relative(profileDir, await realpath(proof.artifacts[key].path));
    }
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.profileReference?.loraAdapter).toMatchObject({
      status: "accepted",
      qualityGateProof: expect.objectContaining({
        transcriptValidationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
  });

  it("does not carry a LoRA adapter whose persisted quality gate proof summary is stale", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    profile.loraAdapter.qualityGateProof = {
      ...(profile.loraAdapter.qualityGateProof as Record<string, unknown>),
      transcriptValidationPassed: false,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("normalizes relative persisted LoRA adapter paths before clone input", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile({
      profileJson: "profile.json",
      path: "adapters/lora_weights.ckpt",
      adapterProofJson: "proofs/adapter-proof.json",
      qualityGateJson: "proofs/lora-quality-gate.json",
      trainConfig: "training/train_config.json",
    });
    const profilePath = voiceProfileManifestPath("local-default");
    const persisted = JSON.parse(await readFile(profilePath, "utf-8"));
    persisted.loraPath = "./adapters/lora_weights.ckpt";
    await writeFile(profilePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    const resolvedProfilePath = await realpath(profilePath);
    const profileDir = path.dirname(resolvedProfilePath);
    expect(input.profileReference?.loraPath).toBe(path.join(profileDir, "adapters", "lora_weights.ckpt"));
    expect(input.profileReference?.loraAdapter).toMatchObject({
      status: "accepted",
      profileJson: resolvedProfilePath,
      path: path.join(profileDir, "adapters", "lora_weights.ckpt"),
      adapterProofJson: path.join(profileDir, "proofs", "adapter-proof.json"),
      qualityGateJson: path.join(profileDir, "proofs", "lora-quality-gate.json"),
      trainConfig: path.join(profileDir, "training", "train_config.json"),
    });
  });

  it("does not carry an incomplete LoRA adapter without train config proof", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile({ trainConfig: null, trainConfigSha256: null });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose proof lacks readable checkpoint evidence", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapterProofJson = profile.loraAdapter?.adapterProofJson;
    if (!adapterProofJson) throw new Error("expected adapter proof fixture");
    const weakProof = '{"status":"pass"}\n';
    await writeFile(adapterProofJson, weakProof, "utf-8");
    profile.loraAdapter!.adapterProofSha256 = createHash("sha256").update(weakProof).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose proof is not bound to the applied train config", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const weakProof = readableLoraAdapterProofJson(profile.loraAdapter.trainConfig, "0".repeat(64));
    await writeFile(profile.loraAdapter.adapterProofJson, weakProof, "utf-8");
    profile.loraAdapter.adapterProofSha256 = createHash("sha256").update(weakProof).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose quality gate is not bound to the applied adapter", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const weakGate = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, path.dirname(profilePath)));
    weakGate.proofs.loraAdapter.sha256 = "0".repeat(64);
    const weakGateJson = `${JSON.stringify(weakGate)}\n`;
    await writeFile(profile.loraAdapter.qualityGateJson, weakGateJson, "utf-8");
    profile.loraAdapter.qualityGateSha256 = createHash("sha256").update(weakGateJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose quality gate skipped transcript validation", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const weakGate = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, path.dirname(profilePath)));
    weakGate.inputs.skipTranscriptValidation = true;
    weakGate.proofs.transcriptValidationPassed = false;
    const weakGateJson = `${JSON.stringify(weakGate)}\n`;
    await writeFile(profile.loraAdapter.qualityGateJson, weakGateJson, "utf-8");
    profile.loraAdapter.qualityGateSha256 = createHash("sha256").update(weakGateJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose quality gate proof says transcript validation was skipped", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const weakGate = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, path.dirname(profilePath)));
    weakGate.proofs.transcriptValidationSkipped = true;
    const weakGateJson = `${JSON.stringify(weakGate)}\n`;
    await writeFile(profile.loraAdapter.qualityGateJson, weakGateJson, "utf-8");
    profile.loraAdapter.qualityGateSha256 = createHash("sha256").update(weakGateJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose quality gate proof says profile verification was skipped", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const weakGate = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, path.dirname(profilePath)));
    weakGate.proofs.profileVerifySkipped = true;
    const weakGateJson = `${JSON.stringify(weakGate)}\n`;
    await writeFile(profile.loraAdapter.qualityGateJson, weakGateJson, "utf-8");
    profile.loraAdapter.qualityGateSha256 = createHash("sha256").update(weakGateJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a LoRA adapter whose quality gate report does not prove the adapter was loaded", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile();
    const profilePath = voiceProfileManifestPath("local-default");
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    if (!profile.loraAdapter) throw new Error("expected LoRA adapter fixture");
    const gate = JSON.parse(await readFile(profile.loraAdapter.qualityGateJson, "utf-8"));
    const reportPath = gate.paths.report;
    const scorePath = gate.paths.score;
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    report.groups[0].renders[0].metadataJson.effectiveParams.loraEnabled = false;
    const reportJson = `${JSON.stringify(report)}\n`;
    await writeFile(reportPath, reportJson, "utf-8");
    const reportSha256 = createHash("sha256").update(reportJson).digest("hex");
    const score = JSON.parse(await readFile(scorePath, "utf-8"));
    score.sourceReportSha256 = reportSha256;
    const scoreJson = `${JSON.stringify(score)}\n`;
    await writeFile(scorePath, scoreJson, "utf-8");
    const scoreSha256 = createHash("sha256").update(scoreJson).digest("hex");
    gate.proofs.artifacts.report.sha256 = reportSha256;
    gate.proofs.artifacts.score.sha256 = scoreSha256;
    const gateJson = `${JSON.stringify(gate)}\n`;
    await writeFile(profile.loraAdapter.qualityGateJson, gateJson, "utf-8");
    profile.loraAdapter.qualityGateSha256 = createHash("sha256").update(gateJson).digest("hex");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("does not carry a stale LoRA adapter whose profile hash no longer matches", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyLoraAdapterToPersistedProfile({ profileSha256: "0".repeat(64) });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
  });

  it("drops advanced profile policies from a non-studio-grade manifest", async () => {
    await writeRun("only-one");
    await persistVoiceProfileManifest({ profileId: "local-default" });
    await applyPreferredBackendToPersistedProfile();
    await applyLoraAdapterToPersistedProfile();

    const loaded = await loadVoiceProfileManifest(voiceProfileManifestPath("local-default"));
    expect(loaded.studioGrade).toBe(false);
    expect(loaded.preferredBackend).toBeUndefined();
    expect(loaded.loraPath).toBeNull();
    expect(loaded.loraAdapter).toBeUndefined();
  });

  it("selects a profile reference that matches risky target pronunciation coverage", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();

    const input = await parseCloneFormWithProfile(
      profileForm({ targetText: "請用我的聲音說 AnyVoice、Brenda 和重慶。" }),
    );
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");

    expect(input.profileReference?.sourceRunId).toBe("run-3");
    expect(input.promptTranscript).toContain("AnyVoice");
    expect(input.promptTranscript).toContain("重慶");
    expect(input.profileReference?.targetCoverageFeatures).toEqual(
      expect.arrayContaining(["latin_terms", "polyphones"]),
    );
    expect(input.profileReference?.matchedCoverageFeatures).toEqual(
      expect.arrayContaining(["latin_terms", "polyphones"]),
    );
    expect(input.profileReference?.targetPronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "brand:anyvoice",
    ]);
    expect(input.profileReference?.matchedPronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "brand:anyvoice",
    ]);
  });

  it("preserves pronunciation overrides when resolving profile input", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, { durationSec: 8 + index });
    }
    await writeStrictReadyProfile();

    const input = await parseCloneFormWithProfile(
      profileForm({ pronunciationOverrides: "重慶=重 慶\nAnyVoice=Any Voice\npinyin:行長=xing2 zhang3" }),
    );
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
    expect(input.pronunciationOverrides).toEqual([
      {
        term: "重慶",
        replacement: "重 慶",
        kind: "polyphone",
        source: "preset",
        presetId: "polyphone:chongqing",
      },
      {
        term: "AnyVoice",
        replacement: "Any Voice",
        kind: "brand",
        source: "preset",
        presetId: "brand:anyvoice",
      },
      {
        term: "行長",
        replacement: "xing2 zhang3",
        kind: "pinyin",
        source: "custom",
      },
    ]);
  });

  it("rejects Simplified or mixed Chinese target text for profile generation", async () => {
    const input = await parseCloneFormWithProfile(profileForm({ targetText: "银行。" }));
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(400);
    expect(input.body.message).toMatch(/Simplified or mixed/);
  });

  it("rejects common Simplified-only target phrasing before profile lookup", async () => {
    const input = await parseCloneFormWithProfile(profileForm({ targetText: "我想说话。" }));
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(400);
    expect(input.body.message).toMatch(/Simplified or mixed/);
  });

  it("accepts short shared-form Chinese target text (zh_unknown) for profile generation", async () => {
    await writeRun("only-one");
    const input = await parseCloneFormWithProfile(profileForm({ targetText: "我愛你", allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
  });

  it("resolves a draft profile only when explicitly allowed without a transcript-validation report", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await rm(path.join(transcriptValidationRoot, "local-default.json"), { force: true });

    const input = await parseCloneFormWithProfile(profileForm({ allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
  });

  it("rejects default profile generation when transcript validation proof is missing", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await rm(path.join(transcriptValidationRoot, "local-default.json"), { force: true });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/strict-ready/);
  });

  it("still resolves draft generation even if transcript validation previously failed", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile({ validationStatus: "blocked" });

    const input = await parseCloneFormWithProfile(profileForm({ allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
  });

  it("does not carry evidence-bound LoRA or backend policies through explicit draft generation", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile();
    await applyPreferredBackendToPersistedProfile();
    await applyLoraAdapterToPersistedProfile();

    const input = await parseCloneFormWithProfile(profileForm({ allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
    expect(input.profileReference?.loraPath).toBeNull();
    expect(input.profileReference?.loraAdapter).toBeUndefined();
    expect(input.profileReference?.preferredBackend).toBeUndefined();
  });

  it("unlocks explicit draft generation from a single usable clip (quick-clone)", async () => {
    await writeRun("only-one");
    const input = await parseCloneFormWithProfile(profileForm({ allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(false);
    if (isCloneInputError(input)) throw new Error("expected clone input");
    expect(input.sourceKind).toBe("profile");
  });

  it("rejects default profile generation from a single non-strict clip", async () => {
    await writeRun("only-one");
    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/strict-ready/);
  });

  it("rejects profile use when no usable clip exists", async () => {
    await writeRun("too-short", { durationSec: 2, grade: "A" });
    const input = await parseCloneFormWithProfile(profileForm({ allowDraftVoiceProfile: "yes" }));
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/not usable/);
  });
});

// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "prepare_voice_lora_dataset.py");

let tmpRoot: string;
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function canonicalProfileSha256(profilePath: string): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as Record<string, unknown>;
  delete profile.createdAt;
  delete profile.loraPath;
  delete profile.loraAdapter;
  delete profile.preferredBackend;
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeProfile({
  ready = true,
  clips = 10,
  strict = true,
}: {
  ready?: boolean;
  clips?: number;
  strict?: boolean;
} = {}): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const rows = [];
  for (let index = 1; index <= clips; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index}.wav`);
    await writeFile(audioPath, Buffer.from([index, index + 1, index + 2]));
    rows.push({
      sourceRunId: `clip-${index}`,
      audioPath,
      transcriptRaw: strict
        ? `這是第 ${index} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日，保持穩定節奏。`
        : `你好，這是第 ${index} 段合格聲音。`,
      transcriptScript: "zh_hant",
      ...(strict ? { sourceKind: "scripted", coverageFeatures: coverage } : {}),
      targetText: "target",
      quality: {
        grade: index === clips ? "B" : "A",
        durationSec: 7 + index,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      modelId: "openbmb/VoxCPM2",
      cloneMode: "hifi",
    });
  }
  const profile = {
    version: 1,
    voiceProfileId: "local-test",
    status: ready ? "ready" : "needs_enrollment",
    requirements: {
      minClips: 5,
      maxClips: 10,
      minDurationSec: 6,
      maxDurationSec: 20,
      passingGrades: ["A", "B"],
      requiredCoverageFeatures: coverage,
    },
    summary: {
      eligibleClips: rows.length,
      selectedClips: rows.length,
      rejectedClips: 0,
      remainingClipsNeeded: Math.max(0, 10 - rows.length),
    },
    preferredPromptClipId: rows[0]?.sourceRunId ?? null,
    referenceClipIds: rows.map((clip) => clip.sourceRunId),
    loraPath: null,
    clips: rows,
    rejectedClips: [],
  };
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  return profilePath;
}

async function writeTranscriptValidation(
  profilePath: string,
  {
    profileSha256,
    status = "pass",
    validationPath = path.join(tmpRoot, "transcript-validation.json"),
  }: { profileSha256?: string; status?: string; validationPath?: string } = {},
): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const passed = status === "pass" ? profile.clips.length : Math.max(0, profile.clips.length - 1);
  await writeFile(
    validationPath,
    `${JSON.stringify({
      version: 1,
      profile: profilePath,
      profileSha256: profileSha256 ?? (await canonicalProfileSha256(profilePath)),
      status,
      summary: { total: profile.clips.length, passed, failed: profile.clips.length - passed },
      clips: profile.clips.map((clip, index) => ({
        sourceRunId: clip.sourceRunId,
        expectedTranscript: clip.transcriptRaw,
        audioPath: clip.audioPath,
        verdict: index < passed ? "pass" : "fail",
        cer: { rate: index < passed ? 0 : 0.5 },
        wer: { rate: index < passed ? 0 : 0.5 },
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
  return validationPath;
}

async function writeQualityGate(
  profilePath: string,
  {
    status = "pass",
    dryRun = false,
    cloneMode = "hifi",
    skipProfileVerify = false,
    skipTranscriptValidation = false,
    profileVerifyPassed = true,
    transcriptValidationPassed = true,
  }: {
    status?: string;
    dryRun?: boolean;
    cloneMode?: "hifi" | "both";
    skipProfileVerify?: boolean;
    skipTranscriptValidation?: boolean;
    profileVerifyPassed?: boolean;
    transcriptValidationPassed?: boolean;
  } = {},
): Promise<string> {
  const gateDir = path.join(tmpRoot, "quality-gate");
  await mkdir(gateDir, { recursive: true });
  const qualityGatePath = path.join(gateDir, "quality-gate.json");
  const reportPath = path.join(gateDir, "report.json");
  const asrPath = path.join(gateDir, "asr.json");
  const speakerPath = path.join(gateDir, "speaker.json");
  const scorePath = path.join(gateDir, "score.json");
  const transcriptValidationJson = path.join(tmpRoot, "transcript-validation.json");
  const sampleAudio = Buffer.from("quality gate sample wav\n");
  const sampleHifiAudio = Buffer.from("quality gate hifi sample wav\n");
  const sampleWav = path.join(gateDir, "sample.wav");
  const sampleHifiWav = path.join(gateDir, "sample-hifi.wav");
  await writeFile(sampleWav, sampleAudio);
  await writeFile(sampleHifiWav, sampleHifiAudio);
  const sampleProof = {
    outputExists: true,
    missingOutput: false,
    outputBytes: sampleAudio.byteLength,
    outputSha256: createHash("sha256").update(sampleAudio).digest("hex"),
  };
  const sampleHifiProof = {
    outputExists: true,
    missingOutput: false,
    outputBytes: sampleHifiAudio.byteLength,
    outputSha256: createHash("sha256").update(sampleHifiAudio).digest("hex"),
  };
  const transcriptValidationSha256 = await fileSha256(transcriptValidationJson);
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as { voiceProfileId?: string };
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const profileEvidence = { voiceProfileId: profile.voiceProfileId, profileSha256 };
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        version: 1,
        voiceProfile: profileEvidence,
          groups: [
            {
              ...profileEvidence,
              cloneMode: cloneMode === "both" ? "prompt" : "hifi",
            case: { id: "zh_hant_polyphones", text: "重慶角色" },
            renders: [{ ...profileEvidence, repeat: 1, status: "ready", outputWav: "sample.wav", ...sampleProof }],
          },
          ...(cloneMode === "both"
            ? [
                {
                  ...profileEvidence,
                  cloneMode: "hifi",
                  case: { id: "zh_hant_polyphones", text: "重慶角色" },
                  renders: [{ ...profileEvidence, repeat: 1, status: "ready", outputWav: "sample-hifi.wav", ...sampleHifiProof }],
                },
              ]
              : []),
          ],
        },
        null,
        2,
    )}\n`,
    "utf-8",
  );
  await writeFile(asrPath, `${JSON.stringify({ "hifi/zh_hant_polyphones/r01": "重慶角色" }, null, 2)}\n`, "utf-8");
  await writeFile(
    speakerPath,
    `${JSON.stringify({ version: 1, backend: "speechbrain-ecapa", summary: { total: 1, scored: 1, failed: 0 } }, null, 2)}\n`,
    "utf-8",
  );
  const reportSha256 = await fileSha256(reportPath);
  const asrSha256 = await fileSha256(asrPath);
  const speakerSha256 = await fileSha256(speakerPath);
  await writeFile(
    scorePath,
    `${JSON.stringify(
      {
        version: 1,
        verdict: "pass",
        sourceReport: reportPath,
        sourceReportSha256: reportSha256,
        asrJson: asrPath,
        asrJsonSha256: asrSha256,
        speakerJson: speakerPath,
        speakerJsonSha256: speakerSha256,
        voiceProfile: profileEvidence,
        groups: [
          {
            ...profileEvidence,
            cloneMode: cloneMode === "both" ? "prompt" : "hifi",
            renders: [
              {
                ...profileEvidence,
                repeat: 1,
                status: "ready",
                outputWav: sampleWav,
                ...sampleProof,
              },
            ],
          },
          ...(cloneMode === "both"
            ? [
                {
                  ...profileEvidence,
                  cloneMode: "hifi",
                  renders: [
                    {
                      ...profileEvidence,
                      repeat: 1,
                      status: "ready",
                      outputWav: sampleHifiWav,
                      ...sampleHifiProof,
                    },
                  ],
                },
              ]
            : []),
        ],
        ...(cloneMode === "both"
          ? {
              pairedComparison: {
                verdict: "pass",
                baselineCloneMode: "prompt",
                candidateCloneMode: "hifi",
                summary: { pairs: 1, passingPairs: 1, reviewPairs: 0 },
              },
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const scoreSha256 = await fileSha256(scorePath);
  await writeFile(
    qualityGatePath,
    `${JSON.stringify({
      version: 1,
      status,
      dryRun,
      inputs: {
        profileJson: profilePath,
        profileSha256,
        cloneMode,
        repeats: 3,
        requireSpeakerBackend: cloneMode === "both" ? "speechbrain-ecapa" : null,
        transcriptValidationJson,
        transcriptValidationSha256,
        skipProfileVerify,
        skipTranscriptValidation,
      },
      proofs: {
        profileVerifyRequired: !skipProfileVerify,
        profileVerifySkipped: skipProfileVerify,
        profileVerifyPassed,
        transcriptValidationRequired: !skipTranscriptValidation,
        transcriptValidationSkipped: skipTranscriptValidation,
        transcriptValidationJson,
        transcriptValidationSha256,
        transcriptValidationPassed,
        speakerBackendRequirement:
          cloneMode === "both"
            ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
            : { requested: "auto", selected: "mfcc-cosine", required: null },
        artifacts: {
          report: { path: reportPath, sha256: reportSha256 },
          asr: { path: asrPath, sha256: asrSha256 },
          speaker: { path: speakerPath, sha256: speakerSha256 },
          score: { path: scorePath, sha256: scoreSha256 },
        },
      },
      commands: {
        score:
          cloneMode === "both"
            ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
            : "python3 scripts/score_voice_regression.py",
      },
      paths: {
        qualityGate: qualityGatePath,
        report: reportPath,
        asr: asrPath,
        speaker: speakerPath,
        score: scorePath,
        profileTranscriptValidation: transcriptValidationJson,
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  return qualityGatePath;
}

async function pointQualityGateAtTranscriptValidation(qualityGatePath: string, transcriptValidationPath: string): Promise<void> {
  const transcriptValidationSha256 = await fileSha256(transcriptValidationPath);
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  gate.inputs.transcriptValidationJson = transcriptValidationPath;
  gate.inputs.transcriptValidationSha256 = transcriptValidationSha256;
  gate.proofs.transcriptValidationJson = transcriptValidationPath;
  gate.proofs.transcriptValidationSha256 = transcriptValidationSha256;
  gate.paths.profileTranscriptValidation = transcriptValidationPath;
  await writeFile(qualityGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function tamperQualityGateAsrArtifact(qualityGatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  await writeFile(gate.paths.asr, `${JSON.stringify({ stale: "changed after score" }, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleAsrHash(qualityGatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.asrJsonSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(qualityGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function makeQualityGatePortable(qualityGatePath: string, profilePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  const scoreDir = path.dirname(gate.paths.score);
  score.sourceReport = path.relative(scoreDir, gate.paths.report);
  score.asrJson = path.relative(scoreDir, gate.paths.asr);
  score.speakerJson = path.relative(scoreDir, gate.paths.speaker);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.inputs.profileJson = path.relative(path.dirname(qualityGatePath), profilePath);
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(qualityGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleProfileEvidence(qualityGatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.voiceProfile.profileSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(qualityGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeQualityGateScorePairedComparison(qualityGatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(qualityGatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  delete score.pairedComparison;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(qualityGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-lora-dataset-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("prepare_voice_lora_dataset.py", () => {
  it("writes train/val/all manifests from a ready profile", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const outDir = path.join(tmpRoot, "dataset");
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--quality-gate-json",
      qualityGate,
      "--out-dir",
      outDir,
      "--copy-audio",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("written");
    expect(payload.trainClips).toBe(8);
    expect(payload.valClips).toBe(2);
    expect(payload.totalClips).toBe(10);

    const trainLines = (await readFile(path.join(outDir, "manifest.train.jsonl"), "utf-8")).trim().split("\n");
    const valLines = (await readFile(path.join(outDir, "manifest.val.jsonl"), "utf-8")).trim().split("\n");
    expect(trainLines).toHaveLength(8);
    expect(valLines).toHaveLength(2);
    const first = JSON.parse(trainLines[0]);
    expect(first).toMatchObject({
      speaker: "local-test",
      split: "train",
      sourceRunId: "clip-1",
      text: "這是第 1 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日，保持穩定節奏。",
      consentSource: "anyvoice_profile_enrollment",
    });
    expect(first.audio).toContain(`${path.sep}audio${path.sep}train-001-clip-1.wav`);
    await expect(stat(first.audio)).resolves.toMatchObject({ size: 3 });

    const metadata = JSON.parse(await readFile(path.join(outDir, "dataset.json"), "utf-8"));
    expect(metadata.proofs).toMatchObject({
      transcriptValidationJson: await realpath(transcriptValidation),
      transcriptValidationSha256: await fileSha256(transcriptValidation),
      qualityGateJson: await realpath(qualityGate),
      qualityGateSha256: await fileSha256(qualityGate),
      strictProfileProof: {
        status: "strict_ready",
      },
    });
  });

  it("accepts portable product-proof quality gates with score-relative artifact paths", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath, { cloneMode: "both" });
    await makeQualityGatePortable(qualityGate, profilePath);
    const outDir = path.join(tmpRoot, "portable-product-proof-dataset");

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--quality-gate-json",
      qualityGate,
      "--require-product-proof-quality-gate",
      "--out-dir",
      outDir,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("written");
    expect(payload.totalClips).toBe(10);

    const metadata = JSON.parse(await readFile(path.join(outDir, "dataset.json"), "utf-8"));
    expect(metadata.proofs).toMatchObject({
      qualityGateJson: await realpath(qualityGate),
      productProofQualityGateRequired: true,
    });
  });

  it("refuses the old five-clip profile by default for LoRA export", async () => {
    const profilePath = await writeProfile({ clips: 5 });
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const outDir = path.join(tmpRoot, "five-clip-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("5 more qualified reference clips needed"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before writing when the profile is not ready", async () => {
    const profilePath = await writeProfile({ ready: false, clips: 2 });
    const outDir = path.join(tmpRoot, "blocked-dataset");
    await expect(
      execFileAsync(python, [script, "--profile-json", profilePath, "--out-dir", outDir]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("voice profile is not ready for LoRA dataset export"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires transcript validation and quality gate proofs before writing", async () => {
    const profilePath = await writeProfile();
    const outDir = path.join(tmpRoot, "blocked-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON not found"),
    });

    const transcriptValidation = await writeTranscriptValidation(profilePath);
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON is required"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ready-looking profiles that fail strict profile verification", async () => {
    const profilePath = await writeProfile({ strict: false });
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const outDir = path.join(tmpRoot, "weak-profile-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA dataset export requires strict ready profile proof"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects planned or dry-run quality gates", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath, { status: "planned", dryRun: true });
    const outDir = path.join(tmpRoot, "planned-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON must be a non-dry-run pass"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates captured before the current profile manifest", async () => {
    const profilePath = await writeProfile();
    await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as Record<string, unknown>;
    profile.auditMarker = "profile changed after quality gate";
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
    const currentTranscriptValidation = await writeTranscriptValidation(profilePath);
    const outDir = path.join(tmpRoot, "stale-gate-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        currentTranscriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON is stale for this profile"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates that skipped profile or transcript proof", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath, {
      skipTranscriptValidation: true,
      transcriptValidationPassed: true,
    });
    const outDir = path.join(tmpRoot, "skipped-proof-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON did not prove transcript validation passed"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose transcript proof says it was skipped", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const gate = JSON.parse(await readFile(qualityGate, "utf-8"));
    gate.proofs.transcriptValidationSkipped = true;
    await writeFile(qualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    const outDir = path.join(tmpRoot, "contradictory-skipped-proof-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON did not prove transcript validation passed"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose profile proof says it was skipped", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const gate = JSON.parse(await readFile(qualityGate, "utf-8"));
    gate.proofs.profileVerifySkipped = true;
    await writeFile(qualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    const outDir = path.join(tmpRoot, "contradictory-skipped-profile-proof-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON did not prove profile verification passed"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates that omit transcript validation proof JSON", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const gate = JSON.parse(await readFile(qualityGate, "utf-8"));
    delete gate.inputs.transcriptValidationJson;
    delete gate.proofs.transcriptValidationJson;
    delete gate.paths.profileTranscriptValidation;
    await writeFile(qualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    const outDir = path.join(tmpRoot, "missing-gate-transcript-proof-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON is missing transcript validation proof path"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects transcript validation JSON with stale profile hash evidence", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath, { profileSha256: "0".repeat(64) });
    const qualityGate = await writeQualityGate(profilePath);
    const outDir = path.join(tmpRoot, "stale-transcript-validation-profile-hash-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON is stale for this profile"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose transcript validation proof rows are stale", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const staleValidation = path.join(tmpRoot, "quality-gate-stale-transcript-validation.json");
    const validation = JSON.parse(await readFile(transcriptValidation, "utf-8"));
    validation.clips[1].expectedTranscript = "這是一段已經過期的逐字稿。";
    await writeFile(staleValidation, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
    await pointQualityGateAtTranscriptValidation(qualityGate, staleValidation);
    const outDir = path.join(tmpRoot, "stale-gate-transcript-validation-rows-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate transcript validation proof rows do not match the profile"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose transcript validation proof file changed", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const validation = JSON.parse(await readFile(transcriptValidation, "utf-8"));
    validation.mutatedAfterQualityGate = true;
    await writeFile(transcriptValidation, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
    const outDir = path.join(tmpRoot, "mutated-gate-transcript-proof-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate transcript validation proof SHA-256 no longer matches the file"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose ASR artifact file changed", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    await tamperQualityGateAsrArtifact(qualityGate);
    const outDir = path.join(tmpRoot, "mutated-gate-asr-artifact-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON asr artifact SHA-256 no longer matches the file"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose score JSON consumed a stale ASR hash", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    await pointQualityGateScoreAtStaleAsrHash(qualityGate);
    const outDir = path.join(tmpRoot, "stale-score-asr-hash-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate score JSON asrJsonSha256 no longer matches paths.asr"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose score JSON carries stale profile evidence", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    await pointQualityGateScoreAtStaleProfileEvidence(qualityGate);
    const outDir = path.join(tmpRoot, "stale-score-profile-evidence-dataset");
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("score.voiceProfile.profileSha256"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a paired product-proof gate when requested", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const hifiGate = await writeQualityGate(profilePath);
    const outDir = path.join(tmpRoot, "product-proof-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        hifiGate,
        "--require-product-proof-quality-gate",
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON is not a paired product-proof gate"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });

    const productGate = await writeQualityGate(profilePath, { cloneMode: "both" });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--quality-gate-json",
      productGate,
      "--require-product-proof-quality-gate",
      "--out-dir",
      outDir,
      "--dry-run",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      proofs: {
        productProofQualityGateRequired: true,
      },
      dryRun: true,
    });
  });

  it("rejects product-proof gates whose score artifact lacks paired comparison proof", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const productGate = await writeQualityGate(profilePath, { cloneMode: "both" });
    await removeQualityGateScorePairedComparison(productGate);
    const outDir = path.join(tmpRoot, "missing-paired-score-product-proof-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        productGate,
        "--require-product-proof-quality-gate",
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate JSON is not a paired product-proof gate"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects quality gates whose score omits ready render output proof", async () => {
    const profilePath = await writeProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const qualityGate = await writeQualityGate(profilePath);
    const gate = JSON.parse(await readFile(qualityGate, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    const render = score.groups[0].renders[0];
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
    await writeFile(qualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
    const outDir = path.join(tmpRoot, "missing-score-render-output-proof-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--quality-gate-json",
        qualityGate,
        "--out-dir",
        outDir,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("quality gate score/report does not prove ready render output files"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows explicit proof bypasses for dry-run migration handoffs", async () => {
    const profilePath = await writeProfile();
    const outDir = path.join(tmpRoot, "dry-run-dataset");
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--out-dir",
      outDir,
      "--dry-run",
      "--skip-transcript-validation",
      "--skip-quality-gate",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      status: "ready",
      dryRun: true,
      proofs: {
        transcriptValidationJson: null,
        qualityGateJson: null,
      },
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write a dataset with proof bypasses unless unsafe export is acknowledged", async () => {
    const profilePath = await writeProfile();
    const outDir = path.join(tmpRoot, "unsafe-blocked-dataset");

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--out-dir",
        outDir,
        "--skip-transcript-validation",
        "--skip-quality-gate",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unsafe LoRA dataset proof bypass refused"),
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the unsafe bypass reason when a migration export is explicitly allowed", async () => {
    const profilePath = await writeProfile();
    const outDir = path.join(tmpRoot, "unsafe-allowed-dataset");
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--out-dir",
      outDir,
      "--skip-transcript-validation",
      "--skip-quality-gate",
      "--allow-unsafe-export",
      "--unsafe-bypass-reason",
      "migration fixture without ASR backend",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("written");
    const metadata = JSON.parse(await readFile(path.join(outDir, "dataset.json"), "utf-8"));
    expect(metadata.proofs.bypass).toMatchObject({
      transcriptValidationSkipped: true,
      qualityGateSkipped: true,
      unsafeExport: true,
      reason: "migration fixture without ASR backend",
    });
  });
});

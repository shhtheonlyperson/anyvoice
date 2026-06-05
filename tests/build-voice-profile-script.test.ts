// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceProfileSummary } from "@/lib/voice-profile";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "build_voice_profile.py");
const backendBaselineAudio = Buffer.from("baseline wav\n");
const backendCandidateAudio = Buffer.from("candidate wav\n");
const loraRenderAudio = Buffer.from("lora render wav\n");

let tmpRoot: string;

async function writeProofFile(filePath: string, contents: string | Buffer): Promise<{ path: string; sha256: string; bytes: number }> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, typeof contents === "string" ? "utf-8" : null);
  const bytes = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength;
  const sha256 = createHash("sha256").update(contents).digest("hex");
  return { path: filePath, sha256, bytes };
}

async function writeBackendRenderOutputs(outDir: string): Promise<{
  baseline: { path: string; sha256: string; bytes: number };
  candidate: { path: string; sha256: string; bytes: number };
}> {
  const baseline = await writeProofFile(path.join(outDir, "renders", "voxcpm2.wav"), backendBaselineAudio);
  const candidate = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), backendCandidateAudio);
  return { baseline, candidate };
}

async function writeLoraQualityGateFixture(
  policy: NonNullable<VoiceProfileSummary["loraAdapter"]>,
  outDir: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const output = await writeProofFile(path.join(outDir, "renders", "lora-hifi.wav"), loraRenderAudio);
  const transcriptValidation = await writeProofFile(
    path.join(outDir, "proofs", "profile-transcript-validation.json"),
    `${JSON.stringify({
      status: "pass",
      profile: resolvedPolicyFixturePath(policy.profileJson, outDir),
      voiceProfileId: policy.voiceProfileId,
      profileSha256: policy.profileSha256,
    })}\n`,
  );
  const asr = await writeProofFile(path.join(outDir, "proofs", "lora-asr.json"), '{"status":"pass"}\n');
  const speaker = await writeProofFile(path.join(outDir, "proofs", "lora-speaker.json"), '{"status":"pass"}\n');
  const report = await writeProofFile(
    path.join(outDir, "proofs", "lora-source-report.json"),
    `${JSON.stringify({
      voiceProfile: {
        voiceProfileId: policy.voiceProfileId,
        profileSha256: policy.profileSha256,
      },
      groups: [
        {
          cloneMode: "hifi",
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: output.path,
              outputBytes: output.bytes,
              outputSha256: output.sha256,
              metadataJson: {
                effectiveParams: {
                  loraEnabled: true,
                  loraPath: resolvedPolicyFixturePath(policy.path, outDir),
                },
              },
            },
          ],
        },
      ],
    })}\n`,
  );
  const score = await writeProofFile(
    path.join(outDir, "proofs", "lora-score.json"),
    `${JSON.stringify({
      verdict: "pass",
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
      asrJson: asr.path,
      asrJsonSha256: asr.sha256,
      speakerJson: speaker.path,
      speakerJsonSha256: speaker.sha256,
      groups: [
        {
          cloneMode: "hifi",
          renders: [
            {
              status: "ready",
              outputExists: true,
              missingOutput: false,
              outputWav: output.path,
              outputBytes: output.bytes,
              outputSha256: output.sha256,
            },
          ],
        },
      ],
    })}\n`,
  );
  policy.qualityGateProof = loraQualityGateProofSummary({
    transcriptValidation,
    report,
    asr,
    speaker,
    score,
  });
  return writeProofFile(
    resolvedPolicyFixturePath(policy.qualityGateJson, outDir),
    acceptedLoraQualityGateJson(policy, outDir, {
      transcriptValidation,
      report,
      asr,
      speaker,
      score,
    }),
  );
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

function resolvedPolicyFixturePath(rawPath: string, baseDir: string): string {
  return path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(baseDir, rawPath));
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
  const loraPath = resolvedPolicyFixturePath(policy.path, baseDir);
  return `${JSON.stringify({
    status: "pass",
    dryRun: false,
    inputs: {
      profileJson: resolvedPolicyFixturePath(policy.profileJson, baseDir),
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
  const profileDir = path.dirname(path.dirname(policy.sourceReport));
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

async function writeRun(id: string, transcript: string, durationSec = 8): Promise<void> {
  const runDir = path.join(tmpRoot, "runs", id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(runDir, "prompt-transcript.raw.txt"), transcript, "utf-8");
  await writeFile(path.join(runDir, "metadata.json"), JSON.stringify({
    referenceQuality: {
      grade: "A",
      durationSec,
      snrDb: 24,
      clippingRatio: 0,
      vadActiveRatio: 0.8,
      warnings: [],
    },
  }), "utf-8");
}

async function writeReadyRuns(): Promise<void> {
  await writeRun("plain-12", "你好，我正在錄製聲音樣本。春天的陽光灑在湖面上，世界顯得安靜。", 12);
  await writeRun("plain-11", "請確認錄音環境安靜，沒有回音，也不要離麥克風太近。", 11);
  await writeRun("date-9", "今天是二零二六年五月十九日，我會清楚讀完。", 9);
  await writeRun("english-8", "我會把 Brenda 與 AnyVoice 的名稱讀清楚。", 8);
  await writeRun("polyphone-7", "重慶、銀行、角色、音樂和長樂，這些詞都要讀準。", 7);
}

async function buildProfileSha256(profilePath: string): Promise<string> {
  const code = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, 'scripts')",
    "from build_voice_profile import canonical_profile_sha256",
    "print(canonical_profile_sha256(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))))",
  ].join("; ");
  const { stdout } = await execFileAsync(python, ["-c", code, profilePath], { cwd: process.cwd() });
  return stdout.trim();
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-build-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("build_voice_profile.py", () => {
  it("does not let mixed Chinese transcripts satisfy zh-Hant coverage", async () => {
    await writeRun("mixed-1", "这个聲音樣本很穩定。春天的陽光灑在湖面上，世界顯得安靜。");
    await writeRun("mixed-2", "今天是二零二六年五月十九日，我会用自然速度，把每一句話清楚讀完。");
    await writeRun("mixed-3", "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準，这个名字要清楚。");
    await writeRun("mixed-4", "我会保持停頓、節奏，讓聲音自然、乾淨。");
    await writeRun("mixed-5", "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，这个聲音要自然。");

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("needs_enrollment");
    expect(summary.eligibleClips).toBe(0);
    expect(summary.selectedClips).toBe(0);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toContain("zh_hant");
    expect(profile.diagnostics.coverageFeatures).toEqual([]);
    expect(profile.diagnostics.eligibleTranscriptScripts).toEqual([]);
    expect(profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "invalid_chinese_script", count: 5 })]),
    );
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "mixed-1",
          transcriptScript: "mixed_zh",
          reasons: ["invalid_chinese_script"],
        }),
      ]),
    );
  });

  it("does not count generic measure words as numbers/date coverage", async () => {
    await writeRun("measure-word", "你好，我正在錄製一段聲音樣本。");

    const outDir = path.join(tmpRoot, "profile");
    await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.clips[0].coverageFeatures).toEqual(["punctuation_rhythm", "zh_hant"]);
    expect(profile.clips[0].sourceKind).toBe("uploaded");
    expect(profile.diagnostics.missingCoverageFeatures).toContain("numbers_dates");
  });

  it("keeps the profile not ready when broad polyphone coverage lacks exact required pronunciation presets", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`subset-${index}`, `這是第 ${index} 段 AnyVoice、重慶、銀行，二零二六年五月十九日。`);
    }

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("needs_enrollment");

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.diagnostics.missingPronunciationPresetIds).toEqual([
      "polyphone:role",
      "polyphone:music",
      "polyphone:changle",
    ]);
  });

  it("rejects duplicate transcripts and keeps the best matching clip", async () => {
    await writeRun("same-a", "同一句聲音樣本。", 8);
    await writeRun("same-b", "同一句聲音樣本。", 10);
    await writeRun("unique-1", "第二句聲音樣本。", 8);
    await writeRun("unique-2", "今天是二零二六年五月十九日，我會清楚讀完。", 8);
    await writeRun("unique-3", "Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，都要讀準。", 8);
    await writeRun("unique-4", "我會保持停頓、節奏，讓聲音自然、乾淨。", 8);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("ready");
    expect(summary.eligibleClips).toBe(5);
    expect(summary.selectedClips).toBe(5);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.referenceClipIds).toContain("same-b");
    expect(profile.referenceClipIds).not.toContain("same-a");
    expect(profile.clips.find((clip: { sourceRunId: string }) => clip.sourceRunId === "unique-3")?.pronunciationPresetIds).toEqual([
      "polyphone:chongqing",
      "polyphone:bank",
      "polyphone:role",
      "polyphone:music",
      "polyphone:changle",
      "brand:anyvoice",
    ]);
    expect(profile.rejectedClips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: "same-a",
          reasons: ["duplicate_transcript"],
        }),
      ]),
    );
  });

  it("keeps lower-ranked eligible clips when they are needed for pronunciation coverage", async () => {
    await writeRun("plain-12", "你好，我正在錄製聲音樣本。春天的陽光灑在湖面上，世界顯得安靜。", 12);
    await writeRun("plain-11", "請確認錄音環境安靜，沒有回音，也不要離麥克風太近。", 11);
    await writeRun("rhythm-10", "這段錄音包含高低起伏、停頓和短句，讓聲音自然、乾淨。", 10);
    await writeRun("date-9", "今天是二零二六年五月十九日，我會清楚讀完。", 9);
    await writeRun("english-8", "我會把 Brenda 與 AnyVoice 的名稱讀清楚。", 8);
    await writeRun("polyphone-7", "重慶、銀行、角色、音樂和長樂，這些詞都要讀準。", 7);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
      "--max-clips",
      "5",
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.status).toBe("ready");
    expect(summary.selectedClips).toBe(5);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.referenceClipIds).toContain("polyphone-7");
    expect(profile.referenceClipIds).toContain("english-8");
    expect(profile.referenceClipIds).toContain("date-9");
    expect(profile.referenceClipIds).not.toContain("rhythm-10");
    expect(profile.diagnostics.missingCoverageFeatures).toEqual([]);
    expect(profile.diagnostics.coverageFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "polyphones" }),
        expect.objectContaining({ feature: "latin_terms" }),
        expect.objectContaining({ feature: "numbers_dates" }),
        expect.objectContaining({ feature: "punctuation_rhythm" }),
        expect.objectContaining({ feature: "zh_hant" }),
      ]),
    );
  });

  it("preserves a complete preferred backend policy across profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const reviewPayload = JSON.parse(acceptedBackendReviewJson(profile.preferredBackend));
    reviewPayload.reportPath = path.relative(path.dirname(profile.preferredBackend.reviewJson), profile.preferredBackend.sourceReport);
    const review = await writeProofFile(profile.preferredBackend.reviewJson, `${JSON.stringify(reviewPayload, null, 2)}\n`);
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const scorePayload = JSON.parse(acceptedBackendScoreJson(profile.preferredBackend));
    scorePayload.sourceReport = path.relative(path.dirname(profile.preferredBackend.scoreJson), profile.preferredBackend.sourceReport);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, `${JSON.stringify(scorePayload, null, 2)}\n`);
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selectionPayload = JSON.parse(acceptedBackendSelectionJson(profile.preferredBackend));
    selectionPayload.scoreJson = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.scoreJson);
    selectionPayload.reviewJson = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.reviewJson);
    selectionPayload.sourceReport = path.relative(path.dirname(profile.preferredBackend.selectionJson), profile.preferredBackend.sourceReport);
    selectionPayload.subjectiveReview = {
      ...selectionPayload.subjectiveReview,
      reviewJson: profile.preferredBackend.reviewJson,
      report: profile.preferredBackend.sourceReport,
    };
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, `${JSON.stringify(selectionPayload, null, 2)}\n`);
    profile.preferredBackend.selectionSha256 = selection.sha256;
    profile.preferredBackend.subjectiveReview = {
      ...acceptedBackendSubjectiveReview(),
      reviewJson: path.relative(outDir, profile.preferredBackend.reviewJson),
      report: path.relative(outDir, profile.preferredBackend.sourceReport),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toMatchObject({
      backend: "indextts2",
      selectionSha256: selection.sha256,
      reviewSha256: review.sha256,
      sourceReportSha256: report.sha256,
    });
  });

  it("drops preferred backend policies whose persisted subjective review summary is stale", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
      subjectiveReview: { ...acceptedBackendSubjectiveReview(), status: "fail" },
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("preserves a preferred backend policy whose profile path is relative to the manifest", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: "profile.json",
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: "proofs/selection.json",
      selectionSha256: "",
      scoreJson: "proofs/score.json",
      scoreSha256: "",
      reviewJson: "proofs/review.json",
      reviewSha256: "",
      sourceReport: "proofs/report.json",
      sourceReportSha256: "",
    };
    const report = await writeProofFile(path.join(outDir, "proofs", "report.json"), acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(path.join(outDir, "proofs", "review.json"), acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    const scoreOutputs = await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(path.join(outDir, "proofs", "score.json"), acceptedBackendScoreJson(profile.preferredBackend, scoreOutputs));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(path.join(outDir, "proofs", "selection.json"), acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toMatchObject({
      profileJson: "profile.json",
      backend: "indextts2",
      selectionJson: "proofs/selection.json",
      reviewJson: "proofs/review.json",
      sourceReport: "proofs/report.json",
    });
  });

  it("drops preferred backend policies whose proof files no longer match stored hashes", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const selection = await writeProofFile(path.join(outDir, "proofs", "selection.json"), '{"verdict":"accept"}\n');
    const score = await writeProofFile(path.join(outDir, "proofs", "score.json"), '{"verdict":"pass"}\n');
    const review = await writeProofFile(path.join(outDir, "proofs", "review.json"), '{"choices":{}}\n');
    const report = await writeProofFile(path.join(outDir, "proofs", "report.json"), '{"groups":[]}\n');
    await writeFile(report.path, '{"groups":["changed"]}\n', "utf-8");
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: selection.path,
      selectionSha256: selection.sha256,
      scoreJson: score.path,
      scoreSha256: score.sha256,
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose accepted selection proof does not bind the policy artifacts", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const selection = await writeProofFile(path.join(outDir, "proofs", "selection.json"), '{"verdict":"accept","accepted":true}\n');
    const score = await writeProofFile(path.join(outDir, "proofs", "score.json"), '{"verdict":"pass"}\n');
    const review = await writeProofFile(path.join(outDir, "proofs", "review.json"), '{"choices":{}}\n');
    const report = await writeProofFile(path.join(outDir, "proofs", "report.json"), '{"groups":[]}\n');
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: selection.path,
      selectionSha256: selection.sha256,
      scoreJson: score.path,
      scoreSha256: score.sha256,
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose accepted selection proof lacks passing subjective review", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selectionPayload = JSON.parse(acceptedBackendSelectionJson(profile.preferredBackend));
    selectionPayload.subjectiveReview.status = "fail";
    selectionPayload.subjectiveReview.reasons = ["subjective_review_candidate_win_rate_below_threshold"];
    selectionPayload.subjectiveReview.stats.candidateWinRate = 0.6;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, `${JSON.stringify(selectionPayload)}\n`);
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose review export lacks pass status", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const reviewPayload = JSON.parse(acceptedBackendReviewJson(profile.preferredBackend));
    delete reviewPayload.status;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, `${JSON.stringify(reviewPayload)}\n`);
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose score proof does not bind the policy source report", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const review = await writeProofFile(path.join(outDir, "proofs", "review.json"), '{"choices":{}}\n');
    const report = await writeProofFile(path.join(outDir, "proofs", "report.json"), '{"groups":[]}\n');
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
    };
    await writeBackendRenderOutputs(outDir);
    const staleScore = await writeProofFile(
      profile.preferredBackend.scoreJson,
      acceptedBackendScoreJson({ ...profile.preferredBackend, sourceReportSha256: "0".repeat(64) }),
    );
    profile.preferredBackend.scoreSha256 = staleScore.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose score proof is bound to a stale profile", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const scorePayload = JSON.parse(acceptedBackendScoreJson(profile.preferredBackend));
    scorePayload.groups[1].renders[0].profileSha256 = "0".repeat(64);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, `${JSON.stringify(scorePayload)}\n`);
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose score omits ready render output proof", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), backendCandidateAudio);
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const scorePayload = JSON.parse(acceptedBackendScoreJson(profile.preferredBackend));
    delete scorePayload.groups[0].renders[0].outputExists;
    delete scorePayload.groups[0].renders[0].missingOutput;
    delete scorePayload.groups[0].renders[0].outputWav;
    delete scorePayload.groups[0].renders[0].outputBytes;
    delete scorePayload.groups[0].renders[0].outputSha256;
    const score = await writeProofFile(profile.preferredBackend.scoreJson, `${JSON.stringify(scorePayload)}\n`);
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose review proof does not bind the policy source report", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const report = await writeProofFile(profile.preferredBackend.sourceReport, acceptedBackendSourceReportJson(profile.preferredBackend, output));
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(
      profile.preferredBackend.reviewJson,
      acceptedBackendReviewJson({ ...profile.preferredBackend, sourceReportSha256: "0".repeat(64) }),
    );
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose source report lacks current external render evidence", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const review = await writeProofFile(path.join(outDir, "proofs", "review.json"), '{"choices":{}}\n');
    const report = await writeProofFile(path.join(outDir, "proofs", "report.json"), JSON.stringify({
      groups: [
        {
          cloneMode: "indextts2",
          renders: [{ status: "ready", outputWav: "renders/missing.wav" }],
        },
      ],
    }));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: report.path,
      sourceReportSha256: report.sha256,
    };
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies whose source report is bound to a stale profile", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const output = await writeProofFile(path.join(outDir, "renders", "indextts2.wav"), Buffer.from("candidate wav\n"));
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: path.join(outDir, "proofs", "selection.json"),
      selectionSha256: "",
      scoreJson: path.join(outDir, "proofs", "score.json"),
      scoreSha256: "",
      reviewJson: path.join(outDir, "proofs", "review.json"),
      reviewSha256: "",
      sourceReport: path.join(outDir, "proofs", "report.json"),
      sourceReportSha256: "",
    };
    const reportPayload = JSON.parse(acceptedBackendSourceReportJson(profile.preferredBackend, output));
    reportPayload.voiceProfile.profileSha256 = "0".repeat(64);
    reportPayload.groups[0].profileSha256 = "0".repeat(64);
    reportPayload.groups[0].renders[0].profileSha256 = "0".repeat(64);
    const report = await writeProofFile(profile.preferredBackend.sourceReport, `${JSON.stringify(reportPayload)}\n`);
    profile.preferredBackend.sourceReportSha256 = report.sha256;
    const review = await writeProofFile(profile.preferredBackend.reviewJson, acceptedBackendReviewJson(profile.preferredBackend));
    profile.preferredBackend.reviewSha256 = review.sha256;
    await writeBackendRenderOutputs(outDir);
    const score = await writeProofFile(profile.preferredBackend.scoreJson, acceptedBackendScoreJson(profile.preferredBackend));
    profile.preferredBackend.scoreSha256 = score.sha256;
    const selection = await writeProofFile(profile.preferredBackend.selectionJson, acceptedBackendSelectionJson(profile.preferredBackend));
    profile.preferredBackend.selectionSha256 = selection.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops a metrics-only preferred backend policy during profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: "/tmp/selection.json",
      selectionSha256: "a".repeat(64),
      scoreJson: "/tmp/score.json",
      scoreSha256: "b".repeat(64),
      reviewJson: "/tmp/review.json",
      reviewSha256: "d".repeat(64),
      sourceReport: "",
      sourceReportSha256: "",
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops preferred backend policies measured against a non-hifi baseline during profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "indextts2",
      baselineBackend: "prompt",
      selectionJson: "/tmp/selection.json",
      selectionSha256: "a".repeat(64),
      scoreJson: "/tmp/score.json",
      scoreSha256: "b".repeat(64),
      reviewJson: "/tmp/review.json",
      reviewSha256: "d".repeat(64),
      sourceReport: "/tmp/report.json",
      sourceReportSha256: "e".repeat(64),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops native backend policies during profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "voxcpm2-hifi",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: "/tmp/selection.json",
      selectionSha256: "a".repeat(64),
      scoreJson: "/tmp/score.json",
      scoreSha256: "b".repeat(64),
      reviewJson: "/tmp/review.json",
      reviewSha256: "d".repeat(64),
      sourceReport: "/tmp/report.json",
      sourceReportSha256: "e".repeat(64),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("drops unsupported backend policies during profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      backend: "made-up-backend",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: "/tmp/selection.json",
      selectionSha256: "a".repeat(64),
      scoreJson: "/tmp/score.json",
      scoreSha256: "b".repeat(64),
      reviewJson: "/tmp/review.json",
      reviewSha256: "d".repeat(64),
      sourceReport: "/tmp/report.json",
      sourceReportSha256: "e".repeat(64),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.preferredBackend).toBeUndefined();
  });

  it("preserves a complete LoRA adapter policy across profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    const loraPath = adapter.path;
    profile.loraPath = loraPath;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: loraPath,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGate = await writeLoraQualityGateFixture(profile.loraAdapter, outDir);
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    const qualityGateProof = profile.loraAdapter.qualityGateProof as Record<string, unknown>;
    profile.loraAdapter.qualityGateProof = {
      ...qualityGateProof,
      transcriptValidationJson: path.relative(outDir, qualityGateProof.transcriptValidationJson as string),
      artifacts: Object.fromEntries(
        Object.entries((qualityGateProof.artifacts ?? {}) as Record<string, { path: string; sha256: string }>).map(([key, artifact]) => [
          key,
          { ...artifact, path: path.relative(outDir, artifact.path) },
        ]),
      ),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBe(loraPath);
    expect(rebuilt.loraAdapter).toMatchObject({
      path: loraPath,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofSha256: adapterProof.sha256,
      qualityGateSha256: qualityGate.sha256,
      trainConfigSha256: trainConfig.sha256,
    });
  });

  it("drops LoRA adapter policies whose persisted quality gate proof summary is stale", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGate = await writeLoraQualityGateFixture(profile.loraAdapter, outDir);
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    profile.loraAdapter.qualityGateProof = {
      ...(profile.loraAdapter.qualityGateProof as Record<string, unknown>),
      speakerBackend: "mfcc-cosine",
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("preserves a LoRA adapter policy whose profile path is relative to the manifest", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson("training/train_config.json", trainConfig.sha256),
    );
    const loraPath = "adapters/lora_weights.ckpt";
    profile.loraPath = loraPath;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: "profile.json",
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: loraPath,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: "proofs/adapter-proof.json",
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: "proofs/lora-quality-gate.json",
      qualityGateSha256: "",
      trainConfig: "training/train_config.json",
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGate = await writeLoraQualityGateFixture(profile.loraAdapter, outDir);
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBe(loraPath);
    expect(rebuilt.loraAdapter).toMatchObject({
      profileJson: "profile.json",
      path: loraPath,
      adapterProofJson: "proofs/adapter-proof.json",
      qualityGateJson: "proofs/lora-quality-gate.json",
      trainConfig: "training/train_config.json",
    });
  });

  it("drops LoRA adapter policies whose quality gate is not bound to the applied adapter", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGatePayload = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, outDir));
    qualityGatePayload.proofs.loraAdapter.sha256 = "0".repeat(64);
    const qualityGate = await writeProofFile(
      profile.loraAdapter.qualityGateJson,
      `${JSON.stringify(qualityGatePayload)}\n`,
    );
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose quality gate skipped transcript validation", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGatePayload = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, outDir));
    qualityGatePayload.inputs.skipTranscriptValidation = true;
    qualityGatePayload.proofs.transcriptValidationPassed = false;
    const qualityGate = await writeProofFile(
      profile.loraAdapter.qualityGateJson,
      `${JSON.stringify(qualityGatePayload)}\n`,
    );
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose quality gate proof says transcript validation was skipped", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGatePayload = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, outDir));
    qualityGatePayload.proofs.transcriptValidationSkipped = true;
    const qualityGate = await writeProofFile(
      profile.loraAdapter.qualityGateJson,
      `${JSON.stringify(qualityGatePayload)}\n`,
    );
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose quality gate proof says profile verification was skipped", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGatePayload = JSON.parse(acceptedLoraQualityGateJson(profile.loraAdapter, outDir));
    qualityGatePayload.proofs.profileVerifySkipped = true;
    const qualityGate = await writeProofFile(
      profile.loraAdapter.qualityGateJson,
      `${JSON.stringify(qualityGatePayload)}\n`,
    );
    profile.loraAdapter.qualityGateSha256 = qualityGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose quality gate report does not prove the adapter was loaded", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: path.join(outDir, "proofs", "lora-quality-gate.json"),
      qualityGateSha256: "",
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    const qualityGate = await writeLoraQualityGateFixture(profile.loraAdapter, outDir);
    const gate = JSON.parse(await readFile(qualityGate.path, "utf-8"));
    const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
    report.groups[0].renders[0].metadataJson.effectiveParams.loraEnabled = false;
    const reportFile = await writeProofFile(gate.paths.report, `${JSON.stringify(report)}\n`);
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.sourceReportSha256 = reportFile.sha256;
    const scoreFile = await writeProofFile(gate.paths.score, `${JSON.stringify(score)}\n`);
    gate.proofs.artifacts.report.sha256 = reportFile.sha256;
    gate.proofs.artifacts.score.sha256 = scoreFile.sha256;
    const rewrittenGate = await writeProofFile(qualityGate.path, `${JSON.stringify(gate)}\n`);
    profile.loraAdapter.qualityGateSha256 = rewrittenGate.sha256;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose proof lacks readable checkpoint evidence", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const adapterProof = await writeProofFile(path.join(outDir, "proofs", "adapter-proof.json"), '{"status":"pass"}\n');
    const qualityGate = await writeProofFile(path.join(outDir, "proofs", "lora-quality-gate.json"), '{"status":"pass"}\n');
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: qualityGate.path,
      qualityGateSha256: qualityGate.sha256,
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose proof is not bound to the applied train config", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const qualityGate = await writeProofFile(path.join(outDir, "proofs", "lora-quality-gate.json"), '{"status":"pass"}\n');
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, "0".repeat(64)),
    );
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: qualityGate.path,
      qualityGateSha256: qualityGate.sha256,
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops LoRA adapter policies whose adapter file no longer matches stored proof", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const adapter = await writeProofFile(path.join(outDir, "adapters", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
    const qualityGate = await writeProofFile(path.join(outDir, "proofs", "lora-quality-gate.json"), '{"status":"pass"}\n');
    const trainConfig = await writeProofFile(path.join(outDir, "training", "train_config.json"), '{"trainer":{"status":"ready"}}\n');
    const adapterProof = await writeProofFile(
      path.join(outDir, "proofs", "adapter-proof.json"),
      readableLoraAdapterProofJson(trainConfig.path, trainConfig.sha256),
    );
    await writeFile(adapter.path, Buffer.from([9, 9, 9, 9]), null);
    profile.loraPath = adapter.path;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: qualityGate.path,
      qualityGateSha256: qualityGate.sha256,
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops an incomplete LoRA adapter policy during profile rebuilds", async () => {
    await writeReadyRuns();

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    const loraPath = "/tmp/profile-lora/lora_weights.ckpt";
    profile.loraPath = loraPath;
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256: await buildProfileSha256(profilePath),
      path: loraPath,
      bytes: 123,
      sha256: "f".repeat(64),
      adapterProofJson: "",
      adapterProofSha256: "",
      qualityGateJson: "/tmp/lora-quality-gate.json",
      qualityGateSha256: "2".repeat(64),
      trainConfig: "/tmp/train_config.json",
      trainConfigSha256: "3".repeat(64),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("drops advanced runtime policies when a rebuilt profile is not ready", async () => {
    await writeRun("single-usable", "你好，我正在錄製聲音樣本。春天的陽光灑在湖面上，世界顯得安靜。", 12);

    const outDir = path.join(tmpRoot, "profile");
    const profilePath = path.join(outDir, "profile.json");
    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const profile = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(profile.status).toBe("needs_enrollment");
    const profileSha256 = await buildProfileSha256(profilePath);
    profile.preferredBackend = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256,
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
    };
    profile.loraPath = "/tmp/profile-lora/lora_weights.ckpt";
    profile.loraAdapter = {
      version: 1,
      status: "accepted",
      profileJson: profilePath,
      voiceProfileId: profile.voiceProfileId,
      profileSha256,
      path: profile.loraPath,
      bytes: 123,
      sha256: "f".repeat(64),
      adapterProofJson: "/tmp/adapter-proof.json",
      adapterProofSha256: "1".repeat(64),
      qualityGateJson: "/tmp/lora-quality-gate.json",
      qualityGateSha256: "2".repeat(64),
      trainConfig: "/tmp/train_config.json",
      trainConfigSha256: "3".repeat(64),
    };
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [script, "--runs-dir", path.join(tmpRoot, "runs"), "--out-dir", outDir]);

    const rebuilt = JSON.parse(await readFile(profilePath, "utf-8")) as VoiceProfileSummary;
    expect(rebuilt.status).toBe("needs_enrollment");
    expect(rebuilt.preferredBackend).toBeUndefined();
    expect(rebuilt.loraPath).toBeNull();
    expect(rebuilt.loraAdapter).toBeUndefined();
  });

  it("skips sample-source runs when building the user voice profile", async () => {
    await writeRun("sample-output", "示範聲音不能加入聲音檔案。", 8);
    await writeFile(
      path.join(tmpRoot, "runs", "sample-output", "request.json"),
      JSON.stringify({ sourceKind: "sample", referenceSource: { kind: "sample" } }),
      "utf-8",
    );
    await writeRun("real-recording", "請錄製真實聲音。", 8);

    const outDir = path.join(tmpRoot, "profile");
    const { stdout } = await execFileAsync(python, [
      script,
      "--runs-dir",
      path.join(tmpRoot, "runs"),
      "--out-dir",
      outDir,
    ]);

    const summary = JSON.parse(stdout);
    expect(summary.eligibleClips).toBe(1);

    const profile = JSON.parse(await readFile(path.join(outDir, "profile.json"), "utf-8"));
    expect(profile.referenceClipIds).toEqual(["real-recording"]);
  });
});

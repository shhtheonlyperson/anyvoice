// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "select_voice_backend_candidate.py");
const candidateAudio = Buffer.from("candidate backend wav bytes\n");
const baselineAudio = Buffer.from("baseline backend wav bytes\n");
const voiceProfileId = "local-test";
const profileSha256 = "f".repeat(64);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-select-backend-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeCandidateAudio(candidateCloneMode = "indextts2"): Promise<string> {
  const audioPath = path.join(tmpRoot, `${candidateCloneMode}.wav`);
  await writeFile(audioPath, candidateAudio);
  return audioPath;
}

function blindOrderKey(caseId: string, repeat: number, cloneMode: string, outputWav: string): string {
  return createHash("sha256").update(`${caseId}\0${repeat}\0${cloneMode}\0${outputWav}`, "utf8").digest("hex");
}

function candidateLabel(
  caseId: string,
  repeat: number,
  baselineOutputWav: string,
  candidateOutputWav: string,
  candidateCloneMode = "indextts2",
): string {
  const samples = [
    { cloneMode: "voxcpm2-hifi", outputWav: baselineOutputWav },
    { cloneMode: candidateCloneMode, outputWav: candidateOutputWav },
  ].sort((a, b) => blindOrderKey(caseId, repeat, a.cloneMode, a.outputWav).localeCompare(
    blindOrderKey(caseId, repeat, b.cloneMode, b.outputWav),
  ));
  return String.fromCharCode(65 + samples.findIndex((sample) => sample.cloneMode === candidateCloneMode));
}

async function writeSourceReport({
  candidateWins = true,
  baselineWins = false,
  profileEvidence = true,
  candidateCloneMode = "indextts2",
}: {
  candidateWins?: boolean;
  baselineWins?: boolean;
  profileEvidence?: boolean;
  candidateCloneMode?: string;
} = {}): Promise<string> {
  const reportPath = path.join(tmpRoot, "report.json");
  const baselineOutputWav = path.join(tmpRoot, "voxcpm2.wav");
  const candidateOutputWav = path.join(tmpRoot, `${candidateCloneMode}.wav`);
  await writeFile(baselineOutputWav, baselineAudio);
  await writeCandidateAudio(candidateCloneMode);
  const candidateSha256 = sha256Buffer(candidateAudio);
  const baselineSha256 = sha256Buffer(baselineAudio);
  const profileFields = profileEvidence ? { voiceProfileId, profileSha256 } : {};
  const report = {
    version: 1,
    ...(profileEvidence ? { voiceProfile: { voiceProfileId, profileSha256 } } : {}),
    groups: [
      {
        cloneMode: "voxcpm2-hifi",
        ...profileFields,
        case: { id: "zh_hant_polyphones", text: "重慶角色" },
        stability: { verdict: "pass" },
        renders: [{
          caseId: "zh_hant_polyphones",
          cloneMode: "voxcpm2-hifi",
          repeat: 1,
          status: "ready",
          outputWav: baselineOutputWav,
          outputExists: true,
          missingOutput: false,
          outputBytes: baselineAudio.byteLength,
          outputSha256: baselineSha256,
          ...profileFields,
        }],
      },
      {
        cloneMode: candidateCloneMode,
        ...profileFields,
        case: { id: "zh_hant_polyphones", text: "重慶角色" },
        stability: { verdict: "pass" },
        renders: [{
          caseId: "zh_hant_polyphones",
          cloneMode: candidateCloneMode,
          repeat: 1,
          status: "ready",
          outputWav: candidateOutputWav,
          externalBackend: true,
          outputExists: true,
          missingOutput: false,
          outputBytes: candidateAudio.byteLength,
          outputSha256: candidateSha256,
          renderSeconds: 9.1,
          ...profileFields,
        }],
      },
    ],
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportText, "utf-8");
  const reportSha256 = sha256Buffer(Buffer.from(reportText, "utf8"));
  const candidateWinsCount = candidateWins && !baselineWins ? 1 : 0;
  const baselineWinsCount = baselineWins ? 1 : 0;
  const ties = candidateWinsCount || baselineWinsCount ? 0 : 1;
  const candidateChoice = candidateLabel("zh_hant_polyphones", 1, baselineOutputWav, candidateOutputWav, candidateCloneMode);
  const baselineChoice = candidateChoice === "A" ? "B" : "A";
  const stats = {
    rounds: 1,
    reviewedRounds: 1,
    candidateWins: candidateWinsCount,
    baselineWins: baselineWinsCount,
    ties,
    rerenders: 0,
    candidateWinRate: candidateWinsCount ? 1 : 0,
    minCandidateWinRate: 0.8,
    reportSha256,
  };
  await writeFile(
    path.join(tmpRoot, "review.json"),
    `${JSON.stringify(
      {
        version: 1,
        status: "pass",
        report: reportPath,
        reportPath,
        reportSha256,
        expectedSaveAs: path.join(tmpRoot, "review.json"),
        choiceKeys: ["winner-zh_hant_polyphones-r01"],
        reviewedAt: "2026-01-09T00:00:00.000Z",
        stats,
        choices: {
          "winner-zh_hant_polyphones-r01": baselineWins
            ? baselineChoice
            : candidateWins
              ? candidateChoice
              : "tie",
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return reportPath;
}

function scoreJson({
  candidateCloneMode = "indextts2",
  candidateOutputWav = path.join(tmpRoot, `${candidateCloneMode}.wav`),
  candidateSha256 = sha256Buffer(candidateAudio),
  sourceReport = path.join(tmpRoot, "report.json"),
  sourceReportSha256 = "0".repeat(64),
}: {
  candidateCloneMode?: string;
  candidateOutputWav?: string;
  candidateSha256?: string | null;
  sourceReport?: string;
  sourceReportSha256?: string;
} = {}) {
  const candidateRender: Record<string, unknown> = {
    caseId: "zh_hant_polyphones",
    cloneMode: candidateCloneMode,
    repeat: 1,
    status: "ready",
    voiceProfileId,
    profileSha256,
    externalBackend: true,
    outputExists: true,
    missingOutput: false,
    outputBytes: candidateAudio.byteLength,
    outputWav: candidateOutputWav,
    renderSeconds: 9.1,
    audioMetrics: { available: true, durationSec: 1.2, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
  };
  if (candidateSha256 !== null) {
    candidateRender.outputSha256 = candidateSha256;
  }
  return {
    version: 1,
    sourceReport,
    sourceReportSha256,
    voiceProfile: {
      voiceProfileId,
      profileSha256,
    },
    verdict: "pass",
    summary: { groups: 2, passingGroups: 2, avgSpeakerSimilarity: 0.835, avgCer: 0.05, avgWer: 0.06 },
    groups: [
      {
        cloneMode: "voxcpm2-hifi",
        caseId: "zh_hant_polyphones",
        voiceProfileId,
        profileSha256,
        pronunciationVerdict: "pass",
        stabilityVerdict: "pass",
        speakerIdentityVerdict: "pass",
        audioQualityVerdict: "pass",
        profileReferenceVerdict: "pass",
        verdict: "pass",
        avgCer: 0.25,
        avgWer: 0.3,
        avgRenderSeconds: 10.2,
        speakerIdentity: { verdict: "pass", avgSpeakerSimilarity: 0.81 },
        audioQuality: { verdict: "pass", maxClippingRatio: 0 },
        renders: [
          {
            caseId: "zh_hant_polyphones",
            cloneMode: "voxcpm2-hifi",
            repeat: 1,
            status: "ready",
            voiceProfileId,
            profileSha256,
            renderSeconds: 10.2,
            audioMetrics: { available: true, durationSec: 1.3, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
            hasSpeakerSimilarity: true,
          },
        ],
      },
      {
        cloneMode: candidateCloneMode,
        caseId: "zh_hant_polyphones",
        voiceProfileId,
        profileSha256,
        pronunciationVerdict: "pass",
        stabilityVerdict: "pass",
        speakerIdentityVerdict: "pass",
        audioQualityVerdict: "pass",
        profileReferenceVerdict: "pass",
        verdict: "pass",
        avgCer: 0.02,
        avgWer: 0.03,
        avgRenderSeconds: 9.1,
        speakerIdentity: { verdict: "pass", avgSpeakerSimilarity: 0.87 },
        audioQuality: { verdict: "pass", maxClippingRatio: 0 },
        renders: [candidateRender],
      },
    ],
    pairedComparison: {
      verdict: "pass",
      baselineCloneMode: "voxcpm2-hifi",
      candidateCloneMode,
      summary: {
        pairs: 1,
        passingPairs: 1,
        reviewPairs: 0,
        avgCerReductionPct: 92,
        avgWerReductionPct: 90,
      },
      pairs: [
        {
          caseId: "zh_hant_polyphones",
          baselineCloneMode: "voxcpm2-hifi",
          candidateCloneMode,
          verdict: "pass",
          cerReductionPct: 92,
          werReductionPct: 90,
          speakerSimilarityDelta: 0.06,
          baselineAvgRenderSeconds: 10.2,
          candidateAvgRenderSeconds: 9.1,
          latencyRegressionPct: -10.784,
          maxLatencyRegressionPct: 0,
          latencyVerdict: "pass",
        },
      ],
    },
  };
}

async function scoreJsonWithReportSha(options: Parameters<typeof scoreJson>[0] = {}) {
  const sourceReport = options?.sourceReport ?? path.join(tmpRoot, "report.json");
  return scoreJson({
    ...options,
    sourceReport,
    sourceReportSha256: sha256Buffer(await readFile(sourceReport)),
  });
}

async function writeScoreJson(scorePath: string, options: Parameters<typeof scoreJson>[0] = {}) {
  await writeFile(scorePath, `${JSON.stringify(await scoreJsonWithReportSha(options), null, 2)}\n`, "utf-8");
}

async function removeSourceReportCandidateExternalEvidence(reportPath: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf-8"));
  const render = report.groups?.[1]?.renders?.[0];
  if (render) {
    delete render.externalBackend;
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
  }
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportText, "utf-8");
  const reviewPath = path.join(tmpRoot, "review.json");
  const review = JSON.parse(await readFile(reviewPath, "utf-8"));
  const reportSha256 = sha256Buffer(Buffer.from(reportText, "utf8"));
  review.reportSha256 = reportSha256;
  if (review.stats && typeof review.stats === "object") {
    review.stats.reportSha256 = reportSha256;
  }
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
}

describe("select_voice_backend_candidate.py", () => {
  it("accepts an external backend only with passing paired score, speaker evidence, and hashed WAVs", async () => {
    const scorePath = path.join(tmpRoot, "score.json");
    const outPath = path.join(tmpRoot, "selection.json");
    const reportPath = await writeSourceReport();
    await writeScoreJson(scorePath);
    const scoreSha256 = sha256Buffer(await readFile(scorePath));
    const reviewPath = path.join(tmpRoot, "review.json");
    const resolvedReviewPath = await realpath(reviewPath);
    const resolvedReportPath = await realpath(reportPath);
    const reviewSha256 = sha256Buffer(await readFile(reviewPath));
    const sourceReportSha256 = sha256Buffer(await readFile(reportPath));

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "indextts2",
      "--out",
      outPath,
      "--strict",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "accept",
      accepted: true,
      scoreSha256,
      reviewJson: resolvedReviewPath,
      reviewSha256,
      sourceReport: resolvedReportPath,
      sourceReportSha256,
      candidateCloneMode: "indextts2",
      pairedComparisonVerdict: "pass",
      subjectiveReview: {
        status: "pass",
      },
      candidate: {
        externalRenders: 1,
        hashedExternalRenders: 1,
        avgSpeakerSimilarity: 0.87,
      },
    });

    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof.reasons).toEqual([]);
    expect(proof.baseline.avgSpeakerSimilarity).toBe(0.81);
  });

  it("accepts fishaudio-s2-pro as an honestly labeled external backend candidate", async () => {
    const scorePath = path.join(tmpRoot, "score-fish.json");
    const outPath = path.join(tmpRoot, "selection-fish.json");
    const reportPath = await writeSourceReport({ candidateCloneMode: "fishaudio-s2-pro" });
    await writeScoreJson(scorePath, { candidateCloneMode: "fishaudio-s2-pro" });
    const sourceReportSha256 = sha256Buffer(await readFile(reportPath));

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "fishaudio-s2-pro",
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "accept",
      accepted: true,
      candidateCloneMode: "fishaudio-s2-pro",
      sourceReportSha256,
      candidate: {
        externalRenders: 1,
        hashedExternalRenders: 1,
      },
    });
    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof.reasons).toEqual([]);
  });

  it("rejects external backend selection when the baseline score group did not pass", async () => {
    const scorePath = path.join(tmpRoot, "score.json");
    const outPath = path.join(tmpRoot, "selection.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    score.groups[0].verdict = "review";
    score.groups[0].speakerIdentityVerdict = "review";
    score.groups[0].speakerIdentity.verdict = "review";
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--out",
        outPath,
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("baseline_group_not_pass:zh_hant_polyphones"),
    });
    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof.reasons).toContain("baseline_speaker_identity_not_pass:zh_hant_polyphones");
  });

  it("resolves score sourceReport relative to the score JSON", async () => {
    const scoreDir = path.join(tmpRoot, "nested-score");
    const scorePath = path.join(scoreDir, "score.json");
    const outPath = path.join(tmpRoot, "selection-relative-source-report.json");
    const reportPath = await writeSourceReport();
    const score = await scoreJsonWithReportSha({ sourceReport: reportPath });
    score.sourceReport = path.relative(scoreDir, reportPath);
    await mkdir(scoreDir, { recursive: true });
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const resolvedReportPath = await realpath(reportPath);

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "indextts2",
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "accept",
      accepted: true,
      sourceReport: resolvedReportPath,
      candidateCloneMode: "indextts2",
      subjectiveReview: {
        status: "pass",
        report: resolvedReportPath,
      },
    });
    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof.sourceReport).toBe(resolvedReportPath);
  });

  it("resolves review reportPath relative to the review JSON", async () => {
    const scorePath = path.join(tmpRoot, "score-relative-review-report.json");
    const outPath = path.join(tmpRoot, "selection-relative-review-report.json");
    const reportPath = await writeSourceReport();
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.report = "report.json";
    review.reportPath = "report.json";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
    await writeScoreJson(scorePath);
    const resolvedReportPath = await realpath(reportPath);

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "indextts2",
      "--out",
      outPath,
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "accept",
      accepted: true,
      sourceReport: resolvedReportPath,
      subjectiveReview: {
        status: "pass",
        report: resolvedReportPath,
      },
    });
  });

  it("rejects an accepted-looking external backend candidate outside the supported backend interface", async () => {
    const candidateCloneMode = "made-up-backend";
    const scorePath = path.join(tmpRoot, "score-unsupported-backend.json");
    await writeSourceReport({ candidateCloneMode });
    await writeScoreJson(scorePath, { candidateCloneMode });

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        candidateCloneMode,
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("candidate_backend_not_allowed:made-up-backend"),
    });
  });

  it("rejects an external backend candidate whose rendered WAV hash is missing", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-hash.json");
    await writeSourceReport();
    await writeScoreJson(scorePath, { candidateSha256: null });

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("external_candidate_output_sha256_missing"),
    });
  });

  it("rejects an external backend candidate whose source report lacks external render evidence", async () => {
    const scorePath = path.join(tmpRoot, "score-source-report-missing-external-evidence.json");
    const reportPath = await writeSourceReport();
    await removeSourceReportCandidateExternalEvidence(reportPath);
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("source_report_candidate_external_backend_missing:indextts2/zh_hant_polyphones#r1"),
    });
  });

  it("rejects an external backend candidate when the hashed WAV is no longer present", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-file.json");
    await writeSourceReport();
    await writeFile(
      scorePath,
      `${JSON.stringify(await scoreJsonWithReportSha({ candidateOutputWav: path.join(tmpRoot, "missing-indextts2.wav") }), null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("external_candidate_output_file_missing"),
    });
  });

  it("rejects an external backend candidate when the baseline review WAV no longer matches the source report hash", async () => {
    const scorePath = path.join(tmpRoot, "score-stale-baseline-review-audio.json");
    await writeSourceReport();
    await writeFile(path.join(tmpRoot, "voxcpm2.wav"), Buffer.from("tampered baseline review wav\n"));
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("source_report_review_output_sha256_mismatch:voxcpm2-hifi/zh_hant_polyphones#r1"),
    });
  });

  it("rejects accepted-looking backend scores that are not bound to a voice profile", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-profile-evidence.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    delete (score as Record<string, unknown>).voiceProfile;
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("score_voice_profile_id_missing"),
    });
  });

  it("rejects backend scores that are not bound to the exact source report bytes", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-source-report-sha.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    delete (score as Record<string, unknown>).sourceReportSha256;
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("score_source_report_sha256_missing"),
    });
  });

  it("rejects backend scores with stale source report hash evidence", async () => {
    const scorePath = path.join(tmpRoot, "score-stale-source-report-sha.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha({ sourceReportSha256: "0".repeat(64) });
    score.sourceReportSha256 = "0".repeat(64);
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("score_source_report_sha256_mismatch"),
    });
  });

  it("rejects accepted-looking backend selections whose review source report is not profile-bound", async () => {
    const scorePath = path.join(tmpRoot, "score-source-report-missing-profile-evidence.json");
    await writeSourceReport({ profileEvidence: false });
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("source_report_voice_profile_missing"),
    });
  });

  it("rejects backend scores whose rendered samples do not match the score voice profile", async () => {
    const scorePath = path.join(tmpRoot, "score-stale-render-profile.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    const candidate = score.groups.find((group: Record<string, unknown>) => group.cloneMode === "indextts2") as {
      renders: Array<Record<string, unknown>>;
    };
    candidate.renders[0].profileSha256 = "0".repeat(64);
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("render_profile_sha256_mismatch"),
    });
  });

  it("accepts an external backend candidate when the blind review is all tie", async () => {
    const scorePath = path.join(tmpRoot, "score-subjective-review.json");
    await writeSourceReport({ candidateWins: false });
    await writeScoreJson(scorePath);

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "indextts2",
      "--strict",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      verdict: "accept",
      accepted: true,
      subjectiveReview: {
        status: "pass",
        stats: {
          candidateWins: 0,
          baselineWins: 0,
          ties: 1,
          candidateWinRate: 0,
        },
      },
    });
  });

  it("rejects an external backend candidate when the baseline clearly wins", async () => {
    const scorePath = path.join(tmpRoot, "score-subjective-baseline-win.json");
    await writeSourceReport({ candidateWins: false, baselineWins: true });
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_baseline_preferred_over_candidate"),
    });
  });

  it("rejects an external backend candidate when review export lacks pass status", async () => {
    const scorePath = path.join(tmpRoot, "score-review-status-missing.json");
    await writeSourceReport();
    await writeScoreJson(scorePath);
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    delete review.status;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_status_not_pass"),
    });
  });

  it("rejects an external backend candidate when review export stats are stale", async () => {
    const scorePath = path.join(tmpRoot, "score-review-stale-stats.json");
    await writeSourceReport();
    await writeScoreJson(scorePath);
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.stats.candidateWins = 0;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_stats_mismatch"),
    });
  });

  it("requires explicit unsafe acknowledgement before skipping subjective review", async () => {
    const scorePath = path.join(tmpRoot, "score-skip-review-without-ack.json");
    const outPath = path.join(tmpRoot, "selection-skip-review-without-ack.json");
    await writeSourceReport();
    await rm(path.join(tmpRoot, "review.json"));
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--skip-subjective-review",
        "--out",
        outPath,
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("unsafe_subjective_review_bypass_not_acknowledged"),
    });

    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof).toMatchObject({
      verdict: "reject",
      accepted: false,
      subjectiveReview: {
        status: "bypassed",
        acceptedUnsafeBypass: false,
      },
    });
    expect(proof.reasons).toContain("subjective_review_bypassed");
    expect(proof.reasons).toContain("unsafe_subjective_review_bypass_not_acknowledged");
  });

  it("keeps an acknowledged subjective review bypass as rejected experiment proof", async () => {
    const scorePath = path.join(tmpRoot, "score-skip-review-acknowledged.json");
    const outPath = path.join(tmpRoot, "selection-skip-review-acknowledged.json");
    await writeSourceReport();
    await rm(path.join(tmpRoot, "review.json"));
    await writeScoreJson(scorePath);

    const { stdout } = await execFileAsync(python, [
      script,
      scorePath,
      "--candidate-clone-mode",
      "indextts2",
      "--skip-subjective-review",
      "--allow-unsafe-subjective-review-bypass",
      "--unsafe-subjective-review-bypass-reason",
      "metrics-only backend benchmark before blind review is available",
      "--out",
      outPath,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      verdict: "reject",
      accepted: false,
      subjectiveReview: {
        status: "bypassed",
        acceptedUnsafeBypass: true,
        reason: "metrics-only backend benchmark before blind review is available",
      },
    });
    expect(payload.reasons).toEqual(["subjective_review_bypassed"]);
    const proof = JSON.parse(await readFile(outPath, "utf-8"));
    expect(proof).toMatchObject({
      verdict: "reject",
      accepted: false,
      subjectiveReview: {
        acceptedUnsafeBypass: true,
      },
    });
  });

  it("rejects an external backend candidate when the review report samples were not rendered", async () => {
    const scorePath = path.join(tmpRoot, "score-review-report-not-rendered.json");
    const reportPath = await writeSourceReport();
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    const candidateGroup = report.groups.find((group: Record<string, unknown>) => group.cloneMode === "indextts2") as {
      renders: Record<string, unknown>[];
    };
    candidateGroup.renders = candidateGroup.renders.map((render) => ({
      ...render,
      status: "missing",
      outputWav: "",
    }));
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, reportText, "utf-8");
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, reportSha256: sha256Buffer(Buffer.from(reportText, "utf8")) }, null, 2)}\n`,
      "utf-8",
    );
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_rounds_missing"),
    });
  });

  it("rejects an external backend candidate when the review report audio files are missing", async () => {
    const scorePath = path.join(tmpRoot, "score-review-report-missing-audio.json");
    await writeSourceReport();
    await rm(path.join(tmpRoot, "voxcpm2.wav"));
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_rounds_missing"),
    });
  });

  it("rejects an external backend candidate when blind review rounds have duplicate candidate samples", async () => {
    const scorePath = path.join(tmpRoot, "score-review-report-duplicate-candidate.json");
    const reportPath = await writeSourceReport();
    const duplicateCandidateWav = path.join(tmpRoot, "indextts2-copy.wav");
    await writeFile(duplicateCandidateWav, candidateAudio);
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    const candidateGroup = report.groups.find((group: Record<string, unknown>) => group.cloneMode === "indextts2") as {
      renders: Array<Record<string, unknown>>;
    };
    candidateGroup.renders.push({
      ...candidateGroup.renders[0],
      outputWav: duplicateCandidateWav,
    });
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, reportText, "utf-8");
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, reportSha256: sha256Buffer(Buffer.from(reportText, "utf8")) }, null, 2)}\n`,
      "utf-8",
    );
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_ambiguous_rounds"),
    });
  });

  it("rejects an external backend candidate whose review JSON points at a different report path", async () => {
    const scorePath = path.join(tmpRoot, "score-review-wrong-report-path.json");
    const reportPath = await writeSourceReport();
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    const wrongReportPath = path.join(tmpRoot, "other-report.json");
    await writeFile(wrongReportPath, await readFile(reportPath, "utf-8"), "utf-8");
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, report: wrongReportPath, reportPath: wrongReportPath }, null, 2)}\n`,
      "utf-8",
    );
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_report_path_mismatch"),
    });
  });

  it("rejects an external backend candidate whose review JSON save location does not match the consumed file", async () => {
    const scorePath = path.join(tmpRoot, "score-review-wrong-save-location.json");
    await writeSourceReport();
    const reviewPath = path.join(tmpRoot, "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, expectedSaveAs: path.join(tmpRoot, "copied-review.json") }, null, 2)}\n`,
      "utf-8",
    );
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("subjective_review_expected_save_as_mismatch"),
    });
  });

  it("rejects an external backend candidate whose paired score omits latency evidence", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-latency.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    const pair = score.pairedComparison.pairs[0] as Record<string, unknown>;
    delete pair.latencyRegressionPct;
    delete pair.latencyVerdict;
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("latency_delta_not_measurable"),
    });
  });

  it("rejects external backend candidates measured against anything other than voxcpm2-hifi", async () => {
    const scorePath = path.join(tmpRoot, "score-wrong-baseline.json");
    await writeSourceReport();
    await writeScoreJson(scorePath);

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--baseline-clone-mode",
        "prompt",
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("baseline_must_be_voxcpm2_hifi"),
    });
  });

  it("rejects an external backend candidate whose score omits audio quality proof", async () => {
    const scorePath = path.join(tmpRoot, "score-missing-audio-quality.json");
    await writeSourceReport();
    const score = await scoreJsonWithReportSha();
    const candidate = score.groups.find((group: Record<string, unknown>) => group.cloneMode === "indextts2") as Record<string, unknown>;
    delete candidate.audioQualityVerdict;
    delete candidate.audioQuality;
    await writeFile(scorePath, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        script,
        scorePath,
        "--candidate-clone-mode",
        "indextts2",
        "--strict",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("candidate_audio_quality_not_pass"),
    });
  });
});

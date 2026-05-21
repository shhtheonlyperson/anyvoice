// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyVoiceProfileReadiness } from "@/lib/voice-profile-verify";

const originalEnv = { ...process.env };
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];
let tmpRoot: string;
let profileRoot: string;
type ProfileFixtureClip = { sourceRunId: string; transcriptRaw: string; audioPath: string };

async function writeReadyProfile(): Promise<string> {
  const profileDir = path.join(profileRoot, "local-test");
  await mkdir(profileDir, { recursive: true });
  const clips = [];
  for (let index = 1; index <= 5; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index}.wav`);
    await writeFile(audioPath, Buffer.from([index, index + 1, index + 2]));
    clips.push({
      sourceRunId: `clip-${index}`,
      audioPath,
      transcriptRaw: `這是第 ${index} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
      transcriptScript: "zh_hant",
      coverageFeatures: coverage,
      sourceKind: "scripted",
      quality: {
        grade: "A",
        durationSec: 7,
        snrDb: 30,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      modelId: "openbmb/VoxCPM2",
      cloneMode: "hifi",
    });
  }
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify(
      {
        version: 1,
        voiceProfileId: "local-test",
        status: "ready",
        requirements: {
          minClips: 5,
          maxClips: 10,
          minDurationSec: 6,
          maxDurationSec: 20,
          passingGrades: ["A", "B"],
          requiredCoverageFeatures: coverage,
        },
        summary: {
          eligibleClips: 5,
          selectedClips: 5,
          rejectedClips: 0,
          remainingClipsNeeded: 0,
        },
        diagnostics: {
          missingCoverageFeatures: [],
        },
        clips,
        rejectedClips: [],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return profilePath;
}

async function validationRowsForProfile(profilePath: string) {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as { clips: ProfileFixtureClip[] };
  return profile.clips.map((clip) => ({
    sourceRunId: clip.sourceRunId,
    expectedTranscript: clip.transcriptRaw,
    audioPath: clip.audioPath,
    verdict: "pass",
    cer: { rate: 0 },
    wer: { rate: 0 },
  }));
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-verify-"));
  profileRoot = path.join(tmpRoot, "voices");
  process.env.ANYVOICE_VOICE_PROFILE_ROOT = profileRoot;
  process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT = path.join(tmpRoot, "transcript-validation");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("verifyVoiceProfileReadiness", () => {
  it("returns blocked verifier output instead of throwing for an incomplete profile", async () => {
    await mkdir(path.join(profileRoot, "local-test"), { recursive: true });
    await writeFile(
      path.join(profileRoot, "local-test", "profile.json"),
      `${JSON.stringify({
        version: 1,
        voiceProfileId: "local-test",
        status: "needs_enrollment",
        requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
        summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
        clips: [],
        rejectedClips: [],
      })}\n`,
      "utf-8",
    );

    const report = await verifyVoiceProfileReadiness({ profileId: "local-test" });
    expect(report.status).toBe("blocked");
    expect(report.checks.find((check) => check.check === "clip_count")).toMatchObject({ ok: false });
    expect(report.checks.find((check) => check.check === "transcript_validation")).toMatchObject({ ok: false });
  });

  it("uses the latest transcript-validation report for the same profile", async () => {
    const profilePath = await writeReadyProfile();
    const validationRoot = process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT!;
    await mkdir(validationRoot, { recursive: true });
    await writeFile(
      path.join(validationRoot, "local-test-old.json"),
      `${JSON.stringify({
        createdAt: "2026-01-01T00:00:00.000Z",
        profile: profilePath,
        status: "blocked",
        summary: { total: 5, passed: 0, failed: 5 },
        clips: [],
      })}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(validationRoot, "local-test-new.json"),
      `${JSON.stringify({
        createdAt: "2026-01-02T00:00:00.000Z",
        profile: profilePath,
        status: "pass",
        summary: { total: 5, passed: 5, failed: 0 },
        clips: await validationRowsForProfile(profilePath),
      })}\n`,
      "utf-8",
    );

    const report = await verifyVoiceProfileReadiness({ profileId: "local-test" });
    expect(report.status).toBe("ready");
    expect(report.checks.find((check) => check.check === "transcript_validation")).toMatchObject({
      ok: true,
    });
  });

  it("uses the profile-local transcript-validation report from kit enrollment", async () => {
    const profilePath = await writeReadyProfile();
    await writeFile(
      path.join(path.dirname(profilePath), "transcript-validation.json"),
      `${JSON.stringify({
        createdAt: "2026-01-03T00:00:00.000Z",
        profile: profilePath,
        status: "pass",
        summary: { total: 5, passed: 5, failed: 0 },
        clips: await validationRowsForProfile(profilePath),
      })}\n`,
      "utf-8",
    );

    const report = await verifyVoiceProfileReadiness({ profileId: "local-test" });
    expect(report.status).toBe("ready");
    expect(report.checks.find((check) => check.check === "transcript_validation")).toMatchObject({
      ok: true,
    });
  });

  it("rejects unsafe profile ids before invoking the verifier script", async () => {
    await expect(verifyVoiceProfileReadiness({ profileId: "../bad" })).rejects.toThrow(
      "profileId must contain only letters, numbers, dash, or underscore",
    );
  });
});

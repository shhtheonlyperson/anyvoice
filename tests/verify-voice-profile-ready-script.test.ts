// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "verify_voice_profile_ready.py");

let tmpRoot: string;

const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];
type ProfileFixtureClip = { sourceRunId: string; transcriptRaw: string; audioPath: string };

async function writeProfile({
  ready = true,
  clips = 5,
  durations = [7, 8, 9, 10, 11],
  missingCoverage = [],
  missingAudio = false,
  sourceKinds,
  transcripts,
  declaredTranscriptScripts,
  recordingKitClipIds,
}: {
  ready?: boolean;
  clips?: number;
  durations?: number[];
  missingCoverage?: string[];
  missingAudio?: boolean;
  sourceKinds?: string[];
  transcripts?: string[];
  declaredTranscriptScripts?: string[];
  recordingKitClipIds?: string[];
} = {}): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const rows = [];
  for (let index = 1; index <= clips; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index}.wav`);
    if (!missingAudio || index !== 1) {
      await writeFile(audioPath, Buffer.from([index, index + 1, index + 2]));
    }
    rows.push({
      sourceRunId: `clip-${index}`,
      ...(recordingKitClipIds?.[index - 1] ? { recordingKitClipId: recordingKitClipIds[index - 1] } : {}),
      audioPath,
      transcriptRaw: transcripts?.[index - 1] ?? `這是第 ${index} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
      transcriptScript: declaredTranscriptScripts?.[index - 1] ?? "zh_hant",
      coverageFeatures: coverage.filter((feature) => !missingCoverage.includes(feature)),
      sourceKind: sourceKinds?.[index - 1] ?? "scripted",
      quality: {
        grade: index === clips ? "B" : "A",
        durationSec: durations[index - 1] ?? 7,
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
      remainingClipsNeeded: ready ? 0 : Math.max(0, 5 - rows.length),
    },
    preferredPromptClipId: rows[0]?.sourceRunId ?? null,
    referenceClipIds: rows.map((clip) => clip.sourceRunId),
    diagnostics: {
      missingCoverageFeatures: missingCoverage,
    },
    loraPath: null,
    clips: rows,
    rejectedClips: [],
  };
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  return profilePath;
}

async function profileClips(profilePath: string): Promise<ProfileFixtureClip[]> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as { clips: ProfileFixtureClip[] };
  return profile.clips;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function canonicalProfileSha256(profilePath: string): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as Record<string, unknown>;
  delete profile.createdAt;
  delete profile.loraPath;
  delete profile.loraAdapter;
  delete profile.preferredBackend;
  return createHash("sha256").update(canonicalJson(profile), "utf-8").digest("hex");
}

async function writeTranscriptValidation(
  profilePath: string,
  validationPath: string,
  {
    reportProfilePath = profilePath,
    profileSha256,
    staleSourceRunId = "",
    wrongAudioSourceRunId = "",
    failedSourceRunId = "",
  }: { reportProfilePath?: string; profileSha256?: string; staleSourceRunId?: string; wrongAudioSourceRunId?: string; failedSourceRunId?: string } = {},
): Promise<void> {
  const clips = await profileClips(profilePath);
  const failed = failedSourceRunId ? 1 : 0;
  await writeFile(
    validationPath,
    `${JSON.stringify({
      profile: reportProfilePath,
      ...(profileSha256 ? { profileSha256 } : {}),
      status: failed ? "blocked" : "pass",
      summary: { total: clips.length, passed: clips.length - failed, failed },
      clips: clips.map((clip) => ({
        sourceRunId: clip.sourceRunId,
        expectedTranscript: clip.sourceRunId === staleSourceRunId ? "舊的逐字稿" : clip.transcriptRaw,
        audioPath: clip.sourceRunId === wrongAudioSourceRunId ? path.join(tmpRoot, "wrong.wav") : clip.audioPath,
        verdict: clip.sourceRunId === failedSourceRunId ? "fail" : "pass",
        cer: { rate: clip.sourceRunId === failedSourceRunId ? 0.5 : 0 },
        wer: { rate: clip.sourceRunId === failedSourceRunId ? 0.6 : 0 },
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-verify-profile-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("verify_voice_profile_ready.py", () => {
  it("passes a ready profile and prints the next regression and LoRA commands", async () => {
    const profilePath = await writeProfile();
    const { stdout } = await execFileAsync(python, [script, "--profile-json", profilePath], {
      env: { ...process.env, ANYVOICE_ASR_PYTHON: "/tmp/asrpy" },
    });
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.summary).toMatchObject({
      selectedClips: 5,
      totalDurationSec: 45,
      missingCoverageFeatures: [],
    });
    expect(payload.checks.every((row: { ok: boolean }) => row.ok)).toBe(true);
    expect(payload.nextCommands.qualityGate).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommands.qualityGate).toContain("--profile-json");
    expect(payload.nextCommands.qualityGate).toContain("--asr-python /tmp/asrpy");
    expect(payload.nextCommands.profileNextStep).toContain("scripts/voice_profile_next_step.py");
    expect(payload.nextCommands.recordingKit).toContain("scripts/prepare_voice_profile_recording_kit.py");
    expect(payload.nextCommands.recordingKit).toContain("--prompt-set extended");
    expect(payload.nextCommands.recordingKit).toContain("--profile-id local-test");
    expect(payload.nextCommands.recordingKit).toContain(path.join("generated", "voice-profile-recording-kits", "local-test-current"));
    expect(payload.nextCommands.enrollProfileKit).toContain("scripts/enroll_voice_profile_kit.py");
    expect(payload.nextCommands.importProfileClips).toContain("scripts/import_voice_profile_clips.py");
    expect(payload.nextCommands.regression).toContain("scripts/voice_clone_regression.py");
    expect(payload.nextCommands.backendShootout).toContain("scripts/prepare_voice_backend_shootout.py");
    expect(payload.nextCommands.backendShootout).toContain("--backend voxcpm2-hifi");
    expect(payload.nextCommands.backendShootout).toContain("--backend indextts2 --backend f5-tts");
    expect(payload.nextCommands.registerBackendRenders).toContain("scripts/register_voice_backend_renders.py");
    expect(payload.nextCommands.validateTranscripts).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.nextCommands.validateTranscripts).toContain("/tmp/asrpy");
    expect(payload.nextCommands.validateTranscripts).toContain("--out");
    expect(payload.nextCommands.validateTranscripts).toContain(path.join("profile", "transcript-validation.json"));
    expect(payload.nextCommands.verifyProfileStrict).toContain("--require-transcript-validation");
    expect(payload.nextCommands.verifyProfileStrict).toContain(path.join("profile", "transcript-validation.json"));
    expect(payload.nextCommands.loraDataset).toContain("scripts/prepare_voice_lora_dataset.py");
    expect(payload.nextCommands.loraDataset).toContain("--require-product-proof-quality-gate");
    expect(payload.nextCommands.loraDataset).toContain("--min-clips 7");
    expect(payload.nextCommands.loraDataset).toContain("--min-total-duration-sec 60.0");
    expect(payload.recordingPrescription).toMatchObject({
      status: "satisfied",
      clipsNeeded: 0,
      durationSec: { min: 6, recommended: 8, max: 20, activeVoiceTarget: 5.2 },
    });
  });

  it("blocks profiles that are not ready or are missing pronunciation coverage", async () => {
    const profilePath = await writeProfile({
      ready: false,
      clips: 4,
      missingCoverage: ["polyphones"],
    });
    await expect(execFileAsync(python, [script, "--profile-json", profilePath])).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "blocked"'),
    });
    try {
      await execFileAsync(python, [script, "--profile-json", profilePath]);
      throw new Error("expected blocked profile");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      const payload = JSON.parse(stdout);
      expect(payload.recordingPrescription).toMatchObject({
        status: "needs_recording",
        clipsNeeded: 1,
        missingCoverageFeatures: ["polyphones"],
        promptManifest: "examples/voice_profile_import_manifest.extended.zh-Hant.json",
      });
      expect(payload.recordingPrescription.message).toContain("Record 1 more qualified profile clip");
    }
  });

  it("blocks broad polyphone coverage that lacks required exact pronunciation preset evidence", async () => {
    const profilePath = await writeProfile({
      transcripts: Array.from(
        { length: 5 },
        (_, index) => `這是第 ${index + 1} 段 AnyVoice、重慶、銀行，二零二六年五月十九日。`,
      ),
    });

    await expect(execFileAsync(python, [script, "--profile-json", profilePath])).rejects.toMatchObject({
      stdout: expect.stringContaining("missing pronunciation presets"),
    });

    try {
      await execFileAsync(python, [script, "--profile-json", profilePath]);
      throw new Error("expected blocked profile");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      const payload = JSON.parse(stdout);
      expect(payload.summary.missingCoverageFeatures).toEqual([]);
      expect(payload.summary.missingPronunciationPresetIds).toEqual([
        "polyphone:changle",
        "polyphone:music",
        "polyphone:role",
      ]);
      expect(payload.checks.find((row: { check: string }) => row.check === "pronunciation_presets")).toMatchObject({
        ok: false,
      });
      expect(payload.recordingPrescription.missingPronunciationPresetIds).toEqual([
        "polyphone:changle",
        "polyphone:music",
        "polyphone:role",
      ]);
    }
  });

  it("blocks missing audio unless the unsafe bypass is acknowledged", async () => {
    const profilePath = await writeProfile({ missingAudio: true });
    await expect(execFileAsync(python, [script, "--profile-json", profilePath])).rejects.toMatchObject({
      stdout: expect.stringContaining("selected clip audio file(s) are missing"),
    });
    await expect(execFileAsync(python, [script, "--profile-json", profilePath, "--skip-audio-exists"])).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "unsafe_audio_exists_bypass_blocked"'),
    });

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--skip-audio-exists",
      "--allow-unsafe-audio-exists-bypass",
      "--unsafe-audio-exists-bypass-reason",
      "remote migration profile paths are checked separately",
    ]);
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.audioFileCheck).toEqual({
      skipped: true,
      acceptedUnsafeBypass: true,
      reason: "remote migration profile paths are checked separately",
    });
    expect(payload.checks.find((row: { check: string }) => row.check === "audio_files")).toMatchObject({
      ok: true,
      details: {
        skipped: true,
        acceptedUnsafeBypass: true,
        reason: "remote migration profile paths are checked separately",
      },
    });
    await expect(stat(path.join(tmpRoot, "profile", "clip-1.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks generated/sample provenance and recomputes transcript script from raw text", async () => {
    const profilePath = await writeProfile({
      sourceKinds: ["profile", "sample", "scripted", "scripted", "scripted"],
      transcripts: [
        "這是第 1 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "這是第 2 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "这是第 3 段 AnyVoice、重庆、银行，二零二六年五月二十日。",
        "這是第 4 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "這是第 5 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
      ],
      declaredTranscriptScripts: ["zh_hant", "zh_hant", "zh_hant", "zh_hant", "zh_hant"],
    });

    await expect(execFileAsync(python, [script, "--profile-json", profilePath])).rejects.toMatchObject({
      stdout: expect.stringContaining("failed integrity checks"),
    });
    try {
      await execFileAsync(python, [script, "--profile-json", profilePath]);
      throw new Error("expected blocked profile");
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      const integrity = payload.checks.find((row: { check: string }) => row.check === "clip_integrity");
      expect(integrity).toMatchObject({ ok: false });
      expect(integrity.details.badClips[0]).toMatchObject({
        sourceKind: "profile",
        errors: expect.arrayContaining(["invalid_source_kind"]),
      });
      expect(integrity.details.badClips[1]).toMatchObject({
        sourceKind: "sample",
        errors: expect.arrayContaining(["invalid_source_kind"]),
      });
      expect(integrity.details.badClips[2]).toMatchObject({
        transcriptScript: "zh_hans",
        declaredTranscriptScript: "zh_hant",
        errors: expect.arrayContaining(["invalid_chinese_script", "transcript_script_mismatch"]),
        scriptMarkerHits: expect.arrayContaining([
          expect.objectContaining({ simplified: "这", simplifiedCount: 1 }),
          expect.objectContaining({ simplified: "庆", simplifiedCount: 1 }),
        ]),
      });
    }
  });

  it("blocks selected profile clips with unproven Chinese script evidence", async () => {
    const profilePath = await writeProfile({
      transcripts: [
        "中文音色自然。",
        "這是第 2 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "這是第 3 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "這是第 4 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
        "這是第 5 段 AnyVoice、重慶、銀行，二零二六年五月二十日。",
      ],
      declaredTranscriptScripts: ["zh_unknown", "zh_hant", "zh_hant", "zh_hant", "zh_hant"],
    });

    await expect(execFileAsync(python, [script, "--profile-json", profilePath])).rejects.toMatchObject({
      stdout: expect.stringContaining("unproven_chinese_script"),
    });
    try {
      await execFileAsync(python, [script, "--profile-json", profilePath]);
      throw new Error("expected blocked profile");
    } catch (error) {
      const payload = JSON.parse((error as { stdout: string }).stdout);
      const integrity = payload.checks.find((row: { check: string }) => row.check === "clip_integrity");
      expect(integrity.details.badClips[0]).toMatchObject({
        transcriptScript: "zh_unknown",
        declaredTranscriptScript: "zh_unknown",
        errors: expect.arrayContaining(["unproven_chinese_script"]),
      });
    }
  });

  it("can require passing ASR transcript validation before reporting ready", async () => {
    const profilePath = await writeProfile();
    try {
      await execFileAsync(python, [script, "--profile-json", profilePath, "--require-transcript-validation"]);
      throw new Error("expected transcript validation blocker");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      expect(stdout).toContain("transcript validation is required");
      const blockedPayload = JSON.parse(stdout);
      expect(blockedPayload.status).toBe("blocked");
      expect(blockedPayload.recordingPrescription).toMatchObject({
        status: "satisfied",
        clipsNeeded: 0,
        missingCoverageFeatures: [],
        missingPronunciationPresetIds: [],
      });
      expect(blockedPayload.recordingPrescription.message).toContain("Recording coverage is satisfied");
      expect(blockedPayload.recordingPrescription.message).not.toContain("Record 0");
    }

    try {
      await execFileAsync(python, [script, "--profile-json", profilePath, "--require-transcript-validation", "--human"]);
      throw new Error("expected transcript validation blocker");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      expect(stdout).toContain("Next proof:");
      expect(stdout).toContain("Resolve failed check(s): transcript_validation");
      expect(stdout).toContain("scripts/validate_voice_profile_transcripts.py");
      expect(stdout).not.toContain("Next recording:");
      expect(stdout).not.toContain("Record 0");
    }

    const validationPath = path.join(tmpRoot, "validation.json");
    await writeTranscriptValidation(profilePath, validationPath, { profileSha256: await canonicalProfileSha256(profilePath) });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      validationPath,
      "--require-transcript-validation",
    ]);
    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready");
    expect(payload.nextCommands.qualityGate).toContain("--transcript-validation-json");
    expect(payload.nextCommands.qualityGate).toContain(validationPath);
    expect(payload.checks.find((row: { check: string }) => row.check === "transcript_validation")).toMatchObject({
      ok: true,
    });
  });

  it("rejects transcript validation JSON that omits profile hash evidence", async () => {
    const profilePath = await writeProfile();
    const validationPath = path.join(tmpRoot, "missing-profile-hash-validation.json");
    await writeTranscriptValidation(profilePath, validationPath);

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"profileShaMatches": false'),
    });
  });

  it("rejects transcript validation JSON for a different profile", async () => {
    const profilePath = await writeProfile();
    const otherProfilePath = path.join(tmpRoot, "other-profile", "profile.json");
    const validationPath = path.join(tmpRoot, "wrong-profile-validation.json");
    await writeTranscriptValidation(profilePath, validationPath, { reportProfilePath: otherProfilePath });

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"profileMatches": false'),
    });
  });

  it("rejects transcript validation JSON bound to a stale profile hash", async () => {
    const profilePath = await writeProfile();
    const validationPath = path.join(tmpRoot, "stale-profile-hash-validation.json");
    await writeTranscriptValidation(profilePath, validationPath, { profileSha256: "0".repeat(64) });

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"profileShaMatches": false'),
    });
  });

  it("includes an exact re-record command when ASR rejects a selected clip transcript", async () => {
    const profilePath = await writeProfile({
      recordingKitClipIds: Array.from({ length: 5 }, (_, index) => `profile-clip-${String(index + 1).padStart(2, "0")}`),
    });
    const validationPath = path.join(tmpRoot, "failed-validation.json");
    await writeTranscriptValidation(profilePath, validationPath, {
      failedSourceRunId: "clip-2",
      profileSha256: await canonicalProfileSha256(profilePath),
    });

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("record_voice_profile_recording_kit.py"),
    });

    try {
      await execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]);
      throw new Error("expected blocked transcript validation");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      const payload = JSON.parse(stdout);
      const transcriptCheck = payload.checks.find((row: { check: string }) => row.check === "transcript_validation");
      expect(transcriptCheck.details.failed[0]).toMatchObject({
        sourceRunId: "clip-2",
        repairClipId: "profile-clip-02",
        verdict: "fail",
      });
      expect(transcriptCheck.details.failed[0].repairCommand).toContain("scripts/record_voice_profile_recording_kit.py");
      expect(transcriptCheck.details.failed[0].repairCommand).toContain("--clip profile-clip-02");
      expect(transcriptCheck.details.failed[0].repairCommand).toContain("--open-cue-sheet");
      expect(transcriptCheck.details.failed[0].repairCommand).toContain("--overwrite");
      expect(transcriptCheck.details.failed[0].repairCommand).toContain("--check-selected");
    }
  });

  it("rejects stale transcript validation that no longer matches selected clips", async () => {
    const profilePath = await writeProfile();
    const validationPath = path.join(tmpRoot, "stale-validation.json");
    await writeTranscriptValidation(profilePath, validationPath, {
      staleSourceRunId: "clip-2",
      wrongAudioSourceRunId: "clip-3",
    });

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("expected_transcript_mismatch"),
    });

    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        validationPath,
        "--require-transcript-validation",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("audio_path_mismatch"),
    });
  });
});

// @vitest-environment node
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "run_voice_quality_gate.py");

let tmpRoot: string;
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];

async function writeReadyProfile(): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
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
        grade: index === 5 ? "B" : "A",
        durationSec: 7,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    });
  }
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify({
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
      summary: { eligibleClips: 5, selectedClips: 5, rejectedClips: 0, remainingClipsNeeded: 0 },
      diagnostics: { missingCoverageFeatures: [] },
      clips,
      rejectedClips: [],
    }, null, 2)}\n`,
    "utf-8",
  );
  return profilePath;
}

async function writeTranscriptValidation(profilePath: string, sourceRunIds = ["clip-1", "clip-2", "clip-3", "clip-4", "clip-5"]): Promise<string> {
  const validationPath = path.join(path.dirname(profilePath), "transcript-validation.json");
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const clipById = new Map(profile.clips.map((clip) => [clip.sourceRunId, clip]));
  await writeFile(
    validationPath,
    `${JSON.stringify({
      version: 1,
      profile: profilePath,
      status: "pass",
      summary: { total: sourceRunIds.length, passed: sourceRunIds.length, failed: 0 },
      clips: sourceRunIds.map((sourceRunId) => {
        const clip = clipById.get(sourceRunId);
        return {
          sourceRunId,
          expectedTranscript: clip?.transcriptRaw ?? "",
          audioPath: clip?.audioPath ?? "",
          verdict: "pass",
          cer: { rate: 0 },
          wer: { rate: 0 },
        };
      }),
    }, null, 2)}\n`,
    "utf-8",
  );
  return validationPath;
}

async function writeBlockedProfile(): Promise<string> {
  const profileDir = path.join(tmpRoot, "blocked-profile");
  await mkdir(profileDir, { recursive: true });
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify({
      version: 1,
      voiceProfileId: "blocked-test",
      status: "needs_enrollment",
      requirements: {
        minClips: 5,
        maxClips: 10,
        minDurationSec: 6,
        maxDurationSec: 20,
        passingGrades: ["A", "B"],
        requiredCoverageFeatures: coverage,
      },
      summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
      diagnostics: { missingCoverageFeatures: coverage },
      clips: [],
      rejectedClips: [],
    }, null, 2)}\n`,
    "utf-8",
  );
  return profilePath;
}

async function writeFakeSpeakerPython(): Promise<string> {
  const fakePython = path.join(tmpRoot, "fake-speaker-python.py");
  await writeFile(
    fakePython,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "",
      "if '--list-backends' in sys.argv:",
      "    print(json.dumps({",
      "        'version': 1,",
      "        'selectedAutoBackend': 'mfcc-cosine',",
      "        'backends': {",
      "            'mfcc-cosine': {'available': True, 'kind': 'local_proxy', 'reason': 'fake built in'},",
      "            'resemblyzer': {'available': False, 'kind': 'speaker_embedding', 'reason': 'fake missing resemblyzer'},",
      "            'speechbrain-ecapa': {'available': False, 'kind': 'speaker_verification', 'reason': 'fake missing speechbrain'},",
      "        },",
      "    }))",
      "    raise SystemExit(0)",
      "raise SystemExit('fake speaker python only supports --list-backends')",
      "",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakePython, 0o755);
  return fakePython;
}

async function writeFakeAsrPython(): Promise<string> {
  const fakePython = path.join(tmpRoot, "fake-asr-python.py");
  await writeFile(
    fakePython,
    [
      "#!/usr/bin/env python3",
      "from pathlib import Path",
      "import runpy",
      "import sys",
      "",
      "if len(sys.argv) < 2:",
      "    raise SystemExit('fake ASR python expected a script path')",
      "script = Path(sys.argv[1]).resolve()",
      "sys.path.insert(0, str(script.parent))",
      "sys.argv = [str(script), *sys.argv[2:]]",
      "runpy.run_path(str(script), run_name='__main__')",
      "",
    ].join("\n"),
    "utf-8",
  );
  await chmod(fakePython, 0o755);
  return fakePython;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-quality-gate-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("run_voice_quality_gate.py", () => {
  it("runs the full quality-gate pipeline in dry-run mode and writes planning artifacts", async () => {
    const fakeAsrPython = await writeFakeAsrPython();
    const outDir = path.join(tmpRoot, "gate");
    const { stdout } = await execFileAsync(python, [
      script,
      "--dry-run",
      "--out-dir",
      outDir,
      "--asr-python",
      fakeAsrPython,
      "--case",
      "zh_hant_short_identity",
      "--clone-mode",
      "hifi",
      "--repeats",
      "1",
      "--min-speaker-similarity",
      "0.8",
    ]);
    const summary = JSON.parse(stdout);
    const resolvedOutDir = await realpath(outDir);
    expect(summary).toMatchObject({
      status: "planned",
      report: path.join(resolvedOutDir, "report.json"),
      asr: path.join(resolvedOutDir, "asr.json"),
      speaker: path.join(resolvedOutDir, "speaker.json"),
      score: path.join(resolvedOutDir, "score.json"),
    });

    await expect(stat(path.join(outDir, "report.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(outDir, "asr.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(outDir, "speaker.json"))).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(path.join(outDir, "quality-gate.json"))).resolves.toMatchObject({ size: expect.any(Number) });

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    expect(gate.status).toBe("planned");
    expect(gate.inputs).toMatchObject({
      profileJson: null,
      cloneMode: "hifi",
      quality: "balanced",
      repeats: 1,
      synthesisPython: expect.any(String),
      asrPython: fakeAsrPython,
      modelId: "openbmb/VoxCPM2",
      loraPath: null,
      stabilitySeed: 1337,
      skipProfileVerify: false,
      skipTranscriptValidation: false,
      speakerBackend: "auto",
      selectedSpeakerBackend: expect.any(String),
      requireSpeakerBackend: null,
      minSpeakerSimilarity: 0.8,
    });
    expect(["mfcc-cosine", "resemblyzer", "speechbrain-ecapa"]).toContain(gate.inputs.selectedSpeakerBackend);
    expect(gate.proofs).toMatchObject({
      profileVerifyRequired: false,
      profileVerifySkipped: false,
      profileVerifyPassed: true,
      transcriptValidationRequired: false,
      transcriptValidationSkipped: false,
      transcriptValidationPassed: true,
    });
    expect(gate.proofs.speakerBackendRequirement).toMatchObject({
      requested: "auto",
      selected: gate.inputs.selectedSpeakerBackend,
      required: null,
    });
    expect(gate.steps.map((step: { name: string }) => step.name)).toEqual(["regression", "asr", "speaker_similarity"]);
    expect(gate.steps[0].command).toContain("--seed 1337");
    expect(gate.steps[0].command).toContain("--python");
    expect(gate.steps[1].command).toContain(fakeAsrPython);
    expect(gate.steps[1].command).toContain("scripts/transcribe_voice_regression.py");
    expect(gate.commands.score).toContain("scripts/score_voice_regression.py");
    expect(gate.commands.score).toContain("--speaker-json");
    expect(gate.commands.score).toContain("--min-speaker-similarity 0.8");

    const asr = JSON.parse(await readFile(path.join(outDir, "asr.json"), "utf-8"));
    expect(asr).toMatchObject({
      backend: "dry-run",
      dryRun: true,
      summary: { total: 1, transcribed: 0, failed: 0 },
    });

    const speaker = JSON.parse(await readFile(path.join(outDir, "speaker.json"), "utf-8"));
    expect(speaker).toMatchObject({
      backend: "dry-run",
      dryRun: true,
      summary: { total: 1, scored: 0, failed: 0 },
    });
  }, 15_000);

  it("adds paired prompt-to-hifi scoring when both clone modes are rendered", async () => {
    const outDir = path.join(tmpRoot, "gate-both");
    await execFileAsync(python, [
      script,
      "--dry-run",
      "--out-dir",
      outDir,
      "--case",
      "zh_hant_polyphones",
      "--clone-mode",
      "both",
      "--repeats",
      "1",
      "--min-reduction-pct",
      "55",
    ]);

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    expect(gate.commands.score).toContain("--baseline-clone-mode prompt");
    expect(gate.commands.score).toContain("--candidate-clone-mode hifi");
    expect(gate.commands.score).toContain("--min-paired-reduction-pct 55.0");
    expect(gate.commands.score).toContain("--require-paired-improvement");
  });

  it("blocks before rendering when the selected speaker backend does not satisfy the required product backend", async () => {
    const outDir = path.join(tmpRoot, "gate-speaker-backend-blocked");
    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--out-dir",
        outDir,
        "--speaker-backend",
        "mfcc-cosine",
        "--require-speaker-backend",
        "speechbrain-ecapa",
        "--case",
        "zh_hant_short_identity",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status": "speaker_backend_requirement_blocked"'),
    });
    await expect(stat(path.join(outDir, "quality-gate.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks the required product speaker backend with the configured speaker Python", async () => {
    const fakeSpeakerPython = await writeFakeSpeakerPython();
    const outDir = path.join(tmpRoot, "gate-speaker-python-blocked");
    try {
      await execFileAsync(python, [
        script,
        "--dry-run",
        "--out-dir",
        outDir,
        "--speaker-python",
        fakeSpeakerPython,
        "--speaker-backend",
        "auto",
        "--require-speaker-backend",
        "speechbrain-ecapa",
        "--case",
        "zh_hant_short_identity",
      ]);
      throw new Error("expected speaker backend requirement to block");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(2);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload).toMatchObject({
        status: "speaker_backend_requirement_blocked",
        speakerBackendRequirement: {
          requested: "auto",
          selected: "mfcc-cosine",
          required: "speechbrain-ecapa",
          speakerPython: fakeSpeakerPython,
          availability: {
            "speechbrain-ecapa": {
              available: false,
              reason: "fake missing speechbrain",
            },
          },
        },
      });
    }
    await expect(stat(path.join(outDir, "quality-gate.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not treat planned transcript validation as profile regression proof", async () => {
    const profilePath = await writeReadyProfile();
    const fakeAsrPython = await writeFakeAsrPython();
    const outDir = path.join(tmpRoot, "gate-profile");
    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--out-dir",
        outDir,
        "--profile-json",
        profilePath,
        "--asr-python",
        fakeAsrPython,
        "--case",
        "zh_hant_short_identity",
        "--repeats",
        "1",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "failed"'),
    });

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    const resolvedOutDir = await realpath(outDir);
    expect(gate.status).toBe("failed");
    expect(gate.inputs.profileJson).toContain(path.join("profile", "profile.json"));
    expect(gate.inputs).toMatchObject({
      skipProfileVerify: false,
      skipTranscriptValidation: false,
      asrPython: fakeAsrPython,
    });
    expect(gate.proofs).toMatchObject({
      profileVerifyRequired: true,
      profileVerifySkipped: false,
      profileVerifyPassed: true,
      transcriptValidationRequired: true,
      transcriptValidationSkipped: false,
      transcriptValidationPassed: false,
    });
    expect(gate.inputs.transcriptValidationJson).toBe(path.join(resolvedOutDir, "profile-transcript-validation.json"));
    expect(gate.steps.map((step: { name: string }) => step.name)).toEqual([
      "profile_verify",
      "profile_transcript_validation",
      "regression",
    ]);
    expect(gate.paths.profileTranscriptValidation).toBe(path.join(resolvedOutDir, "profile-transcript-validation.json"));
    expect(gate.steps[1].command).toContain(fakeAsrPython);
    expect(gate.steps[1].command).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(gate.steps[1].command).toContain("--dry-run");
    expect(gate.steps[2].stderr).toContain("transcript validation JSON must pass before profile regression");
  });

  it("uses supplied passing transcript validation before profile-based dry-run regression", async () => {
    const profilePath = await writeReadyProfile();
    const transcriptValidation = await writeTranscriptValidation(profilePath);
    const outDir = path.join(tmpRoot, "gate-profile-ready");
    await execFileAsync(python, [
      script,
      "--dry-run",
      "--out-dir",
      outDir,
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--case",
      "zh_hant_short_identity",
      "--repeats",
      "1",
    ]);

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    expect(gate.status).toBe("planned");
    expect(gate.inputs.transcriptValidationJson).toBe(await realpath(transcriptValidation));
    expect(gate.proofs).toMatchObject({
      transcriptValidationPassed: true,
      strictProfileProofRequired: true,
      strictProfileProofPassed: true,
    });
    expect(gate.steps.map((step: { name: string }) => step.name)).toEqual([
      "profile_verify",
      "regression",
      "asr",
      "speaker_similarity",
    ]);
    expect(gate.steps[1].command).toContain("--transcript-validation-json");
  });

  it("records skipped profile proof flags in the quality-gate report", async () => {
    const profilePath = await writeReadyProfile();
    const outDir = path.join(tmpRoot, "gate-profile-skipped");
    await execFileAsync(python, [
      script,
      "--dry-run",
      "--out-dir",
      outDir,
      "--profile-json",
      profilePath,
      "--skip-transcript-validation",
      "--allow-unsafe-profile-gate-bypass",
      "--unsafe-profile-gate-bypass-reason",
      "migration fixture already validated elsewhere",
      "--case",
      "zh_hant_short_identity",
      "--repeats",
      "1",
    ]);

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    expect(gate.inputs).toMatchObject({
      skipProfileVerify: false,
      skipTranscriptValidation: true,
      profileGateBypass: {
        requested: ["transcript_validation"],
        acceptedUnsafeBypass: true,
        reason: "migration fixture already validated elsewhere",
      },
    });
    expect(gate.proofs).toMatchObject({
      profileVerifyRequired: true,
      profileVerifySkipped: false,
      profileVerifyPassed: true,
      transcriptValidationRequired: false,
      transcriptValidationSkipped: true,
      transcriptValidationPassed: false,
    });
    expect(gate.steps.map((step: { name: string }) => step.name)).not.toContain("profile_transcript_validation");
  });

  it("blocks skipped profile proof gates unless the unsafe bypass is acknowledged", async () => {
    const profilePath = await writeReadyProfile();
    const outDir = path.join(tmpRoot, "gate-profile-skip-blocked");
    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--out-dir",
        outDir,
        "--profile-json",
        profilePath,
        "--skip-profile-verify",
        "--skip-transcript-validation",
        "--case",
        "zh_hant_short_identity",
        "--repeats",
        "1",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "unsafe_profile_gate_bypass_blocked"'),
    });
    await expect(stat(path.join(outDir, "quality-gate.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops at basic profile readiness before transcript validation when the profile has no clips", async () => {
    const profilePath = await writeBlockedProfile();
    const outDir = path.join(tmpRoot, "gate-blocked-profile");
    await expect(
      execFileAsync(python, [
        script,
        "--dry-run",
        "--out-dir",
        outDir,
        "--profile-json",
        profilePath,
        "--case",
        "zh_hant_short_identity",
        "--repeats",
        "1",
      ]),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "failed"'),
    });

    const gate = JSON.parse(await readFile(path.join(outDir, "quality-gate.json"), "utf-8"));
    expect(gate.steps.map((step: { name: string }) => step.name)).toEqual(["profile_verify"]);
    expect(gate.steps[0].stdout).toContain('"selectedClips": 0');
  });
});

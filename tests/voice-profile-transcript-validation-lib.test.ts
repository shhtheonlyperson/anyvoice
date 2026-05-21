// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateVoiceProfileTranscripts } from "@/lib/voice-profile-transcript-validation";

const originalEnv = { ...process.env };
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];
let tmpRoot: string;
let profileRoot: string;

async function writeProfile(): Promise<string> {
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
        diagnostics: { missingCoverageFeatures: [] },
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

async function writeFakePython(): Promise<string> {
  const fakePython = path.join(tmpRoot, "fake-asr-python.py");
  await writeFile(
    fakePython,
    [
      "#!/usr/bin/env python3",
      "from pathlib import Path",
      "import os",
      "import runpy",
      "import sys",
      "",
      "marker = os.environ.get('ANYVOICE_FAKE_ASR_MARKER')",
      "if marker:",
      "    Path(marker).write_text(sys.argv[0] + '\\n', encoding='utf-8')",
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
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-transcript-validation-lib-"));
  profileRoot = path.join(tmpRoot, "voices");
  process.env.ANYVOICE_VOICE_PROFILE_ROOT = profileRoot;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("validateVoiceProfileTranscripts", () => {
  it("parses blocked script output from external ASR validation as a normal report", async () => {
    await writeProfile();
    const asrPath = path.join(tmpRoot, "asr.json");
    await writeFile(
      asrPath,
      `${JSON.stringify({
        transcripts: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`clip-${index + 1}`, "完全不相符的逐字稿"])),
      })}\n`,
      "utf-8",
    );
    const report = await validateVoiceProfileTranscripts({ profileId: "local-test", asrJson: asrPath });
    expect(report).toMatchObject({
      status: "blocked",
      total: 5,
      passed: 0,
      failed: 5,
      backend: "external-asr",
    });
    expect(report.validationJson).toContain("voice-profile-transcript-validation");
  });

  it("passes when an external ASR report matches the selected profile transcripts", async () => {
    await writeProfile();
    const asrPath = path.join(tmpRoot, "matching-asr.json");
    await writeFile(
      asrPath,
      `${JSON.stringify({
        transcripts: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `clip-${index + 1}`,
            `這是第 ${index + 1} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
          ]),
        ),
      })}\n`,
      "utf-8",
    );
    const report = await validateVoiceProfileTranscripts({ profileId: "local-test", asrJson: asrPath });
    expect(report).toMatchObject({
      status: "pass",
      total: 5,
      passed: 5,
      failed: 0,
      backend: "external-asr",
    });
  });

  it("uses ANYVOICE_ASR_PYTHON for localhost transcript validation", async () => {
    await writeProfile();
    const asrPath = path.join(tmpRoot, "matching-asr.json");
    const markerPath = path.join(tmpRoot, "fake-asr-marker.txt");
    const fakePython = await writeFakePython();
    process.env.ANYVOICE_ASR_PYTHON = fakePython;
    process.env.ANYVOICE_FAKE_ASR_MARKER = markerPath;
    await writeFile(
      asrPath,
      `${JSON.stringify({
        transcripts: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `clip-${index + 1}`,
            `這是第 ${index + 1} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
          ]),
        ),
      })}\n`,
      "utf-8",
    );

    const report = await validateVoiceProfileTranscripts({ profileId: "local-test", asrJson: asrPath });
    expect(report.status).toBe("pass");
    expect((await readFile(markerPath, "utf-8")).trim()).toBe(fakePython);
  });

  it("rejects unsafe profile ids before invoking the validation script", async () => {
    await expect(validateVoiceProfileTranscripts({ profileId: "../bad" })).rejects.toThrow(
      "profileId must contain only letters, numbers, dash, or underscore",
    );
  });
});

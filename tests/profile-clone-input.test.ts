// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCloneInputError } from "@/lib/clone-request";
import { parseCloneFormWithProfile, wantsVoiceProfile } from "@/lib/profile-clone-input";
import { persistVoiceProfileManifest, voiceProfileManifestPath, type VoiceProfileSummary } from "@/lib/voice-profile";

let tmpRoot: string;
let profileRoot: string;
let transcriptValidationRoot: string;
const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalProfileRoot = process.env.ANYVOICE_VOICE_PROFILE_ROOT;
const originalTranscriptValidationRoot = process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT;
const profileTranscriptFixtures = [
  "請用繁體中文錄製穩定聲音。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

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
    expect(input.body.message).toMatch(/Traditional Chinese/);
  });

  it("rejects common Simplified-only target phrasing before profile lookup", async () => {
    const input = await parseCloneFormWithProfile(profileForm({ targetText: "我想说话。" }));
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(400);
    expect(input.body.message).toMatch(/Traditional Chinese/);
  });

  it("rejects unproven Chinese target text for profile generation", async () => {
    const input = await parseCloneFormWithProfile(profileForm({ targetText: "中文音色自然。" }));
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(400);
    expect(input.body.message).toMatch(/unproven Chinese/);
  });

  it("rejects a ready summary until the strict profile check passes", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/strict check/);
  });

  it("rejects profile generation when transcript validation fails", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await writeRun(`run-${index}`, {
        transcript: profileTranscriptFixtures[index - 1],
        durationSec: 12 - index,
      });
    }
    await writeStrictReadyProfile({ validationStatus: "blocked" });

    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/transcript validation|ASR/i);
  });

  it("rejects profile use until enough eligible clips exist", async () => {
    await writeRun("only-one");
    const input = await parseCloneFormWithProfile(profileForm());
    expect(isCloneInputError(input)).toBe(true);
    if (!isCloneInputError(input)) throw new Error("expected error");
    expect(input.statusCode).toBe(409);
    expect(input.body.message).toMatch(/not ready/);
  });
});

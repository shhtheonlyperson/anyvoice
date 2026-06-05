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
const script = path.join(process.cwd(), "scripts", "prepare_voice_backend_shootout.py");
const registerScript = path.join(process.cwd(), "scripts", "register_voice_backend_renders.py");

type TextPreparation = {
  targetText: {
    model: string;
  };
};

type ShootoutJob = {
  backend: string;
  caseId: string;
  rendererStatus: string;
  commandTemplateSource: string;
  commandTemplateEnv?: string | null;
  referenceAudio: string;
  targetTextRaw: string;
  targetText: string;
  textPrepFile: string;
  outputWav: string;
  command: string;
  stabilitySeed?: number | null;
};

type ShootoutManifestRender = {
  backend: string;
  caseId: string;
  repeat: number;
  referenceAudio: string;
  promptTextFile: string;
  profileClipId?: string;
  voiceProfileId?: string;
  textPreparation: TextPreparation;
  stabilitySeed?: number | null;
};

let tmpRoot: string;
const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-backend-shootout-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

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

async function writeTranscriptValidation(
  profilePath: string,
  sourceRunIds: string[],
  {
    status = "pass",
    failedSourceRunId = "",
    profileSha256,
    staleSourceRunId = "",
  }: { status?: string; failedSourceRunId?: string; profileSha256?: string; staleSourceRunId?: string } = {},
): Promise<string> {
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
      profileSha256: profileSha256 ?? (await canonicalProfileSha256(profilePath)),
      status,
      summary: {
        total: sourceRunIds.length,
        passed: sourceRunIds.filter((id) => id !== failedSourceRunId).length,
        failed: failedSourceRunId ? 1 : 0,
      },
      clips: sourceRunIds.map((sourceRunId) => {
        const clip = clipById.get(sourceRunId);
        return {
          sourceRunId,
          expectedTranscript:
            sourceRunId === staleSourceRunId ? `${clip?.transcriptRaw ?? ""} stale` : clip?.transcriptRaw ?? "",
          audioPath: clip?.audioPath ?? "",
          verdict: sourceRunId === failedSourceRunId ? "fail" : "pass",
          cer: { rate: sourceRunId === failedSourceRunId ? 0.5 : 0 },
          wer: { rate: sourceRunId === failedSourceRunId ? 0.5 : 0 },
        };
      }),
    }, null, 2)}\n`,
    "utf-8",
  );
  return validationPath;
}

async function writeReadyProfile(name = "profile"): Promise<{ profilePath: string; sourceRunIds: string[] }> {
  const profileDir = path.join(tmpRoot, name);
  await mkdir(profileDir, { recursive: true });
  const sourceRunIds = Array.from({ length: 5 }, (_, index) => `clip-${index + 1}`);
  const clips = [];
  for (let index = 0; index < sourceRunIds.length; index += 1) {
    const sourceRunId = sourceRunIds[index];
    const audioPath = path.join(profileDir, `${sourceRunId}.wav`);
    await writeFile(audioPath, Buffer.from([index + 1, index + 2, index + 3]));
    clips.push({
      sourceRunId,
      audioPath,
      transcriptRaw: "如果遇到重要名字，例如 Brenda、AnyVoice、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。二零二六年五月十九日。",
      transcriptScript: "zh_hant",
      coverageFeatures: coverage,
      sourceKind: "scripted",
      quality: {
        grade: index === sourceRunIds.length - 1 ? "B" : "A",
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
      voiceProfileId: "local-default",
      status: "ready",
      requirements: {
        minClips: 5,
        maxClips: 10,
        minDurationSec: 6,
        maxDurationSec: 20,
        passingGrades: ["A", "B"],
        requiredCoverageFeatures: coverage,
      },
      summary: { selectedClips: 5, eligibleClips: 5, rejectedClips: 0, remainingClipsNeeded: 0 },
      diagnostics: { missingCoverageFeatures: [] },
      referenceClipIds: sourceRunIds,
      preferredPromptClipId: sourceRunIds[0],
      clips,
      rejectedClips: [],
      loraPath: null,
    }, null, 2)}\n`,
    "utf-8",
  );
  return { profilePath, sourceRunIds };
}

describe("prepare_voice_backend_shootout.py", () => {
  it("creates an executable render plan and register manifest for external backends", async () => {
    const reference = path.join(tmpRoot, "reference.wav");
    await writeFile(reference, Buffer.from([1, 2, 3]));
    const resolvedReference = await realpath(reference);
    const outDir = path.join(tmpRoot, "shootout");
    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "indextts2",
      "--case",
      "zh_hant_polyphones",
      "--repeats",
      "2",
      "--reference-audio",
      reference,
      "--prompt-text",
      "這是參考音逐字稿。",
      "--command-template",
      "python render.py --backend {backend} --text-file {target_text_file} --reference {reference_audio} --prompt {prompt_text_file} --seed {seed} --out {output_wav}",
      "--out-dir",
      outDir,
    ]);
    const payload = JSON.parse(stdout) as {
      manifest: string;
      jobs: string;
      renderScript: string;
      readme: string;
      renders: number;
      rendererStatus: string;
      nextCommands: {
        rendererPreflight: string;
        registerDryRun: string;
        scoreCandidates: Record<string, string>;
        selectCandidates: Record<string, string>;
      };
    };
    expect(payload.renders).toBe(2);
    expect(payload.rendererStatus).toBe("ready");

    const jobs = JSON.parse(await readFile(payload.jobs, "utf-8")) as { jobs: ShootoutJob[] };
    expect(jobs.jobs).toHaveLength(2);
    expect(jobs.jobs[0]).toMatchObject({
      backend: "indextts2",
      caseId: "zh_hant_polyphones",
      rendererStatus: "ready",
      commandTemplateSource: "cli",
      referenceAudio: resolvedReference,
    });
    expect(jobs.jobs[0].targetTextRaw).toContain("重慶、銀行");
    expect(jobs.jobs[0].targetText).toContain("重 慶、銀 行");
    expect(jobs.jobs[0]).toMatchObject({ stabilitySeed: 1337 });
    expect(jobs.jobs[0].textPrepFile).toMatch(/text-prep\.json$/);
    expect(jobs.jobs[0].command).toContain("python render.py");
    expect(jobs.jobs[0].command).toContain("--seed 1337");
    expect(jobs.jobs[0].command).toContain("--out");

    const manifest = JSON.parse(await readFile(payload.manifest, "utf-8")) as { renders: ShootoutManifestRender[] };
    expect(manifest.renders).toHaveLength(2);
    expect(manifest.renders[0]).toMatchObject({
      backend: "indextts2",
      caseId: "zh_hant_polyphones",
      repeat: 1,
      referenceAudio: resolvedReference,
      stabilitySeed: 1337,
    });
    expect(manifest.renders[0].textPreparation.targetText.model).toContain("重 慶、銀 行");

    const renderScript = await readFile(payload.renderScript, "utf-8");
    expect(renderScript).toContain("set -euo pipefail");
    expect(renderScript).toContain("python render.py");

    const register = await execFileAsync(python, [
      registerScript,
      payload.manifest,
      "--dry-run",
      "--out-dir",
      path.join(tmpRoot, "registered"),
    ]);
    const registerPayload = JSON.parse(register.stdout);
    expect(registerPayload).toMatchObject({ groups: 1, renders: 2 });
    const registeredReport = JSON.parse(await readFile(registerPayload.report, "utf-8"));
    expect(registeredReport.groups[0].renders[0].textPreparation.targetText.model).toContain("重 慶、銀 行");
    expect(registeredReport.groups[0].renders[0].targetTextRawFile).toMatch(/raw\.txt$/);
    expect(payload.nextCommands.registerDryRun).toContain("register_voice_backend_renders.py");
    expect(payload.nextCommands.rendererPreflight).toContain("render_voice_backend_job.py --preflight --manifest");
    expect(payload.nextCommands.scoreCandidates.indextts2).toContain("score_voice_regression.py");
    expect(payload.nextCommands.scoreCandidates.indextts2).toContain("--baseline-clone-mode voxcpm2-hifi");
    expect(payload.nextCommands.scoreCandidates.indextts2).toContain("--candidate-clone-mode indextts2");
    expect(payload.nextCommands.selectCandidates.indextts2).toContain("select_voice_backend_candidate.py");
    expect(payload.nextCommands.selectCandidates.indextts2).toContain("--candidate-clone-mode indextts2");
    expect(await readFile(payload.readme, "utf-8")).toContain("## Select Candidate");
  });

  it("turns no-template plans into fail-clear env-template render scripts", async () => {
    const reference = path.join(tmpRoot, "reference.wav");
    await writeFile(reference, Buffer.from([1, 2, 3]));
    const outDir = path.join(tmpRoot, "runtime-template-shootout");
    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "indextts2",
      "--case",
      "zh_hant_polyphones",
      "--repeats",
      "1",
      "--reference-audio",
      reference,
      "--prompt-text",
      "這是參考音逐字稿。",
      "--out-dir",
      outDir,
    ]);
    const payload = JSON.parse(stdout) as {
      jobs: string;
      renderScript: string;
      rendererStatus: string;
      rendererCommandEnv: string;
    };
    expect(payload.rendererStatus).toBe("needs_renderer_command");
    expect(payload.rendererCommandEnv).toBe("ANYVOICE_BACKEND_RENDER_COMMAND");

    const jobs = JSON.parse(await readFile(payload.jobs, "utf-8")) as { jobs: ShootoutJob[] };
    expect(jobs.jobs[0]).toMatchObject({
      rendererStatus: "needs_renderer_command",
      commandTemplateSource: "runtime_env",
      commandTemplateEnv: "ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2",
      commandTemplateFallbackEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
      command: "runtime-env:ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2|ANYVOICE_BACKEND_RENDER_COMMAND",
    });

    const renderScript = await readFile(payload.renderScript, "utf-8");
    expect(renderScript).toContain("ANYVOICE_BACKEND_RENDER_COMMAND");
    expect(renderScript).toContain("ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2");
    expect(renderScript).toContain("skip existing");
    expect(renderScript).toContain("seed");
    expect(renderScript).toContain("return 64");
    const readme = await readFile(path.join(outDir, "README.md"), "utf-8");
    expect(readme).toContain("render_voice_backend_job.py --preflight --manifest");
    expect(readme).toContain("scripts/render_voice_backend_job.py");
    expect(readme).toContain("--skip-unsupported");
    expect(readme).toContain("ANYVOICE_BACKEND_RENDER_COMMAND_VOXCPM2_HIFI='python3 scripts/render_voice_backend_job.py");
    expect(readme).toContain("ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2");

    await expect(execFileAsync("bash", [payload.renderScript])).rejects.toMatchObject({
      code: 64,
      stderr: expect.stringContaining("ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2"),
    });

    await execFileAsync("bash", [payload.renderScript], {
      env: {
        ...process.env,
        ANYVOICE_BACKEND_RENDER_COMMAND: `${python} -c "from pathlib import Path; import sys; Path(sys.argv[4]).write_bytes(b'RIFF')" {target_text_file} {reference_audio} {prompt_text_file} {output_wav}`,
      },
    });
    expect(await readFile(jobs.jobs[0].outputWav, "utf-8")).toBe("RIFF");
    await execFileAsync("bash", [payload.renderScript], {
      env: {
        ...process.env,
        ANYVOICE_BACKEND_RENDER_COMMAND_INDEXTTS2: `${python} -c "raise SystemExit('should have skipped existing output')" {target_text_file} {reference_audio} {prompt_text_file} {output_wav}`,
      },
    });
    expect(await readFile(jobs.jobs[0].outputWav, "utf-8")).toBe("RIFF");
  });

  it("passes eval-case custom pronunciation repairs into external backend targets", async () => {
    const reference = path.join(tmpRoot, "reference.wav");
    const evalPath = path.join(tmpRoot, "repair-eval.json");
    await writeFile(reference, Buffer.from([1, 2, 3]));
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "repair-case",
            text: "請讓行長和長樂的讀法固定。",
            pronunciationOverrides: ["pinyin:行長=xing2 zhang3", "長樂[reading]=chang2 le4"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "indextts2",
      "--eval-set",
      evalPath,
      "--case",
      "repair-case",
      "--repeats",
      "1",
      "--reference-audio",
      reference,
      "--prompt-text",
      "這是參考音逐字稿。",
      "--out-dir",
      path.join(tmpRoot, "repair-shootout"),
    ]);

    const payload = JSON.parse(stdout) as { jobs: string; manifest: string };
    const jobs = JSON.parse(await readFile(payload.jobs, "utf-8")) as { jobs: ShootoutJob[] };
    expect(jobs.jobs[0].targetTextRaw).toBe("請讓行長和長樂的讀法固定。");
    expect(jobs.jobs[0].targetText).toBe("請讓xing2 zhang3和chang2 le4的讀法固定。");

    const manifest = JSON.parse(await readFile(payload.manifest, "utf-8")) as { renders: ShootoutManifestRender[] };
    expect(manifest.renders[0].textPreparation.targetText.model).toBe(
      "請讓xing2 zhang3和chang2 le4的讀法固定。",
    );
  });

  it("rejects renderer command templates that cannot produce planned WAVs", async () => {
    const reference = path.join(tmpRoot, "reference.wav");
    await writeFile(reference, Buffer.from([1, 2, 3]));

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "indextts2",
        "--case",
        "zh_hant_polyphones",
        "--repeats",
        "1",
        "--reference-audio",
        reference,
        "--prompt-text",
        "這是參考音逐字稿。",
        "--command-template",
        "python render.py --text-file {target_text_file} --reference {reference_audio}",
        "--out-dir",
        path.join(tmpRoot, "bad-template-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("{output_wav}"),
    });
  });

  it("rejects renderer command templates that omit the exact prompt transcript file", async () => {
    const reference = path.join(tmpRoot, "reference.wav");
    await writeFile(reference, Buffer.from([1, 2, 3]));

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "indextts2",
        "--case",
        "zh_hant_polyphones",
        "--repeats",
        "1",
        "--reference-audio",
        reference,
        "--prompt-text",
        "這是參考音逐字稿。",
        "--command-template",
        "python render.py --text-file {target_text_file} --reference {reference_audio} --out {output_wav}",
        "--out-dir",
        path.join(tmpRoot, "missing-prompt-template-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("{prompt_text_file}"),
    });
  });

  it("can build the shootout plan from a ready voice profile", async () => {
    const { profilePath, sourceRunIds } = await writeReadyProfile();
    const resolvedClipAudio = await realpath(path.join(path.dirname(profilePath), "clip-1.wav"));
    const transcriptValidation = await writeTranscriptValidation(profilePath, sourceRunIds);

    const { stdout } = await execFileAsync(python, [
      script,
      "--backend",
      "f5-tts",
      "--profile-json",
      profilePath,
      "--transcript-validation-json",
      transcriptValidation,
      "--case",
      "mixed_en_zh_models",
      "--repeats",
      "1",
      "--dry-run",
      "--out-dir",
      path.join(tmpRoot, "profile-shootout"),
    ]);
    const payload = JSON.parse(stdout) as { manifest: string; renders: number; transcriptValidationJson: string };
    expect(payload.renders).toBe(1);
    expect(payload.transcriptValidationJson).toBe(await realpath(transcriptValidation));

    const manifest = JSON.parse(await readFile(payload.manifest, "utf-8")) as { renders: ShootoutManifestRender[] };
    expect(manifest.renders[0]).toMatchObject({
      backend: "f5-tts",
      caseId: "mixed_en_zh_models",
      profileClipId: "clip-1",
      voiceProfileId: "local-default",
      referenceAudio: resolvedClipAudio,
    });
    expect(manifest.renders[0].textPreparation.targetText.model).toContain("Any Voice");
    const prompt = await readFile(manifest.renders[0].promptTextFile, "utf-8");
    expect(prompt).toContain("AnyVoice");
  });

  it("requires strict profile readiness before profile backend shootouts", async () => {
    const clipAudio = path.join(tmpRoot, "single-clip.wav");
    const profilePath = path.join(tmpRoot, "single-profile.json");
    await writeFile(clipAudio, Buffer.from([1, 2, 3]));
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-default",
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: clipAudio,
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
            sourceKind: "scripted",
            coverageFeatures: ["zh_hant"],
            quality: { grade: "A", durationSec: 8, warnings: [] },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const transcriptValidation = await writeTranscriptValidation(profilePath, ["clip-1"]);

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--case",
        "mixed_en_zh_models",
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "single-profile-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires strict ready profile proof"),
    });
  });

  it("requires passing transcript validation before profile backend shootouts", async () => {
    const clipAudio = path.join(tmpRoot, "clip.wav");
    const profilePath = path.join(tmpRoot, "validation-profile.json");
    await writeFile(clipAudio, Buffer.from([1, 2, 3]));
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-default",
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: clipAudio,
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
            quality: { grade: "A", durationSec: 8, warnings: [] },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--case",
        "zh_hant_polyphones",
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "missing-validation-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON not found"),
    });

    const failedValidation = await writeTranscriptValidation(profilePath, ["clip-1"], {
      status: "fail",
      failedSourceRunId: "clip-1",
    });
    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        failedValidation,
        "--case",
        "zh_hant_polyphones",
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "failed-validation-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON must pass"),
    });
  });

  it("rejects transcript validation JSON with stale profile hash evidence", async () => {
    const { profilePath, sourceRunIds } = await writeReadyProfile("stale-validation-hash-profile");
    const transcriptValidation = await writeTranscriptValidation(profilePath, sourceRunIds, {
      profileSha256: "0".repeat(64),
    });

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--case",
        "mixed_en_zh_models",
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "stale-validation-hash-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON is stale for this profile"),
    });
  });

  it("rejects transcript validation JSON with stale selected clip rows", async () => {
    const { profilePath, sourceRunIds } = await writeReadyProfile("stale-validation-row-profile");
    const transcriptValidation = await writeTranscriptValidation(profilePath, sourceRunIds, {
      staleSourceRunId: sourceRunIds[0],
    });

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--transcript-validation-json",
        transcriptValidation,
        "--case",
        "mixed_en_zh_models",
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "stale-validation-row-shootout"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("transcript validation JSON rows do not match the selected profile clips"),
    });
  });

  it("rejects Simplified or mixed Chinese eval cases for profile backend shootouts", async () => {
    const clipAudio = path.join(tmpRoot, "clip.wav");
    const profilePath = path.join(tmpRoot, "profile.json");
    await writeFile(clipAudio, Buffer.from([1, 2, 3]));
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-default",
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: clipAudio,
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
            quality: { grade: "A", durationSec: 8, warnings: [] },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const evalPath = path.join(tmpRoot, "eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "simplified-polyphone",
            text: "请用我的声音说银行和重庆。",
            tags: ["polyphone"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--eval-set",
        evalPath,
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "profile-shootout-blocked"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires clear Traditional Chinese target text"),
    });
  });

  it("rejects Simplified speech-marker target cases for profile backend shootouts", async () => {
    const clipAudio = path.join(tmpRoot, "speech-clip.wav");
    const profilePath = path.join(tmpRoot, "speech-profile.json");
    await writeFile(clipAudio, Buffer.from([1, 2, 3]));
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "ready",
        voiceProfileId: "local-default",
        summary: { selectedClips: 1, eligibleClips: 1, remainingClipsNeeded: 0 },
        clips: [
          {
            sourceRunId: "clip-1",
            audioPath: clipAudio,
            transcriptRaw: "請用繁體中文錄製穩定聲音。",
            transcriptScript: "zh_hant",
            quality: { grade: "A", durationSec: 8, warnings: [] },
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    const evalPath = path.join(tmpRoot, "speech-eval.json");
    await writeFile(
      evalPath,
      `${JSON.stringify({
        cases: [
          {
            id: "simplified-speech-marker",
            text: "我想说话。",
            tags: ["script-risk"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "f5-tts",
        "--profile-json",
        profilePath,
        "--eval-set",
        evalPath,
        "--dry-run",
        "--out-dir",
        path.join(tmpRoot, "speech-shootout-blocked"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires clear Traditional Chinese target text"),
    });
  });

  it("refuses unready profiles so backend shootouts cannot use draft evidence", async () => {
    const profilePath = path.join(tmpRoot, "profile.json");
    await writeFile(
      profilePath,
      `${JSON.stringify({
        status: "needs_enrollment",
        summary: { selectedClips: 0, eligibleClips: 0, remainingClipsNeeded: 5 },
        clips: [],
      })}\n`,
      "utf-8",
    );

    await expect(
      execFileAsync(python, [
        script,
        "--backend",
        "indextts2",
        "--profile-json",
        profilePath,
        "--case",
        "zh_hant_polyphones",
        "--out-dir",
        tmpRoot,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("voice profile is not ready"),
    });
  });
});

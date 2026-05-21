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
const script = path.join(process.cwd(), "scripts", "audit_voice_clone_goal.py");

let tmpRoot: string;

const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
  "今天的任務有三件事：整理想法、確認細節，最後用清楚的語氣說出結論。",
  "我可能會先停一下，再補充一句：這不是急著完成，而是要把每個字都說準。",
  "遇到英文或產品名稱時，例如 OpenAI、Mac Studio、VoxCPM2 和 TestFlight，我會用平常說話的方式讀出來。",
  "請注意多音字：重慶、行長、長樂、角色和音樂，都要保持固定讀法，不要忽快忽慢。",
  "最後這段用比較放鬆的語氣收尾。如果聲音穩定、停頓自然，數位分身才會更像本人。",
];

const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function blindOrderKey(caseId: string, repeat: number, cloneMode: string, outputWav: string): string {
  return createHash("sha256").update(`${caseId}\0${repeat}\0${cloneMode}\0${outputWav}`, "utf8").digest("hex");
}

function candidateLabel(caseId: string, repeat: number): string {
  const samples = [
    { cloneMode: "prompt", outputWav: `prompt-r${String(repeat).padStart(2, "0")}.wav` },
    { cloneMode: "hifi", outputWav: `hifi-r${String(repeat).padStart(2, "0")}.wav` },
  ].sort((a, b) =>
    blindOrderKey(caseId, repeat, a.cloneMode, a.outputWav).localeCompare(
      blindOrderKey(caseId, repeat, b.cloneMode, b.outputWav),
    ),
  );
  return samples.findIndex((sample) => sample.cloneMode === "hifi") === 0 ? "A" : "B";
}

function proofBackendEnv({ asr = true, speaker = true } = {}): Record<string, string> {
  return {
    ANYVOICE_ASR_BACKENDS_JSON: JSON.stringify({
      backends: {
        "faster-whisper": {
          available: asr,
          kind: "local_asr",
          reason: asr ? "test backend ready" : "test backend missing",
        },
      },
      selectedAutoBackend: asr ? "faster-whisper" : null,
      version: 1,
    }),
    ANYVOICE_SPEAKER_BACKENDS_JSON: JSON.stringify({
      backends: {
        "mfcc-cosine": {
          available: true,
          kind: "local_proxy",
          reason: "built in MFCC cosine scorer",
        },
        "speechbrain-ecapa": {
          available: speaker,
          kind: "speaker_verification",
          reason: speaker ? "test backend ready" : "test backend missing",
        },
      },
      selectedAutoBackend: speaker ? "speechbrain-ecapa" : "mfcc-cosine",
      version: 1,
    }),
  };
}

function wavBuffer(durationSec: number): Buffer {
  const sampleRate = 8000;
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(index % 2 === 0 ? 9000 : -9000, 44 + index * 2);
  }
  return buffer;
}

async function writeKit({ count = transcripts.length }: { count?: number } = {}): Promise<string> {
  const kitDir = path.join(tmpRoot, "kit");
  const recordingsDir = path.join(kitDir, "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const file = `profile-clip-${suffix}.wav`;
    await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
    clips.push({
      id: `profile-clip-${suffix}`,
      audioPath: `recordings/${file}`,
      transcript: transcripts[index],
      coverageFeatures: coverage,
      sourceKind: "scripted",
    });
  }
  const manifest = path.join(kitDir, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");
  await writeFile(path.join(kitDir, "cue-sheet.html"), "<!doctype html>\n", "utf-8");
  return manifest;
}

async function writeReadyProfile({ count = transcripts.length }: { count?: number } = {}): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const clips = [];
  for (let index = 0; index < count; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index + 1}.wav`);
    await writeFile(audioPath, wavBuffer(7 + index));
    clips.push({
      sourceRunId: `clip-${index + 1}`,
      audioPath,
      transcriptRaw: transcripts[index],
      transcriptScript: "zh_hant",
      coverageFeatures: coverage,
      sourceKind: "scripted",
      quality: {
        grade: index === 4 ? "B" : "A",
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
        summary: { eligibleClips: clips.length, selectedClips: clips.length, rejectedClips: 0, remainingClipsNeeded: 0 },
        preferredPromptClipId: "clip-1",
        referenceClipIds: clips.map((clip) => clip.sourceRunId),
        diagnostics: { missingCoverageFeatures: [] },
        loraPath: null,
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

async function writeTranscriptValidation(profilePath: string): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const validation = path.join(path.dirname(profilePath), "transcript-validation.json");
  await writeFile(
    validation,
    `${JSON.stringify(
      {
        profile: profilePath,
        status: "pass",
        summary: { total: profile.clips.length, passed: profile.clips.length, failed: 0 },
        clips: profile.clips.map((clip) => ({
          sourceRunId: clip.sourceRunId,
          expectedTranscript: clip.transcriptRaw,
          audioPath: clip.audioPath,
          verdict: "pass",
          cer: { rate: 0 },
          wer: { rate: 0 },
        })),
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return validation;
}

async function writeQualityGate(profilePath: string, mode: "hifi" | "both", createdAt: string): Promise<string> {
  const gateDir = path.join(tmpRoot, "quality-gates", mode);
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  const reportPath = path.join(gateDir, "report.json");
  if (mode === "both") {
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          version: 1,
          groups: [
            {
              cloneMode: "prompt",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [1, 2, 3, 4, 5].map((repeat) => ({
                repeat,
                status: "ready",
                outputWav: `prompt-r${String(repeat).padStart(2, "0")}.wav`,
              })),
            },
            {
              cloneMode: "hifi",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [1, 2, 3, 4, 5].map((repeat) => ({
                repeat,
                status: "ready",
                outputWav: `hifi-r${String(repeat).padStart(2, "0")}.wav`,
              })),
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
  await writeFile(
    gatePath,
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        status: "pass",
        dryRun: false,
        inputs: {
          profileJson: profilePath,
          cloneMode: mode,
          requireSpeakerBackend: mode === "both" ? "speechbrain-ecapa" : null,
          skipProfileVerify: false,
          skipTranscriptValidation: false,
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          transcriptValidationRequired: true,
          transcriptValidationPassed: true,
          speakerBackendRequirement:
            mode === "both"
              ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
              : { requested: "auto", selected: "mfcc-cosine", required: null },
        },
        commands: {
          score:
            mode === "both"
              ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
              : "python3 scripts/score_voice_regression.py",
        },
        paths: { qualityGate: gatePath, report: reportPath, score: path.join(gateDir, "score.json") },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return gatePath;
}

async function writeLoraQualityGate(profilePath: string, adapterPath: string): Promise<string> {
  const gateDir = path.join(tmpRoot, "quality-gates", "lora");
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  await writeFile(
    gatePath,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-07T00:00:00.000Z",
        status: "pass",
        dryRun: false,
        inputs: {
          profileJson: profilePath,
          cloneMode: "hifi",
          loraPath: adapterPath,
          requireSpeakerBackend: "speechbrain-ecapa",
          skipProfileVerify: false,
          skipTranscriptValidation: false,
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          transcriptValidationRequired: true,
          transcriptValidationPassed: true,
          speakerBackendRequirement: { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" },
        },
        commands: {
          score: "python3 scripts/score_voice_regression.py",
        },
        paths: { qualityGate: gatePath, report: path.join(gateDir, "report.json"), score: path.join(gateDir, "score.json") },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return gatePath;
}

async function writeSubjectiveReview(reportPath: string, candidateWins = 5): Promise<void> {
  const choices: Record<string, string> = {};
  for (let repeat = 1; repeat <= 5; repeat += 1) {
    choices[`winner-zh_hant_polyphones-r${String(repeat).padStart(2, "0")}`] =
      repeat <= candidateWins ? candidateLabel("zh_hant_polyphones", repeat) : "tie";
  }
  const reportText = await readFile(reportPath, "utf-8");
  await writeFile(
    path.join(path.dirname(reportPath), "review.json"),
    `${JSON.stringify(
      {
        version: 1,
        report: reportPath,
        reportPath,
        reportSha256: sha256Text(reportText),
        expectedSaveAs: path.join(path.dirname(reportPath), "review.json"),
        choiceKeys: Object.keys(choices),
        reviewedAt: "2026-01-04T00:00:00.000Z",
        choices,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeLoraArtifacts(
  profilePath: string,
  validation: string,
  qualityGate: string,
  options: { adapterProof?: boolean; trainerCommand?: string; loraQualityGate?: boolean } = {},
): Promise<void> {
  const includeAdapterProof = options.adapterProof !== false;
  const includeLoraQualityGate = options.loraQualityGate !== false;
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ quality?: { durationSec?: number } }>;
  };
  const totalClips = profile.clips.length;
  const totalDurationSec = profile.clips.reduce((sum, clip) => sum + (clip.quality?.durationSec ?? 0), 0);
  const datasetDir = path.join(tmpRoot, "lora-datasets", "local-test");
  await mkdir(datasetDir, { recursive: true });
  const datasetJson = path.join(datasetDir, "dataset.json");
  await writeFile(
    datasetJson,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-05T00:00:00.000Z",
        profilePath,
        voiceProfileId: "local-test",
        totalClips,
        totalDurationSec,
        proofs: {
          transcriptValidationJson: validation,
          qualityGateJson: qualityGate,
          bypass: { transcriptValidationSkipped: false, qualityGateSkipped: false, unsafeExport: false, reason: null },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const jobDir = path.join(tmpRoot, "lora-jobs", "local-test");
  const outputDir = path.join(jobDir, "output");
  await mkdir(outputDir, { recursive: true });
  const adapterProof = path.join(outputDir, "adapter-proof.json");
  const adapterPath = path.join(outputDir, "lora_weights.ckpt");
  const trainConfig = path.join(jobDir, "train_config.json");
  await writeFile(
    trainConfig,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-06T00:00:00.000Z",
        profilePath,
        voiceProfileId: "local-test",
        dataset: { json: datasetJson, totalClips, totalDurationSec, minClips: 10, minTotalDurationSec: 60 },
        datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true },
        lora: { expectedWeights: adapterPath, adapterProof, rank: 32, alpha: 16, dropout: 0 },
        trainer: {
          status: options.trainerCommand ? "ready" : "needs_trainer_command",
          commandTemplate: options.trainerCommand || null,
          trainScript: path.join(jobDir, "train.sh"),
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  if (includeAdapterProof) {
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true },
          trainConfig,
          profilePath,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    if (includeLoraQualityGate) {
      await writeLoraQualityGate(profilePath, adapterPath);
    }
  }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-goal-audit-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("audit_voice_clone_goal.py", () => {
  it("reports the first missing artifact and exits nonzero when required", async () => {
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        path.join(tmpRoot, "missing-profile.json"),
        "--kit-manifest",
        path.join(tmpRoot, "missing-kit.json"),
        "--fail-unless-complete",
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"id": "recording_kit"'),
    });
  });

  it("routes an incomplete recording kit to the next missing clip recorder", async () => {
    const manifest = await writeKit();
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile", "profile.json"),
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv({ speaker: false }),
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "recording_kit",
      status: "blocked",
      missingClips: ["profile-clip-01"],
      firstMissingClip: {
        id: "profile-clip-01",
        transcript: transcripts[0],
        recordCommand: expect.stringContaining("--clip profile-clip-01"),
      },
      recordingPreflight: {
        status: "ready_to_record",
        ok: true,
        recorder: {
          configured: true,
          source: "env:ANYVOICE_RECORDER_COMMAND",
        },
      },
    });
    expect(payload.firstBlocker.recordingPreflight.recordingGuidance).toMatchObject({
      durationMode: "auto",
      targetDurationSec: null,
      minDurationSec: 6,
      maxDurationSec: 20,
      minActiveVoiceSec: 5.2,
    });
    expect(payload.firstBlocker.firstMissingClip.recordCommand).toContain("--check-selected");
    expect(payload.firstBlocker.firstMissingClip.recordCommand).toContain("--auto-duration");
    expect(payload.firstBlocker.firstMissingClip.recordCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.nextCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextCommand).toContain("--record-missing-until-complete");
    expect(payload.nextCommand).toContain("--open-cue-sheet");
    expect(payload.nextCommand).toContain("--auto-duration");
    expect(payload.nextCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.nextCommand).toContain("--countdown-sec 2");
    expect(payload.nextCommand).toContain("--write-metadata");
    expect(payload.nextCommand).toContain("--check");
    expect(payload.nextCommand).not.toContain("--prepare-lora-after-product-proof");
    expect(payload.nextBriefCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextBriefCommand).toContain("--preflight");
    expect(payload.nextBriefCommand).toContain("--brief");
    expect(payload.nextBriefCommand).toContain("--auto-duration");
    expect(payload.nextOpenCueSheetCommand).toContain("python3 -m webbrowser -t file://");
    expect(payload.nextOpenCueSheetCommand).toContain("cue-sheet.html");
    expect(payload.nextMicrophoneSmokeTestCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextMicrophoneSmokeTestCommand).toContain("--preflight --brief");
    expect(payload.nextMicrophoneSmokeTestCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.nextMicrophoneSmokeTestCommand).toContain("--auto-duration");
    expect(payload.nextNormalizeExternalRecordingsCommand).toContain("scripts/normalize_voice_profile_recording_kit_audio.py");
    expect(payload.nextNormalizeExternalRecordingsCommand).toContain("--check");
    expect(payload.nextProductProofCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextProductProofCommand).toContain("--run-product-proof-after-check");
    expect(payload.nextProductProofCommand).toContain("--open-cue-sheet");
    expect(payload.nextProductProofCommand).toContain("--auto-duration");
    expect(payload.nextProductProofCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.nextProductProofCommand).toContain("--check");
    expect(payload.nextProofEnvironmentCommand).toContain("scripts/transcribe_voice_regression.py --list-backends");
    expect(payload.nextProofEnvironmentCommand).toContain("scripts/score_speaker_similarity.py --list-backends");
    expect(payload.nextLoraHandoffCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextLoraHandoffCommand).toContain("--prepare-lora-after-product-proof");
    expect(payload.nextLoraHandoffCommand).toContain("--open-cue-sheet");
    expect(payload.nextLoraHandoffCommand).toContain("--auto-duration");
    expect(payload.nextLoraHandoffCommand).toContain("--microphone-smoke-sec 2");
    expect(payload.nextLoraHandoffCommand).toContain("--check");
  });

  it("prints a brief recording-session checklist for an incomplete kit", async () => {
    const manifest = await writeKit();
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile", "profile.json"),
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--brief",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    expect(stdout).toContain("Status: blocked");
    expect(stdout).toContain("First blocker: recording_kit - blocked");
    expect(stdout).toContain("Missing clips: profile-clip-01");
    expect(stdout).toContain("Next missing clip: profile-clip-01");
    expect(stdout).toContain(transcripts[0]);
    expect(stdout).toContain("Recording preflight: ready_to_record");
    expect(stdout).toContain("Recorder: yes (env:ANYVOICE_RECORDER_COMMAND)");
    expect(stdout).toContain("Target: auto per clip");
    expect(stdout).toContain("Open cue sheet:");
    expect(stdout).toContain("Mic smoke test:");
    expect(stdout).toContain("--microphone-smoke-sec 2");
    expect(stdout).toContain("Preflight brief:");
    expect(stdout).toContain("--preflight --brief");
    expect(stdout).toContain("Normalize phone files:");
    expect(stdout).toContain("normalize_voice_profile_recording_kit_audio.py");
    expect(stdout).toContain("Record missing clips:");
    expect(stdout).toContain("--record-missing-until-complete");
    expect(stdout).toContain("Focused clip command:");
    expect(stdout).toContain("--clip profile-clip-01");
    expect(stdout).toContain("--check-selected");
    expect(stdout).toContain("Product proof after recording:");
    expect(stdout).toContain("--run-product-proof-after-check");
    expect(stdout).toContain("LoRA handoff after product proof:");
    expect(stdout).toContain("--prepare-lora-after-product-proof");
    expect(stdout).toContain("Proof environment:");
    expect(stdout).toContain("ASR: ready");
    expect(stdout).toContain("Speaker: ready");
  });

  it("keeps 10x completion blocked at capture depth for a five-clip profile", async () => {
    const manifest = await writeKit({ count: 5 });
    const profile = await writeReadyProfile({ count: 5 });
    await writeTranscriptValidation(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "capture_depth",
      status: "blocked",
      selectedClips: 5,
      recommendedClips: 10,
      recommendedDurationSec: 60,
    });
    expect(payload.nextCommand).toContain("scripts/prepare_voice_profile_recording_kit.py");
    expect(payload.nextCommand).toContain("--prompt-set extended");
    expect(payload.nextCommand).toContain("--out-dir");
  });

  it("uses the fully specified next-step command for the first quality gate", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
          ANYVOICE_VOXCPM_PYTHON: "/tmp/voxcpm-python",
          ANYVOICE_ASR_PYTHON: "/tmp/asr-python",
          ANYVOICE_SPEAKER_PYTHON: "/tmp/speaker-python",
          ANYVOICE_HOT_WORKER_URL: "http://127.0.0.1:8765",
          ANYVOICE_MODEL_ID: "test/voice-model",
          ANYVOICE_STABILITY_SEED: "4242",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.firstBlocker).toMatchObject({ id: "quality_gate", status: "missing" });
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain("--clone-mode hifi");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
    expect(payload.nextCommand).toContain("--synthesis-python /tmp/voxcpm-python");
    expect(payload.nextCommand).toContain("--asr-python /tmp/asr-python");
    expect(payload.nextCommand).toContain("--speaker-python /tmp/speaker-python");
    expect(payload.nextCommand).toContain("--hot-worker-url http://127.0.0.1:8765");
    expect(payload.nextCommand).toContain("--model-id test/voice-model");
    expect(payload.nextCommand).toContain("--seed 4242");
  });

  it("uses the fully specified product proof command after the hifi gate passes", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
          ANYVOICE_VOXCPM_PYTHON: "/tmp/voxcpm-python",
          ANYVOICE_ASR_PYTHON: "/tmp/asr-python",
          ANYVOICE_SPEAKER_PYTHON: "/tmp/speaker-python",
          ANYVOICE_HOT_WORKER_URL: "http://127.0.0.1:8765",
          ANYVOICE_MODEL_ID: "test/voice-model",
          ANYVOICE_STABILITY_SEED: "4242",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.firstBlocker).toMatchObject({ id: "product_10x_proof", status: "missing" });
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain("--clone-mode both");
    expect(payload.nextCommand).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
    expect(payload.nextCommand).toContain("--synthesis-python /tmp/voxcpm-python");
    expect(payload.nextCommand).toContain("--asr-python /tmp/asr-python");
    expect(payload.nextCommand).toContain("--speaker-python /tmp/speaker-python");
    expect(payload.nextCommand).toContain("--hot-worker-url http://127.0.0.1:8765");
    expect(payload.nextCommand).toContain("--model-id test/voice-model");
    expect(payload.nextCommand).toContain("--seed 4242");
  });

  it("does not let a stale recording kit block a profile that already has 10x capture depth", async () => {
    const manifest = await writeKit({ count: 5 });
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
        "--fail-unless-complete",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("complete");
    expect(payload.stages.find((stage: { id: string }) => stage.id === "recording_kit")).toMatchObject({
      status: "pass",
      selectedClips: 10,
      recommendedClips: 10,
    });
  });

  it("passes only when every digital clone gate has evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
        "--fail-unless-complete",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("complete");
    expect(payload.complete).toBe(true);
    expect(payload.stages.map((stage: { status: string }) => stage.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(payload.stages.find((stage: { id: string }) => stage.id === "proof_environment")).toMatchObject({
      status: "pass",
      asr: { selectedAutoBackend: "faster-whisper" },
      speaker: { selectedAutoBackend: "speechbrain-ecapa" },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "subjective_review")).toMatchObject({
      status: "pass",
      stats: {
        candidateWins: 5,
        candidateWinRate: 1,
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("keeps the goal blocked until the blind subjective review is exported", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeLoraArtifacts(profile, validation, productGate);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "subjective_review",
      status: "missing",
    });
    expect(payload.firstBlocker.expectedReviewJson).toEqual(
      expect.arrayContaining([expect.stringContaining("/quality-gates/both/review.json")]),
    );
    expect(payload.nextCommand).toContain("report.html");
    expect(payload.nextCommand).toContain("review.json");
    expect(payload.nextCommand).not.toContain("record_voice_profile_recording_kit.py");
  });

  it("blocks blind subjective review JSON that does not match the product report hash", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(reviewPath, `${JSON.stringify({ ...review, reportSha256: "bad-hash" }, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "subjective_review",
      status: "blocked",
      reviewReportSha256: "bad-hash",
    });
    expect(payload.firstBlocker.message).toContain("does not match");
    expect(payload.firstBlocker.expectedReportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("routes the next command to LoRA dataset export after proof and review pass", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_dataset",
      status: "missing",
    });
    expect(payload.nextCommand).toContain("scripts/prepare_voice_lora_dataset.py");
    expect(payload.nextCommand).toContain("--transcript-validation-json");
    expect(payload.nextCommand).toContain("--quality-gate-json");
    expect(payload.nextCommand).toContain(await realpath(productGate));
    expect(payload.nextCommand).toContain("--require-product-proof-quality-gate");
    expect(payload.nextCommand).not.toContain("record_voice_profile_recording_kit.py");
  });

  it("blocks a LoRA dataset export backed only by a hifi quality gate", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const hifiGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, hifiGate);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_dataset",
      status: "blocked",
      productQualityGateOk: false,
    });
    expect(payload.nextCommand).toContain(await realpath(productGate));
    expect(payload.nextCommand).toContain("--require-product-proof-quality-gate");
  });

  it("keeps the LoRA training job blocked until a trainer command or adapter proof exists", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
      trainerStatus: "needs_trainer_command",
      trainerCommandConfigured: false,
    });
    expect(payload.nextCommand).toContain("ANYVOICE_VOXCPM_TRAINER_COMMAND=");
    expect(payload.nextCommand).toContain("bash");
    expect(payload.nextCommand).not.toContain("verify_voxcpm_lora_adapter.py");
  });

  it("rejects adapter proofs that lost product-proof dataset evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    delete proof.datasetProofs.productProofQualityGateRequired;
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_adapter",
      status: "blocked",
    });
    expect(payload.firstBlocker.message).toContain("product-proof dataset evidence");
    expect(payload.nextCommand).toContain("verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("keeps completion blocked until the verified LoRA adapter has its own quality gate", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { loraQualityGate: false });

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_quality_gate",
      status: "missing",
    });
    expect(payload.nextCommand).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain("--require-speaker-backend speechbrain-ecapa");
  });

  it("blocks after profile readiness when the product speaker backend is missing", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        manifest,
        "--profile-id",
        "local-test",
        "--lora-dataset-root",
        path.join(tmpRoot, "lora-datasets"),
        "--lora-training-job-root",
        path.join(tmpRoot, "lora-jobs"),
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv({ speaker: false }),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "proof_environment",
      status: "blocked",
      missingBackends: ["speechbrain-ecapa"],
    });
    expect(payload.firstBlocker.asr).toMatchObject({ available: true, selectedAutoBackend: "faster-whisper" });
    expect(payload.firstBlocker.speaker).toMatchObject({ available: false, selectedAutoBackend: "mfcc-cosine" });
    expect(payload.nextCommand).toContain("transcribe_voice_regression.py --list-backends");
    expect(payload.nextCommand).toContain("score_speaker_similarity.py --list-backends");
    expect(payload.nextProofEnvironmentCommand).toBe(payload.nextCommand);
  });
});

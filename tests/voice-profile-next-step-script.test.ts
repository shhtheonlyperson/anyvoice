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
const script = path.join(process.cwd(), "scripts", "voice_profile_next_step.py");

let tmpRoot: string;

const coverage = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];
const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function speakerBackendsJson({
  speechbrainAvailable = false,
  selectedAutoBackend = speechbrainAvailable ? "speechbrain-ecapa" : "mfcc-cosine",
}: {
  speechbrainAvailable?: boolean;
  selectedAutoBackend?: string;
} = {}): string {
  return JSON.stringify({
    version: 1,
    selectedAutoBackend,
    backends: {
      "mfcc-cosine": {
        available: true,
        kind: "local_proxy",
        reason: "built in MFCC cosine scorer",
      },
      resemblyzer: {
        available: false,
        kind: "speaker_embedding",
        reason: "missing Python package: resemblyzer",
      },
      "speechbrain-ecapa": {
        available: speechbrainAvailable,
        kind: "speaker_verification",
        reason: speechbrainAvailable ? "installed" : "missing Python package(s): speechbrain, torch, torchaudio",
      },
    },
  });
}

function asrBackendsJson({
  fasterWhisperAvailable = false,
  selectedAutoBackend = fasterWhisperAvailable ? "faster-whisper" : "whisper-cli",
}: {
  fasterWhisperAvailable?: boolean;
  selectedAutoBackend?: string;
} = {}): string {
  return JSON.stringify({
    version: 1,
    selectedAutoBackend,
    backends: {
      "faster-whisper": {
        available: fasterWhisperAvailable,
        kind: "local_asr",
        reason: fasterWhisperAvailable ? "installed" : "missing Python package: faster_whisper",
      },
      "whisper-cli": {
        available: true,
        kind: "cli_asr",
        path: "/usr/local/bin/whisper",
        reason: "installed",
      },
    },
  });
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

async function writeFakeRecorder(): Promise<string> {
  const fakeRecorder = path.join(tmpRoot, "fake_recorder.py");
  await writeFile(
    fakeRecorder,
    [
      "from pathlib import Path",
      "import sys",
      "import wave",
      "",
      "audio_path = Path(sys.argv[1])",
      "duration = float(sys.argv[2])",
      "sample_rate = 8000",
      "frames = max(1, round(duration * sample_rate))",
      "audio_path.parent.mkdir(parents=True, exist_ok=True)",
      "with wave.open(str(audio_path), 'wb') as handle:",
      "    handle.setnchannels(1)",
      "    handle.setsampwidth(2)",
      "    handle.setframerate(sample_rate)",
      "    data = bytearray()",
      "    for index in range(frames):",
      "        value = 9000 if index % 2 == 0 else -9000",
      "        data.extend(int(value).to_bytes(2, 'little', signed=True))",
      "    handle.writeframes(bytes(data))",
      "",
    ].join("\n"),
    "utf-8",
  );
  return `${shellQuote(python)} ${shellQuote(fakeRecorder)} {audio_path} {duration}`;
}

async function writeKit({
  withAudio,
  promptDriftIndex,
  staleSidecarIndex,
  sourceClipIds = false,
}: {
  withAudio: boolean;
  promptDriftIndex?: number;
  staleSidecarIndex?: number;
  sourceClipIds?: boolean;
}): Promise<string> {
  const kitDir = path.join(tmpRoot, "kit");
  const recordingsDir = path.join(kitDir, "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const clips = [];
  for (let index = 0; index < transcripts.length; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const file = `profile-clip-${suffix}.wav`;
    const clipId = sourceClipIds ? `clip-${index + 1}` : `profile-clip-${suffix}`;
    if (withAudio) {
      await writeFile(path.join(recordingsDir, file), wavBuffer(7 + index));
    }
    clips.push({
      id: clipId,
      audioPath: `recordings/${file}`,
      transcript: transcripts[index],
      coverageFeatures: index === 2 ? ["latin_terms", "polyphones", "punctuation_rhythm", "zh_hant"] : undefined,
      pronunciationNotes:
        index === 2
          ? ["重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4", "銀行: ㄧㄣˊ ㄏㄤˊ / yin2 hang2"]
          : undefined,
    });
  }
  if (promptDriftIndex !== undefined) {
    const promptsDir = path.join(kitDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    for (let index = 0; index < transcripts.length; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      const text =
        index + 1 === promptDriftIndex
          ? "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。"
          : transcripts[index];
      await writeFile(path.join(promptsDir, `profile-clip-${suffix}.txt`), `${text}\n`, "utf-8");
    }
  }
  if (staleSidecarIndex !== undefined) {
    const suffix = String(staleSidecarIndex).padStart(2, "0");
    const clipId = sourceClipIds ? `clip-${staleSidecarIndex}` : `profile-clip-${suffix}`;
    const staleTranscript = "今天是二零二六年五月十九日，我會用自然的速度，把每一句話清楚地讀完。";
    await writeFile(
      path.join(recordingsDir, `profile-clip-${suffix}.wav.recording.json`),
      `${JSON.stringify(
        {
          id: clipId,
          transcript: staleTranscript,
          transcriptSha256: textSha256(staleTranscript),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
  const manifest = path.join(kitDir, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ clips }, null, 2)}\n`, "utf-8");
  return manifest;
}

async function writeReadyProfile({
  recordingKitClipIds,
}: {
  recordingKitClipIds?: string[];
} = {}): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const clips = [];
  for (let index = 1; index <= 5; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index}.wav`);
    await writeFile(audioPath, Buffer.from([index, index + 1, index + 2]));
    clips.push({
      sourceRunId: `clip-${index}`,
      ...(recordingKitClipIds?.[index - 1] ? { recordingKitClipId: recordingKitClipIds[index - 1] } : {}),
      audioPath,
      transcriptRaw: `這是第 ${index} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
      transcriptScript: "zh_hant",
      coverageFeatures: coverage,
      sourceKind: "scripted",
      quality: {
        grade: index === 5 ? "B" : "A",
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
    preferredPromptClipId: "clip-1",
    referenceClipIds: clips.map((clip) => clip.sourceRunId),
    diagnostics: { missingCoverageFeatures: [] },
    loraPath: null,
    clips,
    rejectedClips: [],
  };
  const profilePath = path.join(profileDir, "profile.json");
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
  return profilePath;
}

async function writeTranscriptValidation(
  profilePath = path.join(tmpRoot, "profile", "profile.json"),
  { failedSourceRunId = "" }: { failedSourceRunId?: string } = {},
): Promise<string> {
  const validation = path.join(tmpRoot, "transcript-validation.json");
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const failed = failedSourceRunId ? 1 : 0;
  await writeFile(
    validation,
    `${JSON.stringify({
      profile: profilePath,
      status: failed ? "blocked" : "pass",
      summary: { total: 5, passed: 5 - failed, failed },
      clips: profile.clips.slice(0, 5).map((clip) => ({
        sourceRunId: clip.sourceRunId,
        expectedTranscript: clip.transcriptRaw,
        audioPath: clip.audioPath,
        verdict: clip.sourceRunId === failedSourceRunId ? "fail" : "pass",
        cer: { rate: clip.sourceRunId === failedSourceRunId ? 0.46 : 0 },
        wer: { rate: clip.sourceRunId === failedSourceRunId ? 0.52 : 0 },
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
  return validation;
}

async function writeTranscriptAsr(): Promise<string> {
  const asr = path.join(tmpRoot, "asr.json");
  await writeFile(
    asr,
    `${JSON.stringify({
      transcripts: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `clip-${index + 1}`,
          `這是第 ${index + 1} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`,
        ]),
      ),
    }, null, 2)}\n`,
    "utf-8",
  );
  return asr;
}

async function writeQualityGate(
  profile: string,
  {
    status = "pass",
    dryRun = false,
    cloneMode = "hifi",
    createdAt = dryRun ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z",
    profileVerifyPassed = true,
    transcriptValidationPassed = true,
    skipProfileVerify = !profileVerifyPassed,
    skipTranscriptValidation = !transcriptValidationPassed,
  }: {
    status?: string;
    dryRun?: boolean;
    cloneMode?: "hifi" | "both";
    createdAt?: string;
    profileVerifyPassed?: boolean;
    transcriptValidationPassed?: boolean;
    skipProfileVerify?: boolean;
    skipTranscriptValidation?: boolean;
  } = {},
): Promise<string> {
  const gateDir = path.join(
    tmpRoot,
    "quality-gates",
    cloneMode === "hifi" ? `${status}-${dryRun ? "dry" : "real"}` : `${status}-${dryRun ? "dry" : "real"}-${cloneMode}`,
  );
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  await writeFile(
    gatePath,
    `${JSON.stringify({
      version: 1,
      createdAt,
      status,
      dryRun,
      inputs: {
        profileJson: profile,
        cloneMode,
        quality: "balanced",
        repeats: 3,
        requireSpeakerBackend: cloneMode === "both" ? "speechbrain-ecapa" : null,
        skipProfileVerify,
        skipTranscriptValidation,
      },
      proofs: {
        profileVerifyRequired: !skipProfileVerify,
        profileVerifySkipped: skipProfileVerify,
        profileVerifyPassed,
        transcriptValidationRequired: !skipTranscriptValidation,
        transcriptValidationSkipped: skipTranscriptValidation,
        transcriptValidationPassed,
        speakerBackendRequirement:
          cloneMode === "both"
            ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
            : { requested: "auto", selected: "mfcc-cosine", required: null },
      },
      commands: {
        score:
          cloneMode === "both"
            ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
            : "python3 scripts/score_voice_regression.py",
      },
      paths: {
        qualityGate: gatePath,
        score: path.join(gateDir, "score.json"),
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  return gatePath;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-profile-next-step-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("voice_profile_next_step.py", () => {
  it("asks for a recording kit when both profile and kit are missing", async () => {
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      path.join(tmpRoot, "kit", "manifest.json"),
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording_kit");
    expect(payload.nextAction).toMatchObject({
      id: "prepare_recording_kit",
      phase: "recording_kit",
    });
    expect(payload.nextAction.command).toContain("scripts/prepare_voice_profile_recording_kit.py");
    expect(payload.nextAction.command).toContain("--prompt-set extended");
    expect(payload.nextAction.command).toContain("--out-dir");
    expect(payload.nextAction.command).toContain(path.join(tmpRoot, "kit"));
    expect(payload.nextAction.command).toContain("--profile-id local-default");
  });

  it("points at terminal recording when the kit exists but audio is missing", async () => {
    const kit = await writeKit({ withAudio: false });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile.json"),
        "--kit-manifest",
        kit,
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_ASR_BACKENDS_JSON: asrBackendsJson({ fasterWhisperAvailable: false }),
          ANYVOICE_SPEAKER_BACKENDS_JSON: speakerBackendsJson({ speechbrainAvailable: false }),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording");
    expect(payload.brief).toContain("Status: needs_recording");
    expect(payload.brief).toContain("Missing audio clips: profile-clip-01");
    expect(payload.brief).toContain("Product 10x proof command:");
    expect(payload.recordingKit.status).toBe("incomplete");
    expect(payload.nextAction).toMatchObject({
      id: "record_profile_kit",
      phase: "recording",
    });
    expect(payload.nextAction.command).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextAction.command).toContain("--record-missing-until-complete");
    expect(payload.nextAction.command).toContain("--check");
    expect(payload.nextAction.command).toContain("--countdown-sec 2");
    expect(payload.nextAction.command).toContain("--microphone-smoke-sec 2");
    expect(payload.nextAction.command).toContain("--write-metadata");
    expect(payload.nextAction.command).toContain("--auto-duration");
    expect(payload.commands.rehearseRecordingKit).toContain("--rehearse --no-default-recorder");
    expect(payload.commands.rehearseRecordingKit).toContain("--auto-duration");
    expect(payload.commands.recordNextMissingClip).toContain("--next-missing");
    expect(payload.commands.recordNextMissingClip).toContain("--open-cue-sheet");
    expect(payload.commands.recordNextMissingClip).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordNextMissingClip).toContain("--auto-duration");
    expect(payload.commands.recordNextMissingClip).toContain("--check-selected");
    expect(payload.commands.recordNextMissingClip).not.toMatch(/\s--check(\s|$)/);
    expect(payload.commands.recordMissingUntilComplete).toContain("--record-missing-until-complete");
    expect(payload.commands.recordMissingUntilComplete).toContain("--open-cue-sheet");
    expect(payload.commands.recordMissingUntilComplete).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordMissingUntilComplete).toContain("--auto-duration");
    expect(payload.commands.recordMissingUntilComplete).toContain("--check");
    expect(payload.commands.proveRecordedKit).toContain("scripts/voice_profile_next_step.py");
    expect(payload.commands.proveRecordedKit).toContain("--allow-enroll --allow-expensive");
    expect(payload.commands.proveRecordedKit).not.toContain("--allow-recording");
    expect(payload.commands.proveRecordedKit).toContain("--stop-before-lora");
    expect(payload.commands.proveRecordedKit).toContain("--max-steps 3");
    expect(payload.commands.recordProfileKitAndProve).toContain("--run-proof-after-check");
    expect(payload.commands.recordProfileKitAndProve).toContain("--record-missing-until-complete");
    expect(payload.commands.recordProfileKitAndProve).toContain("--open-cue-sheet");
    expect(payload.commands.recordProfileKitAndProve).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordProfileKitAndProve).toContain("--auto-duration");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--run-product-proof-after-check");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--open-cue-sheet");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--auto-duration");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--prepare-lora-after-product-proof");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--auto-duration");
    expect(payload.commands.qualityGateProductProof).toContain("--clone-mode both");
    expect(payload.commands.qualityGateProductProof).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(payload.commands.microphoneSmokeTestRecordingKit).toContain("--preflight --brief");
    expect(payload.commands.microphoneSmokeTestRecordingKit).toContain("--microphone-smoke-sec 2");
    expect(payload.nextAction.secondaryCommands[0]).toContain("--next-missing");
    expect(payload.nextAction.secondaryCommands[1]).toContain("--rehearse --no-default-recorder");
    expect(payload.nextAction.secondaryCommands[1]).toContain("--auto-duration");
    expect(payload.nextAction.secondaryCommands[2]).toContain("--preflight");
    expect(payload.nextAction.secondaryCommands[3]).toContain("--microphone-smoke-sec 2");
    expect(payload.nextAction.secondaryCommands[4]).toContain("--run-proof-after-check");
    expect(payload.nextAction.secondaryCommands[5]).toContain("--run-product-proof-after-check");
    expect(payload.nextAction.secondaryCommands[6]).toContain("--prepare-lora-after-product-proof");
    expect(payload.postRecordingProofPlan).toMatchObject({
      recommendedCommand: expect.stringContaining("--allow-enroll --allow-expensive"),
      productProofCommand: expect.stringContaining("--require-speaker-backend speechbrain-ecapa"),
      productProofAsrBackend: {
        status: "missing",
        available: false,
        requiredBackend: "faster-whisper",
        asrPython: expect.any(String),
        selectedAutoBackend: "whisper-cli",
        reason: "missing Python package: faster_whisper",
        checkCommand: expect.stringContaining("scripts/transcribe_voice_regression.py --list-backends"),
        setupHint: expect.stringContaining("Install faster-whisper"),
        backends: expect.any(Object),
        run: expect.any(Object),
      },
      productProofSpeakerBackend: {
        status: "missing",
        available: false,
        requiredBackend: "speechbrain-ecapa",
        speakerPython: expect.any(String),
        selectedAutoBackend: "mfcc-cosine",
        reason: "missing Python package(s): speechbrain, torch, torchaudio",
        checkCommand: expect.stringContaining("scripts/score_speaker_similarity.py --list-backends"),
        setupHint: expect.stringContaining("Install speechbrain"),
        backends: expect.any(Object),
        run: expect.any(Object),
      },
      policy: expect.stringContaining("ASR transcript validation"),
    });
    expect(payload.productProofReadiness.speakerBackend).toMatchObject({
      status: "missing",
      requiredBackend: "speechbrain-ecapa",
      selectedAutoBackend: "mfcc-cosine",
    });
    expect(payload.productProofReadiness.asrBackend).toMatchObject({
      status: "missing",
      requiredBackend: "faster-whisper",
      selectedAutoBackend: "whisper-cli",
    });
    expect(payload.postRecordingProofPlan.manualCommands).toEqual([
      expect.stringContaining("scripts/check_voice_profile_recording_kit.py"),
      expect.stringContaining("scripts/enroll_voice_profile_kit.py"),
      expect.stringContaining("scripts/verify_voice_profile_ready.py"),
      expect.stringContaining("scripts/run_voice_quality_gate.py"),
    ]);
    expect(payload.postRecordingProofPlan.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "recording_kit_manifest",
          status: "present",
        }),
        expect.objectContaining({
          id: "profile_json",
          status: "missing",
        }),
        expect.objectContaining({
          id: "transcript_validation_json",
          status: "missing",
        }),
        expect.objectContaining({
          id: "quality_gate_json",
          pathPattern: expect.stringContaining("quality-gate.json"),
          status: "planned",
        }),
      ]),
    );
    expect(payload.postRecordingProofPlan.gates.map((gate: { id: string }) => gate.id)).toEqual([
      "recording_kit_check",
      "enroll_profile_kit",
      "verify_profile_strict",
      "run_quality_gate",
      "run_product_proof_quality_gate",
    ]);
    expect(payload.postRecordingProofPlan.gates.at(-1)).toMatchObject({
      required: true,
      blocks: "lora_dataset_export",
    });
    expect(payload.recordingBrief).toMatchObject({
      clipsNeedingAudio: ["profile-clip-01", "profile-clip-02", "profile-clip-03", "profile-clip-04", "profile-clip-05"],
      pronunciationNotePolicy: expect.stringContaining("do not read notes into the transcript"),
    });
    expect(payload.missingRecordingClips).toEqual([
      "profile-clip-01",
      "profile-clip-02",
      "profile-clip-03",
      "profile-clip-04",
      "profile-clip-05",
    ]);
    expect(payload.recordingBrief.manifest).toMatch(/kit\/manifest\.json$/);
    expect(payload.recordingBrief.guidance).toContain("Use strict Traditional Chinese.");
    expect(payload.recordingBrief.clips[2]).toMatchObject({
      id: "profile-clip-03",
      needsAudio: true,
      transcript: expect.stringContaining("重慶"),
      coverageFeatures: ["latin_terms", "polyphones", "punctuation_rhythm", "zh_hant"],
      pronunciationNotes: expect.arrayContaining(["重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4"]),
      recordCommand: expect.stringContaining("--clip profile-clip-03"),
      rehearseCommand: expect.stringContaining("--rehearse"),
      preflightCommand: expect.stringContaining("--preflight"),
    });
    expect(payload.recordingBrief.clips[2].rehearseCommand).toContain("--auto-duration");
    expect(payload.recordingBrief.clips[2].recordCommand).toContain("--open-cue-sheet");
    expect(payload.recordingBrief.clips[2].recordCommand).toContain("--write-metadata");
    expect(payload.recordingBrief.clips[2].recordCommand).toContain("--auto-duration");
    expect(payload.recordingBrief.clips[2].recordCommand).toContain("--check-selected");
    expect(payload.recordingBrief.clips[2].recordCommand).toContain("--countdown-sec 2");
    expect(payload.recordingBrief.clips[2].preflightCommand).toContain("--auto-duration");
  });

  it("prints a compact brief for a missing-audio recording session", async () => {
    const kit = await writeKit({ withAudio: false });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile.json"),
        "--kit-manifest",
        kit,
        "--brief",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_ASR_BACKENDS_JSON: asrBackendsJson({ fasterWhisperAvailable: true }),
          ANYVOICE_SPEAKER_BACKENDS_JSON: speakerBackendsJson({ speechbrainAvailable: true }),
        },
      },
    );

    expect(stdout).toContain("Status: needs_recording");
    expect(stdout).toContain("Next action: record_profile_kit");
    expect(stdout).toContain("Missing audio clips: profile-clip-01");
    expect(stdout).toContain("First clip: profile-clip-01");
    expect(stdout).toContain("Focused clip command:");
    expect(stdout).toContain("--clip profile-clip-01");
    expect(stdout).toContain("--check-selected");
    expect(stdout).not.toContain("--clip profile-clip-01 --profile-id local-default --open-cue-sheet --countdown-sec 2 --write-metadata --overwrite");
    expect(stdout).toContain("Record missing clips:");
    expect(stdout).toContain("--record-missing-until-complete");
    expect(stdout).toContain("Proof backend readiness:");
    expect(stdout).toContain("- ASR: ready (faster-whisper)");
    expect(stdout).toContain("- Speaker: ready (speechbrain-ecapa)");
    expect(stdout).toContain("Product 10x proof command:");
  });

  it("prioritizes stale prompt files before asking for missing audio", async () => {
    const kit = await writeKit({ withAudio: false, promptDriftIndex: 2 });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording_kit_fix");
    expect(payload.nextAction).toMatchObject({
      id: "fix_recording_kit_metadata",
      phase: "recording_kit",
    });
    expect(payload.nextAction.command).toContain("scripts/check_voice_profile_recording_kit.py");
    expect(payload.nextAction.secondaryCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--rehearse --no-default-recorder --auto-duration"),
        expect.stringContaining("scripts/prepare_voice_profile_recording_kit.py"),
        expect.stringContaining("--prompt-set extended"),
        expect.stringContaining("scripts/record_voice_profile_recording_kit.py"),
      ]),
    );
    expect(payload.nextAction.reason).toContain("stale or missing prompt files");
    expect(payload.recordingKit.checks.find((row: { check: string }) => row.check === "prompt_files")).toMatchObject({
      ok: false,
    });
  });

  it("prioritizes stale terminal recording sidecars before enrollment", async () => {
    const kit = await writeKit({ withAudio: true, staleSidecarIndex: 2 });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording_kit_fix");
    expect(payload.recordingKit.status).toBe("incomplete");
    expect(payload.nextAction).toMatchObject({
      id: "fix_recording_kit_metadata",
      phase: "recording_kit",
    });
    expect(payload.nextAction.reason).toContain("stale or unreadable recording sidecars");
    expect(payload.recordingKit.checks.find((row: { check: string }) => row.check === "recording_metadata")).toMatchObject({
      ok: false,
    });
  });

  it("points re-recording at the first failed audio-quality clip", async () => {
    const kit = await writeKit({ withAudio: true });
    await writeFile(path.join(tmpRoot, "kit", "recordings", "profile-clip-02.wav"), wavBuffer(3));

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording_fix");
    expect(payload.nextAction).toMatchObject({
      id: "fix_recording_kit",
      phase: "recording_quality",
      failedClip: "profile-clip-02",
      failedClipErrors: expect.arrayContaining(["audio_too_short"]),
    });
    expect(payload.nextAction.command).toContain("--clip profile-clip-02");
    expect(payload.nextAction.command).toContain("--overwrite");
    expect(payload.nextAction.command).toContain("--write-metadata");
    expect(payload.nextAction.command).toContain("--check-selected");
    expect(payload.nextAction.command).not.toMatch(/\s--check(\s|$)/);
    expect(payload.recordingBrief.clipsNeedingRerecord).toEqual(["profile-clip-02"]);
    expect(payload.recordingBrief.clipsNeedingAttention).toEqual(["profile-clip-02"]);
    expect(payload.recordingBrief.clips[1]).toMatchObject({
      id: "profile-clip-02",
      needsAudio: false,
      needsRerecord: true,
      recordingIssues: expect.arrayContaining(["audio_too_short", "audio_low_voice_activity"]),
      repairCommand: expect.stringContaining("--overwrite"),
    });
  });

  it("runs preflight instead of opening the microphone unless recording is explicitly allowed", async () => {
    const kit = await writeKit({ withAudio: false });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile.json"),
        "--kit-manifest",
        kit,
        "--run",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording");
    expect(payload.run).toMatchObject({
      status: "ran_preflight_instead_of_recording",
      actionId: "record_profile_kit",
      result: {
        exitCode: 0,
        stdout: {
          status: "ready_to_record",
          summary: { toRecord: 5, existing: 0 },
        },
      },
    });
  });

  it("auto-advances after an allowed recording run and then stops at the enrollment safety gate", async () => {
    const kit = await writeKit({ withAudio: false });
    const fakeRecorderCommand = await writeFakeRecorder();

    try {
      await execFileAsync(
        python,
        [
          script,
          "--profile-json",
          path.join(tmpRoot, "profile.json"),
          "--kit-manifest",
          kit,
          "--run",
          "--auto-advance",
          "--allow-recording",
          "--max-steps",
          "6",
          "--record-countdown-sec",
          "0",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_RECORDER_COMMAND: fakeRecorderCommand,
          },
        },
      );
      throw new Error("expected enrollment safety gate");
    } catch (error) {
      expect((error as { code?: number }).code).toBe(2);
      const payload = JSON.parse((error as { stdout: string }).stdout);
      expect(payload.initialStatus).toBe("needs_recording");
      expect(payload.status).toBe("ready_to_enroll");
      expect(payload.runs).toHaveLength(6);
      expect(payload.runs[0]).toMatchObject({
        status: "ran",
        actionId: "record_profile_kit",
        command: expect.stringContaining("--next-missing"),
        result: {
          exitCode: 0,
          stdout: {
            summary: { requestedClips: 1, recorded: 1 },
          },
        },
      });
      expect(payload.runs[4]).toMatchObject({
        status: "ran",
        actionId: "record_profile_kit",
        command: expect.stringContaining("--next-missing"),
      });
      expect(payload.runs[5]).toMatchObject({
        status: "blocked_by_safety",
        actionId: "enroll_profile_kit",
      });
    }
  });

  it("points at enrollment when the recording kit is ready to import", async () => {
    const kit = await writeKit({ withAudio: true });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_to_enroll");
    expect(payload.recordingKit.status).toBe("ready_to_import");
    expect(payload.nextAction.command).toContain("scripts/enroll_voice_profile_kit.py");
    expect(payload.nextAction.command).not.toContain("--validate-transcripts");
    expect(payload.nextAction.secondaryCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("scripts/enroll_voice_profile_kit.py"),
        expect.stringContaining("--validate-transcripts"),
      ]),
    );
    expect(payload.postRecordingProofPlan.recommendedCommand).toContain("--allow-enroll --allow-expensive");
    expect(payload.postRecordingProofPlan.manualCommands[1]).toContain("--validate-transcripts");
    expect(payload.postRecordingProofPlan.manualCommands[1]).toContain("--transcript-python");
  });

  it("blocks enrollment execution unless explicitly allowed", async () => {
    const kit = await writeKit({ withAudio: true });

    await expect(execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
      "--run",
    ])).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"status": "blocked_by_safety"'),
    });
  });

  it("requires transcript validation before quality gate when profile clips are otherwise ready", async () => {
    const profile = await writeReadyProfile();
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profile,
      "--kit-manifest",
      path.join(tmpRoot, "kit", "manifest.json"),
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_transcript_validation");
    expect(payload.nextAction).toMatchObject({
      id: "validate_transcripts",
      phase: "transcript_validation",
    });
    expect(payload.nextAction.command).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.nextAction.command).toContain("--out");
    expect(payload.nextAction.command).toContain(path.join("profile", "transcript-validation.json"));
  });

  it("points transcript-validation failures at the exact clip re-record command", async () => {
    const profile = await writeReadyProfile({
      recordingKitClipIds: Array.from({ length: 5 }, (_, index) => `profile-clip-${String(index + 1).padStart(2, "0")}`),
    });
    const validation = await writeTranscriptValidation(profile, { failedSourceRunId: "clip-2" });
    const kit = await writeKit({ withAudio: true });

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profile,
      "--transcript-validation-json",
      validation,
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_transcript_rerecord");
    expect(payload.nextAction).toMatchObject({
      id: "fix_transcript_validation_clip",
      phase: "transcript_validation",
      failedClip: "profile-clip-02",
      failedSourceRunId: "clip-2",
      failedClipErrors: expect.arrayContaining(["transcript_validation_fail"]),
    });
    expect(payload.nextAction.command).toContain("--clip profile-clip-02");
    expect(payload.nextAction.command).toContain("--open-cue-sheet");
    expect(payload.nextAction.command).toContain("--overwrite");
    expect(payload.nextAction.command).toContain("--write-metadata");
    expect(payload.nextAction.command).toContain("--check-selected");
    expect(payload.nextAction.secondaryCommands[1]).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.recordingBrief.clipsNeedingRerecord).toEqual(["profile-clip-02"]);
    expect(payload.recordingBrief.clipsNeedingAttention).toEqual(["profile-clip-02"]);
    expect(payload.recordingBrief.clips[1]).toMatchObject({
      id: "profile-clip-02",
      needsRerecord: true,
      recordingIssues: expect.arrayContaining(["transcript_validation_fail"]),
      repairCommand: expect.stringContaining("--clip profile-clip-02"),
    });
  });

  it("auto-advances through transcript validation and reuses the profile-local report", async () => {
    const profile = await writeReadyProfile();
    const asr = await writeTranscriptAsr();
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profile,
      "--kit-manifest",
      path.join(tmpRoot, "kit", "manifest.json"),
      "--run",
      "--auto-advance",
      "--allow-expensive",
      "--max-steps",
      "1",
      "--transcript-asr-json",
      asr,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.initialStatus).toBe("needs_transcript_validation");
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      status: "ran",
      actionId: "validate_transcripts",
      result: { exitCode: 0 },
    });
    expect(payload.transcriptValidation.json).toContain(path.join("profile", "transcript-validation.json"));
    expect(payload.transcriptValidation.asrJson).toContain("asr.json");
    expect(payload.nextAction.command).toContain("--transcript-validation-json");
    expect(payload.nextAction.command).toContain(path.join("profile", "transcript-validation.json"));
  });

  it("reports quality gate and LoRA handoff commands after strict profile readiness passes", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
        "--fail-unless-ready",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_VOXCPM_PYTHON: "/tmp/voxpy",
          ANYVOICE_ASR_PYTHON: "/tmp/asrpy",
          ANYVOICE_HOT_WORKER_URL: "http://127.0.0.1:9999",
          ANYVOICE_MODEL_ID: "custom/Model",
          ANYVOICE_ASR_BACKENDS_JSON: asrBackendsJson({ fasterWhisperAvailable: true }),
          ANYVOICE_SPEAKER_BACKENDS_JSON: speakerBackendsJson({ speechbrainAvailable: true }),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.profile.status).toBe("ready");
    expect(payload.nextAction.command).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextAction.command).toContain("--synthesis-python /tmp/voxpy");
    expect(payload.nextAction.command).toContain("--asr-python /tmp/asrpy");
    expect(payload.nextAction.command).toContain("--speaker-python /tmp/voxpy");
    expect(payload.nextAction.command).toContain("--hot-worker-url http://127.0.0.1:9999");
    expect(payload.nextAction.command).toContain("--model-id custom/Model");
    expect(payload.nextAction.command).toContain("--seed 1337");
    expect(payload.nextAction.secondaryCommands).toEqual([
      expect.stringContaining("scripts/run_voice_quality_gate.py"),
      expect.stringContaining("scripts/prepare_voice_backend_shootout.py"),
      expect.stringContaining("scripts/prepare_voice_lora_dataset.py"),
      expect.stringContaining("scripts/prepare_voxcpm_lora_training_job.py"),
    ]);
    expect(payload.nextAction.secondaryCommands[0]).toContain("--clone-mode both");
    expect(payload.nextAction.secondaryCommands[0]).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(payload.nextAction.secondaryCommands[2]).toContain("--min-clips 10");
    expect(payload.nextAction.secondaryCommands[2]).toContain("--min-total-duration-sec 60.0");
    expect(payload.nextAction.secondaryCommands[3]).toContain("--min-clips 10");
    expect(payload.nextAction.secondaryCommands[3]).toContain("--min-total-duration-sec 60.0");
    expect(payload.commands.qualityGateProductProof).toContain("--transcript-validation-json");
    expect(payload.commands.qualityGateProductProof).toContain(validation);
    expect(payload.commands.qualityGateProductProof).toContain("--asr-python /tmp/asrpy");
    expect(payload.commands.qualityGateProductProof).toContain("--speaker-python /tmp/voxpy");
    expect(payload.commands.validateTranscripts).toContain("/tmp/asrpy");
    expect(payload.commands.validateTranscripts).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.commands.enrollProfileKitAndValidate).toContain("--transcript-python /tmp/asrpy");
    expect(payload.commands.prepareLoraDataset).toContain("--require-product-proof-quality-gate");
    expect(payload.commands.prepareLoraDataset).toContain("--min-clips 10");
    expect(payload.commands.prepareLoraDataset).toContain("--min-total-duration-sec 60.0");
    expect(payload.commands.prepareLoraTrainingJob).toContain("--min-clips 10");
    expect(payload.commands.prepareLoraTrainingJob).toContain("--min-total-duration-sec 60.0");
    expect(payload.commands.prepareBackendShootout).toContain("--transcript-validation-json");
    expect(payload.commands.prepareBackendShootout).toContain(validation);
    expect(payload.postRecordingProofPlan.productProofAsrBackend).toMatchObject({
      status: "ready",
      available: true,
      requiredBackend: "faster-whisper",
      asrPython: "/tmp/asrpy",
      selectedAutoBackend: "faster-whisper",
      reason: "installed",
    });
    expect(payload.postRecordingProofPlan.productProofSpeakerBackend).toMatchObject({
      status: "ready",
      available: true,
      requiredBackend: "speechbrain-ecapa",
      speakerPython: "/tmp/voxpy",
      selectedAutoBackend: "speechbrain-ecapa",
      reason: "installed",
    });
  });

  it("moves to product proof after a measured hifi quality gate pass", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile);
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
        "--fail-unless-ready",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_product_proof");
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
    expect(payload.qualityGate.json).toContain(path.join("quality-gates", "pass-real", "quality-gate.json"));
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
    expect(payload.nextAction.command).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextAction.command).toContain("--transcript-validation-json");
    expect(payload.nextAction.command).toContain(validation);
    expect(payload.nextAction.command).toContain("--clone-mode both");
    expect(payload.nextAction.command).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(payload.nextAction.secondaryCommands).toEqual([
      expect.stringContaining("scripts/prepare_voice_backend_shootout.py"),
      expect.stringContaining("scripts/prepare_voice_lora_dataset.py"),
      expect.stringContaining("scripts/prepare_voxcpm_lora_training_job.py"),
    ]);
    expect(payload.nextAction.secondaryCommands[1]).toContain("--require-product-proof-quality-gate");
    expect(payload.commands.prepareBackendShootout).toContain("--backend indextts2 --backend f5-tts");
    expect(payload.commands.prepareBackendShootout).toContain("--transcript-validation-json");
    expect(payload.commands.prepareBackendShootout).toContain(validation);
  });

  it("moves to LoRA dataset export after a paired product-proof quality gate pass", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
        "--fail-unless-ready",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_lora_dataset");
    expect(payload.qualityGate.json).toContain(path.join("quality-gates", "pass-real", "quality-gate.json"));
    expect(payload.productQualityGate.json).toBe(await realpath(productGate));
    expect(payload.nextAction).toMatchObject({
      id: "prepare_lora_dataset",
      phase: "lora_dataset",
    });
    expect(payload.nextAction.command).toContain("scripts/prepare_voice_lora_dataset.py");
    expect(payload.nextAction.command).toContain("--transcript-validation-json");
    expect(payload.nextAction.command).toContain(validation);
    expect(payload.nextAction.command).toContain("--quality-gate-json");
    expect(payload.nextAction.command).toContain(await realpath(productGate));
    expect(payload.nextAction.command).toContain("--require-product-proof-quality-gate");
    expect(payload.nextAction.command).toContain("--min-clips 10");
    expect(payload.nextAction.command).toContain("--min-total-duration-sec 60.0");
    expect(payload.nextAction.secondaryCommands).toEqual([
      expect.stringContaining("scripts/prepare_voxcpm_lora_training_job.py"),
      expect.stringContaining("scripts/prepare_voice_backend_shootout.py"),
      expect.stringContaining("scripts/register_voice_backend_renders.py"),
    ]);
    expect(payload.nextAction.secondaryCommands[0]).toContain("--min-clips 10");
    expect(payload.nextAction.secondaryCommands[0]).toContain("--min-total-duration-sec 60.0");
  });

  it("can stop auto-advance before writing a LoRA dataset", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile, { cloneMode: "both" });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
        "--run",
        "--auto-advance",
        "--stop-before-lora",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.initialStatus).toBe("ready_for_lora_dataset");
    expect(payload.status).toBe("ready_for_lora_dataset");
    expect(payload.nextAction.id).toBe("prepare_lora_dataset");
    expect(payload.run).toBeUndefined();
    expect(payload.runs).toBeUndefined();
  });

  it("requires explicit permission before exporting a LoRA dataset", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile, { cloneMode: "both" });
    await expect(
      execFileAsync(
        python,
        [
          script,
          "--profile-json",
          profile,
          "--transcript-validation-json",
          validation,
          "--kit-manifest",
          path.join(tmpRoot, "kit", "manifest.json"),
          "--run",
        ],
        {
          env: {
            ...process.env,
            ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("requires --allow-lora-export"),
    });
  });

  it("ignores dry-run quality gates before LoRA export", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile, { status: "planned", dryRun: true });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction.id).toBe("run_quality_gate");
    expect(payload.qualityGate).toMatchObject({ status: "planned", dryRun: true });
  });

  it("does not unlock LoRA export when the latest pass gate skipped transcript proof", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile, { skipTranscriptValidation: true, transcriptValidationPassed: true });
    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
      inputs: { skipTranscriptValidation: true },
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });
});

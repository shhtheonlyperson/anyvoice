// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

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
  count = 5,
  recordingKitClipIds,
}: {
  count?: number;
  recordingKitClipIds?: string[];
} = {}): Promise<string> {
  const profileDir = path.join(tmpRoot, "profile");
  await mkdir(profileDir, { recursive: true });
  const clips = [];
  const extraTranscripts = [
    "請把行長這個詞讀成銀行的行、長官的長，保持清楚自然。",
    "我會把 VoxCPM2 和 AnyVoice 的名稱讀清楚，並保持穩定音量。",
    "這段聲音包含較長停頓、短句和自然語氣，讓模型學到穩定節奏。",
    "今天的範例包含二零二六年五月二十日，以及幾個清楚的數字。",
    "最後一段我會維持相同距離，讓每個音節都乾淨可辨識。",
  ];
  for (let index = 1; index <= count; index += 1) {
    const audioPath = path.join(profileDir, `clip-${index}.wav`);
    await writeFile(audioPath, Buffer.from([index, index + 1, index + 2]));
    const transcriptRaw =
      index <= 5
        ? `這是第 ${index} 段 AnyVoice、重慶、銀行、角色、音樂和長樂，二零二六年五月十九日。`
        : extraTranscripts[index - 6] ?? `這是第 ${index} 段 AnyVoice、VoxCPM2、行長和重慶的延伸聲音樣本。`;
    clips.push({
      sourceRunId: `clip-${index}`,
      ...(recordingKitClipIds?.[index - 1] ? { recordingKitClipId: recordingKitClipIds[index - 1] } : {}),
      audioPath,
      transcriptRaw,
      transcriptScript: "zh_hant",
      coverageFeatures: coverage,
      sourceKind: "scripted",
      quality: {
        grade: index === count ? "B" : "A",
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
      eligibleClips: count,
      selectedClips: count,
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
  {
    createdAt,
    failedSourceRunId = "",
    omitProfileSha256 = false,
    profileSha256,
    staleSourceRunId = "",
    validationPath = path.join(tmpRoot, "transcript-validation.json"),
    voiceProfileId,
  }: {
    createdAt?: string;
    failedSourceRunId?: string;
    omitProfileSha256?: boolean;
    profileSha256?: string;
    staleSourceRunId?: string;
    validationPath?: string;
    voiceProfileId?: string;
  } = {},
): Promise<string> {
  const validation = validationPath;
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; transcriptRaw: string; audioPath: string }>;
  };
  const failed = failedSourceRunId ? 1 : 0;
  const effectiveProfileSha256 = omitProfileSha256 ? undefined : profileSha256 ?? (await canonicalProfileSha256(profilePath));
  await writeFile(
    validation,
    `${JSON.stringify({
      ...(createdAt ? { createdAt } : {}),
      profile: profilePath,
      voiceProfileId: voiceProfileId ?? "local-test",
      ...(effectiveProfileSha256 ? { profileSha256: effectiveProfileSha256 } : {}),
      status: failed ? "blocked" : "pass",
      summary: { total: 5, passed: 5 - failed, failed },
      clips: profile.clips.slice(0, 5).map((clip) => ({
        sourceRunId: clip.sourceRunId,
        expectedTranscript: clip.sourceRunId === staleSourceRunId ? "舊的逐字稿" : clip.transcriptRaw,
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
    loraPath,
  }: {
    status?: string;
    dryRun?: boolean;
    cloneMode?: "hifi" | "both";
    createdAt?: string;
    profileVerifyPassed?: boolean;
    transcriptValidationPassed?: boolean;
    skipProfileVerify?: boolean;
    skipTranscriptValidation?: boolean;
    loraPath?: string;
  } = {},
): Promise<string> {
  const gateDir = path.join(
    tmpRoot,
    "quality-gates",
    cloneMode === "hifi" ? `${status}-${dryRun ? "dry" : "real"}` : `${status}-${dryRun ? "dry" : "real"}-${cloneMode}`,
  );
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  const reportPath = path.join(gateDir, "report.json");
  const asrPath = path.join(gateDir, "asr.json");
  const speakerPath = path.join(gateDir, "speaker.json");
  const scorePath = path.join(gateDir, "score.json");
  const transcriptValidationJson = path.join(tmpRoot, "transcript-validation.json");
  const transcriptValidationSha256 = await fileSha256(transcriptValidationJson);
  const profilePayload = JSON.parse(await readFile(profile, "utf-8")) as { voiceProfileId?: string };
  const profileSha256 = await canonicalProfileSha256(profile);
  const profileEvidence = {
    voiceProfileId: profilePayload.voiceProfileId,
    profileSha256,
  };
  const renderMetadata = loraPath
    ? {
        metadataJson: {
          effectiveParams: {
            cloneMode: "hifi",
            loraEnabled: true,
            loraPath,
          },
        },
      }
    : {};
  const reportGroups = [
    {
      ...profileEvidence,
      cloneMode: cloneMode === "both" ? "prompt" : "hifi",
      case: { id: "zh_hant_polyphones", text: "重慶角色" },
      renders: [{ ...profileEvidence, repeat: 1, status: "ready", outputWav: "sample.wav", ...(cloneMode === "hifi" ? renderMetadata : {}) }],
    },
    ...(cloneMode === "both"
      ? [
          {
            ...profileEvidence,
            cloneMode: "hifi",
            case: { id: "zh_hant_polyphones", text: "重慶角色" },
            renders: [{ ...profileEvidence, repeat: 1, status: "ready", outputWav: "sample-hifi.wav", ...renderMetadata }],
          },
        ]
      : []),
  ];
  for (const group of reportGroups) {
    for (const render of group.renders as Array<Record<string, unknown> & { outputWav: string }>) {
      const outputPath = path.isAbsolute(render.outputWav) ? render.outputWav : path.join(gateDir, render.outputWav);
      const audio = Buffer.from(`${group.cloneMode}-${group.case.id}-${render.repeat}\n`, "utf-8");
      await writeFile(outputPath, audio);
      render.outputExists = true;
      render.missingOutput = false;
      render.outputBytes = audio.byteLength;
      render.outputSha256 = textSha256(audio.toString("utf-8"));
    }
  }
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        version: 1,
        voiceProfile: profileEvidence,
        groups: reportGroups,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(asrPath, `${JSON.stringify({ "hifi/zh_hant_polyphones/r01": "重慶角色" }, null, 2)}\n`, "utf-8");
  await writeFile(
    speakerPath,
    `${JSON.stringify({ version: 1, backend: "speechbrain-ecapa", summary: { total: 1, scored: 1, failed: 0 } }, null, 2)}\n`,
    "utf-8",
  );
  const reportSha256 = await fileSha256(reportPath);
  const asrSha256 = await fileSha256(asrPath);
  const speakerSha256 = await fileSha256(speakerPath);
  await writeFile(
    scorePath,
    `${JSON.stringify(
      {
        version: 1,
        verdict: "pass",
        thresholds: {
          requireSpeakerSimilarity: true,
          requireProfileReferenceSimilarity: true,
        },
        voiceProfile: profileEvidence,
        summary: {
          groups: reportGroups.length,
          passingGroups: reportGroups.length,
          avgSpeakerSimilarity: 0.91,
          speakerReviewGroups: 0,
        },
        pairedComparison: cloneMode === "both"
          ? {
              verdict: "pass",
              baselineCloneMode: "prompt",
              candidateCloneMode: "hifi",
              minReductionPct: 50,
              pairs: [
                {
                  caseId: "zh_hant_polyphones",
                  baselineCloneMode: "prompt",
                  candidateCloneMode: "hifi",
                  verdict: "pass",
                  cerReductionPct: 90,
                  werReductionPct: 88,
                  speakerSimilarityDelta: 0.01,
                  latencyVerdict: "pass",
                  latencyRegressionPct: 0,
                },
              ],
              summary: {
                pairs: 1,
                passingPairs: 1,
                reviewPairs: 0,
                avgCerReductionPct: 90,
                avgWerReductionPct: 88,
                avgLatencyRegressionPct: 0,
              },
            }
          : undefined,
        groups: reportGroups.map((group) => ({
          ...group,
          caseId: group.case?.id,
          renderCount: Array.isArray(group.renders) ? group.renders.length : 0,
          verdict: "pass",
          speakerIdentityVerdict: "pass",
          speakerIdentity: {
            verdict: "pass",
            avgSpeakerSimilarity: 0.91,
            profileReferenceEvaluatedRenders: Array.isArray(group.renders) ? group.renders.length : 0,
            requireProfileReferenceSimilarity: true,
          },
        })),
        sourceReport: reportPath,
        sourceReportSha256: reportSha256,
        asrJson: asrPath,
        asrJsonSha256: asrSha256,
        speakerJson: speakerPath,
        speakerJsonSha256: speakerSha256,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const scoreSha256 = await fileSha256(scorePath);
  await writeFile(
    gatePath,
    `${JSON.stringify({
      version: 1,
      createdAt,
      status,
      dryRun,
      inputs: {
        profileJson: profile,
        profileSha256,
        cloneMode,
        quality: "balanced",
        repeats: 3,
        requireSpeakerBackend: cloneMode === "both" ? "speechbrain-ecapa" : null,
        transcriptValidationJson,
        transcriptValidationSha256,
        skipProfileVerify,
        skipTranscriptValidation,
        ...(loraPath ? { loraPath } : {}),
      },
      proofs: {
        profileVerifyRequired: !skipProfileVerify,
        profileVerifySkipped: skipProfileVerify,
        profileVerifyPassed,
        transcriptValidationRequired: !skipTranscriptValidation,
        transcriptValidationSkipped: skipTranscriptValidation,
        transcriptValidationJson,
        transcriptValidationSha256,
        transcriptValidationPassed,
        speakerBackendRequirement:
          cloneMode === "both"
            ? { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" }
            : { requested: "auto", selected: "mfcc-cosine", required: null },
        artifacts: {
          report: { path: reportPath, sha256: reportSha256 },
          asr: { path: asrPath, sha256: asrSha256 },
          speaker: { path: speakerPath, sha256: speakerSha256 },
          score: { path: scorePath, sha256: scoreSha256 },
        },
      },
      commands: {
        score:
          cloneMode === "both"
            ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
            : "python3 scripts/score_voice_regression.py",
      },
      paths: {
        qualityGate: gatePath,
        report: reportPath,
        asr: asrPath,
        speaker: speakerPath,
        profileTranscriptValidation: transcriptValidationJson,
        score: scorePath,
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  return gatePath;
}

async function markQualityGateProfileReferenceReview(gatePath: string, presetId = "brand:voxcpm2"): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.verdict = "review";
  score.summary = {
    ...score.summary,
    passingGroups: 0,
    profileReferenceReviewGroups: 1,
  };
  score.groups = [
    {
      ...(Array.isArray(score.groups) && score.groups[0] ? score.groups[0] : {}),
      verdict: "review",
      profileReferenceVerdict: "review",
      profileReference: {
        verdict: "review",
        evaluatedRenders: 1,
        missingByRender: [
          {
            caseId: "zh_hant_polyphones",
            repeat: 1,
            profileClipId: "clip-1",
            missingPronunciationPresetIds: [presetId],
          },
        ],
      },
    },
  ];
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.status = "failed";
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function tamperQualityGateAsrArtifact(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  await writeFile(gate.paths.asr, `${JSON.stringify({ stale: "changed after gate" }, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleAsrHash(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.asrJsonSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeQualityGatePairedComparison(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  delete score.pairedComparison;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeQualityGatePairedImprovementCommandFlag(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  gate.commands.score = "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi";
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function regressQualityGatePairedSpeakerSimilarity(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.pairedComparison.pairs[0].speakerSimilarityDelta = -0.01;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateSourceReportAtStaleProfileEvidence(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
  report.voiceProfile.profileSha256 = "0".repeat(64);
  report.groups[0].profileSha256 = "0".repeat(64);
  report.groups[0].renders[0].profileSha256 = "0".repeat(64);
  await writeFile(gate.paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const reportSha256 = await fileSha256(gate.paths.report);
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateSourceReportAtStaleRenderOutput(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
  const renderOutput = path.join(path.dirname(gate.paths.report), "sample.wav");
  const originalBytes = "original render output bytes";
  await writeFile(renderOutput, originalBytes);
  report.groups[0].renders[0].outputWav = renderOutput;
  report.groups[0].renders[0].outputExists = true;
  report.groups[0].renders[0].missingOutput = false;
  report.groups[0].renders[0].outputBytes = Buffer.byteLength(originalBytes);
  report.groups[0].renders[0].outputSha256 = textSha256(originalBytes);
  await writeFile(gate.paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const reportSha256 = await fileSha256(gate.paths.report);
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
  await writeFile(renderOutput, "mutated render output bytes");
}

async function removeQualityGateSourceReportRenderOutputProof(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
  const render = report.groups[0].renders[0];
  delete render.outputExists;
  delete render.missingOutput;
  delete render.outputBytes;
  delete render.outputSha256;
  await writeFile(gate.paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const reportSha256 = await fileSha256(gate.paths.report);
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleProfileEvidence(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.voiceProfile.profileSha256 = "0".repeat(64);
  score.groups[0].profileSha256 = "0".repeat(64);
  score.groups[0].renders[0].profileSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeQualityGateProfileReferenceSpeakerProof(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.thresholds.requireProfileReferenceSimilarity = false;
  for (const group of score.groups ?? []) {
    if (!group?.speakerIdentity) continue;
    group.speakerIdentity.requireProfileReferenceSimilarity = false;
    group.speakerIdentity.profileReferenceEvaluatedRenders = 0;
  }
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function markQualityGateSpeakerIdentityForReview(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  for (const group of score.groups ?? []) {
    group.verdict = "review";
    group.speakerIdentityVerdict = "review";
    if (group?.speakerIdentity) {
      group.speakerIdentity.verdict = "review";
    }
  }
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await fileSha256(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
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

  it("accepts an explicit json output flag", async () => {
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      path.join(tmpRoot, "kit", "manifest.json"),
      "--json",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording_kit");
    expect(payload.nextAction.id).toBe("prepare_recording_kit");
  });

  it("rejects conflicting json and brief output flags", async () => {
    await expect(
      execFileAsync(python, [
        script,
        "--profile-json",
        path.join(tmpRoot, "profile.json"),
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
        "--json",
        "--brief",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--brief and --json cannot be used together"),
    });
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
    expect(payload.commands.recordProfileKitAndProve).toContain("--check");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--run-product-proof-after-check");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--open-cue-sheet");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--auto-duration");
    expect(payload.commands.recordProfileKitAndProductProof).toContain("--check");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--prepare-lora-after-product-proof");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--microphone-smoke-sec 2");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--auto-duration");
    expect(payload.commands.recordProfileKitToLoraHandoff).toContain("--check");
    expect(payload.commands.normalizeExternalRecordings).toContain("scripts/normalize_voice_profile_recording_kit_audio.py");
    expect(payload.commands.normalizeExternalRecordings).toContain("--check");
    expect(payload.commands.normalizeExternalRecordings).toContain("--profile-id local-default");
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
    expect(payload.nextAction.secondaryCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("scripts/normalize_voice_profile_recording_kit_audio.py"),
      ]),
    );
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

  it("prioritizes normalizing exported phone recordings when every missing WAV has a source file", async () => {
    const kit = await writeKit({ withAudio: false });
    const recordingsDir = path.join(tmpRoot, "kit", "recordings");
    for (let index = 1; index <= transcripts.length; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeFile(path.join(recordingsDir, `profile-clip-${suffix}.m4a`), Buffer.from(`phone export ${suffix}`));
    }

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_external_recording_normalization");
    expect(payload.nextAction).toMatchObject({
      id: "normalize_external_recordings",
      phase: "recording_import",
      command: expect.stringContaining("scripts/normalize_voice_profile_recording_kit_audio.py"),
      pendingExternalRecordings: expect.arrayContaining([
        expect.objectContaining({
          id: "profile-clip-01",
          sourceAudioPath: expect.stringMatching(/profile-clip-01\.m4a$/),
          audioPath: expect.stringMatching(/profile-clip-01\.wav$/),
        }),
      ]),
    });
    expect(payload.nextAction.pendingExternalRecordings).toHaveLength(transcripts.length);
    expect(payload.nextAction.command).toContain("--check");
    expect(payload.nextAction.command).toContain("--profile-id local-default");
    expect(payload.nextAction.command).not.toContain("record_voice_profile_recording_kit.py");
    expect(payload.nextAction.secondaryCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("scripts/enroll_voice_profile_kit.py"),
        expect.stringContaining("--record-missing-until-complete"),
      ]),
    );
  });

  it("normalizes present exported phone recordings before asking for the remaining missing clips", async () => {
    const kit = await writeKit({ withAudio: false });
    const recordingsDir = path.join(tmpRoot, "kit", "recordings");
    await writeFile(path.join(recordingsDir, "profile-clip-01.m4a"), Buffer.from("phone export 01"));
    await writeFile(path.join(recordingsDir, "profile-clip-03.m4a"), Buffer.from("phone export 03"));

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_partial_external_recording_normalization");
    expect(payload.nextAction).toMatchObject({
      id: "normalize_partial_external_recordings",
      phase: "recording_import",
      command: expect.stringContaining("scripts/normalize_voice_profile_recording_kit_audio.py"),
      pendingExternalRecordings: expect.arrayContaining([
        expect.objectContaining({
          id: "profile-clip-01",
          sourceAudioPath: expect.stringMatching(/profile-clip-01\.m4a$/),
        }),
        expect.objectContaining({
          id: "profile-clip-03",
          sourceAudioPath: expect.stringMatching(/profile-clip-03\.m4a$/),
        }),
      ]),
    });
    expect(payload.nextAction.pendingExternalRecordings).toHaveLength(2);
    expect(payload.nextAction.command).toContain("--only-present");
    expect(payload.nextAction.command).not.toContain("--check");
    expect(payload.nextAction.secondaryCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--record-missing-until-complete"),
        expect.stringContaining("scripts/normalize_voice_profile_recording_kit_audio.py"),
        expect.stringContaining("scripts/enroll_voice_profile_kit.py"),
      ]),
    );
    expect(payload.nextAction.reason).toContain("3 missing WAV source(s)");
  });

  it("runs partial external normalization and auto-advances to remaining recording work", async () => {
    const kit = await writeKit({ withAudio: false });
    const recordingsDir = path.join(tmpRoot, "kit", "recordings");
    await writeFile(path.join(recordingsDir, "profile-clip-01.source.wav"), wavBuffer(7));
    await writeFile(path.join(recordingsDir, "profile-clip-03.source.wav"), wavBuffer(9));

    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      path.join(tmpRoot, "profile.json"),
      "--kit-manifest",
      kit,
      "--run",
      "--auto-advance",
      "--max-steps",
      "1",
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.initialStatus).toBe("needs_partial_external_recording_normalization");
    expect(payload.initialAction).toMatchObject({
      id: "normalize_partial_external_recordings",
      command: expect.stringContaining("--only-present"),
    });
    expect(payload.status).toBe("needs_recording");
    expect(payload.nextAction).toMatchObject({
      id: "record_profile_kit",
      phase: "recording",
    });
    expect(payload.missingRecordingClips).toEqual(["profile-clip-02", "profile-clip-04", "profile-clip-05"]);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      status: "ran",
      actionId: "normalize_partial_external_recordings",
      command: expect.stringContaining("--only-present"),
      result: {
        exitCode: 0,
        stdout: {
          status: "partial_normalized",
          summary: { normalized: 2, missingSources: 3 },
        },
      },
    });
    await expect(stat(path.join(recordingsDir, "profile-clip-01.wav"))).resolves.toMatchObject({
      size: expect.any(Number),
    });
    await expect(stat(path.join(recordingsDir, "profile-clip-03.wav"))).resolves.toMatchObject({
      size: expect.any(Number),
    });
  });

  it("prioritizes the extended recording kit before transcript validation when capture depth is incomplete", async () => {
    const profile = await writeReadyProfile();
    const kit = await writeKit({ withAudio: false });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profile,
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_recording");
    expect(payload.nextAction).toMatchObject({
      id: "record_profile_kit",
      phase: "recording",
      productCaptureDepth: {
        ok: false,
        selectedClips: 5,
      },
    });
    expect(payload.nextAction.productCaptureDepth.missingPronunciationPresetIds).toEqual([]);
    expect(payload.nextAction.command).toContain("--record-missing-until-complete");
    expect(payload.nextAction.command).not.toContain("validate_voice_profile_transcripts.py");
    expect(payload.brief).toContain("Status: needs_recording");
    expect(payload.brief).toContain("Capture depth: 5/7 clips");
    expect(payload.brief).toContain("Capture duration: 50/60s");
    expect(payload.brief).not.toContain("Missing pronunciation coverage:");
  });

  it("does not let stale external kit files block a profile that already has 7-clip product capture depth", async () => {
    const profile = await writeReadyProfile({ count: 10 });
    const kit = await writeKit({ withAudio: false, promptDriftIndex: 2 });
    const { stdout } = await execFileAsync(python, [
      script,
      "--profile-json",
      profile,
      "--kit-manifest",
      kit,
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_transcript_validation");
    expect(payload.profile.summary).toMatchObject({
      selectedClips: 10,
      totalDurationSec: 125,
      missingCoverageFeatures: [],
      missingPronunciationPresetIds: [],
    });
    expect(payload.recordingKit.status).toBe("incomplete");
    expect(payload.recordingKit.checks.find((row: { check: string }) => row.check === "prompt_files")).toMatchObject({
      ok: false,
    });
    expect(payload.nextAction).toMatchObject({
      id: "validate_transcripts",
      phase: "transcript_validation",
    });
    expect(payload.nextAction.command).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.nextAction.command).not.toContain("record_voice_profile_recording_kit.py");
    expect(payload.nextAction.productCaptureDepth).toBeUndefined();
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
    expect(stdout).toContain("Normalize phone files:");
    expect(stdout).toContain("normalize_voice_profile_recording_kit_audio.py");
    expect(stdout).toContain("--check --profile-id local-default");
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

  it("prefers a current profile-bound transcript validation over a newer stale root report", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const profileLocalValidation = path.join(path.dirname(profile), "transcript-validation.json");
    const validationRoot = path.join(tmpRoot, "validation-root");
    const staleValidation = path.join(validationRoot, "newer-stale-validation.json");
    await mkdir(validationRoot, { recursive: true });
    await writeTranscriptValidation(profile, {
      createdAt: "2026-01-01T00:00:00.000Z",
      profileSha256,
      validationPath: profileLocalValidation,
    });
    await writeTranscriptValidation(profile, {
      createdAt: "2026-01-02T00:00:00.000Z",
      profileSha256: "0".repeat(64),
      validationPath: staleValidation,
    });

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--kit-manifest",
        path.join(tmpRoot, "kit", "manifest.json"),
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_TRANSCRIPT_VALIDATION_ROOT: validationRoot,
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.transcriptValidation.json).toBe(await realpath(profileLocalValidation));
    expect(payload.transcriptValidation.json).not.toBe(await realpath(staleValidation));
    expect(payload.nextAction.command).toContain(await realpath(profileLocalValidation));
    expect(payload.nextAction.command).not.toContain(await realpath(staleValidation));
  });

  it("routes failed hifi gates with missing profile-reference presets back to focused recording", async () => {
    const kit = await writeKit({ withAudio: true });
    const manifestPayload = JSON.parse(await readFile(kit, "utf-8"));
    manifestPayload.clips[0].pronunciationPresetIds = ["brand:voxcpm2"];
    await writeFile(kit, `${JSON.stringify(manifestPayload, null, 2)}\n`, "utf-8");
    const profile = await writeReadyProfile();
    const validation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, { validationPath: path.join(tmpRoot, "transcript-validation.json") });
    await writeTranscriptValidation(profile, { validationPath: validation });
    const gatePath = await writeQualityGate(profile);
    await markQualityGateProfileReferenceReview(gatePath, "brand:voxcpm2");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        kit,
        "--json",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_profile_reference_recording");
    expect(payload.nextAction).toMatchObject({
      id: "record_quality_gate_profile_reference",
      phase: "quality_gate_repair",
      profileReferenceRepair: {
        presetIds: ["brand:voxcpm2"],
        clipIds: ["profile-clip-01"],
      },
    });
    expect(payload.nextAction.command).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextAction.command).toContain("--clip profile-clip-01");
    expect(payload.nextAction.command).toContain("--check-selected");
    expect(payload.nextAction.command).not.toContain("--record-missing-until-complete");
    expect(payload.nextAction.command).not.toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextAction.nonInteractiveCommand).toContain("--clip profile-clip-01");
    expect(payload.nextAction.nonInteractiveCommand).toContain("--yes");
    expect(payload.nextAction.nonInteractiveCommand).not.toContain("--open-cue-sheet");
    expect(payload.missingRecordingClips).toBeUndefined();
    expect(payload.recordingBrief).toBeUndefined();
  });

  it("runs preflight instead of recording focused quality-gate reference clips unless explicitly allowed", async () => {
    const kit = await writeKit({ withAudio: true });
    const manifestPayload = JSON.parse(await readFile(kit, "utf-8"));
    manifestPayload.clips[0].pronunciationPresetIds = ["brand:voxcpm2"];
    await writeFile(kit, `${JSON.stringify(manifestPayload, null, 2)}\n`, "utf-8");
    const profile = await writeReadyProfile();
    const validation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, { validationPath: path.join(tmpRoot, "transcript-validation.json") });
    await writeTranscriptValidation(profile, { validationPath: validation });
    const gatePath = await writeQualityGate(profile);
    await markQualityGateProfileReferenceReview(gatePath, "brand:voxcpm2");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        kit,
        "--run",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_profile_reference_recording");
    expect(payload.run).toMatchObject({
      status: "ran_preflight_instead_of_recording",
      actionId: "record_quality_gate_profile_reference",
      command: expect.stringContaining("--preflight"),
      result: {
        exitCode: 0,
      },
    });
  });

  it("uses the focused non-interactive command when quality-gate reference recording is explicitly allowed", async () => {
    const kit = await writeKit({ withAudio: true });
    const manifestPayload = JSON.parse(await readFile(kit, "utf-8"));
    manifestPayload.clips[0].pronunciationPresetIds = ["brand:voxcpm2"];
    await writeFile(kit, `${JSON.stringify(manifestPayload, null, 2)}\n`, "utf-8");
    const profile = await writeReadyProfile();
    const validation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, { validationPath: path.join(tmpRoot, "transcript-validation.json") });
    await writeTranscriptValidation(profile, { validationPath: validation });
    const gatePath = await writeQualityGate(profile);
    await markQualityGateProfileReferenceReview(gatePath, "brand:voxcpm2");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        validation,
        "--kit-manifest",
        kit,
        "--run",
        "--allow-recording",
        "--record-countdown-sec",
        "0",
      ],
      {
        env: {
          ...process.env,
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
          ANYVOICE_RECORDER_COMMAND: await writeFakeRecorder(),
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("needs_profile_reference_recording");
    expect(payload.run).toMatchObject({
      status: "ran",
      actionId: "record_quality_gate_profile_reference",
      command: expect.stringContaining("--clip profile-clip-01"),
      result: { exitCode: 0 },
    });
    expect(payload.run.command).toContain("--yes");
    expect(payload.run.command).not.toContain("--next-missing");
    expect(payload.run.command).not.toContain("--record-missing-until-complete");
    expect(payload.run.command).not.toContain("--open-cue-sheet");
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
    expect(payload.nextAction.secondaryCommands[2]).toContain("--min-clips 7");
    expect(payload.nextAction.secondaryCommands[2]).toContain("--min-total-duration-sec 60.0");
    expect(payload.nextAction.secondaryCommands[3]).toContain("--min-clips 7");
    expect(payload.nextAction.secondaryCommands[3]).toContain("--min-total-duration-sec 60.0");
    expect(payload.commands.qualityGateProductProof).toContain("--transcript-validation-json");
    expect(payload.commands.qualityGateProductProof).toContain(validation);
    expect(payload.commands.qualityGateProductProof).toContain("--asr-python /tmp/asrpy");
    expect(payload.commands.qualityGateProductProof).toContain("--speaker-python /tmp/voxpy");
    expect(payload.commands.validateTranscripts).toContain("/tmp/asrpy");
    expect(payload.commands.validateTranscripts).toContain("scripts/validate_voice_profile_transcripts.py");
    expect(payload.commands.enrollProfileKitAndValidate).toContain("--transcript-python /tmp/asrpy");
    expect(payload.commands.prepareLoraDataset).toContain("--require-product-proof-quality-gate");
    expect(payload.commands.prepareLoraDataset).toContain("--min-clips 7");
    expect(payload.commands.prepareLoraDataset).toContain("--min-total-duration-sec 60.0");
    expect(payload.commands.prepareLoraTrainingJob).toContain("--min-clips 7");
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
    expect(payload.commands.prepareBackendShootout).toContain("--backend voxcpm2-hifi");
    expect(payload.commands.prepareBackendShootout).toContain("--backend indextts2 --backend f5-tts");
    expect(payload.commands.prepareBackendShootout).toContain("--transcript-validation-json");
    expect(payload.commands.prepareBackendShootout).toContain(validation);
  });

  it("does not move to product proof when the hifi quality gate ASR artifact changed", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await tamperQualityGateAsrArtifact(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
  });

  it("does not move to product proof when the hifi quality gate source report has stale profile evidence", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await pointQualityGateSourceReportAtStaleProfileEvidence(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
  });

  it("does not move to product proof when the hifi quality gate source report has stale render output proof", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await pointQualityGateSourceReportAtStaleRenderOutput(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
  });

  it("does not move to product proof when the hifi quality gate source report omits render output proof", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await removeQualityGateSourceReportRenderOutputProof(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
  });

  it("does not move to product proof when the hifi quality gate score lacks enrollment-set speaker proof", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await removeQualityGateProfileReferenceSpeakerProof(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
  });

  it("does not move to product proof when the hifi quality gate score speaker verdict is not pass", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    await markQualityGateSpeakerIdentityForReview(gatePath);

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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
    expect(payload.qualityGate).toMatchObject({
      status: "pass",
      dryRun: false,
    });
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
    expect(payload.nextAction.command).toContain("--min-clips 7");
    expect(payload.nextAction.command).toContain("--min-total-duration-sec 60.0");
    expect(payload.nextAction.secondaryCommands).toEqual([
      expect.stringContaining("scripts/prepare_voxcpm_lora_training_job.py"),
      expect.stringContaining("scripts/prepare_voice_backend_shootout.py"),
      expect.stringContaining("scripts/register_voice_backend_renders.py"),
    ]);
    expect(payload.nextAction.secondaryCommands[0]).toContain("--min-clips 7");
    expect(payload.nextAction.secondaryCommands[0]).toContain("--min-total-duration-sec 60.0");
  });

  it("does not move to LoRA dataset export when the product-proof score consumed a stale ASR hash", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await pointQualityGateScoreAtStaleAsrHash(productGate);

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
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
  });

  it("moves to LoRA dataset export when paired product proof is artifact-backed without the legacy command flag", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await removeQualityGatePairedImprovementCommandFlag(productGate);

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
    expect(payload.productQualityGate.json).toBe(await realpath(productGate));
    expect(payload.nextAction).toMatchObject({
      id: "prepare_lora_dataset",
      phase: "lora_dataset",
    });
  });

  it("does not move to LoRA dataset export when product proof lacks paired improvement evidence", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await removeQualityGatePairedComparison(productGate);

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
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
  });

  it("does not move to LoRA dataset export when product proof regresses speaker similarity", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await regressQualityGatePairedSpeakerSimilarity(productGate);

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
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
  });

  it("does not move to LoRA dataset export when the product-proof score has stale profile evidence", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const productGate = await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await pointQualityGateScoreAtStaleProfileEvidence(productGate);

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
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
  });

  it("does not treat an adapter-loaded paired quality gate as the base product proof", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    await writeQualityGate(profile, { createdAt: "2026-01-04T00:00:00.000Z" });
    await writeQualityGate(profile, {
      cloneMode: "both",
      createdAt: "2026-01-05T00:00:00.000Z",
      loraPath: path.join(tmpRoot, "adapter", "lora_weights.ckpt"),
    });

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
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_product_proof_quality_gate",
      phase: "product_proof",
    });
  });

  it("does not advance from a stale product-proof quality gate after profile changes", async () => {
    const profile = await writeReadyProfile();
    await writeTranscriptValidation();
    await writeQualityGate(profile, { cloneMode: "both", createdAt: "2026-01-03T00:00:00.000Z" });
    const payloadBeforeChange = JSON.parse(await readFile(profile, "utf-8")) as Record<string, unknown>;
    payloadBeforeChange.auditMarker = "profile changed after product proof";
    await writeFile(profile, `${JSON.stringify(payloadBeforeChange, null, 2)}\n`, "utf-8");
    const currentValidation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, { validationPath: currentValidation });

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
    expect(payload.status).toBe("ready_for_quality_gate");
    expect(payload.qualityGate).toBeNull();
    expect(payload.productQualityGate).toBeNull();
    expect(payload.nextAction).toMatchObject({
      id: "run_quality_gate",
      phase: "quality_gate",
    });
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

  it("does not unlock product proof when the quality gate transcript proof has a stale profile hash", async () => {
    const profile = await writeReadyProfile();
    const currentValidation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, {
      profileSha256: await canonicalProfileSha256(profile),
      validationPath: currentValidation,
    });
    await writeTranscriptValidation(profile, { profileSha256: "0".repeat(64) });
    await writeQualityGate(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock product proof when the quality gate transcript proof omits profile hash evidence", async () => {
    const profile = await writeReadyProfile();
    const currentValidation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, {
      validationPath: currentValidation,
    });
    await writeTranscriptValidation(profile, { omitProfileSha256: true });
    await writeQualityGate(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock product proof when the quality gate transcript proof has stale clip rows", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const currentValidation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, {
      profileSha256,
      validationPath: currentValidation,
    });
    await writeTranscriptValidation(profile, {
      profileSha256,
      staleSourceRunId: "clip-2",
    });
    await writeQualityGate(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock product proof when the quality gate transcript proof has a stale voice profile id", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const currentValidation = path.join(path.dirname(profile), "transcript-validation.json");
    await writeTranscriptValidation(profile, {
      profileSha256,
      validationPath: currentValidation,
    });
    await writeTranscriptValidation(profile, {
      profileSha256,
      voiceProfileId: "other-profile",
    });
    await writeQualityGate(profile);

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock product proof when quality gate transcript proof paths disagree", async () => {
    const profile = await writeReadyProfile();
    const currentValidation = await writeTranscriptValidation(profile);
    const alternateValidation = path.join(tmpRoot, "alternate-transcript-validation.json");
    await writeTranscriptValidation(profile, { validationPath: alternateValidation });
    const gatePath = await writeQualityGate(profile);
    const gate = JSON.parse(await readFile(gatePath, "utf-8"));
    gate.inputs.transcriptValidationJson = alternateValidation;
    await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock product proof when the quality gate transcript proof file changed", async () => {
    const profile = await writeReadyProfile();
    const currentValidation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile);
    const validationPayload = JSON.parse(await readFile(currentValidation, "utf-8"));
    validationPayload.mutatedAfterQualityGate = true;
    await writeFile(currentValidation, `${JSON.stringify(validationPayload, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(
      python,
      [
        script,
        "--profile-json",
        profile,
        "--transcript-validation-json",
        currentValidation,
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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });

  it("does not unlock LoRA export when the latest pass gate omits transcript validation proof JSON", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation();
    const gatePath = await writeQualityGate(profile);
    const gate = JSON.parse(await readFile(gatePath, "utf-8"));
    delete gate.inputs.transcriptValidationJson;
    delete gate.proofs.transcriptValidationJson;
    delete gate.paths.profileTranscriptValidation;
    await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      proofs: { transcriptValidationPassed: true },
    });
    expect(payload.nextAction.id).toBe("run_quality_gate");
  });
});

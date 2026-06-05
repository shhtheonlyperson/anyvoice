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
const applyBackendSelectionScript = path.join(process.cwd(), "scripts", "apply_voice_backend_selection.py");
const applyLoraAdapterScript = path.join(process.cwd(), "scripts", "apply_voxcpm_lora_adapter.py");

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

function kitPronunciationPresetIds(index: number): string[] {
  if (index === 7) {
    return ["brand:voxcpm2"];
  }
  if (index === 8) {
    return ["polyphone:bank-president"];
  }
  return [];
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function canonicalProfileSha256(profilePath: string): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as Record<string, unknown>;
  delete profile.createdAt;
  delete profile.loraPath;
  delete profile.loraAdapter;
  delete profile.preferredBackend;
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

function readableLoraCheckpointProof(): Record<string, unknown> {
  return {
    checkpoint: {
      status: "readable",
      loraParameterKeyCount: 2,
      loraParameterKeys: ["encoder.lora_A.weight", "encoder.lora_B.weight"],
    },
  };
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

function baselineLabel(caseId: string, repeat: number): string {
  return candidateLabel(caseId, repeat) === "A" ? "B" : "A";
}

function backendCandidateLabel(caseId: string, repeat: number, baselineOutputWav: string, candidateOutputWav: string): string {
  const samples = [
    { cloneMode: "voxcpm2-hifi", outputWav: baselineOutputWav },
    { cloneMode: "indextts2", outputWav: candidateOutputWav },
  ].sort((a, b) =>
    blindOrderKey(caseId, repeat, a.cloneMode, a.outputWav).localeCompare(
      blindOrderKey(caseId, repeat, b.cloneMode, b.outputWav),
    ),
  );
  return samples.findIndex((sample) => sample.cloneMode === "indextts2") === 0 ? "A" : "B";
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
      pronunciationPresetIds: kitPronunciationPresetIds(index),
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
        version: 1,
        profile: profilePath,
        profileSha256: await canonicalProfileSha256(profilePath),
        voiceProfileId: (profile as { voiceProfileId?: string }).voiceProfileId,
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

async function writeQualityGate(
  profilePath: string,
  mode: "hifi" | "both",
  createdAt: string,
  { loraPath, gateName }: { loraPath?: string; gateName?: string } = {},
): Promise<string> {
  const gateDir = path.join(tmpRoot, "quality-gates", gateName ?? mode);
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  const reportPath = path.join(gateDir, "report.json");
  const asrPath = path.join(gateDir, "asr.json");
  const speakerPath = path.join(gateDir, "speaker.json");
  const scorePath = path.join(gateDir, "score.json");
  const transcriptValidationJson = path.join(path.dirname(profilePath), "transcript-validation.json");
  try {
    await readFile(transcriptValidationJson);
  } catch {
    await writeTranscriptValidation(profilePath);
  }
  const transcriptValidationSha256 = await sha256File(transcriptValidationJson);
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const profileEvidence = { voiceProfileId: profile.voiceProfileId, profileSha256 };
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
  const oneSecondWav = wavBuffer(1);
  const oneSecondWavProof = {
    outputExists: true,
    missingOutput: false,
    outputBytes: oneSecondWav.byteLength,
    outputSha256: createHash("sha256").update(oneSecondWav).digest("hex"),
  };
  if (mode === "both") {
    for (const cloneMode of ["prompt", "hifi"]) {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        await writeFile(path.join(gateDir, `${cloneMode}-r${String(repeat).padStart(2, "0")}.wav`), oneSecondWav);
      }
    }
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          version: 1,
          voiceProfile: profileEvidence,
          groups: [
            {
              ...profileEvidence,
              cloneMode: "prompt",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [1, 2, 3, 4, 5].map((repeat) => ({
                ...profileEvidence,
                repeat,
                status: "ready",
                outputWav: `prompt-r${String(repeat).padStart(2, "0")}.wav`,
                ...oneSecondWavProof,
              })),
            },
            {
              ...profileEvidence,
              cloneMode: "hifi",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [1, 2, 3, 4, 5].map((repeat) => ({
                ...profileEvidence,
                repeat,
                status: "ready",
                outputWav: `hifi-r${String(repeat).padStart(2, "0")}.wav`,
                ...oneSecondWavProof,
                ...renderMetadata,
              })),
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  } else {
    await writeFile(path.join(gateDir, "hifi-r01.wav"), oneSecondWav);
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          version: 1,
          voiceProfile: profileEvidence,
          groups: [
            {
              ...profileEvidence,
              cloneMode: "hifi",
              case: { id: "zh_hant_polyphones", text: "重慶角色" },
              renders: [
                {
                  ...profileEvidence,
                  repeat: 1,
                  status: "ready",
                  outputWav: "hifi-r01.wav",
                  ...oneSecondWavProof,
                  ...renderMetadata,
                },
              ],
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
    asrPath,
    `${JSON.stringify({ "hifi/zh_hant_polyphones/r01": "重慶角色" }, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    speakerPath,
    `${JSON.stringify({ version: 1, backend: "speechbrain-ecapa", summary: { total: 1, scored: 1, failed: 0 } }, null, 2)}\n`,
    "utf-8",
  );
  const reportSha256 = await sha256File(reportPath);
  const asrSha256 = await sha256File(asrPath);
  const speakerSha256 = await sha256File(speakerPath);
  await writeFile(
    scorePath,
    `${JSON.stringify(
      {
        version: 1,
        verdict: "pass",
        sourceReport: reportPath,
        sourceReportSha256: reportSha256,
        asrJson: asrPath,
        asrJsonSha256: asrSha256,
        speakerJson: speakerPath,
        speakerJsonSha256: speakerSha256,
        thresholds: {
          requireSpeakerSimilarity: true,
          requireProfileReferenceSimilarity: true,
        },
        voiceProfile: profileEvidence,
        summary: {
          groups: mode === "both" ? 2 : 1,
          passingGroups: mode === "both" ? 2 : 1,
          avgCer: 0,
          avgWer: 0,
          avgSpeakerSimilarity: 0.9,
          speakerReviewGroups: 0,
        },
        pairedComparison: mode === "both"
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
                blockingPairs: 0,
                avgCerReductionPct: 90,
                avgWerReductionPct: 88,
                avgSpeakerSimilarityDelta: 0.01,
                avgLatencyRegressionPct: 0,
              },
            }
          : undefined,
        groups: [
          {
            ...profileEvidence,
            cloneMode: mode === "both" ? "prompt" : "hifi",
            renderCount: 1,
            verdict: "pass",
            speakerIdentityVerdict: "pass",
            speakerIdentity: {
              verdict: "pass",
              avgSpeakerSimilarity: 0.9,
              profileReferenceEvaluatedRenders: 1,
              requireProfileReferenceSimilarity: true,
            },
            renders: [
              {
                ...profileEvidence,
                repeat: 1,
                status: "ready",
                outputWav: mode === "both" ? "prompt-r01.wav" : "hifi-r01.wav",
                ...oneSecondWavProof,
              },
            ],
          },
          ...(mode === "both"
            ? [
                {
                  ...profileEvidence,
                  cloneMode: "hifi",
                  renderCount: 1,
                  verdict: "pass",
                  speakerIdentityVerdict: "pass",
                  speakerIdentity: {
                    verdict: "pass",
                    avgSpeakerSimilarity: 0.9,
                    profileReferenceEvaluatedRenders: 1,
                    requireProfileReferenceSimilarity: true,
                  },
                  renders: [
                    {
                      ...profileEvidence,
                      repeat: 1,
                      status: "ready",
                      outputWav: "hifi-r01.wav",
                      ...oneSecondWavProof,
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const scoreSha256 = await sha256File(scorePath);
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
          profileSha256,
          cloneMode: mode,
          requireSpeakerBackend: mode === "both" ? "speechbrain-ecapa" : null,
          transcriptValidationJson,
          transcriptValidationSha256,
          skipProfileVerify: false,
          skipTranscriptValidation: false,
          ...(loraPath ? { loraPath } : {}),
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          profileVerifySkipped: false,
          transcriptValidationRequired: true,
          transcriptValidationJson,
          transcriptValidationSha256,
          transcriptValidationPassed: true,
          transcriptValidationSkipped: false,
          speakerBackendRequirement:
            mode === "both"
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
            mode === "both"
              ? "python3 scripts/score_voice_regression.py --baseline-clone-mode prompt --candidate-clone-mode hifi --require-paired-improvement"
              : "python3 scripts/score_voice_regression.py",
        },
        paths: {
          qualityGate: gatePath,
          report: reportPath,
          asr: asrPath,
          speaker: speakerPath,
          score: scorePath,
          profileTranscriptValidation: transcriptValidationJson,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return gatePath;
}

async function pointQualityGateAtStaleTranscriptValidation(gatePath: string, validationPath: string): Promise<string> {
  const staleValidationPath = path.join(path.dirname(gatePath), "stale-transcript-validation.json");
  const staleValidation = JSON.parse(await readFile(validationPath, "utf-8"));
  staleValidation.profileSha256 = "0".repeat(64);
  await writeFile(staleValidationPath, `${JSON.stringify(staleValidation, null, 2)}\n`, "utf-8");
  await pointQualityGateAtTranscriptValidation(gatePath, staleValidationPath);
  return staleValidationPath;
}

async function pointQualityGateAtStaleTranscriptVoiceProfileId(gatePath: string, validationPath: string): Promise<string> {
  const staleValidationPath = path.join(path.dirname(gatePath), "stale-transcript-validation-voice-profile-id.json");
  const staleValidation = JSON.parse(await readFile(validationPath, "utf-8"));
  staleValidation.voiceProfileId = "other-profile";
  await writeFile(staleValidationPath, `${JSON.stringify(staleValidation, null, 2)}\n`, "utf-8");
  await pointQualityGateAtTranscriptValidation(gatePath, staleValidationPath);
  return staleValidationPath;
}

async function pointQualityGateAtStaleTranscriptRows(gatePath: string, validationPath: string): Promise<string> {
  const staleValidationPath = path.join(path.dirname(gatePath), "stale-transcript-validation-rows.json");
  const staleValidation = JSON.parse(await readFile(validationPath, "utf-8"));
  staleValidation.clips[1].expectedTranscript = "這是一段已經過期的逐字稿。";
  await writeFile(staleValidationPath, `${JSON.stringify(staleValidation, null, 2)}\n`, "utf-8");
  await pointQualityGateAtTranscriptValidation(gatePath, staleValidationPath);
  return staleValidationPath;
}

async function pointQualityGateAtTranscriptValidation(gatePath: string, transcriptValidationPath: string): Promise<void> {
  const staleValidationSha256 = await sha256File(transcriptValidationPath);
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  gate.inputs.transcriptValidationJson = transcriptValidationPath;
  gate.inputs.transcriptValidationSha256 = staleValidationSha256;
  gate.proofs.transcriptValidationJson = transcriptValidationPath;
  gate.proofs.transcriptValidationSha256 = staleValidationSha256;
  gate.paths.profileTranscriptValidation = transcriptValidationPath;
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function tamperQualityGateAsrArtifact(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  await writeFile(gate.paths.asr, `${JSON.stringify({ stale: "asr changed after scoring" }, null, 2)}\n`, "utf-8");
}

async function markQualityGateScoreReview(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.verdict = "review";
  score.summary = {
    ...score.summary,
    passingGroups: 0,
    speakerReviewGroups: 1,
    profileReferenceReviewGroups: 1,
  };
  score.groups[0] = {
    ...score.groups[0],
    caseId: "zh_hant_polyphones",
    verdict: "review",
    speakerIdentityVerdict: "review",
    profileReferenceVerdict: "review",
    avgCer: 0,
    avgWer: 0,
    speakerIdentity: {
      ...score.groups[0].speakerIdentity,
      verdict: "review",
      minSpeakerSimilarityObserved: 0.61,
      reasons: ["min_similarity_below_threshold"],
    },
    renders: (score.groups[0].renders ?? []).map((render: Record<string, unknown>) => ({
      ...render,
      asrTranscript: "請整理 Vox C P M two 的測試結果。",
      scoringTarget: { kind: "raw", text: "請整理 VoxCPM2 的測試結果。" },
    })),
    profileReference: {
      verdict: "review",
      evaluatedRenders: 1,
      missingByRender: [
        {
          caseId: "zh_hant_polyphones",
          repeat: 1,
          profileClipId: "clip-1",
          missingPronunciationPresetIds: ["brand:voxcpm2"],
        },
        {
          caseId: "zh_hant_polyphones",
          repeat: 1,
          profileClipId: "clip-1",
          missingPronunciationPresetIds: ["polyphone:bank-president"],
        },
      ],
    },
  };
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function markQualityGateModelCapabilityReview(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.verdict = "review";
  score.summary = {
    ...score.summary,
    passingGroups: 0,
    speakerReviewGroups: 1,
    profileReferenceReviewGroups: 0,
  };
  score.groups[0] = {
    ...score.groups[0],
    caseId: "zh_hant_tone_contrast",
    verdict: "review",
    pronunciationVerdict: "review",
    speakerIdentityVerdict: "review",
    profileReferenceVerdict: "not_evaluated",
    avgCer: 0.176471,
    avgWer: 0.176471,
    speakerIdentity: {
      ...score.groups[0].speakerIdentity,
      verdict: "review",
      avgSpeakerSimilarity: 0.55,
      minSpeakerSimilarityObserved: 0.55,
      reasons: ["min_similarity_below_threshold"],
    },
    renders: (score.groups[0].renders ?? []).map((render: Record<string, unknown>) => ({
      ...render,
      caseId: "zh_hant_tone_contrast",
      asrTranscript: "妈妈妈妈妈,买卖慢慢来,明明没有那么难。",
      scoringTarget: { kind: "raw", text: "媽媽罵馬嗎？買賣慢慢來，明明沒有那麼難。" },
    })),
    profileReference: {
      verdict: "not_evaluated",
      evaluatedRenders: 0,
      missingByRender: [],
    },
  };
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function writeBackendShootoutPlan(profilePath: string, root = path.join(tmpRoot, "backend-shootouts")): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const outDir = path.join(root, "2026-01-03");
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  const renderScript = path.join(outDir, "render.sh");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      renders: [
        {
          backend: "indextts2",
          caseId: "zh_hant_tone_contrast",
          repeat: 1,
          rendererStatus: "needs_renderer_command",
          commandTemplateEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
          voiceProfileId: profile.voiceProfileId,
          profileSha256,
          outputWav: path.join(outDir, "renders", "indextts2", "tone.wav"),
        },
      ],
    }, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(renderScript, "#!/usr/bin/env bash\nexit 64\n", "utf-8");
  return renderScript;
}

async function markQualityGatePartialCase(gatePath: string, caseId = "zh_hant_polyphones"): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  gate.inputs.case = [caseId];
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleAsrHash(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.asrJsonSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeQualityGatePairedComparison(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  delete score.pairedComparison;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
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
  score.pairedComparison.summary.avgSpeakerSimilarityDelta = -0.01;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function markQualityGateScoreSpeakerIdentityForReview(gatePath: string): Promise<void> {
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
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function removeLoraRenderEvidenceFromQualityGate(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
  delete report.groups[0].renders[0].metadataJson;
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(gate.paths.report, reportText, "utf-8");
  const reportSha256 = sha256Text(reportText);

  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function rebindProfileLoraQualityGateHash(profilePath: string, gatePath: string): Promise<void> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  profile.loraAdapter.qualityGateSha256 = await sha256File(gatePath);
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtRelativeArtifactPaths(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  const scoreDir = path.dirname(gate.paths.score);
  score.sourceReport = path.relative(scoreDir, gate.paths.report);
  score.asrJson = path.relative(scoreDir, gate.paths.asr);
  score.speakerJson = path.relative(scoreDir, gate.paths.speaker);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function makeLoraProofChainPortable(profilePath: string): Promise<void> {
  const jobDir = path.join(tmpRoot, "lora-jobs", "local-test");
  const outputDir = path.join(jobDir, "output");
  const trainConfigPath = path.join(jobDir, "train_config.json");
  const adapterProofPath = path.join(outputDir, "adapter-proof.json");
  const adapterPath = path.join(outputDir, "lora_weights.ckpt");
  const loraGatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");

  const trainConfig = JSON.parse(await readFile(trainConfigPath, "utf-8"));
  trainConfig.profilePath = path.relative(jobDir, profilePath);
  trainConfig.lora.expectedWeights = path.relative(jobDir, adapterPath);
  trainConfig.lora.adapterProof = path.relative(jobDir, adapterProofPath);
  await writeFile(trainConfigPath, `${JSON.stringify(trainConfig, null, 2)}\n`, "utf-8");
  const trainConfigSha256 = await sha256File(trainConfigPath);

  const adapterProof = JSON.parse(await readFile(adapterProofPath, "utf-8"));
  adapterProof.adapter.path = path.relative(outputDir, adapterPath);
  adapterProof.profilePath = path.relative(outputDir, profilePath);
  adapterProof.trainConfig = path.relative(outputDir, trainConfigPath);
  adapterProof.trainConfigSha256 = trainConfigSha256;
  await writeFile(adapterProofPath, `${JSON.stringify(adapterProof, null, 2)}\n`, "utf-8");

  await pointQualityGateScoreAtRelativeArtifactPaths(loraGatePath);
  const gate = JSON.parse(await readFile(loraGatePath, "utf-8"));
  const gateDir = path.dirname(loraGatePath);
  gate.inputs.profileJson = path.relative(gateDir, profilePath);
  gate.inputs.loraPath = path.relative(gateDir, adapterPath);
  gate.proofs.loraAdapter.path = path.relative(gateDir, adapterPath);
  await writeFile(loraGatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function makePersistedLoraPolicyPortable(profilePath: string): Promise<void> {
  const profileDir = path.dirname(profilePath);
  const resolvedProfileDir = await realpath(profileDir);
  const relativeToProfile = async (targetPath: string): Promise<string> =>
    path.relative(resolvedProfileDir, await realpath(targetPath));
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  const policy = profile.loraAdapter;
  if (!policy || typeof policy !== "object") {
    throw new Error("profile does not have an applied LoRA policy");
  }
  for (const key of ["loraPath"] as const) {
    if (typeof profile[key] === "string") {
      profile[key] = await relativeToProfile(profile[key]);
    }
  }
  for (const key of ["profileJson", "path", "adapterProofJson", "qualityGateJson", "trainConfig"] as const) {
    if (typeof policy[key] === "string") {
      policy[key] = await relativeToProfile(policy[key]);
    }
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

async function makePersistedBackendPolicyPortable(profilePath: string): Promise<void> {
  const profileDir = path.dirname(profilePath);
  const resolvedProfileDir = await realpath(profileDir);
  const relativeToProfile = async (targetPath: string): Promise<string> =>
    path.relative(resolvedProfileDir, await realpath(targetPath));
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  const policy = profile.preferredBackend;
  if (!policy || typeof policy !== "object") {
    throw new Error("profile does not have an applied backend policy");
  }
  for (const key of ["profileJson", "selectionJson", "scoreJson", "reviewJson", "sourceReport"] as const) {
    if (typeof policy[key] === "string") {
      policy[key] = await relativeToProfile(policy[key]);
    }
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

async function makeLoraDatasetProofsPortable(datasetJson: string): Promise<void> {
  const datasetDir = path.dirname(datasetJson);
  const dataset = JSON.parse(await readFile(datasetJson, "utf-8"));
  for (const key of ["transcriptValidationJson", "qualityGateJson"] as const) {
    if (typeof dataset.proofs?.[key] === "string") {
      dataset.proofs[key] = path.relative(datasetDir, dataset.proofs[key]);
    }
  }
  await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");
}

async function makeLoraDatasetProfilePathPortable(datasetJson: string): Promise<void> {
  const datasetDir = path.dirname(datasetJson);
  const dataset = JSON.parse(await readFile(datasetJson, "utf-8"));
  if (typeof dataset.profilePath === "string") {
    dataset.profilePath = path.relative(datasetDir, dataset.profilePath);
  }
  await writeFile(datasetJson, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");
}

async function pointQualityGateScoreAtStaleProfileEvidence(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.voiceProfile.profileSha256 = "0".repeat(64);
  score.groups[0].profileSha256 = "0".repeat(64);
  score.groups[0].renders[0].profileSha256 = "0".repeat(64);
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function pointQualityGateReportAtStaleProfileEvidence(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const report = JSON.parse(await readFile(gate.paths.report, "utf-8"));
  report.groups[0].renders[0].voiceProfileId = "other-profile";
  await writeFile(gate.paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  const reportSha256 = await sha256File(gate.paths.report);
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
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
  await rebindQualityGateReportArtifact(gatePath);
}

async function rebindQualityGateReportArtifact(gatePath: string): Promise<void> {
  const gate = JSON.parse(await readFile(gatePath, "utf-8"));
  const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
  const reportSha256 = await sha256File(gate.paths.report);
  score.sourceReportSha256 = reportSha256;
  await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
  gate.proofs.artifacts.report.sha256 = reportSha256;
  gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
  await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");
}

async function writeLoraQualityGate(profilePath: string, adapterPath: string): Promise<string> {
  const gateDir = path.join(tmpRoot, "quality-gates", "lora");
  await mkdir(gateDir, { recursive: true });
  const gatePath = path.join(gateDir, "quality-gate.json");
  const reportPath = path.join(gateDir, "report.json");
  const asrPath = path.join(gateDir, "asr.json");
  const speakerPath = path.join(gateDir, "speaker.json");
  const scorePath = path.join(gateDir, "score.json");
  const outputWav = path.join(gateDir, "lora-hifi-r01.wav");
  const outputAudio = Buffer.from("lora hifi rendered wav bytes\n");
  await writeFile(outputWav, outputAudio);
  const outputSha256 = createHash("sha256").update(outputAudio).digest("hex");
  const adapterBytes = (await readFile(adapterPath)).byteLength;
  const adapterSha256 = await sha256File(adapterPath);
  const transcriptValidationJson = path.join(path.dirname(profilePath), "transcript-validation.json");
  try {
    await readFile(transcriptValidationJson);
  } catch {
    await writeTranscriptValidation(profilePath);
  }
  const transcriptValidationSha256 = await sha256File(transcriptValidationJson);
  const profile = JSON.parse(await readFile(profilePath, "utf-8"));
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const profileEvidence = { voiceProfileId: profile.voiceProfileId, profileSha256 };
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        version: 1,
        voiceProfile: profileEvidence,
        groups: [
          {
            ...profileEvidence,
            cloneMode: "hifi",
            case: { id: "zh_hant_polyphones", text: "重慶角色" },
            renders: [
              {
                ...profileEvidence,
                repeat: 1,
                status: "ready",
                outputWav,
                outputExists: true,
                missingOutput: false,
                outputBytes: outputAudio.byteLength,
                outputSha256,
                metadataJson: {
                  effectiveParams: {
                    cloneMode: "hifi",
                    loraEnabled: true,
                    loraPath: adapterPath,
                  },
                },
              },
            ],
          },
        ],
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
  const reportSha256 = await sha256File(reportPath);
  const asrSha256 = await sha256File(asrPath);
  const speakerSha256 = await sha256File(speakerPath);
  await writeFile(
    scorePath,
    `${JSON.stringify(
      {
        version: 1,
        verdict: "pass",
        sourceReport: reportPath,
        sourceReportSha256: reportSha256,
        asrJson: asrPath,
        asrJsonSha256: asrSha256,
        speakerJson: speakerPath,
        speakerJsonSha256: speakerSha256,
        thresholds: {
          requireSpeakerSimilarity: true,
          requireProfileReferenceSimilarity: true,
        },
        voiceProfile: profileEvidence,
        summary: { groups: 1, passingGroups: 1, avgCer: 0, avgWer: 0, avgSpeakerSimilarity: 0.9, speakerReviewGroups: 0 },
        groups: [
          {
            ...profileEvidence,
            cloneMode: "hifi",
            renderCount: 1,
            verdict: "pass",
            speakerIdentityVerdict: "pass",
            speakerIdentity: {
              verdict: "pass",
              avgSpeakerSimilarity: 0.9,
              profileReferenceEvaluatedRenders: 1,
              requireProfileReferenceSimilarity: true,
            },
            renders: [
              {
                ...profileEvidence,
                repeat: 1,
                status: "ready",
                outputWav,
                outputExists: true,
                missingOutput: false,
                outputBytes: outputAudio.byteLength,
                outputSha256,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const scoreSha256 = await sha256File(scorePath);
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
          profileSha256,
          cloneMode: "hifi",
          loraPath: adapterPath,
          requireSpeakerBackend: "speechbrain-ecapa",
          transcriptValidationJson,
          transcriptValidationSha256,
          skipProfileVerify: false,
          skipTranscriptValidation: false,
        },
        proofs: {
          profileVerifyRequired: true,
          profileVerifyPassed: true,
          profileVerifySkipped: false,
          transcriptValidationRequired: true,
          transcriptValidationJson,
          transcriptValidationSha256,
          transcriptValidationPassed: true,
          transcriptValidationSkipped: false,
          speakerBackendRequirement: { requested: "auto", selected: "speechbrain-ecapa", required: "speechbrain-ecapa" },
          loraAdapter: { path: adapterPath, exists: true, bytes: adapterBytes, sha256: adapterSha256 },
          artifacts: {
            report: { path: reportPath, sha256: reportSha256 },
            asr: { path: asrPath, sha256: asrSha256 },
            speaker: { path: speakerPath, sha256: speakerSha256 },
            score: { path: scorePath, sha256: scoreSha256 },
          },
        },
        commands: {
          score: "python3 scripts/score_voice_regression.py",
        },
        paths: {
          qualityGate: gatePath,
          report: reportPath,
          asr: asrPath,
          speaker: speakerPath,
          score: scorePath,
          profileTranscriptValidation: transcriptValidationJson,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return gatePath;
}

async function writeSubjectiveReview(reportPath: string, candidateWins = 5, baselineWins = 0): Promise<void> {
  const choices: Record<string, string> = {};
  for (let repeat = 1; repeat <= 5; repeat += 1) {
    const key = `winner-zh_hant_polyphones-r${String(repeat).padStart(2, "0")}`;
    if (repeat <= baselineWins) {
      choices[key] = baselineLabel("zh_hant_polyphones", repeat);
    } else if (repeat <= baselineWins + candidateWins) {
      choices[key] = candidateLabel("zh_hant_polyphones", repeat);
    } else {
      choices[key] = "tie";
    }
  }
  const reportText = await readFile(reportPath, "utf-8");
  const reportSha256 = sha256Text(reportText);
  const total = 5;
  const ties = Math.max(0, total - candidateWins - baselineWins);
  const stats = {
    rounds: total,
    reviewedRounds: total,
    candidateWins,
    baselineWins,
    ties,
    rerenders: 0,
    candidateWinRate: Number((candidateWins / total).toFixed(4)),
    minCandidateWinRate: 0.8,
    reportSha256,
  };
  await writeFile(
    path.join(path.dirname(reportPath), "review.json"),
    `${JSON.stringify(
      {
        version: 1,
        status: "pass",
        report: reportPath,
        reportPath,
        reportSha256,
        expectedSaveAs: path.join(path.dirname(reportPath), "review.json"),
        choiceKeys: Object.keys(choices),
        reviewedAt: "2026-01-04T00:00:00.000Z",
        stats,
        choices,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeReplacementSubjectiveReport(
  reportPath: string,
  { withReview = false }: { withReview?: boolean } = {},
): Promise<string> {
  const reportDir = path.dirname(reportPath);
  await mkdir(reportDir, { recursive: true });
  const oneSecondWav = wavBuffer(1);
  await writeFile(path.join(reportDir, "prompt-r01.wav"), oneSecondWav);
  await writeFile(path.join(reportDir, "hifi-r01.wav"), oneSecondWav);
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-04T00:00:00.000Z",
        groups: [
          {
            cloneMode: "prompt",
            case: { id: "zh_hant_polyphones", text: "重慶角色" },
            renders: [
              {
                repeat: 1,
                status: "ready",
                outputWav: "prompt-r01.wav",
              },
            ],
          },
          {
            cloneMode: "hifi",
            case: { id: "zh_hant_polyphones", text: "重慶角色" },
            renders: [
              {
                repeat: 1,
                status: "ready",
                outputWav: "hifi-r01.wav",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(reportPath.replace(/\.json$/, ".html"), "<!doctype html><h1>review</h1>\n", "utf-8");
  if (withReview) {
    const reportText = await readFile(reportPath, "utf-8");
    const reportSha256 = sha256Text(reportText);
    const reviewPath = path.join(reportDir, "review.json");
    await writeFile(
      reviewPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          reasons: [],
          report: reportPath,
          reportPath,
          reportSha256,
          expectedSaveAs: reviewPath,
          choiceKeys: ["winner-zh_hant_polyphones-r01"],
          reviewedAt: "2026-01-04T00:00:00.000Z",
          stats: {
            rounds: 1,
            reviewedRounds: 1,
            candidateWins: 0,
            baselineWins: 0,
            ties: 1,
            rerenders: 0,
            candidateWinRate: 0,
            minCandidateWinRate: 0.8,
            reportSha256,
          },
          missingChoices: [],
          invalidChoices: [],
          choices: {
            "winner-zh_hant_polyphones-r01": "tie",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
  return reportPath;
}

async function writeLoraArtifacts(
  profilePath: string,
  validation: string,
  qualityGate: string,
  options: { adapterProof?: boolean; trainerCommand?: string; loraQualityGate?: boolean; applyLora?: boolean } = {},
): Promise<void> {
  const includeAdapterProof = options.adapterProof !== false;
  const includeLoraQualityGate = options.loraQualityGate !== false;
  const applyLora = options.applyLora !== false;
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as {
    clips: Array<{ sourceRunId: string; audioPath: string; transcriptRaw: string; quality?: { durationSec?: number } }>;
  };
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const transcriptValidationSha256 = await sha256File(validation);
  const qualityGateSha256 = await sha256File(qualityGate);
  const totalClips = profile.clips.length;
  const totalDurationSec = profile.clips.reduce((sum, clip) => sum + (clip.quality?.durationSec ?? 0), 0);
  const datasetDir = path.join(tmpRoot, "lora-datasets", "local-test");
  await mkdir(datasetDir, { recursive: true });
  const datasetJson = path.join(datasetDir, "dataset.json");
  const rows = await Promise.all(
    profile.clips.map(async (clip) => ({
      dataset_id: `local-test/${clip.sourceRunId}`,
      sourceRunId: clip.sourceRunId,
      audio: clip.audioPath,
      profileAudioPath: clip.audioPath,
      text: clip.transcriptRaw,
      durationSec: clip.quality?.durationSec ?? 0,
      audioSha256: await sha256File(clip.audioPath),
      transcriptSha256: sha256Text(clip.transcriptRaw),
    })),
  );
  const trainManifest = path.join(datasetDir, "manifest.train.jsonl");
  const valManifest = path.join(datasetDir, "manifest.val.jsonl");
  const allManifest = path.join(datasetDir, "manifest.all.jsonl");
  const trainRows = rows.slice(0, Math.max(1, rows.length - 2));
  const valRows = rows.slice(Math.max(1, rows.length - 2));
  const jsonl = (items: unknown[]) => `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await writeFile(trainManifest, jsonl(trainRows), "utf-8");
  await writeFile(valManifest, jsonl(valRows), "utf-8");
  await writeFile(allManifest, jsonl(rows), "utf-8");
  await writeFile(
    datasetJson,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-05T00:00:00.000Z",
        profilePath,
        profileSha256,
        voiceProfileId: "local-test",
        totalClips,
        totalDurationSec,
        manifests: {
          train: trainManifest,
          val: valManifest,
          all: allManifest,
        },
        proofs: {
          transcriptValidationJson: validation,
          transcriptValidationSha256,
          qualityGateJson: qualityGate,
          qualityGateSha256,
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
  let trainerCommand = options.trainerCommand?.replace(/^python\s+/, `${shellQuote(python)} `);
  if (trainerCommand?.includes("train_voxcpm_lora.py")) {
    const fakeTrainer = path.join(jobDir, "train_voxcpm_lora.py");
    await writeFile(fakeTrainer, "print('fake trainer')\n", "utf-8");
    trainerCommand = trainerCommand.replace("train_voxcpm_lora.py", shellQuote(fakeTrainer));
  }
  const adapterProof = path.join(outputDir, "adapter-proof.json");
  const adapterPath = path.join(outputDir, "lora_weights.ckpt");
  const trainConfig = path.join(jobDir, "train_config.json");
  await writeFile(
    trainConfig,
    `${JSON.stringify(
      {
        version: 1,
        createdAt: "2026-01-06T00:00:00.000Z",
        datasetJson,
        profilePath,
        voiceProfileId: "local-test",
        dataset: {
          json: datasetJson,
          trainClips: trainRows.length,
          valClips: valRows.length,
          totalClips,
          trainDurationSec: trainRows.reduce((sum, row) => sum + (row.durationSec ?? 0), 0),
          valDurationSec: valRows.reduce((sum, row) => sum + (row.durationSec ?? 0), 0),
          totalDurationSec,
          minClips: 10,
          minTotalDurationSec: 60,
        },
        datasetProofs: {
          acceptedUnsafeDataset: false,
          productProofQualityGateRequired: true,
          profileSha256,
          transcriptValidationJson: validation,
          transcriptValidationSha256,
          qualityGateJson: qualityGate,
          qualityGateSha256,
        },
        manifests: {
          train: trainManifest,
          val: valManifest,
          all: allManifest,
        },
        lora: { expectedWeights: adapterPath, adapterProof, rank: 32, alpha: 16, dropout: 0 },
        trainer: {
          status: trainerCommand ? "ready" : "needs_trainer_command",
          commandTemplate: trainerCommand || null,
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
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: {
            acceptedUnsafeDataset: false,
            productProofQualityGateRequired: true,
            profileSha256,
            transcriptValidationJson: validation,
            transcriptValidationSha256,
            qualityGateJson: qualityGate,
            qualityGateSha256,
          },
          trainConfig,
          trainConfigSha256,
          profilePath,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    if (includeLoraQualityGate) {
      const loraQualityGate = await writeLoraQualityGate(profilePath, adapterPath);
      if (applyLora) {
        await execFileAsync(python, [
          applyLoraAdapterScript,
          adapterProof,
          "--quality-gate-json",
          loraQualityGate,
          "--profile-json",
          profilePath,
        ]);
      }
    }
  }
}

async function writeMinimalBoundTrainConfig(
  trainConfig: string,
  adapterPath: string,
  profileSha256: string,
): Promise<void> {
  const datasetDir = path.join(path.dirname(trainConfig), "dataset");
  await mkdir(datasetDir, { recursive: true });
  const manifestRow = {
    audio: adapterPath,
    audioSha256: sha256Text("fake adapter\n"),
    text: "這是一段合格聲音。",
    transcriptSha256: sha256Text("這是一段合格聲音。"),
    sourceRunId: "clip-1",
    profileAudioPath: adapterPath,
    durationSec: 7,
  };
  const trainManifest = path.join(datasetDir, "manifest.train.jsonl");
  const valManifest = path.join(datasetDir, "manifest.val.jsonl");
  const allManifest = path.join(datasetDir, "manifest.all.jsonl");
  await writeFile(trainManifest, `${JSON.stringify(manifestRow)}\n`, "utf-8");
  await writeFile(valManifest, `${JSON.stringify(manifestRow)}\n`, "utf-8");
  await writeFile(allManifest, `${JSON.stringify(manifestRow)}\n`, "utf-8");
  const datasetJson = path.join(datasetDir, "dataset.json");
  await writeFile(
    datasetJson,
    `${JSON.stringify(
      {
        version: 1,
        manifests: {
          train: trainManifest,
          val: valManifest,
          all: allManifest,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    trainConfig,
    `${JSON.stringify(
      {
        version: 1,
        datasetJson,
        datasetProofs: {
          acceptedUnsafeDataset: false,
          profileSha256,
          productProofQualityGateRequired: true,
        },
        manifests: {
          train: trainManifest,
          val: valManifest,
          all: allManifest,
        },
        lora: { expectedWeights: adapterPath },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeBackendSelection(
  profilePath: string,
  {
    apply = true,
    selectionId = "accepted",
    createdAt = "2026-01-08T00:00:00.000Z",
  }: { apply?: boolean; selectionId?: string; createdAt?: string } = {},
): Promise<string> {
  const profile = JSON.parse(await readFile(profilePath, "utf-8")) as { voiceProfileId?: string };
  const voiceProfileId = profile.voiceProfileId || "local-test";
  const profileSha256 = await canonicalProfileSha256(profilePath);
  const selectionDir = path.join(tmpRoot, "backend-selection", selectionId);
  await mkdir(selectionDir, { recursive: true });
  const sourceReport = path.join(selectionDir, "indextts2.report.json");
  const scorePath = path.join(selectionDir, "indextts2.score.json");
  const selectionPath = path.join(selectionDir, "indextts2.selection.json");
  const baselineOutputWav = path.join(selectionDir, "voxcpm2.wav");
  const candidateOutputWav = path.join(selectionDir, "indextts2.wav");
  const baselineAudio = Buffer.from("baseline backend wav bytes\n");
  const candidateAudio = Buffer.from("candidate backend wav bytes\n");
  await writeFile(baselineOutputWav, baselineAudio);
  await writeFile(candidateOutputWav, candidateAudio);
  const baselineSha256 = createHash("sha256").update(baselineAudio).digest("hex");
  const candidateSha256 = createHash("sha256").update(candidateAudio).digest("hex");
  const reportText = `${JSON.stringify(
    {
      version: 1,
      voiceProfile: {
        voiceProfileId,
        profileSha256,
      },
      groups: [
        {
          cloneMode: "voxcpm2-hifi",
          voiceProfileId,
          profileSha256,
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
            voiceProfileId,
            profileSha256,
          }],
        },
        {
          cloneMode: "indextts2",
          voiceProfileId,
          profileSha256,
          case: { id: "zh_hant_polyphones", text: "重慶角色" },
          stability: { verdict: "pass" },
          renders: [{
            caseId: "zh_hant_polyphones",
            cloneMode: "indextts2",
            repeat: 1,
            status: "ready",
            outputWav: candidateOutputWav,
            voiceProfileId,
            profileSha256,
            externalBackend: true,
            outputExists: true,
            missingOutput: false,
            outputBytes: candidateAudio.byteLength,
            outputSha256: candidateSha256,
            renderSeconds: 9.1,
          }],
        },
      ],
    },
    null,
    2,
  )}\n`;
  await writeFile(sourceReport, reportText, "utf-8");
  const sourceReportSha256 = sha256Text(reportText);
  const reviewStats = {
    rounds: 1,
    reviewedRounds: 1,
    candidateWins: 1,
    baselineWins: 0,
    ties: 0,
    rerenders: 0,
    candidateWinRate: 1,
    minCandidateWinRate: 0.8,
    reportSha256: sourceReportSha256,
  };
  const subjectiveReview = {
    status: "pass",
    reasons: [],
    reviewJson: path.join(selectionDir, "review.json"),
    report: sourceReport,
    stats: reviewStats,
    reviewStats,
    statMismatches: [],
    missingChoices: [],
    invalidChoices: [],
  };
  await writeFile(
    path.join(selectionDir, "review.json"),
    `${JSON.stringify(
      {
        version: 1,
        status: "pass",
        report: sourceReport,
        reportPath: sourceReport,
        reportSha256: sourceReportSha256,
        expectedSaveAs: path.join(selectionDir, "review.json"),
        choiceKeys: ["winner-zh_hant_polyphones-r01"],
        reviewedAt: "2026-01-09T00:00:00.000Z",
        stats: reviewStats,
        choices: {
          "winner-zh_hant_polyphones-r01": backendCandidateLabel("zh_hant_polyphones", 1, baselineOutputWav, candidateOutputWav),
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    scorePath,
    `${JSON.stringify(
      {
        version: 1,
        sourceReport,
        sourceReportSha256: await sha256File(sourceReport),
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
                outputExists: true,
                missingOutput: false,
                outputBytes: baselineAudio.byteLength,
                outputSha256: baselineSha256,
                outputWav: baselineOutputWav,
                renderSeconds: 10.2,
                audioMetrics: { available: true, durationSec: 1.3, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                hasSpeakerSimilarity: true,
              },
            ],
          },
          {
            cloneMode: "indextts2",
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
            renders: [
              {
                caseId: "zh_hant_polyphones",
                cloneMode: "indextts2",
                repeat: 1,
                status: "ready",
                voiceProfileId,
                profileSha256,
                externalBackend: true,
                outputExists: true,
                missingOutput: false,
                outputBytes: candidateAudio.byteLength,
                outputSha256: candidateSha256,
                outputWav: candidateOutputWav,
                renderSeconds: 9.1,
                audioMetrics: { available: true, durationSec: 1.2, clippingRatio: 0, rmsDbfs: -18, peak: 0.4 },
                hasSpeakerSimilarity: true,
              },
            ],
          },
        ],
        pairedComparison: {
          verdict: "pass",
          baselineCloneMode: "voxcpm2-hifi",
          candidateCloneMode: "indextts2",
          summary: {
            pairs: 1,
            passingPairs: 1,
            reviewPairs: 0,
            blockingPairs: 0,
            avgCerReductionPct: 92,
            avgWerReductionPct: 90,
            avgSpeakerSimilarityDelta: 0.06,
            avgLatencyRegressionPct: -10.784,
          },
          pairs: [
            {
              caseId: "zh_hant_polyphones",
              baselineCloneMode: "voxcpm2-hifi",
              candidateCloneMode: "indextts2",
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
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    selectionPath,
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        scoreJson: scorePath,
        scoreSha256: await sha256File(scorePath),
        reviewJson: path.join(selectionDir, "review.json"),
        reviewSha256: await sha256File(path.join(selectionDir, "review.json")),
        sourceReport,
        sourceReportSha256: await sha256File(sourceReport),
        voiceProfile: {
          voiceProfileId,
          profileSha256,
        },
        baselineCloneMode: "voxcpm2-hifi",
        candidateCloneMode: "indextts2",
        verdict: "accept",
        accepted: true,
        reasons: [],
        subjectiveReview,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  if (apply) {
    await execFileAsync(python, [applyBackendSelectionScript, selectionPath, "--profile-json", profilePath]);
  }
  return selectionPath;
}

async function removeBackendSelectionSourceReportExternalEvidence(selectionPath: string): Promise<void> {
  const proof = JSON.parse(await readFile(selectionPath, "utf-8")) as {
    reviewJson: string;
    reviewSha256: string;
    scoreJson: string;
    scoreSha256: string;
    sourceReport: string;
    sourceReportSha256: string;
  };
  const report = JSON.parse(await readFile(proof.sourceReport, "utf-8"));
  const render = report.groups?.[1]?.renders?.[0];
  if (render) {
    delete render.externalBackend;
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
  }
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(proof.sourceReport, reportText, "utf-8");
  const reportSha256 = sha256Text(reportText);

  const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
  review.reportSha256 = reportSha256;
  if (review.stats && typeof review.stats === "object") {
    review.stats.reportSha256 = reportSha256;
  }
  await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

  const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
  score.sourceReportSha256 = reportSha256;
  await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

  proof.sourceReportSha256 = reportSha256;
  proof.reviewSha256 = await sha256File(proof.reviewJson);
  proof.scoreSha256 = await sha256File(proof.scoreJson);
  await writeFile(selectionPath, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");
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
        "--json",
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
    expect(payload.completionRequirements).toHaveLength(11);
    expect(payload.firstIncompleteRequirement).toMatchObject({
      id: "recording_kit",
      stageId: "recording_kit",
      order: 1,
      status: "blocked",
      ok: false,
      requirement: expect.stringContaining("extended recording kit"),
      evidence: {
        missingClips: ["profile-clip-01"],
        recommendedClips: 7,
        firstMissingClip: {
          id: "profile-clip-01",
          transcript: transcripts[0],
          recordCommand: expect.stringContaining("--clip profile-clip-01"),
        },
        recordingPreflight: expect.objectContaining({
          status: "ready_to_record",
          ok: true,
        }),
      },
    });
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

  it("routes present external phone exports through partial normalization before recording more clips", async () => {
    const manifest = await writeKit();
    const recordingsDir = path.join(tmpRoot, "kit", "recordings");
    await rm(path.join(recordingsDir, "profile-clip-01.wav"));
    await rm(path.join(recordingsDir, "profile-clip-02.wav"));
    await writeFile(path.join(recordingsDir, "profile-clip-01.source.wav"), wavBuffer(7));

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
        "--json",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_RECORDER_COMMAND: "fake-recorder --out {audio_path} --seconds {duration} --clip {id}",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.firstBlocker).toMatchObject({
      id: "recording_kit",
      pendingExternalRecordingCount: 1,
      missingExternalRecordingSourceCount: 1,
      pendingExternalRecordings: [
        expect.objectContaining({
          id: "profile-clip-01",
          sourceAudioPath: expect.stringMatching(/profile-clip-01\.source\.wav$/),
        }),
      ],
    });
    expect(payload.firstIncompleteRequirement.evidence).toMatchObject({
      pendingExternalRecordingCount: 1,
      missingExternalRecordingSourceCount: 1,
      pendingExternalRecordings: [
        expect.objectContaining({
          id: "profile-clip-01",
          sourceAudioPath: expect.stringMatching(/profile-clip-01\.source\.wav$/),
        }),
      ],
    });
    expect(payload.nextCommand).toContain("scripts/normalize_voice_profile_recording_kit_audio.py");
    expect(payload.nextCommand).toContain("--only-present");
    expect(payload.nextCommand).not.toContain("--check");
    expect(payload.nextNormalizePresentExternalRecordingsCommand).toBe(payload.nextCommand);
    expect(payload.nextNormalizeExternalRecordingsCommand).toContain("--check");
  });

  it("blocks recording kits whose sidecar audio hash is stale", async () => {
    const manifest = await writeKit();
    const audioPath = path.join(tmpRoot, "kit", "recordings", "profile-clip-02.wav");
    await writeFile(
      `${audioPath}.recording.json`,
      `${JSON.stringify(
        {
          id: "profile-clip-02",
          audioPath,
          audioSha256: "0".repeat(64),
          transcript: transcripts[1],
          transcriptSha256: sha256Text(transcripts[1]),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

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
      firstFailedClip: {
        id: "profile-clip-02",
        checks: expect.arrayContaining(["recording_metadata"]),
        errors: expect.arrayContaining(["recording_metadata_audio_hash_mismatch"]),
      },
    });
    expect(payload.firstBlocker.missingClips).toEqual([]);
    expect(payload.nextCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextNormalizeExternalRecordingsCommand).toContain("scripts/normalize_voice_profile_recording_kit_audio.py");
  });

  it("prints a brief recording-session checklist for an incomplete kit", async () => {
    const manifest = await writeKit();
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));
    await writeReadyProfile({ count: 5 });

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
    expect(stdout).toContain("Capture depth: 5/7 clips");
    expect(stdout).toContain("Capture duration: 45/60s");
    expect(stdout).not.toContain("Missing pronunciation coverage:");
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
      recommendedClips: 7,
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

  it("blocks hifi quality gates with stale transcript validation profile proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptValidation(qualityGate, validation);

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
      id: "quality_gate",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_profile_sha256_stale",
        transcriptValidationProfileSha256: "0".repeat(64),
      },
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain("transcript_validation_profile_sha256_stale");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks hifi quality gates with stale transcript validation voice profile id", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptVoiceProfileId(qualityGate, validation);

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
      id: "quality_gate",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_voice_profile_id_stale",
      },
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain(
      "transcript_validation_voice_profile_id_stale",
    );
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks hifi quality gates with stale transcript validation rows", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptRows(qualityGate, validation);

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
      id: "quality_gate",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_rows_mismatch",
      },
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain("transcript_validation_rows_mismatch");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks hifi quality gates with stale ASR artifact evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await tamperQualityGateAsrArtifact(qualityGate);

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
      id: "quality_gate",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "asr_sha256_mismatch",
      },
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain("asr_sha256_mismatch");
  });

  it("reports hifi quality gate score reviews instead of stale artifact proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await markQualityGateScoreReview(qualityGate);

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
      id: "quality_gate",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "score_verdict_not_pass",
        scoreVerdict: "review",
        scoreSummary: {
          groups: 1,
          passingGroups: 0,
          speakerReviewGroups: 1,
          profileReferenceReviewGroups: 1,
        },
      },
    });
    expect(payload.firstBlocker.message).toContain("latest quality gate score is review");
    expect(payload.firstBlocker.message).toContain("passingGroups=0/1");
    expect(payload.firstBlocker.message).toContain("speakerReviewGroups=1");
    expect(payload.firstBlocker.message).not.toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.scoreReviewGroups[0]).toMatchObject({
      caseId: "zh_hant_polyphones",
      cloneMode: "hifi",
      verdict: "review",
      speakerIdentityVerdict: "review",
      profileReferenceVerdict: "review",
      minSpeakerSimilarityObserved: 0.61,
      profileReference: {
        missingByRender: expect.arrayContaining([
          expect.objectContaining({
            missingPronunciationPresetIds: ["brand:voxcpm2"],
          }),
          expect.objectContaining({
            missingPronunciationPresetIds: ["polyphone:bank-president"],
          }),
        ]),
      },
    });
    expect(payload.nextCommand).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(payload.nextCommand).toContain("--clip profile-clip-08");
    expect(payload.nextCommand).toContain("--clip profile-clip-09");
    expect(payload.nextCommand).not.toContain("--record-missing-until-complete");
    expect(payload.nextCommand).toContain("--open-cue-sheet");
    expect(payload.nextCommand).toContain("--check-selected");
    expect(payload.nextOpenCueSheetCommand).toContain("cue-sheet.html");
    expect(payload.nextProfileReferenceRecordingBatchCommand).toBe(payload.nextCommand);
    expect(payload.nextPostProfileReferenceRecordingProofCommand).toContain("scripts/voice_profile_next_step.py");
    expect(payload.nextPostProfileReferenceRecordingProofCommand).toContain("--run");
    expect(payload.nextPostProfileReferenceRecordingProofCommand).toContain("--auto-advance");
    expect(payload.nextPostProfileReferenceRecordingProofCommand).toContain("--allow-enroll");
    expect(payload.nextProfileReferenceRecordingCommands).toEqual([
      expect.objectContaining({
        presetId: "brand:voxcpm2",
        clipId: "profile-clip-08",
        recordCommand: expect.stringContaining("--clip profile-clip-08"),
      }),
      expect.objectContaining({
        presetId: "polyphone:bank-president",
        clipId: "profile-clip-09",
        recordCommand: expect.stringContaining("--clip profile-clip-09"),
      }),
    ]);
    expect(payload.nextQualityGateProbeCommands).toEqual([
      expect.objectContaining({
        caseId: "zh_hant_polyphones",
        proofScope: "partial_case_probe_not_full_completion_gate",
        command: expect.stringContaining("scripts/run_voice_quality_gate.py"),
        asrSamples: expect.arrayContaining([
          expect.objectContaining({
            asrTranscript: expect.any(String),
          }),
        ]),
      }),
    ]);
    expect(payload.nextQualityGateProbeCommands[0].command).toContain("--case zh_hant_polyphones");
    expect(payload.nextQualityGateRepairActions).toEqual([
      expect.objectContaining({
        kind: "record_profile_reference_batch",
        priority: 1,
        status: "ready",
        clipIds: ["profile-clip-08", "profile-clip-09"],
        presetIds: ["brand:voxcpm2", "polyphone:bank-president"],
        command: expect.stringContaining("--clip profile-clip-08"),
      }),
      expect.objectContaining({
        kind: "rerun_profile_reference_proof",
        priority: 2,
        status: "waiting",
        dependsOn: "record_profile_reference_batch",
        command: expect.stringContaining("scripts/voice_profile_next_step.py"),
      }),
      expect.objectContaining({
        kind: "run_quality_probe",
        priority: 3,
        status: "waiting",
        blockedUntil: "rerun_profile_reference_proof",
        caseId: "zh_hant_polyphones",
        proofScope: "partial_case_probe_not_full_completion_gate",
        command: expect.stringContaining("--case zh_hant_polyphones"),
      }),
    ]);
    expect(payload.nextCommand).not.toContain("scripts/run_voice_quality_gate.py");
  });

  it("routes model-capability quality-gate reviews to backend shootout before repeat probes", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await markQualityGateModelCapabilityReview(qualityGate);

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
      id: "quality_gate",
      artifactProof: {
        scoreSummary: {
          speakerReviewGroups: 1,
          profileReferenceReviewGroups: 0,
        },
      },
    });
    expect(payload.nextProfileReferenceRecordingBatchCommand).toBeNull();
    expect(payload.nextCommand).toContain("scripts/prepare_voice_backend_shootout.py");
    expect(payload.nextCommand).toContain("--backend voxcpm2-hifi");
    expect(payload.nextCommand).toContain("--backend indextts2 --backend f5-tts");
    expect(payload.nextCommand).toContain("--transcript-validation-json");
    expect(payload.nextQualityGateRepairActions).toEqual([
      expect.objectContaining({
        kind: "prepare_backend_shootout",
        priority: 1,
        status: "ready",
        command: expect.stringContaining("scripts/prepare_voice_backend_shootout.py"),
      }),
      expect.objectContaining({
        kind: "run_quality_probe",
        priority: 2,
        status: "ready",
        caseId: "zh_hant_tone_contrast",
        command: expect.stringContaining("--case zh_hant_tone_contrast"),
      }),
    ]);
  });

  it("reuses the latest profile-matching backend shootout plan for model-capability quality-gate reviews", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    const backendRoot = path.join(tmpRoot, "backend-shootouts");
    const renderScript = await writeBackendShootoutPlan(profile, backendRoot);
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await markQualityGateModelCapabilityReview(qualityGate);

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
        "--backend-selection-root",
        backendRoot,
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
    const resolvedRenderScript = await realpath(renderScript);
    const resolvedManifest = await realpath(path.join(backendRoot, "2026-01-03", "manifest.json"));
    expect(payload.nextCommand).toBe(resolvedRenderScript);
    expect(payload.nextQualityGateRepairActions[0]).toMatchObject({
      kind: "render_backend_shootout",
      priority: 1,
      status: "ready",
      command: resolvedRenderScript,
      rendererStatus: "needs_renderer_command",
      rendererCommandEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
      rendererCommandConfigured: false,
      totalRenders: 1,
      renderedRenders: 0,
      missingRenders: 1,
    });
    expect(payload.backendShootoutRendererStatus).toMatchObject({
      manifest: resolvedManifest,
      renderScript: resolvedRenderScript,
      rendererStatus: "needs_renderer_command",
      rendererCommandEnv: "ANYVOICE_BACKEND_RENDER_COMMAND",
      rendererCommandConfigured: false,
      totalRenders: 1,
      renderedRenders: 0,
      missingRenders: 1,
    });
    expect(payload.nextQualityGateRepairActions[1]).toMatchObject({
      kind: "run_quality_probe",
      priority: 2,
      caseId: "zh_hant_tone_contrast",
    });
  });

  it("prints the prioritized quality-gate repair queue in brief mode", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const qualityGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    await markQualityGateScoreReview(qualityGate);

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
        "--brief",
      ],
      {
        env: {
          ...process.env,
          ...proofBackendEnv(),
          ANYVOICE_QUALITY_GATE_ROOT: path.join(tmpRoot, "quality-gates"),
        },
      },
    );

    expect(stdout).toContain("First blocker: quality_gate - blocked");
    expect(stdout).toContain("Quality gate repair queue:");
    expect(stdout).toContain("P1 record_profile_reference_batch [ready]:");
    expect(stdout).toContain("--clip profile-clip-08 --clip profile-clip-09");
    expect(stdout).toContain("P2 rerun_profile_reference_proof [waiting]:");
    expect(stdout).toContain("scripts/voice_profile_next_step.py");
    expect(stdout).toContain("P3 run_quality_probe (zh_hant_polyphones) [waiting]:");
    expect(stdout).toContain("--case zh_hant_polyphones");
    expect(stdout).toContain("blockedUntil: rerun_profile_reference_proof");
    expect(stdout).toContain("Quality probe 1 (zh_hant_polyphones):");
    expect(stdout).toContain("partial_case_probe_not_full_completion_gate");
  });

  it("ignores partial-case hifi gates when auditing the full quality gate", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const fullGate = await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z", { gateName: "hifi-full" });
    const partialGate = await writeQualityGate(profile, "hifi", "2026-01-03T00:00:00.000Z", { gateName: "hifi-partial" });
    const resolvedFullGate = await realpath(fullGate);
    await markQualityGatePartialCase(partialGate);
    await markQualityGateScoreReview(partialGate);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
      qualityGateJson: resolvedFullGate,
    });
    expect(payload.firstBlocker).toMatchObject({ id: "product_10x_proof" });
    expect(payload.firstBlocker.qualityGateJson).not.toBe(partialGate);
  });

  it("blocks paired product proof gates with stale transcript validation profile proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptValidation(productGate, validation);

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
      id: "product_10x_proof",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_profile_sha256_stale",
        transcriptValidationProfileSha256: "0".repeat(64),
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain("transcript_validation_profile_sha256_stale");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks paired product proof gates with stale transcript validation voice profile id", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptVoiceProfileId(productGate, validation);

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
      id: "product_10x_proof",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_voice_profile_id_stale",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain(
      "transcript_validation_voice_profile_id_stale",
    );
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks paired product proof gates with stale transcript validation rows", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateAtStaleTranscriptRows(productGate, validation);

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
      id: "product_10x_proof",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_rows_mismatch",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain("transcript_validation_rows_mismatch");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("blocks paired product proof gates when the score JSON consumed a stale ASR hash", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateScoreAtStaleAsrHash(productGate);

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "score_asr_sha256_mismatch",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain("score_asr_sha256_mismatch");
  });

  it("blocks paired product proof gates when the source report omits render output proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await removeQualityGateSourceReportRenderOutputProof(productGate);

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "source_report_render_output_proof_missing",
      },
    });
    expect(payload.firstBlocker.artifactProof.errors).toEqual(
      expect.arrayContaining([
        "source_report_render_output_missing:prompt/zh_hant_polyphones#r1",
        "source_report_render_output_bytes_missing:prompt/zh_hant_polyphones#r1",
        "source_report_render_output_sha256_missing:prompt/zh_hant_polyphones#r1",
      ]),
    );
  });

  it("blocks paired product proof gates without score-level paired improvement evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await removeQualityGatePairedComparison(productGate);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.firstBlocker.message).toContain("no passing paired product quality gate");
  });

  it("accepts paired product proof from score evidence without requiring the legacy command flag", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await removeQualityGatePairedImprovementCommandFlag(productGate);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "product_10x_proof")).toMatchObject({
      status: "pass",
    });
  });

  it("blocks paired product proof gates whose paired score regresses speaker similarity", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await regressQualityGatePairedSpeakerSimilarity(productGate);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.firstBlocker.message).toContain("no passing paired product quality gate");
  });

  it("blocks paired product proof gates when the score speaker verdict is not pass", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await markQualityGateScoreSpeakerIdentityForReview(productGate);

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "score.groups[0].verdict_not_pass",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.artifactProof.errors).toContain("score.groups[0].speaker_identity_verdict_not_pass");
    expect(payload.firstBlocker.artifactProof.errors).toContain("score.groups[0].speaker_identity_detail_not_pass");
  });

  it("blocks paired product proof gates with stale score profile evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateScoreAtStaleProfileEvidence(productGate);

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "score.voiceProfile.profileSha256",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain("score.voiceProfile.profileSha256");
    expect(payload.firstBlocker.artifactProof.errors).toContain("score.groups[0].renders[0].profileSha256");
  });

  it("blocks paired product proof gates with stale source report profile evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateReportAtStaleProfileEvidence(productGate);

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "sourceReport.groups[0].renders[0].voiceProfileId",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain("sourceReport.groups[0].renders[0].voiceProfileId");
  });

  it("does not accept an adapter-loaded paired gate as the base product proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    await writeQualityGate(profile, "both", "2026-01-05T00:00:00.000Z", {
      loraPath: path.join(tmpRoot, "adapter", "lora_weights.ckpt"),
    });

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.firstBlocker.message).toContain("no passing paired product quality gate");
  });

  it("accepts quality-gate score artifact paths relative to the score JSON", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    const hifiGate = await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await pointQualityGateScoreAtRelativeArtifactPaths(hifiGate);
    await pointQualityGateScoreAtRelativeArtifactPaths(productGate);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "product_10x_proof")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "subjective_review",
      status: "missing",
    });
  });

  it("does not accept paired product proof gates that skipped transcript validation", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const gate = JSON.parse(await readFile(productGate, "utf-8"));
    gate.inputs.skipTranscriptValidation = true;
    gate.proofs.transcriptValidationRequired = false;
    gate.proofs.transcriptValidationSkipped = true;
    await writeFile(productGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "product_10x_proof")).toMatchObject({
      status: "missing",
    });
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("does not accept paired product proof gates whose transcript proof says it was skipped", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const gate = JSON.parse(await readFile(productGate, "utf-8"));
    gate.proofs.transcriptValidationSkipped = true;
    await writeFile(productGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "product_10x_proof")).toMatchObject({
      status: "missing",
    });
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("does not accept paired product proof gates whose profile verification proof says it was skipped", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const gate = JSON.parse(await readFile(productGate, "utf-8"));
    gate.proofs.profileVerifySkipped = true;
    await writeFile(productGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      id: "product_10x_proof",
      status: "missing",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "product_10x_proof")).toMatchObject({
      status: "missing",
    });
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("does not accept paired product proof gates that omit transcript validation proof JSON", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const resolvedValidation = await realpath(validation);
    await writeQualityGate(profile, "hifi", "2026-01-04T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const gate = JSON.parse(await readFile(productGate, "utf-8"));
    delete gate.inputs.transcriptValidationJson;
    delete gate.proofs.transcriptValidationJson;
    delete gate.paths.profileTranscriptValidation;
    await writeFile(productGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      id: "product_10x_proof",
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "missing_transcript_validation_path",
      },
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
    expect(payload.nextCommand).toContain(`--transcript-validation-json ${resolvedValidation}`);
  });

  it("does not let a stale recording kit block a profile that already has 7-clip product capture depth", async () => {
    const manifest = await writeKit({ count: 5 });
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile);

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
      recommendedClips: 7,
    });
  });

  it("does not bypass a stale recording kit when the profile is missing product pronunciation coverage", async () => {
    const manifest = await writeKit();
    await rm(path.join(tmpRoot, "kit", "recordings", "profile-clip-01.wav"));
    const profile = await writeReadyProfile();
    const profilePayload = JSON.parse(await readFile(profile, "utf-8")) as {
      clips: Array<{ transcriptRaw: string }>;
    };
    profilePayload.clips[2].transcriptRaw = profilePayload.clips[2].transcriptRaw.replace("AnyVoice、", "");
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
      id: "recording_kit",
      status: "blocked",
      selectedClips: 10,
      totalDurationSec: 115,
      recommendedClips: 7,
      recommendedDurationSec: 60,
      missingPronunciationPresetIds: ["brand:anyvoice"],
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "capture_depth")).toMatchObject({
      status: "blocked",
      selectedClips: 10,
      totalDurationSec: 115,
      missingPronunciationPresetIds: ["brand:anyvoice"],
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
    await writeBackendSelection(profile);

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.completionRequirements).toHaveLength(11);
    expect(payload.completionRequirements.every((row: { ok: boolean; status: string }) => row.ok && row.status === "pass")).toBe(true);
    expect(payload.firstIncompleteRequirement).toBeNull();
    expect(payload.completionRequirements.map((row: { id: string }) => row.id)).toEqual([
      "recording_kit",
      "strict_profile",
      "capture_depth",
      "proof_environment",
      "quality_gate",
      "product_10x_proof",
      "subjective_review",
      "lora_dataset",
      "lora_training_job",
      "lora_adapter",
      "lora_quality_gate",
    ]);
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
    const persistedProfile = JSON.parse(await readFile(profile, "utf-8")) as {
      loraPath?: string;
      loraAdapter?: { path?: string; sha256?: string; qualityGateSha256?: string };
      preferredBackend?: {
        backend?: string;
        profileSha256?: string;
        selectionSha256?: string;
        reviewJson?: string;
        reviewSha256?: string;
        sourceReport?: string;
        sourceReportSha256?: string;
        subjectiveReview?: {
          status?: string;
          reasons?: string[];
          reviewJson?: string;
          stats?: {
            candidateWins?: number;
            candidateWinRate?: number;
          };
        };
      };
    };
    expect(persistedProfile.loraPath).toContain("lora_weights.ckpt");
    expect(persistedProfile.loraAdapter).toMatchObject({
      path: persistedProfile.loraPath,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      qualityGateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(persistedProfile.preferredBackend).toMatchObject({
      backend: "indextts2",
      profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewJson: expect.stringContaining("review.json"),
      reviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceReport: expect.stringContaining("indextts2.report.json"),
      sourceReportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      subjectiveReview: {
        status: "pass",
        reasons: [],
        reviewJson: expect.stringContaining("review.json"),
        stats: {
          candidateWins: 1,
          candidateWinRate: 1,
        },
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("ignores newer accepted backend selection proofs for another voice profile", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const currentSelection = await writeBackendSelection(profile, {
      createdAt: "2026-01-08T00:00:00.000Z",
    });

    const otherProfileDir = path.join(tmpRoot, "other-profile");
    await mkdir(otherProfileDir, { recursive: true });
    const otherProfilePath = path.join(otherProfileDir, "profile.json");
    const otherProfile = JSON.parse(await readFile(profile, "utf-8"));
    otherProfile.voiceProfileId = "other-profile";
    await writeFile(otherProfilePath, `${JSON.stringify(otherProfile, null, 2)}\n`, "utf-8");
    await writeBackendSelection(otherProfilePath, {
      apply: false,
      selectionId: "newer-other-profile",
      createdAt: "2026-01-10T00:00:00.000Z",
    });

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "backend_selection")).toMatchObject({
      status: "pass",
      selectionJson: await realpath(currentSelection),
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("prefers a current-profile backend selection over newer unbound accepted proofs", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const currentSelection = await writeBackendSelection(profile, {
      createdAt: "2026-01-08T00:00:00.000Z",
    });
    const unboundSelection = await writeBackendSelection(profile, {
      apply: false,
      selectionId: "newer-unbound-proof",
      createdAt: "2026-01-11T00:00:00.000Z",
    });
    const unboundProof = JSON.parse(await readFile(unboundSelection, "utf-8"));
    delete unboundProof.voiceProfile;
    await writeFile(unboundSelection, `${JSON.stringify(unboundProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "backend_selection")).toMatchObject({
      status: "pass",
      selectionJson: await realpath(currentSelection),
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("treats backend selection as optional when native and LoRA gates pass", async () => {
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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstIncompleteRequirement).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "missing",
    });
    expect(payload.optionalStages.find((stage: { id: string }) => stage.id === "backend_selection")).toMatchObject({
      id: "backend_selection",
      status: "missing",
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("reports accepted backend selection proofs as optional until they are applied to the profile", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile, { apply: false });

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      message: expect.stringContaining("applied"),
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("accepts applied backend selections whose score sourceReport is relative to the score JSON", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as {
      scoreJson: string;
      scoreSha256: string;
      sourceReport: string;
    };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8")) as Record<string, unknown>;
    score.sourceReport = path.relative(path.dirname(proof.scoreJson), proof.sourceReport);
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    proof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await execFileAsync(python, [
      applyBackendSelectionScript,
      selection,
      "--profile-json",
      profile,
    ]);

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "backend_selection")).toMatchObject({
      status: "pass",
      preferredBackendPolicy: {
        sourceReport: await realpath(proof.sourceReport),
      },
    });
  });

  it("accepts portable applied backend selection policy paths", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile);
    await makePersistedBackendPolicyPortable(profile);
    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    const profileDir = path.dirname(await realpath(profile));
    profilePayload.preferredBackend.subjectiveReview.reviewJson = path.relative(
      profileDir,
      await realpath(profilePayload.preferredBackend.subjectiveReview.reviewJson),
    );
    profilePayload.preferredBackend.subjectiveReview.report = path.relative(
      profileDir,
      await realpath(profilePayload.preferredBackend.subjectiveReview.report),
    );
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "backend_selection")).toMatchObject({
      status: "pass",
      preferredBackendPolicy: {
        profileJson: "profile.json",
        selectionJson: expect.stringContaining("../backend-selection/accepted/indextts2.selection.json"),
        scoreJson: expect.stringContaining("../backend-selection/accepted/indextts2.score.json"),
        reviewJson: expect.stringContaining("../backend-selection/accepted/review.json"),
        sourceReport: expect.stringContaining("../backend-selection/accepted/indextts2.report.json"),
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("blocks applied backend policies missing subjective review or source evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile);

    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    delete profilePayload.preferredBackend.reviewJson;
    delete profilePayload.preferredBackend.reviewSha256;
    delete profilePayload.preferredBackend.sourceReport;
    delete profilePayload.preferredBackend.sourceReportSha256;
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
      id: "backend_selection",
      status: "blocked",
      preferredBackendPolicy: {
        errors: expect.arrayContaining([
          "review_path_mismatch",
          "review_sha256_mismatch",
          "source_report_path_mismatch",
          "source_report_sha256_mismatch",
        ]),
      },
    });
    expect(payload.nextCommand).toContain("scripts/apply_voice_backend_selection.py");
  });

  it("blocks applied backend policies whose voice profile id is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile);

    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    profilePayload.preferredBackend.voiceProfileId = "other-profile";
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
      id: "backend_selection",
      status: "blocked",
      preferredBackendPolicy: {
        errors: expect.arrayContaining(["voice_profile_id_mismatch"]),
      },
    });
    expect(payload.nextCommand).toContain("scripts/apply_voice_backend_selection.py");
  });

  it("blocks applied backend policies whose persisted subjective review summary is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    await writeBackendSelection(profile);

    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    profilePayload.preferredBackend.subjectiveReview.status = "fail";
    profilePayload.preferredBackend.subjectiveReview.reasons = ["stale summary"];
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
      id: "backend_selection",
      status: "blocked",
      preferredBackendPolicy: {
        errors: expect.arrayContaining(["subjective_review_summary_mismatch"]),
      },
    });
    expect(payload.nextCommand).toContain("scripts/apply_voice_backend_selection.py");
  });

  it.each([
    {
      label: "selection proof",
      expectedError: "selection_sha256_mismatch",
      expectedScope: "policy",
      mutate: async (selection: string) => {
        const proof = JSON.parse(await readFile(selection, "utf-8"));
        proof.auditMarker = "selection changed after apply";
        await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");
      },
    },
    {
      label: "score JSON",
      expectedError: "score_sha256_mismatch",
      expectedScope: "selectionEvidence",
      mutate: async (selection: string) => {
        const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
        const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
        score.auditMarker = "score changed after apply";
        await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
      },
    },
    {
      label: "review JSON",
      expectedError: "review_sha256_mismatch",
      expectedScope: "selectionEvidence",
      mutate: async (selection: string) => {
        const proof = JSON.parse(await readFile(selection, "utf-8")) as { reviewJson: string };
        const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
        review.auditMarker = "review changed after apply";
        await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
      },
    },
    {
      label: "source report",
      expectedError: "source_report_sha256_mismatch",
      expectedScope: "selectionEvidence",
      mutate: async (selection: string) => {
        const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string; reviewJson: string };
        const score = JSON.parse(await readFile(proof.scoreJson, "utf-8")) as { sourceReport: string };
        const report = JSON.parse(await readFile(score.sourceReport, "utf-8"));
        report.auditMarker = "source report changed after apply";
        const reportText = `${JSON.stringify(report, null, 2)}\n`;
        await writeFile(score.sourceReport, reportText, "utf-8");
        const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
        const reportSha256 = sha256Text(reportText);
        review.reportSha256 = reportSha256;
        if (review.stats && typeof review.stats === "object") {
          review.stats.reportSha256 = reportSha256;
        }
        await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
      },
    },
  ])("blocks applied backend policies when the $label changes after apply", async ({ expectedError, expectedScope, mutate }) => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile);

    await mutate(selection);

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    if (expectedScope === "selectionEvidence") {
      expect(payload.firstBlocker).toMatchObject({
        id: "backend_selection",
        status: "blocked",
        evidence: {
          errors: expect.arrayContaining([expectedError]),
        },
      });
      expect(payload.nextCommand).toContain("scripts/prepare_voice_backend_shootout.py");
    } else {
      expect(payload.firstBlocker).toMatchObject({
        id: "backend_selection",
        status: "blocked",
        preferredBackendPolicy: {
          errors: expect.arrayContaining([expectedError]),
        },
      });
      expect(payload.nextCommand).toContain("scripts/apply_voice_backend_selection.py");
    }
  });

  it("reports optional backend selection proofs whose score source report hash is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    score.sourceReportSha256 = "0".repeat(64);
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      evidence: {
        errors: expect.arrayContaining(["source_report_score_sha256_mismatch"]),
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("blocks applied backend selections whose score omits ready render output proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile);
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string; scoreSha256: string };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    const render = score.groups[0].renders[0];
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    proof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");
    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    profilePayload.preferredBackend.scoreSha256 = proof.scoreSha256;
    profilePayload.preferredBackend.selectionSha256 = await sha256File(selection);
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
      id: "backend_selection",
      status: "blocked",
      scoreRenderProof: {
        errors: expect.arrayContaining(["score_render_output_missing:voxcpm2-hifi/zh_hant_polyphones#r1"]),
      },
    });
  });

  it("reports optional backend selection proofs whose review is not bound to the source report", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as {
      reviewJson: string;
      reviewSha256: string;
    };
    const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
    review.reportSha256 = "0".repeat(64);
    await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.reviewSha256 = await sha256File(proof.reviewJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      evidence: {
        errors: expect.arrayContaining(["review_source_report_sha256_mismatch"]),
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("reports optional backend selection proofs whose baseline score group did not pass", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    score.groups[0].verdict = "review";
    score.groups[0].speakerIdentityVerdict = "review";
    score.groups[0].speakerIdentity.verdict = "review";
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      reasons: expect.arrayContaining([
        "baseline_group_not_pass:zh_hant_polyphones",
        "baseline_speaker_identity_not_pass:zh_hant_polyphones",
      ]),
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("reports optional backend selection proofs whose source report profile evidence is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as {
      reviewJson: string;
      reviewSha256: string;
      scoreJson: string;
      sourceReport: string;
      sourceReportSha256: string;
      scoreSha256: string;
    };
    const report = JSON.parse(await readFile(proof.sourceReport, "utf-8"));
    report.groups[1].renders[0].voiceProfileId = "other-profile";
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(proof.sourceReport, reportText, "utf-8");
    const reportSha256 = sha256Text(reportText);

    const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
    review.reportSha256 = reportSha256;
    if (review.stats && typeof review.stats === "object") {
      review.stats.reportSha256 = reportSha256;
    }
    await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    score.sourceReportSha256 = reportSha256;
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    proof.sourceReportSha256 = reportSha256;
    proof.reviewSha256 = await sha256File(proof.reviewJson);
    proof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      evidence: {
        errors: expect.arrayContaining(["sourceReport.groups[1].renders[0].voiceProfileId"]),
      },
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("reports optional backend selection proofs whose source report lacks external candidate evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    await removeBackendSelectionSourceReportExternalEvidence(selection);

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      reasons: expect.arrayContaining([
        "source_report_candidate_external_backend_missing:indextts2/zh_hant_polyphones#r1",
        "source_report_candidate_output_bytes_missing:indextts2/zh_hant_polyphones#r1",
        "source_report_candidate_output_sha256_missing:indextts2/zh_hant_polyphones#r1",
      ]),
    });
    expect(payload.nextCommand).toBeNull();
  });

  it("refuses to apply backend selection after the profile manifest changes", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const changedProfile = JSON.parse(await readFile(profile, "utf-8")) as Record<string, unknown>;
    changedProfile.auditMarker = "profile changed after backend selection";
    await writeFile(profile, `${JSON.stringify(changedProfile, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof does not match the target voice profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection when score source report hash evidence is stale", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    score.sourceReportSha256 = "0".repeat(64);
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof sourceReportSha256 does not match the score JSON sourceReportSha256"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection when the source report profile evidence is stale", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as {
      reviewJson: string;
      reviewSha256: string;
      scoreJson: string;
      scoreSha256: string;
      sourceReport: string;
      sourceReportSha256: string;
    };
    const report = JSON.parse(await readFile(proof.sourceReport, "utf-8"));
    report.groups[1].renders[0].voiceProfileId = "other-profile";
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(proof.sourceReport, reportText, "utf-8");
    const reportSha256 = sha256Text(reportText);

    const review = JSON.parse(await readFile(proof.reviewJson, "utf-8"));
    review.reportSha256 = reportSha256;
    if (review.stats && typeof review.stats === "object") {
      review.stats.reportSha256 = reportSha256;
    }
    await writeFile(proof.reviewJson, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    score.sourceReportSha256 = reportSha256;
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");

    proof.sourceReportSha256 = reportSha256;
    proof.reviewSha256 = await sha256File(proof.reviewJson);
    proof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("source_report_render_voice_profile_id_mismatch:indextts2/zh_hant_polyphones#r1"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection when the source report lacks external candidate evidence", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    await removeBackendSelectionSourceReportExternalEvidence(selection);

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("source_report_candidate_external_backend_missing:indextts2/zh_hant_polyphones#r1"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection when the accepted candidate WAV changed after selection", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { sourceReport: string };
    const report = JSON.parse(await readFile(proof.sourceReport, "utf-8"));
    const candidateWav = report.groups[1].renders[0].outputWav;
    await writeFile(candidateWav, Buffer.from("candidate backend wav changed after selection\n"));

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("source_report_candidate_output_sha256_mismatch:indextts2/zh_hant_polyphones#r1"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection when the score omits ready render output proof", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
    const score = JSON.parse(await readFile(proof.scoreJson, "utf-8"));
    const render = score.groups[0].renders[0];
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
    await writeFile(proof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.scoreSha256 = await sha256File(proof.scoreJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection score does not prove ready render output files"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection proofs that are not explicitly accepted", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8"));
    proof.verdict = "reject";
    proof.accepted = false;
    proof.reasons = ["manual_tamper"];
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof must have verdict=accept and accepted=true"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection proofs for unsupported backend names", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8"));
    proof.candidateCloneMode = "made-up-backend";
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof candidateCloneMode is not an allowed voice backend: made-up-backend"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection proofs bound to a stale profile hash", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8"));
    proof.voiceProfile.profileSha256 = "0".repeat(64);
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof does not match the target voice profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("refuses to apply backend selection proofs bound to a stale voice profile id", async () => {
    const profile = await writeReadyProfile();
    const selection = await writeBackendSelection(profile, { apply: false });
    const proof = JSON.parse(await readFile(selection, "utf-8"));
    proof.voiceProfile.voiceProfileId = "other-profile";
    await writeFile(selection, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyBackendSelectionScript,
        selection,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("backend selection proof does not match the target voice profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { preferredBackend?: unknown };
    expect(persisted.preferredBackend).toBeUndefined();
  });

  it("reports optional accepted backend selections whose score profile hash is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const selectionProof = JSON.parse(await readFile(selection, "utf-8")) as { scoreJson: string };
    const score = JSON.parse(await readFile(selectionProof.scoreJson, "utf-8"));
    score.voiceProfile.profileSha256 = "0".repeat(64);
    score.groups[0].profileSha256 = "0".repeat(64);
    score.groups[0].renders[0].profileSha256 = "0".repeat(64);
    await writeFile(selectionProof.scoreJson, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    const updatedProof = JSON.parse(await readFile(selection, "utf-8"));
    updatedProof.scoreSha256 = await sha256File(selectionProof.scoreJson);
    await writeFile(selection, `${JSON.stringify(updatedProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      message: expect.stringContaining("no longer recomputes as accepted"),
      reasons: expect.arrayContaining(["group_profile_sha256_mismatch:indextts2/zh_hant_polyphones"]),
    });
  });

  it("reports optional accepted backend selections whose selection profile hash is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const selection = await writeBackendSelection(profile, { apply: false });
    const selectionProof = JSON.parse(await readFile(selection, "utf-8"));
    selectionProof.voiceProfile.profileSha256 = "0".repeat(64);
    await writeFile(selection, `${JSON.stringify(selectionProof, null, 2)}\n`, "utf-8");

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
        "--backend-selection-root",
        path.join(tmpRoot, "backend-selection"),
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
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "blocked",
      selectionProfile: {
        reason: "selection_does_not_match_current_profile",
      },
    });
    expect(payload.firstOptionalIssue.message).toContain("audited voice profile");
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
    expect(payload.nextCommand).toContain("npm run voice:clone:review");
    expect(payload.nextCommand).toContain("report.html");
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

  it("accepts blind subjective review JSON whose report path is relative to the review file", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.report = "report.json";
    review.reportPath = "report.json";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "subjective_review")).toMatchObject({
      status: "pass",
      reviewJson: await realpath(reviewPath),
      report: await realpath(reportPath),
    });
    expect(payload.firstBlocker.id).not.toBe("subjective_review");
  });

  it("prefers report.review.json over a stale sibling review.json", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const mergedReviewPath = reportPath.replace(/\.json$/, ".review.json");
    await writeFile(mergedReviewPath, await readFile(reviewPath, "utf-8"), "utf-8");
    const staleReview = JSON.parse(await readFile(reviewPath, "utf-8"));
    staleReview.choices["winner-zh_hant_polyphones-r01"] = "rerender";
    staleReview.stats.rerenders = 1;
    staleReview.status = "review";
    staleReview.reasons = ["subjective_review_incomplete_or_rerender"];
    await writeFile(reviewPath, `${JSON.stringify(staleReview, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "subjective_review")).toMatchObject({
      status: "pass",
      reviewJson: await realpath(mergedReviewPath),
    });
    expect(payload.firstBlocker.id).not.toBe("subjective_review");
  });

  it("routes subjective-review rerenders to the matching replacement review report", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.choices["winner-zh_hant_polyphones-r01"] = "rerender";
    review.status = "review";
    review.reasons = ["subjective_review_incomplete_or_rerender"];
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
    const replacementReport = await writeReplacementSubjectiveReport(
      path.join(tmpRoot, "quality-gates", "rerender-subset", "report.json"),
    );

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
    expect(payload.firstBlocker).toMatchObject({ id: "subjective_review", status: "blocked" });
    expect(payload.nextCommand).toContain("voice:clone:review");
    expect(payload.nextCommand).toContain(replacementReport.replace(/\.json$/, ".html"));
    expect(payload.nextCommand).toContain("--port 8768");
  });

  it("routes completed replacement subjective reviews to the merge command", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.choices["winner-zh_hant_polyphones-r01"] = "rerender";
    review.status = "review";
    review.reasons = ["subjective_review_incomplete_or_rerender"];
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
    const replacementReport = await writeReplacementSubjectiveReport(
      path.join(tmpRoot, "quality-gates", "rerender-subset", "report.json"),
      { withReview: true },
    );

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
    expect(payload.firstBlocker).toMatchObject({ id: "subjective_review", status: "blocked" });
    expect(payload.nextCommand).toContain("scripts/merge_voice_subjective_reviews.py");
    expect(payload.nextCommand).toContain(reviewPath);
    expect(payload.nextCommand).toContain(replacementReport);
    expect(payload.nextCommand).toContain(path.join(path.dirname(replacementReport), "review.json"));
    expect(payload.nextCommand).toContain("--fill-missing tie");
  });

  it("accepts selected-scope blind subjective review JSON when the explicit minimum is satisfied", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.reviewScope = "selected";
    review.minimumReviewedRounds = 5;
    review.stats.totalReportRounds = 5;
    review.stats.minimumReviewedRounds = 5;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "subjective_review")).toMatchObject({
      status: "pass",
      stats: {
        reviewedRounds: 5,
        totalReportRounds: 5,
        minimumReviewedRounds: 5,
      },
    });
    expect(payload.firstBlocker.id).not.toBe("subjective_review");
  });

  it("accepts all-tie blind subjective review JSON from the legacy 80% preference UI", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath, 0);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.status = "review";
    review.reasons = ["subjective_review_candidate_win_rate_below_threshold"];
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "subjective_review")).toMatchObject({
      status: "pass",
      stats: {
        candidateWins: 0,
        baselineWins: 0,
        ties: 5,
        candidateWinRate: 0,
      },
    });
    expect(payload.firstBlocker.id).not.toBe("subjective_review");
  });

  it("blocks blind subjective review JSON when the baseline clearly wins", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath, 0, 1);

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
      stats: {
        candidateWins: 0,
        baselineWins: 1,
        ties: 4,
      },
    });
    expect(payload.firstBlocker.message).toContain("baseline was preferred");
  });

  it("blocks selected-scope blind subjective review JSON with a lowered minimum", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.reviewScope = "selected";
    review.minimumReviewedRounds = 3;
    review.stats.totalReportRounds = 5;
    review.stats.minimumReviewedRounds = 3;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
      expectedMinimumReviewedRounds: 5,
      reviewMinimumReviewedRounds: 3,
    });
  });

  it("blocks blind subjective review JSON that omits exported pass status", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    delete review.status;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
    });
    expect(payload.firstBlocker.message).toContain("status='pass'");
  });

  it("blocks blind subjective review JSON whose exported stats are stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    review.stats.candidateWins = 4;
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf-8");

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
      statMismatches: expect.arrayContaining([
        { field: "candidateWins", expected: 5, actual: 4 },
      ]),
    });
    expect(payload.firstBlocker.message).toContain("stats do not match");
  });

  it("blocks blind subjective review JSON that points at a different product report path", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    const resolvedReportPath = await realpath(reportPath);
    await writeSubjectiveReview(reportPath);
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    const wrongReportPath = path.join(tmpRoot, "other-report.json");
    await writeFile(wrongReportPath, await readFile(reportPath, "utf-8"), "utf-8");
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, report: wrongReportPath, reportPath: wrongReportPath }, null, 2)}\n`,
      "utf-8",
    );

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
      reviewReportPath: wrongReportPath,
      expectedReportPath: resolvedReportPath,
    });
    expect(payload.firstBlocker.message).toContain("audited product regression report");
  });

  it("blocks blind subjective reviews when product report samples were not rendered", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    const hifiGroup = report.groups.find((group: { cloneMode: string }) => group.cloneMode === "hifi");
    hifiGroup.renders = hifiGroup.renders.map((render: Record<string, unknown>) => ({
      ...render,
      status: "missing",
      outputWav: "",
    }));
    const tamperedReportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, tamperedReportText, "utf-8");
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, reportSha256: sha256Text(tamperedReportText) }, null, 2)}\n`,
      "utf-8",
    );
    await rebindQualityGateReportArtifact(productGate);

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
    });
    expect(payload.firstBlocker.message).toContain("no prompt-vs-hifi blind rounds");
  });

  it("blocks blind subjective reviews when product report audio files are missing", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      await rm(path.join(path.dirname(reportPath), `hifi-r${String(repeat).padStart(2, "0")}.wav`));
    }

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
      id: "product_10x_proof",
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "source_report_render_output_proof_missing",
      },
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain(
      "source_report_render_output_file_missing:hifi/zh_hant_polyphones#r1",
    );
  });

  it("blocks blind subjective reviews when prompt-vs-hifi rounds have duplicate samples", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    const reportPath = path.join(path.dirname(productGate), "report.json");
    await writeSubjectiveReview(reportPath);
    const duplicateHifiWav = path.join(path.dirname(reportPath), "hifi-r01-copy.wav");
    await writeFile(duplicateHifiWav, wavBuffer(1));
    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    const hifiGroup = report.groups.find((group: { cloneMode: string }) => group.cloneMode === "hifi");
    hifiGroup.renders.push({
      ...hifiGroup.renders[0],
      outputWav: "hifi-r01-copy.wav",
    });
    const tamperedReportText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, tamperedReportText, "utf-8");
    const reviewPath = path.join(path.dirname(reportPath), "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf-8"));
    await writeFile(
      reviewPath,
      `${JSON.stringify({ ...review, reportSha256: sha256Text(tamperedReportText) }, null, 2)}\n`,
      "utf-8",
    );
    await rebindQualityGateReportArtifact(productGate);

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
      ambiguousRounds: [
        {
          caseId: "zh_hant_polyphones",
          repeat: 1,
          sampleCounts: {
            prompt: 1,
            hifi: 2,
          },
        },
      ],
    });
    expect(payload.firstBlocker.message).toContain("ambiguous prompt-vs-hifi blind rounds");
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

  it("accepts LoRA dataset proof paths relative to dataset.json", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });
    const datasetJson = path.join(tmpRoot, "lora-datasets", "local-test", "dataset.json");
    await makeLoraDatasetProofsPortable(datasetJson);

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_dataset")).toMatchObject({
      status: "pass",
      datasetJson: await realpath(datasetJson),
      productQualityGateOk: true,
      datasetProofValidation: {
        qualityGateJson: await realpath(productGate),
        transcriptValidationJson: await realpath(validation),
      },
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
    });
  });

  it("blocks a LoRA dataset whose manifest rows no longer match their hashes", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });
    const datasetJson = path.join(tmpRoot, "lora-datasets", "local-test", "dataset.json");
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { all: string } };
    const lines = (await readFile(dataset.manifests.all, "utf-8")).trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.text = "被手動改過的逐字稿。";
    lines[0] = JSON.stringify(first);
    await writeFile(dataset.manifests.all, `${lines.join("\n")}\n`, "utf-8");

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
      datasetValidationError: expect.stringContaining("transcriptSha256 mismatch"),
    });
    expect(payload.nextCommand).toContain("scripts/prepare_voice_lora_dataset.py");
    expect(payload.nextCommand).toContain("--require-product-proof-quality-gate");
  });

  it("blocks a LoRA dataset whose train and validation manifests do not partition all rows", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });
    const datasetJson = path.join(tmpRoot, "lora-datasets", "local-test", "dataset.json");
    const dataset = JSON.parse(await readFile(datasetJson, "utf-8")) as { manifests: { train: string } };
    const lines = (await readFile(dataset.manifests.train, "utf-8")).trim().split("\n");
    await writeFile(dataset.manifests.train, `${lines.slice(0, 1).join("\n")}\n`, "utf-8");

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
      datasetValidationError: expect.stringContaining("train/val manifests must exactly partition manifest.all.jsonl"),
    });
    expect(payload.nextCommand).toContain("scripts/prepare_voice_lora_dataset.py");
    expect(payload.nextCommand).toContain("--require-product-proof-quality-gate");
  });

  it("prefers the current-profile LoRA dataset over newer stale dataset exports", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });
    const currentDatasetJson = path.join(tmpRoot, "lora-datasets", "local-test", "dataset.json");
    const staleDatasetDir = path.join(tmpRoot, "lora-datasets", "newer-stale-dataset");
    await mkdir(staleDatasetDir, { recursive: true });
    const staleDataset = JSON.parse(await readFile(currentDatasetJson, "utf-8"));
    staleDataset.createdAt = "2026-01-07T00:00:00.000Z";
    staleDataset.profileSha256 = "0".repeat(64);
    await writeFile(path.join(staleDatasetDir, "dataset.json"), `${JSON.stringify(staleDataset, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_dataset")).toMatchObject({
      status: "pass",
      datasetJson: await realpath(currentDatasetJson),
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
    });
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
    expect(payload.nextCommand).toContain("scripts/check_voxcpm_lora_trainer.py");
    expect(payload.nextCommand).toContain("--train-config");
    expect(payload.nextCommand).not.toContain("verify_voxcpm_lora_adapter.py");
  });

  it("accepts LoRA training jobs whose dataset profile path is relative to dataset.json", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { adapterProof: false });
    const datasetJson = path.join(tmpRoot, "lora-datasets", "local-test", "dataset.json");
    await makeLoraDatasetProfilePathPortable(datasetJson);

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
    const loraTrainingJob = payload.stages.find((stage: { id: string }) => stage.id === "lora_training_job");
    expect(loraTrainingJob).toMatchObject({
      status: "blocked",
      datasetJson: await realpath(datasetJson),
      trainerStatus: "needs_trainer_command",
    });
    expect(JSON.stringify(loraTrainingJob)).not.toContain("dataset_profile_mismatch");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
    });
  });

  it("keeps the LoRA training job blocked when the trainer command template is invalid", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, {
      adapterProof: false,
      trainerCommand: "python train_voxcpm_lora.py --config {config}",
    });

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
          ANYVOICE_VOXCPM_TRAINER_COMMAND: "",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
      trainerStatus: "ready",
      trainerCommandConfigured: true,
      trainerCommandValid: false,
      trainerCommandValidationError: expect.stringContaining("train_config.trainer.commandTemplate must include required placeholder(s)"),
    });
    expect(payload.nextCommand).toContain("bash");
    expect(payload.nextCommand).not.toContain("verify_voxcpm_lora_adapter.py");
  });

  it("keeps trainer-ready LoRA jobs blocked when manifest paths drift from dataset.json", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, {
      adapterProof: false,
      trainerCommand: "python train_voxcpm_lora.py --config {config} --output-dir {output_dir} --adapter {adapter_path}",
    });
    const trainConfig = path.join(tmpRoot, "lora-jobs", "local-test", "train_config.json");
    const config = JSON.parse(await readFile(trainConfig, "utf-8"));
    config.manifests.train = path.join(tmpRoot, "other-train-manifest.jsonl");
    await writeFile(config.manifests.train, "{}\n", "utf-8");
    await writeFile(trainConfig, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

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
          ANYVOICE_VOXCPM_TRAINER_COMMAND: "",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
      datasetBindingErrors: expect.arrayContaining(["manifests.train_mismatch"]),
      trainerCommandConfigured: true,
      trainerCommandValid: true,
    });
    expect(payload.nextCommand).toContain("scripts/prepare_voxcpm_lora_training_job.py");
  });

  it("keeps trainer-ready LoRA jobs blocked when dataset proof metadata is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, {
      adapterProof: false,
      trainerCommand: "python train_voxcpm_lora.py --config {config} --output-dir {output_dir} --adapter {adapter_path}",
    });
    const trainConfig = path.join(tmpRoot, "lora-jobs", "local-test", "train_config.json");
    const config = JSON.parse(await readFile(trainConfig, "utf-8"));
    config.datasetProofs.profileSha256 = "0".repeat(64);
    await writeFile(trainConfig, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

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
          ANYVOICE_VOXCPM_TRAINER_COMMAND: "",
        },
      },
    );

    const payload = JSON.parse(stdout);
    expect(payload.status).toBe("blocked");
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_training_job",
      status: "blocked",
      trainerStatus: "ready",
      trainerCommandConfigured: true,
      trainerCommandValid: true,
      datasetBindingErrors: expect.arrayContaining(["datasetProofs.profileSha256_mismatch"]),
    });
    expect(payload.firstBlocker.message).toContain("dataset proof metadata");
    expect(payload.nextCommand).toContain("scripts/prepare_voxcpm_lora_training_job.py");
    expect(payload.nextCommand).toContain("--dataset-json");
    expect(payload.nextCommand).not.toContain("bash");
  });

  it("prefers the current-profile LoRA training config over newer stale training configs", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { loraQualityGate: false });
    const currentTrainConfig = path.join(tmpRoot, "lora-jobs", "local-test", "train_config.json");
    const staleJobDir = path.join(tmpRoot, "lora-jobs", "newer-stale-job");
    await mkdir(staleJobDir, { recursive: true });
    const staleConfig = JSON.parse(await readFile(currentTrainConfig, "utf-8"));
    staleConfig.createdAt = "2026-01-07T00:00:00.000Z";
    staleConfig.datasetProofs.profileSha256 = "0".repeat(64);
    staleConfig.lora.adapterProof = path.join(staleJobDir, "output", "adapter-proof.json");
    await writeFile(path.join(staleJobDir, "train_config.json"), `${JSON.stringify(staleConfig, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_training_job")).toMatchObject({
      status: "pass",
      trainConfig: await realpath(currentTrainConfig),
    });
    expect(payload.firstBlocker).toMatchObject({
      id: "lora_quality_gate",
      status: "missing",
    });
  });

  it("keeps metadata-only adapter proofs from completing the LoRA training handoff", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    proof.status = "metadata_pass";
    proof.warnings = ["Adapter file metadata passed, but checkpoint tensor keys were not inspected."];
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
      id: "lora_training_job",
      status: "partial",
      adapterProofStatus: "metadata_pass",
    });
    expect(payload.firstBlocker.message).toContain("readable checkpoint");
    expect(payload.nextCommand).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("keeps forged pass adapter proofs without checkpoint evidence from completing the LoRA adapter gate", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    delete proof.checkpoint;
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
    expect(payload.firstBlocker.message).toContain("readable checkpoint inspection evidence");
  });

  it("keeps stale adapter proofs from completing the current LoRA training job", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    proof.trainConfig = path.join(tmpRoot, "lora-jobs", "old-profile", "train_config.json");
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
      id: "lora_training_job",
      status: "blocked",
      adapterProofStatus: "pass",
      adapterProofBindingErrors: expect.arrayContaining(["train_config_mismatch"]),
      proofTrainConfig: path.join(tmpRoot, "lora-jobs", "old-profile", "train_config.json"),
    });
    expect(payload.firstBlocker.message).toContain("current training config");
    expect(payload.nextCommand).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
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

  it("rejects adapter proofs bound to a stale dataset profile hash", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    proof.datasetProofs.profileSha256 = "0".repeat(64);
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
      proofProfileSha256: "0".repeat(64),
    });
    expect(payload.firstBlocker.message).toContain("profile hash");
    expect(payload.nextCommand).toContain("verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("rejects stale adapter proofs when the adapter file changed after verification", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const adapterPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "lora_weights.ckpt");
    await writeFile(adapterPath, "tampered adapter\n", "utf-8");

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
    expect(payload.firstBlocker.message).toContain("adapter file");
    expect(payload.firstBlocker.message).toMatch(/byte count|SHA-256/);
    expect(payload.nextCommand).toContain("verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("rejects passing adapter proofs that omit byte and hash evidence", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const proofPath = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf-8"));
    delete proof.adapter.bytes;
    delete proof.adapter.sha256;
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
      actualBytes: "fake adapter\n".length,
    });
    expect(payload.firstBlocker.message).toContain("byte count");
    expect(payload.nextCommand).toContain("verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("blocks stale LoRA quality gates that do not match the verified adapter hash", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    const gate = JSON.parse(await readFile(gatePath, "utf-8"));
    gate.proofs.loraAdapter.sha256 = "stale-adapter-hash";
    await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      status: "blocked",
      qualityGateAdapterSha256: "stale-adapter-hash",
    });
    expect(payload.firstBlocker.message).toContain("verified adapter file");
    expect(payload.firstBlocker.expectedAdapterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.nextCommand).toContain("ANYVOICE_VOXCPM_LORA_PATH=");
    expect(payload.nextCommand).toContain("scripts/run_voice_quality_gate.py");
  });

  it("blocks LoRA quality gates whose source report does not prove the adapter was loaded", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    await removeLoraRenderEvidenceFromQualityGate(gatePath);
    await rebindProfileLoraQualityGateHash(profile, gatePath);

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
      status: "blocked",
      artifactProof: {
        ok: false,
        reason: "source_report_render_lora_effective_params_missing:hifi/zh_hant_polyphones#r1",
      },
    });
    expect(payload.firstBlocker.message).toContain("artifact proof");
    expect(payload.firstBlocker.artifactProof.errors).toContain(
      "source_report_render_lora_effective_params_missing:hifi/zh_hant_polyphones#r1",
    );
  });

  it("accepts LoRA quality-gate score artifact paths relative to the score JSON", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    await pointQualityGateScoreAtRelativeArtifactPaths(gatePath);
    await execFileAsync(python, [
      applyLoraAdapterScript,
      path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json"),
      "--quality-gate-json",
      gatePath,
      "--profile-json",
      profile,
    ]);

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
    expect(payload.status).toBe("complete");
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "missing",
    });
  });

  it("accepts portable LoRA proof chains with relative adapter, gate, and policy paths", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    await makeLoraProofChainPortable(profile);
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    await execFileAsync(python, [
      applyLoraAdapterScript,
      path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json"),
      "--quality-gate-json",
      gatePath,
      "--profile-json",
      profile,
    ]);
    await makePersistedLoraPolicyPortable(profile);
    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    const profileDir = path.dirname(await realpath(profile));
    const proof = profilePayload.loraAdapter.qualityGateProof as {
      transcriptValidationJson: string;
      artifacts: Record<string, { path: string }>;
    };
    proof.transcriptValidationJson = path.relative(profileDir, await realpath(proof.transcriptValidationJson));
    for (const key of ["report", "asr", "speaker", "score"]) {
      proof.artifacts[key].path = path.relative(profileDir, await realpath(proof.artifacts[key].path));
    }
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
    expect(payload.status).toBe("complete");
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_training_job")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_adapter")).toMatchObject({
      status: "pass",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")).toMatchObject({
      status: "pass",
    });
    expect(payload.firstBlocker).toBeNull();
    expect(payload.firstOptionalIssue).toMatchObject({
      id: "backend_selection",
      status: "missing",
    });
  });

  it("blocks LoRA quality gates that skipped transcript validation", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    const gate = JSON.parse(await readFile(gatePath, "utf-8"));
    gate.inputs.skipTranscriptValidation = true;
    gate.proofs.transcriptValidationRequired = false;
    gate.proofs.transcriptValidationPassed = false;
    await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")).toMatchObject({
      id: "lora_quality_gate",
      status: "blocked",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")?.message).toContain(
      "verified adapter file",
    );
  });

  it("blocks LoRA quality gates whose transcript proof says it was skipped", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const gatePath = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    const gate = JSON.parse(await readFile(gatePath, "utf-8"));
    gate.proofs.transcriptValidationSkipped = true;
    await writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")).toMatchObject({
      id: "lora_quality_gate",
      status: "blocked",
    });
    expect(payload.stages.find((stage: { id: string }) => stage.id === "lora_quality_gate")?.message).toContain(
      "verified adapter file",
    );
  });

  it("blocks LoRA quality gates with stale transcript validation profile proof", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);

    const loraGate = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    const staleValidation = path.join(path.dirname(loraGate), "stale-transcript-validation.json");
    const stalePayload = JSON.parse(await readFile(validation, "utf-8"));
    stalePayload.profileSha256 = "0".repeat(64);
    await writeFile(staleValidation, `${JSON.stringify(stalePayload, null, 2)}\n`, "utf-8");
    const staleValidationSha256 = await sha256File(staleValidation);
    const gate = JSON.parse(await readFile(loraGate, "utf-8"));
    gate.inputs.transcriptValidationJson = staleValidation;
    gate.inputs.transcriptValidationSha256 = staleValidationSha256;
    gate.proofs.transcriptValidationJson = staleValidation;
    gate.proofs.transcriptValidationSha256 = staleValidationSha256;
    gate.paths.profileTranscriptValidation = staleValidation;
    await writeFile(loraGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

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
      status: "blocked",
      transcriptValidationProof: {
        ok: false,
        reason: "transcript_validation_profile_sha256_stale",
        transcriptValidationProfileSha256: "0".repeat(64),
      },
    });
    expect(payload.firstBlocker.message).toContain("transcript validation proof");
    expect(payload.firstBlocker.transcriptValidationProof.errors).toContain("transcript_validation_profile_sha256_stale");
    expect(payload.firstBlocker.transcriptValidationProof.expectedProfileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to apply a LoRA adapter with a stale profile quality gate", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    gate.inputs.profileSha256 = "0".repeat(64);
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate is stale for this profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter proof without readable checkpoint evidence", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-missing-checkpoint", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adapter proof must include readable checkpoint inspection evidence"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("applies a LoRA adapter whose proof artifacts use relative paths", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-relative", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: {
            path: path.relative(outputDir, adapterPath),
            bytes: "fake adapter\n".length,
            sha256: sha256Text("fake adapter\n"),
          },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: path.relative(outputDir, profile),
          trainConfig: path.relative(outputDir, trainConfig),
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gateDir = path.dirname(loraQualityGate);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    const scoreDir = path.dirname(gate.paths.score);
    score.sourceReport = path.relative(scoreDir, gate.paths.report);
    score.asrJson = path.relative(scoreDir, gate.paths.asr);
    score.speakerJson = path.relative(scoreDir, gate.paths.speaker);
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.inputs.profileJson = path.relative(gateDir, profile);
    gate.inputs.loraPath = path.relative(gateDir, adapterPath);
    gate.proofs.loraAdapter.path = path.relative(gateDir, adapterPath);
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    const { stdout } = await execFileAsync(python, [
      applyLoraAdapterScript,
      adapterProof,
      "--quality-gate-json",
      loraQualityGate,
      "--profile-json",
      profile,
    ]);
    const resolvedAdapterPath = await realpath(adapterPath);
    const resolvedTrainConfig = await realpath(trainConfig);
    const resolvedQualityGate = await realpath(loraQualityGate);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "applied",
      loraPath: resolvedAdapterPath,
      qualityGateJson: resolvedQualityGate,
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as {
      loraPath?: string;
      loraAdapter?: {
        path?: string;
        trainConfig?: string;
        qualityGateJson?: string;
        qualityGateProof?: {
          status?: string;
          cloneMode?: string;
          speakerBackend?: string;
          transcriptValidationPassed?: boolean;
          transcriptValidationSha256?: string;
          artifacts?: {
            score?: {
              sha256?: string;
            };
          };
        };
      };
    };
    expect(persisted.loraPath).toBe(resolvedAdapterPath);
    expect(persisted.loraAdapter).toMatchObject({
      path: resolvedAdapterPath,
      trainConfig: resolvedTrainConfig,
      qualityGateJson: resolvedQualityGate,
      qualityGateProof: {
        status: "pass",
        cloneMode: "hifi",
        speakerBackend: "speechbrain-ecapa",
        transcriptValidationPassed: true,
        transcriptValidationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        artifacts: {
          score: {
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
  });

  it("refuses to apply a LoRA adapter when the quality gate source report lacks LoRA render evidence", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    const adapterProof = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const loraQualityGate = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    await removeLoraRenderEvidenceFromQualityGate(loraQualityGate);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "LoRA quality gate source report does not prove the verified adapter was loaded: source_report_render_lora_effective_params_missing:hifi/zh_hant_polyphones#r1",
      ),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate source report WAV hash is stale", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    const adapterProof = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const loraQualityGate = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    await writeFile(path.join(tmpRoot, "quality-gates", "lora", "lora-hifi-r01.wav"), Buffer.from("changed lora render wav\n"));

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "source_report_render_output_sha256_mismatch:hifi/zh_hant_polyphones#r1",
      ),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate omits explicit non-dry-run proof", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-missing-dry-run-proof", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    delete gate.dryRun;
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate must be a non-dry-run pass"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate skipped transcript validation", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-skipped-transcript", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    gate.inputs.skipTranscriptValidation = true;
    gate.proofs.transcriptValidationRequired = false;
    gate.proofs.transcriptValidationPassed = false;
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate did not prove transcript validation passed"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate transcript validation proof is stale", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-transcript-validation-profile", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const validationPath = await writeTranscriptValidation(profile);
    const validation = JSON.parse(await readFile(validationPath, "utf-8"));
    validation.profileSha256 = "0".repeat(64);
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate transcript validation proof is stale for this profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate transcript validation voice profile id is stale", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-transcript-validation-voice-profile-id", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const validationPath = await writeTranscriptValidation(profile);
    const validation = JSON.parse(await readFile(validationPath, "utf-8"));
    validation.voiceProfileId = "other-profile";
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate transcript validation proof is bound to the wrong voice profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate transcript validation rows are stale", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-transcript-validation-rows", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const validationPath = await writeTranscriptValidation(profile);
    const validation = JSON.parse(await readFile(validationPath, "utf-8"));
    validation.clips[1].expectedTranscript = "這是一段已經過期的逐字稿。";
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate transcript validation proof rows do not match this profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate transcript proof changed", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-mutated-transcript-proof", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const validationPath = path.join(path.dirname(profile), "transcript-validation.json");
    const validation = JSON.parse(await readFile(validationPath, "utf-8"));
    validation.mutatedAfterLoraQualityGate = true;
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate transcript validation proof SHA-256 no longer matches the file"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate ASR artifact changed", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-mutated-asr-artifact", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    await tamperQualityGateAsrArtifact(loraQualityGate);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate proof asr artifact SHA-256 no longer matches the file"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate score consumed a stale ASR hash", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-score-asr-hash", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    await pointQualityGateScoreAtStaleAsrHash(loraQualityGate);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate score JSON asrJsonSha256 no longer matches paths.asr"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate score omits render output proof", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-missing-score-output-proof", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    const render = score.groups[0].renders[0];
    delete render.outputExists;
    delete render.missingOutput;
    delete render.outputBytes;
    delete render.outputSha256;
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate score/report does not prove ready render output files"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the quality gate score lacks strict speaker proof", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-weak-speaker-score", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);
    const gate = JSON.parse(await readFile(loraQualityGate, "utf-8"));
    const score = JSON.parse(await readFile(gate.paths.score, "utf-8"));
    score.groups[0].verdict = "review";
    score.groups[0].speakerIdentityVerdict = "review";
    score.groups[0].speakerIdentity.verdict = "review";
    await writeFile(gate.paths.score, `${JSON.stringify(score, null, 2)}\n`, "utf-8");
    gate.proofs.artifacts.score.sha256 = await sha256File(gate.paths.score);
    await writeFile(loraQualityGate, `${JSON.stringify(gate, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA quality gate score JSON does not prove strict speaker identity"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter proof without train config evidence", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-missing-train-config", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adapter proof is missing trainConfig evidence"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter proof with a stale train config hash", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-train-config", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: { acceptedUnsafeDataset: false, productProofQualityGateRequired: true, profileSha256 },
          profilePath: profile,
          trainConfig,
          trainConfigSha256: "0".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adapter proof trainConfigSha256 does not match trainConfig"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when train config manifest paths drift from dataset.json", async () => {
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });
    const trainConfig = path.join(tmpRoot, "lora-jobs", "local-test", "train_config.json");
    const adapterProof = path.join(tmpRoot, "lora-jobs", "local-test", "output", "adapter-proof.json");
    const loraQualityGate = path.join(tmpRoot, "quality-gates", "lora", "quality-gate.json");
    const config = JSON.parse(await readFile(trainConfig, "utf-8"));
    config.manifests.train = path.join(tmpRoot, "other-train-manifest.jsonl");
    await writeFile(config.manifests.train, "{}\n", "utf-8");
    await writeFile(trainConfig, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    const proof = JSON.parse(await readFile(adapterProof, "utf-8"));
    proof.trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(adapterProof, `${JSON.stringify(proof, null, 2)}\n`, "utf-8");

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA train config manifest paths do not match dataset.json"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter with a stale adapter proof profile hash", async () => {
    const profile = await writeReadyProfile();
    const outputDir = path.join(tmpRoot, "lora-apply-stale-proof", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, await canonicalProfileSha256(profile));
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: {
            acceptedUnsafeDataset: false,
            productProofQualityGateRequired: true,
            profileSha256: "0".repeat(64),
          },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adapter proof dataset profile hash does not match this profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
  });

  it("refuses to apply a LoRA adapter when the hash-bound train config profile hash is stale", async () => {
    const profile = await writeReadyProfile();
    const profileSha256 = await canonicalProfileSha256(profile);
    const outputDir = path.join(tmpRoot, "lora-apply-stale-config", "output");
    await mkdir(outputDir, { recursive: true });
    const adapterPath = path.join(outputDir, "lora_weights.ckpt");
    const adapterProof = path.join(outputDir, "adapter-proof.json");
    const trainConfig = path.join(outputDir, "train_config.json");
    await writeFile(adapterPath, "fake adapter\n", "utf-8");
    // Build a correctly-bound config, then drift only the config's own dataset
    // profile hash. The proof keeps a genuine trainConfigSha256 and a correct
    // datasetProofs.profileSha256, so this can only be caught by re-deriving the
    // profile binding from the hash-bound train config.
    await writeMinimalBoundTrainConfig(trainConfig, adapterPath, profileSha256);
    const staleConfig = JSON.parse(await readFile(trainConfig, "utf-8"));
    staleConfig.datasetProofs.profileSha256 = "0".repeat(64);
    await writeFile(trainConfig, `${JSON.stringify(staleConfig, null, 2)}\n`, "utf-8");
    const trainConfigSha256 = await sha256File(trainConfig);
    await writeFile(
      adapterProof,
      `${JSON.stringify(
        {
          version: 1,
          status: "pass",
          ...readableLoraCheckpointProof(),
          adapter: { path: adapterPath, bytes: "fake adapter\n".length, sha256: sha256Text("fake adapter\n") },
          datasetProofs: {
            acceptedUnsafeDataset: false,
            productProofQualityGateRequired: true,
            profileSha256,
          },
          profilePath: profile,
          trainConfig,
          trainConfigSha256,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const loraQualityGate = await writeLoraQualityGate(profile, adapterPath);

    await expect(
      execFileAsync(python, [
        applyLoraAdapterScript,
        adapterProof,
        "--quality-gate-json",
        loraQualityGate,
        "--profile-json",
        profile,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LoRA train config dataset profile hash does not match this profile"),
    });
    const persisted = JSON.parse(await readFile(profile, "utf-8")) as { loraAdapter?: unknown; loraPath?: unknown };
    expect(persisted.loraAdapter).toBeUndefined();
    expect(persisted.loraPath).toBeNull();
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

  it("keeps LoRA blocked until the verified adapter is applied to the profile", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate, { applyLora: false });

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
      status: "blocked",
      message: expect.stringContaining("applied"),
    });
    expect(payload.nextCommand).toContain("scripts/apply_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--quality-gate-json");
    expect(payload.nextCommand).toContain("--profile-json");
  });

  it("blocks applied LoRA adapter policies when train_config changes after apply", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);
    const trainConfigPath = path.join(tmpRoot, "lora-jobs", "local-test", "train_config.json");
    const trainConfig = JSON.parse(await readFile(trainConfigPath, "utf-8"));
    trainConfig.lora.rank = 64;
    trainConfig.auditMarker = "train config changed after adapter apply";
    await writeFile(trainConfigPath, `${JSON.stringify(trainConfig, null, 2)}\n`, "utf-8");

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
      adapterProofStatus: "pass",
      adapterProofBindingErrors: expect.arrayContaining(["train_config_sha256_mismatch"]),
    });
    expect(payload.nextCommand).toContain("scripts/verify_voxcpm_lora_adapter.py");
    expect(payload.nextCommand).toContain("--require-readable-checkpoint");
  });

  it("blocks applied LoRA adapter policies whose persisted quality gate summary is stale", async () => {
    const manifest = await writeKit();
    const profile = await writeReadyProfile();
    const validation = await writeTranscriptValidation(profile);
    await writeQualityGate(profile, "hifi", "2026-01-02T00:00:00.000Z");
    const productGate = await writeQualityGate(profile, "both", "2026-01-03T00:00:00.000Z");
    await writeSubjectiveReview(path.join(path.dirname(productGate), "report.json"));
    await writeLoraArtifacts(profile, validation, productGate);

    const profilePayload = JSON.parse(await readFile(profile, "utf-8"));
    profilePayload.loraAdapter.qualityGateProof.transcriptValidationPassed = false;
    await writeFile(profile, `${JSON.stringify(profilePayload, null, 2)}\n`, "utf-8");

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
      status: "blocked",
      loraAdapterPolicy: {
        errors: expect.arrayContaining(["quality_gate_proof_summary_mismatch"]),
      },
    });
    expect(payload.nextCommand).toContain("scripts/apply_voxcpm_lora_adapter.py");
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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hotWorkerUrl,
  modelId,
  profileBackendMode,
  profileBackendRenderCommand,
  stabilitySeed,
  voxcpmCloneMode,
  voxcpmLoraPath,
  type VoxCpmCloneMode,
} from "@/lib/clone-config";
import { prepareVoiceText, type PreparedVoiceText } from "@/lib/text-prep";
import { canonicalVoiceProfileSha256 } from "@/lib/voice-profile";
import {
  detectTargetLanguage,
  type CloneInput,
  type QualityPreset,
} from "@/lib/clone-request";
import { packSentences, splitSentences } from "@/lib/book-segment";
import { safeRunDir } from "@/lib/run-paths";

// Beyond this many characters, VoxCPM2's single-pass synthesis drifts (quality
// degrades and background noise creeps in past ~1 minute of audio). We split
// long text into sentence-packed chunks, synthesize each as its own stable
// generation, then concatenate — the same principle as the audiobook pipeline.
const MAX_SINGLE_PASS_CHARS = 220;

/**
 * Sentence-packed chunks for a target text. Short text (within the single-pass
 * ceiling) is returned unchanged as one chunk; only genuinely long text is
 * split, into fewer/larger chunks (bigger min) to minimize boundary seams.
 */
export function planTargetChunks(targetText: string): string[] {
  if (targetText.trim().length <= MAX_SINGLE_PASS_CHARS) return [targetText];
  const chunks = packSentences(splitSentences(targetText), { minChars: 120, maxChars: MAX_SINGLE_PASS_CHARS });
  return chunks.length > 0 ? chunks : [targetText];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type JsonLineCallback = (line: Record<string, unknown>) => void;
export type CloneProgressCallback = (payload: CloneProgressPayload) => void;

export type ReferenceQualityGrade = "A" | "B" | "C" | "D";

export interface ReferenceQuality {
  grade: ReferenceQualityGrade;
  durationSec: number;
  snrDb: number | null;
  clippingRatio: number;
  vadActiveRatio: number;
  warnings: string[];
}

export interface EffectiveParams {
  timesteps: number;
  cfgValue: number;
  denoise: boolean;
  qualityPreset: QualityPreset;
  cloneMode: VoxCpmCloneMode;
  voiceBackend?: string;
  backendBaselineBackend?: string | null;
  stabilitySeed?: number | null;
  loraEnabled?: boolean;
  loraPath?: string | null;
  backendSelectionJson?: string | null;
  backendSelectionSha256?: string | null;
  backendReviewJson?: string | null;
  backendReviewSha256?: string | null;
  backendSourceReport?: string | null;
  backendSourceReportSha256?: string | null;
  backendFallbackFrom?: string | null;
  backendFallbackReason?: string | null;
}

export type CloneProgressPhase =
  | "queued"
  | "input_saved"
  | "reference_preprocessing"
  | "reference_analyzed"
  | "model_loading"
  | "model_ready"
  | "synthesis_started"
  | "audio_ready"
  | "finalizing";

export interface CloneProgressPayload {
  status: "progress";
  jobId: string;
  modelId: string;
  phase: CloneProgressPhase;
  message?: string;
  referenceQuality?: ReferenceQuality;
  effectiveParams?: EffectiveParams;
}

export interface CloneReadyPayload {
  status: "ready";
  jobId: string;
  modelId: string;
  audioUrl: string;
  referenceQuality: ReferenceQuality;
  targetLanguage: string | null;
  effectiveParams: EffectiveParams;
}

export interface CloneWorkerMissingPayload {
  status: "needs_worker";
  jobId: string;
  modelId: string;
  message: string;
}

interface CloneRunFiles {
  runDir: string;
  referencePath: string;
  targetTextPath: string;
  targetTextRawPath: string;
  promptTranscriptPath: string;
  promptTranscriptRawPath: string;
  outputPath: string;
  metadataPath: string;
  textPrepPath: string;
  requestPath: string;
  textPreparation: {
    targetText: PreparedVoiceText;
    promptTranscript: PreparedVoiceText;
  };
}

export function fileExtension(name: string, type: string): string {
  const fromName = path.extname(name || "").toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;
  if (type.includes("mpeg")) return ".mp3";
  if (type.includes("mp4")) return ".m4a";
  if (type.includes("wav")) return ".wav";
  if (type.includes("webm")) return ".webm";
  return ".audio";
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onJsonLine?: JsonLineCallback,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pendingStdoutLine = "";

    const consumeStdout = (text: string) => {
      if (!onJsonLine) return;
      pendingStdoutLine += text;
      let newlineIndex = pendingStdoutLine.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingStdoutLine.slice(0, newlineIndex);
        pendingStdoutLine = pendingStdoutLine.slice(newlineIndex + 1);
        const parsed = parseJsonLine(line);
        if (parsed) onJsonLine(parsed);
        newlineIndex = pendingStdoutLine.indexOf("\n");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      consumeStdout(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pendingStdoutLine) {
        const parsed = parseJsonLine(pendingStdoutLine);
        if (parsed) onJsonLine?.(parsed);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `worker exited with code ${code}`));
    });
  });
}

// Produce a small AAC/m4a alongside output.wav for fast streaming playback.
// Best-effort: if ffmpeg is missing or fails, the audio route falls back to WAV.
// `+faststart` puts the moov atom first so playback starts before full download.
export async function transcodeWavToM4a(wavPath: string, m4aPath: string): Promise<void> {
  await runCommand(
    process.env.ANYVOICE_FFMPEG || "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", m4aPath],
    path.dirname(m4aPath),
  );
}

async function transcodeToCompressed(runDir: string): Promise<void> {
  try {
    await transcodeWavToM4a(path.join(runDir, "output.wav"), path.join(runDir, "output.m4a"));
  } catch {
    /* keep WAV-only playback */
  }
}

export function workerMissingPayload(jobId: string): CloneWorkerMissingPayload {
  return {
    status: "needs_worker",
    jobId,
    modelId: modelId(),
    message:
      "The Vercel app is ready, but VoxCPM2 inference is not connected. Set ANYVOICE_WORKER_URL and ANYVOICE_WORKER_TOKEN on Vercel, then run the protected local worker on the Mac Studio with ANYVOICE_ENABLE_LOCAL_VOXCPM=1.",
  };
}

async function writeInputFiles(jobId: string, input: CloneInput): Promise<CloneRunFiles> {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });

  const extension = fileExtension(input.voice.name, input.voice.type);
  const referencePath = path.join(runDir, `reference${extension}`);
  const targetTextPath = path.join(runDir, "target.txt");
  const targetTextRawPath = path.join(runDir, "target.raw.txt");
  const promptTranscriptPath = path.join(runDir, "prompt-transcript.txt");
  const promptTranscriptRawPath = path.join(runDir, "prompt-transcript.raw.txt");
  const outputPath = path.join(runDir, "output.wav");
  const metadataPath = path.join(runDir, "metadata.json");
  const textPrepPath = path.join(runDir, "text-prep.json");
  const requestPath = path.join(runDir, "request.json");
  const textPreparation = {
    targetText: prepareVoiceText(input.targetText, {
      pronunciationOverrides: input.pronunciationOverrides,
      autoApplyPresetPronunciations: true,
    }),
    promptTranscript: prepareVoiceText(input.promptTranscript),
  };
  const seed = stabilitySeed();

  await writeFile(referencePath, Buffer.from(await input.voice.arrayBuffer()));
  await writeFile(targetTextPath, textPreparation.targetText.model, "utf-8");
  await writeFile(targetTextRawPath, textPreparation.targetText.raw, "utf-8");
  await writeFile(promptTranscriptPath, textPreparation.promptTranscript.model, "utf-8");
  await writeFile(promptTranscriptRawPath, textPreparation.promptTranscript.raw, "utf-8");
  await writeFile(
    textPrepPath,
    `${JSON.stringify(
      {
        version: 1,
        targetText: textPreparation.targetText,
        promptTranscript: textPreparation.promptTranscript,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    requestPath,
    `${JSON.stringify(
      {
        status: "input_saved",
        modelId: modelId(),
        voiceName: input.voice.name,
        voiceType: input.voice.type,
        voiceSize: input.voice.size,
        quality: input.quality,
        stabilitySeed: seed,
        sourceKind: input.sourceKind,
        pronunciationOverrides: input.pronunciationOverrides ?? [],
        referenceSource: input.profileReference
          ? {
              kind: "profile",
              ...input.profileReference,
            }
          : {
              kind: input.sourceKind ?? "uploaded",
            },
        createdAt: new Date().toISOString(),
        textPreparation,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return {
    runDir,
    referencePath,
    targetTextPath,
    targetTextRawPath,
    promptTranscriptPath,
    promptTranscriptRawPath,
    outputPath,
    metadataPath,
    textPrepPath,
    requestPath,
    textPreparation,
  };
}

export async function recordWorkerMissingRun(jobId: string, input: CloneInput) {
  const { runDir, textPreparation } = await writeInputFiles(jobId, input);
  const seed = stabilitySeed();
  await writeFile(
    path.join(runDir, "request.json"),
    JSON.stringify(
      {
        status: "needs_worker",
        modelId: modelId(),
        voiceName: input.voice.name,
        voiceType: input.voice.type,
        voiceSize: input.voice.size,
        quality: input.quality,
        stabilitySeed: seed,
        sourceKind: input.sourceKind,
        pronunciationOverrides: input.pronunciationOverrides ?? [],
        referenceSource: input.profileReference
          ? {
              kind: "profile",
              ...input.profileReference,
            }
          : {
              kind: input.sourceKind ?? "uploaded",
            },
        createdAt: new Date().toISOString(),
        textPreparation,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

const DEFAULT_REFERENCE_QUALITY: ReferenceQuality = {
  grade: "C",
  durationSec: 0,
  snrDb: null,
  clippingRatio: 0,
  vadActiveRatio: 0,
  warnings: [],
};

const VALID_GRADES: ReadonlySet<ReferenceQualityGrade> = new Set(["A", "B", "C", "D"]);

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export function parseReferenceQuality(raw: unknown): ReferenceQuality {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_REFERENCE_QUALITY };
  const obj = raw as Record<string, unknown>;
  const gradeRaw = typeof obj.grade === "string" ? (obj.grade.toUpperCase() as ReferenceQualityGrade) : "C";
  const grade: ReferenceQualityGrade = VALID_GRADES.has(gradeRaw) ? gradeRaw : "C";
  return {
    grade,
    durationSec: asNumber(obj.durationSec ?? obj.duration_sec, 0),
    snrDb: asNullableNumber(obj.snrDb ?? obj.snr_db),
    clippingRatio: asNumber(obj.clippingRatio ?? obj.clipping_ratio, 0),
    vadActiveRatio: asNumber(obj.vadActiveRatio ?? obj.vad_active_ratio, 0),
    warnings: asStringArray(obj.warnings),
  };
}

export function parseEffectiveParams(raw: unknown, fallbackQuality: QualityPreset): EffectiveParams {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const qualityRaw = obj.qualityPreset ?? obj.quality_preset;
  const qualityPreset: QualityPreset =
    qualityRaw === "speed" || qualityRaw === "balanced" || qualityRaw === "quality"
      ? qualityRaw
      : fallbackQuality;
  return {
    timesteps: asNumber(obj.timesteps, 0),
    cfgValue: asNumber(obj.cfgValue ?? obj.cfg_value, 0),
    denoise: Boolean(obj.denoise),
    qualityPreset,
    cloneMode: obj.cloneMode === "prompt" || obj.clone_mode === "prompt" ? "prompt" : "hifi",
    voiceBackend:
      typeof obj.voiceBackend === "string"
        ? obj.voiceBackend
        : typeof obj.voice_backend === "string"
          ? obj.voice_backend
          : undefined,
    backendBaselineBackend:
      typeof obj.backendBaselineBackend === "string"
        ? obj.backendBaselineBackend
        : typeof obj.backend_baseline_backend === "string"
          ? obj.backend_baseline_backend
          : null,
    stabilitySeed: asNullableNumber(obj.stabilitySeed ?? obj.stability_seed ?? obj.seed),
    loraEnabled: Boolean(obj.loraEnabled ?? obj.lora_enabled),
    loraPath:
      typeof obj.loraPath === "string"
        ? obj.loraPath
        : typeof obj.lora_path === "string"
          ? obj.lora_path
          : null,
    backendSelectionJson:
      typeof obj.backendSelectionJson === "string"
        ? obj.backendSelectionJson
        : typeof obj.backend_selection_json === "string"
          ? obj.backend_selection_json
          : null,
    backendSelectionSha256:
      typeof obj.backendSelectionSha256 === "string"
        ? obj.backendSelectionSha256
        : typeof obj.backend_selection_sha256 === "string"
          ? obj.backend_selection_sha256
          : null,
    backendReviewJson:
      typeof obj.backendReviewJson === "string"
        ? obj.backendReviewJson
        : typeof obj.backend_review_json === "string"
          ? obj.backend_review_json
          : null,
    backendReviewSha256:
      typeof obj.backendReviewSha256 === "string"
        ? obj.backendReviewSha256
        : typeof obj.backend_review_sha256 === "string"
          ? obj.backend_review_sha256
          : null,
    backendSourceReport:
      typeof obj.backendSourceReport === "string"
        ? obj.backendSourceReport
        : typeof obj.backend_source_report === "string"
          ? obj.backend_source_report
          : null,
    backendSourceReportSha256:
      typeof obj.backendSourceReportSha256 === "string"
        ? obj.backendSourceReportSha256
        : typeof obj.backend_source_report_sha256 === "string"
          ? obj.backend_source_report_sha256
          : null,
    backendFallbackFrom:
      typeof obj.backendFallbackFrom === "string"
        ? obj.backendFallbackFrom
        : typeof obj.backend_fallback_from === "string"
          ? obj.backend_fallback_from
          : null,
    backendFallbackReason:
      typeof obj.backendFallbackReason === "string"
        ? obj.backendFallbackReason
        : typeof obj.backend_fallback_reason === "string"
          ? obj.backend_fallback_reason
          : null,
  };
}

function workerProgressPayload(
  jobId: string,
  currentModelId: string,
  raw: Record<string, unknown>,
  fallbackQuality: QualityPreset,
): CloneProgressPayload | null {
  if (raw.type !== "progress") return null;
  const phase = typeof raw.phase === "string" ? raw.phase : "";
  const validPhase: ReadonlySet<string> = new Set([
    "reference_preprocessing",
    "reference_analyzed",
    "model_loading",
    "model_ready",
    "synthesis_started",
    "audio_ready",
  ]);
  if (!validPhase.has(phase)) return null;

  const payload: CloneProgressPayload = {
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: phase as CloneProgressPhase,
  };
  if (typeof raw.message === "string") payload.message = raw.message;
  if (raw.referenceQuality) payload.referenceQuality = parseReferenceQuality(raw.referenceQuality);
  if (raw.effectiveParams) payload.effectiveParams = parseEffectiveParams(raw.effectiveParams, fallbackQuality);
  return payload;
}

function hotWorkerCloneUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/clone")) return url.toString();
    url.pathname = `${pathname}/clone`.replace(/\/+/g, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

const EXTERNAL_BACKEND_TEMPLATE_FIELDS = new Set([
  "backend",
  "target_text",
  "target_text_file",
  "target_text_raw",
  "target_text_raw_file",
  "text_prep_file",
  "reference_audio",
  "prompt_text_file",
  "output_wav",
  "seed",
  "quality",
  "model_id",
]);

function shellQuote(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function commandTemplateFields(template: string): Set<string> {
  const fields = new Set<string>();
  for (const match of template.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    const field = match[1];
    if (!EXTERNAL_BACKEND_TEMPLATE_FIELDS.has(field)) {
      throw new Error(
        `unknown profile backend renderer placeholder {${field}}; allowed placeholders: ${[
          ...EXTERNAL_BACKEND_TEMPLATE_FIELDS,
        ].sort().join(", ")}`,
      );
    }
    fields.add(field);
  }
  return fields;
}

function renderExternalBackendCommand(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  const fields = commandTemplateFields(template);
  if (!fields.has("output_wav")) {
    throw new Error("profile backend renderer command must include {output_wav}");
  }
  if (!fields.has("reference_audio")) {
    throw new Error("profile backend renderer command must include {reference_audio}");
  }
  if (!fields.has("target_text_file") && !fields.has("target_text")) {
    throw new Error("profile backend renderer command must include {target_text_file} or {target_text}");
  }
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, key: string) => shellQuote(values[key]));
}

export function preferredExternalProfileBackend(input: CloneInput): string | null {
  const backend = input.profileReference?.preferredBackend?.backend?.trim();
  if (!backend || backend === "voxcpm2-hifi" || backend === "voxcpm2-lora") return null;
  return backend;
}

export function hasPreferredExternalProfileBackend(input: CloneInput): boolean {
  return preferredExternalProfileBackend(input) !== null;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveEvidencePath(filePath: string): string {
  return path.resolve(expandHomePath(filePath));
}

async function fileSha256(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const data = await readFile(filePath);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
  };
}

async function readEvidenceJson(filePath: string, label: string): Promise<Record<string, unknown>> {
  const resolvedPath = resolveEvidencePath(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf-8"));
  } catch {
    throw new Error(`${label} evidence is stale or missing: missing or invalid JSON ${resolvedPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} evidence is stale or missing: JSON is not an object ${resolvedPath}`);
  }
  return parsed as Record<string, unknown>;
}

function resolveRelatedEvidencePath(filePath: unknown, baseDir: string): string | null {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  const expanded = expandHomePath(filePath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

function normalizeEvidencePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameEvidencePath(left: unknown, expected: string, baseDir: string): boolean {
  const resolvedLeft = resolveRelatedEvidencePath(left, baseDir);
  if (!resolvedLeft) return false;
  return normalizeEvidencePath(resolvedLeft) === normalizeEvidencePath(resolveEvidencePath(expected));
}

function sameEvidencePathFromBases(left: unknown, leftBaseDir: string, right: unknown, rightBaseDir: string): boolean {
  const resolvedLeft = resolveRelatedEvidencePath(left, leftBaseDir);
  const resolvedRight = resolveRelatedEvidencePath(right, rightBaseDir);
  if (!resolvedLeft || !resolvedRight) return false;
  return normalizeEvidencePath(resolvedLeft) === normalizeEvidencePath(resolvedRight);
}

function evidenceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function requireHashBoundPolicyFiles(
  policyName: string,
  files: Array<{ path: string; sha256: string; sha256Field: string; bytes?: number; bytesField?: string }>,
): Promise<void> {
  const errors: string[] = [];
  for (const file of files) {
    let actual: { sha256: string; bytes: number };
    const resolvedPath = resolveEvidencePath(file.path);
    try {
      actual = await fileSha256(resolvedPath);
    } catch {
      errors.push(`${file.sha256Field}: missing file ${resolvedPath}`);
      continue;
    }
    if (actual.sha256 !== file.sha256) {
      errors.push(`${file.sha256Field}: expected ${file.sha256} but found ${actual.sha256}`);
    }
    if (typeof file.bytes === "number" && actual.bytes !== file.bytes) {
      errors.push(`${file.bytesField ?? "bytes"}: expected ${file.bytes} but found ${actual.bytes}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${policyName} evidence is stale or missing: ${errors.join(", ")}`);
  }
}

async function requireReadableLoraAdapterProof(
  policyName: string,
  policy: {
    adapterProofJson: string;
    trainConfig: string;
    trainConfigSha256: string;
  },
): Promise<void> {
  const proof = await readEvidenceJson(policy.adapterProofJson, `${policyName} adapter proof`);
  const proofDir = path.dirname(resolveEvidencePath(policy.adapterProofJson));
  const checkpoint = evidenceObject(proof.checkpoint);
  const errors: string[] = [];

  if (proof.status !== "pass") errors.push("adapterProof.status=pass");
  if (checkpoint.status !== "readable") errors.push("adapterProof.checkpoint.status=readable");
  if (typeof checkpoint.loraParameterKeyCount !== "number" || !Number.isFinite(checkpoint.loraParameterKeyCount) || checkpoint.loraParameterKeyCount <= 0) {
    errors.push("adapterProof.checkpoint.loraParameterKeyCount");
  }
  if (!sameEvidencePath(proof.trainConfig, policy.trainConfig, proofDir)) {
    errors.push("adapterProof.trainConfig_matches_policy");
  }
  if (proof.trainConfigSha256 !== policy.trainConfigSha256) {
    errors.push("adapterProof.trainConfigSha256_matches_policy");
  }

  if (errors.length > 0) {
    throw new Error(`${policyName} adapter proof does not match its applied policy: ${errors.join(", ")}`);
  }
}

async function requireQualityGateArtifactProof(
  policyName: string,
  qualityGateJson: string,
  expectedProfile?: { voiceProfileId: string; profileSha256: string },
): Promise<void> {
  const gate = await readEvidenceJson(qualityGateJson, `${policyName} quality gate`);
  const gateDir = path.dirname(resolveEvidencePath(qualityGateJson));
  const proofs = evidenceObject(gate.proofs);
  const paths = evidenceObject(gate.paths);
  const artifacts = evidenceObject(proofs.artifacts);
  const errors: string[] = [];
  const resolved: Partial<Record<"report" | "asr" | "speaker" | "score", { path: string; sha256: string }>> = {};

  for (const key of ["report", "asr", "speaker", "score"] as const) {
    const artifact = evidenceObject(artifacts[key]);
    const artifactPath = resolveRelatedEvidencePath(artifact.path, gateDir);
    const pathsPath = resolveRelatedEvidencePath(paths[key], gateDir);
    const proofSha256 = artifact.sha256;

    if (!pathsPath) {
      errors.push(`${key}: paths.${key} missing`);
      continue;
    }
    if (!artifactPath) {
      errors.push(`${key}: artifact.path missing`);
      continue;
    }
    if (path.resolve(artifactPath) !== path.resolve(pathsPath)) {
      errors.push(`${key}: artifact.path does not match paths.${key}`);
      continue;
    }
    if (!validSha256(proofSha256)) {
      errors.push(`${key}: artifact.sha256 missing`);
      continue;
    }
    let actual: { sha256: string; bytes: number };
    try {
      actual = await fileSha256(pathsPath);
    } catch {
      errors.push(`${key}: missing file ${pathsPath}`);
      continue;
    }
    if (actual.sha256 !== proofSha256) {
      errors.push(`${key}: artifact.sha256 expected ${proofSha256} but found ${actual.sha256}`);
      continue;
    }
    resolved[key] = { path: pathsPath, sha256: actual.sha256 };
  }

  if (errors.length === 0) {
    const scorePath = resolved.score?.path;
    const score = scorePath ? await readEvidenceJson(scorePath, `${policyName} quality gate score`) : {};
    const reportPath = resolved.report?.path;
    const report = reportPath ? await readEvidenceJson(reportPath, `${policyName} quality gate source report`) : {};
    if (score.verdict !== "pass") errors.push("score.verdict=pass");
    pushQualityGateScoreSpeakerProofErrors(errors, score);
    if (resolved.report && !sameEvidencePath(score.sourceReport, resolved.report.path, path.dirname(scorePath!))) {
      errors.push("score.sourceReport_matches_paths.report");
    }
    if (resolved.report && score.sourceReportSha256 !== resolved.report.sha256) {
      errors.push("score.sourceReportSha256_matches_paths.report");
    }
    if (resolved.asr && !sameEvidencePath(score.asrJson, resolved.asr.path, path.dirname(scorePath!))) {
      errors.push("score.asrJson_matches_paths.asr");
    }
    if (resolved.asr && score.asrJsonSha256 !== resolved.asr.sha256) {
      errors.push("score.asrJsonSha256_matches_paths.asr");
    }
    if (resolved.speaker && !sameEvidencePath(score.speakerJson, resolved.speaker.path, path.dirname(scorePath!))) {
      errors.push("score.speakerJson_matches_paths.speaker");
    }
    if (resolved.speaker && score.speakerJsonSha256 !== resolved.speaker.sha256) {
      errors.push("score.speakerJsonSha256_matches_paths.speaker");
    }
    if (expectedProfile) {
      pushProfileEvidenceErrors(errors, "score.voiceProfile", score.voiceProfile, expectedProfile);
      const scoreRenderCount = pushGroupProfileEvidenceErrors(errors, "score", score.groups, expectedProfile);
      if (scoreRenderCount <= 0) errors.push("score.profile_render_evidence");

      pushProfileEvidenceErrors(errors, "sourceReport.voiceProfile", report.voiceProfile, expectedProfile);
      const reportRenderCount = pushGroupProfileEvidenceErrors(errors, "sourceReport", report.groups, expectedProfile);
      if (reportRenderCount <= 0) errors.push("sourceReport.profile_render_evidence");
    }
    await pushReadyRenderOutputEvidenceErrors(errors, "score", score.groups, scorePath!);
    await pushReadyRenderOutputEvidenceErrors(errors, "sourceReport", report.groups, reportPath!);
  }

  if (errors.length > 0) {
    throw new Error(`${policyName} quality gate proof is stale or missing: ${errors.join(", ")}`);
  }
}

async function pushReadyRenderOutputEvidenceErrors(
  errors: string[],
  rootLabel: string,
  groups: unknown,
  evidenceJsonPath: string,
): Promise<void> {
  if (!Array.isArray(groups)) {
    errors.push(`${rootLabel}.groups`);
    return;
  }
  const baseDir = path.dirname(resolveEvidencePath(evidenceJsonPath));
  for (const [groupIndex, group] of groups.entries()) {
    const groupObj = evidenceObject(group);
    const renders = groupObj.renders;
    if (!Array.isArray(renders)) continue;
    for (const [renderIndex, render] of renders.entries()) {
      const renderObj = evidenceObject(render);
      if (renderObj.status !== "ready") continue;
      const renderLabel = `${rootLabel}.groups[${groupIndex}].renders[${renderIndex}]`;
      if (renderObj.outputExists !== true || renderObj.missingOutput === true) {
        errors.push(`${renderLabel}.outputExists=true`);
      }
      if (typeof renderObj.outputBytes !== "number" || !Number.isFinite(renderObj.outputBytes) || renderObj.outputBytes <= 0) {
        errors.push(`${renderLabel}.outputBytes`);
      }
      if (!validSha256(renderObj.outputSha256)) errors.push(`${renderLabel}.outputSha256`);
      const outputPath = evidencePathFrom(renderObj.outputWav, baseDir);
      if (!outputPath) {
        errors.push(`${renderLabel}.outputWav`);
        continue;
      }
      let actual;
      try {
        actual = await fileSha256(outputPath);
      } catch {
        errors.push(`${renderLabel}.outputWav_exists`);
        continue;
      }
      if (typeof renderObj.outputBytes === "number" && renderObj.outputBytes !== actual.bytes) {
        errors.push(`${renderLabel}.outputBytes_matches_file`);
      }
      if (validSha256(renderObj.outputSha256) && renderObj.outputSha256 !== actual.sha256) {
        errors.push(`${renderLabel}.outputSha256_matches_file`);
      }
    }
  }
}

function renderEffectiveParams(render: Record<string, unknown>): Record<string, unknown> | null {
  for (const candidate of [render.metadataJson, render.hotWorkerMetadata, render]) {
    const effective = evidenceObject(candidate).effectiveParams;
    if (effective && typeof effective === "object" && !Array.isArray(effective)) {
      return effective as Record<string, unknown>;
    }
  }
  return null;
}

function selectedProfileClips(profile: Record<string, unknown>): Record<string, unknown>[] {
  const clips = Array.isArray(profile.clips) ? profile.clips : [];
  const requirements = evidenceObject(profile.requirements);
  const maxClips = typeof requirements.maxClips === "number" && Number.isFinite(requirements.maxClips)
    ? Math.max(0, Math.trunc(requirements.maxClips))
    : 10;
  return clips.filter((clip): clip is Record<string, unknown> => Boolean(clip && typeof clip === "object" && !Array.isArray(clip))).slice(0, maxClips);
}

function transcriptValidationRowsMatchProfile(
  validation: Record<string, unknown>,
  validationPath: string,
  profile: Record<string, unknown>,
  profileJson: string,
): boolean {
  const rows = Array.isArray(validation.clips) ? validation.clips : [];
  const rowBySource = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const rowObj = evidenceObject(row);
    const sourceRunId = typeof rowObj.sourceRunId === "string" ? rowObj.sourceRunId.trim() : "";
    if (sourceRunId) rowBySource.set(sourceRunId, rowObj);
  }
  const profileDir = path.dirname(resolveEvidencePath(profileJson));
  const validationDir = path.dirname(validationPath);
  for (const clip of selectedProfileClips(profile)) {
    const sourceRunId = typeof clip.sourceRunId === "string" ? clip.sourceRunId.trim() : "";
    const row = sourceRunId ? rowBySource.get(sourceRunId) : undefined;
    if (!row || row.verdict !== "pass") return false;
    const expected = typeof clip.transcriptRaw === "string" ? clip.transcriptRaw.trim() : "";
    if (row.expectedTranscript !== expected) return false;
    const rawAudioPath = typeof clip.audioPath === "string" ? clip.audioPath.trim() : "";
    if (!rawAudioPath) return false;
    const expectedAudioPath = resolveRelatedEvidencePath(rawAudioPath, profileDir);
    if (!expectedAudioPath || !sameEvidencePath(row.audioPath, expectedAudioPath, validationDir)) return false;
  }
  return true;
}

async function requireLoraSourceReportRenderEvidence(
  policyName: string,
  reportPath: string,
  policy: { path: string },
): Promise<void> {
  const report = await readEvidenceJson(reportPath, `${policyName} quality gate source report`);
  const reportDir = path.dirname(resolveEvidencePath(reportPath));
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const errors: string[] = [];
  let matchedRenders = 0;

  for (const [groupIndex, group] of groups.entries()) {
    const groupObj = evidenceObject(group);
    if (groupObj.cloneMode !== "hifi") continue;
    const renders = groupObj.renders;
    if (!Array.isArray(renders)) continue;
    for (const [renderIndex, render] of renders.entries()) {
      const renderObj = evidenceObject(render);
      if (renderObj.status !== "ready") continue;
      matchedRenders += 1;
      const renderLabel = `sourceReport.groups[${groupIndex}].renders[${renderIndex}]`;
      const effective = renderEffectiveParams(renderObj);
      if (!effective) {
        errors.push(`${renderLabel}.effectiveParams`);
        continue;
      }
      if (effective.loraEnabled !== true) errors.push(`${renderLabel}.effectiveParams.loraEnabled=true`);
      if (!sameEvidencePath(effective.loraPath, policy.path, reportDir)) {
        errors.push(`${renderLabel}.effectiveParams.loraPath_matches_policy`);
      }
    }
  }

  if (matchedRenders <= 0) errors.push("sourceReport.lora_render_evidence");
  if (errors.length > 0) {
    throw new Error(`${policyName} quality gate source report does not prove the applied LoRA adapter was loaded: ${errors.join(", ")}`);
  }
}

async function requireQualityGateTranscriptValidationProof(
  policyName: string,
  gate: Record<string, unknown>,
  gateDir: string,
  policy: { profileJson: string; profileSha256: string; voiceProfileId: string },
): Promise<void> {
  const inputs = evidenceObject(gate.inputs);
  const proofs = evidenceObject(gate.proofs);
  const paths = evidenceObject(gate.paths);
  const errors: string[] = [];

  if (inputs.skipTranscriptValidation === true) errors.push("inputs.skipTranscriptValidation=false");
  if (proofs.transcriptValidationRequired !== true) errors.push("transcriptValidationRequired=true");
  if (proofs.transcriptValidationPassed !== true) errors.push("transcriptValidationPassed=true");
  if (proofs.transcriptValidationSkipped === true) errors.push("transcriptValidationSkipped=false");

  const proofPaths = [
    resolveRelatedEvidencePath(proofs.transcriptValidationJson, gateDir),
    resolveRelatedEvidencePath(inputs.transcriptValidationJson, gateDir),
    resolveRelatedEvidencePath(paths.profileTranscriptValidation, gateDir),
  ].filter((value): value is string => Boolean(value));
  const uniqueProofPaths = [...new Set(proofPaths.map((value) => normalizeEvidencePath(value)))];
  if (uniqueProofPaths.length <= 0) {
    errors.push("transcriptValidationJson");
  } else if (uniqueProofPaths.length > 1) {
    errors.push("transcriptValidationJson_paths_agree");
  }

  const proofSha256s = [proofs.transcriptValidationSha256, inputs.transcriptValidationSha256].filter(validSha256);
  const uniqueSha256s = [...new Set(proofSha256s)];
  if (uniqueSha256s.length <= 0) {
    errors.push("transcriptValidationSha256");
  } else if (uniqueSha256s.length > 1) {
    errors.push("transcriptValidationSha256_agrees");
  }

  const proofPath = uniqueProofPaths.length === 1 ? uniqueProofPaths[0] : null;
  const proofSha256 = uniqueSha256s.length === 1 ? uniqueSha256s[0] : null;
  if (proofPath && proofSha256) {
    let actual;
    try {
      actual = await fileSha256(proofPath);
    } catch {
      errors.push("transcriptValidationJson_exists");
      actual = null;
    }
    if (actual && actual.sha256 !== proofSha256) {
      errors.push("transcriptValidationSha256_matches_file");
    }
    if (actual) {
      const validation = await readEvidenceJson(proofPath, `${policyName} transcript validation`);
      const validationDir = path.dirname(proofPath);
      const profile = await readEvidenceJson(policy.profileJson, `${policyName} transcript validation profile`);
      if (validation.status !== "pass") errors.push("transcriptValidation.status=pass");
      if (!sameEvidencePath(validation.profile, policy.profileJson, validationDir)) {
        errors.push("transcriptValidation.profile_matches_policy");
      }
      if (validation.voiceProfileId !== policy.voiceProfileId) {
        errors.push("transcriptValidation.voiceProfileId_matches_policy");
      }
      if (validation.profileSha256 !== policy.profileSha256) {
        errors.push("transcriptValidation.profileSha256_matches_policy");
      }
      if (!transcriptValidationRowsMatchProfile(validation, proofPath, profile, policy.profileJson)) {
        errors.push("transcriptValidation.rows_match_profile");
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`${policyName} quality gate transcript validation proof is stale or missing: ${errors.join(", ")}`);
  }
}

function qualityGateProofSummaryMatchesGate(
  summary: unknown,
  gate: Record<string, unknown>,
  summaryBaseDir: string,
  gateBaseDir: string,
): boolean {
  if (summary === undefined) return true;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const proof = summary as Record<string, unknown>;
  const inputs = evidenceObject(gate.inputs);
  const proofs = evidenceObject(gate.proofs);
  const speaker = evidenceObject(proofs.speakerBackendRequirement);
  const expectedFields: Array<[string, unknown]> = [
    ["status", gate.status],
    ["dryRun", gate.dryRun],
    ["cloneMode", inputs.cloneMode],
    ["speakerBackend", speaker.selected],
    ["requiredSpeakerBackend", speaker.required],
    ["profileVerifyRequired", proofs.profileVerifyRequired],
    ["profileVerifyPassed", proofs.profileVerifyPassed],
    ["profileVerifySkipped", proofs.profileVerifySkipped],
    ["transcriptValidationRequired", proofs.transcriptValidationRequired],
    ["transcriptValidationPassed", proofs.transcriptValidationPassed],
    ["transcriptValidationSkipped", proofs.transcriptValidationSkipped],
    ["transcriptValidationSha256", proofs.transcriptValidationSha256 ?? inputs.transcriptValidationSha256],
  ];
  if (expectedFields.some(([key, expected]) => proof[key] !== expected)) return false;

  const transcriptValidationJson = proofs.transcriptValidationJson ?? inputs.transcriptValidationJson;
  if (typeof transcriptValidationJson === "string" && transcriptValidationJson.trim()) {
    if (!sameEvidencePathFromBases(proof.transcriptValidationJson, summaryBaseDir, transcriptValidationJson, gateBaseDir)) return false;
  } else if (proof.transcriptValidationJson !== transcriptValidationJson) {
    return false;
  }

  const proofArtifacts = evidenceObject(proof.artifacts);
  const artifacts = evidenceObject(proofs.artifacts);
  for (const key of ["report", "asr", "speaker", "score"]) {
    const proofArtifact = evidenceObject(proofArtifacts[key]);
    const artifact = evidenceObject(artifacts[key]);
    if (typeof artifact.path === "string" && artifact.path.trim()) {
      if (!sameEvidencePathFromBases(proofArtifact.path, summaryBaseDir, artifact.path, gateBaseDir)) return false;
    } else if (proofArtifact.path !== artifact.path) {
      return false;
    }
    if (proofArtifact.sha256 !== artifact.sha256) return false;
  }
  return true;
}

function canonicalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEvidenceJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function subjectiveReviewSummaryMatches(
  summary: unknown,
  expected: Record<string, unknown>,
  summaryBaseDir: string,
  expectedBaseDir: string,
): boolean {
  if (summary === undefined) return true;
  const summaryObject = evidenceObject(summary);
  for (const key of ["reviewJson", "report"] as const) {
    const expectedPath = expected[key];
    if (typeof expectedPath === "string" && expectedPath.trim()) {
      if (!sameEvidencePathFromBases(summaryObject[key], summaryBaseDir, expectedPath, expectedBaseDir)) return false;
    } else if (summaryObject[key] !== expectedPath) {
      return false;
    }
  }
  for (const key of ["status", "reasons", "stats", "reviewStats", "statMismatches", "missingChoices", "invalidChoices"] as const) {
    if (canonicalEvidenceJson(summaryObject[key]) !== canonicalEvidenceJson(expected[key])) return false;
  }
  return true;
}

async function requireProfileLoraQualityGateProof(
  policyName: string,
  policy: {
    voiceProfileId: string;
    profileJson: string;
    profileSha256: string;
    path: string;
    bytes: number;
    sha256: string;
    qualityGateJson: string;
    qualityGateProof?: unknown;
  },
): Promise<void> {
  const gate = await readEvidenceJson(policy.qualityGateJson, `${policyName} quality gate`);
  const gateDir = path.dirname(resolveEvidencePath(policy.qualityGateJson));
  const inputs = evidenceObject(gate.inputs);
  const proofs = evidenceObject(gate.proofs);
  const paths = evidenceObject(gate.paths);
  const speaker = evidenceObject(proofs.speakerBackendRequirement);
  const adapter = evidenceObject(proofs.loraAdapter);
  const errors: string[] = [];

  if (gate.status !== "pass") errors.push("qualityGate.status=pass");
  if (gate.dryRun !== false) errors.push("qualityGate.dryRun=false");
  if (!sameEvidencePath(inputs.profileJson, policy.profileJson, gateDir)) errors.push("inputs.profileJson_matches_policy");
  if (inputs.profileSha256 !== policy.profileSha256) errors.push("inputs.profileSha256_matches_policy");
  if (inputs.cloneMode !== "hifi") errors.push("inputs.cloneMode=hifi");
  if (inputs.requireSpeakerBackend !== "speechbrain-ecapa") errors.push("inputs.requireSpeakerBackend=speechbrain-ecapa");
  if (inputs.skipProfileVerify === true) errors.push("inputs.skipProfileVerify=false");
  if (proofs.profileVerifyRequired !== true) errors.push("profileVerifyRequired=true");
  if (proofs.profileVerifyPassed !== true) errors.push("profileVerifyPassed=true");
  if (proofs.profileVerifySkipped === true) errors.push("profileVerifySkipped=false");
  if (!sameEvidencePath(inputs.loraPath, policy.path, gateDir)) errors.push("inputs.loraPath_matches_policy");
  if (speaker.selected !== "speechbrain-ecapa") errors.push("speakerBackendRequirement.selected=speechbrain-ecapa");
  if (speaker.required !== "speechbrain-ecapa") errors.push("speakerBackendRequirement.required=speechbrain-ecapa");
  if (adapter.exists !== true) errors.push("loraAdapter.exists=true");
  if (!sameEvidencePath(adapter.path, policy.path, gateDir)) errors.push("loraAdapter.path_matches_policy");
  if (adapter.bytes !== policy.bytes) errors.push("loraAdapter.bytes_matches_policy");
  if (adapter.sha256 !== policy.sha256) errors.push("loraAdapter.sha256_matches_policy");

  if (errors.length > 0) {
    throw new Error(`${policyName} quality gate proof does not match its applied policy: ${errors.join(", ")}`);
  }

  await requireQualityGateTranscriptValidationProof(policyName, gate, gateDir, policy);
  await requireQualityGateArtifactProof(policyName, policy.qualityGateJson, {
    voiceProfileId: policy.voiceProfileId,
    profileSha256: policy.profileSha256,
  });
  const reportPath = resolveRelatedEvidencePath(paths.report, gateDir);
  if (!reportPath) {
    throw new Error(`${policyName} quality gate source report does not prove the applied LoRA adapter was loaded: paths.report`);
  }
  await requireLoraSourceReportRenderEvidence(policyName, reportPath, policy);
  if (!qualityGateProofSummaryMatchesGate(policy.qualityGateProof, gate, process.cwd(), gateDir)) {
    throw new Error(
      `${policyName} quality gate proof does not match its applied policy: loraAdapter.qualityGateProof_matches_qualityGate`,
    );
  }
}

async function requireExternalBackendSelectionProof(
  policyName: string,
  backend: string,
  policy: {
    voiceProfileId: string;
    profileSha256: string;
    baselineBackend: string;
    selectionJson: string;
    scoreJson: string;
    scoreSha256: string;
    reviewJson: string;
    reviewSha256: string;
    sourceReport: string;
    sourceReportSha256: string;
    subjectiveReview?: unknown;
  },
): Promise<void> {
  const selection = await readEvidenceJson(policy.selectionJson, `${policyName} selection`);
  const review = await readEvidenceJson(policy.reviewJson, `${policyName} review`);
  const selectionDir = path.dirname(resolveEvidencePath(policy.selectionJson));
  const reviewDir = path.dirname(resolveEvidencePath(policy.reviewJson));
  const selectionProfile = selection.voiceProfile && typeof selection.voiceProfile === "object"
    ? (selection.voiceProfile as Record<string, unknown>)
    : null;
  const subjective = evidenceObject(selection.subjectiveReview);
  const subjectiveStats = evidenceObject(subjective.stats);
  const subjectiveReasons = Array.isArray(subjective.reasons) ? subjective.reasons : [];
  const subjectiveMissingChoices = Array.isArray(subjective.missingChoices) ? subjective.missingChoices : [];
  const subjectiveInvalidChoices = Array.isArray(subjective.invalidChoices) ? subjective.invalidChoices : [];
  const subjectiveRounds = typeof subjectiveStats.rounds === "number" && Number.isFinite(subjectiveStats.rounds)
    ? subjectiveStats.rounds
    : 0;
  const subjectiveReviewedRounds = typeof subjectiveStats.reviewedRounds === "number" && Number.isFinite(subjectiveStats.reviewedRounds)
    ? subjectiveStats.reviewedRounds
    : -1;
  const subjectiveBaselineWins = typeof subjectiveStats.baselineWins === "number" && Number.isFinite(subjectiveStats.baselineWins)
    ? subjectiveStats.baselineWins
    : -1;
  const subjectiveCandidateWins = typeof subjectiveStats.candidateWins === "number" && Number.isFinite(subjectiveStats.candidateWins)
    ? subjectiveStats.candidateWins
    : -1;
  const reviewChoices = review.choices && typeof review.choices === "object" && !Array.isArray(review.choices)
    ? (review.choices as Record<string, unknown>)
    : {};
  const reviewStats = evidenceObject(review.stats);
  const reviewStatFields = [
    "rounds",
    "reviewedRounds",
    "candidateWins",
    "baselineWins",
    "ties",
    "rerenders",
    "candidateWinRate",
    "minCandidateWinRate",
  ];
  const errors: string[] = [];

  if (selection.verdict !== "accept") errors.push("selection.verdict=accept");
  if (selection.accepted !== true) errors.push("selection.accepted=true");
  if (subjective.status !== "pass") errors.push("selection.subjectiveReview.status=pass");
  if (subjectiveReasons.length > 0) errors.push("selection.subjectiveReview.reasons=[]");
  if (subjectiveMissingChoices.length > 0) errors.push("selection.subjectiveReview.missingChoices=[]");
  if (subjectiveInvalidChoices.length > 0) errors.push("selection.subjectiveReview.invalidChoices=[]");
  if (subjectiveRounds <= 0) errors.push("selection.subjectiveReview.stats.rounds");
  if (subjectiveReviewedRounds !== subjectiveRounds) errors.push("selection.subjectiveReview.stats.reviewedRounds_matches_rounds");
  if (subjectiveStats.rerenders !== 0) errors.push("selection.subjectiveReview.stats.rerenders=0");
  if (subjectiveBaselineWins > subjectiveCandidateWins) {
    errors.push("selection.subjectiveReview.stats.baselineWins<=candidateWins");
  }
  if (!subjectiveReviewSummaryMatches(policy.subjectiveReview, subjective, process.cwd(), selectionDir)) {
    errors.push("preferredBackend.subjectiveReview_matches_selection");
  }
  if (selection.candidateCloneMode !== backend) {
    errors.push(`selection.candidateCloneMode expected ${backend} but found ${String(selection.candidateCloneMode ?? "")}`);
  }
  if (selection.baselineCloneMode !== policy.baselineBackend) {
    errors.push(
      `selection.baselineCloneMode expected ${policy.baselineBackend} but found ${String(selection.baselineCloneMode ?? "")}`,
    );
  }
  if (policy.baselineBackend !== "voxcpm2-hifi") {
    errors.push(`preferredBackend.baselineBackend expected voxcpm2-hifi but found ${policy.baselineBackend}`);
  }
  if (!selectionProfile) {
    errors.push("selection.voiceProfile");
  } else {
    if (selectionProfile.voiceProfileId !== policy.voiceProfileId) {
      errors.push(
        `selection.voiceProfile.voiceProfileId expected ${policy.voiceProfileId} but found ${String(selectionProfile.voiceProfileId ?? "")}`,
      );
    }
    if (selectionProfile.profileSha256 !== policy.profileSha256) {
      errors.push(
        `selection.voiceProfile.profileSha256 expected ${policy.profileSha256} but found ${String(selectionProfile.profileSha256 ?? "")}`,
      );
    }
  }
  if (!sameEvidencePath(selection.scoreJson, policy.scoreJson, selectionDir)) errors.push("selection.scoreJson_matches_policy");
  if (selection.scoreSha256 !== policy.scoreSha256) errors.push("selection.scoreSha256_matches_policy");
  if (!sameEvidencePath(selection.reviewJson, policy.reviewJson, selectionDir)) errors.push("selection.reviewJson_matches_policy");
  if (selection.reviewSha256 !== policy.reviewSha256) errors.push("selection.reviewSha256_matches_policy");
  if (!sameEvidencePath(selection.sourceReport, policy.sourceReport, selectionDir)) {
    errors.push("selection.sourceReport_matches_policy");
  }
  if (selection.sourceReportSha256 !== policy.sourceReportSha256) {
    errors.push("selection.sourceReportSha256_matches_policy");
  }
  if (!sameEvidencePath(review.reportPath ?? review.report, policy.sourceReport, reviewDir)) {
    errors.push("review.sourceReport_matches_policy");
  }
  if (review.status !== "pass") errors.push("review.status=pass");
  if (review.reportSha256 !== policy.sourceReportSha256) {
    errors.push("review.reportSha256_matches_policy");
  }
  if (reviewStats.reportSha256 !== policy.sourceReportSha256) {
    errors.push("review.stats.reportSha256_matches_policy");
  }
  for (const field of reviewStatFields) {
    if (reviewStats[field] !== subjectiveStats[field]) {
      errors.push(`review.stats.${field}_matches_selection`);
    }
  }
  if (Object.keys(reviewChoices).length <= 0) {
    errors.push("review.choices");
  }

  if (errors.length > 0) {
    throw new Error(`${policyName} selection proof does not match its applied policy: ${errors.join(", ")}`);
  }
}

function pushProfileEvidenceErrors(
  errors: string[],
  label: string,
  value: unknown,
  policy: { voiceProfileId: string; profileSha256: string },
): void {
  const evidence = evidenceObject(value);
  if (evidence.voiceProfileId !== policy.voiceProfileId) {
    errors.push(`${label}.voiceProfileId`);
  }
  if (evidence.profileSha256 !== policy.profileSha256) {
    errors.push(`${label}.profileSha256`);
  }
}

function pushGroupProfileEvidenceErrors(
  errors: string[],
  rootLabel: string,
  groups: unknown,
  policy: { voiceProfileId: string; profileSha256: string },
): number {
  if (!Array.isArray(groups)) {
    errors.push(`${rootLabel}.groups`);
    return 0;
  }

  let matchedRenders = 0;
  for (const [groupIndex, group] of groups.entries()) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const groupLabel = `${rootLabel}.groups[${groupIndex}]`;
    pushProfileEvidenceErrors(errors, groupLabel, group, policy);
    const renders = (group as Record<string, unknown>).renders;
    if (!Array.isArray(renders)) continue;
    for (const [renderIndex, render] of renders.entries()) {
      if (!render || typeof render !== "object" || Array.isArray(render)) continue;
      matchedRenders += 1;
      pushProfileEvidenceErrors(errors, `${groupLabel}.renders[${renderIndex}]`, render, policy);
    }
  }
  return matchedRenders;
}

function pushScoreGroupVerdictErrors(
  errors: string[],
  label: string,
  groups: unknown,
  expectedCloneMode: string,
): void {
  if (!Array.isArray(groups)) {
    errors.push(`${label}.groups`);
    return;
  }
  let matchedGroups = 0;
  let readyRenders = 0;
  for (const [groupIndex, group] of groups.entries()) {
    const groupObj = evidenceObject(group);
    if (groupObj.cloneMode !== expectedCloneMode) continue;
    matchedGroups += 1;
    const groupLabel = `${label}.groups[${groupIndex}]`;
    if (groupObj.verdict !== "pass") errors.push(`${groupLabel}.verdict=pass`);
    if (groupObj.pronunciationVerdict !== "pass") errors.push(`${groupLabel}.pronunciationVerdict=pass`);
    if (groupObj.stabilityVerdict !== "pass") errors.push(`${groupLabel}.stabilityVerdict=pass`);
    if (groupObj.speakerIdentityVerdict !== "pass") errors.push(`${groupLabel}.speakerIdentityVerdict=pass`);
    if (groupObj.audioQualityVerdict !== "pass") errors.push(`${groupLabel}.audioQualityVerdict=pass`);
    const renders = groupObj.renders;
    if (!Array.isArray(renders)) continue;
    for (const [renderIndex, render] of renders.entries()) {
      const renderObj = evidenceObject(render);
      if (renderObj.status !== "ready") {
        errors.push(`${groupLabel}.renders[${renderIndex}].status=ready`);
      } else {
        readyRenders += 1;
      }
    }
  }
  if (matchedGroups <= 0) errors.push(`${label}.${expectedCloneMode}.groups`);
  if (readyRenders <= 0) errors.push(`${label}.${expectedCloneMode}.ready_renders`);
}

function pushQualityGateScoreSpeakerProofErrors(errors: string[], score: unknown): void {
  const scoreObj = evidenceObject(score);
  const thresholds = evidenceObject(scoreObj.thresholds);
  if (thresholds.requireProfileReferenceSimilarity !== true) {
    errors.push("score.thresholds.requireProfileReferenceSimilarity=true");
  }
  const groups = scoreObj.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    errors.push("score.groups");
    return;
  }
  for (const [groupIndex, group] of groups.entries()) {
    const groupObj = evidenceObject(group);
    const groupLabel = `score.groups[${groupIndex}]`;
    if (groupObj.verdict !== "pass") errors.push(`${groupLabel}.verdict=pass`);
    if (groupObj.speakerIdentityVerdict !== "pass") errors.push(`${groupLabel}.speakerIdentityVerdict=pass`);
    const renderCount = typeof groupObj.renderCount === "number" && Number.isFinite(groupObj.renderCount)
      ? groupObj.renderCount
      : null;
    if (!renderCount || renderCount <= 0) errors.push(`${groupLabel}.renderCount`);
    const identity = evidenceObject(groupObj.speakerIdentity);
    if (identity.verdict !== "pass") errors.push(`${groupLabel}.speakerIdentity.verdict=pass`);
    if (identity.requireProfileReferenceSimilarity !== true) {
      errors.push(`${groupLabel}.speakerIdentity.requireProfileReferenceSimilarity=true`);
    }
    if (identity.profileReferenceEvaluatedRenders !== renderCount) {
      errors.push(`${groupLabel}.speakerIdentity.profileReferenceEvaluatedRenders_matches_renderCount`);
    }
  }
}

function evidencePathFrom(rawPath: unknown, baseDir: string): string | null {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const expanded = expandHomePath(rawPath.trim());
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded));
}

async function pushExternalCandidateRenderEvidenceErrors(
  errors: string[],
  rootLabel: string,
  groups: unknown,
  backend: string,
  sourceReportPath: string,
): Promise<void> {
  if (!Array.isArray(groups)) {
    errors.push(`${rootLabel}.groups`);
    return;
  }
  const sourceReportDir = path.dirname(resolveEvidencePath(sourceReportPath));
  let readyCandidateRenders = 0;
  let externalCandidateRenders = 0;

  for (const [groupIndex, group] of groups.entries()) {
    const groupObj = evidenceObject(group);
    if (groupObj.cloneMode !== backend) continue;
    const renders = groupObj.renders;
    if (!Array.isArray(renders)) continue;
    for (const [renderIndex, render] of renders.entries()) {
      const renderObj = evidenceObject(render);
      const renderLabel = `${rootLabel}.groups[${groupIndex}].renders[${renderIndex}]`;
      if (renderObj.status !== "ready") {
        errors.push(`${renderLabel}.status=ready`);
        continue;
      }
      readyCandidateRenders += 1;
      if (renderObj.externalBackend === true) externalCandidateRenders += 1;
      if (renderObj.externalBackend !== true) errors.push(`${renderLabel}.externalBackend=true`);
      if (renderObj.outputExists !== true || renderObj.missingOutput === true) {
        errors.push(`${renderLabel}.outputExists=true`);
      }
      if (typeof renderObj.outputBytes !== "number" || !Number.isFinite(renderObj.outputBytes) || renderObj.outputBytes <= 0) {
        errors.push(`${renderLabel}.outputBytes`);
      }
      if (!validSha256(renderObj.outputSha256)) errors.push(`${renderLabel}.outputSha256`);
      const outputPath = evidencePathFrom(renderObj.outputWav, sourceReportDir);
      if (!outputPath) {
        errors.push(`${renderLabel}.outputWav`);
        continue;
      }
      let actual;
      try {
        actual = await fileSha256(outputPath);
      } catch {
        errors.push(`${renderLabel}.outputWav_exists`);
        continue;
      }
      if (typeof renderObj.outputBytes === "number" && renderObj.outputBytes !== actual.bytes) {
        errors.push(`${renderLabel}.outputBytes_matches_file`);
      }
      if (validSha256(renderObj.outputSha256) && renderObj.outputSha256 !== actual.sha256) {
        errors.push(`${renderLabel}.outputSha256_matches_file`);
      }
    }
  }

  if (readyCandidateRenders <= 0) errors.push(`${rootLabel}.candidate_ready_renders`);
  if (externalCandidateRenders <= 0) errors.push(`${rootLabel}.candidate_external_render_evidence`);
}

async function requireExternalBackendScoreProof(
  policyName: string,
  backend: string,
  policy: {
    voiceProfileId: string;
    profileSha256: string;
    baselineBackend: string;
    scoreJson: string;
    sourceReport: string;
    sourceReportSha256: string;
  },
): Promise<void> {
  const score = await readEvidenceJson(policy.scoreJson, `${policyName} score`);
  const scoreDir = path.dirname(resolveEvidencePath(policy.scoreJson));
  const report = await readEvidenceJson(policy.sourceReport, `${policyName} source report`);
  const errors: string[] = [];

  if (score.verdict !== "pass") errors.push("score.verdict=pass");
  if (!sameEvidencePath(score.sourceReport, policy.sourceReport, scoreDir)) {
    errors.push("score.sourceReport_matches_policy");
  }
  if (score.sourceReportSha256 !== policy.sourceReportSha256) {
    errors.push("score.sourceReportSha256_matches_policy");
  }
  pushProfileEvidenceErrors(errors, "score.voiceProfile", score.voiceProfile, policy);
  const scoreRenderCount = pushGroupProfileEvidenceErrors(errors, "score", score.groups, policy);
  if (scoreRenderCount <= 0) errors.push("score.profile_render_evidence");
  pushScoreGroupVerdictErrors(errors, "score.baseline", score.groups, policy.baselineBackend);
  pushScoreGroupVerdictErrors(errors, "score.candidate", score.groups, backend);
  await pushReadyRenderOutputEvidenceErrors(errors, "score", score.groups, policy.scoreJson);

  pushProfileEvidenceErrors(errors, "sourceReport.voiceProfile", report.voiceProfile, policy);
  const reportGroups = Array.isArray(report.groups)
    ? report.groups.filter((group) => {
        const cloneMode = evidenceObject(group).cloneMode;
        return cloneMode === policy.baselineBackend || cloneMode === backend;
      })
    : report.groups;
  const reportRenderCount = pushGroupProfileEvidenceErrors(errors, "sourceReport", reportGroups, policy);
  if (reportRenderCount <= 0) errors.push("sourceReport.profile_render_evidence");
  await pushExternalCandidateRenderEvidenceErrors(errors, "sourceReport", report.groups, backend, policy.sourceReport);

  if (errors.length > 0) {
    throw new Error(`${policyName} score proof does not match its applied policy: ${errors.join(", ")}`);
  }
}

async function requirePolicyProfileHash(policyName: string, profileJson: string, profileSha256: string): Promise<void> {
  const resolvedPath = resolveEvidencePath(profileJson);
  let profile: unknown;
  try {
    profile = JSON.parse(await readFile(resolvedPath, "utf-8"));
  } catch {
    throw new Error(`${policyName} profile evidence is stale or missing: profileJson missing or invalid ${resolvedPath}`);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`${policyName} profile evidence is stale or missing: profileJson is not an object ${resolvedPath}`);
  }
  const actualSha256 = canonicalVoiceProfileSha256(profile);
  if (actualSha256 !== profileSha256) {
    throw new Error(
      `${policyName} profile evidence is stale or missing: profileSha256 expected ${profileSha256} but found ${actualSha256}`,
    );
  }
}

async function requireAcceptedExternalProfileBackendPolicy(input: CloneInput, backend: string): Promise<void> {
  if (backend !== "indextts2" && backend !== "f5-tts" && backend !== "fishaudio-s2-pro") {
    throw new Error(`profile preferred backend ${backend} is unsupported; allowed external backends: indextts2, f5-tts, fishaudio-s2-pro`);
  }
  const reference = input.profileReference;
  const policy = reference?.preferredBackend;
  const missing: string[] = [];

  if (!reference) missing.push("profileReference");
  if (!policy || policy.status !== "accepted") missing.push("preferredBackend.status=accepted");
  if (!policy?.profileJson) missing.push("preferredBackend.profileJson");
  if (!policy?.voiceProfileId) missing.push("preferredBackend.voiceProfileId");
  if (reference && policy?.voiceProfileId && policy.voiceProfileId !== reference.voiceProfileId) {
    missing.push("preferredBackend.voiceProfileId_matches_profileReference");
  }
  if (!validSha256(policy?.profileSha256)) missing.push("preferredBackend.profileSha256");
  if (!policy?.baselineBackend) missing.push("preferredBackend.baselineBackend");
  if (!policy?.selectionJson) missing.push("preferredBackend.selectionJson");
  if (!validSha256(policy?.selectionSha256)) missing.push("preferredBackend.selectionSha256");
  if (!policy?.scoreJson) missing.push("preferredBackend.scoreJson");
  if (!validSha256(policy?.scoreSha256)) missing.push("preferredBackend.scoreSha256");
  if (!policy?.reviewJson) missing.push("preferredBackend.reviewJson");
  if (!validSha256(policy?.reviewSha256)) missing.push("preferredBackend.reviewSha256");
  if (!policy?.sourceReport) missing.push("preferredBackend.sourceReport");
  if (!validSha256(policy?.sourceReportSha256)) missing.push("preferredBackend.sourceReportSha256");

  if (missing.length > 0) {
    throw new Error(
      `profile preferred backend ${backend} is selected but its evidence policy is incomplete: ${missing.join(", ")}`,
    );
  }
  const acceptedPolicy = policy as {
    voiceProfileId: string;
    profileJson: string;
    profileSha256: string;
    baselineBackend: string;
    selectionJson: string;
    selectionSha256: string;
    scoreJson: string;
    scoreSha256: string;
    reviewJson: string;
    reviewSha256: string;
    sourceReport: string;
    sourceReportSha256: string;
    subjectiveReview?: unknown;
  };

  await requirePolicyProfileHash(
    `profile preferred backend ${backend}`,
    acceptedPolicy.profileJson,
    acceptedPolicy.profileSha256,
  );
  await requireHashBoundPolicyFiles(`profile preferred backend ${backend}`, [
    {
      path: acceptedPolicy.selectionJson,
      sha256: acceptedPolicy.selectionSha256,
      sha256Field: "preferredBackend.selectionSha256",
    },
    {
      path: acceptedPolicy.scoreJson,
      sha256: acceptedPolicy.scoreSha256,
      sha256Field: "preferredBackend.scoreSha256",
    },
    {
      path: acceptedPolicy.reviewJson,
      sha256: acceptedPolicy.reviewSha256,
      sha256Field: "preferredBackend.reviewSha256",
    },
    {
      path: acceptedPolicy.sourceReport,
      sha256: acceptedPolicy.sourceReportSha256,
      sha256Field: "preferredBackend.sourceReportSha256",
    },
  ]);
  await requireExternalBackendScoreProof(`profile preferred backend ${backend}`, backend, acceptedPolicy);
  await requireExternalBackendSelectionProof(`profile preferred backend ${backend}`, backend, acceptedPolicy);
}

async function requireAcceptedProfileLoraAdapterPolicy(input: CloneInput): Promise<void> {
  const reference = input.profileReference;
  const loraPath = reference?.loraPath?.trim();
  if (!loraPath) return;
  const policy = reference?.loraAdapter;
  const missing: string[] = [];

  if (!reference) missing.push("profileReference");
  if (!policy || policy.status !== "accepted") missing.push("loraAdapter.status=accepted");
  if (!policy?.profileJson) missing.push("loraAdapter.profileJson");
  if (!policy?.voiceProfileId) missing.push("loraAdapter.voiceProfileId");
  if (reference && policy?.voiceProfileId && policy.voiceProfileId !== reference.voiceProfileId) {
    missing.push("loraAdapter.voiceProfileId_matches_profileReference");
  }
  if (!validSha256(policy?.profileSha256)) missing.push("loraAdapter.profileSha256");
  if (!policy?.path) {
    missing.push("loraAdapter.path");
  } else if (!sameEvidencePath(policy.path, loraPath, process.cwd())) {
    missing.push("loraAdapter.path_matches_loraPath");
  }
  if (typeof policy?.bytes !== "number" || !Number.isFinite(policy.bytes) || policy.bytes <= 0) {
    missing.push("loraAdapter.bytes");
  }
  if (!validSha256(policy?.sha256)) missing.push("loraAdapter.sha256");
  if (!policy?.adapterProofJson) missing.push("loraAdapter.adapterProofJson");
  if (!validSha256(policy?.adapterProofSha256)) missing.push("loraAdapter.adapterProofSha256");
  if (!policy?.qualityGateJson) missing.push("loraAdapter.qualityGateJson");
  if (!validSha256(policy?.qualityGateSha256)) missing.push("loraAdapter.qualityGateSha256");
  if (!policy?.trainConfig) missing.push("loraAdapter.trainConfig");
  if (!validSha256(policy?.trainConfigSha256)) missing.push("loraAdapter.trainConfigSha256");

  if (missing.length > 0) {
    throw new Error(`profile LoRA adapter is selected but its evidence policy is incomplete: ${missing.join(", ")}`);
  }
  const acceptedPolicy = policy as {
    voiceProfileId: string;
    profileJson: string;
    profileSha256: string;
    path: string;
    bytes: number;
    sha256: string;
    adapterProofJson: string;
    adapterProofSha256: string;
    qualityGateJson: string;
    qualityGateSha256: string;
    trainConfig: string;
    trainConfigSha256: string;
    qualityGateProof?: unknown;
  };

  await requirePolicyProfileHash("profile LoRA adapter", acceptedPolicy.profileJson, acceptedPolicy.profileSha256);
  await requireHashBoundPolicyFiles("profile LoRA adapter", [
    {
      path: acceptedPolicy.path,
      sha256: acceptedPolicy.sha256,
      sha256Field: "loraAdapter.sha256",
      bytes: acceptedPolicy.bytes,
      bytesField: "loraAdapter.bytes",
    },
    {
      path: acceptedPolicy.adapterProofJson,
      sha256: acceptedPolicy.adapterProofSha256,
      sha256Field: "loraAdapter.adapterProofSha256",
    },
    {
      path: acceptedPolicy.qualityGateJson,
      sha256: acceptedPolicy.qualityGateSha256,
      sha256Field: "loraAdapter.qualityGateSha256",
    },
    {
      path: acceptedPolicy.trainConfig,
      sha256: acceptedPolicy.trainConfigSha256,
      sha256Field: "loraAdapter.trainConfigSha256",
    },
  ]);
  await requireReadableLoraAdapterProof("profile LoRA adapter", acceptedPolicy);
  await requireProfileLoraQualityGateProof("profile LoRA adapter", acceptedPolicy);
}

function effectiveLoraPath(input: CloneInput): string {
  const profilePath = input.profileReference?.loraPath?.trim();
  return profilePath || voxcpmLoraPath();
}

function effectiveVoxCpmBackend(input: CloneInput): "voxcpm2-hifi" | "voxcpm2-lora" {
  return effectiveLoraPath(input) ? "voxcpm2-lora" : "voxcpm2-hifi";
}

async function parseHotWorkerStream(
  response: Response,
  {
    jobId,
    currentModelId,
    fallbackQuality,
    onProgress,
  }: {
    jobId: string;
    currentModelId: string;
    fallbackQuality: QualityPreset;
    onProgress?: CloneProgressCallback;
  },
) {
  const reader = response.body?.getReader();
  if (!reader) {
    if (!response.ok) throw new Error((await response.text()) || "hot worker request failed");
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string) => {
    const parsed = parseJsonLine(line);
    if (!parsed) return;
    if (parsed.type === "error") {
      throw new Error(String(parsed.traceback || parsed.message || "hot worker request failed"));
    }
    const payload = workerProgressPayload(jobId, currentModelId, parsed, fallbackQuality);
    if (payload) onProgress?.(payload);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) consumeLine(buffer);
  } finally {
    // Release the underlying connection even when consumeLine throws on a
    // worker `type=error` line, so a failed stream does not leak the socket.
    await reader.cancel().catch(() => {});
  }

  if (!response.ok) {
    throw new Error("hot worker request failed");
  }
}

async function runHotClone(
  jobId: string,
  input: CloneInput,
  files: CloneRunFiles,
  currentModelId: string,
  onProgress?: CloneProgressCallback,
) {
  const endpoint = hotWorkerCloneUrl(hotWorkerUrl());
  if (!endpoint) throw new Error("ANYVOICE_HOT_WORKER_URL is invalid");
  const loraPath = effectiveLoraPath(input);
  const seed = stabilitySeed();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      textFile: files.targetTextPath,
      referenceAudio: files.referencePath,
      promptTextFile: files.promptTranscriptPath,
      output: files.outputPath,
      metadataOutput: files.metadataPath,
      textPrepFile: files.textPrepPath,
      quality: input.quality,
      stabilitySeed: seed,
      modelId: currentModelId,
      cloneMode: voxcpmCloneMode(),
      ...(loraPath ? { loraPath } : {}),
    }),
  });

  await parseHotWorkerStream(response, {
    jobId,
    currentModelId,
    fallbackQuality: input.quality,
    onProgress,
  });
}

async function requireNonEmptyOutput(outputPath: string, backend: string): Promise<void> {
  let stats;
  try {
    stats = await stat(outputPath);
  } catch {
    throw new Error(`profile backend ${backend} did not write output WAV: ${outputPath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`profile backend ${backend} wrote an empty output WAV: ${outputPath}`);
  }
}

async function runExternalProfileBackend(
  jobId: string,
  input: CloneInput,
  files: CloneRunFiles,
  currentModelId: string,
  backend: string,
  onProgress?: CloneProgressCallback,
  fallback?: { fromBackend: string; reason: string },
): Promise<void> {
  const template = profileBackendRenderCommand();
  if (!template) {
    throw new Error(
      `profile preferred backend ${backend} is selected but no renderer command is configured; set ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND or ANYVOICE_BACKEND_RENDER_COMMAND`,
    );
  }
  const seed = stabilitySeed();
  const command = renderExternalBackendCommand(template, {
    backend,
    target_text: files.textPreparation.targetText.model,
    target_text_file: files.targetTextPath,
    target_text_raw: files.textPreparation.targetText.raw,
    target_text_raw_file: files.targetTextRawPath,
    text_prep_file: files.textPrepPath,
    reference_audio: files.referencePath,
    prompt_text_file: files.promptTranscriptPath,
    output_wav: files.outputPath,
    seed,
    quality: input.quality,
    model_id: currentModelId,
  });
  onProgress?.({
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: "synthesis_started",
    message: fallback ? `${backend} fallback from ${fallback.fromBackend}` : backend,
  });
  const result = await runCommand("/bin/sh", ["-lc", command], process.cwd());
  await writeFile(path.join(files.runDir, "worker.log"), [result.stdout, result.stderr].filter(Boolean).join("\n"), "utf-8");
  await requireNonEmptyOutput(files.outputPath, backend);
  await writeFile(
    files.metadataPath,
    `${JSON.stringify(
      {
        model_id: currentModelId,
        clone_mode: backend,
        referenceQuality: input.profileReference?.referenceQuality ?? DEFAULT_REFERENCE_QUALITY,
        textPreparation: files.textPreparation,
        effectiveParams: {
          timesteps: 0,
          cfgValue: 0,
          denoise: false,
          qualityPreset: input.quality,
          cloneMode: "hifi",
          voiceBackend: backend,
          backendBaselineBackend: input.profileReference?.preferredBackend?.baselineBackend ?? null,
          stabilitySeed: seed,
          loraEnabled: false,
          loraPath: null,
          backendSelectionJson: input.profileReference?.preferredBackend?.selectionJson ?? null,
          backendSelectionSha256: input.profileReference?.preferredBackend?.selectionSha256 ?? null,
          backendReviewJson: input.profileReference?.preferredBackend?.reviewJson ?? null,
          backendReviewSha256: input.profileReference?.preferredBackend?.reviewSha256 ?? null,
          backendSourceReport: input.profileReference?.preferredBackend?.sourceReport ?? null,
          backendSourceReportSha256: input.profileReference?.preferredBackend?.sourceReportSha256 ?? null,
          backendFallbackFrom: fallback?.fromBackend ?? null,
          backendFallbackReason: fallback?.reason ?? null,
        },
        externalBackend: {
          backend,
          baselineBackend: input.profileReference?.preferredBackend?.baselineBackend ?? null,
          commandTemplateEnv: process.env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND
            ? "ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND"
            : "ANYVOICE_BACKEND_RENDER_COMMAND",
          profileJson: input.profileReference?.preferredBackend?.profileJson ?? null,
          voiceProfileId: input.profileReference?.preferredBackend?.voiceProfileId ?? null,
          profileSha256: input.profileReference?.preferredBackend?.profileSha256 ?? null,
          selectionJson: input.profileReference?.preferredBackend?.selectionJson ?? null,
          selectionSha256: input.profileReference?.preferredBackend?.selectionSha256 ?? null,
          scoreJson: input.profileReference?.preferredBackend?.scoreJson ?? null,
          scoreSha256: input.profileReference?.preferredBackend?.scoreSha256 ?? null,
          reviewJson: input.profileReference?.preferredBackend?.reviewJson ?? null,
          reviewSha256: input.profileReference?.preferredBackend?.reviewSha256 ?? null,
          sourceReport: input.profileReference?.preferredBackend?.sourceReport ?? null,
          sourceReportSha256: input.profileReference?.preferredBackend?.sourceReportSha256 ?? null,
          subjectiveReview: input.profileReference?.preferredBackend?.subjectiveReview ?? null,
          fallbackFrom: fallback?.fromBackend ?? null,
          fallbackReason: fallback?.reason ?? null,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export async function readMetadata(metadataPath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Losslessly concatenate WAV chunks into one output file via ffmpeg. */
async function concatWavs(wavPaths: string[], outputPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
  const list = wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, `${list}\n`, "utf-8");
  const ffmpeg = process.env.ANYVOICE_FFMPEG || "ffmpeg";
  // Re-encode to PCM so the concat is robust to any minor per-chunk param drift.
  await runCommand(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "pcm_s16le", outputPath], process.cwd());
}

/**
 * Synthesize long text as multiple short, stable generations and concatenate
 * them into files.outputPath. Each chunk's leading-artifact + silence trimming
 * runs per generation, so the joined audio stays clean. Metadata from the first
 * chunk (reference quality + effective params) is written to files.metadataPath.
 */
async function synthesizeChunkedToOutput(
  jobId: string,
  input: CloneInput,
  files: CloneRunFiles,
  chunks: string[],
  currentModelId: string,
  onProgress?: CloneProgressCallback,
): Promise<void> {
  const seed = stabilitySeed();
  const loraPath = effectiveLoraPath(input);
  const base = hotWorkerUrl();
  const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "synthesize_voxcpm_anyvoice.py");
  const wavPaths: string[] = [];
  const chunkPlan: Array<{
    index: number;
    rawText: string;
    modelText: string;
    textPrepFile: string;
    outputWav: string;
  }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const stem = `chunk-${String(i).padStart(3, "0")}`;
    const chunkWav = path.join(files.runDir, `${stem}.wav`);
    const chunkText = path.join(files.runDir, `${stem}.txt`);
    const chunkPrepPath = path.join(files.runDir, `${stem}.prep.json`);
    // Only the first chunk's metadata is kept (reference quality is identical
    // across chunks — same reference clip).
    const chunkMeta = i === 0 ? files.metadataPath : path.join(files.runDir, `${stem}.meta.json`);

    const prep = prepareVoiceText(chunks[i], {
      pronunciationOverrides: input.pronunciationOverrides,
      autoApplyPresetPronunciations: true,
    });
    chunkPlan.push({
      index: i,
      rawText: prep.raw,
      modelText: prep.model,
      textPrepFile: chunkPrepPath,
      outputWav: chunkWav,
    });
    await writeFile(chunkText, prep.model, "utf-8");
    await writeFile(
      chunkPrepPath,
      JSON.stringify({ targetText: prep, promptTranscript: files.textPreparation.promptTranscript }),
      "utf-8",
    );

    onProgress?.({
      status: "progress",
      jobId,
      modelId: currentModelId,
      phase: "synthesis_started",
      message: `${i + 1}/${chunks.length}`,
    });

    if (base) {
      const endpoint = hotWorkerCloneUrl(base);
      if (!endpoint) throw new Error("ANYVOICE_HOT_WORKER_URL is invalid");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          textFile: chunkText,
          referenceAudio: files.referencePath,
          promptTextFile: files.promptTranscriptPath,
          output: chunkWav,
          metadataOutput: chunkMeta,
          textPrepFile: chunkPrepPath,
          quality: input.quality,
          stabilitySeed: seed,
          modelId: currentModelId,
          cloneMode: voxcpmCloneMode(),
          ...(loraPath ? { loraPath } : {}),
        }),
      });
      await parseHotWorkerStream(response, {
        jobId,
        currentModelId,
        fallbackQuality: input.quality,
        onProgress,
      });
    } else {
      const args = [
        script,
        "--text-file", chunkText,
        "--reference-audio", files.referencePath,
        "--model-id", currentModelId,
        "--metadata-output", chunkMeta,
        "--text-prep-file", chunkPrepPath,
        "--output", chunkWav,
        "--quality", input.quality,
        "--clone-mode", voxcpmCloneMode(),
        "--prompt-text-file", files.promptTranscriptPath,
      ];
      if (seed !== null) args.push("--seed", String(seed));
      if (loraPath) args.push("--lora-path", loraPath);
      await runCommand(python, args, process.cwd());
    }
    wavPaths.push(chunkWav);
  }

  await concatWavs(wavPaths, files.outputPath);
  const metadata = (await readMetadata(files.metadataPath)) ?? {};
  await writeFile(
    files.metadataPath,
    `${JSON.stringify(
      {
        ...metadata,
        textPreparation: files.textPreparation,
        chunkedSynthesis: {
          version: 1,
          maxSinglePassChars: MAX_SINGLE_PASS_CHARS,
          chunks: chunkPlan,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function finalizeReadyPayload(
  jobId: string,
  input: CloneInput,
  files: CloneRunFiles,
  currentModelId: string,
  onProgress?: CloneProgressCallback,
): Promise<CloneReadyPayload> {
  onProgress?.({
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: "finalizing",
  });
  await transcodeToCompressed(files.runDir);
  const metadata = await readMetadata(files.metadataPath);
  return {
    status: "ready",
    jobId,
    modelId: currentModelId,
    audioUrl: `/api/runs/${jobId}/audio`,
    referenceQuality: parseReferenceQuality(metadata?.referenceQuality),
    targetLanguage: detectTargetLanguage(input.targetText),
    effectiveParams: parseEffectiveParams(metadata?.effectiveParams, input.quality),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "VoxCPM2 synthesis failed";
}

async function runVoxCpmClone(
  jobId: string,
  input: CloneInput,
  files: CloneRunFiles,
  currentModelId: string,
  onProgress?: CloneProgressCallback,
): Promise<void> {
  // Long text → chunked, stable synthesis + concatenation (avoids the quality
  // drift / background noise of a single multi-minute generation).
  const chunks = planTargetChunks(input.targetText);
  if (chunks.length > 1) {
    await synthesizeChunkedToOutput(jobId, input, files, chunks, currentModelId, onProgress);
    return;
  }

  if (hotWorkerUrl()) {
    await runHotClone(jobId, input, files, currentModelId, onProgress);
    return;
  }

  const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
  const loraPath = effectiveLoraPath(input);
  const seed = stabilitySeed();
  const script = path.join(process.cwd(), "scripts", "synthesize_voxcpm_anyvoice.py");
  const args = [
    script,
    "--text-file",
    files.targetTextPath,
    "--reference-audio",
    files.referencePath,
    "--model-id",
    currentModelId,
    "--metadata-output",
    files.metadataPath,
    "--text-prep-file",
    files.textPrepPath,
    "--output",
    files.outputPath,
    "--quality",
    input.quality,
    "--clone-mode",
    voxcpmCloneMode(),
    "--prompt-text-file",
    files.promptTranscriptPath,
  ];
  if (seed !== null) args.push("--seed", String(seed));
  if (loraPath) args.push("--lora-path", loraPath);
  if (onProgress) args.push("--progress-jsonl");

  const result = await runCommand(python, args, process.cwd(), (line) => {
    const payload = workerProgressPayload(jobId, currentModelId, line, input.quality);
    if (payload) onProgress?.(payload);
  });
  await writeFile(path.join(files.runDir, "worker.log"), result.stderr, "utf-8");
}

export async function runLocalCloneWithProgress(
  jobId: string,
  input: CloneInput,
  onProgress?: CloneProgressCallback,
): Promise<CloneReadyPayload> {
  const currentModelId = modelId();
  onProgress?.({
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: "queued",
  });
  const files = await writeInputFiles(jobId, input);
  onProgress?.({
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: "input_saved",
  });

  const externalBackend = preferredExternalProfileBackend(input);
  await requireAcceptedProfileLoraAdapterPolicy(input);
  if (externalBackend) await requireAcceptedExternalProfileBackendPolicy(input, externalBackend);
  if (externalBackend && profileBackendMode() !== "voxcpm-first") {
    await runExternalProfileBackend(jobId, input, files, currentModelId, externalBackend, onProgress);
    return finalizeReadyPayload(jobId, input, files, currentModelId, onProgress);
  }

  if (externalBackend) {
    try {
      await runVoxCpmClone(jobId, input, files, currentModelId, onProgress);
      return finalizeReadyPayload(jobId, input, files, currentModelId, onProgress);
    } catch (error) {
      const reason = errorMessage(error);
      const fromBackend = effectiveVoxCpmBackend(input);
      await writeFile(path.join(files.runDir, "voxcpm-fallback-error.txt"), `${reason}\n`, "utf-8");
      await runExternalProfileBackend(jobId, input, files, currentModelId, externalBackend, onProgress, {
        fromBackend,
        reason,
      });
      return finalizeReadyPayload(jobId, input, files, currentModelId, onProgress);
    }
  }

  await runVoxCpmClone(jobId, input, files, currentModelId, onProgress);
  return finalizeReadyPayload(jobId, input, files, currentModelId, onProgress);
}

export async function runLocalClone(jobId: string, input: CloneInput): Promise<CloneReadyPayload> {
  return runLocalCloneWithProgress(jobId, input);
}

export async function recordCloneError(jobId: string, message: string) {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "error.txt"), message, "utf-8");
}

// Synthesize a single book segment directly (no run-history), reusing the same
// VoxCPM2 worker contract as the clone pipeline. Writes a compressed .m4a at
// outputM4aPath. Files are written into workDir (reused across a book's segments).
export interface SegmentSynthInput {
  targetText: string;
  referenceAudioPath: string;
  promptTranscript: string;
  workDir: string;
  outputM4aPath: string;
  quality?: QualityPreset;
}

export async function synthesizeSegment(input: SegmentSynthInput): Promise<void> {
  const { workDir, outputM4aPath } = input;
  const quality: QualityPreset = input.quality ?? "balanced";
  await mkdir(workDir, { recursive: true });

  const targetPrep = prepareVoiceText(input.targetText, { autoApplyPresetPronunciations: true });
  const promptPrep = prepareVoiceText(input.promptTranscript);
  const targetTextPath = path.join(workDir, "target.txt");
  const promptTextPath = path.join(workDir, "prompt.txt");
  const textPrepPath = path.join(workDir, "text-prep.json");
  const metadataPath = path.join(workDir, "metadata.json");
  const wavPath = path.join(workDir, "seg.wav");

  await writeFile(targetTextPath, targetPrep.model, "utf-8");
  await writeFile(promptTextPath, promptPrep.model, "utf-8");
  await writeFile(
    textPrepPath,
    JSON.stringify({ targetText: targetPrep, promptTranscript: promptPrep }),
    "utf-8",
  );

  const currentModelId = modelId();
  const seed = stabilitySeed();
  const loraPath = voxcpmLoraPath();
  const base = hotWorkerUrl();

  if (base) {
    const endpoint = hotWorkerCloneUrl(base);
    if (!endpoint) throw new Error("ANYVOICE_HOT_WORKER_URL is invalid");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        textFile: targetTextPath,
        referenceAudio: input.referenceAudioPath,
        promptTextFile: promptTextPath,
        output: wavPath,
        metadataOutput: metadataPath,
        textPrepFile: textPrepPath,
        quality,
        stabilitySeed: seed,
        modelId: currentModelId,
        cloneMode: voxcpmCloneMode(),
        ...(loraPath ? { loraPath } : {}),
      }),
    });
    await parseHotWorkerStream(response, {
      jobId: path.basename(workDir) || "segment",
      currentModelId,
      fallbackQuality: quality,
    });
  } else {
    const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
    const script = path.join(process.cwd(), "scripts", "synthesize_voxcpm_anyvoice.py");
    const args = [
      script,
      "--text-file", targetTextPath,
      "--reference-audio", input.referenceAudioPath,
      "--model-id", currentModelId,
      "--metadata-output", metadataPath,
      "--text-prep-file", textPrepPath,
      "--output", wavPath,
      "--quality", quality,
      "--clone-mode", voxcpmCloneMode(),
      "--prompt-text-file", promptTextPath,
    ];
    if (seed !== null) args.push("--seed", String(seed));
    if (loraPath) args.push("--lora-path", loraPath);
    await runCommand(python, args, process.cwd());
  }

  await transcodeWavToM4a(wavPath, outputM4aPath);
}

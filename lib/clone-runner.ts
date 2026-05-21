import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hotWorkerUrl, modelId, stabilitySeed, voxcpmCloneMode, voxcpmLoraPath, type VoxCpmCloneMode } from "@/lib/clone-config";
import { prepareVoiceText, type PreparedVoiceText } from "@/lib/text-prep";
import {
  detectTargetLanguage,
  type CloneInput,
  type QualityPreset,
} from "@/lib/clone-request";
import { safeRunDir } from "@/lib/run-paths";

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
  stabilitySeed?: number | null;
  loraEnabled?: boolean;
  loraPath?: string | null;
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
    stabilitySeed: asNullableNumber(obj.stabilitySeed ?? obj.stability_seed ?? obj.seed),
    loraEnabled: Boolean(obj.loraEnabled ?? obj.lora_enabled),
    loraPath:
      typeof obj.loraPath === "string"
        ? obj.loraPath
        : typeof obj.lora_path === "string"
          ? obj.lora_path
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
  const loraPath = voxcpmLoraPath();
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

  if (hotWorkerUrl()) {
    await runHotClone(jobId, input, files, currentModelId, onProgress);
    onProgress?.({
      status: "progress",
      jobId,
      modelId: currentModelId,
      phase: "finalizing",
    });
    const metadata = await readMetadata(files.metadataPath);
    const referenceQuality = parseReferenceQuality(metadata?.referenceQuality);
    const effectiveParams = parseEffectiveParams(metadata?.effectiveParams, input.quality);
    const targetLanguage = detectTargetLanguage(input.targetText);

    return {
      status: "ready",
      jobId,
      modelId: currentModelId,
      audioUrl: `/api/runs/${jobId}/audio`,
      referenceQuality,
      targetLanguage,
      effectiveParams,
    };
  }

  const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
  const loraPath = voxcpmLoraPath();
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
  onProgress?.({
    status: "progress",
    jobId,
    modelId: currentModelId,
    phase: "finalizing",
  });

  const metadata = await readMetadata(files.metadataPath);
  const referenceQuality = parseReferenceQuality(metadata?.referenceQuality);
  const effectiveParams = parseEffectiveParams(metadata?.effectiveParams, input.quality);
  const targetLanguage = detectTargetLanguage(input.targetText);

  return {
    status: "ready",
    jobId,
    modelId: currentModelId,
    audioUrl: `/api/runs/${jobId}/audio`,
    referenceQuality,
    targetLanguage,
    effectiveParams,
  };
}

export async function runLocalClone(jobId: string, input: CloneInput): Promise<CloneReadyPayload> {
  return runLocalCloneWithProgress(jobId, input);
}

export async function recordCloneError(jobId: string, message: string) {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "error.txt"), message, "utf-8");
}

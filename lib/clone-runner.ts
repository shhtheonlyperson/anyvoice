import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelId } from "@/lib/clone-config";
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

export function fileExtension(name: string, type: string): string {
  const fromName = path.extname(name || "").toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;
  if (type.includes("mpeg")) return ".mp3";
  if (type.includes("mp4")) return ".m4a";
  if (type.includes("wav")) return ".wav";
  if (type.includes("webm")) return ".webm";
  return ".audio";
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
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

async function writeInputFiles(jobId: string, input: CloneInput) {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });

  const extension = fileExtension(input.voice.name, input.voice.type);
  const referencePath = path.join(runDir, `reference${extension}`);
  await writeFile(referencePath, Buffer.from(await input.voice.arrayBuffer()));
  await writeFile(path.join(runDir, "target.txt"), input.targetText, "utf-8");
  await writeFile(path.join(runDir, "prompt-transcript.txt"), input.promptTranscript, "utf-8");

  return { runDir, referencePath };
}

export async function recordWorkerMissingRun(jobId: string, input: CloneInput) {
  const { runDir } = await writeInputFiles(jobId, input);
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
        createdAt: new Date().toISOString(),
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
  };
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

export async function runLocalClone(jobId: string, input: CloneInput): Promise<CloneReadyPayload> {
  const { runDir, referencePath } = await writeInputFiles(jobId, input);
  const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "synthesize_voxcpm_anyvoice.py");
  const outputPath = path.join(runDir, "output.wav");
  const metadataPath = path.join(runDir, "metadata.json");
  const args = [
    script,
    "--text-file",
    path.join(runDir, "target.txt"),
    "--reference-audio",
    referencePath,
    "--model-id",
    modelId(),
    "--metadata-output",
    metadataPath,
    "--output",
    outputPath,
    "--quality",
    input.quality,
    "--prompt-text-file",
    path.join(runDir, "prompt-transcript.txt"),
  ];

  const result = await runCommand(python, args, process.cwd());
  await writeFile(path.join(runDir, "worker.log"), result.stderr, "utf-8");

  const metadata = await readMetadata(metadataPath);
  const referenceQuality = parseReferenceQuality(metadata?.referenceQuality);
  const effectiveParams = parseEffectiveParams(metadata?.effectiveParams, input.quality);
  const targetLanguage = detectTargetLanguage(input.targetText);

  return {
    status: "ready",
    jobId,
    modelId: modelId(),
    audioUrl: `/api/runs/${jobId}/audio`,
    referenceQuality,
    targetLanguage,
    effectiveParams,
  };
}

export async function recordCloneError(jobId: string, message: string) {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "error.txt"), message, "utf-8");
}

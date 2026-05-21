import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { maxUploadBytes, modelId, normalizeTargetText } from "@/lib/clone-config";
import { fileExtension, parseReferenceQuality, type ReferenceQuality } from "@/lib/clone-runner";
import type { SourceKind } from "@/lib/clone-request";
import { safeRunDir } from "@/lib/run-paths";
import { detectChineseScript, prepareVoiceText, strictTraditionalChineseScriptErrors } from "@/lib/text-prep";

type EnrollmentSourceKind = Exclude<SourceKind, "profile" | "sample">;

export interface VoiceProfileEnrollmentInput {
  voice: File;
  promptTranscript: string;
  sourceKind?: EnrollmentSourceKind;
}

export interface VoiceProfileEnrollmentError {
  statusCode: number;
  body: {
    status: "error";
    message: string;
  };
}

export interface VoiceProfileEnrollmentResult {
  status: "enrolled";
  jobId: string;
  modelId: string;
  referenceQuality: ReferenceQuality;
}

interface EnrollmentFiles {
  runDir: string;
  referencePath: string;
  promptTranscriptPath: string;
  promptTranscriptRawPath: string;
  metadataPath: string;
  requestPath: string;
  textPrepPath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const SOURCE_KINDS: ReadonlySet<string> = new Set(["scripted", "freeform", "uploaded"]);

export function isVoiceProfileEnrollmentError(
  value: VoiceProfileEnrollmentInput | VoiceProfileEnrollmentError,
): value is VoiceProfileEnrollmentError {
  return "statusCode" in value;
}

function error(statusCode: number, message: string): VoiceProfileEnrollmentError {
  return { statusCode, body: { status: "error", message } };
}

function parseEnrollmentSourceKind(value: FormDataEntryValue | null): EnrollmentSourceKind | undefined {
  if (value === null || value === undefined) return undefined;
  const candidate = String(value).trim().toLowerCase();
  return SOURCE_KINDS.has(candidate) ? (candidate as EnrollmentSourceKind) : undefined;
}

export function parseVoiceProfileEnrollmentForm(
  form: FormData,
): VoiceProfileEnrollmentInput | VoiceProfileEnrollmentError {
  const voice = form.get("voice");
  const consent = form.get("consent");
  const promptTranscript = normalizeTargetText(String(form.get("promptTranscript") || ""));
  const sourceKindRaw = form.get("sourceKind");
  const sourceKind = parseEnrollmentSourceKind(sourceKindRaw);

  if (!(voice instanceof File)) return error(400, "voice file required");
  if (voice.size <= 0) return error(400, "voice file is empty");
  if (voice.size > maxUploadBytes()) return error(413, "voice file is too large");
  if (!promptTranscript) {
    return error(400, "reference transcript required: type exactly what the reference clip says");
  }
  const transcriptScript = detectChineseScript(promptTranscript);
  const scriptErrors = strictTraditionalChineseScriptErrors(promptTranscript);
  if (scriptErrors.length > 0) {
    return error(
      400,
      `profile transcript must use Traditional Chinese with clear zh-Hant evidence; Simplified, mixed, or unproven Chinese clips are not accepted for the Traditional Mandarin voice profile (${transcriptScript})`,
    );
  }
  if (sourceKindRaw !== null && sourceKind === undefined) {
    return error(400, "only user recordings or user-uploaded audio can be added to a voice profile");
  }
  if (consent !== "yes") return error(400, "voice permission confirmation required");

  return { voice, promptTranscript, sourceKind };
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
      const detail = stderr.trim() || stdout.trim() || `profile analyzer exited with code ${code}`;
      if (/ModuleNotFoundError: No module named '(numpy|soundfile)'/.test(detail)) {
        reject(
          new Error(
            "profile analyzer dependencies are missing: set ANYVOICE_VOXCPM_PYTHON to the VoxCPM Python environment with numpy and soundfile installed",
          ),
        );
        return;
      }
      reject(new Error(detail));
    });
  });
}

async function writeEnrollmentFiles(jobId: string, input: VoiceProfileEnrollmentInput): Promise<EnrollmentFiles> {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });

  const extension = fileExtension(input.voice.name, input.voice.type);
  const referencePath = path.join(runDir, `reference${extension}`);
  const promptTranscriptPath = path.join(runDir, "prompt-transcript.txt");
  const promptTranscriptRawPath = path.join(runDir, "prompt-transcript.raw.txt");
  const metadataPath = path.join(runDir, "metadata.json");
  const requestPath = path.join(runDir, "request.json");
  const textPrepPath = path.join(runDir, "text-prep.json");
  const promptPreparation = prepareVoiceText(input.promptTranscript);

  await writeFile(referencePath, Buffer.from(await input.voice.arrayBuffer()));
  await writeFile(promptTranscriptPath, promptPreparation.model, "utf-8");
  await writeFile(promptTranscriptRawPath, promptPreparation.raw, "utf-8");
  await writeFile(
    textPrepPath,
    `${JSON.stringify(
      {
        version: 1,
        promptTranscript: promptPreparation,
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
        status: "profile_enrollment",
        modelId: modelId(),
        voiceName: input.voice.name,
        voiceType: input.voice.type,
        voiceSize: input.voice.size,
        sourceKind: input.sourceKind ?? "uploaded",
        referenceSource: { kind: input.sourceKind ?? "uploaded" },
        createdAt: new Date().toISOString(),
        textPreparation: {
          promptTranscript: promptPreparation,
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return {
    runDir,
    referencePath,
    promptTranscriptPath,
    promptTranscriptRawPath,
    metadataPath,
    requestPath,
    textPrepPath,
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function enrollVoiceProfileClip(
  jobId: string,
  input: VoiceProfileEnrollmentInput,
): Promise<VoiceProfileEnrollmentResult> {
  const files = await writeEnrollmentFiles(jobId, input);
  const python = process.env.ANYVOICE_VOXCPM_PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "analyze_voice_reference.py");
  const args = [
    script,
    "--reference-audio",
    files.referencePath,
    "--prompt-text-file",
    files.promptTranscriptPath,
    "--metadata-output",
    files.metadataPath,
    "--model-id",
    modelId(),
    "--source-kind",
    input.sourceKind ?? "uploaded",
  ];

  const result = await runCommand(python, args, process.cwd());
  if (result.stderr.trim()) {
    await writeFile(path.join(files.runDir, "analyzer.log"), result.stderr, "utf-8");
  }

  const metadata = await readJson(files.metadataPath);
  const referenceQuality = parseReferenceQuality(metadata?.referenceQuality);
  return {
    status: "enrolled",
    jobId,
    modelId: modelId(),
    referenceQuality,
  };
}

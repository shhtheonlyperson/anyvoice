import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelId } from "@/lib/clone-config";
import type { CloneInput } from "@/lib/clone-request";
import { safeRunDir } from "@/lib/run-paths";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CloneReadyPayload {
  status: "ready";
  jobId: string;
  modelId: string;
  mode: "reference" | "ultimate";
  audioUrl: string;
}

export interface CloneWorkerMissingPayload {
  status: "needs_worker";
  jobId: string;
  modelId: string;
  message: string;
}

function fileExtension(name: string, type: string): string {
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
  if (input.promptTranscript) {
    await writeFile(path.join(runDir, "prompt-transcript.txt"), input.promptTranscript, "utf-8");
  }
  if (input.style) {
    await writeFile(path.join(runDir, "style.txt"), input.style, "utf-8");
  }

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
        ultimateMode: Boolean(input.promptTranscript),
        stylePresent: Boolean(input.style),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
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
  ];

  if (input.promptTranscript) {
    args.push("--prompt-text-file", path.join(runDir, "prompt-transcript.txt"));
  }
  if (input.style) {
    args.push("--style", input.style);
  }

  const result = await runCommand(python, args, process.cwd());
  await writeFile(path.join(runDir, "worker.log"), result.stderr, "utf-8");
  return {
    status: "ready",
    jobId,
    modelId: modelId(),
    mode: input.promptTranscript ? "ultimate" : "reference",
    audioUrl: `/api/runs/${jobId}/audio`,
  };
}

export async function recordCloneError(jobId: string, message: string) {
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "error.txt"), message, "utf-8");
}

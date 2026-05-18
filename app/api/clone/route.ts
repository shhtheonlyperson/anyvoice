import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import {
  maxUploadBytes,
  modelId,
  normalizeStyle,
  normalizeTargetText,
  shouldReturnWorkerMissing,
} from "@/lib/clone-config";
import { safeRunDir } from "@/lib/run-paths";

export const runtime = "nodejs";
export const maxDuration = 300;

interface CommandResult {
  stdout: string;
  stderr: string;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
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

function workerMissing(jobId: string) {
  return json({
    status: "needs_worker",
    jobId,
    modelId: modelId(),
    message:
      "The Vercel app is ready, but VoxCPM2 inference is not enabled in this environment. Set ANYVOICE_ENABLE_LOCAL_VOXCPM=1 and ANYVOICE_VOXCPM_PYTHON on a machine with VoxCPM2 installed.",
  });
}

export async function POST(req: NextRequest) {
  const jobId = nanoid(10);
  const form = await req.formData();
  const voice = form.get("voice");
  const consent = form.get("consent");
  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  const promptTranscript = normalizeTargetText(String(form.get("promptTranscript") || ""));
  const style = normalizeStyle(String(form.get("style") || ""));

  if (!(voice instanceof File)) {
    return json({ status: "error", message: "voice file required" }, { status: 400 });
  }
  if (voice.size <= 0) {
    return json({ status: "error", message: "voice file is empty" }, { status: 400 });
  }
  if (voice.size > maxUploadBytes()) {
    return json({ status: "error", message: "voice file is too large" }, { status: 413 });
  }
  if (!targetText) {
    return json({ status: "error", message: "target text required" }, { status: 400 });
  }
  if (consent !== "yes") {
    return json({ status: "error", message: "voice permission confirmation required" }, { status: 400 });
  }

  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });

  const extension = fileExtension(voice.name, voice.type);
  const referencePath = path.join(runDir, `reference${extension}`);
  await writeFile(referencePath, Buffer.from(await voice.arrayBuffer()));
  await writeFile(path.join(runDir, "target.txt"), targetText, "utf-8");
  if (promptTranscript) {
    await writeFile(path.join(runDir, "prompt-transcript.txt"), promptTranscript, "utf-8");
  }
  if (style) {
    await writeFile(path.join(runDir, "style.txt"), style, "utf-8");
  }

  if (shouldReturnWorkerMissing()) {
    await writeFile(
      path.join(runDir, "request.json"),
      JSON.stringify(
        {
          status: "needs_worker",
          modelId: modelId(),
          voiceName: voice.name,
          voiceType: voice.type,
          voiceSize: voice.size,
          ultimateMode: Boolean(promptTranscript),
          stylePresent: Boolean(style),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    return workerMissing(jobId);
  }

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

  if (promptTranscript) {
    args.push("--prompt-text-file", path.join(runDir, "prompt-transcript.txt"));
  }
  if (style) {
    args.push("--style", style);
  }

  try {
    const result = await runCommand(python, args, process.cwd());
    await writeFile(path.join(runDir, "worker.log"), result.stderr, "utf-8");
    return json({
      status: "ready",
      jobId,
      modelId: modelId(),
      mode: promptTranscript ? "ultimate" : "reference",
      audioUrl: `/api/runs/${jobId}/audio`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "synthesis failed";
    await writeFile(path.join(runDir, "error.txt"), message, "utf-8");
    return json({ status: "error", jobId, message }, { status: 500 });
  }
}

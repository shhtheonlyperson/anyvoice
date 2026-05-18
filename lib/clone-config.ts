import os from "node:os";
import path from "node:path";

export interface CloneEnv {
  [key: string]: string | undefined;
  ANYVOICE_ENABLE_LOCAL_VOXCPM?: string;
  ANYVOICE_STUB?: string;
  ANYVOICE_MODEL_ID?: string;
  ANYVOICE_MAX_UPLOAD_MB?: string;
  ANYVOICE_RUNS_DIR?: string;
  VERCEL?: string;
}

export function modelId(env: CloneEnv = process.env): string {
  return env.ANYVOICE_MODEL_ID || "openbmb/VoxCPM2";
}

export function maxUploadBytes(env: CloneEnv = process.env): number {
  const mb = Number(env.ANYVOICE_MAX_UPLOAD_MB || "80");
  return Math.max(1, Math.min(512, Number.isFinite(mb) ? mb : 80)) * 1024 * 1024;
}

export function isWorkerEnabled(env: CloneEnv = process.env): boolean {
  return env.ANYVOICE_ENABLE_LOCAL_VOXCPM === "1" && env.ANYVOICE_STUB !== "1";
}

export function shouldReturnWorkerMissing(env: CloneEnv = process.env): boolean {
  if (env.ANYVOICE_STUB === "1") return true;
  if (env.VERCEL && env.ANYVOICE_ENABLE_LOCAL_VOXCPM !== "1") return true;
  return !isWorkerEnabled(env);
}

export function runsRoot(env: CloneEnv = process.env): string {
  const configured = env.ANYVOICE_RUNS_DIR || ".anyvoice/runs";
  if (path.isAbsolute(configured)) return configured;
  if (env.VERCEL) return path.join(os.tmpdir(), configured);
  return path.join(process.cwd(), configured);
}

export function normalizeStyle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 180);
}

export function normalizeTargetText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n").slice(0, 4096);
}

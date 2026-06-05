import os from "node:os";
import path from "node:path";

export interface CloneEnv {
  [key: string]: string | undefined;
  ANYVOICE_ENABLE_LOCAL_VOXCPM?: string;
  ANYVOICE_STUB?: string;
  ANYVOICE_MODEL_ID?: string;
  ANYVOICE_VOXCPM_CLONE_MODE?: string;
  ANYVOICE_VOXCPM_LORA_PATH?: string;
  ANYVOICE_STABILITY_SEED?: string;
  ANYVOICE_PROFILE_BACKEND_MODE?: string;
  ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND?: string;
  ANYVOICE_BACKEND_RENDER_COMMAND?: string;
  ANYVOICE_MAX_UPLOAD_MB?: string;
  ANYVOICE_RUNS_DIR?: string;
  ANYVOICE_WORKER_URL?: string;
  ANYVOICE_WORKER_TOKEN?: string;
  ANYVOICE_HOT_WORKER_URL?: string;
  ANYVOICE_HISTORY_FILE?: string;
  VERCEL?: string;
}

export type VoxCpmCloneMode = "hifi" | "prompt";
export type ProfileBackendMode = "preferred" | "voxcpm-first";

export function modelId(env: CloneEnv = process.env): string {
  return env.ANYVOICE_MODEL_ID || "openbmb/VoxCPM2";
}

export function voxcpmCloneMode(env: CloneEnv = process.env): VoxCpmCloneMode {
  const value = (env.ANYVOICE_VOXCPM_CLONE_MODE || "hifi").trim().toLowerCase();
  return value === "prompt" ? "prompt" : "hifi";
}

export function voxcpmLoraPath(env: CloneEnv = process.env): string {
  return (env.ANYVOICE_VOXCPM_LORA_PATH || "").trim();
}

export function stabilitySeed(env: CloneEnv = process.env): number | null {
  const raw = (env.ANYVOICE_STABILITY_SEED || "1337").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "none" || raw === "random") return null;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) return 1337;
  return seed;
}

export function hotWorkerUrl(env: CloneEnv = process.env): string {
  return (env.ANYVOICE_HOT_WORKER_URL || "").trim();
}

export function profileBackendRenderCommand(env: CloneEnv = process.env): string {
  return (env.ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND || env.ANYVOICE_BACKEND_RENDER_COMMAND || "").trim();
}

export function profileBackendMode(env: CloneEnv = process.env): ProfileBackendMode {
  const value = (env.ANYVOICE_PROFILE_BACKEND_MODE || "preferred").trim().toLowerCase();
  return value === "voxcpm-first" ? "voxcpm-first" : "preferred";
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

export function normalizeTargetText(value: string): string {
  return value.trim().replace(/\r\n/g, "\n").slice(0, 4096);
}

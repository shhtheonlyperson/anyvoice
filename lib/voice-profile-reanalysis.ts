import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildVoiceProfileSummary, voiceProfileRoot as canonicalVoiceProfileRoot, type VoiceProfileSummary } from "@/lib/voice-profile";

const execFileAsync = promisify(execFile);

export interface VoiceProfileReanalysisReport {
  status: "completed" | "completed_with_errors";
  runsDir: string;
  analyzer: string;
  python: string;
  dryRun: boolean;
  force: boolean;
  scanned: number;
  plannedOrUpdated: number;
  skipped: Record<string, number>;
  runs: Array<{
    sourceRunId: string;
    metadataPath: string;
    referenceAudio: string;
    promptTextFile: string;
    sourceKind: string;
    status: "planned" | "updated";
    quality?: {
      grade?: string;
      durationSec?: number;
      warnings?: string[];
    };
  }>;
  failures: Array<{
    sourceRunId: string;
    message: string;
  }>;
  profile?: {
    profile: string;
    status: "ready" | "needs_enrollment";
    eligibleClips: number;
    selectedClips: number;
    remainingClipsNeeded: number;
    dryRun: boolean;
  };
}

export interface VoiceProfileReanalysisResult {
  reanalysis: VoiceProfileReanalysisReport;
  profile: VoiceProfileSummary;
}

export interface ReanalyzeVoiceProfileOptions {
  profileId?: string;
  dryRun?: boolean;
  force?: boolean;
}

function assertSafeProfileId(profileId: string): string {
  const normalized = profileId.trim() || "local-default";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    throw new Error("profileId must contain only letters, numbers, dash, or underscore");
  }
  return normalized;
}

function voiceProfileRoot(): string {
  return path.resolve(canonicalVoiceProfileRoot());
}

function profileOutDir(profileId: string): string {
  const root = voiceProfileRoot();
  const outDir = path.resolve(root, profileId);
  const relative = path.relative(root, outDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profile path must stay inside the AnyVoice profile root");
  }
  return outDir;
}

function parseReanalysisPayload(stdout: string): VoiceProfileReanalysisReport {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileReanalysisReport>;
  if (
    (parsed.status !== "completed" && parsed.status !== "completed_with_errors") ||
    typeof parsed.runsDir !== "string" ||
    typeof parsed.scanned !== "number" ||
    typeof parsed.plannedOrUpdated !== "number" ||
    !parsed.skipped ||
    !Array.isArray(parsed.runs) ||
    !Array.isArray(parsed.failures)
  ) {
    throw new Error("voice profile reanalysis returned an invalid payload");
  }
  return parsed as VoiceProfileReanalysisReport;
}

function execErrorOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

export async function reanalyzeVoiceProfileRuns({
  profileId: profileIdInput = "local-default",
  dryRun = false,
  force = false,
}: ReanalyzeVoiceProfileOptions = {}): Promise<VoiceProfileReanalysisResult> {
  const profileId = assertSafeProfileId(profileIdInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "reanalyze_voice_profile_runs.py");
  const args = [
    script,
    "--build-profile",
    "--profile-id",
    profileId,
    "--out-dir",
    profileOutDir(profileId),
    "--copy-clips",
  ];
  if (dryRun) args.push("--dry-run");
  if (force) args.push("--force");

  try {
    const { stdout, stderr } = await execFileAsync(python, args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 5,
    });
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    const reanalysis = parseReanalysisPayload(stdout);
    const profile = await buildVoiceProfileSummary({ profileId });
    return { reanalysis, profile };
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) {
      const reanalysis = parseReanalysisPayload(stdout);
      const profile = await buildVoiceProfileSummary({ profileId });
      return { reanalysis, profile };
    }
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "voice profile reanalysis failed"));
  }
}

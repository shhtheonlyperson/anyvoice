import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VoiceProfileReadinessReport {
  status: "ready" | "blocked";
  profile: string;
  voiceProfileId?: string | null;
  summary: {
    selectedClips: number;
    eligibleClips: number;
    manifestClips: number;
    totalDurationSec: number;
    missingCoverageFeatures: string[];
    missingPronunciationPresetIds?: string[];
    minClips: number;
    minTotalDurationSec: number;
  };
  checks: Array<{
    check: string;
    ok: boolean;
    message: string;
    details?: unknown;
  }>;
  nextCommands: Record<string, string>;
}

export interface VerifyVoiceProfileOptions {
  profileId?: string;
  requireTranscriptValidation?: boolean;
}

function assertSafeProfileId(profileId: string): string {
  const normalized = profileId.trim() || "local-default";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    throw new Error("profileId must contain only letters, numbers, dash, or underscore");
  }
  return normalized;
}

function voiceProfileRoot(): string {
  return path.resolve(process.env.ANYVOICE_VOICE_PROFILE_ROOT || path.join(process.cwd(), ".anyvoice", "voices"));
}

function transcriptValidationRoot(): string {
  return path.resolve(
    process.env.ANYVOICE_TRANSCRIPT_VALIDATION_ROOT ||
      path.join(process.cwd(), "generated", "voice-profile-transcript-validation"),
  );
}

function profileJsonForProfile(profileId: string): string {
  const root = voiceProfileRoot();
  const profileJson = path.resolve(root, profileId, "profile.json");
  const relative = path.relative(root, profileJson);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profile path must stay inside the AnyVoice profile root");
  }
  return profileJson;
}

function parseReadinessPayload(stdout: string): VoiceProfileReadinessReport {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileReadinessReport>;
  if (
    (parsed.status !== "ready" && parsed.status !== "blocked") ||
    typeof parsed.profile !== "string" ||
    !parsed.summary ||
    typeof parsed.summary.selectedClips !== "number" ||
    !Array.isArray(parsed.summary.missingCoverageFeatures) ||
    !Array.isArray(parsed.checks) ||
    !parsed.nextCommands
  ) {
    throw new Error("voice profile verifier returned an invalid payload");
  }
  return parsed as VoiceProfileReadinessReport;
}

function execErrorOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

async function latestTranscriptValidationForProfile(profileJson: string): Promise<string | null> {
  const root = transcriptValidationRoot();
  const normalizedProfile = path.resolve(profileJson);
  const matches: Array<{ path: string; createdAt: string }> = [];
  const seen = new Set<string>();
  const addCandidate = async (file: string) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      const raw = await readFile(resolved, "utf-8");
      const parsed = JSON.parse(raw) as { profile?: unknown; createdAt?: unknown };
      if (typeof parsed.profile !== "string" || path.resolve(parsed.profile) !== normalizedProfile) return;
      matches.push({
        path: resolved,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      });
    } catch {
      // Ignore missing, partial, or unrelated report files.
    }
  };

  await addCandidate(path.join(path.dirname(normalizedProfile), "transcript-validation.json"));

  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => addCandidate(path.join(root, entry.name))),
    );
  } catch {
    // The generated validation directory is optional.
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0].path;
}

export async function verifyVoiceProfileReadiness({
  profileId: profileIdInput = "local-default",
  requireTranscriptValidation = true,
}: VerifyVoiceProfileOptions = {}): Promise<VoiceProfileReadinessReport> {
  const profileId = assertSafeProfileId(profileIdInput);
  const profileJson = profileJsonForProfile(profileId);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "verify_voice_profile_ready.py");
  const args = [script, "--profile-json", profileJson];
  if (requireTranscriptValidation) {
    const validationJson = await latestTranscriptValidationForProfile(profileJson);
    args.push("--require-transcript-validation");
    if (validationJson) {
      args.push("--transcript-validation-json", validationJson);
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(python, args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    });
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseReadinessPayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseReadinessPayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "voice profile verification failed"));
  }
}

import { execFile } from "node:child_process";
import path from "node:path";
import { voiceProfileRoot as canonicalVoiceProfileRoot } from "@/lib/voice-profile";
import { promisify } from "node:util";
import { asrPython } from "@/lib/voxcpm-python";

const execFileAsync = promisify(execFile);

export interface VoiceProfileTranscriptValidationReport {
  validationJson: string;
  total: number;
  passed: number;
  failed: number;
  status: "pass" | "blocked" | "planned";
  backend: string;
  avgCer?: number | null;
  maxCer?: number | null;
  avgWer?: number | null;
  maxWer?: number | null;
  message?: string;
}

export interface ValidateVoiceProfileTranscriptOptions {
  profileId?: string;
  asrJson?: string;
}

function defaultAsrPython(): string {
  return asrPython();
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

function profileJsonForProfile(profileId: string): string {
  const root = voiceProfileRoot();
  const profileJson = path.resolve(root, profileId, "profile.json");
  const relative = path.relative(root, profileJson);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profile path must stay inside the AnyVoice profile root");
  }
  return profileJson;
}

function parseTranscriptValidationPayload(stdout: string): VoiceProfileTranscriptValidationReport {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileTranscriptValidationReport>;
  if (
    typeof parsed.validationJson !== "string" ||
    typeof parsed.total !== "number" ||
    typeof parsed.passed !== "number" ||
    typeof parsed.failed !== "number" ||
    (parsed.status !== "pass" && parsed.status !== "blocked" && parsed.status !== "planned") ||
    typeof parsed.backend !== "string"
  ) {
    throw new Error("profile transcript validation returned an invalid payload");
  }
  return parsed as VoiceProfileTranscriptValidationReport;
}

function execErrorOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

export async function validateVoiceProfileTranscripts({
  profileId: profileIdInput = "local-default",
  asrJson,
}: ValidateVoiceProfileTranscriptOptions = {}): Promise<VoiceProfileTranscriptValidationReport> {
  const profileId = assertSafeProfileId(profileIdInput);
  const python = defaultAsrPython();
  const script = path.join(process.cwd(), "scripts", "validate_voice_profile_transcripts.py");
  const args = [script, "--profile-json", profileJsonForProfile(profileId), "--strict"];
  if (asrJson) {
    args.push("--asr-json", path.resolve(asrJson));
  }

  try {
    const { stdout, stderr } = await execFileAsync(python, args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    });
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseTranscriptValidationPayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseTranscriptValidationPayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "profile transcript validation failed"));
  }
}

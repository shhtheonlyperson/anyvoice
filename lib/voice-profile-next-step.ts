import { execFile } from "node:child_process";
import path from "node:path";
import { voiceProfileRoot as canonicalVoiceProfileRoot } from "@/lib/voice-profile";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VoiceProfileNextAction {
  id: string;
  phase: string;
  status: string;
  command: string;
  reason: string;
  nonInteractiveCommand?: string;
  failedClip?: string | null;
  failedSourceRunId?: string | null;
  failedClipErrors?: string[];
  secondaryCommands?: string[];
}

export interface VoiceProfileRecordingBrief {
  manifest: string;
  clipsNeedingAudio: string[];
  clipsNeedingRerecord?: string[];
  clipsNeedingAttention?: string[];
  pronunciationNotePolicy: string;
  guidance: string[];
  clips: Array<{
    index: number;
    id: string;
    audioPath: string;
    needsAudio: boolean;
    needsRerecord?: boolean;
    recordingIssues?: string[];
    transcript: string;
    transcriptScript?: string;
    coverageFeatures?: string[];
    pronunciationNotes?: string[];
    rehearseCommand?: string;
    preflightCommand?: string;
    recordCommand?: string;
    repairCommand?: string;
  }>;
}

export interface VoiceProfilePostRecordingProofPlan {
  policy: string;
  recommendedCommand: string;
  productProofCommand?: string;
  productProofAsrBackend?: VoiceProfileProductProofAsrBackend;
  productProofSpeakerBackend?: VoiceProfileProductProofSpeakerBackend;
  manualCommands: string[];
  artifacts: Array<{
    id: string;
    path?: string | null;
    pathPattern?: string;
    status: string;
    purpose: string;
  }>;
  gates: Array<{
    id: string;
    command: string;
    required: boolean;
    blocks: string;
  }>;
}

export interface VoiceProfileProductProofAsrBackend {
  status: "ready" | "missing" | string;
  available: boolean;
  requiredBackend: string;
  asrPython?: string;
  selectedAutoBackend?: string | null;
  reason: string;
  checkCommand: string;
  setupHint?: string;
}

export interface VoiceProfileProductProofSpeakerBackend {
  status: "ready" | "missing" | string;
  available: boolean;
  requiredBackend: string;
  speakerPython?: string;
  selectedAutoBackend?: string | null;
  reason: string;
  checkCommand: string;
  setupHint?: string;
}

export interface VoiceProfileNextStepReport {
  status: string;
  phase: string;
  brief?: string;
  nextAction: VoiceProfileNextAction;
  profile?: {
    path?: string;
    exists?: boolean;
    status?: string;
    summary?: unknown;
    checks?: unknown[];
  };
  recordingKit?: {
    manifest?: string;
    exists?: boolean;
    status?: string;
    summary?: unknown;
    checks?: unknown[];
  };
  commands?: Record<string, string>;
  productQualityGate?: Record<string, unknown> | null;
  missingRecordingClips?: string[];
  recordingBrief?: VoiceProfileRecordingBrief;
  postRecordingProofPlan?: VoiceProfilePostRecordingProofPlan;
  productProofReadiness?: {
    asrBackend?: VoiceProfileProductProofAsrBackend;
    speakerBackend?: VoiceProfileProductProofSpeakerBackend;
  };
}

export interface GetVoiceProfileNextStepOptions {
  profileId?: string;
  recordCountdownSec?: number;
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

function recordingKitRoot(): string {
  return path.resolve(process.env.ANYVOICE_RECORDING_KIT_OUT_ROOT || path.join(process.cwd(), "generated", "voice-profile-recording-kits"));
}

function profileJsonForProfile(profileId: string): string {
  return path.join(voiceProfileRoot(), profileId, "profile.json");
}

function kitManifestForProfile(profileId: string): string {
  return path.join(recordingKitRoot(), `${profileId}-current`, "manifest.json");
}

function parseNextStepPayload(stdout: string): VoiceProfileNextStepReport {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileNextStepReport>;
  const nextAction = parsed.nextAction as Partial<VoiceProfileNextAction> | undefined;
  if (
    typeof parsed.status !== "string" ||
    typeof parsed.phase !== "string" ||
    !nextAction ||
    typeof nextAction.id !== "string" ||
    typeof nextAction.phase !== "string" ||
    typeof nextAction.status !== "string" ||
    typeof nextAction.command !== "string" ||
    typeof nextAction.reason !== "string"
  ) {
    throw new Error("voice profile next-step script returned an invalid payload");
  }
  return parsed as VoiceProfileNextStepReport;
}

export async function getVoiceProfileNextStep({
  profileId: profileIdInput = "local-default",
  recordCountdownSec = 2,
}: GetVoiceProfileNextStepOptions = {}): Promise<VoiceProfileNextStepReport> {
  const profileId = assertSafeProfileId(profileIdInput);
  if (!Number.isInteger(recordCountdownSec) || recordCountdownSec < 0) {
    throw new Error("recordCountdownSec must be a non-negative integer");
  }
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "voice_profile_next_step.py");
  const { stdout, stderr } = await execFileAsync(
    python,
    [
      script,
      "--profile-json",
      profileJsonForProfile(profileId),
      "--kit-manifest",
      kitManifestForProfile(profileId),
      "--profile-id",
      profileId,
      "--record-countdown-sec",
      String(recordCountdownSec),
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    },
  );
  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }
  return parseNextStepPayload(stdout);
}

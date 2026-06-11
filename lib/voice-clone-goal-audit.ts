import { execFile } from "node:child_process";
import path from "node:path";
import { voiceProfileRoot as canonicalVoiceProfileRoot } from "@/lib/voice-profile";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VoiceCloneGoalAuditStage {
  id: string;
  status: "pass" | "blocked" | "missing" | "partial" | string;
  ok: boolean;
  message: string;
  missingClips?: string[];
  pendingExternalRecordings?: Array<{
    id?: string;
    index?: number;
    audioPath?: string;
    sourceAudioPath?: string;
  }>;
  pendingExternalRecordingCount?: number;
  missingExternalRecordingSourceCount?: number;
  firstMissingClip?: {
    id: string;
    index?: number;
    audioPath?: string;
    promptPath?: string;
    transcript?: string;
    coverageFeatures?: string[];
    errors?: string[];
    recordCommand?: string;
  };
  firstFailedClip?: {
    id: string;
    index?: number;
    audioPath?: string;
    checks?: string[];
    errors?: string[];
  };
  recordingPreflight?: {
    status?: string;
    ok?: boolean;
    message?: string;
    recorder?: {
      configured?: boolean;
      source?: string;
      template?: string | null;
    };
    recordingGuidance?: {
      durationMode?: "fixed" | "auto" | string;
      targetDurationSec?: number | null;
      targetDurationLabel?: string;
      minDurationSec?: number;
      maxDurationSec?: number;
      minActiveVoiceSec?: number;
    };
  };
  clipCount?: number;
  selectedClips?: number;
  recommendedClips?: number;
  recommendedPromptSet?: string;
  totalDurationSec?: number;
  recommendedDurationSec?: number;
  qualityGateJson?: string;
  datasetJson?: string;
  trainConfig?: string;
  adapterProof?: string;
  adapterProofStatus?: string;
  expectedWeights?: string;
  trainScript?: string;
  trainerStatus?: string;
  trainerCommandConfigured?: boolean;
  trainerCommandSource?: string;
  productQualityGateOk?: boolean;
  adapterPath?: string;
  report?: string;
  reviewJson?: string;
  missingBackends?: string[];
  asr?: Record<string, unknown>;
  speaker?: Record<string, unknown>;
  checkCommands?: string[];
  stats?: Record<string, unknown>;
}

export interface VoiceCloneGoalCompletionRequirement {
  id: string;
  stageId: string;
  order: number;
  requirement: string;
  status: VoiceCloneGoalAuditStage["status"];
  ok: boolean;
  message?: string;
  evidence: Record<string, unknown>;
}

export interface VoiceCloneGoalProfileReferenceRecordingCommand {
  presetId?: string;
  clipId?: string;
  transcript?: string;
  recordCommand?: string;
}

export interface VoiceCloneGoalQualityGateProbeCommand {
  caseId?: string;
  command?: string;
  proofScope?: string;
  verdict?: string;
  pronunciationVerdict?: string;
  speakerIdentityVerdict?: string;
  profileReferenceVerdict?: string;
  asrSamples?: Array<{
    repeat?: number;
    asrTranscript?: string;
    scoringTarget?: string;
  }>;
}

export interface VoiceCloneGoalQualityGateRepairAction {
  kind?: string;
  priority?: number;
  status?: string;
  reason?: string;
  command?: string;
  caseId?: string;
  clipIds?: string[];
  presetIds?: string[];
  dependsOn?: string;
  blockedUntil?: string | null;
  proofScope?: string;
  verdict?: string;
  pronunciationVerdict?: string;
  speakerIdentityVerdict?: string;
  profileReferenceVerdict?: string;
  asrSamples?: VoiceCloneGoalQualityGateProbeCommand["asrSamples"];
}

export interface VoiceCloneGoalAuditReport {
  status: "complete" | "blocked" | string;
  complete: boolean;
  profileJson: string;
  kitManifest: string;
  stages: VoiceCloneGoalAuditStage[];
  completionRequirements: VoiceCloneGoalCompletionRequirement[];
  firstBlocker?: VoiceCloneGoalAuditStage | null;
  firstIncompleteRequirement?: VoiceCloneGoalCompletionRequirement | null;
  nextBriefCommand?: string | null;
  nextOpenCueSheetCommand?: string | null;
  nextMicrophoneSmokeTestCommand?: string | null;
  nextNormalizeExternalRecordingsCommand?: string | null;
  nextNormalizePresentExternalRecordingsCommand?: string | null;
  nextProfileReferenceRecordingCommands?: VoiceCloneGoalProfileReferenceRecordingCommand[];
  nextProfileReferenceRecordingBatchCommand?: string | null;
  nextPostProfileReferenceRecordingProofCommand?: string | null;
  nextQualityGateProbeCommands?: VoiceCloneGoalQualityGateProbeCommand[];
  nextQualityGateRepairActions?: VoiceCloneGoalQualityGateRepairAction[];
  nextProductProofCommand?: string | null;
  nextProofEnvironmentCommand?: string | null;
  nextLoraHandoffCommand?: string | null;
  nextCommand?: string | null;
}

export interface GetVoiceCloneGoalAuditOptions {
  profileId?: string;
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

function parseAuditPayload(stdout: string): VoiceCloneGoalAuditReport {
  const parsed = JSON.parse(stdout) as Partial<VoiceCloneGoalAuditReport>;
  if (
    typeof parsed.status !== "string" ||
    typeof parsed.complete !== "boolean" ||
    typeof parsed.profileJson !== "string" ||
    typeof parsed.kitManifest !== "string" ||
    !Array.isArray(parsed.stages) ||
    !Array.isArray(parsed.completionRequirements)
  ) {
    throw new Error("voice clone goal audit script returned an invalid payload");
  }
  return parsed as VoiceCloneGoalAuditReport;
}

export async function getVoiceCloneGoalAudit({
  profileId: profileIdInput = "local-default",
}: GetVoiceCloneGoalAuditOptions = {}): Promise<VoiceCloneGoalAuditReport> {
  const profileId = assertSafeProfileId(profileIdInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "audit_voice_clone_goal.py");
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
      "--json",
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    },
  );
  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }
  return parseAuditPayload(stdout);
}

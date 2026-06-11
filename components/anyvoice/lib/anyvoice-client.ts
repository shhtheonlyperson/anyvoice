/* Typed client wrapping the existing route handlers. Components never call
   routes ad hoc — they go through here. */

import type { VoiceProfileCoverageFeature } from "@/lib/text-prep";

export interface ProfileListItem {
  id: string;
  displayName: string;
  status: "ready" | "needs_enrollment";
  usable: boolean;
  studioGrade: boolean;
  /** Meets this profile's own requirement tier (lenient for imports) — done. */
  meetsRequirements: boolean;
  clipCount: number;
  hash: number;
}

export interface ProfileClipEvidence {
  sourceRunId: string;
  transcriptRaw: string;
  coverageFeatures?: VoiceProfileCoverageFeature[];
}

export interface RejectedProfileClipEvidence extends ProfileClipEvidence {
  reasons?: string[];
}

export interface VoiceProfileDetail {
  clips?: ProfileClipEvidence[];
  rejectedClips?: RejectedProfileClipEvidence[];
  diagnostics?: {
    missingCoverageFeatures?: VoiceProfileCoverageFeature[];
  };
}

export interface BrowserDraftCaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
}

export interface RunItem {
  id: string;
  status: "ready" | "needs_worker" | "error";
  voiceName: string;
  targetText: string;
  audioUrl?: string;
  createdAt: string;
}

/** GET /api/voice-profile/profiles */
export async function fetchProfiles(): Promise<ProfileListItem[]> {
  const res = await fetch("/api/voice-profile/profiles", { cache: "no-store" });
  if (!res.ok) return [];
  const payload = (await res.json()) as { profiles?: ProfileListItem[] };
  return payload.profiles ?? [];
}

/** GET /api/voice-profile?profileId=... — full manifest summary for script-row status. */
export async function fetchVoiceProfileDetail(profileId: string): Promise<VoiceProfileDetail | null> {
  const res = await fetch(`/api/voice-profile?profileId=${encodeURIComponent(profileId)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => ({}))) as { profile?: VoiceProfileDetail };
  return payload.profile ?? null;
}

/** GET /api/runs — recent generations (only ready runs with audio are useful). */
export async function fetchRuns(limit = 12): Promise<RunItem[]> {
  const res = await fetch(`/api/runs?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) return [];
  const payload = (await res.json()) as { items?: RunItem[] };
  return (payload.items ?? []).filter((it) => it.status === "ready" && it.audioUrl);
}

/** POST /api/voice-profile/profiles — create an empty named profile. */
export async function createProfile(displayName: string): Promise<{ id: string } | null> {
  const res = await fetch("/api/voice-profile/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { profile?: { id: string } };
  return payload.profile ?? null;
}

/** PATCH /api/voice-profile/profiles/[id] — rename a profile. */
export async function renameProfile(id: string, displayName: string): Promise<boolean> {
  const res = await fetch(`/api/voice-profile/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  return res.ok;
}

/** DELETE /api/voice-profile/profiles/[id]. */
export async function deleteProfile(id: string): Promise<boolean> {
  const res = await fetch(`/api/voice-profile/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.ok;
}

export interface EnrollResult {
  ok: boolean;
  message?: string;
  code?: string;
}

/**
 * POST /api/voice-profile/enroll/youtube — synchronous import: resolves when
 * the backend has captured + analysed + built the signature. The caller binds
 * an in-flight "importing" UI to this promise's lifecycle (no fake timer).
 */
export async function enrollFromYoutube(args: {
  url: string;
  profileId: string;
}): Promise<EnrollResult> {
  const res = await fetch("/api/voice-profile/enroll/youtube", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: args.url, profileId: args.profileId, consent: "yes" }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    code?: string;
  };
  return {
    ok: res.ok && payload.status === "enrolled",
    message: payload.message,
    code: payload.code,
  };
}

/**
 * POST /api/voice-profile/enroll — upload a clip with a typed transcript and
 * consent. Synchronous: resolves when the clip is enrolled or rejected.
 */
export async function enrollFromUpload(args: {
  file: File;
  transcript: string;
  profileId: string;
}): Promise<EnrollResult> {
  const form = new FormData();
  form.set("voice", args.file);
  form.set("promptTranscript", args.transcript);
  form.set("sourceKind", "uploaded");
  form.set("voiceProfileId", args.profileId);
  form.set("consent", "yes");
  const res = await fetch("/api/voice-profile/enroll", { method: "POST", body: form });
  const payload = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
  return { ok: res.ok && payload.status === "enrolled", message: payload.message };
}

export interface GenerateResult {
  status: "ready" | "needs_worker" | "error";
  audioUrl?: string;
  jobId?: string;
  message?: string;
}

export interface VoiceCloneGoalRecordingClipEvidence {
  id?: string;
  index?: number;
  audioPath?: string;
  promptPath?: string;
  transcript?: string;
  coverageFeatures?: string[];
  errors?: string[];
  checks?: string[];
  recordCommand?: string;
}

export interface VoiceCloneGoalRecordingPreflight {
  status?: string;
  ok?: boolean;
  message?: string;
  recorder?: {
    configured?: boolean;
    source?: string;
    template?: string | null;
  };
  recordingGuidance?: {
    durationMode?: string;
    targetDurationSec?: number | null;
    targetDurationLabel?: string;
    minDurationSec?: number;
    maxDurationSec?: number;
    minActiveVoiceSec?: number;
    checklist?: string[];
  };
  summary?: Record<string, unknown>;
  run?: Record<string, unknown>;
}

export interface VoiceCloneGoalProofBackendEvidence {
  status?: string;
  available?: boolean;
  requiredBackend?: string;
  selectedAutoBackend?: string;
  checkCommand?: string;
  setupHint?: string;
  reason?: string;
  backends?: Record<string, unknown>;
  run?: Record<string, unknown>;
}

export interface VoiceCloneGoalCompletionRequirement {
  id: string;
  stageId: string;
  order: number;
  requirement: string;
  status: string;
  ok: boolean;
  message?: string;
  evidence: {
    missingClips?: string[];
    selectedClips?: number;
    recommendedClips?: number;
    totalDurationSec?: number;
    recommendedDurationSec?: number;
    requiredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
    pendingExternalRecordings?: VoiceCloneGoalRecordingClipEvidence[];
    pendingExternalRecordingCount?: number;
    missingExternalRecordingSourceCount?: number;
    firstMissingClip?: VoiceCloneGoalRecordingClipEvidence;
    firstFailedClip?: VoiceCloneGoalRecordingClipEvidence;
    recordingPreflight?: VoiceCloneGoalRecordingPreflight;
    asr?: VoiceCloneGoalProofBackendEvidence;
    speaker?: VoiceCloneGoalProofBackendEvidence;
    checkCommands?: string[];
    [key: string]: unknown;
  };
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

export interface VoiceCloneGoalAuditStage extends Omit<VoiceCloneGoalCompletionRequirement, "order" | "requirement" | "stageId" | "evidence"> {
  missingClips?: string[];
  pendingExternalRecordings?: VoiceCloneGoalRecordingClipEvidence[];
  pendingExternalRecordingCount?: number;
  missingExternalRecordingSourceCount?: number;
  firstMissingClip?: VoiceCloneGoalRecordingClipEvidence;
  firstFailedClip?: VoiceCloneGoalRecordingClipEvidence;
  recordingPreflight?: VoiceCloneGoalRecordingPreflight;
  asr?: VoiceCloneGoalProofBackendEvidence;
  speaker?: VoiceCloneGoalProofBackendEvidence;
  checkCommands?: string[];
  [key: string]: unknown;
}

export interface VoiceCloneGoalAuditSummary {
  status: string;
  complete: boolean;
  profileJson?: string;
  kitManifest?: string;
  completionRequirements: VoiceCloneGoalCompletionRequirement[];
  firstBlocker?: VoiceCloneGoalAuditStage | null;
  firstIncompleteRequirement?: VoiceCloneGoalCompletionRequirement | null;
  nextCommand?: string | null;
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
}

/** POST /api/voice-profile/goal-audit — authoritative 10x completion checklist. */
export async function fetchVoiceCloneGoalAudit(profileId: string): Promise<VoiceCloneGoalAuditSummary | null> {
  const res = await fetch("/api/voice-profile/goal-audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => ({}))) as { audit?: VoiceCloneGoalAuditSummary };
  return payload.audit ?? null;
}

export interface VoiceProfileDraftImportClip {
  lineIndex: number;
  transcript: string;
  file: File;
  captureSettings?: BrowserDraftCaptureSettings | null;
}

export interface VoiceProfileDraftImportResult {
  ok: boolean;
  status?: string;
  imported: number;
  message?: string;
  enrollments?: unknown[];
  profile?: VoiceProfileDetail;
}

function recordingKitClipId(lineIndex: number): string {
  return `profile-clip-${String(lineIndex + 1).padStart(2, "0")}`;
}

/** POST /api/voice-profile/import — bulk-import saved browser draft clips. */
export async function importVoiceProfileDraftClips(args: {
  profileId: string;
  clips: VoiceProfileDraftImportClip[];
}): Promise<VoiceProfileDraftImportResult> {
  if (args.clips.length === 0) {
    return { ok: false, imported: 0, message: "no draft clips to import" };
  }

  const form = new FormData();
  form.set("consent", "yes");
  form.set("profileId", args.profileId);
  form.set(
    "clips",
    JSON.stringify(
      args.clips.map((clip, index) => ({
        id: recordingKitClipId(clip.lineIndex),
        fileField: `voice-${index}`,
        transcript: clip.transcript,
        sourceKind: "scripted",
        ...(clip.captureSettings ? { browserCaptureSettings: clip.captureSettings } : {}),
      })),
    ),
  );
  args.clips.forEach((clip, index) => {
    form.set(`voice-${index}`, clip.file);
  });

  const res = await fetch("/api/voice-profile/import", { method: "POST", body: form });
  const payload = (await res.json().catch(() => ({}))) as {
    status?: string;
    imported?: number;
    message?: string;
    enrollments?: unknown[];
    profile?: VoiceProfileDetail;
  };
  return {
    ok: res.ok && payload.status === "imported",
    status: payload.status,
    imported: typeof payload.imported === "number" ? payload.imported : 0,
    message: payload.message,
    enrollments: payload.enrollments,
    profile: payload.profile,
  };
}

/** POST /api/voice-profile/transcript-validation — ASR alignment gate. */
export async function runVoiceProfileTranscriptValidation(profileId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch("/api/voice-profile/transcript-validation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** POST /api/voice-profile/verify — strict reusable-profile readiness gate. */
export async function verifyVoiceProfile(profileId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch("/api/voice-profile/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Refresh the proof surfaces that should move after browser draft import. */
export async function refreshVoiceProfileProofChain(profileId: string): Promise<{
  validation: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  audit: VoiceCloneGoalAuditSummary | null;
}> {
  const validation = await runVoiceProfileTranscriptValidation(profileId);
  const verification = await verifyVoiceProfile(profileId);
  const audit = await fetchVoiceCloneGoalAudit(profileId);
  return { validation, verification, audit };
}

/**
 * POST /api/clone/stream with a profile reference. Drains the ndjson stream,
 * forwarding progress to `onProgress`, and resolves with the terminal payload.
 * Falls back to a plain JSON response if the worker does not stream.
 */
export async function generateFromProfile(
  args: { profileId: string; targetText: string; quality?: string; pronunciationOverrides?: string },
  onProgress?: (phase: string, done?: number, total?: number) => void,
): Promise<GenerateResult> {
  const form = new FormData();
  form.set("targetText", args.targetText);
  form.set("consent", "yes");
  form.set("quality", args.quality ?? "balanced");
  form.set("useVoiceProfile", "yes");
  form.set("profileId", args.profileId);
  form.set("allowDraftVoiceProfile", "yes");
  if (args.pronunciationOverrides?.trim()) form.set("pronunciationOverrides", args.pronunciationOverrides);

  const res = await fetch("/api/clone/stream", { method: "POST", body: form });
  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("application/x-ndjson") && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal: GenerateResult | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.status === "progress") {
            onProgress?.(String(parsed.phase ?? ""), Number(parsed.done), Number(parsed.total));
          } else if (parsed.status === "ready" || parsed.status === "needs_worker" || parsed.status === "error") {
            terminal = parsed as unknown as GenerateResult;
          }
        } catch {
          /* ignore malformed line */
        }
      }
    }
    return terminal ?? { status: "error", message: "no terminal payload" };
  }

  const payload = (await res.json()) as GenerateResult;
  return payload;
}

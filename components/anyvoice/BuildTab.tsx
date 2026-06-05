"use client";
/* Build voice — the handoff's screen #1. Adaptive page driven by the active
 * voice's REAL summary (from GET /api/voice-profile/profiles → clipCount /
 * usable / studioGrade), mapped to the design states:
 *
 *   empty      clipCount === 0           cream card + Start recording + 3 options
 *   reviewing  usable, not studioGrade   cream card + progress donut + Continue
 *   ready      studioGrade               coral hero + Start generating + Listen back
 *   recording  user clicked a record CTA the in-browser 24-line record-and-grade stage
 *
 * The recording state is the heart of the product: the handoff's dark recording
 * stage with the 24-line guided script (components/anyvoice/build-script.ts),
 * a live 6–20s duration meter, a "Space to stop" shortcut, line dots/list, and
 * a phoneme-coverage sidecar.
 *
 * It REUSES the proven capture + enroll + grading from VoiceCloneStudio: the
 * same getUserMedia constraints that reject browser AGC/NS, the same
 * MediaRecorder options + recorded-file creation, and the same
 * POST /api/voice-profile/enroll contract (promptTranscript = the line text,
 * sourceKind="scripted", the active profileId, consent=yes). The returned
 * referenceQuality.grade marks the line passed (A/B) or re-record (C/D) with a
 * single honest reason. Donut + state advance off the refreshed real summary;
 * row dots are seeded from the full profile manifest when available, so rejected
 * scripted takes stay visible instead of being flattened into aggregate clipCount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceCloneStudio } from "@/components/VoiceCloneStudio";
import { buildProfileScriptPlan } from "@/lib/profile-guidance";
import {
  simplifiedOrMixedChineseScriptErrors,
  type VoiceProfileCoverageFeature,
} from "@/lib/text-prep";
import {
  BUILD_LINE_COUNT,
  BUILD_SCRIPT_PACK,
  lineStatusFromGrade,
  type BuildScriptLocale,
} from "./build-script";
import {
  coverageFromTexts,
  phonemesInText,
  FINALS,
  INITIALS,
  TONES,
  type Final,
  type Initial,
  type Tone,
} from "@/lib/mandarin-phonemes";
import { useLang, useT, type Lang, type Translate } from "./i18n";
import type {
  ProfileListItem,
  VoiceProfileDraftImportClip,
  VoiceCloneGoalAuditSummary,
  VoiceCloneGoalCompletionRequirement,
  VoiceProfileDetail,
} from "./lib/anyvoice-client";
import {
  deleteProfile,
  fetchVoiceCloneGoalAudit,
  fetchVoiceProfileDetail,
  importVoiceProfileDraftClips,
  refreshVoiceProfileProofChain,
  renameProfile,
} from "./lib/anyvoice-client";
import {
  deleteBrowserRecordingDraft,
  loadBrowserRecordingDraft,
  loadBrowserRecordingDrafts,
  saveBrowserRecordingDraft,
  updateBrowserRecordingDraft,
  type BrowserRecordingDraft,
} from "./lib/browser-recording-drafts";
import {
  IcCheck,
  IcChevron,
  IcChevronLeft,
  IcEdit,
  IcMic,
  IcRotate,
  IcSquare,
  IcTrash,
  IcUpload,
  IcYoutube,
} from "./icons";
import { Donut, LiveWaveform, MiniWaveform } from "./waveforms";

type BuildState = "empty" | "reviewing" | "ready" | "recording";
type LineStatus = "todo" | "draft" | "pass" | "retry" | "recording" | "processing";

/** Map the real summary to the design state. */
function deriveState(p: ProfileListItem | undefined): Exclude<BuildState, "recording"> {
  if (!p || p.clipCount === 0) return "empty";
  // Done only when the strict curated bar is met. A lighter/imported profile
  // can be usable for draft work, but it should not look 10x-ready.
  if (p.studioGrade) return "ready";
  return "reviewing";
}

function titleKey(state: BuildState): string {
  if (state === "empty") return "build.title.empty";
  if (state === "ready") return "build.title.ready";
  if (state === "recording") return "build.recording.title";
  return "build.title.reviewing";
}
function ledeKey(state: BuildState): string {
  if (state === "empty") return "build.lede.empty";
  if (state === "ready") return "build.lede.ready";
  if (state === "recording") return "build.recording.sub";
  return "build.lede.reviewing";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function coverageFeatureList(value: unknown): VoiceProfileCoverageFeature[] {
  return Array.isArray(value) ? value.filter((item): item is VoiceProfileCoverageFeature => typeof item === "string") : [];
}

interface FirstMissingClip {
  id: string | null;
  transcript: string | null;
  recordCommand: string | null;
}

interface ProofEnvironmentSummary {
  ok: boolean;
  message: string | null;
  asrBackend: string | null;
  asrStatus: string | null;
  speakerBackend: string | null;
  speakerStatus: string | null;
  checkCommands: string[];
}

interface RecordingPreflightSummary {
  ok: boolean;
  status: string | null;
  message: string | null;
  recorderSource: string | null;
  targetDurationLabel: string | null;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  minActiveVoiceSec: number | null;
  checklist: string[];
  commands: Array<{ label: string; command: string }>;
}

interface CaptureDepthSummary {
  selectedClips: number | null;
  recommendedClips: number | null;
  totalDurationSec: number | null;
  recommendedDurationSec: number | null;
  missingPronunciationPresetIds: string[];
}

interface AuditCommand {
  label: string;
  command: string;
}

interface RepairAction {
  key: string;
  title: string;
  reason: string | null;
  blockedUntil: string | null;
  command: string;
}

interface QualityProbeSample {
  caseId: string;
  asrTranscript: string;
  scoringTarget: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstMissingClip(row: VoiceCloneGoalCompletionRequirement | null): FirstMissingClip | null {
  if (!row) return null;
  const firstMissing = row.evidence.firstMissingClip;
  if (firstMissing && typeof firstMissing === "object") {
    const clip = firstMissing as { id?: unknown; transcript?: unknown; recordCommand?: unknown };
    const id = stringValue(clip.id);
    const transcript = stringValue(clip.transcript);
    const recordCommand = stringValue(clip.recordCommand);
    if (id || transcript || recordCommand) return { id, transcript, recordCommand };
  }
  const fallbackId = stringList(row.evidence.missingClips)[0] ?? null;
  return fallbackId ? { id: fallbackId, transcript: null, recordCommand: null } : null;
}

function recordingPreflightSummary(
  row: VoiceCloneGoalCompletionRequirement | null,
  audit: VoiceCloneGoalAuditSummary | null,
): RecordingPreflightSummary | null {
  const checklistRow = row
    ? audit?.completionRequirements.find((item) => item.id === row.id || item.stageId === row.stageId)
    : null;
  const preflight = objectValue(row?.evidence.recordingPreflight) ?? objectValue(checklistRow?.evidence.recordingPreflight);
  if (!preflight) return null;
  const recorder = objectValue(preflight.recorder);
  const guidance = objectValue(preflight.recordingGuidance);
  const commands = [
    { label: "build.goal.micSmokeCommand", command: audit?.nextMicrophoneSmokeTestCommand },
    { label: "build.goal.preflightCommand", command: audit?.nextBriefCommand },
    { label: "build.goal.normalizeCommand", command: audit?.nextNormalizeExternalRecordingsCommand },
    { label: "build.goal.normalizePresentCommand", command: audit?.nextNormalizePresentExternalRecordingsCommand },
  ]
    .map((item) => ({ label: item.label, command: stringValue(item.command) }))
    .filter((item): item is { label: string; command: string } => Boolean(item.command));

  return {
    ok: preflight.ok === true,
    status: stringValue(preflight.status),
    message: stringValue(preflight.message),
    recorderSource: stringValue(recorder?.source),
    targetDurationLabel: stringValue(guidance?.targetDurationLabel),
    minDurationSec: numberValue(guidance?.minDurationSec),
    maxDurationSec: numberValue(guidance?.maxDurationSec),
    minActiveVoiceSec: numberValue(guidance?.minActiveVoiceSec),
    checklist: stringList(guidance?.checklist),
    commands,
  };
}

function captureDepthSummary(
  row: VoiceCloneGoalCompletionRequirement | null,
  audit: VoiceCloneGoalAuditSummary | null,
): CaptureDepthSummary | null {
  const captureRow = audit?.completionRequirements.find((item) => item.id === "capture_depth" || item.stageId === "capture_depth");
  const evidence = row?.evidence ?? {};
  const fallback = captureRow?.evidence ?? {};
  const selectedClips = numberValue(evidence.selectedClips) ?? numberValue(fallback.selectedClips);
  const recommendedClips = numberValue(evidence.recommendedClips) ?? numberValue(fallback.recommendedClips);
  const totalDurationSec = numberValue(evidence.totalDurationSec) ?? numberValue(fallback.totalDurationSec);
  const recommendedDurationSec = numberValue(evidence.recommendedDurationSec) ?? numberValue(fallback.recommendedDurationSec);
  const missingPronunciationPresetIds = stringList(
    evidence.missingPronunciationPresetIds ?? fallback.missingPronunciationPresetIds,
  );

  if (
    selectedClips === null &&
    recommendedClips === null &&
    totalDurationSec === null &&
    recommendedDurationSec === null &&
    missingPronunciationPresetIds.length === 0
  ) {
    return null;
  }
  return {
    selectedClips,
    recommendedClips,
    totalDurationSec,
    recommendedDurationSec,
    missingPronunciationPresetIds,
  };
}

function proofEnvironmentSummary(audit: VoiceCloneGoalAuditSummary | null): ProofEnvironmentSummary | null {
  const row = audit?.completionRequirements.find((item) => item.id === "proof_environment" || item.stageId === "proof_environment");
  if (!row) return null;
  const asr = objectValue(row.evidence.asr);
  const speaker = objectValue(row.evidence.speaker);
  const checkCommands = stringList(row.evidence.checkCommands);
  return {
    ok: row.ok,
    message: row.message || null,
    asrBackend: stringValue(asr?.selectedAutoBackend) ?? stringValue(asr?.requiredBackend),
    asrStatus: stringValue(asr?.status) ?? stringValue(asr?.reason),
    speakerBackend: stringValue(speaker?.selectedAutoBackend) ?? stringValue(speaker?.requiredBackend),
    speakerStatus: stringValue(speaker?.status) ?? stringValue(speaker?.reason),
    checkCommands,
  };
}

function followOnCommands(audit: VoiceCloneGoalAuditSummary | null): AuditCommand[] {
  if (!audit) return [];
  const profileReferenceCommands = (audit.nextProfileReferenceRecordingCommands ?? [])
    .map((item) => ({
      label: "build.goal.profileReferenceClipCommand",
      command: stringValue(item.recordCommand),
    }))
    .filter((item): item is AuditCommand => Boolean(item.command));
  const qualityProbeCommands = (audit.nextQualityGateProbeCommands ?? [])
    .map((item) => ({
      label: "build.goal.qualityProbeCommand",
      command: stringValue(item.command),
    }))
    .filter((item): item is AuditCommand => Boolean(item.command));
  return [
    { label: "build.goal.profileReferenceBatchCommand", command: audit.nextProfileReferenceRecordingBatchCommand },
    { label: "build.goal.postProfileReferenceProofCommand", command: audit.nextPostProfileReferenceRecordingProofCommand },
    { label: "build.goal.productProofCommand", command: audit.nextProductProofCommand },
    { label: "build.goal.loraHandoffCommand", command: audit.nextLoraHandoffCommand },
    ...profileReferenceCommands,
    ...qualityProbeCommands,
  ]
    .map((item) => ({ label: item.label, command: stringValue(item.command) }))
    .filter((item): item is AuditCommand => Boolean(item.command));
}

function qualityProbeSamples(audit: VoiceCloneGoalAuditSummary | null): QualityProbeSample[] {
  if (!audit) return [];
  return (audit.nextQualityGateProbeCommands ?? [])
    .map((probe) => {
      const sample = probe.asrSamples?.find((item) => stringValue(item.asrTranscript) || stringValue(item.scoringTarget));
      const caseId = stringValue(probe.caseId);
      const asrTranscript = stringValue(sample?.asrTranscript);
      const scoringTarget = stringValue(sample?.scoringTarget);
      return caseId && (asrTranscript || scoringTarget)
        ? {
            caseId,
            asrTranscript: asrTranscript ?? "",
            scoringTarget: scoringTarget ?? "",
          }
        : null;
    })
    .filter((item): item is QualityProbeSample => item !== null);
}

function repairActions(audit: VoiceCloneGoalAuditSummary | null): RepairAction[] {
  if (!audit) return [];
  return (audit.nextQualityGateRepairActions ?? [])
    .map((action, index) => {
      const command = stringValue(action.command);
      if (!command) return null;
      const priority = typeof action.priority === "number" && Number.isFinite(action.priority) ? `P${action.priority}` : null;
      const kind = stringValue(action.kind) ?? "repair";
      const caseId = stringValue(action.caseId);
      const status = stringValue(action.status);
      return {
        key: `${index}:${command}`,
        title: [[priority, kind, caseId].filter(Boolean).join(" / "), status ? `[${status}]` : null]
          .filter(Boolean)
          .join(" "),
        reason: stringValue(action.reason),
        blockedUntil: stringValue(action.blockedUntil),
        command,
      };
    })
    .filter((item): item is RepairAction => item !== null);
}

function cueSheetHref(audit: VoiceCloneGoalAuditSummary | null, profileId: string): string | null {
  if (!audit?.kitManifest) return null;
  const params = new URLSearchParams({ profileId, manifest: audit.kitManifest });
  return `/api/voice-profile/recording-kit/cue-sheet?${params.toString()}`;
}

function GoalAuditPanel({
  audit,
  profileId,
}: {
  audit: VoiceCloneGoalAuditSummary | null;
  profileId: string;
}) {
  const t = useT();
  const firstIncomplete =
    audit?.firstIncompleteRequirement ?? audit?.completionRequirements.find((row) => !row.ok) ?? null;
  const missingClips = stringList(firstIncomplete?.evidence.missingClips);
  const firstClip = firstMissingClip(firstIncomplete);
  const passed = audit?.completionRequirements.filter((row) => row.ok).length ?? 0;
  const total = audit?.completionRequirements.length ?? 0;
  const statusKey = audit?.complete ? "build.goal.status.complete" : "build.goal.status.blocked";
  const cueSheet = cueSheetHref(audit, profileId);
  const recordingPreflight = recordingPreflightSummary(firstIncomplete, audit);
  const captureDepth = captureDepthSummary(firstIncomplete, audit);
  const proofEnvironment = proofEnvironmentSummary(audit);
  const afterRecordingCommands = followOnCommands(audit);
  const probeSamples = qualityProbeSamples(audit);
  const qualityRepairActions = repairActions(audit);

  if (!audit) return null;

  return (
    <section className="goal-audit-panel" aria-label={t("build.goal.title")}>
      <div className="row between gap-16 goal-audit-head">
        <div>
          <div className="player-eyebrow">{t("build.goal.eyebrow")}</div>
          <h2>{t("build.goal.title")}</h2>
        </div>
        <span className={"goal-audit-badge" + (audit?.complete ? " pass" : " blocked")}>
          {t(statusKey)}
        </span>
      </div>

      {audit && (
        <>
          <div className="goal-audit-grid">
            <div>
              <span>{t("build.goal.progress")}</span>
              <strong>{passed} / {total}</strong>
            </div>
            <div>
              <span>{t("build.goal.nextGate")}</span>
              <strong>{firstIncomplete?.id ?? t("build.goal.none")}</strong>
            </div>
            <div>
              <span>{t("build.goal.missingClips")}</span>
              <strong>{missingClips.length ? String(missingClips.length) : "0"}</strong>
            </div>
            {captureDepth && (
              <div>
                <span>{t("build.goal.captureDepth")}</span>
                <strong>
                  {captureDepth.selectedClips !== null || captureDepth.recommendedClips !== null
                    ? t("build.goal.captureClips", {
                        n: String(captureDepth.selectedClips ?? 0),
                        total: String(captureDepth.recommendedClips ?? 0),
                      })
                    : t("build.goal.none")}
                </strong>
                {captureDepth.totalDurationSec !== null || captureDepth.recommendedDurationSec !== null ? (
                  <small>
                    {t("build.goal.captureDuration", {
                      sec: String(captureDepth.totalDurationSec ?? 0),
                      target: String(captureDepth.recommendedDurationSec ?? 0),
                    })}
                  </small>
                ) : null}
              </div>
            )}
          </div>

          {firstIncomplete && (
            <p className="goal-audit-message">
              {firstIncomplete.message || firstIncomplete.requirement}
              {firstClip?.id ? ` · ${t("build.goal.firstClip", { id: firstClip.id })}` : ""}
            </p>
          )}

          {missingClips.length > 0 && (
            <div className="goal-audit-missing-list">
              <span>{t("build.goal.missingClipList")}</span>
              <div>
                {missingClips.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </div>
            </div>
          )}

          {captureDepth && captureDepth.missingPronunciationPresetIds.length > 0 && (
            <div className="goal-audit-missing-list">
              <span>{t("build.goal.missingPronunciationPresets")}</span>
              <div>
                {captureDepth.missingPronunciationPresetIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </div>
            </div>
          )}

          {firstClip?.transcript && (
            <div className="goal-audit-prompt">
              <span>{t("build.goal.firstPrompt")}</span>
              <p>{firstClip.transcript}</p>
            </div>
          )}

          {recordingPreflight && (
            <div className="goal-audit-preflight">
              <span>{t("build.goal.recordingPreflight")}</span>
              <div className="goal-audit-preflight-grid">
                <div>
                  <strong>{t("build.goal.recorder")}: {recordingPreflight.recorderSource ?? t("build.goal.none")}</strong>
                  <small>{recordingPreflight.status ?? (recordingPreflight.ok ? t("build.goal.status.complete") : t("build.goal.status.blocked"))}</small>
                </div>
                <div>
                  <strong>{t("build.goal.target")}: {recordingPreflight.targetDurationLabel ?? t("build.goal.none")}</strong>
                  <small>
                    {recordingPreflight.minDurationSec !== null && recordingPreflight.maxDurationSec !== null
                      ? t("build.goal.durationRange", {
                          min: String(recordingPreflight.minDurationSec),
                          max: String(recordingPreflight.maxDurationSec),
                        })
                      : ""}
                    {recordingPreflight.minActiveVoiceSec !== null
                      ? ` · ${t("build.goal.minActiveVoice", { sec: String(recordingPreflight.minActiveVoiceSec) })}`
                      : ""}
                  </small>
                </div>
              </div>
              {recordingPreflight.message && <p>{recordingPreflight.message}</p>}
              {recordingPreflight.checklist.length > 0 && (
                <ul>
                  {recordingPreflight.checklist.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {recordingPreflight.commands.map((item) => (
                <div className="goal-audit-command" key={item.command}>
                  <span>{t(item.label)}</span>
                  <code>{item.command}</code>
                </div>
              ))}
            </div>
          )}

          {proofEnvironment && (
            <div className="goal-audit-proof">
              <span>{t("build.goal.proofBackends")}</span>
              <div className="goal-audit-proof-grid">
                <div>
                  <strong>{t("build.goal.asr")}: {proofEnvironment.asrBackend ?? t("build.goal.none")}</strong>
                  <small>{proofEnvironment.asrStatus ?? (proofEnvironment.ok ? t("build.goal.status.complete") : t("build.goal.status.blocked"))}</small>
                </div>
                <div>
                  <strong>{t("build.goal.speaker")}: {proofEnvironment.speakerBackend ?? t("build.goal.none")}</strong>
                  <small>{proofEnvironment.speakerStatus ?? (proofEnvironment.ok ? t("build.goal.status.complete") : t("build.goal.status.blocked"))}</small>
                </div>
              </div>
              {proofEnvironment.message && <p>{proofEnvironment.message}</p>}
              {proofEnvironment.checkCommands.map((command) => (
                <div className="goal-audit-command" key={command}>
                  <span>{t("build.goal.proofCommand")}</span>
                  <code>{command}</code>
                </div>
              ))}
            </div>
          )}

          {cueSheet && (
            <div className="goal-audit-actions">
              <a className="btn btn--secondary btn--sm" href={cueSheet} target="_blank" rel="noreferrer">
                {t("build.goal.openCueSheet")}
              </a>
            </div>
          )}

          {firstClip?.recordCommand && (
            <div className="goal-audit-command">
              <span>{t("build.goal.focusedCommand")}</span>
              <code>{firstClip.recordCommand}</code>
            </div>
          )}

          {audit.nextCommand && (
            <div className="goal-audit-command">
              <span>{t("build.goal.nextCommand")}</span>
              <code>{audit.nextCommand}</code>
            </div>
          )}

          {probeSamples.length > 0 && (
            <div className="goal-audit-probes">
              <span>{t("build.goal.qualityProbeEvidence")}</span>
              {probeSamples.slice(0, 4).map((sample) => (
                <div className="goal-audit-probe" key={sample.caseId}>
                  <strong>{sample.caseId}</strong>
                  {sample.asrTranscript && <small>{t("build.goal.asrSample")}: {sample.asrTranscript}</small>}
                  {sample.scoringTarget && <small>{t("build.goal.targetSample")}: {sample.scoringTarget}</small>}
                </div>
              ))}
            </div>
          )}

          {qualityRepairActions.length > 0 && (
            <div className="goal-audit-repairs">
              <span>{t("build.goal.qualityRepairQueue")}</span>
              {qualityRepairActions.map((item) => (
                <div className="goal-audit-repair" key={item.key}>
                  <strong>{item.title}</strong>
                  {item.reason && <small>{item.reason}</small>}
                  {item.blockedUntil && <small>{t("build.goal.blockedUntil")}: {item.blockedUntil}</small>}
                  <code>{item.command}</code>
                </div>
              ))}
            </div>
          )}

          {afterRecordingCommands.length > 0 && (
            <div className="goal-audit-followon">
              <span>{t("build.goal.afterRecording")}</span>
              {afterRecordingCommands.map((item) => (
                <div className="goal-audit-command" key={item.command}>
                  <span>{t(item.label)}</span>
                  <code>{item.command}</code>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- enroll/capture mechanics reused verbatim from VoiceCloneStudio ----
const REC_MIN_SEC = 6;
const REC_MAX_SEC = 20;
const REC_MIN_ACTIVE_VOICE_SEC = 5.2;
const LIVE_ACTIVE_VOICE_RMS_THRESHOLD = 0.012;
const MAX_DRAFT_IMPORT_BATCH = 10;
type NoticeKind = "neutral" | "success" | "error";

const VOICE_CAPTURE_MEDIA_CONSTRAINTS = {
  audio: {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
  },
} satisfies MediaStreamConstraints;

function createRecordedFile(chunks: Blob[], mimeType: string, stamp: number): File {
  const type = mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("wav") ? "wav" : "webm";
  return new File(chunks, `recording-${stamp}.${extension}`, { type });
}

function supportedRecorderOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  return mimeType ? { mimeType } : undefined;
}

interface ReferenceQuality {
  grade: "A" | "B" | "C" | "D";
  durationSec: number;
  warnings: string[];
}
interface BrowserCaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
}
interface EnrollPayload {
  status: "enrolled" | "error";
  message?: string;
  referenceQuality?: ReferenceQuality;
  profile?: {
    usable?: boolean;
    studioGrade?: boolean;
    status?: "ready" | "needs_enrollment";
    requirements?: { passingGrades?: string[] };
    clips?: { transcriptRaw?: string }[];
  };
}
type BrowserAudioContextConstructor = new () => AudioContext;

interface LiveActiveVoiceMeter {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  lastSampleAt: number;
  activeVoiceSec: number;
}

// Turn the analyzer's actual finding into one specific, honest reason. The most
// common case for clean-sounding clips is duration, not noise (mirrors
// VoiceCloneStudio.rejectionMessage).
function rejectionMessage(t: Translate, q: ReferenceQuality | undefined): string {
  const dur = q?.durationSec ?? 0;
  if (dur > 0 && dur < REC_MIN_SEC) return t("build.rec.tooShort", { sec: dur.toFixed(1), min: REC_MIN_SEC });
  if (dur > REC_MAX_SEC) return t("build.rec.tooLong", { sec: dur.toFixed(1), max: REC_MAX_SEC });
  const w = q?.warnings ?? [];
  if (w.includes("short_clip")) return t("build.rec.tooShort", { sec: dur.toFixed(1), min: REC_MIN_SEC });
  if (w.includes("long_clip")) return t("build.rec.tooLong", { sec: dur.toFixed(1), max: REC_MAX_SEC });
  if (w.includes("clipping_detected")) return t("build.rec.clipping");
  if (w.includes("low_snr")) return t("build.rec.noisy");
  if (w.some((x) => x.includes("voice") || x.includes("vad") || x.includes("active"))) return t("build.rec.lowVoice");
  return t("build.rec.rejected");
}

function browserCaptureSettings(stream: MediaStream): BrowserCaptureSettings | null {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() as MediaTrackSettings | undefined;
  if (!settings) return null;
  return {
    ...(typeof settings.echoCancellation === "boolean" ? { echoCancellation: settings.echoCancellation } : {}),
    ...(typeof settings.noiseSuppression === "boolean" ? { noiseSuppression: settings.noiseSuppression } : {}),
    ...(typeof settings.autoGainControl === "boolean" ? { autoGainControl: settings.autoGainControl } : {}),
    ...(typeof settings.sampleRate === "number" ? { sampleRate: settings.sampleRate } : {}),
    ...(typeof settings.channelCount === "number" ? { channelCount: settings.channelCount } : {}),
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, percentileValue));
  const index = (sortedValues.length - 1) * (clamped / 100);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower] ?? 0;
  const lowerValue = sortedValues[lower] ?? 0;
  const upperValue = sortedValues[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function activeVoiceSecondsFromAudioBuffer(buffer: AudioBuffer): number | null {
  if (buffer.sampleRate <= 0 || buffer.length <= 0 || buffer.numberOfChannels <= 0) return null;
  const frameSize = Math.max(1, Math.floor(buffer.sampleRate * 0.02));
  const frameCount = buffer.length < frameSize ? 1 : Math.floor(buffer.length / frameSize);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const rmsValues: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(buffer.length, start + frameSize);
    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const value = channel[sampleIndex] ?? 0;
        sumSquares += value * value;
      }
      sampleCount += Math.max(0, end - start);
    }
    rmsValues.push(Math.sqrt(sumSquares / Math.max(1, sampleCount) + 1e-12));
  }
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const noiseFloor = percentile(sorted, 30);
  const threshold = noiseFloor * (10 ** (6 / 20));
  const activeFrames = rmsValues.filter((rms) => rms >= threshold).length;
  const activeVoiceSec = activeFrames * (frameSize / buffer.sampleRate);
  return Math.min(buffer.duration, activeVoiceSec);
}

function rmsFromFloatBuffer(buffer: ArrayLike<number>): number {
  if (buffer.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index] ?? 0;
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / buffer.length);
}

function startLiveActiveVoiceMeter(stream: MediaStream, startedAt: number): LiveActiveVoiceMeter | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as Window & {
    AudioContext?: BrowserAudioContextConstructor;
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    return {
      context,
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      lastSampleAt: startedAt,
      activeVoiceSec: 0,
    };
  } catch {
    return null;
  }
}

async function estimateBrowserActiveVoiceSec(file: Blob): Promise<number | null> {
  if (typeof window === "undefined") return null;
  const audioWindow = window as Window & {
    AudioContext?: BrowserAudioContextConstructor;
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextCtor) return null;
  let context: AudioContext | null = null;
  try {
    const audioContext = new AudioContextCtor();
    context = audioContext;
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    return activeVoiceSecondsFromAudioBuffer(buffer);
  } catch {
    return null;
  } finally {
    if (context && typeof context.close === "function") {
      await context.close().catch(() => undefined);
    }
  }
}

function captureSettingsSummary(t: Translate, settings: BrowserCaptureSettings | null): string {
  if (!settings) return t("build.rec.captureSettingsUnknown");
  const parts: string[] = [];
  if (typeof settings.sampleRate === "number") {
    parts.push(t("build.rec.captureSampleRate", { hz: String(settings.sampleRate) }));
  }
  if (typeof settings.channelCount === "number") {
    parts.push(t("build.rec.captureChannels", { n: String(settings.channelCount) }));
  }
  const enabledProcessing = [
    settings.echoCancellation ? "echoCancellation" : null,
    settings.noiseSuppression ? "noiseSuppression" : null,
    settings.autoGainControl ? "autoGainControl" : null,
  ].filter((item): item is string => Boolean(item));
  parts.push(
    enabledProcessing.length > 0
      ? t("build.rec.captureProcessingOn", { flags: enabledProcessing.join(", ") })
      : t("build.rec.captureProcessingOff"),
  );
  return parts.join(" · ");
}

function firstRecordableLineIndex(statuses: LineStatus[]): number {
  return statuses.findIndex((status) => status !== "pass" && status !== "draft");
}

function fileFromDraft(draft: BrowserRecordingDraft): File | null {
  if (!draft.blob) return null;
  if (draft.blob instanceof File) return draft.blob;
  return new File([draft.blob], draft.fileName, { type: draft.mimeType || "application/octet-stream" });
}

function enabledCaptureProcessingFlags(settings: BrowserCaptureSettings | null | undefined): string[] {
  return [
    settings?.echoCancellation ? "echoCancellation" : null,
    settings?.noiseSuppression ? "noiseSuppression" : null,
    settings?.autoGainControl ? "autoGainControl" : null,
  ].filter((item): item is string => Boolean(item));
}

function captureSettingsError(t: Translate, settings: BrowserCaptureSettings | null | undefined): string | null {
  const enabledProcessing = enabledCaptureProcessingFlags(settings);
  return enabledProcessing.length > 0
    ? t("build.rec.micProcessingFlags", { flags: enabledProcessing.join(", ") })
    : null;
}

function draftDurationError(t: Translate, draft: BrowserRecordingDraft): string | null {
  if (draft.durationSec > 0 && draft.durationSec < REC_MIN_SEC) {
    return t("build.rec.tooShort", { sec: draft.durationSec.toFixed(1), min: REC_MIN_SEC });
  }
  if (draft.durationSec > REC_MAX_SEC) {
    return t("build.rec.tooLong", { sec: draft.durationSec.toFixed(1), max: REC_MAX_SEC });
  }
  const activeVoiceSec = typeof draft.activeVoiceSec === "number" && Number.isFinite(draft.activeVoiceSec)
    ? draft.activeVoiceSec
    : null;
  if (activeVoiceSec !== null && activeVoiceSec < REC_MIN_ACTIVE_VOICE_SEC) {
    return t("build.rec.activeVoiceTooLow", {
      sec: activeVoiceSec.toFixed(1),
      min: REC_MIN_ACTIVE_VOICE_SEC.toFixed(1),
    });
  }
  return null;
}

function draftEvidenceError(t: Translate, draft: BrowserRecordingDraft): string | null {
  return draftDurationError(t, draft) ?? captureSettingsError(t, draft.captureSettings);
}

function lineStatusesFromProfileDetail(pack: BuildScriptLocale, profile: VoiceProfileDetail | null): LineStatus[] | null {
  if (!profile) return null;
  const plan = buildProfileScriptPlan({
    scripts: BUILD_SCRIPT_PACK[pack].map((line) => line.text),
    acceptedClips: profile.clips ?? [],
    rejectedClips: profile.rejectedClips ?? [],
    missingCoverageFeatures: coverageFeatureList(profile.diagnostics?.missingCoverageFeatures),
  });
  return plan.map((item) => {
    if (item.status === "accepted") return "pass";
    if (item.status === "rejected") return "retry";
    return "todo";
  });
}

/* ----------------------------------------------------------------------- */
/* The dark in-browser record-and-grade stage (handoff recording state).   */
/* ----------------------------------------------------------------------- */
function BuildRecordingStage({
  profileId,
  pack,
  initialStatuses,
  onClose,
  onEnrolled,
}: {
  profileId: string;
  pack: BuildScriptLocale;
  /** Per-line status seeded from the profile's already-enrolled transcripts. */
  initialStatuses: LineStatus[];
  onClose: () => void;
  /** Called after each enroll with the fresh profile so the parent can refresh. */
  onEnrolled: () => void;
}) {
  const t = useT();
  const lines = BUILD_SCRIPT_PACK[pack];

  const [statuses, setStatuses] = useState<LineStatus[]>(initialStatuses);
  const [cur, setCur] = useState(() => {
    const firstTodo = firstRecordableLineIndex(initialStatuses);
    return firstTodo >= 0 ? firstTodo : 0;
  });
  const [drafts, setDrafts] = useState<Record<number, BrowserRecordingDraft>>({});
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeVoiceElapsed, setActiveVoiceElapsed] = useState(0);
  const [liveActiveVoiceAvailable, setLiveActiveVoiceAvailable] = useState(false);
  const [captureSettingsNotice, setCaptureSettingsNotice] = useState("");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<NoticeKind>("neutral");
  const [bulkImporting, setBulkImporting] = useState(false);
  const [micPreflightChecking, setMicPreflightChecking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const liveActiveVoiceRef = useRef<LiveActiveVoiceMeter | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);

  const currentLine = lines[cur];
  const recordedCount = statuses.filter((s) => s === "pass").length;
  const draftCount = statuses.filter((s) => s === "draft").length;
  const enrolling = statuses.some((s) => s === "processing") || bulkImporting;
  const busy = enrolling || micPreflightChecking;

  const showMessage = useCallback((text: string, kind: NoticeKind = "error") => {
    setMessageKind(kind);
    setMessage(text);
  }, []);

  // Phoneme coverage sidecar — deterministic, text-derived from the transcripts
  // of the lines passed so far (honest: which phonemes the recorded lines
  // CONTAIN; NOT audio-verified pronunciation — the A–D grade is that signal).
  const coverage = useMemo(() => {
    const recorded = lines.filter((_, i) => statuses[i] === "pass").map((l) => l.text);
    return coverageFromTexts(recorded);
  }, [lines, statuses]);
  const coveredInitials = useMemo(() => new Set<Initial>(coverage.initials), [coverage]);
  const coveredFinals = useMemo(() => new Set<Final>(coverage.finals), [coverage]);
  const coveredTones = useMemo(() => new Set<Tone>(coverage.tones), [coverage]);
  // Phonemes in the current line — ringed as "recent" in the grid.
  const active = useMemo(
    () => (currentLine ? phonemesInText(currentLine.text) : phonemesInText("")),
    [currentLine],
  );

  const clearTimers = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (autoStopRef.current) window.clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
  }, []);

  const stopLiveActiveVoiceMeter = useCallback((resetState = true) => {
    const meter = liveActiveVoiceRef.current;
    liveActiveVoiceRef.current = null;
    try {
      meter?.source.disconnect();
    } catch {
      // Best effort only; closing the AudioContext releases the stream tap.
    }
    if (meter && typeof meter.context.close === "function") {
      void meter.context.close().catch(() => undefined);
    }
    if (resetState) setLiveActiveVoiceAvailable(false);
  }, []);

  const updateLiveActiveVoiceMeter = useCallback((now: number): number | null => {
    const meter = liveActiveVoiceRef.current;
    if (!meter) return null;
    const deltaSec = Math.max(0, (now - meter.lastSampleAt) / 1000);
    meter.lastSampleAt = now;
    meter.analyser.getFloatTimeDomainData(meter.buffer);
    if (rmsFromFloatBuffer(meter.buffer) >= LIVE_ACTIVE_VOICE_RMS_THRESHOLD) {
      meter.activeVoiceSec += deltaSec;
    }
    setActiveVoiceElapsed(meter.activeVoiceSec);
    return meter.activeVoiceSec;
  }, []);

  const stopRecording = useCallback(() => {
    clearTimers();
    setRecording(false);
    stopLiveActiveVoiceMeter();
    recorderRef.current?.stop();
    recorderRef.current = null;
    recordingStartedAtRef.current = null;
  }, [clearTimers, stopLiveActiveVoiceMeter]);

  const setStatus = useCallback((index: number, status: LineStatus) => {
    setStatuses((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  }, []);

  const markLineDraft = useCallback((lineIndex: number) => {
    setStatuses((prev) => {
      const next = [...prev];
      next[lineIndex] = "draft";
      const nextTodo = firstRecordableLineIndex(next);
      if (nextTodo >= 0 && nextTodo !== lineIndex) setCur(nextTodo);
      return next;
    });
  }, []);

  const enrollClip = useCallback(
    async (file: File, lineIndex: number, captureSettings: BrowserCaptureSettings | null) => {
      setStatus(lineIndex, "processing");
      const form = new FormData();
      form.set("voice", file);
      form.set("promptTranscript", lines[lineIndex].text);
      form.set("sourceKind", "scripted");
      form.set("voiceProfileId", profileId);
      form.set("consent", "yes");
      if (captureSettings) form.set("browserCaptureSettings", JSON.stringify(captureSettings));
      try {
        const response = await fetch("/api/voice-profile/enroll", { method: "POST", body: form });
        const payload = (await response.json()) as EnrollPayload;
        if (!response.ok || payload.status !== "enrolled") {
          markLineDraft(lineIndex);
          showMessage(payload.message ? `${payload.message} · ${t("build.rec.draftSaved")}` : t("build.rec.draftSaved"));
          await updateBrowserRecordingDraft({
            profileId,
            pack,
            lineIndex,
            patch: { enrollmentStatus: "error", enrollmentMessage: payload.message || t("build.rec.draftSaved") },
          });
          return;
        }
        onEnrolled();
        const passing = new Set(payload.profile?.requirements?.passingGrades ?? ["A", "B"]);
        const grade = payload.referenceQuality?.grade;
        if (grade && !passing.has(grade)) {
          setStatus(lineIndex, lineStatusFromGrade(grade));
          showMessage(rejectionMessage(t, payload.referenceQuality));
          await updateBrowserRecordingDraft({
            profileId,
            pack,
            lineIndex,
            patch: { enrollmentStatus: "rejected", enrollmentMessage: rejectionMessage(t, payload.referenceQuality) },
          });
          return;
        }
        setStatuses((prev) => {
          const next = [...prev];
          next[lineIndex] = "pass";
          const nextTodo = firstRecordableLineIndex(next);
          if (nextTodo >= 0) setCur(nextTodo);
          return next;
        });
        showMessage("", "neutral");
        await updateBrowserRecordingDraft({
          profileId,
          pack,
          lineIndex,
          patch: { enrollmentStatus: "submitted", enrollmentMessage: undefined },
        });
      } catch {
        markLineDraft(lineIndex);
        showMessage(t("build.rec.draftSaved"));
        await updateBrowserRecordingDraft({
          profileId,
          pack,
          lineIndex,
          patch: { enrollmentStatus: "error", enrollmentMessage: t("build.rec.draftSaved") },
        });
      }
    },
    [lines, profileId, pack, t, onEnrolled, setStatus, markLineDraft, showMessage],
  );

  const submitDraft = useCallback(
    async (lineIndex: number) => {
      const draft = drafts[lineIndex] ?? await loadBrowserRecordingDraft(profileId, pack, lineIndex);
      if (!draft) {
        showMessage(t("build.rec.draftMissingAudio"));
        return;
      }
      const evidenceError = draftEvidenceError(t, draft);
      if (evidenceError) {
        showMessage(evidenceError);
        return;
      }
      const file = fileFromDraft(draft);
      if (!file) {
        showMessage(t("build.rec.draftMissingAudio"));
        return;
      }
      setDrafts((prev) => ({ ...prev, [lineIndex]: draft }));
      await enrollClip(file, lineIndex, draft.captureSettings);
    },
    [drafts, profileId, pack, enrollClip, t, showMessage],
  );

  const importSavedDrafts = useCallback(async () => {
    if (recording || bulkImporting) return;
    const draftIndexes = statuses
      .map((status, lineIndex) => ({ status, lineIndex }))
      .filter((row) => row.status === "draft")
      .map((row) => row.lineIndex);
    if (draftIndexes.length === 0) {
      showMessage(t("build.rec.importDraftsBlocked"));
      return;
    }

    const nextDrafts = { ...drafts };
    const importRows: VoiceProfileDraftImportClip[] = [];
    const importedIndexes: number[] = [];
    for (const lineIndex of draftIndexes) {
      const draft = nextDrafts[lineIndex] ?? await loadBrowserRecordingDraft(profileId, pack, lineIndex);
      if (!draft) {
        setCur(lineIndex);
        showMessage(t("build.rec.draftMissingAudio"));
        return;
      }
      const evidenceError = draftEvidenceError(t, draft);
      if (evidenceError) {
        setCur(lineIndex);
        showMessage(evidenceError);
        return;
      }
      const file = fileFromDraft(draft);
      if (!file) {
        setCur(lineIndex);
        showMessage(t("build.rec.draftMissingAudio"));
        return;
      }
      nextDrafts[lineIndex] = draft;
      importRows.push({
        lineIndex,
        transcript: lines[lineIndex].text,
        file,
        captureSettings: draft.captureSettings,
      });
      importedIndexes.push(lineIndex);
      if (importRows.length >= MAX_DRAFT_IMPORT_BATCH) break;
    }

    if (importRows.length === 0) {
      showMessage(t("build.rec.importDraftsBlocked"));
      return;
    }

    setDrafts(nextDrafts);
    setBulkImporting(true);
    setStatuses((prev) => {
      const next = [...prev];
      for (const lineIndex of importedIndexes) next[lineIndex] = "processing";
      return next;
    });
    showMessage(t("build.rec.importingDrafts", { n: String(importRows.length) }), "neutral");

    try {
      const result = await importVoiceProfileDraftClips({ profileId, clips: importRows });
      if (!result.ok) throw new Error(result.message || t("build.rec.importDraftsFailed"));
      await refreshVoiceProfileProofChain(profileId);
      const profile = await fetchVoiceProfileDetail(profileId) ?? result.profile ?? null;
      const refreshedStatuses = lineStatusesFromProfileDetail(pack, profile);

      await Promise.all(importedIndexes.map((lineIndex) => deleteBrowserRecordingDraft(profileId, pack, lineIndex)));
      setDrafts((prev) => {
        const next = { ...prev };
        for (const lineIndex of importedIndexes) delete next[lineIndex];
        return next;
      });
      setStatuses((prev) => {
        const next = refreshedStatuses ? [...refreshedStatuses] : [...prev];
        const importedIndexSet = new Set(importedIndexes);
        for (const lineIndex of draftIndexes) {
          if (!importedIndexSet.has(lineIndex)) next[lineIndex] = "draft";
        }
        for (const lineIndex of importedIndexes) {
          if (!refreshedStatuses) next[lineIndex] = "todo";
        }
        const nextTodo = firstRecordableLineIndex(next);
        if (nextTodo >= 0) setCur(nextTodo);
        return next;
      });
      showMessage(
        t("build.rec.importDraftsImported", { n: String(result.imported || importRows.length) }),
        "success",
      );
      onEnrolled();
    } catch (error) {
      setStatuses((prev) => {
        const next = [...prev];
        for (const lineIndex of importedIndexes) next[lineIndex] = "draft";
        return next;
      });
      const errorMessage = error instanceof Error && error.message ? error.message : t("build.rec.importDraftsFailed");
      showMessage(`${errorMessage} · ${t("build.rec.draftSaved")}`);
    } finally {
      setBulkImporting(false);
    }
  }, [
    recording,
    bulkImporting,
    statuses,
    drafts,
    profileId,
    pack,
    lines,
    t,
    showMessage,
    onEnrolled,
  ]);

  const runMicPreflight = useCallback(async () => {
    if (recording || busy) return;
    setMicPreflightChecking(true);
    showMessage(t("build.rec.micPreflightChecking"), "neutral");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
      const captureSettings = browserCaptureSettings(stream);
      setCaptureSettingsNotice(captureSettingsSummary(t, captureSettings));
      stream.getTracks().forEach((tr) => tr.stop());
      stream = null;
      const captureError = captureSettingsError(t, captureSettings);
      if (captureError) {
        showMessage(captureError, "error");
        return;
      }
      showMessage(
        t("build.rec.micPreflightOk", { settings: captureSettingsSummary(t, captureSettings) }),
        "success",
      );
    } catch {
      showMessage(t("build.rec.micBlocked"));
    } finally {
      stream?.getTracks().forEach((tr) => tr.stop());
      setMicPreflightChecking(false);
    }
  }, [recording, busy, t, showMessage]);

  useEffect(() => {
    let canceled = false;
    void loadBrowserRecordingDrafts(profileId, pack).then((loaded) => {
      if (canceled) return;
      const byIndex: Record<number, BrowserRecordingDraft> = {};
      for (const draft of loaded) byIndex[draft.lineIndex] = draft;
      setDrafts(byIndex);
      setStatuses((prev) => {
        const next = [...prev];
        for (const draft of loaded) {
          if (next[draft.lineIndex] === "todo") next[draft.lineIndex] = "draft";
        }
        const nextTodo = firstRecordableLineIndex(next);
        if (nextTodo >= 0) setCur(nextTodo);
        return next;
      });
    });
    return () => {
      canceled = true;
    };
  }, [profileId, pack]);

  const startRecording = useCallback(async () => {
    showMessage("", "neutral");
    setCaptureSettingsNotice("");
    if (simplifiedOrMixedChineseScriptErrors(currentLine.text).length > 0) {
      showMessage(t("build.rec.scriptBlocked"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
    } catch {
      showMessage(t("build.rec.micBlocked"));
      return;
    }
    // Reject browser-side AGC/NS/echo — they degrade enrollment quality.
    const captureSettings = browserCaptureSettings(stream);
    const captureSummary = captureSettingsSummary(t, captureSettings);
    setCaptureSettingsNotice(captureSummary);
    const captureError = captureSettingsError(t, captureSettings);
    if (captureError) {
      stream.getTracks().forEach((tr) => tr.stop());
      showMessage(captureError);
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, supportedRecorderOptions());
    const lineIndex = cur;
    const startedAt = Date.now();
    recordingStartedAtRef.current = startedAt;
    const liveMeter = startLiveActiveVoiceMeter(stream, startedAt);
    liveActiveVoiceRef.current = liveMeter;
    setActiveVoiceElapsed(0);
    setLiveActiveVoiceAvailable(Boolean(liveMeter));
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const file = createRecordedFile(chunksRef.current, recorder.mimeType, Date.now());
      const durationSec = (Date.now() - startedAt) / 1000;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
      void (async () => {
        const activeVoiceSec = await estimateBrowserActiveVoiceSec(file);
        const draft = await saveBrowserRecordingDraft({
          profileId,
          pack,
          lineIndex,
          transcript: lines[lineIndex].text,
          file,
          durationSec,
          activeVoiceSec,
          captureSettings,
        });
        setDrafts((prev) => ({ ...prev, [lineIndex]: draft }));
        const durationError = draftDurationError(t, draft);
        if (durationError) {
          markLineDraft(lineIndex);
          showMessage(`${durationError} · ${t("build.rec.draftSaved")}`);
          return;
        }
        await enrollClip(file, lineIndex, captureSettings);
      })();
    };
    recorder.start();
    setStatus(lineIndex, "recording");
    setRecording(true);
    setElapsed(0);
    timerRef.current = window.setInterval(() => {
      const now = Date.now();
      setElapsed((now - startedAt) / 1000);
      updateLiveActiveVoiceMeter(now);
    }, 100);
    // Hard ceiling so a clip never exceeds the gate.
    autoStopRef.current = window.setTimeout(() => stopRecording(), REC_MAX_SEC * 1000);
  }, [
    cur,
    currentLine,
    enrollClip,
    lines,
    markLineDraft,
    pack,
    profileId,
    t,
    setStatus,
    stopRecording,
    showMessage,
    updateLiveActiveVoiceMeter,
  ]);

  const toggleRecord = useCallback(() => {
    if (busy) return;
    if (recording) {
      const now = Date.now();
      const liveActiveVoiceSec = updateLiveActiveVoiceMeter(now) ?? activeVoiceElapsed;
      const currentElapsed = recordingStartedAtRef.current === null
        ? elapsed
        : Math.max(elapsed, (now - recordingStartedAtRef.current) / 1000);
      // Don't let the user stop below the gate floor — the #1 cause of
      // "clean but rejected" clips. Surface the live target instead.
      if (currentElapsed < REC_MIN_SEC) {
        showMessage(t("build.rec.keepGoing"));
        return;
      }
      if (liveActiveVoiceAvailable && liveActiveVoiceSec < REC_MIN_ACTIVE_VOICE_SEC) {
        showMessage(t("build.rec.keepVoiceGoing", { min: REC_MIN_ACTIVE_VOICE_SEC.toFixed(1) }));
        return;
      }
      stopRecording();
    } else {
      void startRecording();
    }
  }, [
    busy,
    recording,
    elapsed,
    activeVoiceElapsed,
    liveActiveVoiceAvailable,
    startRecording,
    stopRecording,
    t,
    showMessage,
    updateLiveActiveVoiceMeter,
  ]);

  // "Space to stop" keyboard shortcut while recording.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (!recording && !enrolling) return;
      e.preventDefault();
      toggleRecord();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, enrolling, toggleRecord]);

  // Clear timers + tracks on unmount mid-take.
  useEffect(() => {
    return () => {
      clearTimers();
      stopLiveActiveVoiceMeter(false);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [clearTimers, stopLiveActiveVoiceMeter]);

  function redoLine(index: number) {
    if (recording || busy) return;
    setStatus(index, "todo");
    setCur(index);
    showMessage("", "neutral");
  }

  function pickLine(index: number) {
    if (recording || busy) return;
    setCur(index);
  }

  const elapsedLabel = `${Math.floor(elapsed)}s`;
  const activeVoiceLabel = activeVoiceElapsed.toFixed(1);
  const activeVoiceReady = !liveActiveVoiceAvailable || activeVoiceElapsed >= REC_MIN_ACTIVE_VOICE_SEC;
  const stopReady = !recording || (elapsed >= REC_MIN_SEC && activeVoiceReady);

  return (
    <div className="build-rec-grid">
      <div>
        <div className="rec-stage">
          <div className="row between" style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ margin: 0 }}>
              {t("build.rec.eyebrow", { n: cur + 1, total: BUILD_LINE_COUNT })}
            </div>
            <div className="row gap-8" style={{ color: "var(--color-on-dark-soft)", fontSize: 13 }}>
              <span className="kbd">{t("build.rec.spaceKey")}</span>
              <span>{t("build.rec.stopHint")}</span>
            </div>
          </div>

          <div className="rec-line">{currentLine.text}</div>

          {currentLine.cues.length > 0 && (
            <div className="row gap-8" style={{ flexWrap: "wrap", marginBottom: 18 }}>
              <span className="small" style={{ color: "var(--color-on-dark-soft)" }}>
                {t("build.rec.cue")}:
              </span>
              {currentLine.cues.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          )}

          <LiveWaveform active={recording} bars={80} height={88} />

          <div className="rec-controls">
            <div className="row gap-16">
              <button
                type="button"
                className={"rec-btn" + (recording ? " recording" : "")}
                onClick={toggleRecord}
                disabled={busy || !stopReady}
                aria-label={recording ? t("build.rec.stopHint") : t("build.rec.start")}
              >
                {recording ? <IcSquare size={22} /> : <IcMic size={22} />}
              </button>
              <div>
                <div className="rec-timer">
                  {recording ? elapsedLabel : "0s"} · {t("build.rec.timerHint")}
                  {recording && liveActiveVoiceAvailable
                    ? ` · ${t("build.rec.activeVoiceMeter", {
                        sec: activeVoiceLabel,
                        min: REC_MIN_ACTIVE_VOICE_SEC.toFixed(1),
                      })}`
                    : ""}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-on-dark-soft)", marginTop: 4 }}>
                  {micPreflightChecking
                    ? t("build.rec.micPreflightChecking")
                    : enrolling
                      ? t("build.rec.processing")
                      : recording
                        ? elapsed < REC_MIN_SEC
                          ? t("build.rec.coach")
                          : activeVoiceReady
                            ? t("build.rec.readyToStop")
                            : t("build.rec.activeVoiceCoach")
                        : t("build.rec.coach")}
                </div>
                {captureSettingsNotice && (
                  <div style={{ fontSize: 12, color: "var(--color-on-dark-soft)", marginTop: 4 }}>
                    {t("build.rec.captureSettingsLine", { settings: captureSettingsNotice })}
                  </div>
                )}
              </div>
            </div>
            <div className="row gap-8">
              <button type="button" className="dark-link-btn" onClick={() => redoLine(cur)} disabled={recording || busy}>
                <IcRotate size={14} /> {t("build.rec.redo")}
              </button>
              <button type="button" className="dark-link-btn" onClick={() => void runMicPreflight()} disabled={recording || busy}>
                <IcMic size={14} /> {micPreflightChecking ? t("build.rec.micPreflightCheckingShort") : t("build.rec.micPreflight")}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" style={{ color: "#fff" }} onClick={onClose}>
                <IcChevronLeft size={14} /> {t("build.recording.back")}
              </button>
            </div>
          </div>
        </div>

        {message && (
          <p className={`notice notice--${messageKind}`} style={{ marginTop: 16 }}>
            {message}
          </p>
        )}

        {/* Lines list — each row's status dot is the analyzer's grade verdict. */}
        <div className="mt-32">
          <div className="row between" style={{ alignItems: "center" }}>
            <span className="player-eyebrow" style={{ color: "var(--color-muted)" }}>
              {t("build.lines.progress", { n: recordedCount, total: BUILD_LINE_COUNT })}
              {draftCount > 0 ? ` · ${t("build.lines.drafts", { n: String(draftCount) })}` : ""}
            </span>
            <div className="row gap-16">
              {draftCount > 0 && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    void importSavedDrafts();
                  }}
                  disabled={recording || busy}
                  title={t("build.rec.importDrafts")}
                >
                  <IcUpload size={14} /> {bulkImporting ? t("build.rec.importingDraftsShort") : t("build.rec.importDrafts")}
                </button>
              )}
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot pass" /> {t("build.lines.legend.pass")}
              </span>
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot retry" /> {t("build.lines.legend.retry")}
              </span>
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot draft" /> {t("build.lines.legend.draft")}
              </span>
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot todo" /> {t("build.lines.legend.todo")}
              </span>
            </div>
          </div>
          <div className="lines-list">
            {lines.map((line, i) => {
              const st = statuses[i];
              const dotClass = st === "processing" ? "recording" : st;
              const stLabel =
                st === "pass"
                  ? t("build.lines.st.pass")
                  : st === "retry"
                    ? t("build.lines.st.retry")
                    : st === "draft"
                      ? t("build.lines.st.draft")
                      : st === "recording"
                        ? t("build.lines.st.recording")
                        : st === "processing"
                          ? t("build.lines.st.processing")
                          : t("build.lines.st.todo");
              return (
                <div
                  key={line.n}
                  className={"line-row" + (i === cur ? " active" : "")}
                  onClick={() => pickLine(i)}
                >
                  <div className="row gap-12" style={{ alignItems: "center" }}>
                    <span className="line-num">{String(line.n).padStart(2, "0")}</span>
                    <span className={`line-status-dot ${dotClass}`} />
                  </div>
                  <div className="line-text">{line.text}</div>
                  <div className="line-actions">
                    {(st === "pass" || st === "retry" || st === "draft") && (
                      <MiniWaveform
                        seed={line.n * 137}
                        text={line.text}
                        bars={28}
                        height={20}
                        color={st === "retry" ? "var(--color-warning)" : st === "draft" ? "var(--color-primary)" : "var(--color-muted-soft)"}
                      />
                    )}
                    <span className="line-meta">{stLabel}</span>
                    {st === "draft" && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={t("build.rec.submitDraft")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void submitDraft(i);
                        }}
                      >
                        <IcUpload size={14} />
                      </button>
                    )}
                    {(st === "pass" || st === "retry") && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={t("build.rec.redo")}
                        onClick={(e) => {
                          e.stopPropagation();
                          redoLine(i);
                        }}
                      >
                        <IcRotate size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Phoneme coverage sidecar — real Mandarin inventory, text-derived from
          the recorded lines' transcripts (see lib/mandarin-phonemes.ts). */}
      <aside className="card-dark coverage-sidecar">
        <div className="row between" style={{ marginBottom: 12 }}>
          <span className="player-eyebrow">{t("build.coverage.title")}</span>
          <span className="player-time">
            {coverage.covered} / {coverage.total}
          </span>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.initials")}</span>
          <div className="phoneme-row">
            {INITIALS.map((p) => (
              <span
                key={`i-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredInitials.has(p) ? " covered-3" : "") +
                  (active.initials.has(p) ? " recent" : "")
                }
              >
                {p}
              </span>
            ))}
          </div>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.finals")}</span>
          <div className="phoneme-row">
            {FINALS.map((p) => (
              <span
                key={`f-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredFinals.has(p) ? " covered-3" : "") +
                  (active.finals.has(p) ? " recent" : "")
                }
              >
                {p === "i_" ? "ɿ" : p}
              </span>
            ))}
          </div>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.tones")}</span>
          <div className="phoneme-row">
            {TONES.map((p) => (
              <span
                key={`t-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredTones.has(p) ? " covered-3" : "") +
                  (active.tones.has(p) ? " recent" : "")
                }
              >
                {p === "neutral" ? "·" : p}
              </span>
            ))}
          </div>
        </div>

        <p className="small" style={{ color: "var(--color-on-dark-soft)", marginTop: 12 }}>
          {t("build.coverage.note")}
        </p>
        <div className="row gap-16 mt-16">
          <div className="row gap-6" style={{ color: "var(--color-on-dark-soft)", fontSize: 12 }}>
            <span className="phoneme-cell covered-3" style={{ width: 14, height: 14 }} />{" "}
            {t("build.coverage.legend.covered")}
          </div>
          <div className="row gap-6" style={{ color: "var(--color-on-dark-soft)", fontSize: 12 }}>
            <span className="phoneme-cell" style={{ width: 14, height: 14 }} /> {t("build.coverage.legend.missing")}
          </div>
        </div>
      </aside>
    </div>
  );
}

export function BuildTab({
  activeProfile,
  onRefresh,
  onChangeTab,
  onDeleted,
}: {
  activeProfile: ProfileListItem | undefined;
  onRefresh: () => void;
  onChangeTab: (t: "generate") => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const lang: Lang = useLang();
  const pack: BuildScriptLocale = lang === "zh" ? "zh-Hant" : "en";
  const [recording, setRecording] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  // Show the legacy YouTube/upload kit as a fallback disclosure under empty.
  const [showFallback, setShowFallback] = useState(false);
  const [goalAuditState, setGoalAuditState] = useState<{
    profileId: string;
    audit: VoiceCloneGoalAuditSummary | null;
  } | null>(null);
  const [profileDetailState, setProfileDetailState] = useState<{
    profileId: string;
    profile: VoiceProfileDetail | null;
  } | null>(null);

  const derived = deriveState(activeProfile);
  const state: BuildState = recording ? "recording" : derived;
  const clipCount = activeProfile?.clipCount ?? 0;

  useEffect(() => {
    const profileId = activeProfile?.id;
    if (!profileId) return;
    let canceled = false;
    void fetchVoiceCloneGoalAudit(profileId)
      .then((audit) => {
        if (!canceled) setGoalAuditState({ profileId, audit });
      });
    return () => {
      canceled = true;
    };
  }, [activeProfile?.id, activeProfile?.hash]);
  const goalAudit = goalAuditState && goalAuditState.profileId === activeProfile?.id ? goalAuditState.audit : null;

  useEffect(() => {
    const profileId = activeProfile?.id;
    if (!profileId) return;
    let canceled = false;
    void fetchVoiceProfileDetail(profileId).then((profile) => {
      if (!canceled) setProfileDetailState({ profileId, profile });
    });
    return () => {
      canceled = true;
    };
  }, [activeProfile?.id, activeProfile?.hash]);
  const profileDetail =
    profileDetailState && profileDetailState.profileId === activeProfile?.id ? profileDetailState.profile : null;

  const scriptPlan = useMemo(() => {
    if (!profileDetail) return null;
    return buildProfileScriptPlan({
      scripts: BUILD_SCRIPT_PACK[pack].map((line) => line.text),
      acceptedClips: profileDetail.clips ?? [],
      rejectedClips: profileDetail.rejectedClips ?? [],
      missingCoverageFeatures: coverageFeatureList(profileDetail.diagnostics?.missingCoverageFeatures),
    });
  }, [pack, profileDetail]);

  // Seed per-line statuses for the recording stage from real per-script profile
  // evidence. Fallback to aggregate count only while the detail manifest is not
  // available, so the UI still has a useful loading/error state.
  const initialStatuses = useMemo<LineStatus[]>(() => {
    if (scriptPlan) {
      return scriptPlan.map((item) => {
        if (item.status === "accepted") return "pass";
        if (item.status === "rejected") return "retry";
        return "todo";
      });
    }
    const passed = Math.min(clipCount, BUILD_LINE_COUNT);
    return Array.from({ length: BUILD_LINE_COUNT }, (_, i) => (i < passed ? "pass" : "todo"));
  }, [clipCount, scriptPlan]);

  function startRename() {
    setDraft(activeProfile?.displayName ?? "");
    setRenaming(true);
  }
  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (!activeProfile || !name || name === activeProfile.displayName) return;
    void (async () => {
      await renameProfile(activeProfile.id, name);
      onRefresh();
    })();
  }
  function doDelete() {
    if (!activeProfile) return;
    if (typeof window !== "undefined" && !window.confirm(t("build.action.deleteConfirm"))) return;
    void (async () => {
      await deleteProfile(activeProfile.id);
      onDeleted();
    })();
  }

  if (state === "recording" && activeProfile) {
    return (
      <div className="page-inner wide">
        <div className="row between" style={{ alignItems: "center", marginBottom: 16 }}>
          <div>
            <div className="eyebrow">{t("build.eyebrow")}</div>
            <h1 className="page-title md" style={{ marginBottom: 8 }}>
              {t(titleKey("recording"))}
            </h1>
            <p className="page-lede">{t(ledeKey("recording"))}</p>
          </div>
        </div>
        <BuildRecordingStage
          key={activeProfile.id}
          profileId={activeProfile.id}
          pack={pack}
          initialStatuses={initialStatuses}
          onClose={() => {
            setRecording(false);
            onRefresh();
          }}
          onEnrolled={onRefresh}
        />
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="eyebrow">{t("build.eyebrow")}</div>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        {renaming ? (
          <input
            className="input"
            style={{ maxWidth: 420, fontSize: 28 }}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {t(titleKey(state))}
          </h1>
        )}
        {activeProfile && (
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            <button className="btn btn--ghost btn--sm" type="button" onClick={startRename}>
              <IcEdit size={14} />
              {t("build.action.rename")}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              style={{ color: "var(--color-error)" }}
              onClick={doDelete}
            >
              <IcTrash size={14} />
              {t("build.action.delete")}
            </button>
          </div>
        )}
      </div>
      <p className="page-lede" style={{ marginTop: 16 }}>
        {t(ledeKey(state))}
      </p>

      <div className="mt-32">
        {state === "empty" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="build-status-title">
                {t("build.status.empty.title", { name: activeProfile?.displayName ?? "" })}
              </div>
              <div className="build-status-sub">{t("build.status.empty.sub")}</div>
            </div>
            <div className="build-cta">
              <button
                className="btn btn--primary btn--lg"
                type="button"
                disabled={!activeProfile}
                onClick={() => setRecording(true)}
              >
                <IcMic size={16} />
                {t("build.status.empty.start")}
              </button>
            </div>
          </div>
        )}

        {state === "reviewing" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={Math.min(1, clipCount / BUILD_LINE_COUNT)}
                  size={64}
                  stroke={6}
                  color="var(--color-ink)"
                  track="var(--color-hairline)"
                  label={`${Math.min(clipCount, BUILD_LINE_COUNT)}`}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">
                    {t("build.status.reviewing.title", { n: clipCount })}
                  </div>
                  <div className="build-status-sub">{t("build.status.reviewing.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button className="btn btn--secondary" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.reviewing.pause")}
              </button>
              <button className="btn btn--primary btn--lg" type="button" onClick={() => setRecording(true)}>
                <IcMic size={16} />
                {t("build.status.reviewing.continue")}
              </button>
            </div>
          </div>
        )}

        {state === "ready" && (
          <div className="build-status ready">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={1}
                  size={64}
                  stroke={6}
                  color="#fff"
                  track="rgba(255,255,255,0.25)"
                  label={<IcCheck size={20} style={{ color: "#fff" }} />}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">{t("build.status.ready.title")}</div>
                  <div className="build-status-sub">{t("build.status.ready.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button
                className="btn btn--ghost"
                style={{ color: "#fff" }}
                type="button"
                onClick={() => onChangeTab("generate")}
              >
                {t("build.status.ready.listen")}
              </button>
              <button className="btn btn--secondary btn--lg" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.ready.generate")}
                <IcChevron size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {activeProfile && <GoalAuditPanel audit={goalAudit} profileId={activeProfile.id} />}

      {state === "empty" && (
        <div className="empty-zone mt-48">
          <div className="ill">
            <IcMic size={24} />
          </div>
          <h3>{t("build.empty.title")}</h3>
          <p>{t("build.empty.sub")}</p>
          <div className="row gap-12 mt-8">
            <button className="btn btn--primary" type="button" disabled={!activeProfile} onClick={() => setRecording(true)}>
              <IcMic size={14} />
              {t("build.empty.record")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setShowFallback((v) => !v)}>
              <IcYoutube size={14} />
              {t("build.empty.youtube")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setShowFallback((v) => !v)}>
              <IcUpload size={14} />
              {t("build.empty.upload")}
            </button>
          </div>
        </div>
      )}

      {(state === "reviewing" || state === "ready") && (
        <div className="mt-32">
          <span className="player-eyebrow" style={{ color: "var(--color-muted)" }}>
            {t("build.lines.usable", { n: clipCount })}
          </span>
        </div>
      )}

      {/* YouTube / upload import remains available as a fallback via the legacy
          kit — it owns its own profile selection + import flow. */}
      {showFallback && (
        <div className="legacy-tab-slot mt-32">
          <VoiceCloneStudio />
        </div>
      )}
      <span aria-hidden style={{ display: "none" }}>
        {lang}
      </span>
    </div>
  );
}

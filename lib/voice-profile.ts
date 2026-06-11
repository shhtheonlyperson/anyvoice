import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runsRoot, type CloneEnv } from "@/lib/clone-config";
import {
  detectChineseScript,
  detectPronunciationPresetIds,
  detectVoiceProfileCoverageFeatures,
  REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  strictTraditionalChineseScriptErrors,
  type DetectedChineseScript,
  type VoiceProfileCoverageFeature,
} from "@/lib/text-prep";

export type VoiceProfileStatus = "ready" | "needs_enrollment";

export interface VoiceProfileRequirements {
  minClips: number;
  maxClips: number;
  minDurationSec: number;
  maxDurationSec: number;
  passingGrades: string[];
  requiredCoverageFeatures: VoiceProfileCoverageFeature[];
  requiredPronunciationPresetIds?: string[];
}

export interface VoiceProfileClip {
  sourceRunId: string;
  voiceProfileId?: string;
  recordingKitClipId?: string;
  audioPath: string;
  transcriptRaw: string;
  targetText: string;
  quality: {
    grade: string;
    durationSec: number;
    snrDb: number | null;
    clippingRatio: number;
    vadActiveRatio: number;
    warnings: string[];
  };
  transcriptScript: DetectedChineseScript;
  coverageFeatures: VoiceProfileCoverageFeature[];
  pronunciationPresetIds?: string[];
  sourceKind?: string;
  modelId?: string;
  cloneMode?: string | null;
  createdFromOutput?: string | null;
}

export interface VoiceProfileClipSelection {
  clip: VoiceProfileClip;
  targetCoverageFeatures: VoiceProfileCoverageFeature[];
  matchedCoverageFeatures: VoiceProfileCoverageFeature[];
  targetPronunciationPresetIds: string[];
  matchedPronunciationPresetIds: string[];
}

export interface RejectedVoiceProfileClip extends VoiceProfileClip {
  reasons: string[];
}

export interface VoiceProfileDiagnostics {
  eligibleTranscriptScripts: Array<{ script: DetectedChineseScript; count: number }>;
  coverageFeatures: Array<{ feature: VoiceProfileCoverageFeature; count: number }>;
  missingCoverageFeatures: VoiceProfileCoverageFeature[];
  pronunciationPresetIds?: Array<{ presetId: string; count: number }>;
  missingPronunciationPresetIds?: string[];
  selectedGrades: Array<{ grade: string; count: number }>;
  rejectionReasons: Array<{ reason: string; count: number }>;
  topRejectedClips: Array<{
    sourceRunId: string;
    grade: string;
    durationSec: number;
    reasons: string[];
  }>;
}

export interface VoiceProfilePreferredBackend {
  version: 1;
  status: "accepted";
  profileJson: string;
  voiceProfileId: string;
  profileSha256: string;
  backend: string;
  baselineBackend: string;
  selectedAt?: string;
  selectionJson: string;
  selectionSha256: string;
  scoreJson: string;
  scoreSha256: string;
  reviewJson: string;
  reviewSha256: string;
  sourceReport: string;
  sourceReportSha256: string;
  pairedSummary?: unknown;
  candidate?: unknown;
  subjectiveReview?: unknown;
}

export interface VoiceProfileLoraAdapter {
  version: 1;
  status: "accepted";
  appliedAt?: string;
  profileJson: string;
  voiceProfileId: string;
  profileSha256: string;
  path: string;
  bytes: number;
  sha256: string;
  adapterProofJson: string;
  adapterProofSha256: string;
  qualityGateJson: string;
  qualityGateSha256: string;
  trainConfig: string;
  trainConfigSha256: string;
  qualityGateProof?: unknown;
}

export interface VoiceProfileSummary {
  version: 1;
  voiceProfileId: string;
  status: VoiceProfileStatus;
  /**
   * True when the voice has at least one passing (A/B) reference clip — enough
   * to clone zero-shot and unlock Generate. Computed independent of the
   * requirement tier for ALL profiles (incl. local-default).
   */
  usable: boolean;
  /**
   * True when the voice meets the full strict curated requirements
   * (today's "ready"). Always evaluated against DEFAULT_REQUIREMENTS.
   */
  studioGrade: boolean;
  createdAt?: string;
  requirements: VoiceProfileRequirements;
  summary: {
    eligibleClips: number;
    selectedClips: number;
    rejectedClips: number;
    remainingClipsNeeded: number;
  };
  preferredPromptClipId: string | null;
  referenceClipIds: string[];
  diagnostics: VoiceProfileDiagnostics;
  loraPath?: string | null;
  loraAdapter?: VoiceProfileLoraAdapter;
  preferredBackend?: VoiceProfilePreferredBackend;
  clips: VoiceProfileClip[];
  rejectedClips: RejectedVoiceProfileClip[];
}

const PASSING_GRADES = new Set(["A", "B"]);
const REQUIRED_COVERAGE_FEATURES: VoiceProfileCoverageFeature[] = [
  "zh_hant",
  "numbers_dates",
  "latin_terms",
  "polyphones",
  "punctuation_rhythm",
];

const DEFAULT_REQUIREMENTS: VoiceProfileRequirements = {
  minClips: 5,
  maxClips: 8,
  minDurationSec: 6,
  maxDurationSec: 20,
  passingGrades: [...PASSING_GRADES].sort(),
  requiredCoverageFeatures: REQUIRED_COVERAGE_FEATURES,
  requiredPronunciationPresetIds: [...REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS],
};

// Imported/cloned voices (YouTube, uploads — any non-default profile) can't be
// expected to recite the curated coverage script (specific polyphones, the
// "AnyVoice" brand word, etc.). Zero-shot cloning only needs one solid A/B
// reference clip, so imported profiles use this lighter bar.
const IMPORTED_PROFILE_REQUIREMENTS: VoiceProfileRequirements = {
  minClips: 1,
  maxClips: 10,
  minDurationSec: 6,
  maxDurationSec: 20,
  passingGrades: [...PASSING_GRADES].sort(),
  requiredCoverageFeatures: [],
  requiredPronunciationPresetIds: [],
};

/** Strict bar for the curated self-recorded default voice; lighter for imports. */
export function requirementsForProfile(profileId: string): VoiceProfileRequirements {
  const normalized = profileId.trim() || DEFAULT_VOICE_PROFILE_ID;
  return normalized === DEFAULT_VOICE_PROFILE_ID ? DEFAULT_REQUIREMENTS : IMPORTED_PROFILE_REQUIREMENTS;
}

/** The default/legacy voice profile id used when none is specified. */
export const DEFAULT_VOICE_PROFILE_ID = "local-default";

export function assertSafeProfileId(profileId: string): string {
  const normalized = profileId.trim() || DEFAULT_VOICE_PROFILE_ID;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    throw new Error("profileId must contain only letters, numbers, dash, or underscore");
  }
  return normalized;
}

export function voiceProfileRoot(env: CloneEnv = process.env): string {
  const configured = env.ANYVOICE_VOICE_PROFILE_ROOT || ".anyvoice/voices";
  if (path.isAbsolute(configured)) return configured;
  if (env.VERCEL) return path.join(os.tmpdir(), configured);
  return path.join(process.cwd(), configured);
}

export function voiceProfileManifestPath(profileIdInput = "local-default", env: CloneEnv = process.env): string {
  const profileId = assertSafeProfileId(profileIdInput);
  const root = voiceProfileRoot(env);
  const profileJson = path.resolve(root, profileId, "profile.json");
  const relative = path.relative(root, profileJson);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profile path must stay inside the AnyVoice profile root");
  }
  return profileJson;
}

interface MetadataFile {
  model_id?: unknown;
  clone_mode?: unknown;
  referenceQuality?: unknown;
}

interface RequestFile {
  sourceKind?: unknown;
  referenceSource?: unknown;
  voiceProfileId?: unknown;
  recordingKitClipId?: unknown;
}

/** Which profile an enrollment run was recorded for (untagged → default). */
function runProfileId(request: RequestFile | null): string {
  const raw = request?.voiceProfileId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_VOICE_PROFILE_ID;
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<MetadataFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as MetadataFile) : null;
  } catch {
    return null;
  }
}

async function readRequestJson(filePath: string): Promise<RequestFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as RequestFile) : null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function qualityFromMetadata(raw: unknown): VoiceProfileClip["quality"] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    grade: typeof obj.grade === "string" ? obj.grade.toUpperCase() : "D",
    durationSec: asNumber(obj.durationSec ?? obj.duration_sec),
    snrDb: asNullableNumber(obj.snrDb ?? obj.snr_db),
    clippingRatio: asNumber(obj.clippingRatio ?? obj.clipping_ratio),
    vadActiveRatio: asNumber(obj.vadActiveRatio ?? obj.vad_active_ratio),
    warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((v): v is string => typeof v === "string") : [],
  };
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const filePath of paths) {
    try {
      await readFile(filePath);
      return filePath;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function referenceAudioPath(runDir: string): Promise<string | null> {
  const preferred = path.join(runDir, "reference_16k_mono.wav");
  const preferredMatch = await firstExisting([preferred]);
  if (preferredMatch) return preferredMatch;

  try {
    const entries = await readdir(runDir);
    const candidate = entries
      .filter((entry) => entry.startsWith("reference.") && !entry.startsWith("reference_"))
      .sort()[0];
    return candidate ? path.join(runDir, candidate) : null;
  } catch {
    return null;
  }
}

function rejectionReasons(clip: VoiceProfileClip, requirements: VoiceProfileRequirements): string[] {
  const reasons = new Set<string>();
  for (const reason of strictTraditionalChineseScriptErrors(clip.transcriptRaw)) reasons.add(reason);
  const { quality } = clip;
  if (!PASSING_GRADES.has(quality.grade)) reasons.add(`grade_${quality.grade.toLowerCase()}`);
  if (quality.durationSec < requirements.minDurationSec) reasons.add("too_short");
  if (quality.durationSec > requirements.maxDurationSec) reasons.add("too_long");
  for (const warning of quality.warnings) reasons.add(warning);
  return [...reasons].sort();
}

function transcriptDiversityKey(text: string): string {
  const normalized = text.normalize("NFKC").toLowerCase();
  const chars = Array.from(normalized).filter((char) => /[\p{L}\p{N}]/u.test(char));
  return chars.join("") || normalized.trim();
}

function clipSortKey(clip: VoiceProfileClip): [number, number, string] {
  return [clip.quality.grade === "A" ? 0 : 1, -clip.quality.durationSec, clip.sourceRunId];
}

function compareEligibleClips(a: VoiceProfileClip, b: VoiceProfileClip): number {
  const aKey = clipSortKey(a);
  const bKey = clipSortKey(b);
  for (let index = 0; index < aKey.length; index += 1) {
    if (aKey[index] < bKey[index]) return -1;
    if (aKey[index] > bKey[index]) return 1;
  }
  return 0;
}

function enforceTranscriptDiversity(
  candidates: VoiceProfileClip[],
  rejected: RejectedVoiceProfileClip[],
): VoiceProfileClip[] {
  const groups = new Map<string, VoiceProfileClip[]>();
  for (const clip of candidates) {
    const key = transcriptDiversityKey(clip.transcriptRaw);
    const group = groups.get(key) ?? [];
    group.push(clip);
    groups.set(key, group);
  }

  const eligible: VoiceProfileClip[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(compareEligibleClips);
    const [keeper, ...duplicates] = sorted;
    if (keeper) eligible.push(keeper);
    for (const duplicate of duplicates) {
      rejected.push({ ...duplicate, reasons: ["duplicate_transcript"] });
    }
  }
  return eligible;
}

function selectProfileClips(
  eligible: VoiceProfileClip[],
  requiredCoverageFeatures: VoiceProfileCoverageFeature[],
  requiredPronunciationPresetIds: string[],
  maxClips: number,
): VoiceProfileClip[] {
  const remaining = [...eligible].sort(compareEligibleClips);
  const selected: VoiceProfileClip[] = [];
  const missing = new Set<VoiceProfileCoverageFeature>(requiredCoverageFeatures);
  const missingPresetIds = new Set(requiredPronunciationPresetIds);

  while ((missing.size > 0 || missingPresetIds.size > 0) && selected.length < maxClips) {
    const candidates = remaining.filter(
      (clip) =>
        clip.coverageFeatures.some((feature) => missing.has(feature)) ||
        pronunciationPresetIdsForClip(clip).some((presetId) => missingPresetIds.has(presetId)),
    );
    if (candidates.length === 0) break;
    const [best] = candidates.sort((a, b) => {
      const aMissingCoverage = a.coverageFeatures.filter((feature) => missing.has(feature)).length;
      const bMissingCoverage = b.coverageFeatures.filter((feature) => missing.has(feature)).length;
      const aMissingPresets = pronunciationPresetIdsForClip(a).filter((presetId) => missingPresetIds.has(presetId)).length;
      const bMissingPresets = pronunciationPresetIdsForClip(b).filter((presetId) => missingPresetIds.has(presetId)).length;
      if (aMissingPresets !== bMissingPresets) return bMissingPresets - aMissingPresets;
      if (aMissingCoverage !== bMissingCoverage) return bMissingCoverage - aMissingCoverage;
      return compareEligibleClips(a, b);
    });
    selected.push(best);
    remaining.splice(remaining.indexOf(best), 1);
    for (const feature of best.coverageFeatures) missing.delete(feature);
    for (const presetId of pronunciationPresetIdsForClip(best)) missingPresetIds.delete(presetId);
  }

  for (const clip of remaining) {
    if (selected.length >= maxClips) break;
    selected.push(clip);
  }

  return selected.sort(compareEligibleClips);
}

/**
 * True when the eligible clip set (already grade/duration-filtered) meets the
 * full strict curated requirements: enough clips plus complete coverage and
 * pronunciation-preset coverage. Used to compute `studioGrade` for ALL profiles
 * regardless of the (possibly lenient) requirement tier they were scanned with.
 *
 * Note: DEFAULT_REQUIREMENTS shares the same A/B passing grades and 6–20s
 * duration band as the imported tier, so the `eligible` set is identical and
 * can be reused directly here.
 */
function meetsStrictRequirements(eligible: VoiceProfileClip[]): boolean {
  const strictPresetIds = DEFAULT_REQUIREMENTS.requiredPronunciationPresetIds ?? [
    ...REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  ];
  const clips = selectProfileClips(
    eligible,
    DEFAULT_REQUIREMENTS.requiredCoverageFeatures,
    strictPresetIds,
    DEFAULT_REQUIREMENTS.maxClips,
  );
  if (clips.length < DEFAULT_REQUIREMENTS.minClips) return false;
  const coveredFeatures = new Set(clips.flatMap((clip) => clip.coverageFeatures));
  if (DEFAULT_REQUIREMENTS.requiredCoverageFeatures.some((feature) => !coveredFeatures.has(feature))) return false;
  const coveredPresetIds = new Set(clips.flatMap((clip) => pronunciationPresetIdsForClip(clip)));
  return !strictPresetIds.some((presetId) => !coveredPresetIds.has(presetId));
}

async function scanRun(runDir: string, runId: string): Promise<VoiceProfileClip | null> {
  const request = await readRequestJson(path.join(runDir, "request.json"));
  const referenceSource = request?.referenceSource;
  if (
    request?.sourceKind === "profile" ||
    request?.sourceKind === "sample" ||
    (referenceSource &&
      typeof referenceSource === "object" &&
      ["profile", "sample"].includes(String((referenceSource as Record<string, unknown>).kind)))
  ) {
    return null;
  }
  let requestSourceKind = "uploaded";
  if (typeof request?.sourceKind === "string" && request.sourceKind.trim()) {
    requestSourceKind = request.sourceKind.trim();
  } else if (referenceSource && typeof referenceSource === "object") {
    requestSourceKind = String((referenceSource as Record<string, unknown>).kind || "unknown");
  }

  const metadata = await readJson(path.join(runDir, "metadata.json"));
  if (!metadata) return null;
  const quality = qualityFromMetadata(metadata.referenceQuality);
  if (!quality) return null;
  const audioPath = await referenceAudioPath(runDir);
  const outputPath = await firstExisting([path.join(runDir, "output.wav")]);
  const transcriptRaw = await readOptionalText(path.join(runDir, "prompt-transcript.raw.txt")) ||
    await readOptionalText(path.join(runDir, "prompt-transcript.txt"));
  if (!audioPath || !transcriptRaw) return null;

  return {
    sourceRunId: runId,
    voiceProfileId: runProfileId(request),
    recordingKitClipId: typeof request?.recordingKitClipId === "string" ? request.recordingKitClipId : undefined,
    audioPath,
    transcriptRaw,
    transcriptScript: detectChineseScript(transcriptRaw),
    coverageFeatures: detectVoiceProfileCoverageFeatures(transcriptRaw),
    pronunciationPresetIds: detectPronunciationPresetIds(transcriptRaw),
    sourceKind: requestSourceKind,
    targetText:
      (await readOptionalText(path.join(runDir, "target.raw.txt"))) ||
      (await readOptionalText(path.join(runDir, "target.txt"))),
    quality,
    modelId: typeof metadata.model_id === "string" ? metadata.model_id : undefined,
    cloneMode: typeof metadata.clone_mode === "string" ? metadata.clone_mode : null,
    createdFromOutput: outputPath,
  };
}

function scriptScore(targetScript: DetectedChineseScript, clipScript: DetectedChineseScript): number {
  if (targetScript === clipScript) return 0;
  if (targetScript === "zh_hant" || targetScript === "zh_hans" || targetScript === "mixed_zh") {
    if (clipScript === "zh_unknown") return 1;
    if (clipScript === "zh_hant" || clipScript === "zh_hans" || clipScript === "mixed_zh") return 2;
  }
  if (targetScript === "zh_unknown") {
    if (clipScript === "zh_hant" || clipScript === "zh_hans" || clipScript === "mixed_zh") return 1;
  }
  return 3;
}

function coverageSelectionScore(
  targetCoverageFeatures: VoiceProfileCoverageFeature[],
  clipCoverageFeatures: VoiceProfileCoverageFeature[],
): { missing: number; matched: VoiceProfileCoverageFeature[] } {
  const clipFeatures = new Set(clipCoverageFeatures);
  const matched = targetCoverageFeatures.filter((feature) => clipFeatures.has(feature));
  return {
    missing: targetCoverageFeatures.length - matched.length,
    matched,
  };
}

function pronunciationPresetIdsForClip(clip: VoiceProfileClip): string[] {
  const ids = new Set<string>();
  if (Array.isArray(clip.pronunciationPresetIds)) {
    for (const presetId of clip.pronunciationPresetIds) {
      if (typeof presetId === "string" && presetId.length > 0) ids.add(presetId);
    }
  }
  for (const presetId of detectPronunciationPresetIds(clip.transcriptRaw)) ids.add(presetId);
  return [...ids];
}

function pronunciationSelectionScore(
  targetPronunciationPresetIds: string[],
  clipPronunciationPresetIds: string[],
): { missing: number; matched: string[]; priorityScore: number } {
  const clipIds = new Set(clipPronunciationPresetIds);
  const matched = targetPronunciationPresetIds.filter((presetId) => clipIds.has(presetId));
  return {
    missing: targetPronunciationPresetIds.length - matched.length,
    matched,
    priorityScore: matched.reduce((sum, presetId) => sum + targetPronunciationPresetIds.indexOf(presetId), 0),
  };
}

export function selectVoiceProfileClipForTarget(
  profile: VoiceProfileSummary,
  targetText: string,
): VoiceProfileClipSelection | null {
  // Clip selection only needs a usable voice (≥1 passing clip) — not the strict
  // studio-grade bar. `usable` may be absent on older persisted manifests, so
  // fall back to status/clip presence for backward compatibility.
  const isUsable = profile.usable ?? profile.status === "ready";
  if (!isUsable || profile.clips.length === 0) return null;
  const targetScript = detectChineseScript(targetText);
  const targetCoverageFeatures = detectVoiceProfileCoverageFeatures(targetText);
  const targetPronunciationPresetIds = detectPronunciationPresetIds(targetText);

  const selected = profile.clips
    .map((clip, index) => {
      const coverage = coverageSelectionScore(targetCoverageFeatures, clip.coverageFeatures);
      const pronunciation = pronunciationSelectionScore(
        targetPronunciationPresetIds,
        pronunciationPresetIdsForClip(clip),
      );
      return {
        clip,
        index,
        scriptScore: scriptScore(targetScript, clip.transcriptScript ?? detectChineseScript(clip.transcriptRaw)),
        pronunciationMissing: pronunciation.missing,
        pronunciationMatched: pronunciation.matched,
        coverageMissing: coverage.missing,
        coverageMatched: coverage.matched,
      };
    })
    .sort((a, b) => {
      if (a.scriptScore !== b.scriptScore) return a.scriptScore - b.scriptScore;
      if (a.pronunciationMissing !== b.pronunciationMissing) {
        return a.pronunciationMissing - b.pronunciationMissing;
      }
      if (a.pronunciationMatched.length > 0 && b.pronunciationMatched.length > 0) {
        const aPriority = a.pronunciationMatched.reduce(
          (sum, presetId) => sum + targetPronunciationPresetIds.indexOf(presetId),
          0,
        );
        const bPriority = b.pronunciationMatched.reduce(
          (sum, presetId) => sum + targetPronunciationPresetIds.indexOf(presetId),
          0,
        );
        if (aPriority !== bPriority) return aPriority - bPriority;
      }
      if (a.coverageMissing !== b.coverageMissing) return a.coverageMissing - b.coverageMissing;
      if (a.pronunciationMatched.length !== b.pronunciationMatched.length) {
        return b.pronunciationMatched.length - a.pronunciationMatched.length;
      }
      if (a.coverageMatched.length !== b.coverageMatched.length) {
        return b.coverageMatched.length - a.coverageMatched.length;
      }
      return a.index - b.index;
    })[0];

  if (!selected) return null;
  return {
    clip: selected.clip,
    targetCoverageFeatures,
    matchedCoverageFeatures: selected.coverageMatched,
    targetPronunciationPresetIds,
    matchedPronunciationPresetIds: selected.pronunciationMatched,
  };
}

export function selectVoiceProfileClip(
  profile: VoiceProfileSummary,
  targetText: string,
): VoiceProfileClip | null {
  return selectVoiceProfileClipForTarget(profile, targetText)?.clip ?? null;
}

function countBy<T extends string>(values: T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function normalizeDiagnosticReason(reason: string): string {
  if (reason === "short_clip") return "too_short";
  if (reason === "long_clip") return "too_long";
  return reason;
}

function buildDiagnostics(
  eligible: VoiceProfileClip[],
  clips: VoiceProfileClip[],
  rejected: RejectedVoiceProfileClip[],
  missingCoverageFeatures: VoiceProfileCoverageFeature[],
  missingPronunciationPresetIds: string[],
): VoiceProfileDiagnostics {
  return {
    eligibleTranscriptScripts: countBy(eligible.map((clip) => clip.transcriptScript)).map(({ value, count }) => ({
      script: value,
      count,
    })),
    coverageFeatures: countBy(clips.flatMap((clip) => clip.coverageFeatures)).map(({ value, count }) => ({
      feature: value,
      count,
    })),
    missingCoverageFeatures,
    pronunciationPresetIds: countBy(clips.flatMap((clip) => pronunciationPresetIdsForClip(clip))).map(({ value, count }) => ({
      presetId: value,
      count,
    })),
    missingPronunciationPresetIds,
    selectedGrades: countBy(clips.map((clip) => clip.quality.grade)).map(({ value, count }) => ({
      grade: value,
      count,
    })),
    rejectionReasons: countBy(
      rejected.flatMap((clip) => [...new Set(clip.reasons.map(normalizeDiagnosticReason))]),
    ).map(({ value, count }) => ({
      reason: value,
      count,
    })),
    topRejectedClips: rejected.slice(0, 5).map((clip) => ({
      sourceRunId: clip.sourceRunId,
      grade: clip.quality.grade,
      durationSec: clip.quality.durationSec,
      reasons: clip.reasons,
    })),
  };
}

export async function buildVoiceProfileSummary({
  env = process.env,
  profileId = "local-default",
  requirements,
  maxRejections = 50,
}: {
  env?: CloneEnv;
  profileId?: string;
  requirements?: VoiceProfileRequirements;
  maxRejections?: number;
} = {}): Promise<VoiceProfileSummary> {
  // Imported profiles get a lighter readiness bar than the curated default.
  requirements = requirements ?? requirementsForProfile(profileId);
  const root = runsRoot(env);
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    entries = [];
  }

  const candidates: VoiceProfileClip[] = [];
  const rejected: RejectedVoiceProfileClip[] = [];

  const wantedProfileId = profileId.trim() || DEFAULT_VOICE_PROFILE_ID;
  for (const entry of entries.sort()) {
    const runDir = path.join(root, entry);
    const clip = await scanRun(runDir, entry);
    if (!clip) continue;
    // Only consider runs recorded for the requested profile (untagged runs
    // belong to the default profile for backward compatibility).
    if ((clip.voiceProfileId ?? DEFAULT_VOICE_PROFILE_ID) !== wantedProfileId) continue;
    const reasons = rejectionReasons(clip, requirements);
    if (reasons.length > 0) rejected.push({ ...clip, reasons });
    else candidates.push(clip);
  }

  const eligible = enforceTranscriptDiversity(candidates, rejected);
  eligible.sort(compareEligibleClips);
  rejected.sort((a, b) => b.quality.durationSec - a.quality.durationSec);

  const requiredPronunciationPresetIds = requirements.requiredPronunciationPresetIds ?? [
    ...REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  ];
  const clips = selectProfileClips(
    eligible,
    requirements.requiredCoverageFeatures,
    requiredPronunciationPresetIds,
    requirements.maxClips,
  );
  const coveredFeatures = new Set(clips.flatMap((clip) => clip.coverageFeatures));
  const missingCoverageFeatures = requirements.requiredCoverageFeatures.filter((feature) => !coveredFeatures.has(feature));
  const coveredPronunciationPresetIds = new Set(clips.flatMap((clip) => pronunciationPresetIdsForClip(clip)));
  const missingPronunciationPresetIds = requiredPronunciationPresetIds.filter(
    (presetId) => !coveredPronunciationPresetIds.has(presetId),
  );
  const meetsRequestedTier =
    clips.length >= requirements.minClips &&
    missingCoverageFeatures.length === 0 &&
    missingPronunciationPresetIds.length === 0;

  // Two-status model (PRD P0.1/P0.2):
  // - `usable`: ≥1 passing (A/B) reference clip survives — enough to clone
  //   zero-shot and unlock Generate. Tier-independent for ALL profiles.
  // - `studioGrade`: meets the full strict curated bar (DEFAULT_REQUIREMENTS),
  //   always evaluated against the strict tier regardless of how this profile
  //   was scanned (imports use a lighter requirement set for their own status).
  // - `status`: whether this profile's own requirement tier is complete
  //   (strict for local-default, lighter for imports). Do not use it to gate
  //   10x/studio-grade flows; those must continue to read `studioGrade`.
  const usable = eligible.some((clip) => PASSING_GRADES.has(clip.quality.grade));
  const studioGrade = meetsStrictRequirements(eligible);

  const status: VoiceProfileStatus = meetsRequestedTier ? "ready" : "needs_enrollment";

  return {
    version: 1,
    voiceProfileId: profileId,
    status,
    usable,
    studioGrade,
    requirements,
    summary: {
      eligibleClips: eligible.length,
      selectedClips: clips.length,
      rejectedClips: rejected.length,
      remainingClipsNeeded:
        meetsRequestedTier
          ? 0
          : Math.max(
              0,
              requirements.minClips - clips.length,
              missingCoverageFeatures.length || missingPronunciationPresetIds.length ? 1 : 0,
            ),
    },
    preferredPromptClipId: clips[0]?.sourceRunId ?? null,
    referenceClipIds: clips.map((clip) => clip.sourceRunId),
    diagnostics: buildDiagnostics(eligible, clips, rejected, missingCoverageFeatures, missingPronunciationPresetIds),
    clips,
    rejectedClips: rejected.slice(0, maxRejections),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalVoiceProfileSha256(profile: Partial<VoiceProfileSummary>): string {
  const payload = { ...profile } as Record<string, unknown>;
  delete payload.createdAt;
  delete payload.loraPath;
  delete payload.loraAdapter;
  delete payload.preferredBackend;
  return createHash("sha256").update(canonicalJson(payload), "utf-8").digest("hex");
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolvePersistedPath(filePath: string, baseDir = process.cwd()): string {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function normalizeResolvedPath(filePath: string, baseDir = process.cwd()): string {
  const resolved = resolvePersistedPath(filePath, baseDir);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameResolvedPath(left: unknown, right: string, baseDir = process.cwd()): boolean {
  if (typeof left !== "string" || !left.trim()) return false;
  return normalizeResolvedPath(left, baseDir) === normalizeResolvedPath(right, baseDir);
}

function sameResolvedPathFromBases(
  left: unknown,
  leftBaseDir: string,
  right: unknown,
  rightBaseDir: string,
): boolean {
  if (typeof left !== "string" || !left.trim()) return false;
  if (typeof right !== "string" || !right.trim()) return false;
  return normalizeResolvedPath(left, leftBaseDir) === normalizeResolvedPath(right, rightBaseDir);
}

function sameEvidencePathAsPolicy(
  evidencePath: unknown,
  evidenceBaseDir: string,
  policyPath: unknown,
  policyBaseDir: string,
): boolean {
  return (
    sameResolvedPathFromBases(evidencePath, evidenceBaseDir, policyPath, policyBaseDir) ||
    sameResolvedPathFromBases(evidencePath, policyBaseDir, policyPath, policyBaseDir)
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fileMatchesSha256(rawPath: unknown, sha256: unknown, baseDir = process.cwd(), expectedBytes?: unknown): boolean {
  if (!nonEmptyString(rawPath) || !validSha256(sha256)) return false;
  const resolvedPath = resolvePersistedPath(rawPath, baseDir);
  try {
    if (typeof expectedBytes === "number" && Number.isFinite(expectedBytes)) {
      const stats = statSync(resolvedPath);
      if (stats.size !== expectedBytes) return false;
    }
    const digest = createHash("sha256").update(readFileSync(resolvedPath)).digest("hex");
    return digest === sha256;
  } catch {
    return false;
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fileDigest(rawPath: unknown, baseDir: string): { sha256: string; bytes: number } | null {
  if (!nonEmptyString(rawPath)) return null;
  const resolvedPath = resolvePersistedPath(rawPath, baseDir);
  try {
    const bytes = statSync(resolvedPath).size;
    const sha256 = createHash("sha256").update(readFileSync(resolvedPath)).digest("hex");
    return { sha256, bytes };
  } catch {
    return null;
  }
}

function readyRenderOutputsMatch(groups: unknown, evidenceDir: string): boolean {
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const renders = Array.isArray(recordObject(group).renders) ? (recordObject(group).renders as unknown[]) : [];
    for (const render of renders) {
      const renderObject = recordObject(render);
      if (renderObject.status !== "ready") continue;
      if (renderObject.outputExists !== true || renderObject.missingOutput === true) return false;
      if (typeof renderObject.outputBytes !== "number" || !Number.isFinite(renderObject.outputBytes) || renderObject.outputBytes <= 0) {
        return false;
      }
      if (!validSha256(renderObject.outputSha256)) return false;
      const actual = fileDigest(renderObject.outputWav, evidenceDir);
      if (!actual) return false;
      if (actual.bytes !== renderObject.outputBytes) return false;
      if (actual.sha256 !== renderObject.outputSha256) return false;
    }
  }
  return true;
}

function adapterProofMatchesLoraPolicy(
  loraAdapter: NonNullable<VoiceProfileSummary["loraAdapter"]>,
  baseDir = process.cwd(),
): boolean {
  if (!nonEmptyString(loraAdapter.adapterProofJson)) return false;
  const resolvedPath = resolvePersistedPath(loraAdapter.adapterProofJson, baseDir);
  try {
    const proof = JSON.parse(readFileSync(resolvedPath, "utf-8")) as Record<string, unknown>;
    const checkpoint =
      proof.checkpoint && typeof proof.checkpoint === "object" && !Array.isArray(proof.checkpoint)
        ? (proof.checkpoint as Record<string, unknown>)
        : {};
    return (
      proof.status === "pass" &&
      checkpoint.status === "readable" &&
      typeof checkpoint.loraParameterKeyCount === "number" &&
      Number.isFinite(checkpoint.loraParameterKeyCount) &&
      checkpoint.loraParameterKeyCount > 0 &&
      sameResolvedPath(proof.trainConfig, loraAdapter.trainConfig, baseDir) &&
      proof.trainConfigSha256 === loraAdapter.trainConfigSha256
    );
  } catch {
    return false;
  }
}

function qualityGateProofSummaryMatchesGate(
  loraAdapter: NonNullable<VoiceProfileSummary["loraAdapter"]>,
  gate: Record<string, unknown>,
  policyBaseDir: string,
  gateBaseDir: string,
): boolean {
  if (loraAdapter.qualityGateProof === undefined) return true;
  if (!loraAdapter.qualityGateProof || typeof loraAdapter.qualityGateProof !== "object" || Array.isArray(loraAdapter.qualityGateProof)) {
    return false;
  }
  const summary = loraAdapter.qualityGateProof as Record<string, unknown>;
  const inputs = recordObject(gate.inputs);
  const proofs = recordObject(gate.proofs);
  const speaker = recordObject(proofs.speakerBackendRequirement);
  const expectedFields: Array<[string, unknown]> = [
    ["status", gate.status],
    ["dryRun", gate.dryRun],
    ["cloneMode", inputs.cloneMode],
    ["speakerBackend", speaker.selected],
    ["requiredSpeakerBackend", speaker.required],
    ["profileVerifyRequired", proofs.profileVerifyRequired],
    ["profileVerifyPassed", proofs.profileVerifyPassed],
    ["profileVerifySkipped", proofs.profileVerifySkipped],
    ["transcriptValidationRequired", proofs.transcriptValidationRequired],
    ["transcriptValidationPassed", proofs.transcriptValidationPassed],
    ["transcriptValidationSkipped", proofs.transcriptValidationSkipped],
    ["transcriptValidationSha256", proofs.transcriptValidationSha256 ?? inputs.transcriptValidationSha256],
  ];
  if (expectedFields.some(([key, expected]) => summary[key] !== expected)) return false;

  const transcriptValidationJson = proofs.transcriptValidationJson ?? inputs.transcriptValidationJson;
  if (typeof transcriptValidationJson === "string" && transcriptValidationJson.trim()) {
    if (!sameResolvedPathFromBases(summary.transcriptValidationJson, policyBaseDir, transcriptValidationJson, gateBaseDir)) return false;
  } else if (summary.transcriptValidationJson !== transcriptValidationJson) {
    return false;
  }

  const summaryArtifacts = recordObject(summary.artifacts);
  const artifacts = recordObject(proofs.artifacts);
  for (const key of ["report", "asr", "speaker", "score"]) {
    const summaryArtifact = recordObject(summaryArtifacts[key]);
    const artifact = recordObject(artifacts[key]);
    if (typeof artifact.path === "string" && artifact.path.trim()) {
      if (!sameResolvedPathFromBases(summaryArtifact.path, policyBaseDir, artifact.path, gateBaseDir)) return false;
    } else if (summaryArtifact.path !== artifact.path) {
      return false;
    }
    if (summaryArtifact.sha256 !== artifact.sha256) return false;
  }
  return true;
}

function qualityGateMatchesLoraPolicy(
  loraAdapter: NonNullable<VoiceProfileSummary["loraAdapter"]>,
  baseDir = process.cwd(),
): boolean {
  if (!nonEmptyString(loraAdapter.qualityGateJson)) return false;
  const resolvedPath = resolvePersistedPath(loraAdapter.qualityGateJson, baseDir);
  const gateDir = path.dirname(resolvedPath);
  try {
    const gate = JSON.parse(readFileSync(resolvedPath, "utf-8")) as Record<string, unknown>;
    const inputs = recordObject(gate.inputs);
    const proofs = recordObject(gate.proofs);
    const paths = recordObject(gate.paths);
    const speaker = recordObject(proofs.speakerBackendRequirement);
    const adapter = recordObject(proofs.loraAdapter);
    if (!qualityGateProofSummaryMatchesGate(loraAdapter, gate, baseDir, gateDir)) return false;
    if (gate.status !== "pass" || gate.dryRun !== false) return false;
    if (!sameResolvedPathFromBases(inputs.profileJson, gateDir, loraAdapter.profileJson, baseDir)) return false;
    if (inputs.profileSha256 !== loraAdapter.profileSha256) return false;
    if (inputs.cloneMode !== "hifi") return false;
    if (inputs.requireSpeakerBackend !== "speechbrain-ecapa") return false;
    if (inputs.skipProfileVerify === true || inputs.skipTranscriptValidation === true) return false;
    if (proofs.profileVerifyRequired !== true || proofs.profileVerifyPassed !== true || proofs.profileVerifySkipped === true) return false;
    if (proofs.transcriptValidationRequired !== true || proofs.transcriptValidationPassed !== true || proofs.transcriptValidationSkipped === true) return false;
    if (!sameResolvedPathFromBases(inputs.loraPath, gateDir, loraAdapter.path, baseDir)) return false;
    if (speaker.selected !== "speechbrain-ecapa" || speaker.required !== "speechbrain-ecapa") return false;
    if (adapter.exists !== true) return false;
    if (!sameResolvedPathFromBases(adapter.path, gateDir, loraAdapter.path, baseDir)) return false;
    if (adapter.bytes !== loraAdapter.bytes || adapter.sha256 !== loraAdapter.sha256) return false;

    const transcriptPath = persistedEvidencePath(proofs.transcriptValidationJson ?? inputs.transcriptValidationJson ?? paths.profileTranscriptValidation, gateDir);
    const transcriptSha256 = proofs.transcriptValidationSha256 ?? inputs.transcriptValidationSha256;
    if (!transcriptPath || !fileMatchesSha256(transcriptPath, transcriptSha256, gateDir)) return false;
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8")) as Record<string, unknown>;
    if (transcript.status !== "pass") return false;
    if (!sameResolvedPathFromBases(transcript.profile, path.dirname(transcriptPath), loraAdapter.profileJson, baseDir)) return false;
    if (transcript.voiceProfileId !== loraAdapter.voiceProfileId) return false;
    if (transcript.profileSha256 !== loraAdapter.profileSha256) return false;

    const artifacts = recordObject(proofs.artifacts);
    const resolvedArtifacts: Record<string, { path: string; sha256: string }> = {};
    for (const key of ["report", "asr", "speaker", "score"]) {
      const artifact = recordObject(artifacts[key]);
      if (!sameResolvedPathFromBases(artifact.path, gateDir, paths[key], gateDir)) return false;
      if (!validSha256(artifact.sha256)) return false;
      const artifactPath = persistedEvidencePath(paths[key], gateDir);
      if (!artifactPath || !fileMatchesSha256(artifactPath, artifact.sha256, gateDir)) return false;
      resolvedArtifacts[key] = { path: artifactPath, sha256: artifact.sha256 };
    }

    const score = JSON.parse(readFileSync(resolvedArtifacts.score.path, "utf-8")) as Record<string, unknown>;
    const report = JSON.parse(readFileSync(resolvedArtifacts.report.path, "utf-8")) as Record<string, unknown>;
    const scoreDir = path.dirname(resolvedArtifacts.score.path);
    if (score.verdict !== "pass") return false;
    if (!sameResolvedPathFromBases(score.sourceReport, scoreDir, resolvedArtifacts.report.path, gateDir)) return false;
    if (score.sourceReportSha256 !== resolvedArtifacts.report.sha256) return false;
    if (!sameResolvedPathFromBases(score.asrJson, scoreDir, resolvedArtifacts.asr.path, gateDir)) return false;
    if (score.asrJsonSha256 !== resolvedArtifacts.asr.sha256) return false;
    if (!sameResolvedPathFromBases(score.speakerJson, scoreDir, resolvedArtifacts.speaker.path, gateDir)) return false;
    if (score.speakerJsonSha256 !== resolvedArtifacts.speaker.sha256) return false;
    if (!readyRenderOutputsMatch(score.groups, scoreDir)) return false;
    if (!readyRenderOutputsMatch(report.groups, path.dirname(resolvedArtifacts.report.path))) return false;

    let matchedLoraRender = 0;
    const reportGroups = Array.isArray(report.groups) ? report.groups : [];
    for (const group of reportGroups) {
      const groupObject = recordObject(group);
      if (groupObject.cloneMode !== "hifi") continue;
      const renders = Array.isArray(groupObject.renders) ? groupObject.renders : [];
      for (const render of renders) {
        const renderObject = recordObject(render);
        if (renderObject.status !== "ready") continue;
        const effective = recordObject(recordObject(renderObject.metadataJson).effectiveParams ?? recordObject(renderObject.hotWorkerMetadata).effectiveParams ?? renderObject.effectiveParams);
        if (effective.loraEnabled !== true) return false;
        if (!sameResolvedPathFromBases(effective.loraPath, path.dirname(resolvedArtifacts.report.path), loraAdapter.path, baseDir)) return false;
        matchedLoraRender += 1;
      }
    }
    return matchedLoraRender > 0;
  } catch {
    return false;
  }
}

const EXTERNAL_PREFERRED_BACKENDS = new Set(["indextts2", "f5-tts", "fishaudio-s2-pro"]);

function isExternalPreferredBackend(value: unknown): value is string {
  return typeof value === "string" && EXTERNAL_PREFERRED_BACKENDS.has(value.trim());
}

function subjectiveReviewSummaryMatches(
  summary: unknown,
  expected: Record<string, unknown>,
  summaryBaseDir: string,
  expectedBaseDir: string,
): boolean {
  if (summary === undefined) return true;
  const summaryObject = recordObject(summary);
  for (const key of ["reviewJson", "report"] as const) {
    const expectedPath = expected[key];
    if (typeof expectedPath === "string" && expectedPath.trim()) {
      if (!sameResolvedPathFromBases(summaryObject[key], summaryBaseDir, expectedPath, expectedBaseDir)) return false;
    } else if (summaryObject[key] !== expectedPath) {
      return false;
    }
  }
  for (const key of ["status", "reasons", "stats", "reviewStats", "statMismatches", "missingChoices", "invalidChoices"] as const) {
    if (canonicalJson(summaryObject[key]) !== canonicalJson(expected[key])) return false;
  }
  return true;
}

function preferredBackendSelectionMatchesPolicy(
  preferredBackend: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  baseDir = process.cwd(),
): boolean {
  try {
    const selectionPath = resolvePersistedPath(preferredBackend.selectionJson, baseDir);
    const selection = JSON.parse(readFileSync(selectionPath, "utf-8")) as Record<string, unknown>;
    const selectionDir = path.dirname(selectionPath);
    const selectionProfile =
      selection.voiceProfile && typeof selection.voiceProfile === "object" && !Array.isArray(selection.voiceProfile)
        ? (selection.voiceProfile as Record<string, unknown>)
        : {};
    const subjective =
      selection.subjectiveReview && typeof selection.subjectiveReview === "object" && !Array.isArray(selection.subjectiveReview)
        ? (selection.subjectiveReview as Record<string, unknown>)
        : {};
    const subjectiveStats =
      subjective.stats && typeof subjective.stats === "object" && !Array.isArray(subjective.stats)
        ? (subjective.stats as Record<string, unknown>)
        : {};
    const subjectiveReasons = Array.isArray(subjective.reasons) ? subjective.reasons : [];
    const missingChoices = Array.isArray(subjective.missingChoices) ? subjective.missingChoices : [];
    const invalidChoices = Array.isArray(subjective.invalidChoices) ? subjective.invalidChoices : [];
    const rounds = typeof subjectiveStats.rounds === "number" && Number.isFinite(subjectiveStats.rounds) ? subjectiveStats.rounds : 0;
    const reviewedRounds =
      typeof subjectiveStats.reviewedRounds === "number" && Number.isFinite(subjectiveStats.reviewedRounds)
        ? subjectiveStats.reviewedRounds
        : -1;
    const baselineWins =
      typeof subjectiveStats.baselineWins === "number" && Number.isFinite(subjectiveStats.baselineWins)
        ? subjectiveStats.baselineWins
        : -1;
    const candidateWins =
      typeof subjectiveStats.candidateWins === "number" && Number.isFinite(subjectiveStats.candidateWins)
        ? subjectiveStats.candidateWins
        : -1;
    if (!subjectiveReviewSummaryMatches(preferredBackend.subjectiveReview, subjective, baseDir, selectionDir)) {
      return false;
    }
    return (
      selection.verdict === "accept" &&
      selection.accepted === true &&
      selection.candidateCloneMode === preferredBackend.backend &&
      selection.baselineCloneMode === preferredBackend.baselineBackend &&
      selectionProfile.voiceProfileId === preferredBackend.voiceProfileId &&
      selectionProfile.profileSha256 === preferredBackend.profileSha256 &&
      sameEvidencePathAsPolicy(selection.scoreJson, selectionDir, preferredBackend.scoreJson, baseDir) &&
      selection.scoreSha256 === preferredBackend.scoreSha256 &&
      sameEvidencePathAsPolicy(selection.reviewJson, selectionDir, preferredBackend.reviewJson, baseDir) &&
      selection.reviewSha256 === preferredBackend.reviewSha256 &&
      sameEvidencePathAsPolicy(selection.sourceReport, selectionDir, preferredBackend.sourceReport, baseDir) &&
      selection.sourceReportSha256 === preferredBackend.sourceReportSha256 &&
      subjective.status === "pass" &&
      subjectiveReasons.length === 0 &&
      missingChoices.length === 0 &&
      invalidChoices.length === 0 &&
      rounds > 0 &&
      reviewedRounds === rounds &&
      subjectiveStats.rerenders === 0 &&
      baselineWins <= candidateWins
    );
  } catch {
    return false;
  }
}

function preferredBackendScoreMatchesPolicy(
  preferredBackend: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  baseDir = process.cwd(),
): boolean {
  try {
    const scorePath = resolvePersistedPath(preferredBackend.scoreJson, baseDir);
    const score = JSON.parse(readFileSync(scorePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const scoreDir = path.dirname(scorePath);
    const voiceProfile =
      score.voiceProfile && typeof score.voiceProfile === "object" && !Array.isArray(score.voiceProfile)
        ? (score.voiceProfile as Record<string, unknown>)
        : {};
    if (score.verdict !== "pass") return false;
    if (!sameEvidencePathAsPolicy(score.sourceReport, scoreDir, preferredBackend.sourceReport, baseDir)) return false;
    if (score.sourceReportSha256 !== preferredBackend.sourceReportSha256) return false;
    if (voiceProfile.voiceProfileId !== preferredBackend.voiceProfileId) return false;
    if (voiceProfile.profileSha256 !== preferredBackend.profileSha256) return false;
    const groups = Array.isArray(score.groups) ? score.groups : [];
    let matchedRenders = 0;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const groupObject = group as Record<string, unknown>;
      const cloneMode = groupObject.cloneMode;
      if (cloneMode !== preferredBackend.backend && cloneMode !== preferredBackend.baselineBackend) continue;
      if (groupObject.voiceProfileId !== preferredBackend.voiceProfileId) return false;
      if (groupObject.profileSha256 !== preferredBackend.profileSha256) return false;
      const renders = Array.isArray(groupObject.renders) ? groupObject.renders : [];
      for (const render of renders) {
        if (!render || typeof render !== "object" || Array.isArray(render)) continue;
        const renderObject = render as Record<string, unknown>;
        if (renderObject.voiceProfileId !== preferredBackend.voiceProfileId) return false;
        if (renderObject.profileSha256 !== preferredBackend.profileSha256) return false;
        if (renderObject.status !== "ready") continue;
        if (renderObject.outputExists !== true || renderObject.missingOutput === true) return false;
        if (typeof renderObject.outputBytes !== "number" || !Number.isFinite(renderObject.outputBytes) || renderObject.outputBytes <= 0) {
          return false;
        }
        if (!validSha256(renderObject.outputSha256)) return false;
        const outputPath = persistedEvidencePath(renderObject.outputWav, scoreDir);
        if (!outputPath) return false;
        const stats = statSync(outputPath);
        if (stats.size !== renderObject.outputBytes) return false;
        const digest = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
        if (digest !== renderObject.outputSha256) return false;
        matchedRenders += 1;
      }
    }
    return matchedRenders > 0;
  } catch {
    return false;
  }
}

function preferredBackendReviewMatchesPolicy(
  preferredBackend: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  baseDir = process.cwd(),
): boolean {
  try {
    const selection = JSON.parse(readFileSync(resolvePersistedPath(preferredBackend.selectionJson, baseDir), "utf-8")) as Record<
      string,
      unknown
    >;
    const reviewPath = resolvePersistedPath(preferredBackend.reviewJson, baseDir);
    const review = JSON.parse(readFileSync(reviewPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const reviewDir = path.dirname(reviewPath);
    const subjective = recordObject(selection.subjectiveReview);
    const subjectiveStats = recordObject(subjective.stats);
    const reviewStats = recordObject(review.stats);
    const choices = review.choices && typeof review.choices === "object" && !Array.isArray(review.choices)
      ? (review.choices as Record<string, unknown>)
      : {};
    const statFields = [
      "rounds",
      "reviewedRounds",
      "candidateWins",
      "baselineWins",
      "ties",
      "rerenders",
      "candidateWinRate",
      "minCandidateWinRate",
    ];
    return (
      review.status === "pass" &&
      sameEvidencePathAsPolicy(review.reportPath ?? review.report, reviewDir, preferredBackend.sourceReport, baseDir) &&
      review.reportSha256 === preferredBackend.sourceReportSha256 &&
      reviewStats.reportSha256 === preferredBackend.sourceReportSha256 &&
      statFields.every((field) => reviewStats[field] === subjectiveStats[field]) &&
      Object.keys(choices).length > 0
    );
  } catch {
    return false;
  }
}

function persistedEvidencePath(rawPath: unknown, baseDir: string): string | null {
  if (!nonEmptyString(rawPath)) return null;
  return resolvePersistedPath(rawPath, baseDir);
}

function preferredBackendSourceReportMatchesPolicy(
  preferredBackend: NonNullable<VoiceProfileSummary["preferredBackend"]>,
  baseDir = process.cwd(),
): boolean {
  const sourceReportPath = resolvePersistedPath(preferredBackend.sourceReport, baseDir);
  try {
    const sourceReport = JSON.parse(readFileSync(sourceReportPath, "utf-8")) as Record<string, unknown>;
    const voiceProfile = sourceReport.voiceProfile && typeof sourceReport.voiceProfile === "object" && !Array.isArray(sourceReport.voiceProfile)
      ? (sourceReport.voiceProfile as Record<string, unknown>)
      : {};
    if (voiceProfile.voiceProfileId !== preferredBackend.voiceProfileId) return false;
    if (voiceProfile.profileSha256 !== preferredBackend.profileSha256) return false;
    const groups = Array.isArray(sourceReport.groups) ? sourceReport.groups : [];
    const reportDir = path.dirname(sourceReportPath);
    let matched = 0;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const groupObject = group as Record<string, unknown>;
      if (groupObject.cloneMode !== preferredBackend.backend) continue;
      if (groupObject.voiceProfileId !== preferredBackend.voiceProfileId) return false;
      if (groupObject.profileSha256 !== preferredBackend.profileSha256) return false;
      const renders = Array.isArray(groupObject.renders) ? groupObject.renders : [];
      for (const render of renders) {
        if (!render || typeof render !== "object" || Array.isArray(render)) continue;
        const renderObject = render as Record<string, unknown>;
        if (renderObject.status !== "ready") continue;
        if (renderObject.voiceProfileId !== preferredBackend.voiceProfileId) return false;
        if (renderObject.profileSha256 !== preferredBackend.profileSha256) return false;
        if (renderObject.externalBackend !== true) return false;
        if (renderObject.outputExists !== true || renderObject.missingOutput === true) return false;
        if (typeof renderObject.outputBytes !== "number" || !Number.isFinite(renderObject.outputBytes) || renderObject.outputBytes <= 0) {
          return false;
        }
        if (!validSha256(renderObject.outputSha256)) return false;
        const outputPath = persistedEvidencePath(renderObject.outputWav, reportDir);
        if (!outputPath) return false;
        const stats = statSync(outputPath);
        if (stats.size !== renderObject.outputBytes) return false;
        const digest = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
        if (digest !== renderObject.outputSha256) return false;
        matched += 1;
      }
    }
    return matched > 0;
  } catch {
    return false;
  }
}

function sanitizePersistedPolicies(profile: VoiceProfileSummary, profileJson: string): VoiceProfileSummary {
  const sanitized: VoiceProfileSummary = { ...profile };
  const profileSha256 = canonicalVoiceProfileSha256(sanitized);
  const canUseEvidenceBoundPolicies = sanitized.status === "ready" && sanitized.studioGrade === true;
  const resolvedProfileJson = resolvePersistedPath(profileJson);
  const profileDir = path.dirname(resolvedProfileJson);

  if (!canUseEvidenceBoundPolicies) {
    delete sanitized.preferredBackend;
    sanitized.loraPath = null;
    delete sanitized.loraAdapter;
    return sanitized;
  }

  const preferredBackend = sanitized.preferredBackend;
  if (
    !preferredBackend ||
    preferredBackend.status !== "accepted" ||
    preferredBackend.voiceProfileId !== sanitized.voiceProfileId ||
    preferredBackend.profileSha256 !== profileSha256 ||
    !sameResolvedPath(preferredBackend.profileJson, resolvedProfileJson, profileDir) ||
    !isExternalPreferredBackend(preferredBackend.backend) ||
    preferredBackend.baselineBackend !== "voxcpm2-hifi" ||
    !nonEmptyString(preferredBackend.selectionJson) ||
    !validSha256(preferredBackend.selectionSha256) ||
    !fileMatchesSha256(preferredBackend.selectionJson, preferredBackend.selectionSha256, profileDir) ||
    !nonEmptyString(preferredBackend.scoreJson) ||
    !validSha256(preferredBackend.scoreSha256) ||
    !fileMatchesSha256(preferredBackend.scoreJson, preferredBackend.scoreSha256, profileDir) ||
    !nonEmptyString(preferredBackend.reviewJson) ||
    !validSha256(preferredBackend.reviewSha256) ||
    !fileMatchesSha256(preferredBackend.reviewJson, preferredBackend.reviewSha256, profileDir) ||
    !nonEmptyString(preferredBackend.sourceReport) ||
    !validSha256(preferredBackend.sourceReportSha256) ||
    !fileMatchesSha256(preferredBackend.sourceReport, preferredBackend.sourceReportSha256, profileDir) ||
    !preferredBackendSelectionMatchesPolicy(preferredBackend, profileDir) ||
    !preferredBackendScoreMatchesPolicy(preferredBackend, profileDir) ||
    !preferredBackendReviewMatchesPolicy(preferredBackend, profileDir) ||
    !preferredBackendSourceReportMatchesPolicy(preferredBackend, profileDir)
  ) {
    delete sanitized.preferredBackend;
  } else {
    sanitized.preferredBackend = {
      ...preferredBackend,
      profileJson: resolvePersistedPath(preferredBackend.profileJson, profileDir),
      selectionJson: resolvePersistedPath(preferredBackend.selectionJson, profileDir),
      scoreJson: resolvePersistedPath(preferredBackend.scoreJson, profileDir),
      reviewJson: resolvePersistedPath(preferredBackend.reviewJson, profileDir),
      sourceReport: resolvePersistedPath(preferredBackend.sourceReport, profileDir),
    };
  }

  const loraAdapter = sanitized.loraAdapter;
  if (
    !loraAdapter ||
    loraAdapter.status !== "accepted" ||
    loraAdapter.voiceProfileId !== sanitized.voiceProfileId ||
    loraAdapter.profileSha256 !== profileSha256 ||
    !sameResolvedPath(loraAdapter.profileJson, resolvedProfileJson, profileDir) ||
    !nonEmptyString(loraAdapter.path) ||
    !nonEmptyString(sanitized.loraPath) ||
    !sameResolvedPath(sanitized.loraPath, loraAdapter.path, profileDir) ||
    !validSha256(loraAdapter.sha256) ||
    !fileMatchesSha256(loraAdapter.path, loraAdapter.sha256, profileDir, loraAdapter.bytes) ||
    !nonEmptyString(loraAdapter.adapterProofJson) ||
    !validSha256(loraAdapter.adapterProofSha256) ||
    !fileMatchesSha256(loraAdapter.adapterProofJson, loraAdapter.adapterProofSha256, profileDir) ||
    !adapterProofMatchesLoraPolicy(loraAdapter, profileDir) ||
    !nonEmptyString(loraAdapter.qualityGateJson) ||
    !validSha256(loraAdapter.qualityGateSha256) ||
    !fileMatchesSha256(loraAdapter.qualityGateJson, loraAdapter.qualityGateSha256, profileDir) ||
    !qualityGateMatchesLoraPolicy(loraAdapter, profileDir) ||
    !nonEmptyString(loraAdapter.trainConfig) ||
    !validSha256(loraAdapter.trainConfigSha256) ||
    !fileMatchesSha256(loraAdapter.trainConfig, loraAdapter.trainConfigSha256, profileDir)
  ) {
    sanitized.loraPath = null;
    delete sanitized.loraAdapter;
  } else {
    sanitized.loraPath = resolvePersistedPath(sanitized.loraPath, profileDir);
    sanitized.loraAdapter = {
      ...loraAdapter,
      profileJson: resolvePersistedPath(loraAdapter.profileJson, profileDir),
      path: resolvePersistedPath(loraAdapter.path, profileDir),
      adapterProofJson: resolvePersistedPath(loraAdapter.adapterProofJson, profileDir),
      qualityGateJson: resolvePersistedPath(loraAdapter.qualityGateJson, profileDir),
      trainConfig: resolvePersistedPath(loraAdapter.trainConfig, profileDir),
    };
  }

  return sanitized;
}

function parsePersistedProfile(raw: string): VoiceProfileSummary {
  const parsed = JSON.parse(raw) as Partial<VoiceProfileSummary>;
  if (
    parsed.version !== 1 ||
    typeof parsed.voiceProfileId !== "string" ||
    (parsed.status !== "ready" && parsed.status !== "needs_enrollment") ||
    !parsed.requirements ||
    !parsed.summary ||
    !parsed.diagnostics ||
    !Array.isArray(parsed.clips) ||
    !Array.isArray(parsed.rejectedClips)
  ) {
    throw new Error("voice profile manifest is invalid");
  }
  // Backfill the two-status booleans for manifests persisted before P0:
  // a "ready" manifest is studio-grade (and therefore usable); any manifest
  // with at least one selected clip is usable.
  const studioGrade = typeof parsed.studioGrade === "boolean" ? parsed.studioGrade : parsed.status === "ready";
  const usable =
    typeof parsed.usable === "boolean" ? parsed.usable : studioGrade || (parsed.clips?.length ?? 0) > 0;
  return { ...parsed, usable, studioGrade } as VoiceProfileSummary;
}

export async function loadVoiceProfileManifest(profileJson: string): Promise<VoiceProfileSummary> {
  return sanitizePersistedPolicies(parsePersistedProfile(await readFile(profileJson, "utf-8")), profileJson);
}

async function copySelectedProfileClips(profileDir: string, clips: VoiceProfileClip[]): Promise<VoiceProfileClip[]> {
  const clipsDir = path.join(profileDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  return Promise.all(
    clips.map(async (clip, index) => {
      const extension = path.extname(clip.audioPath) || ".wav";
      const audioPath = path.join(clipsDir, `${String(index + 1).padStart(3, "0")}${extension}`);
      if (path.resolve(clip.audioPath) !== path.resolve(audioPath)) {
        await copyFile(clip.audioPath, audioPath);
      }
      return { ...clip, audioPath };
    }),
  );
}

export async function persistVoiceProfileManifest({
  env = process.env,
  profileId = "local-default",
  profile,
  copyClips = true,
}: {
  env?: CloneEnv;
  profileId?: string;
  profile?: VoiceProfileSummary;
  copyClips?: boolean;
} = {}): Promise<VoiceProfileSummary> {
  const safeProfileId = assertSafeProfileId(profileId);
  const sourceProfile = profile ?? (await buildVoiceProfileSummary({ env, profileId: safeProfileId }));
  const profileJson = voiceProfileManifestPath(safeProfileId, env);
  const profileDir = path.dirname(profileJson);
  await mkdir(profileDir, { recursive: true });
  const clips = copyClips ? await copySelectedProfileClips(profileDir, sourceProfile.clips) : sourceProfile.clips;
  const persisted: VoiceProfileSummary = {
    ...sourceProfile,
    voiceProfileId: safeProfileId,
    createdAt: new Date().toISOString(),
    clips,
  };
  await writeFile(profileJson, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
  return persisted;
}

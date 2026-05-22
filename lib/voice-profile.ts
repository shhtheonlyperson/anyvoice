import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

export interface VoiceProfileSummary {
  version: 1;
  voiceProfileId: string;
  status: VoiceProfileStatus;
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
  maxClips: 10,
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
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
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
  return Array.isArray(clip.pronunciationPresetIds)
    ? clip.pronunciationPresetIds.filter((presetId): presetId is string => typeof presetId === "string" && presetId.length > 0)
    : detectPronunciationPresetIds(clip.transcriptRaw);
}

function pronunciationSelectionScore(
  targetPronunciationPresetIds: string[],
  clipPronunciationPresetIds: string[],
): { missing: number; matched: string[] } {
  const clipIds = new Set(clipPronunciationPresetIds);
  const matched = targetPronunciationPresetIds.filter((presetId) => clipIds.has(presetId));
  return {
    missing: targetPronunciationPresetIds.length - matched.length,
    matched,
  };
}

export function selectVoiceProfileClipForTarget(
  profile: VoiceProfileSummary,
  targetText: string,
): VoiceProfileClipSelection | null {
  if (profile.status !== "ready" || profile.clips.length === 0) return null;
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
  const status: VoiceProfileStatus =
    clips.length >= requirements.minClips && missingCoverageFeatures.length === 0 && missingPronunciationPresetIds.length === 0
      ? "ready"
      : "needs_enrollment";

  return {
    version: 1,
    voiceProfileId: profileId,
    status,
    requirements,
    summary: {
      eligibleClips: eligible.length,
      selectedClips: clips.length,
      rejectedClips: rejected.length,
      remainingClipsNeeded:
        status === "ready"
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
  return parsed as VoiceProfileSummary;
}

export async function loadVoiceProfileManifest(profileJson: string): Promise<VoiceProfileSummary> {
  return parsePersistedProfile(await readFile(profileJson, "utf-8"));
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

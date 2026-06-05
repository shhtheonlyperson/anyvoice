import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  PRODUCT_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS,
  detectPronunciationPresetIds,
} from "@/lib/text-prep";

const execFileAsync = promisify(execFile);

export interface VoiceProfileRecordingKit {
  status: "written";
  kit: string;
  manifest: string;
  promptSet?: "standard" | "extended" | "custom" | string;
  cueSheetHtml?: string;
  cueSheetUrl?: string;
  openCueSheetCommand?: string;
  prompts: string;
  recordings: string;
  clips: number;
  clipSpecs?: VoiceProfileRecordingKitClipSpec[];
  summary?: {
    requiredCoverageFeatures: string[];
    coveredFeatures: string[];
    missingCoverageFeatures: string[];
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  checkCommand: string;
  recordCommand?: string;
  recordMissingUntilCompleteCommand?: string;
  recordNextMissingCommand?: string;
  recordAllCommand?: string;
  preflightBriefCommand?: string;
  recordAndProveCommand?: string;
  recordProveAndProductProofCommand?: string;
  recordProveProductProofAndLoraCommand?: string;
  normalizeExternalRecordingsCommand?: string;
  enrollCommand: string;
  proofCommand?: string;
  importCommand: string;
  verifyCommand: string;
}

export interface VoiceProfileRecordingKitClipSpec {
  id: string;
  expectedStem: string;
  transcript: string;
  audioPath?: string;
  sourceKind?: string;
  coverageFeatures?: string[];
  pronunciationPresetIds?: string[];
  pronunciationNotes?: string[];
  recommendedDurationSec?: number;
  durationMode?: "fixed" | "auto" | string;
  durationTargetSec?: number;
}

export type VoiceProfileRecordingKitPromptSet = "standard" | "extended";

export interface VoiceProfileRecordingKitCheck {
  status: "ready_to_import" | "incomplete";
  manifest: string;
  profileId: string;
  summary: {
    clips: number;
    minClips: number;
    minDurationSec?: number;
    maxDurationSec?: number;
    minActiveVoiceSec?: number;
    targetDurationToleranceSec?: number;
    minPeakAmplitude?: number;
    maxClippingRatio?: number;
    audioFilesPresent: number;
    audioFilesWithinDuration?: number;
    audioFilesWithinTargetDuration?: number;
    audioFilesWithActiveVoice?: number;
    audioFilesPassingLevelQuality?: number;
    coveredFeatures: string[];
    missingCoverageFeatures: string[];
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  checks: Array<{
    check: string;
    ok: boolean;
    message: string;
    details?: unknown;
  }>;
  clips?: unknown[];
  nextCommands?: {
    importProfileClips?: string;
    verifyProfile?: string;
  };
}

export interface VoiceProfileRecordingKitPreflight {
  status: "ready_to_record" | "all_recordings_present" | "blocked";
  manifest: string;
  kit?: string;
  prompts?: string;
  recordings?: string;
  cueSheetHtml?: string | null;
  openCueSheetCommand?: string | null;
  manifestMetadata?: {
    promptSet?: string | null;
    requiredClips?: number | null;
  };
  message: string;
  durationSec: number;
  countdownSec: number;
  summary: {
    clips: number;
    existing: number;
    toRecord: number;
    toSkipExisting: number;
    promptBlocked: number;
    transcriptBlocked: number;
    recordingMetadataChecked: number;
    recordingMetadataBlocked: number;
    writeBlocked: number;
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  recorder: {
    configured: boolean;
    source: string;
    template?: string;
  };
  microphoneSmokeTest?: {
    status: "passed" | "failed" | "skipped" | string;
    durationSec?: number;
    clipId?: string;
    exitCode?: number;
    audioBytes?: number;
    audioLevelQuality?: {
      peakAmplitude?: number;
      clippingRatio?: number;
    } | null;
    levelQualityError?: string | null;
    minPeakAmplitude?: number;
    maxClippingRatio?: number;
    errors?: string[];
    keptAudio?: boolean;
    stdout?: string | null;
    stderr?: string | null;
    command?: string;
  };
  recordingGuidance?: {
    minDurationSec: number;
    maxDurationSec: number;
    minActiveVoiceSec: number;
    durationMode?: "fixed" | "auto" | string;
    targetDurationSec: number | null;
    targetDurationLabel?: string;
    checklist: string[];
  };
  clips?: unknown[];
  nextCommands?: Record<string, string>;
}

export interface VoiceProfileRecordingKitNormalize {
  status: "normalized" | "all_recordings_present" | "blocked" | "check_failed" | "planned";
  manifest: string;
  profileId: string;
  dryRun: boolean;
  overwrite: boolean;
  sourceDirs: string[];
  summary: {
    clips: number;
    normalized: number;
    existing: number;
    missingSources: number;
    failures: number;
  };
  rows: Array<{
    index?: number;
    id?: string;
    status?: string;
    method?: string;
    sourceAudioPath?: string;
    audioPath?: string;
    recordingMetadataPath?: string | null;
    message?: string;
    expectedSourceNames?: string[];
  }>;
  checkReport?: VoiceProfileRecordingKitCheck | null;
  nextCommands?: Record<string, string>;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function assertSafeProfileId(profileId: string): string {
  const normalized = profileId.trim() || "local-default";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    throw new Error("profileId must contain only letters, numbers, dash, or underscore");
  }
  return normalized;
}

function assertSafePromptSet(promptSet: string | undefined): VoiceProfileRecordingKitPromptSet {
  if (promptSet === undefined || promptSet === "" || promptSet === "standard") return "standard";
  if (promptSet === "extended") return "extended";
  throw new Error("promptSet must be standard or extended");
}

function outDirForProfile(profileId: string, promptSet: VoiceProfileRecordingKitPromptSet): string {
  const root = process.env.ANYVOICE_RECORDING_KIT_OUT_ROOT || path.join(process.cwd(), "generated", "voice-profile-recording-kits");
  const suffix = promptSet === "extended" ? "-extended" : "";
  return path.join(root, `${profileId}${suffix}-${timestamp()}`);
}

function currentOutDirForProfile(profileId: string): string {
  return path.join(recordingKitRoot(), `${profileId}-current`);
}

function recordingKitRoot(): string {
  return path.resolve(process.env.ANYVOICE_RECORDING_KIT_OUT_ROOT || path.join(process.cwd(), "generated", "voice-profile-recording-kits"));
}

function assertSafeManifestPath(manifestInput: string): string {
  const trimmed = manifestInput.trim();
  if (!trimmed) throw new Error("manifest path required");
  const manifest = path.resolve(trimmed);
  const relative = path.relative(recordingKitRoot(), manifest);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(manifest) !== "manifest.json") {
    throw new Error("manifest must be a recording kit manifest generated by AnyVoice");
  }
  return manifest;
}

function parseKitPayload(stdout: string): VoiceProfileRecordingKit {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileRecordingKit>;
  if (
    parsed.status !== "written" ||
    typeof parsed.kit !== "string" ||
    typeof parsed.manifest !== "string" ||
    typeof parsed.prompts !== "string" ||
    typeof parsed.recordings !== "string" ||
    typeof parsed.enrollCommand !== "string"
  ) {
    throw new Error("recording kit script returned an invalid payload");
  }
  return parsed as VoiceProfileRecordingKit;
}

function cueSheetUrl(profileId: string, manifest: string): string {
  const params = new URLSearchParams({ profileId, manifest });
  return `/api/voice-profile/recording-kit/cue-sheet?${params.toString()}`;
}

function withCueSheetUrl(kit: VoiceProfileRecordingKit, profileId: string): VoiceProfileRecordingKit {
  return {
    ...kit,
    cueSheetUrl: cueSheetUrl(profileId, kit.manifest),
  };
}

function shellJoin(parts: string[]): string {
  return parts
    .map((part) => (part.includes(" ") || part.includes("'") ? `'${part.replaceAll("'", "'\\''")}'` : part))
    .join(" ");
}

function requiredPronunciationPresetIds(promptSet: unknown): string[] {
  return [
    ...(promptSet === "extended"
      ? PRODUCT_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS
      : REQUIRED_VOICE_PROFILE_PRONUNCIATION_PRESET_IDS),
  ];
}

function clipPronunciationPresetIds(clip: Record<string, unknown>, transcript: string): string[] {
  const ids = new Set<string>();
  if (Array.isArray(clip.pronunciationPresetIds)) {
    for (const presetId of clip.pronunciationPresetIds) {
      if (typeof presetId === "string" && presetId.length > 0) ids.add(presetId);
    }
  }
  for (const presetId of detectPronunciationPresetIds(transcript)) ids.add(presetId);
  return [...ids];
}

function summarizeKitCoverage(clips: Array<Record<string, unknown>>, promptSet: unknown): VoiceProfileRecordingKit["summary"] {
  const requiredCoverageFeatures = ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"];
  const covered = new Set<string>();
  const coveredPronunciationPresets = new Set<string>();
  for (const clip of clips) {
    const features = clip.coverageFeatures;
    if (Array.isArray(features)) {
      for (const feature of features) {
        if (typeof feature === "string") covered.add(feature);
      }
    }
    const transcript = typeof clip.transcript === "string" ? clip.transcript : "";
    for (const presetId of clipPronunciationPresetIds(clip, transcript)) {
      coveredPronunciationPresets.add(presetId);
    }
  }
  const coveredFeatures = [...covered].sort();
  const coveredPronunciationPresetIds = [...coveredPronunciationPresets].sort();
  const requiredPresetIds = requiredPronunciationPresetIds(promptSet);
  return {
    requiredCoverageFeatures,
    coveredFeatures,
    missingCoverageFeatures: requiredCoverageFeatures.filter((feature) => !covered.has(feature)),
    requiredPronunciationPresetIds: requiredPresetIds,
    coveredPronunciationPresetIds,
    missingPronunciationPresetIds: requiredPresetIds.filter((presetId) => !coveredPronunciationPresets.has(presetId)),
  };
}

function kitClipSpecs(clips: Array<Record<string, unknown>>): VoiceProfileRecordingKitClipSpec[] {
  return clips.flatMap((clip, index) => {
    const id = typeof clip.id === "string" && clip.id.trim() ? clip.id.trim() : `profile-clip-${String(index + 1).padStart(2, "0")}`;
    const transcript = typeof clip.transcript === "string" && clip.transcript.trim()
      ? clip.transcript.trim()
      : typeof clip.promptTranscript === "string" && clip.promptTranscript.trim()
        ? clip.promptTranscript.trim()
        : "";
    if (!transcript) return [];
    const coverageFeatures = Array.isArray(clip.coverageFeatures)
      ? clip.coverageFeatures.filter((feature): feature is string => typeof feature === "string")
      : undefined;
    const pronunciationPresetIds = clipPronunciationPresetIds(clip, transcript);
    const pronunciationNotes = Array.isArray(clip.pronunciationNotes)
      ? clip.pronunciationNotes.filter((note): note is string => typeof note === "string")
      : undefined;
    const recommendedDurationSec = typeof clip.recommendedDurationSec === "number" && Number.isFinite(clip.recommendedDurationSec)
      ? clip.recommendedDurationSec
      : undefined;
    const durationTargetSec = typeof clip.durationTargetSec === "number" && Number.isFinite(clip.durationTargetSec)
      ? clip.durationTargetSec
      : recommendedDurationSec;
    return [
      {
        id,
        expectedStem: id,
        transcript,
        audioPath: typeof clip.audioPath === "string" ? clip.audioPath : undefined,
        sourceKind: typeof clip.sourceKind === "string" ? clip.sourceKind : undefined,
        coverageFeatures,
        pronunciationPresetIds,
        pronunciationNotes,
        recommendedDurationSec,
        durationMode: typeof clip.durationMode === "string" ? clip.durationMode : undefined,
        durationTargetSec,
      },
    ];
  });
}

async function kitPayloadFromManifest(manifest: string, profileId: string): Promise<VoiceProfileRecordingKit> {
  const parsed = JSON.parse(await readFile(manifest, "utf-8")) as {
    promptSet?: unknown;
    requiredClips?: unknown;
    clips?: unknown;
  };
  const clips = Array.isArray(parsed.clips) ? (parsed.clips as Array<Record<string, unknown>>) : [];
  if (!clips.length) throw new Error("recording kit manifest has no clips");
  const kit = path.dirname(manifest);
  const cueSheetHtml = path.join(kit, "cue-sheet.html");
  const prompts = path.join(kit, "prompts");
  const recordings = path.join(kit, "recordings");
  const recordMissingUntilCompleteCommand = shellJoin([
    "python3",
    "scripts/record_voice_profile_recording_kit.py",
    "--manifest",
    manifest,
    "--record-missing-until-complete",
    "--open-cue-sheet",
    "--microphone-smoke-sec",
    "2",
    "--profile-id",
    profileId,
    "--countdown-sec",
    "2",
    "--write-metadata",
    "--check",
    "--auto-duration",
  ]);
  return {
    status: "written",
    kit,
    manifest,
    promptSet: typeof parsed.promptSet === "string" ? parsed.promptSet : undefined,
    cueSheetHtml,
    cueSheetUrl: cueSheetUrl(profileId, manifest),
    openCueSheetCommand: shellJoin(["python3", "-m", "webbrowser", "-t", `file://${cueSheetHtml}`]),
    prompts,
    recordings,
    clips: clips.length,
    clipSpecs: kitClipSpecs(clips),
    summary: summarizeKitCoverage(clips, parsed.promptSet),
    checkCommand: shellJoin(["python3", "scripts/check_voice_profile_recording_kit.py", "--manifest", manifest, "--profile-id", profileId]),
    recordCommand: recordMissingUntilCompleteCommand,
    recordMissingUntilCompleteCommand,
    recordNextMissingCommand: shellJoin([
      "python3",
      "scripts/record_voice_profile_recording_kit.py",
      "--manifest",
      manifest,
      "--next-missing",
      "--open-cue-sheet",
      "--microphone-smoke-sec",
      "2",
      "--profile-id",
      profileId,
      "--countdown-sec",
      "2",
      "--write-metadata",
      "--check-selected",
      "--auto-duration",
    ]),
    recordAllCommand: shellJoin([
      "python3",
      "scripts/record_voice_profile_recording_kit.py",
      "--manifest",
      manifest,
      "--open-cue-sheet",
      "--microphone-smoke-sec",
      "2",
      "--check",
      "--profile-id",
      profileId,
      "--countdown-sec",
      "2",
      "--write-metadata",
      "--auto-duration",
    ]),
    preflightBriefCommand: shellJoin([
      "python3",
      "scripts/record_voice_profile_recording_kit.py",
      "--manifest",
      manifest,
      "--preflight",
      "--brief",
      "--profile-id",
      profileId,
      "--auto-duration",
    ]),
    recordAndProveCommand: `${recordMissingUntilCompleteCommand} --run-proof-after-check`,
    recordProveAndProductProofCommand: `${recordMissingUntilCompleteCommand} --run-product-proof-after-check`,
    recordProveProductProofAndLoraCommand: `${recordMissingUntilCompleteCommand} --prepare-lora-after-product-proof`,
    normalizeExternalRecordingsCommand: shellJoin([
      "python3",
      "scripts/normalize_voice_profile_recording_kit_audio.py",
      "--manifest",
      manifest,
      "--check",
      "--profile-id",
      profileId,
    ]),
    enrollCommand: shellJoin(["python3", "scripts/enroll_voice_profile_kit.py", "--manifest", manifest, "--profile-id", profileId]),
    proofCommand: shellJoin([
      "python3",
      "scripts/voice_profile_next_step.py",
      "--profile-json",
      `.anyvoice/voices/${profileId}/profile.json`,
      "--kit-manifest",
      manifest,
      "--profile-id",
      profileId,
      "--record-countdown-sec",
      "2",
      "--run",
      "--auto-advance",
      "--allow-enroll",
      "--allow-expensive",
      "--stop-before-lora",
      "--max-steps",
      "3",
    ]),
    importCommand: shellJoin(["python3", "scripts/import_voice_profile_clips.py", "--manifest", manifest, "--build-profile"]),
    verifyCommand: shellJoin(["python3", "scripts/verify_voice_profile_ready.py", "--profile-json", `.anyvoice/voices/${profileId}/profile.json`]),
  };
}

function parseKitCheckPayload(stdout: string): VoiceProfileRecordingKitCheck {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileRecordingKitCheck>;
  if (
    (parsed.status !== "ready_to_import" && parsed.status !== "incomplete") ||
    typeof parsed.manifest !== "string" ||
    typeof parsed.profileId !== "string" ||
    !parsed.summary ||
    typeof parsed.summary.audioFilesPresent !== "number" ||
    !Array.isArray(parsed.checks)
  ) {
    throw new Error("recording kit check returned an invalid payload");
  }
  return parsed as VoiceProfileRecordingKitCheck;
}

function parseKitPreflightPayload(stdout: string): VoiceProfileRecordingKitPreflight {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileRecordingKitPreflight>;
  if (
    (parsed.status !== "ready_to_record" && parsed.status !== "all_recordings_present" && parsed.status !== "blocked") ||
    typeof parsed.manifest !== "string" ||
    typeof parsed.message !== "string" ||
    !parsed.summary ||
    typeof parsed.summary.toRecord !== "number" ||
    !parsed.recorder ||
    typeof parsed.recorder.configured !== "boolean" ||
    typeof parsed.recorder.source !== "string"
  ) {
    throw new Error("recording kit preflight returned an invalid payload");
  }
  return parsed as VoiceProfileRecordingKitPreflight;
}

function parseKitNormalizePayload(stdout: string): VoiceProfileRecordingKitNormalize {
  const parsed = JSON.parse(stdout) as Partial<VoiceProfileRecordingKitNormalize>;
  if (
    !["normalized", "all_recordings_present", "blocked", "check_failed", "planned"].includes(String(parsed.status)) ||
    typeof parsed.manifest !== "string" ||
    typeof parsed.profileId !== "string" ||
    !parsed.summary ||
    typeof parsed.summary.missingSources !== "number" ||
    !Array.isArray(parsed.rows)
  ) {
    throw new Error("recording kit normalizer returned an invalid payload");
  }
  return parsed as VoiceProfileRecordingKitNormalize;
}

function execErrorOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

export async function createVoiceProfileRecordingKit(
  profileIdInput = "local-default",
  { promptSet: promptSetInput }: { promptSet?: string } = {},
): Promise<VoiceProfileRecordingKit> {
  const profileId = assertSafeProfileId(profileIdInput);
  const promptSet = assertSafePromptSet(promptSetInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "prepare_voice_profile_recording_kit.py");
  const { stdout, stderr } = await execFileAsync(
    python,
    [
      script,
      "--profile-id",
      profileId,
      "--prompt-set",
      promptSet,
      "--out-dir",
      outDirForProfile(profileId, promptSet),
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    },
  );
  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }
  return withCueSheetUrl(parseKitPayload(stdout), profileId);
}

export async function getCurrentVoiceProfileRecordingKit(profileIdInput = "local-default"): Promise<VoiceProfileRecordingKit | null> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = path.join(currentOutDirForProfile(profileId), "manifest.json");
  try {
    return await kitPayloadFromManifest(manifest, profileId);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readVoiceProfileRecordingKitCueSheet(
  manifestInput: string,
  profileIdInput = "local-default",
): Promise<{
  html: string;
  path: string;
}> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = assertSafeManifestPath(manifestInput);
  const kit = await kitPayloadFromManifest(manifest, profileId);
  if (!kit?.cueSheetHtml) {
    throw new Error("recording kit cue sheet is missing");
  }
  const cueSheetPath = path.resolve(kit.cueSheetHtml);
  const relative = path.relative(recordingKitRoot(), cueSheetPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(cueSheetPath) !== "cue-sheet.html") {
    throw new Error("cue sheet must be generated by AnyVoice");
  }
  return {
    html: await readFile(cueSheetPath, "utf-8"),
    path: cueSheetPath,
  };
}

export async function readCurrentVoiceProfileRecordingKitCueSheet(profileIdInput = "local-default"): Promise<{
  html: string;
  path: string;
}> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = path.join(currentOutDirForProfile(profileId), "manifest.json");
  return readVoiceProfileRecordingKitCueSheet(manifest, profileId);
}

export async function checkVoiceProfileRecordingKit(
  manifestInput: string,
  profileIdInput = "local-default",
): Promise<VoiceProfileRecordingKitCheck> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = assertSafeManifestPath(manifestInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "check_voice_profile_recording_kit.py");
  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [
        script,
        "--profile-id",
        profileId,
        "--manifest",
        manifest,
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      },
    );
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseKitCheckPayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseKitCheckPayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "recording kit check failed"));
  }
}

export async function preflightVoiceProfileRecordingKit(
  manifestInput: string,
  profileIdInput = "local-default",
): Promise<VoiceProfileRecordingKitPreflight> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = assertSafeManifestPath(manifestInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "record_voice_profile_recording_kit.py");
  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [
        script,
        "--profile-id",
        profileId,
        "--manifest",
        manifest,
        "--preflight",
        "--auto-duration",
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      },
    );
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseKitPreflightPayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseKitPreflightPayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "recording kit preflight failed"));
  }
}

export async function smokeTestVoiceProfileRecordingKit(
  manifestInput: string,
  profileIdInput = "local-default",
  smokeSec = 2,
): Promise<VoiceProfileRecordingKitPreflight> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = assertSafeManifestPath(manifestInput);
  const duration = Number.isFinite(smokeSec) && smokeSec > 0 ? smokeSec : 2;
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "record_voice_profile_recording_kit.py");
  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [
        script,
        "--profile-id",
        profileId,
        "--manifest",
        manifest,
        "--preflight",
        "--microphone-smoke-sec",
        String(duration),
        "--auto-duration",
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      },
    );
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseKitPreflightPayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseKitPreflightPayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "recording kit microphone smoke test failed"));
  }
}

export async function normalizeVoiceProfileRecordingKitAudio(
  manifestInput: string,
  profileIdInput = "local-default",
): Promise<VoiceProfileRecordingKitNormalize> {
  const profileId = assertSafeProfileId(profileIdInput);
  const manifest = assertSafeManifestPath(manifestInput);
  const python = process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "normalize_voice_profile_recording_kit_audio.py");
  try {
    const { stdout, stderr } = await execFileAsync(
      python,
      [
        script,
        "--profile-id",
        profileId,
        "--manifest",
        manifest,
        "--check",
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      },
    );
    if (stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return parseKitNormalizePayload(stdout);
  } catch (error) {
    const stdout = execErrorOutput(error, "stdout");
    if (stdout.trim()) return parseKitNormalizePayload(stdout);
    const stderr = execErrorOutput(error, "stderr");
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : "recording kit audio normalization failed"));
  }
}

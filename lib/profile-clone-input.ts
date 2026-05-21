import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTargetText } from "@/lib/clone-config";
import {
  isCloneInputError,
  parseCloneForm,
  type CloneInput,
  type CloneInputError,
} from "@/lib/clone-request";
import { detectChineseScript } from "@/lib/text-prep";
import { buildVoiceProfileSummary, loadVoiceProfileManifest, selectVoiceProfileClipForTarget } from "@/lib/voice-profile";
import { verifyVoiceProfileReadiness, type VoiceProfileReadinessReport } from "@/lib/voice-profile-verify";

export type ParsedCloneInput = CloneInput | CloneInputError;

function error(statusCode: number, message: string): CloneInputError {
  return { statusCode, body: { status: "error", message } };
}

export function wantsVoiceProfile(form: FormData): boolean {
  const value = String(form.get("useVoiceProfile") || form.get("referenceMode") || "")
    .trim()
    .toLowerCase();
  return value === "yes" || value === "true" || value === "1" || value === "profile";
}

function contentTypeForAudio(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

function firstFailedCheck(report: VoiceProfileReadinessReport): string {
  return report.checks.find((check) => !check.ok)?.message || "strict voice-profile check has not passed";
}

export async function parseCloneFormWithProfile(form: FormData): Promise<ParsedCloneInput> {
  if (!wantsVoiceProfile(form)) return parseCloneForm(form);

  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  if (!targetText) return error(400, "target text required");
  const targetScript = detectChineseScript(targetText);
  if (targetScript === "zh_hans" || targetScript === "mixed_zh" || targetScript === "zh_unknown") {
    return error(
      400,
      "voice profile target text must use clear Traditional Chinese; Simplified, mixed, or unproven Chinese can destabilize Mandarin pronunciation",
    );
  }
  if (form.get("consent") !== "yes") {
    return error(400, "voice permission confirmation required");
  }

  const summary = await buildVoiceProfileSummary();
  if (summary.status !== "ready") {
    return error(
      409,
      `voice profile is not ready: ${summary.summary.remainingClipsNeeded} more qualified reference clips needed`,
    );
  }

  let profile = summary;
  try {
    const verification = await verifyVoiceProfileReadiness({
      profileId: summary.voiceProfileId,
      requireTranscriptValidation: true,
    });
    if (verification.status !== "ready") {
      return error(409, `voice profile hard gate is blocked: ${firstFailedCheck(verification)}`);
    }
    profile = await loadVoiceProfileManifest(verification.profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : "strict voice-profile check failed";
    return error(409, `voice profile needs a passing strict check before generation: ${message}`);
  }

  const selection = selectVoiceProfileClipForTarget(profile, targetText);
  if (!selection) {
    return error(409, "voice profile is ready but no reference clip could be selected");
  }
  const clip = selection.clip;

  let bytes: Buffer;
  try {
    bytes = await readFile(clip.audioPath);
  } catch {
    return error(500, `voice profile reference clip is missing: ${clip.sourceRunId}`);
  }

  const extension = path.extname(clip.audioPath) || ".wav";
  const voice = new File([new Uint8Array(bytes)], `voice-profile-${clip.sourceRunId}${extension}`, {
    type: contentTypeForAudio(clip.audioPath),
  });

  const resolved = new FormData();
  resolved.set("voice", voice, voice.name);
  resolved.set("targetText", targetText);
  resolved.set("promptTranscript", clip.transcriptRaw);
  resolved.set("consent", "yes");
  resolved.set("quality", String(form.get("quality") || ""));
  resolved.set("sourceKind", "profile");
  const pronunciationOverrides = String(form.get("pronunciationOverrides") || "").trim();
  if (pronunciationOverrides) resolved.set("pronunciationOverrides", pronunciationOverrides);

  const input = parseCloneForm(resolved);
  if (isCloneInputError(input)) return input;

  return {
    ...input,
    profileReference: {
      voiceProfileId: profile.voiceProfileId,
      sourceRunId: clip.sourceRunId,
      referenceClipIds: profile.referenceClipIds,
      audioPath: clip.audioPath,
      transcriptScript: clip.transcriptScript,
      coverageFeatures: clip.coverageFeatures,
      pronunciationPresetIds: clip.pronunciationPresetIds,
      targetCoverageFeatures: selection.targetCoverageFeatures,
      matchedCoverageFeatures: selection.matchedCoverageFeatures,
      targetPronunciationPresetIds: selection.targetPronunciationPresetIds,
      matchedPronunciationPresetIds: selection.matchedPronunciationPresetIds,
    },
  };
}

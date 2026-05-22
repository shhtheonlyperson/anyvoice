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
import { verifyVoiceProfileReadiness } from "@/lib/voice-profile-verify";

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

export async function parseCloneFormWithProfile(form: FormData): Promise<ParsedCloneInput> {
  if (!wantsVoiceProfile(form)) return parseCloneForm(form);

  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  if (!targetText) return error(400, "target text required");
  const targetScript = detectChineseScript(targetText);
  if (targetScript === "zh_hans" || targetScript === "mixed_zh") {
    return error(
      400,
      "voice profile target text must not use Simplified or mixed Chinese — it can destabilize Mandarin pronunciation",
    );
  }
  if (form.get("consent") !== "yes") {
    return error(400, "voice permission confirmation required");
  }

  const profileId = String(form.get("profileId") || "").trim() || undefined;
  const summary = await buildVoiceProfileSummary(profileId ? { profileId } : undefined);
  // P0.1/P0.2 — Generation only requires a *usable* voice (≥1 passing A/B clip,
  // the zero-shot path the headline copy promises). The strict studio-grade bar
  // governs LoRA/quality-gate/audiobook-at-scale, never routine "speak in my
  // voice". A single-clip local-default profile is enough to generate.
  if (!summary.usable) {
    return error(
      409,
      `voice profile is not usable yet: record at least one clean reference clip to generate`,
    );
  }

  // Optional studio-grade enrichment (NEVER blocking): for the curated default
  // voice, if it already passes the strict verifier we prefer that verified
  // manifest (it may carry a curated clip selection). If the strict check fails,
  // we still generate from the usable summary — usability is the only gate.
  let profile = summary;
  if (summary.voiceProfileId === "local-default" && summary.studioGrade) {
    try {
      const verification = await verifyVoiceProfileReadiness({
        profileId: summary.voiceProfileId,
        requireTranscriptValidation: false,
      });
      if (verification.status === "ready") {
        profile = await loadVoiceProfileManifest(verification.profile);
      }
    } catch {
      /* studio-grade verification is best-effort; a usable voice still generates */
    }
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

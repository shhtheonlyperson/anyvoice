import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import {
  browserCaptureSettingsError,
  enrollVoiceProfileClip,
  parseBrowserCaptureSettings,
  type BrowserCaptureSettings,
  type VoiceProfileEnrollmentInput,
} from "@/lib/profile-enrollment";
import { getCurrentVoiceProfileRecordingKit } from "@/lib/recording-kit";
import { detectChineseScript, strictTraditionalChineseScriptErrors } from "@/lib/text-prep";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";
export const maxDuration = 120;

interface ClipSpec {
  id?: string;
  fileField?: string;
  expectedStem?: string;
  transcript?: string;
  sourceKind?: string;
  browserCaptureSettings?: BrowserCaptureSettings;
}

const SOURCE_KINDS = new Set(["scripted", "freeform", "uploaded"]);
const RECORDING_KIT_CLIP_RE = /^profile-clip-\d{2}$/;
const RECORDING_KIT_FILENAME_RE = /(?:^|[^a-z0-9])(profile-clip-\d{2})(?:[^0-9]|$)/;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function error(message: string, status = 400) {
  return json({ status: "error", message }, { status });
}

function parseClipSpecs(raw: FormDataEntryValue | null): ClipSpec[] | Response {
  if (typeof raw !== "string" || !raw.trim()) return error("clips JSON required");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10) {
      return error("clips must be a non-empty array with at most 10 rows");
    }
    return parsed.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`clip ${index + 1} is not an object`);
      const row = item as ClipSpec;
      if (typeof row.transcript !== "string" || !row.transcript.trim()) {
        throw new Error(`clip ${index + 1} is missing transcript`);
      }
      const transcriptScript = detectChineseScript(row.transcript);
      const scriptErrors = strictTraditionalChineseScriptErrors(row.transcript);
      if (scriptErrors.length > 0) {
        throw new Error(
          `clip ${index + 1} transcript must be proven Traditional Chinese; Simplified, mixed, or unproven Chinese clips are not accepted for the Traditional Mandarin voice profile (${transcriptScript})`,
        );
      }
      if (row.sourceKind !== undefined && !SOURCE_KINDS.has(String(row.sourceKind))) {
        throw new Error(`clip ${index + 1} has invalid sourceKind`);
      }
      if (row.expectedStem !== undefined && (typeof row.expectedStem !== "string" || !row.expectedStem.trim())) {
        throw new Error(`clip ${index + 1} has invalid expectedStem`);
      }
      let browserCaptureSettings: BrowserCaptureSettings | undefined;
      try {
        browserCaptureSettings = parseBrowserCaptureSettings(row.browserCaptureSettings);
      } catch (err) {
        throw new Error(err instanceof Error ? `clip ${index + 1} ${err.message}` : `clip ${index + 1} has invalid browserCaptureSettings`);
      }
      const captureError = browserCaptureSettingsError(browserCaptureSettings);
      if (captureError) throw new Error(`clip ${index + 1} ${captureError}`);
      return { ...row, browserCaptureSettings };
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "clips JSON is invalid");
  }
}

function looksLikeRecordingKitClip(spec: ClipSpec, voiceName?: string): boolean {
  return recordingKitClipIdForSpec(spec, voiceName) !== null;
}

function recordingKitClipId(value: unknown, { matchInside = false }: { matchInside?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (RECORDING_KIT_CLIP_RE.test(normalized)) return normalized;
  if (!matchInside) return null;
  const match = RECORDING_KIT_FILENAME_RE.exec(normalized);
  return match?.[1] ?? null;
}

function recordingKitClipIdForSpec(spec: ClipSpec, voiceName?: string): string | null {
  const id = typeof spec.id === "string" ? spec.id.trim().toLowerCase() : "";
  const expectedStem = typeof spec.expectedStem === "string" ? spec.expectedStem.trim().toLowerCase() : "";
  const fileName = typeof voiceName === "string" ? voiceName.trim().toLowerCase() : "";
  const candidates = [
    recordingKitClipId(id),
    recordingKitClipId(expectedStem),
    recordingKitClipId(fileName, { matchInside: true }),
  ].filter((value): value is string => value !== null);
  if (candidates.length === 0) return null;
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error(`recording kit clip identifiers disagree: ${unique.join(", ")}`);
  }
  return unique[0];
}

function hasExplicitCleanBrowserCaptureSettings(settings: BrowserCaptureSettings | undefined): boolean {
  return (
    settings?.echoCancellation === false &&
    settings.noiseSuppression === false &&
    settings.autoGainControl === false
  );
}

function fixedSlotPairingEvidence(spec: ClipSpec, voiceName?: string): "filename_or_stem" | "browser_capture" | null {
  const expectedStemSlot = recordingKitClipId(spec.expectedStem);
  const fileNameSlot = recordingKitClipId(voiceName, { matchInside: true });
  if (expectedStemSlot || fileNameSlot) return "filename_or_stem";
  if (hasExplicitCleanBrowserCaptureSettings(spec.browserCaptureSettings)) return "browser_capture";
  return null;
}

async function currentRecordingKitTranscriptMap(profileId: string): Promise<Map<string, string>> {
  const kit = await getCurrentVoiceProfileRecordingKit(profileId);
  if (!kit) {
    throw new Error("current recording kit manifest was not found");
  }
  const specs = Array.isArray(kit.clipSpecs) ? kit.clipSpecs : [];
  const transcripts = new Map<string, string>();
  for (const spec of specs) {
    const clipId = recordingKitClipId(spec.id);
    if (!clipId || typeof spec.transcript !== "string" || !spec.transcript.trim()) continue;
    transcripts.set(clipId, spec.transcript.trim());
  }
  if (transcripts.size === 0) {
    throw new Error("current recording kit manifest has no fixed prompt transcripts");
  }
  return transcripts;
}

function enrollmentSourceKindForSpec(spec: ClipSpec, voiceName?: string): VoiceProfileEnrollmentInput["sourceKind"] {
  const rawSourceKind = typeof spec.sourceKind === "string" ? spec.sourceKind.trim().toLowerCase() : "";
  const kitClip = looksLikeRecordingKitClip(spec, voiceName);
  if (kitClip && rawSourceKind && rawSourceKind !== "scripted") {
    throw new Error(`recording kit clip ${spec.id || spec.expectedStem || voiceName || "row"} must use sourceKind scripted`);
  }
  if (kitClip) return "scripted";
  return SOURCE_KINDS.has(rawSourceKind) ? (rawSourceKind as VoiceProfileEnrollmentInput["sourceKind"]) : "uploaded";
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return withAnyVoiceUserCookie(error("multipart form data required"), session);
  }

  if (form.get("consent") !== "yes") {
    return withAnyVoiceUserCookie(error("voice permission confirmation required"), session);
  }

  const specsOrResponse = parseClipSpecs(form.get("clips"));
  if (specsOrResponse instanceof Response) {
    return withAnyVoiceUserCookie(specsOrResponse, session);
  }

  const profileIdRaw = form.get("profileId");
  const voiceProfileId = typeof profileIdRaw === "string" && profileIdRaw.trim() ? profileIdRaw.trim() : undefined;
  const profileId = voiceProfileId ?? "local-default";

  const preparedClips: Array<{
    spec: ClipSpec;
    fileField: string;
    voice: File;
    sourceKind: VoiceProfileEnrollmentInput["sourceKind"];
    recordingKitSlot: string | null;
  }> = [];
  const enrollments = [];
  const recordingKitSlots = new Set<string>();
  let recordingKitTranscripts: Map<string, string> | null = null;
  try {
    for (let index = 0; index < specsOrResponse.length; index += 1) {
      const spec = specsOrResponse[index];
      const fileField = spec.fileField || `voice-${index}`;
      const voice = form.get(fileField);
      if (!(voice instanceof File)) {
        return withAnyVoiceUserCookie(error(`voice file required for clip ${index + 1}`), session);
      }
      let recordingKitSlot: string | null;
      try {
        recordingKitSlot = recordingKitClipIdForSpec(spec, voice.name);
      } catch (err) {
        return withAnyVoiceUserCookie(error(err instanceof Error ? err.message : "recording kit clip id is invalid"), session);
      }
      if (recordingKitSlot) {
        if (recordingKitSlots.has(recordingKitSlot)) {
          return withAnyVoiceUserCookie(error(`recording kit clip ${recordingKitSlot} appears more than once in this import batch`), session);
        }
        recordingKitSlots.add(recordingKitSlot);
        if (!recordingKitTranscripts) {
          try {
            recordingKitTranscripts = await currentRecordingKitTranscriptMap(profileId);
          } catch (err) {
            return withAnyVoiceUserCookie(
              error(err instanceof Error ? `current recording kit manifest is required for fixed prompt imports: ${err.message}` : "current recording kit manifest is required for fixed prompt imports"),
              session,
            );
          }
        }
        const manifestTranscript = recordingKitTranscripts.get(recordingKitSlot);
        if (!manifestTranscript) {
          return withAnyVoiceUserCookie(error(`recording kit clip ${recordingKitSlot} is not present in the current manifest`), session);
        }
        if (spec.transcript?.trim() !== manifestTranscript) {
          return withAnyVoiceUserCookie(error(`recording kit clip ${recordingKitSlot} transcript must match the current manifest prompt`), session);
        }
        if (!fixedSlotPairingEvidence(spec, voice.name)) {
          return withAnyVoiceUserCookie(
            error(`recording kit clip ${recordingKitSlot} requires filename/expectedStem slot evidence or clean browser capture settings`),
            session,
          );
        }
      }
      const expectedStem = spec.expectedStem?.trim().toLowerCase();
      if (expectedStem && !voice.name.toLowerCase().includes(expectedStem)) {
        return withAnyVoiceUserCookie(
          error(`voice file for clip ${index + 1} must include ${spec.expectedStem} in its filename`),
          session,
        );
      }
      let sourceKind: VoiceProfileEnrollmentInput["sourceKind"];
      try {
        sourceKind = enrollmentSourceKindForSpec(spec, voice.name);
      } catch (err) {
        return withAnyVoiceUserCookie(error(err instanceof Error ? err.message : "clip sourceKind is invalid"), session);
      }
      preparedClips.push({
        spec: recordingKitSlot ? { ...spec, transcript: recordingKitTranscripts?.get(recordingKitSlot) ?? spec.transcript } : spec,
        fileField,
        voice,
        sourceKind,
        recordingKitSlot,
      });
    }

    for (const { spec, fileField, voice, sourceKind, recordingKitSlot } of preparedClips) {
      const enrollment = await enrollVoiceProfileClip(nanoid(10), {
        voice,
        promptTranscript: spec.transcript!.trim(),
        sourceKind,
        browserCaptureSettings: spec.browserCaptureSettings,
        recordingKitClipId: recordingKitSlot ?? undefined,
        voiceProfileId,
      });
      enrollments.push({ ...enrollment, id: spec.id || fileField });
    }
    const profile = await persistVoiceProfileManifest({ profileId });
    return withAnyVoiceUserCookie(json({ status: "imported", imported: enrollments.length, enrollments, profile }), session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "voice profile import failed";
    return withAnyVoiceUserCookie(json({ status: "error", message, imported: enrollments.length, enrollments }, { status: 500 }), session);
  }
}

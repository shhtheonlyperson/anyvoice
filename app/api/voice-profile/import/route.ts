import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { enrollVoiceProfileClip, type VoiceProfileEnrollmentInput } from "@/lib/profile-enrollment";
import { detectChineseScript, simplifiedOrMixedChineseScriptErrors } from "@/lib/text-prep";
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
}

const SOURCE_KINDS = new Set(["scripted", "freeform", "uploaded"]);

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
      const scriptErrors = simplifiedOrMixedChineseScriptErrors(row.transcript);
      if (scriptErrors.length > 0) {
        throw new Error(
          `clip ${index + 1} transcript must not use Simplified or mixed Chinese; Simplified clips are not accepted for the Traditional Mandarin voice profile (${transcriptScript})`,
        );
      }
      if (row.sourceKind !== undefined && !SOURCE_KINDS.has(String(row.sourceKind))) {
        throw new Error(`clip ${index + 1} has invalid sourceKind`);
      }
      if (row.expectedStem !== undefined && (typeof row.expectedStem !== "string" || !row.expectedStem.trim())) {
        throw new Error(`clip ${index + 1} has invalid expectedStem`);
      }
      return row;
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "clips JSON is invalid");
  }
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

  const enrollments = [];
  try {
    for (let index = 0; index < specsOrResponse.length; index += 1) {
      const spec = specsOrResponse[index];
      const fileField = spec.fileField || `voice-${index}`;
      const voice = form.get(fileField);
      if (!(voice instanceof File)) {
        return withAnyVoiceUserCookie(error(`voice file required for clip ${index + 1}`), session);
      }
      const expectedStem = spec.expectedStem?.trim().toLowerCase();
      if (expectedStem && !voice.name.toLowerCase().includes(expectedStem)) {
        return withAnyVoiceUserCookie(
          error(`voice file for clip ${index + 1} must include ${spec.expectedStem} in its filename`),
          session,
        );
      }
      const sourceKind = SOURCE_KINDS.has(String(spec.sourceKind)) ? (spec.sourceKind as VoiceProfileEnrollmentInput["sourceKind"]) : "uploaded";
      const enrollment = await enrollVoiceProfileClip(nanoid(10), {
        voice,
        promptTranscript: spec.transcript!.trim(),
        sourceKind,
        voiceProfileId,
      });
      enrollments.push({ ...enrollment, id: spec.id || fileField });
    }
    const profile = await persistVoiceProfileManifest({ profileId: voiceProfileId ?? "local-default" });
    return withAnyVoiceUserCookie(json({ status: "imported", imported: enrollments.length, enrollments, profile }), session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "voice profile import failed";
    return withAnyVoiceUserCookie(json({ status: "error", message, imported: enrollments.length, enrollments }, { status: 500 }), session);
  }
}

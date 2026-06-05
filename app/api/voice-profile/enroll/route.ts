import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import {
  enrollVoiceProfileClip,
  isVoiceProfileEnrollmentError,
  parseVoiceProfileEnrollmentForm,
} from "@/lib/profile-enrollment";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";

export const runtime = "nodejs";
export const maxDuration = 120;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return withAnyVoiceUserCookie(json({ status: "error", message: "multipart form data required" }, { status: 400 }), session);
  }

  const input = parseVoiceProfileEnrollmentForm(form);
  if (isVoiceProfileEnrollmentError(input)) {
    return withAnyVoiceUserCookie(json(input.body, { status: input.statusCode }), session);
  }

  const denied = await guardVoiceProfileAccess(session, input.voiceProfileId ?? "local-default");
  if (denied) return denied;

  const jobId = nanoid(10);
  try {
    const enrollment = await enrollVoiceProfileClip(jobId, input);
    const profile = await persistVoiceProfileManifest({ profileId: input.voiceProfileId ?? "local-default" });
    return withAnyVoiceUserCookie(json({ ...enrollment, profile }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "profile enrollment failed";
    return withAnyVoiceUserCookie(json({ status: "error", jobId, message }, { status: 500 }), session);
  }
}

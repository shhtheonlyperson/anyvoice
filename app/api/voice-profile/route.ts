import { NextRequest } from "next/server";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const profileId = new URL(req.url).searchParams.get("profileId")?.trim();
  if (profileId) {
    const denied = await guardVoiceProfileAccess(session, profileId);
    if (denied) return denied;
  }
  const profile = await buildVoiceProfileSummary(profileId ? { profileId } : undefined);
  return withAnyVoiceUserCookie(Response.json({ profile }), session);
}

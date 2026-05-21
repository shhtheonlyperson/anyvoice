import { NextRequest } from "next/server";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const profile = await buildVoiceProfileSummary();
  return withAnyVoiceUserCookie(Response.json({ profile }), session);
}

import { NextRequest } from "next/server";
import { createVoiceProfile, listVoiceProfiles } from "@/lib/voice-profile-registry";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

// List the voice profiles visible to this user (always includes the default).
export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const profiles = await listVoiceProfiles(session.userId);
  return withAnyVoiceUserCookie(Response.json({ profiles }), session);
}

// Create a new, empty named voice profile.
export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(Response.json(data, init), session);

  const body = (await req.json().catch(() => ({}))) as { displayName?: string };
  const displayName = String(body.displayName || "").trim();
  if (!displayName) return reply({ status: "error", message: "profile name required" }, { status: 400 });

  const profile = await createVoiceProfile({ userId: session.userId, displayName });
  return reply({ profile }, { status: 201 });
}

import { NextRequest } from "next/server";
import { deleteVoiceProfile, renameVoiceProfile } from "@/lib/voice-profile-registry";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

// Rename a voice profile (owner only).
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(Response.json(data, init), session);

  const body = (await req.json().catch(() => ({}))) as { displayName?: string };
  const displayName = String(body.displayName || "").trim();
  if (!displayName) return reply({ status: "error", message: "profile name required" }, { status: 400 });

  let profile;
  try {
    profile = await renameVoiceProfile({ id, userId: session.userId, displayName });
  } catch {
    return reply({ status: "error", message: "invalid profile id" }, { status: 400 });
  }
  if (!profile) return reply({ status: "error", message: "profile not found" }, { status: 404 });
  return reply({ profile });
}

// Delete a voice profile and its clips (owner only).
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(Response.json(data, init), session);

  let deleted = false;
  try {
    deleted = await deleteVoiceProfile(id, session.userId);
  } catch {
    return reply({ status: "error", message: "invalid profile id" }, { status: 400 });
  }
  return reply({ deleted });
}

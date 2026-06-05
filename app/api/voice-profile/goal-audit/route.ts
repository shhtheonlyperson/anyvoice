import { NextRequest } from "next/server";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";
import { getVoiceCloneGoalAudit } from "@/lib/voice-clone-goal-audit";

export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readProfileId(req: NextRequest): Promise<string> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return "local-default";
  try {
    const body = (await req.json()) as { profileId?: unknown };
    return typeof body.profileId === "string" ? body.profileId : "local-default";
  } catch {
    return "local-default";
  }
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const profileId = await readProfileId(req);
  const denied = await guardVoiceProfileAccess(session, profileId);
  if (denied) return denied;
  try {
    const audit = await getVoiceCloneGoalAudit({ profileId });
    return withAnyVoiceUserCookie(json({ audit }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not audit voice clone goal";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

import { NextRequest } from "next/server";
import { smokeTestVoiceProfileRecordingKit } from "@/lib/recording-kit";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";

export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readBody(req: NextRequest): Promise<{ manifest: string; profileId: string }> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return { manifest: "", profileId: "local-default" };
  try {
    const body = (await req.json()) as { manifest?: unknown; profileId?: unknown };
    return {
      manifest: typeof body.manifest === "string" ? body.manifest : "",
      profileId: typeof body.profileId === "string" ? body.profileId : "local-default",
    };
  } catch {
    return { manifest: "", profileId: "local-default" };
  }
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const { manifest, profileId } = await readBody(req);
  const denied = await guardVoiceProfileAccess(session, profileId);
  if (denied) return denied;
  try {
    const preflight = await smokeTestVoiceProfileRecordingKit(manifest, profileId);
    return withAnyVoiceUserCookie(json({ preflight }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not run recording kit microphone smoke test";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

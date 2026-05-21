import { NextRequest } from "next/server";
import { createVoiceProfileRecordingKit, getCurrentVoiceProfileRecordingKit } from "@/lib/recording-kit";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readOptions(req: NextRequest): Promise<{ profileId: string; promptSet?: string }> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return { profileId: "local-default" };
  try {
    const body = (await req.json()) as { profileId?: unknown; promptSet?: unknown };
    return {
      profileId: typeof body.profileId === "string" ? body.profileId : "local-default",
      promptSet: typeof body.promptSet === "string" ? body.promptSet : undefined,
    };
  } catch {
    return { profileId: "local-default" };
  }
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const { profileId, promptSet } = await readOptions(req);
  try {
    const kit = await createVoiceProfileRecordingKit(profileId, { promptSet });
    return withAnyVoiceUserCookie(json({ kit }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not create recording kit";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const profileId = new URL(req.url).searchParams.get("profileId") || "local-default";
  try {
    const kit = await getCurrentVoiceProfileRecordingKit(profileId);
    return withAnyVoiceUserCookie(json({ kit }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not load current recording kit";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

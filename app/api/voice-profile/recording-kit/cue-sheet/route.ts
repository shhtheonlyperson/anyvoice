import { NextRequest } from "next/server";
import { readCurrentVoiceProfileRecordingKitCueSheet, readVoiceProfileRecordingKitCueSheet } from "@/lib/recording-kit";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";

export const runtime = "nodejs";

function html(data: string, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(data, {
    ...init,
    headers,
  });
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const params = new URL(req.url).searchParams;
  const profileId = params.get("profileId") || "local-default";
  const manifest = params.get("manifest");
  const denied = await guardVoiceProfileAccess(session, profileId);
  if (denied) return denied;
  try {
    const cueSheet = manifest
      ? await readVoiceProfileRecordingKitCueSheet(manifest, profileId)
      : await readCurrentVoiceProfileRecordingKitCueSheet(profileId);
    return withAnyVoiceUserCookie(html(cueSheet.html), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not load recording kit cue sheet";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 404 }), session);
  }
}

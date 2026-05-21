import { NextRequest } from "next/server";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { validateVoiceProfileTranscripts } from "@/lib/voice-profile-transcript-validation";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readBody(req: NextRequest): Promise<{ profileId: string }> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return { profileId: "local-default" };
  try {
    const body = (await req.json()) as { profileId?: unknown };
    return {
      profileId: typeof body.profileId === "string" ? body.profileId : "local-default",
    };
  } catch {
    return { profileId: "local-default" };
  }
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const { profileId } = await readBody(req);
  try {
    const validation = await validateVoiceProfileTranscripts({ profileId });
    return withAnyVoiceUserCookie(json({ validation }), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not validate profile transcripts";
    if (message.includes("profile has no selected clips to validate")) {
      return withAnyVoiceUserCookie(
        json({
          validation: {
            validationJson: "",
            total: 0,
            passed: 0,
            failed: 0,
            status: "blocked",
            backend: "none",
            message,
          },
        }),
        session,
      );
    }
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

import { NextRequest } from "next/server";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { getVoiceProfileNextStep } from "@/lib/voice-profile-next-step";
import { verifyVoiceProfileReadiness } from "@/lib/voice-profile-verify";

export const runtime = "nodejs";

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
    const verification = await verifyVoiceProfileReadiness({ profileId, requireTranscriptValidation: true });
    try {
      const nextStep = await getVoiceProfileNextStep({ profileId });
      return withAnyVoiceUserCookie(json({ verification: { ...verification, nextStep } }), session);
    } catch (error) {
      const nextStepError = error instanceof Error ? error.message : "could not inspect next voice profile step";
      return withAnyVoiceUserCookie(json({ verification: { ...verification, nextStepError } }), session);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not verify voice profile";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

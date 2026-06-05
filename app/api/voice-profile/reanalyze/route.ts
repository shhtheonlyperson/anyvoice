import { NextRequest } from "next/server";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";
import { reanalyzeVoiceProfileRuns } from "@/lib/voice-profile-reanalysis";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readBody(req: NextRequest): Promise<{ profileId: string; dryRun: boolean; force: boolean }> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return { profileId: "local-default", dryRun: false, force: false };
  try {
    const body = (await req.json()) as { profileId?: unknown; dryRun?: unknown; force?: unknown };
    return {
      profileId: typeof body.profileId === "string" ? body.profileId : "local-default",
      dryRun: body.dryRun === true,
      force: body.force === true,
    };
  } catch {
    return { profileId: "local-default", dryRun: false, force: false };
  }
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const options = await readBody(req);
  const denied = await guardVoiceProfileAccess(session, options.profileId);
  if (denied) return denied;
  try {
    const result = await reanalyzeVoiceProfileRuns(options);
    return withAnyVoiceUserCookie(json(result), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not reanalyze voice profile runs";
    return withAnyVoiceUserCookie(json({ status: "error", message }, { status: 500 }), session);
  }
}

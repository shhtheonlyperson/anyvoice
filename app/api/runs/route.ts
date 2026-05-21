import { NextRequest } from "next/server";
import { deleteRunForUser, listRunsForUser } from "@/lib/run-history";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

function json(data: unknown, init: ResponseInit | undefined, req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  return withAnyVoiceUserCookie(Response.json(data, init), session);
}

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "20");
  const items = await listRunsForUser(session.userId, Number.isFinite(limit) ? limit : 20);

  return withAnyVoiceUserCookie(Response.json({ items }), session);
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    return json({ status: "error", message: "run id required" }, { status: 400 }, req);
  }

  const session = getOrCreateAnyVoiceUserSession(req);
  const deleted = await deleteRunForUser(session.userId, id);
  return withAnyVoiceUserCookie(Response.json({ deleted }), session);
}

import { NextRequest } from "next/server";
import { loadBookMeta, loadProgress, retryErroredSegments, setBookStatus } from "@/lib/book-job";
import { startBookSynthesis } from "@/lib/book-synthesizer";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(Response.json(data, init), session);

  const meta = await loadBookMeta(id);
  if (!meta || meta.userId !== session.userId) {
    return reply({ status: "error", message: "book not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action === "pause") {
    const progress = await setBookStatus(id, "paused");
    return reply({ progress });
  }
  if (body.action === "resume") {
    // Resume also retries any failed segments (e.g. a transient worker hiccup).
    const progress = await retryErroredSegments(id);
    startBookSynthesis(id);
    return reply({ progress });
  }
  return reply({ status: "error", message: "action must be 'pause' or 'resume'" }, { status: 400 });
}

// Convenience for the UI: read-only progress poll.
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  return withAnyVoiceUserCookie(Response.json({ progress: await loadProgress(id) }), session);
}

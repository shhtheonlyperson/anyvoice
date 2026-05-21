import { NextRequest } from "next/server";
import {
  etaSeconds,
  loadBookMeta,
  loadProgress,
  retryErroredSegments,
  setBookStatus,
  setFocusChapter,
} from "@/lib/book-job";
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

  const body = (await req.json().catch(() => ({}))) as { action?: string; chapter?: number };
  if (body.action === "pause") {
    const progress = await setBookStatus(id, "paused");
    return reply({ progress, eta: progress ? etaSeconds(progress, meta.chapters) : null });
  }
  if (body.action === "resume") {
    // Resume also retries any failed segments (e.g. a transient worker hiccup).
    const progress = await retryErroredSegments(id);
    startBookSynthesis(id);
    return reply({ progress, eta: progress ? etaSeconds(progress, meta.chapters) : null });
  }
  if (body.action === "focus") {
    // Prioritize the clicked chapter (and synthesize an extra on demand).
    const progress = await setFocusChapter(id, typeof body.chapter === "number" ? body.chapter : null);
    startBookSynthesis(id);
    return reply({ progress, eta: progress ? etaSeconds(progress, meta.chapters) : null });
  }
  return reply({ status: "error", message: "action must be 'pause', 'resume', or 'focus'" }, { status: 400 });
}

// Read-only progress poll for the UI (includes ETA).
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const meta = await loadBookMeta(id);
  const progress = await loadProgress(id);
  const eta = progress && meta ? etaSeconds(progress, meta.chapters) : null;
  return withAnyVoiceUserCookie(Response.json({ progress, eta }), session);
}

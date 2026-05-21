import { NextRequest } from "next/server";
import { deleteBook, etaSeconds, loadBookMeta, loadProgress, loadSegments } from "@/lib/book-job";
import { startBookSynthesis } from "@/lib/book-synthesizer";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const meta = await loadBookMeta(id);
  if (!meta || meta.userId !== session.userId) {
    return withAnyVoiceUserCookie(Response.json({ status: "error", message: "book not found" }, { status: 404 }), session);
  }
  const progress = await loadProgress(id);
  if (progress?.status === "synthesizing" && progress.autoResume !== false) startBookSynthesis(id); // resume on open
  const eta = progress ? etaSeconds(progress, meta.chapters) : null;
  // Segment texts are sent once on open (not on every poll) for follow-along display.
  const segments = await loadSegments(id);
  return withAnyVoiceUserCookie(Response.json({ book: meta, progress, segments, eta }), session);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const deleted = await deleteBook(id, session.userId);
  return withAnyVoiceUserCookie(Response.json({ deleted }), session);
}

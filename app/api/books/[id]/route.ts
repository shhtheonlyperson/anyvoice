import { NextRequest } from "next/server";
import { deleteBook, loadBookMeta, loadProgress } from "@/lib/book-job";
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
  return withAnyVoiceUserCookie(Response.json({ book: meta, progress }), session);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = getOrCreateAnyVoiceUserSession(req);
  const deleted = await deleteBook(id, session.userId);
  return withAnyVoiceUserCookie(Response.json({ deleted }), session);
}

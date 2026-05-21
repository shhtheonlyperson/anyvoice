import { NextRequest } from "next/server";
import { extractBook } from "@/lib/book-extract";
import { segmentBook } from "@/lib/book-segment";
import { createBook, listBooks } from "@/lib/book-job";
import { startBookSynthesis } from "@/lib/book-synthesizer";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const books = await listBooks(session.userId);
  return withAnyVoiceUserCookie(Response.json({ books }), session);
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const fail = (status: number, message: string) =>
    withAnyVoiceUserCookie(Response.json({ status: "error", message }, { status }), session);

  // The book is read in your voice — require a ready profile first.
  const profile = await buildVoiceProfileSummary();
  if (profile.status !== "ready" || profile.clips.length === 0) {
    return fail(409, "build your voice first: a ready voice profile is required to synthesize a book");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "expected multipart form-data with a file");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "upload an .epub or .pdf file");

  let extracted;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    extracted = await extractBook(file.name, bytes, file.type);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : "could not read the book file");
  }

  const segmented = segmentBook(extracted.chapters);
  if (segmented.segments.length === 0) return fail(400, "the book contained no readable text");

  const meta = await createBook({
    userId: session.userId,
    title: extracted.title,
    format: extracted.chapters.length > 1 || file.name.toLowerCase().endsWith(".epub") ? "epub" : "pdf",
    voiceProfileId: profile.voiceProfileId,
    segmented,
  });

  startBookSynthesis(meta.id);
  return withAnyVoiceUserCookie(Response.json({ book: meta }, { status: 201 }), session);
}

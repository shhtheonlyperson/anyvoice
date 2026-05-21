import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { NextRequest } from "next/server";
import { loadBookMeta, segmentAudioPath } from "@/lib/book-job";
import { readAnyVoiceUserId } from "@/lib/user-session";

export const runtime = "nodejs";

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await context.params;
  const meta = await loadBookMeta(id);
  if (!meta || meta.userId !== readAnyVoiceUserId(req)) {
    return new Response("not found", { status: 404 });
  }
  const segIndex = Number(index);
  if (!Number.isInteger(segIndex) || segIndex < 0 || segIndex >= meta.segmentCount) {
    return new Response("not found", { status: 404 });
  }

  const filePath = segmentAudioPath(id, segIndex);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    // Segment not synthesized yet — let the client poll progress and retry.
    return new Response("segment not ready", { status: 404 });
  }

  const base: Record<string, string> = {
    "Content-Type": "audio/mp4",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  };
  const range = parseRange(req.headers.get("range"), size);
  if (range) {
    const stream = createReadStream(filePath, { start: range.start, end: range.end });
    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) },
    });
  }
  return new Response(createReadStream(filePath) as unknown as BodyInit, {
    headers: { ...base, "Content-Length": String(size) },
  });
}

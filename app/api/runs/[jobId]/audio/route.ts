import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { NextRequest } from "next/server";
import { findRunById } from "@/lib/run-history";
import { safeRunFile } from "@/lib/run-paths";
import { readAnyVoiceUserId } from "@/lib/user-session";
import {
  isWorkerMode,
  isWorkerProxyConfigured,
  workerAudioUrl,
  workerAuthFailure,
  workerAuthHeaders,
  workerToken,
} from "@/lib/worker-proxy";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;

  const rangeHeader = _req.headers.get("range");

  if (isWorkerProxyConfigured()) {
    const url = workerAudioUrl(jobId);
    if (!url || !workerToken()) {
      return new Response("worker audio proxy is not configured", { status: 500 });
    }

    // Forward the client's Range header so progressive playback / seeking works
    // through the proxy too.
    const upstreamHeaders = new Headers(workerAuthHeaders());
    if (rangeHeader) upstreamHeaders.set("Range", rangeHeader);
    const response = await fetch(url, { headers: upstreamHeaders, cache: "no-store" });
    const headers = new Headers({
      "Content-Type": response.headers.get("content-type") || "audio/wav",
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    const contentRange = response.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  const workerMode = isWorkerMode();
  if (workerMode) {
    const authFailure = workerAuthFailure(_req);
    if (authFailure) {
      return new Response(authFailure.body.message, { status: authFailure.statusCode });
    }
  }

  if (!workerMode) {
    const owner = await findRunById(jobId);
    if (owner) {
      const userId = readAnyVoiceUserId(_req);
      if (!userId || owner.userId !== userId) {
        return new Response("audio not found", { status: 404 });
      }
    }
  }

  // Default to the small AAC/m4a for fast streaming playback; ?format=wav
  // serves the lossless WAV (used by the download button). Fall back to WAV
  // if the compressed file wasn't produced (e.g. ffmpeg unavailable).
  const wantWav = new URL(_req.url).searchParams.get("format") === "wav";
  let outputPath = safeRunFile(jobId, "output.wav");
  let contentType = "audio/wav";
  if (!wantWav) {
    const m4aPath = safeRunFile(jobId, "output.m4a");
    try {
      await stat(m4aPath);
      outputPath = m4aPath;
      contentType = "audio/mp4";
    } catch {
      /* compressed file missing — serve WAV */
    }
  }

  let size: number;
  try {
    size = (await stat(outputPath)).size;
  } catch {
    return new Response("audio not found", { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=3600",
    // Advertise range support so the browser can play progressively and seek
    // without downloading the whole file first.
    "Accept-Ranges": "bytes",
  };

  const range = parseRange(rangeHeader, size);
  if (range) {
    const { start, end } = range;
    const stream = createReadStream(outputPath, { start, end });
    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  if (rangeHeader && !range) {
    // Malformed / unsatisfiable range.
    return new Response("range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const stream = createReadStream(outputPath);
  return new Response(stream as unknown as BodyInit, {
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

// Parse a single "bytes=start-end" range against the file size.
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start < 0 || start >= size) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

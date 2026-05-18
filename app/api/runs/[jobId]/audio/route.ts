import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { NextRequest } from "next/server";
import { safeRunFile } from "@/lib/run-paths";
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

  if (isWorkerProxyConfigured()) {
    const url = workerAudioUrl(jobId);
    if (!url || !workerToken()) {
      return new Response("worker audio proxy is not configured", { status: 500 });
    }

    const response = await fetch(url, {
      headers: workerAuthHeaders(),
      cache: "no-store",
    });
    const headers = new Headers({
      "Content-Type": response.headers.get("content-type") || "audio/wav",
      "Cache-Control": "private, max-age=3600",
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  if (isWorkerMode()) {
    const authFailure = workerAuthFailure(_req);
    if (authFailure) {
      return new Response(authFailure.body.message, { status: authFailure.statusCode });
    }
  }

  const outputPath = safeRunFile(jobId, "output.wav");

  try {
    const info = await stat(outputPath);
    const stream = createReadStream(outputPath);
    return new Response(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("audio not found", { status: 404 });
  }
}

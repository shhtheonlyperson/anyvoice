import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { NextRequest } from "next/server";
import { safeRunFile } from "@/lib/run-paths";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
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

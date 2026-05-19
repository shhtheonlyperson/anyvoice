import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { shouldReturnWorkerMissing } from "@/lib/clone-config";
import { cloneInputToFormData, isCloneInputError, parseCloneForm } from "@/lib/clone-request";
import { localCloneStreamResponse, workerMissingStreamResponse } from "@/lib/clone-stream";
import { isWorkerProxyConfigured, workerAuthHeaders, workerCloneStreamUrl, workerToken } from "@/lib/worker-proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function forwardStreamToWorker(input: ReturnType<typeof parseCloneForm>) {
  if (isCloneInputError(input)) {
    return json(input.body, { status: input.statusCode });
  }

  const url = workerCloneStreamUrl();
  if (!url) {
    return json({ status: "error", message: "ANYVOICE_WORKER_URL is invalid" }, { status: 500 });
  }
  if (!workerToken()) {
    return json({ status: "error", message: "ANYVOICE_WORKER_TOKEN is required when ANYVOICE_WORKER_URL is set" }, { status: 500 });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: workerAuthHeaders(),
      body: cloneInputToFormData(input),
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/x-ndjson")) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (contentType.includes("application/json")) {
      return new Response(await response.text(), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await response.text();
    return json(
      {
        status: "error",
        message: body || "worker stream request failed",
      },
      { status: response.ok ? 502 : response.status },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker stream request failed";
    return json({ status: "error", message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ status: "error", message: "multipart form data required" }, { status: 400 });
  }

  const input = parseCloneForm(form);

  if (isWorkerProxyConfigured()) {
    return forwardStreamToWorker(input);
  }
  if (isCloneInputError(input)) {
    return json(input.body, { status: input.statusCode });
  }

  const jobId = nanoid(10);
  if (shouldReturnWorkerMissing()) {
    return workerMissingStreamResponse(jobId, input);
  }

  return localCloneStreamResponse(jobId, input);
}

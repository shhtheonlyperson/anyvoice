import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { shouldReturnWorkerMissing } from "@/lib/clone-config";
import { cloneInputToFormData, isCloneInputError, type CloneInput, type CloneInputError } from "@/lib/clone-request";
import { localCloneStreamResponse, workerMissingStreamResponse } from "@/lib/clone-stream";
import { parseCloneFormWithProfile } from "@/lib/profile-clone-input";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { isWorkerProxyConfigured, workerAuthHeaders, workerCloneStreamUrl, workerToken } from "@/lib/worker-proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function forwardStreamToWorker(input: CloneInput | CloneInputError) {
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
  const session = getOrCreateAnyVoiceUserSession(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return withAnyVoiceUserCookie(json({ status: "error", message: "multipart form data required" }, { status: 400 }), session);
  }

  const input = await parseCloneFormWithProfile(form);

  if (isWorkerProxyConfigured()) {
    return withAnyVoiceUserCookie(await forwardStreamToWorker(input), session);
  }
  if (isCloneInputError(input)) {
    return withAnyVoiceUserCookie(json(input.body, { status: input.statusCode }), session);
  }

  const jobId = nanoid(10);
  if (shouldReturnWorkerMissing()) {
    return withAnyVoiceUserCookie(workerMissingStreamResponse(jobId, input, { userId: session.userId }), session);
  }

  return withAnyVoiceUserCookie(localCloneStreamResponse(jobId, input, { userId: session.userId }), session);
}

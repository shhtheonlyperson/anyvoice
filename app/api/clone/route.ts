import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { shouldReturnWorkerMissing } from "@/lib/clone-config";
import { cloneInputToFormData, isCloneInputError, type CloneInput, type CloneInputError } from "@/lib/clone-request";
import {
  hasPreferredExternalProfileBackend,
  recordCloneError,
  recordWorkerMissingRun,
  runLocalClone,
  workerMissingPayload,
} from "@/lib/clone-runner";
import { parseCloneFormWithProfile } from "@/lib/profile-clone-input";
import {
  createErrorHistoryRecord,
  createReadyHistoryRecord,
  createWorkerMissingHistoryRecord,
  saveRunHistory,
} from "@/lib/run-history";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";
import { isWorkerProxyConfigured, workerAuthHeaders, workerCloneUrl, workerToken } from "@/lib/worker-proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function forwardToWorker(input: CloneInput | CloneInputError) {
  if (isCloneInputError(input)) {
    return json(input.body, { status: input.statusCode });
  }

  const url = workerCloneUrl();
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
    const body = await response.text();

    if (contentType.includes("application/json")) {
      return new Response(body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return json(
      {
        status: "error",
        message: body || "worker request failed",
      },
      { status: response.ok ? 502 : response.status },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker request failed";
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

  const requestedProfileId = String(form.get("profileId") || "").trim();
  if (requestedProfileId) {
    const denied = await guardVoiceProfileAccess(session, requestedProfileId);
    if (denied) return denied;
  }

  const input = await parseCloneFormWithProfile(form);

  if (isWorkerProxyConfigured()) {
    return withAnyVoiceUserCookie(await forwardToWorker(input), session);
  }
  if (isCloneInputError(input)) {
    return withAnyVoiceUserCookie(json(input.body, { status: input.statusCode }), session);
  }

  const jobId = nanoid(10);
  if (shouldReturnWorkerMissing() && !hasPreferredExternalProfileBackend(input)) {
    await recordWorkerMissingRun(jobId, input);
    const payload = workerMissingPayload(jobId);
    await saveRunHistory(createWorkerMissingHistoryRecord(session.userId, input, payload)).catch(() => {});
    return withAnyVoiceUserCookie(json(payload), session);
  }

  try {
    const payload = await runLocalClone(jobId, input);
    await saveRunHistory(createReadyHistoryRecord(session.userId, input, payload)).catch(() => {});
    return withAnyVoiceUserCookie(json(payload), session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "synthesis failed";
    await recordCloneError(jobId, message);
    await saveRunHistory(createErrorHistoryRecord(session.userId, jobId, input, message)).catch(() => {});
    return withAnyVoiceUserCookie(json({ status: "error", jobId, message }, { status: 500 }), session);
  }
}

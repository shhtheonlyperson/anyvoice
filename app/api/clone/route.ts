import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { shouldReturnWorkerMissing } from "@/lib/clone-config";
import { cloneInputToFormData, isCloneInputError, parseCloneForm } from "@/lib/clone-request";
import { recordCloneError, recordWorkerMissingRun, runLocalClone, workerMissingPayload } from "@/lib/clone-runner";
import { isWorkerProxyConfigured, workerAuthHeaders, workerCloneUrl, workerToken } from "@/lib/worker-proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function forwardToWorker(input: ReturnType<typeof parseCloneForm>) {
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
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ status: "error", message: "multipart form data required" }, { status: 400 });
  }

  const input = parseCloneForm(form);

  if (isWorkerProxyConfigured()) {
    return forwardToWorker(input);
  }
  if (isCloneInputError(input)) {
    return json(input.body, { status: input.statusCode });
  }

  const jobId = nanoid(10);
  if (shouldReturnWorkerMissing()) {
    await recordWorkerMissingRun(jobId, input);
    return json(workerMissingPayload(jobId));
  }

  try {
    return json(await runLocalClone(jobId, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "synthesis failed";
    await recordCloneError(jobId, message);
    return json({ status: "error", jobId, message }, { status: 500 });
  }
}

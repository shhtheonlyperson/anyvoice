import { modelId } from "@/lib/clone-config";
import type { CloneInput } from "@/lib/clone-request";
import {
  recordCloneError,
  recordWorkerMissingRun,
  runLocalCloneWithProgress,
  workerMissingPayload,
  type CloneProgressPayload,
  type CloneReadyPayload,
  type CloneWorkerMissingPayload,
} from "@/lib/clone-runner";

export interface CloneErrorPayload {
  status: "error";
  jobId: string;
  modelId: string;
  message: string;
}

export type CloneStreamPayload =
  | CloneProgressPayload
  | CloneReadyPayload
  | CloneWorkerMissingPayload
  | CloneErrorPayload;

function streamHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  };
}

function enqueueJson(controller: ReadableStreamDefaultController<Uint8Array>, payload: CloneStreamPayload) {
  controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

export function localCloneStreamResponse(jobId: string, input: CloneInput): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: CloneStreamPayload) => enqueueJson(controller, payload);
        try {
          const payload = await runLocalCloneWithProgress(jobId, input, send);
          send(payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "synthesis failed";
          await recordCloneError(jobId, message);
          send({ status: "error", jobId, modelId: modelId(), message });
        } finally {
          controller.close();
        }
      },
    }),
    { headers: streamHeaders() },
  );
}

export function workerMissingStreamResponse(jobId: string, input: CloneInput): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        enqueueJson(controller, {
          status: "progress",
          jobId,
          modelId: modelId(),
          phase: "queued",
        });
        await recordWorkerMissingRun(jobId, input);
        enqueueJson(controller, workerMissingPayload(jobId));
        controller.close();
      },
    }),
    { headers: streamHeaders() },
  );
}

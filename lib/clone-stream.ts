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
import {
  createErrorHistoryRecord,
  createReadyHistoryRecord,
  createWorkerMissingHistoryRecord,
  saveRunHistory,
} from "@/lib/run-history";

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

export interface CloneStreamOptions {
  userId?: string;
}

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

async function saveHistoryBestEffort(recordPromise: Promise<unknown>): Promise<void> {
  await recordPromise.catch(() => {});
}

export function localCloneStreamResponse(jobId: string, input: CloneInput, options: CloneStreamOptions = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: CloneStreamPayload) => enqueueJson(controller, payload);
        try {
          const payload = await runLocalCloneWithProgress(jobId, input, send);
          if (options.userId) {
            await saveHistoryBestEffort(saveRunHistory(createReadyHistoryRecord(options.userId, input, payload)));
          }
          send(payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : "synthesis failed";
          await recordCloneError(jobId, message);
          if (options.userId) {
            await saveHistoryBestEffort(
              saveRunHistory(createErrorHistoryRecord(options.userId, jobId, input, message)),
            );
          }
          send({ status: "error", jobId, modelId: modelId(), message });
        } finally {
          controller.close();
        }
      },
    }),
    { headers: streamHeaders() },
  );
}

export function workerMissingStreamResponse(jobId: string, input: CloneInput, options: CloneStreamOptions = {}): Response {
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
        const payload = workerMissingPayload(jobId);
        if (options.userId) {
          await saveHistoryBestEffort(saveRunHistory(createWorkerMissingHistoryRecord(options.userId, input, payload)));
        }
        enqueueJson(controller, payload);
        controller.close();
      },
    }),
    { headers: streamHeaders() },
  );
}

import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { isWorkerEnabled } from "@/lib/clone-config";
import { isCloneInputError, parseCloneForm } from "@/lib/clone-request";
import { recordCloneError, runLocalClone } from "@/lib/clone-runner";
import { workerAuthFailure } from "@/lib/worker-proxy";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function POST(req: NextRequest) {
  const authFailure = workerAuthFailure(req);
  if (authFailure) {
    return json(authFailure.body, { status: authFailure.statusCode });
  }
  if (!isWorkerEnabled()) {
    return json(
      {
        status: "error",
        message:
          "local VoxCPM2 worker is not enabled. Set ANYVOICE_ENABLE_LOCAL_VOXCPM=1, ANYVOICE_STUB=0, and ANYVOICE_VOXCPM_PYTHON.",
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ status: "error", message: "multipart form data required" }, { status: 400 });
  }

  const input = parseCloneForm(form);
  if (isCloneInputError(input)) {
    return json(input.body, { status: input.statusCode });
  }

  const jobId = nanoid(10);
  try {
    return json(await runLocalClone(jobId, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "synthesis failed";
    await recordCloneError(jobId, message);
    return json({ status: "error", jobId, message }, { status: 500 });
  }
}

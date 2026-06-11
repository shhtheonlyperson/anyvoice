import { NextRequest } from "next/server";
import { createVoiceProfile, listVoiceProfiles } from "@/lib/voice-profile-registry";
import { ANYVOICE_USER_HEADER, getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { isWorkerMode, isWorkerProxyConfigured, workerApiUrl, workerAuthFailure, workerAuthHeaders, workerToken } from "@/lib/worker-proxy";

export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

async function forwardProfilesToWorker(req: NextRequest, session: ReturnType<typeof getOrCreateAnyVoiceUserSession>) {
  const url = workerApiUrl("/api/voice-profile/profiles");
  if (!url) return json({ status: "error", message: "ANYVOICE_WORKER_URL is invalid" }, { status: 500 });
  if (!workerToken()) {
    return json({ status: "error", message: "ANYVOICE_WORKER_TOKEN is required when ANYVOICE_WORKER_URL is set" }, { status: 500 });
  }

  const headers = new Headers(workerAuthHeaders());
  headers.set(ANYVOICE_USER_HEADER, session.userId);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  try {
    const response = await fetch(url, { method: req.method, headers, body, cache: "no-store" });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker request failed";
    return json({ status: "error", message }, { status: 502 });
  }
}

// In worker mode the proxy already enforces Bearer auth; re-check in-handler
// (like the clone/audio routes) so identity never rests on middleware matching.
function workerModeAuthFailureResponse(req: NextRequest): Response | null {
  if (!isWorkerMode()) return null;
  const authFailure = workerAuthFailure(req);
  if (!authFailure) return null;
  return json(authFailure.body, { status: authFailure.statusCode });
}

// List the voice profiles visible to this user (always includes the default).
export async function GET(req: NextRequest) {
  const denied = workerModeAuthFailureResponse(req);
  if (denied) return denied;
  const session = getOrCreateAnyVoiceUserSession(req);
  if (isWorkerProxyConfigured() && !isWorkerMode()) {
    return withAnyVoiceUserCookie(await forwardProfilesToWorker(req, session), session);
  }
  const profiles = await listVoiceProfiles(session.userId);
  return withAnyVoiceUserCookie(Response.json({ profiles }), session);
}

// Create a new, empty named voice profile.
export async function POST(req: NextRequest) {
  const denied = workerModeAuthFailureResponse(req);
  if (denied) return denied;
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(Response.json(data, init), session);

  if (isWorkerProxyConfigured() && !isWorkerMode()) {
    return withAnyVoiceUserCookie(await forwardProfilesToWorker(req, session), session);
  }

  const body = (await req.json().catch(() => ({}))) as { displayName?: string };
  const displayName = String(body.displayName || "").trim();
  if (!displayName) return reply({ status: "error", message: "profile name required" }, { status: 400 });

  const profile = await createVoiceProfile({ userId: session.userId, displayName });
  return reply({ profile }, { status: 201 });
}

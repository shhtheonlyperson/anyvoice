import { timingSafeEqual } from "node:crypto";

export interface WorkerEnv {
  [key: string]: string | undefined;
  ANYVOICE_WORKER_URL?: string;
  ANYVOICE_WORKER_TOKEN?: string;
}

export interface WorkerAuthFailure {
  statusCode: 401 | 503;
  body: {
    status: "error";
    message: string;
  };
}

const KNOWN_CLONE_ENDPOINTS = ["/api/local-worker/clone", "/api/clone"];

export function workerToken(env: WorkerEnv = process.env): string {
  return (env.ANYVOICE_WORKER_TOKEN || "").trim();
}

function configuredWorkerUrl(env: WorkerEnv = process.env): string {
  return (env.ANYVOICE_WORKER_URL || "").trim();
}

function stripKnownCloneEndpoint(url: URL): URL {
  const pathname = url.pathname.replace(/\/+$/, "");
  for (const endpoint of KNOWN_CLONE_ENDPOINTS) {
    if (pathname.endsWith(endpoint)) {
      url.pathname = pathname.slice(0, -endpoint.length) || "/";
      url.search = "";
      url.hash = "";
      return url;
    }
  }
  return url;
}

export function workerBaseUrl(env: WorkerEnv = process.env): string {
  const raw = configuredWorkerUrl(env);
  if (!raw) return "";

  try {
    const url = stripKnownCloneEndpoint(new URL(raw));
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function joinWorkerPath(base: string, pathname: string): string {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function isWorkerProxyConfigured(env: WorkerEnv = process.env): boolean {
  return Boolean(configuredWorkerUrl(env));
}

export function workerCloneUrl(env: WorkerEnv = process.env): string {
  const raw = configuredWorkerUrl(env);
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (KNOWN_CLONE_ENDPOINTS.some((endpoint) => pathname.endsWith(endpoint))) {
      return url.toString();
    }
  } catch {
    return "";
  }

  const base = workerBaseUrl(env);
  return base ? joinWorkerPath(base, "/api/local-worker/clone") : "";
}

export function workerAudioUrl(jobId: string, env: WorkerEnv = process.env): string {
  const base = workerBaseUrl(env);
  return base ? joinWorkerPath(base, `/api/runs/${encodeURIComponent(jobId)}/audio`) : "";
}

export function workerAuthHeaders(env: WorkerEnv = process.env): HeadersInit {
  const token = workerToken(env);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function workerAuthFailure(request: Request, env: WorkerEnv = process.env): WorkerAuthFailure | null {
  const expected = workerToken(env);
  if (!expected) {
    return {
      statusCode: 503,
      body: { status: "error", message: "ANYVOICE_WORKER_TOKEN is required for the local worker" },
    };
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const actual = match?.[1]?.trim() || "";
  if (!constantTimeEqual(actual, expected)) {
    return { statusCode: 401, body: { status: "error", message: "unauthorized" } };
  }

  return null;
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

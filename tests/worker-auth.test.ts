import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  isWorkerProxyConfigured,
  workerAudioUrl,
  workerAuthFailure,
  workerAuthHeaders,
  workerBaseUrl,
  workerCloneUrl,
} from "@/lib/worker-proxy";

describe("constantTimeEqual", () => {
  it("rejects empty actual", () => {
    expect(constantTimeEqual("", "expected")).toBe(false);
  });

  it("rejects empty expected", () => {
    expect(constantTimeEqual("actual", "")).toBe(false);
  });

  it("rejects length mismatch", () => {
    expect(constantTimeEqual("short", "longer-token")).toBe(false);
  });

  it("accepts identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects same-length different strings", () => {
    expect(constantTimeEqual("aaaaaa", "bbbbbb")).toBe(false);
  });
});

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.authorization = authHeader;
  return new Request("http://localhost/x", { method: "POST", headers });
}

describe("workerAuthFailure", () => {
  it("returns 503 when ANYVOICE_WORKER_TOKEN is not set", () => {
    const req = makeRequest("Bearer anything");
    const result = workerAuthFailure(req, {});
    expect(result).not.toBeNull();
    expect(result?.statusCode).toBe(503);
    expect(result?.body.status).toBe("error");
    expect(result?.body.message).toMatch(/ANYVOICE_WORKER_TOKEN/);
  });

  it("returns 401 when Authorization header is missing", () => {
    const req = makeRequest();
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "secret" });
    expect(result?.statusCode).toBe(401);
    expect(result?.body.message).toBe("unauthorized");
  });

  it("returns 401 when Authorization header is blank", () => {
    const req = makeRequest("");
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "secret" });
    expect(result?.statusCode).toBe(401);
  });

  it("returns 401 when header has no Bearer prefix", () => {
    const req = makeRequest("Basic abc");
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "secret" });
    expect(result?.statusCode).toBe(401);
  });

  it("returns 401 when bearer token is wrong", () => {
    const req = makeRequest("Bearer wrong-token");
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "right-token" });
    expect(result?.statusCode).toBe(401);
  });

  it("returns null when bearer token matches", () => {
    const req = makeRequest("Bearer right-token");
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "right-token" });
    expect(result).toBeNull();
  });

  it("accepts case-insensitive Bearer prefix", () => {
    const req = makeRequest("bearer right-token");
    const result = workerAuthFailure(req, { ANYVOICE_WORKER_TOKEN: "right-token" });
    expect(result).toBeNull();
  });
});

describe("workerAuthHeaders", () => {
  it("returns Authorization header when token is present", () => {
    expect(workerAuthHeaders({ ANYVOICE_WORKER_TOKEN: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("returns empty headers when token is absent", () => {
    expect(workerAuthHeaders({})).toEqual({});
  });
});

describe("workerBaseUrl & workerCloneUrl & workerAudioUrl edge cases", () => {
  it("returns empty when worker URL is unset", () => {
    expect(workerBaseUrl({})).toBe("");
    expect(workerCloneUrl({})).toBe("");
    expect(workerAudioUrl("id", {})).toBe("");
    expect(isWorkerProxyConfigured({})).toBe(false);
  });

  it("returns empty when worker URL is malformed", () => {
    expect(workerBaseUrl({ ANYVOICE_WORKER_URL: "not-a-url" })).toBe("");
  });

  it("isWorkerProxyConfigured is true when URL is set", () => {
    expect(isWorkerProxyConfigured({ ANYVOICE_WORKER_URL: "https://x.example" })).toBe(true);
  });

  it("strips /api/clone endpoint to derive base", () => {
    const env = { ANYVOICE_WORKER_URL: "https://w.example/api/clone" };
    expect(workerBaseUrl(env)).toBe("https://w.example");
  });
});

import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  isWorkerMode,
  workerAudioUrl,
  workerApiUrl,
  workerBaseUrl,
  workerCloneStreamUrl,
  workerCloneUrl,
  workerToken,
} from "@/lib/worker-proxy";

describe("worker proxy", () => {
  it("derives clone and audio URLs from a worker base URL", () => {
    const env = { ANYVOICE_WORKER_URL: "https://worker.example" };

    expect(workerBaseUrl(env)).toBe("https://worker.example");
    expect(workerCloneUrl(env)).toBe("https://worker.example/api/local-worker/clone");
    expect(workerCloneStreamUrl(env)).toBe("https://worker.example/api/local-worker/clone/stream");
    expect(workerAudioUrl("abc123", env)).toBe("https://worker.example/api/runs/abc123/audio");
    expect(workerApiUrl("/api/voice-profile/enroll/youtube", env)).toBe(
      "https://worker.example/api/voice-profile/enroll/youtube",
    );
  });

  it("accepts a clone endpoint URL while still deriving the audio base", () => {
    const env = { ANYVOICE_WORKER_URL: "https://worker.example/api/local-worker/clone" };

    expect(workerBaseUrl(env)).toBe("https://worker.example");
    expect(workerCloneUrl(env)).toBe("https://worker.example/api/local-worker/clone");
    expect(workerCloneStreamUrl(env)).toBe("https://worker.example/api/local-worker/clone/stream");
    expect(workerAudioUrl("abc123", env)).toBe("https://worker.example/api/runs/abc123/audio");
  });

  it("accepts a stream endpoint URL directly", () => {
    const env = { ANYVOICE_WORKER_URL: "https://worker.example/api/local-worker/clone/stream" };

    expect(workerBaseUrl(env)).toBe("https://worker.example");
    expect(workerCloneUrl(env)).toBe("https://worker.example/api/local-worker/clone");
    expect(workerCloneStreamUrl(env)).toBe("https://worker.example/api/local-worker/clone/stream");
  });

  it("preserves path-prefixed worker URLs for shared tunnels", () => {
    const env = { ANYVOICE_WORKER_URL: "https://worker.example/anyvoice" };

    expect(workerBaseUrl(env)).toBe("https://worker.example/anyvoice");
    expect(workerCloneUrl(env)).toBe("https://worker.example/anyvoice/api/local-worker/clone");
    expect(workerCloneStreamUrl(env)).toBe("https://worker.example/anyvoice/api/local-worker/clone/stream");
    expect(workerAudioUrl("abc123", env)).toBe("https://worker.example/anyvoice/api/runs/abc123/audio");
  });

  it("keeps the token server-side", () => {
    expect(workerToken({ ANYVOICE_WORKER_TOKEN: " token-value " })).toBe("token-value");
    expect(constantTimeEqual("token-value", "token-value")).toBe(true);
    expect(constantTimeEqual("token-value", "other-value")).toBe(false);
  });

  it("treats worker mode as an explicit opt-in, not implied by a token", () => {
    expect(isWorkerMode({ ANYVOICE_WORKER_TOKEN: "secret" })).toBe(false);
    expect(isWorkerMode({ ANYVOICE_WORKER_MODE: "1" })).toBe(true);
    expect(isWorkerMode({ ANYVOICE_WORKER_MODE: "true" })).toBe(false);
    expect(isWorkerMode({})).toBe(false);
  });
});

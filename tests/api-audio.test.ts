// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/runs/[jobId]/audio/route";

const originalEnv = { ...process.env };
let tmpRoot: string;

function makeContext(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

function makeReq(headers: Record<string, string> = {}): import("next/server").NextRequest {
  return new Request("http://localhost/api/runs/x/audio", {
    method: "GET",
    headers,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-audio-"));
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
  delete process.env.VERCEL;
  delete process.env.ANYVOICE_WORKER_URL;
  delete process.env.ANYVOICE_WORKER_TOKEN;
  delete process.env.ANYVOICE_WORKER_MODE;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
  vi.unstubAllGlobals();
});

describe("GET /api/runs/[jobId]/audio", () => {
  it("returns 200 + audio/wav when the file exists", async () => {
    const runDir = path.join(tmpRoot, "job1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "output.wav"), Buffer.from([1, 2, 3, 4, 5]));
    const res = await GET(makeReq(), makeContext("job1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-length")).toBe("5");
  });

  it("returns 404 when the file is missing", async () => {
    const res = await GET(makeReq(), makeContext("nope"));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("audio not found");
  });

  it("returns 401 when worker mode is on without bearer", async () => {
    process.env.ANYVOICE_WORKER_MODE = "1";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    const res = await GET(makeReq(), makeContext("job2"));
    expect(res.status).toBe(401);
  });

  it("returns 503 when worker mode is on without configured token", async () => {
    process.env.ANYVOICE_WORKER_MODE = "1";
    const res = await GET(makeReq({ authorization: "Bearer x" }), makeContext("job2"));
    expect(res.status).toBe(503);
  });

  it("returns the file when worker mode is on with correct bearer", async () => {
    process.env.ANYVOICE_WORKER_MODE = "1";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    const runDir = path.join(tmpRoot, "job3");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "output.wav"), Buffer.from([9, 9, 9]));
    const res = await GET(makeReq({ authorization: "Bearer secret" }), makeContext("job3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("3");
  });

  it("forwards through fetch when worker proxy is configured", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    process.env.ANYVOICE_WORKER_TOKEN = "secret";
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { "content-type": "audio/wav", "content-length": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(makeReq(), makeContext("remoteJob"));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example/api/runs/remoteJob/audio",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
  });

  it("returns 500 when worker proxy configured but token missing", async () => {
    process.env.ANYVOICE_WORKER_URL = "https://worker.example";
    const res = await GET(makeReq(), makeContext("anyJob"));
    expect(res.status).toBe(500);
  });
});

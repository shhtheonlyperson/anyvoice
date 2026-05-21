// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET } from "@/app/api/runs/route";
import { saveRunHistory, type RunHistoryRecord } from "@/lib/run-history";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";

const originalEnv = { ...process.env };
let tmpRoot: string;

const userA = "av_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "av_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeReq(url: string, userId?: string): import("next/server").NextRequest {
  const headers: HeadersInit = userId
    ? { cookie: `${ANYVOICE_USER_COOKIE}=${encodeURIComponent(userId)}` }
    : {};
  return new Request(url, { headers }) as unknown as import("next/server").NextRequest;
}

function record(id: string, userId: string): RunHistoryRecord {
  return {
    id,
    userId,
    status: "ready",
    modelId: "openbmb/VoxCPM2",
    voiceName: "ref.wav",
    voiceType: "audio/wav",
    voiceSize: 3,
    targetText: `target ${id}`,
    promptTranscript: "reference words",
    quality: "balanced",
    audioUrl: `/api/runs/${id}/audio`,
    createdAt: "2026-05-19T10:00:00.000Z",
    completedAt: "2026-05-19T10:00:00.000Z",
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-api-runs-"));
  process.env.ANYVOICE_HISTORY_FILE = path.join(tmpRoot, "history.json");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("/api/runs", () => {
  it("lists only runs owned by the browser user cookie", async () => {
    await saveRunHistory(record("mine", userA));
    await saveRunHistory(record("other", userB));

    const res = await GET(makeReq("http://localhost/api/runs", userA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["mine"]);
  });

  it("sets a user cookie when the browser has no identity yet", async () => {
    const res = await GET(makeReq("http://localhost/api/runs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
  });

  it("deletes only the current user's run", async () => {
    await saveRunHistory(record("delete-me", userA));
    await saveRunHistory(record("keep-me", userB));

    const res = await DELETE(makeReq("http://localhost/api/runs?id=delete-me", userA));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: true });

    const mine = await GET(makeReq("http://localhost/api/runs", userA));
    expect((await mine.json()).items).toEqual([]);

    const other = await GET(makeReq("http://localhost/api/runs", userB));
    expect((await other.json()).items).toHaveLength(1);
  });

  it("returns 400 when delete is missing an id", async () => {
    const res = await DELETE(makeReq("http://localhost/api/runs", userA));
    expect(res.status).toBe(400);
  });
});

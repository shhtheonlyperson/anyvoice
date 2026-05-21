// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/voice-profile/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";

const originalEnv = { ...process.env };
let tmpRoot: string;

function makeReq(userId?: string): import("next/server").NextRequest {
  const headers: HeadersInit = userId
    ? { cookie: `${ANYVOICE_USER_COOKIE}=${encodeURIComponent(userId)}` }
    : {};
  return new Request("http://localhost/api/voice-profile", { headers }) as unknown as import("next/server").NextRequest;
}

async function writeRun(id: string, grade: string, durationSec: number) {
  const runDir = path.join(tmpRoot, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1]));
  await writeFile(path.join(runDir, "prompt-transcript.txt"), "請錄製一段穩定的真實聲音。", "utf-8");
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify({
      referenceQuality: {
        grade,
        durationSec,
        snrDb: 22,
        clippingRatio: 0,
        vadActiveRatio: 0.7,
        warnings: durationSec < 6 ? ["short_clip"] : [],
      },
    }),
    "utf-8",
  );
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-api-profile-"));
  process.env.ANYVOICE_RUNS_DIR = tmpRoot;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("GET /api/voice-profile", () => {
  it("returns profile readiness from local run evidence", async () => {
    await writeRun("short", "D", 2);
    await writeRun("usable", "A", 8);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    const body = await res.json();

    expect(body.profile.status).toBe("needs_enrollment");
    expect(body.profile.summary.eligibleClips).toBe(1);
    expect(body.profile.summary.rejectedClips).toBe(1);
    expect(body.profile.summary.remainingClipsNeeded).toBe(4);
    expect(body.profile.diagnostics.rejectionReasons).toEqual(
      expect.arrayContaining([{ reason: "grade_d", count: 1 }]),
    );
  });
});

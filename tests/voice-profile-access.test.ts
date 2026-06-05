// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { userCanAccessVoiceProfile } from "@/lib/voice-profile-registry";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";
import type { AnyVoiceUserSession } from "@/lib/user-session";

const OWNER = "av_ea1e0283-229e-439e-b317-2818a58a870b";
const OTHER = "av_4c49a011-8b45-4554-bf57-c8320f03f3c3";

let root: string;
const originalRoot = process.env.ANYVOICE_VOICE_PROFILE_ROOT;

async function writeMeta(id: string, userId?: string): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.json"),
    `${JSON.stringify({ id, displayName: id, ...(userId ? { userId } : {}), createdAt: new Date(0).toISOString() })}\n`,
    "utf-8",
  );
}

function session(userId: string): AnyVoiceUserSession {
  return { userId, shouldSetCookie: false };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "anyvoice-access-"));
  process.env.ANYVOICE_VOICE_PROFILE_ROOT = root;
});

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.ANYVOICE_VOICE_PROFILE_ROOT;
  else process.env.ANYVOICE_VOICE_PROFILE_ROOT = originalRoot;
  await rm(root, { recursive: true, force: true });
});

describe("userCanAccessVoiceProfile", () => {
  it("allows any user for an untagged (legacy/shared) profile", async () => {
    await writeMeta("local-default");
    expect(await userCanAccessVoiceProfile("local-default", OWNER)).toBe(true);
    expect(await userCanAccessVoiceProfile("local-default", OTHER)).toBe(true);
  });

  it("allows any user when no meta.json exists at all", async () => {
    expect(await userCanAccessVoiceProfile("vp_unknown1", OTHER)).toBe(true);
  });

  it("allows the owner but denies a different account for a tagged profile", async () => {
    await writeMeta("vp_owned01", OWNER);
    expect(await userCanAccessVoiceProfile("vp_owned01", OWNER)).toBe(true);
    expect(await userCanAccessVoiceProfile("vp_owned01", OTHER)).toBe(false);
  });

  it("fails open for an unsafe profile id so the route can apply its own validation", async () => {
    expect(await userCanAccessVoiceProfile("../escape", OTHER)).toBe(true);
  });
});

describe("guardVoiceProfileAccess", () => {
  it("returns null when the user owns the profile", async () => {
    await writeMeta("vp_owned02", OWNER);
    expect(await guardVoiceProfileAccess(session(OWNER), "vp_owned02")).toBeNull();
  });

  it("returns a 404 response for a cross-account profile id", async () => {
    await writeMeta("vp_owned03", OWNER);
    const denied = await guardVoiceProfileAccess(session(OTHER), "vp_owned03");
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(404);
    const body = (await denied!.json()) as { status: string };
    expect(body.status).toBe("error");
  });
});

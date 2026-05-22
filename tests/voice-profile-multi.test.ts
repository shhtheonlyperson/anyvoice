// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVoiceProfileSummary, persistVoiceProfileManifest } from "@/lib/voice-profile";
import {
  createVoiceProfile,
  deleteVoiceProfile,
  listVoiceProfiles,
  renameVoiceProfile,
} from "@/lib/voice-profile-registry";

let runsRoot: string;
let voicesRoot: string;

const transcripts = [
  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，世界很安靜。",
  "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
  "如果遇到 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定節奏。",
  "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
  "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
];

async function writeRun(id: string, index: number, voiceProfileId?: string) {
  const runDir = path.join(runsRoot, id);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "reference_16k_mono.wav"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(runDir, "prompt-transcript.txt"), transcripts[index], "utf-8");
  await writeFile(
    path.join(runDir, "request.json"),
    JSON.stringify({ sourceKind: "uploaded", referenceSource: { kind: "uploaded" }, ...(voiceProfileId ? { voiceProfileId } : {}) }),
    "utf-8",
  );
  await writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify({
      model_id: "openbmb/VoxCPM2",
      clone_mode: "hifi",
      referenceQuality: { grade: "A", durationSec: 9, snrDb: 28, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
    }),
    "utf-8",
  );
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-runs-"));
  voicesRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-voices-"));
});
afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
  await rm(voicesRoot, { recursive: true, force: true });
});

describe("multi-profile run filtering", () => {
  it("builds each profile only from its own tagged runs", async () => {
    // 5 runs for vp_a, 5 for vp_b, plus one untagged (belongs to local-default).
    for (let i = 0; i < 5; i += 1) await writeRun(`a${i}`, i, "vp_a");
    for (let i = 0; i < 5; i += 1) await writeRun(`b${i}`, i, "vp_b");
    await writeRun("legacy0", 0); // untagged

    const env = { ANYVOICE_RUNS_DIR: runsRoot };
    const a = await buildVoiceProfileSummary({ env, profileId: "vp_a" });
    const b = await buildVoiceProfileSummary({ env, profileId: "vp_b" });
    const def = await buildVoiceProfileSummary({ env, profileId: "local-default" });

    expect(a.status).toBe("ready");
    expect(a.summary.selectedClips).toBe(5);
    expect(a.clips.every((c) => c.voiceProfileId === "vp_a")).toBe(true);

    expect(b.status).toBe("ready");
    expect(b.clips.every((c) => c.voiceProfileId === "vp_b")).toBe(true);

    // local-default only sees the single untagged legacy run → not ready.
    expect(def.summary.selectedClips).toBe(1);
    expect(def.status).toBe("needs_enrollment");
  });
});

describe("voice profile registry", () => {
  it("always lists a default profile on a fresh install", async () => {
    const list = await listVoiceProfiles("u1", { ANYVOICE_VOICE_PROFILE_ROOT: voicesRoot });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("local-default");
    expect(list[0].status).toBe("needs_enrollment");
  });

  it("creates, lists, renames, and isolates by user", async () => {
    const env = { ANYVOICE_VOICE_PROFILE_ROOT: voicesRoot };
    const mine = await createVoiceProfile({ userId: "u1", displayName: "Sunny 財經" }, env);
    expect(mine.id).toMatch(/^vp_/);
    await createVoiceProfile({ userId: "u2", displayName: "別人的聲音" }, env);

    const list = await listVoiceProfiles("u1", env);
    const ids = list.map((p) => p.id);
    expect(ids).toContain("local-default");
    expect(ids).toContain(mine.id);
    expect(list.find((p) => p.displayName === "別人的聲音")).toBeUndefined(); // other user's

    const renamed = await renameVoiceProfile({ id: mine.id, userId: "u1", displayName: "我的財經聲音" }, env);
    expect(renamed?.displayName).toBe("我的財經聲音");
    // another user cannot rename it
    expect(await renameVoiceProfile({ id: mine.id, userId: "u2", displayName: "hijack" }, env)).toBeNull();
  });

  it("reports ready status + clip count from the persisted manifest", async () => {
    const env = { ANYVOICE_RUNS_DIR: runsRoot, ANYVOICE_VOICE_PROFILE_ROOT: voicesRoot };
    const meta = await createVoiceProfile({ userId: "u1", displayName: "Voice" }, env);
    for (let i = 0; i < 5; i += 1) await writeRun(`x${i}`, i, meta.id);
    await persistVoiceProfileManifest({ env, profileId: meta.id });

    const list = await listVoiceProfiles("u1", env);
    const item = list.find((p) => p.id === meta.id);
    expect(item?.status).toBe("ready");
    expect(item?.clipCount).toBe(5);
  });

  it("deletes only the owner's profile", async () => {
    const env = { ANYVOICE_VOICE_PROFILE_ROOT: voicesRoot };
    const meta = await createVoiceProfile({ userId: "u1", displayName: "Voice" }, env);
    expect(await deleteVoiceProfile(meta.id, "intruder", env)).toBe(false);
    expect(await deleteVoiceProfile(meta.id, "u1", env)).toBe(true);
    expect((await listVoiceProfiles("u1", env)).find((p) => p.id === meta.id)).toBeUndefined();
  });
});

// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloneInput } from "@/lib/clone-request";
import {
  createReadyHistoryRecord,
  deleteRunForUser,
  historyFilePath,
  listRunsForUser,
  saveRunHistory,
  type RunHistoryRecord,
} from "@/lib/run-history";

const originalEnv = { ...process.env };
let tmpRoot: string;

const userA = "av_11111111-1111-4111-8111-111111111111";
const userB = "av_22222222-2222-4222-8222-222222222222";

function cloneInput(overrides: Partial<CloneInput> = {}): CloneInput {
  return {
    voice: new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }),
    targetText: "hello from history",
    promptTranscript: "reference words",
    quality: "balanced",
    sourceKind: "scripted",
    ...overrides,
  };
}

function record(id: string, userId: string, createdAt: string): RunHistoryRecord {
  return {
    id,
    userId,
    status: "ready",
    modelId: "openbmb/VoxCPM2",
    voiceName: "ref.wav",
    voiceType: "audio/wav",
    voiceSize: 3,
    sourceKind: "scripted",
    targetText: `target ${id}`,
    promptTranscript: "reference words",
    quality: "balanced",
    audioUrl: `/api/runs/${id}/audio`,
    createdAt,
    completedAt: createdAt,
  };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-history-"));
  process.env.ANYVOICE_HISTORY_FILE = path.join(tmpRoot, "history.json");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("run history", () => {
  it("stores ready payloads with the clone input metadata", async () => {
    const payload = {
      status: "ready" as const,
      jobId: "job-ready",
      modelId: "openbmb/VoxCPM2",
      audioUrl: "/api/runs/job-ready/audio",
      referenceQuality: {
        grade: "A" as const,
        durationSec: 8,
        snrDb: 24,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      targetLanguage: "en",
      effectiveParams: { timesteps: 8, cfgValue: 2, denoise: false, qualityPreset: "balanced" as const, cloneMode: "hifi" as const },
    };

    await saveRunHistory(
      createReadyHistoryRecord(
        userA,
        cloneInput({ pronunciationOverrides: [{ term: "AnyVoice", replacement: "Any Voice" }] }),
        payload,
      ),
    );

    const items = await listRunsForUser(userA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "job-ready",
      status: "ready",
      voiceName: "ref.wav",
      sourceKind: "scripted",
      targetText: "hello from history",
      audioUrl: "/api/runs/job-ready/audio",
      pronunciationOverrides: [{ term: "AnyVoice", replacement: "Any Voice" }],
    });
    expect(historyFilePath()).toBe(path.join(tmpRoot, "history.json"));
  });

  it("filters by user and sorts newest first", async () => {
    await saveRunHistory(record("old", userA, "2026-05-18T10:00:00.000Z"));
    await saveRunHistory(record("other", userB, "2026-05-19T10:00:00.000Z"));
    await saveRunHistory(record("new", userA, "2026-05-19T11:00:00.000Z"));

    const items = await listRunsForUser(userA);
    expect(items.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("deletes only the current user's record", async () => {
    await saveRunHistory(record("same-id", userA, "2026-05-19T10:00:00.000Z"));
    await saveRunHistory(record("same-id", userB, "2026-05-19T11:00:00.000Z"));

    await expect(deleteRunForUser(userA, "same-id")).resolves.toBe(true);
    await expect(listRunsForUser(userA)).resolves.toEqual([]);
    await expect(listRunsForUser(userB)).resolves.toHaveLength(1);
  });
});

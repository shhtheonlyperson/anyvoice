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
    expect(items[0].textPreparation?.targetText.raw).toBe("hello from history");
    expect(items[0].textPreparation?.targetText.model).toBe("hello from history");
    expect(items[0].textPreparation?.promptTranscript.model).toBe("reference words");
    expect(historyFilePath()).toBe(path.join(tmpRoot, "history.json"));
  });

  it("stores model-facing text transforms in history for debugging bad generations", async () => {
    const payload = {
      status: "ready" as const,
      jobId: "job-prep",
      modelId: "openbmb/VoxCPM2",
      audioUrl: "/api/runs/job-prep/audio",
      referenceQuality: {
        grade: "A" as const,
        durationSec: 8,
        snrDb: 24,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      targetLanguage: "zh",
      effectiveParams: { timesteps: 8, cfgValue: 2, denoise: false, qualityPreset: "balanced" as const, cloneMode: "hifi" as const },
    };

    await saveRunHistory(
      createReadyHistoryRecord(
        userA,
        cloneInput({
          targetText: "請把重慶和 AnyVoice 讀準。",
          promptTranscript: "請錄製乾淨的聲音。",
        }),
        payload,
      ),
    );

    const [item] = await listRunsForUser(userA);
    expect(item.textPreparation?.targetText.raw).toBe("請把重慶和 AnyVoice 讀準。");
    expect(item.textPreparation?.targetText.model).toContain("重 慶");
    expect(item.textPreparation?.targetText.model).toContain("Any Voice");
    expect(item.textPreparation?.targetText.operations).toContain("auto_apply_pronunciation_presets");
    expect(item.textPreparation?.targetText.pronunciationOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "重慶", replacement: "重 慶", presetId: "polyphone:chongqing" }),
        expect.objectContaining({ term: "AnyVoice", replacement: "Any Voice", presetId: "brand:anyvoice" }),
      ]),
    );
    expect(item.textPreparation?.promptTranscript.raw).toBe("請錄製乾淨的聲音。");
  });

  it("stores the resolved profile reference for debugging profile generations", async () => {
    const payload = {
      status: "ready" as const,
      jobId: "job-profile",
      modelId: "openbmb/VoxCPM2",
      audioUrl: "/api/runs/job-profile/audio",
      referenceQuality: {
        grade: "A" as const,
        durationSec: 8,
        snrDb: 24,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
      targetLanguage: "zh",
      effectiveParams: {
        timesteps: 8,
        cfgValue: 2,
        denoise: false,
        qualityPreset: "balanced" as const,
        cloneMode: "hifi" as const,
        voiceBackend: "indextts2",
        backendSelectionSha256: "a".repeat(64),
      },
    };

    await saveRunHistory(
      createReadyHistoryRecord(
        userA,
        cloneInput({
          sourceKind: "profile",
          profileReference: {
            voiceProfileId: "local-test",
            sourceRunId: "clip-1",
            referenceClipIds: ["clip-1", "clip-2"],
            audioPath: "/tmp/profile/clip-1.wav",
            transcriptScript: "zh_hant",
            coverageFeatures: ["zh_hant", "polyphones"],
            targetCoverageFeatures: ["polyphones"],
            matchedCoverageFeatures: ["polyphones"],
            pronunciationPresetIds: ["polyphone:chongqing"],
            targetPronunciationPresetIds: ["polyphone:chongqing"],
            matchedPronunciationPresetIds: ["polyphone:chongqing"],
            loraPath: "/tmp/profile-lora/lora_weights.ckpt",
            loraAdapter: {
              version: 1,
              status: "accepted",
              profileJson: "/tmp/profile/profile.json",
              voiceProfileId: "local-test",
              profileSha256: "c".repeat(64),
              path: "/tmp/profile-lora/lora_weights.ckpt",
              sha256: "f".repeat(64),
              qualityGateJson: "/tmp/lora-quality-gate.json",
              qualityGateSha256: "2".repeat(64),
              trainConfig: "/tmp/train_config.json",
              trainConfigSha256: "3".repeat(64),
            },
            preferredBackend: {
              version: 1,
              status: "accepted",
              profileJson: "/tmp/profile/profile.json",
              voiceProfileId: "local-test",
              profileSha256: "c".repeat(64),
              backend: "indextts2",
              baselineBackend: "voxcpm2-hifi",
              selectionJson: "/tmp/selection.json",
              selectionSha256: "a".repeat(64),
              scoreJson: "/tmp/score.json",
              scoreSha256: "b".repeat(64),
            },
          },
        }),
        payload,
      ),
    );

    const [item] = await listRunsForUser(userA);
    expect(item.profileReference).toMatchObject({
      voiceProfileId: "local-test",
      sourceRunId: "clip-1",
      matchedCoverageFeatures: ["polyphones"],
      matchedPronunciationPresetIds: ["polyphone:chongqing"],
      loraPath: "/tmp/profile-lora/lora_weights.ckpt",
      loraAdapter: {
        profileSha256: "c".repeat(64),
        qualityGateSha256: "2".repeat(64),
      },
      preferredBackend: {
        backend: "indextts2",
        selectionSha256: "a".repeat(64),
        scoreSha256: "b".repeat(64),
      },
    });
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

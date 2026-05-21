import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  isWorkerEnabled,
  hotWorkerUrl,
  maxUploadBytes,
  modelId,
  normalizeTargetText,
  runsRoot,
  shouldReturnWorkerMissing,
  stabilitySeed,
  voxcpmCloneMode,
  voxcpmLoraPath,
} from "@/lib/clone-config";

describe("clone config", () => {
  it("defaults to VoxCPM2", () => {
    expect(modelId({})).toBe("openbmb/VoxCPM2");
  });

  it("keeps Vercel in worker-missing mode unless explicitly enabled", () => {
    expect(shouldReturnWorkerMissing({ VERCEL: "1" })).toBe(true);
    expect(shouldReturnWorkerMissing({ ANYVOICE_STUB: "1" })).toBe(true);
    expect(
      shouldReturnWorkerMissing({
        VERCEL: "1",
        ANYVOICE_STUB: "0",
        ANYVOICE_ENABLE_LOCAL_VOXCPM: "1",
      }),
    ).toBe(false);
  });

  it("does not treat a remote worker URL as local VoxCPM2", () => {
    expect(
      shouldReturnWorkerMissing({
        VERCEL: "1",
        ANYVOICE_WORKER_URL: "https://worker.example",
        ANYVOICE_WORKER_TOKEN: "token",
      }),
    ).toBe(true);
  });

  it("enables the local worker only when stub is off", () => {
    expect(isWorkerEnabled({ ANYVOICE_ENABLE_LOCAL_VOXCPM: "1", ANYVOICE_STUB: "0" })).toBe(true);
    expect(isWorkerEnabled({ ANYVOICE_ENABLE_LOCAL_VOXCPM: "1", ANYVOICE_STUB: "1" })).toBe(false);
  });

  it("bounds upload size", () => {
    expect(maxUploadBytes({ ANYVOICE_MAX_UPLOAD_MB: "0" })).toBe(1024 * 1024);
    expect(maxUploadBytes({ ANYVOICE_MAX_UPLOAD_MB: "999" })).toBe(512 * 1024 * 1024);
  });

  it("normalizes target text line endings", () => {
    expect(normalizeTargetText("hello\r\nworld")).toBe("hello\nworld");
  });

  it("returns absolute path when ANYVOICE_RUNS_DIR is absolute", () => {
    const abs = path.join(os.tmpdir(), "anyvoice-cfg");
    expect(runsRoot({ ANYVOICE_RUNS_DIR: abs })).toBe(abs);
  });

  it("joins relative ANYVOICE_RUNS_DIR with cwd when not on vercel", () => {
    expect(runsRoot({ ANYVOICE_RUNS_DIR: ".out/x" })).toBe(path.join(process.cwd(), ".out/x"));
  });

  it("joins relative ANYVOICE_RUNS_DIR with tmpdir on vercel", () => {
    expect(runsRoot({ ANYVOICE_RUNS_DIR: "vercel-runs", VERCEL: "1" })).toBe(
      path.join(os.tmpdir(), "vercel-runs"),
    );
  });

  it("falls back to the default runs dir when unset", () => {
    expect(runsRoot({})).toBe(path.join(process.cwd(), ".anyvoice/runs"));
  });

  it("clamps maxUploadBytes to default when env is non-numeric", () => {
    expect(maxUploadBytes({ ANYVOICE_MAX_UPLOAD_MB: "not-a-number" })).toBe(80 * 1024 * 1024);
  });

  it("returns the env model when overridden", () => {
    expect(modelId({ ANYVOICE_MODEL_ID: "x/y" })).toBe("x/y");
  });

  it("defaults VoxCPM clone mode to hifi and only allows prompt as rollback", () => {
    expect(voxcpmCloneMode({})).toBe("hifi");
    expect(voxcpmCloneMode({ ANYVOICE_VOXCPM_CLONE_MODE: "prompt" })).toBe("prompt");
    expect(voxcpmCloneMode({ ANYVOICE_VOXCPM_CLONE_MODE: "unknown" })).toBe("hifi");
  });

  it("normalizes the optional hot worker URL", () => {
    expect(hotWorkerUrl({})).toBe("");
    expect(hotWorkerUrl({ ANYVOICE_HOT_WORKER_URL: " http://127.0.0.1:8765 " })).toBe(
      "http://127.0.0.1:8765",
    );
  });

  it("normalizes the optional VoxCPM LoRA path", () => {
    expect(voxcpmLoraPath({})).toBe("");
    expect(voxcpmLoraPath({ ANYVOICE_VOXCPM_LORA_PATH: " /tmp/lora_weights.ckpt " })).toBe(
      "/tmp/lora_weights.ckpt",
    );
  });

  it("defaults to a fixed stability seed and allows explicit opt-out", () => {
    expect(stabilitySeed({})).toBe(1337);
    expect(stabilitySeed({ ANYVOICE_STABILITY_SEED: "42" })).toBe(42);
    expect(stabilitySeed({ ANYVOICE_STABILITY_SEED: "off" })).toBeNull();
    expect(stabilitySeed({ ANYVOICE_STABILITY_SEED: "random" })).toBeNull();
    expect(stabilitySeed({ ANYVOICE_STABILITY_SEED: "bad" })).toBe(1337);
  });
});

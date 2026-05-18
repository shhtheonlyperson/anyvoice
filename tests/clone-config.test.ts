import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  isWorkerEnabled,
  maxUploadBytes,
  modelId,
  normalizeStyle,
  normalizeTargetText,
  runsRoot,
  shouldReturnWorkerMissing,
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

  it("normalizes user-controlled prompt strings", () => {
    expect(normalizeStyle("  calm   and warm  ")).toBe("calm and warm");
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
});

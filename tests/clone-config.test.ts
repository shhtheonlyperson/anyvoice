import { describe, expect, it } from "vitest";
import {
  isWorkerEnabled,
  maxUploadBytes,
  modelId,
  normalizeStyle,
  normalizeTargetText,
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
});

import { describe, expect, it } from "vitest";
import { asrPython, voxcpmPython } from "@/lib/voxcpm-python";

describe("VoxCPM Python resolver", () => {
  it("defaults VoxCPM work to the shared service venv", () => {
    expect(voxcpmPython({})).toBe("/Users/shh/proj/shh-voxcpm-service/.venv/bin/python");
  });

  it("lets ANYVOICE_VOXCPM_PYTHON override the shared service venv", () => {
    expect(voxcpmPython({ ANYVOICE_VOXCPM_PYTHON: " /tmp/voxpy " })).toBe("/tmp/voxpy");
  });

  it("lets ANYVOICE_ASR_PYTHON override ASR work before VoxCPM python", () => {
    expect(asrPython({ ANYVOICE_ASR_PYTHON: "/tmp/asrpy", ANYVOICE_VOXCPM_PYTHON: "/tmp/voxpy" })).toBe(
      "/tmp/asrpy",
    );
  });

  it("falls ASR work back to the VoxCPM python resolver", () => {
    expect(asrPython({ ANYVOICE_VOXCPM_PYTHON: "/tmp/voxpy" })).toBe("/tmp/voxpy");
  });
});

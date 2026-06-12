import { describe, expect, it } from "vitest";
import { asrPython, voxcpmPython } from "@/lib/voxcpm-python";

describe("VoxCPM Python resolver", () => {
  it("defaults VoxCPM work to the shared service venv when installed", () => {
    expect(voxcpmPython({}, () => true)).toBe("/Users/shh/proj/shh-voxcpm-service/.venv/bin/python");
  });

  it("degrades to PATH python3 where the shared venv is not installed (CI)", () => {
    expect(voxcpmPython({}, () => false)).toBe("python3");
  });

  it("prefers PYTHON over the bare fallback when the shared venv is missing", () => {
    expect(voxcpmPython({ PYTHON: "/tmp/py" }, () => false)).toBe("/tmp/py");
  });

  it("lets ANYVOICE_VOXCPM_PYTHON override the shared service venv", () => {
    expect(voxcpmPython({ ANYVOICE_VOXCPM_PYTHON: " /tmp/voxpy " }, () => true)).toBe("/tmp/voxpy");
  });

  it("lets ANYVOICE_ASR_PYTHON override ASR work before VoxCPM python", () => {
    expect(asrPython({ ANYVOICE_ASR_PYTHON: "/tmp/asrpy", ANYVOICE_VOXCPM_PYTHON: "/tmp/voxpy" }, () => true)).toBe(
      "/tmp/asrpy",
    );
  });

  it("falls ASR work back to the VoxCPM python resolver", () => {
    expect(asrPython({ ANYVOICE_VOXCPM_PYTHON: "/tmp/voxpy" }, () => true)).toBe("/tmp/voxpy");
  });
});

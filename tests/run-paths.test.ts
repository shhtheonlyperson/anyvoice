import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRunDir, safeRunFile } from "@/lib/run-paths";

const originalRunsDir = process.env.ANYVOICE_RUNS_DIR;
const originalVercel = process.env.VERCEL;

describe("safeRunDir", () => {
  beforeEach(() => {
    process.env.ANYVOICE_RUNS_DIR = path.join(os.tmpdir(), "anyvoice-test-runs");
    delete process.env.VERCEL;
  });

  afterEach(() => {
    if (originalRunsDir === undefined) delete process.env.ANYVOICE_RUNS_DIR;
    else process.env.ANYVOICE_RUNS_DIR = originalRunsDir;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("resolves a normal id under the runsRoot", () => {
    const dir = safeRunDir("abc123XYZ");
    expect(dir).toBe(path.join(process.env.ANYVOICE_RUNS_DIR!, "abc123XYZ"));
  });

  it("rejects parent traversal", () => {
    expect(() => safeRunDir("..")).toThrow(/invalid job id/);
    expect(() => safeRunDir("../etc")).toThrow(/invalid job id/);
  });

  it("rejects absolute paths", () => {
    expect(() => safeRunDir("/etc/passwd")).toThrow(/invalid job id/);
  });

  it("rejects embedded slashes leading outside", () => {
    expect(() => safeRunDir("../../something")).toThrow(/invalid job id/);
  });
});

describe("safeRunFile", () => {
  beforeEach(() => {
    process.env.ANYVOICE_RUNS_DIR = path.join(os.tmpdir(), "anyvoice-test-runs");
    delete process.env.VERCEL;
  });

  afterEach(() => {
    if (originalRunsDir === undefined) delete process.env.ANYVOICE_RUNS_DIR;
    else process.env.ANYVOICE_RUNS_DIR = originalRunsDir;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  it("resolves a normal file under the run dir", () => {
    const file = safeRunFile("job1", "output.wav");
    expect(file).toBe(path.join(process.env.ANYVOICE_RUNS_DIR!, "job1", "output.wav"));
  });

  it("rejects traversal in the file name", () => {
    expect(() => safeRunFile("job1", "../escape.wav")).toThrow(/invalid run file/);
  });

  it("rejects absolute file names", () => {
    expect(() => safeRunFile("job1", "/etc/passwd")).toThrow(/invalid run file/);
  });

  it("propagates invalid jobId from safeRunDir", () => {
    expect(() => safeRunFile("../x", "out.wav")).toThrow(/invalid job id/);
  });
});

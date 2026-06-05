// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clone-runner", () => ({
  synthesizeSegment: vi.fn(async ({ outputM4aPath }: { outputM4aPath: string }) => {
    await writeFile(outputM4aPath, Buffer.from([1, 2, 3, 4]));
  }),
}));
vi.mock("@/lib/voice-profile", () => ({
  loadVoiceProfileManifest: vi.fn(async () => ({
    clips: [{ audioPath: "/ref/clip.wav", transcriptRaw: "你好。" }],
  })),
}));
vi.mock("@/lib/voice-profile-verify", () => ({
  verifyVoiceProfileReadiness: vi.fn(async () => ({
    status: "ready",
    profile: "/tmp/profile.json",
  })),
}));

import { synthesizeSegment } from "@/lib/clone-runner";
import { runBookSynthesis } from "@/lib/book-synthesizer";
import { createBook, loadProgress, setBookStatus } from "@/lib/book-job";
import { segmentBook } from "@/lib/book-segment";

let tmp: string;
const orig = process.env.ANYVOICE_BOOKS_ROOT;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "anyvoice-booksynth-"));
  process.env.ANYVOICE_BOOKS_ROOT = tmp;
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (orig === undefined) delete process.env.ANYVOICE_BOOKS_ROOT;
  else process.env.ANYVOICE_BOOKS_ROOT = orig;
});

function makeBook() {
  const segmented = segmentBook([{ title: "c1", text: "一。二。三。四。" }], { minChars: 1, maxChars: 3 });
  return createBook({ userId: "u", title: "T", format: "epub", voiceProfileId: "local-default", segmented });
}

describe("background book synthesizer", () => {
  it("synthesizes every pending segment to done", async () => {
    const meta = await makeBook();
    await runBookSynthesis(meta.id);
    const progress = await loadProgress(meta.id);
    expect(progress?.done).toBe(meta.segmentCount);
    expect(progress?.status).toBe("done");
    expect(vi.mocked(synthesizeSegment)).toHaveBeenCalledTimes(meta.segmentCount);
  });

  it("does not synthesize when the book is paused", async () => {
    const meta = await makeBook();
    await setBookStatus(meta.id, "paused");
    await runBookSynthesis(meta.id);
    expect(vi.mocked(synthesizeSegment)).not.toHaveBeenCalled();
    expect((await loadProgress(meta.id))?.done).toBe(0);
  });

  it("marks a segment error when synthesis throws but continues the rest", async () => {
    const meta = await makeBook();
    vi.mocked(synthesizeSegment)
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(async ({ outputM4aPath }) => {
        await writeFile(outputM4aPath, Buffer.from([1]));
      });
    await runBookSynthesis(meta.id);
    const progress = await loadProgress(meta.id);
    expect(progress?.errors).toBe(1);
    expect(progress?.done).toBe(meta.segmentCount - 1);
    expect(progress?.status).toBe("error");
  });
});

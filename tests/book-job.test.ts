// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBook,
  listBooks,
  loadProgress,
  loadSegments,
  markSegment,
  nextPendingIndex,
  setBookStatus,
  deleteBook,
  retryErroredSegments,
} from "@/lib/book-job";
import { segmentBook } from "@/lib/book-segment";

let tmp: string;
const origRoot = process.env.ANYVOICE_BOOKS_ROOT;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "anyvoice-books-"));
  process.env.ANYVOICE_BOOKS_ROOT = tmp;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (origRoot === undefined) delete process.env.ANYVOICE_BOOKS_ROOT;
  else process.env.ANYVOICE_BOOKS_ROOT = origRoot;
});

function makeBook(userId = "av_u1") {
  const segmented = segmentBook(
    [{ title: "第一章", text: "你好。世界。再見。" }],
    { minChars: 1, maxChars: 6 },
  );
  return createBook({ userId, title: "Test", format: "epub", voiceProfileId: "local-default", segmented });
}

describe("book job model", () => {
  it("creates a resumable manifest with per-segment pending status", async () => {
    const meta = await makeBook();
    expect(meta.id).toMatch(/^bk_/);
    expect(meta.segmentCount).toBeGreaterThan(0);
    const progress = await loadProgress(meta.id);
    expect(progress?.status).toBe("synthesizing");
    expect(progress?.statuses.every((s) => s === "pending")).toBe(true);
    expect(nextPendingIndex(progress!)).toBe(0);
    const segments = await loadSegments(meta.id);
    expect(segments).toHaveLength(meta.segmentCount);
  });

  it("tracks done/error counts and auto-completes", async () => {
    const meta = await makeBook();
    const n = meta.segmentCount;
    for (let i = 0; i < n - 1; i += 1) await markSegment(meta.id, i, "done");
    let progress = await loadProgress(meta.id);
    expect(progress?.done).toBe(n - 1);
    expect(progress?.status).toBe("synthesizing");
    progress = await markSegment(meta.id, n - 1, "done");
    expect(progress?.done).toBe(n);
    expect(progress?.status).toBe("done"); // auto-complete
    expect(nextPendingIndex(progress!)).toBeNull();
  });

  it("marks book error when a segment fails the run", async () => {
    const meta = await makeBook();
    const n = meta.segmentCount;
    for (let i = 0; i < n - 1; i += 1) await markSegment(meta.id, i, "done");
    const progress = await markSegment(meta.id, n - 1, "error");
    expect(progress?.errors).toBe(1);
    expect(progress?.status).toBe("error");
  });

  it("supports pause and lists per user; isolates other users", async () => {
    const mine = await makeBook("av_me");
    await makeBook("av_other");
    await setBookStatus(mine.id, "paused");
    expect((await loadProgress(mine.id))?.status).toBe("paused");
    const list = await listBooks("av_me");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(mine.id);
  });

  it("retries errored segments on resume", async () => {
    const meta = await makeBook();
    await markSegment(meta.id, 0, "error");
    for (let i = 1; i < meta.segmentCount; i += 1) await markSegment(meta.id, i, "done");
    expect((await loadProgress(meta.id))?.status).toBe("error");
    const progress = await retryErroredSegments(meta.id);
    expect(progress?.errors).toBe(0);
    expect(progress?.status).toBe("synthesizing");
    expect(nextPendingIndex(progress!)).toBe(0); // the previously-errored segment
  });

  it("prioritizes the focused chapter and keeps extras on-demand; estimates ETA", async () => {
    const { createBook } = await import("@/lib/book-job");
    const { nextSegmentToSynthesize, setFocusChapter, etaSeconds, loadBookMeta } = await import("@/lib/book-job");
    const segmented = segmentBook(
      [
        { title: "第一章", text: "一。二。", kind: "chapter" },
        { title: "序", text: "甲。乙。", kind: "extra" },
      ],
      { minChars: 1, maxChars: 3 },
    );
    const meta = await createBook({ userId: "u", title: "T", format: "epub", voiceProfileId: "local-default", segmented });
    const chapters = (await loadBookMeta(meta.id))!.chapters;
    const ch1 = chapters[0];
    const extra = chapters[1];

    let progress = (await loadProgress(meta.id))!;
    expect(progress.focusChapter).toBe(0); // first main chapter
    // first pick is inside the focused main chapter
    expect(nextSegmentToSynthesize(progress, chapters)).toBe(ch1.firstSegment);

    // complete the main chapter -> extra is NOT auto-synthesized
    for (let i = ch1.firstSegment; i < ch1.firstSegment + ch1.segmentCount; i += 1) {
      await markSegment(meta.id, i, "done", 500);
    }
    progress = (await loadProgress(meta.id))!;
    expect(nextSegmentToSynthesize(progress, chapters)).toBeNull();

    // focusing the extra synthesizes it on demand
    await setFocusChapter(meta.id, extra.index);
    progress = (await loadProgress(meta.id))!;
    expect(nextSegmentToSynthesize(progress, chapters)).toBe(extra.firstSegment);

    // ETA derives from recorded timing (500ms/segment)
    const eta = etaSeconds(progress, chapters);
    expect(eta).not.toBeNull();
    expect(eta!).toBeGreaterThan(0);
  });

  it("excludes auto-resume-off books from the resume scan", async () => {
    const { listInProgressBookIds, setAutoResume } = await import("@/lib/book-job");
    const on = await makeBook();
    const off = await makeBook();
    await setAutoResume(off.id, false);
    const ids = await listInProgressBookIds();
    expect(ids).toContain(on.id);
    expect(ids).not.toContain(off.id);
  });

  it("deletes only the owner's book", async () => {
    const meta = await makeBook("av_owner");
    expect(await deleteBook(meta.id, "av_intruder")).toBe(false);
    expect(await deleteBook(meta.id, "av_owner")).toBe(true);
    expect(await loadProgress(meta.id)).toBeNull();
  });
});

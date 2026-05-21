import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { BookChapter, SegmentedBook } from "@/lib/book-segment";

// Storage layout (per book) keeps frequent progress writes cheap for 50–100K-word
// books by separating immutable text from the small, often-updated status:
//   .anyvoice/books/<id>/book.json        meta: title, chapters, segmentCount, status
//   .anyvoice/books/<id>/segments.jsonl   immutable {index,chapter,text} per line
//   .anyvoice/books/<id>/progress.json    statuses[] + counts (rewritten per segment)
//   .anyvoice/books/<id>/audio/000123.m4a  synthesized segment audio

export type BookStatus = "synthesizing" | "paused" | "done" | "error";
export type SegmentStatus = "pending" | "done" | "error";

export interface BookMeta {
  id: string;
  userId: string;
  title: string;
  format: "epub" | "pdf";
  createdAt: string;
  voiceProfileId: string;
  segmentCount: number;
  chapters: BookChapter[];
}

export interface BookProgress {
  status: BookStatus;
  statuses: SegmentStatus[];
  done: number;
  errors: number;
  updatedAt: string;
}

type BooksEnv = Record<string, string | undefined>;

export function booksRoot(env: BooksEnv = process.env): string {
  // Absolute paths: the hot worker is a separate process and resolves output
  // paths against its own cwd, so relative paths would write seg.wav elsewhere.
  if (env.ANYVOICE_BOOKS_ROOT) return path.resolve(env.ANYVOICE_BOOKS_ROOT);
  const base = env.ANYVOICE_RUNS_DIR || path.join(process.cwd(), ".anyvoice");
  return path.resolve(base, "books");
}

export function bookDir(id: string, env: BooksEnv = process.env): string {
  return path.join(booksRoot(env), id);
}

export function segmentAudioPath(id: string, index: number, env: BooksEnv = process.env): string {
  return path.join(bookDir(id, env), "audio", `${String(index).padStart(6, "0")}.m4a`);
}

const metaPath = (id: string, env?: BooksEnv) => path.join(bookDir(id, env), "book.json");
const segmentsPath = (id: string, env?: BooksEnv) => path.join(bookDir(id, env), "segments.jsonl");
const progressPath = (id: string, env?: BooksEnv) => path.join(bookDir(id, env), "progress.json");

export interface CreateBookInput {
  userId: string;
  title: string;
  format: "epub" | "pdf";
  voiceProfileId: string;
  segmented: SegmentedBook;
}

export async function createBook(input: CreateBookInput): Promise<BookMeta> {
  const id = `bk_${nanoid(10)}`;
  const dir = bookDir(id);
  await mkdir(path.join(dir, "audio"), { recursive: true });

  const meta: BookMeta = {
    id,
    userId: input.userId,
    title: input.title,
    format: input.format,
    createdAt: new Date().toISOString(),
    voiceProfileId: input.voiceProfileId,
    segmentCount: input.segmented.segments.length,
    chapters: input.segmented.chapters,
  };
  const jsonl = input.segmented.segments.map((s) => JSON.stringify(s)).join("\n");
  const progress: BookProgress = {
    status: "synthesizing",
    statuses: input.segmented.segments.map(() => "pending"),
    done: 0,
    errors: 0,
    updatedAt: meta.createdAt,
  };

  await writeFile(metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
  await writeFile(segmentsPath(id), jsonl, "utf-8");
  await writeFile(progressPath(id), JSON.stringify(progress), "utf-8");
  return meta;
}

export async function loadBookMeta(id: string): Promise<BookMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(id), "utf-8")) as BookMeta;
  } catch {
    return null;
  }
}

export async function loadProgress(id: string): Promise<BookProgress | null> {
  try {
    return JSON.parse(await readFile(progressPath(id), "utf-8")) as BookProgress;
  } catch {
    return null;
  }
}

export async function saveProgress(id: string, progress: BookProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  await writeFile(progressPath(id), JSON.stringify(progress), "utf-8");
}

export async function loadSegments(id: string): Promise<{ index: number; chapter: number; text: string }[]> {
  try {
    const raw = await readFile(segmentsPath(id), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { index: number; chapter: number; text: string });
  } catch {
    return [];
  }
}

export async function setBookStatus(id: string, status: BookStatus): Promise<BookProgress | null> {
  const progress = await loadProgress(id);
  if (!progress) return null;
  progress.status = status;
  await saveProgress(id, progress);
  return progress;
}

export async function markSegment(
  id: string,
  index: number,
  status: SegmentStatus,
): Promise<BookProgress | null> {
  const progress = await loadProgress(id);
  if (!progress || index < 0 || index >= progress.statuses.length) return null;
  const prev = progress.statuses[index];
  if (prev !== status) {
    if (prev === "done") progress.done -= 1;
    if (prev === "error") progress.errors -= 1;
    progress.statuses[index] = status;
    if (status === "done") progress.done += 1;
    if (status === "error") progress.errors += 1;
  }
  // Auto-complete when every segment is resolved.
  if (progress.done + progress.errors >= progress.statuses.length && progress.status === "synthesizing") {
    progress.status = progress.errors > 0 ? "error" : "done";
  }
  await saveProgress(id, progress);
  return progress;
}

/** Reset errored segments to pending so resume retries them. */
export async function retryErroredSegments(id: string): Promise<BookProgress | null> {
  const progress = await loadProgress(id);
  if (!progress) return null;
  progress.statuses = progress.statuses.map((s) => (s === "error" ? "pending" : s));
  progress.errors = 0;
  progress.status = "synthesizing";
  await saveProgress(id, progress);
  return progress;
}

/** First segment still pending, or null if none. */
export function nextPendingIndex(progress: BookProgress): number | null {
  const i = progress.statuses.indexOf("pending");
  return i >= 0 ? i : null;
}

export async function listBooks(userId: string): Promise<(BookMeta & { progress: BookProgress | null })[]> {
  let entries: string[];
  try {
    entries = await readdir(booksRoot());
  } catch {
    return [];
  }
  const books: (BookMeta & { progress: BookProgress | null })[] = [];
  for (const id of entries) {
    const meta = await loadBookMeta(id);
    if (!meta || meta.userId !== userId) continue;
    books.push({ ...meta, progress: await loadProgress(id) });
  }
  return books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteBook(id: string, userId: string): Promise<boolean> {
  const meta = await loadBookMeta(id);
  if (!meta || meta.userId !== userId) return false;
  await rm(bookDir(id), { recursive: true, force: true });
  return true;
}

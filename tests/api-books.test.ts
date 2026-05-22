// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/book-synthesizer", () => ({ startBookSynthesis: vi.fn() }));
vi.mock("@/lib/voice-profile", () => ({
  buildVoiceProfileSummary: vi.fn(async () => ({
    status: "ready",
    usable: true,
    studioGrade: true,
    voiceProfileId: "local-default",
    clips: [{ audioPath: "/ref.wav", transcriptRaw: "你好。" }],
  })),
}));
vi.mock("@/lib/book-extract", () => ({
  extractBook: vi.fn(async () => ({
    title: "Mock Book",
    chapters: [{ title: "第一章", text: "你好。世界很大。再見了。" }],
  })),
}));

import { GET as listBooks, POST as createBook } from "@/app/api/books/route";
import { GET as getBook } from "@/app/api/books/[id]/route";
import { POST as control } from "@/app/api/books/[id]/control/route";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import { startBookSynthesis } from "@/lib/book-synthesizer";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";

let tmp: string;
const origBooks = process.env.ANYVOICE_BOOKS_ROOT;
const USER = "av_11111111-1111-4111-8111-111111111111";
const cookie = `${ANYVOICE_USER_COOKIE}=${encodeURIComponent(USER)}`;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "anyvoice-apibooks-"));
  process.env.ANYVOICE_BOOKS_ROOT = tmp;
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (origBooks === undefined) delete process.env.ANYVOICE_BOOKS_ROOT;
  else process.env.ANYVOICE_BOOKS_ROOT = origBooks;
});

function postReq(): NextLike {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "mock.epub", { type: "application/epub+zip" }));
  return new Request("http://localhost/api/books", { method: "POST", headers: { cookie }, body: form }) as NextLike;
}
type NextLike = import("next/server").NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/books", () => {
  it("creates a book, starts synthesis, lists it, and pauses it", async () => {
    const created = await createBook(postReq());
    expect(created.status).toBe(201);
    const { book } = (await created.json()) as { book: { id: string; title: string; segmentCount: number } };
    expect(book.title).toBe("Mock Book");
    expect(book.segmentCount).toBeGreaterThan(0);
    expect(vi.mocked(startBookSynthesis)).toHaveBeenCalledWith(book.id);

    const listed = await listBooks(new Request("http://localhost/api/books", { headers: { cookie } }) as NextLike);
    const { books } = (await listed.json()) as { books: { id: string }[] };
    expect(books.map((b) => b.id)).toContain(book.id);

    const detail = await getBook(new Request(`http://localhost/api/books/${book.id}`, { headers: { cookie } }) as NextLike, ctx(book.id));
    const detailJson = (await detail.json()) as { progress: { status: string } };
    expect(detailJson.progress.status).toBe("synthesizing");

    const paused = await control(
      new Request(`http://localhost/api/books/${book.id}/control`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }) }) as NextLike,
      ctx(book.id),
    );
    const pausedJson = (await paused.json()) as { progress: { status: string } };
    expect(pausedJson.progress.status).toBe("paused");
  });

  it("rejects book creation when the voice profile isn't ready", async () => {
    vi.mocked(buildVoiceProfileSummary).mockResolvedValueOnce({
      status: "needs_enrollment",
      voiceProfileId: "local-default",
      clips: [],
    } as unknown as Awaited<ReturnType<typeof buildVoiceProfileSummary>>);
    const res = await createBook(postReq());
    expect(res.status).toBe(409);
    expect(vi.mocked(startBookSynthesis)).not.toHaveBeenCalled();
  });

  it("hides another user's book", async () => {
    const created = await createBook(postReq());
    const { book } = (await created.json()) as { book: { id: string } };
    const other = `${ANYVOICE_USER_COOKIE}=${encodeURIComponent("av_22222222-2222-4222-8222-222222222222")}`;
    const detail = await getBook(new Request(`http://localhost/api/books/${book.id}`, { headers: { cookie: other } }) as NextLike, ctx(book.id));
    expect(detail.status).toBe(404);
  });
});

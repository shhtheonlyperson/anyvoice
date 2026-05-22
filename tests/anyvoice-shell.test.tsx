// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

beforeAll(() => {
  if (typeof window !== "undefined" && !window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      },
    });
  }
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
  }
});

import { AnyVoiceApp } from "@/components/anyvoice/AnyVoiceApp";

const READY_PROFILE = {
  id: "vp_ready",
  displayName: "我的聲音",
  status: "ready",
  usable: true,
  studioGrade: true,
  clipCount: 5,
  hash: 0x4a7d,
};

const EMPTY_PROFILE = {
  id: "vp_empty",
  displayName: "新的聲音",
  status: "needs_enrollment",
  usable: false,
  studioGrade: false,
  clipCount: 0,
  hash: 0x1111,
};

const BOOK_META = {
  id: "bk_1",
  title: "細胞之歌",
  segmentCount: 6,
  chapters: [
    { index: 0, title: "前言", kind: "extra", firstSegment: 0, segmentCount: 1 },
    { index: 1, title: "第一章 起源", kind: "chapter", firstSegment: 1, segmentCount: 3 },
    { index: 2, title: "第二章 分裂", kind: "chapter", firstSegment: 4, segmentCount: 2 },
  ],
};
const BOOK_PROGRESS = {
  status: "synthesizing",
  statuses: ["done", "done", "done", "pending", "pending", "pending"],
  done: 3,
  errors: 0,
  focusChapter: 1,
  autoResume: true,
};

function stubFetch(profiles: unknown[] = [READY_PROFILE]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/voice-profile/profiles")) return Response.json({ profiles });
    if (url.includes("/api/runs")) return Response.json({ items: [] });
    // Book endpoints
    if (/\/api\/books\/[^/]+\/control/.test(url)) return Response.json({ progress: BOOK_PROGRESS, eta: 120 });
    if (/\/api\/books\/[^/]+$/.test(url))
      return Response.json({
        book: BOOK_META,
        progress: BOOK_PROGRESS,
        eta: 120,
        segments: BOOK_META.chapters.flatMap((c) =>
          Array.from({ length: c.segmentCount }, (_, k) => ({ index: c.firstSegment + k, text: `段落 ${c.firstSegment + k}` })),
        ),
      });
    if (url.includes("/api/books"))
      return Response.json({ books: [{ ...BOOK_META, progress: BOOK_PROGRESS }] });
    return Response.json({ status: "ready", audioUrl: "/result.wav" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function clickTab(container: HTMLElement, label: string) {
  const tab = Array.from(container.querySelectorAll(".tabs .tab")).find((b) =>
    (b.textContent || "").includes(label),
  ) as HTMLButtonElement;
  tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AnyVoiceApp));
  });
  await flush();
  return { container, root };
}

beforeEach(() => {
  window.localStorage.clear();
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("AnyVoice workspace shell", () => {
  it("renders the rail, three topbar tabs, and the Generate tab by default", async () => {
    const { container, root } = await mount();

    // Rail brand + voice from the profiles API.
    expect(container.querySelector(".rail")).not.toBeNull();
    expect(container.textContent).toContain("AnyVoice");
    expect(container.querySelector(".voice-item")).not.toBeNull();
    expect(container.textContent).toContain("我的聲音");

    // Three tabs (zh-Hant default labels).
    const tabs = Array.from(container.querySelectorAll(".tabs .tab")).map((b) => b.textContent?.trim());
    expect(tabs.join("|")).toContain("建立聲音");
    expect(tabs.join("|")).toContain("生成");
    expect(tabs.join("|")).toContain("有聲書");

    // Generate tab is active: composer present.
    expect(container.querySelector(".compose-textarea")).not.toBeNull();
    expect(container.querySelectorAll(".dial").length).toBe(3);

    await act(async () => root.unmount());
    container.remove();
  });

  it("enables Generate once text is typed against a ready voice", async () => {
    const { container, root } = await mount();
    const textarea = container.querySelector(".compose-textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "用我的聲音說這句話。");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const btn = Array.from(container.querySelectorAll("button.btn--primary")).find((b) =>
      (b.textContent || "").includes("生成"),
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("Build tab — adaptive state from real summary", () => {
  it("renders the ready hero with a Start generating CTA for a studio-grade voice", async () => {
    const { container, root } = await mount();
    await act(async () => clickTab(container, "建立聲音"));
    await flush();
    // Ready state: coral hero status panel + "開始生成" CTA.
    expect(container.querySelector(".build-status.ready")).not.toBeNull();
    expect(container.textContent).toContain("你的聲音已準備好");
    expect(container.textContent).toContain("開始生成");
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the empty state with a Start recording CTA when clipCount is 0", async () => {
    stubFetch([EMPTY_PROFILE]);
    const { container, root } = await mount();
    await act(async () => clickTab(container, "建立聲音"));
    await flush();
    const panel = container.querySelector(".build-status") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.classList.contains("ready")).toBe(false);
    expect(container.textContent).toContain("開始錄音");
    // Empty-zone three options present.
    expect(container.querySelector(".empty-zone")).not.toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("Audiobook tab — re-skinned reader", () => {
  it("renders the library grid + upload card from /api/books", async () => {
    const { container, root } = await mount();
    await act(async () => clickTab(container, "有聲書"));
    await flush();
    // Library grid present with the book card + cover + progress.
    expect(container.querySelector(".book-grid")).not.toBeNull();
    expect(container.querySelector(".book-card")).not.toBeNull();
    expect(container.querySelector(".book-cover")).not.toBeNull();
    expect(container.querySelector(".progress-bar")).not.toBeNull();
    // Upload affordance.
    expect(container.querySelector(".book-upload-card")).not.toBeNull();
    expect(container.textContent).toContain("細胞之歌");
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens the reader with chapter rail, queue card, sticky player and core controls", async () => {
    const { container, root } = await mount();
    await act(async () => clickTab(container, "有聲書"));
    await flush();
    // Open the book by clicking its cover.
    const cover = container.querySelector(".book-cover") as HTMLButtonElement;
    await act(async () => cover.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // Chapter rail (left).
    expect(container.querySelector(".reader-shell")).not.toBeNull();
    expect(container.querySelectorAll(".chapter-item").length).toBe(3);
    // Dark generation-queue card with per-chapter status driven by real progress.
    expect(container.querySelector(".queue-card")).not.toBeNull();
    expect(container.querySelectorAll(".queue-row").length).toBe(3);
    expect(container.querySelector(".queue-row .ok-dot")).not.toBeNull(); // chapter 0/1 done
    expect(container.querySelector(".queue-row .queued-dot")).not.toBeNull(); // last chapter pending

    // Now-playing waveform (140-bar StaticWaveform).
    expect(container.querySelector(".waveform-strip")).not.toBeNull();

    // Sticky bottom player with play/pause control.
    expect(container.querySelector(".player-bar")).not.toBeNull();
    expect(container.querySelector(".player-bar .play-btn")).not.toBeNull();

    // Speed controls (1/1.25/1.5/2×).
    const speeds = Array.from(container.querySelectorAll(".speed-group .speed-btn")).map((b) => b.textContent);
    expect(speeds).toEqual(["1×", "1.25×", "1.5×", "2×"]);

    // No emoji glyphs in the player controls (SVG icons only).
    const playerText = container.querySelector(".card-cream")?.textContent ?? "";
    expect(playerText).not.toContain("▶");
    expect(playerText).not.toContain("⏸");

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("CreateVoiceModal — consent gating", () => {
  it("opens from the rail + and gates the YouTube Build button on URL + consent", async () => {
    const { container, root } = await mount();
    // Open the modal via the rail "+".
    const plus = container.querySelector(".rail-section-action") as HTMLButtonElement;
    await act(async () => plus.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    // Choose the YouTube path.
    const ytOption = Array.from(document.querySelectorAll(".cv-option")).find((b) =>
      (b.textContent || "").includes("YouTube"),
    ) as HTMLButtonElement;
    await act(async () => ytOption.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    const buildBtn = Array.from(document.querySelectorAll("button.btn--primary")).find((b) =>
      (b.textContent || "").includes("建立聲音複製"),
    ) as HTMLButtonElement;
    // Gated: no URL, no consent.
    expect(buildBtn.disabled).toBe(true);

    // Type a URL — still gated without consent.
    const urlInput = document.querySelector(".first-run-card input.input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(urlInput, "https://www.youtube.com/watch?v=abc&t=300");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(buildBtn.disabled).toBe(true);

    // Tick consent → enabled.
    const consent = document.querySelector('.first-run-card input[type="checkbox"]') as HTMLInputElement;
    act(() => consent.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(buildBtn.disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});

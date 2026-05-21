// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

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
});

import { VoiceCloneStudio } from "@/components/VoiceCloneStudio";

type ProfileStatus = "ready" | "needs_enrollment";

function profilePayload(status: ProfileStatus) {
  return {
    profile: {
      status,
      summary: {
        eligibleClips: status === "ready" ? 5 : 0,
        selectedClips: status === "ready" ? 5 : 0,
        rejectedClips: 0,
        remainingClipsNeeded: status === "ready" ? 0 : 5,
      },
      requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20, passingGrades: ["A", "B"] },
    },
  };
}

function stubFetch(status: ProfileStatus = "needs_enrollment") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/voice-profile")) return Response.json(profilePayload(status));
    return Response.json({ status: "ready", audioUrl: "/result.wav" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(VoiceCloneStudio));
  });
  await flush();
  return { container, root };
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

function findByText(container: HTMLElement, text: string): Element | null {
  return Array.from(container.querySelectorAll("button, a, summary, span")).find((el) =>
    (el.textContent || "").includes(text),
  ) ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VoiceCloneStudio (SSR smoke)", () => {
  it("renders the studio shell without throwing", () => {
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("AnyVoice");
    expect(html.length).toBeGreaterThan(500);
  });

  it("shows the generate-button copy (zh-Hant default)", () => {
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("產生聲音");
  });

  it("renders English copy when locale is persisted to EN", () => {
    window.localStorage.setItem("anyvoice:locale", "en");
    // SSR ignores localStorage (defaults zh-Hant); the client effect applies it.
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("產生聲音");
  });

  it("renders under light and dark themes without throwing", () => {
    window.localStorage.setItem("anyvoice:theme", "dark");
    expect(renderToString(React.createElement(VoiceCloneStudio))).toContain("AnyVoice");
    window.localStorage.setItem("anyvoice:theme", "light");
    expect(renderToString(React.createElement(VoiceCloneStudio))).toContain("AnyVoice");
  });
});

describe("VoiceCloneStudio (behavior)", () => {
  it("applies the persisted EN locale on mount", async () => {
    window.localStorage.setItem("anyvoice:locale", "en");
    stubFetch();
    const { container, root } = await mount();
    expect(container.textContent).toContain("Generate voice");
    expect(container.textContent).not.toContain("產生聲音");
    await act(async () => root.unmount());
    container.remove();
  });

  it("disables generation and shows the build CTA when the profile needs enrollment", async () => {
    stubFetch("needs_enrollment");
    const { container, root } = await mount();
    // no voice picker: a single voice (yours). Not ready -> generate disabled + build CTA.
    expect(container.querySelector(".seg")).toBeNull();
    const genBtn = container.querySelector("button.btn--primary.btn--lg") as HTMLButtonElement;
    expect(genBtn.disabled).toBe(true);
    expect(container.textContent).toContain("先建立你的聲音檔案");
    expect(container.textContent).not.toContain("範例聲音");
    await act(async () => root.unmount());
    container.remove();
  });

  it("enables generation once the profile is ready", async () => {
    stubFetch("ready");
    const { container, root } = await mount();
    const textarea = container.querySelector("textarea.target") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "用我的聲音說這句話。");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const genBtn = container.querySelector("button.btn--primary.btn--lg") as HTMLButtonElement;
    expect(genBtn.disabled).toBe(false);
    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks profile generation when target text is Simplified/mixed Chinese", async () => {
    const fetchMock = stubFetch("ready");
    const { container, root } = await mount();
    // type Simplified text (profile is ready -> single voice path)
    const textarea = container.querySelector("textarea.target") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "请说这句话"); // Simplified
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    // warning shown + generate disabled + no clone POST
    expect(container.textContent).toContain("簡體");
    const genBtn = container.querySelector("button.btn--primary.btn--lg") as HTMLButtonElement;
    expect(genBtn.disabled).toBe(true);
    const cloneCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/clone/stream"));
    expect(cloneCalls.length).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers a one-click pronunciation replacement for risky terms", async () => {
    stubFetch();
    const { container, root } = await mount();
    const textarea = container.querySelector("textarea.target") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "我在用 AnyVoice 做測試"); // brand term with a preset
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const chip = container.querySelector(".pron-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("→");
    await act(async () => root.unmount());
    container.remove();
  });

  it("build screen shows the first pending script line and checklist", async () => {
    stubFetch("needs_enrollment");
    const { container, root } = await mount();
    click(findByText(container, "建立我的聲音"));
    await flush();
    expect(container.textContent).toContain("第 1 段 · 共 5 段");
    // checklist has all five lines
    expect(container.querySelectorAll(".clip").length).toBe(5);
    expect(container.textContent).toContain("待錄");
    await act(async () => root.unmount());
    container.remove();
  });

  it("build screen reflects a ready profile as done instead of an empty checklist", async () => {
    stubFetch("ready");
    const { container, root } = await mount();
    click(findByText(container, "建立我的聲音"));
    await flush();
    // A returning user with a ready profile must see their voice is built,
    // not a fresh "待錄" list (regression: checklist ignored enrolled clips).
    expect(container.textContent).toContain("你的聲音已就緒");
    await act(async () => root.unmount());
    container.remove();
  });

  it("exposes the advanced developer disclosure on the build screen", async () => {
    stubFetch("needs_enrollment");
    const { container, root } = await mount();
    click(findByText(container, "建立我的聲音"));
    await flush();
    expect(container.querySelector("details.adv")).not.toBeNull();
    expect(container.textContent).toContain("verify_voice_profile_ready.py");
    await act(async () => root.unmount());
    container.remove();
  });
});

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

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/voice-profile/profiles")) return Response.json({ profiles: [READY_PROFILE] });
    if (url.includes("/api/runs")) return Response.json({ items: [] });
    return Response.json({ status: "ready", audioUrl: "/result.wav" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

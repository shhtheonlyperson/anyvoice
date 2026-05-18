// @vitest-environment jsdom
import React, { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

// next/link gets in the way of pure SSR — stub it to a plain anchor.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

beforeAll(() => {
  // SSR runs with `typeof window !== "undefined"` under jsdom, but the
  // renderToString hook path can predate jsdom's storage init.
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

describe("VoiceCloneStudio (SSR smoke)", () => {
  it("renders the studio shell without throwing", () => {
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("AnyVoice");
    expect(html.length).toBeGreaterThan(500);
  });

  it("includes the generate-button copy in the SSR output", () => {
    const html = renderToString(React.createElement(VoiceCloneStudio));
    // Defaults to zh-Hant on first render; both locales include the title leader.
    expect(html).toMatch(/AnyVoice/);
  });

  it("renders again with a saved English locale to exercise the alternate copy", () => {
    window.localStorage.setItem("anyvoice:locale", "en");
    window.localStorage.setItem("anyvoice:theme", "dark");
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("AnyVoice");
  });

  it("renders with the light theme persisted", () => {
    window.localStorage.setItem("anyvoice:locale", "zh-Hant");
    window.localStorage.setItem("anyvoice:theme", "light");
    const html = renderToString(React.createElement(VoiceCloneStudio));
    expect(html).toContain("AnyVoice");
  });

  it("mounts to the DOM and runs initial effects", async () => {
    // Stub URL.createObjectURL and fetch so the mount effects do not crash.
    const objectUrls: string[] = [];
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = (() => {
      const url = `blob:anyvoice/${objectUrls.length}`;
      objectUrls.push(url);
      return url;
    });
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});

    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0, 0, 0, 0]).buffer, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
    });
    expect(container.querySelector('[aria-label="AnyVoice"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });

    container.remove();
    vi.unstubAllGlobals();
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });
});

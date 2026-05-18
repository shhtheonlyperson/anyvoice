// @vitest-environment jsdom
import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

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

import PrdPage from "@/app/prd/page";

describe("PRD page (SSR smoke)", () => {
  it("renders the PRD without throwing", () => {
    const html = renderToString(React.createElement(PrdPage));
    expect(html).toContain("AnyVoice");
    expect(html.length).toBeGreaterThan(500);
  });

  it("renders the PRD in English when locale is persisted", () => {
    window.localStorage.setItem("anyvoice:locale", "en");
    window.localStorage.setItem("anyvoice:theme", "light");
    const html = renderToString(React.createElement(PrdPage));
    expect(html).toContain("AnyVoice");
  });

  it("renders the PRD with the dark theme persisted", () => {
    window.localStorage.setItem("anyvoice:locale", "zh-Hant");
    window.localStorage.setItem("anyvoice:theme", "dark");
    const html = renderToString(React.createElement(PrdPage));
    expect(html).toContain("AnyVoice");
  });
});

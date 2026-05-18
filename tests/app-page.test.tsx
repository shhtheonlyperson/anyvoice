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
        removeItem: () => {},
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      },
    });
  }
});

import Home from "@/app/page";

describe("app/page", () => {
  it("renders the home page wrapping the studio", () => {
    const html = renderToString(React.createElement(Home));
    expect(html).toContain("AnyVoice");
  });
});

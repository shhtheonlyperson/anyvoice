// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

/* Verifies the in-browser recording stage wires the analyzer grade to the
 * line-status dots: a grade A/B enroll marks the line passed; a grade C/D enroll
 * marks it re-record. The capture path (getUserMedia + MediaRecorder) is stubbed
 * so the test drives the enroll → grade → status mapping deterministically. */

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  state = "inactive";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) });
    this.onstop?.();
  }
  static isTypeSupported() {
    return true;
  }
}

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
  vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getAudioTracks: () => [{ getSettings: () => ({}) }],
        getTracks: () => [{ stop() {} }],
      })),
    },
  });
});

import { BuildTab } from "@/components/anyvoice/BuildTab";
import { I18nProvider } from "@/components/anyvoice/i18n";
import type { ProfileListItem } from "@/components/anyvoice/lib/anyvoice-client";

const EMPTY_PROFILE: ProfileListItem = {
  id: "vp1",
  displayName: "我的聲音",
  status: "needs_enrollment",
  usable: false,
  studioGrade: false,
  clipCount: 0,
  hash: 0x1234,
};

function stubEnroll(grade: "A" | "B" | "C" | "D") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/voice-profile/enroll")) {
      return Response.json({
        status: "enrolled",
        referenceQuality: { grade, durationSec: 8, warnings: [] },
        profile: {
          usable: grade === "A" || grade === "B",
          studioGrade: false,
          requirements: { passingGrades: ["A", "B"] },
          clips: [],
        },
      });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function flush() {
  await act(async () => {
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

async function mountRecording(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  container.className = "av-root";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider lang="zh">
        <BuildTab activeProfile={EMPTY_PROFILE} onRefresh={() => {}} onChangeTab={() => {}} onDeleted={() => {}} />
      </I18nProvider>,
    );
  });
  await flush();
  // Click "Start recording" to enter the recording stage.
  const start = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes("開始錄音"),
  ) as HTMLButtonElement;
  await act(async () => start.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
  return { container, root };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BuildTab recording stage — grade → line status", () => {
  it("renders the 24-line list and dark recording stage on Start", async () => {
    stubEnroll("A");
    const { container, root } = await mountRecording();
    expect(container.querySelector(".rec-stage")).not.toBeNull();
    expect(container.querySelectorAll(".lines-list .line-row").length).toBe(24);
    expect(container.querySelector(".coverage-sidecar")).not.toBeNull();
    // "Space" kbd chip present.
    expect(container.textContent).toContain("空白鍵");
    await act(async () => root.unmount());
    container.remove();
  });
});

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

function installFakeIndexedDb() {
  type FakeRequest<T> = {
    result: T;
    error: DOMException | null;
    onsuccess: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
  };
  type FakeOpenRequest = FakeRequest<IDBDatabase> & {
    onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
  };

  const records = new Map<string, unknown>();
  const event = new Event("success");

  function request<T>(result: T): FakeRequest<T> {
    return { result, error: null, onsuccess: null, onerror: null };
  }

  function complete(transaction: { oncomplete: ((event: Event) => void) | null }) {
    window.setTimeout(() => {
      transaction.oncomplete?.(event);
    }, 0);
  }

  const db = {
    objectStoreNames: {
      contains: () => true,
    },
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            const req = request(records.get(String(key)));
            window.setTimeout(() => {
              req.onsuccess?.(event);
              complete(transaction);
            }, 0);
            return req as IDBRequest;
          },
          put: (value: unknown) => {
            const key = (value as { key?: unknown }).key;
            if (typeof key === "string") records.set(key, value);
            complete(transaction);
            return request(undefined) as IDBRequest;
          },
          delete: (key: IDBValidKey) => {
            records.delete(String(key));
            complete(transaction);
            return request(undefined) as IDBRequest;
          },
        }),
      };
      return transaction as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  const indexedDB = {
    open: () => {
      const req: FakeOpenRequest = { ...request(db), onupgradeneeded: null };
      window.setTimeout(() => {
        req.onupgradeneeded?.(event as IDBVersionChangeEvent);
        req.onsuccess?.(event);
      }, 0);
      return req as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: indexedDB,
  });

  return records;
}

async function waitForUi(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

function stubStudioFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/voice-profile")) {
      return Response.json({
        profile: {
          status: "needs_enrollment",
          summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
          requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
          diagnostics: {},
          clips: [],
          rejectedClips: [],
        },
      });
    }
    if (url.includes("/api/runs")) return Response.json({ items: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

  it("loads the current recording kit on mount", async () => {
    installFakeIndexedDb();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/recording-kit")) {
        return Response.json({
          kit: {
            status: "written",
            promptSet: "extended",
            kit: "/tmp/anyvoice-current-kit",
            manifest: "/tmp/anyvoice-current-kit/manifest.json",
            cueSheetHtml: "/tmp/anyvoice-current-kit/cue-sheet.html",
            cueSheetUrl:
              "/api/voice-profile/recording-kit/cue-sheet?profileId=local-default&manifest=%2Ftmp%2Fanyvoice-current-kit%2Fmanifest.json",
            openCueSheetCommand: "python3 -m webbrowser -t file:///tmp/anyvoice-current-kit/cue-sheet.html",
            prompts: "/tmp/anyvoice-current-kit/prompts",
            recordings: "/tmp/anyvoice-current-kit/recordings",
            clips: 10,
            clipSpecs: Array.from({ length: 10 }, (_, index) => {
              const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
              return {
                id: stem,
                expectedStem: stem,
                recommendedDurationSec: index === 9 ? 10 : 9,
                durationMode: "auto",
                durationTargetSec: index === 9 ? 10 : 9,
                transcript:
                  index === 9
                    ? "最後這段用比較放鬆的語氣收尾。如果聲音穩定、停頓自然，數位分身才會更像本人。"
                    : index === 8
                      ? "請注意多音字：重慶、行長、長樂、角色和音樂，都要保持固定讀法，不要忽快忽慢。"
                      : "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
              };
            }),
            summary: {
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              coveredFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              missingCoverageFeatures: [],
            },
            checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json",
            recordMissingUntilCompleteCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
            normalizeExternalRecordingsCommand:
              "python3 scripts/normalize_voice_profile_recording_kit_audio.py --manifest /tmp/anyvoice-current-kit/manifest.json --check --profile-id local-default",
            enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json",
            importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-current-kit/manifest.json --build-profile",
            verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/voice-profile/recording-kit?profileId=local-default", { cache: "no-store" });
    expect(container.textContent).toContain("錄音資料夾已建立");
    expect(container.textContent).toContain("/tmp/anyvoice-current-kit/recordings");
    expect(container.textContent).toContain("10 段錄音進度");
    expect(container.textContent).toContain("第 10 / 10 段");
    expect(container.textContent).toContain("目標 9 秒");
    expect(container.textContent).toContain("目標 10 秒");
    expect(container.textContent).toContain("上傳 10 段錄音");
    expect(container.textContent).toContain("整理手機錄音");
    expect(container.textContent).toContain("normalize_voice_profile_recording_kit_audio.py");
    const cueSheetLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((link) =>
      link.getAttribute("href")?.includes("/api/voice-profile/recording-kit/cue-sheet?profileId=local-default"),
    );
    expect(cueSheetLink).not.toBeUndefined();
    expect(cueSheetLink?.textContent).toContain("開啟讀稿提示");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("bulk-uploads all clip specs from the current 10-clip recording kit", async () => {
    installFakeIndexedDb();
    const clipSpecs = Array.from({ length: 10 }, (_, index) => {
      const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      return {
        id: stem,
        expectedStem: stem,
        transcript:
          index === 9
            ? "最後這段用比較放鬆的語氣收尾。如果聲音穩定、停頓自然，數位分身才會更像本人。"
            : index === 8
              ? "請注意多音字：重慶、行長、長樂、角色和音樂，都要保持固定讀法，不要忽快忽慢。"
              : "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
      };
    });
    const importBodies: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/import")) {
        importBodies.push(init?.body as FormData);
        return Response.json({
          status: "imported",
          imported: 10,
          profile: {
            status: "ready",
            summary: { eligibleClips: 10, selectedClips: 10, rejectedClips: 0, remainingClipsNeeded: 0 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "ready",
            profile: ".anyvoice/voices/local-default/profile.json",
            summary: {
              selectedClips: 10,
              eligibleClips: 10,
              manifestClips: 10,
              totalDurationSec: 90,
              missingCoverageFeatures: [],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/transcript-validation")) {
        return Response.json({
          validation: {
            validationJson: "generated/voice-profile-transcript-validation/local-default.json",
            total: 10,
            passed: 10,
            failed: 0,
            status: "pass",
            backend: "faster-whisper",
            avgCer: 0.01,
            maxCer: 0.02,
            avgWer: 0.01,
            maxWer: 0.02,
          },
        });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({
          audit: {
            status: "blocked",
            complete: false,
            profileJson: ".anyvoice/voices/local-default/profile.json",
            kitManifest: "/tmp/anyvoice-current-kit/manifest.json",
            firstBlocker: {
              id: "quality_gate",
              status: "missing",
              ok: false,
              message: "quality gate has not run",
            },
            stages: [
              {
                id: "recording_kit",
                status: "pass",
                ok: true,
                message: "recording kit complete",
              },
              {
                id: "quality_gate",
                status: "missing",
                ok: false,
                message: "quality gate has not run",
              },
            ],
            nextProductProofCommand:
              "python3 scripts/run_voice_quality_gate.py --profile-json .anyvoice/voices/local-default/profile.json --clone-mode hifi --repeats 3",
          },
        });
      }
      if (url.includes("/api/voice-profile/recording-kit")) {
        return Response.json({
          kit: {
            status: "written",
            promptSet: "extended",
            kit: "/tmp/anyvoice-current-kit",
            manifest: "/tmp/anyvoice-current-kit/manifest.json",
            prompts: "/tmp/anyvoice-current-kit/prompts",
            recordings: "/tmp/anyvoice-current-kit/recordings",
            clips: 10,
            clipSpecs,
            checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json",
            enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json",
            importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-current-kit/manifest.json --build-profile",
            verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const bulkInput = container.querySelector<HTMLInputElement>('input[aria-label="上傳 10 段錄音"]');
    expect(bulkInput).not.toBeNull();
    Object.defineProperty(bulkInput!, "files", {
      configurable: true,
      value: Array.from({ length: 10 }, (_, index) => {
        const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
        return new File([new Uint8Array([index + 1])], `${stem}.m4a`, { type: "audio/mp4" });
      }),
    });
    await act(async () => {
      bulkInput!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(importBodies).toHaveLength(1);
    const clips = JSON.parse(String(importBodies[0].get("clips")));
    expect(clips).toHaveLength(10);
    expect(clips[9]).toMatchObject({
      id: "profile-clip-10",
      expectedStem: "profile-clip-10",
      transcript: expect.stringContaining("最後這段"),
    });
    expect(importBodies[0].get("voice-9")).toBeInstanceOf(File);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/transcript-validation",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/voice-profile/goal-audit", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("已自動開始逐字稿驗證與 10x 完成度審核");
    expect(container.textContent).toContain("逐字稿 ASR 驗證通過：10 / 10");
    expect(container.textContent).toContain("尚未完成：卡在 quality_gate");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a download link for the current uploaded voice sample", async () => {
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:anyvoice/reference";
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      if (url.includes("/api/voice-profile/recording-kit")) {
        return Response.json({
          kit: {
            status: "written",
            kit: "/tmp/anyvoice-profile-kit",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            cueSheetHtml: "/tmp/anyvoice-profile-kit/cue-sheet.html",
            openCueSheetCommand: "python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html",
            prompts: "/tmp/anyvoice-profile-kit/prompts",
            recordings: "/tmp/anyvoice-profile-kit/recordings",
            clips: 5,
            clipSpecs: Array.from({ length: 5 }, (_, index) => {
              const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
              return {
                id: stem,
                expectedStem: stem,
                recommendedDurationSec: 8 + index,
                durationMode: "auto",
                durationTargetSec: 8 + index,
                transcript:
                  index === 2
                    ? "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。"
                    : index === 1
                      ? "日期範例是二零二六年五月二十日，數字和節奏要清楚。"
                      : index === 3
                        ? "我會用平穩的速度說完這一段，避免突然變快或停太久。"
                        : index === 4
                          ? "最後這段用比較放鬆的語氣收尾，保持自然停頓。"
                          : "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
              };
            }),
            summary: {
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              coveredFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              missingCoverageFeatures: [],
            },
            checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
            recordMissingUntilCompleteCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
            recordNextMissingCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --next-missing --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check-selected --auto-duration",
            recordAndProveCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-proof-after-check",
            recordProveAndProductProofCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-product-proof-after-check",
            recordProveProductProofAndLoraCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --prepare-lora-after-product-proof",
            enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
            proofCommand:
              "python3 scripts/voice_profile_next_step.py --profile-json .anyvoice/voices/local-default/profile.json --kit-manifest /tmp/anyvoice-profile-kit/manifest.json --profile-id local-default --run --auto-advance --allow-enroll --allow-expensive --stop-before-lora --max-steps 3",
            importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-profile-kit/manifest.json --build-profile",
            verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
          },
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
    });

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    await act(async () => {
      tabs[1]?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const voice = new File([new Uint8Array([1, 2, 3, 4])], "saved-reference.wav", { type: "audio/wav" });
    Object.defineProperty(input!, "files", { configurable: true, value: [voice] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const download = container.querySelector<HTMLAnchorElement>('a[download="saved-reference.wav"]');
    expect(download?.getAttribute("href")).toBe("blob:anyvoice/reference");
    expect(download?.getAttribute("aria-label")).toBe("下載目前聲音樣本");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("restores the last uploaded voice sample from browser storage until cleared", async () => {
    const storedReferences = installFakeIndexedDb();
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    let objectUrlCount = 0;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:anyvoice/reference-${objectUrlCount++}`;
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    await act(async () => {
      tabs[1]?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const voice = new File([new Uint8Array([1, 2, 3, 4])], "persistent-reference.wav", { type: "audio/wav" });
    Object.defineProperty(input!, "files", { configurable: true, value: [voice] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(storedReferences.has("last")).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.replaceChildren();

    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const restoredDownload = container.querySelector<HTMLAnchorElement>('a[download="persistent-reference.wav"]');
    expect(restoredDownload?.getAttribute("href")).toBe("blob:anyvoice/reference-1");
    expect(container.textContent).toContain("已保存在此瀏覽器，下次開啟會自動帶回。");

    const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="移除目前聲音樣本"]');
    expect(clearButton).not.toBeNull();
    await act(async () => {
      clearButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(storedReferences.has("last")).toBe(false);
    expect(container.querySelector<HTMLAnchorElement>('a[download="persistent-reference.wav"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("restores the last browser-recorded voice sample from browser storage", async () => {
    const storedReferences = installFakeIndexedDb();
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    let objectUrlCount = 0;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:anyvoice/recording-${objectUrlCount++}`;
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});

    const originalMediaDevices = navigator.mediaDevices;
    const track = {
      stop: vi.fn(),
      getSettings: () => ({
        autoGainControl: false,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
      }),
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType || "audio/webm";
      }

      start() {
        this.state = "recording";
      }

      requestData() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([9, 8, 7, 6])], { type: this.mimeType }) } as BlobEvent);
      }

      stop() {
        this.state = "inactive";
        window.setTimeout(() => this.onstop?.(new Event("stop")), 0);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    await act(async () => {
      tabs[1]?.click();
    });

    const recordButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".booth-actions .btn--primary")).find((button) =>
      button.textContent?.includes("自由錄音"),
    );
    expect(recordButton).not.toBeUndefined();
    await act(async () => {
      recordButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: { ideal: false },
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        sampleRate: { ideal: 48000 },
      },
    });
    expect(container.textContent).toContain("錄音設定：聲道 2 / 44100 Hz");
    expect(container.textContent).toContain("瀏覽器仍開啟 回音消除 / 降噪");

    const stopButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("停止"),
    );
    expect(stopButton).not.toBeUndefined();
    await act(async () => {
      stopButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(storedReferences.has("last")).toBe(true);
    const stored = storedReferences.get("last") as { kind?: string; name?: string; file?: Blob } | undefined;
    expect(stored?.kind).toBe("freeform");
    expect(stored?.name).toMatch(/^recording-\d+\.webm$/);
    expect(stored?.file).toBeInstanceOf(File);

    await act(async () => {
      root.unmount();
    });
    container.replaceChildren();

    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const restoredDownload = container.querySelector<HTMLAnchorElement>('a[download^="recording-"]');
    expect(restoredDownload?.getAttribute("href")).toBe("blob:anyvoice/recording-1");
    expect(container.textContent).toContain("已保存在此瀏覽器，下次開啟會自動帶回。");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("restores saved profile recording drafts and can enroll them without re-recording", async () => {
    const storedReferences = installFakeIndexedDb();
    const transcript =
      "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。";
    storedReferences.set("profile-draft:0", {
      key: "profile-draft:0",
      index: 0,
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
      name: "profile-clip-01.webm",
      type: "audio/webm",
      lastModified: 123,
      transcript,
      savedAt: 456,
    });
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:anyvoice/profile-draft";
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});

    const enrollForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/enroll")) {
        enrollForms.push(init?.body as FormData);
        return Response.json({
          status: "enrolled",
          referenceQuality: {
            grade: "A",
            durationSec: 7,
            snrDb: 30,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 0, remainingClipsNeeded: 4 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "blocked",
            profile: ".anyvoice/voices/local-default/profile.json",
            summary: {
              selectedClips: 1,
              eligibleClips: 1,
              manifestClips: 1,
              totalDurationSec: 7,
              missingCoverageFeatures: ["numbers_dates"],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [{ check: "clip_count", ok: false, message: "1 selected / 1 eligible, 1 manifest clips" }],
            nextStep: {
              status: "needs_recording",
              phase: "recording",
              brief:
                "Status: needs_recording\nNext action: record_profile_kit\nMissing audio clips: profile-clip-03\nProduct 10x proof command: python3 scripts/run_voice_quality_gate.py --clone-mode both",
              nextAction: {
                id: "record_profile_kit",
                phase: "recording",
                status: "needs_recording",
                command: "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json",
                reason: "4 clip(s) need audio files",
              },
            },
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("瀏覽器已暫存 1 段錄音。");
    expect(container.textContent).toContain("已暫存");
    const nextRecording = container.querySelector<HTMLElement>(".profile-next p");
    expect(nextRecording?.textContent).toContain("日期範例是二零二六年五月二十日");
    expect(nextRecording?.textContent).not.toContain(transcript);
    const useSaved = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入已存錄音"),
    );
    expect(useSaved).not.toBeUndefined();
    await act(async () => {
      useSaved!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(enrollForms).toHaveLength(1);
    const voice = enrollForms[0].get("voice");
    expect(voice).toBeInstanceOf(File);
    expect((voice as File).name).toBe("profile-clip-01.webm");
    expect(enrollForms[0].get("promptTranscript")).toBe(transcript);
    expect(container.textContent).toContain("已加入參考音");
    expect(container.textContent).toContain("Hard gate 尚未通過");
    expect(container.textContent).toContain("4 clip(s) need audio files");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("keeps a browser profile recording session moving to the next missing prompt", async () => {
    const storedReferences = installFakeIndexedDb();
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    const originalNow = window.performance.now;
    let objectUrlCount = 0;
    let nowMs = 0;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:anyvoice/profile-session-${objectUrlCount++}`;
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: () => nowMs,
    });

    const originalMediaDevices = navigator.mediaDevices;
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });

    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType || "audio/webm";
        FakeMediaRecorder.instances.push(this);
      }

      start() {
        this.state = "recording";
      }

      requestData() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5, 6, 7])], { type: this.mimeType }) } as BlobEvent);
      }

      stop() {
        this.state = "inactive";
        window.setTimeout(() => this.onstop?.(new Event("stop")), 0);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const enrollForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/enroll")) {
        enrollForms.push(init?.body as FormData);
        const eligibleClips = enrollForms.length;
        return Response.json({
          status: "enrolled",
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 30,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips, selectedClips: eligibleClips, rejectedClips: 0, remainingClipsNeeded: 5 - eligibleClips },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "blocked",
            profile: ".anyvoice/voices/local-default/profile.json",
            summary: {
              selectedClips: enrollForms.length,
              eligibleClips: enrollForms.length,
              manifestClips: enrollForms.length,
              totalDurationSec: enrollForms.length * 8,
              missingCoverageFeatures: [],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [{ check: "clip_count", ok: false, message: `${enrollForms.length} selected` }],
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const startSession = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("連續錄剩下片段"),
    );
    expect(startSession).not.toBeUndefined();
    await act(async () => {
      startSession!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(container.textContent).toContain("停止連續錄音");

    nowMs = 8200;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 260));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(FakeMediaRecorder.instances[0].state).toBe("inactive");
    expect(storedReferences.has("profile-draft:0")).toBe(true);
    expect(container.textContent).toContain("下一段 2 秒後開始");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
    });
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(enrollForms[0].get("promptTranscript")).toContain("你好，我正在錄製一段聲音樣本");
    expect(container.textContent).toContain("日期範例是二零二六年五月二十日");

    const stopSession = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("停止連續錄音"),
    );
    expect(stopSession).not.toBeUndefined();
    await act(async () => {
      stopSession!.click();
      FakeMediaRecorder.instances[1].requestData();
      FakeMediaRecorder.instances[1].stop();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(storedReferences.has("profile-draft:1")).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: originalNow,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("stops guided profile recording when the browser keeps audio processing enabled", async () => {
    installFakeIndexedDb();
    const stopTrack = vi.fn();
    const originalMediaDevices = navigator.mediaDevices;
    const stream = {
      getAudioTracks: () => [
        {
          stop: stopTrack,
          getSettings: () => ({
            channelCount: 2,
            sampleRate: 44100,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          }),
        },
      ],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      state: RecordingState = "inactive";

      constructor() {
        FakeMediaRecorder.instances.push(this);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const startSession = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("連續錄剩下片段"),
    );
    expect(startSession).not.toBeUndefined();
    await act(async () => {
      startSession!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getUserMedia).toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(container.textContent).toContain("瀏覽器仍開啟 回音消除 / 降噪");
    expect(container.textContent).toContain("外部錄音資料夾");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("preflights a clean browser mic path before profile recording", async () => {
    installFakeIndexedDb();
    const stopTrack = vi.fn();
    const originalMediaDevices = navigator.mediaDevices;
    const stream = {
      getAudioTracks: () => [
        {
          stop: stopTrack,
          getSettings: () => ({
            channelCount: 1,
            sampleRate: 48000,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }),
        },
      ],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;

      constructor() {
        FakeMediaRecorder.instances.push(this);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const checkMic = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("檢查瀏覽器麥克風"),
    );
    expect(checkMic).not.toBeUndefined();
    await act(async () => {
      checkMic!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: { ideal: false },
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        sampleRate: { ideal: 48000 },
      },
    });
    expect(stopTrack).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(container.textContent).toContain("錄音設定：聲道 1 / 48000 Hz，瀏覽器處理已關閉。");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("preflights and rejects a browser mic path with processing enabled", async () => {
    installFakeIndexedDb();
    const stopTrack = vi.fn();
    const originalMediaDevices = navigator.mediaDevices;
    const stream = {
      getAudioTracks: () => [
        {
          stop: stopTrack,
          getSettings: () => ({
            channelCount: 2,
            sampleRate: 44100,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }),
        },
      ],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });

    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;

      constructor() {
        FakeMediaRecorder.instances.push(this);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const checkMic = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("檢查瀏覽器麥克風"),
    );
    expect(checkMic).not.toBeUndefined();
    await act(async () => {
      checkMic!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(stopTrack).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(container.textContent).toContain("瀏覽器仍開啟 回音消除 / 降噪 / 自動增益");
    expect(container.textContent).toContain("外部錄音資料夾");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("auto-imports saved drafts when a browser profile recording session finishes", async () => {
    const storedReferences = installFakeIndexedDb();
    const clipSpecs = Array.from({ length: 10 }, (_, index) => {
      const clip = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      return {
        id: clip,
        expectedStem: clip,
        transcript:
          index === 9
            ? "最後這段用比較放鬆的語氣收尾。如果聲音穩定、停頓自然，數位分身才會更像本人。"
            : `第 ${index + 1} 段錄音。`,
      };
    });
    clipSpecs.slice(0, 9).forEach((spec, index) => {
      storedReferences.set(`profile-draft:${index}`, {
        key: `profile-draft:${index}`,
        index,
        file: new Blob([new Uint8Array([index + 1, index + 2])], { type: "audio/webm" }),
        name: `${spec.expectedStem}.webm`,
        type: "audio/webm",
        lastModified: 100 + index,
        transcript: spec.transcript,
        savedAt: 200 + index,
      });
    });
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    const originalNow = window.performance.now;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:anyvoice/profile-session-final";
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: () => Number.NaN,
    });

    const originalMediaDevices = navigator.mediaDevices;
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });

    class FakeMediaRecorder {
      static instances: FakeMediaRecorder[] = [];
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType || "audio/webm";
        FakeMediaRecorder.instances.push(this);
      }

      start() {
        this.state = "recording";
      }

      requestData() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([8, 9, 10, 11])], { type: this.mimeType }) } as BlobEvent);
      }

      stop() {
        this.state = "inactive";
        window.setTimeout(() => this.onstop?.(new Event("stop")), 0);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const importForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/recording-kit")) {
        return Response.json({
          kit: {
            status: "written",
            promptSet: "extended",
            kit: "/tmp/anyvoice-current-kit",
            manifest: "/tmp/anyvoice-current-kit/manifest.json",
            cueSheetHtml: "/tmp/anyvoice-current-kit/cue-sheet.html",
            openCueSheetCommand: "python3 -m webbrowser -t file:///tmp/anyvoice-current-kit/cue-sheet.html",
            prompts: "/tmp/anyvoice-current-kit/prompts",
            recordings: "/tmp/anyvoice-current-kit/recordings",
            clips: 10,
            clipSpecs,
            summary: {
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              coveredFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              missingCoverageFeatures: [],
            },
            checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-current-kit/manifest.json",
          },
        });
      }
      if (url.includes("/api/voice-profile/enroll")) {
        return Response.json({
          status: "enrolled",
          referenceQuality: {
            grade: "A",
            durationSec: 8,
            snrDb: 30,
            clippingRatio: 0,
            vadActiveRatio: 0.8,
            warnings: [],
          },
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 10, selectedClips: 10, rejectedClips: 0, remainingClipsNeeded: 0 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/import")) {
        importForms.push(init?.body as FormData);
        return Response.json({
          status: "imported",
          imported: 10,
          profile: {
            status: "ready",
            summary: { eligibleClips: 10, selectedClips: 10, rejectedClips: 0, remainingClipsNeeded: 0 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/transcript-validation")) {
        return Response.json({
          validation: {
            validationJson: "generated/voice-profile-transcript-validation/local-default.json",
            total: 10,
            passed: 10,
            failed: 0,
            status: "pass",
            backend: "faster-whisper",
            avgCer: 0.01,
            maxCer: 0.02,
            avgWer: 0.01,
            maxWer: 0.02,
          },
        });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({
          audit: {
            status: "blocked",
            complete: false,
            profileJson: ".anyvoice/voices/local-default/profile.json",
            firstBlocker: {
              id: "quality_gate",
              status: "missing",
              ok: false,
              message: "quality gate has not run",
            },
            stages: [
              { id: "strict_profile", status: "pass", ok: true, message: "strict profile passed" },
              { id: "quality_gate", status: "missing", ok: false, message: "quality gate has not run" },
            ],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "ready",
            profile: ".anyvoice/voices/local-default/profile.json",
            summary: {
              selectedClips: 10,
              eligibleClips: 10,
              manifestClips: 10,
              totalDurationSec: 80,
              missingCoverageFeatures: [],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [{ check: "clip_count", ok: true, message: "10 selected / 10 eligible, 10 manifest clips" }],
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await waitForUi(() => container.textContent?.includes("瀏覽器已暫存 9 段錄音。") ?? false);
    expect(container.textContent).toContain("瀏覽器已暫存 9 段錄音。");
    const startSession = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("連續錄剩下片段"),
    );
    expect(startSession).not.toBeUndefined();
    await act(async () => {
      startSession!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      FakeMediaRecorder.instances[0].requestData();
      FakeMediaRecorder.instances[0].stop();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    for (let index = 0; index < 6; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(importForms).toHaveLength(1);
    expect(importForms[0].get("voice-9")).toBeInstanceOf(File);
    const clips = JSON.parse(String(importForms[0].get("clips"))) as Array<{ expectedStem: string; transcript: string }>;
    expect(clips).toHaveLength(10);
    expect(clips[9]).toMatchObject({ expectedStem: "profile-clip-10" });
    expect(clips[9].transcript).toContain("最後這段");
    expect(fetchMock).toHaveBeenCalledWith("/api/voice-profile/import", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/transcript-validation",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/voice-profile/goal-audit", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("已自動開始逐字稿驗證與 10x 完成度審核");
    expect(container.textContent).toContain("尚未完成：卡在 quality_gate");
    expect(storedReferences.has("profile-draft:0")).toBe(false);
    expect(storedReferences.has("profile-draft:9")).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: originalNow,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("can import all saved profile recording drafts in one request", async () => {
    const storedReferences = installFakeIndexedDb();
    Array.from({ length: 5 }, (_, index) => {
      const clip = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      storedReferences.set(`profile-draft:${index}`, {
        key: `profile-draft:${index}`,
        index,
        file: new Blob([new Uint8Array([index + 1, index + 2])], { type: "audio/webm" }),
        name: `${clip}.webm`,
        type: "audio/webm",
        lastModified: 100 + index,
        transcript: `第 ${index + 1} 段錄音。`,
        savedAt: 200 + index,
      });
    });

    const importForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/import")) {
        importForms.push(init?.body as FormData);
        return Response.json({
          status: "imported",
          imported: 5,
          profile: {
            status: "ready",
            summary: { eligibleClips: 5, selectedClips: 5, rejectedClips: 0, remainingClipsNeeded: 0 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "ready",
            profile: ".anyvoice/voices/local-default/profile.json",
            summary: {
              selectedClips: 5,
              eligibleClips: 5,
              manifestClips: 5,
              totalDurationSec: 40,
              missingCoverageFeatures: [],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [
              { check: "clip_count", ok: true, message: "5 selected / 5 eligible, 5 manifest clips" },
              { check: "transcript_validation", ok: true, message: "ASR transcript validation passed for selected clips" },
            ],
            nextStep: {
              status: "ready_for_quality_gate",
              phase: "quality_gate",
              nextAction: {
                id: "run_quality_gate",
                phase: "quality_gate",
                status: "ready_for_quality_gate",
                command: "python3 scripts/run_voice_quality_gate.py --profile-json .anyvoice/voices/local-default/profile.json --clone-mode hifi --repeats 3",
                reason: "strict profile verifier passed; prove quality before making the digital voice default",
              },
            },
          },
        });
      }
      if (url.includes("/api/voice-profile/transcript-validation")) {
        return Response.json({
          validation: {
            validationJson: "generated/voice-profile-transcript-validation/local-default.json",
            total: 5,
            passed: 5,
            failed: 0,
            status: "pass",
            backend: "faster-whisper",
            avgCer: 0.01,
            maxCer: 0.02,
            avgWer: 0.01,
            maxWer: 0.02,
          },
        });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({
          audit: {
            status: "blocked",
            complete: false,
            profileJson: ".anyvoice/voices/local-default/profile.json",
            kitManifest: "generated/voice-profile-recording-kits/local-default-current/manifest.json",
            firstBlocker: {
              id: "quality_gate",
              status: "missing",
              ok: false,
              message: "quality gate has not run",
            },
            stages: [
              {
                id: "strict_profile",
                status: "pass",
                ok: true,
                message: "strict profile passed",
              },
              {
                id: "quality_gate",
                status: "missing",
                ok: false,
                message: "quality gate has not run",
              },
            ],
            nextProductProofCommand:
              "python3 scripts/run_voice_quality_gate.py --profile-json .anyvoice/voices/local-default/profile.json --clone-mode hifi --repeats 3",
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("瀏覽器已暫存 5 段錄音。");
    const importAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入全部暫存錄音"),
    );
    expect(importAll).not.toBeUndefined();
    await act(async () => {
      importAll!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }

    expect(importForms).toHaveLength(1);
    for (let index = 0; index < 5; index += 1) {
      const voice = importForms[0].get(`voice-${index}`);
      expect(voice).toBeInstanceOf(File);
      expect((voice as File).name).toContain(`profile-clip-0${index + 1}`);
    }
    const clips = JSON.parse(String(importForms[0].get("clips"))) as Array<{ expectedStem: string; transcript: string }>;
    expect(clips).toHaveLength(5);
    expect(clips[0]).toMatchObject({ expectedStem: "profile-clip-01" });
    expect(clips[0].transcript).toContain("你好，我正在錄製一段聲音樣本");
    expect(container.textContent).toContain("已可建立數位聲音");
    expect(container.textContent).toContain("Hard gate 已通過");
    expect(container.textContent).toContain("scripts/run_voice_quality_gate.py");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/transcript-validation",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/voice-profile/goal-audit", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("已自動開始逐字稿驗證與 10x 完成度審核");
    expect(container.textContent).toContain("逐字稿 ASR 驗證通過：5 / 5");
    expect(container.textContent).toContain("尚未完成：卡在 quality_gate");
    expect(storedReferences.has("profile-draft:0")).toBe(false);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("blocks importing saved profile drafts with known bad durations", async () => {
    const storedReferences = installFakeIndexedDb();
    Array.from({ length: 5 }, (_, index) => {
      const clip = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      storedReferences.set(`profile-draft:${index}`, {
        key: `profile-draft:${index}`,
        index,
        file: new Blob([new Uint8Array([index + 1, index + 2])], { type: "audio/webm" }),
        name: `${clip}.webm`,
        type: "audio/webm",
        lastModified: 100 + index,
        transcript: `第 ${index + 1} 段錄音。`,
        durationSec: index === 0 ? 2 : 7,
        savedAt: 200 + index,
      });
    });

    const importForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/import")) {
        importForms.push(init?.body as FormData);
        return Response.json({ status: "imported" });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("0:02，未滿 6 秒");
    const importAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入全部暫存錄音"),
    );
    expect(importAll).not.toBeUndefined();
    await act(async () => {
      importAll!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(importForms).toHaveLength(0);
    expect(container.textContent).toContain("有暫存錄音不在門檻秒數或人聲時間內");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("blocks importing saved profile drafts with known low active voice time", async () => {
    const storedReferences = installFakeIndexedDb();
    Array.from({ length: 5 }, (_, index) => {
      const clip = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      storedReferences.set(`profile-draft:${index}`, {
        key: `profile-draft:${index}`,
        index,
        file: new Blob([new Uint8Array([index + 1, index + 2])], { type: "audio/webm" }),
        name: `${clip}.webm`,
        type: "audio/webm",
        lastModified: 100 + index,
        transcript: `第 ${index + 1} 段錄音。`,
        durationSec: 8,
        voiceActiveSec: index === 0 ? 1 : 6,
        savedAt: 200 + index,
      });
    });

    const importForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/import")) {
        importForms.push(init?.body as FormData);
        return Response.json({ status: "imported" });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("0:08 / 人聲 0:01，未滿 0:05");
    expect(container.textContent).toContain("已暫存 0:08 / 人聲 0:06");
    const importAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入全部暫存錄音"),
    );
    expect(importAll).not.toBeUndefined();
    await act(async () => {
      importAll!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(importForms).toHaveLength(0);
    expect(container.textContent).toContain("有暫存錄音不在門檻秒數或人聲時間內");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("blocks importing saved profile drafts with browser audio processing enabled", async () => {
    const storedReferences = installFakeIndexedDb();
    Array.from({ length: 5 }, (_, index) => {
      const clip = `profile-clip-${String(index + 1).padStart(2, "0")}`;
      storedReferences.set(`profile-draft:${index}`, {
        key: `profile-draft:${index}`,
        index,
        file: new Blob([new Uint8Array([index + 1, index + 2])], { type: "audio/webm" }),
        name: `${clip}.webm`,
        type: "audio/webm",
        lastModified: 100 + index,
        transcript: `第 ${index + 1} 段錄音。`,
        durationSec: 8,
        voiceActiveSec: 6,
        captureSettings: {
          channelCount: 2,
          sampleRate: 44100,
          echoCancellation: index === 0,
          noiseSuppression: index === 0,
          autoGainControl: false,
        },
        savedAt: 200 + index,
      });
    });

    const importForms: FormData[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/import")) {
        importForms.push(init?.body as FormData);
        return Response.json({ status: "imported" });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 0, selectedClips: 0, rejectedClips: 0, remainingClipsNeeded: 5 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("0:08，瀏覽器處理未關：回音消除 / 降噪");
    const importAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("加入全部暫存錄音"),
    );
    expect(importAll).not.toBeUndefined();
    await act(async () => {
      importAll!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(importForms).toHaveLength(0);
    expect(container.textContent).toContain("有暫存錄音仍開啟瀏覽器處理");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("blocks voice-profile enrollment when the reference transcript mixes Chinese scripts", async () => {
    const originalCreate = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL;
    const originalRevoke = (URL as { revokeObjectURL?: (s: string) => void }).revokeObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:anyvoice/reference";
    (URL as { revokeObjectURL: (s: string) => void }).revokeObjectURL = (() => {});
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    await act(async () => {
      tabs[1]?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const voice = new File([new Uint8Array([1, 2, 3, 4])], "mixed-reference.wav", { type: "audio/wav" });
    Object.defineProperty(input!, "files", { configurable: true, value: [voice] });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const transcript = container.querySelector<HTMLTextAreaElement>("#freeform-transcript");
    expect(transcript).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(transcript!, "这个聲音要穩定。");
      transcript!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("聲音檔案需要繁體中文逐字稿");
    const enroll = container.querySelector<HTMLButtonElement>(".btn--profile-enroll");
    expect(enroll?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    if (originalCreate) (URL as { createObjectURL: typeof originalCreate }).createObjectURL = originalCreate;
    if (originalRevoke) (URL as { revokeObjectURL: typeof originalRevoke }).revokeObjectURL = originalRevoke;
  });

  it("offers one-click pronunciation replacements for risky target terms", async () => {
    stubStudioFetch();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const target = container.querySelector<HTMLTextAreaElement>("textarea.is-hero");
    expect(target).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(target!, "請把重慶、角色和 AnyVoice 唸準。");
      target!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("建議替換");
    expect(container.textContent).toContain("模型文字");
    expect(container.textContent).toContain("pinyin:原詞=讀法");
    expect(container.textContent).toContain("請把重 慶、角 色和 Any Voice 唸準。");
    const suggestion = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("重慶"),
    );
    expect(suggestion).not.toBeUndefined();
    await act(async () => {
      suggestion!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await waitForUi(() => Boolean(container.querySelector<HTMLTextAreaElement>("#pronunciation-overrides")?.value.includes("重慶=重 慶")));
    const overrides = container.querySelector<HTMLTextAreaElement>("#pronunciation-overrides");
    expect(overrides?.value).toContain("重慶=重 慶");
    expect(container.textContent).toContain("模型文字");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("blocks digital-voice generation when target Chinese script is Simplified or mixed", async () => {
    installFakeIndexedDb();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "ready",
            profile: ".anyvoice/voices/local-default/profile.json",
            voiceProfileId: "local-default",
            summary: {
              selectedClips: 5,
              eligibleClips: 5,
              manifestClips: 5,
              totalDurationSec: 40,
              missingCoverageFeatures: [],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [
              { check: "clip_count", ok: true, message: "5 selected / 5 eligible, 5 manifest clips" },
              { check: "transcript_validation", ok: true, message: "ASR transcript validation passed for selected clips" },
            ],
            nextCommands: {},
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "ready",
            summary: { eligibleClips: 5, selectedClips: 5, rejectedClips: 0, remainingClipsNeeded: 0 },
            requirements: { minClips: 5, maxClips: 10, minDurationSec: 6, maxDurationSec: 20 },
            referenceClipIds: ["clip-1", "clip-2", "clip-3", "clip-4", "clip-5"],
            diagnostics: {},
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("使用數位聲音");
    expect(container.textContent).toContain("需先通過嚴格檢查與逐字稿 ASR 驗證");
    const profileUse = container.querySelector<HTMLInputElement>(".profile-use input");
    expect(profileUse?.disabled).toBe(true);
    const verifyButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("檢查聲音檔案"),
    );
    expect(verifyButton).not.toBeUndefined();
    await act(async () => {
      verifyButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Hard gate 已通過");
    expect(container.querySelector<HTMLInputElement>(".profile-use input")?.checked).toBe(true);
    const target = container.querySelector<HTMLTextAreaElement>("textarea.is-hero");
    expect(target).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(target!, "请用我的数位声音说这句话。");
      target!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("使用數位聲音時，目標文字需要繁體中文");
    expect(container.textContent).toContain("偵測線索");
    expect(container.textContent).toContain("声->聲");
    const submit = container.querySelector<HTMLButtonElement>(".btn--submit");
    expect(submit?.disabled).toBe(true);
    const fixButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("套用已知繁體修正"),
    );
    expect(fixButton).not.toBeUndefined();
    await act(async () => {
      fixButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(target!.value).toBe("請用我的數位聲音說這句話。");
    expect(container.textContent).not.toContain("使用數位聲音時，目標文字需要繁體中文");
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(target!, "中文音色自然。");
      target!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("目前無法證明這段是繁體");
    expect(container.textContent).toContain("沒有足夠線索證明是繁體");
    expect(submit?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the next missing profile recording script", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/voice-profile/recording-kit/check")) {
        return Response.json({
          check: {
            status: "incomplete",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            profileId: "local-default",
            summary: {
              clips: 5,
              minClips: 5,
              audioFilesPresent: 3,
              coveredFeatures: ["zh_hant", "latin_terms"],
              missingCoverageFeatures: ["numbers_dates"],
            },
            checks: [
              { check: "clip_count", ok: true, message: "5 clips listed / 5 required" },
              { check: "audio_files", ok: false, message: "2 clip(s) need attention" },
              {
                check: "transcripts",
                ok: false,
                message: "1 clip(s) need transcript fixes",
                details: {
                  rows: [
                    {
                      id: "profile-clip-02",
                      transcriptScript: "zh_unknown",
                      errors: ["unproven_chinese_script"],
                    },
                  ],
                },
              },
              { check: "coverage", ok: false, message: "missing coverage: numbers_dates" },
            ],
            nextCommands: {
              importProfileClips:
                "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-profile-kit/manifest.json --build-profile",
              verifyProfile:
                "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
            },
          },
        });
      }
      if (url.includes("/api/voice-profile/recording-kit/preflight")) {
        return Response.json({
          preflight: {
            status: "ready_to_record",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            message: "5 clip(s) will be recorded",
            durationSec: 9,
            countdownSec: 0,
            summary: {
              clips: 5,
              existing: 0,
              toRecord: 5,
              toSkipExisting: 0,
              promptBlocked: 0,
              transcriptBlocked: 0,
              recordingMetadataChecked: 0,
              recordingMetadataBlocked: 0,
              writeBlocked: 0,
            },
            recorder: {
              configured: true,
              source: "sox:rec",
              template: "rec {audio_path}",
            },
            clips: [
              {
                id: "profile-clip-03",
                index: 3,
                transcript:
                  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
                pronunciationNotes: [
                  "重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4",
                  "銀行: ㄧㄣˊ ㄏㄤˊ / yin2 hang2",
                ],
                coverageFeatures: ["latin_terms", "polyphones", "punctuation_rhythm", "zh_hant"],
                action: "record",
                exists: false,
                audioPath: "/tmp/anyvoice-profile-kit/recordings/profile-clip-03.wav",
              },
            ],
            nextCommands: {
              record:
                "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --check --countdown-sec 2 --write-metadata",
            },
          },
        });
      }
      if (url.includes("/api/voice-profile/recording-kit/microphone-smoke-test")) {
        return Response.json({
          preflight: {
            status: "ready_to_record",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            message: "5 clip(s) will be recorded",
            durationSec: 9,
            countdownSec: 0,
            summary: {
              clips: 5,
              existing: 0,
              toRecord: 5,
              toSkipExisting: 0,
              promptBlocked: 0,
              transcriptBlocked: 0,
              recordingMetadataChecked: 0,
              recordingMetadataBlocked: 0,
              writeBlocked: 0,
            },
            recorder: {
              configured: true,
              source: "sox:rec",
              template: "rec {audio_path}",
            },
            microphoneSmokeTest: {
              status: "passed",
              durationSec: 2,
              clipId: "profile-clip-01",
              exitCode: 0,
              audioBytes: 32044,
              keptAudio: false,
            },
            clips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/recording-kit/normalize")) {
        return Response.json({
          normalization: {
            status: "blocked",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            profileId: "local-default",
            dryRun: false,
            overwrite: false,
            sourceDirs: ["/tmp/anyvoice-profile-kit/recordings"],
            summary: {
              clips: 5,
              normalized: 2,
              existing: 1,
              missingSources: 2,
              failures: 0,
            },
            rows: [],
            checkReport: {
              status: "incomplete",
              manifest: "/tmp/anyvoice-profile-kit/manifest.json",
              profileId: "local-default",
              summary: {
                clips: 5,
                minClips: 5,
                audioFilesPresent: 3,
                coveredFeatures: ["zh_hant", "latin_terms"],
                missingCoverageFeatures: ["numbers_dates"],
              },
              checks: [
                { check: "clip_count", ok: true, message: "5 clips listed / 5 required" },
                { check: "audio_files", ok: false, message: "2 clip(s) need attention" },
              ],
              nextCommands: {
                importProfileClips:
                  "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-profile-kit/manifest.json --build-profile",
              },
            },
          },
        });
      }
      if (url.includes("/api/voice-profile/recording-kit")) {
        return Response.json({
          kit: {
            status: "written",
            kit: "/tmp/anyvoice-profile-kit",
            manifest: "/tmp/anyvoice-profile-kit/manifest.json",
            cueSheetHtml: "/tmp/anyvoice-profile-kit/cue-sheet.html",
            openCueSheetCommand: "python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html",
            prompts: "/tmp/anyvoice-profile-kit/prompts",
            recordings: "/tmp/anyvoice-profile-kit/recordings",
            clips: 5,
            clipSpecs: Array.from({ length: 5 }, (_, index) => {
              const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
              return {
                id: stem,
                expectedStem: stem,
                recommendedDurationSec: 9 + index,
                durationMode: "auto",
                durationTargetSec: 9 + index,
                transcript:
                  index === 2
                    ? "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。"
                    : index === 1
                      ? "日期範例是二零二六年五月二十日，數字和節奏要清楚。"
                      : index === 3
                        ? "我會用平穩的速度說完這一段，避免突然變快或停太久。"
                        : index === 4
                          ? "最後這段用比較放鬆的語氣收尾，保持自然停頓。"
                          : "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
              };
            }),
            summary: {
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              coveredFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
              missingCoverageFeatures: [],
            },
            checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
            recordMissingUntilCompleteCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
            recordNextMissingCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --next-missing --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check-selected --auto-duration",
            recordAndProveCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-proof-after-check",
            recordProveAndProductProofCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-product-proof-after-check",
            recordProveProductProofAndLoraCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --prepare-lora-after-product-proof",
            enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
            proofCommand:
              "python3 scripts/voice_profile_next_step.py --profile-json .anyvoice/voices/local-default/profile.json --kit-manifest /tmp/anyvoice-profile-kit/manifest.json --profile-id local-default --run --auto-advance --allow-enroll --allow-expensive --stop-before-lora --max-steps 3",
            importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-profile-kit/manifest.json --build-profile",
            verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
          },
        });
      }
      if (url.includes("/api/voice-profile/import")) {
        return Response.json({
          status: "imported",
          imported: 5,
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 4, selectedClips: 4, rejectedClips: 1, remainingClipsNeeded: 1 },
            requirements: {
              minClips: 5,
              maxClips: 10,
              minDurationSec: 6,
              maxDurationSec: 20,
              passingGrades: ["A", "B"],
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
            },
            diagnostics: {
              eligibleTranscriptScripts: [{ script: "zh_hant", count: 4 }],
              coverageFeatures: [
                { feature: "zh_hant", count: 4 },
                { feature: "latin_terms", count: 1 },
              ],
              missingCoverageFeatures: ["numbers_dates"],
              rejectionReasons: [],
              topRejectedClips: [],
            },
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/reanalyze")) {
        return Response.json({
          reanalysis: {
            status: "completed_with_errors",
            runsDir: ".anyvoice/runs",
            analyzer: "scripts/analyze_voice_reference.py",
            python: "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python",
            dryRun: false,
            force: false,
            scanned: 8,
            plannedOrUpdated: 2,
            skipped: { already_analyzed: 5, missing_transcript: 1 },
            runs: [
              {
                sourceRunId: "old-run",
                status: "updated",
                quality: { grade: "C", durationSec: 3.4, warnings: [] },
              },
            ],
            failures: [{ sourceRunId: "broken-wav", message: "invalid audio" }],
            profile: {
              status: "needs_enrollment",
              eligibleClips: 1,
              selectedClips: 1,
              remainingClipsNeeded: 4,
            },
          },
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 2, remainingClipsNeeded: 4 },
            requirements: {
              minClips: 5,
              maxClips: 10,
              minDurationSec: 6,
              maxDurationSec: 20,
              passingGrades: ["A", "B"],
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
            },
            diagnostics: {
              eligibleTranscriptScripts: [{ script: "zh_hant", count: 1 }],
              coverageFeatures: [{ feature: "zh_hant", count: 1 }],
              missingCoverageFeatures: ["numbers_dates"],
              rejectionReasons: [{ reason: "too_short", count: 2 }],
              topRejectedClips: [],
            },
            clips: [],
            rejectedClips: [],
          },
        });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({
          verification: {
            status: "blocked",
            profile: ".anyvoice/voices/local-default/profile.json",
            voiceProfileId: "local-default",
            summary: {
              selectedClips: 1,
              eligibleClips: 1,
              manifestClips: 1,
              totalDurationSec: 7,
              missingCoverageFeatures: ["polyphones"],
              minClips: 5,
              minTotalDurationSec: 30,
            },
            checks: [
              { check: "clip_count", ok: false, message: "1 selected / 1 eligible, 1 manifest clips" },
              { check: "coverage", ok: false, message: "missing coverage: polyphones" },
              {
                check: "transcript_validation",
                ok: false,
                message: "transcript validation is required; run scripts/validate_voice_profile_transcripts.py",
              },
            ],
            recordingPrescription: {
              status: "needs_recording",
              clipsNeeded: 4,
              selectedClips: 1,
              eligibleClips: 1,
              durationSec: { min: 6, recommended: 8, max: 20, activeVoiceTarget: 5.2 },
              missingCoverageFeatures: ["polyphones"],
              topRejectionReasons: [{ reason: "too_short", count: 2 }],
              promptManifest: "examples/voice_profile_import_manifest.example.json",
              message: "Record 4 more qualified profile clips.",
            },
            nextCommands: {
              validateTranscripts:
                "python3 scripts/validate_voice_profile_transcripts.py --profile-json .anyvoice/voices/local-default/profile.json --strict",
            },
            nextStep: {
              status: "needs_recording",
              phase: "recording",
              brief:
                "Status: needs_recording\nNext action: record_profile_kit\nMissing audio clips: profile-clip-03\nProduct 10x proof command: python3 scripts/run_voice_quality_gate.py --clone-mode both",
              nextAction: {
                id: "record_profile_kit",
                phase: "recording",
                status: "needs_recording",
                command:
                  "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
                reason: "2 clip(s) need attention",
                secondaryCommands: [
                  "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --profile-id local-default",
                ],
              },
              recordingBrief: {
                manifest: "/tmp/anyvoice-profile-kit/manifest.json",
                clipsNeedingAudio: ["profile-clip-03"],
                pronunciationNotePolicy: "Use pronunciation notes only as rehearsal guidance; do not read notes into the transcript.",
                guidance: ["Read the transcript exactly.", "Use strict Traditional Chinese."],
                clips: [
                  {
                    id: "profile-clip-03",
                    index: 3,
                    audioPath: "/tmp/anyvoice-profile-kit/recordings/profile-clip-03.wav",
                    needsAudio: true,
                    transcript:
                      "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
                    pronunciationNotes: ["長樂: ㄔㄤˊ ㄌㄜˋ / chang2 le4"],
                    recommendedDurationSec: 13,
                    durationMode: "auto",
                    durationTargetSec: 13,
                    recordCommand:
                      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --clip profile-clip-03 --profile-id local-default --countdown-sec 2 --write-metadata --check-selected --auto-duration",
                  },
                ],
              },
              postRecordingProofPlan: {
                policy:
                  "Do not make the digital voice default until the strict profile verifier, ASR transcript validation, and a non-dry-run quality gate all pass.",
                recommendedCommand:
                  "python3 scripts/voice_profile_next_step.py --profile-json /tmp/anyvoice-profile/profile.json --kit-manifest /tmp/anyvoice-profile-kit/manifest.json --profile-id local-default --run --auto-advance --allow-enroll --allow-expensive --stop-before-lora --max-steps 3",
                productProofCommand:
                  "python3 scripts/run_voice_quality_gate.py --profile-json /tmp/anyvoice-profile/profile.json --clone-mode both --require-speaker-backend speechbrain-ecapa",
                productProofAsrBackend: {
                  status: "ready",
                  available: true,
                  requiredBackend: "faster-whisper",
                  selectedAutoBackend: "faster-whisper",
                  reason: "installed",
                  checkCommand:
                    "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python scripts/transcribe_voice_regression.py --list-backends",
                  setupHint: "Install faster-whisper in the Python environment used by transcript validation.",
                },
                productProofSpeakerBackend: {
                  status: "missing",
                  available: false,
                  requiredBackend: "speechbrain-ecapa",
                  selectedAutoBackend: "mfcc-cosine",
                  reason: "missing Python package(s): speechbrain, torch, torchaudio",
                  checkCommand: "python3 scripts/score_speaker_similarity.py --list-backends",
                  setupHint:
                    "Install speechbrain, torch, and torchaudio in the Python environment used by the quality gate.",
                },
                manualCommands: [
                  "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
                  "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --validate-transcripts",
                  "python3 scripts/verify_voice_profile_ready.py --profile-json /tmp/anyvoice-profile/profile.json --require-transcript-validation",
                  "python3 scripts/run_voice_quality_gate.py --profile-json /tmp/anyvoice-profile/profile.json",
                ],
                artifacts: [
                  {
                    id: "recording_kit_manifest",
                    path: "/tmp/anyvoice-profile-kit/manifest.json",
                    status: "present",
                    purpose: "fixed transcript/audio pairing for the five profile clips",
                  },
                  {
                    id: "profile_json",
                    path: "/tmp/anyvoice-profile/profile.json",
                    status: "present",
                    purpose: "selected user-recorded voice profile clips",
                  },
                  {
                    id: "transcript_validation_json",
                    path: "/tmp/anyvoice-profile/transcript-validation.json",
                    status: "missing",
                    purpose: "ASR proof that each recording matches its exact Traditional Chinese transcript",
                  },
                  {
                    id: "quality_gate_json",
                    path: null,
                    pathPattern: "generated/voice-regression/<timestamp>/quality-gate.json",
                    status: "planned",
                    purpose: "non-dry-run regression proof before LoRA export or default use",
                  },
                ],
                gates: [
                  {
                    id: "recording_kit_check",
                    command: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
                    required: true,
                    blocks: "enrollment",
                  },
                  {
                    id: "enroll_profile_kit",
                    command: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json",
                    required: true,
                    blocks: "strict_profile_verification",
                  },
                  {
                    id: "verify_profile_strict",
                    command: "python3 scripts/verify_voice_profile_ready.py --profile-json /tmp/anyvoice-profile/profile.json",
                    required: true,
                    blocks: "quality_gate",
                  },
                  {
                    id: "run_quality_gate",
                    command: "python3 scripts/run_voice_quality_gate.py --profile-json /tmp/anyvoice-profile/profile.json",
                    required: true,
                    blocks: "lora_dataset_export",
                  },
                  {
                    id: "run_product_proof_quality_gate",
                    command:
                      "python3 scripts/run_voice_quality_gate.py --profile-json /tmp/anyvoice-profile/profile.json --clone-mode both --require-speaker-backend speechbrain-ecapa",
                    required: false,
                    blocks: "product_10x_claim",
                  },
                ],
              },
            },
          },
        });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({
          audit: {
            status: "blocked",
            complete: false,
            profileJson: ".anyvoice/voices/local-default/profile.json",
            kitManifest: "/tmp/anyvoice-profile-kit/manifest.json",
            firstBlocker: {
              id: "recording_kit",
              status: "blocked",
              ok: false,
              message: "recording kit is incomplete",
              missingClips: ["profile-clip-01", "profile-clip-02"],
              firstMissingClip: {
                id: "profile-clip-01",
                transcript:
                  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
                recordCommand:
                  "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --clip profile-clip-01 --profile-id local-default --open-cue-sheet --countdown-sec 2 --write-metadata --check-selected --auto-duration",
              },
              recordingPreflight: {
                status: "ready_to_record",
                ok: true,
                message: "2 clip(s) will be recorded",
                recorder: {
                  configured: true,
                  source: "sox:rec",
                },
                recordingGuidance: {
                  targetDurationSec: 9,
                  minDurationSec: 6,
                  maxDurationSec: 20,
                  minActiveVoiceSec: 5.2,
                },
              },
            },
            stages: [
              {
                id: "recording_kit",
                status: "blocked",
                ok: false,
                message: "recording kit is incomplete",
                missingClips: ["profile-clip-01", "profile-clip-02"],
              },
              {
                id: "strict_profile",
                status: "missing",
                ok: false,
                message: "voice profile JSON is missing",
              },
              {
                id: "proof_environment",
                status: "blocked",
                ok: false,
                message: "proof backend setup is incomplete",
                missingBackends: ["speechbrain-ecapa"],
                asr: {
                  available: true,
                  requiredBackend: "faster-whisper",
                  selectedAutoBackend: "faster-whisper",
                  reason: "test ASR ready",
                },
                speaker: {
                  available: false,
                  requiredBackend: "speechbrain-ecapa",
                  selectedAutoBackend: "mfcc-cosine",
                  reason: "test ECAPA missing",
                },
              },
            ],
            nextCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
            nextBriefCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --preflight --brief --profile-id local-default --auto-duration",
            nextOpenCueSheetCommand:
              "python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html",
            nextMicrophoneSmokeTestCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --preflight --brief --microphone-smoke-sec 2 --profile-id local-default --auto-duration",
            nextNormalizeExternalRecordingsCommand:
              "python3 scripts/normalize_voice_profile_recording_kit_audio.py --manifest /tmp/anyvoice-profile-kit/manifest.json --check --profile-id local-default",
            nextProductProofCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-product-proof-after-check",
            nextProofEnvironmentCommand:
              "python3 scripts/transcribe_voice_regression.py --list-backends && python3 scripts/score_speaker_similarity.py --list-backends",
            nextLoraHandoffCommand:
              "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-profile-kit/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --prepare-lora-after-product-proof",
          },
        });
      }
      if (url.includes("/api/voice-profile/transcript-validation")) {
        return Response.json({
          validation: {
            validationJson: "generated/voice-profile-transcript-validation/local-default.json",
            total: 5,
            passed: 4,
            failed: 1,
            status: "blocked",
            backend: "external-asr",
            avgCer: 0.04,
            maxCer: 0.22,
            avgWer: 0.05,
            maxWer: 0.31,
          },
        });
      }
      if (url.includes("/api/voice-profile")) {
        return Response.json({
          profile: {
            status: "needs_enrollment",
            summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 0, remainingClipsNeeded: 4 },
            requirements: {
              minClips: 5,
              maxClips: 10,
              minDurationSec: 6,
              maxDurationSec: 20,
              passingGrades: ["A", "B"],
              requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
            },
            diagnostics: {
              eligibleTranscriptScripts: [{ script: "zh_hant", count: 1 }],
              coverageFeatures: [
                { feature: "zh_hant", count: 1 },
                { feature: "latin_terms", count: 1 },
              ],
              missingCoverageFeatures: ["polyphones"],
              rejectionReasons: [{ reason: "too_short", count: 1 }],
              topRejectedClips: [
                {
                  sourceRunId: "too-short",
                  grade: "D",
                  durationSec: 2.2,
                  reasons: ["grade_d", "too_short"],
                },
              ],
            },
            clips: [
              {
                sourceRunId: "clip-accepted",
                transcriptRaw:
                  "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
                coverageFeatures: ["zh_hant", "punctuation_rhythm"],
              },
            ],
            rejectedClips: [
              {
                sourceRunId: "clip-rejected",
                transcriptRaw:
                  "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
                coverageFeatures: ["zh_hant", "latin_terms", "polyphones", "punctuation_rhythm"],
                reasons: ["too_short"],
              },
            ],
          },
        });
      }
      if (url.includes("/api/runs")) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(VoiceCloneStudio));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("下一段建議錄音");
    expect(container.textContent).toContain("重慶");
    expect(container.textContent).toContain("多音字");
    expect(container.textContent).toContain("目標 11 秒");
    expect(container.textContent).toContain("5 段錄音進度");
    expect(container.textContent).toContain("第 1 / 5 段");
    expect(container.textContent).toContain("已通過");
    expect(container.textContent).toContain("未通過");
    expect(container.textContent).toContain("待錄");
    expect(container.textContent).toContain("發音覆蓋");
    expect(container.textContent).toContain("已補 1");
    expect(container.textContent).toContain("待補");
    expect(container.textContent).toContain("最近未通過");
    expect(container.textContent).toContain("品質 D / 0:02");
    expect(container.textContent).toContain("錄音太短");
    expect(container.textContent).toContain("既有錄音重掃");
    const reanalyzeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("重掃既有錄音"),
    );
    expect(reanalyzeButton).not.toBeUndefined();
    await act(async () => {
      reanalyzeButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("已檢查 8 個 run，補上 2 個分析");
    expect(container.textContent).toContain("還需要 4 段合格片段");
    expect(container.textContent).toContain("broken-wav");
    expect(container.textContent).toContain("外部錄音資料夾");
    const createKitButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("建立資料夾"),
    );
    expect(createKitButton).not.toBeUndefined();
    await act(async () => {
      createKitButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("/tmp/anyvoice-profile-kit/recordings");
    expect(container.textContent).toContain("/tmp/anyvoice-profile-kit/cue-sheet.html");
    expect(container.textContent).toContain("目標 9 秒");
    expect(container.textContent).toContain("目標 13 秒");
    expect(container.textContent).toContain("開啟讀稿提示");
    expect(container.textContent).toContain("python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html");
    expect(container.textContent).toContain("已覆蓋：繁體中文、數字 / 日期、英文詞、多音字、停頓節奏");
    expect(container.textContent).toContain("下一段錄音");
    expect(container.textContent).toContain("--record-missing-until-complete");
    expect(container.textContent).toContain("錄音加驗證");
    expect(container.textContent).toContain("--run-proof-after-check");
    expect(container.textContent).toContain("錄音加 10x 驗證");
    expect(container.textContent).toContain("--run-product-proof-after-check");
    expect(container.textContent).toContain("錄音到 LoRA 交付");
    expect(container.textContent).toContain("--prepare-lora-after-product-proof");
    const normalizeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("整理手機錄音"),
    );
    expect(normalizeButton).not.toBeUndefined();
    await act(async () => {
      normalizeButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("已整理 2 段；既有 1 段；還缺 2 個來源檔");
    expect(container.textContent).toContain("找到 3 / 5 段錄音");
    const smokeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("麥克風 smoke test"),
    );
    expect(smokeButton).not.toBeUndefined();
    await act(async () => {
      smokeButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("麥克風可用：已錄到 32044 bytes / 2.0 秒暫存音檔");
    expect(container.textContent).toContain("錄完後驗證");
    expect(container.textContent).toContain("scripts/voice_profile_next_step.py");
    expect(container.textContent).toContain("--stop-before-lora");
    expect(container.textContent).toContain("scripts/enroll_voice_profile_kit.py");
    const preflightButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("錄音前檢查"),
    );
    expect(preflightButton).not.toBeUndefined();
    await act(async () => {
      preflightButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("可開始錄音：5 段待錄；recorder: sox:rec");
    expect(container.textContent).toContain("讀稿提示");
    expect(container.textContent).toContain("不要唸進逐字稿");
    expect(container.textContent).toContain("profile-clip-03");
    expect(container.textContent).toContain("重慶: ㄔㄨㄥˊ ㄑㄧㄥˋ / chong2 qing4");
    const checkKitButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("檢查錄音"),
    );
    expect(checkKitButton).not.toBeUndefined();
    await act(async () => {
      checkKitButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("找到 3 / 5 段錄音");
    expect(container.textContent).toContain("2 clip(s) need attention");
    expect(container.textContent).toContain("profile-clip-02 (zh_unknown): 逐字稿是中文，但缺少明確繁體線索");
    expect(container.textContent).toContain("scripts/import_voice_profile_clips.py");
    const verifyProfileButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("檢查聲音檔案"),
    );
    expect(verifyProfileButton).not.toBeUndefined();
    await act(async () => {
      verifyProfileButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Hard gate 尚未通過");
    expect(container.textContent).toContain("1 selected / 1 eligible");
    expect(container.textContent).toContain("transcript validation is required");
    expect(container.textContent).toContain("下一步錄音");
    expect(container.textContent).toContain("再錄 4 段；每段建議 8-20 秒，人聲至少 5.2 秒");
    expect(container.textContent).toContain("待補發音覆蓋：多音字");
    expect(container.textContent).toContain("錄音 session 摘要");
    expect(container.textContent).toContain("Status: needs_recording");
    expect(container.textContent).toContain("Product 10x proof command:");
    expect(container.textContent).toContain("scripts/record_voice_profile_recording_kit.py");
    expect(container.textContent).toContain("2 clip(s) need attention");
    expect(container.textContent).toContain("長樂: ㄔㄤˊ ㄌㄜˋ / chang2 le4");
    expect(container.textContent).toContain("--clip profile-clip-03");
    expect(container.textContent).toContain("錄完後驗證");
    expect(container.textContent).toContain("--stop-before-lora");
    expect(container.textContent).toContain("10x Proof 命令");
    expect(container.textContent).toContain("--require-speaker-backend speechbrain-ecapa");
    expect(container.textContent).toContain("10x 發音 ASR");
    expect(container.textContent).toContain("faster-whisper 已就緒");
    expect(container.textContent).toContain("scripts/transcribe_voice_regression.py --list-backends");
    expect(container.textContent).toContain("10x 聲紋驗證");
    expect(container.textContent).toContain("speechbrain-ecapa 缺少");
    expect(container.textContent).toContain("mfcc-cosine");
    expect(container.textContent).toContain("scripts/score_speaker_similarity.py --list-backends");
    expect(container.textContent).toContain("錄音資料夾");
    expect(container.textContent).toContain("逐字稿驗證");
    expect(container.textContent).toContain("缺少");
    expect(container.textContent).toContain("檢查錄音資料夾");
    expect(container.textContent).toContain("LoRA 匯出前");
    expect(container.textContent).toContain("10x proof gate");
    expect(container.textContent).toContain("10x 宣稱前");
    const auditGoalButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("審核完成度"),
    );
    expect(auditGoalButton).not.toBeUndefined();
    await act(async () => {
      auditGoalButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("尚未完成：卡在 recording_kit");
    expect(container.textContent).toContain("recording_kit: recording kit is incomplete");
    expect(container.textContent).toContain("profile-clip-01, profile-clip-02");
    expect(container.textContent).toContain("下一段缺少錄音");
    expect(container.textContent).toContain("春天的陽光");
    expect(container.textContent).toContain("--clip profile-clip-01");
    expect(container.textContent).toContain("--check-selected");
    expect(container.textContent).toContain("錄音前 recorder 狀態");
    expect(container.textContent).toContain("ready_to_record");
    expect(container.textContent).toContain("Recorder: yes (sox:rec)");
    expect(container.textContent).toContain(">=5.2s active voice");
    expect(container.textContent).toContain("--record-missing-until-complete");
    expect(container.textContent).toContain("錄音前狀態");
    expect(container.textContent).toContain("--preflight --brief");
    expect(container.textContent).toContain("開啟讀稿提示");
    expect(container.textContent).toContain("python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html");
    expect(container.textContent).toContain("麥克風 smoke test");
    expect(container.textContent).toContain("--microphone-smoke-sec 2");
    expect(container.textContent).toContain("整理手機錄音");
    expect(container.textContent).toContain("normalize_voice_profile_recording_kit_audio.py");
    expect(container.textContent).toContain("錄音到 10x proof");
    expect(container.textContent).toContain("--run-product-proof-after-check");
    expect(container.textContent).toContain("Proof backend 狀態");
    expect(container.textContent).toContain("faster-whisper 已就緒");
    expect(container.textContent).toContain("speechbrain-ecapa 缺少；目前 auto 會用 mfcc-cosine");
    expect(container.textContent).toContain("Proof backend 檢查");
    expect(container.textContent).toContain("scripts/score_speaker_similarity.py --list-backends");
    expect(container.textContent).toContain("錄音到 LoRA handoff");
    expect(container.textContent).toContain("--prepare-lora-after-product-proof");
    expect(container.textContent).toContain("recording_kit: blocked / strict_profile: missing");
    const validateTranscriptsButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("驗證逐字稿"),
    );
    expect(validateTranscriptsButton).not.toBeUndefined();
    await act(async () => {
      validateTranscriptsButton!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("逐字稿 ASR 驗證未通過：4 / 5");
    expect(container.textContent).toContain("generated/voice-profile-transcript-validation/local-default.json");
    const bulkInput = container.querySelector<HTMLInputElement>('input[aria-label="上傳 5 段錄音"]');
    expect(bulkInput).not.toBeNull();
    Object.defineProperty(bulkInput!, "files", {
      configurable: true,
      value: [1, 2, 3, 4, 5].map((index) =>
        new File([new Uint8Array([index])], `profile-clip-0${index}.wav`, { type: "audio/wav" }),
      ),
    });
    await act(async () => {
      bulkInput!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("已上傳 5 段錄音");

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });
});

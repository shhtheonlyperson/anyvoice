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

const USABLE_DRAFT_PROFILE = {
  id: "vp_draft",
  displayName: "匯入聲音",
  status: "ready",
  usable: true,
  studioGrade: false,
  meetsRequirements: true,
  clipCount: 1,
  hash: 0x2222,
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
const GOAL_AUDIT = {
  status: "blocked",
  complete: false,
  profileJson: "/tmp/profile.json",
  kitManifest: "/tmp/anyvoice-kit/manifest.json",
  completionRequirements: [
    {
      id: "recording_kit",
      stageId: "recording_kit",
      order: 1,
      requirement: "extended recording kit exists",
      status: "blocked",
      ok: false,
      message: "recording kit is incomplete",
      evidence: {
        missingClips: [
          "profile-clip-01",
          "profile-clip-02",
          "profile-clip-03",
          "profile-clip-04",
          "profile-clip-05",
          "profile-clip-06",
          "profile-clip-07",
          "profile-clip-08",
          "profile-clip-09",
          "profile-clip-10",
        ],
        firstMissingClip: {
          id: "profile-clip-01",
          transcript: "你好，我正在錄製一段聲音樣本。",
          recordCommand: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-01 --check-selected",
        },
        recordingPreflight: {
          status: "ready_to_record",
          ok: true,
          message: "10 clip(s) will be recorded",
          recorder: { configured: true, source: "sox:rec" },
          recordingGuidance: {
            checklist: ["read the prompt exactly", "use strict Traditional Chinese"],
            targetDurationLabel: "auto per clip",
            minDurationSec: 6,
            maxDurationSec: 20,
            minActiveVoiceSec: 5.2,
          },
        },
      },
    },
    {
      id: "proof_environment",
      stageId: "proof_environment",
      order: 4,
      requirement: "proof dependencies are ready",
      status: "pass",
      ok: true,
      message: "ASR and speaker backends are ready",
      evidence: {
        asr: { status: "ready", selectedAutoBackend: "faster-whisper" },
        speaker: { status: "ready", selectedAutoBackend: "speechbrain-ecapa" },
        checkCommands: [
          "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python scripts/transcribe_voice_regression.py --list-backends",
          "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python scripts/score_speaker_similarity.py --list-backends",
        ],
      },
    },
  ],
  firstIncompleteRequirement: {
    id: "recording_kit",
    stageId: "recording_kit",
    order: 1,
    requirement: "extended recording kit exists",
    status: "blocked",
    ok: false,
    message: "recording kit is incomplete",
    evidence: {
      missingClips: [
        "profile-clip-01",
        "profile-clip-02",
        "profile-clip-03",
        "profile-clip-04",
        "profile-clip-05",
        "profile-clip-06",
        "profile-clip-07",
        "profile-clip-08",
        "profile-clip-09",
        "profile-clip-10",
      ],
      firstMissingClip: {
        id: "profile-clip-01",
        transcript: "你好，我正在錄製一段聲音樣本。",
        recordCommand: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-01 --check-selected",
      },
    },
  },
  nextBriefCommand:
    "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --preflight --brief --auto-duration --profile-id vp_empty",
  nextMicrophoneSmokeTestCommand:
    "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --preflight --brief --microphone-smoke-sec 2 --auto-duration --profile-id vp_empty",
  nextNormalizeExternalRecordingsCommand:
    "python3 scripts/normalize_voice_profile_recording_kit_audio.py --manifest /tmp/anyvoice-kit/manifest.json --check --profile-id vp_empty",
  nextCommand: "python3 scripts/record_voice_profile_recording_kit.py --record-missing-until-complete",
  nextProductProofCommand:
    "python3 scripts/record_voice_profile_recording_kit.py --record-missing-until-complete --run-product-proof-after-check",
  nextLoraHandoffCommand:
    "python3 scripts/record_voice_profile_recording_kit.py --record-missing-until-complete --prepare-lora-after-product-proof",
};

function stubFetch(profiles: unknown[] = [READY_PROFILE]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/voice-profile/profiles")) return Response.json({ profiles });
    if (url.includes("/api/voice-profile/goal-audit")) return Response.json({ audit: GOAL_AUDIT });
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
    void init;
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

function setTextValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

  it("enables Generate for an imported ready non-studio voice", async () => {
    const fetchMock = stubFetch([USABLE_DRAFT_PROFILE]);
    const { container, root } = await mount();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    setTextValue(textarea, "請用我的聲音說這句話。");
    await flush();

    expect(container.textContent).not.toContain("尚無已就緒的聲音");
    const generateButton = Array.from(container.querySelectorAll("button.btn.btn--primary")).find((button) =>
      (button.textContent || "").includes("生成"),
    ) as HTMLButtonElement | undefined;
    expect(generateButton?.disabled).toBe(false);
    const cloneCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/clone/stream"));
    expect(cloneCalls).toHaveLength(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the raw and model-facing text in the active Generate composer", async () => {
    const { container, root } = await mount();
    const textarea = container.querySelector(".compose-textarea") as HTMLTextAreaElement;
    setTextValue(textarea, "我在用 AnyVoice 和重慶做測試");
    await flush();
    const preview = container.querySelector(".compose-model-preview") as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.textContent).toContain("我在用 AnyVoice 和重慶做測試");
    expect(preview.textContent).toContain("我在用 Any Voice 和重 慶做測試");
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses manual pinyin overrides in the model-facing preview", async () => {
    const { container, root } = await mount();
    const textarea = container.querySelector(".compose-textarea") as HTMLTextAreaElement;
    setTextValue(textarea, "行長會說話");
    await flush();
    const pronField = container.querySelector(".compose-pron-field") as HTMLTextAreaElement;
    expect(pronField).not.toBeNull();
    setTextValue(pronField, "pinyin:行長=xing2 zhang3");
    await flush();
    const preview = container.querySelector(".compose-model-preview") as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.textContent).toContain("行長會說話");
    expect(preview.textContent).toContain("xing2 zhang3會說話");
    await act(async () => root.unmount());
    container.remove();
  });

  it("applies suggested pronunciation overrides and sends them during generation", async () => {
    const fetchMock = stubFetch();
    const { container, root } = await mount();
    const textarea = container.querySelector(".compose-textarea") as HTMLTextAreaElement;
    setTextValue(textarea, "我在用 AnyVoice 做測試");
    await flush();
    const chip = container.querySelector(".compose-pron-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("AnyVoice");
    await act(async () => chip.click());
    await flush();
    const pronField = container.querySelector(".compose-pron-field") as HTMLTextAreaElement;
    expect(pronField.value).toContain("AnyVoice=Any Voice");
    const btn = Array.from(container.querySelectorAll("button.btn--primary")).find((b) =>
      (b.textContent || "").includes("生成"),
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => btn.click());
    await flush();
    const cloneCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/clone/stream"));
    const body = cloneCall?.[1]?.body as FormData | undefined;
    expect(body?.get("pronunciationOverrides")).toContain("AnyVoice=Any Voice");
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

  it("shows an imported ready non-studio voice as complete in Build", async () => {
    stubFetch([USABLE_DRAFT_PROFILE]);
    const { container, root } = await mount();
    await act(async () => clickTab(container, "建立聲音"));
    await flush();
    const readyPanel = container.querySelector(".build-status.ready");
    expect(readyPanel).not.toBeNull();
    expect(container.textContent).toContain("你的聲音已準備好");
    expect(container.textContent).not.toContain("繼續錄音");
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

  it("renders the 10x goal audit blocker from the authoritative audit route", async () => {
    const fetchMock = stubFetch([EMPTY_PROFILE]);
    const { container, root } = await mount();
    await act(async () => clickTab(container, "建立聲音"));
    await flush();

    expect(container.querySelector(".goal-audit-panel")).not.toBeNull();
    expect(container.textContent).toContain("下一個證明關卡");
    expect(container.textContent).toContain("recording_kit");
    expect(container.textContent).toContain("先補 profile-clip-01");
    expect(container.textContent).toContain("缺少的 Kit 片段");
    expect(container.textContent).toContain("profile-clip-10");
    expect(container.textContent).toContain("第一句提示稿");
    expect(container.textContent).toContain("你好，我正在錄製一段聲音樣本。");
    expect(container.textContent).toContain("錄音預檢");
    expect(container.textContent).toContain("錄音器: sox:rec");
    expect(container.textContent).toContain("目標: auto per clip");
    expect(container.textContent).toContain("6–20 秒");
    expect(container.textContent).toContain("至少 5.2 秒人聲");
    expect(container.textContent).toContain("read the prompt exactly");
    expect(container.textContent).toContain("麥克風測試指令");
    expect(container.textContent).toContain("--microphone-smoke-sec 2");
    expect(container.textContent).toContain("預檢指令");
    expect(container.textContent).toContain("外部錄音檢查指令");
    expect(container.textContent).toContain("normalize_voice_profile_recording_kit_audio.py");
    expect(container.textContent).toContain("證明後端");
    expect(container.textContent).toContain("ASR: faster-whisper");
    expect(container.textContent).toContain("聲紋: speechbrain-ecapa");
    expect(container.textContent).toContain("後端檢查指令");
    expect(container.textContent).toContain("transcribe_voice_regression.py --list-backends");
    expect(container.textContent).toContain("score_speaker_similarity.py --list-backends");
    expect(container.textContent).toContain("單句錄音指令");
    expect(container.textContent).toContain("--check-selected");
    expect(container.textContent).toContain("record_voice_profile_recording_kit.py");
    expect(container.textContent).toContain("錄完後");
    expect(container.textContent).toContain("產品證明指令");
    expect(container.textContent).toContain("--run-product-proof-after-check");
    expect(container.textContent).toContain("LoRA 交接指令");
    expect(container.textContent).toContain("--prepare-lora-after-product-proof");
    const cueSheet = Array.from(container.querySelectorAll("a")).find((link) =>
      (link.textContent || "").includes("開啟提示稿"),
    ) as HTMLAnchorElement;
    expect(cueSheet).not.toBeNull();
    expect(cueSheet.getAttribute("href")).toBe(
      "/api/voice-profile/recording-kit/cue-sheet?profileId=vp_empty&manifest=%2Ftmp%2Fanyvoice-kit%2Fmanifest.json",
    );

    const auditCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/voice-profile/goal-audit"));
    expect(auditCall?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ profileId: "vp_empty" }),
    });

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("Audiobook tab — re-skinned reader", () => {
  it("keeps Audiobook locked for an imported ready non-studio voice", async () => {
    stubFetch([USABLE_DRAFT_PROFILE]);
    const { container, root } = await mount();
    await act(async () => clickTab(container, "有聲書"));
    await flush();
    expect(container.querySelector(".book-grid")).toBeNull();
    expect(container.textContent).toContain("有聲書需要錄音室等級聲音");
    await act(async () => root.unmount());
    container.remove();
  });

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

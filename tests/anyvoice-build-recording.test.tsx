// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

/* Verifies the in-browser recording stage wires the analyzer grade to the
 * line-status dots: a grade A/B enroll marks the line passed; a grade C/D enroll
 * marks it re-record. The capture path (getUserMedia + MediaRecorder) is stubbed
 * so the test drives the enroll → grade → status mapping deterministically. */

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  state = "inactive";
  constructor() {
    FakeRecorder.instances.push(this);
  }
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

class FakeAudioBuffer {
  numberOfChannels = 1;
  sampleRate = 1000;
  length: number;
  duration: number;
  private data: Float32Array;

  constructor(durationSec = 10, activeVoiceSec = 6) {
    this.length = Math.max(1, Math.round(durationSec * this.sampleRate));
    this.duration = this.length / this.sampleRate;
    const activeSamples = Math.max(0, Math.min(this.length, Math.round(activeVoiceSec * this.sampleRate)));
    this.data = new Float32Array(this.length);
    this.data.fill(0.001);
    this.data.fill(0.1, 0, activeSamples);
  }

  getChannelData() {
    return this.data;
  }
}

let fakeAudioBuffer = new FakeAudioBuffer();
let fakeLiveRms = 0.1;

class FakeAudioSource {
  connect() {}
  disconnect() {}
}

class FakeAnalyser {
  fftSize = 1024;

  getFloatTimeDomainData(buffer: Float32Array) {
    buffer.fill(fakeLiveRms);
  }
}

class FakeAudioContext {
  async decodeAudioData() {
    return fakeAudioBuffer as unknown as AudioBuffer;
  }

  createMediaStreamSource() {
    return new FakeAudioSource() as unknown as MediaStreamAudioSourceNode;
  }

  createAnalyser() {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }

  async close() {}
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
  vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
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

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FakeMicSettings = Pick<MediaTrackSettings, "echoCancellation" | "noiseSuppression" | "autoGainControl" | "sampleRate" | "channelCount">;

const EMPTY_PROFILE: ProfileListItem = {
  id: "vp1",
  displayName: "我的聲音",
  status: "needs_enrollment",
  usable: false,
  studioGrade: false,
  meetsRequirements: false,
  clipCount: 0,
  hash: 0x1234,
};

const PARTIAL_PROFILE: ProfileListItem = {
  ...EMPTY_PROFILE,
  clipCount: 2,
  usable: true,
  hash: 0x5678,
};

function stubEnroll(
  grade: "A" | "B" | "C" | "D",
  detail?: {
    clips?: Array<{ sourceRunId: string; transcriptRaw: string }>;
    rejectedClips?: Array<{ sourceRunId: string; transcriptRaw: string; reasons?: string[] }>;
  },
) {
  const fetchMock = vi.fn<FetchMock>(async (input) => {
    const url = String(input);
    if (url.includes("/api/voice-profile?")) {
      return Response.json({ profile: detail ?? null });
    }
    if (url.includes("/api/voice-profile/goal-audit")) {
      return Response.json({});
    }
    if (url.includes("/api/voice-profile/enroll")) {
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
  return fetchMock;
}

function stubEnrollFailure() {
  const fetchMock = vi.fn<FetchMock>(async (input) => {
    const url = String(input);
    if (url.includes("/api/voice-profile?")) {
      return Response.json({ profile: null });
    }
    if (url.includes("/api/voice-profile/goal-audit")) {
      return Response.json({});
    }
    if (url.includes("/api/voice-profile/enroll")) {
      return Response.json({ status: "error", message: "temporary enroll failure" }, { status: 500 });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubDraftImportCascade() {
  let imported = false;
  const lineOne = "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。";
  const fetchMock = vi.fn<FetchMock>(async (input) => {
    const url = String(input);
    if (url.includes("/api/voice-profile?")) {
      return Response.json({
        profile: imported
          ? {
              clips: [{ sourceRunId: "browser-draft-01", transcriptRaw: lineOne }],
              rejectedClips: [],
              diagnostics: { missingCoverageFeatures: [] },
            }
          : null,
      });
    }
    if (url.includes("/api/voice-profile/goal-audit")) {
      return Response.json({ audit: { status: "blocked", complete: false, completionRequirements: [] } });
    }
    if (url.includes("/api/voice-profile/enroll")) {
      return Response.json({ status: "error", message: "temporary enroll failure" }, { status: 500 });
    }
    if (url.includes("/api/voice-profile/import")) {
      imported = true;
      return Response.json({
        status: "imported",
        imported: 1,
        profile: {
          clips: [{ sourceRunId: "browser-draft-01", transcriptRaw: lineOne }],
          rejectedClips: [],
          diagnostics: { missingCoverageFeatures: [] },
        },
      });
    }
    if (url.includes("/api/voice-profile/transcript-validation")) {
      return Response.json({ validation: { status: "pass" } });
    }
    if (url.includes("/api/voice-profile/verify")) {
      return Response.json({ verification: { status: "blocked" } });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setMicSettings(settings: Partial<FakeMicSettings> = {}) {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
    getAudioTracks: () => [{ getSettings: () => settings }],
    getTracks: () => [{ stop() {} }],
  } as unknown as MediaStream);
}

async function flush() {
  await act(async () => {
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

async function mountRecording(profile: ProfileListItem = EMPTY_PROFILE): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  container.className = "av-root";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider lang="zh">
        <BuildTab activeProfile={profile} onRefresh={() => {}} onChangeTab={() => {}} onDeleted={() => {}} />
      </I18nProvider>,
    );
  });
  await flush();
  // Click "Start/Continue recording" to enter the recording stage.
  const start = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes("開始錄音") || (b.textContent || "").includes("繼續錄音"),
  ) as HTMLButtonElement;
  await act(async () => start.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
  return { container, root };
}

async function mountBuild(profile: ProfileListItem = EMPTY_PROFILE): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  container.className = "av-root";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider lang="zh">
        <BuildTab activeProfile={profile} onRefresh={() => {}} onChangeTab={() => {}} onDeleted={() => {}} />
      </I18nProvider>,
    );
  });
  await flush();
  return { container, root };
}

beforeEach(() => {
  window.localStorage.clear();
  FakeRecorder.instances = [];
  fakeAudioBuffer = new FakeAudioBuffer(10, 6);
  fakeLiveRms = 0.1;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReset();
  setMicSettings({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 1,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BuildTab recording stage — grade → line status", () => {
  it("renders 10x capture-depth and pronunciation evidence from the goal audit", async () => {
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = String(input);
      if (url.includes("/api/voice-profile?")) {
        return Response.json({ profile: null });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({
          audit: {
            status: "blocked",
            complete: false,
            kitManifest: "/tmp/local-default-current/manifest.json",
            completionRequirements: [
              {
                id: "recording_kit",
                stageId: "recording_kit",
                order: 1,
                requirement: "recording kit",
                status: "blocked",
                ok: false,
                message: "recording kit is incomplete",
                evidence: {
                  missingClips: ["profile-clip-01"],
                  selectedClips: 7,
                  recommendedClips: 10,
                  totalDurationSec: 78.326,
                  recommendedDurationSec: 60,
                  missingPronunciationPresetIds: ["polyphone:bank-president", "brand:voxcpm2"],
                  firstMissingClip: {
                    id: "profile-clip-01",
                    transcript: "你好，我正在錄製一段聲音樣本。",
                    recordCommand: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-01 --check-selected",
                  },
                },
              },
              {
                id: "capture_depth",
                stageId: "capture_depth",
                order: 3,
                requirement: "capture depth",
                status: "blocked",
                ok: false,
                message: "profile is missing 10x capture depth",
                evidence: {
                  selectedClips: 7,
                  recommendedClips: 10,
                  totalDurationSec: 78.326,
                  recommendedDurationSec: 60,
                  missingPronunciationPresetIds: ["polyphone:bank-president", "brand:voxcpm2"],
                },
              },
            ],
            firstIncompleteRequirement: {
              id: "recording_kit",
              stageId: "recording_kit",
              order: 1,
              requirement: "recording kit",
              status: "blocked",
              ok: false,
              message: "recording kit is incomplete",
              evidence: {
                missingClips: ["profile-clip-01"],
                selectedClips: 7,
                recommendedClips: 10,
                totalDurationSec: 78.326,
                recommendedDurationSec: 60,
                missingPronunciationPresetIds: ["polyphone:bank-president", "brand:voxcpm2"],
                firstMissingClip: {
                  id: "profile-clip-01",
                  transcript: "你好，我正在錄製一段聲音樣本。",
                },
              },
            },
            nextCommand: "python3 scripts/record_voice_profile_recording_kit.py --record-missing-until-complete",
            nextProfileReferenceRecordingBatchCommand: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-09 --clip profile-clip-08 --record-missing-until-complete",
            nextPostProfileReferenceRecordingProofCommand: "python3 scripts/voice_profile_next_step.py --run --auto-advance",
            nextProfileReferenceRecordingCommands: [
              {
                presetId: "polyphone:bank-president",
                clipId: "profile-clip-09",
                recordCommand: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-09",
              },
            ],
            nextQualityGateProbeCommands: [
              {
                caseId: "zh_hant_custom_readings",
                command: "python3 scripts/run_voice_quality_gate.py --case zh_hant_custom_readings",
                proofScope: "partial_case_probe_not_full_completion_gate",
                asrSamples: [
                  {
                    repeat: 1,
                    asrTranscript: "这次请把航长、常乐和TSMC的读法固定下来",
                    scoringTarget: "這次請把行長、長樂和 TSMC 的讀法固定下來。",
                  },
                ],
              },
            ],
            nextQualityGateRepairActions: [
              {
                kind: "record_profile_reference_batch",
                priority: 1,
                status: "ready",
                reason: "quality gate is missing profile-reference coverage for review groups",
                command: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-09 --clip profile-clip-08 --record-missing-until-complete",
                clipIds: ["profile-clip-09", "profile-clip-08"],
                presetIds: ["polyphone:bank-president", "brand:voxcpm2"],
              },
              {
                kind: "run_quality_probe",
                priority: 3,
                status: "waiting",
                reason: "re-render and rescore this failing case after the preceding repair actions",
                caseId: "zh_hant_custom_readings",
                blockedUntil: "rerun_profile_reference_proof",
                command: "python3 scripts/run_voice_quality_gate.py --case zh_hant_custom_readings",
                proofScope: "partial_case_probe_not_full_completion_gate",
              },
            ],
          },
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, root } = await mountBuild(PARTIAL_PROFILE);

    expect(container.textContent).toContain("擷取深度");
    expect(container.textContent).toContain("7/10 段");
    expect(container.textContent).toContain("78.326/60 秒");
    expect(container.textContent).toContain("缺少發音覆蓋");
    expect(container.textContent).toContain("polyphone:bank-president");
    expect(container.textContent).toContain("brand:voxcpm2");
    expect(container.textContent).toContain("Profile reference 批次錄音");
    expect(container.textContent).toContain("--clip profile-clip-09 --clip profile-clip-08");
    expect(container.textContent).toContain("補錄後證明鏈");
    expect(container.textContent).toContain("voice_profile_next_step.py --run --auto-advance");
    expect(container.textContent).toContain("Profile reference 單段錄音");
    expect(container.textContent).toContain("單 case quality probe");
    expect(container.textContent).toContain("--case zh_hant_custom_readings");
    expect(container.textContent).toContain("Quality probe 聽寫證據");
    expect(container.textContent).toContain("这次请把航长、常乐和TSMC的读法固定下来");
    expect(container.textContent).toContain("這次請把行長、長樂和 TSMC 的讀法固定下來。");
    expect(container.textContent).toContain("Quality gate 修復順序");
    expect(container.textContent).toContain("P1 / record_profile_reference_batch [ready]");
    expect(container.textContent).toContain("P3 / run_quality_probe / zh_hant_custom_readings [waiting]");
    expect(container.textContent).toContain("等待: rerun_profile_reference_proof");
    expect(container.textContent).toContain("quality gate is missing profile-reference coverage");

    await act(async () => root.unmount());
    container.remove();
  });

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

  it("seeds line status dots from accepted and rejected profile evidence", async () => {
    stubEnroll("A", {
      clips: [
        {
          sourceRunId: "accepted-line-01",
          transcriptRaw: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
        },
      ],
      rejectedClips: [
        {
          sourceRunId: "rejected-line-03",
          transcriptRaw: "今天的天氣很好，午後的微風帶著淡淡花香，讓人想出門走走、曬曬太陽。",
          reasons: ["too_short"],
        },
      ],
    });
    const { container, root } = await mountRecording(PARTIAL_PROFILE);
    const rows = Array.from(container.querySelectorAll(".lines-list .line-row"));
    expect(rows[0].querySelector(".line-status-dot")?.classList.contains("pass")).toBe(true);
    expect(rows[1].querySelector(".line-status-dot")?.classList.contains("todo")).toBe(true);
    expect(rows[2].querySelector(".line-status-dot")?.classList.contains("retry")).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });

  it("runs a browser mic preflight without creating a draft or enrollment", async () => {
    const fetchMock = stubEnroll("A");
    const { container, root } = await mountRecording();

    const preflight = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("檢查麥克風"),
    ) as HTMLButtonElement;
    expect(preflight).not.toBeNull();
    await act(async () => preflight.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("麥克風已通過預檢");
    expect(container.textContent).toContain("48000 Hz");
    expect(container.textContent).toContain("1ch");
    expect(container.textContent).toContain("DSP off");
    expect(FakeRecorder.instances.length).toBe(0);
    expect(window.localStorage.getItem("anyvoice:recordingDrafts:v1:vp1:zh-Hant")).toBeNull();
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks browser mic preflight when capture DSP is still enabled", async () => {
    const fetchMock = stubEnroll("A");
    setMicSettings({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 48000,
      channelCount: 1,
    });
    const { container, root } = await mountRecording();

    const preflight = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("檢查麥克風"),
    ) as HTMLButtonElement;
    await act(async () => preflight.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("偵測到麥克風仍開啟處理");
    expect(container.textContent).toContain("noiseSuppression");
    expect(FakeRecorder.instances.length).toBe(0);
    expect(window.localStorage.getItem("anyvoice:recordingDrafts:v1:vp1:zh-Hant")).toBeNull();
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("shows browser capture settings while a guided recording is live", async () => {
    stubEnroll("A");
    const { container, root } = await mountRecording();

    const recordButton = container.querySelector(".rec-btn") as HTMLButtonElement;
    await act(async () => {
      recordButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    expect(container.textContent).toContain("錄音格式：48000 Hz");
    expect(container.textContent).toContain("1ch");
    expect(container.textContent).toContain("DSP off");
    expect(FakeRecorder.instances[0].state).toBe("recording");

    await act(async () => root.unmount());
    container.remove();
  });

  it("saves a failed browser take as a per-prompt draft instead of losing progress", async () => {
    stubEnrollFailure();
    const { container, root } = await mountRecording();
    vi.useFakeTimers();

    const recordButton = container.querySelector(".rec-btn") as HTMLButtonElement;
    await act(async () => {
      recordButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const rows = Array.from(container.querySelectorAll(".lines-list .line-row"));
    expect(rows[0].querySelector(".line-status-dot")?.classList.contains("draft")).toBe(true);
    expect(rows[0].textContent).toContain("已暫存");
    expect(container.textContent).toContain("錄音已暫存");

    const stored = window.localStorage.getItem("anyvoice:recordingDrafts:v1:vp1:zh-Hant");
    expect(stored).toContain("\"lineIndex\":0");
    expect(stored).toContain("\"activeVoiceSec\":6");
    expect(stored).toContain("你好，我正在錄製一段聲音樣本");
    expect(stored).toContain("\"enrollmentStatus\":\"error\"");

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps recording when duration is met but live active voice is still too low", async () => {
    const fetchMock = stubEnroll("A");
    fakeLiveRms = 0.001;
    const { container, root } = await mountRecording();
    vi.useFakeTimers();

    const recordButton = container.querySelector(".rec-btn") as HTMLButtonElement;
    await act(async () => {
      recordButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(7_000);
      await Promise.resolve();
    });
    expect(recordButton.disabled).toBe(true);
    expect(FakeRecorder.instances[0].state).toBe("recording");
    expect(container.textContent).toContain("有效人聲 0.0/5.2 秒");
    expect(container.textContent).toContain("請繼續照稿唸到有效人聲達標");
    expect(window.localStorage.getItem("anyvoice:recordingDrafts:v1:vp1:zh-Hant")).toBeNull();
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("treats saved draft prompts as progress when choosing the next recording line", async () => {
    stubEnroll("A");
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 8,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: null,
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const rows = Array.from(container.querySelectorAll(".lines-list .line-row"));
    expect(rows[0].querySelector(".line-status-dot")?.classList.contains("draft")).toBe(true);
    expect(rows[0].textContent).toContain("已暫存");
    expect(container.querySelector(".rec-line")?.textContent).toContain("我會用平常說話的速度");

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks resubmitting a draft whose stored duration is below the profile gate", async () => {
    const fetchMock = stubEnroll("A");
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 2,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: null,
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const submit = container.querySelector('button[title="送出暫存"]') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    await act(async () => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("這段只有 2.0 秒");
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks resubmitting a draft whose stored active voice is below the profile gate", async () => {
    const fetchMock = stubEnroll("A");
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 8,
          activeVoiceSec: 4,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: null,
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const submit = container.querySelector('button[title="送出暫存"]') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    await act(async () => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("這段只有 4.0 秒有效人聲");
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks resubmitting a draft whose stored capture settings include browser DSP", async () => {
    const fetchMock = stubEnroll("A");
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 8,
          activeVoiceSec: 6,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: {
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const submit = container.querySelector('button[title="送出暫存"]') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    await act(async () => submit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("偵測到麥克風仍開啟處理");
    expect(container.textContent).toContain("noiseSuppression");
    const enrollCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/voice-profile/enroll"));
    expect(enrollCalls.length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks bulk importing saved drafts below the active-voice gate", async () => {
    const fetchMock = stubDraftImportCascade();
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 8,
          activeVoiceSec: 4,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: null,
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("匯入暫存"),
    ) as HTMLButtonElement;
    expect(importButton).not.toBeNull();
    await act(async () => importButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("這段只有 4.0 秒有效人聲");
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).not.toContain("/api/voice-profile/import");

    await act(async () => root.unmount());
    container.remove();
  });

  it("blocks bulk importing saved drafts with browser DSP capture settings", async () => {
    const fetchMock = stubDraftImportCascade();
    window.localStorage.setItem(
      "anyvoice:recordingDrafts:v1:vp1:zh-Hant",
      JSON.stringify({
        "0": {
          profileId: "vp1",
          pack: "zh-Hant",
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
          fileName: "profile-clip-01.webm",
          mimeType: "audio/webm",
          size: 1,
          durationSec: 8,
          activeVoiceSec: 6,
          recordedAt: "2026-06-02T00:00:00.000Z",
          captureSettings: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
          enrollmentStatus: "draft",
        },
      }),
    );

    const { container, root } = await mountRecording();
    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("匯入暫存"),
    ) as HTMLButtonElement;
    expect(importButton).not.toBeNull();
    await act(async () => importButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(container.textContent).toContain("偵測到麥克風仍開啟處理");
    expect(container.textContent).toContain("echoCancellation");
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).not.toContain("/api/voice-profile/import");

    await act(async () => root.unmount());
    container.remove();
  });

  it("bulk-imports saved valid drafts and refreshes proof surfaces", async () => {
    const fetchMock = stubDraftImportCascade();
    const { container, root } = await mountRecording();
    vi.useFakeTimers();

    const recordButton = container.querySelector(".rec-btn") as HTMLButtonElement;
    await act(async () => {
      recordButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    let rows = Array.from(container.querySelectorAll(".lines-list .line-row"));
    expect(rows[0].querySelector(".line-status-dot")?.classList.contains("draft")).toBe(true);

    const importButton = Array.from(container.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("匯入暫存"),
    ) as HTMLButtonElement;
    expect(importButton).not.toBeNull();
    await act(async () => {
      importButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain("/api/voice-profile/import");
    expect(calledUrls).toContain("/api/voice-profile/transcript-validation");
    expect(calledUrls).toContain("/api/voice-profile/verify");
    expect(calledUrls.filter((url) => url.includes("/api/voice-profile/goal-audit")).length).toBeGreaterThanOrEqual(2);
    const importCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/voice-profile/import"));
    const importBody = importCall?.[1]?.body as FormData;
    expect(JSON.parse(String(importBody.get("clips")))[0]).toMatchObject({
      id: "profile-clip-01",
      transcript: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
      sourceKind: "scripted",
    });

    rows = Array.from(container.querySelectorAll(".lines-list .line-row"));
    expect(rows[0].querySelector(".line-status-dot")?.classList.contains("pass")).toBe(true);
    expect(container.textContent).toContain("證明狀態已更新");
    expect(window.localStorage.getItem("anyvoice:recordingDrafts:v1:vp1:zh-Hant") || "").not.toContain("\"lineIndex\":0");

    await act(async () => root.unmount());
    container.remove();
  });
});

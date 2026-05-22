// @vitest-environment node
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/profile-enrollment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/profile-enrollment")>("@/lib/profile-enrollment");
  return { ...actual, enrollVoiceProfileClip: vi.fn() };
});
vi.mock("@/lib/voice-profile", () => ({ persistVoiceProfileManifest: vi.fn() }));
vi.mock("nanoid", () => ({ nanoid: () => "yt-job-id" }));

// Keep the pure helpers real; only stub the network/yt-dlp orchestrator.
vi.mock("@/lib/youtube-import", async () => {
  const actual = await vi.importActual<typeof import("@/lib/youtube-import")>("@/lib/youtube-import");
  return { ...actual, downloadYoutubeReference: vi.fn(), transcribeAudioFile: vi.fn() };
});

import { POST } from "@/app/api/voice-profile/enroll/youtube/route";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";
import { downloadYoutubeReference, transcribeAudioFile } from "@/lib/youtube-import";

const enrollMock = vi.mocked(enrollVoiceProfileClip);
const profileMock = vi.mocked(persistVoiceProfileManifest);
const downloadMock = vi.mocked(downloadYoutubeReference);
const transcribeMock = vi.mocked(transcribeAudioFile);
const originalEnv = { ...process.env };
let tmp: string;

function makeReq(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/enroll/youtube", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

// Stub the downloader: write a wav + (optionally) a Simplified VTT into runDir.
function stubDownload(opts: { withCaptions: boolean }) {
  downloadMock.mockImplementation(async ({ runDir }) => {
    const wavPath = path.join(runDir, "youtube-section.wav");
    await writeFile(wavPath, Buffer.from([1, 2, 3, 4]));
    const subtitleFiles: string[] = [];
    if (opts.withCaptions) {
      const subPath = path.join(runDir, "youtube.zh-Hans.vtt");
      await writeFile(
        subPath,
        "WEBVTT\n\n00:05:00.000 --> 00:05:10.000\n这个声音样本需要保持稳定，欢迎收看节目。\n",
        "utf-8",
      );
      subtitleFiles.push(subPath);
    }
    return { wavPath, subtitleFiles };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmp = await mkdtemp(path.join(os.tmpdir(), "anyvoice-yt-"));
  process.env.ANYVOICE_RUNS_DIR = tmp;
  transcribeMock.mockResolvedValue(""); // ASR off by default; tests opt in
  enrollMock.mockResolvedValue({
    status: "enrolled",
    jobId: "yt-job-id",
    modelId: "openbmb/VoxCPM2",
    referenceQuality: { grade: "A", durationSec: 12, snrDb: 28, clippingRatio: 0, vadActiveRatio: 0.8, warnings: [] },
  });
  profileMock.mockResolvedValue({
    version: 1,
    voiceProfileId: "local-default",
    status: "ready",
    requirements: {
      minClips: 1,
      maxClips: 10,
      minDurationSec: 6,
      maxDurationSec: 20,
      passingGrades: ["A", "B"],
      requiredCoverageFeatures: [],
    },
    summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 0, remainingClipsNeeded: 0 },
    preferredPromptClipId: "yt-job-id",
    referenceClipIds: ["yt-job-id"],
    diagnostics: {
      eligibleTranscriptScripts: [],
      coverageFeatures: [],
      missingCoverageFeatures: [],
      selectedGrades: [{ grade: "A", count: 1 }],
      rejectionReasons: [],
      topRejectedClips: [],
    },
    clips: [],
    rejectedClips: [],
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/enroll/youtube", () => {
  it("rejects missing consent before any download", async () => {
    const res = await POST(makeReq({ url: "https://youtu.be/dQw4w9WgXcQ?t=300" }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/permission/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid URL", async () => {
    const res = await POST(makeReq({ url: "not a url", consent: "yes" }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/YouTube URL/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("converts Simplified captions and enrolls with a Traditional transcript", async () => {
    stubDownload({ withCaptions: true });
    const res = await POST(makeReq({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=300", consent: "yes" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    const body = await res.json();
    expect(body.status).toBe("enrolled");
    expect(body.profile.status).toBe("ready");
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({ videoId: "dQw4w9WgXcQ", start: 300, end: 312 }));
    expect(enrollMock).toHaveBeenCalledTimes(1);
    const transcript = enrollMock.mock.calls[0][1].promptTranscript;
    expect(transcript).toContain("這");
    expect(transcript).not.toContain("这");
  });

  it("falls back to automatic transcription when there are no captions", async () => {
    stubDownload({ withCaptions: false });
    transcribeMock.mockResolvedValue("这是自动语音识别的文字。"); // Simplified — should be converted
    const res = await POST(makeReq({ url: "https://youtu.be/dQw4w9WgXcQ", consent: "yes" }));
    expect(res.status).toBe(200);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const transcript = enrollMock.mock.calls[0][1].promptTranscript;
    expect(transcript).toContain("這");
    expect(transcript).not.toContain("这");
  });

  it("returns 422 only when captions AND transcription both fail", async () => {
    stubDownload({ withCaptions: false });
    transcribeMock.mockResolvedValue("");
    const res = await POST(makeReq({ url: "https://youtu.be/dQw4w9WgXcQ", consent: "yes" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("no_captions");
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("uses a typed transcript override when captions are absent", async () => {
    stubDownload({ withCaptions: false });
    const res = await POST(
      makeReq({ url: "https://youtu.be/dQw4w9WgXcQ", consent: "yes", transcriptOverride: "這是一段測試聲音。" }),
    );
    expect(res.status).toBe(200);
    expect(enrollMock).toHaveBeenCalledWith(
      "yt-job-id",
      expect.objectContaining({ sourceKind: "uploaded", promptTranscript: "這是一段測試聲音。" }),
    );
  });
});

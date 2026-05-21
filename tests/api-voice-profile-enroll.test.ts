// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/profile-enrollment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/profile-enrollment")>("@/lib/profile-enrollment");
  return {
    ...actual,
    enrollVoiceProfileClip: vi.fn(),
  };
});

vi.mock("@/lib/voice-profile", () => ({
  persistVoiceProfileManifest: vi.fn(),
}));

vi.mock("nanoid", () => ({ nanoid: () => "enroll-job-id" }));

import { POST } from "@/app/api/voice-profile/enroll/route";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";

const enrollMock = vi.mocked(enrollVoiceProfileClip);
const profileMock = vi.mocked(persistVoiceProfileManifest);
const originalEnv = { ...process.env };

function form(overrides: Record<string, string | Blob> = {}): FormData {
  const data = new FormData();
  data.set("voice", new File([new Uint8Array([1, 2, 3])], "enroll.wav", { type: "audio/wav" }));
  data.set("promptTranscript", "請錄製穩定聲音。");
  data.set("sourceKind", "scripted");
  data.set("consent", "yes");
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

function makeReq(body?: BodyInit): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/enroll", {
    method: "POST",
    body,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  profileMock.mockResolvedValue({
    version: 1,
    voiceProfileId: "local-default",
    status: "needs_enrollment",
    requirements: {
      minClips: 5,
      maxClips: 10,
      minDurationSec: 6,
      maxDurationSec: 20,
      passingGrades: ["A", "B"],
      requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
    },
    summary: { eligibleClips: 1, selectedClips: 1, rejectedClips: 0, remainingClipsNeeded: 4 },
    preferredPromptClipId: "enroll-job-id",
    referenceClipIds: ["enroll-job-id"],
    diagnostics: {
      eligibleTranscriptScripts: [{ script: "zh_hant", count: 1 }],
      coverageFeatures: [{ feature: "zh_hant", count: 1 }],
      missingCoverageFeatures: ["numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
      selectedGrades: [{ grade: "A", count: 1 }],
      rejectionReasons: [],
      topRejectedClips: [],
    },
    clips: [],
    rejectedClips: [],
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/enroll", () => {
  it("returns 400 for non-multipart requests", async () => {
    const res = await POST(makeReq("not form"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/multipart/);
  });

  it("analyzes and returns the updated profile", async () => {
    enrollMock.mockResolvedValue({
      status: "enrolled",
      jobId: "enroll-job-id",
      modelId: "openbmb/VoxCPM2",
      referenceQuality: {
        grade: "A",
        durationSec: 8,
        snrDb: 28,
        clippingRatio: 0,
        vadActiveRatio: 0.8,
        warnings: [],
      },
    });

    const res = await POST(makeReq(form()));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    const body = await res.json();
    expect(body.status).toBe("enrolled");
    expect(body.profile.summary.remainingClipsNeeded).toBe(4);
    expect(enrollMock).toHaveBeenCalledWith(
      "enroll-job-id",
      expect.objectContaining({ promptTranscript: "請錄製穩定聲音。", sourceKind: "scripted" }),
    );
  });

  it("rejects sample audio before analyzer work", async () => {
    const res = await POST(makeReq(form({ sourceKind: "sample" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/user recordings|user-uploaded/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects Simplified or mixed Chinese transcripts before analyzer work", async () => {
    const res = await POST(makeReq(form({ promptTranscript: "这个聲音要穩定。" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/Traditional Chinese|mixed Chinese/);
    expect(enrollMock).not.toHaveBeenCalled();
  });
});

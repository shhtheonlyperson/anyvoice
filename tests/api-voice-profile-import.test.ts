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

vi.mock("nanoid", () => ({ nanoid: () => "bulk-job-id" }));

import { POST } from "@/app/api/voice-profile/import/route";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";

const enrollMock = vi.mocked(enrollVoiceProfileClip);
const profileMock = vi.mocked(persistVoiceProfileManifest);
const originalEnv = { ...process.env };

function makeForm(count = 5): FormData {
  const form = new FormData();
  form.set("consent", "yes");
  const clips = [];
  for (let index = 0; index < count; index += 1) {
    const field = `voice-${index}`;
    const stem = `profile-clip-${String(index + 1).padStart(2, "0")}`;
    form.set(field, new File([new Uint8Array([index + 1, index + 2])], `${stem}.wav`, { type: "audio/wav" }));
    clips.push({
      id: stem,
      fileField: field,
      expectedStem: stem,
      transcript: `這是第 ${index + 1} 段錄音。`,
      sourceKind: "uploaded",
    });
  }
  form.set("clips", JSON.stringify(clips));
  return form;
}

function makeReq(body?: BodyInit): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/import", {
    method: "POST",
    body,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  enrollMock.mockResolvedValue({
    status: "enrolled",
    jobId: "bulk-job-id",
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
  profileMock.mockResolvedValue({
    version: 1,
    voiceProfileId: "local-default",
    status: "ready",
    requirements: {
      minClips: 5,
      maxClips: 10,
      minDurationSec: 6,
      maxDurationSec: 20,
      passingGrades: ["A", "B"],
      requiredCoverageFeatures: ["zh_hant", "numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
    },
    summary: { eligibleClips: 5, selectedClips: 5, rejectedClips: 0, remainingClipsNeeded: 0 },
    preferredPromptClipId: "bulk-job-id",
    referenceClipIds: ["bulk-job-id"],
    diagnostics: {
      eligibleTranscriptScripts: [{ script: "zh_hant", count: 5 }],
      coverageFeatures: [
        { feature: "zh_hant", count: 5 },
        { feature: "numbers_dates", count: 1 },
        { feature: "latin_terms", count: 1 },
        { feature: "polyphones", count: 1 },
        { feature: "punctuation_rhythm", count: 5 },
      ],
      missingCoverageFeatures: [],
      selectedGrades: [{ grade: "A", count: 5 }],
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

describe("POST /api/voice-profile/import", () => {
  it("bulk-enrolls uploaded clips and returns the updated profile", async () => {
    const res = await POST(makeReq(makeForm()));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    const body = await res.json();
    expect(body).toMatchObject({ status: "imported", imported: 5 });
    expect(body.profile.status).toBe("ready");
    expect(enrollMock).toHaveBeenCalledTimes(5);
    expect(enrollMock).toHaveBeenCalledWith(
      "bulk-job-id",
      expect.objectContaining({ sourceKind: "uploaded", promptTranscript: "這是第 1 段錄音。" }),
    );
  });

  it("accepts the extended 10-clip recording-kit upload shape", async () => {
    const res = await POST(makeReq(makeForm(10)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "imported", imported: 10 });
    expect(enrollMock).toHaveBeenCalledTimes(10);
    expect(enrollMock).toHaveBeenLastCalledWith(
      "bulk-job-id",
      expect.objectContaining({ sourceKind: "uploaded", promptTranscript: "這是第 10 段錄音。" }),
    );
  });

  it("rejects missing consent before analyzer work", async () => {
    const form = makeForm();
    form.delete("consent");
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/permission/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects malformed clip specs", async () => {
    const form = makeForm();
    form.set("clips", JSON.stringify([{ fileField: "voice-0" }]));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/missing transcript/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects Simplified or mixed Chinese transcripts before analyzer work", async () => {
    const form = makeForm();
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "这个聲音樣本需要保持穩定。",
          sourceKind: "uploaded",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/Traditional Chinese|mixed Chinese/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects Chinese transcripts without clear Traditional marker evidence before analyzer work", async () => {
    const form = makeForm();
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "中文音色自然。",
          sourceKind: "uploaded",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/unproven|zh-Hant|Traditional Chinese/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects files that do not match the declared profile clip slot", async () => {
    const form = makeForm();
    form.set("voice-0", new File([new Uint8Array([1, 2])], "wrong-slot.wav", { type: "audio/wav" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("profile-clip-01");
    expect(enrollMock).not.toHaveBeenCalled();
  });
});

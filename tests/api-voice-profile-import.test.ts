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

vi.mock("@/lib/recording-kit", () => ({
  getCurrentVoiceProfileRecordingKit: vi.fn(),
}));

vi.mock("nanoid", () => ({ nanoid: () => "bulk-job-id" }));

import { POST } from "@/app/api/voice-profile/import/route";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { getCurrentVoiceProfileRecordingKit } from "@/lib/recording-kit";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";

const enrollMock = vi.mocked(enrollVoiceProfileClip);
const recordingKitMock = vi.mocked(getCurrentVoiceProfileRecordingKit);
const profileMock = vi.mocked(persistVoiceProfileManifest);
const originalEnv = { ...process.env };

function recordingKitTranscript(index: number): string {
  return `這是第 ${index + 1} 段錄音。`;
}

function makeForm(count = 5): FormData {
  const form = new FormData();
  form.set("consent", "yes");
  const clips = [];
  for (let index = 0; index < count; index += 1) {
    const field = `voice-${index}`;
    const stem = `uploaded-clip-${String(index + 1).padStart(2, "0")}`;
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

function makeRecordingKitForm(count = 10, sourceKind?: string): FormData {
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
      transcript: recordingKitTranscript(index),
      ...(sourceKind ? { sourceKind } : {}),
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
  recordingKitMock.mockResolvedValue({
    status: "written",
    kit: "/tmp/anyvoice-kit",
    manifest: "/tmp/anyvoice-kit/manifest.json",
    prompts: "/tmp/anyvoice-kit/prompts",
    recordings: "/tmp/anyvoice-kit/recordings",
    clips: 10,
    clipSpecs: Array.from({ length: 10 }, (_, index) => ({
      id: `profile-clip-${String(index + 1).padStart(2, "0")}`,
      expectedStem: `profile-clip-${String(index + 1).padStart(2, "0")}`,
      transcript: recordingKitTranscript(index),
      sourceKind: "scripted",
    })),
    checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json",
    enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-kit/manifest.json",
    importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-kit/manifest.json",
    verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json /tmp/profile.json",
  });
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
    usable: true,
    studioGrade: true,
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

  it("accepts the extended 10-clip recording-kit upload shape as scripted evidence", async () => {
    const res = await POST(makeReq(makeRecordingKitForm(10)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "imported", imported: 10 });
    expect(enrollMock).toHaveBeenCalledTimes(10);
    expect(enrollMock).toHaveBeenLastCalledWith(
      "bulk-job-id",
      expect.objectContaining({ sourceKind: "scripted", promptTranscript: "這是第 10 段錄音。" }),
    );
  });

  it("passes clean browser capture settings through bulk import rows", async () => {
    const form = makeRecordingKitForm(1);
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "這是第 1 段錄音。",
          browserCaptureSettings: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(200);
    expect(enrollMock).toHaveBeenCalledWith(
      "bulk-job-id",
      expect.objectContaining({
        sourceKind: "scripted",
        browserCaptureSettings: expect.objectContaining({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }),
        recordingKitClipId: "profile-clip-01",
      }),
    );
  });

  it("accepts browser-draft fixed slots with clean capture settings even when the file name is generic", async () => {
    const form = new FormData();
    form.set("consent", "yes");
    form.set("voice-0", new File([new Uint8Array([1, 2])], "line-01.webm", { type: "audio/webm" }));
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          transcript: "這是第 1 段錄音。",
          sourceKind: "scripted",
          browserCaptureSettings: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(200);
    expect(enrollMock).toHaveBeenCalledWith(
      "bulk-job-id",
      expect.objectContaining({
        sourceKind: "scripted",
        promptTranscript: "這是第 1 段錄音。",
        recordingKitClipId: "profile-clip-01",
      }),
    );
  });

  it("rejects fixed-slot imports without filename pairing or browser capture proof", async () => {
    const form = new FormData();
    form.set("consent", "yes");
    form.set("voice-0", new File([new Uint8Array([1, 2])], "random-upload.wav", { type: "audio/wav" }));
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          transcript: "這是第 1 段錄音。",
          sourceKind: "scripted",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/filename\/expectedStem slot evidence or clean browser capture settings/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects fixed-slot imports with partial browser capture settings but no filename pairing", async () => {
    const form = new FormData();
    form.set("consent", "yes");
    form.set("voice-0", new File([new Uint8Array([1, 2])], "line-01.webm", { type: "audio/webm" }));
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          transcript: "這是第 1 段錄音。",
          sourceKind: "scripted",
          browserCaptureSettings: {
            sampleRate: 48000,
            channelCount: 1,
          },
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/filename\/expectedStem slot evidence or clean browser capture settings/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects known browser-draft imports with mic processing enabled", async () => {
    const form = makeRecordingKitForm(1);
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "這是第 1 段錄音。",
          browserCaptureSettings: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          },
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/microphone processing/);
    expect(body.message).toMatch(/autoGainControl/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects recording-kit shaped imports that explicitly claim uploaded provenance", async () => {
    const res = await POST(makeReq(makeRecordingKitForm(1, "uploaded")));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/sourceKind scripted/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("infers scripted recording-kit provenance from the uploaded filename", async () => {
    const form = new FormData();
    form.set("consent", "yes");
    form.set("voice-0", new File([new Uint8Array([1, 2])], "phone-profile-clip-01-take.wav", { type: "audio/wav" }));
    form.set("clips", JSON.stringify([{ fileField: "voice-0", transcript: "這是第 1 段錄音。" }]));

    const res = await POST(makeReq(form));
    expect(res.status).toBe(200);
    expect(enrollMock).toHaveBeenCalledWith(
      "bulk-job-id",
      expect.objectContaining({ sourceKind: "scripted", promptTranscript: "這是第 1 段錄音。" }),
    );
  });

  it("rejects filename-shaped recording-kit imports that explicitly claim uploaded provenance", async () => {
    const form = new FormData();
    form.set("consent", "yes");
    form.set("voice-0", new File([new Uint8Array([1, 2])], "phone-profile-clip-01-take.wav", { type: "audio/wav" }));
    form.set(
      "clips",
      JSON.stringify([{ fileField: "voice-0", transcript: "這是第 1 段錄音。", sourceKind: "uploaded" }]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/sourceKind scripted/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate fixed recording-kit slots before analyzer work", async () => {
    const form = makeRecordingKitForm(2);
    form.set("voice-1", new File([new Uint8Array([3, 4])], "profile-clip-01-second-take.wav", { type: "audio/wav" }));
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "這是第 1 段錄音。",
        },
        {
          id: "profile-clip-01",
          fileField: "voice-1",
          expectedStem: "profile-clip-01",
          transcript: "這是第 1 段重複錄音。",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/profile-clip-01 appears more than once/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects recording-kit rows whose fixed slot signals disagree", async () => {
    const form = makeRecordingKitForm(1);
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-02",
          transcript: "這是第 1 段錄音。",
        },
      ]),
    );
    form.set("voice-0", new File([new Uint8Array([1, 2])], "profile-clip-01.wav", { type: "audio/wav" }));

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/recording kit clip identifiers disagree/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects recording-kit imports whose transcript does not match the current manifest prompt", async () => {
    const form = makeRecordingKitForm(1);
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "profile-clip-01",
          fileField: "voice-0",
          expectedStem: "profile-clip-01",
          transcript: "這是被改過的錄音稿。",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/current manifest prompt/);
    expect(enrollMock).not.toHaveBeenCalled();
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
          id: "uploaded-clip-01",
          fileField: "voice-0",
          expectedStem: "uploaded-clip-01",
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

  it("rejects short shared-form Chinese transcripts (zh_unknown) as unproven profile evidence", async () => {
    const form = makeForm();
    form.set(
      "clips",
      JSON.stringify([
        {
          id: "uploaded-clip-01",
          fileField: "voice-0",
          expectedStem: "uploaded-clip-01",
          transcript: "早安你好",
          sourceKind: "uploaded",
        },
      ]),
    );

    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/unproven Chinese|zh_unknown/);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it("rejects files that do not match the declared profile clip slot", async () => {
    const form = makeForm();
    form.set("voice-0", new File([new Uint8Array([1, 2])], "wrong-slot.wav", { type: "audio/wav" }));
    const res = await POST(makeReq(form));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("uploaded-clip-01");
    expect(enrollMock).not.toHaveBeenCalled();
  });
});

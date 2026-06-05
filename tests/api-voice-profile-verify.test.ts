// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-access", () => ({
  guardVoiceProfileAccess: vi.fn(async () => null),
}));

vi.mock("@/lib/voice-profile-verify", () => ({
  verifyVoiceProfileReadiness: vi.fn(),
}));
vi.mock("@/lib/voice-profile-next-step", () => ({
  getVoiceProfileNextStep: vi.fn(),
}));

import { POST } from "@/app/api/voice-profile/verify/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { getVoiceProfileNextStep } from "@/lib/voice-profile-next-step";
import { verifyVoiceProfileReadiness } from "@/lib/voice-profile-verify";

const verifyMock = vi.mocked(verifyVoiceProfileReadiness);
const nextStepMock = vi.mocked(getVoiceProfileNextStep);
const originalEnv = { ...process.env };

function makeReq(body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/verify", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({
    status: "blocked",
    profile: ".anyvoice/voices/local-default/profile.json",
    voiceProfileId: "local-default",
    summary: {
      selectedClips: 0,
      eligibleClips: 0,
      manifestClips: 0,
      totalDurationSec: 0,
      missingCoverageFeatures: ["zh_hant"],
      minClips: 5,
      minTotalDurationSec: 30,
    },
    checks: [
      { check: "clip_count", ok: false, message: "0 selected / 0 eligible, 0 manifest clips" },
      {
        check: "transcript_validation",
        ok: false,
        message: "transcript validation is required; run scripts/validate_voice_profile_transcripts.py",
      },
    ],
    nextCommands: {
      validateTranscripts: "python3 scripts/validate_voice_profile_transcripts.py --profile-json .anyvoice/voices/local-default/profile.json --strict",
    },
  });
  nextStepMock.mockResolvedValue({
    status: "needs_recording",
    phase: "recording",
    nextAction: {
      id: "record_profile_kit",
      phase: "recording",
      status: "needs_recording",
      command:
        "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
      reason: "5 clip(s) need audio files",
      secondaryCommands: [],
    },
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/verify", () => {
  it("runs the strict verifier and returns blocked reports as normal payloads", async () => {
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(verifyMock).toHaveBeenCalledWith({ profileId: "local-default", requireTranscriptValidation: true });
    expect(nextStepMock).toHaveBeenCalledWith({ profileId: "local-default" });
    const body = await res.json();
    expect(body.verification).toMatchObject({
      status: "blocked",
      summary: { selectedClips: 0 },
      nextStep: {
        status: "needs_recording",
        nextAction: {
          id: "record_profile_kit",
          reason: "5 clip(s) need audio files",
        },
      },
    });
  });

  it("uses the default local profile when no JSON body is sent", async () => {
    await POST(makeReq());
    expect(verifyMock).toHaveBeenCalledWith({ profileId: "local-default", requireTranscriptValidation: true });
    expect(nextStepMock).toHaveBeenCalledWith({ profileId: "local-default" });
  });

  it("keeps verifier output usable when the next-step helper cannot run", async () => {
    nextStepMock.mockRejectedValue(new Error("next-step unavailable"));
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verification).toMatchObject({
      status: "blocked",
      nextStepError: "next-step unavailable",
    });
  });

  it("returns an error payload when the verifier cannot run", async () => {
    verifyMock.mockRejectedValue(new Error("voice profile not found"));
    const res = await POST(makeReq({ profileId: "../bad" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "error",
      message: "voice profile not found",
    });
  });
});

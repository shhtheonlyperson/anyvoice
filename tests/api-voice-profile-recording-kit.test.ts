// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-access", () => ({
  guardVoiceProfileAccess: vi.fn(async () => null),
}));

vi.mock("@/lib/recording-kit", () => ({
  createVoiceProfileRecordingKit: vi.fn(),
  getCurrentVoiceProfileRecordingKit: vi.fn(),
  readCurrentVoiceProfileRecordingKitCueSheet: vi.fn(),
  readVoiceProfileRecordingKitCueSheet: vi.fn(),
}));

import { GET, POST } from "@/app/api/voice-profile/recording-kit/route";
import { GET as GET_CUE_SHEET } from "@/app/api/voice-profile/recording-kit/cue-sheet/route";
import {
  createVoiceProfileRecordingKit,
  getCurrentVoiceProfileRecordingKit,
  readCurrentVoiceProfileRecordingKitCueSheet,
  readVoiceProfileRecordingKitCueSheet,
} from "@/lib/recording-kit";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";

const createKitMock = vi.mocked(createVoiceProfileRecordingKit);
const getCurrentKitMock = vi.mocked(getCurrentVoiceProfileRecordingKit);
const readCurrentCueSheetMock = vi.mocked(readCurrentVoiceProfileRecordingKitCueSheet);
const readManifestCueSheetMock = vi.mocked(readVoiceProfileRecordingKitCueSheet);
const originalEnv = { ...process.env };

function makeReq(body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/recording-kit", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  const kit = {
    status: "written",
    promptSet: "standard",
    kit: "/tmp/anyvoice-kit",
    manifest: "/tmp/anyvoice-kit/manifest.json",
    cueSheetHtml: "/tmp/anyvoice-kit/cue-sheet.html",
    cueSheetUrl:
      "/api/voice-profile/recording-kit/cue-sheet?profileId=local-default&manifest=%2Ftmp%2Fanyvoice-kit%2Fmanifest.json",
    prompts: "/tmp/anyvoice-kit/prompts",
    recordings: "/tmp/anyvoice-kit/recordings",
    clips: 5,
    checkCommand: "python3 scripts/check_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json",
    recordCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
    recordMissingUntilCompleteCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
    recordNextMissingCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --next-missing --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check-selected --auto-duration",
    recordAllCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --open-cue-sheet --microphone-smoke-sec 2 --check --profile-id local-default --countdown-sec 2 --write-metadata --auto-duration",
    recordAndProveCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-proof-after-check",
    recordProveAndProductProofCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-product-proof-after-check",
    recordProveProductProofAndLoraCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest /tmp/anyvoice-kit/manifest.json --record-missing-until-complete --open-cue-sheet --microphone-smoke-sec 2 --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --prepare-lora-after-product-proof",
    enrollCommand: "python3 scripts/enroll_voice_profile_kit.py --manifest /tmp/anyvoice-kit/manifest.json",
    proofCommand:
      "python3 scripts/voice_profile_next_step.py --profile-json .anyvoice/voices/local-default/profile.json --kit-manifest /tmp/anyvoice-kit/manifest.json --profile-id local-default --run --auto-advance --allow-enroll --allow-expensive --stop-before-lora --max-steps 3",
    importCommand: "python3 scripts/import_voice_profile_clips.py --manifest /tmp/anyvoice-kit/manifest.json --build-profile",
    verifyCommand: "python3 scripts/verify_voice_profile_ready.py --profile-json .anyvoice/voices/local-default/profile.json",
  } as const;
  createKitMock.mockResolvedValue(kit);
  getCurrentKitMock.mockResolvedValue(kit);
  const cueSheet = {
    html: "<!doctype html><title>AnyVoice cue sheet</title><main>profile-clip-01</main>",
    path: "/tmp/anyvoice-kit/cue-sheet.html",
  };
  readCurrentCueSheetMock.mockResolvedValue(cueSheet);
  readManifestCueSheetMock.mockResolvedValue(cueSheet);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/recording-kit", () => {
  it("creates a recording kit and returns the local commands", async () => {
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(createKitMock).toHaveBeenCalledWith("local-default", { promptSet: undefined });
    const body = await res.json();
    expect(body.kit).toMatchObject({
      status: "written",
      cueSheetHtml: "/tmp/anyvoice-kit/cue-sheet.html",
      cueSheetUrl:
        "/api/voice-profile/recording-kit/cue-sheet?profileId=local-default&manifest=%2Ftmp%2Fanyvoice-kit%2Fmanifest.json",
      recordings: "/tmp/anyvoice-kit/recordings",
    });
    expect(body.kit.enrollCommand).toContain("scripts/enroll_voice_profile_kit.py");
    expect(body.kit.recordMissingUntilCompleteCommand).toContain("--record-missing-until-complete");
    expect(body.kit.recordMissingUntilCompleteCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordMissingUntilCompleteCommand).toContain("--check");
    expect(body.kit.recordMissingUntilCompleteCommand).toContain("--auto-duration");
    expect(body.kit.recordNextMissingCommand).toContain("--next-missing");
    expect(body.kit.recordNextMissingCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordNextMissingCommand).toContain("--check-selected");
    expect(body.kit.recordNextMissingCommand).toContain("--auto-duration");
    expect(body.kit.recordAllCommand).toContain("--check");
    expect(body.kit.recordAllCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordAllCommand).toContain("--auto-duration");
    expect(body.kit.recordAndProveCommand).toContain("--run-proof-after-check");
    expect(body.kit.recordAndProveCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordAndProveCommand).toContain("--auto-duration");
    expect(body.kit.recordProveAndProductProofCommand).toContain("--run-product-proof-after-check");
    expect(body.kit.recordProveAndProductProofCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordProveAndProductProofCommand).toContain("--auto-duration");
    expect(body.kit.recordProveProductProofAndLoraCommand).toContain("--prepare-lora-after-product-proof");
    expect(body.kit.recordProveProductProofAndLoraCommand).toContain("--microphone-smoke-sec 2");
    expect(body.kit.recordProveProductProofAndLoraCommand).toContain("--auto-duration");
    expect(body.kit.proofCommand).toContain("--stop-before-lora");
  });

  it("uses the default profile id when no JSON body is sent", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(createKitMock).toHaveBeenCalledWith("local-default", { promptSet: undefined });
  });

  it("passes the extended prompt set to kit creation", async () => {
    const res = await POST(makeReq({ profileId: "local-default", promptSet: "extended" }));
    expect(res.status).toBe(200);
    expect(createKitMock).toHaveBeenCalledWith("local-default", { promptSet: "extended" });
  });

  it("returns an error payload when kit creation fails", async () => {
    createKitMock.mockRejectedValue(new Error("profileId must contain only letters"));
    const res = await POST(makeReq({ profileId: "../bad" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ status: "error", message: "profileId must contain only letters" });
  });
});

describe("GET /api/voice-profile/recording-kit/cue-sheet", () => {
  it("serves the current generated cue sheet as no-store HTML", async () => {
    const res = await GET_CUE_SHEET(
      new Request(
        "http://localhost/api/voice-profile/recording-kit/cue-sheet?profileId=local-default&manifest=%2Ftmp%2Fanyvoice-kit%2Fmanifest.json",
      ) as unknown as import("next/server").NextRequest,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(readManifestCueSheetMock).toHaveBeenCalledWith("/tmp/anyvoice-kit/manifest.json", "local-default");
    expect(await res.text()).toContain("profile-clip-01");
  });

  it("returns a 404 JSON payload when the cue sheet is not available", async () => {
    readCurrentCueSheetMock.mockRejectedValue(new Error("recording kit cue sheet is missing"));
    const res = await GET_CUE_SHEET(
      new Request("http://localhost/api/voice-profile/recording-kit/cue-sheet") as unknown as import("next/server").NextRequest,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: "error", message: "recording kit cue sheet is missing" });
  });
});

describe("GET /api/voice-profile/recording-kit", () => {
  it("loads the current recording kit for the profile", async () => {
    const res = await GET(new Request("http://localhost/api/voice-profile/recording-kit?profileId=local-default") as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(getCurrentKitMock).toHaveBeenCalledWith("local-default");
    const body = await res.json();
    expect(body.kit).toMatchObject({
      status: "written",
      manifest: "/tmp/anyvoice-kit/manifest.json",
    });
  });

  it("returns null when no current kit exists", async () => {
    getCurrentKitMock.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/voice-profile/recording-kit") as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kit).toBeNull();
  });
});

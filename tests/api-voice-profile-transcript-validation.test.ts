// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-transcript-validation", () => ({
  validateVoiceProfileTranscripts: vi.fn(),
}));

import { POST } from "@/app/api/voice-profile/transcript-validation/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { validateVoiceProfileTranscripts } from "@/lib/voice-profile-transcript-validation";

const validateMock = vi.mocked(validateVoiceProfileTranscripts);
const originalEnv = { ...process.env };

function makeReq(body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/transcript-validation", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  validateMock.mockResolvedValue({
    validationJson: "generated/voice-profile-transcript-validation/local-default.json",
    total: 5,
    passed: 5,
    failed: 0,
    status: "pass",
    backend: "faster-whisper",
    avgCer: 0.01,
    maxCer: 0.03,
    avgWer: 0.02,
    maxWer: 0.04,
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/transcript-validation", () => {
  it("runs transcript validation and returns the summary", async () => {
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(validateMock).toHaveBeenCalledWith({ profileId: "local-default" });
    const body = await res.json();
    expect(body.validation).toMatchObject({
      status: "pass",
      total: 5,
      passed: 5,
      backend: "faster-whisper",
    });
  });

  it("uses the default local profile when no JSON body is sent", async () => {
    await POST(makeReq());
    expect(validateMock).toHaveBeenCalledWith({ profileId: "local-default" });
  });

  it("returns a blocked validation payload when no selected clips exist yet", async () => {
    validateMock.mockRejectedValue(new Error("profile has no selected clips to validate"));
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.validation).toMatchObject({
      status: "blocked",
      total: 0,
      message: "profile has no selected clips to validate",
    });
  });
});

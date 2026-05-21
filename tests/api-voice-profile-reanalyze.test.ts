// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-reanalysis", () => ({
  reanalyzeVoiceProfileRuns: vi.fn(),
}));

import { POST } from "@/app/api/voice-profile/reanalyze/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { reanalyzeVoiceProfileRuns } from "@/lib/voice-profile-reanalysis";

const reanalyzeMock = vi.mocked(reanalyzeVoiceProfileRuns);
const originalEnv = { ...process.env };

function makeReq(body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/reanalyze", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  reanalyzeMock.mockResolvedValue({
    reanalysis: {
      status: "completed",
      runsDir: ".anyvoice/runs",
      analyzer: "scripts/analyze_voice_reference.py",
      python: "/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python",
      dryRun: false,
      force: false,
      scanned: 12,
      plannedOrUpdated: 2,
      skipped: { already_analyzed: 10 },
      runs: [
        {
          sourceRunId: "old-run",
          metadataPath: ".anyvoice/runs/old-run/metadata.json",
          referenceAudio: ".anyvoice/runs/old-run/reference.webm",
          promptTextFile: ".anyvoice/runs/old-run/prompt-transcript.txt",
          sourceKind: "uploaded",
          status: "updated",
          quality: { grade: "B", durationSec: 8, warnings: [] },
        },
      ],
      failures: [],
      profile: {
        profile: ".anyvoice/voices/local-default/profile.json",
        status: "needs_enrollment",
        eligibleClips: 1,
        selectedClips: 1,
        remainingClipsNeeded: 4,
        dryRun: false,
      },
    },
    profile: {
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
      preferredPromptClipId: "old-run",
      referenceClipIds: ["old-run"],
      diagnostics: {
        eligibleTranscriptScripts: [{ script: "zh_hant", count: 1 }],
        coverageFeatures: [{ feature: "zh_hant", count: 1 }],
        missingCoverageFeatures: ["numbers_dates", "latin_terms", "polyphones", "punctuation_rhythm"],
        selectedGrades: [{ grade: "B", count: 1 }],
        rejectionReasons: [],
        topRejectedClips: [],
      },
      clips: [],
      rejectedClips: [],
    },
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/reanalyze", () => {
  it("reanalyzes existing runs and returns the refreshed profile", async () => {
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(reanalyzeMock).toHaveBeenCalledWith({ profileId: "local-default", dryRun: false, force: false });
    const body = await res.json();
    expect(body.reanalysis).toMatchObject({ status: "completed", plannedOrUpdated: 2 });
    expect(body.profile).toMatchObject({ status: "needs_enrollment", summary: { eligibleClips: 1 } });
  });

  it("supports default options without a JSON body", async () => {
    await POST(makeReq());
    expect(reanalyzeMock).toHaveBeenCalledWith({ profileId: "local-default", dryRun: false, force: false });
  });

  it("passes dry-run and force flags through", async () => {
    await POST(makeReq({ profileId: "local-default", dryRun: true, force: true }));
    expect(reanalyzeMock).toHaveBeenCalledWith({ profileId: "local-default", dryRun: true, force: true });
  });

  it("returns an error payload when reanalysis cannot run", async () => {
    reanalyzeMock.mockRejectedValue(new Error("analyzer missing"));
    const res = await POST(makeReq({ profileId: "../bad" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ status: "error", message: "analyzer missing" });
  });
});

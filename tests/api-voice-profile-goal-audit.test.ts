// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-access", () => ({
  guardVoiceProfileAccess: vi.fn(async () => null),
}));

vi.mock("@/lib/voice-clone-goal-audit", () => ({
  getVoiceCloneGoalAudit: vi.fn(),
}));

import { POST } from "@/app/api/voice-profile/goal-audit/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import { getVoiceCloneGoalAudit } from "@/lib/voice-clone-goal-audit";

const auditMock = vi.mocked(getVoiceCloneGoalAudit);
const originalEnv = { ...process.env };

function makeReq(body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/goal-audit", {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue({
    status: "blocked",
    complete: false,
    profileJson: ".anyvoice/voices/local-default/profile.json",
    kitManifest: "generated/voice-profile-recording-kits/local-default-current/manifest.json",
    stages: [
      {
        id: "recording_kit",
        status: "blocked",
        ok: false,
        message: "recording kit is incomplete",
        missingClips: ["profile-clip-01", "profile-clip-02"],
      },
    ],
    completionRequirements: [
      {
        id: "recording_kit",
        stageId: "recording_kit",
        order: 1,
        requirement: "extended recording kit exists and every required fixed-prompt WAV passes the pre-import check",
        status: "blocked",
        ok: false,
        message: "recording kit is incomplete",
        evidence: {
          missingClips: ["profile-clip-01", "profile-clip-02"],
          recommendedClips: 10,
        },
      },
      {
        id: "proof_environment",
        stageId: "proof_environment",
        order: 4,
        requirement: "Faster-Whisper ASR and speechbrain-ecapa speaker-verification backends are available in the configured Python environments",
        status: "pass",
        ok: true,
        message: "ASR and product speaker-verification backends are ready",
        evidence: {
          asr: { selectedAutoBackend: "faster-whisper" },
          speaker: { selectedAutoBackend: "speechbrain-ecapa" },
        },
      },
    ],
    firstBlocker: {
      id: "recording_kit",
      status: "blocked",
      ok: false,
      message: "recording kit is incomplete",
      missingClips: ["profile-clip-01", "profile-clip-02"],
      firstMissingClip: {
        id: "profile-clip-01",
        transcript: "你好，我正在錄製一段聲音樣本。",
        recordCommand:
          "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --clip profile-clip-01 --profile-id local-default --open-cue-sheet --countdown-sec 2 --write-metadata --check-selected --auto-duration",
      },
      recordingPreflight: {
        status: "ready_to_record",
        ok: true,
        message: "2 clip(s) will be recorded",
        recorder: {
          configured: true,
          source: "sox:rec",
        },
        recordingGuidance: {
          durationMode: "auto",
          targetDurationSec: null,
          targetDurationLabel: "auto per clip",
          minDurationSec: 6,
          maxDurationSec: 20,
          minActiveVoiceSec: 5.2,
        },
      },
    },
    firstIncompleteRequirement: {
      id: "recording_kit",
      stageId: "recording_kit",
      order: 1,
      requirement: "extended recording kit exists and every required fixed-prompt WAV passes the pre-import check",
      status: "blocked",
      ok: false,
      message: "recording kit is incomplete",
      evidence: {
        missingClips: ["profile-clip-01", "profile-clip-02"],
        recommendedClips: 10,
      },
    },
    nextCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration",
    nextBriefCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --preflight --brief --profile-id local-default --auto-duration",
    nextOpenCueSheetCommand:
      "python3 -m webbrowser -t file:///tmp/anyvoice-profile-kit/cue-sheet.html",
    nextMicrophoneSmokeTestCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --preflight --brief --microphone-smoke-sec 2 --profile-id local-default --auto-duration",
    nextNormalizeExternalRecordingsCommand:
      "python3 scripts/normalize_voice_profile_recording_kit_audio.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --check --profile-id local-default",
    nextNormalizePresentExternalRecordingsCommand:
      "python3 scripts/normalize_voice_profile_recording_kit_audio.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --only-present --check --profile-id local-default",
    nextQualityGateRepairActions: [
      {
        kind: "record_profile_reference_batch",
        priority: 1,
        status: "ready",
        reason: "quality gate is missing profile-reference coverage for review groups",
        command:
          "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --clip profile-clip-09 --clip profile-clip-08 --record-missing-until-complete --profile-id local-default --check-selected",
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
    nextProductProofCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --run-product-proof-after-check",
    nextProofEnvironmentCommand:
      "python3 scripts/transcribe_voice_regression.py --list-backends && python3 scripts/score_speaker_similarity.py --list-backends",
    nextLoraHandoffCommand:
      "python3 scripts/record_voice_profile_recording_kit.py --manifest generated/voice-profile-recording-kits/local-default-current/manifest.json --record-missing-until-complete --open-cue-sheet --profile-id local-default --countdown-sec 2 --write-metadata --check --auto-duration --prepare-lora-after-product-proof",
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("POST /api/voice-profile/goal-audit", () => {
  it("returns the read-only goal audit", async () => {
    const res = await POST(makeReq({ profileId: "local-default" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    expect(auditMock).toHaveBeenCalledWith({ profileId: "local-default" });
    const body = await res.json();
    expect(body.audit).toMatchObject({
      status: "blocked",
      completionRequirements: [
        {
          id: "recording_kit",
          status: "blocked",
          ok: false,
          evidence: {
            missingClips: ["profile-clip-01", "profile-clip-02"],
          },
        },
        {
          id: "proof_environment",
          status: "pass",
          ok: true,
          evidence: {
            asr: { selectedAutoBackend: "faster-whisper" },
            speaker: { selectedAutoBackend: "speechbrain-ecapa" },
          },
        },
      ],
      firstIncompleteRequirement: {
        id: "recording_kit",
        requirement: expect.stringContaining("extended recording kit"),
        evidence: {
          missingClips: ["profile-clip-01", "profile-clip-02"],
        },
      },
      firstBlocker: {
        id: "recording_kit",
        missingClips: ["profile-clip-01", "profile-clip-02"],
        firstMissingClip: {
          id: "profile-clip-01",
          recordCommand: expect.stringContaining("--check-selected"),
        },
        recordingPreflight: {
          status: "ready_to_record",
          recorder: {
            source: "sox:rec",
          },
        },
      },
      nextCommand: expect.stringContaining("--record-missing-until-complete"),
      nextBriefCommand: expect.stringContaining("--preflight --brief"),
      nextOpenCueSheetCommand: expect.stringContaining("cue-sheet.html"),
      nextMicrophoneSmokeTestCommand: expect.stringContaining("--microphone-smoke-sec 2"),
      nextNormalizeExternalRecordingsCommand: expect.stringContaining("normalize_voice_profile_recording_kit_audio.py"),
      nextNormalizePresentExternalRecordingsCommand: expect.stringContaining("--only-present"),
      nextQualityGateRepairActions: [
        {
          kind: "record_profile_reference_batch",
          priority: 1,
          status: "ready",
          command: expect.stringContaining("--clip profile-clip-09 --clip profile-clip-08"),
          clipIds: ["profile-clip-09", "profile-clip-08"],
          presetIds: ["polyphone:bank-president", "brand:voxcpm2"],
        },
        {
          kind: "run_quality_probe",
          priority: 3,
          status: "waiting",
          caseId: "zh_hant_custom_readings",
          blockedUntil: "rerun_profile_reference_proof",
          proofScope: "partial_case_probe_not_full_completion_gate",
        },
      ],
      nextProductProofCommand: expect.stringContaining("--run-product-proof-after-check"),
      nextProofEnvironmentCommand: expect.stringContaining("score_speaker_similarity.py --list-backends"),
      nextLoraHandoffCommand: expect.stringContaining("--prepare-lora-after-product-proof"),
    });
    expect(body.audit.nextCommand).toContain("--check");
  });

  it("uses the default profile id when no JSON body is sent", async () => {
    await POST(makeReq());
    expect(auditMock).toHaveBeenCalledWith({ profileId: "local-default" });
  });

  it("returns an error payload when the audit cannot run", async () => {
    auditMock.mockRejectedValue(new Error("audit unavailable"));
    const res = await POST(makeReq({ profileId: "../bad" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ status: "error", message: "audit unavailable" });
  });
});

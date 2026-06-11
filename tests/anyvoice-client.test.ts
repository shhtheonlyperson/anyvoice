// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrollFromUpload,
  fetchVoiceCloneGoalAudit,
  fetchVoiceProfileDetail,
  generateFromProfile,
  importVoiceProfileDraftClips,
  refreshVoiceProfileProofChain,
} from "@/components/anyvoice/lib/anyvoice-client";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anyvoice client", () => {
  it("uses the server enrollment sourceKind for uploaded profile clips", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ status: "enrolled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await enrollFromUpload({
      file: new File([new Uint8Array([1, 2, 3])], "voice.wav", { type: "audio/wav" }),
      transcript: "請錄製穩定聲音。",
      profileId: "local-test",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/enroll",
      expect.objectContaining({ method: "POST" }),
    );
    const body = fetchMock.mock.calls[0][1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("sourceKind")).toBe("uploaded");
    expect((body as FormData).get("voiceProfileId")).toBe("local-test");
    expect((body as FormData).get("consent")).toBe("yes");
  });

  it("generates with the usable-profile flag so imported voices do not need strict-ready proof", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ status: "ready", audioUrl: "/api/runs/job/audio", jobId: "job" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateFromProfile({ profileId: "vp_import", targetText: "請用這個聲音說一句話。" });

    expect(result.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/clone/stream",
      expect.objectContaining({ method: "POST" }),
    );
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("useVoiceProfile")).toBe("yes");
    expect(body.get("profileId")).toBe("vp_import");
    expect(body.get("allowDraftVoiceProfile")).toBe("yes");
    expect(body.get("consent")).toBe("yes");
  });

  it("fetches the authoritative voice-clone goal audit checklist", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          audit: {
            status: "blocked",
            complete: false,
            profileJson: "/tmp/profile.json",
            kitManifest: "/tmp/manifest.json",
            completionRequirements: [
              {
                id: "recording_kit",
                stageId: "recording_kit",
                order: 1,
                requirement: "extended recording kit exists",
                status: "blocked",
                ok: false,
                message: "recording kit is incomplete",
                evidence: { missingClips: ["profile-clip-01"] },
              },
              {
                id: "proof_environment",
                stageId: "proof_environment",
                order: 4,
                requirement: "proof dependencies are ready",
                status: "pass",
                ok: true,
                evidence: {},
              },
            ],
            firstIncompleteRequirement: {
              id: "recording_kit",
              stageId: "recording_kit",
              order: 1,
              requirement: "extended recording kit exists",
              status: "blocked",
              ok: false,
              message: "recording kit is incomplete",
              evidence: { missingClips: ["profile-clip-01"] },
            },
            nextCommand: "python3 scripts/record_voice_profile_recording_kit.py --record-missing-until-complete",
            nextMicrophoneSmokeTestCommand: "python3 scripts/record_voice_profile_recording_kit.py --preflight --brief --microphone-smoke-sec 2",
            nextNormalizeExternalRecordingsCommand: "python3 scripts/normalize_voice_profile_recording_kit_audio.py --check",
            nextNormalizePresentExternalRecordingsCommand: "python3 scripts/normalize_voice_profile_recording_kit_audio.py --only-present",
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
              },
            ],
            nextQualityGateRepairActions: [
              {
                kind: "record_profile_reference_batch",
                priority: 1,
                status: "ready",
                reason: "quality gate is missing profile-reference coverage for review groups",
                command: "python3 scripts/record_voice_profile_recording_kit.py --clip profile-clip-09 --record-missing-until-complete",
                clipIds: ["profile-clip-09"],
                presetIds: ["polyphone:bank-president"],
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
            nextProductProofCommand: "python3 scripts/record_voice_profile_recording_kit.py --run-product-proof-after-check",
            nextLoraHandoffCommand: "python3 scripts/record_voice_profile_recording_kit.py --prepare-lora-after-product-proof",
            nextProofEnvironmentCommand: null,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const audit = await fetchVoiceCloneGoalAudit("local-test");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/goal-audit",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ profileId: "local-test" }),
      }),
    );
    expect(audit?.complete).toBe(false);
    expect(audit?.completionRequirements).toHaveLength(2);
    expect(audit?.firstIncompleteRequirement?.id).toBe("recording_kit");
    expect(audit?.nextCommand).toContain("record_voice_profile_recording_kit.py");
    expect(audit?.nextMicrophoneSmokeTestCommand).toContain("--microphone-smoke-sec 2");
    expect(audit?.nextNormalizeExternalRecordingsCommand).toContain("normalize_voice_profile_recording_kit_audio.py");
    expect(audit?.nextNormalizePresentExternalRecordingsCommand).toContain("--only-present");
    expect(audit?.nextProfileReferenceRecordingBatchCommand).toContain("--clip profile-clip-09");
    expect(audit?.nextPostProfileReferenceRecordingProofCommand).toContain("voice_profile_next_step.py");
    expect(audit?.nextProfileReferenceRecordingCommands?.[0]).toMatchObject({
      presetId: "polyphone:bank-president",
      clipId: "profile-clip-09",
    });
    expect(audit?.nextQualityGateProbeCommands?.[0]).toMatchObject({
      caseId: "zh_hant_custom_readings",
      proofScope: "partial_case_probe_not_full_completion_gate",
    });
    expect(audit?.nextQualityGateRepairActions?.[0]).toMatchObject({
      kind: "record_profile_reference_batch",
      priority: 1,
      status: "ready",
      clipIds: ["profile-clip-09"],
      presetIds: ["polyphone:bank-president"],
    });
    expect(audit?.nextQualityGateRepairActions?.[1]).toMatchObject({
      kind: "run_quality_probe",
      priority: 3,
      status: "waiting",
      caseId: "zh_hant_custom_readings",
      blockedUntil: "rerun_profile_reference_proof",
    });
    expect(audit?.nextProductProofCommand).toContain("--run-product-proof-after-check");
    expect(audit?.nextLoraHandoffCommand).toContain("--prepare-lora-after-product-proof");
    expect(audit?.nextProofEnvironmentCommand).toBeNull();
  });

  it("fetches detailed profile evidence for build-line status seeding", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          profile: {
            clips: [{ sourceRunId: "accepted-1", transcriptRaw: "你好，我正在錄製一段聲音樣本。" }],
            rejectedClips: [{ sourceRunId: "short-1", transcriptRaw: "今天的天氣很好。", reasons: ["too_short"] }],
            diagnostics: { missingCoverageFeatures: ["numbers_dates"] },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const profile = await fetchVoiceProfileDetail("local-test");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile?profileId=local-test",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(profile?.clips?.[0].sourceRunId).toBe("accepted-1");
    expect(profile?.rejectedClips?.[0].reasons).toContain("too_short");
  });

  it("bulk-imports browser draft clips through the profile import route", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({
          status: "imported",
          imported: 1,
          profile: {
            clips: [{ sourceRunId: "draft-1", transcriptRaw: "你好，我正在錄製一段聲音樣本。" }],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await importVoiceProfileDraftClips({
      profileId: "local-test",
      clips: [
        {
          lineIndex: 0,
          transcript: "你好，我正在錄製一段聲音樣本。",
          file: new File([new Uint8Array([1, 2, 3])], "line-01.webm", { type: "audio/webm" }),
          captureSettings: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice-profile/import",
      expect.objectContaining({ method: "POST" }),
    );
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("consent")).toBe("yes");
    expect(body.get("profileId")).toBe("local-test");
    expect(body.get("voice-0")).toBeInstanceOf(File);
    const clips = JSON.parse(String(body.get("clips")));
    expect(clips).toEqual([
      {
        id: "profile-clip-01",
        fileField: "voice-0",
        transcript: "你好，我正在錄製一段聲音樣本。",
        sourceKind: "scripted",
        browserCaptureSettings: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1,
        },
      },
    ]);
  });

  it("refreshes transcript validation, strict verification, and the goal audit in order", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/voice-profile/transcript-validation")) {
        return Response.json({ validation: { status: "pass" } });
      }
      if (url.includes("/api/voice-profile/verify")) {
        return Response.json({ verification: { status: "blocked" } });
      }
      if (url.includes("/api/voice-profile/goal-audit")) {
        return Response.json({ audit: { status: "blocked", complete: false, completionRequirements: [] } });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshVoiceProfileProofChain("local-test");

    expect(calls).toEqual([
      "/api/voice-profile/transcript-validation",
      "/api/voice-profile/verify",
      "/api/voice-profile/goal-audit",
    ]);
    expect(result.validation?.validation).toMatchObject({ status: "pass" });
    expect(result.verification?.verification).toMatchObject({ status: "blocked" });
    expect(result.audit?.status).toBe("blocked");
  });

  it("returns null when the voice-clone goal audit route fails", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ status: "error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchVoiceCloneGoalAudit("local-test")).resolves.toBeNull();
  });
});

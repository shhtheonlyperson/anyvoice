import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloneInputToFormData,
  crossLingualWarning,
  detectTargetLanguage,
  isCloneInputError,
  parseCloneForm,
  type CloneInput,
} from "@/lib/clone-request";

let tmpRoot: string;

function writeProofFile(filePath: string, contents: string | Buffer): { path: string; sha256: string; bytes: number } {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  return {
    path: filePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
  };
}

function acceptedBackendSubjectiveReview(): Record<string, unknown> {
  return {
    status: "pass",
    reasons: [],
    missingChoices: [],
    invalidChoices: [],
    stats: {
      rounds: 5,
      reviewedRounds: 5,
      candidateWins: 4,
      baselineWins: 1,
      ties: 0,
      rerenders: 0,
      candidateWinRate: 0.8,
      minCandidateWinRate: 0.8,
    },
  };
}

function completeInternalProfileReference(overrides: Record<string, unknown> = {}): NonNullable<CloneInput["profileReference"]> {
  const profile = writeProofFile(path.join(tmpRoot, "profile", "profile.json"), JSON.stringify({ voiceProfileId: "local-test" }));
  const adapter = writeProofFile(path.join(tmpRoot, "lora", "lora_weights.ckpt"), Buffer.from([1, 2, 3, 4]));
  const adapterProof = writeProofFile(path.join(tmpRoot, "proof", "adapter-proof.json"), JSON.stringify({ status: "accepted" }));
  const qualityGate = writeProofFile(
    path.join(tmpRoot, "proof", "lora-quality-gate.json"),
    JSON.stringify({
      status: "pass",
      dryRun: false,
      inputs: {
        cloneMode: "hifi",
        transcriptValidationJson: "/tmp/transcript-validation.json",
        transcriptValidationSha256: "4".repeat(64),
      },
      proofs: {
        speakerBackendRequirement: { selected: "speechbrain-ecapa", required: "speechbrain-ecapa" },
        profileVerifyRequired: true,
        profileVerifyPassed: true,
        profileVerifySkipped: false,
        transcriptValidationRequired: true,
        transcriptValidationPassed: true,
        transcriptValidationSkipped: false,
        transcriptValidationJson: "/tmp/transcript-validation.json",
        transcriptValidationSha256: "4".repeat(64),
      },
    }),
  );
  const trainConfig = writeProofFile(path.join(tmpRoot, "proof", "train-config.json"), JSON.stringify({ rank: 8 }));
  const subjectiveReview = acceptedBackendSubjectiveReview();
  const selection = writeProofFile(
    path.join(tmpRoot, "backend", "selection.json"),
    JSON.stringify({ backend: "indextts2", subjectiveReview }),
  );
  const score = writeProofFile(path.join(tmpRoot, "backend", "score.json"), JSON.stringify({ score: 0.91 }));
  const review = writeProofFile(path.join(tmpRoot, "backend", "review.json"), JSON.stringify({ accepted: true }));
  const candidateOutput = writeProofFile(path.join(tmpRoot, "backend", "candidate.wav"), Buffer.from([8, 6, 7, 5]));
  const sourceReport = writeProofFile(
    path.join(tmpRoot, "backend", "report.json"),
    JSON.stringify({
      voiceProfile: {
        voiceProfileId: "local-test",
        profileSha256: profile.sha256,
      },
      groups: [
        {
          cloneMode: "indextts2",
          voiceProfileId: "local-test",
          profileSha256: profile.sha256,
          renders: [
            {
              status: "ready",
              externalBackend: true,
              outputExists: true,
              missingOutput: false,
              outputWav: candidateOutput.path,
              outputBytes: candidateOutput.bytes,
              outputSha256: candidateOutput.sha256,
              voiceProfileId: "local-test",
              profileSha256: profile.sha256,
            },
          ],
        },
      ],
    }),
  );

  return {
    voiceProfileId: "local-test",
    sourceRunId: "clip-1",
    referenceClipIds: ["clip-1", "clip-2"],
    audioPath: path.join(tmpRoot, "profile", "clip-1.wav"),
    loraPath: adapter.path,
    loraAdapter: {
      status: "accepted",
      profileJson: profile.path,
      voiceProfileId: "local-test",
      profileSha256: profile.sha256,
      path: adapter.path,
      bytes: adapter.bytes,
      sha256: adapter.sha256,
      adapterProofJson: adapterProof.path,
      adapterProofSha256: adapterProof.sha256,
      qualityGateJson: qualityGate.path,
      qualityGateSha256: qualityGate.sha256,
      trainConfig: trainConfig.path,
      trainConfigSha256: trainConfig.sha256,
      qualityGateProof: {
        status: "pass",
        dryRun: false,
        cloneMode: "hifi",
        speakerBackend: "speechbrain-ecapa",
        requiredSpeakerBackend: "speechbrain-ecapa",
        profileVerifyRequired: true,
        profileVerifyPassed: true,
        profileVerifySkipped: false,
        transcriptValidationRequired: true,
        transcriptValidationPassed: true,
        transcriptValidationSkipped: false,
        transcriptValidationJson: "/tmp/transcript-validation.json",
        transcriptValidationSha256: "4".repeat(64),
      },
    },
    preferredBackend: {
      status: "accepted",
      profileJson: profile.path,
      voiceProfileId: "local-test",
      profileSha256: profile.sha256,
      backend: "indextts2",
      baselineBackend: "voxcpm2-hifi",
      selectionJson: selection.path,
      selectionSha256: selection.sha256,
      scoreJson: score.path,
      scoreSha256: score.sha256,
      reviewJson: review.path,
      reviewSha256: review.sha256,
      sourceReport: sourceReport.path,
      sourceReportSha256: sourceReport.sha256,
      subjectiveReview,
    },
    ...overrides,
  };
}

function buildForm(overrides: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  const voice = new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" });
  form.set("voice", voice);
  form.set("targetText", "hello world");
  form.set("promptTranscript", "hello world");
  form.set("consent", "yes");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "anyvoice-clone-pipeline-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseCloneForm quality preset", () => {
  it("defaults to balanced when quality is absent", () => {
    const result = parseCloneForm(buildForm());
    expect(isCloneInputError(result)).toBe(false);
    if (!isCloneInputError(result)) {
      expect(result.quality).toBe("balanced");
    }
  });

  it("accepts the three known quality presets", () => {
    for (const q of ["speed", "balanced", "quality"] as const) {
      const result = parseCloneForm(buildForm({ quality: q }));
      expect(isCloneInputError(result)).toBe(false);
      if (!isCloneInputError(result)) {
        expect(result.quality).toBe(q);
      }
    }
  });

  it("returns a 400-shaped error on unknown quality values", () => {
    const result = parseCloneForm(buildForm({ quality: "ultra" }));
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.status).toBe("error");
      expect(result.body.message).toMatch(/quality/i);
    }
  });
});

describe("cloneInputToFormData", () => {
  it("round-trips the quality field", () => {
    const input: CloneInput = {
      voice: new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }),
      targetText: "hi",
      promptTranscript: "hello",
      quality: "quality",
    };
    const form = cloneInputToFormData(input);
    expect(form.get("quality")).toBe("quality");

    const reparsed = parseCloneForm(form);
    expect(isCloneInputError(reparsed)).toBe(false);
    if (!isCloneInputError(reparsed)) {
      expect(reparsed.quality).toBe("quality");
    }
  });

  it("defaults round-trip to balanced", () => {
    const input: CloneInput = {
      voice: new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }),
      targetText: "hi",
      promptTranscript: "hello",
      quality: "balanced",
    };
    const form = cloneInputToFormData(input);
    expect(form.get("quality")).toBe("balanced");
  });

  it("parses and round-trips pronunciation overrides", () => {
    const parsed = parseCloneForm(
      buildForm({ pronunciationOverrides: "重慶=重 慶\nAnyVoice=Any Voice\npinyin:行長=xing2 zhang3" }),
    );
    expect(isCloneInputError(parsed)).toBe(false);
    if (isCloneInputError(parsed)) throw new Error("expected clone input");
    expect(parsed.pronunciationOverrides).toEqual([
      {
        term: "重慶",
        replacement: "重 慶",
        kind: "polyphone",
        source: "preset",
        presetId: "polyphone:chongqing",
      },
      {
        term: "AnyVoice",
        replacement: "Any Voice",
        kind: "brand",
        source: "preset",
        presetId: "brand:anyvoice",
      },
      {
        term: "行長",
        replacement: "xing2 zhang3",
        kind: "pinyin",
        source: "custom",
      },
    ]);

    const form = cloneInputToFormData(parsed);
    expect(form.get("pronunciationOverrides")).toBe("重慶=重 慶\nAnyVoice=Any Voice\npinyin:行長=xing2 zhang3");
  });

  it("rejects malformed pronunciation overrides", () => {
    const result = parseCloneForm(buildForm({ pronunciationOverrides: "重慶" }));
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/pronunciation override/);
    }
  });

  it("round-trips profile policy only when the internal worker parser opts in", () => {
    const profileReference = completeInternalProfileReference();
    const input: CloneInput = {
      voice: new File([new Uint8Array([1, 2, 3])], "ref.wav", { type: "audio/wav" }),
      targetText: "hi",
      promptTranscript: "hello",
      quality: "balanced",
      sourceKind: "profile",
      profileReference,
    };

    const form = cloneInputToFormData(input);
    expect(form.get("internalProfileReferenceJson")).toEqual(expect.any(String));

    const publicParsed = parseCloneForm(form);
    expect(isCloneInputError(publicParsed)).toBe(false);
    if (isCloneInputError(publicParsed)) throw new Error("expected clone input");
    expect(publicParsed.profileReference).toBeUndefined();

    const workerParsed = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(workerParsed)).toBe(false);
    if (isCloneInputError(workerParsed)) throw new Error("expected clone input");
    expect(workerParsed.profileReference).toMatchObject({
      voiceProfileId: "local-test",
      sourceRunId: "clip-1",
      referenceClipIds: ["clip-1", "clip-2"],
      audioPath: profileReference.audioPath,
      loraPath: profileReference.loraPath,
      loraAdapter: {
        profileSha256: profileReference.loraAdapter?.profileSha256,
        adapterProofSha256: profileReference.loraAdapter?.adapterProofSha256,
        qualityGateSha256: profileReference.loraAdapter?.qualityGateSha256,
        trainConfigSha256: profileReference.loraAdapter?.trainConfigSha256,
      },
      preferredBackend: {
        status: "accepted",
        backend: "indextts2",
        profileSha256: profileReference.preferredBackend?.profileSha256,
        selectionSha256: profileReference.preferredBackend?.selectionSha256,
        reviewSha256: profileReference.preferredBackend?.reviewSha256,
        sourceReportSha256: profileReference.preferredBackend?.sourceReportSha256,
      },
    });
  });

  it("rejects internal profile LoRA paths without accepted adapter proof", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        loraPath: "/tmp/profile-lora/lora_weights.ckpt",
        loraAdapter: {
          status: "accepted",
          path: "/tmp/profile-lora/lora_weights.ckpt",
          sha256: "f".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/loraAdapter\.adapterProofJson/);
      expect(result.body.message).toMatch(/loraAdapter\.qualityGateJson/);
    }
  });

  it("rejects internal profile references unless sourceKind is profile", () => {
    const form = buildForm({
      sourceKind: "uploaded",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/sourceKind=profile/);
    }
  });

  it("accepts internal profile LoRA policies whose adapter path resolves to loraPath", () => {
    const profileReference = completeInternalProfileReference();
    const absoluteLoraPath = profileReference.loraPath;
    if (!absoluteLoraPath || !profileReference.loraAdapter) throw new Error("expected lora policy");
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        ...profileReference,
        loraPath: absoluteLoraPath,
        loraAdapter: {
          ...profileReference.loraAdapter,
          path: path.relative(process.cwd(), absoluteLoraPath),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(false);
    if (isCloneInputError(result)) throw new Error("expected clone input");
    expect(result.profileReference?.loraPath).toBe(absoluteLoraPath);
    expect(result.profileReference?.loraAdapter).toMatchObject({
      path: path.relative(process.cwd(), absoluteLoraPath),
      sha256: profileReference.loraAdapter.sha256,
      adapterProofSha256: profileReference.loraAdapter.adapterProofSha256,
      qualityGateSha256: profileReference.loraAdapter.qualityGateSha256,
    });
  });

  it("accepts internal profile LoRA policies with portable quality gate proof summary paths", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.loraAdapter?.qualityGateProof) throw new Error("expected lora policy");
    profileReference.loraAdapter.qualityGateProof = {
      ...(profileReference.loraAdapter.qualityGateProof as Record<string, unknown>),
      transcriptValidationJson: path.relative(process.cwd(), "/tmp/transcript-validation.json"),
    };
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(false);
    if (isCloneInputError(result)) throw new Error("expected clone input");
    expect(result.profileReference?.loraAdapter?.qualityGateProof).toMatchObject({
      transcriptValidationJson: path.relative(process.cwd(), "/tmp/transcript-validation.json"),
      transcriptValidationSha256: "4".repeat(64),
    });
  });

  it("rejects internal LoRA adapter policies when proof files no longer match their hashes", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.loraAdapter?.adapterProofJson) throw new Error("expected adapter proof");
    writeFileSync(profileReference.loraAdapter.adapterProofJson, JSON.stringify({ status: "tampered" }));
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/loraAdapter\.adapterProofJson_matches_adapterProofSha256/);
    }
  });

  it("rejects internal LoRA adapter policies whose persisted quality gate summary is stale", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.loraAdapter) throw new Error("expected lora policy");
    profileReference.loraAdapter.qualityGateProof = {
      ...(profileReference.loraAdapter.qualityGateProof as Record<string, unknown>),
      transcriptValidationPassed: false,
    };
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/loraAdapter\.qualityGateProof_matches_qualityGateJson/);
    }
  });

  it("rejects internal preferred backend policies when proof files no longer match their hashes", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.preferredBackend?.sourceReport) throw new Error("expected source report");
    writeFileSync(profileReference.preferredBackend.sourceReport, JSON.stringify({ status: "tampered" }));
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.sourceReport_matches_sourceReportSha256/);
    }
  });

  it("rejects internal preferred backend policies whose persisted subjective summary is stale", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.preferredBackend) throw new Error("expected preferred backend policy");
    profileReference.preferredBackend.subjectiveReview = {
      ...(profileReference.preferredBackend.subjectiveReview as Record<string, unknown>),
      status: "fail",
    };
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.subjectiveReview_matches_selectionJson/);
    }
  });

  it("accepts internal preferred backend policies with portable subjective summary paths", () => {
    const profileReference = completeInternalProfileReference();
    if (!profileReference.preferredBackend) throw new Error("expected preferred backend policy");
    const selectionPath = profileReference.preferredBackend.selectionJson;
    if (!selectionPath) throw new Error("expected selection proof");
    const selection = JSON.parse(readFileSync(selectionPath, "utf-8")) as Record<string, unknown>;
    selection.subjectiveReview = {
      ...(selection.subjectiveReview as Record<string, unknown>),
      reviewJson: profileReference.preferredBackend.reviewJson,
      report: profileReference.preferredBackend.sourceReport,
    };
    writeFileSync(selectionPath, JSON.stringify(selection));
    profileReference.preferredBackend.selectionSha256 = createHash("sha256").update(JSON.stringify(selection)).digest("hex");
    profileReference.preferredBackend.subjectiveReview = {
      ...(profileReference.preferredBackend.subjectiveReview as Record<string, unknown>),
      reviewJson: path.relative(process.cwd(), String(profileReference.preferredBackend.reviewJson)),
      report: path.relative(process.cwd(), String(profileReference.preferredBackend.sourceReport)),
    };
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify(profileReference),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(false);
  });

  it("rejects internal LoRA adapter policy when no runtime loraPath is selected", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        loraAdapter: {
          status: "accepted",
          profileJson: "/tmp/profile/profile.json",
          voiceProfileId: "local-test",
          profileSha256: "c".repeat(64),
          path: "/tmp/profile-lora/lora_weights.ckpt",
          bytes: 123,
          sha256: "f".repeat(64),
          adapterProofJson: "/tmp/adapter-proof.json",
          adapterProofSha256: "1".repeat(64),
          qualityGateJson: "/tmp/lora-quality-gate.json",
          qualityGateSha256: "2".repeat(64),
          trainConfig: "/tmp/train_config.json",
          trainConfigSha256: "3".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/loraPath_required_for_loraAdapter/);
    }
  });

  it("rejects incomplete internal external-backend policies before worker execution", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        preferredBackend: {
          status: "accepted",
          backend: "indextts2",
          selectionSha256: "a".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.baselineBackend/);
      expect(result.body.message).toMatch(/preferredBackend\.reviewJson/);
      expect(result.body.message).toMatch(/preferredBackend\.sourceReport/);
    }
  });

  it("rejects internal external-backend policies measured against a non-hifi baseline", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        preferredBackend: {
          status: "accepted",
          profileJson: "/tmp/profile/profile.json",
          voiceProfileId: "local-test",
          profileSha256: "c".repeat(64),
          backend: "indextts2",
          baselineBackend: "prompt",
          selectionJson: "/tmp/selection.json",
          selectionSha256: "a".repeat(64),
          scoreJson: "/tmp/score.json",
          scoreSha256: "b".repeat(64),
          reviewJson: "/tmp/review.json",
          reviewSha256: "d".repeat(64),
          sourceReport: "/tmp/report.json",
          sourceReportSha256: "e".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.baselineBackend_must_be_voxcpm2-hifi/);
    }
  });

  it("rejects native backends inside internal preferredBackend policy", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        preferredBackend: {
          status: "accepted",
          profileJson: "/tmp/profile/profile.json",
          voiceProfileId: "local-test",
          profileSha256: "c".repeat(64),
          backend: "voxcpm2-hifi",
          baselineBackend: "voxcpm2-hifi",
          selectionJson: "/tmp/selection.json",
          selectionSha256: "a".repeat(64),
          scoreJson: "/tmp/score.json",
          scoreSha256: "b".repeat(64),
          reviewJson: "/tmp/review.json",
          reviewSha256: "d".repeat(64),
          sourceReport: "/tmp/report.json",
          sourceReportSha256: "e".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.backend_must_be_external/);
    }
  });

  it("rejects unsupported external backends inside internal preferredBackend policy", () => {
    const form = buildForm({
      sourceKind: "profile",
      internalProfileReferenceJson: JSON.stringify({
        voiceProfileId: "local-test",
        sourceRunId: "clip-1",
        referenceClipIds: ["clip-1"],
        audioPath: "/tmp/profile/clip-1.wav",
        preferredBackend: {
          status: "accepted",
          profileJson: "/tmp/profile/profile.json",
          voiceProfileId: "local-test",
          profileSha256: "c".repeat(64),
          backend: "made-up-backend",
          baselineBackend: "voxcpm2-hifi",
          selectionJson: "/tmp/selection.json",
          selectionSha256: "a".repeat(64),
          scoreJson: "/tmp/score.json",
          scoreSha256: "b".repeat(64),
          reviewJson: "/tmp/review.json",
          reviewSha256: "d".repeat(64),
          sourceReport: "/tmp/report.json",
          sourceReportSha256: "e".repeat(64),
        },
      }),
    });

    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/preferredBackend\.backend_must_be_supported_external/);
    }
  });

  it("rejects malformed internal profile policy when the worker parser opts in", () => {
    const form = buildForm({ sourceKind: "profile", internalProfileReferenceJson: "not-json" });
    const result = parseCloneForm(form, { allowInternalProfileReference: true });
    expect(isCloneInputError(result)).toBe(true);
    if (isCloneInputError(result)) {
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(/internal profile reference/);
    }
  });
});

describe("detectTargetLanguage", () => {
  it("detects Chinese", () => {
    expect(detectTargetLanguage("你好")).toBe("zh");
  });

  it("detects English by default for Latin script", () => {
    expect(detectTargetLanguage("Hello")).toBe("en");
  });

  it("detects Korean Hangul", () => {
    expect(detectTargetLanguage("안녕")).toBe("ko");
  });

  it("detects Japanese kana", () => {
    expect(detectTargetLanguage("こんにちは")).toBe("ja");
  });

  it("treats mixed Latin + Han as Chinese (Han dominant)", () => {
    expect(detectTargetLanguage("Hello 世界")).toBe("zh");
  });

  it("falls back to English for empty / punctuation-only input", () => {
    expect(detectTargetLanguage("")).toBe("en");
    expect(detectTargetLanguage("!!! ???")).toBe("en");
  });
});

describe("crossLingualWarning", () => {
  it("returns null when either side is missing", () => {
    expect(crossLingualWarning(null, "en")).toBeNull();
    expect(crossLingualWarning("en", null)).toBeNull();
    expect(crossLingualWarning(undefined, "en")).toBeNull();
  });

  it("returns null when reference and target languages match", () => {
    expect(crossLingualWarning("en", "en")).toBeNull();
    expect(crossLingualWarning("zh", "zh")).toBeNull();
  });

  it("returns the formatted warning when languages differ", () => {
    expect(crossLingualWarning("en", "zh")).toBe("cross_lingual:en->_zh");
    expect(crossLingualWarning("zh", "ja")).toBe("cross_lingual:zh->_ja");
  });
});

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { maxUploadBytes, normalizeTargetText } from "@/lib/clone-config";
import {
  parsePronunciationOverrides,
  serializePronunciationOverride,
  type PronunciationOverride,
} from "@/lib/text-prep";

export type QualityPreset = "speed" | "balanced" | "quality";
export type SourceKind = "sample" | "scripted" | "freeform" | "uploaded" | "profile";

export const QUALITY_PRESETS: ReadonlyArray<QualityPreset> = ["speed", "balanced", "quality"];

export const DEFAULT_QUALITY_PRESET: QualityPreset = "balanced";

export interface CloneInput {
  voice: File;
  targetText: string;
  promptTranscript: string;
  quality: QualityPreset;
  sourceKind?: SourceKind;
  pronunciationOverrides?: PronunciationOverride[];
  profileReference?: {
    voiceProfileId: string;
    sourceRunId: string;
    referenceClipIds: string[];
    audioPath: string;
    transcriptScript?: string;
    coverageFeatures?: string[];
    targetCoverageFeatures?: string[];
    matchedCoverageFeatures?: string[];
    pronunciationPresetIds?: string[];
    targetPronunciationPresetIds?: string[];
    matchedPronunciationPresetIds?: string[];
    referenceQuality?: {
      grade: string;
      durationSec: number;
      snrDb: number | null;
      clippingRatio: number;
      vadActiveRatio: number;
      warnings: string[];
    };
    loraPath?: string | null;
    loraAdapter?: {
      version?: number;
      status: "accepted";
      profileJson?: string;
      voiceProfileId?: string;
      profileSha256?: string;
      path: string;
      bytes?: number;
      sha256?: string;
      adapterProofJson?: string;
      adapterProofSha256?: string;
      qualityGateJson?: string;
      qualityGateSha256?: string;
      trainConfig: string;
      trainConfigSha256: string;
      qualityGateProof?: unknown;
    };
    preferredBackend?: {
      version?: number;
      status: "accepted";
      profileJson?: string;
      voiceProfileId?: string;
      backend: string;
      baselineBackend: string;
      selectedAt?: string;
      profileSha256?: string;
      selectionJson?: string;
      selectionSha256?: string;
      scoreJson?: string;
      scoreSha256?: string;
      reviewJson?: string | null;
      reviewSha256?: string | null;
      sourceReport?: string | null;
      sourceReportSha256?: string | null;
      pairedSummary?: unknown;
      candidate?: unknown;
      subjectiveReview?: unknown;
    };
  };
}

export type CloneProfileReference = NonNullable<CloneInput["profileReference"]>;

export interface CloneInputError {
  statusCode: number;
  body: {
    status: "error";
    message: string;
  };
}

export function isCloneInputError(value: CloneInput | CloneInputError): value is CloneInputError {
  return "statusCode" in value;
}

export interface ParseCloneFormOptions {
  allowInternalProfileReference?: boolean;
}

const INTERNAL_PROFILE_REFERENCE_FIELD = "internalProfileReferenceJson";

function isQualityPreset(value: string): value is QualityPreset {
  return (QUALITY_PRESETS as ReadonlyArray<string>).includes(value);
}

function isSourceKind(value: string): value is SourceKind {
  return value === "sample" || value === "scripted" || value === "freeform" || value === "uploaded" || value === "profile";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function normalizeEvidencePath(filePath: string): string {
  const resolved = path.resolve(expandHomePath(filePath));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameEvidencePath(left: unknown, right: string): boolean {
  return typeof left === "string" && left.trim().length > 0 && normalizeEvidencePath(left) === normalizeEvidencePath(right);
}

function sameEvidencePathFromBases(left: unknown, leftBaseDir: string, right: unknown, rightBaseDir: string): boolean {
  const resolvedLeft = resolveEvidencePathFromBase(left, leftBaseDir);
  const resolvedRight = resolveEvidencePathFromBase(right, rightBaseDir);
  if (!resolvedLeft || !resolvedRight) return false;
  return resolvedLeft === resolvedRight;
}

function evidenceFileMatchesSha256(filePath: unknown, sha256: unknown): boolean {
  const normalizedPath = asString(filePath);
  if (!normalizedPath || !validSha256(sha256)) return false;
  try {
    const contents = readFileSync(normalizeEvidencePath(normalizedPath));
    return createHash("sha256").update(contents).digest("hex") === sha256;
  } catch {
    return false;
  }
}

function resolveEvidencePathFromBase(filePath: unknown, baseDir: string): string | null {
  const rawPath = asString(filePath);
  if (!rawPath) return null;
  const expanded = expandHomePath(rawPath);
  return normalizeEvidencePath(path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded));
}

function evidenceFileMatchesSha256AndBytes(filePath: unknown, sha256: unknown, bytes: unknown): boolean {
  const normalizedPath = asString(filePath);
  const expectedBytes = asFiniteNumber(bytes);
  if (!normalizedPath || !validSha256(sha256) || expectedBytes === undefined || expectedBytes <= 0) return false;
  try {
    const resolvedPath = normalizeEvidencePath(normalizedPath);
    const stats = statSync(resolvedPath);
    if (!stats.isFile() || stats.size !== expectedBytes) return false;
    const contents = readFileSync(resolvedPath);
    return createHash("sha256").update(contents).digest("hex") === sha256;
  } catch {
    return false;
  }
}

function readEvidenceObject(filePath: unknown): Record<string, unknown> | null {
  const normalizedPath = asString(filePath);
  if (!normalizedPath) return null;
  try {
    const payload = JSON.parse(readFileSync(normalizeEvidencePath(normalizedPath), "utf-8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function canonicalEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEvidenceJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEvidenceJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function subjectiveReviewSummaryMatches(
  summary: unknown,
  expected: Record<string, unknown>,
  summaryBaseDir: string,
  expectedBaseDir: string,
): boolean {
  if (summary === undefined) return true;
  const summaryObject = recordObject(summary);
  for (const key of ["reviewJson", "report"] as const) {
    const expectedPath = expected[key];
    if (typeof expectedPath === "string" && expectedPath.trim()) {
      if (!sameEvidencePathFromBases(summaryObject[key], summaryBaseDir, expectedPath, expectedBaseDir)) return false;
    } else if (summaryObject[key] !== expectedPath) {
      return false;
    }
  }
  for (const key of ["status", "reasons", "stats", "reviewStats", "statMismatches", "missingChoices", "invalidChoices"] as const) {
    if (canonicalEvidenceJson(summaryObject[key]) !== canonicalEvidenceJson(expected[key])) return false;
  }
  return true;
}

function loraQualityGateSummaryMatchesGate(
  summary: unknown,
  gate: Record<string, unknown>,
  summaryBaseDir: string,
  gateBaseDir: string,
): boolean {
  if (summary === undefined) return true;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const proof = summary as Record<string, unknown>;
  const inputs = recordObject(gate.inputs);
  const proofs = recordObject(gate.proofs);
  const speaker = recordObject(proofs.speakerBackendRequirement);
  const expectedFields: Array<[string, unknown]> = [
    ["status", gate.status],
    ["dryRun", gate.dryRun],
    ["cloneMode", inputs.cloneMode],
    ["speakerBackend", speaker.selected],
    ["requiredSpeakerBackend", speaker.required],
    ["profileVerifyRequired", proofs.profileVerifyRequired],
    ["profileVerifyPassed", proofs.profileVerifyPassed],
    ["profileVerifySkipped", proofs.profileVerifySkipped],
    ["transcriptValidationRequired", proofs.transcriptValidationRequired],
    ["transcriptValidationPassed", proofs.transcriptValidationPassed],
    ["transcriptValidationSkipped", proofs.transcriptValidationSkipped],
    ["transcriptValidationSha256", proofs.transcriptValidationSha256 ?? inputs.transcriptValidationSha256],
  ];
  if (expectedFields.some(([key, expected]) => proof[key] !== expected)) return false;

  const transcriptValidationJson = proofs.transcriptValidationJson ?? inputs.transcriptValidationJson;
  if (typeof transcriptValidationJson === "string" && transcriptValidationJson.trim()) {
    if (!sameEvidencePathFromBases(proof.transcriptValidationJson, summaryBaseDir, transcriptValidationJson, gateBaseDir)) return false;
  } else if (proof.transcriptValidationJson !== transcriptValidationJson) {
    return false;
  }

  const proofArtifacts = recordObject(proof.artifacts);
  const artifacts = recordObject(proofs.artifacts);
  for (const key of ["report", "asr", "speaker", "score"]) {
    const proofArtifact = recordObject(proofArtifacts[key]);
    const artifact = recordObject(artifacts[key]);
    if (typeof artifact.path === "string" && artifact.path.trim()) {
      if (!sameEvidencePathFromBases(proofArtifact.path, summaryBaseDir, artifact.path, gateBaseDir)) return false;
    } else if (proofArtifact.path !== artifact.path) {
      return false;
    }
    if (proofArtifact.sha256 !== artifact.sha256) return false;
  }
  return true;
}

function preferredBackendSourceReportHasRenderProof(
  sourceReportPath: string,
  backend: string,
  voiceProfileId: string | undefined,
  profileSha256: unknown,
): boolean {
  if (!validSha256(profileSha256)) return false;
  try {
    const reportPath = normalizeEvidencePath(sourceReportPath);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as Record<string, unknown>;
    const voiceProfile = report.voiceProfile && typeof report.voiceProfile === "object" && !Array.isArray(report.voiceProfile)
      ? (report.voiceProfile as Record<string, unknown>)
      : {};
    if (voiceProfile.voiceProfileId !== voiceProfileId || voiceProfile.profileSha256 !== profileSha256) return false;

    const groups = Array.isArray(report.groups) ? report.groups : [];
    const reportDir = path.dirname(reportPath);
    let matchedReadyExternalRenders = 0;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const groupObject = group as Record<string, unknown>;
      if (groupObject.cloneMode !== backend) continue;
      if (groupObject.voiceProfileId !== voiceProfileId || groupObject.profileSha256 !== profileSha256) return false;
      const renders = Array.isArray(groupObject.renders) ? groupObject.renders : [];
      for (const render of renders) {
        if (!render || typeof render !== "object" || Array.isArray(render)) continue;
        const renderObject = render as Record<string, unknown>;
        if (renderObject.status !== "ready") continue;
        if (renderObject.voiceProfileId !== voiceProfileId || renderObject.profileSha256 !== profileSha256) return false;
        if (renderObject.externalBackend !== true) return false;
        if (renderObject.outputExists !== true || renderObject.missingOutput === true) return false;
        const outputPath = resolveEvidencePathFromBase(renderObject.outputWav, reportDir);
        if (!outputPath || !evidenceFileMatchesSha256AndBytes(outputPath, renderObject.outputSha256, renderObject.outputBytes)) {
          return false;
        }
        matchedReadyExternalRenders += 1;
      }
    }
    return matchedReadyExternalRenders > 0;
  } catch {
    return false;
  }
}

function isNativeVoiceBackend(value: string): boolean {
  return value === "voxcpm2-hifi" || value === "voxcpm2-lora";
}

function isSupportedExternalVoiceBackend(value: string): boolean {
  return value === "indextts2" || value === "f5-tts" || value === "fishaudio-s2-pro";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseInternalProfileReference(raw: FormDataEntryValue | null): CloneProfileReference | CloneInputError | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    return { statusCode: 400, body: { status: "error", message: "invalid internal profile reference" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: { status: "error", message: "invalid internal profile reference" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { statusCode: 400, body: { status: "error", message: "invalid internal profile reference" } };
  }

  const obj = parsed as Record<string, unknown>;
  const voiceProfileId = asString(obj.voiceProfileId);
  const sourceRunId = asString(obj.sourceRunId);
  const audioPath = asString(obj.audioPath);
  const referenceClipIds = asStringArray(obj.referenceClipIds);
  if (!voiceProfileId || !sourceRunId || !audioPath || referenceClipIds.length === 0) {
    return { statusCode: 400, body: { status: "error", message: "invalid internal profile reference" } };
  }

  const profileReference: CloneProfileReference = {
    voiceProfileId,
    sourceRunId,
    referenceClipIds,
    audioPath,
  };

  const transcriptScript = asString(obj.transcriptScript);
  if (transcriptScript) profileReference.transcriptScript = transcriptScript;
  for (const key of [
    "coverageFeatures",
    "targetCoverageFeatures",
    "matchedCoverageFeatures",
    "pronunciationPresetIds",
    "targetPronunciationPresetIds",
    "matchedPronunciationPresetIds",
  ] as const) {
    const values = asStringArray(obj[key]);
    if (values.length > 0) profileReference[key] = values;
  }

  if (obj.referenceQuality && typeof obj.referenceQuality === "object" && !Array.isArray(obj.referenceQuality)) {
    const quality = obj.referenceQuality as Record<string, unknown>;
    const grade = asString(quality.grade);
    const durationSec = asFiniteNumber(quality.durationSec);
    const clippingRatio = asFiniteNumber(quality.clippingRatio);
    const vadActiveRatio = asFiniteNumber(quality.vadActiveRatio);
    if (grade && durationSec !== undefined && clippingRatio !== undefined && vadActiveRatio !== undefined) {
      profileReference.referenceQuality = {
        grade,
        durationSec,
        snrDb: asFiniteNumber(quality.snrDb) ?? null,
        clippingRatio,
        vadActiveRatio,
        warnings: asStringArray(quality.warnings),
      };
    }
  }

  const loraPath = asStringOrNull(obj.loraPath);
  const loraAdapter = obj.loraAdapter && typeof obj.loraAdapter === "object" && !Array.isArray(obj.loraAdapter)
    ? (obj.loraAdapter as Record<string, unknown>)
    : null;
  if (loraAdapter && !loraPath) {
    return {
      statusCode: 400,
      body: {
        status: "error",
        message: "invalid internal LoRA adapter policy: loraPath_required_for_loraAdapter",
      },
    };
  }
  if (loraPath) {
    const missing: string[] = [];
    if (!loraAdapter || loraAdapter.status !== "accepted") missing.push("loraAdapter.status=accepted");
    if (loraAdapter) {
      if (!asString(loraAdapter.profileJson)) missing.push("loraAdapter.profileJson");
      if (!asString(loraAdapter.voiceProfileId)) missing.push("loraAdapter.voiceProfileId");
      if (asString(loraAdapter.voiceProfileId) && asString(loraAdapter.voiceProfileId) !== voiceProfileId) {
        missing.push("loraAdapter.voiceProfileId_matches_profileReference");
      }
      if (!validSha256(loraAdapter.profileSha256)) missing.push("loraAdapter.profileSha256");
      if (asString(loraAdapter.profileJson) && validSha256(loraAdapter.profileSha256)
        && !evidenceFileMatchesSha256(loraAdapter.profileJson, loraAdapter.profileSha256)) {
        missing.push("loraAdapter.profileJson_matches_profileSha256");
      }
      if (!sameEvidencePath(loraAdapter.path, loraPath)) missing.push("loraAdapter.path_matches_loraPath");
      if (!asFiniteNumber(loraAdapter.bytes) || Number(loraAdapter.bytes) <= 0) missing.push("loraAdapter.bytes");
      if (!validSha256(loraAdapter.sha256)) missing.push("loraAdapter.sha256");
      if (asString(loraAdapter.path) && validSha256(loraAdapter.sha256) && asFiniteNumber(loraAdapter.bytes)
        && !evidenceFileMatchesSha256AndBytes(loraAdapter.path, loraAdapter.sha256, loraAdapter.bytes)) {
        missing.push("loraAdapter.path_matches_sha256_and_bytes");
      }
      if (!asString(loraAdapter.adapterProofJson)) missing.push("loraAdapter.adapterProofJson");
      if (!validSha256(loraAdapter.adapterProofSha256)) missing.push("loraAdapter.adapterProofSha256");
      if (asString(loraAdapter.adapterProofJson) && validSha256(loraAdapter.adapterProofSha256)
        && !evidenceFileMatchesSha256(loraAdapter.adapterProofJson, loraAdapter.adapterProofSha256)) {
        missing.push("loraAdapter.adapterProofJson_matches_adapterProofSha256");
      }
      if (!asString(loraAdapter.qualityGateJson)) missing.push("loraAdapter.qualityGateJson");
      if (!validSha256(loraAdapter.qualityGateSha256)) missing.push("loraAdapter.qualityGateSha256");
      if (asString(loraAdapter.qualityGateJson) && validSha256(loraAdapter.qualityGateSha256)
        && !evidenceFileMatchesSha256(loraAdapter.qualityGateJson, loraAdapter.qualityGateSha256)) {
        missing.push("loraAdapter.qualityGateJson_matches_qualityGateSha256");
      }
      if (loraAdapter.qualityGateProof !== undefined) {
        const qualityGate = readEvidenceObject(loraAdapter.qualityGateJson);
        const qualityGateJson = asString(loraAdapter.qualityGateJson);
        const qualityGateDir = qualityGateJson ? path.dirname(normalizeEvidencePath(qualityGateJson)) : process.cwd();
        if (
          !qualityGate
          || !loraQualityGateSummaryMatchesGate(loraAdapter.qualityGateProof, qualityGate, process.cwd(), qualityGateDir)
        ) {
          missing.push("loraAdapter.qualityGateProof_matches_qualityGateJson");
        }
      }
      if (!asString(loraAdapter.trainConfig)) missing.push("loraAdapter.trainConfig");
      if (!validSha256(loraAdapter.trainConfigSha256)) missing.push("loraAdapter.trainConfigSha256");
      if (asString(loraAdapter.trainConfig) && validSha256(loraAdapter.trainConfigSha256)
        && !evidenceFileMatchesSha256(loraAdapter.trainConfig, loraAdapter.trainConfigSha256)) {
        missing.push("loraAdapter.trainConfig_matches_trainConfigSha256");
      }
    }
    if (missing.length > 0) {
      return {
        statusCode: 400,
        body: {
          status: "error",
          message: `invalid internal LoRA adapter policy: ${missing.join(", ")}`,
        },
      };
    }
  }
  if (loraPath !== undefined) profileReference.loraPath = loraPath;
  if (loraPath && obj.loraAdapter && typeof obj.loraAdapter === "object" && !Array.isArray(obj.loraAdapter)) {
    const adapter = obj.loraAdapter as Record<string, unknown>;
    const path = asString(adapter.path);
    const trainConfig = asString(adapter.trainConfig);
    const trainConfigSha256 = asString(adapter.trainConfigSha256);
    if (adapter.status === "accepted" && path && trainConfig && trainConfigSha256) {
      profileReference.loraAdapter = {
        version: asFiniteNumber(adapter.version),
        status: "accepted",
        profileJson: asString(adapter.profileJson),
        voiceProfileId: asString(adapter.voiceProfileId),
        profileSha256: asString(adapter.profileSha256),
        path,
        bytes: asFiniteNumber(adapter.bytes),
        sha256: asString(adapter.sha256),
        adapterProofJson: asString(adapter.adapterProofJson),
        adapterProofSha256: asString(adapter.adapterProofSha256),
        qualityGateJson: asString(adapter.qualityGateJson),
        qualityGateSha256: asString(adapter.qualityGateSha256),
        trainConfig,
        trainConfigSha256,
        qualityGateProof: adapter.qualityGateProof,
      };
    }
  }

  if (obj.preferredBackend && typeof obj.preferredBackend === "object" && !Array.isArray(obj.preferredBackend)) {
    const backendPolicy = obj.preferredBackend as Record<string, unknown>;
    const backend = asString(backendPolicy.backend);
    const baselineBackend = asString(backendPolicy.baselineBackend);
    if (backendPolicy.status === "accepted" && backend) {
      const missing: string[] = [];
      if (isNativeVoiceBackend(backend)) missing.push("preferredBackend.backend_must_be_external");
      if (!isNativeVoiceBackend(backend) && !isSupportedExternalVoiceBackend(backend)) {
        missing.push("preferredBackend.backend_must_be_supported_external");
      }
      if (!baselineBackend) missing.push("preferredBackend.baselineBackend");
      if (!isNativeVoiceBackend(backend)) {
        if (baselineBackend && baselineBackend !== "voxcpm2-hifi") {
          missing.push("preferredBackend.baselineBackend_must_be_voxcpm2-hifi");
        }
        if (!asString(backendPolicy.profileJson)) missing.push("preferredBackend.profileJson");
        if (!asString(backendPolicy.voiceProfileId)) missing.push("preferredBackend.voiceProfileId");
        if (asString(backendPolicy.voiceProfileId) && asString(backendPolicy.voiceProfileId) !== voiceProfileId) {
          missing.push("preferredBackend.voiceProfileId_matches_profileReference");
        }
        if (!validSha256(backendPolicy.profileSha256)) missing.push("preferredBackend.profileSha256");
        if (asString(backendPolicy.profileJson) && validSha256(backendPolicy.profileSha256)
          && !evidenceFileMatchesSha256(backendPolicy.profileJson, backendPolicy.profileSha256)) {
          missing.push("preferredBackend.profileJson_matches_profileSha256");
        }
        if (!asString(backendPolicy.selectionJson)) missing.push("preferredBackend.selectionJson");
        if (!validSha256(backendPolicy.selectionSha256)) missing.push("preferredBackend.selectionSha256");
        if (asString(backendPolicy.selectionJson) && validSha256(backendPolicy.selectionSha256)
          && !evidenceFileMatchesSha256(backendPolicy.selectionJson, backendPolicy.selectionSha256)) {
          missing.push("preferredBackend.selectionJson_matches_selectionSha256");
        }
        if (!asString(backendPolicy.scoreJson)) missing.push("preferredBackend.scoreJson");
        if (!validSha256(backendPolicy.scoreSha256)) missing.push("preferredBackend.scoreSha256");
        if (asString(backendPolicy.scoreJson) && validSha256(backendPolicy.scoreSha256)
          && !evidenceFileMatchesSha256(backendPolicy.scoreJson, backendPolicy.scoreSha256)) {
          missing.push("preferredBackend.scoreJson_matches_scoreSha256");
        }
        if (!asString(backendPolicy.reviewJson)) missing.push("preferredBackend.reviewJson");
        if (!validSha256(backendPolicy.reviewSha256)) missing.push("preferredBackend.reviewSha256");
        if (asString(backendPolicy.reviewJson) && validSha256(backendPolicy.reviewSha256)
          && !evidenceFileMatchesSha256(backendPolicy.reviewJson, backendPolicy.reviewSha256)) {
          missing.push("preferredBackend.reviewJson_matches_reviewSha256");
        }
        if (!asString(backendPolicy.sourceReport)) missing.push("preferredBackend.sourceReport");
        if (!validSha256(backendPolicy.sourceReportSha256)) missing.push("preferredBackend.sourceReportSha256");
        const sourceReport = asString(backendPolicy.sourceReport);
        if (sourceReport && validSha256(backendPolicy.sourceReportSha256)) {
          if (!evidenceFileMatchesSha256(sourceReport, backendPolicy.sourceReportSha256)) {
            missing.push("preferredBackend.sourceReport_matches_sourceReportSha256");
          } else if (
            !preferredBackendSourceReportHasRenderProof(
              sourceReport,
              backend,
              asString(backendPolicy.voiceProfileId),
              backendPolicy.profileSha256,
            )
          ) {
            missing.push("preferredBackend.sourceReport_render_output_proof");
          }
        }
        if (backendPolicy.subjectiveReview !== undefined) {
          const selection = readEvidenceObject(backendPolicy.selectionJson);
          const subjective = recordObject(selection?.subjectiveReview);
          const selectionJson = asString(backendPolicy.selectionJson);
          const selectionDir = selectionJson ? path.dirname(normalizeEvidencePath(selectionJson)) : process.cwd();
          if (!selection || !subjectiveReviewSummaryMatches(backendPolicy.subjectiveReview, subjective, process.cwd(), selectionDir)) {
            missing.push("preferredBackend.subjectiveReview_matches_selectionJson");
          }
        }
      }
      if (missing.length > 0) {
        return {
          statusCode: 400,
          body: {
            status: "error",
            message: `invalid internal preferred backend policy: ${missing.join(", ")}`,
          },
        };
      }
      profileReference.preferredBackend = {
        version: asFiniteNumber(backendPolicy.version),
        status: "accepted",
        profileJson: asString(backendPolicy.profileJson),
        voiceProfileId: asString(backendPolicy.voiceProfileId),
        backend,
        baselineBackend: baselineBackend ?? "",
        selectedAt: asString(backendPolicy.selectedAt),
        profileSha256: asString(backendPolicy.profileSha256),
        selectionJson: asString(backendPolicy.selectionJson),
        selectionSha256: asString(backendPolicy.selectionSha256),
        scoreJson: asString(backendPolicy.scoreJson),
        scoreSha256: asString(backendPolicy.scoreSha256),
        reviewJson: asStringOrNull(backendPolicy.reviewJson),
        reviewSha256: asStringOrNull(backendPolicy.reviewSha256),
        sourceReport: asStringOrNull(backendPolicy.sourceReport),
        sourceReportSha256: asStringOrNull(backendPolicy.sourceReportSha256),
        pairedSummary: backendPolicy.pairedSummary,
        candidate: backendPolicy.candidate,
        subjectiveReview: backendPolicy.subjectiveReview,
      };
    }
  }

  return profileReference;
}

export function parseCloneForm(form: FormData, options: ParseCloneFormOptions = {}): CloneInput | CloneInputError {
  const voice = form.get("voice");
  const consent = form.get("consent");
  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  const promptTranscript = normalizeTargetText(String(form.get("promptTranscript") || ""));
  const qualityRaw = form.get("quality");
  const sourceKindRaw = form.get("sourceKind");
  const pronunciationOverridesRaw = String(form.get("pronunciationOverrides") || "");

  if (!(voice instanceof File)) {
    return { statusCode: 400, body: { status: "error", message: "voice file required" } };
  }
  if (voice.size <= 0) {
    return { statusCode: 400, body: { status: "error", message: "voice file is empty" } };
  }
  if (voice.size > maxUploadBytes()) {
    return { statusCode: 413, body: { status: "error", message: "voice file is too large" } };
  }
  if (!targetText) {
    return { statusCode: 400, body: { status: "error", message: "target text required" } };
  }
  if (!promptTranscript) {
    return {
      statusCode: 400,
      body: {
        status: "error",
        message: "reference transcript required: type exactly what the reference clip says",
      },
    };
  }
  if (consent !== "yes") {
    return { statusCode: 400, body: { status: "error", message: "voice permission confirmation required" } };
  }

  let quality: QualityPreset = DEFAULT_QUALITY_PRESET;
  if (qualityRaw !== null && qualityRaw !== undefined && String(qualityRaw).length > 0) {
    const candidate = String(qualityRaw).trim().toLowerCase();
    if (!isQualityPreset(candidate)) {
      return {
        statusCode: 400,
        body: { status: "error", message: `unknown quality preset: ${candidate}` },
      };
    }
    quality = candidate;
  }

  const input: CloneInput = {
    voice,
    targetText,
    promptTranscript,
    quality,
  };
  if (pronunciationOverridesRaw.trim()) {
    const parsed = parsePronunciationOverrides(pronunciationOverridesRaw);
    if (parsed.rejected.length > 0) {
      const first = parsed.rejected[0];
      return {
        statusCode: 400,
        body: {
          status: "error",
          message: `invalid pronunciation override on line ${first.line}: ${first.reason}`,
        },
      };
    }
    if (parsed.overrides.length > 0) input.pronunciationOverrides = parsed.overrides;
  }
  if (sourceKindRaw !== null && sourceKindRaw !== undefined) {
    const candidate = String(sourceKindRaw).trim().toLowerCase();
    if (isSourceKind(candidate)) input.sourceKind = candidate;
  }
  if (options.allowInternalProfileReference) {
    const profileReference = parseInternalProfileReference(form.get(INTERNAL_PROFILE_REFERENCE_FIELD));
    if (profileReference && "statusCode" in profileReference) return profileReference;
    if (profileReference && input.sourceKind !== "profile") {
      return {
        statusCode: 400,
        body: {
          status: "error",
          message: "internal profile reference requires sourceKind=profile",
        },
      };
    }
    if (profileReference) input.profileReference = profileReference;
  }

  return input;
}

export function cloneInputToFormData(input: CloneInput): FormData {
  const form = new FormData();
  form.set("voice", input.voice, input.voice.name || "reference.audio");
  form.set("targetText", input.targetText);
  form.set("promptTranscript", input.promptTranscript);
  form.set("quality", input.quality);
  if (input.pronunciationOverrides?.length) {
    form.set(
      "pronunciationOverrides",
      input.pronunciationOverrides.map(serializePronunciationOverride).join("\n"),
    );
  }
  if (input.sourceKind) form.set("sourceKind", input.sourceKind);
  if (input.profileReference) {
    form.set(INTERNAL_PROFILE_REFERENCE_FIELD, JSON.stringify(input.profileReference));
  }
  form.set("consent", "yes");
  return form;
}

/**
 * Detect the dominant script of the target text using simple Unicode-range
 * heuristics. CJK ideographs map to "zh", Hiragana/Katakana to "ja",
 * Hangul to "ko". Anything else (including ASCII Latin) falls back to "en".
 */
export function detectTargetLanguage(text: string): "zh" | "ja" | "ko" | "en" {
  let zh = 0;
  let ja = 0;
  let ko = 0;
  let latin = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code >= 0x4e00 && code <= 0x9fff) {
      zh += 1;
    } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      ja += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      ko += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1;
    }
  }

  if (ja > 0 && ja >= ko) return "ja";
  if (ko > 0 && ko >= ja) return "ko";
  if (zh > 0) return "zh";
  if (latin > 0) return "en";
  return "en";
}

/**
 * Returns the cross-lingual warning string when reference and target languages
 * differ, otherwise null.
 */
export function crossLingualWarning(
  refLang: string | null | undefined,
  targetLang: string | null | undefined,
): string | null {
  if (!refLang || !targetLang) return null;
  if (refLang === targetLang) return null;
  return `cross_lingual:${refLang}->_${targetLang}`;
}

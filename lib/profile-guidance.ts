import {
  detectVoiceProfileCoverageFeatures,
  type VoiceProfileCoverageFeature,
} from "@/lib/text-prep";

export interface ProfileScriptRecommendation {
  index: number;
  text: string;
  coverage: VoiceProfileCoverageFeature[];
  primaryFeature: VoiceProfileCoverageFeature | null;
}

export interface ProfileScriptEvidence {
  sourceRunId: string;
  transcriptRaw: string;
  coverageFeatures?: VoiceProfileCoverageFeature[];
}

export interface RejectedProfileScriptEvidence extends ProfileScriptEvidence {
  reasons?: string[];
}

export interface ProfileScriptPlanItem {
  index: number;
  text: string;
  coverage: VoiceProfileCoverageFeature[];
  status: "accepted" | "rejected" | "missing";
  primaryFeature: VoiceProfileCoverageFeature | null;
  sourceRunId: string | null;
  reasons: string[];
}

function transcriptKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function selectNextProfileScript({
  scripts,
  missingCoverageFeatures,
  eligibleClips,
}: {
  scripts: string[];
  missingCoverageFeatures: VoiceProfileCoverageFeature[];
  eligibleClips: number;
}): ProfileScriptRecommendation | null {
  const scriptCoverage = scripts.map((text, index) => ({
    index,
    text,
    coverage: detectVoiceProfileCoverageFeatures(text),
  }));
  if (scriptCoverage.length === 0) return null;
  const wanted = missingCoverageFeatures[0];
  const match = wanted ? scriptCoverage.find((script) => script.coverage.includes(wanted)) : null;
  const fallback = scriptCoverage[eligibleClips % scriptCoverage.length] ?? scriptCoverage[0];
  const selected = match ?? fallback;
  if (!selected) return null;
  return {
    ...selected,
    primaryFeature: wanted ?? selected.coverage[0] ?? null,
  };
}

export function selectNextProfileRecordingScript({
  scripts,
  missingCoverageFeatures,
  eligibleClips,
  draftIndices = [],
}: {
  scripts: string[];
  missingCoverageFeatures: VoiceProfileCoverageFeature[];
  eligibleClips: number;
  draftIndices?: Iterable<number>;
}): ProfileScriptRecommendation | null {
  const first = selectNextProfileScript({ scripts, missingCoverageFeatures, eligibleClips });
  if (!first) return null;

  const drafted = new Set(Array.from(draftIndices).filter((index) => Number.isInteger(index) && index >= 0));
  if (!drafted.has(first.index)) return first;

  const wanted = missingCoverageFeatures[0];
  for (let offset = 1; offset < scripts.length; offset += 1) {
    const index = (first.index + offset) % scripts.length;
    if (drafted.has(index)) continue;
    const text = scripts[index];
    const coverage = detectVoiceProfileCoverageFeatures(text);
    return {
      index,
      text,
      coverage,
      primaryFeature: wanted && coverage.includes(wanted) ? wanted : coverage[0] ?? null,
    };
  }

  return null;
}

export function buildProfileScriptPlan({
  scripts,
  acceptedClips,
  rejectedClips = [],
  missingCoverageFeatures,
}: {
  scripts: string[];
  acceptedClips: ProfileScriptEvidence[];
  rejectedClips?: RejectedProfileScriptEvidence[];
  missingCoverageFeatures: VoiceProfileCoverageFeature[];
}): ProfileScriptPlanItem[] {
  const acceptedByTranscript = new Map(
    acceptedClips.map((clip) => [transcriptKey(clip.transcriptRaw), clip]),
  );
  const rejectedByTranscript = new Map(
    rejectedClips.map((clip) => [transcriptKey(clip.transcriptRaw), clip]),
  );

  return scripts.map((text, index) => {
    const coverage = detectVoiceProfileCoverageFeatures(text);
    const key = transcriptKey(text);
    const accepted = acceptedByTranscript.get(key);
    const rejected = rejectedByTranscript.get(key);
    const wanted = missingCoverageFeatures.find((feature) => coverage.includes(feature));
    if (accepted) {
      return {
        index,
        text,
        coverage,
        status: "accepted" as const,
        primaryFeature: wanted ?? coverage[0] ?? null,
        sourceRunId: accepted.sourceRunId,
        reasons: [],
      };
    }
    if (rejected) {
      return {
        index,
        text,
        coverage,
        status: "rejected" as const,
        primaryFeature: wanted ?? coverage[0] ?? null,
        sourceRunId: rejected.sourceRunId,
        reasons: rejected.reasons ?? [],
      };
    }
    return {
      index,
      text,
      coverage,
      status: "missing" as const,
      primaryFeature: wanted ?? coverage[0] ?? null,
      sourceRunId: null,
      reasons: [],
    };
  });
}

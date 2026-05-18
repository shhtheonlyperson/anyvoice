import { maxUploadBytes, normalizeTargetText } from "@/lib/clone-config";

export type QualityPreset = "speed" | "balanced" | "quality";

export const QUALITY_PRESETS: ReadonlyArray<QualityPreset> = ["speed", "balanced", "quality"];

export const DEFAULT_QUALITY_PRESET: QualityPreset = "balanced";

export interface CloneInput {
  voice: File;
  targetText: string;
  promptTranscript: string;
  quality: QualityPreset;
}

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

function isQualityPreset(value: string): value is QualityPreset {
  return (QUALITY_PRESETS as ReadonlyArray<string>).includes(value);
}

export function parseCloneForm(form: FormData): CloneInput | CloneInputError {
  const voice = form.get("voice");
  const consent = form.get("consent");
  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  const promptTranscript = normalizeTargetText(String(form.get("promptTranscript") || ""));
  const qualityRaw = form.get("quality");

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

  return {
    voice,
    targetText,
    promptTranscript,
    quality,
  };
}

export function cloneInputToFormData(input: CloneInput): FormData {
  const form = new FormData();
  form.set("voice", input.voice, input.voice.name || "reference.audio");
  form.set("targetText", input.targetText);
  form.set("promptTranscript", input.promptTranscript);
  form.set("quality", input.quality);
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

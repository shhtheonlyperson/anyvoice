import { maxUploadBytes, normalizeStyle, normalizeTargetText } from "@/lib/clone-config";

export interface CloneInput {
  voice: File;
  targetText: string;
  promptTranscript: string;
  style: string;
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

export function parseCloneForm(form: FormData): CloneInput | CloneInputError {
  const voice = form.get("voice");
  const consent = form.get("consent");
  const targetText = normalizeTargetText(String(form.get("targetText") || ""));
  const promptTranscript = normalizeTargetText(String(form.get("promptTranscript") || ""));
  const style = normalizeStyle(String(form.get("style") || ""));

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
  if (consent !== "yes") {
    return { statusCode: 400, body: { status: "error", message: "voice permission confirmation required" } };
  }

  return {
    voice,
    targetText,
    promptTranscript,
    style,
  };
}

export function cloneInputToFormData(input: CloneInput): FormData {
  const form = new FormData();
  form.set("voice", input.voice, input.voice.name || "reference.audio");
  form.set("targetText", input.targetText);
  form.set("style", input.style);
  form.set("promptTranscript", input.promptTranscript);
  form.set("consent", "yes");
  return form;
}

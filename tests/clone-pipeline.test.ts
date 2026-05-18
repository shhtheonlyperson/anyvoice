import { describe, expect, it } from "vitest";
import {
  cloneInputToFormData,
  crossLingualWarning,
  detectTargetLanguage,
  isCloneInputError,
  parseCloneForm,
  type CloneInput,
} from "@/lib/clone-request";

function buildForm(overrides: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  const voice = new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" });
  form.set("voice", voice);
  form.set("targetText", "hello world");
  form.set("consent", "yes");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

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
      promptTranscript: "",
      style: "",
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
      promptTranscript: "",
      style: "",
      quality: "balanced",
    };
    const form = cloneInputToFormData(input);
    expect(form.get("quality")).toBe("balanced");
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

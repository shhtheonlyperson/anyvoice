import { describe, expect, it } from "vitest";
import {
  clampWindow,
  parseTimeParam,
  parseVtt,
  parseYoutubeUrl,
  pickSubtitleFile,
  selectCuesText,
  simplifiedToTraditional,
} from "@/lib/youtube-import";
import { strictTraditionalChineseScriptErrors } from "@/lib/text-prep";

describe("parseTimeParam", () => {
  it("parses bare seconds, unit, and clock forms", () => {
    expect(parseTimeParam("300")).toBe(300);
    expect(parseTimeParam("300s")).toBe(300);
    expect(parseTimeParam("5m0s")).toBe(300);
    expect(parseTimeParam("5:00")).toBe(300);
    expect(parseTimeParam("1h2m3s")).toBe(3723);
    expect(parseTimeParam("1:05:00")).toBe(3900);
  });
  it("returns 0 for empty or garbage", () => {
    expect(parseTimeParam(null)).toBe(0);
    expect(parseTimeParam("")).toBe(0);
    expect(parseTimeParam("abc")).toBe(0);
    expect(parseTimeParam("1:2:3:4")).toBe(0);
  });
});

describe("parseYoutubeUrl", () => {
  it("handles watch, youtu.be, shorts and embed", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ",
      startSeconds: 0,
    });
    expect(parseYoutubeUrl("https://youtu.be/dQw4w9WgXcQ?t=5m0s")).toEqual({
      videoId: "dQw4w9WgXcQ",
      startSeconds: 300,
    });
    expect(parseYoutubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.videoId).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")?.videoId).toBe("dQw4w9WgXcQ");
  });
  it("reads the t param from a watch URL", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=300")?.startSeconds).toBe(300);
  });
  it("returns null for invalid ids or non-URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYoutubeUrl("not a url")).toBeNull();
    expect(parseYoutubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("clampWindow", () => {
  it("defaults to a 12s window", () => {
    expect(clampWindow(100)).toEqual({ start: 100, end: 112 });
  });
  it("clamps below 6s and above 20s", () => {
    expect(clampWindow(100, 2)).toEqual({ start: 100, end: 106 });
    expect(clampWindow(100, 60)).toEqual({ start: 100, end: 120 });
  });
});

describe("parseVtt + selectCuesText", () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
你好

00:00:03.000 --> 00:00:06.000
你好 世界

00:00:06.000 --> 00:00:09.000
<c>歡迎</c> 收看

00:00:30.000 --> 00:00:33.000
這在視窗之外
`;
  it("parses timed cues and strips tags", () => {
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(4);
    expect(cues[2].text).toBe("歡迎 收看");
  });
  it("selects overlapping cues and dedups rolling duplicates", () => {
    const cues = parseVtt(vtt);
    const text = selectCuesText(cues, 0, 9);
    expect(text).toContain("收看");
    expect(text).not.toContain("視窗之外");
    // "你好" then "你好 世界" should collapse to the longer line.
    expect(text.startsWith("你好 世界")).toBe(true);
  });
});

describe("pickSubtitleFile", () => {
  it("prefers manual Traditional, then any zh, then any", () => {
    expect(pickSubtitleFile(["youtube.en.vtt", "youtube.zh-Hant.vtt", "youtube.zh-Hans.vtt"])?.lang).toBe("zh-hant");
    expect(pickSubtitleFile(["youtube.en.vtt", "youtube.zh-Hans.vtt"])?.lang).toBe("zh-hans");
    expect(pickSubtitleFile(["youtube.fr.vtt"])?.lang).toBe("fr");
    expect(pickSubtitleFile(["youtube.section.wav"])).toBeNull();
  });
});

describe("simplifiedToTraditional", () => {
  it("converts Simplified captions so they pass the strict zh-Hant gate", () => {
    const converted = simplifiedToTraditional("这个声音样本需要保持稳定，欢迎收看节目。");
    expect(converted).toContain("這");
    expect(converted).not.toContain("这");
    expect(strictTraditionalChineseScriptErrors(converted)).toHaveLength(0);
  });
});

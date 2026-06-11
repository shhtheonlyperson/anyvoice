import { describe, expect, it } from "vitest";
import {
  clampScanWindow,
  clampWindow,
  parseTimeParam,
  parseVtt,
  parseYoutubeUrl,
  pickSubtitleFile,
  planFixedSlices,
  planSegments,
  selectCuesText,
  simplifiedToTraditional,
  type VttCue,
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

describe("clampScanWindow", () => {
  it("defaults to a 180s scan window", () => {
    expect(clampScanWindow(100)).toEqual({ start: 100, end: 280 });
  });
  it("clamps the scan span to 30–300s", () => {
    expect(clampScanWindow(100, 10)).toEqual({ start: 100, end: 130 });
    expect(clampScanWindow(100, 600)).toEqual({ start: 100, end: 400 });
  });
});

describe("planSegments", () => {
  // 180s of evenly-spaced 6s cues starting at t=300.
  const cues: VttCue[] = Array.from({ length: 30 }, (_, i) => ({
    start: 300 + i * 6,
    end: 306 + i * 6,
    text: `句子${i + 1}`,
  }));

  it("chunks captions into several ~6–18s clips aligned to cue boundaries", () => {
    const segs = planSegments(cues, 300, 480);
    expect(segs.length).toBeGreaterThanOrEqual(5); // enough to clear the 5-clip bar
    for (const s of segs) {
      const dur = s.end - s.start;
      expect(dur).toBeGreaterThanOrEqual(6);
      expect(dur).toBeLessThanOrEqual(18);
      expect(s.text.length).toBeGreaterThan(0);
    }
    // Segments stay within the window and don't overlap.
    expect(segs[0].start).toBeGreaterThanOrEqual(300);
    expect(segs[segs.length - 1].end).toBeLessThanOrEqual(480);
  });

  it("drops rolling auto-caption duplicates within a clip", () => {
    const dupes: VttCue[] = [
      { start: 300, end: 305, text: "你好" },
      { start: 305, end: 310, text: "你好世界" },
      { start: 310, end: 316, text: "你好世界今天" },
    ];
    const segs = planSegments(dupes, 300, 320);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("你好世界今天");
  });

  it("returns [] when no cues overlap the window", () => {
    expect(planSegments(cues, 1000, 1100)).toEqual([]);
  });
});

describe("planFixedSlices", () => {
  it("splits a 90s window into ~6 slices in the 6–18s band", () => {
    const slices = planFixedSlices(90);
    expect(slices.length).toBeGreaterThanOrEqual(5);
    for (const s of slices) {
      expect(s.duration).toBeGreaterThanOrEqual(6);
      expect(s.duration).toBeLessThanOrEqual(18);
    }
    expect(slices[0].relStart).toBe(0);
  });
  it("returns [] for a sub-minimum span", () => {
    expect(planFixedSlices(3)).toEqual([]);
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

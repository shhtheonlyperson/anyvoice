import { describe, expect, it } from "vitest";
import { packSentences, segmentBook, splitSentences } from "@/lib/book-segment";

describe("splitSentences", () => {
  it("splits Traditional Chinese on 。！？", () => {
    expect(splitSentences("你好。今天天氣很好！你要去哪裡？")).toEqual([
      "你好。",
      "今天天氣很好！",
      "你要去哪裡？",
    ]);
  });

  it("splits English on . ! ? followed by space", () => {
    expect(splitSentences("Hello world. How are you? I am fine!")).toEqual([
      "Hello world.",
      "How are you?",
      "I am fine!",
    ]);
  });

  it("treats newlines as boundaries and drops blanks", () => {
    expect(splitSentences("第一段\n\n第二段")).toEqual(["第一段", "第二段"]);
  });
});

describe("packSentences", () => {
  it("merges short sentences up to minChars", () => {
    const packed = packSentences(["甲。", "乙。", "丙。"], { minChars: 10, maxChars: 50 });
    expect(packed).toEqual(["甲。 乙。 丙。"]);
  });

  it("never exceeds maxChars when packing", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `句子${i}。`);
    const packed = packSentences(sentences, { minChars: 1, maxChars: 8 });
    for (const seg of packed) expect(seg.length).toBeLessThanOrEqual(8);
    expect(packed.join("").replace(/\s/g, "")).toBe(sentences.join(""));
  });

  it("hard-splits a pathologically long sentence on commas", () => {
    const long = `${"一二三四五，".repeat(20)}結束。`;
    const packed = packSentences([long], { minChars: 10, maxChars: 30 });
    expect(packed.length).toBeGreaterThan(1);
    for (const seg of packed) expect(seg.length).toBeLessThanOrEqual(45);
  });
});

describe("segmentBook", () => {
  it("produces indexed segments with chapter offsets", () => {
    const book = segmentBook(
      [
        { title: "第一章", text: "你好。世界很大。" },
        { title: "", text: "第二章開始了。這是內容。" },
      ],
      { minChars: 1, maxChars: 200 },
    );
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0].title).toBe("第一章");
    expect(book.chapters[1].title).toBe("Chapter 2"); // fallback title
    expect(book.chapters[0].firstSegment).toBe(0);
    expect(book.chapters[1].firstSegment).toBe(book.chapters[0].segmentCount);
    // segments are globally indexed and tagged with their chapter
    book.segments.forEach((s, i) => expect(s.index).toBe(i));
    expect(book.segments[book.chapters[1].firstSegment].chapter).toBe(1);
  });
});

// Split a book into synthesis-sized segments.
//
// For progressive audiobook synthesis we want each segment to be ~1–2 sentences:
// short enough that the first one is ready quickly (fast time-to-first-audio),
// long enough to keep VoxCPM2 prosody natural and the segment count manageable
// for 50–100K-word books. We never split mid-sentence except for pathologically
// long sentences (fallback split on commas), to preserve intonation.

export interface BookChapterInput {
  title: string;
  text: string;
}

export interface BookChapter {
  index: number;
  title: string;
  /** index of the first segment belonging to this chapter */
  firstSegment: number;
  segmentCount: number;
}

export interface BookSegment {
  index: number;
  chapter: number;
  text: string;
}

export interface SegmentedBook {
  chapters: BookChapter[];
  segments: BookSegment[];
}

export interface SegmentOptions {
  /** flush a segment once it reaches this many characters */
  minChars?: number;
  /** never let a packed segment exceed this many characters */
  maxChars?: number;
}

const DEFAULTS: Required<SegmentOptions> = { minChars: 40, maxChars: 220 };

// Sentence terminators for Traditional Chinese + English, kept with the sentence.
const SENTENCE_BOUNDARY = /(?<=[。！？!?；;…])|(?<=[.!?](?=\s))/u;

/** Split a block of text into sentences (zh-Hant + English), trimming blanks. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const piece of line.split(SENTENCE_BOUNDARY)) {
      const s = piece.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Hard-split a sentence that is far longer than maxChars on comma-like pauses. */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars * 1.5) return [sentence];
  const parts: string[] = [];
  let buf = "";
  for (const piece of sentence.split(/(?<=[，,、])/u)) {
    if (buf && buf.length + piece.length > maxChars) {
      parts.push(buf.trim());
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [sentence];
}

/** Pack sentences into [minChars, maxChars] segments without splitting mid-sentence. */
export function packSentences(
  sentences: string[],
  options: SegmentOptions = {},
): string[] {
  const { minChars, maxChars } = { ...DEFAULTS, ...options };
  const segments: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = "";
  };

  for (const sentence of sentences) {
    for (const part of splitLongSentence(sentence, maxChars)) {
      if (!buf) {
        buf = part;
      } else if (buf.length + part.length + 1 <= maxChars) {
        buf = `${buf} ${part}`;
      } else {
        flush();
        buf = part;
      }
      if (buf.length >= minChars) flush();
    }
  }
  flush();
  return segments;
}

/** Turn extracted chapters into a flat, indexed segment list for synthesis. */
export function segmentBook(
  chapters: BookChapterInput[],
  options: SegmentOptions = {},
): SegmentedBook {
  const outChapters: BookChapter[] = [];
  const segments: BookSegment[] = [];

  chapters.forEach((chapter, chapterIndex) => {
    const firstSegment = segments.length;
    const packed = packSentences(splitSentences(chapter.text), options);
    for (const text of packed) {
      segments.push({ index: segments.length, chapter: chapterIndex, text });
    }
    outChapters.push({
      index: chapterIndex,
      title: chapter.title.trim() || `Chapter ${chapterIndex + 1}`,
      firstSegment,
      segmentCount: segments.length - firstSegment,
    });
  });

  return { chapters: outChapters, segments };
}

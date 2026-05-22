/* The 24-line guided build script — the heart of the in-browser
 * record-and-grade Build flow.
 *
 * Each line is one clip our existing enroll + analyzer already grades. The pack
 * extends VoiceCloneStudio's original 5-line SCRIPT_PACK to 24 lines that
 * broaden coverage across the analyzer's real coverage features (see
 * `detectVoiceProfileCoverageFeatures` in lib/text-prep):
 *
 *   - zh_hant            proven Traditional markers
 *   - numbers_dates      digits + CJK numerals with date/time units
 *   - latin_terms        Latin brand/place names
 *   - polyphones         重慶 / 銀行 / 角色 / 音樂 / 長樂 (the analyzer's preset set)
 *   - punctuation_rhythm commas / full stops / question marks for prosody
 *
 * Lines are tuned to the 6–20s readable band (the enroll duration gate). zh-Hant
 * is the default pack; an English parallel pack mirrors the same coverage so the
 * flow works in either locale. Per-line pronunciation cues mirror SCRIPT_CUES.
 */

import {
  detectVoiceProfileCoverageFeatures,
  type VoiceProfileCoverageFeature,
} from "@/lib/text-prep";

export type BuildScriptLocale = "zh-Hant" | "en";

export interface BuildScriptLine {
  /** 1-based line number shown in the dots / line list. */
  n: number;
  /** The line to read — sent verbatim as promptTranscript on enroll. */
  text: string;
  /** Latin terms / polyphones to watch, rendered as cue chips. */
  cues: string[];
}

/* zh-Hant — 24 lines, ordered easy → coverage-broadening. */
const ZH_LINES: Array<{ text: string; cues?: string[] }> = [
  { text: "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。" },
  { text: "我會用平常說話的速度，把每一句話清楚地讀完，盡量保持自然的呼吸與停頓。" },
  { text: "今天的天氣很好，午後的微風帶著淡淡花香，讓人想出門走走、曬曬太陽。" },
  { text: "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。" },
  { text: "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。" },
  { text: "日期範例是二零二六年五月二十日，星期三，上午九點十五分，我們準時開始。", cues: ["二零二六年", "九點十五分"] },
  { text: "會議室在三樓的第七號房間，預計進行四十五分鐘，大約十一點結束。", cues: ["三樓", "四十五分鐘"] },
  { text: "我買了三斤蘋果、兩公升牛奶，總共花了五百二十八元，找回七十二元。", cues: ["五百二十八元", "七十二元"] },
  { text: "這趟旅程從台北出發，先到紐約，再轉往倫敦，最後抵達東京。", cues: ["台北", "紐約", "倫敦", "東京"] },
  { text: "我常用的應用程式包括 AnyVoice、Notion 和 Spotify，介面都很乾淨。", cues: ["AnyVoice", "Notion", "Spotify"] },
  { text: "請把檔案命名為 report 2026，並寄到我的 email，主旨寫上 OK 就好。", cues: ["report", "email", "OK"] },
  { text: "她說她在 Google 工作，平常用 Python 寫程式，週末喜歡看 Netflix。", cues: ["Google", "Python", "Netflix"] },
  { text: "我們從重慶搭船順流而下，沿途的山水像一幅展開的畫。", cues: ["重慶"] },
  { text: "他在銀行上班，每天細心核對每一筆帳目，從不馬虎。", cues: ["銀行"] },
  { text: "在這齣戲裡，他扮演的角色既溫柔又堅強，讓觀眾印象深刻。", cues: ["角色"] },
  { text: "夜晚的廣場上播著輕快的音樂，孩子們圍著噴泉開心地跑來跑去。", cues: ["音樂"] },
  { text: "我的老家在福建長樂，那裡靠海，海風總是帶著鹹鹹的味道。", cues: ["長樂"] },
  { text: "你準備好了嗎？我們現在就出發，好不好？" },
  { text: "等一下！別忘了帶傘，外面好像快下雨了。" },
  { text: "如果可以的話，我希望能多陪陪家人，慢慢地、好好地過每一天。" },
  { text: "謝謝你一直以來的支持與陪伴，這對我來說，意義非常重大。" },
  { text: "讓我想想……嗯，這個問題其實沒有標準答案，要看當下的情況而定。" },
  { text: "無論晴天或雨天，無論順境或逆境，我都會堅持把這件事完成。" },
  { text: "最後，祝你有美好的一天，我們下次再見，保重！" },
];

/* English parallel pack — mirrors the same coverage buckets. */
const EN_LINES: Array<{ text: string; cues?: string[] }> = [
  { text: "Hello, I'm recording a short voice sample. The morning sun spreads across the lake while distant birdsong keeps the world calm and quiet." },
  { text: "I'll read every sentence clearly, at my normal speaking pace, keeping my breathing and pauses natural." },
  { text: "The weather is lovely today; an afternoon breeze carries a faint scent of flowers, and it makes me want to step outside." },
  { text: "Please make sure the room is quiet, avoid echo, and keep a comfortable distance from the microphone for a clean sound." },
  { text: "This recording includes pitch changes, pauses, and short phrases so the digital voice sounds closer to my everyday speech." },
  { text: "The date example is May the twentieth, twenty twenty-six, a Wednesday, and we begin promptly at nine fifteen in the morning.", cues: ["twenty twenty-six", "nine fifteen"] },
  { text: "The meeting room is number seven on the third floor; we expect it to run forty-five minutes and finish around eleven.", cues: ["number seven", "forty-five"] },
  { text: "I bought three pounds of apples and two liters of milk, spending five hundred twenty-eight in total, with seventy-two back.", cues: ["five hundred twenty-eight", "seventy-two"] },
  { text: "This trip starts in Taipei, stops in New York, transfers through London, and finally arrives in Tokyo.", cues: ["Taipei", "New York", "London", "Tokyo"] },
  { text: "The apps I use most are AnyVoice, Notion, and Spotify, and they all have a clean interface.", cues: ["AnyVoice", "Notion", "Spotify"] },
  { text: "Please name the file report 2026, send it to my email, and just write OK in the subject line.", cues: ["report", "email", "OK"] },
  { text: "She says she works at Google, writes code in Python, and likes watching Netflix on weekends.", cues: ["Google", "Python", "Netflix"] },
  { text: "We took a boat down the river from Chongqing, and the mountains and water unrolled like a painting.", cues: ["Chongqing"] },
  { text: "He works at a bank, carefully checking every entry in the ledger, and never cuts corners.", cues: ["bank"] },
  { text: "In this play, the character he portrays is both gentle and strong, leaving a deep impression on the audience.", cues: ["character"] },
  { text: "Cheerful music played across the night plaza while children chased each other happily around the fountain.", cues: ["music"] },
  { text: "My old home is in Changle, a coastal town where the sea breeze always carries a salty smell.", cues: ["Changle"] },
  { text: "Are you ready? Let's set off right now, shall we?" },
  { text: "Wait! Don't forget your umbrella — it looks like it's about to rain outside." },
  { text: "If I could, I'd love to spend more time with my family, taking each day slowly and well." },
  { text: "Thank you for your support and company all this time; it means a great deal to me." },
  { text: "Let me think… well, this question doesn't really have a standard answer; it depends on the situation." },
  { text: "Rain or shine, in good times or hard ones, I will see this through to the end." },
  { text: "Finally, I hope you have a wonderful day. See you next time, and take care!" },
];

function buildPack(lines: Array<{ text: string; cues?: string[] }>): BuildScriptLine[] {
  return lines.map((line, i) => ({ n: i + 1, text: line.text, cues: line.cues ?? [] }));
}

export const BUILD_SCRIPT_PACK: Record<BuildScriptLocale, BuildScriptLine[]> = {
  "zh-Hant": buildPack(ZH_LINES),
  en: buildPack(EN_LINES),
};

// Both locale packs must stay the same length (the line dots/donut count).
if (ZH_LINES.length !== EN_LINES.length) {
  throw new Error("build-script: zh-Hant and en packs must have the same number of lines");
}

/** Number of guided lines in the build script (derived to avoid drift). */
export const BUILD_LINE_COUNT = ZH_LINES.length;

/** All coverage feature buckets, in display order for the sidecar grid. */
export const COVERAGE_FEATURES: VoiceProfileCoverageFeature[] = [
  "zh_hant",
  "numbers_dates",
  "latin_terms",
  "polyphones",
  "punctuation_rhythm",
];

export interface CoverageBucket {
  feature: VoiceProfileCoverageFeature;
  /** How many recorded lines so far hit this coverage feature. */
  count: number;
  covered: boolean;
}

/**
 * Honest coverage derivation. We do NOT have a real IPA-40 phoneme grid in the
 * backend, so we approximate the handoff's phoneme sidecar with the analyzer's
 * REAL coverage features (lib/text-prep) detected on the transcripts of the
 * lines recorded so far. The grid is labelled "涵蓋面 / Coverage" rather than
 * faking phoneme data. A bucket is "covered" once any recorded line hits it.
 */
export function deriveCoverage(recordedTranscripts: string[]): CoverageBucket[] {
  const counts = new Map<VoiceProfileCoverageFeature, number>();
  for (const feature of COVERAGE_FEATURES) counts.set(feature, 0);
  for (const transcript of recordedTranscripts) {
    for (const feature of detectVoiceProfileCoverageFeatures(transcript)) {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    }
  }
  return COVERAGE_FEATURES.map((feature) => {
    const count = counts.get(feature) ?? 0;
    return { feature, count, covered: count > 0 };
  });
}

/** Map an analyzer grade to the line-list status the design renders. */
export function lineStatusFromGrade(grade: "A" | "B" | "C" | "D" | string | undefined): "pass" | "retry" {
  const g = (grade ?? "").toUpperCase();
  // A/B pass the enroll gate; C/D are rejected and must be re-recorded.
  return g === "A" || g === "B" ? "pass" : "retry";
}

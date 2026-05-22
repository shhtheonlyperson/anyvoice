/**
 * Mandarin phoneme coverage — deterministic, text-derived.
 *
 * WHAT THIS IS
 * ------------
 * Given the *transcripts* of the lines a user has recorded, this module reports
 * which Mandarin phonemes (initials 聲母 / finals 韻母 / tones 聲調) those lines
 * CONTAIN, measured against a canonical inventory. Coverage is computed purely
 * from text via `pinyin-pro` (pure-JS Han → pinyin, accurate, tone numbers).
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT audio-verified pronunciation. We do not run ASR or forced
 * alignment. "Covered" means "a recorded line's text includes a syllable using
 * this phoneme" — it does not assert the speaker actually voiced it correctly.
 * The per-clip audio-quality grade (A–D, from the enroll analyzer) remains the
 * separate, independent signal for *how well* a clip was spoken.
 *
 * INVENTORY
 * ---------
 * Standard Mandarin (Putonghua/Guoyu) pinyin inventory:
 *   - 21 initials (聲母): b p m f d t n l g k h j q x zh ch sh r z c s
 *     (plus the conventional "zero initial" ∅ for syllables that begin with a
 *      vowel/glide once the y/w spelling is normalised)
 *   - 37 finals (韻母): the monophthongs, diphthongs, nasal finals, the
 *     syllabic -i after zh/ch/sh/r and z/c/s, er, and the ü-series. (The bare
 *     interjection final ê — 欸/誒 — is excluded: pinyin-pro never emits it as a
 *     final, so a permanently-uncoverable cell would be dishonest.)
 *   - 5 tones (聲調): 1 2 3 4 + neutral (輕聲).
 *
 * DECOMPOSITION
 * -------------
 * pinyin-pro yields toneless-letter syllables with a trailing tone digit
 * (e.g. "zhong4", "yue4", "er2", "nv3", "de0"). We:
 *   1. split off the tone digit (0 = neutral),
 *   2. match the longest valid initial prefix (handles two-letter zh/ch/sh),
 *   3. normalise the remaining final from its *spelling* to its phonemic form:
 *      - zero-initial y/w glide spellings → underlying final
 *        (yi→i, ya→ia, ye→ie, yao→iao, you→iou, yan→ian, yin→in, yang→iang,
 *         ying→ing, yong→iong, yu→ü, yue→üe, yuan→üan, yun→ün,
 *         wu→u, wa→ua, wo→uo, wai→uai, wei→uei, wan→uan, wen→uen,
 *         wang→uang, weng→ueng),
 *      - the j/q/x + u spelling actually being ü (ju→jü etc.) and the literal
 *        "v"/"ü" pinyin-pro emits for nü/lü,
 *      - the syllabic -i after zh/ch/sh/r/z/c/s → the dedicated final "-i",
 *      - standalone er.
 *
 * Edge cases approximated (documented honestly):
 *   - "ng"/"n" as *finals* are folded into their parent finals (ang, eng, in,
 *     etc.) rather than tracked as separate coda phonemes — the inventory is
 *     final-level, which is the standard pinyin teaching unit.
 *   - We do not split the medial glide from the final (ian stays "ian", not
 *     i+an); again, final-level is the inventory granularity.
 *   - Erhua (兒化, e.g. 花兒) is not separately modelled; the base syllable plus
 *     a standalone "er" syllable both map to the "er" final.
 */

import { pinyin } from "pinyin-pro";

export type Tone = "1" | "2" | "3" | "4" | "neutral";

/** The 21 pinyin initials, plus the conventional zero-initial marker. */
export const INITIALS = [
  "b", "p", "m", "f",
  "d", "t", "n", "l",
  "g", "k", "h",
  "j", "q", "x",
  "zh", "ch", "sh", "r",
  "z", "c", "s",
  "∅",
] as const;
export type Initial = (typeof INITIALS)[number];

/** Two-letter initials must be tried before single letters when prefix-matching. */
const INITIAL_MATCH_ORDER: readonly string[] = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s",
];

/** The canonical phonemic finals (韻母). "i_" is the syllabic buzz vowel. */
export const FINALS = [
  // simple
  "a", "o", "e", "i", "u", "ü",
  // syllabic -i after zh/ch/sh/r/z/c/s (the "buzzing" vowel)
  "i_",
  // er
  "er",
  // -i diphthongs/nasals
  "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "ong",
  // i- series
  "ia", "ie", "iao", "iou", "ian", "in", "iang", "ing", "iong",
  // u- series
  "ua", "uo", "uai", "uei", "uan", "uen", "uang", "ueng",
  // ü- series
  "üe", "üan", "ün",
] as const;
export type Final = (typeof FINALS)[number];

export const TONES: readonly Tone[] = ["1", "2", "3", "4", "neutral"];

export interface SyllablePhonemes {
  initial: Initial;
  final: Final;
  tone: Tone;
}

const INITIAL_SET = new Set<string>(INITIALS);
const FINAL_SET = new Set<string>(FINALS);

/** Initials after which a bare "i" spelling is the syllabic buzz vowel. */
const BUZZ_INITIALS = new Set(["zh", "ch", "sh", "r", "z", "c", "s"]);

/**
 * Map a zero-initial (y/w) spelled final to its underlying phonemic final.
 * Keyed by the full toneless syllable letters when the initial is ∅.
 */
const ZERO_INITIAL_FINALS: Record<string, Final> = {
  // y- glide
  yi: "i", ya: "ia", ye: "ie", yao: "iao", you: "iou",
  yan: "ian", yin: "in", yang: "iang", ying: "ing", yong: "iong",
  yu: "ü", yue: "üe", yuan: "üan", yun: "ün",
  // w- glide
  wu: "u", wa: "ua", wo: "uo", wai: "uai", wei: "uei",
  wan: "uan", wen: "uen", wang: "uang", weng: "ueng",
  // bare vowel zero-initials
  a: "a", o: "o", e: "e",
  ai: "ai", ei: "ei", ao: "ao", ou: "ou",
  an: "an", en: "en", ang: "ang", eng: "eng",
  er: "er", n: "en", ng: "eng", // 嗯 interjection folded to -en/-eng (rare)
};

/**
 * Normalise the final spelling (after an initial has been stripped) to its
 * canonical phonemic final. `initial` is needed for context-sensitive cases.
 */
function normaliseFinal(initial: Initial, rawFinal: string): Final | null {
  let f = rawFinal;
  // pinyin-pro emits ü as "v" (or "u:" in some configs); we request v:true so it
  // is the literal "ü" already, but guard for "v" just in case.
  f = f.replace(/v/g, "ü");

  // Syllabic buzz vowel: zhi/chi/shi/ri/zi/ci/si → final "i_".
  if (f === "i" && BUZZ_INITIALS.has(initial)) return "i_";

  // j/q/x + u is phonemically ü (ju→jü, qu→qü, xu→xü, also -uan/-un/-ue).
  if (initial === "j" || initial === "q" || initial === "x") {
    if (f === "u") f = "ü";
    else if (f === "uan") f = "üan";
    else if (f === "un") f = "ün";
    else if (f === "ue") f = "üe";
  }

  // Spelling shorthands → canonical finals.
  const SPELL: Record<string, Final> = {
    un: "uen", // dun/lun spelling = -uen
    ui: "uei", // gui/hui spelling = -uei
    iu: "iou", // liu/jiu spelling = -iou
  };
  if (SPELL[f]) f = SPELL[f];

  if (FINAL_SET.has(f)) return f as Final;
  return null;
}

/**
 * Decompose ONE pinyin syllable (toneless letters + trailing tone digit, the
 * `toneType:"num"` form pinyin-pro emits, e.g. "zhong4", "yue4", "de0").
 * Returns null for input that is not a recognisable Han syllable.
 */
export function decomposeSyllable(syllable: string): SyllablePhonemes | null {
  if (!syllable) return null;
  const m = /^([a-zü]+)([0-4])?$/i.exec(syllable.trim().toLowerCase());
  if (!m) return null;
  const letters = m[1];
  const toneDigit = m[2];
  const tone: Tone = !toneDigit || toneDigit === "0" ? "neutral" : (toneDigit as Tone);

  // Zero-initial (y/w/bare vowel) syllables, matched whole.
  if (ZERO_INITIAL_FINALS[letters]) {
    const final = ZERO_INITIAL_FINALS[letters];
    if (!FINAL_SET.has(final)) return null;
    return { initial: "∅", final, tone };
  }

  // Longest valid initial prefix.
  let initial: Initial = "∅";
  let rest = letters;
  for (const cand of INITIAL_MATCH_ORDER) {
    if (letters.startsWith(cand) && letters.length > cand.length) {
      initial = cand as Initial;
      rest = letters.slice(cand.length);
      break;
    }
  }
  if (!INITIAL_SET.has(initial)) return null;

  const final = normaliseFinal(initial, rest);
  if (!final) return null;
  return { initial, final, tone };
}

export interface TextPhonemes {
  initials: Set<Initial>;
  finals: Set<Final>;
  tones: Set<Tone>;
}

/**
 * Phonemes present in a block of text. Non-Han (Latin, digits, punctuation) is
 * ignored gracefully via pinyin-pro's `nonZh:"removed"`.
 */
export function phonemesInText(text: string): TextPhonemes {
  const initials = new Set<Initial>();
  const finals = new Set<Final>();
  const tones = new Set<Tone>();
  if (!text) return { initials, finals, tones };

  let syllables: string[] = [];
  try {
    syllables = pinyin(text, {
      type: "array",
      toneType: "num",
      v: true,
      nonZh: "removed",
    });
  } catch {
    return { initials, finals, tones };
  }

  for (const syl of syllables) {
    const decomposed = decomposeSyllable(syl);
    if (!decomposed) continue;
    initials.add(decomposed.initial);
    finals.add(decomposed.final);
    tones.add(decomposed.tone);
  }
  return { initials, finals, tones };
}

export interface PhonemeCoverage {
  /** Initials covered (union across all texts), in inventory order. */
  initials: Initial[];
  /** Finals covered (union), in inventory order. */
  finals: Final[];
  /** Tones covered (union), in inventory order. */
  tones: Tone[];
  /** Total distinct phonemes covered (initials + finals + tones). */
  covered: number;
  /** Total size of the canonical inventory. */
  total: number;
  /** Phonemes still missing, split by kind, in inventory order. */
  missing: {
    initials: Initial[];
    finals: Final[];
    tones: Tone[];
  };
}

/** The full inventory size — initials + finals + tones. */
export const INVENTORY_TOTAL = INITIALS.length + FINALS.length + TONES.length;

/**
 * Coverage of the canonical inventory across the union of `texts`. Incremental:
 * passing more texts can only grow `covered`, never shrink it.
 */
export function coverageFromTexts(texts: string[]): PhonemeCoverage {
  const initials = new Set<Initial>();
  const finals = new Set<Final>();
  const tones = new Set<Tone>();
  for (const text of texts) {
    const p = phonemesInText(text);
    p.initials.forEach((i) => initials.add(i));
    p.finals.forEach((f) => finals.add(f));
    p.tones.forEach((tn) => tones.add(tn));
  }

  const coveredInitials = INITIALS.filter((i) => initials.has(i));
  const coveredFinals = FINALS.filter((f) => finals.has(f));
  const coveredTones = TONES.filter((tn) => tones.has(tn));

  return {
    initials: coveredInitials,
    finals: coveredFinals,
    tones: coveredTones,
    covered: coveredInitials.length + coveredFinals.length + coveredTones.length,
    total: INVENTORY_TOTAL,
    missing: {
      initials: INITIALS.filter((i) => !initials.has(i)),
      finals: FINALS.filter((f) => !finals.has(f)),
      tones: TONES.filter((tn) => !tones.has(tn)),
    },
  };
}

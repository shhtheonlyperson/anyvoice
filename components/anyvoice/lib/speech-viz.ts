/**
 * Pure speech-visualisation helpers ported verbatim from the handoff
 * (`src/components.jsx`). Single source of truth for the deterministic
 * waveform shape, the VoiceMark spoke amplitudes, and the quality verdict that
 * drives both the status-dot colour and the waveform colour.
 *
 * Framework-agnostic — no React, no DOM. Imported by the visual components.
 */

/** Deterministic pseudo-random generator seeded from an integer. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Speech-like waveform generator. Bakes syllable rhythm, word/punctuation
 * pauses and a phrase envelope into a deterministic bar array so visuals read
 * as recorded speech while staying stable across renders.
 */
export function speechBars(
  seed: number,
  barCount: number,
  text = "",
  duration: number | null = null,
): number[] {
  const rand = rng(seed || 1);
  let syllables: number;
  if (text) {
    const cjk = (text.match(/[㐀-鿿]/g) || []).length;
    const latinWords = (text.match(/[a-z']+/gi) || []).length;
    syllables = Math.max(4, cjk + Math.round(latinWords * 1.4));
  } else if (duration) {
    syllables = Math.max(4, Math.round(duration * 3.2));
  } else {
    syllables = Math.max(6, Math.round(barCount / 6));
  }

  const pauses: { pos: number; strength: number }[] = [];
  if (text) {
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const ch = text[i];
      if (/[,，、。.!?！？:]/.test(ch)) {
        const strength = /[。.!?！？]/.test(ch) ? 0.85 : 0.45;
        pauses.push({ pos: i / len, strength });
      }
    }
  } else {
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      pauses.push({ pos: 0.25 + (i + 1) * (0.6 / (n + 1)) + rand() * 0.1, strength: 0.55 });
    }
  }

  const syllCenters: number[] = [];
  for (let i = 0; i < syllables; i++) {
    const base = (i + 0.5) / syllables;
    const jitter = (rand() - 0.5) * (0.6 / syllables);
    syllCenters.push(Math.max(0, Math.min(1, base + jitter)));
  }
  const syllAmp = syllCenters.map(() => 0.55 + rand() * 0.45);
  const syllWidth = (1.0 / syllables) * 0.42;

  const bars = new Array<number>(barCount).fill(0);
  for (let b = 0; b < barCount; b++) {
    const x = b / (barCount - 1);
    const env = Math.min(
      1,
      Math.sin((Math.min(1, x / 0.12) * Math.PI) / 2),
      Math.sin((Math.min(1, (1 - x) / 0.18) * Math.PI) / 2),
    );
    let v = 0;
    for (let i = 0; i < syllCenters.length; i++) {
      const d = x - syllCenters[i];
      v += syllAmp[i] * Math.exp(-(d * d) / (2 * syllWidth * syllWidth));
    }
    for (let i = 0; i < pauses.length; i++) {
      const d = Math.abs(x - pauses[i].pos);
      if (d < 0.04) {
        const f = 1 - pauses[i].strength * (1 - d / 0.04);
        v *= f;
      }
    }
    v += (rand() - 0.5) * 0.08;
    bars[b] = Math.max(0.03, env * Math.min(1, v));
  }
  return bars;
}

export interface SpeechQuality {
  status: "pass" | "retry" | "fail";
  score: number;
  mean: number;
  peak: number;
  peakRatio: number;
  range: number;
}

/** Quality assessment that visually corresponds to the waveform. */
export function speechQuality(seed: number, text: string, duration: number | null): SpeechQuality {
  const bars = speechBars(seed, 60, text, duration);
  const mean = bars.reduce((a, b) => a + b, 0) / bars.length;
  const peak = Math.max(...bars);
  const minimum = Math.min(...bars);
  const peakRatio = peak / Math.max(0.01, mean);
  const range = peak - minimum;

  let score = 0.85;
  if (mean < 0.3) score -= 0.25;
  if (peakRatio > 3.4) score -= 0.2;
  if (range < 0.35) score -= 0.18;
  if (duration && (duration < 4 || duration > 22)) score -= 0.2;

  const rand = rng(seed || 1);
  score += (rand() - 0.5) * 0.12;
  score = Math.max(0, Math.min(1, score));

  let status: SpeechQuality["status"];
  if (score > 0.7) status = "pass";
  else if (score > 0.45) status = "retry";
  else status = "fail";

  return { status, score, mean, peak, peakRatio, range };
}

"use client";
/* Speech-shaped waveform components. StaticWaveform/MiniWaveform are pure;
   they render deterministically from the shared speech-viz helper. */
import { useMemo } from "react";
import { speechBars } from "./lib/speech-viz";

export function StaticWaveform({
  seed = 0x1234,
  bars = 80,
  height = 64,
  played = 0,
  dark = true,
  color,
  text = "",
  duration = null,
}: {
  seed?: number;
  bars?: number;
  height?: number;
  played?: number;
  dark?: boolean;
  color?: string;
  text?: string;
  duration?: number | null;
}) {
  const data = useMemo(() => speechBars(seed, bars, text, duration), [seed, bars, text, duration]);
  const playedIdx = Math.floor(played * bars);
  const baseColor = color || (dark ? "rgba(255,255,255,0.18)" : "var(--color-muted-soft)");
  return (
    <div className="waveform-strip" style={{ height }}>
      {data.map((v, i) => (
        <div
          key={i}
          className={`bar ${i < playedIdx ? "played" : ""} ${i === playedIdx ? "cursor" : ""}`}
          style={{
            height: `${Math.max(8, v * 100)}%`,
            background: i < playedIdx ? "var(--color-primary)" : i === playedIdx ? "#fff" : baseColor,
          }}
        />
      ))}
    </div>
  );
}

export function MiniWaveform({
  seed = 0x1234,
  bars = 22,
  height = 28,
  text = "",
  duration = null,
  color,
}: {
  seed?: number;
  bars?: number;
  height?: number;
  text?: string;
  duration?: number | null;
  color?: string;
}) {
  const data = useMemo(() => speechBars(seed, bars, text, duration), [seed, bars, text, duration]);
  return (
    <div className="recent-mini-waveform" style={{ height }}>
      {data.map((v, i) => (
        <div key={i} className="bar" style={{ height: `${Math.max(12, v * 100)}%`, background: color || undefined }} />
      ))}
    </div>
  );
}

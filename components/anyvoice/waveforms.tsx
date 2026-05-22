"use client";
/* Speech-shaped waveform components. StaticWaveform/MiniWaveform are pure;
   they render deterministically from the shared speech-viz helper.
   LiveWaveform animates (used in the importing card). Donut is a coverage ring. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/** Animated speech-like waveform — used in the importing card while a real
    request is in flight. Layers three sine fronts with a slow phrase envelope. */
export function LiveWaveform({
  active = true,
  bars = 80,
  height = 88,
  color = "var(--color-primary)",
}: {
  active?: boolean;
  bars?: number;
  height?: number;
  color?: string;
}) {
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let last = performance.now();
    const step = (now: number) => {
      setTick((prev) => prev + (now - last) * 0.0042);
      last = now;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  const data = useMemo(() => {
    const arr = new Array<number>(bars).fill(0);
    for (let i = 0; i < bars; i++) {
      const x = i / (bars - 1);
      const s1 = Math.sin(tick * 6 - i * 0.45) * 0.5 + 0.5;
      const s2 = Math.sin(tick * 3.2 - i * 0.7 + 1.2) * 0.5 + 0.5;
      const s3 = Math.sin(tick * 9.1 - i * 0.22) * 0.4 + 0.5;
      let v = (s1 * 0.6 + s2 * 0.5) * s3;
      const phrase = 0.55 + 0.45 * (Math.sin(tick * 0.8) * 0.5 + 0.5);
      v *= phrase;
      const env = Math.min(
        1,
        Math.sin((Math.min(1, x / 0.05) * Math.PI) / 2),
        Math.sin((Math.min(1, (1 - x) / 0.05) * Math.PI) / 2),
      );
      arr[i] = Math.max(0.06, env * v);
    }
    return arr;
  }, [tick, bars]);

  return (
    <div className="waveform-strip" style={{ height }}>
      {data.map((v, i) => (
        <div
          key={i}
          className="bar"
          style={{
            height: `${Math.max(6, v * 100)}%`,
            background: active ? color : "rgba(255,255,255,0.18)",
            transition: "height 80ms ease-out",
          }}
        />
      ))}
    </div>
  );
}

/** SVG coverage donut. */
export function Donut({
  value = 0,
  size = 64,
  stroke = 6,
  color = "var(--color-primary)",
  track = "rgba(255,255,255,0.18)",
  label,
}: {
  value?: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  label?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * Math.max(0, Math.min(1, value));
  return (
    <div className="coverage-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 350ms ease-out" }}
        />
      </svg>
      {label !== undefined && <div className="pct">{label}</div>}
    </div>
  );
}

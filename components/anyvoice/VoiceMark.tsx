/* VoiceMark — deterministic radial bar fingerprint per voice.
   36 spokes seeded from the voice's persisted `hash`; colour by status.
   Pure render, no hooks needed beyond memoising the spoke amplitudes. */
import { useMemo } from "react";
import { rng } from "./lib/speech-viz";
import type { VoiceStatus } from "./i18n";

export function VoiceMark({
  hash = 0x4a7d,
  size = 32,
  status = "ready",
  color,
  dim = false,
}: {
  hash?: number;
  size?: number;
  status?: VoiceStatus;
  color?: string;
  dim?: boolean;
}) {
  const bars = 36;
  const amps = useMemo(() => {
    const rand = rng(hash || 1);
    return new Array(bars).fill(0).map(() => 0.35 + rand() * 0.65);
  }, [hash]);
  const cx = size / 2;
  const cy = size / 2;
  const inner = size * 0.22;
  const outer = size * 0.46;
  const c =
    color ||
    (status === "ready"
      ? "var(--color-primary)"
      : status === "building" || status === "importing"
        ? "var(--color-accent-amber)"
        : "var(--color-muted-soft)");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }} aria-hidden="true">
      <g style={{ opacity: dim ? 0.4 : 1 }}>
        {amps.map((amp, i) => {
          const a = (i / bars) * Math.PI * 2;
          const len = inner + (outer - inner) * amp;
          // Round to fixed precision so server and client render byte-identical
          // coords (raw float formatting differs between them → hydration warning).
          const r = (n: number) => Number(n.toFixed(3));
          const x1 = r(cx + Math.cos(a) * inner);
          const y1 = r(cy + Math.sin(a) * inner);
          const x2 = r(cx + Math.cos(a) * len);
          const y2 = r(cy + Math.sin(a) * len);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1.5} strokeLinecap="round" />;
        })}
      </g>
    </svg>
  );
}

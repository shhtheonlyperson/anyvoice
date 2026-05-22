"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { strictTraditionalChineseScriptErrors } from "@/lib/text-prep";
import { useLang, useT, type VoiceView } from "./i18n";
import { VoiceMark } from "./VoiceMark";
import { MiniWaveform, StaticWaveform } from "./waveforms";
import {
  IcChevronDown,
  IcCheck,
  IcClock,
  IcCopy,
  IcDots,
  IcDownload,
  IcPause,
  IcPlay,
  IcRotate,
  IcShare,
  IcSparkles,
  IcVolume,
} from "./icons";
import { fetchRuns, generateFromProfile, type RunItem } from "./lib/anyvoice-client";

/** Stable per-run seed so the waveform shape is consistent across renders. */
function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (h >>> 0) & 0xffff;
}

function isUnstableChineseScript(text: string): boolean {
  if (!text.trim()) return false;
  const errors = strictTraditionalChineseScriptErrors(text);
  return errors.includes("invalid_chinese_script") || errors.includes("unproven_chinese_script");
}

interface ResultGen {
  id: string;
  text: string;
  voiceName: string;
  voiceHash: number;
  duration: number;
  audioUrl?: string;
  seed: number;
}

function Dial({
  label,
  value,
  onChange,
  fmt,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
  title?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const onPointer = (e: React.PointerEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const apply = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const x = (clientX - r.left) / r.width;
      const snapped = Math.round(Math.max(0, Math.min(1, x)) / 0.05) * 0.05;
      onChange(Math.max(0, Math.min(1, snapped)));
    };
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    apply(e.clientX);
  };
  return (
    <div className="dial" title={title}>
      <span className="dial-label">{label}</span>
      <div className="dial-track" ref={trackRef} onPointerDown={onPointer}>
        <div className="dial-fill" style={{ width: `${value * 100}%` }} />
        <div className="dial-handle" style={{ left: `${value * 100}%` }} />
      </div>
      <span className="dial-val">{fmt(value)}</span>
    </div>
  );
}

function VoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: VoiceView[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ready = voices.filter((v) => v.status === "ready");
  const v = voices.find((x) => x.id === value) || ready[0] || voices[0];
  return (
    <div style={{ position: "relative" }}>
      <button className="voice-pill" onClick={() => setOpen((o) => !o)} type="button">
        <div className="vm-wrap" style={{ position: "relative" }}>
          <VoiceMark hash={v?.hash ?? 0x4a7d} size={22} status={v?.status ?? "empty"} />
        </div>
        <span>{v?.name ?? t("gen.picker.noneReady")}</span>
        <IcChevronDown size={14} />
      </button>
      {open && (
        <div className="voice-pop">
          {ready.length === 0 && (
            <div className="voice-pop-item" style={{ cursor: "default" }}>
              <span />
              <span className="sub">{t("gen.picker.noneReady")}</span>
              <span />
            </div>
          )}
          {ready.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`voice-pop-item ${x.id === value ? "active" : ""}`}
              onClick={() => {
                onChange(x.id);
                setOpen(false);
              }}
            >
              <VoiceMark hash={x.hash} size={24} status={x.status} />
              <div>
                <div className="nm">{x.name}</div>
              </div>
              {x.id === value && <IcCheck size={14} style={{ color: "var(--color-primary)" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function ResultPlayer({ gen, onRegenerate, onDownload, onShare }: {
  gen: ResultGen;
  onRegenerate: () => void;
  onDownload: () => void;
  onShare: () => void;
}) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [dur, setDur] = useState(gen.duration);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset playback when a new result loads
    setPos(0);
    setPlaying(false);
  }, [gen.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, gen.id]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.playbackRate = speed;
      void a.play();
      setPlaying(true);
    }
  };

  const played = dur > 0 ? pos / dur : 0;
  return (
    <div className="player">
      {gen.audioUrl && (
        <audio
          ref={audioRef}
          src={gen.audioUrl}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = (e.target as HTMLAudioElement).duration;
            if (Number.isFinite(d) && d > 0) setDur(d);
          }}
          onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
        />
      )}
      <div className="player-head">
        <div className="row gap-12">
          <span className="player-eyebrow">{t("gen.result")}</span>
          <div className="row gap-8" style={{ color: "var(--color-on-dark)" }}>
            <VoiceMark hash={gen.voiceHash} size={18} />
            <span style={{ fontSize: 13 }}>{gen.voiceName}</span>
          </div>
        </div>
        <div className="player-time">
          {fmtTime(pos)} / {fmtTime(dur)}
        </div>
      </div>
      <StaticWaveform seed={gen.seed} bars={120} height={76} played={played} dark text={gen.text} duration={dur} />
      <div className="player-controls">
        <div className="player-controls-left">
          <button className="play-btn" onClick={toggle} disabled={!gen.audioUrl} type="button">
            {playing ? <IcPause size={18} /> : <IcPlay size={18} />}
          </button>
          <div className="speed-group">
            {[1, 1.25, 1.5, 2].map((s) => (
              <button
                key={s}
                type="button"
                className={`speed-btn ${speed === s ? "active" : ""}`}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
        <div className="player-controls-right">
          <button className="dark-icon-btn" title="Volume" type="button">
            <IcVolume size={16} />
          </button>
          <button className="dark-link-btn" onClick={onShare} type="button">
            <IcShare size={14} />
            Share
          </button>
          <a
            className="dark-link-btn"
            href={gen.audioUrl ? `${gen.audioUrl}?format=wav` : undefined}
            onClick={onDownload}
            aria-disabled={!gen.audioUrl}
          >
            <IcDownload size={14} />
            {t("gen.btn.wav")}
          </a>
          <button
            type="button"
            onClick={onRegenerate}
            className="btn"
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "var(--color-on-dark)",
              height: 36,
              padding: "0 14px",
            }}
          >
            <IcRotate size={14} />
            {t("gen.btn.regenerate")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecentRow({ run, voices, onPlay, onCopy }: {
  run: RunItem;
  voices: VoiceView[];
  onPlay: (r: RunItem) => void;
  onCopy: (r: RunItem) => void;
}) {
  const v = voices.find((x) => x.name === run.voiceName);
  const seed = seedFromId(run.id);
  const ts = new Date(run.createdAt);
  const tsLabel = Number.isNaN(ts.getTime()) ? "" : ts.toLocaleString();
  return (
    <div className="recent-row" onClick={() => onPlay(run)}>
      <button
        className="dark-icon-btn"
        style={{ background: "var(--color-surface-soft)", color: "var(--color-ink)" }}
        type="button"
      >
        <IcPlay size={14} />
      </button>
      <div style={{ minWidth: 0 }}>
        <div className="recent-text">{run.targetText}</div>
        <div className="recent-meta">
          <span className="row gap-6">
            <VoiceMark hash={v?.hash ?? 0x4a7d} size={14} status={v?.status ?? "ready"} /> {run.voiceName}
          </span>
          <span className="dot" />
          <span>{tsLabel}</span>
        </div>
      </div>
      <div className="row gap-2">
        <MiniWaveform seed={seed} bars={22} height={24} text={run.targetText} />
        <div className="recent-actions">
          <button
            className="icon-btn"
            title="Copy text"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(run);
            }}
          >
            <IcCopy size={14} />
          </button>
          <button className="icon-btn" title="More" type="button" onClick={(e) => e.stopPropagation()}>
            <IcDots size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function GenerateTab({
  voices,
  activeVoiceId,
  onToast,
}: {
  voices: VoiceView[];
  activeVoiceId: string | null;
  onToast: (msg: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const readyVoices = useMemo(() => voices.filter((v) => v.status === "ready"), [voices]);

  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [pace, setPace] = useState(0.5);
  const [warmth, setWarmth] = useState(0.6);
  const [breaths, setBreaths] = useState(0.4);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ResultGen | null>(null);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [progress, setProgress] = useState<string>("");

  // Default the picker to the active rail voice (if ready), else first ready voice.
  useEffect(() => {
    const activeReady = readyVoices.find((v) => v.id === activeVoiceId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default the picker to the active rail voice
    setVoiceId((cur) => cur ?? activeReady?.id ?? readyVoices[0]?.id ?? null);
  }, [activeVoiceId, readyVoices]);

  const loadRuns = async () => setRuns(await fetchRuns(12));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async run-history load on mount
    void loadRuns();
  }, []);

  const scriptBlocked = isUnstableChineseScript(text);
  const charCount = text.length;
  const estSec = Math.max(3, Math.round(charCount / 12));
  const genDisabled = generating || !text.trim() || !voiceId || scriptBlocked;

  const dialTip = t("gen.dial.uiOnly");

  async function onGenerate() {
    if (genDisabled || !voiceId) return;
    setGenerating(true);
    setProgress("");
    const picked = voices.find((v) => v.id === voiceId);
    try {
      const res = await generateFromProfile({ profileId: voiceId, targetText: text }, (phase, done, total) => {
        setProgress(done && total ? `${done}/${total}` : phase);
      });
      if (res.status === "ready" && res.audioUrl) {
        const id = res.jobId || `gen_${Date.now()}`;
        setResult({
          id,
          text,
          voiceName: picked?.name ?? "",
          voiceHash: picked?.hash ?? 0x4a7d,
          duration: estSec,
          audioUrl: res.audioUrl,
          seed: seedFromId(id),
        });
        await loadRuns();
      } else {
        onToast(res.message || t("gen.error"));
      }
    } catch {
      onToast(t("gen.error"));
    } finally {
      setGenerating(false);
      setProgress("");
    }
  }

  function onRowPlay(r: RunItem) {
    setResult({
      id: r.id,
      text: r.targetText,
      voiceName: r.voiceName,
      voiceHash: voices.find((v) => v.name === r.voiceName)?.hash ?? 0x4a7d,
      duration: 8,
      audioUrl: r.audioUrl,
      seed: seedFromId(r.id),
    });
  }

  return (
    <div className="page-inner">
      <div className="eyebrow">{t("gen.eyebrow")}</div>
      <h1 className="page-title">{t("gen.title")}</h1>
      <p className="page-lede">{t("gen.lede")}</p>

      {readyVoices.length === 0 && (
        <p className="page-lede" style={{ color: "var(--color-warning)", marginTop: 12 }}>
          {t("gen.noVoiceReady")}
        </p>
      )}

      <div className="compose-shell mt-32">
        <div className="compose-input-wrap">
          <textarea
            className="compose-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("gen.placeholder")}
            rows={3}
          />
        </div>
        <div className="compose-toolbar">
          <div className="compose-tools-left">
            <VoicePicker voices={voices} value={voiceId} onChange={setVoiceId} />
            <Dial
              label={t("gen.dial.pace")}
              value={pace}
              onChange={setPace}
              title={dialTip}
              fmt={(v) => (v < 0.4 ? t("gen.pace.slow") : v > 0.6 ? t("gen.pace.brisk") : t("gen.pace.natural"))}
            />
            <Dial
              label={t("gen.dial.warmth")}
              value={warmth}
              onChange={setWarmth}
              title={dialTip}
              fmt={(v) => (v < 0.4 ? t("gen.warmth.cool") : v > 0.7 ? t("gen.warmth.warm") : t("gen.warmth.even"))}
            />
            <Dial
              label={t("gen.dial.breaths")}
              value={breaths}
              onChange={setBreaths}
              title={dialTip}
              fmt={(v) => `${(v * 0.8).toFixed(2)}s`}
            />
          </div>
          <div className="row gap-12">
            <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
              {t("gen.charCount", { n: charCount, s: estSec })}
            </span>
            <button className="btn btn--primary" onClick={onGenerate} disabled={genDisabled} type="button">
              <IcSparkles size={14} />
              {generating ? `${t("gen.btn.generating")}${progress ? ` ${progress}` : ""}` : t("gen.btn.generate")}
            </button>
          </div>
        </div>
      </div>

      {scriptBlocked && (
        <p className="page-lede" style={{ color: "var(--color-error)", marginTop: 12 }}>
          {t("gen.scriptBlocked")}
        </p>
      )}

      {result && (
        <div className="mt-24">
          <ResultPlayer
            gen={result}
            onRegenerate={onGenerate}
            onDownload={() => onToast(t("gen.toast.download"))}
            onShare={() => onToast(t("gen.toast.deferred"))}
          />
        </div>
      )}

      <div className="subtabs">
        <button className="subtab active" type="button">
          {t("gen.subtab.recent")}
        </button>
        <button className="subtab" type="button" onClick={() => onToast(t("gen.toast.deferred"))}>
          {t("gen.subtab.favorites")}
        </button>
        <button className="subtab" type="button" onClick={() => onToast(t("gen.toast.deferred"))}>
          {t("gen.subtab.shared")}
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        {runs.map((r) => (
          <RecentRow key={r.id} run={r} voices={voices} onPlay={onRowPlay} onCopy={(x) => {
            setText(x.targetText);
            onToast(t("gen.toast.textCopied"));
          }} />
        ))}
        {runs.length === 0 && (
          <div className="empty-zone">
            <div className="ill">
              <IcClock size={24} />
            </div>
            <h3>{t("gen.empty.title")}</h3>
            <p>{t("gen.empty.sub")}</p>
          </div>
        )}
      </div>
      <span aria-hidden style={{ display: "none" }}>{lang}</span>
    </div>
  );
}

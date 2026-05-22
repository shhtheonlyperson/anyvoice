"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IcChevronLeft,
  IcDownload,
  IcPause,
  IcPlay,
  IcRotate,
  IcShare,
  IcSkipBack,
  IcSkipForward,
  IcUpload,
  SpikeIcon,
} from "@/components/anyvoice/icons";
import { StaticWaveform } from "@/components/anyvoice/waveforms";

type Locale = "zh-Hant" | "en";

interface Chapter {
  index: number;
  title: string;
  kind: "chapter" | "extra";
  firstSegment: number;
  segmentCount: number;
}
interface BookMeta {
  id: string;
  title: string;
  segmentCount: number;
  chapters: Chapter[];
}
type SegStatus = "pending" | "done" | "error";
interface Progress {
  status: "synthesizing" | "paused" | "done" | "error";
  statuses: SegStatus[];
  done: number;
  errors: number;
  focusChapter: number | null;
  autoResume: boolean;
}
interface BookListItem extends BookMeta {
  progress: Progress | null;
}

const SPEEDS = [1, 1.25, 1.5, 2] as const;

const COPY: Record<Locale, Record<string, string>> = {
  "zh-Hant": {
    eyebrow: "有聲書",
    h1: "把書讀成有聲書",
    lede: "上傳 EPUB 或 PDF，用你的聲音逐段合成。第一段好了就能開始聽，其餘在背景繼續產生。",
    upload: "上傳 EPUB / PDF",
    uploadSub: "EPUB 或 PDF · 用你的聲音逐段合成",
    uploading: "處理中…",
    inProgress: "進行中",
    empty: "還沒有書，先上傳一本。",
    back: "返回書架",
    play: "播放",
    pause: "暫停",
    prev: "上一段",
    next: "下一段",
    waiting: "等待這一段合成…",
    synthing: "背景合成中",
    paused: "已暫停合成",
    doneStatus: "已全部合成",
    errored: "部分段落失敗",
    pauseSynth: "暫停合成",
    resumeSynth: "繼續合成",
    progress: "合成進度",
    chapters: "章節",
    speed: "速度",
    needProfile: "請先建立你的聲音，才能朗讀書籍。",
    deleteBook: "刪除",
    synthingNow: "合成中",
    onDemand: "點擊合成",
    extraBadge: "附錄",
    etaPrefix: "預估剩餘約",
    autoOn: "自動繼續：開",
    autoOff: "自動繼續：關",
    queueTitle: "生成佇列",
    queued: "排隊中",
    ready: "已就緒",
    nowPlaying: "正在播放",
    badgeReady: "{n} 章已就緒",
    badgeQueued: "{n} 章排隊中",
  },
  en: {
    eyebrow: "Audiobook",
    h1: "Turn a book into an audiobook",
    lede: "Upload an EPUB or PDF and synthesize it in your voice, segment by segment. Start listening as soon as the first piece is ready while the rest generates in the background.",
    upload: "Upload EPUB / PDF",
    uploadSub: "EPUB or PDF · synthesized in your voice",
    uploading: "Processing…",
    inProgress: "In progress",
    empty: "No books yet — upload one to start.",
    back: "Back to shelf",
    play: "Play",
    pause: "Pause",
    prev: "Previous",
    next: "Next",
    waiting: "Waiting for this part to synthesize…",
    synthing: "Synthesizing in background",
    paused: "Synthesis paused",
    doneStatus: "Fully synthesized",
    errored: "Some segments failed",
    pauseSynth: "Pause synthesis",
    resumeSynth: "Resume synthesis",
    progress: "Progress",
    chapters: "Chapters",
    speed: "Speed",
    needProfile: "Build your voice first to read books aloud.",
    deleteBook: "Delete",
    synthingNow: "Synthesizing",
    onDemand: "Tap to synthesize",
    extraBadge: "Extra",
    etaPrefix: "~",
    autoOn: "Auto-resume: on",
    autoOff: "Auto-resume: off",
    queueTitle: "Generation queue",
    queued: "Queued",
    ready: "Ready",
    nowPlaying: "Now playing",
    badgeReady: "{n} chapters ready",
    badgeQueued: "{n} chapters queued",
  },
};

function formatEta(sec: number, locale: Locale): string {
  if (sec < 60) return locale === "en" ? `${sec}s left` : `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return locale === "en" ? `~${min} min left` : `${min} 分鐘`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return locale === "en" ? `~${h}h ${m}m left` : `${h} 小時 ${m} 分`;
}

/** Per-chapter rollup from real progress statuses. */
function chapterRollup(progress: Progress | null, meta: BookMeta | null, c: Chapter) {
  const slice = progress?.statuses.slice(c.firstSegment, c.firstSegment + c.segmentCount) ?? [];
  const done = slice.filter((s) => s === "done").length;
  const pending = slice.filter((s) => s === "pending").length;
  const errored = slice.filter((s) => s === "error").length;
  const total = c.segmentCount || 1;
  const pct = Math.round((done / total) * 100);
  // status enum aligned to the design skin: ready | gen | queued
  let status: "ready" | "gen" | "queued" = "queued";
  if (done + errored >= c.segmentCount) status = "ready";
  else if (
    progress?.status === "synthesizing" &&
    pending > 0 &&
    (progress.focusChapter === c.index ||
      (progress.focusChapter == null && c.kind === "chapter" && done > 0) ||
      done > 0)
  ) {
    status = "gen";
  }
  return { done, pending, errored, pct, status };
}

export function BookReader({
  locale,
  profileReady,
  profileId,
}: {
  locale: Locale;
  profileReady: boolean;
  profileId: string;
}) {
  const t = (k: string, vars?: Record<string, string | number>) => {
    const raw = COPY[locale][k] ?? k;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, key: string) => (vars[key] !== undefined ? String(vars[key]) : `{${key}}`));
  };
  const [books, setBooks] = useState<BookListItem[]>([]);
  const [view, setView] = useState<"list" | "reader">("list");
  const [meta, setMeta] = useState<BookMeta | null>(null);
  const [segments, setSegments] = useState<{ index: number; text: string }[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [playIndex, setPlayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const segUrl = (i: number) => `/api/books/${meta?.id}/segments/${i}`;

  const loadBooks = useCallback(async () => {
    try {
      const res = await fetch("/api/books", { cache: "no-store" });
      if (res.ok) setBooks((await res.json()).books ?? []);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async list load + hydration after mount
    void loadBooks();
    try {
      const s = Number(window.localStorage.getItem("anyvoice:speed"));
      if (SPEEDS.includes(s as (typeof SPEEDS)[number])) setSpeed(s);
    } catch {
      /* ignore */
    }
  }, [loadBooks]);

  async function openBook(id: string) {
    const res = await fetch(`/api/books/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setMeta(data.book);
    setSegments(data.segments ?? []);
    setProgress(data.progress);
    setEta(data.eta ?? null);
    // Start at the first main chapter (skip front-matter extras).
    const firstMain = (data.book.chapters as Chapter[]).find((c) => c.kind === "chapter");
    setPlayIndex(firstMain ? firstMain.firstSegment : 0);
    setPlaying(false);
    setView("reader");
  }

  async function focusChapter(c: Chapter) {
    if (!meta) return;
    setPlayIndex(c.firstSegment);
    setPlaying(true);
    const res = await fetch(`/api/books/${meta.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "focus", chapter: c.index }),
    });
    if (res.ok) {
      const data = await res.json();
      setProgress(data.progress);
      setEta(data.eta ?? null);
    }
  }

  // Poll progress while the reader is open and work is ongoing.
  useEffect(() => {
    if (view !== "reader" || !meta) return;
    const id = meta.id;
    const tick = async () => {
      try {
        const res = await fetch(`/api/books/${id}/control`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setProgress(data.progress);
          setEta(data.eta ?? null);
        }
      } catch {
        /* ignore */
      }
    };
    const handle = window.setInterval(tick, 2500);
    return () => window.clearInterval(handle);
  }, [view, meta]);

  // Drive playback: play done segments, wait on pending, skip errored.
  const curStatus = progress?.statuses[playIndex];
  useEffect(() => {
    if (!playing || !meta) return;
    if (curStatus === "done") {
      const a = audioRef.current;
      if (a) {
        a.src = segUrl(playIndex);
        a.playbackRate = speed;
        void a.play().catch(() => {});
      }
    } else if (curStatus === "error") {
      // skip a failed segment so playback isn't stuck
      // eslint-disable-next-line react-hooks/set-state-in-effect -- advance past errored segment
      if (playIndex + 1 < meta.segmentCount) setPlayIndex((i) => i + 1);
      else setPlaying(false);
    }
    // pending: do nothing; the poll updates progress and re-runs this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playIndex, curStatus, speed, meta]);

  function onEnded() {
    if (meta && playIndex + 1 < meta.segmentCount) setPlayIndex((i) => i + 1);
    else setPlaying(false);
  }

  async function upload(file: File) {
    setError("");
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("profileId", profileId);
      const res = await fetch("/api/books", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "upload failed");
        return;
      }
      await loadBooks();
      await openBook(data.book.id);
    } catch {
      setError("upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function control(body: { action: string; enabled?: boolean }) {
    if (!meta) return;
    const res = await fetch(`/api/books/${meta.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      setProgress(data.progress);
      setEta(data.eta ?? null);
    }
  }

  async function removeBook(id: string) {
    await fetch(`/api/books/${id}`, { method: "DELETE" });
    await loadBooks();
  }

  function setSpeedPersist(s: number) {
    setSpeed(s);
    if (audioRef.current) audioRef.current.playbackRate = s;
    try {
      window.localStorage.setItem("anyvoice:speed", String(s));
    } catch {
      /* ignore */
    }
  }

  function togglePlay() {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
    } else {
      setPlaying(true);
    }
  }

  // ---------------- Profile gate ----------------
  if (!profileReady) {
    return (
      <div className="page-inner wide">
        <div className="eyebrow">{t("eyebrow")}</div>
        <h1 className="page-title md">{t("h1")}</h1>
        <p className="page-lede">{t("needProfile")}</p>
      </div>
    );
  }

  // ---------------- Library ----------------
  if (view === "list") {
    return (
      <div className="page-inner wide">
        <div className="eyebrow">{t("eyebrow")}</div>
        <h1 className="page-title md">{t("h1")}</h1>
        <p className="page-lede">{t("lede")}</p>

        {error && (
          <p className="notice notice--error" style={{ marginTop: 16 }}>
            {error}
          </p>
        )}

        <h6 className="section-label" style={{ margin: "40px 0 14px" }}>
          {t("inProgress")}
        </h6>
        <div className="book-grid">
          {books.map((b) => {
            const done = b.progress?.done ?? 0;
            const pct = b.segmentCount ? done / b.segmentCount : 0;
            return (
              <div className="book-card" key={b.id}>
                <button
                  type="button"
                  className="book-cover"
                  onClick={() => openBook(b.id)}
                  aria-label={b.title}
                >
                  <SpikeIcon className="book-cover-mark" />
                  <div className="title-zh">{b.title}</div>
                </button>
                <div>
                  <div className="book-title">{b.title}</div>
                </div>
                <div>
                  <div className="progress-bar">
                    <div className="fill" style={{ width: `${Math.round(pct * 100)}%` }} />
                  </div>
                  <div className="progress-meta mt-8">
                    <span>
                      {done} / {b.segmentCount}
                    </span>
                    <span>{Math.round(pct * 100)}%</span>
                  </div>
                  <button type="button" className="link small book-delete" onClick={() => removeBook(b.id)}>
                    {t("deleteBook")}
                  </button>
                </div>
              </div>
            );
          })}

          <label className="book-upload-card" aria-disabled={uploading}>
            <IcUpload size={20} />
            <div className="bu-title">{uploading ? t("uploading") : t("upload")}</div>
            <div className="bu-sub">{t("uploadSub")}</div>
            <input
              type="file"
              accept=".epub,.pdf,application/epub+zip,application/pdf"
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        </div>

        {books.length === 0 && (
          <p className="muted small" style={{ marginTop: 20 }}>
            {t("empty")}
          </p>
        )}
      </div>
    );
  }

  // ---------------- Reader ----------------
  const done = progress?.done ?? 0;
  const pct = meta?.segmentCount ? Math.round((done / meta.segmentCount) * 100) : 0;
  const statusLabel =
    progress?.status === "paused"
      ? t("paused")
      : progress?.status === "done"
        ? t("doneStatus")
        : progress?.status === "error"
          ? t("errored")
          : t("synthing");
  const currentChapter = meta?.chapters.find(
    (c) => playIndex >= c.firstSegment && playIndex < c.firstSegment + c.segmentCount,
  );
  const chapters = meta?.chapters ?? [];
  const readyCount = chapters.filter((c) => chapterRollup(progress, meta, c).status === "ready").length;
  const queuedCount = chapters.filter((c) => chapterRollup(progress, meta, c).status === "queued").length;
  // played fraction within the current chapter, by segment position
  const chPlayedFrac = currentChapter
    ? Math.min(1, Math.max(0, (playIndex - currentChapter.firstSegment) / Math.max(1, currentChapter.segmentCount)))
    : 0;
  const waveSeed = (meta ? meta.id.charCodeAt(0) : 1) + (currentChapter?.index ?? 0) * 71;

  return (
    <div className="page-inner wide ab-reader">
      <div className="row gap-8" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            audioRef.current?.pause();
            setView("list");
            setPlaying(false);
            void loadBooks();
          }}
        >
          <IcChevronLeft size={14} /> {t("back")}
        </button>
      </div>

      <div className="reader-shell">
        {/* Chapter rail + generation queue */}
        <aside className="reader-chapters">
          <div className="ch-head">{t("chapters")}</div>
          {chapters.map((c) => {
            const roll = chapterRollup(progress, meta, c);
            return (
              <button
                type="button"
                key={c.index}
                className={`chapter-item ${currentChapter?.index === c.index ? "active" : ""}`}
                onClick={() => focusChapter(c)}
              >
                <span className="ch-num">{String(c.index + 1).padStart(2, "0")}</span>
                <span className="ch-title">{c.title}</span>
                <span className={`ch-status ${roll.status}`} />
              </button>
            );
          })}

          <div style={{ marginTop: 18 }}>
            <div className="queue-card">
              <div className="queue-head">
                <span className="player-eyebrow">{t("queueTitle")}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-on-dark-soft)" }}>
                  {readyCount} / {chapters.length}
                </span>
              </div>
              {chapters.map((c) => {
                const roll = chapterRollup(progress, meta, c);
                return (
                  <div key={c.index} className="queue-row">
                    <span className="q-num">{String(c.index + 1).padStart(2, "0")}</span>
                    <span className="q-title">{c.title}</span>
                    <span className="q-status">
                      {roll.status === "gen" && (
                        <>
                          <span className="gen-dot" />
                          {roll.pct}%
                        </>
                      )}
                      {roll.status === "queued" && (
                        <>
                          <span className="queued-dot" />
                          {t("queued")}
                        </>
                      )}
                      {roll.status === "ready" && (
                        <>
                          <span className="ok-dot" />
                          {t("ready")}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Reader body */}
        <div className="reader-body">
          <div className="book-hero">
            <div className="book-cover">
              <SpikeIcon className="book-cover-mark" />
              <div className="title-zh">{meta?.title}</div>
            </div>
            <div>
              <div className="eyebrow">{statusLabel}</div>
              <h2>{meta?.title}</h2>
              <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--color-muted)", margin: "0 0 14px" }}>
                {done} / {meta?.segmentCount} ({pct}%)
                {progress?.status === "synthesizing" && eta != null && eta > 0 && (
                  <> · {t("etaPrefix")} {formatEta(eta, locale)}</>
                )}
              </p>
              <div className="row gap-12" style={{ flexWrap: "wrap" }}>
                <span className="badge">{t("badgeReady", { n: readyCount })}</span>
                {queuedCount > 0 && (
                  <span className="badge badge--cream">{t("badgeQueued", { n: queuedCount })}</span>
                )}
                {progress && progress.status !== "done" && (() => {
                  // Manual resume when paused or auto-resume off; otherwise pause.
                  const showResume = progress.status === "paused" || !progress.autoResume;
                  return (
                    <button
                      type="button"
                      className="badge badge--btn"
                      onClick={() => control({ action: showResume ? "resume" : "pause" })}
                    >
                      {showResume ? t("resumeSynth") : t("pauseSynth")}
                    </button>
                  );
                })()}
                {progress && progress.status !== "done" && (
                  <button
                    type="button"
                    className="badge badge--btn"
                    aria-pressed={progress.autoResume}
                    onClick={() => control({ action: "autoResume", enabled: !progress.autoResume })}
                  >
                    {progress.autoResume ? t("autoOn") : t("autoOff")}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Now-playing card */}
          <div className="card-cream" style={{ padding: 24, marginBottom: 20 }}>
            <div className="row between" style={{ alignItems: "start", marginBottom: 16 }}>
              <div>
                <div className="eyebrow" style={{ margin: 0, color: "var(--color-primary)" }}>
                  {t("nowPlaying")}
                </div>
                {currentChapter && (
                  <h5
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 400,
                      fontSize: 28,
                      letterSpacing: "-0.4px",
                      margin: "6px 0 4px",
                    }}
                  >
                    {currentChapter.title}
                  </h5>
                )}
                <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--color-muted)" }}>
                  {currentChapter ? `${currentChapter.segmentCount}` : 0} · {playIndex + 1} / {meta?.segmentCount}
                </div>
              </div>
              <div className="row gap-8">
                <button type="button" className="icon-btn" aria-label="download" disabled>
                  <IcDownload size={16} />
                </button>
                <button type="button" className="icon-btn" aria-label="share" disabled>
                  <IcShare size={16} />
                </button>
                <button type="button" className="icon-btn" aria-label="restart" onClick={() => setPlayIndex(currentChapter?.firstSegment ?? 0)}>
                  <IcRotate size={16} />
                </button>
              </div>
            </div>

            <div style={{ background: "var(--color-surface-dark)", borderRadius: 12, padding: 20 }}>
              <StaticWaveform seed={waveSeed} bars={140} height={64} played={chPlayedFrac} />
              <div
                className="row between mt-8"
                style={{ color: "var(--color-on-dark-soft)", fontSize: 12, fontFamily: "var(--font-mono)" }}
              >
                <span>{playIndex + 1}</span>
                <span>{meta?.segmentCount ?? 0}</span>
              </div>
            </div>

            {/* segment transcript */}
            <p className="serif" style={{ fontSize: 20, lineHeight: 1.55, margin: "16px 0 0", minHeight: 56, textWrap: "pretty" }}>
              {segments[playIndex]?.text ?? ""}
            </p>

            <audio
              ref={audioRef}
              preload="auto"
              controlsList="nodownload noplaybackrate"
              onEnded={onEnded}
              style={{ display: "none" }}
            >
              <track kind="captions" />
            </audio>

            <div className="row between mt-16" style={{ flexWrap: "wrap", gap: 12 }}>
              <div className="row gap-8">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setPlayIndex((i) => Math.max(0, i - 1))}
                >
                  <IcSkipBack size={14} />
                  {t("prev")}
                </button>
                <button type="button" className="btn btn--primary" onClick={togglePlay}>
                  {playing ? (
                    <>
                      <IcPause size={14} />
                      {t("pause")}
                    </>
                  ) : (
                    <>
                      <IcPlay size={14} />
                      {t("play")}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => meta && setPlayIndex((i) => Math.min(meta.segmentCount - 1, i + 1))}
                >
                  {t("next")}
                  <IcSkipForward size={14} />
                </button>
              </div>
              <div className="row gap-8">
                <span style={{ fontSize: 12, color: "var(--color-muted)" }}>{t("speed")}</span>
                <div className="speed-group speed-group--light" role="group" aria-label={t("speed")}>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`speed-btn ${speed === s ? "active" : ""}`}
                      aria-pressed={speed === s}
                      onClick={() => setSpeedPersist(s)}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {playing && curStatus !== "done" && (
              <p className="small" style={{ color: "var(--color-muted)", marginTop: 12 }}>
                {t("waiting")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Sticky bottom player */}
      <div className="player-bar">
        <button type="button" className="play-btn" onClick={togglePlay} aria-label={playing ? t("pause") : t("play")}>
          {playing ? <IcPause size={16} /> : <IcPlay size={16} />}
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="pb-title">{currentChapter ? currentChapter.title : meta?.title}</div>
          <div className="pb-time">
            {meta?.title} · {playIndex + 1} / {meta?.segmentCount}
          </div>
        </div>
        <div className="pb-progress" style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, minWidth: 100 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-primary)", borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}

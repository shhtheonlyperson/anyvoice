"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
    h1: "把書讀成有聲書",
    lede: "上傳 EPUB 或 PDF，用你的聲音逐段合成。第一段好了就能開始聽，其餘在背景繼續產生。",
    upload: "上傳 EPUB / PDF",
    uploading: "處理中…",
    empty: "還沒有書，先上傳一本。",
    back: "← 返回書架",
    play: "播放",
    pause: "暫停",
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
  },
  en: {
    h1: "Turn a book into an audiobook",
    lede: "Upload an EPUB or PDF and synthesize it in your voice, segment by segment. Start listening as soon as the first piece is ready while the rest generates in the background.",
    upload: "Upload EPUB / PDF",
    uploading: "Processing…",
    empty: "No books yet — upload one to start.",
    back: "← Back to shelf",
    play: "Play",
    pause: "Pause",
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

export function BookReader({
  locale,
  profileReady,
  profileId,
}: {
  locale: Locale;
  profileReady: boolean;
  profileId: string;
}) {
  const t = (k: string) => COPY[locale][k] ?? k;
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

  if (!profileReady) {
    return (
      <div className="wrap">
        <div className="hero">
          <div className="eyebrow">{locale === "en" ? "Audiobook" : "有聲書"}</div>
          <h1 className="display">{t("h1")}</h1>
          <p className="lede">{t("needProfile")}</p>
        </div>
      </div>
    );
  }

  if (view === "list") {
    return (
      <div className="wrap">
        <div className="hero">
          <div className="eyebrow">{locale === "en" ? "Audiobook" : "有聲書"}</div>
          <h1 className="display">{t("h1")}</h1>
          <p className="lede">{t("lede")}</p>
        </div>
        <div className="card card--cream" style={{ display: "grid", gap: 18 }}>
          <label className="btn btn--primary btn--lg" style={{ cursor: "pointer", justifySelf: "start" }}>
            {uploading ? t("uploading") : t("upload")}
            <input
              type="file"
              accept=".epub,.pdf,application/epub+zip,application/pdf"
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
          {error && <p className="notice notice--error">{error}</p>}
        </div>

        {books.length === 0 ? (
          <p className="muted small" style={{ marginTop: 20 }}>{t("empty")}</p>
        ) : (
          <div className="book-shelf">
            {books.map((b) => {
              const done = b.progress?.done ?? 0;
              const pct = b.segmentCount ? Math.round((done / b.segmentCount) * 100) : 0;
              return (
                <div className="book-card" key={b.id}>
                  <button className="book-open" onClick={() => openBook(b.id)}>
                    <span className="book-title serif">{b.title}</span>
                    <span className="muted small">
                      {done} / {b.segmentCount} · {pct}%
                    </span>
                    <span className="book-bar"><i style={{ width: `${pct}%` }} /></span>
                  </button>
                  <button className="link small" onClick={() => removeBook(b.id)}>{t("deleteBook")}</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // reader
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

  return (
    <div className="wrap">
      <button className="link small" onClick={() => { setView("list"); setPlaying(false); void loadBooks(); }}>
        {t("back")}
      </button>
      <div className="hero" style={{ paddingTop: 16 }}>
        <h1 className="display">{meta?.title}</h1>
        <p className="lede">
          {statusLabel} · {done} / {meta?.segmentCount} ({pct}%)
          {progress?.status === "synthesizing" && eta != null && eta > 0 && (
            <> · {t("etaPrefix")} {formatEta(eta, locale)}</>
          )}
        </p>
      </div>

      <div className="card card--dark" style={{ display: "grid", gap: 18 }}>
        {currentChapter && (
          <span className="label" style={{ color: "var(--on-dark-soft)", margin: 0 }}>{currentChapter.title}</span>
        )}
        <p className="serif" style={{ fontSize: 22, lineHeight: 1.5, minHeight: 64 }}>
          {segments[playIndex]?.text ?? ""}
        </p>
        <audio ref={audioRef} preload="auto" controlsList="nodownload noplaybackrate" onEnded={onEnded} style={{ display: "none" }}>
          <track kind="captions" />
        </audio>
        <div className="player-menu">
          <button
            className="btn btn--primary"
            onClick={() => {
              if (playing) {
                audioRef.current?.pause();
                setPlaying(false);
              } else {
                setPlaying(true);
              }
            }}
          >
            {playing ? `⏸ ${t("pause")}` : `▶ ${t("play")}`}
          </button>
          <div className="speed-group" role="group" aria-label={t("speed")}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={"speedbtn" + (speed === s ? " speedbtn--on" : "")}
                aria-pressed={speed === s}
                onClick={() => {
                  setSpeed(s);
                  if (audioRef.current) audioRef.current.playbackRate = s;
                  try {
                    window.localStorage.setItem("anyvoice:speed", String(s));
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {s}×
              </button>
            ))}
          </div>
          {progress && progress.status !== "done" && (() => {
            // Offer manual resume when paused, or when auto-resume is off (the
            // loop may not be running after a restart). Otherwise offer pause.
            const showResume = progress.status === "paused" || !progress.autoResume;
            return (
              <button
                className="btn btn--on-dark"
                onClick={() => control({ action: showResume ? "resume" : "pause" })}
              >
                {showResume ? t("resumeSynth") : t("pauseSynth")}
              </button>
            );
          })()}
          {progress && progress.status !== "done" && (
            <button
              className="btn btn--on-dark"
              aria-pressed={progress.autoResume}
              onClick={() => control({ action: "autoResume", enabled: !progress.autoResume })}
            >
              {progress.autoResume ? t("autoOn") : t("autoOff")}
            </button>
          )}
        </div>
        {playing && curStatus !== "done" && (
          <p className="small" style={{ color: "var(--on-dark-soft)" }}>{t("waiting")}</p>
        )}
      </div>

      {meta && meta.chapters.length > 1 && (
        <div style={{ marginTop: 28 }}>
          <span className="label">{t("chapters")}</span>
          <div className="chapter-list">
            {meta.chapters.map((c) => {
              const slice = progress?.statuses.slice(c.firstSegment, c.firstSegment + c.segmentCount) ?? [];
              const cDone = slice.filter((s) => s === "done").length;
              const cPending = slice.filter((s) => s === "pending").length;
              // "synthesizing" if this chapter is the active queue head.
              const isSynthing =
                progress?.status === "synthesizing" &&
                cPending > 0 &&
                (progress.focusChapter === c.index ||
                  (progress.focusChapter == null && c.kind === "chapter") ||
                  (progress.focusChapter != null &&
                    meta.chapters[progress.focusChapter] &&
                    progress.statuses
                      .slice(
                        meta.chapters[progress.focusChapter].firstSegment,
                        meta.chapters[progress.focusChapter].firstSegment + meta.chapters[progress.focusChapter].segmentCount,
                      )
                      .every((s) => s !== "pending") &&
                    c.kind === "chapter"));
              const untouchedExtra = c.kind === "extra" && cDone === 0 && cPending === c.segmentCount;
              return (
                <button
                  key={c.index}
                  className={"chapter-row" + (currentChapter?.index === c.index ? " chapter-row--on" : "")}
                  onClick={() => focusChapter(c)}
                >
                  <span className="chapter-title">
                    {c.kind === "extra" && <span className="chip chip--cream" style={{ marginRight: 8 }}>{t("extraBadge")}</span>}
                    {c.title}
                  </span>
                  <span className="muted small">
                    {isSynthing ? (
                      <span style={{ color: "var(--primary)" }}>● {t("synthingNow")} {cDone}/{c.segmentCount}</span>
                    ) : untouchedExtra ? (
                      t("onDemand")
                    ) : (
                      `${cDone} / ${c.segmentCount}`
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

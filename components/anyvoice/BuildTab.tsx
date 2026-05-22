"use client";
/* Build voice — the handoff's screen #1. Adaptive page driven by the active
 * voice's REAL summary (from GET /api/voice-profile/profiles → clipCount /
 * usable / studioGrade), mapped to the design states:
 *
 *   empty      clipCount === 0           cream card + Start recording + 3 options
 *   reviewing  usable, not studioGrade   cream card + progress donut + Continue
 *   ready      studioGrade               coral hero + Start generating + Listen back
 *   recording  user clicked a record CTA the in-browser 24-line record-and-grade stage
 *
 * The recording state is the heart of the product: the handoff's dark recording
 * stage with the 24-line guided script (components/anyvoice/build-script.ts),
 * a live 6–20s duration meter, a "Space to stop" shortcut, line dots/list, and
 * a phoneme-coverage sidecar.
 *
 * It REUSES the proven capture + enroll + grading from VoiceCloneStudio: the
 * same getUserMedia constraints that reject browser AGC/NS, the same
 * MediaRecorder options + recorded-file creation, and the same
 * POST /api/voice-profile/enroll contract (promptTranscript = the line text,
 * sourceKind="scripted", the active profileId, consent=yes). The returned
 * referenceQuality.grade marks the line passed (A/B) or re-record (C/D) with a
 * single honest reason. Donut + state advance off the refreshed real summary.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceCloneStudio } from "@/components/VoiceCloneStudio";
import {
  simplifiedOrMixedChineseScriptErrors,
} from "@/lib/text-prep";
import {
  BUILD_LINE_COUNT,
  BUILD_SCRIPT_PACK,
  lineStatusFromGrade,
  type BuildScriptLocale,
} from "./build-script";
import {
  coverageFromTexts,
  phonemesInText,
  FINALS,
  INITIALS,
  TONES,
  type Final,
  type Initial,
  type Tone,
} from "@/lib/mandarin-phonemes";
import { useLang, useT, type Lang, type Translate } from "./i18n";
import type { ProfileListItem } from "./lib/anyvoice-client";
import { deleteProfile, renameProfile } from "./lib/anyvoice-client";
import {
  IcCheck,
  IcChevron,
  IcChevronLeft,
  IcEdit,
  IcMic,
  IcRotate,
  IcSquare,
  IcTrash,
  IcUpload,
  IcYoutube,
} from "./icons";
import { Donut, LiveWaveform, MiniWaveform } from "./waveforms";

type BuildState = "empty" | "reviewing" | "ready" | "recording";
type LineStatus = "todo" | "pass" | "retry" | "recording" | "processing";

/** Map the real summary to the design state. */
function deriveState(p: ProfileListItem | undefined): Exclude<BuildState, "recording"> {
  if (!p || p.clipCount === 0) return "empty";
  if (p.studioGrade) return "ready";
  return "reviewing";
}

function titleKey(state: BuildState): string {
  if (state === "empty") return "build.title.empty";
  if (state === "ready") return "build.title.ready";
  if (state === "recording") return "build.recording.title";
  return "build.title.reviewing";
}
function ledeKey(state: BuildState): string {
  if (state === "empty") return "build.lede.empty";
  if (state === "ready") return "build.lede.ready";
  if (state === "recording") return "build.recording.sub";
  return "build.lede.reviewing";
}

// ---- enroll/capture mechanics reused verbatim from VoiceCloneStudio ----
const REC_MIN_SEC = 6;
const REC_MAX_SEC = 20;

const VOICE_CAPTURE_MEDIA_CONSTRAINTS = {
  audio: {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
  },
} satisfies MediaStreamConstraints;

function createRecordedFile(chunks: Blob[], mimeType: string, stamp: number): File {
  const type = mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("wav") ? "wav" : "webm";
  return new File(chunks, `recording-${stamp}.${extension}`, { type });
}

function supportedRecorderOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  return mimeType ? { mimeType } : undefined;
}

interface ReferenceQuality {
  grade: "A" | "B" | "C" | "D";
  durationSec: number;
  warnings: string[];
}
interface EnrollPayload {
  status: "enrolled" | "error";
  message?: string;
  referenceQuality?: ReferenceQuality;
  profile?: {
    usable?: boolean;
    studioGrade?: boolean;
    status?: "ready" | "needs_enrollment";
    requirements?: { passingGrades?: string[] };
    clips?: { transcriptRaw?: string }[];
  };
}

// Turn the analyzer's actual finding into one specific, honest reason. The most
// common case for clean-sounding clips is duration, not noise (mirrors
// VoiceCloneStudio.rejectionMessage).
function rejectionMessage(t: Translate, q: ReferenceQuality | undefined): string {
  const dur = q?.durationSec ?? 0;
  if (dur > 0 && dur < REC_MIN_SEC) return t("build.rec.tooShort", { sec: dur.toFixed(1), min: REC_MIN_SEC });
  if (dur > REC_MAX_SEC) return t("build.rec.tooLong", { sec: dur.toFixed(1), max: REC_MAX_SEC });
  const w = q?.warnings ?? [];
  if (w.includes("short_clip")) return t("build.rec.tooShort", { sec: dur.toFixed(1), min: REC_MIN_SEC });
  if (w.includes("long_clip")) return t("build.rec.tooLong", { sec: dur.toFixed(1), max: REC_MAX_SEC });
  if (w.includes("clipping_detected")) return t("build.rec.clipping");
  if (w.includes("low_snr")) return t("build.rec.noisy");
  if (w.some((x) => x.includes("voice") || x.includes("vad") || x.includes("active"))) return t("build.rec.lowVoice");
  return t("build.rec.rejected");
}

/* ----------------------------------------------------------------------- */
/* The dark in-browser record-and-grade stage (handoff recording state).   */
/* ----------------------------------------------------------------------- */
function BuildRecordingStage({
  profileId,
  pack,
  initialStatuses,
  onClose,
  onEnrolled,
}: {
  profileId: string;
  pack: BuildScriptLocale;
  /** Per-line status seeded from the profile's already-enrolled transcripts. */
  initialStatuses: LineStatus[];
  onClose: () => void;
  /** Called after each enroll with the fresh profile so the parent can refresh. */
  onEnrolled: () => void;
}) {
  const t = useT();
  const lines = BUILD_SCRIPT_PACK[pack];

  const [statuses, setStatuses] = useState<LineStatus[]>(initialStatuses);
  const [cur, setCur] = useState(() => {
    const firstTodo = initialStatuses.findIndex((s) => s !== "pass");
    return firstTodo >= 0 ? firstTodo : 0;
  });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);

  const currentLine = lines[cur];
  const recordedCount = statuses.filter((s) => s === "pass").length;
  const enrolling = statuses[cur] === "processing";

  // Phoneme coverage sidecar — deterministic, text-derived from the transcripts
  // of the lines passed so far (honest: which phonemes the recorded lines
  // CONTAIN; NOT audio-verified pronunciation — the A–D grade is that signal).
  const coverage = useMemo(() => {
    const recorded = lines.filter((_, i) => statuses[i] === "pass").map((l) => l.text);
    return coverageFromTexts(recorded);
  }, [lines, statuses]);
  const coveredInitials = useMemo(() => new Set<Initial>(coverage.initials), [coverage]);
  const coveredFinals = useMemo(() => new Set<Final>(coverage.finals), [coverage]);
  const coveredTones = useMemo(() => new Set<Tone>(coverage.tones), [coverage]);
  // Phonemes in the current line — ringed as "recent" in the grid.
  const active = useMemo(
    () => (currentLine ? phonemesInText(currentLine.text) : phonemesInText("")),
    [currentLine],
  );

  const clearTimers = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (autoStopRef.current) window.clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    clearTimers();
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, [clearTimers]);

  const setStatus = useCallback((index: number, status: LineStatus) => {
    setStatuses((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  }, []);

  const enrollClip = useCallback(
    async (file: File, lineIndex: number) => {
      setStatus(lineIndex, "processing");
      const form = new FormData();
      form.set("voice", file);
      form.set("promptTranscript", lines[lineIndex].text);
      form.set("sourceKind", "scripted");
      form.set("voiceProfileId", profileId);
      form.set("consent", "yes");
      try {
        const response = await fetch("/api/voice-profile/enroll", { method: "POST", body: form });
        const payload = (await response.json()) as EnrollPayload;
        if (!response.ok || payload.status !== "enrolled") {
          setStatus(lineIndex, "retry");
          setMessage(payload.message || t("build.rec.rejected"));
          return;
        }
        const passing = new Set(payload.profile?.requirements?.passingGrades ?? ["A", "B"]);
        const grade = payload.referenceQuality?.grade;
        if (grade && !passing.has(grade)) {
          setStatus(lineIndex, lineStatusFromGrade(grade));
          setMessage(rejectionMessage(t, payload.referenceQuality));
          return;
        }
        setStatus(lineIndex, "pass");
        setMessage("");
        onEnrolled();
        // Advance to the next not-yet-passed line.
        setStatuses((prev) => {
          const nextTodo = prev.findIndex((s, i) => i !== lineIndex && s !== "pass" && s !== "processing");
          if (nextTodo >= 0) setCur(nextTodo);
          return prev;
        });
      } catch {
        setStatus(lineIndex, "retry");
        setMessage(t("build.rec.rejected"));
      }
    },
    [lines, profileId, t, onEnrolled, setStatus],
  );

  const startRecording = useCallback(async () => {
    setMessage("");
    if (simplifiedOrMixedChineseScriptErrors(currentLine.text).length > 0) {
      setMessage(t("build.rec.scriptBlocked"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
    } catch {
      setMessage(t("build.rec.micBlocked"));
      return;
    }
    // Reject browser-side AGC/NS/echo — they degrade enrollment quality.
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() as MediaTrackSettings | undefined;
    if (settings && (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl)) {
      stream.getTracks().forEach((tr) => tr.stop());
      setMessage(t("build.rec.micProcessing"));
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, supportedRecorderOptions());
    const lineIndex = cur;
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const file = createRecordedFile(chunksRef.current, recorder.mimeType, Date.now());
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
      void enrollClip(file, lineIndex);
    };
    recorder.start();
    setStatus(lineIndex, "recording");
    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    // Hard ceiling so a clip never exceeds the gate.
    autoStopRef.current = window.setTimeout(() => stopRecording(), REC_MAX_SEC * 1000);
  }, [cur, currentLine, enrollClip, t, setStatus, stopRecording]);

  const toggleRecord = useCallback(() => {
    if (enrolling) return;
    if (recording) {
      // Don't let the user stop below the gate floor — the #1 cause of
      // "clean but rejected" clips. Surface the live target instead.
      if (elapsed < REC_MIN_SEC) {
        setMessage(t("build.rec.keepGoing"));
        return;
      }
      stopRecording();
    } else {
      void startRecording();
    }
  }, [enrolling, recording, elapsed, startRecording, stopRecording, t]);

  // "Space to stop" keyboard shortcut while recording.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (!recording && !enrolling) return;
      e.preventDefault();
      toggleRecord();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, enrolling, toggleRecord]);

  // Clear timers + tracks on unmount mid-take.
  useEffect(() => {
    return () => {
      clearTimers();
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [clearTimers]);

  function redoLine(index: number) {
    if (recording || enrolling) return;
    setStatus(index, "todo");
    setCur(index);
    setMessage("");
  }

  function pickLine(index: number) {
    if (recording || enrolling) return;
    setCur(index);
  }

  const elapsedLabel = `${Math.floor(elapsed)}s`;

  return (
    <div className="build-rec-grid">
      <div>
        <div className="rec-stage">
          <div className="row between" style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ margin: 0 }}>
              {t("build.rec.eyebrow", { n: cur + 1, total: BUILD_LINE_COUNT })}
            </div>
            <div className="row gap-8" style={{ color: "var(--color-on-dark-soft)", fontSize: 13 }}>
              <span className="kbd">{t("build.rec.spaceKey")}</span>
              <span>{t("build.rec.stopHint")}</span>
            </div>
          </div>

          <div className="rec-line">{currentLine.text}</div>

          {currentLine.cues.length > 0 && (
            <div className="row gap-8" style={{ flexWrap: "wrap", marginBottom: 18 }}>
              <span className="small" style={{ color: "var(--color-on-dark-soft)" }}>
                {t("build.rec.cue")}:
              </span>
              {currentLine.cues.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          )}

          <LiveWaveform active={recording} bars={80} height={88} />

          <div className="rec-controls">
            <div className="row gap-16">
              <button
                type="button"
                className={"rec-btn" + (recording ? " recording" : "")}
                onClick={toggleRecord}
                disabled={enrolling}
                aria-label={recording ? t("build.rec.stopHint") : t("build.rec.start")}
              >
                {recording ? <IcSquare size={22} /> : <IcMic size={22} />}
              </button>
              <div>
                <div className="rec-timer">
                  {recording ? elapsedLabel : "0s"} · {t("build.rec.timerHint")}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-on-dark-soft)", marginTop: 4 }}>
                  {enrolling
                    ? t("build.rec.processing")
                    : recording
                      ? elapsed < REC_MIN_SEC
                        ? t("build.rec.coach")
                        : t("build.rec.readyToStop")
                      : t("build.rec.coach")}
                </div>
              </div>
            </div>
            <div className="row gap-8">
              <button type="button" className="dark-link-btn" onClick={() => redoLine(cur)} disabled={recording || enrolling}>
                <IcRotate size={14} /> {t("build.rec.redo")}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" style={{ color: "#fff" }} onClick={onClose}>
                <IcChevronLeft size={14} /> {t("build.recording.back")}
              </button>
            </div>
          </div>
        </div>

        {message && (
          <p className="notice notice--error" style={{ marginTop: 16 }}>
            {message}
          </p>
        )}

        {/* Lines list — each row's status dot is the analyzer's grade verdict. */}
        <div className="mt-32">
          <div className="row between" style={{ alignItems: "center" }}>
            <span className="player-eyebrow" style={{ color: "var(--color-muted)" }}>
              {t("build.lines.progress", { n: recordedCount, total: BUILD_LINE_COUNT })}
            </span>
            <div className="row gap-16">
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot pass" /> {t("build.lines.legend.pass")}
              </span>
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot retry" /> {t("build.lines.legend.retry")}
              </span>
              <span className="row gap-6" style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <span className="line-status-dot todo" /> {t("build.lines.legend.todo")}
              </span>
            </div>
          </div>
          <div className="lines-list">
            {lines.map((line, i) => {
              const st = statuses[i];
              const dotClass = st === "processing" ? "recording" : st;
              const stLabel =
                st === "pass"
                  ? t("build.lines.st.pass")
                  : st === "retry"
                    ? t("build.lines.st.retry")
                    : st === "recording"
                      ? t("build.lines.st.recording")
                      : st === "processing"
                        ? t("build.lines.st.processing")
                        : t("build.lines.st.todo");
              return (
                <div
                  key={line.n}
                  className={"line-row" + (i === cur ? " active" : "")}
                  onClick={() => pickLine(i)}
                >
                  <div className="row gap-12" style={{ alignItems: "center" }}>
                    <span className="line-num">{String(line.n).padStart(2, "0")}</span>
                    <span className={`line-status-dot ${dotClass}`} />
                  </div>
                  <div className="line-text">{line.text}</div>
                  <div className="line-actions">
                    {(st === "pass" || st === "retry") && (
                      <MiniWaveform
                        seed={line.n * 137}
                        text={line.text}
                        bars={28}
                        height={20}
                        color={st === "retry" ? "var(--color-warning)" : "var(--color-muted-soft)"}
                      />
                    )}
                    <span className="line-meta">{stLabel}</span>
                    {(st === "pass" || st === "retry") && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={t("build.rec.redo")}
                        onClick={(e) => {
                          e.stopPropagation();
                          redoLine(i);
                        }}
                      >
                        <IcRotate size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Phoneme coverage sidecar — real Mandarin inventory, text-derived from
          the recorded lines' transcripts (see lib/mandarin-phonemes.ts). */}
      <aside className="card-dark coverage-sidecar">
        <div className="row between" style={{ marginBottom: 12 }}>
          <span className="player-eyebrow">{t("build.coverage.title")}</span>
          <span className="player-time">
            {coverage.covered} / {coverage.total}
          </span>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.initials")}</span>
          <div className="phoneme-row">
            {INITIALS.map((p) => (
              <span
                key={`i-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredInitials.has(p) ? " covered-3" : "") +
                  (active.initials.has(p) ? " recent" : "")
                }
              >
                {p}
              </span>
            ))}
          </div>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.finals")}</span>
          <div className="phoneme-row">
            {FINALS.map((p) => (
              <span
                key={`f-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredFinals.has(p) ? " covered-3" : "") +
                  (active.finals.has(p) ? " recent" : "")
                }
              >
                {p === "i_" ? "ɿ" : p}
              </span>
            ))}
          </div>
        </div>

        <div className="coverage-section">
          <span className="coverage-section-label">{t("build.coverage.tones")}</span>
          <div className="phoneme-row">
            {TONES.map((p) => (
              <span
                key={`t-${p}`}
                className={
                  "phoneme-cell" +
                  (coveredTones.has(p) ? " covered-3" : "") +
                  (active.tones.has(p) ? " recent" : "")
                }
              >
                {p === "neutral" ? "·" : p}
              </span>
            ))}
          </div>
        </div>

        <p className="small" style={{ color: "var(--color-on-dark-soft)", marginTop: 12 }}>
          {t("build.coverage.note")}
        </p>
        <div className="row gap-16 mt-16">
          <div className="row gap-6" style={{ color: "var(--color-on-dark-soft)", fontSize: 12 }}>
            <span className="phoneme-cell covered-3" style={{ width: 14, height: 14 }} />{" "}
            {t("build.coverage.legend.covered")}
          </div>
          <div className="row gap-6" style={{ color: "var(--color-on-dark-soft)", fontSize: 12 }}>
            <span className="phoneme-cell" style={{ width: 14, height: 14 }} /> {t("build.coverage.legend.missing")}
          </div>
        </div>
      </aside>
    </div>
  );
}

export function BuildTab({
  activeProfile,
  onRefresh,
  onChangeTab,
  onDeleted,
}: {
  activeProfile: ProfileListItem | undefined;
  onRefresh: () => void;
  onChangeTab: (t: "generate") => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const lang: Lang = useLang();
  const pack: BuildScriptLocale = lang === "zh" ? "zh-Hant" : "en";
  const [recording, setRecording] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  // Show the legacy YouTube/upload kit as a fallback disclosure under empty.
  const [showFallback, setShowFallback] = useState(false);

  const derived = deriveState(activeProfile);
  const state: BuildState = recording ? "recording" : derived;
  const clipCount = activeProfile?.clipCount ?? 0;

  // Seed per-line statuses for the recording stage. The backend tracks clip
  // count, not which scripted line each clip belongs to, so we mark the first
  // `clipCount` lines (capped at 24) passed and the rest todo. This keeps the
  // donut + dots honest against the real summary without fabricating grades.
  const initialStatuses = useMemo<LineStatus[]>(() => {
    const passed = Math.min(clipCount, BUILD_LINE_COUNT);
    return Array.from({ length: BUILD_LINE_COUNT }, (_, i) => (i < passed ? "pass" : "todo"));
  }, [clipCount]);

  function startRename() {
    setDraft(activeProfile?.displayName ?? "");
    setRenaming(true);
  }
  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (!activeProfile || !name || name === activeProfile.displayName) return;
    void (async () => {
      await renameProfile(activeProfile.id, name);
      onRefresh();
    })();
  }
  function doDelete() {
    if (!activeProfile) return;
    if (typeof window !== "undefined" && !window.confirm(t("build.action.deleteConfirm"))) return;
    void (async () => {
      await deleteProfile(activeProfile.id);
      onDeleted();
    })();
  }

  if (state === "recording" && activeProfile) {
    return (
      <div className="page-inner wide">
        <div className="row between" style={{ alignItems: "center", marginBottom: 16 }}>
          <div>
            <div className="eyebrow">{t("build.eyebrow")}</div>
            <h1 className="page-title md" style={{ marginBottom: 8 }}>
              {t(titleKey("recording"))}
            </h1>
            <p className="page-lede">{t(ledeKey("recording"))}</p>
          </div>
        </div>
        <BuildRecordingStage
          key={activeProfile.id}
          profileId={activeProfile.id}
          pack={pack}
          initialStatuses={initialStatuses}
          onClose={() => {
            setRecording(false);
            onRefresh();
          }}
          onEnrolled={onRefresh}
        />
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="eyebrow">{t("build.eyebrow")}</div>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        {renaming ? (
          <input
            className="input"
            style={{ maxWidth: 420, fontSize: 28 }}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {t(titleKey(state))}
          </h1>
        )}
        {activeProfile && (
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            <button className="btn btn--ghost btn--sm" type="button" onClick={startRename}>
              <IcEdit size={14} />
              {t("build.action.rename")}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              style={{ color: "var(--color-error)" }}
              onClick={doDelete}
            >
              <IcTrash size={14} />
              {t("build.action.delete")}
            </button>
          </div>
        )}
      </div>
      <p className="page-lede" style={{ marginTop: 16 }}>
        {t(ledeKey(state))}
      </p>

      <div className="mt-32">
        {state === "empty" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="build-status-title">
                {t("build.status.empty.title", { name: activeProfile?.displayName ?? "" })}
              </div>
              <div className="build-status-sub">{t("build.status.empty.sub")}</div>
            </div>
            <div className="build-cta">
              <button
                className="btn btn--primary btn--lg"
                type="button"
                disabled={!activeProfile}
                onClick={() => setRecording(true)}
              >
                <IcMic size={16} />
                {t("build.status.empty.start")}
              </button>
            </div>
          </div>
        )}

        {state === "reviewing" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={Math.min(1, clipCount / BUILD_LINE_COUNT)}
                  size={64}
                  stroke={6}
                  color="var(--color-ink)"
                  track="var(--color-hairline)"
                  label={`${Math.min(clipCount, BUILD_LINE_COUNT)}`}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">
                    {t("build.status.reviewing.title", { n: clipCount })}
                  </div>
                  <div className="build-status-sub">{t("build.status.reviewing.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button className="btn btn--secondary" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.reviewing.pause")}
              </button>
              <button className="btn btn--primary btn--lg" type="button" onClick={() => setRecording(true)}>
                <IcMic size={16} />
                {t("build.status.reviewing.continue")}
              </button>
            </div>
          </div>
        )}

        {state === "ready" && (
          <div className="build-status ready">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={1}
                  size={64}
                  stroke={6}
                  color="#fff"
                  track="rgba(255,255,255,0.25)"
                  label={<IcCheck size={20} style={{ color: "#fff" }} />}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">{t("build.status.ready.title")}</div>
                  <div className="build-status-sub">{t("build.status.ready.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button
                className="btn btn--ghost"
                style={{ color: "#fff" }}
                type="button"
                onClick={() => onChangeTab("generate")}
              >
                {t("build.status.ready.listen")}
              </button>
              <button className="btn btn--secondary btn--lg" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.ready.generate")}
                <IcChevron size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {state === "empty" && (
        <div className="empty-zone mt-48">
          <div className="ill">
            <IcMic size={24} />
          </div>
          <h3>{t("build.empty.title")}</h3>
          <p>{t("build.empty.sub")}</p>
          <div className="row gap-12 mt-8">
            <button className="btn btn--primary" type="button" disabled={!activeProfile} onClick={() => setRecording(true)}>
              <IcMic size={14} />
              {t("build.empty.record")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setShowFallback((v) => !v)}>
              <IcYoutube size={14} />
              {t("build.empty.youtube")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setShowFallback((v) => !v)}>
              <IcUpload size={14} />
              {t("build.empty.upload")}
            </button>
          </div>
        </div>
      )}

      {(state === "reviewing" || state === "ready") && (
        <div className="mt-32">
          <span className="player-eyebrow" style={{ color: "var(--color-muted)" }}>
            {t("build.lines.usable", { n: clipCount })}
          </span>
        </div>
      )}

      {/* YouTube / upload import remains available as a fallback via the legacy
          kit — it owns its own profile selection + import flow. */}
      {showFallback && (
        <div className="legacy-tab-slot mt-32">
          <VoiceCloneStudio />
        </div>
      )}
      <span aria-hidden style={{ display: "none" }}>
        {lang}
      </span>
    </div>
  );
}

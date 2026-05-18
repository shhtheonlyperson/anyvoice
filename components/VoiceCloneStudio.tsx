"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CircleStop,
  Loader2,
  Mic,
  Monitor,
  Moon,
  Sun,
  TriangleAlert,
  Upload,
  Wand2,
} from "lucide-react";

type Locale = "zh-Hant" | "en";
type Theme = "system" | "light" | "dark";
type Status = "idle" | "requesting_mic" | "recording" | "submitting" | "ready" | "needs_worker" | "error";
type SourceKind = "sample" | "uploaded" | "recorded";
type ReferenceGrade = "A" | "B" | "C" | "D";

interface ReferenceQuality {
  grade: ReferenceGrade;
  durationSec: number;
  snrDb: number;
  clippingRatio: number;
  vadActiveRatio: number;
  warnings: string[];
}

interface ClonePayload {
  status: Status;
  audioUrl?: string;
  message?: string;
  jobId?: string;
  referenceQuality?: ReferenceQuality;
  referenceLanguage?: string | null;
  targetLanguage?: string | null;
  effectiveParams?: {
    timesteps?: number;
    cfgValue?: number;
    denoise?: boolean;
    qualityPreset?: string;
  };
}

const SONOGRAM_BARS = 64;
const MAX_TARGET_CHARS = 4096;
const MAX_RECORDING_SECONDS = 60;

const SAMPLE_VOICE_URL = "/sample-voice.wav";
const SAMPLE_VOICE_FILENAME = "sample-voice.wav";

const DEFAULT_TARGET_TEXT = {
  "zh-Hant": "你好，這是我的聲音。",
  en: "Hello, this is my voice.",
} as const;

const copy = {
  "zh-Hant": {
    brand: "AnyVoice",
    locale: "EN",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "Auto",
    workerMissingTitle: "目前環境沒有 VoxCPM2 worker",
    workerMissingBody:
      "Vercel 預覽不能跑 VoxCPM2。設 ANYVOICE_ENABLE_LOCAL_VOXCPM=1 並把 ANYVOICE_VOXCPM_PYTHON 指到本機後再送一次。",
    errorTitle: "失敗",
    sectionVoice: "你的聲音",
    sectionText: "要說的話",
    sourceSample: "示範聲音（小王子節錄）",
    sourceRecorded: "瀏覽器錄音",
    sourceUploaded: "上傳音檔",
    record: "錄音",
    requestingMic: "要求麥克風",
    stop: "停止",
    upload: "上傳",
    targetPlaceholder: "輸入你想讓這個聲音說出的內容…",
    consent: "我擁有這段聲音、或已取得明確授權，且不會用於冒充、詐欺或誤導聽眾。",
    submit: "產生聲音",
    submitting: "送出中",
    outputStatusPending: "Processing",
    outputStatusReady: "Ready",
    outputStatusWarn: "Worker missing",
    outputStatusError: "Failed",
    outputAside: "結果",
    warningCrossLingual: (refLang: string, targetLang: string) =>
      `參考音是${refLang}，但目標文字是${targetLang} — 口音可能不自然。`,
    warningClipping: "參考音有削波，建議重新錄製音量小一點。",
    warningShort: "參考音偏短，相似度可能受影響。",
    warningNoise: "參考音背景雜訊偏高，請在安靜環境再錄一次。",
    noAudio: "請先錄音、上傳或保留示範聲音。",
    noText: "請輸入要合成的文字。",
    noConsent: "請先確認聲音授權。",
    recordingUnavailable: "這個瀏覽器不支援直接錄音，請改用上傳音檔。",
    micPermissionDenied: "瀏覽器沒有取得麥克風權限。請允許麥克風後再按一次錄音。",
    micMissing: "找不到可用的麥克風。請接上或啟用音訊輸入裝置。",
    recorderStartFailed: "無法啟動瀏覽器錄音。請改用上傳音檔，或換一個瀏覽器再試。",
    recordingEmpty: "沒有收到錄音資料。請再錄一次，或改用上傳音檔。",
    langZh: "中文",
    langEn: "英文",
    langJa: "日文",
    langKo: "韓文",
    langOther: "另一種語言",
  },
  en: {
    brand: "AnyVoice",
    locale: "繁中",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "Auto",
    workerMissingTitle: "No VoxCPM2 worker on this environment",
    workerMissingBody:
      "Vercel preview cannot run VoxCPM2. Set ANYVOICE_ENABLE_LOCAL_VOXCPM=1 and point ANYVOICE_VOXCPM_PYTHON at a local runtime, then resubmit.",
    errorTitle: "Failed",
    sectionVoice: "Your voice",
    sectionText: "What to say",
    sourceSample: "Sample voice (Petit Prince excerpt)",
    sourceRecorded: "Browser recording",
    sourceUploaded: "Uploaded audio",
    record: "Record",
    requestingMic: "Requesting mic",
    stop: "Stop",
    upload: "Upload",
    targetPlaceholder: "Write the line you want this voice to say…",
    consent:
      "I own this voice recording, or have explicit permission from the speaker to use it, and I will not use it for impersonation, fraud, or to mislead listeners.",
    submit: "Generate voice",
    submitting: "Submitting",
    outputStatusPending: "Processing",
    outputStatusReady: "Ready",
    outputStatusWarn: "Worker missing",
    outputStatusError: "Failed",
    outputAside: "Result",
    warningCrossLingual: (refLang: string, targetLang: string) =>
      `Reference is ${refLang} but the target is ${targetLang} — accent may be unnatural.`,
    warningClipping: "Reference clips at peaks. Record again with lower input gain.",
    warningShort: "Reference is short. Similarity may suffer.",
    warningNoise: "Reference has high background noise. Record in a quieter room.",
    noAudio: "Record, upload, or keep the sample voice first.",
    noText: "Enter target text first.",
    noConsent: "Confirm voice permission first.",
    recordingUnavailable: "This browser does not support direct recording. Upload an audio file instead.",
    micPermissionDenied: "Microphone permission was not granted. Allow mic access, then press Record again.",
    micMissing: "No available microphone was found. Connect or enable an audio input device.",
    recorderStartFailed: "Browser recording could not start. Upload audio instead, or try another browser.",
    recordingEmpty: "No recording data was captured. Record again, or upload an audio file instead.",
    langZh: "Mandarin",
    langEn: "English",
    langJa: "Japanese",
    langKo: "Korean",
    langOther: "another language",
  },
} satisfies Record<Locale, Record<string, unknown>>;

function createRecordedFile(chunks: Blob[], mimeType: string, stamp: number): File {
  const type = mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("wav") ? "wav" : "webm";
  return new File(chunks, `recording-${stamp}.${extension}`, { type });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
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

async function fetchSampleVoiceFile(): Promise<File> {
  const response = await fetch(SAMPLE_VOICE_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`sample voice fetch failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new File([buffer], SAMPLE_VOICE_FILENAME, { type: "audio/wav" });
}

function extractWaveformPeaks(file: File, bins: number): Promise<number[]> {
  return new Promise(async (resolve, reject) => {
    try {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) {
        resolve([]);
        return;
      }
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new AudioContextConstructor();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const channel = audioBuffer.getChannelData(0);
      const samplesPerBin = Math.max(1, Math.floor(channel.length / bins));
      const peaks: number[] = new Array(bins).fill(0);
      for (let i = 0; i < bins; i += 1) {
        let max = 0;
        const start = i * samplesPerBin;
        const end = Math.min(channel.length, start + samplesPerBin);
        for (let j = start; j < end; j += 1) {
          const value = Math.abs(channel[j] ?? 0);
          if (value > max) max = value;
        }
        peaks[i] = max;
      }
      const ceiling = Math.max(...peaks, 0.001);
      const normalized = peaks.map((peak) => peak / ceiling);
      await audioContext.close();
      resolve(normalized);
    } catch (error) {
      reject(error);
    }
  });
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function localizeLanguage(code: string | null | undefined, t: typeof copy[Locale]): string {
  if (!code) return t.langOther;
  const c = code.toLowerCase();
  if (c.startsWith("zh")) return t.langZh;
  if (c.startsWith("en")) return t.langEn;
  if (c.startsWith("ja")) return t.langJa;
  if (c.startsWith("ko")) return t.langKo;
  return t.langOther;
}

function describeWarning(code: string, payload: ClonePayload, t: typeof copy[Locale]): string | null {
  if (code.startsWith("cross_lingual")) {
    const parts = code.split(":")[1]?.split("->") ?? [];
    const refLang = localizeLanguage(parts[0] || payload.referenceLanguage, t);
    const targetLang = localizeLanguage(parts[1] || payload.targetLanguage, t);
    return t.warningCrossLingual(refLang, targetLang);
  }
  if (code === "clipping" || code.startsWith("clipping")) return t.warningClipping;
  if (code === "short" || code.startsWith("short")) return t.warningShort;
  if (code === "noisy" || code === "low_snr" || code.startsWith("snr")) return t.warningNoise;
  return code;
}

export function VoiceCloneStudio() {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window === "undefined") return "zh-Hant";
    const saved = window.localStorage.getItem("anyvoice:locale");
    return saved === "en" || saved === "zh-Hant" ? saved : "zh-Hant";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    const saved = window.localStorage.getItem("anyvoice:theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });
  const t = copy[locale];

  const [status, setStatus] = useState<Status>("idle");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>("sample");
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [wavePeaks, setWavePeaks] = useState<number[]>([]);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [userTargetText, setUserTargetText] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [message, setMessage] = useState("");
  const [recordingSupported, setRecordingSupported] = useState(true);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);

  const [referenceQuality, setReferenceQuality] = useState<ReferenceQuality | null>(null);
  const [lastResponse, setLastResponse] = useState<ClonePayload | null>(null);

  const targetText = userTargetText ?? DEFAULT_TARGET_TEXT[locale];

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sourcePreviewUrlRef = useRef("");
  const sourceAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingDeadlineRef = useRef<number | null>(null);

  /* ---------- Theme & locale ---------- */
  useEffect(() => {
    window.localStorage.setItem("anyvoice:locale", locale);
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  useEffect(() => {
    window.localStorage.setItem("anyvoice:theme", theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  /* ---------- Cleanup ---------- */
  useEffect(() => {
    return () => {
      if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);
      void audioContextRef.current?.close();
    };
  }, []);

  const adoptVoiceFile = useCallback(async (file: File, kind: SourceKind) => {
    if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    sourcePreviewUrlRef.current = previewUrl;
    setVoiceFile(file);
    setSourceKind(kind);
    setSourcePreviewUrl(previewUrl);
    setPlaybackProgress(0);
    setAudioUrl("");
    setStatus("idle");
    setMessage("");
    setWavePeaks([]);
    setReferenceQuality(null);
    setLastResponse(null);
    try {
      const peaks = await extractWaveformPeaks(file, SONOGRAM_BARS);
      setWavePeaks(peaks);
    } catch {
      /* waveform extraction is best-effort */
    }
  }, []);

  /* ---------- Load sample voice on mount ---------- */
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const sample = await fetchSampleVoiceFile();
        if (active) await adoptVoiceFile(sample, "sample");
      } catch {
        /* sample is optional; user can still record/upload */
      }
    })();
    return () => {
      active = false;
    };
  }, [adoptVoiceFile]);

  function stopRecordingTimer() {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  function startRecordingTimer() {
    stopRecordingTimer();
    const startedAt = Date.now();
    recordingDeadlineRef.current = startedAt + MAX_RECORDING_SECONDS * 1000;
    setRecordingElapsed(0);
    recordingTimerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setRecordingElapsed(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) {
        stopRecording();
      }
    }, 200);
  }

  function stopInputMeter() {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    void audioContext?.close();
    setInputLevel(0);
  }

  function startInputMeter(stream: MediaStream) {
    stopInputMeter();
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;

    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    const samples = new Uint8Array(analyser.fftSize);
    let lastPaint = 0;

    const tick = (timestamp: number) => {
      analyser.getByteTimeDomainData(samples);
      if (timestamp - lastPaint > 70) {
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        setInputLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.4));
        lastPaint = timestamp;
      }
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }

  function cleanupRecordingSession() {
    stopRecordingTimer();
    stopInputMeter();
  }

  async function startRecording() {
    cleanupRecordingSession();
    setMessage("");
    setAudioUrl("");

    if (typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      setRecordingSupported(false);
      setStatus("error");
      setMessage(t.recordingUnavailable);
      return;
    }

    setStatus("requesting_mic");

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, supportedRecorderOptions());
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stream?.getTracks().forEach((track) => track.stop());
        cleanupRecordingSession();
        mediaRecorderRef.current = null;
        setStatus("error");
        setMessage(t.recorderStartFailed);
      };
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        cleanupRecordingSession();
        mediaRecorderRef.current = null;
        if (chunksRef.current.length === 0) {
          setStatus("error");
          setMessage(t.recordingEmpty);
          return;
        }
        const file = createRecordedFile(chunksRef.current, recorder.mimeType, Date.now());
        await adoptVoiceFile(file, "recorded");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      startInputMeter(stream);
      startRecordingTimer();
      setStatus("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      cleanupRecordingSession();
      mediaRecorderRef.current = null;
      setStatus("error");
      if (error instanceof DOMException && error.name === "NotFoundError") {
        setMessage(t.micMissing);
      } else if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)) {
        setMessage(t.micPermissionDenied);
      } else {
        setMessage(t.recorderStartFailed);
      }
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.requestData();
    recorder.stop();
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      cleanupRecordingSession();
      await adoptVoiceFile(file, "uploaded");
      event.currentTarget.value = "";
    }
  }

  async function submit() {
    setMessage("");
    setAudioUrl("");
    setReferenceQuality(null);
    setLastResponse(null);

    if (!voiceFile) {
      setStatus("error");
      setMessage(t.noAudio);
      return;
    }
    if (!targetText.trim()) {
      setStatus("error");
      setMessage(t.noText);
      return;
    }
    if (!consent) {
      setStatus("error");
      setMessage(t.noConsent);
      return;
    }

    setStatus("submitting");
    const form = new FormData();
    form.set("voice", voiceFile);
    form.set("targetText", targetText);
    form.set("style", "");
    form.set("promptTranscript", "");
    form.set("consent", "yes");
    form.set("quality", "balanced");

    const response = await fetch("/api/clone", { method: "POST", body: form });
    const payload = (await response.json()) as ClonePayload;

    setLastResponse(payload);
    if (payload.referenceQuality) setReferenceQuality(payload.referenceQuality);

    if (!response.ok || payload.status === "error") {
      setStatus("error");
      setMessage(payload.message || t.errorTitle);
      return;
    }
    if (payload.status === "needs_worker") {
      setStatus("needs_worker");
      setMessage(payload.message || t.workerMissingBody);
      return;
    }
    setStatus("ready");
    setAudioUrl(payload.audioUrl || "");
  }

  const showWorkerBanner = status === "needs_worker";
  const isRecording = status === "recording" || status === "requesting_mic";
  const showOutput = status === "submitting" || status === "ready" || status === "needs_worker";
  const showInlineError = status === "error" && message;

  const sourceLabel =
    sourceKind === "sample"
      ? t.sourceSample
      : sourceKind === "recorded"
        ? t.sourceRecorded
        : t.sourceUploaded;

  const submitDisabled = status === "submitting" || isRecording;
  const recordingApproachingLimit = isRecording && recordingElapsed >= MAX_RECORDING_SECONDS - 8;
  const targetNearLimit = targetText.length >= MAX_TARGET_CHARS * 0.8;

  const warnings = useMemo(() => {
    if (!referenceQuality || !lastResponse) return [];
    return referenceQuality.warnings
      .map((code) => describeWarning(code, lastResponse, t))
      .filter((line): line is string => Boolean(line));
  }, [referenceQuality, lastResponse, t]);

  /* ---------- Sonogram bar heights ---------- */
  const sonogramBars = useMemo(() => {
    const bars = new Array(SONOGRAM_BARS).fill(0).map((_, index) => {
      if (isRecording) {
        const shape = 0.42 + Math.min(1.4, inputLevel * (1.1 + (index % 7) / 9));
        return { height: 18 + shape * 38, intensity: shape };
      }
      const peak = wavePeaks[index];
      if (peak !== undefined && peak > 0) {
        const normalized = Math.max(0.06, peak);
        return { height: 8 + normalized * 80, intensity: normalized };
      }
      const fallback = 12 + ((index * 17) % 9) * 4;
      return { height: fallback, intensity: 0.18 };
    });
    return bars;
  }, [isRecording, inputLevel, wavePeaks]);

  return (
    <main className="shell">
      <header className="app-bar" role="banner">
        <Link href="/" className="brand brand--mark-only" aria-label={t.brand}>
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
        </Link>

        <div className="app-bar-right">
          <ThemeToggle theme={theme} onChange={setTheme} labels={t} />
          <button
            className="locale-toggle"
            type="button"
            onClick={() => setLocale(locale === "zh-Hant" ? "en" : "zh-Hant")}
            aria-label="Toggle language"
          >
            {t.locale}
          </button>
        </div>
      </header>

      {showWorkerBanner ? (
        <div className="notice notice--warn" role="status">
          <span className="notice-glyph">
            <TriangleAlert size={13} />
          </span>
          <div>
            <strong>{t.workerMissingTitle}</strong>
            <p>{t.workerMissingBody}</p>
          </div>
        </div>
      ) : null}

      {showInlineError ? (
        <div className="notice notice--error" role="alert">
          <span className="notice-glyph">!</span>
          <div>
            <strong>{t.errorTitle}</strong>
            <p>{message}</p>
          </div>
        </div>
      ) : null}

      <section className="playground" aria-label="AnyVoice studio">
        {/* 1. Voice source */}
        <section className="surface surface--dark" aria-labelledby="h-voice">
          <h2 id="h-voice" className="visually-hidden">{t.sectionVoice}</h2>

          <div className="booth">
            <div className={`sonogram ${isRecording ? "is-recording" : voiceFile ? "is-captured" : "is-idle"}`} aria-hidden>
              {sonogramBars.map((bar, index) => (
                <span
                  key={index}
                  style={
                    {
                      "--i": index,
                      "--h": `${bar.height}px`,
                      opacity: 0.35 + bar.intensity * 0.55,
                    } as React.CSSProperties
                  }
                />
              ))}
              {voiceFile && !isRecording ? (
                <span
                  className="sonogram-cursor"
                  aria-hidden
                  style={{ left: `${playbackProgress * 100}%` }}
                />
              ) : null}
            </div>

            <div className="booth-actions">
              {status === "requesting_mic" ? (
                <button className="btn btn--on-dark btn--lg" type="button" disabled>
                  <Loader2 className="spin" size={16} /> {t.requestingMic}
                </button>
              ) : status === "recording" ? (
                <button className="btn btn--on-dark btn--lg" type="button" onClick={stopRecording}>
                  <CircleStop size={16} /> {t.stop}
                </button>
              ) : (
                <button
                  className="btn btn--primary btn--lg"
                  type="button"
                  onClick={startRecording}
                  disabled={!recordingSupported}
                >
                  <Mic size={16} /> {t.record}
                </button>
              )}
              <label className="btn btn--on-dark file-trigger">
                <Upload size={14} /> {t.upload}
                <input type="file" accept="audio/*" onChange={onUpload} aria-label={t.upload} />
              </label>
            </div>
          </div>

          <div className="source-readout">
            {sourceKind !== "sample" ? (
              <strong title={voiceFile?.name}>{sourceLabel}</strong>
            ) : null}
            {isRecording ? (
              <div className={`recording-cap ${recordingApproachingLimit ? "is-warn" : ""}`}>
                <strong>{formatDuration(recordingElapsed)}</strong>
                <small>/ {formatDuration(MAX_RECORDING_SECONDS)}</small>
              </div>
            ) : voiceFile ? (
              <audio
                ref={sourceAudioRef}
                controls
                src={sourcePreviewUrl}
                onTimeUpdate={(event) => {
                  const target = event.currentTarget;
                  if (target.duration) setPlaybackProgress(target.currentTime / target.duration);
                }}
                onEnded={() => setPlaybackProgress(0)}
              />
            ) : null}
          </div>
        </section>

        {/* 2. Target text */}
        <section className="surface surface--cream" aria-labelledby="h-text">
          <h2 id="h-text" className="visually-hidden">{t.sectionText}</h2>

          <div className="field">
            {targetNearLimit ? (
              <div className="field-label field-label--right">
                <span className="field-counter">
                  {targetText.length} / {MAX_TARGET_CHARS}
                </span>
              </div>
            ) : null}
            <textarea
              className="textarea is-hero"
              value={targetText}
              onChange={(event) => {
                setUserTargetText(event.target.value.slice(0, MAX_TARGET_CHARS));
              }}
              placeholder={t.targetPlaceholder}
              rows={5}
            />
          </div>
        </section>

        {/* 3. Submit panel — inline consent + generate button */}
        <div className="submit-panel">
          <label className="consent-inline">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>{t.consent}</span>
          </label>
          <button
            className="btn btn--primary btn--lg btn--submit"
            type="button"
            onClick={submit}
            disabled={submitDisabled}
          >
            {status === "submitting" ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
            {status === "submitting" ? t.submitting : t.submit}
          </button>
        </div>

        {/* 4. Output (conditional) */}
        {showOutput ? (
          <section className="surface surface--dark surface--output" aria-labelledby="h-output">
            <h2 id="h-output" className="visually-hidden">{t.outputAside}</h2>
            <div className="surface-head surface-head--bare">
              <span
                className={`output-status ${
                  status === "submitting"
                    ? "is-pending"
                    : status === "needs_worker"
                      ? "is-warn"
                      : ""
                }`}
              >
                <span className="dot" />
                {status === "submitting"
                  ? t.outputStatusPending
                  : status === "ready"
                    ? t.outputStatusReady
                    : t.outputStatusWarn}
              </span>
            </div>

            <div className="output-stack">
              <div className="output-frame">
                {status === "submitting" ? (
                  <div className="level-meter is-loading" aria-hidden>
                    {Array.from({ length: 20 }).map((_, index) => (
                      <span key={index} style={{ "--i": index } as React.CSSProperties} />
                    ))}
                  </div>
                ) : audioUrl ? (
                  <audio controls src={audioUrl} />
                ) : (
                  <p className="output-text">{message || t.workerMissingBody}</p>
                )}
                {status === "ready" && targetText ? <p className="output-text">{targetText}</p> : null}
              </div>

              {warnings.length > 0 ? (
                <ul className="reference-warnings">
                  {warnings.map((line, index) => (
                    <li key={index}>
                      <TriangleAlert size={12} /> {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function ThemeToggle({
  theme,
  onChange,
  labels,
}: {
  theme: Theme;
  onChange: (next: Theme) => void;
  labels: { themeLight: string; themeDark: string; themeSystem: string };
}) {
  const order: Theme[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const currentLabel =
    theme === "light" ? labels.themeLight : theme === "dark" ? labels.themeDark : labels.themeSystem;
  return (
    <button
      type="button"
      className="theme-cycle"
      onClick={() => onChange(next)}
      aria-label={`Theme: ${currentLabel}`}
      title={currentLabel}
    >
      <Icon size={14} />
    </button>
  );
}

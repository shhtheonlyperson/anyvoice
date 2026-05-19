"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CircleStop,
  Gauge,
  Loader2,
  Mic,
  Monitor,
  Moon,
  PlayCircle,
  Sun,
  TriangleAlert,
  Upload,
  Wand2,
} from "lucide-react";

type Locale = "zh-Hant" | "en";
type Theme = "system" | "light" | "dark";
type Status = "idle" | "requesting_mic" | "recording" | "submitting" | "ready" | "needs_worker" | "error";
type Mode = "scripted" | "freeform";
type SourceKind = "sample" | "scripted" | "freeform" | "uploaded";
type ReferenceGrade = "A" | "B" | "C" | "D";
type QualityPreset = "speed" | "balanced" | "quality";
type ProgressPhase =
  | "queued"
  | "input_saved"
  | "reference_preprocessing"
  | "reference_analyzed"
  | "model_loading"
  | "model_ready"
  | "synthesis_started"
  | "audio_ready"
  | "finalizing";

interface ReferenceQuality {
  grade: ReferenceGrade;
  durationSec: number;
  snrDb: number | null;
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
  targetLanguage?: string | null;
  effectiveParams?: {
    timesteps?: number;
    cfgValue?: number;
    denoise?: boolean;
    qualityPreset?: string;
  };
}

interface CloneProgressPayload {
  status: "progress";
  jobId: string;
  modelId: string;
  phase: ProgressPhase;
  message?: string;
  referenceQuality?: ReferenceQuality;
  effectiveParams?: ClonePayload["effectiveParams"];
}

const SONOGRAM_BARS = 64;
const MAX_TARGET_CHARS = 4096;
const MAX_TRANSCRIPT_CHARS = 1024;
const MAX_RECORDING_SECONDS = 60;
const QUALITY_PRESETS: QualityPreset[] = ["quality", "balanced", "speed"];

const SAMPLE_VOICE_URL = "/sample-voice.wav";
const SAMPLE_VOICE_FILENAME = "sample-voice.wav";

// Verified transcript of /public/sample-voice.wav (Petit Prince excerpt).
const SAMPLE_VOICE_TRANSCRIPT =
  "當你看著夜空時，因為我住在其中一顆星星上，因為我會在其中一顆星星上笑，那麼對你來說，就好像所有的星星都在笑。";

// Fixed reading script for scripted mode. Both locales selected to cover
// the dominant phonemes / tones the model needs to align speaker → text.
const SCRIPT_TEXT: Record<Locale, string> = {
  "zh-Hant":
    "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
  en:
    "Hello, I'm recording a short voice sample. The quick brown fox jumps over a lazy dog while bright sunlight breaks through the morning clouds.",
};

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
    stepRecordTitle: "步驟 1 — 錄一段你的聲音",
    scriptedIntro: "請自然地朗讀以下這段話。系統會用這段稿做為發音對齊的基準，唸越完整，合成發音越準。",
    scriptedRecordCta: "開始朗讀錄音",
    scriptedReRecordCta: "重新朗讀",
    scriptedUsing: "已錄到朗讀片段",
    freeformIntro: "自由錄製或上傳一段乾淨的人聲（5–30 秒最佳），並把這段聲音裡實際說的內容逐字打進來。",
    freeformRecordCta: "自由錄音",
    freeformReRecordCta: "重新錄音",
    transcriptLabel: "這段錄音的逐字稿（必填）",
    transcriptHelp: "請一字不漏地輸入錄音內容，包含語氣詞。逐字越精準，合成發音越準。",
    transcriptPlaceholder: "把錄音中聽到的每一個字打進來…",
    noTranscript: "請輸入這段錄音的逐字稿。",
    modeScripted: "讀稿錄音（推薦）",
    modeFreeform: "自由錄音 / 上傳",
    useSample: "或試試示範聲音",
    sourceSample: "示範聲音（小王子節錄）",
    sourceScripted: "讀稿錄音",
    sourceFreeform: "瀏覽器錄音",
    sourceUploaded: "上傳音檔",
    requestingMic: "要求麥克風",
    stop: "停止",
    upload: "上傳音檔",
    targetPlaceholder: "輸入你想讓這個聲音說出的內容…",
    consent: "我擁有這段聲音、或已取得明確授權，且不會用於冒充、詐欺或誤導聽眾。",
    submit: "產生聲音",
    submitting: "送出中",
    qualityTitle: "合成品質",
    qualityHelp: "高品質會比較慢，但通常保留聲線和發音更穩。",
    qualitySpeed: "速度",
    qualitySpeedHint: "最快回應，適合試句子。",
    qualityBalanced: "平衡",
    qualityBalancedHint: "速度和穩定性折衷。",
    qualityQuality: "高品質",
    qualityQualityHint: "較慢，優先聲音相似度。",
    guideIdle: "目標 6–20 秒、正常音量、安靜背景。",
    guideRequesting: "正在等麥克風權限。",
    guideKeepReading: "繼續讀，至少錄到 6 秒。",
    guideGoodLevel: "音量剛好，保持這個距離。",
    guideTooQuiet: "音量偏小，靠近一點或提高輸入音量。",
    guideTooLoud: "音量偏大，退遠一點避免破音。",
    guideEnough: "樣本夠長了，可以停止。",
    guideReady: "參考音已就緒。",
    guideCapturedShort: "參考音偏短，建議重錄到 6 秒以上。",
    guideCapturedLong: "參考音偏長，建議剪到 20–30 秒內。",
    progressStarting: "準備送出",
    progressQueued: "排隊中",
    progressInputSaved: "已保存輸入",
    progressReferencePreprocessing: "整理參考音",
    progressReferenceAnalyzed: "已檢查參考音",
    progressModelLoading: "載入 VoxCPM2",
    progressModelReady: "模型已就緒",
    progressSynthesisStarted: "正在合成",
    progressAudioReady: "音檔完成",
    progressFinalizing: "整理結果",
    streamFailed: "串流連線失敗，請重試。",
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
    noAudio: "請先錄一段聲音、或選擇示範聲音。",
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
    stepRecordTitle: "Step 1 — Record a sample of your voice",
    scriptedIntro:
      "Read the line below naturally. The model uses this script as the speaker → text alignment anchor — the more accurately you read it, the more accurate the generated speech.",
    scriptedRecordCta: "Start reading",
    scriptedReRecordCta: "Re-record",
    scriptedUsing: "Scripted recording captured",
    freeformIntro:
      "Record or upload a clean voice clip (5–30 s works best), then type the exact transcript of that clip word-for-word.",
    freeformRecordCta: "Record freeform",
    freeformReRecordCta: "Re-record",
    transcriptLabel: "Transcript of this recording (required)",
    transcriptHelp:
      "Type the audio word-for-word, including filler words. Accurate transcripts make pronunciation accurate.",
    transcriptPlaceholder: "Type every word you hear in the recording…",
    noTranscript: "Type the transcript of this recording first.",
    modeScripted: "Scripted (recommended)",
    modeFreeform: "Freeform / upload",
    useSample: "Or try the sample voice",
    sourceSample: "Sample voice (Petit Prince excerpt)",
    sourceScripted: "Scripted recording",
    sourceFreeform: "Browser recording",
    sourceUploaded: "Uploaded audio",
    requestingMic: "Requesting mic",
    stop: "Stop",
    upload: "Upload audio",
    targetPlaceholder: "Write the line you want this voice to say…",
    consent:
      "I own this voice recording, or have explicit permission from the speaker to use it, and I will not use it for impersonation, fraud, or to mislead listeners.",
    submit: "Generate voice",
    submitting: "Submitting",
    qualityTitle: "Synthesis quality",
    qualityHelp: "Higher quality is slower, but usually keeps voice identity and pronunciation steadier.",
    qualitySpeed: "Speed",
    qualitySpeedHint: "Fastest response for draft lines.",
    qualityBalanced: "Balanced",
    qualityBalancedHint: "Middle ground for previews.",
    qualityQuality: "Quality",
    qualityQualityHint: "Slower, prioritizes similarity.",
    guideIdle: "Aim for 6-20 seconds, normal volume, quiet background.",
    guideRequesting: "Waiting for microphone permission.",
    guideKeepReading: "Keep reading until at least 6 seconds.",
    guideGoodLevel: "Level looks good. Keep this distance.",
    guideTooQuiet: "Input is quiet. Move closer or raise gain.",
    guideTooLoud: "Input is hot. Back off to avoid clipping.",
    guideEnough: "Sample is long enough. You can stop.",
    guideReady: "Reference audio is ready.",
    guideCapturedShort: "Reference is short. Re-record past 6 seconds for better matching.",
    guideCapturedLong: "Reference is long. Trim toward 20-30 seconds for steadier cloning.",
    progressStarting: "Preparing request",
    progressQueued: "Queued",
    progressInputSaved: "Input saved",
    progressReferencePreprocessing: "Preparing reference",
    progressReferenceAnalyzed: "Reference checked",
    progressModelLoading: "Loading VoxCPM2",
    progressModelReady: "Model ready",
    progressSynthesisStarted: "Synthesizing",
    progressAudioReady: "Audio written",
    progressFinalizing: "Finalizing",
    streamFailed: "Streaming connection failed. Try again.",
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
    noAudio: "Record a clip first, or pick the sample voice.",
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
    const refLang = localizeLanguage(parts[0], t);
    const targetLang = localizeLanguage(parts[1] || payload.targetLanguage, t);
    return t.warningCrossLingual(refLang, targetLang);
  }
  if (code === "clipping" || code.startsWith("clipping")) return t.warningClipping;
  if (code === "short" || code.startsWith("short")) return t.warningShort;
  if (code === "noisy" || code === "low_snr" || code.startsWith("snr")) return t.warningNoise;
  return code;
}

function progressLabel(phase: ProgressPhase, t: typeof copy[Locale]): string {
  switch (phase) {
    case "queued":
      return t.progressQueued;
    case "input_saved":
      return t.progressInputSaved;
    case "reference_preprocessing":
      return t.progressReferencePreprocessing;
    case "reference_analyzed":
      return t.progressReferenceAnalyzed;
    case "model_loading":
      return t.progressModelLoading;
    case "model_ready":
      return t.progressModelReady;
    case "synthesis_started":
      return t.progressSynthesisStarted;
    case "audio_ready":
      return t.progressAudioReady;
    case "finalizing":
      return t.progressFinalizing;
  }
}

function isProgressPayload(value: unknown): value is CloneProgressPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { status?: unknown }).status === "progress" &&
      typeof (value as { phase?: unknown }).phase === "string",
  );
}

function isTerminalPayload(value: unknown): value is ClonePayload {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "ready" || status === "needs_worker" || status === "error";
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

  const [mode, setMode] = useState<Mode>("scripted");
  const [status, setStatus] = useState<Status>("idle");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [wavePeaks, setWavePeaks] = useState<number[]>([]);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [userTargetText, setUserTargetText] = useState<string | null>(null);
  const [freeformTranscript, setFreeformTranscript] = useState("");
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("quality");
  const [consent, setConsent] = useState(true);
  const [audioUrl, setAudioUrl] = useState("");
  const [message, setMessage] = useState("");
  const [recordingSupported, setRecordingSupported] = useState(true);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [streamEvents, setStreamEvents] = useState<CloneProgressPayload[]>([]);

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
  const recordingKindRef = useRef<"scripted" | "freeform">("scripted");

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
    setSourceDuration(null);
    setAudioUrl("");
    setStatus("idle");
    setMessage("");
    setStreamEvents([]);
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

  async function loadSampleVoice() {
    try {
      const sample = await fetchSampleVoiceFile();
      await adoptVoiceFile(sample, "sample");
    } catch {
      setStatus("error");
      setMessage(t.noAudio);
    }
  }

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

  async function startRecording(kind: "scripted" | "freeform") {
    cleanupRecordingSession();
    setMessage("");
    setAudioUrl("");
    recordingKindRef.current = kind;

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
        await adoptVoiceFile(file, recordingKindRef.current);
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

  // Resolve the transcript that pairs with the current reference audio.
  function resolvePromptTranscript(): string {
    if (sourceKind === "scripted") return SCRIPT_TEXT[locale];
    if (sourceKind === "sample") return SAMPLE_VOICE_TRANSCRIPT;
    return freeformTranscript.trim();
  }

  function handleProgressPayload(payload: CloneProgressPayload) {
    setStreamEvents((current) => [...current, payload].slice(-8));
    if (payload.referenceQuality) setReferenceQuality(payload.referenceQuality);
  }

  function handleTerminalPayload(payload: ClonePayload, responseOk = true) {
    setLastResponse(payload);
    if (payload.referenceQuality) setReferenceQuality(payload.referenceQuality);

    if (!responseOk || payload.status === "error") {
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

  async function readStreamingResponse(response: Response) {
    if (!response.body) throw new Error("missing response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalSeen = false;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = JSON.parse(trimmed) as unknown;
      if (isProgressPayload(parsed)) {
        handleProgressPayload(parsed);
        return;
      }
      if (isTerminalPayload(parsed)) {
        terminalSeen = true;
        handleTerminalPayload(parsed, response.ok);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) consumeLine(buffer);
    if (!terminalSeen && !response.ok) {
      setStatus("error");
      setMessage(t.streamFailed);
    }
  }

  async function submit() {
    setMessage("");
    setAudioUrl("");
    setReferenceQuality(null);
    setLastResponse(null);
    setStreamEvents([]);

    if (!voiceFile || !sourceKind) {
      setStatus("error");
      setMessage(t.noAudio);
      return;
    }
    if (!targetText.trim()) {
      setStatus("error");
      setMessage(t.noText);
      return;
    }
    const promptTranscript = resolvePromptTranscript();
    if (!promptTranscript) {
      setStatus("error");
      setMessage(t.noTranscript);
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
    form.set("promptTranscript", promptTranscript);
    form.set("consent", "yes");
    form.set("quality", qualityPreset);

    try {
      const response = await fetch("/api/clone/stream", { method: "POST", body: form });
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/x-ndjson")) {
        await readStreamingResponse(response);
        return;
      }
      const payload = (await response.json()) as ClonePayload;
      handleTerminalPayload(payload, response.ok);
    } catch {
      setStatus("error");
      setMessage(t.streamFailed);
    }
  }

  const showWorkerBanner = status === "needs_worker";
  const isRecording = status === "recording" || status === "requesting_mic";
  const showOutput = status === "submitting" || status === "ready" || status === "needs_worker";
  const showInlineError = status === "error" && message;

  const sourceLabel =
    sourceKind === "sample"
      ? t.sourceSample
      : sourceKind === "scripted"
        ? t.sourceScripted
        : sourceKind === "freeform"
          ? t.sourceFreeform
          : sourceKind === "uploaded"
            ? t.sourceUploaded
            : "";

  const submitDisabled = status === "submitting" || isRecording;
  const recordingApproachingLimit = isRecording && recordingElapsed >= MAX_RECORDING_SECONDS - 8;
  const targetNearLimit = targetText.length >= MAX_TARGET_CHARS * 0.8;

  const qualityMeta = {
    speed: { label: t.qualitySpeed, hint: t.qualitySpeedHint },
    balanced: { label: t.qualityBalanced, hint: t.qualityBalancedHint },
    quality: { label: t.qualityQuality, hint: t.qualityQualityHint },
  } satisfies Record<QualityPreset, { label: string; hint: string }>;

  const recordingGuide = useMemo(() => {
    if (status === "requesting_mic") return { tone: "info", text: t.guideRequesting };
    if (isRecording) {
      if (inputLevel > 0.82) return { tone: "warn", text: t.guideTooLoud };
      if (recordingElapsed > 1.2 && inputLevel < 0.04) return { tone: "warn", text: t.guideTooQuiet };
      if (recordingElapsed < 6) return { tone: "info", text: t.guideKeepReading };
      if (recordingElapsed >= 20) return { tone: "ready", text: t.guideEnough };
      return { tone: "ready", text: t.guideGoodLevel };
    }
    if (voiceFile) {
      if (sourceDuration !== null && sourceDuration < 4) return { tone: "warn", text: t.guideCapturedShort };
      if (sourceDuration !== null && sourceDuration > 30) return { tone: "warn", text: t.guideCapturedLong };
      return { tone: "ready", text: t.guideReady };
    }
    return { tone: "info", text: t.guideIdle };
  }, [inputLevel, isRecording, recordingElapsed, sourceDuration, status, t, voiceFile]);

  const warnings = useMemo(() => {
    if (!referenceQuality || !lastResponse) return [];
    return referenceQuality.warnings
      .map((code) => describeWarning(code, lastResponse, t))
      .filter((line): line is string => Boolean(line));
  }, [referenceQuality, lastResponse, t]);

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

  const hasReferenceInMode =
    voiceFile !== null &&
    ((mode === "scripted" && (sourceKind === "scripted" || sourceKind === "sample")) ||
      (mode === "freeform" && (sourceKind === "freeform" || sourceKind === "uploaded")));

  const progressRows =
    streamEvents.length > 0
      ? streamEvents
      : status === "submitting"
        ? [
            {
              status: "progress" as const,
              jobId: "pending",
              modelId: "",
              phase: "queued" as const,
              message: t.progressStarting,
            },
          ]
        : [];

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

          <div className="step-header">
            <strong className="step-title">{t.stepRecordTitle}</strong>
            <div className="mode-tabs" role="tablist" aria-label={t.sectionVoice}>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "scripted"}
                className={`mode-tab ${mode === "scripted" ? "is-active" : ""}`}
                onClick={() => setMode("scripted")}
              >
                {t.modeScripted}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "freeform"}
                className={`mode-tab ${mode === "freeform" ? "is-active" : ""}`}
                onClick={() => setMode("freeform")}
              >
                {t.modeFreeform}
              </button>
            </div>
          </div>

          {mode === "scripted" ? (
            <div className="script-card">
              <p className="script-intro">{t.scriptedIntro}</p>
              <blockquote className="script-text" lang={locale}>
                {SCRIPT_TEXT[locale]}
              </blockquote>
            </div>
          ) : (
            <p className="script-intro">{t.freeformIntro}</p>
          )}

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
              ) : mode === "scripted" ? (
                <>
                  <button
                    className="btn btn--primary btn--lg"
                    type="button"
                    onClick={() => startRecording("scripted")}
                    disabled={!recordingSupported}
                  >
                    <Mic size={16} />{" "}
                    {hasReferenceInMode && sourceKind === "scripted"
                      ? t.scriptedReRecordCta
                      : t.scriptedRecordCta}
                  </button>
                  <button className="btn btn--on-dark" type="button" onClick={loadSampleVoice}>
                    <PlayCircle size={14} /> {t.useSample}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn btn--primary btn--lg"
                    type="button"
                    onClick={() => startRecording("freeform")}
                    disabled={!recordingSupported}
                  >
                    <Mic size={16} />{" "}
                    {hasReferenceInMode && sourceKind === "freeform"
                      ? t.freeformReRecordCta
                      : t.freeformRecordCta}
                  </button>
                  <label className="btn btn--on-dark file-trigger">
                    <Upload size={14} /> {t.upload}
                    <input type="file" accept="audio/*" onChange={onUpload} aria-label={t.upload} />
                  </label>
                </>
              )}
            </div>
          </div>

          <div className={`recording-guide is-${recordingGuide.tone}`} role="status">
            <span aria-hidden />
            <p>{recordingGuide.text}</p>
          </div>

          <div className="source-readout">
            {sourceKind ? <strong title={voiceFile?.name}>{sourceLabel}</strong> : null}
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
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  if (Number.isFinite(duration)) setSourceDuration(duration);
                }}
                onEnded={() => setPlaybackProgress(0)}
              />
            ) : null}
          </div>

          {mode === "freeform" ? (
            <div className="field field--transcript">
              <label className="field-label" htmlFor="freeform-transcript">
                <strong>{t.transcriptLabel}</strong>
                <span className="field-hint">{t.transcriptHelp}</span>
              </label>
              <textarea
                id="freeform-transcript"
                className="textarea"
                value={freeformTranscript}
                onChange={(event) =>
                  setFreeformTranscript(event.target.value.slice(0, MAX_TRANSCRIPT_CHARS))
                }
                placeholder={t.transcriptPlaceholder}
                rows={3}
              />
            </div>
          ) : null}
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

        {/* 3. Submit panel */}
        <div className="submit-panel">
          <div className="submit-settings">
            <div className="quality-control">
              <div className="quality-copy">
                <Gauge size={16} aria-hidden />
                <div>
                  <strong>{t.qualityTitle}</strong>
                  <span>{t.qualityHelp}</span>
                </div>
              </div>
              <div className="quality-options" role="radiogroup" aria-label={t.qualityTitle}>
                {QUALITY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    className={`quality-option ${qualityPreset === preset ? "is-active" : ""}`}
                    type="button"
                    role="radio"
                    aria-checked={qualityPreset === preset}
                    onClick={() => setQualityPreset(preset)}
                  >
                    <strong>{qualityMeta[preset].label}</strong>
                    <span>{qualityMeta[preset].hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="consent-inline">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>{t.consent}</span>
            </label>
          </div>
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

        {/* 4. Output */}
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

              {progressRows.length > 0 ? (
                <ol className="progress-list" aria-label="Synthesis progress">
                  {progressRows.map((event, index) => (
                    <li key={`${event.phase}-${index}`} className={index === progressRows.length - 1 ? "is-current" : ""}>
                      <span className="progress-dot" aria-hidden />
                      <span>{progressLabel(event.phase, t)}</span>
                    </li>
                  ))}
                </ol>
              ) : null}

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

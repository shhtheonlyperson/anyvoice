"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookReader } from "@/components/BookReader";
import {
  parsePronunciationOverrides,
  prepareVoiceText,
  serializePronunciationOverride,
  strictTraditionalChineseScriptErrors,
  suggestPronunciationOverrides,
  type PronunciationOverride,
} from "@/lib/text-prep";

/* ---------------------------------------------------------------- types */

type Locale = "zh-Hant" | "en";
type Theme = "light" | "dark";
type Screen = "generate" | "build" | "book";
type GenState = "idle" | "busy" | "done" | "needs_worker" | "error";
type ClipState = "idle" | "ok" | "bad";
type SourceKind = "scripted";

interface ClonePayload {
  status: "ready" | "needs_worker" | "error" | "progress";
  audioUrl?: string;
  message?: string;
  jobId?: string;
  phase?: string;
}

interface VoiceProfilePayload {
  status: "ready" | "needs_enrollment";
  usable?: boolean;
  studioGrade?: boolean;
  summary: {
    eligibleClips: number;
    selectedClips: number;
    rejectedClips: number;
    remainingClipsNeeded: number;
  };
  requirements: {
    minClips: number;
    maxClips: number;
    minDurationSec: number;
    maxDurationSec: number;
    passingGrades?: string[];
  };
  referenceClipIds?: string[];
  clips?: { transcriptRaw?: string }[];
}

interface VoiceProfileListItem {
  id: string;
  displayName: string;
  status: "ready" | "needs_enrollment";
  usable?: boolean;
  studioGrade?: boolean;
  clipCount: number;
}

interface ReferenceQuality {
  grade: "A" | "B" | "C" | "D";
  durationSec: number;
  warnings: string[];
}

interface BrowserCaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
}

interface VoiceProfileEnrollmentPayload {
  status: "enrolled" | "error";
  message?: string;
  profile?: VoiceProfilePayload;
  referenceQuality?: ReferenceQuality;
}

interface RunHistoryItem {
  id: string;
  status: string;
  targetText: string;
  audioUrl?: string;
  createdAt: string;
}

/* ------------------------------------------------------- preserved data */


const DEFAULT_QUALITY = "balanced";

// Playback speeds offered on generated audio.
const SPEEDS = [1, 1.25, 1.5, 2] as const;

// Profile enrollment duration gate (analyzer requires 6–20s; grade A wants this band).
const REC_MIN_SEC = 6;
const REC_MAX_SEC = 20;

const VOICE_CAPTURE_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  autoGainControl: { ideal: false },
} satisfies MediaTrackConstraints;
const VOICE_CAPTURE_MEDIA_CONSTRAINTS = {
  audio: VOICE_CAPTURE_AUDIO_CONSTRAINTS,
} satisfies MediaStreamConstraints;

// Fixed reading scripts for profile enrollment (Traditional Chinese / English).
const SCRIPT_PACK: Record<Locale, string[]> = {
  "zh-Hant": [
    "你好，我正在錄製一段聲音樣本。春天的陽光灑在湖面上，遠方傳來陣陣鳥鳴，世界顯得格外安靜。",
    "日期範例是二零二六年五月二十日，我會用自然的速度，把每一句話清楚地讀完。",
    "如果遇到重要名字，例如 Brenda、AnyVoice、台北、紐約、重慶、銀行、角色、音樂和長樂，我會保持穩定的音量與節奏。",
    "這段錄音包含高低起伏、停頓和短句，目的是讓數位聲音更接近我平常說話的方式。",
    "請確認錄音環境安靜、沒有回音，也不要離麥克風太近，讓聲音保持乾淨自然。",
  ],
  en: [
    "Hello, I'm recording a short voice sample. The quick brown fox jumps over a lazy dog while bright sunlight breaks through the morning clouds.",
    "The date example is May twentieth, twenty twenty-six, and I will read each sentence clearly at a natural pace.",
    "When I say names like Brenda, AnyVoice, Taipei, and New York, I keep my volume and rhythm steady.",
    "This recording includes pitch changes, pauses, and short phrases so the digital voice sounds closer to my normal speech.",
    "Please make sure the room is quiet, avoid echo, and keep a comfortable distance from the microphone.",
  ],
};
const SCRIPT_COUNT = SCRIPT_PACK["zh-Hant"].length;

// Pronunciation cue chips per script line (latin terms / polyphones to watch).
const SCRIPT_CUES: Record<number, string[]> = {
  2: ["Brenda", "AnyVoice", "重慶", "銀行", "長樂"],
};

/* ----------------------------------------------------------- helpers */

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

function browserCaptureSettings(stream: MediaStream): BrowserCaptureSettings | null {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() as MediaTrackSettings | undefined;
  if (!settings) return null;
  return {
    ...(typeof settings.echoCancellation === "boolean" ? { echoCancellation: settings.echoCancellation } : {}),
    ...(typeof settings.noiseSuppression === "boolean" ? { noiseSuppression: settings.noiseSuppression } : {}),
    ...(typeof settings.autoGainControl === "boolean" ? { autoGainControl: settings.autoGainControl } : {}),
    ...(typeof settings.sampleRate === "number" ? { sampleRate: settings.sampleRate } : {}),
    ...(typeof settings.channelCount === "number" ? { channelCount: settings.channelCount } : {}),
  };
}

// Block Simplified / mixed / unproven Chinese (real product safety contract).
// Pure non-Chinese (English) target text is allowed.
function isUnstableChineseScript(text: string): boolean {
  if (!text.trim()) return false;
  const errors = strictTraditionalChineseScriptErrors(text);
  return errors.includes("invalid_chinese_script") || errors.includes("unproven_chinese_script");
}

function isProgressPayload(value: unknown): value is ClonePayload {
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

/* ------------------------------------------------------------- i18n */

type Copy = {
  languageName: string;
  switchLang: string;
  navGenerate: string;
  navBuild: string;
  navBook: string;
  themeLabel: string;
  eyebrow: string;
  h1: string;
  lede: string;
  voiceLabel: string;
  voiceSample: string;
  voiceMine: string;
  voiceMineHint: string;
  voiceUpload: string;
  uploadHint: string;
  uploadPick: string;
  uploadPicked: (name: string) => string;
  uploadTranscriptLabel: string;
  uploadTranscriptPlaceholder: string;
  textLabel: string;
  placeholder: string;
  generate: string;
  generating: string;
  chars: string;
  pronTitle: string;
  pronApply: (term: string, replacement: string) => string;
  modelPreviewTitle: string;
  modelPreviewRaw: string;
  modelPreviewModel: string;
  outLabel: string;
  download: string;
  regenerate: string;
  play: string;
  speedLabel: string;
  historyTitle: string;
  historyEmpty: string;
  workerMissing: string;
  genError: string;
  scriptBlocked: string;
  buildEyebrow: string;
  buildH1: string;
  buildLede: string;
  progress: (d: number, total: number) => string;
  promptOf: (n: number, total: number) => string;
  cueLabel: string;
  recordStart: string;
  recordHint: string;
  recording: string;
  recordKeepGoing: (min: number) => string;
  recordReadyToStop: string;
  stop: string;
  enrolling: string;
  enrollFailed: string;
  enrollRejected: string;
  enrollTooShort: (sec: number, min: number) => string;
  enrollTooLong: (sec: number, max: number) => string;
  enrollLowVoice: string;
  enrollNoisy: string;
  enrollClipping: string;
  enrollScriptBlocked: string;
  youtubeTitle: string;
  youtubeHint: string;
  youtubeNotice: string;
  youtubeUrlPlaceholder: string;
  youtubeConsent: string;
  youtubeImport: string;
  youtubeImporting: string;
  youtubeNoCaptions: string;
  youtubeOk: string;
  youtubeFailed: string;
  profileLabel: string;
  profileCreate: string;
  profileManage: string;
  profileRename: string;
  profileDelete: string;
  profileDeleteConfirm: string;
  profileNamePlaceholder: string;
  profileSave: string;
  profileCancel: string;
  profileActive: (name: string) => string;
  statusUsable: string;
  statusStudio: string;
  statusNeedsClip: string;
  micBlocked: string;
  micProcessing: string;
  listTitle: string;
  stOk: string;
  stBad: string;
  stIdle: string;
  doneH1: string;
  doneLede: string;
  doneCta: string;
  advTitle: string;
  advHint: string;
  adv1: string;
  adv2: string;
  adv3: string;
  adv4: string;
};

const COPY: Record<Locale, Copy> = {
  "zh-Hant": {
    languageName: "繁體中文",
    switchLang: "EN",
    navGenerate: "產生聲音",
    navBuild: "建立我的聲音",
    navBook: "有聲書",
    themeLabel: "切換深淺色",
    eyebrow: "數位聲音複製",
    h1: "讓你的聲音說任何話",
    lede: "用一段你錄好的聲音，輸入文字就能生成自然的語音。先建立你的聲音檔案，之後每次只要打字。",
    voiceLabel: "選擇聲音",
    voiceSample: "範例聲音",
    voiceMine: "我的聲音",
    voiceMineHint: "先建立你的聲音檔案才能使用",
    voiceUpload: "我的錄音",
    uploadHint: "上傳一段你自己的乾淨錄音（6 秒以上最佳），並打上這段錄音實際說的內容，即可立即複製你的聲音。",
    uploadPick: "選擇音檔",
    uploadPicked: (name) => `已選：${name}`,
    uploadTranscriptLabel: "這段錄音說了什麼（逐字）",
    uploadTranscriptPlaceholder: "把錄音裡實際說的話一字不差打進來…",
    textLabel: "想說的內容",
    placeholder: "輸入你想讓這個聲音說出的內容…",
    generate: "產生聲音",
    generating: "生成中…",
    chars: "字",
    pronTitle: "建議的發音替換",
    pronApply: (term, replacement) => `${term} → ${replacement}`,
    modelPreviewTitle: "模型輸入預覽",
    modelPreviewRaw: "原文",
    modelPreviewModel: "模型",
    outLabel: "生成結果",
    download: "下載 WAV",
    regenerate: "重新生成",
    play: "播放",
    speedLabel: "播放速度",
    historyTitle: "最近生成",
    historyEmpty: "生成的聲音會保留在這裡。",
    workerMissing: "後端 worker 尚未就緒，請稍後再試。",
    genError: "生成失敗，請再試一次。",
    scriptBlocked: "目標文字含簡體或混用字，使用我的聲音時請改為繁體中文。",
    buildEyebrow: "聲音檔案",
    buildH1: "建立你的數位聲音",
    buildLede: "錄製引導語句，安靜環境、照稿自然唸即可。每段至少 6 秒、不超過 20 秒。",
    progress: (d, total) => `已完成 ${d} / ${total} 段`,
    promptOf: (n, total) => `第 ${n} 段 · 共 ${total} 段`,
    cueLabel: "發音提示",
    recordStart: "開始錄音",
    recordHint: "點擊開始 · 每段 6–20 秒，連續把整句唸完",
    recording: "錄音中…",
    recordKeepGoing: (min) => `再講一下，至少要 ${min} 秒才能存（這是音質沒問題、時長不足造成的）。`,
    recordReadyToStop: "已達標，點擊停止並儲存",
    stop: "停止並儲存",
    enrolling: "處理中…",
    enrollFailed: "這段沒有通過，請重錄。",
    enrollRejected: "這段沒有通過，請重錄。",
    enrollTooShort: (sec, min) => `這段只有 ${sec.toFixed(1)} 秒，太短了。請連續唸滿至少 ${min} 秒（音質其實沒問題）。`,
    enrollTooLong: (sec, max) => `這段有 ${sec.toFixed(1)} 秒，太長了。請控制在 ${max} 秒以內。`,
    enrollLowVoice: "中間停頓或留白太多，有效人聲不足。請照稿連續唸、減少停頓。",
    enrollNoisy: "背景雜訊偏高，請在更安靜的環境重錄。",
    enrollClipping: "音量過大造成削波，請降低輸入音量或離麥克風遠一點。",
    enrollScriptBlocked: "稿件含簡體或混用字，無法錄製。",
    youtubeTitle: "從 YouTube 匯入聲音",
    youtubeHint: "貼上 YouTube 影片網址即可擷取聲音來複製。網址含 &t=（例如 &t=300 代表從 5:00 開始）就會從該時間點掃描約 3 分鐘，自動切成多段參考片段建立聲音。逐字稿會自動從字幕或語音辨識取得；下方欄位選填，只在想修正時才需填寫。",
    youtubeNotice: "僅供個人與研究用途。請確認你有權使用這段聲音。",
    youtubeUrlPlaceholder: "https://www.youtube.com/watch?v=…&t=300",
    youtubeConsent: "我確認此匯入僅供個人／研究用途，且我有權使用這段聲音。",
    youtubeImport: "匯入",
    youtubeImporting: "匯入中…（下載與分析需要一點時間）",
    youtubeNoCaptions: "這段沒有字幕，請改貼上有字幕的片段，或在下方自行輸入逐字稿。",
    youtubeOk: "匯入成功，聲音已建立。",
    youtubeFailed: "匯入失敗，請確認網址或稍後再試。",
    profileLabel: "聲音",
    profileCreate: "新增聲音",
    profileManage: "管理",
    profileRename: "重新命名",
    profileDelete: "刪除",
    profileDeleteConfirm: "確定要刪除這個聲音及其錄音嗎？",
    profileNamePlaceholder: "幫這個聲音取個名字（例如：我的聲音、Sunny 財經）",
    profileSave: "儲存",
    profileCancel: "取消",
    profileActive: (name) => `目前聲音：${name}`,
    statusUsable: "可使用",
    statusStudio: "錄音室等級",
    statusNeedsClip: "尚未建立",
    micBlocked: "無法取得麥克風權限。",
    micProcessing: "偵測到麥克風仍開啟降噪或回音消除，請關閉後重試。",
    listTitle: "全部語句",
    stOk: "已通過",
    stBad: "需重錄",
    stIdle: "待錄",
    doneH1: "你的聲音已就緒",
    doneLede: "所有語句都通過了，現在可以用你的聲音生成任何文字。",
    doneCta: "開始產生聲音",
    advTitle: "開發者",
    advHint: "品質驗證、proof、LoRA 訓練等在指令列執行。",
    adv1: "嚴格 profile 驗證",
    adv2: "prompt vs hi-fi 品質閘門",
    adv3: "匯出 LoRA 訓練資料",
    adv4: "後端 shootout (IndexTTS2/F5)",
  },
  en: {
    languageName: "EN",
    switchLang: "繁體中文",
    navGenerate: "Generate",
    navBuild: "Build my voice",
    navBook: "Audiobook",
    themeLabel: "Toggle theme",
    eyebrow: "Digital voice clone",
    h1: "Make your voice say anything",
    lede: "Record your voice once, then type text to generate natural speech. Build your voice profile first — after that, just type.",
    voiceLabel: "Choose a voice",
    voiceSample: "Sample voice",
    voiceMine: "My voice",
    voiceMineHint: "Build your voice profile to use this",
    voiceUpload: "My recording",
    uploadHint: "Upload a clean recording of yourself (6s+ is best) and type exactly what it says — clones your voice instantly.",
    uploadPick: "Choose audio file",
    uploadPicked: (name) => `Selected: ${name}`,
    uploadTranscriptLabel: "What the recording says (verbatim)",
    uploadTranscriptPlaceholder: "Type exactly what's spoken in the recording…",
    textLabel: "What to say",
    placeholder: "Write the line you want this voice to say…",
    generate: "Generate voice",
    generating: "Generating…",
    chars: "chars",
    pronTitle: "Suggested pronunciation fixes",
    pronApply: (term, replacement) => `${term} → ${replacement}`,
    modelPreviewTitle: "Model input preview",
    modelPreviewRaw: "Raw",
    modelPreviewModel: "Model",
    outLabel: "Result",
    download: "Download WAV",
    regenerate: "Regenerate",
    play: "Play",
    speedLabel: "Speed",
    historyTitle: "Recent",
    historyEmpty: "Your generated audio is kept here.",
    workerMissing: "The backend worker isn't ready yet. Try again shortly.",
    genError: "Generation failed. Please try again.",
    scriptBlocked: "Target text is Simplified or mixed Chinese. Use Traditional Chinese with My voice.",
    buildEyebrow: "Voice profile",
    buildH1: "Build your digital voice",
    buildLede: "Record the guided lines in a quiet room, reading naturally. Each line 6–20 seconds.",
    progress: (d, total) => `${d} of ${total} done`,
    promptOf: (n, total) => `Line ${n} of ${total}`,
    cueLabel: "Pronunciation",
    recordStart: "Start recording",
    recordHint: "Tap to start · 6–20s, read the whole line without pausing",
    recording: "Recording…",
    recordKeepGoing: (min) => `Keep going — needs at least ${min}s to save (your audio is fine, it's just too short).`,
    recordReadyToStop: "Long enough — tap to stop & save",
    stop: "Stop & save",
    enrolling: "Processing…",
    enrollFailed: "This line didn't pass. Please re-record.",
    enrollRejected: "This line didn't pass. Please re-record.",
    enrollTooShort: (sec, min) => `Only ${sec.toFixed(1)}s — too short. Read continuously for at least ${min}s (the audio itself is fine).`,
    enrollTooLong: (sec, max) => `${sec.toFixed(1)}s — too long. Keep it under ${max}s.`,
    enrollLowVoice: "Too much silence/pausing — not enough active voice. Read the line continuously.",
    enrollNoisy: "Background noise is high. Re-record in a quieter room.",
    enrollClipping: "Volume too high (clipping). Lower input gain or move back from the mic.",
    enrollScriptBlocked: "Script is Simplified or mixed Chinese and can't be recorded.",
    youtubeTitle: "Import a voice from YouTube",
    youtubeHint: "Paste a YouTube URL to grab a voice to clone. A URL with &t= (e.g. &t=300 = start at 5:00) scans ~3 minutes from that point and auto-splits it into several reference clips. The transcript is captured automatically from captions or speech recognition; the field below is optional, for corrections only.",
    youtubeNotice: "Personal & research use only. Confirm you have the right to use this voice.",
    youtubeUrlPlaceholder: "https://www.youtube.com/watch?v=…&t=300",
    youtubeConsent: "I confirm this import is for personal/research use and I have the right to use this voice.",
    youtubeImport: "Import",
    youtubeImporting: "Importing… (download + analysis takes a moment)",
    youtubeNoCaptions: "No captions in this window — pick a captioned section or type the transcript below.",
    youtubeOk: "Imported — your voice is built.",
    youtubeFailed: "Import failed. Check the URL or try again later.",
    profileLabel: "Voice",
    profileCreate: "New voice",
    profileManage: "Manage",
    profileRename: "Rename",
    profileDelete: "Delete",
    profileDeleteConfirm: "Delete this voice and its recordings?",
    profileNamePlaceholder: "Name this voice (e.g. My voice, Sunny finance)",
    profileSave: "Save",
    profileCancel: "Cancel",
    profileActive: (name) => `Voice: ${name}`,
    statusUsable: "Usable",
    statusStudio: "Studio-grade",
    statusNeedsClip: "Not built",
    micBlocked: "Couldn't get microphone permission.",
    micProcessing: "The mic still has noise suppression / echo cancellation on. Disable it and retry.",
    listTitle: "All lines",
    stOk: "Passed",
    stBad: "Re-record",
    stIdle: "Pending",
    doneH1: "Your voice is ready",
    doneLede: "All lines passed. You can now generate any text in your voice.",
    doneCta: "Start generating",
    advTitle: "Developer",
    advHint: "Quality gate, proof, LoRA training run in the CLI.",
    adv1: "Strict profile verify",
    adv2: "prompt vs hi-fi quality gate",
    adv3: "Export LoRA dataset",
    adv4: "Backend shootout (IndexTTS2/F5)",
  },
};

const ADV_COMMANDS: Array<[keyof Copy, string]> = [
  ["adv1", "verify_voice_profile_ready.py"],
  ["adv2", "run_voice_quality_gate.py --clone-mode both"],
  ["adv3", "prepare_voice_lora_dataset.py"],
  ["adv4", "prepare_voice_backend_shootout.py"],
];

function Spike() {
  return (
    <svg className="spike" viewBox="0 0 24 24" aria-hidden="true">
      {[0, 45, 90, 135].map((a) => (
        <rect key={a} x="11" y="2" width="2" height="20" rx="1" fill="var(--primary)" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

// Flattened, centered controls below a player: speed options + download (+ optional
// regenerate). Replaces the native <audio> ⋮ overflow menu (which we suppress via
// controlsList) so every option is visible and consistent across result + history.
function PlayerMenu({
  speed,
  setSpeed,
  downloadUrl,
  onRegenerate,
  variant,
  speedLabel,
  downloadLabel,
  regenerateLabel,
}: {
  speed: number;
  setSpeed: (s: number) => void;
  downloadUrl: string;
  onRegenerate?: () => void;
  variant: "dark" | "cream";
  speedLabel: string;
  downloadLabel: string;
  regenerateLabel?: string;
}) {
  const btnClass = variant === "cream" ? "btn btn--secondary" : "btn btn--on-dark";
  return (
    <div className={"player-menu" + (variant === "cream" ? " player-menu--cream" : "")}>
      <div className="speed-group" role="group" aria-label={speedLabel}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={"speedbtn" + (speed === s ? " speedbtn--on" : "")}
            aria-pressed={speed === s}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      <a className={btnClass} href={downloadUrl} download>
        {downloadLabel}
      </a>
      {onRegenerate && regenerateLabel && (
        <button className={btnClass} onClick={onRegenerate}>
          {regenerateLabel}
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- component */

export function VoiceCloneStudio() {
  const [locale, setLocale] = useState<Locale>("zh-Hant");
  const [theme, setTheme] = useState<Theme>("light");
  // Build your voice is step 1; generation is unlocked only once it's ready.
  const [screen, setScreen] = useState<Screen>("build");
  const t = COPY[locale];
  const scripts = SCRIPT_PACK[locale];

  // persisted locale + theme — read after mount (localStorage is unavailable
  // during SSR; a lazy initializer would cause a hydration mismatch).
  useEffect(() => {
    try {
      const storedLocale = window.localStorage.getItem("anyvoice:locale");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-mount hydration
      if (storedLocale === "en" || storedLocale === "zh-Hant") setLocale(storedLocale);
      const storedTheme = window.localStorage.getItem("anyvoice:theme");
      if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("anyvoice:locale", locale);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.documentElement.dataset.locale = locale;
    }
  }, [locale]);
  useEffect(() => {
    try {
      window.localStorage.setItem("anyvoice:theme", theme);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ---- generate state (one voice: yours, from your profile)
  const [text, setText] = useState("");
  const [pronText, setPronText] = useState("");
  const [gen, setGen] = useState<GenState>("idle");
  const [audioUrl, setAudioUrl] = useState("");
  const [genMessage, setGenMessage] = useState("");
  const [speed, setSpeed] = useState(1);
  const [history, setHistory] = useState<RunHistoryItem[]>([]);

  // ---- profile state
  const [profile, setProfile] = useState<VoiceProfilePayload | null>(null);
  // Draft generation can use a usable voice; audiobook requires the strict curated bar.
  const profileUsable = profile?.usable ?? profile?.status === "ready";
  const profileReady = Boolean(profile?.studioGrade); // studio-grade (kept for Book/long-form gates)
  // ---- multiple voice profiles
  const [profiles, setProfiles] = useState<VoiceProfileListItem[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("local-default");
  const [profileDraft, setProfileDraft] = useState("");
  const [profileEditing, setProfileEditing] = useState<"create" | "rename" | null>(null);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  // Top-bar picker can expand to reach create/rename/delete on every screen.
  const [profileManageOpen, setProfileManageOpen] = useState(false);

  // Per-voice status indicator for the picker (Studio-grade ✓ / Usable / Not built).
  function statusLabelFor(p: Pick<VoiceProfileListItem, "studioGrade" | "usable" | "status">): string {
    if (p.studioGrade ?? p.status === "ready") return t.statusStudio;
    if (p.usable) return t.statusUsable;
    return t.statusNeedsClip;
  }

  // ---- build state
  const [clips, setClips] = useState<ClipState[]>(() => SCRIPT_PACK["zh-Hant"].map(() => "idle"));
  const [cur, setCur] = useState(0);
  const [recording, setRecording] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [buildMessage, setBuildMessage] = useState("");
  const [elapsed, setElapsed] = useState(0);
  // ---- YouTube import (build screen disclosure)
  const [ytUrl, setYtUrl] = useState("");
  const [ytTranscript, setYtTranscript] = useState("");
  const [ytNeedTranscript, setYtNeedTranscript] = useState(false);
  const [ytConsent, setYtConsent] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytMessage, setYtMessage] = useState("");
  const [ytError, setYtError] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);

  const done = clips.filter((c) => c === "ok").length;
  // A ready profile means the voice is built, even if more clips were enrolled
  // (via the extended kit) than the 5 fixed prompts shown in this checklist.
  const allDone = profileReady || done === SCRIPT_COUNT;

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/runs?limit=12", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: RunHistoryItem[] };
      setHistory((payload.items ?? []).filter((it) => it.status === "ready" && it.audioUrl));
    } catch {
      /* offline / SSR */
    }
  }, []);

  const loadVoiceProfile = useCallback(async (profileId: string) => {
    try {
      const response = await fetch(`/api/voice-profile?profileId=${encodeURIComponent(profileId)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { profile?: VoiceProfilePayload };
      if (!payload.profile) return;
      setProfile(payload.profile);
      // Reflect this profile's enrolled clips in the build checklist (and clear
      // ticks that belong to other profiles when switching).
      const enrolled = new Set(
        (payload.profile.clips ?? [])
          .map((c) => (c.transcriptRaw ?? "").trim())
          .filter(Boolean),
      );
      setClips(SCRIPT_PACK["zh-Hant"].map((prompt) => (enrolled.has(prompt.trim()) ? "ok" : "idle")));
      setCur(0);
    } catch {
      /* offline / SSR */
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const response = await fetch("/api/voice-profile/profiles", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { profiles?: VoiceProfileListItem[] };
      const list = payload.profiles ?? [];
      setProfiles(list);
      setActiveProfileId((current) => {
        const stored =
          typeof window !== "undefined" ? window.localStorage.getItem("anyvoice:activeProfile") : null;
        if (stored && list.some((p) => p.id === stored)) return stored;
        if (list.some((p) => p.id === current)) return current;
        return list[0]?.id ?? "local-default";
      });
    } catch {
      /* offline / SSR */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async profile/history load after mount
    void loadProfiles();
    void loadHistory();
  }, [loadProfiles, loadHistory]);

  // Load the active profile's summary whenever the selection changes, and
  // persist the choice so it survives reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem("anyvoice:activeProfile", activeProfileId);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async summary load on profile switch
    void loadVoiceProfile(activeProfileId);
  }, [activeProfileId, loadVoiceProfile]);

  // Restore persisted playback speed after mount (localStorage is SSR-unsafe).
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem("anyvoice:speed"));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-mount hydration
      if (SPEEDS.includes(stored as (typeof SPEEDS)[number])) setSpeed(stored);
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Persist speed and apply it to every audio element (result + history rows).
  useEffect(() => {
    try {
      window.localStorage.setItem("anyvoice:speed", String(speed));
    } catch {
      /* storage unavailable */
    }
    document.querySelectorAll("audio").forEach((a) => {
      (a as HTMLAudioElement).playbackRate = speed;
    });
  }, [speed, audioUrl, history]);

  // Clear any live recording timers if the component unmounts mid-take.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (autoStopRef.current) window.clearTimeout(autoStopRef.current);
    };
  }, []);

  // ---- pronunciation
  const pronParsed = useMemo(() => parsePronunciationOverrides(pronText), [pronText]);
  const pronOverrides = pronParsed.overrides;
  const pronSuggestions = useMemo(
    () => suggestPronunciationOverrides(text, pronOverrides),
    [text, pronOverrides],
  );
  const preparedTarget = useMemo(
    () =>
      prepareVoiceText(text, {
        pronunciationOverrides: pronOverrides,
        autoApplyPresetPronunciations: true,
      }),
    [text, pronOverrides],
  );
  const showModelPreview = text.trim().length > 0 && preparedTarget.raw !== preparedTarget.model;

  function applyPronunciation(term: string, override: PronunciationOverride) {
    setPronText((current) => {
      const parsed = parsePronunciationOverrides(current);
      if (parsed.overrides.some((o) => o.term === term)) return current;
      const line = serializePronunciationOverride(override);
      return current.trim() ? `${current.trim()}\n${line}` : line;
    });
  }

  /* ----------------------------- voice profile management */

  function switchProfile(id: string) {
    setProfileEditing(null);
    setProfileDraft("");
    setBuildMessage("");
    setActiveProfileId(id); // effect reloads the summary + checklist for it
  }

  async function createProfileFromDraft() {
    const displayName = profileDraft.trim();
    if (!displayName) return;
    try {
      const res = await fetch("/api/voice-profile/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const payload = (await res.json()) as { profile?: { id: string } };
      if (res.ok && payload.profile) {
        await loadProfiles();
        setActiveProfileId(payload.profile.id);
      }
    } finally {
      setProfileEditing(null);
      setProfileDraft("");
    }
  }

  async function renameProfileFromDraft() {
    const displayName = profileDraft.trim();
    if (!displayName) return;
    try {
      await fetch(`/api/voice-profile/profiles/${encodeURIComponent(activeProfileId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      await loadProfiles();
    } finally {
      setProfileEditing(null);
      setProfileDraft("");
    }
  }

  async function deleteActiveProfile() {
    if (typeof window !== "undefined" && !window.confirm(t.profileDeleteConfirm)) return;
    await fetch(`/api/voice-profile/profiles/${encodeURIComponent(activeProfileId)}`, { method: "DELETE" });
    await loadProfiles(); // current id is gone → loadProfiles falls back to the first profile
  }

  const targetScriptBlocked = profileUsable && isUnstableChineseScript(text);
  const generateDisabled = !text.trim() || gen === "busy" || !profileUsable || targetScriptBlocked;

  /* ----------------------------- streaming parse (reused contract) */

  function handleTerminal(payload: ClonePayload, responseOk: boolean) {
    void loadVoiceProfile(activeProfileId);
    if (!responseOk || payload.status === "error") {
      setGen("error");
      setGenMessage(payload.message || t.genError);
      return;
    }
    if (payload.status === "needs_worker") {
      setGen("needs_worker");
      setGenMessage(payload.message || t.workerMissing);
      return;
    }
    setGen("done");
    setAudioUrl(payload.audioUrl || "");
    setGenMessage("");
    void loadHistory();
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
      if (isProgressPayload(parsed)) return;
      if (isTerminalPayload(parsed)) {
        terminalSeen = true;
        handleTerminal(parsed, response.ok);
      }
    };

    while (true) {
      const { value, done: streamDone } = await reader.read();
      buffer += decoder.decode(value, { stream: !streamDone });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      if (streamDone) break;
    }
    if (buffer.trim()) consumeLine(buffer);
    if (!terminalSeen && !response.ok) {
      setGen("error");
      setGenMessage(t.genError);
    }
  }

  /* ----------------------------- generate */

  async function doGenerate() {
    if (generateDisabled) return;
    if (targetScriptBlocked) {
      setGen("error");
      setGenMessage(t.scriptBlocked);
      return;
    }
    setGen("busy");
    setGenMessage("");
    setAudioUrl("");

    const form = new FormData();
    form.set("targetText", text);
    form.set("consent", "yes");
    form.set("quality", DEFAULT_QUALITY);
    if (pronText.trim()) form.set("pronunciationOverrides", pronText);

    try {
      // Speak in the selected voice — the server resolves that profile's best
      // enrolled clip and clones it zero-shot (no upload, no transcript typing).
      form.set("useVoiceProfile", "yes");
      form.set("profileId", activeProfileId);
      form.set("allowDraftVoiceProfile", "yes");

      const response = await fetch("/api/clone/stream", { method: "POST", body: form });
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/x-ndjson")) {
        await readStreamingResponse(response);
        return;
      }
      const payload = (await response.json()) as ClonePayload;
      handleTerminal(payload, response.ok);
    } catch {
      setGen("error");
      setGenMessage(t.genError);
    }
  }

  /* ----------------------------- recording + enroll */

  function micProcessingEnabled(settings: BrowserCaptureSettings | null): boolean {
    return Boolean(settings?.echoCancellation || settings?.noiseSuppression || settings?.autoGainControl);
  }

  async function startRecording() {
    setBuildMessage("");
    // safety: block Simplified/mixed scripts before capturing
    if (isUnstableChineseScript(scripts[cur])) {
      setBuildMessage(t.enrollScriptBlocked);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
    } catch {
      setBuildMessage(t.micBlocked);
      return;
    }
    const captureSettings = browserCaptureSettings(stream);
    if (micProcessingEnabled(captureSettings)) {
      stream.getTracks().forEach((track) => track.stop());
      setBuildMessage(t.micProcessing);
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, supportedRecorderOptions());
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const file = createRecordedFile(chunksRef.current, recorder.mimeType, Date.now());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void enrollClip(file, captureSettings);
    };
    recorder.start();
    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsed((Date.now() - startedAt) / 1000);
    }, 100);
    // hard ceiling: auto-stop at the max duration so a clip never exceeds the gate
    autoStopRef.current = window.setTimeout(() => stopRecording(), REC_MAX_SEC * 1000);
  }

  function clearTimers() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (autoStopRef.current) window.clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
  }

  function stopRecording() {
    clearTimers();
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  async function enrollClip(file: File, captureSettings: BrowserCaptureSettings | null) {
    setEnrolling(true);
    const promptTranscript = scripts[cur];
    const form = new FormData();
    form.set("voice", file);
    form.set("promptTranscript", promptTranscript);
    form.set("sourceKind", "scripted" satisfies SourceKind);
    form.set("voiceProfileId", activeProfileId);
    form.set("consent", "yes");
    if (captureSettings) form.set("browserCaptureSettings", JSON.stringify(captureSettings));

    try {
      const response = await fetch("/api/voice-profile/enroll", { method: "POST", body: form });
      const payload = (await response.json()) as VoiceProfileEnrollmentPayload;
      if (!response.ok || payload.status !== "enrolled") {
        markClip("bad", payload.message || t.enrollFailed);
        return;
      }
      if (payload.profile) setProfile(payload.profile);
      const quality = payload.referenceQuality;
      const passing = new Set(payload.profile?.requirements?.passingGrades ?? ["A", "B"]);
      if (quality?.grade && !passing.has(quality.grade)) {
        markClip("bad", rejectionMessage(quality));
        return;
      }
      markClip("ok", "");
      advance();
    } catch {
      markClip("bad", t.enrollFailed);
    } finally {
      setEnrolling(false);
    }
  }

  async function importFromYoutube() {
    if (!ytUrl.trim() || !ytConsent || ytBusy) return;
    if (ytNeedTranscript && !ytTranscript.trim()) return;
    setYtBusy(true);
    setYtError(false);
    setYtMessage(t.youtubeImporting);
    try {
      // Start time comes from the URL's &t= param; the transcript is captured
      // automatically (captions → speech recognition). Only send a typed
      // transcript when an earlier import asked for one.
      const response = await fetch("/api/voice-profile/enroll/youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: ytUrl.trim(),
          transcriptOverride: ytNeedTranscript ? ytTranscript.trim() || undefined : undefined,
          profileId: activeProfileId,
          consent: "yes",
        }),
      });
      const payload = (await response.json()) as VoiceProfileEnrollmentPayload & { code?: string };
      if (!response.ok || payload.status !== "enrolled") {
        setYtError(true);
        if (payload.code === "no_captions") {
          setYtNeedTranscript(true);
          setYtMessage(t.youtubeNoCaptions);
        } else {
          setYtMessage(payload.message || t.youtubeFailed);
        }
        return;
      }
      setYtNeedTranscript(false);
      if (payload.profile) setProfile(payload.profile);
      const quality = payload.referenceQuality;
      const passing = new Set(payload.profile?.requirements?.passingGrades ?? ["A", "B"]);
      if (quality?.grade && !passing.has(quality.grade)) {
        setYtError(true);
        setYtMessage(rejectionMessage(quality));
        return;
      }
      setYtError(false);
      setYtMessage(t.youtubeOk);
    } catch {
      setYtError(true);
      setYtMessage(t.youtubeFailed);
    } finally {
      setYtBusy(false);
    }
  }

  function markClip(state: ClipState, message: string) {
    setClips((cs) => {
      const next = [...cs];
      next[cur] = state;
      return next;
    });
    setBuildMessage(message);
  }

  // Turn the analyzer's actual finding into a specific, honest reason.
  // The most common case for clean-sounding clips is duration, not noise.
  function rejectionMessage(q: ReferenceQuality): string {
    const dur = q.durationSec ?? 0;
    if (dur > 0 && dur < REC_MIN_SEC) return t.enrollTooShort(dur, REC_MIN_SEC);
    if (dur > REC_MAX_SEC) return t.enrollTooLong(dur, REC_MAX_SEC);
    const w = q.warnings ?? [];
    if (w.includes("short_clip")) return t.enrollTooShort(dur, REC_MIN_SEC);
    if (w.includes("long_clip")) return t.enrollTooLong(dur, REC_MAX_SEC);
    if (w.includes("clipping_detected")) return t.enrollClipping;
    if (w.includes("low_snr")) return t.enrollNoisy;
    if (w.some((x) => x.includes("voice") || x.includes("vad") || x.includes("active"))) return t.enrollLowVoice;
    return t.enrollRejected;
  }

  function advance() {
    setClips((cs) => {
      const nextMissing = cs.findIndex((c, i) => i !== cur && c !== "ok");
      if (nextMissing >= 0) setCur(nextMissing);
      return cs;
    });
  }

  function toggleRecord() {
    if (enrolling) return;
    if (recording) {
      // Don't let the user stop below the gate floor — that's the #1 cause of
      // "clean but rejected" clips. Surface the live target instead of saving a 1s clip.
      if (elapsed < REC_MIN_SEC) {
        setBuildMessage(t.recordKeepGoing(REC_MIN_SEC));
        return;
      }
      stopRecording();
    } else {
      void startRecording();
    }
  }

  /* ----------------------------------------------------------- render */

  return (
    <div>
      <nav className="nav">
        <div className="brand">
          <Spike /> AnyVoice
        </div>
        <div className="nav-right">
          {/* Global voice picker (P0.3): visible + active on every screen. */}
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="muted small" style={{ margin: 0 }}>
              {t.profileLabel}
            </span>
            <select
              className="field"
              style={{ width: "auto" }}
              value={activeProfileId}
              onChange={(e) => switchProfile(e.target.value)}
              aria-label={t.profileLabel}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} · {statusLabelFor(p)}
                </option>
              ))}
            </select>
            <button
              className="pillbtn"
              aria-pressed={profileManageOpen}
              aria-label={t.profileManage}
              onClick={() => {
                setProfileEditing(null);
                setProfileDraft("");
                setProfileManageOpen((open) => !open);
              }}
            >
              {t.profileManage}
            </button>
          </div>
          <button className="pillbtn" aria-pressed={screen === "build"} onClick={() => setScreen("build")}>
            {t.navBuild}
          </button>
          <button
            className="pillbtn"
            aria-pressed={screen === "generate"}
            disabled={!profileUsable}
            title={!profileUsable ? t.voiceMineHint : undefined}
            onClick={() => profileUsable && setScreen("generate")}
          >
            {t.navGenerate}
          </button>
          <button
            className="pillbtn"
            aria-pressed={screen === "book"}
            disabled={!profileReady}
            title={!profileReady ? t.voiceMineHint : undefined}
            onClick={() => profileReady && setScreen("book")}
          >
            {t.navBook}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => setLocale(locale === "en" ? "zh-Hant" : "en")}
          >
            {t.switchLang}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => setTheme((th) => (th === "dark" ? "light" : "dark"))}
            aria-label={t.themeLabel}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </nav>

      {/* Voice management (create / rename / delete) — reachable from the global
          picker on every screen. Expands inline under the nav. */}
      {profileManageOpen && (
        <div className="wrap" style={{ paddingTop: 16, paddingBottom: 0 }}>
          <div className="card card--cream" style={{ display: "grid", gap: 12 }}>
            <div className="row between" style={{ gap: 10, flexWrap: "wrap" }}>
              <span className="muted small" style={{ margin: 0 }}>
                {activeProfile ? t.profileActive(activeProfile.displayName) : t.profileLabel}
              </span>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setProfileEditing("create");
                    setProfileDraft("");
                  }}
                >
                  {t.profileCreate}
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setProfileEditing("rename");
                    setProfileDraft(activeProfile?.displayName ?? "");
                  }}
                >
                  {t.profileRename}
                </button>
                <button className="btn btn--ghost" disabled={profiles.length <= 1} onClick={deleteActiveProfile}>
                  {t.profileDelete}
                </button>
              </div>
            </div>
            {profileEditing && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <input
                  className="field"
                  style={{ flex: "1 1 240px" }}
                  autoFocus
                  placeholder={t.profileNamePlaceholder}
                  value={profileDraft}
                  onChange={(e) => setProfileDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      void (profileEditing === "create" ? createProfileFromDraft() : renameProfileFromDraft());
                  }}
                />
                <button
                  className="btn"
                  disabled={!profileDraft.trim()}
                  onClick={() => void (profileEditing === "create" ? createProfileFromDraft() : renameProfileFromDraft())}
                >
                  {t.profileSave}
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setProfileEditing(null);
                    setProfileDraft("");
                  }}
                >
                  {t.profileCancel}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {screen === "book" ? (
        <BookReader locale={locale} profileReady={Boolean(profileReady)} profileId={activeProfileId} />
      ) : screen === "generate" ? (
        <div className="wrap">
          <div className="hero">
            <div className="eyebrow">{t.eyebrow}</div>
            <h1 className="display">{t.h1}</h1>
            <p className="lede">{t.lede}</p>
            {activeProfile && (
              <p className="muted small" style={{ marginTop: 6 }}>
                {t.profileActive(activeProfile.displayName)}
              </p>
            )}
          </div>

          <div className="card card--cream" style={{ display: "grid", gap: 28 }}>
            {!profileUsable && (
              <div className="row between" style={{ gap: 16 }}>
                <span className="muted small" style={{ margin: 0 }}>
                  {t.voiceMineHint}
                </span>
                <button className="btn btn--secondary" onClick={() => setScreen("build")}>
                  {t.navBuild} →
                </button>
              </div>
            )}

            <div>
              <div className="row between">
                <span className="label" style={{ margin: 0 }}>
                  {t.textLabel}
                </span>
                <span className="muted small">
                  {text.length} {t.chars}
                </span>
              </div>
              <textarea
                className="target"
                placeholder={t.placeholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label={t.textLabel}
              />

              {pronSuggestions.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <span className="label">{t.pronTitle}</span>
                  <div className="pron">
                    {pronSuggestions.map((s) => (
                      <button
                        key={s.term}
                        className="pron-chip"
                        onClick={() => applyPronunciation(s.term, s)}
                      >
                        {t.pronApply(s.term, s.replacement)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {showModelPreview && (
                <div className="model-preview" aria-label={t.modelPreviewTitle}>
                  <span className="label">{t.modelPreviewTitle}</span>
                  <div className="model-preview__grid">
                    <span className="model-preview__label">{t.modelPreviewRaw}</span>
                    <span className="model-preview__text">{preparedTarget.raw}</span>
                    <span className="model-preview__label">{t.modelPreviewModel}</span>
                    <span className="model-preview__text model-preview__text--model">{preparedTarget.model}</span>
                  </div>
                </div>
              )}

              {targetScriptBlocked && (
                <p className="notice notice--warn" style={{ marginTop: 14 }}>
                  {t.scriptBlocked}
                </p>
              )}
            </div>

            <div className="row">
              <button className="btn btn--primary btn--lg" disabled={generateDisabled} onClick={doGenerate}>
                {gen === "busy" ? t.generating : t.generate}
              </button>
            </div>

            {(gen === "error" || gen === "needs_worker") && genMessage && (
              <p className={"notice " + (gen === "needs_worker" ? "notice--warn" : "notice--error")}>
                {genMessage}
              </p>
            )}
          </div>

          {gen === "done" && (
            <div className="card card--dark" style={{ marginTop: 16 }}>
              <span className="label" style={{ color: "var(--on-dark-soft)" }}>
                {t.outLabel}
              </span>
              {audioUrl && (
                <audio
                  controls
                  autoPlay
                  preload="auto"
                  controlsList="nodownload noplaybackrate"
                  src={audioUrl}
                  onPlay={(e) => {
                    e.currentTarget.playbackRate = speed;
                  }}
                  style={{ width: "100%", marginTop: 12 }}
                >
                  <track kind="captions" />
                </audio>
              )}
              <PlayerMenu
                variant="dark"
                speed={speed}
                setSpeed={setSpeed}
                downloadUrl={audioUrl ? `${audioUrl}?format=wav` : "#"}
                onRegenerate={doGenerate}
                speedLabel={t.speedLabel}
                downloadLabel={t.download}
                regenerateLabel={t.regenerate}
              />
            </div>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <span className="label">{t.historyTitle}</span>
              <div className="history">
                {history.map((h) => (
                  <div className="history-row" key={h.id}>
                    <code
                      className="muted small"
                      style={{ display: "block", marginBottom: 4, fontFamily: "var(--mono, ui-monospace, monospace)", letterSpacing: "0.02em" }}
                      title={new Date(h.createdAt).toLocaleString()}
                    >
                      #{h.id}
                    </code>
                    <p className="history-text">{h.targetText}</p>
                    {h.audioUrl && (
                      <>
                        <audio
                          controls
                          preload="none"
                          controlsList="nodownload noplaybackrate"
                          src={h.audioUrl}
                          onPlay={(e) => {
                            e.currentTarget.playbackRate = speed;
                          }}
                        >
                          <track kind="captions" />
                        </audio>
                        <PlayerMenu
                          variant="cream"
                          speed={speed}
                          setSpeed={setSpeed}
                          downloadUrl={`${h.audioUrl}?format=wav`}
                          speedLabel={t.speedLabel}
                          downloadLabel={t.download}
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="wrap">
          <div className="hero">
            <div className="eyebrow">{t.buildEyebrow}</div>
            <h1 className="display">{t.buildH1}</h1>
            <p className="lede">{t.buildLede}</p>
          </div>

          {allDone ? (
            <div className="done-band">
              <h2 className="serif" style={{ fontSize: 34, marginBottom: 10 }}>
                {t.doneH1}
              </h2>
              <p style={{ opacity: 0.9, maxWidth: "40ch", margin: "0 auto 22px" }}>{t.doneLede}</p>
              <button
                className="btn btn--lg"
                style={{ background: "var(--canvas)", color: "var(--ink)" }}
                onClick={() => setScreen("generate")}
              >
                {t.doneCta}
              </button>
            </div>
          ) : (
            <>
              <div className="row between" style={{ marginBottom: 10 }}>
                <span className="label" style={{ margin: 0 }}>
                  {t.progress(done, SCRIPT_COUNT)}
                </span>
              </div>
              <div className="ticks" style={{ marginBottom: 24 }}>
                {clips.map((c, i) => (
                  <i key={i} className={c === "ok" ? "done" : i === cur ? "cur" : ""} />
                ))}
              </div>

              <div className="card card--dark" style={{ textAlign: "center" }}>
                <div className="small" style={{ color: "var(--on-dark-soft)", marginBottom: 14 }}>
                  {t.promptOf(cur + 1, SCRIPT_COUNT)}
                </div>
                <p className="serif" style={{ fontSize: 26, lineHeight: 1.45, maxWidth: "34ch", margin: "0 auto 18px" }}>
                  {scripts[cur]}
                </p>
                {SCRIPT_CUES[cur] && (
                  <div className="row" style={{ justifyContent: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
                    <span className="small" style={{ color: "var(--on-dark-soft)" }}>
                      {t.cueLabel}:
                    </span>
                    {SCRIPT_CUES[cur].map((c) => (
                      <span key={c} className="chip">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                <div className="row" style={{ justifyContent: "center", marginBottom: 14 }}>
                  <button
                    className={
                      "record" + (recording ? (elapsed < REC_MIN_SEC ? " record--live record--hold" : " record--live") : "")
                    }
                    onClick={toggleRecord}
                    disabled={enrolling}
                    aria-label={recording ? t.stop : t.recordStart}
                  >
                    {recording ? "■" : "●"}
                  </button>
                </div>
                {recording && (
                  <div
                    className="serif"
                    style={{ fontSize: 28, marginBottom: 4, fontVariantNumeric: "tabular-nums" }}
                  >
                    {Math.floor(elapsed)}
                    <span style={{ fontSize: 16, color: "var(--on-dark-soft)" }}> / {REC_MIN_SEC}–{REC_MAX_SEC}s</span>
                  </div>
                )}
                <div className="small" style={{ color: "var(--on-dark-soft)" }}>
                  {enrolling
                    ? t.enrolling
                    : recording
                      ? elapsed < REC_MIN_SEC
                        ? t.recording
                        : t.recordReadyToStop
                      : t.recordHint}
                </div>
              </div>

              {buildMessage && (
                <p className="notice notice--error" style={{ marginTop: 16 }}>
                  {buildMessage}
                </p>
              )}

              <div style={{ marginTop: 28 }}>
                <span className="label">{t.listTitle}</span>
                <div className="checklist">
                  {scripts.map((p, i) => (
                    <div className="clip" key={i}>
                      <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                      <span className="txt">{p}</span>
                      <span
                        className={
                          "st " + (clips[i] === "ok" ? "st--ok" : clips[i] === "bad" ? "st--bad" : "st--idle")
                        }
                      >
                        {clips[i] === "ok" ? t.stOk : clips[i] === "bad" ? t.stBad : t.stIdle}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <details className="adv">
            <summary>▸ {t.youtubeTitle}</summary>
            <p className="muted small" style={{ marginTop: 12 }}>
              {t.youtubeHint}
            </p>
            <p className="muted small" style={{ marginTop: 8, fontStyle: "italic" }}>
              {t.youtubeNotice}
            </p>
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <input
                type="url"
                className="field"
                placeholder={t.youtubeUrlPlaceholder}
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                disabled={ytBusy}
              />
              {/* Transcript is captured automatically; this only appears when
                  both captions and speech recognition came up empty. */}
              {ytNeedTranscript && (
                <textarea
                  className="field"
                  rows={2}
                  placeholder={t.uploadTranscriptPlaceholder}
                  value={ytTranscript}
                  onChange={(e) => setYtTranscript(e.target.value)}
                  disabled={ytBusy}
                />
              )}
              <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={ytConsent}
                  onChange={(e) => setYtConsent(e.target.checked)}
                  disabled={ytBusy}
                />
                <span>{t.youtubeConsent}</span>
              </label>
              <button
                className="btn"
                onClick={importFromYoutube}
                disabled={ytBusy || !ytUrl.trim() || !ytConsent || (ytNeedTranscript && !ytTranscript.trim())}
              >
                {ytBusy ? t.youtubeImporting : t.youtubeImport}
              </button>
              {ytMessage && (
                <p className={ytError ? "notice notice--error" : "notice"} style={{ marginTop: 4 }}>
                  {ytMessage}
                </p>
              )}
            </div>
          </details>

          <details className="adv">
            <summary>▸ {t.advTitle}</summary>
            <p className="muted small" style={{ marginTop: 12 }}>
              {t.advHint}
            </p>
            <div className="advgrid">
              {ADV_COMMANDS.map(([key, cmd]) => (
                <div className="advcard" key={key}>
                  <strong className="small">{t[key] as string}</strong>
                  <code>{cmd}</code>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

export default VoiceCloneStudio;

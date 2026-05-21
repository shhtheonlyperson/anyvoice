"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  BadgePlus,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Download,
  FolderPlus,
  Gauge,
  History,
  ListChecks,
  Loader2,
  Mic,
  Monitor,
  Moon,
  PlayCircle,
  RefreshCw,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  Wand2,
} from "lucide-react";
import { buildProfileScriptPlan, selectNextProfileRecordingScript } from "@/lib/profile-guidance";
import {
  analyzeChineseScript,
  detectChineseScript,
  parsePronunciationOverrides,
  prepareVoiceText,
  serializePronunciationOverride,
  strictTraditionalChineseScriptErrors,
  suggestKnownTraditionalChineseText,
  suggestPronunciationOverrides,
  type DetectedChineseScript,
  type PronunciationOverride,
  type PronunciationSuggestion,
  type VoiceProfileCoverageFeature,
} from "@/lib/text-prep";

type Locale = "zh-Hant" | "en";
type Theme = "system" | "light" | "dark";
type Status = "idle" | "requesting_mic" | "recording" | "submitting" | "ready" | "needs_worker" | "error";
type Mode = "scripted" | "freeform";
type SourceKind = "sample" | "scripted" | "freeform" | "uploaded" | "profile";
type ReferenceGrade = "A" | "B" | "C" | "D";
type QualityPreset = "speed" | "balanced" | "quality";
type CaptureStatusTone = "info" | "ready" | "warn";
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

interface CaptureStatus {
  tone: CaptureStatusTone;
  text: string;
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
    cloneMode?: "hifi" | "prompt";
    stabilitySeed?: number | null;
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

interface RunHistoryItem {
  id: string;
  status: "ready" | "needs_worker" | "error";
  modelId: string;
  voiceName: string;
  sourceKind?: SourceKind;
  targetText: string;
  promptTranscript: string;
  quality: QualityPreset;
  pronunciationOverrides?: PronunciationOverride[];
  audioUrl?: string;
  referenceQuality?: ReferenceQuality;
  targetLanguage?: string | null;
  effectiveParams?: ClonePayload["effectiveParams"];
  message?: string;
  createdAt: string;
  completedAt?: string;
}

interface VoiceProfilePayload {
  status: "ready" | "needs_enrollment";
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
    requiredCoverageFeatures?: string[];
    requiredPronunciationPresetIds?: string[];
  };
  referenceClipIds?: string[];
  diagnostics?: {
    eligibleTranscriptScripts?: Array<{ script: string; count: number }>;
    coverageFeatures?: Array<{ feature: string; count: number }>;
    missingCoverageFeatures?: string[];
    pronunciationPresetIds?: Array<{ presetId: string; count: number }>;
    missingPronunciationPresetIds?: string[];
    selectedGrades?: Array<{ grade: string; count: number }>;
    rejectionReasons?: Array<{ reason: string; count: number }>;
    topRejectedClips?: Array<{
      sourceRunId: string;
      grade: string;
      durationSec: number;
      reasons: string[];
    }>;
  };
  clips?: Array<{
    sourceRunId: string;
    transcriptRaw: string;
    coverageFeatures?: VoiceProfileCoverageFeature[];
  }>;
  rejectedClips?: Array<{
    sourceRunId: string;
    transcriptRaw: string;
    coverageFeatures?: VoiceProfileCoverageFeature[];
    reasons?: string[];
  }>;
}

interface VoiceProfileEnrollmentPayload {
  status: "enrolled" | "error";
  message?: string;
  referenceQuality?: ReferenceQuality;
  profile?: VoiceProfilePayload;
}

interface RecordingKitPayload {
  status: "written";
  kit: string;
  manifest: string;
  promptSet?: "standard" | "extended" | "custom" | string;
  cueSheetHtml?: string;
  cueSheetUrl?: string;
  openCueSheetCommand?: string;
  prompts: string;
  recordings: string;
  clips: number;
  clipSpecs?: RecordingKitClipSpec[];
  summary?: {
    requiredCoverageFeatures: string[];
    coveredFeatures: string[];
    missingCoverageFeatures: string[];
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  checkCommand: string;
  recordCommand?: string;
  recordMissingUntilCompleteCommand?: string;
  recordNextMissingCommand?: string;
  recordAllCommand?: string;
  preflightBriefCommand?: string;
  recordAndProveCommand?: string;
  recordProveAndProductProofCommand?: string;
  recordProveProductProofAndLoraCommand?: string;
  normalizeExternalRecordingsCommand?: string;
  enrollCommand: string;
  proofCommand?: string;
  importCommand: string;
  verifyCommand: string;
}

interface RecordingKitClipSpec {
  id?: string;
  expectedStem?: string;
  transcript?: string;
  audioPath?: string;
  sourceKind?: string;
  coverageFeatures?: VoiceProfileCoverageFeature[];
  pronunciationPresetIds?: string[];
  pronunciationNotes?: string[];
  recommendedDurationSec?: number;
  durationMode?: "fixed" | "auto" | string;
  durationTargetSec?: number;
}

interface RecordingKitCheckPayload {
  status: "ready_to_import" | "incomplete";
  manifest: string;
  profileId: string;
  summary: {
    clips: number;
    minClips: number;
    minDurationSec?: number;
    maxDurationSec?: number;
    minActiveVoiceSec?: number;
    targetDurationToleranceSec?: number;
    minPeakAmplitude?: number;
    maxClippingRatio?: number;
    audioFilesPresent: number;
    audioFilesWithinDuration?: number;
    audioFilesWithinTargetDuration?: number;
    audioFilesWithActiveVoice?: number;
    audioFilesPassingLevelQuality?: number;
    coveredFeatures: string[];
    missingCoverageFeatures: string[];
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  checks: Array<{
    check: string;
    ok: boolean;
    message: string;
    details?: {
      rows?: Array<{
        index?: number;
        id?: string;
        transcriptScript?: string;
        errors?: string[];
      }>;
    };
  }>;
  nextCommands?: {
    importProfileClips?: string;
    verifyProfile?: string;
  };
}

interface RecordingKitNormalizePayload {
  status: "normalized" | "all_recordings_present" | "blocked" | "check_failed" | "planned";
  manifest: string;
  profileId: string;
  summary: {
    clips: number;
    normalized: number;
    existing: number;
    missingSources: number;
    failures: number;
  };
  checkReport?: RecordingKitCheckPayload | null;
}

interface RecordingKitPreflightClip {
  id: string;
  index: number;
  transcript?: string;
  promptTranscript?: string;
  pronunciationNotes?: string[];
  coverageFeatures?: VoiceProfileCoverageFeature[];
  pronunciationPresetIds?: string[];
  action?: string;
  exists?: boolean;
  audioPath?: string;
  needsAudio?: boolean;
  needsRerecord?: boolean;
  recordingIssues?: string[];
  durationSec?: number;
  activeVoiceSec?: number;
  recommendedDurationSec?: number;
  durationMode?: "fixed" | "auto" | string;
  durationTargetSec?: number;
  rehearseCommand?: string;
  preflightCommand?: string;
  recordCommand?: string;
  repairCommand?: string;
}

interface RecordingKitPreflightPayload {
  status: "ready_to_record" | "all_recordings_present" | "blocked";
  manifest: string;
  kit?: string;
  prompts?: string;
  recordings?: string;
  cueSheetHtml?: string | null;
  openCueSheetCommand?: string | null;
  manifestMetadata?: {
    promptSet?: string | null;
    requiredClips?: number | null;
  };
  message: string;
  durationSec: number;
  countdownSec: number;
  summary: {
    clips: number;
    existing: number;
    toRecord: number;
    toSkipExisting: number;
    promptBlocked: number;
    transcriptBlocked: number;
    recordingMetadataChecked: number;
    recordingMetadataBlocked: number;
    writeBlocked: number;
    requiredPronunciationPresetIds?: string[];
    coveredPronunciationPresetIds?: string[];
    missingPronunciationPresetIds?: string[];
  };
  recorder: {
    configured: boolean;
    source: string;
    template?: string;
  };
  microphoneSmokeTest?: {
    status: "passed" | "failed" | "skipped" | string;
    durationSec?: number;
    clipId?: string;
    exitCode?: number;
    audioBytes?: number;
    audioLevelQuality?: {
      peakAmplitude?: number;
      clippingRatio?: number;
    } | null;
    levelQualityError?: string | null;
    minPeakAmplitude?: number;
    maxClippingRatio?: number;
    errors?: string[];
    keptAudio?: boolean;
    stdout?: string | null;
    stderr?: string | null;
    command?: string;
  };
  clips?: RecordingKitPreflightClip[];
  nextCommands?: Record<string, string>;
}

interface VoiceProfileNextStepPayload {
  status: string;
  phase: string;
  brief?: string;
  nextAction: {
    id: string;
    phase: string;
    status: string;
    command: string;
    reason: string;
    nonInteractiveCommand?: string;
    failedClip?: string | null;
    failedSourceRunId?: string | null;
    failedClipErrors?: string[];
    secondaryCommands?: string[];
  };
  recordingBrief?: {
    manifest: string;
    clipsNeedingAudio: string[];
    clipsNeedingRerecord?: string[];
    clipsNeedingAttention?: string[];
    pronunciationNotePolicy: string;
    guidance: string[];
    clips: RecordingKitPreflightClip[];
  };
  postRecordingProofPlan?: {
    policy: string;
    recommendedCommand: string;
    productProofCommand?: string;
    productProofAsrBackend?: {
      status: string;
      available: boolean;
      requiredBackend: string;
      asrPython?: string;
      selectedAutoBackend?: string | null;
      reason: string;
      checkCommand: string;
      setupHint?: string;
    };
    productProofSpeakerBackend?: {
      status: string;
      available: boolean;
      requiredBackend: string;
      speakerPython?: string;
      selectedAutoBackend?: string | null;
      reason: string;
      checkCommand: string;
      setupHint?: string;
    };
    manualCommands: string[];
    artifacts: Array<{
      id: string;
      path?: string | null;
      pathPattern?: string;
      status: string;
      purpose: string;
    }>;
    gates: Array<{
      id: string;
      command: string;
      required: boolean;
      blocks: string;
    }>;
  };
}

interface VoiceProfileVerificationPayload {
  status: "ready" | "blocked";
  profile: string;
  voiceProfileId?: string | null;
  summary: {
    selectedClips: number;
    eligibleClips: number;
    manifestClips: number;
    totalDurationSec: number;
    missingCoverageFeatures: string[];
    missingPronunciationPresetIds?: string[];
    minClips: number;
    minTotalDurationSec: number;
  };
  checks: Array<{
    check: string;
    ok: boolean;
    message: string;
  }>;
  recordingPrescription?: {
    status: "satisfied" | "needs_recording";
    clipsNeeded: number;
    selectedClips: number;
    eligibleClips: number;
    durationSec: {
      min: number;
      recommended: number;
      max: number;
      activeVoiceTarget: number;
    };
    missingCoverageFeatures: string[];
    missingPronunciationPresetIds?: string[];
    topRejectionReasons?: Array<{ reason: string; count: number }>;
    promptManifest?: string;
    message?: string;
  };
  nextCommands?: Record<string, string>;
  nextStep?: VoiceProfileNextStepPayload;
  nextStepError?: string;
}

interface VoiceProfileTranscriptValidationPayload {
  validationJson: string;
  total: number;
  passed: number;
  failed: number;
  status: "pass" | "blocked" | "planned";
  backend: string;
  avgCer?: number | null;
  maxCer?: number | null;
  avgWer?: number | null;
  maxWer?: number | null;
  message?: string;
}

interface VoiceCloneGoalAuditStage {
  id: string;
  status: string;
  ok: boolean;
  message: string;
  missingClips?: string[];
  firstMissingClip?: {
    id: string;
    index?: number;
    audioPath?: string;
    promptPath?: string;
    transcript?: string;
    coverageFeatures?: string[];
    errors?: string[];
    recordCommand?: string;
  };
  recordingPreflight?: {
    status?: string;
    ok?: boolean;
    message?: string;
    recorder?: {
      configured?: boolean;
      source?: string;
      template?: string | null;
    };
    recordingGuidance?: {
      durationMode?: "fixed" | "auto" | string;
      targetDurationSec?: number | null;
      targetDurationLabel?: string;
      minDurationSec?: number;
      maxDurationSec?: number;
      minActiveVoiceSec?: number;
    };
  };
  clipCount?: number;
  selectedClips?: number;
  recommendedClips?: number;
  recommendedPromptSet?: string;
  totalDurationSec?: number;
  recommendedDurationSec?: number;
  trainConfig?: string;
  adapterProof?: string;
  adapterProofStatus?: string;
  expectedWeights?: string;
  trainScript?: string;
  trainerStatus?: string;
  trainerCommandConfigured?: boolean;
  trainerCommandSource?: string;
  report?: string;
  reviewJson?: string;
  missingBackends?: string[];
  asr?: Record<string, unknown>;
  speaker?: Record<string, unknown>;
  checkCommands?: string[];
  stats?: Record<string, unknown>;
}

interface VoiceCloneGoalAuditPayload {
  status: string;
  complete: boolean;
  profileJson: string;
  kitManifest: string;
  stages: VoiceCloneGoalAuditStage[];
  firstBlocker?: VoiceCloneGoalAuditStage | null;
  nextBriefCommand?: string | null;
  nextOpenCueSheetCommand?: string | null;
  nextMicrophoneSmokeTestCommand?: string | null;
  nextNormalizeExternalRecordingsCommand?: string | null;
  nextProductProofCommand?: string | null;
  nextProofEnvironmentCommand?: string | null;
  nextLoraHandoffCommand?: string | null;
  nextCommand?: string | null;
}

interface VoiceProfileReanalysisPayload {
  status: "completed" | "completed_with_errors";
  scanned: number;
  plannedOrUpdated: number;
  skipped?: Record<string, number>;
  runs?: Array<{
    sourceRunId: string;
    status: "planned" | "updated";
    quality?: {
      grade?: string;
      durationSec?: number;
      warnings?: string[];
    };
  }>;
  failures?: Array<{
    sourceRunId: string;
    message: string;
  }>;
  profile?: {
    status: "ready" | "needs_enrollment";
    eligibleClips: number;
    selectedClips: number;
    remainingClipsNeeded: number;
  };
}

const SONOGRAM_BARS = 64;
const MAX_TARGET_CHARS = 4096;
const MAX_TRANSCRIPT_CHARS = 1024;
const MAX_RECORDING_SECONDS = 60;
const MAX_PROFILE_DRAFTS = 10;
const PROFILE_VOICE_ACTIVE_LEVEL = 0.045;
const QUALITY_PRESETS: QualityPreset[] = ["balanced", "quality", "speed"];
const PROFILE_COVERAGE_FEATURES: VoiceProfileCoverageFeature[] = [
  "zh_hant",
  "numbers_dates",
  "latin_terms",
  "polyphones",
  "punctuation_rhythm",
];

const SAMPLE_VOICE_URL = "/sample-voice.wav";
const SAMPLE_VOICE_FILENAME = "sample-voice.wav";

// Verified transcript of /public/sample-voice.wav (Petit Prince excerpt).
const SAMPLE_VOICE_TRANSCRIPT =
  "當你看著夜空時，因為我住在其中一顆星星上，因為我會在其中一顆星星上笑，那麼對你來說，就好像所有的星星都在笑。";

const REFERENCE_DB_NAME = "anyvoice-reference";
const REFERENCE_DB_VERSION = 1;
const REFERENCE_STORE = "references";
const LAST_REFERENCE_KEY = "last";
const PROFILE_DRAFT_KEY_PREFIX = "profile-draft:";
const PROFILE_BROWSER_SESSION_COUNTDOWN_SECONDS = 2;
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

// Fixed reading scripts for profile enrollment. The zh-Hant set intentionally
// covers common Mandarin tones, punctuation rhythm, numbers, and names while
// staying in Traditional Chinese.
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
    scriptStep: (index: number, total: number) => `第 ${index} / ${total} 段`,
    previousScript: "上一段讀稿",
    nextScript: "下一段讀稿",
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
    sourceProfile: "數位聲音",
    referenceSavedLocal: "已保存在此瀏覽器，下次開啟會自動帶回。",
    downloadReference: "下載目前聲音樣本",
    clearReference: "移除目前聲音樣本",
    requestingMic: "要求麥克風",
    stop: "停止",
    upload: "上傳音檔",
    targetPlaceholder: "輸入你想讓這個聲音說出的內容…",
    pronunciationTitle: "發音替換",
    pronunciationHelp: "一行一個：原詞=模型要唸的字；也可用 pinyin:原詞=讀法。只改目標文字，不改逐字稿。",
    pronunciationPlaceholder: "重慶=重 慶\npinyin:行長=xing2 zhang3",
    pronunciationPreview: "模型文字",
    pronunciationInvalid: (line: number) => `第 ${line} 行格式無法使用。`,
    pronunciationSuggestions: "建議替換",
    pronunciationSuggestionPolyphone: "多音字",
    pronunciationSuggestionBrand: "名稱",
    consent: "我擁有這段聲音、或已取得明確授權，且不會用於冒充、詐欺或誤導聽眾。",
    submit: "產生聲音",
    submitting: "送出中",
    qualityTitle: "合成模式",
    qualityHelp: "預設採用 Brenda 的平衡 VoxCPM2 路徑；較慢模式只用來做聲線穩定比較。",
    qualitySpeed: "速度",
    qualitySpeedHint: "最快回應，適合試句子。",
    qualityBalanced: "平衡",
    qualityBalancedHint: "Brenda 預設路徑，適合大多數錄音。",
    qualityQuality: "聲線穩定",
    qualityQualityHint: "稍慢一點，但不強制降噪、不過度推 CFG。",
    guideIdle: "目標 6–20 秒、正常音量、安靜背景。",
    guideRequesting: "正在等麥克風權限。",
    guideKeepReading: "繼續讀，至少錄到 6 秒。",
    guideKeepRecording: (target: string) => `繼續讀，至少錄到 ${target}。`,
    guideKeepSpeaking: (voiceActive: string, target: string) => `繼續朗讀，人聲至少累積 ${target}（目前 ${voiceActive}）。`,
    guideGoodLevel: "音量剛好，保持這個距離。",
    guideTooQuiet: "音量偏小，靠近一點或提高輸入音量。",
    guideTooLoud: "音量偏大，退遠一點避免破音。",
    guideEnough: "樣本夠長了，可以停止。",
    guideReady: "參考音已就緒。",
    guideCapturedShort: "參考音偏短，建議重錄到 6 秒以上。",
    guideCapturedLong: "參考音偏長，建議剪到 20–30 秒內。",
    captureSettingsDetails: (channels: string, sampleRate: string) => `聲道 ${channels} / ${sampleRate}`,
    captureSettingsClean: (details: string) => `錄音設定：${details}，瀏覽器處理已關閉。`,
    captureSettingsUnknown: (details: string) => `錄音設定：${details}，瀏覽器未回報處理狀態。`,
    captureSettingsWarning: (details: string, processing: string) =>
      `錄音設定：${details}；瀏覽器仍開啟 ${processing}，聲線可能不穩。`,
    captureUnknownValue: "未知",
    captureEchoCancellation: "回音消除",
    captureNoiseSuppression: "降噪",
    captureAutoGainControl: "自動增益",
    profileCaptureProcessingBlocked: (processing: string) =>
      `瀏覽器仍開啟 ${processing}。為了建立穩定數位聲音，請改用能關閉處理的瀏覽器或麥克風，或改用外部錄音資料夾。`,
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
    historyTitle: "最近結果",
    historyHelp: "此瀏覽器的最近結果",
    historyRefresh: "更新紀錄",
    historyEmpty: "還沒有產生紀錄。",
    historyLoading: "讀取紀錄",
    historyFailed: "讀取紀錄失敗。",
    historyDelete: "從紀錄移除",
    historyOpen: "載入這次結果",
    historyStatusReady: "已完成",
    historyStatusWorker: "待 worker",
    historyStatusError: "失敗",
    profileTitle: "聲音檔案",
    profileHelp: "穩定的數位聲音需要多段合格參考音，不再靠單次短錄音硬撐。",
    profileReady: "已可建立數位聲音",
    profileNeeds: "需要更多錄音",
    profileSessionTitle: (count: number) => `${count} 段錄音進度`,
    profileScriptStatusAccepted: "已通過",
    profileScriptStatusRejected: "未通過",
    profileScriptStatusMissing: "待錄",
    profileDraftRestored: (count: number) => `瀏覽器已暫存 ${count} 段錄音。`,
    profileDraftSaved: "已暫存",
    profileDraftUse: "加入已存錄音",
    profileDraftUseAll: "加入全部暫存錄音",
    profileDraftClear: "清除暫存",
    profileDraftFailed: "無法載入暫存錄音。",
    profileDraftDuration: (duration: string) => `已暫存 ${duration}`,
    profileDraftDurationWithVoice: (duration: string, voiceActive: string) => `已暫存 ${duration} / 人聲 ${voiceActive}`,
    profileDraftTooShort: (duration: string, minSec: number) => `${duration}，未滿 ${minSec} 秒`,
    profileDraftTooLong: (duration: string, maxSec: number) => `${duration}，超過 ${maxSec} 秒`,
    profileDraftLowVoiceActive: (duration: string, voiceActive: string, minVoiceActive: string) =>
      `${duration} / 人聲 ${voiceActive}，未滿 ${minVoiceActive}`,
    profileDraftProcessedCapture: (duration: string, processing: string) => `${duration}，瀏覽器處理未關：${processing}`,
    profileDraftDurationBlocked: "有暫存錄音不在門檻秒數或人聲時間內，請重錄該段再一次匯入。",
    profileDraftCaptureBlocked: "有暫存錄音仍開啟瀏覽器處理，請重錄該段再一次匯入。",
    profileEligible: "合格片段",
    profileRejected: "未通過",
    profileRemaining: (count: number) => `還需要 ${count} 段`,
    profileCoverageTitle: "發音覆蓋",
    profileCoverageDone: (count: number) => `已補 ${count}`,
    profileCoverageMissing: "待補",
    profileGate: (min: number, minSec: number, maxSec: number) =>
      `門檻：至少 ${min} 段不同內容，每段 ${minSec}-${maxSec} 秒，品質 A/B，且覆蓋數字、英文詞和多音詞。`,
    profileRefresh: "更新聲音檔案",
    profileFailed: "讀取聲音檔案失敗。",
    profileUse: "使用數位聲音",
    profileUsing: "將使用已通過 hard gate 的固定參考音。",
    profileUseNeedsVerify: "需先通過嚴格檢查與逐字稿 ASR 驗證。",
    profileUseBlocked: "Hard gate 尚未通過，先補齊失敗項目。",
    profileUseChecking: "正在檢查 hard gate。",
    profileNextTitle: "下一段建議錄音",
    profileNextHelp: (feature: string) => `優先補：${feature}`,
    profileNextAction: "錄並加入",
    profileSessionStart: "連續錄剩下片段",
    profileSessionStop: "停止連續錄音",
    profileSessionActive: (done: number, total: number) => `連續錄音中：已暫存 ${done} / ${total} 段。`,
    profileSessionCountdown: (seconds: number) => `下一段 ${seconds} 秒後開始`,
    profileSessionComplete: "瀏覽器錄音已補齊，可加入全部暫存錄音。",
    profileBrowserMicCheck: "檢查瀏覽器麥克風",
    profileBrowserMicChecking: "檢查中",
    profileKitTitle: "外部錄音資料夾",
    profileKitHelp: "建立五段標準資料夾，或建立十段強化資料夾給更穩定的 10x / LoRA 路徑；批次上傳會跟目前資料夾的 clip 數與逐字稿配對。",
    profileKitCreate: "建立資料夾",
    profileKitCreateExtended: "建立十段強化資料夾",
    profileKitCreating: "建立中",
    profileKitCreated: "錄音資料夾已建立",
    profileKitFailed: "建立錄音資料夾失敗。",
    profileKitPreflight: "錄音前檢查",
    profileKitPreflighting: "檢查中",
    profileKitPreflightFailed: "錄音前檢查失敗。",
    profileKitPreflightReady: (count: number, recorder: string) => `可開始錄音：${count} 段待錄；recorder: ${recorder}`,
    profileKitPreflightComplete: "錄音檔已齊，可以檢查並匯入。",
    profileKitMicSmoke: "麥克風 smoke test",
    profileKitMicSmoking: "測試中",
    profileKitMicSmokeFailed: "麥克風 smoke test 失敗。",
    profileKitMicSmokePassed: (bytes: number, seconds: number) => `麥克風可用：已錄到 ${bytes} bytes / ${seconds.toFixed(1)} 秒暫存音檔。`,
    profileKitMicSmokeLevel: (peak: number, clipping: number) => `電平 peak ${peak.toFixed(3)}；clipping ${clipping.toFixed(3)}`,
    profileKitCheck: "檢查錄音",
    profileKitChecking: "檢查中",
    profileKitCheckFailed: "檢查錄音資料夾失敗。",
    profileKitCheckReady: (count: number) => `找到 ${count} 段錄音，可以執行匯入。`,
    profileKitCheckIncomplete: (present: number, total: number) => `找到 ${present} / ${total} 段錄音，先補齊缺少的檔案。`,
    profileKitCheckNeedsFixes: "音檔已找到；先修正逐字稿或發音覆蓋問題再匯入。",
    profileKitNormalize: "整理手機錄音",
    profileKitNormalizing: "整理中",
    profileKitNormalizeFailed: "整理手機錄音失敗。",
    profileKitNormalizeSummary: (normalized: number, existing: number, missing: number) =>
      `已整理 ${normalized} 段；既有 ${existing} 段；還缺 ${missing} 個來源檔。`,
    profileReanalyzeTitle: "既有錄音重掃",
    profileReanalyzeHelp: "補上舊 runs 的品質分析，讓以前錄過且合格的片段可以進入聲音檔案。",
    profileReanalyze: "重掃既有錄音",
    profileReanalyzing: "重掃中",
    profileReanalyzeFailed: "重掃既有錄音失敗。",
    profileReanalysisSummary: (updated: number, scanned: number, failures: number, remaining: number) =>
      `已檢查 ${scanned} 個 run，補上 ${updated} 個分析。${failures > 0 ? `${failures} 個失敗。` : ""}${
        remaining > 0 ? `還需要 ${remaining} 段合格片段。` : "數位聲音已可使用。"
      }`,
    profileReanalysisUpdated: "已補分析",
    profileReanalysisSkipped: "略過",
    profileReanalysisFailures: "重掃失敗",
    profileVerifyTitle: "嚴格聲音檔案檢查",
    profileVerifyHelp: "跑和 quality gate 相同的硬門檻：片段數、發音覆蓋、音檔存在，以及逐字稿 ASR 驗證。",
    profileVerify: "檢查聲音檔案",
    profileVerifying: "檢查中",
    profileVerifyFailed: "檢查聲音檔案失敗。",
    profileVerifyReady: "Hard gate 已通過，可以用固定數位聲音。",
    profileVerifyBlocked: "Hard gate 尚未通過，先補齊下面失敗項目。",
    profileVerifySummary: (selected: number, eligible: number, duration: number) =>
      `${selected} selected / ${eligible} eligible；${duration.toFixed(1)} 秒。`,
    profileRecordingPlan: "下一步錄音",
    profileRecordingPlanMeta: (clips: number, recommended: number, max: number, active: number) =>
      `再錄 ${clips} 段；每段建議 ${recommended.toFixed(0)}-${max.toFixed(0)} 秒，人聲至少 ${active.toFixed(1)} 秒。`,
    profileRecordingPlanCoverage: (features: string) => `待補發音覆蓋：${features}`,
    profileVerifyNext: "下一步命令",
    profileVerifyNextReason: "原因",
    profileVerifyBrief: "錄音 session 摘要",
    profileGoalAuditTitle: "10x 完成度審核",
    profileGoalAuditHelp: "讀取目前所有證據：錄音、逐字稿、品質門檻、10x proof、LoRA 與 adapter。",
    profileGoalAudit: "審核完成度",
    profileGoalAuditing: "審核中",
    profileGoalAuditFailed: "無法審核 10x 完成度。",
    profileGoalAuditComplete: "完整數位聲音已通過所有 gate。",
    profileGoalAuditBlocked: (stage: string) => `尚未完成：卡在 ${stage}`,
    profileGoalAuditFirstBlocker: "第一個阻塞",
    profileGoalAuditFocusedClip: "下一段缺少錄音",
    profileGoalAuditRecordingPreflight: "錄音前 recorder 狀態",
    profileGoalAuditStages: "Gate 狀態",
    profileGoalAuditNext: "下一步",
    profileGoalAuditBrief: "錄音前狀態",
    profileGoalAuditOpenCueSheet: "開啟讀稿提示",
    profileGoalAuditMicrophoneSmoke: "麥克風 smoke test",
    profileGoalAuditNormalize: "整理手機錄音",
    profileGoalAuditProductProof: "錄音到 10x proof",
    profileGoalAuditProofEnvironment: "Proof backend 檢查",
    profileGoalAuditProofEnvironmentStatus: "Proof backend 狀態",
    profileGoalAuditLoraHandoff: "錄音到 LoRA handoff",
    profileProofPlan: "錄完後驗證",
    profileProofHelp: "這個資料夾的 WAV 錄完後，用這個流程證明可用；會停在 LoRA 匯出前。",
    profileProofCommand: "Proof 命令",
    profileProductProofCommand: "10x Proof 命令",
    profileProductProofAsrBackend: "10x 發音 ASR",
    profileProductProofAsrBackendReady: (backend: string) => `${backend} 已就緒`,
    profileProductProofAsrBackendMissing: (backend: string, selected: string) => `${backend} 缺少；目前 auto 會用 ${selected}`,
    profileProductProofBackend: "10x 聲紋驗證",
    profileProductProofBackendReady: (backend: string) => `${backend} 已就緒`,
    profileProductProofBackendMissing: (backend: string, selected: string) => `${backend} 缺少；目前 auto 會用 ${selected}`,
    profileProofArtifacts: "證據檔",
    profileProofGates: "檢查順序",
    profileTranscriptValidate: "驗證逐字稿",
    profileTranscriptValidating: "驗證中",
    profileTranscriptValidateFailed: "逐字稿驗證失敗。",
    profileTranscriptValidationReady: (passed: number, total: number) => `逐字稿 ASR 驗證通過：${passed} / ${total}。`,
    profileTranscriptValidationBlocked: (passed: number, total: number) => `逐字稿 ASR 驗證未通過：${passed} / ${total}。`,
    profileTranscriptValidationMeta: (backend: string) => `ASR backend: ${backend}`,
    profileTranscriptValidationReport: "驗證報告",
    profileKitRecordings: "錄音放這裡",
    profileKitCoverage: "讀稿覆蓋",
    profileKitCoverageReady: (features: string) => `已覆蓋：${features}`,
    profileKitCoverageMissing: (features: string) => `待補：${features}`,
    profileKitCueSheet: "讀稿提示",
    profileKitOpenCueSheet: "開啟讀稿提示",
    profileKitCueHelp: "提示只用來抓準發音，不要唸進逐字稿。",
    profileKitCueNotes: "發音提示",
    profileKitCueTarget: (seconds: number) => `目標 ${seconds.toFixed(0)} 秒`,
    profileKitRecordNext: "下一段錄音",
    profileKitRecordAndProve: "錄音加驗證",
    profileKitRecordAndProductProof: "錄音加 10x 驗證",
    profileKitRecordAndLora: "錄音到 LoRA 交付",
    profileKitProof: "錄完後驗證",
    profileKitEnroll: "錄完後執行",
    profileKitImport: "檢查通過後執行",
    profileBulkUpload: (count: number) => `上傳 ${count} 段錄音`,
    profileBulkUploading: "上傳分析中",
    profileBulkSuccess: (count: number, remaining: number) =>
      `已上傳 ${count} 段錄音。${remaining > 0 ? `還需要 ${remaining} 段合格片段。` : "數位聲音已可使用。"}`,
    profileBulkProofStarted: "已自動開始逐字稿驗證與 10x 完成度審核。",
    profileBulkMissing: (count: number) => `請一次選擇 ${count} 個錄音檔。`,
    profileBulkNameMismatch: (first: string, last: string) => `檔名需包含 ${first} 到 ${last}，才能和逐字稿正確配對。`,
    profileBulkFailed: "無法匯入這批錄音。",
    profileStopMin: (minSec: number) => `至少 ${minSec} 秒`,
    profileStopVoiceActive: (minVoiceActive: string) => `人聲至少 ${minVoiceActive}`,
    profileVoiceActiveMeter: (voiceActive: string, target: string) => `人聲 ${voiceActive} / ${target}`,
    profileDiagnostics: "主要問題",
    profileNoDiagnostics: "目前沒有阻擋問題。",
    profileScriptMix: "腳本分布",
    profileRejectedExamples: "最近未通過",
    profileRejectedMeta: (grade: string, duration: string) => `品質 ${grade} / ${duration}`,
    profileEnroll: "加入聲音檔案",
    profileEnrolling: "分析中",
    profileEnrollSuccess: (grade: string, remaining: number) =>
      `已加入參考音，品質 ${grade}。${remaining > 0 ? `還需要 ${remaining} 段。` : "數位聲音已可使用。"}`,
    profileEnrollRejected: (reason: string) => `已保存分析結果，但這段不會成為合格片段：${reason}。`,
    profileEnrollSampleBlocked: "示範聲音不能加入你的數位聲音檔案。",
    profileEnrollScriptBlocked: "聲音檔案需要繁體中文逐字稿；簡體或繁簡混用會造成發音不穩，請先改成繁體再加入。",
    profileEnrollScriptUnprovenBlocked: "這段逐字稿是中文，但目前無法證明是繁體。請改用含明確繁體字的逐字稿，再加入聲音檔案。",
    profileTargetScriptBlocked: "使用數位聲音時，目標文字需要繁體中文；簡體或繁簡混用會讓中文發音不穩。",
    profileTargetScriptUnprovenBlocked: "使用數位聲音時，中文目標文字需要明確繁體線索；目前無法證明這段是繁體。",
    profileEnrollShortBlocked: (minSec: number) => `這段太短，請錄到至少 ${minSec} 秒再加入聲音檔案。`,
    profileEnrollLongBlocked: (maxSec: number) => `這段太長，請剪到 ${maxSec} 秒內再加入聲音檔案。`,
    profileEnrollFailed: "無法加入聲音檔案。",
    scriptWarningTarget: "偵測到簡體或繁簡混用。系統會保留原文，不會自動轉換；為了中文發音穩定，建議改成繁體。",
    scriptWarningTargetUnproven: "這段目標文字是中文，但目前沒有足夠線索證明是繁體；使用數位聲音前請改成明確繁體。",
    scriptFixTarget: "套用已知繁體修正",
    scriptWarningTranscript: "這段逐字稿看起來有簡體或繁簡混用。請確認它和錄音逐字一致；如果你要建立繁體中文聲音，建議改用繁體。",
    scriptWarningTranscriptUnproven: "這段逐字稿是中文，但缺少明確繁體線索；建立繁體中文聲音前請改用可判斷的繁體字。",
    scriptWarningMismatch: "目標文字和參考逐字稿的中文腳本不同，可能造成發音或口音不穩。",
    scriptWarningDetails: (details: string) => `偵測線索：${details}`,
    profileKitScriptInvalid: "逐字稿含簡體或繁簡混用",
    profileKitScriptUnproven: "逐字稿是中文，但缺少明確繁體線索",
    profileKitScriptMissing: "逐字稿缺少中文內容",
    profileKitRushedTake: "低於該段目標秒數，可能唸太趕",
    profileKitClippingDetected: "音量爆掉或削波，請降低輸入音量重錄",
    profileKitTooQuiet: "音量太小，請靠近麥克風或提高輸入音量",
    profileKitLevelUnreadable: "無法讀取音量品質",
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
    scriptStep: (index: number, total: number) => `Clip ${index} / ${total}`,
    previousScript: "Previous script",
    nextScript: "Next script",
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
    sourceProfile: "Digital voice",
    referenceSavedLocal: "Saved in this browser; it restores on reload.",
    downloadReference: "Download current voice sample",
    clearReference: "Remove current voice sample",
    requestingMic: "Requesting mic",
    stop: "Stop",
    upload: "Upload audio",
    targetPlaceholder: "Write the line you want this voice to say…",
    pronunciationTitle: "Pronunciation replacements",
    pronunciationHelp: "One per line: term=model-readable wording; pinyin:term=reading is also accepted. Target text only, never the transcript.",
    pronunciationPlaceholder: "Chongqing=Chong-ching\npinyin:行長=xing2 zhang3",
    pronunciationPreview: "Model text",
    pronunciationInvalid: (line: number) => `Line ${line} cannot be used.`,
    pronunciationSuggestions: "Suggested replacements",
    pronunciationSuggestionPolyphone: "Polyphone",
    pronunciationSuggestionBrand: "Name",
    consent:
      "I own this voice recording, or have explicit permission from the speaker to use it, and I will not use it for impersonation, fraud, or to mislead listeners.",
    submit: "Generate voice",
    submitting: "Submitting",
    qualityTitle: "Synthesis mode",
    qualityHelp: "Default uses Brenda's balanced VoxCPM2 lane; the slower mode is only for voice-stability comparison.",
    qualitySpeed: "Speed",
    qualitySpeedHint: "Fastest response for draft lines.",
    qualityBalanced: "Balanced",
    qualityBalancedHint: "Brenda-default lane for most recordings.",
    qualityQuality: "Stable voice",
    qualityQualityHint: "Slightly slower without forced denoise or aggressive CFG.",
    guideIdle: "Aim for 6-20 seconds, normal volume, quiet background.",
    guideRequesting: "Waiting for microphone permission.",
    guideKeepReading: "Keep reading until at least 6 seconds.",
    guideKeepRecording: (target: string) => `Keep reading until at least ${target}.`,
    guideKeepSpeaking: (voiceActive: string, target: string) => `Keep reading until active voice reaches ${target}; now ${voiceActive}.`,
    guideGoodLevel: "Level looks good. Keep this distance.",
    guideTooQuiet: "Input is quiet. Move closer or raise gain.",
    guideTooLoud: "Input is hot. Back off to avoid clipping.",
    guideEnough: "Sample is long enough. You can stop.",
    guideReady: "Reference audio is ready.",
    guideCapturedShort: "Reference is short. Re-record past 6 seconds for better matching.",
    guideCapturedLong: "Reference is long. Trim toward 20-30 seconds for steadier cloning.",
    captureSettingsDetails: (channels: string, sampleRate: string) => `${channels} ch / ${sampleRate}`,
    captureSettingsClean: (details: string) => `Capture: ${details}, browser processing is off.`,
    captureSettingsUnknown: (details: string) => `Capture: ${details}, browser processing was not reported.`,
    captureSettingsWarning: (details: string, processing: string) =>
      `Capture: ${details}; browser still has ${processing} on, which can destabilize voice identity.`,
    captureUnknownValue: "unknown",
    captureEchoCancellation: "echo cancellation",
    captureNoiseSuppression: "noise suppression",
    captureAutoGainControl: "auto gain",
    profileCaptureProcessingBlocked: (processing: string) =>
      `The browser still has ${processing} enabled. Use a browser or microphone path that can disable processing, or use the external recording kit.`,
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
    historyTitle: "Recent results",
    historyHelp: "Recent results for this browser",
    historyRefresh: "Refresh history",
    historyEmpty: "No generated results yet.",
    historyLoading: "Loading history",
    historyFailed: "Could not load history.",
    historyDelete: "Remove from history",
    historyOpen: "Load this result",
    historyStatusReady: "Ready",
    historyStatusWorker: "Needs worker",
    historyStatusError: "Failed",
    profileTitle: "Voice profile",
    profileHelp: "A stable digital voice needs multiple qualified reference clips, not one short recording.",
    profileReady: "Digital voice ready",
    profileNeeds: "Needs more recordings",
    profileSessionTitle: (count: number) => `${count}-clip recording progress`,
    profileScriptStatusAccepted: "Accepted",
    profileScriptStatusRejected: "Rejected",
    profileScriptStatusMissing: "Missing",
    profileDraftRestored: (count: number) => `${count} profile recording${count === 1 ? "" : "s"} saved in this browser.`,
    profileDraftSaved: "Saved draft",
    profileDraftUse: "Add saved recording",
    profileDraftUseAll: "Add all saved recordings",
    profileDraftClear: "Clear drafts",
    profileDraftFailed: "Could not load this saved recording.",
    profileDraftDuration: (duration: string) => `Saved ${duration}`,
    profileDraftDurationWithVoice: (duration: string, voiceActive: string) => `Saved ${duration} / voice ${voiceActive}`,
    profileDraftTooShort: (duration: string, minSec: number) => `${duration}, under ${minSec} s`,
    profileDraftTooLong: (duration: string, maxSec: number) => `${duration}, over ${maxSec} s`,
    profileDraftLowVoiceActive: (duration: string, voiceActive: string, minVoiceActive: string) =>
      `${duration} / voice ${voiceActive}, under ${minVoiceActive}`,
    profileDraftProcessedCapture: (duration: string, processing: string) => `${duration}, browser processing on: ${processing}`,
    profileDraftDurationBlocked:
      "One or more saved recordings are outside the duration or active-voice gate. Re-record those clips before importing all.",
    profileDraftCaptureBlocked:
      "One or more saved recordings still have browser processing enabled. Re-record those clips before importing all.",
    profileEligible: "Qualified",
    profileRejected: "Rejected",
    profileRemaining: (count: number) => `${count} more needed`,
    profileCoverageTitle: "Pronunciation coverage",
    profileCoverageDone: (count: number) => `${count} covered`,
    profileCoverageMissing: "Missing",
    profileGate: (min: number, minSec: number, maxSec: number) =>
      `Gate: at least ${min} distinct clips, ${minSec}-${maxSec} s each, grade A/B, covering numbers, English terms, and polyphones.`,
    profileRefresh: "Refresh voice profile",
    profileFailed: "Could not load voice profile.",
    profileUse: "Use digital voice",
    profileUsing: "Uses the fixed reference clip that passed the hard gate.",
    profileUseNeedsVerify: "Requires strict check plus ASR transcript validation first.",
    profileUseBlocked: "Hard gate is blocked. Fix the failed checks first.",
    profileUseChecking: "Checking hard gate.",
    profileNextTitle: "Next recording",
    profileNextHelp: (feature: string) => `Fill first: ${feature}`,
    profileNextAction: "Record and add",
    profileSessionStart: "Record remaining",
    profileSessionStop: "Stop session",
    profileSessionActive: (done: number, total: number) => `Recording session: ${done} / ${total} drafts saved.`,
    profileSessionCountdown: (seconds: number) => `Next clip starts in ${seconds} s`,
    profileSessionComplete: "Browser recordings are complete. Add all saved recordings when ready.",
    profileBrowserMicCheck: "Check browser mic",
    profileBrowserMicChecking: "Checking",
    profileKitTitle: "External recording kit",
    profileKitHelp: "Create the 5-clip standard folder, or a 10-clip extended folder for the stronger 10x / LoRA path. Bulk upload follows the current kit's clip count and transcripts.",
    profileKitCreate: "Create folder",
    profileKitCreateExtended: "Create 10-clip folder",
    profileKitCreating: "Creating",
    profileKitCreated: "Recording folder created",
    profileKitFailed: "Could not create recording kit.",
    profileKitPreflight: "Preflight",
    profileKitPreflighting: "Checking",
    profileKitPreflightFailed: "Could not preflight recording kit.",
    profileKitPreflightReady: (count: number, recorder: string) => `Ready to record: ${count} clip${count === 1 ? "" : "s"} pending; recorder: ${recorder}`,
    profileKitPreflightComplete: "Recordings are present. Check and import next.",
    profileKitMicSmoke: "Mic smoke test",
    profileKitMicSmoking: "Testing",
    profileKitMicSmokeFailed: "Mic smoke test failed.",
    profileKitMicSmokePassed: (bytes: number, seconds: number) => `Mic works: captured ${bytes} bytes / ${seconds.toFixed(1)}s temporary audio.`,
    profileKitMicSmokeLevel: (peak: number, clipping: number) => `level peak ${peak.toFixed(3)}; clipping ${clipping.toFixed(3)}`,
    profileKitCheck: "Check recordings",
    profileKitChecking: "Checking",
    profileKitCheckFailed: "Could not check recording kit.",
    profileKitCheckReady: (count: number) => `${count} recordings found. Ready to import.`,
    profileKitCheckIncomplete: (present: number, total: number) => `${present} / ${total} recordings found. Add the missing files first.`,
    profileKitCheckNeedsFixes: "Recordings found. Fix transcript or coverage issues before import.",
    profileKitNormalize: "Normalize phone files",
    profileKitNormalizing: "Normalizing",
    profileKitNormalizeFailed: "Could not normalize phone recordings.",
    profileKitNormalizeSummary: (normalized: number, existing: number, missing: number) =>
      `${normalized} normalized; ${existing} already present; ${missing} source file${missing === 1 ? "" : "s"} missing.`,
    profileReanalyzeTitle: "Existing recording rescan",
    profileReanalyzeHelp: "Backfill quality analysis for older runs so previously recorded eligible clips can enter the voice profile.",
    profileReanalyze: "Rescan recordings",
    profileReanalyzing: "Rescanning",
    profileReanalyzeFailed: "Could not rescan existing recordings.",
    profileReanalysisSummary: (updated: number, scanned: number, failures: number, remaining: number) =>
      `Checked ${scanned} runs and backfilled ${updated}. ${failures > 0 ? `${failures} failed. ` : ""}${
        remaining > 0 ? `${remaining} qualified clips still needed.` : "Digital voice is ready."
      }`,
    profileReanalysisUpdated: "Backfilled",
    profileReanalysisSkipped: "Skipped",
    profileReanalysisFailures: "Failures",
    profileVerifyTitle: "Strict voice-profile check",
    profileVerifyHelp: "Runs the same hard gate as the quality gate: clip count, pronunciation coverage, audio files, and ASR transcript validation.",
    profileVerify: "Check voice profile",
    profileVerifying: "Checking",
    profileVerifyFailed: "Could not verify voice profile.",
    profileVerifyReady: "Hard gate passed. Fixed digital voice is usable.",
    profileVerifyBlocked: "Hard gate is blocked. Fix the failed checks below.",
    profileVerifySummary: (selected: number, eligible: number, duration: number) =>
      `${selected} selected / ${eligible} eligible; ${duration.toFixed(1)} s.`,
    profileRecordingPlan: "Next recording",
    profileRecordingPlanMeta: (clips: number, recommended: number, max: number, active: number) =>
      `Record ${clips} more; aim for ${recommended.toFixed(0)}-${max.toFixed(0)} s each, with at least ${active.toFixed(1)} s active voice.`,
    profileRecordingPlanCoverage: (features: string) => `Missing pronunciation coverage: ${features}`,
    profileVerifyNext: "Next command",
    profileVerifyNextReason: "Reason",
    profileVerifyBrief: "Recording session brief",
    profileGoalAuditTitle: "10x completion audit",
    profileGoalAuditHelp: "Reads current evidence: recordings, transcripts, quality gates, 10x proof, LoRA, and adapter.",
    profileGoalAudit: "Audit completion",
    profileGoalAuditing: "Auditing",
    profileGoalAuditFailed: "Could not audit 10x completion.",
    profileGoalAuditComplete: "Digital voice has passed every gate.",
    profileGoalAuditBlocked: (stage: string) => `Not complete: blocked at ${stage}`,
    profileGoalAuditFirstBlocker: "First blocker",
    profileGoalAuditFocusedClip: "Next missing recording",
    profileGoalAuditRecordingPreflight: "Recorder preflight",
    profileGoalAuditStages: "Gate status",
    profileGoalAuditNext: "Next step",
    profileGoalAuditBrief: "Preflight brief",
    profileGoalAuditOpenCueSheet: "Open cue sheet",
    profileGoalAuditMicrophoneSmoke: "Microphone smoke test",
    profileGoalAuditNormalize: "Normalize phone files",
    profileGoalAuditProductProof: "Record to 10x proof",
    profileGoalAuditProofEnvironment: "Proof backend check",
    profileGoalAuditProofEnvironmentStatus: "Proof backend status",
    profileGoalAuditLoraHandoff: "Record to LoRA handoff",
    profileProofPlan: "After-recording proof",
    profileProofHelp: "After this kit's WAVs exist, this proves the profile and stops before LoRA export.",
    profileProofCommand: "Proof command",
    profileProductProofCommand: "10x proof command",
    profileProductProofAsrBackend: "10x ASR backend",
    profileProductProofAsrBackendReady: (backend: string) => `${backend} ready`,
    profileProductProofAsrBackendMissing: (backend: string, selected: string) => `${backend} missing; auto will use ${selected}`,
    profileProductProofBackend: "10x speaker backend",
    profileProductProofBackendReady: (backend: string) => `${backend} ready`,
    profileProductProofBackendMissing: (backend: string, selected: string) => `${backend} missing; auto will use ${selected}`,
    profileProofArtifacts: "Evidence files",
    profileProofGates: "Gate order",
    profileTranscriptValidate: "Validate transcripts",
    profileTranscriptValidating: "Validating",
    profileTranscriptValidateFailed: "Could not validate transcripts.",
    profileTranscriptValidationReady: (passed: number, total: number) => `ASR transcript validation passed: ${passed} / ${total}.`,
    profileTranscriptValidationBlocked: (passed: number, total: number) => `ASR transcript validation blocked: ${passed} / ${total}.`,
    profileTranscriptValidationMeta: (backend: string) => `ASR backend: ${backend}`,
    profileTranscriptValidationReport: "Validation report",
    profileKitRecordings: "Recordings folder",
    profileKitCoverage: "Prompt coverage",
    profileKitCoverageReady: (features: string) => `Covered: ${features}`,
    profileKitCoverageMissing: (features: string) => `Missing: ${features}`,
    profileKitCueSheet: "Cue sheet",
    profileKitOpenCueSheet: "Open cue sheet",
    profileKitCueHelp: "Use notes to rehearse pronunciation; do not read them into the transcript.",
    profileKitCueNotes: "Pronunciation notes",
    profileKitCueTarget: (seconds: number) => `Target ${seconds.toFixed(0)} s`,
    profileKitRecordNext: "Record next clip",
    profileKitRecordAndProve: "Record and prove",
    profileKitRecordAndProductProof: "Record and 10x proof",
    profileKitRecordAndLora: "Record to LoRA handoff",
    profileKitProof: "After-recording proof",
    profileKitEnroll: "After recording",
    profileKitImport: "After check passes",
    profileBulkUpload: (count: number) => `Upload ${count} recordings`,
    profileBulkUploading: "Uploading",
    profileBulkSuccess: (count: number, remaining: number) =>
      `${count} recordings uploaded. ${remaining > 0 ? `${remaining} qualified clips still needed.` : "Digital voice is ready."}`,
    profileBulkProofStarted: "Transcript validation and 10x completion audit started automatically.",
    profileBulkMissing: (count: number) => `Select ${count} recording files at once.`,
    profileBulkNameMismatch: (first: string, last: string) =>
      `Filenames must include ${first} through ${last} so each clip matches the right transcript.`,
    profileBulkFailed: "Could not import these recordings.",
    profileStopMin: (minSec: number) => `Min ${minSec} s`,
    profileStopVoiceActive: (minVoiceActive: string) => `Voice min ${minVoiceActive}`,
    profileVoiceActiveMeter: (voiceActive: string, target: string) => `Voice ${voiceActive} / ${target}`,
    profileDiagnostics: "Top issues",
    profileNoDiagnostics: "No blocking issues right now.",
    profileScriptMix: "Script mix",
    profileRejectedExamples: "Recent rejected",
    profileRejectedMeta: (grade: string, duration: string) => `Grade ${grade} / ${duration}`,
    profileEnroll: "Add to voice profile",
    profileEnrolling: "Analyzing",
    profileEnrollSuccess: (grade: string, remaining: number) =>
      `Reference saved, grade ${grade}. ${remaining > 0 ? `${remaining} more needed.` : "Digital voice is ready."}`,
    profileEnrollRejected: (reason: string) => `Analysis saved, but this clip is not qualified: ${reason}.`,
    profileEnrollSampleBlocked: "The sample voice cannot be added to your digital voice profile.",
    profileEnrollScriptBlocked:
      "Voice-profile enrollment requires a Traditional Chinese transcript. Convert Simplified or mixed Chinese before adding this clip.",
    profileEnrollScriptUnprovenBlocked:
      "This transcript is Chinese, but AnyVoice cannot prove it is Traditional Chinese. Use a transcript with clear zh-Hant evidence before adding it.",
    profileTargetScriptBlocked:
      "Digital-voice generation requires Traditional Chinese target text; Simplified or mixed Chinese destabilizes Mandarin pronunciation.",
    profileTargetScriptUnprovenBlocked:
      "Digital-voice generation requires clear Traditional Chinese evidence for Chinese target text; this text is currently unproven.",
    profileEnrollShortBlocked: (minSec: number) => `This clip is too short. Record at least ${minSec} seconds before adding it.`,
    profileEnrollLongBlocked: (maxSec: number) => `This clip is too long. Trim it under ${maxSec} seconds before adding it.`,
    profileEnrollFailed: "Could not add this voice sample.",
    scriptWarningTarget:
      "Simplified or mixed Chinese detected. The system preserves your text instead of auto-converting it; use Traditional Chinese for steadier Mandarin pronunciation.",
    scriptWarningTargetUnproven:
      "This target is Chinese, but there is not enough evidence to prove it is Traditional Chinese. Make it clearly zh-Hant before using the digital voice.",
    scriptFixTarget: "Apply known Traditional fixes",
    scriptWarningTranscript:
      "This transcript appears to contain Simplified or mixed Chinese. Keep it word-for-word with the recording; use Traditional Chinese for a Traditional Mandarin profile.",
    scriptWarningTranscriptUnproven:
      "This transcript is Chinese, but lacks clear Traditional evidence. Use distinguishable Traditional characters before building the Traditional Mandarin profile.",
    scriptWarningMismatch:
      "The target text and reference transcript use different Chinese scripts, which can make pronunciation or accent less stable.",
    scriptWarningDetails: (details: string) => `Detected script markers: ${details}`,
    profileKitScriptInvalid: "Transcript contains Simplified or mixed Chinese",
    profileKitScriptUnproven: "Transcript is Chinese but lacks clear Traditional evidence",
    profileKitScriptMissing: "Transcript is missing Chinese content",
    profileKitRushedTake: "Below this prompt's target duration; likely rushed",
    profileKitClippingDetected: "Input clipped; lower the gain and record again",
    profileKitTooQuiet: "Input is too quiet; move closer or raise gain",
    profileKitLevelUnreadable: "Audio level quality could not be read",
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

function profileClipStem(index: number): string {
  return `profile-clip-${String(index + 1).padStart(2, "0")}`;
}

function profileClipIndexFromName(name: string, expectedCount = SCRIPT_PACK["zh-Hant"].length): number | null {
  const match = name.toLowerCase().match(/profile-clip-(\d{1,2})/);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < expectedCount ? index : null;
}

interface ProfileBulkClipSpec {
  id: string;
  expectedStem: string;
  transcript: string;
  recommendedDurationSec?: number;
  durationTargetSec?: number;
}

function defaultProfileBulkClipSpecs(): ProfileBulkClipSpec[] {
  return SCRIPT_PACK["zh-Hant"].map((transcript, index) => {
    const stem = profileClipStem(index);
    return {
      id: stem,
      expectedStem: stem,
      transcript,
    };
  });
}

function finitePositiveSeconds(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function recordingKitTargetDurationSec(clip?: Pick<RecordingKitClipSpec, "durationTargetSec" | "recommendedDurationSec"> | null): number | null {
  return finitePositiveSeconds(clip?.durationTargetSec) ?? finitePositiveSeconds(clip?.recommendedDurationSec);
}

function profileBulkTargetDurationSec(spec?: Pick<ProfileBulkClipSpec, "durationTargetSec" | "recommendedDurationSec"> | null): number | null {
  return finitePositiveSeconds(spec?.durationTargetSec) ?? finitePositiveSeconds(spec?.recommendedDurationSec);
}

function preflightClipTargetDurationSec(clip?: Pick<RecordingKitPreflightClip, "durationTargetSec" | "recommendedDurationSec"> | null): number | null {
  return finitePositiveSeconds(clip?.durationTargetSec) ?? finitePositiveSeconds(clip?.recommendedDurationSec);
}

function recordingGuidanceTargetLabel(guidance?: {
  durationMode?: string;
  targetDurationSec?: number | null;
  targetDurationLabel?: string;
}): string {
  if (!guidance) return "";
  const targetDurationSec = finitePositiveSeconds(guidance.targetDurationSec ?? undefined);
  if (targetDurationSec !== null) return `${Number.isInteger(targetDurationSec) ? targetDurationSec.toFixed(0) : targetDurationSec.toFixed(1)}s`;
  if (guidance.targetDurationLabel) return guidance.targetDurationLabel;
  if (guidance.durationMode === "auto") return "auto per clip";
  return "unknown";
}

function recordingKitBulkClipSpecs(recordingKit: RecordingKitPayload | null): ProfileBulkClipSpec[] {
  const specs = recordingKit?.clipSpecs;
  if (!Array.isArray(specs) || specs.length === 0) return defaultProfileBulkClipSpecs();
  const normalized = specs.slice(0, MAX_PROFILE_DRAFTS).flatMap((clip, index) => {
    const transcript = typeof clip.transcript === "string" ? clip.transcript.trim() : "";
    if (!transcript) return [];
    const id = typeof clip.id === "string" && clip.id.trim() ? clip.id.trim() : profileClipStem(index);
    const targetDurationSec = recordingKitTargetDurationSec(clip);
    return [
      {
        id,
        expectedStem: typeof clip.expectedStem === "string" && clip.expectedStem.trim() ? clip.expectedStem.trim() : id,
        transcript,
        recommendedDurationSec: finitePositiveSeconds(clip.recommendedDurationSec) ?? undefined,
        durationTargetSec: targetDurationSec ?? undefined,
      },
    ];
  });
  return normalized.length > 0 ? normalized : defaultProfileBulkClipSpecs();
}

interface PersistedReference {
  key: typeof LAST_REFERENCE_KEY;
  kind: SourceKind;
  mode: Mode;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
  transcript: string;
  savedAt: number;
}

interface PersistedProfileDraft {
  key: string;
  index: number;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
  transcript: string;
  durationSec?: number;
  voiceActiveSec?: number;
  captureSettings?: ProfileDraftCaptureSettings;
  savedAt: number;
}

interface ProfileDraftCaptureSettings {
  channelCount?: number;
  sampleRate?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

interface ProfileDraftClip {
  index: number;
  file: File;
  transcript: string;
  durationSec?: number;
  voiceActiveSec?: number;
  captureSettings?: ProfileDraftCaptureSettings;
  savedAt: number;
}

function modeForSourceKind(kind: SourceKind): Mode {
  return kind === "freeform" || kind === "uploaded" ? "freeform" : "scripted";
}

function transcriptForSourceKind(kind: SourceKind, locale: Locale, freeformTranscript: string): string {
  if (kind === "scripted") return SCRIPT_PACK[locale][0];
  if (kind === "sample") return SAMPLE_VOICE_TRANSCRIPT;
  return freeformTranscript.trim();
}

function isSourceKind(value: unknown): value is SourceKind {
  return value === "sample" || value === "scripted" || value === "freeform" || value === "uploaded";
}

function isMode(value: unknown): value is Mode {
  return value === "scripted" || value === "freeform";
}

function isChineseScript(script: DetectedChineseScript): boolean {
  return script === "zh_hant" || script === "zh_hans" || script === "mixed_zh" || script === "zh_unknown";
}

type ChineseScriptIssue = "none" | "invalid" | "unproven";

function chineseScriptIssue(text: string): ChineseScriptIssue {
  const errors = strictTraditionalChineseScriptErrors(text);
  if (errors.includes("invalid_chinese_script")) return "invalid";
  if (errors.includes("unproven_chinese_script")) return "unproven";
  return "none";
}

function isUnstableChineseScript(text: string): boolean {
  return chineseScriptIssue(text) !== "none";
}

function hasChineseScriptMismatch(referenceText: string, targetText: string): boolean {
  const referenceScript = detectChineseScript(referenceText);
  const targetScript = detectChineseScript(targetText);
  if (!isChineseScript(referenceScript) || !isChineseScript(targetScript)) return false;
  if (referenceScript === "zh_unknown" || targetScript === "zh_unknown") return false;
  return referenceScript !== targetScript;
}

function formatScriptMarkerList(markers: Array<{ char: string; count: number; counterpart: string }>): string {
  return markers
    .slice(0, 6)
    .map((marker) => `${marker.char}->${marker.counterpart}${marker.count > 1 ? `x${marker.count}` : ""}`)
    .join(", ");
}

function scriptWarningWithDetails(text: string, baseMessage: string, t: typeof copy[Locale], locale: Locale): string {
  const diagnostics = analyzeChineseScript(text);
  const parts: string[] = [];
  if (diagnostics.simplifiedMarkers.length > 0) {
    const label = locale === "zh-Hant" ? "簡體" : "Simplified";
    parts.push(`${label}: ${formatScriptMarkerList(diagnostics.simplifiedMarkers)}`);
  }
  if (diagnostics.traditionalMarkers.length > 0 && diagnostics.simplifiedMarkers.length > 0) {
    const label = locale === "zh-Hant" ? "繁體" : "Traditional";
    parts.push(`${label}: ${formatScriptMarkerList(diagnostics.traditionalMarkers)}`);
  }
  if (!parts.length) return baseMessage;
  return `${baseMessage} ${t.scriptWarningDetails(parts.join("; "))}`;
}

function scriptWarningForIssue(
  text: string,
  issue: ChineseScriptIssue,
  invalidMessage: string,
  unprovenMessage: string,
  t: typeof copy[Locale],
  locale: Locale,
): string {
  if (issue === "invalid") return scriptWarningWithDetails(text, invalidMessage, t, locale);
  if (issue === "unproven") return scriptWarningWithDetails(text, unprovenMessage, t, locale);
  return "";
}

function scriptBlockMessageForIssue(
  issue: ChineseScriptIssue,
  invalidMessage: string,
  unprovenMessage: string,
): string {
  if (issue === "invalid") return invalidMessage;
  if (issue === "unproven") return unprovenMessage;
  return "";
}

function describeRecordingKitError(error: string, t: typeof copy[Locale]): string {
  if (error === "invalid_chinese_script") return String(t.profileKitScriptInvalid);
  if (error === "unproven_chinese_script") return String(t.profileKitScriptUnproven);
  if (error === "missing_chinese_script") return String(t.profileKitScriptMissing);
  if (error === "audio_below_target_duration") return String(t.profileKitRushedTake);
  if (error === "audio_clipping_detected") return String(t.profileKitClippingDetected);
  if (error === "audio_too_quiet") return String(t.profileKitTooQuiet);
  if (error === "audio_level_quality_unreadable") return String(t.profileKitLevelUnreadable);
  return error.replaceAll("_", " ");
}

function recordingKitCheckDetailLines(check: RecordingKitCheckPayload["checks"][number], t: typeof copy[Locale]): string[] {
  const rows = check.details?.rows ?? [];
  return rows.flatMap((row) => {
    const errors = row.errors ?? [];
    if (!errors.length) return [];
    const id = row.id || (row.index ? `clip-${row.index}` : check.check);
    const script = row.transcriptScript ? ` (${row.transcriptScript})` : "";
    return [`${id}${script}: ${errors.map((error) => describeRecordingKitError(error, t)).join(", ")}`];
  });
}

function referenceKey(file: File | null, kind: SourceKind | null, transcript: string): string {
  if (!file || !kind) return "";
  return [kind, file.name, file.size, file.lastModified, transcript].join(":");
}

function profileDraftKey(index: number): string {
  return `${PROFILE_DRAFT_KEY_PREFIX}${index}`;
}

function openReferenceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }

    const request = window.indexedDB.open(REFERENCE_DB_NAME, REFERENCE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REFERENCE_STORE)) {
        db.createObjectStore(REFERENCE_STORE, { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

async function loadPersistedRecord<T>(key: string): Promise<T | null> {
  const db = await openReferenceDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(REFERENCE_STORE, "readonly");
    const store = transaction.objectStore(REFERENCE_STORE);
    const request = store.get(key);

    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

async function loadPersistedReference(): Promise<PersistedReference | null> {
  return loadPersistedRecord<PersistedReference>(LAST_REFERENCE_KEY);
}

async function savePersistedReference(input: Omit<PersistedReference, "key" | "savedAt">): Promise<void> {
  return savePersistedRecord({
    ...input,
    key: LAST_REFERENCE_KEY,
    savedAt: Date.now(),
  } satisfies PersistedReference);
}

async function savePersistedRecord<T extends { key: string }>(record: T): Promise<void> {
  const db = await openReferenceDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(REFERENCE_STORE, "readwrite");
    const store = transaction.objectStore(REFERENCE_STORE);
    store.put(record);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB write failed"));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB write aborted"));
    };
  });
}

async function deletePersistedRecord(key: string): Promise<void> {
  const db = await openReferenceDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(REFERENCE_STORE, "readwrite");
    const store = transaction.objectStore(REFERENCE_STORE);
    store.delete(key);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB delete failed"));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB delete aborted"));
    };
  });
}

async function deletePersistedReference(): Promise<void> {
  return deletePersistedRecord(LAST_REFERENCE_KEY);
}

function fileFromPersistedReference(reference: PersistedReference): File | null {
  if (!isSourceKind(reference.kind) || !isMode(reference.mode) || !(reference.file instanceof Blob)) {
    return null;
  }
  if (reference.file instanceof File) return reference.file;
  return new File([reference.file], reference.name || "reference.audio", {
    type: reference.type || reference.file.type || "audio/webm",
    lastModified: reference.lastModified || reference.savedAt || Date.now(),
  });
}

function fileExtensionFromFile(file: File): string {
  const nameExtension = file.name.split(".").pop();
  if (nameExtension && nameExtension !== file.name && /^[a-z0-9]{2,5}$/i.test(nameExtension)) {
    return nameExtension.toLowerCase();
  }
  if (file.type.includes("mp4")) return "m4a";
  if (file.type.includes("wav")) return "wav";
  if (file.type.includes("mpeg") || file.type.includes("mp3")) return "mp3";
  return "webm";
}

function profileDraftFile(file: File, index: number): File {
  const expectedStem = profileClipStem(index);
  if (file.name.toLowerCase().includes(expectedStem)) return file;
  return new File([file], `${expectedStem}.${fileExtensionFromFile(file)}`, {
    type: file.type || "audio/webm",
    lastModified: file.lastModified,
  });
}

function replaceProfileDraftClip(drafts: ProfileDraftClip[], draft: ProfileDraftClip): ProfileDraftClip[] {
  return [...drafts.filter((item) => item.index !== draft.index), draft].sort((a, b) => a.index - b.index);
}

function normalizedProfileDraftCaptureSettings(settings: MediaTrackSettings | ProfileDraftCaptureSettings | undefined): ProfileDraftCaptureSettings | undefined {
  if (!settings) return undefined;
  const normalized: ProfileDraftCaptureSettings = {};
  if (typeof settings.channelCount === "number" && Number.isFinite(settings.channelCount)) normalized.channelCount = settings.channelCount;
  if (typeof settings.sampleRate === "number" && Number.isFinite(settings.sampleRate)) normalized.sampleRate = settings.sampleRate;
  if (typeof settings.echoCancellation === "boolean") normalized.echoCancellation = settings.echoCancellation;
  if (typeof settings.noiseSuppression === "boolean") normalized.noiseSuppression = settings.noiseSuppression;
  if (typeof settings.autoGainControl === "boolean") normalized.autoGainControl = settings.autoGainControl;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function profileDraftCaptureUsesProcessing(settings?: ProfileDraftCaptureSettings): boolean {
  return settings?.echoCancellation === true || settings?.noiseSuppression === true || settings?.autoGainControl === true;
}

function profileDraftFromPersisted(draft: PersistedProfileDraft | null): ProfileDraftClip | null {
  if (
    !draft ||
    !Number.isInteger(draft.index) ||
    draft.index < 0 ||
    draft.index >= MAX_PROFILE_DRAFTS ||
    !(draft.file instanceof Blob) ||
    typeof draft.transcript !== "string"
  ) {
    return null;
  }
  const file =
    draft.file instanceof File
      ? draft.file
      : new File([draft.file], draft.name || `${profileClipStem(draft.index)}.webm`, {
          type: draft.type || draft.file.type || "audio/webm",
          lastModified: draft.lastModified || draft.savedAt || Date.now(),
        });
  return {
    index: draft.index,
    file: profileDraftFile(file, draft.index),
    transcript: draft.transcript,
    durationSec: typeof draft.durationSec === "number" && Number.isFinite(draft.durationSec) ? draft.durationSec : undefined,
    voiceActiveSec:
      typeof draft.voiceActiveSec === "number" && Number.isFinite(draft.voiceActiveSec) ? draft.voiceActiveSec : undefined,
    captureSettings: normalizedProfileDraftCaptureSettings(draft.captureSettings),
    savedAt: draft.savedAt,
  };
}

async function loadPersistedProfileDrafts(count: number): Promise<ProfileDraftClip[]> {
  const drafts = await Promise.all(
    Array.from({ length: count }, async (_, index) =>
      profileDraftFromPersisted(await loadPersistedRecord<PersistedProfileDraft>(profileDraftKey(index))),
    ),
  );
  return drafts.filter((draft): draft is ProfileDraftClip => Boolean(draft));
}

async function savePersistedProfileDraft(
  index: number,
  file: File,
  transcript: string,
  durationSec?: number,
  voiceActiveSec?: number,
  captureSettings?: ProfileDraftCaptureSettings,
): Promise<ProfileDraftClip> {
  const savedFile = profileDraftFile(file, index);
  const savedAt = Date.now();
  const normalizedDurationSec = typeof durationSec === "number" && Number.isFinite(durationSec) ? Math.max(0, durationSec) : undefined;
  const normalizedVoiceActiveSec =
    typeof voiceActiveSec === "number" && Number.isFinite(voiceActiveSec) ? Math.max(0, voiceActiveSec) : undefined;
  const normalizedCaptureSettings = normalizedProfileDraftCaptureSettings(captureSettings);
  await savePersistedRecord({
    key: profileDraftKey(index),
    index,
    file: savedFile,
    name: savedFile.name,
    type: savedFile.type,
    lastModified: savedFile.lastModified,
    transcript,
    durationSec: normalizedDurationSec,
    voiceActiveSec: normalizedVoiceActiveSec,
    captureSettings: normalizedCaptureSettings,
    savedAt,
  } satisfies PersistedProfileDraft);
  return {
    index,
    file: savedFile,
    transcript,
    durationSec: normalizedDurationSec,
    voiceActiveSec: normalizedVoiceActiveSec,
    captureSettings: normalizedCaptureSettings,
    savedAt,
  };
}

async function deletePersistedProfileDrafts(count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, index) => deletePersistedRecord(profileDraftKey(index))));
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

function historyStatusLabel(status: RunHistoryItem["status"], t: typeof copy[Locale]): string {
  if (status === "ready") return t.historyStatusReady;
  if (status === "needs_worker") return t.historyStatusWorker;
  return t.historyStatusError;
}

function sourceKindLabel(kind: SourceKind | undefined, t: typeof copy[Locale]): string {
  if (kind === "sample") return t.sourceSample;
  if (kind === "scripted") return t.sourceScripted;
  if (kind === "freeform") return t.sourceFreeform;
  if (kind === "uploaded") return t.sourceUploaded;
  if (kind === "profile") return t.sourceProfile;
  return t.sectionVoice;
}

function serializePronunciationOverrides(overrides: PronunciationOverride[] | undefined): string {
  return overrides?.map(serializePronunciationOverride).join("\n") ?? "";
}

function suggestionReasonLabel(reason: PronunciationSuggestion["reason"], t: typeof copy[Locale]): string {
  if (reason === "polyphone") return t.pronunciationSuggestionPolyphone;
  return t.pronunciationSuggestionBrand;
}

function profileIssueLabel(reason: string, locale: Locale): string {
  const zh: Record<string, string> = {
    too_short: "錄音太短",
    short_clip: "錄音太短",
    too_long: "錄音太長",
    long_clip: "錄音太長",
    low_snr: "背景噪音高",
    clipping_detected: "音量破音",
    low_voice_activity: "人聲比例低",
    very_quiet: "音量太小",
    duplicate_transcript: "逐字稿重複",
    missing_coverage_zh_hant: "缺少繁中片段",
    missing_coverage_numbers_dates: "缺少數字/日期片段",
    missing_coverage_latin_terms: "缺少英文詞片段",
    missing_coverage_polyphones: "缺少多音詞片段",
    missing_coverage_punctuation_rhythm: "缺少標點節奏片段",
  };
  const en: Record<string, string> = {
    too_short: "Too short",
    short_clip: "Too short",
    too_long: "Too long",
    long_clip: "Too long",
    low_snr: "Noisy background",
    clipping_detected: "Clipping",
    low_voice_activity: "Low voice activity",
    very_quiet: "Too quiet",
    duplicate_transcript: "Duplicate transcript",
    missing_coverage_zh_hant: "Missing zh-Hant clip",
    missing_coverage_numbers_dates: "Missing numbers/dates clip",
    missing_coverage_latin_terms: "Missing English terms clip",
    missing_coverage_polyphones: "Missing polyphone clip",
    missing_coverage_punctuation_rhythm: "Missing punctuation/rhythm clip",
  };
  if (reason.startsWith("grade_")) {
    const grade = reason.slice("grade_".length).toUpperCase();
    return locale === "zh-Hant" ? `品質 ${grade}` : `Grade ${grade}`;
  }
  const labels = locale === "zh-Hant" ? zh : en;
  return labels[reason] ?? reason.replace(/_/g, " ");
}

function profileCoverageLabel(feature: VoiceProfileCoverageFeature, locale: Locale): string {
  const zh: Record<VoiceProfileCoverageFeature, string> = {
    zh_hant: "繁體中文",
    numbers_dates: "數字 / 日期",
    latin_terms: "英文詞",
    polyphones: "多音字",
    punctuation_rhythm: "停頓節奏",
  };
  const en: Record<VoiceProfileCoverageFeature, string> = {
    zh_hant: "Traditional Chinese",
    numbers_dates: "numbers / dates",
    latin_terms: "English terms",
    polyphones: "polyphones",
    punctuation_rhythm: "punctuation rhythm",
  };
  return (locale === "zh-Hant" ? zh : en)[feature];
}

function profileCoverageList(features: string[], locale: Locale): string {
  const separator = locale === "zh-Hant" ? "、" : ", ";
  return features
    .map((feature) =>
      PROFILE_COVERAGE_FEATURES.includes(feature as VoiceProfileCoverageFeature)
        ? profileCoverageLabel(feature as VoiceProfileCoverageFeature, locale)
        : feature,
    )
    .join(separator);
}

function profileProofArtifactLabel(id: string, locale: Locale): string {
  const zh: Record<string, string> = {
    recording_kit_manifest: "錄音資料夾",
    profile_json: "聲音檔案",
    transcript_validation_json: "逐字稿驗證",
    quality_gate_json: "Quality gate",
  };
  const en: Record<string, string> = {
    recording_kit_manifest: "Recording kit",
    profile_json: "Voice profile",
    transcript_validation_json: "Transcript validation",
    quality_gate_json: "Quality gate",
  };
  return (locale === "zh-Hant" ? zh : en)[id] ?? id.replace(/_/g, " ");
}

function profileProofGateLabel(id: string, locale: Locale): string {
  const zh: Record<string, string> = {
    recording_kit_check: "檢查錄音資料夾",
    enroll_profile_kit: "匯入聲音檔案",
    verify_profile_strict: "嚴格聲音檢查",
    run_quality_gate: "Quality gate",
    run_product_proof_quality_gate: "10x proof gate",
  };
  const en: Record<string, string> = {
    recording_kit_check: "Check recording kit",
    enroll_profile_kit: "Enroll voice profile",
    verify_profile_strict: "Strict profile check",
    run_quality_gate: "Quality gate",
    run_product_proof_quality_gate: "10x proof gate",
  };
  return (locale === "zh-Hant" ? zh : en)[id] ?? id.replace(/_/g, " ");
}

function profileProofBlockLabel(blocks: string, locale: Locale): string {
  const zh: Record<string, string> = {
    enrollment: "匯入前",
    strict_profile_verification: "嚴格檢查前",
    quality_gate: "Quality gate 前",
    lora_dataset_export: "LoRA 匯出前",
    product_10x_claim: "10x 宣稱前",
  };
  const en: Record<string, string> = {
    enrollment: "before enrollment",
    strict_profile_verification: "before strict check",
    quality_gate: "before quality gate",
    lora_dataset_export: "before LoRA export",
    product_10x_claim: "before 10x claim",
  };
  return (locale === "zh-Hant" ? zh : en)[blocks] ?? blocks.replace(/_/g, " ");
}

function profileProofStatusLabel(status: string, locale: Locale): string {
  const zh: Record<string, string> = {
    present: "已存在",
    missing: "缺少",
    planned: "待產生",
  };
  const en: Record<string, string> = {
    present: "Present",
    missing: "Missing",
    planned: "Planned",
  };
  return (locale === "zh-Hant" ? zh : en)[status] ?? status.replace(/_/g, " ");
}

function auditBackendString(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function auditBackendAvailable(payload: Record<string, unknown> | undefined): boolean {
  return payload?.available === true || payload?.status === "ready";
}

function profileProofStatusClass(status: string): string {
  return ["present", "missing", "planned"].includes(status) ? status : "unknown";
}

function profileRejectedReasonLabels(reasons: string[], locale: Locale): string {
  const labels = new Set<string>();
  for (const reason of reasons) {
    if (reason.startsWith("grade_")) continue;
    labels.add(profileIssueLabel(reason, locale));
  }
  return [...labels].join(" / ");
}

function profileQualityRejectionReason(
  quality: ReferenceQuality,
  requirements: VoiceProfilePayload["requirements"] | undefined,
  locale: Locale,
): string | null {
  const passingGrades = new Set(requirements?.passingGrades ?? ["A", "B"]);
  if (!passingGrades.has(quality.grade)) return profileIssueLabel(`grade_${quality.grade.toLowerCase()}`, locale);
  if (requirements && quality.durationSec < requirements.minDurationSec) return profileIssueLabel("too_short", locale);
  if (requirements && quality.durationSec > requirements.maxDurationSec) return profileIssueLabel("too_long", locale);
  const blockingWarning = quality.warnings.find((warning) =>
    ["short_clip", "long_clip", "low_snr", "clipping_detected", "low_voice_activity", "very_quiet"].includes(warning),
  );
  return blockingWarning ? profileIssueLabel(blockingWarning, locale) : null;
}

function scriptLabel(script: string, locale: Locale): string {
  const zh: Record<string, string> = {
    zh_hant: "繁中",
    zh_hans: "簡中",
    mixed_zh: "混用",
    zh_unknown: "中文",
    non_zh: "非中文",
  };
  const en: Record<string, string> = {
    zh_hant: "zh-Hant",
    zh_hans: "zh-Hans",
    mixed_zh: "Mixed zh",
    zh_unknown: "Chinese",
    non_zh: "Non-Chinese",
  };
  return (locale === "zh-Hant" ? zh : en)[script] ?? script;
}

function formatRunTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-TW" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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
  const [locale, setLocale] = useState<Locale>("zh-Hant");
  const [theme, setTheme] = useState<Theme>("system");
  const t = copy[locale];

  const [mode, setMode] = useState<Mode>("scripted");
  const [scriptIndex, setScriptIndex] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const [wavePeaks, setWavePeaks] = useState<number[]>([]);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [userTargetText, setUserTargetText] = useState<string | null>(null);
  const [pronunciationOverridesText, setPronunciationOverridesText] = useState("");
  const [freeformTranscript, setFreeformTranscript] = useState("");
  const [sourceTranscript, setSourceTranscript] = useState("");
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("balanced");
  const [consent, setConsent] = useState(true);
  const [audioUrl, setAudioUrl] = useState("");
  const [message, setMessage] = useState("");
  const [recordingSupported, setRecordingSupported] = useState(true);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingEnrollAfterStop, setRecordingEnrollAfterStop] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [recordingVoiceActiveElapsed, setRecordingVoiceActiveElapsed] = useState(0);
  const [voiceActiveTrackingAvailable, setVoiceActiveTrackingAvailable] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [streamEvents, setStreamEvents] = useState<CloneProgressPayload[]>([]);
  const [historyItems, setHistoryItems] = useState<RunHistoryItem[]>([]);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "loading" | "error">("idle");
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfilePayload | null>(null);
  const [profileStatus, setProfileStatus] = useState<"idle" | "loading" | "error">("idle");
  const [useVoiceProfile, setUseVoiceProfile] = useState(false);
  const [enrollStatus, setEnrollStatus] = useState<"idle" | "loading" | "error">("idle");
  const [enrollMessage, setEnrollMessage] = useState("");
  const [enrolledReferenceKey, setEnrolledReferenceKey] = useState("");
  const [referenceSavedLocal, setReferenceSavedLocal] = useState(false);
  const [recordingKit, setRecordingKit] = useState<RecordingKitPayload | null>(null);
  const [recordingKitStatus, setRecordingKitStatus] = useState<"idle" | "loading" | "error">("idle");
  const [recordingKitPreflight, setRecordingKitPreflight] = useState<RecordingKitPreflightPayload | null>(null);
  const [recordingKitPreflightStatus, setRecordingKitPreflightStatus] = useState<"idle" | "loading" | "error">("idle");
  const [recordingKitSmokeTest, setRecordingKitSmokeTest] = useState<RecordingKitPreflightPayload | null>(null);
  const [recordingKitSmokeTestStatus, setRecordingKitSmokeTestStatus] = useState<"idle" | "loading" | "error">("idle");
  const [recordingKitNormalization, setRecordingKitNormalization] = useState<RecordingKitNormalizePayload | null>(null);
  const [recordingKitNormalizeStatus, setRecordingKitNormalizeStatus] = useState<"idle" | "loading" | "error">("idle");
  const [recordingKitCheck, setRecordingKitCheck] = useState<RecordingKitCheckPayload | null>(null);
  const [recordingKitCheckStatus, setRecordingKitCheckStatus] = useState<"idle" | "loading" | "error">("idle");
  const [profileReanalysis, setProfileReanalysis] = useState<VoiceProfileReanalysisPayload | null>(null);
  const [profileReanalysisStatus, setProfileReanalysisStatus] = useState<"idle" | "loading" | "error">("idle");
  const [profileVerification, setProfileVerification] = useState<VoiceProfileVerificationPayload | null>(null);
  const [profileVerifyStatus, setProfileVerifyStatus] = useState<"idle" | "loading" | "error">("idle");
  const [goalAudit, setGoalAudit] = useState<VoiceCloneGoalAuditPayload | null>(null);
  const [goalAuditStatus, setGoalAuditStatus] = useState<"idle" | "loading" | "error">("idle");
  const [profileTranscriptValidation, setProfileTranscriptValidation] = useState<VoiceProfileTranscriptValidationPayload | null>(null);
  const [profileTranscriptStatus, setProfileTranscriptStatus] = useState<"idle" | "loading" | "error">("idle");
  const [profileDraftClips, setProfileDraftClips] = useState<ProfileDraftClip[]>([]);
  const [profileBulkStatus, setProfileBulkStatus] = useState<"idle" | "loading" | "error">("idle");
  const [profileBulkMessage, setProfileBulkMessage] = useState("");
  const [profileBrowserMicCheckStatus, setProfileBrowserMicCheckStatus] = useState<"idle" | "loading">("idle");
  const [profileBrowserSessionActive, setProfileBrowserSessionActive] = useState(false);
  const [profileBrowserSessionCountdown, setProfileBrowserSessionCountdown] = useState<number | null>(null);

  const [referenceQuality, setReferenceQuality] = useState<ReferenceQuality | null>(null);
  const [lastResponse, setLastResponse] = useState<ClonePayload | null>(null);

  const targetText = userTargetText ?? DEFAULT_TARGET_TEXT[locale];
  const scripts = SCRIPT_PACK[locale];
  const currentScript = scripts[scriptIndex] ?? scripts[0];
  const profileBulkClipSpecs = useMemo(() => recordingKitBulkClipSpecs(recordingKit), [recordingKit]);
  const profileRecordingScripts = useMemo(() => profileBulkClipSpecs.map((spec) => spec.transcript), [profileBulkClipSpecs]);
  const profileBulkExpectedCount = profileBulkClipSpecs.length;
  const profileBulkFirstStem = profileBulkClipSpecs[0]?.expectedStem || profileClipStem(0);
  const profileBulkLastStem = profileBulkClipSpecs.at(-1)?.expectedStem || profileClipStem(profileBulkExpectedCount - 1);
  const profileBulkUploadLabel = t.profileBulkUpload(profileBulkExpectedCount);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sourcePreviewUrlRef = useRef("");
  const sourceAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingDeadlineRef = useRef<number | null>(null);
  const voiceActiveMsRef = useRef(0);
  const lastVoiceMeterAtRef = useRef<number | null>(null);
  const voiceActiveTrackingAvailableRef = useRef(false);
  const captureSettingsRef = useRef<ProfileDraftCaptureSettings | undefined>(undefined);
  const recordingKindRef = useRef<"scripted" | "freeform">("scripted");
  const recordingEnrollAfterStopRef = useRef(false);
  const profileDraftClipsRef = useRef<ProfileDraftClip[]>([]);
  const profileBrowserSessionActiveRef = useRef(false);
  const profileBrowserSessionTimeoutRef = useRef<number | null>(null);
  const profileBrowserSessionIntervalRef = useRef<number | null>(null);
  const restoreAttemptedRef = useRef(false);
  const profileDraftRestoreCountRef = useRef(0);
  const profileAutoSelectedRef = useRef(false);
  const referenceSaveTokenRef = useRef(0);

  const loadHistory = useCallback(async () => {
    setHistoryStatus("loading");
    try {
      const response = await fetch("/api/runs?limit=12", { cache: "no-store" });
      if (!response.ok) throw new Error(`history request failed: ${response.status}`);
      const payload = (await response.json()) as { items?: RunHistoryItem[] };
      setHistoryItems(Array.isArray(payload.items) ? payload.items : []);
      setHistoryStatus("idle");
    } catch {
      setHistoryStatus("error");
    }
  }, []);

  const loadVoiceProfile = useCallback(async () => {
    setProfileStatus("loading");
    try {
      const response = await fetch("/api/voice-profile", { cache: "no-store" });
      if (!response.ok) throw new Error(`profile request failed: ${response.status}`);
      const payload = (await response.json()) as { profile?: VoiceProfilePayload };
      setVoiceProfile(payload.profile ?? null);
      setProfileVerification(null);
      setProfileVerifyStatus("idle");
      setProfileTranscriptValidation(null);
      setProfileTranscriptStatus("idle");
      setProfileStatus("idle");
    } catch {
      setProfileStatus("error");
    }
  }, []);

  const loadCurrentRecordingKit = useCallback(async () => {
    try {
      const response = await fetch("/api/voice-profile/recording-kit?profileId=local-default", { cache: "no-store" });
      if (!response.ok) throw new Error(`recording kit request failed: ${response.status}`);
      const payload = (await response.json()) as { kit?: RecordingKitPayload | null };
      if (payload.kit) {
        setRecordingKit(payload.kit);
      }
    } catch {
      // A missing current kit should not block the studio. The create buttons remain available.
    }
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => {
      void loadHistory();
      void loadVoiceProfile();
      void loadCurrentRecordingKit();
    });
  }, [loadCurrentRecordingKit, loadHistory, loadVoiceProfile]);

  useEffect(() => {
    window.queueMicrotask(() => {
      const strictProfileReady = voiceProfile?.status === "ready" && profileVerification?.status === "ready";
      if (strictProfileReady) {
        if (!profileAutoSelectedRef.current) {
          setUseVoiceProfile(true);
          profileAutoSelectedRef.current = true;
        }
        return;
      }
      setUseVoiceProfile(false);
    });
  }, [profileVerification?.status, voiceProfile?.status]);

  /* ---------- Theme & locale ---------- */
  useEffect(() => {
    const savedLocale = window.localStorage.getItem("anyvoice:locale");
    const savedTheme = window.localStorage.getItem("anyvoice:theme");
    window.queueMicrotask(() => {
      if (savedLocale === "en" || savedLocale === "zh-Hant") {
        setLocale(savedLocale);
      }
      if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
        setTheme(savedTheme);
      }
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem("anyvoice:locale", locale);
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  useEffect(() => {
    if (scriptIndex >= SCRIPT_PACK[locale].length) {
      window.queueMicrotask(() => setScriptIndex(0));
    }
  }, [locale, scriptIndex]);

  useEffect(() => {
    window.localStorage.setItem("anyvoice:theme", theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    profileDraftClipsRef.current = profileDraftClips;
  }, [profileDraftClips]);

  useEffect(() => {
    profileBrowserSessionActiveRef.current = profileBrowserSessionActive;
  }, [profileBrowserSessionActive]);

  /* ---------- Cleanup ---------- */
  useEffect(() => {
    return () => {
      if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      if (profileBrowserSessionTimeoutRef.current) window.clearTimeout(profileBrowserSessionTimeoutRef.current);
      if (profileBrowserSessionIntervalRef.current) window.clearInterval(profileBrowserSessionIntervalRef.current);
      if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current);
      void audioContextRef.current?.close();
    };
  }, []);

  const adoptVoiceFile = useCallback(async (
    file: File,
    kind: SourceKind,
    options: { mode?: Mode; persist?: boolean; transcript?: string } = {},
  ) => {
    const nextMode = options.mode ?? modeForSourceKind(kind);
    const nextTranscript = options.transcript ?? transcriptForSourceKind(kind, locale, freeformTranscript);
    const saveToken = referenceSaveTokenRef.current + 1;
    referenceSaveTokenRef.current = saveToken;
    if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    sourcePreviewUrlRef.current = previewUrl;
    setMode(nextMode);
    setVoiceFile(file);
    setSourceKind(kind);
    setUseVoiceProfile(false);
    setSourceTranscript(nextTranscript);
    if (kind === "freeform" || kind === "uploaded") {
      setFreeformTranscript(nextTranscript);
    }
    setSourcePreviewUrl(previewUrl);
    setPlaybackProgress(0);
    setSourceDuration(null);
    setAudioUrl("");
    setStatus("idle");
    setMessage("");
    setEnrollStatus("idle");
    setEnrollMessage("");
    setEnrolledReferenceKey("");
    setStreamEvents([]);
    setWavePeaks([]);
    setReferenceQuality(null);
    setLastResponse(null);
    setReferenceSavedLocal(false);
    try {
      const peaks = await extractWaveformPeaks(file, SONOGRAM_BARS);
      setWavePeaks(peaks);
    } catch {
      /* waveform extraction is best-effort */
    }

    if (options.persist === false) {
      if (kind !== "sample") setReferenceSavedLocal(true);
      return;
    }

    if (kind !== "sample") {
      void savePersistedReference({
        file,
        kind,
        mode: nextMode,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        transcript: nextTranscript,
      })
        .then(() => {
          if (referenceSaveTokenRef.current === saveToken) setReferenceSavedLocal(true);
        })
        .catch(() => {
          if (referenceSaveTokenRef.current === saveToken) setReferenceSavedLocal(false);
        });
    }
  }, [freeformTranscript, locale]);

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const persisted = await loadPersistedReference();
        if (cancelled || !persisted) return;
        const file = fileFromPersistedReference(persisted);
        if (!file) return;
        await adoptVoiceFile(file, persisted.kind, {
          mode: persisted.mode,
          persist: false,
          transcript: persisted.transcript,
        });
      } catch {
        /* persisted reference restore is best-effort */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adoptVoiceFile]);

  useEffect(() => {
    if (profileDraftRestoreCountRef.current >= profileBulkExpectedCount) return;
    profileDraftRestoreCountRef.current = profileBulkExpectedCount;

    let cancelled = false;
    void (async () => {
      try {
        const drafts = await loadPersistedProfileDrafts(profileBulkExpectedCount);
        if (!cancelled) {
          profileDraftClipsRef.current = drafts;
          setProfileDraftClips(drafts);
        }
      } catch {
        /* persisted profile draft restore is best-effort */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileBulkExpectedCount]);

  useEffect(() => {
    if (!voiceFile || !sourceKind || (sourceKind !== "freeform" && sourceKind !== "uploaded")) return;
    const transcript = freeformTranscript.trim();
    const saveToken = referenceSaveTokenRef.current + 1;
    referenceSaveTokenRef.current = saveToken;

    const timer = window.setTimeout(() => {
      void savePersistedReference({
        file: voiceFile,
        kind: sourceKind,
        mode: "freeform",
        name: voiceFile.name,
        type: voiceFile.type,
        lastModified: voiceFile.lastModified,
        transcript,
      })
        .then(() => {
          if (referenceSaveTokenRef.current === saveToken) setReferenceSavedLocal(true);
        })
        .catch(() => {
          if (referenceSaveTokenRef.current === saveToken) setReferenceSavedLocal(false);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [freeformTranscript, sourceKind, voiceFile]);

  async function loadSampleVoice() {
    try {
      const sample = await fetchSampleVoiceFile();
      await adoptVoiceFile(sample, "sample", { mode: "scripted", transcript: SAMPLE_VOICE_TRANSCRIPT });
    } catch {
      setStatus("error");
      setMessage(t.noAudio);
    }
  }

  function clearProfileBrowserSessionQueue() {
    if (profileBrowserSessionTimeoutRef.current) {
      window.clearTimeout(profileBrowserSessionTimeoutRef.current);
      profileBrowserSessionTimeoutRef.current = null;
    }
    if (profileBrowserSessionIntervalRef.current) {
      window.clearInterval(profileBrowserSessionIntervalRef.current);
      profileBrowserSessionIntervalRef.current = null;
    }
    setProfileBrowserSessionCountdown(null);
  }

  function stopProfileBrowserSession() {
    profileBrowserSessionActiveRef.current = false;
    setProfileBrowserSessionActive(false);
    clearProfileBrowserSessionQueue();
  }

  function profileRecordingFromDrafts(drafts: ProfileDraftClip[]) {
    return selectNextProfileRecordingScript({
      scripts: profileRecordingScripts,
      missingCoverageFeatures: profileMissingCoverage,
      eligibleClips: profileSummary?.eligibleClips ?? 0,
      draftIndices: drafts.map((draft) => draft.index),
    });
  }

  function recordProfileScript(index: number, text: string) {
    clearProfileBrowserSessionQueue();
    setMode("scripted");
    if (scripts.length > 0) setScriptIndex(index % scripts.length);
    void startRecording("scripted", {
      scriptedTranscript: text,
      enrollAfterStop: true,
      profileIndex: index,
    });
  }

  function queueNextProfileBrowserSessionRecording(drafts: ProfileDraftClip[]) {
    if (!profileBrowserSessionActiveRef.current) return;
    const next = profileRecordingFromDrafts(drafts);
    if (!next) {
      setProfileBulkMessage(t.profileSessionComplete);
      stopProfileBrowserSession();
      void importAllProfileDrafts(drafts);
      return;
    }

    if (scripts.length > 0) setScriptIndex(next.index % scripts.length);
    setMode("scripted");
    setProfileBrowserSessionCountdown(PROFILE_BROWSER_SESSION_COUNTDOWN_SECONDS);

    let remaining = PROFILE_BROWSER_SESSION_COUNTDOWN_SECONDS;
    profileBrowserSessionIntervalRef.current = window.setInterval(() => {
      remaining -= 1;
      setProfileBrowserSessionCountdown(Math.max(0, remaining));
      if (remaining <= 0 && profileBrowserSessionIntervalRef.current) {
        window.clearInterval(profileBrowserSessionIntervalRef.current);
        profileBrowserSessionIntervalRef.current = null;
      }
    }, 1000);

    profileBrowserSessionTimeoutRef.current = window.setTimeout(() => {
      clearProfileBrowserSessionQueue();
      if (!profileBrowserSessionActiveRef.current || mediaRecorderRef.current) return;
      recordProfileScript(next.index, next.text);
    }, PROFILE_BROWSER_SESSION_COUNTDOWN_SECONDS * 1000);
  }

  function startProfileBrowserSession() {
    if (!profileNextRecording) return;
    profileBrowserSessionActiveRef.current = true;
    setProfileBrowserSessionActive(true);
    recordProfileScript(profileNextRecording.index, profileNextRecording.text);
  }

  async function checkProfileBrowserMic() {
    if (mediaRecorderRef.current || profileBrowserMicCheckStatus === "loading") return;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      setProfileBulkStatus("error");
      setProfileBulkMessage(t.recordingUnavailable);
      return;
    }

    setProfileBrowserMicCheckStatus("loading");
    setProfileBulkStatus("loading");
    setProfileBulkMessage(t.profileBrowserMicChecking);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
      const settings = normalizedProfileDraftCaptureSettings(stream.getAudioTracks?.()[0]?.getSettings());
      const status = captureStatusFromSettings(settings ?? {});
      setCaptureStatus(status);
      if (profileDraftCaptureUsesProcessing(settings)) {
        setProfileBulkStatus("error");
        setProfileBulkMessage(t.profileCaptureProcessingBlocked(captureProcessingLabel(settings)));
        return;
      }
      setProfileBulkStatus("idle");
      setProfileBulkMessage(status.text);
    } catch (error) {
      setProfileBulkStatus("error");
      if (error instanceof DOMException && error.name === "NotFoundError") {
        setProfileBulkMessage(t.micMissing);
      } else if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)) {
        setProfileBulkMessage(t.micPermissionDenied);
      } else {
        setProfileBulkMessage(t.recorderStartFailed);
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setProfileBrowserMicCheckStatus("idle");
    }
  }

  async function saveProfileDraft(
    index: number,
    file: File,
    transcript: string,
    durationSec?: number,
    voiceActiveSec?: number,
    captureSettings?: ProfileDraftCaptureSettings,
  ) {
    const draft = await savePersistedProfileDraft(index, file, transcript, durationSec, voiceActiveSec, captureSettings);
    const nextDrafts = replaceProfileDraftClip(profileDraftClipsRef.current, draft);
    profileDraftClipsRef.current = nextDrafts;
    setProfileDraftClips(nextDrafts);
    const nextRecording = profileRecordingFromDrafts(nextDrafts);
    if (nextRecording && scripts.length > 0) setScriptIndex(nextRecording.index % scripts.length);
    return nextDrafts;
  }

  async function clearProfileDrafts() {
    await deletePersistedProfileDrafts(MAX_PROFILE_DRAFTS).catch(() => {});
    profileDraftClipsRef.current = [];
    setProfileDraftClips([]);
  }

  function resetVoiceActiveTracking() {
    voiceActiveMsRef.current = 0;
    lastVoiceMeterAtRef.current = null;
    voiceActiveTrackingAvailableRef.current = false;
    setRecordingVoiceActiveElapsed(0);
    setVoiceActiveTrackingAvailable(false);
  }

  function stopRecordingTimer() {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  function profileRecordingGatePassed(elapsedSec: number) {
    if (elapsedSec < profileRecommendedRecordingDuration) return false;
    return !voiceActiveTrackingAvailableRef.current || voiceActiveMsRef.current / 1000 >= profileMinVoiceActiveDuration;
  }

  function startRecordingTimer() {
    stopRecordingTimer();
    const startedAt = window.performance.now();
    recordingStartedAtRef.current = startedAt;
    recordingDeadlineRef.current = startedAt + MAX_RECORDING_SECONDS * 1000;
    setRecordingElapsed(0);
    recordingTimerRef.current = window.setInterval(() => {
      const elapsed = (window.performance.now() - startedAt) / 1000;
      setRecordingElapsed(elapsed);
      if (
        profileBrowserSessionActiveRef.current &&
        recordingEnrollAfterStopRef.current &&
        profileRecordingGatePassed(elapsed)
      ) {
        stopRecording({ force: true });
        return;
      }
      if (elapsed >= MAX_RECORDING_SECONDS) {
        stopRecording({ force: true });
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
    if (!AudioContextConstructor) {
      voiceActiveTrackingAvailableRef.current = false;
      setVoiceActiveTrackingAvailable(false);
      return;
    }

    const audioContext = new AudioContextConstructor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    voiceActiveTrackingAvailableRef.current = true;
    setVoiceActiveTrackingAvailable(true);
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
        const nextInputLevel = Math.min(1, Math.sqrt(sum / samples.length) * 3.4);
        const lastMeterAt = lastVoiceMeterAtRef.current;
        if (lastMeterAt !== null && nextInputLevel >= PROFILE_VOICE_ACTIVE_LEVEL) {
          voiceActiveMsRef.current += Math.max(0, Math.min(timestamp - lastMeterAt, 250));
          setRecordingVoiceActiveElapsed(voiceActiveMsRef.current / 1000);
        }
        lastVoiceMeterAtRef.current = timestamp;
        setInputLevel(nextInputLevel);
        lastPaint = timestamp;
      }
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }

  function captureStatusFromSettings(settings: MediaTrackSettings | ProfileDraftCaptureSettings): CaptureStatus {
    const channelCount =
      typeof settings.channelCount === "number" && Number.isFinite(settings.channelCount)
        ? String(settings.channelCount)
        : t.captureUnknownValue;
    const sampleRate =
      typeof settings.sampleRate === "number" && Number.isFinite(settings.sampleRate)
        ? `${settings.sampleRate} Hz`
        : t.captureUnknownValue;
    const details = t.captureSettingsDetails(channelCount, sampleRate);
    const processing = [
      settings.echoCancellation === true ? t.captureEchoCancellation : "",
      settings.noiseSuppression === true ? t.captureNoiseSuppression : "",
      settings.autoGainControl === true ? t.captureAutoGainControl : "",
    ].filter(Boolean);
    if (processing.length > 0) {
      return { tone: "warn", text: t.captureSettingsWarning(details, processing.join(" / ")) };
    }
    if (
      settings.echoCancellation !== false ||
      settings.noiseSuppression !== false ||
      settings.autoGainControl !== false
    ) {
      return { tone: "info", text: t.captureSettingsUnknown(details) };
    }
    return { tone: "ready", text: t.captureSettingsClean(details) };
  }

  function captureProcessingLabel(settings?: MediaTrackSettings | ProfileDraftCaptureSettings): string {
    return [
      settings?.echoCancellation === true ? t.captureEchoCancellation : "",
      settings?.noiseSuppression === true ? t.captureNoiseSuppression : "",
      settings?.autoGainControl === true ? t.captureAutoGainControl : "",
    ]
      .filter(Boolean)
      .join(" / ");
  }

  function cleanupRecordingSession() {
    stopRecordingTimer();
    stopInputMeter();
    recordingStartedAtRef.current = null;
    resetVoiceActiveTracking();
    captureSettingsRef.current = undefined;
    recordingEnrollAfterStopRef.current = false;
    setRecordingEnrollAfterStop(false);
  }

  async function startRecording(
    kind: "scripted" | "freeform",
    options: { scriptedTranscript?: string; enrollAfterStop?: boolean; profileIndex?: number } = {},
  ) {
    clearProfileBrowserSessionQueue();
    cleanupRecordingSession();
    setMessage("");
    setAudioUrl("");
    setCaptureStatus(null);
    captureSettingsRef.current = undefined;
    recordingKindRef.current = kind;
    const shouldEnrollAfterStop = Boolean(options.enrollAfterStop && kind === "scripted");
    recordingEnrollAfterStopRef.current = shouldEnrollAfterStop;
    setRecordingEnrollAfterStop(shouldEnrollAfterStop);
    const scriptedTranscript = options.scriptedTranscript ?? currentScript;

    if (options.enrollAfterStop && !consent) {
      stopProfileBrowserSession();
      setEnrollStatus("error");
      setEnrollMessage(t.noConsent);
      return;
    }

    if (typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      stopProfileBrowserSession();
      setRecordingSupported(false);
      setStatus("error");
      setMessage(t.recordingUnavailable);
      return;
    }

    setStatus("requesting_mic");

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_MEDIA_CONSTRAINTS);
      const audioTrack = stream.getAudioTracks?.()[0];
      if (audioTrack) {
        const settings = normalizedProfileDraftCaptureSettings(audioTrack.getSettings());
        captureSettingsRef.current = settings;
        if (settings) setCaptureStatus(captureStatusFromSettings(settings));
        if (shouldEnrollAfterStop && profileDraftCaptureUsesProcessing(settings)) {
          const blockMessage = t.profileCaptureProcessingBlocked(captureProcessingLabel(settings));
          stream.getTracks().forEach((track) => track.stop());
          cleanupRecordingSession();
          stopProfileBrowserSession();
          mediaRecorderRef.current = null;
          setStatus("error");
          setMessage(blockMessage);
          setEnrollStatus("error");
          setEnrollMessage(blockMessage);
          setProfileBulkStatus("error");
          setProfileBulkMessage(blockMessage);
          return;
        }
      }
      const recorder = new MediaRecorder(stream, supportedRecorderOptions());
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stream?.getTracks().forEach((track) => track.stop());
        cleanupRecordingSession();
        stopProfileBrowserSession();
        mediaRecorderRef.current = null;
        setStatus("error");
        setMessage(t.recorderStartFailed);
      };
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        const capturedDurationSec = recordingStartedAtRef.current
          ? Math.min(MAX_RECORDING_SECONDS, (window.performance.now() - recordingStartedAtRef.current) / 1000)
          : undefined;
        const capturedVoiceActiveSec = voiceActiveTrackingAvailableRef.current
          ? Math.min(MAX_RECORDING_SECONDS, voiceActiveMsRef.current / 1000)
          : undefined;
        const capturedCaptureSettings = captureSettingsRef.current;
        cleanupRecordingSession();
        mediaRecorderRef.current = null;
        if (chunksRef.current.length === 0) {
          stopProfileBrowserSession();
          setStatus("error");
          setMessage(t.recordingEmpty);
          return;
        }
        const file = createRecordedFile(chunksRef.current, recorder.mimeType, Date.now());
        const kind = recordingKindRef.current;
        let nextDrafts: ProfileDraftClip[] | null = null;
        await adoptVoiceFile(file, kind, {
          mode: modeForSourceKind(kind),
          transcript: kind === "scripted" ? scriptedTranscript : freeformTranscript.trim(),
        });
        const profileIndex = options.profileIndex;
        if (options.enrollAfterStop && kind === "scripted" && Number.isInteger(profileIndex)) {
          nextDrafts = await saveProfileDraft(
            profileIndex!,
            file,
            scriptedTranscript,
            capturedDurationSec,
            capturedVoiceActiveSec,
            capturedCaptureSettings,
          );
        }
        if (options.enrollAfterStop && kind === "scripted") {
          const enrolled = await enrollReferenceClip({
            file,
            kind,
            promptTranscript: scriptedTranscript,
            skipClientDurationGate: true,
          });
          if (enrolled && nextDrafts) {
            queueNextProfileBrowserSessionRecording(nextDrafts);
          } else if (!enrolled) {
            stopProfileBrowserSession();
          }
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      startInputMeter(stream);
      startRecordingTimer();
      setStatus("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      cleanupRecordingSession();
      stopProfileBrowserSession();
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

  function stopRecording({ force = false }: { force?: boolean } = {}) {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (!force && recordingEnrollAfterStopRef.current) {
      const elapsed = recordingStartedAtRef.current !== null
        ? Math.max(recordingElapsed, (window.performance.now() - recordingStartedAtRef.current) / 1000)
        : recordingElapsed;
      if (!profileRecordingGatePassed(elapsed)) return;
    }
    recorder.requestData();
    recorder.stop();
  }

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = event.target.files?.[0];
    if (file) {
      cleanupRecordingSession();
      setCaptureStatus(null);
      await adoptVoiceFile(file, "uploaded", { mode: "freeform", transcript: freeformTranscript.trim() });
      input.value = "";
    }
  }

  async function clearVoiceFile() {
    cleanupRecordingSession();
    setCaptureStatus(null);
    const shouldDeletePersistedReference = sourceKind !== "sample";
    referenceSaveTokenRef.current += 1;
    if (sourcePreviewUrlRef.current) URL.revokeObjectURL(sourcePreviewUrlRef.current);
    sourcePreviewUrlRef.current = "";
    setVoiceFile(null);
    setSourceKind(null);
    setSourceTranscript("");
    setSourcePreviewUrl("");
    setPlaybackProgress(0);
    setSourceDuration(null);
    setAudioUrl("");
    setStatus("idle");
    setMessage("");
    setEnrollStatus("idle");
    setEnrollMessage("");
    setEnrolledReferenceKey("");
    setStreamEvents([]);
    setWavePeaks([]);
    setReferenceQuality(null);
    setLastResponse(null);
    setReferenceSavedLocal(false);
    if (sourceKind === "freeform" || sourceKind === "uploaded") {
      setFreeformTranscript("");
    }
    if (shouldDeletePersistedReference) await deletePersistedReference().catch(() => {});
  }

  // Resolve the transcript that pairs with the current reference audio.
  function resolvePromptTranscript(): string {
    if (sourceKind === "scripted") return sourceTranscript || currentScript;
    if (sourceKind === "sample") return sourceTranscript || SAMPLE_VOICE_TRANSCRIPT;
    return freeformTranscript.trim();
  }

  function handleProgressPayload(payload: CloneProgressPayload) {
    setStreamEvents((current) => [...current, payload].slice(-8));
    if (payload.referenceQuality) setReferenceQuality(payload.referenceQuality);
  }

  function handleTerminalPayload(payload: ClonePayload, responseOk = true) {
    setLastResponse(payload);
    if (payload.referenceQuality) setReferenceQuality(payload.referenceQuality);
    void loadHistory();
    void loadVoiceProfile();

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

  function activateHistoryItem(item: RunHistoryItem) {
    setUserTargetText(item.targetText);
    setPronunciationOverridesText(serializePronunciationOverrides(item.pronunciationOverrides));
    setQualityPreset(item.quality);
    setStreamEvents([]);
    setReferenceQuality(item.referenceQuality ?? null);
    setLastResponse({
      status: item.status,
      jobId: item.id,
      audioUrl: item.audioUrl,
      message: item.message,
      referenceQuality: item.referenceQuality,
      targetLanguage: item.targetLanguage,
      effectiveParams: item.effectiveParams,
    });

    if (item.status === "ready") {
      setStatus("ready");
      setAudioUrl(item.audioUrl || "");
      setMessage("");
      return;
    }
    if (item.status === "needs_worker") {
      setStatus("needs_worker");
      setAudioUrl("");
      setMessage(item.message || t.workerMissingBody);
      return;
    }
    setStatus("error");
    setAudioUrl("");
    setMessage(item.message || t.errorTitle);
  }

  async function deleteHistoryItem(id: string) {
    try {
      const response = await fetch(`/api/runs?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`delete failed: ${response.status}`);
      setHistoryItems((items) => items.filter((item) => item.id !== id));
    } catch {
      setHistoryStatus("error");
    }
  }

  function addPronunciationSuggestion(suggestion: PronunciationSuggestion) {
    setPronunciationOverridesText((current) => {
      const parsed = parsePronunciationOverrides(current);
      if (parsed.overrides.some((override) => override.term === suggestion.term)) return current;
      const line = `${suggestion.term}=${suggestion.replacement}`;
      return current.trim() ? `${current.trimEnd()}\n${line}` : line;
    });
  }

  async function createRecordingKit(promptSet: "standard" | "extended" = "standard") {
    setRecordingKitStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/recording-kit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default", promptSet }),
      });
      const payload = (await response.json()) as { kit?: RecordingKitPayload; message?: string };
      if (!response.ok || !payload.kit) {
        throw new Error(payload.message || t.profileKitFailed);
      }
      setRecordingKit(payload.kit);
      setRecordingKitPreflight(null);
      setRecordingKitPreflightStatus("idle");
      setRecordingKitSmokeTest(null);
      setRecordingKitSmokeTestStatus("idle");
      setRecordingKitNormalization(null);
      setRecordingKitNormalizeStatus("idle");
      setRecordingKitCheck(null);
      setRecordingKitCheckStatus("idle");
      setRecordingKitStatus("idle");
    } catch {
      setRecordingKitStatus("error");
    }
  }

  async function preflightRecordingKit() {
    if (!recordingKit) return;
    setRecordingKitPreflightStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/recording-kit/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default", manifest: recordingKit.manifest }),
      });
      const payload = (await response.json()) as { preflight?: RecordingKitPreflightPayload; message?: string };
      if (!response.ok || !payload.preflight) {
        throw new Error(payload.message || t.profileKitPreflightFailed);
      }
      setRecordingKitPreflight(payload.preflight);
      setRecordingKitPreflightStatus("idle");
    } catch {
      setRecordingKitPreflightStatus("error");
    }
  }

  async function smokeTestRecordingKit() {
    if (!recordingKit) return;
    setRecordingKitSmokeTestStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/recording-kit/microphone-smoke-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default", manifest: recordingKit.manifest }),
      });
      const payload = (await response.json()) as { preflight?: RecordingKitPreflightPayload; message?: string };
      if (!response.ok || !payload.preflight) {
        throw new Error(payload.message || t.profileKitMicSmokeFailed);
      }
      setRecordingKitSmokeTest(payload.preflight);
      setRecordingKitPreflight(payload.preflight);
      setRecordingKitSmokeTestStatus("idle");
    } catch {
      setRecordingKitSmokeTestStatus("error");
    }
  }

  async function normalizeRecordingKitAudio() {
    if (!recordingKit) return;
    setRecordingKitNormalizeStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/recording-kit/normalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default", manifest: recordingKit.manifest }),
      });
      const payload = (await response.json()) as { normalization?: RecordingKitNormalizePayload; message?: string };
      if (!response.ok || !payload.normalization) {
        throw new Error(payload.message || t.profileKitNormalizeFailed);
      }
      setRecordingKitNormalization(payload.normalization);
      if (payload.normalization.checkReport) {
        setRecordingKitCheck(payload.normalization.checkReport);
      }
      setRecordingKitNormalizeStatus("idle");
    } catch {
      setRecordingKitNormalizeStatus("error");
    }
  }

  async function checkRecordingKit() {
    if (!recordingKit) return;
    setRecordingKitCheckStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/recording-kit/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default", manifest: recordingKit.manifest }),
      });
      const payload = (await response.json()) as { check?: RecordingKitCheckPayload; message?: string };
      if (!response.ok || !payload.check) {
        throw new Error(payload.message || t.profileKitCheckFailed);
      }
      setRecordingKitCheck(payload.check);
      setRecordingKitCheckStatus("idle");
    } catch {
      setRecordingKitCheckStatus("error");
    }
  }

  async function reanalyzeExistingProfileRuns() {
    setProfileReanalysisStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/reanalyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default" }),
      });
      const payload = (await response.json()) as {
        reanalysis?: VoiceProfileReanalysisPayload;
        profile?: VoiceProfilePayload;
        message?: string;
      };
      if (!response.ok || !payload.reanalysis || !payload.profile) {
        throw new Error(payload.message || t.profileReanalyzeFailed);
      }
      setProfileReanalysis(payload.reanalysis);
      setVoiceProfile(payload.profile);
      setProfileTranscriptValidation(null);
      setProfileTranscriptStatus("idle");
      setProfileReanalysisStatus("idle");
      await verifyVoiceProfile();
    } catch {
      setProfileReanalysisStatus("error");
    }
  }

  async function verifyVoiceProfile(): Promise<boolean> {
    setProfileVerifyStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default" }),
      });
      const payload = (await response.json()) as { verification?: VoiceProfileVerificationPayload; message?: string };
      if (!response.ok || !payload.verification) {
        throw new Error(payload.message || t.profileVerifyFailed);
      }
      setProfileVerification(payload.verification);
      setProfileVerifyStatus("idle");
      return true;
    } catch {
      setProfileVerifyStatus("error");
      return false;
    }
  }

  async function auditVoiceCloneGoal(): Promise<boolean> {
    setGoalAuditStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/goal-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default" }),
      });
      const payload = (await response.json()) as { audit?: VoiceCloneGoalAuditPayload; message?: string };
      if (!response.ok || !payload.audit) {
        throw new Error(payload.message || t.profileGoalAuditFailed);
      }
      setGoalAudit(payload.audit);
      setGoalAuditStatus("idle");
      return true;
    } catch {
      setGoalAuditStatus("error");
      return false;
    }
  }

  async function validateProfileTranscripts(): Promise<boolean> {
    setProfileTranscriptStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/transcript-validation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "local-default" }),
      });
      const payload = (await response.json()) as { validation?: VoiceProfileTranscriptValidationPayload; message?: string };
      if (!response.ok || !payload.validation) {
        throw new Error(payload.message || t.profileTranscriptValidateFailed);
      }
      setProfileTranscriptValidation(payload.validation);
      setProfileTranscriptStatus("idle");
      await verifyVoiceProfile();
      return true;
    } catch {
      setProfileTranscriptStatus("error");
      return false;
    }
  }

  async function runPostProfileImportProof() {
    const transcriptValidationFinished = await validateProfileTranscripts();
    if (!transcriptValidationFinished) {
      await verifyVoiceProfile();
    }
    await auditVoiceCloneGoal();
  }

  async function importProfileClipFiles(selected: File[], clipSpecs = profileBulkClipSpecs) {
    setProfileBulkMessage("");
    setProfileBulkStatus("idle");
    const form = new FormData();
    form.set("consent", "yes");
    form.set(
      "clips",
      JSON.stringify(
        clipSpecs.map((spec, index) => ({
          id: spec.id,
          fileField: `voice-${index}`,
          expectedStem: spec.expectedStem,
          transcript: spec.transcript,
          sourceKind: "uploaded",
        })),
      ),
    );
    selected.forEach((file, index) => form.set(`voice-${index}`, file));

    setProfileBulkStatus("loading");
    try {
      const response = await fetch("/api/voice-profile/import", { method: "POST", body: form });
      const payload = (await response.json()) as {
        status?: string;
        imported?: number;
        message?: string;
        profile?: VoiceProfilePayload;
      };
      if (!response.ok || payload.status !== "imported" || !payload.profile) {
        throw new Error(payload.message || t.profileBulkFailed);
      }
      setVoiceProfile(payload.profile);
      setProfileTranscriptValidation(null);
      setProfileTranscriptStatus("idle");
      setProfileBulkMessage(
        `${t.profileBulkSuccess(payload.imported ?? selected.length, payload.profile.summary.remainingClipsNeeded)} ${
          t.profileBulkProofStarted
        }`,
      );
      setProfileBulkStatus("idle");
      void runPostProfileImportProof();
      return true;
    } catch (error) {
      setProfileBulkStatus("error");
      setProfileBulkMessage(error instanceof Error ? error.message : t.profileBulkFailed);
      return false;
    }
  }

  async function importProfileRecordings(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const expected = profileBulkClipSpecs;
    const files = Array.from(input.files ?? []).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length < expected.length) {
      setProfileBulkStatus("error");
      setProfileBulkMessage(t.profileBulkMissing(expected.length));
      input.value = "";
      return;
    }

    const selectedByIndex = new Map<number, File>();
    for (const file of files) {
      const index = profileClipIndexFromName(file.name, expected.length);
      if (index !== null && !selectedByIndex.has(index)) {
        selectedByIndex.set(index, file);
      }
    }
    if (expected.some((_, index) => !selectedByIndex.has(index))) {
      setProfileBulkStatus("error");
      setProfileBulkMessage(t.profileBulkNameMismatch(profileBulkFirstStem, profileBulkLastStem));
      input.value = "";
      return;
    }
    const selected = expected.map((_, index) => selectedByIndex.get(index)!);
    try {
      await importProfileClipFiles(selected, expected);
    } finally {
      input.value = "";
    }
  }

  function profileDraftCaptureProcessingLabel(draft: ProfileDraftClip): string {
    return captureProcessingLabel(draft.captureSettings);
  }

  function profileDraftQualityIssue(draft: ProfileDraftClip): "too_short" | "too_long" | "low_voice_active" | "processed_capture" | "" {
    if (typeof draft.durationSec === "number" && Number.isFinite(draft.durationSec)) {
      if (draft.durationSec < profileMinDuration) return "too_short";
      if (draft.durationSec > profileMaxDuration) return "too_long";
      if (
        typeof draft.voiceActiveSec === "number" &&
        Number.isFinite(draft.voiceActiveSec) &&
        draft.voiceActiveSec < profileMinVoiceActiveDuration
      ) {
        return "low_voice_active";
      }
    }
    if (profileDraftCaptureUsesProcessing(draft.captureSettings)) return "processed_capture";
    return "";
  }

  function profileDraftStatusLabel(draft: ProfileDraftClip): string {
    const issue = profileDraftQualityIssue(draft);
    const hasDuration = typeof draft.durationSec === "number" && Number.isFinite(draft.durationSec);
    const duration = hasDuration ? formatDuration(draft.durationSec!) : t.profileDraftSaved;
    const voiceActive =
      typeof draft.voiceActiveSec === "number" && Number.isFinite(draft.voiceActiveSec)
        ? formatDuration(draft.voiceActiveSec)
        : "";
    if (issue === "processed_capture") return t.profileDraftProcessedCapture(duration, profileDraftCaptureProcessingLabel(draft));
    if (!hasDuration) return t.profileDraftSaved;
    if (issue === "too_short") return t.profileDraftTooShort(duration, profileMinDuration);
    if (issue === "too_long") return t.profileDraftTooLong(duration, profileMaxDuration);
    if (issue === "low_voice_active") {
      return t.profileDraftLowVoiceActive(duration, voiceActive, formatDuration(profileMinVoiceActiveDuration));
    }
    if (voiceActive) return t.profileDraftDurationWithVoice(duration, voiceActive);
    return t.profileDraftDuration(duration);
  }

  async function importAllProfileDrafts(drafts = profileDraftClipsRef.current) {
    const selectedByIndex = new Map(drafts.map((draft) => [draft.index, draft.file]));
    const draftSpecs = profileBulkClipSpecs;
    if (draftSpecs.some((_, index) => !selectedByIndex.has(index))) {
      setProfileBulkStatus("error");
      setProfileBulkMessage(t.profileBulkMissing(draftSpecs.length));
      return;
    }
    const draftIssue = drafts.find((draft) => draft.index < draftSpecs.length && profileDraftQualityIssue(draft));
    if (draftIssue) {
      setProfileBulkStatus("error");
      setProfileBulkMessage(
        profileDraftQualityIssue(draftIssue) === "processed_capture"
          ? t.profileDraftCaptureBlocked
          : t.profileDraftDurationBlocked,
      );
      return;
    }
    const imported = await importProfileClipFiles(draftSpecs.map((_, index) => selectedByIndex.get(index)!), draftSpecs);
    if (imported) {
      await clearProfileDrafts();
    }
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

  async function enrollReferenceClip({
    file,
    kind,
    promptTranscript,
    skipClientDurationGate = false,
  }: {
    file: File | null;
    kind: SourceKind | null;
    promptTranscript: string;
    skipClientDurationGate?: boolean;
  }) {
    setEnrollMessage("");
    setEnrollStatus("idle");

    if (!file || !kind) {
      setEnrollStatus("error");
      setEnrollMessage(t.noAudio);
      return false;
    }
    if (!skipClientDurationGate && profileEnrollmentBlockMessage) {
      setEnrollStatus("error");
      setEnrollMessage(profileEnrollmentBlockMessage);
      return false;
    }
    if (!promptTranscript) {
      setEnrollStatus("error");
      setEnrollMessage(t.noTranscript);
      return false;
    }
    if (!consent) {
      setEnrollStatus("error");
      setEnrollMessage(t.noConsent);
      return false;
    }

    setEnrollStatus("loading");
    const form = new FormData();
    form.set("voice", file);
    form.set("promptTranscript", promptTranscript);
    form.set("sourceKind", kind);
    form.set("consent", "yes");

    try {
      const response = await fetch("/api/voice-profile/enroll", { method: "POST", body: form });
      const payload = (await response.json()) as VoiceProfileEnrollmentPayload;
      if (!response.ok || payload.status !== "enrolled") {
        throw new Error(payload.message || t.profileEnrollFailed);
      }
      if (payload.profile) setVoiceProfile(payload.profile);
      const remaining = payload.profile?.summary.remainingClipsNeeded ?? profileRemaining;
      const quality = payload.referenceQuality;
      const rejectionReason = quality ? profileQualityRejectionReason(quality, payload.profile?.requirements ?? profileRequirements, locale) : null;
      setEnrollMessage(
        rejectionReason
          ? t.profileEnrollRejected(rejectionReason)
          : t.profileEnrollSuccess(quality?.grade ?? "C", remaining),
      );
      setEnrolledReferenceKey(referenceKey(file, kind, promptTranscript));
      if (kind === "scripted" && remaining > 0 && !rejectionReason && payload.profile) {
        const next = selectNextProfileRecordingScript({
          scripts,
          missingCoverageFeatures: (payload.profile.diagnostics?.missingCoverageFeatures ?? []) as VoiceProfileCoverageFeature[],
          eligibleClips: payload.profile.summary.eligibleClips,
          draftIndices: profileDraftClipsRef.current.map((draft) => draft.index),
        });
        if (next && scripts.length > 0) setScriptIndex(next.index % scripts.length);
      }
      setEnrollStatus("idle");
      if (payload.profile) {
        setProfileTranscriptValidation(null);
        setProfileTranscriptStatus("idle");
        await verifyVoiceProfile();
      }
      return true;
    } catch (error) {
      setEnrollStatus("error");
      setEnrollMessage(error instanceof Error ? error.message : t.profileEnrollFailed);
      return false;
    }
  }

  async function enrollCurrentReference() {
    await enrollReferenceClip({
      file: voiceFile,
      kind: sourceKind,
      promptTranscript: resolvePromptTranscript(),
    });
  }

  async function enrollProfileDraft(index: number) {
    const draft = profileDraftClips.find((item) => item.index === index);
    if (!draft) {
      setEnrollStatus("error");
      setEnrollMessage(t.profileDraftFailed);
      return;
    }
    setMode("scripted");
    setScriptIndex(index);
    await adoptVoiceFile(draft.file, "scripted", {
      mode: "scripted",
      persist: false,
      transcript: draft.transcript,
    });
    await enrollReferenceClip({
      file: draft.file,
      kind: "scripted",
      promptTranscript: draft.transcript,
      skipClientDurationGate: true,
    });
  }

  async function submit() {
    setMessage("");
    setAudioUrl("");
    setReferenceQuality(null);
    setLastResponse(null);
    setStreamEvents([]);

    const usingVoiceProfile = profileHardGateReady && useVoiceProfile;

    if (!usingVoiceProfile && (!voiceFile || !sourceKind)) {
      setStatus("error");
      setMessage(t.noAudio);
      return;
    }
    if (!targetText.trim()) {
      setStatus("error");
      setMessage(t.noText);
      return;
    }
    const promptTranscript = usingVoiceProfile ? "" : resolvePromptTranscript();
    if (!usingVoiceProfile && !promptTranscript) {
      setStatus("error");
      setMessage(t.noTranscript);
      return;
    }
    if (pronunciationRejected.length > 0) {
      setStatus("error");
      setMessage(t.pronunciationInvalid(pronunciationRejected[0].line));
      return;
    }
    if (usingVoiceProfile && isUnstableChineseScript(targetText)) {
      setStatus("error");
      setMessage(t.profileTargetScriptBlocked);
      return;
    }
    if (!consent) {
      setStatus("error");
      setMessage(t.noConsent);
      return;
    }

    setStatus("submitting");
    const form = new FormData();
    form.set("targetText", targetText);
    form.set("consent", "yes");
    form.set("quality", qualityPreset);
    if (pronunciationOverridesText.trim()) {
      form.set("pronunciationOverrides", pronunciationOverridesText);
    }
    if (usingVoiceProfile) {
      form.set("useVoiceProfile", "yes");
    } else {
      form.set("voice", voiceFile!);
      form.set("promptTranscript", promptTranscript);
      form.set("sourceKind", sourceKind!);
    }

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
  const guidedProfileRecording = isRecording && recordingEnrollAfterStop;
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
            : sourceKind === "profile"
              ? t.sourceProfile
            : "";

  const currentPromptTranscript = resolvePromptTranscript();
  const currentReferenceKey = referenceKey(voiceFile, sourceKind, currentPromptTranscript);
  const currentReferenceEnrolled = Boolean(currentReferenceKey && currentReferenceKey === enrolledReferenceKey);
  const profileSummary = voiceProfile?.summary;
  const profileRequirements = voiceProfile?.requirements;
  const profileIsReady = voiceProfile?.status === "ready";
  const profileHardGateReady = profileIsReady && profileVerification?.status === "ready";
  const profileRemaining = profileSummary?.remainingClipsNeeded ?? 0;
  const profileMissingCoverage = [...((voiceProfile?.diagnostics?.missingCoverageFeatures ?? []) as VoiceProfileCoverageFeature[])];
  const profileIssues = [
    ...profileMissingCoverage.map((feature) => ({
      reason: `missing_coverage_${feature}`,
      count: 1,
    })),
    ...(voiceProfile?.diagnostics?.rejectionReasons ?? []),
  ].slice(0, 5);
  const profileRejectedExamples = voiceProfile?.diagnostics?.topRejectedClips?.slice(0, 3) ?? [];
  const profileScripts = voiceProfile?.diagnostics?.eligibleTranscriptScripts?.slice(0, 4) ?? [];
  const profileMinDuration = profileRequirements?.minDurationSec ?? 6;
  const profileMaxDuration = profileRequirements?.maxDurationSec ?? 20;
  const profileRecommendedRecordingDuration = Math.min(profileMaxDuration, Math.max(profileMinDuration + 2, 8));
  const profileMinVoiceActiveDuration = Math.min(profileMinDuration, profileRecommendedRecordingDuration * 0.65);
  const profileRequiredCoverage = (profileRequirements?.requiredCoverageFeatures ?? PROFILE_COVERAGE_FEATURES) as VoiceProfileCoverageFeature[];
  const profileCoverageCounts = new Map(
    (voiceProfile?.diagnostics?.coverageFeatures ?? []).map((item) => [item.feature, item.count]),
  );
  const profileCoverageItems = voiceProfile
    ? profileRequiredCoverage.map((feature) => {
        const count = profileCoverageCounts.get(feature) ?? 0;
        return {
          feature,
          count,
          missing: count <= 0 || profileMissingCoverage.includes(feature),
        };
      })
    : [];
  const profileScriptPlan = voiceProfile
    ? buildProfileScriptPlan({
        scripts: profileRecordingScripts,
        acceptedClips: voiceProfile.clips ?? [],
        rejectedClips: voiceProfile.rejectedClips ?? [],
        missingCoverageFeatures: profileMissingCoverage,
      })
    : [];
  const activeProfileDraftClips = useMemo(
    () => profileDraftClips.filter((draft) => draft.index < profileRecordingScripts.length),
    [profileDraftClips, profileRecordingScripts.length],
  );
  const profileDraftByIndex = useMemo(
    () => new Map(activeProfileDraftClips.map((draft) => [draft.index, draft])),
    [activeProfileDraftClips],
  );
  const profileDraftCount = activeProfileDraftClips.length;
  const profileDraftComplete = profileRecordingScripts.every((_, index) => profileDraftByIndex.has(index));
  const profileNextRecording = (() => {
    if (!voiceProfile) return null;
    if (profileIsReady) return null;
    return selectNextProfileRecordingScript({
      scripts: profileRecordingScripts,
      missingCoverageFeatures: profileMissingCoverage,
      eligibleClips: profileSummary?.eligibleClips ?? 0,
      draftIndices: profileDraftByIndex.keys(),
    });
  })();
  const profileNextTargetDurationSec = profileNextRecording
    ? profileBulkTargetDurationSec(profileBulkClipSpecs[profileNextRecording.index])
    : null;
  const targetScriptIssue = chineseScriptIssue(targetText);
  const targetScriptWarning = scriptWarningForIssue(
    targetText,
    targetScriptIssue,
    t.scriptWarningTarget,
    t.scriptWarningTargetUnproven,
    t,
    locale,
  );
  const targetTraditionalFix = useMemo(
    () => (targetScriptIssue === "invalid" ? suggestKnownTraditionalChineseText(targetText) : null),
    [targetScriptIssue, targetText],
  );
  const transcriptScriptIssue = currentPromptTranscript ? chineseScriptIssue(currentPromptTranscript) : "none";
  const transcriptScriptWarning =
    currentPromptTranscript
      ? scriptWarningForIssue(
          currentPromptTranscript,
          transcriptScriptIssue,
          t.scriptWarningTranscript,
          t.scriptWarningTranscriptUnproven,
          t,
          locale,
        )
      : "";
  const scriptMismatchWarning =
    voiceFile && currentPromptTranscript && hasChineseScriptMismatch(currentPromptTranscript, targetText)
      ? t.scriptWarningMismatch
      : "";
  const pronunciationParsed = useMemo(
    () => parsePronunciationOverrides(pronunciationOverridesText),
    [pronunciationOverridesText],
  );
  const pronunciationOverrides = pronunciationParsed.overrides;
  const pronunciationRejected = pronunciationParsed.rejected;
  const pronunciationSuggestions = useMemo(
    () => suggestPronunciationOverrides(targetText, pronunciationOverrides),
    [pronunciationOverrides, targetText],
  );
  const targetModelPreview = useMemo(
    () => prepareVoiceText(targetText, { pronunciationOverrides, autoApplyPresetPronunciations: true }),
    [pronunciationOverrides, targetText],
  );
  const showPronunciationPreview = Boolean(
    targetText.trim() &&
      (targetModelPreview.model !== targetText.trim() ||
        targetModelPreview.pronunciationOverrides.length > 0 ||
        pronunciationRejected.length > 0),
  );

  const enrolling = enrollStatus === "loading";
  const profileTargetScriptBlockMessage =
    profileHardGateReady && useVoiceProfile
      ? scriptBlockMessageForIssue(targetScriptIssue, t.profileTargetScriptBlocked, t.profileTargetScriptUnprovenBlocked)
      : "";
  const profileUseHelper = profileVerifyStatus === "loading"
    ? t.profileUseChecking
    : profileHardGateReady
      ? t.profileUsing
      : profileVerification?.status === "blocked"
        ? t.profileUseBlocked
        : t.profileUseNeedsVerify;
  const submitDisabled =
    status === "submitting" ||
    isRecording ||
    pronunciationRejected.length > 0 ||
    Boolean(profileTargetScriptBlockMessage);
  const profileEnrollmentScriptBlockMessage =
    voiceFile && currentPromptTranscript
      ? scriptBlockMessageForIssue(transcriptScriptIssue, t.profileEnrollScriptBlocked, t.profileEnrollScriptUnprovenBlocked)
      : "";
  const profileEnrollmentBlockMessage =
    voiceFile && sourceKind === "sample"
      ? t.profileEnrollSampleBlocked
      : profileEnrollmentScriptBlockMessage
        ? profileEnrollmentScriptBlockMessage
      : voiceFile && sourceDuration !== null && sourceDuration < profileMinDuration
        ? t.profileEnrollShortBlocked(profileMinDuration)
        : voiceFile && sourceDuration !== null && sourceDuration > profileMaxDuration
          ? t.profileEnrollLongBlocked(profileMaxDuration)
          : "";
  const enrollDisabled =
    submitDisabled ||
    enrolling ||
    !voiceFile ||
    !sourceKind ||
    currentReferenceEnrolled ||
    Boolean(profileEnrollmentBlockMessage);
  const recordingApproachingLimit = isRecording && recordingElapsed >= MAX_RECORDING_SECONDS - 8;
  const recordingMeetsRecommendedDuration = recordingElapsed >= profileRecommendedRecordingDuration;
  const recordingMeetsVoiceActiveDuration =
    !voiceActiveTrackingAvailable || recordingVoiceActiveElapsed >= profileMinVoiceActiveDuration;
  const stopRecordingDisabled =
    guidedProfileRecording && (!recordingMeetsRecommendedDuration || !recordingMeetsVoiceActiveDuration);
  const stopRecordingDisabledLabel = !recordingMeetsRecommendedDuration
    ? t.profileStopMin(profileRecommendedRecordingDuration)
    : t.profileStopVoiceActive(formatDuration(profileMinVoiceActiveDuration));
  const targetNearLimit = targetText.length >= MAX_TARGET_CHARS * 0.8;

  const qualityMeta = {
    speed: { label: t.qualitySpeed, hint: t.qualitySpeedHint },
    balanced: { label: t.qualityBalanced, hint: t.qualityBalancedHint },
    quality: { label: t.qualityQuality, hint: t.qualityQualityHint },
  } satisfies Record<QualityPreset, { label: string; hint: string }>;

  const recordingGuide = (() => {
    if (status === "requesting_mic") return { tone: "info", text: t.guideRequesting };
    if (isRecording) {
      if (inputLevel > 0.82) return { tone: "warn", text: t.guideTooLoud };
      if (recordingElapsed > 1.2 && inputLevel < 0.04) return { tone: "warn", text: t.guideTooQuiet };
      if (guidedProfileRecording && !recordingMeetsRecommendedDuration) {
        return { tone: "info", text: t.guideKeepRecording(formatDuration(profileRecommendedRecordingDuration)) };
      }
      if (guidedProfileRecording && !recordingMeetsVoiceActiveDuration) {
        return {
          tone: "info",
          text: t.guideKeepSpeaking(formatDuration(recordingVoiceActiveElapsed), formatDuration(profileMinVoiceActiveDuration)),
        };
      }
      if (recordingElapsed < profileMinDuration) return { tone: "info", text: t.guideKeepReading };
      if (recordingElapsed >= profileMaxDuration) return { tone: "ready", text: t.guideEnough };
      return { tone: "ready", text: t.guideGoodLevel };
    }
    if (voiceFile) {
      if (sourceDuration !== null && sourceDuration < profileMinDuration) return { tone: "warn", text: t.guideCapturedShort };
      if (sourceDuration !== null && sourceDuration > profileMaxDuration) return { tone: "warn", text: t.guideCapturedLong };
      return { tone: "ready", text: t.guideReady };
    }
    return { tone: "info", text: t.guideIdle };
  })();

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
  const recordingKitCheckMessage = recordingKitCheck
    ? recordingKitCheck.status === "ready_to_import"
      ? t.profileKitCheckReady(recordingKitCheck.summary.audioFilesPresent)
      : recordingKitCheck.summary.audioFilesPresent >= recordingKitCheck.summary.clips
        ? t.profileKitCheckNeedsFixes
      : t.profileKitCheckIncomplete(recordingKitCheck.summary.audioFilesPresent, recordingKitCheck.summary.clips)
    : "";
  const recordingKitMissingCoverage = recordingKit?.summary?.missingCoverageFeatures ?? [];
  const recordingKitMissingPresets = recordingKit?.summary?.missingPronunciationPresetIds ?? [];
  const recordingKitCoverageMessage = recordingKit?.summary
    ? recordingKitMissingCoverage.length > 0 || recordingKitMissingPresets.length > 0
      ? t.profileKitCoverageMissing(
          profileCoverageList([...recordingKitMissingCoverage, ...recordingKitMissingPresets], locale),
        )
      : t.profileKitCoverageReady(profileCoverageList(recordingKit.summary.coveredFeatures, locale))
    : "";
  const recordingKitPreflightMessage = recordingKitPreflight
    ? recordingKitPreflight.status === "ready_to_record"
      ? t.profileKitPreflightReady(recordingKitPreflight.summary.toRecord, recordingKitPreflight.recorder.source)
      : recordingKitPreflight.status === "all_recordings_present"
        ? t.profileKitPreflightComplete
        : recordingKitPreflight.message
    : "";
  const recordingKitSmokeTestResult = recordingKitSmokeTest?.microphoneSmokeTest;
  const recordingKitSmokeLevelMessage =
    typeof recordingKitSmokeTestResult?.audioLevelQuality?.peakAmplitude === "number" &&
    typeof recordingKitSmokeTestResult.audioLevelQuality.clippingRatio === "number"
      ? t.profileKitMicSmokeLevel(
          recordingKitSmokeTestResult.audioLevelQuality.peakAmplitude,
          recordingKitSmokeTestResult.audioLevelQuality.clippingRatio,
        )
      : "";
  const recordingKitSmokeErrorMessage = recordingKitSmokeTestResult?.errors?.length
    ? recordingKitSmokeTestResult.errors.map((error) => describeRecordingKitError(error, t)).join(", ")
    : "";
  const recordingKitSmokeTestMessage = recordingKitSmokeTest
    ? recordingKitSmokeTestResult?.status === "passed"
      ? [
          t.profileKitMicSmokePassed(
            recordingKitSmokeTestResult.audioBytes ?? 0,
            recordingKitSmokeTestResult.durationSec ?? 0,
          ),
          recordingKitSmokeLevelMessage,
        ]
          .filter(Boolean)
          .join(" ")
      : [recordingKitSmokeTest.message, recordingKitSmokeErrorMessage, recordingKitSmokeLevelMessage].filter(Boolean).join(" ")
    : "";
  const recordingKitNormalizeMessage = recordingKitNormalization
    ? t.profileKitNormalizeSummary(
        recordingKitNormalization.summary.normalized,
        recordingKitNormalization.summary.existing,
        recordingKitNormalization.summary.missingSources,
      )
    : "";
  const profileReanalysisMessage = profileReanalysis
    ? t.profileReanalysisSummary(
        profileReanalysis.plannedOrUpdated,
        profileReanalysis.scanned,
        profileReanalysis.failures?.length ?? 0,
        voiceProfile?.summary.remainingClipsNeeded ?? profileReanalysis.profile?.remainingClipsNeeded ?? 0,
      )
    : "";
  const profileVerificationMessage = profileVerification
    ? profileVerification.status === "ready"
      ? t.profileVerifyReady
      : t.profileVerifyBlocked
    : "";
  const profileNextAction = profileVerification?.nextStep?.nextAction;
  const profileVerificationNextCommand =
    profileNextAction?.command ||
    profileVerification?.nextCommands?.validateTranscripts ||
    profileVerification?.nextCommands?.buildProfile ||
    profileVerification?.nextCommands?.recordingKit ||
    "";
  const profileVerificationNextReason = profileNextAction?.reason || "";
  const profileVerificationCueClips = profileVerification?.nextStep?.recordingBrief?.clips ?? [];
  const profileProofPlan = profileVerification?.nextStep?.postRecordingProofPlan;
  const profileProofArtifacts = profileProofPlan?.artifacts ?? [];
  const profileProofGates = profileProofPlan?.gates ?? [];
  const goalAuditMessage = goalAudit
    ? goalAudit.complete
      ? t.profileGoalAuditComplete
      : t.profileGoalAuditBlocked(goalAudit.firstBlocker?.id || goalAudit.status)
    : "";
  const goalAuditProofEnvironment = goalAudit?.stages.find((stage) => stage.id === "proof_environment");
  const goalAuditProofAsr = goalAuditProofEnvironment?.asr;
  const goalAuditProofSpeaker = goalAuditProofEnvironment?.speaker;
  const goalAuditFocusedClip = goalAudit?.firstBlocker?.firstMissingClip;
  const goalAuditRecordingPreflight = goalAudit?.firstBlocker?.recordingPreflight;
  const recordingPrescription = profileVerification?.recordingPrescription;
  const recordingPrescriptionCoverage =
    [
      ...(recordingPrescription?.missingCoverageFeatures?.map((feature) =>
        profileCoverageLabel(feature as VoiceProfileCoverageFeature, locale),
      ) ?? []),
      ...(recordingPrescription?.missingPronunciationPresetIds ?? []),
    ].join("、") || "";
  const profileTranscriptValidationMessage = profileTranscriptValidation
    ? profileTranscriptValidation.message ||
      (profileTranscriptValidation.status === "pass"
      ? t.profileTranscriptValidationReady(profileTranscriptValidation.passed, profileTranscriptValidation.total)
      : t.profileTranscriptValidationBlocked(profileTranscriptValidation.passed, profileTranscriptValidation.total))
    : "";
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
              <div className="script-nav" aria-label={t.modeScripted}>
                <button
                  className="icon-button icon-button--on-dark"
                  type="button"
                  aria-label={t.previousScript}
                  title={t.previousScript}
                  onClick={() => setScriptIndex((index) => (index + scripts.length - 1) % scripts.length)}
                >
                  <ChevronLeft size={14} />
                </button>
                <span>{t.scriptStep(scriptIndex + 1, scripts.length)}</span>
                <button
                  className="icon-button icon-button--on-dark"
                  type="button"
                  aria-label={t.nextScript}
                  title={t.nextScript}
                  onClick={() => setScriptIndex((index) => (index + 1) % scripts.length)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              <blockquote className="script-text" lang={locale}>
                {currentScript}
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
                <button
                  className="btn btn--on-dark btn--lg"
                  type="button"
                  onClick={() => stopRecording()}
                  disabled={stopRecordingDisabled}
                >
                  <CircleStop size={16} /> {stopRecordingDisabled ? stopRecordingDisabledLabel : t.stop}
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
          {isRecording && captureStatus ? (
            <div className={`recording-guide recording-capture is-${captureStatus.tone}`} role="status">
              <span aria-hidden />
              <p>{captureStatus.text}</p>
            </div>
          ) : null}

          <div className="source-readout">
            {sourceKind ? (
              <div className="source-meta">
                <strong title={voiceFile?.name}>{sourceLabel}</strong>
                {referenceSavedLocal && sourceKind !== "sample" ? <small>{t.referenceSavedLocal}</small> : null}
              </div>
            ) : null}
            {isRecording ? (
              <div className={`recording-cap ${recordingApproachingLimit ? "is-warn" : ""}`}>
                <strong>{formatDuration(recordingElapsed)}</strong>
                <small>/ {formatDuration(MAX_RECORDING_SECONDS)}</small>
                {guidedProfileRecording && voiceActiveTrackingAvailable ? (
                  <small>{t.profileVoiceActiveMeter(formatDuration(recordingVoiceActiveElapsed), formatDuration(profileMinVoiceActiveDuration))}</small>
                ) : null}
              </div>
            ) : voiceFile ? (
              <div className="source-audio-row">
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
                <a
                  className="icon-button icon-button--on-dark"
                  href={sourcePreviewUrl}
                  download={voiceFile.name || "anyvoice-reference.audio"}
                  aria-label={t.downloadReference}
                  title={t.downloadReference}
                >
                  <Download size={14} />
                </a>
                <button
                  className="icon-button icon-button--on-dark"
                  type="button"
                  aria-label={t.clearReference}
                  title={t.clearReference}
                  onClick={clearVoiceFile}
                >
                  <Trash2 size={14} />
                </button>
              </div>
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
                onChange={(event) => {
                  const next = event.target.value.slice(0, MAX_TRANSCRIPT_CHARS);
                  setFreeformTranscript(next);
                  if (sourceKind === "freeform" || sourceKind === "uploaded") {
                    setSourceTranscript(next.trim());
                  }
                }}
                placeholder={t.transcriptPlaceholder}
                rows={3}
              />
              {transcriptScriptWarning ? <p className="script-warning">{transcriptScriptWarning}</p> : null}
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
            {targetScriptWarning ? (
              <div className="script-warning">
                <p>{targetScriptWarning}</p>
                {targetTraditionalFix ? (
                  <button
                    type="button"
                    onClick={() => setUserTargetText(targetTraditionalFix.text.slice(0, MAX_TARGET_CHARS))}
                  >
                    {t.scriptFixTarget}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="pronunciation-control">
            <label className="field-label" htmlFor="pronunciation-overrides">
              <strong>{t.pronunciationTitle}</strong>
              <span className="field-hint">{t.pronunciationHelp}</span>
            </label>
            <textarea
              id="pronunciation-overrides"
              className="textarea textarea--compact"
              value={pronunciationOverridesText}
              onChange={(event) => setPronunciationOverridesText(event.target.value.slice(0, 1200))}
              placeholder={t.pronunciationPlaceholder}
              rows={2}
            />
            {pronunciationSuggestions.length > 0 ? (
              <div className="pronunciation-suggestions" aria-label={t.pronunciationSuggestions}>
                <strong>{t.pronunciationSuggestions}</strong>
                <div>
                  {pronunciationSuggestions.map((suggestion) => (
                    <button
                      key={suggestion.term}
                      type="button"
                      onClick={() => addPronunciationSuggestion(suggestion)}
                    >
                      <span>{suggestion.term}</span>
                      <small>{suggestionReasonLabel(suggestion.reason, t)}</small>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {pronunciationRejected.length > 0 ? (
              <p className="script-warning">{t.pronunciationInvalid(pronunciationRejected[0].line)}</p>
            ) : null}
            {showPronunciationPreview ? (
              <div className="model-text-preview">
                <strong>{t.pronunciationPreview}</strong>
                <p>{targetModelPreview.model}</p>
              </div>
            ) : null}
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
            {enrollMessage ? (
              <p className={`enroll-state ${enrollStatus === "error" ? "is-error" : ""}`}>{enrollMessage}</p>
            ) : profileTargetScriptBlockMessage ? (
              <p className="enroll-state is-error">{profileTargetScriptBlockMessage}</p>
            ) : profileEnrollmentBlockMessage ? (
              <p className="enroll-state is-error">{profileEnrollmentBlockMessage}</p>
            ) : null}
            {scriptMismatchWarning ? <p className="script-warning">{scriptMismatchWarning}</p> : null}
          </div>
          <div className="submit-actions">
            <button
              className="btn btn--inverted btn--lg btn--profile-enroll"
              type="button"
              onClick={() => void enrollCurrentReference()}
              disabled={enrollDisabled}
            >
              {enrolling ? <Loader2 className="spin" size={16} /> : <BadgePlus size={16} />}
              {enrolling ? t.profileEnrolling : t.profileEnroll}
            </button>
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

        <section className="surface surface--cream profile-surface" aria-labelledby="h-profile">
          <div className="profile-head">
            <div>
              <h2 id="h-profile">{t.profileTitle}</h2>
              <p>{t.profileHelp}</p>
            </div>
            <button
              className="icon-button profile-refresh"
              type="button"
              aria-label={t.profileRefresh}
              title={t.profileRefresh}
              onClick={() => void loadVoiceProfile()}
            >
              <RefreshCw className={profileStatus === "loading" ? "spin" : ""} size={14} />
            </button>
          </div>

          {profileStatus === "error" ? <p className="history-state">{t.profileFailed}</p> : null}

          <div className={`profile-status ${profileIsReady ? "is-ready" : "is-needed"}`}>
            <span className="profile-status-dot" aria-hidden />
            <strong>{profileIsReady ? t.profileReady : t.profileNeeds}</strong>
            {profileRequirements ? (
              <span>{t.profileGate(profileRequirements.minClips, profileRequirements.minDurationSec, profileRequirements.maxDurationSec)}</span>
            ) : null}
          </div>
          {profileBulkMessage ? (
            <p className={`profile-kit-message ${profileBulkStatus === "error" ? "is-error" : ""}`}>{profileBulkMessage}</p>
          ) : null}

          {profileScriptPlan.length > 0 ? (
            <div className="profile-script-plan">
              <div className="profile-script-plan-head">
                <strong>{t.profileSessionTitle(profileRecordingScripts.length)}</strong>
                {profileNextRecording ? (
                  <div className="profile-session-tools">
                    {profileBrowserSessionActive ? (
                      <span>
                        {profileBrowserSessionCountdown !== null
                          ? t.profileSessionCountdown(profileBrowserSessionCountdown)
                          : t.profileSessionActive(profileDraftCount, profileRecordingScripts.length)}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={profileBrowserSessionActive ? stopProfileBrowserSession : startProfileBrowserSession}
                      disabled={!profileBrowserSessionActive && (isRecording || !consent)}
                    >
                      {profileBrowserSessionActive ? <CircleStop size={12} /> : <Mic size={12} />}
                      {profileBrowserSessionActive ? t.profileSessionStop : t.profileSessionStart}
                    </button>
                    <button
                      type="button"
                      onClick={() => void checkProfileBrowserMic()}
                      disabled={isRecording || profileBrowserSessionActive || profileBrowserMicCheckStatus === "loading"}
                    >
                      {profileBrowserMicCheckStatus === "loading" ? <Loader2 className="spin" size={12} /> : <ListChecks size={12} />}
                      {profileBrowserMicCheckStatus === "loading" ? t.profileBrowserMicChecking : t.profileBrowserMicCheck}
                    </button>
                  </div>
                ) : null}
                {profileDraftCount > 0 ? (
                  <div className="profile-draft-tools">
                    <span>{t.profileDraftRestored(profileDraftCount)}</span>
                    {profileDraftComplete ? (
                      <button
                        type="button"
                        onClick={() => void importAllProfileDrafts()}
                        disabled={profileBulkStatus === "loading"}
                      >
                        {profileBulkStatus === "loading" ? (
                          <Loader2 className="spin" size={12} />
                        ) : (
                          <Upload size={12} />
                        )}
                        {t.profileDraftUseAll}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => void clearProfileDrafts()}>
                      <Trash2 size={12} /> {t.profileDraftClear}
                    </button>
                  </div>
                ) : null}
              </div>
              <ol>
                {profileScriptPlan.map((item) => {
                  const statusLabel =
                    item.status === "accepted"
                      ? t.profileScriptStatusAccepted
                      : item.status === "rejected"
                        ? t.profileScriptStatusRejected
                        : t.profileScriptStatusMissing;
                  const primaryLabel = item.primaryFeature ? profileCoverageLabel(item.primaryFeature, locale) : "";
                  const canRecord = !profileIsReady && item.status !== "accepted";
                  const draft = profileDraftByIndex.get(item.index);
                  const targetDurationSec = profileBulkTargetDurationSec(profileBulkClipSpecs[item.index]);
                  return (
                    <li key={item.index} className={`is-${item.status}`}>
                      <span className="profile-script-index">{t.scriptStep(item.index + 1, profileRecordingScripts.length)}</span>
                      <span className="profile-script-feature">
                        {primaryLabel}
                        {targetDurationSec !== null ? <em>{t.profileKitCueTarget(targetDurationSec)}</em> : null}
                        {draft ? <em className={profileDraftQualityIssue(draft) ? "is-warning" : ""}>{profileDraftStatusLabel(draft)}</em> : null}
                      </span>
                      {canRecord ? (
                        <span className="profile-script-actions">
                          <button
                            className="profile-script-action"
                            type="button"
                            onClick={() => {
                              stopProfileBrowserSession();
                              recordProfileScript(item.index, item.text);
                            }}
                            disabled={isRecording || !consent}
                          >
                            <Mic size={12} /> {statusLabel}
                          </button>
                          {draft ? (
                            <button
                              className="profile-script-action"
                              type="button"
                              onClick={() => void enrollProfileDraft(item.index)}
                              disabled={isRecording || enrolling || !consent}
                            >
                              <Upload size={12} /> {t.profileDraftUse}
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        <b>{statusLabel}</b>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {profileNextRecording ? (
            <div className="profile-next">
              <div>
                <strong>{t.profileNextTitle}</strong>
                {profileNextRecording.primaryFeature ? (
                  <span>{t.profileNextHelp(profileCoverageLabel(profileNextRecording.primaryFeature, locale))}</span>
                ) : null}
                {profileNextTargetDurationSec !== null ? <span>{t.profileKitCueTarget(profileNextTargetDurationSec)}</span> : null}
              </div>
              <p>{profileNextRecording.text}</p>
              <button
                className="btn btn--inverted"
                type="button"
                onClick={() => {
                  stopProfileBrowserSession();
                  recordProfileScript(profileNextRecording.index, profileNextRecording.text);
                }}
                disabled={isRecording || !consent}
              >
                <Mic size={14} /> {t.profileNextAction}
              </button>
            </div>
          ) : null}

          {!profileIsReady ? (
            <div className="profile-kit">
              <div className="profile-kit-head">
                <div>
                  <strong>{t.profileReanalyzeTitle}</strong>
                  <span>{t.profileReanalyzeHelp}</span>
                </div>
                <button
                  className="btn btn--inverted"
                  type="button"
                  onClick={() => void reanalyzeExistingProfileRuns()}
                  disabled={profileReanalysisStatus === "loading"}
                >
                  {profileReanalysisStatus === "loading" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {profileReanalysisStatus === "loading" ? t.profileReanalyzing : t.profileReanalyze}
                </button>
              </div>
              {profileReanalysisStatus === "error" ? <p className="profile-kit-error">{t.profileReanalyzeFailed}</p> : null}
              {profileReanalysis ? (
                <div className="profile-kit-result" role="status">
                  <strong>{profileReanalysisMessage}</strong>
                  <dl>
                    <div>
                      <dt>{t.profileReanalysisUpdated}</dt>
                      <dd>{profileReanalysis.plannedOrUpdated}</dd>
                    </div>
                    <div>
                      <dt>{t.profileReanalysisSkipped}</dt>
                      <dd>{Object.values(profileReanalysis.skipped ?? {}).reduce((sum, count) => sum + count, 0)}</dd>
                    </div>
                    {profileReanalysis.failures && profileReanalysis.failures.length > 0 ? (
                      <div>
                        <dt>{t.profileReanalysisFailures}</dt>
                        <dd>{profileReanalysis.failures.map((failure) => failure.sourceRunId).join(", ")}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </div>
          ) : null}

          {!profileIsReady ? (
            <div className="profile-kit">
              <div className="profile-kit-head">
                <div>
                  <strong>{t.profileKitTitle}</strong>
                  <span>{t.profileKitHelp}</span>
                </div>
                <button
                  className="btn btn--inverted"
                  type="button"
                  onClick={() => void createRecordingKit("standard")}
                  disabled={recordingKitStatus === "loading"}
                >
                  {recordingKitStatus === "loading" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <FolderPlus size={14} />
                  )}
                  {recordingKitStatus === "loading" ? t.profileKitCreating : t.profileKitCreate}
                </button>
                <button
                  className="btn btn--inverted"
                  type="button"
                  onClick={() => void createRecordingKit("extended")}
                  disabled={recordingKitStatus === "loading"}
                >
                  {recordingKitStatus === "loading" ? (
                    <Loader2 className="spin" size={14} />
                  ) : (
                    <FolderPlus size={14} />
                  )}
                  {recordingKitStatus === "loading" ? t.profileKitCreating : t.profileKitCreateExtended}
                </button>
                {recordingKit ? (
                  <button
                    className="btn btn--inverted"
                    type="button"
                    onClick={() => void preflightRecordingKit()}
                    disabled={recordingKitPreflightStatus === "loading"}
                  >
                    {recordingKitPreflightStatus === "loading" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <ListChecks size={14} />
                    )}
                    {recordingKitPreflightStatus === "loading" ? t.profileKitPreflighting : t.profileKitPreflight}
                  </button>
                ) : null}
                {recordingKit ? (
                  <button
                    className="btn btn--inverted"
                    type="button"
                    onClick={() => void smokeTestRecordingKit()}
                    disabled={recordingKitSmokeTestStatus === "loading"}
                  >
                    {recordingKitSmokeTestStatus === "loading" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Mic size={14} />
                    )}
                    {recordingKitSmokeTestStatus === "loading" ? t.profileKitMicSmoking : t.profileKitMicSmoke}
                  </button>
                ) : null}
                {recordingKit ? (
                  <button
                    className="btn btn--inverted"
                    type="button"
                    onClick={() => void normalizeRecordingKitAudio()}
                    disabled={recordingKitNormalizeStatus === "loading"}
                  >
                    {recordingKitNormalizeStatus === "loading" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Upload size={14} />
                    )}
                    {recordingKitNormalizeStatus === "loading" ? t.profileKitNormalizing : t.profileKitNormalize}
                  </button>
                ) : null}
                {recordingKit ? (
                  <button
                    className="btn btn--inverted"
                    type="button"
                    onClick={() => void checkRecordingKit()}
                    disabled={recordingKitCheckStatus === "loading"}
                  >
                    {recordingKitCheckStatus === "loading" ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <ListChecks size={14} />
                    )}
                    {recordingKitCheckStatus === "loading" ? t.profileKitChecking : t.profileKitCheck}
                  </button>
                ) : null}
                <label className={`btn btn--inverted file-trigger ${profileBulkStatus === "loading" ? "is-disabled" : ""}`}>
                  {profileBulkStatus === "loading" ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
                  {profileBulkStatus === "loading" ? t.profileBulkUploading : profileBulkUploadLabel}
                  <input
                    type="file"
                    accept="audio/*"
                    multiple
                    onChange={importProfileRecordings}
                    disabled={profileBulkStatus === "loading"}
                    aria-label={profileBulkUploadLabel}
                  />
                </label>
              </div>
              {recordingKitStatus === "error" ? <p className="profile-kit-error">{t.profileKitFailed}</p> : null}
              {recordingKitPreflightStatus === "error" ? <p className="profile-kit-error">{t.profileKitPreflightFailed}</p> : null}
              {recordingKitSmokeTestStatus === "error" ? <p className="profile-kit-error">{t.profileKitMicSmokeFailed}</p> : null}
              {recordingKitNormalizeStatus === "error" ? <p className="profile-kit-error">{t.profileKitNormalizeFailed}</p> : null}
              {recordingKitCheckStatus === "error" ? <p className="profile-kit-error">{t.profileKitCheckFailed}</p> : null}
              {recordingKit ? (
                <div className="profile-kit-result" role="status">
                  <strong>{t.profileKitCreated}</strong>
                  <dl>
                    <div>
                      <dt>{t.profileKitRecordings}</dt>
                      <dd>{recordingKit.recordings}</dd>
                    </div>
                    {recordingKit.cueSheetHtml ? (
                      <div>
                        <dt>{t.profileKitCueSheet}</dt>
                        <dd>{recordingKit.cueSheetHtml}</dd>
                      </div>
                    ) : null}
                  {recordingKit.openCueSheetCommand || recordingKitPreflight?.openCueSheetCommand ? (
                    <div>
                      <dt>{t.profileKitOpenCueSheet}</dt>
                      <dd>
                        {recordingKit.cueSheetUrl ? (
                          <>
                            <a href={recordingKit.cueSheetUrl} target="_blank" rel="noreferrer">
                              {t.profileKitOpenCueSheet}
                            </a>
                            <br />
                          </>
                        ) : null}
                        {recordingKit.openCueSheetCommand || recordingKitPreflight?.openCueSheetCommand}
                      </dd>
                    </div>
                  ) : null}
                    {recordingKitCoverageMessage ? (
                      <div>
                        <dt>{t.profileKitCoverage}</dt>
                        <dd>{recordingKitCoverageMessage}</dd>
                      </div>
                    ) : null}
                    {recordingKitPreflightMessage ? (
                      <div>
                        <dt>{t.profileKitPreflight}</dt>
                        <dd>{recordingKitPreflightMessage}</dd>
                      </div>
                    ) : null}
                    {recordingKitSmokeTestMessage ? (
                      <div>
                        <dt>{t.profileKitMicSmoke}</dt>
                        <dd>{recordingKitSmokeTestMessage}</dd>
                      </div>
                    ) : null}
                    {recordingKitNormalizeMessage ? (
                      <div>
                        <dt>{t.profileKitNormalize}</dt>
                        <dd>{recordingKitNormalizeMessage}</dd>
                      </div>
                    ) : recordingKit.normalizeExternalRecordingsCommand ? (
                      <div>
                        <dt>{t.profileKitNormalize}</dt>
                        <dd>{recordingKit.normalizeExternalRecordingsCommand}</dd>
                      </div>
                    ) : null}
                    {recordingKit.recordMissingUntilCompleteCommand || recordingKit.recordNextMissingCommand || recordingKit.recordCommand ? (
                      <div>
                        <dt>{t.profileKitRecordNext}</dt>
                        <dd>{recordingKit.recordMissingUntilCompleteCommand || recordingKit.recordNextMissingCommand || recordingKit.recordCommand}</dd>
                      </div>
                    ) : null}
                    {recordingKit.recordAndProveCommand ? (
                      <div>
                        <dt>{t.profileKitRecordAndProve}</dt>
                        <dd>{recordingKit.recordAndProveCommand}</dd>
                      </div>
                    ) : null}
                    {recordingKit.recordProveAndProductProofCommand ? (
                      <div>
                        <dt>{t.profileKitRecordAndProductProof}</dt>
                        <dd>{recordingKit.recordProveAndProductProofCommand}</dd>
                      </div>
                    ) : null}
                    {recordingKit.recordProveProductProofAndLoraCommand ? (
                      <div>
                        <dt>{t.profileKitRecordAndLora}</dt>
                        <dd>{recordingKit.recordProveProductProofAndLoraCommand}</dd>
                      </div>
                    ) : null}
                    {recordingKit.proofCommand ? (
                      <div>
                        <dt>{t.profileKitProof}</dt>
                        <dd>{recordingKit.proofCommand}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t.profileKitEnroll}</dt>
                      <dd>{recordingKit.enrollCommand}</dd>
                    </div>
                    {recordingKitCheck ? (
                      <>
                        <div>
                          <dt>{t.profileKitCheck}</dt>
                          <dd>{recordingKitCheckMessage}</dd>
                        </div>
                        {recordingKitCheck.nextCommands?.importProfileClips ? (
                          <div>
                            <dt>{t.profileKitImport}</dt>
                            <dd>{recordingKitCheck.nextCommands.importProfileClips}</dd>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </dl>
                  {recordingKitPreflight?.clips?.length ? (
                    <section className="profile-kit-cue-sheet" aria-label={t.profileKitCueSheet}>
                      <header>
                        <strong>{t.profileKitCueSheet}</strong>
                        <span>{t.profileKitCueHelp}</span>
                      </header>
                      <ol className="profile-kit-cues">
                        {recordingKitPreflight.clips.map((clip, cueIndex) => {
                          const transcript = clip.transcript || clip.promptTranscript || "";
                          const command = clip.needsRerecord && clip.repairCommand ? clip.repairCommand : clip.recordCommand;
                          const targetDurationSec = preflightClipTargetDurationSec(clip);
                          return (
                            <li key={clip.id || `clip-${clip.index ?? cueIndex}`}>
                              <span className="profile-kit-cue-id">{clip.id || `clip-${clip.index}`}</span>
                              {targetDurationSec !== null ? (
                                <span className="profile-kit-cue-target">{t.profileKitCueTarget(targetDurationSec)}</span>
                              ) : null}
                              {transcript ? <p>{transcript}</p> : null}
                          {clip.pronunciationNotes?.length ? (
                            <ul className="profile-kit-cue-notes" aria-label={t.profileKitCueNotes}>
                              {clip.pronunciationNotes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          ) : null}
                          {clip.recordingIssues?.length ? (
                            <ul className="profile-kit-cue-notes" aria-label={t.profileKitCueNotes}>
                              {clip.recordingIssues.map((issue) => (
                                <li key={issue}>{issue}</li>
                              ))}
                            </ul>
                          ) : null}
                          {command ? <code className="profile-kit-cue-command">{command}</code> : null}
                        </li>
                      );
                    })}
                      </ol>
                    </section>
                  ) : null}
                  {recordingKitCheck ? (
                    <ul className={`profile-kit-check is-${recordingKitCheck.status}`}>
                      {recordingKitCheck.checks.flatMap((check) => [
                        <li key={check.check} className={check.ok ? "is-ok" : "is-error"}>
                          <span>{check.message}</span>
                        </li>,
                        ...recordingKitCheckDetailLines(check, t).map((line, detailIndex) => (
                          <li key={`${check.check}-detail-${detailIndex}`} className="is-error is-detail">
                            <span>{line}</span>
                          </li>
                        )),
                      ])}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="profile-verify">
            <div className="profile-kit-head">
              <div>
                <strong>{t.profileVerifyTitle}</strong>
                <span>{t.profileVerifyHelp}</span>
              </div>
              <button
                className="btn btn--inverted"
                type="button"
                onClick={() => void validateProfileTranscripts()}
                disabled={profileTranscriptStatus === "loading" || profileVerifyStatus === "loading"}
              >
                {profileTranscriptStatus === "loading" ? <Loader2 className="spin" size={14} /> : <ListChecks size={14} />}
                {profileTranscriptStatus === "loading" ? t.profileTranscriptValidating : t.profileTranscriptValidate}
              </button>
              <button
                className="btn btn--inverted"
                type="button"
                onClick={() => void verifyVoiceProfile()}
                disabled={profileVerifyStatus === "loading"}
              >
                {profileVerifyStatus === "loading" ? <Loader2 className="spin" size={14} /> : <ListChecks size={14} />}
                {profileVerifyStatus === "loading" ? t.profileVerifying : t.profileVerify}
              </button>
              <button
                className="btn btn--inverted"
                type="button"
                onClick={() => void auditVoiceCloneGoal()}
                disabled={goalAuditStatus === "loading"}
              >
                {goalAuditStatus === "loading" ? <Loader2 className="spin" size={14} /> : <ListChecks size={14} />}
                {goalAuditStatus === "loading" ? t.profileGoalAuditing : t.profileGoalAudit}
              </button>
            </div>
            {profileTranscriptStatus === "error" ? <p className="profile-kit-error">{t.profileTranscriptValidateFailed}</p> : null}
            {profileVerifyStatus === "error" ? <p className="profile-kit-error">{t.profileVerifyFailed}</p> : null}
            {goalAuditStatus === "error" ? <p className="profile-kit-error">{t.profileGoalAuditFailed}</p> : null}
            {goalAudit ? (
              <div className="profile-kit-result" role="status">
                <strong>{goalAuditMessage}</strong>
                <dl>
                  {goalAudit.firstBlocker ? (
                    <div>
                      <dt>{t.profileGoalAuditFirstBlocker}</dt>
                      <dd>
                        {goalAudit.firstBlocker.id}: {goalAudit.firstBlocker.message}
                        {goalAudit.firstBlocker.missingClips?.length ? (
                          <>
                            <br />
                            {goalAudit.firstBlocker.missingClips.join(", ")}
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  {goalAuditFocusedClip ? (
                    <div>
                      <dt>{t.profileGoalAuditFocusedClip}</dt>
                      <dd>
                        <pre className="profile-next-step-brief">
                          {[
                            goalAuditFocusedClip.id,
                            goalAuditFocusedClip.transcript,
                            goalAuditFocusedClip.recordCommand,
                          ]
                            .filter((line): line is string => Boolean(line?.trim()))
                            .join("\n")}
                        </pre>
                      </dd>
                    </div>
                  ) : null}
                  {goalAuditRecordingPreflight ? (
                    <div>
                      <dt>{t.profileGoalAuditRecordingPreflight}</dt>
                      <dd>
                        <pre className="profile-next-step-brief">
                          {[
                            `${goalAuditRecordingPreflight.status || "unknown"}: ${
                              goalAuditRecordingPreflight.message || ""
                            }`.trim(),
                            goalAuditRecordingPreflight.recorder
                              ? `Recorder: ${goalAuditRecordingPreflight.recorder.configured ? "yes" : "no"} (${
                                  goalAuditRecordingPreflight.recorder.source || "unknown"
                                })`
                              : "",
                            goalAuditRecordingPreflight.recordingGuidance
                              ? `Target: ${recordingGuidanceTargetLabel(goalAuditRecordingPreflight.recordingGuidance)}, ${
                                  goalAuditRecordingPreflight.recordingGuidance.minDurationSec
                                }-${goalAuditRecordingPreflight.recordingGuidance.maxDurationSec}s, >=${
                                  goalAuditRecordingPreflight.recordingGuidance.minActiveVoiceSec
                                }s active voice`
                              : "",
                          ]
                            .filter(Boolean)
                            .join("\n")}
                        </pre>
                      </dd>
                    </div>
                  ) : null}
                  {goalAudit.nextCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditNext}</dt>
                      <dd>{goalAudit.nextCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextBriefCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditBrief}</dt>
                      <dd>{goalAudit.nextBriefCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextOpenCueSheetCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditOpenCueSheet}</dt>
                      <dd>{goalAudit.nextOpenCueSheetCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextMicrophoneSmokeTestCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditMicrophoneSmoke}</dt>
                      <dd>{goalAudit.nextMicrophoneSmokeTestCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextNormalizeExternalRecordingsCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditNormalize}</dt>
                      <dd>{goalAudit.nextNormalizeExternalRecordingsCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextProductProofCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditProductProof}</dt>
                      <dd>{goalAudit.nextProductProofCommand}</dd>
                    </div>
                  ) : null}
                  {goalAuditProofAsr || goalAuditProofSpeaker ? (
                    <div>
                      <dt>{t.profileGoalAuditProofEnvironmentStatus}</dt>
                      <dd>
                        {goalAuditProofAsr ? (
                          <>
                            <span>
                              {auditBackendAvailable(goalAuditProofAsr)
                                ? t.profileProductProofAsrBackendReady(
                                    auditBackendString(goalAuditProofAsr, "requiredBackend") || "ASR",
                                  )
                                : t.profileProductProofAsrBackendMissing(
                                    auditBackendString(goalAuditProofAsr, "requiredBackend") || "ASR",
                                    auditBackendString(goalAuditProofAsr, "selectedAutoBackend") || "none",
                                  )}
                            </span>
                            {auditBackendString(goalAuditProofAsr, "reason") ? (
                              <small>{auditBackendString(goalAuditProofAsr, "reason")}</small>
                            ) : null}
                          </>
                        ) : null}
                        {goalAuditProofSpeaker ? (
                          <>
                            <span>
                              {auditBackendAvailable(goalAuditProofSpeaker)
                                ? t.profileProductProofBackendReady(
                                    auditBackendString(goalAuditProofSpeaker, "requiredBackend") || "speaker",
                                  )
                                : t.profileProductProofBackendMissing(
                                    auditBackendString(goalAuditProofSpeaker, "requiredBackend") || "speaker",
                                    auditBackendString(goalAuditProofSpeaker, "selectedAutoBackend") || "none",
                                  )}
                            </span>
                            {auditBackendString(goalAuditProofSpeaker, "reason") ? (
                              <small>{auditBackendString(goalAuditProofSpeaker, "reason")}</small>
                            ) : null}
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  {goalAudit.nextProofEnvironmentCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditProofEnvironment}</dt>
                      <dd>{goalAudit.nextProofEnvironmentCommand}</dd>
                    </div>
                  ) : null}
                  {goalAudit.nextLoraHandoffCommand ? (
                    <div>
                      <dt>{t.profileGoalAuditLoraHandoff}</dt>
                      <dd>{goalAudit.nextLoraHandoffCommand}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{t.profileGoalAuditStages}</dt>
                    <dd>{goalAudit.stages.map((stage) => `${stage.id}: ${stage.status}`).join(" / ")}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            {profileTranscriptValidation ? (
              <div className="profile-kit-result" role="status">
                <strong>{profileTranscriptValidationMessage}</strong>
                <dl>
                  <div>
                    <dt>{t.profileTranscriptValidationMeta(profileTranscriptValidation.backend)}</dt>
                    <dd>
                      CER max {profileTranscriptValidation.maxCer ?? "--"} / WER max {profileTranscriptValidation.maxWer ?? "--"}
                    </dd>
                  </div>
                  {profileTranscriptValidation.validationJson ? (
                    <div>
                      <dt>{t.profileTranscriptValidationReport}</dt>
                      <dd>{profileTranscriptValidation.validationJson}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
            {profileVerification ? (
              <div className="profile-kit-result" role="status">
                <strong>{profileVerificationMessage}</strong>
                <dl>
                  <div>
                    <dt>{t.profileVerify}</dt>
                    <dd>
                      {t.profileVerifySummary(
                        profileVerification.summary.selectedClips,
                        profileVerification.summary.eligibleClips,
                        profileVerification.summary.totalDurationSec,
                      )}
                    </dd>
                  </div>
                  {profileVerificationNextCommand ? (
                    <div>
                      <dt>{t.profileVerifyNext}</dt>
                      <dd>{profileVerificationNextCommand}</dd>
                    </div>
                  ) : null}
                  {profileVerificationNextReason ? (
                    <div>
                      <dt>{t.profileVerifyNextReason}</dt>
                      <dd>{profileVerificationNextReason}</dd>
                    </div>
                  ) : null}
                  {profileVerification.nextStep?.brief ? (
                    <div>
                      <dt>{t.profileVerifyBrief}</dt>
                      <dd><pre className="profile-next-step-brief">{profileVerification.nextStep.brief}</pre></dd>
                    </div>
                  ) : null}
                  {recordingPrescription?.status === "needs_recording" ? (
                    <div>
                      <dt>{t.profileRecordingPlan}</dt>
                      <dd>
                        {t.profileRecordingPlanMeta(
                          recordingPrescription.clipsNeeded,
                          recordingPrescription.durationSec.recommended,
                          recordingPrescription.durationSec.max,
                          recordingPrescription.durationSec.activeVoiceTarget,
                        )}
                        {recordingPrescriptionCoverage ? (
                          <>
                            <br />
                            {t.profileRecordingPlanCoverage(recordingPrescriptionCoverage)}
                          </>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {profileVerificationCueClips.length ? (
                  <section className="profile-kit-cue-sheet" aria-label={t.profileKitCueSheet}>
                    <header>
                      <strong>{t.profileKitCueSheet}</strong>
                      <span>{t.profileKitCueHelp}</span>
                    </header>
                    <ol className="profile-kit-cues">
                      {profileVerificationCueClips.map((clip, cueIndex) => (
                        (() => {
                          const command = clip.needsRerecord && clip.repairCommand ? clip.repairCommand : clip.recordCommand;
                          const targetDurationSec = preflightClipTargetDurationSec(clip);
                          return (
                            <li key={clip.id || `next-step-clip-${clip.index ?? cueIndex}`}>
                              <span className="profile-kit-cue-id">{clip.id || `clip-${clip.index}`}</span>
                              {targetDurationSec !== null ? (
                                <span className="profile-kit-cue-target">{t.profileKitCueTarget(targetDurationSec)}</span>
                              ) : null}
                              {clip.transcript ? <p>{clip.transcript}</p> : null}
                              {clip.pronunciationNotes?.length ? (
                                <ul className="profile-kit-cue-notes" aria-label={t.profileKitCueNotes}>
                                  {clip.pronunciationNotes.map((note) => (
                                    <li key={note}>{note}</li>
                                  ))}
                                </ul>
                              ) : null}
                              {clip.recordingIssues?.length ? (
                                <ul className="profile-kit-cue-notes" aria-label={t.profileKitCueNotes}>
                                  {clip.recordingIssues.map((issue) => (
                                    <li key={issue}>{issue}</li>
                                  ))}
                                </ul>
                              ) : null}
                              {command ? <code className="profile-kit-cue-command">{command}</code> : null}
                            </li>
                          );
                        })()
                      ))}
                    </ol>
                  </section>
                ) : null}
                {profileProofPlan ? (
                  <section className="profile-proof-plan" aria-label={t.profileProofPlan}>
                    <header>
                      <strong>{t.profileProofPlan}</strong>
                      <span>{t.profileProofHelp}</span>
                    </header>
                    <dl>
                      <div>
                        <dt>{t.profileProofCommand}</dt>
                        <dd>{profileProofPlan.recommendedCommand}</dd>
                      </div>
                      {profileProofPlan.productProofCommand ? (
                        <div>
                          <dt>{t.profileProductProofCommand}</dt>
                          <dd>{profileProofPlan.productProofCommand}</dd>
                        </div>
                      ) : null}
                      {profileProofPlan.productProofAsrBackend ? (
                        <div>
                          <dt>{t.profileProductProofAsrBackend}</dt>
                          <dd>
                            <span>
                              {profileProofPlan.productProofAsrBackend.available
                                ? t.profileProductProofAsrBackendReady(
                                    profileProofPlan.productProofAsrBackend.requiredBackend,
                                  )
                                : t.profileProductProofAsrBackendMissing(
                                    profileProofPlan.productProofAsrBackend.requiredBackend,
                                    profileProofPlan.productProofAsrBackend.selectedAutoBackend || "none",
                                  )}
                            </span>
                            <small>{profileProofPlan.productProofAsrBackend.reason}</small>
                            <small>{profileProofPlan.productProofAsrBackend.checkCommand}</small>
                          </dd>
                        </div>
                      ) : null}
                      {profileProofPlan.productProofSpeakerBackend ? (
                        <div>
                          <dt>{t.profileProductProofBackend}</dt>
                          <dd>
                            <span>
                              {profileProofPlan.productProofSpeakerBackend.available
                                ? t.profileProductProofBackendReady(
                                    profileProofPlan.productProofSpeakerBackend.requiredBackend,
                                  )
                                : t.profileProductProofBackendMissing(
                                    profileProofPlan.productProofSpeakerBackend.requiredBackend,
                                    profileProofPlan.productProofSpeakerBackend.selectedAutoBackend || "none",
                                  )}
                            </span>
                            <small>{profileProofPlan.productProofSpeakerBackend.reason}</small>
                            <small>{profileProofPlan.productProofSpeakerBackend.checkCommand}</small>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                    {profileProofArtifacts.length ? (
                      <div className="profile-proof-group">
                        <strong>{t.profileProofArtifacts}</strong>
                        <ul className="profile-proof-artifacts">
                          {profileProofArtifacts.map((artifact) => (
                            <li
                              key={artifact.id}
                              className={`is-${profileProofStatusClass(artifact.status)}`}
                              title={artifact.path || artifact.pathPattern || artifact.purpose}
                            >
                              <span>
                                <b>{profileProofArtifactLabel(artifact.id, locale)}</b>
                                <small>{artifact.path || artifact.pathPattern || artifact.purpose}</small>
                              </span>
                              <em>{profileProofStatusLabel(artifact.status, locale)}</em>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {profileProofGates.length ? (
                      <div className="profile-proof-group">
                        <strong>{t.profileProofGates}</strong>
                        <ol className="profile-proof-gates">
                          {profileProofGates.map((gate, gateIndex) => (
                            <li key={gate.id}>
                              <span>
                                {gateIndex + 1}. {profileProofGateLabel(gate.id, locale)}
                              </span>
                              <small>{profileProofBlockLabel(gate.blocks, locale)}</small>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                <ul className={`profile-kit-check is-${profileVerification.status}`}>
                  {profileVerification.checks.map((check) => (
                    <li key={check.check} className={check.ok ? "is-ok" : "is-error"}>
                      <span>{check.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {profileIsReady ? (
            <label className={`profile-use ${profileHardGateReady ? "" : "is-disabled"}`}>
              <input
                type="checkbox"
                checked={profileHardGateReady && useVoiceProfile}
                onChange={(event) => setUseVoiceProfile(event.currentTarget.checked)}
                disabled={!profileHardGateReady || profileVerifyStatus === "loading"}
              />
              <span>
                <strong>{t.profileUse}</strong>
                <small>{profileUseHelper}</small>
              </span>
            </label>
          ) : null}

          <dl className="profile-stats">
            <div>
              <dt>{t.profileEligible}</dt>
              <dd>{profileSummary?.eligibleClips ?? 0}</dd>
            </div>
            <div>
              <dt>{t.profileRejected}</dt>
              <dd>{profileSummary?.rejectedClips ?? 0}</dd>
            </div>
            <div>
              <dt>{t.profileRemaining(profileRemaining)}</dt>
              <dd>{profileRemaining}</dd>
            </div>
          </dl>

          {profileCoverageItems.length > 0 ? (
            <div className="profile-coverage">
              <strong>{t.profileCoverageTitle}</strong>
              <ul>
                {profileCoverageItems.map((item) => (
                  <li key={item.feature} className={item.missing ? "is-missing" : "is-covered"}>
                    <span>{profileCoverageLabel(item.feature, locale)}</span>
                    <b>{item.missing ? t.profileCoverageMissing : t.profileCoverageDone(item.count)}</b>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="profile-diagnostics">
            <div>
              <strong>{t.profileDiagnostics}</strong>
              {profileIssues.length > 0 ? (
                <ul>
                  {profileIssues.map((issue) => (
                    <li key={issue.reason}>
                      <span>{profileIssueLabel(issue.reason, locale)}</span>
                      <b>{issue.count}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t.profileNoDiagnostics}</p>
              )}
            </div>
            <div>
              <strong>{t.profileScriptMix}</strong>
              {profileScripts.length > 0 ? (
                <ul>
                  {profileScripts.map((item) => (
                    <li key={item.script}>
                      <span>{scriptLabel(item.script, locale)}</span>
                      <b>{item.count}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t.profileNoDiagnostics}</p>
              )}
            </div>
          </div>

          {profileRejectedExamples.length > 0 ? (
            <div className="profile-rejected">
              <strong>{t.profileRejectedExamples}</strong>
              <ul>
                {profileRejectedExamples.map((clip) => (
                  <li key={clip.sourceRunId}>
                    <span>{t.profileRejectedMeta(clip.grade, formatDuration(clip.durationSec))}</span>
                    <b>{profileRejectedReasonLabels(clip.reasons, locale)}</b>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="surface surface--cream history-surface" aria-labelledby="h-history">
          <div className="history-head">
            <div>
              <h2 id="h-history">
                <History size={18} aria-hidden /> {t.historyTitle}
              </h2>
              <p>{t.historyHelp}</p>
            </div>
            <button
              className="icon-button history-refresh"
              type="button"
              aria-label={t.historyRefresh}
              title={t.historyRefresh}
              onClick={() => void loadHistory()}
            >
              <RefreshCw className={historyStatus === "loading" ? "spin" : ""} size={14} />
            </button>
          </div>

          {historyStatus === "error" ? <p className="history-state">{t.historyFailed}</p> : null}

          {historyItems.length > 0 ? (
            <ol className="history-list" aria-label={t.historyTitle}>
              {historyItems.map((item) => (
                <li key={item.id} className="history-row">
                  <button className="history-main" type="button" onClick={() => activateHistoryItem(item)}>
                    <span className={`history-status is-${item.status.replace("_", "-")}`}>
                      {historyStatusLabel(item.status, t)}
                    </span>
                    <strong>{item.targetText}</strong>
                    <span>
                      {formatRunTime(item.createdAt, locale)}
                      {" · "}
                      {sourceKindLabel(item.sourceKind, t)}
                      {" · "}
                      {qualityMeta[item.quality].label}
                    </span>
                  </button>
                  <button
                    className="icon-button history-delete"
                    type="button"
                    aria-label={`${t.historyDelete}: ${item.targetText}`}
                    title={t.historyDelete}
                    onClick={() => void deleteHistoryItem(item.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ol>
          ) : historyStatus === "loading" ? (
            <p className="history-state">{t.historyLoading}</p>
          ) : (
            <p className="history-state">{t.historyEmpty}</p>
          )}
        </section>
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

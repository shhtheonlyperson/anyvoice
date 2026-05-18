"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Monitor, Moon, Sun } from "lucide-react";

type Locale = "zh-Hant" | "en";
type Theme = "system" | "light" | "dark";

const doc = {
  "zh-Hant": {
    brand: "AnyVoice",
    back: "← AnyVoice",
    kicker: "Product requirements · v1",
    title: "在獲得授權的前提下，用 VoxCPM2 複製一個聲音。",
    intro:
      "AnyVoice 用 Vercel 部署主控台 UI 與 API，真正的推論交給本機或 GPU 的 VoxCPM2 worker。網站把錄音、上傳、請求驗證與結果播放做到一打開就能用；模型邊界當作 UI 的一部分，不假裝 serverless 能跑大型 PyTorch。",
    goal: "Goal",
    goalText: "讓使用者用自己的錄音或上傳的音檔複製出一個聲音，再合成新的文字。",
    nonGoals: "Non-goals",
    nonGoalsList: [
      "不做冒充用途、不做隱藏式繞過授權、不做公共複製聲音庫。",
      "v1 不長期保留聲音。",
      "不承諾 VoxCPM2 在 serverless 上運作。",
    ],
    acceptance: "Acceptance criteria",
    acceptanceList: [
      "支援錄音與 mp3 / wav / m4a / 其他 ffmpeg 可讀音檔上傳。",
      "可輸入目標文字與選填語氣描述。",
      "可選填精準逐字稿啟用 VoxCPM2 ultimate cloning。",
      "送出前必須勾選授權，API 拒絕沒有授權的請求。",
      "VoxCPM2 worker 連上時，回傳可播放的音檔。",
      "Vercel 預覽要顯示 worker-missing 狀態與需要設定的 env。",
    ],
    modes: "Modes",
    modesList: [
      "Reference clone — 只把參考音傳成 reference_wav_path。",
      "Ultimate clone — 同一份參考音同時當 reference_wav_path 與 prompt_wav_path，再附上對應的精準 prompt_text。",
    ],
    runtime: "Runtime",
    runtimeList: [
      "Local Python bridge 用 voxcpm、soundfile、ffmpeg。",
      "Vercel 預設 ANYVOICE_STUB=1，需要時改接 ANYVOICE_WORKER_URL 指到 Mac Studio 或 GPU worker。",
      "ANYVOICE_WORKER_MODE=1 是 worker 模式的顯式開關；只有開啟時才會對 /api/runs/:jobId/audio 要 Bearer。",
    ],
    safety: "Safety",
    safetyList: [
      "送出前必須勾選授權。",
      "UI 清楚說明使用者必須擁有或取得這段聲音的授權。",
      "產出的音檔在下游介面標示為 AI 生成。",
    ],
  },
  en: {
    brand: "AnyVoice",
    back: "← AnyVoice",
    kicker: "Product requirements · v1",
    title: "Clone a permitted voice with VoxCPM2.",
    intro:
      "AnyVoice ships the studio UI and API on Vercel and routes real inference to a local or GPU VoxCPM2 worker. The site is useful immediately for recording, upload, request validation, and result playback. The inference boundary is part of the UI, not pretending serverless can host a large PyTorch model.",
    goal: "Goal",
    goalText: "Let a user clone a voice from their own recording or uploaded audio, then synthesize new text with VoxCPM2.",
    nonGoals: "Non-goals",
    nonGoalsList: [
      "No impersonation workflows, no hidden consent bypass, no public gallery of cloned voices.",
      "No long-term voice storage in v1.",
      "No serverless-only promise for VoxCPM2 inference.",
    ],
    acceptance: "Acceptance criteria",
    acceptanceList: [
      "Record or upload a voice reference (mp3, wav, m4a, ffmpeg-readable).",
      "Enter target text and optional style guidance.",
      "Provide an optional exact transcript for VoxCPM2 ultimate cloning.",
      "Require explicit consent before submission; the API rejects requests without it.",
      "Return playable synthesized audio when the VoxCPM2 worker is connected.",
      "Show a clear worker-missing state on Vercel preview with the env vars to flip.",
    ],
    modes: "Modes",
    modesList: [
      "Reference clone — pass the uploaded reference through reference_wav_path.",
      "Ultimate clone — pass the same reference as both reference_wav_path and prompt_wav_path, plus the exact transcript as prompt_text.",
    ],
    runtime: "Runtime",
    runtimeList: [
      "Local Python bridge uses voxcpm, soundfile, and ffmpeg.",
      "Vercel defaults to ANYVOICE_STUB=1; production inference moves behind ANYVOICE_WORKER_URL pointing at a Mac Studio or GPU worker.",
      "ANYVOICE_WORKER_MODE=1 is the explicit opt-in for worker mode; only then does /api/runs/:jobId/audio require Bearer auth.",
    ],
    safety: "Safety",
    safetyList: [
      "Consent checkbox is required before any clone request.",
      "UI copy states the user must own or have permission to use the voice.",
      "Generated output is labeled as AI-generated in downstream product surfaces.",
    ],
  },
} as const;

export default function PrdPage() {
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

  const t = doc[locale];

  return (
    <div className="doc-shell">
      <header className="app-bar" role="banner">
        <Link href="/" className="brand" aria-label="AnyVoice home">
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>{t.brand}</span>
        </Link>
        <div className="app-bar-right">
          <ThemeToggle theme={theme} onChange={setTheme} />
          <button
            className="locale-toggle"
            type="button"
            onClick={() => setLocale(locale === "zh-Hant" ? "en" : "zh-Hant")}
            aria-label="Toggle language"
          >
            {locale === "zh-Hant" ? "EN" : "繁中"}
          </button>
        </div>
      </header>

      <main className="doc">
        <Link href="/" className="doc-back">
          {t.back}
        </Link>
        <span className="kicker">{t.kicker}</span>
        <h1>{t.title}</h1>
        <p>{t.intro}</p>

        <h2>{t.goal}</h2>
        <p>{t.goalText}</p>

        <h2>{t.nonGoals}</h2>
        <ul>
          {t.nonGoalsList.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>{t.acceptance}</h2>
        <ul>
          {t.acceptanceList.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>{t.modes}</h2>
        <ul>
          {t.modesList.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>{t.runtime}</h2>
        <ul>
          {t.runtimeList.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>{t.safety}</h2>
        <ul>
          {t.safetyList.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (next: Theme) => void }) {
  const order: Theme[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";
  return (
    <button
      type="button"
      className="theme-cycle"
      onClick={() => onChange(next)}
      aria-label={`Theme: ${label}`}
      title={label}
    >
      <Icon size={14} />
    </button>
  );
}

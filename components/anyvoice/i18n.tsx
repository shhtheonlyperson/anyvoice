"use client";
/* i18n — Traditional Chinese (default) + English. Ported from the handoff
   `src/i18n.jsx`. `{var}` interpolation; falls back zh → en → key. */
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type Lang = "zh" | "en";

export const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    "brand.name": "AnyVoice",
    "brand.tagline": "個人聲音複製",

    "tab.build": "建立聲音",
    "tab.generate": "生成",
    "tab.audiobook": "有聲書",
    "topbar.help": "說明",
    "topbar.changeLanguage": "切換語言",
    "topbar.toggleTheme": "切換明暗",
    "topbar.expandRail": "展開側欄",
    "topbar.collapseRail": "收合側欄",

    "rail.voices": "聲音",
    "rail.newVoice": "新建聲音",
    "rail.library": "收藏",
    "rail.generations": "已生成",
    "rail.audiobooks": "有聲書",
    "rail.datasets": "資料集",
    "rail.plan": "研究使用 · 個人",
    "rail.user": "Glory",

    "build.eyebrow": "聲音檔案",
    "build.title.empty": "建立你的數位聲音",
    "build.title.ready": "你的聲音已準備好",
    "build.lede.empty": "在安靜的環境中以自然語速錄製句子。你的聲音不會離開這個裝置。",
    "build.placeholder.title": "建立聲音（即將推出完整錄音流程）",
    "build.placeholder.sub": "完整的 24 句逐句錄音與評分流程將於下一階段提供。目前可使用既有的錄音與匯入功能來建立聲音。",

    "gen.eyebrow": "數位聲音複製",
    "gen.title": "用你的聲音說出任何內容",
    "gen.lede": "輸入任何文字，以你的聲音生成。可微調語速、溫度與停頓 — 細微的差別，但很有感。",
    "gen.placeholder": "輸入或貼上想讓這個聲音說的內容…",
    "gen.dial.pace": "語速",
    "gen.dial.warmth": "溫度",
    "gen.dial.breaths": "停頓",
    "gen.dial.uiOnly": "目前僅為介面預覽，尚未影響生成結果。",
    "gen.pace.slow": "慢",
    "gen.pace.natural": "自然",
    "gen.pace.brisk": "快",
    "gen.warmth.cool": "冷",
    "gen.warmth.even": "中",
    "gen.warmth.warm": "暖",
    "gen.charCount": "{n} 字 · 約 {s} 秒",
    "gen.btn.generate": "生成",
    "gen.btn.generating": "生成中…",
    "gen.btn.wav": "WAV",
    "gen.btn.regenerate": "重新生成",
    "gen.result": "結果",
    "gen.subtab.recent": "最近",
    "gen.subtab.favorites": "收藏",
    "gen.subtab.shared": "已分享",
    "gen.empty.title": "還沒有生成紀錄",
    "gen.empty.sub": "在上方輸入一段文字 — 紀錄會出現在這裡。",
    "gen.needVoice": "請先選擇一個已就緒的聲音。",
    "gen.scriptBlocked": "偵測到簡體或混用字。請改用繁體中文。",
    "gen.error": "生成失敗，請再試一次。",
    "gen.toast.copied": "已複製分享連結",
    "gen.toast.textCopied": "已將文字帶到輸入框",
    "gen.toast.download": "正在下載 WAV…",
    "gen.toast.deferred": "此功能即將推出",
    "gen.noVoiceReady": "尚無已就緒的聲音。先建立一個聲音再回來生成。",
    "gen.picker.noneReady": "尚無可用聲音",

    "ab.locked.title": "先建立一個聲音",
    "ab.locked.sub": "有聲書需要一個已就緒的聲音。請先在「建立聲音」分頁完成一個聲音。",
  },

  en: {
    "brand.name": "AnyVoice",
    "brand.tagline": "Personal voice cloning",

    "tab.build": "Build voice",
    "tab.generate": "Generate",
    "tab.audiobook": "Audiobook",
    "topbar.help": "Help",
    "topbar.changeLanguage": "Change language",
    "topbar.toggleTheme": "Toggle theme",
    "topbar.expandRail": "Expand rail",
    "topbar.collapseRail": "Collapse rail",

    "rail.voices": "Voices",
    "rail.newVoice": "New voice",
    "rail.library": "Library",
    "rail.generations": "Generations",
    "rail.audiobooks": "Audiobooks",
    "rail.datasets": "Datasets",
    "rail.plan": "Research · Personal use",
    "rail.user": "Glory",

    "build.eyebrow": "Voice profile",
    "build.title.empty": "Build your digital voice",
    "build.title.ready": "Your voice is ready",
    "build.lede.empty": "Record guided lines in a quiet room, at your natural pace. Your voice never leaves this device.",
    "build.placeholder.title": "Build a voice (full recorder coming soon)",
    "build.placeholder.sub": "The full 24-line record-and-grade flow ships in the next phase. For now, use the existing recording and import tools to build a voice.",

    "gen.eyebrow": "Digital voice clone",
    "gen.title": "Make your voice say anything",
    "gen.lede": "Type any text. Generate it in your voice. Adjust pace, warmth, and breathing — the changes are subtle but they matter.",
    "gen.placeholder": "Type or paste what you want this voice to say…",
    "gen.dial.pace": "Pace",
    "gen.dial.warmth": "Warmth",
    "gen.dial.breaths": "Breaths",
    "gen.dial.uiOnly": "Preview only for now — does not yet affect the generated audio.",
    "gen.pace.slow": "slow",
    "gen.pace.natural": "natural",
    "gen.pace.brisk": "brisk",
    "gen.warmth.cool": "cool",
    "gen.warmth.even": "even",
    "gen.warmth.warm": "warm",
    "gen.charCount": "{n} chars · ~{s}s",
    "gen.btn.generate": "Generate",
    "gen.btn.generating": "Generating…",
    "gen.btn.wav": "WAV",
    "gen.btn.regenerate": "Regenerate",
    "gen.result": "Result",
    "gen.subtab.recent": "Recent",
    "gen.subtab.favorites": "Favorites",
    "gen.subtab.shared": "Shared",
    "gen.empty.title": "No recent generations",
    "gen.empty.sub": "Try a line above — your history will live here.",
    "gen.needVoice": "Pick a ready voice first.",
    "gen.scriptBlocked": "Simplified or mixed Chinese detected. Use Traditional Chinese.",
    "gen.error": "Generation failed. Please try again.",
    "gen.toast.copied": "Share link copied",
    "gen.toast.textCopied": "Text copied to composer",
    "gen.toast.download": "Downloading WAV…",
    "gen.toast.deferred": "Coming soon",
    "gen.noVoiceReady": "No ready voice yet. Build a voice, then come back to generate.",
    "gen.picker.noneReady": "No ready voices",

    "ab.locked.title": "Build a voice first",
    "ab.locked.sub": "Audiobooks need a ready voice. Finish a voice in the Build tab first.",
  },
};

type Vars = Record<string, string | number>;
export type Translate = (key: string, vars?: Vars) => string;

const I18nContext = createContext<{ lang: Lang; t: Translate }>({ lang: "zh", t: (k) => k });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => {
    const t: Translate = (key, vars) => {
      const dict = I18N[lang] || I18N.en;
      const raw = dict[key] ?? I18N.en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
    };
    return { lang, t };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}
export function useLang(): Lang {
  return useContext(I18nContext).lang;
}

/** Design status enum used across the rail + tabs. */
export type VoiceStatus = "empty" | "building" | "importing" | "ready";

export interface VoiceView {
  id: string;
  name: string;
  status: VoiceStatus;
  hash: number;
  /** Backend-derived line/clip count used in the subtitle. */
  clipCount: number;
  source?: "yt" | "upload" | "record";
}

/** Voice subtitle helper — "已完成" / "0 / 24 句" etc., language-aware. */
export function voiceSubtitle(v: VoiceView, lang: Lang): string {
  if (v.status === "ready") return lang === "zh" ? "已完成" : "ready";
  if (v.status === "importing") return lang === "zh" ? "匯入中…" : "importing…";
  if (v.status === "empty") return lang === "zh" ? "尚未錄音" : "no clips yet";
  const n = v.clipCount;
  return lang === "zh" ? `${n} 段素材` : `${n} clip${n === 1 ? "" : "s"}`;
}

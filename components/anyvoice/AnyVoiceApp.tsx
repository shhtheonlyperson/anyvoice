"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookReader } from "@/components/BookReader";
import "./anyvoice.css";
import { I18nProvider, useT, type Lang, type VoiceStatus, type VoiceView } from "./i18n";
import { WorkspaceShell } from "./WorkspaceShell";
import type { Tab } from "./Topbar";
import { GenerateTab } from "./GenerateTab";
import { BuildTab } from "./BuildTab";
import { CreateVoiceModal } from "./CreateVoiceModal";
import { fetchProfiles, type ProfileListItem } from "./lib/anyvoice-client";

/** Backend two-status model → design status enum. */
function toDesignStatus(p: ProfileListItem): VoiceStatus {
  if (p.clipCount === 0) return "empty";
  if (p.status === "ready" || p.meetsRequirements) return "ready";
  return "building";
}

function toVoiceView(p: ProfileListItem): VoiceView {
  return {
    id: p.id,
    name: p.displayName,
    status: toDesignStatus(p),
    hash: p.hash,
    clipCount: p.clipCount,
    source: "record",
  };
}

/** Inner shell — assumes the i18n provider is mounted above it. */
function Workspace({
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
}: {
  lang: Lang;
  onToggleLang: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const t = useT();
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [activeVoiceId, setActiveVoiceId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("generate");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const voices = useMemo(() => profiles.map(toVoiceView), [profiles]);

  const refresh = useCallback(async () => {
    const list = await fetchProfiles();
    setProfiles(list);
    setActiveVoiceId((cur) => cur ?? list.find((p) => p.usable)?.id ?? list[0]?.id ?? null);
  }, []);

  // Refresh, then force-select a specific profile (used after create/delete).
  const refreshAndSelect = useCallback(async (id: string | null) => {
    const list = await fetchProfiles();
    setProfiles(list);
    setActiveVoiceId(id && list.some((p) => p.id === id) ? id : (list.find((p) => p.usable)?.id ?? list[0]?.id ?? null));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load on mount
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const activeProfile = profiles.find((p) => p.id === activeVoiceId);
  const localeForLegacy = lang === "zh" ? "zh-Hant" : "en";

  return (
    <WorkspaceShell
      voices={voices}
      activeVoiceId={activeVoiceId}
      onSelectVoice={setActiveVoiceId}
      onCreateVoice={() => setShowCreate(true)}
      activeTab={activeTab}
      onChangeTab={setActiveTab}
      lang={lang}
      onToggleLang={onToggleLang}
      theme={theme}
      onToggleTheme={onToggleTheme}
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
    >
      {activeTab === "generate" && (
        <GenerateTab voices={voices} activeVoiceId={activeVoiceId} onToast={setToast} />
      )}

      {activeTab === "build" && (
        <BuildTab
          activeProfile={activeProfile}
          onRefresh={() => void refresh()}
          onChangeTab={(tab) => setActiveTab(tab)}
          onDeleted={() => void refreshAndSelect(null)}
        />
      )}

      {activeTab === "audiobook" && (
        <div className="legacy-tab-slot">
          {activeProfile?.studioGrade ? (
            <BookReader
              locale={localeForLegacy}
              profileReady={Boolean(activeProfile?.studioGrade)}
              profileId={activeProfile.id}
            />
          ) : (
            <div className="empty-zone">
              <h3>{t("ab.locked.title")}</h3>
              <p>{t("ab.locked.sub")}</p>
            </div>
          )}
        </div>
      )}

      {showCreate && (
        <CreateVoiceModal
          onClose={() => setShowCreate(false)}
          onRecordPath={(id) => {
            setShowCreate(false);
            void refreshAndSelect(id);
            setActiveTab("build");
          }}
          onCreated={(id) => {
            setShowCreate(false);
            void refreshAndSelect(id);
            setActiveTab("build");
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </WorkspaceShell>
  );
}

export function AnyVoiceApp() {
  // zh-Hant default per project defaults; light/dark follows system, overridable.
  const [lang, setLang] = useState<Lang>("zh");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Hydrate persisted prefs after mount (localStorage unavailable during SSR).
  useEffect(() => {
    try {
      /* eslint-disable react-hooks/set-state-in-effect -- post-mount hydration of persisted prefs */
      const storedLocale = window.localStorage.getItem("anyvoice:locale");
      if (storedLocale === "en") setLang("en");
      else if (storedLocale === "zh-Hant") setLang("zh");
      const storedTheme = window.localStorage.getItem("anyvoice:theme");
      if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
      else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) setTheme("dark");
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    const locale = lang === "zh" ? "zh-Hant" : "en";
    try {
      window.localStorage.setItem("anyvoice:locale", locale);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.documentElement.dataset.locale = locale;
    }
  }, [lang]);

  useEffect(() => {
    try {
      window.localStorage.setItem("anyvoice:theme", theme);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="av-root">
      <I18nProvider lang={lang}>
        <Workspace
          lang={lang}
          onToggleLang={() => setLang((l) => (l === "zh" ? "en" : "zh"))}
          theme={theme}
          onToggleTheme={() => setTheme((th) => (th === "light" ? "dark" : "light"))}
        />
      </I18nProvider>
    </div>
  );
}

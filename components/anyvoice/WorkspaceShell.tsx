"use client";
import type { ReactNode } from "react";
import { Topbar, type Tab } from "./Topbar";
import { VoiceRail } from "./VoiceRail";
import type { Lang, VoiceView } from "./i18n";

export function WorkspaceShell({
  voices,
  activeVoiceId,
  speakingVoiceId,
  onSelectVoice,
  onCreateVoice,
  activeTab,
  onChangeTab,
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
  railCollapsed,
  onToggleRail,
  children,
}: {
  voices: VoiceView[];
  activeVoiceId: string | null;
  speakingVoiceId?: string | null;
  onSelectVoice: (id: string) => void;
  onCreateVoice: () => void;
  activeTab: Tab;
  onChangeTab: (t: Tab) => void;
  lang: Lang;
  onToggleLang: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`workspace ${railCollapsed ? "rail-collapsed" : ""}`}>
      <VoiceRail
        voices={voices}
        activeVoiceId={activeVoiceId}
        speakingVoiceId={speakingVoiceId}
        onSelectVoice={onSelectVoice}
        onCreateVoice={onCreateVoice}
        lang={lang}
        railCollapsed={railCollapsed}
        onToggleRail={onToggleRail}
      />
      <main className="workspace-main">
        <Topbar
          activeTab={activeTab}
          onChangeTab={onChangeTab}
          lang={lang}
          onToggleLang={onToggleLang}
          theme={theme}
          onToggleTheme={onToggleTheme}
          railCollapsed={railCollapsed}
          onToggleRail={onToggleRail}
        />
        <div className="page">{children}</div>
      </main>
    </div>
  );
}

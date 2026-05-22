"use client";
import { useT } from "./i18n";
import type { Lang } from "./i18n";
import { IcBook, IcGlobe, IcInfo, IcMic, IcMoon, IcPanelLeft, IcSparkles, IcSun } from "./icons";

export type Tab = "build" | "generate" | "audiobook";

export function Topbar({
  activeTab,
  onChangeTab,
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
  railCollapsed,
  onToggleRail,
}: {
  activeTab: Tab;
  onChangeTab: (t: Tab) => void;
  lang: Lang;
  onToggleLang: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
}) {
  const t = useT();
  return (
    <header className="topbar">
      <div className="row gap-12">
        {railCollapsed && (
          <button className="icon-btn" onClick={onToggleRail} title={t("topbar.expandRail")}>
            <IcPanelLeft size={16} />
          </button>
        )}
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "build"}
            className={`tab ${activeTab === "build" ? "active" : ""}`}
            onClick={() => onChangeTab("build")}
          >
            <IcMic size={14} /> {t("tab.build")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "generate"}
            className={`tab ${activeTab === "generate" ? "active" : ""}`}
            onClick={() => onChangeTab("generate")}
          >
            <IcSparkles size={14} /> {t("tab.generate")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "audiobook"}
            className={`tab ${activeTab === "audiobook" ? "active" : ""}`}
            onClick={() => onChangeTab("audiobook")}
          >
            <IcBook size={14} /> {t("tab.audiobook")}
          </button>
        </div>
      </div>
      <div className="topbar-right">
        <button className="lang-toggle" onClick={onToggleLang} title={t("topbar.changeLanguage")}>
          <IcGlobe size={14} />
          <span>{lang === "zh" ? "中" : "EN"}</span>
        </button>
        <button className="icon-btn" onClick={onToggleTheme} title={t("topbar.toggleTheme")}>
          {theme === "dark" ? <IcSun size={16} /> : <IcMoon size={16} />}
        </button>
        <button className="icon-btn" title={t("topbar.help")}>
          <IcInfo size={16} />
        </button>
      </div>
    </header>
  );
}

"use client";
import { useT, voiceSubtitle, type Lang, type VoiceView } from "./i18n";
import { VoiceMark } from "./VoiceMark";
import { IcChevron, IcHeadphones, IcLayers, IcLibrary, IcPanelLeft, IcPlus, IcSettings, IcWave, IcYoutube, SpikeIcon } from "./icons";

/** Map the design status to the rail status-dot class (importing → building). */
function dotClass(status: VoiceView["status"]): string {
  if (status === "ready") return "ready";
  if (status === "empty") return "empty";
  return "building";
}

export function VoiceRail({
  voices,
  activeVoiceId,
  speakingVoiceId,
  onSelectVoice,
  onCreateVoice,
  lang,
  railCollapsed,
  onToggleRail,
}: {
  voices: VoiceView[];
  activeVoiceId: string | null;
  speakingVoiceId?: string | null;
  onSelectVoice: (id: string) => void;
  onCreateVoice: () => void;
  lang: Lang;
  railCollapsed: boolean;
  onToggleRail: () => void;
}) {
  const t = useT();
  return (
    <aside className="rail">
      <div className="rail-head">
        {!railCollapsed ? (
          <>
            <div className="rail-brand">
              <SpikeIcon size={18} />
              <span>{t("brand.name")}</span>
            </div>
            <button className="rail-collapse" onClick={onToggleRail} title={t("topbar.collapseRail")}>
              <IcPanelLeft size={16} />
            </button>
          </>
        ) : (
          <SpikeIcon size={20} style={{ color: "var(--color-primary)", margin: "0 auto" }} />
        )}
      </div>

      {!railCollapsed ? (
        <>
          <div className="rail-section">
            <span className="rail-section-label">{t("rail.voices")}</span>
            <button className="rail-section-action" onClick={onCreateVoice} title={t("rail.newVoice")}>
              <IcPlus size={14} />
            </button>
          </div>
          <div className="voice-list">
            {voices.map((v) => (
              <button
                key={v.id}
                className={`voice-item ${v.id === activeVoiceId ? "active" : ""} ${v.id === speakingVoiceId ? "speaking" : ""}`}
                onClick={() => onSelectVoice(v.id)}
              >
                <div className="vm-wrap">
                  <VoiceMark hash={v.hash} status={v.status} size={32} dim={v.status === "empty"} />
                  <span className={`vm-status ${dotClass(v.status)}`} />
                </div>
                <div className="voice-meta">
                  <div className="voice-name">{v.name}</div>
                  <div className="voice-sub">{voiceSubtitle(v, lang)}</div>
                </div>
                {v.source === "yt" && (
                  <IcYoutube size={12} style={{ color: "var(--color-muted-soft)", flexShrink: 0 }} />
                )}
                <IcWave size={14} className="vm-speaking" />
              </button>
            ))}
          </div>

          <div className="rail-section" style={{ marginTop: 16 }}>
            <span className="rail-section-label">{t("rail.library")}</span>
          </div>
          <div className="rail-nav">
            <button className="rail-link" type="button">
              <IcLibrary size={16} /> {t("rail.generations")}
            </button>
            <button className="rail-link" type="button">
              <IcHeadphones size={16} /> {t("rail.audiobooks")}
            </button>
            <button className="rail-link" type="button">
              <IcLayers size={16} /> {t("rail.datasets")}
            </button>
          </div>

          <div className="rail-foot">
            <div className="avatar">G</div>
            <div className="who">
              <div className="name">{t("rail.user")}</div>
              <div className="plan">{t("rail.plan")}</div>
            </div>
            <button className="icon-btn" title="Settings">
              <IcSettings size={16} />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="voice-list" style={{ padding: "6px 14px" }}>
            {voices.map((v) => (
              <button
                key={v.id}
                className={`voice-item ${v.id === activeVoiceId ? "active" : ""}`}
                onClick={() => onSelectVoice(v.id)}
                title={v.name}
                style={{ padding: 8, justifyContent: "center" }}
              >
                <div className="vm-wrap">
                  <VoiceMark hash={v.hash} status={v.status} size={32} dim={v.status === "empty"} />
                  <span className={`vm-status ${dotClass(v.status)}`} />
                </div>
              </button>
            ))}
            <button
              className="voice-item"
              onClick={onCreateVoice}
              title={t("rail.newVoice")}
              style={{ padding: 8, justifyContent: "center" }}
            >
              <div
                className="vm-wrap"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "var(--color-surface-card)",
                  color: "var(--color-muted)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IcPlus size={16} />
              </div>
            </button>
          </div>
          <button
            className="rail-collapse"
            onClick={onToggleRail}
            style={{ margin: "auto auto 14px" }}
            title={t("topbar.expandRail")}
          >
            <IcChevron size={16} />
          </button>
        </>
      )}
    </aside>
  );
}

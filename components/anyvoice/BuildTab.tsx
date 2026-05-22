"use client";
/* Build voice — the handoff's screen #1. Adaptive page driven by the active
 * voice's REAL summary (from GET /api/voice-profile/profiles → clipCount /
 * usable / studioGrade), mapped to the design states:
 *
 *   empty      clipCount === 0           cream card + Start recording + 3 options
 *   reviewing  usable, not studioGrade   cream card + progress donut + Continue
 *   ready      studioGrade               coral hero + Start generating + Listen back
 *   recording  user clicked a record CTA hands off to the existing recorder
 *
 * DEFERRED TO P2 (honest render, no faking): the handoff's bespoke 24-line
 * in-browser record-and-grade loop with phoneme coverage is a backend gap (the
 * backend has no 24-line scripted-coverage model). Rather than fake that loop,
 * the recording state REUSES the existing, working recorder/enrollment kit in
 * <VoiceCloneStudio>, which actually captures audio and enrolls clips into the
 * active profile via /api/voice-profile/enroll. When clips are added the
 * summary refreshes and the state advances to reviewing/ready for real.
 */
import { useState } from "react";
import { VoiceCloneStudio } from "@/components/VoiceCloneStudio";
import { useLang, useT, type Lang } from "./i18n";
import type { ProfileListItem } from "./lib/anyvoice-client";
import { deleteProfile, renameProfile } from "./lib/anyvoice-client";
import { IcCheck, IcChevron, IcEdit, IcMic, IcTrash, IcUpload, IcYoutube } from "./icons";
import { Donut } from "./waveforms";

type BuildState = "empty" | "reviewing" | "ready" | "recording";

/** Map the real summary to the design state. */
function deriveState(p: ProfileListItem | undefined): Exclude<BuildState, "recording"> {
  if (!p || p.clipCount === 0) return "empty";
  if (p.studioGrade) return "ready";
  return "reviewing";
}

// Target clip count for the reviewing donut. The backend's studio-grade bar is
// the real gate; this is a visual "almost there" target only.
const REVIEW_TARGET = 5;

function titleKey(state: BuildState): string {
  if (state === "empty") return "build.title.empty";
  if (state === "ready") return "build.title.ready";
  if (state === "recording") return "build.recording.title";
  return "build.title.reviewing";
}
function ledeKey(state: BuildState): string {
  if (state === "empty") return "build.lede.empty";
  if (state === "ready") return "build.lede.ready";
  if (state === "recording") return "build.recording.sub";
  return "build.lede.reviewing";
}

export function BuildTab({
  activeProfile,
  onRefresh,
  onChangeTab,
  onDeleted,
}: {
  activeProfile: ProfileListItem | undefined;
  onRefresh: () => void;
  onChangeTab: (t: "generate") => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const lang: Lang = useLang();
  const [recording, setRecording] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const derived = deriveState(activeProfile);
  const state: BuildState = recording ? "recording" : derived;
  const clipCount = activeProfile?.clipCount ?? 0;

  function startRename() {
    setDraft(activeProfile?.displayName ?? "");
    setRenaming(true);
  }
  function commitRename() {
    const name = draft.trim();
    setRenaming(false);
    if (!activeProfile || !name || name === activeProfile.displayName) return;
    void (async () => {
      await renameProfile(activeProfile.id, name);
      onRefresh();
    })();
  }
  function doDelete() {
    if (!activeProfile) return;
    if (typeof window !== "undefined" && !window.confirm(t("build.action.deleteConfirm"))) return;
    void (async () => {
      await deleteProfile(activeProfile.id);
      onDeleted();
    })();
  }

  // Recording state: reuse the existing working recorder/enrollment kit. When
  // the user returns, refresh so newly-enrolled clips re-derive the state.
  if (state === "recording") {
    return (
      <div className="page-inner">
        <div className="row between" style={{ alignItems: "center", marginBottom: 16 }}>
          <div>
            <div className="eyebrow">{t("build.eyebrow")}</div>
            <h1 className="page-title" style={{ marginBottom: 8 }}>
              {t(titleKey("recording"))}
            </h1>
            <p className="page-lede">{t(ledeKey("recording"))}</p>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            type="button"
            onClick={() => {
              setRecording(false);
              onRefresh();
            }}
          >
            {t("build.recording.back")}
          </button>
        </div>
        {/* Existing working recorder + enrollment + YouTube import. It manages
            its own active profile (persisted in localStorage). */}
        <div className="legacy-tab-slot">
          <VoiceCloneStudio />
        </div>
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="eyebrow">{t("build.eyebrow")}</div>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        {renaming ? (
          <input
            className="input"
            style={{ maxWidth: 420, fontSize: 28 }}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            {t(titleKey(state))}
          </h1>
        )}
        {activeProfile && (
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            <button className="btn btn--ghost btn--sm" type="button" onClick={startRename}>
              <IcEdit size={14} />
              {t("build.action.rename")}
            </button>
            {/* Export stays hidden — there is no export endpoint. */}
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              style={{ color: "var(--color-error)" }}
              onClick={doDelete}
            >
              <IcTrash size={14} />
              {t("build.action.delete")}
            </button>
          </div>
        )}
      </div>
      <p className="page-lede" style={{ marginTop: 16 }}>
        {t(ledeKey(state))}
      </p>

      <div className="mt-32">
        {state === "empty" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="build-status-title">
                {t("build.status.empty.title", { name: activeProfile?.displayName ?? "" })}
              </div>
              <div className="build-status-sub">{t("build.status.empty.sub")}</div>
            </div>
            <div className="build-cta">
              <button className="btn btn--primary btn--lg" type="button" onClick={() => setRecording(true)}>
                <IcMic size={16} />
                {t("build.status.empty.start")}
              </button>
            </div>
          </div>
        )}

        {state === "reviewing" && (
          <div className="build-status">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={Math.min(1, clipCount / REVIEW_TARGET)}
                  size={64}
                  stroke={6}
                  color="var(--color-ink)"
                  track="var(--color-hairline)"
                  label={`${clipCount}`}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">{t("build.status.reviewing.title", { n: clipCount })}</div>
                  <div className="build-status-sub">{t("build.status.reviewing.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button className="btn btn--secondary" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.reviewing.pause")}
              </button>
              <button className="btn btn--primary btn--lg" type="button" onClick={() => setRecording(true)}>
                <IcMic size={16} />
                {t("build.status.reviewing.continue")}
              </button>
            </div>
          </div>
        )}

        {state === "ready" && (
          <div className="build-status ready">
            <div className="build-status-content">
              <div className="coverage-meta">
                <Donut
                  value={1}
                  size={64}
                  stroke={6}
                  color="#fff"
                  track="rgba(255,255,255,0.25)"
                  label={<IcCheck size={20} style={{ color: "#fff" }} />}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="build-status-title">{t("build.status.ready.title")}</div>
                  <div className="build-status-sub">{t("build.status.ready.sub")}</div>
                </div>
              </div>
            </div>
            <div className="build-cta">
              <button
                className="btn btn--ghost"
                style={{ color: "#fff" }}
                type="button"
                onClick={() => onChangeTab("generate")}
              >
                {t("build.status.ready.listen")}
              </button>
              <button className="btn btn--secondary btn--lg" type="button" onClick={() => onChangeTab("generate")}>
                {t("build.status.ready.generate")}
                <IcChevron size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {state === "empty" && (
        <div className="empty-zone mt-48">
          <div className="ill">
            <IcMic size={24} />
          </div>
          <h3>{t("build.empty.title")}</h3>
          <p>{t("build.empty.sub")}</p>
          <div className="row gap-12 mt-8">
            <button className="btn btn--primary" type="button" onClick={() => setRecording(true)}>
              <IcMic size={14} />
              {t("build.empty.record")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setRecording(true)}>
              <IcYoutube size={14} />
              {t("build.empty.youtube")}
            </button>
            <button className="btn btn--secondary" type="button" onClick={() => setRecording(true)}>
              <IcUpload size={14} />
              {t("build.empty.upload")}
            </button>
          </div>
        </div>
      )}

      {(state === "reviewing" || state === "ready") && (
        <div className="mt-32">
          <span className="player-eyebrow" style={{ color: "var(--color-muted)" }}>
            {t("build.lines.usable", { n: clipCount })}
          </span>
        </div>
      )}
      <span aria-hidden style={{ display: "none" }}>
        {lang}
      </span>
    </div>
  );
}

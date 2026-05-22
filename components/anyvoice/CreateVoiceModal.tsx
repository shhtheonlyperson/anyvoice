"use client";
/* Create-voice modal — opened from the rail "+". Three real paths:
 *
 *  - Record: POST /api/voice-profile/profiles to create an empty named voice,
 *    then hand off to the Build tab in recording mode (the existing recorder).
 *  - Upload: real <input type=file> + a REQUIRED typed transcript + consent,
 *    POSTed to /api/voice-profile/enroll. Build is gated until file + transcript
 *    + consent are present — never a dead button.
 *  - YouTube: URL + amber playground warning + REQUIRED consent checkbox,
 *    POSTed to /api/voice-profile/enroll/youtube. Build gated until URL + consent.
 *
 * YT/upload first create an empty profile, then enroll into it. The importing
 * state is bound to the REAL request lifecycle (the fetch promise) — no fake
 * 4.2s timer. On success we refresh the rail and select the new voice.
 */
import { useState } from "react";
import { useT } from "./i18n";
import {
  createProfile,
  enrollFromUpload,
  enrollFromYoutube,
} from "./lib/anyvoice-client";
import { IcChevronLeft, IcDownload, IcInfo, IcMic, IcUpload, IcX, IcYoutube, SpikeIcon } from "./icons";
import { LiveWaveform } from "./waveforms";

type Mode = "record" | "yt" | "upload";

export function CreateVoiceModal({
  onClose,
  onRecordPath,
  onCreated,
}: {
  onClose: () => void;
  /** Record path: created an empty profile, hand off to the Build/record flow. */
  onRecordPath: (profileId: string) => void;
  /** YT/upload path resolved: refresh the rail and select the new voice. */
  onCreated: (profileId: string) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const ytStart = Number((url.match(/[&?]t=(\d+)/) || [])[1] || 0);

  function reset() {
    setMode(null);
    setName("");
    setUrl("");
    setFile(null);
    setTranscript("");
    setConsent(false);
    setError("");
  }

  function startRecord() {
    if (busy) return;
    setBusy(true);
    setError("");
    void (async () => {
      const created = await createProfile(name.trim() || (t("create.opt.record.title")));
      setBusy(false);
      if (!created) {
        setError(t("create.error"));
        return;
      }
      onRecordPath(created.id);
    })();
  }

  function startYoutube() {
    if (busy || !url.trim() || !consent) return;
    setBusy(true);
    setError("");
    void (async () => {
      const created = await createProfile(name.trim() || "YouTube");
      if (!created) {
        setBusy(false);
        setError(t("create.error"));
        return;
      }
      const res = await enrollFromYoutube({ url: url.trim(), profileId: created.id });
      setBusy(false);
      if (!res.ok) {
        setError(res.code === "no_captions" ? t("create.error.noCaptions") : res.message || t("create.error"));
        return;
      }
      onCreated(created.id);
    })();
  }

  function startUpload() {
    if (busy || !file || !transcript.trim() || !consent) return;
    setBusy(true);
    setError("");
    void (async () => {
      const created = await createProfile(name.trim() || file.name.replace(/\.[^.]+$/, ""));
      if (!created) {
        setBusy(false);
        setError(t("create.error"));
        return;
      }
      const res = await enrollFromUpload({ file, transcript: transcript.trim(), profileId: created.id });
      setBusy(false);
      if (!res.ok) {
        setError(res.message || t("create.error"));
        return;
      }
      onCreated(created.id);
    })();
  }

  // Importing state — bound to the in-flight request (busy) for YT/upload.
  if (busy && (mode === "yt" || mode === "upload")) {
    return (
      <div className="first-run" onClick={onClose}>
        <div className="first-run-card" style={{ maxWidth: 560, padding: 36 }} onClick={(e) => e.stopPropagation()}>
          <div className="eyebrow" style={{ color: "var(--color-primary)" }}>
            {mode === "yt" ? (
              <>
                <IcYoutube size={14} style={{ verticalAlign: "middle" }} /> YouTube
              </>
            ) : (
              <>
                <IcUpload size={14} style={{ verticalAlign: "middle" }} /> Upload
              </>
            )}
          </div>
          <h2>{t("create.importing.title")}</h2>
          <p className="page-lede" style={{ fontSize: 14, marginBottom: 18 }}>
            {t("create.importing.sub")}
          </p>
          <div className="card-dark" style={{ padding: 20 }}>
            <LiveWaveform active bars={70} height={64} />
            <div className="mt-16" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {["build.importing.step1", "build.importing.step2", "build.importing.step3"].map((k) => (
                <div key={k} className="row gap-12" style={{ color: "var(--color-on-dark)", fontSize: 14 }}>
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: "var(--color-primary)",
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#fff",
                        animation: "pulse 1.4s ease-in-out infinite",
                      }}
                    />
                  </span>
                  <span>{t(k)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="first-run" onClick={onClose}>
      <div className="first-run-card" style={{ maxWidth: 620, padding: 36 }} onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <div className="row gap-12">
            <SpikeIcon size={18} style={{ color: "var(--color-primary)" }} />
            <span className="eyebrow" style={{ margin: 0 }}>
              {t("create.eyebrow")}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close" type="button">
            <IcX size={16} />
          </button>
        </div>
        <h2 style={{ margin: "8px 0 18px" }}>{t("create.title")}</h2>

        {!mode && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <button className="cv-option" onClick={() => setMode("record")} type="button">
                <IcMic size={20} style={{ color: "var(--color-primary)" }} />
                <div className="cv-option-title">{t("create.opt.record.title")}</div>
                <div className="cv-option-sub">{t("create.opt.record.sub")}</div>
                <div className="cv-option-time">{t("create.opt.record.time")}</div>
              </button>
              <button className="cv-option" onClick={() => setMode("yt")} type="button">
                <IcYoutube size={20} style={{ color: "var(--color-primary)" }} />
                <div className="cv-option-title">{t("create.opt.yt.title")}</div>
                <div className="cv-option-sub">{t("create.opt.yt.sub")}</div>
                <div className="cv-option-time">{t("create.opt.yt.time")}</div>
              </button>
              <button className="cv-option" onClick={() => setMode("upload")} type="button">
                <IcUpload size={20} style={{ color: "var(--color-primary)" }} />
                <div className="cv-option-title">{t("create.opt.upload.title")}</div>
                <div className="cv-option-sub">{t("create.opt.upload.sub")}</div>
                <div className="cv-option-time">{t("create.opt.upload.time")}</div>
              </button>
            </div>
            <div className="mt-20" style={{ fontSize: 12, color: "var(--color-muted)", textAlign: "center" }}>
              {t("create.disclaimer")}
            </div>
          </>
        )}

        {mode === "record" && (
          <div>
            <label className="input-label">{t("create.field.name")}</label>
            <input
              className="input"
              autoFocus
              placeholder={t("create.field.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div
              style={{
                background: "var(--color-surface-soft)",
                borderRadius: 12,
                padding: 16,
                marginTop: 18,
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <IcInfo size={16} style={{ color: "var(--color-muted)", marginTop: 2, flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: "var(--color-body)", lineHeight: 1.5 }}>{t("create.record.guide")}</div>
            </div>
            {error && (
              <p className="notice notice--error" style={{ marginTop: 14 }}>
                {error}
              </p>
            )}
            <div className="row gap-8 mt-24" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--ghost" onClick={reset} type="button">
                <IcChevronLeft size={14} />
                {t("create.back")}
              </button>
              <button className="btn btn--primary" onClick={startRecord} disabled={busy} type="button">
                <IcMic size={14} />
                {t("create.btn.startRecording")}
              </button>
            </div>
          </div>
        )}

        {mode === "yt" && (
          <div>
            <div
              style={{
                background: "rgba(214, 159, 51, 0.10)",
                border: "1px solid rgba(214, 159, 51, 0.35)",
                borderRadius: 10,
                padding: "10px 14px",
                marginBottom: 18,
                fontSize: 13,
                color: "var(--color-body)",
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
              }}
            >
              <IcInfo size={16} style={{ color: "var(--color-accent-amber)", flexShrink: 0, marginTop: 1 }} />
              <div>{t("create.yt.playgroundNote")}</div>
            </div>
            <label className="input-label">{t("create.yt.urlLabel")}</label>
            <input
              className="input"
              autoFocus
              placeholder="https://www.youtube.com/watch?v=…&t=300"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div style={{ fontSize: 12, color: "var(--color-muted)", marginTop: 6 }}>
              {t("create.yt.hint")}
              {ytStart > 0 && ` · ${fmtTime(ytStart)}`}
            </div>
            <label className="input-label" style={{ marginTop: 18 }}>
              {t("create.field.name")}
            </label>
            <input
              className="input"
              placeholder={t("create.field.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label
              className="row gap-8 mt-16"
              style={{ fontSize: 13, color: "var(--color-body)", cursor: "pointer", alignItems: "flex-start" }}
            >
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{t("create.yt.confirm")}</span>
            </label>
            {error && (
              <p className="notice notice--error" style={{ marginTop: 14 }}>
                {error}
              </p>
            )}
            <div className="row gap-8 mt-24" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--ghost" onClick={reset} type="button">
                <IcChevronLeft size={14} />
                {t("create.back")}
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || !url.trim() || !consent}
                onClick={startYoutube}
                type="button"
              >
                <IcDownload size={14} />
                {t("create.btn.buildFromYt")}
              </button>
            </div>
          </div>
        )}

        {mode === "upload" && (
          <div>
            <label className="input-label">{t("create.field.name")}</label>
            <input
              className="input"
              autoFocus
              placeholder={t("create.field.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label
              className="cv-upload-drop"
              style={{
                marginTop: 18,
                border: "2px dashed var(--color-hairline)",
                borderRadius: 12,
                padding: 24,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                textAlign: "center",
                cursor: "pointer",
              }}
            >
              <IcUpload size={22} style={{ color: "var(--color-muted)" }} />
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-ink)" }}>
                {file ? t("create.upload.picked", { name: file.name }) : t("create.upload.pick")}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-muted)" }}>{t("create.upload.formats")}</div>
              <input
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="input-label" style={{ marginTop: 18 }}>
              {t("create.upload.transcriptLabel")}
            </label>
            <textarea
              className="input"
              rows={2}
              placeholder={t("create.upload.transcriptPlaceholder")}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
            <label
              className="row gap-8 mt-16"
              style={{ fontSize: 13, color: "var(--color-body)", cursor: "pointer", alignItems: "flex-start" }}
            >
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{t("create.yt.confirm")}</span>
            </label>
            {error && (
              <p className="notice notice--error" style={{ marginTop: 14 }}>
                {error}
              </p>
            )}
            <div className="row gap-8 mt-24" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--ghost" onClick={reset} type="button">
                <IcChevronLeft size={14} />
                {t("create.back")}
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || !file || !transcript.trim() || !consent}
                onClick={startUpload}
                type="button"
              >
                <IcUpload size={14} />
                {t("create.btn.upload")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

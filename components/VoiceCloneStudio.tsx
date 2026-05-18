"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleStop,
  Languages,
  Loader2,
  Mic,
  Play,
  ShieldCheck,
  Upload,
  Wand2,
  AudioLines,
} from "lucide-react";

type Locale = "zh-Hant" | "en";
type Status = "idle" | "recording" | "submitting" | "ready" | "needs_worker" | "error";

const copy = {
  "zh-Hant": {
    brand: "AnyVoice",
    navModel: "VoxCPM2",
    navPrd: "PRD",
    locale: "EN",
    title: "把允許使用的聲音，變成可測試的語音分身。",
    subtitle: "錄一段或上傳音檔，輸入要說的文字。接上本機 VoxCPM2 worker 後，就能產生同聲線的新語音。",
    record: "錄音",
    stop: "停止",
    upload: "上傳音檔",
    sourceTitle: "聲音來源",
    sourceHint: "支援錄音、mp3、wav、m4a、webm 與 ffmpeg 可讀音檔。",
    selectedFile: "已選取",
    targetTitle: "要合成的文字",
    targetPlaceholder: "輸入你想讓這個聲音說出的內容。",
    styleTitle: "語氣控制",
    stylePlaceholder: "例如：calm, warm, slightly faster",
    transcriptTitle: "參考音檔逐字稿",
    transcriptPlaceholder: "選填。若逐字稿精準，會走 VoxCPM2 ultimate cloning。",
    consent:
      "我確認自己擁有這段聲音，或已取得明確授權，並且不會用於冒充、詐欺或誤導。",
    submit: "產生聲音",
    submitting: "送出中",
    outputTitle: "輸出",
    idleOutput: "完成後會在這裡播放。",
    ready: "已完成",
    needsWorker: "需要 VoxCPM2 worker",
    needsWorkerBody:
      "Vercel 預覽已啟用，但這個環境沒有跑大型 PyTorch 模型。把 ANYVOICE_ENABLE_LOCAL_VOXCPM=1 指到本機 VoxCPM2 Python 後再送出。",
    error: "失敗",
    runtimeTitle: "Runtime",
    modeReference: "Reference clone",
    modeUltimate: "Ultimate clone",
    model: "Model",
    worker: "Worker",
    localWorker: "Local/GPU",
    vercelHost: "Vercel UI",
    safetyTitle: "Safety",
    safetyBody: "API 會拒絕沒有授權確認的請求。v1 不做長期聲音庫。",
    workflowTitle: "Clone Console",
    workflowBody: "錄音或上傳、輸入文字、確認授權，送到 VoxCPM2。",
    uploadCta: "選擇檔案",
    recordReady: "瀏覽器錄音可用",
    noAudio: "請先錄音或上傳音檔。",
    noText: "請輸入要合成的文字。",
    noConsent: "請先確認聲音授權。",
  },
  en: {
    brand: "AnyVoice",
    navModel: "VoxCPM2",
    navPrd: "PRD",
    locale: "繁中",
    title: "Turn a permitted voice into a testable speech double.",
    subtitle:
      "Record or upload audio, enter the line, then connect a local VoxCPM2 worker to synthesize new speech in that voice.",
    record: "Record",
    stop: "Stop",
    upload: "Upload audio",
    sourceTitle: "Voice source",
    sourceHint: "Supports recording, mp3, wav, m4a, webm, and other ffmpeg-readable audio.",
    selectedFile: "Selected",
    targetTitle: "Text to synthesize",
    targetPlaceholder: "Write what this voice should say.",
    styleTitle: "Style control",
    stylePlaceholder: "Example: calm, warm, slightly faster",
    transcriptTitle: "Reference transcript",
    transcriptPlaceholder: "Optional. Exact transcript enables VoxCPM2 ultimate cloning.",
    consent:
      "I own this voice or have explicit permission to use it, and I will not use it for impersonation, fraud, or deception.",
    submit: "Generate voice",
    submitting: "Submitting",
    outputTitle: "Output",
    idleOutput: "Generated audio will play here.",
    ready: "Ready",
    needsWorker: "VoxCPM2 worker needed",
    needsWorkerBody:
      "The Vercel preview is live, but this environment is not running the large PyTorch model. Set ANYVOICE_ENABLE_LOCAL_VOXCPM=1 and point ANYVOICE_VOXCPM_PYTHON at a local VoxCPM2 runtime.",
    error: "Failed",
    runtimeTitle: "Runtime",
    modeReference: "Reference clone",
    modeUltimate: "Ultimate clone",
    model: "Model",
    worker: "Worker",
    localWorker: "Local/GPU",
    vercelHost: "Vercel UI",
    safetyTitle: "Safety",
    safetyBody: "The API rejects requests without permission confirmation. v1 does not keep a long-term voice library.",
    workflowTitle: "Clone Console",
    workflowBody: "Record or upload, enter text, confirm permission, send to VoxCPM2.",
    uploadCta: "Choose file",
    recordReady: "Browser recording available",
    noAudio: "Record or upload audio first.",
    noText: "Enter target text first.",
    noConsent: "Confirm voice permission first.",
  },
};

function createRecordedFile(chunks: Blob[], mimeType: string): File {
  const type = mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("wav") ? "wav" : "webm";
  return new File(chunks, `recording-${Date.now()}.${extension}`, { type });
}

export function VoiceCloneStudio() {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window === "undefined") return "zh-Hant";
    const saved = window.localStorage.getItem("anyvoice:locale");
    return saved === "en" || saved === "zh-Hant" ? saved : "zh-Hant";
  });
  const t = copy[locale];
  const [status, setStatus] = useState<Status>("idle");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [targetText, setTargetText] = useState("");
  const [style, setStyle] = useState("");
  const [promptTranscript, setPromptTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [message, setMessage] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    window.localStorage.setItem("anyvoice:locale", locale);
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const mode = useMemo(
    () => (promptTranscript.trim() ? t.modeUltimate : t.modeReference),
    [promptTranscript, t.modeReference, t.modeUltimate],
  );

  async function startRecording() {
    setMessage("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const file = createRecordedFile(chunksRef.current, recorder.mimeType);
      setVoiceFile(file);
      stream.getTracks().forEach((track) => track.stop());
      setStatus("idle");
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setStatus("recording");
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      setVoiceFile(file);
      setAudioUrl("");
      setStatus("idle");
      setMessage("");
    }
  }

  async function submit() {
    setMessage("");
    setAudioUrl("");

    if (!voiceFile) {
      setStatus("error");
      setMessage(t.noAudio);
      return;
    }
    if (!targetText.trim()) {
      setStatus("error");
      setMessage(t.noText);
      return;
    }
    if (!consent) {
      setStatus("error");
      setMessage(t.noConsent);
      return;
    }

    setStatus("submitting");
    const form = new FormData();
    form.set("voice", voiceFile);
    form.set("targetText", targetText);
    form.set("style", style);
    form.set("promptTranscript", promptTranscript);
    form.set("consent", "yes");

    const response = await fetch("/api/clone", {
      method: "POST",
      body: form,
    });
    const payload = (await response.json()) as {
      status: Status;
      audioUrl?: string;
      message?: string;
    };

    if (!response.ok || payload.status === "error") {
      setStatus("error");
      setMessage(payload.message || t.error);
      return;
    }
    if (payload.status === "needs_worker") {
      setStatus("needs_worker");
      setMessage(payload.message || t.needsWorkerBody);
      return;
    }
    setStatus("ready");
    setAudioUrl(payload.audioUrl || "");
    setMessage(t.ready);
  }

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>{t.brand}</span>
        </div>
        <nav className="nav-actions" aria-label="AnyVoice">
          <a href="https://huggingface.co/openbmb/VoxCPM2" target="_blank" rel="noreferrer">
            {t.navModel}
          </a>
          <a href="/prd">{t.navPrd}</a>
          <button
            className="icon-button"
            type="button"
            onClick={() => setLocale(locale === "zh-Hant" ? "en" : "zh-Hant")}
            aria-label="Toggle language"
          >
            <Languages size={17} />
            <span>{t.locale}</span>
          </button>
        </nav>
      </header>

      <section className="intro-grid">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <div className="runtime-strip" aria-label={t.runtimeTitle}>
          <div>
            <span>{t.model}</span>
            <strong>openbmb/VoxCPM2</strong>
          </div>
          <div>
            <span>{t.worker}</span>
            <strong>{t.vercelHost} + {t.localWorker}</strong>
          </div>
          <div>
            <span>Mode</span>
            <strong>{mode}</strong>
          </div>
        </div>
      </section>

      <section className="workspace-grid" aria-label={t.workflowTitle}>
        <div className="console-panel">
          <div className="panel-heading">
            <div>
              <h2>{t.workflowTitle}</h2>
              <p>{t.workflowBody}</p>
            </div>
            <AudioLines size={28} />
          </div>

          <div className="voice-source">
            <div className="section-label">
              <h3>{t.sourceTitle}</h3>
              <p>{t.sourceHint}</p>
            </div>
            <div className={`wave-card ${status === "recording" ? "is-recording" : ""}`}>
              <div className="wave-bars" aria-hidden="true">
                {Array.from({ length: 44 }).map((_, index) => (
                  <span key={index} style={{ "--i": index } as React.CSSProperties} />
                ))}
              </div>
              <div className="source-actions">
                {status === "recording" ? (
                  <button className="secondary-action" type="button" onClick={stopRecording}>
                    <CircleStop size={18} />
                    {t.stop}
                  </button>
                ) : (
                  <button className="primary-action" type="button" onClick={startRecording}>
                    <Mic size={18} />
                    {t.record}
                  </button>
                )}
                <label className="secondary-action file-action">
                  <Upload size={18} />
                  {t.uploadCta}
                  <input accept="audio/*" type="file" onChange={onUpload} />
                </label>
              </div>
            </div>
            <div className="file-readout">
              <span>{voiceFile ? t.selectedFile : t.recordReady}</span>
              <strong>{voiceFile ? voiceFile.name : t.upload}</strong>
            </div>
          </div>

          <label className="field-block">
            <span>{t.targetTitle}</span>
            <textarea
              value={targetText}
              onChange={(event) => setTargetText(event.target.value)}
              placeholder={t.targetPlaceholder}
              rows={5}
            />
          </label>

          <div className="split-fields">
            <label className="field-block">
              <span>{t.styleTitle}</span>
              <input
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder={t.stylePlaceholder}
              />
            </label>
            <label className="field-block">
              <span>{t.transcriptTitle}</span>
              <textarea
                value={promptTranscript}
                onChange={(event) => setPromptTranscript(event.target.value)}
                placeholder={t.transcriptPlaceholder}
                rows={3}
              />
            </label>
          </div>

          <label className="consent-row">
            <input checked={consent} type="checkbox" onChange={(event) => setConsent(event.target.checked)} />
            <span>{t.consent}</span>
          </label>

          <button className="submit-action" type="button" onClick={submit} disabled={status === "submitting"}>
            {status === "submitting" ? <Loader2 className="spin" size={18} /> : <Wand2 size={18} />}
            {status === "submitting" ? t.submitting : t.submit}
          </button>
        </div>

        <aside className="result-panel">
          <div className="result-surface">
            <div className="panel-heading compact">
              <div>
                <h2>{t.outputTitle}</h2>
                <p>{status === "idle" ? t.idleOutput : message}</p>
              </div>
              {status === "ready" ? <CheckCircle2 size={25} /> : <Play size={25} />}
            </div>

            {audioUrl ? (
              <audio controls src={audioUrl} />
            ) : (
              <div className={`output-state ${status}`}>
              {status === "submitting" ? <Loader2 className="spin" size={30} /> : <AudioLines size={34} />}
              </div>
            )}
          </div>

          <div className="safety-panel">
            <ShieldCheck size={24} />
            <div>
              <h3>{status === "needs_worker" ? t.needsWorker : t.safetyTitle}</h3>
              <p>{status === "needs_worker" ? t.needsWorkerBody : t.safetyBody}</p>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

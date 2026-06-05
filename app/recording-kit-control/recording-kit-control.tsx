"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, Mic, Play, RefreshCw, Square, Trash2, Upload } from "lucide-react";

type ClipId = "profile-clip-09" | "profile-clip-08";

type KitClip = {
  id: string;
  transcript: string;
  pronunciationNotes?: string[];
  durationTargetSec?: number;
  recommendedDurationSec?: number;
};

type KitPayload = {
  kit?: {
    manifest: string;
    cueSheetUrl?: string;
    clipSpecs?: KitClip[];
  } | null;
};

type CheckPayload = {
  check?: {
    status?: string;
    checks?: Array<{ check: string; ok: boolean; message: string; details?: unknown }>;
    clips?: Array<Record<string, unknown>>;
  };
  status?: string;
  message?: string;
};

type ClipState = {
  blob?: Blob;
  url?: string;
  seconds: number;
  estimatedActiveSec?: number;
  status: "empty" | "recording" | "ready" | "uploaded";
};

const TARGET_CLIPS: ClipId[] = ["profile-clip-09", "profile-clip-08"];
const PROFILE_ID = "local-default";
const CLEAN_BROWSER_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const ACTIVE_VOICE_RMS_THRESHOLD = 0.006;

function initialClipState(): Record<ClipId, ClipState> {
  return {
    "profile-clip-09": { seconds: 0, status: "empty" },
    "profile-clip-08": { seconds: 0, status: "empty" },
  };
}

function formatSeconds(value: number): string {
  return `${Math.max(0, value).toFixed(1)}s`;
}

function checkErrorsForClip(check: CheckPayload | null, clipId: ClipId): string[] {
  const rows = check?.check?.clips ?? [];
  const row = rows.find((item) => item.id === clipId);
  const errors = row?.errors;
  return Array.isArray(errors) ? errors.filter((item): item is string => typeof item === "string") : [];
}

function checkSummary(check: CheckPayload | null): string {
  if (!check?.check) return "No check yet.";
  const failed = (check.check.checks ?? []).filter((row) => !row.ok);
  if (failed.length === 0) return `Kit check: ${check.check.status ?? "unknown"}`;
  return failed.map((row) => `${row.check}: ${row.message}`).join("\n");
}

async function estimateActiveVoiceSec(blob: Blob): Promise<number | undefined> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const sampleRate = buffer.sampleRate;
    const channel = buffer.getChannelData(0);
    const windowFrames = Math.max(1, Math.round(sampleRate * 0.02));
    let activeFrames = 0;
    for (let start = 0; start < channel.length; start += windowFrames) {
      const end = Math.min(channel.length, start + windowFrames);
      let sumSquares = 0;
      for (let index = start; index < end; index += 1) {
        sumSquares += channel[index] * channel[index];
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
      if (rms >= ACTIVE_VOICE_RMS_THRESHOLD) activeFrames += end - start;
    }
    return activeFrames / sampleRate;
  } catch {
    return undefined;
  } finally {
    await context.close().catch(() => {});
  }
}

export function RecordingKitControl() {
  const [kit, setKit] = useState<KitPayload["kit"]>(null);
  const [clips, setClips] = useState<Record<ClipId, ClipState>>(initialClipState);
  const [activeClip, setActiveClip] = useState<ClipId>("profile-clip-09");
  const [check, setCheck] = useState<CheckPayload | null>(null);
  const [message, setMessage] = useState("Loading current recording kit...");
  const [error, setError] = useState("");
  const [meter, setMeter] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);

  const clipSpecs = useMemo(() => {
    const map = new Map<string, KitClip>();
    for (const clip of kit?.clipSpecs ?? []) map.set(clip.id, clip);
    return map;
  }, [kit]);

  function stopMeter() {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    setMeter(0);
  }

  async function loadKit() {
    setError("");
    const response = await fetch(`/api/voice-profile/recording-kit?profileId=${PROFILE_ID}`, { cache: "no-store" });
    const payload = (await response.json()) as KitPayload;
    if (!response.ok || !payload.kit) throw new Error("current recording kit not found");
    setKit(payload.kit);
    setMessage("Ready. Record 09 first, then 08.");
  }

  async function runCheck() {
    if (!kit?.manifest) return;
    setError("");
    const response = await fetch("/api/voice-profile/recording-kit/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: PROFILE_ID, manifest: kit.manifest }),
    });
    const payload = (await response.json()) as CheckPayload;
    setCheck(payload);
    if (!response.ok || payload.status === "error") throw new Error(payload.message || "kit check failed");
    setMessage(checkSummary(payload));
  }

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void loadKit().then(runCheck).catch((err) => setError(err instanceof Error ? err.message : "load failed"));
    }, 0);
    return () => {
      window.clearTimeout(handle);
      stopMeter();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      for (const state of Object.values(clips)) {
        if (state.url) URL.revokeObjectURL(state.url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startMeter(stream: MediaStream) {
    stopMeter();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    audioContextRef.current = context;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      let sumSquares = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
      for (const value of data) {
        const centered = (value - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setMeter(Math.max(peak * 0.35, rms * 10));
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  async function startRecording(clipId: ClipId) {
    setError("");
    setActiveClip(clipId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: CLEAN_BROWSER_CAPTURE,
    });
    streamRef.current = stream;
    startMeter(stream);
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setClips((current) => ({ ...current, [clipId]: { ...current[clipId], status: "recording", seconds: 0 } }));
    timerRef.current = window.setInterval(() => {
      setClips((current) => ({
        ...current,
        [clipId]: { ...current[clipId], seconds: (Date.now() - startedAtRef.current) / 1000 },
      }));
    }, 100);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      stopMeter();
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      const seconds = (Date.now() - startedAtRef.current) / 1000;
      setClips((current) => {
        if (current[clipId].url) URL.revokeObjectURL(current[clipId].url);
        return {
          ...current,
          [clipId]: {
            blob,
            url,
            seconds,
            status: "ready",
          },
        };
      });
      void estimateActiveVoiceSec(blob).then((estimatedActiveSec) => {
        if (estimatedActiveSec === undefined) return;
        setClips((current) => ({
          ...current,
          [clipId]: {
            ...current[clipId],
            estimatedActiveSec,
          },
        }));
      });
      setMessage(`${clipId} recorded. Play it back, then upload or re-record.`);
    };
    recorder.start();
    setMessage(`Recording ${clipId}... stop after the sentence is complete.`);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  function clearClip(clipId: ClipId) {
    setClips((current) => {
      if (current[clipId].url) URL.revokeObjectURL(current[clipId].url);
      return { ...current, [clipId]: { seconds: 0, status: "empty" } };
    });
  }

  async function uploadClip(clipId: ClipId) {
    const state = clips[clipId];
    const spec = clipSpecs.get(clipId);
    if (!state.blob || !spec) return;
    setError("");
    const form = new FormData();
    form.set("consent", "yes");
    form.set("profileId", PROFILE_ID);
    form.set(
      "clips",
      JSON.stringify([
        {
          id: clipId,
          fileField: "voice-0",
          expectedStem: clipId,
          transcript: spec.transcript,
          sourceKind: "scripted",
          browserCaptureSettings: CLEAN_BROWSER_CAPTURE,
        },
      ]),
    );
    form.set("voice-0", new File([state.blob], `${clipId}.webm`, { type: state.blob.type || "audio/webm" }));
    const response = await fetch("/api/voice-profile/import", { method: "POST", body: form });
    const payload = (await response.json()) as { status?: string; message?: string };
    if (!response.ok || payload.status === "error") throw new Error(payload.message || "upload failed");
    setClips((current) => ({ ...current, [clipId]: { ...current[clipId], status: "uploaded" } }));
    setMessage(`${clipId} uploaded. Running kit check...`);
    await runCheck();
  }

  async function uploadBoth() {
    for (const clipId of TARGET_CLIPS) {
      if (clips[clipId].status === "ready") await uploadClip(clipId);
    }
  }

  const isRecording = Object.values(clips).some((clip) => clip.status === "recording");

  return (
    <main className="rk-page">
      <section className="rk-header">
        <div>
          <p className="rk-eyebrow">AnyVoice local recording control</p>
          <h1>Record profile clips 09 and 08</h1>
          <p>Use the browser microphone, listen back, then upload the selected take into the local profile.</p>
        </div>
        <div className="rk-actions">
          {kit?.cueSheetUrl ? (
            <a className="rk-button secondary" href={kit.cueSheetUrl} target="_blank" rel="noreferrer">
              Cue sheet
            </a>
          ) : null}
          <button className="rk-button secondary" type="button" onClick={() => void runCheck()}>
            <RefreshCw size={16} />
            Check
          </button>
        </div>
      </section>

      <section className="rk-status">
        <div>
          <strong>Status</strong>
          <pre>{message}</pre>
          {error ? <p className="rk-error">{error}</p> : null}
        </div>
        <div>
          <strong>Input level</strong>
          <div className="rk-meter" aria-label="Input level">
            <span style={{ width: `${Math.min(100, Math.round(meter * 100))}%` }} />
          </div>
          <p className="rk-hint">Aim for steady movement around 25-70%. This meter weights RMS voice activity, not only peak spikes.</p>
        </div>
      </section>

      <section className="rk-grid">
        {TARGET_CLIPS.map((clipId) => {
          const spec = clipSpecs.get(clipId);
          const state = clips[clipId];
          const errors = checkErrorsForClip(check, clipId);
          const target = spec?.durationTargetSec ?? spec?.recommendedDurationSec;
          return (
            <article key={clipId} className={`rk-card ${activeClip === clipId ? "active" : ""}`}>
              <div className="rk-card-head">
                <div>
                  <p className="rk-eyebrow">{clipId}</p>
                  <h2>{target ? `Target ${target}s` : "Guided clip"}</h2>
                </div>
                {errors.length === 0 ? <CheckCircle2 className="rk-ok" /> : <Circle className="rk-warn" />}
              </div>
              <p className="rk-transcript">{spec?.transcript ?? "Loading transcript..."}</p>
              {spec?.pronunciationNotes?.length ? (
                <ul className="rk-notes">
                  {spec.pronunciationNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {errors.length > 0 ? <p className="rk-error">Current check: {errors.join(", ")}</p> : null}
              <div className="rk-row">
                <span>{state.status}</span>
                <strong>
                  {formatSeconds(state.seconds)}
                  {state.estimatedActiveSec !== undefined ? ` / active ${formatSeconds(state.estimatedActiveSec)}` : ""}
                </strong>
              </div>
              {state.url ? <audio className="rk-audio" controls src={state.url} /> : null}
              <div className="rk-controls">
                {state.status === "recording" ? (
                  <button className="rk-button danger" type="button" onClick={stopRecording}>
                    <Square size={16} />
                    Stop
                  </button>
                ) : (
                  <button className="rk-button" type="button" disabled={isRecording} onClick={() => void startRecording(clipId).catch((err) => setError(err instanceof Error ? err.message : "record failed"))}>
                    <Mic size={16} />
                    Record
                  </button>
                )}
                {state.url ? (
                  <a className="rk-button secondary" href={state.url}>
                    <Play size={16} />
                    Open
                  </a>
                ) : null}
                <button className="rk-button secondary" type="button" disabled={!state.blob || state.status === "recording"} onClick={() => void uploadClip(clipId).catch((err) => setError(err instanceof Error ? err.message : "upload failed"))}>
                  <Upload size={16} />
                  Upload
                </button>
                <button className="rk-icon" type="button" disabled={state.status === "recording"} onClick={() => clearClip(clipId)} aria-label={`Clear ${clipId}`}>
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rk-footer">
        <button className="rk-button" type="button" disabled={!TARGET_CLIPS.some((clipId) => clips[clipId].status === "ready")} onClick={() => void uploadBoth().catch((err) => setError(err instanceof Error ? err.message : "upload failed"))}>
          <Upload size={16} />
          Upload ready takes
        </button>
        <button className="rk-button secondary" type="button" onClick={() => void runCheck().catch((err) => setError(err instanceof Error ? err.message : "check failed"))}>
          <RefreshCw size={16} />
          Re-check kit
        </button>
      </section>
    </main>
  );
}

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import * as OpenCC from "opencc-js";

/**
 * Helpers for importing a voice-profile reference clip from a YouTube video:
 * parse the URL (+ `t` start param), download just the needed audio section and
 * subtitles via yt-dlp, turn the overlapping captions into a transcript, and
 * convert Simplified Chinese captions to Traditional so they pass the strict
 * zh-Hant enrollment gate.
 */

export interface ParsedYoutubeUrl {
  videoId: string;
  startSeconds: number;
}

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Default reference window length and the enrollment 6–20s sweet spot. */
const DEFAULT_WINDOW_SEC = 12;
const MIN_WINDOW_SEC = 6;
const MAX_WINDOW_SEC = 20;

/**
 * Parse a `t` / `start` time value into seconds. Accepts a bare integer
 * ("300"), a trailing-unit form ("300s", "5m0s", "1h2m3s"), or a clock form
 * ("5:00", "1:05:00"). Returns 0 for empty or unrecognized input.
 */
export function parseTimeParam(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return 0;

  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d+s$/.test(raw)) return Number(raw.slice(0, -1));

  if (raw.includes(":")) {
    const parts = raw.split(":");
    if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return 0;
    return parts.reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return 0;
  const [, h, m, s] = match;
  return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

/**
 * Parse a YouTube URL into its video id and start offset. Supports watch,
 * youtu.be, shorts and embed forms. Returns null when no valid 11-char id is
 * present.
 */
export function parseYoutubeUrl(raw: string): ParsedYoutubeUrl | null {
  if (!raw || typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");

  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.slice(1).split("/")[0] || null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/);
      videoId = m ? m[1] : null;
    }
  }
  if (!videoId || !VIDEO_ID.test(videoId)) return null;

  const startSeconds = parseTimeParam(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return { videoId, startSeconds };
}

/** Clamp the requested window length into the 6–20s enrollment sweet spot. */
export function clampWindow(
  start: number,
  durationSeconds?: number,
): { start: number; end: number } {
  const safeStart = Math.max(0, Math.floor(start || 0));
  const requested = durationSeconds && durationSeconds > 0 ? durationSeconds : DEFAULT_WINDOW_SEC;
  const window = Math.min(MAX_WINDOW_SEC, Math.max(MIN_WINDOW_SEC, Math.round(requested)));
  return { start: safeStart, end: safeStart + window };
}

function parseVttTimestamp(value: string): number | null {
  // HH:MM:SS.mmm or MM:SS.mmm
  const m = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms ? `0.${ms}` : 0);
}

/** Strip inline VTT/HTML tags and decode the few entities captions use. */
function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a WebVTT file into timed cues. */
export function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingLine = lines.find((l) => l.includes("-->"));
    if (!timingLine) continue;
    const [startRaw, endRaw] = timingLine.split("-->");
    const start = parseVttTimestamp(startRaw ?? "");
    const end = parseVttTimestamp((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;
    const textLines = lines.slice(lines.indexOf(timingLine) + 1);
    const text = cleanCueText(textLines.join(" "));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Concatenate the cues overlapping [windowStart, windowEnd] into a transcript,
 * dropping the rolling-duplicate lines YouTube auto-captions emit.
 */
export function selectCuesText(cues: VttCue[], windowStart: number, windowEnd: number): string {
  const picked = cues
    .filter((c) => c.end > windowStart && c.start < windowEnd)
    .sort((a, b) => a.start - b.start);
  const out: string[] = [];
  for (const cue of picked) {
    const last = out[out.length - 1];
    if (cue.text === last) continue;
    // Auto-captions repeat the tail of the previous cue at the head of the next.
    if (last && (last.endsWith(cue.text) || cue.text.startsWith(last))) {
      out[out.length - 1] = cue.text.length >= last.length ? cue.text : last;
      continue;
    }
    out.push(cue.text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Pick the best subtitle file: manual Traditional first, then any zh, then any.
 * yt-dlp auto-captions land as `*.lang.vtt`; we use the lang in the filename.
 */
export function pickSubtitleFile(files: string[]): { path: string; lang: string } | null {
  const vtts = files.filter((f) => f.toLowerCase().endsWith(".vtt"));
  if (vtts.length === 0) return null;
  const lang = (f: string) => (f.match(/\.([A-Za-z-]+)\.vtt$/i)?.[1] ?? "").toLowerCase();
  const score = (f: string) => {
    const l = lang(f);
    if (l === "zh-hant" || l === "zh-tw") return 0;
    if (l.startsWith("zh")) return 1;
    if (l) return 2;
    return 3;
  };
  const best = [...vtts].sort((a, b) => score(a) - score(b))[0];
  return { path: best, lang: lang(best) };
}

const s2tConverter = OpenCC.Converter({ from: "cn", to: "twp" });

/** Convert Simplified Chinese to Traditional (Taiwan + phrases). Idempotent. */
export function simplifiedToTraditional(text: string): string {
  if (!text) return text;
  return s2tConverter(text);
}

/**
 * Transcribe an audio file to text via the local Whisper backend
 * (scripts/transcribe_audio_anyvoice.py). Used as an automatic fallback when a
 * video has no usable captions. Returns "" if ASR is unavailable or fails so
 * the caller can degrade gracefully (e.g. ask for a typed transcript).
 */
export async function transcribeAudioFile(audioPath: string, language = "zh"): Promise<string> {
  const python =
    process.env.ANYVOICE_ASR_PYTHON || process.env.ANYVOICE_VOXCPM_PYTHON || process.env.PYTHON || "python3";
  const script = path.join(process.cwd(), "scripts", "transcribe_audio_anyvoice.py");
  const model = process.env.ANYVOICE_ASR_MODEL || "large-v3";
  const args = [script, "--audio", audioPath, "--language", language, "--model", model];
  const result = await new Promise<RunResult>((resolve) => {
    const child = spawn(python, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", (err) => (spawnError = err));
    child.on("close", (code) => resolve({ code, stdout, stderr, spawnError }));
  });
  if (result.code !== 0 || !result.stdout.trim()) return "";
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { transcript?: string };
    return (parsed.transcript || "").trim();
  } catch {
    return "";
  }
}

export class YoutubeImportError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "YoutubeImportError";
    this.statusCode = statusCode;
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

function runYtDlp(args: string[], timeoutMs: number): Promise<RunResult> {
  const bin = process.env.ANYVOICE_YTDLP || "yt-dlp";
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", (err) => (spawnError = err));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, spawnError });
    });
  });
}

function friendlyYtDlpError(result: RunResult): YoutubeImportError {
  if (result.spawnError && (result.spawnError as NodeJS.ErrnoException).code === "ENOENT") {
    return new YoutubeImportError("yt-dlp is not installed: brew install yt-dlp", 500);
  }
  const detail = `${result.stderr}\n${result.stdout}`;
  if (/Sign in to confirm|age|inappropriate/i.test(detail)) {
    return new YoutubeImportError("this video is age-restricted and cannot be imported", 422);
  }
  if (/not available in your country|geo|region/i.test(detail)) {
    return new YoutubeImportError("this video is region-locked and cannot be imported", 422);
  }
  if (/Private video|members-only|Join this channel|login|cookies/i.test(detail)) {
    return new YoutubeImportError("this video is private or members-only and cannot be imported", 422);
  }
  if (/Video unavailable|does not exist|Incomplete YouTube ID/i.test(detail)) {
    return new YoutubeImportError("this video is unavailable", 404);
  }
  const trimmed = result.stderr.trim() || result.stdout.trim();
  return new YoutubeImportError(trimmed ? `yt-dlp failed: ${trimmed.slice(0, 300)}` : "yt-dlp failed", 502);
}

/**
 * Download only the [start, end] audio section (as wav) plus subtitles for a
 * YouTube video into `runDir`. Two passes so a subtitle failure does not lose
 * the audio and vice versa. Throws YoutubeImportError on failure.
 */
export async function downloadYoutubeReference(opts: {
  videoId: string;
  start: number;
  end: number;
  runDir: string;
  timeoutMs?: number;
}): Promise<{ wavPath: string; subtitleFiles: string[] }> {
  const { videoId, start, end, runDir } = opts;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const ffmpeg = process.env.ANYVOICE_FFMPEG || "/opt/homebrew/bin/ffmpeg";

  // Pass A: section audio -> wav.
  const audioResult = await runYtDlp(
    [
      "--download-sections",
      `*${start}-${end}`,
      "--force-keyframes-at-cuts",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "wav",
      "--no-playlist",
      "--no-progress",
      "--ffmpeg-location",
      ffmpeg,
      "-o",
      path.join(runDir, "youtube-section.%(ext)s"),
      url,
    ],
    timeoutMs,
  );
  if (audioResult.code !== 0) throw friendlyYtDlpError(audioResult);

  // Pass B: subtitles only (best-effort — missing captions are not fatal).
  await runYtDlp(
    [
      "--skip-download",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs",
      "zh-Hant,zh-TW,zh-Hans,zh-CN,zh.*,zh,en.*,en",
      "--sub-format",
      "vtt",
      "--convert-subs",
      "vtt",
      "--no-playlist",
      "--ffmpeg-location",
      ffmpeg,
      "-o",
      path.join(runDir, "youtube"),
      url,
    ],
    timeoutMs,
  );

  const entries = await readdir(runDir);
  const wavName = entries.find((f) => f === "youtube-section.wav");
  if (!wavName) {
    throw new YoutubeImportError("yt-dlp produced no audio for the requested section", 502);
  }
  const subtitleFiles = entries
    .filter((f) => f.startsWith("youtube") && f.toLowerCase().endsWith(".vtt"))
    .map((f) => path.join(runDir, f));

  return { wavPath: path.join(runDir, wavName), subtitleFiles };
}

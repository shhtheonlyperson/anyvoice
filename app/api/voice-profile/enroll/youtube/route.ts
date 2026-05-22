import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { safeRunDir } from "@/lib/run-paths";
import { detectChineseScript, strictTraditionalChineseScriptErrors } from "@/lib/text-prep";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";
import {
  clampWindow,
  downloadYoutubeReference,
  parseVtt,
  parseYoutubeUrl,
  pickSubtitleFile,
  selectCuesText,
  simplifiedToTraditional,
  transcribeAudioFile,
  YoutubeImportError,
} from "@/lib/youtube-import";

export const runtime = "nodejs";
export const maxDuration = 120;

interface YoutubeImportBody {
  url?: string;
  startSeconds?: number;
  durationSeconds?: number;
  transcriptOverride?: string;
  consent?: string;
  profileId?: string;
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export async function POST(req: NextRequest) {
  const session = getOrCreateAnyVoiceUserSession(req);
  const reply = (data: unknown, init?: ResponseInit) =>
    withAnyVoiceUserCookie(json(data, init), session);

  let body: YoutubeImportBody;
  try {
    body = (await req.json()) as YoutubeImportBody;
  } catch {
    return reply({ status: "error", message: "JSON body required" }, { status: 400 });
  }

  if (body.consent !== "yes") {
    return reply({ status: "error", message: "voice permission confirmation required" }, { status: 400 });
  }

  const parsed = parseYoutubeUrl(String(body.url || ""));
  if (!parsed) {
    return reply({ status: "error", message: "valid YouTube URL required" }, { status: 400 });
  }

  const startSeconds =
    typeof body.startSeconds === "number" && body.startSeconds >= 0 ? body.startSeconds : parsed.startSeconds;
  const { start, end } = clampWindow(startSeconds, body.durationSeconds);

  const jobId = nanoid(10);
  const runDir = safeRunDir(jobId);
  await mkdir(runDir, { recursive: true });

  try {
    const { wavPath, subtitleFiles } = await downloadYoutubeReference({
      videoId: parsed.videoId,
      start,
      end,
      runDir,
    });

    // Transcript: explicit override wins, otherwise captions, otherwise ASR.
    let transcriptRaw = String(body.transcriptOverride || "").trim();
    let transcriptSource: "override" | "captions" | "asr" | null = transcriptRaw ? "override" : null;
    let subtitleLang: string | null = null;
    if (!transcriptRaw) {
      const picked = pickSubtitleFile(subtitleFiles);
      if (picked) {
        subtitleLang = picked.lang;
        const cues = parseVtt(await readFile(picked.path, "utf-8"));
        transcriptRaw = selectCuesText(cues, start, end);
        if (transcriptRaw) transcriptSource = "captions";
      }
    }
    if (!transcriptRaw) {
      // No usable captions — transcribe the downloaded slice automatically.
      transcriptRaw = await transcribeAudioFile(wavPath);
      if (transcriptRaw) transcriptSource = "asr";
    }

    const transcript = simplifiedToTraditional(transcriptRaw);
    if (!transcript) {
      return reply(
        {
          status: "error",
          code: "no_captions",
          message:
            "could not capture text for this window (no captions and transcription failed); type the transcript and import again",
        },
        { status: 422 },
      );
    }

    const transcriptScript = detectChineseScript(transcript);
    const scriptErrors = strictTraditionalChineseScriptErrors(transcript);
    if (scriptErrors.length > 0) {
      return reply(
        {
          status: "error",
          message: `profile transcript must use Traditional Chinese with clear zh-Hant evidence; Simplified, mixed, or unproven Chinese clips are not accepted for the Traditional Mandarin voice profile (${transcriptScript})`,
        },
        { status: 400 },
      );
    }

    const voiceProfileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : undefined;
    const buf = await readFile(wavPath);
    const voice = new File([buf], "youtube.wav", { type: "audio/wav" });
    const enrollment = await enrollVoiceProfileClip(jobId, {
      voice,
      promptTranscript: transcript,
      sourceKind: "uploaded",
      voiceProfileId,
    });

    // Provenance sidecar (additive — does not affect profile selection).
    await writeFile(
      path.join(runDir, "youtube-import.json"),
      `${JSON.stringify(
        {
          url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
          videoId: parsed.videoId,
          startSeconds: start,
          endSeconds: end,
          transcriptSource,
          subtitleLang,
          transcriptRaw,
          transcriptConverted: transcript,
          importedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const profile = await persistVoiceProfileManifest({ profileId: voiceProfileId ?? "local-default" });
    return reply({ ...enrollment, profile });
  } catch (err) {
    if (err instanceof YoutubeImportError) {
      return reply({ status: "error", jobId, message: err.message }, { status: err.statusCode });
    }
    const message = err instanceof Error ? err.message : "youtube import failed";
    return reply({ status: "error", jobId, message }, { status: 500 });
  }
}

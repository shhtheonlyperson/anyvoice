import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { enrollVoiceProfileClip } from "@/lib/profile-enrollment";
import { safeRunDir } from "@/lib/run-paths";
import { detectChineseScript, strictTraditionalChineseScriptErrors } from "@/lib/text-prep";
import { getOrCreateAnyVoiceUserSession, withAnyVoiceUserCookie } from "@/lib/user-session";
import { guardVoiceProfileAccess } from "@/lib/voice-profile-access";
import { persistVoiceProfileManifest } from "@/lib/voice-profile";
import {
  clampScanWindow,
  downloadYoutubeReference,
  parseVtt,
  parseYoutubeUrl,
  pickSubtitleFile,
  planFixedSlices,
  planSegments,
  sliceAudioSegment,
  simplifiedToTraditional,
  transcribeAudioFile,
  YoutubeImportError,
  type PlannedSegment,
} from "@/lib/youtube-import";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Cap clips per import so enroll time stays bounded. */
const MAX_CLIPS = 8;
/** Highest grade wins when reporting the headline referenceQuality. */
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

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
  const { start, end } = clampScanWindow(startSeconds, body.durationSeconds);
  const voiceProfileId = typeof body.profileId === "string" && body.profileId.trim() ? body.profileId.trim() : undefined;

  const denied = await guardVoiceProfileAccess(session, voiceProfileId ?? "local-default");
  if (denied) return denied;

  const baseJobId = nanoid(10);
  const baseRunDir = safeRunDir(baseJobId);
  await mkdir(baseRunDir, { recursive: true });

  try {
    const { wavPath, subtitleFiles } = await downloadYoutubeReference({
      videoId: parsed.videoId,
      start,
      end,
      runDir: baseRunDir,
    });

    // Plan the clips. Explicit override → one clip from the head of the window.
    // Captions → chunk into caption-aligned clips. Otherwise → fixed slices,
    // each transcribed by ASR.
    type Clip = { relStart: number; duration: number; transcriptRaw: string };
    let clips: Clip[] = [];
    let transcriptSource: "override" | "captions" | "asr" | null = null;
    let subtitleLang: string | null = null;
    let plannedSegments: PlannedSegment[] = [];

    const override = String(body.transcriptOverride || "").trim();
    if (override) {
      transcriptSource = "override";
      clips = [{ relStart: 0, duration: Math.min(18, end - start), transcriptRaw: override }];
    } else {
      const picked = pickSubtitleFile(subtitleFiles);
      if (picked) {
        subtitleLang = picked.lang;
        const cues = parseVtt(await readFile(picked.path, "utf-8"));
        plannedSegments = planSegments(cues, start, end);
        if (plannedSegments.length > 0) {
          transcriptSource = "captions";
          clips = plannedSegments.map((seg) => ({
            relStart: seg.start - start,
            duration: seg.end - seg.start,
            transcriptRaw: seg.text,
          }));
        }
      }
      if (clips.length === 0) {
        // No captions — slice and ASR-transcribe each piece.
        const slices = planFixedSlices(end - start);
        for (const slice of slices.slice(0, MAX_CLIPS)) {
          const slicePath = path.join(baseRunDir, `asr-slice-${slice.relStart}.wav`);
          await sliceAudioSegment({ srcWav: wavPath, ...slice, outPath: slicePath });
          const text = await transcribeAudioFile(slicePath);
          if (text.trim()) {
            clips.push({ relStart: slice.relStart, duration: slice.duration, transcriptRaw: text.trim() });
          }
        }
        if (clips.length > 0) transcriptSource = "asr";
      }
    }

    if (clips.length === 0) {
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

    clips = clips.slice(0, MAX_CLIPS);

    // Enroll each clip as its own run, tagged with the target profile.
    type EnrolledClip = {
      jobId: string;
      grade?: string;
      durationSec?: number;
      transcript: string;
      relStart: number;
    };
    const enrolledClips: EnrolledClip[] = [];
    const skipped: { reason: string; transcript: string }[] = [];
    let lastEnrollment: Awaited<ReturnType<typeof enrollVoiceProfileClip>> | null = null;

    for (const clip of clips) {
      const transcript = simplifiedToTraditional(clip.transcriptRaw);
      if (!transcript) {
        skipped.push({ reason: "empty", transcript: clip.transcriptRaw });
        continue;
      }
      const scriptErrors = strictTraditionalChineseScriptErrors(transcript);
      if (scriptErrors.length > 0) {
        skipped.push({ reason: scriptErrors.includes("unproven_chinese_script") ? "unproven_chinese_script" : "simplified_or_mixed", transcript });
        continue;
      }
      const clipJobId = nanoid(10);
      const slicePath = path.join(safeRunDir(clipJobId), "youtube-clip.wav");
      await mkdir(path.dirname(slicePath), { recursive: true });
      await sliceAudioSegment({ srcWav: wavPath, relStart: clip.relStart, duration: clip.duration, outPath: slicePath });
      const buf = await readFile(slicePath);
      const voice = new File([buf], "youtube.wav", { type: "audio/wav" });
      const enrollment = await enrollVoiceProfileClip(clipJobId, {
        voice,
        promptTranscript: transcript,
        sourceKind: "uploaded",
        voiceProfileId,
      });
      lastEnrollment = enrollment;
      enrolledClips.push({
        jobId: clipJobId,
        grade: enrollment.referenceQuality?.grade,
        durationSec: enrollment.referenceQuality?.durationSec,
        transcript,
        relStart: clip.relStart,
      });
    }

    // Provenance sidecar (additive — does not affect profile selection).
    await writeFile(
      path.join(baseRunDir, "youtube-import.json"),
      `${JSON.stringify(
        {
          url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
          videoId: parsed.videoId,
          startSeconds: start,
          endSeconds: end,
          transcriptSource,
          subtitleLang,
          clips: enrolledClips,
          skipped,
          importedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    if (enrolledClips.length === 0) {
      // Every candidate clip failed the Traditional-Chinese gate.
      const sample =
        skipped.find((s) => s.reason === "simplified_or_mixed" || s.reason === "unproven_chinese_script")?.transcript ??
        "";
      return reply(
        {
          status: "error",
          message: `profile transcript must be proven Traditional Chinese; Simplified, mixed, or unproven Chinese clips are not accepted for the Traditional Mandarin voice profile (${detectChineseScript(sample)})`,
        },
        { status: 400 },
      );
    }

    const profile = await persistVoiceProfileManifest({ profileId: voiceProfileId ?? "local-default" });

    // Headline quality = the best clip we enrolled (so the UI shows the strongest grade).
    const best = enrolledClips
      .slice()
      .sort((a, b) => (GRADE_RANK[b.grade ?? ""] ?? 0) - (GRADE_RANK[a.grade ?? ""] ?? 0))[0];

    return reply({
      ...(lastEnrollment ?? {}),
      status: "enrolled",
      referenceQuality: best?.grade
        ? { ...(lastEnrollment?.referenceQuality ?? {}), grade: best.grade, durationSec: best.durationSec }
        : lastEnrollment?.referenceQuality,
      clipsEnrolled: enrolledClips.length,
      clipsSkipped: skipped.length,
      clips: enrolledClips,
      profile,
    });
  } catch (err) {
    if (err instanceof YoutubeImportError) {
      return reply({ status: "error", jobId: baseJobId, message: err.message }, { status: err.statusCode });
    }
    const message = err instanceof Error ? err.message : "youtube import failed";
    return reply({ status: "error", jobId: baseJobId, message }, { status: 500 });
  }
}

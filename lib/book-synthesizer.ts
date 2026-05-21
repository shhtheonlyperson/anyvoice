import path from "node:path";
import { synthesizeSegment } from "@/lib/clone-runner";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import {
  bookDir,
  loadProgress,
  loadSegments,
  markSegment,
  nextPendingIndex,
  segmentAudioPath,
} from "@/lib/book-job";

// Books currently being synthesized in-process, so a re-trigger doesn't start a
// second loop over the same book. The loop is resumable: on server restart,
// re-triggering skips already-done segments (status persisted per segment).
const running = new Set<string>();

export function isBookSynthesisRunning(id: string): boolean {
  return running.has(id);
}

async function resolveReference(): Promise<{ audioPath: string; transcript: string }> {
  const profile = await buildVoiceProfileSummary();
  const clip = profile.clips[0];
  if (!clip) throw new Error("voice profile has no usable clip");
  return { audioPath: clip.audioPath, transcript: clip.transcriptRaw };
}

/** Awaitable synthesis loop (used directly in tests). No-op if already running. */
export async function runBookSynthesis(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const reference = await resolveReference();
    const segments = await loadSegments(id);
    const workDir = path.join(bookDir(id), "tmp");

    for (;;) {
      const progress = await loadProgress(id);
      if (!progress || progress.status !== "synthesizing") break; // paused / cancelled / done / deleted
      const index = nextPendingIndex(progress);
      if (index === null) break;

      const segment = segments[index];
      try {
        await synthesizeSegment({
          targetText: segment.text,
          referenceAudioPath: reference.audioPath,
          promptTranscript: reference.transcript,
          workDir,
          outputM4aPath: segmentAudioPath(id, index),
        });
        await markSegment(id, index, "done");
      } catch {
        await markSegment(id, index, "error");
      }
    }
  } finally {
    running.delete(id);
  }
}

/** Start (or resume) background synthesis for a book. No-op if already running. */
export function startBookSynthesis(id: string): void {
  // Fire-and-forget: keeps running on the always-on local server across requests.
  void runBookSynthesis(id);
}

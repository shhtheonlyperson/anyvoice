import path from "node:path";
import { synthesizeSegment } from "@/lib/clone-runner";
import { buildVoiceProfileSummary } from "@/lib/voice-profile";
import {
  bookDir,
  loadBookMeta,
  loadProgress,
  loadSegments,
  markSegment,
  nextSegmentToSynthesize,
  segmentAudioPath,
  setBookStatus,
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
    const meta = await loadBookMeta(id);
    if (!meta) return;
    const reference = await resolveReference();
    const segments = await loadSegments(id);
    const workDir = path.join(bookDir(id), "tmp");

    for (;;) {
      const progress = await loadProgress(id);
      if (!progress || progress.status !== "synthesizing") break; // paused / cancelled / done / deleted
      // Re-read each iteration so a user clicking another chapter re-prioritizes.
      const index = nextSegmentToSynthesize(progress, meta.chapters);
      if (index === null) {
        // Caught up on all main + focused work; extras stay on-demand.
        await setBookStatus(id, progress.errors > 0 ? "error" : "done");
        break;
      }

      const segment = segments[index];
      const startedAt = Date.now();
      try {
        await synthesizeSegment({
          targetText: segment.text,
          referenceAudioPath: reference.audioPath,
          promptTranscript: reference.transcript,
          workDir,
          outputM4aPath: segmentAudioPath(id, index),
        });
        await markSegment(id, index, "done", Date.now() - startedAt);
      } catch (err) {
        console.error(`[book ${id}] segment ${index} failed:`, err);
        await markSegment(id, index, "error");
      }
    }
  } catch {
    // e.g. profile not ready / no reference clip — surface as a failed book.
    await setBookStatus(id, "error").catch(() => {});
  } finally {
    running.delete(id);
  }
}

/** Start (or resume) background synthesis for a book. No-op if already running. */
export function startBookSynthesis(id: string): void {
  // Fire-and-forget: keeps running on the always-on local server across requests.
  void runBookSynthesis(id);
}

/** Resume every book that was mid-synthesis (e.g. after a server restart). */
export async function resumeInProgressBooks(): Promise<void> {
  const { listInProgressBookIds } = await import("@/lib/book-job");
  for (const id of await listInProgressBookIds()) startBookSynthesis(id);
}

# Audiobook Synthesis

Turn a whole book (EPUB / PDF, 50–100K words) into an audiobook in the user's
cloned voice. Synthesis runs in the background, segment by segment, so the user
can start listening from the first sentence while the rest is produced.

Surfaced in the studio as the **有聲書 / Audiobook** screen (gated on a ready
voice profile).

## Pipeline

```
upload .epub/.pdf
  → extract (TOC → chapters + text)        lib/book-extract.ts
  → segment (chapters → ~40–220-char bits) lib/book-segment.ts
  → create job (persisted manifest)        lib/book-job.ts
  → background synthesizer (priority loop) lib/book-synthesizer.ts
        → synthesizeSegment() per segment  lib/clone-runner.ts  (VoxCPM2 hot worker → .m4a)
  → reader UI plays done segments,         components/BookReader.tsx
    waits on pending, polls progress
```

### Extraction — `lib/book-extract.ts`
- **EPUB**: reads the Table of Contents (NCX, or EPUB3 `nav`) for real chapter
  titles and order — not raw spine order (which surfaces cover/copyright pages).
  Falls back to spine if no TOC. Near-empty pages (`<8` chars, e.g. a cover) are
  dropped. Text via `fflate` (unzip) + `node-html-parser`.
- **PDF**: `unpdf` text extraction; treated as a single chapter (PDFs lack
  reliable chapter structure). Scanned-image PDFs (no text layer) are rejected.
- **Chapter kind** (`classifyChapter`): `chapter` = main content (第N章 /
  Chapter N / numbered) → auto-synthesized; `extra` = front/back matter
  (foreword, reviews, afterword) → **on-demand only**.

### Segmentation — `lib/book-segment.ts`
Splits each chapter into zh-Hant/English sentences and packs them into
`[minChars, maxChars]` (default 40–220) segments. Never splits mid-sentence
except a pathologically long sentence (comma fallback). Pure + unit-tested.

### Job model — `lib/book-job.ts`
Per book under `<runs>/books/<id>/` (paths are **absolute** — the hot worker is
a separate process):
- `book.json` — meta: title, format, **chapters (with `kind`)**, segmentCount.
- `segments.jsonl` — immutable `{index, chapter, text}` per line.
- `progress.json` — small, rewritten per segment: `statuses[]`,
  `done`/`errors`, `focusChapter`, `autoResume`, synthesis timing.
- `audio/000123.m4a` — synthesized segment audio.

Storage is split so per-segment progress writes stay cheap at 100K-word scale.

### Background synthesizer — `lib/book-synthesizer.ts`
In-process resumable loop (`runBookSynthesis`), one segment at a time via the
VoxCPM2 hot worker, marking each `done`/`error` and recording timing. A
module-level `running` set prevents duplicate loops.

**Priority scheduler** (`nextSegmentToSynthesize`), re-read each iteration:
1. the **focused** chapter's pending segments (clicking a chapter jumps the queue),
2. otherwise main chapters in TOC order.
3. **Extras synthesize only when focused** (on demand) — the foreword isn't
   produced unless opened.

When the queue is caught up (extras left on-demand), the book is marked `done`.

## API — `app/api/books/...`
- `POST /api/books` — upload + extract + segment + create + start. Requires a
  ready voice profile (409 otherwise).
- `GET /api/books` — list the user's books with progress (auto-resumes in-flight ones).
- `GET/DELETE /api/books/[id]` — owner-scoped detail (meta + progress + segment
  texts + ETA) / delete.
- `POST /api/books/[id]/control` — `{action}`:
  - `pause` / `resume` (resume also retries errored segments),
  - `focus {chapter}` — prioritize a chapter (and synthesize an extra on demand),
  - `autoResume {enabled}` — toggle background auto-resume.
- `GET /api/books/[id]/control` — progress + ETA poll (keeps the loop alive).
- `GET /api/books/[id]/segments/[index]` — owner-scoped segment `.m4a`, HTTP
  Range (206); 404 while pending so the player can poll + retry.

## Reader UI — `components/BookReader.tsx`
- Shelf: upload + per-book progress.
- Reader: continuous player that plays `done` segments in order, **waits** on
  pending ones (polling), **skips** errored ones; follow-along sentence text;
  speed 1×/1.25×/1.5×/2×.
- Chapter list: real titles, `附錄` badge + `點擊合成` for on-demand extras,
  `● 合成中` on the active chapter, per-chapter done counts. Clicking a chapter
  focuses it (prioritizes synthesis + seeks playback there).
- Header shows progress + a rough **ETA** once timing is known.
- **自動繼續 (auto-resume) toggle** + context-aware pause/resume button.

## Background execution & resume
Synthesis is **server-side** — closing the browser tab does not stop it.
- **Survives server restart**: `instrumentation.ts` resumes every in-flight
  book (with auto-resume on) on startup.
- **Resumes on revisit**: shelf list, book open, and each progress poll
  idempotently re-start the loop (running-guard dedupes).
- **Auto-resume toggle** (per book, default on, persisted). When off, the
  server never auto-restarts; the reader offers a manual 繼續合成 button.

**Limit:** single in-process loop (ideal for an always-on Mac Studio), not a
crash-durable queue. If the process is killed mid-segment, that one segment
restarts on resume (segments are short). Per-segment progress is always
persisted, so completed work is never lost.

## Related playback work
- **Leading-artifact trim** (`scripts/synthesize_voxcpm_anyvoice.py:trim_leading_artifact`,
  applied in the hot worker too): VoxCPM2 emits a ~200ms phantom syllable + gap
  at the start of each generation; detected and trimmed to the real onset.
- **AAC/m4a playback**: synthesis output is transcoded to a small streaming
  `.m4a` (~11× smaller than the WAV); WAV stays available via
  `?format=wav` for download. See the audio route + `transcodeWavToM4a`.
- **HTTP Range streaming** on all audio routes so playback starts before full
  download (and Safari plays at all).

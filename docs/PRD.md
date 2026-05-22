# AnyVoice PRD — First-Principles Revision

> Revision date 2026-05-21. This supersedes the original alpha PRD (archived below as "Legacy v1") and reframes the product around the single irreducible job. It is a **refactor of the working app**, not a rewrite — every shippable change protects the existing VoxCPM2 worker, profile gate, audiobook pipeline, and safety contract.

---

## 1. Vision

AnyVoice turns *your* voice into a keyboard. Record yourself once (or hand it a clip), then anything you type comes back spoken in your voice — a line, a script, or a whole book. The promise is **type → hear yourself**, delivered in a warm, editorial, single-surface tool that never feels like a research console. The model quality (hi-fi VoxCPM2, eval gates, per-speaker LoRA) is real and hard-won, but it lives *behind* the product, not in front of the user.

## 2. Target user & top jobs-to-be-done

**Primary user:** a zh-Hant creator (podcaster, narrator, indie author, finance/news explainer) who wants narration in a specific voice — usually their own, sometimes a reference voice they have rights to — without a studio session every time.

Top 3 JTBD, in priority order:

1. **"Say this in my voice."** Type a line, hear it spoken in my voice, download/share it. (The 80% daily job.)
2. **"Give my voice to a whole book."** Drop an EPUB/PDF, get a back-pressure-free audiobook I can start listening to from sentence one.
3. **"Keep more than one voice."** Switch between "my voice", a co-host's voice, a reference YouTuber's voice — each named, each independently built.

## 3. First-principles rationale — keep / cut / merge

The irreducible loop is **voice in → text in → audio out**. Everything else is scaffolding the user should feel as little as possible.

| Decision | What | Why |
|---|---|---|
| **KEEP** | VoxCPM2 hot-worker hi-fi clone path, streaming progress, audiobook background synthesis, multi-profile store, zh-Hant strict-script safety, consent gates, run history. | These are the working spine and the differentiators. Do not touch the inference or safety contracts. |
| **KEEP, demote** | The 5/10-clip enrollment kit + strict eval/LoRA gates. | Necessary for a *durable* voice and the 10x quality claim — but it is the path to a **premium** voice, not the cost of entry. Today it is the only door. |
| **CUT from the primary surface** | The "Advanced · Developer" CLI card, the strict-vs-lenient framing, raw analyzer jargon ("VAD", "SNR", "low_snr") surfaced as user copy. | Incidental complexity. Engineers use the CLI; users never should. Keep the panel, move it behind a single "Developer" disclosure in settings. |
| **MERGE** | "Build my voice" + the voice switcher into one **Voices** surface. Upload-clone, YouTube import, and guided recording become three *ways to feed the same voice*, not separate mental models. | Today "upload + transcript = instant clone" is described in Generate copy but the Generate button is hard-gated on the multi-clip profile. That is the single biggest UX leak: the app promises instant and delivers a 5-step gate. |
| **NEW (small)** | A **Quick clone** tier: one clean clip + its transcript → immediately usable voice (zero-shot, the path the README already supports). Generate unlocks here. The 5/10-clip kit becomes an optional **"Make it studio-grade"** upgrade on the same voice. | Restores the 60-second delight without weakening the durable-voice gate for users who want it. The strict gate still governs LoRA/quality-gate/audiobook-at-scale claims. |

### The core leak being fixed
Generation is gated on `profileReady` (multi-clip strict profile). But the product's own headline copy says *"upload a clean recording and type exactly what it says — clones your voice instantly."* The user is promised instant and hits a wall. **P0 is to make that promise true:** a single consented clip + transcript yields a usable voice and unlocks Generate, with a clear, non-blocking "upgrade to studio-grade" path.

## 4. Information architecture

**Decision: two surfaces, not three. Plus a global voice picker.**

```
┌─ AnyVoice ─────────────── [Voice ▾]  EN/中  ☾ ─┐
│                                                │
│   STUDIO            (Generate + Audiobook,     │
│                      one continuous workspace)  │
│   VOICES            (build / feed / manage      │
│                      every voice profile)       │
└────────────────────────────────────────────────┘
```

- **Global voice picker** lives in the top bar, always visible, available on every screen (today it's buried inside Build). Switching voice is the most frequent multi-profile action and must be one tap from anywhere.
- **Studio** = type-to-speak *and* book-to-audiobook in one place. Audiobook is not a separate top-level mode; it is "speak a whole book" — a second input affordance (text box vs. file drop) feeding the same engine and player. This collapses today's 3 nav items to 2.
- **Voices** = everything about *making* a voice exist: quick clone (clip + transcript), guided recording kit, YouTube import, rename/delete, and the optional studio-grade upgrade with its readiness checklist.

Why not keep 3 screens: "Generate" and "Audiobook" are the same job at two lengths. Splitting them doubles the nav cost and hides the audiobook behind a gate the user already passed. Why not collapse to 1: building a voice is a genuinely different mode (mic, scripts, consent) and deserves its own room.

## 5. Core flows

### Flow A — Quick clone → first generation (the 60-second flow, P0)
1. First run lands on **Voices**, empty state: "Make your first voice." Two equal cards: **Record a clip** / **Upload a clip**. (YouTube import is a third, secondary option.)
2. User uploads or records one clean clip → types the verbatim transcript → ticks consent. *State: analyzing → ok / re-record (one honest reason).*
3. Voice becomes **Usable** (not yet Studio-grade). Toast: "Sunny is ready. Try saying something →" routes to **Studio**.
4. Studio: type a line → **Generate** (streaming progress: queued → preparing → synthesizing → ready) → autoplay + speed + download. *State: idle / busy(streamed phases) / done / needs_worker / error.*
5. Persistent, dismissible nudge on the voice: "Add 9 more lines to make this studio-grade." (optional, never blocking).

### Flow B — Studio-grade upgrade (today's strict path, demoted to opt-in)
1. From a Usable voice, user taps **Make it studio-grade**.
2. Guided 5-line (standard) or 10-line (extended) kit, one card at a time: prompt + pronunciation cues + record button with the 6–20s live meter (existing, good). *State per line: pending / recording(meter) / processing / passed / re-record.*
3. Progress ticks fill; on completion the voice flips to **Studio-grade ✓** and unlocks high-confidence audiobook-at-scale + (developer) LoRA/quality-gate paths.
4. All eval/LoRA/quality-gate work stays in the CLI, surfaced read-only behind a single **Developer** disclosure.

### Flow C — Audiobook (keep pipeline, re-home under Studio)
1. In **Studio**, switch input from "a line" to "a book" (tab/segmented control). Drop EPUB/PDF. *Requires at least a Usable voice; recommends Studio-grade for length.*
2. Extract → segment → background synth starts; reader plays from sentence one, waits on pending, skips errored. Chapter list, ETA, auto-resume, pause/resume — all existing BookReader behavior, unchanged.

### Flow D — Multi-profile
1. Top-bar **Voice ▾** lists every voice with status dot (Usable / Studio-grade). Switch is instant and global.
2. "+ New voice" opens Voices in create mode. Rename/delete live in Voices, not in a row of ghost buttons.

## 6. UX principles

1. **Type → hear yourself.** Optimize ruthlessly for the loop; everything else is a disclosure.
2. **Usable before perfect.** One clip unlocks the product; quality is an upgrade, never a toll gate.
3. **Honest single-reason states.** Every rejection says exactly one thing the user can act on ("Only 4.2s — read for at least 6s"). Never surface raw analyzer codes.
4. **The model is invisible.** No CFG/timesteps/LoRA/eval vocabulary on the primary surface. Developer truth lives behind one disclosure.
5. **Editorial calm.** Cream canvas, serif headlines, coral used scarcely. Dark surfaces only for runtime/output truth (the player, progress). No emoji icons, no gradients.
6. **zh-Hant first, English a tap away.** System theme by default.
7. **Consent is close to the action and unambiguous**, on every voice-ingest path.

## 7. Success signals

- **Time-to-first-audio (TTFA):** < 90s from first load to first played clip via Quick clone. (Today: effectively unbounded — blocked by the 5-clip gate.)
- **Quick-clone → generation conversion:** % of new voices that produce ≥1 generation within the session.
- **Upgrade rate:** % of Usable voices that voluntarily become Studio-grade (signals the upgrade framing works without forcing it).
- **Audiobook start latency:** time from upload to first playable segment.
- **Re-record loops per enrolled line:** lower = clearer rejection copy.

## 8. Non-goals

- No impersonation workflows, no hidden-consent bypass, no public gallery of cloned voices. (Unchanged.)
- No serverless-only VoxCPM2 promise; inference stays on the GPU/Mac Studio worker.
- No surfacing of LoRA/quality-gate/backend-shootout tooling as user-facing features — they remain CLI + a read-only Developer disclosure.
- No auto-transcription as the source of truth for enrollment transcripts (the strict-transcript contract stays; YouTube caption capture is the only assisted path and is correctable).
- No removal of the strict zh-Hant script safety gate.

## 9. Prioritized change list

### P0 — make the promise true (highest leverage, smallest blast radius)
- **P0.1 Quick-clone unlock.** Treat a single consented clip + verbatim transcript as a *Usable* voice that unlocks Generate, exactly as the headline copy already promises. The strict multi-clip profile becomes the *Studio-grade* tier, not the entry gate. (Server already supports zero-shot from one clip; this is primarily a gating + state change.)
- **P0.2 Two-status model.** Replace binary `profileReady` with `Usable` / `Studio-grade`. Generate + single-line Studio require Usable; audiobook-at-length + LoRA require Studio-grade.
- **P0.3 Global voice picker.** Move the profile switcher into the top bar, visible on every screen.
- **P0.4 Hide developer surface.** Move the "Advanced · Developer" CLI card behind a single collapsed **Developer** disclosure in Voices; never on Studio.

### P1 — IA consolidation
- **P1.1 Merge to two surfaces:** **Studio** (Generate + Audiobook as one workspace with a line/book input toggle) and **Voices** (build/feed/manage). Drop the third top-level nav item.
- **P1.2 First-run empty state** on Voices: "Make your first voice" with Record / Upload as equal cards, YouTube secondary.
- **P1.3 Upgrade nudge** on Usable voices: non-blocking "Make it studio-grade (+9 lines)".
- **P1.4 Unify ingest copy.** One mental model: recording, upload, YouTube are three ways to *feed a voice*, shown together in Voices.

### P2 — polish & trust
- **P2.1 Single-reason rejection copy** audit across enroll/upload/YouTube; kill raw analyzer codes in UI.
- **P2.2 Voice status dots** (Usable / Studio-grade) in the picker and Voices list.
- **P2.3 Progress phase labels** humanized in zh-Hant (queued/preparing/synthesizing/ready) with an honest ETA on long generations and audiobooks.
- **P2.4 Consent affordance** consistency across all three ingest paths (same component, same placement).
- **P2.5 Studio-grade benefits** copy: state plainly what the upgrade buys (stability, long-form, downloadable studio quality) so the opt-in is informed.

---

## Appendix — Legacy v1 (archived)

The original alpha PRD framed AnyVoice as a Vercel-hosted UI + separate GPU VoxCPM2 worker with a single record/upload → target-text → consent → playback flow, reference-only and "ultimate" (prompt+reference+transcript) modes, `ANYVOICE_STUB` worker-missing state, and a hard consent checkbox. That contract is intact and is the foundation this revision builds on; see README.md for the full runtime/worker/eval surface.

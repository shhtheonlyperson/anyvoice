# AnyVoice PRD — Handoff-Grounded Revision

> Revision date 2026-05-22. **This supersedes the prior first-principles PRD** (archived intent below as "Legacy intent"). The high-fidelity design handoff at `.handoff/design_handoff_anyvoice/` is now the **design source of truth**. This PRD describes the product the handoff specifies, maps each surface to the existing backend, and flags every gap between design and backend so engineering can scope it.
>
> Guiding constraint: this is a **refactor of the working app**, not a rewrite. The VoxCPM2 worker, the two-status profile model (`usable` / `studioGrade`), the audiobook pipeline, the consent gates, and run history are the working spine and must not be broken by the UI port.

---

## 1. Vision

AnyVoice turns *your* voice into a keyboard. Build a voice once (record 24 guided lines, paste a YouTube URL, or upload a clip), then anything you type comes back spoken in that voice — a line, a script, or a whole book. The promise is **type → hear yourself**, delivered in a warm, editorial, single-surface workspace that never feels like a research console. The hard-won model quality lives *behind* the product, not in front of the user.

Positioning: a **playground for personal & research use**. Voices are device-local. YouTube import is allowed only with an explicit playground-use acknowledgement.

## 2. Target user & top jobs-to-be-done

**Primary user:** a zh-Hant creator (podcaster, narrator, indie author, finance/news explainer) who wants narration in a specific voice — usually their own, sometimes a reference voice they hold rights to — without a studio session every time.

Top JTBD in priority order:

1. **"Say this in my voice."** Type a line, hear it in my voice, download/share. (The 80% daily job — the Generate tab.)
2. **"Give my voice to a whole book."** Drop an EPUB/PDF, get a back-pressure-free audiobook playable from segment one. (The Audiobook tab.)
3. **"Build / keep more than one voice."** Switch between "my voice", a co-host, a reference YouTuber — each named, each with its own fingerprint and build state. (The rail + Build tab.)

## 3. Information architecture (per handoff README)

**Decision: a persistent workspace shell — left rail (280px) + topbar (60px) — with three topbar tabs.** This replaces the prior "two surfaces + global picker" sketch and the current single-page `VoiceCloneStudio`.

```
┌─ Workspace shell ───────────────────────────────────────────────┐
│  Left rail (280px)         │   Top bar (60px)                    │
│   • Brand (spike + wordmark)│    Tabs: Build / Generate / Book   │
│   • Voices section + (+)    │    Lang toggle · Theme · Help      │
│     – VoiceMark fingerprint │                                    │
│     – status dot + label    │   Page area (scroll)               │
│     – source icon (YT/upload)│                                   │
│   • Library section         │                                    │
│     (Generations / Audiobooks / Datasets)                        │
│   • User footer             │                                    │
└──────────────────────────────────────────────────────────────────┘
```

- The **active voice in the rail drives the Build tab**. In Generate and Audiobook the user picks a voice via a pill picker; the active rail voice is the default.
- **Tabs:** `建立聲音 / Build voice`, `生成 / Generate`, `有聲書 / Audiobook`.
- **Defaults:** locale **zh-Hant**, theme follows system preference (light/dark both shipped). Language is a topbar toggle (中 / EN); all visible strings flow through the i18n keyset.

## 4. Screens

### 4.1 Build voice — adaptive, five sub-states

Single page; `activeVoice.status` selects one of five sub-states. Header is always present: eyebrow `聲音檔案 / voice profile`, Fraunces H1 (title varies by state), lede (≤560px), and right-side Rename / Export / Delete ghost buttons (hidden in `importing`).

| State | Trigger | Visual |
|---|---|---|
| `empty` | status `empty`, 0 lines | Cream status card, "Start recording" CTA, empty-zone with 3 options |
| `importing` | new voice from YT/upload | Dark status card, live waveform, 3-step progress (capture → transcribe → build signature) |
| `recording` | local `mode === recording` | Dark recording stage (live waveform, 64px record button, timer, coach copy) + phoneme-coverage sidecar (40 IPA cells) |
| `reviewing` | 1–23 of 24 lines done | Cream status card with 64px ink donut + Continue/Pause CTAs |
| `ready` | all 24 lines done | Coral hero card, white donut + check, Listen back / Start generating |

Below the status panel (in `recording` / `reviewing` / `ready`): the **24-line list** — number + status dot (`pass`/`retry`/`fail`/`todo`/`recording`), line text, a 28-bar micro-waveform whose color matches quality, duration, Play and Re-record buttons. **Status dot color, waveform color and quality verdict are one source of truth** (`speechQuality()` in the handoff; the model's real assessment in production).

### 4.2 Generate

- **Composer:** cream wrapper around a borderless textarea; toolbar with the voice-picker pill (with VoiceMark), three draggable dials (**Pace** slow/natural/brisk · **Warmth** cool/even/warm · **Breaths** 0.00–0.80s), char/seconds counter, primary Generate button.
- **Result player (dark):** eyebrow "Result" + voice fingerprint, time, full-width 120-bar speech waveform with played/cursor states, round play button, speed group (1× / 1.25× / 1.5× / 2×), Volume / Share / WAV / Regenerate.
- **Recent list** with subtabs Recent / Favorites / Shared; rows show 2-line text clamp, fingerprint + name · timestamp · duration, mini-wave, share/copy/more.

### 4.3 Audiobook

- **Library:** wide 60/40 split — 3-column book grid (tall dark cover with Chinese title in Fraunces + spike accent, title/author, coral progress bar + mono segment counter, trailing `+` upload card) and a "How it works" cream card (01/02/03 steps).
- **Reader:** `240px chapter rail | reader body`. Rail = chapter list with status dots (`ready`/`gen`/`queued`) + a dark **generation-queue card** with live percentages. Body = book hero, **Now playing** card (cream, with a dark inset 140-bar waveform + Prev/Play/Next + speed), and a line-numbered transcript with the current segment highlighted.
- **Sticky player bar:** dark, `position: sticky; bottom: 24px`, with play / chapter·book·voice·time / progress bar.

### 4.4 Create voice modal

`+` in the rail opens a modal. Step 1 = 3 chooser cards (Record ~12 min · YouTube ~15 s · Upload ~30 s) + device-local disclaimer. Step 2 branches:
- **Record:** name + language chips (繁中/EN/日) + guide card → Start recording (creates `empty` voice, routes to Build).
- **YouTube:** amber playground-only warning, URL input, auto-parsed preview card (channel/title/timestamp), name (auto-fills channel), **required** acknowledgement checkbox → Build voice clone (creates `importing` voice).
- **Upload:** name + drag-drop area → Continue (creates `importing` voice).

### 4.5 First-run modal

Translucent backdrop, 540px card, "Three minutes from here to a voice that's yours", 3 numbered steps, Later / Start.

## 5. Backend mapping & gaps

Legend: **Real** = backend supports it today · **Adapt** = backend exists, shape/contract differs · **Gap** = design-only, needs new backend or graceful fake.

| Design surface | Backend today | Status | Notes |
|---|---|---|---|
| Rail voice list (name, status, source, fingerprint) | `GET /api/voice-profile/profiles` → `{id, displayName, status, usable, studioGrade, meetsRequirements, clipCount}`; per-voice `GET /api/voice-profile?profileId=` | **Adapt** | List has `usable`/`studioGrade`, **not** the design's 4-state `empty/importing/building/ready` enum, nor `source`, `hash`, `lang`, `lineCount`. Map: `status===ready || meetsRequirements→ready`, `clipCount===0→empty`, else `building`; `studioGrade` is the stricter long-form/audiobook gate. `importing` is a transient client/job state. |
| VoiceMark fingerprint (16-bit `hash`) | none | **Gap** | Persist a stable `hash` per profile in `meta.json` (e.g. hash of `id`). Backend-cheap; do it for real so the mark survives serialization. |
| Build — recording 24 guided lines | recording-kit: `recording-kit` (cue sheet), `recording-kit/preflight`, `…/check`, `…/normalize`, `…/microphone-smoke-test`, `…/cue-sheet`; prompt sets `standard` / `extended` | **Adapt** | Kit is **CLI/file-oriented** (records to local files via a Python script, returns cue-sheet HTML + shell commands). It is **not** a browser recorder of 24 lines with per-line dots. The "24 guided lines" pack is a **design construct**; backend has prompt sets but not a per-line in-browser record/grade loop. Largest Build-tab gap. |
| Build — enroll a recorded clip | `POST /api/voice-profile/enroll` (multipart) | **Real** | Enroll persists a clip+transcript into the profile and recomputes status. |
| Build — line quality dots (`pass/retry/fail`) | `recording-kit/check`, `reanalyze`, `verify`, `transcript-validation`, clip `quality.grade` (A/B…) | **Adapt** | Backend grades whole clips (A/B grade, SNR, VAD, coverage), not 24 named lines. Map grade→dot, or fake per-line until a per-line record loop exists. |
| Build — phoneme coverage sidecar (40 IPA cells) | `text-prep` coverage features + pronunciation presets (`detectVoiceProfileCoverageFeatures`) | **Adapt** | Backend tracks *coverage features* and *pronunciation presets*, not IPA-phoneme counts. Render the sidecar from coverage features, or keep the deterministic `buildCoverage()` fake for v1. |
| Build — importing (YT/upload) 3-step progress | `POST /api/voice-profile/enroll/youtube` (consent-gated), `POST /api/voice-profile/import` | **Adapt** | Endpoints exist and YouTube is consent-gated to match the design's acknowledgement. The handoff's fixed **4.2 s auto-promote** is a mock; wire real job progress (poll/stream) for the 3 steps. |
| Build — Rename / Export / Delete | `PATCH`/`DELETE /api/voice-profile/profiles/[id]` (rename via displayName, delete) | **Adapt / Gap** | Rename + delete are real. **Export** (download the voice profile/clips) has no endpoint → Gap. |
| Generate — composer + Generate | `POST /api/clone` (+ `…/stream`) multipart: `voice`, `targetText`, `promptTranscript`, `quality`, `consent`, `sourceKind`, `profileReference` | **Adapt** | Real synthesis with streaming progress. Today it takes a profile reference + transcript, **not** a simple `{profileId, text}`. UI resolves the active voice → profile reference (the server already does clip selection via `selectVoiceProfileClipForTarget`). |
| Generate — Pace / Warmth / Breaths dials | `quality` preset only (`speed`/`balanced`/`quality`) | **Gap** | No pace/warmth/breath params on the worker. Recommend: ship the dials visually, persist intent, treat as **no-op with honest tooltip** until the worker exposes controls (or map Pace→a real speed param if/when added). |
| Generate — Recent / Favorites / Shared | `GET /api/runs`, `GET /api/runs/[jobId]/audio` | **Adapt** | Run history backs "Recent". **Favorites** and **Shared** have no backing → Gap (local-only flag / share to defer). |
| Generate — WAV download / Share | run audio endpoint exists | **Adapt** | WAV = real download of run audio. Share link = Gap (defer to copy-of-local-URL). |
| Audiobook — library + upload | `GET /api/books`, `POST /api/books` (multipart EPUB/PDF) | **Real** | Returns book meta with chapters + segmentation. |
| Audiobook — reader, segments, queue, progress | `GET /api/books/[id]` (meta+progress+segments+eta), `…/segments/[index]`, `…/control` (play/pause/resume synthesis) | **Real** | Background synthesis, ETA, per-segment audio, chapter statuses all real. **Reuse the existing `BookReader.tsx` inside the Book tab** rather than rebuilding. |
| Create voice modal → create | `POST /api/voice-profile/profiles` `{displayName}` | **Adapt** | Creates an empty named profile. Record path → create then route to Build. YT/Upload path → create then call enroll/youtube or import. Modal's `lang`/`source` fields are ignored by the API → store client-side or extend `meta.json`. |
| Sticky player / Now-playing waveform (140 bars) | per-segment audio | **Adapt** | Waveform is currently math; plumb real RMS later, keep speech-shaped fallback for loading. |

### Top gaps (engineering must scope)
1. **24-line in-browser record-and-grade loop** — the backbone of the Build tab — does not exist; today's kit is CLI/file-based. Biggest gap.
2. **Pace / Warmth / Breaths** generation controls — no worker params.
3. **Per-voice `hash` fingerprint** — must be persisted for VoiceMark.
4. **Status enum mismatch** — backend `usable`/`studioGrade` vs design `empty/importing/building/ready`.
5. **Export voice, Favorites, Shared, share links** — no backing.
6. **Phoneme/IPA coverage** — backend tracks coverage *features*, not IPA cells.

## 6. Success signals
- Time-to-first-generation for a new user (record/import → first heard line) under a few minutes.
- A user keeps ≥2 named voices and switches between them.
- A book reaches "playable from segment one" without waiting on full synthesis.
- zh-Hant users never see raw analyzer jargon (VAD/SNR/grade) in primary UI.

## 7. Non-goals
- Not a commercial impersonation tool. Playground / personal / research only.
- No account system or cloud voice storage in scope — voices stay device-local.
- No public sharing marketplace (Shared subtab is local-only for now).
- Do not surface developer/CLI affordances on the primary surface.

---

## Legacy intent (archived)
The prior revision proposed a two-surface IA (Studio + Voices) with a global voice picker, and a "Quick clone" tier to fix the instant-clone leak. The handoff instead specifies a three-tab shell (Build / Generate / Book) with a voice rail. The underlying fix still holds: a single consented clip + transcript yields a `usable` voice that unlocks Generate, while `status`/`meetsRequirements` means this profile's own tier is complete. `studioGrade` remains the strict long-form/audiobook gate.

# AnyVoice — Handoff Port Spec

> Engineering plan to port the high-fidelity design handoff (`.handoff/design_handoff_anyvoice/`) onto the existing Next.js (App Router) + React 19 + TS app. The handoff JSX is a **reference, not code to copy** (it runs on in-browser Babel + React 18 CDN). Recreate each component using our patterns. **Do not regress** the working backend (clone worker, profiles, books, run history) or the existing `components/BookReader.tsx`.

This spec pairs with `docs/PRD.md` (vision/IA/gaps). Read both.

---

## 0. Ground truth already in our favor

- **Design tokens already match.** `app/globals.css` and `~/DESIGN.md` already carry the exact handoff palette/type/radii — just **without** the handoff's `--color-` prefix (we use `--canvas`, `--primary`, `--surface-dark`, etc.; handoff uses `--color-canvas`, `--color-primary`, `--color-surface-dark`). Dark theme is on `[data-theme="dark"]` (handoff uses `.theme-dark`). So the CSS job is mostly **a token-name aliasing/reconciliation pass**, not a new design system. See §3.
- **Fonts** (`--serif`/Fraunces, `--sans`/Inter, `--mono`/JetBrains Mono) are already wired.
- The handoff's `speechBars`/`speechQuality`/VoiceMark math is pure and portable verbatim into a TS util.

---

## 1. Component inventory (handoff JSX → our components)

Target tree under `components/anyvoice/` (new namespace), composed by a new client root that replaces `VoiceCloneStudio` at `app/page.tsx`. Keep `VoiceCloneStudio.tsx` in the tree until the shell reaches parity, then retire it.

| New component (TS) | Recreated from | Composes / notes |
|---|---|---|
| `AnyVoiceApp.tsx` (client root) | `src/main.jsx` | Owns app state: `voices`, `activeVoiceId`, `activeTab`, `lang`, `theme`, modals. Replaces in-page `App`. Mount from `app/page.tsx`. |
| `WorkspaceShell.tsx` | `src/shell.jsx` | Rail (280px) + topbar (60px) + page slot. Props: voices, active ids, tab, lang, theme, callbacks. |
| `VoiceRail.tsx` (+ `VoiceRailItem`) | `src/shell.jsx` rail block | Voice list with VoiceMark + status dot + source icon + speaking indicator; Library nav; user footer; collapse. |
| `Topbar.tsx` | `src/shell.jsx` topbar block | Tabs (Build/Generate/Book), lang toggle, theme toggle, help. |
| `VoiceMark.tsx` | `src/components.jsx` `VoiceMark` | Deterministic radial SVG from `hash`. Pure. |
| `waveforms.tsx` | `src/components.jsx` | `LiveWaveform`, `StaticWaveform`, `MiniWaveform`, `Donut`, `RippleViz`, `Progress`. `Live`/`Ripple` use rAF → `"use client"`. |
| `lib/speech-viz.ts` | `src/components.jsx` | Port `rng`, `speechBars`, `speechQuality` as pure TS. Single source of truth for dot color + waveform shape. |
| `BuildTab.tsx` | `src/build.jsx` `BuildPage` | State machine: empty/importing/recording/reviewing/ready. |
| `build/StatusPanel.tsx` | `StatusPanel` | Empty / reviewing (donut) / ready (coral hero) variants. |
| `build/RecordingStage.tsx` | `RecordingStage` | Dark stage, live waveform, record button, timer, coach. |
| `build/ImportingStage.tsx` | `ImportingStage` | Dark card, 3-step progress; driven by real job progress (not the 4.2s timer). |
| `build/PhonemeCoverage.tsx` | `PhonemeCoverage` | 40-cell sidecar (recording state). |
| `build/LinesList.tsx` | `LinesList` | 24 rows; dot+waveform color from `speechQuality`. |
| `GenerateTab.tsx` | `src/generate.jsx` `GeneratePage` | Composer + result player + recent. |
| `generate/Dial.tsx` | `Dial` | Draggable mini-slider (pointer events). |
| `generate/VoicePicker.tsx` | `VoicePicker` | Pill + dropdown; ready voices only. |
| `generate/ResultPlayer.tsx` | `Player` | Dark player, speed group, actions. |
| `generate/RecentRow.tsx` | `RecentRow` | Recent/Favorites/Shared rows. |
| `AudiobookTab.tsx` | `src/audiobook.jsx` | Library grid + reader. **Wrap/reuse existing `BookReader.tsx` for the reader body** if its behavior matches; otherwise reskin it to match the handoff and keep its data wiring. |
| `audiobook/StickyPlayer.tsx` | sticky player block | `position: sticky; bottom: 24px`. |
| `CreateVoiceModal.tsx` | `src/create-voice.jsx` | 3-path modal. |
| `FirstRunModal.tsx` | `src/main.jsx` `FirstRunModal` | Optional, P2. |
| `lib/i18n.tsx` (or reuse existing) | `src/i18n.jsx` | Port the full keyset; zh default, `{var}` interpolation, `voiceSubtitle()`. Check whether the app already has an i18n provider before adding one. |
| `lib/icons.tsx` | `src/icons.jsx` | Line icons (1.75px stroke). Or map to an existing icon set if present. |

**Server vs client:** the shell and all interactive tabs are client components (`"use client"`). Data fetching should happen in client hooks (`useEffect`/SWR-style) hitting the existing route handlers, OR via thin server components that pass initial data down — pick whichever the repo already does for `VoiceCloneStudio`. Pure helpers (`speech-viz.ts`, VoiceMark math, i18n strings) stay framework-agnostic.

---

## 2. Data wiring (screen → endpoint)

Define a typed client layer (`lib/anyvoice-client.ts`) wrapping fetches; never call routes ad hoc from components.

| Screen action | Endpoint | Wiring notes |
|---|---|---|
| Load rail voices | `GET /api/voice-profile/profiles` | Map `{status,usable,studioGrade,meetsRequirements,clipCount}` → UI status: `clipCount===0→empty`, `status===ready || meetsRequirements→ready`, else `building`. `studioGrade` remains the strict long-form/audiobook gate. `importing` is a client-only transient. |
| Per-voice detail (Build) | `GET /api/voice-profile?profileId=` | summary (usable/studioGrade/requirements/diagnostics). |
| Create voice | `POST /api/voice-profile/profiles {displayName}` | Then route by source. |
| Record path enroll | `POST /api/voice-profile/enroll` (multipart) | Per-clip enroll. The 24-line loop is the gap (§4). |
| YouTube import | `POST /api/voice-profile/enroll/youtube {url,consent:"yes",startSeconds,durationSeconds}` | Consent gate matches the modal checkbox. Drive ImportingStage from real progress. |
| Upload import | `POST /api/voice-profile/import` (multipart) | Same ImportingStage. |
| Rename | `PATCH /api/voice-profile/profiles/[id] {displayName}` | Real. |
| Delete | `DELETE /api/voice-profile/profiles/[id]` | Real. |
| Export | — | **Gap**; hide or stub the Export button initially. |
| Generate | `POST /api/clone` and `POST /api/clone/stream` (multipart) | Send `voice`/`profileReference`, `targetText`, `promptTranscript`, `quality`, `consent:"yes"`, `sourceKind:"profile"`. Stream for progress. |
| Recent list | `GET /api/runs`, audio via `GET /api/runs/[jobId]/audio` | Real "Recent". |
| Books library / upload | `GET /api/books`, `POST /api/books` (multipart) | Real. |
| Book reader / segments / control | `GET /api/books/[id]`, `…/segments/[index]`, `POST …/control` | Real; back the existing `BookReader`. |

### Mock-only fields — recommendation
| Field | Recommendation |
|---|---|
| `hash` (VoiceMark) | **Implement for real** — persist in `meta.json` (cheap; deterministic from id). |
| `pace` / `warmth` / `breaths` | **Fake gracefully** — render dials, persist intent, no-op with honest tooltip until worker supports params. Do NOT block Generate on them. |
| 24-line guided pack + per-line dots | **Defer the real loop**; v1 derives dots from clip grade or shows the pack as a guided checklist over `enroll`. Flag as the headline follow-up. |
| Importing timing (4.2s) | **Implement for real** via job progress; never ship the fixed timer. |
| Phoneme/IPA coverage | **Fake gracefully** from `buildCoverage()` v1; later map to backend coverage features. |
| Favorites / Shared / share links | **Defer**; local-only flag for Favorites, hide Shared/share until backed. |

---

## 3. CSS strategy

Goal: bring the handoff look in **without forking the design system**. The palette is already ours.

1. **Do not ship `assets/claude.css` verbatim** (README says so). It re-declares tokens we already have.
2. **Reconcile token names.** Handoff components reference `--color-*`; our `globals.css` defines un-prefixed (`--primary`, `--canvas`, …). Two options — pick one and apply consistently:
   - **(Preferred) Rename in the ported components** to our existing token names as you transcribe each JSX file. No CSS change, single token vocabulary.
   - **(Alternative) Add a thin alias block** in `globals.css` mapping `--color-primary: var(--primary)` etc. for the handoff names actually used. Lower-effort transcription, but two vocabularies linger — only do this as a temporary bridge.
3. **Port the component-level CSS** (`.build-status`, `.rec-stage`, `.voice-item`, `.waveform-strip .bar`, `.dial`, `.player`, `.recent-row`, `.phoneme-cell`, sticky player, modal) from the handoff `app.css` into a scoped stylesheet (e.g. `components/anyvoice/anyvoice.css` imported by the shell, or CSS modules). Keep selectors namespaced to avoid clobbering existing `VoiceCloneStudio`/`BookReader` styles during the transition.
4. **Dark mode:** handoff uses `.theme-dark` on `<html>`; ours uses `[data-theme="dark"]`. Standardize on **`[data-theme]`** (already in `globals.css`) and translate handoff dark overrides into it. Default to **system preference** per project defaults, with the topbar toggle as override.
5. **Accent theming:** the handoff recomputes `--color-primary`/`-active` on accent change (Tweaks). Keep this optional; the shipped default is the coral pair. The Tweaks panel itself is **not** shipped (dev-only).
6. **Shadows:** single elevated value `0 6px 24px rgba(20,20,19,0.10)` on sticky player + modals only. No hover-lift stacks.

---

## 4. Build order

### P0 — Shell + one real tab (prove the architecture)
1. `lib/speech-viz.ts`, `VoiceMark.tsx`, `waveforms.tsx`, ported i18n + icons.
2. CSS reconciliation pass (§3 steps 1–4) + namespaced component CSS.
3. `WorkspaceShell` + `VoiceRail` + `Topbar`, wired to **real** `GET /api/voice-profile/profiles` (with status mapping) and persisted `hash`.
4. **Generate tab end-to-end real** (the 80% job): composer → `POST /api/clone/stream` → ResultPlayer; Recent from `GET /api/runs`. Dials present but no-op. This is the highest-value first slice and exercises the existing worker.
5. Mount `AnyVoiceApp` at `app/page.tsx`; keep `VoiceCloneStudio` importable as fallback until parity.

### P1 — Build + Audiobook on real data
6. **Build tab** states empty/reviewing/ready off real profile summary; Create-voice modal → `profiles` POST + record routing; **importing** state wired to real YouTube/import progress (replace 4.2s timer). Lines list dots derived from clip grade where available; 24-line record loop stubbed/guided.
7. **Audiobook tab**: library grid + upload (`/api/books`), reader **reusing `BookReader.tsx`** behind the handoff skin, sticky player, generation queue from `GET /api/books/[id]` progress.
8. Rename/Delete wired; Export hidden.

### P2 — Fidelity polish & deferred features
9. Phoneme sidecar, FirstRun modal, Favorites (local), real RMS waveforms, dial→worker params if backend gains them, full 24-line in-browser record-and-grade loop, Export endpoint, Shared/share links.

**Protect throughout:** never alter clone/worker or book route contracts; keep `BookReader` working; keep consent gates (YouTube acknowledgement + clone `consent:"yes"`).

---

## 5. Fidelity checklist (reviewer)

- [ ] **Rail** 280px; brand spike + wordmark; Voices section with `+`; Library nav; user footer; collapse works.
- [ ] **Status dots** in rail and lines list use the 5 states with correct colors (pass=success, retry=warning, fail=error, todo=hairline, recording=pulsing primary) and **agree with waveform color** (single `speechQuality` source).
- [ ] **VoiceMark** is deterministic per `hash`, 36 spokes, color by status (ready coral / building amber / empty muted), persists across reload.
- [ ] **5 Build states** render correctly and transition (empty→recording→reviewing→ready; importing for YT/upload with 3-step progress driven by real job, not a timer).
- [ ] **Generate** composer (cream wrap, borderless textarea), 3 dials draggable, voice pill with VoiceMark, char counter; dark result player with **120-bar speech waveform**, played/cursor states, speed group (1/1.25/1.5/2×), Volume/Share/WAV/Regenerate.
- [ ] **Sticky player** dark, `sticky; bottom:24px`, single elevated shadow; follows page in Audiobook reader.
- [ ] **Topbar** tabs + lang toggle (中/EN, default zh-Hant) + theme toggle (system default, light/dark both correct) + help.
- [ ] **Create-voice modal**: 3 chooser cards, YouTube path shows amber warning + parsed preview + required checkbox, Build disabled until URL+checkbox.
- [ ] **Typography:** Fraunces display ≤400 weight, Inter body, JetBrains mono numerals; eyebrows coral 11px uppercase on cream.
- [ ] **No dev-only surfaces** shipped (Tweaks panel, CLI/analyzer jargon).

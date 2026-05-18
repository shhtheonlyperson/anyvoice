# AnyVoice — Simplification log

A running record of every UI element we challenged, the 5-whys reasoning, the decision (CUT / KEEP / MERGE), and the bet behind it. New rounds are appended; nothing here is rewritten.

## Hard constants (never challenged)
- **Bilingual zh-Hant / EN** — required by `~/CLAUDE.md`.
- **Theme: light / dark / system** — required by `~/CLAUDE.md`.
- **Warm cream-canvas + coral design system** — `~/DESIGN.md`.
- **Consent gate** — `/api/clone` rejects requests without `consent=yes`. API-level legal gate.

Everything else is open to interrogation.

The user's north star, repeated verbatim:
> "The only 2 inputs I anticipate are (1) my voice input and (2) any text and use my voice."

## Round 1 — initial radical simplification (prior agent)

| Element | Decision | Rationale |
|---|---|---|
| Editorial kicker "Voice cloning console" | **CUT** | Marketing framing on a tool surface; PRD says no marketing preamble. |
| Editorial H1 with serif emphasis | **REPLACED** | Subtitle "錄一段你的聲音、輸入要說的字，按下產生。" promoted to H1; editorial framing dropped. |
| Subtitle paragraph | **CUT** | Was duplicated by the (new) H1; serves no further purpose. |
| Status chips (VoxCPM2 / Worker / Mode) | **CUT** | Runtime metadata; user already knows model from brand context. |
| Mode cards (Reference / Ultimate) | **CUT** | Auto-Whisper on the server makes every run Ultimate by default; mode is no longer a user decision. |
| Reference transcript textarea | **CUT** | Server fills it from Whisper; surfacing in UI is debugging-only. |
| Style hint input | **CUT** | The original implementation was a `(style)text` string-prepend hack; misleads users. |
| PRD link in app-bar | **CUT** | Footer keeps it; engineers can reach `/prd` directly. |
| Job / Model meta row in output | **CUT** | Engineering metadata; user wants playback, not metrics. |
| Reference grade badge (A/B/C/D) | **CUT** | Internal scoring; user-facing warning list already conveys actionable info. |
| Reference summary "12s clean speech…" line | **CUT** | Same — actionable warnings are enough. |
| Whisper transcript editor + Copy button | **CUT** | Debug surface, not user-facing. |
| "Use sample voice" reset button | **CUT** | Re-clicking Upload or Record covers the same intent. |
| Char counter "0 / 4096" | **CONDITIONAL** | Now only renders when length ≥ 80% of cap. |
| Target hint paragraph | **CUT** | The textarea + placeholder is self-evident. |
| Source hint paragraph (4 variants) | **CUT** (mostly) | Only the recording-state hint remains, and only during recording. |
| Source-label overline | **CUT** | Audio player + filename below is enough. |
| Footer "· VoxCPM2 Studio" descriptor | **CUT** | Decorative. |
| Advanced disclosure → Quality preset (Speed/Balanced/Quality) | **CUT** | Default Balanced is right for >99% of users; preset can come back if users ask. |

**Result:** 33 → ~21 visible elements (≈36% reduction).

## Round 2 — deeper interrogation (this pass)

The remaining elements after Round 1 still include several that are decorative, redundant, or default-correct. Each one is re-tested below.

| Element | Why it's here | Why the user needs it | First-principles test | Decision | Bet |
|---|---|---|---|---|---|
| **H1 "錄一段你的聲音、輸入要說的字，按下產生。"** | Replaced editorial copy with an instruction line. | First-time orientation. | The record button + textarea + Generate button are arranged in exactly that order. The H1 *describes* what's already visually obvious. Self-narrating UI is a smell. | **CUT** | The tool is self-evident; if a user can't infer "press record, type, hit Generate" from the layout, the layout itself is wrong — fix the layout, not by adding a sentence. |
| **Section h2「你的聲音」/「Your voice」** | Labels the dark booth. | A11y region naming + visual rhythm. | The dark booth contains a record button and an audio player. It IS the voice section. Visual label is redundant; a11y need is satisfied by `aria-labelledby` → visually-hidden h2. | **HIDE (visually)** | Keep h2 for screen readers, hide visually. Sighted users lose nothing they didn't already know. |
| **Section h2「要說的話」/「What to say」** | Labels the cream textarea card. | Same as voice. | Same as voice — the textarea with placeholder text IS the input. | **HIDE (visually)** | Same bet. |
| **Output h2「結果」/「Result」** | Labels the output card. | Status indication. | The card appears only after submit; its appearance IS the result indication. Status pill below already labels the state. | **CUT** | Card materializes only on submission, so the user already knows what they're looking at. |
| **Source name caption「示範聲音（小王子節錄）」** | Identifies the loaded clip. | "Did I record something or is this the sample?" | When sample is loaded, the user *just opened the page* — they know it's the sample. After recording, the caption switches to「瀏覽器錄音」, but the audio player above also has the filename. | **CUT (when sample)** | Conditional render: caption only after the user replaces the sample with their own audio. Reduces idle-state chrome. |
| **Footer "AnyVoice · PRD · openbmb/VoxCPM2"** | Brand + nav + model attribution. | Engineers want PRD; brand consistency. | End-user cloning a voice doesn't need any of this. PRD is reachable via `/prd`; brand presence is already in the app-bar; attribution to VoxCPM2 isn't legally required by the model license. | **CUT** | The footer was vestigial SaaS chrome. `/prd` survives as a direct URL. |
| **"AnyVoice" wordmark next to mark** | Standard brand-prefix pattern. | Identification for first-time users. | The mark is distinctive (4-bar sonogram with coral peak). The wordmark only matters before the brand is established. For a tool the user is *currently inside*, the mark alone identifies it. | **CUT (homepage)** | Keep wordmark on `/prd` (more text-document context). Homepage gets mark-only. Reversible. |
| **Theme toggle (3 separate buttons)** | Light / Dark / Auto. | Per CLAUDE.md, required. | Three buttons consume horizontal space. A single button that cycles through the three states preserves the requirement at one-third the chrome. | **MERGE → single cycle button** | Click cycles light → dark → system → light. Title attr explains current state. |
| **Recording near-limit copy (`recordingNearLimit` / `recordingAtLimit`)** | Warn the user about the 60s cap. | Avoid surprise at 60s. | These keys exist but the previous round removed their render path. They're orphaned. | **CUT (already orphaned)** | Remove dead copy keys. The visual timer turning amber at 52s is enough warning. |
| **Source-label overline (「聲音來源」)** | Labels what the strong-text below is. | Already cut in Round 1 — verify. | — | **(verified gone)** | — |
| **`sourceHint*` copy keys (idle/captured/sample variants)** | All cut from UI per Round 1. | — | Most are unused. | **CUT dead keys** | Trim copy dictionary. |
| **Sonogram + audio player both rendered** | Sonogram = "we have your voice"; player = "you can hear it." | Different jobs. | Could click the sonogram to play, removing the player. But native `<audio>` controls bring familiar scrub + volume + speed — recreating those in a custom widget is wasteful. | **KEEP both** | The reuse of native chrome > the cost of one extra UI element. |
| **The 4-bar sonogram brand mark** | Voice-product brand prefix. | Brand identifier. | The mark alone now carries the wordmark's old job. Distinct enough; do not flatten further. | **KEEP** | — |
| **Theme toggle existence** | CLAUDE.md mandate. | Required. | — | **KEEP (collapsed)** | — |
| **Locale toggle (EN button)** | CLAUDE.md mandate. | Required. | A single button toggles. Already minimal. | **KEEP** | — |
| **Generate button label** | Action. | Required. | Could just be the icon. But labels reduce ambiguity and the cost is one word. | **KEEP** | Reversible if we A/B test icon-only later. |
| **Consent text + checkbox** | API gate, legal. | Required. | The full sentence + small print preserve evidentiary symmetry across locales. | **KEEP** | — |
| **Recording timer (mm:ss / 60s cap)** | Active during recording only. | "How long have I been recording?" | Native MediaRecorder doesn't expose its own timer; users want this. | **KEEP** | — |
| **`sourceHintRecording` paragraph** | Single remaining state hint. | Tells user to press stop. | The visible Stop button on a recording-state booth IS the affordance. The hint is redundant. | **CUT** | — |

**Round 2 actions to apply:**
1. Cut H1.
2. Hide section h2s visually; keep them as `.visually-hidden` for a11y.
3. Cut output h2; rely on conditional render + status pill.
4. Conditional source-name caption (sample → hidden).
5. Cut footer entirely.
6. Remove "AnyVoice" wordmark text from homepage app-bar; mark only.
7. Collapse theme toggle (3 buttons → 1 cycle button).
8. Cut `sourceHintRecording` paragraph.
9. Garbage-collect orphaned copy keys (`sourceHintIdle`, `sourceHintCaptured`, `sourceHintSample`, `recordingNearLimit`, `recordingAtLimit`).
10. (Already this turn) Shorten default target text to "你好，這是我的聲音。" / "Hello, this is my voice."

**Predicted result:** ~21 → ~12 visible elements.

## Round 2 — applied

Verified with screenshot `/tmp/anyvoice-round2.png`. Above-the-fold inventory after Round 2:

| # | Element | Reason kept |
|---|---|---|
| 1 | Brand mark (4-bar sonogram glyph) | Brand identifier; wordmark cut |
| 2 | Theme cycle button (single icon) | CLAUDE.md mandate; collapsed 3 buttons → 1 |
| 3 | Locale button "EN" / "繁中" | CLAUDE.md mandate |
| 4 | Sonogram (real WAV peaks + playback cursor) | Affordance: "we have your voice" |
| 5 | Record button (coral) | Primary action #1 |
| 6 | Upload button (cream) | Alternative input |
| 7 | Audio player (native HTML5) | Playback of captured voice |
| 8 | Target textarea (with short default + placeholder) | Primary action #2 |
| 9 | Consent checkbox + sentence | API gate, legal |
| 10 | Generate button (coral) | Primary action #3 |

That's it. **10 visible elements** above the fold (down from ~33 at start, ~21 after Round 1).

Conditional / state-driven elements that only render when relevant:
- Recording timer (only while recording)
- Source name caption (only when user-uploaded or recorded — hidden for sample)
- Worker-missing notice (only when worker offline)
- Inline error banner (only on validation failure)
- Output panel (only after submit) → audio player + status pill + warnings list

## Round 3 — what's left to challenge

Walk through Round 2's 10 survivors. Each must justify itself again.

| # | Element | Round-3 challenge | Verdict |
|---|---|---|---|
| 1 | Brand mark | A logo is conventional; users on this page already know what product it is. Do we need it on the homepage at all? | **Borderline KEEP.** Coral peak in the mark is the only chroma in the empty header bar; removing leaves a slightly cold header. Worth A/B: with-mark vs naked. |
| 2 | Theme cycle | Required by CLAUDE.md. Cannot cut. | KEEP |
| 3 | Locale toggle | Required by CLAUDE.md. Cannot cut. | KEEP |
| 4 | Sonogram | This is the moment of "we have your voice." But the audio player below conveys the same fact with a duration indicator. Could remove the sonogram and let `<audio>` carry it. | **KEEP with reservation.** Sonogram is decorative more than functional; cutting wins ~120px of vertical space and removes one custom-widget responsibility. Open question for the user. |
| 5 | Record button | Primary input. | KEEP |
| 6 | Upload button | Alternative input for users with pre-recorded audio. | KEEP |
| 7 | Audio player | Only way to *hear* the captured voice. | KEEP |
| 8 | Target textarea | Primary input. | KEEP |
| 9 | Consent checkbox | API gate. | KEEP |
| 10 | Generate button | Primary action. | KEEP |

**Round 3 candidates flagged for user judgment (not auto-applied):**
- Cut the brand mark from the homepage (keep on `/prd`)
- Cut the sonogram (let the audio player below stand alone)

Both are reversible. Neither is *necessary* for cloning a voice. The argument against each is "is there any time the user genuinely needs to see this for their task?" Both fail that test mildly.

**My recommendation: cut the sonogram, keep the mark.** The mark is the brand presence in a minimal header bar; without it the bar looks decapitated. The sonogram is large (~132px), repeats info already conveyed by the audio player, and was originally justified as "shows we extracted real peaks" — but the user doesn't need to know we extracted peaks, only that we have their voice. Decision deferred to user.

## Bets we're making

- **Defaults are right for >99% of cases.** Auto-Whisper + Balanced quality + denoise-on-noise means most users don't need a single tunable knob.
- **The page is the tutorial.** Removing the H1 was the boldest bet: if you can't infer "record → type → press" from three labeled affordances, the layout is the problem.
- **Brand presence in a tool is decoration, not aid.** Cutting wordmark and footer assumes users already know they're on AnyVoice.
- **Coral is conserved.** Only the Generate button and the Record button carry coral; the consent gate no longer has its own coral band.

Each bet is reversible — none touches the API contract.

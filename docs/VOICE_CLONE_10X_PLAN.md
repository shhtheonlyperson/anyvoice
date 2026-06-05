# AnyVoice Digital Voice Clone 10x Plan

## Recommendation

Do not keep trying to make the current "stable voice" preset stable by nudging
CFG, denoise, or timesteps. The current product is a zero-shot prompt clone:
one browser recording, one transcript, one target text. That is useful for a
demo, but it is not yet a durable digital voice clone.

The 10x path is:

1. Fix the VoxCPM2 call path and text pipeline first.
2. Add a repeatable eval harness so each change has a pronunciation and speaker
   similarity score.
3. Build a per-user voice profile from multiple clean enrollment clips.
4. Train or load a small per-speaker LoRA when enough consented audio exists.
5. Evaluate a second backend, with IndexTTS2 first, if zero-shot pronunciation
   still beats VoxCPM2.

## Current Diagnosis

Before the M0 patch, AnyVoice sent:

- `text`: user target text
- `prompt_wav_path`: the same user recording
- `prompt_text`: exact transcript of that recording
- no `reference_wav_path`

That made the model rely on the prompt as both pronunciation alignment and
voice identity. Brenda's more stable path uses separate prompt/reference assets
and passes both `prompt_wav_path + prompt_text` and `reference_wav_path`.
VoxCPM2's current docs also call that the higher-fidelity path.

The current app also lacks:

- a per-user voice profile with multiple enrollment clips;
- a pronunciation eval set;
- a speaker similarity score;
- deterministic candidate comparison;
- pinyin/reading overrides for hard Chinese terms;
- a model fallback when VoxCPM2 fails on a user's voice.

## Immediate Fixes

### 1. Use VoxCPM2 Hi-Fi Clone Path

Default AnyVoice to:

```python
model.generate(
    text=target_text,
    prompt_wav_path=reference_wav,
    prompt_text=exact_reference_transcript,
    reference_wav_path=reference_wav,
    cfg_value=2.0,
    inference_timesteps=8,
)
```

This is now patched in both:

- `scripts/synthesize_voxcpm_anyvoice.py`
- `scripts/voxcpm_hot_worker_anyvoice.py`

Risk: if this reintroduces prompt-audio leakage for a particular VoxCPM package
version, keep this behind an env switch and compare both modes in the eval
harness. The expected win is higher speaker similarity, not speed.

### 2. Split User Input Into Script Domain + Model Domain

Keep UI text in zh-Hant, but track model-prepared text separately:

- `target_text_raw`
- `target_text_model`
- `prompt_text_raw`
- `prompt_text_model`
- `script_policy`: `preserve_zh_hant`, `model_normalize`, `pinyin_override`

The default should remain `preserve_zh_hant`. Do not blindly convert all
Traditional Chinese to Simplified; that would be wrong for this product and for
Taiwan Mandarin. Instead:

- normalize punctuation, whitespace, full-width alphanumerics;
- optionally enable VoxCPM text normalization for numbers/dates only;
- support explicit pinyin annotations for words the model misreads;
- detect common Simplified variants of risky Mandarin terms (`重庆`, `银行`,
  `音乐`, `长乐`, `行长`, `长大`) and auto-apply typed, model-facing preset
  replacements for known risky terms while preserving the source text;
- store every transformed field in metadata/history so bad generations are
  debuggable.

### 3. Raise Enrollment Quality Gate

For "digital clone", do not accept a sub-3-second or noisy clip as good enough.
The UI can still allow draft generation, but the clone profile should require:

- 5 to 10 clips;
- 6 to 20 seconds each;
- exact transcript for each clip;
- grade A/B from the existing reference analyzer;
- varied scripts: digits, names, English words, zh-Hant common phrases, tone
  pairs, punctuation, and emotional range.
- strict zh-Hant coverage: Simplified or mixed Chinese transcripts should warn
  and stay preserved, but they should not count toward the Traditional Chinese
  profile gate.

Default profile generation now enforces that strict bar at the server boundary:
`useVoiceProfile=yes` requires the strict profile verifier plus passing
transcript-validation proof before resolving a profile reference. Draft
quick-clone remains available only through an explicit
`allowDraftVoiceProfile=yes` / `profileMode=draft` flag, so a single usable clip
cannot silently travel the verified profile path. Audiobook creation and the
background book synthesizer use the same strict-ready check before accepting or
continuing long-form synthesis jobs.

## Eval Harness

Create `examples/voice_clone_eval_set.json` with fixed cases:

- zh-Hant short sentence;
- zh-Hant paragraph;
- names with common misreadings;
- numbers/dates;
- mixed English + Chinese;
- tongue-twister style tone contrast;
- one user-provided failing sentence from history.

For every candidate backend/settings/profile:

- render all cases with a fixed seed if the backend supports it;
- run ASR and compute CER/WER against target text;
- compute speaker embedding cosine against enrollment clips;
- compute duration drift and clipping;
- produce an HTML blind A/B page with audio.

When the eval run uses a ready digital voice profile, reject Simplified, mixed,
or unproven Chinese target cases before rendering. The eval set can still
document those failures separately, but the strict Traditional Mandarin quality
gate should not blend script drift with speaker stability.

Pass bar for a 10x-quality claim:

- pronunciation: at least 50% CER/WER reduction vs current baseline;
- speaker identity: speaker similarity improves or does not regress;
- stability: three repeated renders do not vary materially;
- latency: no worse than current hot-worker path for short text;
- subjective: blind A/B does not prefer baseline over candidate; all-tie is
  acceptable for the current product bar, while an 80% candidate preference
  remains a stronger 10x claim.

## Architecture

### Voice Profile

Add a real profile layer:

```json
{
  "voiceProfileId": "vp_...",
  "userId": "av_...",
  "displayName": "My voice",
  "clips": [
    {
      "audioPath": ".anyvoice/voices/vp_.../clips/001.wav",
      "transcriptRaw": "...",
      "transcriptModel": "...",
      "quality": {"grade": "A", "snrDb": 28.4}
    }
  ],
  "preferredPromptClipId": "001",
  "referenceClipIds": ["001", "002", "003"],
  "loraPath": null
}
```

Then generation uses a profile, not just the last uploaded blob.

### Backends

Keep a backend interface:

```ts
type VoiceBackend =
  | "voxcpm2-hifi"
  | "voxcpm2-lora"
  | "indextts2"
  | "f5-tts"
  | "fishaudio-s2-pro";
```

Backend order:

1. `voxcpm2-hifi`: immediate improvement, already installed.
2. `voxcpm2-lora`: true digital clone for a consented single speaker.
3. `indextts2`: strongest candidate for pronunciation/speaker similarity
   experiments, especially Chinese.
4. `f5-tts`: speed baseline and fallback; good for local throughput, but
   validate zh-Hant and speaker similarity before productizing.
5. `fishaudio-s2-pro`: local MLX/TypelessMLX fallback candidate when
   IndexTTS2/F5-TTS are not installed. Keep it honestly labeled; do not use it
   as IndexTTS2 evidence.

## Milestones

### M0: Patch Current Clone Path

- Pass both prompt and reference audio to VoxCPM2.
- Record `clone_mode` in metadata.
- Add a rollback env flag if prompt leakage recurs.

Status: implemented. `ANYVOICE_VOXCPM_CLONE_MODE=hifi` is the default;
`prompt` keeps the old prompt-only path available for A/B rollback.

### M1: Measurement

- Add eval fixture and render harness.
- Compare current baseline vs Hi-Fi path.
- Add one failing user sentence from history.

Status: started. The fixture is `examples/voice_clone_eval_set.json` and the
render/stability harness is `scripts/voice_clone_regression.py`. It renders
`prompt` and `hifi` modes, can filter by `--case` / `--tag`, can use the hot
worker through `--hot-worker-url`, can run from a ready
`.anyvoice/voices/local-default/profile.json` via `--profile-json` only after a
passing transcript-validation report and strict profile verifier, repeats each
case, stores metadata/audio, and emits a JSON + HTML review report. The fixture
now includes `history_failed_self_voice`, a user-provided failed local-history
target with source run IDs, so regressions keep one real prior failure in the
suite. It does not run ASR itself.

Gate orchestration status: `scripts/run_voice_quality_gate.py` now runs the
full eval path in one command: basic profile readiness verification, profile
transcript validation, strict profile readiness verification with that report,
regression render, ASR transcription, speaker similarity, and strict scoring. It
writes `quality-gate.json` next to the phase artifacts, supports `--dry-run` for
command/fixture validation, and makes the 10x bar repeatable instead of a
sequence of manual commands.

ASR status: `scripts/transcribe_voice_regression.py` consumes the regression
`report.json`, transcribes each rendered WAV with `faster-whisper` or the
`whisper` CLI, and writes a scorer-compatible `asr.json`.

Speaker identity status: `scripts/score_speaker_similarity.py` now consumes the
same regression `report.json`, compares each render to its recorded reference,
and writes scorer-compatible `speaker.json`. When `--profile-json` is provided,
it also compares each profile render against the selected enrollment clips and
records per-clip plus min/avg profile-reference similarity; strict scoring uses
the lower of the prompt-reference and profile-reference similarity for the
speaker identity verdict. The built-in `mfcc-cosine` backend is an immediately
runnable local proxy; `resemblyzer` and `speechbrain-ecapa` are supported when
those packages are installed. The script now has `--list-backends`, and `auto`
prefers `speechbrain-ecapa` when the SpeechBrain, Torch, and Torchaudio
dependencies are present, then `resemblyzer`, then the MFCC proxy. ECAPA or
another speaker-verification model is still the target backend for a stronger
product claim, but the pipeline no longer has a missing artifact between render
and identity scoring. Product-proof quality gates can now pass
`--require-speaker-backend speechbrain-ecapa`; the gate blocks before rendering
if `auto` would fall back to the MFCC proxy or if the ECAPA stack is not
installed. Profile-based quality gates pass the profile manifest into the
speaker scorer, so product proof measures identity against the reusable
enrollment set instead of only the one selected prompt clip. `--speaker-python`
/ `ANYVOICE_SPEAKER_PYTHON` points the
speaker check and scoring step at the Python env that owns `torch`,
`torchaudio`, and `speechbrain`; when unset, the gate defaults to the synthesis
Python so local VoxCPM and ECAPA dependencies can live together.
`--asr-python` / `ANYVOICE_ASR_PYTHON` does the same for Faster-Whisper. The
quality gate uses that interpreter for both profile transcript validation and
regression ASR, so a shell Python with only the `whisper` CLI on PATH cannot
silently become the measured transcription path.
The next-step router exposes that same state as
`postRecordingProofPlan.productProofSpeakerBackend`, including the required
backend, speaker Python, current `auto` fallback, check command, and missing
dependency reason, so the UI cannot imply a credible 10x speaker proof while
only the MFCC proxy is available or the wrong Python env was checked.

Scoring status: `scripts/score_voice_regression.py` consumes the regression
`report.json` plus ASR JSON and speaker JSON, then emits a `score.json` with
per-case CER/WER, repeat stability verdicts, speaker identity verdicts, and
optional baseline comparison. If ASR transcripts are missing, pronunciation is
explicitly marked `missing_asr`; if a previous score is provided, the scorer
checks the 50%+ CER/WER reduction bar used by this plan. When `--speaker-json`
is supplied, strict scoring also requires every render to meet the speaker
similarity threshold. Strict scoring now also requires audio metrics for every
render and rejects clipping above the configured `--max-clipping-ratio`, so the
duration/clipping measurement requirement is part of the pass gate rather than
only HTML-report metadata. Stability is proof-bound as well: strict scoring
requires at least three successful repeats per case and numeric duration-span,
RMS-span, and pairwise-waveform-correlation metrics before a stability verdict
can pass.
The CER/WER scorer now folds common Simplified/Traditional glyph variants before
comparison. This prevents ASR output like `重庆` from being counted as a
pronunciation miss against an expected `重慶`, while the enrollment contract
still requires saved profile transcripts to be strict zh-Hant.
When `text-prep.json` is present, the scorer also treats the model-facing target
as a pronunciation alias for the raw target and scores against the better
candidate. That keeps preset spell-outs such as `VoxCPM2 -> Vox C P M two` from
becoming false CER/WER regressions.
Paired A/B status: when the gate renders `--clone-mode both`, it now scores
`prompt` as the current zero-shot baseline against `hifi` as the candidate in
the same report. This keeps the 10x-quality claim honest: bad prompt-only
baseline groups can fail, but hifi must pass the absolute gates before the
paired proof is considered. The paired scorer is now ceiling-aware: if the
baseline already has zero CER/WER for a case, that case is treated as a
no-regression ceiling instead of an impossible reduction target. The product
verdict uses aggregate evidence: no candidate group failures, no pronunciation
regression, non-negative average speaker delta, aggregate latency within the
configured tolerance, and at least one aggregate CER/WER reduction metric at the
configured threshold. Native regression renders now record `renderSeconds`,
external render manifests can provide the same field, and paired scoring records
per-case latency while judging the product proof on aggregate latency. That
makes the latency pass bar measurable without failing on single-render timing
noise.
The regression HTML report is also blind by default: paired renders are shown
as Sample A/B, reviewer choices are saved locally and exportable as JSON, and
the prompt/hifi answer key stays collapsed until after listening. That makes
the subjective no-regression bar collectable instead of relying on memory.
The completion audit now enforces that bar: save the exported review JSON next
to the product proof `report.json` as `review.json` or `report.review.json`.
The report page now has a `Save review.json` button when served through
`scripts/serve_voice_review.py`, plus a `Download review.json` fallback. The
exported JSON includes the reviewed `report.json` path, SHA-256, status, and
review stats, and
`scripts/audit_voice_clone_goal.py` rejects review files that do not point at
the audited product report path or do not match the product report hash. It
reconstructs the blind order from the report and blocks completion only when
the review is incomplete, asks for rerender, contains invalid choices, or
prefers prompt over hifi. The export also supports an explicit
selected-rounds mode: `reviewScope: "selected"` with
`minimumReviewedRounds: 7` can clear the current operator gate while preserving
`totalReportRounds`, so later blind rounds can be added without pretending they
were already reviewed.
When a full blind review requests rerender for only a subset of cases, keep the
original `review.json` as the raw operator record and merge the replacement
subset after it is reviewed:
`scripts/merge_voice_subjective_reviews.py --base-review <full>/review.json
--base-report <full>/report.json --replacement-review <rerender>/review.json
--replacement-report <rerender>/report.json --out <full>/report.review.json`.
The merge proof translates A/B labels through candidate/baseline roles before
writing the full-review replacement, and the audit prefers `report.review.json`
over the sibling raw `review.json`.
Regression renders now use the same production text-prep contract: raw target
text is kept beside the model-facing preset-pronunciation target, and the
`text-prep.json` proof is passed through to worker metadata. That prevents the
quality gate from measuring a different pronunciation path than the app.
Long-form chunked app synthesis now rewrites final run metadata back to the
full request-level text-prep proof and records per-chunk raw/model text evidence,
so concatenated output is not left with only the first chunk's metadata.
Chunked and segment hot-worker responses now use the same NDJSON parser as
single-pass hot-worker generation, so worker `type=error` events fail the run
instead of being silently drained as plain text.
Runtime stability now has a shared seed contract instead of relying on implicit
Torch randomness. `ANYVOICE_STABILITY_SEED` defaults to `1337`, one-shot
synthesis passes it as `--seed`, the hot worker accepts `stabilitySeed`, and
regression / quality-gate / backend-shootout artifacts record the same value.
Set it to `off` only for exploratory variation; measured digital-voice claims
should keep a fixed seed so repeated renders are comparable.
Regression cases can now carry explicit `pronunciationOverrides`, including
`pinyin:行長=xing2 zhang3`, `zhuyin:...`, `reading` annotations, or structured
`{term, replacement, kind}` rows. These custom repairs are applied to the
model-facing target in native VoxCPM2 regression runs, external backend
shootout plans, and registered external-render reports, while raw target text
remains untouched for scoring and review. The default eval set includes
`zh_hant_custom_readings` so a heard pronunciation bug can become a durable
gate case instead of a one-off textarea tweak. The 2026-06-04 blind review
rejected the earlier `重試 -> 重新測試` repair, so that override is removed:
future runs must keep the spoken target aligned with the raw text unless a
reviewer explicitly approves the model-facing substitution.

Current local evidence: after rescanning older runs with
`scripts/reanalyze_voice_profile_runs.py --build-profile`, the local profile
still has `0` eligible clips. Two older candidate references exist, but their
`reference.wav` files fail ffmpeg parsing, so they cannot be recovered into a
trustworthy enrollment set. Treat the current profile as draft mode until the
five scripted enrollment clips are recorded or imported cleanly.

Text-prep status: implemented for run inputs. Every local run now stores raw
and model-facing text plus `text-prep.json`; the default policy preserves
zh-Hant and only normalizes model-safe whitespace / full-width alphanumerics.
Simplified or mixed Chinese is warned about but not silently converted.
Pronunciation replacements are also wired through the UI/API/worker path in
`term=model-readable wording` format. They apply only to target text, keep the
reference transcript exact, and are recorded with applied counts in
`text-prep.json` / `request.json`.
The same parser now accepts explicit reading annotations such as
`pinyin:行長=xing2 zhang3`, `zhuyin:音樂=ㄧㄣ ㄩㄝˋ`, and
`長樂[reading]=chang2 le4`. These are stored as custom pronunciation override
metadata and applied only to the model-facing target text, never to enrollment
or prompt transcripts.
The runner now auto-applies built-in safe presets for known risky polyphones and
product names in the target text, turning likely misreads into an explicit
model-facing text change before synthesis. Custom user replacements remain
available for terms outside that preset list.
The studio preview now runs that same auto-preset text-prep path and renders a
raw/model-facing text diff, so the user can see the exact target before
synthesis. Mixed-script warnings
also include the concrete marker hits, such as `这->這` or `声->聲`, so
Simplified/Traditional drift can be fixed at the source instead of treated as a
vague Mandarin pronunciation issue. The UI now also exposes a manual
known-marker Traditional fix for target text. It is deliberately click-to-apply,
not automatic conversion, because profile transcripts must remain exact and some
Chinese variants need human review.
The script detector now covers common speech and recording words such as
`說/说`, `話/话`, `讓/让`, `樣/样`, and `麥/麦`, so short Simplified target
phrases are rejected by strict profile generation/evaluation instead of being
treated as unknown Chinese.
Profile enrollment now also treats Chinese text with no clear Traditional
marker evidence as `unproven_chinese_script`. That is intentionally stricter
than generic script detection: a sentence may be Chinese, but if the gate cannot
prove it is zh-Hant, the clip is blocked before recording/import/analyzer work
instead of becoming a late profile-verifier failure.

### M2: Voice Profile

- Add profile storage under `.anyvoice/voices`.
- Let users record 5 enrollment clips once.
- Select best prompt/reference clips automatically.

Status: foundation added. `scripts/build_voice_profile.py` scans local runs and
builds `.anyvoice/voices/<profile-id>/profile.json` with eligible/rejected clips,
readiness status, and remaining clip count. Profile-generated runs are skipped
so copied profile references cannot re-enroll themselves, and sample-source runs
are skipped so the built-in demo voice cannot become the user's digital profile.
Profile clip selection is now coverage-aware: it collapses duplicate
transcripts, reserves eligible clips needed for zh-Hant, numbers/dates, English
terms, polyphones, punctuation/rhythm, and exact required pronunciation preset
ids, then fills the remaining slots by quality. That prevents a profile from
dropping a lower-ranked but pronunciation-critical clip just because several
generic clips scored slightly higher.
`scripts/reanalyze_voice_profile_runs.py` can backfill older runs that have
audio plus transcript but no `metadata.referenceQuality`, preserving existing
metadata and rebuilding the manifest after the analyzer pass. The same recovery
path is available from localhost through `POST /api/voice-profile/reanalyze`
and the profile-panel rescan button, making previously recorded clips part of
the normal digital-voice workflow instead of a one-off CLI repair. If any
candidate audio cannot be analyzed, the script still prints a structured report
with `failures`, but exits non-zero so automation does not mistake a partial
rescan for a clean recovery. Repeated
readings of the same transcript now count once: the profile keeps the
best-quality copy and marks the rest `duplicate_transcript`, preventing five
takes of one sentence from masquerading as a broad digital voice profile.
The ready gate also requires transcript coverage for zh-Hant, numbers/dates,
Latin terms, polyphone traps, punctuation/rhythm, and exact core preset ids such
as `polyphone:chongqing`, `polyphone:bank`, `polyphone:role`,
`polyphone:music`, `polyphone:changle`, and `brand:anyvoice`. Missing coverage
and missing preset ids are returned in diagnostics so the UI can tell the user
which kind of sentence to record next.

App status: `/api/voice-profile` now exposes the same readiness gate to the
studio UI. The main page shows qualified clips, rejected clips, and remaining
clips needed so a short draft recording cannot be mistaken for a real profile.
When the profile is ready, the studio can send `useVoiceProfile=yes`; the server
now requires the persisted profile manifest to pass the strict verifier with ASR
transcript validation, then selects the best eligible prompt clip, uses its exact
transcript, and runs synthesis from that fixed profile reference instead of the
current browser blob.
The regression harness now mirrors that path with `--profile-json`, records the
selected profile clip per render, and refuses to render from a profile that has
not passed the strict profile verifier plus ASR transcript validation. A
one-clip `status: ready` manifest and a dry-run transcript-validation report are
both blocked before profile-based regression artifacts are written.
Selection is now target-aware: the server detects numbers/dates, Latin terms,
polyphone traps, and punctuation/rhythm in the target text, then prefers a
qualified profile clip whose transcript covers those same pronunciation risks
before falling back to the stable default profile clip. It also records exact
pronunciation preset ids for known risky terms, so `行長` and `重慶` are no
longer treated as interchangeable just because both are polyphones.
The regression harness now uses the same target-aware selection and stores
`targetCoverageFeatures` / `matchedCoverageFeatures` plus
`targetPronunciationPresetIds` / `matchedPronunciationPresetIds` on each render,
so quality gates measure the same profile reference the app would use.

Enrollment status: `POST /api/voice-profile/enroll` now saves the current
reference clip as profile evidence without a full synthesis run. It writes the
same run-file shape, runs the duration/SNR/VAD/clipping analyzer, refreshes the
readiness gate, and lets users build the five-clip profile faster and cheaper.
The studio now also prevents obviously invalid profile enrollment before upload
when the browser can see the clip is shorter than the profile minimum, longer
than the profile maximum, has a Simplified/mixed Chinese transcript, or is the
built-in sample voice; the server rejects sample clips and Simplified/mixed
Chinese profile transcripts as a second guard. Profile builders also reject
Simplified or mixed Chinese transcripts before coverage-aware clip selection, so
stale local runs cannot make a manifest look ready only to fail strict
verification later. Analyzer results that are saved but still fail the A/B
duration gate are shown as rejected rather than as a qualified clip.
The scripted recording path now includes five fixed enrollment prompts, plus UI
warnings for Simplified or mixed Chinese in the target text or transcript. This
keeps the pronunciation contract explicit: preserve the user's text, but make
script risk visible before synthesis.
The fixed prompts avoid relative wording such as "today"; date coverage is
phrased as an example so the user is less likely to improvise while reading and
break ASR transcript alignment.
When coverage is missing, the profile panel recommends the next scripted prompt
that fills the highest-priority gap. The guided action records that prompt,
keeps the stop button disabled until the recommended duration and, when the
browser live audio meter is available, active-voice time are reached, and submits
it to the profile analyzer after the user stops recording. Saved browser drafts
also carry both total duration and post-decode active-voice duration; known
silence-heavy drafts are blocked from resubmit or batch import before they can
become low-VAD rejected clips.
The ready-profile generation path now applies the same script discipline to the
target text: Simplified, mixed, or unproven Chinese is blocked for digital-voice
renders so the fixed Traditional Mandarin profile is not evaluated against
script-drifted input.
The profile API now also returns diagnostics for selected grade counts, eligible
transcript script mix, top rejection reasons, and rejected clip examples; the UI
surfaces top issues and recent rejected clips so users know whether to record
longer, quieter, cleaner, or with a consistent script.
The profile panel also shows a pronunciation coverage checklist for zh-Hant,
numbers/dates, Latin terms, polyphone traps, and punctuation/rhythm, making
the five required coverage gates visible before the profile is ready.
Enrollment progress is now script-level, not just aggregate counts: the UI maps
the five fixed prompts to accepted, rejected, or missing states. A missing or
rejected row can start recording that exact prompt and auto-submit it to profile
enrollment, reducing the chance that the user records the wrong category again.
The active Build tab now seeds its guided recording rows from the detailed
profile manifest when available, so accepted and rejected scripted transcripts
stay tied to their exact prompt rows instead of being inferred from aggregate
`clipCount`.
Batch import is also available for a cleaner recording workflow:
`scripts/prepare_voice_profile_recording_kit.py` creates a local folder with
the prompt files, a `recordings/` directory, a ready import manifest, and the
exact import/verify commands. The standard prompt set has five files; the
extended 10x prompt set has ten. It rejects Simplified or mixed Chinese prompt
manifests before writing the kit and stores script/coverage diagnostics beside
each manifest row. It now also writes pronunciation cue notes for risky fixed
prompt terms such as `Brenda`, `AnyVoice`, `重慶`, `銀行`, `音樂`, and
`長樂`; those notes are recording guidance only and are not added to the exact
transcript. Record once into that folder, then reuse those files instead of
repeating browser mic capture.
For the stronger digital-voice path, use
`scripts/prepare_voice_profile_recording_kit.py --prompt-set extended`. That
creates ten zh-Hant prompts inside the existing `maxClips=10` profile contract,
adding more pauses, product names, numbers/dates, and polyphone cases before
LoRA export or backend shootout. The five-clip set remains the fast minimum
gate; the extended set is the better default when the goal is a stable clone
rather than a quick proof.
The kit also writes `cue-sheet.html`: a static, phone/second-screen friendly
reading view generated from the same manifest, with the exact transcripts,
output filenames, and pronunciation notes. This keeps the high-risk
polyphone/name guidance visible during recording without adding those notes to
the transcript. The localhost profile panel exposes that same generated HTML as
a direct cue-sheet link, with the terminal `webbrowser` command kept as a
fallback for external recording sessions.
`scripts/record_voice_profile_recording_kit.py` closes the missing-audio gap in
that folder: it reads the manifest prompts, calls a local recorder command for
all missing clips with `--record-missing-until-complete`, writes the exact
expected WAV paths, skips existing non-empty clips by default, and validates each
new take before moving to the next prompt. The one-take escape hatch remains
`--next-missing --check-selected`, while final enrollment still requires `--check`
after all kit WAVs exist. It
uses `ANYVOICE_RECORDER_COMMAND` / `--recorder-command` when the default `rec`
or macOS `ffmpeg` microphone path is not available. The next-step command uses a
short countdown and writes sidecar recording metadata with the exact transcript
SHA-256, resolved audio path, byte size, and audio SHA-256 for each take.
`--rehearse --no-default-recorder --auto-duration`
prints the exact cue sheet, per-prompt targets, and required pronunciation
coverage without requiring a recorder; `--dry-run` shows the exact recorder
command per clip before touching the microphone. `--preflight` is the stricter
no-recording check: it verifies the recorder backend, missing or existing WAVs,
prompt-file drift, stale sidecars for existing skipped takes, Simplified/mixed
transcript drift, write access, and command previews, then exits non-zero if a
real recording attempt would fail before reaching the microphone.
Preferred generated recording commands include `--auto-duration`, which derives
a 6-20 second target from each prompt transcript, and `--microphone-smoke-sec 2`,
which blocks the recording run before writing profile WAVs when mic permission,
input gain, or clipping is already bad. This keeps long Traditional Mandarin,
Latin-name, and polyphone prompts from being rushed into the old fixed
nine-second recording window while also making the one-shot terminal path safer
than a separate checklist.
Add `--brief` to `--preflight`, `--rehearse`, or `--dry-run` when the operator
needs the short terminal view: status, kit metadata, cue-sheet path, cue-sheet
open command, recordings folder, next clip, and the exact record/proof commands
without parsing the full JSON payload.
If the audio is recorded externally, for example in Voice Memos or on a phone,
`scripts/normalize_voice_profile_recording_kit_audio.py` maps files named by
clip id (`profile-clip-01.m4a`, `profile-clip-02.wav`, etc.) into the manifest
WAV paths, writes transcript/audio-hash sidecars, and can immediately run the
same kit check with `--check`. That keeps the external-recorder path inside the
same strict prompt/transcript/audio proof chain instead of requiring manifest
edits.
The localhost profile panel auto-loads the `local-default-current` kit, so the
same normalize/check path is visible on page load instead of requiring a new
timestamped kit. The panel's bulk upload path now derives expected files and
transcripts from that manifest as well, so the 10x kit can import all ten
`profile-clip-01` through `profile-clip-10` phone exports in one batch. The
same manifest also drives the browser recording progress panel, so browser-captured
drafts can cover all ten 10x prompts instead of stopping at the old five-script
minimum.
Use `--preflight --brief --microphone-smoke-sec 2` as the explicit microphone
smoke test before the full recording session. It writes only a temporary WAV,
verifies that the configured recorder can actually capture non-empty audio with
usable peak level and no clipping, and blocks before the ten-clip run if macOS
microphone permission, the selected input device, input gain, or the recorder
command is broken. The next-step router and goal audit surface the same
smoke-test command beside the normal no-microphone preflight and full recording
commands, and the generated bulk/proof recording commands run that smoke gate
again immediately before real capture.
The rehearsal and recording prompts include the same pronunciation notes, and
terminal sidecars persist them next to the transcript hash so later inspection
can tell which cue sheet was used.
When an existing WAV fails duration or active-voice checks, the next-step router
does not ask for a bulk re-record. It points at the first failed clip with
`--clip <id> --overwrite --write-metadata` and includes the concrete issue
codes in `recordingBrief`, so bad takes are repaired one by one.
The terminal recorder now also refuses target durations outside the 6-20 second
profile gate before opening the microphone unless explicitly overridden for
debugging. Auto-duration uses the same gate but gives longer prompts more room,
and its plan output carries the 5.2 second active-voice target plus a short
recording checklist.
`scripts/check_voice_profile_recording_kit.py` is the pre-import gate for that
folder: it verifies the expected files exist, that recorded files are within
the 6-20 second profile duration gate, that recordings contain at least
5.2 seconds of active voice, and that the transcripts still cover zh-Hant,
numbers/dates, Latin terms, polyphone traps, and rhythm before the importer
spends time analyzing clips. Non-WAV files are decoded with `ffmpeg` for the
same active-voice gate; undecodable files remain blocked instead of slipping
through as duration-only evidence. It also checks generated prompt files
against `manifest.json`, rejects stale terminal `.recording.json` transcript
hashes, rejects sidecars whose resolved audio path or audio SHA-256 no longer
match the current recording, rejects explicit non-scripted recording-kit rows,
and includes exact Simplified/Traditional marker hits when transcript script
validation fails.
When a generated manifest carries `durationTargetSec` /
`recommendedDurationSec`, the checker also rejects takes recorded more than two
seconds below that prompt-specific target, so a long Mandarin/polyphone prompt
cannot pass just by squeezing into the generic 6-second minimum.
The same pre-import check now rejects obvious level damage, including clipped
audio and very quiet captures, before those clips are analyzed or enrolled into
the profile.
The same check now rejects `zh_unknown` Chinese rows as
`unproven_chinese_script`, matching the importer, browser bulk import, direct
profile enrollment, profile builder, and strict verifier.
`scripts/enroll_voice_profile_kit.py` is the one-command path after recording:
preflight the kit, import the clips, rebuild the profile, and run
`verify_voice_profile_ready.py`, returning one JSON workflow report. It can now
run the transcript ASR alignment phase with `--validate-transcripts`; when that
phase runs, the final verifier requires the validation JSON to pass before the
workflow reports `ready`. Recording-kit enrollment defaults to
`sourceKind=scripted`, keeping fixed-prompt clips distinct from freeform uploads
in the run evidence. The `--skip-kit-check` escape hatch is now explicitly
unsafe: migration/debug imports must pass
`--allow-unsafe-skip-kit-check --unsafe-skip-kit-check-reason "<reason>"`, and
that accepted reason is recorded in the workflow JSON.
Direct `scripts/import_voice_profile_clips.py --manifest <generated-kit>` calls
now enforce the same pre-import recording-kit check when `manifest.json` carries
generated kit metadata such as `promptSet`, `requiredClips`, or per-row prompt
targets. The same unsafe skip flags are required to bypass that direct-import
gate, so stale sidecars or swapped audio cannot bypass the proof chain by
skipping the enroll wrapper. When a generated-kit row omits `sourceKind`, direct
import now defaults it to `scripted` instead of the generic upload default, so
fixed-prompt recording-kit evidence keeps the same provenance whether it enters
through the wrapper or the lower-level importer.
The same rule applies to manifest-provided quality values:
`--trust-manifest-quality` is only for already analyzed migration/debug
manifests, and it now requires
`--allow-unsafe-trust-manifest-quality --unsafe-manifest-quality-reason "<reason>"`.
Normal imports analyze the audio; unsafe trusted quality records the reason in
run metadata as `referenceQualitySource`.
The studio now exposes this through `POST /api/voice-profile/recording-kit` and
a profile-panel action, so the user can create the standard five-clip folder or
the extended ten-clip 10x folder and copy the exact enrollment command without
leaving localhost.
`POST /api/voice-profile/recording-kit/check` runs the same pre-import kit
check from the UI, so missing audio files, Simplified/mixed Chinese transcripts,
stale prompt files, stale terminal-recording sidecars, non-scripted kit rows, or
missing prompt coverage are visible before the user spends time
importing/analyzing bad evidence. The
CLI importer repeats the script gate before writing run evidence, which keeps
manifest imports from wasting analyzer time on clips that cannot satisfy the
Traditional Mandarin profile.
The same surface also supports standard-kit browser bulk import through
`POST /api/voice-profile/import`: select the five standard recorded audio files,
and the server enrolls them against the fixed prompt transcripts, rebuilds the
profile, and returns the updated gate status. Bulk import repeats the same
Simplified / mixed-Chinese transcript rejection before analyzer work and
requires filenames containing `profile-clip-01` through `profile-clip-05`; this
prevents a wrong audio/transcript pairing from becoming another pronunciation
bug. The API treats `profile-clip-XX` rows or filenames as fixed-prompt scripted
evidence and rejects an explicit non-scripted source kind for that shape, while
generic bulk uploads continue to default to `uploaded`. For the 10x extended kit, use the generated manifest commands so
`profile-clip-01` through `profile-clip-10` stay paired with the extended
transcripts. After a successful browser bulk import, the studio starts
transcript validation, strict profile verification, and the completion audit
automatically, so the profile panel immediately shows whether the next stop is
quality gate, 10x product proof, or LoRA handoff.
Generated recording kits now carry the proof chain directly: the script JSON,
kit README, `cue-sheet.html`, and browser kit panel all include the same
`voice_profile_next_step.py --run --auto-advance --allow-enroll
--allow-expensive --stop-before-lora` command. That makes the offline recording
folder self-contained: after the kit WAV files exist, the next command can
enroll, validate ASR transcript alignment, run strict verification, and run the
quality gate without unexpectedly reopening recording or exporting a LoRA
dataset.
`scripts/import_voice_profile_clips.py` reads a JSON/JSONL/CSV manifest of
audio paths plus exact transcripts, writes profile enrollment run evidence,
runs the same analyzer, and can rebuild the profile manifest. For generated
recording-kit manifests, it first runs the recording-kit pre-import gate unless
an explicit unsafe skip reason is provided. The example manifest is
`examples/voice_profile_import_manifest.example.json`.
Post-enrollment verification is now a first-class gate:
`scripts/verify_voice_profile_ready.py` loads the profile manifest and refuses
the digital-voice path until status, selected clip count, pronunciation
coverage, selected audio duration, clip metadata, user-recorded source
provenance, strict zh-Hant raw transcripts, and audio files all pass. The fast
minimum remains five selected clips / 30s. The temporary 10x product audit and
LoRA handoff gate allow seven selected clips / 60s while the remaining extended
capture is backfilled; the extended ten-clip set still carries additional
clone-depth and backend-shootout coverage such as `polyphone:bank-president`
and `brand:voxcpm2`. Missing extended profile-reference presets are reported as
focused recording cues rather than as the current capture-depth blocker. It
recomputes script from `transcriptRaw`, reports exact Simplified/Traditional
marker hits when script validation fails, and rejects selected clips marked
`profile` or `sample` so generated/sample evidence cannot become a reusable
voice anchor. Its JSON output includes the exact profile regression and LoRA
dataset commands, so the transition from recording to evaluation/training is
explicit instead of manual.
The verifier's audio-file skip path is also explicit unsafe-only:
`--skip-audio-exists` requires
`--allow-unsafe-audio-exists-bypass --unsafe-audio-exists-bypass-reason "<reason>"`,
and the accepted reason is reported as `audioFileCheck`.
When transcript validation is required, the verifier also rejects validation
JSON that omits the current profile SHA-256 or points at a different profile
manifest, even if the clip IDs happen to match.
`scripts/voice_profile_next_step.py` is the workflow router around that gate: it
loads the strict profile verifier plus the current recording-kit checker and
returns one next action: prepare the kit, record missing WAVs, enroll a ready
kit, validate transcripts, run the quality gate, prepare the LoRA handoff, or
prepare the IndexTTS2/F5 backend shootout.
When a fast-ready profile still lacks temporary seven-clip product capture depth
and the current extended kit is incomplete, the router prioritizes recording-kit repair/recording before
ASR transcript validation, so the audit, terminal brief, and profile panel point
at the same first physical blocker.
When the latest matching full hifi quality gate is a review/fail because score
evidence reports missing profile-reference pronunciation presets, the same
router reads the score artifact, maps those presets back to the recording-kit
clips, and returns a focused profile-reference recording action before another
full quality-gate render. This keeps `voice_profile_next_step.py` aligned with
the goal audit's repair queue instead of wasting a rerun on unchanged reference
evidence.
Use `--brief` for the operator-facing recording-session view: it prints status,
the exact next command, missing clips, the first prompt, mic/preflight commands,
the focused `--clip ... --check-selected` command, the proof-chain command, and
ASR/speaker backend readiness without requiring the caller to parse JSON. The
router accepts `--json` as an explicit machine-readable alias for its default
JSON output, rejects `--brief --json`, also includes this brief in its JSON payload, and the profile check panel
renders it beside the structured cue sheet so the app and terminal present the
same next action.
It now routes stale prompt files, non-scripted rows, mixed-script transcripts,
and stale terminal-recording sidecars to `needs_recording_kit_fix` before
missing-audio recording, so the workflow does not collect more audio against a
bad manifest.
For recording phases, it also exposes `rehearseRecordingKit` before preflight
and recording commands, making the exact cue sheet part of the normal next-step
output instead of a hidden helper.
That keeps the 10x path from depending on remembering which script comes next.
With `--run`, the router executes only the safe next step by default: if
recording is needed it runs preflight rather than opening the microphone.
Recording, enrollment, and ASR/quality-gate work are separate phases requiring
`--allow-recording`, `--allow-enroll`, or `--allow-expensive`. Focused
quality-gate profile-reference repairs keep their mapped clip list when
recording is explicitly allowed: non-interactive runs use the action's
`nonInteractiveCommand` with the same `--clip ...` selectors and `--yes`, not
the generic `--next-missing` path. With
`--auto-advance`, the router re-checks after each successful allowed phase and
continues until the next blocked or unpermitted phase, so a finished recording
kit can move directly to enrollment, then transcript validation, then the quality
gate without another manual status command.
Blocked verifier reports now also include `recordingPrescription`: clips needed,
recommended per-clip duration, active-voice target, missing pronunciation
coverage, and dominant rejection reasons. The profile panel renders that plan
after a failed check, turning the current `too_short` / zero-eligible state into
an explicit recording target.
The same router now emits `recordingBrief` whenever a recording kit exists:
exact transcripts, resolved audio paths, missing-audio flags, coverage features,
and cue-sheet pronunciation notes. That makes the next-step JSON and browser
strict-check panel actionable without a separate rehearsal run, while still
preserving the rule that pronunciation notes are guidance only and must not be
read into the transcript. Its focused single-clip record commands include
`--check-selected`, so a newly recorded take is validated immediately before the
operator continues through the missing clips.
The generated record and repair commands include `--open-cue-sheet`, so the
browser cue sheet opens before the first microphone take instead of relying on
the operator to run a separate cue-sheet command from memory.
It also emits `postRecordingProofPlan`: the no-microphone one-shot proof command
to run after the kit WAVs exist, manual fallback commands, and the expected
profile, transcript-validation, and quality-gate artifacts. That keeps the path
from "recorded kit files" to "stable enough to trust" explicit: enroll, validate
ASR transcript alignment, rerun strict profile verification, and run a real
quality gate before default digital-voice use. LoRA export also requires the
paired product proof gate. The generated one-shot proof command includes
`--stop-before-lora`, so it can prove readiness without silently writing a
training dataset after the product proof passes.
The terminal recorder now exposes the same handoff as `--run-proof-after-check`:
after recording or skipping existing WAVs, it runs the kit checker and only then
invokes the one-shot proof chain. That removes the manual gap between "kit
files exist" and "the profile was actually enrolled, ASR-validated, and
quality-gated." Generated recording kits now include that path as
`recordAndProveCommand` in JSON, README, cue sheet, and the localhost profile
panel, while still keeping the plain `proofCommand` available for manually
recorded files.
For the actual 10x/product claim, the recorder also supports
`--run-product-proof-after-check`. That runs the normal proof chain first, then
loads the router's `productProofCommand` and executes the paired `prompt` vs
`hifi` quality gate with the required product speaker backend. Generated kits
surface it as `recordProveAndProductProofCommand`.
`--prepare-lora-after-product-proof` goes one step further: after the product
proof passes, it exports the consented LoRA dataset handoff. That command is
surfaced as `recordProveProductProofAndLoraCommand` and printed in the terminal
preflight brief, while direct `voice_profile_next_step.py --run` still requires
`--allow-lora-export` before writing the dataset.
`scripts/audit_voice_clone_goal.py --fail-unless-complete` is the read-only
completion audit for this plan. Use `scripts/audit_voice_clone_goal.py --brief`
or `npm run voice:clone:audit` when the next step is a recording-session
checklist instead of machine-readable JSON; use
`npm run --silent voice:clone:audit:json` for a pure structured payload without
npm's command header. It refuses to call the goal complete until the
recording kit, strict profile verifier, ASR transcript validation, proof backend
environment, seven selected clips / 60 seconds of temporary product capture
depth, non-dry-run hifi quality gate, paired 10x product proof, LoRA dataset,
LoRA training job, readable adapter proof, and a non-dry-run LoRA quality gate
with the verified adapter loaded, plus an accepted backend-selection proof that
still recomputes from its score JSON and matches the audited voice profile, all
have current evidence. Quality-gate and product-proof transcript validation
evidence must bind back to the audited profile path, voice profile ID, profile
hash, and selected clip rows. The audit now also emits
`completionRequirements`: a fixed, ordered checklist for every 10x gate with
the requirement text, pass/block status, and the stage-specific evidence used
for that decision. `firstIncompleteRequirement` mirrors the first failed
checklist item, so future UI/automation code can prove completion from
structured requirements instead of scraping stage labels or brief text. For
profile-reference quality-gate failures, it carries through
`scoreReviewGroups[].profileReference` and ASR samples for each review group,
emits `nextProfileReferenceRecordingCommands` for individual focused cue clips,
`nextProfileReferenceRecordingBatchCommand` for recording all known missing
profile-reference clips in one session, and
`nextPostProfileReferenceRecordingProofCommand` for the no-microphone proof
chain to run after those clips pass `--check-selected`.
`nextQualityGateProbeCommands` lists partial `--case` probes for review groups;
those probes are diagnostics and are not accepted as the full hifi completion
gate. `nextQualityGateRepairActions` orders the operator path for a blocked
quality gate: missing profile-reference batch recording first, proof-chain
refresh second, then the partial case probes. Each action carries a `status`
such as `ready` or `waiting`, and waiting probes include `blockedUntil` so
automation does not run diagnostics before the required profile-reference proof
refresh. These actions are repair guidance, not completion evidence. The
`POST /api/voice-profile/goal-audit` TypeScript contract preserves that checklist
as `completionRequirements`, and the AnyVoice browser client exposes it through
`fetchVoiceCloneGoalAudit`, so browser surfaces can render the same evidence
without shelling out or re-parsing brief text. The Build tab also turns the
audited `kitManifest` into a cue-sheet link through the recording-kit API, so
the browser action opens the exact fixed-prompt kit the audit checks, and it
shows the full audited missing-kit clip list, the first missing clip transcript,
and the focused one-clip record command from audit evidence so the next
recording cue is visible without opening a terminal. It also renders the
recording preflight evidence, recorder source, duration targets, microphone
smoke-test command, preflight command, and external recording normalization
check from audit evidence. The same panel now carries the post-recording
product-proof and LoRA-handoff commands, so the browser path
does not dead-end at recording. Proof-backend readiness and backend check
commands from the `proof_environment` checklist row render even when the
recording kit is the first blocker, so missing Faster-Whisper or
`speechbrain-ecapa` setup is visible before recording starts.
When the first blocker is missing kit audio, the audit includes the first missing
transcript plus a focused `--check-selected` recording command so the operator
can validate one take before continuing. It also embeds the no-microphone
recorder preflight result, including recorder source and duration/active-voice
targets. The audit's recording commands use auto-duration, so recorder setup
problems and per-prompt timing are visible before a ten-clip session starts.
The plan also carries a separate `productProofCommand`: it runs the paired
`prompt` vs `hifi` gate and requires `speechbrain-ecapa` speaker verification.
That keeps local MFCC-based plumbing distinct from the stronger proof needed for
a credible 10x/product claim.
The same proof plan now carries `productProofSpeakerBackend`; if ECAPA is
missing, the profile panel shows that blocker before recordings are finished.
It also carries `productProofAsrBackend`; if Faster-Whisper is missing or the
wrong Python would be used, the profile panel shows that pronunciation-proof
blocker before a 10x claim is possible.
Transcript alignment now has its own stricter gate:
`scripts/validate_voice_profile_transcripts.py` transcribes the selected profile
clips with `faster-whisper`/`whisper` or consumes external ASR JSON, then scores
each clip against the exact reference transcript with CER/WER. The readiness
verifier can be run with `--require-transcript-validation` and
`--transcript-validation-json` so wrong prompt text cannot silently become the
pronunciation anchor for regression or LoRA work. Standalone
`voice_clone_regression.py --profile-json` now enforces that same passing
validation report before rendering or dry-run planning from a saved profile.
The router writes transcript validation to the profile-local
`.anyvoice/voices/<profile-id>/transcript-validation.json`, discovers the latest
matching validation report automatically, and passes it into strict verification
and `run_voice_quality_gate.py`. `--transcript-asr-json` lets the same path use
an external ASR report during tests or when transcription was already run
elsewhere.
Transcript-validation failures now preserve the original recording-kit clip id
through import and profile building. If an import run id was suffixed because an
older run already existed, the verifier still emits `repairClipId` and the
router re-records the original kit slot with
`record_voice_profile_recording_kit.py --clip <repairClipId> --overwrite
--check-selected`, rather than pointing at a non-existent suffixed kit clip.
The CLI, recording-kit enrollment workflow, next-step router, and localhost
transcript-validation API share the `ANYVOICE_ASR_PYTHON` /
`--transcript-python` / `--asr-python` contract, so the ASR proof path uses the
Brenda Faster-Whisper env instead of whichever shell Python launched the action.
Quality-gate artifacts include an `inputs` block with the profile path, the
canonical profile SHA-256, and gate parameters. The hash excludes later applied
`loraPath`, `loraAdapter`, and `preferredBackend` policies, but catches changed
clip/transcript evidence. The router scans
`generated/voice-regression/**/quality-gate.json` for the latest matching
non-dry-run hifi `status=pass` gate with the current profile hash, then
advances to the paired product proof gate. It only advances to
`prepare_lora_dataset` after the paired `prompt` vs `hifi` product proof passes
with `speechbrain-ecapa` and the same current profile hash.
Quality-gate consumers also reopen the transcript-validation JSON named by the
gate (`proofs`, `inputs`, or `paths`) and require that report to be `status=pass`
for the same profile, so a hand-edited gate cannot advance on boolean proof flags
alone. LoRA export, training handoff, adapter verification, adapter application,
runtime use, and the completion audit also reopen the quality-gate
score/source-report artifacts and reject them if their top-level, group, or
render `voiceProfileId` / `profileSha256` evidence no longer matches the current
profile.
Dry-run gates and hifi-only gates remain useful planning evidence but do not
unlock LoRA export.
Profile quality-gate proof skips are now explicit unsafe operations:
`--skip-profile-verify` or `--skip-transcript-validation` require
`--allow-unsafe-profile-gate-bypass --unsafe-profile-gate-bypass-reason "<reason>"`,
and the accepted reason is stored in the gate artifact. This keeps migration or
debug reports visibly separate from measured digital-voice proof. The completion
audit uses the same strict predicate for paired product gates, so an unsafe
skip-bypassed `prompt` vs `hifi` report cannot satisfy the 10x product proof or
unlock LoRA export. Base profile quality-gate discovery ignores adapter-loaded
reports with `inputs.loraPath`; those are audited only by the dedicated
`lora_quality_gate` stage, so a bad LoRA run cannot mask a valid zero-shot
profile gate or vice versa.
The top-level completion audit also requires a blind subjective review artifact
for the paired product proof. Metrics alone are not enough for `complete`: the
review JSON must be exported from `report.html`, saved beside the product
`report.json`, carry the matching report SHA-256, and not prefer prompt over
hifi. The audit rebuilds rounds only from existing audio and rejects duplicate
prompt/hifi samples for the same case and repeat, so ambiguous A/B evidence
cannot satisfy the subjective bar.
At the same ready-profile stages, the router also surfaces
`prepare_voice_backend_shootout.py` as a secondary command. That keeps the
alternative-backend 10x route visible at the moment there is finally enough
verified user voice evidence to run a fair IndexTTS2/F5 comparison. The command
now carries the same transcript-validation proof path as the quality gate, so
backend shootouts cannot be planned from a ready-looking profile whose reference
transcripts have not passed ASR alignment. The planner also runs the strict
profile verifier, so a one-clip or missing-audio profile cannot become backend
comparison evidence.
The localhost studio now exposes this same hard gate through
`POST /api/voice-profile/verify` and a profile-panel button. Blocked verifier
JSON is rendered as normal state, including the failed checks and the
`validate_voice_profile_transcripts.py` command, so the user can see whether the
saved voice profile is truly reusable before running another generation.
`POST /api/voice-profile/transcript-validation` now runs the ASR transcript
alignment gate from the same panel and refreshes strict verification afterward,
so transcript mismatch is a visible localhost state rather than a separate CLI
handoff.
The guided enrollment path now persists each fixed prompt recording as a
browser draft keyed by profile, script pack, and prompt index. Metadata is kept
in `localStorage` for prompt ordering, and the audio blob is kept in IndexedDB
when the browser supports it. Reloads or failed enrollment attempts do not force
the user to re-record every line: the line list marks the saved take as a draft,
can re-submit the draft directly to `POST /api/voice-profile/enroll`, and treats
drafted prompts as progress when choosing the next recording line. Newly
recorded drafts also store their browser-measured duration, estimated
active-voice duration when local decoding is available, file size, MIME type,
and capture settings, so the checklist has enough local evidence to flag known
clips under the 6-second floor, over the 20-second ceiling, or below the
5.2-second active-voice gate before another analyzer run is wasted on invalid
material. Draft resubmission and batch import now check stored duration and
stored active-voice duration before reopening the draft blob or posting to
enrollment, so stale short/long/silence-heavy drafts cannot become profile
evidence through the browser path.
The browser-session bulk import/validation cascade is now wired into the Build
tab: saved valid drafts can be imported in backend-sized batches through
`POST /api/voice-profile/import`, then the studio automatically starts ASR
transcript validation, strict profile verification, and the 10x completion
audit before refreshing the row statuses from the updated profile manifest.
Browser capture now requests mono 48 kHz audio as an ideal format and asks the
browser to disable echo cancellation, noise suppression, and automatic gain
control when supported. Those are soft constraints, but they keep profile
recordings closer to the speaker's real timbre instead of letting browser DSP
reshape each take differently. The live recorder also displays the browser's
reported capture settings and warns when processing remains enabled, so a bad
capture path is caught before the full ten-clip profile run. Browser profile
drafts persist those capture settings and block one-click submit/import when a
draft is known to have echo cancellation, noise suppression, or automatic gain
enabled.
Guided profile recording now fails before saving a draft when the active browser
mic path reports that processing is still enabled, which keeps bad browser DSP
out of the 10x profile evidence set. A browser mic preflight button runs the
same capture-settings check without creating a draft, reports the observed
sample rate/channel/DSP flags, and stops the track immediately, so the mic path
can be validated before starting the guided ten-clip session. The enrollment and
bulk import APIs repeat the same check when browser capture settings are
included and persist those settings in enrollment run metadata, so
browser-recorded profile evidence cannot bypass the DSP guard through a
different upload path.
For the extended ten-prompt kit, those imported browser drafts are first-class
profile evidence: once the selected profile reaches ten clips and at least sixty
seconds of selected audio, stale external recording-kit files do not block the
recording-kit audit stage.

### M3: Pronunciation Controls

- Add per-run pinyin override field for hard terms.
- Store raw/model text transforms in history.
- Add a preview diff showing what the model will read.

Status: implemented as explicit replacement controls rather than silent
conversion. The active workspace composer and the legacy studio both show the
model-facing target preview; the workspace composer also exposes per-run reading
override rows and preset chips. API validation rejects malformed override lines,
worker/proxy form data preserves the field, and run history stores the override
list, the resolved profile reference, and the prepared raw/model text payload
used for synthesis. Known
polyphone/brand suggestions carry typed
preset metadata (`polyphone` / `brand`, `source=preset`, stable `presetId`)
while arbitrary user entries are marked `custom`. Explicit
`pinyin:` / `zhuyin:` / `[reading]` lines are accepted as user-supplied
model-facing text and tagged separately, keeping validated Brenda/AnyVoice-style
fixes distinct from experimental reading overrides.

### M4: LoRA Digital Clone

- Prepare JSONL training manifest from consented clips.
- Train VoxCPM2 LoRA when there are enough clips.
- Hot-load LoRA in the AnyVoice worker.
- Compare LoRA vs zero-shot profile in eval.

Status: dataset handoff, training-job scaffold, load contract, and product-proof
handoff detection implemented.
`scripts/verify_voice_profile_ready.py` is the preflight gate, and
`scripts/prepare_voice_lora_dataset.py` performs the export. Together they load
a ready profile manifest, validate the ten-clip / 60s default LoRA bar, then the
exporter reruns the strict verifier with the transcript-validation report before
writing any dataset files. That blocks ready-looking manifests with missing
coverage, bad provenance, missing audio, wrong script, or weak clip metadata.
The exporter also requires a passing same-profile transcript-validation JSON
plus a matching non-dry-run paired product-proof quality-gate JSON with the
current profile SHA-256, and writes `dataset.json` plus
`manifest.train.jsonl`, `manifest.val.jsonl`, and `manifest.all.jsonl`. It can
copy audio into the export folder with `--copy-audio`; otherwise it references
the profile clip paths. Each row now records the source profile audio path plus
audio and transcript SHA-256 hashes, giving the later training handoff a
content-bound check instead of trusting a hand-edited JSONL manifest. It refuses
the current local profile because there are 0 eligible clips, so the training
path cannot silently proceed from short draft recordings. Direct exporter
bypasses now fail unless those proof files are provided, or unless a
migration/debug export explicitly combines the skip flags with
`--allow-unsafe-export --unsafe-bypass-reason "<reason>"`; that reason is stored
in `dataset.json`.

`scripts/prepare_voxcpm_lora_training_job.py` is the next handoff step. It reads
the exported `dataset.json`, validates every train/val/all JSONL row, row hash,
source profile audio path, and audio file, and writes `train_config.json`,
`train.sh`, and a README under
`generated/voice-lora-training-jobs/`. The config records LoRA hyperparameters,
the expected `output/lora_weights.ckpt`, `output/adapter-proof.json`, AnyVoice
runtime env, trainer preflight, and post-train quality gate commands.
`scripts/train_voxcpm_lora.py` is the repo-local VoxCPM LoRA trainer entry
point. Its `--dry-run` mode validates train/val manifests, audio paths, hashes,
and trainer arguments without loading the model or writing an adapter; real
training must still load VoxCPM, train LoRA parameters, and write
`output/lora_weights.ckpt`. `scripts/check_voxcpm_lora_trainer.py` preflights
the generated config before a long training run: it revalidates the
dataset/proof bindings, checks output paths, validates the trainer command
template, and confirms the selected Python can import `voxcpm.training` with
`load_audio_text_datasets`, `HFVoxCPMDataset`, and `BatchProcessor`. The
Brenda-installed VoxCPM package exposes LoRA load/runtime support plus those
`voxcpm.training` helpers, but no packaged `voxcpm train` CLI, so the generated
`train.sh` now points operators at the repo-local trainer command template. The
completion audit does not let that scaffold create a false green:
`lora_training_job` remains blocked
until the generated config has `trainer.status=ready` with a valid command
template, the audit run has a valid `ANYVOICE_VOXCPM_TRAINER_COMMAND` set, or a
passing readable `output/adapter-proof.json` exists. Metadata-only adapter proofs keep
the stage partial and route the operator to
`scripts/verify_voxcpm_lora_adapter.py --require-readable-checkpoint`. Valid trainer templates must include
`{config}`, `{output_dir}`, and `{adapter_path}`; `{train_manifest}` and
`{val_manifest}` are optional. Both `prepare_voxcpm_lora_training_job.py` and
the generated `train.sh` reject unknown placeholders or incomplete templates, so
an env override cannot silently train into the wrong output path. The same audit
currently allows the LoRA handoff at seven selected clips and at least 60 seconds
of selected audio, while the full 10 selected clips remain the final clone-depth
target. A five-clip minimum profile cannot become the final digital-clone proof.
It also validates the dataset's proof metadata:
normal handoffs require passing same-profile transcript-validation and
non-dry-run paired product-proof quality-gate proof files with the dataset
profile SHA-256, every dataset row must match the transcript-validation clip
proof, and unsafe-bypassed datasets require
`--allow-unsafe-dataset
--unsafe-dataset-reason "<reason>"` so migration/debug exceptions are visible in
`train_config.json`.
After training, `train.sh` now runs `scripts/verify_voxcpm_lora_adapter.py` to
prove the adapter path, byte size, SHA-256, dataset minimums, and proof metadata
before writing `adapter-proof.json`. The verifier rejects train configs or
adapter proofs that do not preserve the paired product-proof dataset marker or
whose `voiceProfileId` / `datasetProofs.profileSha256` no longer match the
current voice profile.
It also writes the training config SHA-256 into the adapter proof; apply and
audit reject proofs whose `trainConfigSha256` no longer matches the current
`train_config.json`, so post-verification trainer or hyperparameter edits force
fresh adapter verification. The completion audit rechecks the same adapter proof
profile hash so hand-edited or older proof JSON cannot stay green after a profile
edit. A plain environment can only produce a metadata proof; final acceptance uses the generated
`--require-readable-checkpoint` command in the VoxCPM/Torch environment so
readable LoRA tensor keys are confirmed. After that, the adapter proof's
`qualityGateWithAdapter` command must pass a non-dry-run quality gate with
`ANYVOICE_VOXCPM_LORA_PATH` set to the verified adapter, ECAPA speaker
verification required, the dataset's transcript-validation JSON passed through
when the dataset was not unsafe-bypassed, and quality-gate evidence recording
the adapter path, byte count, and SHA-256 from the run. That verified adapter
must then be
applied with `scripts/apply_voxcpm_lora_adapter.py`, which writes `loraPath`
and a hash-bound `loraAdapter` policy into the profile. The apply script also
rejects adapter proofs whose `datasetProofs.profileSha256` no longer matches
the current profile, then rejects adapter-loaded quality gates whose
`voiceProfileId` / `profileSha256` no longer match the current profile or whose
profile / transcript-validation proof was skipped. A profile edit after LoRA
verification or evaluation therefore forces fresh adapter proof and quality gate
evidence before policy write. The applied policy now also carries the training config
path and SHA-256; the apply step refuses adapter proofs that do not name an
existing training config or whose proof hash does not match it, and profile
loading, profile rebuilds, internal worker requests, runtime generation, and the
completion audit all reject LoRA policies without that train-config evidence.
LoRA apply and completion audit also require the source regression report's
render metadata to prove `loraEnabled=true` and the same `loraPath`, so a
hand-edited quality-gate wrapper cannot claim the adapter was loaded while the
underlying renders were still zero-shot. Conversely, base paired product proof
rejects adapter-loaded quality gates with `inputs.loraPath`; those reports must
flow through the dedicated `lora_quality_gate` stage and cannot unlock the LoRA
dataset export as if they were zero-shot `prompt` vs `hifi` evidence. The
completion audit requires that
applied policy, so a
passing adapter-loaded quality gate cannot stay as a one-off env-var proof that
normal profile generation would ignore. Runtime generation now also reopens the
applied LoRA quality gate before spawning a worker, requires the gate to match
the applied profile/adapter policy, and rechecks the report, ASR, speaker, and
score artifact hashes plus the score JSON's source-report/ASR/speaker hash
bindings. It also rechecks the transcript-validation proof path, SHA-256,
`status=pass`, profile path, voice profile ID, profile hash, and selected-clip
rows so an applied LoRA policy cannot run from a quality gate that later skips
or points at stale transcript proof.
Runtime rejects score/source-report artifacts whose top-level, group, or render
profile evidence no longer matches the applied policy. Runtime also rechecks
the quality-gate source report's ready `hifi` renders for
`effectiveParams.loraEnabled=true` and the same `loraPath`, so a rehashed report
cannot drop the proof that the measured run actually loaded the applied adapter.
That prevents an already-applied `loraPath` from being used after the
adapter-loaded proof artifacts have drifted, were re-hashed from another
profile, or no longer prove adapter-loaded rendering.

The runtime contract for a trained adapter is also wired:
`ANYVOICE_VOXCPM_LORA_PATH` / `--lora-path` is passed through the Next runner,
the one-shot `synthesize_voxcpm_anyvoice.py` bridge, and the preloaded
`voxcpm_hot_worker_anyvoice.py` worker. The local VoxCPM package supports
`lora_weights_path`; the hot worker includes LoRA path/config in its model cache
key so a new adapter reloads once and then stays resident. Metadata records
`loraEnabled`, `loraPath`, and LoRA config under `effectiveParams`, which lets
LoRA output be compared against zero-shot profile output in the same regression
pipeline. Profile generation now prefers a strict profile's applied `loraPath`
over the global env var, keeping per-speaker adapter ownership attached to the
voice profile instead of the process environment. The remaining M4 work is the
actual VoxCPM2 LoRA trainer command and a real trained adapter from qualified
user clips; the post-training proof and runtime load path are now wired, but no
real adapter can be accepted until the recording/profile gates produce usable
clips, the adapter is readable, the adapter-loaded quality gate passes, and the
adapter policy has been applied to the profile.

### M5: Alternative Backend Shootout

- Wire IndexTTS2 behind the same runner contract.
- Render the same eval set.
- Keep only if it beats VoxCPM2 on pronunciation and speaker similarity.

Status: shootout contract added. `scripts/prepare_voice_backend_shootout.py`
turns a ready profile/reference plus the fixed eval set into executable backend
jobs: `jobs.json`, `manifest.json`, `render.sh`, and next commands for
registration/scoring/selection. The default plan now includes the
`voxcpm2-hifi` baseline plus candidate backends such as `indextts2` and
`f5-tts`; it can also use arbitrary backend ids, repeated cases, a shell command
template, and the same target-aware profile reference selection as the VoxCPM2
regression harness. Profile-based plans require a passing same-profile
transcript-validation report before any external backend jobs are written.
Renderer command templates are now validated up front: they must include the
planned output WAV, reference audio, and model-facing text placeholder. If no
template is supplied, the plan is explicitly marked `needs_renderer_command`
and `render.sh` exits with a precise `ANYVOICE_BACKEND_RENDER_COMMAND`
instruction instead of behaving like a loose TODO checklist.
`scripts/render_voice_backend_job.py --preflight --manifest <manifest.json>`
now checks planned render counts, backend-specific envs, local adapter support,
and model cache state before `render.sh` runs. The current local-default
shootout at `generated/voice-backend-shootouts/20260604-054441` is now fully
rendered and registered: `voxcpm2-hifi`, `indextts2`, and `f5-tts` each have
`27/27` ready, hashed WAVs (`81/81` total). The local IndexTTS2 path uses
`solar2ain/mlx-indextts` plus the `vanch007/mlx-indextts2-standard-fp16` MLX
model snapshot. The local F5-TTS path uses the official
`uvx --from f5-tts f5-tts_infer-cli` runner with `SWivid/F5-TTS`
(`F5TTS_v1_Base`) on `mps`. That clears the previous F5 renderer blocker.
The first complete IndexTTS2 paired score was rejected:
`registered-report/indextts2.score.json` produced `verdict=review` and
`registered-report/indextts2.selection.json` produced `verdict=reject`. Against
the VoxCPM2 baseline, IndexTTS2 had `0/9` passing paired cases; average CER/WER
reduction was negative, and every candidate group stayed in review. The first
complete F5-TTS paired score was also rejected:
`registered-report/f5-tts.score.json` produced `verdict=review` and
`registered-report/f5-tts.selection.json` produced `verdict=reject`. F5-TTS had
`0/9` passing paired cases, with negative average CER/WER reduction versus
VoxCPM2 and lower average speaker similarity (`0.793515` candidate vs
`0.813136` baseline in the selector evidence). This means the next backend work
should not ask for more recording. The immediate options are to tune backend
text conditioning/settings, try different checkpoints/runtime options, or move
to the LoRA path.
After the completed backend shootout, the remaining direct quality failures were
not recording-depth failures. The profile was reduced to the requested 7 selected
clips and the speaker-embedding outlier `DennlGsidA` was removed while retaining
all required coverage and pronunciation presets. The refreshed transcript proof
at `.anyvoice/voices/local-default/transcript-validation.json` passes `7/7`
selected clips with profile SHA
`ae2c55518cfa912f69bba69bbf4992c7c5836444bec670eca7c08bb519a236e2`.
`zh_hant_custom_readings` now keeps `重試` as `重試`; the earlier
model-facing `重試 -> 重新測試` repair produced a blind-review rerender request
because the audio no longer matched the displayed text. Case-level ASR
equivalence remains only for faster-whisper homophone choices such as
`行長/航長` and `長樂/常樂`.
`zh_hant_tone_contrast` now keeps the tone trap inside a carrier sentence so the
speaker verifier has enough speech to measure identity; the short standalone
tone phrase topped out at only `0.664385` speaker similarity across the 7 profile
references, while the carrier probe measured `0.850185` against the selected
reference. The refreshed tone probe at
`generated/voice-regression/20260604-075722/score.json` passes. The full native
VoxCPM2 quality gate at `generated/voice-regression/20260604-075831/score.json`
passes all `9/9` groups with `avgCer=0.012656`, `avgWer=0.023073`,
`avgSpeakerSimilarity=0.838183`, no stability review groups, and no speaker
review groups. The paired product gate at
`generated/voice-regression/20260604-080700/score.json` renders both `prompt`
and `hifi` for all 9 cases, and all 18 absolute groups pass. Under the
ceiling-aware product scorer it now produces `pairedComparison.verdict=pass`:
`9/9` pairs pass, average CER reduction is `50.0%`, average WER reduction is
`41.666667%`, average speaker delta is `+0.018621`, and average latency
regression is `5.312667%` against the configured `10%` tolerance. That remains
a metric-only product proof, not a subjective 10x claim. The merged blind review
at `generated/voice-regression/20260604-080700/report.review.json` now passes
the no-regression bar: all `27/27` rounds are reviewed, all are ties, and there
are no rerenders or baseline wins. The reviewer still reported no clear audible
difference between prompt and hifi, so this is a stability/no-regression proof,
not a human 10x preference proof. The triage artifact remains
`generated/voice-regression/20260604-080700/subjective-review-triage.json`.
The `乾淨` reading is now tracked explicitly as `gānjìng`, not `qiānjìng`, via
the eval-set `乾淨 -> 甘淨` model-facing override and reviewer target.
The first gated LoRA dataset export is
`generated/voice-lora-datasets/local-default-20260604-083412/dataset.json`
(`7` clips, `84.349s`, product quality gate required and satisfied). The latest
training handoff is
`generated/voice-lora-training-jobs/local-default-20260604-084344/train_config.json`;
the local VoxCPM LoRA trainer now produces readable weights at
`output/lora_weights.ckpt`, verified by
`output/adapter-proof.json`. The LoRA quality gate at
`generated/voice-regression/20260604-134932/quality-gate.json` passes with the
adapter loaded: `9/9` groups pass, `avgCer=0.013438`, `avgWer=0.014156`,
`avgSpeakerSimilarity=0.843523`, and no stability, speaker, audio, or
profile-reference review groups. That verified adapter policy has been applied
to `.anyvoice/voices/local-default/profile.json`.
Those jobs use the production text-prep contract: `targetTextRaw` /
`targetTextRawFile` preserve the eval sentence, while `targetText` /
`targetTextFile` carry the model-facing preset-pronunciation text that external
renderers should use. Each row also carries `textPrepFile` / `textPreparation`,
so registered external renders are scored with the same pronunciation-alias
policy as native AnyVoice runs.
The scorer also accepts explicit case-level `asrEquivalenceAliases` for known
ASR text ambiguity. Alias hits are recorded as `scoringTarget.kind=asr_alias:*`
instead of pretending the raw target matched exactly, so downstream review can
separate true transcription matches from ASR-equivalence passes.
Case-level custom pronunciation repairs are included in the same contract, so
backend candidates are compared against the corrected model-facing reading
rather than a different prompt path.
After the scorer normalization update, the existing external backend selections
were refreshed and remain rejected. `indextts2.selection.json` and
`f5-tts.selection.json` both keep `verdict=reject`; each still has `0/9`
passing paired cases, missing subjective review evidence, and candidate groups
in review. The FishAudio S2 Pro fallback shootout at
`generated/voice-backend-shootouts/20260604-141034-fishaudio/registered-report`
also produced a rejected proof:
`fishaudio-s2-pro.selection.json` has `verdict=reject`, `0/9` passing paired
cases, `avgCerReductionPct=-91.668`, `avgWerReductionPct=-91.6675`, and
`avgSpeakerSimilarityDelta=-0.152811` versus `voxcpm2-hifi`. The completion
audit now passes through `lora_quality_gate` and treats external
`backend_selection` as optional research unless a `preferredBackend` policy is
actually applied. Missing, rejected, or unapplied external backend evidence is
reported under `optionalStages` / `firstOptionalIssue`; a stale or invalid
applied `preferredBackend` policy still blocks completion because it can affect
runtime.
Backend render command templates can also use `{{seed}}` so external engines
with explicit seeding are compared under the same stability setting as VoxCPM2.
`scripts/register_voice_backend_renders.py` then turns rendered WAVs from that
plan into the same `report.json` plus blind `report.html` shape emitted by
`voice_clone_regression.py`; the example is
`examples/voice_backend_renders.example.json`. This means IndexTTS2, F5-TTS, or
another local backend can be evaluated through the existing ASR, speaker
similarity, paired-improvement scoring, latency comparison, and blind A/B review
pipeline before being wired into the product path. Native and external
regression reports now carry the canonical profile SHA-256 through report,
score, and selection artifacts, so a backend selected before profile evidence
changes cannot be applied to the updated profile. The backend selector checks
that the blind-review source report is profile-bound at report, group, and render
levels before accepting a candidate, so a hand-edited score JSON cannot borrow a
review from another profile. Registration also records
each rendered WAV's byte count, SHA-256, and optional `renderSeconds`; `--allow-missing`
rows are marked `missing` instead of `ready`, so incomplete external backend
plans cannot look like finished evidence. Registration now also rejects explicit
backend identity conflicts between the manifest backend and renderer metadata
fields such as `metadataJson.voiceBackend`, preventing a rendered WAV from being
filed under a different backend label than the engine that produced it.
`scripts/select_voice_backend_candidate.py` is the final
keep/reject gate: it accepts a candidate only when the strict paired score
is bound to one current voice profile at score, source-report, group, and render levels, passes
against `voxcpm2-hifi`, speaker similarity and render latency are
evaluated without regression, and external candidate WAVs carry byte/SHA-256
evidence whose current output files still exist and match the recorded bytes and
hash. It also requires the exported blind `review.json` for the exact source
regression report path and SHA-256, and enforces the same no-regression
subjective bar before accepting a backend, so an alternative backend cannot win
on metrics alone. The selector's `--skip-subjective-review` path is
experiment-only: it requires an explicit unsafe acknowledgement and reason, and
still writes a rejected proof with `subjective_review_bypassed` instead of an
accepted backend selection. External backend selections measured against any baseline
other than `voxcpm2-hifi` stay rejected experiment data; apply/runtime paths,
internal request parsing, profile loads, and profile rebuilds mirror that
baseline requirement before writing, carrying, forwarding, or executing a
policy. `preferredBackend` is external-only: native `voxcpm2-hifi` and
`voxcpm2-lora` choices are represented by the normal VoxCPM/LoRA runtime paths,
not by backend-selection policy. The selector rejects ambiguous blind rounds that contain
multiple baseline or candidate samples for the same case/repeat, so a
hand-edited source report cannot satisfy the preference bar by overwriting A/B
labels. The source report must also preserve the external candidate render's
`externalBackend`, `outputBytes`, `outputSha256`, and current output WAV
evidence; a score JSON cannot become the only place where backend identity and
file hashes are proven. Accepted selection proofs now persist the accepted score,
review, and source-report SHA-256 values; apply/audit rejects the proof if any
referenced artifact has changed and routes the operator back to a fresh
backend shootout/selection instead of re-applying stale evidence. Accepted selections must
then be applied with `scripts/apply_voice_backend_selection.py`, which writes a
hash-bound `preferredBackend` policy into the voice profile; the apply script
first requires the selection proof itself to have `verdict=accept`,
`accepted=true`, and current `voiceProfileId` / `profileSha256` evidence, then
recomputes the selection and rejects score/source-report artifacts whose
`voiceProfileId` or `profileSha256` no longer match the current profile. The
completion audit checks the same selection-profile and source-report evidence
when a `preferredBackend` policy is present, so runtime backend choice cannot
drift away from the accepted evidence. Unapplied accepted proofs remain optional
research until they are explicitly applied. Persisted
profile loads now drop stale `preferredBackend` and `loraAdapter` policies whose
current `voiceProfileId`, canonical `profileSha256`, or `profileJson` no longer match the manifest,
or whose preferred backend policy no longer names the measured baseline backend,
so a later profile edit cannot silently reuse an old backend or LoRA proof.
Runtime execution also reopens the applied `selectionJson` and requires it to
still say `verdict=accept`, `accepted=true`, the same candidate backend, the
same baseline backend, the same profile identity, and the same score/review/report
paths plus SHA-256 values before spawning an external renderer. It also reopens
the applied score and source-report JSON and rejects runtime backend use if the
score no longer points at the same source report/hash or if either artifact's
`voiceProfileId` / `profileSha256` group or render evidence no longer matches
the applied policy. Runtime now also rechecks the source report's external
candidate render evidence and current WAV file bytes/SHA-256, so a
post-selection source report cannot be rehashed into policy while dropping the
proof that the accepted candidate output was actually rendered by the external
backend.
Profile generation now carries that applied policy into the clone runner. If the
selected backend is not `voxcpm2-hifi` or
`voxcpm2-lora`, the runner uses `ANYVOICE_PROFILE_BACKEND_RENDER_COMMAND`
(falling back to the shootout `ANYVOICE_BACKEND_RENDER_COMMAND`) with the same
shell-quoted placeholders used by backend shootout plans, verifies that a
non-empty output WAV was written, and records `voiceBackend` plus selection
hashes in run metadata. If the policy selects an external backend but its
profile / selection / score evidence is incomplete, or if no
renderer command is configured, generation fails clearly instead of silently
falling back to VoxCPM2. By default, an accepted external backend is the primary
runtime backend; setting `ANYVOICE_PROFILE_BACKEND_MODE=voxcpm-first` tries
VoxCPM2 first and falls back to that accepted external backend only after the
VoxCPM2 path throws. That fallback writes `voxcpm-fallback-error.txt` and
records `backendFallbackFrom` / `backendFallbackReason` in metadata so failed
VoxCPM attempts remain auditable. The worker proxy preserves the resolved profile
reference, applied LoRA policy, and preferred backend policy through an
authenticated internal form field accepted only by `/api/local-worker/clone`
and `/api/local-worker/clone/stream`, so Vercel-to-Mac worker handoff does not
drop the evidence-bound runtime selection. The remaining external-backend work
is optional: install/run another candidate backend, fill the planned WAV outputs
from the ready voice profile, and keep the backend only if that selection proof
passes and has been applied to the profile.

## Definition Of 10x Better

"10x" cannot mean one knob. It means the product crosses from toy clone to
repeatable digital voice:

- the user records once, not every run;
- pronunciation failures are measurable and fixable;
- the clone identity is stable across repeated generations;
- the best profile/backend is selected from evidence;
- there is a training path when zero-shot is not enough.

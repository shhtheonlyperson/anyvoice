# AnyVoice

AnyVoice is a consent-gated voice cloning web app. Users record or upload a voice reference, enter target text, and the app sends the request to a local/GPU VoxCPM2 worker.

The Vercel deployment hosts the product UI and API contract. Real VoxCPM2 inference should run on a machine with the model installed; production can forward synthesis requests to a token-protected Mac Studio worker.

## Local Run

```bash
npm install
cp .env.example .env.local
# edit .env.local:
# ANYVOICE_STUB=0
# ANYVOICE_ENABLE_LOCAL_VOXCPM=1
# ANYVOICE_VOXCPM_PYTHON=/path/to/voxcpm/python
# ANYVOICE_ASR_PYTHON=/path/to/python-with-faster-whisper
npm run dev
```

## VoxCPM2 Worker

The local bridge is `scripts/synthesize_voxcpm_anyvoice.py`. It accepts mp3, wav, m4a, and other ffmpeg-readable audio, converts the reference to 16k mono wav, then calls `openbmb/VoxCPM2` through the `voxcpm` Python package.

**Ultimate mode is required.** The script always expects `--prompt-text` / `--prompt-text-file` containing an exact, verified transcript of the reference clip. There is no auto-transcribe fallback — a wrong transcript is the dominant cause of mispronounced output, so the contract pushes that responsibility to the caller. In the UI this is satisfied either by the scripted-recording flow (user reads a known script) or by the freeform/upload flow (user types the transcript).

The UI sends `quality=speed|balanced|quality`. The Python bridge maps those presets to VoxCPM2 timesteps / CFG / denoise settings and returns the effective parameters in `metadata.json`. These are Brenda-derived stability presets, not "more is always better" presets:

- `speed`: `steps=6`, `cfg=1.8`, denoise off for fast drafts.
- `balanced`: `steps=8`, `cfg=2.0`, denoise auto; this tracks Brenda Voice's stable default lane.
- `quality`: `steps=10`, `cfg=2.0`, denoise auto; this is the slightly slower voice-stability lane without aggressive CFG or forced denoise.

Runtime synthesis also uses `ANYVOICE_STABILITY_SEED` to reduce repeat-to-repeat
drift. The default is `1337`; set `ANYVOICE_STABILITY_SEED=off` only for
exploratory renders where variation is intentional. The one-shot bridge, hot
worker, regression harness, quality gate, and backend shootout manifests all
record the effective seed in metadata as `stabilitySeed`.

`POST /api/clone/stream` is the preferred browser path. It returns newline-delimited JSON progress events (`queued`, `reference_preprocessing`, `reference_analyzed`, `model_loading`, `model_ready`, `synthesis_started`, `audio_ready`) followed by the same final payload as `/api/clone`. This improves perceived latency without pretending VoxCPM2 can stream sample-accurate audio before the model has written a WAV.

For local/Mac Studio inference, prefer the hot worker so VoxCPM2 loads once at process startup instead of on every request:

```bash
/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/voxcpm_hot_worker_anyvoice.py \
  --host 127.0.0.1 \
  --port 8765
```

Then set:

```bash
ANYVOICE_ENABLE_LOCAL_VOXCPM=1
ANYVOICE_STUB=0
ANYVOICE_HOT_WORKER_URL=http://127.0.0.1:8765
```

With `ANYVOICE_HOT_WORKER_URL` configured, the Next worker still owns uploads, run directories, validation, and audio serving; it sends file paths to the already-loaded Python process. `model_loading` only appears on true cold start or model reload. The fallback remains `ANYVOICE_VOXCPM_PYTHON` + `scripts/synthesize_voxcpm_anyvoice.py`.
Set `ANYVOICE_ASR_PYTHON` when Faster-Whisper lives in a different Python
environment. If it is not set, profile transcript validation and regression ASR
default to the synthesis Python, so the Brenda VoxCPM env can own both render
and transcription dependencies.
Set `ANYVOICE_SPEAKER_PYTHON` when the speaker-verification dependency stack
lives in a different Python environment. If it is not set, quality-gate speaker
scoring defaults to the synthesis Python, which is usually the right local env
for `torch` / `torchaudio` / `speechbrain`.

After a gated per-speaker LoRA exists, set `ANYVOICE_VOXCPM_LORA_PATH` to the
`.pth` file or directory containing `lora_weights.ckpt`. The one-shot Python
bridge passes it as `lora_weights_path`; the hot worker includes it in the
model cache key and reloads only when the LoRA path/config changes. Run metadata
records `effectiveParams.loraEnabled`, `effectiveParams.loraPath`, and the LoRA
config so zero-shot profile renders and LoRA renders can be compared in the same
regression report.

## Local Persistence

The browser keeps the last user-recorded or user-uploaded reference voice in IndexedDB so local testing does not require recording the same clip repeatedly. The sample voice does not overwrite that saved user reference. The studio also exposes a download button beside the current reference audio, so a good recording can be saved as a real file and reused in a recording kit or manifest later. Clearing a user recording or upload removes the saved browser reference.
Guided voice-profile recordings are also saved as per-prompt browser drafts for
the current five- or ten-clip kit. If the page reloads before enrollment
succeeds, the profile panel shows the saved draft count and each prompt can be
re-added to the voice profile without recording that line again. When every
prompt in the current kit has a draft, the panel can send all saved recordings
to the profile importer in one request.
Browser recording requests mono 48 kHz audio as an ideal capture format and asks
the browser to leave echo cancellation, noise suppression, and automatic gain
control off when supported. Those constraints are intentionally soft so older
browsers can still record, but stable voice-profile takes should avoid
browser-side voice processing whenever possible. During recording, the studio
shows the browser-reported capture settings and warns when processing is still
enabled so a bad mic/browser path is visible before collecting all ten clips.
Profile drafts save those reported capture settings; one-click browser import is
blocked for drafts known to have browser processing enabled. Guided profile
recording also stops before saving a draft when the active mic path reports
browser processing, pushing the user toward a cleaner browser/mic setup or the
external recording kit. The profile panel includes a browser mic preflight button
that checks the active mic path and stops it immediately without saving a draft.

Generated runs are tracked per browser profile with an HTTP-only `anyvoice_user_id` cookie and a local JSON store at `.anyvoice/run-history.json` by default. The studio history lists recent runs for that browser, can reload a prior result, and can remove a run from the visible history. Audio files remain under `.anyvoice/runs/<jobId>/output.wav`.

## Digital Voice Clone Quality Plan

The current zero-shot clone path is not enough for a durable digital voice. The concrete 10x plan is tracked in `docs/VOICE_CLONE_10X_PLAN.md`: Hi-Fi VoxCPM2 clone path, eval harness, per-user voice profiles, pronunciation controls, LoRA training, and an IndexTTS2/F5 backend shootout.

Every run writes both raw and model-prepared text:

- `target.raw.txt` / `target.txt`
- `prompt-transcript.raw.txt` / `prompt-transcript.txt`
- `text-prep.json`

The default policy is `preserve_zh_hant`: normalize only model-safe whitespace and full-width alphanumerics, preserve Traditional Chinese, and warn when Simplified/mixed Chinese is detected. Digital voice profiles require strict zh-Hant transcript coverage; Simplified or mixed Chinese recordings are preserved for debugging, but profile builders reject them before clip selection so they cannot satisfy or fill the enrollment gate.

For known pronunciation failures, the studio auto-applies built-in safe pronunciation presets to `target.txt` and also accepts optional custom replacements in `term=model-readable wording` format. These apply only to model-facing target text; the reference transcript remains exact. Each run stores the raw target text, model-facing target text, and applied replacement counts in `text-prep.json` / `request.json`.
Explicit reading annotations are accepted as `pinyin:term=reading`,
`zhuyin:term=reading`, or `term[reading]=model-readable wording`; those are
stored as custom pronunciation overrides and still apply only to target text.
When the target text contains known risky zh-Hant polyphones, common Simplified
variants, or local product names, the studio records typed replacements so
common failures like `重慶` / `重庆`, `銀行` / `银行`, `角色`, `音樂` / `音乐`,
`AnyVoice`, or `VoxCPM2` are handled before the render. Built-in replacements
are stored with typed preset metadata
(`polyphone` / `brand` plus a stable preset id), while arbitrary user-entered
lines are marked `custom`; neither path edits the exact reference transcript.
The browser preview uses the same auto-preset text-prep as production, so the
model-facing wording is visible before synthesis. Script warnings also include
the concrete Simplified/Traditional marker hits, which makes mixed-script
pronunciation bugs debuggable instead of a generic warning. When those marker
hits are present, the studio offers a manual known-marker Traditional fix button;
it rewrites the target text only after the user clicks it, so the app still does
not silently convert or alter transcripts.
The detector includes common speech markers such as `說/说`, `話/话`,
`讓/让`, `樣/样`, and recording-environment terms so short Simplified target
phrases are blocked from the strict digital-voice path instead of slipping
through as unknown Chinese.

To compare the old prompt-only path against the new Hi-Fi prompt+reference path, run the regression harness with a consented reference clip:

```bash
/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/voice_clone_regression.py \
  --reference-audio /path/to/reference.wav \
  --prompt-text-file /path/to/reference-transcript.txt \
  --clone-mode both \
  --repeats 3
```

For a no-model command preview:

```bash
python3 scripts/voice_clone_regression.py --dry-run --repeats 1
```

The harness writes `report.json` and a blind `report.html` under
`generated/voice-regression/<timestamp>/`. The HTML review page labels paired
renders as Sample A/B, saves local reviewer choices, exports review JSON, and
keeps the prompt/hifi answer key collapsed until after listening.
For a product 10x claim, put that exported JSON beside the report as
`review.json` or `report.review.json`; `scripts/audit_voice_clone_goal.py`
reconstructs the blind key from `report.json` and requires the hifi candidate
to win at least 80% of prompt-vs-hifi rounds.
Each render uses the same target text-prep policy as production: `target.raw.txt`
keeps the eval sentence, `target.txt` contains the model-facing pronunciation
preset version, and `text-prep.json` is passed into the Python worker metadata.

To run the measurable digital-voice gate in one command:

```bash
/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/run_voice_quality_gate.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --hot-worker-url http://127.0.0.1:8765 \
  --clone-mode hifi \
  --repeats 3
```

This writes `report.json`, `asr.json`, `speaker.json`, `score.json`, and
`quality-gate.json` under `generated/voice-regression/<timestamp>/`. With
`--profile-json`, it first verifies the profile has enough qualified clips,
then validates the selected clips against their reference transcripts, then
verifies readiness again with that transcript-validation report before
rendering. The regression phase also rechecks that strict profile proof, so a
dry-run transcript-validation plan is not enough to produce profile-based
regression artifacts. It fails unless clip readiness, transcript alignment,
pronunciation, repeat stability, and speaker identity all pass their gates.

For debugging individual phases, run the same steps manually:

```bash
/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/transcribe_voice_regression.py \
  generated/voice-regression/<timestamp>/report.json \
  --out generated/voice-regression/<timestamp>/asr.json \
  --model large-v3 \
  --language zh

python3 scripts/score_speaker_similarity.py \
  generated/voice-regression/<timestamp>/report.json \
  --out generated/voice-regression/<timestamp>/speaker.json \
  --strict

python3 scripts/score_voice_regression.py \
  generated/voice-regression/<timestamp>/report.json \
  --asr-json generated/voice-regression/<timestamp>/asr.json \
  --speaker-json generated/voice-regression/<timestamp>/speaker.json \
  --out generated/voice-regression/<timestamp>/score.json \
  --strict
```

`transcribe_voice_regression.py` uses `faster-whisper` when available and falls
back to the `whisper` CLI. Use `--asr-python` or `ANYVOICE_ASR_PYTHON` on the
quality gate when the default shell Python cannot import `faster_whisper`; the
same interpreter is used for profile transcript validation and regression ASR.
The score script also accepts externally generated ASR JSON keyed by
`outputWav`, basename, case id, or `cloneMode/caseId/rNN`.
Without ASR transcripts, the scorer still checks repeat stability and marks
pronunciation as `missing_asr` instead of pretending quality improved. CER/WER
scoring folds common Simplified/Traditional glyph variants before comparison, so
Whisper returning `重庆` for an expected `重慶` does not look like a
pronunciation failure; enrollment still requires the profile transcript itself
to be strict zh-Hant. Profile-based regression also rejects Simplified, mixed,
or unproven Chinese eval targets before rendering, so quality gates measure the
fixed Traditional Mandarin lane instead of mixing script drift into voice
stability.
When a render has `text-prep.json`, the scorer evaluates both raw target text
and model-facing target text, then keeps the lower CER/WER candidate. This lets
intentional preset spell-outs like `VoxCPM2 -> Vox C P M two` count as correct
pronunciation instead of false failures.
With a previous score, add
`--baseline-score <old-score.json>` to verify the 50%+ CER/WER reduction bar
from the 10x plan.

Speaker identity is now part of the same score contract.
`score_speaker_similarity.py` reads the regression report, compares each
rendered WAV to its recorded reference, and writes `speaker.json`. Its built-in
`mfcc-cosine` backend is a local proxy that needs no model download; the script
also supports `resemblyzer` and `speechbrain-ecapa` when those packages are
installed. Check the current machine before making a product-quality identity
claim:

```bash
python3 scripts/score_speaker_similarity.py --list-backends
```

`auto` prefers `speechbrain-ecapa` when its dependencies are available, then
`resemblyzer`, then the built-in MFCC proxy. The speaker JSON can also come from
any external embedding scorer as a map or list keyed the same way as ASR
(`outputWav`, basename, case id, or `cloneMode/caseId/rNN`) with values like `0.83` or
`{ "speakerSimilarity": 0.83 }`. When `--speaker-json` is present,
`score_voice_regression.py --strict` fails unless every render has speaker
similarity at or above `--min-speaker-similarity` (default `0.72`).
For product-quality proof runs, add
`--require-speaker-backend speechbrain-ecapa` to `run_voice_quality_gate.py`; the
gate fails before rendering if `auto` would fall back to the MFCC proxy or if the
ECAPA dependency stack is missing. Use `--speaker-python` or
`ANYVOICE_SPEAKER_PYTHON` to point that check at the Python env that owns the
speaker-verification dependencies.
`voice_profile_next_step.py` also surfaces this readiness as
`postRecordingProofPlan.productProofSpeakerBackend`, so the browser proof panel
shows whether the 10x speaker verifier is actually installed before the final
recordings are ready. It reports the Python used for the check so a missing
backend is not confused with checking the wrong environment.
When a regression run renders `--clone-mode both`, the quality gate also asks
`score_voice_regression.py` to compare `prompt` as the in-report baseline
against `hifi` as the candidate. With `--require-paired-improvement`, prompt
groups are allowed to be bad baseline evidence, but every hifi group still has
to pass the absolute pronunciation/stability/speaker gates and beat prompt by
the configured reduction threshold.
For migration or debugging only, `run_voice_quality_gate.py` accepts an existing
`--transcript-validation-json`. Skipping profile readiness or transcript
validation with `--skip-profile-verify` / `--skip-transcript-validation` now
requires
`--allow-unsafe-profile-gate-bypass --unsafe-profile-gate-bypass-reason "<reason>"`,
and that accepted reason is stored in the quality-gate artifact.

To compare an external backend such as IndexTTS2 or F5 against the same eval
set, first prepare a backend shootout plan:

```bash
python3 scripts/prepare_voice_backend_shootout.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --transcript-validation-json .anyvoice/voices/local-default/transcript-validation.json \
  --backend indextts2 \
  --backend f5-tts \
  --case zh_hant_polyphones \
  --repeats 3 \
  --command-template 'python render_backend.py --backend {backend} --text-file {target_text_file} --reference {reference_audio} --prompt {prompt_text_file} --out {output_wav}'
```

This writes `jobs.json`, `manifest.json`, `render.sh`, and a small README under
`generated/voice-backend-shootouts/<timestamp>/`. The command template is
optional; without it, the plan is marked `needs_renderer_command` and
`render.sh` fails clearly until `ANYVOICE_BACKEND_RENDER_COMMAND` is set. The
template must include `{output_wav}`, `{reference_audio}`, and either
`{target_text_file}` or `{target_text}`, so external renders cannot silently
write to the wrong path or use the wrong model-facing text.
Backend shootout jobs use the same raw/model target split as production:
`targetTextRaw` / `targetTextRawFile` preserve the eval sentence, while
`targetText` / `targetTextFile` contain the model-facing preset-pronunciation
text passed to external renderers. The manifest also carries `textPrepFile` and
`textPreparation` so registered backend reports score pronunciation aliases the
same way as native AnyVoice renders.
When `--profile-json` is used, the planner applies the same strict target-script
gate as profile regression: Simplified, mixed, or unproven Chinese cases are
rejected before external backend renders are planned. It also requires a passing same-profile
transcript-validation report and the full strict profile verifier, so alternate
backends are compared from the verified digital-voice reference rather than a
one-clip or prompt/transcript mismatch.
After rendering WAVs, register them instead of changing the scorer:

```bash
python3 scripts/register_voice_backend_renders.py \
  generated/voice-backend-shootouts/<timestamp>/manifest.json \
  --out-dir generated/voice-backend-shootouts/<timestamp>/registered-report
```

The manifest maps external WAVs to `caseId`, `repeat`, and `backend` ids such as
`indextts2` or `f5-tts`. The script writes the same `report.json` and blind
`report.html` shape as `voice_clone_regression.py`, so the next phases are still
`transcribe_voice_regression.py`, `score_speaker_similarity.py`, and
`score_voice_regression.py --baseline-clone-mode voxcpm2-hifi
--candidate-clone-mode indextts2 --require-paired-improvement`.

Once the digital voice profile is ready, run the same regression cases from the saved profile instead of recording or passing a one-off reference again:

```bash
python3 scripts/voice_clone_regression.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --transcript-validation-json .anyvoice/voices/local-default/transcript-validation.json \
  --clone-mode hifi \
  --repeats 3
```

The standalone profile regression path now requires the same strict verifier as
the app and backend shootout: enough qualified clips, real audio files,
user-recorded provenance, strict zh-Hant transcripts, complete pronunciation
coverage, and passing transcript validation. The fast verifier minimum remains
five clips / 30s, but the 10x audit, LoRA export, and training handoff require
ten selected clips / 60s. A one-clip
`status: ready` manifest or a dry-run validation report is rejected before
rendering. The report records the selected profile clip for each case, so
pronunciation/stability checks are tied to repeatable profile evidence.
Profile regression uses the same target-aware reference selection as the app:
after script match, it prefers a profile clip whose transcript covers the
target's pronunciation features such as numbers/dates, English terms,
polyphones, and punctuation/rhythm. For risky terms it also matches exact
pronunciation preset ids, so a target containing `行長` prefers a clip that
actually includes `行長`, not merely any polyphone sentence. Each render records
`targetCoverageFeatures`, `matchedCoverageFeatures`,
`targetPronunciationPresetIds`, and `matchedPronunciationPresetIds`.

To build a profile-readiness manifest from local runs:

```bash
python3 scripts/build_voice_profile.py --dry-run
python3 scripts/build_voice_profile.py --copy-clips
```

The default profile manifest is `.anyvoice/voices/local-default/profile.json`. A profile is only `ready` when at least five clips pass the A/B grade, duration, strict zh-Hant transcript gates, broad coverage gates, and exact required pronunciation preset gates. Selection is coverage-aware: after invalid-script and duplicate transcripts are rejected, the profile keeps eligible clips needed for Traditional Chinese, numbers/dates, English terms, polyphones, punctuation/rhythm, and required preset ids such as `polyphone:chongqing`, `polyphone:bank`, `polyphone:role`, `polyphone:music`, `polyphone:changle`, and `brand:anyvoice` before filling the rest by quality. Guided browser recordings now also track effective active-voice time before saving profile drafts, so silence-heavy takes are blocked before batch import instead of reaching the analyzer as low-VAD clips. Profile-based generation also rejects Simplified, mixed, or unproven Chinese target text; the fixed Mandarin profile expects clear Traditional Chinese target text so script drift does not become another pronunciation variable. Profile-generated runs are excluded from future enrollment so the profile cannot reinforce copies of itself.
If older runs have a reference audio file and transcript but predate
`metadata.referenceQuality`, backfill them before rebuilding:

```bash
python3 scripts/reanalyze_voice_profile_runs.py --dry-run --build-profile
python3 scripts/reanalyze_voice_profile_runs.py --build-profile
```

The backfill preserves existing run metadata, skips profile-generated and
sample-source runs, writes only the analyzer quality fields, and then refreshes
the profile manifest. It uses `ANYVOICE_VOXCPM_PYTHON` from the shell or
`.env.local`, so local runs reuse the Brenda VoxCPM Python environment when
configured. If any candidate reference audio cannot be analyzed, the command
still prints the structured JSON report with `failures`, but exits non-zero so
automation does not treat a partial rescan as clean.
The studio exposes the same path through `POST /api/voice-profile/reanalyze`
and a profile-panel rescan button, so localhost can recover older recordings
without dropping into the CLI.
Repeated readings of the same transcript do not count as multiple qualified
profile clips; the profile builder keeps the best copy and marks the rest
`duplicate_transcript`. This keeps the five-clip gate tied to pronunciation and
cadence coverage instead of repeated takes of one sentence.
The ready gate also requires transcript coverage for Traditional Chinese,
numbers/dates, English terms, polyphone traps, punctuation/rhythm, and exact
core pronunciation preset ids. Missing coverage and missing preset ids appear in
profile diagnostics, so the next recording can fill the actual pronunciation gap
instead of adding another generic sentence.

Before running profile-based regression or LoRA export, verify the manifest:

```bash
python3 scripts/voice_profile_next_step.py

python3 scripts/verify_voice_profile_ready.py \
  --profile-json .anyvoice/voices/local-default/profile.json
```

`voice_profile_next_step.py` is the fastest status command during enrollment:
it reads the current profile plus `generated/voice-profile-recording-kits/local-default-current/manifest.json`
and returns the exact next command: create a kit, record missing WAVs, enroll a
ready kit, run ASR transcript validation, run the quality gate, prepare the
LoRA dataset/training handoff, or prepare the IndexTTS2/F5 backend shootout.
Use `python3 scripts/voice_profile_next_step.py --brief` when you want a compact
terminal checklist: current status, exact next command, missing clips, first
prompt, mic/preflight commands, proof-chain command, and ASR/speaker backend
readiness. The same brief is included in the next-step JSON and shown in the
profile check panel, so the browser and terminal point at the same recording
session.
If the kit has stale prompt files, non-scripted rows, mixed-script transcripts,
or stale terminal-recording sidecars, it returns `needs_recording_kit_fix`
before asking for more audio, so bad evidence is fixed before recording or
enrollment.
During recording phases, the router also includes a no-microphone
`rehearseRecordingKit` command before preflight/recording commands. Use it to
read the exact cue sheet and coverage aloud before committing takes.
Use `python3 scripts/voice_profile_next_step.py --run` for the safe automated
step: in a recording-needed state it runs preflight only, not the microphone.
Recording, enrollment, and ASR/quality-gate work are separate phases requiring
explicit `--allow-recording`, `--allow-enroll`, or `--allow-expensive`. Add
`--auto-advance` to re-check after a successful permitted step and continue
until the next unpermitted or blocked phase. Transcript validation writes the
profile-local `.anyvoice/voices/<profile-id>/transcript-validation.json`, and the
router automatically reuses the latest matching validation report for strict
verification and the quality gate.
After `run_voice_quality_gate.py` writes a non-dry-run hifi `quality-gate.json`
with `status=pass` for that same profile, the router stops asking for the first
quality gate and moves to the stricter product proof gate. LoRA export stays
locked until the paired `prompt` vs `hifi` product proof passes with the required
speaker backend. Dry-run/planned gates are kept as planning evidence but do not
unlock LoRA.
The router also emits `postRecordingProofPlan`: a compact proof chain with the
recommended no-microphone one-shot command for after the kit WAVs are recorded,
the manual fallback commands, and the expected profile, transcript-validation,
and quality-gate artifacts. The recommended command deliberately allows
enrollment and expensive validation/gating, but not recording, so it can prove a
finished kit without unexpectedly opening the microphone. It also passes
`--stop-before-lora`, so a passing product proof can turn the next action into
LoRA dataset export without writing training handoff files automatically.
The same plan now includes `productProofCommand`, a stricter quality gate that
renders `prompt` vs `hifi` and requires `speechbrain-ecapa` speaker verification.
Use that command for the real 10x/product claim and for LoRA handoff. The normal
hifi quality gate is still useful evidence, but it is no longer enough to unlock
the training dataset path.
It also includes `productProofSpeakerBackend`, which reports the required ECAPA
backend status, the current `auto` fallback, the backend check command, and the
missing dependency reason when the product-proof gate is not yet credible.
`productProofAsrBackend` does the same for Faster-Whisper, so the proof panel
cannot imply pronunciation proof is ready while ASR would fall back to a
different backend or the wrong Python environment.

This returns non-zero until the profile clears the reusable-profile minimum:
`ready` status, at least five qualified clips, required pronunciation coverage,
existing clip audio files, user-recorded source provenance, strict zh-Hant raw
transcripts, valid A/B clip metadata, and at least 30 seconds of selected audio.
The full 10x clone path adds the separate `capture_depth` and LoRA gates for ten
selected clips and 60 seconds.
The verifier recomputes script from `transcriptRaw` instead of trusting stored
coverage labels, and rejects selected clips marked `profile` or `sample`. When
it passes, the JSON output includes the exact regression and LoRA dataset
commands to run next. When it is blocked, `recordingPrescription` spells out the
concrete next recording target: clips needed, recommended clip duration,
active-voice target, and missing pronunciation coverage. The verifier does not
take a `--strict` flag; use `--require-transcript-validation` to make ASR
transcript alignment part of the hard gate. Transcript-validation reports must
also point at the same profile manifest, so stale or unrelated ASR proof cannot
unlock profile generation. Skipping selected audio file existence with
`--skip-audio-exists` is migration/debug-only and requires
`--allow-unsafe-audio-exists-bypass --unsafe-audio-exists-bypass-reason "<reason>"`;
the reason is stored in verifier JSON as `audioFileCheck`. For the stricter
pronunciation path,
validate that the recorded audio actually matches each reference transcript
before running profile regression:

```bash
python3 scripts/validate_voice_profile_transcripts.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --out .anyvoice/voices/local-default/transcript-validation.json \
  --strict

python3 scripts/verify_voice_profile_ready.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --transcript-validation-json .anyvoice/voices/local-default/transcript-validation.json \
  --require-transcript-validation
```

`validate_voice_profile_transcripts.py` uses `faster-whisper` or the `whisper`
CLI when available, and also accepts externally generated ASR JSON keyed by
`sourceRunId` or audio path. It uses the same Simplified/Traditional-equivalent
CER/WER scorer as regression so ASR glyph drift does not falsely reject a good
recording. The verifier can require that report so a profile cannot be treated
as regression/LoRA-ready when the transcript and recording disagree.
The localhost transcript-validation API and recording-kit enrollment command
also honor `ANYVOICE_ASR_PYTHON`; use `--transcript-python` on
`enroll_voice_profile_kit.py` when launching enrollment from an environment that
has not loaded `.env.local`.
For scripted automation, `voice_profile_next_step.py --transcript-asr-json
<asr.json> --run --allow-expensive --auto-advance` passes that external ASR JSON
to the validation step and then re-checks the profile with the saved report.
The voice profile panel exposes the same strict verifier through
`POST /api/voice-profile/verify`. It parses blocked verifier output as a normal
report, automatically uses the latest matching transcript-validation JSON when
one exists, and shows the failing checks plus the next command to run.
The same panel can also run `POST /api/voice-profile/transcript-validation`,
which executes `validate_voice_profile_transcripts.py --strict`, writes the ASR
validation report, and then refreshes the strict verifier so the new report is
used immediately.

The studio also calls `/api/voice-profile` and shows the same readiness gate in the UI: qualified clips, rejected clips, and remaining clips needed. Once ready, `Use digital voice` sends `useVoiceProfile=yes`; the server requires the persisted profile manifest to pass the strict check, including ASR transcript validation, before it resolves the best eligible reference clip and exact transcript. Generation no longer depends on the current browser upload. Profile reference selection is target-aware: if the target contains numbers/dates, English terms, polyphone traps, or punctuation/rhythm, the server prefers a qualified profile clip whose transcript covers the same feature before falling back to the stable default clip.

To enroll the current recording without running full synthesis, the studio calls `POST /api/voice-profile/enroll`. This saves the reference clip, runs the same duration/SNR/VAD/clipping analyzer used by synthesis, updates the readiness counts, and avoids repeated expensive VoxCPM2 generations just to build the profile.
When the profile is missing a required coverage feature, the studio recommends the next scripted prompt that fills that gap. The guided action records that prompt, keeps the stop button disabled until the profile minimum duration is reached, and submits it to the profile analyzer after the user stops recording.

The studio blocks known-bad profile enrollment before the analyzer when browser
metadata shows the clip is shorter than the profile minimum, longer than the
profile maximum, has a Simplified/mixed Chinese transcript, or is the built-in
sample voice. Server validation also rejects sample clips and Simplified/mixed
Chinese profile transcripts, so the Traditional Mandarin digital voice is built
only from user recordings or user-uploaded audio with strict zh-Hant transcript
coverage.

The scripted recording flow now provides a five-prompt standard kit and a ten-prompt extended kit instead of one generic line. The zh-Hant prompts cover common Mandarin tone/rhythm cases, numbers, names, pauses, and recording hygiene. The UI also flags Simplified or mixed Chinese in target text or transcripts because the app preserves user text rather than silently converting it.
Fixed enrollment prompts avoid relative wording such as "today" so users do not
silently change the line while reading and break the transcript alignment gate.

The profile API also returns diagnostics: selected grade counts, eligible transcript script mix, top rejection reasons, and rejected clip examples. The studio shows the top issues and recent rejected clips directly in the voice profile panel so the next recording fix is visible.
The voice profile panel also shows a pronunciation coverage checklist for Traditional Chinese, numbers/dates, English terms, polyphone traps, and punctuation/rhythm, so enrollment progress is visible even before the five-clip gate is complete.
Use the panel's strict profile check before trusting the reusable digital voice;
it is stricter than the summary badge because it also requires ASR transcript
validation when available.
After a profile has selected clips, use the panel's transcript-validation action
to run the ASR alignment gate from localhost instead of copying the CLI command
manually.
The same panel now shows the current fixed enrollment prompts as accepted,
rejected, or missing. Missing/rejected rows can be recorded directly from the
checklist, which keeps the user on the shortest path to the minimum profile and
the stronger ten-clip 10x lane.
Recorded prompt drafts persist in this browser and can be re-submitted from the
same checklist, so a failed analyzer run, accidental reload, or interrupted
session does not force another recording take. The next recording suggestion
skips prompts already saved as drafts, keeping browser capture moving through
the profile list instead of circling back to the first un-enrolled line. The
same panel has a browser recording session control that starts the next missing
prompt, auto-stops each take after the guided duration and voice-active gate,
and then queues the following prompt with a short cancelable countdown after
save/enrollment. When that browser session records the last missing prompt, it
imports the completed draft set automatically through
the same fixed-transcript `/api/voice-profile/import` path as bulk file upload.
The manual one-click import remains available when every current-kit prompt
already has a draft. A successful import automatically starts ASR transcript
validation, the strict profile verifier, and the 10x completion audit so the
next blocker is visible without another manual click. Newly recorded drafts store their
browser-measured duration; the checklist marks known clips outside the 6-20
second gate and blocks one-click batch import until those clips are re-recorded.

If browser recording is annoying, record the five prompts in any external app
and import them with a manifest:

```bash
python3 scripts/prepare_voice_profile_recording_kit.py \
  --out-dir /tmp/anyvoice-profile-kit

# stronger 10-clip capture for the 10x / LoRA path:
python3 scripts/prepare_voice_profile_recording_kit.py \
  --prompt-set extended \
  --out-dir /tmp/anyvoice-profile-kit-extended

# record each prompt into /tmp/anyvoice-profile-kit/recordings/:
python3 scripts/record_voice_profile_recording_kit.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json \
  --rehearse \
  --no-default-recorder \
  --auto-duration

python3 scripts/record_voice_profile_recording_kit.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json \
  --preflight \
  --auto-duration

python3 scripts/record_voice_profile_recording_kit.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json \
  --preflight \
  --brief \
  --auto-duration

	# record all missing WAVs; each take is checked before the next prompt:
	python3 scripts/record_voice_profile_recording_kit.py \
	  --manifest /tmp/anyvoice-profile-kit/manifest.json \
	  --record-missing-until-complete \
	  --countdown-sec 2 \
	  --write-metadata \
	  --check \
	  --auto-duration

	# optional: after the kit check passes, enroll/validate/run the quality gate:
	python3 scripts/record_voice_profile_recording_kit.py \
	  --manifest /tmp/anyvoice-profile-kit/manifest.json \
	  --record-missing-until-complete \
	  --countdown-sec 2 \
	  --write-metadata \
	  --run-proof-after-check \
	  --auto-duration

# then import/build/verify:
python3 scripts/enroll_voice_profile_kit.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json
```

If you record from Voice Memos, a phone, or another app, keep the exported files
named by clip id such as `profile-clip-01.m4a` through `profile-clip-10.m4a`,
place them in the kit `recordings/` folder or pass `--source-dir`, then normalize
them into the exact manifest WAV paths:

```bash
python3 scripts/normalize_voice_profile_recording_kit_audio.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json \
  --source-dir /path/to/exported-recordings \
  --check
```

The normalizer converts supported formats with `ffmpeg`, writes transcript-hash
sidecars, and runs the same kit checker when `--check` is present. The localhost
profile panel auto-loads the current kit at
`generated/voice-profile-recording-kits/local-default-current/manifest.json` and
exposes the same path as **Normalize phone files**. Its bulk upload control also
uses that kit manifest, so an extended 10-clip kit expects `profile-clip-01`
through `profile-clip-10` and pairs each file with the manifest transcript
instead of the older five-clip browser script list. The browser recording
progress panel uses the same manifest clips, so the in-browser path can capture
all ten 10x prompts before importing them.

`enroll_voice_profile_kit.py` runs the kit check, imports clips, rebuilds the
profile, and verifies readiness in one JSON-reporting command. Add
`--validate-transcripts` after recording to run the ASR transcript alignment
gate in the same workflow; when it runs or when `--transcript-validation-json`
is supplied, the final verifier requires that validation report to pass before
reporting `ready`. Recording-kit enrollment defaults to `sourceKind=scripted`,
so those clips remain distinguishable from freeform uploads in profile evidence.
The `--skip-kit-check` bypass is migration/debug-only and now requires
`--allow-unsafe-skip-kit-check --unsafe-skip-kit-check-reason "<reason>"`; the
reason is stored in the JSON workflow report so a skipped preflight cannot look
like normal enrollment.
Likewise, `--trust-manifest-quality` is migration/debug-only. Normal imports run
the analyzer on each clip; trusting `quality` / `referenceQuality` values from a
manifest requires
`--allow-unsafe-trust-manifest-quality --unsafe-manifest-quality-reason "<reason>"`,
and the reason is stored in run metadata as `referenceQualitySource`.
Generated recording-kit manifests also mark each fixed-prompt row as
`sourceKind=scripted` and include script/coverage diagnostics plus cue-sheet
pronunciation notes for risky names and polyphones such as `Brenda`,
`AnyVoice`, `重慶`, `銀行`, `音樂`, and `長樂`. Those notes are not part of
the transcript and should not be read aloud; they only keep the recording take
consistent. Kit creation rejects Simplified or mixed Chinese prompt manifests
before writing files, so script drift is fixed before any external recorder
opens the microphone.
Each generated kit now includes `cue-sheet.html`, a static reading view with the
exact transcripts, output filenames, and pronunciation notes. Use it when
recording from another screen or phone; it is generated from the same manifest
that later drives the import and verifier.
The profile panel can also create this kit from the browser on localhost; it
shows the `recordings/` path, cue-sheet path, a direct localhost cue-sheet link,
a `python3 -m webbrowser -t` fallback command, import-only enrollment command, and the full
after-recording proof command with `--stop-before-lora`. After
recording into that folder, the panel can run the same kit check from localhost
and report missing files, clips outside the 6-20 second duration gate,
recordings with less than 5.2 seconds of active voice, stale prompt files,
stale terminal-recording sidecars, non-scripted kit rows, or coverage gaps
before import. Non-WAV files are decoded with `ffmpeg` for the active-voice
gate; if they cannot be decoded, they do not pass the kit check.
For the actual 10x/LoRA lane, prefer the extended kit. It records ten distinct
Traditional Mandarin prompts, still inside the same `maxClips=10` profile
contract, so the profile selector and LoRA dataset have more rhythm, product
name, number/date, pause, and polyphone evidence than the five-clip minimum.
The `voice_profile_next_step.py` router also includes a `recordingBrief` when a
kit exists: every clip transcript, audio path, missing-audio flag, coverage
features, and cue-sheet pronunciation notes. The browser renders that brief
after a failed strict profile check, so the next-step recommendation contains
the actual words to record instead of only a shell command. Its focused
single-clip record commands also include `--check-selected`, so a bad take is
caught before you move on to the next missing prompt.
`record_voice_profile_recording_kit.py` is the terminal shortcut for the same
folder: it reads each prompt, records into the exact manifest WAV path with
`rec`, `ffmpeg`, `ANYVOICE_RECORDER_COMMAND`, or `--recorder-command`, skips
existing non-empty clips unless `--overwrite` is set, and supports
`--record-missing-until-complete` so the default workflow records all missing
prompts one by one, validates each take's file, duration, active voice,
transcript script, prompt file, and metadata before moving on, and stops at the
first bad take. `--next-missing --check-selected` remains available for one
focused prompt while ignoring the other still-missing kit clips. Preferred
recording commands include `--auto-duration`, which derives a 6-20 second target
from each transcript so longer Mandarin/polyphone prompts are not rushed into
the old fixed nine-second window.
After all kit WAVs exist, run the same script with `--check` to gate the kit
before enrollment. With `--write-metadata`, each terminal-recorded WAV
gets a `.recording.json` sidecar containing the exact transcript and transcript
SHA-256 used for that take, plus any cue-sheet pronunciation notes, so the
checker can reject audio recorded from an older cue sheet. Use
`--rehearse --no-default-recorder --auto-duration` to print the exact cue sheet,
pronunciation notes, per-prompt targets, and coverage without requiring a
recorder, then use `--preflight` before recording to verify the
backend, missing/existing files, prompt-file drift, stale sidecars for existing
skipped recordings, Simplified/mixed transcript drift, command previews, and
writable paths without touching the microphone. The recorder refuses target
durations outside the 6-20 second
profile gate before opening the microphone unless
`--allow-out-of-range-duration` is passed for debugging; the JSON plan also
reports the 5.2 second active-voice target and recording checklist.
`--auto-duration` stays inside that same gate while giving longer prompts more
room. Add
`--brief` to `--preflight`, `--rehearse`, or `--dry-run` for a compact terminal
view with the cue-sheet path, cue-sheet open command, recordings folder, next
clip, and exact record commands. Generated record commands include
`--open-cue-sheet`, so the browser cue sheet opens before the first microphone
take. Use `--dry-run` to inspect the same plan
without failing when a recorder is missing.
If the kit check finds an existing take that is too short, too long, unreadable,
or below the active-voice gate, `voice_profile_next_step.py` points at the first
failed clip with `--clip <id> --overwrite --write-metadata` so only that bad
take is replaced.
Add `--run-proof-after-check` when the kit WAVs are present and you want the
terminal flow to continue through the no-microphone proof chain automatically:
it runs the kit check first, then calls `voice_profile_next_step.py --run
--auto-advance --allow-enroll --allow-expensive --stop-before-lora --max-steps
3` only after the kit reports `ready_to_import`. Generated kit JSON, README, the
cue sheet, and the localhost profile panel expose this as
`recordAndProveCommand`, so the operator does not need to remember a separate
proof command after terminal recording. Use `--run-product-proof-after-check`
for the stricter 10x claim: it first runs that normal proof chain, then runs the
paired `prompt` vs `hifi` quality gate with the required product speaker backend.
Generated kits expose that as `recordProveAndProductProofCommand`. Use
`--prepare-lora-after-product-proof` only when you want to continue past proof
into the consented LoRA dataset handoff; generated kits expose it as
`recordProveProductProofAndLoraCommand`, and terminal preflight briefs print the
same handoff command beside the normal record/proof commands. The next-step
router also requires `--allow-lora-export` before `--run` can write that
dataset. On this machine the default recorder is SoX `rec` when available.
The generated `README.md` and `cue-sheet.html` now include the same after-recording
proof command:

```bash
python3 scripts/voice_profile_next_step.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --kit-manifest generated/voice-profile-recording-kits/local-default-current/manifest.json \
  --profile-id local-default \
  --run --auto-advance --allow-enroll --allow-expensive --stop-before-lora
```

Use that after the kit WAV files are present. It can enroll and run expensive
ASR/quality gates, but it will not open the microphone or write LoRA dataset
handoff files.
To audit the full goal state at any point, run:

```bash
python3 scripts/audit_voice_clone_goal.py --fail-unless-complete
```

For a recording-session checklist instead of JSON, use:

```bash
python3 scripts/audit_voice_clone_goal.py --brief
```

The audit is read-only. It reports each gate separately: recording kit,
strict profile plus transcript validation, 10-clip capture depth, proof backend environment
(`faster-whisper` ASR plus `speechbrain-ecapa` speaker verification), normal
quality gate, paired 10x product proof, blind subjective review, LoRA dataset,
LoRA training job, readable adapter proof, and a LoRA quality gate run with the
verified adapter loaded. Even when the first blocker is still the recording kit,
the audit also surfaces the proof-backend check command
and a focused first-missing-clip command with `--check-selected`. It also embeds
the no-microphone recorder preflight status, so missing ASR or ECAPA
dependencies, recorder setup issues, and bad first takes can be caught before
the full recording session continues.
If you already have the five clips as files, the same panel can bulk-upload
them directly; keep filenames as `profile-clip-01` through `profile-clip-05` so
the app can pair each audio file with the right transcript. `/api/voice-profile/import`
rejects Simplified or mixed Chinese transcripts before analyzer work, enrolls
each clip, writes `.anyvoice/voices/local-default/profile.json` with copied
profile audio, returns the updated readiness state, and triggers the same
transcript-validation plus 10x audit checks shown in the profile panel.

Or start from the example manifest directly:

```bash
cp examples/voice_profile_import_manifest.example.json /tmp/anyvoice-profile-manifest.json
# edit audioPath values to point at the recorded clips
python3 scripts/enroll_voice_profile_kit.py \
  --manifest /tmp/anyvoice-profile-manifest.json
```

For manual debugging, the individual phases remain available:

```bash
python3 scripts/check_voice_profile_recording_kit.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json

/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/import_voice_profile_clips.py \
  --manifest /tmp/anyvoice-profile-kit/manifest.json \
  --build-profile

python3 scripts/verify_voice_profile_ready.py \
  --profile-json .anyvoice/voices/local-default/profile.json
```

The kit checker catches missing recording filenames, stale prompt files that no
longer match `manifest.json`, stale terminal `.recording.json` transcript
hashes, non-scripted kit rows, Simplified/mixed Chinese transcripts with exact
marker hits, and missing transcript coverage before import. The importer also
rejects Simplified/mixed Chinese transcripts before writing run evidence or
running the analyzer. When import passes, it writes the
same local run evidence as
`/api/voice-profile/enroll`, runs the profile analyzer for each clip, and
rebuilds `.anyvoice/voices/local-default/profile.json`.

When the profile is ready, prepare the per-speaker LoRA dataset handoff:

```bash
python3 scripts/prepare_voice_lora_dataset.py \
  --profile-json .anyvoice/voices/local-default/profile.json \
  --transcript-validation-json .anyvoice/voices/local-default/transcript-validation.json \
  --quality-gate-json generated/voice-regression/<timestamp>/quality-gate.json \
  --require-product-proof-quality-gate \
  --min-clips 10 \
  --min-total-duration-sec 60.0 \
  --copy-audio
```

This writes `dataset.json`, `manifest.train.jsonl`, `manifest.val.jsonl`, and `manifest.all.jsonl` under `generated/voice-lora-datasets/<profile-id>-<timestamp>/`. The script refuses to run until the profile passes the same strict verifier used by profile regression and, by default, has ten selected clips plus at least 60 seconds of selected audio. It also requires existing audio files, user-recorded provenance, strict zh-Hant transcripts, per-clip duration/grade checks, and complete pronunciation coverage. Each exported row carries the source profile audio path plus audio/transcript SHA-256 hashes, so later training handoffs can detect stale or hand-edited rows. LoRA experiments cannot accidentally train on the current short draft recordings or a ready-looking manifest with weak clip evidence.
Direct LoRA export also requires a passing same-profile transcript-validation JSON
and a matching non-dry-run paired product-proof quality gate JSON. The
`--require-product-proof-quality-gate` flag rejects a hifi-only gate, even if it
passed. The escape hatches
`--skip-transcript-validation` and `--skip-quality-gate` exist only for explicit
migration/debug handoffs: they are dry-run-only unless the export also includes
`--allow-unsafe-export --unsafe-bypass-reason "<reason>"`, and that reason is
stored in `dataset.json`.
`voice_profile_next_step.py` also discovers the latest matching non-dry-run
paired product-proof gate under `generated/voice-regression/**/quality-gate.json`;
once that gate has `status=pass`, its next action becomes this dataset export
instead of another proof run.
The same router also exposes `prepare_voice_backend_shootout.py` as a secondary
10x path once the strict profile is ready, so a faster or more stable external
backend can be planned from the same verified voice profile instead of a one-off
reference recording.
Then prepare the VoxCPM LoRA training job handoff:

```bash
python3 scripts/prepare_voxcpm_lora_training_job.py \
  --dataset-json generated/voice-lora-datasets/<profile-id>-<timestamp>/dataset.json \
  --min-clips 10 \
  --min-total-duration-sec 60.0
```

This validates every manifest row, row hash, source profile audio path, and audio file, writes `train_config.json`,
`train.sh`, and `README.md` under `generated/voice-lora-training-jobs/`, and
records the expected adapter path `output/lora_weights.ckpt`. Brenda's installed
VoxCPM package exposes LoRA load/runtime support plus `voxcpm.training` helper
modules, but not a packaged `voxcpm train` CLI, so `train.sh` requires an
external trainer command before it will run training. The top-level completion
audit keeps `lora_training_job` blocked when only `train_config.json` exists:
it passes that gate only when `train_config.trainer.status=ready` with a
non-empty command template, `ANYVOICE_VOXCPM_TRAINER_COMMAND` is set for the
run, or a passing `output/adapter-proof.json` exists. The audit also requires
the LoRA dataset to contain the full 10 selected clips and at least 60 seconds
of selected audio, so a five-clip minimum profile cannot become final digital
clone proof. The training-job handoff also refuses datasets that are missing
transcript-validation / quality-gate
proof metadata, validates that those proof files are passing and match the same
profile, verifies every dataset row against the transcript-validation clip proof,
and refuses unsafe-bypassed datasets unless the command includes
`--allow-unsafe-dataset --unsafe-dataset-reason "<reason>"`; that
acknowledgement is stored in `train_config.json`.
The generated job also records `lora.adapterProof` and
`nextCommands.verifyAdapter`. After the external trainer writes
`output/lora_weights.ckpt`, `train.sh` runs
`scripts/verify_voxcpm_lora_adapter.py` and writes `output/adapter-proof.json`.
That verifier checks the adapter path, byte size, SHA-256, dataset minimums, and
dataset proof metadata, including the paired product-proof marker from the LoRA
dataset handoff. In a plain Python environment it can produce only a metadata
proof; the generated final verifier command includes `--require-readable-checkpoint`
so the VoxCPM/Torch environment must confirm readable LoRA tensor keys before
the adapter is treated as final. The adapter proof then emits
`qualityGateWithAdapter`; the 10x audit requires that non-dry-run quality gate
to pass with `ANYVOICE_VOXCPM_LORA_PATH` set to the verified adapter and ECAPA
speaker verification required.

After training produces VoxCPM-compatible LoRA weights, point local synthesis at
them:

```bash
ANYVOICE_VOXCPM_LORA_PATH=/path/to/lora_weights.ckpt \
ANYVOICE_ENABLE_LOCAL_VOXCPM=1 \
ANYVOICE_STUB=0 \
npm run dev
```

For the hot worker, pass `--lora-path /path/to/lora_weights.ckpt` at startup or
set `ANYVOICE_VOXCPM_LORA_PATH` on the Next process so requests include the LoRA
path. A changed LoRA path reloads the hot model once, then subsequent requests
reuse the loaded LoRA model.

If the hot worker is already running, avoid repeated model loads:

```bash
/Users/shh/proj/brenda-voice/.venv-voxcpm/bin/python \
  scripts/voice_clone_regression.py \
  --hot-worker-url http://127.0.0.1:8765 \
  --reference-audio /path/to/reference.wav \
  --prompt-text-file /path/to/reference-transcript.txt \
  --case zh_hant_polyphones \
  --clone-mode both \
  --repeats 2
```

For fast local debugging, narrow the run before rendering all cases:

```bash
python3 scripts/voice_clone_regression.py \
  --dry-run \
  --case zh_hant_polyphones \
  --clone-mode both \
  --repeats 2
```

## Mac Studio Worker

Run the protected worker on the Mac Studio with local VoxCPM2 enabled:

```bash
ANYVOICE_ENABLE_LOCAL_VOXCPM=1 \
ANYVOICE_STUB=0 \
ANYVOICE_VOXCPM_PYTHON=/path/to/voxcpm/python \
ANYVOICE_HOT_WORKER_URL=http://127.0.0.1:8765 \
ANYVOICE_WORKER_TOKEN=<local-secret-token> \
ANYVOICE_WORKER_MODE=1 \
npm run dev -- --port 3001
```

`ANYVOICE_WORKER_MODE=1` is the explicit opt-in to worker mode. When set, `/api/runs/:jobId/audio` requires `Authorization: Bearer ANYVOICE_WORKER_TOKEN`. Leave it unset for studio/dev — the audio route is then public so the browser can play locally-generated clips without a token.

Expose that local server through a stable HTTPS tunnel, then set Vercel env:

```bash
ANYVOICE_WORKER_URL=https://your-worker-host.example
ANYVOICE_WORKER_TOKEN=<same-local-secret-token>
```

The public `/api/clone` route forwards to `/api/local-worker/clone`; `/api/clone/stream` forwards to `/api/local-worker/clone/stream`. Generated audio stays on the worker and `/api/runs/:jobId/audio` proxies it back through Vercel with the server-side token.

Brenda Voice already has the equivalent hot-daemon pattern: `brenda tts` auto-spawns `scripts/voxcpm_hot_service_v1.py`, keeps VoxCPM2 loaded, and reuses prompt/cache state across runs.

## Planning Artifact

`docs/recording-experience-roadmap.html` is a standalone interactive rationale log for the recording / synthesis / streaming UX plan. It is intentionally static and can be opened directly in a browser.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

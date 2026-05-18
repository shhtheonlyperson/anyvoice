# AnyVoice PRD

## Recommendation

Build AnyVoice as a Vercel-hosted product surface with a separate local/GPU VoxCPM2 worker. The website should be useful immediately for upload, recording, request validation, and result playback, while making the inference boundary explicit instead of pretending Vercel serverless can run a large voice model reliably.

## Goal

Let a user clone a voice from their own recording or uploaded audio, then synthesize new text with VoxCPM2.

## Non-Goals

- No impersonation workflows, hidden consent bypass, or public gallery of cloned voices.
- No long-term voice storage in v1.
- No serverless-only promise for VoxCPM2 inference.

## Users

- A creator testing narration in their own voice.
- A product engineer validating local-first voice workflows.
- A researcher comparing reference-only versus prompt-transcript cloning quality.

## Core Requirements

- Accept microphone recording in-browser.
- Accept uploaded audio files such as mp3, wav, m4a, and other ffmpeg-readable formats.
- Require explicit consent before submission.
- Accept target text to synthesize.
- Support optional style guidance.
- Support optional exact reference transcript for VoxCPM2 ultimate cloning.
- Produce a playable synthesized audio result when a VoxCPM2 worker is connected.
- Show a clear worker-missing state on Vercel preview.
- Document local worker setup.

## Product Flow

1. User records or uploads voice audio.
2. User enters target text.
3. User optionally adds style guidance.
4. User optionally adds exact transcript for the reference clip.
5. User confirms permission to clone the voice.
6. App uploads the request to `/api/clone`.
7. API saves the run locally and invokes `scripts/synthesize_voxcpm_anyvoice.py` when enabled.
8. API returns a job id, status, and audio URL.
9. UI plays the result or shows the worker setup state.

## Design Direction

Use the local `~/DESIGN.md` warm-canvas system: cream canvas, coral primary actions, editorial serif display, humanist sans UI labels, dark product surfaces for technical/runtime state, and restrained teal/amber accents. The app should open as the tool itself, not as a marketing landing page.

Huashu-specific decisions:

- Default locale is Traditional Chinese with an English toggle.
- Use a hi-fi product-tool layout, not a generic SaaS hero.
- Use code-native controls for recording, upload, consent, target text, and playback.
- Keep the visual emphasis on the waveform and clone pipeline state.

## VoxCPM2 Integration

Official model: `openbmb/VoxCPM2`.

Modes:

- Reference-only: pass the uploaded reference through `reference_wav_path`.
- Ultimate: pass the same converted reference as `reference_wav_path` and `prompt_wav_path`, plus the exact transcript as `prompt_text`.

Runtime:

- Local Python bridge uses `voxcpm`, `soundfile`, and `ffmpeg`.
- Vercel defaults to `ANYVOICE_STUB=1` / worker-missing mode.
- Production-grade inference should move behind a GPU worker endpoint or local personal gateway.

## Safety

- Consent checkbox is required before any clone request.
- UI copy states that the user must own or have permission to use the voice.
- API rejects requests without consent.
- Generated output should be labeled as AI-generated in downstream product surfaces.

## v1 Acceptance Criteria

- `docs/PRD.md` exists and captures the product, safety, design, runtime, and launch constraints.
- Next app builds locally.
- Home page supports recording, upload, target text, optional prompt transcript, consent, submit, and result playback state.
- `/api/clone` validates inputs and calls the VoxCPM2 bridge when enabled.
- `/api/runs/[jobId]/audio` serves local generated audio.
- Vercel project is linked to the GitHub repo.
- Preview deployment builds.

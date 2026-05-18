# AnyVoice

AnyVoice is a consent-gated voice cloning web app. Users record or upload a voice reference, enter target text, and the app sends the request to a local/GPU VoxCPM2 worker.

The Vercel deployment hosts the product UI and API contract. Real VoxCPM2 inference should run on a machine with the model installed; the Vercel preview defaults to safe worker-missing mode because VoxCPM2 is a large PyTorch model and is not a good fit for Vercel serverless.

## Local Run

```bash
npm install
cp .env.example .env.local
# edit .env.local:
# ANYVOICE_STUB=0
# ANYVOICE_ENABLE_LOCAL_VOXCPM=1
# ANYVOICE_VOXCPM_PYTHON=/path/to/voxcpm/python
npm run dev
```

## VoxCPM2 Worker

The local bridge is `scripts/synthesize_voxcpm_anyvoice.py`. It accepts mp3, wav, m4a, and other ffmpeg-readable audio, converts the reference to 16k mono wav, then calls `openbmb/VoxCPM2` through the `voxcpm` Python package.

Reference-only mode works with just uploaded audio. Ultimate mode is enabled when the user also provides an exact transcript for that same reference clip.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

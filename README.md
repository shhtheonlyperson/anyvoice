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
npm run dev
```

## VoxCPM2 Worker

The local bridge is `scripts/synthesize_voxcpm_anyvoice.py`. It accepts mp3, wav, m4a, and other ffmpeg-readable audio, converts the reference to 16k mono wav, then calls `openbmb/VoxCPM2` through the `voxcpm` Python package.

Reference-only mode works with just uploaded audio. Ultimate mode is enabled when the user also provides an exact transcript for that same reference clip.

## Mac Studio Worker

Run the protected worker on the Mac Studio with local VoxCPM2 enabled:

```bash
ANYVOICE_ENABLE_LOCAL_VOXCPM=1 \
ANYVOICE_STUB=0 \
ANYVOICE_VOXCPM_PYTHON=/path/to/voxcpm/python \
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

The public `/api/clone` route forwards to `/api/local-worker/clone`. Generated audio stays on the worker and `/api/runs/:jobId/audio` proxies it back through Vercel with the server-side token.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

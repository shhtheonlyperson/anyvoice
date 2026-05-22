# TODO

## Public domain (`voice.theonlyperson.com`) → point at the local worker

**Status:** deferred — circle back later.

**Problem:** `voice.theonlyperson.com` currently serves a **Vercel** deployment,
which is the wrong backend. AnyVoice is **device-local by design** — it needs
the local Python analyzer (`scripts/analyze_voice_reference.py`, numpy/soundfile
in the VoxCPM venv), the VoxCPM2 hot worker (`:8765`), local file storage
(`.anyvoice/voices` · `runs` · `books`), and ffmpeg/yt-dlp. None of those exist
on Vercel's serverless runtime.

Confirmed live on the domain:
- Recording/enroll → `spawn python3 ENOENT` (no Python venv on Vercel; not
  fixable by restart, unlike the local server).
- Generate → "voice profile is not usable" (no clips; storage is ephemeral).
- Profile create → silently fails (read-only/ephemeral filesystem).

The working URL is the local Mac Studio server **`localhost:3001`** (served by
the launchd agent `com.shh.anyvoice-worker` → `.anyvoice/start-worker.sh` →
`next start -p 3001`).

**Fix (when we circle back):** repoint `voice.theonlyperson.com` away from
Vercel and at the Mac Studio's `:3001` via an HTTPS tunnel (the mic's
`getUserMedia` requires a secure context):
- **Cloudflare Tunnel** (`cloudflared`): map the domain → `http://localhost:3001`.
  Run `cloudflared tunnel login` (interactive), create a tunnel, route the
  hostname, and run it (ideally as its own launchd agent alongside the worker).
- Or **Tailscale Funnel** if we prefer the tailnet.

**Not viable:** keeping Vercel as the frontend. Generation *could* be proxied to
the Mac Studio via `ANYVOICE_WORKER_URL` + `ANYVOICE_WORKER_TOKEN`, but
enrollment (Python analyzer), local storage, and YouTube import have no proxy
path and would still break — would require a major re-architecture.

**Operational note (already fixed once):** after editing `.env.local` or
rebuilding, restart the local worker so it re-sources env:
`launchctl kickstart -k gui/$(id -u)/com.shh.anyvoice-worker`.

## Google-OAuth access gate (Auth.js) — finish the manual setup

**Status:** code DONE; needs Google credentials + (for the public domain) the tunnel above.

The whole app is now gated behind Google login with a hard email allowlist
(`huge.huang@gmail.com`, `shh@theonlyperson.com`). Implemented with Auth.js v5:
- `auth.ts` — Google provider + `signIn`/`authorized` allowlist (extendable via
  `ANYVOICE_ALLOWED_EMAILS`); JWT sessions, no DB.
- `app/api/auth/[...nextauth]/route.ts` — Auth.js handlers.
- `proxy.ts` — Next 16 proxy (ex-middleware) gating all routes except
  `/api/auth/*` and static assets. Verified: anonymous `/` and `/api/*` → 307 to
  `/api/auth/signin`.

**Remaining manual steps (cannot be done from code):**
1. Google Cloud Console → create an OAuth 2.0 Client ID (type: **Web application**).
2. Authorized redirect URIs:
   - `http://localhost:3001/api/auth/callback/google` (local testing)
   - `https://voice.theonlyperson.com/api/auth/callback/google` (production)
3. OAuth consent screen: while it's in **Testing**, add both emails as test
   users (the allowlist enforces access regardless, but Google itself blocks
   non-test users in testing mode).
4. Paste `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` into `.env.local`; restart the
   worker. `AUTH_SECRET` is already set.
5. When the domain points at `:3001` (tunnel item above), set
   `AUTH_URL=https://voice.theonlyperson.com` in `.env.local` and restart.

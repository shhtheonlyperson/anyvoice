#!/bin/zsh
# Set up a Cloudflare Tunnel that publishes voice.theonlyperson.com -> the local
# AnyVoice worker on http://localhost:3001, and run it as a launchd agent.
#
# PREREQUISITE (one-time, manual — done in Cloudflare + Squarespace, not here):
#   1. Add the zone `theonlyperson.com` to a Cloudflare account
#      (dash.cloudflare.com -> Add a site).
#   2. In Squarespace -> Domains -> theonlyperson.com -> DNS / Nameservers,
#      change the nameservers to the two Cloudflare gave you. Wait for Cloudflare
#      to show the zone as "Active" (can take minutes to a few hours).
#   3. Remove the old Vercel record for `voice` if Cloudflare imported it
#      (this script's `route dns` step creates the right CNAME).
#
# Then run this script. It is safe to re-run.
set -euo pipefail

TUNNEL_NAME="anyvoice"
HOSTNAME="voice.theonlyperson.com"
LOCAL_URL="http://localhost:3001"
CFDIR="$HOME/.cloudflared"
PLIST="$HOME/Library/LaunchAgents/com.shh.anyvoice-tunnel.plist"
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"

echo "==> Using cloudflared: $CLOUDFLARED"
"$CLOUDFLARED" --version

# 1. Authenticate (opens a browser; pick the theonlyperson.com zone).
if [[ ! -f "$CFDIR/cert.pem" ]]; then
  echo "==> Logging in to Cloudflare (a browser window will open)…"
  "$CLOUDFLARED" tunnel login
fi

# 2. Create the named tunnel if it doesn't exist; capture its UUID.
if ! "$CLOUDFLARED" tunnel list --output json | grep -q "\"name\":\"$TUNNEL_NAME\""; then
  echo "==> Creating tunnel '$TUNNEL_NAME'…"
  "$CLOUDFLARED" tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$("$CLOUDFLARED" tunnel list --output json | python3 -c "import json,sys;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$TUNNEL_NAME'))")"
echo "==> Tunnel id: $TUNNEL_ID"

# 3. Write the tunnel config (ingress: hostname -> local worker).
cat > "$CFDIR/config.yml" <<YML
tunnel: $TUNNEL_ID
credentials-file: $CFDIR/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME
    service: $LOCAL_URL
  - service: http_404
YML
echo "==> Wrote $CFDIR/config.yml"

# 4. Point the hostname's DNS at the tunnel (requires the zone to be on Cloudflare).
echo "==> Routing $HOSTNAME -> tunnel…"
"$CLOUDFLARED" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

# 5. Install + (re)load a launchd agent so the tunnel runs on login and restarts.
cat > "$PLIST" <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.shh.anyvoice-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$CFDIR/config.yml</string>
    <string>run</string>
    <string>$TUNNEL_NAME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$CFDIR/tunnel.log</string>
  <key>StandardErrorPath</key><string>$CFDIR/tunnel.err.log</string>
</dict>
</plist>
PLISTXML
launchctl bootout "gui/$(id -u)/com.shh.anyvoice-tunnel" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "==> Tunnel agent loaded."

cat <<DONE

Done. Next:
  • Set AUTH_URL=https://$HOSTNAME in .env.local, then restart the worker:
      launchctl kickstart -k gui/\$(id -u)/com.shh.anyvoice-worker
  • Make sure the Google OAuth client lists this callback URL:
      https://$HOSTNAME/api/auth/callback/google
  • Verify:  curl -sI https://$HOSTNAME/  (expect a 307 to /api/auth/signin)
DONE

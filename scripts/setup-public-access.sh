#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
CLOUDFLARED="$BIN_DIR/cloudflared"
UNIT_DIR="$HOME/.config/systemd/user"
URL_FILE="$ROOT/pc/public-url.txt"

mkdir -p "$BIN_DIR" "$UNIT_DIR"

if [[ ! -x "$CLOUDFLARED" ]]; then
  echo "Installing cloudflared to $CLOUDFLARED"
  curl -fsSL -o "$CLOUDFLARED" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  chmod +x "$CLOUDFLARED"
fi

"$CLOUDFLARED" --version

systemctl --user enable --now clawdpebble-bridge.service

sed "s|%h|$HOME|g; s|%r|$ROOT|g" \
  "$ROOT/pc/watch-bridge/clawdpebble-tunnel.service" \
  > "$UNIT_DIR/clawdpebble-tunnel.service"

# Drop the previous quick-tunnel hostname so we do not report a dead URL.
rm -f "$URL_FILE"
systemctl --user daemon-reload
systemctl --user enable clawdpebble-tunnel.service
systemctl --user restart clawdpebble-tunnel.service

echo "Waiting for a fresh public HTTPS URL..."
URL=""
for _ in $(seq 1 45); do
  if [[ -s "$URL_FILE" ]]; then
    URL="$(tr -d '[:space:]' < "$URL_FILE")"
    break
  fi
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo "Timed out waiting for the tunnel URL. Logs:"
  journalctl --user -u clawdpebble-tunnel.service -n 50 --no-pager || true
  exit 1
fi

echo "Public URL: $URL"
echo "Config page: $URL/config"
echo "Health: $URL/health"

host="${URL#https://}"
host="${host%%/*}"
ok=0
for _ in $(seq 1 20); do
  ip="$(dig @1.1.1.1 +short "$host" A | head -1 || true)"
  if [[ -n "$ip" ]] && curl -fsS --max-time 10 --resolve "${host}:443:${ip}" "$URL/health" >/dev/null; then
    ok=1
    break
  fi
  if curl -fsS --max-time 10 --doh-url https://cloudflare-dns.com/dns-query "$URL/health" >/dev/null 2>/dev/null; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "$ok" -eq 1 ]]; then
  echo "Public health check succeeded."
else
  echo "Tunnel wrote a URL but HTTPS health still failed."
  echo "This PC's DNS may not resolve *.trycloudflare.com; phones usually still can."
  echo "Recent tunnel logs:"
  journalctl --user -u clawdpebble-tunnel.service -n 30 --no-pager || true
  exit 1
fi

echo
echo "Rebuild and reinstall the watchapp so it uses this HTTPS URL:"
echo "  export PATH=\"\$HOME/.local/bin:\$HOME/.openclaw/tools/node/bin:\$PATH\""
echo "  cd $ROOT/watch && pebble build && pebble install --phone PHONE_IP"
echo
echo "Quick tunnels mint a new hostname on every tunnel restart."
echo "If commands fail later, re-run this script and reinstall the watchapp."

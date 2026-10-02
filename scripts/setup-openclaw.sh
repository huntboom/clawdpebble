#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_BIN="$OPENCLAW_HOME/bin/openclaw"
ENV_FILE="$ROOT/pc/.env"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"
WORKSPACE="$OPENCLAW_HOME/workspace"

export PATH="$OPENCLAW_HOME/bin:$OPENCLAW_HOME/tools/node/bin:$PATH"

if [[ ! -x "$OPENCLAW_BIN" ]]; then
  echo "OpenClaw CLI not found. Installing to $OPENCLAW_HOME ..."
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --no-onboard
fi

rand_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
}

mkdir -p "$ROOT/pc" "$WORKSPACE"

if [[ ! -f "$ENV_FILE" ]]; then
  GATEWAY_TOKEN="$(rand_token)"
  HOOKS_TOKEN="$(rand_token)"
  BRIDGE_TOKEN="$(rand_token)"
  cat > "$ENV_FILE" <<EOF
WATCH_BRIDGE_BIND=0.0.0.0
WATCH_BRIDGE_PORT=18790
LAN_IP=
LAN_BRIDGE_URL=
WATCH_BRIDGE_TOKEN=$BRIDGE_TOKEN
OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN
OPENCLAW_HOOKS_TOKEN=$HOOKS_TOKEN
PEBBLE_SESSION_KEY=agent:main:pebble-remote
PEBBLE_AGENT_ID=main
PEBBLE_AGENT_TIMEOUT=90
PEBBLE_MAX_REPLY_CHARS=480
PUBLIC_BRIDGE_URL=
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE"
else
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
  GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:?}"
  HOOKS_TOKEN="${OPENCLAW_HOOKS_TOKEN:?}"
  BRIDGE_TOKEN="${WATCH_BRIDGE_TOKEN:?}"
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ ! -f "$CONFIG_FILE" ]]; then
  python3 - <<PY
import json, os
config = {
  "agents": {
    "defaults": {
      "workspace": os.path.expanduser("~/.openclaw/workspace"),
      "model": {"primary": "openai/gpt-5.4-mini", "fallbacks": ["anthropic/claude-sonnet-4-6"]},
    },
    "list": [
      {
        "id": "main",
        "default": True,
        "identity": {
          "name": "Clawd",
          "theme": "helpful assistant reachable from a Pebble watch",
          "emoji": "🦞",
        },
      }
    ],
  },
  "hooks": {
    "enabled": True,
    "token": os.environ["OPENCLAW_HOOKS_TOKEN"],
    "path": "/hooks",
    "allowRequestSessionKey": True,
    "allowedSessionKeyPrefixes": ["hook:", "agent:"],
    "defaultSessionKey": "hook:pebble",
  },
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "controlUi": {"enabled": True},
    "auth": {
      "mode": "token",
      "token": os.environ["OPENCLAW_GATEWAY_TOKEN"],
    },
  },
}
path = os.path.expanduser("~/.openclaw/openclaw.json")
with open(path, "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent=2)
    fh.write("\n")
os.chmod(path, 0o600)
print(f"Wrote {path}")
PY
else
  echo "Keeping existing $CONFIG_FILE"
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  printf '%s' "$ANTHROPIC_API_KEY" | "$OPENCLAW_BIN" models auth paste-api-key --provider anthropic --profile-id anthropic:default >/dev/null || true
  "$OPENCLAW_BIN" models set anthropic/claude-sonnet-4-6 >/dev/null || true
  echo "Configured Anthropic model auth from the environment."
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
  printf '%s' "$OPENAI_API_KEY" | "$OPENCLAW_BIN" models auth paste-api-key --provider openai --profile-id openai:default >/dev/null || true
  "$OPENCLAW_BIN" models set openai/gpt-4.1 >/dev/null || true
  echo "Configured OpenAI model auth from the environment."
else
  echo "No ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment."
  echo "Run: openclaw onboard   (or paste a provider key) before the watch can get agent replies."
fi

"$OPENCLAW_BIN" config validate || true

echo "Installing OpenClaw gateway user service..."
"$OPENCLAW_BIN" gateway install || true
"$OPENCLAW_BIN" gateway start || "$OPENCLAW_BIN" gateway run --port 18789 --bind loopback --token "$GATEWAY_TOKEN" --allow-unconfigured &
sleep 2
"$OPENCLAW_BIN" gateway status || true
"$OPENCLAW_BIN" health --json || true

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|%h|$HOME|g" "$ROOT/pc/watch-bridge/clawdpebble-bridge.service" > "$UNIT_DIR/clawdpebble-bridge.service"
systemctl --user daemon-reload
systemctl --user enable --now clawdpebble-bridge.service || true

DETECTED_LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1 || true)"
# Prefer values already in pc/.env; otherwise detect and persist locally (never commit).
if [[ -z "${LAN_IP:-}" ]]; then
  LAN_IP="${DETECTED_LAN_IP:-127.0.0.1}"
fi
if [[ -z "${LAN_BRIDGE_URL:-}" ]]; then
  LAN_BRIDGE_URL="http://${LAN_IP}:${WATCH_BRIDGE_PORT}"
fi
if grep -q '^LAN_IP=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^LAN_IP=.*|LAN_IP=${LAN_IP}|" "$ENV_FILE"
else
  printf '\nLAN_IP=%s\n' "$LAN_IP" >> "$ENV_FILE"
fi
if grep -q '^LAN_BRIDGE_URL=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^LAN_BRIDGE_URL=.*|LAN_BRIDGE_URL=${LAN_BRIDGE_URL}|" "$ENV_FILE"
else
  printf 'LAN_BRIDGE_URL=%s\n' "$LAN_BRIDGE_URL" >> "$ENV_FILE"
fi

export LAN_IP LAN_BRIDGE_URL WATCH_CONFIG="$ROOT/watch/src/embeddedjs/config.js" WATCH_BRIDGE_TOKEN WATCH_BRIDGE_PORT
WATCH_EXAMPLE="$ROOT/watch/src/embeddedjs/config.example.js"
if [[ -f "$WATCH_EXAMPLE" ]]; then
  python3 - <<PY
from pathlib import Path
import os
host = os.environ.get("LAN_BRIDGE_URL") or f"http://{os.environ.get('LAN_IP') or '127.0.0.1'}:{os.environ.get('WATCH_BRIDGE_PORT','18790')}"
token = os.environ["WATCH_BRIDGE_TOKEN"]
Path(os.environ["WATCH_CONFIG"]).write_text(
    "export const defaults = {\n"
    f"\thost: {host!r},\n"
    f"\ttoken: {token!r},\n"
    "};\n"
)
print(f"Wrote {os.environ['WATCH_CONFIG']} (gitignored)")
PY
fi
echo
echo "Setup complete."
echo "  Gateway:  ws://127.0.0.1:18789  (loopback, token auth)"
echo "  Bridge:   ${LAN_BRIDGE_URL}"
echo "  Token:    see $ENV_FILE (WATCH_BRIDGE_TOKEN)"
echo "  Config:   ${LAN_BRIDGE_URL}/config"
echo
echo "Finish model onboarding if needed:  openclaw onboard"
echo "Dashboard:                           openclaw dashboard"

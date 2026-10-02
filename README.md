# ClawdPebble

Remote an [OpenClaw](https://github.com/openclaw) agent from a **Pebble Time 2** (or Round 2) using the **Claw Remote** Alloy watchapp.

The watch never talks to OpenClaw’s WebSocket control plane. It sends short AppMessages to the phone; PebbleKit JS calls a token-gated HTTP bridge on your PC. At home that is LAN. Away from home it is a Cloudflare HTTPS tunnel to the same bridge.

```
Pebble Time 2 (Alloy / Claw Remote)
        AppMessage
Phone (PebbleKit JS + XHR)
        HTTPS + token
Cloudflare Tunnel (or LAN :18790)
PC watch-bridge
        openclaw CLI → Gateway :18789 (loopback)
OpenClaw agent
```

## What you get

1. OpenClaw under `~/.openclaw` (user-space Node; no system Node upgrade required).
2. Gateway on `127.0.0.1:18789` with token auth.
3. Local HTTP bridge on port **18790**.
4. Optional **public HTTPS tunnel** so the phone works on cellular / other Wi‑Fi.
5. **Claw Remote** Alloy watchapp for `emery` (Time 2) and `gabbro` (Round 2).

Local secrets (`pc/.env`, bridge URL files, baked watch config) are gitignored.

### Watch controls

| Button | Action |
| --- | --- |
| Up / Down | Move the menu |
| Select | Run the highlighted action |
| Long Select | Dictate a command |
| Long Down | Abort the current agent run |
| Hold Back | Exit the app |

Menu: **Speak**, **Status**, **Ping agent**, **What's next?**, **Stop**.

## One-time setup on the PC

```bash
export PATH="$HOME/.openclaw/bin:$HOME/.local/bin:$PATH"
./scripts/setup-openclaw.sh
```

That script:

- writes `pc/.env` with fresh tokens (not committed)
- writes `~/.openclaw/openclaw.json` if missing
- stores a provider API key if `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set
- starts the Gateway user service and `clawdpebble-bridge.service`

If you skipped a model key:

```bash
openclaw onboard
```

Confirm:

```bash
openclaw gateway status
openclaw health
```

## Build and install the watchapp

Needs Pebble SDK **4.33+** (Alloy) and `pebble-tool` 5.x.

```bash
export PATH="$HOME/.local/bin:$HOME/.openclaw/tools/node/bin:$PATH"
pebble sdk activate 4.33
cd watch
pebble package install
pebble build
pebble install --emulator emery
```

On a physical Time 2, enable Dev Connect in the Pebble phone app, then:

```bash
pebble install --phone PHONE_IP
```

Or `pebble install --cloudpebble` after `pebble login`.

### Point the watch at this PC (same Wi‑Fi)

1. Copy `watch/src/embeddedjs/config.example.js` → `config.js` and set your LAN bridge URL from `pc/.env` (`LAN_BRIDGE_URL`) plus `WATCH_BRIDGE_TOKEN`.
2. Or open **Claw Remote** settings in the Pebble phone app and save host + token there (settings live in phone `localStorage`).

Machine-specific values (`LAN_IP`, tokens, live tunnel hostname) belong in **`pc/.env`** only — that file is gitignored.

### Control it from anywhere (cellular / other Wi‑Fi)

GitHub Pages cannot run the agent API. Use a Cloudflare Tunnel in front of the local bridge. The PC must stay on and online.

```bash
./scripts/setup-public-access.sh
```

That installs `cloudflared`, starts `clawdpebble-tunnel.service`, and writes the public URL to `pc/public-url.txt`. Rebuild/install the watchapp (or save the new HTTPS URL in phone settings).

Quick tunnels mint a **new hostname whenever the tunnel restarts**. After a restart:

1. Read `pc/public-url.txt`
2. Open Claw Remote settings on the phone and save the new HTTPS URL + the same `WATCH_BRIDGE_TOKEN`

Optional static settings page (does not proxy commands): `docs/config.html`.

## Bridge API

All routes except `/health` and `/config` require the bridge token (`Authorization: Bearer …`, `x-clawdpebble-token`, or `?token=`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process liveness |
| GET | `/config` | Phone settings page |
| GET | `/v1/status` | Gateway probe + last reply |
| POST | `/v1/command` | `{ "text": "..." }` or raw text — run an agent turn |
| POST | `/v1/abort` | Abort the pebble session |

Session key defaults to `agent:main:pebble-remote`.

## Layout

```
scripts/setup-openclaw.sh          PC bootstrap
scripts/setup-public-access.sh     Public HTTPS tunnel
scripts/public-tunnel.py           Cloudflare Tunnel wrapper
pc/watch-bridge/server.js          Local HTTP bridge
pc/.env                            Tokens (local only)
docs/config.html                   Optional static settings page
watch/                             Alloy watchapp (embedded JS + PKJS)
```

## Security

- Do not port-forward 18789 or 18790 yourself. The tunnel publishes HTTPS to the token-gated bridge only.
- Keep the Gateway on loopback.
- Treat hook/bridge tokens as secrets (`pc/.env`, `~/.openclaw/openclaw.json`).
- Anyone with the public URL still needs `WATCH_BRIDGE_TOKEN` to send commands.

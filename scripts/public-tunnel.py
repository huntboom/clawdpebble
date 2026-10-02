#!/usr/bin/env python3
"""Expose the local watch-bridge on a public HTTPS URL via Cloudflare Tunnel."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "pc" / ".env"
URL_FILE = ROOT / "pc" / "public-url.txt"
WATCH_CONFIG = ROOT / "watch" / "src" / "embeddedjs" / "config.js"
PKJS_REMOTE = ROOT / "watch" / "src" / "pkjs" / "remote-url.js"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if not line.strip() or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'").strip('"')
    return values


def upsert_env(key: str, value: str) -> None:
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    found = False
    out = []
    for line in lines:
        if line.startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(out) + "\n")
    os.chmod(ENV_FILE, 0o600)


def write_public_url(url: str) -> None:
    url = url.rstrip("/")
    URL_FILE.write_text(url + "\n")
    upsert_env("PUBLIC_BRIDGE_URL", url)
    env = load_env()
    token = env.get("WATCH_BRIDGE_TOKEN", "")
    WATCH_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    WATCH_CONFIG.write_text(
        "export const defaults = {\n"
        f"\thost: {url!r},\n"
        f"\ttoken: {token!r},\n"
        "};\n"
    )
    PKJS_REMOTE.write_text(
        "module.exports = {\n"
        f"  host: {url!r},\n"
        f"  configUrl: {url + '/config'!r}\n"
        "};\n"
    )
    print(f"Public bridge URL: {url}", flush=True)


def find_cloudflared() -> str:
    candidates = [
        os.environ.get("CLOUDFLARED_BIN", ""),
        str(Path.home() / ".local/bin/cloudflared"),
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ]
    for path in candidates:
        if path and Path(path).is_file() and os.access(path, os.X_OK):
            return path
    raise SystemExit("cloudflared not found. Run scripts/setup-public-access.sh")


def main() -> int:
    port = load_env().get("WATCH_BRIDGE_PORT", "18790")
    target = f"http://127.0.0.1:{port}"
    binary = find_cloudflared()
    cmd = [
        binary,
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--edge-ip-version",
        "4",
        "--url",
        target,
    ]
    print(f"Starting Cloudflare Tunnel to {target}", flush=True)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    published = False
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            match = URL_RE.search(line)
            if match and not published:
                write_public_url(match.group(0))
                published = True
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

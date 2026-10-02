#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT, "pc", ".env");

loadEnvFile(ENV_PATH);

const HOST = process.env.WATCH_BRIDGE_BIND || "0.0.0.0";
const PORT = Number(process.env.WATCH_BRIDGE_PORT || 18790);
const BRIDGE_TOKEN = process.env.WATCH_BRIDGE_TOKEN || "";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || path.join(process.env.HOME || "", ".openclaw/bin/openclaw");
const SESSION_KEY = process.env.PEBBLE_SESSION_KEY || "agent:main:pebble-remote";
const AGENT_ID = process.env.PEBBLE_AGENT_ID || "main";
const AGENT_TIMEOUT_SEC = Number(process.env.PEBBLE_AGENT_TIMEOUT || 90);
const MAX_REPLY_CHARS = Number(process.env.PEBBLE_MAX_REPLY_CHARS || 480);
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

if (!BRIDGE_TOKEN) {
  console.error("WATCH_BRIDGE_TOKEN is not set. Run scripts/setup-openclaw.sh first.");
  process.exit(1);
}

let lastReply = "";
let lastError = "";
let busy = false;
let lastCommandAt = 0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Clawdpebble-Token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      return send(res, 204, "", CORS);
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return send(res, 200, configPage(url.searchParams.get("host")), Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "clawdpebble-bridge" });
    }

    if (!authorize(req, url)) {
      return sendJson(res, 401, { ok: false, error: "unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      const health = await probeHealth();
      return sendJson(res, 200, {
        ok: health.ok,
        busy,
        gateway: health.ok ? "up" : "down",
        detail: health.detail,
        lastReply: clip(lastReply),
        lastError: clip(lastError, 160),
        lastCommandAt,
        sessionKey: SESSION_KEY,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/command") {
      const body = await readBody(req);
      const text = String(body.text || body.message || "").trim();
      if (!text) return sendJson(res, 400, { ok: false, error: "missing text" });
      if (busy) return sendJson(res, 409, { ok: false, error: "busy" });

      busy = true;
      lastError = "";
      lastCommandAt = Date.now();
      try {
        const result = await runOpenClaw([
          "agent",
          "--agent", AGENT_ID,
          "--session-key", SESSION_KEY,
          "--message", text,
          "--timeout", String(AGENT_TIMEOUT_SEC),
          "--json",
        ], (AGENT_TIMEOUT_SEC + 15) * 1000);
        const reply = extractReply(result);
        lastReply = reply;
        return sendJson(res, 200, {
          ok: true,
          reply: clip(reply),
          truncated: reply.length > MAX_REPLY_CHARS,
        });
      } catch (err) {
        lastError = err.message || String(err);
        return sendJson(res, 502, { ok: false, error: clip(lastError, 200) });
      } finally {
        busy = false;
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/abort") {
      try {
        const result = await runOpenClaw([
          "gateway", "call", "sessions.abort",
          "--json",
          "--params", JSON.stringify({ key: SESSION_KEY, clearQueued: true }),
          ...(GATEWAY_TOKEN ? ["--token", GATEWAY_TOKEN] : []),
        ], 15000);
        lastError = "";
        return sendJson(res, 200, { ok: true, result: clip(result.stdout || "aborted", 240) });
      } catch (err) {
        lastError = err.message || String(err);
        return sendJson(res, 502, { ok: false, error: clip(lastError, 200) });
      }
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: clip(err.message || String(err), 200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ClawdPebble bridge listening on http://${HOST}:${PORT}`);
  console.log(`OpenClaw binary: ${OPENCLAW_BIN}`);
});

function authorize(req, url) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const alt = req.headers["x-clawdpebble-token"] || "";
  const query = url && url.searchParams ? (url.searchParams.get("token") || "") : "";
  const token = bearer || alt || query;
  return token && token === BRIDGE_TOKEN;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, CORS, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        resolve({ text: raw });
      }
    });
    req.on("error", reject);
  });
}

function clip(text, max) {
  const limit = max || MAX_REPLY_CHARS;
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + "…";
}

function extractReply(result) {
  const raw = (result.stdout || "").trim();
  if (!raw) return result.stderr || "No reply";
  try {
    const parsed = JSON.parse(raw);
    const payloads =
      (parsed.result && parsed.result.payloads) ||
      parsed.payloads ||
      [];
    if (Array.isArray(payloads) && payloads.length) {
      const texts = payloads
        .map((p) => (typeof p === "string" ? p : p && p.text))
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    return (
      parsed.reply ||
      parsed.text ||
      parsed.output ||
      parsed.message ||
      (parsed.result && (parsed.result.reply || parsed.result.text)) ||
      raw
    );
  } catch (_err) {
    return raw;
  }
}

function probeHealth() {
  return runOpenClaw(["health", "--json"], 8000)
    .then((result) => {
      try {
        const parsed = JSON.parse(result.stdout || "{}");
        const ok = parsed.ok !== false && parsed.status !== "error";
        return { ok, detail: parsed.status || parsed.ok ? "ok" : "unknown" };
      } catch (_err) {
        const ok = (result.stdout || "").toLowerCase().includes("ok") || result.code === 0;
        return { ok, detail: clip(result.stdout || "health", 80) };
      }
    })
    .catch((err) => ({ ok: false, detail: clip(err.message, 80) }));
}

function runOpenClaw(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_BIN, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("openclaw timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ code, stdout, stderr });
      reject(new Error((stderr || stdout || `openclaw exited ${code}`).trim()));
    });
  });
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function localBridgeUrl() {
  const fromEnv = (process.env.LAN_BRIDGE_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const lanIp = (process.env.LAN_IP || "").trim();
  if (lanIp) return `http://${lanIp}:${PORT}`;
  return "";
}

function publicBridgeUrl() {
  const filePath = path.join(ROOT, "pc", "public-url.txt");
  if (fs.existsSync(filePath)) {
    const fromFile = fs.readFileSync(filePath, "utf8").trim().replace(/\/$/, "");
    if (fromFile) return fromFile;
  }
  const fromEnv = (process.env.PUBLIC_BRIDGE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "";
}

function configPage(requestedHost) {
  const publicHost = requestedHost || publicBridgeUrl();
  const hostValue =
    publicHost ||
    (process.env.LAN_BRIDGE_URL || "").trim().replace(/\/$/, "") ||
    localBridgeUrl() ||
    "http://127.0.0.1:18790";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claw Remote</title>
  <style>
    body { font-family: sans-serif; margin: 24px; background: #111; color: #eee; }
    label { display: block; margin: 12px 0 4px; }
    input { width: 100%; padding: 8px; font-size: 16px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 16px; font-size: 16px; }
    .hint { color: #aaa; font-size: 14px; }
  </style>
</head>
<body>
  <h1>Claw Remote</h1>
  <p>Point the Pebble app at the public HTTPS bridge. This works from cellular or any Wi-Fi.</p>
  <p class="hint">Leave the token as the value from pc/.env on the PC.</p>
  <form id="f">
    <label>Bridge URL</label>
    <input id="host" value="${escapeHtml(hostValue)}">
    <label>Bridge token</label>
    <input id="token" placeholder="WATCH_BRIDGE_TOKEN">
    <button type="submit">Save to watch</button>
  </form>
  <script>
    document.getElementById("f").onsubmit = function (e) {
      e.preventDefault();
      var cfg = {
        host: document.getElementById("host").value.trim().replace(/\\/$/, ""),
        token: document.getElementById("token").value.trim()
      };
      location.href = "pebblejs://close#" + encodeURIComponent(JSON.stringify(cfg));
    };
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

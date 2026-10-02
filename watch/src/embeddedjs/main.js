import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Dictation from "pebble/dictation";
import Message from "pebble/message";
import { defaults } from "./config";

const render = new Poco(screen);
const titleFont = new render.Font("Gothic-Bold", 18);
const bodyFont = new render.Font("Gothic-Regular", 14);
const smallFont = new render.Font("Gothic-Regular", 14);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const orange = render.makeColor(255, 85, 0);
const gray = render.makeColor(40, 40, 40);
const dim = render.makeColor(180, 180, 180);
const green = render.makeColor(40, 180, 90);
const red = render.makeColor(200, 60, 50);

const ACTIONS = [
	{ id: "speak", label: "Speak" },
	{ id: "status", label: "Status" },
	{ id: "ping", label: "Ping agent" },
	{ id: "next", label: "What's next?" },
	{ id: "abort", label: "Stop" },
];

const settings = {
	host: defaults.host,
	token: defaults.token,
};

loadSettings();

let selected = 0;
let statusLine = "waiting for phone";
let bodyText = "Up/Down move. Select runs. Long Select dictates.";
let scroll = 0;
let busy = false;
let connected = false;
let pending = null;
let pressedAt = {};
let canWrite = false;
let writeQueue = [];

const dictation = new Dictation({
	byteLength: 512,
	onReadable() {
		const text = this.read();
		statusLine = text ? "heard" : "empty speech";
		bodyText = text || "No words captured.";
		draw();
		if (text) {
			setImmediate(function () {
				sendCommand(text);
			});
		}
	},
	onError(e) {
		statusLine = "dictation error " + e;
		draw();
	},
});
dictation.configure({ confirm: false, errorDialogs: true });

new Button({
	types: ["select", "up", "down"],
	onPush(down, type) {
		if (down) {
			pressedAt[type] = Date.now();
			return;
		}
		const held = Date.now() - (pressedAt[type] || 0);
		if (type === "up") {
			selected = (selected + ACTIONS.length - 1) % ACTIONS.length;
			draw();
			return;
		}
		if (type === "down") {
			if (held > 700)
				return runAction("abort");
			selected = (selected + 1) % ACTIONS.length;
			draw();
			return;
		}
		if (type === "select") {
			if (held > 700)
				return startSpeak();
			runAction(ACTIONS[selected].id);
		}
	},
});

const phone = new Message({
	keys: ["CONFIG_HOST", "CONFIG_TOKEN", "METHOD", "PATH", "BODY", "HOST", "TOKEN", "OK", "TEXT", "ERROR"],
	onReadable() {
		const msg = this.read();
		let host, token, text;
		msg.forEach((value, key) => {
			const name = String(key);
			if ((name === "CONFIG_HOST" || name === "10000") && value)
				host = String(value).replace(/\/$/, "");
			if ((name === "CONFIG_TOKEN" || name === "10001") && value)
				token = String(value);
			if ((name === "TEXT" || name === "10008") && value)
				text = value;
			if ((name === "ERROR" || name === "10009") && value && !text)
				text = JSON.stringify({ error: String(value) });
		});
		if (host) {
			settings.host = host;
			if (token)
				settings.token = token;
			saveSettings();
			statusLine = "config saved";
			draw();
		}
		if (!pending || text === undefined)
			return;
		let parsed = null;
		try {
			parsed = JSON.parse(String(text));
		} catch (_err) {
			parsed = null;
		}
		if (parsed && (parsed.progress === "start" || parsed.progress === "pkjs")) {
			statusLine = parsed.progress === "pkjs" ? "pkjs ready" : "phone got it";
			draw();
			return;
		}
		finishPending(1, String(text), "");
	},
	onWritable() {
		canWrite = true;
		flushWrite();
	},
	onSuspend() {
		canWrite = false;
	},
});

watch.addEventListener("connected", () => {
	connected = !!(watch.connected && watch.connected.pebblekit);
	statusLine = connected ? "phone ready" : "phone offline";
	draw();
});
connected = !!(watch.connected && watch.connected.pebblekit);
statusLine = connected ? "phone ready" : "waiting for phone";
draw();

function runAction(id) {
	if (id === "speak")
		return startSpeak();
	if (id === "status")
		return probeStatus();
	if (id === "abort")
		return abortAgent();
	if (id === "ping")
		return sendCommand("Reply in one short sentence: you are reachable from my Pebble Time 2. Confirm you are awake.");
	if (id === "next")
		return sendCommand("In 3 short lines, what are you doing and what needs me next?");
}

function startSpeak() {
	statusLine = "listening...";
	draw();
	dictation.start();
}

function probeStatus() {
	request("GET", "/v1/status", null, 16000, "checking...", function (data) {
		if (data.gateway === "up")
			statusLine = "gateway up";
		else if (data.error)
			statusLine = String(data.error).slice(0, 18);
		else
			statusLine = "gateway down";
		if (data.busy)
			statusLine = "agent busy";
		bodyText = data.lastReply || data.lastError || data.detail || data.error || "Connected.";
	});
}

function sendCommand(text) {
	bodyText = text;
	scroll = 0;
	request("POST", "/v1/command", { text }, 95000, "sending...", function (data) {
		statusLine = data.ok ? "reply" : "send failed";
		bodyText = data.reply || data.error || "No reply";
		scroll = 0;
	}, true);
}

function abortAgent() {
	request("POST", "/v1/abort", {}, 16000, "stopping...", function (data) {
		statusLine = data.ok ? "stopped" : "stop failed";
		bodyText = data.result || data.error || "Abort sent.";
	});
}

function request(method, path, body, timeoutMs, waiting, onDone, force) {
	if (busy && !force) {
		statusLine = "still working...";
		draw();
		return;
	}
	if (busy && force && pending) {
		if (pending.timer)
			clearTimeout(pending.timer);
		pending = null;
		busy = false;
	}
	if (!(watch.connected && watch.connected.pebblekit)) {
		statusLine = "phone offline";
		bodyText = "Open the Pebble phone app and try again.";
		draw();
		return;
	}
	if (!settings.token) {
		statusLine = "need token";
		bodyText = "Open Claw Remote settings on the phone and save the bridge URL plus token.";
		draw();
		return;
	}

	busy = true;
	statusLine = waiting;
	draw();

	const payload = new Map();
	payload.set("METHOD", method);
	payload.set("PATH", path);
	payload.set("HOST", settings.host.replace(/\/$/, ""));
	payload.set("TOKEN", settings.token);
	payload.set("BODY", body ? JSON.stringify(body) : " ");

	pending = {
		onDone,
		timer: setTimeout(function () {
			finishPending(0, "", "timeout");
		}, timeoutMs),
	};

	writeQueue.push(payload);
	flushWrite();
}

function flushWrite() {
	if (!canWrite || !writeQueue.length)
		return;
	const payload = writeQueue.shift();
	try {
		canWrite = false;
		phone.write(payload);
	} catch (err) {
		writeQueue.unshift(payload);
		statusLine = "retrying phone";
		bodyText = String(err);
		draw();
	}
}

function finishPending(ok, text, error) {
	if (!pending)
		return;
	const onDone = pending.onDone;
	if (pending.timer)
		clearTimeout(pending.timer);
	pending = null;
	busy = false;

	let data = {};
	const raw = text ? String(text) : "";
	if (raw) {
		try {
			data = JSON.parse(raw);
		} catch (_err) {
			data = { error: raw };
		}
	}
	if (!ok && !data.error)
		data.error = error ? String(error) : "request failed";
	try {
		onDone(data);
	} catch (err) {
		statusLine = "error";
		bodyText = String(err);
	}
	draw();
}

function loadSettings() {
	try {
		const raw = localStorage.getItem("clawdpebble");
		if (!raw)
			return;
		const parsed = JSON.parse(raw);
		if (parsed.host)
			settings.host = parsed.host;
		if (parsed.token)
			settings.token = parsed.token;
	} catch (_err) {
	}
}

function saveSettings() {
	localStorage.setItem("clawdpebble", JSON.stringify(settings));
}

function wrap(text, font, width) {
	const lines = [];
	const paragraphs = String(text || "").split("\n");
	for (let p = 0; p < paragraphs.length; p++) {
		const words = paragraphs[p].split(" ");
		let line = "";
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const next = line ? line + " " + word : word;
			if (render.getTextWidth(next, font) > width && line) {
				lines.push(line);
				if (render.getTextWidth(word, font) > width)
					pushChunks(lines, word, font, width);
				else
					line = word;
			} else if (render.getTextWidth(next, font) > width) {
				pushChunks(lines, word, font, width);
				line = "";
			} else {
				line = next;
			}
		}
		if (line)
			lines.push(line);
	}
	return lines.length ? lines : [""];
}

function pushChunks(lines, word, font, width) {
	let rest = word;
	while (rest.length) {
		let n = rest.length;
		while (n > 1 && render.getTextWidth(rest.slice(0, n), font) > width)
			n--;
		lines.push(rest.slice(0, n));
		rest = rest.slice(n);
	}
}

function draw() {
	const w = render.width;
	const h = render.height;
	render.begin();
	render.fillRectangle(black, 0, 0, w, h);
	render.fillRectangle(orange, 0, 0, w, 26);
	render.drawText("CLAW REMOTE", titleFont, white, 6, 4);

	const readyColor = connected ? green : red;
	render.fillRectangle(readyColor, w - 14, 8, 8, 8);

	render.fillRectangle(gray, 0, 26, w, 20);
	render.drawText(trimToWidth(statusLine, smallFont, w - 12), smallFont, dim, 6, 28);

	let y = 50;
	for (let i = 0; i < ACTIONS.length; i++) {
		const label = (i === selected ? "> " : "  ") + ACTIONS[i].label;
		const color = i === selected ? orange : white;
		render.drawText(label, bodyFont, color, 6, y);
		y += 16;
	}

	render.fillRectangle(gray, 0, y + 4, w, 1);
	const textTop = y + 8;
	const lines = wrap(bodyText, smallFont, w - 12);
	const lineH = 16;
	const visible = Math.max(1, Math.floor((h - textTop - 4) / lineH));
	if (scroll > Math.max(0, lines.length - visible))
		scroll = Math.max(0, lines.length - visible);
	for (let i = 0; i < visible && textTop + i * lineH < h; i++) {
		const line = lines[i + scroll];
		if (line === undefined)
			break;
		render.drawText(line, smallFont, white, 6, textTop + i * lineH);
	}
	render.end();
}

function trimToWidth(text, font, width) {
	let value = String(text || "");
	while (value.length > 1 && render.getTextWidth(value, font) > width)
		value = value.slice(0, -1);
	return value;
}

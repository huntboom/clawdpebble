let remote = {
	host: "",
	configUrl: "",
};
try {
	remote = Object.assign(remote, require("./remote-url"));
} catch (_err) {
	try {
		remote = Object.assign(remote, require("./remote-url.example"));
	} catch (_err2) {
	}
}

function pick(payload, name, id) {
	if (!payload)
		return "";
	if (payload[name] !== undefined && payload[name] !== null)
		return payload[name];
	if (payload[id] !== undefined && payload[id] !== null)
		return payload[id];
	if (payload[String(id)] !== undefined)
		return payload[String(id)];
	return "";
}

let savedHost = remote.host || "";
let savedToken = "";
try {
	if (typeof localStorage !== "undefined") {
		savedHost = localStorage.getItem("clawHost") || savedHost;
		savedToken = localStorage.getItem("clawToken") || savedToken;
	}
} catch (_err) {
}

Pebble.addEventListener("ready", function () {
	console.log("Claw Remote PKJS ready " + savedHost);
	sendText({ progress: "pkjs" });
});

Pebble.addEventListener("showConfiguration", function () {
	Pebble.openURL("data:text/html," + encodeURIComponent(configHtml()));
});

Pebble.addEventListener("webviewclosed", function (e) {
	if (!e || !e.response)
		return;
	let cfg = null;
	const raw = e.response;
	try {
		cfg = JSON.parse(decodeURIComponent(raw));
	} catch (_err) {
		try {
			cfg = JSON.parse(raw);
		} catch (_err2) {
			console.log("config parse failed");
			return;
		}
	}
	if (cfg.host)
		savedHost = String(cfg.host).replace(/\/$/, "");
	if (cfg.token)
		savedToken = String(cfg.token);
	persist();
	Pebble.sendAppMessage({
		CONFIG_HOST: savedHost,
		CONFIG_TOKEN: savedToken,
	});
});

Pebble.addEventListener("appmessage", function (e) {
	const p = e.payload || {};
	const token = pick(p, "TOKEN", 10006) || pick(p, "CONFIG_TOKEN", 10001);
	const host = pick(p, "HOST", 10005) || pick(p, "CONFIG_HOST", 10000);
	const method = pick(p, "METHOD", 10002);
	if (token)
		savedToken = String(token);
	if (host)
		savedHost = String(host).replace(/\/$/, "");
	if (token || host)
		persist();
	if (method)
		runRequest(p);
});

function persist() {
	try {
		if (typeof localStorage !== "undefined") {
			if (savedHost)
				localStorage.setItem("clawHost", savedHost);
			if (savedToken)
				localStorage.setItem("clawToken", savedToken);
		}
	} catch (_err) {
	}
}

function configHtml() {
	const host = savedHost || remote.host || "";
	const token = savedToken || "";
	return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		"<title>Claw Remote</title>" +
		"<style>body{font-family:sans-serif;margin:24px;background:#111;color:#eee}" +
		"input{width:100%;padding:8px;font-size:16px;box-sizing:border-box}" +
		"label{display:block;margin:12px 0 4px}" +
		"button{margin-top:16px;padding:10px 16px;font-size:16px}</style></head><body>" +
		"<h1>Claw Remote</h1>" +
		"<form id=\"f\">" +
		"<label>Bridge URL</label>" +
		'<input id="host" value="' + escapeHtml(host) + '">' +
		"<label>Bridge token</label>" +
		'<input id="token" value="' + escapeHtml(token) + '">' +
		"<button type=\"submit\">Save to watch</button></form>" +
		"<script>document.getElementById(\"f\").onsubmit=function(e){e.preventDefault();" +
		"var cfg={host:document.getElementById(\"host\").value.trim().replace(/\\/$/,\"\")," +
		"token:document.getElementById(\"token\").value.trim()};" +
		"location.href=\"pebblejs://close#\"+encodeURIComponent(JSON.stringify(cfg));};</script>" +
		"</body></html>";
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/\"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

const outbox = [];
let sending = false;

function sendText(obj, then) {
	outbox.push({ text: JSON.stringify(obj).slice(0, 450), then: then });
	kick();
}

function kick() {
	if (sending || !outbox.length)
		return;
	sending = true;
	const item = outbox[0];
	Pebble.sendAppMessage({ TEXT: item.text }, function () {
		outbox.shift();
		sending = false;
		if (item.then)
			item.then();
		kick();
	}, function () {
		sending = false;
		setTimeout(kick, 300);
	});
}

function runRequest(payload) {
	const host = String(pick(payload, "HOST", 10005) || savedHost || "").replace(/\/$/, "");
	const path = pick(payload, "PATH", 10003) || "/v1/status";
	const method = pick(payload, "METHOD", 10002) || "GET";
	const token = pick(payload, "TOKEN", 10006) || savedToken || "";
	const body = pick(payload, "BODY", 10004);
	if (!host) {
		sendText({ error: "missing bridge url" });
		return;
	}
	if (!token) {
		sendText({ error: "missing token" });
		return;
	}

	sendText({ progress: "start" }, function () {
		startXhr();
	});

	function startXhr() {
		const xhr = new XMLHttpRequest();
		const command = method === "POST" && String(path).indexOf("/v1/command") === 0;
		const limit = command ? 90000 : 12000;
		let done = false;

		function finish(obj) {
			if (done)
				return;
			done = true;
			try {
				xhr.abort();
			} catch (_err) {
			}
			sendText(obj);
		}

		const timer = setTimeout(function () {
			finish({ error: "phone http timeout" });
		}, limit);

		xhr.onreadystatechange = function () {
			if (xhr.readyState !== 4)
				return;
			clearTimeout(timer);
			if (done)
				return;
			done = true;
			if (xhr.status === 0) {
				sendText({ error: "network error" });
				return;
			}
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					sendText(JSON.parse(xhr.responseText));
				} catch (_err) {
					sendText({ error: xhr.responseText || ("HTTP " + xhr.status) });
				}
				return;
			}
			sendText({ error: "HTTP " + xhr.status });
		};
		xhr.onerror = function () {
			clearTimeout(timer);
			finish({ error: "network error" });
		};

		try {
			const sep = String(path).indexOf("?") >= 0 ? "&" : "?";
			xhr.open(method, host + path + sep + "token=" + encodeURIComponent(token), true);
			if (body && String(body).trim()) {
				xhr.setRequestHeader("Content-Type", "text/plain");
				xhr.send(body);
			} else {
				xhr.send();
			}
		} catch (err) {
			clearTimeout(timer);
			finish({ error: String(err) });
		}
	}
}

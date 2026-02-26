"use strict";

// Stream Control Panel Backend (Container-basierter Push, mit /api/current)
// - /api/status  : nginx-rtmp /stat (Publisher + Bytes)
// - /api/who     : Status + Logs des Containers "twitch-push" (auch wenn Exited)
// - /api/logtail : Text-Logauszug (tail) von twitch-push für das Panel
// - /api/stop    : GRACEFUL Stop (wie OBS): SIGINT an ffmpeg -> warten -> stop -> rm
// - /api/switch  : FAST Switch (kein Offline auf Twitch): rm -f -> docker run
// - /api/current : ermittelt aktuelles Push-Target (brb|dennis|auria|mobil|idle|unknown) + masked cmd
// - /api/diag    : Docker/Network-Diagnose

const express = require("express");
const path = require("path");
const { exec } = require("child_process");

const PORT = Number(process.env.PORT || 4000);
const NGINX_STAT_URL = process.env.NGINX_STAT_URL || "http://nginx-rtmp:18080/stat";

// Keys/URL aus ENV (Panel-Container liest .env via compose)
const TWITCH_RTMP_URL = process.env.TWITCH_RTMP_URL || "";
const DENNIS = process.env.DENNIS || "";
const AURIA = process.env.AURIA || "";
const MOBIL = process.env.MOBIL || "";

// Optional: Transcode an/aus (0=copy, 1=libx264 ultrafast)
const TWITCH_TRANSCODE = String(process.env.TWITCH_TRANSCODE || "0").trim() !== "0";

// Optionales Basic-Auth
const PANEL_USER = process.env.PANEL_USER || "";
const PANEL_PASS = process.env.PANEL_PASS || "";

const app = express();
app.use(express.json());

if (PANEL_USER && PANEL_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Basic ") ? hdr.slice(6) : "";
    const decoded = Buffer.from(token, "base64").toString();
    if (decoded === `${PANEL_USER}:${PANEL_PASS}`) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="stream-panel"');
    return res.status(401).send("Auth required");
  });
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "panel-server" }));

// ---------- Helpers ----------
function sh(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").toString().trim();
        return reject(new Error(msg || "command failed"));
      }
      resolve((stdout || "").toString().trim());
    });
  });
}

// Variante, die NIE wirft (für "best effort" Log-Reads)
async function shNoFail(cmd) {
  try {
    return await sh(cmd);
  } catch (_e) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const toNum = (x) => (Number.isFinite(+x) ? +x : 0);
const esc = (s) => String(s).replace(/'/g, `'\\''`);

// ---------- nginx-rtmp Parser (Publisher & Bytes) ----------

// publishing Erkennung in allen gängigen Varianten
function hasPublisher(block) {
  return (
    /<\/publisher>/i.test(block) ||
    /<publishing>\s*1\s*<\/publishing>/i.test(block) ||
    /<publishing\s*\/\s*>/i.test(block) ||
    /<publishing\s*\/\s*>\s*/i.test(block) ||
    /<type>\s*publisher\s*<\/type>/i.test(block) ||
    /<publishing\b/i.test(block) // letzter Fallback, falls nginx irgendwas Komisches ausgibt
  );
}

function parseStreamBlock(streamXml) {
  const publisher = hasPublisher(streamXml);

  // Wichtig: wir matchen innerhalb des stream Blocks, nicht global
  const nclients = toNum((streamXml.match(/<nclients>\s*(\d+)\s*<\/nclients>/i) || [])[1]);
  const bytesIn = toNum((streamXml.match(/<bytes_in>\s*(\d+)\s*<\/bytes_in>/i) || [])[1]);
  const bytesOut = toNum((streamXml.match(/<bytes_out>\s*(\d+)\s*<\/bytes_out>/i) || [])[1]);

  return { publisher, nclients, bytesIn, bytesOut };
}

function parseApplicationBlock(appXmlInner) {
  // appXmlInner ist der Inhalt IN <application> ... </application>
  // Der App-Name ist die erste <name> direkt in application (die Stream-Names kommen später)
  const name = (appXmlInner.match(/<name>\s*([^<]+?)\s*<\/name>/i) || [])[1];
  if (!name) return null;

  let publisher = false;
  let nclients = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  // alle Streams innerhalb der App aufsummieren
  const rxStream = /<stream>([\s\S]*?)<\/stream>/gi;
  let m;
  let anyStream = false;

  while ((m = rxStream.exec(appXmlInner))) {
    anyStream = true;
    const s = m[1];
    const st = parseStreamBlock(s);
    if (st.publisher) publisher = true;
    nclients += st.nclients;
    bytesIn += st.bytesIn;
    bytesOut += st.bytesOut;
  }

  // falls keine <stream> Blöcke vorhanden sind (selten), fallback auf app level
  if (!anyStream) {
    publisher = hasPublisher(appXmlInner);
    nclients = toNum((appXmlInner.match(/<nclients>\s*(\d+)\s*<\/nclients>/i) || [])[1]);
    bytesIn = toNum((appXmlInner.match(/<bytes_in>\s*(\d+)\s*<\/bytes_in>/i) || [])[1]);
    bytesOut = toNum((appXmlInner.match(/<bytes_out>\s*(\d+)\s*<\/bytes_out>/i) || [])[1]);
  }

  return { name: String(name).trim(), publisher, nclients, bytesIn, bytesOut };
}

function parseApplications(xml) {
  const apps = {};

  // Robust: wirklich nur application Blöcke matchen
  const rxApp = /<application>([\s\S]*?)<\/application>/gi;
  let m;

  while ((m = rxApp.exec(xml))) {
    const inner = m[1];
    const parsed = parseApplicationBlock(inner);
    if (!parsed) continue;
    apps[parsed.name] = {
      publisher: parsed.publisher,
      nclients: parsed.nclients,
      bytesIn: parsed.bytesIn,
      bytesOut: parsed.bytesOut,
    };
  }

  return apps;
}

function buildStatus(xml) {
  const apps = parseApplications(xml);
  const safe = (n) => apps[n] || { publisher: false, nclients: 0, bytesIn: 0, bytesOut: 0 };
  return { dennis: safe("dennis"), auria: safe("auria"), mobil: safe("mobil") };
}

async function getRelayNet() {
  const out = await sh("docker network ls --format '{{.Name}}'");
  const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
  return (
    lines.find((n) => n === "stream-relay_relay-net") ||
    lines.find((n) => /_relay-net$/.test(n)) ||
    "bridge"
  );
}

// ---------- Push Container / ffmpeg ----------

const PUSH_NAME = "twitch-push";
const PUSH_NEXT = "twitch-push-next";
const FFMPEG_IMAGE = "jrottenberg/ffmpeg:4.4-ubuntu";

function buildFfmpegCmd(source) {
  if (!TWITCH_RTMP_URL) throw new Error("TWITCH_RTMP_URL not set");

  // BRB: immer transcode, weil mp4 -> flv
  if (source === "brb") {
    return [
      "set -euxo pipefail;",
      "ffmpeg -nostdin -hide_banner -loglevel info",
      "-re -stream_loop -1 -i /work/brb.mp4",
      "-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -profile:v high -level 4.1 -g 60 -keyint_min 60 -sc_threshold 0 -x264-params keyint=60:min-keyint=60:scenecut=0",
      "-b:v 4500k -maxrate 4500k -bufsize 9000k",
      "-c:a aac -ar 44100 -b:a 128k",
      "-f flv",
      `'${esc(TWITCH_RTMP_URL)}'`,
    ].join(" ");
  }

  const MAP = { dennis: DENNIS, auria: AURIA, mobil: MOBIL };
  const key = MAP[source];
  if (!key) throw new Error(`missing key for ${source}`);

  const input = `rtmp://nginx-rtmp:1935/${source}/${key}`;

  // LIVE: KEIN -re
  if (!TWITCH_TRANSCODE) {
    return [
      "set -euxo pipefail;",
      "ffmpeg -nostdin -hide_banner -loglevel info",
      "-i",
      `'${esc(input)}'`,
      "-c:v copy",
      "-c:a aac -ar 44100 -b:a 160k",
      "-f flv",
      `'${esc(TWITCH_RTMP_URL)}'`,
    ].join(" ");
  }

  return [
    "set -euxo pipefail;",
    "ffmpeg -nostdin -hide_banner -loglevel info",
    "-i",
    `'${esc(input)}'`,
    "-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -profile:v high -level 4.1 -g 60 -keyint_min 60 -sc_threshold 0 -x264-params keyint=60:min-keyint=60:scenecut=0",
    "-b:v 6000k -maxrate 6000k -bufsize 12000k",
    "-c:a aac -ar 44100 -b:a 128k",
    "-f flv",
    `'${esc(TWITCH_RTMP_URL)}'`,
  ].join(" ");
}

async function startNamedPushContainer(name, source) {
  const net = await getRelayNet();
  const cmd = buildFfmpegCmd(source);

  const run = [
    `docker run -d --name ${name}`,
    `--network ${net}`,
    "-v /opt/stream-relay/ffmpeg:/work:ro",
    "--entrypoint /bin/bash",
    FFMPEG_IMAGE,
    "-lc",
    `'${esc(cmd)}'`,
  ].join(" ");

  return await sh(run);
}

async function containerId(name) {
  const id = await shNoFail(`docker ps -a --filter name=^/${name}$ --format '{{.ID}}' 2>/dev/null || true`);
  return (id || "").trim();
}

async function containerRunning(name) {
  const out = await shNoFail(`docker ps --filter name=^/${name}$ --format '{{.ID}}' 2>/dev/null || true`);
  return Boolean((out || "").trim());
}

// Robustes Ready: wir prüfen primär, ob Container "running" ist.
// Optional prüfen wir zusätzlich Logs auf typische Fortschrittszeichen, aber NICHT als harte Bedingung.
async function waitPushReady(name, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await containerRunning(name)) {
      // Bonus: wenn Logs existieren, gut, aber nicht zwingend
      return true;
    }
    await sleep(250);
  }
  return false;
}

function maskTwitchUrl(s) {
  return String(s).replace(/(rtmp:\/\/live\.twitch\.tv\/app\/)([^'"\s]+)/gi, "$1***MASKED***");
}

function normalizeLogText(s) {
  return String(s || "").replace(/\r/g, "\n");
}

async function fastStopPushContainer() {
  await shNoFail(`docker rm -f ${PUSH_NAME} 2>/dev/null || true`);
}

async function gracefulStopPushContainer() {
  const id = await containerId(PUSH_NAME);
  if (!id) return;

  await shNoFail(`docker exec ${PUSH_NAME} sh -lc 'pkill -INT -x ffmpeg 2>/dev/null || true'`);
  await shNoFail(`docker exec ${PUSH_NAME} bash -lc 'pkill -INT -x ffmpeg 2>/dev/null || true'`);
  await sleep(700);

  await shNoFail(`docker stop -t 12 ${PUSH_NAME} 2>/dev/null || true`);
  await sleep(200);

  await shNoFail(`docker rm -f ${PUSH_NAME} 2>/dev/null || true`);
}

// Seamless Switch: neuer Container zuerst, dann alter weg, dann rename.
// Achtung: Twitch erlaubt nicht wirklich zwei Verbindungen gleichzeitig. Wir minimieren die Lücke,
// aber 100% offline-frei ist nur mit "permanentem Mixer".
async function seamlessSwitchTo(source) {
  await shNoFail(`docker rm -f ${PUSH_NEXT} 2>/dev/null || true`);

  const oldExists = await containerId(PUSH_NAME);

  // neuen starten
  await startNamedPushContainer(PUSH_NEXT, source);

  const ok = await waitPushReady(PUSH_NEXT, 8000);
  if (!ok) {
    const logs = await shNoFail(`docker logs --tail 80 ${PUSH_NEXT} 2>/dev/null || true`);
    await shNoFail(`docker rm -f ${PUSH_NEXT} 2>/dev/null || true`);
    if (!oldExists) throw new Error(`new push not ready, and no old push running. next logs:\n${logs}`);
    throw new Error(`new push not ready, keeping old. next logs:\n${logs}`);
  }

  // alten weg (fast)
  if (oldExists) {
    await shNoFail(`docker rm -f ${PUSH_NAME} 2>/dev/null || true`);
  }

  // rename
  await shNoFail(`docker rename ${PUSH_NEXT} ${PUSH_NAME} 2>/dev/null || true`);
}

// ---------- API ----------
app.get("/api/status", async (_req, res) => {
  try {
    const r = await fetch(NGINX_STAT_URL);
    if (!r.ok) throw new Error(`/stat ${r.status}`);
    const xml = await r.text();
    return res.json({ ok: true, stat: buildStatus(xml) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/who", async (_req, res) => {
  try {
    const ps = await shNoFail(
      `docker ps -a --filter name=^/${PUSH_NAME}$ --format '{{.ID}} {{.Image}} {{.Status}}' 2>/dev/null || true`
    );
    if (!ps.trim()) {
      return res.json({ ok: true, container: "", logs: "" });
    }
    const logsRaw = await shNoFail(`docker logs --tail 200 ${PUSH_NAME} 2>/dev/null || true`);
    const logs = maskTwitchUrl(normalizeLogText(logsRaw));
    return res.json({ ok: true, container: ps, logs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/logtail", async (req, res) => {
  const lines = Math.max(1, Math.min(500, parseInt(String(req.query.lines || "20"), 10) || 20));
  try {
    const id = await containerId(PUSH_NAME);
    if (!id) return res.type("text/plain").status(200).send("");
    const outRaw = await shNoFail(`docker logs --tail ${lines} ${PUSH_NAME} 2>/dev/null || true`);
    const out = maskTwitchUrl(normalizeLogText(outRaw));
    return res.type("text/plain").status(200).send(out || "");
  } catch (_e) {
    return res.type("text/plain").status(200).send("");
  }
});

async function currentMode() {
  const cfgJson = await shNoFail(`docker inspect ${PUSH_NAME} --format '{{json .Config}}' 2>/dev/null || true`);
  if (!cfgJson) return { mode: "idle" };

  let cfg;
  try {
    cfg = JSON.parse(cfgJson);
  } catch {
    return { mode: "unknown" };
  }

  const entry = Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.join(" ") : cfg.Entrypoint || "";
  const cmdArr = Array.isArray(cfg.Cmd) ? cfg.Cmd : cfg.Cmd ? [cfg.Cmd] : [];
  const cmd = cmdArr.join(" ");
  const full = [entry, cmd].filter(Boolean).join(" ");

  if (/\/work\/brb\.mp4/.test(full)) return { mode: "brb", cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/dennis\//.test(full)) return { mode: "dennis", cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/auria\//.test(full)) return { mode: "auria", cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/mobil\//.test(full)) return { mode: "mobil", cmd: full };
  return { mode: "unknown", cmd: full };
}

app.get("/api/current", async (_req, res) => {
  try {
    const cur = await currentMode();
    if (cur.cmd) cur.cmd = maskTwitchUrl(cur.cmd);
    return res.json({ ok: true, ...cur });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/stop", async (_req, res) => {
  try {
    await gracefulStopPushContainer();
    return res.json({ ok: true, stopped: true, mode: "idle" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/switch", async (req, res) => {
  try {
    const src = String((req.body && req.body.source) || "").toLowerCase();
    if (!["dennis", "auria", "mobil", "brb"].includes(src)) {
      return res.status(400).json({ ok: false, error: "invalid source" });
    }

    // Seamless-ish switch
    await seamlessSwitchTo(src);

    const top = await shNoFail(`docker ps -a --filter name=^/${PUSH_NAME}$ --format '{{.ID}} {{.Status}}' 2>/dev/null || true`);
    return res.json({ ok: true, switched: src, push: top.trim() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/diag", async (_req, res) => {
  try {
    const which = await shNoFail("which docker || true");
    const sock = await shNoFail("ls -l /var/run/docker.sock || true");
    const net = await getRelayNet();
    const top = await shNoFail(`docker ps -a --filter name=^/${PUSH_NAME}$ --format '{{.ID}} {{.Image}} {{.Status}}' || true`);

    const probeRaw = await shNoFail(`docker logs --tail 3 ${PUSH_NAME} 2>/dev/null || true`);
    const logsProbe = maskTwitchUrl(normalizeLogText(probeRaw));

    return res.json({ ok: true, docker: which || "(not found)", sock, network: net, push: top, logsProbe });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`✅ panel-server läuft auf Port ${PORT}`);
  console.log(`   NGINX_STAT_URL = ${NGINX_STAT_URL}`);
  console.log(`   TWITCH_TRANSCODE = ${TWITCH_TRANSCODE ? "1" : "0"}`);
});

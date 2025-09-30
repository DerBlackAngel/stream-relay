// Stream Control Panel Backend (Container-basierter Push, mit /api/current)
// - /api/status  : nginx-rtmp /stat (Publisher + Bytes)
// - /api/who     : Status + Logs des Containers "twitch-push" (auch wenn Exited)
// - /api/stop    : docker rm -f twitch-push
// - /api/switch  : Stop → docker run -d twitch-push mit ffmpeg-Command (über bash -lc)
// - /api/current : ermittelt aktuelles Push-Target (brb|dennis|auria|mobil|idle|unknown)
// - /api/diag    : Docker/Network-Diagnose

const express = require("express");
const path = require("path");
const { exec } = require("child_process");

const PORT = Number(process.env.PORT || 4000);
const NGINX_STAT_URL = process.env.NGINX_STAT_URL || "http://nginx-rtmp:18080/stat";

// Keys/URL aus ENV (Panel-Container liest .env via compose)
const TWITCH_RTMP_URL = process.env.TWITCH_RTMP_URL || "";
const DENNIS = process.env.DENNIS || "";
const AURIA  = process.env.AURIA  || "";
const MOBIL  = process.env.MOBIL  || "";

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
        console.error("[CMD FAIL]", cmd, "\n=>", msg);
        return reject(new Error(msg || "command failed"));
      }
      resolve((stdout || "").toString().trim());
    });
  });
}
const toNum = (x) => (Number.isFinite(+x) ? +x : 0);
const esc = (s) => String(s).replace(/'/g, `'\\''`);

// nginx-rtmp Parser (Publisher & Bytes)
function hasPublisher(block) {
  const rx = /<publisher>[\s\S]*?<\/publisher>|<publishing\s*\/>|<publishing>\s*1\s*<\/publishing>|<type>\s*publisher\s*<\/type>/i;
  return rx.test(block);
}
function parseAppBlock(block) {
  let publisher = false, nclients = 0, bytesIn = 0, bytesOut = 0;
  const rxStream = /<stream>([\s\S]*?)<\/stream>/g;
  let m, any = false;
  while ((m = rxStream.exec(block))) {
    any = true;
    const s = m[1];
    if (hasPublisher(s)) publisher = true;
    nclients += toNum((s.match(/<nclients>(\d+)<\/nclients>/) || [])[1]);
    bytesIn  += toNum((s.match(/<bytes_in>(\d+)<\/bytes_in>/)   || [])[1]);
    bytesOut += toNum((s.match(/<bytes_out>(\d+)<\/bytes_out>/) || [])[1]);
  }
  if (!any) {
    if (hasPublisher(block)) publisher = true;
    nclients = toNum((block.match(/<nclients>(\d+)<\/nclients>/) || [])[1]);
    bytesIn  = toNum((block.match(/<bytes_in>(\d+)<\/bytes_in>/)   || [])[1]);
    bytesOut = toNum((block.match(/<bytes_out>(\d+)<\/bytes_out>/) || [])[1]);
  }
  return { publisher, nclients, bytesIn, bytesOut };
}
function parseApplications(xml) {
  const apps = {};
  const rxApp = /<application>([\s\S]*?)<\/application>/g;
  let m;
  while ((m = rxApp.exec(xml))) {
    const block = m[1];
    const name = (block.match(/<name>([^<]+)<\/name>/) || [])[1];
    if (!name) continue;
    apps[name] = parseAppBlock(block);
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
  const lines = out.split("\n").map(s=>s.trim()).filter(Boolean);
  return lines.find(n => n === "stream-relay_relay-net")
      || lines.find(n => /_relay-net$/.test(n))
      || "bridge";
}

function buildFfmpegCmd(source) {
  if (!TWITCH_RTMP_URL) throw new Error("TWITCH_RTMP_URL not set");

  // Sichtbare Logs: -nostdin -loglevel info -progress pipe:2
  if (source === "brb") {
    return [
      "set -euxo pipefail;",
      "ffmpeg -nostdin -hide_banner -loglevel info",
      "-progress pipe:2",
      "-re -stream_loop -1 -i /work/brb.mp4",
      "-c:v copy -c:a aac -ar 44100 -b:a 128k",
      "-f flv", `'${esc(TWITCH_RTMP_URL)}'`
    ].join(" ");
  }

  const MAP = { dennis: DENNIS, auria: AURIA, mobil: MOBIL };
  const key = MAP[source];
  if (!key) throw new Error(`missing key for ${source}`);

  const input = `rtmp://nginx-rtmp:1935/${source}/${key}`;
  return [
    "set -euxo pipefail;",
    "ffmpeg -nostdin -hide_banner -loglevel info",
    "-progress pipe:2",
    "-re -i", `'${esc(input)}'`,
    "-c:v copy -c:a aac -ar 44100 -b:a 128k",
    "-f flv", `'${esc(TWITCH_RTMP_URL)}'`
  ].join(" ");
}

async function stopPushContainer() {
  await sh("docker rm -f twitch-push 2>/dev/null || true");
}

async function startPushContainer(source) {
  const net = await getRelayNet();
  const cmd = buildFfmpegCmd(source);
  // ENTRYPOINT überschreiben → /bin/bash -lc '<cmd>'
  const run = [
    "docker run -d --name twitch-push",
    `--network ${net}`,
    "-v /opt/stream-relay/ffmpeg:/work:ro",
    "--entrypoint /bin/bash",
    "jrottenberg/ffmpeg:4.4-ubuntu",
    "-lc",
    `'${esc(cmd)}'`
  ].join(" ");
  return await sh(run);
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
    const ps = await sh("docker ps -a --filter name=twitch-push --format '{{.ID}} {{.Image}} {{.Status}}'");
    const logs = await sh("docker logs --tail 200 twitch-push 2>/dev/null || true");
    return res.json({ ok: true, container: ps, logs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// NEU: Aktuelle Quelle erkennen (Cmd/Entrypoint inspizieren)
async function currentMode() {
  const cfgJson = await sh("docker inspect twitch-push --format '{{json .Config}}' 2>/dev/null || true");
  if (!cfgJson) return { mode: "idle" };
  let cfg;
  try { cfg = JSON.parse(cfgJson); } catch { return { mode: "unknown" }; }
  const entry = Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.join(" ") : (cfg.Entrypoint || "");
  const cmdArr = Array.isArray(cfg.Cmd) ? cfg.Cmd : (cfg.Cmd ? [cfg.Cmd] : []);
  const cmd = cmdArr.join(" ");
  const full = [entry, cmd].filter(Boolean).join(" ");
  if (/\/work\/brb\.mp4/.test(full)) return { mode: "brb", cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/dennis\//.test(full)) return { mode: "dennis", cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/auria\//.test(full))  return { mode: "auria",  cmd: full };
  if (/rtmp:\/\/nginx-rtmp:1935\/mobil\//.test(full))  return { mode: "mobil",  cmd: full };
  return { mode: "unknown", cmd: full };
}

app.get("/api/current", async (_req, res) => {
  try {
    const cur = await currentMode();
    return res.json({ ok: true, ...cur });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/stop", async (_req, res) => {
  try {
    await stopPushContainer();
    return res.json({ ok: true, stopped: true });
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
    await stopPushContainer();
    const id = await startPushContainer(src);
    return res.json({ ok: true, switched: src, container: id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/diag", async (_req, res) => {
  try {
    const which = await sh("which docker || true");
    const sock  = await sh("ls -l /var/run/docker.sock || true");
    const net   = await getRelayNet();
    const top   = await sh("docker ps -a --filter name=twitch-push --format '{{.ID}} {{.Image}} {{.Status}}' || true");
    return res.json({ ok: true, docker: which || "(not found)", sock, network: net, push: top });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Static UI
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`✅ panel-server läuft auf Port ${PORT}`);
  console.log(`   NGINX_STAT_URL = ${NGINX_STAT_URL}`);
});

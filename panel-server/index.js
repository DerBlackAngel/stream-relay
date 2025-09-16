const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const xml2js = require("xml2js");

const app = express();
const PORT = 4000;

const TWITCH_STREAM_KEY = process.env.TWITCH_STREAM_KEY || "";
const YOUTUBE_STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ------------------ Helpers ------------------

async function fetchStatXml() {
  const response = await axios.get("http://nginx-rtmp:8080/stat");
  return xml2js.parseStringPromise(response.data);
}
function findApp(result, appName) {
  const apps = result?.rtmp?.server?.[0]?.application || [];
  return apps.find(a => a.name?.[0] === appName) || null;
}
function getFirstStreamNameFromApp(appNode) {
  const streams = appNode?.live?.[0]?.stream || [];
  if (!streams.length) return null;
  return streams[0]?.name?.[0] || null;
}
function buildInputUrl(appName, streamName) {
  return `rtmp://nginx-rtmp:1935/${appName}/${streamName}`;
}
function buildBrbInputUrl() {
  return "rtmp://nginx-rtmp:1935/live/brb";
}

function runDocker(args, label) {
  const p = spawn("docker", args, { stdio: "ignore" });
  p.on("exit", (code, signal) => {
    console.log(`ℹ️ docker ${label} exit=${code} signal=${signal ?? "none"}`);
  });
  return p;
}
function runDockerCollect(args) {
  return new Promise((resolve) => {
    const p = spawn("docker", args);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("exit", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// ffmpeg-Prozesse im Runner zählen (optional Filter auf Ziel)
async function countFfmpeg(filter = "") {
  const { out } = await runDockerCollect([
    "exec", "ffmpeg-runner", "sh", "-lc",
    `pgrep -fa ffmpeg ${filter ? `| grep '${filter.replace(/'/g, "'\\''")}'` : ""} | wc -l`
  ]);
  return parseInt(out || "0", 10);
}

// alle ffmpeg killen und wirklich warten, bis 0 laufen
async function killFFmpegAndWait() {
  await runDockerCollect(["exec", "-d", "ffmpeg-runner", "pkill", "-9", "ffmpeg"]);
  // Poll bis 0, max ~3s
  for (let i = 0; i < 15; i++) {
    const n = await countFfmpeg();
    if (n === 0) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

// detached ffmpeg mit Logging
let lastLogFile = null;
function spawnFfmpegDetachedWithLog(ffArgs, label) {
  const stamp = Date.now();
  const logFile = `/tmp/relay-${stamp}-${label}.log`;
  lastLogFile = logFile;
  const cmd = `exec ffmpeg -nostdin -loglevel verbose ${ffArgs.join(" ")} >> ${logFile} 2>&1 &`;
  const full = ["exec", "-d", "ffmpeg-runner", "sh", "-lc", cmd];
  console.log(`$ docker ${full.join(" ")}`);
  return runDocker(full, label);
}

// kleine Wartehilfe
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------ Routes ------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "panel-server",
    twitchKeyLoaded: !!TWITCH_STREAM_KEY,
    youtubeKeyLoaded: !!YOUTUBE_STREAM_KEY
  });
});

app.get("/status", async (_req, res) => {
  try {
    const result = await fetchStatXml();
    const dennisApp = findApp(result, "dennis");
    const auriaApp  = findApp(result, "auria");
    const mobilApp  = findApp(result, "mobil");
    const liveApp   = findApp(result, "live");
    const anyStream = a => !!(a?.live?.[0]?.stream || []).length;
    res.json({
      dennis: anyStream(dennisApp),
      auria:  anyStream(auriaApp),
      mobil:  anyStream(mobilApp),
      live:   anyStream(liveApp)
    });
  } catch (err) {
    console.error("Fehler beim Parsen von RTMP-Stat:", err.message);
    res.status(500).json({ error: "Fehler beim Laden der Stream-Status" });
  }
});

// Letzte ffmpeg-Logs aus dem Runner (tail)
app.get("/ffmpeg/lastlog", async (_req, res) => {
  if (!lastLogFile) return res.status(404).send("no log yet");
  const { out, err } = await runDockerCollect([
    "exec", "ffmpeg-runner", "sh", "-lc", `test -f ${lastLogFile} && tail -n 200 ${lastLogFile} || echo 'no log file'`
  ]);
  res.type("text/plain").send(out || err || "");
});

// Debug: laufende ffmpeg sehen
app.get("/ffmpeg/pids", async (_req, res) => {
  const { out } = await runDockerCollect([
    "exec", "ffmpeg-runner", "sh", "-lc", "pgrep -fa ffmpeg || true"
  ]);
  res.type("text/plain").send(out || "(none)");
});

// Start mit Auto-Detect + strikter Ein-/Ausschalt-Sequenz
app.post("/start", async (req, res) => {
  const { input, twitch = true, youtube = false } = req.body || {};
  if (!input) return res.status(400).send("❌ 'input' fehlt");
  const allowed = ["dennis", "auria", "mobil", "brb", "live"];
  if (!allowed.includes(input)) return res.status(400).send("❌ Ungültiger Input");
  if (!twitch && !youtube) return res.status(400).send("❌ Kein Ziel ausgewählt");

  let inputUrl;
  try {
    if (["dennis", "auria", "mobil"].includes(input)) {
      const result = await fetchStatXml();
      const appNode = findApp(result, input);
      const streamName = getFirstStreamNameFromApp(appNode);
      inputUrl = streamName ? buildInputUrl(input, streamName) : buildBrbInputUrl();
      console.log(streamName
        ? `📡 Quelle: ${inputUrl}`
        : `⚠️ Kein aktiver Stream bei '${input}' – Fallback: BRB (${inputUrl})`);
    } else {
      inputUrl = buildBrbInputUrl();
      console.log(`📼 Quelle: BRB (${inputUrl})`);
    }
  } catch (e) {
    console.error("❌ Fehler beim Ermitteln des Inputs:", e.message);
    inputUrl = buildBrbInputUrl();
  }

  // 1) sicher alles stoppen
  await killFFmpegAndWait();
  // 2) Twitch/YT-Session freigeben lassen
  await sleep(2000);

  // 3) starten
  if (twitch) {
    if (!TWITCH_STREAM_KEY) return res.status(500).send("❌ TWITCH_STREAM_KEY fehlt");
    spawnFfmpegDetachedWithLog(
      ["-re", "-rtmp_live", "live", "-i", inputUrl, "-c", "copy", "-f", "flv",
       `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`],
      "start-twitch"
    );
  }
  if (youtube) {
    if (!YOUTUBE_STREAM_KEY) return res.status(500).send("❌ YOUTUBE_STREAM_KEY fehlt");
    spawnFfmpegDetachedWithLog(
      ["-re", "-rtmp_live", "live", "-i", inputUrl, "-c", "copy", "-f", "flv",
       `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`],
      "start-youtube"
    );
  }

  res.send(`🚀 Weiterleitung gestartet von '${input}' (${inputUrl}) → ${[
    twitch ? "Twitch" : null,
    youtube ? "YouTube" : null
  ].filter(Boolean).join(" & ")}`);
});

// BRB direkt pushen – auch mit sauberem Kill/Wait
app.post("/stop", async (_req, res) => {
  if (!TWITCH_STREAM_KEY && !YOUTUBE_STREAM_KEY) {
    return res.status(500).send("❌ Keine Ziel-Keys vorhanden");
  }
  await killFFmpegAndWait();
  await sleep(500);

  if (TWITCH_STREAM_KEY) {
    spawnFfmpegDetachedWithLog(
      ["-re", "-stream_loop", "-1", "-i", "/ffmpeg/brb.mp4", "-c", "copy", "-f", "flv",
       `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`],
      "brb-twitch"
    );
  }
  if (YOUTUBE_STREAM_KEY) {
    spawnFfmpegDetachedWithLog(
      ["-re", "-stream_loop", "-1", "-i", "/ffmpeg/brb.mp4", "-c", "copy", "-f", "flv",
       `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`],
      "brb-youtube"
    );
  }

  res.send(`🛑 BRB gestartet (${buildBrbInputUrl()})`);
});

// Kompatibilität
app.post("/switch", (req, res) => {
  const { input } = req.body || {};
  if (!input) return res.status(400).send("❌ input fehlt");
  if (input === "brb") {
    req.url = "/stop";
    return app._router.handle(req, res);
  }
  req.body.twitch = req.body.twitch ?? true;
  req.body.youtube = req.body.youtube ?? false;
  req.url = "/start";
  return app._router.handle(req, res);
});

app.listen(PORT, () => {
  console.log(`✅ panel-server läuft auf Port ${PORT}`);
});

const express = require("express");
const { exec } = require("child_process");
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

// ---- Helpers ---------------------------------------------------------------

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
  // nimm den ersten aktiven Stream
  return streams[0]?.name?.[0] || null;
}

function buildInputUrl(appName, streamName) {
  // Beispiel: rtmp://nginx-rtmp:1935/dennis/test
  return `rtmp://nginx-rtmp:1935/${appName}/${streamName}`;
}

function buildBrbInputUrl() {
  // Unser BRB-Loop speist in live/brb ein (siehe ffmpeg-loop)
  return "rtmp://nginx-rtmp:1935/live/brb";
}

function run(cmd, label = "cmd") {
  console.log(`$ ${cmd}`);
  exec(cmd, (error, stdout, stderr) => {
    if (error) console.error(`❌ ${label} error:`, error.message);
    if (stdout) console.log(`ℹ️  ${label} out:`, stdout.toString().trim());
    if (stderr) console.log(`ℹ️  ${label} err:`, stderr.toString().trim());
  });
}

function killFFmpeg() {
  // nur im ffmpeg-runner Container (nicht ffmpeg-loop)
  run(`docker exec ffmpeg-runner pkill -9 ffmpeg || true`, "kill-ffmpeg");
}

// ---- Routes ---------------------------------------------------------------

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "panel-server",
    twitchKeyLoaded: !!TWITCH_STREAM_KEY,
    youtubeKeyLoaded: !!YOUTUBE_STREAM_KEY
  });
});

// RTMP-Livestatus fürs Webpanel
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

// Stream starten (Weiterleitung zu Twitch/YouTube) mit Auto-Detect des Stream-Namens
app.post("/start", async (req, res) => {
  const { input, twitch = true, youtube = false } = req.body || {};
  if (!input) return res.status(400).send("❌ 'input' fehlt");

  const allowed = ["dennis", "auria", "mobil", "brb", "live"];
  if (!allowed.includes(input)) {
    return res.status(400).send("❌ Ungültiger Input");
  }
  if (!twitch && !youtube) {
    return res.status(400).send("❌ Kein Ziel ausgewählt");
  }

  // Ermittele die Input-URL
  let inputUrl = null;
  try {
    if (["dennis", "auria", "mobil"].includes(input)) {
      const result = await fetchStatXml();
      const appNode = findApp(result, input);
      const streamName = getFirstStreamNameFromApp(appNode);
      if (!streamName) {
        // Kein aktiver Stream: Fallback = BRB
        inputUrl = buildBrbInputUrl();
        console.log(`⚠️ Kein aktiver Stream bei '${input}' gefunden – Fallback auf BRB.`);
      } else {
        inputUrl = buildInputUrl(input, streamName);
        console.log(`📡 Quelle: ${inputUrl}`);
      }
    } else {
      // brb oder live: immer live/brb
      inputUrl = buildBrbInputUrl();
      console.log(`📼 Quelle: BRB (${inputUrl})`);
    }
  } catch (e) {
    console.error("❌ Fehler beim Ermitteln des Input-Streams:", e.message);
    inputUrl = buildBrbInputUrl();
    console.log("⚠️ Fallback auf BRB.");
  }

  // Alte Weiterleitungen stoppen
  killFFmpeg();

  // Kommandos bauen
  const commands = [];
  if (twitch) {
    if (!TWITCH_STREAM_KEY) return res.status(500).send("❌ TWITCH_STREAM_KEY fehlt");
    const twitchCmd = `docker exec ffmpeg-runner ffmpeg -re -i "${inputUrl}" -c copy -f flv "rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}"`;
    commands.push(twitchCmd);
  }
  if (youtube) {
    if (!YOUTUBE_STREAM_KEY) return res.status(500).send("❌ YOUTUBE_STREAM_KEY fehlt");
    const ytCmd = `docker exec ffmpeg-runner ffmpeg -re -i "${inputUrl}" -c copy -f flv "rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}"`;
    commands.push(ytCmd);
  }

  // Starten
  commands.forEach((cmd, i) => run(cmd, `ffmpeg-start-${i + 1}`));

  res.send(`🚀 Weiterleitung gestartet von '${input}' (${inputUrl}) → ${[
    twitch ? "Twitch" : null,
    youtube ? "YouTube" : null
  ].filter(Boolean).join(" & ")}`);
});

// BRB-Video direkt zu Twitch/YouTube pushen
app.post("/stop", (_req, res) => {
  if (!TWITCH_STREAM_KEY && !YOUTUBE_STREAM_KEY) {
    return res.status(500).send("❌ Keine Ziel-Keys vorhanden");
  }

  // Alte Weiterleitungen stoppen
  killFFmpeg();

  const brbUrl = buildBrbInputUrl();

  const commands = [];
  if (TWITCH_STREAM_KEY) {
    const cmd = `docker exec ffmpeg-runner ffmpeg -re -stream_loop -1 -i /ffmpeg/brb.mp4 -c copy -f flv "rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}"`;
    commands.push(cmd);
  }
  if (YOUTUBE_STREAM_KEY) {
    const cmd = `docker exec ffmpeg-runner ffmpeg -re -stream_loop -1 -i /ffmpeg/brb.mp4 -c copy -f flv "rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}"`;
    commands.push(cmd);
  }

  commands.forEach((cmd, i) => run(cmd, `ffmpeg-brb-${i + 1}`));
  res.send(`🛑 BRB gestartet (${brbUrl})`);
});

// Kompatibilität: /switch -> /start
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

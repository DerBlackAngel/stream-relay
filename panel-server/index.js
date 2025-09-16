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

// Healthcheck
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "panel-server",
    twitchKeyLoaded: !!TWITCH_STREAM_KEY,
    youtubeKeyLoaded: !!YOUTUBE_STREAM_KEY
  });
});

// RTMP-Livestatus fürs Webpanel
app.get("/status", async (req, res) => {
  try {
    const response = await axios.get("http://nginx-rtmp:8080/stat");
    const result = await xml2js.parseStringPromise(response.data);
    const apps = result?.rtmp?.server?.[0]?.application || [];
    const liveApp = apps.find(a => a.name?.[0] === "live"); // falls du "live" verwendest
    const dennisApp = apps.find(a => a.name?.[0] === "dennis");
    const auriaApp  = apps.find(a => a.name?.[0] === "auria");
    const mobilApp  = apps.find(a => a.name?.[0] === "mobil");

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

// Stream starten (Weiterleitung zu Twitch/YouTube)
app.post("/start", (req, res) => {
  const { input, twitch = true, youtube = false } = req.body;
  if (!["dennis", "auria", "mobil", "brb", "live"].includes(input)) {
    return res.status(400).send("❌ Ungültiger Input");
  }

  const commands = [];
  if (twitch) {
    if (!TWITCH_STREAM_KEY) return res.status(500).send("❌ TWITCH_STREAM_KEY fehlt");
    const twitchCmd = `docker exec ffmpeg-runner ffmpeg -re -i rtmp://nginx-rtmp:1935/${input} -c copy -f flv rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`;
    commands.push(twitchCmd);
  }
  if (youtube) {
    if (!YOUTUBE_STREAM_KEY) return res.status(500).send("❌ YOUTUBE_STREAM_KEY fehlt");
    const ytCmd = `docker exec ffmpeg-runner ffmpeg -re -i rtmp://nginx-rtmp:1935/${input} -c copy -f flv rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;
    commands.push(ytCmd);
  }
  if (!commands.length) return res.status(400).send("❌ Kein Ziel ausgewählt");

  commands.forEach(cmd => {
    exec(cmd, (error) => {
      if (error) console.error(`❌ Fehler beim Start: ${error.message}`);
      else console.log(`✅ Stream gestartet: ${cmd}`);
    });
  });

  res.send(`🚀 Weiterleitung gestartet von '${input}'`);
});

// BRB-Video aktivieren
app.post("/stop", (req, res) => {
  if (!TWITCH_STREAM_KEY) return res.status(500).send("❌ TWITCH_STREAM_KEY fehlt");
  const cmd = `docker exec ffmpeg-runner ffmpeg -re -stream_loop -1 -i /ffmpeg/brb.mp4 -c copy -f flv rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`;
  console.log("🛑 Wechsle zu BRB-Video");
  exec(cmd, (error) => {
    if (error) return res.status(500).send("Fehler beim Umschalten auf BRB");
    console.log("✅ BRB-Video läuft");
    res.send("🛑 BRB-Video gestartet");
  });
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

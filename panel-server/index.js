const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const xml2js = require("xml2js");

const app = express();
const PORT = 4000;

const TWITCH_STREAM_KEY = process.env.TWITCH_STREAM_KEY || "";
if (!TWITCH_STREAM_KEY) {
  console.warn("⚠️  TWITCH_STREAM_KEY ist nicht gesetzt. Setze ihn in .env / Compose!");
}
const YOUTUBE_STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || ""; // optional

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// RTMP-Livestatus fürs Webpanel
app.get("/status", async (req, res) => {
  try {
    const response = await axios.get("http://nginx-rtmp:8080/stat");
    const result = await xml2js.parseStringPromise(response.data);
    const liveApp = (result?.rtmp?.server?.[0]?.application || []).find(a => a.name?.[0] === "live");
    const streams = liveApp?.live?.[0]?.stream || [];
    const getLive = (name) => streams.some(s => s.name?.[0] === name);
    res.json({ dennis: getLive("dennis"), auria: getLive("auria"), mobil: getLive("mobil") });
  } catch (err) {
    console.error("Fehler beim Parsen von RTMP-Stat:", err);
    res.status(500).json({ error: "Fehler beim Laden der Stream-Status" });
  }
});

// Stream starten (Weiterleitung)
app.post("/start", (req, res) => {
  const { input, twitch = true, youtube = false } = req.body;
  if (!["dennis", "auria", "mobil", "brb"].includes(input)) {
    return res.status(400).send("❌ Ungültiger Input");
  }

  const commands = [];
  if (twitch) {
    if (!TWITCH_STREAM_KEY) return res.status(500).send("❌ TWITCH_STREAM_KEY fehlt");
    const twitchCmd = `docker exec ffmpeg-runner ffmpeg -re -i rtmp://nginx-rtmp/live/${input} -c copy -f flv rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`;
    commands.push(twitchCmd);
  }
  if (youtube) {
    if (!YOUTUBE_STREAM_KEY) return res.status(500).send("❌ YOUTUBE_STREAM_KEY fehlt");
    const youtubeCmd = `docker exec ffmpeg-runner ffmpeg -re -i rtmp://nginx-rtmp/live/${input} -c copy -f flv rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;
    commands.push(youtubeCmd);
  }
  if (!commands.length) return res.status(400).send("❌ Kein Ziel ausgewählt");

  commands.forEach(cmd => {
    exec(cmd, (error) => {
      if (error) console.error(`❌ Fehler beim Start: ${error.message}`);
      else console.log(`✅ Stream gestartet: ${cmd}`);
    });
  });

  res.send("🚀 Stream gestartet");
});

// BRB
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
  const { input } = req.body;
  if (input === "brb") return app._router.handle({ ...req, url: "/stop", method: "POST" }, res, () => {});
  req.body.twitch = true;
  req.body.youtube = false;
  return app._router.handle({ ...req, url: "/start", method: "POST" }, res, () => {});
});

app.listen(PORT, () => {
  console.log(`✅ Panel-Server läuft auf Port ${PORT}`);
});

const express = require("express");
const { exec, execSync, spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const xml2js = require("xml2js");

const app = express();
const PORT = 4000;

// 🔑 DEIN TWITCH-KEY HIER EINTRAGEN
const TWITCH_STREAM_KEY = "live_1292654616_qmwWRqcG0IDbu88xC35lhJN9otgLBd"; // <== WICHTIG!

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🔍 RTMP-Livestatus abrufen für Webpanel
app.get("/status", async (req, res) => {
  try {
    const response = await axios.get("http://nginx-rtmp:8080/stat");
    const result = await xml2js.parseStringPromise(response.data);
    const streams = result.rtmp.server[0].application.find(app => app.name[0] === "live").live[0].stream || [];

    const getLive = (name) => streams.some(s => s.name[0] === name);
    res.json({
      dennis: getLive("dennis"),
      auria: getLive("auria"),
      mobil: getLive("mobil")
    });
  } catch (err) {
    console.error("Fehler beim Parsen von RTMP-Stat:", err);
    res.status(500).json({ error: "Fehler beim Laden der Stream-Status" });
  }
});

// 🚀 STREAM STARTEN
app.post("/start", (req, res) => {
  const { input, twitch, youtube } = req.body;

  console.log("⚙️ /start API wurde aufgerufen");
  console.log(`🔁 Starte Umschaltung auf: ${input} → ${twitch ? "twitch" : ""} ${youtube ? "+ youtube" : ""}`);

  if (!twitch && !youtube) {
    return res.status(400).send("❌ Kein Ziel ausgewählt");
  }

  // 🛑 Stoppe alte ffmpeg-Prozesse im ffmpeg-runner
  try {
    execSync(`docker exec ffmpeg-runner pkill -9 ffmpeg`);
    console.log("🛑 Alte ffmpeg Instanzen gestoppt");
  } catch {
    console.log("ℹ️ Keine laufenden ffmpeg-Prozesse");
  }

  if (twitch) {
    const twitchCmd = [
      "exec", "ffmpeg-runner", "ffmpeg",
      "-re", "-i", `rtmp://nginx-rtmp/live/${input}`,
      "-c", "copy", "-f", "flv",
      `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`
    ];
    console.log("🚀 Starte Twitch ffmpeg-Prozess (Debug aktiv)...");
    const proc = spawn("/usr/bin/docker", twitchCmd);

    proc.stdout.on("data", (data) => console.log(`📤 Twitch stdout: ${data.toString()}`));
    proc.stderr.on("data", (data) => console.error(`📥 Twitch stderr: ${data.toString()}`));
    proc.on("close", (code) => console.log(`❌ Twitch-ffmpeg beendet mit Code ${code}`));
    proc.on("error", (err) => console.error(`💥 Spawn-Fehler: ${err.message}`));
  }

  if (youtube) {
    const youtubeKey = "YOUR_YOUTUBE_KEY"; // <== ggf. hier einsetzen
    const ytCmd = [
      "exec", "ffmpeg-runner", "ffmpeg",
      "-re", "-i", `rtmp://nginx-rtmp/live/${input}`,
      "-c", "copy", "-f", "flv",
      `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`
    ];
    console.log("🚀 Starte YouTube ffmpeg-Prozess...");
    const proc = spawn("/usr/bin/docker", ytCmd);
    proc.stdout.on("data", (data) => console.log(`📤 YouTube stdout: ${data.toString()}`));
    proc.stderr.on("data", (data) => console.error(`📥 YouTube stderr: ${data.toString()}`));
    proc.on("close", (code) => console.log(`❌ YouTube-ffmpeg beendet mit Code ${code}`));
    proc.on("error", (err) => console.error(`💥 Spawn-Fehler: ${err.message}`));
  }

  res.send("🚀 Stream gestartet");
});

// 🛑 STREAM STOPPEN (BRB)
app.post("/stop", (req, res) => {
  const cmd = `docker exec ffmpeg-runner ffmpeg -re -stream_loop -1 -i /ffmpeg/brb.mp4 -c copy -f flv rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`;
  console.log("🛑 Wechsle zu BRB-Video");

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Fehler beim Umschalten auf BRB: ${error.message}`);
      return res.status(500).send("Fehler beim Stoppen des Streams");
    }
    console.log("✅ BRB-Video läuft");
    res.send("🛑 BRB-Video gestartet");
  });
});

// 🌐 Server starten
app.listen(PORT, () => {
  console.log(`✅ Panel-Server läuft auf Port ${PORT}`);
});

const express = require("express");
const cors = require("cors");
const { execSync, spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

let activeInput = "brb"; // Startzustand: immer BRB-Loop

const inputs = ["dennis", "auria", "mobil"];
const TWITCH_STREAM_KEY = process.env.TWITCH_STREAM_KEY || "";
if (!TWITCH_STREAM_KEY) {
  console.warn("⚠️  TWITCH_STREAM_KEY ist nicht gesetzt. Setze ihn in .env / Compose!");
}
const twitchStreamUrl = `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`;

function isLive(inputName) {
  try {
    const result = execSync(
      `curl -s http://nginx-rtmp:8080/stat | grep -A10 "<name>${inputName}</name>"`
    ).toString();
    return result.includes("<bw>");
  } catch {
    return false;
  }
}

function stopAllFFmpeg() {
  try {
    const running = execSync(
      `docker exec ffmpeg-runner ps -eaf | grep ffmpeg | grep -v grep || true`
    ).toString();

    if (running.includes("ffmpeg")) {
      execSync(`docker exec ffmpeg-runner pkill -9 ffmpeg`);
      console.log("🛑 ffmpeg gestoppt");
    }
  } catch (err) {
    console.error("⚠️ Fehler beim Stoppen von ffmpeg:", err.message);
  }
}

function startInputStream(inputName) {
  console.log(`🚀 Starte Input-FFmpeg: ${inputName}`);
  const cmd = [
    "docker", "exec", "ffmpeg-runner", "ffmpeg",
    "-re", "-i", `rtmp://nginx-rtmp:1935/live/${inputName}`,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "3000k",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv", twitchStreamUrl
  ];
  spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
}

function switchTo(inputName) {
  stopAllFFmpeg();

  if (inputName === "brb") {
    console.log("⚠️ Aktiviere BRB-Stream");
    startInputStream("brb");
  } else {
    if (isLive(inputName)) {
      console.log(`📡 ${inputName} ist live – starte Weiterleitung`);
      startInputStream(inputName);
    } else {
      console.log(`❌ ${inputName} ist NICHT live – aktiviere BRB`);
      startInputStream("brb");
    }
  }

  activeInput = inputName;
}

app.post("/switch", (req, res) => {
  const { input } = req.body;
  if (!inputs.includes(input) && input !== "brb") {
    return res.status(400).json({ error: "Ungültiger Input" });
  }
  console.log(`🟢 Manuelle Umschaltung auf: ${input}`);
  switchTo(input);
  res.json({ success: true, active: input });
});

app.get("/status", (req, res) => {
  const status = {};
  for (const input of inputs) {
    status[input] = isLive(input);
  }
  res.json({ inputs: status, activeInput });
});

setInterval(() => {
  if (activeInput === "brb") return;
  const stillLive = isLive(activeInput);
  if (!stillLive) {
    console.log(`⚠️ ${activeInput} ist nicht mehr live – schalte zu BRB`);
    switchTo("brb");
  }
}, 4000);

app.listen(3000, () => {
  console.log("✅ Auth-Server läuft auf Port 3000");
});

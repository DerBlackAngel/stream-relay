/**
 * Stream-Guard
 * - Pollt alle 5s den Status der aktuell relayed Quelle (dennis/auria/mobil)
 * - Prüft 2 Dinge:
 *    (a) existiert der Stream-Node im RTMP-Stat?
 *    (b) steigt dessen <time>-Wert weiter an?
 * - Wenn 3x hintereinander "nicht aktiv" => BRB via Panel-API.
 * - Kein Alarm, wenn die "nicht aktiv" Fälle nicht direkt aufeinander folgen.
 */

const axios = require("axios");
const xml2js = require("xml2js");

const POLL_MS = parseInt(process.env.SG_POLL_MS || "5000", 10);         // Intervall
const FAIL_THRESHOLD = parseInt(process.env.SG_FAIL_THRESHOLD || "3", 10); // 3x hintereinander
const COOLDOWN_MS = parseInt(process.env.SG_COOLDOWN_MS || "10000", 10);   // 10s nach Umschalten

const RTMP_STAT_URL = process.env.SG_STAT_URL || "http://nginx-rtmp:8080/stat";
const PANEL_BASE = process.env.SG_PANEL_BASE || "http://panel-server:4000";

const APPS = new Set(["dennis", "auria", "mobil"]); // überwachte Quellen

let lastTimes = new Map();          // key = `${app}:${streamName}` -> last <time> Int
let inactiveStreak = 0;             // Anzahl in Folge "nicht aktiv" für die aktuelle Quelle
let currentApp = null;              // aktuell relayed App (aus ffmpeg-CLI geparst)
let currentStreamName = null;       // aktuell relayed Stream-Name
let lastSwitchTs = 0;               // für Cooldown nach BRB-Umschalten

// Hilfsfunktionen ------------------------------------------------------------

async function getCurrentRelayFromRunner() {
  // Liest den aktiven ffmpeg im Runner und parst die -i URL
  try {
    const { data: line } = await execInRunnerCollect("pgrep -fa ffmpeg | head -n1 || true");
    const text = (line || "").trim();
    if (!text) return { mode: "idle" };

    if (text.includes("/ffmpeg/brb.mp4")) {
      return { mode: "brb" };
    }

    // Suche nach rtmp://nginx-rtmp:1935/<app>/<stream>
    const m = text.match(/rtmp:\/\/nginx-rtmp:1935\/([a-zA-Z0-9_-]+)\/([^\s"']+)/);
    if (m) {
      const app = m[1];
      const stream = m[2];
      if (APPS.has(app)) {
        return { mode: "relay", app, stream };
      }
      return { mode: "other", app, stream }; // z.B. "live/brb" o.ä.
    }

    return { mode: "unknown", raw: text };
  } catch (e) {
    return { mode: "idle", err: e.message };
  }
}

async function fetchStat() {
  const res = await axios.get(RTMP_STAT_URL, { timeout: 3000 });
  return xml2js.parseStringPromise(res.data);
}

function findStreamNode(stat, appName, streamName) {
  const apps = stat?.rtmp?.server?.[0]?.application || [];
  const app = apps.find(a => a?.name?.[0] === appName);
  if (!app) return null;
  const streams = app?.live?.[0]?.stream || [];
  if (!streams.length) return null;
  if (!streamName) return streams[0];
  return streams.find(s => (s?.name?.[0] || "") === streamName) || null;
}

function getStreamTimeMs(streamNode) {
  // <time> kommt in Millisekunden
  const tStr = streamNode?.time?.[0];
  if (!tStr) return null;
  const t = parseInt(String(tStr), 10);
  return Number.isFinite(t) ? t : null;
}

async function postBRB() {
  try {
    await axios.post(`${PANEL_BASE}/stop`, {}, { timeout: 4000 });
    console.log("🟥 FAILOVER → BRB aktiviert");
  } catch (e) {
    console.error("❌ BRB-Umschaltung fehlgeschlagen:", e.message);
  }
}

async function execInRunnerCollect(cmd) {
  // Führt shell im Runner aus und sammelt stdout
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", "ffmpeg-runner", "sh", "-lc", cmd]);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("exit", (code) => resolve({ code, data: (out || err).trim() }));
  });
}

// Hauptloop ------------------------------------------------------------------

async function tick() {
  try {
    // 1) Herausfinden, was gerade relayed wird
    const relay = await getCurrentRelayFromRunner();

    if (relay.mode !== "relay" || !APPS.has(relay.app)) {
      // Nichts zu überwachen (BRB/idle/other). Zähler zurücksetzen.
      if (inactiveStreak !== 0) inactiveStreak = 0;
      currentApp = null;
      currentStreamName = null;
      // Debug: freundliches Ping
      console.log(`Ping ... (keine überwachte Quelle aktiv: ${relay.mode})`);
      return;
    }

    // Wenn neue Quelle oder neuer Stream-Key: Streak zurücksetzen
    const switchedSource = (relay.app !== currentApp) || (relay.stream !== currentStreamName);
    if (switchedSource) {
      inactiveStreak = 0;
      currentApp = relay.app;
      currentStreamName = relay.stream;
      console.log(`🔎 Überwache jetzt: ${currentApp}/${currentStreamName}`);
    }

    // 2) Stat laden und passenden Stream-Knoten suchen
    const stat = await fetchStat();
    const node = findStreamNode(stat, currentApp, currentStreamName);

    let isActive = false;
    if (node) {
      // Zeitzähler sollte steigen
      const key = `${currentApp}:${currentStreamName}`;
      const t = getStreamTimeMs(node);
      const last = lastTimes.get(key);
      if (t !== null && (last === undefined || t > last)) {
        isActive = true;
        lastTimes.set(key, t);
      } else {
        // Zeit steht → vermutlich eingefroren/abgerissen
        isActive = false;
      }
    } else {
      // Kein Stream-Knoten → nicht aktiv
      isActive = false;
    }

    // 3) Konsequenz
    if (isActive) {
      inactiveStreak = 0;
      console.log("Ping ... aktiv");
      return;
    }

    // Nicht aktiv
    inactiveStreak += 1;
    console.log(`Ping ... nicht aktiv (${inactiveStreak}/${FAIL_THRESHOLD})`);

    // Cooldown nach Umschalten beachten
    const now = Date.now();
    const inCooldown = (now - lastSwitchTs) < COOLDOWN_MS;

    if (!inCooldown && inactiveStreak >= FAIL_THRESHOLD) {
      await postBRB();
      lastSwitchTs = Date.now();
      inactiveStreak = 0; // zurücksetzen nach Umschaltung
    }
  } catch (e) {
    console.error("tick() Fehler:", e.message);
  }
}

console.log(`🛡️  Stream-Guard gestartet: Intervall=${POLL_MS}ms, Threshold=${FAIL_THRESHOLD}x, Cooldown=${COOLDOWN_MS}ms`);
setInterval(tick, POLL_MS);
tick(); // sofort erster Durchlauf

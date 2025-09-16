/**
 * Stream-Guard (v3) – robustes Failover
 * - Pollt alle 5s (konfigurierbar) den aktuell relayed Input (dennis/auria/mobil)
 * - Aktiv = es gibt mind. einen <client> mit <publishing/> UND bytes_in steigt
 *   Sonderfälle:
 *     * erster Tick (delta=n/a) bei vorhandenem Publisher => aktiv
 *     * Counter-Wrap/Reset (delta<0) bei vorhandenem Publisher => aktiv
 * - Nicht aktiv = kein Publisher ODER bytes_in steigt nicht
 * - 3x hintereinander „nicht aktiv“ => BRB via Panel-API
 *   -> mit Retry & längerem Timeout, plus Cooldown gegen Flapping
 * - Fallback-Erkennung der Quelle über runner-IP im /stat, falls Prozess-Parse nichts liefert
 */

const axios = require("axios");
const xml2js = require("xml2js");
const { spawn } = require("child_process");

const POLL_MS          = parseInt(process.env.SG_POLL_MS || "5000", 10);       // 5s
const FAIL_THRESHOLD   = parseInt(process.env.SG_FAIL_THRESHOLD || "3", 10);   // 3x in Folge
const COOLDOWN_MS      = parseInt(process.env.SG_COOLDOWN_MS || "10000", 10);  // 10s
const MIN_BYTES_DELTA  = parseInt(process.env.SG_MIN_BYTES_DELTA || "1", 10);  // >=1 Byte reicht
const PANEL_TIMEOUT_MS = parseInt(process.env.SG_PANEL_TIMEOUT_MS || "10000", 10); // 10s
const PANEL_RETRIES    = parseInt(process.env.SG_PANEL_RETRIES || "3", 10);    // bis zu 3 Versuche

const RTMP_STAT_URL  = process.env.SG_STAT_URL   || "http://nginx-rtmp:8080/stat";
const PANEL_BASE     = process.env.SG_PANEL_BASE  || "http://panel-server:4000";

const APPS = new Set(["dennis", "auria", "mobil"]); // überwachte Inputs

let lastBytesIn = new Map();     // key=app:stream -> bytes_in zuletzt
let inactiveStreak = 0;
let currentApp = null;
let currentStreamName = null;
let lastSwitchTs = 0;
let runnerIP = null;

/* ------------------- Shell Helpers ------------------- */

function shCollect(container, cmd) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", container, "sh", "-lc", cmd]);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("exit", (code) => resolve({ code, out: (out || err).trim() }));
  });
}

async function getRunnerIP() {
  if (runnerIP) return runnerIP;
  const { out } = await shCollect(
    "ffmpeg-runner",
    `hostname -I 2>/dev/null | awk '{print $1}' || ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | head -n1`
  );
  runnerIP = (out || "").split(/\s+/)[0] || null;
  if (runnerIP) console.log(`🔎 ffmpeg-runner IP: ${runnerIP}`);
  else console.warn("⚠️ Konnte runner IP nicht ermitteln (Fallback nur via Prozess)");
  return runnerIP;
}

async function getCurrentRelayFromProcess() {
  // gezielt ffmpeg suchen, der /dennis|/auria|/mobil zieht
  const { out } = await shCollect(
    "ffmpeg-runner",
    `ps -eo pid,command | grep -E 'ffmpeg .* -i rtmp://nginx-rtmp:1935/(dennis|auria|mobil)/' | grep -v grep | tail -n1 || true`
  );
  const line = (out || "").trim();
  if (!line) {
    // BRB?
    const brb = await shCollect(
      "ffmpeg-runner",
      `ps -eo pid,command | grep -E 'ffmpeg .* /ffmpeg/brb.mp4' | grep -v grep | tail -n1 || true`
    );
    if ((brb.out || "").trim()) return { mode: "brb" };
    return { mode: "idle" };
  }
  const m = line.match(/rtmp:\/\/nginx-rtmp:1935\/([a-zA-Z0-9_-]+)\/([^\s"']+)/);
  if (m) {
    const app = m[1], stream = m[2];
    if (APPS.has(app)) return { mode: "relay", app, stream };
    return { mode: "other", app, stream };
  }
  return { mode: "unknown", raw: line };
}

/* ------------------- /stat Helpers ------------------- */

async function fetchStat() {
  const res = await axios.get(RTMP_STAT_URL, { timeout: 3000 });
  return xml2js.parseStringPromise(res.data);
}

function findAppNode(stat, appName) {
  const apps = stat?.rtmp?.server?.[0]?.application || [];
  return apps.find(a => a?.name?.[0] === appName) || null;
}

function findStreamNode(stat, appName, streamName) {
  const app = findAppNode(stat, appName);
  if (!app) return null;
  const streams = app?.live?.[0]?.stream || [];
  if (!streams.length) return null;
  if (!streamName) return streams[0];
  return streams.find(s => (s?.name?.[0] || "") === streamName) || null;
}

function hasPublishingClient(streamNode) {
  const clients = streamNode?.client || [];
  return clients.some(c => !!c?.publishing);
}

function getBytesIn(streamNode) {
  const s = streamNode?.bytes_in?.[0];
  if (!s) return null;
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

function runnerIsPlayClientOf(streamNode, ip) {
  if (!ip) return false;
  const clients = streamNode?.client || [];
  return clients.some(c => {
    const addr = c?.address?.[0] || "";
    const isPublisher = !!c?.publishing;
    return addr === ip && !isPublisher; // Puller (unser ffmpeg) ≠ Publisher
  });
}

async function findRelayByRunnerIP(stat) {
  const ip = await getRunnerIP();
  if (!ip) return null;
  for (const app of APPS) {
    const appNode = findAppNode(stat, app);
    const streams = appNode?.live?.[0]?.stream || [];
    for (const s of streams) {
      if (runnerIsPlayClientOf(s, ip)) {
        const name = s?.name?.[0] || null;
        if (name) return { mode: "relay", app, stream: name };
      }
    }
  }
  return null;
}

/* ------------------- Actions ------------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postBRB() {
  let lastErr = null;
  for (let attempt = 1; attempt <= PANEL_RETRIES; attempt++) {
    try {
      await axios.post(`${PANEL_BASE}/stop`, {}, { timeout: PANEL_TIMEOUT_MS });
      console.log(`🟥 FAILOVER → BRB aktiviert (Versuch ${attempt}/${PANEL_RETRIES})`);
      return true;
    } catch (e) {
      lastErr = e;
      console.error(`❌ BRB-Umschaltung fehlgeschlagen (Versuch ${attempt}/${PANEL_RETRIES}): ${e.message}`);
      await sleep(500 * attempt); // kleiner Backoff
    }
  }
  console.error("❌ BRB-Umschaltung endgültig fehlgeschlagen:", lastErr?.message || "unknown error");
  return false;
}

/* ------------------- Main Loop ------------------- */

async function tick() {
  try {
    // 1) Quelle ermitteln
    let relay = await getCurrentRelayFromProcess();

    // Fallback über runner-IP im /stat
    if (relay.mode === "idle" || relay.mode === "unknown" || relay.mode === "other") {
      const st = await fetchStat().catch(() => null);
      if (st) {
        const viaIP = await findRelayByRunnerIP(st);
        if (viaIP) relay = viaIP;
      }
    }

    // Nichts Überwachbares
    if (relay.mode !== "relay" || !APPS.has(relay.app)) {
      inactiveStreak = 0;
      currentApp = null;
      currentStreamName = null;
      console.log(`Ping ... (keine überwachte Quelle aktiv: ${relay.mode})`);
      return;
    }

    // Source/Key-Wechsel -> Reset
    if (relay.app !== currentApp || relay.stream !== currentStreamName) {
      inactiveStreak = 0;
      currentApp = relay.app;
      currentStreamName = relay.stream;
      console.log(`🔎 Überwache jetzt: ${currentApp}/${currentStreamName}`);
    }

    // 2) Stat prüfen: Publisher + bytes_in
    const stat = await fetchStat();
    const node = findStreamNode(stat, currentApp, currentStreamName);

    let isActive = false;
    if (node) {
      const hasPub = hasPublishingClient(node);           // OBS noch dran?
      const key = `${currentApp}:${currentStreamName}`;
      const nowBytes = getBytesIn(node);                  // kumulativ
      const last = lastBytesIn.get(key);
      let delta = null;

      if (nowBytes !== null) {
        if (last !== undefined) delta = nowBytes - last;
        lastBytesIn.set(key, nowBytes);
      }

      // Aktiv-Regel:
      //  - Publisher muss vorhanden sein
      //  - und entweder:
      //     * erster Tick (delta === null), oder
      //     * Counter-Wrap/Reset (delta < 0), oder
      //     * normal steigende Bytes (delta >= MIN_BYTES_DELTA)
      if (hasPub) {
        if (delta === null || delta < 0 || (delta >= MIN_BYTES_DELTA)) {
          isActive = true;
        }
      }

      console.log(
        `Ping ... ${isActive ? "aktiv" : "nicht aktiv"} ` +
        `(publisher=${hasPub ? "ja" : "nein"}, delta=${delta === null ? "n/a" : delta})`
      );
    } else {
      console.log("Ping ... nicht aktiv (stream node fehlt)");
    }

    // 3) Zählen / Umschalten
    if (isActive) {
      inactiveStreak = 0;
      return;
    }

    inactiveStreak += 1;
    const now = Date.now();
    const inCooldown = (now - lastSwitchTs) < COOLDOWN_MS;

    if (!inCooldown && inactiveStreak >= FAIL_THRESHOLD) {
      // Cooldown sofort setzen, damit wir nicht mehrfach spammen,
      // selbst wenn der POST mal länger dauert.
      lastSwitchTs = Date.now();
      inactiveStreak = 0;

      const ok = await postBRB();
      if (!ok) {
        // Beim Fehlschlag den Cooldown nicht zurückdrehen — sonst flappen wir.
        // Nächste Ticks versuchen erneut nach dem Cooldown.
      }
    }
  } catch (e) {
    console.error("tick() Fehler:", e.message);
  }
}

console.log(
  `🛡️  Stream-Guard gestartet: ` +
  `Intervall=${POLL_MS}ms, Threshold=${FAIL_THRESHOLD}x, ` +
  `Cooldown=${COOLDOWN_MS}ms, MinDelta=${MIN_BYTES_DELTA}, ` +
  `PanelTimeout=${PANEL_TIMEOUT_MS}ms, PanelRetries=${PANEL_RETRIES}`
);
setInterval(tick, POLL_MS);
tick();

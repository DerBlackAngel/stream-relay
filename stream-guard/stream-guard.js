// Stream-Guard: Fallback auf BRB, wenn aktive Quelle keinen Publisher mehr hat.
// Pollt alle 2s /stat und /api/current. Bei X Fehl-Ticks → POST /api/switch brb.

const CHECK_MS   = Number(process.env.CHECK_MS || 2000);  // Poll-Intervall
const FAIL_TICKS = Number(process.env.FAIL_TICKS || 4);    // Anzahl Ticks bis Fallback (4*2s=~8s)
const PANEL_URL  = process.env.PANEL_URL  || "http://panel-server:4000";
const STAT_URL   = process.env.STAT_URL   || "http://nginx-rtmp:18080/stat";

// Beobachtete Apps (Reihenfolge wichtig nur fürs Logging)
const WATCH = (process.env.WATCH || "dennis,auria,mobil")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const fetchOpts = { method: "GET" };

function ts() {
  return new Date().toISOString().replace("T"," ").replace(/\..+/, "");
}

function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
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

async function getStat() {
  const r = await fetch(STAT_URL, fetchOpts);
  if (!r.ok) throw new Error(`/stat ${r.status}`);
  const xml = await r.text();
  const apps = parseApplications(xml);
  return apps;
}

async function getCurrent() {
  const r = await fetch(`${PANEL_URL}/api/current`, fetchOpts);
  if (!r.ok) throw new Error(`/api/current ${r.status}`);
  const j = await r.json();
  // { ok:true, mode: "...", cmd?: "..." }
  return j.mode || "idle";
}

async function switchToBRB() {
  const r = await fetch(`${PANEL_URL}/api/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "brb" })
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`/api/switch brb failed: ${r.status} ${t}`);
  }
}

let failTicks = 0;
let lastMode = "idle";
let cooldownUntil = 0; // ms epoch, um mehrfach-Triggers zu vermeiden

async function tick() {
  try {
    const now = Date.now();
    const mode = await getCurrent(); // brb|dennis|auria|mobil|idle|unknown
    const apps = await getStat();

    // Fürs Log:
    if (mode !== lastMode) {
      console.log(`[${ts()}] [guard] mode=${mode}`);
      lastMode = mode;
      failTicks = 0; // Reset bei Moduswechsel
    }

    // Nur reagieren, wenn eine Live-Quelle aktiv gepusht wird
    if (mode === "dennis" || mode === "auria" || mode === "mobil") {
      const app = apps[mode] || { publisher: false };
      if (app.publisher) {
        failTicks = 0; // gesund
      } else {
        failTicks++;
        console.log(`[${ts()}] [guard] ${mode} publisher=false  (tick ${failTicks}/${FAIL_TICKS})`);
        if (failTicks >= FAIL_TICKS) {
          if (now < cooldownUntil) {
            // noch Cooldown – nichts tun
          } else {
            console.log(`[${ts()}] [guard] Fallback → BRB (mode=${mode})`);
            await switchToBRB();
            // 10s Cooldown, damit kein Ping-Pong
            cooldownUntil = Date.now() + 10_000;
            failTicks = 0;
          }
        }
      }
    } else {
      // BRB/idle/unknown → nichts zu tun
      failTicks = 0;
    }
  } catch (e) {
    console.error(`[${ts()}] [guard] ERROR:`, e.message || e);
  }
}

console.log(`[${ts()}] [guard] start CHECK_MS=${CHECK_MS} FAIL_TICKS=${FAIL_TICKS} PANEL_URL=${PANEL_URL} STAT_URL=${STAT_URL} WATCH=${WATCH.join(",")}`);
setInterval(tick, CHECK_MS);
tick(); // sofort einmal

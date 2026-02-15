/* eslint-disable no-console */
"use strict";

/**
 * Stream-Guard v4.10 — Sticky BRB, Auto-Resume nur auf letzte Quelle, STOP bleibt STOP
 *
 * Fix:
 * - Auto-Resume wird standardmäßig NUR bei "brb" gemacht.
 * - "idle" gilt als manuell gestoppt (STOP Button) und startet NICHT automatisch neu.
 *
 * Steuerung:
 * - GUARD_AUTO_RESUME=true/false (wie bisher)
 * - GUARD_RESUME_ONLY_LAST=true/false (Default true)
 * - GUARD_RESUME_FROM_IDLE=true/false (neu, Default false)
 */

const STAT_URL = envStr(process.env.STAT_URL, "http://nginx-rtmp:18080/stat");
const PANEL_BASE_URL = envStr(process.env.PANEL_BASE_URL, "http://host.docker.internal:8080");
const HTTP_TIMEOUT_MS = intEnv(process.env.HTTP_TIMEOUT_MS, 4000);

const GUARD_POLL_MS = intEnv(process.env.GUARD_POLL_MS, 5000);
const GUARD_INACTIVE_THRESHOLD = intEnv(process.env.GUARD_INACTIVE_THRESHOLD, 3);
const GUARD_MIN_DELTA_BYTES = intEnv(process.env.GUARD_MIN_DELTA_BYTES, 40000);

const GUARD_AUTO_RESUME = boolEnv(process.env.GUARD_AUTO_RESUME, true);
const GUARD_RESUME_STABLE_MS = intEnv(process.env.GUARD_RESUME_STABLE_MS, 5000);
const GUARD_RESUME_COOLDOWN_MS = intEnv(process.env.GUARD_RESUME_COOLDOWN_MS, 60000);

// Default so wie du es willst:
const GUARD_RESUME_ONLY_LAST = boolEnv(process.env.GUARD_RESUME_ONLY_LAST, true);

// Neu: Idle NICHT auto-resumen (STOP bleibt STOP)
const GUARD_RESUME_FROM_IDLE = boolEnv(process.env.GUARD_RESUME_FROM_IDLE, false);

const GUARD_DEBUG = boolEnv(process.env.GUARD_DEBUG, false);

const SOURCES = ["dennis", "auria", "mobil"];
const BRB_MODE = "brb";

const PANEL_USER = envStr(process.env.PANEL_USER, null);
const PANEL_PASS = envStr(process.env.PANEL_PASS, null);
const BASIC_AUTH =
  PANEL_USER && PANEL_PASS
    ? "Basic " + Buffer.from(`${PANEL_USER}:${PANEL_PASS}`).toString("base64")
    : null;

let lastBytes = Object.fromEntries(SOURCES.map((s) => [s, 0]));
let resumeCounters = Object.fromEntries(SOURCES.map((s) => [s, 0]));
let inactiveCount = 0;

// letzte aktive Quelle
let lastSelected = null;

let lastResumeAt = 0;
let warnedAuth = false;

log(
  `🛡️ Stream-Guard gestartet: Intervall=${GUARD_POLL_MS}ms, Threshold=${GUARD_INACTIVE_THRESHOLD}x, MinDelta=${GUARD_MIN_DELTA_BYTES}, AutoResume=${GUARD_AUTO_RESUME}, ResumeOnlyLast=${GUARD_RESUME_ONLY_LAST}, ResumeFromIdle=${GUARD_RESUME_FROM_IDLE}, Stable=${GUARD_RESUME_STABLE_MS}ms, Cooldown=${GUARD_RESUME_COOLDOWN_MS}ms`
);

init().then(() => {
  setInterval(() => {
    tick().catch((e) => log("! tick error:", e?.message || e));
  }, GUARD_POLL_MS);
});

async function init() {
  const cur = await getCurrentMode();
  if (SOURCES.includes(cur)) lastSelected = cur;
  log(`ℹ️ Initial mode = ${cur || "unknown"}, lastSelected = ${lastSelected || "-"}`);
}

async function tick() {
  // 1) RTMP-Stat einlesen und pro Quelle pub/delta berechnen
  const xml = await fetchText(STAT_URL);
  const pub = {}, delta = {}, sum = {};

  for (const s of SOURCES) {
    const { publisher, bytesSum } = parseApplication(xml, s);
    const d = Math.max(0, bytesSum - (lastBytes[s] || 0));
    lastBytes[s] = bytesSum;
    pub[s] = !!publisher;
    delta[s] = d;
    sum[s] = bytesSum;
  }

  // 2) Panel-Zustand
  const mode = await getCurrentMode();

  if (GUARD_DEBUG) {
    const line = SOURCES.map((s) => `${s}{pub:${pub[s] ? 1 : 0},d:${delta[s]},Σ:${sum[s]}}`).join(" ");
    log("DBG:", `mode=${mode}`, line, `lastSelected=${lastSelected || "-"}`);
  }

  // 3) Wenn aktive Quelle: "lebendig" nur wenn Publisher && Delta >= MinDelta
  if (SOURCES.includes(mode)) {
    lastSelected = mode;

    const aliveActive = pub[mode] && delta[mode] >= GUARD_MIN_DELTA_BYTES;

    if (aliveActive) {
      inactiveCount = 0;
    } else {
      inactiveCount++;
      log(`… ${mode} scheint tot (${inactiveCount}/${GUARD_INACTIVE_THRESHOLD}) [pub=${pub[mode] ? 1 : 0}, delta=${delta[mode]}]`);
      if (inactiveCount >= GUARD_INACTIVE_THRESHOLD) {
        await switchTo("brb", `inactive_${mode}_${inactiveCount}x`);
        inactiveCount = 0;
      }
    }

    for (const s of SOURCES) resumeCounters[s] = 0;
    return;
  }

  // 4) STOP soll STOP bleiben: bei idle standardmäßig KEIN Auto-Resume
  if (mode === "idle" && !GUARD_RESUME_FROM_IDLE) {
    for (const s of SOURCES) resumeCounters[s] = 0;
    inactiveCount = 0;
    return;
  }

  // 5) Auto-Resume (nur BRB, optional idle wenn GUARD_RESUME_FROM_IDLE=true)
  const canResumeHere =
    (mode === BRB_MODE) ||
    (mode === "idle" && GUARD_RESUME_FROM_IDLE);

  if (canResumeHere && GUARD_AUTO_RESUME) {
    const now = Date.now();
    if (now - lastResumeAt < GUARD_RESUME_COOLDOWN_MS) return;

    for (const s of SOURCES) {
      const aliveForResume = pub[s] || delta[s] >= GUARD_MIN_DELTA_BYTES;
      resumeCounters[s] = aliveForResume ? resumeCounters[s] + 1 : 0;
    }

    const needed = Math.max(1, Math.ceil(GUARD_RESUME_STABLE_MS / GUARD_POLL_MS));

    let candidate = null;

    if (GUARD_RESUME_ONLY_LAST) {
      if (lastSelected && resumeCounters[lastSelected] >= needed) candidate = lastSelected;
    } else {
      const order = lastSelected ? [lastSelected, ...SOURCES.filter((x) => x !== lastSelected)] : [...SOURCES];
      for (const s of order) {
        if (resumeCounters[s] >= needed) { candidate = s; break; }
      }
    }

    if (candidate) {
      await switchTo(candidate, `auto_resume_${candidate}_${resumeCounters[candidate]}x`);
      lastResumeAt = now;
      for (const k of SOURCES) resumeCounters[k] = 0;
    }
    return;
  }

  // 6) Unbekannter Modus
  for (const s of SOURCES) resumeCounters[s] = 0;
  inactiveCount = 0;
}

/* ----------------- Panel (mit stillen Fallbacks) ----------------- */

function commonHeaders(json = false) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  h["Accept"] = "application/json";
  if (BASIC_AUTH) h["Authorization"] = BASIC_AUTH;
  return h;
}
function panelCandidates() {
  return Array.from(
    new Set([PANEL_BASE_URL, "http://host.docker.internal:8080", "http://panel-server:8080", "http://panel:8080"].filter(Boolean))
  );
}
async function getCurrentMode() {
  const errs = [];
  for (const base of panelCandidates()) {
    try {
      const res = await fetchWithTimeout(`${base}/api/current`, { method: "GET", headers: commonHeaders(false) }, HTTP_TIMEOUT_MS);
      if (!res.ok) {
        const body = await safeText(res);
        if (res.status === 401 || res.status === 403) warnOnceAuth(res.status, body);
        errs.push(`GET ${base}/api/current -> HTTP ${res.status}`);
        continue;
      }
      const j = await res.json().catch(() => ({}));
      return j?.mode || "unknown";
    } catch (e) {
      errs.push(`GET ${base}/api/current -> ${e?.message || e}`);
    }
  }
  log("! Panel unreachable:", errs.join(" | "));
  return "unknown";
}
async function switchTo(target, reason) {
  const errs = [];
  for (const base of panelCandidates()) {
    try {
      const res = await fetchWithTimeout(
        `${base}/api/switch`,
        { method: "POST", headers: commonHeaders(true), body: JSON.stringify({ source: target, reason: `guard:${reason}` }) },
        HTTP_TIMEOUT_MS
      );
      const ok = res.ok;
      const j = await res.json().catch(() => ({}));
      if (!ok) {
        errs.push(`POST ${base}/api/switch -> HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
        continue;
      }
      log(`→ switch ${target} (${reason})`, j?.ok ? "ok" : "", `via ${base}`);
      return;
    } catch (e) {
      errs.push(`POST ${base}/api/switch -> ${e?.message || e}`);
    }
  }
  log("! switch failed:", errs.join(" | "));
}
function warnOnceAuth(status, body) {
  if (warnedAuth) return;
  if (status === 401 || status === 403) {
    warnedAuth = true;
    log(`! Panel-Auth nötig (HTTP ${status}). Setze PANEL_USER/PANEL_PASS für den Guard.`, body ? `Body: ${String(body).slice(0, 120)}` : "");
  }
}

/* ----------------- HTTP utils ----------------- */

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { method: "GET" }, HTTP_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/* ----------------- XML-Parsing (beide Varianten) ----------------- */

function parseApplication(xml, appName) {
  const reAttr = new RegExp(`<application\\s+name="${escapeRe(appName)}">([\\s\\S]*?)<\\/application>`, "i");
  let m = xml.match(reAttr);
  if (m) return parseAppBlock(m[1]);

  const reAnyApp = /<application>([\s\S]*?)<\/application>/gi;
  let g;
  while ((g = reAnyApp.exec(xml))) {
    const block = g[1];
    const nameMatch = block.match(/<name>\s*([^<]+)\s*<\/name>/i);
    if (nameMatch && nameMatch[1].trim().toLowerCase() === appName.toLowerCase()) return parseAppBlock(block);
  }
  return { publisher: false, bytesSum: 0 };
}

function parseAppBlock(block) {
  const hasPublisher =
    /<publisher>/i.test(block) ||
    /<active\/>/i.test(block) ||
    /<publishing\/>/i.test(block) ||
    /<publishing\s*\/\s*>/i.test(block) ||
    /<nclients>\s*[1-9]/i.test(block);

  let bytesSum = 0;
  const it = block.matchAll(/<bytes_in>(\d+)<\/bytes_in>/gi);
  for (const g of it) bytesSum += parseInt(g[1], 10);
  return { publisher: hasPublisher, bytesSum };
}

/* ----------------- misc utils ----------------- */

function escapeRe(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}
function intEnv(v, d) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
}
function boolEnv(v, dflt) {
  if (v == null) return dflt;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return dflt;
}
function envStr(v, d) {
  if (v == null) return d;
  const s = String(v).trim();
  return s.length ? s : d;
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}


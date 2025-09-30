// Publish-Auth-Server für nginx-rtmp
// - Endpunkte: /auth?app=...&name=...  UND  /auth/:app
// - Nur ENV-Keys (keine Fallbacks). Fehlende Keys => DENY (403).
// - 200 = erlaubt, 403 = blockiert

const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// NUR ENV – keine Fallbacks!
const ALLOWED_KEYS = {
  dennis: process.env.DENNIS,
  auria:  process.env.AURIA,
  mobil:  process.env.MOBIL,
};

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim().length > 0) return String(v).trim();
  }
  return "";
}

function handleAuth(req, res, forcedApp = "") {
  const p = { ...req.query, ...req.body };
  const call = (pick(p.call) || "publish").toLowerCase();
  const appName = (forcedApp || pick(p.app)).toLowerCase();
  const streamKey = pick(p.name, p.stream);
  const addr = String(p.addr || req.ip || "").replace("::ffff:", "");

  if (call !== "publish") return res.status(200).send("OK");

  const expected = ALLOWED_KEYS[appName];
  console.log(`[AUTH] call=${call} app=${appName||"-"} from=${addr} ${expected ? "candidate" : "unknown-app"}`);

  if (!expected || streamKey !== expected) {
    console.warn(`[AUTH] DENY app=${appName||"-"} from=${addr} reason=${!expected ? "no_key_configured" : "bad_key"}`);
    return res.status(403).send("FORBIDDEN");
  }

  console.log(`[AUTH] ALLOW app=${appName} from=${addr}`);
  return res.status(200).send("OK");
}

app.get("/health", (_req, res) => res.status(200).json({ ok: true, service: "auth-server" }));
app.all("/auth", (req, res) => handleAuth(req, res));                 // /auth?app=...&name=...
app.all("/auth/:app", (req, res) => handleAuth(req, res, req.params.app)); // /auth/dennis

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Auth-Server listening on :${PORT}`));

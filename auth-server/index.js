const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "auth-server" });
});

/**
 * NGINX-RTMP Hooks (allow-all)
 * Viele Configs nutzen on_publish (oder on_play, on_done usw.).
 * Solange wir debuggen, geben wir IMMER 200 zurück, damit OBS connecten darf.
 * Später bauen wir hier echte Prüfungen (Token, App-Name, IP-Whitelist, etc.).
 */
const ok = (req, res) => {
  console.log(`[RTMP-HOOK] ${req.path} ${req.method} query=`, req.query, " body=", req.body);
  res.status(200).send("OK");
};

app.all("/auth", ok);
app.all("/on_publish", ok);
app.all("/on_done", ok);
app.all("/on_play", ok);
app.all("/on_publish_done", ok);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ auth-server läuft auf Port ${PORT}`);
});

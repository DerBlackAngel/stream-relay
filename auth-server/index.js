const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "auth-server" });
});

// Allow-all Handler (zum Debuggen; gibt immer 200 zurück)
const ok = (req, res) => {
  console.log(`[RTMP-HOOK] ${req.method} ${req.originalUrl} | query=`, req.query, "| body=", req.body);
  res.status(200).send("OK");
};

// Wichtig: alle Varianten matchen – exakt wie NGINX aufruft
app.all(/^\/auth(\/.*)?$/, ok);          // /auth  und /auth/dennis  /auth/auria ...
app.all("/on_publish", ok);
app.all("/on_done", ok);
app.all("/on_play", ok);
app.all("/on_publish_done", ok);
app.all("/on_play_done", ok);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ auth-server läuft auf Port ${PORT}`);
});

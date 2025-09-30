#!/usr/bin/env bash
set -euo pipefail

cd /opt/stream-relay

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  COMPOSE="docker compose"
fi
echo "🧭 Verwende Compose: $COMPOSE"

echo "🧹 Stoppe alle laufenden Container..."
$COMPOSE down || true

# Zusätzlicher „Einmalcontainer“ für Twitch-Push
echo "🛑 Stoppe twitch-push (falls läuft)..."
docker rm -f twitch-push 2>/dev/null || true

echo "🗑️  Entferne alte Container..."
docker container prune -f >/dev/null || true

echo "🗑️  Entferne alte Volumes..."
docker volume prune -f >/dev/null || true

echo "🛠️  Baue alle Services neu..."
$COMPOSE build --no-cache

echo "🚀 Starte alle Container neu im Hintergrund..."
$COMPOSE up -d

echo "📋 Status (docker ps):"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

echo "✅ Bereinigung abgeschlossen & Container neu gestartet!"

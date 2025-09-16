#!/usr/bin/env bash
set -Eeuo pipefail

# Finde den richtigen Compose-Befehl (Plugin oder v1)
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Weder 'docker compose' noch 'docker-compose' gefunden."
  echo "   Installiere entweder das Docker Compose Plugin oder docker-compose v1."
  exit 1
fi

echo "🧭 Verwende Compose: $COMPOSE_CMD"

echo "🧹 Stoppe alle laufenden Container..."
$COMPOSE_CMD down --remove-orphans || true

echo "🗑️  Entferne alte Container..."
docker container prune -f || true

echo "🗑️  Entferne alte Volumes..."
docker volume prune -f || true

echo "🛠️  Baue alle Services neu..."
# Falls eine ältere Compose-Version --pull nicht kennt, fällt es auf einfachen build zurück
$COMPOSE_CMD build --pull || $COMPOSE_CMD build

echo "🚀 Starte alle Container neu im Hintergrund..."
$COMPOSE_CMD up -d --remove-orphans

echo "📋 Status (docker ps):"
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

echo "✅ Bereinigung abgeschlossen & Container neu gestartet!"

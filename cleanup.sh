#!/bin/bash

echo "🧹 Stoppe alle laufenden Container..."
docker-compose down

echo "🗑️ Entferne alte Container..."
docker container prune -f

echo "🗑️ Entferne alte Volumes..."
docker volume prune -f

echo "🛠️ Baue alle Services neu..."
docker-compose build

echo "🚀 Starte alle Container neu im Hintergrund..."
docker-compose up -d

echo "✅ Bereinigung abgeschlossen & Container neu gestartet!"
#test

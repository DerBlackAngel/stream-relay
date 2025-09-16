FROM node:20-alpine

# Root nötig für Zugriff auf /var/run/docker.sock
USER root
# Docker-CLI, damit wir aus dem Guard "docker exec ..." aufrufen können
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY stream-guard.js ./stream-guard.js

CMD ["node", "stream-guard.js"]

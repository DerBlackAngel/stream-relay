FROM node:20-alpine

# Als root arbeiten, damit /var/run/docker.sock genutzt werden kann
USER root

# Docker-CLI für "docker exec ..." installieren
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./index.js
COPY public ./public

EXPOSE 4000
CMD ["node", "index.js"]

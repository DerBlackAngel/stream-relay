FROM node:18

# Docker CLI installieren
RUN apt-get update && \
    apt-get install -y docker.io

# Arbeitsverzeichnis
WORKDIR /app

# Dateien kopieren
COPY . .

# Abhängigkeiten installieren
RUN npm install

# App starten
CMD ["node", "index.js"]

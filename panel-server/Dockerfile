FROM node:18

# 🔧 Docker CLI installieren
RUN apt update && apt install -y docker.io

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "index.js"]

FROM node:20-alpine
WORKDIR /app

# Docker-CLI für "docker exec" (wir mounten ja /var/run/docker.sock vom Host)
RUN apk add --no-cache docker-cli

# App-Dependencies
COPY package.json ./
RUN if [ -f package-lock.json ]; then \
      echo "Using npm ci" && npm ci --omit=dev; \
    else \
      echo "Using npm install" && npm install --omit=dev; \
    fi

# App-Code
COPY index.js .
COPY public ./public

EXPOSE 4000
CMD ["node","index.js"]

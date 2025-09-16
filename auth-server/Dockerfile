FROM node:20-alpine
WORKDIR /app

# package.json separat kopieren für besseren Build-Cache
COPY package.json ./

# Wenn package-lock.json existiert -> npm ci, sonst npm install
RUN if [ -f package-lock.json ]; then \
      echo "Using npm ci" && npm ci --omit=dev; \
    else \
      echo "Using npm install" && npm install --omit=dev; \
    fi

# App-Code
COPY index.js .
EXPOSE 3000
CMD ["node","index.js"]

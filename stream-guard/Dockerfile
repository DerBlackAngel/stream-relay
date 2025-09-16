FROM node:20-alpine

USER root
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY stream-guard.js ./stream-guard.js

EXPOSE 4100
CMD ["node", "stream-guard.js"]

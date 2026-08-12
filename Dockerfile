# Gebetszeiten Weltweit - Production Dockerfile
# Pin auf Node 20 (LTS) weil better-sqlite3@11 keine prebuilt binaries
# für Node 24 hat. bookworm-slim (Debian) statt alpine, weil glibc
# kompatibler mit better-sqlite3 prebuilds ist.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json* ./

# Fallback zu npm install falls lock out of sync
RUN npm ci --omit=dev --include=optional --no-audit --no-fund \
    || npm install --omit=dev --include=optional --no-audit --no-fund

COPY server.js ./
COPY public ./public
COPY igmg-calc.mjs ./

# Persistenzverzeichnis für SQLite-API-Keys
# (in Dokploy MUSS ein Volume auf /app/data gemountet werden)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]

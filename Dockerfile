# Gebetszeiten Weltweit - Production Dockerfile (v2: fully local, no Appwrite/IGMG dependency)
# Pin auf Node 20 (LTS) weil better-sqlite3@11 keine prebuilt binaries
# für Node 24 hat. bookworm-slim (Debian) statt alpine, weil glibc
# kompatibler mit better-sqlite3 prebuilds ist.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PORT=3000

WORKDIR /app

# Erst package files für besseres Docker-Layer-Caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --include=optional --no-audit --no-fund \
    || npm install --omit=dev --include=optional --no-audit --no-fund

# App-Code + gebündelte Städte
COPY server.js ./
COPY igmg-calc.mjs ./
COPY public ./public
COPY data/cities.json ./data/cities.json

# Persistenzverzeichnis für SQLite (API keys + custom cities)
# In Dokploy MUSS ein Volume auf /app/data gemountet werden,
# sonst gehen API-Keys + custom cities bei Container-Restart verloren.
# cities.json wird vom Image gemountet, ist read-only;
# SQLite-Datei (api_keys.db) wird im Volume persistiert.
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]

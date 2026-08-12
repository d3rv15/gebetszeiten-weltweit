# Gebetszeiten Weltweit - Production Dockerfile (v2: fully local, no Appwrite/IGMG dependency)
# Pin auf Node 20 (LTS) weil better-sqlite3@11 keine prebuilt binaries
# für Node 24 hat. bookworm-slim (Debian) statt alpine, weil glibc
# kompatibler mit better-sqlite3 prebuilds ist.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PORT=3000

WORKDIR /app

# Build tools needed if better-sqlite3 has to compile from source
# (prebuilds usually work for Node 20 / x64 / linux, but we add this as fallback)
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Erst package files für besseres Docker-Layer-Caching
COPY package.json package-lock.json* ./
# Retry logic: prefer prebuilt binaries, fall back to source build
RUN npm ci --omit=dev --include=optional --no-audit --no-fund \
    || (echo "npm ci failed, retrying with npm install" && npm install --omit=dev --include=optional --no-audit --no-fund) \
    || (echo "retrying with build-from-source" && npm rebuild better-sqlite3 --build-from-source)

# App-Code + gebündelte Städte
COPY server.js ./
COPY igmg-calc.mjs ./
COPY public ./public
# cities.json + hadith.json + seferi.json in /app/ (nicht /app/data/ - das wird vom Volume überschattet)
COPY data/cities.json ./cities.json
COPY data/hadith.json ./hadith.json
COPY data/seferi.json ./seferi.json

# Persistenzverzeichnis für SQLite (API keys + custom cities)
# In Dokploy MUSS ein Volume auf /app/data gemountet werden,
# sonst gehen API-Keys + custom cities bei Container-Restart verloren.
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]

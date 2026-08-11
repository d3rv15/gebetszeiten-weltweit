# Gebetszeiten Weltweit

Web-App + JSON-API für weltweite Gebetszeiten (Daten aus IGMG, gespeichert in Appwrite).

## Features
- 🌐 331 deutsche Städte + 434 Weltstädte
- 📅 Gebetszeiten für aktuelle + 29 Tage im Voraus
- 🔑 Eigene API-Key-Verwaltung
- 📡 JSON-API mit/ohne Auth

## Live
- Web-UI: https://salah.chargedesk.de
- API: https://salah.chargedesk.de/api/...

## Lokal testen
```bash
npm install
node server.js
# → http://localhost:3000
```

## Deploy (Dokploy)
- Build-Provider: **Nixpacks** mit `nixpacks.toml` (Node 20-Pin wegen better-sqlite3)
- Port: 3000
- Domain: https://salah.chargedesk.de (letsencrypt)
- Wichtig: Docker-Volume auf `/app/data` mounten, sonst gehen API-Keys bei jedem Restart verloren

### Alternative: Dockerfile-Modus
Das mitgelieferte `Dockerfile` funktioniert auch (Node 20-bookworm-slim). In Dokploy den Provider auf "Dockerfile" umstellen.

## API-Endpoints
| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | – | Health check + Cities-Cache-Info |
| GET | `/api/cities?country=DE` | – | Städteliste (filter `country=DE`, Suche `q=...`) |
| GET | `/api/times?city=20166&date=2026-01-01` | – | Gebetszeiten |
| GET | `/api/times/month?city=20166&year=2026&month=1` | – | Monatsübersicht |
| GET | `/api/v1/times?city=20166` | API-Key | Auth-Version mit Key-Info |
| GET | `/api/v1/times/month?city=20166&year=2026&month=1` | API-Key | Auth Monatsübersicht |
| POST | `/api/keys` | – | Neuen Key erstellen (Body: `{name}`) |
| GET | `/api/keys` | – | Liste aller Keys |
| POST | `/api/keys/:id/disable` | – | Key deaktivieren |
| DELETE | `/api/keys/:id` | – | Key löschen |

## Bekannte Einschränkungen / Roadmap
- Aktuell nur Offenbach (Stadt-ID 20166) hat Gebetszeiten in `prayer_times_data` (25 Tage im Jan 2026). Daten-Sync für alle 765 Städte läuft.
- Koordinaten (lat/lng/timezone) für die Städte fehlen noch. Werden via Open-Meteo Geocoding API nachgeladen.
- Appwrite-Key liegt aktuell hardcoded in `server.js` — sollte in Phase 5 in eine env-var verschoben und rotiert werden.

## Build-Hinweise
Der Build nutzt `nixpacks.toml` mit Node 20-Pin. **Wichtig:** better-sqlite3@11 hat keine prebuilt binaries für Node 24, daher MUSS Node 20 erzwungen werden. `nixpacks.toml` macht das automatisch. Falls Nixpacks die Datei ignoriert, in Dokploy unter Environment die Variable `NIXPACKS_NODE_VERSION=20` setzen.

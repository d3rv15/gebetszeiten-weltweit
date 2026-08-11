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
- Health: https://salah.chargedesk.de/health

## Lokal testen
```bash
npm install
node server.js
# → http://localhost:3000
```

## Deploy (Dokploy)
- **Build-Provider: Dockerfile** (nicht Nixpacks! Der hat einen Bug mit Multi-Pkg-Listen)
- `Dockerfile` im Repo: Node 20-bookworm-slim (mit glibc + python3 + make/g++ als Fallback)
- Port: 3000
- Domain: https://salah.chargedesk.de (letsencrypt via Traefik)
- **Wichtig:** Docker-Volume auf `/app/data` mounten, sonst gehen API-Keys bei jedem Restart verloren

### Nixpacks vs Dockerfile
Nixpacks 1.40 / 1.41 hat einen Bug, der bei `nixPkgs = ["a", "b", "c"]` fehlerhaftes Nix-Syntax generiert
(Strings werden ohne Anführungszeichen serialisiert, was Nix als Variablen-Referenzen interpretiert).
Workaround: `Dockerfile` direkt verwenden (Provider in Dokploy auf "Dockerfile" stellen).

## API-Endpoints
| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | – | Health check + Cities-Cache-Info |
| GET | `/api/cities?country=DE` | – | Städte (Filter `country=DE`, Suche `q=...`) |
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
- Appwrite-Key liegt aktuell hardcoded in `server.js` — sollte rotiert + in env-var verschoben werden (Phase 5).

## Docker-Image
Image: `gebetszeiten-weltweit:latest` (224 MB, Node 20-bookworm-slim, ~10s Build)
```bash
docker run -d --name gebetszeiten --restart unless-stopped \
  -p 3000:3000 \
  -v gebetszeiten-data:/app/data \
  gebetszeiten-weltweit:latest
```

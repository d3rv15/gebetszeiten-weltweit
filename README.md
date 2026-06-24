# Gebetszeiten Weltweit

Web-App + JSON-API für weltweite Gebetszeiten (Daten aus IGMG, gespeichert in Appwrite).

## Features
- 🌐 331 deutsche Städte + 434 Weltstädte
- 📅 Gebetszeiten für aktuelle + 29 Tage im Voraus
- 🔑 Eigene API-Key-Verwaltung
- 📡 JSON-API mit/ohne Auth

## Lokal testen
```bash
npm install
node server.js
# → http://localhost:3000
```

## Deploy
- `Dockerfile` vorhanden
- Auf Dokploy: neues Projekt → "Gebetszeiten weltweit" → Git-Repo oder Source-Upload → Port 3000

## API-Endpoints
| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | – | Health check |
| GET | `/api/cities?country=DE` | – | Städteliste |
| GET | `/api/times?city=20166&date=2026-06-25` | – | Gebetszeiten |
| GET | `/api/v1/times?city=20166` | API-Key | Auth-Version mit Key-Info |
| POST | `/api/keys` | – | Neuen Key erstellen |
| GET | `/api/keys` | – | Liste aller Keys |
| POST | `/api/keys/:id/disable` | – | Key deaktivieren |
| DELETE | `/api/keys/:id` | – | Key löschen |

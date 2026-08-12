// Gebetszeiten Weltweit - Server
// Lädt Gebetszeiten aus Appwrite, bietet Web-UI und JSON-API mit API-Key-Auth

const express = require('express');
const path = require('path');
const { Client, Databases, Query } = require('node-appwrite');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3100;
const APPWRITE_ENDPOINT = 'https://appwrite.chargedesk.de/v1';
const APPWRITE_PROJECT = '6a20bfcd000e9e4ca544';
const APPWRITE_KEY = 'standard_5488355d4db980c24f54ce630c1dcc192cc863b88a148ce9d09b8d76550d6bbe0445038422419d5bb3c8f10f05f0b08e78e74fb1a765b9f5cddeed045e64917e01ed5e979dbaffc48e53bddc0ef8bfc406f8fb0c97637d792fd651e072c10879b5b12c1ecc27e1246af2488dff8e52be9c63e8c934999a1e6b7d217bb6588484';
const DB_ID = 'igmg';
const CITIES_COLL = 'cities2';
const PRAYERS_COLL = 'prayer_times_data';

const log = (...args) => console.log('[gebetszeiten]', ...args);
const logErr = (...args) => console.error('[gebetszeiten][ERROR]', ...args);

// Appwrite client
const appwrite = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT)
  .setKey(APPWRITE_KEY);
const databases = new Databases(appwrite);

// SQLite for API keys
const sqlite = new Database(path.join(__dirname, 'data', 'api_keys.db'));
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used TEXT,
    requests INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
  )
`);
const stmtCreate = sqlite.prepare('INSERT INTO api_keys (id, name) VALUES (?, ?)');
const stmtList = sqlite.prepare('SELECT * FROM api_keys ORDER BY created_at DESC');
const stmtGet = sqlite.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1');
const stmtUpdate = sqlite.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, requests = requests + 1 WHERE id = ?');
const stmtDisable = sqlite.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?');
const stmtDelete = sqlite.prepare('DELETE FROM api_keys WHERE id = ?');

// Cache cities in memory
let citiesCache = null;
let citiesCacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCities() {
  const now = Date.now();
  if (citiesCache && now - citiesCacheTime < CACHE_TTL_MS) {
    return citiesCache;
  }
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const resp = await databases.listDocuments(DB_ID, CITIES_COLL, [Query.limit(limit), Query.offset(offset)]);
    all.push(...resp.documents);
    if (resp.documents.length < limit) break;
    offset += limit;
  }
  citiesCache = all.map(d => ({
    id: d.igmg_id || d.$id,
    name: d.name,
    country: d.country,
  }));
  citiesCacheTime = now;
  return citiesCache;
}

async function getPrayerTimes(cityId, date) {
  const queries = [Query.equal('city_igmg_id', cityId), Query.limit(1)];
  if (date) queries.push(Query.equal('date', date));
  const resp = await databases.listDocuments(DB_ID, PRAYERS_COLL, queries);
  return resp.documents.map(d => ({
    date: d.date,
    imsak: d.imsak, sunrise: d.sunrise, dhuhr: d.dhuhr,
    asr: d.asr, maghrib: d.maghrib, isha: d.isha,
    source: d.source,
  }));
}

// API-Key auth middleware
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key required. Pass via X-Api-Key header or ?api_key=... query param.' });
  const row = stmtGet.get(key);
  if (!row) return res.status(401).json({ error: 'Invalid or disabled API key.' });
  stmtUpdate.run(key);
  req.apiKey = row;
  next();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ PUBLIC ROUTES ============

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gebetszeiten-weltweit', cities: citiesCache?.length || 0 });
});

// List cities (no auth, public for the dropdown in UI)
app.get('/api/cities', async (req, res) => {
  try {
    const cities = await getCities();
    const country = req.query.country?.toUpperCase();
    const search = req.query.q?.toLowerCase();
    let filtered = cities;
    if (country) filtered = filtered.filter(c => c.country === country);
    if (search) {
      // Diacritic-insensitive: 'münchen' / 'munich' / 'MUNCHEN' all match
      const normalize = (s) => s
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/ı/g, 'i')   // Turkish dotless i
        .replace(/İ/g, 'i')   // Turkish dotted I
        .replace(/ß/g, 'ss')  // German sharp s
        .replace(/ø/g, 'o')   // Nordic
        .replace(/æ/g, 'ae');
      const needle = normalize(search);
      filtered = filtered.filter(c => normalize(c.name).includes(needle));
    }
    res.json({ total: filtered.length, cities: filtered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get prayer times for a city on a date (no auth for web UI)
app.get('/api/times', async (req, res) => {
  try {
    const { city, date } = req.query;
    if (!city) return res.status(400).json({ error: 'city parameter required (igmg_id)' });
    const times = await getPrayerTimes(city, date);
    if (!times.length) return res.status(404).json({ error: 'No data for this city/date' });
    res.json({ city, date: date || times[0].date, times: times[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a month of prayer times for a city (e.g. for kiosk calendar view)
app.get('/api/times/month', async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city || !year || !month) {
      return res.status(400).json({ error: 'city, year, month required' });
    }
    const y = parseInt(year), m = parseInt(month);
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'year must be int, month 1-12' });
    }
    const daysInMonth = new Date(y, m, 0).getDate();
    const queries = [
      Query.equal('city_igmg_id', city),
      Query.greaterThanEqual('date', `${y}-${String(m).padStart(2, '0')}-01`),
      Query.lessThanEqual('date', `${y}-${String(m).padStart(2, '0')}-${daysInMonth}`),
      Query.limit(31),
      Query.orderAsc('date'),
    ];
    const resp = await databases.listDocuments(DB_ID, PRAYERS_COLL, queries);
    res.json({
      city,
      year: y,
      month: m,
      days: resp.documents.map(d => ({
        date: d.date,
        imsak: d.imsak, sunrise: d.sunrise, dhuhr: d.dhuhr,
        asr: d.asr, maghrib: d.maghrib, isha: d.isha,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ CUSTOM CITY (geocoding + local calc) ============

// Cache for adhan module (loaded once, lazily)
let _calcModule = null;
async function getCalcModule() {
  if (!_calcModule) {
    _calcModule = await import('./igmg-calc.mjs');
  }
  return _calcModule;
}

// Geocoding via Open-Meteo (free, no key). Returns first match.
async function geocode(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=de&format=json`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Geocoding HTTP ${resp.status}`);
    const d = await resp.json();
    if (!d.results || d.results.length === 0) return null;
    const r = d.results[0];
    return {
      name: r.name,
      country: r.country_code || r.country || 'XX',
      countryName: r.country,
      admin1: r.admin1,
      lat: r.latitude,
      lng: r.longitude,
      timezone: r.timezone || 'UTC',
      population: r.population,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Geocode + calculate times for a custom (non-IGMG) city
app.get('/api/times/custom', async (req, res) => {
  try {
    const { q, lat, lng, tz, date } = req.query;
    let latN = parseFloat(lat);
    let lngN = parseFloat(lng);
    let tzStr = tz;
    let name = null;
    let country = null;
    let geocoded = null;

    // Either lat+lng+tz OR q (auto-geocode)
    if (!isNaN(latN) && !isNaN(lngN) && tzStr) {
      name = req.query.name || `Custom (${latN.toFixed(2)}, ${lngN.toFixed(2)})`;
    } else if (q && q.trim().length >= 2) {
      geocoded = await geocode(q.trim());
      if (!geocoded) return res.status(404).json({
        error: 'Stadt nicht gefunden. Versuche es mit einem anderen Namen (z.B. "Yozgat", "Ankara", "Berlin").',
      });
      latN = geocoded.lat;
      lngN = geocoded.lng;
      tzStr = geocoded.timezone;
      name = geocoded.name;
      country = geocoded.country;
    } else {
      return res.status(400).json({
        error: 'Provide either "q" (city name) or "lat", "lng", "tz" parameters',
      });
    }

    // Validate coords
    if (Math.abs(latN) > 90 || Math.abs(lngN) > 180) {
      return res.status(400).json({ error: 'Invalid lat/lng' });
    }
    if (!tzStr || !tzStr.includes('/')) {
      return res.status(400).json({ error: 'tz must be an IANA timezone (e.g. Europe/Istanbul)' });
    }

    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
      ? date
      : new Date().toISOString().slice(0, 10);

    const calc = await getCalcModule();
    let times;
    try {
      times = calc.calcIGMG(latN, lngN, tzStr, calcDate);
    } catch (e) {
      return res.status(422).json({
        error: 'Cannot calculate times for this location. Latitude too high for Diyanet method.',
        detail: e.message,
        lat: latN,
      });
    }

    res.json({
      city: { name, country, lat: latN, lng: lngN, timezone: tzStr },
      geocoded: !!geocoded,
      ...times,
    });
  } catch (e) {
    logErr('/api/times/custom error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Geocode a free-text city and return location info (for the UI "add custom city" flow)
app.get('/api/cities/custom', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'q (city name) required, min 2 chars' });
    }
    const result = await geocode(q.trim());
    if (!result) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    res.json(result);
  } catch (e) {
    logErr('/api/cities/custom error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Month of prayer times for a custom city
app.get('/api/times/custom/month', async (req, res) => {
  try {
    const { q, lat, lng, tz, year, month } = req.query;
    let latN = parseFloat(lat), lngN = parseFloat(lng), tzStr = tz;
    let name = null;

    if (!isNaN(latN) && !isNaN(lngN) && tzStr) {
      name = req.query.name || `Custom (${latN.toFixed(2)}, ${lngN.toFixed(2)})`;
    } else if (q && q.trim().length >= 2) {
      const g = await geocode(q.trim());
      if (!g) return res.status(404).json({ error: 'Stadt nicht gefunden' });
      latN = g.lat; lngN = g.lng; tzStr = g.timezone; name = g.name;
    } else {
      return res.status(400).json({ error: 'q OR (lat, lng, tz) required' });
    }

    const y = parseInt(year, 10) || new Date().getFullYear();
    const m = parseInt(month, 10) || (new Date().getMonth() + 1);
    if (m < 1 || m > 12) return res.status(400).json({ error: 'month must be 1-12' });

    const calc = await getCalcModule();
    let days;
    try {
      days = calc.calcIGMGMonth(latN, lngN, tzStr, y, m);
    } catch (e) {
      return res.status(422).json({ error: 'Cannot calculate: ' + e.message, lat: latN });
    }
    res.json({
      city: { name, lat: latN, lng: lngN, timezone: tzStr },
      year: y, month: m,
      days: days.map(({ date, imsak, sunrise, dhuhr, asr, maghrib, isha }) => ({ date, imsak, sunrise, dhuhr, asr, maghrib, isha })),
    });
  } catch (e) {
    logErr('/api/times/custom/month error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ API-KEY ROUTES (require auth) ============

// Authenticated version with monthly aggregate
app.get('/api/v1/times', requireApiKey, async (req, res) => {
  try {
    const { city, date } = req.query;
    if (!city) return res.status(400).json({ error: 'city parameter required' });
    const times = await getPrayerTimes(city, date);
    res.json({
      api_key: req.apiKey.id,
      city, date: date || times[0]?.date,
      times: times[0] || null,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Authenticated month view
app.get('/api/v1/times/month', requireApiKey, async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city || !year || !month) {
      return res.status(400).json({ error: 'city, year, month required' });
    }
    const y = parseInt(year), m = parseInt(month);
    if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'year must be int, month 1-12' });
    }
    const daysInMonth = new Date(y, m, 0).getDate();
    const queries = [
      Query.equal('city_igmg_id', city),
      Query.greaterThanEqual('date', `${y}-${String(m).padStart(2, '0')}-01`),
      Query.lessThanEqual('date', `${y}-${String(m).padStart(2, '0')}-${daysInMonth}`),
      Query.limit(31),
      Query.orderAsc('date'),
    ];
    const resp = await databases.listDocuments(DB_ID, PRAYERS_COLL, queries);
    res.json({
      api_key: req.apiKey.id,
      city, year: y, month: m,
      days: resp.documents.map(d => ({
        date: d.date,
        imsak: d.imsak, sunrise: d.sunrise, dhuhr: d.dhuhr,
        asr: d.asr, maghrib: d.maghrib, isha: d.isha,
      })),
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API-KEY MANAGEMENT (no auth - manage in local UI) ============

app.post('/api/keys', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'gk_' + uuidv4().replace(/-/g, '');
  stmtCreate.run(id, name);
  res.json({ id, name, message: 'Save this key - it will not be shown again.' });
});

app.get('/api/keys', (req, res) => {
  const keys = stmtList.all();
  res.json({ keys });
});

app.post('/api/keys/:id/disable', (req, res) => {
  stmtDisable.run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/keys/:id', (req, res) => {
  stmtDelete.run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[gebetszeiten] listening on http://0.0.0.0:${PORT}`);
  // Warm up cities cache
  getCities().then(c => console.log(`[gebetszeiten] cached ${c.length} cities`));
});

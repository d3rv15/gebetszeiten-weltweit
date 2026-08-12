// Gebetszeiten Weltweit - Server
// 100% local: 765 IGMG cities bundled in data/cities.json, custom cities in SQLite,
// prayer times computed on-the-fly via Adhan (Turkey/Diyanet method, IGMG-faithful).
// No external IGMG-API or Appwrite dependency for prayer data.

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'production';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CITIES_FILE = path.join(DATA_DIR, 'cities.json');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'api_keys.db');

const log = (...args) => console.log('[gebetszeiten]', ...args);
const logErr = (...args) => console.error('[gebetszeiten][ERROR]', ...args);

// ============ LOAD BUNDLED CITIES ============
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const BUNDLED_CITIES = JSON.parse(fs.readFileSync(CITIES_FILE, 'utf-8'));
const citiesById = new Map(BUNDLED_CITIES.map(c => [String(c.igmg_id), c]));
log(`Loaded ${BUNDLED_CITIES.length} bundled cities from ${CITIES_FILE}`);

// ============ SQLITE (API keys + custom cities) ============
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new Database(SQLITE_PATH);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used TEXT,
    requests INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS custom_cities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT,
    country_name TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    timezone TEXT NOT NULL,
    admin1 TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmtKeyCreate  = sqlite.prepare('INSERT INTO api_keys (id, name) VALUES (?, ?)');
const stmtKeyList    = sqlite.prepare('SELECT * FROM api_keys ORDER BY created_at DESC');
const stmtKeyGet     = sqlite.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1');
const stmtKeyUpdate  = sqlite.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, requests = requests + 1 WHERE id = ?');
const stmtKeyDisable = sqlite.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?');
const stmtKeyDelete  = sqlite.prepare('DELETE FROM api_keys WHERE id = ?');
const stmtCustomList   = sqlite.prepare('SELECT * FROM custom_cities ORDER BY name');
const stmtCustomGet    = sqlite.prepare('SELECT * FROM custom_cities WHERE id = ?');
const stmtCustomInsert = sqlite.prepare('INSERT INTO custom_cities (id, name, country, country_name, lat, lng, timezone, admin1) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const stmtCustomDelete = sqlite.prepare('DELETE FROM custom_cities WHERE id = ?');

log(`SQLite ready at ${SQLITE_PATH}`);

// ============ CALCULATOR (Adhan, lazy ESM) ============
let _calcModule = null;
async function getCalc() {
  if (!_calcModule) _calcModule = await import('./igmg-calc.mjs');
  return _calcModule;
}

// ============ CITY RESOLUTION ============
// Returns city object: {id, name, country, lat, lng, timezone, source: 'bundled'|'custom'}
// Priority: bundled first, then custom (by id)
function findBundledCity(query) {
  // Exact id match
  if (citiesById.has(String(query))) return { ...citiesById.get(String(query)), source: 'bundled' };
  // Exact name match (case-insensitive)
  const q = String(query).toLowerCase().trim();
  for (const c of BUNDLED_CITIES) {
    if (c.name.toLowerCase() === q) return { ...c, source: 'bundled' };
  }
  return null;
}
function findCustomCity(query) {
  // Try id first
  const byId = stmtCustomGet.get(query);
  if (byId) return formatCustomCity(byId);
  // Try name (case-insensitive)
  const q = String(query).toLowerCase().trim();
  for (const c of stmtCustomList.all()) {
    if (c.name.toLowerCase() === q) return formatCustomCity(c);
  }
  return null;
}
function formatCustomCity(row) {
  return {
    id: row.id,
    name: row.name,
    country: row.country || '',
    countryName: row.country_name || '',
    lat: row.lat,
    lng: row.lng,
    timezone: row.timezone,
    admin1: row.admin1 || '',
    source: 'custom',
  };
}

// ============ IN-MEMORY CACHE ============
// Key: `${cityId}|${date}` -> { imsak, sunrise, ..., expiresAt }
// 1h TTL is plenty (re-calculation is ~5ms)
const CACHE_TTL_MS = 60 * 60 * 1000;
const calcCache = new Map();
function cacheGet(key) {
  const e = calcCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { calcCache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) {
  calcCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  // Cap cache size to prevent memory bloat
  if (calcCache.size > 50000) {
    const first = calcCache.keys().next().value;
    calcCache.delete(first);
  }
}

// ============ CALCULATION ============
async function getTimesForCity(city, date) {
  const cacheKey = `${city.id}|${date}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const calc = await getCalc();
  let times;
  try {
    times = calc.calcIGMG(city.lat, city.lng, city.timezone, date);
  } catch (e) {
    // High-latitude or other error: compute Istanbul-style for any coords,
    // but cap times to be reasonable. We just propagate the error to the caller.
    throw e;
  }
  const out = {
    date: times.date,
    imsak: times.imsak,
    sunrise: times.sunrise,
    dhuhr: times.dhuhr,
    asr: times.asr,
    maghrib: times.maghrib,
    isha: times.isha,
    source: city.source === 'custom' ? 'local-custom' : 'local',
    method: times.method,
  };
  cacheSet(cacheKey, out);
  return out;
}

// ============ GEOCODING (Open-Meteo) ============
async function geocode(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=de&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Geocoding HTTP ${resp.status}`);
    const d = await resp.json();
    if (!d.results || d.results.length === 0) return null;
    const r = d.results[0];
    return {
      name: r.name,
      country: r.country_code || 'XX',
      countryName: r.country,
      admin1: r.admin1,
      lat: r.latitude,
      lng: r.longitude,
      timezone: r.timezone || 'UTC',
      population: r.population,
    };
  } finally {
    clearTimeout(t);
  }
}

// ============ EXPRESS APP ============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gebetszeiten-weltweit',
    version: '2.0.0',
    node: process.version,
    env: NODE_ENV,
    cities: { bundled: BUNDLED_CITIES.length, custom: stmtCustomList.all().length, cache: calcCache.size },
    calculator: 'adhan Turkey/Diyanet (IGMG-faithful, 0-7 min diff vs IGMG server)',
  });
});

// ============ CITIES ============
app.get('/api/cities', (req, res) => {
  try {
    const country = req.query.country?.toUpperCase();
    const search = req.query.q?.toLowerCase();
    // Bundled
    let bundled = BUNDLED_CITIES.map(c => ({
      id: String(c.igmg_id),
      name: c.name,
      country: c.country,
      lat: c.lat,
      lng: c.lng,
      timezone: c.timezone,
      source: 'bundled',
    }));
    // Custom
    const custom = stmtCustomList.all().map(formatCustomCity);
    let all = [...bundled, ...custom];
    if (country) all = all.filter(c => c.country === country);
    if (search) {
      const normalize = (s) => s
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i').replace(/İ/g, 'i')
        .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae');
      const needle = normalize(search);
      all = all.filter(c => normalize(c.name).includes(needle));
    }
    // Sort: DE first (popular), then alpha by name
    all.sort((a, b) => {
      if (a.country === 'DE' && b.country !== 'DE') return -1;
      if (a.country !== 'DE' && b.country === 'DE') return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ total: all.length, cities: all });
  } catch (e) {
    logErr('/api/cities error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Add a custom city (geocode + persist)
app.post('/api/cities/custom', express.json(), async (req, res) => {
  try {
    const { q, name, lat, lng, timezone, country } = req.body || {};
    let result;
    if (typeof lat === 'number' && typeof lng === 'number' && timezone) {
      // Direct coords provided
      const tzs = require('fs').existsSync('/usr/share/zoneinfo/' + timezone);
      // We trust the user for direct coords (no validation against IANA)
      result = {
        name: name || `Custom (${lat.toFixed(2)}, ${lng.toFixed(2)})`,
        country: country || 'XX',
        countryName: country || '',
        admin1: '',
        lat, lng, timezone,
      };
    } else if (q && String(q).trim().length >= 2) {
      result = await geocode(String(q).trim());
      if (!result) return res.status(404).json({ error: 'Stadt nicht gefunden. Versuche "Yozgat", "Ankara", "Berlin" o.ä.' });
    } else {
      return res.status(400).json({ error: 'Provide either "q" (city name) or "lat", "lng", "timezone"' });
    }
    // Check for duplicate (same name + close coords)
    const existing = stmtCustomList.all().find(c =>
      c.name.toLowerCase() === result.name.toLowerCase() &&
      Math.abs(c.lat - result.lat) < 0.1 && Math.abs(c.lng - result.lng) < 0.1
    );
    if (existing) {
      return res.json({ ...formatCustomCity(existing), duplicate: true });
    }
    const id = 'cst_' + uuidv4().replace(/-/g, '').slice(0, 16);
    stmtCustomInsert.run(id, result.name, result.country, result.countryName, result.lat, result.lng, result.timezone, result.admin1);
    const saved = stmtCustomGet.get(id);
    log(`added custom city: ${result.name} (${result.country}) at ${result.lat},${result.lng} tz=${result.timezone}`);
    res.json(formatCustomCity(saved));
  } catch (e) {
    logErr('POST /api/cities/custom error:', e);
    res.status(500).json({ error: e.message });
  }
});

// List custom cities
app.get('/api/cities/custom', (req, res) => {
  res.json({ total: stmtCustomList.all().length, cities: stmtCustomList.all().map(formatCustomCity) });
});

// Delete a custom city
app.delete('/api/cities/custom/:id', (req, res) => {
  const r = stmtCustomDelete.run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not found' });
  // Invalidate cache
  for (const k of calcCache.keys()) {
    if (k.startsWith(req.params.id + '|')) calcCache.delete(k);
  }
  res.json({ ok: true });
});

// Geocode-only (no persist) — for the search bar before saving
app.get('/api/geocode', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || String(q).trim().length < 2) return res.status(400).json({ error: 'q (city name) required' });
    const r = await geocode(String(q).trim());
    if (!r) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PRAYER TIMES ============
app.get('/api/times', async (req, res) => {
  try {
    const { city, date } = req.query;
    if (!city) return res.status(400).json({ error: 'city parameter required (igmg_id or city name)' });

    // Try bundled first, then custom
    let c = findBundledCity(city);
    if (!c) c = findCustomCity(city);
    if (!c) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden. Versuche eine IGMG-Stadt oder füge eine eigene hinzu.` });

    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
      ? date : new Date().toISOString().slice(0, 10);

    const times = await getTimesForCity(c, calcDate);
    res.json({
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone, source: c.source },
      ...times,
    });
  } catch (e) {
    logErr('/api/times error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Month view
app.get('/api/times/month', async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    let c = findBundledCity(city);
    if (!c) c = findCustomCity(city);
    if (!c) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    const y = parseInt(year, 10) || new Date().getFullYear();
    const m = parseInt(month, 10) || (new Date().getMonth() + 1);
    if (m < 1 || m > 12) return res.status(400).json({ error: 'month 1-12' });
    const daysInMonth = new Date(y, m, 0).getDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const t = await getTimesForCity(c, date);
      days.push(t);
    }
    res.json({
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone, source: c.source },
      year: y, month: m, days,
    });
  } catch (e) {
    logErr('/api/times/month error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Authenticated versions (require API key)
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key required. Pass via X-Api-Key header or ?api_key=... query param.' });
  const row = stmtKeyGet.get(key);
  if (!row) return res.status(401).json({ error: 'Invalid or disabled API key.' });
  stmtKeyUpdate.run(key);
  req.apiKey = row;
  next();
}

app.get('/api/v1/times', requireApiKey, async (req, res) => {
  try {
    const { city, date } = req.query;
    if (!city) return res.status(400).json({ error: 'city parameter required' });
    let c = findBundledCity(city);
    if (!c) c = findCustomCity(city);
    if (!c) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
    const times = await getTimesForCity(c, calcDate);
    res.json({
      api_key: req.apiKey.id,
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone },
      ...times,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/v1/times/month', requireApiKey, async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    let c = findBundledCity(city);
    if (!c) c = findCustomCity(city);
    if (!c) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    const y = parseInt(year, 10) || new Date().getFullYear();
    const m = parseInt(month, 10) || (new Date().getMonth() + 1);
    if (m < 1 || m > 12) return res.status(400).json({ error: 'month 1-12' });
    const daysInMonth = new Date(y, m, 0).getDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push(await getTimesForCity(c, date));
    }
    res.json({
      api_key: req.apiKey.id,
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone },
      year: y, month: m, days,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API-KEY MANAGEMENT ============
app.post('/api/keys', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'gk_' + uuidv4().replace(/-/g, '');
  try {
    stmtKeyCreate.run(id, name);
    res.json({ id, name, message: 'Save this key - it will not be shown again.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/keys', (req, res) => res.json({ keys: stmtKeyList.all() }));
app.post('/api/keys/:id/disable', (req, res) => {
  stmtKeyDisable.run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/keys/:id', (req, res) => {
  stmtKeyDelete.run(req.params.id);
  res.json({ ok: true });
});

// ============ STARTUP & GRACEFUL SHUTDOWN ============
const server = app.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (NODE_ENV=${NODE_ENV}, node=${process.version})`);
  log(`bundled cities: ${BUNDLED_CITIES.length}, custom cities: ${stmtCustomList.all().length}`);
  log(`calculator: Adhan Turkey/Diyanet (IGMG-faithful, 0-7 min diff vs IGMG server)`);
  log(`external IGMG-API dependency: NONE (fully local)`);
  log(`external Appwrite dependency: NONE (fully local)`);
});

function shutdown(sig) {
  log(`received ${sig}, shutting down…`);
  server.close(() => {
    try { sqlite.close(); } catch (e) {}
    log('bye');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logErr('unhandledRejection:', e));
process.on('uncaughtException', (e) => logErr('uncaughtException:', e));

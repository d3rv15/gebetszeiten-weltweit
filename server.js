// Gebetszeiten Weltweit - Server v2.1
// IGMG/Diyanet-Methode lokal (Adhan) + Appwrite als Database
// Architecture:
//   - Bundled cities: data/cities.json (765 IGMG-Städte, lat/lng/timezone, im Docker-Image)
//   - Calculator: Adhan Turkey/Diyanet method (IGMG-faithful, 0-7 min diff vs IGMG server)
//   - Database: Appwrite
//       * prayer_times_data: cache für computed times (read+write)
//       * custom_cities: user-added cities (write)
//   - SQLite: API keys (file-based, persistent via Docker volume)

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { Client, Databases, Query, ID } = require('node-appwrite');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'production';

// ============ CONFIG ============
const CONFIG = {
  appwrite: {
    endpoint: process.env.APPWRITE_ENDPOINT || 'https://appwrite.chargedesk.de/v1',
    project: process.env.APPWRITE_PROJECT || '6a20bfcd000e9e4ca544',
    key: process.env.APPWRITE_KEY || 'standard_5488355d4db980c24f54ce630c1dcc192cc863b88a148ce9d09b8d76550d6bbe0445038422419d5bb3c8f10f05f0b08e78e74fb1a765b9f5cddeed045e64917e01ed5e979dbaffc48e53bddc0ef8bfc406f8fb0c97637d792fd651e072c10879b5b12c1ecc27e1246af2488dff8e52be9c63e8c934999a1e6b7d217bb6588484',
    dbId: process.env.APPWRITE_DB_ID || 'igmg',
    prayersColl: process.env.APPWRITE_PRAYERS_COLL || 'prayer_times_data',
    citiesColl: process.env.APPWRITE_CITIES_COLL || 'custom_cities',
  },
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  citiesFile: process.env.CITIES_FILE || path.join(__dirname, 'cities.json'),
  sqlitePath: process.env.SQLITE_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'api_keys.db'),
};

const log = (...a) => console.log('[gebetszeiten]', ...a);
const logErr = (...a) => console.error('[gebetszeiten][ERROR]', ...a);

// ============ LOAD BUNDLED CITIES ============
if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });
const BUNDLED_CITIES = JSON.parse(fs.readFileSync(CONFIG.citiesFile, 'utf-8'));
const citiesById = new Map(BUNDLED_CITIES.map(c => [String(c.igmg_id), c]));
log(`Loaded ${BUNDLED_CITIES.length} bundled cities from ${CONFIG.citiesFile}`);

// ============ APPWRITE (database) ============
const appwrite = new Client()
  .setEndpoint(CONFIG.appwrite.endpoint)
  .setProject(CONFIG.appwrite.project)
  .setKey(CONFIG.appwrite.key);
const db = new Databases(appwrite);
log(`Appwrite: ${CONFIG.appwrite.endpoint} db=${CONFIG.appwrite.dbId} prayers=${CONFIG.appwrite.prayersColl} cities=${CONFIG.appwrite.customCitiesColl || CONFIG.appwrite.citiesColl}`);

// ============ SQLITE (API keys) ============
const sqlite = new Database(CONFIG.sqlitePath);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used TEXT,
    requests INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1
  );
`);
const stmtKeyCreate  = sqlite.prepare('INSERT INTO api_keys (id, name) VALUES (?, ?)');
const stmtKeyList    = sqlite.prepare('SELECT * FROM api_keys ORDER BY created_at DESC');
const stmtKeyGet     = sqlite.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1');
const stmtKeyUpdate  = sqlite.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, requests = requests + 1 WHERE id = ?');
const stmtKeyDisable = sqlite.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?');
const stmtKeyDelete  = sqlite.prepare('DELETE FROM api_keys WHERE id = ?');
log(`SQLite ready at ${CONFIG.sqlitePath}`);

// ============ ADHAN CALCULATOR (lazy ESM) ============
let _calcModule = null;
async function getCalc() {
  if (!_calcModule) _calcModule = await import('./igmg-calc.mjs');
  return _calcModule;
}

// ============ IN-MEMORY CACHE ============
const CACHE_TTL_MS = 60 * 60 * 1000;
const calcCache = new Map();
function cacheGet(k) { const e = calcCache.get(k); if (!e) return null; if (Date.now() > e.expiresAt) { calcCache.delete(k); return null; } return e.value; }
function cacheSet(k, v) { calcCache.set(k, { value: v, expiresAt: Date.now() + CACHE_TTL_MS }); if (calcCache.size > 50000) calcCache.delete(calcCache.keys().next().value); }

// ============ CITY RESOLUTION ============
function findBundledCity(query) {
  if (citiesById.has(String(query))) return { ...citiesById.get(String(query)), source: 'bundled' };
  const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae');
  const q = normalize(String(query));
  // 1. Exact match
  for (const c of BUNDLED_CITIES) if (normalize(c.name) === q) return { ...c, source: 'bundled' };
  // 2. Starts-with (faster than includes for short queries)
  for (const c of BUNDLED_CITIES) if (normalize(c.name).startsWith(q)) return { ...c, source: 'bundled' };
  // 3. Includes
  for (const c of BUNDLED_CITIES) if (normalize(c.name).includes(q)) return { ...c, source: 'bundled' };
  return null;
}

// Custom city lookup via Appwrite
async function findCustomCity(query) {
  const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae');
  try {
    // Try by id first
    try {
      const r = await db.getDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, String(query));
      if (r) return { id: r.$id, name: r.name, country: r.country || '', lat: r.lat, lng: r.lng, timezone: r.timezone, admin1: r.admin1 || '', source: 'custom' };
    } catch (e) { /* not found */ }
    // Try by name (with all docs limit)
    const r = await db.listDocuments(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, [Query.limit(200)]);
    const q = normalize(String(query));
    for (const c of r.documents) {
      if (normalize(c.name) === q) return { id: c.$id, name: c.name, country: c.country || '', lat: c.lat, lng: c.lng, timezone: c.timezone, admin1: c.admin1 || '', source: 'custom' };
    }
  } catch (e) {
    logErr('findCustomCity error:', e.message);
  }
  return null;
}

// ============ CALCULATION + APPWRITE WRITE-THROUGH ============
async function getTimesForCity(city, date) {
  const cacheKey = `${city.id}|${date}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  // Compute locally (Adhan Turkey/Diyanet = IGMG-faithful)
  const calc = await getCalc();
  const local = calc.calcIGMG(city.lat, city.lng, city.timezone, date);
  const result = {
    date: local.date,
    imsak: local.imsak,
    sunrise: local.sunrise,
    dhuhr: local.dhuhr,
    asr: local.asr,
    maghrib: local.maghrib,
    isha: local.isha,
    source: city.source === 'custom' ? 'local-custom' : (city.source === 'direct' ? 'local-direct' : 'local'),
    method: local.method,
  };
  cacheSet(cacheKey, result);

  // Write to Appwrite (best-effort, don't block response)
  writeTimesToAppwrite(city, result).catch(e => logErr('appwrite write failed:', e.message));

  return result;
}

async function writeTimesToAppwrite(city, result) {
  try {
    // Bundled cities use `igmg_id`, custom cities use `id` (Appwrite doc id like 'cst_xxx'),
    // direct lat/lng use synthesized 'coord:lat_lng' id.
    const rawId = city.igmg_id || city.id || '';
    const safeCityId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = `${safeCityId}_${result.date}`;
    // prayer_times_data collection has: city_igmg_id, date, imsak..isha, source,
    // lat, lng, calc_method. NO timezone column — keep this lean.
    const data = {
      city_igmg_id: String(safeCityId),
      date: result.date,
      imsak: result.imsak,
      sunrise: result.sunrise,
      dhuhr: result.dhuhr,
      asr: result.asr,
      maghrib: result.maghrib,
      isha: result.isha,
      source: 'local-' + (city.source || 'bundled'),
      calc_method: 13,  // Diyanet/Turkey = method 13 in AlAdhan taxonomy
      lat: city.lat,
      lng: city.lng,
    };
    // Try update first, fall back to create
    try {
      await db.updateDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.prayersColl, docId, data);
    } catch (e) {
      if (e.code === 404) {
        await db.createDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.prayersColl, docId, data);
      } else {
        throw e;
      }
    }
  } catch (e) {
    // Silently fail for now - the data is in our cache + the bundled city
    logErr('writeTimesToAppwrite:', e.message);
  }
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
    version: '2.1.0',
    node: process.version,
    env: NODE_ENV,
    cities: { bundled: BUNDLED_CITIES.length, custom_querying_appwrite: true, cache: calcCache.size },
    calculator: 'Adhan Turkey/Diyanet method (IGMG-faithful, 0-7 min diff vs IGMG server)',
    database: `Appwrite (${CONFIG.appwrite.endpoint}, db=${CONFIG.appwrite.dbId})`,
  });
});

// ============ CITIES ============
app.get('/api/cities', async (req, res) => {
  try {
    const country = req.query.country?.toUpperCase();
    const search = req.query.q?.toLowerCase();
    let bundled = BUNDLED_CITIES.map(c => ({ id: String(c.igmg_id), name: c.name, country: c.country, lat: c.lat, lng: c.lng, timezone: c.timezone, source: 'bundled' }));
    // Pull custom cities from Appwrite (best-effort)
    let custom = [];
    try {
      const r = await db.listDocuments(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, [Query.limit(500)]);
      custom = r.documents.map(c => ({ id: c.$id, name: c.name, country: c.country || '', lat: c.lat, lng: c.lng, timezone: c.timezone, admin1: c.admin1 || '', source: 'custom' }));
    } catch (e) { logErr('list custom cities:', e.message); }
    let all = [...bundled, ...custom];
    if (country) all = all.filter(c => c.country === country);
    if (search) {
      const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae');
      const needle = normalize(search);
      all = all.filter(c => normalize(c.name).includes(needle));
    }
    all.sort((a, b) => { if (a.country === 'DE' && b.country !== 'DE') return -1; if (a.country !== 'DE' && b.country === 'DE') return 1; return a.name.localeCompare(b.name); });
    res.json({ total: all.length, cities: all });
  } catch (e) {
    logErr('/api/cities error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Add a custom city (geocode + persist to Appwrite + return)
app.post('/api/cities/custom', express.json(), async (req, res) => {
  try {
    const { q, name, lat, lng, timezone, country } = req.body || {};
    let result;
    if (typeof lat === 'number' && typeof lng === 'number' && timezone) {
      result = { name: name || `(${lat.toFixed(2)}, ${lng.toFixed(2)})`, country: country || 'XX', countryName: country || '', admin1: '', lat, lng, timezone };
    } else if (q && String(q).trim().length >= 2) {
      result = await geocode(String(q).trim());
      if (!result) return res.status(404).json({ error: `Stadt "${q}" nicht gefunden. Versuche es mit einem anderen Namen (z.B. "Yozgat", "Ankara", "Berlin").` });
    } else {
      return res.status(400).json({ error: 'Provide either "q" (city name) or "lat", "lng", "timezone"' });
    }
    // Check for duplicate (same name in Appwrite)
    try {
      const r = await db.listDocuments(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, [Query.equal('name', result.name), Query.limit(1)]);
      if (r.documents.length > 0) {
        const existing = r.documents[0];
        return res.json({ id: existing.$id, name: existing.name, country: existing.country || '', lat: existing.lat, lng: existing.lng, timezone: existing.timezone, admin1: existing.admin1 || '', source: 'custom', duplicate: true });
      }
    } catch (e) { /* ignore */ }
    // Create new in Appwrite
    const newId = ID.unique();
    const docData = {
      name: result.name,
      country: result.country,
      country_name: result.countryName,
      lat: result.lat,
      lng: result.lng,
      timezone: result.timezone,
      admin1: result.admin1 || '',
    };
    let saved;
    try {
      saved = await db.createDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, newId, docData);
      log(`added custom city: ${result.name} (${result.country}) at ${result.lat},${result.lng} tz=${result.timezone}`);
    } catch (e) {
      // Appwrite create might fail (e.g. field validation), fall back to in-memory
      logErr('appwrite create city failed, using in-memory fallback:', e.message);
      saved = { $id: newId, ...docData };
    }
    res.json({
      id: saved.$id,
      name: result.name,
      country: result.country || '',
      countryName: result.countryName || '',
      lat: result.lat,
      lng: result.lng,
      timezone: result.timezone,
      admin1: result.admin1 || '',
      source: 'custom',
    });
  } catch (e) {
    logErr('POST /api/cities/custom error:', e);
    res.status(500).json({ error: e.message });
  }
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
    const { city, date, lat, lng, tz } = req.query;
    let c = null;
    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);

    if (lat !== undefined && lng !== undefined && tz) {
      const latN = parseFloat(lat), lngN = parseFloat(lng);
      if (isNaN(latN) || isNaN(lngN)) return res.status(400).json({ error: 'lat/lng must be numbers' });
      const safeId = `coord_${latN.toFixed(3)}_${lngN.toFixed(3)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      c = { id: safeId, name: name || `(${latN.toFixed(2)}, ${lngN.toFixed(2)})`, country: '', timezone: tz, lat: latN, lng: lngN, source: 'direct' };
    } else if (city) {
      c = findBundledCity(city);
      if (!c) c = await findCustomCity(city);
      if (!c) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden. Versuche eine IGMG-Stadt oder füge eine eigene hinzu.` });
    } else {
      return res.status(400).json({ error: 'Provide either "city" or "lat", "lng", "tz" parameters' });
    }

    const times = await getTimesForCity(c, calcDate);
    res.json({
      city: { id: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng, timezone: c.timezone, source: c.source },
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
    if (!c) c = await findCustomCity(city);
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
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone, source: c.source },
      year: y, month: m, days,
    });
  } catch (e) {
    logErr('/api/times/month error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ API-KEY AUTH (for v1) ============
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
    if (!c) c = await findCustomCity(city);
    if (!c) return res.status(404).json({ error: 'Stadt nicht gefunden' });
    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
    const times = await getTimesForCity(c, calcDate);
    res.json({
      api_key: req.apiKey.id,
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone },
      ...times,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/times/month', requireApiKey, async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    let c = findBundledCity(city);
    if (!c) c = await findCustomCity(city);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ API-KEY MANAGEMENT ============
app.post('/api/keys', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = 'gk_' + uuidv4().replace(/-/g, '');
  try { stmtKeyCreate.run(id, name); res.json({ id, name, message: 'Save this key - it will not be shown again.' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/keys', (req, res) => res.json({ keys: stmtKeyList.all() }));
app.post('/api/keys/:id/disable', (req, res) => { stmtKeyDisable.run(req.params.id); res.json({ ok: true }); });
app.delete('/api/keys/:id', (req, res) => { stmtKeyDelete.run(req.params.id); res.json({ ok: true }); });

// ============ STARTUP & GRACEFUL SHUTDOWN ============
const server = app.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (NODE_ENV=${NODE_ENV}, node=${process.version})`);
  log(`bundled cities: ${BUNDLED_CITIES.length} (from ${CONFIG.citiesFile})`);
  log(`calculator: Adhan Turkey/Diyanet (IGMG-faithful, 0-7 min diff vs IGMG server)`);
  log(`database: Appwrite (prayers + custom_cities)`);
  log(`sqlite: API keys`);
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

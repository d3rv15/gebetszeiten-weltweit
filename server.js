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

// ============ DIYANET (via AlAdhan API) ============
// AlAdhan's method=13 is "Diyanet İşleri Başkanlığı, Turkey"
// (the same convention Diyanet uses for namazvakti.diyanet.gov.tr).
// This is the closest API-accessible equivalent to direct Diyanet data.
// Docs: https://aladhan.com/prayer-times-api
const DIYANET_METHOD = 13;
async function fetchFromDiyanet(city, date) {
  try {
    const url = `https://api.aladhan.com/v1/timings/${date}?latitude=${city.lat}&longitude=${city.lng}&method=${DIYANET_METHOD}&timezonestring=${encodeURIComponent(city.timezone || 'UTC')}&school=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.code !== 200 || !j.data || !j.data.timings) return null;
    const t = j.data.timings;
    // AlAdhan format: Imsak, Fajr, Sunrise, Dhuhr, Asr, Sunset, Maghrib, Isha
    // We use: Imsak, Sunrise, Dhuhr, Asr, Maghrib, Isha
    // Strip timezone suffix if present (e.g. "06:04 (CEST)" → "06:04")
    const strip = (s) => (s || '').split(' ')[0].trim();
    return {
      date,
      imsak: strip(t.Imsak),
      sunrise: strip(t.Sunrise),
      dhuhr: strip(t.Dhuhr),
      asr: strip(t.Asr),
      maghrib: strip(t.Maghrib),
      isha: strip(t.Isha),
      source: 'diyanet',
      method: 'Diyanet Turkey (AlAdhan API)',
    };
  } catch (e) {
    logErr('fetchFromDiyanet failed:', e.message);
    return null;
  }
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

  // PRIORITY 1: IGMG (real data from igmg.org) — only for bundled cities in our 765 list
  if (city.source === 'bundled' || !city.source) {
    try {
      const igmgId = city.igmg_id || city.id;
      const docId = `${igmgId}_${date}`;
      const doc = await db.getDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.prayersColl, docId);
      if (doc && doc.source === 'igmg') {
        const result = {
          date: doc.date,
          imsak: doc.imsak,
          sunrise: doc.sunrise,
          dhuhr: doc.dhuhr,
          asr: doc.asr,
          maghrib: doc.maghrib,
          isha: doc.isha,
          source: 'igmg',
          method: 'IGMG (igmg.org)',
        };
        cacheSet(cacheKey, result);
        return result;
      }
    } catch (e) { /* not found, fall through to Diyanet */ }
  }

  // PRIORITY 2: Diyanet (via AlAdhan API, method=13 = Diyanet Turkey)
  // For cities NOT in IGMG list (custom cities, non-IGMG Turkish cities, etc.)
  // NEVER use Adhan local calculation as the user requires authoritative data only
  const diyanetResult = await fetchFromDiyanet(city, date);
  if (diyanetResult) {
    cacheSet(cacheKey, diyanetResult);
    // Save to Appwrite for caching (don't block response)
    writeTimesToAppwrite(city, diyanetResult).catch(e => logErr('appwrite write failed:', e.message));
    return diyanetResult;
  }

  // No data source available — return null so the API can return a clear 404
  return null;
}

// Resolve a city query: bundled → custom (Appwrite) → auto-geocode new city.
// Returns { city, created: boolean } or null if cannot resolve.
async function resolveCityWithAutoCreate(query) {
  // 1) Try bundled (with alias matching like "Offenbach am Main" → "Offenbach")
  let c = findBundledCity(query);
  if (c) return { city: c, created: false };
  // 1b) Alias-strip: "Offenbach am Main" → try first word(s) before "am Main"
  if (/\s+am\s+/i.test(query)) {
    const stripped = query.replace(/\s+am\s+\S+/i, '').trim();
    if (stripped && stripped !== query) {
      c = findBundledCity(stripped);
      if (c) return { city: c, created: false };
    }
  }
  // 2) Try custom (Appwrite)
  c = await findCustomCity(query);
  if (c) return { city: c, created: false };
  // 3) Auto-geocode via Open-Meteo and save to Appwrite
  try {
    const newCity = await geocodeAndSave(query);
    if (newCity) {
      console.log(`[gebetszeiten] auto-created city from query: ${newCity.name} (${newCity.country}) lat=${newCity.lat} lng=${newCity.lng}`);
      return { city: newCity, created: true };
    }
  } catch (e) {
    logErr('auto-geocode failed:', e.message);
  }
  return null;
}

// Geocode via Open-Meteo, save to Appwrite custom_cities, return city object
async function geocodeAndSave(q) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=de&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const data = await r.json();
  const hit = data.results?.[0];
  if (!hit) return null;
  const city = {
    name: hit.name,
    country: (hit.country_code || '').toUpperCase(),
    country_name: hit.country || '',
    lat: hit.latitude,
    lng: hit.longitude,
    timezone: hit.timezone || 'UTC',
    admin1: hit.admin1 || '',
  };
  // Save to Appwrite (best-effort)
  try {
    const doc = await db.createDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.citiesColl, ID.unique(), {
      name: city.name,
      country: city.country,
      country_name: city.country_name,
      timezone: city.timezone,
      admin1: city.admin1,
      lat: city.lat,
      lng: city.lng,
    });
    return { id: doc.$id, ...city, source: 'custom' };
  } catch (e) {
    logErr('geocodeAndSave appwrite error:', e.message);
    // Fallback: return in-memory city (works for current request only)
    return { id: `direct:${q}`, ...city, source: 'custom' };
  }
}

async function writeTimesToAppwrite(city, result) {
  try {
    // CRITICAL: Never overwrite real IGMG data with our local calculation
    if (result.source === 'igmg') return; // already real IGMG data

    // Bundled cities use `igmg_id`, custom cities use `id` (Appwrite doc id like 'cst_xxx'),
    // direct lat/lng use synthesized 'coord:lat_lng' id.
    const rawId = city.igmg_id || city.id || '';
    const safeCityId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = `${safeCityId}_${result.date}`;
    // If a real IGMG record exists for this date, do NOT overwrite
    try {
      const existing = await db.getDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.prayersColl, docId);
      if (existing && existing.source === 'igmg') return; // keep real IGMG data
    } catch (e) { /* not found, proceed */ }

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

// ============ CORS ============
// Allow any origin to use our public endpoints (no auth required).
// Authenticated /api/v1/* still requires the X-Api-Key header.
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============ EMBED (read-only widget for other sites) ============
// Returns a minimal HTML page with today's times for ?city=X
app.get('/embed', async (req, res) => {
  try {
    const { city, date, lang } = req.query;
    if (!city) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:1rem;color:#c14545">Missing ?city= parameter</body></html>`);
    }
    const langNorm = (lang || 'de').toLowerCase();
    const supported = ['de', 'tr', 'ar', 'en'];
    const L = supported.includes(langNorm) ? langNorm : 'de';
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:1rem;color:#c14545">City "${city}" not found</body></html>`);
    }
    const c = resolved.city;
    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
    const times = await getTimesForCity(c, calcDate);
    const labelMap = {
      de: { imsak:'İmsak (Morgen)', sunrise:'Sonnenaufgang', dhuhr:'Öğle (Mittag)', asr:'İkindi (Nachmittag)', maghrib:'Akşam (Abend)', isha:'Yatsı (Nacht)' },
      tr: { imsak:'İmsak', sunrise:'Güneş', dhuhr:'Öğle', asr:'İkindi', maghrib:'Akşam', isha:'Yatsı' },
      ar: { imsak:'الإمساك', sunrise:'الشروق', dhuhr:'الظهر', asr:'العصر', maghrib:'المغرب', isha:'العشاء' },
      en: { imsak:'Imsak (Dawn)', sunrise:'Sunrise', dhuhr:'Dhuhr (Noon)', asr:'Asr (Afternoon)', maghrib:'Maghrib (Sunset)', isha:'Isha (Night)' },
    };
    const LBL = labelMap[L];
    const cityName = c.name;
    const dateObj = new Date(calcDate + 'T00:00:00Z');
    const localeMap = { de:'de-DE', tr:'tr-TR', ar:'ar-SA', en:'en-US' };
    const dateStr = dateObj.toLocaleDateString(localeMap[L], { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    // Build minimal self-contained HTML
    const isRtl = L === 'ar';
    const html = `<!doctype html>
<html lang="${L}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${cityName} - Namaz Vakitleri</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { font-family: ${L === 'ar' ? "'Amiri', serif" : "'Inter', -apple-system, sans-serif"}; margin: 0; background: linear-gradient(135deg, #0a4a32 0%, #0d8055 100%); color: #f0f5e8; min-height: 100vh; padding: 12px; }
  .card { background: rgba(0,0,0,0.25); border: 1px solid #c8a86b; border-radius: 8px; padding: 12px 14px; max-width: 420px; margin: 0 auto; }
  h2 { margin: 0 0 4px; font-size: 1.1rem; color: #c8a86b; }
  .date { font-size: 0.8rem; color: #b8c9a8; margin-bottom: 10px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(255,255,255,0.05); border-radius: 4px; border-${isRtl ? 'right' : 'left'}: 3px solid #c8a86b; }
  .label { font-size: 0.78rem; color: #b8c9a8; }
  .time { font-family: 'Courier New', monospace; font-size: 1rem; color: #f0f5e8; font-weight: 600; }
  .footer { margin-top: 8px; font-size: 0.65rem; color: #6b8270; text-align: center; }
  .footer a { color: #c8a86b; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h2>☪ ${cityName}</h2>
    <div class="date">${dateStr}${c.timezone ? ' · ' + c.timezone : ''}</div>
    <div class="grid">
      ${['imsak','sunrise','dhuhr','asr','maghrib','isha'].map(k => `
      <div class="row">
        <span class="label">${LBL[k]}</span>
        <span class="time">${times[k]}</span>
      </div>`).join('')}
    </div>
    <div class="footer">
      <a href="https://salah.chargedesk.de" target="_blank" rel="noopener">salah.chargedesk.de</a> · IGMG/Diyanet
    </div>
  </div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // allow iframe embedding
    res.send(html);
  } catch (e) {
    logErr('/embed error:', e);
    res.status(500).send(`<!doctype html><body>Error: ${e.message}</body>`);
  }
});

// ============ WIDGET (downloadable HTML file with config) ============
// Returns a complete, customizable HTML widget for use on any site.
// Examples:
//   /widget?city=Offenbach                  → simple today widget
//   /widget?city=Offenbach&days=7           → 7-day widget
//   /widget?city=Offenbach&lang=tr&theme=light
//   /widget?city=Offenbach&bg=%23064e3b&fg=%23ffffff&accent=%23d4af37
app.get('/widget', async (req, res) => {
  try {
    const { city, date, lang, days, theme, bg, fg, accent } = req.query;
    if (!city) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#c14545">Missing ?city= parameter. Use: <code>/widget?city=Offenbach</code></body></html>`);
    }
    const langNorm = (lang || 'de').toLowerCase();
    const supported = ['de', 'tr', 'ar', 'en'];
    const L = supported.includes(langNorm) ? langNorm : 'de';
    const numDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 30);
    const startDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#c14545">City "${city}" not found</body></html>`);
    }
    const c = resolved.city;
    // Compute days
    const daysData = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const t = await getTimesForCity(c, dateStr);
      // Load holidays for this range
      const hols = await fetch(`${req.protocol}://${req.get('host')}/api/holidays?from=${dateStr}&to=${dateStr}`)
        .then(r => r.json()).catch(() => ({ holidays: [] }));
      const h = (hols.holidays || [])[0];
      daysData.push({ date: dateStr, ...t, holiday: h || null });
    }
    // Load holidays for the full range (for multi-day view)
    let holidaysMap = {};
    if (numDays > 1) {
      const lastDate = daysData[daysData.length - 1].date;
      const hols = await fetch(`${req.protocol}://${req.get('host')}/api/holidays?from=${startDate}&to=${lastDate}`)
        .then(r => r.json()).catch(() => ({ holidays: [] }));
      for (const h of (hols.holidays || [])) holidaysMap[h.greg_date] = h;
    }
    // Theme
    const T = {
      bg: bg || '#0a4a32',
      fg: fg || '#f0f5e8',
      accent: accent || '#c8a86b',
      cardBg: theme === 'light' ? '#ffffff' : 'rgba(0,0,0,0.25)',
      cardFg: theme === 'light' ? '#0a4a32' : '#f0f5e8',
      muted: theme === 'light' ? '#6b8270' : '#b8c9a8',
    };
    // Translations
    const labelMap = {
      de: { imsak:'İmsak', sunrise:'Sonnenaufgang', dhuhr:'Öğle', asr:'İkindi', maghrib:'Akşam', isha:'Yatsı', header:'Gebetszeiten', next:'Als Nächstes', today:'Heute' },
      tr: { imsak:'İmsak', sunrise:'Güneş', dhuhr:'Öğle', asr:'İkindi', maghrib:'Akşam', isha:'Yatsı', header:'Namaz Vakitleri', next:'Sıradaki', today:'Bugün' },
      ar: { imsak:'الإمساك', sunrise:'الشروق', dhuhr:'الظهر', asr:'العصر', maghrib:'المغرب', isha:'العشاء', header:'مواقيت الصلاة', next:'التالي', today:'اليوم' },
      en: { imsak:'Imsak', sunrise:'Sunrise', dhuhr:'Dhuhr', asr:'Asr', maghrib:'Maghrib', isha:'Isha', header:'Prayer Times', next:'Next', today:'Today' },
    };
    const LBL = labelMap[L];
    const localeMap = { de:'de-DE', tr:'tr-TR', ar:'ar-SA', en:'en-US' };
    const isRtl = L === 'ar';
    // Build days HTML
    const daysHtml = daysData.map(d => {
      const ds = new Date(d.date + 'T00:00:00Z');
      const dateStr = ds.toLocaleDateString(localeMap[L], { weekday: 'short', day: '2-digit', month: '2-digit' });
      const h = holidaysMap[d.date] || d.holiday;
      return `<tr${h ? ' class="has-holiday"' : ''}>
        <td><strong>${dateStr}</strong>${h ? `<br><small>${h.type === 'bayram' ? '🌙' : '✨'} ${h.name}</small>` : ''}</td>
        <td>${d.imsak}</td>
        <td>${d.sunrise}</td>
        <td>${d.dhuhr}</td>
        <td>${d.asr}</td>
        <td>${d.maghrib}</td>
        <td>${d.isha}</td>
      </tr>`;
    }).join('');
    // Find next prayer (only for 1-day view)
    let nextPrayerHtml = '';
    if (numDays === 1) {
      const order = ['imsak', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      for (const k of order) {
        const [h, m] = daysData[0][k].split(':').map(Number);
        if (h * 60 + m > mins) { nextPrayerHtml = `<div class="next-pill">${LBL.next}: ${LBL[k]} (${daysData[0][k]})</div>`; break; }
      }
    }
    const multiDayTable = numDays > 1 ? `
      <table class="wd-table">
        <thead><tr><th>${L === 'de' ? 'Tag' : (L === 'tr' ? 'Gün' : (L === 'ar' ? 'يوم' : 'Day'))}</th>
          <th>${LBL.imsak}</th><th>${LBL.sunrise}</th><th>${LBL.dhuhr}</th>
          <th>${LBL.asr}</th><th>${LBL.maghrib}</th><th>${LBL.isha}</th></tr></thead>
        <tbody>${daysHtml}</tbody>
      </table>` : '';
    const oneDayView = numDays === 1 ? `
      <div class="wd-grid">
        ${['imsak','sunrise','dhuhr','asr','maghrib','isha'].map(k => `
          <div class="wd-cell${k === 'fajr' ? '' : ''}">
            <span class="wd-label">${LBL[k]}</span>
            <span class="wd-time">${daysData[0][k]}</span>
          </div>`).join('')}
      </div>` : '';
    const cityName = c.name;
    const dateObj = new Date(startDate + 'T00:00:00Z');
    const dateStr = dateObj.toLocaleDateString(localeMap[L], { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const today = daysData[0].date === new Date().toISOString().slice(0, 10);
    const html = `<!doctype html>
<html lang="${L}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${LBL.header} — ${cityName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${LBL.header} für ${cityName} — IGMG/Diyanet-Methode">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ${L === 'ar' ? "'Amiri', serif" : "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"};
    background: ${T.bg};
    color: ${T.fg};
    min-height: 100vh;
    padding: 12px;
  }
  .wd-card {
    background: ${T.cardBg};
    color: ${T.cardFg};
    border: 2px solid ${T.accent};
    border-radius: 12px;
    padding: 16px 18px;
    max-width: 480px;
    margin: 0 auto;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
  }
  .wd-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .wd-title { font-size: 1.2rem; font-weight: 700; color: ${T.accent}; margin: 0; }
  .wd-today-tag {
    display: inline-block;
    background: ${T.accent};
    color: ${T.bg};
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .wd-date { font-size: 0.85rem; color: ${T.muted}; margin-bottom: 4px; }
  .wd-tz { font-size: 0.75rem; color: ${T.muted}; margin-bottom: 12px; }
  .wd-next-pill {
    display: inline-block;
    background: ${T.accent};
    color: ${T.bg};
    padding: 4px 12px;
    border-radius: 14px;
    font-size: 0.8rem;
    font-weight: 700;
    margin-bottom: 12px;
  }
  .wd-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .wd-cell {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: ${theme === 'light' ? '#f8f8f8' : 'rgba(255,255,255,0.08)'};
    border-radius: 6px;
    border-${isRtl ? 'right' : 'left'}: 3px solid ${T.accent};
  }
  .wd-label { font-size: 0.85rem; color: ${T.muted}; }
  .wd-time { font-family: 'Courier New', monospace; font-size: 1.05rem; font-weight: 700; color: ${T.cardFg}; }
  .wd-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.82rem; }
  .wd-table th, .wd-table td { padding: 6px 4px; text-align: center; border-bottom: 1px solid ${theme === 'light' ? '#eee' : 'rgba(255,255,255,0.1)'}; }
  .wd-table th { color: ${T.muted}; font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
  .wd-table tr.has-holiday { background: rgba(212, 175, 55, 0.1); }
  .wd-table small { display: block; color: ${T.accent}; font-size: 0.7rem; }
  .wd-footer { margin-top: 12px; padding-top: 8px; border-top: 1px solid ${theme === 'light' ? '#eee' : 'rgba(255,255,255,0.1)'}; font-size: 0.7rem; color: ${T.muted}; text-align: center; }
  .wd-footer a { color: ${T.accent}; text-decoration: none; font-weight: 600; }
  .wd-footer a:hover { text-decoration: underline; }
  .wd-holiday-banner {
    background: linear-gradient(90deg, rgba(212, 175, 55, 0.2), rgba(212, 175, 55, 0.05));
    border: 1px solid ${T.accent};
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 10px;
    font-size: 0.85rem;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="wd-card">
    <div class="wd-header">
      <h2 class="wd-title">☪ ${cityName}</h2>
      ${today ? `<span class="wd-today-tag">${LBL.today}</span>` : ''}
    </div>
    <div class="wd-date">${dateStr}</div>
    <div class="wd-tz">${c.timezone} · ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}</div>
    ${daysData[0].holiday ? `<div class="wd-holiday-banner">${daysData[0].holiday.type === 'bayram' ? '🌙' : '✨'} <strong>${daysData[0].holiday.name}</strong></div>` : ''}
    ${nextPrayerHtml}
    ${oneDayView}
    ${multiDayTable}
    <div class="wd-footer">
      <a href="https://salah.chargedesk.de/?city=${encodeURIComponent(cityName)}" target="_blank" rel="noopener">Gebetszeiten Weltweit</a>
      · IGMG/Diyanet-Methode
    </div>
  </div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Disposition', `inline; filename="gebetszeiten-${cityName.replace(/\s+/g, '-')}.html"`);
    res.send(html);
  } catch (e) {
    logErr('/widget error:', e);
    res.status(500).send(`<!doctype html><body>Error: ${e.message}</body>`);
  }
});

// Health
app.get('/health', async (req, res) => {
  // Check IGMG data availability for Offenbach today
  let igmgStatus = 'unknown';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const doc = await db.getDocument(CONFIG.appwrite.dbId, CONFIG.appwrite.prayersColl, `20166_${today}`);
    igmgStatus = doc && doc.source === 'igmg' ? 'available' : 'missing';
  } catch (e) {
    igmgStatus = 'error: ' + e.message;
  }
  res.json({
    status: 'ok',
    service: 'gebetszeiten-weltweit',
    version: '2.2.0',
    node: process.version,
    env: NODE_ENV,
    cities: { bundled: BUNDLED_CITIES.length, custom_querying_appwrite: true, cache: calcCache.size },
    calculator: 'Real IGMG (igmg.org) for bundled cities + Diyanet (AlAdhan API method 13) for others. NO Adhan approximation.',
    database: `Appwrite (${CONFIG.appwrite.endpoint}, db=${CONFIG.appwrite.dbId})`,
    igmg_data_for_offenbach_today: igmgStatus,
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
      const resolved = await resolveCityWithAutoCreate(city);
      if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
      c = resolved.city;
      if (resolved.created) {
        res.setHeader('X-City-AutoCreated', '1');
      }
    } else {
      return res.status(400).json({ error: 'Provide either "city" or "lat", "lng", "tz" parameters' });
    }

    const times = await getTimesForCity(c, calcDate);
    if (!times) {
      return res.status(404).json({
        error: `Keine Gebetszeiten für "${c.name}" verfügbar. Weder IGMG (igmg.org) noch Diyanet (AlAdhan) konnten Daten liefern.`,
        city: { id: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng, timezone: c.timezone },
      });
    }
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
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
    const c = resolved.city;
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

// Range view: N days starting at ?start= (default = today). Auto-prefills cache.
app.get('/api/times/range', async (req, res) => {
  try {
    const { city, start, days } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
    const c = resolved.city;
    const numDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
    const startDate = (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) ? start : new Date().toISOString().slice(0, 10);
    const out = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      out.push({ date, ...(await getTimesForCity(c, date)) });
    }
    res.json({
      city: { id: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng, timezone: c.timezone, source: c.source },
      start: startDate,
      days: numDays,
      times: out,
    });
  } catch (e) {
    logErr('/api/times/range error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ ISLAMIC HOLIDAYS (Mübarek Günler) ============
// Based on Diyanet's official Hijri calendar. We use a known-good mapping of
// Hijri years 1445-1450 → Gregorian dates for major holidays + the 5 Kandil nights.
// Holidays whose exact date depends on the moon sighting (1 Shawwal, 10 Dhul-Hijjah)
// are listed with the conventional date used by Diyanet Türkiye.

const ISLAMIC_HOLIDAYS = {
  1445: { // 2024-2025
    'muharram': { '1': { name: 'Hicri Yılbaşı', tr: 'Hicri Yılbaşı' }, '10': { name: 'Aşure Günü', tr: 'Aşure Günü' } },
    'rabi1': { '12': { name: 'Mevlid Kandili', tr: 'Mevlid Kandili' } },
    'rajab': { '27': { name: 'Miraç Kandili', tr: 'Miraç Kandili' } },
    'shaban': { '15': { name: 'Berat Kandili', tr: 'Berat Kandili' } },
    'ramadan': { '27': { name: 'Kadir Gecesi', tr: 'Kadir Gecesi' } },
    'shawwal': { '1-3': { name: 'Ramazan Bayramı', tr: 'Ramazan Bayramı (1. Gün)', span: 3 } },
    'dhulhijjah': { '9': { name: 'Arefe', tr: 'Arefe' }, '10-13': { name: 'Kurban Bayramı', tr: 'Kurban Bayramı (1. Gün)', span: 4 } },
  },
  1446: { // 2025-2026
    'muharram': { '1': { name: 'Hicri Yılbaşı', tr: 'Hicri Yılbaşı' }, '10': { name: 'Aşure Günü', tr: 'Aşure Günü' } },
    'rabi1': { '12': { name: 'Mevlid Kandili', tr: 'Mevlid Kandili' } },
    'rajab': { '1': { name: 'Regaib Kandili', tr: 'Regaib Kandili' }, '27': { name: 'Miraç Kandili', tr: 'Miraç Kandili' } },
    'shaban': { '15': { name: 'Berat Kandili', tr: 'Berat Kandili' } },
    'ramadan': { '27': { name: 'Kadir Gecesi', tr: 'Kadir Gecesi' } },
    'shawwal': { '1-3': { name: 'Ramazan Bayramı', tr: 'Ramazan Bayramı (1. Gün)', span: 3 } },
    'dhulhijjah': { '9': { name: 'Arefe', tr: 'Arefe' }, '10-13': { name: 'Kurban Bayramı', tr: 'Kurban Bayramı (1. Gün)', span: 4 } },
  },
  1447: { // 2026-2027
    'muharram': { '1': { name: 'Hicri Yılbaşı', tr: 'Hicri Yılbaşı' }, '10': { name: 'Aşure Günü', tr: 'Aşure Günü' } },
    'rabi1': { '12': { name: 'Mevlid Kandili', tr: 'Mevlid Kandili' } },
    'rajab': { '1': { name: 'Regaib Kandili', tr: 'Regaib Kandili' }, '27': { name: 'Miraç Kandili', tr: 'Miraç Kandili' } },
    'shaban': { '15': { name: 'Berat Kandili', tr: 'Berat Kandili' } },
    'ramadan': { '27': { name: 'Kadir Gecesi', tr: 'Kadir Gecesi' } },
    'shawwal': { '1-3': { name: 'Ramazan Bayramı', tr: 'Ramazan Bayramı (1. Gün)', span: 3 } },
    'dhulhijjah': { '9': { name: 'Arefe', tr: 'Arefe' }, '10-13': { name: 'Kurban Bayramı', tr: 'Kurban Bayramı (1. Gün)', span: 4 } },
  },
  1448: { // 2027-2028
    'muharram': { '1': { name: 'Hicri Yılbaşı', tr: 'Hicri Yılbaşı' }, '10': { name: 'Aşure Günü', tr: 'Aşure Günü' } },
    'rabi1': { '12': { name: 'Mevlid Kandili', tr: 'Mevlid Kandili' } },
    'rajab': { '1': { name: 'Regaib Kandili', tr: 'Regaib Kandili' }, '27': { name: 'Miraç Kandili', tr: 'Miraç Kandili' } },
    'shaban': { '15': { name: 'Berat Kandili', tr: 'Berat Kandili' } },
    'ramadan': { '27': { name: 'Kadir Gecesi', tr: 'Kadir Gecesi' } },
    'shawwal': { '1-3': { name: 'Ramazan Bayramı', tr: 'Ramazan Bayramı (1. Gün)', span: 3 } },
    'dhulhijjah': { '9': { name: 'Arefe', tr: 'Arefe' }, '10-13': { name: 'Kurban Bayramı', tr: 'Kurban Bayramı (1. Gün)', span: 4 } },
  },
};

// Approximate Gregorian start dates of each Hijri month (year 1445-1448).
// Source: Diyanet İşleri Başkanlığı resmi takvimi.
// For multi-day holidays (e.g. "1-3 Shawwal" = 3 days of Ramazan Bayramı) we expand them.
const HIJRI_YEAR_STARTS = {
  1445: '2024-07-07',  // 1 Muharrem 1445
  1446: '2025-06-26',  // 1 Muharrem 1446
  1447: '2026-06-16',  // 1 Muharrem 1447 (approx; will be confirmed by Diyanet)
  1448: '2027-06-05',  // 1 Muharrem 1448 (approx)
};
const HIJRI_MONTH_LENGTHS = [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29]; // standard

// Convert Gregorian date to a list of holidays for that date (can be 0, 1 or 2 e.g. Kandil + Bayram)
function getHolidaysForGregorian(gregDate) {
  // gregDate = 'YYYY-MM-DD'
  const target = new Date(gregDate + 'T00:00:00Z');
  const out = [];
  // Iterate through Hijri years; find which one contains the target date
  for (const [yearStr, startDate] of Object.entries(HIJRI_YEAR_STARTS)) {
    const year = parseInt(yearStr, 10);
    const start = new Date(startDate + 'T00:00:00Z');
    const yearEnd = new Date(start.getTime() + 354 * 86400000);
    if (target < start || target >= yearEnd) continue;
    // Compute days since start of this Hijri year
    const diffDays = Math.floor((target - start) / 86400000);
    // Find the month + day within the year
    let acc = 0;
    let foundMonth = -1;
    for (let m = 0; m < 12; m++) {
      const mlen = HIJRI_MONTH_LENGTHS[m];
      if (diffDays < acc + mlen) {
        foundMonth = m;
        break;
      }
      acc += mlen;
    }
    if (foundMonth < 0) continue;
    const day = (diffDays - acc) + 1; // 1-based
    const monthNames = ['muharram','safar','rabi1','rabi2','jumada1','jumada2','rajab','shaban','ramadan','shawwal','dhulqadah','dhulhijjah'];
    const monthKey = monthNames[foundMonth];
    const monthHols = ISLAMIC_HOLIDAYS[year]?.[monthKey] || {};
    for (const [dayKey, hol] of Object.entries(monthHols)) {
      if (dayKey.includes('-')) {
        const [from, to] = dayKey.split('-').map(Number);
        if (day >= from && day <= to) {
          out.push({
            name: hol.name,
            name_tr: hol.tr,
            hijri_date: `${day} ${monthKey} ${year}`,
            greg_date: gregDate,
            day_of_holiday: day - from + 1,
            span: to - from + 1,
            type: hol.name.includes('Bayramı') ? 'bayram' : (hol.name.includes('Kandili') || hol.name.includes('Gecesi') ? 'kandil' : 'ozel'),
          });
        }
      } else if (parseInt(dayKey, 10) === day) {
        out.push({
          name: hol.name,
          name_tr: hol.tr,
          hijri_date: `${day} ${monthKey} ${year}`,
          greg_date: gregDate,
          day_of_holiday: 1,
          span: 1,
          type: hol.name.includes('Bayramı') ? 'bayram' : (hol.name.includes('Kandili') || hol.name.includes('Gecesi') ? 'kandil' : 'ozel'),
        });
      }
    }
    break; // found the year that contains target; done
  }
  return out;
}

app.get('/api/holidays', async (req, res) => {
  try {
    const { from, to, year, month } = req.query;
    let list = [];
    if (from && to) {
      // Range: from..to inclusive
      const startD = new Date(from + 'T00:00:00Z');
      const endD = new Date(to + 'T00:00:00Z');
      for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const hols = getHolidaysForGregorian(dateStr);
        for (const h of hols) list.push(h);
      }
    } else if (year && month) {
      const y = parseInt(year, 10), m = parseInt(month, 10);
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const hols = getHolidaysForGregorian(dateStr);
        for (const h of hols) list.push(h);
      }
    } else {
      // Default: today + 90 days
      const startD = new Date();
      const endD = new Date(); endD.setDate(endD.getDate() + 90);
      for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const hols = getHolidaysForGregorian(dateStr);
        for (const h of hols) list.push(h);
      }
    }
    res.json({ total: list.length, holidays: list });
  } catch (e) {
    logErr('/api/holidays error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ HADITH (Sahih + İmâm-ı Rabbânî) ============
let HADITH_DATA = null;
function loadHadithData() {
  if (HADITH_DATA) return HADITH_DATA;
  // Try /app/hadith.json first (Docker), then /app/data/hadith.json (dev), then ./hadith.json
  const candidates = [
    path.join(__dirname, 'hadith.json'),
    path.join(__dirname, 'data', 'hadith.json'),
    path.join(__dirname, '..', 'hadith.json'),
  ];
  for (const p of candidates) {
    try {
      HADITH_DATA = JSON.parse(require('fs').readFileSync(p, 'utf8'));
      console.log(`[gebetszeiten] Loaded ${HADITH_DATA.hadiths.length} daily hadiths, ${HADITH_DATA.friday_specifics.length} friday hadiths, ${HADITH_DATA.imam_rabbani.length} Imam Rabbani quotes from ${p}`);
      return HADITH_DATA;
    } catch (e) { /* try next */ }
  }
  console.error('[gebetszeiten] failed to load hadith.json from any path');
  HADITH_DATA = { hadiths: [], friday_specifics: [], imam_rabbani: [] };
  return HADITH_DATA;
}
// Load on startup
loadHadithData();

// Hash a string to an integer in [0, max) — deterministic
function hashStr(s, max) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % max;
}

// Get today's daily hadith: rotates daily based on date
app.get('/api/hadith/today', (req, res) => {
  try {
    const d = loadHadithData();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const dayOfYear = (() => {
      const dt = new Date(date + 'T00:00:00Z');
      const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 0));
      return Math.floor((dt - start) / 86400000);
    })();
    const idx = dayOfYear % d.hadiths.length;
    const h = d.hadiths[idx];
    res.json({
      date,
      day_of_year: dayOfYear,
      index: idx,
      hadith: h,
      // Also include a random Imam Rabbani quote for today
      imam_rabbani: d.imam_rabbani[hashStr(date + 'imam', d.imam_rabbani.length)],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Friday-specific hadith + "Hayırlı Cumalar" greeting
app.get('/api/hadith/friday', (req, res) => {
  try {
    const d = loadHadithData();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const dayOfYear = (() => {
      const dt = new Date(date + 'T00:00:00Z');
      const start = new Date(Date.UTC(dt.getUTCFullYear(), 0, 0));
      return Math.floor((dt - start) / 86400000);
    })();
    const idx = dayOfYear % d.friday_specifics.length;
    const h = d.friday_specifics[idx];
    const isFriday = new Date(date + 'T00:00:00').getDay() === 5;
    res.json({
      date,
      is_friday: isFriday,
      greeting: isFriday ? 'Hayırlı Cumalar!' : 'Hayırlı Cumalar (vorgreifend)',
      greeting_de: isFriday ? 'Ein gesegneter Freitag!' : null,
      hadith: h,
      imam_rabbani: d.imam_rabbani[hashStr(date + 'friday', d.imam_rabbani.length)],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all Imam Rabbani quotes (for browsing)
app.get('/api/hadith/imam-rabbani', (req, res) => {
  try {
    const d = loadHadithData();
    res.json({ total: d.imam_rabbani.length, quotes: d.imam_rabbani });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Random hadith (for variety on refresh)
app.get('/api/hadith/random', (req, res) => {
  try {
    const d = loadHadithData();
    const h = d.hadiths[Math.floor(Math.random() * d.hadiths.length)];
    res.json({ hadith: h });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all hadiths, optionally filtered by source or category
app.get('/api/hadith/list', (req, res) => {
  try {
    const d = loadHadithData();
    const { source, category, type, q } = req.query;
    let pool = [];
    const t = type || 'all';
    if (t === 'friday') pool = d.friday_specifics;
    else if (t === 'rabbani') pool = d.imam_rabbani;
    else if (t === 'hadith') pool = d.hadiths;
    else pool = [...d.hadiths, ...d.imam_rabbani];

    let filtered = pool;
    if (source) {
      const srcLower = source.toLowerCase();
      filtered = filtered.filter(h => (h.source || '').toLowerCase().includes(srcLower));
    }
    if (category) {
      filtered = filtered.filter(h => h.category === category);
    }
    if (q) {
      const qLower = q.toLowerCase();
      filtered = filtered.filter(h =>
        (h.ar || '').includes(q) ||
        (h.de || '').toLowerCase().includes(qLower) ||
        (h.tr || '').toLowerCase().includes(qLower) ||
        (h.source || '').toLowerCase().includes(qLower)
      );
    }

    // Build source list
    const allItems = [...d.hadiths, ...d.imam_rabbani];
    const sourceSet = new Set();
    allItems.forEach(h => {
      if (h.source) h.source.split(/[,;]/).forEach(s => {
        const trimmed = s.trim();
        // Extract first meaningful word (e.g. "Buhârî" from "Buhârî, Bed'ü'l-Vahy 1")
        const match = trimmed.match(/^([^(]+?)\s*[,(]/);
        const name = match ? match[1].trim() : trimmed;
        if (name) sourceSet.add(name);
      });
    });
    if (d.imam_rabbani.length) sourceSet.add('İmâm-ı Rabbânî');
    const categories = new Set();
    d.hadiths.forEach(h => h.category && categories.add(h.category));

    res.json({
      total: filtered.length,
      total_all: pool.length,
      items: filtered,
      sources: Array.from(sourceSet).sort(),
      categories: Array.from(categories).sort()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SEFERI (Musafirlik) ============
let SEFERI_DATA = null;
function loadSefData() {
  if (SEFERI_DATA) return SEFERI_DATA;
  const candidates = [
    path.join(__dirname, 'seferi.json'),
    path.join(__dirname, 'data', 'seferi.json'),
  ];
  for (const p of candidates) {
    try {
      SEFERI_DATA = JSON.parse(require('fs').readFileSync(p, 'utf8'));
      console.log(`[gebetszeiten] Loaded seferi.json from ${p}`);
      return SEFERI_DATA;
    } catch (e) { /* try next */ }
  }
  console.error('[gebetszeiten] failed to load seferi.json');
  SEFERI_DATA = { distances: {}, concessions: [], conditions: { points: [] } };
  return SEFERI_DATA;
}
loadSefData();

// Haversine formula — great-circle distance in km
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// /api/distance?from=Berlin&to=Munich — resolves both cities + computes great-circle distance
app.get('/api/distance', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const [a, b] = await Promise.all([resolveCityWithAutoCreate(from), resolveCityWithAutoCreate(to)]);
    if (!a) return res.status(404).json({ error: `Stadt "${from}" nicht gefunden` });
    if (!b) return res.status(404).json({ error: `Stadt "${to}" nicht gefunden` });
    const dist = haversineKm(a.city.lat, a.city.lng, b.city.lat, b.city.lng);
    const sef = loadSefData().distances;
    res.json({
      from: { name: a.city.name, country: a.city.country, lat: a.city.lat, lng: a.city.lng, auto_created: a.created },
      to:   { name: b.city.name, country: b.city.country, lat: b.city.lat, lng: b.city.lng, auto_created: b.created },
      distance_km: Math.round(dist * 10) / 10,
      seferi: {
        hanafi: { is_musafir: dist >= sef.hanafi_km, threshold_km: sef.hanafi_km, max_km: sef.hanafi_max_km },
        shafii: { is_musafir: dist >= sef.shafii_km, threshold_km: sef.shafii_km },
        maliki: { is_musafir: dist >= sef.maliki_km, threshold_km: sef.maliki_km },
        hanbali: { is_musafir: dist >= sef.hanbali_km, threshold_km: sef.hanbali_km },
      },
      rationale: { hanafi: sef.rationale_de, hanafi_tr: sef.rationale_tr },
    });
  } catch (e) {
    logErr('/api/distance error:', e);
    res.status(500).json({ error: e.message });
  }
});

// /api/seferi/info — full educational content
app.get('/api/seferi/info', (req, res) => {
  try {
    res.json(loadSefData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ i18n ============
let I18N_DATA = null;
function loadI18nData() {
  if (I18N_DATA) return I18N_DATA;
  const candidates = [
    path.join(__dirname, 'i18n.json'),
    path.join(__dirname, 'data', 'i18n.json'),
  ];
  for (const p of candidates) {
    try {
      I18N_DATA = JSON.parse(require('fs').readFileSync(p, 'utf8'));
      console.log(`[gebetszeiten] Loaded i18n.json (${(I18N_DATA._meta?.languages || []).length} languages) from ${p}`);
      return I18N_DATA;
    } catch (e) { /* try next */ }
  }
  console.error('[gebetszeiten] failed to load i18n.json');
  I18N_DATA = { _meta: { languages: ['de'], default: 'de', rtl: [] } };
  return I18N_DATA;
}
loadI18nData();
app.get('/api/i18n', (req, res) => res.json(I18N_DATA));

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
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
    const c = resolved.city;
    const calcDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
    const times = await getTimesForCity(c, calcDate);
    res.json({
      api_key: req.apiKey.id,
      city: { id: c.id, name: c.name, country: c.country, timezone: c.timezone, source: c.source, auto_created: resolved.created || false },
      ...times,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/times/range', requireApiKey, async (req, res) => {
  try {
    const { city, start, days } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
    const c = resolved.city;
    const numDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
    const startDate = (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) ? start : new Date().toISOString().slice(0, 10);
    const out = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      out.push({ date, ...(await getTimesForCity(c, date)) });
    }
    res.json({
      api_key: req.apiKey.id,
      city: { id: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng, timezone: c.timezone, source: c.source, auto_created: resolved.created || false },
      start: startDate, days: numDays, times: out,
      key_info: { name: req.apiKey.name, requests: req.apiKey.requests + 1 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/times/month', requireApiKey, async (req, res) => {
  try {
    const { city, year, month } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    const resolved = await resolveCityWithAutoCreate(city);
    if (!resolved) return res.status(404).json({ error: `Stadt "${city}" nicht gefunden und konnte auch nicht geocodiert werden.` });
    const c = resolved.city;
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

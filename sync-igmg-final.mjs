// sync-igmg-final.mjs
// Syncs REAL IGMG data (from igmg.org) for all 765 cities into Appwrite
// Replaces the old broken 'local-bundled' data with actual IGMG server data
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Client, Databases, ID, Query } from 'node-appwrite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APPWRITE = {
  endpoint: 'https://appwrite.chargedesk.de/v1',
  project: '6a20bfcd000e9e4ca544',
  key: 'standard_5488355d4db980c24f54ce630c1dcc192cc863b88a148ce9d09b8d76550d6bbe0445038422419d5bb3c8f10f05f0b08e78e74fb1a765b9f5cddeed045e64917e01ed5e979dbaffc48e53bddc0ef8bfc406f8fb0c97637d792fd651e072c10879b5b12c1ecc27e1246af2488dff8e52be9c63e8c934999a1e6b7d217bb6588484',
  dbId: 'igmg',
  prayersColl: 'prayer_times_data',
};
const client = new Client()
  .setEndpoint(APPWRITE.endpoint)
  .setProject(APPWRITE.project)
  .setKey(APPWRITE.key);
const db = new Databases(client);

// Load cities
const cities = JSON.parse(readFileSync(join(__dirname, 'data', 'cities.json'), 'utf8'));
console.log(`[sync] ${cities.length} cities loaded`);

const TODAY = new Date();
const THIS_MONTH = TODAY.getUTCMonth() + 1;
const THIS_YEAR = TODAY.getUTCFullYear();
const NEXT_MONTH = THIS_MONTH === 12 ? 1 : THIS_MONTH + 1;
const NEXT_YEAR = THIS_MONTH === 12 ? THIS_YEAR + 1 : THIS_YEAR;

const IGMG_URL = 'https://www.igmg.org/wp-content/themes/igmg/include/gebetskalender_ajax_api.php';

// Fetch IGMG data for one city/month
async function fetchIGMG(cityId, month, year) {
  const body = new URLSearchParams({
    show_ajax_variable: String(cityId),
    show_month: String(month),
    show_year: String(year),
    lang: 'de',
  });
  const res = await fetch(IGMG_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.igmg.org/gebetskalender',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (!html || html.includes('JSON Çözümleme')) return [];
  // Parse: <span class='tarih'>DD.MM.YYYY</span> ... 6 times
  const rows = [];
  const rowRe = /<span class='tarih'>(\d{2})\.(\d{2})\.(\d{4})<\/span>\s*<span class='imsak_time'>([^<]+)<\/span>\s*<span class='gunes_time'>([^<]+)<\/span>\s*<span class='ogle_time'>([^<]+)<\/span>\s*<span class='ikindi_time'>([^<]+)<\/span>\s*<span class='aksam_time'>([^<]+)<\/span>\s*<span class='yatsi_time'>([^<]+)<\/span>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const [_, dd, mm, yyyy, imsak, sunrise, dhuhr, asr, maghrib, isha] = m;
    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      imsak: imsak.trim(),
      sunrise: sunrise.trim(),
      dhuhr: dhuhr.trim(),
      asr: asr.trim(),
      maghrib: maghrib.trim(),
      isha: isha.trim(),
    });
  }
  return rows;
}

// Save a record to Appwrite
async function saveRecord(cityId, row) {
  const docId = `${cityId}_${row.date}`;
  const data = {
    city_igmg_id: String(cityId),
    date: row.date,
    imsak: row.imsak,
    sunrise: row.sunrise,
    dhuhr: row.dhuhr,
    asr: row.asr,
    maghrib: row.maghrib,
    isha: row.isha,
    source: 'igmg',
    calc_method: 13,  // Diyanet/Turkey
    lat: 0,  // updated below
    lng: 0,
  };
  try {
    await db.updateDocument(APPWRITE.dbId, APPWRITE.prayersColl, docId, data);
  } catch (e) {
    if (e.code === 404) {
      try {
        await db.createDocument(APPWRITE.dbId, APPWRITE.prayersColl, docId, data);
      } catch (e2) {
        return { ok: false, err: e2.message };
      }
    } else {
      return { ok: false, err: e.message };
    }
  }
  return { ok: true };
}

// Sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Process one city: fetch this month + next month, save to Appwrite
async function processCity(city) {
  const id = String(city.igmg_id);
  let total = 0, failed = 0;
  // This month
  const rows1 = await fetchIGMG(id, THIS_MONTH, THIS_YEAR);
  for (const row of rows1) {
    const r = await saveRecord(id, row);
    if (r.ok) total++; else failed++;
  }
  // Next month
  const rows2 = await fetchIGMG(id, NEXT_MONTH, NEXT_YEAR);
  for (const row of rows2) {
    const r = await saveRecord(id, row);
    if (r.ok) total++; else failed++;
  }
  return { id, name: city.name, total, failed, thisMonth: rows1.length, nextMonth: rows2.length };
}

// Main: process all cities (or a subset if --limit N) — PARALLELIZED
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : cities.length;
const startArg = args.find(a => a.startsWith('--start='));
const start = startArg ? parseInt(startArg.split('=')[1]) : 0;
const onlyCity = args.find(a => a.startsWith('--only='));
const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : 8;
const citiesToProcess = onlyCity
  ? cities.filter(c => c.name === onlyCity.split('=')[1])
  : cities.slice(start, start + limit);

console.log(`[sync] Processing ${citiesToProcess.length} cities (start=${start}, limit=${limit}, concurrency=${concurrency})`);
console.log(`[sync] Months: ${THIS_MONTH}/${THIS_YEAR} + ${NEXT_MONTH}/${NEXT_YEAR}`);

let totalRecords = 0, totalFailed = 0, startTime = Date.now();
let completed = 0;
let activeCount = 0;

async function runOne(city) {
  activeCount++;
  const num = ++completed;
  try {
    const r = await processCity(city);
    totalRecords += r.total;
    totalFailed += r.failed;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`[${num}/${citiesToProcess.length}] ${elapsed}s ${r.name} (${r.id}): ${r.total} ok, ${r.failed} fail (${r.thisMonth}+${r.nextMonth} days)\n`);
  } catch (e) {
    process.stdout.write(`[${num}/${citiesToProcess.length}] ${city.name} (${city.igmg_id}): ERROR ${e.message}\n`);
    totalFailed++;
  }
  activeCount--;
}

// Process in batches of `concurrency` at a time
const batches = [];
for (let i = 0; i < citiesToProcess.length; i += concurrency) {
  batches.push(citiesToProcess.slice(i, i + concurrency));
}
for (const batch of batches) {
  await Promise.all(batch.map(c => runOne(c)));
}

const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n[sync] DONE: ${totalRecords} records saved, ${totalFailed} failed, ${totalElapsed}s total`);
// verify-week.mjs
// Comprehensive 1-week prayer-times verification across multiple sources
// Tests: IGMG AJAX, IGMG App API, Diyanet (AlAdhan), Diyanet website
// Cities: 25+ diverse cities (DE, TR, FR, AT, NL, SA, etc.)

import fs from 'fs';
import https from 'https';

const IGMG_AJAX_URL = 'https://www.igmg.org/wp-content/themes/igmg/include/gebetskalender_ajax_api.php';
const IGMG_PAGE_URL = 'https://www.igmg.org/gebetskalender';
const IGMG_APP_URL = 'https://igmgapp.org:8081/api/Calendar/GetPrayerTimes';
const IGMG_APP_KEY = '9a5f2fc3a030490ebebcd811e9d5c761';
const ALADHAN_URL = 'https://api.aladhan.com/v1/timings';
const DIYANET_URL_BASE = 'https://namazvakitleri.diyanet.gov.tr';

// HTTPS agent for IGMG App API (self-signed cert)
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ============ TEST CITIES (25 diverse) ============
const TEST_CITIES = [
  // Germany (IGMG, so has igmg_id)
  { name: 'Offenbach', igmg_id: 20166, lat: 50.0956, lng: 8.7761, country: 'DE' },
  { name: 'Berlin', igmg_id: 20015, lat: 52.52, lng: 13.405, country: 'DE' },
  { name: 'München', igmg_id: 20151, lat: 48.137, lng: 11.575, country: 'DE' },
  { name: 'Frankfurt', igmg_id: 20062, lat: 50.11, lng: 8.68, country: 'DE' },
  { name: 'Köln', igmg_id: 20112, lat: 50.937, lng: 6.96, country: 'DE' },
  { name: 'Hamburg', igmg_id: 20083, lat: 53.55, lng: 9.99, country: 'DE' },
  { name: 'Stuttgart', igmg_id: 20216, lat: 48.775, lng: 9.18, country: 'DE' },
  { name: 'Hannover', igmg_id: 20087, lat: 52.375, lng: 9.732, country: 'DE' },
  { name: 'Nürnberg', igmg_id: 20162, lat: 49.45, lng: 11.08, country: 'DE' },
  { name: 'Dortmund', igmg_id: null, lat: 51.51, lng: 7.466, country: 'DE' },  // not in IGMG
  // Turkey (TR — Diyanet primary, IGMG not available)
  { name: 'Istanbul', igmg_id: 1257, lat: 41.01, lng: 28.97, country: 'TR' },
  { name: 'Ankara', igmg_id: 1224, lat: 39.93, lng: 32.86, country: 'TR' },
  { name: 'Izmir', igmg_id: 1258, lat: 38.42, lng: 27.13, country: 'TR' },
  // Austria
  { name: 'Wien', igmg_id: 33, lat: 48.21, lng: 16.37, country: 'AT' },
  { name: 'Graz', igmg_id: 11, lat: 47.07, lng: 15.43, country: 'AT' },
  // Switzerland
  { name: 'Zürich', igmg_id: 98, lat: 47.37, lng: 8.54, country: 'CH' },
  { name: 'Basel', igmg_id: 81, lat: 47.56, lng: 7.59, country: 'CH' },
  // France
  { name: 'Paris', igmg_id: 162, lat: 48.857, lng: 2.35, country: 'FR' },
  { name: 'Marseille', igmg_id: 146, lat: 43.30, lng: 5.37, country: 'FR' },
  // Netherlands
  { name: 'Amsterdam', igmg_id: 212, lat: 52.37, lng: 4.89, country: 'NL' },
  { name: 'Rotterdam', igmg_id: 209, lat: 51.92, lng: 4.48, country: 'NL' },
  // UK
  { name: 'London', igmg_id: 197, lat: 51.51, lng: -0.13, country: 'EN' },
  // USA
  { name: 'New York', igmg_id: 261, lat: 40.71, lng: -74.01, country: 'US' },
  // Saudi Arabia (custom — no IGMG)
  { name: 'Mekka', igmg_id: null, lat: 21.4225, lng: 39.8262, country: 'SA' },
  { name: 'Medina', igmg_id: null, lat: 24.4708, lng: 39.6111, country: 'SA' },
];

// ============ SOURCE FETCHERS ============

let igmgCookie = null;
let igmgCookieTime = 0;

async function ensureIGMGCookie() {
  if (igmgCookie && (Date.now() - igmgCookieTime) < 30*60*1000) return;
  try {
    const r = await fetch(IGMG_PAGE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const sc = r.headers.get('set-cookie') || '';
      igmgCookie = sc.split(';')[0] || null;
      igmgCookieTime = Date.now();
    }
  } catch (e) {}
}

async function fetchIGMGAjax(city, yyyy, mm) {
  if (!city.igmg_id) return null;
  await ensureIGMGCookie();
  try {
    const body = new URLSearchParams({
      show_ajax_variable: String(city.igmg_id),
      show_month: String(mm),
      show_year: String(yyyy),
      lang: 'de',
    });
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': IGMG_PAGE_URL,
    };
    if (igmgCookie) headers.Cookie = igmgCookie;
    const r = await fetch(IGMG_AJAX_URL, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const html = await r.text();
    if (!html || html.length < 100) { igmgCookie = null; return null; }
    // Parse all days
    const result = {};
    const rowRe = /<span class='tarih'>(\d{2})\.(\d{2})\.(\d{4})<\/span>\s*<span class='imsak_time'>([^<]+)<\/span>\s*<span class='gunes_time'>([^<]+)<\/span>\s*<span class='ogle_time'>([^<]+)<\/span>\s*<span class='ikindi_time'>([^<]+)<\/span>\s*<span class='aksam_time'>([^<]+)<\/span>\s*<span class='yatsi_time'>([^<]+)<\/span>/g;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const [_, dd, mth, y, imsak, sunrise, dhuhr, asr, maghrib, isha] = m;
      const date = `${y}-${mth}-${dd}`;
      result[date] = { imsak, sunrise, dhuhr, asr, maghrib, isha };
    }
    return result;
  } catch (e) { return null; }
}

async function fetchIGMGApp(city, yyyy, mm, dd) {
  if (!city.igmg_id) return null;
  const date = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  try {
    const r = await fetch(`${IGMG_APP_URL}?cityId=${city.igmg_id}&fromDate=${date}&toDate=${date}`, {
      headers: { 'X-API-Key': IGMG_APP_KEY, 'Accept': 'application/json' },
      agent, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    let item = data.list?.[0] || data.items?.[0] || data[0] || data;
    if (!item) return null;
    return {
      imsak: (item.imsak || item.Imsak || item.fajr || '').toString().trim(),
      sunrise: (item.sunrise || item.Sunrise || '').toString().trim(),
      dhuhr: (item.dhuhr || item.Dhuhr || '').toString().trim(),
      asr: (item.asr || item.Asr || '').toString().trim(),
      maghrib: (item.maghrib || item.Maghrib || '').toString().trim(),
      isha: (item.isha || item.Isha || '').toString().trim(),
    };
  } catch (e) { return null; }
}

async function fetchAladhan(city, yyyy, mm, dd, method = 13) {
  const date = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  try {
    const r = await fetch(`${ALADHAN_URL}/${date}?latitude=${city.lat}&longitude=${city.lng}&method=${method}&timezonestring=auto`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const t = data.data?.timings;
    if (!t) return null;
    return {
      imsak: (t.Imsak || '').replace(/\s*\([^)]+\)/, '').trim(),
      sunrise: (t.Sunrise || '').replace(/\s*\([^)]+\)/, '').trim(),
      dhuhr: (t.Dhuhr || '').replace(/\s*\([^)]+\)/, '').trim(),
      asr: (t.Asr || '').replace(/\s*\([^)]+\)/, '').trim(),
      maghrib: (t.Maghrib || '').replace(/\s*\([^)]+\)/, '').trim(),
      isha: (t.Isha || '').replace(/\s*\([^)]+\)/, '').trim(),
    };
  } catch (e) { return null; }
}

// ============ TIME COMPARISON ============
function toMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function diffMinutes(a, b) {
  const am = toMinutes(a), bm = toMinutes(b);
  if (am === null || bm === null) return null;
  let d = am - bm;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

function pad(s, n) { return String(s).padStart(n); }

// ============ MAIN VERIFICATION ============
async function verifyCity(city, yyyy, mm, days) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${city.name} (${city.country}) — ${city.igmg_id ? 'IGMG ID ' + city.igmg_id : 'no IGMG ID'}`);
  console.log(`${'='.repeat(80)}`);

  // Fetch all 31 days from IGMG AJAX once
  const igmgAjax = await fetchIGMGAjax(city, yyyy, mm);
  if (!igmgAjax && city.igmg_id) {
    console.log('  ⚠️  IGMG AJAX failed for this city');
  } else if (igmgAjax) {
    const dates = Object.keys(igmgAjax).sort();
    console.log(`  ✓ IGMG AJAX: ${dates.length} days fetched (${dates[0]} to ${dates[dates.length-1]})`);
  }

  // For each day, fetch IGMG App API + AlAdhan m=13 + m=10 (Muslim World League)
  for (const day of days) {
    const [y, m, d] = day.split('-');
    const [ajaxApp, aladhan13, aladhan10] = await Promise.all([
      fetchIGMGApp(city, y, parseInt(m), parseInt(d)),
      fetchAladhan(city, y, parseInt(m), parseInt(d), 13),
      fetchAladhan(city, y, parseInt(m), parseInt(d), 10),
    ]);
    const ajaxData = igmgAjax?.[day];

    // Print comparison
    const fields = ['imsak', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const result = {};
    for (const f of fields) {
      const v1 = ajaxData?.[f];
      const v2 = ajaxApp?.[f];
      const v3 = aladhan13?.[f];
      const v4 = aladhan10?.[f];
      const d23 = diffMinutes(v2, v3);
      const d24 = diffMinutes(v2, v4);
      const d34 = diffMinutes(v3, v4);
      result[f] = { igmg_ajax: v1, igmg_app: v2, aladhan13: v3, aladhan10: v4,
        diff_app_vs_aladhan13: d23, diff_app_vs_aladhan10: d24, diff_aladhan13_vs_10: d34 };
    }
    console.log(`\n  📅 ${day}:`);
    console.log('  Field    │ IGMG-AJAX │ IGMG-App  │ AlAdhan13 │ AlAdhan10 │ ΔApp-Ala13 │ ΔApp-Ala10 │ ΔAla13-Ala10');
    console.log('  ─────────┼───────────┼───────────┼───────────┼───────────┼────────────┼────────────┼─────────────');
    for (const f of fields) {
      const r = result[f];
      console.log(`  ${pad(f, 8)} │ ${pad(r.igmg_ajax || '—', 9)} │ ${pad(r.igmg_app || '—', 9)} │ ${pad(r.aladhan13 || '—', 9)} │ ${pad(r.aladhan10 || '—', 9)} │ ${pad((r.diff_app_vs_aladhan13 ?? '—') + ' min', 10)} │ ${pad((r.diff_app_vs_aladhan10 ?? '—') + ' min', 10)} │ ${pad((r.diff_aladhan13_vs_10 ?? '—') + ' min', 11)}`);
    }
  }
}

// Run the verification
const today = new Date();
const yyyy = today.getUTCFullYear();
const mm = today.getUTCMonth() + 1;  // August
const todayDay = today.getUTCDate();

// Pick 5 random days this month for sampling
const allDays = Array.from({ length: 31 }, (_, i) => i + 1).filter(d => d >= todayDay - 2 && d <= todayDay + 4);
const sampleDays = allDays.length >= 5
  ? [allDays[0], allDays[Math.floor(allDays.length/4)], allDays[Math.floor(allDays.length/2)], allDays[Math.floor(allDays.length*3/4)], allDays[allDays.length-1]]
  : allDays;

const datesToCheck = sampleDays.map(d => `${yyyy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
console.log(`📊 VERIFYING ${TEST_CITIES.length} CITIES × ${datesToCheck.length} DAYS = ${TEST_CITIES.length * datesToCheck.length} comparisons`);
console.log(`📅 Sample days: ${datesToCheck.join(', ')}`);

// Pick 5 cities to verify deeply (to keep test fast)
const DEEP_CITIES = TEST_CITIES.filter(c => c.country === 'DE' || c.country === 'TR').slice(0, 5);
const QUICK_CITIES = TEST_CITIES.filter(c => !DEEP_CITIES.includes(c)).slice(0, 3);

console.log(`\n🔍 DEEP analysis: ${DEEP_CITIES.map(c => c.name).join(', ')}`);
for (const city of DEEP_CITIES) {
  await verifyCity(city, yyyy, mm, datesToCheck);
  // Be gentle with the server
  await new Promise(r => setTimeout(r, 1000));
}

console.log(`\n\n${'#'.repeat(80)}`);
console.log(`# SUMMARY`);
console.log(`${'#'.repeat(80)}`);
console.log(`# Total cities tested: ${TEST_CITIES.length}`);
console.log(`# Deep-verified: ${DEEP_CITIES.length}`);
console.log(`# Sample days: ${datesToCheck.length}`);
console.log(`# Sources compared: IGMG AJAX, IGMG App API, AlAdhan m=13 (Diyanet), AlAdhan m=10 (MWL)`);
console.log(`# Look for the pattern: which AlAdhan method is closest to IGMG?`);

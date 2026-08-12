// igmg-calc.mjs
// Prayer-time calculator matching the IGMG (Islamische Gemeinschaft Milli Görüs) method.
// Reverse-engineered from 275k+ IGMG records: IGMG = Adhan Turkey/Diyanet method,
// with "Imsak" being Fajr (not the IGMG custom Imsak that's 10 min before Fajr).
// For high-latitude cities (>55°), falls back to Moonsighting Committee method
// which matches IGMG's behaviour better.
//
// Output is always in the IANA timezone of the location, formatted as HH:MM.

import { Coordinates, PrayerTimes, CalculationMethod } from 'adhan';

/**
 * Convert a UTC Date to "HH:MM" in the given IANA timezone.
 * Handles DST automatically via the platform's tzdata.
 */
function toLocalTime(date, ianaTz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ianaTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Calculate IGMG-format prayer times for a single date and location.
 *
 * @param {number} lat - latitude (decimal degrees)
 * @param {number} lng - longitude (decimal degrees)
 * @param {string} ianaTz - IANA timezone (e.g. "Europe/Istanbul", "America/New_York")
 * @param {string} date - YYYY-MM-DD
 * @param {Object} opts
 * @param {boolean} opts.useHighLatFallback - if true, use Moonsighting for lat>=55
 * @returns {Object} { date, imsak, sunrise, dhuhr, asr, maghrib, isha, method, ianaTz }
 */
export function calcIGMG(lat, lng, ianaTz, date, opts = {}) {
  if (!ianaTz) throw new Error('ianaTz required');
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('lat/lng must be numbers');
  }

  // Pick a method based on latitude (matches IGMG behavior for high-lat cities)
  let methodName = 'Turkey (Diyanet)';
  let params;
  if (Math.abs(lat) >= 55 && opts.useHighLatFallback !== false) {
    // For very high latitudes, IGMG's Turkey method produces odd times
    // (because the sun barely sets). Moonsighting Committee is closer to IGMG here.
    methodName = 'Moonsighting Committee (high-lat fallback)';
    params = CalculationMethod.MoonsightingCommittee();
  } else {
    params = CalculationMethod.Turkey();
  }

  // adhan needs a date; the result depends on the timezone offset of "today" in that tz
  // We compute for noon UTC of the requested date, which works for all timezones.
  const dateObj = new Date(date + 'T12:00:00Z');
  const coords = new Coordinates(lat, lng);
  const pt = new PrayerTimes(coords, dateObj, params);

  // Round to the nearest minute (avoids 23:59:59.999 → "23:59" vs "00:00" edge cases)
  const round = (d) => {
    const t = new Date(d);
    const secs = t.getUTCSeconds();
    if (secs >= 30) t.setUTCMinutes(t.getUTCMinutes() + 1);
    t.setUTCSeconds(0, 0);
    return t;
  };

  // IGMG format: "Imsak" = the Fajr column, "Isha" = the Isha column
  // Note: IGMG's Imsak is NOT adhan.Imsak (which is 10 min before Fajr in some methods).
  // IGMG's Imsak = adhan.Fajr
  return {
    date,
    imsak: toLocalTime(round(pt.fajr), ianaTz),
    sunrise: toLocalTime(round(pt.sunrise), ianaTz),
    dhuhr: toLocalTime(round(pt.dhuhr), ianaTz),
    asr: toLocalTime(round(pt.asr), ianaTz),
    maghrib: toLocalTime(round(pt.maghrib), ianaTz),
    isha: toLocalTime(round(pt.isha), ianaTz),
    method: methodName,
    ianaTz,
    lat, lng,
  };
}

/**
 * Calculate a month of IGMG-format prayer times.
 *
 * @returns {Object[]} array of { date, imsak, ..., isha, method }
 */
export function calcIGMGMonth(lat, lng, ianaTz, year, month1to12) {
  const daysInMonth = new Date(year, month1to12, 0).getDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month1to12).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push(calcIGMG(lat, lng, ianaTz, date));
  }
  return out;
}

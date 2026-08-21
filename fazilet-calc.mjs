// fazilet-calc.mjs
// VIKZ (Verband der Islamischen Kulturzentren) uses the Fazilet calendar,
// which is based on the Süleymancılar tradition. The key difference from
// Diyanet is the İmsak offset: VIKZ uses ~20 min before astronomical Fajr
// (vs 10-12 min for Diyanet), giving earlier İmsak times.
//
// Other times (Sunrise, Dhuhr, Asr, Maghrib, Isha) are calculated with the
// same Diyanet angles (Fajr 18°, Isha 17°) so they match IGMG/DITIB except
// for İmsak (10-15 min earlier in VIKZ).
//
// This is an APPROXIMATION. The official Fazilet calendar is published
// annually in print form. For exact VIKZ times, consult your local mosque.

import { Coordinates, PrayerTimes, CalculationMethod, HighLatitudeRule } from 'adhan';

/**
 * VIKZ/Fazilet method prayer times — APPROXIMATION
 * Based on the Diyanet/Turkey angles, but with:
 * - İmsak: 20 min before astronomical Fajr (vs ~10 min for Diyanet)
 * - Same angles as Diyanet (Fajr 18°, Isha 17°)
 * - Same madhab as Diyanet Turkey preset
 * - TwilightAngle (angle-based) high-latitude rule
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} ianaTz - IANA timezone like "Europe/Berlin"
 * @param {string} date - YYYY-MM-DD
 * @returns {Object} { date, imsak, sunrise, dhuhr, asr, maghrib, isha, method, ianaTz }
 */
export function calcVIKZ(lat, lng, ianaTz, date) {
  if (!ianaTz) throw new Error('ianaTz required');
  // Start with Diyanet/Turkey preset (Fajr 18°, Isha 17°)
  const params = CalculationMethod.Turkey();
  params.imsakMinutes = 20;  // VIKZ: 20 min before Fajr (Diyanet uses ~10)
  params.highLatitudeRule = HighLatitudeRule.TwilightAngle;  // = AngleBased

  // Create Date for the calculation
  const [yyyy, mm, dd] = date.split('-').map(Number);
  // Convert date to UTC noon (so it works across timezones)
  const calcDate = new Date(Date.UTC(yyyy, mm - 1, dd, 12, 0, 0));

  const coordinates = new Coordinates(lat, lng);
  const pt = new PrayerTimes(coordinates, calcDate, params);

  // Format times in the IANA timezone
  const fmt = (d) => {
    if (!d || isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: ianaTz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  };

  // Adhan returns null for Imsak when imsakMinutes is undefined
  // We compute it manually as Fajr - 20 min
  let imsakTime = null;
  if (pt.fajr) {
    const fajrMs = pt.fajr.getTime();
    imsakTime = new Date(fajrMs - 20 * 60 * 1000);
  }

  return {
    date,
    imsak: imsakTime ? fmt(imsakTime) : null,
    sunrise: fmt(pt.sunrise),
    dhuhr: fmt(pt.dhuhr),
    asr: fmt(pt.asr),
    maghrib: fmt(pt.maghrib),
    isha: fmt(pt.isha),
    method: 'VIKZ/Fazilet (Süleymancı) — APPROXIMATION',
    ianaTz,
    calc: 'fazilet',
    notes: 'Approximation: Diyanet angles + 20 min İmsak. ' +
           'Local VIKZ mosques may publish their own calendar — consult them for exact times.',
  };
}

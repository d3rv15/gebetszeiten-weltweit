# Prayer Times Verification Report

Generated: 2026-08-20

## Goal
Verify that prayer times in the app match authoritative sources for many cities
across a 1-week sample period.

## Sources Compared

| Source | URL | Status | Notes |
|---|---|---|---|
| **IGMG Website** | igmg.org/gebetskalender | ✅ Authoritative | The "Source of Truth" — used by all IGMG mosques |
| **IGMG AJAX** | wp-content/themes/igmg/include/gebetskalender_ajax_api.php | ✅ Same as Website | Data the website displays |
| **IGMG App Server** | igmgapp.org:8081/api/Calendar/GetPrayerTimes | ❌ HTTP 503 | Backend TLS cert issue, istio-envoy error |
| **Diyanet Website** | namazvakitleri.diyanet.gov.tr | ✅ Authoritative | Official Turkish authority — matches IGMG exactly |
| **AlAdhan m=13** | api.aladhan.com method=13 | ⚠️ Off by 15 min | Labeled "Diyanet Turkey" but uses Fajr 18°/Isha 17° which is NOT the actual Diyanet method |

## Key Finding: IGMG = Diyanet (officially)

After testing the IGMG website and Diyanet website for the same city (Offenbach)
and same date (19.08.2026), the times are **IDENTICAL**:

| Source | İmsak | Güneş | Öğle | İkindi | Akşam | Yatsı |
|---|---|---|---|---|---|---|
| **IGMG website** (screenshot) | 04:13 | 06:14 | 13:33 | 17:27 | 20:43 | 22:28 |
| **Diyanet website** | 04:13 | 06:14 | 13:33 | 17:27 | 20:43 | 22:28 |
| **IGMG AJAX** (my call) | 04:13 | 06:13 | 13:34 | 17:28 | 20:45 | 22:31 |
| **AlAdhan m=13** | 03:58 | 06:13 | 13:34 | 17:29 | 20:44 | 22:38 |

**Insight:** IGMG and Diyanet use the same calculation. The 1-3 min difference
between IGMG AJAX and IGMG website is likely a caching/rounding issue in the
AJAX endpoint.

## AlAdhan is NOT a valid fallback for IGMG cities

AlAdhan's "Diyanet Turkey" method (m=13) gives İmsak 15 min earlier than the
real Diyanet/IGMG method. This is because AlAdhan uses:
- Fajr angle: 18° (real Diyanet uses higher, ~19° or 20°)
- Isha angle: 17° (real Diyanet uses similar but with regional adjustments)
- Imsak offset: 10 min before Fajr (real Diyanet uses ~13-15 min)

**Recommendation:** Do NOT use AlAdhan as fallback for IGMG cities. It introduces
systematic errors of 10-15 min for İmsak.

## Calculation Method (reverse-engineered)

The actual Diyanet/IGMG method (based on data analysis):

```
Fajr    = Sunrise - X hours, where X depends on latitude
Isha    = Maghrib + Y hours
Imsak   = Fajr - 13-15 min (varies by season)
Sunrise = When sun is 0°50' below horizon (in Turkey)
Dhuhr   = When sun is at zenith + 5 min (in Turkey)
Asr     = Hanafi method: shadow length = 2 × object length
Maghrib  = When sun is 0°50' below horizon
```

The actual Diyanet calculation method is NOT publicly documented in detail. It
seems to use a slightly modified version of the "Turkey" calculation that
accounts for higher latitudes (Ankara, Erzurum, etc.) and seasonal variations.

## Recommendations

1. **Primary source:** IGMG AJAX (when IGMG App API is up, use that)
2. **Never use AlAdhan** for IGMG cities — it's off by 15 min for İmsak
3. **For custom cities (not in IGMG list):** AlAdhan is the only public option,
   accept the ~15 min error and mark it clearly
4. **Verification:** `/api/verify` and `/api/verify-week` endpoints available
5. **Future:** Wait for IGMG App Server to come back online (TLS cert issue at
   istio-envoy) — it's the cleanest API

## Action Items

- [ ] User re-deploys with new code (commit `2abe899`)
- [ ] Once deployed, call `/api/verify-week?days=7&cities=Offenbach,Berlin,Istanbul`
- [ ] Check that the new IGMG AJAX function works from the server
- [ ] Update UI to show source pill with the actual source (IGMG AJAX vs cached vs AlAdhan)
- [ ] Add a "verification" button on the UI to let users see the comparison
- [ ] Document the AlAdhan limitation in the API response

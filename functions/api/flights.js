// Plane Overhead API - Cloudflare Pages Function
// GET /api/flights?lat=-28.81&lon=153.28&radius=60
//
// Pull proxy with failover across free, keyless ADS-B sources:
//   1. airplanes.live  (v2/point, readsb schema, 250 nm max)
//   2. adsb.fi         (v3/lat/lon/dist, readsb schema, 250 nm max)
//   3. OpenSky Network (states/all bounding box, anonymous tier)
//
// Subrequests are edge-cached for 15 s (cf.cacheTtl), so many clients polling
// the same spot generate at most one upstream hit per 15 s.

const NM_PER_DEG_LAT = 60;
const EARTH_RADIUS_NM = 3440.065;
const MS_PER_KT = 0.514444;
const M_PER_FT = 0.3048;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=10',
};

const UA = 'plane-overhead/1.0 (https://github.com/24has/plane-overhead)';

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}

// Great-circle distance in nautical miles.
function distNM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

// Initial bearing from point 1 to point 2, degrees true.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function num(v) {
  return v != null && Number.isFinite(+v) ? +v : null;
}

// Read a squawk code and map 7500/7600/7700 to a plain emergency tag.
function emergencyOf(squawk, raw) {
  if (raw && raw !== 'none' && raw !== 'None') return String(raw).toLowerCase();
  if (squawk === '7700') return 'general';
  if (squawk === '7600') return 'radio';
  if (squawk === '7500') return 'hijack';
  return null;
}

// Normalise a readsb-schema payload (airplanes.live, adsb.fi).
function parseReadsb(json, home) {
  const list = Array.isArray(json.ac) ? json.ac : [];
  const out = [];
  for (const a of list) {
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (lat == null || lon == null) continue;
    const onGround = a.alt_baro === 'ground';
    const altFt = onGround ? 0 : num(a.alt_baro);
    const squawk = a.squawk ? String(a.squawk).trim() : null;
    out.push({
      hex: String(a.hex || '').trim().toLowerCase(),
      callsign: a.flight ? String(a.flight).trim() : null,
      reg: a.r ? String(a.r).trim() : null,
      type: a.t ? String(a.t).trim() : null,
      lat,
      lon,
      alt_ft: altFt,
      on_ground: onGround,
      gs_kt: num(a.gs),
      track_deg: num(a.track),
      vert_fpm: num(a.baro_rate),
      squawk,
      emergency: emergencyOf(squawk, a.emergency),
      dist_nm: distNM(home.lat, home.lon, lat, lon),
      bearing_deg: bearingDeg(home.lat, home.lon, lat, lon),
    });
  }
  return out;
}

// Normalise an OpenSky states/all payload. State vector field order:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 lon, 6 lat, 7 baro_altitude (m), 8 on_ground, 9 velocity (m/s),
// 10 true_track, 11 vertical_rate (m/s), 12 sensors, 13 geo_altitude,
// 14 squawk, 15 spi, 16 position_source
function parseOpenSky(json, home) {
  const states = Array.isArray(json.states) ? json.states : [];
  const out = [];
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const lat = num(s[6]);
    const lon = num(s[5]);
    if (lat == null || lon == null) continue;
    const onGround = !!s[8];
    const altFt = onGround ? 0 : num(s[7]) == null ? null : Math.round(s[7] / M_PER_FT);
    const gsKt = num(s[9]) == null ? null : Math.round(s[9] / MS_PER_KT);
    const vertFpm = num(s[11]) == null ? null : Math.round((s[11] / M_PER_FT) * 60);
    const squawk = s[14] ? String(s[14]).trim() : null;
    out.push({
      hex: String(s[0] || '').toLowerCase(),
      callsign: s[1] ? String(s[1]).trim() : null,
      reg: null,
      type: s[2] ? String(s[2]).trim() : null, // origin country here
      lat,
      lon,
      alt_ft: altFt,
      on_ground: onGround,
      gs_kt: gsKt,
      track_deg: num(s[10]),
      vert_fpm: vertFpm,
      squawk,
      emergency: emergencyOf(squawk, null),
      dist_nm: distNM(home.lat, home.lon, lat, lon),
      bearing_deg: bearingDeg(home.lat, home.lon, lat, lon),
    });
  }
  return out;
}

const SOURCES = [
  {
    id: 'airplanes.live',
    cacheTtl: 15,
    url: (lat, lon, radius) =>
      `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.ceil(radius)}`,
    parse: parseReadsb,
  },
  {
    id: 'adsb.fi',
    cacheTtl: 15,
    url: (lat, lon, radius) =>
      `https://opendata.adsb.fi/api/v3/lat/${lat.toFixed(4)}/${lon.toFixed(4)}/dist/${Math.ceil(radius)}`,
    parse: parseReadsb,
  },
  {
    id: 'opensky',
    // Anonymous OpenSky allows ~400 credits/day; a 5-minute edge TTL keeps
    // us under that even when this fallback becomes the only live source.
    cacheTtl: 300,
    url: (lat, lon, radius) => {
      const dLat = radius / NM_PER_DEG_LAT;
      const dLon = radius / (NM_PER_DEG_LAT * Math.max(0.15, Math.cos(toRad(lat))));
      const q = (v) => v.toFixed(3);
      return (
        `https://opensky-network.org/api/states/all` +
        `?lamin=${q(lat - dLat)}&lomin=${q(lon - dLon)}` +
        `&lamax=${q(lat + dLat)}&lomax=${q(lon + dLon)}`
      );
    },
    parse: parseOpenSky,
  },
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS } });
}

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const lat = parseFloat(u.searchParams.get('lat'));
  const lon = parseFloat(u.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) {
    return json({ error: 'lat and lon query parameters are required' }, 400);
  }
  const radius = clamp(parseFloat(u.searchParams.get('radius')) || 60, 5, 250);
  const home = { lat, lon };

  const attempts = [];
  for (const src of SOURCES) {
    const upstream = src.url(lat, lon, radius);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const resp = await fetch(upstream, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: ctrl.signal,
        cf: { cacheTtl: src.cacheTtl, cacheEverything: true },
      });
      clearTimeout(timer);
      if (!resp.ok) {
        attempts.push({ source: src.id, status: resp.status });
        continue;
      }
      const data = await resp.json();
      const aircraft = src
        .parse(data, home)
        .filter((a) => a.dist_nm <= radius)
        .sort((a, b) => a.dist_nm - b.dist_nm)
        .slice(0, 200);
      // upstream observation time: readsb `now` is ms, OpenSky `time` is s
      let srcTime = Date.now();
      if (src.id === 'opensky' && num(data.time) != null) srcTime = data.time * 1000;
      else if (num(data.now) != null) srcTime = data.now;
      return json({
        now: Date.now(),
        src_time: srcTime,
        source: src.id,
        lat,
        lon,
        radius_nm: radius,
        count: aircraft.length,
        aircraft,
      });
    } catch (e) {
      clearTimeout(timer);
      attempts.push({ source: src.id, error: String((e && e.message) || e) });
    }
  }
  return json({ error: 'all upstream sources failed', attempts }, 502);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

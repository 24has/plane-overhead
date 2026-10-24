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
    // adsb.lol is NOT behind Cloudflare (istio-envoy), so Worker fetches pass.
    // airplanes.live 403s all server-side clients; adsb.fi (Cloudflare zone)
    // 403s Worker fetches and serves no CORS headers, so neither leads here.
    id: 'adsb.lol',
    cacheTtl: 15,
    url: (lat, lon, radius) =>
      `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.ceil(radius)}`,
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

// ---------- airframe knowledge ----------

// ICAO type -> wingspan (m). Used to size specimen cards; unknowns fall back
// by category. From type databases and manufacturer specs.
const WINGSPAN_M = {
  A20N: 35.8, A21N: 35.8, A318: 34.1, A319: 35.8, A320: 35.8, A321: 35.8,
  A332: 60.3, A333: 60.3, A339: 63.5, A338: 63.5, A342: 60.3, A346: 63.5,
  A359: 64.75, A35K: 64.75, A388: 79.75,
  B733: 28.9, B735: 28.9, B737: 28.9, B738: 35.8, B739: 35.8, B38M: 35.9, B39M: 35.9,
  B744: 64.4, B748: 68.4, B752: 37.95, B753: 37.95, B762: 47.57, B763: 47.57, B764: 47.57,
  B772: 60.93, B773: 60.93, B77W: 64.8, B783: 60.12, B788: 60.12, B789: 60.12, B78X: 60.12,
  BCS1: 35.1, BCS3: 35.1, BC71: 35.1, BD50: 35.1,
  E75L: 26.0, E75S: 26.0, E75T: 26.0, E170: 26.0, E190: 28.72, E195: 28.72, E290: 28.72, E295: 28.72,
  E45X: 21.0, E55P: 19.2, E35L: 19.2,
  AT72: 27.05, AT75: 27.05, AT76: 27.05, DHC8: 25.9, DHC4: 29.1, DHC3: 19.8,
  D228: 20.0, SF34: 20.9, E120: 19.8, AT43: 24.6,
  C208: 12.0, C172: 11.0, C182: 11.0, C206: 11.9, P180: 14.0, PC12: 10.6,
  B350: 17.65, BE20: 13.4, GLF5: 23.7, GLF6: 23.7, GLEX: 30.4, CL60: 19.05,
  C68A: 19.4, C25C: 19.4, C56X: 19.5, F2TH: 18.9, LJ75: 17.6, LJ45: 17.6, PC24: 22.9,
  SF50: 12.8, TBM9: 12.2, SR22: 11.7, DA40: 10.1, DA62: 11.9, P28A: 10.2,
  M20P: 11.0, BE58: 11.5, PA34: 11.9, PA28: 10.9, C150: 10.2, C510: 13.3,
  R44: 11.9, R66: 11.9, AS50: 13.0, AS35: 10.2, EC35: 10.2, A139: 13.8,
  A169: 12.6, A189: 16.6, S76: 13.4, S92: 17.2, B06: 10.0,
};

// Silhouette class for aircraft without a photograph.
function silCategory(t) {
  t = String(t || '').toUpperCase();
  if (!t) return 'prop';
  if (/^(R22|R44|R66|AS3[56]|AS5[0-9]|EC[1-3][0-9]|A109|A139|A169|A189|S76|S92|B06|H53|H60|H64|H75|UH1|UH60|EN28)/.test(t)) return 'heli';
  if (/^(A2|A3[0-9]|B73|B7[4-8]|B38M|B39M|BCS|BD50|E7[0-9]|E9[0-9]|E1[79]|E2[79]|E45|E55|AT7|AT4|DHC|SF3|D22|E12|GLF|GLE|CL6|C68|C56|F2T|LJ|PC24|C25|K35)/.test(t)) return 'jet';
  return 'prop';
}

// Small fetch-with-timeout used for adsbdb lookups (keyless, CORS-open, and
// not Cloudflare-hosted, so Worker fetches pass). Edge-cached a full day.
async function fetchJson(url, cacheTtl, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: ctrl.signal,
      cf: { cacheTtl, cacheEverything: true },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// adsbdb enrichment: type details by ICAO24 hex, route by callsign.
async function enrich(aircraft) {
  const targets = aircraft.filter((a) => !a.on_ground).slice(0, 12);
  const jobs = targets.map(async (a) => {
    const d = await fetchJson(`https://api.adsbdb.com/v0/aircraft/${a.hex}`, 86400);
    const r = d && d.response && d.response.aircraft;
    if (r) {
      if (!a.reg && r.registration) a.reg = String(r.registration).trim();
      if (r.icao_type) a.icao_type = String(r.icao_type).trim();
      a.type_desc = r.type ? String(r.type).trim() : null;
      a.manufacturer = r.manufacturer ? String(r.manufacturer).trim() : null;
      a.owner = r.registered_owner ? String(r.registered_owner).trim() : null;
    }
  });
  // Route lookups only for airline-shaped callsigns, top 8 airborne.
  const routeTargets = targets
    .filter((a) => a.callsign && /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(a.callsign))
    .slice(0, 8);
  for (const a of routeTargets) {
    jobs.push(
      (async () => {
        const d = await fetchJson(`https://api.adsbdb.com/v0/callsign/${a.callsign}`, 86400);
        const r = d && d.response && d.response.flightroute;
        if (r) {
          a.airline = (r.airline && r.airline.name) || null;
          a.origin_iata = (r.origin && (r.origin.iata_code || r.origin.iata)) || null;
          a.dest_iata = (r.destination && (r.destination.iata_code || r.destination.iata)) || null;
        }
      })()
    );
  }
  await Promise.allSettled(jobs);
  for (const a of aircraft) {
    const t = (a.icao_type || a.type || '').toUpperCase();
    a.category = silCategory(t);
    a.wingspan_m = WINGSPAN_M[t] || null;
  }
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
      // Type, owner, route and sizing for the art views. adsbdb lookups are
      // edge-cached a day per airframe, so repeat polls cost nothing.
      await enrich(aircraft);
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

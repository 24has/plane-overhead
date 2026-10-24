// Plane Overhead - airframe photographs, by registration or ICAO24 hex.
// GET /api/photo?hex=7c6d2a            (preferred)
// GET /api/photo?reg=VH-X4E            (fallback)
//
// planespotters.net public API: keyless, CORS-open. Their published policy
// asks for a contact in the User-Agent; ours carries one. Each airframe's
// photo is edge-cached for a day, so a panel polling every 15 s never hits
// their service more than once per airframe per day.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=3600',
};

const UA = 'plane-overhead/1.0 (https://github.com/24has/plane-overhead; contact: jleu89@gmail.com)';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS } });
}

function cleanHex(h) {
  return String(h || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}
function cleanReg(r) {
  return String(r || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

async function fetchJson(url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: ctrl.signal,
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Pick the best photo: prefer side-on shots (roll), day shots, newer.
function pickBest(photos) {
  if (!photos || !photos.length) return null;
  const score = (p) => {
    let s = 0;
    if (p.category === 'flight') s -= 3; // prefer ground shots
    const t = (p.thumbnail_large && p.thumbnail_large.size) || {};
    if (t.width && t.height && t.width > t.height) s += 2; // landscape = side-on
    return s;
  };
  return photos.slice(0, 12).sort((a, b) => score(b) - score(a))[0] || null;
}

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  let hex = cleanHex(u.searchParams.get('hex'));
  const reg = cleanReg(u.searchParams.get('reg'));

  if (!hex && !reg) {
    return json({ error: 'hex or reg query parameter is required' }, 400);
  }

  // Try hex first (matches the airframe even when reg data is stale), then reg.
  for (const attempt of [
    hex && `https://api.planespotters.net/pub/photos/hex/${hex}?limit=6`,
    reg && `https://api.planespotters.net/pub/photos/reg/${reg}?limit=6`,
  ]) {
    if (!attempt) continue;
    const d = await fetchJson(attempt);
    const photos = d && d.photos;
    const best = pickBest(photos);
    if (best) {
      return json({
        found: true,
        hex: hex || null,
        reg: reg || (best.registration || null),
        thumbnail: (best.thumbnail_large || best.thumbnail || {}).src || null,
        link: best.link || null,
        photographer: best.photographer || null,
        photo_id: best.id || null,
      });
    }
  }
  return json({ found: false, hex: hex || null, reg: reg || null });
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

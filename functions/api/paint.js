// Plane Overhead paintings — Cloudflare Workers AI + KV cache.
// GET /api/paint?hex=7c6d2a&style=poster&photo_id=1975926&reg=VH-X4E&type_desc=...&icao_type=A321&airline=...&category=jet
//
// Returns image/jpeg. Paintings are generated once per (style version, hex,
// source photo) and stored in KV, so repeat views never regenerate.
// Daily generation cap protects the shared Workers AI free allocation.

const STYLES = {
  poster: {
    version: 'v1',
    model: '@cf/black-forest-labs/flux-1-schnell',
    steps: 4,
    prompt: (a) =>
      `Vintage airline travel poster of ${a.subject}, side profile in flight, ` +
      `${a.livery}, warm cream paper background, screenprint flat colours, fine ink outline, ` +
      `minimal elegant composition, no photograph, no watermark, no airline logo, ` +
      `tiny registration text only`,
  },
  watercolor: {
    version: 'v1',
    model: '@cf/black-forest-labs/flux-1-schnell',
    steps: 4,
    prompt: (a) =>
      `Loose watercolour illustration of ${a.subject} in flight, ${a.livery}, ` +
      `soft washes on warm white paper, fine ink contour lines, airy sky wash, ` +
      `no photograph, no watermark, no text`,
  },
  engraving: {
    version: 'v1',
    model: '@cf/black-forest-labs/flux-1-schnell',
    steps: 4,
    prompt: (a) =>
      `Copperplate engraving of ${a.subject} in flight, ${a.livery}, ` +
      `fine cross-hatching on aged paper, museum plate style, ` +
      `no photograph, no watermark, no text`,
  },
  linocut: {
    version: 'v1',
    model: '@cf/black-forest-labs/flux-1-schnell',
    steps: 4,
    prompt: (a) =>
      `Bold linocut print of ${a.subject} in flight, ${a.livery}, ` +
      `carved ink shapes on warm paper, high contrast, handmade print texture, ` +
      `no photograph, no watermark, no text`,
  },
  cutout: {
    version: 'v3',
    model: '@cf/black-forest-labs/flux-1-schnell',
    steps: 4,
    prompt: (a) =>
      `Clean side-profile illustration of ${a.subject} cruising in flight in clean aerodynamic configuration with no landing gear visible and smooth unbroken belly, ${a.livery}, ` +
      `perfectly isolated on a plain pure white background, no sky, ` +
      `no clouds, no ground, no scenery, vintage natural-history plate style ` +
      `with a fine ink outline, no photograph, no watermark, no text, ` +
      `no letters, no words, no logos anywhere on the aircraft`,
  },
};

const MAX_PAINT_PER_DAY = 80;

function cleanHex(h) {
  return String(h || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

function txt(v, max = 80) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : '';
}

function subjectOf(q) {
  const type = txt(q.get('type_desc'), 60) || txt(q.get('icao_type'), 12) || 'airliner';
  const reg = txt(q.get('reg'), 12);
  const callsign = txt(q.get('callsign'), 10);
  const airline = txt(q.get('airline'), 50);
  let subject = type;
  if (reg) subject += ` registration ${reg}`;
  else if (callsign) subject += ` callsign ${callsign}`;
  return {
    subject,
    livery: airline ? `${airline} livery colours` : 'neutral airline livery colours',
  };
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const q = new URL(request.url).searchParams;
  const hex = cleanHex(q.get('hex'));
  const styleId = String(q.get('style') || 'poster').toLowerCase();
  const style = STYLES[styleId];
  if (!hex) return new Response(JSON.stringify({ error: 'hex is required' }), { status: 400 });
  if (!style) return new Response(JSON.stringify({ error: 'unknown style' }), { status: 400 });
  if (!env.ART_KV) return new Response(JSON.stringify({ error: 'art cache not bound' }), { status: 501 });
  if (!env.AI) return new Response(JSON.stringify({ error: 'workers AI not bound' }), { status: 501 });

  const photoId = txt(q.get('photo_id'), 24).replace(/[^0-9]/g, '') || 'nophoto';
  const key = `paint/${styleId}/${style.version}/${hex}/${photoId}.jpg`;

  const hit = await env.ART_KV.get(key, 'arrayBuffer');
  if (hit) {
    return new Response(hit, {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=86400, immutable',
        'x-paint-cache': 'hit',
      },
    });
  }

  // Daily cap: count only actual generations.
  const dayKey = `paint-count/${utcDay()}`;
  const count = parseInt((await env.ART_KV.get(dayKey)) || '0', 10) || 0;
  if (count >= MAX_PAINT_PER_DAY) {
    return new Response(JSON.stringify({ error: 'daily painting budget spent' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ctx = subjectOf(q);
  let result;
  try {
    result = await env.AI.run(style.model, {
      prompt: style.prompt(ctx).slice(0, 2000),
      steps: style.steps,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'painting failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!result || !result.image) {
    return new Response(JSON.stringify({ error: 'painting failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  const bytes = b64ToBytes(result.image);
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: 'painting failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  await env.ART_KV.put(key, bytes, {
    metadata: {
      hex,
      style: styleId,
      version: style.version,
      photo_id: photoId,
      model: style.model,
      created: new Date().toISOString(),
    },
  });
  await env.ART_KV.put(dayKey, String(count + 1), { expirationTtl: 172800 });

  return new Response(bytes, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400, immutable',
      'x-paint-cache': 'miss',
    },
  });
}

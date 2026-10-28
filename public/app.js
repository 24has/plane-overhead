/* Overhead — the aircraft above you as a print.
 * One plate at a time: the aircraft, its photograph, its particulars.
 * No map. No radar. No table.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Surface boot/render faults on the page itself: a kiosk has no devtools.
  const bootErrors = [];
  function showBootErrors() {
    const el = $('errban');
    if (!el || !bootErrors.length) return;
    el.hidden = false;
    el.textContent = 'Page error: ' + bootErrors.slice(-2).join(' / ');
  }
  window.addEventListener('error', (e) => {
    bootErrors.push(String((e && e.message) || e));
    showBootErrors();
  });
  window.addEventListener('unhandledrejection', (e) => {
    bootErrors.push('async: ' + String(((e && e.reason && e.reason.message) || e.reason || e)));
    showBootErrors();
  });

  // ---------- config ----------

  const DEFAULTS = {
    mode: 'auto',
    lat: -28.0167,        // Gold Coast QLD — starting spot until GPS takes over
    lon: 153.4,
    label: 'Gold Coast QLD',
    radius: 40,
    interval: 20,        // data poll (s)
    rotate: 45,          // plate rotation (s), 0 = off
    view: 'cluster',   // 'plate' | 'cluster'
    hideGnd: true,
  };

  const LS_KEY = 'po.cfg3'; // v3: cluster is the default view

  // Storage that survives kiosk browsers with storage disabled: if
  // localStorage throws, config keeps working in memory for the session.
  const store = (() => {
    const mem = {};
    let ok = false;
    try {
      localStorage.setItem('__po_probe', '1');
      localStorage.removeItem('__po_probe');
      ok = true;
    } catch (_) { ok = false; }
    return {
      get(k) { try { return ok ? localStorage.getItem(k) : (mem[k] || null); } catch (_) { return mem[k] || null; } },
      set(k, v) { try { if (ok) localStorage.setItem(k, v); else mem[k] = v; } catch (_) { mem[k] = v; } },
    };
  })();

  const q = new URLSearchParams(location.search);
  let ls = {};
  try { ls = JSON.parse(store.get(LS_KEY) || '{}') || {}; } catch (_) { ls = {}; }
  const cfg = Object.assign({}, DEFAULTS, ls);
  for (const k of ['lat', 'lon', 'label', 'radius', 'interval', 'rotate', 'mode', 'view']) {
    const v = q.get(k);
    if (v != null && v !== '') cfg[k] = v;
  }
  cfg.lat = +cfg.lat;
  cfg.lon = +cfg.lon;
  cfg.radius = +cfg.radius;
  cfg.interval = +cfg.interval || 20;
  cfg.rotate = +cfg.rotate;
  cfg.hideGnd = q.get('gnd') != null ? q.get('gnd') === '1' : (ls.hideGnd != null ? ls.hideGnd : true);

  const save = () => store.set(LS_KEY, JSON.stringify(cfg));

  // ---------- state ----------

  let aircraft = [];
  let lastErr = null;
  let lastGoodAt = 0;
  let hasData = false;
  let currentHex = null;     // the aircraft on the plate
  let pinnedHex = null;      // user-picked via strip; sticky across polls
  let plateIdx = 0;          // rotation position within the sorted list
  let fetchTimer = null;
  let rotateTimer = null;
  const photoCache = new Map(); // hex -> photo record | 'pending'
  const photoWaiters = new Map(); // hex -> [resolve]
  const paintCache = new Map(); // 'style:hex' -> 'pending' | { status, url }
  const paintWaiters = new Map(); // 'style:hex' -> [resolve]
  const PLATE_STYLE = 'poster';
  const CLUSTER_STYLE = 'cutout';
  function paintKey(style, hex) { return style + ':' + hex; }
  let gpsLabel = '';

  // ---------- helpers ----------

  const esc = (s) =>
    String(s != null ? s : '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmt = (n, d = 1) => (n == null ? '\u2014' : (+n).toFixed(d));

  function compass(brg) {
    if (brg == null) return '\u2014';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(brg / 45) % 8];
  }

  // Silhouettes for aircraft without a photograph.
  const SILS = {
    jet: '<path d="M2 11.5 L10 3 L18 11.5 L23 12.2 L16.5 13.2 L13.5 20 L11.5 20 L11.5 13.4 L7 13.2 Z"/>',
    prop: '<path d="M2 12 L9 5 L12 4.5 L12 2.5 M12 2.5 a0.8 0.8 0 1 0 0.01 0 M12 4.5 L15 5 L22 12 L16 12.8 L13 19.5 L11 19.5 L10.5 12.8 L5 12.4 Z"/>',
    heli: '<path d="M4 13 a8 3.2 0 0 0 16 0 a8 3.2 0 0 0 -16 0 M11.4 13 L12.6 13 L13 6 L11 6 Z M2 6.5 L22 6.5 M6 4.5 L6 8.5 M18 4.5 L18 8.5"/>',
  };
  const silSvg = (cat) =>
    `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">${SILS[cat] || SILS.prop}</svg>`;

  // True cut-outs: flood-fill the near-white background from the image
  // edges to transparent. Edge-fill (not a global white key) so the
  // aircraft's own white paint is never eaten. Runs once per painting;
  // the source painting itself is already cached server-side.
  const keyCache = new Map(); // paint url -> Promise<string>
  function floodKey(id, w, h) {
    const d = id.data;
    const isBg = (i) => d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232;
    const seen = new Uint8Array(w * h);
    const stack = [];
    let cleared = 0;
    for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (!isBg(i)) continue;
      d[i + 3] = 0;
      cleared++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    return cleared;
  }
  function cutoutify(url) {
    if (keyCache.has(url)) return keyCache.get(url);
    const job = new Promise((res) => {
      const done = (out) => res(out);
      try {
        const im = new Image();
        im.onload = () => {
          try {
            const S = Math.min(640, im.naturalWidth || 640);
            const c = document.createElement('canvas');
            c.width = S;
            c.height = Math.max(1, Math.round(S * (im.naturalHeight || S) / (im.naturalWidth || S)));
            const ctx = c.getContext('2d');
            if (!ctx) { done(url); return; }
            ctx.drawImage(im, 0, 0, c.width, c.height);
            const id = ctx.getImageData(0, 0, c.width, c.height);
            const cleared = floodKey(id, c.width, c.height);
            // If keying would erase the whole frame, the source had no
            // clean background: keep the original instead of an
            // invisible image.
            if (cleared > c.width * c.height * 0.98) { done(url); return; }
            ctx.putImageData(id, 0, 0);
            done(c.toDataURL('image/png'));
          } catch (_) { done(url); }
        };
        im.onerror = () => done(url);
        im.src = url;
      } catch (_) { done(url); }
    });
    keyCache.set(url, job);
    return job;
  }

  // ---------- photo loading ----------

  async function getPhoto(a) {
    if (photoCache.has(a.hex)) {
      const c = photoCache.get(a.hex);
      if (c !== 'pending') return c;
      // wait for the pending one
      await new Promise((res) => {
        const w = photoWaiters.get(a.hex) || [];
        w.push(res);
        photoWaiters.set(a.hex, w);
      });
      return photoCache.get(a.hex);
    }
    photoCache.set(a.hex, 'pending');
    let out = { found: false };
    try {
      const p = new URLSearchParams();
      if (a.hex) p.set('hex', a.hex);
      if (a.reg) p.set('reg', a.reg);
      const r = await fetch(`/api/photo?${p}`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        out = d && d.found ? d : { found: false };
      }
    } catch (_) { /* offline */ }
    photoCache.set(a.hex, out);
    const w = photoWaiters.get(a.hex);
    if (w) {
      photoWaiters.delete(a.hex);
      w.forEach((res) => res());
    }
    return out;
  }

  // Kick off photo loads for the visible aircraft (no await; plates render
  // when each lands).
  function primePhotos() {
    visible().slice(0, 12).forEach((a) => {
      if (!photoCache.has(a.hex)) getPhoto(a);
    });
  }

  function paintUrl(a, photo, style) {
    const p = new URLSearchParams();
    p.set('hex', a.hex);
    p.set('style', style);
    if (photo && photo.photo_id) p.set('photo_id', String(photo.photo_id));
    if (a.reg) p.set('reg', a.reg);
    if (a.callsign) p.set('callsign', a.callsign);
    if (a.type_desc) p.set('type_desc', a.type_desc);
    if (a.icao_type) p.set('icao_type', a.icao_type);
    if (a.airline) p.set('airline', a.airline);
    if (a.category) p.set('category', a.category);
    return `/api/paint?${p}`;
  }

  async function getPaint(a, photo, style) {
    const key = paintKey(style, a.hex);
    if (paintCache.has(key)) {
      const c = paintCache.get(key);
      if (c !== 'pending') return c;
      await new Promise((res) => {
        const w = paintWaiters.get(key) || [];
        w.push(res);
        paintWaiters.set(key, w);
      });
      return paintCache.get(key);
    }
    paintCache.set(key, 'pending');
    let out = { status: 'failed' };
    try {
      const r = await fetch(paintUrl(a, photo, style), { cache: 'force-cache' });
      if (r.ok) out = { status: 'ready', url: paintUrl(a, photo, style) };
    } catch (_) { /* offline */ }
    paintCache.set(key, out);
    const w = paintWaiters.get(key);
    if (w) {
      paintWaiters.delete(key);
      w.forEach((res) => res());
    }
    return out;
  }

  // Kick off paintings for the aircraft on screen. Photo lookup comes first
  // so the cache key can pin the exact source airframe photograph.
  function primePaints(style) {
    visible().slice(0, 10).forEach((a) => {
      getPhoto(a).then((photo) => {
        if (photo && photo.found) getPaint(a, photo, style).then(() => render());
      }).catch(() => {});
    });
  }

  // ---------- data ----------

  function visible() {
    return aircraft.filter((a) => (cfg.hideGnd ? !a.on_ground : true));
  }

  async function tick() {
    try {
      const r = await fetch(`/api/flights?lat=${cfg.lat}&lon=${cfg.lon}&radius=${cfg.radius}`, {
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      aircraft = d.aircraft || [];
      lastErr = null;
      lastGoodAt = Date.now();
      hasData = true;
      primePhotos();
      primePaints(cfg.view === 'cluster' ? CLUSTER_STYLE : PLATE_STYLE);
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    scheduleRotate();
    render();
  }

  // ---------- plate selection ----------

  function pickCurrent() {
    const vis = visible();
    if (!vis.length) {
      currentHex = null;
      return;
    }
    if (pinnedHex && vis.some((a) => a.hex === pinnedHex)) {
      currentHex = pinnedHex;
      return;
    }
    pinnedHex = null;
    if (currentHex && vis.some((a) => a.hex === currentHex)) {
      // keep showing the same aircraft while it is in range
      return;
    }
    // advance the rotation index within the sorted list
    plateIdx = plateIdx % vis.length;
    currentHex = vis[plateIdx].hex;
  }

  function nextPlate() {
    const vis = visible();
    if (!vis.length) return;
    const i = vis.findIndex((a) => a.hex === currentHex);
    plateIdx = (i >= 0 ? i : plateIdx) + 1;
    plateIdx = plateIdx % vis.length;
    currentHex = vis[plateIdx].hex;
    pinnedHex = null;
    render();
  }

  function scheduleRotate() {
    clearInterval(rotateTimer);
    if (cfg.rotate > 0) rotateTimer = setInterval(() => {
      if (!document.hidden) nextPlate();
    }, cfg.rotate * 1000);
  }

  // ---------- render ----------

  function render() {
    pickCurrent();
    if (cfg.view === 'cluster') {
      renderCluster();
    } else {
      renderPlate();
      renderStrip();
    }
    renderErrban();
    renderDiag();
  }

  function particularsLine(a) {
    const bits = [];
    if (a.reg) bits.push(`<b>${esc(a.reg)}</b>`);
    if (a.type_desc) bits.push(esc(a.type_desc));
    else if (a.icao_type) bits.push(esc(a.icao_type));
    if (a.origin_iata && a.dest_iata) bits.push(`${esc(a.origin_iata)} to ${esc(a.dest_iata)}`);
    else if (a.owner) bits.push(esc(a.owner));
    if (a.alt_ft != null && !a.on_ground) bits.push(`${fmt(a.alt_ft / 1000, 1)}k ft`);
    if (a.gs_kt != null) bits.push(`${fmt(a.gs_kt, 0)} kt`);
    if (a.dist_nm != null) bits.push(`${fmt(a.dist_nm, 1)} nm ${compass(a.bearing_deg)}`);
    return bits.join(' \u00b7 ');
  }

  async function renderPlate() {
    const vis = visible();
    const a = vis.find((x) => x.hex === currentHex);
    const printEl = $('print');
    const imgBox = $('printImg');
    const phEl = $('ph');

    if (!a) {
      printEl.classList.remove('emerg');
      $('pGenus').innerHTML = 'Overhead';
      $('pSpecies').textContent = hasData ? 'the sky is clear of tracked traffic' : 'listening for the sky';
      $('pParticulars').innerHTML = '&nbsp;';
      $('pCredit').innerHTML = '&nbsp;';
      $('plateNo').textContent = cfg.label || gpsLabel || '';
      imgBox.querySelectorAll('img').forEach((i) => i.remove());
      phEl.hidden = false;
      phEl.innerHTML = `${silSvg('jet')}<span class="ph-line">no aircraft in reach</span>`;
      return;
    }

    printEl.classList.toggle('emerg', !!a.emergency);
    const name = a.callsign || a.hex.toUpperCase();
    $('pGenus').innerHTML = esc(name);
    const sp = [];
    if (a.type_desc) sp.push(esc(a.type_desc));
    else if (a.icao_type) sp.push(esc(a.icao_type));
    if (a.airline) sp.push(esc(a.airline));
    $('pSpecies').textContent = sp.join(', ') || 'aircraft overhead';

    $('pParticulars').innerHTML = particularsLine(a);

    const photo = photoCache.get(a.hex);
    const paint = paintCache.get(paintKey(PLATE_STYLE, a.hex));
    if (paint && paint !== 'pending' && paint.status === 'ready') {
      const ref = photo && photo !== 'pending' && photo.found && photo.photographer
        ? ` \u00b7 after a photograph \u00a9 ${esc(photo.photographer)}`
        : '';
      $('pCredit').innerHTML = `AI painting \u00b7 Cloudflare Workers AI${ref}`;
      imgBox.querySelectorAll('img').forEach((i) => i.remove());
      phEl.hidden = true;
      const img = document.createElement('img');
      img.src = paint.url;
      img.alt = `${a.reg || name} \u2014 AI painting`;
      img.className = 'fade-in';
      imgBox.appendChild(img);
    } else {
      $('pCredit').innerHTML = '&nbsp;';
      imgBox.querySelectorAll('img').forEach((i) => i.remove());
      phEl.hidden = false;
      phEl.innerHTML =
        (photo === 'pending' || paint === 'pending'
          ? `<span class="ph-line">painting this aircraft\u2026</span>`
          : `${silSvg(a.category)}<span class="ph-line">painting paused \u2014 showing outline</span>`);
      if (photo === 'pending') {
        getPhoto(a).then(() => render());
      } else if (photo && photo.found && paint !== 'failed') {
        getPaint(a, photo, PLATE_STYLE).then(() => render());
      }
    }

    const n = vis.findIndex((x) => x.hex === a.hex) + 1;
    $('plateNo').textContent =
      `Plate ${n} of ${vis.length} \u00b7 ${cfg.label || gpsLabel || ''}`.trim();
  }

  function stripThumb(a) {
    const el = document.createElement('button');
    el.className = 's' + (a.hex === currentHex ? ' on' : '');
    el.title = a.callsign || a.hex;
    const paint = paintCache.get(paintKey(PLATE_STYLE, a.hex));
    if (paint && paint !== 'pending' && paint.status === 'ready') {
      const img = document.createElement('img');
      img.src = paint.url;
      img.alt = a.callsign || a.hex;
      el.appendChild(img);
    } else {
      const sil = document.createElement('div');
      sil.className = 's-sil';
      sil.innerHTML = silSvg(a.category);
      el.appendChild(sil);
      const photo = photoCache.get(a.hex);
      if (photo === 'pending' || paint === 'pending') {
        getPhoto(a).then((p) => {
          if (p && p.found) getPaint(a, p, PLATE_STYLE).then(() => render());
        }).catch(() => {});
      }
    }
    const cs = document.createElement('span');
    cs.className = 's-cs';
    cs.textContent = a.callsign || a.hex.toUpperCase();
    el.appendChild(cs);
    el.addEventListener('click', () => {
      pinnedHex = a.hex;
      currentHex = a.hex;
      render();
    });
    return el;
  }

  function renderStrip() {
    const wrap = $('strip');
    wrap.innerHTML = '';
    const vis = visible();
    if (!vis.length) {
      const p = document.createElement('p');
      p.className = 'strip-empty';
      p.textContent = hasData ? 'nothing in reach' : 'listening\u2026';
      wrap.appendChild(p);
      $('btnNext').hidden = true;
      return;
    }
    vis.slice(0, 14).forEach((a) => wrap.appendChild(stripThumb(a)));
    $('btnNext').hidden = vis.length < 2 || (cfg.rotate > 0 && !pinnedHex) || cfg.view === 'cluster';
  }

  // ---------- cluster: everything in reach, sized by wingspan ----------

  const CLUSTER_MAX = 10;
  const SHEET_W = 1200;
  let sheetH = 0;

  function spanFor(a) {
    if (a.wingspan_m) return a.wingspan_m;
    if (a.category === 'heli') return 13;
    if (a.category === 'prop') return 12;
    return 32; // jet-ish default
  }

  function renderCluster() {
    const grid = $('clusterGrid');
    const vis = visible().slice(0, CLUSTER_MAX);
    const place = cfg.label || gpsLabel || '';
    if (!vis.length) {
      composeToken++;
      grid.innerHTML = '';
      $('cTitle').textContent = 'Overhead';
      $('cSub').textContent = hasData ? 'nothing in reach right now' : 'listening for the sky';
      const e = document.createElement('p');
      e.className = 'oh-empty';
      e.textContent = 'When something passes, it will appear here.';
      grid.appendChild(e);
    } else {
      $('cTitle').textContent = `Overhead ${place}`.trim();
      const spans = vis.map(spanFor);
      const lo = Math.min(...spans);
      const hi = Math.max(...spans);
      const ordered = vis
        .map((a, i) => ({ a, ws: spans[i] }))
        .sort((x, y) => y.ws - x.ws);
      composeSheet(grid, ordered);
    }
    $('btnNext').hidden = true;
  }

  // Alpha bounds of a keyed cut-out: the plane's real footprint inside
  // its square painting, so packing hugs the artwork, not the canvas.
  function alphaBounds(img) {
    const S = 96;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, S, S);
    let d;
    try { d = ctx.getImageData(0, 0, S, S).data; } catch (_) { return null; }
    let x0 = S, y0 = S, x1 = -1, y1 = -1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (d[(y * S + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x0: x0 / S, y0: y0 / S, x1: (x1 + 1) / S, y1: (y1 + 1) / S };
  }

  let composeToken = 0;
  const imgCache = new Map(); // cutout dataURL -> loaded image
  let sheetLayout = []; // {a,x,y,w,h} in canvas px, for tap-to-plate
  let sheetPx = { w: 1200, h: 800 }; // live canvas size for hit-testing

  function loadImage(url) {
    if (imgCache.has(url)) return Promise.resolve(imgCache.get(url));
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => { imgCache.set(url, im); res(im); };
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  // One clean artwork: all finished cut-outs composed on one cream sheet,
  // packed middle-out against their true artwork bounds (not the square
  // canvases), sized by wingspan, no labels. Aircraft still painting are
  // left off until their art lands.
  async function composeSheet(grid, ordered) {
    const my = ++composeToken;
    const jobs = ordered.map(async (o) => {
      const paint = paintCache.get(paintKey(CLUSTER_STYLE, o.a.hex));
      if (paint && paint !== 'pending' && paint.status === 'ready') {
        const cut = await cutoutify(paint.url);
        const img = await loadImage(cut);
        if (img) return { a: o.a, ws: o.ws, img, bounds: alphaBounds(img) || { x0: 0, y0: 0, x1: 1, y1: 1 } };
      } else {
        const photo = photoCache.get(o.a.hex);
        if (photo === 'pending' || paint === 'pending') {
          getPhoto(o.a).then((pp) => {
            if (pp && pp.found) getPaint(o.a, pp, CLUSTER_STYLE).then(() => render());
          }).catch(() => {});
        } else if (photo && photo.found && paint !== 'failed') {
          getPaint(o.a, photo, CLUSTER_STYLE).then(() => render());
        }
      }
      return null;
    });
    let done = (await Promise.all(jobs)).filter(Boolean);
    if (my !== composeToken) return; // a newer poll took over
    grid.innerHTML = '';

    const gridW = Math.max(320, grid.clientWidth || 1200);
    const gridH = Math.max(320, grid.clientHeight || 800);
    const MARGIN = 10;
    const W = gridW;
    const H = gridH;

    // Biggest planes-first order (area), then scale everything as large as
    // the screen allows. Planes may interlock at their edges — a wingtip
    // over a neighbour's empty corner — but never stack: the shared area
    // between any two footprints is capped, so every fuselage stays
    // readable, as in the printed collage.
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    const OVERLAP_CAP = 0.16; // of the smaller footprint's area
    let SPAN = 24; // px per metre of wingspan
    let placed = null;

    for (let attempt = 0; attempt < 14; attempt++) {
      const items = done.map((d) => {
        const pw = (d.bounds.x1 - d.bounds.x0) || 1;
        const ph = (d.bounds.y1 - d.bounds.y0) || 1;
        const cw = Math.max(80, (d.ws * SPAN) / pw);
        return {
          d, cw,
          fx: d.bounds.x0 * cw, fy: d.bounds.y0 * cw,
          fw: pw * cw, fh: ph * cw,
        };
      });
      items.sort((p, q) => (q.fw * q.fh) - (p.fw * p.fh));
      const cx = W / 2, cy = H * 0.46;
      const out = [];
      let fit = true;
      for (const it of items) {
        let ok = false;
        let best = null;
        let th = Math.random() * Math.PI * 2;
        let R = 0;
        let tries = 0;
        while (tries < 9000) {
          const fx = cx + R * Math.cos(th) - it.fw / 2;
          const fy = Math.max(MARGIN, cy + R * Math.sin(th) - it.fh / 2);
          if (fx >= MARGIN && fx + it.fw <= W - MARGIN && fy + it.fh <= H - MARGIN) {
            // worst shared-area ratio against everything already placed
            let worst = 0;
            for (const p of out) {
              const ox = Math.min(fx + it.fw, p.fx + p.fw) - Math.max(fx, p.fx);
              const oy = Math.min(fy + it.fh, p.fy + p.fh) - Math.max(fy, p.fy);
              if (ox > 0 && oy > 0) {
                const share = (ox * oy) / Math.min(it.fw * it.fh, p.fw * p.fh);
                if (share > worst) worst = share;
              }
            }
            if (worst <= OVERLAP_CAP) {
              // first spiral hit is the most central; keep scanning only
              // for a strictly cleaner spot nearby
              if (!best) best = { fx, fy, worst };
              else if (worst < best.worst - 0.02) best = { fx, fy, worst };
              if (best && best.worst === 0) break;
            }
          }
          th += GOLD;
          R += 2.0;
          tries++;
        }
        if (!best) { fit = false; break; }
        it.fx = best.fx;
        it.fy = best.fy;
        out.push(it);
      }
      if (fit && out.length) { placed = out; break; }
      SPAN *= 0.88; // too crowded for this screen: shrink and retry
    }
    if (!placed) {
      // Degenerate case (one huge plane on a tiny screen): scale to fit.
      const it0 = done.map((d) => {
        const pw = (d.bounds.x1 - d.bounds.x0) || 1;
        const ph = (d.bounds.y1 - d.bounds.y0) || 1;
        const cw = Math.min(W - 2 * MARGIN, (d.ws * 10) / pw);
        return { d, cw, fx: d.bounds.x0 * cw, fy: d.bounds.y0 * cw, fw: pw * cw, fh: ph * cw };
      })[0];
      placed = it0 ? [it0] : [];
    }

    const S = 2;
    const c = document.createElement('canvas');
    c.width = Math.round(W * S);
    c.height = Math.round(H * S);
    c.className = 'sheet-canvas';
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(S, S);
    sheetPx = { w: W, h: H };
    ctx.fillStyle = '#f6f2e7';
    ctx.fillRect(0, 0, W, H);
    sheetLayout = [];
    // largest first so smaller planes interlock over the big ones' gaps
    for (const it of placed) {
      ctx.drawImage(it.d.img, it.fx - it.d.bounds.x0 * it.cw, it.fy - it.d.bounds.y0 * it.cw, it.cw, it.cw);
      sheetLayout.push({ a: it.d.a, x: it.fx, y: it.fy, w: it.fw, h: it.fh });
    }
    c.addEventListener('click', (e) => {
      const r = c.getBoundingClientRect();
      const lx = (e.clientX - r.left) * (sheetPx.w / r.width);
      const ly = (e.clientY - r.top) * (sheetPx.h / r.height);
      // topmost hit wins: iterate small-to-large
      for (let i = sheetLayout.length - 1; i >= 0; i--) {
        const s = sheetLayout[i];
        if (lx >= s.x && lx <= s.x + s.w && ly >= s.y && ly <= s.y + s.h) {
          pinnedHex = s.a.hex;
          setView('plate');
          render();
          break;
        }
      }
    });
    grid.appendChild(c);
  }

  function setView(v) {
    cfg.view = v === 'cluster' ? 'cluster' : 'plate';
    $('plateView').hidden = cfg.view !== 'plate';
    $('clusterView').hidden = cfg.view !== 'cluster';
    $('btnView').setAttribute('aria-label', cfg.view === 'cluster' ? 'Switch to plate' : 'Switch to cluster');
    save();
    if (cfg.view === 'cluster') primePaints(CLUSTER_STYLE);
    else primePaints(PLATE_STYLE);
  }

  function renderErrban() {
    const ban = $('errban');
    if (bootErrors.length) {
      ban.hidden = false;
      ban.textContent = 'Page error: ' + bootErrors.slice(-2).join(' / ');
      return;
    }
    if (lastErr) {
      ban.hidden = false;
      ban.textContent = `Feed unreachable \u2014 retrying. ${lastErr}`;
    } else {
      ban.hidden = true;
    }
  }

  function renderDiag() {
    const el = $('diag');
    if (!el) return;
    // Debug scaffolding: only visible when requested via ?diag=1
    if (!q.get('diag')) { el.hidden = true; return; }
    el.hidden = false;
    const age = lastGoodAt ? Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000)) + 's ago' : 'never';
    const cur = visible().find((x) => x.hex === currentHex);
    const paint = cur ? paintCache.get(paintKey(PLATE_STYLE, cur.hex)) : null;
    const paintState = !cur ? 'no plate' : paint === 'pending' ? 'painting' : paint && paint.status === 'ready' ? 'painted' : 'no paint';
    let extra = '';
    if (cfg.view === 'cluster') {
      const vis = visible().slice(0, CLUSTER_MAX);
      let ready = 0, pending = 0;
      for (const a of vis) {
        const p = paintCache.get(paintKey(CLUSTER_STYLE, a.hex));
        if (p && p !== 'pending' && p.status === 'ready') ready++;
        else if (p === 'pending') pending++;
      }
      extra = ` \u00b7 sheet ${vis.length} cards ${ready} cut ${pending} keying`;
    }
    el.textContent =
      `view ${cfg.view} \u00b7 ${cfg.lat.toFixed(3)},${cfg.lon.toFixed(3)} r${cfg.radius}nm` +
      ` \u00b7 ${aircraft.length} tracked/${visible().length} shown \u00b7 poll ${age}` +
      ` \u00b7 ${cur ? (cur.callsign || cur.hex) + ' ' + paintState : paintState}` +
      extra +
      (lastErr ? ` \u00b7 ERR ${lastErr}` : '');
  }

  // ---------- location: follow me ----------

  let geoWatchId = null;

  function haversineNm(a, b) {
    const R = 3440.065;
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLon = (b.lon - a.lon) * r;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function startGeoWatch() {
    if (!('geolocation' in navigator)) return;
    if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        const moved = haversineNm({ lat: cfg.lat, lon: cfg.lon }, { lat: c.latitude, lon: c.longitude });
        cfg.lat = c.latitude;
        cfg.lon = c.longitude;
        save();
        if (moved > 2) {
          photoCache.clear();
          tick();
        }
        reverseGeocode(c.latitude, c.longitude);
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 }
    );
  }

  function stopGeoWatch() {
    if (geoWatchId != null) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
  }

  async function reverseGeocode(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const a = d.address || {};
      const name = a.city || a.town || a.village || a.suburb || a.hamlet || a.county || a.state || '';
      gpsLabel = [name, a.state || ''].filter(Boolean).join(' ');
      render();
    } catch (_) { /* keep coordinates */ }
  }

  // ---------- config dialog ----------

  const dlg = $('cfg');

  function setSegBtns() {
    $('modeAuto').classList.toggle('on', cfg.mode === 'auto');
    $('modeManual').classList.toggle('on', cfg.mode === 'manual');
    $('cLat').disabled = $('cLon').disabled = $('cLabel').disabled = cfg.mode === 'auto';
  }

  $('modeAuto').addEventListener('click', () => {
    cfg.mode = 'auto';
    setSegBtns();
    $('cNote').textContent = 'Following this device. Fields disabled; GPS sets them.';
  });
  $('modeManual').addEventListener('click', () => {
    cfg.mode = 'manual';
    setSegBtns();
    $('cNote').textContent = 'Fixed spot: type coordinates, or press Locate now once.';
  });

  function openCfg() {
    $('cLat').value = cfg.lat;
    $('cLon').value = cfg.lon;
    $('cLabel').value = cfg.label || '';
    $('cRadius').value = String(cfg.radius);
    $('cRotate').value = String(cfg.rotate);
    $('cHideGnd').hidden = true;
    $('cHideGnd').checked = cfg.hideGnd;
    $('cNote').textContent = '';
    setSegBtns();
    dlg.showModal();
  }

  $('btnCfg').addEventListener('click', openCfg);
  $('btnNext').addEventListener('click', nextPlate);
  $('btnView').addEventListener('click', () => {
    setView(cfg.view === 'cluster' ? 'plate' : 'cluster');
    render();
  });

  $('cGps').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('cNote').textContent = 'This browser has no geolocation.';
      return;
    }
    $('cNote').textContent = 'Locating\u2026';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        $('cLat').value = p.coords.latitude.toFixed(4);
        $('cLon').value = p.coords.longitude.toFixed(4);
        $('cNote').textContent = 'GPS fix applied \u2014 press Done.';
      },
      (e) => {
        $('cNote').textContent = 'GPS unavailable (' + e.message + '). Type coordinates instead.';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $('cShare').addEventListener('click', async () => {
    const u = new URL(location.href.split('?')[0]);
    if (cfg.mode === 'manual') {
      u.searchParams.set('lat', cfg.lat);
      u.searchParams.set('lon', cfg.lon);
      if (cfg.label) u.searchParams.set('label', cfg.label);
    } else {
      u.searchParams.set('mode', 'auto');
    }
    u.searchParams.set('radius', cfg.radius);
    u.searchParams.set('rotate', cfg.rotate);
    u.searchParams.set('view', cfg.view);
    u.searchParams.set('gnd', cfg.hideGnd ? '1' : '0');
    try {
      await navigator.clipboard.writeText(u.toString());
      $('cNote').textContent = 'Link copied to clipboard.';
    } catch (_) {
      $('cNote').textContent = 'Copy failed \u2014 URL is: ' + u.toString();
    }
  });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    cfg.radius = +$('cRadius').value;
    cfg.rotate = +$('cRotate').value;
    cfg.hideGnd = $('cHideGnd').checked;
    if (cfg.mode === 'manual') {
      const lat = parseFloat($('cLat').value);
      const lon = parseFloat($('cLon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        cfg.lat = lat;
        cfg.lon = lon;
        cfg.label = $('cLabel').value.trim();
      }
    }
    save();
    if (cfg.mode === 'auto') startGeoWatch();
    else stopGeoWatch();
    photoCache.clear();
    tick();
    scheduleRotate();
  });

  // ---------- wake lock ----------

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch (_) { /* fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  let rzT = null;
  window.addEventListener('resize', () => {
    clearTimeout(rzT);
    rzT = setTimeout(() => { if (cfg.view === 'cluster') render(); }, 200);
  });

  // Kiosk idle: controls fade out after a quiet minute, reappear on touch.
  let idleT = null;
  function pokeIdle() {
    document.getElementById('app').classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      document.getElementById('app').classList.add('idle');
    }, 45000);
  }
  ['touchstart', 'touchmove', 'mousedown', 'mousemove', 'keydown'].forEach((ev) => {
    window.addEventListener(ev, pokeIdle, { passive: true });
  });
  pokeIdle();

  // ---------- boot ----------

  if (cfg.view !== 'cluster' && cfg.view !== 'plate') cfg.view = 'cluster';
  setView(cfg.view);
  render();
  tick();
  fetchTimer = setInterval(tick, cfg.interval * 1000);
  scheduleRotate();
  keepAwake();
  if (cfg.mode === 'auto') {
    startGeoWatch();
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
      (p) => {
        cfg.lat = p.coords.latitude;
        cfg.lon = p.coords.longitude;
        save();
        reverseGeocode(cfg.lat, cfg.lon);
        photoCache.clear();
        tick();
      },
      () => {},
      { enableHighAccuracy: false, timeout: 15000 }
    );
  }
})();

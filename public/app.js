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
    view: 'plate',       // 'plate' | 'cluster'
    hideGnd: true,
  };

  const LS_KEY = 'po.cfg2'; // v2: fresh start; the v1 key held a stale label

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

  function spanFor(a) {
    if (a.wingspan_m) return a.wingspan_m;
    if (a.category === 'heli') return 13;
    if (a.category === 'prop') return 12;
    return 32; // jet-ish default
  }

  function renderCluster() {
    const grid = $('clusterGrid');
    grid.innerHTML = '';
    const vis = visible().slice(0, CLUSTER_MAX);
    const place = cfg.label || gpsLabel || '';
    if (!vis.length) {
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
      $('cSub').textContent = `${vis.length} in reach \u00b7 sized by wingspan`;
      const ordered = vis
        .map((a, i) => ({ a, ws: spans[i] }))
        .sort((x, y) => y.ws - x.ws);
      for (const { a, ws } of ordered) {
        const card = document.createElement('article');
        card.className = 'cluster-card';
        const w = Math.round(150 + ((ws - lo) / (hi - lo || 1)) * 230);
        card.style.width = `${w}px`;
        card.title = `${a.callsign || a.hex} \u00b7 ${ws}m span`;
        const paint = paintCache.get(paintKey(CLUSTER_STYLE, a.hex));
        if (paint && paint !== 'pending' && paint.status === 'ready') {
          const img = document.createElement('img');
          img.src = paint.url;
          img.alt = a.callsign || a.hex;
          img.loading = 'lazy';
          card.appendChild(img);
        } else {
          const sil = document.createElement('div');
          sil.className = 'c-sil';
          sil.innerHTML = silSvg(a.category);
          card.appendChild(sil);
          const photo = photoCache.get(a.hex);
          if (photo === 'pending' || paint === 'pending') {
            getPhoto(a).then((p) => {
              if (p && p.found) getPaint(a, p, CLUSTER_STYLE).then(() => render());
            }).catch(() => {});
          } else if (photo && photo.found && paint !== 'failed') {
            getPaint(a, photo, CLUSTER_STYLE).then(() => render());
          }
        }
        const cap = document.createElement('div');
        cap.className = 'cluster-cap';
        const typeLine = a.type_desc || a.icao_type || 'aircraft';
        const opLine = a.airline || a.owner || '';
        cap.innerHTML =
          `<div class="cc-type">${esc(typeLine)}</div>` +
          `<div class="cc-reg">${esc(a.reg || a.hex.toUpperCase())}</div>` +
          (opLine ? `<div class="cc-op">${esc(opLine)}</div>` : '');
        card.appendChild(cap);
        card.addEventListener('click', () => {
          pinnedHex = a.hex;
          setView('plate');
          render();
        });
        grid.appendChild(card);
      }
    }
    $('btnNext').hidden = true;
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
    el.hidden = false;
    const age = lastGoodAt ? Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000)) + 's ago' : 'never';
    const cur = visible().find((x) => x.hex === currentHex);
    const paint = cur ? paintCache.get(paintKey(PLATE_STYLE, cur.hex)) : null;
    const paintState = !cur ? 'no plate' : paint === 'pending' ? 'painting' : paint && paint.status === 'ready' ? 'painted' : 'no paint';
    el.textContent =
      `view ${cfg.view} \u00b7 ${cfg.lat.toFixed(3)},${cfg.lon.toFixed(3)} r${cfg.radius}nm` +
      ` \u00b7 ${aircraft.length} tracked/${visible().length} shown \u00b7 poll ${age}` +
      ` \u00b7 ${cur ? (cur.callsign || cur.hex) + ' ' + paintState : paintState}` +
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

  // ---------- boot ----------

  if (cfg.view !== 'cluster' && cfg.view !== 'plate') cfg.view = 'plate';
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

/* Overhead — the aircraft above you as a print.
 * One plate at a time: the aircraft, its photograph, its particulars.
 * No map. No radar. No table.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- config ----------

  const DEFAULTS = {
    mode: 'auto',
    lat: -28.8146,
    lon: 153.0114,
    label: '',
    radius: 40,
    interval: 20,        // data poll (s)
    rotate: 45,          // plate rotation (s), 0 = off
    hideGnd: true,
  };

  const q = new URLSearchParams(location.search);
  const ls = JSON.parse(localStorage.getItem('po.cfg') || '{}');
  const cfg = { ...DEFAULTS, ...ls };
  for (const k of ['lat', 'lon', 'label', 'radius', 'interval', 'rotate', 'mode']) {
    const v = q.get(k);
    if (v != null && v !== '') cfg[k] = v;
  }
  cfg.lat = +cfg.lat;
  cfg.lon = +cfg.lon;
  cfg.radius = +cfg.radius;
  cfg.interval = +cfg.interval || 20;
  cfg.rotate = +cfg.rotate;
  cfg.hideGnd = q.get('gnd') != null ? q.get('gnd') === '1' : (ls.hideGnd ?? true);

  const save = () => localStorage.setItem('po.cfg', JSON.stringify(cfg));

  // ---------- state ----------

  let aircraft = [];
  let lastErr = null;
  let hasData = false;
  let currentHex = null;     // the aircraft on the plate
  let pinnedHex = null;      // user-picked via strip; sticky across polls
  let plateIdx = 0;          // rotation position within the sorted list
  let fetchTimer = null;
  let rotateTimer = null;
  const photoCache = new Map(); // hex -> photo record | 'pending'
  const photoWaiters = new Map(); // hex -> [resolve]
  let gpsLabel = '';

  // ---------- helpers ----------

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
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
    } catch { /* offline */ }
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
      hasData = true;
      primePhotos();
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
    renderPlate();
    renderStrip();
    renderErrban();
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
    if (photo && photo !== 'pending' && photo.found) {
      $('pCredit').innerHTML =
        `Photograph \u00a9 <a href="${esc(photo.link)}" target="_blank" rel="noopener">${esc(photo.photographer || 'planespotters.net')}</a> \u00b7 planespotters.net`;
      imgBox.querySelectorAll('img').forEach((i) => i.remove());
      phEl.hidden = true;
      const img = document.createElement('img');
      img.src = photo.thumbnail;
      img.alt = `${a.reg || name}`;
      img.className = 'fade-in';
      imgBox.appendChild(img);
    } else {
      $('pCredit').innerHTML = '&nbsp;';
      imgBox.querySelectorAll('img').forEach((i) => i.remove());
      phEl.hidden = false;
      phEl.innerHTML =
        (photo === 'pending'
          ? `<span class="ph-line">finding its photograph\u2026</span>`
          : `${silSvg(a.category)}<span class="ph-line">no photograph on record</span>`);
      if (photo === 'pending') {
        getPhoto(a).then(() => render());
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
    const photo = photoCache.get(a.hex);
    if (photo && photo !== 'pending' && photo.found) {
      const img = document.createElement('img');
      img.src = photo.thumbnail;
      img.alt = a.callsign || a.hex;
      el.appendChild(img);
    } else {
      const sil = document.createElement('div');
      sil.className = 's-sil';
      sil.innerHTML = silSvg(a.category);
      el.appendChild(sil);
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
    $('btnNext').hidden = vis.length < 2 || (cfg.rotate > 0 && !pinnedHex);
  }

  function renderErrban() {
    const ban = $('errban');
    if (lastErr) {
      ban.hidden = false;
      ban.textContent = `Feed unreachable \u2014 retrying. ${lastErr}`;
    } else {
      ban.hidden = true;
    }
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
    } catch { /* keep coordinates */ }
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
    u.searchParams.set('gnd', cfg.hideGnd ? '1' : '0');
    try {
      await navigator.clipboard.writeText(u.toString());
      $('cNote').textContent = 'Link copied to clipboard.';
    } catch {
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

  render();
  tick();
  fetchTimer = setInterval(tick, cfg.interval * 1000);
  scheduleRotate();
  keepAwake();
  if (cfg.mode === 'auto') {
    startGeoWatch();
    navigator.geolocation?.getCurrentPosition(
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

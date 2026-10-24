/* Plane Overhead — client logic
 * Polls our Pages Function (/api/flights) which fails over across
 * airplanes.live -> adsb.fi -> OpenSky, normalised to one shape.
 * Config lives in URL params (shareable) with localStorage fallback.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';

  // ---------- config ----------

  const DEFAULTS = {
    lat: -28.8146,
    lon: 153.0114,
    label: 'Lismore NSW',
    radius: 60,
    interval: 15,
    units: 'av',
    theme: 'scope',
    hideGnd: true,
  };

  const q = new URLSearchParams(location.search);
  const ls = JSON.parse(localStorage.getItem('po.cfg') || '{}');
  const cfg = { ...DEFAULTS, ...ls };
  for (const k of ['lat', 'lon', 'label', 'radius', 'interval', 'units', 'theme']) {
    const v = q.get(k);
    if (v != null && v !== '') cfg[k] = v;
  }
  cfg.lat = +cfg.lat;
  cfg.lon = +cfg.lon;
  cfg.radius = +cfg.radius;
  cfg.interval = +cfg.interval;
  cfg.hideGnd = q.get('gnd') != null ? q.get('gnd') === '1' : (ls.hideGnd ?? true);

  const save = () => localStorage.setItem('po.cfg', JSON.stringify(cfg));

  // ---------- units ----------

  const UNITS = {
    av: { alt: (ft) => Math.round(ft).toLocaleString(), altU: 'ft', spd: (kt) => Math.round(kt), spdU: 'kt', dist: (nm) => nm, distU: 'nm', distD: 1 },
    met: {
      alt: (ft) => Math.round(ft * 0.3048 / 10) * 10, altU: 'm',
      spd: (kt) => Math.round(kt * 1.852), spdU: 'km/h',
      dist: (nm) => nm * 1.852, distU: 'km', distD: 0,
    },
  };
  let U = UNITS[cfg.units] || UNITS.av;
  const fmtDist = (nm) => U.dist(nm).toFixed(U.distD);

  // ---------- state ----------

  let aircraft = [];
  let lastGood = null;
  let lastErr = null;
  let selectedHex = null;
  let fetchTimer = null;
  const history = new Map(); // hex -> [{x,y,t}]

  // ---------- elements ----------

  const scope = $('scope');
  const listEl = $('list');
  const layers = {};

  function buildScope() {
    scope.innerHTML = '';
    const layerClass = {
      rings: 'layer-rings',
      trails: 'layer-trails',
      marks: 'layer-marks',
      labels: 'layer-labels',
    };
    for (const name of ['rings', 'trails', 'marks', 'labels']) {
      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', layerClass[name]);
      if (name === 'labels') g.setAttribute('id', 'labels');
      scope.appendChild(g);
      layers[name] = g;
    }
    drawStatic();
  }

  function drawStatic() {
    const g = document.createElementNS(svgNS, 'g');
    const R = 100;

    for (let i = 1; i <= 4; i++) {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('r', (R * i) / 4);
      c.setAttribute('class', 'ring');
      g.appendChild(c);
    }

    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      const long = a % 90 === 0;
      const l = document.createElementNS(svgNS, 'line');
      l.setAttribute('x1', Math.sin(rad) * R);
      l.setAttribute('y1', -Math.cos(rad) * R);
      l.setAttribute('x2', Math.sin(rad) * (R + (long ? 7 : 3.5)));
      l.setAttribute('y2', -Math.cos(rad) * (R + (long ? 7 : 3.5)));
      l.setAttribute('class', 'tick');
      g.appendChild(l);
    }

    for (const [txt, a, cls] of [['N', 0, ''], ['E', 90, ''], ['S', 180, ''], ['W', 270, '']]) {
      const rad = (a * Math.PI) / 180;
      const t = document.createElementNS(svgNS, 'text');
      t.setAttribute('x', Math.sin(rad) * (R + 10));
      t.setAttribute('y', -Math.cos(rad) * (R + 10) + 2.4);
      t.setAttribute('class', 'rose-lbl ' + cls);
      t.textContent = txt;
      g.appendChild(t);
    }

    const home = document.createElementNS(svgNS, 'g');
    const d = document.createElementNS(svgNS, 'path');
    d.setAttribute('d', 'M-1.8 0 L0 -2.6 L1.8 0 L0 2.6 Z');
    d.setAttribute('class', 'home-dot');
    home.appendChild(d);
    for (let a = 0; a < 4; a++) {
      const rad = ((a * 90 + 45) * Math.PI) / 180;
      const l = document.createElementNS(svgNS, 'line');
      l.setAttribute('x1', Math.sin(rad) * 4);
      l.setAttribute('y1', -Math.cos(rad) * 4);
      l.setAttribute('x2', Math.sin(rad) * 8);
      l.setAttribute('y2', -Math.cos(rad) * 8);
      l.setAttribute('class', 'home-cross');
      home.appendChild(l);
    }
    g.appendChild(home);
    scope.insertBefore(g, scope.firstChild);
  }

  function ringLabels() {
    const frac = [0.25, 0.5, 0.75, 1];
    const xs = [0, 0, 0, 0];
    const ys = [-25, -50, -75, -100];
    let old = document.getElementById('ringlbls');
    if (old) old.remove();
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('id', 'ringlbls');
    const lab = (i) => {
      const nm = (cfg.radius * frac[i]).toFixed(0);
      return cfg.units === 'met' ? (nm * 1.852).toFixed(0) + 'km' : nm + 'nm';
    };
    frac.forEach((_, i) => {
      const t = document.createElementNS(svgNS, 'text');
      t.setAttribute('x', 4);
      t.setAttribute('y', ys[i] + 1.8);
      t.setAttribute('class', 'ring-lbl');
      t.textContent = lab(i);
      g.appendChild(t);
    });
    scope.appendChild(g);
  }

  // bearing/dist -> scope coords, north up, edge = radius
  const xy = (b, d) => {
    const rad = (b * Math.PI) / 180;
    const r = (Math.min(d, cfg.radius) / cfg.radius) * 100;
    return [Math.sin(rad) * r, -Math.cos(rad) * r];
  };

  // ---------- render ----------

  function render() {
    U = UNITS[cfg.units] || UNITS.av;
    $('scopeLegend').textContent =
      cfg.units === 'met' ? 'callsign \u00b7 altitude m' : 'callsign \u00b7 altitude \u00d7100 ft';
    ringLabels();
    renderScope();
    renderList();
    renderHero();
    renderStatus();
  }

  function visible() {
    return aircraft.filter((a) => (cfg.hideGnd ? !a.on_ground : true));
  }

  function renderScope() {
    layers.trails.innerHTML = '';
    layers.marks.innerHTML = '';
    const labG = layers.labels;
    labG.innerHTML = '';

    const vis = visible();
    const labelled = new Set(vis.slice(0, 10).map((a) => a.hex));

    for (const a of vis) {
      const [x, y] = xy(a.bearing_deg, a.dist_nm);

      // trail
      const h = history.get(a.hex) || [];
      if (h.length > 1) {
        const p = document.createElementNS(svgNS, 'polyline');
        const pts = h.slice(-4).map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
        p.setAttribute('points', pts + ` ${x.toFixed(1)},${y.toFixed(1)}`);
        p.setAttribute('class', 'trail');
        p.setAttribute('opacity', '0.5');
        layers.trails.appendChild(p);
      }

      const cls = a.emergency ? 'ac-mark emerg' : a.on_ground ? 'ac-mark ground' : 'ac-mark';
      const m = document.createElementNS(svgNS, 'path');
      const s = a.emergency ? 4.4 : 3.4;
      // nose pointing along track
      const rot = `rotate(${((a.track_deg || 0) - 90).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`;
      m.setAttribute(
        'd',
        `M${x + s} ${y} L${x - s * 0.75} ${y - s * 0.62} L${x - s * 0.3} ${y} L${x - s * 0.75} ${y + s * 0.62} Z`
      );
      m.setAttribute('transform', rot);
      m.setAttribute('class', cls);
      m.dataset.hex = a.hex;
      m.addEventListener('click', () => select(a.hex));
      m.style.cursor = 'pointer';
      layers.marks.appendChild(m);

      if (a.emergency) {
        const r = document.createElementNS(svgNS, 'circle');
        r.setAttribute('cx', x);
        r.setAttribute('cy', y);
        r.setAttribute('r', s + 3.4);
        r.setAttribute('class', 'ac-ring');
        layers.marks.appendChild(r);
      }
      if (a.hex === selectedHex) {
        const r = document.createElementNS(svgNS, 'circle');
        r.setAttribute('cx', x);
        r.setAttribute('cy', y);
        r.setAttribute('r', s + 4.2);
        r.setAttribute('class', 'sel-ring');
        layers.marks.appendChild(r);
      }

      if (labelled.has(a.hex) || a.hex === selectedHex || a.emergency) {
        const clsE = a.emergency ? ' emerg' : a.on_ground ? ' ground' : '';
        const t1 = document.createElementNS(svgNS, 'text');
        t1.setAttribute('x', x + 6.5);
        t1.setAttribute('y', y - 1);
        t1.setAttribute('class', 'lab' + clsE);
        t1.textContent = a.callsign || a.hex.toUpperCase();
        labG.appendChild(t1);
        const t2 = document.createElementNS(svgNS, 'text');
        t2.setAttribute('x', x + 6.5);
        t2.setAttribute('y', y + 5);
        t2.setAttribute('class', 'lab-sub' + clsE);
        t2.textContent = a.on_ground ? 'GND' : Math.round((a.alt_ft || 0) / 100);
        labG.appendChild(t2);
      }
    }
  }

  function row(a) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    if (a.hex === selectedHex) li.classList.add('sel');

    const alt = a.on_ground
      ? 'GND'
      : a.alt_ft == null
        ? '—'
        : U.alt(a.alt_ft);
    const spd = a.gs_kt == null ? '—' : U.spd(a.gs_kt);

    let trend = '<span class="trend">&nbsp;</span>';
    if (a.vert_fpm != null && Math.abs(a.vert_fpm) > 300) {
      trend = a.vert_fpm > 0
        ? '<span class="tr-up trend">&#9650;</span>'
        : '<span class="tr-dn trend">&#9660;</span>';
    }

    const metaBits = [a.type, a.reg].filter(Boolean).join(' · ');
    li.innerHTML =
      `<span class="cs">${esc(a.callsign || a.hex.toUpperCase())}${a.emergency ? ' <span class="chip emerg">alert</span>' : ''}</span>` +
      `<span class="meta">${esc(metaBits || '—')}</span>` +
      `<span class="num ${a.on_ground ? 'dim' : ''}">${alt}</span>` +
      `<span class="num">${spd}</span>` +
      `<span class="num">${fmtDist(a.dist_nm)}</span>` +
      trend +
      `<span class="meta">${compass(a.bearing_deg)}</span>`;

    li.addEventListener('click', () => select(a.hex));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(a.hex);
      }
    });
    return li;
  }

  function renderList() {
    const head = $('listHead');
    head.innerHTML =
      `<span>callsign</span><span>type / reg</span><span>alt ${U.altU}</span>` +
      `<span>${U.spdU}</span><span>${U.distU}</span><span>&#8597;</span><span>brg</span>`;

    listEl.innerHTML = '';
    const vis = visible();
    if (!vis.length) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = aircraft.length
        ? 'Only ground traffic in range'
        : 'No aircraft tracked in range right now';
      listEl.appendChild(li);
      return;
    }
    for (const a of vis) listEl.appendChild(row(a));
  }

  function renderHero() {
    const hero = $('hero');
    const vis = visible();
    const pick = vis.find((a) => a.hex === selectedHex) || vis[0];
    hero.classList.toggle('emerg', !!(pick && pick.emergency));
    if (!pick) {
      $('heroCs').textContent = '—';
      $('heroDist').textContent = '—';
      $('heroSub').textContent = 'nothing airborne in range';
      return;
    }
    $('heroCs').textContent = pick.callsign || pick.hex.toUpperCase();
    $('heroDist').innerHTML = `${fmtDist(pick.dist_nm)}<small>${U.distU}</small>`;
    const bits = [];
    if (pick.on_ground) bits.push('on the ground');
    else if (pick.alt_ft != null) bits.push(`${U.alt(pick.alt_ft)} ${U.altU}`);
    if (pick.gs_kt != null) bits.push(`${U.spd(pick.gs_kt)} ${U.spdU}`);
    bits.push(`bearing ${compass(pick.bearing_deg)}`);
    if (pick.type && pick.reg) bits.push(`${pick.type} ${pick.reg}`);
    else if (pick.type) bits.push(pick.type);
    $('heroSub').innerHTML = bits.map((b) => `<b>${esc(b)}</b>`).join(' · ') || '';
  }

  function renderStatus() {
    const s = $('status');
    const chips = [];
    if (lastGood) {
      const ageS = Math.max(0, Math.round((Date.now() - lastGood.t) / 1000));
      chips.push(`<span class="chip">${esc(lastGood.source)}</span>`);
      chips.push(`<span>${visible().length} airborne of ${aircraft.length} in range</span>`);
      chips.push(`<span>updated ${ageS}s ago</span>`);
      const emerg = aircraft.filter((a) => a.emergency);
      if (emerg.length)
        chips.push(`<span class="chip emerg">${emerg.length} squawking emergency</span>`);
    } else if (lastErr) {
      chips.push(`<span class="chip dim">offline</span>`);
    } else {
      chips.push(`<span class="chip dim">connecting</span>`);
    }
    s.innerHTML = chips.join('');
    const ban = $('errban');
    if (lastErr) {
      ban.hidden = false;
      ban.textContent = `Feed unreachable — retrying. ${lastErr}`;
    } else {
      ban.hidden = true;
    }
  }

  function select(hex) {
    selectedHex = selectedHex === hex ? null : hex;
    render();
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function compass(brg) {
    if (brg == null) return '—';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(brg / 45) % 8] + ' ' + brg.toFixed(0) + '°';
  }

  // ---------- data ----------

  async function tick() {
    try {
      const r = await fetch(
        `/api/flights?lat=${cfg.lat}&lon=${cfg.lon}&radius=${cfg.radius}`,
        { cache: 'no-store' }
      );
      if (!r.ok) throw new Error(`API ${r.status}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      aircraft = d.aircraft || [];
      lastGood = { t: Date.now(), source: d.source };
      lastErr = null;

      // sweep the scanline once per update
      const sl = $('scanline');
      sl.classList.remove('sweep');
      void sl.offsetWidth;
      sl.classList.add('sweep');

      // prune + update history for trails
      const now = Date.now();
      const seen = new Set();
      for (const a of aircraft) {
        seen.add(a.hex);
        const h = history.get(a.hex) || [];
        const [x, y] = xy(a.bearing_deg, a.dist_nm);
        h.push({ x, y, t: now });
        if (h.length > 6) h.shift();
        history.set(a.hex, h);
      }
      for (const k of history.keys()) if (!seen.has(k)) history.delete(k);
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    render();
  }

  function schedule() {
    clearInterval(fetchTimer);
    fetchTimer = setInterval(tick, cfg.interval * 1000);
  }

  // ---------- clock ----------

  function clock() {
    const n = new Date();
    $('clock').textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('dateLine').textContent = n
      .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
      .toUpperCase();
  }

  // ---------- theme / fullscreen ----------

  function applyTheme() {
    $('app').dataset.theme = cfg.theme;
    $('themeColorMeta').content = cfg.theme === 'scope' ? '#0a0f0c' : '#f2efe6';
    save();
  }

  $('btnTheme').addEventListener('click', () => {
    cfg.theme = cfg.theme === 'scope' ? 'paper' : 'scope';
    applyTheme();
  });

  $('btnFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  // ---------- config dialog ----------

  const dlg = $('cfg');

  function openCfg() {
    $('cLat').value = cfg.lat;
    $('cLon').value = cfg.lon;
    $('cLabel').value = cfg.label || '';
    $('cRadius').value = String(cfg.radius);
    $('cInterval').value = String(cfg.interval);
    $('cUnits').value = cfg.units;
    $('cTheme').value = cfg.theme;
    $('cHideGnd').checked = cfg.hideGnd;
    $('cNote').textContent = '';
    dlg.showModal();
  }

  $('btnCfg').addEventListener('click', openCfg);

  $('cGps').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('cNote').textContent = 'This browser has no geolocation.';
      return;
    }
    $('cNote').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        $('cLat').value = p.coords.latitude.toFixed(4);
        $('cLon').value = p.coords.longitude.toFixed(4);
        $('cNote').textContent = 'GPS fix applied — press Done.';
      },
      (e) => {
        $('cNote').textContent = 'GPS unavailable (' + e.message + '). Type coordinates instead.';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $('cShare').addEventListener('click', async () => {
    const u = new URL(location.href.split('?')[0]);
    u.searchParams.set('lat', cfg.lat);
    u.searchParams.set('lon', cfg.lon);
    if (cfg.label) u.searchParams.set('label', cfg.label);
    u.searchParams.set('radius', cfg.radius);
    u.searchParams.set('interval', cfg.interval);
    u.searchParams.set('units', cfg.units);
    u.searchParams.set('theme', cfg.theme);
    u.searchParams.set('gnd', cfg.hideGnd ? '1' : '0');
    try {
      await navigator.clipboard.writeText(u.toString());
      $('cNote').textContent = 'Link copied to clipboard.';
    } catch {
      $('cNote').textContent = 'Copy failed — URL is: ' + u.toString();
    }
  });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const lat = parseFloat($('cLat').value);
    const lon = parseFloat($('cLon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    cfg.lat = lat;
    cfg.lon = lon;
    cfg.label = $('cLabel').value.trim();
    cfg.radius = +$('cRadius').value;
    cfg.interval = +$('cInterval').value;
    cfg.units = $('cUnits').value;
    cfg.theme = $('cTheme').value;
    cfg.hideGnd = $('cHideGnd').checked;
    save();
    applyTheme();
    $('locLabel').textContent = locText();
    history.clear();
    selectedHex = null;
    tick();
    schedule();
  });

  function locText() {
    return `${cfg.label ? cfg.label + ' · ' : ''}${cfg.lat.toFixed(3)}, ${cfg.lon.toFixed(3)} · ${cfg.radius} nm`;
  }

  // ---------- wake lock (keep the wall tablet on) ----------

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch (_) {
      /* unsupported or denied — fine */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  // ---------- boot ----------

  applyTheme();
  $('locLabel').textContent = locText();
  buildScope();
  clock();
  setInterval(clock, 5000);
  render();
  tick();
  schedule();
  keepAwake();
})();

# plane-overhead

A Tesserae-style "Air Traffic" wall display for an Android tablet, as a plain web page. Live ADS-B radar of flights overhead at your location: radar scope plus a nearest-flights list, refresh on a cadence, dark scope theme and light paper theme.

## Live

- Production: <https://plane-overhead.pages.dev>
- Repo: <https://github.com/24has/plane-overhead>

## How it works

```
Android tablet (kiosk browser, any origin)
   │  GET /api/flights?lat=…&lon=…&radius=60   (same origin, no CORS issues)
   ▼
Cloudflare Pages Function  functions/api/flights.js
   │  failover chain, edge-cached 15 s per spot:
   │    1. adsb.lol         v2/point       (readsb schema, 250 nm max)
   │    2. adsb.fi          v3/lat/lon/dist (readsb schema, 250 nm max)
   │    3. OpenSky Network  states/all bbox  (anonymous tier, ~400 credits/day)
   ▼
normalised JSON → SVG radar + sorted list on the tablet
```

Why the proxy instead of hitting the feeds directly from the tablet:

- **No CORS.** None of the community feeds serve `Access-Control-Allow-Origin`, so the tablet browser can't fetch them directly. The Pages Function is same-origin with the frontend.
- **Cloudflare-to-Cloudflare gotcha.** Cloudflare zones (airplanes.live, adsb.fi) 403 fetches coming from a Worker — verified empirically. adsb.lol is served by istio-envoy, not Cloudflare, so it's the reliable lead source. airplanes.live additionally 403s all server-side clients regardless of IP.
- **Edge caching.** Subrequests are cached at the Cloudflare edge for 15 s (OpenSky fallback: 300 s to protect the anonymous credit quota), so a shelf of tablets polling the same spot generate at most one upstream hit per 15 s. Rate limits are respected by construction.
- **Failover.** If one feed is down or rate-limiting, the next serves the request.
- **One normalised shape.** Every source maps to the same aircraft object: callsign, registration, type, lat/lon, altitude, ground speed, track, vertical rate, squawk, emergency flag, distance and bearing from home.

## Setup on the tablet

1. Open the production URL.
2. Tap the gear: enter lat/lon (or use GPS), place label, range (25–250 nm), refresh cadence, units, theme, and whether to hide ground traffic. Done.
3. Share a configured view: "Copy link to this setup" in the gear menu puts every setting in the URL — good for kiosk launchers (Fully Kiosk, WallPanel) that need a fixed URL.
4. Keep the screen on: the page requests a screen Wake Lock while visible. In your kiosk app, also enable "keep screen on while plugged in".
5. Install as an app: Chrome menu → "Install app" / "Add to Home screen" (it's a PWA, launches standalone with its own icon).

## Development

No build step. Static frontend in `public/`, one Pages Function in `functions/api/flights.js`.

```bash
# local dev with live upstreams
npx wrangler pages dev
# → http://127.0.0.1:8788

# deploy by hand
npx wrangler pages deploy public --project-name plane-overhead --branch main
```

CI (`.github/workflows/deploy.yml`) deploys to Cloudflare Pages on every push to `main`.

## API

`GET /api/flights?lat=-28.81&lon=153.28&radius=60`

```json
{
  "now": 1761686400000,
  "src_time": 1761686398000,
  "source": "airplanes.live",
  "lat": -28.81, "lon": 153.28, "radius_nm": 60,
  "count": 4,
  "aircraft": [
    {
      "hex": "7c6d2a", "callsign": "VOZ902", "reg": "VH-8PN", "type": "B738",
      "lat": -28.62, "lon": 153.05,
      "alt_ft": 20000, "on_ground": false,
      "gs_kt": 430, "track_deg": 35, "vert_fpm": -1200,
      "squawk": "3521", "emergency": null,
      "dist_nm": 12.4, "bearing_deg": 340
    }
  ]
]
```

Try it: `curl "https://plane-overhead.pages.dev/api/flights?lat=-33.94&lon=151.18&radius=50"`

## Credit

Data: [adsb.lol](https://adsb.lol/), [adsb.fi](https://adsb.fi/), [OpenSky Network](https://opensky-network.org/) — community ADS-B receiver networks, free for personal use. Concept inspired by the Tesserae Air Traffic e-ink widget (tesserae.ink).

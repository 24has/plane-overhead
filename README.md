# Overhead — the aircraft above you as a print

An artwork-only wall display for an Android tablet: one aircraft at a time as a print, or everything in reach on one Cluster page. No map, no radar, no table. Paintings are AI-generated in an arty style (not raw photos), cached so each airframe/style is only ever generated once.

- Production: <https://plane-overhead.pages.dev>
- Repo: <https://github.com/24has/plane-overhead>

## How it works

```
Android tablet
  │  GET /api/flights?lat=…&lon=…&radius=40
  ▼
Cloudflare Pages Function  functions/api/flights.js
  │  adsb.lol → adsb.fi → OpenSky failover, edge-cached;
  │  adsbdb enrichment: type, owner, route, wingspan, silhouette class
  ▼
  │  GET /api/photo?hex=…          (planespotters by hex/reg, day-cached)
  │  GET /api/paint?...            (Workers AI painting, KV-cached)
  ▼
Plate shows the painting; strip shows paintings or outlines while pending.
The grid button (top right) switches to the Cluster page: up to ten aircraft
in reach, each painting sized by wingspan (largest first), click any card to
open its plate.
```

Paintings are text-to-image interpretations conditioned on the airframe (type, registration/callsign, airline livery). The plate uses the `poster` style; the Cluster page uses a separate `cutout` style (aircraft isolated on plain paper, no scenery) so the page reads as a specimen sheet. Both are cached per style and never regenerated. Storage key:

`paint/{style}/{style-version}/{hex}/{photo_id or nophoto}.jpg`

KV stores the JPEG bytes plus metadata (model, photo id, created time). Repeat views serve the stored bytes with `x-paint-cache: hit` and never touch Workers AI again. A code-level daily cap (80 generations) protects the shared Workers AI free allocation.

## Setup on the tablet

1. Open the production URL.
2. Tap the setup button: Follow this device (default) or a fixed spot; range; plate rotation; hide ground traffic.
3. The starting spot is Gold Coast until GPS takes over. Give the page one tap after opening so geolocation is allowed.
4. Share link encodes the setup for kiosk launchers.
5. Keep the screen on in the kiosk app; the page also requests a screen wake lock.

## Development

No build step. Static frontend in `public/`; Pages Functions in `functions/api/`.

```bash
npx wrangler pages dev --ai AI
# → http://127.0.0.1:8788
```

Deploy:

```bash
npx wrangler pages deploy public --project-name plane-overhead --branch main
```

Bindings in `wrangler.toml`: `ART_KV` (painting bytes/metadata) and `AI` (Workers AI). R2 is not enabled on this account, so KV is the durable painting store.

## API

`GET /api/flights?lat=-28.0167&lon=153.4&radius=40` → normalised aircraft with enrichment.

`GET /api/photo?hex=7c6d2a` → `{ found, thumbnail, link, photographer, photo_id }`.

`GET /api/paint?hex=7c6d2a&style=poster&photo_id=1967150&reg=VH-VUK&type_desc=...&icao_type=B738&airline=...` → `image/jpeg`; `x-paint-cache: hit|miss`.

## Credit

Data: [adsb.lol](https://adsb.lol/), [adsbdb](https://adsbdb.com/), [planespotters.net](https://www.planespotters.net/), [OpenSky Network](https://opensky-network.org/). Paintings: Cloudflare Workers AI (`flux-1-schnell`). Photographer references via planespotters.net. Concept inspired by the Tesserae Overhead bundle.

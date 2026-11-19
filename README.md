# Nisuwaz Tools

Public EVE Online tools for Korean players, served at tools.nisuwaz.com. The home page (`/`) is a star map that links to each tool.

## Included tools

- `/plex` — PLEX 현질 효율 계산기: the cheapest way to turn KRW into ISK, SP or Omega time, using Jita 4-4 PLEX/LSI/extractor quotes and Steam Omega prices.
- `/fridge` — 냉장고 계산기 (fitting shopping list): fits × count − hangar = what to buy in Jita 4-4, with prices, volume and a Multibuy list. Calls ESI and Fuzzwork directly from the browser.

No EVE login, character data or server-side user state is used. Inputs are kept in the visitor's own browser storage.

## How it is built

```
web/          React + Vite + TypeScript static site (hub, PLEX, 냉장고)
refresher/    refresh.py: fetches public market data on a timer, writes JSON files
Caddyfile     serves the built site and the JSON files; nothing else
docker/       entrypoint.sh: runs the refresher and Caddy side by side
```

Visitor requests never reach an upstream service. The refresher fetches Fuzzwork aggregates every 5 minutes and Steam Omega prices every 30 minutes, validates them and writes `/srv/data/aggregates.json` and `/srv/data/steamomega.json` atomically. A failed fetch keeps the previous file. Caddy serves them at `GET /aggregates` and `GET /steamomega`; the file's `Last-Modified` tells the page how old the quotes are, and the page warns when they are over 30 minutes old.

Routes: `/`, `/plex`, `/fridge` (the app), `/aggregates`, `/steamomega` (data), `/healthz`, `/assets/*` (hashed, cached for a year). Only `GET` and `HEAD` are accepted; anything else is `405`.

## Data sources

- Fuzzwork market aggregates for Jita 4-4 prices.
- EVE ESI for item name → ID lookup and packaged volume (냉장고 계산기).
- Steam public app details API for KRW Omega prices.
- Built-in public retail-price constants (2026-06) when live data is unavailable.

## Develop

```bash
cd web
npm ci
npm run dev        # http://localhost:5173; /aggregates and /steamomega are proxied to a container on 127.0.0.1:8080
                   # (without one the PLEX page falls back to its built-in prices)
npm test           # calculation tests, compared against the original pages in test/legacy/
npm run build      # type-check and build into web/dist
```

Refresher tests:

```bash
python3 -m unittest discover -s tests
```

## Adding a tool

1. Add an entry to `web/src/tools.ts` (name, path, number key, map position) and a 256×256 icon in `web/public/icons/`.
2. Add the page under `web/src/pages/` and its route in `web/src/App.tsx`.
3. Add the path to the `@app` matcher in `Caddyfile`.

## Docker

```bash
docker build -t goemktg/nisuwaz-tools .
docker run --rm --read-only --tmpfs /tmp --tmpfs /srv/data:uid=100,gid=101 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 goemktg/nisuwaz-tools
```

The image builds and tests the site, then runs as an unprivileged user. Settings (environment variables): `PORT` (default `8080`), `REFRESH_SECONDS` (default `300`), `STEAM_EVERY` (refresh Steam every N market rounds, default `6`).

Pushing a `v*` tag builds and publishes the image through `.github/workflows/docker.yml`.

## Deployment

Put the container behind a reverse proxy (tools.nisuwaz.com runs Cloudflare → Caddy → this container) and publish port 8080 only on the loopback or internal network. The container itself only serves static files with short header/body timeouts, but per-client connection limits belong at the proxy.

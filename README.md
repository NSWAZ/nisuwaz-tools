# Nisuwaz Tools

Public EVE Online tools for Korean players. The home page (`/`) is a hub that links to each tool.

## Included tools

- `/fridge` — 냉장고 계산기 (fitting shopping list): fits × count − hangar = what to buy in Jita 4-4, with prices, volume, and a Multibuy list. Calls ESI and Fuzzwork directly from the browser.
- `/plex` — PLEX 현질 효율 계산기: compares direct PLEX sale against Omega + MCT skill farming using public market data.

Adding a tool: add its page and 256×256 icon, list both in `STATIC_ROUTES` in `app.py`, add a link on `hub.html`, and copy the files in the `Dockerfile`.

## Data sources

- Fuzzwork market aggregates for Jita 4-4 prices (PLEX calculator via the server proxy, 냉장고 계산기 directly).
- EVE ESI for item name → ID lookup and packaged volume (냉장고 계산기).
- Steam public app details API for KRW Omega pricing when available.
- EVE Online web store prices for USD PLEX and Omega ranking comparisons when available.

No EVE login, character cache, roster data, or private storage is used.

## Run locally

```bash
PORT=8080 python3 app.py
```

Open `http://localhost:8080/`.

Useful endpoints:

- `GET /` — tool hub
- `GET /fridge`, `GET /plex` — tool pages
- `GET /aggregates` — CORS-friendly Fuzzwork proxy
- `GET /steamomega` — public Steam Omega price proxy
- `GET /webstore` — public EVE web-store PLEX and Omega price proxy
- `GET /api/calculate` — JSON calculation with default inputs

## Tests

```bash
python3 -m unittest discover -s tests
```

## Docker

```bash
docker build -t goemktg/nisuwaz-tools .
docker run --rm -p 8080:8080 -e PORT=8080 goemktg/nisuwaz-tools
```

## Deployment limits

The server handles at most 64 connections at once (extra connections are closed, with a best-effort `503`), gives each client 10 s to send its request headers, and backs off for 30 s after an upstream fetch fails (serving the last cached data when it has any). These caps are global, not per client, so put the container behind a reverse proxy that enforces per-client connection limits and header timeouts rather than publishing port 8080 directly to the internet.

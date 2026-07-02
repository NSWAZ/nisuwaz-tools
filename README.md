# Nisuwaz Tools

Standalone public tools for EVE Online.

## Included tool

- PLEX farming efficiency calculator: compares direct PLEX sale against Omega + MCT skill farming using public market data.

## Data sources

- Fuzzwork market aggregates for Jita 4-4 prices of PLEX, Large Skill Injector, and Skill Extractor.
- Steam public app details API for KRW Omega pricing when available.
- Built-in public retail-price constants for ranking comparisons.

No EVE login, character cache, roster data, or private storage is used.

## Run locally

```bash
PORT=8080 python3 app.py
```

Open `http://localhost:8080/`.

Useful endpoints:

- `GET /` — calculator page
- `GET /aggregates` — CORS-friendly Fuzzwork proxy
- `GET /steamomega` — public Steam Omega price proxy
- `GET /api/calculate` — JSON calculation with default inputs

## Docker

```bash
docker build -t goemktg/nisuwaz-tools .
docker run --rm -p 8080:8080 -e PORT=8080 goemktg/nisuwaz-tools
```

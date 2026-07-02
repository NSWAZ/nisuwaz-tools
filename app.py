#!/usr/bin/env python3
"""Standalone public PLEX farming efficiency calculator."""
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))
BIND = os.environ.get("BIND", "0.0.0.0")

FUZZWORK_AGGREGATES_URL = os.environ.get(
    "FUZZWORK_AGGREGATES_URL",
    "https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=44992,40520,40519",
)
STEAM_OMEGA_APPS = {1: 695740, 3: 695741, 6: 695742, 12: 695743, 24: 1983081}
WEBSTORE_PLEX_URL = "https://store.eveonline.com/en/plex"
USER_AGENT = "Mozilla/5.0 (compatible; nisuwaz-tools/1.1)"
UPSTREAM_CACHE_SECONDS = 300
WEBSTORE_CACHE_SECONDS = 3600
WEBSTORE_OFFER_RE = re.compile(
    r'\{\\"sysId\\":.*?\\"purchaseNotAllowedReason\\":\\"[^"]*\\"\}',
    re.DOTALL,
)


class UpstreamCache:
    def __init__(self, ttl=UPSTREAM_CACHE_SECONDS):
        self.ttl = ttl
        self.lock = threading.Lock()
        self.body = None
        self.fetched_at = 0.0

    def get(self, fetcher):
        now = time.time()
        if self.body is not None and now - self.fetched_at < self.ttl:
            return self.body, False
        with self.lock:
            now = time.time()
            if self.body is not None and now - self.fetched_at < self.ttl:
                return self.body, False
            try:
                body = fetcher()
            except Exception:
                if self.body is not None:
                    return self.body, True
                raise
            self.body = body
            self.fetched_at = time.time()
            return body, False


MARKET_CACHE = UpstreamCache()
STEAM_CACHE = UpstreamCache()
WEBSTORE_CACHE = UpstreamCache(ttl=WEBSTORE_CACHE_SECONDS)

DEFAULTS = {
    "plex_price": 4713000.0,
    "lsi_price": 700200000.0,
    "extractor_price": 460400000.0,
    "budget": 20000.0,
    "omega_plex": 6600.0,
    "mct_plex": 4400.0,
    "mct_count": 2.0,
    "farm_months": 24.0,
    "sp_day": 64800.0,
    "floor_sp": 5000000.0,
    "sp_lsi": 500000.0,
    "tax_percent": 2.0,
    "nes_qty": 50.0,
    "nes_plex": 5600.0,
    "krw_total": 851500.0,
}


def _fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def _json_response(handler, code, payload):
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _cached_json_bytes_response(handler, body, stale=False, max_age=UPSTREAM_CACHE_SECONDS):
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", f"public, max-age={max_age}")
    if stale:
        handler.send_header("X-Stale", "1")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _static_response(handler, path):
    body = path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _fetch_steam_omega():
    out = {}
    failures = 0
    for months, app_id in STEAM_OMEGA_APPS.items():
        url = (
            "https://store.steampowered.com/api/appdetails?"
            f"appids={app_id}&cc=kr&filters=price_overview"
        )
        try:
            data = json.loads(_fetch(url, timeout=10).decode("utf-8"))
            price = data[str(app_id)]["data"].get("price_overview") or {}
            if price:
                out[months] = {
                    "final": int(price.get("final", 0)) // 100,
                    "initial": int(price.get("initial", 0)) // 100,
                    "disc": int(price.get("discount_percent", 0)),
                }
        except Exception:
            failures += 1
    if failures == len(STEAM_OMEGA_APPS) and not out:
        raise RuntimeError("steam omega fetch failed")
    return json.dumps(out, ensure_ascii=False, sort_keys=True).encode("utf-8")


def _fetch_webstore():
    html = _fetch(WEBSTORE_PLEX_URL, timeout=15).decode("utf-8", errors="replace")
    offers = []
    seen = set()
    for match in WEBSTORE_OFFER_RE.finditer(html):
        raw = match.group(0).replace('\\"', '"')
        try:
            offer = json.loads(raw)
        except Exception:
            continue
        offer_id = offer.get("id")
        pricing = offer.get("pricing")
        if not offer_id or offer_id in seen or not offer.get("canPurchase") or not pricing:
            continue
        seen.add(offer_id)
        offers.append(
            {
                "id": offer_id,
                "title": offer.get("titleEnglish"),
                "category": offer.get("offerCategory"),
                "slug": offer.get("slug"),
                "price": pricing.get("price"),
                "basePrice": pricing.get("basePrice"),
                "discountPercentage": pricing.get("discountPercentage"),
                "isRecurring": offer.get("isRecurring"),
                "canPurchase": offer.get("canPurchase"),
            }
        )
    if not offers:
        raise RuntimeError("webstore fetch failed")
    return json.dumps({"offers": offers}, ensure_ascii=False, sort_keys=True).encode("utf-8")


def _number(params, name):
    raw = params.get(name, [None])[0]
    if raw in (None, ""):
        return DEFAULTS[name]
    try:
        return float(raw)
    except (TypeError, ValueError):
        return DEFAULTS[name]


def calculate(params):
    plex_price = _number(params, "plex_price")
    lsi_price = _number(params, "lsi_price")
    extractor_price = _number(params, "extractor_price")
    budget = _number(params, "budget")
    omega_plex = _number(params, "omega_plex")
    mct_plex = _number(params, "mct_plex")
    mct_count = int(_number(params, "mct_count"))
    farm_months = _number(params, "farm_months")
    sp_day = _number(params, "sp_day")
    floor_sp = _number(params, "floor_sp")
    sp_lsi = _number(params, "sp_lsi") or 500000.0
    tax = _number(params, "tax_percent") / 100.0
    nes_qty = _number(params, "nes_qty") or 1.0
    nes_plex = _number(params, "nes_plex")
    krw_total = _number(params, "krw_total")

    chars = 1 + mct_count
    days = farm_months * 30.4167
    sp_per_char = sp_day * days - floor_sp
    total_sp = sp_per_char * chars
    lsi_count = int(total_sp // sp_lsi) if total_sp > 0 else 0
    extractor_needed = lsi_count
    nes_isk = (nes_plex / nes_qty) * plex_price
    extractor_unit = min(extractor_price, nes_isk)
    extractor_source = "market" if extractor_price <= nes_isk else "nes_plex"
    setup_plex = omega_plex + mct_count * mct_plex
    leftover_plex = budget - setup_plex
    leftover_isk = leftover_plex * plex_price
    direct_sale_isk = budget * plex_price
    lsi_gross = lsi_count * lsi_price
    lsi_net = lsi_gross * (1.0 - tax)
    extractor_cost = extractor_needed * extractor_unit
    farm_isk_before_tax = lsi_gross - extractor_cost + leftover_isk
    farm_isk = lsi_net - extractor_cost + leftover_isk
    direct_krw_per_billion = krw_total / (direct_sale_isk / 1e9) if direct_sale_isk > 0 else None
    farm_krw_per_billion = krw_total / (farm_isk / 1e9) if farm_isk > 0 else None

    return {
        "inputs": {
            "plex_price": plex_price,
            "lsi_price": lsi_price,
            "extractor_price": extractor_price,
            "budget": budget,
            "mct_count": mct_count,
            "krw_total": krw_total,
        },
        "outputs": {
            "characters": chars,
            "days": days,
            "sp_per_character": sp_per_char,
            "total_sp": total_sp,
            "large_skill_injectors": lsi_count,
            "extractors_needed": extractor_needed,
            "extractor_unit_isk": extractor_unit,
            "extractor_source": extractor_source,
            "setup_plex": setup_plex,
            "leftover_plex": leftover_plex,
            "direct_sale_isk": direct_sale_isk,
            "farm_isk_before_tax": farm_isk_before_tax,
            "farm_isk": farm_isk,
            "direct_krw_per_billion": direct_krw_per_billion,
            "farm_krw_per_billion": farm_krw_per_billion,
            "better_isk_route": "skill_farm" if farm_isk > direct_sale_isk else "direct_sale",
        },
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            _static_response(self, ROOT / "index.html")
            return
        if path == "/healthz":
            _json_response(self, 200, {"ok": True})
            return
        if path in ("/aggregates", "/api/market-data"):
            try:
                body, stale = MARKET_CACHE.get(lambda: _fetch(FUZZWORK_AGGREGATES_URL, timeout=15))
                _cached_json_bytes_response(self, body, stale=stale)
            except Exception:
                _json_response(self, 502, {"error": "upstream fetch failed"})
            return
        if path == "/steamomega":
            try:
                body, stale = STEAM_CACHE.get(_fetch_steam_omega)
                _cached_json_bytes_response(self, body, stale=stale)
            except Exception:
                _json_response(self, 502, {"error": "upstream fetch failed"})
            return
        if path == "/webstore":
            try:
                body, stale = WEBSTORE_CACHE.get(_fetch_webstore)
                _cached_json_bytes_response(
                    self, body, stale=stale, max_age=WEBSTORE_CACHE_SECONDS
                )
            except Exception:
                _json_response(self, 502, {"error": "upstream fetch failed"})
            return
        if path == "/api/calculate":
            _json_response(self, 200, calculate(params))
            return
        _json_response(self, 404, {"error": "not found"})

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    print(f"nisuwaz-tools listening on {BIND}:{PORT}")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()

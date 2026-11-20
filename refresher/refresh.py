"""Fetch public market data on a timer and write it as static JSON files.

Visitors never trigger an upstream request: Caddy serves the files this loop
writes (/aggregates, /steamomega, /evestore), and their modification time tells
the page how old the data is. A failed fetch leaves the previous file in place.
"""
import json
import logging
import math
import os
import re
import signal
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/srv/data"))
REFRESH_SECONDS = max(60, int(os.environ.get("REFRESH_SECONDS", "300")))
# Steam prices change rarely; refresh them every STEAM_EVERY market cycles.
STEAM_EVERY = max(1, int(os.environ.get("STEAM_EVERY", "6")))
# The EVE web store changes prices rarely; every STORE_EVERY cycles (6 h by default).
STORE_EVERY = max(1, int(os.environ.get("STORE_EVERY", "72")))

FUZZWORK_URL = os.environ.get(
    "FUZZWORK_AGGREGATES_URL",
    "https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=44992,40520,40519",
)
PLEX_TYPE = "44992"
# PLEX, Large Skill Injector, Skill Extractor: every quote the PLEX page reads.
MARKET_TYPES = (PLEX_TYPE, "40520", "40519")
QUOTE_FIELDS = ("max", "min")
STEAM_OMEGA_APPS = {1: 695740, 3: 695741, 6: 695742, 12: 695743, 24: 1983081}
STEAM_URL = "https://store.steampowered.com/api/appdetails?appids={app}&cc=kr&filters=price_overview"
EVE_STORE_URL = "https://store.eveonline.com/"
OMEGA_MONTHS = (1, 3, 6, 12, 24)
MAX_USD = 10_000

USER_AGENT = "nisuwaz-tools/2.0"
TIMEOUT_SECONDS = 15
MAX_BYTES = 2_000_000

log = logging.getLogger("refresher")


class UpstreamError(Exception):
    """The upstream answered with something we will not publish."""


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another https URL (never a downgrade or another scheme)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise UpstreamError(f"refusing redirect to {newurl!r}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnlyRedirects)


def fetch(url, timeout=TIMEOUT_SECONDS, accept="application/json"):
    """GET url; the whole exchange (connect, redirects, headers, body) ends within timeout seconds.

    urlopen's timeout bounds each socket operation only, and a server dripping a
    byte at a time could hold a read open for hours, so a wall-clock timer
    (SIGALRM) bounds the whole call. The refresher calls fetch from its single
    main thread only.
    """

    def expire(*_):
        raise UpstreamError(f"response took longer than {timeout} s")

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        chunks, size = [], 0
        with _OPENER.open(req, timeout=timeout) as res:
            while True:
                chunk = res.read1(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BYTES:
                    raise UpstreamError(f"response larger than {MAX_BYTES} bytes")
        return b"".join(chunks)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _reject_constant(name):
    raise ValueError(f"non-finite number {name}")


def _parse_json(raw, what):
    try:
        return json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, UnicodeDecodeError) as err:
        raise UpstreamError(f"{what} is not valid JSON") from err


def _finite(value):
    """Return value as a finite float, or raise ValueError."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f"not a number: {value!r}")
    num = float(value)
    if not math.isfinite(num):
        raise ValueError(f"not finite: {value!r}")
    return num


def _dumps(data, **kw):
    return json.dumps(data, allow_nan=False, sort_keys=True, **kw).encode("utf-8")


def build_aggregates(raw):
    """Validate a Fuzzwork aggregates body; return only the quotes the page reads.

    Every type needs a positive best bid (buy.max) and best ask (sell.min);
    otherwise the previous file stays published.
    """
    data = _parse_json(raw, "aggregates")
    if not isinstance(data, dict):
        raise UpstreamError("aggregates is not an object")
    out = {}
    for type_id in MARKET_TYPES:
        quote = data.get(type_id)
        if not isinstance(quote, dict):
            raise UpstreamError(f"aggregates has no quote for {type_id}")
        kept = {}
        for side in ("buy", "sell"):
            fields = quote.get(side)
            if not isinstance(fields, dict):
                raise UpstreamError(f"aggregates {type_id} has no {side} side")
            kept[side] = {}
            for name in QUOTE_FIELDS:
                if name not in fields:
                    continue
                try:
                    num = _finite(fields[name])
                except ValueError as err:
                    raise UpstreamError(f"aggregates {type_id} {side}.{name}: {err}") from err
                if num < 0:
                    raise UpstreamError(f"aggregates {type_id} {side}.{name} is negative")
                # Publish the validated number, not the upstream token: Python float()
                # accepts forms ("4_713_000") that the browser's parseFloat reads differently.
                kept[side][name] = format(num, ".15g")
        for side, name in (("buy", "max"), ("sell", "min")):
            if not float(kept[side].get(name, 0)) > 0:
                raise UpstreamError(f"aggregates {type_id} {side}.{name} is not positive")
        out[type_id] = kept
    return _dumps(out, separators=(",", ":"))


def _steam_entry(price):
    """Turn a Steam price_overview (KRW cents) into {final, initial, disc}, or raise ValueError."""
    final = int(_finite(price["final"])) // 100
    initial = int(_finite(price.get("initial", price["final"]))) // 100
    disc = int(_finite(price.get("discount_percent", 0)))
    if final <= 0 or initial < final or not 0 <= disc < 100:
        raise ValueError(f"implausible price {price!r}")
    return {"final": final, "initial": initial, "disc": disc}


def _valid_entries(previous):
    """Keep only well-formed entries of a previously published steamomega.json."""
    if not isinstance(previous, dict):
        return {}
    keep = {}
    for months, entry in previous.items():
        try:
            if str(months) in {str(m) for m in STEAM_OMEGA_APPS} and isinstance(entry, dict):
                keep[str(months)] = _steam_entry(
                    {"final": entry["final"] * 100, "initial": entry["initial"] * 100, "discount_percent": entry["disc"]})
        except (KeyError, TypeError, ValueError):
            continue
    return keep


def build_steam_omega(fetcher=fetch, previous=None):
    """Return {months: {final, initial, disc}} in KRW for every Omega app Steam prices.

    An app that fails this round keeps its entry from `previous` (the file on
    disk), so a transient error never swaps a sale price for nothing.
    """
    out = _valid_entries(previous)
    fresh = 0
    for months, app_id in STEAM_OMEGA_APPS.items():
        try:
            data = _parse_json(fetcher(STEAM_URL.format(app=app_id), timeout=10), "steam")
            entry = _steam_entry(data[str(app_id)]["data"]["price_overview"])
        except Exception as err:  # one app failing must not drop the others
            log.warning("steam app %s: %s", app_id, err)
            continue
        out[str(months)] = entry
        fresh += 1
    if not fresh or not out:
        raise UpstreamError("no Steam Omega price available")
    return _dumps(out, ensure_ascii=False)


# ---- EVE web store ----
# The store has no public price API. Its Next.js page embeds every offer as JSON
# inside `self.__next_f.push([1,"<js string>"])` script chunks; each offer is an
# object that starts with {"sysId": ... and carries a "pricing" object.
_RSC_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
_OFFER_START = '{"sysId":'
_OMEGA_TITLE = re.compile(r"^\s*(\d+)\s*(?:m|months?)\s+omega\b", re.I)
_BONUS_PLEX = re.compile(r"\+\s*([\d,]+)\s*PLEX\b", re.I)
_PLEX_PACK = re.compile(r"^\s*([\d,]+)\s*PLEX\s*$", re.I)
_BOOST = re.compile(r"^\s*(3x\s+)?(undock|afterburn|warp|jump)\s+boost\s+bundle\s*$", re.I)


_JSON_TOKENS = re.compile(r'["\\{}\[\]]')


def _skip_value(text, at):
    """Return the index just past the JSON object or array starting at `at` (end of text if unclosed)."""
    depth, in_string, escaped = 0, False, False
    for m in _JSON_TOKENS.finditer(text, at):
        ch = m.group()
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                # Only an escaped quote or backslash is itself a token the loop would see next.
                escaped = text[m.end():m.end() + 1] in ('"', "\\")
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
            if depth == 0:
                return m.end()
    return len(text)


def _store_offers(raw):
    """Yield the offer objects embedded in the store page, each id once."""
    try:
        page = raw.decode("utf-8")
    except UnicodeDecodeError as err:
        raise UpstreamError("store page is not UTF-8") from err
    chunks = []
    for literal in _RSC_CHUNK.findall(page):
        try:
            chunks.append(json.loads(literal))
        except ValueError:
            continue
    body = "".join(chunks)
    # NaN/Infinity decode as floats here; _usd -> _finite rejects them per offer. Rejecting them in the
    # decoder would raise without a position and force a quadratic rescan of nested offers.
    decoder = json.JSONDecoder()
    seen = set()
    at = body.find(_OFFER_START)
    while at != -1:
        try:
            offer, end = decoder.raw_decode(body, at)
        except json.JSONDecodeError as err:
            # Resume after the error, not just past this start: an offer that fails deep inside
            # would otherwise be re-read once per nested start, quadratic in the page size.
            end = max(at + len(_OFFER_START), err.pos)
        except (RecursionError, ValueError):
            # Too deep to decode, or a number int() refuses (over 4,300 digits): no error position,
            # so skip the whole offer in one pass; otherwise every nested start would fail again.
            end = _skip_value(body, at)
        else:
            oid = offer.get("id") if isinstance(offer, dict) else None
            if isinstance(oid, str) and oid not in seen:
                seen.add(oid)
                yield offer
        at = body.find(_OFFER_START, end)


def _usd(pricing):
    """Return (price, base) in USD from an offer's pricing object, or raise ValueError."""
    if not isinstance(pricing, dict) or pricing.get("currency") != "USD":
        raise ValueError("not a USD price")
    price = _finite(pricing["price"])
    base = _finite(pricing.get("basePrice", price))
    if not 0 < price <= MAX_USD:
        raise ValueError(f"implausible price {price!r}")
    if not price <= base <= MAX_USD:
        base = price
    return price, base


def _count(text):
    num = int(text.replace(",", ""))
    if not 0 < num <= 1_000_000:
        raise ValueError(f"implausible count {text!r}")
    return num


def build_eve_store(raw):
    """Return the store prices the PLEX page reads, in USD.

    {"omega": [{months, plex, price, base}], "plex": [{qty, price, base}],
     "boosts": [{key, price, base}]}. Offers are matched by title; anything
    unrecognised is ignored. Without an Omega offer and the 20,000 PLEX pack
    the round fails and the previous file stays published.
    """
    omega, plex, boosts = [], [], []
    for offer in _store_offers(raw):
        title = offer.get("title")
        if not isinstance(title, str) or offer.get("isRecurring") is True or offer.get("canPurchase") is False:
            continue
        try:
            price, base = _usd(offer.get("pricing"))
            if m := _OMEGA_TITLE.match(title):
                months = int(m.group(1))
                if months not in OMEGA_MONTHS:
                    continue
                bonus = _BONUS_PLEX.search(title)
                omega.append({"months": months, "plex": _count(bonus.group(1)) if bonus else 0, "price": price, "base": base})
            elif m := _PLEX_PACK.match(title):
                plex.append({"qty": _count(m.group(1)), "price": price, "base": base})
            elif m := _BOOST.match(title):
                key = ("3x-" if m.group(1) else "") + m.group(2).lower()
                boosts.append({"key": key, "price": price, "base": base})
        except (KeyError, TypeError, ValueError) as err:
            log.warning("store offer %r skipped: %s", title[:60], err)
    if not omega or not any(p["qty"] == 20000 for p in plex):
        raise UpstreamError("store page has no Omega offer or 20,000 PLEX pack")
    return _dumps({"omega": omega, "plex": plex, "boosts": boosts}, separators=(",", ":"))


def write_atomic(path, body):
    """Replace path with body so readers never see a partial file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def refresh_market(data_dir=DATA_DIR, fetcher=fetch):
    try:
        write_atomic(Path(data_dir) / "aggregates.json", build_aggregates(fetcher(FUZZWORK_URL)))
        return True
    except Exception as err:
        log.warning("market refresh failed, keeping previous data: %s", err)
        return False


def refresh_steam(data_dir=DATA_DIR, fetcher=fetch):
    try:
        path = Path(data_dir) / "steamomega.json"
        try:
            previous = _parse_json(path.read_bytes(), "previous steamomega")
        except (OSError, UpstreamError):
            previous = None
        write_atomic(path, build_steam_omega(fetcher, previous))
        return True
    except Exception as err:
        log.warning("steam refresh failed, keeping previous data: %s", err)
        return False


def refresh_store(data_dir=DATA_DIR, fetcher=fetch):
    try:
        raw = fetcher(EVE_STORE_URL, timeout=20, accept="text/html")
        write_atomic(Path(data_dir) / "evestore.json", build_eve_store(raw))
        return True
    except Exception as err:
        log.warning("store refresh failed, keeping previous data: %s", err)
        return False


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s refresher %(levelname)s %(message)s", stream=sys.stdout)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cycle = 0
    while True:
        refresh_market()
        if cycle % STEAM_EVERY == 0:
            refresh_steam()
        if cycle % STORE_EVERY == 0:
            refresh_store()
        cycle += 1
        time.sleep(REFRESH_SECONDS)


if __name__ == "__main__":
    main()

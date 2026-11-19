"""Fetch public market data on a timer and write it as static JSON files.

Visitors never trigger an upstream request: Caddy serves the files this loop
writes (/aggregates, /steamomega), and their modification time tells the page
how old the data is. A failed fetch leaves the previous file in place.
"""
import json
import logging
import math
import os
import signal
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from time import monotonic

DATA_DIR = Path(os.environ.get("DATA_DIR", "/srv/data"))
REFRESH_SECONDS = max(60, int(os.environ.get("REFRESH_SECONDS", "300")))
# Steam prices change rarely; refresh them every STEAM_EVERY market cycles.
STEAM_EVERY = max(1, int(os.environ.get("STEAM_EVERY", "6")))

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

USER_AGENT = "nisuwaz-tools/2.0"
TIMEOUT_SECONDS = 15
MAX_BYTES = 2_000_000

log = logging.getLogger("refresher")


class UpstreamError(Exception):
    """The upstream answered with something we will not publish."""


def fetch(url, timeout=TIMEOUT_SECONDS):
    """GET url; the whole exchange must finish within timeout seconds.

    urlopen's timeout bounds each socket operation only, so a server dripping a
    byte at a time could stall the loop; the read loop enforces a deadline.
    """
    deadline = monotonic() + timeout
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    chunks, size = [], 0
    with urllib.request.urlopen(req, timeout=timeout) as res:
        while True:
            if monotonic() > deadline:
                raise UpstreamError(f"response took longer than {timeout} s")
            chunk = res.read(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise UpstreamError(f"response larger than {MAX_BYTES} bytes")
    return b"".join(chunks)


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
                kept[side][name] = fields[name]
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


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s refresher %(levelname)s %(message)s", stream=sys.stdout)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cycle = 0
    while True:
        refresh_market()
        if cycle % STEAM_EVERY == 0:
            refresh_steam()
        cycle += 1
        time.sleep(REFRESH_SECONDS)


if __name__ == "__main__":
    main()

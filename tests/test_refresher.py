"""Tests for the market-data refresher (no external network: fetchers are stubbed or loopback)."""
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "refresher"))

import refresh  # noqa: E402

AGG = {
    "44992": {"buy": {"max": "4713000", "min": "100"}, "sell": {"min": "4800000", "max": "9000000"}},
    "40520": {"buy": {"max": "700200000"}, "sell": {"min": "710000000"}},
    "40519": {"buy": {"max": "460400000"}, "sell": {"min": "470000000"}},
}
GOOD_AGG = json.dumps(AGG).encode()


def agg_with(type_id, side, field, value):
    data = json.loads(GOOD_AGG)
    data[type_id][side][field] = value
    return json.dumps(data).encode()


def steam_body(app_id, final=26200_00, initial=26200_00, disc=0):
    return json.dumps({str(app_id): {"success": True, "data": {"price_overview": {
        "final": final, "initial": initial, "discount_percent": disc}}}}).encode()


class BuildAggregatesTests(unittest.TestCase):
    def test_accepts_a_plex_bid_and_reserialises(self):
        out = json.loads(refresh.build_aggregates(GOOD_AGG))
        self.assertEqual(out["44992"]["buy"]["max"], "4713000")

    def test_rejects_bodies_without_a_positive_plex_bid(self):
        for body in (b"<html>", b"[]", b"{}", json.dumps({"44992": {"buy": {"max": "0"}}}).encode(),
                     json.dumps({"44992": {"buy": {}}}).encode(), b"\xff\xfe"):
            with self.subTest(body=body):
                with self.assertRaises(refresh.UpstreamError):
                    refresh.build_aggregates(body)

    def test_rejects_when_lsi_or_extractor_quote_is_missing(self):
        for type_id in ("40520", "40519"):
            data = json.loads(GOOD_AGG)
            del data[type_id]
            with self.subTest(type_id=type_id), self.assertRaises(refresh.UpstreamError):
                refresh.build_aggregates(json.dumps(data).encode())
        with self.assertRaises(refresh.UpstreamError):
            refresh.build_aggregates(agg_with("40520", "sell", "min", "0"))

    def test_rejects_non_finite_numbers(self):
        for body in (agg_with("44992", "buy", "max", "inf"), agg_with("40519", "sell", "min", "nan"),
                     GOOD_AGG.replace(b'"100"', b"NaN"), GOOD_AGG.replace(b'"9000000"', b"Infinity")):
            with self.subTest(body=body[:60]), self.assertRaises(refresh.UpstreamError):
                refresh.build_aggregates(body)

    def test_publishes_the_validated_number_not_the_upstream_token(self):
        out = json.loads(refresh.build_aggregates(agg_with("44992", "buy", "max", "47_13_000")))
        self.assertEqual(out["44992"]["buy"]["max"], "4713000")
        out = json.loads(refresh.build_aggregates(agg_with("44992", "buy", "max", "4713000.50")))
        self.assertEqual(out["44992"]["buy"]["max"], "4713000.5")

    def test_keeps_only_the_quotes_the_page_reads(self):
        data = json.loads(GOOD_AGG)
        data["44992"]["buy"]["weird"] = "<script>"
        data["99999"] = {"buy": {"max": "1"}}
        out = json.loads(refresh.build_aggregates(json.dumps(data).encode()))
        self.assertEqual(sorted(out), ["40519", "40520", "44992"])
        self.assertNotIn("weird", out["44992"]["buy"])
        self.assertEqual(out["44992"]["sell"]["max"], "9000000")


class BuildSteamTests(unittest.TestCase):
    def test_converts_cents_and_skips_failed_apps(self):
        def fetcher(url, timeout=None):
            app = int(url.split("appids=")[1].split("&")[0])
            if app == refresh.STEAM_OMEGA_APPS[3]:
                raise OSError("timeout")
            if app == refresh.STEAM_OMEGA_APPS[6]:
                return json.dumps({str(app): {"success": False}}).encode()
            return steam_body(app, final=259380_00, initial=345840_00, disc=25)

        out = json.loads(refresh.build_steam_omega(fetcher))
        self.assertEqual(sorted(out), ["1", "12", "24"])
        self.assertEqual(out["24"], {"final": 259380, "initial": 345840, "disc": 25})

    def test_raises_when_no_app_has_a_price(self):
        with self.assertRaises(refresh.UpstreamError):
            refresh.build_steam_omega(lambda url, timeout=None: b"{}")

    def test_failed_apps_keep_their_previous_price(self):
        previous = {"3": {"final": 50000, "initial": 62880, "disc": 20}, "1": {"final": 1, "initial": 1, "disc": 0}}

        def fetcher(url, timeout=None):
            app = int(url.split("appids=")[1].split("&")[0])
            if app == refresh.STEAM_OMEGA_APPS[3]:
                raise OSError("timeout")
            return steam_body(app)

        out = json.loads(refresh.build_steam_omega(fetcher, previous))
        self.assertEqual(out["3"], previous["3"])
        self.assertEqual(out["1"], {"final": 26200, "initial": 26200, "disc": 0})

    def test_ignores_zero_or_missing_prices(self):
        def fetcher(url, timeout=None):
            app = int(url.split("appids=")[1].split("&")[0])
            if app == refresh.STEAM_OMEGA_APPS[1]:
                return json.dumps({str(app): {"data": {"price_overview": {"initial": 2620000}}}}).encode()
            if app == refresh.STEAM_OMEGA_APPS[3]:
                return steam_body(app, final=0)
            return steam_body(app)

        out = json.loads(refresh.build_steam_omega(fetcher))
        self.assertNotIn("1", out)
        self.assertNotIn("3", out)
        self.assertIn("6", out)

    def test_refresh_steam_merges_with_the_file_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            prev = {"24": {"final": 259380, "initial": 345840, "disc": 25}}
            (Path(d) / "steamomega.json").write_text(json.dumps(prev))

            def fetcher(url, timeout=None):
                app = int(url.split("appids=")[1].split("&")[0])
                if app == refresh.STEAM_OMEGA_APPS[24]:
                    raise OSError("reset")
                return steam_body(app)

            self.assertTrue(refresh.refresh_steam(d, fetcher))
            out = json.loads((Path(d) / "steamomega.json").read_text())
            self.assertEqual(out["24"], prev["24"])
            self.assertEqual(sorted(out), ["1", "12", "24", "3", "6"])


def store_offer(oid, title, price, base=None, currency="USD", **extra):
    return {"sysId": "s" + oid, "id": oid, "title": title, "pricing": {
        "currency": currency, "currencySymbol": "$$", "price": price, "basePrice": base if base is not None else price},
        "isRecurring": False, "canPurchase": True, **extra}


def store_page(*offers, chunks=2):
    """A store page shaped like the real one: offers inside Next.js RSC push chunks, split mid-object."""
    payload = json.dumps({"children": list(offers)})
    step = max(1, len(payload) // chunks + 1)
    parts = [payload[i:i + step] for i in range(0, len(payload), step)]
    scripts = "".join(f"<script>self.__next_f.push([1,{json.dumps(p)}])</script>" for p in parts)
    return f"<html><body><div>$15.00</div>{scripts}</body></html>".encode()


GOOD_STORE = store_page(
    store_offer("o1", "1 Month Omega + Bonus Items", 15, 20),
    store_offer("o24p", "24m omega + 1500 PLEX", 264, 329),
    store_offer("p20", "20,000 PLEX", 650),
    store_offer("p500", "500 PLEX", 25),
    store_offer("b1", "Undock Boost Bundle", 16),
    store_offer("b2", "3x Jump Boost Bundle", 384),
    store_offer("x", "Amarr Campaign Pack", 30),
)


class BuildEveStoreTests(unittest.TestCase):
    def test_reads_omega_plex_and_boost_offers_from_split_chunks(self):
        out = json.loads(refresh.build_eve_store(GOOD_STORE))
        self.assertEqual(out["omega"], [
            {"months": 1, "plex": 0, "price": 15, "base": 20},
            {"months": 24, "plex": 1500, "price": 264, "base": 329}])
        self.assertEqual([p["qty"] for p in out["plex"]], [20000, 500])
        self.assertEqual([b["key"] for b in out["boosts"]], ["undock", "3x-jump"])

    def test_skips_odd_offers_without_failing_the_round(self):
        page = store_page(
            store_offer("o1", "1 Month Omega", 15),
            store_offer("o2", "2m Omega", 30),  # not a tier the page knows
            store_offer("o3", "3m Omega", 36, currency="EUR"),
            store_offer("o6", "6m Omega", -1),
            store_offer("o12", "12m Omega", float("1e9")),
            store_offer("o24", "24m Omega", 198, extra_field="<script>"),
            store_offer("sub", "1 Month Omega", 12, isRecurring=True),
            store_offer("p20", "20,000 PLEX", 650, 600),  # base below price is ignored
            store_offer("p20", "20,000 PLEX", 1),  # same id again
        )
        out = json.loads(refresh.build_eve_store(page))
        self.assertEqual([(o["months"], o["price"]) for o in out["omega"]], [(1, 15), (24, 198)])
        self.assertNotIn("extra_field", json.dumps(out))
        self.assertEqual(out["plex"], [{"qty": 20000, "price": 650, "base": 650}])

    def test_rejects_pages_without_omega_or_the_20k_pack(self):
        for page in (b"<html>maintenance</html>", b"\xff\xfe", store_page(store_offer("p20", "20,000 PLEX", 650)),
                     store_page(store_offer("o1", "1 Month Omega", 15), store_offer("p5", "500 PLEX", 25))):
            with self.subTest(page=page[:40]), self.assertRaises(refresh.UpstreamError):
                refresh.build_eve_store(page)

    def test_refresh_store_writes_and_keeps_previous_on_failure(self):
        with tempfile.TemporaryDirectory() as d:
            calls = []

            def fetcher(url, timeout=None, accept=None):
                calls.append((url, accept))
                return GOOD_STORE

            self.assertTrue(refresh.refresh_store(d, fetcher))
            self.assertEqual(calls, [(refresh.EVE_STORE_URL, "text/html")])
            before = (Path(d) / "evestore.json").read_bytes()
            self.assertFalse(refresh.refresh_store(d, lambda url, timeout=None, accept=None: b"<html></html>"))
            self.assertEqual((Path(d) / "evestore.json").read_bytes(), before)


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_successful_refresh_writes_the_file(self):
        self.assertTrue(refresh.refresh_market(self.path, lambda url: GOOD_AGG))
        self.assertEqual(json.loads((self.path / "aggregates.json").read_bytes())["44992"]["buy"]["max"], "4713000")

    def test_failed_refresh_keeps_the_previous_file(self):
        refresh.refresh_market(self.path, lambda url: GOOD_AGG)
        before = (self.path / "aggregates.json").read_bytes()

        def boom(url):
            raise OSError("connection reset")

        self.assertFalse(refresh.refresh_market(self.path, boom))
        self.assertFalse(refresh.refresh_market(self.path, lambda url: b"<html>maintenance</html>"))
        self.assertEqual((self.path / "aggregates.json").read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.path.iterdir()), ["aggregates.json"])

    def test_atomic_write_leaves_no_temp_file_and_is_world_readable(self):
        refresh.write_atomic(self.path / "x.json", b"{}")
        self.assertEqual([p.name for p in self.path.iterdir()], ["x.json"])
        self.assertEqual((self.path / "x.json").stat().st_mode & 0o777, 0o644)

    def test_steam_refresh_failure_keeps_previous_file(self):
        (self.path / "steamomega.json").write_bytes(b'{"1":{"final":1,"initial":1,"disc":0}}')
        self.assertFalse(refresh.refresh_steam(self.path, lambda url, timeout=None: b"{}"))
        self.assertEqual((self.path / "steamomega.json").read_bytes(), b'{"1":{"final":1,"initial":1,"disc":0}}')


class FetchLimitTests(unittest.TestCase):
    def test_rejects_oversized_responses(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read1(self, n):
                return b"x" * n

        original = refresh._OPENER.open
        refresh._OPENER.open = lambda req, timeout: FakeResponse()
        try:
            with self.assertRaises(refresh.UpstreamError):
                refresh.fetch("https://example.invalid/")
        finally:
            refresh._OPENER.open = original

    def _drip_server(self, head, body, gap):
        """Loopback server that sends `head` then `body` one byte every `gap` seconds."""
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        stop = threading.Event()

        def serve():
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.recv(4096)
                    for b in head + body:
                        if stop.is_set():
                            return
                        conn.sendall(bytes([b]))
                        time.sleep(gap)
                except OSError:
                    pass

        t = threading.Thread(target=serve, daemon=True)
        t.start()
        self.addCleanup(lambda: (stop.set(), srv.close(), t.join(5)))
        return f"http://127.0.0.1:{srv.getsockname()[1]}/"

    def _assert_gives_up_in_time(self, url):
        started = time.monotonic()
        with self.assertRaises(refresh.UpstreamError):
            refresh.fetch(url, timeout=1)
        self.assertLess(time.monotonic() - started, 2.5)

    def test_gives_up_on_a_slow_drip_body(self):
        body = b'{"drip":"' + b"x" * 40 + b'"}'
        head = b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body)
        self._assert_gives_up_in_time(self._drip_server(head, body, 0.1))

    def test_gives_up_on_slow_drip_headers(self):
        head = b"HTTP/1.1 200 OK\r\nX-Pad: " + b"y" * 40 + b"\r\nContent-Length: 2\r\n\r\n"
        self._assert_gives_up_in_time(self._drip_server(head, b"{}", 0.1))

    def test_refuses_redirects_to_non_https(self):
        head = b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\n\r\n"
        with self.assertRaises(refresh.UpstreamError):
            refresh.fetch(self._drip_server(head, b"", 0), timeout=5)

    def test_fast_response_still_succeeds_and_timer_is_cleared(self):
        head = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n"
        self.assertEqual(refresh.fetch(self._drip_server(head, b"{}", 0), timeout=5), b"{}")
        self.assertEqual(refresh.signal.getitimer(refresh.signal.ITIMER_REAL), (0.0, 0.0))

if __name__ == "__main__":
    unittest.main()

"""Tests for the market-data refresher (no network: fetchers are stubbed)."""
import json
import sys
import tempfile
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

            def read(self, n):
                return b"x" * n

        original = refresh.urllib.request.urlopen
        refresh.urllib.request.urlopen = lambda req, timeout: FakeResponse()
        try:
            with self.assertRaises(refresh.UpstreamError):
                refresh.fetch("https://example.invalid/")
        finally:
            refresh.urllib.request.urlopen = original

    def test_gives_up_on_a_slow_drip_response(self):
        clock = [0.0]

        class Drip:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, n):
                clock[0] += 5  # every small chunk takes 5 s, never ending
                return b"x"

        original_open, original_clock = refresh.urllib.request.urlopen, refresh.monotonic
        refresh.urllib.request.urlopen = lambda req, timeout: Drip()
        refresh.monotonic = lambda: clock[0]
        try:
            with self.assertRaises(refresh.UpstreamError):
                refresh.fetch("https://example.invalid/", timeout=15)
            self.assertLessEqual(clock[0], 25)
        finally:
            refresh.urllib.request.urlopen, refresh.monotonic = original_open, original_clock


if __name__ == "__main__":
    unittest.main()

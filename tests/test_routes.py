"""Route tests for the tool hub: pages, icons, and path safety."""
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.BoundedThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, method="GET"):
        req = urllib.request.Request(self.base + path, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers, err.read()

    def assert_html_page(self, path, must_contain):
        status, headers, body = self.get(path)
        self.assertEqual(status, 200, path)
        self.assertTrue(headers["Content-Type"].startswith("text/html"), path)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        text = body.decode("utf-8")
        for needle in must_contain:
            self.assertIn(needle, text, f"{path} missing {needle!r}")
        return text

    def test_hub_lists_both_tools(self):
        text = self.assert_html_page("/", ["니수와즈 도구 조각모음", 'href="/fridge"', 'href="/plex"'])
        self.assertIn("/icons/fridge.png", text)
        self.assertIn("/icons/plex.png", text)

    def test_hub_has_no_placeholder_tools(self):
        _, _, body = self.get("/")
        text = body.decode("utf-8")
        self.assertNotIn("준비 중", text)
        self.assertNotIn("스트럭처 타이머", text)

    def test_index_html_serves_hub(self):
        self.assert_html_page("/index.html", ["니수와즈 도구 조각모음"])

    def test_plex_page(self):
        self.assert_html_page("/plex", ["현질 효율 계산기", 'href="/"', "/icons/plex.png"])

    def test_fridge_page(self):
        text = self.assert_html_page("/fridge", ["냉장고 계산기", 'href="/"', "/icons/fridge.png"])
        self.assertNotIn("지타 쇼핑리스트", text)

    def test_tool_pages_accept_trailing_slash(self):
        self.assert_html_page("/plex/", ["현질 효율 계산기"])
        self.assert_html_page("/fridge/", ["냉장고 계산기"])

    def test_icons_are_png(self):
        for name in ("fridge", "plex"):
            status, headers, body = self.get(f"/icons/{name}.png")
            self.assertEqual(status, 200, name)
            self.assertEqual(headers["Content-Type"], "image/png")
            self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"), name)

    def test_unknown_and_traversal_paths_are_404(self):
        for path in (
            "/icons/missing.png",
            "/icons/../app.py",
            "/icons/%2e%2e/app.py",
            "/app.py",
            "/hub.html",
            "/plex.html",
            "/Dockerfile",
            "/nope",
        ):
            status, _, _ = self.get(path)
            self.assertEqual(status, 404, path)

    def test_existing_api_routes_still_work(self):
        status, _, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertIn(b'"ok": true', body)
        status, _, body = self.get("/api/calculate")
        self.assertEqual(status, 200)
        self.assertIn(b"farm_krw_per_billion", body)

    def test_head_request_has_no_body(self):
        status, headers, body = self.get("/", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)

    def test_head_healthz_is_ok(self):
        status, _, body = self.get("/healthz", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()

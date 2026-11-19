"""Availability tests: upstream cache backoff and connection limits (no network)."""
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402


class FailingFetcher:
    def __init__(self):
        self.calls = 0

    def __call__(self):
        self.calls += 1
        raise OSError("upstream down")


def wait_until(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        time.sleep(0.01)


def expired():
    return time.monotonic() - app.UPSTREAM_CACHE_SECONDS - 1


def backoff_over():
    return time.monotonic() - app.UPSTREAM_FAILURE_BACKOFF_SECONDS - 1


class UpstreamCacheTests(unittest.TestCase):
    def test_failure_is_not_retried_during_backoff(self):
        cache = app.UpstreamCache()
        fetcher = FailingFetcher()
        with self.assertRaises(OSError):
            cache.get(fetcher)
        with self.assertRaises(app.UpstreamUnavailable):
            cache.get(fetcher)
        self.assertEqual(fetcher.calls, 1)

    def test_stale_body_served_without_refetch_during_backoff(self):
        cache = app.UpstreamCache()
        cache.body = b"{}"
        cache.fetched_at = expired()
        fetcher = FailingFetcher()
        self.assertEqual(cache.get(fetcher), (b"{}", True))
        self.assertEqual(cache.get(fetcher), (b"{}", True))
        self.assertEqual(fetcher.calls, 1)

    def test_retries_after_backoff_expires(self):
        cache = app.UpstreamCache()
        with self.assertRaises(OSError):
            cache.get(FailingFetcher())
        cache.failed_at = backoff_over()
        self.assertEqual(cache.get(lambda: b"[1]"), (b"[1]", False))

    def test_success_clears_failure_state(self):
        cache = app.UpstreamCache()
        cache.failed_at = backoff_over()
        self.assertEqual(cache.get(lambda: b"[2]"), (b"[2]", False))
        self.assertIsNone(cache.failed_at)

    def _call_while_lock_held(self, cache, fetcher):
        """Run cache.get in a thread while another 'request' holds the lock."""
        results = []
        cache.lock.acquire()
        try:
            def run():
                try:
                    results.append(cache.get(fetcher))
                except Exception as err:  # noqa: BLE001 - recorded for assertion
                    results.append(err)

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(timeout=0.5)
            self.assertFalse(worker.is_alive(), "caller waited on another caller's fetch")
        finally:
            cache.lock.release()
        worker.join(timeout=2)
        return results

    def test_stale_body_returned_immediately_while_another_fetch_runs(self):
        cache = app.UpstreamCache()
        cache.body = b"{}"
        cache.fetched_at = expired()
        fetcher = FailingFetcher()
        self.assertEqual(self._call_while_lock_held(cache, fetcher), [(b"{}", True)])
        self.assertEqual(fetcher.calls, 0)

    def test_no_body_after_failure_fails_fast_while_retry_runs(self):
        cache = app.UpstreamCache()
        cache.failed_at = backoff_over()
        fetcher = FailingFetcher()
        results = self._call_while_lock_held(cache, fetcher)
        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], app.UpstreamUnavailable)
        self.assertEqual(fetcher.calls, 0)


class ServerTestCase(unittest.TestCase):
    def start(self, handler=app.Handler, **kwargs):
        server = app.BoundedThreadingHTTPServer(("127.0.0.1", 0), handler, **kwargs)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        def stop():
            server.shutdown()
            server.server_close()

        self.addCleanup(stop)
        return server

    def healthz(self, server):
        url = f"http://127.0.0.1:{server.server_address[1]}/healthz"
        with urllib.request.urlopen(url, timeout=3) as res:
            return res.status


class ConnectionLimitTests(ServerTestCase):
    def test_handler_has_socket_timeout(self):
        self.assertIsNotNone(app.Handler.timeout)
        self.assertGreater(app.Handler.timeout, 0)
        self.assertLessEqual(app.Handler.timeout, 30)

    def test_idle_connection_is_closed_by_server(self):
        class FastTimeoutHandler(app.Handler):
            timeout = 0.3

        server = self.start(FastTimeoutHandler, max_connections=4)
        with socket.create_connection(server.server_address, timeout=3) as sock:
            self.assertEqual(sock.recv(1), b"")

    def test_slow_drip_request_line_hits_read_deadline(self):
        class ShortDeadlineHandler(app.Handler):
            timeout = 2
            request_read_deadline = 0.5

        self.assert_drip_is_cut(ShortDeadlineHandler, b"", b"GET /healthz HTTP/1.0\r\n")

    def test_slow_drip_headers_hit_read_deadline(self):
        class ShortDeadlineHandler(app.Handler):
            timeout = 2
            request_read_deadline = 0.5

        self.assert_drip_is_cut(
            ShortDeadlineHandler, b"GET /healthz HTTP/1.0\r\n", b"X-Padding: aaaaaaaaaaaaaaaaaaaaaaaa\r\n"
        )

    def assert_drip_is_cut(self, handler, prefix, drip):
        server = self.start(handler, max_connections=4)
        with socket.create_connection(server.server_address, timeout=3) as sock:
            if prefix:
                sock.sendall(prefix)
            started = time.monotonic()
            closed = False
            for ch in drip:
                try:
                    sock.sendall(bytes([ch]))
                except OSError:
                    closed = True
                    break
                sock.settimeout(0.2)
                try:
                    if sock.recv(1) == b"":
                        closed = True
                        break
                except socket.timeout:
                    pass
                except OSError:  # e.g. ConnectionResetError once the server has closed
                    closed = True
                    break
                finally:
                    sock.settimeout(3)
                if time.monotonic() - started > 2.5:
                    break
            self.assertTrue(closed, "slow-drip connection outlived the request-read deadline")
            self.assertLess(time.monotonic() - started, 2.5)

    def test_slow_handler_is_not_cut_by_request_read_deadline(self):
        class SlowUpstreamHandler(app.Handler):
            request_read_deadline = 0.5

            def do_GET(self):
                time.sleep(1.5)  # e.g. a cold-start upstream fetch
                super().do_GET()

        server = self.start(SlowUpstreamHandler, max_connections=4)
        self.assertEqual(self.healthz(server), 200)

    def test_connection_slots_are_released_after_requests(self):
        server = self.start(max_connections=2)
        for _ in range(6):
            self.assertEqual(self.healthz(server), 200)

    def test_full_server_rejects_extra_connections_without_blocking(self):
        server = self.start(max_connections=1)
        with socket.create_connection(server.server_address, timeout=3):
            wait_until(lambda: server._slots._value == 0)
            with socket.create_connection(server.server_address, timeout=3) as extra:
                reply = extra.recv(64)
                self.assertTrue(reply.startswith(b"HTTP/1.0 503"), reply)
        deadline = time.monotonic() + 3
        while True:
            try:
                self.assertEqual(self.healthz(server), 200)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)

    def test_slot_released_when_handler_raises(self):
        class BrokenHandler(app.Handler):
            def do_GET(self):
                raise RuntimeError("boom")

        server = self.start(BrokenHandler, max_connections=1)
        server.handle_error = lambda request, client_address: None
        for _ in range(3):
            with self.assertRaises(OSError):
                self.healthz(server)
        self.assertTrue(server._slots.acquire(timeout=2))
        server._slots.release()


class UpstreamOutageRouteTests(ServerTestCase):
    def test_backoff_returns_502(self):
        cache = app.UpstreamCache()
        cache.failed_at = time.monotonic()
        original = app.MARKET_CACHE
        app.MARKET_CACHE = cache
        self.addCleanup(setattr, app, "MARKET_CACHE", original)
        server = self.start()
        url = f"http://127.0.0.1:{server.server_address[1]}/aggregates"
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(url, timeout=3)
        self.assertEqual(ctx.exception.code, 502)


if __name__ == "__main__":
    unittest.main()

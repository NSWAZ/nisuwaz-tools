"""Smoke test for a running image: routes, status codes and security headers.

Runs inside the container (stdlib only), e.g.
    docker exec -i <container> python3 - < docker/smoke.py
Exits non-zero and prints every failed check.
"""
import http.client
import sys
import time

BASE = ("127.0.0.1", 8080)
SECURITY = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
}

# (method, path, expected status)
CASES = [
    ("GET", "/", 200),
    ("GET", "/plex", 200),
    ("GET", "/fridge", 200),
    ("GET", "/healthz", 200),
    ("HEAD", "/", 200),
    ("GET", "/no-such-page", 404),
    ("GET", "/assets/no-such-file.js", 404),
    ("POST", "/", 405),
]


def request(method, path):
    conn = http.client.HTTPConnection(*BASE, timeout=5)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        resp.read()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}
    finally:
        conn.close()


def wait_ready(seconds=30):
    deadline = time.monotonic() + seconds
    while True:
        try:
            if request("GET", "/healthz")[0] == 200:
                return
        except OSError:
            pass
        if time.monotonic() > deadline:
            sys.exit("server did not become ready")
        time.sleep(0.5)


def main():
    wait_ready()
    failures = []
    for method, path, want in CASES:
        status, headers = request(method, path)
        if status != want:
            failures.append(f"{method} {path}: status {status}, want {want}")
        for name, value in SECURITY.items():
            if headers.get(name) != value:
                failures.append(f"{method} {path}: {name} is {headers.get(name)!r}, want {value!r}")
        csp = headers.get("content-security-policy", "")
        if "frame-ancestors 'none'" not in csp:
            failures.append(f"{method} {path}: content-security-policy missing frame-ancestors 'none'")
        print(f"{method:4} {path:26} {status}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        sys.exit(1)
    print(f"all {len(CASES)} checks passed")


if __name__ == "__main__":
    main()

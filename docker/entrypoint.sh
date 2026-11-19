#!/bin/sh
# Runs the market refresher and Caddy side by side. If either stops, stop the
# other and exit non-zero so the container restart policy brings both back.
set -eu

python3 /app/refresh.py &
refresher=$!
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
server=$!

stopping=0
stop() {
	stopping=1
	kill -TERM "$server" "$refresher" 2>/dev/null || true
}
trap stop TERM INT

while [ "$stopping" -eq 0 ] && kill -0 "$server" 2>/dev/null && kill -0 "$refresher" 2>/dev/null; do
	sleep 1
done

# Asked to stop (docker stop): clean exit. A process died on its own: fail.
requested=$stopping
stop
wait || true
[ "$requested" -eq 1 ] && exit 0
exit 1

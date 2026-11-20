# syntax=docker/dockerfile:1

# ---- build the React site (tests run here too) ----
FROM node:22.22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit
COPY web/ ./
RUN npm test && npm run build

# ---- runtime: Caddy serves files, the refresher writes market snapshots ----
FROM caddy:2.11.9-alpine
# Port 8080 needs no bind capability; dropping caddy's file capability lets the
# container run with --cap-drop ALL and no-new-privileges.
RUN apk add --no-cache python3 libcap \
 && setcap -r /usr/bin/caddy \
 && apk del libcap \
 && addgroup -S app && adduser -S -G app -H app \
 && mkdir -p /srv/data /tmp/caddy && chown app:app /srv/data /tmp/caddy

ENV PORT=8080 \
    DATA_DIR=/srv/data \
    XDG_CONFIG_HOME=/tmp/caddy \
    XDG_DATA_HOME=/tmp/caddy \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=web /web/dist /srv/site
COPY refresher/refresh.py /app/refresh.py
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY Caddyfile /etc/caddy/Caddyfile

USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]

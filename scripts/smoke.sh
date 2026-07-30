#!/bin/sh
set -eu

PORT="${PORT:-18081}"
LOG="${TMPDIR:-/tmp}/rowake-smoke.log"
./bin/rowake serve --listen "127.0.0.1:${PORT}" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM

attempt=0
while [ "$attempt" -lt 80 ]; do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
    cat "$LOG" >&2 || true
    echo "Rowake did not become healthy" >&2
    exit 1
fi

curl -fsS "http://127.0.0.1:${PORT}/api/v1/meta" | grep -q 'Rowake'
curl -fsS "http://127.0.0.1:${PORT}/" | grep -q '<title>Rowake</title>'

CONNECTION_RESPONSE=$(curl -fsS \
    -H 'Content-Type: application/json' \
    --data '{"name":"Test database","engine":"sqlite","data_source_name":"testdata/rowake-test.sqlite"}' \
    "http://127.0.0.1:${PORT}/api/v1/connections")
CONNECTION_ID=$(printf '%s' "$CONNECTION_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$CONNECTION_ID" ]; then
    echo "Connection API did not return an id: $CONNECTION_RESPONSE" >&2
    exit 1
fi

curl -fsS "http://127.0.0.1:${PORT}/api/v1/connections" | grep -q '"name":"Test database"'
curl -fsS "http://127.0.0.1:${PORT}/api/v1/catalog?connection_id=${CONNECTION_ID}" | grep -q '"name":"users"'
curl -fsS "http://127.0.0.1:${PORT}/api/v1/topology?connection_id=${CONNECTION_ID}" | grep -q '"from_table":"projects"'
curl -fsS "http://127.0.0.1:${PORT}/api/v1/table?connection_id=${CONNECTION_ID}&schema=main&table=users&limit=10" | grep -q 'alice@example.test'
curl -fsS \
    -H 'Content-Type: application/json' \
    --data "{\"connection_id\":\"${CONNECTION_ID}\",\"sql\":\"SELECT name FROM projects ORDER BY id\",\"limit\":10}" \
    "http://127.0.0.1:${PORT}/api/v1/query" | grep -q '"Atlas"'

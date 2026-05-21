#!/usr/bin/env bash
# Spin up a local Postgres with wal_level=logical, run the emit-latency
# benchmark, then tear it down. Produces the numbers cited in §4 / §8 of
# content/posts/outbox-without-outbox-pg-logical-messages/index.md.
set -euo pipefail

PGDIR=/tmp/pg-emit-bench
PORT=5599

# Pick a Postgres ≥ 14. Tries Nix store first, then system PATH.
PGBIN=$(ls -d /nix/store/*-postgresql-17*/bin 2>/dev/null | head -1 || true)
if [ -z "$PGBIN" ]; then PGBIN=$(dirname "$(command -v initdb)"); fi
test -x "$PGBIN/initdb" || { echo "no initdb"; exit 1; }

cleanup() {
    "$PGBIN/pg_ctl" -D "$PGDIR/data" stop -m fast >/dev/null 2>&1 || true
    rm -rf "$PGDIR"
}
trap cleanup EXIT

rm -rf "$PGDIR" && mkdir -p "$PGDIR"
"$PGBIN/initdb" -D "$PGDIR/data" -U postgres --no-locale --encoding=UTF8 >/dev/null
cat >> "$PGDIR/data/postgresql.conf" <<EOF
wal_level = logical
max_wal_senders = 4
max_replication_slots = 4
port = $PORT
unix_socket_directories = '$PGDIR'
fsync = on
synchronous_commit = on
shared_buffers = 256MB
EOF
"$PGBIN/pg_ctl" -D "$PGDIR/data" -l "$PGDIR/server.log" -w start >/dev/null
"$PGBIN/psql" -h "$PGDIR" -p $PORT -U postgres -c "CREATE DATABASE bench;" >/dev/null
"$PGBIN/psql" -h "$PGDIR" -p $PORT -U postgres -d bench -c \
    "CREATE TABLE dummy (id bigserial PRIMARY KEY, v bytea);" >/dev/null

cd "$(dirname "$0")"
echo "=== TCP loopback ==="
go run main.go

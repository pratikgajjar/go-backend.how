#!/usr/bin/env bash
# Run the scorer for the scylla-shard-per-core post.
# Emits `METRIC name=value` lines, including primary `defects`.
set -euo pipefail
ROOT="/Users/pratikgajjar/ambitious/go-backend.how"
POST="$ROOT/content/posts/scylla-shard-per-core/index.md"
CACHE="/Users/pratikgajjar/.cache/checkouts/github.com/scylladb/seastar"
exec python3 "$ROOT/.autoresearch/score.py" "$POST" "$CACHE"

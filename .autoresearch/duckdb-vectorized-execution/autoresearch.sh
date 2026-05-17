#!/usr/bin/env bash
# Run the shared scorer on the duckdb-vectorized-execution post.
set -euo pipefail
ROOT="/Users/pratikgajjar/ambitious/go-backend.how"
POST="$ROOT/content/posts/duckdb-vectorized-execution/index.md"
CACHED="/Users/pratikgajjar/.cache/checkouts/github.com/duckdb/duckdb"
exec python3 "$ROOT/.autoresearch/score.py" "$POST" "$CACHED"

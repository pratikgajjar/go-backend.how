#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
POST="$ROOT/content/posts/pg-partman-partition-pruning/index.md"
CACHED="$HOME/.cache/checkouts/github.com/pgpartman/pg_partman"
exec python3 "$ROOT/.autoresearch/score.py" "$POST" "$CACHED"

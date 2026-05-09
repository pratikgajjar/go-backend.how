#!/usr/bin/env bash
# Score the badgerdb-internals post; emit METRIC lines on stdout.
# Usage: bash autoresearch.sh
set -euo pipefail
cd "$(dirname "$0")"
POST="../../content/posts/badgerdb-internals/index.md"
REPO="$HOME/.cache/checkouts/github.com/dgraph-io/badger"
python3 ../score.py "$POST" "$REPO"

#!/usr/bin/env bash
# Score the wal-cake post; emit METRIC lines on stdout.
# Usage: bash autoresearch.sh
set -euo pipefail
cd "$(dirname "$0")"
POST="../../content/posts/wal-cake-lock-free-cdc/index.md"
REPO="$HOME/.cache/checkouts/github.com/fampay-inc/wal-cake"
python3 ../score.py "$POST" "$REPO"

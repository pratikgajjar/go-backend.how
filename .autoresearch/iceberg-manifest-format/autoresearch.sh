#!/usr/bin/env bash
# Score the iceberg-manifest-format post; emit METRIC lines on stdout.
# Usage: bash autoresearch.sh
set -euo pipefail
cd "$(dirname "$0")"
POST="../../content/posts/iceberg-manifest-format/index.md"
REPO="$HOME/.cache/checkouts/github.com/apache/iceberg"
python3 ../score.py "$POST" "$REPO"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
POST="$ROOT/content/posts/outbox-without-outbox-pg-logical-messages/index.md"
CACHED="$HOME/.cache/checkouts/github.com/fampay-inc/factlib"
exec python3 "$(dirname "${BASH_SOURCE[0]}")/scorer.py" "$POST" "$CACHED"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
POST="$ROOT/content/posts/etcd-raft-leader-election/index.md"
CACHED="$HOME/.cache/checkouts/github.com/etcd-io/raft"
exec python3 "$(dirname "${BASH_SOURCE[0]}")/scorer.py" "$POST" "$CACHED"

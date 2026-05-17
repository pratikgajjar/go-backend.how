#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"
POST="$ROOT/content/posts/distroless-cold-start-k8s/index.md"
RIG="$ROOT/.autoresearch/distroless/repo"
exec python3 "$(dirname "${BASH_SOURCE[0]}")/scorer.py" "$POST" "$RIG"

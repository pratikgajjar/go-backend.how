#!/bin/sh
# autoresearch.sh — run the defect scorer for the pgvector-hnsw post
# Uses a local fork of score.py with pgvector-specific section requirements.
set -e
ROOT="/Users/pratikgajjar/ambitious/go-backend.how"
POST="$ROOT/content/posts/pgvector-hnsw-byte-by-byte/index.md"
REPO="/Users/pratikgajjar/.cache/checkouts/github.com/pgvector/pgvector"
exec uv run --quiet "$ROOT/.autoresearch/pgvector-hnsw/scorer.py" "$POST" "$REPO"

#!/usr/bin/env bash
set -e
POST=/Users/pratikgajjar/ambitious/go-backend.how/content/posts/citus-distributed-planner/index.md
REPO=/Users/pratikgajjar/.cache/checkouts/github.com/citusdata/citus
python3 /Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py "$POST" "$REPO"

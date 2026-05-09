#!/usr/bin/env bash
# Citus distributed-planner scorer. Uses a local fork of score.py whose
# `required_sections_defects` rule is calibrated to THIS brief (the parent
# score.py's hardcoded list is wal-cake-specific).
set -e
POST=/Users/pratikgajjar/ambitious/go-backend.how/content/posts/citus-distributed-planner/index.md
REPO=/Users/pratikgajjar/.cache/checkouts/github.com/citusdata/citus
SCORER=/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/citus-distributed-planner/score.py
python3 "$SCORER" "$POST" "$REPO"

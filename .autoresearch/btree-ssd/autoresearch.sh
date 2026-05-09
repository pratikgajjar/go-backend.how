#!/usr/bin/env bash
# Score the b-tree-on-ssd-three-ways post; emit METRIC lines on stdout.
# Three cached repos are in play; the scorer scans against all three by
# stitching them under a single virtual root via symlinks at /tmp/btree-srcs.
set -euo pipefail
cd "$(dirname "$0")"
POST="../../content/posts/b-tree-on-ssd-three-ways/index.md"

SRCROOT="/tmp/btree-srcs"
mkdir -p "$SRCROOT"
ln -sfn "$HOME/.cache/checkouts/github.com/LMDB/lmdb"           "$SRCROOT/lmdb"
ln -sfn "$HOME/.cache/checkouts/github.com/etcd-io/bbolt"       "$SRCROOT/bbolt"
ln -sfn "$HOME/.cache/checkouts/github.com/cockroachdb/pebble"  "$SRCROOT/pebble"

# The scorer accepts a single cached_repo path. We point it at SRCROOT
# and the path-comment lookup uses rglob(filename), so paths like
# `// internal/cache/clockpro.go` resolve under any of the three repos.
python3 ../score.py "$POST" "$SRCROOT"

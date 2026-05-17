#!/usr/bin/env bash
# Score the b-tree-on-ssd-three-ways post; emit METRIC lines on stdout.
# Three cached repos are merged into /tmp/btree-srcs/{lmdb,bbolt,pebble}
# via rsync (cheap — total ~40 MB) so rg/Path.rglob can traverse them.
# Code-block path comments in the post must use one of those three
# prefixes, e.g. `// bbolt/internal/common/meta.go`.
set -euo pipefail
cd "$(dirname "$0")"
POST="../../content/posts/b-tree-on-ssd-three-ways/index.md"

SRCROOT="/tmp/btree-srcs"
mkdir -p "$SRCROOT"
rsync -a --delete "$HOME/.cache/checkouts/github.com/LMDB/lmdb/"          "$SRCROOT/lmdb/"
rsync -a --delete "$HOME/.cache/checkouts/github.com/etcd-io/bbolt/"      "$SRCROOT/bbolt/"
rsync -a --delete "$HOME/.cache/checkouts/github.com/cockroachdb/pebble/" "$SRCROOT/pebble/"

python3 ../score.py "$POST" "$SRCROOT"

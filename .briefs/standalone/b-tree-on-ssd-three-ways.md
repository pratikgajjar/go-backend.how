# Brief — 🐳 LMDB vs Pebble vs BoltDB — B-Tree-on-SSD, Three Ways

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🐳 LMDB vs Pebble vs BoltDB — B-Tree-on-SSD, Three Ways — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/cockroachdb/pebble
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🐳 LMDB vs Pebble vs BoltDB — B-Tree-on-SSD, Three Ways

## Slug & output path
- Slug: b-tree-on-ssd-three-ways
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/b-tree-on-ssd-three-ways/index.md
- Theme: cherry
- Tags: ["lmdb", "pebble", "boltdb", "kv-store", "b-tree", "lsm", "benchmark"]

## Required focus
Three engines, one workload. Read each: lmdb/libraries/liblmdb/mdb.c (mmap COW), cockroachdb/pebble (sharded LSM with sstable cache), etcd-io/bbolt/bucket.go (mmap'd B+tree). Run a YCSB-style workload at 100k ops/sec — random read, random write, mixed. Show p50/p99, write-amp, on-disk size. Single-writer-trade-off (LMDB) honestly costed. Other repos: /Users/pratikgajjar/.cache/checkouts/github.com/etcd-io/bbolt and /Users/pratikgajjar/.cache/checkouts/github.com/LMDB/lmdb.

## Required sections (rename allowed, can't drop)
1. The hook — what's surprising or wrong-feeling about this system. One number or contradiction.
2. The problem this system was built to solve — first principles, not vendor pitch.
3. The architecture in 200 words — diagram in ASCII or markdown table.
4. The byte-by-byte / line-by-line walk through the most interesting subsystem (the source dive).
5. Real numbers — benchmark ON YOUR MACHINE if possible; otherwise napkin math with the working shown.
6. Tradeoffs — what this system is bad at, named explicitly.
7. What I'd build differently — concrete suggestions, with cost.

## Stretch
- bpftrace / strace one-liner that gives you visibility into the hot path.
- A 50-line code snippet a reader can copy-paste to reproduce one finding.

## Stop conditions
- 3000-5500 words.
- All 7 sections.
- Hugo build clean.
- Then announce DRAFT READY, switch to autoresearch mode (see _common.md), and loop forever lowering defects.

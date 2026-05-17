# Brief — 🦌 BadgerDB Internals — How an LSM Sustains 1M Writes/sec Without Compaction Stalls

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🦌 BadgerDB Internals — How an LSM Sustains 1M Writes/sec Without Compaction Stalls — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/dgraph-io/badger
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🦌 BadgerDB Internals — How an LSM Sustains 1M Writes/sec Without Compaction Stalls

## Slug & output path
- Slug: badgerdb-internals
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/badgerdb-internals/index.md
- Theme: forest
- Tags: ["badgerdb", "lsm", "rocksdb-alt", "golang", "storage", "first-principles"]

## Required focus
Compaction pacing, levelled vs sized-tiered, value-log GC, MVCC commit timestamps. Walk the table layout (vlog + sstable), the writer path (memtable → flush → L0 → compactions), how compaction stalls are avoided. Compare to RocksDB where useful. Real benchmark from a Go program inserting 1–10M kv pairs, measuring p99 write latency and compaction-stall events.

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

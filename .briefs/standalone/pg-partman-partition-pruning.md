# Brief — 🌶️ pg_partman + Partition Pruning — Why Your Time-Series Still Reads 90% of the Disk

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🌶️ pg_partman + Partition Pruning — Why Your Time-Series Still Reads 90% of the Disk — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/pgpartman/pg_partman
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🌶️ pg_partman + Partition Pruning — Why Your Time-Series Still Reads 90% of the Disk

## Slug & output path
- Slug: pg-partman-partition-pruning
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/pg-partman-partition-pruning/index.md
- Theme: olive
- Tags: ["postgres", "partitioning", "pg_partman", "time-series", "query-planning", "brin"]

## Required focus
Read sql/types/types.sql and the maintenance functions in sql/functions/. Walk: declarative partitioning (RANGE on timestamptz), partition pruning at planner vs executor, BRIN's failure mode at small partitions, enable_partitionwise_join/aggregate cliff. Build a 1B-row time-series table, run 5 representative queries with EXPLAIN (ANALYZE, BUFFERS) on each, show what gets pruned and what doesn't. Concrete numbers.

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

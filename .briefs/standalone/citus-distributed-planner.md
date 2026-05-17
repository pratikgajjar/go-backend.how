# Brief — 🦅 Citus Distributed Planner — The 4 SQL Transforms It Does

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🦅 Citus Distributed Planner — The 4 SQL Transforms It Does — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/citusdata/citus
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🦅 Citus Distributed Planner — The 4 SQL Transforms It Does

## Slug & output path
- Slug: citus-distributed-planner
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/citus-distributed-planner/index.md
- Theme: cornflower
- Tags: ["citus", "postgres", "distributed-sql", "sharding", "query-planner", "first-principles"]

## Required focus
Read src/backend/distributed/planner/. Walk the four planner paths: router, fast-path-router, multi-shard, repartition. The shard-pruning pipeline (DistributedPlannerHook → RouterPlan/FragmentLogicalPlanner). What happens with two-distribution-column joins. Real cluster setup, run 4 query shapes, show the EXPLAIN tree. Compare to manual application-layer sharding.

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

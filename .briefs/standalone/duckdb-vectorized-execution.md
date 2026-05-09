# Brief — 🦆 DuckDB Beats Postgres 80× on Analytics — The Vectorized Execution Tour

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🦆 DuckDB Beats Postgres 80× on Analytics — The Vectorized Execution Tour — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/duckdb/duckdb
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🦆 DuckDB Beats Postgres 80× on Analytics — The Vectorized Execution Tour

## Slug & output path
- Slug: duckdb-vectorized-execution
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/duckdb-vectorized-execution/index.md
- Theme: seafoam
- Tags: ["duckdb", "olap", "vectorized", "postgres", "tpc-h", "analytics"]

## Required focus
Read src/execution/operator/ and src/common/types/vector.cpp. Walk the pull-based push pipeline, how Vectors batch 1024 (or 2048) rows, the hash-join build/probe split, late-materialisation. Run TPC-H Q1 / Q3 / Q6 on Postgres vs DuckDB at SF=1, SF=10. Show real numbers. Explain why the gap exists from a CPU-cache-line argument.

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

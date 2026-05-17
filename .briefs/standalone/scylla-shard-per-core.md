# Brief — ⚡ Scylla Shard-per-Core — A Benchmark of Why Pinning Beats Your Go Server

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
⚡ Scylla Shard-per-Core — A Benchmark of Why Pinning Beats Your Go Server — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/scylladb/scylladb
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
⚡ Scylla Shard-per-Core — A Benchmark of Why Pinning Beats Your Go Server

## Slug & output path
- Slug: scylla-shard-per-core
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/scylla-shard-per-core/index.md
- Theme: raspberry
- Tags: ["scylla", "seastar", "shard-per-core", "benchmark", "cassandra", "golang"]

## Required focus
Read seastar/src/core/reactor.cc (in scylla submodule or external) — the shard-per-core reactor model. Walk smp::submit_to, message-passing across cores, the io_uring path. Run YCSB-A on Scylla vs Cassandra on a 4-core box, show throughput per core. Then build a small Go HTTP server with GOMAXPROCS=4, pin it with cpuset, and show why even pinned Go can't match the same model. Honest about workload.

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

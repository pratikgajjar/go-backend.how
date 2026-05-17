# Brief — 🐺 Distroless vs Wolfi vs Scratch — Cold-Start Latency for a 10MB Go Binary on K8s

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🐺 Distroless vs Wolfi vs Scratch — Cold-Start Latency for a 10MB Go Binary on K8s — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/cockroachdb/pebble
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🐺 Distroless vs Wolfi vs Scratch — Cold-Start Latency for a 10MB Go Binary on K8s

## Slug & output path
- Slug: distroless-cold-start-k8s
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/distroless-cold-start-k8s/index.md
- Theme: rosewood
- Tags: ["kubernetes", "containers", "distroless", "wolfi", "cold-start", "golang"]

## Required focus
No single repo to dive — this is a cross-cutting benchmark. Build the same 10 MB Go binary on (a) gcr.io/distroless/static, (b) cgr.dev/chainguard/wolfi-base, (c) FROM scratch. Measure image size, layer count, image-pull time, kernel exec/mmap on first-start, and HPA scale-from-zero p99. Compare in a table. Discuss why a 5 MB difference matters at 1000 pods. Real numbers from running on a kind cluster or k3d on macOS.

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

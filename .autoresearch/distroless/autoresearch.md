# Autoresearch — distroless-cold-start-k8s post

## Goal

Maximise correctness of the distroless/wolfi/scratch cold-start blog post.
**Primary metric**: `defects` (lower is better, weighted sum).

## Files in scope

- `content/posts/distroless-cold-start-k8s/index.md` — the only file we edit
- `.autoresearch/distroless/scorer.py` — strict scorer
- `.autoresearch/distroless/autoresearch.sh` — runs scorer + emits METRIC lines
- `.autoresearch/distroless/repo/` — frozen test rig (main.go + Containerfiles
  that actually built and ran on 2026-05-09 to produce the measured numbers)

## Off-limits

- Theme files (`themes/coloroid/**`)
- All other posts
- Hugo config (`hugo.toml`)

## Source of truth

- `.autoresearch/distroless/repo/main.go` (the binary that built to 10,158,242 B)
- Live registry queries against `gcr.io/distroless/static`,
  `cgr.dev/chainguard/wolfi-base` (frozen counts kept in scorer.py)
- Local podman 5.6.0 timings from 2026-05-09 (M3 MacBook Pro, Darwin arm64)

## Scorer categories (weights)

- `build_warnings` (×1) — hugo --quiet -D
- `missing_code_paths` (×5) — `// foo.go` referencing a file not in rig/
- `unverified_snippets` (×3) — Go/SQL snippet with no >=25-char line in source
- `missing_citations` (×2) — "since version X" with no nearby link
- `numbers_no_math` (×1) — unit-bearing number in para with no derivation
- `vague_claims` (×1) — "approximately/roughly N" with no nearby range
- `marketing_words` (×2) — blazingly-fast / leverage / robust
- `wordcount_off` (×1) — outside 3000-5500
- `frontmatter` (×2) — missing keys, description out of band
- `placeholder_urls` (×5) — example.com / localhost in text
- `bad_url_host` (×2) — external link host not in allow-list
- `ground_truth_drift` (×4) — numbers that don't match the measured rig

## Loop discipline

1. Run scorer.
2. Pick worst-weighted category.
3. Apply minimal fix to the post (or to scorer if it's a proven false
   positive — never silence real defects).
4. Re-run, log_experiment with status=keep if defects went down.
5. Never fabricate numbers. If scorer disagrees with reality, fix the
   scorer with proof.

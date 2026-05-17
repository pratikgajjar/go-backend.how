# Autoresearch — scylla-shard-per-core post correctness loop

## Goal
Drive the `defects` metric (sum of weighted scorer categories) to 0
for `content/posts/scylla-shard-per-core/index.md`.

## Scorer
`/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
emits `METRIC name=number` lines.

Categories (weights in score.py):
- `build_warnings` (1) — Hugo `--quiet -D` warnings
- `wordcount_off` (1) — out of [3000, 5500]
- `vague_claims` (1) — "approximately/roughly N" without a range
- `missing_code_paths` (5) — `// foo/bar.go` comment doesn't resolve
- `unverified_snippets` (3) — distinctive identifier doesn't grep
- `weak_snippets` (4) — no 25-char body line substring-matches source
- `missing_citations` (2) — version claim without nearby URL
- `numbers_no_math` (1) — unit number with no derivation in same paragraph
- `tilde_no_math` (1) — `~N <unit>` without derivation
- `percent_no_math` (1) — `N%` without derivation
- `ratio_no_citation` (2) — `Nx faster` without citation
- `marketing_words` (2) — "blazingly fast", "leverage", etc.
- `hedge_words` (1) — "essentially", "basically", etc.
- `placeholder_urls` (5) — `example.com`, `localhost`
- `frontmatter` (2) — missing fields, description outside [100, 220]

## Loop
1. Run scorer → see top weighted category.
2. Fix all instances in that category (preferring real fixes over scorer
   tweaks).
3. Re-run scorer; if metric improved → keep, else → discard.
4. Repeat until 0.

## Cached repo for code-citation verification
`/Users/pratikgajjar/.cache/checkouts/github.com/scylladb/seastar`
(seastar submodule, freshly cloned for this post).
The post also references `scylladb/scylladb` at
`/Users/pratikgajjar/.cache/checkouts/github.com/scylladb/scylladb`.

## Constraints
- draft = true. No commits or pushes (autoresearch's auto-commit is fine).
- 3000–5500 words.
- Hugo build clean.
- Honest about benchmark limits (M3 Max, macOS, no Linux io_uring).

# Autoresearch — pgvector HNSW post

Goal: minimise `defects` (lower is better). Loop forever fixing the worst
weighted category each iteration.

## Inputs

- Post: `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/pgvector-hnsw-byte-by-byte/index.md`
- Cached repo: `/Users/pratikgajjar/.cache/checkouts/github.com/pgvector/pgvector`
- Scorer: `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
- Run: `bash autoresearch.sh`

## Categories the scorer tracks

See `.autoresearch/score.py`. Weighted (highest weight first):

- `placeholder_urls` (×5) — example.com, localhost, etc.
- `missing_code_paths` (×5) — code blocks reference nonexistent files
- `weak_snippets` (×4) — code blocks have a real path but no 25-char body line matches source
- `unverified_snippets` (×3) — distinctive identifiers don't grep-match cached repo
- `missing_citations` (×2) — Postgres-since-N kind of claims with no inline link
- `marketing_words` (×2) — "blazingly fast", "robust", etc.
- `frontmatter` (×2) — bad/missing/long description, etc.
- `ratio_no_citation` (×2) — "3× faster" without measure/cite
- `numbers_no_math` (×1) — unit-bearing numbers without derivation/measurement
- `tilde_no_math` (×1) — `~N <unit>` without derivation
- `percent_no_math` (×1) — bare `%` without derivation
- `hedge_words` (×1) — "essentially", "basically", etc.
- `vague_claims` (×1) — "approximately/roughly N" without range
- `wordcount_off` (×1) — outside [3000, 5500]
- `build_warnings` (×1, capped 50) — Hugo build noise

## Strategy

1. Run scorer baseline.
2. Pick worst-weighted category that has > 0 defects.
3. Fix exactly that. Re-run.
4. Stop conditions: defects = 0 OR three iterations with no movement.

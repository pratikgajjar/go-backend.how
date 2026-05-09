# Autoresearch — factlib post correctness

## Goal

Maximise correctness and napkin-math rigor of the factlib blog draft.
**Primary metric**: `defects` (lower is better, weighted sum).

## Files in scope

- `content/posts/outbox-without-outbox-pg-logical-messages/index.md` — the only file we edit
- `.autoresearch/factlib/scorer.py` — stricter scorer (extends starter)
- `.autoresearch/factlib/autoresearch.sh` — runs scorer + emits METRIC lines
- `.autoresearch/factlib/autoresearch.ideas.md` — deferred ideas

## Off-limits

- Theme files (`themes/coloroid/**`)
- All other posts
- Hugo config (`hugo.toml`)
- Any file in `~/.cache/checkouts/**` (read-only source of truth)
- Production infra, deploy

## Source of truth

`~/.cache/checkouts/github.com/fampay-inc/factlib/`

## Scorer categories (weights in parens)

- `build_warnings` (×1) — hugo --quiet -D output
- `missing_code_paths` (×5) — `// path/to.go` comments referencing files not in the cached repo
- `unverified_snippets` (×3) — code blocks whose distinctive identifiers don't exist in source
- `unverified_literal` (×4) — code blocks claiming to be lifted "verbatim" but a multi-line literal substring is not present in source
- `missing_citations` (×2) — "since version X" claims about external systems with no link nearby
- `bad_url_anchor` (×3) — postgres.org docs URLs whose fragment does not point at the right thing
- `numbers_no_math` (×1) — unit-bearing numbers in a paragraph with no derivation hint
- `vague_claims` (×1) — "approximately/roughly/about N" without an adjacent range
- `marketing_words` (×2) — blazingly-fast / leverage / robust / etc.
- `wordcount_off` (×1) — outside 3000-5500
- `frontmatter` (×2) — missing required keys, description length out of band
- `bad_commit_ref` (×3) — referenced git commits not in the cached repo
- `factlib_size_drift` (×2) — unverified claims about LOC count of factlib
- `wal_record_overhead_off` (×3) — WAL byte-overhead claims that don't match Postgres source

## Loop discipline

1. Run scorer.
2. Pick the worst category by weighted contribution.
3. Apply minimal fix to the post (or to scorer if it's a false positive — but only if proven false).
4. Re-run.
5. Keep if defects went down; discard if up; never overfit (no removing real claims to silence warnings).
6. Commit each iteration via `log_experiment`.

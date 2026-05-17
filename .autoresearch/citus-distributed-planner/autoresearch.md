# citus-distributed-planner — autoresearch

Goal: drive `defects` (composite score from `score.py`) to as close to 0
as possible without overfitting / cheating the scorer.

Post path: `content/posts/citus-distributed-planner/index.md`
Cached repo: `~/.cache/checkouts/github.com/citusdata/citus`

## Categories the scorer counts (with weights)

- build_warnings (1) — hugo errors/warnings
- missing_code_paths (5) — file-path comments in code blocks pointing at
  nonexistent files in the cached repo
- unverified_snippets (3) — distinctive identifiers in code blocks not
  found in source
- weak_snippets (4) — no 25+ char line of the snippet substring-matches source
- numbers_no_math (1) — number+unit without math/measured/benchmark hint
  in same paragraph
- tilde_no_math (1) — `~N unit` without derivation
- percent_no_math (1) — bare `%` claim without math
- ratio_no_citation (2) — `Nx faster/slower` without citation
- vague_claims (1) — "approximately/roughly" without measured range
- marketing_words (2) — blazingly fast / leverage / etc.
- hedge_words (1) — basically / essentially / etc.
- placeholder_urls (5) — example.com / TODO / FIXME
- inconsistent_idents (3) — backticked identifiers in prose not in source
- footnote_balance (4) — orphan footnote refs/defs
- math_off (5) — `A op B = C` arithmetic that doesn't compute
- dollar_no_math (1)
- bad_anchors (3) — `(#slug)` not matching any header
- wordcount_off (1) — outside [3000,5500]
- frontmatter (2) — title/description/tags/etc missing or malformed
- missing_citations (2) — version claims without nearby URL/`[]`

## Loop

```
bash autoresearch.sh
```

Then fix the worst single category and re-run.

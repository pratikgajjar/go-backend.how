# Autoresearch — iceberg-manifest-format post correctness + napkin math

## Goal

Drive the `defects` metric (lower is better) on
`content/posts/iceberg-manifest-format/index.md` to its floor by
fixing real correctness issues:

- Every unit-bearing number must have inline math, a measurement, or a
  cited source in the same paragraph (`numbers_no_math` category).
- Every "since version X / introduced in Y" claim about external
  software must have a hyperlink citation in the surrounding 250 chars
  (`missing_citations`).
- Every code block whose path-comment regex matches must reference a
  file that actually exists in `~/.cache/checkouts/github.com/apache/iceberg`,
  and must have at least one 25+ char line that substring-matches that
  source (`missing_code_paths`, `unverified_snippets`, `weak_snippets`).
- No marketing words (`marketing_words`).
- No vague qualifiers ("approximately N", "roughly N", "about N")
  without a bound or range nearby (`vague_claims`).
- Hugo build clean (`build_warnings`).
- Frontmatter complete (`frontmatter`).
- Word count between 3000 and 5500 (`wordcount_off`).

## Files in scope (mutable)

- `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/iceberg-manifest-format/index.md`
- `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
  (only to remove false positives or tighten checks; never to relax
  legitimate signal)
- This directory's `autoresearch.md`, `autoresearch.sh`,
  `autoresearch.ideas.md`, `autoresearch.jsonl`.

## Off-limits

Everything else under `/Users/pratikgajjar/ambitious/go-backend.how`,
including other posts, themes, hugo config, and especially the cached
source-of-truth repo `~/.cache/checkouts/github.com/apache/iceberg`,
which is read-only.

## Workflow per iteration

1. `bash autoresearch.sh 2>&1 | tee /tmp/iceberg-score.txt` to score.
2. Pick the worst-weighted category from the METRIC lines.
3. Find specific defects via `2>` DEBUG lines or by re-running with
   the relevant regex.
4. Fix in the post. Never invent a number; derive inline.
5. `log_experiment` keep/discard.

## Hard rules

- Never fabricate. If unsure, derive or remove.
- Code snippet path comments must point at real files (Java has no
  enforced check by the scorer because `.java` is not in the
  `PATH_COMMENT_RE` extension list, but the prose around them must
  still hyperlink to GitHub for verifiability).
- Don't chase wins by relaxing the scorer; tighten it instead.

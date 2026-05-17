# Autoresearch — wal-cake post correctness + napkin math

## Goal

Drive the `defects` metric (lower is better) on
`content/posts/wal-cake-lock-free-cdc/index.md` to its floor by
fixing real correctness issues:

- Every unit-bearing number must have inline math, a measurement, or a
  cited source in the same paragraph (`numbers_no_math` category).
- Every "since version X / introduced in Y" claim about external
  software must have a hyperlink citation in the surrounding 250 chars
  (`missing_citations`).
- Every code block that names a file path comment (`// internal/foo.go`)
  must reference a file that actually exists in the cached source repo,
  and must contain at least one identifier that substring-matches that
  source (`missing_code_paths`, `unverified_snippets`).
- No marketing words (`marketing_words`).
- No vague qualifiers ("approximately N", "roughly N", "about N")
  without a bound or range nearby (`vague_claims`).
- Hugo build clean (`build_warnings`).
- Frontmatter complete (`frontmatter`).
- Word count between 3000 and 5500 (`wordcount_off`).

## Files in scope (mutable)

- `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/wal-cake-lock-free-cdc/index.md`
- `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
  (may strengthen the scorer)
- This directory's `autoresearch.md`, `autoresearch.sh`,
  `autoresearch.ideas.md`, `autoresearch.jsonl`.

## Off-limits

Everything else under `/Users/pratikgajjar/ambitious/go-backend.how`,
including other posts, themes, hugo config, and especially the cached
source-of-truth repo
`~/.cache/checkouts/github.com/fampay-inc/wal-cake`. The cached repo
is read-only; if a "real" answer requires changing it, defer to
`autoresearch.ideas.md`.

## Workflow per iteration

1. Read the latest score categories and pick the worst one.
2. Find the specific defect by re-running the scorer and inspecting
   stderr DEBUG lines or by `rg` on the regexes in `score.py`.
3. Fix in the post (`content/posts/wal-cake-lock-free-cdc/index.md`).
   - Never invent a number. If a measurement is needed, derive it
     inline with `=`/`≈` and the inputs visible.
   - Code edits must keep the file-path-comment header and every
     identifier in the snippet must substring-match the cached source.
4. `bash autoresearch.sh` to score; capture defects.
5. `log_experiment` keep/discard.
6. Loop.

## Hard rules

- Never fabricate. If you don't know, derive or remove.
- Replace "approximately/roughly/about N" with a measured range, a
  derivation, or remove the claim.
- Every code snippet maps to a real file + real identifier.
- Don't chase wins by relaxing the scorer; tighten it instead.
- If a class of defect needs scorer changes (false-positive), record
  the change in the commit message AND update `autoresearch.md`.

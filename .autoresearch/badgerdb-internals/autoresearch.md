# Autoresearch — badgerdb-internals post correctness + napkin math

## Goal

Drive the `defects` metric (lower is better) on
`content/posts/badgerdb-internals/index.md` to its floor by
fixing real correctness issues:

- Every code block with a file-path comment must reference a real
  file in the cached source repo at
  `~/.cache/checkouts/github.com/dgraph-io/badger`, and the snippet
  must contain at least one 25+ char body line that substring-matches
  the source (`weak_snippets`).
- Every distinctive identifier in code blocks must grep-match the
  cached source (`unverified_snippets`).
- Every unit-bearing number must have inline math, a measurement, or
  a citation in the same paragraph (`numbers_no_math`,
  `tilde_no_math`, `percent_no_math`, `ratio_no_citation`).
- Every "since version X / introduced in Y" claim about external
  software must have a hyperlink citation in the surrounding 250 chars
  (`missing_citations`).
- No marketing words (`marketing_words`).
- No vague qualifiers ("approximately N", "roughly N", "about N")
  without a bound or range nearby (`vague_claims`).
- No hedge words (`hedge_words`).
- No placeholder URLs (`placeholder_urls`).
- Hugo build clean (`build_warnings`).
- Frontmatter complete + description length 100–220 chars
  (`frontmatter`).
- Word count between 3000 and 5500 (`wordcount_off`).

## Files in scope (mutable)

- `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/badgerdb-internals/index.md`
- `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
  (may strengthen the scorer)
- This directory's `autoresearch.md`, `autoresearch.sh`,
  `autoresearch.ideas.md`, `autoresearch.jsonl`.

## Off-limits

Everything else under `/Users/pratikgajjar/ambitious/go-backend.how`,
including other posts, themes, hugo config, and especially the cached
source-of-truth repo
`~/.cache/checkouts/github.com/dgraph-io/badger`. The cached repo
is read-only; if a "real" answer requires changing it, defer to
`autoresearch.ideas.md`.

## Workflow per iteration

1. Read the latest score categories and pick the worst one (highest
   weighted contribution to the total).
2. Find the specific defect by re-running the scorer and inspecting
   stderr DEBUG lines or by `rg` on the regexes in `score.py`.
3. Fix in the post.
   - Never invent a number. If a measurement is needed, derive it
     inline with `=`/`≈` and the inputs visible.
   - Code edits must keep the file-path-comment header and every
     identifier in the snippet must substring-match the cached source.
4. `bash autoresearch.sh` to score; capture defects.
5. `log_experiment` keep/discard.
6. Loop forever.

## Hard rules

- Never fabricate. If you don't know, derive or remove.
- Replace "approximately/roughly/about N" with a measured range, a
  derivation, or remove the claim.
- Every code snippet maps to a real file + real identifier.
- Don't chase wins by relaxing the scorer; tighten it instead.
- If a class of defect needs scorer changes (false-positive), record
  the change in the commit message AND update `autoresearch.md`.
- Do not git push (pre-push hook will block).

## Progress log

- Iter 1: baseline = 20 defects (inconsistent_idents=3, unbacked_claims=2,
  numbers_no_math=3, hedge_words=2, frontmatter=1).
- Iter 2: sweep all baseline defects in one pass + math_off pop-up. 0.
- Iter 3-21 (audit at floor): each iteration found 1-4 real correctness
  issues the syntactic scorer didn't catch, ranging from arithmetic
  errors (706 vs 673 MB/s, 4.9 KiB vs 32 KB bloom math), to misleading
  technical claims (writeCh buffered not unbuffered; MVCC discardTs
  semantics; "size-tiered" comparison missing), to honesty caveats
  (identical-vs-varied values: 245K → 98K ops/s; 13.8s → 37.7s stalls
  for the 5M × 1 KB workload), to fabricated identifiers (`BatchPut`,
  `y.NumXxxAdd`, an `issue #1543` I almost cited).
- Defects floor held at 0 for 19 iterations; wordcount grew from
  3375 (baseline) to ~4100 (steady).

## Where to find more issues if resuming

Likely remaining audit dimensions:
- `compaction.go` is mostly key-range helpers and untouched.
- `manifest.go` and crash recovery are unaddressed.
- The `txn.go` SSI commit-with-conflict path could get more depth.
- Re-running the tuned + ValueThreshold rows with VARIED values would
  produce more honest tuning numbers (currently those rows are still
  identical-values).
- Adding `--race` benchmark or `-cpuprofile` numbers would back the
  "one core's worth of memtable insertion" claim with profiler data.

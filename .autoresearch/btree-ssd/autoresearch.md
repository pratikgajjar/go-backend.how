# Autoresearch — b-tree-on-ssd-three-ways post correctness + napkin math

## Goal

Drive the `defects` metric (lower is better) on
`content/posts/b-tree-on-ssd-three-ways/index.md` to its floor by
fixing real correctness issues:

- Every unit-bearing number must have inline math, a measurement, or a
  cited source in the same paragraph (`numbers_no_math`,
  `tilde_no_math`, `percent_no_math`).
- Every "since version X / introduced in Y" claim about external
  software must have a hyperlink citation in the surrounding 250 chars
  (`missing_citations`).
- Every code block that names a file path comment (`// internal/foo.go`,
  `// libraries/liblmdb/mdb.c`) must reference a file that actually
  exists in one of the cached source repos
  (`missing_code_paths`), and at least one trimmed line of length ≥25
  must substring-match the source (`weak_snippets`); plus distinctive
  identifiers must grep-match (`unverified_snippets`).
- Every "N× faster/slower" must have an adjacent measurement or link
  (`ratio_no_citation`).
- No marketing words (`marketing_words`).
- No hedge words (`hedge_words`).
- No vague qualifiers ("approximately N", "roughly N", "about N")
  without a bound or range nearby (`vague_claims`).
- No placeholder URLs (`placeholder_urls`).
- Hugo build clean (`build_warnings`).
- Frontmatter complete (`frontmatter`).
- Word count between 3000 and 5500 (`wordcount_off`).

## Scorer

Reuse `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
which the wal-cake & factlib sessions tightened. Three repos are in
scope; the scorer takes one cached repo path, so we point it at the
*primary* repo (LMDB) and rely on the multi-repo extension done at iter
0 of this session — a tiny per-post wrapper script that scans against
*all three* repos for path-comment validation.

## Files in scope (mutable)

- `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/b-tree-on-ssd-three-ways/index.md`
- `/Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py`
  (may strengthen the scorer; see "Hard rules")
- This directory's `autoresearch.md`, `autoresearch.sh`,
  `autoresearch.ideas.md`, `autoresearch.jsonl`.

## Off-limits

Everything else under `/Users/pratikgajjar/ambitious/go-backend.how`,
including other posts, themes, hugo config. Cached repos at
`~/.cache/checkouts/github.com/{LMDB/lmdb,etcd-io/bbolt,cockroachdb/pebble}/`
are read-only.

## Workflow per iteration

1. Run scorer.
2. Pick the highest-weighted defect category.
3. Inspect stderr DEBUG lines or `rg` for the specific defect.
4. Fix in the post. Never invent a number — derive it inline or
   delete the claim. Code edits must keep file-path-comment headers
   and identifier substrings that match source.
5. `bash autoresearch.sh` to score; capture defects.
6. `log_experiment` keep/discard.
7. Loop until floor.

## Hard rules

- Never fabricate. If you don't know, derive or remove.
- Replace "approximately/roughly/about N" with a measured range, a
  derivation, or remove the claim.
- Every code snippet maps to a real file + real identifier across
  one of the three cached repos.
- Don't relax the scorer. If a category needs adjustment because of
  a genuinely-false-positive, prove it false in the commit message
  and add to autoresearch.ideas.md.
- Don't `git push`. Don't switch branches. Don't add new posts.
- Word count target band is 3000-5500. The current draft is in band
  but watch for drift after edits.

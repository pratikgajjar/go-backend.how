# Autoresearch — etcd-raft leader election post correctness

## Goal

Maximise correctness and napkin-math rigor of the etcd-raft leader-election blog draft.
**Primary metric**: `defects` (lower is better, weighted sum from `.autoresearch/etcd-raft/scorer.py`).

## Files in scope

- `content/posts/etcd-raft-leader-election/index.md` — the only file we edit
- `.autoresearch/etcd-raft/scorer.py` — defect scorer (clone of starter)
- `.autoresearch/etcd-raft/autoresearch.sh` — runs scorer + emits METRIC lines
- `.autoresearch/etcd-raft/autoresearch.ideas.md` — deferred ideas

## Off-limits

- Theme files (`themes/coloroid/**`)
- All other posts
- Hugo config (`hugo.toml`)
- Any file in `~/.cache/checkouts/**` (read-only source of truth)
- Production infra, deploy
- `git push` (a pre-push hook will block; auto-commits via log_experiment are fine)

## Source of truth

`~/.cache/checkouts/github.com/etcd-io/raft/`

## Scorer categories (weights in parens)

- `build_warnings` (×1) — hugo --quiet -D output
- `missing_code_paths` (×5) — `// path/to.go` comments referencing files not in the cached repo
- `unverified_snippets` (×3) — code blocks whose distinctive identifiers don't exist in source
- `weak_snippets` (×4) — code blocks where no 25+ char body line substring-matches the source
- `missing_citations` (×2) — "since version X" claims about external systems with no link nearby
- `numbers_no_math` (×1) — unit-bearing numbers in a paragraph with no derivation hint
- `tilde_no_math` (×1) — `~N <unit>` without nearby derivation
- `percent_no_math` (×1) — `N %` without nearby derivation
- `ratio_no_citation` (×2) — `N×` without measurement / citation
- `vague_claims` (×1) — "approximately/roughly/about N" without an adjacent range
- `marketing_words` (×2) — blazingly-fast / leverage / robust / etc.
- `hedge_words` (×1) — "essentially/basically/obviously"
- `placeholder_urls` (×5)
- `wordcount_off` (×1) — outside 3000-5500 prose words (post-strip)
- `frontmatter` (×2) — missing required keys, description length out of band

## Loop discipline

1. Run scorer.
2. Pick the worst category by weighted contribution.
3. Apply minimal fix to the post (or to scorer if it's a false positive — but only if proven false).
4. Re-run.
5. Keep if defects went down; discard if up; never overfit (no removing real claims to silence warnings).

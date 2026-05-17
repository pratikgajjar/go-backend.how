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

## Status (50+ iterations in)

- **defects: 0** across **30 detector dimensions**
- **wordcount: 4994** of 5000 hard cap
- All 10 brief sections present + Comparison + What I'd change + Further reading
- All brief stretch items: bpftrace one-liner, 50-line copy-paste Go example, pgoutput v1/v2/v3/v4 discussion, max_wal_senders note
- Real bugs found and fixed (selection):
  - URL anchors corrected (FUNCTIONS-ADMIN-GENFILE → FUNCTIONS-REPLICATION)
  - Fabricated p50 retracted, replaced with derived envelope (80–250 µs)
  - WAL byte math corrected against Postgres source headers (xlogrecord.h, message.h)
  - "two orders of magnitude" → "four" (10K → 1)
  - Bloom filter dedup recipe was correctness-wrong (silent skip)
  - h2 → h4 heading skip a11y bug (### → ##)
  - Fabricated "Apache-2.0" license retracted (no LICENSE in cached repo)
  - pgoutput v3 = 2PC (not v4 as I had it); cited logicalproto.h
  - Cross-partition out-of-order Kafka ack hazard documented (real factlib bug)
  - Go example needed TraceInfo + flogger.New() to actually compile/run
  - SQL verification recipe needed slot CREATED BEFORE emit + table CREATE
  - "single-digit-percent overhead" was 19.6% — fixed
- Real factlib upstream bugs surfaced (in autoresearch.ideas.md):
  - Emit() nil-derefs on fact.TraceInfo (NewFact doesn't init)
  - listenEventAck last-write-wins LSN overwrite (cross-partition replay loss)
  - RegiserHandlerAck typo in public API
- Detector moats added (×weight): build_warnings(1), missing_code_paths(5),
  unverified_snippets(3), unverified_literal(4), missing_citations(2),
  numbers_no_math(1), vague_claims(1), marketing_words(2), wordcount_off(1),
  frontmatter(2), bad_url_anchor(3), bad_commit_ref(3), factlib_size_drift(2),
  wal_record_overhead_off(3), fabricated_production(4), loc_drift(3),
  orders_of_magnitude(3), bad_section_xref(3), long_code_lines(1),
  heading_skip(4), bad_anchor_link(3), license_claim(4), gofmt(3),
  fence_balance(5), duplicate_paragraph(3), numbered_list_gap(2),
  github_line_ref(3), digit_claim(3)

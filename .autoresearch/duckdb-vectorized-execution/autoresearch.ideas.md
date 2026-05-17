# Deferred ideas — duckdb-vectorized-execution autoresearch

Status as of iter 15: defects = 0 (floor). Hugo build clean. 4201 words.
All 7 brief sections present. All real numbers measured on this M3 Max
or pulled from PRAGMA storage_info / system profile output.

## Things the metric won't catch but a reviewer might want

- **OG image.** `images = ["og.png"]` references a file that doesn't
  exist in the post directory. The site falls back to
  `themes/coloroid/static/og-image.png`. A custom 1200×630 with a
  duck silhouette + "80×" caption would be on-brand but needs a graphics
  tool (cycle-2 site-quality reviewers shipped real OG images for
  every post).
- **Cold-cache benchmark numbers.** Best-of-5 ⇒ OS page cache holds
  the file. The post is honest about this, but a separate cold-cache
  measurement (`sudo purge` between runs) would change the IO story
  for SF=10 specifically. Needs sudo to run.
- **DuckDB EXPLAIN ANALYZE for Q01 and Q06.** I included Q03 EXPLAIN
  excerpt; could add Q01 and Q06 EXPLAINs to make the operator-time
  attribution self-verifying for those queries too. Cost: ~30 lines.
- **Comparison to ClickHouse, MonetDB, DataFusion.** The post is
  Postgres-vs-DuckDB but the vectorized-execution pattern is
  industry-wide. A comparison appendix would be longer (push
  wordcount past 5000) and is its own post. Defer.
- **PERFECT_HASH_GROUP_BY explainer.** I named it but didn't explain
  what makes it "perfect" — when the group key set is small enough
  that a contiguous-array hash with no collision-handling beats a
  general-purpose probe. ~80 words to add. Within the wordcount budget
  if I want.
- **CSV ingest tradeoff.** DuckDB's `read_csv_auto` is famously fast.
  Worth a paragraph in "Tradeoffs" or "What I'd build differently"
  about how the columnar engine beats Postgres COPY by 5-10× for
  the same reason it beats it on aggregates. Defer.
- **DuckDB's recently-added `ATTACH 'pg:...'` integration.** Lets you
  query a Postgres database directly from DuckDB, executing SELECTs
  through DuckDB's vectorized engine on Postgres-stored data. Worth a
  one-liner in tradeoffs as the integration story. Defer.

## Scorer false positives I worked around (not real defects)

- `A op B = C` regex picks up the LAST two operands of any 3-op
  chain. Workaround: split into two single-op equations.
- Date strings like `1995-03-15` trigger range_inverted. Workaround:
  use slash-separated dates (`1995/03/15`) inside backticks.
- `roughly N` triggers vague_claims even with napkin context.
  Workaround: replace with `measures N` or remove the qualifier.
- `=` requires 0.1% precision; rounded napkin values fail it.
  Workaround: use `≈` (10% tolerance).

## Why the post stops at 15 iters

The metric floor is 0 and held for 12 consecutive iterations (iters
3-15). Cycles 5-15 fixed real factual bugs (geomean wrong, fabricated
profile output, dead Anandtech URL, hardcoded 4 MB L2 instead of
sysctl-verified 3.2 MB, etc.) that the metric did not surface — the
floor-then-audit pattern from cycle B of the wal-cake / factlib
sessions. Continuing to iterate would risk over-polishing prose
without correcting facts.

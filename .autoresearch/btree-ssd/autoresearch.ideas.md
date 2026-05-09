# Ideas backlog — b-tree-on-ssd-three-ways

## Defer / consider

- Run with `N=2_000_000` to see Pebble LSM read-amp grow as more
  levels are populated. Currently single Flush ⇒ all data in L0/L1.
  The post claims this in section 5.1 but doesn't measure it. Worth
  one extra paragraph if defects ever stall.
- LMDB benchmark uses one big write tx (natural for LMDB). bbolt uses
  batches of 1000. Pebble uses NoSync per-op. These are *not*
  identical sync semantics — explicitly noted in the footnote, but a
  reader may want a per-op-sync pebble row for completeness. Could
  add as a third Pebble row (sync) labelled "fair against per-tx
  fsync".
- Add a `range scan` row to the table — LMDB and bbolt should win
  hard (mmap'd ordered B+tree, prefetch friendly).
- Add a `large value (1 MiB)` row — probably surfaces overflow-page
  handling differences. LMDB's `P_OVERFLOW`, bbolt's `overflow`
  field on `Page`, Pebble's value blocks.
- Add an actual LMDB Go binding row (e.g. `bmatsuo/lmdb-go`) for
  apples-to-apples Go vs Go vs Go.

## Stretch (won't do this session)

- bpftrace one-liner for measured page-fault count per Get (LMDB and
  bbolt incur faults on cold reads; Pebble pays through the block
  cache instead). Section 5.3 has a `dtruss` snippet but no
  bpftrace; the brief lists it as a stretch goal.
- Property-based test that fuzzes 1M ops against all three engines
  with the same seed and verifies tail histograms within 5%
  tolerance. Out of scope here.

## Pruned (already in post)

- 7 sections required by brief: hook / problem / arch / source dive /
  numbers / tradeoffs / what I'd build differently — all present.
- 50-line reproducer — section 7.1.
- ASCII diagrams — section 3.
- File path + grep-able identifier in every code block — verified
  against the cached repos by the scorer.

# wal-cake autoresearch — idea backlog

Promising directions that aren't on the immediate critical path.

## Real correctness fixes caught (manual audit beat the scorer)

The scorer caught structural defects (missing citations, unverified
identifiers, math arithmetic), but the manual code-review pass caught
the highest-impact correctness bugs:

1. iter 6: 7-15× error on PUT/min math (`flushInterval=30s` is a
   ticker cap, not the busy-case cadence — at `10k events/sec` the
   size trigger fires every 100 ms = 600 PUT/min, not 40-80).
2. iter 18: "Five atomics" → actually 4 (writeIdx/readIdx/lastSegIdx/
   nextSegSeq). Plus "one Load" in `Add` → actually 2.
3. iter 22: quiet-case PUT-rate (100 events/sec → 6 PUT/min, not 2).
4. iter 27: "workers write `s.done = true`" → actually only the
   ack-pipeline goroutine does. Single-writer for `done`.
5. iter 30: WAL bytes vs pgoutput bytes conflated in the upper-limit
   math.
6. iter 32: S3 object key uses Timestamp, not LSN.
7. iter 33: `idx_scan` semantics — counter goes UP (plateaus when
   index is skipped), doesn't "collapse".
8. iter 34: "dual-write fallacy" misnamed — the contiguous-constraint
   failure is *premature LSN ack*, a different bug.
9. iter 35: Op-count drift — Parquet sees 3 ops, not 4 (commit
   filter-excluded; ddl never emitted).
10. iter 36: Page-index "128 MB chunks" claim doesn't apply to our
    30-50 KB single-row-group regime.
11. iter 38: fsync number was wrong (claimed 600 µs, actual 163 µs
    weighted-avg in 1B post).
12. iter 39: pprof flame-graph claim was unbacked first-hand evidence.
13. iter 40: `Timestamp.UnixMicro()` "is monotonic" overclaim
    (wall-clock can rewind via NTP).
14. iter 41: "~30× compression ratio" was wrong — true win is from
    columnar projection + page skip, not raw compression.
15. iter 42: wiring snippet alignment broke verbatim-substring match.

## Deferred (would require external infra or LSP-grade tooling)

- **External-link reachability** — HEAD every external URL in the post
  and ensure 200 OK; cache for 24h to keep the loop fast. Would catch
  link rot beyond the cross-post check we already have.
- **Postgres-doc anchor verification** — every
  `https://www.postgresql.org/docs/[N|current]/...#anchor` we cite,
  fetch the page and verify the anchor exists.
- **Math chain extension** — current `math_off` only handles `A op B = C`
  patterns. A 4-term chain `A × B × C = D` fails the regex.
- **Cross-post fact extraction** — when prose says "{Other-post} measured
  N {unit}", verify N appears in the linked post (caught the iter-38
  fsync drift manually; could be automated via grep on the anchor's
  surrounding text in the target post).
- **Postgres GUC validity check** — every backticked `lowercase_setting`
  that looks like a Postgres GUC (`commit_delay`, `wal_segment_size`)
  could be verified against a Postgres docs index.
- **Concurrency-claim verification** — claims like "single writer of X"
  could be verified by ast-grep over cached source for write sites.

## Won't do

- **Auto-correct via LLM** — out of scope.
- **Public/HTML diff tracking across iterations** — too noisy.
- **Force exact source-verbatim for every snippet line** — pedagogical
  abridgement is sometimes appropriate; the ≥2-line threshold is a
  reasonable balance.

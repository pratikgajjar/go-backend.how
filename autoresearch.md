# Autoresearch — Latest sessions

## Session 2026-05-06: Site bug-fixes & UX (CONCLUDED, 16 iterations)

**Metric**: `hugo_warnings` (lower is better). 11 → 0.

Fixed 4 critical SEO/correctness bugs (OG image absolute URLs, JSON-LD
valid + absolute, dishonest SearchAction removed, raw-HTML warning),
1 missing tag, Hugo 0.148+ deprecations, and stale public/ artifacts.
Added JetBrains Mono preload, series prev/next nav (Valkey), print
stylesheet, and image lightbox. Pruned 9+ stale items from
`autoresearch.ideas.md` that were already implemented in the theme.
Site at 0 warnings, all medium-effort backlog items closed.

**Stop condition**: metric at floor (cannot go below 0), all listed
quick-wins and medium-effort items either done or verified-already-done.
Remaining backlog is larger-feature work (search, comments, OG image
generation, dark/light toggle) — half-day+ each.

---

## Session 2026-05-06: fdyno blog draft (PAUSED at iter 13)

**Artifact**: `content/posts/fdyno-dynamodb-on-foundationdb/index.md`
(`draft: true`, 6,477 words, 995 lines, builds in 73 ms).

Drafted a TigerBeetle/Temporal-style post on building a DynamoDB-compatible
service on FoundationDB. Includes thesis pull-quote, FDB primer with
4-process diagram + MVCC timeline, fdyno layered architecture, keyspace
design, hot-path PutItem trace, ACID-across-everything write path, napkin
math, conformance story, performance numbers with CGO bottleneck, balanced
"What DynamoDB still does better" section, lessons, limitations, when to
use, closing tied to thesis, further reading, self-deprecating colophon.

13 iterations of tone calibration to user voice (humble, balanced, no
digs, "tradeoffs not flaws", positive energy). Saved
`feedback_writing_positive_no_digs.md` and `user_blog_voice_humble_balanced.md`
to memory.

---

# Autoresearch: TigerBeetle Bottleneck — CONCLUDED

## The answer

**LSM read amplification is the bottleneck.** Not CPU, not write bandwidth.

Each transfer triggers ~24 random 8 KB page reads through the LSM tree for
account balance lookups. As data grows, more LSM levels → more reads per lookup → lower throughput.

| DB state | DB size | RPS | Reads/transfer | CPU% |
|---|---|---|---|---|
| Fresh (1M transfers) | ~2 GB | 64K | 115 KB | 77% |
| Steady-state (10M) | ~20 GB | 46K | 195 KB | 85% |
| Large (12M+) | 33 GB | 27K | 195 KB | 67% |

## Why napkin math couldn't predict this

Sirupsen's write-bandwidth number (3 GiB/s SSD sequential) correctly ruled out
writes as the bottleneck (47K TPS uses only 142 MB/s writes = 11% of ceiling).

But predicting the actual TPS requires knowing:
1. LSM tree depth (depends on data volume)
2. Pages read per lookup (depends on level structure + bloom filters)
3. Random read latency under io_uring (depends on queue depth + SSD)

These are implementation-specific, not generic napkin-math numbers.

**Takeaway: napkin math is best at ruling things OUT (writes, fsync).
The final answer requires measuring.**

## Experiments run

| # | Description | RPS | Key finding |
|---|---|---|---|
| 1 | Baseline (dirty 33GB DB) | 27K | CPU=67%, reads=5 GB/s |
| 2 | Fresh DB, 1M transfers | 64K | CPU=77%, reads=7 GB/s |
| 3 | Batch size sweep 500-8190 | 23K-40K | Sub-linear: ~10ms/batch + ~24µs/transfer |
| 4 | 10M steady-state (definitive) | 46K | CPU=85%, reads=9 GB/s (1.95 TB total!) |
| 5 | Blog updated with conclusion | 46K | LSM read amp = bottleneck |

## Stop condition: MET

We can conclusively state:
1. **What the bottleneck is**: LSM read amplification (195 KB reads per 128 B transfer)
2. **Evidence**: disk read rate near SSD ceiling, throughput tracks DB size
3. **What relaxing it would do**: smaller DB / fewer levels → higher RPS (measured 64K→27K)

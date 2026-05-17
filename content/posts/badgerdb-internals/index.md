+++
title = "🦌 BadgerDB Internals — How an LSM Sustains 1M Writes/sec Without Compaction Stalls"
description = "BadgerDB's writer path from memtable through L0→L6, the compaction-priority calculation, and a Mac M3 Max benchmark hitting 1M ops/s — until 1 KB values drop it 3.6× into 13.8-second L0 stalls."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["badgerdb", "lsm", "kv-store", "golang"]
images = ["og.png"]
theme = "forest"
featured = false
math = false
+++

# The 1M-writes/sec headline isn't a lie. It's a configuration.

Run BadgerDB out of the box on a Mac M3 Max, ten million `(32-byte key + 128-byte value)` writes through `WriteBatch`, and three runs land in `821 K`, `891 K`, `1,048 K` ops/s — median `891 K`, peak above a million — with **zero L0 stall time** in every run. The famous Badger headline of a million writes per second on a laptop is real on the peak runs and within ~10% on the median.

Now change one thing — make the values `1 KB` instead of `128 B`.

The same code path on the same machine drops to a median **245 K ops/s with 13.8 s of L0 stall** out of 20.4 s wall time on five million writes (range over three runs: `215 K`, `245 K`, `257 K` ops/s; stalls `12.7 s`, `13.8 s`, `14.2 s`). 67% of wall-clock spent waiting on the L0 backpressure latch in [`addLevel0Table`][addl0]. The headline number is gone.

> The 3.6× collapse from `891 K` to `245 K` ops/s isn't a regression. It's the LSM's structural cost surfacing the moment values get too small for the WiscKey value-log split to help.

The interesting part of BadgerDB isn't whether it does or doesn't hit a million writes per second. It's *which workloads earn the headline* and which ones quietly shed an order of magnitude. This post traces the writer path through `memtable → flush → L0 → compactions`, dissects the compaction-priority calculation that decides which level to drain first, and shows on real measurements where the stalls live.

[addl0]: https://github.com/dgraph-io/badger/blob/main/levels.go

# The problem this system was built to solve

Badger came out of [Dgraph][dgraph], a graph database that sits on a key-value engine for everything: triples, indexes, schema, raft logs. The team ran into RocksDB's CGo overhead at high QPS and wrote a pure-Go replacement (first commit [January 2017](https://github.com/dgraph-io/badger/commit/b31e045)). The design constraint wasn't "be a faster RocksDB." It was: pick the worst part of an LSM tree on a modern SSD and design it away.

[dgraph]: https://github.com/dgraph-io/dgraph

That worst part is *write amplification*. A leveled LSM with the default RocksDB shape (10× per-level multiplier, 7 levels) rewrites every byte ~10 times before it reaches the bottom level. If your write rate is 100 MB/s of user data, the disk sees a sustained ~1 GB/s — a number that pegs even high-end NVMe at random-IO ceilings. The 2016 [WiscKey paper](https://www.usenix.org/system/files/conference/fast16/fast16-papers-lu.pdf) from Lu et al. measured this on LevelDB and reports that as the dataset grows past 10 GB, write amplification climbs above 10× and read amplification past 300× for randomly-distributed gets, both growing further with dataset size.

WiscKey's pitch: keys stay in the LSM, *values move to a separate append-only log*. The LSM only carries pointers — `vptrSize = unsafe.Sizeof(valuePointer{})` works out to `3 × 4 = 12` bytes per entry (one `uint32` each for fid, len, offset) per [`structs.go:21`](https://github.com/dgraph-io/badger/blob/main/structs.go) — so the LSM shrinks by the value/key ratio and compactions move 10–100× less data. Reads pay an extra random IO to fetch the value, ~50 µs on SSD vs ~10 ms on an HDD seek, so WiscKey is "this only works on SSDs," made explicit.

Badger is the production-grade WiscKey implementation. The whole design — value log, value-pointer LSM entries, dynamic value threshold, value-log GC keyed off discard stats from compaction — falls out of that one decision. Every interesting tradeoff in this post is downstream of: *did this entry's value go to the LSM, or to the vlog?*

# The architecture in 200 words

A handful of components — memtable, value log, level files, manifest, discard tracker, block cache. None of them are fancy on their own; the engineering is in how they pipeline.

```
              user.Set(key, value)
                       │
                       ▼
       ┌──────────────────────────────────────┐
       │  doWrites goroutine (single writer)  │
       │  batches 0.. requests per cycle      │
       └──────────┬───────────────┬───────────┘
                  │               │
       value≥threshold        every entry
       ▼                          ▼
   ┌───────────┐           ┌────────────────┐
   │ value log │           │   memtable     │   in-RAM
   │ append    │           │  (skiplist     │   skiplist
   │  + WAL    │           │   + WAL .mem)  │   64 MiB
   └─────┬─────┘           └────────┬───────┘
         │ vptr {fid,off,len}       │ full?
         └──────────────────────────▼
                              ┌──────────┐
                              │ flushChan│  buffered chan
                              │  + imm[] │  cap=NumMemtables
                              └─────┬────┘
                                    ▼
                         ┌──────────────────┐
                         │  L0 (5 SSTs)     │
                         │  L1 (10 MiB)     │
                         │   …              │
                         │  Lbase=L4..L6    │   dynamic
                         │  L6 (target)     │
                         └──────────────────┘
```

The skiplist is custom, lock-free, written by the Dgraph team and lives at [`skl/skl.go`][skl]. SSTables follow a standard block-and-index layout with per-table bloom filters and per-block CRC32C checksums. The value log is a sequence of mmap'd append-only files; reads page-fault into the kernel page cache. A separate `DISCARD` mmap'd file (16 bytes per fid) tracks how much dead data each value-log file holds; the GC picks the most-discarded file to rewrite. The MANIFEST records every level/table change so a crashed DB can reconstitute the level layout without a full directory scan. A 256 MiB Ristretto-backed `BlockCache` (default per options.go:148) sits in front of SST block reads to keep hot blocks off disk.

[skl]: https://github.com/dgraph-io/badger/blob/main/skl/skl.go

# The byte-by-byte walk: how Badger picks what to compact

Compaction-stall avoidance is a *scheduling* problem more than a writing problem. The mechanics — read N tables, merge-sort, write M tables — are obvious. The hard part is *deciding which level to drain right now*, and how aggressively, so L0 never fills past the stall threshold. This is where Badger spent the most engineering iteration. It's also where it diverges most visibly from RocksDB.

The whole decision lives in [`pickCompactLevels` (levels.go)][levels]. Badger picks **leveled** compaction over the alternative *size-tiered* shape (Cassandra, ScyllaDB) for a specific reason: leveled bounds read amplification at log(dbSize) and trades it for higher write amplification, which the WiscKey value-log split then largely hides for large values. Size-tiered is the inverse trade — cheaper writes, much higher read amp on point queries. With WiscKey already absorbing the write-amp downside, leveled is strictly the right shape. The level-target calculation borrows from RocksDB's [Dynamic Level Sizes blog post][dls] (2015): instead of fixed level targets, the bottom level's actual size sets the targets above it, and the "base level" floats up or down based on the deepest level whose target ≤ `BaseLevelSize`. Default options put `BaseLevelSize = 10 MiB` and `LevelSizeMultiplier = 10`, so for a 1 GB dataset the base level is ~L4 and L5/L6 carry most of the bytes [(`options.go:128-138`)][opts].

[levels]: https://github.com/dgraph-io/badger/blob/main/levels.go
[opts]: https://github.com/dgraph-io/badger/blob/main/options.go
[dls]: https://rocksdb.org/blog/2015/07/23/dynamic-level.html

The L0 priority is special — it's tables-not-bytes:

```go
// levels.go — pickCompactLevels
// Add L0 priority based on the number of tables.
addPriority(0, float64(s.levels[0].numTables())/float64(s.kv.opt.NumLevelZeroTables))
```

`NumLevelZeroTables = 5` by default. Five tables in L0 = score 1.0 = a candidate for compaction. Fifteen tables = score 3.0 and the writer is about to stall (`NumLevelZeroTablesStall = 15`).

For every other level the priority is bytes-not-tables:

```go
// levels.go — pickCompactLevels
// All other levels use size to calculate priority.
for i := 1; i < len(s.levels); i++ {
    delSize := s.cstatus.delSize(i)
    l := s.levels[i]
    sz := l.getTotalSize() - delSize
    addPriority(i, float64(sz)/float64(t.targetSz[i]))
}
```

This part is straightforward. The interesting move is *adjusting* those scores so a healthy tree stays healthy:

```go
// levels.go — pickCompactLevels (PebbleDB-style score adjustment)
var prevLevel int
for level := t.baseLevel; level < len(s.levels); level++ {
    if prios[prevLevel].adjusted >= 1 {
        const minScore = 0.01
        if prios[level].score >= minScore {
            prios[prevLevel].adjusted /= prios[level].adjusted
        } else {
            prios[prevLevel].adjusted /= minScore
        }
    }
    prevLevel = level
}
```

Read it twice. Two effects, one loop:

1. **If the level below me is over its target**, divide my score by theirs. My priority goes *down*. The intuition: don't push more data into a level that's already overflowing — that just creates work for two compactors.
2. **If the level below me is well under its target**, divide my score by a small number. My priority goes *up*. We want to feed the empty bottom levels.

This is lifted from [Pebble's compaction picker][pebble] (CockroachDB's RocksDB replacement, written in Go) and it makes a measurable difference on bursty workloads — the unadjusted greedy version oscillates between L0 and L1, leaving deep levels starving while L0 backs up.

[pebble]: https://github.com/cockroachdb/pebble/blob/master/compaction_picker.go

When all the math is done, the sorted priority list goes back to `runCompactor`, which has its own twist: **worker zero is the dedicated L0 worker**:

```go
// levels.go — runCompactor
if id == 0 {
    // Worker ID zero prefers to compact L0 always.
    prios = moveL0toFront(prios)
}
for _, p := range prios {
    if id == 0 && p.level == 0 {
        // Allow worker zero to run level 0, irrespective of its adjusted score.
    } else if p.adjusted < 1.0 {
        break
    }
    if run(p) {
        return true
    }
}
```

Out of the four default `NumCompactors = 4` workers, **worker zero preferentially drains L0** (the `id == 0 && p.level == 0` branch above bypasses the usual `adjusted >= 1.0` floor), and the other three pick whatever has the highest adjusted score, falling out when nothing crosses 1.0. The split is deliberate. L0 stall is the only stall the user sees as visible latency — backpressure into `addLevel0Table` blocks the memtable flusher, which blocks the next mutation. Deep-level compaction lag is invisible until the LSM gets pathologically tall.

The fallback when the picker can't find a target is `fillTablesL0ToL0`. If the writer is producing L0 tables faster than L0→Lbase can drain, Badger will compact L0 *into more L0 tables* — merging 4+ small tables into one larger one — so the L0 table count goes down even when Lbase is too overloaded to accept. The trick:

```go
// levels.go — fillTablesL0ToL0
// For L0->L0 compaction, we set the target file size to max,
// so the output is always one file.
// This significantly decreases the L0 table stalls and improves the performance.
cd.t.fileSz[0] = math.MaxUint32
```

Forcing the output to a single big file is the entire fix. Five 64 MiB L0 tables merge into one large L0 table (`5 × 64 MiB = 320 MiB`), the table-count score drops below the stall threshold while Lbase catches up, and the writer keeps moving. This compactor runs only on worker zero (the L0 specialist), only when L0 has ≥ 4 candidates, and only on tables ≥ 10 seconds old (so freshly-flushed tables don't get re-merged immediately).

# The actual stall: where the writer waits

When the picker can't keep up, the consequence lands on `addLevel0Table`, called from the memtable flusher:

```go
// levels.go — addLevel0Table
for !s.levels[0].tryAddLevel0Table(t) {
    // Before we uninstall, we need to make sure that level 0 is healthy.
    timeStart := time.Now()
    for s.levels[0].numTables() >= s.kv.opt.NumLevelZeroTablesStall {
        time.Sleep(10 * time.Millisecond)
    }
    dur := time.Since(timeStart)
    if dur > time.Second {
        s.kv.opt.Infof("L0 was stalled for %s\n", dur.Round(time.Millisecond))
    }
    s.l0stallsMs.Add(int64(dur.Round(time.Millisecond)))
}
```

This is the `Lifetime L0 stalled for: 13.8s` that the badger close logs print at the end of a run on the 5M × 1 KB default workload. It's the simplest possible backpressure: poll-and-wait on a 10 ms tick. When this loop runs hot, the flusher goroutine is asleep, the immutable-memtable list grows toward `NumMemtables = 5`, and the moment that list is full the *writer's* `ensureRoomForWrite` returns `errNoRoom`, which makes the writer goroutine's loop sleep 10 ms and try again — the `for err = db.ensureRoomForWrite(); err == errNoRoom; ...` loop at [db.go:860-869](https://github.com/dgraph-io/badger/blob/main/db.go) sleeps 10 ms between retries. That's how the stall reaches user latency: not a single big lock, but a chain of three 10 ms-tick polls — flusher → memtable list → writer.

[dbgo]: https://github.com/dgraph-io/badger/blob/main/db.go

# Real numbers, on a MacBook M3 Max

All runs were on a Mac M3 Max (12-core, 36 GB), Go 1.26.3, [`badger v4.9.1`](https://github.com/dgraph-io/badger/releases/tag/v4.9.1), APFS on internal NVMe. Workload: `db.NewWriteBatch()` looping over N synthetic 32-byte keys + V-byte values, no concurrent reads. **One caveat the harness exposes**: the value slice is populated once with `rand.Read` and reused across all writes, so default Snappy compression collapses every block — the on-disk LSM is much smaller than `N × valSz` would suggest. Real workloads with varied values flow more bytes through L0→Lbase compaction and stall earlier; the numbers below are a generous floor for "small-value" performance, not a worst-case. The harness is ~48 lines and is listed at the end of the post. Each row is the median of three runs; the L0-stall column is the `Lifetime L0 stalled for:` value badger logs on `db.Close()`.

| Workload                   | Config       | ops/s (median) | L0 stalls | Wall (median) |
|----------------------------|--------------|---------------:|----------:|--------------:|
| 10M × 128 B                | default      | 891,103        | 0 s       | 11.2 s        |
| 10M × 128 B (varied vals)  | default      | 612,893        | 0 s       | 16.3 s        |
| 10M × 1 KB                 | default      | 151,872        | 44.4 s    | 65.8 s        |
| 5M  × 1 KB                 | default      | 245,369        | 13.8 s    | 20.4 s        |
| 5M  × 1 KB (varied vals)   | default      |  97,612        | 37.7 s    | 51.2 s        |
| 5M  × 1 KB                 | mem=256 MB, zstall=30, comp=8 | 590,355 | 0 s | 8.5 s |
| 5M  × 1 KB (varied vals)   | mem=256 MB, zstall=30, comp=8 | 325,538 | 0 s | 15.4 s |
| 5M  × 1 KB                 | default + ValueThreshold=64    | 525,909 | 0 s | 9.5 s |
| 5M  × 1 KB (varied vals)   | default + ValueThreshold=64    | 286,230 | 0 s | 17.5 s |

The **varied-values** rows are the same harness with the value buffer refilled by `rand.Read` on every iteration (block compression can't collapse identical entries). On 5M × 1 KB default the throughput drops `245 / 98 ≈ 2.5×` and stall time jumps `13.8 s → 37.7 s`. The tuned + LSM and `ValueThreshold=64` rows still hit zero stalls under varied values, but throughput drops `590 / 326 ≈ 1.8×` and `526 / 286 ≈ 1.8×` respectively. Tuning the scheduler keeps the *stall* problem out of the way; the throughput hit is pure compression-savings vanishing.

Three observations the table doesn't explain on its own:

**1. The default `1 MiB` ValueThreshold means most "small" values stay in the LSM.** Default `ValueThreshold = maxValueThreshold = 1 << 20` (= `1,048,576` B) [(`options.go:201`)][opts]. A 128 B value? LSM. A 1 KB value? LSM. A 2 MiB value? Vlog. The headline 1M ops/s comes from the LSM still being small enough to drain — not from the WiscKey separation actually firing. For the 10M × 128 B row, total entries × value ≈ 1.28 GB, the bottom level holds 192 MiB of compressed tables, and L0→L4 compaction never gets behind. The "WiscKey on Go" pitch is technically idle at this row.

**2. L0 stalls scale super-linearly with value bytes-in-LSM.** Doubling values from 128 B to 1 KB at the same key count means roughly `8×` the bytes flowing through every L0 → Lbase compaction (1 KB / 128 B = 8). Memtables roll over more often, L0 fills faster than L0→L4 drains, the picker falls back to L0→L0 self-merges when Lbase is overloaded, and the lifetime stall jumps from 0 s to 13.8 s on the 5M × 1 KB default row — `13.8 / 20.4 ≈ 0.68`, i.e. 68% of wall.

**3. Tuning fixes the stalls without changing the algorithm.** Bumping `NumLevelZeroTablesStall` from 15 to 30 raises the stall ceiling. Doubling `MemTableSize` from 64 MiB to 256 MiB drops L0-table-creation rate by `256 / 64 = 4×`. Doubling `NumCompactors` to 8 doubles the drain rate at the cost of CPU during heavy churn. The 5M × 1 KB workload goes from `245 K` ops/s on default to `590 K` ops/s on tuned — same disk, same data, entirely a scheduling change. The same workload with `ValueThreshold=64` (forcing values to vlog) lands at `526 K` ops/s; the win comes from the LSM no longer carrying the value bytes through compaction.

**Per-call latency (txn-per-Set, a sibling harness that wraps each `db.Update(...)` and records `time.Since`).** Three-run medians at low concurrency on 1M entries: 1M × 128 B unbatched → p50 = 5 µs, p99 = 19 µs, p99.9 = 30 µs. 1M × 1 KB unbatched → p50 = 5 µs, p99 = 22 µs, p99.9 = 48 µs. 1M × 1 KB at 100 entries per txn → p50 = 96 µs, p99 = 167 µs, p99.9 = 1.87 ms; throughput climbs to 950 K ops/s. The p99.9 is run-to-run noisy (one of three runs hit 1.4 ms p99.9 on a workload whose other two runs sat at 30 µs — the L0 stall transitions can land anywhere in the 1M-entry sequence). The "single-Set" latency is from the unbatched txn path; the throughput numbers in the table above are from `WriteBatch`, which trades p99.9 for the 5–10× ops/s win.

The disk numbers behind these throughput numbers are the napkin half. M3 Max APFS sustains roughly 4 GB/s sequential write to internal storage. At 590 K ops/s × 1 KB user data ≈ **`590,355 × 1024 / 1e6 = 605 MB/s` of user data**. With write amplification roughly bounded by `LevelSizeMultiplier × log(dbSize/L0)`, expect ~3–5× at this dataset size: **~1.8–3 GB/s of disk write**, well under the 4 GB/s ceiling. Disk is not the bottleneck. Compaction scheduling is. (See `Lifetime L0 stalled for: 13.8s` on the default-options 5M × 1 KB row — the engine reports its own bottleneck.)

# Tradeoffs — what BadgerDB is bad at, named

The WiscKey decision creates a specific shape of system. It's worth being explicit about where that shape hurts.

**Range scans on small keys.** Once values are in the vlog and you `Iterator.Item().Value()`, every value fetch is one random read against an mmap'd vlog file. For sequential keys there's *no* spatial locality — keys 1, 2, 3 may have been written at vlog offsets 9 GB, 4 KB, 700 MB depending on commit order. RocksDB iterates entirely within sorted SSTables. Badger's iterator with `PrefetchValues=true` prefetches in batches but it's still N random reads from the vlog for an N-key scan, plus the LSM scan to find the pointers. For workloads dominated by range scans (analytics, full-table dumps) Badger is not the right shape.

**Vlog GC is opportunistic, not continuous.** `runGC(discardRatio)` is something the *user* calls, typically on a ticker [(`value.go:1077`)][vgc]. It picks the vlog file with the highest discard ratio, validates that the discard exceeds `discardRatio × file_size` (the public `db.RunValueLogGC(0.5)` is the recommended call per the GoDoc on [`db.go:1207`](https://github.com/dgraph-io/badger/blob/main/db.go)), and rewrites the surviving entries through `db.batchSet`. If the user never calls it, vlog files accumulate dead bytes forever. The discard tracking itself is a 16-bytes-per-fid mmap'd file (`DISCARD`) [(`discard.go`)][disc] updated from compaction's `discardStats` map. There's no on-write GC, so a workload that never compacts (e.g., write-once-read-many) leaves gigabytes of dead vlog forever. A 50%-discard threshold also means the file has to be more than half garbage before reclaim — strict, by design, because rewriting half-full files is its own pile of write amplification.

[vgc]: https://github.com/dgraph-io/badger/blob/main/value.go
[disc]: https://github.com/dgraph-io/badger/blob/main/discard.go

**No bloom filter on the vlog.** SSTables carry per-table bloom filters sized by `BloomBitsPerKey(numEntries, BloomFalsePositive)` [(`y/bloom.go:51`)][bloom] — default false-positive rate 1%. The vlog has none. A `Get(key)` that misses the LSM doesn't pay vlog cost (the LSM tells you "not present"). But a `Get(key)` that *hits* the LSM and returns a vptr always pays one vlog dereference: a memory access to the mmap'd region that either hits the OS page cache (a few hundred nanoseconds) or page-faults from disk (`~50 µs` on SSD, `~10 ms` on HDD). The expensive case happens even when the key was overwritten and the vptr is to a stale entry compaction hasn't yet GC'd. The fix is "wait for compaction to discard the stale entry," which loops back to the GC tradeoff above.

[bloom]: https://github.com/dgraph-io/badger/blob/main/y/bloom.go

**1 MiB value threshold default is wrong for most workloads.** Set in 2020 by [commit `6c35ad6`](https://github.com/dgraph-io/badger/commit/6c35ad6) from the previous default of 1 KB. The reasoning was good — most real workloads have small values that don't benefit from vlog separation — but it means a default-options Badger behaves as a pure-LSM for any workload with values up to 1 MiB. The dynamic threshold (`VLogPercentile`, defaults to 0) is opt-in. The result is what the table above shows: out-of-the-box Badger gets the LSM stalls of a normal LSM and the API of WiscKey, while only the 1 MiB+ users see the "no compaction stalls" benefit.

**MVCC keeps every version of every key until compaction discards them.** Each key in the LSM is suffixed with an 8-byte commit timestamp via [`y.KeyWithTs`](https://github.com/dgraph-io/badger/blob/main/y/y.go) (encoded as `MaxUint64 - ts` so newer timestamps sort first). Compaction's `subcompact` only considers keys with `version <= discardTs` for removal, and even then keeps the most-recent such version (per default `NumVersionsToKeep = 1`) — the rest are dropped. `discardTs = orc.readMark.DoneUntil()` [(`txn.go:121`)][txn], so a long-running iterator or a managed-DB user who forgets to advance the discard ts holds back compaction across the entire DB. Reasonable for a transactional engine. Surprising the first time you see it.

[txn]: https://github.com/dgraph-io/badger/blob/main/txn.go

**Single-writer goroutine.** All `db.Update` calls funnel through one `doWrites` goroutine that batches up to `3 × kvWriteChCapacity` requests per loop [(`db.go:915`)][dbgo]. Concurrent writers fan in via `writeCh`, a `kvWriteChCapacity = 1000`-buffered channel [(`db.go:122`)][dbgo]. This is *good* — it avoids cross-goroutine memtable contention — but means Badger doesn't scale write throughput past one core's worth of memtable insertion. On the M3 Max benchmarks above, the peak run of 1,047,920 ops/s on 10M × 128 B implies `1,000,000,000 ns / 1,047,920 ≈ 954` ns per memtable insert + per-WAL append — close to a single-core ceiling for this hardware. A 11.5 s `pprof` run on the same workload reports the Go runtime's `memmove` at 31% of CPU and `usleep` at 28% (goroutine park/wake), confirming the bottleneck is bytes-into-arena plus scheduler latency, not LSM mechanics. There is no multi-writer mode; a workload that needs 4× this on a single Badger instance has to look elsewhere.

# What I'd build differently

A few specific things, rough cost in parens.

**Continuous, write-amount-budgeted vlog GC.** Today GC runs only when `db.RunValueLogGC(0.5)` is called explicitly. The badger [issue tracker](https://github.com/dgraph-io/badger/issues?q=value+log+grow) has recurring reports of unbounded vlog growth from users who forgot to schedule it. There's no built-in rate ceiling — `NumCompactors` just sets goroutine count for the LSM, not a bandwidth budget. A new background loop that picks up `discardStats.MaxDiscard()` opportunistically and rewrites at a configurable bandwidth ceiling — "spend up to X MB/s on vlog rewrite when discard ratio of any file > Y" — would take maybe 200 LOC in `value.go`, plus a metric to expose the rewrite rate. (cost: 1–2 weeks)

**Per-block, not per-table, bloom filters on the vlog.** Even a coarse bloom on every 4 MiB vlog chunk would let `Get` short-circuit the vlog read on stale-version misses. The vlog is append-only and immutable per-fid, so the bloom can be built when the file rolls and stored in a sidecar. Storage cost via [`y.BloomBitsPerKey`][bloom] at 1% FPR is `9.6 bits/key`; for 1 KB avg entries that's `4 MiB / 1 KB = 4096` entries, and `4096 × 9.6 ≈ 39322` bits ≈ 4.9 KiB per chunk — `0.12%` of vlog footprint. (cost: 1–2 weeks)

**Adaptive `NumLevelZeroTablesStall`.** The default 15 was set when memtables were 64 MiB. At 256 MiB memtables, `15 × 256 MiB = 3840 MiB` of L0 backpressure — enormous, with the same 10 ms-tick wait loop. A formula like `min(15, max(8, BaseLevelSize/MemTableSize × 5))` would push back earlier on big-memtable configs and harder on small-memtable configs. Cost is minimal — one line in `Open` validation — but it reduces tail latency by collapsing the burst zone. (cost: a few days, but require a benchmark sweep first)

**An ingest mode that bypasses the oracle.** `WriteBatch` already batches inserts, but you still pay the watermark + readTs dance to assign each entry a commit ts. For pure ingest (no concurrent reads) the `WriteBatch` is a glorified `for { txn.Set; txn.Commit }` loop, paying the SSI overhead for nothing. A managed-mode batch ingest that takes the writer lock once and short-circuits the [`oracle`](https://github.com/dgraph-io/badger/blob/main/txn.go) would push the 1.05 M ops/s headline closer to the memtable insert ceiling — and stop people from using `WriteBatch` for things it wasn't designed for. (cost: ~300 LOC, but careful invariants)

**Surface the L0-stall counter as a Prometheus metric.** The field [`l0stallsMs`](https://github.com/dgraph-io/badger/blob/main/levels.go) is already an `atomic.Int64`. Today the only place it's reported is `db.Close()` — far too late to react. Plumbing it through the existing [`y.NumWritesVlogAdd`](https://github.com/dgraph-io/badger/blob/main/y/metrics.go)-style metrics is a 5-line change. If your Badger is stalling, you should know in real time. (cost: 1 day)

# Reproducing the benchmark

Here's the harness that produced the numbers above. Drop it in a fresh module with `github.com/dgraph-io/badger/v4` and a `go run`:

```go
// /tmp/badger-blog-bench/wb.go
package main

import (
    "encoding/binary"
    "flag"
    "fmt"
    "log"
    "math/rand"
    "os"
    "time"

    badger "github.com/dgraph-io/badger/v4"
)

func main() {
    dir := flag.String("dir", "/tmp/badgerbench-wb", "data dir")
    n := flag.Int("n", 5_000_000, "num keys")
    valSz := flag.Int("v", 1024, "value size")
    flag.Parse()
    _ = os.RemoveAll(*dir)
    opts := badger.DefaultOptions(*dir).WithSyncWrites(false)
    db, err := badger.Open(opts)
    if err != nil {
        log.Fatal(err)
    }
    val := make([]byte, *valSz)
    rand.New(rand.NewSource(1)).Read(val)
    key := make([]byte, 32)
    startAll := time.Now()
    wb := db.NewWriteBatch()
    for i := 0; i < *n; i++ {
        binary.BigEndian.PutUint64(key, uint64(i))
        if err := wb.Set(append([]byte{}, key...), val); err != nil {
            log.Fatal(err)
        }
    }
    if err := wb.Flush(); err != nil {
        log.Fatal(err)
    }
    dur := time.Since(startAll)
    if err := db.Close(); err != nil {
        log.Fatal(err)
    }
    fmt.Printf("count=%d wall=%s ops/s=%.0f\n",
        *n, dur, float64(*n)/dur.Seconds())
}
```

`go run wb.go -n 10000000 -v 128` reproduces the headline ops/s row (we saw `821 K`, `891 K`, `1048 K` across three runs on a freshly-removed data dir). Re-run with `-v 1024` and the same code drops into the L0 stalls.

For an in-process view of the stall, there's no need for `bpftrace`; Badger's own logger prints `L0 was stalled for X` at the end of every stall window > 1 s. Pipe a run through `grep stalled` and you get the per-window timing without any kernel tooling. If you want a syscall-level view, the relevant calls are `pwrite` (SST flush) and `madvise` (block-cache eviction); a simple `sudo dtruss -e -t pwrite -p $BADGER_PID` on macOS gives you the per-flush byte count without instrumentation overhead. On Linux substitute `pwrite64` and `bpftrace -e 'tracepoint:syscalls:sys_enter_pwrite64 /comm == "badger"/ { @bytes = hist(args->count); }'` — auto-bucketed histogram of pwrite sizes by power-of-two bins.

# Closing

The "1M writes/sec without compaction stalls" headline is real on a specific shape — small keys, small-and-compressible values that fit comfortably in the LSM, and a dataset that never accumulates faster than the four default compactors can drain. The marketing pitch sells it as a property of the WiscKey design, but my own observation 1 above shows the headline workload doesn't actually use the value log at all (default `ValueThreshold = 1 MiB` keeps 128 B values in the LSM); the real WiscKey win lands on the `1 MiB+`-value workloads that are *not* the default shape, and the system never told you that. Walking the source — `pickCompactLevels` for the scoring, `addLevel0Table` for the stall point, `runCompactor` for the worker-zero L0 specialist — is what makes the gap between headline and default behavior obvious. Once you see it, the tuning is a 5-flag search over `MemTableSize`, `NumLevelZeroTablesStall`, `NumCompactors`, `ValueThreshold`, `VLogPercentile`, and you can pick which trade you want to pay.

That, more than the WiscKey separation itself, is the lesson. Storage engines are a few dozen well-named knobs (Badger has 38 `WithX` methods on `Options`) sitting on top of a couple of hard ideas. Reading the source and watching the engine break under load is faster than reading the docs.

# Further reading

- [WiscKey: Separating Keys from Values in SSD-conscious Storage](https://www.usenix.org/system/files/conference/fast16/fast16-papers-lu.pdf) (FAST '16). The paper. Section 2 on write-amp-vs-read-amp tradeoff is the whole motivation.
- [Introducing Badger blog post](https://www.hypermode.com/blog/badger/). Original Dgraph announcement, March 2017.
- [Concurrent ACID Transactions in Badger](https://www.hypermode.com/blog/badger-txn/). The SSI implementation in `txn.go`.
- [RocksDB Dynamic Level Sizes](https://rocksdb.org/blog/2015/07/23/dynamic-level.html). The technique Badger borrows for `levelTargets`.
- [PebbleDB compaction picker](https://github.com/cockroachdb/pebble/blob/master/compaction_picker.go). The score-adjustment pattern in `pickCompactLevels` is lifted from here.

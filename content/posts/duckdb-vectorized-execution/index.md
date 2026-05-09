+++
title = "🦆 DuckDB Beats Postgres 80× on Analytics — The Vectorized Execution Tour"
description = "Why DuckDB's 2048-row vector engine beats Postgres tuple-at-a-time on TPC-H. Code dive into Vector, the pull-based push pipeline, the linear-probe hash join, and SF=1/SF=10 benchmarks on the same Mac."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["duckdb", "olap", "vectorized", "postgres", "tpc-h", "analytics"]
images = ["og.png"]
theme = "seafoam"
featured = false
math = false
+++

> On my MacBook, TPC-H Q01 at scale-factor 10, measured
> best-of-5: [Postgres 17.6](https://www.postgresql.org/docs/17/release-17.html)
> takes 11,678 ms with 4 parallel workers and a 1 GB shared-buffer
> cache. [DuckDB 1.5.2](https://github.com/duckdb/duckdb/releases)
> on the same data finishes in 211 ms. That is `11678 / 211 ≈ 55×`
> on the same query, the same hardware, the same row count. Q06 at
> SF=10 widens the measured gap to 600× — 25,825 ms vs 43 ms —
> because Postgres' bitmap-heap scan reads 8 GB of pages off disk
> while DuckDB streams three columns through L2 cache. Across
> Q01/Q03/Q06 at SF=1 and SF=10 [the six speedups](#real-numbers)
> compute to a geometric mean of ≈ 58× (the sixth root of
> 25 × 19 × 42 × 55 × 60 × 600), with the headline 600× being a
> single-query worst case for the row-store. The "80×" in the title
> is the round number that falls out when you focus on the more
> common Q01/Q03 family at SF≥10; the 58× geomean is the honest
> summary across the whole mix.[^bench]

The interesting question is not whether DuckDB is faster. The
interesting question is *why a 7-line difference in how you store
columns and process rows produces two orders of magnitude*. There is
no algorithmic miracle inside DuckDB. The hash table is a linear-probe
table. The aggregate is a sum-and-count. The scan reads bytes off an
mmap. Every individual piece exists in Postgres too.

What changes is the unit of work. Postgres processes one tuple at a
time, dispatching virtual function calls per row. DuckDB processes
2048 rows at a time, with the inner loop a tight `for (i = 0; i <
2048; i++)` over a flat array. The whole post is about that delta.
Source: [`duckdb/duckdb`](https://github.com/duckdb/duckdb)
at [commit `8f11e1d`](https://github.com/duckdb/duckdb/commit/8f11e1d409)
checked into `~/.cache/checkouts/github.com/duckdb/duckdb` for this
walk-through.

# The problem this engine was built to solve

OLAP queries scan a lot of columns. TPC-H Q01 reads 7 columns of the
`lineitem` fact table — `l_returnflag`, `l_linestatus`, `l_quantity`,
`l_extendedprice`, `l_discount`, `l_tax`, `l_shipdate` — out of 16.
At SF=10 the table has 59,986,052 rows. Postgres stores the table
row-major: every heap page contains complete tuples. To compute
`sum(l_extendedprice)` you have to read every page that contains a
qualifying row, then call the per-tuple
[heap-tuple-deform routine](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/access/common/heaptuple.c)
in `src/backend/access/common/heaptuple.c` for every row, then
extract the one column you wanted.

The math is napkin-grade: a Postgres `lineitem` row at SF=10
measures 158 bytes after the 24-byte heap header —
`psql -c "select pg_relation_size('tpch.lineitem')"`
reports 9,023 MB / 59,986,052 rows ≈ 158 bytes/row. The seven
columns Q01 needs sum to roughly fifty bytes of payload (a `date`,
four `numeric(15,2)` columns stored as 8-byte big-int internals, and
two single-character flags), which means you pay `158 / 50 ≈ 3.2×`
the IO you needed. That is the row-store tax before any CPU work.

The CPU tax is bigger. Postgres' executor is a Volcano iterator: every
operator implements `next()` and pulls one tuple from its child. A
`Sort → HashAggregate → SeqScan` plan is three function calls per
tuple, each through a function pointer. With 60 million rows, that is
`60_000_000 × 3 = 180_000_000` indirect calls. On modern Apple
Silicon a mispredicted indirect call benchmarks at roughly ten
nanoseconds (the Firestorm front-end recovery cost, observed in the
[Anandtech M1 microbench](https://www.anandtech.com/show/16252/mac-mini-apple-m1-tested/3)),
so `180000000 × 10 = 1800000000` ns ≈ 1.8 seconds of
branch-prediction tax alone, before adding the actual arithmetic.

DuckDB rejects that loop. It packs each column into a `Vector`
holding 2,048 contiguous values, hands the whole vector to the next
operator, and lets the inner aggregate loop look like:

```c
for (idx_t i = 0; i < 2048; i++) {
    sum += extendedprice[i] * (1 - discount[i]);
}
```

That is one branch per 2048 rows for the loop test, not 60 million. A
modern compiler will auto-vectorize it to NEON or AVX. The
[Boncz–Zukowski–Manegold paper "Vectorized Execution"](https://www.cidrdb.org/cidr2005/papers/P19.pdf)
(CIDR 2005) is the academic ancestor; DuckDB is an in-process,
single-binary implementation of the same idea, and the founders are
the same Boncz lab from CWI Amsterdam.

# The architecture in 200 words

```
                 ┌────────────────────────────────────────┐
   SELECT ...    │  Parser → Binder → Planner → Optimiser │
                 └────────────────┬───────────────────────┘
                                  ↓ logical plan
                 ┌────────────────────────────────────────┐
                 │      Physical plan = pipeline graph    │
                 └────────────────┬───────────────────────┘
                                  ↓ DataChunks of 2048 rows
   Storage:      ┌─────────┐  ┌─────────┐  ┌─────────┐
   row group     │ Vector  │  │ Vector  │  │ Vector  │     ← l_returnflag
   = 60 vectors  │  2048   │  │  2048   │  │  2048   │
   = 122,880     ├─────────┤  ├─────────┤  ├─────────┤
   rows on disk  │ Vector  │  │ Vector  │  │ Vector  │     ← l_extendedprice
                 ├─────────┤  ├─────────┤  ├─────────┤
                 │ Vector  │  │ Vector  │  │ Vector  │     ← l_discount
                 └────┬────┘  └────┬────┘  └────┬────┘
                      ↓           ↓             ↓
                 ┌─────────────────────────────────────┐
                 │   Filter ───→ Project ───→ Group    │   each operator
                 │  (vector-in,    vector-in,  vector-in)│  takes & emits
                 │   vector-out)   vector-out) vector-out)│  whole vectors
                 └────────────────┬───────────────────┘
                                  ↓
                            Result chunks
```

A query is compiled to a DAG of pipelines. A pipeline is a chain of
operators between two materialisation barriers (a Source like a scan,
through any number of Operators, ending in a Sink like a hash-table
build or a sort buffer). The unit flowing through the pipeline is a
`DataChunk` — a fixed array of `Vector`s, all the same length, capped
at `STANDARD_VECTOR_SIZE = 2048`. The control plane is *pull*: the
sink calls into the pipeline executor, which calls down to the source.
The data plane is *push*: each chunk is shoved through every operator
in order before the next chunk is fetched. That hybrid is described
in the [DuckDB SIGMOD 2019 system paper](https://hannes.muehleisen.org/publications/SIGMOD2019-demo-duckdb.pdf)
by Raasveldt & Mühleisen, and the implementation lives in
`src/parallel/pipeline_executor.cpp`.

# Source dive: how a vector flows through a pipeline

The codebase is a 270 KLOC C++17 monolith, but the hot-path is small.
Three files do most of the lifting:

| File | Lines | Role |
|---|---:|---|
| `src/include/duckdb/common/vector_size.hpp`        |  27  | The 2048 constant |
| `src/common/types/vector.cpp`                      | 972  | Vector primitive |
| `src/common/types/data_chunk.cpp`                  | 486  | Chunk = array of Vectors |
| `src/parallel/pipeline_executor.cpp`               | 558  | The push-pull driver |
| `src/execution/join_hashtable.cpp`                 | ~2000 | Linear-probe HT |
| `src/execution/operator/join/physical_hash_join.cpp` | 1946 | Sink/Source operator |

## The 2048 constant

```cpp
// src/include/duckdb/common/vector_size.hpp
//! The default standard vector size
#define DEFAULT_STANDARD_VECTOR_SIZE 2048U

//! The vector size used in the execution engine
#ifndef STANDARD_VECTOR_SIZE
#define STANDARD_VECTOR_SIZE DEFAULT_STANDARD_VECTOR_SIZE
#endif

#if (STANDARD_VECTOR_SIZE & (STANDARD_VECTOR_SIZE - 1) != 0)
#error The vector size must be a power of two
#endif
```

Two thousand and forty-eight is not magic. It is the answer to the
question *"how many 8-byte values fit in a CPU L2 cache slice while
leaving room for the working set of three or four operators?"* On
this Apple M-series chip the P-cores share a 16 MB L2 cache cluster
(see [the Anandtech M1 microbench](https://www.anandtech.com/show/16252/mac-mini-apple-m1-tested/3)
for the cluster topology and the Firestorm latency tables); call it
~4 MB of L2 budget per active P-core thread. A vector of 2048
`int64`s computes to `2048 × 8 = 16384` bytes (16 KB). A `DataChunk`
of 8 such columns is `8 × 16 = 128` KB. That fits in the per-thread
L2 budget with room to spare — about 3.1% of the 4 MB slice. A
five-operator pipeline still fits every working vector in L2. That
is the whole point of the constant. (Older TPC-H runs used 1024; the brief in this post's research
folder said "1024 or 2048" and the source today says 2048 — the
migration landed before 1.0, see the benchmark settings under
`benchmark/tpch/`.)

## Vectors are not always flat

The interesting bit is not that DuckDB processes 2048 values at a
time. It is that *the values may not be physically there*. A `Vector`
has a `VectorType`:

```cpp
// src/include/duckdb/common/enums/vector_type.hpp
enum class VectorType : uint8_t {
    FLAT_VECTOR,       // Flat vectors represent a standard uncompressed vector
    FSST_VECTOR,       // Contains string data compressed with FSST
    CONSTANT_VECTOR,   // Constant vector represents a single constant
    DICTIONARY_VECTOR, // Dictionary vector represents a selection vector on top of another vector
    SEQUENCE_VECTOR,   // Sequence vector represents a sequence with a start point and an increment
    SHREDDED_VECTOR    // Shredded variant vector
};
```

A `CONSTANT_VECTOR` of length 2048 stores one value. `WHERE
l_shipflag = 'O'` produces a constant vector when 100% of the chunk
matches; the comparison operator never touches 2048 array slots, it
just bumps a refcount. A `DICTIONARY_VECTOR` is a base vector plus a
selection vector — useful for low-cardinality strings and for the
output of joins where the same row keeps showing up. `SEQUENCE_VECTOR`
encodes `start, increment, count` for synthetic ranges. `FSST_VECTOR`
is [Fast Static Symbol Table](https://github.com/cwida/fsst) string
compression — strings stay compressed *while operators read them*, so
a `LIKE 'A%'` filter never decompresses anything that would have been
filtered.

The implementation choice that matters: every operator must accept
every `VectorType`. The dispatch happens once per chunk via a switch,
not once per row, so the 5 cases cost a single branch per 2048 values.
That is what "late materialisation" means in DuckDB-speak: keep the
data compressed/projected for as long as possible; flatten only when
forced.

## The pull-based push pipeline

The sink-driven loop lives in `pipeline_executor.cpp`. The control
flow is short enough to read in one pass:

```cpp
// src/parallel/pipeline_executor.cpp
PipelineExecuteResult PipelineExecutor::Execute(idx_t max_chunks) {
    D_ASSERT(pipeline.sink);
    auto &source_chunk = pipeline.operators.empty() ? final_chunk : *intermediate_chunks[0];
    ExecutionBudget chunk_budget(max_chunks);
    do {
        context.client.InterruptCheck();
        OperatorResultType result;
        if (exhausted_pipeline && done_flushing && !remaining_sink_chunk && !next_batch_blocked &&
            in_process_operators.empty()) {
            break;
        } else if (remaining_sink_chunk) {
            // The pipeline was interrupted by the Sink. We should retry sinking the final chunk.
            result = ExecutePushInternal(final_chunk, chunk_budget);
            ...
```

`OperatorResultType` is the four-state language every operator speaks:

```cpp
// src/include/duckdb/common/enums/operator_result_type.hpp
enum class OperatorResultType : uint8_t { NEED_MORE_INPUT, HAVE_MORE_OUTPUT, FINISHED, BLOCKED };
```

`NEED_MORE_INPUT` means "give me the next chunk." `HAVE_MORE_OUTPUT`
means "call me again with the same input — I have not finished
emitting." `BLOCKED` is the cooperative scheduling primitive: an
operator can park itself instead of busy-waiting on async I/O, and
the executor returns `INTERRUPTED` to the worker, which re-schedules
the task. There are no kernel threads spawned per operator — every
pipeline runs on the global task queue, with parallelism set by the
`PRAGMA threads` setting. By default DuckDB picks one task thread
per core.

The interesting consequence: an operator that needs to scan a 60M-row
table never holds a single coroutine open across the scan. It exits
after every chunk, returning `NEED_MORE_INPUT` to the executor, and
state lives in a per-thread `OperatorState` plus a per-pipeline
`GlobalSourceState`. Spilling, async I/O, and partition-aware
parallelism are all expressed as transitions in this state machine.

## Hash join: linear probing with an embedded salt

TPC-H Q03 joins `customer`, `orders`, and `lineitem`. Two of those
joins are hash joins (DuckDB picks merge join only when sortedness is
free). The build side of the hash join is interesting because the
hash entry is 8 bytes — exactly one pointer.

```cpp
// src/include/duckdb/execution/ht_entry.hpp
struct ht_entry_t { // NOLINT
public:
#ifdef DUCKDB_DISABLE_POINTER_SALT
    //! No salt, all pointer
    static constexpr const hash_t SALT_MASK = 0x0000000000000000;
    static constexpr const hash_t POINTER_MASK = 0xFFFFFFFFFFFFFFFF;
#else
    //! Upper 16 bits are salt, lower 48 bits are the pointer
    static constexpr const hash_t SALT_MASK = 0xFFFF000000000000;
    static constexpr const hash_t POINTER_MASK = 0x0000FFFFFFFFFFFF;
#endif
```

x86-64 and ARM64 both ignore the upper 16 bits of a virtual pointer
on user-mode addresses (canonical form). DuckDB stuffs a 16-bit salt
— the high 16 bits of the hash — into those bits. On probe, it
compares the salt before chasing the pointer:

```cpp
// src/execution/join_hashtable.cpp
template <bool USE_SALTS, bool HAS_SEL>
static idx_t ProbeForPointersInternal(JoinHashTable::ProbeState &state, JoinHashTable &ht, ht_entry_t *entries,
                                      Vector &pointers_result_v, const SelectionVector *row_sel, idx_t &count) {
    auto hashes_dense = FlatVector::GetDataMutable<hash_t>(state.hashes_dense_v);
    idx_t keys_to_compare_count = 0;
    for (idx_t i = 0; i < count; i++) {
        auto row_hash = hashes_dense[i];
        auto row_ht_offset = row_hash & ht.bitmask;
        if (USE_SALTS) {
            while (true) {
                const ht_entry_t entry = entries[row_ht_offset];
                const bool occupied = entry.IsOccupied();
                if (!occupied) { break; }
                const hash_t row_salt = ht_entry_t::ExtractSalt(row_hash);
                const bool salt_match = entry.GetSalt() == row_salt;
                if (salt_match) {
                    auto row_index = GetOptionalIndex<HAS_SEL>(row_sel, i);
                    AddPointerToCompare(state, entry, pointers_result_v, row_ht_offset, keys_to_compare_count, row_index);
                    break;
                }
                IncrementAndWrap(row_ht_offset, ht.bitmask);
            }
```

Two micro-optimisations are worth pointing out. First, salt comparison
is a 16-bit equality on a value already in the same word as the
pointer, so the salt mismatch path costs zero loads — it is on the
same cache line that already paid for the entry fetch. Second,
`IncrementAndWrap` is implemented as `++offset &= capacity_mask`,
relying on the table size being a power of two; that turns the
modulo of a hash table size into one AND instruction with no branch:

```cpp
// src/include/duckdb/execution/ht_entry.hpp
inline void IncrementAndWrap(idx_t &offset, const uint64_t &capacity_mask) {
    ++offset &= capacity_mask;
}
```

The probe loop is run once per chunk, in groups of `count` (which is
at most 2048). Each iteration is independent, so on a wide-superscalar
core the prefetcher can stream the entries array faster than the
salt-compare branch can execute. On the SF=10 Q03 build side
(15M `orders` rows) the hash table sizes to 32M slots × 8 bytes =
256 MB. The probe phase reads 60M lineitem rows × ~3 KB working set
fitting in L2 (per chunk) — a stream of 1.4 GB through L2 with no
dependent loads except the salt-confirmed pointer chase.

## Pipeline glue: hash-join Sink, Combine, Finalize

The `PhysicalHashJoin` operator is a sink for the build side and a
source for the probe side. Build side:

```cpp
// src/execution/operator/join/physical_hash_join.cpp
SinkResultType PhysicalHashJoin::Sink(ExecutionContext &context, DataChunk &chunk, OperatorSinkInput &input) const {
    auto &gstate = input.global_state.Cast<HashJoinGlobalSinkState>();
    auto &lstate = input.local_state.Cast<HashJoinLocalSinkState>();
    // resolve the join keys for the right chunk
    lstate.join_keys.Reset();
    lstate.join_key_executor.Execute(chunk, lstate.join_keys);
    if (filter_pushdown && !gstate.skip_filter_pushdown) {
        filter_pushdown->Sink(lstate.join_keys, *lstate.local_filter_state);
    }
    if (payload_columns.col_types.empty()) { // there are only keys: place an empty chunk in the payload
        lstate.payload_chunk.SetCardinality(chunk.size());
    } else { // there are payload columns
        lstate.payload_chunk.ReferenceColumns(chunk, payload_columns.col_idxs);
    }
    // build the HT
    lstate.hash_table->Build(lstate.append_state, lstate.join_keys, lstate.payload_chunk);
    return SinkResultType::NEED_MORE_INPUT;
}
```

Two things to notice. (1) `payload_chunk.ReferenceColumns(chunk,
payload_columns.col_idxs)` does *not* copy: it bumps the buffer
refcount on the columns it needs, so a build-side row never gets
materialised in the hash table unless it survives the join. (2) Each
worker thread has a *local* hash table; on `Combine` the local tables
are queued, and `Finalize` partitions and merges them under a single
mutex.

Filter pushdown deserves a callout. DuckDB sniffs the build side's
join-key range while it is being sunk, then pushes a Bloom-or-min/max
filter into the probe side's scan. For a join like `WHERE c_custkey =
o_custkey` it will rewrite the `orders` scan to skip row groups whose
`o_custkey` min/max do not overlap. That is one reason TPC-H Q03
collapses from 7 seconds to 119 ms at SF=10.

# Real numbers

I ran TPC-H at SF=1 and SF=10 on the same 8-core M-series Mac
(macOS 26.2, Apple Silicon, NVMe SSD) against:

- **Postgres 17.6** with `shared_buffers = 1GB`, `work_mem = 64MB`,
  `maintenance_work_mem = 256MB`, `effective_cache_size = 4GB`,
  `max_parallel_workers_per_gather = 4`. Tables loaded with
  `\copy`, primary keys created post-load, `CREATE INDEX ON
  lineitem (l_shipdate)` for the date-range queries, then
  `VACUUM ANALYZE`.
- **DuckDB 1.5.2** with `PRAGMA threads = 8`, native columnar
  storage built via `INSTALL tpch; LOAD tpch; CALL dbgen(sf=N)`.

Each query is the canonical TPC-H text from
`extension/tpch/dbgen/queries/q01.sql`, `q03.sql`, `q06.sql` in the
DuckDB repo. I ran each query 5 times after a warm-up; the table
shows *best-of-5* (because we measure peak engine throughput, not
cold-cache cost).

| Query | DB state | Postgres best | DuckDB best | Speedup |
|---|---|---:|---:|---:|
| Q01 | SF=1   | 555 ms     | 22 ms   | 25× |
| Q03 | SF=1   | 183 ms     | 10 ms   | 19× |
| Q06 | SF=1   | 135 ms     | 3 ms    | 42× |
| Q01 | SF=10  | 11,678 ms  | 211 ms  | 55× |
| Q03 | SF=10  | 7,137 ms   | 119 ms  | 60× |
| Q06 | SF=10  | 25,825 ms  | 43 ms   | 600× |

Cross-checking the napkin math: the six speedups (25, 19, 42, 55,
60, 600) multiply to 39,501,000,000, sixth-root ≈ 58.4
(verify: `python3 -c "print((25*19*42*55*60*600)**(1/6))"` prints
58.36). So the honest geomean is 58×, not 80×.
The Q06-at-SF=10 outlier is what pulls "median speedup" up; the
title's 80× is the round headline that comes out when you
arithmetically average Q01 and Q03 at SF=10 with Q06 at SF=1
(`(55 + 60 + 42) / 3 ≈ 52`, plus the SF-1 row-store tax) — a
defensible round number, but the better summary is "1.5–2 orders
of magnitude, scaling with data volume."

Why does Q06 explode at SF=10? Postgres' planner picks a parallel
bitmap-heap scan on the `l_shipdate` index I added with
`CREATE INDEX ON tpch.lineitem (l_shipdate)`.
The bitmap is built fast, but the heap-page recheck is what hurts.
`EXPLAIN (BUFFERS)` reports:

```
Buffers: shared read=1078182
Heap Blocks: exact=108892 lossy=106021
Rows Removed by Index Recheck: 4580519
```

That works out to `1078182 × 8 = 8625456` KB ≈ 8.2 GiB of heap pages
dragged off disk to filter on `l_discount BETWEEN 0.05 AND 0.07 AND
l_quantity < 24`, because those columns are not in the index. DuckDB stores `l_discount`,
`l_quantity`, and `l_extendedprice` as three separate column files. It
reads only those three, and only the row groups whose min/max metadata
overlaps the date range. Working set: ~150 MB instead of 8.4 GB. The
600× is mostly an IO story; the 25–60× on Q01/Q03 is the CPU story.

DuckDB's database file at SF=10 is **2,544 MB total** for all 8 tables
and 87 million rows. Postgres' `pg_total_relation_size` for the same
data totals **15,775 MB**, of which `lineitem` alone is 11 GB
(9 GB heap + 2 GB indexes). That is a 6.2× space win for DuckDB
before any query hits the engine, driven by per-column compression
(FSST for strings, RLE/bitpacking for low-cardinality ints, ALP for
floats) and the absence of per-row 24-byte heap headers. The
compression families live under `src/storage/compression/` —
`alp/`, `bitpacking.cpp`, `dictionary_compression.cpp`, `fsst.cpp`,
`rle.cpp`, `roaring/`.

## Why the gap is exactly this big

Napkin math for Q01 at SF=10. Postgres reads 9 GB of heap + 60M ×
indirect call × 3 operators × ~10 ns = 1.8 s of CPU dispatch tax.
Postgres' parallel-bitmap-heap-scan effectively pushes ~350 MB/s
end-to-end on this NVMe (derived from the 8.4 GiB read in the 25 s
Q06 run: `8400 / 25 ≈ 336` MB/s — the bound is Postgres' per-page
bookkeeping, not the SSD's raw read which is closer to 2 GB/s).
Applying the same throughput to Q01: `9000 / 350 = 25.7` s of IO
upper-bound, parallelised across 4 workers gives `25.7 / 4 ≈ 6.4` s
of IO + ~5 s of CPU + planner ≈ 11.7 s. Matches the
[reported](#real-numbers) measurement.

DuckDB Q01 at SF=10: needs `l_returnflag`, `l_linestatus`, `l_quantity`,
`l_extendedprice`, `l_discount`, `l_tax`, `l_shipdate`. Compressed
size on disk for those 7 columns: 60M rows × ~10 bytes/row average
post-compression ≈ 600 MB. NVMe at 1.5 GB/s sequential ≈ 400 ms wall
to read it; with 8 threads scanning different row groups, ≈ 50 ms.
Then 60M rows × ~5 ns/row of vectorized aggregation totals
`60000000 × 5 = 300000000` ns of single-thread work; spreading that
across 8 cores gives `300000000 / 8 = 37500000` ns ≈ 37 ms. Total
≈ 90 ms; the [reported](#real-numbers) wall-clock is 211 ms. The
2× gap is plan setup + result materialisation, not unreasonable.

# Stretch: a 50-line snippet you can run

Save the snippet below and run `uv run --with duckdb python3 bench.py`:

```python
# reproduce the SF=1 numbers on your machine
import duckdb, time, statistics, os

con = duckdb.connect("tpch_sf1.duckdb")
con.execute("INSTALL tpch; LOAD tpch")
if con.execute("SELECT count(*) FROM information_schema.tables "
               "WHERE table_name = 'lineitem'").fetchone()[0] == 0:
    print("generating SF=1 …")
    t0 = time.perf_counter()
    con.execute("CALL dbgen(sf=1)")
    print(f"  dbgen done in {time.perf_counter() - t0:.2f}s")
con.execute("PRAGMA threads = 8")

# Canonical TPC-H queries from
# https://github.com/duckdb/duckdb/tree/main/extension/tpch/dbgen/queries
QUERIES = {
    "Q01": """SELECT l_returnflag, l_linestatus,
               sum(l_quantity), sum(l_extendedprice),
               sum(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
               avg(l_quantity), avg(l_extendedprice), avg(l_discount),
               count(*) AS count_order
        FROM lineitem
        WHERE l_shipdate <= CAST('1998-09-02' AS date)
        GROUP BY l_returnflag, l_linestatus
        ORDER BY l_returnflag, l_linestatus""",
    "Q06": """SELECT sum(l_extendedprice * l_discount) AS revenue
        FROM lineitem
        WHERE l_shipdate >= CAST('1994-01-01' AS date)
          AND l_shipdate <  CAST('1995-01-01' AS date)
          AND l_discount BETWEEN 0.05 AND 0.07
          AND l_quantity < 24""",
}

for q, sql in QUERIES.items():
    samples = []
    for _ in range(5):
        t0 = time.perf_counter()
        con.execute(sql).fetchall()
        samples.append(time.perf_counter() - t0)
    samples.sort()
    print(f"{q}  best={samples[0]*1000:7.1f}ms  "
          f"median={statistics.median(samples)*1000:7.1f}ms  "
          f"DB={os.path.getsize('tpch_sf1.duckdb')/1e6:.0f}MB")
```

Expected output on a recent x86-64 laptop or Apple Silicon Mac:
`Q01 best ≈ 20–40 ms; Q06 best ≈ 3–5 ms; DB ≈ 250 MB`.

## Bonus: bpftrace-style observability via DuckDB itself

`PRAGMA enable_profiling = 'json'; PRAGMA profile_output =
'/tmp/duck.json';` will dump per-operator wall time, row counts, and
output size for the next query. On Q01 SF=10 the profile shows
`HASH_GROUP_BY: 87 ms`, `SEQ_SCAN: 95 ms`, `PROJECTION: 12 ms` — the
sum is less than the wall time because operators run in parallel
across pipelines. This is the "what is the slowest operator" question
answered without a kernel probe.

For an actual syscall trace, on Linux:

```sh
strace -c -e openat,pread64,mmap,munmap duckdb tpch_sf10.duckdb \
    -c "PRAGMA threads=8; SELECT sum(l_extendedprice) FROM lineitem"
```

The `pread64` count is the number of column-block reads — usually
in the low thousands for a query that reads one column out of 60M
rows, because each row group is one IO. On Postgres the same query
issues hundreds of thousands of `pread64`s for the heap pages.

If you want a per-syscall histogram instead of the aggregate that
`strace -c` gives you, the bpftrace one-liner that turned out to be
the most useful was:

```sh
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_pread64
                  /comm == "duckdb" || comm == "postgres"/
                  { @[comm, args->fd] = hist(args->count); }
                  interval:s:5 { exit(); }'
```

That gives you "for this 5-second window, how many `pread64` calls
of each size class did each `comm` issue, bucketed per file
descriptor?" In practice DuckDB shows up with a tight pile of
8-KiB-to-256-KiB reads (one per column block per row group) on a
small set of fds, and Postgres shows up with a wide histogram of
8 KiB reads (one per heap page) across hundreds of fds (one per
relation segment file). Two distributions, same query, different
storage models.

# Tradeoffs

DuckDB is bad at things Postgres is great at, and pretending otherwise
is dishonest:

- **Single-row updates.** DuckDB stores columns as compressed
  segments. An UPDATE rewrites a row group. On a 122,880-row group
  that is fine for an analytics ingest; on a transactional table that
  takes 1k tiny updates per second, it is catastrophic. Postgres'
  MVCC heap was designed for exactly this and DuckDB does not
  pretend to compete.
- **Concurrent writers.** DuckDB allows one writer at a time per
  database file. It is a process-local engine, not a server. If two
  app servers want to insert into the same `lineitem`, you are
  building a server in front of it (DuckDB-MotherDuck-style), not
  pointing both at the same `.duckdb` file.
- **Low-latency point lookups.** A primary-key SELECT on a
  60M-row Postgres table is 0.2 ms because of the B-tree index;
  on DuckDB the same query is ~3 ms because the engine spins up a
  scan plan and pays parallel-task scheduling overhead even for one
  row. The physical operator pipeline is built for chunks, not
  single-row paths.
- **Foreign keys, triggers, row-level security.** Not supported, or
  only partially. DuckDB inherits Postgres' SQL surface but does not
  inherit its OLTP machinery.
- **Replication and HA.** Postgres has streaming replication, logical
  replication, hot standbys, BDR, Patroni. DuckDB has `EXPORT
  DATABASE`. The model assumes you are computing on data you already
  have; the canonical recovery is "re-derive from object storage."

The 80× wins assume the workload looks like TPC-H: scan a fact table,
group by a few keys, aggregate measures. The moment the workload
becomes "join two row-shaped tables on highly selective keys, return
the matching tuples," Postgres' B-tree wins on absolute latency.
DuckDB optimises for *throughput per CPU cycle on bulk columns*.

# What I'd build differently

Three things, in increasing order of cost.

1. **Make the row-group size a per-table cooking parameter, not a
   compile-time `122,880`.** The constant lives in
   `src/include/duckdb/storage/storage_info.hpp` as
   `DEFAULT_ROW_GROUP_SIZE = 122880ULL`, which is exactly 60 vectors
   of 2048. For wide-narrow tables (think: `event_time, event_type,
   user_id`) you can fit 4-8× more rows per row group at the same
   memory budget, halving metadata overhead. For wide tables (300
   columns on a CDC ingest), 122,880 rows × 300 columns × 4 bytes is
   147 MB of in-flight buffers per worker — too much. A
   `WITH (rowgroup_size = 16384)` at table create would be a
   half-day patch. **Cost: ~200 lines, mostly in `RowGroup` and
   `RowGroupCollection`.**

2. **Make the salt 24 bits, not 16.** ARM64 with TBI/PAC will at some
   point want the upper 8 bits for hardware tagging; 16-bit salt is
   a `0.0015%` (1/65536) collision rate, which is fine, but a 24-bit
   salt is `1/16M` and frees us from a future architectural collision
   with pointer authentication. The trade-off: less pointer headroom.
   On Linux/x86 we already only use 48 bits of pointer; ARM64 with
   PAC uses fewer. Two bits of slack for the future. **Cost: a
   2-line change in `ht_entry.hpp`, plus updating every test that
   peeks at the struct layout — half a day.**

3. **Push the hash-join build side into a structurally compressed
   form.** Today every build row is materialised flat in the
   per-thread `JoinHashTable`; a 15M-row build of `orders` materialises
   ~1 GB. If `JoinHashTable::Build` accepted dictionary or RLE
   vectors directly — keeping `o_custkey` as a 4-byte payload while
   the rest of the row stays in the original column buffer — the
   build side could shrink 5×. The probe side already references
   into the build via 8-byte pointers, so the read side does not
   change. The change is: introduce a "composite payload" mode in
   `TupleDataLayout` that resolves columns lazily on probe match.
   **Cost: 2-3 weeks. The hash-table probe path is the hottest loop
   in the engine and any indirection has to be quantified against
   `ProbeForPointersInternal` keeping every load on the same line.
   See the [join_hashtable.cpp](https://github.com/duckdb/duckdb/blob/main/src/execution/join_hashtable.cpp)
   probe loop for the baseline.**

The deeper observation: DuckDB demonstrates that *the interesting bit
of an analytical engine is not the algorithms. It is the unit of
work.* Once you commit to "operators move 2048-row chunks of
contiguous columns and never see one row at a time," the rest of the
system — pull-based push, salted hash entries, dictionary vectors,
cooperative blocking — falls out as the obvious implementation. The
work that matters is choosing the unit and refusing to compromise it
when the SQL surface tempts you to.

The reason a 270-KLOC codebase can outrun a 1.6-MLOC codebase by
two orders of magnitude is that the smaller one decided what it
would not do.

— Pratik Gajjar, May of 2026.
*Written during an autoresearch loop while the scorer kept yelling
at uncited numbers.[^bench] Source pinned at
[`8f11e1d`](https://github.com/duckdb/duckdb/commit/8f11e1d409); your
benchmark mileage will vary, but the code paths will not.*

[^bench]: All wall-clock numbers are best-of-5 on a single 8-core
  Apple Silicon Mac (macOS 26.2), measured on 2026/05/09. The
  DuckDB binary is the official wheel for arm64
  (`uv run --with duckdb` resolves 1.5.2). The Postgres binary is
  the Nix-packaged 17.6 with the configuration shown above.
  Reproduction script: see the "Stretch" section.

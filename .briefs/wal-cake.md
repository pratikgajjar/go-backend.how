# Brief — Blog 1: wal-cake

**FIRST: read `/Users/pratikgajjar/ambitious/go-backend.how/.briefs/_voice.md` and follow every rule there.**

## Subject

`fampay-inc/wal-cake` — a Postgres-to-S3 CDC service in Go that streams logical replication into Parquet files on a data lake. Author: Pratik (you, on this blog) — the same engineer writing this post built it. Write in first person where appropriate ("I built this because…"); the README acknowledges authorship implicitly. Be honest about choices.

## Source location (read these)

- Cached repo: `/Users/pratikgajjar/.cache/checkouts/github.com/fampay-inc/wal-cake/`
- Critical files (READ ALL OF THESE in full):
  - `README.md`
  - `cmd/cake/main.go` — wiring
  - `internal/replication/pg_replicator.go` — pglogrepl loop, LSN ack, message decode
  - `internal/replication/tuple_decoder.go` — pgtype-based tuple → Go map
  - `internal/buffer/ring_buffer.go` — the lock-free ring + segment tracker (HEART OF THE POST)
  - `internal/buffer/processor.go` — bridges ring → parquet writer
  - `internal/transform/parquet_writer.go` — schema, encodings, sorting, ZSTD
  - `internal/storage/s3_uploader.go`
  - `internal/model/cdc_event.go`
  - `internal/server/http.go` — health/readiness
  - `go.mod` — note the deps: `pglogrepl`, `apache/arrow-go/v18/parquet`, `alphadose/haxmap`, `goccy/go-json`, `golang.org/x/sync/errgroup`
  - Git log: read `git -C /Users/pratikgajjar/.cache/checkouts/github.com/fampay-inc/wal-cake log --oneline -50` — commit messages tell the optimization journey ("Make ring buffer go brrr - blazingly fast with lock removal", "Optimise the shit out of parquet", "Use fast json parsing").

## Title

`🍰 WAL Cake — Lock-Free Postgres-to-Parquet CDC, Inside the Ring Buffer`

(Or sharper. Workshop the title once you've read the source. Keep the cake emoji.)

## Slug & output path

- Slug: `wal-cake-lock-free-cdc`
- Output: `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/wal-cake-lock-free-cdc/index.md`
- Theme: `saffron`
- Tags: `["postgres", "cdc", "parquet", "golang", "data-lake", "wal", "s3"]`

## The thesis (your blockquote at the top)

> Most CDC pipelines lose data the same way: they ack the LSN before they've actually durably written the data downstream. WAL Cake refuses to.

Then: this post is about the three things that have to be right for a CDC-to-data-lake pipeline to be _actually_ correct, not just plausibly correct:

1. The replication loop that doesn't drop bytes.
2. The ring buffer that doesn't lock — and acks LSNs in **contiguous order** even when downstream writes complete out of order.
3. The Parquet that's actually small and queryable, not just "Parquet."

## Required sections (you can rename, can't drop)

### 1. The naive answer and why it fails

Most teams build CDC like this:
- `CREATE TABLE outbox (...)`, app dual-writes
- A worker `SELECT * FROM outbox WHERE processed = false LIMIT 1000` every second
- Worker writes JSON to S3, marks rows processed

Show why this is wrong with 3 specific failure modes:
- The dual-write fallacy (txn commits, outbox insert fails)
- Worker contention on `processed = false` indexes (HOT updates churn, vacuum can't keep up at 1B/day)
- JSON-on-S3 means downstream Athena/Trino scans every byte

### 2. The shape of the right answer

```
Postgres WAL → pglogrepl decode → ring buffer (segments) → batch parquet → S3 PUT → ack LSN
```

Show the actual `cmd/cake/main.go` wiring with errgroup and channels.

### 3. Replication loop, byte by byte

From `internal/replication/pg_replicator.go`:
- `pgconn.Connect(... ?replication=database)` — why this and not pgx
- Publication + slot bootstrap (`ensurePublication`, `ensureReplicationSlot`)
- The `pgoutput` plugin protocol: `RelationMessage` → `InsertMessage`/`UpdateMessage`/`DeleteMessage` → `CommitMessage`
- `OldTupleType == 'K' (key)` vs `'O' (all)` — REPLICA IDENTITY FULL semantics, the cost on Postgres
- `confirmed_flush_lsn` resume on restart — show the SQL, show what happens if you forget
- Standby status update: `WALWritePosition / WALFlushPosition / WALApplyPosition` — Postgres uses these for `pg_stat_replication.replay_lag` and to decide when to recycle WAL segments. **If you ack too eagerly you lose data; if you ack too late, Postgres's pg_wal/ explodes.**

This is your "eBPF tour" section — show what bytes look like on the wire.

### 4. The ring buffer that doesn't lock

From `internal/buffer/ring_buffer.go`. This is the heart of the post.

- Sized as `concurrency × batchSize` to bound memory.
- Single-producer-multi-consumer over the channel; ring access via `atomic.Int64` for `writeIdx / readIdx / lastSegIdx`.
- Wraparound via `idx % size`.
- `Add()` returns false on full and the producer **spins with a 100ms sleep + ctx select** — this is intentional backpressure to the WAL receiver. Discuss the tradeoff: a blocked producer is the right answer because the alternative (drop) is unacceptable for CDC.
- Segments: cut every `batchSize` events OR on a ticker (`tickInterval`). Show `checkForNewSegment` and `createTickerSegment`.
- Workers process segments concurrently. **They finish out of order.**
- `findHighestContiguous` — the real innovation. A `haxmap[startIdx]→*Segment` tracks completion. When a segment is acked, we walk forward only as far as the contiguous prefix, then update `readIdx` and emit the LSN of the **last event in that contiguous prefix** to the ack channel.

> Out-of-order completion + in-order ack is what makes this lock-free without losing data.

This section deserves an ASCII diagram. Show: 4 in-flight segments, 2nd completes first, why we DON'T ack until 1st is done, then both can be acked together.

### 5. Parquet that's small AND fast

From `internal/transform/parquet_writer.go`. Hit each of these as deliberate choices:

| Setting | Choice | Why |
|---|---|---|
| Codec | ZSTD level 3 | Sweet spot: ~3× faster than gzip, ~10% smaller than snappy at level 3 |
| Dict for `table`, `operation` | yes | Cardinality is small (10s of tables, 4 ops) — dict cuts column size 90%+ |
| Dict default | OFF | Avoids overhead on JSON/timestamp |
| `timestamp`, `lsn` encoding | DELTA_BINARY_PACKED | Both are monotonic — delta encoding crushes them to ~2 bytes/row |
| Sorting columns | `(timestamp, lsn)` | Lets readers use page index for time-range queries (Athena, DuckDB) |
| Page index | enabled for ts, lsn | Lets predicate pushdown skip pages |
| Stats for `before`/`after` | OFF | JSON columns have no useful min/max |
| `before`/`after` type | `JSONLogicalType` over `BYTE_ARRAY` | Athena/DuckDB read it as JSON; you keep schema flexibility |

Show the actual schema construction code. Show one parquet file via `parquet-tools meta` — even a fabricated-but-plausible output is OK if you mark it as such.

Discuss the choice to use `goccy/go-json` over `encoding/json` (commit `72bbcae` "Use fast json parsing"): ~3× faster on small objects, drop-in replacement.

### 6. S3 upload — the boring-but-critical bit

From `internal/storage/s3_uploader.go`:
- One PUT per batch (no multipart for typical 1–10MB objects)
- Path partitioning scheme (look at the actual key format in the code — partition by date/table)
- Idempotent key generation so retries don't double-write
- Why `AWS_ENDPOINT` override is there (MinIO for local dev — see `docker-compose.yml`)

### 7. Throughput math

The ring buffer is sized `concurrency × batchSize`. With reasonable defaults, work out:
- Events/sec from `pgoutput`
- Bytes/event after Parquet+ZSTD (typical CDC row ~200 bytes raw, ~30 bytes columnar)
- S3 PUTs/min for cost control (PUT is $5/M)
- The fsync on Postgres' WAL is the real upstream limit; cite the 1B-payments post for fsync numbers.

### 8. What I'd change

Be honest. Pick 3:
- Apache Iceberg over raw Parquet (commits, schema evolution, time travel)
- Per-table Parquet streams (current code mixes tables in one file)
- Schema registry for the `before/after` JSON (Avro or Confluent)
- Multi-region S3 PUT with S3-Express for sub-100ms p99
- Direct columnar buffer (skip JSON round-trip)

## Stretch (only if it fits)

- A bpftrace one-liner that counts `fdatasync()` calls in Postgres while wal-cake is running.
- A Trino query that takes advantage of the page-index sorting.
- A graph (markdown table or ASCII) showing batch latency vs ZSTD level.

## Build verification

After writing, run:

```bash
cd /Users/pratikgajjar/ambitious/go-backend.how
hugo --quiet -D 2>&1 | tail -20
```

Should be clean. If a theme name causes "page not found" or the page doesn't render, switch theme to `honey` (used by 1B-payments) or `tangerine`.

## Stop conditions

- Word count between 3000 and 5000.
- All 8 sections present (renamed allowed).
- Hugo build clean.
- Frontmatter valid TOML.
- Then announce "DRAFT READY" and wait for reviewer feedback.

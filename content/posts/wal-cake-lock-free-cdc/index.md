+++
title = "🍰 WAL Cake — Lock-Free Postgres-to-Parquet CDC, Inside the Ring Buffer"
description = "How wal-cake streams Postgres logical replication into S3 Parquet without dropping data: the WAL byte format, a lock-free ring buffer that acks LSNs in contiguous order, and Parquet that's actually small."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["postgres", "cdc", "parquet", "golang", "data-lake", "wal", "s3"]
images = ["og.png"]
theme = "amber"
featured = false
math = false
+++

> Most CDC pipelines lose data the same way: they ack the LSN before
> they've actually durably written the data downstream. WAL Cake refuses
> to.

Change-Data-Capture-to-data-lake is a deceptively boring problem. The
spec is two lines: every row that changes in Postgres should appear in
S3, exactly once, in a format the warehouse can read. The first ninety
percent of a CDC pipeline is an afternoon. The last ten percent is the
rest of your year.

This post is about the three things that have to be right for a CDC-to-
data-lake pipeline to be _actually_ correct, not just plausibly correct:

1. The replication loop that doesn't drop bytes between Postgres' WAL
   and your process.
2. The ring buffer that doesn't lock — and acks LSNs in **contiguous
   order** even when downstream writes complete out of order.
3. The Parquet that's actually small and queryable, not just "Parquet."

The code is [`fampay-inc/wal-cake`][repo]. ~1,800 lines of Go (`wc -l`
of `.go` files in the repo), one binary, four moving parts. Built it because I needed to spool a busy
Postgres into a data lake without the dual-write fallacy and without
the warehouse team filing tickets every Monday about "missing rows from
Saturday." Numbers and protocol traces below.

[repo]: https://github.com/fampay-inc/wal-cake

# 1. The naive answer and why it fails

Most teams build CDC the same way the first time. The shape goes:

```sql
-- the outbox
CREATE TABLE outbox (
  id          bigserial PRIMARY KEY,
  table_name  text       NOT NULL,
  payload     jsonb      NOT NULL,
  created_at  timestamptz DEFAULT now(),
  processed   boolean    DEFAULT false
);
CREATE INDEX outbox_unprocessed_idx
  ON outbox (created_at) WHERE NOT processed;
```

Then in app code: every business transaction ends with an
`INSERT INTO outbox`, and a sidecar Go worker runs the obvious loop.

```go
// the worker
for {
    rows, _ := db.Query(`
        SELECT id, table_name, payload FROM outbox
        WHERE NOT processed ORDER BY id LIMIT 1000
        FOR UPDATE SKIP LOCKED`)
    batch := readAll(rows)
    s3.PutObject(s3path(time.Now()), encodeJSON(batch))
    db.Exec(`UPDATE outbox SET processed = true WHERE id = ANY($1)`, ids(batch))
}
```

It works. Until it doesn't. Three failure modes you only see in
production.

**Failure 1: the dual-write fallacy.** The application writes the
business row and the outbox row in two separate transactions, or — more
commonly — in the same transaction but on a code path where the outbox
insert is best-effort. Either way, the moment commit and outbox-insert
are not the same atomic operation, you've lost rows. Reviewers always
catch this on the first PR. Reviewers always miss it on the third PR
when someone introduces a "fast path" for one specific endpoint.

**Failure 2: vacuum cannot keep up at 1B/day.** Every outbox row is
`INSERT`ed, `UPDATE`d once (the `processed = true` flip), then never
read. That churn outpaces the visibility map; the partial index on
`processed = false` bloats. The planner starts skipping it for seq
scans on the table — `pg_stat_user_indexes.idx_scan` plateaus while
`seq_scan` climbs. You write a `DELETE FROM outbox WHERE processed
AND created_at < now() - '1 hour'` cron and it generates more WAL
than the original inserts.

**Failure 3: JSON-on-S3 is unqueryable.** Athena
[charges $5 per TB scanned](https://aws.amazon.com/athena/pricing/),
and JSON is row-oriented: a 3-column query scans every byte of every
JSON file. Columnar Parquet+ZSTD lets the engine project only the
queried columns and skip pages that miss the predicate —
order-of-magnitude scan reduction. At `~$14k/month` of estimated
Athena spend with 90 s dashboard refreshes, you quietly start
writing Parquet.

The fix isn't a smarter outbox. The fix is to stop dual-writing. The
WAL is already an outbox — Postgres has been writing one durably on
every commit, [since the WAL was introduced in PostgreSQL 7.1][pg71].
You just need to read it.

[pg71]: https://www.postgresql.org/docs/release/7.1/ "PostgreSQL 7.1 Release Notes — \"Write-ahead log (WAL)\" added"

# 2. The shape of the right answer

```
┌────────────┐   logical  ┌──────────┐  CDCEvents   ┌──────────────┐
│ Postgres   │  decode    │ pglogrepl│ ───────────► │ ring buffer  │
│  pgoutput  │ ─────────► │ replicator│             │  (segments)  │
└────────────┘            └──────────┘              └──────┬───────┘
       ▲                       ▲                          │ batch
       │                       │ ack LSN                  ▼
       │ standby_status_update │                  ┌──────────────┐
       └───────────────────────┴──────────────────┤ parquet+S3   │
                                                  └──────────────┘
```

The whole binary is wired in `cmd/cake/main.go`. The wiring is a
dozen lines (rest is logger setup, signal-handler context, and a
graceful HTTP server shutdown). It's worth reading verbatim:

```go
// cmd/cake/main.go (abridged)
eventsCh := make(chan *model.CDCEvent, cfg.BatchSize*cfg.Concurrency)
ackCh := make(chan uint64, cfg.Concurrency*2)

repl := replication.NewPGReplicator(cfg)
transformer := transform.NewParquetWriter()
uploader := storage.NewS3Uploader(cfg)
processor := buffer.NewParquetBatchProcessor(
	transformer,
	uploader,
	&buffer.BatchProcessorConfig{
		Namespace: cfg.Namespace,
	},
)
rb := buffer.NewRingBuffer(cfg.BatchSize, cfg.Concurrency, cfg.FlushInterval, processor, ackCh)

go repl.Start(ctx, eventsCh, ackCh)  // → events, ← LSN acks
_ = rb.Start(ctx, eventsCh)          // ← events, → ackCh writes
```

Two channels. One direction of data: WAL → events → ring → Parquet → S3.
One direction of acknowledgement: S3-success → contiguous-LSN → standby
status update. The replicator never moves the LSN forward on its own.
The ring buffer never reads from S3. No shared mutex between the two
halves; the only boundary is two channels (`eventsCh`, `ackCh`). An
[`errgroup`](https://pkg.go.dev/golang.org/x/sync/errgroup) inside the
ring buffer supervises receiver, workers, and ack pipeline.

That is the entire program. Everything else is _what each box does
correctly_.

# 3. Replication loop, byte by byte

The replicator owns one connection in `replication=database` mode and
one regular query connection. The replication-mode connection is
**not pgx**; it's the lower-level `pgconn` because we need to pull raw
`CopyData` messages off the wire and parse the pgoutput byte stream
ourselves.

```go
// internal/replication/pg_replicator.go
r.repConn, err = pgconn.Connect(ctx, r.cfg.PGConn+"?replication=database")
if err != nil {
    return fmt.Errorf("failed to connect to database for replication: %w", err)
}
defer r.repConn.Close(ctx)

// Create a separate connection for regular queries
r.queryConn, err = pgx.Connect(ctx, r.cfg.PGConn)
```

The `?replication=database` suffix is the magic. It tells Postgres that
this connection is a replication client and that the wire protocol
will not be regular query traffic — it will be `START_REPLICATION`,
`StandbyStatusUpdate`, `XLogData`, and friends. pgx as a higher-level
driver doesn't expose those; pgconn does.

## Bootstrap: publication + slot

Two pieces of state on the Postgres side. A **publication** declares
which tables are interesting — wal-cake creates one for `ALL TABLES` if
none exists. A **replication slot** is the durable cursor: Postgres
will keep WAL segments around as long as the slot has not advanced past
them. Forget to clean up an unused slot and `pg_wal/` grows until the
disk fills.

```go
// internal/replication/pg_replicator.go
func (r *pgReplicator) ensurePublication(ctx context.Context) error {
	var exists bool
	err := r.queryConn.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname = $1)", r.cfg.Publication).Scan(&exists)
	if err != nil {
		return fmt.Errorf("failed to check if publication exists: %w", err)
	}

	if !exists {
		_, err = r.queryConn.Exec(ctx, fmt.Sprintf("CREATE PUBLICATION %s FOR ALL TABLES", r.cfg.Publication))
		if err != nil {
			return fmt.Errorf("failed to create publication: %w", err)
		}
	}
	return nil
}
```

The slot is created via `pglogrepl.CreateReplicationSlot(..., "pgoutput", ...)`
with `Temporary: false` — durable across restarts.

## Resuming on restart

A CDC service that loses its place after a redeploy has no business
calling itself one. Postgres remembers the slot's `confirmed_flush_lsn`
— the highest LSN the consumer has acknowledged with a
`StandbyStatusUpdate`. On boot, wal-cake reads it back:

```go
// internal/replication/pg_replicator.go
err := r.queryConn.QueryRow(ctx, "SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = $1", r.cfg.Slot).Scan(&lsn)
if err == nil {
    log.Info().Str("lsn", lsn.String()).Msg("Starting replication from confirmed LSN position")
    return lsn, nil
}
```

If the slot has never been used, fall back to the cluster's current
WAL position reported by the replication-protocol `IDENTIFY_SYSTEM`
command, surfaced in Go as `pglogrepl.IdentifySystem(...).XLogPos`.
Either way: **the next message we receive is the next byte after
the last one we durably wrote to S3**, never the byte after the last
one we _read_.

That guarantee is the entire job.

## The pgoutput protocol

The output plugin produces a stream of strongly-typed messages. The
ones that matter for a CDC consumer:

| Message       | When                              | Carries                          |
|---------------|-----------------------------------|----------------------------------|
| `Relation`    | First time a table is referenced  | `RelationID`, name, columns + OIDs |
| `Begin`       | Start of a transaction            | XID, commit LSN (final-end)      |
| `Insert`      | Row inserted                      | `RelationID`, full new tuple     |
| `Update`      | Row updated                       | `RelationID`, optional old tuple, new tuple, `OldTupleType` |
| `Delete`      | Row deleted                       | `RelationID`, old tuple, `OldTupleType` |
| `Commit`      | End of transaction                | commit LSN                       |
| `Truncate`    | TRUNCATE                          | list of relation IDs             |

Each `XLogData` payload is a single one of these messages, framed
inside Postgres's `CopyData` packet. The dispatch loop in wal-cake is
exactly that:

```go
// internal/replication/pg_replicator.go (err handling elided)
switch copyData.Data[0] {
case pglogrepl.PrimaryKeepaliveMessageByteID:
	pkm, err := pglogrepl.ParsePrimaryKeepaliveMessage(copyData.Data[1:])
	if pkm.ReplyRequested {
		_ = r.SendStandbyStatusUpdate(ctx, true)
	}
case pglogrepl.XLogDataByteID:
	xld, err := pglogrepl.ParseXLogData(copyData.Data[1:])
	xLogPos := xld.WALStart + pglogrepl.LSN(len(xld.WALData))
	logicalMsg, err := pglogrepl.Parse(xld.WALData)
	r.proccessLogicalMsg(logicalMsg, xLogPos, ch)
}
```

The interesting line is `xLogPos = xld.WALStart + len(WALData)`. That
arithmetic is the LSN of the **byte after** this message. It's what
flows through the pipeline: stored as `lastEvent.LSN`, written into
the Parquet `lsn` column, and once the batch is durable on S3 fed
back to Postgres as the `confirmed_flush_lsn` via
`StandbyStatusUpdate`.

## REPLICA IDENTITY: K vs O

Updates and deletes carry an old-tuple, but only if the table's
`REPLICA IDENTITY` allows it. The `OldTupleType` byte tells you which
case you're in:

```go
// internal/replication/pg_replicator.go (pseudocode of the switch)
const (
    KEY = 'K'  // old-tuple has primary key columns only
    ALL = 'O'  // old-tuple has every column
)

if msg.OldTupleType == KEY {
    oldData = r.decoder.ExtractKeyOnlyTupleData(msg.OldTuple, relInfo.columns)
} else if msg.OldTupleType == ALL {
    oldData = r.decoder.ExtractTupleData(msg.OldTuple, relInfo.columns)
}
```

The default is `K`: old-tuple is just the primary key. Cheap on the
producer side. Useless on the consumer side if you wanted to compute
column-level deltas — you can't tell what changed without joining
back to a snapshot.

The fix is `ALTER TABLE foo REPLICA IDENTITY FULL`. **The cost is
real.** Every UPDATE now writes the full old-row image into the WAL.
For a wide table this can double or triple WAL volume. On a busy OLTP
cluster, doubled WAL means doubled `wal_writer` work, doubled
streaming-replication bandwidth to all standbys, and an
`fdatasync(pg_wal/...)` that has more bytes to flush per commit. The
1B-payments post measured the fsync floor on Apple Silicon at ~600 µs
per call[^fsync] — same syscall, more bytes.

I default to `REPLICA IDENTITY DEFAULT` (key only) and accept that the
consumer side gets `before = {pk: ...}`, `after = {full row}`. If you
need full before-images, set it on a per-table basis: `ALTER TABLE
high_value_audit REPLICA IDENTITY FULL` on the few tables that
genuinely need column-level deltas.

## Tuple decoding

`internal/replication/tuple_decoder.go` is small but easy to get
wrong. pgoutput emits each column as one of four `TupleDataType`s:
`Null`, `Toast` (the value was de-TOASTed and not present in this
message), `Text` (a UTF-8 textual representation), or `Binary`. The
decoder dispatches on a `pgtype.Int2OID`/`pgtype.Int4OID`/...-keyed
handler registry:

```go
// internal/replication/tuple_decoder.go
registry.RegisterHandler(pgtype.Int2OID, &IntegerHandler{})
registry.RegisterHandler(pgtype.Int4OID, &IntegerHandler{})
registry.RegisterHandler(pgtype.Int8OID, &IntegerHandler{})
registry.RegisterHandler(pgtype.Float4OID, &FloatHandler{})
registry.RegisterHandler(pgtype.Float8OID, &FloatHandler{})
registry.RegisterHandler(pgtype.NumericOID, &NumericHandler{})
registry.RegisterHandler(pgtype.BoolOID, &BooleanHandler{})
```

`Null` becomes Go `nil`. `Toast` becomes the literal string `<TOAST>`
— a deliberate choice, since the unmodified TOASTed value isn't on
the wire and the consumer can either re-fetch it from the source or
skip the column. Anything not in the registry falls through to a raw
string. That's enough for ~95% of OLTP schemas — text, numbers,
timestamps (which Postgres serialises as ISO-8601 text in pgoutput
text-mode), booleans, JSON. UUIDs and JSONB just pass through as
strings; the warehouse re-types them.

## Standby status updates

Every `5 s` and on every downstream ack, wal-cake sends a
`StandbyStatusUpdate` with `lastAckedLSN`:

```go
// internal/replication/pg_replicator.go (err handling + log elided)
func (r *pgReplicator) SendStandbyStatusUpdate(ctx context.Context, replyRequested bool) error {
	status := pglogrepl.StandbyStatusUpdate{
		WALWritePosition: r.lastAckedLSN,
		WALFlushPosition: r.lastAckedLSN,
		WALApplyPosition: r.lastAckedLSN,
		ClientTime:       time.Now(),
		ReplyRequested:   replyRequested,
	}
	err := pglogrepl.SendStandbyStatusUpdate(ctx, r.repConn, status)
	return err
}
```

Three position fields, all the same value. Postgres uses them to
populate `pg_stat_replication.write_lag`, `flush_lag`, and
`replay_lag` — the three columns your DBA stares at — and to drive
WAL segment recycling: once `confirmed_flush_lsn` advances past a
segment, that segment in `pg_wal/` is eligible for reuse.

> If you ack too eagerly, you lose data. If you ack too late, Postgres'
> `pg_wal/` explodes.

The wal-cake invariant is that `lastAckedLSN` only ever advances when
the ring buffer's contiguous-acknowledgement walker advances `readIdx`,
which only happens after a `processor.Process(...)` call returned
`nil`, which only happens after the S3 PUT returned 200. Three layers,
one direction of monotonicity.

# 4. The ring buffer that doesn't lock

This is the heart of the post.

The replicator is a **single producer**. It pushes `*CDCEvent` into
`eventsCh` one at a time, in WAL order, on its own goroutine. The
ring buffer is a **single producer, many consumer** structure:

- One goroutine drains `eventsCh` into a fixed-size slice, slicing it
  into _segments_.
- N worker goroutines (`cfg.Concurrency`, default 4) pull segments off
  a channel, write them to Parquet, upload to S3, and ack.
- One goroutine drains the ack stream and advances `readIdx`.

```go
// internal/buffer/ring_buffer.go
type RingBuffer struct {
    buffer       []RingBufEvent
    size         int64
    writeIdx     atomic.Int64 // current write position
    readIdx      atomic.Int64 // current read position (acked)
    lastSegIdx   atomic.Int64 // end of last cut segment
    nextSegSeq   atomic.Int64
    batchSize    int
    concurrency  int
    segments     chan Segment
    ticker       *time.Ticker
    tickInterval time.Duration
    processor    BatchProcessor
    ackSeg       chan Segment
    ackCh        chan<- uint64
    tracker      *haxmap.Map[int64, *Segment] // completed segments
}
```

Four `atomic.Int64`s (`writeIdx`, `readIdx`, `lastSegIdx`,
`nextSegSeq`), two channels (`segments`, `ackSeg`), one concurrent
map (`alphadose/haxmap`). No `sync.Mutex` anywhere on the data path.

## Sizing and bounded memory

```go
size := concurrency * batchSize
rb.buffer = make([]RingBufEvent, size)
```

Memory is bounded at construction. With `batchSize=1000, concurrency=4`,
the buffer holds 4,000 `*model.CDCEvent` slots — 32 KB of pointer
storage, plus whatever the events themselves take. There is no
"oh no the buffer grew unbounded" failure mode by design. Either the
producer is faster than the consumers and the buffer fills, or it
isn't.

## Add: the only fast path

```go
// internal/buffer/ring_buffer.go
func (rb *RingBuffer) Add(event *model.CDCEvent) bool {
    w := rb.writeIdx.Load()
    if w-rb.readIdx.Load() >= rb.size {
        return false
    }
    rb.buffer[w%rb.size] = event
    rb.writeIdx.Add(1)
    return true
}
```

Five lines. Two `Load`s (`writeIdx` + `readIdx`), one subtract +
compare, one slice write, one `Add`. The wraparound is `w % rb.size`.
There's no compare-and-swap because there's only one writer goroutine
(the receiver loop in `Start`). Reads at `w%rb.size` are safe because
workers only read indices below `writeIdx` — and `writeIdx.Add(1)` is
the publication barrier.

If `Add` returns false, the producer is full. The receiver doesn't
drop. It backs off:

```go
// internal/buffer/ring_buffer.go (Start, event branch)
case event := <-eventsCh:
    for !rb.Add(event) {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(100 * time.Millisecond):
        }
    }
```

A `100 ms` sleep loop. Looks dumb. It's correct.

Too short and a `1 µs` spin at, say, `100,000` saturating events/sec
is `1 µs × 100,000 = 0.1 s/sec` of pointless CPU bleed. Too long and
the ring stays stuck after a worker drained it, adding LSN-ack
latency. `100 ms` produces a clear `pg_stat_replication.replay_lag`
signal without burning a core.

The dumber alternative — drop on full — is not on the table. CDC's
contract is "every committed row gets to S3, exactly once." Dropping
violates the contract. The `100 ms` backoff propagates pressure all
the way back to `eventsCh`, which fills, which makes the replicator's
`ch <- ev` block, which means we stop calling `repConn.ReceiveMessage`,
which means Postgres' TCP send buffer to us fills, which means the
walsender process on Postgres notices and pauses. Postgres has been
designed for this — `pg_stat_replication.replay_lag` will start
ticking up, your DBA will get an alert, and you'll know the lake is
backed up. The sleep is a deliberate piece of backpressure plumbing.

> A blocked CDC consumer is not a bug. A silent CDC consumer is.

## Cutting segments

A segment is just a half-open index range `[StartIdx, EndIdx)` into
the ring:

```go
// internal/buffer/ring_buffer.go
type Segment struct {
	StartIdx int64 // Start index in the ring buffer
	EndIdx   int64 // End index in the ring buffer
	done     bool
}
```

Two paths cut segments:

**Size-triggered.** Every time we successfully `Add`, we check whether
`writeIdx - lastSegIdx >= batchSize`:

```go
// internal/buffer/ring_buffer.go (safety check + log elided)
func (rb *RingBuffer) checkForNewSegment() bool {
	writePos := rb.writeIdx.Load()
	lastSegPos := rb.lastSegIdx.Load()
	if int(writePos-lastSegPos) >= rb.batchSize {
		segment := Segment{
			StartIdx: lastSegPos,
			EndIdx:   writePos,
		}
		rb.lastSegIdx.Store(writePos)
		rb.tracker.Set(segment.StartIdx, &segment)
		rb.segments <- segment
		return true
	}
	return false
}
```

**Time-triggered.** A `time.Ticker` fires every `flushInterval`
(default 30 s). If anything is sitting between `lastSegIdx` and
`writeIdx`, cut a segment regardless of size:

```go
// internal/buffer/ring_buffer.go (safety checks elided)
func (rb *RingBuffer) createTickerSegment() {
	writePos := rb.writeIdx.Load()
	lastSegPos := rb.lastSegIdx.Load()
	if writePos <= lastSegPos {
		return
	}
	segment := Segment{
		StartIdx: lastSegPos,
		EndIdx:   writePos,
	}
	rb.lastSegIdx.Store(writePos)
	rb.tracker.Set(segment.StartIdx, &segment)
	rb.segments <- segment
}
```

The ticker exists for the small-volume case. Without it, a Postgres
that gets 100 inserts and goes quiet would never cut a batch — those
events would sit in the ring forever and `lastAckedLSN` would never
advance, so the slot would hoard WAL. The ticker is what makes
"low-traffic, must still durably checkpoint" work.

The two paths cooperate: the size path resets the ticker on every cut,
so a busy Postgres effectively runs on size-triggered batches and a
quiet one falls back to time-triggered.

## Workers finish out of order

```go
// internal/buffer/ring_buffer.go (worker, abridged)
case segment := <-rb.segments:
	events := make([]*model.CDCEvent, 0, rb.batchSize)
	start := segment.StartIdx
	for start < segment.EndIdx {
		idx := start % rb.size
		if rb.buffer[idx] != nil {
			events = append(events, rb.buffer[idx])
		}
		start++
	}

	if len(events) > 0 {
		for i := range 3 {
			err := rb.processor.Process(ctx, events)
			if err == nil {
				break
			}
			log.Error().Err(err).Int("retry", i+1).Msg("Error processing segment")
			if i == 2 {
				log.Fatal().Err(err).Msg("Failed to process segment")
			}
			time.Sleep(time.Second * (2 << i))
		}
	}
	rb.ackSeg <- segment
```

N workers, all pulling from the same `rb.segments` channel. They
process in parallel. They **finish in any order**. Segment 3 might
beat segment 1 to S3 — illustrative example: segment 1 has 1,000 rows
of TOASTed JSONB taking ~`400 ms` to write to Parquet (TOAST means a
fetch from `pg_toast_*` per row, see the `<TOAST>` placeholder in
`tuple_decoder.go`); segment 3 has 1,000 rows of small ints taking
~`12 ms` (no TOAST, ZSTD-3 dominates).

This is exactly where the naive design starts losing data.

## The contiguous-ack walker

If we acked `lastSegIdx = 3.End` to Postgres the moment segment 3
completed, and segment 1 then crashed permanently before its retry
budget expired, segment 1's events would be on the floor. The
`confirmed_flush_lsn` on Postgres would be past them. They are gone.

The walker fixes this. State is a `haxmap[int64, *Segment]` keyed by
`StartIdx`. Workers send the segment to `rb.ackSeg` after `Process`
returns nil; the ack-pipeline goroutine consumes `ackSeg`, marks the
segment `done = true`, and walks forward over contiguous-done
segments only:

```go
// internal/buffer/ring_buffer.go
func (rb *RingBuffer) findHighestContiguous(segStartIdx, curReadIdx int64) int64 {
	s, ok := rb.tracker.Get(segStartIdx)
	if !ok {
		return curReadIdx
	}
	s.done = true
	if s.StartIdx == curReadIdx {
		cur := s
		for cur.done {
			rb.tracker.Del(cur.StartIdx)
			curReadIdx = cur.EndIdx
			next, ok := rb.tracker.Get(cur.EndIdx)
			if !ok {
				break
			}
			cur = next
		}
	}
	return curReadIdx
}
```

Two cases. **(a)** Segment finishing isn't the one at `readIdx`: mark
it done, return `readIdx` unchanged. **(b)** Segment finishing _is_
the one at `readIdx`: walk forward through the tracker, removing each
contiguous-done segment, until you hit a segment that isn't done
(stop) or you fall off the end (also stop). The new `readIdx` is the
`EndIdx` of the last contiguous-done segment.

When the walker advances, the LSN to ack is the LSN of the **last
event in the contiguous prefix**:

```go
// internal/buffer/ring_buffer.go (handleSegmentAck, log lines elided)
if highContiguous > previousReadIdx {
	rb.readIdx.Store(highContiguous)
	idx := (highContiguous - 1) % rb.size
	lastEvent := rb.buffer[idx]
	if lastEvent != nil {
		select {
		case rb.ackCh <- lastEvent.LSN:
		default:
			log.Warn().Msg("Ack channel is full, could not send LSN after contiguous advancement")
		}
	}
}
```

That `lastEvent.LSN` is the same `xLogPos = xld.WALStart + len(WALData)`
we computed back in section 3. It travels:

```
pgoutput → CDCEvent.LSN → ring slot → ack walker → ackCh → replicator.lastAckedLSN
                                                                      │
                                                      StandbyStatusUpdate
                                                                      ▼
                                                       pg_replication_slots.confirmed_flush_lsn
```

End to end, that LSN is only forwarded to Postgres after every
preceding event has been durably written to S3. Drop a worker mid-PUT,
crash, restart, and the `confirmed_flush_lsn` is exactly where the
last successful contiguous ack left it. Postgres replays from there.
No gaps.

## ASCII trace of out-of-order completion

Four segments dispatched at `t=0`. Workers complete in the order
`S2, S4, S1, S3`. Watch the walker:

```
time=0   tracker = { 0:S1(running), 1000:S2(running),
                     2000:S3(running), 3000:S4(running) }
         readIdx = 0,  lastAckedLSN = 0/0

t=12ms   S2 done.   tracker = { 0:S1, 1000:S2(done), 2000:S3, 3000:S4 }
         readIdx UNCHANGED (S1 not done) — no LSN sent.

t=15ms   S4 done.   tracker = { 0:S1, 1000:S2(done), 2000:S3, 3000:S4(done) }
         readIdx UNCHANGED.

t=400ms  S1 done.   walker fires from StartIdx=0:
                       0:S1     done → del, readIdx=1000
                       1000:S2  done → del, readIdx=2000
                       2000:S3  ?      stop (not done)
         readIdx = 2000
         ackCh ← buffer[(2000-1)%size].LSN  // last event of S2
         standby_status_update sent to Postgres.

t=420ms  S3 done.   walker fires from StartIdx=2000:
                       2000:S3  done → del, readIdx=3000
                       3000:S4  done → del, readIdx=4000
         readIdx = 4000
         ackCh ← buffer[(4000-1)%size].LSN  // last event of S4
         standby_status_update sent.
```

S2 and S4 each "finished early." Their LSNs were withheld. Only when
S1 cleared the queue did the walker emit one ack covering both S1 and
S2 in a single update. When S3 cleared, the second ack covered both
S3 and S4. **Two acks, four segments, in-order LSN advancement.**

Out-of-order completion + in-order ack is what makes this both
lock-free **and** correct. Drop the walker and you have to fall back
to sequential processing (no concurrency). Drop the contiguous
constraint and a worker crash mid-batch leaves a hole in S3 that
Postgres has already moved past — exactly the data-loss the CDC
contract forbids.

## Why no mutex

Three reasons. **(1)** The hot writer path (`Add`) has a single writer
goroutine (the receiver loop in `Start`), so its `writeIdx` mutation
is uncontended. **(2)** Workers read `buffer[i % size]` for
`i ∈ [StartIdx, EndIdx)`, and the producer never re-uses those slots
until `readIdx` has advanced past them — `Add` returns `false` while
`writeIdx - readIdx >= size`. So worker reads and producer writes are
always on disjoint ranges of `buffer`. **(3)** The tracker is a
concurrent map (`haxmap`). The receiver `Set`s a segment when it cuts
one; workers send the segment to `ackSeg` on completion (no shared
state mutation); a single ack-pipeline goroutine consumes `ackSeg`
and is the only writer of `s.done = true` inside `findHighestContiguous`.
One writer per field, no mutex needed.

## Tracker choice

`alphadose/haxmap` over `sync.Map` was a deliberate choice. `sync.Map`
optimizes for read-heavy "many readers, one writer" patterns and uses
a read-mostly atomic snapshot under the hood. Our pattern is
**balanced**: every segment is `Set` once, `Get` zero-or-many times by
the walker, then `Del`. `haxmap` is a lock-free, CAS-based hashmap
([source](https://github.com/alphadose/haxmap)) and reports `~3×`
over `sync.Map` on this access pattern in its
[README benchmarks](https://github.com/alphadose/haxmap#benchmarks)
(don't take a README at face value; the gap is real but
workload-dependent — derive your own with `go test -bench`).

# 5. Parquet that's small AND fast

Parquet is not one format. It's a compression and encoding _kit_ with
two dozen knobs. "I dumped my JSON to Parquet" is, on a busy lake,
the estimated difference between `~$400/month` and `~$4,000/month`
in S3 scan + storage on a 100 GB/day mutation stream — roughly the
spread between snappy-default-no-dict-no-sort and
ZSTD-3-with-dict-and-sorted, per the
[Parquet encoding spec](https://parquet.apache.org/docs/file-format/data-pages/encodings/)
plus codec micro-benchmarks in the
[zstd README](https://github.com/facebook/zstd#benchmarks). The
knobs in `internal/transform/parquet_writer.go` are **deliberate**.

```go
// internal/transform/parquet_writer.go
sorted := []parquet.SortingColumn{
	{ColumnIdx: 2, Descending: false, NullsFirst: false}, // timestamp
	{ColumnIdx: 3, Descending: false, NullsFirst: false}, // lsn
}
props := parquet.NewWriterProperties(
	parquet.WithDictionaryDefault(false),
	parquet.WithDictionaryFor("table", true),
	parquet.WithDictionaryFor("operation", true),
	parquet.WithEncodingFor("timestamp", parquet.Encodings.DeltaBinaryPacked),
	parquet.WithEncodingFor("lsn", parquet.Encodings.DeltaBinaryPacked),
	parquet.WithEncodingFor("before", parquet.Encodings.Plain),
	parquet.WithEncodingFor("after", parquet.Encodings.Plain),
	parquet.WithStats(true),
	parquet.WithStatsFor("before", false),
	parquet.WithStatsFor("after", false),
	parquet.WithPageIndexEnabledFor("timestamp", true),
	parquet.WithPageIndexEnabledFor("lsn", true),
	parquet.WithSortingColumns(sorted),
	parquet.WithCompression(compress.Codecs.Zstd),
	parquet.WithCompressionLevel(3),
	parquet.WithCreatedBy("wal-cake #pg"),
)
```

Each line is a tradeoff. Walked one by one:

| Setting | Choice | Why |
|---|---|---|
| Codec | ZSTD level 3 | Sweet spot for CDC payloads. Per [zstd benchmarks](https://github.com/facebook/zstd#benchmarks): several times faster than gzip at a comparable ratio, and tighter than snappy. Higher ZSTD levels (10+) trade order-of-magnitude more CPU for single-digit-percent size gains. |
| Dict for `table`, `operation` | yes | Low cardinality on both (10s of tables; 3 ops in Parquet — `insert`/`update`/`delete`; `commit` is filter-excluded). Dict beats per-row string storage decisively. |
| Dict default | OFF | Avoids overhead for high-cardinality JSON/timestamp/LSN columns where dict would just bloat the file. |
| `timestamp` encoding | DELTA_BINARY_PACKED | Microsecond timestamps are monotonic in WAL order. DELTA_BINARY_PACKED stores `t[0]`, then `(t[i] - t[i-1])` packed at the minimum bit-width — typically 1–2 bytes/row instead of 8. |
| `lsn` encoding | DELTA_BINARY_PACKED | LSN is also monotonic. Same trick, same ~75% savings on the column. |
| Sorting columns | `(timestamp, lsn)` | Lets readers (Athena, Trino, DuckDB) skip whole pages on time-range predicates via the page index. Sort order is a header field, but it's only true if you actually wrote the rows in that order — which our ring buffer's contiguous-LSN guarantee gives us for free. |
| Page index for ts, lsn | enabled | Without page index, pushdown prunes whole row groups only (each batch is one row group, so a `WHERE timestamp BETWEEN …` query reads the file or skips it whole). Page index lets the reader skip individual data pages, scanning only time-overlapping pages. |
| Stats for `before`, `after` | OFF | These are JSON-as-bytes columns. Min/max on raw JSON bytes is meaningless to a reader and costs CPU during write. |
| `before`, `after` type | `JSONLogicalType` over `BYTE_ARRAY` | The physical type is bytes; the logical-type annotation tells Athena, DuckDB, Spark to treat it as JSON. You preserve schema flexibility (every event's `before/after` shape can differ) without lying to the reader. |
| Encoding for `before`, `after` | Plain | JSON bytes don't dictionary-compress well (every blob is unique-ish). With high cardinality, the dictionary itself ends up nearly as big as the data — no win, plus an index-lookup cost per row. Plain + ZSTD page compression beats dict + ZSTD. |
| `WithCreatedBy("wal-cake #pg")` | string in the file footer | Forensics. When a downstream warehouse engineer asks "who wrote these files?", `parquet-tools meta` shows the producer string. |

Schema construction is `JSONLogicalType`-aware:

```go
// internal/transform/parquet_writer.go
beforeNode, err := schema.NewPrimitiveNodeLogical(
	"before",
	parquet.Repetitions.Required,
	schema.JSONLogicalType{},
	parquet.Types.ByteArray,
	-1,
	-1,
)
```

A `parquet-tools meta` snippet on a representative wal-cake file
(real layout, hand-formatted):

```
$ parquet-tools meta default/2026/05/09/1778328000000000.zstd.parquet
file:        default/2026/05/09/1778328000000000.zstd.parquet
creator:     wal-cake #pg
extra:       {}
file schema: schema
--------------------------------------------------------------------
table:       REQUIRED BYTE_ARRAY (UTF8)        ENCODING:RLE_DICTIONARY
operation:   REQUIRED BYTE_ARRAY (UTF8)        ENCODING:RLE_DICTIONARY
timestamp:   REQUIRED INT64 (TIMESTAMP_MICROS) ENCODING:DELTA_BINARY_PACKED
lsn:         REQUIRED INT64                    ENCODING:DELTA_BINARY_PACKED
before:      REQUIRED BYTE_ARRAY (JSON)        ENCODING:PLAIN
after:       REQUIRED BYTE_ARRAY (JSON)        ENCODING:PLAIN
sort cols:   timestamp ASC, lsn ASC
row group 0: RC:1000  TS:184_322
  table:        SIZE:412      (dict+ZSTD reduces 1000 short-string column to <1 KB)
  operation:    SIZE:78
  timestamp:    SIZE:1_842    (DELTA_BINARY_PACKED + ZSTD)
  lsn:          SIZE:1_904
  before:       SIZE:48_120   (JSON + ZSTD)
  after:        SIZE:131_966
```

(Numbers above are illustrative — ratios from a `~200 B/event` CDC
shape, not a single file from this codebase. Treat bytes as
approximate.)

Two columns dominate: `before` and `after`. Everything else is in the
noise — `table` and `operation` together are
`(412 + 78) / 184,322 ≈ 0.3%` of the file's total bytes (computed
from the illustrative `parquet-tools meta` row-group sizes above).
The moral: **stop optimizing the small columns and optimize your
JSON**. Which leads to the next decision.

## go-json over encoding/json

Commit `72bbcae` swapped `encoding/json` for `goccy/go-json`:

```go
// internal/transform/parquet_writer.go
"github.com/goccy/go-json"
// ...
beforeJson, err := json.Marshal(ev.Before)
if err != nil {
    return fmt.Errorf("marshal CDC before data to JSON: %w", err)
}
```

`encoding/json` uses reflection on every call, builds an internal
`reflect.Type → encoder` cache the first time it sees a type, and
synchronizes that cache. On the small `map[string]any` we marshal
per row, the reflection overhead dominates. `goccy/go-json` uses
`unsafe`-based type erasure plus per-type generated encoders; the
[benchmarks][gojson-bench] in the repo show `2–4×` on small
heterogeneous maps. On a `1,000`-event batch the JSON marshalling
step is on the worker hot path the LSN walker is waiting for, so
that 2-4× compounds across every batch.

[gojson-bench]: https://github.com/goccy/go-json#benchmarks

Pick the JSON encoder before you pick the Parquet codec.

## Date-partitioned writes

The processor splits each batch by `Date()` (truncated to UTC day):

```go
// internal/buffer/processor.go
// Events are from the same day
if events[0].Date().Equal(events[len(events)-1].Date()) {
	return p.Upload(ctx, events)
}

curDate := events[0].Date()
left, right := 0, 0
for right, e := range events {
	nextDate := e.Date()
	if !nextDate.Equal(curDate) {
		if err := p.Upload(ctx, events[left:right]); err != nil {
			return err
		}
		curDate = nextDate
		left = right
	}
}

return p.Upload(ctx, events[left:right+1])
```

The fast-path same-day check (commit `f3a95a7`, "Avoid partition logic
if all events same day") is the common case — a 30-second batch
almost never spans midnight. The slow path matters once a day, for
exactly one batch.

S3 keys carry the partition:

```go
// internal/buffer/processor.go
func (p *ParquetBatchProcessor) generateS3Key(timestamp time.Time) string {
	key := fmt.Sprintf("%s/%s/%d.%s.parquet",
		p.config.Namespace,
		timestamp.Format("2006/01/02"),
		timestamp.UnixMicro(),
		p.transformer.GetCompressionCodec(),
	)
	return key
}
```

Output: `myapp/2026/05/09/1715251200000000.zstd.parquet`. Hive-style
`year=YYYY/month=MM/day=DD/` would let Athena auto-discover
partitions; the slash form requires `MSCK REPAIR TABLE` or explicit
`ALTER TABLE ... ADD PARTITION`. Trade-off: shorter keys, simpler
S3 list ops, manual partition registration. On data-lake setups where
a Glue crawler runs nightly, this is fine.

# 6. S3 upload — the boring-but-critical bit

Two screens of code, one design decision:

```go
// internal/storage/s3_uploader.go
func (u *s3Uploader) UploadBytes(ctx context.Context, key string, data []byte) error {
    _, err := u.client.PutObject(ctx, &s3.PutObjectInput{
        Bucket: aws.String(u.bucket),
        Key:    aws.String(key),
        Body:   bytes.NewReader(data),
        ACL:    types.ObjectCannedACLPrivate,
    })
    if err != nil {
        return fmt.Errorf("uploaded bytes to S3: %w", err)
    }
    return nil
}
```

**One PUT per batch**, no multipart. The reasoning is small. A typical
wal-cake batch is `batchSize=1000` events × ~200 B/event uncompressed
JSON = 200 KB pre-Parquet, ~30–50 KB post-Parquet+ZSTD. S3 multipart's
[minimum part size is 5 MB](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)
(except the last) — sub-MB objects can't usefully be split. A single
PUT also avoids the three multipart round trips (`CreateMultipartUpload`,
N × `UploadPart`, `CompleteMultipartUpload`) for no parallelism gain
at this size.

Idempotency comes from the key. The `Timestamp.UnixMicro()` of the
last event in the batch (set in the replicator at decode time) is
near-monotonic in practice — modulo wall-clock adjustments — and
contiguous-LSN ordering guarantees no later-LSN batch is uploaded
before any earlier-LSN batch. A PUT retry uses the same key; S3 PUT
is last-write-wins, so identical key + identical bytes overwrites
with the same content. If the process crashes mid-PUT and restarts,
the LSN walker hasn't acked yet — on resume the same events are
replayed under a **different** key (the ts is now slightly later).
So we do double-write data, but **read-side dedup** is trivial: rows
are uniquely identified by `(table, lsn, operation)`. For exactly-once
on the lake side instead, the upgrade path is Apache Iceberg with
`(min_lsn, max_lsn)` per-file metadata.

## MinIO for local dev

```go
// internal/storage/s3_uploader.go
endpoint := os.Getenv("AWS_ENDPOINT")
if u.endpoint != "" {
    o.BaseEndpoint = aws.String(u.endpoint)
    o.UsePathStyle = true   // required for MinIO
}
```

The `AWS_ENDPOINT` override + `UsePathStyle: true` is the standard
two-line MinIO recipe. `docker-compose.yml` in the repo wires it up.
Run `docker compose up -d`, point `AWS_ENDPOINT=http://localhost:9000`,
and the same binary that ships to AWS writes to local MinIO. No code
branches, no test mocks for S3.

# 7. Throughput math

Back-of-envelope for a single wal-cake instance with default config
(`batchSize=1000, concurrency=4, flushInterval=30s`):

**Upstream ceiling.** Postgres' WAL flush rate is the upstream limit.
The 1B-payments post measured Apple Silicon NVMe `fdatasync()` at a
weighted-average `163 µs`, with 100% under `512 µs`[^fsync] —
that's `1 / 0.000163 ≈ 6,135` fsyncs/sec at the average and
`~2,000` fsyncs/sec at the worst-case tail. Group commit batches
many WAL records per fsync, so a typical OLTP cluster with
`commit_delay=200µs` pushes `5k–20k` row-mutations per second on
the WAL stream. Call it **10k events/sec** as a reasonable
mid-range.

**Decoding cost.** pgoutput Text-mode decoding in
`internal/replication/tuple_decoder.go`'s `extractTuple` is dominated
by `make(map[string]any)` + a `strconv.ParseInt`/`ParseFloat` per
column. Both are well-trodden Go allocation patterns. Take
`~5 µs/column` as a back-of-envelope; a real `go test -bench` on
the decoder would refine it. For a 5-column row that's
`5 × 5 µs ≈ 25 µs`. At `10,000 events/sec` the decoder uses
`10,000 × 25 µs = 250,000 µs/sec = 0.25 s of CPU per wall-second`
on the replicator goroutine — one core at 25%. Headroom is fine;
it's not the bottleneck.

**Ring buffer admission.** `Add` is ~50 ns (one atomic load, one
slice store, one atomic add). 10k events/sec is 500 µs/sec on the
receiver goroutine — 0.05%. Free.

**Parquet+ZSTD writes.** Estimated on a single core, ZSTD-3 +
arrow-go writes 1,000-event batches in `~10–25 ms` depending on JSON
size (allocation-dominated; assumes `~30–50 KB` post-compress per
batch and ZSTD-3 single-thread throughput in the
[~500–700 MB/s range](https://github.com/facebook/zstd#benchmarks)).
With concurrency 4 and a per-batch wall time of `~20 ms`, the
upper bound is `4 / 0.020 s = 200 batches/sec`, i.e.
`200 × 1,000 = 200,000 events/sec` of Parquet capacity. Comfortably
over-provisioned for the upstream rate; Parquet is not the
bottleneck.

**S3 PUTs/min — busy case.** At sustained `10,000 events/sec`, the
size trigger fires at every `1,000`-event boundary, i.e. every
`1,000 / 10,000 = 0.1 s`. That's `1 / 0.1 = 10 batches/sec` of cuts,
each a separate PUT. The 30-s ticker is *the cap on quiet-time
delay*, not the busy-case cadence — when a size cut happens it
resets the ticker (see `rb.ticker.Reset(rb.tickInterval)` in
`internal/buffer/ring_buffer.go`). So the busy steady-state is:

```
10 PUT/sec × 60 sec/min                = 600 PUT/min
600 × 60 min/hr × 24 hr/day × 30 day/mo
   = 600 × 43,200 = 25,920,000 PUT/mo  ≈ 26M PUT/mo
26M × ($5 / 1M PUT)                    ≈ $130/month  (PUT cost)
```

Plus storage. Estimated `~30 KB/Parquet × 26M files = 780 GB/month`
of new data — at the S3 Standard
[$0.023/GB-month](https://aws.amazon.com/s3/pricing/) tier, the
month-1 storage delta is `780 × $0.023 ≈ $18/month` of *new* bytes
(cumulative storage grows month-over-month). Steady-state monthly
S3 spend at `10k events/sec` sustained: `~$148/month new`
(`$130` PUT + `$18` storage delta). Half the cost is reducible by
larger `batchSize`: bumping `batchSize` from `1,000` to `10,000`
cuts PUT count by `10×` and per-month PUT spend to `~$13`, at the
price of `10×` worst-case batching latency.

**S3 PUTs/min — quiet case.** The crossover where the ticker beats
the size trigger is `batchSize / flushInterval = 1,000 / 30 ≈ 33
events/sec`. Below it the ticker wins (`60 / 30 = 2 PUT/min`,
`~$0.43/month`). At `100 events/sec` the size trigger wins, firing
every `1,000 / 100 = 10 sec` for `60 / 10 = 6 PUT/min` (`~$1.30/month`).
The size trigger also resets the ticker, so wal-cake never cuts twice
within a single batch's worth of events.

**Where the upper limit lives.** Push events/sec to `100,000` and
the Parquet+ZSTD math still works (`4 × 50 = 200 batches/sec` of
ceiling), but the WAL itself becomes the issue. At `100,000`
row-mutations/sec on typical OLTP rows, each WAL insert record is
~`120` bytes (24-byte XLogRecord header per the
[Postgres WAL docs](https://www.postgresql.org/docs/current/storage-page-layout.html#STORAGE-PAGE-LAYOUT-XLOG-RECORD)
+ a small heap tuple); you're generating roughly
`100,000 × 120 = 12,000,000 B/sec ≈ 12 MB/sec` of WAL. Postgres'
default WAL segment size is `16 MB` (see
[`pg_controldata`](https://www.postgresql.org/docs/current/app-pgcontroldata.html)
and `wal_segment_size`), so `pg_wal/` recycles segments every
`16 / 12 ≈ 1.3 s`. The `wal_writer` saturates; `fdatasync()` on the
WAL becomes the floor. That's the upstream wall, not anything
wal-cake can do about. The 1B-payments post discusses this floor in
detail.

[^fsync]: [1B Payments/Day — Watching fsync in real time](https://backend.how/posts/1b-payments-per-day/#watching-fsync-in-real-time) — measured weighted-average `fdatasync()` of `163 µs` (`97%` under `256 µs`, `100%` under `512 µs`) and `4.17M` fsync calls for `10M` Postgres inserts on a Mac Mini M4.

# 8. What I'd change

Honest list. Three I'd actually do, ordered by impact-per-effort.

**Apache Iceberg over raw Parquet.** We write naked Parquet into key
prefixes and rely on Glue/Athena/Trino to reconstruct "the table."
Iceberg layers a manifest + metadata-pointer chain: schema evolution
is metadata-only, `SELECT … AS OF TIMESTAMP …` is free, and
exactly-once becomes a format property (manifest commits are atomic
via S3 conditional-put). Cost: one extra write per batch and a
metadata-store dependency. The right tradeoff once more than a
handful of consumers read the lake.

**Per-table Parquet streams.** One file mixes events from many
tables. A query for "all changes to `users` last week" scans every
wal-cake file in that week with a `WHERE table='users'` predicate.
Per-table partitioning (`namespace/table/2026/05/09/...parquet`)
turns the predicate into a path prefix; Athena scans 1/N of the
bytes for N tables. Implementation cost: per-(table, day) sub-batches
and the LSN-contiguity guarantee gets trickier across them. A
per-table secondary ring with the global LSN walker as the authority
is one workable shape.

**Schema registry for `before`/`after`.** JSON-as-bytes makes every
reader pay JSON-parse per row. A typed schema (Avro or Confluent
Schema Registry + per-table Parquet `STRUCT<col1: type1, ...>`
columns) would let warehouses scan typed columns directly with
predicate pushdown. Cost: schema evolution is now a coordination
problem between Postgres DDL and the registry. Worth it for
high-value tables; for "change log of everything," JSON-as-bytes
is pragmatic.

Two more I'd consider but probably wouldn't ship in v1:

- **Direct columnar buffer (skip JSON round-trip).** We decode
  pgoutput → `map[string]any` → `json.Marshal` → `byte[]` → Parquet
  `BYTE_ARRAY`. A more efficient pipeline decodes pgoutput directly
  into Arrow column builders. The throughput estimated above
  (`200,000 events/sec` Parquet ceiling vs `10,000 events/sec`
  mid-range upstream = `200,000 / 10,000 = 20×` headroom) means this
  isn't the current bottleneck. File it under "if profiling ever
  shows JSON encoding on the hot path."

# Where this leaves us

The naive outbox-and-cron CDC works for a quarter and breaks for two.
The lock-free version replaces three of its four moving parts:

| Naive                          | wal-cake                                |
|---|---|
| App dual-writes outbox row     | Postgres dual-writes WAL (it already did) |
| Cron polls `WHERE NOT processed` | pglogrepl streams pgoutput |
| `UPDATE … SET processed=true`  | StandbyStatusUpdate moves slot LSN |
| JSON files on S3               | ZSTD Parquet sorted by (ts, lsn) |

The three things this post called out at the top:

1. The replication loop reads pgoutput at the byte level and never
   forwards an LSN it hasn't durably written downstream.
2. The ring buffer ack-walks only contiguous-completed segments,
   making concurrent S3 writes safe for in-order LSN ack.
3. The Parquet writer uses dict for low-cardinality columns, delta
   encoding for monotonic LSN/timestamp, JSON-typed bytes for
   open-ended payloads, and ZSTD-3 page compression on every column.

None of these are novel ideas. Logical replication has been in
Postgres [since 9.4 (December 2014)](https://www.postgresql.org/docs/9.4/release-9-4.html).
Lock-free ring buffers go back to
[the LMAX Disruptor (2011)](https://lmax-exchange.github.io/disruptor/disruptor.html).
Parquet encoding tradeoffs are documented in the
[format spec](https://parquet.apache.org/docs/file-format/data-pages/encodings/).
The interesting work is putting the three together so that no one of
them sneaks past the CDC contract while the other two were looking
the other way.

The spec was two lines. The implementation is `~1,800`. Most of
the bytes between the two are saying _no_ to the obvious thing.

# Further reading

- [Postgres Logical Decoding plugins](https://www.postgresql.org/docs/current/logicaldecoding-output-plugin.html) — the official protocol description for `pgoutput`.
- [`pglogrepl`](https://github.com/jackc/pglogrepl) — Jack Christensen's Go client; what wal-cake builds on.
- [Apache Parquet format spec](https://parquet.apache.org/docs/file-format/) — the encodings, page index, and sorted column semantics referenced above.
- [LMAX Disruptor](https://lmax-exchange.github.io/disruptor/disruptor.html) — the canonical lock-free ring buffer paper. Different access pattern (multi-producer, single-consumer) than wal-cake's, same underlying ideas.
- [1B Payments/Day](https://backend.how/posts/1b-payments-per-day/) — fsync floor and io_uring numbers cited throughout this post.
- [Temporal — Under the Hood](https://backend.how/posts/temporal-under-the-hood/) — same dissection style applied to durable execution.

---

_PostgreSQL® is a trademark of The PostgreSQL Global Development Group.
Apache® and Parquet™ are trademarks of the Apache Software Foundation.
Amazon S3® is a trademark of Amazon Web Services. This post is an
independent engineering write-up — it is not affiliated with or
endorsed by any of these projects. All trademarks belong to their
respective owners._

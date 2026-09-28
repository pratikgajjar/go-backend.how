+++
title = "🧁 WAL Cake: Ordered ACKs from Parallel S3 Uploads"
description = "How WAL Cake reads the Postgres WAL in order, uploads Parquet files to S3 in parallel, and uses one ring buffer to keep the replication slot ACK in order."
date = 2026-09-28T08:00:00+05:30
lastmod = 2026-09-28T08:00:00+05:30
publishDate = "2026-09-28T08:00:00+05:30"
draft = false
tags = ["postgres", "cdc", "parquet", "golang", "data-lake", "wal", "s3"]
images = ["og-feae11dd.png"]
theme = "moss"
featured = true
math = false
hide_toc = true
+++

WAL Cake is a Go service that copies row changes from Postgres to Parquet
files in S3, one folder per day, to build a data lake. Postgres sends those
changes as one ordered stream, and expects one ordered answer: a single
position that says "everything before this is safe". Both ends are sequential.
The slow work in between, encoding Parquet and uploading to S3, does not have
to be. This post shows how WAL Cake runs that middle part in parallel while it
still reads and acknowledges the WAL in order, how it is tested, and where it
can still replay or stall.

I wrote most of WAL Cake, and we ran it in production at a large Indian fintech
company. Everything in this post refers to commit
[`300e7ab`](https://github.com/pratikgajjar/wal-cake/tree/300e7abe41d4e8573657910cd51de65ebbc1d905).
The benchmarks ran on an Apple M3 Max with Go 1.26.5, and the integration
tests against Postgres 18.

# Terms

If you already know Postgres logical replication, skip to [the
rule](#the-rule).

- **WAL** (write-ahead log): Postgres records every change in this log before
  it writes the change to the table files.
- **LSN** (log sequence number): a byte position in the WAL. A higher LSN
  means a later change.
- **Replication slot**: a bookmark in the WAL for one consumer. Postgres keeps
  the WAL that the consumer still needs, so it can resume after a crash.
- **`confirmed_flush_lsn`**: the slot's bookmark. The consumer moves it by
  sending an LSN back to Postgres. This message is the **ACK**. On restart,
  Postgres does not resend transactions that committed before this position.
- **pgoutput**: the built-in plugin Postgres uses to stream row changes to a
  consumer.
- **CDC** (change data capture): reading these row changes and copying them to
  another system.
- **Parquet**: a columnar file format used by data lakes.

The figures use one colour code: black is structure, brown is data, green is
durable, red is a problem, purple is the part to look at, blue is an option,
and orange is the option we chose.

# The rule

WAL Cake builds the raw layer of a data lake. It reads committed row changes,
writes them to S3 as Parquet files, and tells Postgres which WAL it can delete.
Files are split by the UTC day each transaction committed: each file holds rows
from one day only, under a `YYYY/MM/DD` prefix. A query or a daily job for one
day reads one prefix, and never has to filter out rows from the day before or
after.

Postgres and S3 each keep data safely, but they do not know about each other.
A row is safe in Postgres after commit. A file is safe in S3 after `PutObject`
returns. Between them, WAL Cake holds rows only in memory. If it crashes,
Postgres must still have every row that is not yet in S3. So the consumer must
follow one rule:

**Advance the slot only past rows that are already in S3.**

# Existing options

{{< walviz kind="options" fig="1" title="Options for copying Postgres changes to S3" fallback="pipeline.svg" alt="Four options for copying Postgres changes to S3 as Parquet, with benefits, costs, and the one WAL Cake chose" >}}

Every option has to follow the same rule. They differ in which system keeps
track of the slot position, and in how much control you get over the files.

- **Debezium with Kafka Connect** reads pgoutput[^debezium-pg] and stores its
  position in Kafka. An S3 sink connector writes the files and can partition
  them by time. This is a good fit if you already run Kafka.
- **Debezium Server** runs without Kafka[^debezium-server]. It has sinks for
  Kinesis, Pub/Sub, HTTP, and more, and a community-maintained Iceberg sink,
  but no sink for plain Parquet files in S3.
- **AWS DMS** is a managed service that writes Parquet to S3 and can put files
  in folders by transaction commit date[^dms]. You configure it instead of
  writing code, and you run a replication instance.
- **Direct pgoutput** is what WAL Cake does. One Go process reads pgoutput,
  batches rows, writes Parquet, and uploads it.

We chose direct pgoutput because we wanted day-split Parquet files from one Go
binary, without a broker or a replication instance, and with control over batch
size and the ACK. In exchange, we own reconnects, backpressure, and the ACK.
This post is about the ACK.

# Why one upload at a time is too slow

The simplest correct consumer does this in a loop:

1. Encode a batch of rows as Parquet.
2. Upload it to S3 and wait.
3. Send the batch's last LSN to Postgres.

This follows the rule, because nothing is confirmed before it is in S3. The
problem is step 2. The worker does nothing while it waits for S3, so upload
latency sets the throughput.

An S3 PUT from inside the same region usually takes tens to a few hundred
milliseconds. One public benchmark of 500 KB PUTs measured a median of 70 ms
and a p99 of 137 ms[^s3bench]. The estimate below uses 100 ms:

```txt
B = events per batch             1,000    (default)
E = Parquet encode time          0.0012 s (benchmark below)
P = S3 PUT time                  0.100 s  (assumed)
R = incoming events per second   10,000

one worker handles   B / (E + P)       = 1,000 / 0.1012      ≈ 9,881 events/s
workers needed       ceil(R × (E+P)/B) = ceil(10,000 × 0.1012 / 1,000) = 2
```

At 100 ms, one worker handles about 9,900 events/s, so at 10,000 events/s the
backlog grows by about 120 events every second and never shrinks. At 200 ms,
three workers are needed. The worker count is a setting; the default is
four[^defaults]. Use the figure below to try other values.

{{< walviz kind="sizing" fig="2" title="How many workers?" fallback="s3-concurrency.svg" alt="Workers needed across S3 PUT latency and input rate" caption="Each grey band is one worker count from `ceil(R × (E + P) / B)`. The orange curve is the capacity of the workers you run. Move the cursor to evaluate any point, or change `B` and `E` to move the bands." >}}

This is an upper bound: it assumes full batches and no retries. More workers do
not make a single upload faster. They let other uploads run while one waits.

# Where the parallelism can go

The WAL has to be read in order, and the ACK has to be sent in order. So which
part of the pipeline can run in parallel? Look at each step:

- **Reading** is one stream. Only one connection can read from a replication
  slot at a time[^logical], and Postgres sends each transaction after it
  commits, in commit order. You could create one slot per group of tables and
  read them in parallel. But each slot decodes the whole WAL on the Postgres
  server, you lose ordering across tables, and you have more slots to monitor.
- **Parsing and decoding** are fast. WAL Cake parses a pgoutput insert and
  turns five columns into a Go map in about 0.5 µs, so 1,000 rows take about
  0.5 ms.
- **Encoding and uploading** the same 1,000 rows take about 101 ms with the
  numbers above. Almost all of it is waiting for S3.
- **The ACK** is one number, sent on the same replication connection.

So WAL Cake keeps one reader and one ACK, and runs only encode and upload in
parallel:

```txt
one reader  →  cut into segments  →  N workers: encode + upload  →  one ACK
(in order)                           (finish in any order)           (in order)
```

This is Amdahl's law in practice. Per 1,000 rows, the serial part takes about
0.5 ms and the parallel part about 101 ms, so the serial part is about 0.5% of
the work. In theory, the single reader only becomes the limit at around 200
workers. In practice, other limits come first: memory per worker, and the
walsender, the single Postgres process that decodes the slot. I have not
measured the walsender's ceiling. The 0.5 µs is for a short five-column row;
wider rows cost more.

The hard part is the last arrow: turning results that finish in any order back
into one ordered ACK.

# Parallel uploads break the ACK

Take four batches that start uploading in WAL order `S1`, `S2`, `S3`, `S4`,
and finish in the order `S2`, `S4`, `S1`, `S3`.

The ACK is a single LSN, and it confirms everything before it[^protocol].
Postgres cannot accept "`S2` and `S4` are done, `S1` and `S3` are not." If the
consumer sends the end of `S4`, it also confirms `S1` and `S3`. If the process
crashes at that moment, Postgres will not send `S1` and `S3` again, and S3
does not have them. Those rows are lost.

So uploads can finish in any order, but the ACK must only move forward in
order.

# The fix: ACK only a contiguous prefix

Keep a cursor at the oldest batch that is not yet in S3. When a batch finishes,
mark it done. If it is the batch at the cursor, move the cursor forward over it
and every done batch directly after it. Stop at the first batch that is not
done. Send the LSN at the new cursor.

With the example above:

```txt
finishes   done so far        cursor stops before   ACK covers
S2         S2                 S1                    nothing new
S4         S2, S4             S1                    nothing new
S1         S1, S2, S4         S3                    S1, S2
S3         S1, S2, S3, S4     (end)                 S3, S4
```

To do this, the consumer needs three things:

1. A place to keep each row after a worker takes it, until all earlier batches
   are in S3. The ACK needs the LSN of the last row in the finished run.
2. A list of every batch boundary, written before any worker starts. Without
   it, the consumer cannot tell a slow batch from a missing one.
3. A cursor that only moves forward and never skips a batch that is not done.

A Go channel cannot do (1), because it forgets an item once it is received.
WAL Cake uses a fixed-size ring of event pointers for (1), a small map of batch
ranges for (2), and an atomic index for (3). A ring fits because its slots are
freed in the same order that the cursor moves.

The figure below follows one `INSERT` through the whole system, from commit to
the ACK that lets Postgres delete its WAL.

{{< walviz kind="map" fig="3" title="Follow one row" follow="true" fallback="pipeline.svg" alt="WAL Cake system map: data path from Postgres to S3 and the ACK path back" caption="One `INSERT` from commit to `confirmed_flush_lsn`. Hex bytes follow the pgoutput format. LSNs, keys, and times are sample values." >}}

The components are connected in `cmd/cake/main.go`:

```go
// cmd/cake/main.go (abridged)
eventsCh := make(chan *model.CDCEvent, cfg.BatchSize*cfg.Concurrency)
acked := &ack.Position{} // highest LSN that is durable in S3

repl := replication.NewPGReplicator(cfg)
processor := buffer.NewParquetBatchProcessor(transformer, uploader, bpCfg)
rb := buffer.NewRingBuffer(cfg.BatchSize, cfg.Concurrency,
    cfg.FlushInterval, processor, acked)

replCtx, stopRepl := context.WithCancel(context.Background())
go repl.Start(replCtx, eventsCh, acked)

rb.Start(ctx, eventsCh) // until SIGTERM, then drains
stopRepl()              // the replicator sends the final ACK
```

This gives at-least-once delivery, not exactly-once. No transaction covers both
Postgres and S3. If the process crashes after an upload and before the ACK,
the file is in S3 but the slot has not moved, so Postgres sends those rows
again. [Figure 6](#the-s3-upload-and-its-key) shows what that does to the
bucket.

# Reading pgoutput

{{< walviz kind="map" focus="pg,rep,evc" wide="false" fallback="pipeline.svg" alt="System map with Postgres, the replicator, and eventsCh highlighted" >}}

The replicator opens a `?replication=database` connection and streams from the
slot's `confirmed_flush_lsn`[^slots]. A short-lived normal connection runs the
publication and slot queries first. Each `XLogData` frame becomes at most one
event:

```go
// internal/replication/pg_replicator.go (abridged)
xld, err := pglogrepl.ParseXLogData(data[1:])
if err != nil {
    return fmt.Errorf("parse XLogData: %w", err)
}
logicalMsg, err := pglogrepl.Parse(xld.WALData)
if err != nil {
    return fmt.Errorf("parse logical replication message at %s: %w", xld.WALStart, err)
}
return r.proccessLogicalMsg(ctx, logicalMsg, xld.WALStart, ch)
```

Every event carries an LSN, and the ring may later send any of them as the ACK.
So each one must be safe to confirm once the event and everything before it is
in S3:

- A **row event** carries `WALStart`, the LSN of its change record. If the ACK
  lands there, in the middle of a transaction, Postgres resends that whole
  transaction after a restart. Some rows arrive twice, and none are lost.
- A **commit event** carries `TransactionEndLSN`, the end of the commit record.
  The next transaction's commit record starts at or after it, so confirming it
  never covers the next transaction.

`WALStart + len(WALData)` is the right position in physical replication, where
`WALData` is WAL bytes. In logical replication `WALData` holds pgoutput bytes,
so the sum is not a WAL position. For a commit it points 26 bytes past the end
of the record. When the next transaction commits right after, that lands inside
its commit record, and Postgres would skip that transaction on restart.

Commit events go into the ring, so a finished run can end on a commit. The
Parquet writer skips them.

A few pgoutput details[^msgformats]:

- A `BEGIN` message carries the transaction's commit timestamp. Every event in
  the transaction gets it as `CommitTime`, which picks the day folder.
- A `RelationMessage` describes a table and its columns. Row messages refer to
  it by ID.
- For updates and deletes, the old row depends on the table's replica
  identity. `K` means only the key columns are sent, `O` means the full old
  row.
- A large (TOASTed) value that did not change is sent as a marker, not a value.
  WAL Cake writes the string `"<TOAST>"` for it.

Any error ends the session: a lost connection, a server error, a failed status
update, or a message that does not parse. The replicator reconnects with
backoff from 1 to 30 seconds and resumes from `confirmed_flush_lsn`, so nothing
is skipped. The readiness check passes only while a session is streaming and
event delivery has not been blocked for more than a minute.

# The ring buffer

Two types move through the pipeline:

```go
// internal/model/cdc_event.go
type CDCEvent struct {
    Table      string         `json:"table"`
    Operation  Operation      `json:"op"`
    Before     map[string]any `json:"before,omitempty"`
    After      map[string]any `json:"after,omitempty"`
    Timestamp  time.Time      `json:"timestamp"`   // decode time
    CommitTime time.Time      `json:"commit_time"` // from BEGIN
    LSN        uint64         `json:"lsn"`
}

// internal/buffer/ring_buffer.go
type Segment struct {
    StartIdx int64 // Start index in the ring buffer
    EndIdx   int64 // End index in the ring buffer
    done     bool
}
```

A `CDCEvent` is one row change and its LSN. A `Segment` is a batch: the range
`[StartIdx, EndIdx)` of positions in the ring. The rest of the post uses
"segment" for a batch.

The ring has a fixed array, three counters, a tracker, and three channels:

```txt
buffer      fixed array of *CDCEvent
writeIdx    next position to write
lastSegIdx  end of the last segment sent to workers
readIdx     end of the finished prefix (the cursor)
tracker     map: StartIdx → segment, guarded by a mutex
segments    channel: segments going to workers
ackSeg      channel: finished segments coming back
space       channel: wakes the writer when readIdx moves
```

The three counters only increase. Only the array index wraps, using
`index % size`. Because of this, the ring is full exactly when
`writeIdx - readIdx >= size`.

At any moment, the positions fall into four ranges:

```txt
[0, readIdx)             done; slots can be reused
[readIdx, lastSegIdx)    sent to workers: waiting, running, or done behind a gap
[lastSegIdx, writeIdx)   written, not yet in a segment
[writeIdx, readIdx+size) free
```

## Writing to the ring

{{< walviz kind="map" focus="evc,ring" wide="false" fallback="pipeline.svg" alt="System map with eventsCh and the ring highlighted" >}}

One goroutine reads `eventsCh` and calls `Add`. It is the only writer, so it
does not need a mutex:

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

If the ring is full, `Add` returns false and does not overwrite anything. The
goroutine waits on `space` until the walker moves `readIdx`. While it waits,
`eventsCh` fills up and the replicator blocks. No data is lost, but replication
pauses until uploads finish.

The ring holds `2 × workers × batch` events: 8,000 pointers, or 64 KB, with the
defaults. Half of that is what the workers hold at once. The other half lets
the writer fill the next segments while every worker is busy. This limits the
number of events, not their size: one large JSONB value can still use a lot of
memory.

## Sending segments to workers

{{< walviz kind="map" focus="ring,seg,wrk" wide="false" fallback="pipeline.svg" alt="System map with the ring, the segments channel, and the workers highlighted" >}}

The same goroutine creates a segment when 1,000 events are waiting. When
traffic is low, a `30 s` timer creates a smaller one, so a few events do not
wait forever and hold WAL in the slot. The segment is added to `tracker`
before it is sent:

```go
// internal/buffer/ring_buffer.go (logging elided)
segment := Segment{StartIdx: lastSegPos, EndIdx: writePos}
rb.lastSegIdx.Store(writePos)
rb.tracker.Set(segment.StartIdx, &segment)
rb.segments <- segment
```

This order matters. Because every segment is in `tracker` before any worker
starts, the walker can see a gap: a segment that exists but is not done yet.

A channel send happens before the matching receive in the Go memory
model[^gomem], so a worker sees the events written before its segment was
sent. Only one goroutine, the walker, changes `done` and `readIdx`.

## Moving the cursor

When a worker finishes, it sends the segment back on `ackSeg`. The walker marks
it done. If the segment starts at `readIdx`, the walker moves forward over
every done segment:

```go
// internal/buffer/ring_buffer.go
func (rb *RingBuffer) findHighestContiguous(start, read int64) int64 {
    s, ok := rb.tracker.Get(start)
    if !ok { return read }
    s.done = true

    if s.StartIdx == read {
        cur := s
        for cur.done {
            rb.tracker.Del(cur.StartIdx)
            read = cur.EndIdx
            next, ok := rb.tracker.Get(cur.EndIdx)
            if !ok { break }
            cur = next
        }
    }
    return read
}
```

Then it publishes the new prefix:

```go
// internal/buffer/ring_buffer.go (handleSegmentAck, abridged)
lastEvent := rb.buffer[(highContiguous-1)%rb.size]
rb.readIdx.Store(highContiguous)
select {
case rb.space <- struct{}{}: // wake the writer if it is waiting
default:
}
rb.acked.Advance(lastEvent.LSN)
```

It reads the last event before it stores `readIdx`, because the writer may
reuse that slot as soon as `readIdx` moves. `acked` is an `ack.Position`: an
atomic register that only moves forward. The replicator reads it on each loop
iteration, which is at least once a second while it is receiving, and sends a
status update when it grows. A
register cannot drop an ACK, and it never holds a stale one, because only the
highest value matters.

The walk only ever sees each segment three times: added, marked done, and
deleted. So the total work is `O(N)` for `N` segments.

The figure below runs the `S1`–`S4` example with 2 events per segment and 8
slots. Step through it and watch `tracker` and `readIdx`.

{{< walviz kind="ring-walk" fig="4" title="The contiguous walk, one step at a time" fallback="ring-buffer-walk.svg" alt="An eight-slot ring: out-of-order completions and the contiguous readIdx walk" caption="Four workers, two events per batch, eight slots. Use ← and → to step." >}}

At step 10, event `e9` is written to `buffer[0]`, the slot `e1` used before.
Its position is 8, and `8 % 8 = 0`. The counters keep growing, and only the
array index wraps.

## The ring at production size

The next figure uses the defaults: 4 workers, 1,000 events per segment, and
8,000 slots. **Slow PUT** delays one upload, so later segments finish but wait
behind it. **S3 stall** stops all uploads, so the ring fills and the replicator
blocks.

{{< walviz kind="ring-sim" fig="5" title="The ring at production size" fallback="ring-buffer-walk.svg" alt="Ring buffer simulator with 8,000 slots and four workers" caption="A model, not a benchmark. PUT times are sampled from a lognormal with the chosen p50 and an assumed p99 of 2 × p50. Encode time is `1.2 ms`. The receiver and the walk follow the source." >}}

`TestRingCapacity` runs the real ring with a stand-in uploader that sleeps for
`7 ms` plus a PUT time from the same lognormal (p50 `100 ms`). With four
workers it sustains about 35,500 events/s, against an ideal of about 36,000.
A variant with three workers, a p50 of `200 ms`, and a `1.2 ms` encode kept up
with 14,000 events/s.

## What "mutex-free" means

`Add` uses no mutex: one writer, atomic counters, and slots that only the
writer fills, and only workers and the walker read. The tracker takes a mutex a few times per
segment, which is a few times per 1,000 events. Go channels lock internally,
workers wait on the network, and a full ring blocks the replicator. So the
system is not lock-free, and does not need to be. `Add` takes about 11 ns, and
the ring's job is ordering.

# Parquet: small files

Each Parquet file has one row group and seven columns: `table`, `operation`,
`timestamp`, `lsn`, `before`, `after`, and `commit_time`. `before` and `after`
hold the old and new row as JSON, and are null when that image does not exist:
an insert has no `before`, and a delete has no `after`. `NUMERIC` values are
written as JSON numbers with their exact digits, so `9999999999999999.99`
stays `9999999999999999.99`. All columns use ZSTD compression at level 3.

The test fixture has 1,000 events across 12 tables, a third each inserts,
updates, and deletes. Its file is 13,465 bytes, and the two JSON columns are
90% of that.

Benchmarks of the real code, three to five runs each:

| Step | Time | Allocated |
|---|---:|---:|
| Ring `Add` | about 11 ns per event | 0 B |
| Parse and decode one insert (five columns) | about 0.5 µs per event | 760 B |
| Write 1,000 events to Parquet | 1.17–1.20 ms per batch | 2.7–2.9 MB |

The Parquet library, arrow-go v18.2.0, creates a new ZSTD encoder for every
page it compresses, and each encoder allocates about 18 MB. A 1,000-event file
has one page per column plus two dictionary pages, so with the library's own
codec the fixture takes about 6.5 ms and 170 MB per batch. WAL Cake registers a
ZSTD codec that reuses encoders from a `sync.Pool`. It writes exactly the same
bytes, and a test checks that.

# The S3 upload and its key

A segment can hold rows from two days around midnight. The processor checks
every event's commit date and makes one `PutObject` call per run of equal
dates. The key is:

```txt
namespace/YYYY/MM/DD/<decode-time-µs>-<seq>.ZSTD.parquet
```

- The folder is the UTC date the transaction committed, from the `BEGIN`
  message. It does not depend on when WAL Cake decoded the row, on a replay, or
  on the server's time zone.
- The file name is the last event's decode time in microseconds, plus a
  sequence number that is unique within the process. The decode time alone is
  not unique: events decode in well under a microsecond, so two files in one
  folder can end on the same microsecond.

After a crash, Postgres sends the same rows again. They decode at a new time,
so they get a new key, and S3 now has two files with the same rows. Step
through it in the figure, then switch to an LSN-based key.

{{< walviz kind="replay" fig="6" title="Crash after PUT, then replay" fallback="pipeline.svg" alt="A crash after a successful PUT replays the segment; compare decode-time keys with LSN-range keys" caption="Both schemes keep at-least-once delivery. The LSN-range key turns the second PUT into a no-op." >}}

An LSN-range key with an `If-None-Match` conditional write[^conditional] would
make a replayed segment a no-op, but only when the replay cuts exactly the same
segments. It often does not. A segment cut by the `30 s` timer can have
different boundaries after a restart. A segment that ends inside a transaction
makes Postgres resend the whole transaction, which shifts every later boundary.
And a `COPY` writes up to 1,000 rows in one WAL record, so they share an LSN,
and an LSN range does not name a unique set of rows. A table format such as Iceberg handles deduplication
better, so WAL Cake leaves it to the reader.

If processing fails, the worker retries the whole segment, up to three
attempts, waiting `2 s` and then `4 s`. It reports the segment as done only
after an attempt succeeds.

# Shutdown

On `SIGTERM`, the ring stops taking events. It sends the last partial segment,
lets the workers finish their uploads, and moves the cursor over everything
that finished. Workers use a context that shutdown does not cancel, so an
upload is never cut off halfway. Then `main` stops the replicator, which sends
one final status update with the latest `acked` position before it closes the
connection.

After a deploy, Postgres resends at most the transaction that the last segment
ended in. A crash, such as an OOM kill or a lost node, replays everything after
the last status update.

# How it is tested

The tests are in the repository. The ones that need Postgres run when
`WALCAKE_TEST_PG` is set.

- **Ring state machine.** `rapid` generates random sequences of events and
  random completion orders against the real ring. After every step, the ACK
  must be the LSN of an event inside the finished prefix, and `readIdx` must
  equal the model's prefix. At the end, the drain must cover every admitted
  event.
- **Ring stress.** 200,000 one-event segments finish concurrently. The ring
  must reach the last event without stalling.
- **Processor property.** Random commit times around midnight, in several time
  zones, with decode times that share microseconds. Each event must be
  uploaded exactly once, in order, one UTC commit date per file, under the
  right folder, with no key used twice.
- **Replicator integration.** Back-to-back commits followed by a restart; a
  killed walsender; a failing slot query; and the final status update on
  shutdown.
- **Whole pipeline state machine.** The real replicator, ring, processor, and
  Parquet writer, with an S3 fake that fails each file once at random and adds
  delays. `rapid` generates histories of single-row and multi-row
  transactions, `COPY`, back-to-back commits, updates, deletes, rollbacks,
  killed walsenders, crashes, and graceful restarts. After recovery, every
  committed change must be in S3 with its exact values, no rolled-back row may
  be, every row must sit under its commit date, and the slot must never have
  moved backwards.

To check that the pipeline test can fail, I pointed commit events 26 bytes past
the end of the commit record. The state machine found a lost insert. The
current code passes 25 random histories, and 5 more under the race detector.

# What can still go wrong

{{< walviz kind="map" fig="7" title="Where each fault lives" failures="true" fallback="pipeline.svg" alt="System map with eight numbered markers for replays, stalls, and changes WAL Cake does not capture" caption="Numbers match the list below." >}}

None of these lose a committed row. The numbers match the markers in the
figure.

## Replays

1. **Crash after a successful upload.** The slot has not moved, so Postgres
   resends the rows and a second file holds them.
2. **Segment ends inside a transaction.** The ACK is a change LSN, so after a
   restart Postgres resends the whole transaction, including rows already in
   S3.
3. **Upload fails three times.** `log.Fatal` exits the process, and the slot
   replays everything after the last ACK.

Readers of the lake should expect duplicates, and deduplicate on `table`,
`lsn`, `operation`, and the row's key.

## Stalls and reconnects

4. **The ring is full.** The receiver waits for free space, `eventsCh` fills,
   and the replicator blocks. After a minute, the readiness check fails.
5. **The replicator is blocked for a long time.** It cannot send status
   updates while it is blocked, so Postgres drops the connection after
   `wal_sender_timeout` (60 s by default). When the ring drains, WAL Cake
   reconnects from the slot.
6. **The walsender dies or the primary fails over.** The session ends, and WAL
   Cake reconnects with backoff. The readiness check fails until it streams
   again.

The buffers only absorb short delays. At 10,000 events/s with the defaults, the
ring holds `0.8 s` of events and `eventsCh` another `0.4 s`. Part of the ring
is always taken by in-flight segments, so a longer S3 outage pauses
replication, and WAL builds up on the primary.

## Changes not captured

7. **`TRUNCATE`** is logged and not written to the lake.
8. **An unchanged TOASTed value** is stored as the string `"<TOAST>"`, because
   pgoutput does not send it.

# Takeaways

- A CDC consumer should advance the replication slot only past rows that are
  already in S3.
- The WAL is read in order and acknowledged in order. Only the middle, encode
  and upload, can run in parallel, and that is where the time goes.
- Parallel uploads finish out of order. Recording every segment before it
  starts, and moving the cursor only over finished segments, turns them back
  into one ordered ACK.
- Every LSN the consumer might send must be safe to confirm: the change LSN for
  a row, and the commit record's end for a commit.
- Give the ring room for one more batch per worker, and wake the writer when
  space frees up, so the workers stay busy.
- A day folder is only as exact as the timestamp used to split it. Use the
  commit time from `BEGIN`.
- Property tests over whole histories (crashes, restarts, back-to-back commits,
  bulk loads) check the one rule directly: every committed change ends up in
  S3.

[^debezium-pg]: <https://debezium.io/documentation/reference/stable/connectors/postgresql.html>
[^debezium-server]: <https://debezium.io/documentation/reference/stable/operations/debezium-server.html>
[^dms]: <https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.S3.html>
[^s3bench]: [S3 PUT latency benchmark, 500 KB objects, eu-north-1, 100 samples](https://topicpartition.io/misc/AWS-S3-PUT-latency-benchmark)
[^defaults]: [WAL Cake config defaults](https://github.com/pratikgajjar/wal-cake/blob/300e7abe41d4e8573657910cd51de65ebbc1d905/internal/config/config.go#L35-L36)
[^protocol]: [Postgres streaming replication protocol: standby status update](https://www.postgresql.org/docs/current/protocol-replication.html)
[^logical]: [Postgres logical decoding: replication slots](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html#LOGICALDECODING-REPLICATION-SLOTS)
[^msgformats]: <https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html>
[^slots]: <https://www.postgresql.org/docs/current/view-pg-replication-slots.html>
[^gomem]: <https://go.dev/ref/mem>
[^conditional]: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>

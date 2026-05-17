+++
title = "🦉 The Outbox Without an Outbox — Postgres Logical Messages as Eventbus"
description = "Postgres has shipped pg_logical_emit_message since 9.6 (2016) — it lets you skip the outbox table entirely. We walk factlib + OwlPost line by line and audit the LSN-ack pipeline."
date = 2026-05-17T12:00:00+05:30
lastmod = 2026-05-17T12:00:00+05:30
publishDate = "2026-05-17T12:00:00+05:30"
draft = false
tags = ["postgres", "outbox", "kafka", "event-driven", "wal", "golang"]
images = ["og.png"]
theme = "mauve"
featured = false
math = false
+++
# How you arrive here

By the end of this post you will see how Postgres' built-in
replication can carry your application's events — no separate outbox
table, polling loop, or cleanup job — along with the LSN-ack
pipeline that keeps it crash-safe, the trace context that survives
the WAL, and the failure modes where the approach breaks down.

The outbox pattern needs three properties for events: durability,
order preservation, and resumable delivery after a consumer
disconnects. Every production database already provides those for an
unrelated reason — replication. To let a warm standby survive the
primary's failure, the database writes every change to a write-ahead
log, ships those bytes to replicas in order, and tracks where each
replica is caught up to. The same three guarantees, with years of
pain folded into the implementation.

Stated that way, the outbox table looks like a second copy of the
replication mechanism — built in application code, on top of the
same database, with its own polling loop, its own high-water mark
(`processed = true`), and its own retention story (the cleanup job).
The database underneath is solving the same problem already.

So a natural question is whether the application can emit its own
events into the replication stream the database is already running.
Postgres has shipped that capability since 9.6 (September 2016)[^1].
`pg_logical_emit_message` writes an arbitrary blob into the WAL
atomically with the surrounding transaction; the same logical-
replication machinery a read replica uses decodes it out the other
end. The producer call is one line:

```go
// pkg/outbox/producer/producer.go
sqlQuery := "SELECT pg_logical_emit_message(true, $1, $2::bytea)"
err = a.conn.Exec(ctx, sqlQuery, a.prefix, protoBytes)
```

Roll back the transaction and no message leaves the system; commit
and the bytes are in the WAL and will be delivered. The replication
slot's `confirmed_flush_lsn` carries the bookkeeping that the outbox
table would otherwise hold, so no separate table, index, or vacuum
job is needed.

This post walks factlib[^2] — the Go library we ship at FamPay —
and its consumer **OwlPost** line by line: producer, consumer, ack
pipeline, trace propagation, and the edges where the approach hits
its limits.

# 1. The dual-write fallacy

Here's the code most engineers write the first time they need to emit
an event from a database transaction:

```go
func CreateUser(ctx context.Context, u User) error {
    if err := db.Save(ctx, u); err != nil {
        return err
    }
    return kafka.Produce(ctx, "user.created", u)
}
```

It looks fine. It is not fine. These 4 lines hide **at least three**
distinct failure modes:

1. **DB commits, Kafka returns error.** The user exists in your DB.
   Downstream services never hear about it. The retry budget on the
   client expires; the request returns 500; the user retries and now
   you have two users (or one user and a UNIQUE-violation depending on
   your schema). Either way, your invariants are broken.
2. **DB commits, process dies before Kafka call.** OOM, kill -9,
   panic, the kernel reaps you because the K8s node was draining.
   Same outcome, no error to log.
3. **Kafka acks, DB later loses its commit.** Less common: Kafka
   acks while the DB is async-replicating, the primary fails over
   before the WAL ships, and downstream services hold an event for
   a row that doesn't exist post-failover. Synchronous replication
   trades that risk for an `8 ms` instead of `800 µs` `db.Save` —
   and you still have problems #1 and #2.

The bug is structural. There is no atomic operation that spans your
relational database and your message broker. (Kafka transactions per
KIP-98 don't help here — they bound a producer's writes across Kafka
topics, not across Kafka and Postgres.) The fix is to make event
emission part of the *same* atomic write that the business data goes
into. That's the outbox pattern.

# 2. Why the canonical "outbox table" pattern is *almost* right

The textbook outbox pattern looks like this:

```sql
BEGIN;
  INSERT INTO users (id, ...) VALUES (...);
  INSERT INTO outbox (id, aggregate_type, payload, created_at, processed)
  VALUES (gen_random_uuid(), 'user', '{...}'::jsonb, now(), false);
COMMIT;
```

A separate process polls:

```sql
SELECT id, aggregate_type, payload
FROM outbox
WHERE processed = false
ORDER BY created_at
LIMIT 100;
```

For each row it produces to Kafka, then:

```sql
UPDATE outbox SET processed = true WHERE id = ANY($1);
-- or
DELETE FROM outbox WHERE id = ANY($1);
```

This works. It also has an operations tail that's easy to
under-estimate at design time. Let's enumerate.

## The polling-latency / scan-cost tradeoff

Set the poll interval to 100 ms and event lag is bounded by ~100 ms,
at the cost of **864,000 SELECT scans per day per worker** even when
no events exist. Set it to 5 s and you've added 5 s of p99 latency to
every event-driven downstream. There is no good answer here; "1
second" is the typical compromise, and that 1 s lands on every
webhook, every email, every side-effect.

## MVCC update churn on `processed = true`

`UPDATE outbox SET processed = true ...` writes a new row version;
the old tuple dies and waits for autovacuum. The partial index below
(`WHERE processed = false`) makes this not-HOT — predicate change
kicks the row out of the index. At 10K events/sec:

```txt
10,000 inserts/sec      → 10K live rows added per second
+ 10,000 updates/sec    → 10K dead rows per second
                        → vacuum has to reclaim ~864M dead tuples/day
```

Even if you switched to `DELETE` instead of `UPDATE`, you still write
a tombstone, still bloat the table, still need vacuum to run. The
table only shrinks when autovacuum manages to compete with your
inserts — which it usually doesn't, until you tune
`autovacuum_vacuum_scale_factor` for this specific table down to
something like 0.01 and `autovacuum_vacuum_cost_limit` up to 5000.

These knobs aren't usually front-and-centre in the tutorials I
learned from, and they're the ones that decide whether the outbox
table stays healthy at sustained throughput.

## Index choice for `WHERE processed = false`

A normal btree on `processed` is mostly useless because the column has
two values. The textbook "fix" is a **partial index**:

```sql
CREATE INDEX outbox_unprocessed_idx
  ON outbox (created_at)
  WHERE processed = false;
```

This works — but it does not save you. Every insert still touches the
index. Every update of `processed` from `false` to `true` triggers an
index entry deletion (and re-insertion if you ever flip it back).
Index bloat tracks table bloat in lockstep. You still need vacuum.

## The cleanup job

The table is unbounded without one, so you write:

```sql
DELETE FROM outbox WHERE processed = true AND created_at < now() - interval '7 days';
```

Run that on a 10 GB outbox table during peak hours and watch your
p99s. The right shape is a chunked delete with `LIMIT` + `pg_sleep`
between batches, or better still, partition the table by day and
`DROP PARTITION` every morning. Both work; both are extra code,
alerts, and runbooks.

## Polling vs change-data-capture

The other escape hatch is **Debezium** tailing the WAL for
`INSERT`s on `outbox`. Genuinely good — no polling, ~10 ms latency,
row-level semantics. The cost is operating Debezium: a JVM process
with Kafka Connect and a schema registry, fine for teams already on
that stack, heavier than the rest of the design for teams that
aren't.

The atomicity argument behind the outbox table is sound. The
implementation is just heavier than it needs to be.

# 3. The forgotten Postgres feature: `pg_logical_emit_message`

Function signature from the Postgres 17 docs[^3]:

> `pg_logical_emit_message(transactional boolean, prefix text, content text  [, flush boolean DEFAULT false]) → pg_lsn`
> `pg_logical_emit_message(transactional boolean, prefix text, content bytea [, flush boolean DEFAULT false]) → pg_lsn`

In English: emit a text or binary logical-decoding message that
plugins receive through WAL. `transactional = true` makes it visible
to decoders only when the surrounding txn commits; `false` writes
immediately. The optional `flush` parameter (added in Postgres 16[^4]) forces an
`XLogFlush` before returning — useful for non-transactional emits,
irrelevant for the `transactional=true` path factlib takes (the
COMMIT flushes). Pre-16 Postgres has only the 3-parameter form.

Three properties matter:

1. **Atomic with the surrounding transaction.** If you `ROLLBACK`,
   the message is gone. Same guarantee as the outbox table, no table
   needed.
2. **Decoded by `pgoutput` / `wal2json` like any row change.** Same
   `START_REPLICATION` connection, same `confirmed_flush_lsn`.
3. **Zero on-disk table footprint after WAL recycling.** Bytes live
   in WAL until the slowest active replication slot has flushed past
   that LSN (the WAL is held by `min(confirmed_flush_lsn)` across
   slots), then recycle like any other WAL record. No vacuum, no
   bloat, no cleanup job.

> The WAL **is** the outbox.

This is not Debezium-style row-level CDC: we are not decoding row
writes on an outbox table. We are inserting an application-defined
message into the same WAL the database uses for replication, and
decoding only that. (The underlying logical-decoding framework went
GA in 9.4; `pgoutput` landed in 10 alongside built-in logical
replication.)

# 4. How factlib emits

factlib's producer (`pkg/outbox/producer/producer.go`) is **99 lines**
end-to-end; the hot-path `Emit()` is the bottom 50. Reproduced below
with `metrics.EmitFailures.WithLabelValues(...)` calls on each
early-return collapsed:

```go
// pkg/outbox/producer/producer.go
func (a *PostgresAdapter) Emit(ctx context.Context, fact *common.Fact) (string, error) {
    if err := fact.Validate(); err != nil {
        return "", errors.Wrap(err, "failed to validate fact")
    }
    eventId, err := uuid.NewV7()
    if err != nil {
        return "", errors.Wrap(err, "failed to generate event ID")
    }
    outboxEvent := &pb.OutboxEvent{
        Id:            eventId.String(),
        AggregateType: fact.AggregateType,
        AggregateId:   fact.AggregateID,
        EventType:     fact.EventType,
        Payload:       fact.Payload,
        Metadata:      fact.Metadata,
        TraceInfo: &pb.TraceInfo{
            TraceId: fact.TraceInfo.TraceId,
            SpanId:  fact.TraceInfo.SpanId,
            Metadata: map[string]string{
                "parent_op":  fact.TraceInfo.ParentOp,
                "is_sampled": fact.TraceInfo.IsSampled,
            },
        },
        CreatedAt: time.Now().UTC().UnixNano(),
    }
    protoBytes, err := proto.Marshal(outboxEvent)
    if err != nil {
        return "", errors.Wrap(err, "failed to marshal proto event")
    }
    sqlQuery := "SELECT pg_logical_emit_message(true, $1, $2::bytea)"
    err = a.conn.Exec(ctx, sqlQuery, a.prefix, protoBytes)
    return outboxEvent.Id, err
}
```

A few things are doing real work here.

**`WithTxn(txn)` — bind the producer to a transaction by construction.**
Right above the function:

```go
func (a *PostgresAdapter) WithTxn(txn postgres.SQLExecutor) (postgres.OutboxProducer, error) {
    return &PostgresAdapter{ conn: txn, logger: a.logger, prefix: a.prefix }, nil
}
```

Application code:

```go
func CreateUser(ctx context.Context, db *pgxpool.Pool, u User) error {
    return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
        if _, err := tx.Exec(ctx, "INSERT INTO users ...", u.ID, ...); err != nil {
            return err
        }
        producer, _ := factlibProducer.WithTxn(postgres.GetPgxTxn(tx))
        fact, _ := common.NewFact("user", u.ID, "user.created", payloadBytes, nil)
        fact.TraceInfo = &common.TraceInfo{}  // mandatory; see §10 demo
        _, err := producer.Emit(ctx, fact)
        return err
    })
}
```

The `producer` shares the `pgx.Tx` with the business `INSERT`. There
is no way to call `Emit` outside a transaction, and no way for `Emit`
to commit on its own. The compiler does not enforce this — the
*ergonomics* enforce it. It's the cheapest invariant in the file.

**UUIDv7 for event IDs.** Time-sortable, 48-bit millisecond
timestamp prefix, then random bits. Two reasons it matters here
over UUIDv4:

1. **B-tree index locality on the consumer side.** Whatever ledger
   the consumer keeps for "events I have seen" — Postgres, Mongo,
   Cassandra — sorts inserts in time-near order, which keeps the
   right side of the btree hot and the rest cold. v4 inserts are
   uniformly random and bloat the btree over time.
2. **Free time ordering.** Sort events by ID and you get an
   approximate timeline without a separate `created_at` index. Useful
   for replay debugging.

Either v7 or ULID[^5] gets you the same property (both are 128-bit,
both put a millisecond timestamp at the front). v7 wins because
it's part of the UUID standard, so it round-trips through every
Postgres / pgx / `database/sql` column typed as `uuid` without
custom serde; ULID needs either a text column or a custom binary
type per ORM.

**One marshal, one SQL call.** No retry inside the emit. If the
`SELECT pg_logical_emit_message(...)` fails, the surrounding
transaction is poisoned and rolls back, and the caller gets to decide
whether to retry the whole business operation. This is correct: a
half-emitted event isn't a thing in this design.

**Latency observability via Prometheus.**

```go
start := time.Now()
err = a.conn.Exec(ctx, sqlQuery, a.prefix, protoBytes)
latency := time.Since(start).Seconds()
metrics.EventProcessingLatency.WithLabelValues(...).Observe(latency)
```

The histogram is `factlib_event_processing_seconds`. The byte math
in [§8](#8-ordering--throughput) derives an expected envelope of **80–250 µs p50** for sub-1KB
events on a same-VPC pgx connection — most of which is the network
round-trip, not the WAL append. We have not yet collected production
percentiles to ship publicly, so resist the urge to read absolute
numbers off this paragraph.

# 5. How OwlPost consumes

OwlPost (`cmd/owlpost/`) opens a logical-replication connection,
filters the WAL for our prefix, deserialises the protobuf, ships to
Kafka. The connection setup is the part most people get wrong:

```go
// pkg/postgres/wal.go — NewWALSubscriber
replUrl := fmt.Sprintf("%s?replication=database", cfg.DatabaseURL)
replConn, err := pgconn.Connect(ctx, replUrl)
```

`?replication=database` enters replication mode (it can still run
regular SQL, unlike `replication=true`). factlib opens **two**
connections because once you fire `START_REPLICATION`, that socket
is dedicated to streaming CopyData forever — no more queries.
`replConn` does streaming; `queryConn` does the boring
`SELECT EXISTS(SELECT 1 FROM pg_replication_slots ...)` bookkeeping.

## Setting up the slot

Two one-time, idempotent operations that `pkg/postgres/wal.go` runs
on every boot (`%s` is `fmt.Sprintf` interpolation):

```sql
-- ensurePublication
CREATE PUBLICATION %s;
-- ensureReplicationSlot
SELECT pg_create_logical_replication_slot('%s', 'pgoutput');
```

A **publication** is a set of tables whose row changes get streamed;
we don't care about row changes, just logical-decoding messages, but
`pgoutput` requires a publication to exist before it starts. We make
an empty one.

A **replication slot** is the durability primitive. It holds WAL
until the consumer acks past that LSN. *This is at-least-once for
free*: if OwlPost crashes for an hour, WAL accumulates for an hour
and we resume exactly where we left off. Operational footgun: a
slot whose consumer never returns pins WAL until the disk fills —
see [§7](#7-reliability-proof--the-lsn-dance).

## Starting replication

```go
// pkg/postgres/wal.go — startReplication
err = pglogrepl.StartReplication(ctx, w.replConn, w.cfg.ReplicationSlotName, w.xLogPos,
    pglogrepl.StartReplicationOptions{
        PluginArgs: []string{
            "proto_version '1'",
            fmt.Sprintf("publication_names '%s'", w.cfg.PublicationName),
            "messages 'true'",   // ← the important one
        },
    })
```

`messages 'true'` is a `pgoutput` plugin arg (added in PG 14[^6])
that tells it to decode logical-decoding messages alongside row
changes. Without it, `pg_logical_emit_message` calls are silently
dropped on the subscriber side — one of the failure modes that is
hardest to find without already knowing to look for it.

`w.xLogPos` is the start position. On every boot it's the slot's
`confirmed_flush_lsn`:

```sql
SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = $1;
```

That single column is the entire durability state of the consumer.

## The receive loop

```go
for {
    rawMsg, err := w.replConn.ReceiveMessage(receiveCtx)
    switch msg := rawMsg.(type) {
    case *pgproto3.CopyData:
        switch msg.Data[0] {
        case pglogrepl.PrimaryKeepaliveMessageByteID:
            // keepalive; reply if requested
        case pglogrepl.XLogDataByteID:
            xld, _ := pglogrepl.ParseXLogData(msg.Data[1:])
            newXLogPos := xld.WALStart + pglogrepl.LSN(len(xld.WALData))
            logicalMsg, _ := pglogrepl.Parse(xld.WALData)
            w.processLogicalMessage(ctx, logicalMsg, newXLogPos)
        }
    }
}
```

Two message types matter:

- **PrimaryKeepalive.** Postgres sends one on a cadence governed by
  `wal_sender_timeout` (default 60 s, keepalive interval = timeout/2 =
  30 s) even when the WAL is idle. The server can request a reply, in
  which case OwlPost echoes back its current `WALWritePosition` so the
  server doesn't tear down the connection. OwlPost's *own* tick is
  faster — `standbyMessageTimeout := time.Second * 5` in
  `pkg/postgres/wal.go` — so we send a status update every 5 s
  regardless.
- **XLogData.** Real WAL bytes. We parse them, compute
  `newXLogPos := xld.WALStart + LSN(len(xld.WALData))`, and pass
  *that* LSN through with the decoded message into
  `processLogicalMessage`. The receive loop does not advance
  `w.xLogPos` itself; the LSN rides on each event and only updates
  `w.xLogPos` when the ack pipeline (see [§7](#7-reliability-proof--the-lsn-dance))
  hears back from Kafka.

`processLogicalMessage` is two lines and the type-switch is doing the
filtering:

```go
func (w *WALSubscriber) processLogicalMessage(
    ctx context.Context,
    msg pglogrepl.Message,
    xLogPos pglogrepl.LSN,
) {
    if ldm, ok := msg.(*pglogrepl.LogicalDecodingMessage); ok {
        if ldm.Prefix == w.cfg.OutboxPrefix {
            w.handleMessage(ctx, ldm.Content, xLogPos)
        }
    }
}
```

We decode the **WAL stream of an entire database** but only act on
messages matching our prefix. Other emitters (other services, other
prefixes) on the same database fan out the same way: each consumer
subscribes with its own prefix and ignores the rest. The prefix is
the routing key.

## Prefix-based handler dispatch

In `pkg/outbox/consumer/consumer.go`:

```go
type EventHandler func(ctx context.Context, event *postgres.Event) error
func (s *OutboxConsumer) RegisterHandler(prefix string, handler EventHandler) {
    s.Handlers[prefix] = handler
}
```

For OwlPost, the registered handler is the Kafka adapter:

```go
// cmd/owlpost/main.go
outboxConsumer.RegisterHandler(cfg.WalPrefix, consumer.KafkaEventHandler(kafkaAdapter, logger))
outboxConsumer.RegiserHandlerAck(kafkaAdapter.Acks)
```

And the Kafka adapter:

```go
// pkg/outbox/consumer/kafka.go — KafkaEventHandler
topic := fmt.Sprintf("%s.%s", event.OutboxPrefix, event.Outbox.AggregateType)
key := []byte(event.Outbox.AggregateId)
value, _ := proto.Marshal(&event.Outbox)
headers := map[string]string{
    "event_id":   event.Outbox.Id,
    "event_type": event.Outbox.EventType,
    "LSN":        event.XLogPos.String(),
}
producer.Produce(ctx, topic, key, value, headers)
```

Three details:

- **Topic = `prefix.aggregateType`.** All `user.*` events emitted
  with prefix `payments-user` land in the `payments-user.user`
  topic. Topic proliferation is bounded by aggregate type, not event
  type; you filter individual event types on the consumer side.
- **Key = aggregateId.** Kafka's sticky partitioner hashes this to
  a partition; all events for `aggregate_id = "user-12345"` land on
  the same partition in WAL order. **Per-aggregate ordering is
  preserved end-to-end.** Cross-aggregate isn't — see [§8](#8-ordering--throughput).
- **`headers["LSN"] = event.XLogPos.String()`.** The LSN rides with
  the message so OwlPost's own ack callback can feed it back into
  the slot-advancement pipeline (§7 walks the timing — the slot's
  `confirmed_flush_lsn` is the single source of truth for "where
  we've read up to", not the Kafka offset). Downstream consumers
  don't need the header for correctness; it's there for debugging,
  so any Kafka message can be correlated back to its exact WAL
  position on the publisher.

# 6. Distributed tracing through the WAL

Trace context across an outbox boundary isn't part of the canonical
recipe and usually has to be added by hand. Without it, the
producer's Sentry / OTel span ends at the database write and a fresh,
disconnected one starts at the Kafka consume, which makes incident
replay harder than it needs to be.

factlib carries the trace info inside the protobuf:

```protobuf
// pkg/proto/outbox.proto
message OutboxEvent {
  string id              = 1;
  string aggregate_type  = 2;
  string aggregate_id    = 3;
  string event_type      = 4;
  bytes  payload         = 5;
  int64  created_at      = 6;
  map<string, string> metadata = 7;
  optional TraceInfo trace_info = 8;
}

message TraceInfo {
  string trace_id = 1;
  string span_id  = 2;
  map<string, string> metadata = 3;   // parent_op, is_sampled
}
```

On the producer side, the Python client lifts the active Sentry span
straight off the hub:

```python
# python/factlib/index.py
def _get_trace_context(self) -> TraceInfo:
    span = sentry_sdk.Hub.current.scope.span
    if span is None:
        return {}
    return TraceInfo(
        trace_id=span.trace_id,
        span_id=span.span_id,
        metadata={"parent_op": span.op or "", "is_sampled": "1" if span.sampled else "0"},
    )
```

The Go side is symmetric — caller fills in `Fact.TraceInfo` from
their tracer of choice. Both languages produce the same protobuf, so
polyglot fan-in works because the WAL doesn't care about the
producer language. Django writes a fact, OwlPost reads it, the Go
consumer downstream sees the same trace ID.

On the consumer side, `KafkaEventHandler` lifts the trace fields back
out and stuffs them into Kafka headers:

```go
// pkg/outbox/consumer/kafka.go
if event.Outbox.TraceInfo != nil && event.Outbox.TraceInfo.TraceId != "" {
    headers["trace_id"] = event.Outbox.TraceInfo.TraceId
    headers["span_id"]  = event.Outbox.TraceInfo.SpanId
    for k, v := range event.Outbox.TraceInfo.Metadata {
        headers[k] = v
    }
}
```

Service A's Sentry span covers the SQL `INSERT` plus the
`pg_logical_emit_message` call. Service B's Kafka consumer reads
`trace_id` from headers and opens a child span with the same trace
ID. Sentry / Jaeger / Tempo stitches them into one waterfall.

Cost: an extra **~95 B in the protobuf**, zero extra plumbing on
the consumer side. Derivation: every protobuf field is tag (1 B for
field numbers 1–15) + length-prefix (1 B for short strings) +
payload, so a 32-hex `trace_id` costs 34 B, a 16-hex `span_id` 18 B,
the two metadata entries `parent_op` ("http.request") and
`is_sampled` ("1") add 27 + 17, plus 2 B for the `trace_info`
wrapper — 98 B for a typical span. Vary `parent_op` and you land in
the **80–120 B** envelope — **~20 %** of a 500 B payload, dropping
to ~2 % for 5 KB payloads.

# 7. Reliability proof — the LSN dance

**Where we are**: §4 emits one SQL call into your transaction; §5
decodes the WAL for our prefix; §6 carries trace context across.
This section closes the loop on crash-safety — the LSN ack pipeline
that keeps "the database commit and the event delivery are atomic"
true under failure. Four scenarios; we'll walk all of them.

## Scenario 1: the happy path

```txt
producer       Postgres        OwlPost            Kafka
   │  INSERT        │              │                 │
   │ ─────────────▶ │              │                 │
   │  pg_logical_   │              │                 │
   │   emit_msg     │              │                 │
   │ ─────────────▶ │              │                 │
   │  COMMIT        │              │                 │
   │ ─────────────▶ │              │                 │
   │                │  WAL bytes   │                 │
   │                │ ───────────▶ │                 │
   │                │              │  produce(key,v) │
   │                │              │ ──────────────▶ │
   │                │              │      ack(LSN)   │
   │                │              │ ◀────────────── │
   │                │ ack=LSN      │                 │
   │                │ ◀─────────── │                 │
   │                │  confirmed_  │                 │
   │                │  flush_lsn↑  │                 │
```

The ack flows back through four hops:

1. Kafka acks the produce. `KafkaAdapter.Produce`'s callback fires.
2. The callback finds the `LSN` header and sends it to
   `kafkaAdapter.Acks`, which is plumbed into `consumer.handlerAcks`.
3. `OutboxConsumer.syncAck` parses the LSN and pushes it onto
   `walSubscriber.AckXLogPos`.
4. `WALSubscriber.listenEventAck` pops the LSN, updates `w.xLogPos`,
   and on the next 1-second tick calls `SendStandbyStatusUpdate`,
   which tells Postgres to advance `confirmed_flush_lsn`.

Postgres can now recycle WAL up to that LSN. The "outbox" auto-cleans.

The relevant code:

```go
// pkg/postgres/wal.go — listenEventAck
func (w *WALSubscriber) listenEventAck(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case ackPos := <-w.AckXLogPos:
            w.xLogPos = *ackPos
        case <-ticker.C:
            w.SendStandbyStatusUpdate()
        }
    }
}
```

Note the design: the LSN is **not** flushed to Postgres on every Kafka
ack. It's coalesced into a 1-second tick. At 10K events/sec, that
collapses 10,000 ack writes into one `pglogrepl.SendStandbyStatusUpdate`
call (the wire-protocol message is called "Standby status update")
— that is **four orders of magnitude** less ack traffic
(`10,000 → 1` per second). We trade a 1-second window of replay-on-
crash for it. Sensible default; tunable if your workload disagrees.

## Scenario 2: producer crash mid-transaction

```txt
producer        Postgres
   │ INSERT          │
   │ ──────────────▶ │
   │ pg_logical_     │
   │  emit_msg       │
   │ ──────────────▶ │
   │ ✗ panic
                     │
                     │ ROLLBACK (txn abandoned)
                     │ → no commit record in WAL
                     │ → logical-decoder skips
                     │   the entire transaction
                     │ → no message delivered
```

Because `transactional=true`, the message is part of the txn.
Logical decoding emits a txn's records only on COMMIT. No COMMIT,
no delivery, **zero events leak** — the same property the table-
based pattern has, free.

## Scenario 3: consumer crash post-Kafka, pre-LSN-ack

```txt
OwlPost                Kafka         Postgres
   │  produce(K, V)        │              │
   │ ────────────────────▶ │              │
   │            ack(LSN=X) │              │
   │ ◀──────────────────── │              │
   │                                      │
   │  ✗ kill -9                           │
   │                                      │
                                          │
                                          │ confirmed_flush_lsn still < X
                                          │ → on restart, replay from < X
   ┌─────────┐                            │
   │ OwlPost │                            │
   │ restart │                            │
   └────┬────┘                            │
        │ getxLogPos()                    │
        │ ──────────────────────────────▶ │
        │ ◀── confirmed_flush_lsn         │
        │                                 │
        │ replay X again                  │
        │ produce(K, V)  ─── duplicate ─→ Kafka
```

The same event is produced to Kafka twice. By design — this is
at-least-once; dedup is the consumer's job. `event.Id` is a UUIDv7,
so dedupe on it. **Don't reach for a Bloom filter**: a false positive
would silently *skip* an unseen event, the wrong direction of error.
Use an in-memory LRU of recent IDs plus, for sensitive flows,
`INSERT ... ON CONFLICT DO NOTHING` against a
`processed_events(id uuid PRIMARY KEY, processed_at timestamptz)`
table you TTL-prune yourself.

> **Sharp edge worth naming.**
> `listenEventAck`[^7] does `w.xLogPos = *ackPos` (line 390) on
> every ack. Kafka callbacks
> fire in-order per partition but across partitions interleave: if
> event A (LSN_a) is on partition 1 and event B (LSN_b > LSN_a) on
> partition 2 acks first, the consumer advances to LSN_b while A is
> in flight. Crash now and we replay from `>= LSN_b`, skipping A.
> The fix is a contiguous-acked high-water mark instead of last-
> write-wins; until that
> ships, factlib's "at-least-once" guarantee is effectively
> "at-least-once *per Kafka partition*". For most aggregate-keyed
> workloads (which is what factlib is designed for) the per-aggregate
> guarantee is what you actually want, but it's worth knowing the
> limit.

## Scenario 4: Kafka down for hours

```txt
OwlPost                Kafka
   │  produce(K, V)        │ ✗ broker unreachable
   │ ────────────────────▶
   │                  retries internally
   │  produce(K, V)        │ ✗ still down
                           ...
                           ...
                           │ Kafka recovers
   │                  ┌────┘
   │                  │
   │  buffered acks   │
   │ ◀────────────────┘
   │ ack chain proceeds
```

While Kafka is down, OwlPost reads up to **1000** events into the
`w.events` channel (a buffered Go channel; sends block past that),
plus whatever franz-go's producer can buffer. Once both buffers are
full, the WAL receive loop stops draining and Postgres continues to
retain WAL behind the slot. The LSN never advances.

After ~hours, two things start to break:

- **WAL fills the disk.** Postgres has no built-in alarm for "this
  replication slot is way behind." You add it:

  ```sql
  -- alert when ANY slot lags > 1 GiB. Don't filter by active=true:
  -- a stuck slot whose consumer has died goes inactive, and that's
  -- the most dangerous case (WAL still pinned, nobody draining).
  SELECT slot_name, active,
         pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
         ) AS lag_size
  FROM pg_replication_slots;
  ```

  In Prometheus terms: scrape this, alert at `> 1 GiB`. If it grows
  past your reserved disk, Postgres goes read-only and *every*
  writer in your fleet stops. Postgres 13+ has
  `max_slot_wal_keep_size` (default `-1` / no limit) that
  invalidates a slot before disk fills — set it (e.g. `10GB`) so a
  stuck slot loses its WAL retention rather than wedging the cluster.

- **The producer's WAL emit latency stays unchanged.** This is good.
  The producer doesn't care that the consumer is slow. The dual-write
  fallacy doesn't reappear because the producer's only contract is
  "the bytes are in WAL." Whether they're delivered today or tomorrow
  is the consumer's problem.

When Kafka recovers, OwlPost drains. WAL is reclaimed. Disk pressure
drops. No data loss.

# 8. Ordering & throughput

Two questions every event-bus eventually has to answer.

## Ordering

- **Per-aggregate ordering: strict.** Kafka partition is keyed on
  `aggregateId`. All events for `aggregate_id = "user-12345"` land on
  the same partition, in WAL emission order, period. The WAL itself
  is totally ordered, and Kafka's per-partition order is preserved.
- **Cross-aggregate ordering: not guaranteed in Kafka.** Two events
  for different aggregates may land on different partitions and be
  consumed in any order. *You almost never want cross-aggregate
  ordering anyway* — it serialises everything, defeats partitioning,
  and hurts throughput. If you really need it (rare), make all the
  related events share an aggregate.

The WAL itself preserves total order across all transactions on the
publisher database. If you cared, you could write a single-partition
consumer and get a strict total order out of factlib. Most teams
shouldn't.

## Throughput — napkin math

Each `Emit` call is exactly one extra `SELECT pg_logical_emit_message(...)`
on top of the business transaction. Cost components:

- **Function call overhead.** A few µs for the C function dispatch
  inside Postgres (`pg_logical_emit_message_bytea` is a built-in,
  not a SQL or PL/pgSQL function), ignoring the payload.
- **`bytea` argument copy.** The protobuf payload is bound as a
  parameter; pgx copies it once into the network buffer. For a 500 B
  payload, ~hundreds of nanoseconds.
- **WAL append.** A logical-decoding message produces a single
  `XLOG_LOGICAL_MESSAGE` WAL record. The structural overhead is
  fixed and easy to compute from the Postgres source headers
  (`xlogrecord.h`[^8], `replication/message.h`[^9]):

  - `SizeOfXLogRecord` = `offsetof(XLogRecord, xl_crc) + sizeof(pg_crc32c)`
    = `4 + 4 + 8 + 1 + 1 + 2 (pad) + 4` = **24 B** (per-record header).
  - `XLogRecordDataHeaderLong` = **5 B** (used because our payload >255 B).
  - `SizeOfLogicalMessage` = `offsetof(xl_logical_message, message)`
    = `4 (Oid) + 1 (bool) + 3 (pad) + 8 (Size prefix_size) + 8 (Size message_size)`
    = **24 B**.
  - The prefix is stored inline in the `message[]` flexible array, NUL-
    terminated; for the literal `"payments-user"` that is `13 + 1 = 14 B`.
  - The protobuf payload itself: **500 B** (worked example).

  ```txt
  XLogRecord header               24 B
  XLogRecordDataHeaderLong         5 B
  xl_logical_message header       24 B
  prefix (NUL-terminated)         14 B   ("payments-user\0")
  payload                        500 B
  ─────────────────────────────────────
  total                          567 B per emit
  ```

  Plus the surrounding `xl_xact_commit` record at COMMIT. Its
  minimal payload is just `TimestampTz xact_time` (8 B), small
  enough to use `XLogRecordDataHeaderShort` (2 B), so the COMMIT
  itself costs `24 + 2 + 8` = **34 B**. Round the per-event amortised
  WAL footprint up to **~600 B** (567 + 34 = 601).

- **Total round-trip.** We have not run the rig that would let us
  publish a measured p50 for `Emit()` honestly, so derive it from
  parts: a localhost pgx round-trip is `~80 µs` (one TCP write +
  read on loopback), the protobuf marshal of a 500 B event is
  `~5 µs` on Apple Silicon, and `pg_logical_emit_message` is a
  single C function call + WAL append. The expected envelope is
  **80–250 µs p50** on a same-VPC connection; anything outside that
  band is either network or contention.

At 10K events/sec:

```txt
WAL bytes   ≈ 600 B × 10,000  = 6 MB/sec
            ≈ 21 GB/hour
            ≈ 500 GB/day
```

A modern NVMe sustains 1–3 GB/sec sequential writes; we're using
0.3% of that. The bottleneck for ten-thousand-events-per-second is
network round-trips on the producer side, not the WAL itself. For
hundred-thousand-per-second you start needing batched-emit (see [§9](#9-when-not-to-use-this)
for "when not to use this") or a dedicated event store.

## How does this compare to a table-based outbox?

| | Outbox table (poll) | factlib (logical msg) |
|---|---:|---:|
| Producer SQL | 1 INSERT (heap tuple ~24 B header + payload + 2 index entries) | 1 SELECT (~600 B WAL, derived in [§8](#8-ordering--throughput)) |
| Producer round-trips | 1 | 1 |
| Consumer query rate | 10/sec polls per worker | 0 (push via WAL) |
| Index writes per event | 2 (PK + partial-on-`processed`) | 0 |
| Vacuum cost | proportional to event rate | none |
| End-to-end latency | poll interval (100 ms–5 s) | WAL flush + Kafka produce (single-digit ms on a same-VPC pgx connection, derived) |

The producer cost is roughly the same. The **consumer** cost is where
you get back hours of vacuum-tuning life and several Postgres-CPU
percent.

# 9. When NOT to use this

Every win has a cost. Name it.

## Cross-database transactions

`pg_logical_emit_message` is per-database. If your business
transaction spans **multiple Postgres clusters** (write to A and B
atomically), you don't have an atomic write to begin with — and
factlib doesn't help. You need 2PC or a saga.

## Ultra-high event rates (≥ 100K/sec)

WAL append itself is cheap — microseconds, into a buffer that's
only fsync'd at COMMIT. The real per-emit cost is the network
round-trip for the SELECT (~80 µs same-VPC), and the real per-
transaction cost is the COMMIT fsync (which already happens for the
business write, so an extra emit inside a short txn is nearly free).
The ceiling shows up around the commit-fsync rate, not the WAL
itself: at 100K events/sec with one emit per txn, you need ~100K
fsyncs/sec, which a single Postgres can't sustain. Mitigation:
batched emit (N events in one transaction; factlib doesn't expose
this yet, but the extension is small), or move to a dedicated event
store (Kafka, EventStoreDB, Pulsar) for async-write semantics.

# Caveats

Things to be aware of that apply regardless — they aren't reasons to
avoid this approach, just operational realities to plan for.

## Schema evolution

Standard protobuf evolution rules apply (additive optional fields,
never re-use field numbers, never change types) and you need a shared
schema registry across consumer languages. factlib doesn't solve this
problem, it just doesn't make it worse — same as any protobuf-based
event bus.

## Long Postgres transactions

With the `proto_version '1'` plugin arg factlib uses today, logical
decoding does not see a transaction's records until COMMIT — a 30-
second transaction blocks event delivery for 30 seconds. The
outbox-table pattern has the same property; the advice is the same:
keep transactions short, hoist long-running work outside the
transaction.

Newer pgoutput protocols help: v2 (PG 14) streams in-progress
transactions; v3 (PG 15) adds two-phase commit; v4 (PG 16) adds
parallel apply[^10]. Switching factlib past v1 is deferred — it
needs care around rolled-back streamed messages on the consumer.

# 10. The Python client (and polyglot fan-in)

The producer side has a sibling in `python/factlib/`. The hot path
is identical (the source also wraps the `cursor.execute` in
`except Exception as e: raise RuntimeError("Failed to emit event") from e`,
elided here):

```python
# python/factlib/index.py
def emit(self):
    cursor = connection.cursor()
    try:
        sql_query = "SELECT pg_logical_emit_message(true, %s, %s::bytea)"
        cursor.execute(sql_query, (self._prefix, self._event.SerializeToString()))
    finally:
        cursor.close()
```

Same SQL, same protobuf bytes. The Django version uses
`django.db.connection`, picking up the in-flight ORM transaction as
long as `emit()` runs inside an `atomic()` block. Mental model maps
1:1 to the Go side.

Once the wire format is "bytes in WAL with a prefix", every
language can emit and every language can consume. A Django service
emits a `payments-user` event; OwlPost (Go) reads it and ships to
Kafka; downstream consumers in Python, Go, or Kotlin read the same
bytes via the proto file. The producer language never enters the
picture downstream — a nice property for a polyglot backend to get
for free.

## Minimal Go producer

A whole runnable producer, copy-pasteable. Set
`DATABASE_URL=postgres://...?sslmode=disable` and a database with
`wal_level = logical` and run:

```go
// cmd/demo/main.go — minimal factlib producer
package main

import (
    "context"
    "log"
    "os"

    "git.famapp.in/fampay-inc/factlib/pkg/common"
    flogger "git.famapp.in/fampay-inc/factlib/pkg/logger"
    "git.famapp.in/fampay-inc/factlib/pkg/outbox/producer"
    fpostgres "git.famapp.in/fampay-inc/factlib/pkg/postgres"
    "github.com/jackc/pgx/v5"
)

func main() {
    ctx := context.Background()
    conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close(ctx)

    base, err := producer.NewPostgresAdapter("payments-user", flogger.New())
    if err != nil {
        log.Fatal(err)
    }

    err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
        if _, err := tx.Exec(ctx,
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            "user-12345", "alice@example.com",
        ); err != nil {
            return err
        }
        p, err := base.WithTxn(fpostgres.GetPgxTxn(tx))
        if err != nil {
            return err
        }
        fact, err := common.NewFact(
            "user", "user-12345", "user.created",
            []byte(`{"email":"alice@example.com"}`),
            map[string]string{"source": "demo"},
        )
        if err != nil {
            return err
        }
        // Required: factlib's Emit dereferences fact.TraceInfo, so an
        // empty struct is mandatory if you don't have a tracer wired up.
        fact.TraceInfo = &common.TraceInfo{}
        _, err = p.Emit(ctx, fact)
        return err
    })
    if err != nil {
        log.Fatal(err)
    }
}
```

To verify the emit landed in WAL, create a slot **before** running
the demo (a slot only sees changes after its creation point), then
peek after:

```sql
-- 1. Before running the Go demo:
CREATE TABLE users (id text PRIMARY KEY, email text);
CREATE PUBLICATION demo_pub;
SELECT pg_create_logical_replication_slot('demo_peek', 'pgoutput');

-- 2. Run the Go program above (it does the INSERT + emit).

-- 3. Peek at the bytes:
SELECT lsn, encode(data, 'hex')
FROM pg_logical_slot_peek_binary_changes(
    'demo_peek', NULL, NULL,
    'proto_version', '1', 'publication_names', 'demo_pub',
    'messages', 'true'
);

-- 4. Cleanup:
SELECT pg_drop_replication_slot('demo_peek');
DROP PUBLICATION demo_pub;
DROP TABLE users;
```

Run `go run ./cmd/owlpost` from the factlib repo with `KAFKA_BROKERS`
configured and the same bytes flow into Kafka instead.

# Comparison

| Approach | Atomic with business txn | Polling | Schema migration | Cleanup | Per-aggregate ordering | Trace context |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Dual-write (db + kafka) | ❌ | n/a | none | none | weak | manual |
| Outbox table + poller | ✅ | yes | yes | needed | per row | manual |
| Outbox table + Debezium | ✅ | no (WAL) | yes | needed | per row | manual |
| **factlib (logical messages)** | ✅ | no (WAL) | **none** | **automatic (WAL recycle)** | per aggregate | **in WAL** |

# What I'd change next

A few notes from running this in production.

- **Slot-lag alerting is mandatory, not optional.** The single most
  dangerous failure mode is "OwlPost dies on a Friday evening, WAL
  fills the disk on Sunday morning, Postgres goes read-only." We
  alert on `pg_replication_slots.confirmed_flush_lsn` lag at 1 GiB
  warning, 5 GiB page. You should too.
- **Batched emit would help bulk loads.** Today every event is a
  separate `pg_logical_emit_message` round-trip; a 200-row import
  is 200 SELECTs serialised on one transaction. An
  `EmitBatch([]*Fact)` envelope with N inner events would cut the
  round-trips and the WAL header overhead. Not built yet.
- **The 1-second ack tick is a knob.** Coalescing 10K acks per tick
  is a sane default; low-volume / high-criticality flows want 100 ms.
  Make it configurable.
- **`max_wal_senders` and `max_replication_slots`** default to 10
  in Postgres. Twelve services each running an OwlPost will exhaust
  them; bump both in `postgresql.conf` before you scale.
- **A bpftrace one-liner that counts emits in real time** is useful
  during incident response. Both `pg_logical_emit_message_text` and
  `pg_logical_emit_message_bytea` call `LogLogicalMessage`, so one
  uprobe covers both:

  ```bash
  bpftrace -e '
    uprobe:/usr/lib/postgresql/17/bin/postgres:LogLogicalMessage {
      @ = count();
    }
    interval:s:5 { print(@); clear(@); }
  '
  ```

  Five-second buckets of emit counts on this Postgres. apt-installed
  binaries are stripped; the PGDG `-dbgsym` package[^11] ships the
  symbols separately (`apt install postgresql-17-dbgsym`).
- **What we would not change:** `pgoutput` over `wal2json`.
  `pgoutput` is in-tree, ships with every Postgres, needs no
  extension install, and the protocol is stable since v1. JSON would
  duplicate what protobuf already gives us.

The whole library is 2,483 lines of Go (`find pkg cmd -name '*.go' -not -name '*_test.go' | xargs wc -l`). The interesting
line is exactly one:

```go
"SELECT pg_logical_emit_message(true, $1, $2::bytea)"
```

Postgres did the hard work in 2016. The rest is the scaffolding —
ack pipeline, slot management, trace propagation — that turns one
function call into a system you can run in production.

# Further reading

- Postgres docs:
  [logical decoding](https://www.postgresql.org/docs/17/logicaldecoding.html),
  [`pg_replication_slots`](https://www.postgresql.org/docs/17/view-pg-replication-slots.html).
- The classic outbox-pattern essay by Chris Richardson:
  [microservices.io](https://microservices.io/patterns/data/transactional-outbox.html).
- Decodable on the same idea applied to CDC pipelines:
  [Revisiting the Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern).
- Debezium's outbox-router (the Debezium-based variant of the same
  pattern):
  <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>.
- `pglogrepl` Go library: <https://github.com/jackc/pglogrepl>.

[^1]: [Postgres 9.6 release notes — September 2016](https://www.postgresql.org/docs/9.6/release-9-6.html)
[^2]: [factlib — github.com/fampay-inc/factlib](https://github.com/fampay-inc/factlib)
[^3]: [`pg_logical_emit_message` — Postgres 17 docs](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-REPLICATION)
[^4]: [Postgres 16 release notes](https://www.postgresql.org/docs/release/16.0/)
[^5]: [ULID specification](https://github.com/ulid/spec)
[^6]: [Postgres 14 release notes](https://www.postgresql.org/docs/release/14.0/)
[^7]: [`listenEventAck` — factlib/pkg/postgres/wal.go L381-396](https://github.com/fampay-inc/factlib/blob/main/pkg/postgres/wal.go#L381-L396)
[^8]: [`xlogrecord.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/access/xlogrecord.h)
[^9]: [`replication/message.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/replication/message.h)
[^10]: [`logicalproto.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/replication/logicalproto.h)
[^11]: [PGDG `-dbgsym` packages — PostgreSQL Wiki](https://wiki.postgresql.org/wiki/Apt)

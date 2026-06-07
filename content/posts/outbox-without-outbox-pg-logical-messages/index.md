+++
title = "🦉 The Outbox Without an Outbox"
description = "The outbox pattern asks for what replication already provides: durable, ordered, resumable delivery. Postgres' pg_logical_emit_message lets you piggyback on that. A line-by-line walk through factlib + OwlPost."
date = 2026-05-17T09:00:00+05:30
lastmod = 2026-05-17T10:50:00+05:30
publishDate = "2026-05-17T09:00:00+05:30"
draft = false
tags = ["postgres", "outbox", "kafka", "event-driven", "wal", "golang"]
images = ["og-4a8e2733.png"]
theme = "mauve"
featured = true
math = false
+++

{{< figure src="xiaohei-hero.png" alt="Xiaohei dropping a message straight into the Postgres WAL stream instead of an outbox table" >}}

# The idea

Postgres' replication can already carry your application's events: no
separate outbox table, polling loop, or cleanup job.

The outbox pattern needs three things: durability, order, and resumable
delivery after a consumer disconnects. Every database already provides
them, for replication. To keep a standby in sync, the database writes
every change to a write-ahead log, ships those bytes to replicas in
order, and tracks how far each replica has caught up.

Put that way, the outbox table is a second copy of replication, built
in application code on the same database: its own polling loop, its own
high-water mark (`processed = true`), its own cleanup job. The database
underneath already solves this.

Can the application emit its own events into that replication stream?
Postgres has shipped this since 9.6 (September 2016)[^1].
`pg_logical_emit_message` writes a blob into the WAL atomically with the
surrounding transaction; the same logical decoding that powers logical
replication reads it on the other end. The producer call is one line:

```go
// pkg/outbox/producer/producer.go
sqlQuery := "SELECT pg_logical_emit_message(true, $1, $2::bytea)"
err = a.conn.Exec(ctx, sqlQuery, a.prefix, protoBytes)
```

Roll back and the message is never delivered; commit and it ships
through the WAL like any replicated change. The replication slot's
`confirmed_flush_lsn` holds the bookkeeping the outbox table would
hold, so there's no separate table, index, or vacuum job.

This post walks factlib[^2] — the Go library we ship at FamPay — and
its consumer **OwlPost** line by line: producer, consumer, ack
pipeline, trace propagation, and where it hits its limits.

# 1. The dual-write fallacy

The first attempt:

```go
func CreateUser(ctx context.Context, u User) error {
    if err := db.Save(ctx, u); err != nil {
        return err
    }
    return kafka.Produce(ctx, "user.created", u)
}
```

These few lines hide one failure mode: the DB commit lands but the event
never reaches Kafka. It happens two ways:

1. **Kafka returns an error.** The user exists in your DB, but downstream
   services never hear about it. The retry budget on the client expires;
   the request returns 500; the user retries and now you have two users
   (or one user and a UNIQUE-violation, depending on your schema).
   Either way, your invariants are broken.
2. **The process dies before the Kafka call.** OOM, kill -9, panic, the
   kernel reaps you because the K8s node was draining. Same outcome, no
   error to log.

The bug is structural: no atomic operation spans your database and your
message broker. (Kafka transactions per KIP-98[^11] don't help: they
bound a producer's writes across Kafka topics, not across Kafka and
Postgres.) The fix: make event emission part of the *same* atomic write
as the business data. That's the outbox pattern.

# 2. The outbox table is almost right

The standard outbox table:

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

The trade-off is the ongoing maintenance it adds.

## The polling-latency / scan-cost tradeoff

Poll every 100 ms and lag stays ~100 ms, at the cost of **864,000
SELECT scans per day per worker** even when no events exist. Poll every
5 s and you add 5 s of p99 latency to every downstream. No good answer;
1 second is the usual compromise.

## Vacuum, indexes, and cleanup

`UPDATE outbox SET processed = true` writes a new row version; the old
tuple dies and waits for autovacuum. You need a partial index:

```sql
CREATE INDEX outbox_unprocessed_idx ON outbox (created_at) WHERE processed = false;
```

It makes that update not-HOT (Heap-Only Tuple; the predicate change
kicks the row out of the index), so index bloat tracks table bloat. At
10K events/sec:

```txt
10,000 inserts/sec      → 10K live rows added per second
+ 10,000 updates/sec    → 10K dead rows per second
                        → vacuum has to reclaim ~864M dead tuples/day
```

`DELETE` instead of `UPDATE` just trades the update for a tombstone:
same bloat, same vacuum. The table only shrinks when autovacuum keeps up
with your inserts, which usually means tuning
`autovacuum_vacuum_scale_factor` down to ~0.01 and
`autovacuum_vacuum_cost_limit` up to 5000 for this table. And it stays
unbounded without a cleanup job:

```sql
DELETE FROM outbox WHERE processed = true AND created_at < now() - interval '7 days';
```

Run that on a 10 GB table at peak and you spike p99s; the safe shapes are
a chunked delete (`LIMIT` + `pg_sleep`) or partition-by-day +
`DROP PARTITION`. Both are extra code, alerts, and runbooks.

## Polling vs change-data-capture

The other option is **Debezium** tailing the WAL for `INSERT`s on
`outbox`. Solid: no polling, ~10 ms latency, row-level semantics. The
cost is running Debezium: a JVM process with Kafka Connect and a schema
registry. Fine if you're already on that stack, heavy if you're not.

That path runs INSERT → WAL → Kafka Connect → Kafka, with a schema
registry alongside. The event is in the WAL the moment you commit; the
next section reads it straight from there, dropping the table and the
Connect tier.

# 3. `pg_logical_emit_message`

The function signature[^3]:

```sql
pg_logical_emit_message(
    transactional boolean,
    prefix        text,
    content       text   [, flush boolean DEFAULT false]
) → pg_lsn

pg_logical_emit_message(
    transactional boolean,
    prefix        text,
    content       bytea  [, flush boolean DEFAULT false]
) → pg_lsn
```

It emits a text or binary logical-decoding message that plugins receive
through WAL. `transactional = true` makes it visible to decoders only on
COMMIT; `false` writes immediately. factlib uses `transactional = true`,
so the surrounding COMMIT carries the flush.

Three properties matter:

1. **Atomic with the surrounding transaction.** If you `ROLLBACK`,
   the message is never delivered.[^4] Same guarantee as the outbox table,
   no table needed.
2. **Decoded by `pgoutput` / `wal2json` like any row change.** Same
   `START_REPLICATION` connection, same `confirmed_flush_lsn`.
3. **Zero on-disk table footprint after WAL recycling.** Bytes live
   in WAL until every replication slot has decoded past them (each
   slot's `restart_lsn` marks the oldest WAL it still needs, so a
   checkpoint recycles anything below the minimum), then they recycle
   like any other WAL record. No vacuum, no bloat, no cleanup job.

This is not Debezium-style row-level CDC: we are not decoding row
writes on an outbox table. We are inserting an application-defined
message into the same WAL the database uses for replication, and
decoding only that. (The underlying logical-decoding framework went
GA in 9.4; `pgoutput` landed in 10 alongside built-in logical
replication.)

# 4. How factlib emits

factlib's producer (`pkg/outbox/producer/producer.go`) is **99 lines**
end-to-end. The hot path is `Emit()`, reproduced below with the
per-error `metrics.EmitFailures.WithLabelValues(...)` calls collapsed:

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

**`WithTxn(txn)` binds the producer to a transaction by construction.**
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
        fact.TraceInfo = &common.TraceInfo{}  // required; Emit dereferences it
        _, err := producer.Emit(ctx, fact)
        return err
    })
}
```

The `producer` shares the `pgx.Tx` with the business `INSERT`. There
is no way to call `Emit` outside a transaction, and no way for `Emit`
to commit on its own.

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

Either v7 or ULID[^5] gives this (both are 128-bit with a leading
millisecond timestamp); we pick v7 because it's part of the UUID
standard and round-trips through any Postgres / pgx `uuid` column without
custom serde.

**One marshal, one SQL call.** No retry inside the emit. If the
`SELECT pg_logical_emit_message(...)` fails, the surrounding
transaction is poisoned and rolls back, and the caller decides whether
to retry the whole business operation.

**Latency observability.** Each emit records the
`factlib_event_processing_seconds` histogram; the `SELECT` itself runs in
microseconds.

**Same emit in Python.** factlib has a sibling in `python/factlib/` with
the same SQL and protobuf bytes:

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

The Django version uses `django.db.connection`, picking up the in-flight
ORM transaction as long as `emit()` runs inside an `atomic()` block. Once
the wire format is "bytes in WAL with a prefix", any language can emit and
any can consume: a Django service emits a `payments-user` event, OwlPost
(Go) ships it to Kafka, downstream consumers in any language read the same
proto. The producer language never enters the picture downstream.

To verify an emit landed in WAL, create a slot **before** running the
producer (`cmd/demo/main.go`, which needs `wal_level = logical` and
`DATABASE_URL`); a slot only sees changes after its creation point. Then
peek:

```sql
-- before: table, publication, slot
CREATE TABLE users (id text PRIMARY KEY, email text);
CREATE PUBLICATION demo_pub;
SELECT pg_create_logical_replication_slot('demo_peek', 'pgoutput');

-- run the producer (INSERT + emit), then peek at the bytes:
SELECT lsn, encode(data, 'hex')
FROM pg_logical_slot_peek_binary_changes(
    'demo_peek', NULL, NULL,
    'proto_version', '1', 'publication_names', 'demo_pub', 'messages', 'true'
);

-- cleanup:
SELECT pg_drop_replication_slot('demo_peek');
DROP PUBLICATION demo_pub;
DROP TABLE users;
```

# 5. How OwlPost consumes

OwlPost (`cmd/owlpost/`) opens a logical-replication connection,
filters the WAL for our prefix, deserialises the protobuf, ships to
Kafka. The connection setup needs two flags:

```go
// pkg/postgres/wal.go — NewWALSubscriber
replUrl := fmt.Sprintf("%s?replication=database", cfg.DatabaseURL)
replConn, err := pgconn.Connect(ctx, replUrl)
```

`?replication=database` enters replication mode (it can still run
regular SQL, unlike `replication=true`). factlib opens **two**
connections because once you fire `START_REPLICATION`, that socket
only streams CopyData; you can't run queries on it.
`replConn` does streaming; `queryConn` does the
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
until the consumer acks past that LSN (log sequence number, a byte
offset into the WAL). *This is at-least-once for free*: if OwlPost crashes for an hour, WAL accumulates for an hour
and we resume exactly where we left off. One risk to watch: a slot whose
consumer never returns pins WAL until the disk fills.

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
dropped on the subscriber side, with no error to tell you why.

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
  faster (`standbyMessageTimeout := time.Second * 5` in
  `pkg/postgres/wal.go`), so we send a status update every 5 s
  regardless.
- **XLogData.** Real WAL bytes. We parse them, compute
  `newXLogPos := xld.WALStart + LSN(len(xld.WALData))`, and pass
  *that* LSN through with the decoded message into
  `processLogicalMessage`. The receive loop does not advance
  `w.xLogPos` itself; the LSN rides on each event and only updates
  `w.xLogPos` when the ack pipeline hears back from Kafka.

`processLogicalMessage` filters by prefix with a type switch:

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

## Kafka adapter

`OutboxConsumer.RegisterHandler(prefix, handler)` wires one handler per
prefix (and an ack callback). For OwlPost the handler is the Kafka
adapter:

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
- **Key = aggregateId.** Kafka hashes this key to a partition, so
  all events for `aggregate_id = "user-12345"` land on the same
  partition in WAL order. **Per-aggregate ordering is preserved
  end-to-end**, cross-aggregate isn't.
- **`headers["LSN"]`.** The LSN rides with each message so OwlPost's ack
  callback can feed it back to advance the slot. Downstream
  consumers don't need it; it's there so any Kafka message can be traced
  back to its exact WAL position on the publisher.

# 6. Distributed tracing through the WAL

Trace context across an outbox boundary has to be passed explicitly, or
the producer's Sentry / OTel span ends at the database write and a fresh,
disconnected one starts at the Kafka consume, which makes incident replay
harder. factlib carries it inside the protobuf:

```protobuf
// pkg/proto/outbox.proto
message TraceInfo {
  string trace_id = 1;
  string span_id  = 2;
  map<string, string> metadata = 3;   // parent_op, is_sampled
}
```

The producer fills `TraceInfo` from its tracer (the Python client lifts
the active Sentry span off the hub; the Go side is symmetric). On the
consumer, `KafkaEventHandler` copies those fields into Kafka headers, so
Service B opens a child span with the same trace ID and Sentry / Jaeger /
Tempo stitch the two into one waterfall. Same protobuf in every language,
so polyglot fan-in needs no extra work.

# 7. Crash safety: the LSN ack pipeline

The LSN ack pipeline guarantees every committed event reaches Kafka at
least once under failure, across four scenarios.

## Scenario 1: the happy path

{{< figure src="seq-happy-path.png" alt="Sequence diagram of the happy path: the producer sends INSERT, pg_logical_emit_message, then COMMIT to Postgres; Postgres streams the WAL bytes to OwlPost; OwlPost produces to Kafka and receives ack(LSN); OwlPost sends ack=LSN back to Postgres, which advances confirmed_flush_lsn." >}}

OwlPost produces to Kafka asynchronously (franz-go, `acks=all`, idempotent
producer), so each partition stays ordered and a success callback means the
record is durably replicated. It does not advance the slot on each ack, and
it never advances to the *latest* ack: a later event can ack while an
earlier one is still in flight on another partition. It advances to the
**contiguous acked prefix** instead.

The single WAL reader hands events to the producer in LSN order, so
`pending` stays sorted. Each Kafka success marks one done; we then advance
over the longest gap-free run from the front:

```go
// pkg/postgres/wal.go — advance over the contiguous acked prefix
func (w *WALSubscriber) onKafkaAck(lsn pglogrepl.LSN) {
    // NOTE: pending is an unbounded slice today; a fixed ~1000-slot ring
    // buffer would cap the in-flight set and back-pressure the WAL reader.
    w.mu.Lock()
    w.acked[lsn] = true
    for len(w.pending) > 0 && w.acked[w.pending[0]] {
        w.safe = w.pending[0]          // highest LSN with no gap below it
        delete(w.acked, w.pending[0])
        w.pending = w.pending[1:]
    }
    w.mu.Unlock()
}

// 1s tick:
w.SendStandbyStatusUpdate(w.safe)      // everything <= safe is durable
```

This keeps the pipeline full, no draining. Two properties fall out:

- **A gap pins the slot.** If an event is slow or its produce fails, its
  LSN never leaves the head of `pending`, so `safe` (and
  `confirmed_flush_lsn`) stops there. A stuck broker becomes back-pressure,
  not skipped events. Pair it with slot-lag alerting.
- **Ack traffic collapses.** `safe` advances on every ack but is only
  shipped to Postgres on a 1-second tick, so 10K acks/sec become one
  `SendStandbyStatusUpdate`, four orders of magnitude less wire chatter.

The cost is a bounded replay window (events since the last shipped tick),
which the consumer dedupes on `event.Id`.

## Scenario 2: producer crash mid-transaction

This is what `transactional=true` is for: logical decoding emits a
transaction's records only on COMMIT. A panic before COMMIT means
ROLLBACK, so no commit record reaches the WAL and zero events leak,
same as the table-based pattern.

## Scenario 3: consumer crash post-Kafka, pre-LSN-ack

{{< figure src="seq-replay-duplicate.png" alt="Sequence diagram: OwlPost produces to Kafka and gets ack(LSN=X), then is killed (kill -9) before sending the ack back to Postgres, whose confirmed_flush_lsn is still < X. On restart OwlPost reads confirmed_flush_lsn via getxLogPos(), replays X, and produces a duplicate to Kafka." >}}

The same event is produced to Kafka twice, by design: this is at-least-once,
so the consumer must be idempotent. Dedupe on `event.Id` (a UUIDv7). For
durable dedup, `INSERT ... ON CONFLICT DO NOTHING` into a
`processed_events(id uuid PRIMARY KEY, processed_at timestamptz)` table you
TTL-prune; an in-memory LRU of recent IDs is a fine fast-path in front of
it, but only the table survives the restart that caused the duplicate.
A Bloom filter is the cheapest membership check, but it only errs toward
false positives — reporting an unseen event as already seen. So it can
confirm an event is new (definitely not in the set) but never that one was
already handled; keep the table as the authority.

## Scenario 4: Kafka down for hours

{{< figure src="seq-kafka-down.png" alt="Sequence diagram: OwlPost produces to Kafka but the broker is unreachable, so it retries internally; a second produce still fails while the broker is down; after time passes Kafka recovers, the buffered acks flow back to OwlPost, and the ack chain proceeds." >}}

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

  In Prometheus terms: scrape it and warn at `> 1 GiB`, page at `> 5 GiB`. If it grows
  past your reserved disk, Postgres stops accepting writes, halting
  *every* writer in your fleet. Postgres 13+ has
  `max_slot_wal_keep_size` (default `-1` / no limit) that
  invalidates a slot before disk fills; set it (e.g. `10GB`) so a
  stuck slot loses its WAL retention rather than wedging the cluster.

- **The producer's WAL emit latency stays unchanged.** The producer
  doesn't care that the consumer is slow. The dual-write
  fallacy doesn't reappear because the producer's only contract is
  "the bytes are in WAL."

When Kafka recovers, OwlPost drains, WAL is reclaimed, and disk
pressure drops without data loss.

# 8. Ordering & throughput

## Ordering

- **Per-aggregate ordering: strict.** Kafka partition is keyed on
  `aggregateId`. All events for `aggregate_id = "user-12345"` land on
  the same partition, in WAL emission order. The WAL itself
  is totally ordered, and Kafka's per-partition order is preserved.
- **Cross-aggregate ordering: not guaranteed in Kafka.** Two events
  for different aggregates may land on different partitions and be
  consumed in any order. Cross-aggregate ordering serialises
  everything, defeats partitioning, and hurts throughput; when you
  need it, make the related events share an aggregate.

The WAL itself preserves total order across all transactions on the
publisher database. A single-partition consumer would expose that
strict total order; the per-partition guarantee is usually enough.

## Throughput — napkin math

Each `Emit` is one extra `SELECT pg_logical_emit_message(...)` on top of
the business transaction. Three costs:

- **Function dispatch + arg copy.** A few µs for the built-in C function
  (`pg_logical_emit_message_bytea`); pgx copies the `bytea` payload once
  into the network buffer (~hundreds of ns for 500 B).
- **WAL append.** One `XLOG_LOGICAL_MESSAGE` record. Its overhead is
  fixed and computable from the Postgres headers (`xlogrecord.h`[^8],
  `replication/message.h`[^9]). For a 500 B payload with prefix
  `"payments-user"`:

  ```txt
  XLogRecord header               24 B
  XLogRecordDataHeaderLong         5 B   (payload >255 B)
  xl_logical_message header       24 B
  prefix (NUL-terminated)         14 B   ("payments-user\0")
  payload                        500 B
  ──────────────────────────────────────
  total                          567 B per emit
  ```

  Plus the COMMIT's `xl_xact_commit` record (~34 B), so **~600 B**
  amortised per event.
- **Total round-trip.** On Apple M3 Max[^12] (1 KB payload, BEGIN →
  INSERT → EMIT → COMMIT, 10K iters): emit `SELECT` p50 **12.8 µs**
  (unix socket) / **21.9 µs** (TCP loopback), p99 28 / 42 µs. Same-VPC
  TCP adds the cross-host RTT (~200–500 µs cross-AZ). Protobuf marshal
  of 500 B is ~5 µs, negligible.

At 10K events/sec:

```txt
WAL bytes   ≈ 600 B × 10,000  = 6 MB/sec
            ≈ 21 GB/hour
            ≈ 500 GB/day
```

A modern NVMe sustains 1–3 GB/sec sequential writes; the EBS gp3 volume
here did 574 MB/sec. At ~600 B per event the WAL is never the limit for
small events. What binds depends on payload size and how you commit.
Measured on a 16-core EC2 box (EBS gp3, durable `synchronous_commit = on`)[^13]:

```txt
small events, one emit per commit    fsync-bound      ~25–70K emits/sec
small events, batched (~512/commit)  CPU / WAL locks  ~390K emits/sec
large events (≥100 KB)               WAL bandwidth    ~SSD write rate
```

A single connection does ~1,000 emits/sec, exactly the volume's
single-stream fsync rate. Concurrency, and especially batching several
events into one transaction, amortise that fsync across many emits. Batch
~512 and you reach ~390K/sec durable, where the disk sits at 12% and the
limit becomes CPU and WAL-insert locks rather than fsync. Only payloads
above ~100 KB push WAL to the disk's write rate. So 100K events/sec is
comfortable on one node once you batch; the producer is rarely the ceiling.
The single slot consumer is.

## Cost breakdown vs the outbox table

| | Outbox table (poll) | factlib (logical msg) |
|---|---:|---:|
| Producer SQL | 1 INSERT (heap tuple ~24 B header + payload + 2 index entries) | 1 SELECT (~600 B WAL) |
| Producer round-trips | 1 | 1 |
| Consumer query rate | 10/sec poll (100 ms) | 0 (push via WAL) |
| Index writes per event | 2 (PK + partial-on-`processed`) | 0 |
| Vacuum cost | proportional to event rate | none |
| End-to-end latency | poll interval (100 ms–5 s) | WAL flush + Kafka produce (single-digit ms on a same-VPC pgx connection, derived) |
| Consumer parallelism | N workers (`SKIP LOCKED` / partitioned table) | 1 reader per slot; fan out via Kafka |

The producer cost is roughly the same. The consumer side is where they
differ, and it cuts both ways. The table outbox is wasteful to poll, but it
parallelizes cleanly: run N workers with `SELECT ... FOR UPDATE SKIP
LOCKED`, or partition the table, and they make progress independently. A
logical slot has exactly one reader, so OwlPost decodes the WAL in order,
reads in batches, and hands off to Kafka, where partitions restore
parallelism downstream. The two approaches parallelize in different places:
the table at the database read, factlib after Kafka.

# Comparison

| Approach | What it costs | What you get |
|---|---|---|
| Dual-write (DB then Kafka) | No atomicity: a crash between the two writes loses or duplicates events | Simplest to write |
| Outbox table + poller | A table, polling latency, and constant vacuum + cleanup | Atomicity on any database, simple mental model, parallel consumers |
| Outbox table + Debezium | Running Debezium (JVM, Kafka Connect, schema registry); table and cleanup remain | No polling (~10 ms), per-aggregate ordering, mature tooling |
| **factlib (logical messages)** | Postgres-only, one WAL reader (fan out via Kafka), slot-lag alerting | No table, index, vacuum, cleanup, or schema migration; per-aggregate ordering; trace context in the WAL |

# Notes

## Cross-database transactions

`pg_logical_emit_message` is per-database. If your business
transaction spans **multiple Postgres clusters** (write to A and B
atomically), you don't have an atomic write to begin with, and
factlib doesn't help. You need 2PC or a saga.

## Scaling the producer

Writing the emit to the WAL is cheap: it appends one record to an in-memory
buffer. The real cost is the `fsync` at COMMIT that makes the transaction
durable, and a `transactional` emit rides that same `fsync` instead of
adding its own. So the limit is durable commits per second, not bytes.

Batching needs no extra machinery: because the emit rides your transaction,
a transaction that produces several facts emits each one and they share one
commit, so a single `fsync` covers the batch.

The producer is rarely the wall. The consumer is: one logical slot is a
single reader, so to scale past it shard by prefix or aggregate range, or
move to a dedicated event store like Kafka or Pulsar.

## Schema evolution

Standard protobuf evolution rules apply (additive optional fields,
never re-use field numbers, never change types) and you need a shared
schema registry across consumer languages. factlib doesn't solve this
problem, it just doesn't make it worse, same as any protobuf-based
event bus.

## Long Postgres transactions

With the `proto_version '1'` plugin arg factlib uses today, logical
decoding does not see a transaction's records until COMMIT, so a 30-
second transaction blocks event delivery for 30 seconds. The
outbox-table pattern has the same property; the advice is the same:
keep transactions short, hoist long-running work outside the
transaction.

Newer pgoutput protocols help: v2 (PG 14) streams in-progress
transactions; v3 (PG 15) adds two-phase commit; v4 (PG 16) adds
parallel apply[^10]. Switching factlib past v1 is deferred because it
needs care around rolled-back streamed messages on the consumer.

## Production gotchas

- **`max_wal_senders` and `max_replication_slots`** default to 10.
  Twelve services each running their own consumer will exhaust them;
  bump both in `postgresql.conf` before you scale.
- **Slot-lag alerting is mandatory.** A stuck slot pins WAL until the
  disk fills and Postgres stops accepting writes. Alert on
  `pg_replication_slots` lag and cap it with `max_slot_wal_keep_size`.

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
[^4]: Rollback isn't physically free: the `XLOG_LOGICAL_MESSAGE` record is written to WAL when the function runs, and `ROLLBACK` only adds an abort record on top. Logical decoding buffers the transaction and drops it on abort, so what you avoid is *delivery*, not the *write* — the bytes sit in WAL until normal recycling. The outbox table is the same shape: a rolled-back `INSERT` still wrote a tuple and WAL that vacuum later reclaims.
[^5]: [ULID specification](https://github.com/ulid/spec)
[^6]: [Postgres 14 release notes](https://www.postgresql.org/docs/release/14.0/)
[^8]: [`xlogrecord.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/access/xlogrecord.h)
[^9]: [`replication/message.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/replication/message.h)
[^10]: [`logicalproto.h` — postgres/postgres REL_17_0](https://github.com/postgres/postgres/blob/REL_17_0/src/include/replication/logicalproto.h)
[^11]: [KIP-98 — Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
[^12]: Measured on a local PostgreSQL 17 (`wal_level = logical`, `synchronous_commit = on`), 10,000 iterations of BEGIN → INSERT → `pg_logical_emit_message` → COMMIT timing the emit `SELECT`, over a unix socket and TCP loopback on an Apple M3 Max.
[^13]: Throughput measured on a 16-core EC2 instance (EBS gp3, ~574 MB/sec sequential write, single-stream `fdatasync` ~1,100/sec) running PostgreSQL 15 with `wal_level = logical`, `synchronous_commit = on`, over a unix socket. Load from a concurrent Go emitter (pgx, one `pg_logical_emit_message` per commit unless batched), cross-checked against `pgbench` within ~2%.

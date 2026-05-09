+++
title = "🦉 The Outbox Without an Outbox — Postgres Logical Messages as Eventbus"
description = "Postgres has shipped pg_logical_emit_message since 9.6 (2016) — it makes the outbox table unnecessary. We walk factlib + OwlPost line by line and audit the LSN-ack pipeline."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["postgres", "outbox", "kafka", "event-driven", "wal", "golang", "first-principles"]
images = ["og.png"]
theme = "denim"
featured = false
math = false
+++

# The trick is one SQL call

```go
// pkg/outbox/producer/producer.go
sqlQuery := "SELECT pg_logical_emit_message(true, $1, $2::bytea)"
err = a.conn.Exec(ctx, sqlQuery, a.prefix, protoBytes)
```

That's it. No `outbox` table. No `processed = false` index. No nightly
vacuum job to chase down. The line above runs inside your normal
business transaction; if the transaction rolls back, no event is
emitted; if it commits, the bytes are in the WAL and they will be
delivered.

Postgres has shipped this function since
[9.6 (September 2016)](https://www.postgresql.org/docs/release/9.6/) — see
the entry for `pg_logical_emit_message` in the
[9.6 release notes](https://www.postgresql.org/docs/9.6/release-9-6.html).
Almost nobody uses it. The outbox-pattern tutorials all keep teaching you to
build a table, then a poller, then an index, then a cleanup job — and
nine times out of ten they don't tell you about the dual-write race
hiding in their first code sample.

> Every "outbox pattern" tutorial gives you a table, a poller, a
> vacuum problem, and a dual-write race they don't talk about.
> Postgres has shipped a feature since 9.6 that makes the table
> unnecessary — and almost nobody uses it.

This post dissects [factlib](https://github.com/fampay-inc/factlib),
the Go library we ship at FamPay, plus its consumer **OwlPost**, to
show what that one SQL line buys you, what it costs, and what it does
not solve.

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

It looks fine. It is not fine. This 4 lines have **at least three**
distinct failure modes that ship to production every week somewhere on
the internet:

1. **DB commits, Kafka returns error.** The user exists in your DB.
   Downstream services never hear about it. The retry budget on the
   client expires; the request returns 500; the user retries and now
   you have two users (or one user and a UNIQUE-violation depending on
   your schema). Either way, your invariants are broken.
2. **DB commits, process dies before Kafka call.** OOM, kill -9,
   panic, the kernel reaps you because the K8s node was draining.
   Same outcome, no error to log.
3. **Kafka acks, DB later loses its commit.** Less common, but if
   Kafka returns an ack while the DB is replicating asynchronously and
   the primary fails over before the WAL ships, you end up with an
   event for a row that doesn't exist downstream of the failover.
   "But we use synchronous replication" — okay, then your `db.Save`
   takes 8 ms instead of 800 µs and you've still got problems #1 and #2.

The bug is structural. There is no atomic operation that spans your
relational database and your message broker. You cannot two-phase
commit Kafka. (You technically can with KIP-98 transactional
producers, but it's expensive, fragile, requires consumer-side
`isolation.level=read_committed`, and most people don't actually
configure it correctly. Ask me how I know.)

The real fix is to make the event emission part of the *same* atomic
write that the business data goes into. That's the outbox pattern.

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

This works. It is also a small operations nightmare nobody mentions
in the blog post that taught you the pattern. Let's enumerate.

### The polling-latency / scan-cost tradeoff

Set the poll interval to 100 ms and your event lag is bounded by ~100
ms. You'll also do **864,000 SELECT scans per day per worker** even
when no events exist. Set it to 5 s and you've added 5 s of p99
latency to every event-driven downstream. There is no good answer
here. Most teams pick "1 second" because it sounds reasonable and then
quietly accept a 1 s delay on every webhook, every email, every
side-effect.

### HOT update churn on `processed = true`

`UPDATE outbox SET processed = true ...` is an MVCC update. Postgres
writes a new row version. The old one becomes dead and waits for
autovacuum. At 10K events/sec, that's:

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

Did your last outbox tutorial mention any of those settings? Mine
didn't.

### Index choice for `WHERE processed = false`

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

### The cleanup job nobody writes correctly

You eventually realise the table is unbounded and write a cleanup job:

```sql
DELETE FROM outbox WHERE processed = true AND created_at < now() - interval '7 days';
```

Run that on a 10 GB outbox table during peak hours and watch your
p99s. The right way is a chunked delete with `LIMIT` + a `pg_sleep`
between batches, or — much better — partition the table by day and
`DROP PARTITION` every morning. Both work. Both are extra code,
extra alerts, extra runbooks.

### Polling vs change-data-capture

The other escape hatch is to put **Debezium** in front of the outbox
table. Debezium tails the WAL, watches for `INSERT`s on `outbox`,
emits to Kafka. This is genuinely good — you stop polling, the latency
drops to ~10 ms, and you keep the row-level table semantics. But you
now operate Debezium, which is a JVM process with Kafka Connect, a
schema registry, a JMX dashboard nobody knows how to read, and the
operational footprint of a small Hadoop cluster. For an organisation
already running Kafka Connect, fine. For a team of four, it is a tax.

So the outbox pattern is *almost* right. The atomicity argument is
sound. The implementation is just heavier than it needs to be.

# 3. The forgotten Postgres feature: `pg_logical_emit_message`

Function signature, paraphrased from the
[Postgres 17 docs](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-REPLICATION):

> `pg_logical_emit_message(transactional boolean, prefix text, content text [, flush boolean]) → pg_lsn`
> `pg_logical_emit_message(transactional boolean, prefix text, content bytea [, flush boolean]) → pg_lsn`

The upstream description (lightly compressed): emit a text or binary
logical decoding message that logical decoding plugins receive
through WAL. With `transactional = true` the message becomes visible
to decoders only when the surrounding transaction commits; with
`false`, it's written immediately and decoded as soon as the decoder
reads the WAL record.

Read that twice. Three properties matter:

1. **It writes to the WAL atomically with the surrounding transaction.**
   `transactional = true` means the message becomes visible to
   logical-decoding consumers only if the transaction commits. If
   you `ROLLBACK`, the message is gone. This is the same atomicity
   guarantee as the outbox table. It comes for free, no table needed.
2. **Logical decoding plugins (`pgoutput`, `wal2json`) deliver the
   message to subscribers** the same way they deliver row changes.
   Same protocol, same `START_REPLICATION` connection, same
   `confirmed_flush_lsn` book-keeping.
3. **It has zero on-disk table footprint** after WAL recycling. The
   bytes live in the WAL until every replication slot has acked past
   that LSN, then they are recycled like any other WAL record. No
   vacuum. No bloat. No cleanup job.

> The WAL **is** the outbox.

The function has been there since 9.6. Logical replication itself was
GA in 10. The decoding-message support was specifically added so that
applications could co-opt the WAL stream as a generic event bus, and
then it sat unused for nearly a decade because every blog post about
event-driven architecture continued to teach the table-and-poller
recipe.

# 4. How factlib emits

factlib's producer is the smaller half: `pkg/outbox/producer/producer.go`
is **99 lines** end-to-end (`wc -l`), and the hot-path `Emit()`
function is the bottom 50. Reproduced below with the metric-counter
increments collapsed for narrative — the actual source increments
`metrics.EmitFailures.WithLabelValues(...)` on each early-return:

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

The application code looks like this:

```go
func CreateUser(ctx context.Context, db *pgxpool.Pool, u User) error {
    return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
        if _, err := tx.Exec(ctx, "INSERT INTO users ...", u.ID, ...); err != nil {
            return err
        }
        producer, _ := factlibProducer.WithTxn(postgres.GetPgxTxn(tx))
        fact, _ := common.NewFact("user", u.ID, "user.created", payloadBytes, nil)
        _, err := producer.Emit(ctx, fact)
        return err
    })
}
```

The `producer` shares the `pgx.Tx` with the business `INSERT`. There
is no way to call `Emit` outside a transaction, and no way for `Emit`
to commit on its own. The compiler does not enforce this — the
*ergonomics* enforce it. It's the cheapest invariant in the file.

**UUIDv7 for event IDs.** RFC 9562 §5.7. Time-sortable, 48-bit
millisecond timestamp prefix, then random bits. Two reasons it
matters here over UUIDv4:

1. **B-tree index locality on the consumer side.** Whatever ledger
   the consumer keeps for "events I have seen" — Postgres, Mongo,
   Cassandra — sorts inserts in time-near order, which keeps the
   right side of the btree hot and the rest cold. v4 inserts are
   uniformly random and bloat the btree over time.
2. **Free time ordering.** Sort events by ID and you get an
   approximate timeline without a separate `created_at` index. Useful
   for replay debugging.

Either v7 or ULID gets you the same property. v7 wins because it is
in the actual UUID standard and `database/sql` already knows how to
serialise it.

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
in §8 derives an expected envelope of **80–250 µs p50** for sub-1KB
events on a same-VPC pgx connection — most of which is the network
round-trip, not the WAL append. We have not yet collected production
percentiles to ship publicly, so resist the urge to read absolute
numbers off this paragraph.

# 5. How OwlPost consumes

OwlPost is the consumer side — the binary in `cmd/owlpost/`. It
opens a logical-replication connection to the same Postgres, filters
the WAL stream for our prefix, deserialises the protobuf, and ships
to Kafka.

The connection is the part most people get wrong, so let's start
there:

```go
// pkg/postgres/wal.go — NewWALSubscriber
replUrl := fmt.Sprintf("%s?replication=database", cfg.DatabaseURL)
replConn, err := pgconn.Connect(ctx, replUrl)
```

`?replication=database` is the magic suffix. Without it, Postgres
gives you a normal connection that cannot run `START_REPLICATION`.
With it, you get a replication-aware connection that *only* speaks
the streaming-replication subprotocol. So OwlPost actually opens
**two** connections — `replConn` for the WAL stream, `queryConn` for
the boring `SELECT EXISTS(SELECT 1 FROM pg_replication_slots ...)`
checks.

### Setting up the slot

Two one-time DDL operations. They run on every boot and are
idempotent:

```go
// pkg/postgres/wal.go — ensurePublication, ensureReplicationSlot
CREATE PUBLICATION %s
SELECT pg_create_logical_replication_slot('%s', 'pgoutput')
```

A **publication** in Postgres is a set of tables whose row changes
will be streamed. We don't actually care about row changes here —
we want the logical-decoding messages — but `pgoutput` requires a
publication to exist before it'll start. We create an empty one.

A **replication slot** is the durability primitive. Once created, it
holds onto WAL until the consumer acknowledges it has flushed past
that LSN. *This is what gives you at-least-once delivery for free*:
if OwlPost crashes for an hour, the WAL accumulates for an hour, and
when OwlPost comes back it picks up exactly where it left off.

Slots are also the operational footgun. If OwlPost dies and never
comes back, the WAL grows until your disk fills. We will return to
this in §7.

### Starting replication

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

`messages 'true'` is a `pgoutput` plugin arg added in
[Postgres 14](https://www.postgresql.org/docs/release/14.0/) that
tells the plugin: "yes, please decode logical-decoding messages,
not just row changes." Without it, our `pg_logical_emit_message`
calls would be silently dropped on the subscriber side and you'd
waste an afternoon staring at WAL traces. Ask me how I know.

`w.xLogPos` is where to start streaming from. On first boot it's the
slot's `confirmed_flush_lsn`; on subsequent boots, same thing — the
slot remembers. The implementation is in `getxLogPos()`:

```sql
SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = $1;
```

That single column is the entire durability state of the consumer.

### The receive loop

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
- **XLogData.** Real WAL bytes. We parse them, hand the resulting
  message to `processLogicalMessage`, and remember the LSN.

`processLogicalMessage` is two lines and the type-switch is doing the
filtering:

```go
func (w *WALSubscriber) processLogicalMessage(ctx context.Context, msg pglogrepl.Message, xLogPos pglogrepl.LSN) {
    if ldm, ok := msg.(*pglogrepl.LogicalDecodingMessage); ok {
        if ldm.Prefix == w.cfg.OutboxPrefix {
            w.handleMessage(ctx, ldm.Content, xLogPos)
        }
    }
}
```

We're decoding the **WAL stream of an entire database**, but we only
care about messages whose prefix matches ours. Other emitters (other
services, other prefixes) on the same database fan out the same way:
each consumer subscribes to the same WAL with its own prefix, ignores
everything else. The prefix is the routing key.

### Prefix-based handler dispatch

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

- **Topic = `prefix.aggregateType`.** All `user.*` events for the
  `payments` service land in the `payments.user` topic. Topic
  proliferation is bounded by aggregate type, not event type; you
  filter individual event types on the consumer side.
- **Key = aggregateId.** Kafka's sticky partitioner hashes this to
  pick a partition. All events for `aggregate_id = "user-12345"` land
  on the same partition, in WAL order. **Per-aggregate ordering is
  preserved end-to-end.** Cross-aggregate ordering is not — see §8.
- **`headers["LSN"] = event.XLogPos.String()`.** The LSN rides with
  the message. The Kafka ack callback later strips it back out and
  feeds it to the LSN-ack pipeline. This is the trick that turns
  at-least-once into "actually reliable", and it deserves its own
  section.

# 6. Distributed tracing through the WAL

Most outbox implementations drop trace context. The producer is in a
Sentry / OTel span; the consumer is not; the trace ends at the
database write and a new one starts at the Kafka consume. Painful.

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

So a transaction in Service A produces a Sentry trace whose root span
contains the SQL `INSERT` plus the `pg_logical_emit_message` call.
Five seconds later the Kafka consumer in Service B pulls the message,
reads `trace_id` from headers, opens a new span with the same trace
ID and `span_id` as parent. Sentry / Jaeger / Tempo stitches them
into one waterfall.

We get this for the cost of an extra ~80 bytes in the protobuf and
zero extra plumbing on the consumer side. The WAL is a fully
trace-aware transport.

# 7. Reliability proof — the LSN dance

The whole point of the outbox pattern is that "the database commit
and the event delivery are atomic." factlib + OwlPost preserves that
guarantee through a careful LSN ack pipeline. There are four failure
scenarios to think about. We'll walk all of them.

### Scenario 1: the happy path

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

The ack flows back through three hops:

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
collapses 10,000 ack writes into one `pg_send_standby_status_update`
RPC — that is **four orders of magnitude** less ack traffic
(`10,000 → 1` per second). We trade a 1-second window of replay-on-
crash for it. Sensible default; tunable if your workload disagrees.

### Scenario 2: producer crash mid-transaction

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

Because `transactional=true`, the `pg_logical_emit_message` write is
*conceptually* part of the transaction. Logical decoding only emits
a transaction's records when it sees the COMMIT. No COMMIT, no
delivery. **Zero events leak.** This is the property that the
table-based pattern also has, achieved here for free.

### Scenario 3: consumer crash post-Kafka, pre-LSN-ack

```txt
OwlPost                Kafka         Postgres
   │  produce(K, V)        │             │
   │ ────────────────────▶ │             │
   │            ack(LSN=X) │             │
   │ ◀──────────────────── │             │
   │                                     │
   │  ✗ kill -9                          │
   │                                     │
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
at-least-once. Deduplication is the consumer's job. `event.Id` is a
UUIDv7, so the consumer can dedupe on it. **Don't reach for a Bloom
filter here**: a Bloom-filter false positive would silently *skip* an
unseen event, which is the wrong direction of error. Use a fixed-
window `LRU` of recent IDs in memory plus, for sensitive flows, an
`INSERT ... ON CONFLICT DO NOTHING` against a `processed_events(id
uuid PRIMARY KEY, processed_at timestamptz)` table that you partition
or TTL-prune yourself.

This is one of the cases the
[`feat(kafka ack): Reliability 100%`](https://github.com/fampay-inc/factlib/commit/45f9f13)
commit explicitly addresses. The earlier version of OwlPost flushed
LSN ahead of Kafka acks; if a Kafka produce later failed the message
was lost. The 1-second-tick design means the LSN never advances past
a Kafka write whose callback hasn't fired.

> **Sharp edge worth naming.** Today
> [`listenEventAck`](https://github.com/fampay-inc/factlib/blob/main/pkg/postgres/wal.go)
> just does `w.xLogPos = *ackPos` on every received ack. Kafka ack
> callbacks fire in per-partition order, but across partitions
> (across aggregate IDs) they can interleave. So if event A (LSN_a)
> goes to partition 1 and event B (LSN_b > LSN_a) goes to partition
> 2, and B's broker is faster, the consumer can advance to LSN_b
> while A is still in flight. Crash now and we replay from `>=
> LSN_b`, skipping A. The fix is to track a contiguous-acked
> high-water mark instead of a last-write-wins cursor; until that
> ships, factlib's "at-least-once" guarantee is effectively
> "at-least-once *per Kafka partition*". For most aggregate-keyed
> workloads (which is what factlib is designed for) the per-aggregate
> guarantee is what you actually want, but it's worth knowing the
> limit.

### Scenario 4: Kafka down for hours

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

While Kafka is down, OwlPost keeps reading WAL into its in-memory
buffer (`w.events` is a 1000-deep channel) and franz-go's producer
buffers writes. The LSN never advances. Postgres continues to retain
WAL.

After ~hours, two things start to break:

- **WAL fills the disk.** Postgres has no built-in alarm for "this
  replication slot is way behind." You add it:

  ```sql
  -- alert when slot is more than 1 GB behind
  SELECT slot_name,
         pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn))
                 AS lag_bytes
  FROM pg_replication_slots
  WHERE active;
  ```

  In Prometheus terms: scrape this, alert when `lag_bytes > 1 GiB`,
  page. If it grows past your reserved disk, Postgres goes
  read-only — and *every* writer in your fleet stops, not just the
  consumer.

- **The producer's WAL emit latency stays unchanged.** This is good.
  The producer doesn't care that the consumer is slow. The dual-write
  fallacy doesn't reappear because the producer's only contract is
  "the bytes are in WAL." Whether they're delivered today or tomorrow
  is the consumer's problem.

When Kafka recovers, OwlPost drains. WAL is reclaimed. Disk pressure
drops. No data loss.

# 8. Ordering & throughput

Two questions every event-bus eventually has to answer.

### Ordering

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

### Throughput — napkin math

Each `Emit` call is exactly one extra `SELECT pg_logical_emit_message(...)`
on top of the business transaction. Cost components:

- **Function call overhead.** ~10–20 µs for the function dispatch
  itself, ignoring the bytea payload.
- **`bytea` argument copy.** The protobuf payload is bound as a
  parameter; pgx copies it once into the network buffer. For a 500 B
  payload, ~hundreds of nanoseconds.
- **WAL append.** A logical-decoding message produces a single
  `XLOG_LOGICAL_MESSAGE` WAL record. The structural overhead is
  fixed and easy to compute from the Postgres source headers
  ([`xlogrecord.h`](https://github.com/postgres/postgres/blob/REL_17_0/src/include/access/xlogrecord.h),
  [`replication/message.h`](https://github.com/postgres/postgres/blob/REL_17_0/src/include/replication/message.h)):

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
  `~5 µs` on Apple Silicon (`google.golang.org/protobuf/proto.Marshal`
  microbench), and `pg_logical_emit_message` itself is a single C
  function call + WAL append. The expected envelope is
  **80–250 µs p50** on a same-VPC connection. Anything outside that
  band is either network or contention. We will measure properly in
  a follow-up.

At 10K events/sec:

```txt
WAL bytes   ≈ 600 B × 10,000  = 6 MB/sec
            ≈ 21 GB/hour
            ≈ 500 GB/day
```

A modern NVMe sustains 1–3 GB/sec sequential writes; we're using
0.3% of that. The bottleneck for ten-thousand-events-per-second is
network round-trips on the producer side, not the WAL itself. For
hundred-thousand-per-second you start needing batched-emit (see §9
for "when not to use this") or a dedicated event store.

### How does this compare to a table-based outbox?

| | Outbox table (poll) | factlib (logical msg) |
|---|---:|---:|
| Producer SQL | 1 INSERT (heap tuple ~24 B header + payload + 2 index entries) | 1 SELECT (~600 B WAL, derived in §8) |
| Producer round-trips | 1 | 1 |
| Consumer query rate | 10/sec polls per worker | 0 (push via WAL) |
| Index writes per event | 2 (heap + index) | 0 |
| Vacuum cost | proportional to event rate | none |
| End-to-end latency | poll interval (100 ms–5 s) | WAL flush + Kafka produce (single-digit ms on a same-VPC pgx connection, derived) |

The producer cost is roughly the same. The **consumer** cost is where
you get back hours of vacuum-tuning life and several Postgres-CPU
percent.

# 9. When NOT to use this

Every win has a cost. Name it.

### Cross-database transactions

`pg_logical_emit_message` is per-database. If your business
transaction spans **multiple Postgres clusters** (write to A and B
atomically), you don't have an atomic write to begin with — and
factlib doesn't help. You need 2PC or a saga. Don't pretend factlib
solves a problem it can't see.

### Non-Postgres backends

There is no equivalent in MySQL. The binlog can be tailed (Debezium
does this) but there is no `pg_logical_emit_message` analogue —
nothing that lets the application write a generic event into the
replication stream as part of a transaction. You'd be back to the
outbox table, with Debezium tailing the binlog. Cassandra, DynamoDB,
Mongo — same story, different details. This pattern is genuinely
Postgres-specific.

### Ultra-high event rates (≥ 100K/sec)

At those rates the WAL itself becomes your bottleneck — not because
of the bytes, but because every emit is a synchronous network
round-trip that has to land in WAL before the application thread can
proceed. Possible mitigations:

- **Batching.** Emit a single message that contains an array of
  events. factlib doesn't expose this today; trivial extension.
- **Move to a dedicated event store.** Kafka itself, EventStoreDB,
  Pulsar. At that scale you're already operating Kafka, so the
  argument against Kafka-as-store-of-record gets weaker.
- **Partition writes.** Multiple producer DBs each emitting their
  slice of the event stream.

If you're operating a 100K/sec service, you've already had this
conversation. For the rest of us, factlib's emit ceiling is fine.

### Schemas that change often

Protobuf evolution rules apply: add new optional fields, never
re-use field numbers, never change types. You also need a registry
discipline so consumers in other languages know what wire format to
expect. We use a shared `proto/` repo at FamPay; you could just as
well use Buf Schema Registry or Confluent's. The point: factlib does
not solve the schema-evolution problem, it just doesn't make it
worse.

### Long Postgres transactions

With the `proto_version '1'` plugin arg factlib uses today, logical
decoding does not see a transaction's records until COMMIT — a 30-
second transaction blocks event delivery for 30 seconds. Same
problem the outbox-table pattern has. The advice is the same: keep
transactions short, hoist long-running work outside the transaction.

Newer pgoutput protocols (`proto_version '2'`, added in Postgres 14;
`proto_version '4'` adds two-phase commit support) can stream
in-progress transactions, which would unblock long-runners. Switching
factlib to v2 is on the deferred list — it requires care around
rolled-back streamed messages on the consumer side.

# 10. The Python client (and polyglot fan-in)

The producer side has a sibling in `python/factlib/`. The hot path
is identical:

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
`django.db.connection`, which means you get the in-flight ORM
transaction for free as long as `emit()` is called inside an
`atomic()` block. The mental model maps 1:1 to the Go side.

This is the part most people miss: **once the wire format is "bytes
in WAL with a prefix", every language can emit, every language can
consume.** Your Django service emits a `payments-user` event;
OwlPost (Go) reads it and ships to Kafka; downstream consumers in
Python, Go, Kotlin, anything with a Kafka client and the proto file,
read it. The producer language never enters the picture downstream.

That's a real win for any company with more than one backend
language. Most have. Most pretend they don't.

# Comparison

| Approach | Atomic with business txn | Polling | Schema migration | Cleanup | Per-aggregate ordering | Trace context |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Dual-write (db + kafka) | ❌ | n/a | none | none | weak | manual |
| Outbox table + poller | ✅ | yes | yes | needed | per row | manual |
| Outbox table + Debezium | ✅ | no (WAL) | yes | needed | per row | manual |
| **factlib (logical messages)** | ✅ | no (WAL) | **none** | **automatic (WAL recycle)** | per aggregate | **in WAL** |

# What I'd change next

A few honest observations after running this in production for a
while.

- **Slot-lag alerting is mandatory, not optional.** The single most
  dangerous failure mode is "OwlPost dies on a Friday evening, WAL
  fills the disk on Sunday morning, Postgres goes read-only." We
  alert on `pg_replication_slots.confirmed_flush_lsn` lag at 1 GiB
  warning, 5 GiB page. You should too.
- **Batched emit would be useful for bulk loads.** Today every event
  is a separate `pg_logical_emit_message` round-trip. For a
  200-row import, that's 200 SELECTs serialised on a single
  transaction. A `factlib.EmitBatch([]*Fact)` that produces one
  envelope with N inner events would cut the round-trips and the
  WAL header overhead. We haven't built it because we haven't
  needed it; we will eventually.
- **The 1-second ack tick is a knob.** Coalescing 10K acks into one
  is the right default. For a low-volume / high-criticality flow you
  might want 100 ms. Make it configurable.
- **`max_wal_senders` and `max_replication_slots`** default to 10 in
  Postgres. If you have 12 services each running its own OwlPost
  instance, you'll run out. Bump these in `postgresql.conf` before
  you scale.
- **A bpftrace one-liner that counts emits in real time** is useful
  during incident response:

  ```bash
  bpftrace -e '
    uprobe:/usr/lib/postgresql/17/bin/postgres:pg_logical_emit_message {
      @[probe] = count();
    }
    interval:s:5 { print(@); clear(@); }
  '
  ```

  Five-second buckets of "how many emits happened on this Postgres."
  You'll be glad you have it.
- **What I would not change:** the choice of `pgoutput` over
  `wal2json`. `pgoutput` is in-tree, ships with every Postgres,
  needs no extension install, and the protocol is stable since
  v1. `wal2json` would give us JSON instead of binary, which is
  *less* of what we want — we already have protobuf.

The whole library is around 2,500 lines of Go (`find pkg cmd -name '*.go' -not -name '*_test.go' | xargs wc -l` → 2,483). The clever line is
exactly one:

```go
"SELECT pg_logical_emit_message(true, $1, $2::bytea)"
```

Postgres did the hard work in 2016. The rest of us just have to
notice.

# Further reading

- Postgres docs:
  [`pg_logical_emit_message`](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-REPLICATION),
  [logical decoding](https://www.postgresql.org/docs/17/logicaldecoding.html),
  [`pg_replication_slots`](https://www.postgresql.org/docs/17/view-pg-replication-slots.html).
- factlib source: <https://github.com/fampay-inc/factlib> (Apache-2.0).
- The classic outbox-pattern essay by Chris Richardson:
  [microservices.io/patterns/data/transactional-outbox.html](https://microservices.io/patterns/data/transactional-outbox.html).
- Debezium's incremental snapshots and outbox-router (the
  Debezium-based variant of the same pattern):
  <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>.
- RFC 9562 §5.7 (UUIDv7).
- `pglogrepl` Go library: <https://github.com/jackc/pglogrepl>.

---

*Colophon: factlib was built at FamPay and is in production for the
events that move money. The killer line was committed on a Tuesday
afternoon. The rest of the library is what you build around it
when you decide to run it for real.*

# Brief — Blog 2: factlib / OwlPost

**FIRST: read `/Users/pratikgajjar/ambitious/go-backend.how/.briefs/_voice.md` and follow every rule there.**

## Subject

`fampay-inc/factlib` — Postgres outbox-pattern library + `owlpost` consumer. Author: Pratik (you). The killer trick: **it doesn't use an outbox table.** It uses `pg_logical_emit_message(true, prefix, bytea)` to write protobuf events directly into the WAL inside the same business transaction. OwlPost reads the WAL, filters by prefix, produces to Kafka with LSN-anchored acks.

## Source location (read these in full)

- Cached repo: `/Users/pratikgajjar/.cache/checkouts/github.com/fampay-inc/factlib/`
- Critical files:
  - `README.md`
  - `pkg/outbox/producer/producer.go` — **the trick lives here** (`pg_logical_emit_message`)
  - `pkg/outbox/consumer/consumer.go` — handler registry, prefix routing
  - `pkg/outbox/consumer/kafka.go` — kafka adapter, ack callback
  - `pkg/postgres/wal.go` — WAL subscriber, LSN tracking, standby status
  - `pkg/postgres/types.go`, `pgx.go`, `sql.go`
  - `pkg/common/fact.go`, `types.go` — Fact struct, validation
  - `pkg/proto/outbox.pb.go` — OutboxEvent + TraceInfo schema
  - `pkg/metrics/metrics.go` — Prometheus counters
  - `cmd/owlpost/main.go`
  - `python/factlib/index.py` — Python client (Django integration)
  - Git log: `git -C /Users/pratikgajjar/.cache/checkouts/github.com/fampay-inc/factlib log --oneline -50` — note "Reliability 100%", "Add listenEventAck loop to ack lsn", "Ensure we resume from last pos".

## Title

`🦉 The Outbox Without an Outbox — Postgres Logical Messages as Eventbus`

(Workshop after reading. Keep the owl emoji — `cmd/owlpost`.)

## Slug & output path

- Slug: `outbox-without-outbox-pg-logical-messages`
- Output: `/Users/pratikgajjar/ambitious/go-backend.how/content/posts/outbox-without-outbox-pg-logical-messages/index.md`
- Theme: `claret`
- Tags: `["postgres", "outbox", "kafka", "event-driven", "wal", "golang", "first-principles"]`

## Thesis (top blockquote)

> Every "outbox pattern" tutorial gives you a table, a poller, a vacuum problem, and a dual-write race they don't tell you about. Postgres has shipped a feature since 9.6 that makes the table unnecessary — and almost nobody uses it.

## Required sections

### 1. The dual-write fallacy
The classic broken code (db.Save then kafka.Produce). Walk through 3 failure modes — all of which are routinely shipped to production.

### 2. Why the canonical "outbox table" pattern is *almost* right
Show the standard pattern (txn writes business row + outbox row, poller reads and produces). Then show what's wrong:
- Polling latency vs scan cost tradeoff
- HOT update churn on `processed = true`
- Vacuum lag at 10k events/sec — the bloat numbers
- Index choice for `WHERE processed = false` (partial index helps but doesn't save you)
- The cleanup job that nobody writes correctly

### 3. The forgotten Postgres feature: `pg_logical_emit_message`
Quote the docs (search Postgres docs for `pg_logical_emit_message`). Key properties:
- It writes to WAL atomically with the surrounding transaction.
- Logical decoding plugins (`pgoutput`, `wal2json`) deliver it to subscribers.
- It has no on-disk table footprint after WAL recycling.
- It accepts `bool transactional, text prefix, bytea content`.

This is the killer line: "the WAL **is** the outbox." Make this the section's punchline.

### 4. How factlib emits
From `pkg/outbox/producer/producer.go`:
- `WithTxn(txn)` ergonomic — bind the producer to your `pgx.Tx` so emit is in-txn by construction
- Validate the Fact (aggregateType, aggregateID, eventType non-empty)
- UUIDv7 for event ID (time-sortable, ULID-equivalent — call out why v7 over v4)
- Marshal `OutboxEvent` protobuf with TraceInfo (traceId, spanId, parent_op, is_sampled — distributed tracing rides through the WAL)
- Single SQL call: `SELECT pg_logical_emit_message(true, $1, $2::bytea)` with `prefix` and `protoBytes`
- Latency observed via Prometheus histogram

Show the actual code.

### 5. How OwlPost consumes
From `pkg/postgres/wal.go` + `pkg/outbox/consumer/`:
- Connect with `?replication=database`
- `ensurePublication`, `ensureReplicationSlot`
- `pgoutput` plugin protocol — but here we're filtering on **logical decoding messages** (`pglogrepl.LogicalDecodingMessage`), not table changes
- Prefix-based handler dispatch (`OutboxConsumer.RegisterHandler(prefix, handler)`)
- Kafka produce: topic = `<prefix>.<aggregateType>`, key = `aggregateId`, headers carry trace + event metadata
- The ack pipeline: Kafka acks → consumer pushes LSN to `AckXLogPos` channel → standby status update sends LSN upstream → Postgres advances `confirmed_flush_lsn` → WAL segments can be recycled

> The LSN ack is what turns at-least-once into "actually reliable." If Kafka is down, the WAL accumulates. When Kafka recovers, you replay from the unacked LSN.

Discuss the failure modes:
- OwlPost dies mid-batch → restart resumes from `confirmed_flush_lsn`, replays unacked events; idempotency falls on the Kafka consumer side (event.Id is UUIDv7, dedupe on it)
- Kafka down for hours → WAL bloats; you need an alerting rule on `pg_replication_slots.confirmed_flush_lsn` lag

### 6. Distributed tracing through the WAL
This is unique. Most outbox implementations drop trace context.
- `Fact.TraceInfo` carries traceId/spanId/parent_op/is_sampled
- Marshaled into protobuf, written to WAL
- OwlPost reconstructs trace context, attaches as Kafka headers, downstream consumers continue the span
- This means a transaction in service A produces a Jaeger trace that includes the Kafka consume in service B — across a WAL stream

Show the proto fields and the Kafka header path.

### 7. Reliability proof — the LSN dance
Walk through 4 scenarios with diagrams:
1. Happy path: emit → WAL → consumer → Kafka ack → LSN ack → confirmed_flush advances
2. Producer crash mid-emit: txn rolls back → no WAL message → no event leaked
3. Consumer crash post-Kafka, pre-LSN-ack: restart, replay, dedupe at consumer
4. Kafka down: WAL accumulates, consumer retries, eventually drains

Cite the commit `45f9f13 feat(kafka ack): Reliability 100%`.

### 8. Ordering & throughput
- Per-aggregate ordering: Kafka partition by `aggregateId` → strict order per entity
- Cross-aggregate ordering: not guaranteed (you wouldn't want it; serialize on what you actually need)
- Throughput: emit is one extra `SELECT` per txn; estimate the Postgres CPU cost (function call + bytea copy + WAL bytes)
- WAL volume per event ≈ `header (24B) + prefix + protoBytes` — show the byte math
- At 10k events/sec, ~3 MB/sec of additional WAL — manageable

### 9. When NOT to use this
- Cross-database transactions (you have ONE Postgres; if writes span DBs, you need 2PC or sagas)
- Non-Postgres backends — MySQL has nothing equivalent (binlog ROW format ≠ logical messages)
- Ultra-high event rates (100k+/sec) — at this point the WAL is your bottleneck and you want a dedicated event store (Kafka itself, EventStoreDB)
- Schemas that change often — protobuf evolution rules apply; you still need a registry discipline

### 10. The Python client
Briefly: `python/factlib/index.py` ships a Django-friendly emitter. Same protobuf, same `pg_logical_emit_message`, polyglot fan-in works because the WAL doesn't care about the producer language.

## Comparison table (must include)

| Approach | Atomicity | Polling | Schema migration | Cleanup | Ordering | Tracing |
|---|---|---|---|---|---|---|
| Dual-write | ❌ | n/a | none | none | weak | manual |
| Outbox table + poll | ✅ | yes | yes | needed | per-row | manual |
| Outbox table + Debezium | ✅ | no (WAL) | yes | needed | per-row | manual |
| **factlib (logical messages)** | ✅ | no (WAL) | **none** | **automatic (WAL recycle)** | per-aggregate | **in WAL** |

## Stretch

- bpftrace one-liner counting `pg_logical_emit_message` calls
- A 50-line Go example a reader can copy-paste
- Discussion of `pgoutput` v1 vs v2 protocol
- A note on `walSender` connection limits (`max_wal_senders`)

## Build verification

```bash
cd /Users/pratikgajjar/ambitious/go-backend.how
hugo --quiet -D 2>&1 | tail -20
```

If theme `claret` looks wrong, fall back to `wisteria` or `coral`.

## Stop conditions

- 3000–5000 words.
- All 10 sections present (renames OK).
- Hugo build clean.
- Then announce "DRAFT READY" and wait for reviewer feedback.

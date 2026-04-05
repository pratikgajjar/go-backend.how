+++
title = "🚂 Temporal — Under the Hood"
description = "What actually happens when you start a Temporal workflow? We trace every SQL statement, count the event-history nodes, and then watch Absurd — a 5-table, single-SQL-file system — do the same job with one-fifth the queries and twenty-times the throughput."
date = 2026-04-05T12:00:00+05:30
lastmod = 2026-04-05T12:00:00+05:30
publishDate = "2026-04-05T12:00:00+05:30"
draft = false
tags = ["temporal", "durable-execution", "workflows", "postgres", "system-design"]
images = []
theme = "teal"
+++

# The setup

A Temporal install on Postgres creates **37 tables**. A 3-activity workflow
executes **~145 SQL statements** against 16 of them. A comparable system
called Absurd — by Armin Ronacher, it came out five months ago — does the
same 3-step job with **~32 SQL statements** against 3 tables (of 5 in its
per-queue schema), at ~20× the throughput on the same hardware.

So the obvious question is: **what are those extra ~113 queries buying you?**

That's what this post is about. I'm going to:

1. Walk through Temporal's internal schema — what each of the 37 tables is for
2. Trace exactly what happens in Postgres when a workflow runs
3. Do the same for [Absurd](https://github.com/earendil-works/absurd) as the counterpoint
4. Benchmark both on the same hardware, fairly
5. Talk about when each one is worth it

This isn't a "Temporal is overkill" post — it's a "let's see what you're
paying for" post.

# What is Temporal?

Temporal is an open-source durable execution system that abstracts away the
complexity of building scalable, reliable distributed systems. It preserves
complete application state so that on host or software failure it can migrate
execution to another machine and keep going as if nothing happened.

Almost everyone is in distributed-systems land without realising. A microservice
making a network call looks like this:

{{< figure src="sample-app.svg" title="Next Gen app" alt="Wireframes of basic app" >}}

Step 3 can fail for a dozen reasons — buggy code, a network blip, the
third-party is down, the instance is gone. How do you guarantee that the call
happened *at least once* and that the system converges?

Here are the common approaches:

1. [Saga](https://microservices.io/patterns/data/saga.html)
2. [CQRS — Command Query Responsibility Segregation](https://microservices.io/patterns/data/cqrs.html)
3. [Event sourcing](https://microservices.io/patterns/data/event-sourcing.html)
4. [Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern) _must read_
5. Durable Functions / Workflow Engine

This post is about the last one — and specifically, about what it _costs_ to
run it.

## Durable Execution Systems

Apart from [temporal.io](https://temporal.io/), there is an entire zoo:

| System | Runtime | Storage | License | Notes |
|---|---|---|---|---|
| [Temporal](https://temporal.io/) | Go server | Pluggable (Postgres, MySQL, Cassandra) | MIT | Fork of Cadence |
| [Cadence](https://github.com/cadence-workflow/cadence) | Go server | same | MIT | The original, by Uber |
| [Conductor](https://conductor-oss.org/) | Java server | Dynomite / Postgres | Apache-2.0 | By Netflix |
| [Restate](https://restate.dev/) | Rust server | own storage | BSL | Promising, single-binary |
| [DBOS](https://docs.dbos.dev/) | Python/TS SDK | Postgres | MIT | SDK-heavy, 40k LOC Python |
| [Inngest](https://www.inngest.com/) | Go server | Postgres | SSPL | Event-driven, HTTP-based |
| [Absurd](https://github.com/earendil-works/absurd) | *none* (SDK only) | Postgres | Apache-2.0 | One SQL file, pull-based |
| [CloudFlare Workflows](https://developers.cloudflare.com/workflows/) | Workers runtime | Cloudflare | proprietary | Vendor-locked |
| [AWS Step Functions](https://aws.amazon.com/step-functions/) | AWS | AWS | proprietary | Vendor-locked |
| [Azure Durable Functions](https://learn.microsoft.com/en-us/azure/azure-functions/durable/) | Azure | Azure Storage | proprietary | Vendor-locked |

We're going to look at two of these in depth — the one that everyone cites as
the "real" solution (Temporal) and the one that fits on a napkin (Absurd).

# Vocabulary

Before we dig, let's agree on terms. Both systems use them, but spell them
slightly differently.

| Temporal | Absurd | What it is |
|---|---|---|
| Workflow | Task | The top-level durable function |
| Activity | Step | A checkpointed unit of work inside a workflow |
| Worker | Worker | A process that pulls work and runs user code |
| Task Queue | Queue | A logical dispatch lane |
| Workflow run | Run | One execution attempt of a task |
| Event History | Checkpoints | The replay state |
| Signal | Event | External wake-up |

The **activity/step** is the hinge: once it completes, its result is
persisted, and re-executing the workflow will skip it. That's what makes the
whole thing "durable".

# Basics — the runtime model

{{< figure src="temporal-svc.svg" title="Temporal runtime" alt="Diagram showing worker and temporal backend connected" width="auto" >}}

1. **Workers** (your code) talk to the **Temporal server** via gRPC.
2. The **Temporal server** uses a database-specific protocol to read and write state.

Your worker is stateless. The Temporal server itself is split into _four
internal services_: **frontend** (gRPC terminator), **history** (workflow
state machine), **matching** (task dispatch), and **worker** (internal
maintenance workflows — confusingly named, nothing to do with _your_
workers). All four talk to the same database. When you scale Temporal
horizontally, you scale those services, not your database (until you do).

# Under the hood

Let's look under the hood. I'm going to use Postgres because it's the easiest
backend to inspect, and because it exposes the scaling story cleanly. At the
end, most production Temporal clusters end up database-bound — the server
services are stateless, the database is not.

## The schema

A fresh Temporal 1.28 auto-setup installs **37 tables** into your database.
Here are the ones that matter:

```txt
shards                   ─ owns a range of workflows (the unit of sharding)
executions               ─ current workflow state (blob, protobuf-encoded)
current_executions       ─ "which run_id is current for this workflow_id"
history_node             ─ event history (append-only, replayed on load)
history_tree             ─ branch metadata for history_node
tasks                    ─ matching service queues (dispatches activities)
task_queues              ─ matching service queue metadata
transfer_tasks           ─ "schedule an activity" intents
timer_tasks              ─ "wake me up at time T" intents
visibility_tasks         ─ "update the search index" intents
replication_tasks        ─ cross-cluster replication queue
activity_info_maps       ─ in-flight activity metadata per workflow
timer_info_maps          ─ user timers per workflow
buffered_events          ─ events waiting to be written to history
cluster_membership       ─ which server nodes are alive
namespaces               ─ tenant isolation
```

Plus another 20 tables for request cancellations, signals, child workflows,
chasm nodes, namespace metadata, nexus endpoints, replication DLQ, schema
versioning, etc.

Every one of these tables is there to support a _specific_ distributed-systems
guarantee. Let's unpack the important ones.

## Sharding: workflows → shards

When a workflow is created, Temporal computes which shard owns it:

```go
// common/util.go — upstream Temporal source
func WorkflowIDToHistoryShard(
    namespaceID string,
    workflowID string,
    numberOfShards int32,
) int32 {
    idBytes := []byte(namespaceID + "_" + workflowID)
    hash := farm.Fingerprint32(idBytes)
    return int32(hash%uint32(numberOfShards)) + 1
}
```

A `(namespace_id, workflow_id)` pair hashes to a **shard_id**. That shard is
owned by one history service instance. Every write for that workflow —
executions, history events, scheduled tasks — goes to that shard.

The default `numHistoryShards` in dev is 4. A production cluster uses 512 or
2048. **You cannot change this number without re-sharding your database**, so
people tend to over-provision it upfront.

The shard table itself looks like this:

```sql
CREATE TABLE shards (
    shard_id integer NOT NULL,
    range_id bigint  NOT NULL,   -- monotonic fencing token
    data        bytea   NOT NULL,
    data_encoding varchar(16) NOT NULL,
    CONSTRAINT shards_pkey PRIMARY KEY (shard_id)
);
```

`range_id` is a fencing token. Before a history service processes any workflow
on a shard, it bumps `range_id` via `UPDATE shards SET range_id = range_id + 1`.
Any other instance that tries to write with a stale `range_id` gets rejected.
This is how Temporal guarantees that only one host is mutating a workflow's
state at a time.

You will see `SELECT range_id FROM shards WHERE shard_id = $1 FOR SHARE`
on **every** workflow mutation. We'll count them below.

## The executions table: current state

This is where a workflow's current state lives:

```sql
CREATE TABLE executions (
    shard_id             integer NOT NULL,
    namespace_id         bytea   NOT NULL,
    workflow_id          varchar(255) NOT NULL,
    run_id               bytea   NOT NULL,
    next_event_id        bigint  NOT NULL,
    last_write_version   bigint  NOT NULL,
    data                 bytea   NOT NULL,   -- protobuf-encoded WorkflowMutableState
    data_encoding        varchar(16) NOT NULL,
    state                bytea   NOT NULL,
    state_encoding       varchar(16) NOT NULL,
    db_record_version    bigint  NOT NULL DEFAULT 0,
    PRIMARY KEY (shard_id, namespace_id, workflow_id, run_id)
);
```

The `data` column holds a protobuf-serialised `WorkflowMutableState` — the
complete current state of the workflow, including pending activities, timers,
child workflows, and so on. It's a single blob that Temporal reads, mutates
in memory, and writes back.

`db_record_version` is **another fencing token** — this one for
optimistic-concurrency writes on individual workflows. Combined with `range_id`,
Temporal guarantees single-writer semantics at two levels: shard and workflow.

## history_node: the event log

Now the interesting one. Temporal is fundamentally **event-sourced**: the
authoritative state of every workflow is the sequence of events it emitted,
not the `executions` blob. The blob is just a cache.

```sql
CREATE TABLE history_node (
    shard_id      integer NOT NULL,
    tree_id       bytea   NOT NULL,
    branch_id     bytea   NOT NULL,
    node_id       bigint  NOT NULL,
    prev_txn_id   bigint  NOT NULL,
    txn_id        bigint  NOT NULL,
    data          bytea   NOT NULL,       -- batch of protobuf events
    data_encoding varchar(16) NOT NULL,
    PRIMARY KEY (shard_id, tree_id, branch_id, node_id, txn_id)
);
```

A single "node" contains a batch of events. Let me show you what a
3-activity workflow actually writes.

This is the full history of one `OrderFulfillmentWorkflow` execution from my
benchmark, which calls three activities in sequence:

```txt
 1  WorkflowExecutionStarted   {WorkflowType:OrderFulfillmentWorkflow, Input:...}
 2  WorkflowTaskScheduled      {TaskQueue:order-fulfillment-q, Attempt:1}
 3  WorkflowTaskStarted        {ScheduledEventId:2, Identity:36960@host}
 4  WorkflowTaskCompleted      {ScheduledEventId:2, StartedEventId:3}
 5  ActivityTaskScheduled      {ActivityId:5, ActivityType:ProcessPayment, ...}
 6  ActivityTaskStarted        {ScheduledEventId:5, Attempt:1}
 7  ActivityTaskCompleted      {Result:[{"PaymentID":"pay-order-...","Amount":5922}]}
 8  WorkflowTaskScheduled      {TaskQueue:Sticky, StartToCloseTimeout:10s}
 9  WorkflowTaskStarted        {ScheduledEventId:8}
10  WorkflowTaskCompleted      {ScheduledEventId:8, StartedEventId:9}
11  ActivityTaskScheduled      {ActivityId:11, ActivityType:ReserveInventory, ...}
12  ActivityTaskStarted        {ScheduledEventId:11}
13  ActivityTaskCompleted      {Result:[{"ReservedItems":[...]}]}
14  WorkflowTaskScheduled      ...
15  WorkflowTaskStarted        ...
16  WorkflowTaskCompleted      ...
17  ActivityTaskScheduled      {ActivityType:SendNotification, ...}
18  ActivityTaskStarted        ...
19  ActivityTaskCompleted      ...
20  WorkflowTaskScheduled      ...
21  WorkflowTaskStarted        ...
22  WorkflowTaskCompleted      ...
23  WorkflowExecutionCompleted {Result:...}
```

**23 events** for 3 activities. The pattern per activity is:

```txt
┌─────────────────────────┐
│ ActivityTaskScheduled   │   ← workflow decided to run it
│ ActivityTaskStarted     │   ← worker picked it up
│ ActivityTaskCompleted   │   ← worker returned result
│ WorkflowTaskScheduled   │   ← workflow wakes up again
│ WorkflowTaskStarted     │   ← worker runs the workflow code
│ WorkflowTaskCompleted   │   ← workflow made next decision
└─────────────────────────┘   = 6 events per activity
```

Plus 4 framing events (`WorkflowExecutionStarted`, then the first workflow
task's Scheduled/Started/Completed trio) and 1 to finish
(`WorkflowExecutionCompleted`). So: **`4 + 6×N + 1`** events per N-activity
workflow. For N=3 that's 23. Every one is a proto-serialised row in
`history_node`.

**Why all this ceremony?** Because replay is deterministic. If your worker
crashes mid-workflow, Temporal replays the entire event history against your
workflow code — which *must* be deterministic — and the SDK routes every
`ExecuteActivity` call to its already-recorded result instead of executing it
again. The 23 events are what makes that replay possible.

## The four internal task queues

When a workflow decides to schedule an activity, _that intent_ is a row written
to `transfer_tasks`. A separate loop in the history service picks it up and
tells the matching service to dispatch it. Here's the rough flow:

```txt
user code: "ExecuteActivity(ProcessPayment)"
    │
    ▼
┌───────────────────────────────┐
│ history service               │
│  1. appends to history_node   │
│  2. inserts into              │
│     transfer_tasks            │   ← "schedule this activity"
│  3. updates executions blob   │
│  4. bumps shards.range_id     │
└───────────────────────────────┘
    │
    ▼
┌───────────────────────────────┐
│ history service transfer loop │
│  SELECT from transfer_tasks   │
│  → call matching.AddTask      │
└───────────────────────────────┘
    │
    ▼
┌───────────────────────────────┐
│ matching service              │
│  INSERT INTO tasks            │   ← actual dispatch queue
└───────────────────────────────┘
    │
    ▼
┌───────────────────────────────┐
│ worker long-polls matching    │
│ SELECT FROM tasks             │
│ FOR UPDATE SKIP LOCKED        │
└───────────────────────────────┘
```

There is a similar loop for `timer_tasks` (scheduled wake-ups), `visibility_tasks`
(search index updates), and `replication_tasks` (cross-cluster replication).
Four background loops per history service, all polling the database.

## A real query trace

Enough words. Let's actually run a Temporal workflow and count what Postgres
sees. I spun up Postgres 17 and Temporal 1.28.2 inside a Podman Linux VM on
an M4 Mac mini, enabled `pg_stat_statements`, and ran **500 workflows with 3
activities each**.

Here are the top queries by call count, after `pg_stat_statements_reset()`:

```sql
 calls | avg_ms | per-wf | query
-------+--------+--------+-------------------------------------------------------
  7500 |  0.003 |   15   | SELECT range_id FROM shards WHERE shard_id=$1 FOR SHARE
  7000 |  0.006 |   14   | SELECT ... FROM executions WHERE shard_id=$1 AND ...
  7000 |  0.006 |   14   | UPDATE executions SET ... WHERE shard_id=$1 AND ...
  7000 |  0.007 |   14   | SELECT ... FROM current_executions WHERE ...
  7000 |  0.006 |   14   | UPDATE current_executions SET ...
  6000 |  0.009 |   12   | INSERT INTO history_node (...)
  5500 |  0.005 |   11   | INSERT INTO timer_tasks (...)
  4000 |  0.004 |    8   | INSERT INTO transfer_tasks(...)
  3000 |  0.009 |    6   | INSERT INTO activity_info_maps (...)
  2500 |  0.009 |    5   | SELECT ... FROM history_node WHERE ...
  1516 |  0.006 |    3   | SELECT range_id FROM task_queues ... FOR UPDATE
  1500 |  0.005 |    3   | DELETE FROM activity_info_maps ...
  1500 |  0.008 |    3   | INSERT INTO visibility_tasks(...)
  1162 |  0.023 |    2   | INSERT INTO tasks(...)
   932 |  0.009 |    2   | SELECT task_id, data FROM tasks WHERE ... LIMIT ...
```

Counting every non-trivial statement (ignoring `BEGIN`/`COMMIT`/`SET`) gives
**~145 SQL statements per 3-activity workflow**. Across 16 different tables.

That's not a bug. That's the cost of event sourcing with strict ordering and
fencing. Each activity requires: read current state, append events, update
blob, schedule transfer task, schedule timer for timeout, update activity map,
bump range_id. On completion: same pattern in reverse. Every statement is
fast — 0.003 to 0.023 ms — but there are a lot of them.

## How does it scale per activity?

This is the part I really wanted to pin down. I ran the same 200-workflow
benchmark but with 1, 3, 5, and 10 no-op activities per workflow, resetting
`pg_stat_statements` each time:

| activities | total SQL | per-workflow | throughput |
|-----------:|----------:|-------------:|-----------:|
|     1      |  15,159   |     **75.7** |    35.1/s  |
|     3      |  28,978   |    **144.8** |    43.3/s  |
|     5      |  42,811   |    **214.0** |    28.2/s  |
|    10      |  77,054   |    **385.2** |    16.6/s  |

Subtract row-to-row:

```txt
(144.8 − 75.7) / (3 − 1) = 34.55 queries per additional activity
(214.0 − 144.8) / (5 − 3) = 34.60 queries per additional activity
(385.2 − 214.0) / (10 − 5) = 34.24 queries per additional activity
```

The per-activity slope is **~35 SQL statements**, independent of N.  The
baseline (fixed cost to start and complete any workflow) is about **40
queries**, so:

```
Temporal cost model:  ~40 + 35 × N   SQL statements per workflow
                                     (where N = activity count)
```

Where do the 35 per-activity queries land? I diffed the N=1 and N=5 runs
and computed the delta per activity:

| Per-activity ops                | N=1  | N=5   | delta÷4 |
|---------------------------------|-----:|------:|--------:|
| UPDATE executions               |  6.0 | 22.0  |  **4**  |
| SELECT FROM executions          |  6.0 | 22.0  |  **4**  |
| UPDATE current_executions       |  6.0 | 22.0  |  **4**  |
| SELECT FROM current_executions  |  6.0 | 22.0  |  **4**  |
| SELECT range_id FROM shards     |  7.0 | 23.0  |  **4**  |
| INSERT INTO history_node        |  6.0 | 18.0  |  **3**  |
| INSERT INTO timer_tasks         |  5.0 | 17.0  |  **3**  |
| INSERT INTO activity_info_maps  |  2.0 | 10.0  |  **2**  |
| INSERT INTO transfer_tasks      |  4.0 | 12.0  |  **2**  |
| SELECT FROM history_node        |  3.0 |  7.0  |  **1**  |
| DELETE FROM activity_info_maps  |  1.0 |  5.0  |  **1**  |
| INSERT INTO tasks (matching)    |  1.2 |  3.9  |  **0.7**|
| SELECT FROM tasks (matching)    |  1.0 |  3.1  |  **0.5**|
| SELECT/UPDATE task_queues       |  1.5 |  5.1  |  **0.9**|
|                                 |      | **sum**| **~34** |

Each activity triggers:

- **4×** fencing writes (shard range_id, executions × 2, current_executions × 2)
- **3×** history event writes (schedule, start, complete) into `history_node`
- **3×** timer task inserts (retry timeouts, heartbeat timeouts, schedule-to-start)
- **2×** activity lifecycle writes (transfer task enqueue + dispatch via matching)
- **2×** activity metadata writes (insert on schedule, delete on completion)
- **1×** history read for replay
- **~1×** matching service round-trip via `tasks`/`task_queues`

That is the decomposition of the 35. None of it is wasted — every statement
corresponds to a specific distributed-systems guarantee. But every
statement **also** corresponds to a row you've got to vacuum, a WAL entry
you've got to flush, and a lock you've got to acquire.

Run these numbers against your own workflow: a 20-activity checkout flow is
~740 SQL statements against 16 tables, per checkout. On a 1K-checkouts/sec
service, that's **740,000 statements/sec in Postgres**. Sharding and
matching replicas scale horizontally, but the database is where the meter
ticks.

## Storage cost

After running **5000 workflows** end-to-end:

```txt
Temporal tables (5000 workflows × 3 activities each)
───────────────────────────────────────────────────
history_node              91,522 rows      44 MB
executions                 7,638 rows      12 MB
timer_tasks               15,661 rows      10 MB
transfer_tasks             2,676 rows    7.4 MB
tasks                        247 rows    6.2 MB
current_executions         7,646 rows    3.7 MB
history_tree               7,669 rows    3.5 MB
visibility_tasks           1,762 rows    2.3 MB
activity_info_maps            16 rows    2.6 MB  ← big indexes
task_queues                   67 rows    344 kB
────────────────────────────────────────────────────
total                                     93 MB
```

The `history_node` table alone is 44 MB — on average **~285 bytes per event,
23 events per workflow, 6500 workflows**. That's Temporal's "receipts file",
and **it never goes away** unless you explicitly configure history retention.

Even `activity_info_maps` is interesting: 16 live rows, but 2.6 MB because
its btree indexes are not yet vacuumed. Temporal churns this table hard —
insert on schedule, delete on completion, insert again on retry. Index
bloat is a known operational concern.

## Throughput

Running my 500-workflow benchmark with a single worker
(`MaxConcurrentActivityExecutionSize=500`, `MaxConcurrentWorkflowTaskExecutionSize=500`)
and concurrent starts from a single client:

| Starts | Concurrency | Throughput | p50 ms | p99 ms | Max ms |
|--------|-------------|-----------:|-------:|-------:|-------:|
|   100  |      16     |   20.6/s   |   —    |   —    |   —    |
|   500  |      32     |   47.4/s   |   —    |   —    |   —    |
|  1000  |      64     |   65.6/s   |  660.9 | 2976.3 | 4799.4 |
|  5000  |     128     |   77.5/s   | 1049.6 | 7060.9 |13668.0 |

Adding spawn concurrency lifts throughput because Temporal's backend is doing
dozens of writes per workflow and the client bottleneck at 16 is the
round-trip time, not the backend. The backend saturates near ~80 workflows/s
on this hardware — **~8000 SQL statements/s across all those tables**.

This is a single `auto-setup` pod on a 4-CPU VM. Real Temporal clusters run
history/matching as separate replicas and scale linearly with database IOPS.
But the ratio of "SQL statements per workflow" is constant. You pay it always.

---

Now let's look at the other extreme.

# Absurd: the Postgres-only counterpart

[Absurd](https://github.com/earendil-works/absurd) was built by Armin Ronacher
(of Flask / Jinja fame) for Earendil's agent workloads. It's a **single `.sql`
file** — 1,685 lines — that installs a durable-execution engine into your
existing Postgres. There is no server. There are no microservices. The SDK is
under 2,000 lines of code per language. You apply the SQL, create a queue,
connect workers, and go.

It came out in November 2025. I ran the same benchmark against it.

## The schema

When you call `create_queue('default')`, Absurd generates **five tables**
with a `<prefix>_default` name:

```sql
t_default   ─ tasks (the durable work units)
r_default   ─ runs (execution attempts per task)
c_default   ─ checkpoints (persisted step results)
e_default   ─ events (external signals, first-write-wins)
w_default   ─ wait registrations (sleeping on events)
```

That's it. There is no shard table, no history log, no transfer queue.
Three of the five tables carry the primary workload (tasks, runs,
checkpoints); the other two (`e_`, `w_`) only grow when you use events. The
full schema for one queue:

```sql
CREATE TABLE absurd.t_default (
    task_id            uuid PRIMARY KEY,
    task_name          text NOT NULL,
    params             jsonb NOT NULL,
    headers            jsonb,
    retry_strategy     jsonb,
    max_attempts       integer,
    cancellation       jsonb,
    enqueue_at         timestamptz NOT NULL,
    first_started_at   timestamptz,
    state              text CHECK (state IN ('pending','running','sleeping',
                                             'completed','failed','cancelled')),
    attempts           integer NOT NULL DEFAULT 0,
    last_attempt_run   uuid,
    completed_payload  jsonb,
    cancelled_at       timestamptz,
    idempotency_key    text UNIQUE
) WITH (fillfactor=70);

CREATE TABLE absurd.r_default (
    run_id            uuid PRIMARY KEY,
    task_id           uuid NOT NULL,
    attempt           integer NOT NULL,
    state             text CHECK (state IN (...)),
    claimed_by        text,
    claim_expires_at  timestamptz,
    available_at      timestamptz NOT NULL,
    wake_event        text,
    event_payload     jsonb,
    started_at        timestamptz,
    completed_at      timestamptz,
    failed_at         timestamptz,
    result            jsonb,
    failure_reason    jsonb,
    created_at        timestamptz NOT NULL
) WITH (fillfactor=70);

CREATE TABLE absurd.c_default (
    task_id          uuid NOT NULL,
    checkpoint_name  text NOT NULL,
    state            jsonb,
    status           text DEFAULT 'committed',
    owner_run_id     uuid,
    updated_at       timestamptz NOT NULL,
    PRIMARY KEY (task_id, checkpoint_name)
) WITH (fillfactor=70);
```

`fillfactor=70` leaves slack in each page for HOT updates — a Postgres trick
to keep update-heavy tables fast. The rest is boring. Just rows.

## The claim loop

Every Absurd worker runs this function, via stored procedure:

```sql
CREATE FUNCTION absurd.claim_task(
  p_queue_name    text,
  p_worker_id     text,
  p_claim_timeout integer DEFAULT 30,
  p_qty           integer DEFAULT 1
) RETURNS TABLE (
  run_id uuid, task_id uuid, attempt integer, task_name text,
  params jsonb, retry_strategy jsonb, max_attempts integer,
  headers jsonb, wake_event text, event_payload jsonb
) AS $$
DECLARE
  v_now timestamptz := absurd.current_time();
  v_claim_until timestamptz := v_now + make_interval(secs => p_claim_timeout);
BEGIN
  -- 1. Cancel tasks whose deadline has passed
  -- 2. Sweep expired claims (fail the runs)
  -- 3. The main claim query:
  RETURN QUERY
  WITH candidate AS (
    SELECT r.run_id
    FROM absurd.r_default r
    JOIN absurd.t_default t ON t.task_id = r.task_id
    WHERE r.state IN ('pending', 'sleeping')
      AND t.state IN ('pending', 'sleeping', 'running')
      AND r.available_at <= v_now
    ORDER BY r.available_at, r.run_id
    LIMIT p_qty
    FOR UPDATE SKIP LOCKED              -- ← the whole secret
  ),
  updated AS (
    UPDATE absurd.r_default r
       SET state = 'running',
           claimed_by = p_worker_id,
           claim_expires_at = v_claim_until,
           started_at = v_now,
           available_at = v_now
     WHERE run_id IN (SELECT run_id FROM candidate)
    RETURNING r.run_id, r.task_id, r.attempt
  )
  -- task update + wait cleanup + return fields ...
END;
$$;
```

`SELECT ... FOR UPDATE SKIP LOCKED` [was added to Postgres 9.5 in
2016](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/)
specifically for this use case: multiple consumers can poll the same queue
without blocking each other. This is also the basis for
[pgmq](https://github.com/pgmq/pgmq), [River](https://riverqueue.com/), and
a half-dozen other Postgres-native queues. Absurd just layers state machines
and checkpoints on top.

## A step is just a checkpoint

Here's what the Absurd worker does for each task:

```go
// Pseudocode — the real SDK wraps this more ergonomically
for step in ["process-payment", "reserve-inventory", "send-notification"]:
    cached = get_task_checkpoint_state(queue, task_id, step)
    if cached is not NULL:
        result = cached                    # replay path — cheap
    else:
        result = run_step_body()
        set_task_checkpoint_state(queue, task_id, step, result, run_id, claim_timeout)
complete_run(queue, run_id, result)
```

If the process dies mid-task, another worker picks up the same task (its lease
expires), calls `claim_task`, and starts from step 1 again. Steps that already
checkpointed return their cached value immediately. No event replay, no
deterministic-execution constraint — just "if the checkpoint is there, use it".

This is the philosophical difference from Temporal:

| | Temporal | Absurd |
|---|---|---|
| Replay model | Deterministic re-execution of workflow code | Re-run code, short-circuit on checkpoints |
| Code constraint | Workflow code must be deterministic | None — use `random()`, `now()`, whatever |
| State source | Event history (append-only) | Checkpoint table (last-write-wins by attempt) |
| Code between steps | Must be deterministic & bounded | Runs however many times it runs |

The Absurd model is weaker — you can re-run an LLM call or a random number
generator between steps, and the system doesn't care — but the mental model
is dramatically simpler.

## A real query trace

After running **5000 Absurd tasks** with 3 steps each:

```sql
 calls | avg_ms | per-task | query
-------+--------+----------+---------------------------------------
  5000 |  0.195 |    1     | SELECT ... FROM absurd.spawn_task(...)
 15000 |  0.342 |    3     | SELECT absurd.set_task_checkpoint_state(...)
 15000 |  0.036 |    3     | SELECT absurd.get_task_checkpoint_state(...)
  5000 |  0.151 |    1     | SELECT absurd.complete_run(...)
  4420 |  0.618 |   ~0.88  | (claim_task internals)
```

**~32 SQL statements per 3-step task**, touching only 3 of the 5 tables
(`t_`, `r_`, `c_`; `e_` and `w_` are unused because we don't emit events).
Running the same
1/3/5/10 scaling experiment:

| steps | total SQL | per-task | throughput |
|------:|----------:|---------:|-----------:|
|   1   |   3,543   | **17.7** | 1,724/s    |
|   3   |   6,406   | **32.0** | 1,206/s    |
|   5   |   9,216   | **46.1** |   908/s    |
|  10   |  16,236   | **81.2** |   546/s    |

Subtract row-to-row:

```txt
(32.0 − 17.7) / (3 − 1) = 7.15 queries per additional step
(46.1 − 32.0) / (5 − 3) = 7.05 queries per additional step
(81.2 − 46.1) / (10 − 5) = 7.02 queries per additional step
```

The per-step slope is **~7 SQL statements**, flat. The baseline is about
**11 queries** for spawn + claim-share + complete, so:

```
Absurd cost model:  ~11 + 7 × N   SQL statements per task
                                  (where N = step count)
```

Side-by-side:

```txt
          SQL statements per N-activity work unit
                                                             [~35 × N]
          400 ─┐                                              ┌
               │                                              │
          300 ─┤                                      ┌───────┤
               │                                      │       │
          200 ─┤                              ┌───────┤       │
               │                              │       │       │
          100 ─┤                      ┌───────┤       │       │
               │              ┌───────┤       │       │       │
               │  ┌───────────┤       │       │       │       │
            0 ─┴──┴───────────┴───────┴───────┴───────┴───────┘
               │        │              │              │
              N=1      N=3            N=5            N=10

          Temporal:  75.7 → 144.8 → 214.0 → 385.2  (slope ≈ 35)
          Absurd:    17.7 →  32.0 →  46.1 →  81.2  (slope ≈ 7)
```

**A Temporal activity costs about 5× as many SQL statements as an Absurd
step.** That ratio stays constant as you add more units of work.

Each Absurd step is:
- 1 checkpoint read (returns empty on first run, cached value on replay)
- 1 checkpoint write (on first run)
- plus amortized claim polling and implicit internal queries in the SPs

Task lifecycle is:
- 1 spawn_task (inserts a row in `t_` and `r_`)
- N step reads + N step writes
- 1 complete_run (marks `r_` as completed, `t_` as completed, clears `w_`)
- Plus your share of claim polling (batched)

The average `set_task_checkpoint_state` takes 0.342ms — slightly more than
Temporal's raw inserts because it's a full stored procedure with multiple
updates inside it. But there are an order of magnitude fewer round trips.

## Storage cost

Same 5000-task workload:

```txt
Absurd tables (5000 tasks × 3 steps each)
──────────────────────────────────────────
c_default (checkpoints)  21,300 rows   6.4 MB
r_default (runs)          7,100 rows   3.8 MB
t_default (tasks)         7,100 rows   3.2 MB
queues                        1 rows    32 kB
──────────────────────────────────────────
total                                  13 MB
```

- 3 checkpoint rows per task (one per step).
- 1 run row per attempt (on first-try success, 1 row per task).
- 1 task row per task.

No event history means no 44 MB `history_node`. **Absurd stores ~7× less
per task.**

## Throughput

Same hardware, same workload:

| Starts | Concurrency | Workers | Throughput | p50 ms | p99 ms | Max ms |
|--------|-------------|--------:|-----------:|-------:|-------:|-------:|
|   100  |     16      |   8     |  698.6/s   |   —    |   —    |   —    |
|  1000  |     64      |   8     | 1435.8/s   |  285.4 | 518.9  |  524.0 |
|  5000  |    128      |  16     | 1450.6/s   | 1564.5 |2705.1  | 2729.4 |

Absurd saturates around 1,450 tasks/s — **~20× higher throughput** than
Temporal on identical hardware (22× at N=1000, 19× at N=5000), and much
tighter tail latencies (519 ms p99 vs 2976 ms p99 at N=1000). On this
hardware Postgres plus 16 worker goroutines is the bottleneck, not
anything Absurd does.

# Single-workflow round-trip latency

Throughput under load is one axis; latency for a _single_ workflow is
another. If you throw one workflow at each system at a time and wait for
completion before starting the next:

| N  | Temporal p50 | Absurd p50 | ratio |
|---:|-------------:|-----------:|------:|
|  1 |     13.4 ms  |   10.2 ms  |  1.3× |
|  3 |     27.7 ms  |   11.4 ms  |  2.4× |
|  5 |     41.1 ms  |   11.3 ms  |  3.6× |
| 10 |     69.1 ms  |   12.6 ms  |  5.5× |

The per-activity latency slope is **~6.2 ms in Temporal** versus **~0.27 ms
in Absurd** — a 23× difference per unit of work. Each Absurd step is
essentially just a single `set_task_checkpoint_state` stored-procedure call
(0.342 ms measured). Each Temporal activity routes through the matching
service's dispatch loop, a decision round-trip back to the worker, then
history event persistence — several network hops per activity, even on a
single-node deploy.

Temporal's long-tail latency is also more dramatic: the p90 for a
10-activity workflow was **1.04 seconds**, with most of that variance
attributable to matching-service dispatch jitter (sticky queue falling
back to normal dispatch). Absurd's p99 for a 10-step task was **20.1 ms**
— essentially no tail.

# Head to head

Same workload (3-step order fulfillment), same hardware, same Postgres
instance, same VM:

```txt
┌──────────────────────────────────────┬────────────────┬─────────────┐
│                                      │   Temporal     │    Absurd   │
├──────────────────────────────────────┼────────────────┼─────────────┤
│ Tables in schema                     │      37        │   5 per q   │
│ SQL / unit of work (cost model)      │ ~40 + 35×N     │ ~11 + 7×N   │
│ SQL for a 3-unit workflow            │     145        │     32      │
│ Throughput (1k units @ c=64)         │    65.6/s      │  1,435.8/s  │
│ p50 latency (ms)                     │    660.9       │    285.4    │
│ p99 latency (ms)                     │   2,976.3      │    518.9    │
│ Storage / workflow                   │    ~15 kB      │    ~2 kB    │
│ Separate server process?             │     yes        │     no      │
│ Runtime deterministic constraint     │     yes        │     no      │
│ SDK LOC (Python, non-generated)      │    ~49,000     │    1,900    │
│ SDK LOC (TypeScript, non-generated)  │    ~38,000     │    1,400    │
│ Dependencies outside Postgres        │  gRPC server,  │    none     │
│                                      │  history svc,  │             │
│                                      │  matching svc, │             │
│                                      │  frontend svc  │             │
└──────────────────────────────────────┴────────────────┴─────────────┘
```

# What does Temporal buy you for that tax?

It would be too easy to read this as "Temporal is bloated, use Absurd." It
isn't. What Temporal gives you in exchange for the heavier machinery:

**1. Deterministic replay.** Your workflow code runs to completion, then the
worker process can die and a fresh one reconstructs the workflow by replaying
every event. This is powerful — you can write `if (x > 0) signalSomeone()`
and Temporal guarantees that on replay, `x` has the same value and the
branch is taken the same way. Absurd doesn't give you this; you have to
manually ensure that between-step code is idempotent.

**2. Signals, timers, child workflows as first-class primitives.** Temporal
has dedicated table machinery for signals (`signals_requested_sets`,
`signal_info_maps`), child workflows (`child_execution_info_maps`), and
user timers (`timer_info_maps`). You can `workflow.Signal()` a running workflow
from outside and Temporal routes it through matching with correct ordering.
Absurd has events, which are first-emit-wins and much simpler, but less
expressive.

**3. Battle-tested at Uber / Snap / Netflix scale.** Cadence (Temporal's
predecessor) powers Uber's workflow orchestration. Temporal itself is used
by Snap, Box, Coinbase, and many more. If your workflows span months or
cross data centers, you want that hardening.

**4. Versioning & replay migration.** When you update workflow code, Temporal
has [patched / version APIs](https://docs.temporal.io/dev-guide/typescript/versioning)
to keep old workflows replayable. Absurd's "re-run between checkpoints" model
lets you deploy any code — which is nice for agility, less nice for
correctness when you _want_ historical workflows to replay as they did before.

**5. Cross-cluster replication.** That `replication_tasks` table exists to
mirror workflow state to another DC. Temporal supports geo-redundant clusters.
Absurd is one Postgres instance — you can replicate Postgres, but you lose
the workflow-level replication semantics.

**6. A huge ecosystem.** UI, metrics, observability integrations, a CLI,
dozens of SDKs, a Temporal Cloud. When things go wrong at 3am, that matters.

From the [Absurd comparison docs](https://earendil-works.github.io/absurd/comparison/):

> Temporal gives you more, but asks for more:
>
> - you run **Temporal Server**, not just a database schema
> - the SDK runtime is more opinionated about how workflow code executes
> - the system exposes more first-class workflow concepts
> - the ecosystem, tooling, and battle-tested patterns are broader
>
> Absurd is intentionally less invasive. It does **not** try to turn your
> code into a deterministic workflow runtime. Instead, it relies on
> explicit step boundaries and persisted step results. This results in
> much simpler SDKs.

# When each one makes sense

**Pick Temporal when:**

- You already run a platform team that can operate gRPC services and a
  Postgres cluster that handles tens of thousands of IOPS.
- Your workflows span weeks/months, have complex versioning needs, use
  signals heavily.
- You need cross-DC replication or compliance-grade audit trails.
- You're buying the ecosystem (UI, SDKs in 7 languages, Temporal Cloud).

**Pick Absurd (or a Postgres-native system) when:**

- You want to self-host durable execution in an app you're shipping, without
  forcing your users to run another service.
- Your workflows are minutes-to-days-long, with straightforward retry
  semantics.
- You're writing agents or LLM pipelines where between-step code naturally
  varies (sampling, timestamps, non-determinism) and deterministic replay
  would actually get in the way.
- You want to read the entire engine in an afternoon.

**Pick something in between** (DBOS, Inngest, Restate) when your needs sit
between these poles. The space is young and healthy; the choices are better
than they were two years ago.

# The lesson

Temporal's complexity isn't incidental. Event sourcing, sharded fencing
tokens, separate matching/history/frontend services, and 37 tables are what
you need to build a distributed workflow runtime that scales to millions of
workflows, survives zone failures, and supports multi-decade workflow
lifetimes. If you need that, pay the tax.

Most of us don't. Most of the durable-execution needs I've seen in practice
are "run this 4-step thing, make sure it eventually finishes, retry on
failure, let me wait for this webhook." That's an afternoon's worth of SQL.

When [sirupsen's napkin
math](https://github.com/sirupsen/napkin-math) tells you to start with the
first-principles back of the envelope, this is what it looks like in the
workflow-engine domain. The two cost models I measured are:

```txt
Temporal:  ~40 + 35 × N   SQL statements per workflow
Absurd:    ~11 +  7 × N   SQL statements per task
           └───┘  └───┘
        scaffolding   per work unit
```

The ~5× ratio between them is _your_ operational cost — in query count, in
Postgres IOPS, in storage, and (ultimately) in machines. It's the price of
event-sourced, fenced, deterministic replay versus checkpoint-based resume.
If you need those guarantees, they're worth it. If you don't, you're
paying for insurance you won't cash in.

Pick the model that matches your problem's complexity. Don't pay for
invariants you don't need.

---

# Appendix: reproducing the benchmarks

Everything runs inside a Podman Linux VM on macOS — the same setup I used
for the [1B Payments/Day post](../1b-payments-per-day/). Full source and
setup scripts are in the bench/ directory of this site's repo.

**Hardware:** Apple M4 Pro Mac mini, 10 cores, 24 GB RAM, macOS 26.1
**VM:** Podman machine, 4 CPUs, 8 GB RAM, kernel 6.12 aarch64
**Software:** Postgres 17, Temporal 1.28.2 (auto-setup), Absurd @ main (April 2026)

The workflow in both systems is a 3-step "order fulfillment":

```go
// Temporal
func OrderFulfillmentWorkflow(ctx workflow.Context, params OrderParams) (string, error) {
    ao := workflow.ActivityOptions{StartToCloseTimeout: 30 * time.Second}
    ctx = workflow.WithActivityOptions(ctx, ao)
    var p PaymentResult;   _ = workflow.ExecuteActivity(ctx, ProcessPayment, params).Get(ctx, &p)
    var i InventoryResult; _ = workflow.ExecuteActivity(ctx, ReserveInventory, params).Get(ctx, &i)
    var n NotificationResult; _ = workflow.ExecuteActivity(ctx, SendNotification, params).Get(ctx, &n)
    return params.OrderID, nil
}
```

```go
// Absurd (hand-written worker, pseudo-SDK)
func runOrderFulfillment(t claimedTask) error {
    _, _ = step(ctx, "process-payment",    func() (...) { ... })
    _, _ = step(ctx, "reserve-inventory",  func() (...) { ... })
    _, _ = step(ctx, "send-notification",  func() (...) { ... })
    return complete_run(t.RunID, result)
}
```

Activities/steps are no-ops (return a small struct) so we measure
orchestration throughput, not user-code latency. Driver code in
`bench/temporal_driver/` and `bench/absurd_driver/` starts N workflows with
concurrency C and waits for completion.

Query counts come from `pg_stat_statements_reset()` before the run and a
scoped query against `pg_database.datname='temporal'` or `'absurd'` after.
Storage comes from `pg_total_relation_size()` per table.

---

# References

- [Absurd announcement — Armin Ronacher](https://lucumr.pocoo.org/2025/11/3/absurd-workflows/) (Nov 2025)
- [Absurd in production — Armin Ronacher](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/) (Apr 2026)
- [Absurd vs Temporal / Cadence / Inngest / PGMQ / DBOS](https://earendil-works.github.io/absurd/comparison/)
- [Absurd SQL source](https://github.com/earendil-works/absurd/blob/main/sql/absurd.sql) — the whole engine
- [Temporal source: `WorkflowIDToHistoryShard`](https://github.com/temporalio/temporal/blob/main/common/util.go) — how workflows map to shards
- [Temporal Postgres schema](https://github.com/temporalio/temporal/tree/main/schema/postgresql/v12/temporal/versioned)
- [What is SELECT … SKIP LOCKED for? — 2ndQuadrant](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/)
- [pgmq — a battle-tested Postgres queue](https://github.com/pgmq/pgmq)
- [napkin-math — Sirupsen](https://github.com/sirupsen/napkin-math)

_Disclaimer: benchmarks ran on a single M4 Mac mini inside a 4-CPU Podman VM.
Production Temporal deployments scale history and matching services
horizontally and use much larger Postgres clusters. The throughput numbers
here should be read as "ratio of orchestration work per unit of user work,"
not as production capacity planning._

---

## Colophon — AI assistance

This post was researched, benchmarked, and drafted with the help of
**Claude Opus 4.6** (via the [pi](https://github.com/mariozechner/pi)
coding agent). The agent set up Temporal + Postgres + Absurd in Podman on
my Mac mini, wrote the benchmark drivers, ran the workloads, queried
`pg_stat_statements`, and produced the first draft of this write-up.
Every number in this post was measured on real infrastructure, then
hand-verified by me; every claim was cross-checked against upstream
source before publication.

Session stats (from the pi harness):

```txt
model           input   output  cache_read  cache_write   cost    turns
claude-opus-4-6   225    143k       37.8M         403k   $24.99    199
```

38 million cached-read tokens, 143k output tokens, 199 tool turns,
**$24.99 total** over ~3 hours. The benchmark code in `bench/` is open in
the [repo for this
site](https://github.com/pratikgajjar/go-backend.how/tree/main/bench) if
you want to reproduce or extend it.

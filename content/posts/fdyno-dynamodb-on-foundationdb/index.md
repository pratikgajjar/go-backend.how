---
title: "🦎 fdyno — DynamoDB on FoundationDB"
date: 2026-05-06
lastmod: 2026-05-06
description: "An experiment in putting DynamoDB's API on top of FoundationDB. We walk through what FDB's transaction model lets you simplify (strongly-consistent GSIs, ACID across base + indexes + CDC), what it costs you (CGO crossings, fsync at commit), and what DynamoDB the service still does better. With napkin math, eBPF-style traces, and 526/526 conformance tests."
tags: ["foundationdb", "dynamodb", "golang", "system-design", "ebpf"]
images: ["og.png"]
draft: true
theme: "honey"
featured: false
math: true
---

# Why I'm doing this

The thesis is one line:

> **FoundationDB has a wonderful engine and a tiny API.
> DynamoDB has a wonderful API and a closed engine.
> Put one on top of the other.**

I use DynamoDB at work. The API is a joy to design against — partition +
sort key, conditional writes, transactions, streams. The shape fits a lot
of OLTP problems without a SQL planner in sight. The tradeoffs (eventually-
consistent GSIs, partition limits, AWS-only) are real, and they're
consequences of how the service was built for the scale it serves. Not
wrong, just specific.

FoundationDB[^2] is the engine I keep coming back to. Apple runs iCloud on it,
Snowflake runs metadata on it, and a number of payment teams trust it with
their ledgers. It ships full ACID transactions across an ordered keyspace
and has [deterministic simulation testing](https://www.youtube.com/watch?v=OJb8A6h9jQQ)
as the correctness story. What it doesn't ship is a friendly API: the
public surface is `Get(key)`, `Set(key, value)`, `ClearRange`, and a
transaction handle. No secondary indexes, no query language, no schema.
You build the rest as a *layer*.

fdyno is that layer. The API people already know how to use, on the engine
I already trust to run. Neither half is novel on its own; the combination
is what makes it fun to write.

A quick note on what this isn't: it isn't a competitor to DynamoDB the
service. AWS runs DynamoDB at a scale and with operational guarantees I
can't match from a Mac mini. fdyno is interesting in the niches where
you'd rather own the engine than rent it — strong-consistency requirements,
data sovereignty, or simply already running FDB.

This post is what fell out. By the end you'll know:

- **What it takes to clone the DynamoDB API faithfully** — every operation,
  every error message, every ordering rule, validated against DynamoDB Local
  with 780 differential probes and against a 526-test conformance suite
- **What changes when you put it on FDB** — strongly-consistent secondary
  indexes, ACID across base + indexes + CDC in one transaction, no LSI
  partition cap, no per-partition throttle — and what stays the same
- **What it costs in Go** — every operation pays a CGO crossing into the FDB
  client; we'll measure that with a profile
- **What DynamoDB the service still does better** — operational maturity,
  managed scale, AWS ecosystem fit; this layer doesn't try to replace those

The numbers that anchor the rest of the post:

> A fresh fdyno install passes **526/526** of the
> [nubo-db conformance suite](https://github.com/nubo-db/dynamodb-conformance)[^3],
> **780/780** of a differential benchmark vs DynamoDB Local, and currently
> **1,331/1,357** of [ScyllaDB Alternator's](https://github.com/scylladb/scylladb)[^4]
> upstream test suite — the same tests Scylla uses to validate its own
> DynamoDB API. The whole implementation is **~9,000 lines of Go**, no file
> over 1,740 lines, single binary.[^1]
>
> On a Mac mini (M2 Pro, single-node FDB, memory engine) it sustains
> **3,660 PutItem/s**, **13,533 GetItem/s** at 32 workers.[^5] The bottleneck
> isn't FDB or Go logic — it's the **CGO boundary** burning ~48% of CPU.

# Where the API and the service part ways

DynamoDB's tradeoffs are tradeoffs, not flaws. They were chosen carefully
for the scale and operational profile AWS targets. Worth listing them
side-by-side because the same set of choices, made on a different engine,
lands somewhere different:

| Property | DynamoDB the service | Why it's that way |
|---|---|---|
| GSI consistency | Eventual | Async propagation keeps writes fast at any scale |
| Cross-table atomicity | Per-request scope (TransactWriteItems) | Bounded blast radius for retries |
| LSI partition size | 10 GB cap | Single partition holds the LSI |
| Per-partition throughput | 3,000 RCU / 1,000 WCU | Hash-based partition selection |
| Index count | 5 LSI + 20 GSI | Per-partition write amplification budget |
| Deployment | AWS regions only | Service architecture |

Each of these is the right answer for the workload AWS optimizes for. The
question fdyno asks isn't "are these wrong?" — they aren't — it's *if you
held the API constant and changed the engine, which of these would change?*

# A FoundationDB primer

[FoundationDB](https://apple.github.io/foundationdb/) is a distributed
ordered key-value store with full ACID transactions across the entire
keyspace. The history is a footnote on its own: started by a small NYC
company in 2009, acquired by Apple in 2015 (where it underpins iCloud and
CloudKit), open-sourced in 2018. Today Apple, Snowflake, and a number of
payment shops run it in production. The user-visible API is intentionally
tiny.

## The roles inside an FDB cluster

A production FDB cluster runs four kinds of processes that talk to each
other over the FDB transport. Most users never see this layout because the
client hides it — but it shapes everything about how transactions work.

```txt
            ┌────────────────┐
            │     Client     │  your app / our fdyno binary
            │  (Go via CGO)  │  chooses keys to read & write
            └───────┬────────┘
                    │ read version, conflict ranges, mutation buffer
                    ▼
            ┌────────────────┐
            │     Proxy      │  stateless: hands out commit versions,
            │  (commit txn)  │  fans mutations out to logs
            └───────┬────────┘
                    │
                    ▼
            ┌────────────────┐
            │   Resolver(s)  │  optimistic-CC conflict checker
            │  (conflicts?)  │  over your read range
            └───────┬────────┘
                    │  OK → commit
                    ▼
       ┌──────────────────────────────┐
       │   Transaction Logs (durable) │  fsync here = committed
       └──────────────┬───────────────┘
                      │ replicate async
                      ▼
       ┌──────────────────────────────┐
       │ Storage Servers (key ranges) │  serve reads at any version
       │        b-tree on disk        │  for the past few seconds
       └──────────────────────────────┘
```

- **Client** is your process holding the FDB native client (`libfdb_c`).
  fdyno talks to it through Go's CGO bindings. The client buffers reads
  and writes; nothing reaches the cluster until you call `commit()`.
- **Proxies** are stateless front doors. They hand out *commit versions*
  (monotonic 64-bit numbers, the heart of FDB's ordering) and fan
  mutations out to the transaction logs.
- **Resolvers** detect serializability conflicts. They keep an in-memory
  history of recent committed write-ranges; on commit they check whether
  any other transaction wrote to your read range while you were running.
  If yes → your transaction aborts; if no → it commits.
- **Transaction logs** are the durability boundary. Once a mutation is
  fsynced here, the commit is acknowledged. They fan out to storage
  servers in the background.
- **Storage servers** hold the actual b-tree shards. Each server owns
  some range of keys. Reads at version \(V\) go to whichever storage
  server has that range and can serve at that version.

The contract this exposes to a client like fdyno is small:

1. Pick a read version (latest, by default).
2. Read whatever you want; reads are MVCC and consistent at \(V\).
3. Buffer writes locally.
4. Commit → proxy assigns commit version \(V'\), resolver checks
   conflicts, logs persist mutations, you get an ack.

If you read \(K\) keys totalling \(b_r\) bytes and write \(W\) keys totalling
\(b_w\) bytes, the work breaks down as:

$$
\underbrace{O(K \cdot \log n)}_{\text{storage server lookups}} +
\underbrace{O(b_w + b_r)}_{\text{network + log fsync}} +
\underbrace{O(\text{conflict ranges})}_{\text{resolver check}}
$$

For an OLTP workload — small \(K\), small \(b_w\) — latency is dominated by
the **log fsync** (the commit boundary), typically 2–8 ms on a
well-tuned cluster. Reads parallelise; writes serialise at the logs.

## MVCC in one diagram

The single property that makes FDB pleasant to layer on is that every
read happens at a specific **version** — a 64-bit number monotonically
assigned by the proxies. A transaction picks one read version \(V\) and
sees the entire keyspace as it was at \(V\). Other writes happening
concurrently land at higher versions and are invisible until you start a
new transaction.

```txt
       ──── ordered timeline of commit versions ────▶

   V=100  │  Tx_A commits {x=1, y=2}
   V=101  │  Tx_B commits {x=3}
   V=102  │  Tx_C commits {z=9}
   V=103  │  Tx_D commits {y=5, z=10}
    …     │

   Reader picks V=102 → sees {x=3, y=2, z=9}     snapshot at V=102
   Reader picks V=103 → sees {x=3, y=5, z=10}    snapshot at V=103

   Concurrent writer Tx_E reads at V=102, writes y' at V':
     commit time → resolver checks: did anyone write to y in (102, V')?
                   yes (Tx_D at 103)  → ABORT, retry
                   no                 → COMMIT at V'>103
```

This is *optimistic concurrency control*: writers don't block readers,
readers don't block writers, and conflicts are detected at commit time
by the resolver scanning recent committed write-ranges against your
read range. fdyno never has to think about locks; we just retry on
`commit_unknown_result` or `not_committed` errors.

## The contract for a layer

FDB's layer model is the part that matters for fdyno. The core gives you
*just* ordered KV + ACID transactions; everything else (SQL, document
stores, secondary indexes, queues) is a layer the user builds. fdyno is
one such layer — implementing the DynamoDB API on top of these primitives:

- **One transaction, one commit point.** Read and write any keys in the
  cluster atomically — no two-phase commit, no shard-aware client logic.
  Up to **10 MB** of writes and **5 s** of execution per transaction.
- **MVCC reads.** Every read is consistent at a single read-version. No
  read locks, no torn views.
- **Versionstamps.** FDB hands out globally-ordered 10-byte sequence
  numbers (`SetVersionstampedKey`) that get filled in at commit time —
  perfect for change-data-capture ordering.
- **Tuple layer.** Encodes composite keys with order-preserving binary
  layout. `(string, int, bytes)` sorts correctly without manual padding.
- **Directory layer.** Hierarchical namespacing for keyspaces. Each
  fdyno table gets its own subspace, automatically prefixed.
- **Deterministic simulation testing.** FDB's
  [own correctness story](https://www.youtube.com/watch?v=OJb8A6h9jQQ) is
  a thousand-CPU-core simulator that can corrupt disks, partition networks,
  and replay bugs from a seed. We piggyback on it: if FDB says a
  transaction committed, it committed.

These primitives let us collapse several DynamoDB constraints into single
FDB transactions:

| | DynamoDB | fdyno on FDB |
|---|---|---|
| GSI consistency | Eventually consistent | **Strongly consistent** (same FDB transaction as base) |
| Cross-table atomicity | Per-request scope, async cleanup on failure | **Full ACID** — base + all indexes + CDC in one commit |
| LSI partition limit | 10 GB | **None** — FDB auto-splits transparently |
| Secondary indexes | 5 LSI + 20 GSI | **Practical limit is the 10 MB transaction size** |
| Hot partition throttling | 3,000 RCU / 1,000 WCU per partition | **None at the API layer** — FDB redistributes |

The catch: you have to host FDB. Single-node FDB with the `memory` engine
runs in seconds and is fine for development. Production needs a real FDB
cluster (typically 3+ machines, SSD storage), and FDB's operational story
is its own thing — not as polished as a managed AWS service.

This isn't "DynamoDB but better." It's "DynamoDB the API on infrastructure
you control, with a different set of operational tradeoffs."

# Architecture in one diagram

```txt
                     ┌──────────────────────────┐
                     │  AWS DynamoDB SDK        │
                     │  (boto3, aws-sdk-go,     │
                     │   aws-sdk-js, ... any)   │
                     └────────────┬─────────────┘
                                  │ HTTP + JSON +
                                  │ X-Amz-Target header
                                  ▼
       ┌──────────────────────────────────────────────────────┐
       │  service.go      (100 LOC)                           │
       │  HTTP router — parse X-Amz-Target, dispatch          │
       └─────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
       ┌──────────────────────────────────────────────────────┐
       │  http.go         (540 LOC)                           │
       │  Thin adapters: decode JSON → call op → encode       │
       └─────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
       ┌──────────────────────────────────────────────────────┐
       │  *_ops.go        (~2,300 LOC across 7 files)         │
       │                                                       │
       │  item_ops · table_ops · query_ops · batch_ops        │
       │  txn_ops  · partiql_ops · controlplane_ops           │
       │                                                       │
       │  Transport-agnostic. Returns typed results + errors. │
       └─────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
       ┌──────────────────────────────────────────────────────┐
       │  fdb_store.go    (600 LOC)                           │
       │  Keyspace · chunking · index maintenance · CDC       │
       └─────────────────────────┬────────────────────────────┘
                                 │ CGO
                                 ▼
       ┌──────────────────────────────────────────────────────┐
       │  FoundationDB cluster                                 │
       │  Single source of truth. No in-process state.         │
       └──────────────────────────────────────────────────────┘
```

Total: **~9,000 lines of Go**. The HTTP layer doesn't know about FDB.
The operations don't know about HTTP. The store doesn't know about
expressions or PartiQL. Each layer can be tested in isolation.

In code, the onion looks like this — same shape across all 23 DynamoDB
operations:

```go
// item_ops.go — transport-agnostic, returns typed result/error
func (s *Service) PutItem(in putItemInput) (*putItemResult, error) {
    if err := validatePutItemInput(in); err != nil {
        return nil, err
    }
    return s.fdbPutItem(in)            // → FDB transaction
}

// http.go — thin HTTP adapter, no business logic
func (s *Service) httpPutItem(w http.ResponseWriter, r *http.Request) {
    var in putItemInput
    if !decodeJSON(w, r, &in) { return }
    res, err := s.PutItem(in)
    if err != nil { writeServiceError(s, w, err); return }
    writeJSON(w, http.StatusOK, res)
}
```

The HTTP adapter is decode → call → encode, three lines of real work.
All the *behavior* lives one layer down, where it can be exercised
without spinning up an HTTP server. This is the
[Tiger Style](https://backend.how/posts/the-tiger-style/) reflex
applied to Go: keep boundaries thin, push state down, give every layer
exactly one job.

There is **no in-memory state** between requests. Every operation opens
an FDB transaction, reads what it needs, writes what it must, and commits.
Multiple fdyno instances behind a load balancer work without coordination
because FDB handles concurrency.

# The keyspace

A DynamoDB-compatible store needs to encode tables, items, indexes, and
change records into a single ordered keyspace. FDB's tuple + directory
layers make this almost free:

```txt
dynodb/<table>/
  ├── m                                → table metadata (schema, GSIs, LSIs, TTL, ...)
  ├── i/<hash>[/<range>]               → item (binary codec, ≤10 KB direct)
  ├── c/<hash>[/<range>]/<chunk_idx>   → large-item chunks (>10 KB, parallel reads)
  ├── x/<index>/<hash>/<sort>/<basePK> → secondary index entry
  └── v/<versionstamp>                 → CDC change record (10-byte FDB versionstamp)
```

A few details worth dwelling on:

**Tuple-encoded keys.** DynamoDB's hash + range key sort must obey
type-aware ordering: strings lex-sort, numbers sort numerically, binary
sorts by byte. FDB's tuple layer encodes each type with a tag byte that
gives correct ordering automatically. No manual padding, no string
mangling.

**Chunked large items.** DynamoDB's item size limit is 400 KB. We store
items ≤10 KB as a single FDB value; bigger items split across N chunks
under `c/...` with a manifest at `i/...`. Reads use parallel FDB futures
to fetch all chunks concurrently — usually one round-trip's worth of
latency for an arbitrary item up to FDB's 10 MB transaction limit.

**Unified index path.** GSI and LSI share the same `x/<index>/...`
subspace. The base primary key is appended as a tiebreaker so duplicate
index values don't collide. The write path is identical — both
synchronous, both inside the same transaction as the base item write.

**Versionstamped CDC.** Change records are written with FDB's
`SetVersionstampedKey`. FDB stamps a globally-ordered 10-byte sequence
number at commit time, atomic with the base mutation. Stream consumers
can iterate `v/...` in commit order without worrying about clock skew or
Lamport timestamps.

# The hot path — a single PutItem, traced

Before getting to the architectural ACID story, here's exactly what
happens to one `PutItem` from the moment it hits the socket. I'll
annotate it with measured latencies (single-node FDB on the bench
machine, p50 numbers).

```txt
                               t (µs)        what
   ┌──────────────────────────┐
   │ HTTP POST / arrives      │     0        accept(2) returns
   ├──────────────────────────┤
   │ JSON decode              │   +30        goccy/go-json into putItemInput
   │ X-Amz-Target → "PutItem" │              (decoded once, no reflection)
   ├──────────────────────────┤
   │ Validate input           │   +15        table-name regex, item-size
   │                          │              ≤ 400 KB, expression syntax
   ├──────────────────────────┤
   │ db.Transact(...)         │   +40        ┐ CGO crossing #1: open txn
   │   read schema            │   +500       │  fdb.NewTransaction()
   │   readItem(old)          │   +1200      │  ↓ go ↔ C ↔ network
   │   apply UpdateExpression │   +80        │  pure Go, no FDB
   │   writeItem(new)         │   +20        │  buffered locally in client
   │   for idx in indexes:    │   +20        │  buffered locally
   │     writeIndexEntry      │              │
   │   writeChangeRecord      │   +20        │  buffered locally
   │   tx.Commit()            │   +6000      │  CGO + log fsync — the cost
   │                          │              ┘
   ├──────────────────────────┤
   │ Encode response (CC etc) │   +25
   │ HTTP write               │   +50        TCP_NODELAY
   ├──────────────────────────┤
   │ socket close (keepalive) │   +5
   └──────────────────────────┘

                            ≈ 8 ms total, p50
```

Two things stand out:

1. **The commit alone is ~75% of wall-clock time.** Everything fdyno does
   in Go between `db.Transact` opening and `tx.Commit` returning is
   buffered locally in the FDB client; nothing crosses the network until
   commit. Optimizing JSON parsing or expression evaluation cannot move
   this needle.

2. **Reads are CGO-heavy.** `readItem` is one FDB `Get` for ≤10 KB items,
   so it incurs one round-trip. Even at ~1.2 ms p50 on a local cluster,
   it's the second-largest line item. Multiply this across `Query`
   (potentially hundreds of FDB reads in one transaction) and the CGO
   overhead compounds.

The rest of the post — the ACID property, the conformance story, the
performance numbers — all sit on top of this profile. Knowing the shape
of the hot path makes everything else easier to interpret.

# What changes when ACID covers everything

In DynamoDB, an `UpdateItem` that touches a GSI does this:

```txt
1. Update item in base partition          (sync, conditional)
2. ──── return success to caller ────
3. (later, async) propagate to GSI partitions
4. (later, async) emit stream record
```

Steps 3 and 4 are eventually consistent. If your reader queries the GSI
right after the write, it might miss the update. If your stream consumer
reads at the same moment, the record might not be there yet.

In fdyno, the same operation does this — all inside one FDB transaction:

```go
// internal/dynodb/item_ops.go (simplified)
return s.db.Transact(func(tx fdb.Transaction) (any, error) {
    table := openTableInTx(tx, in.TableName)

    // 1. Read current item (for ConditionExpression + OldImage)
    old := readItem(tx, table, key)

    // 2. Apply UpdateExpression to produce the new item
    new := applyUpdate(old, in.UpdateExpression, in.Values)

    // 3. Write base item
    writeItem(tx, table, new)

    // 4. Update every secondary index this item participates in
    for _, idx := range table.AllIndexes() {
        deleteIndexEntry(tx, table, idx, old)
        writeIndexEntry(tx, table, idx, new)
    }

    // 5. Emit CDC record with a versionstamped key (filled at commit)
    writeChangeRecord(tx, table, old, new)

    return nil, nil
}) // <-- single commit point. All-or-nothing.
```

Either every step lands together or none of them do. There is no window
where the index is stale, no window where the stream is missing a record,
no window where two consumers see different states. The cost is
concentrated at the commit boundary (~5–8 ms for a single FDB
transaction on a local cluster); in return you get a property that falls
out naturally of FDB's transaction model.

Visually, the difference between the two write paths:

```txt
DynamoDB (UpdateItem touching 2 GSIs + 1 stream consumer):

   t=0    APP ─▶ base partition write ─▶ ack
   t=ε    base ─▶ propagation queue
   t=Δ₁   GSI-1 partition catches up    ◀─ window of staleness
   t=Δ₂   GSI-2 partition catches up    ◀─ window of staleness
   t=Δ₃   stream consumer sees record   ◀─ window of staleness


fdyno on FDB (same UpdateItem):

   t=0    APP ─▶ FDB.Transact():
                    read base item            (read version V)
                    compute new item
                    write base + 2 GSI + CDC  (buffered locally)
                  commit                       (single log fsync)
                  ─▶ ack at commit version V'  ◀─ no windows
```

Formally, every read at version \(V \ge V'\) sees:

$$
\{ \text{base}_{\text{new}},\ \text{GSI-1}_{\text{new}},\
   \text{GSI-2}_{\text{new}},\ \text{CDC}_{V'} \}
$$

simultaneously. Either all of them, or none of them — there is no
\(\Delta\).

This is the property that made the experiment worth running for me.
Everything else (PartiQL, error messages, validation ordering) is grunt
work — important grunt work, but the kind any team can grind through
given enough patience. ACID-across-everything is what falls out for
free once you put the API on top of FDB's transaction model.

# Napkin math — what does this engine give us?

Before measuring, the question is *what should we expect?* Three back-of-the-
envelope numbers anchor every later benchmark.

## How many writes per second per node?

Each `PutItem` is one FDB transaction: read the existing item (for the
`OldImage` and `ConditionExpression`), apply the update, write the base
item plus all secondary index entries, write a CDC record, commit. The
commit boundary is one log fsync.

Call the per-commit cost \(T_c\). On a single-node FDB cluster with NVMe
this is ~2–3 ms; on a multi-node cluster on a real network it's
~5–10 ms. The single-thread throughput ceiling is then:

$$
\text{TPS}_{\text{single}} = \frac{1}{T_c}
\;\;\approx\;\;
\frac{1}{8\text{ ms}}
\;\;=\;\;
125 \text{ TPS per worker}
$$

That matches what we measure. With 8 worker goroutines on the bench
machine pipelining commits we see ~960 PutItem/s; with 32 we see ~3,660.
Every additional worker buys us another commit-in-flight up to whatever
the FDB log fsync queue can absorb.

The implication is that **single-row PutItem is a CGO + fsync-bound
problem, not a CPU-bound one** — well above the cost of JSON parsing,
expression evaluation, or anything else fdyno does in Go.

## How big can one transaction be?

FDB caps a single transaction at:

$$
b_{\text{txn}} \le 10\text{ MB}
\quad\text{and}\quad
t_{\text{txn}} \le 5\text{ s}
$$

This is the operational ceiling on every multi-item op (BatchWriteItem,
TransactWriteItems). For a 200-byte item touching 2 secondary indexes
(say a 16 byte key entry each), one item costs about:

$$
\underbrace{200\text{ B}}_{\text{base item}} +
\underbrace{2 \times 16\text{ B}}_{\text{index entries}} +
\underbrace{\sim 64\text{ B}}_{\text{CDC record}}
\;\approx\; 300 \text{ B per item}
$$

So a single transaction can comfortably carry:

$$
\frac{10 \text{ MB}}{300 \text{ B}} \approx 33{,}000 \text{ items}
$$

DynamoDB's `TransactWriteItems` caps at 100 items. fdyno respects that
cap to stay API-compatible, but the underlying engine could carry
~330× more in one ACID block. That's a meaningful headroom for
batch-import flows once you opt out of strict DynamoDB compatibility.

## What does CDC cost us?

Every mutation also writes a CDC record under `v/<versionstamp>`. For
NEW_AND_OLD_IMAGES this is roughly:

$$
b_{\text{cdc}} \approx \underbrace{10\text{ B}}_{\text{versionstamp}} +
\underbrace{2 \cdot b_{\text{item}}}_{\text{old + new image}}
$$

For our 200 B items that's ~410 B per change record. At 30,000 ops/day
per table (a small SaaS workload), that's:

$$
30{,}000 \times 410\text{ B} \approx 12 \text{ MB/day per table}
$$

CDC retention is therefore cheap until you forget to run the GC sweeper.
On the roadmap; not in the bench numbers.

## How much disk does this actually use?

A small SaaS workload — say, **10K writes/day** to a 200-byte item,
2 secondary indexes, NEW_AND_OLD_IMAGES streams, 90 days retained.
Storage cost on FDB (which uses double-replica by default in most
production configs):

$$
\begin{aligned}
\text{base item} &= 200\text{ B} \\
\text{index entries} &= 2 \times 16\text{ B} = 32\text{ B} \\
\text{CDC record} &= 410\text{ B} \\
\hline
\text{per write, raw} &\approx 642\text{ B}
\end{aligned}
$$

$$
\text{daily} = 10^4 \times 642 \approx 6.4 \text{ MB/day}
$$

$$
\text{90-day retained} \times \underbrace{2}_{\text{FDB replicas}}
\times \underbrace{1.3}_{\text{LSM amp}}
\approx 1.5 \text{ GB}
$$

A pathological 1B-write/day workload (UPI-scale, like the one I
[modelled for TigerBeetle](https://backend.how/posts/1b-payments-per-day))
would land at:

$$
10^9 \times 642\text{ B} \times 90 \times 2 \times 1.3
\approx 150 \text{ TB hot tier}
$$

Same order of magnitude as the TigerBeetle ledger calculation — same
underlying physics, just a different access pattern.

## What's the actual bottleneck going to be?

If the per-commit cost is fixed at ~8 ms and the Go logic per op is
small, the *real* bottleneck on a single fdyno process is going to be
**the CGO crossing into FDB**. We'll see that explicitly in the CPU
profile in a moment — ~48% of CPU is `runtime.cgocall`. Napkin math
predicts that before we measure it.

The lesson, same as in [the TigerBeetle post](https://backend.how/posts/1b-payments-per-day):
napkin math is best at *ruling things out*, not at predicting the final
answer. We've ruled out CPU, JSON, and expression parsing as the
bottleneck. We've ruled in fsync (commit cost) and CGO. The remaining
question — which dominates — is what the profile is for.

# Conformance: how we got to 526/526

Cloning an API isn't done when the happy paths work. DynamoDB has thirty
years of accumulated edge cases — error message wording, validation
ordering, legacy APIs, reserved-word lists, number normalization rules.
The conformance harness was the way through:

| Suite | Purpose | Status |
|---|---|---:|
| [nubo-db/dynamodb-conformance](https://github.com/nubo-db/dynamodb-conformance) | TypeScript / vitest, AWS SDK v3 — error messages, validation, PartiQL, Streams | **526 / 526** |
| `cmd/compatbench` (in-tree) | Go differential bench: same op against fdyno + DynamoDB Local, compare byte-for-byte | **780 / 780** |
| [ScyllaDB Alternator](https://github.com/scylladb/scylladb/tree/master/test/alternator) | Python / pytest, boto3 — 5+ years of DynamoDB compat tests Scylla itself uses | **1,331 / 1,357** (zero failures; 26 are scylla-specific fixtures we don't carry) |

The differential bench is the one I trust most. It's not "does my
behavior match my idea of the spec" — it's "does my response equal
DynamoDB Local's response, byte for byte, on the same input." It caught
dozens of bugs I'd never have spotted from reading docs:

- DynamoDB normalizes numbers in subtle ways (`-0` → `0`, leading zeros
  stripped, but trailing zeros after the decimal preserved).
- Validation runs in a specific order: schema first, then expressions,
  then conditional checks. Get the order wrong and your error message is
  technically right but doesn't match.
- Reserved-word handling: 573 reserved words; using one as an attribute
  name in an expression triggers a specific error code, not a generic
  "syntax error."
- ReturnValues semantics differ between PutItem (allows ALL_OLD,
  ALL_NEW), UpdateItem (allows all five), and DeleteItem (ALL_OLD only).
  Each combination has its own error path.

Building this loop is what made the project ship. Every commit ran the
suites; any regression on any test failed CI. The
[autoresearch loop](https://github.com/pratikgajjar/txn-store/blob/main/autoresearch.md)
was a thousand iterations of "make it pass one more test without
breaking any of the ones that already pass."

# Performance — honest numbers

Benchmarked on a Mac mini (Apple M2 Pro, 10 cores, 24 GB RAM) running a
single-node FDB cluster with the `memory` engine. Items are ~200 bytes
with a composite hash + range key. fdyno is local, FDB is local.

```
                    8 workers   16 workers   32 workers
─────────────────────────────────────────────────────────
PutItem               958        1,820        3,660  ops/s
GetItem              4,881        9,711       13,533  ops/s
UpdateItem             921        1,820        3,667  ops/s
DeleteItem+PutItem     473          918        1,851  ops/s
Query (10 items)     3,950        6,379        8,482  ops/s
Scan  (limit 10)       207          128           68  ops/s

Latency (8 workers):
  GetItem   p50=1.6 ms  p95=2.0 ms  p99=2.4 ms
  PutItem   p50=8.0 ms  p95=10  ms  p99=15  ms
  Query     p50=2.0 ms  p95=2.3 ms  p99=2.5 ms
```

A few honest observations:

- **PutItem latency is dominated by FDB commit (~8 ms).** Single-node
  FDB on a laptop won't push below that. A real cluster on NVMe pushes
  it down to ~2–3 ms.
- **GetItem scales linearly with concurrency** because reads can run
  in parallel against FDB's MVCC.
- **Scan degrades with more workers.** That's not a bug — it's
  expected. Concurrent Scans on a small table contend for the same FDB
  range. The DynamoDB workaround (parallel-segment Scan) splits the key
  range across workers; we implement that, but the test workload has
  segments contending on the same physical range.

## Where the time goes

CPU profile (from `pprof` during a steady-state PutItem workload):

| Component | CPU share | Notes |
|---|---:|---|
| FDB CGO boundary | **~48%** | `cgocall` — every FDB op crosses Go ↔ C |
| FDB future wait | ~22% | Waiting for commit / read completion |
| HTTP / syscall | ~10% | Network I/O |
| Go logic | <5% | JSON, expressions, validation |

The bottleneck isn't the database, isn't the wire format, isn't the
expression engine — it's the **CGO crossing** into FDB's C client. Every
read, every write, every commit pays for a Go ↔ C transition. ~50% of
CPU is `runtime.cgocall` and friends.

What does this tell us?

1. **Optimizing the Go side ahead of the CGO crossings is premature.**
   JSON parsing, expression evaluation, validation — those numbers will
   matter, but only after the CGO bill comes down.
2. **Batching ops per transaction is the obvious lever.** Two PutItems
   in one transaction = one CGO commit instead of two. We already do
   this for `BatchWriteItem` and `TransactWriteItems`; doing it for the
   single-item path would mean changing the API contract.
3. **Multi-node FDB is the production path.** A 3-node FDB cluster
   parallelizes reads across machines, which gives us linear scale up
   to FDB's commit throughput ceiling.

I haven't yet measured fdyno against a multi-node FDB cluster on real
hardware. That's the obvious next step — and the place where this
project either earns its keep or doesn't.

# What this experiment actually proved

Stripping out the napkin math and the architecture diagrams, here's what
I learned that wasn't obvious before I started:

- **DynamoDB the API is more "compositional primitives" than "API."**
  Once you have ordered KV + ACID transactions + tuples + versionstamps,
  the entire DynamoDB shape (PutItem, Query, GSI, streams, transactions)
  falls out of layered code. There's no magic at the storage layer —
  every interesting property comes from FDB's transaction model.

- **Differential testing was worth more than every doc I read.** The
  780-probe `compatbench` runs the same operation against fdyno and
  DynamoDB Local and compares responses byte-for-byte. It found bugs in
  number normalization, validation ordering, and ReturnValues semantics
  that I'd never have caught from the AWS docs alone. **If you're
  cloning a black-box API, the most honest measure is differential
  parity with a reference implementation.**

- **Strong consistency falls out of FDB's transaction model.**
  The cost is one FDB transaction per write — that's the entire price.
  What you get: GSI reads-your-writes, atomic cross-table updates, and
  CDC records that arrive in commit order with no gaps. It's a property
  the DynamoDB API doesn't promise on AWS, but it's free here.

- **CGO is the silent tax on Go-on-FDB.** Hot-path Go optimizations
  plateau until the CGO crossings come down. Batching is the lever, but
  DynamoDB's API contract pins single-item operations to single FDB
  transactions. Future work: a Go client that pipelines multiple
  in-flight transactions to amortize the CGO cost.

- **FDB's 5-s / 10-MB transaction limits are wide enough for everything
  DynamoDB can express.** TransactWriteItems caps at 100 items;
  BatchWriteItem at 25; the largest single operation is a 400-KB item.
  All of this comfortably fits inside one FDB transaction with
  hundreds of multiples of headroom.

- **The "Tiger Style" coding discipline transfers.** Onion architecture
  (transport-agnostic ops, thin HTTP adapters, no shared mutable state)
  and treating limits as forcing functions — the practices I picked up
  from reading TigerBeetle's source apply cleanly to Go. The codebase
  stays consistent in shape across the 23 DynamoDB operations, which
  was probably the single biggest factor in the conformance loop
  staying tractable.

# What DynamoDB the service buys you that fdyno doesn't

This would be a poor post if I only listed what FDB makes possible.
DynamoDB the service has a long list of properties that an experimental
layer on a self-hosted engine simply doesn't offer:

- **Operational simplicity.** No FDB cluster to run, no coordinators to
  monitor, no log-server fsync queues to tune. You hand AWS your data and
  they handle the rest.
- **Predictable scale.** Adaptive capacity, on-demand mode, and
  auto-splitting partitions are mature engineering. fdyno on a single FDB
  cluster has its own ceilings, and shifting them is your problem.
- **Multi-region.** Global Tables ship today. fdyno's multi-region story
  defers to FDB, which has its own design problem.
- **AWS ecosystem fit.** IAM, KMS, VPC endpoints, CloudWatch, X-Ray.
  These are first-party features; fdyno would have to reimplement each
  one if you need it.
- **A decade of hardening.** DynamoDB has run real workloads at planet
  scale for over ten years. fdyno passes a lot of tests; it has not run
  Black Friday.

If any of these matter for your workload, DynamoDB the service is the
right answer. fdyno is interesting in the niches where the API matters
to you but the hosted service doesn't fit — not as a replacement.

# Limitations — things that aren't done

This is an experiment, not a production database. Concrete gaps:

| Gap | Status | Workaround |
|---|---|---|
| TTL auto-expiry | Metadata stored, background scanner not built | Sweep externally with a cron job |
| Authentication | None | Front with a reverse proxy doing IAM-style auth |
| Metrics & tracing | Not wired up | Pre-prod only until added |
| CDC consumer GC | Records accumulate forever | Manual range-clear, or run for short windows |
| Multi-shard streams | Single shard per table | Adequate for most workloads, not parity |
| At-rest encryption | None at the fdyno layer | Use FDB 7.x encryption or volume encryption |
| Point-in-time recovery | Not implemented | Use FDB backups |

There are also things I deliberately didn't try to match:

- **DynamoDB-on-demand pricing.** ConsumedCapacity is reported, but
  there's no actual throttling. FDB doesn't model RCU/WCU; capping
  artificially would be a layer to maintain.
- **Global tables.** Cross-region replication is FDB's job. fdyno would
  expose them but FDB's multi-region story is its own design problem.
- **DAX-style caching.** The CGO bottleneck means a read cache could
  buy a lot, but I haven't measured it yet.

The full roadmap is in the [README](https://github.com/pratikgajjar/txn-store/blob/main/README.md#roadmap-to-production).

# When this approach makes sense

A DynamoDB-on-FDB layer is interesting if at least one of these is true:

- **You need strongly-consistent secondary indexes.** Read-after-write
  through a GSI is a real product requirement that DynamoDB can't
  satisfy. fdyno's index writes are inside the same transaction, so a
  GSI query immediately after a base write sees the update.
- **You need ACID across multiple tables, multiple indexes, and the
  CDC stream.** DynamoDB's transactions are scoped narrowly; FDB's
  aren't.
- **You're already running FDB.** Apple, Snowflake, and others run FDB
  in production. If you have the operational story, putting a
  DynamoDB-compatible API on top costs you ~9k lines of Go and a CGO
  client.
- **Data sovereignty matters.** FDB runs anywhere; DynamoDB runs in
  AWS regions only.

It's *not* the right answer if:

- **You want a managed service.** DynamoDB the service is the
  operationally cheapest path. fdyno + FDB is more code to run.
- **Your workload is happy with eventual GSI consistency.** You're
  paying for a property you don't need.
- **You'll exceed FDB's 5-second / 10 MB transaction limits.** Some
  large bulk-import patterns just don't fit.

# What's next

The honest list, not the marketing one:

1. **Multi-node FDB benchmarks.** Single-node memory-engine numbers are
   directional, not realistic. Need a 3-node SSD cluster on a real
   network.
2. **Reduce CGO crossings.** Either batch more aggressively, or sketch a
   single-binary FDB client wrapper that minimizes round-trips.
3. **TTL background scanner + CDC GC.** The two operational gaps that
   matter for any production-shaped use.
4. **Property-based stateful testing.** The conformance suites cover
   specific scenarios; we need a generator that emits random operation
   sequences and compares fdyno against DynamoDB Local at every step.
   This is the FoundationDB-flavoured testing story applied one layer
   up.
5. **Auth.** SigV4 verification is partially in place; a real IAM-style
   policy engine is not.

If any of this is interesting and you'd like to pair on it, the repo is
[`pratikgajjar/txn-store`](https://github.com/pratikgajjar/txn-store).
File issues, send PRs, or just kick the tires on a local install:

```shell
# 1. Start FDB
export FDB_CLUSTER_FILE=$(./scripts/fdb-local.sh start)

# 2. Start fdyno
go run ./cmd/dynodb     # listens on :8000

# 3. Point any AWS SDK at it
export AWS_ENDPOINT_URL=http://127.0.0.1:8000
aws dynamodb create-table \
  --table-name Users \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Three commands, three minutes, and you have a DynamoDB endpoint backed
by ACID transactions on infrastructure you control.

# Closing

The thesis I opened with:

> *FoundationDB has a wonderful engine and a tiny API. DynamoDB has a
> wonderful API and a closed engine. Put one on top of the other.*

After 1,152 autoresearch iterations, 526/526 conformance tests, and
~9,000 lines of Go, I'm comfortable saying the layer is achievable
without heroics. The combination is the interesting part — neither half
is novel on its own.

The broader takeaway, if there is one: **APIs and engines are easier to
decouple than people assume.** When a great API is closed and a great
engine is open, the gap between them is a project. Sometimes a
rewarding one.

# Further reading

- [TigerBeetle: 1B Payments/Day](https://backend.how/posts/1b-payments-per-day) — the napkin-math + eBPF post this one borrows its structure from.
- [Temporal — Under the Hood](https://backend.how/posts/temporal-under-the-hood) — same dissection technique applied to durable execution.
- [The Tiger Style](https://backend.how/posts/the-tiger-style/) — the coding discipline that shaped fdyno's structure.
- [FoundationDB Architecture](https://apple.github.io/foundationdb/architecture.html) — Apple's official primer on FDB internals.
- [FoundationDB SOSP paper](https://www.foundationdb.org/files/fdb-paper.pdf) — the formal description of the deterministic simulation testing approach.
- [DynamoDB Paper (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) — Werner Vogels et al. on the original design that the public DynamoDB API descends from.

---

[^1]: [`pratikgajjar/txn-store`](https://github.com/pratikgajjar/txn-store) — fdyno source, conformance harness, benchmark code.

[^2]: [FoundationDB](https://www.foundationdb.org/) — the underlying ordered key-value store. Apple's [architecture doc](https://apple.github.io/foundationdb/architecture.html) is the best 30-minute primer.

[^3]: [nubo-db/dynamodb-conformance](https://github.com/nubo-db/dynamodb-conformance) — the 526-test conformance suite.

[^4]: [ScyllaDB Alternator](https://github.com/scylladb/scylladb/tree/master/test/alternator) — Scylla's own DynamoDB-compat test suite.

[^5]: _Benchmarks were performed on an Apple M2 Pro Mac mini (10-core, 24 GB RAM) with FoundationDB 7.x running single-node with the in-memory storage engine. Production workloads should use the SSD engine on a multi-node cluster._

_DynamoDB® is a trademark of Amazon Web Services. FoundationDB® is a trademark of Apple Inc. This post is an independent engineering project — it is not affiliated with, endorsed by, or sponsored by either project. All trademarks belong to their respective owners._

## Colophon

fdyno was built end-to-end through an [autoresearch loop](https://github.com/pratikgajjar/txn-store/blob/main/autoresearch.md)
— an LLM-driven agent that proposes one experiment at a time, runs it,
logs the result against the conformance + differential test suites, and
either keeps or discards the change. **1,152 iterations.** From `0/6`
CRUD ops on day 1 to `526/526` conformance + `780/780` differential +
`1,331/1,357` Alternator on day N. The ledger is in
[`autoresearch.jsonl`](https://github.com/pratikgajjar/txn-store/blob/main/autoresearch.jsonl)
and every commit it produced is on `main`. My contribution was prompting,
reviewing, and an awful lot of "no, the error message must match exactly,
run it again."

The blog post you just read is iteration 5 of the same loop applied to
prose. Sonnet drafted the first pass from the README + ARCHITECTURE
doc; subsequent iterations added the napkin math, the FDB primer, the
hot-path trace, the balance section. Hugo's build was the correctness
check — every iteration had to keep the site building. Then [Chaitanya
from TigerBeetle's correction](https://backend.how/posts/1b-payments-per-day#corrections)
on a previous post taught me to be careful with framings, so this draft
got extra passes for tone.

As with every microbenchmark post: take the numbers with a pinch of
salt. They're from one Mac mini, single-node FDB on the memory engine,
one workload shape. The shape of the bottleneck (CGO + commit) is what
transfers across environments; the absolute throughput won't.

---
title: "🦎 fdyno — DynamoDB on FoundationDB"
date: 2026-10-18T10:30:00+05:30
lastmod: 2026-10-18T10:30:00+05:30
description: "The goal: DynamoDB-level reliability on self-hosted infrastructure. How fdyno maps DynamoDB's data model, reads, writes, and retries onto FoundationDB transactions."
tags: ["foundationdb", "dynamodb", "golang", "system-design", "distributed-systems"]
images: ["og-5535ee72.png"]
draft: false
theme: "honey"
featured: false
math: true
---

My goal with fdyno is DynamoDB-level reliability on infrastructure I run
myself. fdyno is a Go server that speaks the DynamoDB API and stores all of its
data in FoundationDB. You point a normal AWS SDK at it and send normal DynamoDB
requests. FoundationDB keeps the data replicated and recovers from failures.
fdyno maps each request to FoundationDB transactions.

By the end of this post you will know:

- what DynamoDB and FoundationDB have in common, and what a DynamoDB table
  looks like as FDB keys;
- what a read and a write cost when the keys follow the access patterns;
- what fdyno adds on top of FDB to keep every write correct, even when a
  commit reply is lost.

fdyno routes **61** DynamoDB actions: items, expressions, `Query`/`Scan`, GSIs
and LSIs, batches, transactions, a PartiQL subset, Streams, TTL, and on-demand
backups. The source is private. The documentation is public at
[fdyno.backend.how](https://fdyno.backend.how/). fdyno is not production
ready.

# Terms

If you know FoundationDB and DynamoDB, skip to [the comparison](#dynamo-dynamodb-and-foundationdb).

- **Partition key, sort key**: a DynamoDB primary key. All items with the same
  partition key form an **item collection**, stored in sort-key order.
- **`Query`** reads one item collection (or one index partition), optionally
  within a sort-key range. **`Scan`** reads the whole table.
- **GSI / LSI**: DynamoDB secondary indexes. An index is a second copy of the
  items, keyed by other attributes.
- **FoundationDB (FDB)**: an ordered key-value store with ACID transactions
  across the whole key space.
- **Read version**: the version a transaction reads at. All reads in one
  transaction see the database as it was at that version.
- **Conflict** (error `1020`): another transaction changed a key this one read.
  The client runs the transaction again.
- **`commit_unknown_result`** (error `1021`): the commit was sent but the
  result was lost. The write may or may not have happened[^fdb-errors].
- **Versionstamp**: a 10-byte value that FDB fills in at commit time from the
  commit version. A key that contains it sorts in commit order.

# Dynamo, DynamoDB, and FoundationDB

DynamoDB is not the Dynamo of the 2007 paper[^dynamo]. Dynamo had no leader:
any of N replicas could accept a write, a "sloppy" quorum kept writes
available during failures, and vector clocks let the application merge
conflicting versions of an item. It updated one key at a time, with no
isolation. DynamoDB kept Dynamo's hash partitioning and its incremental
scaling, and replaced the rest. Each partition has a leader chosen by
Multi-Paxos, reads can be strongly consistent, and transactions are
ACID[^ddb-paper]. The reliability fdyno aims for is DynamoDB's.

The table below compares how each system stores and protects a write. It is
taken from the three papers[^dynamo][^ddb-paper][^fdb-paper].

| | Dynamo (2007) | DynamoDB (2022) | FoundationDB (2021) |
|---|---|---|---|
| Data split by | consistent-hashing ring with virtual nodes | contiguous ranges of hash(pk), then sk | contiguous ranges of the key bytes |
| Copies | N per key, usually 3 | 3, one per Availability Zone | f + 1: 2 in `double` mode, 3 in `triple` |
| Write acknowledged after | W replicas (usually 2), possibly stand-ins | the leader and a quorum (2 of 3) persist the log record | all f + 1 log servers persist the log record |
| When a replica fails | another node takes the write and hands it back later | the quorum still works; the leader adds a log replica | the transaction system recovers with new processes, usually in under five seconds |
| Concurrent writes | vector clocks; the application merges | the partition leader orders them | resolvers reject the later conflicting transaction; it runs again |
| Atomic multi-key writes | none | transactions of up to 100 items | any keys in one transaction |
| Reads | eventually consistent | strong or eventual | strictly serializable |

Two points from this table matter for fdyno.

First, FDB keeps f + 1 copies to survive f failures, where a quorum system
needs 2f + 1. It can do that because it does not mask a failure with a
quorum. It detects the failure and rebuilds the transaction system. The cost is
a short pause: while FDB recovers, commits wait. A DynamoDB partition keeps
accepting writes while two of its three replicas are healthy. Only FDB's
small metadata store (the coordinators) uses a majority quorum.

Second, DynamoDB's guarantees stop at one item or one transaction of up to 100
items. FoundationDB's transaction covers any set of keys. fdyno uses that to
write an item and its index entries and stream record together, which
DynamoDB does not do.

The other half of DynamoDB's reliability is its API. There are no joins and no
query planner. A `GetItem` reads one key, and a `Query` reads one item
collection, in order, up to 1 MiB per page. A request cannot ask for unbounded
work, so its cost does not change as the table grows. fdyno keeps the same
API, so applications keep the same key design.

# Two sorted key spaces

Both stores split data into contiguous key ranges. DynamoDB's key starts with
a hash of the partition key, followed by the sort key. FoundationDB's key is
whatever bytes the layer chooses. fdyno chooses `(table, pk, sk)`, so a
DynamoDB item collection becomes one FDB key prefix:

| DynamoDB | FoundationDB in fdyno |
|---|---|
| Table | A directory: a short binary key prefix |
| Item | One key, `<table>/i/<pk>/<sk>`; large items are split into chunks |
| Item collection | All keys with the prefix `<table>/i/<pk>/` |
| `GetItem` | One point read |
| `Query` on a sort-key range | One range read between two keys |
| `ScanIndexForward=false` | The same range read in reverse |
| GSI / LSI | A second sorted copy under `<table>/x/<index>/` |
| Partition split | Shard split by data distribution |
| `TransactWriteItems` | One FDB transaction |

The tuple layer encodes `(pk, sk)` so that byte order matches DynamoDB's
order. Strings and binary values sort by bytes, as in DynamoDB. Numbers need
more work, because the text `"100"` sorts before `"2"`. fdyno encodes each
number as a sign, an exponent, and its digits, so byte order equals numeric
order. It never converts to `float64`, so all 38 digits stay exact.

# Design keys for the queries

DynamoDB's main design rule is to list the access patterns first and then
choose keys so that each pattern is one `GetItem` or one `Query`[^nosql-design].
On FDB, that rule has a physical meaning: each pattern becomes one point read
or one contiguous range read.

Take a small shop in one table, `Shop`, with keys `pk` and `sk`, and one GSI,
`ByStatus`, on `(status, createdAt)`:

| Access pattern | Request |
|---|---|
| A. Customer profile | `GetItem pk=CUST#42, sk=PROFILE` |
| B. Last 10 orders of a customer | `Query pk=CUST#42, sk begins_with ORDER#`, reverse, `Limit 10` |
| C. A customer's orders in October | `Query pk=CUST#42, sk BETWEEN ORDER#2026-10-01 AND ORDER#2026-10-31~` |
| D. Lines of one order | `Query pk=ORDER#9` |
| E. Open orders, oldest first | `Query` on `ByStatus`, `status=OPEN` |

The sort key starts with the order date, so the orders of one customer are
already in date order. Pick a pattern in Figure 1 to see which keys each side
reads. The last option is the same question asked without a key for it.

{{< viz kind="fdy-access" fig="1" title="One access pattern, two stores" fallback="fdy-access.svg" alt="The Shop table drawn twice: DynamoDB partitions chosen by a hash of the partition key, and FoundationDB's single sorted key space split into shards. Each access pattern highlights the keys it reads." caption="Sample data. Partition placement and shard boundaries are samples; real ones depend on the hash, data size, and load. Keys are shown as text; FDB stores them tuple-encoded under the table's directory prefix." >}}

fdyno turns the key condition of a `Query` into the two ends of an FDB range.
`begins_with` becomes a prefix range. `BETWEEN`, `<`, and `>` become key
bounds. Reverse order becomes a reverse range read. If the `Query` has a
`Limit` of at most 100, fdyno usually asks FDB for exactly that many keys, and
one network reply returns the whole page.

Every index entry ends with the base key. Two orders can both be `OPEN` at the
same `createdAt`, and the base-key suffix keeps their entries distinct and in
a stable order for pagination.

## What one range read costs

Reading ten items with one `Query` costs much less than ten `GetItem` calls.
Each call pays a read-version round trip, a storage round trip, HTTP, SigV4
signing, and JSON. A `Query` pays these once and reads ten adjacent keys from
one storage server.

On my laptop (Apple M3 Max, one local FDB 7.3.51 process, signed AWS SDK
requests, 1 KiB items, 32 concurrent clients, every response checked):

| Request | Requests/s | Items/s |
|---|---:|---:|
| `GetItem`, one item | 20,903 | 20,903 |
| `Query`, `Limit 10`, one item collection | 12,270 | 122,700 |

These two runs were made two days apart on code that differed by a few
commits, so read the ratio, not the exact numbers. A query that returns ten
items costs about 1.7 times one `GetItem` and returns about **5.9 times** more
items per second.

DynamoDB prices it the same way. A strong `GetItem` of a 1 KiB item costs one
read unit. A `Query` adds up the sizes of all items it returns and rounds up to
4 KB, so ten 1 KiB items cost three read units, not ten[^rcu].

A `Scan` with a filter is the opposite case. The filter runs after the read,
so the request reads every item and returns a few. DynamoDB charges for every
item read[^rcu]. fdyno stops a page after about 10,000 examined rows or 1 MiB,
so one request stays bounded, but the client still pages through the whole
table. On both systems, the fix is an index on the attribute you filter on.

## Hash versus range

fdyno does not hash the partition key, so neighbouring partition keys are
neighbours in FDB. A partition key with many values written evenly, such as a
customer ID, spreads writes over all shards on both systems. A partition key
that always grows, such as a timestamp, does not. DynamoDB's hash still
spreads it across partitions. In fdyno, every new key is larger than every
existing key, so every write goes to the last shard. Try to fix it in Figure 2
by splitting that shard.

{{< viz kind="fdy-hot" fig="2" title="Where new writes go" fallback="fdy-hot.svg" alt="Twenty-four new writes placed into four FoundationDB shards by key range and four DynamoDB partitions by hash, for a customer-ID key and a timestamp key, with a button that splits the busiest shard" caption="Sample keys and boundaries. The DynamoDB side uses a stand-in hash (FNV-1a), not DynamoDB's real one. FDB's data distribution splits shards by size and write traffic; the split point here is the middle key of the busy shard." >}}

A split does not help, because the next write goes to the new end. The
DynamoDB paper says the same about its own splits: a partition whose key
range is accessed in order does not benefit from a split[^ddb-paper]. In
DynamoDB that happens inside one item collection. In fdyno it also happens
across partition keys. So on fdyno, avoid a partition key that only grows.

# FoundationDB in five minutes

A FoundationDB cluster splits its work across process roles. fdyno links the
FDB client library (through cgo) and talks to these roles directly.

```txt
Solid box = process. Dashed box = data on disk.

┌──────────────────┐ 1. get read version V   ┌──────────────┐
│ fdyno            │ ──────────────────────▶ │ GRV proxy    │
│ (FDB client lib) │                         └──────────────┘
│                  │ 2. read keys at V       ┌──────────────┐
│ writes are       │ ──────────────────────▶ │ storage      │
│ buffered here    │                         │ servers      │
│ until commit     │                         └──────▲───────┘
│                  │ 3. commit                      │ pull new
└────────┬─────────┘                                │ versions
         ▼                                          │
┌──────────────────┐ 4. conflicts?  ┌───────────┐   │
│ commit proxy     │ ─────────────▶ │ resolvers │   │
│ gets version V'  │                └───────────┘   │
└────────┬─────────┘                                │
         │ 5. append and fsync                      │
         ▼                                          │
┌──────────────────┐                                │
│ transaction logs │ ───────────────────────────────┘
│ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │
│ ╎ mutation log ╎ │  durable here = committed
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │
└──────────────────┘
```

Three facts from this figure matter for the rest of the post:

1. **Reads skip the commit path.** After it gets a read version, the client
   reads from the storage servers. A read-only transaction never needs a
   commit.
2. **Writes are local until commit.** `Set` and `Clear` only add to a buffer in
   the client. Nothing reaches the cluster until step 3.
3. **A conflict check replaces locks.** The resolvers check whether any key
   this transaction read changed between \(V\) and \(V'\). If one did, the
   commit fails with `1020` and the client runs the whole function again at a
   newer read version.

FDB has three limits that fdyno must respect[^fdb-limits]:

- A transaction may change at most 10,000,000 bytes in total.
- A transaction may live at most five seconds after its first read.
- A key may be at most 10,000 bytes, and a value at most 100,000 bytes.

# The full key space

Items and index entries are only part of what fdyno stores. Each table is one
FDB directory, and FDB's directory layer gives it a short binary prefix. This
is the full layout:

```txt
dynodb/<table>/
  m                                   schema JSON
  mr                                  SHA-256 of m (schema revision)
  i/<hash>[/<range>]                  item, or a chunk manifest
  c/<hash>[/<range>]/<n>              item chunk (10,000 bytes each)
  x/<index>/<ihash>[/<isort>]/<base key>  index entry
  xc/<index>/d/<sha256 of entry key>/<n>  large index entry chunk
  v/[<shard>/]<versionstamp>          stream record
  vt/<shard>                          stream trim position
  t/<expiry minute>/<base key>        TTL expiry index
  ts                                  TTL backfill cursor

dynodb_txn_tokens/<token>             ClientRequestToken records
dynodb_operation_receipts/...         retry receipts
dynodb_index_backfills/...            GSI backfill jobs
dynodb_worker_leases/<worker>         which process runs each background job
dynodb_backups/..., dynodb_restore_jobs/...
```

Every piece of state is in FDB. An fdyno process holds only caches,
configuration, and requests in flight, so you can run several behind a load
balancer and replace any of them without a recovery step.

**Large values are split.** An FDB value can hold 100,000 bytes and a DynamoDB
item can be 400 KiB. fdyno stores an encoded item up to 10,000 bytes in one
value. A larger item gets a manifest under `i/` and chunks under `c/`, all in
the same transaction. Large index entries and stream records use manifests
with a SHA-256 digest. A missing chunk or a wrong digest fails the read. fdyno
never returns part of an item.

**The schema has a revision key.** Every request needs the table schema.
Reading and parsing the JSON at `m` on every request is slow, so fdyno keeps
parsed schemas in process memory. To use one, a request checks the 32-byte
`mr` key at its own read version. The cache is only a parsing shortcut. FDB
still decides whether the schema is current.

# Reading

A `GetItem` shows the floor that every request pays. The numbers below are
mean latencies from FDB's client trace on my laptop at 32 concurrent clients:

```txt
GetItem, strong, 1 KiB item

  HTTP request, SigV4 check, JSON decode         fdyno
  get read version V ........................... 0.62 ms  GRV proxy round trip
  read i/<key> at V ............................ 0.43 ms  storage round trip
  check mr at V ................................ usually no read, see below
  no commit: the transaction only read
  JSON encode, HTTP response                     fdyno
```

The client saw a p50 of about 1.5 ms. One read-version round trip and one
storage round trip are the floor. A raw Go program that uses the FDB binding
pays the same two.

The schema check would be a second storage read on every request. fdyno avoids
it with one property of MVCC: **the value of a key at a fixed version never
changes.** FDB batches read-version requests, so many concurrent transactions
receive the same version \(V\). fdyno caches the value of `mr` by the pair
(key, \(V\)). Such an entry can never be stale. A write that uses a cached
revision also adds `mr` to its conflict set, so a schema change still conflicts
with it. At 32 clients, 99.95% of `GetItem` calls used the cache, and storage
reads per `GetItem` were 1.0 instead of 2.0.

Every read uses a current FDB transaction, even when `ConsistentRead` is
false. There is no cheaper eventual path. For API compatibility, fdyno still
rejects `ConsistentRead=true` on a GSI, although the GSI is current.

# The write set

The read path is a point read or a range read. The write path is where
reliability is decided. This section follows one write.

Use the `Shop` table from above, with the `ByStatus` GSI and a stream with old
and new images. A client marks order 9 as paid:

```json
{
  "TableName": "Shop",
  "Key": {"pk": {"S": "CUST#42"}, "sk": {"S": "ORDER#2026-10-17#9"}},
  "UpdateExpression": "SET #s = :paid",
  "ExpressionAttributeNames": {"#s": "status"},
  "ExpressionAttributeValues": {":paid": {"S": "PAID"}}
}
```

fdyno turns this into one FoundationDB transaction. I call the keys it reads
and writes the **write set**. Step through it in Figure 3.

{{< viz kind="fdy-write" fig="3" title="One UpdateItem, one FDB transaction" fallback="fdy-write.svg" alt="A stepper that follows one UpdateItem through the FoundationDB roles while the write set fills up: the schema revision and old item are read, the item, index entries, stream record and receipt are buffered, then the commit is checked, logged, and made visible" caption="Version numbers, the operation ID, and the receipt expiry minute are samples. The receipt is described in the next section." >}}

The Go code that builds it is short. This is `UpdateItem` without the
validation and the legacy `AttributeUpdates` path:

```go
// Simplified from internal/dynodb/item_ops.go. Errors and
// validation are left out.
val, err := transactMutationProjected(ctx, s, operationKindUpdateItem,
  func(tr fdb.Transaction) (*updateItemResult, error) {
    tbl, _ := openTableInTx(tr, in.TableName) // checked against mr
    existing, _, _ := loadExistingForWrite(tr, tbl, ki)
    code, msg := evaluateConditionExpression(cond, names, vals, existing)
    if code != "" {
      return nil, conditionalFailureServiceError(code, msg, rv, existing)
    }
    updated, _ := applyUpdateExpression(existing, expr, names, vals)
    putItem(tr, ki, updated)                       // base item
    updateIndexEntries(tr, tbl.dir, tbl, existing, updated) // changed
    cdc.write(tr, tbl.dir, tbl, "MODIFY", keys, existing, updated, nil)
    return &updateItemResult{Old: existing, Updated: updated}, nil
  }, compactUpdateItemReceipt, replayUpdateItemReceipt)
```

The function only reads and buffers. `transactMutationProjected` adds the
receipt, commits, and runs the retry loop. A failed condition returns before
anything is buffered, so nothing commits.

## What the shared commit changes

In DynamoDB, the base write returns to the caller first. The GSI and the
stream are updated after that[^gsi]. A query on the GSI right after a successful
write can miss the change. A stream consumer sees the record a little later.

In fdyno, the index entries and the stream record are in the write set. A
reader at any version \(\ge V'\) sees all of them. A reader at a lower version
sees none of them. No crash can leave the base item at the new value and the
index at the old value, because there is no second step.

The commit order also orders the stream. The versionstamp in the `v/` key comes
from the commit version. So stream records sort in commit order with no clock
and no sequence counter. fdyno adds a 2-byte number for the order inside one
transaction. A `TransactWriteItems` that changes ten items therefore gets ten
records with one versionstamp prefix.

`TransactWriteItems` is the same function applied to up to 100 items, in one
FDB transaction. If any condition fails, fdyno returns
`TransactionCanceledException` with one reason per item, and nothing commits.

## What it costs

Every line in the write set adds bytes and work to the request that the client
waits for:

- An item in \(N\) indexes writes \(N\) extra entries, plus clears for the old
  ones. fdyno writes only the entries that changed. An update that changes no
  key or projected attribute of an index touches none of its keys.
- A stream with `NEW_AND_OLD_IMAGES` writes two more copies of the item.
- All of it counts toward the 10,000,000-byte transaction limit. The section on
  [performance](#how-big-can-one-write-be) works out where a valid DynamoDB
  item stops fitting.
- More keys in the read set can mean more conflicts on hot items.

## Many writers on one key

Optimistic concurrency has a known weak point: many writers on one key. Each
`UpdateItem ADD` on the same item reads the item, so concurrent ones conflict,
back off, and run again. fdyno queues `UpdateItem`, `DeleteItem`, and any
`PutItem` that reads the old item, on the same key inside one process, in arrival order.
Each one still runs as its own FDB transaction, and writers in other processes
still use FDB conflicts.

In a local test, 50 workers each sent 20 `ADD` calls to one key:

| | Conflicts | Max latency | Errors |
|---|---:|---:|---:|
| Without the per-key queue | 1,373 | 15.25 s | 5 |
| With the per-key queue | 0 | 642 ms | 0 |

# When the reply is lost

Go back to Figure 3. At the commit step, suppose the network between fdyno
and the commit proxy fails before the answer arrives. FDB returns `1021`,
`commit_unknown_result`. The write is either fully committed or not at all,
but fdyno cannot tell which.

FDB's normal retry loop runs the transaction function again. For the
`SET status = PAID` example, that is safe: the second run writes the same
value. For `SET n = n + :one` or `ADD n :one`, it is not safe. If the first
commit succeeded, the second run reads the new value and adds one again.

## Receipts

fdyno adds one more line to the write set, a receipt. Before the retry loop
starts, fdyno creates a random 128-bit operation ID. Every attempt writes a
receipt under that ID in the same transaction as the item. The receipt holds
the typed result that was sent to the client.

On the first attempt, fdyno skips the receipt read. The ID is new, so no
earlier commit can have used it. On every later attempt, fdyno reads the
receipt first:

- **Found:** the earlier attempt committed. fdyno returns the stored result
  and writes nothing.
- **Absent:** the earlier attempt did not commit. Running the mutation again
  is safe.

The receipt read is a normal read, so if the earlier commit arrives late, the
retry conflicts and runs again. Figure 4 lets you try each case.

{{< viz kind="fdy-retry" fig="4" title="A lost reply, then a retry" fallback="fdy-retry.svg" alt="Predict the value of n after a lost commit reply and a retry without a receipt, then choose the operation, whether the first commit reached the logs, and whether receipts are on, and see both attempts and the final item" caption="The item starts with n = 5 and status = OPEN. One HTTP request; fdyno retries inside it." >}}

Receipts expire after at least an hour. Each receipt also writes an expiry
index entry, `receipts/x/<minute>/<id>`, in the same transaction. A cleanup
job drains that index in small transactions, up to about 833 receipts per
second with the default settings.

FDB 7.3 has an automatic idempotency option for this problem. The Go binding
marks it experimental, so fdyno does not use it.

## What receipts do not cover

A receipt protects one HTTP request while fdyno retries it internally. If the
client times out and its SDK sends the request again, that is a new request
with a new ID. For that case, DynamoDB has `ClientRequestToken` on
`TransactWriteItems`. fdyno stores the token and a SHA-256 of the request in
the same transaction as the effects. A retry with the same token within ten
minutes returns the first result. The same token with a different request
returns `IdempotentParameterMismatchException`.

If fdyno's own deadline (30 s by default) ends after a commit attempt, it
returns HTTP 500 with a message that says the outcome may be unknown. AWS SDKs
retry 500s. The client must decide if that retry is safe:

| Write | Retry after an unknown result |
|---|---|
| `PutItem` of the same item, `DeleteItem`, `SET x = :fixed` | Converges, unless another writer changed the item in between |
| `ADD`, `SET n = n + :d`, `list_append` | Can apply twice |
| Create with `attribute_not_exists(pk)` | Applies at most once; the retry reports a condition failure |
| `TransactWriteItems` with a stable token | Safe for ten minutes |

## So far

DynamoDB and FDB both keep keys sorted and split into replicated ranges, so a
DynamoDB table maps to one FDB directory and an item collection to one key
prefix. Reads are one point read or one range read. Each write is one FDB
transaction, and its write set holds the item, the changed index entries, the
stream record, and a receipt. Readers see all of it or none of it. A lost
commit reply is resolved by the receipt inside one request, and by
`ClientRequestToken` across requests.

The rest of the post covers the work that does not fit in one transaction, the
API details, and how all of it is tested.

# Work that spans many transactions

Some DynamoDB features cannot be one FDB transaction, because they touch a
whole table and FDB transactions live at most five seconds. fdyno builds each
of them the same way: a job record in FDB, small transactions that each do a
bounded amount of work and move a cursor, and a lease so that only one fdyno
process runs the job.

**Adding a GSI to existing data.** fdyno writes the index as `CREATING`, with a
new generation number, and stores a backfill job in
`dynodb_index_backfills`. From that commit on, every normal write maintains
the index. The job copies existing items in pages of 10. Each page writes its
index entries and the job cursor in one transaction, and checks the
generation first, so a job for a deleted index cannot write into a new index
with the same name. The last page marks the index `ACTIVE`. Until then, a
`Query` on the index returns a `ValidationException`.

**TTL.** Every write of an item with a TTL attribute also writes an empty key
`t/<expiry minute>/<base key>` in the same transaction. Reads treat an expired
item as absent at once, in every read and every condition. A sweeper deletes
expired items later by reading the `t/` range in order, so it does not scan
the table. When you enable TTL on a table that already has data, a one-time
pass adds the `t/` keys for existing items, and `ts` holds its cursor.

**Stream trimming.** An optional trimmer deletes stream records older than the
retention period and writes the first remaining key to `vt/<shard>`. A
consumer whose iterator points before that key gets
`TrimmedDataAccessException` instead of a silent gap.

**Who runs the job.** Each job has a lease key in `dynodb_worker_leases` with
an owner and an expiry time, and a separate epoch key that changes only when
the owner changes. Every job transaction reads the epoch key with a normal
read. If another process takes the lease, the epoch changes, and the old
owner's next commit conflicts and stops. Two processes never apply the same
job step.

# Matching DynamoDB, one error at a time

A DynamoDB client depends on more than the happy path. It depends on error
codes, error messages, the order of validation, number formats, and return
shapes. Most of fdyno's code is in this layer, not in storage.

- **Validation order.** `UpdateItem` runs about twenty checks before it opens
  a transaction, and their order decides which error the client sees. For
  example, `a IN ()` must return a syntax error, not an unused-value error.
- **Numbers.** Numbers are decimal strings with up to 38 significant digits.
  `ADD` adds them as decimal strings, not as `float64`. `-0` and `0.0` read
  back as `0`.
- **Reserved words.** The parser knows DynamoDB's 567 reserved words. A
  reserved word in an expression without a `#name` alias fails with
  DynamoDB's message.
- **Return values.** `PutItem` and `DeleteItem` accept `ReturnValues` of
  `NONE` and `ALL_OLD`. `UpdateItem` accepts five values. Each has its own
  error path.
- **FDB errors.** A conflict (`1020`) is retried inside fdyno and never
  reaches the client. A transaction that is too large (`2101`), or a key or
  value that is too large, becomes a `ValidationException`, because a retry
  would fail the same way. A deadline after a commit attempt becomes
  `InternalServerError` with HTTP 500.

Three external suites check this layer. Each starts fdyno against a fresh
FoundationDB and sends requests through an AWS SDK:

| Suite | Client | Result |
|---|---|---|
| ScyllaDB Alternator[^alternator] | boto3 / pytest | 1,452 passed, 34 deselected |
| nubo-db[^nubo] | AWS SDK for JavaScript v3 / Vitest | 698 passed, 1 skipped |
| ExtendDB[^extenddb] | boto3 / pytest | 876 passed, 2 skipped, 186 deselected, 1 expected failure |

The three suites select different cases, so their counts do not add up to one
percentage. Most deselections are features fdyno does not implement on
purpose. For example, the Alternator cases that expect point-in-time recovery
to work are deselected, because fdyno rejects it. The nubo-db skip needs AWS
accounts. Most ExtendDB deselections test ExtendDB's own management features.
When two suites disagree, the case that was checked against AWS wins.

# Testing under failure

The suites above send one request and check one response. Reliability depends
on histories: many requests, several processes, and faults in between. Three
tests check those, and all three run in CI.

**The two-instance fault test** runs two fdyno processes on one FDB. It runs
conditional creates and tokened account transfers. It drops one HTTP response
after the server returned 200, then sends the same request through the other
instance. It kills one fdyno process with `SIGKILL` and restarts it. It stops
and restarts FoundationDB. A checker then requires one winner per conditional
create, conserved balances, and exactly one effect for the dropped request.
The checker is also run against broken histories, to prove that it can fail.

**The replicated kill test** runs a five-process FoundationDB cluster on one
host with `double` redundancy and three coordinators. Two fdyno instances run
transfers and racing creates. Under that load, the script kills a storage
process, then the transaction-log process, then one fdyno process, and waits
for full recovery after each step. In the last CI run:

- 8,446 transfers: 8,423 acknowledged, 23 ambiguous, 29 failed their
  condition;
- after token replay, all 23 ambiguous transfers were present once, and all 29
  failed ones were absent;
- 1,907 conditional-create keys, each with exactly one winner;
- recovery took 75.6 s after the storage kill and 12.5 s after the log kill.

**The DDL-under-traffic test** has instance A change the schema while
instance B serves about 300 mixed operations per second. A adds a GSI, deletes
it, enables a stream, disables and re-enables it, enables TTL, and recreates
the table with a different key. After each step, B's reads and a full scan must
match the expected state. The last run passed all six steps over 5,682
operations. The test also runs against five builds with bugs added on purpose,
one of which keeps stale schema in its cache, and catches each one.

These tests do not cover a network partition between fdyno and FDB, FDB on
several hosts, or a broad history checked by Jepsen or Elle.

# Performance

The numbers in this section come from short runs on two setups. They describe
those runs, not a capacity you can plan with.

**AWS, 21 September 2026.** fdyno and FDB 7.3.77 (one process, `ssd-2`
engine) ran on one `m8i.2xlarge`. The client ran on a separate
`c8i.2xlarge`. It used the AWS SDK for Go v2 with 1 KiB values, 32 concurrent
workers, no SDK retries, and checked every response. Each point is one 5 s run
after a 2 s warmup, with zero errors. Raw FDB is a Go program that does the
same get, set, read-modify-write, and clear directly, with no HTTP, SigV4,
JSON, or DynamoDB logic.

| Operation, 32 workers | fdyno ops/s (p50, p99 ms) | Raw FDB ops/s (p50, p99 ms) | fdyno / raw |
|---|---:|---:|---:|
| GetItem | 16,572 (1.9, 2.9) | 30,014 (0.9, 4.4) | 55% |
| PutItem | 5,548 (5.6, 10.0) | 9,401 (3.4, 5.0) | 59% |
| UpdateItem | 4,475 (6.8, 19.7) | 8,619 (3.5, 7.3) | 52% |
| DeleteItem | 5,609 (5.5, 10.2) | 8,234 (3.6, 7.4) | 68% |

With the revision cache from the [reading](#reading) section, `GetItem` on the
same setup reached 21,588 ops/s, which is 72% of raw.

## Throughput is concurrency divided by latency

These are closed-loop runs. Each worker sends its next request when the last
one returns. Little's law then gives throughput from latency:

$$
X = \frac{N}{R}
$$

With \(N = 32\) workers and the p50 as an estimate of the mean latency \(R\):

$$
\text{GetItem: } \frac{32}{1.91\text{ ms}} \approx 16{,}750\text{/s}
\qquad
\text{PutItem: } \frac{32}{5.56\text{ ms}} \approx 5{,}750\text{/s}
$$

Both are within 4% of the measured values. So to make fdyno faster at a fixed
concurrency, you must remove latency. A write pays a read-version round trip,
its reads, and a commit that waits for the log fsync. A read pays the first
two only.

## Where `GetItem` time goes

On my laptop (Apple M3 Max, FDB 7.3.51, 32 concurrent clients), a raw Go
program that reads the same two keys per transaction ran 39,338 ops/s. fdyno's
`GetItem` called in process, with no HTTP, SigV4, or JSON, ran 34,133 ops/s:
87% of raw. The full API path ran about 20,000 ops/s. Most of the gap is HTTP,
signing, JSON, and an SDK client on the same machine.

## How big can one write be

DynamoDB allows a 400 KiB item, 20 GSIs, and 5 LSIs. Every index entry with an
`ALL` projection holds a full copy of the item, and all copies are in one write
set:

$$
(1 + 20 + 5) \times 409{,}600\text{ B} = 10{,}649{,}600\text{ B}
\;>\; 10{,}000{,}000\text{ B}
$$

So a valid DynamoDB item can be too large to write in fdyno. Two stream images
make the limit lower. fdyno returns a `ValidationException` for such a write
and commits nothing. On a normal table with small items this limit is far
away: a 1 KiB item with three indexes and both stream images is about 6 KiB
per write.

# What DynamoDB does better

Much of DynamoDB's value is outside the API that fdyno copies:

- **Reliability you do not have to build.** fdyno is as reliable as the FDB
  cluster you run: `triple` mode across enough machines, coordinators in
  separate failure domains, backups to another place, and monitoring. With
  DynamoDB, AWS does that work.
- **No pause on failure.** A DynamoDB partition keeps writing while two of
  three replicas are healthy. FDB pauses commits for its recovery, usually a
  few seconds.
- **Global tables and point-in-time recovery.** fdyno has one FDB cluster as
  its consistency domain, keeps no history, and rejects point-in-time restore.
- **IAM, KMS, VPC endpoints, CloudWatch.** fdyno checks SigV4 against static
  keys. Every valid key can read every table.
- **Cheaper eventual reads.** DynamoDB charges half for an eventually
  consistent read. fdyno has one read path.

fdyno also has its own limits. It is not production ready: there is no
external review, no Jepsen run, and no test of FDB on several hosts yet. Table
backups stay in the same FDB cluster. A stream has a fixed number of shards,
chosen when you enable it.

# What this post added

1. DynamoDB and FoundationDB both split a sorted key space into replicated
   ranges. A DynamoDB item collection is an FDB key prefix.
2. FDB survives f failures with f + 1 copies, because it recovers instead of
   using a quorum. The cost is a short pause while it recovers.
3. Keys designed for the access patterns turn each request into one point read
   or one range read. A ten-item `Query` returned about 5.9 times more items
   per second than `GetItem`.
4. fdyno does not hash partition keys, so a partition key that only grows
   sends every write to one shard.
5. One DynamoDB write is one FDB transaction that holds the item, its changed
   index entries, its stream record, and a retry receipt.
6. After `commit_unknown_result`, a receipt in the same commit stops a retry
   from applying a write twice.

FoundationDB does the hard part: replicated, atomic commits across any keys.
fdyno's work is to keep the DynamoDB API exact and to decide which keys go
into each commit.

---

[^dynamo]: [Dynamo: Amazon's Highly Available Key-value Store (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
[^ddb-paper]: [Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service (USENIX ATC 2022)](https://www.usenix.org/conference/atc22/presentation/elhemali)
[^fdb-paper]: [FoundationDB: A Distributed Unbundled Transactional Key Value Store (SIGMOD 2021)](https://www.foundationdb.org/files/fdb-paper.pdf)
[^fdb-errors]: [FoundationDB error codes](https://apple.github.io/foundationdb/api-error-codes.html)
[^gsi]: [DynamoDB global secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
[^fdb-limits]: [FoundationDB known limitations](https://apple.github.io/foundationdb/known-limitations.html)
[^nosql-design]: [DynamoDB: NoSQL design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html)
[^rcu]: [DynamoDB read and write operations](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)
[^alternator]: [ScyllaDB Alternator tests](https://github.com/scylladb/scylladb/tree/master/test/alternator)
[^nubo]: [nubo-db/dynamodb-conformance](https://github.com/nubo-db/dynamodb-conformance)
[^extenddb]: [ExtendDB](https://extenddb.org)

_DynamoDB® is a trademark of Amazon Web Services. FoundationDB® is a trademark
of Apple Inc. fdyno is an independent project. It is not affiliated with,
endorsed by, or sponsored by either company._

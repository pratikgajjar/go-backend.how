---
title: "💸 Billion Payments per day with TigerBeetle & PostgreSQL: A First-Principles Approach"
date: 2025-03-01
description: "A deep dive into handling the 1B payments/day challenge using first-principles system design with TigerBeetle, PostgreSQL and Golang."
tags: ["golang", "tigerbeetle", "payments", "first-principles", "system-design"]
draft: true
---

tldr;
This post explores what it takes for a single bank in India to handle 1 billion digital transactions daily—roughly 12,000 TPS on average and up to 30,000 TPS at peak load (using a 2.5x multiplier for resiliency). We break down the storage requirements for accounts and transfers, estimate throughput and latency using batching strategies, and compare two systems: TigerBeetle, a high-performance, single-core ledger optimized for sequential writes (demonstrating up to 22x better performance than PostgreSQL), and PostgreSQL, a robust multi-core relational database ideal for complex queries but with slower write throughput under extreme loads.

---

In India, digital payments have transformed the economy. According to NPCI (Government of India), in January 2025 alone, we collectively executed approximately **17 billion** digital transactions in 31 days. To ensure resiliency, a system should handle at least **2x the peak load**. This raises the question: What kind of system is required to perform **1 billion transactions daily**, assuming there is only **one** bank?

| Month  | No. of Banks live on UPI | Volume (in Mn) | Value (in Cr.) |
| ------ | ------------------------ | -------------- | -------------- |
| Jan-25 | 647                      | 16,996.00      | 23,48,037.12   |
| Dec-24 | 641                      | 16,730.01      | 23,24,699.91   |
| Nov-24 | 637                      | 15,482.02      | 21,55,187.40   |

Source: [NPCI product-statistics](https://web.archive.org/https://www.npci.org.in/what-we-do/upi/product-statistics)

# Napkin-math

- **Scale & Usage:** Out of India’s 1.4 billion people, around 400 million use digital payments.
- **Transactions:** To support 1 billion daily transactions, we estimate an average of ~12,000 TPS. With a **2.5x peak load multiplier**, peak throughput can reach ~30,000 TPS.
- **Rationale for Assumptions:**
  - **1 Billion Transactions/Day:** Based on observed trends and projections in digital adoption.
  - **2.5x Multiplier:** To ensure resiliency during traffic surges, it’s standard to design for twice the expected load.

# Defining the Data Model

1. **Account**: Stores the cumulative effect of committed transfers.
2. **Transfer**: An immutable record of a financial transaction between two accounts.

Below is the Go data model for accounts and transfers:

```go
type Account struct {
    ID             Uint128  // 16 bytes
    DebitsPending  Uint128  // 16 bytes
    DebitsPosted   Uint128  // 16 bytes
    CreditsPending Uint128  // 16 bytes
    CreditsPosted  Uint128  // 16 bytes
    UserData128    Uint128  // 16 bytes
    UserData64     uint64   // 8 bytes
    UserData32     uint32   // 4 bytes
    Reserved       uint32   // 4 bytes
    Ledger         uint32   // 4 bytes
    Code           uint16   // 2 bytes
    Flags          uint16   // 2 bytes
    Timestamp      uint64   // 8 bytes
}

type Transfer struct {
    ID              Uint128  // 16 bytes
    DebitAccountID  Uint128  // 16 bytes
    CreditAccountID Uint128  // 16 bytes
    Amount          Uint128  // 16 bytes
    PendingID       Uint128  // 16 bytes
    UserData128     Uint128  // 16 bytes
    UserData64      uint64   // 8 bytes
    UserData32      uint32   // 4 bytes
    Timeout         uint32   // 4 bytes
    Ledger          uint32   // 4 bytes
    Code            uint16   // 2 bytes
    Flags           uint16   // 2 bytes
    Timestamp       uint64   // 8 bytes
}
```

- **Total size per Account** = **128 bytes**
- **Total size per Transfer** = **128 bytes**

Assuming **400 million** people use digital payments out of **1.4 billion** in India.

## Storage Requirements

### Account Storage

- **Number of Accounts** = 400M
- **Size per Account** = 128 bytes
- **Total Storage** = `400M × 128B = 51.2GB`

### Payments (Transfers) Storage

- **Number of Payments per Day** = 1 billion (1B)
- **Size per Payment** = 128 bytes
- **Daily Storage Requirement** = `1B × 128B = 128GB`
- **Retention Period** = 90 days
- **Total Hot Storage** = `128GB × 90 = 11.52TB`
- **Replication Factor** = 6x → **69.42TB**

With **20TB SSDs**, vertical scaling remains feasible.

### Cold Storage (10-year Retention)

- **Total Storage for 10 Years** = `128GB × 365 × 10 = 467.2TB`

## Throughput and Latency

- **Request Rate** = 30,000 RPS
- **Size per Transfer** = 128 bytes
- **Total Throughput** = `30,000 × 128B = 3,840MB/s`
- **NVMe SSDs** = Capable of **3,000–7,000MB/s** sequential writes.

### Batching Strategy

128-byte Writes at 30K RPS with 8190 [Transfer Batching](https://docs.tigerbeetle.com/coding/requests/#batching-events)

- **Batch Size** = `8,190 transfers = 1MB`
- Throughput = 3.66 batches/sec × 1 MB = `3.66 MB/s` (trivial for NVMe).
- Per-Transfer Latency =
  - Best-case = ~1.3 ms (if batched instantly, write + `fsync`).
  - Worst-case = 8,190 / 30,000 = `0.27 sec` (273 ms) to fill a batch + 1.3 ms ≈ 274 ms.
- Parallel batches = Use 2–4 NVMe drives in parallel to reduce contention.

# TigerBeetle

[TigerBeetle](https://tigerbeetle.com/) is a high-performance, distributed financial database designed for mission-critical payments and ledger applications. Engineered for speed, resilience, and correctness, it handles millions of transactions per second with strict consistency. Built in Zig, it prioritizes safety and efficiency while ensuring minimal operational complexity.

TigerBeetle uses a consensus-based replication model with a recommended optimal cluster size of 6 nodes for production environments:

1. **Consensus Protocol**: Uses a custom consensus protocol to maintain strong consistency and strict serializability.

2. **Leader-Follower Model**: One node acts as the primary (leader), processing all writes, while followers replicate data.

3. **[Fault Tolerance](https://docs.tigerbeetle.com/operating/cluster/#fault-tolerance) Requirements**:

   - 4/6 replicas are required to elect a new primary if the current primary fails
   - Cluster remains highly available (processing transactions) when at least 3/6 nodes are operational (if primary is still active)
   - Cluster remains highly available when at least 4/6 nodes are operational (if primary has failed and new election is needed)

4. **Data Durability**: The cluster preserves data integrity and can repair corruption as long as it maintains availability.

5. **Safety Mechanism**: If too many machines fail permanently, the cluster will correctly remain unavailable rather than risk data inconsistency.

```txt
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ TigerBeetle │     │ TigerBeetle │     │ TigerBeetle │
│   Node 1    │◄────┤   Node 2    │◄────┤   Node 3    │
│  (Primary)  │     │ (Follower)  │     │ (Follower)  │
└──────┬──────┘     └─────────────┘     └─────────────┘
       │
       │            ┌─────────────┐     ┌─────────────┐
       └───────────►│ TigerBeetle │     │ TigerBeetle │
                    │   Node 4    │◄────┤   Node 5    │
                    │ (Follower)  │     │ (Follower)  │
                    └─────────────┘     └─────────────┘
                                              │
                                              ▼
                                        ┌─────────────┐
                                        │ TigerBeetle │
                                        │   Node 6    │
                                        │ (Follower)  │
                                        └─────────────┘
```

### Benchmark Analysis: Storage vs Expectations

Storage Discrepancy Breakdown

Accounts

- Expected: `10M × 128B = 1.28GB`
- Actual: `3.2GB` (**2.5x overhead**). Likely due to internal indexing for account lookups.

Source[^2] - [GitHub](https://github.com/pratikgajjar/1b-payments/tree/main?tab=readme-ov-file#create-10m-accounts)

Transfers, here we created 80% transfers from 20% accounts

- Expected: `10M × 128B × 2 (double-entry) = 2.56GB`
- Actual: `29.8GB` (**11.6x overhead**).

Source - [GitHub](https://github.com/pratikgajjar/1b-payments/tree/main?tab=readme-ov-file#create-10m-payments)

TigerBeetle’s [QueryFilter](https://docs.tigerbeetle.com/reference/query-filter/) might be indexing (`debit_account_id`, `credit_account_id`, `timestamp`) adding significant storage bloat. #TODO RCA

Concurrency vs Throughput

- Sequential: `25m25s` (1 worker).
- Concurrent: `35m41s` per batch (contention on single core).
- Throughput: 6666 RPS

Here concurrent requests got slow down by factor of concurrently, in this case 20x concurrency lead to write latency ~18 second per batch vs ~900ms per batch[^3]

> TigerBeetle uses a single core by design and uses a single leader node to process events. Adding more nodes can therefore increase reliability but not throughput. - [TigerBeetle - Performance](https://docs.tigerbeetle.com/concepts/performance/#single-threaded-by-design)

Storage calculations must account for indexing and journaling overhead, not just raw data size; single-core architectures prioritize reliability over parallelism, necessitating workflow designs that align with this constraint.

# PostgreSQL

[PostgreSQL](https://www.postgresql.org/about/news/postgresql-174-168-1512-1417-and-1320-released-3018/) is a powerful, open source object-relational database system that uses and extends the SQL language combined with many features that safely store and scale the most complicated data workloads. The origins of PostgreSQL date back to 1986 as part of the POSTGRES project at the University of California at Berkeley and has more than 35 years of active development on the core platform.

## Schema

We have created the schema in PostgreSQL to match the same account and transaction model in TigerBeetle

```sql

CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  debits_pending BIGINT NOT NULL DEFAULT 0,
  debits_posted BIGINT NOT NULL DEFAULT 0,
  credits_pending BIGINT NOT NULL DEFAULT 0,
  credits_posted BIGINT NOT NULL DEFAULT 0,
  user_data128 UUID,
  user_data64 BIGINT,
  user_data32 INTEGER,
  reserved INTEGER,
  ledger INTEGER,
  code SMALLINT,
  flags SMALLINT,
  timestamp BIGINT
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY,
  debit_account_id UUID NOT NULL REFERENCES accounts(id),
  credit_account_id UUID NOT NULL REFERENCES accounts(id),
  amount BIGINT NOT NULL,
  ledger INTEGER,
  code SMALLINT,
  flags SMALLINT,
  timestamp BIGINT
);

```

## Benchmark

Perform 10M Accounts creation and 1M Payments via [Git](https://github.com/pratikgajjar/1b-payments/blob/main/cmd/pg/).

### Accounts

#### COPY FROM

- Latency[^2] = we were able to create 10M accounts in 14s
  - As accounts creation can happen in bulk, postgres doesn't need to perform complex logic here.
- Expected: `10M × 128B = 1.28GB`, actual = `1256MB` table storage is around the same.
  - PK Index used `453MB`, thus here also we should consider index storage usage in our napkin math.

`fsync(1)` is a Linux command that forces all buffered changes to disk, ensuring data integrity by synchronizing files and metadata. It is mainly used to minimize data loss in case of a crash.

Writes correlate with `fsync(1)`, and we monitor system call latency and frequency using [bpftrace](https://github.com/bpftrace/bpftrace).

```d
fsync_count.d

tracepoint:syscalls:sys_enter_fsync,tracepoint:syscalls:sys_enter_fdatasync
/comm == str($1)/
{
  @fsyncs[args->fd] = count();
  if (@fd_to_filename[args->fd]) {
  } else {
    @fd_to_filename[args->fd] = 1;
    system("echo -n 'fd %d -> ' &1>&2 | readlink /proc/%d/fd/%d",
           args->fd, pid, args->fd);
  }
}

END {
  clear(@fd_to_filename);
}

root@localhost:~# sudo bpftrace --unsafe fsync_count.d  postgres
Attaching 3 probes...
fd 26 -> /var/lib/postgresql/data/pg_wal/000000010000003D0000008D
fd 22 -> /var/lib/postgresql/data/pg_wal/000000010000003D0000008D
fd 25 -> /var/lib/postgresql/data/pg_wal/000000010000003D0000008D
fd 24 -> /var/lib/postgresql/data/pg_wal/000000010000003D0000008D
fd 6 -> /var/lib/postgresql/data/pg_wal/000000010000003D0000009E
fd 7 -> /var/lib/postgresql/data/base/16384/16492_fsm
fd 9 -> fd 8 -> /var/lib/postgresql/data/base/16384/16493
fd 10 -> /var/lib/postgresql/data/pg_wal
fd 11 -> /var/lib/postgresql/data/pg_wal/000000010000003D000000CF
fd 45 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000001
^C


@fsyncs[45]: 1
@fsyncs[7]: 2
@fsyncs[8]: 3
@fsyncs[10]: 3
@fsyncs[9]: 7
@fsyncs[11]: 198
@fsyncs[24]: 299
@fsyncs[25]: 303
@fsyncs[6]: 317
@fsyncs[22]: 357
@fsyncs[26]: 367

Total fsync count = 1857

```

Latency Histogram of fsync(1) during 10M accounts insertions

```d
fsync_lat.d

tracepoint:syscalls:sys_enter_fsync,tracepoint:syscalls:sys_enter_fdatasync
/comm == str($1)/
{
        @start[tid] = nsecs;
}

tracepoint:syscalls:sys_exit_fsync,tracepoint:syscalls:sys_exit_fdatasync
/comm == str($1)/
{
        @bytes = lhist((nsecs - @start[tid]) / 1000, 0, 2000, 100);
        delete(@start[tid]);
}


root@localhost:~# sudo bpftrace fsync_lat.d postgres
Attaching 4 probes...
^C

@bytes:
[0, 100)             139 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@                     |
[100, 200)            85 |@@@@@@@@@@@@@@@@@@@                                 |
[200, 300)           209 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@     |
[300, 400)           228 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[400, 500)           208 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@     |
[500, 600)           145 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@                   |
[600, 700)           126 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@                        |
[700, 800)           106 |@@@@@@@@@@@@@@@@@@@@@@@@                            |
[800, 900)            87 |@@@@@@@@@@@@@@@@@@@                                 |
[900, 1000)           69 |@@@@@@@@@@@@@@@                                     |
[1000, 1100)          65 |@@@@@@@@@@@@@@                                      |
[1100, 1200)          32 |@@@@@@@                                             |
[1200, 1300)          31 |@@@@@@@                                             |
[1300, 1400)          25 |@@@@@                                               |
[1400, 1500)          40 |@@@@@@@@@                                           |
[1500, 1600)          46 |@@@@@@@@@@                                          |
[1600, 1700)          60 |@@@@@@@@@@@@@                                       |
[1700, 1800)          37 |@@@@@@@@                                            |
[1800, 1900)          13 |@@                                                  |
[1900, 2000)          10 |@@                                                  |
[2000, ...)           96 |@@@@@@@@@@@@@@@@@@@@@                               |

```

```sql
                             ^
mydatabase=# SELECT
  pg_size_pretty(pg_relation_size('accounts')) AS table_size,
  pg_size_pretty(pg_indexes_size('accounts')) AS index_size,
  pg_size_pretty(pg_total_relation_size('accounts')) AS total_size,
  AVG(pg_column_size(a)) as avg_row_exl_index,
  pg_total_relation_size('accounts') / COUNT(*) AS avg_row_size_bytes FROM accounts a;
 table_size | index_size | total_size |  avg_row_exl_index   | avg_row_size_bytes
------------+------------+------------+----------------------+--------------------
 1202 MB    | 447 MB     | 1650 MB    | 119.9999991000000000 |                173
(1 row)

```

#### INSERT INTO

Since accounts would get created in single entity, Here we are running 8 go-routines to insert data concurrently with each account creation as separate query. Now we are in same order of magnitude as TigerBeetle.

```md
2025/03/16 21:16:14 Progress: 10000000 accounts inserted (10443.37 inserts/sec)
2025/03/16 21:16:14 Completed: Inserted 10000000 accounts in 15m57.545568625s (10443.37 inserts/sec)
2025/03/16 21:16:14 Average time per insert: 0.095755 ms
```

No of `fsync(1)` required by 10M writes 6053719 ~6M vs 1857 via COPY. This explains why copy took 14s vs ~16 minutes required by insert.

```d
root@localhost:~# sudo bpftrace --unsafe fsync_count.d  postgres
Attaching 3 probes...
fd 13 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 9 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 11 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 6 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 43 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000018
fd 39 -> /var/lib/postgresql/data/pg_wal/000000010000003E00000023
fd 42 -> /var/lib/postgresql/data/pg_wal/000000010000003E0000002E
fd 12 -> fd 7 -> /var/lib/postgresql/data/base/16384/2619
fd 10 -> /var/lib/postgresql/data/base/16384/16494_fsm
fd 8 -> /var/lib/postgresql/data/base/16384/2696
fd 14 -> /var/lib/postgresql/data/pg_wal/000000010000003E0000001A
^Cfd 40 ->


@fsyncs[43]: 1
@fsyncs[40]: 1
@fsyncs[42]: 1
@fsyncs[39]: 2
@fsyncs[10]: 4
@fsyncs[8]: 4
@fsyncs[7]: 4
@fsyncs[6]: 65
@fsyncs[14]: 99
@fsyncs[12]: 208
@fsyncs[13]: 1605121
@fsyncs[11]: 1605842
@fsyncs[9]: 2842367

root@localhost:~# sudo bpftrace fsync_lat.d postgres
Attaching 4 probes...
^C

@bytes:
[0, 100)          552273 |@@@@@                                               |
[100, 200)       5287626 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[200, 300)        208510 |@@                                                  |
[300, 400)          3569 |                                                    |
[400, 500)           707 |                                                    |
[500, 600)           293 |                                                    |
[600, 700)           158 |                                                    |
[700, 800)           111 |                                                    |
[800, 900)            73 |                                                    |
[900, 1000)           60 |                                                    |
[1000, 1100)          35 |                                                    |
[1100, 1200)          23 |                                                    |
[1200, 1300)          26 |                                                    |
[1300, 1400)          18 |                                                    |
[1400, 1500)          18 |                                                    |
[1500, 1600)          12 |                                                    |
[1600, 1700)          22 |                                                    |
[1700, 1800)          17 |                                                    |
[1800, 1900)          13 |                                                    |
[1900, 2000)          14 |                                                    |
[2000, ...)          141 |                                                    |
```

Write latency remained ~200ns for all 6M fsync calls, imposing no load on the SSD. In contrast, COPY showed significant fsync latency spikes >400ns, indicating higher storage overhead.

## Transfers

with 10 go-routines and 10 db connection

- Latency = 10M Transfers caused 100% CPU usage, stopped. At 23min 4.55 M transfers were completed.
- Throughput = 300 RPS
- Storage = ~2GB assuming it scales linearly as at 4.5M it used `440M` table storage + `442M` index usage

### PostgreSQL Horizontal Scaling

PostgreSQL offers more flexible horizontal scaling options:

1. **Read Replicas**: Offload read queries to replica instances.
2. **Partitioning**: Divide tables by time periods or account ranges.
3. **Connection Pooling**: Use PgBouncer or Pgpool-II to manage connection overhead.
4. **Citus Extension**: For true distributed PostgreSQL deployments.

```txt
┌─────────────────┐
│   Application   │
│      Layer      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Connection    │
│      Pool       │
└────────┬────────┘
         │
         ▼
┌─────────┬─────────┬─────────┐
│ Primary │ Read    │ Read    │
│ DB      │ Replica │ Replica │
└─────────┴─────────┴─────────┘
```

# Conclusion & Future

> TigerBeetle demonstrates significant speed advantages (up to 22x faster than PostgreSQL in our benchmarks) with lower CPU usage for immutable, sequential writes. However, its single-core architecture limits parallelism.

### Storage Considerations

Both systems incur overheads beyond raw data sizes due to indexing and journaling. For TigerBeetle, understanding and potentially mitigating this overhead (e.g., with custom indexing strategies) could further optimize storage.

TigerBeetle Wishlist;

- Layered archival, ex transfers done >90 days moves to another disk, >6 months data moves to object storage.
- Transparent loading of specific payment data back to hot storage for read access in case linked transfer needs to be created on older payment.
- 2PC with N shards ensuring reducing blast radius in case primary node has issues.
- Change data capture to listens payment stream for downstream services like reconciliation.

### Hot-Warm-Cold Storage Architecture

1. **Hot Storage (0-90 days)**:

   - Kept in primary database (TigerBeetle or PostgreSQL)
   - Fully indexed and immediately accessible
   - Estimated size: 11.52TB (with replication: 69.42TB)

2. **Warm Storage (90 days - 1 year)**:

   - Moved to a secondary database or columnar storage (e.g., ClickHouse)
   - Partially indexed for common queries
   - Accessible within minutes
   - Estimated size: ~46.72TB

3. **Cold Storage (1-10 years)**:
   - Archived to object storage (e.g., S3, GCS)
   - Compressed and potentially partitioned by time
   - Accessible within hours
   - Estimated size: ~467.2TB

### Archival Process

1. **Scheduled Jobs**: Run during off-peak hours to move data between tiers
2. **Data Compression**: Apply columnar compression for archived data (typically 5-10x reduction)
3. **Selective Indexing**: Maintain indices only for frequently accessed fields in warm storage
4. **Immutable Storage**: Use append-only formats like Parquet or ORC for cold storage

## Meeting the 1B Requirement: Final Assessment

Based on our analysis, can a system handle 1 billion payments per day? Let's summarize:

### Storage Requirements: ✅ Feasible

- **Account Data**: 51.2GB (raw) → ~150GB with indices and overhead
- **Daily Transfers**: 128GB (raw) → ~1.5TB with indices and overhead
- **90-Day Hot Storage**: ~135TB with replication

Modern cloud infrastructure can easily accommodate these storage requirements

### Throughput Requirements: ✅ Feasible with Constraints

- **Average Load**: ~12,000 TPS
- **Peak Load**: ~30,000 TPS
- **TigerBeetle Performance**: Single node can handle ~6,600 TPS
- **PostgreSQL Performance**: Single node can handle ~300 TPS

To meet the throughput requirements:

- **TigerBeetle**: Would need 5 sharded clusters to handle peak load
- **PostgreSQL**: Would need 100+ sharded instances to handle peak load

### Latency Requirements: ✅ Feasible

- **TigerBeetle**: ~1.3ms per transaction (best case) to ~274ms (worst case with batching)
- **PostgreSQL**: ~100-200ms per transaction

Both systems can meet reasonable payment latency requirements (sub-second)

### Operational Complexity: ⚠️ Challenging

- **TigerBeetle**: Lower operational complexity due to simpler architecture, but requires custom sharding logic
- **PostgreSQL**: Higher operational complexity due to the large number of instances required

## Conclusion

A system handling 1 billion payments per day is technically feasible with current technology, but requires careful architecture decisions:

1. **TigerBeetle** offers superior performance for the core payment processing with significantly lower resource requirements, making it the preferred choice for the transaction engine.

2. **PostgreSQL** remains valuable for supporting systems where complex queries and joins are needed (reporting, analytics, user management).

3. **Hybrid Architecture** combining both systems likely offers the best balance:
   - TigerBeetle for core payment processing
   - PostgreSQL for supporting services and complex queries
   - Specialized analytics databases for reporting

The key challenge isn't the technical feasibility but rather the operational complexity of managing such a system at scale. With proper sharding, batching strategies, and a well-designed archival system, processing 1 billion payments daily is achievable with current technology.

---

Reference

GitHub Source code used for benchmarking - [Git](https://github.com/pratikgajjar/1b-payments/)

YT [Advanced Napkin Math: Estimating System Performance from First Principles](https://www.youtube.com/watch?v=IxkSlnrRFqc)

Sirupsen - GitHub [napkin-math](https://github.com/sirupsen/napkin-math)

[^2]: [1B Payments Benchmark Repository](https://github.com/pratikgajjar/1b-payments/tree/main?tab=readme-ov-file)

[^3]: _Disclaimer:_ Benchmarks were performed on an M3 Max MacBook Pro 14" under specific conditions. Real-world performance may vary based on hardware and workload.

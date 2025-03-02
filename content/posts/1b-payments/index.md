---
title: "💸 1 Billion Payments with TigerBeetle/PostgreSQL: A First-Principles Approach"
date: 2025-03-01
description: "A deep dive into handling the 1B payments challenge using first-principles system design with TigerBeetle, PostgreSQL and Golang."
tags: ["golang", "tigerbeetle", "payments", "first-principles" , "system-design"]
draft: false
---

tldr;
This post explores what it takes for a single bank in India to handle 1 billion digital transactions daily—roughly 12,000 TPS on average and up to 30,000 TPS at peak load (using a 2.5x multiplier for resiliency). We break down the storage requirements for accounts and transfers, estimate throughput and latency using batching strategies, and compare two systems: TigerBeetle, a high-performance, single-core ledger optimized for sequential writes (demonstrating up to 22x better performance than PostgreSQL), and PostgreSQL, a robust multi-core relational database ideal for complex queries but with slower write throughput under extreme loads.

---

In India, digital payments have transformed the economy. According to NPCI (Government of India), in January 2025 alone, we collectively executed approximately **17 billion** digital transactions in 31 days. To ensure resiliency, a system should handle at least **2x the peak load**. This raises the question: What kind of system is required to perform **1 billion transactions daily**, assuming there is only **one** bank?

| Month  | No. of Banks live on UPI | Volume (in Mn) | Value (in Cr.)    |
|--------|--------------------------|----------------|-------------------|
| Jan-25 | 647                      | 16,996.00     | 23,48,037.12      |
| Dec-24 | 641                      | 16,730.01     | 23,24,699.91      |
| Nov-24 | 637                      | 15,482.02     | 21,55,187.40      |

Source: [NPCI product-statistics](https://web.archive.org/https://www.npci.org.in/what-we-do/upi/product-statistics)

# Napkin-math

- **Scale & Usage:** Out of India’s 1.4 billion people, around 400 million use digital payments.
- **Transactions:** To support 1 billion daily transactions, we estimate an average of ~12,000 TPS. With a **2.5x peak load multiplier**, peak throughput can reach ~30,000 TPS.
- **Rationale for Assumptions:**  
  - **1 Billion Transactions/Day:** Based on observed trends and projections in digital adoption.  
  - **2.5x Multiplier:** To ensure resiliency during traffic surges, it’s standard to design for twice the expected load.

## Defining the Data Model

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

# TigerBeetle vs PostgreSQL Performance

## TigerBeetle

[TigerBeetle](https://tigerbeetle.com/) is a high-performance, distributed financial database designed for mission-critical payments and ledger applications. Engineered for speed, resilience, and correctness, it handles millions of transactions per second with strict consistency. Built in Zig, it prioritizes safety and efficiency while ensuring minimal operational complexity.

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

## PostgreSQL

[PostgreSQL 17](https://www.postgresql.org/about/news/postgresql-174-168-1512-1417-and-1320-released-3018/) is the latest release of the powerful open-source relational database, offering enhanced performance, security, and developer features. It introduces improvements in query execution, logical replication, and JSON processing, making it even more efficient for modern applications. With a strong focus on scalability and reliability, it remains a top choice for enterprise databases.

### Schema

We have design the schema in PostgreSQL to match the same account and transaction model in TigerBeetle

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

### Benchmark

Accounts - [Git](https://github.com/pratikgajjar/1b-payments/blob/main/cmd/pg/accounts/main.go)

- Latency[^2] = we were able to create 10M accounts in 14s
  - As accounts creation can happen in bulk, postgres doesn't need to perform complex logic here.
- Expected: `10M × 128B = 1.28GB`, actual = `1256MB` table storage is around the same.
  - PK Index used `453MB`, thus here also we should consider index storage usage in our napkin math.

Transfers - [Git](https://github.com/pratikgajjar/1b-payments/blob/main/cmd/pg/transfer/main.go)

with 10 go-routines and 10 db connection

- Latency = 10M Transfers caused 100% CPU usage, stopped. At 23min 4.55 M transfers were completed.
- Throughput = 300 RPS
- Storage = ~2GB assuming it scales linearly as at 4.5M it used `440M` table storage + `442M` index usage

## Conclusion & Future Directions

> TigerBeetle demonstrates significant speed advantages (up to 22x faster than PostgreSQL in our benchmarks) with lower CPU usage for immutable, sequential writes. However, its single-core architecture limits parallelism.

### Storage Considerations

  Both systems incur overheads beyond raw data sizes due to indexing and journaling. For TigerBeetle, understanding and potentially mitigating this overhead (e.g., with custom indexing strategies) could further optimize storage.

### System Trade-offs

- **TigerBeetle** excels in scenarios demanding high throughput and predictable low latency.
- **PostgreSQL** remains a strong candidate when complex query capabilities and multi-core processing are required.

### Further Exploration

- Investigate distributed processing strategies to overcome single-core limitations.
- Experiment with custom indexing or journaling strategies to reduce storage overhead.

-- #TODO Add horizontal scaling, archival, conclude on 1B requirement, include screenshots

GitHub Source code used for benchmarking - [Git](https://github.com/pratikgajjar/1b-payments/)

[^2]: [1B Payments Benchmark Repository](https://github.com/pratikgajjar/1b-payments/tree/main?tab=readme-ov-file)

[^3]: *Disclaimer:* Benchmarks were performed on an M3 Max MacBook Pro 14" under specific conditions. Real-world performance may vary based on hardware and workload.

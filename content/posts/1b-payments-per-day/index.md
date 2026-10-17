---
title: "💸 1B Payments/Day - TigerBeetle & PostgreSQL"
date: 2025-03-01
lastmod: 2026-09-28
description: "Can one bank absorb India's entire daily UPI volume? A first-principles design exercise with real benchmarks: TigerBeetle vs PostgreSQL, traced with eBPF down to the io_uring and fsync calls."
tags: ["golang", "tigerbeetle", "payments", "system-design", "ebpf"]
images: ["og-23339fbc.png"]
draft: false
theme: "honey"
featured: true
math: true
---

This post answers one question with numbers you can reproduce: can a single machine's worth of hardware keep a ledger for a billion payments a day? By the end you will know why PostgreSQL, committing one payment per transaction, tops out at a few thousand transfers per second on an SSD that could move hundreds of times more data, why TigerBeetle does about 48,000 on the same Mac Mini, and which syscalls explain the gap. I ran every benchmark here myself and traced both databases with eBPF.

India moves money like no other country. By February 2026, UPI was clearing **20+ billion** digital transactions per month — nearly half of all real-time payments on Earth.

| Month  | Banks on UPI | Volume (Mn) | Value (₹ Cr.) |
| ------ | ------------ | ----------- | ------------- |
| Feb-26 | 694          | 20,394.18   | 26,84,229.29  |
| Jan-26 | 691          | 21,703.44   | 28,33,481.22  |
| Dec-25 | 685          | 21,634.67   | 27,96,712.73  |
| Jan-25 | 647          | 16,996.00   | 23,48,037.12  |
| Dec-24 | 641          | 16,730.01   | 23,24,699.91  |
| Nov-24 | 637          | 15,482.02   | 21,55,187.40  |

Source: [NPCI product-statistics](https://www.npci.org.in/product/upi/product-statistics)

Put those numbers side-by-side: Jan 2025 to Jan 2026, volume jumped from 17B to 21.7B in a single year — **28% YoY growth, month after month**. Bank count grew from 647 → 691. Rupee value from ₹23.48L Cr → ₹28.33L Cr.

That's ~700 million transactions per day today, spread across 694 banks. At 28% YoY, UPI crosses **1 billion transactions per day by late 2027**. The biggest banks (SBI, HDFC, ICICI) already handle 15–25% of volume each. At the same growth, one of them would need to handle 1B/day on its own in about 7–9 years.

**What does it take for one node to handle 1 billion payments per day?** That's ~12,000 TPS average, ~30,000 TPS at the normal daily peak (2.5× the average — morning 11 AM rush and evening 8-10 PM burst). Seasonal spikes (Diwali shopping, IPL finals, tax deadline) push another 2× on top, so budget closer to **5× the average (~60,000 TPS)** for actual worst-case capacity.

This post starts with the napkin math, then measures the familiar design (PostgreSQL, one transaction per payment) and a ledger built around batching (TigerBeetle) on a Mac Mini (M4, 10-core, 24 GB), tracing every fsync and io_uring call from the kernel. The headline numbers:

- Single TigerBeetle process sustaining **~48K transfers/sec** (63K burst) vs same machine's PostgreSQL at **3,356 RPS** — a **~14×** gap that comes down to how often each one asks the disk to confirm a write.
- What `io_uring` looks like from the kernel: 90% of I/O in 64–512 μs, **zero `fsync()` syscalls** — the data file is opened with `O_DSYNC`, which fuses the durability barrier into `write()` itself: the syscall only returns once the device confirms the data is on stable storage.
- TigerBeetle is **single-threaded by design** — one writer thread, one core, ~48K sustained / 63K burst.
- **4.17 million fsync calls** for 10M PostgreSQL inserts — ~89% of wall-clock accounted for by durability syscalls.
- 2.56 GB of raw data → **21 GB on disk** in TigerBeetle. Why.
- 1B payments/day ≈ 12 nodes, ~100 TB hot storage, one rack.

Benchmark code and eBPF scripts are in the repo[^3]. Every number is reproducible on any Apple Silicon Mac with Podman.

# Napkin math

Start with the easy numbers[^1].

- **Active users**: ~400M of India's 1.4B (NPCI active UPI users, 2024)
- **Daily transfers**: 1B (our hypothetical bank shard)
- **Transfer size on the wire**: 128 bytes (we'll see why shortly)

**Average TPS:**

$$
\frac{10^9 \text{ transfers}}{86{,}400 \text{ s}} = 11{,}574 \approx 12{,}000 \text{ TPS}
$$

**Daily peak TPS** — the normal diurnal swing. Traffic concentrates around the 11 AM office-login burst and the 8-10 PM evening settlement window, emptying out overnight:

$$
\text{peak}_{\text{daily}} = 12{,}000 \times 2.5 = 30{,}000 \text{ TPS}
$$

**Seasonal peak TPS** — on top of daily peaks, events like Diwali, IPL finals, GST deadlines pile another 2× on top. Design for **5× average** if you don't want to page anyone on Black Friday:

$$
\text{peak}_{\text{seasonal}} = 12{,}000 \times 5 = 60{,}000 \text{ TPS}
$$

**Daily raw data volume:**

$$
10^9 \text{ transfers} \times 128 \text{ B} = 128 \text{ GB/day}
$$

That last number is the critical one. 128 GB/day is within reach of commodity hardware — but only if every layer below the application protocol is *designed* for that rate. Let's see what happens to 128 GB when it hits a ledger.

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

Both records are **128 bytes**: two 64-byte cache lines, and 32 of them fit in a 4 KiB page. 8,190 of them plus a 256 B header fill one 1 MiB TigerBeetle request, which is why 8,190 keeps showing up in this post.

## What the ledger has to store

**Account storage** (users × 1):

$$
400\text{M accounts} \times 128 \text{ B} = 51.2 \text{ GB}
$$

**Transfer storage** (hot tier, 90-day retention, replicated 6×):

$$
\underbrace{10^9 \times 128 \text{ B}}_{\text{daily}} \times 90 \text{ days} \times 6 \text{ replicas} = 69.12 \text{ TB}
$$

**Cold tier** (10-year regulatory retention):

$$
128 \text{ GB/day} \times 365 \text{ days} \times 10 \text{ years} = 467.2 \text{ TB}
$$

## What 30K TPS means on disk

$$
30{,}000 \text{ TPS} \times 128 \text{ B} = 3.84 \text{ MB/s}
$$

That's trivial — a 2010-era HDD could sustain it if fsync didn't exist. Modern NVMe (1–7 GB/s sequential, depending on hardware) is **hundreds of times oversized** for the raw data rate. The entire challenge is in the indirection between "user-visible throughput" and "actual bytes written to disk + syncs issued per byte."

The rest of the post measures that for two designs: PostgreSQL with one transaction per payment, and TigerBeetle, which makes a whole batch durable at once.

# Test setup

Everything below was measured on a single Apple M4 Mac Mini[^4] (10-core, 24 GB RAM, macOS 26.1). Both databases ran in containers inside a Podman Linux VM (Fedora CoreOS 41, kernel 6.12.13-aarch64, 4 CPU / 8 GB memory allocated): [PostgreSQL 17](https://www.postgresql.org/about/news/postgresql-174-168-1512-1417-and-1320-released-3018/) and TigerBeetle 0.16.78. Setup and cleanup instructions are in the [reproduction guide](https://github.com/pratikgajjar/1b-payments).

The workload is the same for both: 10M accounts, then transfers where 80% debit the top 20% of accounts (hot accounts, think merchants receiving many small payments) and 20% debit the rest.

# PostgreSQL: one transaction per payment

PostgreSQL is where most payment systems start, so it goes first.

## Schema

The schema mirrors the two 128-byte records:

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

### Accounts, two ways

There are two patterns for account creation. `COPY` is the bulk path — send N rows to the server, parse once, write once, fsync once. `INSERT` is the "realistic" path where each account comes in as its own transaction with its own commit boundary.

**COPY (bulk):**

```shell
$ go run ./cmd/pg/accounts/main.go -totalAccounts 10000000 -concurrency 1
Inserted 10000000 accounts in 22.3s
```

**22.3 seconds for 10M accounts — 448,763 accts/sec.**

**INSERT (one row per transaction, 8 workers):**

```shell
$ go run ./cmd/pg/accounts/INSERT/main.go -totalAccounts 10000000 -concurrency 8
Completed: Inserted 10000000 accounts in 12m46s (13,053 inserts/sec)
```

**From 448K/sec to 13K/sec when you commit each row individually.** That's a 34× drop from batching to not-batching. The database didn't get slower — it's doing 34× more work. Let's watch that work from the kernel.

### Where PostgreSQL actually writes

Before reading the trace, a quick map of the data directory. PostgreSQL splits its on-disk state into two places:

```txt
$PGDATA/
├── pg_wal/                           # Write-Ahead Log (16 MB segments, numbered)
│   ├── 000000010000003E00000001      # active segment
│   ├── 000000010000003E00000018      # next segment
│   └── …
└── base/
    └── 16384/                        # your database (OID 16384)
        ├── 2619, 2696                # system catalog tables
        ├── 16494                     # the accounts table heap
        ├── 16494_fsm                 # Free Space Map (where rows can go)
        └── 16494_vm                  # Visibility Map (MVCC bookkeeping)
```

**Every commit writes twice** — once to the WAL (for durability + crash recovery), then later to the heap file during a checkpoint. The commit `fsync()` only syncs the WAL. Data files get synced in bulk at checkpoint time, so almost every fsync in the trace below lands on the active WAL segment.

### Watching fsync in real time

A PostgreSQL commit returns only after its WAL record is flushed with `fdatasync()` on the active WAL segment. Without that flush, a power loss could lose committed transactions. So with 8 backends each committing one row at a time, how many flushes does it take to make a batch of rows durable? Guess before you look at the trace.

{{< viz kind="one-batch" fig="1" title="8,190 rows, made durable two ways" fallback="one-batch.svg" alt="A grid of 8,190 rows twice. TigerBeetle makes the whole request durable with one prepare, two writes. PostgreSQL single-row inserts need 3,421 fdatasync calls at the measured 0.42 per row." caption="Flush counts follow the measured rates: 0.42 `fdatasync` calls per row for single-row inserts, 0.76 per transfer. TigerBeetle writes the prepare, which makes the batch durable, before it executes the batch." >}}

Here is the trace behind that number. Count the calls with bpftrace:

```d
# fsync_count.d — count fsync/fdatasync calls per fd for postgres process
tracepoint:syscalls:sys_enter_fsync,
tracepoint:syscalls:sys_enter_fdatasync
/ comm == str($1) /
{
  @fsyncs[args->fd] = count();
}
```

Running this during the 10M INSERT run:

```d
$ sudo bpftrace --unsafe fsync_count.d postgres
fd  6 → /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd  9 → /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 11 → /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 13 → /var/lib/postgresql/data/pg_wal/000000010000003E00000001
fd 12 → /var/lib/postgresql/data/base/16384/2619
fd 10 → /var/lib/postgresql/data/base/16384/16494_fsm
…

@fsyncs[ 6]:       126
@fsyncs[ 7]:         4
@fsyncs[ 8]:         5
@fsyncs[ 9]: 3,138,369  → pg_wal/000000010000003E00000001
@fsyncs[10]:         4
@fsyncs[11]: 1,038,168  → pg_wal/000000010000003E00000001
@fsyncs[12]:       107
@fsyncs[13]:       101
@fsyncs[14]:         6
@fsyncs[15]:       104
@fsyncs[16]:        56
```

**Total: 4,177,054 fsync calls for 10 million inserts — 0.42 fsyncs per row.**

Almost all calls land on fd 9 and fd 11, and both point to the **same** WAL segment. Each of the 8 workers has its own PostgreSQL backend process with its own file descriptor table, and the script counts by fd number only. So fd 9 is the sum over every backend that happened to open the WAL segment as fd 9.

Each fsync takes how long?

```d
fsync_lat.d — latency histogram in microseconds

@latency_us:
[0, 64)                168 |                                                    |
[64, 128)        1,567,385 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@                    |
[128, 256)       2,468,475 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[256, 512)         139,667 |@@@                                                 |
[512, 1K)              963 |                                                    |
[1K, 2K)               235 |                                                    |
[2K, 4K)                68 |                                                    |
[4K, 8K)                56 |                                                    |
[8K, 16K)               31 |                                                    |
[16K, 32K)               6 |                                                    |
```

**Weighted-average fsync latency: 163 µs. 97% finish under 256 µs, 100% under 512 µs.** The tail is tiny, the SSD is fine. The cost is in the volume — 4.17 million calls.

Quick math:

$$
4{,}177{,}054 \text{ fsyncs} \times 163 \text{ µs} = 681 \text{ seconds of sequential fsync work}
$$

The benchmark took 766 seconds total:

$$
\frac{681 \text{ s in fsync}}{766 \text{ s total}} = 89\%
$$

Flushes run one at a time: a backend takes `WALWriteLock` to flush, and the others queue behind it[^xlogflush]. So 681 s of flush time in a 766 s run means the WAL was being flushed 89% of the time. Yet there were 0.42 flushes per row, not 1. A flush writes everything in the WAL up to that point, so it makes every commit record inserted before it started durable. With 8 backends, about 2.4 commits share each flush. This is group commit, and Postgres does it with the default settings.

{{< viz kind="group-commit" fig="2" title="Group commit, one flush at a time" fallback="group-commit.svg" alt="Timeline of Postgres backends waiting on WAL flushes; each flush covers every commit record inserted before it started" caption="A model, not a trace. Each backend spends a random time on SQL and network (lognormal around the chosen mean), inserts its commit record, then waits. One flush runs at a time. It uses the measured 163 µs `fdatasync` mean, and the work time is fitted so the model's throughput matches the measured INSERT run. The model ignores CPU limits. Tap a flush, or use ← and →." >}}

A flush can only share the commits that are already waiting, so the number per flush can never exceed the number of backends. That is the tax of per-row commits: PostgreSQL pays **0.42 fsyncs per row** here. TigerBeetle's client puts up to 8,190 transfers into one request, and one prepare makes them all durable.

### Transfers — the real payment workload

```shell
$ go run ./cmd/pg/transfer/main.go -totalTransfers 2000000 -concurrency 10
Processed 2000000 transfers, errors: 0, took: 9m56s
```

**2M transfers in 9m56s = 3,356 RPS.** This is the workload that actually models a payment — each transfer does:

1. `BEGIN`
2. `UPDATE accounts` to add the amount to the debit account's `debits_posted`
3. `UPDATE accounts` to add it to the credit account's `credits_posted`
4. `INSERT` into transfers, which checks both foreign keys and maintains the primary key index
5. `COMMIT`, which waits for a WAL flush

Running `fsync_count.d` during this workload:

```d
@total: 1,517,374  fsyncs for 2M transfers = 0.76 fsyncs/transfer

@latency_us:
[64, 128)         187,897 |@@@@@@@@@                                           |
[128, 256)      1,056,316 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[256, 512)        247,976 |@@@@@@@@@@@@                                        |
[512, 1K)           6,821 |                                                    |
[1K, 8K)           15,127 |                                                    |
```

Compare transfers to the INSERT-only benchmark:

| | INSERT (10M) | Transfer (2M) |
|---|---|---|
| **Fsyncs per row** | 0.42 | **0.76** |
| **Avg fsync latency** | 163 µs | **253 µs** |
| **Wall-clock in fsync** | 89% | **64%** |
| **Throughput** | 13K RPS | **3.4K RPS** |

Transfers make almost 2× more flushes per row. Each transaction spends much longer outside the flush (five round trips, two row updates, lock waits on hot accounts), so fewer commits are waiting when a flush starts: 1.3 per flush instead of 2.4. Average fsync latency rises from 163 µs to 253 µs, probably because each transaction writes three row changes instead of one. And only 64% of wall-clock goes to fsync, not 89%. The remaining **36% is work outside the flush**: the account updates, row-lock waits on hot accounts (10 workers on the 80/20 skewed distribution), index maintenance, and new row versions for VACUUM to clean up.

This is why the transfer throughput (3.4K) is 4× lower than INSERT throughput (13K), not the 1.8× you'd predict from the fsync ratio alone. The two account updates, the foreign key checks, and the row-lock waits add time per transfer that doesn't show up in fsync counts. TigerBeetle, doing the same semantic work (debit A, credit B, enforce balance invariants), batches up to 8,190 transfers into one WAL prepare — same per-write durability, but paid once per batch and with strict serializability instead of row-level locks.

**So far.** PostgreSQL makes each commit durable with a WAL flush. Flushes run one at a time, so at 163 µs each the disk confirms only about 6,000 a second, and group commit can share each flush only among the commits already waiting. With one payment per transaction, that holds a node to a few thousand transfers per second: 3,356 measured. The SSD is not slow; it is asked to confirm too often. A ledger that makes thousands of transfers durable with one write avoids that, and TigerBeetle is built that way.

# TigerBeetle: one durable write per batch

[TigerBeetle](https://tigerbeetle.com/) is a financial transactions database written in Zig. It makes a narrow but aggressive set of design choices: double-entry accounting as the only data model, one writer thread per node, `io_uring` + `O_DIRECT` for all disk I/O, and deterministic simulation testing as the primary correctness story.

Those two flags are worth unpacking, because they're half the reason the numbers later in this post look the way they do.

**`O_DIRECT` — "don't cache this in RAM first."** Normally when you "write" to a file, Linux copies your bytes into a kernel page cache and returns immediately, promising to really save them later. That's fast, but the data hasn't actually reached the disk — which is why a crash can lose committed work unless you also call `fsync`. `O_DIRECT` skips the page cache: your bytes go straight from your program's memory to the storage device. You manage the buffers; the kernel doesn't lie to you about durability.

**`io_uring` — "stop calling me for every little I/O."** The old way, every single read or write is a round trip through the kernel — a syscall: dial, pass arguments, wait for the answer, hang up. For a database doing millions of small I/Os, all that dialling is pure overhead. `io_uring` replaces the phone with two shared ring buffers sitting in memory that both your program and the kernel can see: you drop requests onto a "submission" ring, the kernel posts results onto a "completion" ring. One syscall (`io_uring_enter`, the doorbell) can hand off a thousand I/Os at once.

Together they give TigerBeetle the shortest path from "I want to write this transfer" to "the platter has the bits": no kernel page cache to lie about durability, no syscall tax per I/O. We'll watch this directly with eBPF later: about 46,000 I/Os completing with about 4,200 `io_uring_enter` calls.

The production topology is a 6-node VR-style[^7] consensus cluster: one primary processes all writes, five followers replicate. Critically, **adding followers buys reliability, not throughput** — the primary is still a single thread. You scale TigerBeetle by sharding account ranges across *multiple* clusters, not by adding cores to one cluster.

$$
\begin{CD}
  \text{client writes} \\
  @VVV \\
  \boxed{\;\text{PRIMARY}\;} @>\text{replicate}>> \boxed{\;\text{follower}\;} \times 5 \\
  @VVV \\
  \text{commit ACK} @<<{\text{quorum: } 3/6}< \\
\end{CD}
$$

_one thread · LSM + journal · io_uring + O_DIRECT_

With 6 replicas, a commit needs the prepare on 3 of them, and electing a new primary needs 4, so the cluster keeps running with 2 replicas down. These are flexible quorums[^tb-cluster]: a small replication quorum keeps each commit fast, a larger view-change quorum keeps elections safe, and the two always overlap because 3 + 4 > 6.

## Benchmarks

### Account creation

```shell
$ go run ./cmd/tb/accounts/main.go -tbAddress "3000" -startAt 1 -endAt 10000000
Created accounts from 1 to 10000000 (total: 10000000, failed: 0)
Time taken: 12.277s
```

**10 million accounts in 12.3 seconds — 815,000 accounts/second.**

That's a batched operation: the client pushes 8,190 accounts per batch (the TigerBeetle default, sized to fit its 1 MB message envelope). Each batch is one network round-trip.

### Transfers — the single-worker baseline

Same 80/20 workload as the PostgreSQL run, sent in full 8,190-transfer requests from one client goroutine.

```shell
$ go run ./cmd/tb/transfers/main.go -concurrency 1 -totalTransfer 10000000
done: ok=9999995 err=5 time=3m34.5s RPS=46614
```

**1 worker goroutine → 46,614 transfers/sec.**

Five errors out of 10 million: those are the edge cases in the 80/20 distribution where top-20 accounts don't generate enough volume — negligible. The five failures are `exceeds_credits` — expected in any skewed workload.

A shorter 1M-transfer burst on a fresh database pushed it to **63K RPS**. Client concurrency (1, 4, or 8 goroutines) doesn't meaningfully change throughput — the server is single-threaded, so batches serialize regardless of how many clients submit them.

### Batching math (the TigerBeetle approach)

The benchmark client packs **8,190 transfers per request** (one 1 MiB message):

$$
8{,}190 \text{ transfers} \times 128 \text{ B} = 1{,}048{,}320 \text{ B} \approx 1 \text{ MB}
$$

At 30K TPS, one batch fills in:

$$
t_{\text{fill}} = \frac{8{,}190}{30{,}000} = 273 \text{ ms}
$$

That's ~3.66 batches/sec. How long does each batch take on the server? We measured ~48K RPS sustained, which is \(48{,}000 / 8{,}190 \approx 5.9\) batches/sec — so **~170 ms per batch** of server-side processing. The raw NVMe write for 1 MB is ~1 ms; the rest goes to executing the batch: account lookups through the LSM tree, balance checks, index updates, and compaction.

At 30K TPS the server keeps up, so the batch never has to fill. A TigerBeetle client keeps at most one request in flight and packs whatever arrived meanwhile into the next request[^tb-batching]. Each request carries the transfers that arrived during the previous round trip, far fewer than 8,190, and a payment waits one to two round trips, not the 273 ms it would take to fill a batch. 8,190 is the ceiling, reached only when the server falls behind.

### What `io_uring` actually looks like

TigerBeetle uses Linux's [io_uring](https://en.wikipedia.org/wiki/Io_uring) for disk I/O — a ring buffer where the program submits I/O requests and the kernel completes them asynchronously, without syscalls per operation. You can watch this from outside using eBPF.

```d
# io_uring.bt — trace submission → completion latency per request
tracepoint:io_uring:io_uring_submit_req
{
  @start[args->user_data] = nsecs;
}

tracepoint:io_uring:io_uring_complete
/ @start[args->user_data] != 0 /
{
  $lat = (nsecs - @start[args->user_data]) / 1000;
  @latency_us = hist($lat);
  delete(@start[args->user_data]);
}
```

Run it against a live 100K-transfer workload:

```d
$ sudo bpftrace io_uring.bt

@completions: 45,819

@latency_us:
[0]                   37 |                                                    |
[1]                   81 |                                                    |
[2, 4)                38 |                                                    |
[4, 8)               281 |                                                    |
[8, 16)               76 |                                                    |
[16, 32)              90 |                                                    |
[32, 64)             299 |                                                    |
[64, 128)          7,785 |@@@@@@@@@@@@@@@@@@@@@@@                             |
[128, 256)        17,467 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
[256, 512)        16,158 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@    |
[512, 1K)            899 |@@                                                  |
[1K, 2K)             593 |@                                                   |
[2K, 4K)             596 |@                                                   |
[4K, 8K)             725 |@@                                                  |
[8K, 16K)            643 |@                                                   |
[16K, 32K)            37 |                                                    |
[128K, 256K)          13 |                                                    |
[512K, 1M)             1 |                                                    |
```

**90% of I/O completes in 64–512 μs** (92% if you extend to 1 ms). The tail is 14 completions between 128 ms and 1 s. This trace does not say which I/O they were; checkpoint and compaction I/O are the likely candidates. Nothing is blocking the hot path on a per-transfer `fsync`.

### Counting every syscall TigerBeetle makes

```d
$ sudo bpftrace --unsafe raw_sys.d $TB_PID
# 100,000 transfers processed
@syscalls[64]:      2   (write)
@syscalls[206]:    14   (sendto — network replies)
@syscalls[426]: 4,225   (io_uring_enter)
```

**4,241 syscalls to commit 100,000 transfers.** That is one `io_uring_enter` per ~24 transfers — one doorbell ring to tell the kernel "process this batch of ready I/Os." There are **zero `fsync()` syscalls** because the data file is opened with `O_DSYNC` ([source](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/io/linux.zig)) — the durability barrier is fused into every `write()`. Per the Linux spec, the syscall only returns once the data is on stable storage at the device. `O_DIRECT` complements this by bypassing the page cache, which lets TigerBeetle [handle fsync failures correctly](https://www.usenix.org/system/files/atc20-rebello.pdf) (page-cached writes can lose dirty pages silently on `EIO`). The throughput win comes from batching: one durable WAL prepare covers up to 8,190 transfers.

Compare PostgreSQL above: 0.42 `fdatasync` calls per row, about 42,000 for the same 100,000 rows.

### Storage: 8× amplification

After 10M accounts + 10M transfers, the data file is **21 GB**.

```shell
$ ls -lh ~/bench/tb/0_0.tigerbeetle
-rw-r--r--. 1 core core 21G Apr  5 00:36 0_0.tigerbeetle
```

Raw expected: `10M × 128B + 10M × 128B = 2.56 GB`. **Actual: 21 GB. 8.2× amplification.**

Everything lives in one file, `0_0.tigerbeetle`. The figure follows one `create_transfers` batch through it, from the client's request to the checkpoint that makes its WAL slot reusable.

{{< viz kind="batch-path" fig="3" title="One batch through the data file" fallback="batch-path.svg" alt="One create_transfers batch through a TigerBeetle replica: the WAL prepare and header writes, the state machine and its 33 LSM trees, compaction into the grid, and the superblock checkpoint" caption="Zone sizes, intervals, and tree counts are from the [TigerBeetle 0.16.78 source](https://github.com/tigerbeetle/tigerbeetle/tree/0.16.78/src) with the production config. The op number and slot are samples. Pick a journal entry, or use ← and →." >}}

The reply waits for two writes, the prepare and its header sector, and for the in-memory execution. Compaction and checkpoints come after the reply. The next batch still waits for its slice of compaction, so they cost throughput, not latency.

The 8.2× comes from two places. First, a 128 B transfer becomes up to 824 B of LSM values: the transfer and 6 index entries, two new account versions, and a 256 B `AccountEvent` that records both balances after the transfer. The Transfer groove has 14 trees, but a benchmark transfer touches only 7 of them: its optional fields are zero, which is not indexed, and it is not pending, imported, or closing. Second, compaction writes those values again at each level they pass through.

At 8.2×, the napkin-math[^2] figure of `128 GB/day raw` becomes about `1 TB/day on disk`. We measured 8.2× after 10M transfers; I have not measured how it changes as the file grows.

# Head-to-head

Same hardware. Same workload. Same afternoon.

| Operation | TigerBeetle | PostgreSQL | Ratio |
|---|---:|---:|---:|
| 10M accounts (bulk) | 12.3s (815K/s) | 22.3s COPY (449K/s) | **1.8×** |
| 10M accounts (per-row commit) | 12.3s (815K/s) | 12m46s INSERT (13K/s) | **62×** |
| Transfers throughput | ~48K sustained / 63K burst | 3,356 RPS | **~14×** |
| Storage amplification | 8.2× | 1.2× | PG wins |
| `fsync()` syscalls per row | **0** (O_DSYNC fuses durability into `write()`) | 0.42 | — |
| WAL flushes per 8,190 rows | 1 prepare (2 writes: prepare + header) | ~3,420 | **~3,420×** |
| io_uring_enter per 100K rows | 4,225 | n/a | — |
| Concurrency model | single-threaded (by design) | scales with workers | different tradeoffs |

Two ratios: **~14×** compares TB's sustained (48K) to PG's transfer rate (3.4K). Against PostgreSQL's INSERT-only run (per-row commit, 10M rows), TigerBeetle's transfer rate is still **~4×** higher (48K vs 13K). The difference: each PG transfer also updates two account rows, checks two foreign keys, and waits on row locks for hot accounts, which the INSERT-only test skips.

> PostgreSQL makes 0.76 `fdatasync()` calls per transfer (0.42 per row in the INSERT-only run). TigerBeetle makes zero — durability is in the write itself (O_DSYNC), and one batched WAL prepare commits up to 8,190 transfers, costing one `io_uring_enter` per ~24 transfers.

# Does napkin math predict this?

Two numbers from sirupsen's napkin-math[^2] settle both arguments:

> **SSD write + fsync (8 KiB): 300 µs**
> **Sequential SSD write, no fsync (8 KiB): 2 µs, 3 GiB/s**

**Hypothesis: PG is fsync-bound.** PG commits one row = one fsync. A disk can do \(1\text{ s} / 300\text{ µs} \approx 3{,}300\) fsyncs per second, so one worker tops out at 3,300 RPS. Eight workers with group commit buy a modest boost (maybe 3–4×), so expect **~10K RPS**. Measured: 13K RPS → same order of magnitude → **hypothesis holds**.

**Hypothesis: TB is write-bandwidth-bound.** With `O_DSYNC` fusing durability into `write()` and 8,190-deep batches, the per-transfer overhead collapses to raw write bandwidth. Raw data per transfer is 128 B, but each transfer writes up to 824 B of values into 11 LSM trees ([Figure 3](#storage-8-amplification), step 4), and compaction writes them again at each level. Empirically the disk sees ~1 KB per transfer (8.2× total amp). Using sirupsen's 3 GiB/s reference:

$$
\frac{3 \text{ GiB/s}}{128 \text{ B} \times 8 \text{ amp}} \approx 3 \text{ million TPS}
$$

Measured: 47K TPS → ~65× below the ceiling → **write bandwidth isn't it**. My M4 Mac Mini's actual write bandwidth (`dd bs=1M oflag=direct`) is 1.3 GB/s, which still gives a 27× margin. Writes are ruled out either way.

**So what IS the bottleneck?** Digging deeper with `/proc/pid/io` during a 10M-transfer run revealed the culprit: **disk reads, not writes**.

| Metric | Value |
|---|---|
| Disk writes | 142 MB/s (30 GB total) |
| **Disk reads** | **9 GB/s (1.95 TB total!)** |
| Read per transfer | ~195 KB |
| CPU (single thread) | 85% |

Each transfer requires account balance lookups through the LSM tree. With 10M accounts spread across multiple LSM levels, that means reading index blocks + data pages from several sorted runs per lookup — **about 195 KB read per transfer**. The VM's disk is a file on the Mac, so many of these reads were probably served from the macOS page cache rather than the SSD; 9 GB/s is more than this SSD reads. In our degradation test (1M-transfer chunks, sequential IDs, same DB), throughput held at **~41–46K RPS from 3M to 10M cumulative transfers** (10 GB → 27 GB file). LSM compaction keeps pace at this scale — the throughput cliff likely comes when the working set exceeds the grid cache (1 GB in our test configuration).

The napkin-math story ends here: **sirupsen's write numbers correctly told us writes aren't the bottleneck. But predicting the actual throughput requires knowing the LSM read amplification — and that depends on data size, tree depth, and bloom filter effectiveness.** Those are implementation details that don't fit on a napkin. Napkin math is best at ruling things OUT, not at predicting the final answer.

# What 1B/day actually costs

Plug the real numbers into the original question. Average = 12,000 TPS, daily peak = 30,000 TPS, seasonal peak = ~60,000 TPS.

**TigerBeetle on a Mac Mini:** One node measured at ~48K transfers/sec sustained, ~63K burst. That's **4 billion transfers/day** from a single $600 box.

One node comfortably handles the 1B target — but you don't run payments on one node. TigerBeetle's 6-replica cluster (the recommended production topology) still processes through a single primary, so you're getting the same ~47K TPS throughput with 6× the reliability, not 6× the throughput.

For daily 30K peaks, one cluster is fine. For the 60K seasonal peak, **two clusters (12 nodes total)** sharded by account range is the right shape — half the account space per cluster, each primary handling ~30K TPS headroom.

**PostgreSQL on a Mac Mini:** ~3,400 transfers/sec. To hit 60K seasonal peak, you need **~18 sharded primary instances**, each with a read replica, each with connection pooling, each with its own VACUUM schedule. The operational surface area is roughly order-of-magnitude larger than the TigerBeetle footprint.

**Storage for 90-day hot retention** (with real amplification, not napkin math):

$$
\underbrace{10^9 \times 128 \text{ B}}_{128 \text{ GB/day raw}} \times \underbrace{8.2}_{\text{TB amp}} \times 90 \text{ days} \times 6 \text{ replicas} \approx 567 \text{ TB}
$$

Distributed across 12 nodes (two 6-replica clusters, sharded by account range) = **47 TB per node = 3 × 20 TB NVMe each, 36 drives total — a single rack.** Whether you use TigerBeetle's 8× amplification or PostgreSQL's 1.2× + separate WAL/index maintenance, the order-of-magnitude is the same (~100 TB hot tier per data center).

Neither storage nor throughput is the hard constraint. The **operational blast radius** of each design is.

## Hot, warm, and cold tiers

Indian banking regulations require **10 years of transaction retention**. At 128 GB/day raw, that's 467 TB before compression. You can't keep all of that in TigerBeetle's hot tier. We ran 10M transfers in 1M sequential chunks on a single M4 Mac Mini and throughput held steady at **~41–46K RPS from 3M to 10M** (10 GB → 27 GB file) — the LSM compaction keeps up at this scale. But at 1B/day the data file grows by ~1 TB/day (after 8.2× amplification); at some point the working set exceeds the grid cache and throughput will drop. So tiering is part of the design from the start.

The solution: **checkpoint and archive**. TigerBeetle's accounts already represent a running balance — the cumulative effect of every transfer ever processed. If you snapshot account balances at a cutoff date, every transfer before that date becomes archival. The account balances ARE the checkpoint: you don't need the old transfers to know the current state, only to audit history.

| Age | Tier | Storage | Query Latency |
|---|---|---|---|
| 0–90 days | **Hot** — TigerBeetle cluster | ~100 TB × 6 replicas = ~600 TB | single-digit ms |
| 90 days–1 year | **Warm** — ClickHouse / Parquet on NVMe | ~15 TB (35 TB raw, compressed 2–3×) | seconds |
| 1–10 years | **Cold** — S3 / GCS Parquet, partitioned by day | ~90 TB (420 TB raw, compressed ~4.7×) | minutes |

For the cold tier, I tested every Parquet codec on TigerBeetle's 128-byte Transfer schema. The winner: **zstd(3) with dictionary encoding — 27.3 B/row, 4.7× compression, 0.16 s to write 100 MB.**

- **zstd(3) does ~97%** of the work. Levels 9 and 22 buy <1% more at 10–50× the CPU.
- **Dictionary** adds ~2% on the 12 low-cardinality columns (`ledger`, `flags`, `code`, zero-fields).
- **Delta** on `id_hi` and `timestamp` contributes **<1%** — noise once zstd has a pass. If you want the last percent, `BYTE_STREAM_SPLIT` on random u64s gets you to 25.7 B/row (4.98×) for free.
- **80 of 128 bytes are random** (amount + account IDs) — no structural compression possible there.
- Ratio saturates at **81K rows** (10× a TB batch) — no need for millions to measure.

**10-year cold tier: ~94 TB on S3, ~$2,150/month.** The [full benchmark](https://github.com/pratikgajjar/1b-payments/blob/main/bench/parquet_scales.py) is 200 lines of Python, 15 seconds to run.

### The archival pipeline

1. **Scheduled rollover job** (nightly): query TigerBeetle for transfers with `timestamp < NOW() - 90d`, stream to Parquet files partitioned by day. The account balances at the cutoff date are the checkpoint — save those alongside the archived transfers.
2. **Columnar compression** on the way out: zstd gets ~4.7× on this schema (we measured it — 27 B/row with dictionary encoding on the low-cardinality fields).
3. **Compact the hot tier.** TigerBeetle doesn't have DELETE — it's an append-only ledger by design. The current path for compaction is a rolling data-file migration: format a new file, replay accounts + recent transfers, swap.
4. **Rehydration**: on a legal-hold query or dispute, pull the relevant Parquet partition back into a warm ClickHouse instance. The checkpoint balances let you validate the rehydrated transactions against the known-good state at that date. Don't try to import back into the hot ledger — that invalidates the immutability guarantee.

# When to use what

The question isn't "which is better" — it's "where does each one belong in the same system?"

TigerBeetle is a **ledger accelerator**. If the operation is `debit A, credit B, enforce invariants, commit` — and it happens millions of times per day — that's TigerBeetle. Everything else (KYC, disputes, merchant metadata, reporting, anything that needs a JOIN or a WHERE clause you haven't thought of yet) stays in Postgres. Most production deployments will run both.

# The lesson

Both systems run on the same SSD. The difference is **what they ask the disk to do per transfer**:

```txt
TigerBeetle:  O_DSYNC + O_DIRECT + io_uring, 8,190-tx batches    →  47K RPS   (not disk-bound)
PostgreSQL:   one WAL flush per ~2.4 commits (group commit)       →  13K RPS   (fsync-bound)

                        ↓
                  ~4× throughput gap on the per-row-commit workload
                  same durability guarantees -- different batching model, not a knob
```

Both systems provide strong per-commit durability when configured correctly (PostgreSQL with `synchronous_commit = on`, TigerBeetle via `O_DSYNC` writes). TigerBeetle's win is the batched interface: clients hand it up to 8,190 transfers and one durable WAL prepare commits the whole batch. PostgreSQL, by default, flushes the WAL before a commit returns, and group commit lets only the commits already waiting share that flush. Turning `synchronous_commit` off gives you faster COMMITs at the price of losing the last few hundred ms of committed data on crash.

**If every payment must be durable the instant it's written and your clients can't batch, the per-commit fsync cost is the budget you're working with.** If they can batch, the cost amortizes.

# What we showed

What the traces and benchmarks showed:

- **Postgres already batches, but only across commits that are waiting.** Group commit shares each WAL flush among the commits already queued: about 2.4 with 8 backends. A TigerBeetle client puts up to 8,190 transfers in one request before the database sees them, and one prepare makes them durable.

- **Single-core by design works.** TigerBeetle sustains ~48K RPS (10M steady-state) and bursts to ~63K (1M fresh) on one thread. Client concurrency (1, 4, or 8 goroutines) doesn't change throughput — batches serialize at the primary regardless.

- **Zero `fsync()` syscalls, durability intact.** 100,000 transfers committed in 4,241 total syscalls (4,225 `io_uring_enter`, 14 `sendto`, 2 `write`). Durability is in the write itself (O_DSYNC); the throughput delta vs PostgreSQL is batching — one durable WAL prepare per 8,190 transfers.

- **io_uring works.** 90% of TigerBeetle's I/O completes in 64–512 μs, with one `io_uring_enter` per ~11 I/Os (~24 transfers).

- **fsync is PostgreSQL's budget.** 4.17 million fsyncs for 10M INSERTs account for ~89% of wall-clock time. The latency histogram shows a healthy 163 µs per call — this isn't a "slow SSD" story, it's a "4.17 million calls" story. Batch the rows with `COPY` and the same PostgreSQL loads accounts 34× faster.

- **Storage amplification is the hidden cost.** TigerBeetle's 8.2× isn't waste. Each transfer writes up to 824 B of values into 11 of the 33 LSM trees (the transfer and its indexes, two account versions, and an `AccountEvent`), and compaction rewrites them at each level. Plan for ~1 TB/day of actual disk usage per 128 GB of raw transfers — the comparison with Postgres here is at the use-case level (transactions + ledger), not at matching indexes.

- **The real TB cost is read amplification, not writes.** During a 10M-transfer run, `/proc/pid/io` showed 142 MB/s writes (well within disk capacity) but **9 GB/s reads** — 1.95 TB total. That is ~195 KB read per transfer, mostly account lookups through the LSM tree; the VM's disk is a file on the Mac, so much of it likely came from the macOS page cache. On this workload throughput held steady at ~41–46K RPS from 3M to 10M transfers (10 GB → 27 GB file) — LSM compaction keeps up at this scale. The open question is where the throughput cliff is when the working set exceeds the 1 GB grid cache.

# Reproduce this yourself

Every number above was measured on one Mac Mini, in one afternoon, on a live Podman VM you can create in three commands.

```shell
podman machine init --cpus 4 --memory 8192 --disk-size 40
podman machine start
podman machine ssh "sudo rpm-ostree install bpftrace --idempotent" && \
  podman machine stop && podman machine start
```

Full setup, teardown, and bpftrace scripts are in the [benchmark repo](https://github.com/pratikgajjar/1b-payments). Cleanup is one line: `podman machine rm -f`.

---

[^1]: Simon Eskildsen, [Advanced Napkin Math: Estimating System Performance from First Principles](https://www.youtube.com/watch?v=IxkSlnrRFqc) (YouTube talk).

[^2]: Simon Eskildsen, [`sirupsen/napkin-math`](https://github.com/sirupsen/napkin-math) — the reference numbers for back-of-the-envelope system sizing.

[^3]: [`pratikgajjar/1b-payments`](https://github.com/pratikgajjar/1b-payments) — benchmark code, eBPF scripts, and setup guide for reproducing every number in this post.

[^4]: _Benchmarks were performed on an Apple M4 Mac Mini (10-core, 24 GB RAM) inside a Podman Linux VM (Fedora CoreOS 41, 4 CPU / 8 GB). Real-world performance will vary with storage, kernel, and workload._

[^7]: VR = [Viewstamped Replication](vr-revisited.pdf) — a leader-based consensus protocol by Oki & Liskov (1988), in the same family as Paxos and Raft. TigerBeetle's implementation is documented in their [VSR protocol docs](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vsr.md).

[^tb-cluster]: [TigerBeetle: cluster fault tolerance](https://docs.tigerbeetle.com/operating/cluster/) and `quorums()` in [`src/vsr.zig`](https://github.com/tigerbeetle/tigerbeetle/blob/0.16.78/src/vsr.zig).

[^tb-batching]: [TigerBeetle: automatic batching](https://docs.tigerbeetle.com/coding/requests/#automatic-batching)

[^xlogflush]: `XLogFlush` in [`src/backend/access/transam/xlog.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/access/transam/xlog.c)

_TigerBeetle® is a trademark of TigerBeetle, Inc. PostgreSQL® is a trademark of The PostgreSQL Global Development Group. This post is an independent benchmark and analysis — it is not affiliated with, endorsed by, or sponsored by either project. All trademarks belong to their respective owners._

# Corrections

*2026-05-06* — Two corrections from **[Chaitanya Bhandari](https://github.com/chaitanyabhandari)** ([@chaitybhandari](https://x.com/chaitybhandari)) of the TigerBeetle team:

- **TigerBeetle is fully ACID.** Original framing ("sidesteps the ACID tax") was wrong. The data file is opened with `O_DSYNC` ([linux.zig](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/io/linux.zig)) — every `write()` carries the durability barrier inline (the syscall returns only once data is on stable storage). The throughput win is batching: one durable WAL prepare per 8,190 transfers, not skipping fsync semantics.
- **27 secondary indexes, not 3.** Per [`state_machine.zig`](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/state_machine.zig): Account (7) + Transfer (12) + TransferPending (1) + AccountEvents (7). The Transfer groove has 14 LSM trees in total (`id` + `timestamp` + 12 secondary), and an insert fans out across all of them — explains the 8.2× on-disk amplification cleanly.

Deeply grateful to Chaitanya for the close read and source-level pointers.

*2026-09-28* — Replaced the hero image and the data-file diagram with interactive figures, added a group-commit figure, and fixed these while checking them against the TigerBeetle 0.16.78 source and the benchmark code:

- **A benchmark transfer writes to 7 of the Transfer groove's 14 trees, not all 14.** Zero fields in optional indexes (`pending_id`, `user_data_*`) are not indexed. Per transfer, TigerBeetle also writes two account versions and a 256 B `AccountEvent`: up to 824 B of values in 11 trees.
- **The superblock zone is 96 KiB (4 × 24 KiB), not ~64 MiB.** The 64 MiB is the client-replies zone, which the old diagram left out.
- **The commit quorum for 6 replicas is 3, not 4.** 4 is the view-change quorum. The old text also called the replica count Byzantine-safe; VSR tolerates crashes and storage faults, not Byzantine replicas.
- **Postgres does batch commits.** 0.42 fsyncs per row means about 2.4 commits share each WAL flush (group commit), not one flush per commit as the old hero image and summary box said. A TigerBeetle prepare is also two writes (the prepare and its header sector), not one.
- **The Postgres transfer benchmark runs two `UPDATE`s and one `INSERT` per transaction**, not an `INSERT` with FK checks alone.
- **TigerBeetle clients do not wait to fill a batch**, so the 273 ms fill time is not the latency at 30K TPS.
- **4,241 syscalls per 100,000 transfers** (one `io_uring_enter` per ~24), not ~4,600 (one per ~22).

*2026-10-17* — More fixes from a second read:

- **The `io_uring` trace shows about 46,000 I/Os for about 4,200 `io_uring_enter` calls**, not "tens of syscalls", so one call per ~11 I/Os.
- **The `io_uring` tail runs from 128 ms to 1 s**, not 128–512 ms, and the trace does not show its cause.
- **PostgreSQL makes 0.76 flushes per transfer**; 0.42 is per row in the INSERT-only run. Against that run TigerBeetle is ~4× faster, not ~5×.
- **The 195 KB read per transfer is a byte count, not 24 measured 8 KB page reads**, and much of the 9 GB/s probably came from the host's page cache.
- **The warm and cold tiers hold ~15 TB and ~90 TB** after compression, not ~45 TB and ~150 TB.

# Colophon

This post sat in `draft: true` for 13 months before an LLM with infinite patience for re-running benchmarks showed up. **Sonnet 4.6** drafted and ran the first traces; **Opus 4.6** came later for the skepticism sweep — caught a 4.5M→4.17M fsync discrepancy, a 567-vs-564 TB Parquet math bug, two dead TB-docs links, and a concurrency-degradation claim that turned out to be an artifact of dirty test state. **1,279 tool turns, $266, 95% cache hit.** Writing a blog post about a $600 box that can do 4 billion payments/day cost half a $600 box.

As a wise man once said: take microbenchmarks with a pinch of salt. These numbers are from one Mac Mini, one afternoon, one workload shape. Your mileage will vary with hardware, kernel version, data distribution, and whether Mercury is in retrograde. The value isn't the exact RPS — it's the *ratios* and the *bottleneck analysis* that transfer across environments.

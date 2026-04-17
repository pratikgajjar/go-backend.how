---
title: "💸 1B Payments/Day - TigerBeetle & PostgreSQL"
date: 2025-03-01
lastmod: 2026-04-05
description: "Can one bank absorb India's entire daily UPI volume? A first-principles design exercise with real benchmarks: TigerBeetle vs PostgreSQL, traced with eBPF down to the io_uring and fsync calls."
tags: ["golang", "tigerbeetle", "payments", "first-principles", "system-design", "ebpf"]
draft: false
theme: "honey"
featured: true
math: true
---

India moves money like no other country. By February 2026, UPI was clearing **20+ billion** digital transactions per month — nearly half of all real-time payments on Earth.

| Month  | Banks on UPI | Volume (Mn) | Value (₹ Cr.) |
| ------ | ------------ | ----------- | ------------- |
| Feb-26 | 694          | 20,394.18   | 26,84,229.29  |
| Jan-26 | 691          | 21,703.44   | 28,33,481.22  |
| Dec-25 | 685          | 21,634.67   | 27,96,712.73  |
| Jan-25 | 647          | 16,996.00   | 23,48,037.12  |
| Dec-24 | 641          | 16,730.01   | 23,24,699.91  |
| Nov-24 | 637          | 15,482.02   | 21,55,187.40  |

Source: [NPCI product-statistics](https://www.npci.org.in/what-we-do/upi/product-statistics)

Put those numbers side-by-side: Jan 2025 to Jan 2026, volume jumped from 17B to 21.7B in a single year — **28% YoY growth, month after month**. Bank count grew from 647 → 691. Rupee value from ₹23.48L Cr → ₹28.33L Cr.

That's ~700 million transactions per day today, spread across 694 banks. At 28% YoY, UPI crosses **1 billion transactions per day by late 2027**. The biggest banks (SBI, HDFC, ICICI) already handle 15–25% of volume each, so the "1B/day for a single bank" threshold — which feels fantastical today — is table-stakes engineering by 2028.

**What does it take for one node to handle 1 billion payments per day?** That's ~12,000 TPS average, ~30,000 TPS at the normal daily peak (2.5× the average — morning 11 AM rush and evening 8-10 PM burst). Seasonal spikes (Diwali shopping, IPL finals, tax deadline) push another 2× on top, so budget closer to **5× the average (~60,000 TPS)** for actual worst-case capacity.

Can a single node handle it? Could you do it on a laptop? The answer to both is "closer than you'd think," but the interesting question is *how*. This post walks through the first-principles design, then actually runs it on a Mac Mini (M4, 10-core, 24 GB), tracing every io_uring and fsync call from the kernel. No vendor slide decks, no hand-waving. The headline numbers:

- Single TigerBeetle process sustaining **~48K transfers/sec** (63K burst) vs same machine's PostgreSQL at **3,356 RPS** — a **~14×** gap traceable to one syscall.
- What `io_uring` looks like from the kernel: 90% of I/O in 64–512 μs, **zero** `fsync` calls.
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
\text{avg TPS} = \frac{10^9 \text{ transfers/day}}{86{,}400 \text{ s/day}} = 11{,}574 \approx 12{,}000 \text{ TPS}
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

Both records are **128 bytes** — this isn't arbitrary. It fits cache lines, aligns with page boundaries, and packs 8,190 of them into a single 1 MB network batch (which is why that magic 8,190 keeps showing up in TigerBeetle's docs).

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

I tested every Parquet codec on TB's 128-byte Transfer schema. The winner: **zstd(3) with dictionary encoding — 27.3 B/row, 4.7× compression, 0.16 s to write 100 MB.**

- **zstd(3) does ~97%** of the work. Levels 9 and 22 buy <1% more at 10–50× the CPU.
- **Dictionary** adds ~2% on the 12 low-cardinality columns (`ledger`, `flags`, `code`, zero-fields).
- **Delta** on `id_hi` and `timestamp` contributes **<1%** — noise once zstd has a pass. If you want the last percent, `BYTE_STREAM_SPLIT` on random u64s gets you to 25.7 B/row (4.98×) for free.
- **80 of 128 bytes are random** (amount + account IDs) — no structural compression possible there.
- Ratio saturates at **81K rows** (10× a TB batch) — no need for millions to measure.

**10-year cold tier: ~94 TB on S3, ~$2,150/month.** The [full benchmark](https://github.com/pratikgajjar/1b-payments/blob/main/bench/parquet_scales.py) is 200 lines of Python, 15 seconds to run.

For the hot tier: each primary takes `500M × 128 B × 8.2 × 90 days = 47 TB`. That's **3 × 20 TB NVMe per node, 22% headroom for LSM compaction**. With two sharded clusters of 6 nodes each, that's 36 drives total — still a single rack.

## What 30K TPS means on disk

$$
30{,}000 \text{ TPS} \times 128 \text{ B} = 3.84 \text{ MB/s}
$$

That's trivial — a 2010-era HDD could sustain it if fsync didn't exist. Modern NVMe (1–7 GB/s sequential, depending on hardware) is **hundreds of times oversized** for the raw data rate. The entire challenge is in the indirection between "user-visible throughput" and "actual bytes written to disk + syncs issued per byte."

### Batching math (the TigerBeetle approach)

TigerBeetle's client packs **8,190 transfers per batch** (fits one 1 MB message envelope):

$$
8{,}190 \text{ transfers} \times 128 \text{ B} = 1{,}048{,}320 \text{ B} \approx 1 \text{ MB}
$$

At 30K TPS, one batch fills in:

$$
t_{\text{fill}} = \frac{8{,}190}{30{,}000} = 273 \text{ ms}
$$

That's ~3.66 batches/sec. How long does each batch take on the server? We measured ~48K RPS sustained, which is \(48{,}000 / 8{,}190 \approx 5.9\) batches/sec — so **~170 ms per batch** of server-side processing (LSM inserts, balance checks, io_uring writes, checksums). The raw NVMe I/O for 1 MB is ~1 ms; the other 169 ms is CPU work.

At 30K TPS, filling a batch takes 273 ms but processing takes only 170 ms — the pipeline is **fill-bound**, not server-bound. The client fills batch N+1 while the server processes batch N, so effective latency ≈ \(t_{\text{fill}} = 273\) ms. Users don't notice 273 ms on a payment. If your peak is lower, the timeout fires sooner and latency drops proportionally.

# TigerBeetle

[TigerBeetle](https://tigerbeetle.com/) is a financial transactions database written in Zig. It makes a narrow but aggressive set of design choices: double-entry accounting as the only data model, one writer thread per node, `io_uring` + `O_DIRECT` for all disk I/O, and deterministic simulation testing as the primary correctness story.

Those two flags are worth unpacking, because they're half the reason the numbers later in this post look the way they do.

**`O_DIRECT` — "don't cache this in RAM first."** Normally when you "write" to a file, Linux copies your bytes into a kernel page cache and returns immediately, promising to really save them later. That's fast, but the data hasn't actually reached the disk — which is why a crash can lose committed work unless you also call `fsync`. `O_DIRECT` skips the page cache: your bytes go straight from your program's memory to the storage device. You manage the buffers; the kernel doesn't lie to you about durability.

**`io_uring` — "stop calling me for every little I/O."** The old way, every single read or write is a round trip through the kernel — a syscall: dial, pass arguments, wait for the answer, hang up. For a database doing millions of small I/Os, all that dialling is pure overhead. `io_uring` replaces the phone with two shared ring buffers sitting in memory that both your program and the kernel can see: you drop requests onto a "submission" ring, the kernel posts results onto a "completion" ring. One syscall (`io_uring_enter`, the doorbell) can hand off a thousand I/Os at once.

Together they give TigerBeetle the shortest path from "I want to write this transfer" to "the platter has the bits": no kernel page cache to lie about durability, no syscall tax per I/O. We'll watch this directly with eBPF later — thousands of I/Os completing with tens of syscalls total.

The production topology is a 6-node VR-style[^7] consensus cluster: one primary processes all writes, five followers replicate. Critically, **adding followers buys reliability, not throughput** — the primary is still a single thread. You scale TigerBeetle by sharding account ranges across *multiple* clusters, not by adding cores to one cluster.

$$
\begin{CD}
  \text{client writes} \\
  @VVV \\
  \boxed{\;\text{PRIMARY}\;} @>\text{replicate}>> \boxed{\;\text{follower}\;} \times 5 \\
  @VVV \\
  \text{commit ACK} @<<{\text{quorum: } 4/6}< \\
\end{CD}
$$

<p style="text-align:center; font-family: var(--font-mono); font-size: 0.85rem; opacity: 0.7; margin-top: -0.5rem;">one thread · LSM + journal · io_uring + O_DIRECT</p>

With 6 replicas you tolerate 2 simultaneous node failures. A primary election needs 4 live nodes (4-of-6 quorum). The quorum math drives the "6" default — you want Byzantine-safe counts without paying for 7 or 9.

## Benchmarks — on a Mac Mini M4

Everything below was measured on a single Apple M4 Mac Mini[^4] (10-core, 24 GB RAM, macOS 26.1) with TigerBeetle 0.16.78 running inside a Podman Linux VM (Fedora CoreOS 41, kernel 6.12.13-aarch64, 4 CPU / 8 GB memory allocated). Setup and cleanup instructions are in the [reproduction guide](https://github.com/pratikgajjar/1b-payments).

### Account creation

```shell
$ go run ./cmd/tb/accounts/main.go -tbAddress "3000" -startAt 1 -endAt 10000000
Created accounts from 1 to 10000000 (total: 10000000, failed: 0)
Time taken: 12.277s
```

**10 million accounts in 12.3 seconds — 815,000 accounts/second.**

That's a batched operation: the client pushes 8,190 accounts per batch (the TigerBeetle default, sized to fit its 1 MB message envelope). Each batch is one network round-trip.

### Transfers — the single-worker baseline

Transfers are where it gets interesting. The workload: 80% of transfers debit from the top 20% of accounts (hot accounts — think merchants receiving many small payments), 20% from the rest.

```shell
$ go run ./cmd/tb/transfers/main.go -concurrency 1 -totalTransfer 10000000
done: ok=9999995 err=5 time=3m34.5s RPS=46614
```

**1 worker goroutine → 46,614 transfers/sec.**

Five errors out of 10 million: those are the edge cases in the 80/20 distribution where top-20 accounts don't generate enough volume — negligible. The five failures are `exceeds_credits` — expected in any skewed workload.

A shorter 1M-transfer burst on a fresh database pushed it to **63K RPS**. Client concurrency (1, 4, or 8 goroutines) doesn't meaningfully change throughput — the server is single-threaded, so batches serialize regardless of how many clients submit them.

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

**90% of I/O completes in 64–512 μs** (93% if you extend to 1 ms). The tail — a handful of completions in the 128–512 ms range — are the checkpoint flushes, where TigerBeetle moves an on-disk manifest to the next LSM-tree level. Nothing is blocking the hot path on a per-transfer `fsync`.

### Counting every syscall TigerBeetle makes

```d
$ sudo bpftrace --unsafe raw_sys.d $TB_PID
# 100,000 transfers processed
@syscalls[64]:      2   (write)
@syscalls[206]:    14   (sendto — network replies)
@syscalls[426]: 4,225   (io_uring_enter)
```

**~4,600 total syscalls to commit 100,000 transfers.** Roughly one `io_uring_enter` per ~22 transfers — one doorbell ring to tell the kernel "process this batch of ready I/Os." There are **zero** `fsync()` calls. Durability isn't provided by `fsync` here; it's provided by `O_DIRECT` writes + the WAL's circular journal structure.

Hold this number. In a minute we'll see PostgreSQL do 4.17 million fsyncs for the same volume.

### Storage: 8× amplification

After 10M accounts + 10M transfers, the data file is **21 GB**.

```shell
$ ls -lh ~/bench/tb/0_0.tigerbeetle
-rw-r--r--. 1 core core 21G Apr  5 00:36 0_0.tigerbeetle
```

Raw expected: `10M × 128B + 10M × 128B = 2.56 GB`. **Actual: 21 GB. 8.2× amplification.**

Where does it go? Everything lives in one file — `0_0.tigerbeetle` — divided into three zones:

```txt
0_0.tigerbeetle (21 GB after 10M accounts + 10M transfers)
┌────────────────────────────────────────────────────────────────┐
│  Superblock (x4 copies)                            ~64 MiB     │
│  Root pointers: manifest + free set + checksums                │
│  Updated infrequently; swaps atomically                        │
├────────────────────────────────────────────────────────────────┤
│  WAL -- write-ahead log (ring buffer)             ~1.06 GiB    │
│  1,024 prepare slots x 1 MiB each + 256 KiB headers            │
│  This is the durability layer: O_DIRECT writes go here         │
│  No fsync needed -- circular journal + checksums               │
├────────────────────────────────────────────────────────────────┤
│  Grid (elastic, grows with data)                  ~20 GB       │
│  512 KiB blocks: LSM tree tables + indexes                     │
│                                                                │
│  Each table = 1 index block + N value blocks (sorted)          │
│  Levels: L0 (in-memory) -> L1 -> L2 -> ... (exponential)       │
│  Compaction merges levels asynchronously                       │
│                                                                │
│  LSM trees stored:                                             │
│    accounts (by timestamp key)                                 │
│    transfers (by timestamp key)                                │
│    transfers_by_debit_account_id  (secondary index)            │
│    transfers_by_credit_account_id (secondary index)            │
│    transfers_by_timestamp         (secondary index)            │
└────────────────────────────────────────────────────────────────┘
```

- **Superblock**: the root pointer to all state. Stores block references (index + u128 checksum) for the manifest and free-set. Written atomically as 4 copies on disk — if a crash corrupts one copy, 2+ survive.
- **WAL**: the ring buffer where each `prepare` is written via O_DIRECT before the state machine processes it. After enough prepares, the superblock is updated to point to the new grid state. On crash recovery, replaying the WAL from the last superblock reproduces the exact same state (deterministic).
- **Grid**: the bulk of the file. An array of 512 KiB blocks implementing a purely functional, copy-on-write data structure (like a filesystem). Each LSM tree level holds sorted tables; compaction merges them into deeper levels. The 3 secondary indexes (debit/credit account + timestamp) each maintain their own LSM tree — these alone contribute ~3× the raw write volume.

The amplification is constant (not growing with load) — once the LSM tree reaches equilibrium, additional writes roll through the levels at a fixed ratio. For the 1B/day workload, this means the napkin-math[^2] of `128 GB/day raw` is closer to `~1 TB/day on disk` in practice.

# PostgreSQL

Same workload, same machine — now through a general-purpose database. [PostgreSQL 17](https://www.postgresql.org/about/news/postgresql-174-168-1512-1417-and-1320-released-3018/) running in a container on the same Mac Mini.

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

## Benchmarks

Same hardware, same workload — now running against PostgreSQL 17 in a container on the same Mac Mini.

### Accounts, two ways

There are two patterns for account creation. `COPY` is the bulk path — send N rows to the server, parse once, write once, fsync once. `INSERT` is the "realistic" path where each account comes in as its own transaction with its own commit boundary.

**COPY (bulk):**

```shell
$ go run ./cmd/pg/accounts/main.go -totalAccounts 10000000 -concurrency 1
Inserted 10000000 accounts in 22.3s
```

**22.3 seconds for 10M accounts — 448,763 accts/sec.** About half of TigerBeetle's 815K/sec, not bad for a general-purpose DB.

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

**Every commit writes twice** — once to the WAL (for durability + crash recovery), then later to the heap file during a checkpoint. The commit `fsync()` only syncs the WAL. Data files get synced in bulk at checkpoint time, which is why bursts of fsyncs cluster around the active WAL segment.

### Watching fsync in real time

Every PostgreSQL commit forces a `fdatasync()` on the active WAL segment. `fdatasync` ensures the page cache actually reaches disk — without it, `kill -9` on the server could lose committed transactions. Count these calls with bpftrace:

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

Notice fd 9 and fd 11 both point to the **same** WAL file. That's not a bug — each of the 8 worker goroutines has its own PostgreSQL backend process, and **each backend has its own file descriptor table**. When 8 backends all need to fsync the active WAL segment, the kernel sees 8 different fds pointing to the same inode. They fan-in to one durable-write operation at the disk layer, which is why everything past fd 9 and fd 11 is tiny — all 4.17M fsyncs funnel through two hot fds, one per currently-open WAL segment.

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

**Weighted-average fsync latency: 163 µs. 97% finish under 256 µs, 100% under 512 µs.** The tail is tiny. The SSD is fine. But you're doing **4.17 million of them**, funnelled through a small number of WAL file descriptors, and that's where throughput goes to die.

Quick math:

$$
4{,}177{,}054 \text{ fsyncs} \times 163 \text{ µs} = 681 \text{ seconds of sequential fsync work}
$$

The benchmark took 766 seconds total:

$$
\frac{681}{766} = 89\% \text{ of wall-clock time accounted for by durability syscalls}
$$

The remaining 11% is where the CPU actually executes queries and moves data around. With 8 workers, that serial fsync cost parallelises partially at the disk level, but the fundamental arithmetic doesn't change: PostgreSQL is spending nearly all its time waiting for storage to say "yes, written."

This is the fundamental tax of ACID. TigerBeetle sidesteps it entirely — zero fsyncs, durability via `O_DIRECT` writes + circular WAL + checksums. PostgreSQL, in the single-row INSERT pattern, pays **0.42 fsyncs per row**.

### Transfers — the real payment workload

```shell
$ go run ./cmd/pg/transfer/main.go -totalTransfers 2000000 -concurrency 10
Processed 2000000 transfers, errors: 0, took: 9m56s
```

**2M transfers in 9m56s = 3,356 RPS.** This is the workload that actually models a payment — each transfer does:

1. `BEGIN`
2. Validate FK on `debit_account_id` and `credit_account_id` (two B-tree index lookups)
3. `INSERT` into transfers (PK + 2 FK indexes maintained)
4. `COMMIT` → `fdatasync` on WAL

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

Transfers generate **almost 2× more fsyncs per row** (the WAL must record both the INSERT into `transfers` and the implicit FK validation I/O). Average fsync latency jumps from 163 µs to 253 µs — bigger WAL records per transaction. And only 64% of wall-clock goes to fsync, not 89% — the remaining **36% is real CPU work**: FK lookups, row-level locks on hot accounts (10 workers contending on the 80/20 skewed distribution), B-tree index splits, and MVCC version row creation for eventual VACUUM.

This is why the transfer throughput (3.4K) is 4× lower than INSERT throughput (13K), not the 1.8× you'd predict from the fsync ratio alone. The FK validation and row-lock contention on the accounts table add a constant per-transfer CPU overhead that doesn't show up in fsync counts. TigerBeetle, doing the same semantic work (debit A, credit B, enforce balance invariants), batches 8,190 transfers into one durable commit — with zero fsyncs and no row-level locking.

# Hot / Warm / Cold Tiering

Indian banking regulations require **10 years of transaction retention**. At 128 GB/day raw, that's 467 TB before compression. You can't keep all of that in TigerBeetle's hot tier. We ran 10M transfers in 1M sequential chunks on a single M4 Mac Mini and throughput held steady at **~41–46K RPS from 3M to 10M** (10 GB → 27 GB file) — the LSM compaction keeps up at this scale. But at 1B/day the data file grows by ~1 TB/day (after 8.2× amplification); at some point the working set exceeds the grid cache and throughput will drop. Tiering isn't optional, it's structural.

The solution: **checkpoint and archive**. TigerBeetle's accounts already represent a running balance — the cumulative effect of every transfer ever processed. If you snapshot account balances at a cutoff date, every transfer before that date becomes archival. The account balances ARE the checkpoint: you don't need the old transfers to know the current state, only to audit history.

| Age | Tier | Storage | Query Latency |
|---|---|---|---|
| 0–90 days | **Hot** — TigerBeetle cluster | ~100 TB × 6 replicas = ~600 TB | single-digit ms |
| 90 days–1 year | **Warm** — ClickHouse / Parquet on NVMe | ~45 TB (compressed 2–3×) | seconds |
| 1–10 years | **Cold** — S3 / GCS Parquet, partitioned by day | ~150 TB (compressed 3–5×) | minutes |

### The archival pipeline

1. **Scheduled rollover job** (nightly): query TigerBeetle for transfers with `timestamp < NOW() - 90d`, stream to Parquet files partitioned by day. The account balances at the cutoff date are the checkpoint — save those alongside the archived transfers.
2. **Columnar compression** on the way out: zstd gets ~4.7× on this schema (we measured it — 27 B/row with dictionary encoding on the low-cardinality fields).
3. **Compact the hot tier.** TigerBeetle doesn't have DELETE — it's an append-only ledger by design. The current path is a rolling data-file migration: format a new file, replay accounts + recent transfers, swap. This is where TB is still maturing operationally — native checkpoint-and-truncate would make tiering a first-class operation instead of an external migration.
4. **Rehydration**: on a legal-hold query or dispute, pull the relevant Parquet partition back into a warm ClickHouse instance. The checkpoint balances let you validate the rehydrated transactions against the known-good state at that date. Don't try to import back into the hot ledger — that invalidates the immutability guarantee.

## Head-to-Head

Same hardware. Same workload. Same afternoon.

| Operation | TigerBeetle | PostgreSQL | Ratio |
|---|---:|---:|---:|
| 10M accounts (bulk) | 12.3s (815K/s) | 22.3s COPY (449K/s) | **1.8×** |
| 10M accounts (per-row commit) | 12.3s (815K/s) | 12m46s INSERT (13K/s) | **62×** |
| Transfers throughput | ~48K sustained / 63K burst | 3,356 RPS | **~14×** |
| Storage amplification | 8.2× | 1.2× | PG wins |
| fsyncs per row | **0** | 0.42 | ∞ |
| io_uring_enter per 100K rows | 4,225 | n/a | — |
| Concurrency model | single-threaded (by design) | scales with workers | different tradeoffs |

Two ratios: **~14×** compares TB's sustained (48K) to PG's transfer rate (3.4K). On the INSERT-only workload (per-row commit, 10M rows), the gap is **~5×** (63K vs 13K). The difference: PG transfers do two FK lookups + row-level locking + MVCC bookkeeping per row that the INSERT-only test skips.

> PostgreSQL makes 0.42 fsyncs per transfer. TigerBeetle makes zero. Durability goes through `io_uring_enter` + `O_DIRECT`, which costs one kernel entry per ~24 transfers.

## What 1B/Day Actually Costs

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

The hard constraint isn't storage. It isn't throughput. It's the **operational blast radius** of each design choice.

## What the eBPF traces proved

This wasn't a vendor shootout. I wanted to see the kernel-level reasons why these numbers diverge. The syscall traces are unambiguous:

- **Single-core by design works.** TigerBeetle sustains ~48K RPS (10M steady-state) and bursts to ~63K (1M fresh) on one thread. Client concurrency (1, 4, or 8 goroutines) doesn't change throughput — batches serialize at the primary regardless.

- **TigerBeetle made zero fsync calls.** For 100,000 transfers, it issued 4,241 total syscalls — 4,225 of them `io_uring_enter`, the rest `sendto` for network. Durability comes from `O_DIRECT` writes passing through the WAL's circular journal, not from synchronous `fsync`. This is the single biggest throughput delta between the two systems.

- **io_uring isn't a marketing term.** 90% of TigerBeetle's I/O completes in 64–512 μs. The kernel ring buffer is doing exactly what it promised: amortized low-overhead async I/O with one doorbell ring per ~24 ops.

- **fsync is PostgreSQL's budget.** 4.17 million fsyncs for 10M INSERTs account for ~89% of wall-clock time. The latency histogram shows a healthy 163 µs per call — this isn't a "slow SSD" story, it's a "4.17 million calls" story. Change the per-row-commit pattern (to COPY, or to pipelined transactions) and PG gets 34× faster instantly.

- **Storage amplification is the hidden cost.** TigerBeetle's 8.2× isn't waste — it's LSM levels + 3 secondary indexes + fault-tolerance padding, all pre-paid. Plan for ~1 TB/day of actual disk usage per 128 GB of raw transfers.

- **The real TB cost is read amplification, not writes.** During a 10M-transfer run, `/proc/pid/io` showed 142 MB/s writes (well within disk capacity) but **9 GB/s reads** — 1.95 TB total. Each transfer triggers ~24 random 8 KB page reads through the LSM tree for account balance lookups. On this workload throughput held steady at ~41–46K RPS from 3M to 10M transfers (10 GB → 27 GB file) — LSM compaction keeps up at this scale. The open question is where the throughput cliff is when the working set exceeds the 1 GB grid cache.

## When to use what

The question isn't "which is better" — it's "where does each one belong in the same system?"

TigerBeetle is a **ledger accelerator**. If the operation is `debit A, credit B, enforce invariants, commit` — and it happens millions of times per day — that's TigerBeetle. Everything else (KYC, disputes, merchant metadata, reporting, anything that needs a JOIN or a WHERE clause you haven't thought of yet) stays in Postgres. Most production deployments will run both.

## Does napkin math predict this?

Two numbers from sirupsen's napkin-math[^2] settle both arguments:

> **SSD write + fsync (8 KiB): 300 µs**
> **Sequential SSD write, no fsync (8 KiB): 2 µs, 3 GiB/s**

**Hypothesis: PG is fsync-bound.** PG commits one row = one fsync. A disk can do \(1\text{ s} / 300\text{ µs} \approx 3{,}300\) fsyncs per second, so one worker tops out at 3,300 RPS. Eight workers with group commit buy a modest boost (maybe 3–4×), so expect **~10K RPS**. Measured: 13K RPS → same order of magnitude → **hypothesis holds**.

**Hypothesis: TB is write-bandwidth-bound.** TB doesn't fsync at all — it uses `O_DIRECT` + `io_uring`, so the ceiling is raw write bandwidth. Raw data per transfer is 128 B, but the LSM tree adds ~8× write amplification (journal + level flushes + manifest), so the disk actually sees about 1 KB per transfer. Using sirupsen's 3 GiB/s reference:

$$
\frac{3 \text{ GiB/s}}{128 \text{ B} \times 8 \text{ amp}} \approx 3 \text{ million TPS}
$$

Measured: 47K TPS → ~60× below the ceiling → **write bandwidth isn't it**. My M4 Mac Mini's actual write bandwidth (`dd bs=1M oflag=direct`) is 1.3 GB/s, which still gives a 27× margin. Writes are ruled out either way.

**So what IS the bottleneck?** Digging deeper with `/proc/pid/io` during a 10M-transfer run revealed the culprit: **disk reads, not writes**.

| Metric | Value |
|---|---|
| Disk writes | 142 MB/s (30 GB total) |
| **Disk reads** | **9 GB/s (1.95 TB total!)** |
| Read per transfer | ~195 KB |
| CPU (single thread) | 85% |

Each transfer requires account balance lookups through the LSM tree. With 10M accounts spread across multiple LSM levels, that means reading index blocks + data pages from several sorted runs per lookup — **about 24 random 8 KB page reads per transfer**. In our degradation test (1M-transfer chunks, sequential IDs, same DB), throughput held at **~41–46K RPS from 3M to 10M cumulative transfers** (10 GB → 27 GB file). LSM compaction keeps pace at this scale — the throughput cliff likely comes when the working set exceeds the grid cache (1 GB in our test configuration).

The napkin-math story ends here: **sirupsen's write numbers correctly told us writes aren't the bottleneck. But predicting the actual throughput requires knowing the LSM read amplification — and that depends on data size, tree depth, and bloom filter effectiveness.** Those are implementation details that don't fit on a napkin. Napkin math is best at ruling things OUT, not at predicting the final answer.

## The lesson

Both systems run on the same SSD. The difference is **what they ask the disk to do per transfer**:

```txt
TigerBeetle:  zero fsyncs — O_DIRECT + io_uring + circular WAL  →  47K RPS   (not disk-bound)
PostgreSQL:   0.42 fsyncs per row (fdatasync on WAL commit)      →  13K RPS   (fsync-bound)

                        ↓
                  ~4× throughput gap on the per-row-commit workload
                  zero vs millions of fsyncs — different durability model, not a knob
```

TigerBeetle's durability comes from the structure of its WAL (circular journal + O_DIRECT writes + checksums) rather than from calling `fsync` after every commit. PostgreSQL *has* to `fdatasync` on every commit — that's what `synchronous_commit = on` means, and turning it off gives you faster COMMITs at the price of losing the last few hundred ms of committed data on crash.

**If every payment must be durable the instant it's written and your clients can't batch, you're paying the fsync tax on every COMMIT — plan for it, or move the ledger hot path off your OLTP database.** Both are legitimate choices. Just know which one you're making.

## Reproduce this yourself

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

[^5]: [TigerBeetle](https://tigerbeetle.com/) — the financial transactions database used in this post's benchmarks.

[^6]: [PostgreSQL](https://www.postgresql.org/) — the open-source relational database used in this post's benchmarks.

[^7]: VR = [Viewstamped Replication](vr-revisited.pdf) — a leader-based consensus protocol by Oki & Liskov (1988), in the same family as Paxos and Raft. TigerBeetle's implementation is documented in their [VSR protocol docs](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vsr.md).

_TigerBeetle® is a trademark of TigerBeetle, Inc. PostgreSQL® is a trademark of The PostgreSQL Global Development Group. This post is an independent benchmark and analysis — it is not affiliated with, endorsed by, or sponsored by either project. All trademarks belong to their respective owners._

## Colophon

This post sat in `draft: true` for 13 months before an LLM with infinite patience for re-running benchmarks showed up. **Sonnet 4.6** drafted and ran the first traces; **Opus 4.6** came later for the skepticism sweep — caught a 4.5M→4.17M fsync discrepancy, a 567-vs-564 TB Parquet math bug, two dead TB-docs links, and a concurrency-degradation claim that turned out to be an artifact of dirty test state. **1,279 tool turns, $266, 95% cache hit.** Writing a blog post about a $600 box that can do 4 billion payments/day cost half a $600 box.

As a wise man once said: take microbenchmarks with a pinch of salt. These numbers are from one Mac Mini, one afternoon, one workload shape. Your mileage will vary with hardware, kernel version, data distribution, and whether Mercury is in retrograde. The value isn't the exact RPS — it's the *ratios* and the *bottleneck analysis* that transfer across environments.

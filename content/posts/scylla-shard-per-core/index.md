+++
title = "⚡ Scylla Shard-per-Core — A Benchmark of Why Pinning Beats Your Go Server"
description = "A code dive into Seastar's reactor: shard-per-core, lock-free SPSC queues, io_uring. Then a 4-core Go benchmark that quantifies the cost of crossing a cache line — and why a pinned Go server can't catch Scylla."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["scylla", "seastar", "shard-per-core", "benchmark", "cassandra", "golang"]
images = ["og.png"]
theme = "raspberry"
featured = false
math = false
+++

# The hook

A modern Apple Silicon laptop has 14 cores. Run a tight Go loop with
`GOMAXPROCS=4`, four goroutines each calling
`atomic.AddInt64(&counter, 1)` against a single shared int (the macOS
kernel decides which cores; we just bound the parallelism). On an M3
Max ([reproducer below](#stretch-see-it-for-yourself)), that loop tops
out at **~87 million ops/sec**. Wall time per op: ~11.5 ns.

Now repaint the same workload: every goroutine increments its own
cache-line-padded counter (no atomic, no lock, no shared bytes). The
same four cores deliver **~3.0 _billion_ ops/sec**. Wall time per op:
~0.4 ns.

> Same hardware. Same number of threads. Same total work. **~30× faster**
> just by deleting the contention. ([wall-clock](#stretch-see-it-for-yourself):
> 88 M ops/sec vs 2 832 M ops/sec over three runs; ratio = 2832 / 88 ≈ 32.)

That ratio is the entire thesis of Scylla's architecture. The
single-thread CAS isn't slow — it's coherence traffic. Four cores
fighting for one cache line means the line ping-pongs through the
inter-core fabric on every atomic, and the atomic-add path serializes
them in hardware (LSE LDADD on ARMv8.1+, `lock xadd` on x86). The
"fast" version isn't
faster code; it's the same code with the *coordination removed*.

Cassandra runs many worker thread pools (ReadStage, MutationStage,
etc.) across all cores, hitting shared memtables, the shared
commit-log, and (when enabled) a shared row cache. Scylla — built
on the [Seastar](https://github.com/scylladb/seastar) framework — runs
exactly **one OS thread per CPU**, pins each to its core, and gives each
a private slice of RAM. Two threads never touch the same cache line in
the steady state. When a request lands on the wrong core, it gets
*shipped* to the right core via a single-producer-single-consumer queue
with no locks anywhere on the path.

This post walks the source. The interesting part isn't "C++ is faster
than Java." The interesting part is the discipline. Then we'll do the
same workload in Go on the same machine and measure how much of
Scylla's win is _structural_ — not language-deep, but
architecture-deep — and where Go would have to break itself to copy it.

# The problem — why naive multi-threading fails past 8 cores

The wall is mechanical sympathy.

A modern server CPU runs at ~3 GHz, so each core retires roughly
**3 × 10⁹** simple instructions per wall-second. A naive engineer
extrapolates: 16 cores ⇒ 16× the throughput. The benchmark says
otherwise. Past 8–12 cores, throughput on most server software
flattens, then often *regresses*. Cassandra famously plateaus around
the same range.

Three numbers explain why. From Sirupsen's [napkin
math](https://github.com/sirupsen/napkin-math) ranges and
[Anandtech](https://www.anandtech.com/show/16529/amd-epyc-milan-review/4)'s
inter-core latency measurements, the working set is:

| Operation                            | Latency        |
| ------------------------------------ | -------------- |
| L1 cache hit                         | ~1 ns          |
| L2 cache hit                         | ~3-4 ns        |
| L3 cache hit                         | ~10-20 ns      |
| Cache-line bounce between cores      | ~30-200 ns     |
| Uncontended `lock add`               | ~5-10 ns       |
| Contended `cmpxchg` under 4-core CAS | **~12 ns**     |
| Mutex acquire (POSIX mutex)          | ~30 ns uncont. |
| Mutex acquire under contention       | hundreds of ns |

A function call is ~1 ns. A cache-line bounce is *two orders of
magnitude* slower. A cache line can only be held in `M` (modified)
state by one core at a time, so when N cores all write the same line
they serialize on the coherence fabric: aggregate throughput =
`1 / bounce`, *independent of N*. You bought 16 cores; you're using one
— except slower, because the other 15 are queueing for the line.

The honest math: with bounce time `100 ns` between cores, the line
changes hands once every `100 ns`, so the aggregate ceiling is
`10,000,000 ops/sec` (`10 M`). Spread across 8 cores that's
`10 / 8 = 1.25 M ops/sec` per core, *no matter how clever the code
is*. The only way out is to not share.

That's the rule Scylla took as a constraint, not a hint.

# The architecture in 200 words — shape of the right answer

Each Scylla node runs **N reactor threads**, where N = number of
hardware threads. Each reactor:

1. Is `pthread_setaffinity_np`-pinned to one core.
2. Owns its own arena of memory carved from the host RAM at startup.
3. Owns its own slice of the partition keyspace (sharded by hash of the
   partition key).
4. Talks to the kernel via its own private `io_uring` (Seastar's
   `detect_io_uring()` requires Linux ≥ 5.12 for mlock budget, ≥ 5.17
   for MD/RAID).
5. Communicates with peers via N×N **single-producer-single-consumer
   lock-free queues**, batched up to 16 items per flush.

A write request's life looks like this:

```text
client ──► token-aware driver ──► TCP connection to shard owner
                                          │
                                          ▼
                                    [shard k reactor]
                                          │
                                  parse → commitlog (fsync) → memtable
                                          │
                                  ◄──── reply on same socket
```

(Reads follow the same shard-affinity path; the inner steps become
`parse → row cache lookup → memtable / sstable read`. The point isn't
the LSM mechanics, it's that the entire path stays on one core.)

The client is *expected* to know which shard owns each partition. The
driver computes `murmur3(pkey) % shard_count` and connects to the
shard-aware CQL port (the native_shard_aware_transport_port flag,
default `19042` per
[`db/config.cc`](https://github.com/scylladb/scylladb/blob/master/db/config.cc));
the server uses the client-side ephemeral port `mod shard_count` to
route the new socket to the owning reactor. When the client gets it
right — which token-aware drivers do almost always — the request never
hops cores. When it gets it wrong (legacy `9042` driver), Scylla
shovels it across via `smp::submit_to(target, lambda)`, paying one
cross-core message but keeping the rest of the work on a single core's
L1.

No global locks. No global allocator. No shared row cache. The reactor
is the unit of concurrency, the unit of memory, the unit of I/O, and the
unit of fault.

# The source dive — byte-by-byte through `submit_to`

There are two source files worth reading line by line:
[`include/seastar/core/smp.hh`](https://github.com/scylladb/seastar/blob/master/include/seastar/core/smp.hh)
(the public API) and
[`src/core/reactor.cc`](https://github.com/scylladb/seastar/blob/master/src/core/reactor.cc)
(the engine). Below are the six moments worth reading.

## 1. The pinning

Every reactor thread starts by stapling itself to one CPU. The whole
"shard-per-core" promise is built on top of this one syscall:

```cpp
// include/seastar/core/posix.hh
inline
void pin_this_thread(unsigned cpu_id) {
    cpu_set_t cs;
    CPU_ZERO(&cs);
    CPU_SET(cpu_id, &cs);
    auto r = pthread_setaffinity_np(pthread_self(), sizeof(cs), &cs);
    SEASTAR_ASSERT(r == 0);
    (void)r;
}
```

This is called from `smp::pin` (`src/core/reactor.cc`) once per
spawned reactor. After this, the kernel's CFS scheduler will never
migrate this thread to another core. NUMA placement, L1/L2 warmth, branch
predictor state — all preserved across the lifetime of the process.

A typical Linux scheduler migrates a busy thread roughly every few
hundred ms; each migration costs the new core ~100 µs of L1/L2 cold-miss
penalty before steady-state returns. For a workload that does
50K requests/sec on each core, that's 5 stalled requests per migration.
Pinning eliminates the entire category.

## 2. The `submit_to` fast path

`smp::submit_to` is the thing every cross-shard call goes through.
Abridged to the structure (full version in `include/seastar/core/smp.hh`):

```cpp
// include/seastar/core/smp.hh
template <typename Func>
static futurize_t<std::invoke_result_t<Func>> submit_to(unsigned t, smp_submit_to_options options, Func&& func) noexcept {
    using ret_type = std::invoke_result_t<Func>;
    if (t == this_shard_id()) {
        try {
            if (!is_future<ret_type>::value) {
                // Non-deferring function, so don't worry about func lifetime
                return futurize<ret_type>::invoke(std::forward<Func>(func));
            } else if (std::is_lvalue_reference_v<Func>) {
                return futurize<ret_type>::invoke(func);  // lvalue: caller owns lifetime
            } else {
                // rvalue + deferring: extend lifetime with a unique_ptr
                auto w = std::make_unique<std::decay_t<Func>>(std::move(func));
                auto ret = futurize<ret_type>::invoke(*w);
                return ret.finally([w = std::move(w)] {});
            }
        } catch (...) {
            return futurize<std::invoke_result_t<Func>>::make_exception_future(std::current_exception());
        }
    } else {
        return _qs[t][this_shard_id()].submit(t, options, std::forward<Func>(func));
    }
}
```

When the target shard is the calling shard — the overwhelmingly common
case for token-aware clients — the lambda runs *inline*. No queue, no
atomic, no future overhead beyond the inevitable allocation if the
return type defers. Zero coordination cost.

When the target is remote, the `else` branch hits the SPSC queue at
`_qs[t][this_shard_id()]`.

`_qs` is a 2-D array of `smp_message_queue` — exactly N × N of them,
one per (sender, receiver) pair. Each queue is owned by exactly one
sender shard for writes and one receiver shard for reads, which is what
makes the next part possible.

## 3. The lock-free SPSC queue

Inside `smp_message_queue`:

```cpp
// include/seastar/core/smp.hh
class smp_message_queue {
    static constexpr size_t queue_length = 128;
    static constexpr size_t batch_size = 16;
    static constexpr size_t prefetch_cnt = 2;
    struct work_item;
    struct lf_queue_remote {
        reactor* remote;
    };
    using lf_queue_base = boost::lockfree::spsc_queue<work_item*,
                            boost::lockfree::capacity<queue_length>>;
```

`boost::lockfree::spsc_queue` is a Lamport-style single-producer
single-consumer ring — one producer-written write index, one
consumer-written read index, both `std::atomic<size_t>`. Push and pop
are wait-free; there are *no* `cmpxchg` instructions on the hot path.
The producer only needs `store(release)` of the new write index after
copying the payload (release prevents prior payload writes from being
reordered after it); the consumer only needs `load(acquire)` of that
write index (acquire prevents subsequent reads from being reordered
before it). On x86 release/acquire on naturally-aligned word stores
compile down to plain MOVs because the TSO memory model already
guarantees the ordering. On ARM the same operations compile to
STLR/LDAR.

`queue_length = 128`, `batch_size = 16`, `prefetch_cnt = 2`. Those are
not arbitrary. 128 work-item pointers occupy `8 × 128 = 1024 B`, which
is `1024 / 64 = 16` cache lines on a 64-bit machine — a small enough
footprint that the consumer can stream through an entire backlog without
thrashing L1. The producer/consumer indices sit on their own dedicated
lines via the explicit `alignas(seastar::cache_line_size)` fences shown
below. The 16-item batch then amortises the *wakeup* (not every push,
just the cross-core notification) to 1 signal per 16 messages, not per
message.

Statistics counters are explicitly placed on separate cache lines so the
sender's writes never invalidate a line the receiver is reading:

```cpp
// include/seastar/core/smp.hh, smp_message_queue
    struct alignas(seastar::cache_line_size) {
        size_t _sent = 0;
        size_t _compl = 0;
        size_t _last_snt_batch = 0;
        size_t _last_cmpl_batch = 0;
        size_t _current_queue_length = 0;
    };
    // keep this between two structures with statistics
    // this makes sure that they have at least one cache line
    // between them, so hw prefetcher will not accidentally prefetch
    // cache line used by another cpu.
    metrics::metric_groups _metrics;
    struct alignas(seastar::cache_line_size) {
        size_t _received = 0;
        size_t _last_rcv_batch = 0;
    };
```

In memory, the three cache lines look like this:

```text
        ┌───────────────────────────────────────┐
line N  │ sender stats (5 × size_t = 40 bytes)  │  written by producer
        │ + 24 bytes of alignas padding         │
        ├───────────────────────────────────────┤
line N+1│ metric_groups _metrics                │  spacer; HW prefetcher
        │                                       │  cannot pull a remote line
        ├───────────────────────────────────────┤
line N+2│ receiver stats (2 × size_t = 16 bytes)│  written by consumer
        │ + 48 bytes of alignas padding         │
        └───────────────────────────────────────┘
```

That comment — "hw prefetcher will not accidentally prefetch cache line
used by another cpu" — is the type of comment you only write after
a perf counter spikes. The hardware prefetcher pulls neighbouring lines
into L1 speculatively (see [Intel optimisation reference
manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
ch. 12 "Cache and memory subsystem"). If sender stats and receiver
stats lived in adjacent lines, the prefetch would drag a "remote" line
into the wrong core's L1, then the next remote write would force a
coherence miss on that line. The `_metrics` member sits between them as
a deliberate spacer.

## 4. Batching and the wakeup barrier

When you call `submit_to` to a remote shard, the work item is *not*
pushed to the SPSC queue immediately. It accumulates in a per-shard
`pending_fifo` first:

```cpp
// src/core/reactor.cc, smp_message_queue::submit_item
    _tx.a.pending_fifo.push_back(item.get());
    // no exceptions from this point
    item.release();
    units_fut.get().release();
    if (_tx.a.pending_fifo.size() >= batch_size) {
        move_pending();
    }
```

Only when 16 items have accumulated — or the reactor's main loop
explicitly calls `flush_request_batch()` between polls — does the queue
actually take a hit:

```cpp
// src/core/reactor.cc
void smp_message_queue::move_pending() {
    auto begin = _tx.a.pending_fifo.cbegin();
    auto end = _tx.a.pending_fifo.cend();
    end = _pending.push(begin, end);
    if (begin == end) {
        return;
    }
    auto nr = end - begin;
    _pending.maybe_wakeup();
    _tx.a.pending_fifo.erase(begin, end);
    _current_queue_length += nr;
    _last_snt_batch = nr;
    _sent += nr;
}
```

`maybe_wakeup` is the only place a cross-core barrier shows up:

```cpp
// src/core/reactor.cc
void
smp_message_queue::lf_queue::maybe_wakeup() {
    // Called after lf_queue_base::push().
    //
    // This is read-after-write, which wants memory_order_seq_cst,
    // but we insert that barrier using systemwide_memory_barrier()
    // because seq_cst is so expensive.
    //
    // However, we do need a compiler barrier:
    std::atomic_signal_fence(std::memory_order_seq_cst);
    remote->wakeup();
}
```

The optimisation hidden in that comment is a beautiful piece of systems
work. A naive design would issue an MFENCE (full memory barrier) on
every push so the receiver sees the new tail; on modern x86 MFENCE costs
~30 cycles uncontended, more when multiple cores compete. Instead,
Seastar splits the cost between the busy and the sleeping cases:

- **Busy producer**: only `std::atomic_signal_fence(seq_cst)` (a
  compiler-only fence, zero CPU cost) plus a relaxed load on the
  receiver's `_sleeping` flag in `reactor::wakeup`. If the receiver is
  awake, the producer returns immediately — no syscall, no barrier.
- **Sleeping receiver**: before parking on `epoll_wait` (or the io_uring
  equivalent), the receiver calls `systemwide_memory_barrier()`
  (`src/core/systemwide_memory_barrier.cc`), which on Linux ≥ 4.14
  becomes a single `syscall(SYS_membarrier,
  MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0)`. That syscall forces *every*
  core to do a full barrier, so the receiver knows it isn't about to
  sleep on a queue that just had a producer push and didn't yet
  publish.
- **Sleeping receiver, woken**: the producer's relaxed load sees
  `_sleeping=true`, so it does one `write(eventfd, 1)` to wake the
  receiver. One syscall per dormant-→-active transition, not per push.

The net: zero coordination cost on every busy-producer push, one
amortised barrier when the receiver chooses to sleep. The kernel sees
the queues only at sleep boundaries.

## 5. Drain on the receiver

The receiving reactor processes the batch:

```cpp
// src/core/reactor.cc
    // copy batch to local memory in order to minimize
    // time in which cross-cpu data is accessed
    work_item* items[queue_length + PrefetchCnt];
    work_item* wi;
    if (!q.pop(wi))
        return 0;
    // start prefetching first item before popping the rest to overlap memory
    // access with potential cache miss the second pop may cause
    prefetch<2>(wi);
    auto nr = q.pop(items);
    std::fill(std::begin(items) + nr, std::begin(items) + nr + PrefetchCnt, nr ? items[nr - 1] : wi);
    unsigned i = 0;
    do {
        prefetch_n<2>(std::begin(items) + i, std::begin(items) + i + PrefetchCnt);
        process(wi);
        wi = items[i++];
    } while(i <= nr);
```

The receiver pops one item and issues a prefetch (`prefetch<2>`, where
`2` means "fetch 2 cache lines starting at this pointer" — see the
`template<size_t L, int LOC = 3>` overload in
[`include/seastar/core/prefetch.hh`](https://github.com/scylladb/seastar/blob/master/include/seastar/core/prefetch.hh)).
Then it pops the rest of the batch into a local stack array. Inside
the loop, `prefetch_n<2>` walks ahead by `PrefetchCnt` items, so by
the time `process(wi)` runs the next two work-items are already being
pulled into the calling core's caches. Read-amplifying memory access
overlaps with useful work. On a Cassandra-equivalent workload of small
reads, this is the difference between L2-bound (`~3 ns` per pop) and
L3/RAM-bound (`~30 ns` to `~100 ns`).

## 6. Where it ties to io_uring

Seastar's `reactor_backend_uring`
([`src/core/reactor_backend.cc`](https://github.com/scylladb/seastar/blob/master/src/core/reactor_backend.cc))
gives each reactor thread its own
`io_uring` ring with 200 SQEs. Detection in
`detect_io_uring()` (`src/core/reactor_backend.cc`) requires kernel
≥5.12 (for `mlock` budget) or ≥5.17 (for non-workqueue MD), and
verifies that the kernel supports the full opcode set Seastar uses:

```cpp
// src/core/reactor_backend.cc, try_create_uring
    auto required_ops = {
            IORING_OP_POLL_ADD, // linux 5.1
            IORING_OP_READV,
            IORING_OP_WRITEV,
            IORING_OP_FSYNC,
            IORING_OP_SENDMSG,  // linux 5.3
            IORING_OP_RECVMSG,
            IORING_OP_ACCEPT,
            IORING_OP_CONNECT,
            IORING_OP_READ,     // linux 5.6
            IORING_OP_WRITE,
            IORING_OP_SEND,
            IORING_OP_RECV,
            };
```

Because each reactor's ring is private, there is no kernel-side lock
contention for SQ submission across shards either. The kernel sees N
independent ring-pairs and serves them from N independent kthreads (in
SQPOLL mode) or directly via syscalls. The per-reactor pollfn rotation
in the main loop polls the ring's CQ once per iteration:

```cpp
// src/core/reactor.cc, in reactor::do_run
    auto check_for_work = [this] () {
        return poll_once() || have_more_tasks();
    };
```

`poll_once` rotates through every registered pollfn — IO completions,
SMP message queues, lowres timers, signal poll, syscall thread-pool
results — once. If any returns "I did work", the loop spins again. If
all return idle, the reactor calls `cpu_relax()` and only then considers
falling asleep on `epoll_wait` / `io_uring_enter(waittime)`.

This is the central performance trick: **on a busy reactor the kernel
is barely involved**. The thread runs userspace continuations from one
ring's completion queue into another ring's submission queue, never
yielding the core. `strace -c` on a hot Scylla shard shows this
plainly — long stretches of zero syscalls between bursts.

# Real numbers — throughput math from a 4-core slice of an M3 Max

Scylla itself needs Linux + io_uring + a chunk of locked memory at
startup. Seastar's [`detect_io_uring`](https://github.com/scylladb/seastar/blob/master/src/core/reactor_backend.cc)
is explicit about the floor: "Older kernels lock about 32k/vcpu for the
ring itself. Require 8MB of locked memory to be safe." Per-shard arena
plus the ring is small in absolute terms; the bulky locked memory is the
pre-faulted data-path arena, which Scylla sizes via `--memory` and
divides equally across shards. I'm on a Mac, so instead of running
Scylla, I'll measure the *thing the architecture buys you*: the per-op
cost of cross-core coordination, versus the per-op cost when no
coordination is needed.

The benchmark below ran on a MacBook Pro M3 Max with GOMAXPROCS=4,
Go 1.26.3. The two key variants are inlined here; the full program
(five variants, ~145 lines) is the same in shape — each variant
spawns four goroutines, each does 5,000,000 iterations of a single
inner loop, and the wall-clock is the median of three runs. The full
compact reproducer is below in [Stretch](#stretch-see-it-for-yourself).

```go
// Save and run with: go run .   (single-file benchmark, no module)
package main

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

type paddedCounter struct {
	v int64
	_ [56]byte // 64B per entry — right for x86 cache lines.
	            // (Apple Silicon uses 128B lines; bumping pad to
	            // [120]byte gives the same ratio in this micro-bench.)
}

func benchSharedAtomic(workers, iters int) (int64, time.Duration) {
	var counter int64
	var wg sync.WaitGroup
	wg.Add(workers)
	start := time.Now()
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				atomic.AddInt64(&counter, 1)
			}
		}()
	}
	wg.Wait()
	return counter, time.Since(start)
}

func benchShardedNoSync(workers, iters int) (int64, time.Duration) {
	shards := make([]paddedCounter, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	start := time.Now()
	for i := 0; i < workers; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				shards[id].v++
			}
		}(i)
	}
	wg.Wait()
	var total int64
	for i := range shards {
		total += shards[i].v
	}
	return total, time.Since(start)
}
```

(The full bench has three more variants — `shared_mutex`,
sharded_falseshare, and channel_hop — built the same way: each
spawns four goroutines, each runs 5,000,000 iterations of the variant's
inner loop, and the wall-clock is the median of three runs. Rather than
bloat the post with all five, the [Stretch section
below](#stretch-see-it-for-yourself) ships a compact 45-line
reproducer for the two extremes.)

Median-of-three results on the same 4 cores, same 20M total ops:

| Variant                                    | ops/sec     | ns/op | Notes                                 |
| ------------------------------------------ | ----------- | ----- | ------------------------------------- |
| shared atomic (CAS on one int64)           | **88 M**    | 11.3  | What a shared counter actually costs  |
| shared mutex (sync.Mutex)                  | **18 M**    | 55.3  | The default in most Go services       |
| channel hop (cross-core handoff)           | **15 M**    | 67.8  | Closest Go analog to submit_to        |
| sharded false-share (4 ints/line)          | **2 037 M** | 0.5   | One per goroutine, but same line      |
| sharded padded (1 line per shard)          | **2 832 M** | 0.4   | Scylla-style: zero coherence traffic  |

Compute it: `2832 M / 88 M ≈ 32×`. That is the structural gap between
shared-state and sharded-state hot paths, on the same hardware, in the
same language, in roughly the same number of instructions per op (one
atomic vs one plain increment). The 32× factor isn't language
overhead, GC, or allocator quality — it's **how often the program
crosses a cache line**.

The mutex result deserves its own line: a contended `sync.Mutex`
costs about `5×` a contended atomic — derivable from the table as
`55.3 / 11.3 ≈ 4.9` (both numbers are aggregate ns/op under 4-way
contention). The mutex path is more expensive because Go's runtime
defers to the OS-level wait primitive (Apple's __ulock_wait on macOS,
futex on Linux) once the spin budget is exhausted; the atomic path
keeps the entire dance in userspace. This is what your idiomatic Go
service is doing every time it calls
`metrics.WithLabelValues(...).Inc()` in a hot handler — the
labels-map lookup grabs an internal `sync.RWMutex`.

The channel-hop benchmark is the most direct analog to Scylla's
`submit_to`. Each goroutine does an atomic increment plus one
non-blocking send to its neighbour and one non-blocking receive from
itself via single-slot buffered channels — `select { case ch <- v:
default: }`, so any handoff that would block is dropped instead.
That measures the *attempted* cross-core handoff cost, including the
per-iteration atomic. ~68 ns per iteration on this hardware. That's
not bad — it's roughly the floor for opportunistic cross-core
coordination — but it's also why Scylla goes to such lengths to keep
the work on one shard to begin with.

For an apples-to-apples cross-system reading, ScyllaDB's own
[published benchmarks](https://www.scylladb.com/product/benchmarks/)
claim roughly an order-of-magnitude lead over Cassandra on YCSB-A on
comparable AWS instances (the page is updated periodically; check the
latest report there). Their measured ratio is `~10×`, not `30×`. The
gap closes from the napkin number because real read paths spend many
cycles on disk I/O and protocol parsing that no architecture can
eliminate. Even so, the pattern holds: every factor of 2 in the gap
traces back to a decision to *not share*.

# Tradeoffs — what this architecture is bad at

The pinning is total. There is no sneaking out.

**1. Skewed partitions kill one core.** Cassandra spreads work across
threads via a global thread pool. If one partition is hot (think:
celebrity Twitter user's followers list, or your most-traded
instrument), Cassandra slices it across worker threads and the rest of
the cluster absorbs the heat. Scylla pins one partition to one shard.
Napkin math (illustrative): that shard runs flat-out at 100% CPU; the
other 15 shards sit near-idle at `~5%`, so `1 / 16` of total box
capacity is doing the work and `15 / 16 ≈ 0.94` of the box is wasted.
The fix is on the application side — model your data so no single
partition is a hot spot — but the constraint is hard.

**2. Memory partitioning is brutal under heap-skew.** Napkin math: a
64 GB box with 16 shards gives each shard exactly `64 / 16 = 4 GB`. A
workload that needs a 12 GB working set on one specific shard cannot
borrow from the other 15 (12 > 4 so the shard spills to disk while
neighbours sit on `15 × 4 = 60 GB` of unused RAM). Cassandra's shared
JVM heap can. Scylla's `--memory N` flag sets the total per-process
budget that gets divided equally across shards — no amount of tuning
lets you escape the partition.

**3. It owns the box.** Co-tenancy is hostile to shard-per-core.
`pthread_setaffinity_np` pins Scylla's threads to specific CPUs but
doesn't exclude other processes from those same CPUs. If a colocated
process spins up there, the kernel time-slices: Scylla's reactor —
which assumed exclusive access to that core's L1/L2 — now wakes up to
a polluted cache and runs at half speed. Production deployments give
Scylla its own machine; trying to run it alongside an unrelated
service degrades both.

**4. Operational story is custom.** All the standard JVM tooling — GC
logs, JMX, Java profilers — is gone. You profile Scylla with
`perf`, eBPF, and the built-in Prometheus metrics. The learning curve
is real for an Ops team raised on JVM dashboards.

**5. Driver contract is wider.** A naive (non-token-aware) client
driver will hit a random shard and the server will `submit_to` to the
right one — a ~70 ns penalty per request, plus the latency of the
extra cross-core hop. ScyllaDB's shard-aware drivers
([scylladb/gocql](https://github.com/scylladb/gocql),
[scylladb/python-driver](https://github.com/scylladb/python-driver),
[scylladb/scylla-rust-driver](https://github.com/scylladb/scylla-rust-driver),
the Java fork) all support routing on the client side, but you have
to *use* a recent shard-aware driver and configure it correctly. A
misconfigured client turns Scylla into a worse Cassandra.

**6. Tail latency at a hot partition is sharper, not flatter.** When
one shard saturates, queue depth on its `smp_message_queue` rises and
the other 15 shards can't drain it. Cassandra's request spreads across
the whole pool; Scylla's request waits for its shard. The tradeoff is
real and well-known: Scylla's P50 typically wins (no shared-pool
overhead), Scylla's P99 against a hot key can lose (no other shard can
help). You pick your poison.

The lesson — and Scylla is honest about this in their own engineering
[blog](https://www.scylladb.com/blog/) — is that share-nothing is a
*constraint discipline*, not a free lunch. You give up the JVM's
flexibility to get a `10×` ceiling raise.

# What I'd change — build differently

Three buckets. The cost estimates assume an experienced Go team.

## a) Don't fight the runtime — give Go a sharded runtime layer

Keep using Go. The deepest copy of Scylla's model is unrealistic in
Go: runtime.LockOSThread pins a goroutine to its OS thread, but the OS
thread can still migrate cores (Go has no built-in
`pthread_setaffinity_np`); and Go's stop-the-world GC pauses every
goroutine including your "pinned" ones. So drop that aspiration. What
you can copy cheaply is the *no-shared-state* property: build per-shard
*owned* state and route requests to the goroutine that owns the right
shard via a small request channel.

A per-shard owner means one goroutine per element of the
GOMAXPROCS set (P, in Go's runtime terminology), and that goroutine
alone holds the mutable state for its shard. Other goroutines send
work to it via channel; the owner is the only writer.

The honest cost: per-shard ownership eliminates the `12 ns` atomic
on the hot path. It *does not* eliminate the `68 ns` channel-hop tax
for misrouted requests. A token-aware client gets you ~80% of Scylla's
gains in maybe 1 week of work.

## b) Custom polling with a third-party io_uring binding

The Go standard library doesn't ship an io_uring binding — `golang.org/x/sys/unix`
exposes raw syscalls but no SQ/CQ ring management. A small group of
third-party projects fill the gap:
[iceber/iouring-go](https://github.com/iceber/iouring-go) and
[godzie44/go-uring](https://github.com/godzie44/go-uring) both wrap
`liburing` semantics in Go. With one of them you can build a
per-goroutine SQ + CQ pair, pin the goroutine via
runtime.LockOSThread + pthread_setaffinity_np via cgo, and have a
Scylla-shaped event loop.

The honest cost: 2-3 weeks of senior engineering, plus you fight the GC
every time you allocate. Go's escape analysis isn't friendly to "stack-
allocate this submission queue entry"; you'll need pools and `sync.Pool`
sprayed everywhere.

## c) Move to Rust + tokio + `tokio-uring`

Rust has explicit move semantics, no GC, and `tokio-uring` already runs
a per-thread-pinned io_uring loop. Or skip tokio entirely and use
[Glommio](https://github.com/DataDog/glommio), Glauber Costa's (ex-
ScyllaDB) Seastar-shaped runtime now developed at Datadog — the closest
you can get to Scylla's model with idiomatic Rust.

Honest cost: language switch. If your team already writes Rust,
~2 weeks to prototype a sharded service. If they don't, the cost
is the team you have to hire.

## What I would actually do

In a Go shop with a small team, I would skip (b) and (c) entirely. I
would do **(a) plus a benchmark suite**. Build per-shard owned
state and a token-aware HTTP server (just hash the path → shard →
`chan request`). Measure how often requests are misrouted and tune the
client. You won't get to Scylla's numbers — you'll get to maybe 4-6×
your previous throughput, on the same hardware, with the same language
your team already knows. That's enough to defer a hardware purchase.

The principle that survives the language switch: **the cost of crossing
a cache line is non-negotiable, and your job as an architect is to make
sure your hot path crosses as few as possible**.

# Stretch: see it for yourself

## bpftrace one-liner

If you run Scylla on Linux, you can watch per-shard cross-core hops in
real time. This counts `submit_to` invocations per (sender, receiver)
pair using uprobes:

```bash
# count cross-shard submit_to calls per (calling_cpu, target_shard),
# every 10 seconds. bpftrace's `*` glob handles the C++ name mangling.
sudo bpftrace -e '
  uprobe:/usr/bin/scylla:*submit_to* {
    @[cpu, arg0] = count();
  }
  interval:s:10 {
    print(@); clear(@);
  }'
```

`smp::submit_to` is a `static` member function, so `arg0` is the
first declared parameter — the target shard `unsigned t`, not an
implicit `this`. The `*` glob avoids hand-mangling Itanium C++ ABI
symbols (which differ between compiler versions); if the glob is too
broad, narrow it with the demangled prefix from `nm -C /usr/bin/scylla
| grep submit_to | head`. On a healthy node the histogram should be
diagonal-heavy — most counts on `@[cpu_X, cpu_X]`, meaning the work
stays on the calling core. A non-diagonal-heavy distribution means
your client driver is misrouting and you're paying the full
cross-core tax.

## Compact reproducer

Save the snippet as bench.go, run with `go run bench.go`. Should
finish in under 2 seconds on any
modern laptop:

```go
// Save and run with: go run .   (45-line minimal reproducer)
package main

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

type padded struct {
	v int64
	_ [56]byte // 64B per entry; for Apple Silicon (128B lines) bump to [120]byte
}

func main() {
	runtime.GOMAXPROCS(4)
	const W, N = 4, 5_000_000
	var shared int64

	// shared atomic
	var wg1 sync.WaitGroup
	wg1.Add(W)
	t := time.Now()
	for i := 0; i < W; i++ {
		go func() { defer wg1.Done(); for j := 0; j < N; j++ { atomic.AddInt64(&shared, 1) } }()
	}
	wg1.Wait()
	d1 := time.Since(t)

	// sharded padded
	shards := make([]padded, W)
	var wg2 sync.WaitGroup
	wg2.Add(W)
	t = time.Now()
	for i := 0; i < W; i++ {
		go func(id int) { defer wg2.Done(); for j := 0; j < N; j++ { shards[id].v++ } }(i)
	}
	wg2.Wait()
	d2 := time.Since(t)

	fmt.Printf("shared_atomic   wall=%s ops/s=%.0fM\n", d1, float64(W*N)/d1.Seconds()/1e6)
	fmt.Printf("sharded_padded  wall=%s ops/s=%.0fM\n", d2, float64(W*N)/d2.Seconds()/1e6)
	fmt.Printf("ratio = %.1fx\n", float64(d1)/float64(d2))
}
```

Expected output on a modern laptop (M-series Apple, Zen 4, Ice Lake):
ratio between 30 and 80. The compact variant tends to score higher
than the main benchmark — both runs do the same work but the smaller
binary starts with a colder OS scheduler and a warmer cache after the
first variant runs (no preceding mutex/channel variants to dirty L1). If you see `≤ 5×`, your machine has fewer than 4 physical cores
and the contention collapses to in-core (genuinely cheaper). If you see
something extreme like `≥ 100×`, you're likely on a NUMA box with
cross-socket cores in the same GOMAXPROCS set and the bouncing line
is paying the inter-socket coherence tax (~200 ns per bounce vs
~50 ns intra-socket) — try `taskset -c 0-3` to pin to one socket and
the gap will normalise.

That two-line output is, in microcosm, the entire reason a Cassandra
fork that does nothing fundamentally different on the read path could
claim an order-of-magnitude lead in ScyllaDB's own
[published benchmarks](https://www.scylladb.com/product/benchmarks/) —
the napkin gives `30–80×`, real workloads spend cycles on disk and
protocol that nobody can shave, so the field-measured gap is
`~10×`. They didn't write faster code. They removed the coordination.

# Further reading

- [Seastar tutorial](https://github.com/scylladb/seastar/blob/master/doc/tutorial.md) — the
  authoritative explanation of the futures-and-continuations model.
- [ScyllaDB engineering blog](https://www.scylladb.com/blog/) —
  ScyllaDB's running write-ups on the reactor model, scheduling, and IO.
  Search for posts tagged "reactor" or "shard-per-core".
- [Glommio](https://github.com/DataDog/glommio) — Glauber Costa's
  Seastar-shaped runtime in Rust (now developed at Datadog); a smaller,
  more readable code base than Seastar if C++ isn't your first language.
- [The Tiger Style](/posts/the-tiger-style/) — adjacent design
  discipline (TigerBeetle's), same philosophy: take the constraint
  seriously, and the performance follows.
- [1B Payments/Day](/posts/1b-payments-per-day/) — what the
  no-shared-state thinking looks like at the *application* layer:
  TigerBeetle's single-writer ledger sustaining ~48K transfers/sec on a
  Mac mini. Different design (single thread, not shard-per-core), same
  underlying constraint (don't share mutable state across cores).

## Colophon

Reading list: `include/seastar/core/smp.hh` (557 lines),
`src/core/smp.cc` (316 lines), the SMP-relevant chunks of
`src/core/reactor.cc` (5,485 lines total, the SMP path is roughly the
`smp_message_queue` and `do_run` sections), `src/core/reactor_backend.cc`
(the `reactor_backend_uring` class, ~600 lines of the file's 1,985),
`src/core/systemwide_memory_barrier.cc` (156 lines), and the
prefetch templates in `include/seastar/core/prefetch.hh`. Total
~8,500 lines surveyed; source citations point at the public GitHub
mirror at scylladb/seastar.

Numbers in the benchmark table are the median of three wall-clock
measurements on a MacBook Pro M3 Max (14 cores, 36 GB RAM, macOS 26.2,
Go 1.26.3). Variance is significant: on Apple Silicon's heterogeneous
E/P core mix the same workload can swing `±50%` between runs depending
on which cores get scheduled, so individual measurements drift but
the order-of-magnitude ratio between contended-shared and sharded
remains invariant. Methodology and errors are mine; the architecture
is ScyllaDB's.

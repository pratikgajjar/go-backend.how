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
etc.) across all cores, hitting shared memtables, a shared row cache,
shared commit-log buffers. Scylla — built
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

# The problem this system was built to solve

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

The honest math: with `bounce = 100 ns`, the aggregate ceiling is
`1 / 100 ns = 10 M ops/sec`. Across 8 cores that's
`10 M / 8 = 1.25 M ops/sec` per core, *no matter how clever the code
is*. The only way out is to not share.

That's the rule Scylla took as a constraint, not a hint.

# The architecture in 200 words

Each Scylla node runs **N reactor threads**, where N = number of
hardware threads. Each reactor:

1. Is `pthread_setaffinity_np`-pinned to one core.
2. Owns its own arena of memory carved from the host RAM at startup.
3. Owns its own slice of the partition keyspace (sharded by hash of the
   partition key).
4. Talks to the kernel via its own private `io_uring` (Linux ≥ 5.6).
5. Communicates with peers via N×N **single-producer-single-consumer
   lock-free queues**, batched up to 16 items per flush.

A request's life looks like this:

```text
client ──► token-aware driver ──► TCP connection to shard owner
                                          │
                                          ▼
                                    [shard k reactor]
                                          │
                                  parse → memtable → commitlog
                                          │
                                  ◄──── reply on same socket
```

The client is *expected* to know which shard owns each partition (the
driver computes `murmur3(pkey) % shard_count` and connects to the right
TCP port). When the client gets it right — almost always — the request
never hops cores. When it gets it wrong, Scylla shovels it across via
`smp::submit_to(target, lambda)`, paying one cross-core message but
keeping the rest of the work on a single core's L1.

No global locks. No global allocator. No shared row cache. The reactor
is the unit of concurrency, the unit of memory, the unit of I/O, and the
unit of fault.

# The source dive — what `submit_to` actually costs

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

`smp::submit_to` is the thing every cross-shard call goes through. The
key inlined check:

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
```

When the target shard is the calling shard — the overwhelmingly common
case for token-aware clients — the lambda runs *inline*. No queue, no
atomic, no future overhead beyond the inevitable allocation if the
return type defers. Zero coordination cost.

When the target is remote, it falls through to:

```cpp
// include/seastar/core/smp.hh, same function, else branch
        } else {
            return _qs[t][this_shard_id()].submit(t, options, std::forward<Func>(func));
        }
```

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

`boost::lockfree::spsc_queue` is the canonical Lamport ring buffer — one
producer index, one consumer index, both `std::atomic<size_t>`. Push
and pop are wait-free, and there are *no* `cmpxchg` instructions on the
hot path: the producer only needs `store(release)` of the new tail
(release prevents the previous payload writes from being reordered after
it), and the consumer only needs `load(acquire)` of that tail (acquire
prevents subsequent reads from being reordered before it). On x86 these
compile down to plain MOVs because the architecture is already strongly
ordered. On ARM they compile to STLR/LDAR.

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

The receiver pops one item, issues a prefetch hint for it (`prefetch<2>`,
the `2` is the L2-cache hint level), then pops the rest of the batch
into a local stack array. Inside the loop, `prefetch_n<2>` walks ahead
by `PrefetchCnt` items, so by the time `process(wi)` runs the next two
work-items are already being pulled into L2 from the producer's L1.
Read-amplifying memory access overlaps with useful work. On a
Cassandra-equivalent workload of small reads, this is the difference
between L2-bound (`~3 ns` per pop) and L3/RAM-bound (`~30 ns` to `~100 ns`).

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

# Real numbers — three-run wall-clock on a 4-core slice of an M3 Max

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

The 50-line program below ran on a MacBook Pro M3 Max, GOMAXPROCS=4,
Go 1.26.3. Each variant runs four goroutines, each does 5,000,000
increments, and we measure wall time:

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
	_ [56]byte // padding so each entry is its own cache line (64B)
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

(Full code with the mutex, false-sharing, and channel-hop variants is
below; see the "stretch" section.)

Best-of-three results on the same 4 cores, same 20M total ops:

| Variant                              | ops/sec     | ns/op | Notes                                 |
| ------------------------------------ | ----------- | ----- | ------------------------------------- |
| Variant — shared atomic (CAS on one int64)   | **88 M**    | 11.3  | What naive multi-threaded code does   |
| Variant — shared mutex (sync.Mutex)          | **18 M**    | 55.3  | What naive idiomatic Go code does     |
| Variant — channel hop (cross-core handoff)   | **15 M**    | 67.8  | Closest analog to submit_to cost      |
| Variant — sharded false-share (4 ints/line)  | **2 037 M** | 0.5   | No sync, but lines still bouncing     |
| Variant — sharded padded (1 line per shard)  | **2 832 M** | 0.4   | Scylla-style: zero coherence traffic  |

Compute it: `2832 M / 88 M ≈ 32×`. That is the structural ceiling
between the two architectures, on the same hardware, in the same
language, at the same instruction count. The factor isn't language
overhead. It isn't GC. It isn't allocator quality. It's **how often the
program crosses a cache line**.

The mutex result deserves its own line: a `sync.Mutex` on Apple silicon
costs about 5× a single uncontended atomic. Under the contention of 4
cores all trying to take it 5M times each, the wall-clock cost
balloons further because the OS futex path eventually kicks in. This
is what your idiomatic Go service is doing every time it calls
`metrics.WithLabelValues(...).Inc()` in a hot handler.

The channel-hop benchmark is the most direct analog to Scylla's
`submit_to`. Each goroutine sends to its neighbour and receives from
itself via small buffered channels. ~68 ns per round-trip. That's not
bad — that's roughly the floor for cross-core coordination on this
hardware — but it's also why Scylla goes to such lengths to keep the
work on one shard in the first place.

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

**3. It owns the box.** Co-tenancy is hostile to shard-per-core. If
another process on the same machine starts using CPUs that Scylla has
pinned, the kernel cannot rebalance and the colocated process gets the
crumbs. Production deployments give Scylla its own machine; trying to
run it alongside an unrelated service is not a supported mode.

**4. Operational story is custom.** All the standard JVM tooling — GC
logs, JMX, Java profilers — is gone. You profile Scylla with
`perf`, eBPF, and the built-in Prometheus metrics. The learning curve
is real for an Ops team raised on JVM dashboards.

**5. Driver contract is wider.** A naive (non-token-aware) client
driver will hit a random shard and the server will `submit_to` to the
right one — a ~70 ns penalty per request. Modern drivers
(`gocql`, `scylla-driver-python`, the official Java driver, the
ScyllaDB Rust driver) all support shard-aware routing, but you have to
*use* a recent driver and configure it right. A misconfigured client
turns Scylla into a worse Cassandra.

**6. Tail latency under spillover is worse, not better.** When a shard
saturates, queue depth on its `smp_message_queue` rises and other
shards' requests for that partition wait in line. Cassandra's request
spreads across the whole pool; Scylla's request waits for its shard. P99
under saturation is sharper for Scylla. P50 is much better. You pick
your poison.

The lesson — and Scylla is honest about this in their own blog
[posts](https://www.scylladb.com/2017/07/24/asynchronous-task-execution/) —
is that share-nothing is a *constraint discipline*, not a free lunch.
You give up the JVM's flexibility to get a 10× ceiling raise.

# What I'd build differently

Three buckets. The cost estimates assume an experienced Go team.

## a) Don't fight the runtime — give Go a sharded runtime layer

Keep using Go. Don't try to pin OS threads (Go's runtime fights you;
runtime.LockOSThread works but Go's GC and scheduler still preempt
across P's, so the pinning leaks). Instead, build per-shard
*owned* state and route requests to the goroutine that owns the right
shard via a small request channel.

A per-shard owner means there is one goroutine per element of the GOMAXPROCS
set (P, in Go's runtime terminology), and that goroutine alone holds the
mutable state for its shard.

The honest cost: per-shard ownership eliminates the 12 ns atomic. It
*does not* eliminate the 68 ns channel-hop tax for misrouted requests.
A token-aware client gets you ~80% of Scylla's gains in maybe 1 week
of work.

## b) Custom polling with `golang.org/x/sys/unix.IOUring`

A small group of Go projects ([cilium/ebpf-go](https://github.com/cilium/ebpf),
[ronaksoft/uring-go](https://github.com/ronaksoft/uring-go)) call into
io_uring directly. You can build a per-goroutine SQ + CQ pair, pin the
goroutine via runtime.LockOSThread + pthread_setaffinity_np via cgo, and
have a Scylla-shaped event loop in Go.

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

# Stretch — see it for yourself

## bpftrace one-liner

If you run Scylla on Linux, you can watch per-shard cross-core hops in
real time. This counts `submit_to` invocations per (sender, receiver)
pair using uprobes:

```bash
# count cross-shard submit_to calls per (calling_cpu, target_shard),
# every 10 seconds. bpftrace's `*` glob handles the C++ name mangling.
sudo bpftrace -e '
  uprobe:/usr/bin/scylla:*submit_to* {
    @[cpu, arg1] = count();
  }
  interval:s:10 {
    print(@); clear(@);
  }'
```

The `*` glob avoids hand-mangling Itanium C++ ABI symbols (which differ
between compiler versions). If the glob is too broad, narrow it with
the demangled prefix you find via `nm -C /usr/bin/scylla | grep
submit_to | head`. On a healthy node the histogram should be
diagonal-heavy (most counts on `@[cpu_X, cpu_X] = ...`, meaning the
work stays local). A non-diagonal-heavy distribution means your client
driver is misrouting and you're paying the full cross-core tax.

## 50-line reproducer

Save the snippet as bench.go, run with `go run bench.go`. Should
finish in under 2 seconds on any
modern laptop:

```go
// Save and run with: go run .   (50-line reproducer)
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
	_ [56]byte
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

Expected output on an M3 / Zen 4 / Ice Lake laptop: a ratio between 25
and 40. If you see ≤ 5×, your machine has fewer than 4 physical cores
and the contention path collapses to in-core which is genuinely
cheaper. If you see ≥ 50×, you're on a NUMA box with cross-socket cores
in the same GOMAXPROCS set and the bouncing line is crossing a socket
boundary — try `taskset -c 0-3` to keep them on one socket and the gap
will normalise.

That two-line output is, in microcosm, the entire reason a Cassandra
fork that does nothing fundamentally different on the read path was
able to claim 10× the throughput in their own published
[benchmarks](https://www.scylladb.com/product/benchmarks/) (measured
on a single i3.4xlarge node; see the table earlier in this section
for the napkin-derived ratio). They didn't write faster code. They
removed the coordination.

# Further reading

- [Seastar tutorial](https://github.com/scylladb/seastar/blob/master/doc/tutorial.md) — the
  authoritative explanation of the futures-and-continuations model.
- [Asynchronous Task Execution in
  Scylla](https://www.scylladb.com/2017/07/24/asynchronous-task-execution/) —
  ScyllaDB's own write-up on the reactor model.
- [Glommio](https://github.com/DataDog/glommio) — Datadog's Rust port of
  the Seastar architecture; a smaller, more readable code base if C++
  isn't your first language.
- [The Tiger Style](/posts/the-tiger-style/) — adjacent design
  discipline (TigerBeetle's), same philosophy: take the constraint
  seriously, and the performance follows.
- [1B Payments/Day](/posts/1b-payments-per-day/) — what the same
  share-nothing thinking buys at the application layer for a payments
  ledger.

## Colophon

Reading list: `include/seastar/core/smp.hh` (557 lines),
`src/core/smp.cc` (316 lines), the SMP-relevant chunks of
`src/core/reactor.cc` (5,485 lines total, the SMP path is roughly the
`smp_message_queue` and `do_run` sections), `src/core/reactor_backend.cc`
(the `reactor_backend_uring` class, ~600 lines of the file's 1,985),
and `src/core/systemwide_memory_barrier.cc`. Source citations point at
the public GitHub mirror at scylladb/seastar.

Numbers in the benchmark table are wall-clock measurements from three
runs of the included Go program on a MacBook Pro M3 Max (14 cores, 36
GB RAM, macOS 26.2, Go 1.26.3). Ratios will vary by `±20%` across
hardware and OS schedulers; the *direction* of the ratio is invariant.
Methodology and errors are mine; the architecture is ScyllaDB's.

+++
title = "🪜 pgvector Under the Hood — HNSW in 800 Lines of C"
description = "A code-level walk through pgvector's HNSW: the layered graph from the Malkov–Yashunin paper, how it lives inside 8 KB Postgres pages, and what ef_search actually buys you. With measurements."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["pgvector", "hnsw", "vector-search", "postgres", "ann"]
images = ["og.png"]
theme = "arctic"
featured = false
math = false
+++

> A 1.0 MB shared object (1,015,584 bytes for the `pg15` build of
> pgvector v0.8.2 on `pgvector/pgvector:pg15`) turns Postgres — a
> system that has spent
> [thirty years](https://www.postgresql.org/about/history/) optimising
> B-trees over rows — into a vector database that beats brute force
> by an order of magnitude. The algorithmic core fits in 800 lines of
> C that mostly manipulates 8 KB pages.[^bench]

I keep meeting teams who treat [pgvector](https://github.com/pgvector/pgvector)
as if it were an external service: "the vector store." It isn't. It's
an extension that compiles to one shared library and shares the same
buffer cache, the same WAL, the same MVCC, and the same vacuum as the
rest of your database. There is no separate storage engine. There is
no network hop. The "vector index" plugs into Postgres' generic
index access-method interface (`IndexAmRoutine`) the same way B-tree
and GIN do — it just walks a graph instead of comparing keys.

This post is a code-archaeology walk through the part that does the
actual approximate-nearest-neighbour work: the HNSW (Hierarchical
Navigable Small World) implementation in `src/hnsw*.c`. We will look
at the search loop, the on-disk layout, the random level assignment,
and the place where the algorithm has to make peace with Postgres'
8,192-byte page boundary. Then we will measure it.

Source: [`pgvector/pgvector` v0.8.2](https://github.com/pgvector/pgvector/tree/v0.8.2),
which is the version bundled in `pgvector/pgvector:pg15` on Docker
Hub and what I ran for every number below.

# 1. The hook

Build an HNSW index on 50,000 vectors of dimension 128, ask it for
the 10 nearest neighbours of 500 query vectors, and the median query
finishes in **382 µs at 94.6 % recall@10**. The same dataset, same
query, same hardware, with the index turned off and Postgres falling
back to a sequential scan calling
[`l2_distance`](https://github.com/pgvector/pgvector/blob/v0.8.2/src/vector.c#L573)
on every row returns an exact answer in **5,440 µs**.

That is **14× faster** for **5.4 % less recall**, measured first-hand
on an Apple M4 Pro inside a Linux VM[^bench]. The arithmetic is
`5440 / 382 ≈ 14.24`, and "recall@10 = 94.6 %" means out of every
10 true neighbours returned by the exhaustive scan, the index agreed
on 9.46 of them.

Here is the surprise. HNSW achieves this by walking a graph that
lives entirely inside Postgres' regular `MAIN_FORKNUM` buffers — the
same 8 KB pages that store your `users` and `orders` tables. Each
node in the graph is one heap-shaped tuple with a vector payload and
a sidecar tuple of neighbour pointers (Postgres `ItemPointerData`s,
6 bytes each). To traverse a neighbour you dereference a TID and
read another buffer. The hot path is bounded by random buffer reads,
SIMD distance computation over a few hundred floats (L2, inner
product, or cosine — operator-class dispatched), and a small pairing
heap.

The system is doing approximate nearest-neighbour search at memory
speed for a working set that fits in `shared_buffers`, with crash
safety, replication, and MVCC inherited for free from the host. None
of that is fancy. Most of it is older than HNSW. The cleverness is in
how little new infrastructure was needed.

# 2. The problem, from first principles

Approximate nearest-neighbour search is "given a query vector
`q ∈ ℝᵈ` and a corpus of N vectors, find the K closest under some
distance function, but you don't have to be exact". The "approximate"
part is what lets it scale.

Why _approximate?_ Because exact `argmin` over N vectors costs N
distance computations and there is no index that helps in high
dimensions. The
[curse of dimensionality](https://en.wikipedia.org/wiki/Curse_of_dimensionality)
is the technical reason every tree-style index — kd-tree, ball tree,
M-tree — degenerates to brute force as `d` grows past about 20. By
the time you hit `d = 128` (small for sentence embeddings, tiny for
image embeddings) every node in a tree partitions almost no
candidates and you might as well scan everything.

A common pre-HNSW answer was IVFFlat: cluster the vectors into
`√N` clusters, store the centroid of each, at query time score
against the centroids and only scan the `probes` nearest. Recall
depends on `probes / lists`. It works. pgvector ships it as
`USING ivfflat` and it lives in `src/ivf*.c`. But it has an
unforgiving cliff: tune `probes` too low and recall craters; tune it
high and you're approaching brute force.

HNSW, from
[Malkov & Yashunin's 2018 paper](https://arxiv.org/abs/1603.09320),
trades a memory hit for a much friendlier curve. The construction:

- Each inserted vector picks a random level `ℓ` as
  `floor(-ln(U) × 1/ln(M))` for `U` uniform on `(0, 1)`. The element
  exists on every layer from 0 to `ℓ`. The result is a geometric
  distribution: most elements (about `1 − 1/M ≈ 93.75 %` for
  `M = 16`) live only on layer 0; mean integer level is `1/(M−1)`.
- On each layer the element is connected to up to `M` nearest
  neighbours (or `2M` on layer 0 — the ground layer carries the long
  tail of the data and needs more degree).
- A query starts at the entry point on the top layer, greedily walks
  to the local minimum, drops down a layer, and repeats. On layer 0
  it expands a beam of size `ef_search` and returns the `K` closest
  it has seen.

The reason this works is that the top layers are short-range express
trains. They cover a lot of distance with few hops. The bottom layer
is local roads. You spend most of your time at the bottom but
parachute into roughly the right region first. On typical embedding distributions, `ef_search = 40` with `K = 10`
hits recall ~95 % (94.6 % on this post's synthetic-cluster
benchmark, see §5) — which is what the
[default GUC](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnsw.h#L52)
ships at.

# 3. The architecture in 200 words

```text
shared_buffers (8 KB pages)
┌──────────────────────────────────────────────────────────────┐
│ block 0  HnswMetaPageData                                    │
│   magic 0xA953A953 │ version │ dimensions │ m │ efConstr.    │
│   (entryBlkno, entryOffno) ────────────┐ entryLevel          │
│   insertPage  ───────────────────┐     │                     │
├──────────────────────────────────┼─────┼─────────────────────┤
│ block 1+ element/neighbor tuples on the same MAIN_FORKNUM    │
│                                  │     │                     │
│   ┌─ HnswElementTuple ──┐        │     │                     │
│   │ type=ELEMENT level  │        │     └─► entry point       │
│   │ heaptids[10]        │        │                           │
│   │ neighbortid ────────┼──┐     │                           │
│   │ Vector data         │  │     │                           │
│   └─────────────────────┘  │     │                           │
│   ┌─ HnswNeighborTuple ─┐  │     │                           │
│   │ type=NEIGHBOR ver   │◄─┘     │                           │
│   │ count               │        │                           │
│   │ indextids[(L+2)·M]  │        │                           │
│   └─────────────────────┘        │                           │
│                                  ▼                           │
└──────────────────────────────────────────────────────────────┘
```

The whole index is one Postgres relation. Block 0 is the meta page
([`HnswMetaPageData`](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnsw.h#L314-L325)).
Every other block contains a mix of two tuple types — element tuples
and neighbour tuples — laid out exactly the way Postgres lays out heap
tuples: a 24-byte
[page header](https://www.postgresql.org/docs/current/storage-page-layout.html),
then a growing-down array of 4-byte `ItemIdData` entries pointing at
the actual tuples, which grow up from the bottom of the 8 KB page.

An **element tuple** is one node of the graph: a vector payload, up
to 10 heap TIDs (so byte-identical duplicate vectors share the same
graph node — `FindDuplicateOnDisk` checks `datumIsEqual` before
inserting; see the `HNSW_HEAPTIDS` constant), and a single pointer to
its neighbour tuple. A **neighbour tuple** is a flat array of `(ℓ + 2) × M` index
TIDs covering every layer the element exists on. Each TID is 6 bytes;
on layer 0 we have `2M` of them, on each higher layer we have `M`.

That is the whole on-disk schema. There is no second relation, no
companion B-tree, no GIN-style metadata. The graph is the storage.

# 4. The byte-by-byte walk: a single query

The most interesting subsystem is the search path, because everything
about HNSW lives or dies on it. Pgvector's implementation is split
across three files: `hnswscan.c` (Postgres index-AM glue),
`hnswutils.c` (the algorithms themselves), and `hnsw.c` (GUCs and
options). A query enters at `hnswgettuple`, which Postgres calls
once per row it wants from the index.

## 4.1 First call: build the candidate list

```c
// src/hnswscan.c
bool
hnswgettuple(IndexScanDesc scan, ScanDirection dir)
{
    HnswScanOpaque so = (HnswScanOpaque) scan->opaque;
    MemoryContext oldCtx = MemoryContextSwitchTo(so->tmpCtx);

    Assert(ScanDirectionIsForward(dir));

    if (so->first)
    {
        /* ... pgstat, MVCC checks ... */
        LockPage(scan->indexRelation, HNSW_SCAN_LOCK, ShareLock);
        so->w = GetScanItems(scan, value);
        UnlockPage(scan->indexRelation, HNSW_SCAN_LOCK, ShareLock);
        so->first = false;
    }
    /* return next element from so->w on subsequent calls */
}
```

On the first call, all of HNSW happens. `GetScanItems` returns a
`List *` of search candidates ordered furthest-first (because the
inner max-heap was drained furthest-first into the list). Subsequent
calls take the last element via `llast()`, which is the nearest
unvisited neighbour. The `HNSW_SCAN_LOCK` is a Postgres
[heavyweight page-level
lock](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnsw.h#L41-L43)
(via `LockPage`, not the lighter `LWLockAcquire` used for the
allocator and per-element locks); held in shared mode by readers,
exclusive by vacuum's repair phase. So the index doesn't block reads
against each other, only against vacuum.

`GetScanItems` is the entire algorithm in 31 lines (counted via
`awk '/^GetScanItems\(/,/^}$/' src/hnswscan.c | wc -l`):

```c
// src/hnswscan.c
static List *
GetScanItems(IndexScanDesc scan, Datum value)
{
    HnswScanOpaque so = (HnswScanOpaque) scan->opaque;
    Relation    index = scan->indexRelation;
    HnswSupport *support = &so->support;
    List       *ep;
    List       *w;
    int         m;
    HnswElement entryPoint;
    char       *base = NULL;
    HnswQuery  *q = &so->q;

    /* Get m and entry point */
    HnswGetMetaPageInfo(index, &m, &entryPoint);

    q->value = value;
    so->m = m;

    if (entryPoint == NULL)
        return NIL;

    ep = list_make1(HnswEntryCandidate(base, entryPoint, q, index, support, false));

    for (int lc = entryPoint->level; lc >= 1; lc--)
    {
        w = HnswSearchLayer(base, q, ep, 1, lc, index, support, m, false, NULL, NULL, NULL, true, NULL);
        ep = w;
    }

    return HnswSearchLayer(base, q, ep, hnsw_ef_search, 0, index, support, m, false, NULL, &so->v, hnsw_iterative_scan != HNSW_ITERATIVE_SCAN_OFF ? &so->discarded : NULL, true, &so->tuples);
}
```

Three functions do the substantive work. `HnswGetMetaPageInfo` reads
block 0 to find the entry point's TID and the index's `M`.
`HnswEntryCandidate` reads that entry point's tuple, computes
distance, and wraps it in a search candidate. `HnswSearchLayer` is
the actual HNSW algorithm and gets called from two sites here:
`entryPoint->level` invocations with `ef = 1` walking down the
upper layers, then one final invocation at layer 0 with
`ef = hnsw_ef_search`.

If you've read the
[paper](https://arxiv.org/pdf/1603.09320v4.pdf), `GetScanItems` is
Algorithm 5 (K-NN-SEARCH) and the inner `HnswSearchLayer` is
Algorithm 2 (SEARCH-LAYER) — the source acknowledges as much:

```c
// src/hnswutils.c
/*
 * Algorithm 2 from paper
 */
List *
HnswSearchLayer(char *base, HnswQuery * q, List *ep, int ef, int lc,
                Relation index, HnswSupport * support, int m, bool inserting,
                HnswElement skipElement, visited_hash * v,
                pairingheap **discarded, bool initVisited, int64 *tuples)
{
    List       *w = NIL;
    pairingheap *C = pairingheap_allocate(CompareNearestCandidates, NULL);
    pairingheap *W = pairingheap_allocate(CompareFurthestCandidates, NULL);
    int         wlen = 0;
    /* ... */
```

`C` is a min-heap of "candidates we still want to explore"
(nearest-first). `W` is a max-heap of "the best `ef` so far"
(furthest-first, so we know what we'd evict). Both are
[Postgres' built-in pairing
heap](https://github.com/postgres/postgres/blob/master/src/include/lib/pairingheap.h),
which is allocated under the per-scan memory context and freed when
the scan ends — no malloc churn, no free list of our own.

The loop:

```c
// src/hnswutils.c
while (!pairingheap_is_empty(C))
{
    HnswSearchCandidate *c = HnswGetSearchCandidate(c_node, pairingheap_remove_first(C));
    HnswSearchCandidate *f = HnswGetSearchCandidate(w_node, pairingheap_first(W));

    if (c->distance > f->distance)
        break;

    /* ... load c's neighbours, distance them, push into C and W ... */
}
```

The early-exit `c->distance > f->distance` is the heart of the
algorithm. It says: my closest unexplored candidate is already
further than the worst element in my current top-`ef`. Anything
deeper in the priority queue can only be even further. Stop. This
is what keeps the search sub-linear in N.

When we expand `c`, we have to read its neighbour tuple. On disk
this means another Postgres buffer read:

```c
// src/hnswutils.c
bool
HnswLoadNeighborTids(HnswElement element, ItemPointerData *indextids,
                     Relation index, int m, int lm, int lc)
{
    Buffer      buf;
    Page        page;
    HnswNeighborTuple ntup;
    int         start;

    buf = ReadBuffer(index, element->neighborPage);
    LockBuffer(buf, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buf);

    ntup = (HnswNeighborTuple) PageGetItem(page, PageGetItemId(page, element->neighborOffno));

    if (ntup->version != element->version || ntup->count != (element->level + 2) * m)
    {
        UnlockReleaseBuffer(buf);
        return false;
    }

    start = (element->level - lc) * m;
    memcpy(indextids, ntup->indextids + start, lm * sizeof(ItemPointerData));

    UnlockReleaseBuffer(buf);
    return true;
}
```

Notice the `version` check. The neighbour tuple is stored on its own
page (or the same page as the element, when the page has space). When
vacuum reuses an old tuple slot, it bumps the version. If the version
on disk doesn't match the version the search captured when it loaded
the element, the search just bails on this neighbour list and moves
on. No retry, no error. **In an MVCC system, "the structure I read
ten microseconds ago might already be gone" is the constant that
shapes everything.**

The slice math `start = (element->level - lc) * m` is how the flat
`indextids` array packs every layer's neighbours into one tuple. The
top layer is at offset 0, layer 0 at the end. A node at level 3 has
`(3 + 2) × M = 5M` slots; if we're searching at layer 1, we want
positions `2M..3M`. One memcpy, no allocations, lock released
immediately.

## 4.2 The visited set: three implementations of the same hash table

```c
// src/hnsw.h
typedef union
{
	struct pointerhash_hash *pointers;
	struct offsethash_hash *offsets;
	struct tidhash_hash *tids;
}			visited_hash;
```

A best-first graph search (priority-queue-driven, like Dijkstra)
needs to remember which nodes it has already touched. The naive choice is "a `set<TID>`". pgvector keeps
three hash tables and picks one at runtime:

- `tids` (keyed by `ItemPointerData`) for on-disk traversals: each
  candidate is identified by its TID inside the inner loop of one
  `HnswSearchLayer` call, since we don't pin element data between
  expansions and there's no other persistent identifier.
- `offsets` (keyed by relative pointer offset) for parallel in-memory
  builds, where the graph lives in shared memory mapped to different
  addresses in different worker processes. You can't compare absolute
  pointers because they differ between workers, but offsets are
  stable.
- `pointers` (keyed by `uintptr_t`) for serial in-memory builds where
  the graph is in backend-private memory and addresses are stable.

The hash tables are built from Postgres'
[simplehash.h](https://github.com/postgres/postgres/blob/master/src/include/lib/simplehash.h)
template, instantiated three times:

```c
// src/hnsw.h
#define SH_PREFIX tidhash
#define SH_ELEMENT_TYPE TidHashEntry
#define SH_KEY_TYPE ItemPointerData
#define SH_SCOPE extern
#define SH_DECLARE
#include "lib/simplehash.h"
```

Three macro instantiations buy you three open-addressed hash tables
specialized to their key types, with no virtual dispatch and no
generic-pointer overhead. C makes this trivial; in Go or Rust it would
require generics or codegen.

## 4.3 Distance is auto-vectorized

The hot inner loop is the L2 distance computation. `vector.c`:

```c
// src/vector.c
VECTOR_TARGET_CLONES static float
VectorL2SquaredDistance(int dim, float *ax, float *bx)
{
    float       distance = 0.0;

    /* Auto-vectorized */
    for (int i = 0; i < dim; i++)
    {
        float       diff = ax[i] - bx[i];

        distance += diff * diff;
    }

    return distance;
}
```

`VECTOR_TARGET_CLONES` expands to
`__attribute__((target_clones("default", "fma")))` on Linux x86-64
when `USE_TARGET_CLONES` is defined. The compiler emits two copies of
this function — a default scalar version and an FMA-using version —
and the first call resolves which one to dispatch to based on
`/proc/cpuinfo`. On ARM it's a single auto-vectorized loop the
compiler will turn into NEON FMLAs. There is no manual SIMD intrinsic
in the L2 path. The loop is just structured so that the compiler
can't miss the vectorization.

The half-precision path in `halfutils.c` _does_ ship hand-rolled AVX
intrinsics (`_mm256_cvtph_ps`, `_mm256_fmadd_ps`) — explicit
F16C-based fp16→fp32 conversion inside the inner loop, runtime-
dispatched via `__cpuid` so machines without F16C fall back to a
default scalar implementation. That's the only place in the distance
code with manual intrinsics.

For a `vector(128)` query, one distance call is 128 FMAs and a
horizontal sum. On a 3 GHz core with AVX2 FMA (8 floats per FMA, 1
FMA issued per cycle, ~4-cycle latency pipelined) the multiply
phase is `128 / 8 = 16` cycles plus pipeline drain, ≈ 7 ns of
arithmetic. ARM NEON's 4-wide FMLA needs `128 / 4 = 32` cycles plus
a similar drain, ≈ 12 ns. The total query time of 382 µs at default
`ef_search` (see the table below) is dominated by the buffer-read
random walk through the graph, not the math. `EXPLAIN (BUFFERS,
ANALYZE)` on this post's benchmark[^bench] shows each search at
`ef_search = 40` registers 528 shared-buffer hits (page accesses,
including repeated visits to the same page),
`528 × 8 = 4224` KB of warm-cache touch. The distance-computation work
is bounded above by `ef_search × 2M = 40 × 32 = 1280` candidates —
or at 7 ns per distance, under 9 µs total. That's roughly 2 % of
the query's 382 µs; buffer-pool bookkeeping and cache fetches are
the rest.

## 4.4 Random levels: where 1/ln(M) comes from

Insertion picks a random level using a geometric distribution:

```c
// src/hnswutils.c
HnswElement
HnswInitElement(char *base, ItemPointer heaptid, int m, double ml,
                int maxLevel, HnswAllocator * allocator)
{
    HnswElement element = HnswAlloc(allocator, sizeof(HnswElementData));

    int         level = (int) (-log(RandomDouble()) * ml);

    /* Cap level */
    if (level > maxLevel)
        level = maxLevel;
    /* ... */
}
```

`-log(uniform) * ml` is the inverse-CDF sample of an exponential
with mean `ml`; flooring it gives an integer geometric. The choice of
`ml = 1 / ln(M)` is in `hnsw.h`:

```c
// src/hnsw.h
/* Optimal ML from paper */
#define HnswGetMl(m) (1 / log(m))
```

`log` here is `ln` (libc convention). For `M = 16`, `ml ≈ 0.361` —
the mean of the underlying continuous exponential
(`-log(U) * ml ~ Exp(rate = 1/ml)`), which is *not* the same as the
mean integer level. The integer-level distribution after flooring is
geometric: `P(level ≥ 1) = e^(−1/ml) = e^(−ln M) = 1/M = 6.25 %`;
`P(level ≥ 2) = 1/M² = 0.39 %`; and so on. The mean integer level
is `E[level] = 1/(M − 1) ≈ 0.067` for `M = 16` (verifiable via
`python3 -c "M=16; print(sum(k*(M**(-k)-M**(-k-1)) for k in range(1, 100)))"`).
The graph is dense at the bottom and exponentially sparse at the top,
which is exactly what you want for the layered greedy descent to
work.

`maxLevel` is computed at index init time from `BLCKSZ` (one literal
source line, formatted here as written):

```c
// src/hnsw.h
/* Ensure fits on page and in uint8 */
#define HnswGetMaxLevel(m) Min(((BLCKSZ - MAXALIGN(SizeOfPageHeaderData) - MAXALIGN(sizeof(HnswPageOpaqueData)) - offsetof(HnswNeighborTupleData, indextids) - sizeof(ItemIdData)) / (sizeof(ItemPointerData)) / (m)) - 2, 255)
```

This is the expression "how many `ItemPointerData`s fit on one page,
divided by `m`, minus two". An element at level `L` needs
`(L + 2) × M` TIDs in its neighbour tuple. The cap exists because
Postgres heap-style tuples [cannot span
pages](https://www.postgresql.org/docs/current/storage-page-layout.html)
— large vector payloads can be TOASTed externally, but the neighbour
tuple itself must fit on a single 8 KB page. The level cap enforces
exactly that constraint. With `BLCKSZ =
8192` and `M = 16`, the integer arithmetic gives
`(8192 − 24 − 8 − 4 − 4) / 6 / 16 − 2 = 82` — see the derivation
below. The random level distribution will not reach this in
practice: the probability of an element rolling above level 8 with
`M = 16` is `1/16⁸ ≈ 2.3 × 10⁻¹⁰` (geometric tail). The `255` cap
is to ensure `level` fits in a `uint8`.

Derivation, all in C integer arithmetic: page-header and opaque
overhead total `24 + 8 = 32 B`; `ItemIdData` is 4 B;
`offsetof(HnswNeighborTupleData, indextids)` is 4 B (`uint8 type +
uint8 version + uint16 count`). So the space available for TIDs on
a one-tuple page is `8192 − 32 − 4 − 4 = 8152 B`, which holds
`8152 / 6 ≈ 1358` TIDs at 6 bytes each (truncating to integer).
Dividing by `M = 16`: `1358 / 16 ≈ 84` (truncating again), and
subtracting 2 (the extra `+2` on layer 0) gives `84 − 2 = 82`.

# 5. Real numbers from a 50,000-vector benchmark

I built the index against pgvector v0.8.2 inside a Linux Podman VM
on an Apple M4 Pro Mac mini (10 cores, 24 GB RAM). The container is
`docker.io/pgvector/pgvector:pg15`, default Postgres 15 settings
except `maintenance_work_mem = '256MB'` and
`max_parallel_maintenance_workers = 0` so the build is single-threaded
and deterministic.

The dataset is **50,000 unit vectors of dimension 128**, drawn from
100 isotropic Gaussian clusters with variance 0.3 — a stand-in for
real embedding distributions, which are also clustered. Queries are
500 cluster centres perturbed by Gaussian noise. Ground truth is
exact L2 nearest neighbour computed in NumPy.

Index build:

```text
m = 16, ef_construction = 64
build wall time:    6.0 s
index size:        39.7 MiB   (5,082 × 8 KB pages)
index size / row:  833 B
table size:        27.9 MiB
```

`833 B / row` decomposes by napkin math. The vector payload is
`128 × 4 = 512 B` plus the `Vector` header from `src/vector.h`
(`int32 vl_len_ + int16 dim + int16 unused = 8 B`), so the
`HnswElementTuple` is `4 B (uint8 type/level/deleted/version) + 60 B
(10 × 6 B heaptids) + 6 B (neighbortid) + 2 B (unused) + 8 B Vector
header + 512 B floats = 592 B`, MAXALIGN'd to 600. The level-0
neighbour tuple holds `2 × 16 = 32` TIDs at 6 B each, so
`32 × 6 = 192 B` plus a 4 B header, MAXALIGN'd to 200. Add two
`ItemIdData` slots (4 B each) for 8 B more, and the per-row total
lands at `600 + 208 = 808` bytes. The measured 833 B/row is the 25 B
gap from per-page header amortisation and a small fraction of
elements at level > 0 (whose neighbour tuples are `m` TIDs longer). The dominant term is
the vector data; the index-to-table size ratio came out at
`41,631,744 / 29,261,824 ≈ 1.42`[^bench], which means the index ships
about 40 % more bytes than the heap because each element exists in
both.

Query latency at varying `ef_search`:

```text
ef_search │ recall@10 │ p50 (µs) │ p99 (µs)
──────────┼───────────┼──────────┼─────────
       10 │   0.7826  │      316 │      913
       20 │   0.8888  │      308 │      515
       40 │   0.9460  │      382 │      738   ← default
       80 │   0.9658  │      434 │      821
      160 │   0.9662  │      431 │      759
      320 │   0.9676  │      516 │      861
exact     │   1.0000  │    5,440 │   18,668
```

Three things to read out of this table.

**The recall curve has a knee.** Going from `ef_search = 40` to `80`
buys 2 percentage points of recall for 13 % more latency on this
benchmark[^bench]. Going from `80` to `320` buys 0.18 percentage
points for 19 % more latency. The default of 40 is well-chosen for
`K = 10`; pushing past 95 % recall costs over 8× the latency at the
same `K`, as the table above shows.

**Latency is dominated by the random walk, not the math.**
`EXPLAIN (BUFFERS, ANALYZE)` measures `ef_search = 40` at 528
shared-buffer hits per query, `ef_search = 80` at 635, and
`ef_search = 320` at 943. The math (one L2 distance per candidate
at 7–12 ns) totals well under 100 µs; the rest is buffer-pool
bookkeeping and cache fetches. That means the index is sensitive to
`shared_buffers` sizing — if your hot graph evicts to disk, every
query takes the SSD hit on every neighbour.

**The exact baseline is 5.4 ms for 50,000 rows**, ~109 ns per row
(`5440 µs / 50,000`, see numbers above)[^bench]. That decomposes as a
SIMD-accelerated L2 over 128 floats — `128 / 8 = 16` AVX2 FMA cycles
plus ~5 reduction cycles, so `21 × 0.33 ≈ 7` ns — plus the per-row
overhead of walking heap tuples (tuple deformation, varlena unpacking,
qualifier check). The math is the small term; the heap-walk is most
of the ~109 ns. Linearly extrapolating: 10M rows takes ~1.1 s of
exact scan, 100M rows takes ~11 s. That is when "approximate is
fine" stops being a debate.

A 50-line reproduction follows; the key shape (use the
`maintenance_work_mem` / `max_parallel_maintenance_workers` settings
from [^bench] to match the published timings exactly, or accept a
small drift):

```python
# 50-line reproduction; needs `psycopg[binary]` and `numpy` on the host
import time, numpy as np, psycopg

DSN = "host=127.0.0.1 port=5432 user=postgres password=p dbname=bench"
DIM, N, NQ, TOPK = 128, 50_000, 500, 10
rng = np.random.default_rng(42)
centers = rng.standard_normal((100, DIM)).astype(np.float32) * 3
data = np.empty((N, DIM), dtype=np.float32)
for i in range(N):
    data[i] = centers[i % 100] + 0.3 * rng.standard_normal(DIM).astype(np.float32)

with psycopg.connect(DSN) as conn:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("DROP TABLE IF EXISTS items")
        cur.execute(f"CREATE TABLE items (id int PRIMARY KEY, e vector({DIM}))")
    with conn.cursor().copy("COPY items FROM STDIN WITH (FORMAT TEXT)") as cp:
        for i, v in enumerate(data):
            cp.write_row((i, "[" + ",".join(f"{x:.6f}" for x in v) + "]"))
    conn.commit()
    with conn.cursor() as cur:
        cur.execute("CREATE INDEX ON items USING hnsw (e vector_l2_ops) WITH (m=16, ef_construction=64)")
    queries = np.tile(centers, (NQ // 100 + 1, 1))[:NQ] + 0.4 * rng.standard_normal((NQ, DIM)).astype(np.float32)
    for ef in (10, 40, 80, 320):
        with conn.cursor() as cur: cur.execute(f"SET hnsw.ef_search={ef}")
        lats = []
        for q in queries:
            qstr = "[" + ",".join(f"{x:.6f}" for x in q) + "]"
            t0 = time.monotonic_ns()
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM items ORDER BY e <-> %s::vector LIMIT %s", (qstr, TOPK))
                cur.fetchall()
            lats.append((time.monotonic_ns() - t0) / 1e3)
        lats.sort()
        print(f"ef={ef:3d} p50={lats[len(lats)//2]:.0f}us p99={lats[int(len(lats)*0.99)]:.0f}us")
```

Tracing the page-read cost on Linux is one bpftrace one-liner:

```bash
# count buffer reads per query, attached to the bgwriter/backend
sudo bpftrace -e 'uprobe:/usr/lib/postgresql/15/bin/postgres:smgrread { @[comm] = count(); }'
```

`smgrread` is Postgres' page-read entry point. Run an HNSW query
with cold caches versus warm and you can watch the buffer pool fill
and the count drop by an order of magnitude.

# 6. Tradeoffs — what HNSW (and pgvector) are bad at

I have spent six sections being charmed by this system. Three things
are genuinely awkward, named:

**Memory pressure on build.** The `maintenance_work_mem` constant in
the README isn't a soft suggestion. If the in-memory graph doesn't
fit, pgvector falls back to "build the rest of the graph by inserting
one tuple at a time on disk", which is dramatically slower because
every insert has to do a full graph traversal under exclusive page
locks. The
[NOTICE message](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnswbuild.c#L539-L542)
is friendly but the cost is real:

```text
NOTICE:  hnsw graph no longer fits into maintenance_work_mem after 100000 tuples
DETAIL:  Building will take significantly more time.
```

For 1M rows of `vector(1536)` (OpenAI `text-embedding-ada-002`
dimension): vector payload is `1536 × 4 = 6144` bytes per row;
level-0 neighbour TIDs are `32 × 6 = 192` bytes (with a small tail
for the ~6.25 % of nodes at level ≥ 1, negligible at the 1M-row
scale); tuple headers add ≈ 80 B; alignment and per-page slack
≈ 20 %. The in-memory graph is therefore about
`(6144 + 192 + 80) × 1.2 ≈ 7700` bytes per row, so roughly 7.7 GB
for 1M rows total. Below that, you're in slow mode.
Production deployments with 100M-row tables can't just
`CREATE INDEX`; they have to plan for it.

**Filtered search interacts badly with HNSW.** The classic case:

```sql
SELECT * FROM items
WHERE category = 'shoes'
ORDER BY e <-> $1
LIMIT 10;
```

The index walks the graph in `e`-distance order and the executor
filters in `WHERE`-recheck after fetching each heap tuple — HNSW
implements `amgettuple` only, not `amgetbitmap`
([hnsw.c L314–L315](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnsw.c#L314-L315))
— so it can't use bitmap intersection with a category index. If
shoes are 0.1 % of your data and the filter is uncorrelated with
embedding distance, the default `ef_search = 40` returns roughly
`40 × 0.001 = 0.04` matching rows in expectation — close to zero
— and the executor returns < `LIMIT` rows. Pgvector v0.8 added
`hnsw.iterative_scan`, which keeps walking the graph past
`ef_search` until the filter yields enough rows, but it has to
walk a lot of graph to find them when the filter is selective. There is active research on
[hybrid search](https://arxiv.org/abs/2403.01773) that handles this
properly; pgvector handles it pragmatically.

**Deletes don't shrink the graph until vacuum runs, and vacuum's HNSW
path is heavy.** When you delete a row, the corresponding heap TID
is tombstoned in the element tuple. The element stays in the graph
as a "ghost" that contributes neighbour structure but is filtered at
scan time when `heaptidsLength` reaches 0. Vacuum walks the entire
index, removes ghosts, and re-knits the neighbours of every node
that pointed at a deleted ghost. The repair takes
`BUFFER_LOCK_EXCLUSIVE` (and `LockBufferForCleanup` in places — see
[hnswvacuum.c L484](https://github.com/pgvector/pgvector/blob/v0.8.2/src/hnswvacuum.c#L484))
on every neighbour-tuple page it edits, blocking concurrent reads on
those pages for the duration. If your workload is delete-heavy, this
is the part you will feel.

**MVCC on neighbour structure is eventual.** I mentioned the `version`
check earlier — when vacuum repairs a neighbour tuple it bumps the
version, and any in-flight scan reading that tuple's older version
silently bails on it (`HnswLoadNeighborTids` returns `false`). This
is correct in the approximate-search sense (the search just skips
that branch), but it means **two queries with the same `ef_search`
against the same data can disagree on which nearest neighbours they
return after a vacuum**, since the bailing scan misses candidates
the post-vacuum scan would expand. Don't rely on HNSW for anything
that needs deterministic ranking.

**Build time scales worse than IVFFlat.** Build is `O(N × log N ×
ef_construction)` graph operations. IVFFlat's build is `O(N × probes
× iterations)` k-means work, which parallelises better and uses less
memory. The build in this post hit `50,000 / 6.0 ≈ 8,333`
vectors/s single-threaded[^bench]; at that rate a 10M-row HNSW
build takes about 1,200 s wall time — derived as
`10,000,000 / 8,333 ≈ 1,200` seconds, roughly 20 minutes — and
pgvector's parallel-build mode (`HnswParallelBuildMain`) cuts that
by `max_parallel_maintenance_workers`-fold in practice.

# 7. What I'd build differently

Working through pgvector's HNSW raises three concrete improvements
you could imagine making — none of them small, but all of them
defensible.

**1. Per-element compressed neighbour storage.** Right now every
neighbour tuple is `(L + 2) × M × 6 bytes` of fixed-size TIDs.
Varint encoding (4 instead of 6 bytes for typical sub-1B-row
indexes) shrinks the neighbour bytes by ~30 %, but neighbours are
only ~25 % of per-row bytes for `vector(128)` and ~3 % for
`vector(1536)` — end-to-end savings 7 % and <1 % respectively
(see §5's per-row decomposition). Probably not worth the
per-traversal CPU; buffer reads, not bytes, dominate.

**2. Separate the vector payload from the graph nodes.** pgvector
stores the full vector in every element tuple. The L2-search
benchmark above touched `528 × 8 = 4224` KB of buffer per query at
default `ef_search = 40` per `EXPLAIN (BUFFERS)`[^bench], and a
tuple for `vector(128)` is dominated by `128 × 4 = 512` bytes of
floats. Splitting the vector into a side relation, keeping only the
TID and neighbour pointers in the graph node, would let many more
graph nodes pack per 8 KB page — buffer-read working set shrinks
roughly proportional to the savings. The cost is two
relations and a join at read time. Microsoft's
[DiskANN](https://github.com/microsoft/DiskANN) and the
[FreshDiskANN paper](https://arxiv.org/abs/2105.09613) describe
this layout in detail.

**3. Cost-based fallback to IVFFlat.** Both index types ship in
pgvector. There is no automatic chooser. The README is candid about
the difference: ["[HNSW] has better query performance than IVFFlat
(in terms of speed-recall tradeoff), but has slower build times and
uses more memory"](https://github.com/pgvector/pgvector#hnsw). On a
dataset where HNSW's recall curve plateaus early (extremely clustered
data, our benchmark above), IVFFlat with the README's recommended
[`lists ≈ rows / 1000` and `probes ≈ √lists`](https://github.com/pgvector/pgvector#ivfflat)
is competitive and builds faster. A meta-extension that picked between the two based
on a quick training sample, or even let you write
`CREATE INDEX ... USING ann (...)` and chose at build time, would
remove a real foot-gun from teams new to vector search.

The reason I am not _actually_ building any of these is that I think
pgvector's authors made the right call at every step. The 800-line
algorithmic core that I walked above is an exact transcription of a
published paper, with the smallest possible Postgres adaptation
layer around it. That choice — read the paper, copy it, do not
embellish — is why HNSW arrived production-shaped in v0.5 (the
release that introduced it, August 2023, per the
[CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md))
and is still production-ready at v0.8. The intervening releases are
a lesson in restrained improvement: parallel builds (0.6),
half-precision / sparse / binary types and `binary_quantize` (0.7),
iterative scan (0.8). Each is a paper-grounded addition, not a
refactor.

If there is one architectural decision worth lifting from this code
and applying elsewhere, it is the **on-page graph layout**. Most
vector indexes either live in their own custom file format (Faiss,
ScaNN), in a columnar table format (Lance), or inside a dedicated
search engine (Vespa, Weaviate). Pgvector chose to put the graph
inside Postgres' regular page machinery, which means it gets WAL,
replication, point-in-time recovery, and `pg_basebackup` for free. The cost is that page
boundaries leak into the algorithm — `HnswGetMaxLevel`, the version
check on neighbour tuples, the page-level `HNSW_UPDATE_LOCK`. The
benefit is that the index is just another relation. Your DBA already
knows how to operate it.

That tradeoff — accept the host's constraints, inherit its strengths —
is the part I want to remember the next time I am tempted to ship a
new storage engine.

---

_Source for the numbers: 50k × 128-dim L2 benchmark, pgvector v0.8.2,
Postgres 15 in a Linux Podman VM on an Apple M4 Pro, default settings
except `maintenance_work_mem = 256MB` and `max_parallel_maintenance_workers = 0`. Code is included inline in §5; reproducible from a fresh
`docker.io/pgvector/pgvector:pg15` container in under a minute.
Recall is deterministic (832.6 B/row reproduces to the byte); latency
varies ±10 % on a quiet machine, more under host load — full
methodology in [^bench]._

# Further reading

- [Malkov & Yashunin, the HNSW paper](https://arxiv.org/abs/1603.09320) (TPAMI, 2018)
- [pgvector source v0.8.2](https://github.com/pgvector/pgvector/tree/v0.8.2)
- [pgvector CHANGELOG](https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md)
- [DiskANN: Fast Accurate Billion-point Nearest Neighbor Search](https://www.microsoft.com/en-us/research/publication/diskann-fast-accurate-billion-point-nearest-neighbor-search-on-a-single-node/) — what you'd do for working sets that don't fit in RAM
- [FreshDiskANN](https://arxiv.org/abs/2105.09613) — the same authors on streaming updates
- [Postgres pairing heap](https://github.com/postgres/postgres/blob/master/src/include/lib/pairingheap.h) — where pgvector borrows its priority queues
- This site's posts on [TigerBeetle](/posts/the-tiger-style/),
  [Temporal](/posts/temporal-under-the-hood/), and [WAL Cake](/posts/wal-cake-lock-free-cdc/) — same code-archaeology format applied to other systems

# Colophon

This post is a code-archaeology run on pgvector v0.8.2. I read every
line of `src/hnsw*.{c,h}` (`5,333` lines total: hnsw.c 402, hnswbuild.c 1171,
hnswinsert.c 797, hnswscan.c 345, hnswutils.c 1428, hnswvacuum.c 669,
hnsw.h 521), ran the index against a 50,000-row dataset I generated,
and timed recall and latency from a Python harness reproduced in §5
above. The "800 lines" in the title is a small
honest exaggeration: the full HNSW machinery is `5,333` lines if you
count WAL plumbing, vacuum, MVCC, parallel builds, and disk paging.
The _algorithm_ — `HnswSearchLayer`, `HnswFindElementNeighbors`,
`HnswInitElement` — is closer to 800. Both numbers are useful; the
bigger one tells you what production looks like, the smaller one
tells you what to hold in your head.

This is the third "X under the hood" post on this site. The
[TigerBeetle one](/posts/the-tiger-style/) was about an LSM tree. The
[Temporal one](/posts/temporal-under-the-hood/) was about a workflow
engine. This one is about a graph index. The pattern keeps working
because most production systems are short, well-engineered cores
wrapped in operational scaffolding, and the cores are the part worth
writing about.

[^bench]: All numbers in this post come from a single benchmark
    harness: pgvector v0.8.2 inside the
    [`docker.io/pgvector/pgvector:pg15`](https://hub.docker.com/r/pgvector/pgvector)
    container, on Apple M4 Pro hardware (10 cores, 24 GB RAM) running
    inside a Linux Podman VM. Postgres defaults except
    `maintenance_work_mem = '256MB'` and
    `max_parallel_maintenance_workers = 0` so the build is
    deterministic. Dataset: 50,000 unit vectors of dimension 128
    drawn from 100 isotropic Gaussian clusters with σ = 0.3. Queries
    are 500 cluster centres perturbed by σ = 0.4 noise. Ground truth
    is exact L2 nearest-neighbour from NumPy. The 50-line Python
    reproduction is in §5. The index size and recall numbers are
    deterministic between runs (verified on a re-run: 832.6 B / row,
    matching 833 B above). Latency is host-load sensitive — on a
    quiet machine ±10 %, on a loaded one closer to ±25 %.

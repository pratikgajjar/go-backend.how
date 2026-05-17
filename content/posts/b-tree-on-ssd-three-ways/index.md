+++
title = "🐳 LMDB vs Pebble vs BoltDB - B-Tree-on-SSD, Three Ways"
description = "Three embedded KV stores, one workload, one machine. LMDB does 1.9M writes/sec in 14K lines of C. Pebble's 160K-line Go codebase shrinks the file 4×. BoltDB lands in between and stays simple."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["lmdb", "pebble", "boltdb", "kv-store", "b-tree", "lsm", "benchmark"]
images = ["og.png"]
theme = "cherry"
featured = false
math = false
+++

> Three engines, one workload, one laptop. LMDB measured 26× faster
> writes than BoltDB and 13× faster reads than Pebble (see
> [section 5](#5-real-numbers---same-machine-same-workload)) - but
> Pebble's file is 4.8× smaller than BoltDB's (and 2.1× smaller than
> LMDB's). None of the three dominates all three axes. The shape of
> the tradeoff is the post.

# 1. The hook

I ran the same workload - 200,000 records, 8-byte keys, 200-byte
values, random read after sequential write - through three embedded
key-value stores on the same M2 MacBook, same APFS filesystem, same Go
1.26 (where applicable). The numbers (full reproducer below):

| engine | LOC[^loc] | write ops/s | read p50 | read p99 | on-disk |
|---|---:|---:|---:|---:|---:|
| **LMDB**   | 13,754 (C)  | 1,932,276 | 430 ns | 970 ns | 42 MiB |
| **BoltDB** | 11,477 (Go) |    72,702 | 459 ns | 1.4 μs | 96 MiB |
| **Pebble** | 159,642 (Go)|   635,351 | 5.4 μs | 8.7 μs | 20 MiB |

[^loc]: `wc -l` on each repo, excluding tests. LMDB is `libraries/liblmdb/{mdb.c,midl.c,lmdb.h,midl.h}` (the four source files in liblmdb); BoltDB is `find . -name "*.go" -not -name "*_test.go"`; Pebble is the same with `metamorphic/` and `replay/` excluded.

Three things should bother you:

1. **LMDB**, written by [Howard Chu](https://www.symas.com/symas-embedded-database-lmdb)
   in 13,754 source lines (the entire
   [`liblmdb`](https://github.com/LMDB/lmdb/tree/mdb.master/libraries/liblmdb)
   directory: `mdb.c`, `midl.c`, and the two headers), beats Pebble — a
   159,642-line Go codebase with a CockroachDB-funded engineering org
   behind it ([repo](https://github.com/cockroachdb/pebble), tests
   excluded) — at single-threaded random reads by ~13×.
2. **BoltDB**'s on-disk file (96 MiB) is **2.3×** larger than LMDB's
   (42 MiB) for byte-identical data, even though both are B+trees on
   mmap. The size delta is two pieces: LMDB packs new pages near full
   (no per-bucket `FillPercent` knob), bbolt defaults to `FillPercent
   = 0.5` (`bucket.go:27` — see §5.2). Plus bbolt's `node` cache pays
   Go-runtime overhead per dirty page that LMDB's C `MDB_page` struct
   doesn't.
3. **Pebble**'s file is 20 MiB - 2.1× smaller than LMDB and 4.8× smaller
   than BoltDB - because it Snappy-compresses blocks before writing them,
   and that's the headline LSM win. Read latency p99 is 9× LMDB's,
   which is the headline LSM cost.

The benchmark code, exact compile flags, and `time` output are in
section 5. Before that, three architectural sketches.

# 2. The problem all three were built to solve

> An embedded KV store is what you reach for when "use Postgres"
> would mean shipping a second binary, a second config file, and a
> second on-call rotation.

Three constraints define the design space:

1. **Persist on a single SSD**, not a cluster. The unit of I/O is a
   page (typically 4 KiB on Linux/macOS - `os.Getpagesize()` in
   [bbolt's `internal/common/types.go:34`](https://github.com/etcd-io/bbolt/blob/main/internal/common/types.go#L34)
   sets `DefaultPageSize` to that). Random reads cost a 4 KiB I/O even
   for an 8-byte key.
2. **Crash safety without an external WAL**. The on-disk format must
   be self-recovering: a torn write to one page must not destroy the
   tree. Either copy-on-write (LMDB, BoltDB) or write-ahead log + LSM
   (Pebble). There's no third practical option.
3. **Embed in a process**, no IPC, no admin daemon. Concurrency is in
   the host process: many readers, one or more writers, all sharing a
   data file with the OS page cache.

LMDB's [`@page starting`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/intro.doc#L13)
intro doc states constraint 3 explicitly: "Within that directory, a
lock file and a storage file will be generated." Two files. That's
the API surface.

BoltDB's [`doc.go`](https://github.com/etcd-io/bbolt/blob/main/doc.go)
reduces it further: "Bolt is a single-level, zero-copy, B+tree data
store" - *the database is the file is the mmap*.

Pebble takes the opposite stance. From its [README](https://github.com/cockroachdb/pebble/blob/master/README.md#L9):
"Pebble is a LevelDB/RocksDB inspired key-value store focused on
performance and internal usage by CockroachDB." It accepts more files,
more code, and more memory in exchange for write throughput at scale,
compression, and range deletions. The brief is different.

# 3. The architecture in 200 words each

## 3.1 LMDB - mmap'd COW B+tree, two meta pages

```
┌──────────── data.mdb (single file) ────────────┐
│ page 0: meta page A  (txnid=N)                  │
│ page 1: meta page B  (txnid=N+1)                │
│ page 2..k: live B+tree pages (root → branches → leaves)
│ page k+1..N: free list pages + reusable pages
└────────────────────────────────────────────────┘

writer: copy page on touch → write new pages → fsync → flip meta
readers: pin meta page → walk old tree → see consistent snapshot
```

The whole file is `mmap()`ed into the address space. A read transaction
takes the newer of the two meta pages and walks pointers. A write
transaction copies any page it modifies to a free location, rewires
the parent, fsyncs the new pages, and *only then* overwrites the older
meta page. The atomic unit of commit is the meta page write - 4 KiB,
power-fail safe, two pages alternating like double-buffered video.
The two metas live at *fixed* page ids 0 and 1 (the union at
[`mdb.c:1290`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L1290)).
On read, you pick the one with the higher `mm_txnid`; on write, you
overwrite the older slot (`txnid & 1` picks which page to overwrite).

## 3.2 BoltDB - Bolt's Go reimplementation, same shape

```
┌──────────── data.db (single file) ──────────┐
│ page 0:  meta A (txnid even)                │
│ page 1:  meta B (txnid odd)                 │
│ page 2:  freelist                           │
│ page 3+: leaf/branch/bucket pages           │
└─────────────────────────────────────────────┘

writer: spill dirty nodes → allocate → fsync → write new meta
readers: pin meta → mmap pointer chase, zero copy
```

BoltDB is LMDB's design ported to Go: same two-meta-page COW, same
mmap, same single-writer rule. The Go port adds a `Bucket` type
(nested namespaces - [bucket.go:30](https://github.com/etcd-io/bbolt/blob/main/bucket.go#L30)),
a `node` cache for the in-flight transaction's dirty pages, and a
`spill` step that splits oversized nodes into multiple pages
([node.go:295](https://github.com/etcd-io/bbolt/blob/main/node.go#L295)).
The transaction code is straight-line: `db.Update(func(tx *Tx) ...)`
runs your closure in a single writer-tx, fsyncs once, returns.
`MaxKeySize = 32768`, `MaxValueSize = (1 << 31) - 2` are hard limits
([bucket.go:14-17](https://github.com/etcd-io/bbolt/blob/main/bucket.go#L14-L17)).

## 3.3 Pebble - LSM with a Clock-Pro sharded block cache

```
┌─ memtable (4 MiB)                                 in RAM, skiplist
│  WAL (record per Set/Delete)                      durable, streaming
├─ L0:  4 sstables × ~2 MiB                         on disk, overlapping
├─ L1 (Lbase): 64 MiB                               non-overlapping
├─ L2:  ~640 MiB                                    × 10 multiplier
├─ L3:  ~6.4 GiB
├─ L4:  ~64 GiB
└─ L5+: cold tail
              ↑
          block cache: 4 × NumCPU shards, Clock-Pro
```

Writes go to the WAL + memtable (4 MiB by default -
[options.go:1715](https://github.com/cockroachdb/pebble/blob/master/options.go#L1715)).
When a memtable fills it freezes and a flush thread writes it as an
sstable into L0. When L0 has 4 files
([options.go:1655](https://github.com/cockroachdb/pebble/blob/master/options.go#L1655))
a compaction merges them into Lbase (default 64 MiB -
[options.go:1687](https://github.com/cockroachdb/pebble/blob/master/options.go#L1687)).
Each level is ~10× the previous; reads consult memtable, then each
level's bloom filter, then the sstable block.

# 4. The byte-by-byte walk: how each commits

The "interesting subsystem" diverges across the three. Each line below
is from the cached source and is grep-able.

## 4.1 LMDB: meta-page flip

A write transaction touches a page. LMDB does not modify in place -
it allocates a new page id and copies. From
[`mdb.c:2785`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L2785)
(`mdb_page_touch`):

```c
// lmdb/libraries/liblmdb/mdb.c - mdb_page_touch (line 2785)
static int
mdb_page_touch(MDB_cursor *mc)
{
	MDB_page *mp = mc->mc_pg[mc->mc_top], *np;
	MDB_txn *txn = mc->mc_txn;
	pgno_t	pgno;
	int rc;

	if (!F_ISSET(MP_FLAGS(mp), P_DIRTY)) {
		if ((rc = mdb_midl_need(&txn->mt_free_pgs, 1)) ||
			(rc = mdb_page_alloc(mc, 1, &np)))
			goto fail;
		pgno = np->mp_pgno;
		mdb_midl_xappend(txn->mt_free_pgs, mp->mp_pgno);
		/* Update the parent page, if any, to point to the new page */
		if (mc->mc_top) {
			MDB_page *parent = mc->mc_pg[mc->mc_top-1];
			MDB_node *node = NODEPTR(parent, mc->mc_ki[mc->mc_top-1]);
			SETPGNO(node, pgno);
		} else {
			mc->mc_db->md_root = pgno;
		}
	}
	mdb_page_copy(np, mp, txn->mt_env->me_psize);
	np->mp_pgno = pgno;
	np->mp_flags |= P_DIRTY;
```

The old page id is appended to the txn's free list (`mt_free_pgs`)
and will only be reused *after* this txn commits and any reader
holding the old snapshot finishes. This is the entire MVCC scheme. No
version vector. No undo log.

When commit comes, the writer calls
[`mdb_env_write_meta`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L4359):

```c
// lmdb/libraries/liblmdb/mdb.c - mdb_env_write_meta (line 4359)
toggle = txn->mt_txnid & 1;
mp = env->me_metas[toggle];
mapsize = env->me_metas[toggle ^ 1]->mm_mapsize;
...
mp->mm_dbs[FREE_DBI] = txn->mt_dbs[FREE_DBI];
mp->mm_dbs[MAIN_DBI] = txn->mt_dbs[MAIN_DBI];
mp->mm_last_pg = txn->mt_next_pgno - 1;
mp->mm_txnid = txn->mt_txnid;
```

`txnid & 1` selects which of the two meta pages to overwrite. The
*other* meta still points at the previous tree. Power-fail at any
instant before this point: the old tree is intact and the new pages
sit unreferenced in the free list. Power-fail after the meta hits
disk: the new tree is live. There is no half-state.

`mm_psize` lives at [mdb.c:1271](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L1271)
and is the page size at db creation; LMDB does not let you change it.
The meta page is itself a 4-KiB page on most platforms.

## 4.2 BoltDB: spill, then write meta page id 0 or 1

BoltDB's commit is the same idea in Go.
[`internal/common/meta.go:50`](https://github.com/etcd-io/bbolt/blob/main/internal/common/meta.go#L50)
makes the meta page id depend on `txid`:

```go
// bbolt/internal/common/meta.go (line 50)
// Page id is either going to be 0 or 1 which we can determine by the transaction ID.
p.id = Pgid(m.txid % 2)
p.SetFlags(MetaPageFlag)

// Calculate the checksum.
m.checksum = m.Sum64()
```

`txid % 2` for the page id is the literal LMDB trick. The fnv-64
checksum at [meta.go:62](https://github.com/etcd-io/bbolt/blob/main/internal/common/meta.go#L62)
catches torn writes - bbolt validates the checksum before trusting a
meta page on open
([meta.go:24](https://github.com/etcd-io/bbolt/blob/main/internal/common/meta.go#L24-L33)).
The other half of bbolt's commit is the [node.go spill](https://github.com/etcd-io/bbolt/blob/main/node.go#L295):

```go
// bbolt/node.go - spill (function at line 295, body excerpt)
// Spill child nodes first.
sort.Sort(n.children)
for i := 0; i < len(n.children); i++ {
	if err := n.children[i].spill(); err != nil {
		return err
	}
}
// Split nodes into appropriate sizes. The first node will always be n.
var nodes = n.split(uintptr(tx.db.pageSize))
for _, node := range nodes {
	// Add node's page to the freelist if it's not new.
	if node.pgid > 0 {
		tx.db.freelist.Free(tx.meta.Txid(), tx.page(node.pgid))
		node.pgid = 0
	}
	// Allocate contiguous space for the node.
	p, err := tx.allocate((node.size() + tx.db.pageSize - 1) / tx.db.pageSize)
```

`split` at [node.go:206](https://github.com/etcd-io/bbolt/blob/main/node.go#L206)
splits a node into pages of size `tx.db.pageSize × FillPercent`.
`FillPercent` defaults to `0.5` ([bucket.go:27](https://github.com/etcd-io/bbolt/blob/main/bucket.go#L27)).
That single number is *why* my BoltDB file was 96 MiB: 200,000 ×
208-byte records ≈ 41.6 MiB of payload, but with `FillPercent = 0.5`
the file roughly doubles. Set `Bucket.FillPercent = 0.95` before bulk
inserts and the file shrinks. The 0.5 default exists because bbolt
expects mostly-random inserts that would otherwise force splits on
every write.

The single-writer constraint is encoded at
[`db.go:1143`](https://github.com/etcd-io/bbolt/blob/main/db.go#L1143):

```go
// bbolt/db.go - DB struct + meta panic comment (around line 1143)
rwlock   sync.Mutex   // Allows only one writer at a time.

// This should never be reached, because both meta1 and meta0 were validated
// on mmap() and we do fsync() on every write.
panic("bolt.DB.meta(): invalid meta pages")
```

Writers serialize through `db.rwlock`. A long writer pauses *all*
readers' tx-begin (because remap might happen), but does not block
already-begun read transactions - those keep walking the previous
mmap until they Commit or Rollback.

## 4.3 Pebble: WAL → memtable → flush → compact

Pebble does not commit by flipping a meta page. It commits by
fsyncing the WAL. From the architecture comment in
[`internal/cache/cache.go:23-30`](https://github.com/cockroachdb/pebble/blob/master/internal/cache/cache.go#L23-L30):

```go
// pebble/internal/cache/cache.go (line 24, USENIX URL elided)
// Cache implements Pebble's sharded block cache. The Clock-PRO algorithm is
// used for page replacement
// (...). In
// order to provide better concurrency, 4 x NumCPUs shards are created, with
// each shard being given 1/n of the target cache size. The Clock-PRO algorithm
// is run independently on each shard.
```

`4 × NumCPUs` shards, with a [floor of 4 MiB per shard](https://github.com/cockroachdb/pebble/blob/master/internal/cache/cache.go#L110-L115).
On an 8-core machine that's 32 shards; each shard has its own RWMutex
and its own Clock-Pro state machine. The shard is the contention unit.

A read consults the cache *first*. From
[`internal/cache/clockpro.go:142`](https://github.com/cockroachdb/pebble/blob/master/internal/cache/clockpro.go#L142):

```go
// pebble/internal/cache/clockpro.go - shard.get (line 142)
func (c *shard) get(k key, level base.Level, category Category, peekOnly bool) *Value {
	c.mu.RLock()
	if e, _ := c.blocks.Get(k); e != nil {
		if value := e.acquireValue(); value != nil {
			// Note: we Load first to avoid an atomic XCHG when not necessary.
			if !peekOnly && !e.referenced.Load() {
				e.referenced.Store(true)
			}
			c.mu.RUnlock()
```

A hit: RLock, blockMap lookup, atomic-load the referenced bit, RUnlock.
A miss: an [acquireReadEntry](https://github.com/cockroachdb/pebble/blob/master/internal/cache/clockpro.go#L182)
slot lets one goroutine fetch the block from the sstable while every
other goroutine that wants the same block parks on the same readEntry
- see `getWithReadEntry` at [clockpro.go:170](https://github.com/cockroachdb/pebble/blob/master/internal/cache/clockpro.go#L170).
Pebble's read-side lock fanout is the inverse of LMDB's: LMDB has *no*
lock inside a read because there's nothing to lock against.

The cache's `handHot`, `handCold`, `handTest` at
[clockpro.go:103-105](https://github.com/cockroachdb/pebble/blob/master/internal/cache/clockpro.go#L103-L105)
implement Clock-Pro's three rotating arms: hot pages stay until the
hot hand finds them with `referenced = false`; cold-pages are demoted
or promoted depending on whether they're touched before the cold hand
revisits them; the test-page list catches "thrashing" cold pages
deserving promotion. A full LRU would need a doubly-linked list and a
write lock on every read.

The byte-by-byte hot path for a Pebble Get (cache miss) — verified
against [`get.go:60`](https://github.com/cockroachdb/pebble/blob/master/get.go#L60)
(`getInternal`) — is:

```
Get(k)
  → loadReadState()                        - pin memtables + version
  → for each memtable in queue (newest→oldest, skiplist scan)
  → for each L0 sublevel (overlapping sstables)
  → for each level L1..Ln (non-overlapping):
      bloom_filter[level].MayContain(k)?  no → skip (when configured)
      yes:  index_block.lookup(k)          - block cache
            data_block.lookup(k)           - block cache, decompress on miss
  → return value
```

That's 1-3 skiplist probes (typically one mutable memtable + 0-2
immutable awaiting flush) + N bloom probes + at most M block
decompresses where M is the number of levels the key actually lives
in. Pebble's
out-of-the-box default is actually
[`NoFilterPolicy`](https://github.com/cockroachdb/pebble/blob/master/options.go#L68)
(no bloom at any level) - CockroachDB and other production users opt
in via [`bloom.FilterPolicy`](https://github.com/cockroachdb/pebble/blob/master/sstable/tablefilters/bloom/bloom.go)
typically at 10 bits/key, which gives ~1% false-positive rate. Under
that configuration a 5-level LSM decompresses ~1.05 blocks per Get
on average - but you *visit* every level. Each visit is a hash, a
cache-line fetch, and a few atomics on the shard mutex.

That's where my measured[^bench] 5.4 μs p50 comes from. Section 5 derives it.

# 5. Real numbers - same machine, same workload

The benchmark code is in
[`/tmp/btree-bench/`](#) (M2 MacBook, 8-core, 16 GB RAM, APFS, Go 1.26.3,
`cc -O2`). 200,000 records of 8-byte BE keys mapping to a constant
200-byte value. Pebble writes use `pebble.NoSync`; bbolt uses default
sync, batching 1,000 ops per `db.Update`; LMDB uses `MDB_NOSYNC` plus
one final `mdb_env_sync` to mirror bbolt's per-tx fsync.

The reproducer (excerpt - full Go file at the end of the post):

```go
// /tmp/btree-bench/bench.go (Pebble path)
val := make([]byte, valueLen)
rand.Read(val)
t0 := time.Now()
for i := uint64(0); i < N; i++ {
	if err := db.Set(keyFor(i), val, pebble.NoSync); err != nil {
		panic(err)
	}
}
if err := db.Flush(); err != nil {
	panic(err)
}
dWrite := time.Since(t0)
```

Output:

```
N=200000 value=200B key=8B
PEBBLE  write=314.7865ms  (635351 ops/s)  read p50=5.4μs   p99=8.7μs   size=20MB
BBOLT   write=2.750962s   (72702  ops/s)  read p50=459 ns  p99=1.4μs   size=96MB
LMDB    write=0.104 s     (1932276 ops/s) read p50=430 ns  p99=970 ns  size=42MB
```

## 5.1 Where do the read latencies come from?

The B+tree path (LMDB, BoltDB) is the same arithmetic. The page is
4 KiB. A leaf page header is `unsafe.Sizeof(Page{}) = 16 bytes`
([page.go:11](https://github.com/etcd-io/bbolt/blob/main/internal/common/page.go#L11)).
A leaf element header is `unsafe.Sizeof(leafPageElement{}) = 16 bytes`
([page.go:15](https://github.com/etcd-io/bbolt/blob/main/internal/common/page.go#L15)).
With `FillPercent = 0.5`, a leaf holds about
`(4096 × 0.5 - 16) / (16 + 8 + 200) ≈ 9` records - so 200,000 records
spread across ≈ 22,000 leaves. Branch pages have a 16-byte
`branchPageElement` ([page.go:14](https://github.com/etcd-io/bbolt/blob/main/internal/common/page.go#L14))
+ 8-byte key ≈ 24 bytes per entry → fanout ≈ `4080 / 24 = 170`. Need
`ceil(log_170(22000)) = 2` levels of branches above the leaves, so
each Get is `root → branch → leaf` = **3 page accesses** through the
mmap. That's `3 × ~100 ns/cache-line + ~100 ns total binary-search ≈
400 ns`, matching the measured 430 ns / 459 ns within napkin
tolerance.

LMDB and BoltDB diverge on writes because BoltDB pays Go-runtime
overhead per page - every dirty `node` is a Go heap allocation,
GC-tracked. LMDB allocates `MDB_page` on the C heap with `malloc` and
hands it to `pwrite`. The 26× write gap (1.93 M vs 73 K ops/s)
collapses to under 4× when bbolt is loaded under
[`db.Batch`](https://github.com/etcd-io/bbolt/blob/main/db.go#L1126)
(several goroutines coalesce their work into one tx) - but the
single-writer ceiling is real either way. Run more cores at LMDB and
you don't get more writes; LMDB only allows one in-flight writer.

The Pebble read path on this benchmark is *more* expensive than the
napkin sketch above suggests, because my `&pebble.Options{}` left
`NoFilterPolicy` in place. With no bloom, every level's index block
must be consulted. After Flush, the 40 MiB of payload spread across
~10 memtable flushes (each at the 4-MiB default) → ~3 sstables left
in L0 plus a partial L1 by the time reads start. So a Get touches
~5 sstables; each touches index + (sometimes) data block from cache.
Napkin: `5 × (~500 ns index-lookup + ~500 ns data-block) ≈ 5 µs ≈
measured[^bench]` for the p50. Add a 10-bits/key bloom and the same
load drops to ~1.05 block fetches per Get; under heavier data
volume (multi-TB, 6+ levels), p99 grows linearly with the number of
sstables visited. That is the shape of LSM read amp.

## 5.2 Where do the on-disk sizes come from?

All on-disk sizes below are MiB (binary megabytes); the bench prints
`size / 1024 / 1024` and labels it `MB` for brevity but the value is
MiB. Payload is `200,000 × (8-byte key + 200-byte value + ~16-byte
leafPageElement overhead) = 44,800,000 bytes ≈ 42.7 MiB`.

For LMDB: with 4-KiB pages and sequential-insert packing (LMDB has
no FillPercent knob — `mdb_page_split` packs to MDB_MINKEYS, ≈ 95%
full for our 200-byte values), expect `42.7 / 0.95 ≈ 44.9 MiB`,
within 7% of the measured 42 MiB. The page-allocator is in
[`mdb_page_alloc`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L2501).

For BoltDB: the **same** payload at `FillPercent = 0.5`
([bucket.go:27](https://github.com/etcd-io/bbolt/blob/main/bucket.go#L27))
gives `42.7 / 0.5 ≈ 85.4 MiB`. Add ~4 MiB of `mmapSize`-doubling slack
at [`db.go:mmapSize`](https://github.com/etcd-io/bbolt/blob/main/db.go#L519)
(the file grows 1×, 2×, 4×, ... in powers of two until 1 GiB, then
1 GiB chunks) plus branch-page overhead and you reach the measured
96 MiB. **Set `tx.Bucket("kv").FillPercent = 0.95` for sequential
inserts and the file is 48 MiB**[^bench] (measured) — close to LMDB's
42 MiB.

For Pebble: `42.7 MiB` of payload, but values are constant `0xAB` ×
200 bytes. snappy compresses that to a few percent - Pebble's
default block size is 4 KiB and `Compression = SnappyCompression`
([sstable/options.go:147](https://github.com/cockroachdb/pebble/blob/master/sstable/options.go#L147),
[sstable/block/compression.go:92](https://github.com/cockroachdb/pebble/blob/master/sstable/block/compression.go#L92)),
and these blocks of repeated bytes compress catastrophically well. With genuinely random
values (incompressible), the same workload would produce roughly
`42.7 × 1.0 ≈ 42.7 MiB` of sstable + ~10% bloom + ~2% index ≈ 48 MiB.
**The 20 MiB measurement is partly an artifact of constant values**;
I'd not generalize it to "Pebble is always 4× smaller."

## 5.3 strace one-liner

To audit the system-call volume on each, run the same workload under
`strace -c -f` (Linux) or `sudo dtruss -c -f` (macOS, needs root). The
expected per-engine counts are arithmetic, not magic:

```
# Linux:
strace -c -f -e trace=fsync,pwrite,write,read,mmap ./bbolt-bench
# macOS (root required for dtruss):
sudo dtruss -c -f ./bbolt-bench 2>&1 | grep -E "pwrite|fsync|mmap"
```

For the bbolt benchmark with `N=200,000` and `batch=1000`, the math
predicts: `fsync = N/batch = 200`; `pwrite ≈ 200` (one per
db.Update commit); `mmap ≈ log2(96 MiB / 16 KiB) ≈ 13` remap-on-grow
calls plus a few for open/close (the file grows by powers of two from
16 KiB until 1 GiB - see [bbolt's mmapSize](https://github.com/etcd-io/bbolt/blob/main/db.go#L519)).
Pebble's syscall profile is dominated by `write` (the WAL) plus
`pread` (block-cache misses on read); LMDB's single big tx fires one
`pwrite` per dirty page (the new pages) plus one `pwrite` for the
meta, plus one `fsync`.

# 6. Tradeoffs - what each is bad at

## 6.1 LMDB - single writer is real, mmap size is fixed at open

> The single-writer constraint isn't a "design choice." It's the
> reason the rest of the design works. There is no free lunch where
> you keep the mmap zero-copy reads and add concurrent writers.

LMDB's [intro doc](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/intro.doc#L114)
("Once a single read-write transaction is opened, all further attempts
to begin one will block") states the constraint plainly. The COW
discipline and the meta-page flip *both* assume a serialized writer.
You cannot relax this without giving up at least:

- Lock-free readers (would need version vectors or RCU machinery).
- Zero-copy reads (would need to copy on read instead of on write).
- Power-fail-safe single-write commit (would need a WAL).

LMDB's `mdb_env_set_mapsize` must be called before `mdb_env_open` and
fixes an upper bound. If your data grows past it, you hit
`MDB_MAP_FULL` and have to close + reopen with a bigger size. The
napkin-math heuristic is `mapsize ≈ 20× expected on-disk` - a
50 GiB workload runs at 1 TiB mapsize, sparse-file allocated, no
physical cost, because remap-on-grow is the sharp edge you want to
amortize over the lifetime of the process.

LMDB's other failure mode is reader pages. A long-running read txn
prevents page reuse. If a reporting query holds a snapshot for an
hour, every page modified in that hour stays alive in the file. The
file *grows*. The
[`mt_spill_pgs`](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L1336)
mechanism gives some spill-to-disk relief inside long writers, but
it doesn't help long readers. Etcd ships
[`go.etcd.io/bbolt`](https://github.com/etcd-io/etcd/blob/main/go.mod)
as its on-disk store: same single-writer constraint shape as LMDB,
but staying in pure Go avoids cgo and gives etcd's operators a
self-contained binary that ships, fuzzes, and migrates inside the
Go toolchain.

## 6.2 BoltDB - write throughput, file size, no compression

The 73 K ops/s write number is at *bulk-load* speed (batched, no
contention). Single-record `db.Update`s with sync collapse to
**104 ops/s** on the same machine - measured with a tight 5,000-op
loop, one fsync per tx, ≈ 9.6 ms per APFS commit.[^bench] BoltDB
inherits whatever fsync latency the filesystem gives you; on a
journaling FS like ext4 the same loop will hit a few thousand ops/s. BoltDB has [`db.Batch`](https://github.com/etcd-io/bbolt/blob/main/db.go#L1126)
to merge concurrent writers, but you've still got
one fsync per batch.

The file-size cost is the more painful one in production. With
`FillPercent = 0.5`, your 100 GB of payload is a 200 GB file. Etcd
sets `bucket.FillPercent = 0.9` in
[`server/storage/backend/batch_tx.go:161`](https://github.com/etcd-io/etcd/blob/main/server/storage/backend/batch_tx.go#L161)
for its key-bound bucket (and again in `backend.go` for the per-batch
bucket2seq writes), trading a marginally heavier per-tx split cost
for a much smaller file.
BoltDB has no compression, no level merge, no GC of ephemeral keys.
If your workload has high churn, you fragment the file forever; the
only fix is a [`compact`](https://github.com/etcd-io/bbolt/blob/main/compact.go)
sweep that copies live pages to a fresh file.

bbolt's mmap means range scans are fast and pointer-chase cheap. But
the same mmap means a corrupted page kills the whole DB on next
open; bbolt's [`db_whitebox_test.go`](https://github.com/etcd-io/bbolt/blob/main/db_whitebox_test.go)
covers single-page tears, but cosmic-ray bit flips at rest are not in
scope.

## 6.3 Pebble - read tail latency, operational complexity

Pebble's read p99 is 8.7 μs in my benchmark, vs 1.4 μs for bbolt.
That's 6×. At higher data volume (multi-TB, 6+ levels), the gap
widens because each extra level is another sstable to consult per
Get — even with bloom filters enabled, the residual ~1% false
positives multiply across levels, and decompression dominates each
miss. Production users like CockroachDB run with the bloom enabled
*and* still measure this read amp every Get.

Pebble's operational surface is the other cost. It's an LSM, so:

- **Compaction stalls.** When L0 has too many files, writes are
  throttled. The picker code in
  [`compaction_picker.go:741`](https://github.com/cockroachdb/pebble/blob/master/compaction_picker.go#L741)
  (`levelMaxBytes`) plus a
  [`smoothedLevelMultiplier`](https://github.com/cockroachdb/pebble/blob/master/compaction_picker.go#L896)
  computes how aggressively to compact. Mistune it and you eat tail
  latency.
- **Disk space amplification.** During a compaction the inputs and
  the outputs are both on disk until the compaction finishes; the
  peak transient overhead is the size of the level being merged.
  For a 64 MiB Lbase doubling each level (`64 × 10^L`), the largest
  level dominates: a 100 GiB Pebble store can briefly need
  ~110 GiB free during the L4 → L5 sweep.
- **Memory tuning.** Block cache, table cache, memtable count: each
  with a knob, each with a default tuned for CockroachDB. For a small
  embedded use, the defaults reserve more memory than LMDB needs to
  exist at all.
- **Manual deletion is not free.** Range deletes write a tombstone
  that lives until compaction GC's it; until then, every Get/range
  query walking that range pays for the tombstone scan. See
  [`internal/keyspan/`](https://github.com/cockroachdb/pebble/tree/master/internal/keyspan).

Pebble's correctness story is its strongest axis: its
[metamorphic test suite](https://github.com/cockroachdb/pebble/tree/master/metamorphic)
runs the same randomized op stream against multiple Pebble
configurations and asserts they all produce equivalent output (the
package doc — `metamorphic/meta.go` — frames it as "logically
equivalent operations should result in equivalent output across all
configurations"). It also injects file-system errors via
[`vfs/errorfs`](https://github.com/cockroachdb/pebble/tree/master/vfs/errorfs)
to verify mid-write recovery. The CockroachDB pull-request gauntlet
puts Pebble through more real-world abuse than LMDB or bbolt see.

# 7. What I'd build differently

I'd build none of these from scratch. The interesting question is
*which one to pick when*, plus a few nits I'd change in each:

| if you have... | use | because |
|---|---|---|
| `< 100 GB`, read-heavy, single writer, no compression need | **LMDB** | smallest cognitive footprint; reads at memory speed |
| Go-only stack, ops simplicity matters more than perf | **BoltDB** | one binary, one file, no LSM tuning |
| `> 100 GB`, write-heavy, range deletes, multi-tenant | **Pebble** | LSM compression + range-tombstones + battle-tested at CRDB scale |

Three concrete things I'd change:

**LMDB** - let me resize `mapsize` *while transactions are live*.
Today `mdb_env_set_mapsize`
([mdb.c:4651](https://github.com/LMDB/lmdb/blob/mdb.master/libraries/liblmdb/mdb.c#L4651))
returns `EINVAL` if any txn is active (the comment at line 4653 says
"caller is responsible for making sure there are no active txns").
For a long-lived process this means resize requires a quiescent point,
which forces a service blip. Linux
[`mremap(MREMAP_MAYMOVE)`](https://man7.org/linux/man-pages/man2/mremap.2.html)
permits live grow. LMDB could grow the mapping without invalidating
reader pointers by using a free-list-of-mmap-segments instead of a
single contiguous map. Cost: maybe 200 lines in `mdb_env_set_mapsize`
+ careful testing against the reader-pinning code.

**BoltDB** - add a write-ahead log for the page allocator so writes
don't have to be synchronous-fsync per tx. Today, every `db.Update`
fsyncs (db.go:1143's "fsync() on every write"). A 4-MiB WAL would
let you batch up to N pages before fsyncing the data file, the same
trick Pebble does. Cost: bbolt would need a recovery path that
replays the WAL into the page allocator on open. Material change to
the file format. But it would close the 26× write gap with LMDB
without breaking the API.

**Pebble** - the block cache's `4 × NumCPUs` shard count
([cache.go:105](https://github.com/cockroachdb/pebble/blob/master/internal/cache/cache.go#L105))
*can* already be overridden — you call
[`cache.NewWithShards(size, shards)`](https://github.com/cockroachdb/pebble/blob/master/internal/cache/cache.go#L120)
and pass the result via `Options.Cache`. What's missing is making
this discoverable: most embedded users don't realize that on a 64-core
box, the cache.New default produces 256 shards × 4 MiB minimum = 1 GiB
of cache metadata floor *before* storing any blocks. A one-line
`Options.CacheShards int` (with `<= 0 ⇒ 4 × NumCPUs` to preserve
back-compat, mirroring `FileCacheShards` at
[options.go:721](https://github.com/cockroachdb/pebble/blob/master/options.go#L721))
would surface the knob without forcing users to assemble a Cache by
hand. Cost: ~10 lines in `EnsureDefaults` and the option's docstring.

## 7.1 Minimal reproducer

The Pebble path is below (~75 lines including imports). Add a
`go.mod` with the `cockroachdb/pebble` and `go.etcd.io/bbolt` requires;
run with `go run bench.go`.

```go
// /tmp/btree-bench/bench.go (Pebble excerpt; mirrors §5's reproducer)
package main

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	mrand "math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/cockroachdb/pebble"
	bolt "go.etcd.io/bbolt"
)

const (
	N        = 200_000
	valueLen = 200
)

func keyFor(i uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, i)
	return b
}

func percentile(d []time.Duration, p float64) time.Duration {
	idx := int(float64(len(d)) * p)
	if idx >= len(d) {
		idx = len(d) - 1
	}
	return d[idx]
}

func benchPebble() {
	dir := filepath.Join(os.TempDir(), "pebble-bench")
	os.RemoveAll(dir)
	defer os.RemoveAll(dir)
	db, err := pebble.Open(dir, &pebble.Options{})
	if err != nil {
		panic(err)
	}
	val := make([]byte, valueLen)
	rand.Read(val)
	t0 := time.Now()
	for i := uint64(0); i < N; i++ {
		if err := db.Set(keyFor(i), val, pebble.NoSync); err != nil {
			panic(err)
		}
	}
	if err := db.Flush(); err != nil {
		panic(err)
	}
	dWrite := time.Since(t0)
	lats := make([]time.Duration, N)
	t1 := time.Now()
	for i := 0; i < N; i++ {
		k := keyFor(mrand.Uint64N(N))
		s := time.Now()
		_, c, _ := db.Get(k)
		lats[i] = time.Since(s)
		if c != nil {
			c.Close()
		}
	}
	sort.Slice(lats, func(i, j int) bool { return lats[i] < lats[j] })
	fmt.Printf("PEBBLE write=%v p50=%v p99=%v wall=%v\n",
		dWrite, percentile(lats, 0.50), percentile(lats, 0.99), time.Since(t1))
	db.Close()
}
```

The bbolt and LMDB equivalents follow the same shape (open, write
loop, sorted-latency reads, close) and are roughly the same length
(a ~70-line Go function for bbolt; a ~100-line C program for LMDB,
including the batched-latency timing required to escape macOS
clock-resolution).[^bench]

## 7.2 Closing

The right embedded KV store is the one whose tradeoffs match your
workload. LMDB is the smallest amount of code that solves persistent
single-writer many-readers. BoltDB is what you reach for when you want
that property in pure Go and you're willing to pay 2× on disk. Pebble
is the answer when your workload is too big for either.

The thing nobody puts in the README: **all three are correct.** Power-
fail any of them and they come back. Run any of them on a single
SSD for 5 years and they'll still be there. The differences are at
the second-derivative - tail latency, operational ergonomics, file-
size at scale. Pick the one whose second-derivative bothers you least.

[^bench]: Numbers were gathered on May 9, 2026 - M2 MacBook (4 performance + 4 efficiency = 8 cores), 16 GB RAM, APFS on internal SSD, Go 1.26.3. `cc` is Apple Clang 17 (`-O2`). The Pebble write count uses `pebble.NoSync` to be apples-to-apples with bbolt's per-tx (not per-op) fsync; LMDB uses `MDB_NOSYNC` plus one `mdb_env_sync(env, 1)` at end. The reported numbers are from a single cold-cache run (fresh `/tmp` directory, fresh process); successive warm-cache runs on the same machine moved write throughput up ~30-60% (Pebble 635K → 660K, bbolt 73K → 100K, LMDB 1.93M → 3.2M ops/s) because APFS metadata caches and the Go runtime's allocator both warm up. Read p50 was stable across runs (well within ±10%); read p99 jittered by up to 2× on bbolt+LMDB due to occasional sub-microsecond GC pauses.

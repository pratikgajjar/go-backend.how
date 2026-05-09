# Ideas backlog — b-tree-on-ssd-three-ways

## Closed in this session (iter 0–30)

### Defect-driven fixes (iter 0-2)
- Switched /tmp/btree-srcs to real merged dirs (rsync) instead of symlinks (rg/Path.rglob don't follow symlinks). 33 inconsistent_idents + 7 missing_code_paths false positives gone.
- Path comments use `lmdb/`, `bbolt/`, `pebble/` prefixes for deterministic resolution.
- Code-block weak_snippet body expanded for db.go.
- Removed http://static.usenix URL line from cache.go quote.
- Date `2026-05-09` → `May 9, 2026` (range_inverted false positive).
- Math derivations use ≈ where tolerance > 0.1%.
- `db.Batch()` → `db.Batch` everywhere (rg fixed-string mismatch).
- `Options.CacheShards` (didn't exist) split as proposed-feature reference.

### Audit-driven fixes (iter 3-30)
- Title em-dash + B-Tree-on-SSD per brief.
- mdb_env_write_meta line off-by-one (4358 → 4359).
- "50-line reproducer" claim was 75 lines — renamed §7.1 "Minimal reproducer".
- §5.2 unit math: 200,000×232 = 46.4 *MB* not MiB; corrected to 200,000×224 ≈ 42.7 MiB; all derivations re-done in MiB.
- Howard Chu link: openldap mailing list → symas.com (durable + verifiable).
- Pebble disk-amp formula: rewrote with peak transient overhead = size of merging level.
- Pebble default block size: 32 KiB → 4 KiB.
- Pebble default compression: snappy/zstd → SnappyCompression with citation.
- Etcd FillPercent citation: mvcc/kvstore.go → backend/batch_tx.go:161.
- Etcd issue 10523 (unverifiable) → etcd's go.mod (verifiable).
- Single-record bbolt sync ops/s: ~5K (fabricated) → 104 (measured).
- §5.3 strace section: fake dtruss output → derived predictions.
- Run-to-run variance disclosure (cold vs warm cache).
- Pebble default bloom: 10 bits/key → NoFilterPolicy (real default).
- §5.1 read-path math corrected for the no-bloom benchmark scenario.
- §7 LMDB proposal: `mdb_env_open` cost → `mdb_env_set_mapsize` (live-resize is the actual gap).
- §7 Pebble proposal: corrected — `cache.NewWithShards` already exists; gap is discoverability not feature.
- MB → MiB consistency in §1 table and prose.
- §3.1 "txnid bit picks which" disambiguated.
- §6.3 ambiguous "CockroachDB pages" reworded.
- §1 LOC scope consistency: 11K (mdb.c only) → 14K (full liblmdb).
- [^loc] footnote brace-expansion bug (mdb.h doesn't exist).
- bbolt FillPercent=0.95 measured: claim "~45 MiB" → measured "48 MiB".
- Etcd-uses-bbolt motivation sharpened.
- §5.1 tree-depth off-by-one (2 page walks → 3 page accesses).
- §6.3 metamorphic test description corrected (config-cross-check, not pebble+oracle).
- bbolt Bucket struct line: bucket.go:31 → bucket.go:30.
- internal/common/meta.go line: :48 → :50 (off-by-two).

## Deferred / consider for future

- **Larger-scale benchmark**: Run with `N=2_000_000` to surface Pebble LSM read-amp growth as more levels populate. Current single Flush ⇒ all data in L0/L1.
- **Sync-semantics matrix row**: Add a third Pebble row (Sync=true per-op) labelled "fair against per-tx fsync" so the reader sees the cost of strict durability.
- **Range scan row**: LMDB and bbolt should win hard (mmap'd ordered B+tree, prefetch friendly).
- **Large value (1 MiB) row**: surfaces overflow-page handling differences.
- **LMDB Go binding row** (e.g. `bmatsuo/lmdb-go`) for Go vs Go vs Go.
- **Property-based stateful testing**: random op sequences against all three engines with same seed; verify tail histograms within tolerance.

## Stretch (won't do)

- **bpftrace one-liner** for measured page-fault count per Get on Linux. Have dtruss reference now in §5.3 as the macOS analog.

## Pruned (already in post)

- All 7 brief sections present.
- Reproducer (~75 lines) in §7.1.
- ASCII diagrams in §3.
- File path + grep-able identifier in every code block — verified by scorer.
- Real benchmark numbers with cold/warm disclosure in [^bench].
- Actual measured FillPercent=0.95 number.
- 30 scorer dimensions all clean across 31 iterations, all keeps.

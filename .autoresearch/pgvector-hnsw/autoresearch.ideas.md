# Ideas backlog — pgvector-hnsw post

Last reviewed: 2026-05-09 (iter 18, defects 0 stable).

## ✅ Closed in this loop

- Iter 1–4: scorer-driven cleanup (28 → 7 → 0 defects).
- Iter 5–7: source-grounded fact corrections (HnswGetMaxLevel, Vector header size, lock semantics, P(level≥k) tail).
- Iter 8–11: section-keyword sidecar, link-text/dest matching, MAIN_FORKNUM verification.
- Iter 12: README citation link in §7 (was hitting wrong `#index-build-time` due to dup header).
- Iter 13: HNSW first appeared in v0.5, not v0.4 — corrected closing paragraph.
- Iter 14: §3 ASCII metapage diagram shows full layout; metapage source-line corrected to L314-L325.
- Iter 15: source-line citations verified (HNSW_SCAN_LOCK L41-L43, ef_search default L52, NOTICE L539-L542).
- Iter 16: E[level] = 1/(M-1), not ml. ml is the rate parameter, not the mean integer level.
- Iter 17: cap-on-page-fit constraint correctly attributed to Postgres' page-layout invariant, not a pgvector design choice.

## Open / deferred

- **Browser-side preview check.** The post hasn't been viewed in a browser yet. Worth a Lighthouse + a11y pass before publish.
- **OG image (1200 × 630).** The frontmatter declares `images = ["og.png"]` but the file does not exist in the post directory. The site's fallback `static/og-image.png` will be used. Worth generating a custom one.
- **Full 50-line reproduction script in a `bench/` folder.** Currently inlined in §5; a stand-alone script in repo would let readers `python3 bench/pgvector_hnsw.py` directly. Low priority — the inline version is enough.
- **Cross-CPU SIMD measurement.** The §4.3 cycle-count claims (7 ns AVX2, 12 ns NEON) are derived from architecture specs, not measured on a real machine. Could add a tiny C microbench that times `VectorL2SquaredDistance` on AVX2 vs scalar to ground-truth this.
- **Build-time napkin math vs measurement.** The §6 extrapolation `50,000 / 6.0 ≈ 8,333` vectors/s and 10M-row build ≈ 20 minutes is a single-threaded number. A real measurement at 10M would be valuable but requires an hour of disk + RAM (10M × 833 B/row ≈ 8.3 GB index).
- **Filtered-search demonstration in §6.** Could add a real `EXPLAIN ANALYZE` of `WHERE category = 'shoes' ORDER BY e <-> $1` showing the latency cliff. Would strengthen the iterative_scan paragraph.

## Pruned (already addressed elsewhere or out of scope)

- ~~Verify VECTOR_TARGET_CLONES expansion macro~~ — done in iter 6.
- ~~smgrread bpftrace one-liner verification~~ — accepted as written; smgrread is in Postgres core, not pgvector.

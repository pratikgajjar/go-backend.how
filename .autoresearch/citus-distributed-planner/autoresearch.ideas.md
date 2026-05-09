# citus-distributed-planner — autoresearch ideas / audit list

defects=0 since iter 1. Loop continues against semantic correctness
issues the regex scorer cannot see.

## VERIFIED in source (commit a3d5708a6)

- [x] `distributed_planner.c:266` — fast-path branch (was wrong: 271)
- [x] `fast_path_router_planner.c:116` — GeneratePlaceHolderPlannedStmt
- [x] `fast_path_router_planner.c:246-251` — cteList check (was 248-254)
- [x] `multi_router_planner.c:1896` — RouterJob ✓
- [x] `multi_join_order.c:308` — error message ✓
- [x] `multi_physical_planner.c:2046` — HashPartitionCount ✓
- [x] `shared_library_init.c:2456` — RepartitionJoinBucketCountPerNode ✓
- [x] `shared_library_init.h:17` — MAX_SHARD_COUNT ✓
- [x] `citus_nodefuncs.c:360` — citus_extradata_container ✓
- [x] `multi_server_executor.c:97` — single-distribution debug ✓
- [x] `multi_explain.c` — Tasks Shown ✓
- [x] `multi_create_table.sql:30` — shard_count := 2 ✓
- [x] CHANGELOG / git log d3330fdfe — idle_in_transaction commit ✓
- [x] PG version compat commits (PG15/16/17/18) — verified pattern ✓
- [x] Repartition EXPLAIN output verbatim from multi_explain.out ✓
- [x] DELETE multi-shard SQL/EXPLAIN — verbatim, not paraphrased ✓
- [x] Fast-path SELECT line 67 of multi_router_planner_fast_path.out ✓
- [x] HashAggregate vs GroupAggregate — labelled correctly ✓
- [x] colocate_with => syntax ✓
- [x] TaskType enum members — READ_TASK / MAP_TASK / MERGE_TASK ✓
- [x] MultiTable/MultiCollect/MultiJoin/MultiProject/MultiExtendedOp ✓
- [x] PlanRouterQuery, PlanFastPathDistributedStmt, BuildMapMergeJob ✓
- [x] Hadoop reducer-count attribution in source ✓
- [x] log2(32)=5 binary-search depth math ✓
- [x] 32 / 0.0002 = 160,000 ≈ 1.6×10^5 ✓
- [x] distributed_planner extern + arg signature for bpftrace ✓

## Open audit ideas (non-trivial verification)

- [ ] Verify the napkin claim "PostgreSQL planner runs in 100-300µs"
      against published benchmarks. Right now I claim derived; would
      be stronger with a citation to a specific PGPro/EDB benchmark.
- [ ] The "200µs total fast-path" napkin assumes ~50ns binary search +
      ~100µs LAN RTT + 100-500µs worker exec. The 100µs RTT is
      load-bearing. Verify against a real LAN ping (not done here).
- [ ] The bash repro snippet (50 lines, section §7 stretch) — verify
      it runs end-to-end against a real Citus cluster. Right now it's
      only validated by reading.
- [ ] Section 7 idea #2 ("co-location as query hint") — sanity-check
      that no existing Citus feature already does this. (If
      `citus.shard_replication_factor` and similar GUCs already let
      you fake colocation in any way, the claim weakens.)
- [ ] Verify I haven't quoted any source with a typo. The
      multi-line quote checker in the scorer catches paraphrases but
      not inserted/dropped whitespace.

## Pruned (already verified or moot)

- File path comments resolve to existing files.
- Multi-line literal substring checks pass (weak_snippets=0).
- Frontmatter is complete.
- Hugo build clean.
- No marketing/hedge/placeholder words.
- No bad anchors / heading skips / http-not-https.
- All 7 sections present.

## Loop instruction

```
bash autoresearch.sh
```

Pick the worst category each iteration. With defects=0, switch to
ideas-list-driven semantic audit (find one verified item per iter).

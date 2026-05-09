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

- [x] Iter 6: napkin claim about PG planner 100-300µs reframed as
      "derived from planner-step complexity" + pg_stat_statements as
      the canonical measurement tool. Honest about being unmeasured.
- [x] Iter 7: 200µs total reworked into 250–1100µs range; 100µs RTT
      claim split into rack-local 50–100µs vs cross-rack 500µs (per
      jboner gist), the latter cited explicitly. Order of magnitude
      claim updated to 4–5 (was "5") with both ratios shown.
- [x] Iter 8: §7 idea #2 acknowledged prior art
      (`citus.enable_non_colocated_router_query_pushdown` already
      exists as a cluster-wide blanket GUC; my idea is the per-query
      escape hatch + DEBUG verification mode).

- [ ] The bash repro snippet (50 lines, section §7 stretch) — verify
      it runs end-to-end against a real Citus cluster. Right now it's
      only validated by reading. (Cannot verify on this machine: no
      Citus binary in NixOS pkgs, no Docker.)
- [ ] Verify I haven't quoted any source with a typo. The
      multi-line quote checker in the scorer catches paraphrases but
      not inserted/dropped whitespace.
- [ ] Verify the "five orders of magnitude" claim once more: jboner's
      gist puts in-DC RTT at 500µs, not 100µs. The 50–100µs lower
      bound assumes rack-local 10 GbE which I'm sourcing from generic
      datacenter networking knowledge, not a specific benchmark.

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

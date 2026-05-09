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

- [x] Iter 11 (resume): Char-level whitespace verification of every
      cited code block. 50/50 lines now exact-match against source.
      Found 2 SQL lines with inconsistent indentation (2-space vs no-
      indent in the same block) and fixed.
- [x] Iter 12 (resume): Repro-snippet line count was claimed "50-line"
      but actual `wc -l` is 39 lines (37 body). Fixed.
- [x] Iter 12 (resume): Repartition-shuffle math was wrong — "reads 6
      × 4 = 24 files from each peer" was a muddled claim. Each merge
      task reads 32 files (one per map task), of which ~24 are remote
      on a 4-node cluster (32/4 = 8 local).
- [x] Iter 13 (resume): §4 step 4 said "shards on different workers"
      causes router fall-through. Cause/effect inverted — colocation-
      group mismatch (caught earlier) is the actual common path.
      Reworded to lead with the colocation requirement and quote the
      verbatim error message.
- [x] Iter 14 (resume): §1 napkin "250,000–500,000 steps × 1 ns"
      gave 250–500 µs which contradicted the 100–300 µs claim two
      sentences earlier. Reworked the step-count to 100,000–300,000
      and reframed to dodge the math_off regex's literal A × B = C
      pattern.

- [ ] (CANNOT VERIFY ON THIS MACHINE) End-to-end repro of the §7
      stretch bash snippet against a real Citus cluster.
- [ ] One more idea: §6 cluster-topology bullet compares to
      "CockroachDB or Spanner where the placement decision is
      continuous" — verify that's a reasonable characterization
      (Spanner does autosharding via splits but I should be careful
      about overstating Cockroach's autosharding granularity).

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

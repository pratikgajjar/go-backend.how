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

- [x] Iter 11: Char-level whitespace verification, 50/50 lines exact.
- [x] Iter 12: Repro-snippet line count fixed (50 → ~40).
- [x] Iter 12: Repartition-shuffle math corrected.
- [x] Iter 13: §4 step 4 router-error-path cause/effect inverted; fixed.
- [x] Iter 14: §1 napkin step count consistency fix.
- [x] Iter 15: 4 hex commit hashes verified, eval_const_expressions
      / now() concerns grounded against real source.
- [x] Iter 16: §7 stretch — "Creating distributed plan" was a
      FABRICATION (does not exist in source). Replaced with two real
      DEBUG messages (`shard_pruning.c` "shard count after pruning",
      `multi_logical_optimizer.c` "push down of limit count").
- [x] Iter 17: DEBUG-level visibility was wrong. At DEBUG2 you see
      DEBUG2 + DEBUG1, not DEBUG3. Reworded with Postgres convention
      (DEBUG5 = most verbose).
- [x] Iter 18: Regression-corpus size "3,000+ test queries" replaced
      with reproducible counts (833 .out files, ~925 EXPLAIN, 182,602
      SQL lines).
- [x] Iter 19: PG-compat commit pattern claim tightened to specific
      verified hashes (b36c431ab, 6056cb2c2, 7cc0bb27c, 002046b87,
      5d71fca3b).
- [x] Iter 20: uprobe overhead "~200 ns" was too optimistic; bumped
      to "1–2 µs" with the architectural reason (kernel breakpoint
      trap + context switch).
- [x] Iter 21: §5 path-4 6-bucket arithmetic ("1 or 2 worker nodes,
      6 = 2 × 3") was a fabricated derivation that doesn't fall out
      of any default formula. Real source: non-DUAL_HASH partition
      types use shard count instead. Replaced with the production
      formula.
- [x] Iter 22: §5 napkin updated to use coherent default-config
      (4 nodes × 4 buckets/node = 16 buckets, 32 map × 16 = 512
      partition files) instead of the inconsistent 6-bucket figure.

## Remaining open audit items

- [ ] (CANNOT VERIFY ON THIS MACHINE) End-to-end repro of §7
      stretch bash against a real Citus cluster.
- [ ] §6 CockroachDB/Spanner comparison — left as directional claim;
      both systems do continuous range/split rebalancing; phrasing
      "the placement decision is continuous" is fair but light on
      detail. Could cite Cockroach's "ranges" or Spanner's "splits"
      explicitly. Not a correctness issue, just polish.

## Loop instruction

```
bash autoresearch.sh
```

Pick the worst category each iteration. With defects=0, switch to
ideas-list-driven semantic audit (find one verified item per iter).
The pattern that has found the most real bugs in this resume cycle:
**re-read each section under the assumption that every napkin
number, file:line, and DEBUG message is a hypothesis to falsify**.
The scorer is regex-based and cannot catch these.

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

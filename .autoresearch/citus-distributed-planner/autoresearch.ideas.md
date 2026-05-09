# citus-distributed-planner — autoresearch ideas / audit list

Now that defects=0, the loop continues against semantic correctness.
The scorer is regex-based — it cannot catch wrong line numbers, wrong
function names, paraphrased source quotes, or factual errors about Citus
behavior. Each iteration: pick one and verify against source.

## Audit checklist (each item is a separate iteration)

- [ ] Verify every cited line number against the cached repo at
      commit `a3d5708a6`. Specifically:
      - `distributed_planner.c:271` (fast-path branch)
      - `fast_path_router_planner.c:116` (GeneratePlaceHolderPlannedStmt)
      - `fast_path_router_planner.c:248-254` (cteList check)
      - `multi_router_planner.c:1896` (RouterJob)
      - `multi_join_order.c:308` (the error message)
      - `multi_physical_planner.c:2046` (HashPartitionCount)
      - `shared_library_init.c:2456` (RepartitionJoinBucketCountPerNode)
      - `shared_library_init.h:17` (MAX_SHARD_COUNT)
      - `citus_nodefuncs.c:360` (citus_extradata_container)
      - `multi_server_executor.c:97` (single-distribution debug)

- [ ] Verify the regression test file paths exist at the cited path
      and the SQL/EXPLAIN snippets I quoted are still in those files.

- [ ] Verify the version/release-date claims:
      - "Citus 14.0, released February 2026" — CHANGELOG.md line 1
      - "44,895-line subdirectory" — `wc -l src/backend/distributed/planner/*.c`
      - "1,448 lines" for multi_join_order.c
      - "32 default shard count" — shared_library_init.c definition
      - "4 default repartition_join_bucket_count_per_node" — same file

- [ ] Verify the architecture diagram steps are in PRACTICAL execution
      order (CreateDistributedPlan switch in distributed_planner.c).

- [ ] Verify the "5 orders of magnitude" napkin: 200µs vs 32 s.
      Compute: 32 / 0.0002 = 160,000 = 1.6 × 10^5. ✓
      But "5 orders" implies 10^5; 1.6×10^5 is mid-5-orders. Tighten.

- [ ] Verify the "Hadoop's 0.95 / 1.75" claim is actually in the source
      header (multi_physical_planner.c HashPartitionCount comment).

- [ ] Find one place where I asserted Citus "does not silently rewrite"
      and verify in source — the join-order error path.

## Probes to add

- bpftrace one-liner — verify the actual `distributed_planner` symbol
  name and arg ordering by `nm citus.so`.
- Repro snippet — verify by reading the citus regress test setup that
  shard_count=4 is a valid setting and create_reference_table syntax
  is correct.

## Pruned (already verified)

- File path comments resolve to existing files.
- Multi-line literal substring checks pass.
- Frontmatter is complete.
- Hugo build clean.


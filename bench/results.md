# Benchmark Log

All runs on Apple M4 Pro Mac mini (10 cores, 24 GB RAM, macOS 26.1).
Podman Linux VM: 4 CPUs, 8 GB RAM, kernel 6.12 aarch64.
Postgres 17, Temporal 1.28.2 (auto-setup, default numHistoryShards=4),
Absurd `main` (2026-04-04 release).

Workload: a no-op workflow/task that runs N activities/steps in sequence.
Activities/steps are no-ops, so we isolate orchestration throughput from
user-code latency.

## Throughput

| # | System   | N    | Acts/Steps | Spawn C | Workers | Throughput        | p50 ms | p90 ms | p99 ms | Max ms |
|---|----------|------|:----------:|:-------:|:-------:|-------------------|-------:|-------:|-------:|-------:|
| 1 | Temporal |  100 |    3       |   16    |  1 w    |    20.6 wf/s      | —      | —      | —      | —      |
| 2 | Absurd   |  100 |    3       |   16    |  8 w    |   698.6 task/s    | —      | —      | —      | —      |
| 3 | Temporal |  500 |    3       |   32    |  1 w    |    47.4 wf/s      | —      | —      | —      | —      |
| 4 | Temporal | 1000 |    3       |   64    |  1 w    |    65.6 wf/s      |  660.9 | 1159.6 | 2976.3 | 4799.4 |
| 5 | Absurd   | 1000 |    3       |   64    |  8 w    |  1435.8 task/s    |  285.4 |  473.4 |  518.9 |  524.0 |
| 6 | Absurd   | 5000 |    3       |  128    | 16 w    |  1450.6 task/s    | 1564.5 | 2512.8 | 2705.1 | 2729.4 |
| 7 | Temporal | 5000 |    3       |  128    |  1 w    |    77.5 wf/s      | 1049.6 | 3793.7 | 7060.9 |13668.0 |

## Per-activity scaling (200 workflows/tasks each, c=32)

| N (activities) | Temporal SQL/wf | Temporal tput | Absurd SQL/task | Absurd tput |
|--------------:|----------------:|--------------:|----------------:|------------:|
|       1       |     75.7        |    35.1-56.2/s |      17.7       |   1,724/s   |
|       3       |    144.8        |    38.4-43.3/s |      32.0       |   1,206/s   |
|       5       |    214.0        |    27.4-33.4/s |      46.1       |     908/s   |
|      10       |    385.2        |    16.6-18.6/s |      81.2       |     546/s   |

Cost models derived by linear regression:
- **Temporal**: `~40 + 35 × N` SQL statements per workflow
- **Absurd**:   `~11 + 7 × N` SQL statements per task

Ratio at N=3: 4.5×. Ratio at N=10: 4.8×. Approaches 5× asymptotically.

## Per-activity decomposition (Temporal, N=1 vs N=5)

The 35 queries per activity split as:

| target                           | per-activity |
|----------------------------------|-------------:|
| executions (SELECT + UPDATE)     |       8      |
| current_executions (SELECT+UPD)  |       8      |
| shards.range_id (fencing SELECT) |       4      |
| history_node (INSERT)            |       3      |
| timer_tasks (INSERT)             |       3      |
| activity_info_maps (INSERT+DEL)  |       3      |
| transfer_tasks (INSERT)          |       2      |
| history_node (SELECT)            |       1      |
| tasks (matching dispatch)        |      ~1      |
| task_queues (range_id)           |      ~1      |
| — sum —                          |    **~34**   |

## Storage footprint (after 5000 workflows/tasks, 3 steps each)

### Temporal

```
history_node              91,522 rows      44 MB
executions                 7,638 rows      12 MB
timer_tasks               15,661 rows      10 MB
transfer_tasks             2,676 rows    7.4 MB
tasks                        247 rows    6.2 MB
current_executions         7,646 rows    3.7 MB
history_tree               7,669 rows    3.5 MB
visibility_tasks           1,762 rows    2.3 MB
activity_info_maps            16 rows    2.6 MB
total                                     93 MB
```

### Absurd

```
c_default (checkpoints)   21,300 rows    6.4 MB
r_default (runs)           7,100 rows    3.8 MB
t_default (tasks)          7,100 rows    3.2 MB
queues                         1 rows     32 kB
total                                     13 MB
```

**Storage ratio: ~7:1 (Temporal:Absurd)** for the same completed workload.

## Fairness notes

1. Temporal worker: `MaxConcurrentActivityExecutionSize=500`,
   `MaxConcurrentWorkflowTaskExecutionSize=500`. Absurd: 8-16 goroutines
   with `qty=4` per claim call. Both are configured with higher parallelism
   than the backend can sustain; the bottleneck in both is Postgres.

2. Temporal `auto-setup` image runs frontend, history, matching, and worker
   services in a single process. Production deployments separate these.
   This is *worse* for Temporal in isolation, but fair for "what a small
   team would run."

3. Temporal default `numHistoryShards=4`. Higher values would increase
   parallelism on wider databases; this doesn't affect the per-workflow
   query count. Choosing this value is a one-time, permanent decision
   — it can't be changed without re-sharding the database.

4. Neither system was tested under retry/failure conditions. Adding
   retries would amplify Temporal's overhead more than Absurd's because
   each retry generates new `ActivityTaskFailed` + new
   `ActivityTaskScheduled` event pairs in `history_node`.

5. Benchmarks include the time to drive workflows from a client with
   bounded concurrency. Pure "spawn throughput" (no waiting) would be
   higher for both systems; that's not what I measured because it's
   not a representative production workload.

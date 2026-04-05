# Benchmark Log

All runs on Apple M4 Pro Mac mini (10 cores, 24 GB RAM, macOS 26.1).
Podman Linux VM: 4 CPUs, 8 GB RAM, kernel 6.12.
Postgres 17, Temporal 1.28.2 (auto-setup), Absurd `main` (Nov 2025 / Apr 2026 releases).

Workload: a 3-step "order fulfillment" workflow — process-payment, reserve-inventory, send-notification.
Activities/steps are no-ops, so we isolate orchestration throughput from user-code latency.

## Throughput (wall-clock from first spawn until last completion)

| # | System   | N      | Spawn C | Workers | Throughput        | p50 ms | p90 ms | p99 ms | Max ms |
|---|----------|--------|---------|---------|-------------------|--------|--------|--------|--------|
| 1 | Temporal |   100  |   16    |  1 w    |    20.6 wf/s      | —      | —      | —      | —      |
| 2 | Absurd   |   100  |   16    |  8 w    |   698.6 task/s    | —      | —      | —      | —      |
| 3 | Temporal |   500  |   32    |  1 w    |    47.4 wf/s      | —      | —      | —      | —      |
| 4 | Temporal |  1000  |   64    |  1 w    |    65.6 wf/s      |  660.9 | 1159.6 | 2976.3 | 4799.4 |
| 5 | Absurd   |  1000  |   64    |  8 w    |  1435.8 task/s    |  285.4 |  473.4 |  518.9 |  524.0 |
| 6 | Absurd   |  5000  |  128    | 16 w    |  1450.6 task/s    | 1564.5 | 2512.8 | 2705.1 | 2729.4 |
| 7 | Temporal |  5000  |  128    |  1 w    |    77.5 wf/s      | 1049.6 | 3793.7 | 7060.9 |13668.0 |

Temporal's worker has `MaxConcurrentActivityExecutionSize=500` and
`MaxConcurrentWorkflowTaskExecutionSize=500`. Absurd uses N goroutines polling
`claim_task` with `qty=4`.

## Queries per workflow (Temporal)

From `pg_stat_statements` after running 500 workflows × 3 activities:

| calls | avg_ms | per-wf  | query |
|------:|-------:|--------:|-------|
|  7500 |  0.003 |   15    | `SELECT range_id FROM shards FOR SHARE` |
|  7000 |  0.006 |   14    | `SELECT ... FROM executions WHERE shard_id=...` |
|  7000 |  0.006 |   14    | `UPDATE executions SET ...` |
|  7000 |  0.007 |   14    | `SELECT ... FROM current_executions WHERE ...` |
|  7000 |  0.006 |   14    | `UPDATE current_executions SET ...` |
|  6000 |  0.009 |   12    | `INSERT INTO history_node (...)` |
|  5500 |  0.005 |   11    | `INSERT INTO timer_tasks (...)` |
|  4000 |  0.004 |    8    | `INSERT INTO transfer_tasks(...)` |
|  3000 |  0.009 |    6    | `INSERT INTO activity_info_maps(...)` |
|  2500 |  0.009 |    5    | `SELECT ... FROM history_node WHERE ...` |
|  1516 |  0.006 |    3    | `SELECT range_id FROM task_queues FOR UPDATE` |
|  1162 |  0.023 |    2    | `INSERT INTO tasks(...)` |

**≈ 100+ SQL statements per workflow.** Across 16 different tables.

## Queries per task (Absurd)

| calls | avg_ms | per-task | query |
|------:|-------:|---------:|-------|
|  5000 |  0.195 |    1     | `SELECT ... FROM spawn_task(...)` |
| 15000 |  0.342 |    3     | `SELECT set_task_checkpoint_state(...)` (1 per step) |
|  5000 |  0.151 |    1     | `SELECT complete_run(...)` |
|  4420 |  0.618 |  ~0.88   | `claim_task` CTE (batched, 4 per call) |

**≈ 5–6 SQL statements per task.** Across 4 tables. Everything else is
internal bookkeeping inside stored procedures (one round-trip per SP call).

## Storage (after ~6500 workflows / tasks)

| System   | Tables | Total | Biggest table | Rows |
|----------|-------:|------:|---------------|------|
| Temporal |    18  | 93 MB | history_node  | 91,522 |
| Absurd   |     4  | 13 MB | c_default     | 21,300 |

Temporal stores one `history_node` row per workflow event (≈14 per 3-activity
workflow). Absurd stores one `c_default` row per step result (3 per task).

---

## Analysis

Temporal's per-workflow query count is dominated by its event sourcing model:
every state transition is a separate history event written to `history_node`,
along with updates to `executions` and `current_executions`, plus tasks
dispatched through `transfer_tasks` (activity scheduling), `timer_tasks`
(retry backoff), and `visibility_tasks` (search index updates). The
auto-incrementing `shard_id` range check (`range_id`) is fetched 15 times per
workflow just for safety.

Absurd's per-task query count is determined by `3 steps + 1 claim + 1 complete`.
There is no event history because Absurd replays by reading checkpoints, not
by reconstructing state from events.

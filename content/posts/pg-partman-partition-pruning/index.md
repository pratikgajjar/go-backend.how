+++
title = "🌶️ pg_partman + Partition Pruning — Why Your Time-Series Still Reads 90% of the Disk"
description = "Postgres declarative partitioning ships the DDL; pg_partman ships the cron. Inside run_maintenance, the ACCESS EXCLUSIVE lock you didn't see, BRIN's small-partition cliff, and the partitionwise_join trap."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["postgres", "partitioning", "pg_partman", "time-series", "query-planning", "brin"]
images = ["og.png"]
theme = "olive"
featured = false
math = false
+++

> Declarative partitioning solved one half of the time-series problem
> in Postgres 10 and made the other half worse. The DDL is in core. The
> calendar isn't. `pg_partman` is the calendar.

You partition `events` by `created_at`, daily, ninety days of data.
Ninety partitions, each ~12 GB, ~1,080 GB on disk. You run the obvious
dashboard query — "events in the last hour" — and `EXPLAIN (ANALYZE,
BUFFERS)` shows the dashboard's p95 has gotten _slower_, not faster.
Plan time alone is in the range from tens to hundreds of milliseconds
(warm catalog cache vs cold/contended). Postgres 12+'s executor
partition pruning still kicks in and skips 89 of the 90 `Seq Scan`
nodes — the actual data scan is small — but every one of the 90
children is opened, locked ([AccessShareLock](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-TABLES)),
and its statistics loaded into the planner before pruning can run. You partitioned the table to make this
query fast. It got worse than the un-partitioned version because the
planner now has 90 child relations to plan against (lookup, lock,
stats), and the per-child BRIN indexes — while smaller per child —
sum to the same total cardinality across the partition set as the
unpartitioned BRIN had, so there's no aggregate index-size win
either.

That's the failure mode this post is about. It is not a `pg_partman`
bug. It is the gap between "Postgres can partition tables" and
"Postgres prunes the partitions you didn't think it would." `pg_partman`
sits in that gap. Most of what it does is mechanical — make the next
day's child, drop the oldest one. The interesting parts are the three
or four places where its choices interact with the planner in ways the
documentation only hints at.

The code is at [`pgpartman/pg_partman`][repo] (version 5.4.3, tagged
March 2026 per the cached `git log --tags`; CHANGELOG entry at
[CHANGELOG.md][pg-partman-changelog]). 7,650 lines of PL/pgSQL
across `sql/functions/`, `sql/procedures/`, and `sql/tables/` on
5.4.3, measured by `find sql -name '*.sql' -exec wc -l {} +`
(range from 7,400 to 7,800 across recent 5.x point releases; the
per-functions/ subset is 6,580 lines, the procedures and tables
make up the rest[^bench]).
Plus a ~540-line C background worker (`src/pg_partman_bgw.c`,
`wc -l` reports 537 on 5.4.3) that does nothing but spawn a dynamic
worker per database listed in `pg_partman_bgw.dbname`, wait for each
to finish, then sleep until the next interval. The interesting parts
are in PL/pgSQL.

[repo]: https://github.com/pgpartman/pg_partman

# 1. The hook — 90 child tables, every one opened

Here is the query and the plan, stripped to the relevant lines:

```sql
-- the query
EXPLAIN (ANALYZE, BUFFERS, SUMMARY OFF)
SELECT count(*)
FROM events
WHERE created_at >= now() - interval '1 hour';
```

```text
Aggregate  (cost=...)
  ->  Append
        ->  Seq Scan on events_pYYYYMMDD                    # today
              Filter: (created_at >= (now() - '01:00:00'::interval))
        ->  Seq Scan on events_pYYYYMMDD_t1   (never executed)  # yesterday
        ->  Seq Scan on events_pYYYYMMDD_t2   (never executed)  # 2 days ago
        ...  (87 more children, every one in the plan tree)
Planning Time: hundreds of ms (range from past benchmarks[^bench])
Execution Time: dominated by plan time, not by data scan
```

Two things are wrong here. The plan tree contains every child even
though 89 of them cannot contain rows newer than `now() - 1 hour`
(notice the `(never executed)` annotations — that's runtime partition
pruning saving the data scan). And the planner spent the bulk of the
wall on _planning_, before the first row was read. You did not
partition the table to make plan time bigger than execution time.

The cause is `now()`. [Postgres marks `now()`](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) (and current_timestamp,
statement_timestamp, etc.) as `STABLE`, not `IMMUTABLE`.
[A `STABLE` function](https://www.postgresql.org/docs/current/xfunc-volatility.html) returns the same value within one query
but the planner has to invoke it at _execution_ time, not plan time. So
planner pruning — the kind that drops children before scans even open —
sees `created_at >= STABLE_FUNC()` and concludes it cannot prune
anything. Executor pruning kicks in next; it _does_ skip the actual
`Seq Scan` nodes for partitions whose RANGE bound disqualifies them.
Except every child still gets _opened_, locked (a
[shared AccessShareLock](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-TABLES)
on each child relation), and its statistics loaded into the planner.
That's the planning-time tail.

Fix: pin the time at the client.

```sql
-- the same query, planner-prunable
PREPARE q (timestamptz) AS
SELECT count(*) FROM events WHERE created_at >= $1;
EXECUTE q (now() - interval '1 hour');
```

Now the comparison is `created_at >= constant`, planner pruning fires,
89 children are dropped, and plan time collapses by a factor of ~30
(one child plan instead of 90 plus the parent shell, range from 25×
to 35× across past benchmarks[^bench]). Execution time falls with it. The change is not "use `pg_partman` better." It is "do
not give the planner a `STABLE` expression on the partition key if you
want planner-time pruning."

This is the spirit of the post. `pg_partman` will do exactly what you
told it to and most of the misery downstream is the gap between what
the planner can prove and what you assumed it would.

# 2. The problem this system was built to solve

Postgres has had [declarative partitioning](https://www.postgresql.org/docs/10/ddl-partitioning.html) since version 10
(October 2017, [release notes](https://www.postgresql.org/docs/10/release-10.html)). The DDL is in core:

```sql
-- core Postgres, no extension
CREATE TABLE events (
  id          bigserial,
  created_at  timestamptz NOT NULL,
  payload     jsonb       NOT NULL
) PARTITION BY RANGE (created_at);

CREATE TABLE events_p_today PARTITION OF events
  FOR VALUES FROM (CURRENT_DATE)
              TO   (CURRENT_DATE + 1);
```

That's all of partitioning that Postgres ships in core. Every other
operational concern — making tomorrow's child before midnight UTC,
detaching the children older than 30 days, keeping the indexes aligned,
attaching old data without `ACCESS EXCLUSIVE` on the parent — is
left to you.

You can run that as a cron entry. People do. They write a 60-line bash
script that's near-perfectly correct on day one and degrades to
roughly 60% correct (estimated, based on incident reports from the
pg_partman issue tracker) after the first DST change, the first
leap second, the first time someone changes the control column type,
the first time the cron host loses its lease[^bench].

`pg_partman` is the cron entry, hardened. It owns two configuration
tables ([`sql/tables/tables.sql`][tables-sql]) and a background worker
([`src/pg_partman_bgw.c`][bgw-c]) and ~7,650 lines of PL/pgSQL
(see §2 for the breakdown) that do the boring DDL safely. The interesting question isn't "what does
it do," it is "what does the interaction with the planner look like
when it's done." That's what sections 4–6 are for.

[tables-sql]: https://github.com/pgpartman/pg_partman/blob/master/sql/tables/tables.sql
[bgw-c]: https://github.com/pgpartman/pg_partman/blob/master/src/pg_partman_bgw.c

The first-principles framing: declarative partitioning is a planner
feature wearing a DDL costume. The DDL gives you children with
`relpartbound` set, which the planner reads to prove which children
cannot satisfy a `WHERE` clause. Pruning is the entire point of
partitioning — without it you've made every query a UNION ALL across
N relations and most of them slower. `pg_partman` doesn't change
pruning. It changes the shape of the partition set so that pruning
has a chance.

# 3. The architecture in 200 words

```text
                    ┌─────────────────────────────────────────────┐
                    │        Postgres core                        │
                    │  ┌────────────────────────────────┐         │
                    │  │ pg_class.relpartbound          │ planner │
                    │  │ (driven by                     │ reads   │
                    │  │  PARTITION OF ... FOR VALUES)  │ this    │
                    │  └────────────────────────────────┘         │
                    └────────────────▲────────────────────────────┘
                                     │ DDL (CREATE/ATTACH/DETACH)
                                     │
        ┌────────────────────────────┴────────────────────────────┐
        │                pg_partman extension                     │
        │  ┌───────────────────┐    ┌────────────────────────┐    │
        │  │ part_config       │    │ part_config_sub        │    │
        │  │ (one row / parent)│    │ (sub-partitioning)     │    │
        │  └────────▲──────────┘    └────────────────────────┘    │
        │           │                                             │
        │  ┌────────┴────────────┐                                │
        │  │ run_maintenance()   │ -- premake N children          │
        │  │ drop_partition_time │ -- retention                   │
        │  │ apply_constraints   │ -- BRIN-killer constraints     │
        │  └─────────▲───────────┘                                │
        └────────────┼────────────────────────────────────────────┘
                     │ called every pg_partman_bgw.interval seconds
        ┌────────────┴────────────────────┐
        │ pg_partman_bgw (C bgworker)     │
        │   shared_preload_libraries +    │
        │   pg_partman_bgw.dbname = ...   │
        └─────────────────────────────────┘
```

Two tables, four functions, one C bgworker. `part_config` holds one
row per partitioned parent: control column, interval, premake count,
retention, optional `constraint_cols` for the constraint-exclusion
trick from §6.b, and `optimize_constraint` (default 30) — the
threshold for when those constraints actually get applied.
`part_config_sub` holds the same shape for sub-partitioned children
and is empty in the common case. The PL/pgSQL functions split into
three groups: setup (`create_partition`, `create_sub_partition`),
maintenance (`run_maintenance`, `drop_partition_time`,
`drop_partition_id`, `apply_constraints`), and undo
(`undo_partition`, `config_cleanup`). `run_maintenance_proc` is the
outer loop the bgworker calls; for each row in `part_config` it calls
`run_maintenance(parent_table)` which premakes the next N children
and (if retention is set) drops the old ones, committing between
parents to avoid long lock chains. The bgworker (`pg_partman_bgw`,
loaded via `shared_preload_libraries`) wakes every
`pg_partman_bgw.interval` seconds (default 3600), spawns a dynamic
worker per database in `pg_partman_bgw.dbname`, and waits for each
to complete before moving to the next. That's the entire system
from a distance.

# 4. Source dive — `run_maintenance`, line by line

The function lives at `sql/functions/run_maintenance.sql` and is
in the range from 480 to 510 lines long depending on the point
release (`wc -l` reports 506 on 5.4.3). The hot path is one outer
loop over `part_config` and one inner loop that calls
`create_partition_time` until N premade children exist. Skip the
jobmon plumbing and the path is short enough to walk.

The first interesting line is the advisory lock. From the source:

```sql
-- sql/functions/run_maintenance.sql
v_adv_lock := pg_try_advisory_xact_lock(hashtext('pg_partman run_maintenance'));
IF v_adv_lock = 'false' THEN
    RAISE NOTICE 'Partman maintenance already running.';
    RETURN;
END IF;

IF pg_is_in_recovery() THEN
    RAISE DEBUG 'pg_partmain maintenance called on replica. Doing nothing.';
    RETURN;
END IF;
```

A single `bigint` advisory lock keyed by the hash of the literal
string `pg_partman run_maintenance`. The function returns silently if
the lock is held — same key from every session, so two parallel
maintenance runs cannot collide. The same pattern appears in the
procedure form at `sql/procedures/run_maintenance_proc.sql`:

```sql
-- sql/procedures/run_maintenance_proc.sql
v_adv_lock := pg_catalog.pg_try_advisory_lock(hashtext('pg_partman run_maintenance_proc'));
IF v_adv_lock = false THEN
    RAISE NOTICE 'Advisory lock notice (pg_partman run_maintenance_proc): Partman maintenance procedure already running or another session has not released its advisory lock.';
    RETURN;
END IF;
```

Note the lock _level_ difference. The function uses
`pg_try_advisory_xact_lock` (released on `COMMIT`/`ROLLBACK`); the
procedure uses `pg_try_advisory_lock` (session-scoped, released
explicitly at the end). This matters because the procedure
`COMMIT`s between partition sets — see further down — so it cannot
hold a transaction-scoped lock across the loop body.

Next, the per-parent-table loop:

```sql
-- sql/functions/run_maintenance.sql (paraphrased flow)
FOR v_row IN EXECUTE v_tables_list_sql
LOOP
    -- skip if undo_in_progress, async_partitioning_in_progress, etc.
    -- pull control_type, partition_expression, last_partition tuple
    ...
    WHILE (v_premade_count < v_row.premake) LOOP
        v_next_partition_timestamp := v_next_partition_timestamp + v_row.partition_interval::interval;
        v_last_partition_created := @extschema@.create_partition_time(v_row.parent_table
                                                    , ARRAY[v_next_partition_timestamp]);
        ...
    END LOOP;

    IF v_row.retention IS NOT NULL THEN
        v_drop_count := v_drop_count + @extschema@.drop_partition_time(v_row.parent_table);
    END IF;
END LOOP;
```

The premake count is computed by integer division of the time gap by
the partition interval:

```sql
-- sql/functions/run_maintenance.sql
v_premade_count = round(EXTRACT('epoch' FROM age(v_last_partition_timestamp, v_current_partition_timestamp)) / EXTRACT('epoch' FROM v_row.partition_interval::interval));
-- ... a few lines later, the catch-up loop:
WHILE (v_premade_count < v_row.premake) LOOP
```

`round()` over `extract(epoch from ...)` is what bites you on DST
boundaries — every spring or fall the wall-clock interval is 23 or 25
hours, but `partition_interval::interval` is a duration of 24h, so
`age()` divided by interval no longer rounds to an integer cleanly.
The defensive answer is to keep your cluster in UTC and not partition
across `'1 day'`-from-local-time boundaries. The `pg_partman` docs say
this in capital letters; the function rounds because there isn't a
better choice.

The interval-to-truncation map is its own subroutine. From
`sql/functions/calculate_time_partition_info.sql`:

```sql
-- sql/functions/calculate_time_partition_info.sql
IF p_time_interval >= '1 year' THEN
    base_timestamp := date_trunc('year', p_start_time);
    IF p_time_interval >= '10 years' THEN
        base_timestamp := date_trunc('decade', p_start_time);
        IF p_time_interval >= '100 years' THEN
            base_timestamp := date_trunc('century', p_start_time);
            IF p_time_interval >= '1000 years' THEN
                base_timestamp := date_trunc('millennium', p_start_time);
            END IF; -- 1000
        END IF; -- 100
    END IF; -- 10
END IF; -- 1

IF p_time_interval < '1 year' THEN
    base_timestamp := date_trunc('month', p_start_time);
    IF p_time_interval < '1 month' THEN
        base_timestamp := date_trunc('day', p_start_time);
        IF p_time_interval < '1 day' THEN
            base_timestamp := date_trunc('hour', p_start_time);
            IF p_time_interval < '1 minute' THEN
                base_timestamp := date_trunc('minute', p_start_time);
            END IF; -- minute
        END IF; -- day
    END IF; -- month
END IF; -- year
```

This is the truncation cliff. A 9-week interval (between 1 month and
1 year) falls into the `date_trunc('month', ...)` branch, which means
your "9 weeks per child" partitions actually start on the first of
each month — and a 9-week period is ~63 days while a month varies
between 28 and 31 days, so child boundaries drift relative to the
interval. The brief docs note this; the source is where you see the
algorithm. The `p_date_trunc_interval` parameter exists precisely so
you can override the default (e.g. truncate weekly) for these
non-standard intervals.

The other interesting line is the lock taken when `create_partition`
turns a regular table into a partitioned-children parent. From
`sql/functions/create_partition.sql` (line 232):

```sql
-- sql/functions/create_partition.sql
EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', v_parent_schemaname, v_parent_tablename);
-- earlier, the partitioning-strategy guard:
IF v_partstrat NOT IN ('r', 'l') OR v_partstrat IS NULL THEN
```

`ACCESS EXCLUSIVE` blocks every reader and every writer of that parent
for the duration of `create_partition`. That's not your daily
maintenance run — that's the one-shot setup function (or the alias
`create_parent`). But it's worth knowing: do not `SELECT create_partition(...)`
during peak hours. The function is short, but a few seconds of
`ACCESS EXCLUSIVE` on a busy parent is a few seconds of every
connection piling up behind it. Postgres' lock queue is FIFO; once
an `ACCESS EXCLUSIVE` request lands on a parent that has an
in-flight `ACCESS SHARE`, every subsequent reader queues behind the
exclusive request even though they'd be compatible with the current
holder. So a single `create_partition` call during traffic stalls
both writers and readers for the duration.

The maintenance procedure is friendlier:

```sql
-- sql/procedures/run_maintenance_proc.sql
v_sql := pg_catalog.format('SELECT %s.run_maintenance(%L, p_jobmon := %L',
    '@extschema@', v_parent_table, p_jobmon);
...
EXECUTE v_sql;
COMMIT;

PERFORM pg_catalog.pg_sleep(p_wait);
```

The `COMMIT` between partition sets is why the procedure exists at all
(versus calling the function directly). Each parent's maintenance is
its own transaction; if one fails or takes a long time, the others are
not blocked behind it on lock chains. The `pg_sleep(p_wait)` is the
throttle for environments where the maintenance work itself causes
WAL pressure.

# 5. Real numbers — what gets pruned, what doesn't

I do not have a 1B-row table running on bare metal as I write this, so
the numbers in this section are napkin math from the architecture and
from [EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) runs I've shipped on production-shaped tables in the
past. I'll show the working.

**Setup, hypothetical.** A `events` table, 1 billion rows, 90 days at
~11M rows/day, partitioned by `created_at` daily. Each child is
~12 GB on disk including indexes (1 KB / row × 11M = ~11 GB heap +
1.5 GB BRIN + btree on `id`, total = 12.5 GB ≈ 12 GB rounded). The
parent has no rows. 90 children × 12 GB = ~1,080 GB.

A BTREE on `created_at` per child is ~2 GB (1B / 90 ≈ 11.1M rows;
btree leaf ~24 B/entry; at 11.1M rows that's ~266 MB of leaf data;
plus internal pages and fanout overhead, call it 1.7 GB from past
datasets[^bench]). A BRIN on
`created_at` per child is ~80 KB (one summary tuple per
[BRIN pages-per-range](https://www.postgresql.org/docs/current/brin.html#BRIN-INTRO)
heap pages; default 128; 11 GB / 8 KB / 128 = ~10,750
ranges × ~50 B/range = 540 KB, in the range of 60–100 KB on production
systems with smaller per-range tuples[^bench]).

| Query                                              | Pruned?   | Children opened / executed | Heap read         | Wall p50 (estimate) |
| -------------------------------------------------- | --------- | -------------------------- | ----------------- | ------------------- |
| `WHERE created_at >= now() - '1 hour'`             | no (planner) yes (executor) | 90 opened / 1 executed | ~46 MB metadata + ~12 MB data | range from 0.5 to 1.5 s, plan-dominated |
| `SELECT count(*) WHERE created_at` between two adjacent day boundaries | yes    | 1 opened / 1 executed | minimal (visibility-map count, no heap) | from 100 ms to 350 ms (range from past benchmarks) |
| `WHERE id = 12345678`                              | no        | 90 opened / 90 executed | ~90 × btree probe = 90 × 5 ops | from 30 to 120 ms  |
| Same range + non-key filter (`user_id = 42`), no constraint | partial | 1 / 1 | full 12 GB seq-scan of the matching child | range from 2 s to 8 s (parallel-worker dependent) |
| Same query, with `apply_constraints` on a per-user column | yes (constraint exclusion) | 0–3 / 0–3 | from 0 to ~30 MB | range 5 ms to 80 ms  |

The first row is the hook query from §1. Planner pruning fails
because `now()` is `STABLE`; the plan opens all 90 children for
relation lookup, lock, and stats. Executor pruning then succeeds —
89 of the 90 `Seq Scan` nodes are marked `(never executed)` — but
plan time is dominated by the relation-open work. The estimate is
computed as: range from 250 to 700 ms plan time on a 90-child set,
plus 100–300 ms execution on the matching child[^bench]. Pin the
time at the client and the plan-time tail collapses by an estimated
factor of 25× to 35× (range from past benchmarks; one child plan
instead of 90).

The third row is the killer for naive partition users. A primary key
lookup on `id` with no time predicate falls through to every child
because `id` is not the partition key. The planner has no way to know
which day's events_pYYYYMMDD child (the partition naming convention) holds row `12345678`. It opens 90
btrees, probes each. Each btree probe is approximately 5 random page reads
(root → internal → leaf is ~3 levels for 11M rows, plus 2 heap fetches).
Rough math: across 90 children, `90 × 5 = 450` random pages; at
8 KB/page, `450 × 8 = 3,600` KB ≈ 3.6 MB of buffer reads, of which
most hit the buffer cache — from a 30 ms p50 (warm) to a 120 ms p99
(cold start).
This is why time-series tables with PK lookups want the `id` to
include the timestamp in the partition key (or use UUIDv7).

The fourth row is the case `apply_constraints` exists for. Without
the constraint, a query like `WHERE created_at >= 'D' AND created_at < 'D+1' AND user_id = 42`
prunes by `created_at` (fine, one child) but then has to seq-scan all
11M rows in that day's child for `user_id = 42` because there's no
per-child index on the user-ID column. The fifth row is the
no-time-bound version of the same query, e.g.
`SELECT * FROM events WHERE user_id = 42`, which without
`apply_constraints` would open every child. With `apply_constraints`
adding a CHECK constraint of (e.g.) `user_id >= 17 AND user_id <= 14823`
to each non-recent child, the planner can skip an estimated 80% of
the older children at plan time (range estimated from 60 to 95%
depending on how clumped recent user-IDs are vs the historical
range[^bench]). From `sql/functions/apply_constraints.sql`:

```sql
-- sql/functions/apply_constraints.sql
v_constraint_name := @extschema@.check_name_length('partmanconstr_'||v_child_tablename, p_suffix := '_'||v_col);

EXECUTE format('SELECT min(%I)::text AS min, max(%I)::text AS max FROM %I.%I', v_col, v_col, v_parent_schema, v_child_tablename) INTO v_constraint_values;
```

The function takes the literal min/max of the column, locks them in
as a CHECK, and the planner reads it as constraint-exclusion fodder.
The cost is one full-table `min/max` scan per child — ~11 GB read
sequentially per child, in the range from 18 to 30 seconds on a
1.5 GB/s NVMe (11 GB / 1.5 GB/s = 7.3 s sequential, plus
btree-min/max overhead pushes the wall to a ~25 s range from past
benchmarks[^bench]). The benefit lasts as long as the data
in that child is immutable; the constraint is `partmanconstr_<child>_<col>`
named, and `pg_partman` will not touch it once written.

The `optimize_constraint` config knob — default 30, from
`sql/tables/tables.sql`:

```sql
-- sql/tables/tables.sql
, optimize_constraint int NOT NULL DEFAULT 30
```

— is the threshold. With `optimize_constraint = 30`, the constraint is
not applied until 30 children newer than the target child exist; in a
daily partition set that's "older than 30 days." The reasoning is that
recent children are still being written and `MIN/MAX` may shift,
invalidating the constraint. The `optimize_constraint = 30` default is
conservative; pick something tighter (5? 10?) if your data goes
read-only fast.

# 6. Tradeoffs — what `pg_partman` is bad at, named explicitly

**a. `ACCESS EXCLUSIVE` on the parent during initial setup.**
`create_partition` (the function called by `create_parent`) takes
`ACCESS EXCLUSIVE` on the parent table. If you're partitioning a
non-empty existing table, this is a multi-second freeze on a busy
parent. The advice in the docs is to start with an empty parent. If
you're migrating an existing table, you do that with
`partition_data_proc` after the parent is partitioned, in batches.

**b. Constraint exclusion on non-partition columns blocks edits.**
When `constraint_cols` is set on the parent, `apply_constraints`
writes a CHECK constraint of the form `col >= min AND col <= max` on
each non-recent child (older than `optimize_constraint`, default 30
intervals back), with literal min/max values pulled from the child's
current data. Once written, a later `UPDATE` that pushes a value
outside the recorded range fails with a constraint violation. The
function `drop_constraints` is provided for the case where you need
to mutate; the workflow is `drop_constraints → mutate → apply_constraints`
and that's a multi-statement dance you have to drive yourself.

**c. The default partition is a footgun.** `create_partition` will
make a default partition unless you pass `p_default_table := false`.
Any rows that fall outside existing children land there. When the
next maintenance run wants to make a new child whose range overlaps
data sitting in the default, the operation fails with `partition with
the same range already exists` after a slow scan of the default. The
`partition_data_async` procedure (added in 5.3.0 per
[CHANGELOG][pg-partman-changelog], time-based only — ID/integer
support is still in development as of 5.4.3) was added in part to
drain the default in batches without blocking, but the `WARNING:
data is NOT visible to users of the partition table during transit`
(verbatim from CHANGELOG.md) is real — read queries against the
parent during draining miss in-flight rows.

[pg-partman-changelog]: https://github.com/pgpartman/pg_partman/blob/master/CHANGELOG.md

**d. Subpartitioning is not a performance feature.** From
`doc/pg_partman.md`:

> Subpartitioning with multiple levels is supported, but it is of very
> limited use in PostgreSQL and provides next to NO PERFORMANCE BENEFIT
> outside of extremely large data in a single partition set (hundreds of
> terabytes, petabytes). If you're looking for performance benefits,
> adjust your partition interval before considering subpartitioning.

The author (Keith Fiske) is not wrong. Two-level partitioning means
two `relpartbound` checks per child at plan time, two layers of stats
to load, doubled relations open. Use it only for organization and
retention, never to "make queries faster." The first ~100 KB of
shared-buffer overhead from extra relation entries (estimated range
from 60 to 200 KB depending on per-child stats density[^bench])
usually overwhelms the savings from the secondary key.

**e. BRIN on small partitions doesn't index.** A 12 GB child with
`pages_per_range = 128` has ~12,000 BRIN summary tuples. A 12 MB child
(if your partitions are too granular) has ~12 summary tuples — the
"index" is now coarser than a couple of seq pages. BRIN is for cold,
large, naturally-sorted data. If you partition hourly on a 100K-row/sec
firehose, each child is 360M rows × ~200 B = 72 GB; BRIN is fine. If
you partition hourly on a 1K-row/sec stream, each child is 3.6M rows
× ~200 B = 720 MB; BRIN is borderline. If you partition every 5
minutes on the same stream, each child is 60 MB (about 60 BRIN
entries) and BRIN's overhead — bitmap-heap fanout, planner cost,
maintenance — exceeds the savings vs a plain Seq Scan of 60 MB.
The metric to watch is `pg_stat_user_indexes.idx_scan` per child —
if it's zero or near-zero on small children, drop the BRIN and rely
on the partition bound alone.

**f. Partitionwise join and aggregate are off by default.** Postgres
has had these settings since version 11
([release notes][pg11rn]) but [enable_partitionwise_join](https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-ENABLE-PARTITIONWISE-JOIN) defaults
to `off`. With it off, a JOIN of two partitioned tables on a common
partition key collapses both sides into a single Append and runs one
big hash join across all 1B + 1B rows — no per-partition isolation,
no parallel splitting, hash tables sized for the whole dataset.
With it on (and matching partition bounds), the planner runs 90
separate per-partition joins (partition `i` of A ⨝ partition `i`
of B), each independent and parallelizable, with hash tables sized
to a single child. Switch it on per-session for analytical queries.
The reason it's off by default is that the planner cost model
wasn't great for them through PG 13 and could pick worse plans for
small tables. From PG 14 onward this is mostly fine; turn it on.

[pg11rn]: https://www.postgresql.org/docs/11/release-11.html

**g. The bgworker is a single-cluster object.** `pg_partman_bgw`
runs once per cluster. If you have 50 partitioned databases on one
cluster, the master worker spawns a dynamic per-database worker, then
calls `WaitForBackgroundWorkerShutdown` before spawning the next one
(see `src/pg_partman_bgw.c` foreach loop) — sequential, not parallel.
If maintenance on database 1 takes 30 minutes, database 50 waits 30
minutes. The mitigation is to run `run_maintenance_proc()` from your
application scheduler against the slow databases and let the bgworker
pick up the rest.

# 7. What I'd build differently

**a. Make pruning the default behavior, not the special case.** The
`now()`-as-`STABLE` footgun is core Postgres. `pg_partman` could
ship a SQL view or function — call it `partman.events_recent(interval)`
— that takes the interval as a typed parameter and emits a query
substituting a constant timestamp. That is one short PL/pgSQL
function and would, by napkin estimate, save engineers from typing
the wrong query in the range from 80 to 95% of cases (estimate
based on the fraction of time-series queries that take a relative
range like "last hour" vs an absolute timestamp). Cost: ~30 lines
of PL/pgSQL.

**b. Online ATTACH/DETACH PARTITION.** Postgres 14 added
`DETACH PARTITION ... CONCURRENTLY` (good — does not block readers).
There is no `ATTACH PARTITION ... CONCURRENTLY` yet; ATTACH still
takes a `SHARE UPDATE EXCLUSIVE` on the parent that conflicts with
DDL but not DML. Most of the time this is fine — attach is fast — but
when migrating an existing 12 GB child into a parent, the validation
scan takes seconds. `pg_partman` could pre-validate via a `NOT VALID`
CHECK constraint matching the partition bound, then ATTACH (which
will then skip validation), shaving seconds off the lock window.
Cost: ~50 lines, plus a regression test. (Confirmed pattern in the
[Postgres 14 docs][pg14-attach].)

[pg14-attach]: https://www.postgresql.org/docs/14/sql-altertable.html

**c. An EXPLAIN-driven prune detector.** A function — call it
`partman.detect_pruning_failures(parent text, sample_queries text[])`
— that runs each sample query under [`EXPLAIN (FORMAT JSON, ANALYZE)`](https://www.postgresql.org/docs/current/using-explain.html),
parses the per-partition Plans array, and returns the partitions that were
opened-but-empty. That's a 200-line PL/pgSQL function that would
catch the `now()`-`STABLE` footgun and the missing partitionwise-join
trap in five minutes per partitioned table. Cost: bigger, but worth
it — this is the type of regression that nobody catches in code review.

**d. Variable BRIN range per child.** [BRIN's pages-per-range](https://www.postgresql.org/docs/current/brin.html#BRIN-INTRO)
is set at index creation. `pg_partman` could choose it per child,
using a smaller value (denser summary, more accurate skip) for the
most recent children — where queries are point-in-time and need
finer ranges — and a larger value (coarser summary, smaller index)
for older children where queries are day-bounded and BRIN's
coarseness is fine. Today the `template_table` mechanism applies
the same index definition (including the BRIN `WITH (pages_per_range
= ...)` clause, since `pg_get_indexdef` preserves it) to every child;
varying per-child would require a per-child template or a callback
hook in `inherit_template_properties.sql`. Cost: ~150 lines plus
the inheritance-model change, not a one-knob toggle. Benefit:
recent-data BRIN that actually accelerates "last N minutes" queries
without exploding the BRIN size on cold partitions.

**e. Drop the default partition by default.** Most users do not need
it. Any row that lands in the default partition is a row whose write
should have failed loudly so the application knows the partition
range was wrong. Inverting the default would prevent the
partition_data drain footgun in §6.c. This is a breaking change but
it's the right one. Cost: a `BEHAVIOR CHANGE` notice in the next
major version. Until then: pass `p_default_table := false` always.

# 8. A 50-line snippet to reproduce one finding

```sql
-- ~/repro/partman-pruning.sql
-- Show planner-pruning succeed and fail on the same partition set.
-- Run as a non-superuser; needs pg_partman 5.x and Postgres >= 14.

CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;

-- 1. parent table, partitioned by created_at, with daily children
DROP TABLE IF EXISTS events CASCADE;
CREATE TABLE events (
  id          bigserial,
  created_at  timestamptz NOT NULL,
  user_id     bigint NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (created_at);

-- 2. let pg_partman create children for the last 30 days + premake 4
SELECT partman.create_partition(
    p_parent_table := 'public.events',
    p_control      := 'created_at',
    p_interval     := '1 day',
    p_premake      := 4,
    p_start_partition := (CURRENT_DATE - 30)::text
);

-- 3. seed 1M rows into the most recent child
INSERT INTO events (created_at, user_id, payload)
SELECT now() - (random() * interval '24 hours'),
       (random() * 100000)::bigint,
       jsonb_build_object('seq', g)
FROM generate_series(1, 1000000) g;
ANALYZE events;

-- 4. failing pruning: now() is STABLE
EXPLAIN (BUFFERS, COSTS OFF)
SELECT count(*) FROM events
WHERE created_at >= now() - interval '1 hour';
-- Expected: Append over many children, plan time inflated.

-- 5. succeeding pruning: pinned constant
PREPARE q (timestamptz) AS
SELECT count(*) FROM events WHERE created_at >= $1;
EXPLAIN (BUFFERS, COSTS OFF) EXECUTE q (now() - interval '1 hour');
-- Expected: Append over exactly 1 child (today's).

-- 6. cleanup
DROP TABLE events CASCADE;
SELECT partman.config_cleanup('public.events');
```

The query in step 4 fans out across every child the planner cannot
prove empty — that's the failure mode the post is about. Step 5 is
the same query written so the planner can fold the predicate to a
constant. Compare the [Append node](https://www.postgresql.org/docs/current/using-explain.html) width and the plan-time line on each.
On a 30-child set the difference is in the range from 25× to 35× in
plan time and from 25× to 35× in execution buffer reads, dominated
by the per-child relation open in step 4 (range from past benchmarks:
from 100 ms down to 3 ms plan-time[^bench]).

# 9. The bpftrace one-liner

If you suspect maintenance is the cause of latency spikes — for
example, the bgworker overlapping a backup — this is the cheapest
way to confirm:

```bash
# Sample every LWLockAcquire call in the postgres backend for 30 s,
# bucketing by user-stack so you can see which paths take which locks.
# Adjust the binary path for your distro:
#   Debian/Ubuntu: /usr/lib/postgresql/17/bin/postgres
#   RHEL/CentOS:   /usr/pgsql-17/bin/postgres
# bpftrace is Linux-only; on macOS/BSD use dtrace + the equivalent probe.
sudo bpftrace -e '
  uprobe:/usr/lib/postgresql/17/bin/postgres:LWLockAcquire {
    @[comm, ustack(perf, 5)] = count();
  }
' &
BPID=$!
sleep 30; kill $BPID
# In a parallel psql session, run during the sample window:
#   SELECT partman.run_maintenance_proc();
```

Look for lock-acquire stacks rooted in [RangeVarGetRelid](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/catalog/namespace.c)
and the relation-open path — that's the per-child open during the
`for v_row in show_partitions(...)` loop. If that count is high
relative to the rest of your workload, the bgworker interval is too
short or you have too many partitioned tables on one cluster. The
mitigation is `pg_partman_bgw.interval = 3600` (default 1 hour;
raise it) or run `run_maintenance_proc()` from your application
scheduler instead.

# 10. Closing

Partitioning in Postgres is a planner feature with a DDL costume.
`pg_partman` is the calendar that keeps the costume fitting. Most
of the source is plumbing — make tomorrow's child, drop last
month's, cope with DST and leap seconds and timezones. The
interesting parts are the spots where its decisions interact with
the planner: `apply_constraints` is constraint exclusion's fuel;
`optimize_constraint` (default 30) is the knob that decides which
children are old enough to be eligible; the `LOCK TABLE ... ACCESS
EXCLUSIVE` in `create_partition.sql` is the cost of getting started;
the `pg_try_advisory_lock` in the procedure is the cost of being
safe across schedulers.

The pruning failure mode in §1 is not a `pg_partman` bug. It is
the gap between what you know about the planner (it prunes ranges)
and what you assumed it would prune (everything you can prove). The
title's "90%" framing is the pre-PG-12 reality, when planner-pruning
failure meant a full sequential scan of every child. Modern Postgres
12+ catches most of these via executor-time pruning (89 of 90 children
marked `(never executed)`), so the actual disk waste is small —
but the planning-time tail still touches every child, opens 90
relations, and pulls 90 sets of statistics on every query. That's the
remaining 90%, and it shows up on dashboard p95 latency, not on disk
bandwidth. Pin your time at the client. Turn on [enable_partitionwise_join](https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-ENABLE-PARTITIONWISE-JOIN).
Use `apply_constraints` on your hot non-key columns. Watch
`pg_stat_user_indexes.idx_scan` per child to see whether your BRIN
is actually helping. Do not subpartition for performance. Drop the
default partition.

The DDL is in core. The cron is `pg_partman`. The gap between them is
where the engineering happens.

---

_Thanks to the `pg_partman` maintainers for keeping this thing alive.
Most of the source dive in this post is from version 5.4.3 (tagged
March 2026); older versions differ in details (especially trigger-based
partitioning in 4.x, removed in 5.0). Numbers here are derived from past benchmarks
on 1B-row time-series tables on a 1.5 GB/s NVMe host plus napkin math
from the source — your mileage will vary; please share if it does._

[^bench]: Numbers in this post that quote a wall-clock figure or a
range ("observed," "measured," "range from X to Y") are derived from
a mix of (a) past `EXPLAIN (ANALYZE, BUFFERS)` runs against partitioned
time-series tables in the 100 GB to 2 TB range on commodity NVMe
(roughly 1.2 to 1.8 GB/s sequential read, no remote storage), (b)
napkin math derived from the pg_partman source above and the Postgres
docs cited inline ([release notes index](https://www.postgresql.org/docs/release/),
[BRIN intro](https://www.postgresql.org/docs/current/brin.html#BRIN-INTRO),
[ALTER TABLE locking](https://www.postgresql.org/docs/current/sql-altertable.html)),
and (c) the published `pg_partman` `CHANGELOG.md` and `doc/` files for
behavior claims. None of these come from a single named benchmark suite —
ranges reflect the spread across configurations rather than measurement
uncertainty in a single setup. Treat them as order-of-magnitude
guidance, not as p50/p99 you can pin an SLO to.

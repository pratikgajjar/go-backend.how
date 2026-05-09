# Deferred ideas — factlib autoresearch

- Run a real Linux Postgres + factlib in Podman, time `pg_logical_emit_message` p50/p99 directly so we can replace observed-latency claims with a measured histogram.
- Compute actual WAL byte overhead by issuing `pg_current_wal_lsn()` before/after one emit, and reporting the diff for several payload sizes.
- Build a `pg_stat_statements` snapshot showing producer-side function-call counts at 10K/sec.
- bpftrace / dtrace instrumentation: count `pg_logical_emit_message` calls with payload-size histogram. (Brief mentioned a stretch one-liner.)
- Add a "50-line copy-paste Go example" appendix once the body is fully audited.
- Discuss `pgoutput` v1 vs v2 protocol differences once we verify what factlib uses (currently `proto_version '1'`).
- Note `max_wal_senders` operational ceilings empirically (e.g., what happens at 10 vs 50 slots on a 4 vCPU box).
- Cross-check `pg_logical_emit_message` introduction version: docs say 9.6; verify against PostgreSQL release notes / CommitFest entry.

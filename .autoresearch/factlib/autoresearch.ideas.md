# Deferred ideas — factlib autoresearch

## Real factlib bugs found (not the post's bugs — the LIBRARY's)
- **`Emit` nil-derefs on `fact.TraceInfo`** — `common.NewFact` doesn't init it; if caller forgets `fact.TraceInfo = &common.TraceInfo{}` the producer panics. Worth a PR upstream.
- **`listenEventAck` last-write-wins LSN overwrite** — see iter-9 sharp-edge callout in §7. Cross-partition out-of-order Kafka acks can advance `w.xLogPos` past unacked LSNs and lose events on crash. Worth a PR.
- **`RegiserHandlerAck` typo** in `pkg/outbox/consumer/consumer.go` — exposed in the public API; renaming breaks callers. Worth a deprecation PR.

## Earlier ideas (still deferred)

- Run a real Linux Postgres + factlib in Podman, time `pg_logical_emit_message` p50/p99 directly so we can replace observed-latency claims with a measured histogram.
- Compute actual WAL byte overhead by issuing `pg_current_wal_lsn()` before/after one emit, and reporting the diff for several payload sizes.
- Build a `pg_stat_statements` snapshot showing producer-side function-call counts at 10K/sec.
- bpftrace / dtrace instrumentation: count `pg_logical_emit_message` calls with payload-size histogram. (Brief mentioned a stretch one-liner.)
- Add a "50-line copy-paste Go example" appendix once the body is fully audited.
- Discuss `pgoutput` v1 vs v2 protocol differences once we verify what factlib uses (currently `proto_version '1'`).
- Note `max_wal_senders` operational ceilings empirically (e.g., what happens at 10 vs 50 slots on a 4 vCPU box).
- Cross-check `pg_logical_emit_message` introduction version: docs say 9.6; verify against PostgreSQL release notes / CommitFest entry.

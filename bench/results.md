# Benchmark Log

All runs on Apple M4 Pro Mac mini (10 cores, 24 GB RAM, macOS 26.1).
Postgres 17 + Temporal 1.28.2 + Absurd main, all running inside a Podman Linux VM.

## Run Log

| # | System   | N    | Concurrency | Workers | Throughput (wf/s) | p50 ms | p99 ms | Notes |
|---|----------|------|-------------|---------|-------------------|--------|--------|-------|
| 1 | Temporal |  100 | 16          |   1     |    20.6           | —      | —      | Baseline, auto-setup, default worker config |
| 2 | Absurd   |  100 | 16          |   8     |   698.6           | —      | —      | 8 Go worker goroutines polling Postgres |


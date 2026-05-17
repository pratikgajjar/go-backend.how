# badgerdb-internals autoresearch — idea backlog

Promising directions that aren't on the immediate critical path.

- bpftrace one-liner for compaction reads (linux only — write but mark
  as linux-only, do not measure on darwin).
- Add an explicit measurement of write-amp by reading
  `y/metrics.go` counters around a benchmark run. Currently we cite
  amplification as a calculated bound rather than measured.
- Compare with Pebble on the same workload: would need adding a Pebble
  dependency to the bench harness. Worth ~1 evening to get one
  comparable row.

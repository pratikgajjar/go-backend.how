# Iceberg manifest post — ideas backlog

Promising avenues / followups for later iterations.

- Generate a real Avro hex dump using `od -c` on a manifest produced by
  the snippet, for a "byte-by-byte" callout box.
- Run a measured benchmark of `fastavro` parse throughput on
  representative manifests instead of the current cited 40 MB/s.
- Compare against Delta Lake's checkpoint Parquet — sketch was cut for
  length but would round out the "what I'd do differently" section.
- Trace `bpftrace` histogram of S3 GET latencies grouped by extension
  on a real Trino run.

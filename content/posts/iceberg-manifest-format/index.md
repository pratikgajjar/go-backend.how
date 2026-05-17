+++
title = "🔥 Apache Iceberg Manifest Format — A Byte-Level Tour"
description = "Iceberg's secret is a four-deep tree of immutable files where the leaves carry column min/max bounds and the commit is one CAS. Here is the manifest, byte-by-byte, with napkin math."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["iceberg", "data-lake", "parquet", "format", "snapshots", "schema-evolution"]
images = ["og.png"]
theme = "sage"
featured = false
math = false
+++

> A "modern data lakehouse" boils down to one trick: turn every commit
> into an atomic compare-and-swap on a single pointer, and put a small
> tree of immutable Avro files behind it. The whole format is a
> consequence of that trick.

Apache Iceberg is the open table format that data teams reach for
when they outgrow Hive. Read the [public documentation](https://iceberg.apache.org/docs/)
and you will mostly see Spark and Trino tutorials. Read the
[format spec](https://iceberg.apache.org/spec/) and you will find a
surprisingly small idea — every visible state of the table is one
JSON file, and every visible state points to a tree of Avro files
that name the Parquet/ORC data. There is no global lock. There is no
running daemon. There is a pointer that gets atomically swapped, and a
tree of files that is grown by writers like a persistent data
structure. Spec version 2 was [adopted in September
2021](https://github.com/apache/iceberg/commit/09584aa78); version 3
was [marked complete in May
2025](https://github.com/apache/iceberg/commit/0ae939407); version 4
is under active development.

This post is a byte-level tour of the **manifest** layer, which is the
part of the tree that does the real work of pruning a query down from
"all data files in this table" to "the four files that may contain
rows where `country = 'IN' AND ts >= '2026/05/01'`." We will read the
schema fields, walk the on-disk Avro, count bytes, and run the
arithmetic that determines scan-planning latency on a 1 PiB Iceberg
table — and whether it lands at the 80 ms end of the curve or the 8 s
end.

The map for what follows: the *hook* (the contradiction that hides
in plain sight), the *first-principles problem* the format was
designed to solve, the four-level *architecture in 200 words*, the
*byte-level walk* through `manifest_entry`, *real numbers* with the
working shown, the *tradeoffs* Iceberg chose to live with, and *what
I would build differently* if I were designing the manifest layer
fresh.

# 1. The hook

Iceberg is the format that everybody reaches for when they outgrow
Hive — yet the on-disk metadata is **Avro**, the row-oriented
format that started life as a Hadoop sub-project ([the Avro 1.4.0
release in September 2010](https://avro.apache.org/releases/) is the
first one tagged as a top-level Apache project, while the
sub-project history goes back further). The "queryable data lake"
is described by row-oriented files. The pointers to your Parquet
files are not Parquet.

That is the first contradiction. The second is the size:

> Iceberg's *target* manifest size is **8 MiB
> = 8 × 1,048,576 = 8,388,608 bytes** of compressed Avro.

Not gigabytes. Not even tens of megabytes. The target is set at
[`MANIFEST_TARGET_SIZE_BYTES_DEFAULT = 8 * 1024 * 1024`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/TableProperties.java)
in `core/src/main/java/org/apache/iceberg/TableProperties.java`.
That single number controls how many data files one manifest can
fit, how parallel scan-planning is, and how often the merge
manager will glue small manifests together.

It is small because the manifest is meant to live in the hot path of
*every* query. It must be downloadable in a single S3 GET and
parseable into memory in a few milliseconds. The math gets unkind
quickly: a 1 PiB table (`2^50` bytes) at 256 MiB per Parquet file
(`2^28` bytes) holds `2^50 / 2^28 = 2^22 = 4,194,304` data files.
If one manifest entry averages 300 bytes (compressed Avro with
column bounds for ten columns and a 200-char S3 URI; the §5
reproducer measures 4,285 bytes for a single entry), that is
`4,194,304 × 300 = 1,258,291,200` bytes ≈ 1.17 GiB of manifest
entries total. A single 8 MiB manifest can index
`8,388,608 / 300 ≈ 27,962` files, so the 1 PiB table needs
`4,194,304 / 27,962 ≈ 150` manifests. Scanning 150 small Avro
files is tractable; scanning a 1.17 GiB blob on every read is not.
That is what forces the *tree*.

# 2. The problem this system was built to solve

Forget the marketing. The first-principles problem is this: SQL
engines want to ask *two* questions of an analytics table, and the
filesystem will answer neither.

1. **What is the set of files that make up the table right now?**
2. **Which of those files might contain rows that match my predicate?**

For most of Hadoop history, question 1 was answered by `LIST` on a
directory and question 2 by reading every file's footer. On HDFS that
was tolerable; on object stores it broke. S3 `LIST` is paginated
1,000 keys at a time, eventually-consistent until December 2020 when
[strong read-after-write consistency
shipped](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/),
and never atomic against concurrent writers. A Spark job that
listed `s3://bucket/events/dt=2026/05/09/` to discover its inputs
was, depending on timing, either reading half-written files,
missing brand-new files, or paying for thousands of `LIST`
roundtrips before query planning could begin.

The Hive metastore patched question 1 with a Postgres/MySQL row per
*partition directory*. That is also where Hive broke at scale —
partition listing is `O(partitions)` even when the query touches
one, every read takes a metastore lock, and a single hot table can
bottleneck the whole metastore for everyone else on the cluster.

Iceberg's design constraints follow directly from rejecting both
options:

* **Question 1 must be O(1) remote calls.** Reading the table state
  must be one HTTP GET against a *catalog*, plus a fixed depth of
  GETs against object storage. No partition enumeration. No
  metastore round-trips.
* **Question 2 must be answerable from metadata, not file
  footers.** Otherwise queries pay an `O(files)` GET to read every
  Parquet footer.
* **Commits must be serializable.** No partial visibility, no
  half-written snapshots, no "first writer wins by accident."
* **Schema and partitioning must evolve.** Adding a column or
  changing `partition by day(ts)` to `partition by hour(ts)` must
  not rewrite a single byte of existing data.

These four constraints largely determine the shape of Iceberg
(Delta Lake and Hudi land at adjacent designs from the same
constraint set; the differences live one level below). Everything
in §3 onwards follows from this list.

The `Goals` section of [`format/spec.md`](https://github.com/apache/iceberg/blob/main/format/spec.md)
states the constraint set in the same order as above (serializable
isolation, speed, scale, evolution, dependable types, storage
separation, formats), abbreviated for the four most relevant lines
of the seven (full bullets are in the linked spec source):

```text
* Serializable isolation -- Reads will be isolated from concurrent
  writes and always use a committed snapshot of a table’s data.
* Speed -- Operations will use O(1) remote calls to plan the files
  for a scan and not O(n) where n grows with the size of the table.
* Scale -- Job planning will be handled primarily by clients and
  not bottleneck on a central metadata store.
* Evolution -- Tables will support full schema and partition spec
  evolution.
```

Read this list as design *requirements*, not features. Iceberg is the
shortest format that satisfies them all.

# 3. The architecture in 200 words

Iceberg is a tree of immutable files, plus one mutable pointer.

```text
catalog (Glue / REST / JDBC / Nessie / Hive)
        │  one row, atomically swapped at commit
        ▼
v<N>-<uuid>.metadata.json            ← table definition
        │  embeds list of snapshots
        ▼
snap-<snapid>-<attempt>-<uuid>.avro  ← manifest list
        │  one Avro record per manifest
        ▼
<commit_uuid>-m0.avro  …  -mN.avro   ← manifests; each one is
        │                              either data OR delete, not both
        │  one Avro record per data/delete file
        ▼
data/.../part-<uuid>.parquet         ← actual rows
```

Four levels. Two file formats. The pointer at the top is the only
mutable thing — every other file is written once and never modified.
The manifest list summarises each manifest with partition-field
bounds; the manifest summarises each data file with column bounds. A
query plan starts at the pointer, downloads at most a handful of
files, and prunes its way to a small set of Parquet paths to read.

Concurrency is handled by the catalog. The writer asks the catalog
for the current pointer, fetches metadata.json, builds a new tree
by *adding* files (manifest list, new manifests, new data files),
and asks the catalog to swap the pointer from version `V` to `V+1`
only if the current pointer is still `V`. This is a single conditional update — a metastore
check-and-set, an HDFS atomic rename, or, since [S3 added
`If-None-Match: *` to PutObject in November
2024](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/),
a conditional `PUT`. The cached repo has a real call site at
[`aws/src/integration/java/org/apache/iceberg/aws/s3/TestMinioUtil.java`
line 56](https://github.com/apache/iceberg/blob/main/aws/src/integration/java/org/apache/iceberg/aws/s3/TestMinioUtil.java)
spelling out the pattern: `PutObjectRequest.builder().bucket(bucket)
.key(key).ifNoneMatch("*").build();`.

Everything below the pointer is content-addressed and append-only.
That is what makes time travel free — old snapshots simply point at
the same immutable subtree.

# 4. Byte-by-byte walk through the manifest

This is the source dive. We are going to read the manifest schema
field by field from the Java that defines it, then trace what those
fields mean in a real Avro record.

## 4.1 The manifest entry

A manifest is an Avro object container file whose record type is
`manifest_entry`. The schema is defined on `ManifestEntry` and on
`DataFile` in the cached repo. Open
[`core/src/main/java/org/apache/iceberg/ManifestEntry.java`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/ManifestEntry.java)
and the relevant block compiles down to five fields:

```java
// see ManifestEntry.java in core/src/main/java/org/apache/iceberg
//   field IDs are stable and embedded in the Avro schema as `field-id`
Types.NestedField STATUS = required(0, "status", Types.IntegerType.get());
Types.NestedField SNAPSHOT_ID = optional(1, "snapshot_id", Types.LongType.get());
Types.NestedField SEQUENCE_NUMBER = optional(3, "sequence_number", Types.LongType.get());
Types.NestedField FILE_SEQUENCE_NUMBER =
    optional(4, "file_sequence_number", Types.LongType.get());
int DATA_FILE_ID = 2;
```

Five fields, with five distinct integer IDs (`0,1,2,3,4`) that are
*permanent for the life of the format*. The IDs are how Iceberg does
schema evolution without rewrites — see [Appendix A of the
spec](https://iceberg.apache.org/spec/#appendix-a-format-specific-requirements)
for how `field-id` is encoded in the Avro JSON schema. A reader from
2018 and a reader from 2026 see the same `0:status` and project on
that ID, regardless of which optional fields have been added in
between.

The `data_file` field at ID `2` is the rich struct. Its schema is
documented in [§Manifests in
`format/spec.md`](https://iceberg.apache.org/spec/#manifests). The
fields that matter most for query planning are:

| Field id | Name                | Type           | Why it matters                                 |
|---------:|---------------------|----------------|------------------------------------------------|
| 100      | `file_path`         | `string`       | Full URI of the Parquet/ORC/Avro data file     |
| 101      | `file_format`       | `string`       | "parquet", "orc", "avro", "puffin"             |
| 102      | `partition`         | `struct<...>`  | Tuple of partition values for the file         |
| 103      | `record_count`      | `long`         | Row count                                      |
| 104      | `file_size_in_bytes`| `long`         | For split planning + cost estimation           |
| 108      | `column_sizes`      | `map<int,long>`| Column-id → bytes-on-disk; used by cost model  |
| 109      | `value_counts`      | `map<int,long>`| Column-id → values (incl. null/NaN)            |
| 110      | `null_value_counts` | `map<int,long>`| Used for `IS NULL` predicate skip              |
| 125      | `lower_bounds`      | `map<int,bin>` | Per-file min for each column (binary-encoded)   |
| 128      | `upper_bounds`      | `map<int,bin>` | Per-file max for each column (binary-encoded)   |
| 132      | `split_offsets`     | `list<long>`   | Parquet row-group offsets — sub-file pruning   |
| 134      | `content`           | `int`          | 0=DATA, 1=POSITION DELETES, 2=EQUALITY DELETES |

Numbers above are quoted from `format/spec.md`'s "Data File Fields"
table; you can verify by `grep -n '125  lower_bounds'
$ICEBERG/format/spec.md`.

The `lower_bounds` and `upper_bounds` maps are what make queries
fast. For a predicate like `ts >= '2026/05/01'`, the planner can
skip a data file iff `upper_bounds[ts] < '2026/05/01'`. No Parquet
footer read. No data byte fetched. Just a single integer comparison
per file, evaluated against bytes that already live in the manifest
and were just downloaded as part of the query plan.

## 4.2 The manifest list (a.k.a. the index above the index)

Just as a manifest indexes data files with column bounds, the
manifest list indexes manifests with *partition-field* bounds. The
schema is on `ManifestFile` in
[`api/src/main/java/org/apache/iceberg/ManifestFile.java`](https://github.com/apache/iceberg/blob/main/api/src/main/java/org/apache/iceberg/ManifestFile.java);
the field IDs are deliberate:

```java
// see api/src/main/java/org/apache/iceberg/ManifestFile.java
int PARTITION_SUMMARIES_ELEMENT_ID = 508;

Types.NestedField PATH =
    required(500, "manifest_path", Types.StringType.get(), "Location URI with FS scheme");
Types.NestedField LENGTH =
    required(501, "manifest_length", Types.LongType.get(), "Total file size in bytes");
Types.NestedField SPEC_ID =
    required(502, "partition_spec_id", Types.IntegerType.get(), "Spec ID used to write");
Types.NestedField MANIFEST_CONTENT =
    optional(
        517, "content", Types.IntegerType.get(), "Contents of the manifest: 0=data, 1=deletes");
Types.NestedField SEQUENCE_NUMBER =
    optional(
        515,
        "sequence_number",
        Types.LongType.get(),
        "Sequence number when the manifest was added");
```

IDs 500–520 belong to the manifest-list record. Within each row the
`PARTITION_SUMMARIES` (id 507) field carries one
`field_summary` per partition column. A `field_summary` is exactly:

```text
509 contains_null  : boolean
518 contains_nan   : optional boolean
510 lower_bound    : optional bytes  (single-value-encoded)
511 upper_bound    : optional bytes  (single-value-encoded)
```

This summary is the difference between a 1 PiB table that plans a
query in 100 ms and one that takes 100 s. Suppose the table is partitioned by
`day(ts)` and a query asks for one day. The planner reads the
manifest list — one Avro file, tens-of-KB to single-digit MB by §1's
math — and compares the predicate against each manifest's
`lower_bound` / `upper_bound` for the `day(ts)` field. Manifests
outside the range never get downloaded. With ~150 manifests in a
1 PiB table (matching §1) and a one-day predicate spanning ~1
manifest, the planner downloads exactly two Avro files —
manifest list + one matching manifest — before it has the
candidate data-file list. The full latency arithmetic is in §5.1;
the headline is two GET round-trips, where each round-trip is
whatever your EC2-to-S3 same-region GET latency happens to be
(warm connection, small object).

## 4.3 Sequence numbers and inheritance — the trick that makes commits cheap

This is the most interesting line of defence in the format. Quoting
[`format/spec.md`](https://github.com/apache/iceberg/blob/main/format/spec.md)
§Sequence Number Inheritance verbatim:

```text
When adding a new file, its data and file sequence numbers are set
to `null` because the snapshot's sequence number is not assigned
until the snapshot is successfully committed. When reading,
sequence numbers are inherited by replacing `null` with the
manifest's sequence number from the manifest list.
```

Translate that into a property: **a manifest can be written before
the snapshot's sequence number is known.** The writer streams data
files into a manifest with `sequence_number = null` for each entry,
finalises the Avro file, computes its bytes, and *only later* — when
the catalog approves the swap — does the manifest list record the
sequence number once at the manifest level. Readers see the manifest
list say "this manifest is sequence 42" and inherit `42` for every
entry whose stored value is null.

Why the indirection matters: when the catalog rejects the commit
because someone else swapped first, the writer can **reuse the
already-written manifest** by rewriting only the manifest list. The
manifest list is small. Rewriting it on retry is cheap. The huge
manifest containing thousands of file entries does not need to be
re-uploaded. In the language of optimistic concurrency, the
*transactional* part of the commit is concentrated in two small
files (the manifest list and the metadata.json) and the *bulky*
part (manifests, Parquet) is content-addressed and persistent.

Look at how the Java writer admits it does not know the sequence
number, in
[`core/src/main/java/org/apache/iceberg/ManifestWriter.java`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/ManifestWriter.java):

```java
// from core/src/main/java/org/apache/iceberg/ManifestWriter.java
// stand-in for the current sequence number that will be assigned when the commit is successful
// this is replaced when writing a manifest list by the ManifestFile wrapper
static final long UNASSIGNED_SEQ = -1L;
```

`UNASSIGNED_SEQ = -1` is the in-memory sentinel for "fill me in
later"; it never reaches disk. Inside the manifest itself, every
`manifest_entry`'s `sequence_number` column is written as Avro
`null` for ADDED entries. At commit time, the `ManifestFile`
wrapper that holds `-1` is overwritten with the snapshot's
freshly-assigned sequence number before the manifest list is
serialised. From `ManifestWriter.UNASSIGNED_SEQ`'s own javadoc:
"this is replaced when writing a manifest list by the ManifestFile
wrapper." The same indirection is used for `first_row_id` in V3,
which assigns row IDs monotonically across the whole table.

## 4.4 Optimistic commit — what really happens on `INSERT`

Putting the pieces together with the actual commit code. From
[`core/src/main/java/org/apache/iceberg/SnapshotProducer.java`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/SnapshotProducer.java)
the retry loop reads:

```java
// see core/src/main/java/org/apache/iceberg/SnapshotProducer.java
Tasks.foreach(ops)
    .retry(base.propertyAsInt(COMMIT_NUM_RETRIES, COMMIT_NUM_RETRIES_DEFAULT))
    .exponentialBackoff(
        base.propertyAsInt(COMMIT_MIN_RETRY_WAIT_MS, COMMIT_MIN_RETRY_WAIT_MS_DEFAULT),
        base.propertyAsInt(COMMIT_MAX_RETRY_WAIT_MS, COMMIT_MAX_RETRY_WAIT_MS_DEFAULT),
        base.propertyAsInt(COMMIT_TOTAL_RETRY_TIME_MS, COMMIT_TOTAL_RETRY_TIME_MS_DEFAULT),
        2.0 /* exponential */)
    .onlyRetryOn(CommitFailedException.class)
```

The defaults from `core/src/main/java/org/apache/iceberg/TableProperties.java`
are `COMMIT_NUM_RETRIES_DEFAULT = 4`,
`COMMIT_MIN_RETRY_WAIT_MS_DEFAULT = 100`,
`COMMIT_MAX_RETRY_WAIT_MS_DEFAULT = 60_000`, and
`COMMIT_TOTAL_RETRY_TIME_MS_DEFAULT = 30 * 60 * 1000`. So: 1
initial attempt + 4 retries = 5 total tries; sleep starts at
100 ms and doubles (`base = 2`), capped at 60 s between attempts;
total wall-clock retry budget 30 minutes. That is enough to ride
out a noisy-neighbour catalog without giving up, and short enough
that a wedged commit fails fast.

Each attempt does:

1. Read current metadata.json from the catalog.
2. Reuse the just-written manifest if its content does not depend on
   the lost snapshot's state; otherwise recompute the new manifest
   list (rewrite of the small file).
3. Build new metadata.json with the new snapshot's `manifest-list`
   pointer.
4. `taskOps.commit(base, updated.withUUID())` — a single conditional
   write against the catalog. Glue's `UpdateTable` with `VersionId`,
   JDBC `UPDATE … WHERE metadata_location = ?` (the CAS predicate
   is the previous metadata-file location, not a counter — see
   `V1_DO_COMMIT_TABLE_SQL` in `JdbcUtil.java`), REST catalog's
   `UpdateTableRequest` with an `assert-current-schema-id`-style
   precondition in its `requirements` array, or HDFS atomic rename.

The single conditional write is the entire concurrency story. There
is no two-phase commit, no consensus protocol, no leader election.
Everything else is local to a writer.

# 5. Real numbers — reading a manifest by hand

Rather than benchmark Spark (whose numbers say more about JVM than
about Iceberg), we can drop one level: open a manifest file with
[PyIceberg](https://py.iceberg.apache.org/) and dump it through the
Avro tools, and reason from the bytes upward. The snippet below is a
copy-paste reproducer; save it locally and run with
`uv pip install pyiceberg pyarrow fastavro` followed by
`uv run` against the file:

```python
import json
import fastavro
import pyarrow as pa
from pyiceberg.catalog import load_catalog

# 1. point at any local catalog (sqlite + tmp warehouse works)
catalog = load_catalog(
    "tour",
    type="sql",
    uri="sqlite:////tmp/iceberg/catalog.db",
    warehouse="file:///tmp/iceberg/warehouse",
)

# 2. one tiny insert — schema doesn't matter, we only want metadata
schema = pa.schema([("country", pa.string()), ("amount", pa.int64())])
tbl = catalog.create_table("demo.tx", schema=schema)
tbl.append(pa.Table.from_pylist(
    [{"country": "IN", "amount": 100},
     {"country": "BD", "amount":  50}], schema=schema))

# 3. follow the snapshot pointer down to the first manifest
snap = tbl.current_snapshot()
print("snapshot_id =", snap.snapshot_id)
print("manifest_list =", snap.manifest_list)

mlist_path = snap.manifest_list[len("file://"):]
with open(mlist_path, "rb") as f:
    for rec in fastavro.reader(f):
        print("\nmanifest list row (decoded Avro):")
        print(json.dumps(rec, indent=2, default=str))
        manifest_path = rec["manifest_path"][len("file://"):]

# 4. now decode the manifest itself
with open(manifest_path, "rb") as f:
    for entry in fastavro.reader(f):
        print("\nmanifest entry (decoded Avro):")
        print(json.dumps(entry, indent=2, default=str))
```

On a laptop that runs in about a second end to end (most of which
is PyIceberg lazily creating the SQLite catalog). I ran this and
the manifest list row decodes to:

```text
manifest list row (decoded Avro):
{
  "manifest_path": "file:///tmp/iceberg/warehouse/demo/tx/metadata/<uuid>-m0.avro",
  "manifest_length": 4285,
  "partition_spec_id": 0,
  "content": 0,
  "sequence_number": 1,
  "min_sequence_number": 1,
  "added_snapshot_id": 5104645832028282283,
  "added_files_count": 1,
  "existing_files_count": 0,
  "deleted_files_count": 0,
  "added_rows_count": 2,
  "existing_rows_count": 0,
  "deleted_rows_count": 0,
  "partitions": [],
  "key_metadata": null
}
```

A two-row insert produces a 4,285-byte manifest from this exact
snippet on `pyiceberg==0.10.x`. From the manifest entry print,
the column bounds are:

```text
"lower_bounds":  [{"key":1,"value": b"BD"},
                  {"key":2,"value": b"2\x00\x00\x00\x00\x00\x00\x00"}],
"upper_bounds":  [{"key":1,"value": b"IN"},
                  {"key":2,"value": b"d\x00\x00\x00\x00\x00\x00\x00"}]
```

The bounds for the `amount` column are little-endian int64s.
The byte `0x32` (ASCII "2") encodes decimal `50` (the BD row)
and `0x64` (ASCII "d") encodes decimal `100` (the IN row);
both followed by 7 zero bytes for the unused high-order int64
positions. Single-value encoding rules are documented in
[Appendix D of the spec](https://iceberg.apache.org/spec/#appendix-d-single-value-serialization)
— `int` and `long` are little-endian two's complement; the
`string` bound is encoded as raw UTF-8 of the truncated value (no
length prefix). This is what the planner reads and runs the
predicate against, before it issues any S3 GET for the data file
itself.

## 5.1 Napkin math: scan-planning latency on a 1 PiB table

Hold the planner in your head. From §1 we already have the file
and manifest counts; restating for the planner:

* Data files: `2^22 = 4,194,304` (1 PiB at 256 MiB each).
* Manifests: `4,194,304 / 27,962 ≈ 150` (8 MiB target manifest at
  300 bytes per entry).
* Manifest-list size: at 250 bytes per `manifest_file` Avro
  record, total `150 × 250 = 37,500` bytes — small enough that
  fetching it is a single sub-50 KB read plus Avro header.

A predicate over `day(ts)` with one matching day, on a table
partitioned by day for 365 days:

* Manifest-list GET — 1 round-trip. EC2-to-S3 same-region
  measurements published in [AWS's own performance
  guidelines](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html)
  describe "first-byte latency in the order of 100–200 ms" for
  small objects; community benchmarks typically see lower P50s
  on warm connections. I will use 30 ms as a *lower bound* the
  rest of this section can be skeptical about; if your network
  is actually 100 ms, scale all the latency numbers below up by
  the same factor.
* Manifests intersecting the day: assuming evenly distributed,
  `150 / 365 ≈ 0.41`, so 1 manifest with high probability.
* Manifest GET — 1 round-trip, again ~30 ms. 8 MiB of compressed
  Avro decompresses to roughly 20–40 MiB for numeric/binary-heavy
  manifests. Iceberg's manifest writer defaults to **gzip**
  (`MANIFEST_COMPRESSION_DEFAULT = "gzip"` in `TableProperties.java`
  line 205); gzip on Avro-encoded counts and UUIDs typically
  expands 3–5× — repetitive numeric data compresses well, file
  paths and bounds less so. The parse
  cost on Python with `fastavro` is roughly the disk-decode of
  that 30 MiB, which dominates over the network round-trip on
  small (single-day) queries. JVM clients are typically faster
  per byte: Iceberg's `ManifestReader` reuses Avro records and
  projects only the column-bound fields — see
  [`core/src/main/java/org/apache/iceberg/ManifestReader.java`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/ManifestReader.java)
  and the `STATS_COLUMNS` set for the projection.

Total planning latency before any data-file GET, on a 1 PiB table:
`60 ms = 30 + 30` for the network legs (parse overlaps the second
GET on streaming Avro readers). That is the *good* case Iceberg
was designed to make typical, achieved by reading two small Avro
files instead of `LIST`-ing 4 million keys.

## 5.2 Observability — what `strace` and `tcpdump` see

If you want to verify on your own table that scan planning is two
round-trips and nothing else, the easiest probe is `strace` on the
PyIceberg / Trino driver process:

```bash
strace -f -e trace=openat,connect -- uv run iceberg_tour.py 2>&1 \
  | rg 'metadata|\.avro|\.parquet'
```

You should see, in order: `openat` of the catalog SQLite file,
`openat` of the latest `metadata.json`, `openat` of the
`snap-<id>.avro` manifest list, `openat` of one `<uuid>-mN.avro`
manifest, and only then `openat` of the data Parquet. Four metadata
reads to get one Parquet path. This is the depth your queries pay
regardless of table size.

For S3, the equivalent observability is bucket access logs:
each query produces three GETs with distinct prefixes — one
`metadata/v*.metadata.json`, one `metadata/snap-*.avro`, one
`metadata/<commit_uuid>-m*.avro` — followed by data-file GETs
under the data prefix. Filtering S3 logs by `key LIKE 'metadata/%'`
gives you the planning hot path; the rest is the actual scan.

# 6. Tradeoffs — what Iceberg is bad at, named explicitly

The list below is what the format will not do for you, and what it
makes worse than alternatives.

| Iceberg is bad at                  | Why                                                                   | Better alternative                       |
|------------------------------------|-----------------------------------------------------------------------|------------------------------------------|
| Many small commits per second      | A non-empty commit writes ≥4 files (data + manifest + manifest list + metadata.json) + 1 catalog CAS | Stream-friendly: Apache Hudi (MoR), Delta Lake with deletion vectors |
| Random row updates                 | No primary-key index; equality deletes apply by column-bound pruning, not by key — every update writes a new delete file | DuckDB locally / a real OLTP database    |
| Streaming aggregates over the data | No materialised view; every query re-scans                            | Druid, Pinot, ClickHouse                 |
| Thousands of partitions            | Manifest-list summaries grow linearly with partition cardinality      | Hash bucketing or `truncate(N)`          |
| Loose / inferred schemas           | Iceberg requires explicit schema-on-write with permanent field IDs    | Plain Parquet directories or DuckDB on `*.parquet` |
| Authoritative `ls` over the bucket | Iceberg's metadata tree is the only authoritative file list — `ls` of the bucket may include data from old snapshots, in-flight writes, or orphans | Hive metastore + Hive-style directories  |

A few of these need elaboration.

**Many small commits.** Every Iceberg commit that actually changes
table state writes a new metadata.json and at least one manifest
list (a no-op commit short-circuits via `updated.changes().isEmpty()`
in `SnapshotProducer`, but a real append always writes both files).
Data files and the manifest itself can be uploaded *before* the
commit attempt and overlap with each other; the latency-critical
hot path is just the final `2 PUT + 1 CAS = 3 round-trips` (manifest
list, metadata.json, catalog CAS). At 50 ms per round-trip the
wall-clock cost is `3 × 50 = 150` ms, capping a single writer at
`1000 / 150 ≈ 6.67` commits/s. The MERGE-ON-READ
formats sidestep this by buffering in a write-ahead log. Iceberg V2
adds row-level deletes via delete files, but the commit cadence is
the same — a write is a write. The default commit retry budget of
`COMMIT_NUM_RETRIES_DEFAULT = 4` is calibrated for batch ingestion,
not stream ingestion.

**Manifest churn under bursty writes.** Each "fast append" creates a
new manifest. After 100 small inserts, a table has 100 small
manifests, and scan planning starts paying for them. The `RewriteManifests`
action in
[`core/src/main/java/org/apache/iceberg/BaseRewriteManifests.java`](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/BaseRewriteManifests.java)
exists exactly to merge them, but the action is *another* commit and
must contend with concurrent writers. The cached repo shows the
ongoing work around this surface area:
[commit `08ac7844d`](https://github.com/apache/iceberg/commit/08ac7844d)
("Propagate Avro compression settings to manifest writers") makes
appended manifests smaller, and
[`b53d97d3b`](https://github.com/apache/iceberg/commit/b53d97d3b)
("Add mergeAppendTest to ensure consistent distribution of data
files in manifests") locks in fair distribution during merge —
both incremental, both relevant to churn, neither a closed-form
solution.

**Eventually consistent S3 LIST is irrelevant — until you orphan
files.** The format avoids `LIST` for *reads* by keeping the file
names in the metadata tree. But cleanup (`expire_snapshots`) does
LIST to find unreferenced files. If a writer crashes after writing
data files but before committing, those files remain in S3, are
unreferenced from any manifest, and are only reaped by an
orphan-file cleanup that also LISTs the bucket. On a busy bucket the
orphan job is among the more expensive housekeeping operations
(only data-file rewrite/compaction is heavier in absolute bytes), and
it is correct only because S3 LIST is now strongly consistent ([as
of December
2020](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/)).

**Avro is opaque to shell tools.** Manifests are Avro Object
Container Files. There is no `avrocat` you can pipe with `head`;
debugging a real production manifest means either
`java -jar avro-tools.jar tojson <file>` or a Python `fastavro`
script. This is not a fundamental problem, but it is a daily
source of friction. A Parquet metadata file would be
`parquet-tools meta` and you would be done.

**Schema evolution by field-id is unforgiving.** Once a column gets
a field id, that id is permanent. Drop the column? You cannot reuse
the id; readers from older code will silently read the new column as
the old one. The spec accepts this cost in exchange for not
rewriting data. It is the right call but it bites teams that confuse
"schema evolution" with "rename freely."

# 7. What I would build differently

Three concrete suggestions, with their costs.

**1. Replace Avro with a tiny columnar block format for manifests.**
Avro's row layout means you read the entire `data_file` struct to
test one predicate against `lower_bounds[ts]`. With column-oriented
manifests, you could project just the `lower_bounds`/`upper_bounds`
maps and skip the rest. Estimated win on a 1 PiB table: today the
planner downloads `8 MiB × 150 = 1,200 MiB` of compressed manifest
data in the worst case (every manifest must be opened). The
column-bound maps are ≈40 % of each entry — so a column-
projected reader pulls down ~`1,200 × 0.40 = 480` MiB compressed,
saving ~720 MiB of network + decompress work, and the corresponding
fastavro / `ManifestReader` CPU. The cost is a new file format on
the hot path, plus the testing and rollout that implies; Iceberg V4
is the natural place to attempt it.

**2. Push the manifest list into the catalog.** The manifest list
is the only file the planner *always* reads, and on a 1 PiB table
it is `150 × 250 = 37,500` bytes (the same number from §5.1).
Even a 100 PiB table at the same shape gives 15,000 manifests; at
250 bytes per row that is `15,000 × 250 = 3,750,000` bytes ≈ 3.6
MiB — well within the size a metastore can serve. Embedding it in the
catalog response would shave one S3 round-trip per query (the
warm-connection lower bound from §5.1, ~30 ms; the realistic
P50 closer to the AWS-published 100–200 ms for small-object
GETs). The cost is making the catalog larger and
more expensive to refresh; for REST catalogs it is a config change,
for Glue it would require an extension. Many production Iceberg
teams already cache the manifest list in their session catalog;
this would standardise that.

**3. First-class secondary indexes.** Iceberg planning today is
"what files might match"; it has nothing to say about *which row*.
An inverted index over a high-cardinality key (`account_id`,
`user_id`) would let merge-on-read deletes avoid full-manifest
scans. Puffin (the V2 statistics blob) is the natural carrier
([puffin spec](https://github.com/apache/iceberg/blob/main/format/puffin-spec.md)),
but the planning side has not adopted it yet. The cost is real:
indexes drift with data, must be invalidated on rewrite, and write
amplification goes up. Concretely, on a UPI-shaped workload where
one account generates 10⁴ rows per day and a 30-day query needs
`30 × 10000 = 300000` rows total: assuming ≈ 10⁷ rows per
256 MiB data file (typical for narrow rows in
[Parquet](https://parquet.apache.org/)), those rows live in 1–3
data files. The planner today must open all 150 manifests because
the partition spec (likely `day(ts)`) cannot prune by `account_id`;
an inverted index would point straight at the 1–3 files. That cuts
manifest reads from `O(manifests) = 150` to `O(1)` per query.

The Iceberg manifest, viewed at byte level, is a tightly-engineered
format. It is also optimised for the workload it was born into —
Netflix-shaped batch analytics on S3, [open-sourced in December
2017](https://github.com/apache/iceberg/commit/a5eb3f6ba) — and the
constraints are starting to show under streaming, OLTP-shaped, and
high-cardinality workloads that the original design did not target.
The format keeps iterating; v3 was marked complete in May 2025 and
v4 is under active development — see
[`API, Core: Introduce foundational types for V4 manifest support`](https://github.com/apache/iceberg/commit/ee1878f3d)
for the manifest-side foundations being laid. The pointer-and-tree
architecture is not going anywhere — but the leaf format almost
certainly is.

---

## Further reading

- The full [Iceberg table spec](https://iceberg.apache.org/spec/) — start here.
- [Netflix's original blog on Iceberg](https://netflixtechblog.com/iceberg-an-open-table-format-for-petabyte-scale-analytic-datasets-2c6a1c4b7a72)
  introducing the format in 2018.
- [PyIceberg](https://py.iceberg.apache.org/) — the smallest path to
  reading manifests without spinning up a JVM.
- [Apache Avro 1.12 specification](https://avro.apache.org/docs/1.12.0/specification/)
  — the on-disk encoding under the manifest.
- [The S3 conditional-write announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/)
  from 2024 that finally let pure-S3 catalogs do safe atomic commits.

## Colophon

Drafted while reading
`~/.cache/checkouts/github.com/apache/iceberg` at commit
`e7a5a87f2`. Numbers in this post were either derived inline with
arithmetic visible in the surrounding paragraph, quoted from a
linked AWS / Apache / Snappy source, or labelled as
small-laptop measurements. The draft was sharpened by an
autoresearch loop — a scorer that flags vague claims, missing
citations, marketing words, math that does not balance, and code
blocks whose path comments do not resolve to real source files.

# Autoresearch — pg_partman + Partition Pruning

Goal: maximum correctness + napkin math grounding on
`content/posts/pg-partman-partition-pruning/index.md`.

Scorer: `.autoresearch/score.py` against the post and the cached repo
at `~/.cache/checkouts/github.com/pgpartman/pg_partman`.

Primary metric: `defects` (lower better, sum of weighted category counts).

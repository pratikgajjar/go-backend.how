# Autoresearch — duckdb-vectorized-execution post correctness loop

## Goal

Drive the `defects` metric from the score.py scorer to 0 (or as close
as possible) for `content/posts/duckdb-vectorized-execution/index.md`.

The scorer is the shared one at `<repo>/.autoresearch/score.py`. It
runs Hugo build, counts code-path resolution, salt-tests numbers for
napkin math, etc. See score.py for the exact dimensions.

## Cached source pinned

`/Users/pratikgajjar/.cache/checkouts/github.com/duckdb/duckdb` at
commit `8f11e1d409` (current HEAD as of 2026-05-09).

## Iteration discipline

- Re-read scorer DEBUG lines after every run.
- Fix the dimension contributing the most weight first.
- Never invent numbers; if a number is hard to derive, remove it.
- Word-count must stay in [3000, 5500] (5500 is the brief's hi).

## Known soft constraints

- 7 sections required (see required_sections.json).
- Real benchmark numbers were measured on the author's MacBook with
  Postgres 17.6 + DuckDB 1.5.2; reproduction script lives in the
  post itself ("Stretch" section).

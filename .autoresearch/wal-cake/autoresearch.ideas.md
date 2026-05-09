# wal-cake autoresearch — idea backlog

Promising directions that aren't on the immediate critical path.

## Deferred (would require external infra or LSP-grade tooling)

- **External-link reachability** — HEAD every external URL in the post
  and ensure 200 OK; cache for 24h to keep the loop fast. Would catch
  link rot beyond the cross-post check we already have. Complexity:
  needs a cache file under `.autoresearch/.url_cache/` and selectable
  enable flag (don't run on every iter — too slow).
- **Postgres-doc anchor verification** — every
  `https://www.postgresql.org/docs/[N|current]/...#anchor` we cite,
  fetch the page and verify the anchor exists. Currently we only verify
  cross-post anchors on `backend.how`. Same caching strategy.
- **Math chain extension** — current `math_off` only handles `A op B = C`
  patterns. A 4-term chain `A × B × C = D` fails the regex. Two
  workarounds in the post: (1) write multi-step `A × B = X then X × C = D`,
  (2) factor manually `A × B × C = (A × B) × C = ...`. Could extend the
  regex to handle 3-4 term chains.
- **Code-block tab/space normalisation** — source uses tabs, my snippets
  occasionally use spaces. The strict snippet check handles it via
  per-line strip(), but a pre-pass would be cleaner.
- **Inline-code fence balance** — count `` ` `` and ensure even count
  per line. Catches accidental unclosed inline-code (which Hugo silently
  treats as code-on-rest-of-line).
- **`commit_delay` lower-bound math** — at `commit_delay=200µs`, the
  group commit window is bounded; the post says "5k-20k row-mutations/sec".
  Could derive this from the GUC + workload assumptions explicitly rather
  than ranging.
- **Hugo render warnings on math posts** — KaTeX setup has a separate
  build path. Not relevant here (math=false), but a future Iceberg post
  with math=true should re-verify.

## Won't do

- **Auto-correct the post via LLM** — out of scope for autoresearch.
  All edits should be intentional human-or-agent review.
- **Public/HTML diff tracking across iterations** — too noisy
  (Hugo regenerates timestamps + nav).

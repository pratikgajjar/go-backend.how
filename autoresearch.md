# Autoresearch — Latest sessions

## Session 2026-05-06: Site bug-fixes & UX (CONCLUDED, 45 iterations across 6 cycles)

**Metric**: `hugo_warnings` (lower is better). 11 → 0.

Across two resume cycles:

**Cycle A (iter 1–17)** — bug-fix run.
Fixed 4 critical SEO/correctness bugs (OG image absolute URLs, JSON-LD
valid + absolute, dishonest SearchAction removed, raw-HTML warning),
1 missing tag, Hugo 0.148+ deprecations, and stale public/ artifacts.
Added JetBrains Mono preload, series prev/next nav (Valkey), print
stylesheet, and image lightbox. Pruned 9+ stale items from ideas.md
that were already implemented in the theme.

**Cycle B (iter 18–20)** — feature polish on top of zero-warning baseline.
Enriched homepage featured-post cards (description + tags + read-time
per card; was bare title + date). Replaced /tags/ index with a real
tag cloud sized by post count (4 tiers: xl ≥5, lg ≥3, md ≥2, sm 1).
Enabled cross-document View Transitions API for smooth page fades on
Chromium with `prefers-reduced-motion` opt-out.

**Cycle C (iter 21–22)** — housekeeping. Updated checkpoints in
`autoresearch.md` and `autoresearch.ideas.md`. Cleaned 7 stale CSS
fingerprint files + 3 stale JS files from `public/` via `hugo --gc`.

**Cycle D (iter 24–29)** — second SEO audit pass found 5 more real bugs
the metric didn't surface (because hugo_warnings doesn't check semantic
correctness, only template syntax). Each fix was committed locally:
- Iter 24: about page `og:image` was concatenating the unsplash URL
  onto Permalink (`https://backend.how/about/https://images.unsplash.com/…`).
  Removed the unsplash URL; site now uses fallback `og-image.png`.
  Also rewrote the bare "About Me" description into a real meta sentence.
- Iter 25: hardened `opengraph.html` to detect absolute URLs in
  `Params.images` and emit them as-is (defense in depth for iter 24).
- Iter 26: `twitter_cards.html` was using `RelPermalink` for `twitter:image`
  (Twitter wants absolute) and didn't handle absolute URLs in front matter.
  Same hardening applied. Also fixed `structured-data.html` image array.
- Iter 27: `<link rel="canonical">` and `AlternativeOutputFormats` (RSS)
  were emitting relative URLs. Google strongly prefers absolute canonical
  URLs to deduplicate properly. Switched to Permalink/absURL.
- Iter 28: Person schema was using site title ("Backend.how | How It Works")
  as the person's name. Now falls back to `author.name` ("Pratik") when
  schemaType=Person. Affects rich-result eligibility in Google.
- Iter 29: BreadcrumbList JSON-LD was using `http://schema.org` while
  Article used `https://schema.org` — normalized to https everywhere.

**Validation**: every JSON-LD block on every page parses as valid JSON
(verified with `python3 -c json.loads(...)`); every `og:image`,
`twitter:image`, and canonical URL is now absolute.

**Cycle E (iter 33–38)** — auxiliary outputs audit. Found 6 more issues
in RSS, sitemap, and config that no metric was watching:

- Iter 33: home was emitting `/amp/index.html` with regular HTML at it
  (zero `ampproject` script refs) — fake AMP that Google would reject.
  Removed `amp` from outputs. Also removed per-post RSS feeds (rarely
  consumed; section + home feeds remain).
- Iter 34: rewrote `layouts/_default/rss.xml` so feed channel titles
  read "Backend.how | How It Works" instead of Hugo's default
  "Home on How It Works". Per-item description uses front-matter
  `.Description` when set; falls back to `.Summary`.
- Iter 35: **major SEO bug** — `public/sitemap.xml` started with literal
  `&lt;?xml version=...?&gt;` (HTML-escaped XML declaration). Every
  XML parser rejects this — search engines could not parse the sitemap.
  Fix: wrap declaration in `printf | safeHTML` to bypass Go template
  escaping. Verified with Python ElementTree.
- Iter 36: my RSS template rewrite in iter 34 forgot the `<?xml ?>`
  declaration. Added with the same safeHTML pattern. All four XML
  endpoints (home, posts, per-tag, sitemap) now parse cleanly.
- Iter 37: `content/posts/_index.md` was missing a `description` —
  `/posts/` was falling back to site description. Added a section-
  specific one.
- Iter 38: normalized `hugo.toml` — was using capital `Description`
  inside `[params]`. Moved to lowercase at top level (so `site.Description`
  works) plus `[params]` (back-compat for templates that reference
  `site.Params.description` explicitly).

**Cycle F (iter 40–45)** — final-pass audit, found 5 more issues:

- Iter 40: validated 0 broken internal links across all built HTML
  via Python script that walks public/, builds the set of every
  reachable path, and checks every `href` against it. Validated all
  3 XML output endpoints parse via ElementTree. Validated CSS brace
  balance (364 opens vs 364 closes).
- Iter 41: added conditional DNS prefetch + preconnect for
  `cdn.jsdelivr.net` on math posts. KaTeX loads 3 separate files
  from jsdelivr — without prefetch, DNS lookup happens after head
  parse. Conditional gate via `Params.math` so non-math pages don't
  add unnecessary hints.
- Iter 42: removed duplicate `<meta charset>` and `<meta viewport>`
  tags. baseof.html emitted them at the very top of `<head>` and
  head.html partial emitted them again with slightly different syntax.
  Browsers honor the first only; second was noise. Now exactly 1
  charset + 1 viewport per page.
- Iter 43: added `rel="noopener noreferrer"` to two `target="_blank"`
  links that bypassed `ext_link.html` postprocessing — RSS feed icon
  in footer and Hacker News upvote link in `hacker-news-comments.html`.
  Without this, the new tab can use `window.opener` to redirect the
  original page (tabnabbing).
- Iter 44: fixed malformed `twitter:site` meta. hugo.toml had
  `twitterSite = "https://x.com/pratikgajjar_in"` and the template
  prepends `@`, so the output was `content="@https://x.com/...`.
  Twitter cards spec wants `@handle`. Fixed config to just the handle.
- Iter 45: extended deployment cache-control matcher to include WOFF
  and WOFF2 fonts (was matching only js/css/svg/ttf).

The cumulative effect of cycles A–F: 11 → 0 warnings (cycle A), real
SEO/social-preview/security/perf correctness verified via reading
templates + parsing emitted HTML/XML (cycles D–F). At no point did the
primary metric shift, yet **18 distinct semantic-correctness bugs were
fixed**. The floor-then-audit pattern keeps producing value because
`hugo_warnings` is too narrow.

**Stop condition**: metric at floor (cannot go below 0), all listed
quick-wins and medium-effort items either done or verified-already-done.
Remaining backlog is larger-feature work (Pagefind search, Giscus comments,
auto-generated OG images, JetBrains Mono → WOFF2/subset) — half-day+ each.
Also pruned items as deliberate theme decisions (no per-block language
label — the theme author chose copy-button-only) or
already-done-and-not-recognized (RSS per-tag feeds emitted by default,
markdown images get loading="lazy" via figure shortcode, dark/light
toggle via `initDarkModeToggle`, keyboard nav via `initKeyboardNav`).

**Local commits not pushed**: 35+ commits ahead of `origin/main` per
the user's "do not push for go-backend.how" rule. Includes the fdyno
draft session and these 22 site-fix iterations. User reviews and pushes
on their own schedule.

---

## Session 2026-05-06: fdyno blog draft (PAUSED at iter 13)

**Artifact**: `content/posts/fdyno-dynamodb-on-foundationdb/index.md`
(`draft: true`, 6,477 words, 995 lines, builds in 73 ms).

Drafted a TigerBeetle/Temporal-style post on building a DynamoDB-compatible
service on FoundationDB. Includes thesis pull-quote, FDB primer with
4-process diagram + MVCC timeline, fdyno layered architecture, keyspace
design, hot-path PutItem trace, ACID-across-everything write path, napkin
math, conformance story, performance numbers with CGO bottleneck, balanced
"What DynamoDB still does better" section, lessons, limitations, when to
use, closing tied to thesis, further reading, self-deprecating colophon.

13 iterations of tone calibration to user voice (humble, balanced, no
digs, "tradeoffs not flaws", positive energy). Saved
`feedback_writing_positive_no_digs.md` and `user_blog_voice_humble_balanced.md`
to memory.

---

# Autoresearch: TigerBeetle Bottleneck — CONCLUDED

## The answer

**LSM read amplification is the bottleneck.** Not CPU, not write bandwidth.

Each transfer triggers ~24 random 8 KB page reads through the LSM tree for
account balance lookups. As data grows, more LSM levels → more reads per lookup → lower throughput.

| DB state | DB size | RPS | Reads/transfer | CPU% |
|---|---|---|---|---|
| Fresh (1M transfers) | ~2 GB | 64K | 115 KB | 77% |
| Steady-state (10M) | ~20 GB | 46K | 195 KB | 85% |
| Large (12M+) | 33 GB | 27K | 195 KB | 67% |

## Why napkin math couldn't predict this

Sirupsen's write-bandwidth number (3 GiB/s SSD sequential) correctly ruled out
writes as the bottleneck (47K TPS uses only 142 MB/s writes = 11% of ceiling).

But predicting the actual TPS requires knowing:
1. LSM tree depth (depends on data volume)
2. Pages read per lookup (depends on level structure + bloom filters)
3. Random read latency under io_uring (depends on queue depth + SSD)

These are implementation-specific, not generic napkin-math numbers.

**Takeaway: napkin math is best at ruling things OUT (writes, fsync).
The final answer requires measuring.**

## Experiments run

| # | Description | RPS | Key finding |
|---|---|---|---|
| 1 | Baseline (dirty 33GB DB) | 27K | CPU=67%, reads=5 GB/s |
| 2 | Fresh DB, 1M transfers | 64K | CPU=77%, reads=7 GB/s |
| 3 | Batch size sweep 500-8190 | 23K-40K | Sub-linear: ~10ms/batch + ~24µs/transfer |
| 4 | 10M steady-state (definitive) | 46K | CPU=85%, reads=9 GB/s (1.95 TB total!) |
| 5 | Blog updated with conclusion | 46K | LSM read amp = bottleneck |

## Stop condition: MET

We can conclusively state:
1. **What the bottleneck is**: LSM read amplification (195 KB reads per 128 B transfer)
2. **Evidence**: disk read rate near SSD ceiling, throughput tracks DB size
3. **What relaxing it would do**: smaller DB / fewer levels → higher RPS (measured 64K→27K)

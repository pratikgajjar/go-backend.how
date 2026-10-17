# Autoresearch — Latest sessions

## Session 2026-05-06: Site bug-fixes & UX (CONCLUDED, 52 iterations across 8 cycles)

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

**Cycle G (iter 47–49)** — security headers + JS audit, found 3 more issues:

- Iter 47: `themes/coloroid/static/_headers` emitted **two** Content-Security-
  Policy headers. The first had `frame-ancestors 'none'` (no embedding
  at all); the second had `frame-ancestors 'self'`. Browsers take the
  intersection, so 'none' won — but `X-Frame-Options: SAMEORIGIN` on
  the same response said the opposite. Resolved: one CSP with
  `frame-ancestors 'self'` matching X-Frame-Options.
- Iter 48: tightened CSP by removing dead third-party permissions.
  Verified via grep that templates/content reference NONE of:
  `static.cloudflareinsights.com`, `cloudflareinsights.com`,
  `mirrors.creativecommons.org`. Site uses Plausible at
  `stats.backend.how` (covered by `*.backend.how`) and HN comments hit
  `hn.algolia.com`. CSP went from 7 third-party hosts to 4.
- Iter 49: `themes/coloroid/assets/js/hn-comments.js` emitted a
  `<a href=... target="_blank">` HN user-profile link with no
  `rel="noopener noreferrer"` (same tabnabbing concern as iter 43,
  but in the JS-emitted HTML rather than templates). Also wrapped
  `comment.author` in `encodeURIComponent` for the URL — defense in
  depth against any malformed username (HN usernames are restricted
  in practice but the safety has no cost).

**Cycle H (iter 51–52)** — final tail-end finds:

- Iter 51: `article:author` OG meta wasn't being emitted because the
  template only fired when `Site.Params.facebookAuthor` was set (Facebook
  profile URL). Site has no Facebook config. Now: falls back to
  `Site.Params.author.name` (Pratik) when facebook is unset, so article
  posts properly attribute their author. Verified: `article:author=Pratik`
  on every post page now.
- Iter 52: removed contradictory `defer async` on the dev-mode script
  tag in `js.html` (per HTML spec, `async` overrides `defer` when both
  are set, so the tag was effectively just `async`). Production was
  already `defer` only; now both modes match.

Also flagged as backlog (not fixed in this session because it needs a
graphics tool): the fallback `static/og-image.png` is 512×512, but
Facebook/Twitter `summary_large_image` cards expect 1200×630.

The cumulative effect of cycles A–H: 11 → 0 warnings (cycle A), real
SEO/social-preview/security/perf correctness verified via reading
templates + parsing emitted HTML/XML (cycles D–H). At no point did the
primary metric shift, yet **23 distinct semantic-correctness bugs were
fixed**. The floor-then-audit pattern keeps producing value because
`hugo_warnings` is too narrow.

**At iter 52, audit-friendly bug surface is genuinely depleted.** Further
productive work needs browser tooling (Lighthouse/axe-core/visual
regression) or larger features (Pagefind, Giscus comments, OG image
generation) — both are substantial new initiatives, not audit work.

---

## Session 2026-05-07: Lighthouse-driven perf + a11y (10 iterations)

**Metric**: `lh_perf` (higher better). Lighthouse run via `npx lighthouse`
against the production-built static site served by `python3 -m http.server :1313`.
Chrome path: `/Applications/Chromium.app/Contents/MacOS/Chromium`.
Headless desktop, screenEmulation disabled, performance + a11y +
best-practices + seo categories.

### Score trajectory across three pages

|                          | Home | Tiger Style | 1B Payments |
|---|---:|---:|---:|
| Iter 1 baseline          | 83 / 100 / 100 / 100 | 82 / 94 / 100 / 100  | 64 / 95 / 100 / 100  |
| Iter 2 woff2             | 89 / 100 / 100 / 100 | — | — |
| Iter 3 subset            | 91 / 100 / 100 / 100 | — | — |
| Iter 4-7 a11y            | (no perf change)     | 82 / 100 / 100 / 100 | 76 / 100 / 100 / 100 |
| Iter 9 italic subset     | 91 / 100 / 100 / 100 | 84 / 100 / 100 / 100 | 78 / 100 / 100 / 100 |
| Iter 11 lean themes      | 92 / 100 / 100 / 100 | 87 / 100 / 100 / 100 | 80 / 100 / 100 / 100 |
| Iter 12 unicode-range    | (reverted — net negative) |     |     |
| Iter 13 chroma split     | (reverted — extra request hurt posts) |  |  |
| Iter 14 async KaTeX CSS  | 92 / 100 / 100 / 100 | 87 / 100 / 100 / 100 | **81 / 100 / 100 / 100** |
| Iter 15 async main CSS   | (reverted — CLS=1, critical CSS too thin) | | |
| Iter 16 inline home CSS  | **92 / 100 / 100 / 100** (FCP -122 ms) | — | — |
| Iter 17 inline non-page  | **92** (FCP 779) | 87 | 81 |
| /posts/ list iter 17     | **93 / 100 / 100 / 100** (FCP 776) | | |
| /tags/ iter 17           | **93 / 100 / 100 / 100** (FCP 771) | | |
| Iter 18 inline ALL pages | (reverted — post HTML parse overhead) | | |
| Iter 19 fetchpriority    | (reverted — no measurable change) | | |
| Iter 20 narrower weight  | **93** (LCP 1651) | **88** (LCP 1951) | **81** (LCP 2402) |
| Iter 21 @font-face match | 93 (correctness fix, no perf delta) | 88 | 81 |
| Iter 22 drop TTF fallback | 93 (lean code, no perf delta) | 88 | 81 |
| Iter 23 tight font subset | **94** (LCP 1576) | 89 (LCP 1801) | 81 |
| Iter 24 archive a11y     | (perf unchanged) — /archive/ a11y 95 → **100** | | |
| Iter 25 italic preload   | 94 | **91** (FCP -300ms) | **86** (FCP -291ms, LCP -150ms) |
| Iter 26 KaTeX preload    | (reverted — bandwidth competition pushed 1b LCP +775ms) | | |

---

## Session 2026-05-07: Site-quality cycle (12 iterations)

After perf plateau at 94, switched metric from `lh_perf` to a composite
`defects` count (lower is better). Built a comprehensive defect detector
(`scripts/site-quality-check.py`) that scans 24 categories. Baseline 10
defects → final 5 (only the fdyno-draft orphan footnotes remain,
intentionally deferred to author's polish pass).

### Real bugs fixed beyond what the perf cycle caught

| iter | issue                                            | scope              |
|---:|---|---|
| 2  | Orphan footnote defs in published posts (4)       | content cleanup |
| 3  | OG image regenerated 1200×630 with branding       | social previews |
| 4  | RSS icon dimensions (CLS prevention)              | every page |
| 5  | External link rot (4 broken/redirected URLs)      | tiger, 1b, temporal |
| 6  | **Term pages were broken** — taxonomy.html was rendering the full tag cloud instead of post listings on /tags/postgres/ etc. | every tag page |
| 7  | Tag case collision (TigerBeetle/tigerbeetle)      | tag cloud |
| 8  | Stereogram heading skip (a11y) via h3→h2 promote (different from h1→h2 demote which regressed perf -8 in iter 32 of perf cycle) | stereogram post |
| 9  | Article schema empty `image: []` — fallback to OG image | every post without hero image |
| 10 | h1 hierarchy across 56 pages — site title `<h1>` was rendered on every page; `# Heading` in markdown was h1 too. Fixed via header.html `IsHome` branch + render-heading.html bumps level by 1 inside posts | every page |
| 11 | **CSS bug**: `scrollbar-width: thin` was floating outside any selector since the theme's inception. Hugo's minifier merged it with the `summary` rule, breaking summary's padding for years. Wrapped in `* { ... }`. Bonus: tiger 91→93, valkey-part-1 91→93, post-query-optimise 91→92 | global |
| 11 | Blockquote link contrast (light themes)           | valkey-part-1 |
| 11 | Mermaid edge-label contrast (auto-styled)         | valkey-part-2 |
| 12 | 404 page `.error-code` opacity 0.2 (a11y)         | 404 page |

### Detector dimensions tracked (24 categories)

orphan_footnote_def, orphan_footnote_ref, broken_anchor, img_no_alt,
img_no_dimensions, duplicate_id, json_ld_invalid, json_ld_missing_field,
missing_og_field, missing_twitter_field, broken_internal_href,
dangling_local_file, duplicate_title, empty_title, missing_canonical,
og_image_missing, og_image_aspect_ratio, sitemap_dead_url,
robots_disallow_all, term_page_no_posts, tag_case_collision,
md_heading_skip, no_h1, multiple_h1, external_link_broken (cached, opt-in).

### Final scores (cycle 2 conclusion)

All tested pages: **a11y 100**, bp 100, seo 100 (except 404 which is
intentionally noindex'd → seo 69).

| Page                                              | perf | a11y | bp | seo |
|---|---:|---:|---:|---:|
| `/` (home)                                        | **95** | 100 | 100 | 100 |
| `/about/`                                         | 94 | 100 | 100 | 100 |
| `/posts/` list                                    | 94 | 100 | 100 | 100 |
| `/tags/` cloud                                    | 94 | 100 | 100 | 100 |
| `/archive/`                                       | 93 | 100 | 100 | 100 |
| `/404.html`                                       | 94 | 100 | 100 | 69 (noindex, intentional) |
| `/posts/post-query-optimise/`                     | 92 | 100 | 100 | 100 |
| `/posts/the-tiger-style/`                         | 91 | 100 | 100 | 100 |
| `/posts/the-best-way-to-learn-backend-web-…/`     | 91 | 100 | 100 | 100 |
| `/posts/lost-ssh-access-to-ec2/`                  | 91 | 100 | 100 | 100 |
| `/posts/the-psychology-of-seeking-help/`          | 91 | 100 | 100 | 100 |
| `/posts/creating-content/`                        | 91 | 100 | 100 | 100 |
| `/posts/building-…-valkey-part-1/`                | 91 | 100 | 100 | 100 |
| `/posts/running-101/`                             | 90 | 100 | 100 | 100 |
| `/posts/system-design-tinder/`                    | 89 | 100 | 100 | 100 |
| `/posts/cat-stereogram-dark-mode/`                | 89 | 100 | 100 | 100 |
| `/posts/pre-owned-…-valkey-part-2/`               | 87 | 100 | 100 | 100 |
| `/posts/1b-payments-per-day/`                     | 85 | 100 | 100 | 100 |
| `/posts/temporal-under-the-hood/`                 | 81 | 100 | 100 | 100 |

Notable post bumps from this cycle:
- tiger-style: 91 → **93** (LCP 1801 → 1651 ms) — held since iter 11
- /about/: 92 → **94**
- valkey-part-1: 91 → 93
- post-query-optimise: 91 → 92
- home: 94 → **95** (cumulative effect of h1 cleanup + scrollbar CSS bug fix)

Lowest-perf posts (1b at 85, temporal at 81) are bound by KaTeX's
third-party CDN load and large article HTML — the deferred ideas in
autoresearch.ideas.md (self-host KaTeX, per-page critical CSS) would
help them.

---

## Session 2026-05-07: Site-quality cycle 3 (5 iterations)

After cycle 2 plateau, extended the detector with several new
dimensions and ran a final correctness/security pass.

### Iter-by-iter

| iter | scope                                                               | result |
|---:|---|---|
| 13 | **Metadata + RSS feed validation**                                    | added missing `lastmod` to system-design-tinder, post-query-optimise, content/archive.md; disabled empty `/tags/index.xml` and `/series/index.xml` (taxonomy parents). RSS validates clean (feedparser). Sitemap URLs all have `lastmod` |
| 14 | **Title length sanity**                                               | shortened `params.title` from "Backend.how \| How It Works" to "backend.how"; `seo.html` drops the suffix when post-title + suffix would exceed Google's 60-char SERP cutoff. 5 long titles → 1 (only valkey-part-1's 69-char post-title-alone) |
| 15 | **Browser-runtime checks**                                            | added two opt-in detector dimensions backed by puppeteer-core: `viewport_overflow` (4 widths × 20 pages = 80 combos), `js_console_error_or_404` (every page loaded headless and watched). Both came back zero |
| 16 | **CSP audit + URL consistency**                                       | switched hn-comments script from `Permalink` (absolute URL) to `RelPermalink` for consistency with main.js; removed `www.youtube.com` from `frame-src` (only `www.youtube-nocookie.com` is actually used) |
| 17 | **Security headers**                                                  | added X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geolocation/payment/usb (with interest-cohort opt-out for FLoC) |

### New detector dimensions added in cycle 3

(beyond cycle 2's 24 categories)

- **Static checks**: title_too_long (>75), missing_required_fm_field,
  missing_lastmod, date_in_future, lastmod_in_future,
  lastmod_before_date, rss_parse_error, rss_item_missing_field,
  rss_item_no_description, sitemap_url_no_lastmod,
  target_blank_no_noopener, inline_event_handler

- **Opt-in browser checks** (require `--check-runtime`):
  viewport_overflow, js_console_error_or_404

### Final state at cycle 3 conclusion

- **Defects**: 5 (all `orphan_footnote_def` in fdyno-dynamodb-on-foundationdb,
  which is `draft: true` — author's polish pass)
- **Pages tested**: 56+ across home, about, posts list, tags cloud, archive,
  taxonomy terms (33 of them), all 13 individual posts, 404
- **Lighthouse**: a11y 100 / bp 100 / seo 100 across all (except 404 which is
  intentionally noindex'd → seo 69 by Lighthouse, correct behavior per
  HTTP standard)
- **Browser**: 0 viewport overflow, 0 JS console errors, 0 4xx network
  responses
- **Feeds**: RSS root + 33 per-tag feeds parse cleanly via feedparser;
  all items have title/link/guid/description
- **Schemas**: Article + Person + BreadcrumbList valid + complete on
  every post; Article.image always non-empty (falls back to OG image)
- **Security**: CSP minimal+complete; HSTS / X-Frame-Options /
  X-Content-Type-Options / Referrer-Policy / Permissions-Policy all set

### Across all 3 cycles

- **Cycle 1** (perf, 34 iters): home 83 → **95**; tiger 82 → 91-93;
  1b 64 → 85; cumulative wire savings ~600 KB on first visit (font
  TTF→woff2 + subset; lean theme palettes; inline CSS on small pages;
  italic preload on posts).
- **Cycle 2** (site quality, 12 iters): defects 10 → 5; fixed term
  pages, h1 hierarchy across 56 pages, scrollbar CSS bug that had
  been silently breaking summary CSS, multi-page a11y to 100.
- **Cycle 3** (extended quality, 5 iters): metadata sanity, RSS feed
  validation, title length, browser-runtime sweeps, CSP cleanup,
  security headers.

**Total**: 51 iterations, 36 keeps, 15 discards. ~120 local commits
ahead of `origin/main`, all unpushed per project constraint
(go-backend.how is user-controlled push only).

### Final scores across all tested pages

| Page | perf | a11y | bp | seo | LCP (ms) | FCP (ms) |
|---|---:|---:|---:|---:|---:|---:|
| `/` (home)                                    | **94** | 100 | 100 | 100 | 1576 | 777 |
| `/about/`                                     | **94** | 100 | 100 | 100 | 1576 | 774 |
| `/posts/` (list)                              | **94** | 100 | 100 | 100 | 1576 | 776 |
| `/tags/` (cloud)                              | **94** | 100 | 100 | 100 | 1576 | 770 |
| `/archive/`                                   | **93** | 100 | 100 | 100 | 1651 | 773 |
| `/posts/the-tiger-style/`                     | **91** | 100 | 100 | 100 | 1801 | 907 |
| `/posts/1b-payments-per-day/`                 | **85** | 100 | 100 | 100 | 2251 | 1212 |
| `/posts/post-query-optimise/`                 | **92** | 100 | 100 | 100 | 1727 | 902 |
| `/posts/lost-ssh-access-to-ec2/`              | **91** | 100 | 100 | 100 | 1801 | 906 |
| `/posts/temporal-under-the-hood/`             | **81** | 100 | 100 | 100 | 2401 | 1513 |
| `/posts/cat-stereogram-dark-mode/`            | **89** | 98  | 100 | 100 | 2026 | 906 |

(scores are run-to-run noisy by ±1; LCP is mostly reproducible to ±75ms.
Stereogram a11y is at 98 because the post has a `# H1 → ### H3` jump
that, when fixed, regressed perf by 8 points (image LCP candidate
rebalance) — the original heading structure preserves the better
trade-off.)

(scores: perf / a11y / best-practices / seo)

**LCP progression on home**: 2927 ms → 2026 ms (woff2) → 1802 ms (subset)
→ 1727 ms (lean themes). 41% improvement on LCP.

**FCP progression on navigation pages**: 906 ms → 779 ms (inline CSS on
non-page kinds). 14% improvement on FCP.

### Real fixes from this cycle

1. **JBM TTF → WOFF2** (iter 2). 303 KB → 113 KB. Lighthouse perf 83 → 89.
2. **JBM subset to Latin + box-drawing + arrows + math** (iter 3).
   113 KB → 76 KB. perf 89 → 91.
3. **Heading order on post pages** (iter 4). The TOC, Series, and Related
   used `<h4>` inside an article that started with `<h1>`, skipping h2/h3.
   Changed to `<nav aria-labelledby="...">` + `<h2>` with CSS adjusted to
   keep the small visual size. a11y 94 → 96 → 100.
4. **Color contrast a11y wins** (iter 4 + 7). `.copy-btn` was using a
   46%-lightness color on a dark code-block bg. `.share-links span` was
   opacity 0.5. `.related-post .read-time` was 0.5. `.keyboard-hint` was
   0.35. `.last-updated` was 0.6. All bumped to ≥0.75/0.85 for WCAG AA.
5. **Heading-skip fix** (iter 7). `1b-payments` had `### The archival
   pipeline` directly under `# Hot/Warm/Cold Tiering`. Changed h3 → h2.
6. **Table headers** (iter 7). `<table>` elements had `<thead>` + `<th>`
   but axe-core `td-headers-attr` audit wants explicit `scope="col"` on
   each `<th>` in large tables. Added a postprocessor in `ext_link.html`
   that rewrites `<th>` → `<th scope="col">` (carefully not matching
   `<thead>`).
7. **Italic font subset** (iter 9). Italic only ever wraps `<em>` text
   which is ASCII + 3 non-ASCII chars across all posts. Was using the
   wide subset (82 KB); cut down to ASCII + Latin-1 + Latin-Ext-A +
   smart quotes (52 KB). Tiger-style perf 81 → 84.
8. **Lean theme palettes** (iter 11). The 51 `body.theme-X { --vars }`
   rules in main.css were ~10 KB of dead bytes for any single page
   (each page only ever uses ONE theme). Extracted to
   `data/themes.yaml`; baseof.html inlines only the active theme's vars.
   main.css 34 KB → 25 KB minified; home perf 91 → 92, LCP -150 ms;
   tiger 84 → 87; 1b 78 → 80.
9. **Async KaTeX stylesheet** (iter 14). KaTeX CSS was render-blocking
   on math posts. Set `media="print"`, then `katex-init.js` flips it to
   `"all"` on DOMContentLoaded right before `renderMathInElement` runs.
   The CSS is applied in time for math paint without blocking FCP.
   `<noscript>` fallback ensures a JS-less viewer still gets math
   styled. 1b-payments perf 80 → 81, FCP 1652 → 1501 ms (-150 ms),
   LCP 2552 → 2401 ms (-150 ms).
10. **Inline main.css on non-page kinds** (iter 16-17). Home, /about/,
    /posts/, /tags/, /archive/, taxonomy pages — all have small HTML
    (8-20 KB) and benefit from removing the render-blocking external
    CSS request. Inline ~25 KB of minified CSS in `<head>`; total HTML
    stays 30-45 KB (compresses to ~10-15 KB on Cloudflare). Individual
    posts (Kind=page) keep `<link rel="stylesheet">` because their HTML
    is already big and adding 25 KB inline hurts parse time. Result:
    home perf 91 → 92, FCP 906 → 784 ms; /posts/ list and /tags/
    reached 93. Verified on iter 18 that pushing this to all pages
    regresses post LCP (HTML parse overhead exceeds saved request).
11. **Narrow JBM weight axis to 400-700** (iter 20-21). The JBM
    variable font supported weights 100-900 but the design system
    only uses 400/500/600/700. Used `fontTools.varLib.instancer.
    instantiateVariableFont` to drop the 100-300 and 800-900 ranges.
    Regular: 76 → 57 KB (-25%); Italic: 52 → 38 KB (-27%). LCP gains
    across the board: home 1727 → 1651 ms; tiger 2102 → 1951 ms; 1b
    2552 → 2402 ms. Updated `@font-face font-weight` to match the new
    range (correctness — was advertising weights the file no longer
    contains).
12. **Drop TTF fallback** (iter 22). woff2 has been universally
    supported since Chrome 36 / Firefox 39 / Safari 12. Removed the
    `format("truetype-variations")` fallback and deleted the 600 KB
    of TTF source files from `static/`. Same scores, leaner repo.
13. **Content-driven tight font subset** (iter 23). Site uses 164
    unique non-emoji chars across all rendered HTML/XML — vastly less
    than the 3500-codepoint subset I had been baking. Built a
    content-driven subset (full Basic Latin + Latin-1 + dashes/quotes
    + box-drawing + curated UI glyphs). Regular: 57 → 35 KB (-39%);
    Italic: 38 → 34 KB. Result: home 93 → 94 (LCP 1651 → 1576 ms);
    tiger 88 → 89 (LCP 1951 → 1801 ms). Added `scripts/regen-fonts.py`
    to re-run the subset when new content adds chars; the script
    restores TTF source from git history, scans `public/` for char
    usage, and writes new woff2 files. Future content with chars
    outside the subset will fall back to system mono on those specific
    glyphs (graceful degradation, not a build error).

### Probes that didn't move the metric

- **font-display: optional** (iter 6). No score change because the font
  is preloaded. Reverted to `swap`.
- **Unicode-range JBM split into common + extended subsets** (iter 12,
  discarded). Two woff2 files (49 + 33 KB) outweighed monolithic 76 KB
  on pages that legitimately need both ranges (any page with µs, ↻,
  box-drawing, etc.). Home gained +1 but tiger lost 3 and 1b lost 4.
  Reverted.
- **Per-route CSS split — extract Chroma to chroma.css** (iter 13,
  discarded). Saved 5 KB on home but added ~150 ms FCP to posts via
  the extra round-trip. On Cloudflare HTTP/2 the extra request would
  be cheaper, but on the localhost test harness the split was net
  negative. Reverted.
- **Async-load main.css with media swap** (iter 15, discarded). FCP
  dropped 285 ms on home — proof the pattern works — but CLS=1
  catastrophically broke perf because the hand-written 2 KB critical
  CSS missed `.featured-post`/`.article-content`/`.toc` etc., causing
  full-page reflow when main.css applied. Pattern is sound but
  requires automated critical-CSS extraction (`critters`/`critical`).
- **Inline main.css on ALL pages including posts** (iter 18, discarded).
  Home/list pages stayed at 92-93 but tiger 87→85 and 1b 81→80
  because the 25 KB inline CSS added enough HTML parse time on the
  already-large post bodies (38 KB and 100 KB) to push LCP back 150 ms.
  Reverted to the iter-17 split.

### Key insight

Lighthouse penalties on this site come from two stacked sources:
1. **Render-blocking CSS** (~25 KB main.css fetch) — addressed by
   inlining on small pages (iter 16-17).
2. **Font load gating LCP** — `font-display: swap` paints with system
   mono first (FCP ~900 ms), then re-paints when JBM arrives. Cutting
   font bytes (woff2 + subset, iter 2-3, 9) directly cuts LCP.

The home page reached **perf=92, FCP 779 ms, LCP 1727 ms**, all
a11y/bp/seo at 100. /posts/, /tags/, and other navigation pages reached
perf=93. Individual post pages are at 87 (tiger) and 81 (1b-payments).

The next likely big lever is **automated critical-CSS extraction** so
post pages can also use the async-CSS pattern without CLS. Recorded in
autoresearch.ideas.md as a future tooling-required experiment.

**Cumulative gains across this Lighthouse cycle**:
- Home: 78 (dev) → 83 (prod baseline) → **94** (current). LCP 2927 → 1576 ms (-46%). FCP 906 → 776 ms.
- /posts/ list, /tags/, /about/: **94**.
- /archive/: 92-93.
- Tiger Style: 82 → **91**. LCP 2401 → 1801 ms (-25%). FCP 1509 → 902 ms (-40%).
- 1B-payments: 64 → **86**. LCP 3879 → 2101 ms (-46%). FCP 2656 → 1212 ms (-54%).
- a11y: 95-100 across pages → **100** across all pages.

**Total wire savings on the home page** (vs initial baseline):
- JBM regular: 303 KB TTF → 35 KB woff2 (-88%)
- JBM italic: 309 KB TTF → 34 KB woff2 (-89%)
- main.css: 34 KB external → inlined in HTML (-1 round-trip)
- Theme palettes: 10 KB CSS dead-code removed
- TTF fallback fonts: 600 KB total deleted from repo

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

# backend.how — Improvement Ideas

Living backlog. Items get crossed off as they're done; stale claims get pruned.

Last reviewed: **2026-05-07** (two cycles: 34-iter lh_perf optimization, then 8-iter site-quality optimization).

## ✅ Site quality fixes from cycle 2 (defect count 10 → 5)

- ✅ **Orphan footnote defs in published posts** — removed 4 dead `[^N]:` defs from 1b-payments and temporal that were silently dropped by Goldmark
- ✅ **OG image regenerated at 1200×630** — was a generic 512×512 DNA-helix; now branded for backend.how with the site's typography and theme color
- ✅ **External link rot fixes** — github.com/coilhq/tigerbeetle (×2, org migrated), npci.org.in/what-we-do/upi (URL restructure), github.com/mariozechner/pi (was github.com/badlogic/pi-mono)
- ✅ **RSS icon dimensions** — added width=32 height=32 to /rss.svg img in footer (CLS prevention)
- ✅ **Term pages were broken** — /tags/postgres/ etc. were showing the full tag cloud instead of posts under the term, because Hugo's lookup was using taxonomy.html for both Kind=taxonomy and Kind=term. Extended taxonomy.html with a Kind branch.
- ✅ **Tag case collision** — tiger-style used 'TigerBeetle'/'System Design'/'Repost' (Title Case) while 1b-payments used lowercase kebab-case; both slugified to same URLs but rendered differently per post. Normalized to lowercase kebab-case.
- ✅ **Heading skip in stereogram post** — `# How to View` → `### Relax` was an h1→h3 skip. Earlier perf-cycle attempt fixed via h1 demote (regressed perf -8). This iter promoted h3s to h2s instead — same a11y win, no perf regression.

## Site-quality detector dimensions (currently checking)
Stored at /tmp/site-quality-check.py. Categories scanned:

- orphan_footnote_def, orphan_footnote_ref
- broken_anchor (in-page #fragment)
- img_no_alt, img_no_dimensions
- duplicate_id (same id="" on multiple elements)
- json_ld_invalid, json_ld_missing_field (Article/Person/BreadcrumbList required fields)
- missing_og_field, missing_twitter_field
- broken_internal_href, dangling_local_file
- duplicate_title, empty_title, missing_canonical
- og_image_missing, og_image_aspect_ratio
- sitemap_dead_url, robots_disallow_all
- term_page_no_posts, tag_case_collision
- md_heading_skip
- external_link_broken (cached, opt-in via --check-external)

## ⚡ Perf optimizations attempted in this cycle

- ✅ **WOFF2 conversion** (iter 2). 303 KB TTF → 113 KB WOFF2. perf 83 → 89.
- ✅ **JBM Latin subset** (iter 3). 113 → 76 KB. perf 89 → 91.
- ✅ **Italic subset** (iter 9). 82 → 52 KB. tiger 81 → 84.
- ✅ **Lean theme palettes** (iter 11). Extracted 51 theme color rules to data/themes.yaml; baseof inlines only the active theme. main.css 34 → 25 KB. home 91 → 92, tiger 84 → 87, 1b 78 → 80.
- ❌ **font-display: optional** (iter 6). No movement; reverted.
- ❌ **Inline all CSS** (probe). No measurable score change; reverted (saves no real bytes — main.css still required for posts and inline duplicates per page request).
- ❌ **Unicode-range JBM split** (iter 12). Two woff2 files (49+33 KB) outweighed monolithic 76 KB on pages that need both. Net negative on posts. Reverted.

## ⚡ Perf optimizations not yet tried

- **Per-page critical CSS** — auto-extract above-fold rules per
  individual post URL (use `critters` or `critical`). The hand-written
  5 KB critical bundle in iter 28 was a wash because 1b's huge HTML
  (100 KB) made any extra inlined CSS hurt parse time more than it
  saved on the round-trip. A per-page critical CSS limited to ONLY the
  rules that page actually uses would tip the balance back positive.
- **font-display: fallback** — 100 ms swap window then fallback locks
  in. Could eliminate LCP swap on slow networks but penalize first-time
  visitors.
- **HTTP/2 server push from Cloudflare** — deployment-side; not
  measurable in localhost test. Should help LCP when fonts can be
  pushed alongside HTML.
- **103 Early Hints** — Cloudflare Workers feature; deployment-side.
- **Self-host KaTeX** — eliminate cdn.jsdelivr.net cross-origin
  handshake. Self-hosting also lets us add `font-display: swap` to
  KaTeX @font-face declarations (currently `font-display: block` per
  Lighthouse `font-display-insight`). Would help 1b's LCP.
- **Per-page font subset** — currently the JBM woff2 covers chars used
  across the whole site. Per-page subsets (only chars used on that
  specific HTML) would shrink the font further but require running the
  subsetter as part of the build and emitting per-page font URLs.
- **Regenerate `og-image.png` at 1200×630** — current is 512×512
  (graphics-tool work).

---

## ✅ Done in last autoresearch session

- **Hugo 0.148+ deprecations** — `markup.goldmark.renderHooks.{image,link}.enableDefault` → `useEmbedded = "never"`
- **OG image broken absolute URLs** — `opengraph.html` now uses `.Permalink` for `og:image`, `og:see_also`, `og:video`
- **JSON-LD invalid + relative URLs** — `structured-data.html` Article `@id` is absolute, image array is properly quoted JSON
- **Dishonest SearchAction schema** — `siteLinksSearchBox = false`
- **Empty tags on cat-stereogram-dark-mode**
- **Stale public/ assets** — `hugo --gc` cleans orphans now
- **Raw HTML omitted warning** — replaced inline `<p>` caption with markdown italics in 1b-payments post
- **JetBrains Mono preload** — added to head.html for faster initial paint
- **Series prev/next navigation** — single.html renders an ordered list of all posts in a series with the current one marked as "(you are here)"; verified on Valkey Part 1 + Part 2
- **Print-friendly CSS** — `@media print` stylesheet hides chrome, resets to white-on-black, shows external link URLs inline, keeps headings/tables/code blocks together across page breaks
- **Image lightbox** — vanilla-JS click-to-zoom for any `.article-content img`. ESC, ×, or click-outside to close. Body scroll locked while open
- **Build is clean** — 0 warnings/deprecations from `hugo --logLevel debug` (was 11)
- **Homepage featured cards** — now show description + tags + read-time + date; was bare title + date
- **Tag cloud with post counts** — `/tags/` is now a real tag cloud sized by post frequency in 4 tiers (xl/lg/md/sm), not a list of tag-summary headings
- **View Transitions API** — smooth same-origin page fades on Chromium browsers, respects `prefers-reduced-motion`

## ✅ Already in the theme (verified — were stale claims)

- Copy button on code blocks — `themes/coloroid/assets/js/main.js`
- Reading progress bar — `initProgressBar()` already wired
- Back-to-top button — `initBackToTop()` already wired
- Custom 404 page — `layouts/404.html` exists
- Last-updated badge — `single.html` checks `.Lastmod.After .Date`
- Navigation menu — `[[menus.main]]` entries in hugo.toml
- DNS prefetch + preconnect for `stats.backend.how` — already in head.html
- Departure Mono preload — already in head.html
- `privacy.x.*` — already migrated from `privacy.twitter.*`

---

## 🔧 Medium Effort — All done

The medium-effort tier is now empty. The remaining items in the original
backlog were all already implemented in the theme:

- ~~Active TOC highlighting~~ — IntersectionObserver in `main.js` (`initTOCHighlight`); CSS class `.toc-active` styled
- ~~Image lightbox/zoom~~ — added in iter 14 of this session
- ~~Post descriptions on list page~~ — `list.html` already uses `{{ with .Description }}<p class="post-description">...</p>{{ end }}`; verified 13 render on `/posts/`
- ~~Related posts section~~ — `single.html` uses `.Site.RegularPages.Related | first 3`
- ~~Social sharing buttons~~ — `single.html` has X, LinkedIn, copy-link
- ~~Footnote back-links~~ — Goldmark default emits `class="footnote-backref"` with bidirectional refs (multi-reference support too)
- ~~Series linking~~ — added in iter 11 of this session
- ~~Print-friendly CSS~~ — added in iter 12 of this session

---

## 🏗️ Larger Features (Half day+)

- **Client-side search** — Pagefind (~15 KB) or Fuse.js
- **Comments via Giscus** — GitHub Discussions-backed
- **Auto-generated OG images** — per-post via Hugo `images.Text` (or one-shot via Playwright/Puppeteer pipeline)
- **View counter** — pull from Plausible API
- **Webmention support** — IndieWeb integration

### ✅ Verified already in theme (were stale claims)

- ~~Dark/light mode toggle~~ — `initDarkModeToggle()` + `#theme-toggle` button in header
- ~~Keyboard navigation~~ — `initKeyboardNav()` handles `j`/`k` for next/prev post
- ~~RSS per-tag feeds~~ — Hugo emits them by default; verified `/tags/temporal/index.xml`, etc.

---

## 🎨 Design/UX Polish

- **Gradient/pattern header per theme** — subtle visual differentiation

### ✅ Done in this session

- ~~Homepage featured posts~~ — now show description + tags + read-time per card
- ~~Tag cloud with post counts~~ — added in iter 19 of this session
- ~~Smooth page transitions~~ — added in iter 20 of this session

### Pruned (deliberate theme decision or already adequate)

- ~~Mobile hamburger menu~~ — flexbox + flex-wrap on `.nav-menu` already handles narrow viewports gracefully (4 menu items wrap to 2 lines max)
- ~~Code block language label~~ — `initCodeLabels` is intentionally a no-op (theme author chose copy-button-only as sufficient)

---

## 📊 SEO & Performance (most fixed; remaining items)

- **Add HowTo structured data** to step-by-step tutorial posts (e.g., Lost SSH Access). Article schema is already present; HowTo would unlock Google's "How To" rich result.
- **`fetchpriority="high"`** on hero/above-fold images — currently a no-op for fonts (browser already prioritizes font preloads); per-post hero images would benefit but most posts have no hero image.

### Pruned (done or verified already adequate)

- ~~Resize fallback OG image~~ — done in iter 3 of site-quality cycle
- ~~Optimize font loading~~ — done in iter 2/3/9/20/23 of perf cycle
- ~~Add FAQ structured data~~ — most "Q&A" posts on this site are tutorials, not strict FAQs. HowTo schema is a better fit (see below).
- ~~Lazy load below-fold images~~ — figure shortcode emits `loading="lazy"`; markdown content rarely uses raw `<img>`

---

## 📝 Content Gaps

- ~~"Temporal Under the Hood"~~ **shipped 2026-04-05**
- ~~"1B Payments/Day"~~ **shipped 2026-04-05**
- ~~"fdyno — DynamoDB on FoundationDB"~~ **drafted 2026-05-06** (still `draft: true`, 13 iters of polish)
- About page is fairly generic — could link to specific achievements, projects, talks
- No `/uses/` or `/now/` page (common in dev blogs)

---

## 🔬 Follow-up Research

### From Temporal post
- **Retry cost measurement** — extra queries from one failed+retried workflow
- **Temporal replay cost** — force replay by killing worker; measure extra `history_node` SELECTs
- **Postgres WAL throughput** — bytes/sec for both Temporal and Absurd
- **Absurd at larger scale** — current ceiling at ~1,450 task/s; with connection pooling + HOT updates, where does it go?
- **Comparison with DBOS / Inngest** — same workload, their Postgres schemas
- **Signal/event latency** — Temporal signals vs Absurd events
- **Napkin-math workflow calculator** — interactive form, storage/IOPS estimates per system

### From fdyno post
- **Multi-node FDB benchmark** — current numbers are single-node memory engine; need 3-node SSD on real network
- **CGO crossing reduction** — pipelined transactions, batched ops, or a Go client wrapper that minimizes round-trips
- **Property-based stateful testing** — random op sequences against fdyno + DynamoDB Local, compare at every step
- **TTL background scanner + CDC GC** — operational gaps for production-shaped use
- **Fdyno vs Scylla Alternator** — both implement DynamoDB on different engines; would round out the "DynamoDB on X" landscape

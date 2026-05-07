# backend.how — Improvement Ideas

Living backlog. Items get crossed off as they're done; stale claims get pruned.

Last reviewed: **2026-05-06** (autoresearch session, 20 iterations: bug-fixes + perf + UX).

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

- **Add FAQ structured data** — for posts like "Lost SSH Access" that answer specific questions
- **Optimize font loading** — subset JetBrains Mono to latin-only, convert TTF → WOFF2 (would need `pyftsubset` or similar; ~7-8× payload reduction expected)
- **`fetchpriority="high"`** on hero/above-fold images
- **Resize fallback OG image** — `static/og-image.png` is 512×512 (square). Facebook/LinkedIn/Twitter `summary_large_image` cards expect 1200×630 (1.91:1). The square gets cropped/shown smaller in social previews. Needs a graphics tool to regenerate; ideally with the site's theme color (`#100f0f`) and "Backend.how" branding.

### Pruned (verified already adequate)

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

# backend.how — Improvement Ideas

Living backlog. Items get crossed off as they're done; stale claims get pruned.

Last reviewed: **2026-05-06** (autoresearch session, 9 iterations: bug-fixes + perf hint).

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
- **Build is clean** — 0 warnings/deprecations from `hugo --logLevel debug` (was 11)

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

## 🔧 Medium Effort (1–3 hours each)

- **Related posts section** — 2–3 related posts at article bottom based on shared tags
- **Series linking** — Valkey Part 1 & 2 should auto-link via prev/next series navigation
- **Active TOC highlighting** — IntersectionObserver to highlight current section
- **Image lightbox/zoom** — click to enlarge images in articles
- **Social sharing buttons** — X, LinkedIn, copy-link
- **Print-friendly CSS** — `@media print` stylesheet
- **Footnote back-links** — bidirectional linking
- **Post descriptions on list page** — show `.Description` under each post title in `/posts/`

---

## 🏗️ Larger Features (Half day+)

- **Client-side search** — Pagefind (~15 KB) or Fuse.js
- **Dark/light mode toggle** — themes are there, just need a button + localStorage
- **Comments via Giscus** — GitHub Discussions-backed
- **Auto-generated OG images** — per-post via Hugo `images.Text`
- **RSS per-tag feeds** — `/tags/system-design/index.xml`
- **Keyboard navigation** — `j`/`k`, `/` to focus search
- **View counter** — pull from Plausible API
- **Webmention support** — IndieWeb integration

---

## 🎨 Design/UX Polish

- **Homepage featured posts** — current layout is bare; add post descriptions, tags, card layout
- **Tag cloud with post counts** — show post counts per tag on `/tags/`
- **Gradient/pattern header per theme** — subtle visual differentiation
- **Mobile hamburger menu** — for narrow viewports
- **Smooth page transitions** — View Transitions API for same-origin nav
- **Code block language label** — "go", "sql", "python" in top-right of code blocks

---

## 📊 SEO & Performance (most fixed; remaining items)

- **Add FAQ structured data** — for posts like "Lost SSH Access" that answer specific questions
- **Optimize font loading** — subset JetBrains Mono to latin-only, convert TTF → WOFF2
- **`fetchpriority="high"`** on hero/above-fold images
- **Lazy load below-fold images** — markdown images may not be lazy yet (figure shortcode is)

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

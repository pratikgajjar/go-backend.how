# backend.how — Improvement Ideas

Living backlog. Items get crossed off as they're done; stale claims get pruned.

Last reviewed: **2026-05-06** (autoresearch session, 8 iterations of bug-fixes).

---

## 🐛 Bugs & Issues

### Done in this session
- ✅ **Hugo 0.148+ deprecations** — `markup.goldmark.renderHooks.{image,link}.enableDefault` → `useEmbedded = "never"` (was emitting 8 INFO-level deprecation messages per build)
- ✅ **OG image broken absolute URLs** — `opengraph.html` was using `.RelPermalink` for `og:image`, `og:see_also`, `og:video`. Switched to `.Permalink` / `absURL`. Verified: social previews now embed `https://backend.how/...` URLs
- ✅ **JSON-LD invalid + relative URLs** — `structured-data.html` was emitting `"image": [https://.../foo.webp]` (UNQUOTED url because of `safeJS`) — invalid JSON. Also Article `@id` was relative. Both fixed; image array now properly quoted and absolute
- ✅ **Dishonest SearchAction schema** — `siteLinksSearchBox = true` was emitting a SearchAction with `urlTemplate=/tags/{q}/` but that endpoint doesn't accept queries. Set to `false`
- ✅ **Empty tags on cat-stereogram-dark-mode** — added `["stereograms", "vision", "dark-mode", "focus"]`
- ✅ **Stale public/ assets** — `rm -rf public/ resources/ && hugo --gc` removed 11 leftover `particles.min.*.js` fingerprints (gitignored, just local clutter)
- ✅ **Raw HTML omitted warning** — `1b-payments-per-day` had a centered `<p style="...">` caption under the cluster diagram. Replaced with markdown italics. Build now emits **0 warnings/deprecations**

### Stale (verified — these claims no longer apply)
- ~~Theme conflict `lilac` used by About + "Psychology of Seeking Help"~~ — neither uses lilac anymore
- ~~`privacy.twitter.*` deprecation~~ — already migrated to `privacy.x.*` in hugo.toml
- ~~No navigation menu in hugo.toml~~ — `[[menus.main]]` entries exist for posts, archive, tags, about
- ~~Lost SSH Access has empty tags~~ — verified, tags exist

---

## ⚡ Quick Wins (≤30 min each)

- **Copy button on code blocks** — JS snippet + small CSS, big UX win for a technical blog
- **Reading progress bar** — thin bar at top of article pages showing scroll progress
- **Back-to-top button** — appears after scrolling, smooth scroll back
- **Font preloading** — `<link rel="preload">` for DepartureMono + JetBrains Mono woff2
- **dns-prefetch/preconnect** for `stats.backend.how` (Plausible analytics)

---

## 🔧 Medium Effort (1–3 hours each)

- **Related posts section** — 2–3 related posts at article bottom based on shared tags
- **Series linking** — Valkey Part 1 & 2 should auto-link via prev/next series navigation (Hugo has built-in series taxonomy)
- **Active TOC highlighting** — highlight current section in TOC as user scrolls (IntersectionObserver)
- **"Last updated" badge** — show `Updated: <date>` when `lastmod` differs from `date`
- **Image lightbox/zoom** — click to enlarge images in articles (especially diagrams)
- **Social sharing buttons** — X, LinkedIn, copy-link for each post
- **Print-friendly CSS** — `@media print` stylesheet for clean article printing
- **Footnote back-links** — improve footnote UX with bidirectional linking
- **Post descriptions on list page** — show `.Description` under each post title in `/posts/`

---

## 🏗️ Larger Features (Half day+)

- **Client-side search** — Pagefind (static, ~15 KB) or Fuse.js for instant search
- **Dark/light mode toggle** — themes are already there, just need a button + localStorage
- **Comments via Giscus** — GitHub Discussions-backed comments
- **Auto-generated OG images** — per-post social preview images with title + theme color (Hugo `images.Text`)
- **RSS per-tag feeds** — `/tags/system-design/index.xml`
- **Keyboard navigation** — `j`/`k` for next/prev post, `/` to focus search
- **View counter** — pull from Plausible API and display on posts
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

## 📊 SEO & Performance (most fixed, remaining)

- **Add FAQ structured data** — for posts like "Lost SSH Access" that answer specific questions
- **Optimize font loading** — subset JetBrains Mono to latin-only, ensure WOFF2
- **`fetchpriority="high"`** on hero/above-fold images
- **Lazy load below-fold images** — markdown images may not be lazy yet (figure shortcode is)

---

## 📝 Content Gaps

- ~~"Temporal Under the Hood" draft~~ **done 2026-04-05**
- ~~"1B Payments/Day" 🚧 in-progress~~ **shipped 2026-04-05**
- ~~"fdyno — DynamoDB on FoundationDB" draft~~ **drafted 2026-05-06** (still `draft: true`, 13 iters of polish)
- About page is fairly generic — could link to specific achievements, projects, talks
- No `/uses/` or `/now/` page

---

## 🔬 Follow-up Research

### From Temporal post
- **Retry cost measurement** — how many extra queries does one failed+retried workflow cost?
- **Temporal replay cost** — force replay by killing worker mid-execution; measure extra `history_node` SELECTs
- **Postgres WAL throughput** — WAL bytes/sec for both Temporal and Absurd
- **Absurd at larger scale** — current ceiling at ~1,450 task/s; with connection pooling + HOT updates, where does it go?
- **Comparison with DBOS / Inngest** — same workload, their Postgres schemas
- **Signal/event latency** — Temporal signals vs Absurd events, race-freeness mechanisms
- **Napkin-math workflow calculator** — interactive form, storage/IOPS estimates per system

### From fdyno post (NEW)
- **Multi-node FDB benchmark** — current numbers are single-node memory engine; need 3-node SSD on real network
- **CGO crossing reduction** — pipelined transactions, batched ops, or sketch a Go client wrapper that minimizes round-trips
- **Property-based stateful testing** — random op sequences against fdyno + DynamoDB Local, compare at every step
- **TTL background scanner + CDC GC** — operational gaps for production-shaped use
- **Fdyno vs Scylla Alternator** — both implement DynamoDB on different engines, would round out the "DynamoDB on X" landscape

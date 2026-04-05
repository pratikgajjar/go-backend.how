# backend.how — Improvement Ideas

Full audit of the Hugo blogging site. Organized by priority and effort.

---

## 🐛 Bugs & Issues (Fix First)

- **Theme conflict**: `lilac` used by both About page AND "Psychology of Seeking Help" post — one needs a different theme
- **Hugo deprecation warnings**: `privacy.twitter.enableDNT` and `privacy.twitter.simple` → should be `privacy.x.enableDNT` and `privacy.x.simple` (deprecated since Hugo v0.141.0)
- **OG URL uses relURL**: `opengraph.html` uses `.RelPermalink` instead of `.Permalink` for `og:url` — Facebook/Twitter will get broken URLs
- **Structured data image URLs are relative**: `structured-data.html` builds image URLs as `{{ $.RelPermalink }}{{ $e }}` — Google wants absolute URLs
- **SearchAction without search**: `siteLinksSearchBox = true` emits a SearchAction schema but there's no actual search on the site — misleading to Google
- **No navigation menu**: `hugo.toml` has no `[menus]` section — the nav menu partial renders nothing
- **Missing tags**: "Psychology of Seeking Help" and "Lost SSH Access" have empty `tags = []`
- **Stale public/ assets**: ~12 old fingerprinted `particles.min.*.js` files in `public/` — should be cleaned on build

---

## ⚡ Quick Wins (High Impact, ≤30 min each)

- **Copy button on code blocks** — JS snippet + small CSS, huge UX for technical blog
- **Reading progress bar** — thin bar at top of article pages showing scroll progress
- **Back-to-top button** — appears after scrolling down, smooth scroll back
- **Custom 404 page** — `layouts/404.html` with a themed "page not found" message
- **Add nav menu items** — add `[[menus.main]]` entries in `hugo.toml` for Posts, About, Tags, RSS
- **Fix privacy.twitter → privacy.x** — 2-line config change to silence Hugo warnings
- **Font preloading** — add `<link rel="preload">` for DepartureMono and JetBrains Mono woff2
- **dns-prefetch/preconnect** for `stats.backend.how` (Plausible analytics)

---

## 🔧 Medium Effort (1-3 hours each)

- **Related posts section** — show 2-3 related posts at article bottom based on shared tags
- **Series linking for multi-part posts** — Valkey Part 1 & 2 should auto-link to each other with prev/next series navigation (Hugo has built-in series taxonomy)
- **Post archive page** — `/archive/` showing all posts grouped by year
- **Active TOC highlighting** — highlight current section in table of contents as user scrolls (IntersectionObserver)
- **"Last updated" badge** — show "Updated: date" when `lastmod` differs from `date`
- **Image lightbox/zoom** — click to enlarge images in articles (especially diagrams)
- **Social sharing buttons** — Twitter/X, LinkedIn, copy-link for each post
- **Print-friendly CSS** — `@media print` stylesheet for clean article printing
- **Footnote back-links** — improve footnote UX with bidirectional linking
- **Post descriptions on list page** — show `.Description` under each post title in `/posts/`

---

## 🏗️ Larger Features (Half day+)

- **Client-side search** — Pagefind (static search, ~15KB) or Fuse.js for instant search across posts
- **Dark/light mode toggle** — already have dark default + light themes; add a toggle button that persists preference in localStorage
- **Comments via Giscus** — GitHub Discussions-backed comments (beyond HN comments which only work for HN-linked posts)
- **Auto-generated OG images** — per-post social preview images with title + theme color (Hugo can do this with images.Text)
- **Newsletter/email subscription** — Buttondown or similar, with a signup form in footer or post bottom
- **RSS per-tag feeds** — so readers can subscribe to specific topics (e.g., `/tags/system-design/index.xml`)
- **Keyboard navigation** — `j`/`k` for next/prev post, `/` to focus search
- **View counter** — pull from Plausible API and display on posts (already have Plausible analytics)
- **Webmention support** — receive and display webmentions for IndieWeb integration

---

## 🎨 Design/UX Polish

- **Homepage featured posts** — current layout is bare; add post descriptions, tags, or card-style layout
- **Tag cloud with post counts** — show how many posts per tag on `/tags/`
- **Gradient or pattern header per theme** — subtle visual differentiation beyond just background color
- **Mobile hamburger menu** — for when nav menu items are added
- **Smooth page transitions** — View Transitions API for same-origin navigation
- **Code block language label** — show "go", "sql", "python" etc. in top-right corner of code blocks

---

## 📊 SEO & Performance

- **Fix og:url to absolute URL** — change `.RelPermalink` to `.Permalink` in opengraph.html
- **Fix structured data images** — use absolute URLs (`site.BaseURL + path`)
- **Remove bogus SearchAction** — or implement actual search and point to it
- **Add FAQ structured data** — for posts like "Lost SSH Access" that answer specific questions
- **Optimize font loading** — subset JetBrains Mono to latin-only, convert TTF to WOFF2
- **Add `fetchpriority="high"`** to hero/above-fold images
- **Lazy load below-fold images** — already done for figure shortcode; ensure markdown images also lazy load
- **Cache busting strategy** — clean old fingerprinted assets from public/ on build

---

## 📝 Content Gaps

- "Temporal Under the Hood" is a draft with empty description — finish or remove
- "1B Payments/Day" marked as 🚧 in-progress
- About page is fairly generic — could link to specific achievements, projects, or talks
- No `/uses/` or `/now/` page (common in dev blogs)
- No contributors page content beyond Pratik's empty `_index.md`

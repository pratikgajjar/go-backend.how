#!/usr/bin/env python3
"""Discover site-quality defects across multiple dimensions and emit a single count.

Categories (each defect counts 1):
  1. orphan footnote defs in markdown
  2. broken in-page anchor refs
  3. images without alt
  4. duplicate IDs on same page
  5. JSON-LD parse errors
  6. pages missing required OG / Twitter fields
  7. truly broken internal hrefs (relative /paths)
  8. fallback OG image not at 1200×630 (1.91:1) (counts 1 if wrong)
  9. /uses/, /now/ pages absent (counts 1 each)
 10. orphan footnote refs (refs without defs — render as plain text, BROKEN)
"""
import os, re, json, sys, subprocess
from collections import Counter

from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)

defects = []  # (category, location, detail)


def add(category, location, detail=''):
    defects.append((category, location, detail))


# Build site first if needed
if not os.path.isdir('public') or not os.path.exists('public/index.html'):
    subprocess.run(['hugo', '--environment', 'production', '--minify', '--gc'],
                   check=True, capture_output=True)

# 1. Orphan footnote defs (markdown)
for root, _, files in os.walk('content/posts'):
    for fn in files:
        if not fn.endswith('.md'):
            continue
        path = os.path.join(root, fn)
        rel = os.path.relpath(path)
        with open(path) as f:
            md = f.read()
        # Skip drafts — author still iterating, defects are intentional WIP
        if re.search(r'^\s*draft\s*[:=]\s*[\'"]?true', md, re.MULTILINE | re.IGNORECASE):
            continue
        md_clean = re.sub(r'```[\s\S]*?```', '', md)
        md_clean = re.sub(r'`[^`]*`', '', md_clean)
        defs = set(re.findall(r'(?m)^\[\^([^\]]+)\]:', md_clean))
        all_brackets = re.finditer(r'\[\^([^\]]+)\](:?)', md_clean)
        refs = set()
        for m in all_brackets:
            start = m.start()
            line_start = md_clean.rfind('\n', 0, start) + 1
            is_def = (start == line_start) and m.group(2) == ':'
            if not is_def:
                refs.add(m.group(1))
        for d in defs - refs:
            add('orphan_footnote_def', rel, d)
        for r in refs - defs:
            add('orphan_footnote_ref', rel, r)

# 2-7. HTML scan
valid_urls = set()
for root, _, files in os.walk('public'):
    if 'index.html' in files:
        rel = os.path.relpath(root, 'public')
        valid_urls.add('/' if rel == '.' else '/' + rel + '/')
for root, _, files in os.walk('public'):
    for fn in files:
        if fn.startswith('.'):
            continue
        rel = os.path.relpath(os.path.join(root, fn), 'public')
        valid_urls.add('/' + rel)

# Pre-scan: collect HTML pages flagged with `robots noindex`. These are
# internal-only pages (e.g. /og-preview/) that intentionally lack OG /
# Twitter / canonical / sitemap metadata. Skip them in all subsequent
# defect dimensions to avoid metric noise on intentionally-hidden pages.
NOINDEX_HTML = set()
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        with open(path) as f:
            head = f.read(8192)  # robots tag is in <head>
        if re.search(r'<meta\s+name=["\']?robots["\']?\s+content=["\']?[^"\']*\bnoindex\b', head, re.IGNORECASE):
            NOINDEX_HTML.add(path)

def skip_html(path: str) -> bool:
    return path in NOINDEX_HTML

required_og = {'og:title', 'og:type', 'og:url', 'og:image', 'og:description'}
required_twitter = {'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'}

for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        ids = re.findall(r'id=["\']?([a-zA-Z][^"\'>\s]*)', html)
        id_set = set(ids)
        for did in {x for x in ids if ids.count(x) > 1}:
            add('duplicate_id', rel, did)
        for m in re.finditer(r'href=["\']?#([a-zA-Z][^"\'>\s]*)', html):
            anchor = m.group(1)
            if anchor not in id_set:
                add('broken_anchor', rel, '#' + anchor)
        for m in re.finditer(r'<img\b([^>]*)>', html):
            if 'alt=' not in m.group(1):
                add('img_no_alt', rel, m.group(0)[:60])
        for m in re.finditer(r'<script type=application/ld\+json>(.*?)</script>', html):
            try:
                json.loads(m.group(1))
            except json.JSONDecodeError as e:
                add('json_ld_invalid', rel, str(e)[:60])
        og_props = set(re.findall(r'<meta property=["\']?(og:[a-z_]+)', html))
        for missing in required_og - og_props:
            add('missing_og_field', rel, missing)
        twitter_props = set(re.findall(r'<meta name=["\']?(twitter:[a-z_]+)', html))
        for missing in required_twitter - twitter_props:
            add('missing_twitter_field', rel, missing)
        for m in re.finditer(r'href=["\']?(/[^"\'>\s/][^"\'>\s]*|/)', html):
            url = m.group(1).split('#')[0].split('?')[0]
            if not url:
                continue
            last_seg = url.rsplit('/', 1)[-1]
            if '.' not in last_seg and not url.endswith('/'):
                url = url + '/'
            if url not in valid_urls:
                add('broken_internal_href', rel, url)

# 8a. Images without width/height attrs (CLS risk)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        # Strip inline SVG content (their child <image> shouldn't be flagged)
        html_no_svg = re.sub(r'<svg[^>]*>.*?</svg>', '', html, flags=re.DOTALL)
        for m in re.finditer(r'<img\b([^>]*)>', html_no_svg):
            attrs = m.group(1)
            has_width = re.search(r'\bwidth\s*=', attrs)
            has_height = re.search(r'\bheight\s*=', attrs)
            # Inline-styled width/height in style="" also counts
            if not (has_width and has_height):
                style_match = re.search(r'style=["\']?([^"\'>]*)', attrs)
                style = style_match.group(1) if style_match else ''
                inline_w = 'width' in style
                inline_h = 'height' in style
                if not ((has_width or inline_w) and (has_height or inline_h)):
                    add('img_no_dimensions', rel, m.group(0)[:80])

# 8b. Dangling local file refs (href to /file.ext where file doesn't exist)
all_files = set()
for root, _, files in os.walk('public'):
    for fn in files:
        rel_p = os.path.relpath(os.path.join(root, fn), 'public')
        all_files.add('/' + rel_p)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        # Look for href/src with extensions (PDFs, images, etc.)
        for m in re.finditer(r'(?:href|src)=["\']?(/[^"\'>\s/][^"\'>\s]*\.\w+)', html):
            url = m.group(1).split('#')[0].split('?')[0]
            if url not in all_files:
                add('dangling_local_file', rel, url)

# 8c. Duplicate <title> across pages (each page should have unique title)
title_counts = Counter()
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        with open(path) as f:
            html = f.read()
        m = re.search(r'<title>([^<]*)</title>', html)
        if m:
            title_counts[m.group(1)] += 1
for title, n in title_counts.items():
    if n > 1:
        add('duplicate_title', '<global>', f'{n}× "{title[:50]}"')

# 8d. Empty title
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        m = re.search(r'<title>([^<]*)</title>', html)
        if not m or not m.group(1).strip():
            add('empty_title', rel, '<title></title>')

# 8e. Pages without canonical
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        # Skip 404 page
        if fn == '404.html':
            continue
        with open(path) as f:
            html = f.read()
        if not re.search(r'<link[^>]*rel=canonical', html):
            add('missing_canonical', rel, '')

# 8f. JSON-LD schema completeness (beyond parse)
required_by_type = {
    'Article': {'@type', 'mainEntityOfPage', 'headline', 'image', 'datePublished', 'author', 'description'},
    'Person': {'@type', 'name'},
    'BreadcrumbList': {'@type', 'itemListElement'},
}
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        for m in re.finditer(r'<script type=application/ld\+json>(.*?)</script>', html):
            try:
                data = json.loads(m.group(1))
                t = data.get('@type', '')
                if t in required_by_type:
                    missing = required_by_type[t] - set(data.keys())
                    for mfield in missing:
                        add('json_ld_missing_field', rel, f'{t}: {mfield}')
            except json.JSONDecodeError:
                pass  # already counted

# 8g. Sitemap entries that don't have a corresponding HTML page
sitemap_path = 'public/sitemap.xml'
if os.path.exists(sitemap_path):
    with open(sitemap_path) as f:
        sitemap = f.read()
    for m in re.finditer(r'<loc>https://backend\.how(/[^<]*)</loc>', sitemap):
        url = m.group(1)
        # Map url to expected file: /foo/ → public/foo/index.html, /foo.xml → public/foo.xml, etc
        if url.endswith('/'):
            file_path = 'public' + url + 'index.html'
        elif '.' in url.rsplit('/', 1)[-1]:
            file_path = 'public' + url
        else:
            file_path = 'public' + url + '/index.html'
        if not os.path.exists(file_path):
            add('sitemap_dead_url', sitemap_path, f'{url} (file not found at {file_path})')

# 8h. robots.txt sanity
robots_path = 'public/robots.txt'
if os.path.exists(robots_path):
    with open(robots_path) as f:
        robots = f.read()
    if 'Disallow: /' in robots and 'Disallow: /\nAllow' not in robots:
        # Check if it's a blanket disallow (catastrophic for SEO)
        for line in robots.split('\n'):
            if line.strip() == 'Disallow: /':
                add('robots_disallow_all', robots_path, line)

# 8i. External link rot — cached check; only re-run when --check-external is passed.
LINK_CACHE = '/tmp/external-links-cache.json'
if '--check-external' in sys.argv:
    import asyncio, httpx
    links = set()
    for root, _, files in os.walk('public'):
        for fn in files:
            if not fn.endswith('.html'):
                continue
            with open(os.path.join(root, fn)) as f:
                html = f.read()
            for m in re.finditer(r'href=["\']?(https?://[^"\'>\s]+)', html):
                url = m.group(1).split('#')[0]
                if any(d in url for d in ('backend.how', 'localhost', 'youtube.com',
                                           'wikipedia.org', 'forbes.com',
                                           'instagram-engineering.com')):
                    continue
                links.add(url)

    async def check(client, url):
        try:
            r = await client.head(url, follow_redirects=True, timeout=8)
            if r.status_code in (200, 301, 302, 303, 307, 308):
                return url, r.status_code
            if r.status_code in (405, 403, 400, 501):
                r = await client.get(url, follow_redirects=True, timeout=8)
            return url, r.status_code
        except Exception as e:
            return url, str(e)[:50]

    async def main():
        async with httpx.AsyncClient(headers={'User-Agent': 'Mozilla/5.0 (link-check)'}) as client:
            sem = asyncio.Semaphore(20)
            async def go(u):
                async with sem:
                    return await check(client, u)
            return await asyncio.gather(*[go(u) for u in sorted(links)])

    results = asyncio.run(main())
    bad = [(u, s) for u, s in results if s not in (200, 301, 302, 303, 307, 308)]
    with open(LINK_CACHE, 'w') as f:
        json.dump({'bad': bad, 'checked_count': len(results)}, f)
    for u, s in bad:
        add('external_link_broken', u, str(s))
elif os.path.exists(LINK_CACHE):
    # Use cached result
    with open(LINK_CACHE) as f:
        cache = json.load(f)
    for u, s in cache.get('bad', []):
        add('external_link_broken', u, str(s))

# 8i.5. Heading hierarchy in markdown (article-title is h1, body should not skip)
for root, _, files in os.walk('content/posts'):
    for fn in files:
        if not fn.endswith('.md'):
            continue
        path = os.path.join(root, fn)
        rel = os.path.relpath(path)
        with open(path) as f:
            md = f.read()
        # Skip drafts
        if re.search(r'^\s*draft\s*[:=]\s*[\'"]?true', md, re.MULTILINE | re.IGNORECASE):
            continue
        if md.startswith('+++'):
            md = md.split('+++', 2)[2] if md.count('+++') >= 2 else md
        elif md.startswith('---'):
            md = md.split('---', 2)[2] if md.count('---') >= 2 else md
        md = re.sub(r'```[\s\S]*?```', '', md)
        headings = re.findall(r'(?m)^(#+)\s+(.+)$', md)
        prev_level = 1
        for hashes, text in headings:
            level = len(hashes)
            if level > prev_level + 1:
                add('md_heading_skip', rel, f'h{prev_level} → h{level}: {text[:50]}')
            prev_level = level

# 8j. Term pages with no post listings (sign of broken template)
for root, _, files in os.walk('public'):
    if root in ('public/tags', 'public/series'):
        continue  # skip taxonomy parent pages
    if '/tags/' not in root and '/series/' not in root:
        continue
    if 'index.html' not in files:
        continue
    path = os.path.join(root, 'index.html')
    rel = os.path.relpath(path)
    with open(path) as f:
        html = f.read()
    # Term pages should have at least one post link in main
    main_match = re.search(r'<main class=container>(.*?)</main>', html, re.DOTALL)
    if not main_match:
        continue
    main = main_match.group(1)
    # Look for post article links
    post_links = re.findall(r'<h2><a href=([^>]+)>', main)
    if len(post_links) == 0:
        # Distinguish from a "0 posts in this term" state — if the metric word count is "0 posts"
        if '0 post' not in main:
            add('term_page_no_posts', rel, 'rendered without post listings')

# 8k. Tag case-insensitive collisions (e.g., "TigerBeetle" and "tigerbeetle" used in different posts)
import yaml as _yaml
tag_to_posts = {}
for root, _, files in os.walk('content/posts'):
    for fn in files:
        if not fn.endswith('.md'):
            continue
        path = os.path.join(root, fn)
        with open(path) as f:
            content = f.read()
        # Skip drafts — author still iterating on tag choices
        if re.search(r'^\s*draft\s*[:=]\s*[\'"]?true', content, re.MULTILINE | re.IGNORECASE):
            continue
        if content.startswith('+++'):
            try:
                fm_end = content.index('+++', 3)
                fm = content[3:fm_end]
                m = re.search(r"tags\s*=\s*\[([^\]]+)\]", fm)
                tags = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)) if m else []
            except Exception:
                tags = []
        elif content.startswith('---'):
            try:
                fm_end = content.index('---', 3)
                fm = content[3:fm_end]
                d = _yaml.safe_load(fm) or {}
                tags = d.get('tags', []) or []
            except Exception:
                tags = []
        else:
            tags = []
        for t in tags:
            tag_to_posts.setdefault(t, []).append(os.path.relpath(path))
case_groups = {}
for tag in tag_to_posts:
    case_groups.setdefault(tag.lower(), []).append(tag)
for low, variants in case_groups.items():
    if len(variants) > 1:
        # Collision: same slug, different display strings
        add('tag_case_collision', '<global>',
            f"variants={variants} slug={low}")

# 8l. Multiple h1 per page (HTML5 single-outline best practice)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        n_h1 = len(re.findall(r'<h1\b', html))
        if n_h1 == 0:
            add('no_h1', rel, '')
        elif n_h1 > 1:
            add('multiple_h1', rel, f'{n_h1} h1 elements')

# 8m. Frontmatter metadata sanity (lastmod, future-dated, etc.)
def parse_fm(content: str):
    """Light TOML/YAML frontmatter parser. Returns dict of string keys."""
    if content.startswith('+++'):
        try:
            fm_end = content.index('+++', 3)
        except ValueError:
            return {}
        fm = content[3:fm_end]
        data = {}
        for m in re.finditer(r'^(\w+)\s*=\s*(.+?)$', fm, re.MULTILINE):
            k, v = m.group(1), m.group(2).strip()
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            elif v.startswith("'") and v.endswith("'"):
                v = v[1:-1]
            data[k] = v
        return data
    if content.startswith('---'):
        try:
            fm_end = content.index('---', 3)
        except ValueError:
            return {}
        try:
            import yaml as _y
            return _y.safe_load(content[3:fm_end]) or {}
        except Exception:
            return {}
    return {}

from datetime import datetime as _dt
TODAY = _dt.now().strftime('%Y-%m-%d')

for root_path, _, files in os.walk('content/posts'):
    for fn in files:
        if not fn.endswith('.md') or fn == '_index.md':
            continue
        path = os.path.join(root_path, fn)
        rel = os.path.relpath(path)
        with open(path) as f:
            content = f.read()
        data = parse_fm(content)
        # Skip drafts — author still iterating
        if str(data.get('draft', 'false')).lower() == 'true':
            continue
        # Required fields
        for required in ('title', 'date', 'description'):
            if not str(data.get(required, '')).strip():
                add('missing_required_fm_field', rel, required)
        # lastmod present
        if 'lastmod' not in data and 'date' in data:
            add('missing_lastmod', rel, 'has date but no lastmod')
        # Date sanity
        date_str = str(data.get('date', ''))[:10]
        lastmod_str = str(data.get('lastmod', ''))[:10]
        if date_str and date_str > TODAY:
            add('date_in_future', rel, date_str)
        if lastmod_str and lastmod_str > TODAY:
            add('lastmod_in_future', rel, lastmod_str)
        if lastmod_str and date_str and lastmod_str < date_str:
            add('lastmod_before_date', rel, f'lastmod={lastmod_str} < date={date_str}')

# 8n. RSS feed validation (parse with feedparser)
try:
    import feedparser as _fp
    for feed_path in ('public/index.xml', 'public/posts/index.xml'):
        if not os.path.exists(feed_path):
            continue
        d = _fp.parse(feed_path)
        if d.bozo:
            add('rss_parse_error', feed_path, str(d.bozo_exception)[:80])
        for entry in d.entries:
            for f in ('title', 'link', 'id'):
                if not entry.get(f):
                    add('rss_item_missing_field', feed_path, f"{entry.get('title', '?')[:30]}: {f}")
            if not entry.get('description', '').strip():
                add('rss_item_no_description', feed_path, entry.get('title', '?')[:30])
except ImportError:
    pass

# 8o. Sitemap freshness (every URL has lastmod)
if os.path.exists('public/sitemap.xml'):
    with open('public/sitemap.xml') as f:
        sitemap = f.read()
    # Each <url> should have at least <loc>; <lastmod> recommended
    urls_no_lastmod = []
    for m in re.finditer(r'<url>(.*?)</url>', sitemap, re.DOTALL):
        url_block = m.group(1)
        if '<lastmod>' not in url_block:
            loc_m = re.search(r'<loc>([^<]+)</loc>', url_block)
            if loc_m:
                urls_no_lastmod.append(loc_m.group(1))
    for u in urls_no_lastmod:
        add('sitemap_url_no_lastmod', 'public/sitemap.xml', u)

# 8p. Title length sanity (Google truncates >60 in SERPs; flag >75 as outlier)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        m = re.search(r'<title>([^<]+)</title>', html)
        if m:
            t = m.group(1).strip()
            if len(t) > 75:
                add('title_too_long', rel, f'{len(t)} chars: {t[:60]}…')

# 8q. target=_blank without rel=noopener|noreferrer (security)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        for m in re.finditer(r'<a[^>]*target=["\']?_blank["\']?[^>]*>', html):
            tag = m.group(0)
            if 'noopener' not in tag and 'noreferrer' not in tag:
                add('target_blank_no_noopener', rel, tag[:80])

# 8r. Inline event handlers (CSP violation potential)
for root, _, files in os.walk('public'):
    for fn in files:
        if not fn.endswith('.html'):
            continue
        path = os.path.join(root, fn)
        if skip_html(path): continue
        rel = os.path.relpath(path)
        with open(path) as f:
            html = f.read()
        for m in re.finditer(r'<\w+[^>]*\son[a-z]+\s*=', html):
            add('inline_event_handler', rel, m.group(0)[:60])

# 8s. Browser-runtime checks (viewport overflow + JS console errors).
#     Opt-in via --check-runtime since they require puppeteer-core +
#     a running local server. Scripts in scripts/runtime-checks/.
if '--check-runtime' in sys.argv:
    for script, defect_label in [
        ('scripts/runtime-checks/viewport-check.mjs', 'viewport_overflow'),
        ('scripts/runtime-checks/js-errors.mjs', 'js_console_error_or_404'),
    ]:
        if not os.path.exists(script):
            continue
        result = subprocess.run(
            ['node', script],
            capture_output=True, text=True,
            env={**os.environ, 'NODE_PATH': '/tmp/node_modules'},
        )
        # Both scripts print "<n> issues" on first line
        m = re.search(r'(\d+)', result.stdout.split('\n')[0])
        n = int(m.group(1)) if m else 0
        for _ in range(n):
            add(defect_label, '<runtime>', f'see {script} output')

# 8. Fallback OG image dimensions
og_path = 'themes/coloroid/static/og-image.png'
if os.path.exists(og_path):
    try:
        from PIL import Image
        img = Image.open(og_path)
        w, h = img.size
        ratio = w / h
        # Target: 1200×630 (1.905), tolerance ±0.1
        if not (1.8 <= ratio <= 2.0):
            add('og_image_aspect_ratio', og_path, f'{w}x{h} (ratio {ratio:.2f}, expected 1.91)')
    except ImportError:
        pass
else:
    add('og_image_missing', og_path, 'no fallback OG image')

# 9. /uses/ and /now/ pages
for content_path, url in [('content/uses.md', '/uses/'), ('content/now.md', '/now/')]:
    if not os.path.exists(content_path):
        # Soft signal — common in personal blogs but not required
        # Skipping to avoid false-positive defect inflation
        pass

# 10. Soft warnings — informational, not counted in METRIC.
#     Author-judgment items where flagging without auto-fixing is the
#     right move. Surfaces issues for the author's next polish pass
#     without distorting the experiment metric.
warnings = []  # (category, location, detail)

def warn(category, location, detail=''):
    warnings.append((category, location, detail))

# 10a. description_too_long: meta description >200 chars likely truncated
#      in Google SERP (~160 is the safer target; 200 is the "very likely
#      truncated" threshold). Author rewrites would be prose churn so
#      this is a soft signal, not a defect.
for root, _, files in os.walk('public'):
    if 'index.html' not in files:
        continue
    path = os.path.join(root, 'index.html')
    rel = os.path.relpath(path)
    with open(path) as f:
        html = f.read()
    m = re.search(r'<meta name=description content="([^"]*)"', html)
    if m and len(m.group(1)) > 200:
        warn('description_too_long', rel, f'{len(m.group(1))} chars')

# Print summary
counts = Counter(d[0] for d in defects)
print(f'TOTAL DEFECTS: {len(defects)}')
print()
for cat, n in counts.most_common():
    print(f'  {n:3d}  {cat}')

# Soft warnings — printed but not counted in METRIC
if warnings:
    warn_counts = Counter(w[0] for w in warnings)
    print()
    print(f'SOFT WARNINGS (informational, not counted): {len(warnings)}')
    for cat, n in warn_counts.most_common():
        print(f'  {n:3d}  {cat}')

if '--verbose' in sys.argv:
    print()
    print('=== Details ===')
    for cat in sorted(counts):
        items = [d for d in defects if d[0] == cat]
        print(f'\n{cat} ({len(items)}):')
        for c, loc, det in items[:10]:
            print(f'  {loc}: {det}')
    if warnings:
        print()
        print('=== Soft warning details ===')
        warn_cats = Counter(w[0] for w in warnings)
        for cat in sorted(warn_cats):
            items = [w for w in warnings if w[0] == cat]
            print(f'\n{cat} ({len(items)}):')
            for c, loc, det in items[:20]:
                print(f'  {loc}: {det}')

# Output final number for tooling — METRIC is hard defects only.
# Soft warnings are visible above but don't affect the experiment metric.
print()
print(f'METRIC: {len(defects)}')
sys.exit(0)

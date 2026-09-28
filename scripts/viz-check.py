#!/usr/bin/env python3
"""Build the site and check one post's interactive figures in headless Chromium.

Usage:
  uv run --quiet --with playwright scripts/viz-check.py <post-slug> [--no-build] [--dark]

Builds drafts too, into /tmp/gbh-viz/<slug>/ (separate cache per slug, so
parallel runs do not collide), serves it on a free port, then for a 390px
phone and a 1280px desktop viewport it reports:

  - figures on the page vs figures that mounted (class wv-live)
  - console errors and page errors
  - horizontal overflow (document wider than the viewport)

and saves one screenshot per figure to /tmp/gbh-viz/<slug>/shots/.
Exit code 1 if anything failed.
"""

import functools
import http.server
import shutil
import socketserver
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium"
VIEWPORTS = [("phone", 390, 844), ("desktop", 1280, 900)]


def house_style(slug: str) -> bool:
    """Flag per-post CSS that overrides the shared look. Returns True on failure."""
    import re
    bad = False
    css = ROOT / "themes/coloroid/assets/css/viz" / f"{slug}.css"
    rules = [
        (r"^\s*--[\w-]+\s*:", "defines a CSS variable (use the shared tokens)"),
        (r"font-family\s*:", "sets font-family"),
        (r"box-shadow\s*:", "sets box-shadow"),
        (r"(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\()", "hard-codes a colour"),
    ]
    if css.exists():
        for n, line in enumerate(css.read_text().splitlines(), 1):
            for pat, why in rules:
                if re.search(pat, line):
                    print(f"  STYLE: {css.name}:{n} {why}: {line.strip()[:90]}")
                    bad = True
    md = ROOT / "content/posts" / slug / "index.md"
    if md.exists() and 'frame="none"' in md.read_text():
        print('  STYLE: index.md uses frame="none"; the house frame is always on')
        bad = True
    return bad


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__)
        return 2
    slug = args[0]
    work = Path("/tmp/gbh-viz") / slug
    out, shots = work / "out", work / "shots"

    if "--no-build" not in sys.argv:
        shutil.rmtree(out, ignore_errors=True)
        r = subprocess.run(
            ["hugo", "--quiet", "-D", "--destination", str(out), "--cacheDir", str(work / "cache"),
             "--baseURL", "/"],
            cwd=ROOT, capture_output=True, text=True,
            env={**__import__("os").environ, "HUGO_RESOURCEDIR": str(work / "resources")},
        )
        if r.returncode:
            print("hugo build failed:\n" + r.stderr[-3000:])
            return 1
    page_path = out / "posts" / slug / "index.html"
    if not page_path.exists():
        print(f"no page at {page_path}")
        return 1

    failed = house_style(slug)

    shutil.rmtree(shots, ignore_errors=True)
    shots.mkdir(parents=True)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=str(out))
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/posts/{slug}/"

    schemes = ["light", "dark"] if "--dark" in sys.argv else ["light"]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROMIUM)
        for scheme in schemes:
            for name, w, hgt in VIEWPORTS:
                pg = browser.new_page(viewport={"width": w, "height": hgt}, device_scale_factor=2,
                                      color_scheme=scheme)
                errors = []
                pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
                pg.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
                pg.goto(url, wait_until="networkidle")
                if scheme == "dark":
                    pg.evaluate("document.documentElement.setAttribute('data-force-dark', '')")
                pg.wait_for_timeout(600)
                total = pg.locator("figure.wv, figure.viz").count()
                live = pg.locator("figure.wv.wv-live, figure.viz.wv-live").count()
                sw = pg.evaluate("document.documentElement.scrollWidth")
                tag = f"{name}-{scheme}"
                print(f"[{tag}] figures {live}/{total} mounted, scrollWidth {sw}px (viewport {w}px)")
                if live < total:
                    failed = True
                    print(f"  FAIL: {total - live} figure(s) did not mount")
                if sw > w + 1:
                    failed = True
                    wide = pg.evaluate(
                        f"[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > {w} + 1)"
                        ".slice(0, 5).map(e => e.tagName.toLowerCase() + '.' + [...e.classList].join('.'))")
                    print(f"  FAIL: horizontal overflow; widest elements: {wide}")
                for e in errors[:10]:
                    failed = True
                    print(f"  FAIL: {e}")
                figs = pg.locator("figure.wv, figure.viz")
                for i in range(total):
                    f = figs.nth(i)
                    f.scroll_into_view_if_needed()
                    kind = f.get_attribute("data-viz") or f.get_attribute("data-wv") or "fig"
                    f.screenshot(path=str(shots / f"{i + 1:02d}-{kind}-{tag}.png"))
                pg.close()
        browser.close()
    srv.shutdown()
    print(f"screenshots: {shots}")
    print("FAILED" if failed else "OK")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml"]
# ///
"""Render a post's hand-written og.svg to its social card PNG.

  .agents/skills/og-image/render.py <slug> [--check]
  .agents/skills/og-image/render.py site [--check]

Reads content/posts/<slug>/og.svg (1200x630), injects the post's theme
colours and the figure tokens as CSS variables, embeds JetBrains Mono, and
screenshots it at 2x with Chromium. Writes og-<hash>.png next to the post,
deletes the old og-*.png files, and points `images` in the front matter at
the new file. --check renders to /tmp only and prints the path.
`site` renders themes/coloroid/og-image.svg (the homepage theme) to
themes/coloroid/static/og-image.png, the default card for non-post pages.
"""
import base64
import hashlib
import re
import sys
import tempfile
from pathlib import Path

import yaml
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium"
FONT = ROOT / "themes/coloroid/static/fonts/jetbrains/JetBrainsMono[wght].woff2"

# Figure tokens from themes/coloroid/assets/css/walviz.css (light).
TOKENS = """
  --board: oklch(98.6% 0.004 100); --ink: oklch(16% 0.012 260);
  --mute: oklch(40% 0.012 260); --line: oklch(80% 0.01 260);
  --tint: oklch(95.6% 0.005 100); --tint2: oklch(91.5% 0.006 100);
  --blue: oklch(46% 0.16 258);   --blue-l: oklch(93% 0.04 258);
  --brown: oklch(42% 0.075 55);  --brown-l: oklch(92.5% 0.035 70);
  --purple: oklch(45% 0.2 305);  --purple-l: oklch(91.5% 0.06 305);
  --orange: oklch(56% 0.17 45);  --orange-l: oklch(92% 0.07 65);
  --green: oklch(45% 0.13 152);  --green-l: oklch(91% 0.075 152);
  --red: oklch(51% 0.2 27);      --red-l: oklch(92.5% 0.05 25);
"""


def front_matter(text: str) -> tuple[str, str]:
    m = re.match(r"(\+\+\+|---)\n(.*?)\n\1\n", text, re.S)
    if not m:
        sys.exit("no front matter")
    return m.group(1), m.group(2)


def theme_vars(fm: str) -> str:
    m = re.search(r"""^theme\s*[=:]\s*["']?([\w-]+)""", fm, re.M)
    themes = yaml.safe_load((ROOT / "data/themes.yaml").read_text())
    vals = themes.get(m.group(1), {}) if m else {}
    if not vals:  # site default (dark) has no entry; use a neutral light page
        vals = {"--article-bg": "oklch(93% 0.01 260)", "--article-text": "oklch(20% 0.01 260)",
                "--color-link": "oklch(42% 0.1 260)"}
    return "".join(f"{k}: {v};" for k, v in vals.items())


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    slug, check = sys.argv[1], "--check" in sys.argv
    site = slug == "site"
    post = ROOT / "content/posts" / slug
    md = ROOT / "content/_index.md" if site else post / "index.md"
    svg = (ROOT / "themes/coloroid/og-image.svg" if site else post / "og.svg").read_text()
    text = md.read_text()
    delim, fm = front_matter(text)
    font = base64.b64encode(FONT.read_bytes()).decode()
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: "JetBrains Mono"; src: url(data:font/woff2;base64,{font}) format("woff2");
  font-weight: 100 800; }}
:root {{ {theme_vars(fm)} {TOKENS} --font-mono: "JetBrains Mono", ui-monospace, monospace; }}
html, body {{ margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--article-bg); }}
svg {{ display: block; font-family: var(--font-mono); }}
</style></head><body>{svg}</body></html>"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        page_path = f.name
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROMIUM)
        pg = b.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=2)
        pg.goto(f"file://{page_path}")
        pg.evaluate("document.fonts.ready")
        png = pg.screenshot(type="png")
        b.close()
    name = f"og-{hashlib.sha256(png).hexdigest()[:8]}.png"
    if check:
        out = Path("/tmp") / f"{slug}-{name}"
        out.write_bytes(png)
        print(out)
        return 0
    if site:
        out = ROOT / "themes/coloroid/static/og-image.png"
        out.write_bytes(png)
        print(out)
        return 0
    for old in post.glob("og-*.png"):
        old.unlink()
    (post / name).write_bytes(png)
    line = f'images = ["{name}"]' if delim == "+++" else f'images: ["{name}"]'
    new_fm = re.sub(r"^images\s*[=:].*$", line, fm, flags=re.M) if re.search(r"^images\s*[=:]", fm, re.M) else fm + "\n" + line
    md.write_text(text.replace(fm, new_fm, 1))
    print(post / name)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env -S uv run --with fonttools --with brotli python3
"""Regenerate the JetBrains Mono woff2 subsets used by the site.

Usage: ./scripts/regen-fonts.py [--rebuild-html-first]

The font is subset to:
  * The actual chars that appear in any rendered HTML/XML in public/
  * A safety margin: full Basic Latin + Latin-1 + smart quotes/dashes/
    box-drawing + a curated set of common arrows/math/UI glyphs.

Re-run this whenever new posts introduce new characters that aren't
already covered. Build the site (`hugo --environment production`) first
so the script can scan public/.

The TTF source files are no longer in the repo; this script pulls them
from a known git history reference. Update SOURCE_REF if the TTF was
removed in a different commit.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TTF_REF = "HEAD~10"  # bump if needed; last commit that contains the TTF source
TTF_REGULAR = "themes/coloroid/static/fonts/jetbrains/JetBrainsMono[wght].ttf"
TTF_ITALIC = "themes/coloroid/static/fonts/jetbrains/JetBrainsMono-Italic[wght].ttf"
OUT_REGULAR = "themes/coloroid/static/fonts/jetbrains/JetBrainsMono[wght].woff2"
OUT_ITALIC = "themes/coloroid/static/fonts/jetbrains/JetBrainsMono-Italic[wght].woff2"

SAFETY = (
    list(range(0x0020, 0x007E + 1))   # Basic Latin
    + list(range(0x00A0, 0x00FF + 1)) # Latin-1 Supplement
    + [0x2010, 0x2011, 0x2013, 0x2014, 0x2015,         # dashes
       0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, # smart quotes
       0x2022, 0x2026,                                  # bullet, ellipsis
       0x00AD, 0xFFFD,
       0x2190, 0x2191, 0x2192, 0x2193,                  # arrows
       0x2200, 0x2208, 0x2209, 0x2212, 0x2248,          # math
       0x2260, 0x2264, 0x2265, 0x221D,
       0x03BC,                                          # μ
       0x20B9,                                          # ₹
       0x21BB,                                          # ↻
       0x25D1, 0x25B2, 0x25B6, 0x25BC, 0x25C0,          # geometric
       0x2713, 0x2715,                                  # check / cross
       0x2B50,                                          # star
    ]
    + list(range(0x2500, 0x257F + 1))  # box-drawing
)


def scan_chars(html_paths: list[Path], inside_em_only: bool = False) -> set[int]:
    chars = set()
    for p in html_paths:
        if not p.suffix in (".html", ".xml"):
            continue
        text = p.read_text()
        if inside_em_only:
            for m in re.finditer(r"<em[^>]*>([^<]+)</em>", text):
                for c in m.group(1):
                    if 0x20 <= ord(c) < 0x10000:
                        chars.add(ord(c))
        else:
            text = re.sub(r"<[^>]+>", "", text)
            for c in text:
                cp = ord(c)
                if 0x20 <= cp < 0x10000:
                    chars.add(cp)
    return chars


def fetch_ttf(rel_path: str, dst: Path) -> None:
    out = subprocess.run(
        ["git", "cat-file", "-p", f"{TTF_REF}:{rel_path}"],
        cwd=ROOT, capture_output=True, check=True,
    )
    dst.write_bytes(out.stdout)


def subset_font(src_ttf: Path, unicodes: list[int], dst: Path) -> None:
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options
    from fontTools.varLib.instancer import instantiateVariableFont

    opts = Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.recommended_glyphs = True

    font = TTFont(str(src_ttf))
    sub = Subsetter(options=opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    font = instantiateVariableFont(font, {"wght": (400, 700)}, inplace=False)
    font.flavor = "woff2"
    font.save(str(dst))


def main() -> int:
    public = ROOT / "public"
    if not public.exists():
        print("public/ doesn't exist — run `hugo --environment production` first", file=sys.stderr)
        return 1

    html_paths = list(public.rglob("*.html")) + list(public.rglob("*.xml"))
    all_chars = scan_chars(html_paths)
    em_chars = scan_chars(html_paths, inside_em_only=True)

    regular_unicodes = sorted(set(list(all_chars) + SAFETY))
    italic_unicodes = sorted(set(
        list(em_chars)
        + list(range(0x0020, 0x007E + 1))
        + list(range(0x00A0, 0x00FF + 1))
        + [0x2010, 0x2011, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x00AD, 0xFFFD]
    ))

    print(f"Found {len(all_chars)} unique chars (excl. emoji)")
    print(f"Regular subset: {len(regular_unicodes)} codepoints")
    print(f"Italic subset:  {len(italic_unicodes)} codepoints")

    tmp_dir = Path("/tmp")
    src_regular = tmp_dir / "jbm-regular.ttf"
    src_italic = tmp_dir / "jbm-italic.ttf"
    fetch_ttf(TTF_REGULAR, src_regular)
    fetch_ttf(TTF_ITALIC, src_italic)

    subset_font(src_regular, regular_unicodes, ROOT / OUT_REGULAR)
    subset_font(src_italic, italic_unicodes, ROOT / OUT_ITALIC)

    sz_r = (ROOT / OUT_REGULAR).stat().st_size / 1024
    sz_i = (ROOT / OUT_ITALIC).stat().st_size / 1024
    print(f"\nWrote {OUT_REGULAR}: {sz_r:.1f} KB")
    print(f"Wrote {OUT_ITALIC}: {sz_i:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env -S uv run --quiet --with pycairo --with numpy --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pycairo", "numpy"]
# ///
"""Math-driven Dune-aesthetic OG image generator.

Replaces the PIL-based `og-images.py` with sharper rendering (cairo) and
genuinely generative motifs (numpy). Each post gets a unique sigil
deterministically derived from its slug; the brand palette stays
constant for visual identity.

Usage:
    scripts/og-art.py                # regenerate all posts
    scripts/og-art.py <slug> [...]   # regenerate one or more posts

Motifs (math-driven generative art):
    flow_field      perlin-style vector field + particle trails
    phyllotaxis     golden-angle dot spiral (Vogel 1979)
    voronoi_shards  random points → Lloyd-relaxed cells
    topographic     marching-squares contours over perlin noise
    harmonograph    two coupled damped pendulums (Lissajous family)
    worm_trail      sinusoidal dune ridges with a curving spice trail
    concentric_ritual  nested arc rings with deterministic tick marks
    bench           debug grid — every motif, side-by-side preview

Brand identity (matches existing site):
    --coal           #0c0a09  background
    --copper         #b97834  warm metallic accent
    --spice          #e9c97e  primary highlight (Arrakis spice)
    --cream          #f0e5c5  text
    --dune           #1c1612  panel/box fill
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import cairo
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)

# ────────────────────────────────────────────────────────────────────
# Palette + layout
# ────────────────────────────────────────────────────────────────────
# OG spec is 1200×630 logical pixels; render at 2× for retina sharpness on
# every social platform (PNG keeps Twitter/LinkedIn compatibility — WebP does
# not render in their card previews).
W, H = 1200, 630
SCALE = 2

COAL = (0.047, 0.039, 0.035)       # #0c0a09 — bg
DUNE = (0.110, 0.086, 0.070)       # #1c1612 — panel
COPPER = (0.725, 0.471, 0.204)     # #b97834 — chrome accent (frame/tags)
SPICE = (0.914, 0.788, 0.494)      # #e9c97e — chrome highlight (BACKEND.HOW mast)
CREAM = (0.941, 0.898, 0.773)      # #f0e5c5
SHADOW = (0, 0, 0, 0.6)


# Full theme palette — every visual layer pulls from the post's theme so the
# OG card reads as a preview of the live post (same bg, same text, same hue).
@dataclass(frozen=True)
class Palette:
    name: str         # e.g. "mauve", "cherry"
    bg: tuple         # canvas background    = --article-bg
    text: tuple       # title + chrome text  = --article-text
    accent: tuple     # sigil structural ink (mid-tone of theme hue)
    highlight: tuple  # sigil focal highlight (deep tone of theme hue)
    panel: tuple      # sigil panel bg (slight darker tint of canvas bg)


@dataclass(frozen=True)
class SigilStyle:
    palette: Palette
    density: float    # 0.75 / 1.0 / 1.3 — scales particle/cell/dot count
    line_scale: float # 0.85 / 1.0 / 1.2 — scales stroke widths


# ────────────────────────────────────────────────────────────────────
# Theme color extraction (themes.yaml → OKLCH → sRGB)
# ────────────────────────────────────────────────────────────────────


THEMES_PATH = ROOT / "data" / "themes.yaml"


def _load_themes() -> dict[str, dict[str, str]]:
    themes: dict[str, dict[str, str]] = {}
    current: str | None = None
    for line in THEMES_PATH.read_text().splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            # top-level key: "mauve:" — name ends at ':'
            if line.rstrip().endswith(":"):
                current = line.rstrip()[:-1].strip()
                themes[current] = {}
            continue
        if current and ":" in line:
            k, _, v = line.strip().partition(":")
            themes[current][k.strip()] = v.strip()
    return themes


_THEMES_CACHE: dict[str, dict[str, str]] | None = None


def themes() -> dict[str, dict[str, str]]:
    global _THEMES_CACHE
    if _THEMES_CACHE is None:
        _THEMES_CACHE = _load_themes()
    return _THEMES_CACHE


_OKLCH_RE = re.compile(r"oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*\)")


def _parse_oklch(css: str) -> tuple[float, float, float] | None:
    m = _OKLCH_RE.search(css)
    if not m:
        return None
    L = float(m.group(1))
    if L > 1.5:               # percent form ("38%") → 0..1
        L /= 100.0
    return (L, float(m.group(2)), float(m.group(3)))


def _oklch_to_srgb(L: float, C: float, h_deg: float) -> tuple[float, float, float]:
    """OKLCH → linear LMS → linear sRGB → sRGB (CSS Color 4 spec)."""
    h = math.radians(h_deg)
    a = C * math.cos(h)
    b = C * math.sin(h)
    # OKLab → LMS (non-linear)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    # LMS → linear sRGB
    r =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def to_srgb(x: float) -> float:
        x = max(0.0, min(1.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * (x ** (1 / 2.4)) - 0.055

    return (to_srgb(r), to_srgb(g), to_srgb(bl))


def palette_for_theme(theme_name: str) -> Palette:
    """Pull the post's full theme palette so the OG matches the live page.

    Sources from data/themes.yaml:
      bg     ← --article-bg     (light page background)
      text   ← --article-text   (dark body text on the light bg)
      hue    ← --color-link h°  (post's accent hue)
    The sigil accent/highlight are re-lit at darker L on the light bg so they
    contrast against bg without losing the theme's identity.
    The panel is bg darkened ~12% — gives the sigil a contained framed feel.
    """
    t = themes().get(theme_name) or themes().get("amber") or {}
    bg_css = t.get("--article-bg", "oklch(85% 0.06 60)")
    txt_css = t.get("--article-text", "oklch(20% 0.04 60)")
    link_css = t.get("--color-link", "oklch(40% 0.14 60)")
    bg_LCh = _parse_oklch(bg_css) or (0.85, 0.06, 60.0)
    txt_LCh = _parse_oklch(txt_css) or (0.20, 0.04, 60.0)
    link_LCh = _parse_oklch(link_css) or (0.40, 0.14, 60.0)
    hue = link_LCh[2]
    bg_L = bg_LCh[0]

    bg = _oklch_to_srgb(*bg_LCh)
    text = _oklch_to_srgb(*txt_LCh)
    # Panel: same hue as bg, slightly darker so the sigil sits in a contained box.
    panel = _oklch_to_srgb(max(0.0, bg_L - 0.10), max(0.02, bg_LCh[1] * 0.9), bg_LCh[2])
    # Sigil ink: lit for the chosen bg lightness so it pops without glare.
    accent = _oklch_to_srgb(0.40, 0.15, hue)
    highlight = _oklch_to_srgb(0.22, 0.13, hue)
    return Palette(theme_name, bg=bg, text=text, accent=accent, highlight=highlight, panel=panel)


# ────────────────────────────────────────────────────────────────────
# Per-slug derivation (UUIDv5-style: every knob comes from sha256(slug))
# ────────────────────────────────────────────────────────────────────


_DENSITY_BINS = (0.78, 1.0, 1.28)
_LINE_BINS = (0.85, 1.0, 1.18)


def style_for(slug: str, theme_name: str) -> SigilStyle:
    h = hashlib.sha256(slug.encode()).digest()
    density = _DENSITY_BINS[h[0] % len(_DENSITY_BINS)]
    line_scale = _LINE_BINS[h[1] % len(_LINE_BINS)]
    return SigilStyle(palette_for_theme(theme_name), density, line_scale)

# Layout: left text column, right sigil square
PAD = 60
SIGIL_SIZE = 400
SIGIL_CX = W - PAD - SIGIL_SIZE / 2
SIGIL_CY = H / 2

# Font (system JetBrains Mono Nerd, present on macOS via nix or homebrew;
# falls back to system mono if absent — cairo handles substitution).
FONT_FAMILY = "JetBrains Mono"
FONT_FALLBACK = "Menlo"


# ────────────────────────────────────────────────────────────────────
# Helpers — deterministic randomness, cairo conveniences
# ────────────────────────────────────────────────────────────────────


def seed_for(slug: str) -> int:
    """Stable 32-bit seed derived from slug."""
    return int(hashlib.sha256(slug.encode()).hexdigest()[:8], 16)


def rng_for(slug: str) -> np.random.Generator:
    return np.random.default_rng(seed_for(slug))


def set_rgb(ctx: cairo.Context, rgb: tuple) -> None:
    if len(rgb) == 3:
        ctx.set_source_rgb(*rgb)
    else:
        ctx.set_source_rgba(*rgb)


def stroke_with(ctx: cairo.Context, rgb, width: float = 2.0) -> None:
    set_rgb(ctx, rgb)
    ctx.set_line_width(width)
    ctx.stroke()


def select_mono(ctx: cairo.Context, family: str = FONT_FAMILY) -> None:
    try:
        ctx.select_font_face(family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    except cairo.Error:
        ctx.select_font_face(FONT_FALLBACK, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)


def select_mono_bold(ctx: cairo.Context, family: str = FONT_FAMILY) -> None:
    try:
        ctx.select_font_face(family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    except cairo.Error:
        ctx.select_font_face(FONT_FALLBACK, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)


# ────────────────────────────────────────────────────────────────────
# Motifs (centred inside SIGIL_SIZE × SIGIL_SIZE box at SIGIL_CX,CY)
# ────────────────────────────────────────────────────────────────────


def _perlin_like(rng: np.random.Generator, shape, scale=4.0):
    """Cheap smooth-noise field — sum of a few rotated sinusoids."""
    h, w = shape
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    field = np.zeros(shape, dtype=np.float32)
    for _ in range(5):
        kx = rng.uniform(-scale, scale) * 2 * math.pi / w
        ky = rng.uniform(-scale, scale) * 2 * math.pi / h
        phase = rng.uniform(0, 2 * math.pi)
        amp = rng.uniform(0.4, 1.0)
        field += amp * np.sin(kx * x + ky * y + phase)
    field /= np.abs(field).max() + 1e-9
    return field


def motif_flow_field(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Spice-in-wind: particles traced along a curl-noise vector field."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n = 56                                  # grid for vector field
    field = _perlin_like(rng, (n, n), scale=2.0)
    # Gradient → vector field (perpendicular for swirly curl-like motion)
    gy, gx = np.gradient(field)
    angle = np.arctan2(-gx, gy)             # rotate 90°

    # Draw the field faintly as background hatch
    ctx.set_line_width(0.6 * style.line_scale)
    set_rgb(ctx, accent + (0.18,))
    step = size / n
    for j in range(n):
        for i in range(n):
            a = angle[j, i]
            px = cx - r + (i + 0.5) * step
            py = cy - r + (j + 0.5) * step
            dx = math.cos(a) * step * 0.42
            dy = math.sin(a) * step * 0.42
            ctx.move_to(px - dx, py - dy)
            ctx.line_to(px + dx, py + dy)
            ctx.stroke()

    # Particles traced through the field — these are the foreground spice trails
    n_particles = int(80 * style.density)
    steps = 90
    h0 = 0.6
    for _ in range(n_particles):
        # Seed positions roughly along the perimeter so trails sweep across
        edge = rng.integers(0, 4)
        if edge == 0:    px, py = cx - r, cy - r + rng.uniform(0, size)
        elif edge == 1:  px, py = cx + r, cy - r + rng.uniform(0, size)
        elif edge == 2:  px, py = cx - r + rng.uniform(0, size), cy - r
        else:            px, py = cx - r + rng.uniform(0, size), cy + r
        ctx.move_to(px, py)
        for _ in range(steps):
            # Look up vector
            fx = int((px - (cx - r)) / size * (n - 1))
            fy = int((py - (cy - r)) / size * (n - 1))
            if fx < 0 or fx >= n or fy < 0 or fy >= n:
                break
            a = angle[fy, fx]
            px += math.cos(a) * h0 * 4.0
            py += math.sin(a) * h0 * 4.0
            ctx.line_to(px, py)
        # Stroke with spice gradient (alpha decays for trail look)
        ctx.set_source_rgba(*highlight, 0.55)
        ctx.set_line_width((0.9 + rng.random() * 0.6) * style.line_scale)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()

    # Anchor: one bold spice dot at the center
    set_rgb(ctx, highlight)
    ctx.arc(cx, cy, 4, 0, 2 * math.pi)
    ctx.fill()


def motif_phyllotaxis(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Vogel's sunflower: r=c√n, θ=n·137.508° (golden angle)."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n = int(520 * style.density)
    golden = math.pi * (3 - math.sqrt(5))
    c = r / math.sqrt(n) * 0.95
    field = _perlin_like(rng, (32, 32), scale=2.5)
    for i in range(1, n + 1):
        rad = c * math.sqrt(i)
        theta = i * golden + seed_for(slug) * 1e-6
        px = cx + rad * math.cos(theta)
        py = cy + rad * math.sin(theta)
        fx = int((px - (cx - r)) / size * 31)
        fy = int((py - (cy - r)) / size * 31)
        if not (0 <= fx < 32 and 0 <= fy < 32):
            continue
        m = (field[fy, fx] + 1) / 2
        radius = (1.5 + 3.5 * m * (1 - i / n) ** 0.5) * style.line_scale
        col = highlight if m > 0.55 else accent
        ctx.set_source_rgba(*col, 0.7 + 0.3 * m)
        ctx.arc(px, py, radius, 0, 2 * math.pi)
        ctx.fill()


def motif_voronoi_shards(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Lloyd-relaxed Voronoi cells: random seeds, two relaxation passes."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n = max(20, int(60 * style.density))
    pts = rng.uniform(0, 1, size=(n, 2))
    # Simple Lloyd relaxation via numpy: assign grid pixels → mean
    H_, W_ = 200, 200
    yy, xx = np.mgrid[0:H_, 0:W_].astype(np.float32)
    grid = np.stack([xx / W_, yy / H_], axis=-1)  # (H, W, 2)
    for _ in range(2):
        dists = np.linalg.norm(grid[..., None, :] - pts[None, None, :, :], axis=-1)
        owner = np.argmin(dists, axis=-1)
        new_pts = pts.copy()
        for i in range(n):
            mask = owner == i
            if mask.any():
                gy = (yy[mask]).mean() / H_
                gx = (xx[mask]).mean() / W_
                new_pts[i] = [gx, gy]
        pts = new_pts
    # Re-compute final owners
    dists = np.linalg.norm(grid[..., None, :] - pts[None, None, :, :], axis=-1)
    owner = np.argmin(dists, axis=-1)
    # Find cell boundaries (pixels whose neighbour differs) → trace as lines
    edges = (owner[1:, :] != owner[:-1, :])[:, :-1]
    edges |= (owner[:, 1:] != owner[:, :-1])[:-1, :]
    ctx.set_source_rgba(*accent, 0.55)
    ctx.set_line_width(1.0 * style.line_scale)
    ys, xs = np.where(edges)
    for ex, ey in zip(xs, ys):
        px = cx - r + (ex / W_) * size
        py = cy - r + (ey / H_) * size
        ctx.rectangle(px, py, 1.6 * style.line_scale, 1.6 * style.line_scale)
        ctx.fill()
    for i, (gx, gy) in enumerate(pts):
        px = cx - r + gx * size
        py = cy - r + gy * size
        is_hi = i % 7 == 0
        col = highlight if is_hi else accent
        ctx.set_source_rgba(*col, 0.8 if is_hi else 0.45)
        ctx.arc(px, py, 2.2 if is_hi else 1.4, 0, 2 * math.pi)
        ctx.fill()


def motif_topographic(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Marching-squares contours over a perlin field — dune ridges from above."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    res = 180
    field = _perlin_like(rng, (res, res), scale=2.5)
    step = size / res
    n_levels = max(7, int(11 * style.density))
    levels = np.linspace(-0.8, 0.8, n_levels)
    for lvl_i, lvl in enumerate(levels):
        if lvl_i == len(levels) // 2:
            col = highlight; alpha = 0.85; lw = 1.6
        elif lvl_i % 2 == 0:
            col = accent; alpha = 0.45; lw = 0.9
        else:
            col = accent; alpha = 0.25; lw = 0.7
        ctx.set_source_rgba(*col, alpha)
        ctx.set_line_width(lw * style.line_scale)
        # March each cell
        for j in range(res - 1):
            for i in range(res - 1):
                a = field[j, i]; b = field[j, i + 1]
                c = field[j + 1, i + 1]; d = field[j + 1, i]
                code = ((a > lvl) << 3) | ((b > lvl) << 2) | ((c > lvl) << 1) | (d > lvl)
                if code in (0, 15):
                    continue
                # Compute interpolated edge intersections
                def lerp(p1, p2, v1, v2):
                    t = (lvl - v1) / (v2 - v1 + 1e-9)
                    return (p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t)
                p_a = (cx - r + i * step, cy - r + j * step)
                p_b = (cx - r + (i + 1) * step, cy - r + j * step)
                p_c = (cx - r + (i + 1) * step, cy - r + (j + 1) * step)
                p_d = (cx - r + i * step, cy - r + (j + 1) * step)
                e_top = lerp(p_a, p_b, a, b)
                e_right = lerp(p_b, p_c, b, c)
                e_bot = lerp(p_d, p_c, d, c)
                e_left = lerp(p_a, p_d, a, d)
                segments = {
                    1: [(e_left, e_bot)], 2: [(e_bot, e_right)],
                    3: [(e_left, e_right)], 4: [(e_top, e_right)],
                    5: [(e_left, e_top), (e_bot, e_right)],
                    6: [(e_bot, e_top)], 7: [(e_left, e_top)],
                    8: [(e_left, e_top)], 9: [(e_bot, e_top)],
                    10: [(e_left, e_bot), (e_top, e_right)],
                    11: [(e_top, e_right)], 12: [(e_left, e_right)],
                    13: [(e_bot, e_right)], 14: [(e_left, e_bot)],
                }
                for s, e in segments.get(code, []):
                    ctx.move_to(*s); ctx.line_to(*e); ctx.stroke()


def motif_harmonograph(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Two damped pendulums coupled on each axis (4D harmonograph)."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    f1, f2 = rng.uniform(2.0, 4.0, 2)
    f3, f4 = rng.uniform(2.0, 4.0, 2)
    p1, p2, p3, p4 = rng.uniform(0, 2 * math.pi, 4)
    # Lighter damping + bigger amplitude so the figure fills the panel.
    d1, d2, d3, d4 = rng.uniform(0.0008, 0.0035, 4)
    A = r * 0.88
    n_pts = int(6000 * style.density)
    t = np.linspace(0, 60, n_pts)
    x = A * (np.sin(f1 * t + p1) * np.exp(-d1 * t) + np.sin(f2 * t + p2) * np.exp(-d2 * t)) / 2
    y = A * (np.sin(f3 * t + p3) * np.exp(-d3 * t) + np.sin(f4 * t + p4) * np.exp(-d4 * t)) / 2
    ctx.set_source_rgba(*highlight, 0.88)
    ctx.set_line_width(2.6 * style.line_scale)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.move_to(cx + x[0], cy + y[0])
    for xi, yi in zip(x[1:], y[1:]):
        ctx.line_to(cx + xi, cy + yi)
    ctx.stroke()


def motif_worm_trail(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Horizontal dune ridges + a curving spice trail sweeping across them."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n_ridges = max(10, int(24 * style.density))
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    for i in range(n_ridges):
        y0 = cy - r + (i + 0.5) * (size / n_ridges)
        amp = 6 + rng.uniform(0, 4)
        freq = rng.uniform(0.005, 0.015)
        phase = rng.uniform(0, 2 * math.pi)
        ctx.set_source_rgba(*accent, 0.25 + 0.4 * (i / n_ridges))
        ctx.set_line_width((0.8 + (i / n_ridges) * 1.4) * style.line_scale)
        ctx.move_to(cx - r, y0)
        for px in np.linspace(cx - r, cx + r, 120):
            py = y0 + amp * math.sin(freq * (px - cx) + phase)
            ctx.line_to(px, py)
        ctx.stroke()
    ctx.set_source_rgba(*highlight, 0.85)
    ctx.set_line_width(2.4 * style.line_scale)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    t = np.linspace(0, 1, 200)
    # 3 control points jittered
    p0 = np.array([cx - r * 0.85, cy + r * 0.5])
    p1 = np.array([cx + rng.uniform(-r * 0.3, r * 0.3), cy + rng.uniform(-r * 0.4, r * 0.4)])
    p2 = np.array([cx + r * 0.85, cy - r * 0.55])
    pts = (1 - t)[:, None] ** 2 * p0 + 2 * ((1 - t) * t)[:, None] * p1 + (t ** 2)[:, None] * p2
    ctx.move_to(*pts[0])
    for px, py in pts[1:]:
        ctx.line_to(px, py)
    ctx.stroke()
    # Spice particles trailing behind the curve
    for i in range(50):
        idx = int(t.shape[0] * rng.uniform(0.0, 1.0))
        px, py = pts[idx]
        jitter = rng.normal(0, 3, 2)
        rad = 1.0 + rng.uniform(0, 2.5)
        ctx.set_source_rgba(*highlight, 0.4 + rng.uniform(0, 0.4))
        ctx.arc(px + jitter[0], py + jitter[1], rad, 0, 2 * math.pi)
        ctx.fill()


def motif_concentric_ritual(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Bene Gesserit-style nested arc rings with deterministic tick marks."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n_rings = max(5, int(8 * style.density))
    for i in range(n_rings):
        ring_r = r * (0.25 + 0.75 * (i / (n_rings - 1)))
        a0 = rng.uniform(0, 2 * math.pi)
        a1 = a0 + rng.uniform(math.pi * 0.5, math.pi * 1.8)
        alpha = 0.35 + 0.5 * (i / n_rings)
        ctx.set_source_rgba(*accent, alpha)
        ctx.set_line_width((1.2 + (i % 3) * 0.4) * style.line_scale)
        ctx.arc(cx, cy, ring_r, a0, a1)
        ctx.stroke()
        n_ticks = 12 + i * 2
        ctx.set_source_rgba(*highlight, 0.7)
        ctx.set_line_width(0.7 * style.line_scale)
        for k in range(n_ticks):
            ta = a0 + (a1 - a0) * (k / (n_ticks - 1))
            x1 = cx + (ring_r - 5) * math.cos(ta)
            y1 = cy + (ring_r - 5) * math.sin(ta)
            x2 = cx + (ring_r + 5) * math.cos(ta)
            y2 = cy + (ring_r + 5) * math.sin(ta)
            ctx.move_to(x1, y1); ctx.line_to(x2, y2); ctx.stroke()
    ctx.set_source_rgba(*highlight, 1.0)
    ctx.arc(cx, cy, 6, 0, 2 * math.pi)
    ctx.fill()
    ctx.set_source_rgba(*accent, 0.9)
    ctx.arc(cx, cy, 12, 0, 2 * math.pi)
    ctx.set_line_width(1.2 * style.line_scale)
    ctx.stroke()


# ────────────────────────────────────────────────────────────────────
# CLRS / "Intro to Algorithms"-themed motifs
# ────────────────────────────────────────────────────────────────────


def motif_fibonacci_spiral(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Golden rectangle subdivisions + ¼-arc spiral. Phi geometry."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    phi = (1 + math.sqrt(5)) / 2
    n_steps = max(7, int(10 * style.density))
    # Place rectangles spiralling outward from center.
    # Start with a small square, then add a square on the long side at each step.
    # Direction sequence: right, up, left, down — rotates 90° each step.
    w = h = r / phi ** (n_steps - 1) * 1.4
    x = cx - w / 2
    y = cy - h / 2
    dirs = [(1, 0), (0, -1), (-1, 0), (0, 1)]
    rects = []         # (x, y, w, h, arc_center, arc_start)
    rects.append((x, y, w, h))
    for i in range(n_steps):
        dx, dy = dirs[i % 4]
        if dx != 0:    # extend horizontally: new square is square=h, beside
            new_w = h
            new_x = x + (w if dx > 0 else -new_w)
            new_y = y
            x = min(x, new_x); w = w + new_w; h = h
        else:          # extend vertically
            new_h = w
            new_y = y + (h if dy > 0 else -new_h)
            new_x = x
            y = min(y, new_y); h = h + new_h; w = w
        rects.append((x, y, w, h))
    # Draw rectangles faintly
    ctx.set_source_rgba(*accent, 0.35)
    ctx.set_line_width(0.8 * style.line_scale)
    for (rx, ry, rw, rh) in rects:
        ctx.rectangle(rx, ry, rw, rh)
        ctx.stroke()
    # Draw spiral as concatenated quarter-arcs anchored on each rectangle's far corner
    ctx.set_source_rgba(*highlight, 0.9)
    ctx.set_line_width(2.0 * style.line_scale)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    # Walk rects pairwise. For each new addition, the arc lives inside the new square.
    side = min(rects[0][2], rects[0][3])
    cur_w = cur_h = side
    cx0 = rects[0][0] + side
    cy0 = rects[0][1] + side
    angle = math.pi               # start arc from inside the seed square
    for i in range(1, len(rects)):
        rx, ry, rw, rh = rects[i]
        added_w = rw - cur_w
        added_h = rh - cur_h
        if added_w > 0:           # extended horizontally
            sq_side = rh
            if rx == rects[i-1][0]:   # extended right
                arc_cx = rx + rw - sq_side
                arc_cy = ry if angle in (math.pi, 3*math.pi/2) else ry + sq_side
            else:                    # extended left
                arc_cx = rx + sq_side
                arc_cy = ry if angle in (0, math.pi/2) else ry + sq_side
            cur_w = rw
        else:
            sq_side = rw
            if ry == rects[i-1][1]:   # extended down
                arc_cx = rx if angle in (math.pi/2, math.pi) else rx + sq_side
                arc_cy = ry + rh - sq_side
            else:                    # extended up
                arc_cx = rx if angle in (0, 3*math.pi/2) else rx + sq_side
                arc_cy = ry + sq_side
            cur_h = rh
        ctx.arc(arc_cx, arc_cy, sq_side, angle, angle + math.pi / 2)
        ctx.stroke()
        angle = (angle + math.pi / 2) % (2 * math.pi)
    # Anchor dot
    set_rgb(ctx, highlight)
    ctx.arc(cx, cy, 3, 0, 2 * math.pi)
    ctx.fill()


def motif_binary_tree(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Recursive binary tree with depth-attenuated alpha."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    depth = max(5, int(6 * style.density))
    top = (cx, cy - r * 0.85)
    spread = r * 0.95

    def draw(x: float, y: float, dx: float, dy: float, d: int) -> None:
        if d > depth:
            return
        alpha = 0.95 - 0.55 * (d / depth)
        col = highlight if d <= 1 else accent
        ctx.set_source_rgba(*col, alpha)
        ctx.set_line_width((2.0 - 1.3 * (d / depth)) * style.line_scale)
        nx, ny = x + dx, y + dy
        ctx.move_to(x, y); ctx.line_to(nx, ny); ctx.stroke()
        # Node dot
        ctx.set_source_rgba(*col, alpha)
        ctx.arc(nx, ny, max(1.0, 3.5 - d * 0.45), 0, 2 * math.pi)
        ctx.fill()
        # Recurse: children fan out at ±35°, length shrinks
        ang = math.atan2(dy, dx)
        mag = math.hypot(dx, dy) * 0.68
        for off in (-0.62, 0.62):
            na = ang + off
            draw(nx, ny, mag * math.cos(na), mag * math.sin(na), d + 1)

    # Root dot
    ctx.set_source_rgba(*highlight, 1.0)
    ctx.arc(top[0], top[1], 4.5, 0, 2 * math.pi)
    ctx.fill()
    # Two children of root
    for off in (-0.55, 0.55):
        na = math.pi / 2 + off
        draw(top[0], top[1], spread * math.cos(na) * 0.45, spread * math.sin(na) * 0.45, 1)


def motif_hilbert_curve(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Hilbert space-filling curve (depth chosen by density)."""
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    order = 5 if style.density >= 1.2 else (4 if style.density >= 0.9 else 3)
    n = 1 << order
    # Generate Hilbert curve points via standard d→(x,y) transform
    def d2xy(d: int) -> tuple[int, int]:
        x = y = 0
        t = d
        s = 1
        while s < n:
            rx = 1 & (t // 2)
            ry = 1 & (t ^ rx)
            if ry == 0:
                if rx == 1:
                    x = s - 1 - x
                    y = s - 1 - y
                x, y = y, x
            x += s * rx
            y += s * ry
            t //= 4
            s *= 2
        return x, y

    total = n * n
    pts = [d2xy(i) for i in range(total)]
    step = (size * 0.92) / (n - 1)
    x0 = cx - (n - 1) * step / 2
    y0 = cy - (n - 1) * step / 2
    # Stroke as a single polyline with hue shift along the path
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.set_line_width(1.8 * style.line_scale)
    for i in range(total - 1):
        t = i / (total - 1)
        col = highlight if t > 0.65 else accent
        a = 0.55 + 0.4 * t
        ctx.set_source_rgba(*col, a)
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        ctx.move_to(x0 + x1 * step, y0 + y1 * step)
        ctx.line_to(x0 + x2 * step, y0 + y2 * step)
        ctx.stroke()


def motif_cellular_automaton(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Elementary 1-D CA (Wolfram rules) — rule picked from slug hash."""
    accent, highlight = style.palette.accent, style.palette.highlight
    h = hashlib.sha256(slug.encode()).digest()
    # Interesting non-trivial rules
    rules = (30, 54, 60, 73, 90, 102, 105, 110, 122, 126, 150, 161, 182, 195)
    rule = rules[h[5] % len(rules)]
    rule_bits = [(rule >> i) & 1 for i in range(8)]
    cols = max(60, int(80 * style.density))
    rows = max(40, int(60 * style.density))
    grid = np.zeros((rows, cols), dtype=np.uint8)
    # Seed center cell
    grid[0, cols // 2] = 1
    for j in range(1, rows):
        for i in range(cols):
            left = grid[j-1, (i-1) % cols]
            mid = grid[j-1, i]
            right = grid[j-1, (i+1) % cols]
            idx = (left << 2) | (mid << 1) | right
            grid[j, i] = rule_bits[idx]
    cell_w = (size * 0.92) / cols
    cell_h = (size * 0.92) / rows
    x0 = cx - size * 0.46
    y0 = cy - size * 0.46
    for j in range(rows):
        for i in range(cols):
            if grid[j, i]:
                # Color graded by row (newer at bottom = highlight, older = accent)
                t = j / rows
                col = highlight if t > 0.7 else accent
                ctx.set_source_rgba(*col, 0.55 + 0.35 * t)
                ctx.rectangle(x0 + i * cell_w, y0 + j * cell_h, cell_w * 0.95, cell_h * 0.95)
                ctx.fill()
    # Bottom-left rule label
    select_mono(ctx)
    ctx.set_font_size(10)
    ctx.set_source_rgba(*accent, 0.7)
    ctx.move_to(x0, y0 + size * 0.92 + 12)
    ctx.show_text(f"rule {rule}")


def motif_hash_buckets(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Hash table with chaining — buckets + linked nodes."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n_buckets = max(8, int(12 * style.density))
    bucket_h = (size * 0.92) / n_buckets
    bucket_w = size * 0.18
    x0 = cx - size * 0.46
    y0 = cy - size * 0.46
    # Buckets column
    ctx.set_source_rgba(*accent, 0.6)
    ctx.set_line_width(1.2 * style.line_scale)
    for i in range(n_buckets):
        ctx.rectangle(x0, y0 + i * bucket_h, bucket_w, bucket_h * 0.85)
        ctx.stroke()
    # Index labels
    select_mono(ctx)
    ctx.set_font_size(9)
    ctx.set_source_rgba(*accent, 0.7)
    for i in range(n_buckets):
        ctx.move_to(x0 - 18, y0 + i * bucket_h + bucket_h * 0.55)
        ctx.show_text(f"{i:02d}")
    # Chains
    node_w = size * 0.10
    node_h = bucket_h * 0.62
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    for i in range(n_buckets):
        chain_len = int(rng.integers(0, 4))  # 0..3 nodes
        bx = x0 + bucket_w + 14
        by = y0 + i * bucket_h + bucket_h * 0.12
        prev_right = (x0 + bucket_w, by + node_h / 2)
        for k in range(chain_len):
            # Node
            is_hi = (i + k) % 5 == 0
            col = highlight if is_hi else accent
            ctx.set_source_rgba(*col, 0.85)
            ctx.rectangle(bx, by, node_w, node_h)
            ctx.fill()
            ctx.set_source_rgba(*accent, 0.55)
            ctx.set_line_width(1.0 * style.line_scale)
            # Arrow from previous
            ctx.move_to(*prev_right)
            ctx.line_to(bx, by + node_h / 2)
            ctx.stroke()
            prev_right = (bx + node_w, by + node_h / 2)
            bx += node_w + 10


def motif_wal_log(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str, style: SigilStyle) -> None:
    """Append-only WAL: stacked LSN-stamped records, writer head + flush mark."""
    rng = rng_for(slug)
    accent, highlight = style.palette.accent, style.palette.highlight
    r = size / 2
    n_rows = max(9, int(13 * style.density))
    row_h = (size * 0.86) / n_rows
    x0 = cx - r * 0.94
    y0 = cy - r * 0.86
    full_w = size * 0.88

    # Random starting LSN, advance by realistic per-record bytes.
    cur_lsn = int(rng.integers(0x100000, 0xFFFFFF))
    record_kinds = ("INS", "UPD", "DEL", "COM", "MSG")  # commit, message etc.
    flushed_row = int(n_rows * 0.55)

    select_mono(ctx)
    ctx.set_font_size(10 * style.line_scale)

    for i in range(n_rows):
        is_head = i == n_rows - 1
        is_recent = i >= n_rows - 3
        kind = record_kinds[int(rng.integers(0, len(record_kinds)))]

        # LSN label, monotone increasing
        lsn_lo = cur_lsn & 0xFFFFFF
        lsn_hi = (cur_lsn >> 24) & 0xFF
        lsn_str = f"{lsn_hi:X}/{lsn_lo:06X}"
        alpha_lsn = 0.45 + 0.40 * (i / n_rows)
        ctx.set_source_rgba(*accent, alpha_lsn)
        ctx.move_to(x0, y0 + i * row_h + row_h * 0.72)
        ctx.show_text(lsn_str)
        lsn_w = ctx.text_extents(lsn_str).width

        # Record kind tag
        tag_x = x0 + lsn_w + 14
        ctx.set_source_rgba(*accent, alpha_lsn + 0.05)
        ctx.move_to(tag_x, y0 + i * row_h + row_h * 0.72)
        ctx.show_text(kind)
        tag_w = ctx.text_extents(kind).width

        # Variable payload bar width
        rec_w_frac = 0.45 + rng.random() * 0.42
        body_x = tag_x + tag_w + 12
        body_w = (full_w - (lsn_w + tag_w + 26)) * rec_w_frac

        # Header byte (small block)
        ctx.set_source_rgba(*(highlight if is_head else accent), 1.0 if is_head else (0.7 if is_recent else 0.45))
        ctx.rectangle(body_x, y0 + i * row_h + row_h * 0.20, row_h * 0.18, row_h * 0.62)
        ctx.fill()
        # Payload
        ctx.set_source_rgba(*accent, 0.35 + 0.35 * (i / n_rows))
        ctx.rectangle(body_x + row_h * 0.24, y0 + i * row_h + row_h * 0.30,
                      max(8.0, body_w - row_h * 0.24), row_h * 0.42)
        ctx.fill()

        # Advance LSN
        cur_lsn += int(rng.integers(0x40, 0x180))

    # Writer-head arrow on the right of the last record
    head_y = y0 + (n_rows - 1) * row_h + row_h * 0.5
    head_x = x0 + full_w + 14
    ctx.set_source_rgba(*highlight, 1.0)
    ctx.set_line_width(2.0 * style.line_scale)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.move_to(head_x - 14, head_y); ctx.line_to(head_x, head_y); ctx.stroke()
    ctx.move_to(head_x, head_y); ctx.line_to(head_x - 6, head_y - 5); ctx.stroke()
    ctx.move_to(head_x, head_y); ctx.line_to(head_x - 6, head_y + 5); ctx.stroke()

    # confirmed_flush_lsn marker — horizontal dashed line
    flushed_y = y0 + flushed_row * row_h
    ctx.set_dash([5, 3], 0)
    ctx.set_source_rgba(*accent, 0.65)
    ctx.set_line_width(1.2 * style.line_scale)
    ctx.move_to(x0, flushed_y); ctx.line_to(x0 + full_w, flushed_y); ctx.stroke()
    ctx.set_dash([], 0)


MOTIFS = {
    "flow_field": motif_flow_field,
    "phyllotaxis": motif_phyllotaxis,
    "voronoi_shards": motif_voronoi_shards,
    "topographic": motif_topographic,
    "harmonograph": motif_harmonograph,
    "worm_trail": motif_worm_trail,
    "concentric_ritual": motif_concentric_ritual,
    "fibonacci_spiral": motif_fibonacci_spiral,
    "binary_tree": motif_binary_tree,
    "hilbert_curve": motif_hilbert_curve,
    "cellular_automaton": motif_cellular_automaton,
    "hash_buckets": motif_hash_buckets,
    "wal_log": motif_wal_log,
}


# ────────────────────────────────────────────────────────────────────
# Tag → motif routing
# ────────────────────────────────────────────────────────────────────


def pick_motif(slug: str, tags: list[str]) -> str:
    bag = " ".join([slug] + tags).lower()

    def has(*needles: str) -> bool:
        return any(n in bag for n in needles)

    # Specific routings (post-mood mapping). Each branch tries to land on a
    # motif that matches the post's underlying CS idea.
    if has("hnsw", "vector-search", "pgvector"):
        return "phyllotaxis"            # spiral indexing, golden angle
    if has("btree", "b-tree", "skip-list"):
        return "binary_tree"            # tree fanout
    if has("hash", "consistent-hash", "hashmap", "shard-per-core", "scylla"):
        return "hash_buckets"           # buckets + chains
    if has("sharding", "partition", "citus", "post-query-optimise", "duckdb"):
        return "voronoi_shards"         # space partitioning
    # WAL/outbox routes BEFORE storage so wal-cake (tagged parquet+wal) lands here.
    if has("outbox", "wal", "logical-decoding", "lsn", "wal-cake"):
        return "wal_log"                # append-only LSN ladder
    if has("storage", "lsm", "badger", "iceberg", "parquet"):
        return "topographic"            # layered contours
    if has("raft", "consensus", "etcd", "leader-election", "tigerbeetle"):
        return "harmonograph"           # coupled oscillation
    if has("cdc", "kafka", "event-driven", "stream"):
        return "flow_field"             # streaming particle trails
    if has("distroless", "container", "k8s", "kubernetes", "dune", "worm"):
        return "worm_trail"
    if has("temporal", "workflow", "ritual", "tinder", "system-design", "fdyno"):
        return "concentric_ritual"
    if has("fibonacci", "phi", "golden"):
        return "fibonacci_spiral"
    if has("space-fill", "locality", "ssh", "ec2"):
        return "hilbert_curve"
    if has("gossip", "distributed-state", "ca", "gameoflife", "automaton"):
        return "cellular_automaton"

    # Deterministic fallback: hash slug → motif index (UUIDv5-style).
    keys = sorted(MOTIFS.keys())
    h = hashlib.sha256(slug.encode()).digest()
    return keys[h[3] % len(keys)]


# ────────────────────────────────────────────────────────────────────
# Text layout
# ────────────────────────────────────────────────────────────────────


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float


def wrap(ctx: cairo.Context, text: str, max_w: float, size: float) -> list[str]:
    ctx.set_font_size(size)
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        ext = ctx.text_extents(trial)
        if ext.width <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_text(ctx: cairo.Context, text: str, max_w: float, max_size: float, min_size: float, max_lines: int) -> tuple[float, list[str]]:
    s = max_size
    while s >= min_size:
        ctx.set_font_size(s)
        lines = wrap(ctx, text, max_w, s)
        if len(lines) <= max_lines:
            return s, lines
        s -= 2
    return min_size, wrap(ctx, text, max_w, min_size)[:max_lines]


_EMOJI_RE = re.compile(
    r"(?:"
    r"[\U0001F300-\U0001FAFF]"            # symbols/pictographs/emoticons/transport
    r"|[\u2600-\u27BF]"                    # misc symbols + dingbats (♥ ✦ ⚡)
    r"|[\u2700-\u27BF]"                    # dingbats (full range)
    r"|\uFE0F|\uFE0E"                     # variation selectors VS15/VS16
    r"|\u200D"                             # zero-width joiner (emoji sequences)
    r")+\s?"
)


def strip_emoji(s: str) -> str:
    return _EMOJI_RE.sub("", s).strip()


# ────────────────────────────────────────────────────────────────────
# Compose one OG image
# ────────────────────────────────────────────────────────────────────


def render(slug: str, title: str, description: str, tags: list[str], theme_name: str, out_path: Path) -> tuple[str, str]:
    motif_name = pick_motif(slug, tags)
    motif_fn = MOTIFS[motif_name]
    style = style_for(slug, theme_name or "amber")

    pal = style.palette
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W * SCALE, H * SCALE)
    ctx = cairo.Context(surf)
    # Render in logical 1200×630 coords; surface is 2400×1260 for retina sharpness.
    ctx.scale(SCALE, SCALE)
    # Cairo quality knobs — best anti-aliasing for shapes and font glyphs.
    ctx.set_antialias(cairo.ANTIALIAS_BEST)
    font_opts = cairo.FontOptions()
    font_opts.set_antialias(cairo.ANTIALIAS_SUBPIXEL)
    font_opts.set_hint_style(cairo.HINT_STYLE_FULL)
    font_opts.set_hint_metrics(cairo.HINT_METRICS_ON)
    ctx.set_font_options(font_opts)

    # Background: post's theme bg (light, matches the live page)
    set_rgb(ctx, pal.bg)
    ctx.rectangle(0, 0, W, H)
    ctx.fill()

    # Subtle vignette in theme accent around sigil area
    grad = cairo.RadialGradient(SIGIL_CX, SIGIL_CY, SIGIL_SIZE * 0.1, SIGIL_CX, SIGIL_CY, SIGIL_SIZE * 0.95)
    grad.add_color_stop_rgba(0, *pal.accent, 0.05)
    grad.add_color_stop_rgba(1, *pal.bg, 0)
    ctx.set_source(grad)
    ctx.rectangle(0, 0, W, H)
    ctx.fill()

    # Frame: hairline in theme text colour
    set_rgb(ctx, pal.text + (0.45,))
    ctx.set_line_width(1.5)
    ctx.rectangle(8, 8, W - 16, H - 16)
    ctx.stroke()

    # Top mast: BACKEND.HOW // HOW IT WORKS
    select_mono_bold(ctx)
    ctx.set_font_size(22)
    set_rgb(ctx, pal.text)
    ctx.move_to(PAD, 60)
    ctx.show_text("BACKEND.HOW")
    ext = ctx.text_extents("BACKEND.HOW")
    select_mono(ctx)
    ctx.set_font_size(18)
    set_rgb(ctx, pal.accent + (0.85,))
    ctx.move_to(PAD + ext.width + 12, 60)
    ctx.show_text("// HOW IT WORKS")

    # Title
    title_clean = strip_emoji(title).strip('"')
    max_text_w = W - SIGIL_SIZE - PAD * 3
    select_mono_bold(ctx)
    title_size, title_lines = fit_text(ctx, title_clean, max_text_w, 44, 28, 3)
    set_rgb(ctx, pal.text)
    y = 250
    for line in title_lines:
        ctx.set_font_size(title_size)
        ctx.move_to(PAD, y)
        ctx.show_text(line)
        y += title_size * 1.18

    # Description (first sentence; don't split on "9.6"/"1.0" etc.)
    select_mono(ctx)
    sent_split = re.split(r"(?<=[.!?])(?=\s|$)", description, maxsplit=1)
    short_desc = sent_split[0].strip()
    if len(short_desc) > 200:
        short_desc = short_desc[:197].rsplit(" ", 1)[0] + "…"
    desc_size, desc_lines = fit_text(ctx, short_desc, max_text_w, 20, 14, 4)
    set_rgb(ctx, pal.text + (0.85,))
    y += 16
    for line in desc_lines:
        ctx.set_font_size(desc_size)
        ctx.move_to(PAD, y)
        ctx.show_text(line)
        y += desc_size * 1.35

    # Tags row at bottom — in theme accent
    if tags:
        select_mono(ctx)
        ctx.set_font_size(18)
        set_rgb(ctx, pal.accent)
        tx = PAD
        ty = H - 60
        for i, t in enumerate(tags[:4]):
            chip = f"#{t}"
            ctx.move_to(tx, ty)
            ctx.show_text(chip)
            tx += ctx.text_extents(chip).width + 24
            if i < len(tags[:4]) - 1:
                set_rgb(ctx, pal.accent + (0.5,))
                ctx.move_to(tx - 16, ty - 6)
                ctx.show_text("·")
                set_rgb(ctx, pal.accent)

    # Sigil panel: slightly darker tint of bg
    pr = SIGIL_SIZE / 2
    panel_x = SIGIL_CX - pr - 22
    panel_y = SIGIL_CY - pr - 22
    panel_w = pr * 2 + 44
    panel_h = pr * 2 + 44
    set_rgb(ctx, pal.panel + (0.95,))
    ctx.rectangle(panel_x, panel_y, panel_w, panel_h)
    ctx.fill()
    set_rgb(ctx, pal.accent + (0.40,))
    ctx.set_line_width(1.2)
    ctx.rectangle(panel_x, panel_y, panel_w, panel_h)
    ctx.stroke()

    # Motif — drawn straight, no rotation (rotation clipped corners outside the panel)
    motif_fn(ctx, SIGIL_CX, SIGIL_CY, SIGIL_SIZE - 30, slug, style)

    # Motif + theme caption inside panel, bottom-right
    select_mono(ctx)
    ctx.set_font_size(12)
    set_rgb(ctx, pal.text + (0.50,))
    cap = f"// {motif_name} · {style.palette.name}"
    ext = ctx.text_extents(cap)
    ctx.move_to(panel_x + panel_w - ext.width - 14, panel_y + panel_h - 14)
    ctx.show_text(cap)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    surf.write_to_png(str(out_path))
    return motif_name, style.palette.name


# ────────────────────────────────────────────────────────────────────
# Frontmatter parsing (TOML / YAML, shared with og-images.py)
# ────────────────────────────────────────────────────────────────────


def parse_frontmatter(text: str) -> tuple[str, str, str]:
    if text.startswith("+++"):
        end = text.find("\n+++", 3)
        return "+++", text[3:end].strip("\n"), text[end + 4:]
    if text.startswith("---"):
        end = text.find("\n---", 3)
        return "---", text[3:end].strip("\n"), text[end + 4:]
    return "", "", text


def extract_field(fm: str, key: str) -> str:
    for pat in (
        rf'^{re.escape(key)}\s*[:=]\s*"((?:[^"\\]|\\.)*)"',
        rf"^{re.escape(key)}\s*[:=]\s*'([^']*)'",
        rf"^{re.escape(key)}\s*:\s*([^\n]+)$",
    ):
        m = re.search(pat, fm, re.MULTILINE)
        if m:
            return m.group(1).replace('\\"', '"')
    return ""


def extract_list(fm: str, key: str) -> list[str]:
    m = re.search(rf"^{re.escape(key)}\s*[:=]\s*\[(.*?)\]", fm, re.DOTALL | re.MULTILINE)
    if not m:
        return []
    return re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))


def set_or_replace_images(fm: str, delim: str, images_value: str) -> str:
    pat = re.compile(r"^images\s*[:=]\s*\[.*?\]", re.DOTALL | re.MULTILINE)
    line = f'images = ["{images_value}"]' if delim == "+++" else f'images: ["{images_value}"]'
    if pat.search(fm):
        return pat.sub(line, fm)
    tag_pat = re.compile(r"(^tags\s*[:=]\s*\[.*?\])", re.DOTALL | re.MULTILINE)
    if tag_pat.search(fm):
        return tag_pat.sub(r"\1\n" + line, fm)
    return fm.rstrip() + "\n" + line + "\n"


def discover_posts(filter_slugs: set[str] | None = None) -> list[tuple[str, bool, Path]]:
    posts = []
    for entry in sorted(os.listdir("content/posts")):
        if entry == "_index.md":
            continue
        if entry.endswith(".md"):
            slug = entry[:-3]
            md = Path("content/posts") / entry
        else:
            slug = entry
            md = Path("content/posts") / entry / "index.md"
            if not md.exists():
                continue
        if filter_slugs and slug not in filter_slugs:
            continue
        is_bundle = not entry.endswith(".md")
        posts.append((slug, is_bundle, md))
    return posts


def main() -> int:
    args = sys.argv[1:]
    filter_slugs: set[str] | None = set(args) if args else None
    posts = discover_posts(filter_slugs)
    if filter_slugs and not posts:
        print(f"No posts matched: {filter_slugs}", file=sys.stderr)
        return 1
    print(f"Generating {len(posts)} OG image(s)…")
    for slug, is_bundle, md in posts:
        text = md.read_text()
        delim, fm, rest = parse_frontmatter(text)
        title = extract_field(fm, "title") or slug
        desc = extract_field(fm, "description")
        tags = extract_list(fm, "tags")
        theme_name = extract_field(fm, "theme") or "amber"

        # Honour existing `images` value if it points to a versioned filename
        # (e.g. og-v2.png), so social cache-busts survive regeneration.
        existing_images = extract_list(fm, "images")
        existing_basename = ""
        for v in existing_images:
            if v.endswith(".png"):
                existing_basename = v.rsplit("/", 1)[-1]
                break

        if is_bundle:
            basename = existing_basename if existing_basename else "og.png"
            out = Path("content/posts") / slug / basename
            images_value = basename
        else:
            basename = existing_basename if existing_basename else "og.png"
            out = Path("static/posts") / slug / basename
            images_value = f"/posts/{slug}/{basename}"

        motif, palette = render(slug, title, desc, tags, theme_name, out)
        new_fm = set_or_replace_images(fm, delim, images_value)
        new_text = f"{delim}\n{new_fm}\n{delim}{rest}" if delim else text
        tag = "✓" if (delim and new_text != text) else "·"
        if delim and new_text != text:
            md.write_text(new_text)
        print(f"  {tag} {slug:55s} motif={motif:18s} palette={palette:11s} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

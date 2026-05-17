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
W, H = 1200, 630

COAL = (0.047, 0.039, 0.035)       # #0c0a09 — bg
DUNE = (0.110, 0.086, 0.070)       # #1c1612 — panel
COPPER = (0.725, 0.471, 0.204)     # #b97834
SPICE = (0.914, 0.788, 0.494)      # #e9c97e
CREAM = (0.941, 0.898, 0.773)      # #f0e5c5
SHADOW = (0, 0, 0, 0.6)

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


def motif_flow_field(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Spice-in-wind: particles traced along a curl-noise vector field."""
    rng = rng_for(slug)
    r = size / 2
    n = 56                                  # grid for vector field
    field = _perlin_like(rng, (n, n), scale=2.0)
    # Gradient → vector field (perpendicular for swirly curl-like motion)
    gy, gx = np.gradient(field)
    angle = np.arctan2(-gx, gy)             # rotate 90°

    # Draw the field faintly as background hatch
    ctx.set_line_width(0.6)
    set_rgb(ctx, COPPER + (0.18,))
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
    n_particles = 80
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
        ctx.set_source_rgba(*SPICE, 0.55)
        ctx.set_line_width(0.9 + rng.random() * 0.6)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()

    # Anchor: one bold spice dot at the center
    set_rgb(ctx, SPICE)
    ctx.arc(cx, cy, 4, 0, 2 * math.pi)
    ctx.fill()


def motif_phyllotaxis(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Vogel's sunflower: r=c√n, θ=n·137.508° (golden angle).

    Dot radius modulated by a perlin field so the pattern feels organic."""
    rng = rng_for(slug)
    r = size / 2
    n = 520
    golden = math.pi * (3 - math.sqrt(5))
    c = r / math.sqrt(n) * 0.95
    # Modulation field
    field = _perlin_like(rng, (32, 32), scale=2.5)
    for i in range(1, n + 1):
        rad = c * math.sqrt(i)
        theta = i * golden + seed_for(slug) * 1e-6
        px = cx + rad * math.cos(theta)
        py = cy + rad * math.sin(theta)
        # Sample modulation
        fx = int((px - (cx - r)) / size * 31)
        fy = int((py - (cy - r)) / size * 31)
        if not (0 <= fx < 32 and 0 <= fy < 32):
            continue
        m = (field[fy, fx] + 1) / 2
        radius = 1.5 + 3.5 * m * (1 - i / n) ** 0.5
        # Pick palette by radial band
        col = SPICE if m > 0.55 else COPPER
        ctx.set_source_rgba(*col, 0.7 + 0.3 * m)
        ctx.arc(px, py, radius, 0, 2 * math.pi)
        ctx.fill()


def motif_voronoi_shards(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Lloyd-relaxed Voronoi cells: random seeds, two relaxation passes.

    Each cell drawn as a stroked polygon — looks like cracked desert glass."""
    rng = rng_for(slug)
    r = size / 2
    n = 60
    # Seed points uniformly inside the square
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
    # Draw edges as faint copper hatch
    ctx.set_source_rgba(*COPPER, 0.55)
    ctx.set_line_width(1.0)
    ys, xs = np.where(edges)
    for ex, ey in zip(xs, ys):
        px = cx - r + (ex / W_) * size
        py = cy - r + (ey / H_) * size
        ctx.rectangle(px, py, 1.6, 1.6)
        ctx.fill()
    # Highlight a few seed points
    for i, (gx, gy) in enumerate(pts):
        px = cx - r + gx * size
        py = cy - r + gy * size
        col = SPICE if i % 7 == 0 else COPPER
        ctx.set_source_rgba(*col, 0.8 if col is SPICE else 0.45)
        ctx.arc(px, py, 2.2 if col is SPICE else 1.4, 0, 2 * math.pi)
        ctx.fill()


def motif_topographic(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Marching-squares contours over a perlin field — dune ridges from above."""
    rng = rng_for(slug)
    r = size / 2
    res = 180
    field = _perlin_like(rng, (res, res), scale=2.5)
    step = size / res
    # Contour at multiple levels
    levels = np.linspace(-0.8, 0.8, 11)
    for lvl_i, lvl in enumerate(levels):
        # Pick palette band
        if lvl_i == len(levels) // 2:
            col = SPICE; alpha = 0.85; lw = 1.6
        elif lvl_i % 2 == 0:
            col = COPPER; alpha = 0.45; lw = 0.9
        else:
            col = COPPER; alpha = 0.25; lw = 0.7
        ctx.set_source_rgba(*col, alpha)
        ctx.set_line_width(lw)
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


def motif_harmonograph(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Two damped pendulums coupled on each axis (4D harmonograph)."""
    rng = rng_for(slug)
    r = size / 2
    # Random frequencies/phases/decays
    f1, f2 = rng.uniform(2.0, 4.0, 2)
    f3, f4 = rng.uniform(2.0, 4.0, 2)
    p1, p2, p3, p4 = rng.uniform(0, 2 * math.pi, 4)
    d1, d2, d3, d4 = rng.uniform(0.002, 0.008, 4)
    A = r * 0.46
    n_pts = 6000
    t = np.linspace(0, 50, n_pts)
    x = A * (np.sin(f1 * t + p1) * np.exp(-d1 * t) + np.sin(f2 * t + p2) * np.exp(-d2 * t)) / 2
    y = A * (np.sin(f3 * t + p3) * np.exp(-d3 * t) + np.sin(f4 * t + p4) * np.exp(-d4 * t)) / 2
    # Single continuous stroke with spice
    ctx.set_source_rgba(*SPICE, 0.7)
    ctx.set_line_width(0.85)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.move_to(cx + x[0], cy + y[0])
    for xi, yi in zip(x[1:], y[1:]):
        ctx.line_to(cx + xi, cy + yi)
    ctx.stroke()
    # Copper shadow trace offset slightly
    ctx.set_source_rgba(*COPPER, 0.35)
    ctx.set_line_width(0.5)
    ctx.move_to(cx + x[0] + 3, cy + y[0] + 3)
    for xi, yi in zip(x[1:], y[1:]):
        ctx.line_to(cx + xi + 3, cy + yi + 3)
    ctx.stroke()


def motif_worm_trail(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Horizontal dune ridges + a curving spice trail sweeping across them."""
    rng = rng_for(slug)
    r = size / 2
    # Dune ridges: parametric sine bands stacked vertically
    n_ridges = 24
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    for i in range(n_ridges):
        y0 = cy - r + (i + 0.5) * (size / n_ridges)
        amp = 6 + rng.uniform(0, 4)
        freq = rng.uniform(0.005, 0.015)
        phase = rng.uniform(0, 2 * math.pi)
        ctx.set_source_rgba(*COPPER, 0.25 + 0.4 * (i / n_ridges))
        ctx.set_line_width(0.8 + (i / n_ridges) * 1.4)
        ctx.move_to(cx - r, y0)
        for px in np.linspace(cx - r, cx + r, 120):
            py = y0 + amp * math.sin(freq * (px - cx) + phase)
            ctx.line_to(px, py)
        ctx.stroke()
    # Spice trail: parametric Bezier-like curve
    ctx.set_source_rgba(*SPICE, 0.85)
    ctx.set_line_width(2.4)
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
        ctx.set_source_rgba(*SPICE, 0.4 + rng.uniform(0, 0.4))
        ctx.arc(px + jitter[0], py + jitter[1], rad, 0, 2 * math.pi)
        ctx.fill()


def motif_concentric_ritual(ctx: cairo.Context, cx: float, cy: float, size: float, slug: str) -> None:
    """Bene Gesserit-style nested arc rings with deterministic tick marks."""
    rng = rng_for(slug)
    r = size / 2
    n_rings = 8
    for i in range(n_rings):
        ring_r = r * (0.25 + 0.75 * (i / (n_rings - 1)))
        # Each ring: an arc covering a random angular span
        a0 = rng.uniform(0, 2 * math.pi)
        a1 = a0 + rng.uniform(math.pi * 0.5, math.pi * 1.8)
        alpha = 0.35 + 0.5 * (i / n_rings)
        ctx.set_source_rgba(*COPPER, alpha)
        ctx.set_line_width(1.2 + (i % 3) * 0.4)
        ctx.arc(cx, cy, ring_r, a0, a1)
        ctx.stroke()
        # Tick marks along the arc
        n_ticks = 12 + i * 2
        ctx.set_source_rgba(*SPICE, 0.7)
        ctx.set_line_width(0.7)
        for k in range(n_ticks):
            ta = a0 + (a1 - a0) * (k / (n_ticks - 1))
            x1 = cx + (ring_r - 5) * math.cos(ta)
            y1 = cy + (ring_r - 5) * math.sin(ta)
            x2 = cx + (ring_r + 5) * math.cos(ta)
            y2 = cy + (ring_r + 5) * math.sin(ta)
            ctx.move_to(x1, y1); ctx.line_to(x2, y2); ctx.stroke()
    # Central spice dot
    ctx.set_source_rgba(*SPICE, 1.0)
    ctx.arc(cx, cy, 6, 0, 2 * math.pi)
    ctx.fill()
    ctx.set_source_rgba(*COPPER, 0.9)
    ctx.arc(cx, cy, 12, 0, 2 * math.pi)
    ctx.set_line_width(1.2)
    ctx.stroke()


MOTIFS = {
    "flow_field": motif_flow_field,
    "phyllotaxis": motif_phyllotaxis,
    "voronoi_shards": motif_voronoi_shards,
    "topographic": motif_topographic,
    "harmonograph": motif_harmonograph,
    "worm_trail": motif_worm_trail,
    "concentric_ritual": motif_concentric_ritual,
}


# ────────────────────────────────────────────────────────────────────
# Tag → motif routing
# ────────────────────────────────────────────────────────────────────


def pick_motif(slug: str, tags: list[str]) -> str:
    bag = " ".join([slug] + tags).lower()

    def has(*needles: str) -> bool:
        return any(n in bag for n in needles)

    # Specific routings (post-mood mapping)
    if has("outbox", "cdc", "wal", "kafka", "event-driven", "stream"):
        return "flow_field"
    if has("hnsw", "vector-search", "pgvector", "btree", "b-tree", "phyllotax"):
        return "phyllotaxis"
    if has("sharding", "partition", "shard-per-core", "scylla", "voronoi"):
        return "voronoi_shards"
    if has("storage", "lsm", "badger", "iceberg", "parquet", "topograph"):
        return "topographic"
    if has("raft", "consensus", "etcd", "leader-election", "tigerbeetle", "harmono"):
        return "harmonograph"
    if has("distroless", "container", "k8s", "kubernetes", "dune", "worm"):
        return "worm_trail"
    if has("temporal", "workflow", "ritual", "concentric", "tinder", "system-design"):
        return "concentric_ritual"

    # Deterministic fallback: hash slug → motif index
    keys = list(MOTIFS.keys())
    return keys[seed_for(slug) % len(keys)]


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


def strip_emoji(s: str) -> str:
    return re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]+\s?", "", s).strip()


# ────────────────────────────────────────────────────────────────────
# Compose one OG image
# ────────────────────────────────────────────────────────────────────


def render(slug: str, title: str, description: str, tags: list[str], out_path: Path) -> str:
    motif_name = pick_motif(slug, tags)
    motif_fn = MOTIFS[motif_name]

    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx = cairo.Context(surf)

    # Background: deep coal
    set_rgb(ctx, COAL)
    ctx.rectangle(0, 0, W, H)
    ctx.fill()

    # Subtle vignette around sigil area
    grad = cairo.RadialGradient(SIGIL_CX, SIGIL_CY, SIGIL_SIZE * 0.1, SIGIL_CX, SIGIL_CY, SIGIL_SIZE * 0.95)
    grad.add_color_stop_rgba(0, *COPPER, 0.06)
    grad.add_color_stop_rgba(1, *COAL, 0)
    ctx.set_source(grad)
    ctx.rectangle(0, 0, W, H)
    ctx.fill()

    # Frame: hairline copper border 1px in from edge
    set_rgb(ctx, COPPER + (0.55,))
    ctx.set_line_width(1.5)
    ctx.rectangle(8, 8, W - 16, H - 16)
    ctx.stroke()

    # Top mast: BACKEND.HOW // HOW IT WORKS
    select_mono_bold(ctx)
    ctx.set_font_size(22)
    set_rgb(ctx, SPICE)
    ctx.move_to(PAD, 60)
    ctx.show_text("BACKEND.HOW")
    ext = ctx.text_extents("BACKEND.HOW")
    select_mono(ctx)
    ctx.set_font_size(18)
    set_rgb(ctx, COPPER + (0.85,))
    ctx.move_to(PAD + ext.width + 12, 60)
    ctx.show_text("// HOW IT WORKS")

    # Title
    title_clean = strip_emoji(title).strip('"')
    max_text_w = W - SIGIL_SIZE - PAD * 3
    select_mono_bold(ctx)
    title_size, title_lines = fit_text(ctx, title_clean, max_text_w, 44, 28, 3)
    set_rgb(ctx, CREAM)
    y = 250
    for line in title_lines:
        ctx.set_font_size(title_size)
        ctx.move_to(PAD, y)
        ctx.show_text(line)
        y += title_size * 1.18

    # Description (first sentence, but don't split on "9.6" / "1.0" etc.)
    select_mono(ctx)
    # Match sentence-terminator followed by whitespace or end of string
    sent_split = re.split(r"(?<=[.!?])(?=\s|$)", description, maxsplit=1)
    short_desc = sent_split[0].strip()
    if len(short_desc) > 200:
        short_desc = short_desc[:197].rsplit(" ", 1)[0] + "…"
    desc_size, desc_lines = fit_text(ctx, short_desc, max_text_w, 20, 14, 4)
    set_rgb(ctx, SPICE + (0.9,))
    y += 16
    for line in desc_lines:
        ctx.set_font_size(desc_size)
        ctx.move_to(PAD, y)
        ctx.show_text(line)
        y += desc_size * 1.35

    # Tags row at bottom
    if tags:
        select_mono(ctx)
        ctx.set_font_size(18)
        set_rgb(ctx, COPPER)
        tx = PAD
        ty = H - 60
        for i, t in enumerate(tags[:4]):
            chip = f"#{t}"
            ctx.move_to(tx, ty)
            ctx.show_text(chip)
            tx += ctx.text_extents(chip).width + 24
            if i < len(tags[:4]) - 1:
                set_rgb(ctx, COPPER + (0.5,))
                ctx.move_to(tx - 16, ty - 6)
                ctx.show_text("·")
                set_rgb(ctx, COPPER)

    # Sigil panel: round rectangle behind motif
    pr = SIGIL_SIZE / 2
    panel_x = SIGIL_CX - pr - 22
    panel_y = SIGIL_CY - pr - 22
    panel_w = pr * 2 + 44
    panel_h = pr * 2 + 44
    set_rgb(ctx, DUNE + (0.85,))
    ctx.rectangle(panel_x, panel_y, panel_w, panel_h)
    ctx.fill()
    set_rgb(ctx, COPPER + (0.5,))
    ctx.set_line_width(1.2)
    ctx.rectangle(panel_x, panel_y, panel_w, panel_h)
    ctx.stroke()

    # Motif
    motif_fn(ctx, SIGIL_CX, SIGIL_CY, SIGIL_SIZE - 30, slug)

    # Motif name caption inside panel, bottom-right
    select_mono(ctx)
    ctx.set_font_size(12)
    set_rgb(ctx, COPPER + (0.6,))
    cap = f"// {motif_name}"
    ext = ctx.text_extents(cap)
    ctx.move_to(panel_x + panel_w - ext.width - 14, panel_y + panel_h - 14)
    ctx.show_text(cap)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    surf.write_to_png(str(out_path))
    return motif_name


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

        if is_bundle:
            out = Path("content/posts") / slug / "og.png"
            images_value = "og.png"
        else:
            out = Path("static/posts") / slug / "og.png"
            images_value = f"/posts/{slug}/og.png"

        motif = render(slug, title, desc, tags, out)
        new_fm = set_or_replace_images(fm, delim, images_value)
        # Reassemble: delimiters need surrounding newlines so Hugo can parse them.
        new_text = f"{delim}\n{new_fm}\n{delim}{rest}" if delim else text
        if delim and new_text != text:
            md.write_text(new_text)
            print(f"  ✓ {slug:55s} motif={motif:18s} → {out}")
        else:
            print(f"  · {slug:55s} motif={motif:18s} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

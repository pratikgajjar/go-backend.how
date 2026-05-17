#!/usr/bin/env python3
"""Generate per-post OG images with Dune-film-style geometric sigils.

For each post in content/posts/:
  - Pick a motif by topic (tag-based mapping)
  - Render 1200x630 PNG: title + description + sigil on dark sand palette
  - Write to:
      content/posts/<slug>/og.png  (page-bundle posts)
      static/posts/<slug>/og.png   (single-file posts)
  - Update frontmatter `images = ["og.png"]` (or absolute /posts/<slug>/og.png)

Visual identity (consistent across all posts):
  - Deep coal background  (#0c0a09)
  - Spice-gold accents    (#e9c97e)
  - Cream text            (#f0e5c5)
  - Heavy negative space, radial/bilateral symmetry

Run:  uv run --with pillow python3 scripts/og-images.py
"""

from __future__ import annotations

import math
import os
import random
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)

# --- Brand palette --------------------------------------------------------
W, H = 1200, 630
COAL = (12, 10, 9)            # background
DUNE = (28, 22, 18)            # darker overlay
COPPER = (185, 120, 52)
SPICE = (233, 201, 126)
CREAM = (240, 229, 197)
SHADOW = (0, 0, 0, 80)

FONT_REG = "/tmp/og-fonts/JetBrainsMono-Regular.ttf"
FONT_BOLD = "/tmp/og-fonts/JetBrainsMono-Bold.ttf"

# --- Helpers --------------------------------------------------------------


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def fit_text(draw, text: str, font_path: str, max_w: int, max_size: int, min_size: int = 28, max_lines: int = 2) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Wrap text into ≤max_lines that fit max_w; shrink font until it does."""
    size = max_size
    while size >= min_size:
        font = load_font(font_path, size)
        lines = wrap_text(draw, text, font, max_w)
        too_wide = any(draw.textlength(L, font=font) > max_w for L in lines)
        too_many = len(lines) > max_lines
        if not too_wide and not too_many:
            return font, lines
        size -= 4
    # Final fallback: hard-truncate to max_lines at min_size
    font = load_font(font_path, min_size)
    lines = wrap_text(draw, text, font, max_w)
    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + [lines[max_lines - 1] + "…"]
    return font, lines


# Drop leading emoji / pictographic glyphs from title (JBM has no emoji glyphs).
# We keep ASCII punctuation but strip Unicode codepoints in emoji ranges.
EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF"      # symbols & pictographs, faces, etc.
    r"\U0001F600-\U0001F64F"        # emoticons
    r"\U0001F680-\U0001F6FF"        # transport
    r"\U0001F900-\U0001F9FF"        # supplemental symbols
    r"\U00002600-\U000027BF"        # misc symbols + dingbats
    r"\u2764\ufe0f]+"                # heart + variation selector
)


def strip_emoji(s: str) -> str:
    return EMOJI_RE.sub("", s).strip()


def first_sentence(desc: str, max_chars: int = 200) -> str:
    """Pick the first sentence-ish chunk for OG description.

    Splits on `.!?` followed by whitespace AND uppercase or end-of-string,
    so we don't break inside `DynamoDB's` or `India's`.
    """
    if not desc:
        return ""
    # Prefer first split on `.!?` followed by space and uppercase letter
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", desc, maxsplit=1)
    head = parts[0].strip()
    if len(head) > max_chars:
        head = head[:max_chars].rsplit(" ", 1)[0] + "…"
    return head


def wrap_text(draw, text: str, font, max_w: int) -> list[str]:
    """Greedy line-wrap on word boundaries."""
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        candidate = (cur + " " + w).strip()
        if draw.textlength(candidate, font=font) <= max_w:
            cur = candidate
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# --- Motif library (drawn into a 380x380 square at right side) -----------

SIGIL_W = 380
SIGIL_H = 380


def motif_spoke_wheel(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Concentric ring + radial spokes (TigerBeetle / payments / ledger)."""
    r1, r2, r3 = 60, 130, 175
    # Outer thin ring
    d.ellipse((cx - r3, cy - r3, cx + r3, cy + r3), outline=SPICE, width=2)
    # Mid bold ring
    d.ellipse((cx - r2, cy - r2, cx + r2, cy + r2), outline=COPPER, width=4)
    # Inner solid disk
    d.ellipse((cx - r1, cy - r1, cx + r1, cy + r1), outline=SPICE, width=3)
    # Radial spokes (12)
    for i in range(12):
        a = math.radians(i * 30 + 15)
        x1 = cx + r2 * math.cos(a)
        y1 = cy + r2 * math.sin(a)
        x2 = cx + r3 * math.cos(a)
        y2 = cy + r3 * math.sin(a)
        d.line((x1, y1, x2, y2), fill=SPICE, width=2)
    # Inner crosshair
    d.line((cx - r1 + 10, cy, cx + r1 - 10, cy), fill=COPPER, width=2)
    d.line((cx, cy - r1 + 10, cx, cy + r1 - 10), fill=COPPER, width=2)
    # Center dot
    d.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=SPICE)


def motif_hex_shield(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Holtzman-shield hex grid (FoundationDB / DynamoDB / databases)."""
    rng = random.Random(seed)
    r = 175
    # Outer hex
    pts = [(cx + r * math.cos(math.radians(60 * i - 30)), cy + r * math.sin(math.radians(60 * i - 30))) for i in range(6)]
    d.polygon(pts, outline=SPICE, width=3)
    # Inner small hexes — flat-top tessellation
    sr = 36
    sw = sr * math.sqrt(3)
    rows = 5
    cols = 5
    for row in range(-rows, rows + 1):
        for col in range(-cols, cols + 1):
            ox = cx + col * sw + (sw / 2 if row % 2 else 0)
            oy = cy + row * sr * 1.5
            # Skip if outside the outer hex (loosely)
            if math.hypot(ox - cx, oy - cy) > r - 25:
                continue
            sub = [(ox + sr * math.cos(math.radians(60 * i - 30)), oy + sr * math.sin(math.radians(60 * i - 30))) for i in range(6)]
            color = COPPER if rng.random() < 0.32 else SPICE
            width = 2 if rng.random() < 0.7 else 3
            d.polygon(sub, outline=color, width=width)


def motif_concentric_clock(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Sundial / time spiral (Temporal / workflows)."""
    radii = [50, 90, 130, 165]
    for i, r in enumerate(radii):
        c = COPPER if i % 2 else SPICE
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=c, width=2 + (i == 1))
    # 12 hour ticks on outer
    for h in range(12):
        a = math.radians(h * 30 - 90)
        outer = radii[-1]
        inner = outer - (16 if h % 3 == 0 else 8)
        d.line((cx + inner * math.cos(a), cy + inner * math.sin(a),
                cx + outer * math.cos(a), cy + outer * math.sin(a)), fill=SPICE, width=3 if h % 3 == 0 else 1)
    # Hour and minute hands
    d.line((cx, cy, cx + radii[1] * math.cos(math.radians(-60)), cy + radii[1] * math.sin(math.radians(-60))),
           fill=SPICE, width=4)
    d.line((cx, cy, cx + radii[2] * math.cos(math.radians(20)), cy + radii[2] * math.sin(math.radians(20))),
           fill=COPPER, width=3)
    d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=SPICE)


def motif_nested_squares(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Nested chambers / cache layers (Valkey / Redis)."""
    sizes = [330, 250, 175, 110, 55]
    rng = random.Random(seed)
    for i, s in enumerate(sizes):
        rot = (i * 9) % 18
        # Use rotated polygon
        half = s / 2
        pts = []
        for x, y in [(-half, -half), (half, -half), (half, half), (-half, half)]:
            ang = math.radians(rot)
            rx = x * math.cos(ang) - y * math.sin(ang)
            ry = x * math.sin(ang) + y * math.cos(ang)
            pts.append((cx + rx, cy + ry))
        c = SPICE if i % 2 == 0 else COPPER
        d.polygon(pts, outline=c, width=3 if i == 0 else 2)


def motif_dotted_field(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Stereogram / random dot field (vision / focus)."""
    rng = random.Random(seed)
    R = 180
    # Bounding circle
    d.ellipse((cx - R, cy - R, cx + R, cy + R), outline=COPPER, width=3)
    # Dots clustered toward center
    for _ in range(280):
        # Polar with bias to center
        u = rng.random() ** 0.55
        a = rng.random() * 2 * math.pi
        r = u * (R - 18)
        x = cx + r * math.cos(a)
        y = cy + r * math.sin(a)
        size = rng.choice([1, 1, 2, 2, 3])
        col = SPICE if rng.random() < 0.7 else COPPER
        d.ellipse((x - size, y - size, x + size, y + size), fill=col)


def motif_keyhole(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Keyhole + crysknife (security / ssh)."""
    # Outer shield outline
    d.ellipse((cx - 165, cy - 175, cx + 165, cy + 175), outline=SPICE, width=3)
    # Keyhole circle
    d.ellipse((cx - 38, cy - 50, cx + 38, cy + 26), outline=SPICE, width=4)
    # Keyhole stem (trapezoid)
    d.polygon([(cx - 16, cy + 18), (cx + 16, cy + 18),
               (cx + 28, cy + 110), (cx - 28, cy + 110)], outline=SPICE, width=3)
    # Decorative dashes on outer
    for i in range(24):
        a = math.radians(i * 15)
        r1 = 165
        r2 = 150
        d.line((cx + r2 * math.cos(a), cy + r2 * math.sin(a),
                cx + r1 * math.cos(a), cy + r1 * math.sin(a)), fill=COPPER, width=2)


def motif_dune_ridges(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Layered desert ridges (running / journey / landscape)."""
    rng = random.Random(seed)
    # Sun behind
    d.ellipse((cx - 80, cy - 130, cx + 80, cy + 30), outline=SPICE, width=3)
    d.ellipse((cx - 60, cy - 110, cx + 60, cy + 10), fill=DUNE, outline=COPPER, width=2)
    # Wave ridges (bottom half)
    for layer in range(5):
        y0 = cy + 20 + layer * 24
        amp = 22 - layer * 3
        period = 220 + layer * 30
        col = SPICE if layer % 2 == 0 else COPPER
        pts = []
        for x in range(-180, 181, 3):
            y = y0 + amp * math.sin((x + layer * 40) * 2 * math.pi / period)
            pts.append((cx + x, y))
        if len(pts) >= 2:
            d.line(pts, fill=col, width=2)


def motif_branching_tree(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Mentat / decision tree (learning / first-principles)."""
    rng = random.Random(seed)

    def branch(x, y, ang, length, depth):
        if depth == 0 or length < 8:
            d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=SPICE)
            return
        x2 = x + length * math.cos(ang)
        y2 = y + length * math.sin(ang)
        col = SPICE if depth >= 3 else COPPER
        w = max(1, depth)
        d.line((x, y, x2, y2), fill=col, width=w)
        spread = math.radians(30 + rng.uniform(-5, 5))
        new_len = length * 0.72
        branch(x2, y2, ang - spread, new_len, depth - 1)
        branch(x2, y2, ang + spread, new_len, depth - 1)

    branch(cx, cy + 160, math.radians(-90), 110, 6)


def motif_grid_cells(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Database grid / matrix (postgres / queries / cells)."""
    rng = random.Random(seed)
    cell = 30
    grid = 9
    half = (grid * cell) // 2
    for row in range(grid):
        for col in range(grid):
            x = cx - half + col * cell
            y = cy - half + row * cell
            # Distance from center for fade
            dist = math.hypot(col - grid / 2, row - grid / 2)
            if dist > grid / 2 + 0.5:
                continue
            fill = None
            outline = COPPER
            if rng.random() < 0.18:
                fill = COPPER
                outline = SPICE
            elif rng.random() < 0.3:
                outline = SPICE
            d.rectangle((x + 2, y + 2, x + cell - 2, y + cell - 2), outline=outline, fill=fill, width=1)


def motif_radial_polygon(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Default / fallback: 8-pointed star sigil (system design / general)."""
    rng = random.Random(seed)
    R = 175
    r = 75
    n = 8
    pts = []
    for i in range(n * 2):
        radius = R if i % 2 == 0 else r
        a = math.radians(i * (180 / n) - 90)
        pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    d.polygon(pts, outline=SPICE, width=3)
    # Inner ring
    d.ellipse((cx - 50, cy - 50, cx + 50, cy + 50), outline=COPPER, width=2)
    # Center dot
    d.ellipse((cx - 6, cy - 6, cx + 6, cy + 6), fill=SPICE)


def motif_text_columns(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Manuscript columns / scribe glyphs (creating content / writing)."""
    rng = random.Random(seed)
    # Outer frame
    d.rectangle((cx - 140, cy - 170, cx + 140, cy + 170), outline=SPICE, width=3)
    # Vertical column dividers (3 columns)
    for i in (1, 2):
        x = cx - 140 + i * (280 / 3)
        d.line((x, cy - 165, x, cy + 165), fill=COPPER, width=1)
    # Lines of text-like dashes per column
    for ci in range(3):
        x0 = cx - 138 + ci * (280 / 3) + 6
        x1 = x0 + 280 / 3 - 16
        for li in range(18):
            y = cy - 158 + li * 18
            seg_w = (x1 - x0) * (0.55 + 0.4 * rng.random()) if li > 0 else (x1 - x0) * 0.85
            col = SPICE if li == 0 else (COPPER if rng.random() < 0.3 else CREAM)
            d.line((x0, y, x0 + seg_w, y), fill=col, width=2 if li == 0 else 1)


def motif_stacked_layers(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """Horizontal stacked layers — container image layers, formats, etc."""
    rng = random.Random(seed)
    # 6 layers, each thinner than the next, with offset for parallax
    layer_count = 6
    base_w = 320
    base_h = 26
    spacing = 40
    total_h = layer_count * spacing
    top = cy - total_h // 2 + 10
    for i in range(layer_count):
        # Each layer narrows slightly going up, mimicking a stack
        w = base_w - i * 14
        h = base_h
        x0 = cx - w // 2
        y0 = top + i * spacing
        # Outline
        col = SPICE if i in (0, layer_count - 1) else COPPER
        # Top + side faces (3D-ish): draw the front rectangle and a top parallelogram
        front = [(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)]
        d.polygon(front, outline=col, width=2)
        # Top edge: short parallelogram suggesting depth
        depth = 14
        top_face = [(x0, y0), (x0 + depth, y0 - depth // 2),
                    (x0 + w + depth, y0 - depth // 2), (x0 + w, y0)]
        d.line([top_face[0], top_face[1]], fill=col, width=1)
        d.line([top_face[1], top_face[2]], fill=col, width=1)
        d.line([top_face[2], top_face[3]], fill=col, width=1)
        # A small dot inside indicating "files" in this layer
        for _ in range(3 + i):
            dx = rng.randint(x0 + 8, x0 + w - 8)
            dy = rng.randint(y0 + 6, y0 + h - 6)
            d.ellipse((dx - 1, dy - 1, dx + 1, dy + 1), fill=CREAM)


def motif_hnsw_layers(d: ImageDraw.ImageDraw, cx: int, cy: int, seed: int):
    """HNSW-style multi-layer graph — sparse top, dense bottom, vertical edges."""
    rng = random.Random(seed)
    # 4 layers, top has fewest nodes, bottom has most (HNSW semantics)
    layer_y = [cy - 130, cy - 40, cy + 40, cy + 130]
    layer_counts = [3, 6, 10, 14]
    layer_x_span = [120, 180, 230, 270]
    nodes_per_layer = []
    for y, n, span in zip(layer_y, layer_counts, layer_x_span):
        xs = [cx - span + (2 * span * i) // (n - 1) if n > 1 else cx for i in range(n)]
        nodes_per_layer.append([(x, y) for x in xs])

    # Faint horizontal layer guidelines (like rails)
    for y, span in zip(layer_y, layer_x_span):
        d.line((cx - span - 20, y, cx + span + 20, y), fill=DUNE, width=1)

    # Intra-layer edges (sparse, more on lower layers)
    for li, layer in enumerate(nodes_per_layer):
        n = len(layer)
        for i in range(n - 1):
            if rng.random() < 0.3 + 0.15 * li:
                d.line((layer[i][0], layer[i][1], layer[i + 1][0], layer[i + 1][1]),
                       fill=COPPER, width=1)
        # Skip-edges (HNSW property: long jumps within layer)
        if n >= 3:
            for _ in range(li + 1):
                a, b = sorted(rng.sample(range(n), 2))
                if b - a >= 2:
                    d.line((layer[a][0], layer[a][1], layer[b][0], layer[b][1]),
                           fill=COPPER, width=1)

    # Inter-layer edges (each upper-layer node connects down)
    for li in range(len(nodes_per_layer) - 1):
        upper = nodes_per_layer[li]
        lower = nodes_per_layer[li + 1]
        for u in upper:
            # Pick the closest lower node + maybe one more
            closest = min(lower, key=lambda p: abs(p[0] - u[0]))
            d.line((u[0], u[1], closest[0], closest[1]), fill=SPICE, width=1)

    # Draw nodes on top of edges
    for li, layer in enumerate(nodes_per_layer):
        for x, y in layer:
            r = 4 if li == 0 else 3
            col = SPICE if li == 0 else CREAM
            d.ellipse((x - r, y - r, x + r, y + r), fill=col)


# --- Tag → motif routing -------------------------------------------------

MOTIFS = {
    "spoke_wheel":      motif_spoke_wheel,
    "hex_shield":       motif_hex_shield,
    "concentric_clock": motif_concentric_clock,
    "nested_squares":   motif_nested_squares,
    "dotted_field":     motif_dotted_field,
    "keyhole":          motif_keyhole,
    "dune_ridges":      motif_dune_ridges,
    "branching_tree":   motif_branching_tree,
    "grid_cells":       motif_grid_cells,
    "radial_polygon":   motif_radial_polygon,
    "text_columns":     motif_text_columns,
    "stacked_layers":   motif_stacked_layers,
    "hnsw_layers":      motif_hnsw_layers,
}


def pick_motif(slug: str, tags: list[str]) -> str:
    """Match post topic to motif. Order: most specific first, generic last.

    Match with word boundaries (space-padded slug-style tokens) to avoid
    "ann" inside "planner"/"planning" leaking pgvector→hnsw_layers onto
    Postgres planner posts.
    """
    # Build a tokens set: each tag + each slug-segment, lowercased.
    tokens = set()
    for tag in tags:
        for piece in re.split(r"[\s_/\-]+", tag.lower()):
            if piece:
                tokens.add(piece)
    for piece in re.split(r"[\s_/\-]+", slug.lower()):
        if piece:
            tokens.add(piece)

    def has(*needles: str) -> bool:
        return any(n in tokens for n in needles)

    # Specific topics first
    if has("tigerbeetle", "payments"):
        return "spoke_wheel"
    if has("foundationdb", "dynamodb", "fdyno"):
        return "hex_shield"
    if has("temporal", "workflow", "workflows", "durable"):
        return "concentric_clock"
    # Vector search / HNSW BEFORE postgres so pgvector→hnsw_layers (not grid_cells)
    if has("pgvector", "hnsw", "ann", "vector"):
        return "hnsw_layers"
    # Containers / k8s — image layers
    if has("kubernetes", "k8s", "containers", "distroless", "wolfi"):
        return "stacked_layers"
    # Iceberg / data-lake / parquet / formats — tree of immutable files
    if has("iceberg", "snapshots") or "data-lake" in " ".join(tags).lower():
        return "branching_tree"
    # Distributed DBs / sharding — radial coordinator + workers
    if has("citus", "scylla", "seastar", "shard", "cassandra") or "shard-per-core" in " ".join(tags).lower() or "distributed-sql" in " ".join(tags).lower():
        return "spoke_wheel"
    if has("valkey", "redis", "cache", "car"):
        return "nested_squares"
    if has("stereogram", "vision") or "dark-mode" in " ".join(tags).lower():
        return "dotted_field"
    if has("ssh", "ec2", "aws", "devops"):
        return "keyhole"
    if has("running", "health"):
        return "dune_ridges"
    if has("repost") or "tiger-style" in " ".join(tags).lower():
        return "spoke_wheel"  # tiger-beetle adjacent
    if has("psychology", "help"):
        return "concentric_clock"
    # Learning / first-principles BEFORE the gyan/content fallback
    if has("backend") or "first-principles" in " ".join(tags).lower():
        return "branching_tree"
    # Postgres-specific (partitioning, partman, time-series, query optimization, BRIN)
    if has("postgres", "db", "query", "partitioning", "brin", "partman") or "time-series" in " ".join(tags).lower():
        return "grid_cells"
    if has("creating", "content", "writing"):
        return "text_columns"
    if has("hld", "geospatial", "dating") or "system-design" in " ".join(tags).lower() or "system design" in " ".join(tags).lower():
        return "radial_polygon"
    # Generic fallback for `gyan`/`engineering` posts that didn't match above
    if has("gyan", "engineering"):
        return "concentric_clock"
    return "radial_polygon"


# --- Composer ------------------------------------------------------------

def render(slug: str, title: str, description: str, tags: list[str], out_path: Path):
    """Compose a single OG image."""
    img = Image.new("RGB", (W, H), COAL)
    d = ImageDraw.Draw(img)

    # Subtle vignette (lighter top, darker bottom)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for i in range(H):
        alpha = int(60 * i / H)
        od.line((0, i, W, i), fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    d = ImageDraw.Draw(img)

    # 1px frame (Dune poster border)
    d.rectangle((20, 20, W - 21, H - 21), outline=COPPER, width=1)

    # Top wordmark
    wm_font = load_font(FONT_BOLD, 22)
    d.text((50, 42), "BACKEND.HOW", fill=SPICE, font=wm_font)
    d.text((50 + d.textlength("BACKEND.HOW", font=wm_font) + 14, 47), "// HOW IT WORKS",
           fill=COPPER, font=load_font(FONT_REG, 16))

    # Sigil on right
    sigil_cx = W - 240
    sigil_cy = H // 2 + 6
    motif_name = pick_motif(slug, tags)
    seed = sum(ord(c) for c in slug)
    MOTIFS[motif_name](d, sigil_cx, sigil_cy, seed)

    # Bottom-left tag stripe (above title)
    tag_str = "  ·  ".join(("#" + t.lower().replace(" ", "-") for t in tags[:3]))
    d.text((50, H - 70), tag_str, fill=COPPER, font=load_font(FONT_REG, 16))

    # Title (large, JBM Bold), wrapped to ≤2 lines, max width avoids sigil
    title_max_w = 700
    title_font, title_lines = fit_text(
        d, strip_emoji(title), FONT_BOLD, title_max_w,
        max_size=62, min_size=34, max_lines=2,
    )
    line_h = int(title_font.size * 1.08)
    title_block_h = line_h * len(title_lines)

    # Description: ≤2 lines, smaller font
    desc_font = load_font(FONT_REG, 19)
    desc_text = first_sentence(description)
    desc_lines = wrap_text(d, desc_text, desc_font, 700)[:2]
    desc_h = len(desc_lines) * 26

    # Vertically center the title+description block in the middle band
    block_h = title_block_h + 22 + desc_h
    block_top = (H - block_h) // 2 - 10
    title_top = block_top
    desc_top = title_top + title_block_h + 22

    for i, line in enumerate(title_lines):
        d.text((50, title_top + i * line_h), line, fill=CREAM, font=title_font)
    for i, line in enumerate(desc_lines):
        d.text((50, desc_top + i * 26), line, fill=COPPER, font=desc_font)

    # Save
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG", optimize=True)


# --- Frontmatter handling -----------------------------------------------

def parse_frontmatter(text: str) -> tuple[str, str, str]:
    """Returns (delimiter, frontmatter_body, rest)."""
    if text.startswith("+++"):
        end = text.index("+++", 3)
        return "+++", text[3:end], text[end + 3:]
    if text.startswith("---"):
        end = text.index("---", 3)
        return "---", text[3:end], text[end + 3:]
    return "", "", text


def extract_field(fm: str, key: str) -> str:
    """Match a quoted scalar tolerating embedded apostrophes inside double-quoted
    strings (and vice-versa). Falls back to bare value if unquoted."""
    # Double-quoted: capture until matching `"` not preceded by `\`
    m = re.search(rf'^{re.escape(key)}\s*[:=]\s*"((?:[^"\\]|\\.)*)"', fm, re.MULTILINE)
    if m:
        return m.group(1).replace("\\\"", "\"")
    # Single-quoted (TOML basic single quotes are literal — no escapes)
    m = re.search(rf"^{re.escape(key)}\s*[:=]\s*'([^']*)'", fm, re.MULTILINE)
    if m:
        return m.group(1)
    # Unquoted bare value (YAML)
    m = re.search(rf"^{re.escape(key)}\s*:\s*([^\n]+)$", fm, re.MULTILINE)
    return m.group(1).strip() if m else ""


def extract_list(fm: str, key: str) -> list[str]:
    m = re.search(rf'^{re.escape(key)}\s*[:=]\s*\[(.*?)\]', fm, re.DOTALL | re.MULTILINE)
    if not m:
        return []
    return re.findall(r'[\'"]([^\'"]+)[\'"]', m.group(1))


def set_or_replace_images(fm: str, delim: str, images_value: str) -> str:
    """Set images = ["..."] in frontmatter, replacing existing if present."""
    pattern = re.compile(r'^images\s*[:=]\s*\[.*?\]', re.DOTALL | re.MULTILINE)
    if delim == "+++":
        new_line = f'images = ["{images_value}"]'
    else:  # YAML
        new_line = f'images: ["{images_value}"]'
    if pattern.search(fm):
        return pattern.sub(new_line, fm)
    # Insert after `tags`
    tag_pat = re.compile(r'(^tags\s*[:=]\s*\[.*?\])', re.DOTALL | re.MULTILINE)
    if tag_pat.search(fm):
        return tag_pat.sub(r'\1\n' + new_line, fm)
    # Otherwise append
    return fm.rstrip() + "\n" + new_line + "\n"


# --- Main ----------------------------------------------------------------

def discover_posts() -> list[tuple[str, bool, Path]]:
    """Returns (slug, is_bundle, md_path) for each post."""
    posts = []
    for entry in sorted(os.listdir("content/posts")):
        if entry == "_index.md":
            continue
        if entry.endswith(".md"):
            slug = entry[:-3]
            md = Path("content/posts") / entry
            posts.append((slug, False, md))
        else:
            md = Path("content/posts") / entry / "index.md"
            if md.exists():
                posts.append((entry, True, md))
    return posts


def main():
    posts = discover_posts()
    print(f"Found {len(posts)} posts")
    for slug, is_bundle, md in posts:
        text = md.read_text()
        delim, fm, rest = parse_frontmatter(text)
        title = extract_field(fm, "title") or slug
        desc = extract_field(fm, "description")
        tags = extract_list(fm, "tags")

        # First-sentence-ish description (preserves apostrophes etc.)
        short_desc = first_sentence(desc, max_chars=200)

        # Output paths
        if is_bundle:
            out = Path("content/posts") / slug / "og.png"
            images_value = "og.png"
        else:
            out = Path("static/posts") / slug / "og.png"
            images_value = f"/posts/{slug}/og.png"

        render(slug, title, short_desc, tags, out)

        # Update frontmatter to point at the new image
        new_fm = set_or_replace_images(fm, delim, images_value)
        new_text = f"{delim}{new_fm}{delim}{rest}"
        if new_text != text:
            md.write_text(new_text)
            print(f"  ✓ {slug:55s} motif={pick_motif(slug, tags):17s} → {out}")
        else:
            print(f"  · {slug:55s} motif={pick_motif(slug, tags):17s} → {out} (fm unchanged)")


if __name__ == "__main__":
    main()

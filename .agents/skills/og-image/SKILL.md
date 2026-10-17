---
name: og-image
description: Design and render the social card (Open Graph image) for a backend.how post or the site. Use when a post is new, its title or core idea changed, or its card looks off. Hand-write the SVG in the house figure style, then render it with render.py.
---

# OG image

Source: `content/posts/<slug>/og.svg`, hand-written for that post. Output:
`og-<hash>.png` next to it; `images` in the front matter points to it. The
site card (home, lists, about) is `themes/coloroid/og-image.svg` →
`static/og-image.png`; render it with `render.py site`.

## Steps

1. Read the post. Find the one idea a reader takes away, and look at its
   figures for the post's visual language.
2. Write `og.svg`. Copy the structure of
   `content/posts/wal-cake-lock-free-cdc/og.svg`, then draw this post's idea.
3. `.agents/skills/og-image/render.py <slug> --check` renders to /tmp. Read
   the PNG, then judge it at feed size: `sips -Z 500 <png> --out /tmp/x.png`.
4. `.agents/skills/og-image/render.py <slug>` writes the PNG, deletes the
   old one and updates `images`.
5. Check the feeds view at http://localhost:1313/og-preview/ (`make serve`).
6. `hugo --quiet` builds. Commit only `content/posts/<slug>/`.

## Canvas

- SVG 1200 × 630 (1.91:1). Renders at 2x to 2400 × 1260; keep it under
  300 KB (WhatsApp skips larger images).
- Background: the theme colour, injected. On it, one sheet:
  `x=48 y=48 w=1104 h=526`, `var(--board)` fill, 2.5 px `var(--ink)` stroke,
  8 px hard shadow (ink rect at +8,+8, drawn first).
- Font `var(--font-mono)`. Figure colour tokens (`--ink --mute --line
  --tint`, `--blue --brown --purple --orange --green --red` and `-l`
  variants) are injected.

## Layout and rules

- `backend.how` top left in `--mute`. Title without the emoji, 52–60 px,
  weight 800, at most two lines (or a 30–36 px second line). One diagram of
  the post's idea, 4–10 shapes. Optional one line stating the idea.
- All text 28 px or more. 48 px clear inside the sheet.
- X draws the post title in a dark label over the bottom-left of the image.
  Keep key text out of that corner's lower 70 px.
- Colour grammar of the figures: black structure, brown data, purple look
  here, green durable or safe, red problem, blue options, orange the choice
  made. At most two accents. Solid boxes are processes, dashed boxes data.
- Plain words, no Claudisms (`docs/CLAUDISMS.md`), no emoji. Numbers match
  the post. Each card draws its own post, not a relabelled copy of another.

The theme's head partials emit `og:image` with type, size and alt, and
`twitter:card summary_large_image`. A changed card gets a new hashed name, so
platforms fetch it fresh.

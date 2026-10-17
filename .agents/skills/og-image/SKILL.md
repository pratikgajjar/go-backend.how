---
name: og-image
description: Design and render the social card (Open Graph image) for a backend.how post. Use when a post is new, its title or core idea changed, or its og image looks off. Hand-write og.svg in the house figure style, then render it with render.py.
---

# OG image for a backend.how post

Each post has a hand-written `content/posts/<slug>/og.svg` (the source) and a
rendered `og-<hash>.png` that `images = [...]` in the front matter points to.
There is no generator: you design each card for its post.

## Steps

1. Read the post: title, opening promise, and the one idea a reader should
   take away. Look at its figures (`themes/coloroid/assets/js/viz/<slug>.js`
   and the SVG fallbacks) for the post's own visual language.
2. Write `content/posts/<slug>/og.svg`. Copy the structure of
   `content/posts/wal-cake-lock-free-cdc/og.svg`, then draw this post's idea.
3. Render a preview: `.agents/skills/og-image/render.py <slug> --check`.
   Open the PNG it prints with the read tool. Look at it full size, then
   judge it as a 600 px wide thumbnail in a feed.
4. Iterate until it passes the checklist below. Then render for real:
   `.agents/skills/og-image/render.py <slug>`. This writes the new
   `og-<hash>.png`, deletes the old `og-*.png`, and updates `images`.
5. Check the card as X, LinkedIn and Facebook show it: run `make serve`
   and open http://localhost:1313/og-preview/ (hidden page, drafts
   included). Text that is hard to read there is too small.
6. `hugo --quiet` must build. Commit only the post folder:
   `git add content/posts/<slug>/og.svg content/posts/<slug>/og-*.png && git commit -m "posts(<slug>): new og image" -- content/posts/<slug>`.

## Canvas

- 1200 × 630 SVG (`width="1200" height="630"`). It renders at 2x.
- The page background is the post's theme colour (`--article-bg`), injected
  by `render.py`. On it sits one whiteboard sheet: `x=48 y=48 w=1104 h=526`,
  `fill: var(--board)`, 2.5 px `var(--ink)` stroke, and an 8 px hard shadow
  (an ink rect offset by 8,8 drawn first). This is the figure frame from
  `walviz.css`.
- Font: `var(--font-mono)` (JetBrains Mono, embedded by `render.py`).
- Colour tokens, same as figures: `--ink`, `--mute`, `--line`, `--tint`,
  and `--blue --brown --purple --orange --green --red` with `-l` light
  variants. Theme tokens: `--article-bg`, `--article-text`, `--color-link`.

## Layout

- Top left, inside the sheet: `backend.how` in `--mute`, 28 px.
- Title: the post's title without the emoji, 52–60 px, weight 800, at most
  two lines. A long title can split into a short title line and a 30–36 px
  second line, as in the WAL Cake card.
- One diagram of the post's core idea, in the lower half or on the right.
  It must be the post's own idea (the thing a reader remembers), drawn with
  4–10 shapes. Not decoration, not generative art, not a logo.
- Optional: one line of 28–32 px text that states the idea in plain words.
- Keep 48 px clear inside the sheet on every side. Nothing important within
  60 px of the canvas edge.

## Rules

- Colour carries meaning, as in the figures: black structure, brown data,
  purple "look here", green durable or safe, red problem, blue options,
  orange the choice made. At most two accent colours.
- Solid boxes are processes, dashed boxes are data.
- Text readable as a 600 px thumbnail: nothing under 28 px. Check it at
  `/og-preview/`, where X shows the card about 500 px wide.
- Plain words. No Claudisms (see `docs/CLAUDISMS.md`), no hype, no tags list,
  no "deep dive", no emoji.
- Numbers on the card must match the post.
- Each card looks like its post, not like the other cards with new labels.
  The frame, fonts and colour grammar are shared; the drawing is not.

## Checklist

- [ ] Title matches the post (minus emoji) and fits in two lines.
- [ ] The diagram shows the post's core idea; a reader of the post would
      recognise it.
- [ ] Two accent colours or fewer; every colour means something.
- [ ] Readable at 600 px wide.
- [ ] No text overflows the sheet; nothing is clipped.
- [ ] `images` in the front matter points to the new PNG; old PNG deleted.

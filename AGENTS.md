# AI Agent Guidelines

## Theme System

Each page should have a unique color theme to give it a distinct visual identity. Themes are defined in `themes/coloroid/assets/css/main.css` and applied via frontmatter.

### How to Apply a Theme

Add `theme = "theme-name"` to the frontmatter of any content file:

```toml
+++
title = "My Article"
theme = "seafoam"
+++
```

### Currently Used Themes

| Theme | Page |
|-------|------|
| `vanilla` | Homepage (`content/_index.md`) |
| `powder` | Posts list (`content/posts/_index.md`) |
| `arctic` | Tags (`content/tags/_index.md`) |
| `lilac` | About (`content/about/_index.md`) |
| `tiger` | The Tiger Style |
| `honey` | 1B Payments per Day |
| `blush` | System Design: Tinder |
| `coral` | Pre-owned Car Platform Part 2 |
| `tangerine` | Pre-owned Car Platform Part 1 |
| `teal` | Temporal Under the Hood |
| `mint` | Running 101 |
| `lavender` | Cat Stereogram |
| `pistachio` | Best Way to Learn Backend |
| `periwinkle` | Postgres: Optimising Query |
| `steel` | Lost SSH Access to EC2 |
| `vanilla` | Creating Content |

### Available Unused Themes

**Warm Tones (Reds/Pinks):**
- `salmon`, `rose`, `dustyrose`, `raspberry`, `cherry`, `rosewood`

**Warm Tones (Oranges/Yellows):**
- `peach`, `apricot`, `amber`, `gold`, `butterscotch`, `terracotta`

**Neutrals:**
- `cream`, `butter`, `lemon`, `sand`, `wheat`

**Greens:**
- `sage`, `seafoam`, `olive`, `moss`, `forest`, `jade`, `emerald`, `eucalyptus`

**Teals/Blues:**
- `turquoise`, `aqua`, `cyan`, `ocean`

**Blues:**
- `sky`, `cornflower`, `slate`, `denim`

**Purples:**
- `wisteria`, `mauve`, `plum`, `orchid`, `grape`

**Special:**
- `tiger` - Dark theme with orange accents (reserved for TigerBeetle content)

### Theme Guidelines

1. **Use unique themes** - Each article should have a different theme to create visual variety
2. **Match content mood** - Choose themes that complement the article's topic
3. **Check availability** - Before assigning a theme, verify it's not already in use
4. **Dark themes** - `tiger`, `dustyrose`, `raspberry`, `cherry`, `rosewood`, `terracotta`, `olive`, `moss`, `forest`, `ocean`, `steel`, `slate`, `denim`, `mauve`, `plum` use light text on dark backgrounds

### Theme Inheritance

Themes are inherited in this order:
1. Page's own `theme` parameter
2. Parent section's `theme` parameter  
3. Site-wide default (dark theme)

This means individual tag pages (`/tags/golang/`) will inherit from `/tags/_index.md`.

## Code Block Formatting

### Text/ASCII Diagrams

Use the `txt` language tag for plain text blocks, ASCII diagrams, and non-code content:

```txt
┌──────────┐     ┌──────────┐
│  Client  │────▶│  Server  │
└──────────┘     └──────────┘
```

**Do NOT** use empty language tags for text blocks. Always specify `txt` for:
- ASCII art and diagrams
- Plain text calculations
- Non-code textual content
- System architecture diagrams

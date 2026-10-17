# backend.how — agent notes

Hugo site. Posts are page bundles in `content/posts/<slug>/index.md`. Theme:
`themes/coloroid`. Pushing `main` deploys to Cloudflare Pages.

## New post

1. `make new name=<slug>/index.md`, then write it per `docs/WRITING_GUIDE.md`
   and `docs/CLAUDISMS.md`.
2. Theme: pick one from `data/themes.yaml` that no other post uses
   (`rg -oNI '^theme *[=:] *"?\w+' content | sort | uniq -c`). `tiger` is
   reserved for TigerBeetle posts.
3. Figures: follow `docs/VIZ_GUIDE.md`. Use `{{< viz kind=... >}}` with code in
   `themes/coloroid/assets/{js,css}/viz/<slug>.{js,css}`. Check with
   `uv run --with playwright scripts/viz-check.py <slug>` (add `--dark`).
4. Social card: use the `og-image` skill (`.agents/skills/og-image/`). Preview
   all cards at `http://localhost:1313/og-preview/` (`make serve`).
5. `hugo --quiet` must build.

## Rules

- Code blocks always have a language. Use `txt` for ASCII diagrams and plain
  text.
- Keep tooling minimal. No new generator or checker scripts in the repo; write
  one-off scripts in `/tmp`.
- Run at most 10 sub-agents at a time.

# Interactive figures for backend.how posts

Read this before adding figures to a post. Also read `docs/WRITING_GUIDE.md`.

The WAL Cake post (`content/posts/wal-cake-lock-free-cdc/index.md`,
`themes/coloroid/assets/js/walviz.js`) shows the level of care expected.
It is a bar for quality, not a template. Do not copy its widgets, layout,
or look. Each post gets the visual that makes sense for its subject: a
running post, a stereogram post, and a Postgres post should not look like
the same kit with different labels.

## Reimagine the post's images

Replace the post's current images with visuals you design for it:

- The `xiaohei-hero.png` at the top of the post: replace it with a hero
  visual that shows the post's core idea (static SVG or interactive).
  Remove the old file with `git rm` once nothing references it.
- Diagram images (sequence-diagram PNGs, explanatory drawings, metric
  charts drawn by hand) and ASCII diagrams: replace each with a figure that
  shows the same thing better. Delete the old file when replaced.
- Keep evidence: real screenshots of dashboards, benchmark output, badges,
  and the artefact a post is about (for example the stereogram itself).
  You may add a figure next to them.
- Keep `og-*.png` social images.

## What Pratik asked for

Sources he gave, in his words and in ours:

- **Depth and diagrams:** [Cursor, "Git at any scale"](https://cursor.com/blog/git-at-any-scale).
  First-principles narrative. Show why naive designs fail. Trace the
  mechanism end to end. Diagrams expose state transitions and failure
  behaviour. Performance claims come from reproducible numbers. Name the
  limits honestly. Do not copy its marketing ending.
- **Diagram level:** [PlanetScale, "The lifecycle of a sharded Postgres query"](https://planetscale.com/blog/the-lifecycle-of-a-sharded-postgres-query).
  "I don't like this UI but similar diagram level." Take the depth
  (follow one request, scrub through states, tweak parameters), not the dark
  isometric look.
- **Colour:** [Shishir, "Great Diagrams"](https://docs.superhuman.com/@shishir/eigenquestions-the-art-of-framing-problems/great-diagrams-2).
  "We can use color to signify and do better." Colour carries meaning, and
  the meaning is the same in every figure.
- **Story:** "Like Steve Jobs, first we explain why the existing 2–3 ways
  fall short and why this one makes sense. Then, like the How to Speak
  guide in the repo, we tell a story."
- **Audience:** a new engineer should be able to follow it, and an expert
  should still learn something.

## Colour grammar (default)

Colour must carry meaning, stated in a key, and mean the same thing in
every figure of a post. The grammar below is the site default; use it
unless the post's subject calls for a different one (for example heart-rate
zones in a running post).

| Colour | Meaning | CSS token / key class |
|---|---|---|
| black | structure, the question | `--ink`, `k-ink` |
| brown | concrete data: rows, bytes, keys, LSNs, numbers | `--brown`, `k-data` |
| purple | look here, the current step | `--purple`, `k-look` |
| green | durable, safe, a benefit | `--green`, `k-safe`, `k-held` |
| red | problem, gap, fault | `--red`, `k-gap` |
| blue | options, controls the reader can change | `--blue`, `k-opt` |
| orange | the choice we made | `--orange`, `k-pick` |

Every figure carries a small colour key (`colorKey`) listing only the
colours it uses.

## Look

- Default: a light whiteboard sheet on the themed page (near-white board,
  1.5px near-black ink border, hard offset shadow) from `walviz.css` via the
  `.wv` class. Use it when it fits. Pass `frame="none"` to the shortcode to
  drop it and design your own frame, type, and layout in
  `css/viz/<slug>.css` (target `.viz--<kind>`). The page theme's colours are
  available as CSS variables.
- Dark ink for text. No grey text on tinted backgrounds.
- Solid boxes are processes you run. Dashed boxes are data at rest.
- Label every failure point.
- Must work at 390px wide: no horizontal scroll. Use a tall layout on phones
  when a wide diagram would shrink below readable size.
- Respect `prefers-reduced-motion` (`REDUCED` in lib.js).
- Dark mode: `html[data-force-dark]` swaps the tokens. Use tokens, never
  hard-coded colours.

## What makes a figure worth adding

Each figure must answer one question the text raises and show something
text cannot: a state that changes over time, a parameter the reader can
move, a comparison side by side, or one request followed through every
component. Some patterns that worked in WAL Cake (examples, not a menu;
invent what the post needs):

- **Follow one request** — a stepper (`stepper()` in lib.js) walks one row,
  payment, query or message through every component, with the real bytes,
  keys or SQL at each step and the relevant code line highlighted.
- **State scrubber** — step through the internal state of a data structure
  or protocol, including the failure case.
- **Parameter explorer** — sliders for the inputs of a formula in the post;
  the chart and the numbers update live. The formula must match the text.
- **Options compared** — the 2–3 existing ways and the chosen one, with
  benefits (green) and costs (red), the pick in orange.
- **Failure map** — the system diagram with numbered fault markers that
  match a numbered list in the text.

Do not reuse another post's widget with new labels. Do not add a figure that only restates a paragraph, a decorative figure, or
an animation that carries no information. A post with two strong figures is
better than one with six weak ones. If a post does not need a figure, say so.

Every number, byte layout, SQL statement, and behaviour shown in a figure
must be true. Check it against the source, the docs, or a script you run.
Label sample values as samples.

## Design for how people learn

Be creative. Before you build, ask what a reader's brain needs to take this
idea in, then design for that. Do not start from a widget you have seen.
Some findings from learning research to design with:

- **Working memory holds about four chunks** (Cowan, 2001). Show one new
  idea per view. Reveal detail on demand instead of all at once.
- **Words plus a picture beat either alone** (Paivio's dual coding; Mayer's
  multimedia principles). Put the label next to the thing it names, not in
  a legend far away. Do not narrate on screen what the picture already shows.
- **Signal what matters.** One highlighted thing per view. Everything else
  recedes.
- **Concrete before abstract.** Start with one real row, one real runner,
  one real question, then generalise.
- **Predict, then see** (prediction error drives learning). Let the reader
  guess before the answer appears when the answer is surprising.
- **Do, don't watch** (generation effect). Knowledge the reader produces
  sticks better than knowledge they read. Let them move the input, make the
  choice, or place themselves.
- **Retrieval beats rereading** (testing effect). A small "what happens
  if…" the reader answers can fix an idea better than a summary.
- **Segment.** Break a long process into steps the reader controls; let
  them set the pace.
- **Spatial memory is strong.** Keep a stable layout across states so the
  reader's map of the figure stays valid while the contents change.
- **Emotion and relevance.** People remember what connects to their own
  goals. Tie the figure to the reader's situation where the post allows.

A figure that follows these beats one that looks impressive. Different
posts will need different answers, so different posts should look and
behave differently.

## Match the interaction to the kind of post

Systems posts (Postgres, Temporal, TigerBeetle, Valkey) explain a
mechanism, so steppers, state scrubbers, system maps and failure maps fit.

Essays, philosophy, and advice posts (creating content, seeking help,
learning backend) make an argument about people and habits. The reader is
not tracing a request; they are testing the idea against their own life.
Steppers, system maps, and "Fig. N" technical framing are the wrong tool.
Interaction there should put the reader inside the argument, for example:

- the reader answers a few honest questions and sees where they sit in the
  post's framework, and what the post suggests for that spot
- a playable model of the post's claim, where moving one input shows the
  consequence the essay argues for
- the reader makes the choice the essay discusses and sees what follows
- a before/after the reader can toggle, when the advice is about craft

Keep it calm and in the essay's tone: typographic, light, few controls,
often `frame="none"`. One interaction that changes how the reader sees
the idea is enough. Personal and physical posts (running, stereograms)
sit in between: model the body or the eyes, but keep it human and simple.

## Writing rules (for captions, figure text, and any prose you touch)

- Simple technical English. Short sentences. Answer first.
- No slop: no "let's dive in", "the magic", "game changer", "under the hood
  of", "it's not X, it's Y", "the trick is", anaphora ("No X. No Y. No Z."),
  reveal colons, dramatic build-up, rhetorical questions, emoji in titles.
- No digs at other tools or engineers. Delete the phrase; do not replace it.
- Reasoning chain, not punchline: the conclusion follows from the steps.
- Do not over-explain. If the figure shows it, the text need not repeat it.
- Citations are bare links (`[^n]` footnotes), never "verified against".
- Name the component that actually owns a guarantee.
- Titles are humble and grounded.
- Keep a table only if it adds value.
- Keep Pratik's voice. Fix slop you find near your figures, but do not
  rewrite the post wholesale.

## How to build one

Files you own for post `<slug>` (the post's folder name under
`content/posts/`):

```txt
themes/coloroid/assets/js/viz/<slug>.js    widgets for this post only
themes/coloroid/assets/css/viz/<slug>.css  optional styles for this post only
content/posts/<slug>/                      index.md and fallback SVGs
```

Do not edit shared files (`walviz.js`, `walviz.css`, `viz/lib.js`,
`viz.html`, `baseof.html`, `AGENTS.md`). If you need a shared change, write
it in your final report instead.

Widget module:

```js
import { h, s, stepper, colorKey, codeBlock, range, register, REDUCED } from './lib.js';

function initCommitPath(fig, app) {
  // fig.dataset holds extra shortcode params (e.g. data-step="3").
  app.append(/* … */);
}

register({ 'commit-path': initCommitPath });
```

Shortcode in `index.md`:

```txt
{{< viz kind="commit-path" fig="1" title="One write, end to end"
        fallback="commit-path.svg" alt="…" caption="…" >}}
```

- `fallback` is a static SVG in the page bundle shown without JavaScript
  and in feed readers. Hand-write it with the same colours. Figures may
  share one fallback.
- Prefix every CSS class you add with `v-<short-slug>-` so posts never
  collide.
- `wide="false"` keeps a small figure in the text column.

## Check

```bash
uv run --quiet --with playwright scripts/viz-check.py <slug> --dark
```

It builds the site into `/tmp/gbh-viz/<slug>/`, loads the post at 390px and
1280px in light and dark mode, and reports unmounted figures, JS errors, and
horizontal overflow. Screenshots go to `/tmp/gbh-viz/<slug>/shots/`. Look at
them. Use every control and step, not just the first frame: write a short
Playwright snippet if you need to click through states.

## Git

Several agents work in this checkout at the same time.

- Commit only your own paths: `git add <paths>` then
  `git commit -m "..." -- <paths>`.
- Never `git add -A`, `git add .`, `git commit -a`, `git stash`,
  `git reset`, `git checkout -- .`, `git restore .`, `git rebase`, or
  `git push`.
- If `index.lock` exists, wait a few seconds and retry. Do not delete it.
- Commit as you go: one commit per figure or per logical change.
- Message style: `posts(<slug>): <what changed>` with a short body.

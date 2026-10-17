# Claudisms: words and frames to avoid

Model-written English has tells. Readers notice them and stop trusting the
text. This list covers the ones that show up in backend.how posts. Sources:
[claudisms.ai](https://claudisms.ai/),
[archiewood/claudeisms](https://github.com/archiewood/claudeisms) (word
frequencies from Claude Code sessions),
[Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing),
and Pratik's own corrections.

Rule: say the literal thing. If a word is a metaphor for a plain verb, use the
plain verb. A technical term used in its technical sense is fine. For example,
`land` is wrong for "a commit lands", but a runner's foot does land.

Run `uv run scripts/slop-check.py <slug>` to list candidates. The script finds
words, not frames, so read every sentence too.

## Figurative verbs and nouns

| Avoid | Write instead |
|---|---|
| land, lands, landed, landing (a change, a commit, an idea, an event) | arrive, reach, is written, ships in, works, is merged |
| lane, lanes (outside a real swimlane label) | row, path, track, queue |
| lives in, lives at (abstract placement) | is in, is stored in, runs in |
| sits, sit (abstract placement: "the bottleneck sits in") | is |
| shape (of the problem, of the data) | structure, form, pattern, size |
| surface, surfaces (verb) | show, report, return, expose |
| load-bearing | required, critical, the part everything depends on |
| carries, carry (an idea, a cost) | has, holds, includes, costs |
| walks, walk through (meaning "explains") | explains, shows, goes through |
| owns, own (meaning "is responsible for") | handles, is responsible for, writes |
| settles, flips, survives, kills, wins (figurative) | decides, changes, still works, stops, is better |
| gate, gates, gating (non-technical) | check, condition, blocks |
| wire, wired, wiring (non-electrical) | connect, set up, configure |
| drift (non-statistical) | change, diverge |
| harness (verb), leverage, unlock, empower, foster | use, allow, help |
| engine, physics, story, beat, move (as nouns, figurative) | name the actual thing |
| tax, pay for, buys you, for free, cheap (figurative cost) | costs, takes, adds, without extra work, fast, small |
| budget (figurative) | limit, allowance |
| the tell, the trick, the catch, the punchline | state the fact |
| verdict, decisive | result, clear |
| delve, journey, landscape, navigate, realm, tapestry, testament, pivotal, crucial, vital, robust, seamless, intricate, meticulous, interplay, nuanced | plain words or cut |

## Adverbs and hedges

`genuinely`, `honestly`, `honest`, `quietly`, `cleanly`, `crisp`, `sharp`,
`really`, `actually`, `simply`, `just`, `basically`, `truly`, `deliberately`,
`essentially`. Cut them. `silently` is fine for a real silent failure, such as
"drops the row with no error".

## Frames

These are sentence patterns. A word search does not find them, so read for them.

- **Not X but Y.** "It's not X, it's Y." "X, not Y." Say Y.
- **Reveal colon.** "The answer: X." "The problem? X." State X.
- **Announcers.** "Here's the thing", "Here's where it gets interesting",
  "The point is", "It's worth noting", "This matters", "Let's". Cut them.
- **The real X / the whole game / the most X.** These crown one item. Give
  the reason, not the crown.
- **The right X.** "The right question" or "the right tool" tells the reader
  what is correct. Say why.
- **Drama fragments.** "No locks. No waits. Just X." "That's it." Write one
  normal sentence.
- **Rule of three by habit.** Three adjectives or three clauses where one
  is enough.
- **Closing aphorism.** A one-line moral at the end of a section. Cut it.
- **Self-narrated insight.** "What surprised me most", "the part that
  stuck", "I keep coming back to". State the observation.
- **Rhetorical questions.** Answer them in a statement, or cut them.
- **Em-dash chains.** One em-dash in a paragraph is fine. Use commas or two
  sentences instead of more.
- **Reader mind-reading.** "You might think", "You're probably wondering".
  State the fact.

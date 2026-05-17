# Writing Guide for backend.how

> Distilled from Patrick Winston's MIT lecture *How to Speak* (1986–2019)
> and adapted for long-form technical blog posts. Future agents drafting
> or editing posts in `content/posts/` should read this before writing.
>
> Winston's lecture is about speaking, but ~80% of the heuristics
> translate cleanly to writing. Where they diverge, both are listed.

---

## Why this guide exists

Your success as a technical writer is determined largely — in this order —
by:

1. **Your ability to write.**
2. **Your ability to speak.**
3. **The quality of your ideas.**

Winston's order is deliberate: a great idea badly packaged loses to a
mediocre idea well packaged. Communication quality follows:

```
Q  =  K  ×  P  ×  t
       ↑      ↑     ↑
   knowledge practice  talent (small)
```

The takeaway for an agent: don't wait for inspiration. **Knowledge of
the form** (this guide) plus **deliberate practice on the artefact**
(the post) does almost all the work. Raw talent is a tiebreaker.

---

## 1. How to start a post

### Do: open with an empowerment promise

The first paragraph tells the reader **what they will know by the end
that they don't know now**. It is the reason for being here.

Good openings on this site:

- *the-tiger-style* — "TigerBeetle moves money. Money is conserved.
  Here is the style that survives at 1M TPS."
- *1b-payments-per-day* — "How a single Postgres node, a small
  outbox, and a lot of partitioning serve a billion payments a day."
- *temporal-under-the-hood* — "Workflows are not magic. By the end,
  you'll see exactly which Postgres tables Temporal touches per
  signal, and why your replay latency is what it is."

Each one is a contract with the reader.

### Don't: open with a joke, a quote, or a windup

In speaking, "people are still putting their laptops away." In
writing, the reader is *deciding whether to bounce*. The first 90
seconds — roughly the area above the fold — is the most expensive
real estate on the page. Don't spend it on:

- Generic "in today's fast-paced world…" intros.
- A wikipedia-style history of the technology.
- A joke that requires shared context to land.
- Personal preamble ("I've been meaning to write this for a while…").

Save the personal voice for the body, where it's earned.

### Bonus: tell the reader why *you* of all people

One sentence. "I shipped this on Absurd at $employer." "I broke
my own LSM read-amp number twice trying to get this wrong." This is
the *situate* move from §10 — establishing standing. Don't oversell it.

---

## 2. Four heuristics for the body

Winston names four reusable moves that work throughout a talk. They
all apply to long-form posts too.

### Cycle on the subject

Say the same idea **three times**, each time slightly differently:

1. **Plain English** — "An LSM tree gets slower as it grows because
   each lookup walks more levels."
2. **Concrete** — "At 33 GB our DB does 195 KB of disk reads per 128
   byte transfer."
3. **Mechanistic** — "Levels 0–5 each contribute a random 8 KB page
   read on a key miss; bloom filters cut most but not all of them."

Why three: at any moment ~20% of readers have fogged out. Cycling
gives every reader at least one re-entry. **Don't be afraid of
saying it again.** Subheadings, bold pull-quotes, code captions,
and figures are all legitimate cycling surfaces.

### Build a fence around your idea

State explicitly what your idea is **not**. Distinguish it from the
neighbors readers will confuse it with.

- "This isn't write amplification. Write amp is sequential and
  bandwidth-bound; **this is read amp**, random and IOPS-bound."
- "Absurd is not Temporal. It doesn't replay; it re-queues."
- "Our outbox isn't an outbox table — it's `pg_logical_emit_message`."

Each fence pre-empts the objection "wait, isn't this just X?" before
the reader writes it in the HN comments.

### Verbal punctuation (re-entry points)

Provide **landmarks where a fogged-out reader can get back on the
bus**:

- Numbered section headings ("§3. The hot path").
- Bold lede sentences at the top of long sections.
- TL;DR boxes ("If you only remember one thing: …").
- The site's section dividers (`---`) used as visual breath marks.
- Recap paragraphs ("So far we have established three things: …").

Posts > 2500 words on this site **must** have at least one mid-post
recap. Posts > 5000 words should have two.

### Ask a question (engagement)

In writing, a real question is a fork the reader walks. It works
when:

- It precedes a non-obvious answer ("So why is the cold-pull p50
  identical? Look at the layer cache.").
- It admits more than one reasonable answer, and you commit to one
  ("Which level dominates the lookup? Level 4 — and not for the
  reason you'd expect.").

Avoid rhetorical questions that the reader can't engage with —
those are filler.

---

## 3. Tools: prose, diagrams, code, props

Winston distinguishes the **blackboard** (informing/teaching) from
**slides** (exposing/showing-what-you-did). Same split applies here:

| Goal                       | Primary tool          | Secondary             |
|---|---|---|
| Teach a mechanism          | Prose with one diagram | Code block            |
| Show numbers / results     | Table or chart        | Sentence summarising  |
| Argue a position           | Prose                 | One concrete example  |
| Make the reader *feel* it  | A prop / story        | Diagram of the prop   |

### Props are the most memorable element of any post

Winston tells the story of a play where a manuscript and a glowing
stove sit on stage; tension builds until the manuscript burns. He
remembers nothing else about the play. He also remembers a physics
professor who held a wrecking ball against his nose to prove
conservation of energy.

The equivalent in our posts:

- **The duct-tape bicycle wheel** of TigerBeetle is the
  *Transfer struct*, 128 bytes. Show it. Annotate every field.
- **The pot-bellied stove** of 1B Payments is the *partition map* —
  show the partition for today, then how it ages, then how it gets
  archived.
- **The wrecking ball** of Lost SSH Access is the recovery shell
  itself — show the literal session.

A prop is one concrete, weighable object the reader can hold in
memory. Every post should have at least one. **Name it. Refer back
to it. Use it again in the conclusion.**

### Diagrams: the speed property

The speed at which you draw on a blackboard matches the speed at
which an audience absorbs ideas. In writing, the equivalent is the
**density** of the diagram. A diagram that takes 30 seconds to
absorb should sit next to 30 seconds of prose. Mermaid diagrams on
this site default to too-dense — split them.

---

## 4. The slide / figure / code-block crimes

Winston's slide crimes translate to this site's figure crimes.

### Crime 1 — too many words

Slides: > 40 words. Figures: ASCII art crammed with labels. Code
blocks: 80+ line dumps. **Cut.** A figure should have at most one
arrow per idea and one label per arrow. A code block should be the
*minimum diff* that demonstrates the point.

### Crime 2 — reading the slide

In a talk: speaker reads aloud what's on the slide. In a post: the
paragraph below the diagram reiterates the diagram's labels.

**Wrong**:

> ![diagram of LSM compaction](compaction.svg)
>
> The diagram shows L0 flushing to L1, L1 compacting to L2, L2
> compacting to L3.

**Right**:

> ![diagram of LSM compaction](compaction.svg)
>
> The interesting bit isn't the cascade — it's that L2→L3 stalls
> when the bloom filter for L3 doesn't fit in page cache.

The figure shows *what*. The prose adds *why* or *which part to
look at first*.

### Crime 3 — too heavy

Print the post and lay it on a table. (`hugo --renderToDisk` then
`Print to PDF`.) Look for **air**. A post with no white space is a
post nobody finishes. Specific signals:

- Three code blocks in a row with no prose between them.
- A 12-row table where 4 rows would prove the point.
- A 600-word paragraph. Break it.

### Crime 4 — no eye contact (the laser pointer)

In a talk: the speaker faces the screen, not the audience. In a
post: the writer makes the reader chase references ("see Appendix B
table 4"). Don't. Put the number you need next to the sentence that
uses it. Put the figure next to the prose that references it. If
you're using a footnote for an off-ramp the reader doesn't need,
delete the footnote and the off-ramp.

### Crime 5 — the once-per-paper "Apex Lon" slide

Winston: you may show *exactly one* incomprehensibly-complex slide
per talk, and only to make the point "this domain is unmanageably
complex." Our equivalent: the *one* giant 100-row table or the *one*
40-line flame-graph excerpt. **One per post.** No more.

### Font / formatting minimums

- Inline code (`like this`) for anything the reader would type.
- Fenced code blocks always specify a language (`txt` for ASCII —
  see `AGENTS.md`).
- Tables wider than 6 columns are a smell. Pivot or split.
- Avoid block-quoting more than 3 lines from another source —
  paraphrase and link instead.

---

## 5. Time, place, lighting

Winston insists on **a well-lit room, well-chosen time, half-full at
minimum**. The blog equivalents:

- **Well-lit**: light/dark theme both legible. WCAG-AA contrast on
  every page (we enforce this — see `scripts/site-quality-check.py`).
- **Well-chosen time**: don't ship posts on Friday evening. Tuesday
  morning UTC catches the EU + US workday.
- **Half-full**: don't publish until at least one trusted reader has
  read it cold. An empty room (publishing into the void without any
  pre-read) signals to the algorithm that nobody cares.

The "case the room" rule: before publishing, **build the post and
read it on a phone, on a slow connection, in dark mode, with
JavaScript off**. Lighthouse runs in CI but is no substitute.

---

## 6. Inspiring the reader

Winston surveyed freshmen, senior faculty, and everyone in between.
Inspiration came from two things, every time:

1. **Someone who helped them see a problem in a new way.**
2. **Someone who exhibited passion about what they were doing.**

Translate:

- **New way of seeing**: don't just describe what Temporal does;
  show that "a workflow is a deterministic function over an event
  log." Reframe.
- **Passion**: it's fine — encouraged — for the post to say "this
  is the coolest part" or "this took me three days to debug and I
  am still annoyed about it." The voice should be Pratik's
  (humble, balanced, not dismissive of any tool) — see
  `feedback_user_blog_voice_humble_balanced.md` in agent memory.

The thing to avoid: **flat affect**. A post that reads like a
release-note has nothing to recommend it over the release note.

---

## 7. Stories

> "We are storytelling animals. We start with fairy tales and we
> never stop."

Every technical post on this site is **at least three stories
nested**:

1. **The system's story** — what it is, what it solves, how it
   works.
2. **The investigation's story** — what we tried, what failed, what
   the bottleneck turned out to be.
3. **The reader's story** — what they should do next Monday.

If a post has only #1, it's a Wikipedia article. If it has only #2,
it's a war story without takeaway. If it has only #3, it's a tweet.
**All three together** is the form.

The TigerBeetle bottleneck post in `autoresearch.md` is a textbook
example: system → investigation → "napkin math rules things out,
measurement closes the loop."

---

## 8. Practice (and who reviews)

Winston: practice your talk, but **not in front of your collaborators**.
Collaborators *hallucinate context* that isn't in the slides. They
will tell you it's clear when it isn't.

For posts:

- Send drafts to **friends outside the specific domain**. If the
  post is on FoundationDB, send it to someone who's never read the
  FDB docs.
- Ask them: "Where did you get bored? Where did you stop and
  re-read? Where did you stop and Google something?"
- A reviewer who knows what you mean is worse than no reviewer.
- The autoresearch defect detector
  (`scripts/site-quality-check.py`) catches *syntactic* problems
  (broken anchors, missing alt text). It cannot tell you the post
  is boring. That's the human reviewer's job.

---

## 9. Job-talk structure (for showcase / capstone posts)

Some posts on this site are technical-job-talk-shaped: tiger-style,
1b-payments, fdyno, temporal. For those, Winston's job-talk advice
applies almost verbatim. **In the first 5% of the post, establish two
things**:

### Vision (the problem you care about + the new angle)

"Workflow engines mostly debate one of two questions: durable
execution vs. event-replay. The interesting question is the third
one: *does the Postgres schema force a tradeoff between the two?*"

### Done-something (the steps already taken)

"We built it. We ran 1,450 task/s through a single Postgres. We
have flamegraphs. Here they are."

If you can't do both in the first 5 minutes of reading time
(roughly the first 1000 words), the rest of the post is fighting
uphill.

### End with **contributions**, not "thanks for reading"

The closing section is mirror of the opening promise:

- **Wrong**: "Thanks for reading! Hit me up on Twitter."
- **Wrong**: "That's it. Any questions?" (we have no questions slot)
- **Wrong**: "Conclusion: workflows are hard."
- **Right**: a numbered list titled **"What this post added"** or
  **"What we showed"**, each item one line, restating the
  contributions the body actually delivered.

This is the slide that stays up while people are filing out. Make
it count.

---

## 10. Getting your work remembered: the Winston Star

For posts you want cited and shared, hit all five of these. (You
don't always need all five — but the great posts on this site hit
4–5; the forgettable posts hit 1–2.)

| Element            | What it is                                              | Site example |
|---|---|---|
| **Symbol**         | One visual or shape the reader will recall in a year.   | The Transfer struct from tiger-style. The duct-taped wheel. |
| **Slogan**         | One phrase that handles the work.                       | *"Money is conserved"* (tiger). *"Outbox without an outbox"* (pg-logical). |
| **Surprise**       | The counter-intuitive finding.                          | LSM read amp, not write amp, is the bottleneck. |
| **Salient idea**   | The *one* idea that sticks out — not the most important, the most *distinctive*. | "Near-miss learning" in Winston's own thesis. "Napkin math rules out, measurement closes the loop." |
| **Story**          | How you arrived at it, briefly.                         | "We ran the benchmark, the number looked too low, we instrumented…" |

Theses that have all five become careers. Posts that have all five
become canonical references in their niche. **Audit every draft
against this table** before publishing.

---

## 11. How to end a post

Winston dedicates the last ~10 minutes of his talk to *just the
final slide and the final words*. It is the most-watched real
estate of the entire talk, and the same is true of posts: the last
screenful is what the reader screenshots and shares.

### The final section should be titled

Use one of:

- **"What we showed"** (technical results)
- **"Takeaways"** (mechanism posts)
- **"What's next"** (sequence-of-work posts)
- **"What this post added"** (capstone / showcase)

Don't use:

- **"Conclusion"** — boring, says nothing.
- **"That's all"** / **"Fin"** / **"The End"** — wastes the
  highest-value real estate.
- **"Questions?"** — there is no questions slot; we have HN
  comments and email.
- **"Thanks for reading"** — Winston's strongest single rule:
  *don't thank the reader*. It implies they stayed out of
  politeness.

### Final words: salute, don't thank

Acceptable closings, ranked:

1. **A line that re-states the salient idea** ("And that is why
   read amp, not write amp, is what your steady-state benchmark
   measures.").
2. **A pointer to the next post** in the series (the Valkey posts
   do this; series prev/next nav is wired).
3. **A salute to the domain** ("Postgres keeps earning its
   reputation.") — Winston's "salute the audience" move,
   redirected toward the subject so it doesn't sound sycophantic.
4. **A joke** — only if you have one and it lands cold. Most don't.
   When in doubt, don't.

Never:

- Ask the reader to "subscribe", "share", or "follow."
- Apologise for length or for taking time off between posts.
- Promise a follow-up post unless one is written.

---

## 12. Pre-publish checklist

Run this before opening the PR / pushing to `main`:

- [ ] **Opening contract**: first paragraph states what the reader
      will know by the end.
- [ ] **One prop**: a concrete named object the post returns to.
- [ ] **Cycling**: the salient claim appears in ≥ 3 forms (prose,
      figure, table/code, recap).
- [ ] **Fence**: at least one explicit "this isn't X" sentence.
- [ ] **Punctuation**: re-entry landmarks every ~800 words for
      posts > 2500 words.
- [ ] **Three stories**: system + investigation + reader's
      Monday.
- [ ] **Crimes audit**: no slide-crime equivalents — figures that
      read themselves, no chase-the-reference footnotes, ≤ 1 apex-
      lon slide, no 600-word paragraph.
- [ ] **Lit room**: WCAG-AA contrast (scripts/site-quality-check.py),
      Lighthouse ≥ 85 perf on the new post.
- [ ] **Outside reviewer**: a non-domain reader has read it and
      reported where they re-read or googled.
- [ ] **Winston Star**: at least 4 of {symbol, slogan, surprise,
      salient idea, story} hit.
- [ ] **Final section** titled *"What we showed"* or similar — not
      *"Conclusion"*, not *"Thanks"*.
- [ ] **No "thanks for reading"** anywhere. No "subscribe", "share",
      "follow."

If a draft fails three or more of these, it's not ready.

---

## 13. Voice (project-specific)

These overlap with `feedback_user_blog_voice_humble_balanced.md`
in agent memory, and are mandatory regardless of Winston's
guidance:

- Humble. The author is one of many engineers who shipped this; not
  the inventor of the field.
- Balanced. Every system has tradeoffs. *Always* include a section
  titled *"What X still does better"* / *"Where this hurts"* /
  *"Limitations"*. No system is a free lunch.
- No digs. Don't bash Postgres, MySQL, MongoDB, AWS, GCP, Temporal,
  Inngest, or any specific person. Disagreement is fine; sneering
  isn't.
- No marketing voice. The post is for engineers, not procurement.
- Inline code, inline numbers, inline citations (footnotes for
  off-ramps only — see crime 4).

---

## 14. Further reading

- Winston, P. H. — *How to Speak* (MIT, video, 1986–2019). The
  source. ~60 minutes; ⭐⭐⭐⭐⭐.
- `feedback_user_blog_voice_humble_balanced.md` — site voice.
- `feedback_writing_positive_no_digs.md` — tone calibration.
- `feedback_blog_idea_taste.md` — what to write about.
- `feedback_blog_diagrams.md` — diagram standards.
- `feedback_blog_footnotes.md` — footnote restraint.
- `feedback_blog_audit_floor_then_factcheck.md` — review process.
- `AGENTS.md` — theme assignment, code-block tags.
- `scripts/site-quality-check.py` — pre-publish defect detector.

---

*This guide is a living artefact. When a new heuristic is found to
materially improve a post — measured by reader behaviour or by the
defect detector — append a section. When a rule turns out to be
local custom rather than universal, demote it to §13 (Voice).*

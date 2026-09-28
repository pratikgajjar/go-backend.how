/*
 * viz/creating-content — figures for "Creating Content".
 *
 *   revision-log  this post's own history, one version per step: when it
 *                 changed, how long after the previous version, its word
 *                 count, and the lines that changed.
 *
 * Every time, word count and line below comes from the post's git history
 * (author dates, IST) or the Hacker News API (item 40781712). Word counts
 * are whitespace tokens in the body, without front matter.
 */
import { h, s, stepper, colorKey, codeBlock, register } from './lib.js';

/* noDiff: not a commit; words is the version that was live then (6e4075b,
   21:25 on Jun 16, one link token after the Thanks commit).
   at: ISO time in IST. The HN steps use the HN API timestamps: the squashed
   commit 10f4699 that adds the quote carries an earlier author date. */
const VERSIONS = [
  {
    label: 'Draft', at: '2024-06-11T02:06:23+05:30', words: 427, ref: 'ee25357', msg: 'Publish new blog',
    title: 'First commit',
    lines: [
      'draft: «true»',
      '',
      '## What ?',
      'to write ? ⟦serveral⟧ options.',
      '',
      '## Knowledge',
      'With right amount of knowledge one can get ⟦lotter⟧ better than people with talent.',
    ],
    body: 'Headings end in <code>" ?"</code>, some sentences are half written, and some words are misspelled.',
  },
  {
    label: 'Live', at: '2024-06-11T02:15:19+05:30', words: 427, ref: 'd82539a', msg: 'Hugo use newer convention', pick: true,
    title: 'draft = false, nine minutes later',
    lines: [
      '⟦- draft: true⟧',
      '⟪+ draft = false⟫',
      "⟪+ tags = ['gyan']⟫",
      '',
      'to write ? ⟦serveral⟧ options.   // unchanged',
    ],
    body: 'The front matter moves from YAML to TOML. <span class="c-pick">With <code>draft = false</code>, Hugo builds the page for the site.</span> The text is the same 427 words, typos included.',
  },
  {
    label: 'Typos', at: '2024-06-11T03:11:22+05:30', words: 416, ref: '41b29a9', msg: 'Make it coherent',
    title: 'A reread fixes typos',
    lines: [
      '⟦- one can get lotter better than people with talent.⟧',
      '⟪+ one can get lot better than people with talent.⟫',
      '⟦- There are several benifits of writing down.⟧',
      '⟪+ There are several benefits of writing down.⟫',
      '⟦- 3. WhatsApp comminity⟧',
      '⟪+ 3. WhatsApp community⟫',
      '⟦- When one should start creating content and sharing with the world.⟧',
    ],
    body: 'Four typos fixed and one sentence cut. <code>serveral</code> and <code>pracice</code> are still there.',
  },
  {
    label: 'Rewrite', at: '2024-06-16T20:10:21+05:30', words: 640, ref: 'f77c8ad', msg: 'Fix grammer',
    title: 'Rewrite after five days',
    lines: [
      '⟦- to write ? serveral options.⟧',
      '⟪+ What should you write about? Here are several options:⟫',
      '⟦- With right amount of knowledge one can get lot better than people with talent.⟧',
      '⟪+ With the right amount of knowledge, you can surpass those with natural talent.⟫',
      '⟪+ Consider this: you chat with an Uber driver who owns an iPhone 13. …⟫',
    ],
    body: '35 of the 40 text lines change. Topic idea 4, "out of the ordinary", gets an example: the Uber driver story, now footnote 1.',
  },
  {
    label: 'Thanks', at: '2024-06-16T20:32:22+05:30', words: 658, ref: 'b58d4fe', msg: 'Add Thanks',
    title: 'Credit for the draft reader',
    lines: [
      '⟪+ **Thanks** to Vaibhav suggestions and for reading drafts.⟫',
      '// reworded at 21:22 in fd4fd36',
    ],
    body: 'Same evening. The FAQ says to have someone pre-read. Vaibhav read the drafts.',
  },
  {
    label: 'HN', at: '2024-06-25T03:55:13+05:30', words: 659, ref: 'HN 40781712', msg: 'news.ycombinator.com', noDiff: true,
    title: 'Posted to Hacker News',
    lines: [
      'title: «Role of Talent and Knowledge in Success»',
      'text:  Your success in life will be largely determined by …',
      '',
      '12:42  a reader comments:',
      '       «Nothing in this world can take the place of persistence. …»',
      '       ― Calvin Coolidge',
    ],
    body: 'About nine hours after the submission, a reader answers with a quote about persistence.',
  },
  {
    label: 'Quote', at: '2024-06-25T18:09:15+05:30', words: 729, ref: '10f4699', msg: 'HN reply at 18:09',
    title: 'The comment goes into the post',
    lines: [
      '18:09  reply: Thank you, have added in the blog.',
      '',
      '#### Talent',
      '⟪+ Consider this as gift. No?⟫',
      '⟪+ > Nothing in this world can take the place of persistence. …⟫',
    ],
    body: 'The same day, the quote from the comment is in the Talent section.',
  },
  {
    label: 'Footnotes', at: '2024-07-27T01:15:16+05:30', words: 719, ref: '8a789ef', msg: 'Use actual footnote feature :cry:',
    title: 'Real footnotes, a month later',
    lines: [
      '⟦- 4. … out of the ordinary or even simple topics. [[1]](#ref_a)⟧',
      '⟪+ 4. … out of the ordinary[^1] or even simple topics.⟫',
      '⟦- #### [1] What do you mean by out of the ordinary ? {#ref_a}⟧',
      '⟪+ [^1]:⟫',
    ],
    body: 'The hand-made <code>[1]</code> link becomes a Markdown footnote. The post is still changing 46 days after the first commit.',
  },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* Read the IST wall clock straight from the ISO string, so the reader's
   time zone does not change what the figure shows. */
function ist(iso) {
  const [, mo, d, hh, mm] = iso.match(/^\d{4}-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
  return `${MONTHS[+mo - 1]} ${+d} ${hh}:${mm}`;
}
function dur(ms) {
  const min = ms / 60000;
  if (min < 60) return `${Math.round(min)} min`;
  const hrs = min / 60;
  if (hrs < 24) return `${Math.round(hrs)} h`;
  let d = Math.floor(hrs / 24);
  let rh = Math.round(hrs - d * 24);
  if (rh === 24) { d += 1; rh = 0; }
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

const T0 = Date.parse(VERSIONS[0].at);
VERSIONS.forEach((v, i) => {
  v.t = Date.parse(v.at);
  v.gap = i ? `+${dur(v.t - Date.parse(VERSIONS[i - 1].at))}` : 'first commit';
  v.since = i ? dur(v.t - T0) : '0 min';
});

/* ------------------------------------------------------- revision log */

const W = 360;
const ROW = 46;
const TOP = 6;
const X_DOT = 108;
const X_BAR = 122;
const BAR_MAX = 184;
const WORDS_MAX = 760;

function initRevisionLog(fig, app) {
  const n = VERSIONS.length;
  const H = TOP + n * ROW;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Versions of this post with time and word count' });

  /* The spine: dashed while draft: true, green once draft = false. */
  const dy = (i) => TOP + i * ROW + 19;
  const spine = [];
  for (let i = 0; i < n - 1; i++) {
    const draft = i === 0;
    spine.push(svg.appendChild(s('line', {
      x1: X_DOT, y1: dy(i), x2: X_DOT, y2: dy(i + 1),
      class: `${draft ? 'rule-ink dash' : 'v-cc-live'} anim`,
    })));
  }

  const rows = VERSIONS.map((v, i) => {
    const y = TOP + i * ROW;
    const bw = Math.round((v.words / WORDS_MAX) * BAR_MAX);
    const g = s('g', { class: `v-cc-row${v.pick ? ' is-pick' : ''}` },
      s('rect', { class: 'v-cc-hl', x: 0, y: y + 1, width: W, height: ROW - 4 }),
      s('text', { x: 4, y: y + 16, class: 't-s t-data' }, ist(v.at)),
      s('text', { x: 4, y: y + 32, class: 't-xs t-mute' }, v.gap),
      s('text', { x: X_BAR, y: y + 15, class: `t-s t-b${v.pick ? ' t-pick' : ''}` }, `${String(i + 1).padStart(2, '0')} ${v.label}`),
      s('rect', { class: 'v-cc-bar', x: X_BAR, y: y + 22, width: bw, height: 11 }),
      s('text', { x: X_BAR + bw + 6, y: y + 32, class: 't-xs t-data' }, `${v.words} words`),
    );
    svg.insertBefore(g, spine[0] || null);
    const dot = s('circle', { cx: X_DOT, cy: dy(i), r: v.pick ? 7 : 5.5, class: 'v-cc-dot' });
    g.append(dot);
    g.style.cursor = 'pointer';
    g.addEventListener('click', () => { st.stop(); st.go(i); });
    return g;
  });
  /* Dots sit above the spine. */
  rows.forEach((g) => svg.append(g.querySelector('.v-cc-dot')));

  const head = h('h4');
  const where = h('span', { class: 'where' });
  const code = h('div');
  const note = h('p');
  const kv = h('dl', { class: 'wv-kv v-cc-kv' });
  const insp = h('div', { class: 'wv-insp v-cc-insp', 'aria-live': 'polite' }, head, code, note, kv);

  function render(i) {
    const v = VERSIONS[i];
    rows.forEach((g, k) => {
      g.classList.toggle('is-now', k === i);
      g.classList.toggle('is-future', k > i);
    });
    const dots = svg.querySelectorAll('.v-cc-dot');
    dots.forEach((d, k) => {
      d.classList.toggle('is-now', k === i);
      d.classList.toggle('is-past', k < i);
      d.classList.toggle('is-future', k > i);
      d.classList.toggle('is-pick', !!VERSIONS[k].pick);
    });
    spine.forEach((l, k) => l.classList.toggle('is-future', k >= i));

    head.replaceChildren(v.title, where);
    where.textContent = `${v.ref} · ${v.msg}`;
    code.innerHTML = codeBlock(v.lines);
    note.innerHTML = v.body;
    const prev = VERSIONS[i - 1];
    kv.replaceChildren(
      h('dt', null, 'time (IST)'), h('dd', { class: 'c-data' }, ist(v.at)),
      h('dt', null, 'since first commit'), h('dd', { class: 'c-data' }, v.since),
      h('dt', null, 'words'), h('dd', { class: 'c-data' }, prev && !v.noDiff && prev.words !== v.words ? `${prev.words} → ${v.words}` : String(v.words)),
    );
  }

  const st = stepper(fig, VERSIONS, render, { interval: 3800 });
  /* main.js turns ← → into previous/next post and does not check
     defaultPrevented; keep the keys inside the figure. */
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
  });
  app.append(
    st.el,
    h('div', { class: 'wv-split v-cc-split' }, h('div', { class: 'v-cc-log' }, svg), insp),
    colorKey([
      ['k-data', 'times and word counts'],
      ['k-look', 'version shown'],
      ['k-pick', 'draft = false: publish first'],
      ['v-cc-k-dash', 'draft: true'],
      ['k-line-green', 'draft = false'],
      ['k-gap', 'removed or misspelled'],
      ['k-held', 'added'],
    ]),
  );
  st.go(0);
}

register({ 'revision-log': initRevisionLog });

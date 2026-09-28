/*
 * Figures for "The Psychology of Seeking Help" (house style, shared parts).
 *
 *   trails     Fig. 1: five people, one failing test, what each did before
 *              asking. Ink marks, labels on the marks, the ask in purple.
 *   sorter     Fig. 2: predict then see. One sample message at a time; the
 *              reader guesses the type (ask()), then the clues are marked.
 *   last-ask   Fig. 3: the reader answers three questions (chips()) about
 *              their own last ask and draws their own line, one part each.
 *
 * Types, ratings, and traits come from the post. Messages are samples.
 */
import { h, s, btn, chips, ask, colorKey, register, esc } from './lib.js';

const ERR = 'dial tcp 127.0.0.1:5432: connect: connection refused';

/* Trail shapes, on a 0..300 scale from "problem appears" to "asks". */
const SHAPES = {
  persistent: { start: 14, marks: [[58, 18], [98, 15], [136, 12], [170, 9], [202, 7], [230, 5], [254, 4]].map(([x, t]) => ({ x, t, k: 'try' })) },
  exhausted: { start: 14, marks: [52, 82, 112, 142, 172, 202, 232, 258].map((x) => ({ x, k: 'dead' })) },
  connector: { start: 128, marks: [158, 196, 232].map((x) => ({ x, t: 12, k: 'try' })), past: true },
  direct: { start: 262, marks: [] },
  delegator: { start: 236, marks: [{ x: 258, k: 'know' }], handoff: true },
};

const NAMES = {
  persistent: 'The Persistent Problem Solver',
  exhausted: 'The Exhausted Effort',
  connector: 'The Unrelated Connector',
  direct: 'The Direct Seeker',
  delegator: 'The Delegator',
};

/** Draw a trail into group g, mapping 0..300 onto [x0, x1] at height y. */
function drawTrail(g, id, x0, x1, y, { labels = false } = {}) {
  const sh = SHAPES[id];
  const X = (v) => x0 + (v / 300) * (x1 - x0);
  const lab = (x, yy, t, anchor = 'middle') => g.append(s('text', { x, y: yy, class: 't-xs halo', 'text-anchor': anchor }, t));
  if (sh.past) {
    g.append(
      s('circle', { cx: X(40), cy: y - 14, r: 4.5, class: 'v-psh-past' }),
      s('path', { d: `M${X(46)} ${y - 13} C ${X(66)} ${y - 10}, ${X(82)} ${y - 6}, ${X(98)} ${y - 3}`, class: 'v-psh-link' }),
      s('path', { d: `M${X(107) - 4} ${y - 7} l 8 8 M${X(107) + 4} ${y - 7} l -8 8`, class: 'v-psh-mark' }),
    );
    if (labels) { lab(X(40) + 9, y - 22, 'fixed something like it before', 'start'); lab(X(107), y + 18, 'no link'); }
  }
  g.append(s('line', { x1: X(sh.start), y1: y, x2: X(279), y2: y, class: 'v-psh-line' }));
  g.append(s('circle', { cx: X(sh.start), cy: y, r: 3.5, class: 'v-psh-start' }));
  sh.marks.forEach((m, n) => {
    const x = X(m.x);
    if (m.k === 'try') g.append(s('line', { x1: x, y1: y - m.t / 2 - 2, x2: x, y2: y + m.t / 2 + 2, class: 'v-psh-mark' }));
    if (m.k === 'dead') g.append(s('path', { d: `M${x - 4} ${y - 4} l 8 8 M${x + 4} ${y - 4} l -8 8`, class: 'v-psh-mark' }));
    if (m.k === 'know') g.append(s('path', { d: `M${x - 4} ${y} l 3 4 l 6 -8`, class: 'v-psh-mark' }));
    if (labels && n === 0 && m.k === 'try' && id === 'persistent') lab(x, y - 17, 'an attempt');
    if (labels && n === 0 && m.k === 'dead') lab(x, y - 12, 'a dead end');
    if (labels && m.k === 'know') lab(x, y - 12, 'knows it');
  });
  if (labels && id === 'persistent') lab(X(sh.start), y + 18, 'problem', 'start');
  return X(288);
}

/* ================================================================ TRAILS */

function initTrails(fig, app) {
  const order = ['persistent', 'exhausted', 'connector', 'direct', 'delegator'];
  const RATE = {
    persistent: ['high', 'high'], exhausted: ['high', 'high'], connector: ['high', 'medium'], direct: ['low', 'unknown'], delegator: ['low', 'low'],
  };
  const svgs = [];
  const rows = order.map((id) => {
    const svg = s('svg', { class: 'v-psh-trail', 'aria-hidden': 'true' });
    svgs.push([id, svg]);
    const [e, d] = RATE[id];
    return h('li', { class: 'v-psh-row' },
      h('b', { class: 'v-psh-name' }, NAMES[id]),
      h('span', { class: 'v-psh-rate t-s' }, 'effort ', h('span', { class: 'c-data' }, e), ' · difficulty ',
        h('span', { class: d === 'unknown' ? 'c-bad' : 'c-data' }, d)),
      svg);
  });
  // Draw in user units close to the on-screen width, so labels keep one size.
  let drawnW = 0;
  function draw() {
    const px = svgs[0][1].getBoundingClientRect().width || 300;
    const W = Math.max(300, Math.round(px / 20) * 20);
    if (W === drawnW) return;
    drawnW = W;
    svgs.forEach(([id, svg], n) => {
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${W} 50`);
      const ax = drawTrail(svg, id, 0, W, 30, { labels: true });
      svg.append(s('text', { x: ax, y: 36, class: 't-l t-b t-look', 'text-anchor': 'middle' }, SHAPES[id].handoff ? '→' : '?'));
      if (n === 0) svg.append(s('text', { x: ax, y: 12, class: 't-xs t-b t-look', 'text-anchor': 'middle' }, 'asks'));
      if (id === 'direct') svg.append(s('text', { x: 10, y: 34, class: 't-xs' }, 'nothing tried'));
    });
  }
  app.append(
    h('div', { class: 'wv-q' }, 'Five people hit the same failing test. What did each do before asking?'),
    h('ol', { class: 'v-psh-rows' }, ...rows),
    colorKey([['k-ink', 'what they did'], ['k-look', 'the ask'], ['k-data', 'rating from the post'], ['k-gap', 'not known yet']]),
  );
  draw();
  if ('ResizeObserver' in window) new ResizeObserver(draw).observe(svgs[0][1]);
}

/* ================================================================ SORTER */

// Parts: plain strings, or [text, clue]. Backticks mark code.
const MESSAGES = [
  {
    id: 'direct', time: '10:02',
    parts: [['tests are broken', 'no detail, nothing tried'], ', ', ['can someone look?', 'expects a ready answer']],
  },
  {
    id: 'persistent', time: '10:17',
    parts: ['`go test ./...` fails on main with `' + ERR + '`. ', ['`docker ps` shows no db container.', 'checked'], ' ',
      ['`make test` stopped starting it after #412.', 'narrowed it down'], ' ', ['Was that on purpose, or should I add it back?', 'a specific question']],
  },
  {
    id: 'delegator', time: '10:40',
    parts: [['Tests need the local DB after the compose change.', 'knows the problem'], ' ',
      ['You set that up, can you sort it?', 'hands it over'], ' ', ['Not really my area.', 'outside their job']],
  },
  {
    id: 'exhausted', time: '14:55',
    parts: ['Tests fail with connection refused on 5432. ',
      ["I've restarted Docker, reinstalled Postgres, cleared the Go cache, switched branches, rebooted, and pulled main again.", 'a long list of attempts'], ' ',
      ['Been at it since morning.', 'frustrated'], ' ', ['Any idea??', 'no lead left']],
  },
  {
    id: 'connector', time: '16:20',
    parts: ['Getting connection refused on :5432 in tests. ',
      ['Feels like the Redis issue last sprint when the port changed', 'links it to an old problem'], ', ',
      ["but Redis is fine, so I'm not sure how they relate.", 'cannot connect the two']],
  },
];

const WHY = {
  persistent: 'They tried, narrowed it down, and want confirmation or a new angle.',
  exhausted: 'They tried everything and ask as a last resort, hoping for one piece of advice.',
  connector: 'They have seen something similar and need help bridging the gap.',
  direct: 'Nothing tried yet. They assume someone else can solve it faster.',
  delegator: 'They know the problem and would rather someone else did it.',
};

const PAIRS = [
  [['persistent', 'exhausted'], 'Both tried hard on a hard problem. The Persistent solver still has a lead; the Exhausted one has run out.'],
  [['direct', 'delegator'], 'Both put in little effort. The Delegator knows what the problem is; the Direct Seeker does not yet.'],
];

function codeify(text) {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((p) => (p.startsWith('`') ? h('code', null, p.slice(1, -1)) : p));
}

function initSorter(fig, app) {
  let idx = 0;
  const picks = [];
  const pos = h('span', { class: 'wv-pos' });
  const score = h('span', { class: 'v-psh-score' });
  const card = h('div', { class: 'wv-card is-data v-psh-msg' });
  const slot = h('div', { class: 'v-psh-slot' });
  const next = btn('Next message ▶', () => go(idx + 1));
  const again = btn('↻ Try again', () => { picks.length = 0; go(0); });

  function renderMsg(m, revealed) {
    card.replaceChildren(
      h('h5', null, '#backend', h('span', { class: 'v-psh-meta' }, ` · ${m.time} · sample`)),
      h('p', { class: 'v-psh-body' }, ...m.parts.map((p) => {
        if (typeof p === 'string') return codeify(p);
        const [txt, clue] = p;
        return revealed
          ? h('span', null, h('mark', { class: 'v-psh-clue' }, ...codeify(txt)), h('span', { class: 'c-look t-xs t-up' }, ` ${clue} `))
          : h('span', null, ...codeify(txt));
      })));
  }

  function tally() {
    const right = picks.filter((p, k) => p === MESSAGES[k].id).length;
    score.textContent = picks.length ? `${right} of ${picks.filter((p) => p != null).length} right` : '';
  }

  function go(n) {
    if (n >= MESSAGES.length) return finish();
    idx = n;
    const m = MESSAGES[idx];
    renderMsg(m, false);
    pos.textContent = `${idx + 1} / ${MESSAGES.length}`;
    const q = ask('Who wrote this?', Object.keys(NAMES).map((id) => [id, NAMES[id].replace(/^The /, '')]), m.id, (v, right) => {
      picks[idx] = v;
      renderMsg(m, true);
      tally();
      next.hidden = false;
      next.textContent = idx === MESSAGES.length - 1 ? 'See the result ▶' : 'Next message ▶';
      const pair = PAIRS.find(([ids]) => ids.includes(v) && ids.includes(m.id) && !right);
      return `<b>${right ? 'Yes.' : `This one is ${esc(NAMES[m.id])}.`}</b> ${esc(WHY[m.id])}${pair ? `<br>${esc(pair[1])}` : ''}`;
    });
    slot.replaceChildren(q.el);
    next.hidden = true;
    again.hidden = true;
    tally();
  }

  function finish() {
    const right = picks.filter((p, k) => p === MESSAGES[k].id).length;
    pos.textContent = 'done';
    card.className = 'wv-card v-psh-msg';
    card.replaceChildren(h('h5', null, `${right} of ${MESSAGES.length} placed`),
      h('p', { class: 'v-psh-body' }, 'Every message was about the same failing test. What changed was what the person had done before they wrote it, and that is what the reply should answer.'));
    slot.replaceChildren();
    next.hidden = true;
    again.hidden = false;
  }

  app.append(
    h('div', { class: 'wv-bar' }, h('span', { class: 'c-opt t-up t-xs' }, 'Message'), pos, h('span', { class: 'wv-sp' }), score),
    card,
    h('div', { class: 'v-psh-gap' }),
    slot,
    h('div', { class: 'wv-bar' }, next, again),
    colorKey([['k-data', 'the message (sample)'], ['k-look', 'what gives it away'], ['k-held', 'the right type'], ['k-gap', 'your wrong guess']]),
  );
  go(0);
}

/* ============================================================= LAST ASK */

const QUESTIONS = [
  {
    id: 'seeker', q: 'Before you asked, what had you done?',
    options: [
      ['direct', 'Nothing yet. I asked as soon as it broke.'],
      ['delegator', 'Nothing. I knew what it needed, but someone else is faster at it, or it is not my job.'],
      ['connector', 'A little. It looked like something I had fixed before, but I could not connect the two.'],
      ['persistent', 'Several things. I had narrowed it down and wanted a second opinion.'],
      ['exhausted', 'Everything I could think of. I was out of ideas.'],
    ],
  },
  {
    id: 'reaction', q: 'When the fix came, what did you do?',
    options: [
      ['inquisitive', 'Asked why it broke, and how to stop it happening again.'],
      ['solution', 'Applied it and got back to work.'],
      ['disinterested', 'Let them sort it out. I needed it working, not explained.'],
    ],
  },
  {
    id: 'channel', q: 'Where did you ask?',
    options: [
      ['call', 'A phone or WhatsApp call.'],
      ['dm', 'A direct message or personal email.'],
      ['public', 'A public channel.'],
    ],
  },
];

const REACT = {
  inquisitive: { name: 'Inquisitive Learner', end: 1, note: 'you learn why; next time you may not need to ask' },
  solution: { name: 'Solution Seeker', end: 0.5, note: 'fixed; the why stays with them' },
  disinterested: { name: 'Disinterested', end: 0.3, note: 'fixed by them; if it breaks, ask again' },
};
const CHAN = {
  call: { n: 1, note: 'a call: stops them now, nothing written' },
  dm: { n: 1, note: 'a DM: one reader, stays private' },
  public: { n: 5, note: 'public: anyone free answers, searchable later' },
};
const NEXT = {
  seeker: {
    exhausted: 'Ask a little earlier, while you still have a lead. Keep the list of what you tried.',
    connector: 'Name the earlier problem in your message. It gives the helper the link to check.',
    direct: 'Spend a few minutes first. Reproduce it and read the error, so you can say how hard it is.',
    delegator: 'Say plainly that you are handing it over, and why. Then it reads as a request.',
  },
  reaction: {
    solution: 'When the fix comes, ask why it broke. Then the fix stays with you too.',
    disinterested: 'When the fix comes, ask one question about why it broke. Then the next one is yours to fix.',
  },
  channel: {
    call: 'Post the same question in a public channel. No one has to stop, and the answer stays for the next person.',
    dm: 'Post the same message in a public channel. Anyone free can answer, and the next person can find it.',
  },
};

function wrapText(g, x, y, text, max, cls, anchor = 'start') {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  const t = s('text', { x, y, class: cls, 'text-anchor': anchor });
  lines.forEach((ln, k) => t.append(s('tspan', { x, dy: k ? '1.25em' : 0 }, ln)));
  g.append(t);
}

function initLastAsk(fig, app) {
  const ans = {};
  let last = null; // the part drawn last is the one highlight
  const stage = h('div', { class: 'v-psh-stage' });
  const qs = h('div', { class: 'v-psh-qs' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });

  function draw() {
    const W = stage.clientWidth < 520 ? 340 : 560;
    const H = 214;
    const x0 = 14; const xq = Math.round(W * 0.5); const xe = W - 14; const y = 100;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'v-psh-own', role: 'img', 'aria-label': 'Your line, drawn from your answers' });
    const layer = (id) => { const g = s('g', { class: `v-psh-part${last === id ? ' is-new' : ''}` }); svg.append(g); return g; };
    const max = W < 400 ? 22 : 34;

    svg.append(
      s('text', { x: x0, y: y + 30, class: 't-xs t-mute' }, 'before'),
      s('text', { x: xe, y: y + 30, class: 't-xs t-mute', 'text-anchor': 'end' }, 'after the fix'),
    );
    if (!ans.seeker) svg.append(s('line', { x1: x0, y1: y, x2: xq - 12, y2: y, class: 'rule dash' }));
    if (!ans.reaction) svg.append(s('line', { x1: xq + 12, y1: y, x2: xe, y2: y, class: 'rule dash' }));
    svg.append(s('text', { x: xq, y: y + 7, class: 't-xl t-b', 'text-anchor': 'middle' }, '?'));
    svg.append(s('text', { x: xq, y: y - 18, class: 't-xs', 'text-anchor': 'middle' }, 'you ask'));

    if (ans.seeker) {
      const g = layer('seeker');
      drawTrail(g, ans.seeker, x0, xq - 6, y);
      wrapText(g, x0, 18, NAMES[ans.seeker], max, 't-s t-b');
    }
    if (ans.reaction) {
      const g = layer('reaction');
      const r = REACT[ans.reaction];
      const x1 = xq + 12 + (xe - xq - 12) * r.end;
      g.append(s('line', { x1: xq + 12, y1: y, x2: x1, y2: y, class: `v-psh-line${ans.reaction === 'disinterested' ? ' dash' : ''}` }));
      if (ans.reaction === 'inquisitive') g.append(s('line', { x1: (xq + x1) / 2, y1: y - 7, x2: (xq + x1) / 2, y2: y + 7, class: 'v-psh-mark' }));
      g.append(s('circle', { cx: x1, cy: y, r: 4.5, class: ans.reaction === 'disinterested' ? 'v-psh-start' : 'v-psh-end' }));
      wrapText(g, xe, 18, r.name, max, 't-s t-b', 'end');
      wrapText(g, xe, 36, r.note, max, 't-xs', 'end');
    }
    if (ans.channel) {
      const g = layer('channel');
      const c = CHAN[ans.channel];
      const py = y + 70;
      const xs = c.n === 1 ? [xq] : [-2, -1, 0, 1, 2].map((k) => xq + k * (W < 400 ? 22 : 30));
      xs.forEach((px) => g.append(
        s('line', { x1: xq, y1: y + 12, x2: px, y2: py - 7, class: 'v-psh-line' }),
        s('circle', { cx: px, cy: py, r: 6, class: 'v-psh-start' })));
      if (ans.channel === 'call') g.append(s('text', { x: xq + 12, y: py - 10, class: 't-s t-b' }, '!'));
      wrapText(g, xs[0] - 12, py - 4, c.note, W < 400 ? 18 : 26, 't-xs', 'end');
    }
    stage.replaceChildren(svg);
  }

  function renderNote() {
    if (!(ans.seeker && ans.reaction && ans.channel)) { note.hidden = true; return; }
    const t = NEXT.channel[ans.channel] || NEXT.seeker[ans.seeker] || NEXT.reaction[ans.reaction];
    note.hidden = false;
    note.className = `wv-note${t ? '' : ' is-good'}`;
    note.replaceChildren(h('span', { class: 'k' }, 'Next time'),
      t || 'You bring what you tried, learn why it broke, and leave the answer where the next person can find it. That is the pattern the post describes.');
  }

  // One question at a time; answered ones stay visible and editable.
  const blocks = QUESTIONS.map((qq, n) => {
    const c = chips(qq.options, (v) => {
      ans[qq.id] = v; last = qq.id;
      if (blocks[n + 1]) blocks[n + 1].hidden = false;
      draw(); renderNote();
    }, { label: qq.q });
    const el = h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, `${n + 1}. ${qq.q}`), c.el);
    el.hidden = n > 0;
    qs.append(el);
    return el;
  });

  app.append(
    h('div', { class: 'wv-q' }, 'Think of the last time you asked someone for help at work. Each answer draws one part of your line.'),
    stage,
    h('div', { class: 'v-psh-gap' }),
    qs,
    note,
    colorKey([['k-opt', 'your answer'], ['k-look', 'the part you just drew'], ['k-ink', 'your line so far']]),
  );
  draw(); renderNote();
  if ('ResizeObserver' in window) {
    let w = null;
    new ResizeObserver(() => { const nw = stage.clientWidth < 520; if (nw !== w) { w = nw; draw(); } }).observe(stage);
  }
}

register({ trails: initTrails, sorter: initSorter, 'last-ask': initLastAsk });

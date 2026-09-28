/*
 * Figures for "The Psychology of Seeking Help".
 *
 *   trails     hero: five people, one failing test, what each did before
 *              asking. Labels sit on the marks; the ask is the only colour.
 *   sorter     retrieval: the reader reads one message at a time, guesses
 *              who wrote it, then sees the phrases that give it away.
 *   last-ask   relevance: the reader answers three questions about their
 *              own last ask and draws their own line, one part per answer.
 *
 * Types, ratings, and traits come from the post. Messages are samples.
 */
import { h, s, register, REDUCED } from './lib.js';

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
  const lab = (x, yy, t, anchor = 'middle') => g.append(s('text', { x, y: yy, class: 'v-psh-tl', 'text-anchor': anchor }, t));
  if (sh.past) {
    g.append(
      s('circle', { cx: X(40), cy: y - 14, r: 4.5, class: 'v-psh-past' }),
      s('path', { d: `M${X(46)} ${y - 13} C ${X(66)} ${y - 10}, ${X(82)} ${y - 6}, ${X(98)} ${y - 3}`, class: 'v-psh-link' }),
      s('path', { d: `M${X(107) - 4} ${y - 7} l 8 8 M${X(107) + 4} ${y - 7} l -8 8`, class: 'v-psh-x' }),
    );
    if (labels) { lab(X(40) + 9, y - 22, 'fixed something like it before', 'start'); lab(X(107), y + 18, 'no link'); }
  }
  g.append(s('line', { x1: X(sh.start), y1: y, x2: X(279), y2: y, class: 'v-psh-line' }));
  g.append(s('circle', { cx: X(sh.start), cy: y, r: 3.5, class: 'v-psh-start' }));
  sh.marks.forEach((m, n) => {
    const x = X(m.x);
    if (m.k === 'try') g.append(s('line', { x1: x, y1: y - m.t / 2 - 2, x2: x, y2: y + m.t / 2 + 2, class: 'v-psh-try' }));
    if (m.k === 'dead') g.append(s('path', { d: `M${x - 4} ${y - 4} l 8 8 M${x + 4} ${y - 4} l -8 8`, class: 'v-psh-try' }));
    if (m.k === 'know') g.append(s('path', { d: `M${x - 4} ${y} l 3 4 l 6 -8`, class: 'v-psh-know' }));
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
      h('span', { class: 'v-psh-name' }, NAMES[id]),
      h('span', { class: 'v-psh-rate' }, `effort ${e} · difficulty ${d}`),
      svg);
  });
  // Draw in user units close to the on-screen width, so labels keep one size.
  let drawnW = 0;
  function draw() {
    const px = svgs[0][1].getBoundingClientRect().width || 300;
    const W = Math.max(300, Math.round(px / 1.15 / 20) * 20);
    if (W === drawnW) return;
    drawnW = W;
    svgs.forEach(([id, svg], n) => {
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${W} 50`);
      const ax = drawTrail(svg, id, 0, W, 30, { labels: true });
      svg.append(s('text', { x: ax, y: 36, class: 'v-psh-ask', 'text-anchor': 'middle' }, SHAPES[id].handoff ? '→' : '?'));
      if (n === 0) svg.append(s('text', { x: ax, y: 12, class: 'v-psh-tl v-psh-tl-ask', 'text-anchor': 'middle' }, 'asks'));
      if (id === 'direct') svg.append(s('text', { x: 10, y: 34, class: 'v-psh-tl v-psh-tl-empty' }, 'nothing tried'));
    });
  }
  app.append(
    h('p', { class: 'v-psh-kicker' }, 'Five people hit the same failing test.'),
    h('ol', { class: 'v-psh-rows' }, ...rows),
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

  const dots = h('div', { class: 'v-psh-dots', 'aria-hidden': 'true' });
  const count = h('span', { class: 'v-psh-count' });
  const msg = h('div', { class: 'v-psh-msg' });
  const choices = h('div', { class: 'v-psh-choices', role: 'group', 'aria-label': 'Who wrote this?' });
  const verdict = h('p', { class: 'v-psh-verdict', 'aria-live': 'polite' });
  const prompt = h('p', { class: 'v-psh-prompt' }, 'Who wrote this?');
  const next = h('button', { type: 'button', class: 'v-psh-next', onclick: () => go(idx + 1) });

  const btns = Object.keys(NAMES).map((id) => {
    const b = h('button', { type: 'button', class: 'v-psh-choice', onclick: () => pick(id) }, NAMES[id].replace(/^The /, ''));
    b.dataset.id = id;
    choices.append(b);
    return b;
  });

  function renderMsg(m, revealed) {
    msg.replaceChildren(
      h('div', { class: 'v-psh-meta' }, h('b', null, '#backend'), ` · ${m.time} · sample`),
      h('p', { class: 'v-psh-body' }, ...m.parts.map((p) => {
        if (typeof p === 'string') return codeify(p);
        const [t, clue] = p;
        return revealed
          ? h('span', { class: 'v-psh-clue' }, h('mark', null, ...codeify(t)), h('span', { class: 'v-psh-cl' }, clue))
          : h('span', null, ...codeify(t));
      })));
  }

  function renderDots() {
    dots.replaceChildren(...MESSAGES.map((m, k) => h('i', {
      class: k === idx ? 'is-now' : picks[k] == null ? '' : picks[k] === m.id ? 'is-ok' : 'is-miss',
    })));
  }

  function go(n) {
    if (n >= MESSAGES.length) return finish();
    idx = n;
    const m = MESSAGES[idx];
    renderMsg(m, false);
    count.textContent = `Message ${idx + 1} of ${MESSAGES.length}`;
    btns.forEach((b) => { b.disabled = false; b.className = 'v-psh-choice'; });
    choices.hidden = false;
    verdict.replaceChildren();
    prompt.hidden = false;
    next.hidden = true;
    renderDots();
  }

  function pick(id) {
    const m = MESSAGES[idx];
    picks[idx] = id;
    const ok = id === m.id;
    renderMsg(m, true);
    btns.forEach((b) => {
      b.disabled = true;
      if (b.dataset.id === m.id) b.classList.add('is-right');
      else if (b.dataset.id === id) b.classList.add('is-wrong');
    });
    const pair = PAIRS.find(([ids]) => ids.includes(id) && ids.includes(m.id) && id !== m.id);
    verdict.replaceChildren(...[
      h('b', null, ok ? 'Yes. ' : `This one is ${NAMES[m.id]}. `),
      WHY[m.id],
      pair ? h('span', { class: 'v-psh-pair' }, pair[1]) : null].filter(Boolean));
    next.textContent = idx === MESSAGES.length - 1 ? 'See how you did →' : 'Next message →';
    next.hidden = false;
    renderDots();
    next.focus({ preventScroll: true });
  }

  function finish() {
    idx = MESSAGES.length;
    const right = picks.filter((p, k) => p === MESSAGES[k].id).length;
    renderDots();
    count.textContent = 'Done';
    choices.hidden = true;
    prompt.hidden = true;
    next.hidden = true;
    msg.replaceChildren(h('p', { class: 'v-psh-score' }, h('b', null, `${right} of ${MESSAGES.length}`), ' placed.'),
      h('p', { class: 'v-psh-body' }, 'Every message was about the same failing test. What changed was what the person had done before they wrote it, and that is what the reply should answer.'));
    verdict.replaceChildren(h('button', { type: 'button', class: 'v-psh-next', onclick: () => { picks.length = 0; go(0); } }, '↺ Try again'));
  }

  app.append(
    h('div', { class: 'v-psh-top' }, count, dots),
    msg,
    prompt,
    choices,
    verdict,
    h('div', { class: 'v-psh-foot' }, next),
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
  let open = 0;
  let last = null; // id of the part drawn last: the one highlight
  const stage = h('div', { class: 'v-psh-stage' });
  const qwrap = h('div', { class: 'v-psh-qs' });
  const nextBox = h('p', { class: 'v-psh-nextbox', 'aria-live': 'polite' });

  function draw() {
    const W = stage.clientWidth < 520 ? 340 : 560;
    const H = 214;
    const x0 = 14; const xq = Math.round(W * 0.5); const xe = W - 14; const y = 100;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'v-psh-own', role: 'img', 'aria-label': 'Your line, drawn from your answers' });
    const layer = (id) => { const g = s('g', { class: `v-psh-part${last === id ? ' is-new' : ''}` }); svg.append(g); return g; };
    const max = W < 400 ? 22 : 34;

    // placeholders keep the map stable before any answer
    svg.append(
      s('text', { x: x0, y: y + 30, class: 'v-psh-tl v-psh-dim' }, 'before'),
      s('text', { x: xe, y: y + 30, class: 'v-psh-tl v-psh-dim', 'text-anchor': 'end' }, 'after the fix'),
    );
    if (!ans.seeker) svg.append(s('line', { x1: x0, y1: y, x2: xq - 12, y2: y, class: 'v-psh-ghost' }));
    if (!ans.reaction) svg.append(s('line', { x1: xq + 12, y1: y, x2: xe, y2: y, class: 'v-psh-ghost' }));

    // the ask
    svg.append(s('text', { x: xq, y: y + 6, class: 'v-psh-ask', 'text-anchor': 'middle' }, '?'));
    svg.append(s('text', { x: xq, y: y - 16, class: 'v-psh-tl', 'text-anchor': 'middle' }, 'you ask'));

    if (ans.seeker) {
      const g = layer('seeker');
      drawTrail(g, ans.seeker, x0, xq - 6, y);
      wrapText(g, x0, 18, NAMES[ans.seeker], max, 'v-psh-tname');
    }
    if (ans.reaction) {
      const g = layer('reaction');
      const r = REACT[ans.reaction];
      const x1 = xq + 12 + (xe - xq - 12) * r.end;
      g.append(s('line', { x1: xq + 12, y1: y, x2: x1, y2: y, class: `v-psh-line${ans.reaction === 'disinterested' ? ' v-psh-dash' : ''}` }));
      if (ans.reaction === 'inquisitive') g.append(s('line', { x1: (xq + x1) / 2, y1: y - 7, x2: (xq + x1) / 2, y2: y + 7, class: 'v-psh-try' }));
      g.append(s('circle', { cx: x1, cy: y, r: 4.5, class: ans.reaction === 'disinterested' ? 'v-psh-start' : 'v-psh-end' }));
      wrapText(g, xe, 18, r.name, max, 'v-psh-tname', 'end');
      wrapText(g, xe, 36, r.note, max, 'v-psh-tl', 'end');
    }
    if (ans.channel) {
      const g = layer('channel');
      const c = CHAN[ans.channel];
      const py = y + 70;
      const xs = c.n === 1 ? [xq] : [-2, -1, 0, 1, 2].map((k) => xq + k * (W < 400 ? 22 : 30));
      xs.forEach((px) => g.append(
        s('line', { x1: xq, y1: y + 10, x2: px, y2: py - 7, class: 'v-psh-reach' }),
        s('circle', { cx: px, cy: py, r: 6, class: 'v-psh-person' })));
      if (ans.channel === 'call') g.append(s('text', { x: xq + 12, y: py - 10, class: 'v-psh-tl v-psh-bang' }, '!'));
      const lx = xs[0] - 12;
      wrapText(g, lx, py - 4, c.note, W < 400 ? 18 : 26, 'v-psh-tl', 'end');
    }
    stage.replaceChildren(svg);
  }

  function nextLine() {
    if (!(ans.seeker && ans.reaction && ans.channel)) { nextBox.replaceChildren(); return; }
    const t = NEXT.channel[ans.channel] || NEXT.seeker[ans.seeker] || NEXT.reaction[ans.reaction]
      || 'You bring what you tried, learn why it broke, and leave the answer where the next person can find it. That is the pattern the post describes.';
    nextBox.replaceChildren(h('b', null, 'Next time. '), t);
  }

  function renderQs() {
    qwrap.replaceChildren(...QUESTIONS.map((qq, n) => {
      if (n !== open) {
        const got = ans[qq.id];
        if (!got) return n < open ? null : h('p', { class: 'v-psh-qline is-todo' }, h('span', { class: 'v-psh-num' }, `${n + 1}`), qq.q);
        const label = qq.options.find(([v]) => v === got)[1];
        return h('p', { class: 'v-psh-qline' }, h('span', { class: 'v-psh-num' }, `${n + 1}`),
          h('span', { class: 'v-psh-got' }, label),
          h('button', { type: 'button', class: 'v-psh-change', onclick: () => { open = n; renderQs(); } }, 'change'));
      }
      return h('fieldset', { class: 'v-psh-q' },
        h('legend', null, h('span', { class: 'v-psh-num' }, `${n + 1}`), qq.q),
        ...qq.options.map(([val, label]) => h('button', {
          type: 'button', class: 'v-psh-opt', 'aria-pressed': String(ans[qq.id] === val),
          onclick: () => {
            ans[qq.id] = val; last = qq.id;
            const nxt = QUESTIONS.findIndex((q2) => !ans[q2.id]);
            open = nxt;
            renderQs(); draw(); nextLine();
          },
        }, label)));
    }));
  }

  app.append(
    h('p', { class: 'v-psh-intro' }, 'Think of the last time you asked someone for help at work. Each answer draws one part of your line.'),
    stage, qwrap, nextBox);
  renderQs();
  draw();
  if ('ResizeObserver' in window) {
    let w = 0;
    new ResizeObserver(() => { const nw = stage.clientWidth < 520; if (nw !== w) { w = nw; draw(); } }).observe(stage);
  }
  if (REDUCED) stage.classList.add('is-still');
}

register({ trails: initTrails, sorter: initSorter, 'last-ask': initLastAsk });

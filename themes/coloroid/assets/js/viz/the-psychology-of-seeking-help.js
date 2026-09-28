/*
 * Figures for "The Psychology of Seeking Help".
 *
 *   trails     hero: what each help seeker did before asking
 *   last-ask   the reader answers three questions about the last time they
 *              asked for help and reads which seeker, which reaction, and
 *              which channel that was, with what the post suggests
 *
 * Ratings and traits come from the post.
 */
import { h, s, register } from './lib.js';

/* ================================================================ TRAILS */

// x runs from 0 (problem appears) to 300 (asks). Every ask sits at x = 288.
const ASK_X = 288;
const TRAILS = [
  {
    name: 'The Persistent Problem Solver', effort: 'high', diff: 'high', start: 14,
    // narrowing attempts: taller ticks first, shorter as the issue narrows
    marks: [[58, 18], [98, 15], [136, 12], [170, 9], [202, 7], [230, 5], [254, 4]].map(([x, t]) => ({ x, t, kind: 'try' })),
    note: 'narrowed it down',
  },
  {
    name: 'The Exhausted Effort', effort: 'high', diff: 'high', start: 14,
    marks: [52, 82, 112, 142, 172, 202, 232, 258].map((x) => ({ x, kind: 'dead' })),
    note: 'out of ideas',
  },
  {
    name: 'The Unrelated Connector', effort: 'high', diff: 'medium', start: 128,
    marks: [158, 196, 232].map((x) => ({ x, t: 12, kind: 'try' })),
    past: true,
    note: 'solved something like it before',
  },
  {
    name: 'The Direct Seeker', effort: 'low', diff: 'unknown', start: 262,
    marks: [],
    note: 'asked right away',
  },
  {
    name: 'The Delegator', effort: 'low', diff: 'low', start: 236,
    marks: [{ x: 258, kind: 'know' }],
    handoff: true,
    note: 'knows it, hands it off',
  },
];

function trailSvg(t) {
  const y = 22;
  const g = s('svg', { viewBox: '0 0 300 40', class: 'v-psh-trail', 'aria-hidden': 'true' });
  // the past problem the connector half-remembers
  if (t.past) {
    g.append(
      s('circle', { cx: 40, cy: 8, r: 4.5, class: 'v-psh-past' }),
      s('path', { d: 'M46 9 C 66 12, 82 16, 98 19', class: 'v-psh-link' }),
      s('path', { d: 'M103 15 l 8 8 M111 15 l -8 8', class: 'v-psh-x' }),
    );
  }
  g.append(
    s('line', { x1: t.start, y1: y, x2: ASK_X - 9, y2: y, class: 'v-psh-line' }),
    s('circle', { cx: t.start, cy: y, r: 3.5, class: 'v-psh-start' }),
  );
  for (const m of t.marks) {
    if (m.kind === 'try') g.append(s('line', { x1: m.x, y1: y - m.t / 2 - 2, x2: m.x, y2: y + m.t / 2 + 2, class: 'v-psh-try' }));
    if (m.kind === 'dead') g.append(s('path', { d: `M${m.x - 4} ${y - 4} l 8 8 M${m.x + 4} ${y - 4} l -8 8`, class: 'v-psh-x' }));
    if (m.kind === 'know') g.append(s('path', { d: `M${m.x - 4} ${y} l 3 4 l 6 -8`, class: 'v-psh-know' }));
  }
  g.append(t.handoff
    ? s('text', { x: ASK_X, y: y + 5, class: 'v-psh-ask', 'text-anchor': 'middle' }, '→')
    : s('text', { x: ASK_X, y: y + 5.5, class: 'v-psh-ask', 'text-anchor': 'middle' }, '?'));
  return g;
}

function initTrails(fig, app) {
  const rows = TRAILS.map((t) => h('li', { class: 'v-psh-row' },
    h('div', { class: 'v-psh-who' },
      h('span', { class: 'v-psh-name' }, t.name),
      h('span', { class: 'v-psh-rate' },
        'effort ', h('b', null, t.effort), ' · difficulty ', h('b', { class: t.diff === 'unknown' ? 'v-psh-unk' : '' }, t.diff))),
    h('div', { class: 'v-psh-path' }, trailSvg(t), h('span', { class: 'v-psh-note' }, t.note))));
  app.append(
    h('p', { class: 'v-psh-kicker' }, 'What happened before the question'),
    h('div', { class: 'v-psh-axis', 'aria-hidden': 'true' }, h('span', null, 'problem appears'), h('span', null, 'asks')),
    h('ol', { class: 'v-psh-rows' }, ...rows),
    h('p', { class: 'v-psh-legend' },
      h('span', null, h('i', { class: 'l-try' }), 'an attempt'),
      h('span', null, h('i', { class: 'l-dead' }, '×'), 'a dead end'),
      h('span', null, h('i', { class: 'l-past' }), 'solved before'),
      h('span', null, h('i', { class: 'l-ask' }, '?'), 'the ask')),
  );
}

/* ============================================================= LAST ASK */

const QUESTIONS = [
  {
    id: 'seeker',
    q: 'Before you asked, what had you done?',
    options: [
      ['direct', 'Nothing yet. I asked as soon as it broke.'],
      ['delegator', 'Nothing. I knew what it needed, but someone else is faster at it, or it is not my job.'],
      ['connector', 'A little. It looked like something I had fixed before, but I could not connect the two.'],
      ['persistent', 'Several things. I had narrowed it down and wanted a second opinion.'],
      ['exhausted', 'Everything I could think of. I was out of ideas.'],
    ],
  },
  {
    id: 'reaction',
    q: 'When the fix came, what did you do?',
    options: [
      ['inquisitive', 'Asked why it broke, and how to stop it happening again.'],
      ['solution', 'Applied it and got back to work.'],
      ['disinterested', 'Let them sort it out. I needed it working, not explained.'],
    ],
  },
  {
    id: 'channel',
    q: 'Where did you ask?',
    options: [
      ['call', 'A phone or WhatsApp call.'],
      ['dm', 'A direct message or personal email.'],
      ['public', 'A public channel.'],
    ],
  },
];

const SEEKER = {
  persistent: {
    name: 'The Persistent Problem Solver', rate: 'effort high, difficulty high',
    you: 'You narrowed the issue down first, and came for confirmation or a new angle.',
    helper: 'The person helping you starts where you stopped, because you told them what you tried.',
    next: 'Keep doing this. Put what you tried in the first message.',
  },
  exhausted: {
    name: 'The Exhausted Effort', rate: 'effort high, difficulty high',
    you: 'You tried everything and asked as a last resort, hoping for the one piece of advice that works.',
    helper: 'The person helping you gets a long list of failed fixes and has to find the one that was close.',
    next: 'Ask a little earlier, while you still have a lead. Keep the list of what you tried; it is the useful part.',
  },
  connector: {
    name: 'The Unrelated Connector', rate: 'effort high, difficulty medium',
    you: 'You had solved something like this before, but could not link the two.',
    helper: 'The person helping you mostly supplies context: how this problem relates to the one you already know.',
    next: 'Name the earlier problem in your message. It gives the helper the link to check.',
  },
  direct: {
    name: 'The Direct Seeker', rate: 'effort low, difficulty unknown',
    you: 'You asked before finding out how hard the problem was, assuming someone else could solve it faster.',
    helper: 'The person helping you starts from zero. It may take them a minute, or it may be much harder than either of you expected.',
    next: 'Spend a few minutes first. Reproduce it and read the error, so you can say how hard it is.',
  },
  delegator: {
    name: 'The Delegator', rate: 'effort low, difficulty low',
    you: 'You knew the problem and passed it on, because someone else is faster or it sat outside your job.',
    helper: 'The person helping you does the work, not just the explaining.',
    next: 'Say plainly that you are handing it over, and why. Then it reads as a request, not a question.',
  },
};

const REACTION = {
  inquisitive: {
    name: 'The Inquisitive Learner',
    you: 'You asked about the details and how to prevent a repeat. The next time this breaks, you may not need to ask.',
  },
  solution: {
    name: 'The Solution Seeker',
    you: 'You took the fix and moved on. The problem is gone for now, but the knowledge stayed with the person who fixed it.',
  },
  disinterested: {
    name: 'The Disinterested',
    you: 'You wanted it resolved and left the details to someone else. If it breaks again, you will need the same help again.',
  },
};

const CHANNEL = {
  call: {
    name: 'a call', tone: 'bad',
    you: 'A call stops the other person right away, and the answer is not written down anywhere.',
    next: 'The post suggests a message in a public channel instead.',
  },
  dm: {
    name: 'a direct message', tone: 'bad',
    you: 'A message does not stop anyone, but only one person sees it. If they are busy, you wait, and the answer stays private.',
    next: 'The post suggests the same message in a public channel instead.',
  },
  public: {
    name: 'a public channel', tone: 'good',
    you: 'Anyone who is free can answer, no one has to stop work, and the next person can find the answer by search.',
    next: 'Keep asking there. This is what the post recommends.',
  },
};

function initLastAsk(fig, app) {
  const picked = {};
  const reading = h('div', { class: 'v-psh-reading', 'aria-live': 'polite' });

  const qs = QUESTIONS.map((qq, n) => {
    const name = `v-psh-${qq.id}-${Math.random().toString(36).slice(2, 7)}`;
    return h('fieldset', { class: 'v-psh-q' },
      h('legend', null, h('span', { class: 'v-psh-num' }, `${n + 1}`), qq.q),
      ...qq.options.map(([val, label]) => h('label', { class: 'v-psh-opt' },
        h('input', { type: 'radio', name, value: val, onchange: () => { picked[qq.id] = val; render(); } }),
        h('span', null, label))));
  });

  const para = (label, text, cls = '') => h('p', { class: `v-psh-line ${cls}` }, h('span', { class: 'v-psh-lbl' }, label), text);

  function render() {
    const sk = SEEKER[picked.seeker];
    const re = REACTION[picked.reaction];
    const ch = CHANNEL[picked.channel];
    if (!sk && !re && !ch) {
      reading.replaceChildren(h('p', { class: 'v-psh-wait' }, 'Your reading appears here as you answer.'));
      return;
    }
    const head = h('p', { class: 'v-psh-sum' },
      'You asked as ', sk ? h('b', null, sk.name) : h('span', { class: 'v-psh-blank' }, '…'),
      ', took the fix as ', re ? h('b', null, re.name) : h('span', { class: 'v-psh-blank' }, '…'),
      ', and asked in ', ch ? h('b', null, ch.name) : h('span', { class: 'v-psh-blank' }, '…'), '.');
    const parts = [head];
    if (sk) {
      parts.push(h('section', null,
        h('h4', null, sk.name, h('span', { class: 'v-psh-rt' }, sk.rate)),
        para('You', sk.you),
        para('Your helper', sk.helper),
        para('Next time', sk.next, 'is-next')));
    }
    if (re) parts.push(h('section', null, h('h4', null, re.name), para('After the fix', re.you)));
    if (ch) {
      parts.push(h('section', null,
        h('h4', null, `Asked in ${ch.name}`),
        para(ch.tone === 'good' ? 'Benefit' : 'Cost', ch.you, ch.tone === 'good' ? 'is-good' : 'is-bad'),
        para('Next time', ch.next, ch.tone === 'good' ? 'is-good' : 'is-next')));
    }
    reading.replaceChildren(...parts);
  }

  app.append(
    h('p', { class: 'v-psh-intro' }, 'Think of the last time you asked someone for help at work. Pick the answer closest to what you actually did.'),
    h('div', { class: 'v-psh-qs' }, ...qs),
    reading,
    h('p', { class: 'v-psh-legend' },
      h('span', null, h('i', { class: 'l-you' }), 'your answer'),
      h('span', null, h('i', { class: 'l-next' }), 'what could help next time'),
      h('span', null, h('i', { class: 'l-good' }), 'works in your favour'),
      h('span', null, h('i', { class: 'l-bad' }), 'costs someone time')),
  );
  render();
}

register({ trails: initTrails, 'last-ask': initLastAsk });

/*
 * Figures for "The Psychology of Seeking Help".
 *
 *   sorter     Fig. 1: one sample message at a time. The reader guesses who
 *              wrote it (ask()), then the phrases that give it away are
 *              underlined and labelled. Remember: the type shows in the
 *              first message. Do: guess before the answer appears.
 *   last-ask   Fig. 2: three questions (chips()) about the reader's own
 *              last ask; the answers name their types and one change the
 *              post suggests. Remember: which one you are. Do: place yourself.
 *
 * Types and traits come from the post. Messages are samples.
 */
import { h, btn, chips, ask, colorKey, register, esc } from './lib.js';

const ERR = 'dial tcp 127.0.0.1:5432: connect: connection refused';

const NAMES = {
  persistent: 'The Persistent Problem Solver',
  exhausted: 'The Exhausted Effort',
  connector: 'The Unrelated Connector',
  direct: 'The Direct Seeker',
  delegator: 'The Delegator',
};

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
      ['You set that up, can you sort it?', 'hands it over'], ' ', ['Not my area.', 'outside their job']],
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
  connector: 'They have seen something similar and need someone to explain how it relates to this problem.',
  direct: 'They have tried nothing yet and assume someone else can solve it faster.',
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
  const card = h('div', { class: 'wv-card v-psh-msg' });
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
          ? h('span', null, h('span', { class: 'v-psh-clue' }, ...codeify(txt)), h('span', { class: 't-xs t-up t-b' }, ` ${clue}`))
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
    slot.hidden = false;
    next.hidden = true;
    again.hidden = true;
    tally();
  }

  function finish() {
    const right = picks.filter((p, k) => p === MESSAGES[k].id).length;
    pos.textContent = `${MESSAGES.length} / ${MESSAGES.length}`;
    card.replaceChildren(h('h5', null, `You got ${right} of ${MESSAGES.length} right`),
      h('p', { class: 'v-psh-body' }, 'Every message was about the same failing test. Each person had done different work before they wrote, and the reply should match that work.'));
    slot.replaceChildren();
    slot.hidden = true;
    score.textContent = "";
    next.hidden = true;
    again.hidden = false;
  }

  app.append(
    h('div', { class: 'wv-bar' }, pos, h('span', { class: 'wv-sp' }), score),
    card,
    h('div', { class: 'v-psh-gap' }),
    slot,
    h('div', { class: 'wv-bar' }, next, again),
    colorKey([['k-held', 'the correct type'], ['k-gap', 'your guess, if wrong']]),
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
    id: 'channel', q: 'Where did you ask?',
    options: [
      ['call', 'A phone or WhatsApp call.'],
      ['dm', 'A direct message or personal email.'],
      ['public', 'A public channel.'],
    ],
  },
  {
    id: 'reaction', q: 'When the fix came, what did you do?',
    options: [
      ['inquisitive', 'Asked why it broke, and how to stop it happening again.'],
      ['solution', 'Applied it and got back to work.'],
      ['disinterested', 'Let them sort it out. I only needed it to work.'],
    ],
  },
];

const REACT = {
  inquisitive: 'The Inquisitive Learner',
  solution: 'The Solution Seeker',
  disinterested: 'The Disinterested',
};
const CHAN = { call: 'on a call', dm: 'in a direct message', public: 'in a public channel' };

// One change, in the order the post argues: where to ask, then effort, then reaction.
const NEXT = {
  call: 'Post the same question in a public channel. No one has to stop work, and the answer stays searchable for the next person.',
  dm: 'Post the same message in a public channel. Anyone who is free can answer, and the answer stays searchable for the next person.',
  direct: 'Try one thing before you ask. Then you know how hard the problem is and can say what you tried.',
  connector: 'Name the earlier problem in your message, so the helper can check the link.',
  solution: 'When the fix comes, ask why it broke and how to stop it happening again.',
  disinterested: 'When the fix comes, ask why it broke and how to stop it happening again.',
};

function initLastAsk(fig, app) {
  const ans = {};
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  note.hidden = true;

  function render() {
    if (!(ans.seeker && ans.reaction && ans.channel)) { note.hidden = true; return; }
    const tip = NEXT[ans.channel] || NEXT[ans.seeker] || NEXT[ans.reaction];
    note.hidden = false;
    note.replaceChildren(
      h('p', { class: 'v-psh-you' }, 'You asked as ', h('b', null, NAMES[ans.seeker]), ` ${CHAN[ans.channel]}, and took the fix as `, h('b', null, REACT[ans.reaction]), '.'),
      h('p', { class: 'v-psh-you' }, h('span', { class: 'k' }, 'Next time'),
        tip || 'You do not need to change anything. You tried first, learned why it broke, and asked where others can find the answer.'),
    );
  }

  // One question at a time; answered ones stay visible and can be changed.
  const blocks = QUESTIONS.map((qq, n) => {
    const c = chips(qq.options, (v) => {
      ans[qq.id] = v;
      if (blocks[n + 1]) blocks[n + 1].hidden = false;
      render();
    }, { label: qq.q });
    const el = h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, `${n + 1}. ${qq.q}`), c.el);
    el.hidden = n > 0;
    return el;
  });

  app.append(
    h('div', { class: 'wv-q' }, 'Think of the last time you asked someone for help at work.'),
    ...blocks,
    note,
    colorKey([['k-opt', 'your answer']]),
  );
}

register({ sorter: initSorter, 'last-ask': initLastAsk });

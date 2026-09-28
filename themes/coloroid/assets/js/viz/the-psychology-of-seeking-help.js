/*
 * Figures for "The Psychology of Seeking Help".
 *
 *   seeker-map    the five help seekers placed by effort and difficulty
 *   channel-walk  one question asked by call, by DM, and in a public channel
 *
 * Ratings and traits come from the post. People, times, and the sample
 * question are samples.
 */
import { h, btn, stepper, colorKey, register } from './lib.js';

/* =========================================================== SEEKER MAP */

// effort: 'low' | 'high'; diff: 'low' | 'medium' | 'high' | 'unknown'
const SEEKERS = [
  {
    id: 'persistent', short: 'Persistent', name: 'The Persistent Problem Solver', effort: 'high', diff: 'high',
    did: ['Tried several approaches', 'Narrowed the issue down', 'Explains what they tried, asks specific questions'],
    wants: 'Confirmation, or a new angle on a problem they have already narrowed down.',
  },
  {
    id: 'exhausted', short: 'Exhausted', name: 'The Exhausted Effort', effort: 'high', diff: 'high',
    did: ['Tried everything they could think of', 'Has a long list of failed fixes'],
    wants: 'The one piece of advice that unblocks them. They ask as a last resort, and they are frustrated.',
  },
  {
    id: 'connector', short: 'Connector', name: 'The Unrelated Connector', effort: 'high', diff: 'medium',
    did: ['Solved related problems before'],
    wants: 'Help linking this problem to the ones they have already solved.',
  },
  {
    id: 'direct', short: 'Direct', name: 'The Direct Seeker', effort: 'low', diff: 'unknown',
    did: [],
    wants: 'A ready answer. They assume someone else can solve it faster, and may not know how hard it is.',
  },
  {
    id: 'delegator', short: 'Delegator', name: 'The Delegator', effort: 'low', diff: 'low',
    did: ['Recognises the problem'],
    wants: 'Someone else to do it, because that person is faster or the task is outside their job.',
  },
];

const PAIR_NOTE = {
  persistent: 'Shares a cell with the Exhausted Effort. Both tried hard on a hard problem. The persistent solver still has a lead to follow.',
  exhausted: 'Shares a cell with the Persistent Problem Solver. Both tried hard on a hard problem. The exhausted one has run out of leads.',
  direct: 'Difficulty is unknown because no one has looked at the problem yet. It could land in any row.',
};

const DIFF_ROWS = ['high', 'medium', 'low'];

function initSeekerMap(fig, app) {
  let cur = 'persistent';
  const chips = {};

  const chip = (sk) => {
    const b = h('button', {
      type: 'button',
      class: `v-psh-chip${sk.diff === 'unknown' ? ' is-unknown' : ''}`,
      'aria-pressed': 'false',
      'aria-label': `${sk.name}: ${sk.effort} effort, ${sk.diff} difficulty`,
      onclick: () => select(sk.id),
    }, sk.short, sk.diff === 'unknown' ? h('span', { class: 'v-psh-q', 'aria-hidden': 'true' }, 'unknown') : null);
    chips[sk.id] = b;
    return b;
  };

  const grid = h('div', { class: 'v-psh-grid', role: 'group', 'aria-label': 'Help seekers by effort and difficulty' });
  // header row
  grid.append(
    h('div', { class: 'v-psh-ax v-psh-corner' }, 'difficulty'),
    h('div', { class: 'v-psh-ax v-psh-colhead', style: 'grid-column: 2 / 4' }, 'Low effort'),
    h('div', { class: 'v-psh-ax v-psh-colhead', style: 'grid-column: 4' }, 'High effort'),
  );
  DIFF_ROWS.forEach((d, r) => {
    const row = r + 2;
    const last = r === DIFF_ROWS.length - 1 ? ' is-last' : '';
    grid.append(h('div', { class: `v-psh-ax v-psh-rowhead${last}`, style: `grid-row: ${row}; grid-column: 1` }, d));
    grid.append(h('div', { class: `v-psh-cell${last}`, style: `grid-row: ${row}; grid-column: 2 / 4` }));
    const hi = h('div', { class: `v-psh-cell v-psh-stack${last}`, style: `grid-row: ${row}; grid-column: 4` });
    SEEKERS.filter((sk) => sk.effort === 'high' && sk.diff === d).forEach((sk) => hi.append(chip(sk)));
    grid.append(hi);
  });
  const direct = SEEKERS.find((sk) => sk.id === 'direct');
  const deleg = SEEKERS.find((sk) => sk.id === 'delegator');
  grid.append(
    h('div', { class: 'v-psh-slot v-psh-tall', style: 'grid-row: 2 / 5; grid-column: 2' }, chip(direct)),
    h('div', { class: 'v-psh-slot', style: 'grid-row: 4; grid-column: 3' }, chip(deleg)),
  );

  const panel = h('div', { class: 'v-psh-panel', 'aria-live': 'polite' });

  function select(id) {
    cur = id;
    for (const [k, b] of Object.entries(chips)) b.setAttribute('aria-pressed', String(k === id));
    const sk = SEEKERS.find((x) => x.id === id);
    const did = sk.did.length
      ? h('ul', { class: 'v-psh-did' }, ...sk.did.map((t) => h('li', null, t)))
      : h('p', { class: 'v-psh-none' }, 'Nothing yet. They asked as soon as the problem appeared.');
    panel.replaceChildren(
      h('h4', null, sk.name),
      h('dl', { class: 'wv-kv' },
        h('dt', null, 'effort'), h('dd', { class: 'c-data' }, sk.effort),
        h('dt', null, 'difficulty'), h('dd', { class: sk.diff === 'unknown' ? 'c-bad' : 'c-data' }, sk.diff)),
      h('div', { class: 'v-psh-sub' }, 'Already done before asking'),
      did,
      h('div', { class: 'v-psh-sub' }, 'What they want from you'),
      h('p', null, sk.wants),
      PAIR_NOTE[id] ? h('div', { class: `wv-note${id === 'direct' ? ' is-bad' : ''}` }, PAIR_NOTE[id]) : null,
    );
  }

  app.append(
    h('div', { class: 'wv-q' }, 'How much has this person done before asking, and how hard is the problem?'),
    h('div', { class: 'v-psh-map' }, grid, panel),
    colorKey([['k-opt', 'a type (select one)'], ['k-look', 'selected'], ['k-data', 'rating from the post'], ['k-held', 'done before asking'], ['k-gap', 'difficulty unknown']]),
  );
  select(cur);
}

/* ========================================================= CHANNEL WALK */

const QUESTION = 'go test ./... fails with "connection refused" on :5432 after I pulled main. Anyone seen this?';
const ANSWER = 'The test DB moved to docker compose last week. Run: docker compose up -d postgres';

const PEOPLE = [
  { id: 'A', role: 'asks' },
  { id: 'B', role: 'knows the fix' },
  { id: 'C', role: 'knows the fix' },
  { id: 'D', role: 'teammate' },
  { id: 'E', role: 'joins next month' },
];

// Person state: [class, text]. Classes: look, bad, good, seen, idle, away.
const STEPS = [
  { label: 'Ask' },
  { label: 'Reply' },
  { label: 'Rest of team' },
  { label: 'Next month' },
];

const CHANNELS = {
  call: {
    name: 'Phone call',
    steps: [
      {
        people: { A: ['look', 'calls B'], B: ['bad', 'stops work to pick up'], C: ['idle', 'unaware'], D: ['idle', 'unaware'], E: ['away', 'not on the team yet'] },
        record: ['none', 'Nothing written down'],
        note: 'A call needs B right now. B stops whatever they were doing.',
        tally: [1, 0, 'nobody'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['bad', 'explains, then gets back into their task'], C: ['idle', 'knew the fix, never heard the question'], D: ['idle', 'unaware'], E: ['away', 'not on the team yet'] },
        record: ['none', 'The fix was spoken, not written'],
        note: 'Only B could answer, because only B was called.',
        tally: [1, 1, 'nobody'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['good', 'has the fix'], C: ['idle', 'unaware'], D: ['idle', 'unaware'], E: ['away', 'not on the team yet'] },
        record: ['none', 'Nothing written down'],
        note: 'The fix lives in two heads, A and B.',
        tally: [1, 1, 'nobody'],
      },
      {
        people: { A: ['idle', ''], B: ['bad', 'stops work again'], C: ['idle', ''], D: ['idle', ''], E: ['look', 'hits the same error, calls B'] },
        record: ['none', 'Nothing to search'],
        note: 'No one can search a call. E asks B the same question, and B stops work a second time.',
        tally: [2, 2, 'nobody'],
      },
    ],
  },
  dm: {
    name: 'Direct message',
    steps: [
      {
        people: { A: ['look', 'sends B a DM'], B: ['good', 'reads it at a break'], C: ['idle', 'cannot see it'], D: ['idle', 'cannot see it'], E: ['away', 'not on the team yet'] },
        record: ['private', 'DM between A and B'],
        note: 'A message does not force B to stop. But only B can see it.',
        tally: [0, 0, 'A, B'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['good', 'replies in the DM'], C: ['idle', 'knew the fix, never saw the question'], D: ['idle', 'cannot see it'], E: ['away', 'not on the team yet'] },
        record: ['private', 'DM between A and B'],
        note: 'If B is busy or on leave, A waits, even though C knew the fix.',
        tally: [0, 1, 'A, B'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['good', 'has the fix'], C: ['idle', 'unaware'], D: ['idle', 'unaware'], E: ['away', 'not on the team yet'] },
        record: ['private', 'DM between A and B'],
        note: 'The fix is written down, in a place only two people can open.',
        tally: [0, 1, 'A, B'],
      },
      {
        people: { A: ['idle', ''], B: ['good', 'answers the same question again'], C: ['idle', ''], D: ['idle', ''], E: ['look', 'searches, finds nothing, DMs B'] },
        record: ['private', 'New DM between E and B'],
        note: 'Search does not show E a DM between A and B. B writes the same answer twice.',
        tally: [0, 2, 'A, B'],
      },
    ],
  },
  public: {
    name: 'Public channel',
    pick: true,
    steps: [
      {
        people: { A: ['look', 'posts in #backend'], B: ['good', 'busy, keeps working'], C: ['good', 'sees it at a break'], D: ['seen', 'sees it'], E: ['away', 'not on the team yet'] },
        record: ['public', 'Thread in #backend'],
        note: 'No one has to stop. Anyone in the channel can pick it up.',
        tally: [0, 0, 'every member'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['good', 'never pulled away'], C: ['good', 'replies in the thread'], D: ['seen', 'sees the reply'], E: ['away', 'not on the team yet'] },
        record: ['public', 'Thread in #backend'],
        note: 'C was free first, so C answered. B kept working.',
        tally: [0, 1, 'every member'],
      },
      {
        people: { A: ['good', 'has the fix'], B: ['good', 'has the fix'], C: ['good', 'has the fix'], D: ['good', 'knows the fix before needing it'], E: ['away', 'not on the team yet'] },
        record: ['public', 'Thread in #backend'],
        note: 'Everyone who reads the channel learns the fix, including people who never asked.',
        tally: [0, 1, 'every member'],
      },
      {
        people: { A: ['idle', ''], B: ['good', 'not asked'], C: ['good', 'not asked'], D: ['idle', ''], E: ['look', 'searches "5432", finds the thread'] },
        record: ['public', 'Thread in #backend'],
        note: 'Public channel messages show up in search for every workspace member, including people who joined later. On the Slack free plan, search covers the last 90 days.',
        tally: [0, 1, 'every member'],
      },
    ],
  },
};

function initChannelWalk(fig, app) {
  let ch = 'call';

  const chBtns = Object.entries(CHANNELS).map(([k, c]) =>
    btn(c.pick ? h('span', null, c.name, h('span', { class: 'v-psh-rec' }, 'recommended')) : c.name,
      () => { ch = k; syncBtns(); render(stp.i); }, { 'aria-pressed': String(k === ch), class: `wv-btn${c.pick ? ' v-psh-pickbtn' : ''}` }));
  const syncBtns = () => Object.keys(CHANNELS).forEach((k, n) => chBtns[n].setAttribute('aria-pressed', String(k === ch)));

  const msg = h('div', { class: 'v-psh-msgs' });
  const people = h('div', { class: 'v-psh-people' });
  const cards = {};
  for (const p of PEOPLE) {
    const st = h('span', { class: 'v-psh-st' });
    const card = h('div', { class: 'v-psh-person' }, h('b', null, p.id), h('span', { class: 'v-psh-role' }, p.role), st);
    cards[p.id] = { card, st };
    people.append(card);
  }
  const tally = h('div', { class: 'wv-stats v-psh-tally' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });

  function render(i) {
    const c = CHANNELS[ch];
    const st = c.steps[i];
    for (const p of PEOPLE) {
      const [cls, text] = st.people[p.id];
      cards[p.id].card.className = `v-psh-person is-${cls}`;
      cards[p.id].st.textContent = text;
    }
    const [kind, where] = st.record;
    const asker = i === 3 && ch !== 'public' ? 'E' : 'A';
    const q = h('div', { class: 'v-psh-msg' }, h('span', { class: 'v-psh-who' }, asker), h('code', null, QUESTION));
    const answered = i >= 1;
    const aWho = ch === 'public' ? 'C' : 'B';
    const a = answered
      ? h('div', { class: `v-psh-msg${kind === 'none' ? ' is-spoken' : ''}` }, h('span', { class: 'v-psh-who' }, aWho), h('code', null, ANSWER))
      : null;
    msg.replaceChildren(
      h('div', { class: `v-psh-record is-${kind}` },
        h('div', { class: 'v-psh-rhead' }, h('span', null, 'Record'), h('span', { class: 'wv-tag' }, where)),
        q, a,
        kind === 'none' && answered ? h('div', { class: 'v-psh-lost' }, 'spoken on the call, not saved anywhere') : null,
        ch === 'public' && i === 3 ? h('div', { class: 'v-psh-found' }, 'E found this thread by search') : null));
    const [stops, answers, who] = st.tally;
    tally.replaceChildren(
      h('div', { class: `wv-stat${stops ? ' is-bad' : ' is-good'}` }, h('span', { class: 'k' }, 'forced to stop work'), h('span', { class: 'v' }, `${stops}×`)),
      h('div', { class: `wv-stat${answers > 1 ? ' is-bad' : ''}` }, h('span', { class: 'k' }, 'times the fix was given'), h('span', { class: 'v' }, `${answers}`)),
      h('div', { class: `wv-stat${who === 'nobody' ? ' is-bad' : who === 'every member' ? ' is-good' : ''}` }, h('span', { class: 'k' }, 'who can search the fix'), h('span', { class: 'v' }, who)),
    );
    note.className = `wv-note${i === 3 ? (ch === 'public' ? ' is-good' : ' is-bad') : ''}`;
    note.innerHTML = '';
    note.append(h('span', { class: 'k' }, `${c.name} · ${String(i + 1).padStart(2, '0')}`), st.note);
  }

  const stp = stepper(fig, STEPS, (i) => render(i), { interval: 3400 });
  app.append(
    h('div', { class: 'wv-bar' },
      h('span', { class: 'c-opt v-psh-lbl' }, 'Where A asks'),
      h('span', { class: 'wv-seg' }, ...chBtns)),
    stp.el,
    msg,
    people,
    tally,
    h('div', { style: 'height:.6rem' }),
    note,
    colorKey([['k-opt', 'channel you can pick'], ['k-pick', 'the post recommends'], ['k-data', 'the question and fix'], ['k-look', 'who acts now'], ['k-gap', 'interrupted or lost'], ['k-held', 'not blocked, or has the fix']]),
  );
  stp.go(0);
}

register({ 'seeker-map': initSeekerMap, 'channel-walk': initChannelWalk });

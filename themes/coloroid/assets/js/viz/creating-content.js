/*
 * viz/creating-content — figures for "Creating Content".
 *
 *   who-gets-better  Three reader-paced beats on one fixed table (T, K, P
 *                    rows × Retton, Winston, You columns):
 *                      1. predict: who skis better, the Olympian or Winston?
 *                      2. place yourself: two questions about your writing
 *                      3. retrieve: if you never publish, what does a
 *                         reader see?
 *
 * The ski story and quotes are from Winston's How to Speak (MIT OCW
 * transcript). Pips mean more or less, not measurements.
 */
import { h, btn, chips, ask, colorKey, register } from './lib.js';

const ROWS = [
  { id: 't', sym: 'T', name: 'talent', note: 'given' },
  { id: 'k', sym: 'K', name: 'knowledge', note: 'you grow it' },
  { id: 'p', sym: 'P', name: 'practice', note: 'you grow it' },
];
const COLS = [
  { id: 'retton', name: 'Retton', sub: 'Olympic gymnast', v: { t: 5, k: 1, p: 1 } },
  { id: 'winston', name: 'Winston', sub: 'MIT professor', v: { t: null, k: 4, p: 4 } },
  { id: 'you', name: 'You', sub: 'writing', v: { t: null, k: 0, p: 0 } },
];
const K_ANS = [[1, 'A little'], [3, 'Well'], [5, 'Deeply']];
const P_ANS = [[0, 'None yet'], [2, '1 to 5'], [4, 'More than 5']];
const BEATS = 3;

function pips(v) {
  const el = h('span', { class: 'v-cc-pips' });
  for (let i = 0; i < 5; i++) el.append(h('i'));
  const set = (n) => {
    el.classList.toggle('is-unknown', n == null);
    el.setAttribute('aria-label', n == null ? 'unknown' : `${n} of 5`);
    [...el.children].forEach((c, i) => c.classList.toggle('on', n != null && i < n));
  };
  set(v);
  return { el, set };
}

function advice(k, p) {
  if (p === 0) return ['Start now, and do not wait for it to be perfect.', '#when', 'When to start'];
  if (k === 1) return ['Pick a topic that interests you, and ask questions. Curiosity drives knowledge.', '#what', 'What to write about'];
  return ['Keep publishing. Have someone pre-read, then iterate on the feedback.', '#faq', 'FAQ'];
}

function initWho(fig, app) {
  const st = { beat: 0, guess: null, k: null, p: null, never: null };

  /* --- the table: the same in every beat --- */
  const cells = {};
  const heads = {};
  const table = h('table', { class: 'wv-table v-cc-grid' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }),
      ...COLS.map((c) => (heads[c.id] = h('th', { scope: 'col', class: 'v-cc-col' },
        h('span', { class: 't-m t-b' }, c.name), h('br'), h('span', { class: 't-xs' }, c.sub)))))),
    h('tbody', null, ...ROWS.map((r) => h('tr', { class: `v-cc-r-${r.id}` },
      h('th', { scope: 'row', class: 'v-cc-rowh' },
        h('span', { class: 't-l t-b' }, r.sym), ' ', r.name, h('br'),
        h('span', { class: `t-xs${r.id === 't' ? '' : ' t-safe'}` }, r.note)),
      ...COLS.map((c) => {
        const pp = pips(c.v[r.id]);
        const td = h('td', { class: `v-cc-cell v-cc-c-${c.id}` }, pp.el);
        cells[`${c.id}.${r.id}`] = { ...pp, td };
        return td;
      })))),
  );

  const stage = h('div', { class: 'v-cc-stage' });
  const back = btn('◀ Back', () => go(st.beat - 1), { 'aria-label': 'Previous part' });
  const next = btn('Next ▶', () => go(st.beat + 1), { 'aria-label': 'Next part' });
  const again = btn('↻ Start over', () => { Object.assign(st, { guess: null, k: null, p: null, never: null }); go(0); });
  const pos = h('span', { class: 'wv-pos', 'aria-live': 'polite' });

  function paint() {
    const b = st.beat;
    const revealed = b > 0 || st.guess != null;
    COLS.forEach((c) => ROWS.forEach((r) => {
      const x = cells[`${c.id}.${r.id}`];
      let v = c.v[r.id];
      if (c.id === 'you' && r.id === 'k') v = st.k ?? 0;
      if (c.id === 'you' && r.id === 'p') v = b === 2 ? 0 : (st.p ?? 0);
      const hidden = c.id !== 'you' && r.id !== 't' && !revealed;
      x.el.classList.toggle('is-hidden', hidden);
      x.set(hidden ? 0 : v);
      x.td.classList.toggle('is-gap', c.id === 'you' && b === 2 && st.never != null);
    }));
    const focus = b === 0 ? (st.guess != null ? 'winston' : null) : 'you';
    COLS.forEach((c) => {
      const cls = (e) => {
        e.classList.toggle('is-look', c.id === focus);
        e.classList.toggle('is-dim', b > 0 && c.id !== 'you');
      };
      cls(heads[c.id]);
      ROWS.forEach((r) => cls(cells[`${c.id}.${r.id}`].td));
    });
    const done = [st.guess != null, st.k != null && st.p != null, true][b];
    back.disabled = b === 0;
    next.disabled = !done;
    next.hidden = b === BEATS - 1;
    again.hidden = b !== BEATS - 1;
    pos.textContent = `${b + 1} / ${BEATS}`;
  }

  /* An ask() is fresh each time a beat renders; replay a stored answer. */
  function replay(a, value, choices) {
    const i = choices.findIndex(([v]) => v === value);
    if (i >= 0) a.el.querySelectorAll('.wv-chip')[i].click();
  }

  function beatStory() {
    const choices = [['retton', 'Retton'], ['winston', 'Winston']];
    const a = ask('Who skis better?', choices, 'winston', (v, right) => {
      st.guess = v; paint();
      return `${right ? 'Yes, Winston.' : 'Winston, by his own account.'} <i>“I was a better skier because I had the K, and I had the P, and all she had was the T.”</i>`;
    });
    replay(a, st.guess, choices);
    return [
      h('p', null, 'Sun Valley, Celebrity Weekend. On the novice slope is Mary Lou Retton, an Olympic gymnast with perfect 10s in the vault. Patrick Winston skis there too.'),
      a.el,
    ];
  }

  function beatYou() {
    const note = h('div', { class: 'wv-note is-good', 'aria-live': 'polite' });
    const show = () => {
      paint();
      note.hidden = st.k == null || st.p == null;
      if (note.hidden) return;
      const [text, href, label] = advice(st.k, st.p);
      note.replaceChildren(text, ' ', h('a', { href }, `(${label})`));
    };
    const ck = chips(K_ANS, (v) => { st.k = v; show(); }, { value: st.k, label: 'How well you know the topic' });
    const cp = chips(P_ANS, (v) => { st.p = v; show(); }, { value: st.p, label: 'How much you have published' });
    show();
    return [
      h('p', null, 'Now you, and writing. Talent is not one of the questions: you cannot change it.'),
      h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, 'One topic you could write about: how well do you know it?'), ck.el),
      h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, 'How many pieces have you published?'), cp.el),
      note,
    ];
  }

  function beatNever() {
    const choices = [['all', 'All of it'], ['some', 'Some'], ['none', 'None']];
    const a = ask('How much of your knowledge and talent does a reader see?', choices, 'none', (v, right) => {
      st.never = v; paint();
      return `${right ? 'Yes, none.' : 'None.'} A reader only meets what you publish. <i>“Talent will not; nothing is more common than unsuccessful men with talent.”</i> Calvin Coolidge`;
    });
    replay(a, st.never, choices);
    return [
      h('p', null, 'Say you never publish. Your practice column is empty.'),
      a.el,
    ];
  }

  function go(b) {
    st.beat = Math.max(0, Math.min(BEATS - 1, b));
    if (st.beat !== 2) st.never = null;
    stage.replaceChildren(...[beatStory, beatYou, beatNever][st.beat]());
    paint();
  }

  app.append(
    h('div', { class: 'wv-split' }, h('div', { class: 'wv-scroll' }, table), stage),
    h('div', { class: 'wv-bar v-cc-bar' }, back, pos, h('span', { class: 'wv-sp' }), next, again),
    colorKey([
      ['k-ink', 'talent: given'],
      ['k-safe', 'knowledge, practice: you grow them'],
      ['k-opt', 'your answers'],
      ['k-look', 'the column to look at'],
      ['k-gap', 'not published'],
    ]),
  );
  go(0);
}

register({ 'who-gets-better': initWho });

/*
 * viz/creating-content — figures for "Creating Content".
 *
 *   formula-hero     Winston's formula as type: K and P large, t small.
 *   who-gets-better  Three short beats on one stable grid (T, K, P rows ×
 *                    Retton, Winston, You columns):
 *                      1. predict: who skis better, the Olympian or Winston?
 *                      2. place yourself: two questions about your writing
 *                      3. retrieve: if you never publish, what does a
 *                         reader see?
 *
 * The ski story and quotes are from Winston's How to Speak (MIT OCW
 * transcript). Pips mean more or less, not measurements.
 */
import { h, register } from './lib.js';

/* ---------------------------------------------------------------- hero */

function initHero(fig, app) {
  const L = (ch, name, cls) => h('span', { class: `v-cc-h-term ${cls}` },
    h('span', { class: 'v-cc-h-glyph', 'aria-hidden': 'true' }, ch), h('span', { class: 'v-cc-h-name' }, name));
  const P = (ch) => h('span', { class: 'v-cc-h-punct', 'aria-hidden': 'true' }, ch);
  app.append(
    h('div', { class: 'v-cc-h-eq' },
      L('Q', 'quality', 'is-q'), P('='), P('f('), L('K', 'knowledge', 'is-k'), P(','),
      L('P', 'practice', 'is-p'), P(','), L('t', 'talent', 'is-t'), P(')')),
    h('p', { class: 'v-cc-h-line' },
      'Quality depends on what you know and how much you practise. Talent is the small term.'),
  );
}

/* ------------------------------------------------------ who-gets-better */

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
const K_ANS = [['A little', 1], ['Well', 3], ['Deeply', 5]];
const P_ANS = [['None yet', 0], ['1 to 5', 2], ['More than 5', 4]];

function pips(n) {
  const el = h('span', { class: 'v-cc-pips' });
  for (let i = 0; i < 5; i++) el.append(h('i'));
  const set = (v) => {
    el.classList.toggle('is-unknown', v == null);
    el.setAttribute('aria-label', v == null ? 'unknown' : `${v} of 5`);
    [...el.children].forEach((c, i) => c.classList.toggle('on', v != null && i < v));
  };
  set(n);
  return { el, set };
}

function choice(label, onpick) {
  return h('button', { type: 'button', class: 'v-cc-pick', 'aria-pressed': 'false', onclick: onpick }, label);
}
function press(group, btn) {
  group.querySelectorAll('.v-cc-pick').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
}

function initWho(fig, app) {
  const st = { beat: 0, guess: null, k: null, p: null, never: null };

  /* --- the grid: stays put in every beat --- */
  const grid = h('div', { class: 'v-cc-grid', role: 'table', 'aria-label': 'Talent, knowledge and practice for Retton, Winston and you' });
  const cells = {};
  const colHead = {};
  grid.append(h('span', { class: 'v-cc-corner', role: 'columnheader', style: 'grid-row:1;grid-column:1' }));
  /* Every cell is placed explicitly, so the veil can overlay the You column. */
  COLS.forEach((c, ci) => {
    colHead[c.id] = h('span', { class: `v-cc-col v-cc-c-${c.id}`, role: 'columnheader', style: `grid-row:1;grid-column:${ci + 2}` },
      h('b', null, c.name), h('span', null, c.sub));
    grid.append(colHead[c.id]);
  });
  ROWS.forEach((r, ri) => {
    grid.append(h('span', { class: `v-cc-row v-cc-r-${r.id}`, role: 'rowheader', style: `grid-row:${ri + 2};grid-column:1` },
      h('b', { class: 'v-cc-sym' }, r.sym), h('span', null, r.name), h('small', null, r.note)));
    COLS.forEach((c, ci) => {
      const pp = pips(c.v[r.id]);
      const cell = h('span', { class: `v-cc-cell v-cc-c-${c.id} v-cc-r-${r.id}`, role: 'cell', style: `grid-row:${ri + 2};grid-column:${ci + 2}` }, pp.el);
      cells[`${c.id}.${r.id}`] = { ...pp, cell };
      grid.append(cell);
    });
  });
  const veil = h('span', { class: 'v-cc-veil', 'aria-hidden': 'true' }, 'not published', h('br'), 'a reader sees nothing');
  grid.append(veil);

  /* --- the question area: one beat at a time --- */
  const stage = h('div', { class: 'v-cc-stage', 'aria-live': 'polite' });
  const dots = h('div', { class: 'v-cc-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const nav = h('div', { class: 'v-cc-nav' }, dots);

  function paintGrid() {
    const b = st.beat;
    const showKnown = b > 0 || st.guess != null;
    COLS.forEach((c) => ROWS.forEach((r) => {
      const x = cells[`${c.id}.${r.id}`];
      let v = c.v[r.id];
      if (c.id === 'you') {
        if (r.id === 'k') v = st.k ?? 0;
        if (r.id === 'p') v = b === 2 ? 0 : (st.p ?? 0);
      }
      const hidden = c.id !== 'you' && r.id !== 't' && !showKnown;
      x.cell.classList.toggle('is-hidden', hidden);
      x.set(hidden ? 0 : v);
    }));
    const focus = b === 0 ? (st.guess != null ? 'winston' : null) : 'you';
    COLS.forEach((c) => {
      const on = c.id === focus;
      colHead[c.id].classList.toggle('is-focus', on);
      grid.querySelectorAll(`.v-cc-cell.v-cc-c-${c.id}`).forEach((e) => e.classList.toggle('is-focus', on));
      const dim = b > 0 && c.id !== 'you';
      colHead[c.id].classList.toggle('is-dim', dim);
      grid.querySelectorAll(`.v-cc-cell.v-cc-c-${c.id}`).forEach((e) => e.classList.toggle('is-dim', dim));
    });
    grid.classList.toggle('is-veiled', b === 2 && st.never != null);
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === b));
  }

  const next = (label, to) => h('button', { type: 'button', class: 'v-cc-next', onclick: () => go(to) }, label);

  function beatStory() {
    const row = h('div', { class: 'v-cc-picks' });
    const out = h('div', { class: 'v-cc-out' });
    const pick = (id, btn) => {
      st.guess = id; press(row, btn); paintGrid();
      out.replaceChildren(
        h('p', null, st.guess === 'winston' ? 'Yes, Winston.' : 'Winston, by his own account.'),
        h('blockquote', { class: 'v-cc-quote' },
          '“I was a better skier because I had the K, and I had the P, and all she had was the T.”'),
        next('Now you →', 1),
      );
    };
    COLS.slice(0, 2).forEach((c) => {
      const b = choice(c.name, () => pick(c.id, b));
      row.append(b);
    });
    return [
      h('p', { class: 'v-cc-say' },
        'Sun Valley, Celebrity Weekend. On the novice slope is Mary Lou Retton, an Olympic gymnast with perfect 10s in the vault. Patrick Winston skis there too.'),
      h('p', { class: 'v-cc-ask' }, 'Who skis better?'),
      row, out,
    ];
  }

  function advice() {
    if (st.k == null || st.p == null) return null;
    if (st.p === 0) return ['Start now, and do not wait for it to be perfect.', '#when', 'When?'];
    if (st.k === 1) return ['Pick a topic that interests you, and ask questions. Curiosity drives knowledge.', '#what', 'What?'];
    return ['Keep publishing. Have someone pre-read, then iterate on the feedback.', '#faq', 'FAQ'];
  }

  function beatYou() {
    const out = h('div', { class: 'v-cc-out' });
    const qk = h('div', { class: 'v-cc-picks' });
    const qp = h('div', { class: 'v-cc-picks' });
    const show = () => {
      paintGrid();
      const a = advice();
      out.replaceChildren();
      if (a) {
        out.append(
          h('p', { class: 'v-cc-advice' }, a[0], ' ', h('a', { href: a[1] }, `(${a[2]})`)),
          next('One question →', 2),
        );
      }
    };
    K_ANS.forEach(([label, v]) => { const b = choice(label, () => { st.k = v; press(qk, b); show(); }); if (st.k === v) b.setAttribute('aria-pressed', 'true'); qk.append(b); });
    P_ANS.forEach(([label, v]) => { const b = choice(label, () => { st.p = v; press(qp, b); show(); }); if (st.p === v) b.setAttribute('aria-pressed', 'true'); qp.append(b); });
    show();
    return [
      h('p', { class: 'v-cc-say' }, 'Now you, and writing. Two questions. Talent is not one of them: you cannot change it.'),
      h('p', { class: 'v-cc-ask' }, 'One topic you could write about: how well do you know it?'), qk,
      h('p', { class: 'v-cc-ask' }, 'How many pieces have you published?'), qp,
      out,
    ];
  }

  function beatNever() {
    const row = h('div', { class: 'v-cc-picks' });
    const out = h('div', { class: 'v-cc-out' });
    const pick = (ans, btn) => {
      st.never = ans; press(row, btn); paintGrid();
      out.replaceChildren(
        h('p', null, ans === 'None' ? 'Yes, none.' : 'None.',
          ' A reader only meets what you publish. Your knowledge and talent stay in your head.'),
        h('blockquote', { class: 'v-cc-quote' },
          '“Talent will not; nothing is more common than unsuccessful men with talent.”',
          h('span', { class: 'v-cc-src' }, ' Calvin Coolidge')),
        h('div', { class: 'v-cc-again' }, next('← Back to your answers', 1), next('Start over', -1)),
      );
    };
    ['All of it', 'Some', 'None'].forEach((a) => { const b = choice(a, () => pick(a, b)); row.append(b); });
    return [
      h('p', { class: 'v-cc-say' }, 'Say you never publish. Your practice column is empty.'),
      h('p', { class: 'v-cc-ask' }, 'How much of your knowledge and talent does a reader see?'),
      row, out,
    ];
  }

  function go(b) {
    if (b === -1) { Object.assign(st, { guess: null, k: null, p: null, never: null }); b = 0; }
    st.beat = b;
    if (b !== 2) st.never = null;
    stage.replaceChildren(...[beatStory, beatYou, beatNever][b]());
    paintGrid();
  }

  app.append(h('div', { class: 'v-cc-who' }, grid, h('div', { class: 'v-cc-side' }, stage, nav)));
  go(0);
}

register({ 'formula-hero': initHero, 'who-gets-better': initWho });

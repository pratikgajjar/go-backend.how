/*
 * viz/creating-content — one figure for "Creating Content".
 *
 *   who-gets-better  Remember: knowledge and practice beat talent, and you
 *                    grow both. The reader does: sees only the Olympian's
 *                    talent, guesses who skis better, then sees the
 *                    knowledge and practice that decided it.
 *
 * Story and quote: Patrick Winston, How to Speak (MIT OCW transcript).
 * Bar lengths mean more or less, not measurements.
 */
import { h, ask, colorKey, register } from './lib.js';

const ROWS = [
  { id: 't', sym: 'T', name: 'talent', note: 'given' },
  { id: 'k', sym: 'K', name: 'knowledge', note: 'you grow it' },
  { id: 'p', sym: 'P', name: 'practice', note: 'you grow it' },
];
// out of 4; null = Winston does not say
const COLS = [
  { id: 'retton', name: 'Retton', sub: 'Olympic gymnast', v: { t: 4, k: 1, p: 1 } },
  { id: 'winston', name: 'Winston', sub: 'MIT professor', v: { t: null, k: 3, p: 3 } },
];

function bar(r, v) {
  const fill = h('i');
  const el = h('span', { class: `v-cc-bar v-cc-bar-${r.id}` }, fill);
  const set = (state) => {
    // state: 'hidden' | 'shown'
    el.classList.toggle('is-hidden', state === 'hidden');
    el.classList.toggle('is-unsaid', state === 'shown' && v == null);
    fill.style.width = state === 'shown' && v != null ? `${v * 25}%` : '0';
    el.setAttribute('aria-label', state === 'hidden' ? 'hidden until you guess'
      : v == null ? 'he does not say' : `${v} of 4`);
    el.dataset.label = state === 'shown' && v == null ? 'not said' : '';
  };
  return { el, set };
}

function initWho(fig, app) {
  const bars = [];
  const table = h('table', { class: 'wv-table v-cc-grid' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }),
      ...COLS.map((c) => h('th', { scope: 'col' }, c.name, h('br'), h('span', { class: 't-xs' }, c.sub))))),
    h('tbody', null, ...ROWS.map((r) => h('tr', null,
      h('th', { scope: 'row' }, h('b', null, r.sym), ' ', r.name, h('br'), h('span', { class: 't-xs' }, r.note)),
      ...COLS.map((c) => {
        const b = bar(r, c.v[r.id]);
        // Before the guess the reader sees only Retton's talent.
        bars.push({ b, early: c.id === 'retton' && r.id === 't' });
        return h('td', null, b.el);
      })))),
  );
  const paint = (revealed) => bars.forEach(({ b, early }) => b.set(revealed || early ? 'shown' : 'hidden'));

  const q = ask('Who skis better?', [['retton', 'Retton'], ['winston', 'Winston']], 'winston', (v, right) => {
    paint(true);
    return `${right ? 'Winston.' : 'Winston, by his own account.'} <i>“I was a better skier because I had the K, and I had the P, and all she had was the T.”</i>`;
  });

  app.append(
    h('div', { class: 'v-cc-who' },
      h('p', { class: 'v-cc-story' }, 'Sun Valley, Celebrity Weekend. Mary Lou Retton, an Olympic gymnast with perfect 10s in the vault, is on the novice slope. Patrick Winston is skiing there too.'),
      h('div', { class: 'v-cc-table' }, table),
      h('div', { class: 'v-cc-ask' }, q.el)),
    colorKey([
      ['k-ink', 'talent: given'],
      ['k-safe', 'knowledge, practice: you grow them'],
    ]),
  );
  paint(false);
}

register({ 'who-gets-better': initWho });

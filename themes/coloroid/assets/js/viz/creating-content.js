/*
 * viz/creating-content — figures for "Creating Content".
 *
 *   formula-hero  Winston's formula set as type: K and P large, t small.
 *   formula       the same formula, playable. Each letter's size follows
 *                 its value; Q = K × P × t updates as the reader moves the
 *                 terms or picks one of the people in the post.
 *
 * Winston writes Q = f(K, P, T) and draws the T small (How to Speak, MIT
 * OCW transcript). The plain product and the 0.8–1.2 range for t are this
 * post's simplification; the values in the presets are made up.
 */
import { h, register, REDUCED } from './lib.js';

const K_MAX = 10;
const P_MAX = 10;
const T_MIN = 0.8;
const T_MAX = 1.2;
const Q_MAX = K_MAX * P_MAX * T_MAX;

const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
const tal = (v) => v.toFixed(1);
const q = (k, p, t) => Math.round(k * p * t * 10) / 10;

/* Glyph sizes in em of the figure's base size. Area grows with value. */
const sizeQ = (v) => (v <= 0 ? 2.2 : 1.7 + 3.1 * Math.sqrt(v / Q_MAX));
const sizeKP = (v, max) => 1.2 + 2.2 * Math.sqrt(v / max);
const sizeT = (v) => 0.75 + 0.45 * ((v - T_MIN) / (T_MAX - T_MIN));

/* The equation is a grid: letters and operators share row 1 and one
   baseline, names sit in row 2, values in row 3. */
function term(letter, name, cls, col) {
  const at = (row) => `grid-column:${col};grid-row:${row}`;
  const glyph = h('span', { class: 'v-cc-glyph', 'aria-hidden': 'true', style: at(1) }, letter);
  const val = h('span', { class: 'v-cc-val', style: at(3) });
  const el = h('span', { class: `v-cc-term ${cls}` }, glyph, h('span', { class: 'v-cc-name', style: at(2) }, name), val);
  return { el, glyph, val };
}
const op = (c, col) => h('span', { class: 'v-cc-op', 'aria-hidden': 'true', style: `grid-column:${col};grid-row:1` }, c);

function equation() {
  const Q = term('Q', 'quality', 'v-cc-q', 1);
  const K = term('K', 'knowledge', 'v-cc-k', 3);
  const P = term('P', 'practice', 'v-cc-p', 5);
  const T = term('t', 'talent', 'v-cc-t', 7);
  const el = h('div', { class: 'v-cc-eq' }, Q.el, op('=', 2), K.el, op('×', 4), P.el, op('×', 6), T.el);
  return { el, Q, K, P, T };
}

function paint(eq, k, p, t, showVals = true) {
  const v = q(k, p, t);
  eq.Q.glyph.style.fontSize = `${sizeQ(v)}em`;
  eq.K.glyph.style.fontSize = `${sizeKP(k, K_MAX)}em`;
  eq.P.glyph.style.fontSize = `${sizeKP(p, P_MAX)}em`;
  eq.T.glyph.style.fontSize = `${sizeT(t)}em`;
  eq.Q.el.classList.toggle('is-zero', v === 0);
  if (showVals) {
    eq.Q.val.textContent = num(v);
    eq.K.val.textContent = num(k);
    eq.P.val.textContent = num(p);
    eq.T.val.textContent = tal(t);
  }
  return v;
}

/* ---------------------------------------------------------------- hero */

function initHero(fig, app) {
  const eq = equation();
  eq.el.classList.add('is-hero');
  paint(eq, 8, 8, 1.0, false);
  app.append(eq.el, h('p', { class: 'v-cc-line' },
    'What you make depends on what you know and how much you practise. Talent is the small term.'));
}

/* ------------------------------------------------------------ playable */

const PEOPLE = [
  {
    id: 'you', label: 'You, before the first post', k: 5, p: 0, t: 1.0,
    says: null,
  },
  {
    id: 'retton', label: 'Retton on skis', k: 1, p: 1, t: 1.2,
    says: ['Winston saw Mary Lou Retton, an Olympic gymnast, on the novice slope. “…and all she had was the T.”', 'Winston, How to Speak'],
  },
  {
    id: 'winston', label: 'Winston on skis', k: 7, p: 8, t: 1.0,
    says: ['“I was a better skier because I had the K, and I had the P.”', 'Winston, How to Speak'],
  },
  {
    id: 'quiet', label: 'Talented, not sharing', k: 8, p: 0, t: 1.2,
    says: ['“I’ve encountered many talented people who don’t share their knowledge.”', 'this post, Not to Do'],
  },
  {
    id: 'partner', label: 'My project partner', k: 8, p: 9, t: 0.8,
    says: ['“I’m not as talented as others, so I’ll put in more effort to learn.”', 'this post, Talent'],
  },
];

function slider(label, sym, { min, max, step, cls }, oninput) {
  const input = h('input', { type: 'range', min, max, step, 'aria-label': `${sym}, ${label}` });
  input.addEventListener('input', () => oninput(+input.value));
  const el = h('label', { class: `v-cc-ctl ${cls}` },
    h('span', { class: 'v-cc-sym' }, sym), h('span', { class: 'v-cc-lbl' }, label),
    h('span', { class: 'v-cc-track' }, input));
  return { el, input };
}

function initFormula(fig, app) {
  const st = { k: 5, p: 0, t: 1.0, who: 'you' };
  const eq = equation();

  const chips = PEOPLE.map((pp) => h('button', {
    type: 'button', class: 'v-cc-chip', 'aria-pressed': 'false',
    onclick: () => { Object.assign(st, { k: pp.k, p: pp.p, t: pp.t, who: pp.id }); render(); },
  }, pp.label));

  const sk = slider('what you know', 'K', { min: 0, max: K_MAX, step: 1, cls: 'is-k' }, (v) => { st.k = v; st.who = null; render(); });
  const sp = slider('how much you practise', 'P', { min: 0, max: P_MAX, step: 1, cls: 'is-p' }, (v) => { st.p = v; st.who = null; render(); });
  const stl = slider('talent', 't', { min: T_MIN, max: T_MAX, step: 0.1, cls: 'is-t' }, (v) => { st.t = v; st.who = null; render(); });

  const sum = h('p', { class: 'v-cc-sum' });
  const said = h('p', { class: 'v-cc-said' });
  const read = h('div', { class: 'v-cc-read', 'aria-live': 'polite' }, sum, said);

  function render() {
    const { k, p, t } = st;
    sk.input.value = k; sp.input.value = p; stl.input.value = t;
    chips.forEach((c, i) => c.setAttribute('aria-pressed', String(PEOPLE[i].id === st.who)));
    const v = paint(eq, k, p, t);

    const n = (x) => `<b class="v-cc-n">${num(x)}</b>`;
    let html = `${n(k)} × ${n(p)} × <b class="v-cc-n">${tal(t)}</b> = ${n(v)}. `;
    if (p === 0) {
      html += '<span class="v-cc-bad">With no practice, Q is 0 at any talent.</span>';
    } else if (k === 0) {
      html += '<span class="v-cc-bad">With nothing to say yet, Q is 0.</span> Curiosity grows K: ask questions.';
    } else {
      const lo = q(k, p, T_MIN); const hi = q(k, p, T_MAX);
      /* Compare whole ranges: talent can scale Q by 1.5 at most; practice
         takes it from 0 to its top. That gap is the claim. */
      html += `Talent, across its whole range, moves Q between ${n(lo)} and ${n(hi)}. `;
      html += `Practice, across its range, moves it between ${n(0)} and ${n(q(k, P_MAX, t))}.`;
    }
    sum.innerHTML = html;
    const pp = PEOPLE.find((x) => x.id === st.who);
    said.replaceChildren();
    if (pp?.says) said.append(pp.says[0], h('span', { class: 'v-cc-src' }, ` ${pp.says[1]}`));
    said.hidden = !pp?.says;
  }

  app.append(
    eq.el,
    h('div', { class: 'v-cc-people', role: 'group', 'aria-label': 'People from the post' }, ...chips),
    h('div', { class: 'v-cc-ctls' }, sk.el, sp.el, stl.el),
    read,
    h('p', { class: 'v-cc-key' },
      h('span', { class: 'is-opt' }, 'blue'), ' you can change · ',
      h('span', { class: 'is-data' }, 'brown'), ' numbers · ',
      h('span', { class: 'is-bad' }, 'red'), ' nothing to show yet'),
  );
  if (REDUCED) fig.classList.add('v-cc-still');
  render();
}

register({ 'formula-hero': initHero, formula: initFormula });

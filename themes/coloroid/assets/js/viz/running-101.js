/*
 * running-101 — figures for "Running 101", in the house style.
 *
 *   form-check  guess where my 120 spm start sits among runners, then type
 *               your own four form numbers and see which one to work on
 *               first
 *   hr-zones    your max heart rate gives the post's five zones in bpm;
 *               type a run's average to see its zone
 *
 * Colour follows the site grammar, two accents per view. Form: Garmin's
 * five percentile bands are redrawn red (bottom 5%), light red, neutral,
 * light green, green (top 5%); the reader's number is an ink mark.
 * Heart rate: bpm numbers are brown data; the zone of the reader's run is
 * purple.
 */

import { h, register, clamp, ask, colorKey } from './lib.js';

/* ---------------------------------------------------------------- shared */

let FID = 0;
/** Shared .wv-field: label, input, unit. */
function field(label, value, unit, onchange, { min, max, step, mode = 'numeric' } = {}) {
  const id = `v-r101-f${++FID}`;
  const input = h('input', { id, type: 'number', inputmode: mode, value, min, max, step, autocomplete: 'off' });
  input.addEventListener('input', () => onchange(input.value));
  const el = h('div', { class: 'wv-field' }, h('label', { for: id }, label), input, unit ? h('span', null, unit) : null);
  return { el, input, set(v) { input.value = v; onchange(String(v)); } };
}
/** Read a number in [lo, hi], or NaN. */
function num(v, lo, hi) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : NaN;
}

/* ========================================================= FORM CHECK */

const BAND = [
  { key: 'b0', name: 'bottom 5%', p: [0, 5] },
  { key: 'b1', name: '5th–29th percentile', p: [5, 30] },
  { key: 'b2', name: '30th–69th percentile', p: [30, 70] },
  { key: 'b3', name: '70th–95th percentile', p: [70, 95] },
  { key: 'b4', name: 'top 5%', p: [95, 100] },
];

/* Band edges from the tables in the post (Garmin manuals). `up`: higher is
   better. Edges sit halfway between the table's integer limits. */
const METRIC = {
  cad: { name: 'Cadence', unit: 'spm', up: true, edges: [150.5, 162.5, 173.5, 185.5], v: 120, lim: [60, 250], step: 1 },
  gct: { name: 'Ground contact time', unit: 'ms', up: false, edges: [208, 240.5, 272.5, 305.5], v: 260, lim: [100, 500], step: 1 },
  vo: { name: 'Vertical oscillation', unit: 'cm', up: false, edges: [6.4, 8.15, 9.75, 11.55], v: 9.0, lim: [2, 20], step: 0.1 },
  vr: { name: 'Vertical ratio', unit: '%', up: false, edges: [6.1, 7.45, 8.65, 10.15], v: 10.3, lim: [2, 20], step: 0.1 },
};
const ORDER = ['cad', 'gct', 'vo', 'vr'];

function bandOf(m, v) {
  const M = METRIC[m];
  if (M.up) return M.edges.filter((e) => v > e).length;
  return 4 - M.edges.filter((e) => v >= e).length;
}
/** Position of v along the bar, 0–100, inside its band. */
function posOf(m, v) {
  const M = METRIC[m]; const k = bandOf(m, v);
  const e = M.up ? M.edges : [...M.edges].reverse();
  const w = (a, b) => (M.up ? (v - a) / (b - a) : (a - v) / (a - b));
  let f;
  if (k === 0) f = w(e[0] - (e[1] - e[0]), e[0]);
  else if (k === 4) f = w(e[3], e[3] + (e[3] - e[2]));
  else f = w(e[k - 1], e[k]);
  const [p0, p1] = BAND[k].p;
  return p0 + clamp(f, 0.1, 0.9) * (p1 - p0);
}

function initFormCheck(fig, app) {
  const P = Object.fromEntries(ORDER.map((k) => [k, METRIC[k].v]));
  const rows = h('div', { class: 'v-r101-rows' });
  const key = colorKey([['v-r101-b0', 'below most runners'], ['v-r101-b4', 'above most runners'], ['k-ink', 'your number']]);
  const ends = h('div', { class: 'wv-key v-r101-ends' }, h('span', null, '← bottom 5% of runners'), h('span', null, 'top 5% →'));
  const after = h('div', null, ends, rows, key);
  after.hidden = true;

  /* predict, then see: the rows would give the answer away */
  const guess = ask(
    'I started at 120 steps a minute. Which percentile band is that in, among the runners Garmin measured?',
    BAND.map((b) => [b.key, b.name]),
    'b0',
    (v, right) => {
      after.hidden = false; update();
      return `${right ? 'Yes. ' : ''}120 spm is in the <b>bottom 5%</b>: more than 95% of runners take more steps a minute. So cadence was the first thing I worked on. Now type your own numbers.`;
    },
  );

  const R = {};
  for (const k of ORDER) {
    const M = METRIC[k];
    const f = field(M.name, M.step < 1 ? M.v.toFixed(1) : M.v, M.unit, (v) => {
      const n = num(v, ...M.lim);
      f.input.setAttribute('aria-invalid', String(Number.isNaN(n)));
      if (!Number.isNaN(n)) { P[k] = n; update(); }
    }, { min: M.lim[0], max: M.lim[1], step: M.step, mode: M.step < 1 ? 'decimal' : 'numeric' });
    const you = h('span', { class: 'v-r101-you' });
    const bar = h('div', { class: 'v-r101-bar', 'aria-hidden': 'true' },
      ...BAND.map((b) => h('span', { class: `v-r101-${b.key}`, style: `flex:${b.p[1] - b.p[0]}` })), you);
    const band = h('b');
    const first = h('span', { class: 'wv-tag c-bad' }, 'start here');
    rows.append(h('div', { class: 'v-r101-row' }, h('div', { class: 'v-r101-rhd' }, f.el, first), bar, band));
    R[k] = { you, band, first };
  }

  function update() {
    const b = Object.fromEntries(ORDER.map((k) => [k, bandOf(k, P[k])]));
    const worst = ORDER.reduce((a, k) => (b[k] < b[a] ? k : a), ORDER[0]);
    for (const k of ORDER) {
      R[k].you.style.left = `${posOf(k, P[k])}%`;
      R[k].band.textContent = BAND[b[k]].name;
      R[k].first.style.visibility = k === worst && b[k] <= 2 ? 'visible' : 'hidden';
    }
  }
  update();
  app.append(guess.el, after);
}

/* ========================================================= HR ZONES */

const ZONES = [
  { z: 1, hi: 0.65, eff: 'breathing easily, full sentences' },
  { z: 2, hi: 0.80, eff: 'easy to steady, complete sentences' },
  { z: 3, hi: 0.85, eff: 'moderate, winded if you talk' },
  { z: 4, hi: 0.92, eff: 'threshold, clipped sentences, about an hour' },
  { z: 5, hi: 1.00, eff: 'hard intervals to all-out sprints' },
];
/** bpm ranges: zone 1 starts at 50% of max; upper edges round down. */
function zoneTable(max) {
  let lo = Math.ceil(0.5 * max - 1e-9);
  return ZONES.map((z) => { const hi = Math.floor(z.hi * max + 1e-9); const r = { ...z, lo, hiB: hi }; lo = hi + 1; return r; });
}

function initHrZones(fig, app) {
  const P = { max: 180, run: 140 };
  const table = h('div', { class: 'wv-scroll' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const fMax = field('max heart rate', P.max, 'bpm', (v) => {
    const n = num(v, 120, 230); fMax.input.setAttribute('aria-invalid', String(Number.isNaN(n)));
    if (!Number.isNaN(n)) { P.max = Math.round(n); draw(); }
  }, { min: 120, max: 230 });
  const fAge = field('or age', '', '', (v) => { const n = num(v, 10, 90); if (!Number.isNaN(n)) fMax.set(220 - Math.round(n)); }, { min: 10, max: 90 });
  const fRun = field('a run\'s average', P.run, 'bpm', (v) => {
    const n = num(v, 40, 240); fRun.input.setAttribute('aria-invalid', String(Number.isNaN(n)));
    if (!Number.isNaN(n)) { P.run = Math.round(n); draw(); }
  }, { min: 40, max: 240 });
  app.append(h('div', { class: 'v-r101-fields' }, fMax.el, fAge.el, fRun.el), note, table,
    colorKey([['k-data', 'your zones in bpm'], ['k-look', 'the zone of your run']]));

  function draw() {
    const zt = zoneTable(P.max);
    const zi = zt.findIndex((z) => P.run >= z.lo && P.run <= z.hiB);
    table.innerHTML = `<table class="wv-table"><thead><tr><th>zone</th><th>bpm</th><th>effort</th></tr></thead><tbody>${
      zt.map((z, k) => `<tr class="${k === zi ? 'is-look' : ''}"><td><b>${z.z}</b></td><td class="c-data">${z.lo}–${z.hiB}</td><td>${z.eff}</td></tr>`).join('')}</tbody></table>`;
    if (zi >= 0) note.innerHTML = `A run at <b>${P.run} bpm</b> is <b class="c-look">zone ${zt[zi].z}</b> for a max of ${P.max}.`;
    else if (P.run < zt[0].lo) note.innerHTML = `A run at <b>${P.run} bpm</b> is below zone 1 (under half of ${P.max}).`;
    else note.innerHTML = `<b>${P.run} bpm</b> is above the max you typed, so your real max is higher than ${P.max}.`;
  }
  draw();
}

register({ 'form-check': initFormCheck, 'hr-zones': initHrZones });

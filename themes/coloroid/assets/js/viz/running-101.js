/*
 * running-101 — figures for "Running 101".
 *
 *   one-step   follow one running step: landing, contact, toe-off, flight,
 *              next landing. Each Garmin running-dynamics metric appears at
 *              the moment it is measured.
 *   pace-map   pace = 1000 / (cadence × stride length). Move cadence and
 *              stride length and see pace, 5K time, vertical ratio, and the
 *              stride or cadence each goal pace needs.
 *
 * Percentile bands come from the tables in the post (Garmin watch manuals).
 * The runner in one-step is a sample, not a measurement.
 */

import { h, s, stepper, colorKey, range, register, clamp, tween, btn } from './lib.js';

/* ---------------------------------------------------------------- shared */

/** Garmin percentile bands, same values as the tables in the post. */
const CAD_BANDS = [ // spm, low → high
  [0, 151, '<5%'], [151, 163, '5–29%'], [163, 174, '30–69%'], [174, 186, '70–95%'], [186, 999, '>95%'],
];
const VR_BANDS = [ // percent, best → worst
  [0, 6.1, '>95%'], [6.1, 7.5, '70–95%'], [7.5, 8.7, '30–69%'], [8.7, 10.2, '5–29%'], [10.2, 99, '<5%'],
];
const GCT_BANDS = [ // ms, best → worst
  [0, 208, '>95%'], [208, 241, '70–95%'], [241, 273, '30–69%'], [273, 306, '5–29%'], [306, 9999, '<5%'],
];
const band = (bands, v) => (bands.find(([a, b]) => v >= a && v < b) || bands[bands.length - 1])[2];

/** 4.985 → "4:59" */
function mmss(min) {
  let m = Math.floor(min); let sec = Math.round((min - m) * 60);
  if (sec === 60) { m += 1; sec = 0; }
  return `${m}:${String(sec).padStart(2, '0')}`;
}
const pace = (cad, stride) => 1000 / (cad * stride); // min per km
const n1 = (v) => v.toFixed(1);

/* ============================================================= ONE STEP */

const RUN = { cad: 170, stride: 1.18, gct: 250, vo: 8.6 };
RUN.T = 60000 / RUN.cad; // ms per step
RUN.flight = RUN.T - RUN.gct;
RUN.rise = (9.81 * (RUN.flight / 1000) ** 2) / 8 * 100; // cm, free fall up and down
RUN.dip = RUN.vo - RUN.rise; // cm below landing height at mid-stance
RUN.speed = RUN.cad * RUN.stride; // m/min
RUN.pace = 1000 / RUN.speed;
RUN.vr = (RUN.vo / (RUN.stride * 100)) * 100;

/** Torso height (cm, 0 = height at landing) at time t (ms) since the right foot landed. */
function torso(t) {
  const u = ((t % RUN.T) + RUN.T) % RUN.T;
  if (u < RUN.gct) return -RUN.dip * Math.sin((Math.PI * u) / RUN.gct);
  const f = (u - RUN.gct) / RUN.flight;
  return RUN.rise * 4 * f * (1 - f);
}

const STEP_CARDS = [
  ['gct', 'ground contact', `${RUN.gct} ms`],
  ['vo', 'vertical oscillation', `${n1(RUN.vo)} cm`],
  ['stride', 'stride length', `${RUN.stride.toFixed(2)} m`],
  ['cad', 'cadence', `${RUN.cad} spm`],
  ['vr', 'vertical ratio', `${n1(RUN.vr)}%`],
  ['pace', 'pace', `${mmss(RUN.pace)} /km`],
];

const ONE_STEPS = [
  {
    label: 'Land', t: 0, show: [],
    note: `<b>The right foot lands.</b> The watch starts timing ground contact. One step lasts from this landing to the next one, on the left foot.`,
  },
  {
    label: 'Stance', t: RUN.gct / 2, show: [], low: true,
    note: `<b>The leg bends and the body sinks.</b> Mid-stance is the lowest point of the step, <span class="c-data">${n1(RUN.dip)} cm</span> below the height at landing.`,
  },
  {
    label: 'Toe-off', t: RUN.gct, show: ['gct'], hot: 'gct',
    note: `<b>The foot leaves the ground after <span class="c-data">${RUN.gct} ms</span>.</b> That is ground contact time. In Garmin's table, ${RUN.gct} ms sits in the ${band(GCT_BANDS, RUN.gct)} band.`,
  },
  {
    label: 'Flight', t: RUN.gct + RUN.flight / 2, show: ['gct', 'vo'], hot: 'vo', low: true,
    note: `<b>Both feet are in the air, and the torso peaks.</b> Peak minus the lowest point is vertical oscillation: <span class="c-data">${n1(RUN.vo)} cm</span>. A ${Math.round(RUN.flight)} ms flight lifts the torso only ${n1(RUN.rise)} cm; the rest of the bounce happens during contact.`,
  },
  {
    label: 'Next land', t: RUN.T, show: ['gct', 'vo', 'stride', 'cad'], hot: 'cad', low: true,
    note: `<b>The left foot lands <span class="c-data">${RUN.stride.toFixed(2)} m</span> ahead, ${Math.round(RUN.T)} ms after the right.</b> That distance is stride length. Cadence counts steps per minute: 60,000 / ${Math.round(RUN.T)} = <span class="c-data">${RUN.cad} spm</span>.`,
  },
  {
    label: 'Pace', t: RUN.T, show: ['gct', 'vo', 'stride', 'cad', 'vr', 'pace'], hot: 'pace', low: true,
    note: `<b>Two numbers set the speed.</b> ${RUN.cad} × ${RUN.stride.toFixed(2)} m = ${n1(RUN.speed)} m/min, so pace is 1000 / ${n1(RUN.speed)} = <span class="c-data">${mmss(RUN.pace)} /km</span>, a 5K in ${mmss(RUN.pace * 5)}. Contact time and bounce do not enter the sum. They are the cost of each step. Vertical ratio compares that cost to the gain: ${n1(RUN.vo)} / ${Math.round(RUN.stride * 100)} = <span class="c-data">${n1(RUN.vr)}%</span>.`,
  },
];

function initOneStep(fig, app) {
  const svg = s('svg', { role: 'img', 'aria-label': 'One running step: torso height over time, ground contact, flight, and stride length' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const cards = h('div', { class: 'v-r101-cards' });
  const cardEls = {};
  for (const [k, label] of STEP_CARDS) {
    const v = h('span', { class: 'v' }, '—');
    const c = h('div', { class: 'v-r101-card' }, h('span', { class: 'k' }, label), v);
    cardEls[k] = { c, v };
    cards.append(c);
  }
  const st = stepper(fig, ONE_STEPS, (i, prev) => show(i, prev));
  app.append(st.el, svg, cards, note,
    colorKey([['k-ink', 'torso path'], ['k-data', 'measured value (sample runner)'], ['k-look', 'this step']]));

  let tNow = 0; let step = 0; let cancel = () => {};

  function draw() {
    const W = Math.max(300, app.clientWidth);
    const narrow = W < 520;
    const ky = narrow ? 7 : 8.5; // px per cm of height (exaggerated)
    const m = { l: 14, r: narrow ? 64 : 96 };
    const t0 = -60; const t1 = RUN.T + 60;
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const yTop = 30;
    const y0 = yTop + RUN.rise * ky; // landing height
    const yLow = y0 + RUN.dip * ky;
    const yG = yLow + 58; // ground
    const yBar = yG + 46; // time bar
    const H = yBar + 52;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const S = ONE_STEPS[step];
    const on = new Set(S.show);
    let o = '';
    // trace: full path light, travelled part in ink
    const pts = (a, b) => { const r = []; for (let t = a; t <= b; t += 4) r.push(`${x(t).toFixed(1)},${(y0 - torso(t) * ky).toFixed(1)}`); r.push(`${x(b).toFixed(1)},${(y0 - torso(b) * ky).toFixed(1)}`); return r.join(' L'); };
    o += `<path d="M${pts(t0, t1)}" style="fill:none;stroke:var(--line);stroke-width:1.6;stroke-dasharray:4 4"/>`;
    o += `<path d="M${pts(t0, tNow)}" style="fill:none;stroke:var(--ink);stroke-width:2.2"/>`;
    // landing height reference
    o += `<line x1="${x(t0)}" x2="${x(t1)}" y1="${y0}" y2="${y0}" class="rule" style="stroke-dasharray:2 4"/>`;
    o += `<text x="${m.l}" y="${y0 + 13}" class="t-xs t-mute halo">landing height</text>`;
    // ground and feet
    o += `<line x1="${m.l}" x2="${W - 6}" y1="${yG}" y2="${yG}" class="rule-ink"/>`;
    const foot = (t, lab, lit) => `<rect x="${x(t) - 11}" y="${yG - 6}" width="22" height="6" style="fill:${lit ? 'var(--brown-l)' : 'var(--board)'};stroke:${lit ? 'var(--brown)' : 'var(--ink)'};stroke-width:1.3"/><text x="${x(t)}" y="${yG + 13}" class="t-xs t-b" text-anchor="middle">${lab}</text>`;
    o += foot(0, 'R', true);
    if (tNow >= RUN.T - 1) o += foot(RUN.T, 'L', true);
    // stance leg while the foot is on the ground
    const tx = x(tNow); const ty = y0 - torso(tNow) * ky;
    const inContact = tNow < RUN.gct - 1 || tNow >= RUN.T - 1;
    if (inContact) {
      const fx = tNow >= RUN.T - 1 ? x(RUN.T) : x(0);
      o += `<line x1="${tx}" y1="${ty}" x2="${fx}" y2="${yG - 6}" style="stroke:var(--ink);stroke-width:2.2;stroke-linecap:round"/>`;
    }
    o += `<circle cx="${tx}" cy="${ty}" r="8" style="fill:var(--purple);stroke:var(--board);stroke-width:2"/>`;
    // lowest and highest markers
    const xLow = x(RUN.gct / 2); const xHigh = x(RUN.gct + RUN.flight / 2);
    const yHigh = y0 - RUN.rise * ky;
    if (S.low) {
      o += `<line x1="${xLow - 18}" x2="${xLow + 18}" y1="${yLow}" y2="${yLow}" style="stroke:var(--brown);stroke-width:1.4"/>`;
      o += `<text x="${xLow}" y="${yLow + 14}" class="t-xs t-data t-b halo" text-anchor="middle">lowest</text>`;
    }
    if (on.has('vo')) {
      const vx = x(t1) + 10; const hot = S.hot === 'vo';
      const col = hot ? 'var(--purple)' : 'var(--brown)';
      o += `<line x1="${xHigh}" x2="${vx + 6}" y1="${yHigh}" y2="${yHigh}" style="stroke:${col};stroke-width:1;stroke-dasharray:2 3"/>`;
      o += `<line x1="${xLow}" x2="${vx + 6}" y1="${yLow}" y2="${yLow}" style="stroke:${col};stroke-width:1;stroke-dasharray:2 3"/>`;
      o += `<line x1="${vx + 3}" x2="${vx + 3}" y1="${yHigh}" y2="${yLow}" style="stroke:${col};stroke-width:2"/>`;
      o += `<text x="${vx + 9}" y="${(yHigh + yLow) / 2 + 4}" class="t-s t-b halo" style="fill:${col}">${n1(RUN.vo)} cm</text>`;
    }
    // stride length bracket along the ground
    if (on.has('stride')) {
      const yb = yG + 24; const hot = S.hot === 'cad' || S.hot === 'stride';
      const col = hot ? 'var(--purple)' : 'var(--brown)';
      o += `<line x1="${x(0)}" x2="${x(RUN.T)}" y1="${yb}" y2="${yb}" style="stroke:${col};stroke-width:1.6"/>`;
      o += `<line x1="${x(0)}" x2="${x(0)}" y1="${yb - 5}" y2="${yb + 5}" style="stroke:${col};stroke-width:1.6"/><line x1="${x(RUN.T)}" x2="${x(RUN.T)}" y1="${yb - 5}" y2="${yb + 5}" style="stroke:${col};stroke-width:1.6"/>`;
      o += `<text x="${(x(0) + x(RUN.T)) / 2}" y="${yb - 5}" class="t-s t-b halo" text-anchor="middle" style="fill:${col}">stride length ${RUN.stride.toFixed(2)} m</text>`;
    }
    // time bar: contact then flight
    const tEnd = clamp(tNow, 0, RUN.T);
    const cEnd = Math.min(tEnd, RUN.gct);
    const bh = 18;
    const gctHot = S.hot === 'gct';
    o += `<rect x="${x(0)}" y="${yBar}" width="${x(RUN.gct) - x(0)}" height="${bh}" style="fill:var(--board);stroke:var(--ink);stroke-width:1.2"/>`;
    o += `<rect x="${x(RUN.gct)}" y="${yBar}" width="${x(RUN.T) - x(RUN.gct)}" height="${bh}" style="fill:var(--board);stroke:var(--ink);stroke-width:1.2;stroke-dasharray:4 3"/>`;
    if (cEnd > 0) o += `<rect x="${x(0)}" y="${yBar}" width="${x(cEnd) - x(0)}" height="${bh}" style="fill:${gctHot ? 'var(--purple-l)' : 'var(--brown-l)'};stroke:${gctHot ? 'var(--purple)' : 'var(--brown)'};stroke-width:1.5"/>`;
    if (tEnd > RUN.gct) o += `<rect x="${x(RUN.gct)}" y="${yBar}" width="${x(tEnd) - x(RUN.gct)}" height="${bh}" style="fill:var(--tint2);stroke:var(--ink);stroke-width:1.2;stroke-dasharray:4 3"/>`;
    const lab = (t0_, t1_, txt, cls) => `<text x="${(x(t0_) + x(t1_)) / 2}" y="${yBar + 12.5}" class="t-xs t-b ${cls}" text-anchor="middle">${txt}</text>`;
    o += lab(0, RUN.gct, on.has('gct') ? `on ground ${RUN.gct} ms` : (narrow ? 'ground' : 'on ground'), '');
    o += lab(RUN.gct, RUN.T, narrow ? 'air' : `air ${Math.round(RUN.flight)} ms`, '');
    o += `<text x="${x(0) - 6}" y="${yBar + 12.5}" class="t-xs t-mute" text-anchor="end">time →</text>`;
    if (on.has('cad')) {
      const yb = yBar + bh + 14; const col = S.hot === 'cad' ? 'var(--purple)' : 'var(--brown)';
      o += `<line x1="${x(0)}" x2="${x(RUN.T)}" y1="${yb - 4}" y2="${yb - 4}" style="stroke:${col};stroke-width:1.2"/>`;
      o += `<text x="${(x(0) + x(RUN.T)) / 2}" y="${yb + 10}" class="t-xs t-b halo" text-anchor="middle" style="fill:${col}">one step ${Math.round(RUN.T)} ms = ${RUN.cad} spm</text>`;
    }
    svg.innerHTML = o;
  }

  function show(i, prev) {
    step = i;
    const S = ONE_STEPS[i];
    const on = new Set(S.show);
    for (const [k] of STEP_CARDS) {
      const { c, v } = cardEls[k];
      v.textContent = on.has(k) ? STEP_CARDS.find((x) => x[0] === k)[2] : '—';
      c.classList.toggle('is-on', on.has(k));
      c.classList.toggle('is-hot', S.hot === k || (S.hot === 'cad' && k === 'stride') || (S.hot === 'pace' && k === 'vr'));
    }
    note.innerHTML = S.note;
    cancel();
    const from = prev >= 0 && ONE_STEPS[prev].t <= S.t ? tNow : (prev > i ? S.t : 0);
    const to = S.t;
    if (from === to) { tNow = to; draw(); return; }
    cancel = tween(Math.min(1200, 5 * Math.abs(to - from)), (k) => { tNow = from + (to - from) * k; draw(); });
  }

  new ResizeObserver(() => draw()).observe(app);
  st.go(0);
}

/* ============================================================= PACE MAP */

/* Goals from the post's "Next Steps" list. */
const GOALS = [
  { p: 7, lab: '7:00', race: '5K 35:00', done: true },
  { p: 6, lab: '6:00', race: '5K 30:00, 10K 60:00', done: true },
  { p: 5, lab: '5:00', race: '5K 25:00', done: true },
  { p: 4, lab: '4:00', race: '5K 20:00', done: false },
];
const CX = [110, 200]; const LY = [0.6, 1.6];

function initPaceMap(fig, app) {
  const P = { cad: RUN.cad, stride: RUN.stride, vo: RUN.vo };
  const svg = s('svg', { role: 'img', 'aria-label': 'Stride length against cadence, with curves of equal pace for each goal' });
  const read = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const need = h('div', { class: 'v-r101-need' });

  const rc = range('cadence', { min: 110, max: 200, step: 1, value: P.cad, fmt: (v) => `${v} spm`, oninput: (v) => { P.cad = v; draw(); } });
  const rs = range('stride length', { min: 0.6, max: 1.6, step: 0.01, value: P.stride, fmt: (v) => `${v.toFixed(2)} m`, oninput: (v) => { P.stride = v; draw(); } });
  const rv = range('vertical oscillation', { min: 5, max: 13, step: 0.1, value: P.vo, fmt: (v) => `${v.toFixed(1)} cm`, oninput: (v) => { P.vo = v; draw(); } });
  const preset = (label, c, l) => btn(label, () => { rc.set(c); rs.set(l); });
  const presets = h('div', { class: 'wv-seg v-r101-presets' },
    h('span', { class: 'v-r101-plabel' }, 'try:'),
    preset('my start (120 spm)', 120, 0.88),
    preset('Fig. 1 runner', RUN.cad, RUN.stride),
    preset('sub-20 at 180 spm', 180, 1.39));

  app.append(h('div', { class: 'wv-grid-ctrl' }, rc.el, rs.el, rv.el), presets, svg,
    colorKey([['k-look', 'you'], ['k-safe', 'goal reached'], ['k-pick', 'next goal'], ['k-opt', 'drag or slide'], ['k-data', 'computed']]),
    h('div', { style: 'height:.6rem' }), read, need);

  let geom = null;

  function draw() {
    const W = Math.max(300, app.clientWidth);
    const narrow = W < 560;
    const H = clamp(Math.round(W * 0.6), 300, 420);
    const m = { l: 42, r: 12, t: 34, b: 36 };
    const x = (c) => m.l + ((c - CX[0]) / (CX[1] - CX[0])) * (W - m.l - m.r);
    const y = (l) => H - m.b - ((l - LY[0]) / (LY[1] - LY[0])) * (H - m.t - m.b);
    geom = { m, W, H };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = `<defs><clipPath id="v-r101-clip"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></clipPath></defs>`;
    // cadence percentile bands
    CAD_BANDS.forEach(([a, b, lab], k) => {
      const xa = x(clamp(a, CX[0], CX[1])); const xb = x(clamp(b, CX[0], CX[1]));
      const tint = k % 2 ? 'var(--tint2)' : 'var(--tint)';
      o += `<rect x="${xa}" y="${m.t}" width="${xb - xa}" height="${H - m.t - m.b}" style="fill:${tint}"/>`;
      const short = narrow ? lab.replace('%', '') : lab;
      o += `<text x="${(xa + xb) / 2}" y="${m.t - 6}" class="t-xs t-mute" text-anchor="middle">${short}</text>`;
    });
    o += `<text x="${m.l}" y="${m.t - 20}" class="t-xs t-mute">cadence percentile (Garmin) · ↑ stride length (m)</text>`;
    // grid
    for (let l = 0.6; l <= 1.601; l += 0.2) {
      o += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(l)}" y2="${y(l)}" class="rule" style="opacity:.6"/>`;
      o += `<text x="${m.l - 6}" y="${y(l) + 3.5}" class="t-xs t-mute" text-anchor="end">${l.toFixed(1)}</text>`;
    }
    for (let c = 110; c <= 200; c += narrow ? 30 : 10) o += `<text x="${x(c)}" y="${H - m.b + 14}" class="t-xs t-mute" text-anchor="middle">${c}</text>`;
    o += `<text x="${W - m.r}" y="${H - 4}" class="t-xs t-mute" text-anchor="end">cadence (spm) →</text>`;
    // equal-pace curves
    for (const g of GOALS) {
      const pts = []; for (let c = CX[0]; c <= CX[1]; c += 1) pts.push(`${x(c).toFixed(1)},${y(1000 / (g.p * c)).toFixed(1)}`);
      const col = g.done ? 'var(--green)' : 'var(--orange)';
      o += `<path d="M${pts.join(' L')}" clip-path="url(#v-r101-clip)" style="fill:none;stroke:${col};stroke-width:${g.done ? 2 : 3}"/>`;
      const txt = narrow ? `${g.lab}/km` : `${g.lab}/km · ${g.race}`;
      // baseline sits above the curve across the whole label, which rises to the left
      const cStart = CX[0] + ((x(CX[1]) - 5 - txt.length * 6.1 - m.l) / (W - m.l - m.r)) * (CX[1] - CX[0]);
      const ly = y(1000 / (g.p * cStart)) - 5;
      o += `<text x="${x(CX[1]) - 5}" y="${ly}" class="t-xs t-b halo" text-anchor="end" style="fill:${col}">${txt}</text>`;
    }
    o += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" class="rule-ink"/>`;
    // the reader's point
    const px = x(P.cad); const py = y(P.stride);
    o += `<line x1="${px}" x2="${px}" y1="${py}" y2="${H - m.b}" style="stroke:var(--purple);stroke-width:1.2;stroke-dasharray:3 3"/>`;
    o += `<line x1="${m.l}" x2="${px}" y1="${py}" y2="${py}" style="stroke:var(--purple);stroke-width:1.2;stroke-dasharray:3 3"/>`;
    o += `<circle cx="${px}" cy="${py}" r="7" style="fill:var(--purple);stroke:var(--board);stroke-width:2.5"/>`;
    const lx = px < W / 2 ? px + 12 : px - 12;
    o += `<text x="${lx}" y="${py - 10}" class="t-s t-b halo" text-anchor="${px < W / 2 ? 'start' : 'end'}" style="fill:var(--purple)">${mmss(pace(P.cad, P.stride))}/km</text>`;
    svg.innerHTML = o;
    readout();
  }

  function readout() {
    const sp = P.cad * P.stride; const pc = 1000 / sp; const vr = (P.vo / (P.stride * 100)) * 100;
    read.innerHTML = `<span class="c-data">${P.cad}</span> steps/min × <span class="c-data">${P.stride.toFixed(2)} m</span> = ${n1(sp)} m/min → pace <b class="c-data">${mmss(pc)} /km</b>, 5K in <b>${mmss(pc * 5)}</b>. ` +
      `Cadence band: ${band(CAD_BANDS, P.cad)} of runners. ` +
      `Vertical ratio ${n1(P.vo)} / ${Math.round(P.stride * 100)} = <b class="c-data">${n1(vr)}%</b> (${band(VR_BANDS, vr)} band).`;
    need.innerHTML = `<div class="wv-scroll"><table class="wv-mini"><thead><tr><th>goal</th><th>stride needed<br>at ${P.cad} spm</th><th>cadence needed<br>at ${P.stride.toFixed(2)} m</th></tr></thead><tbody>${
      GOALS.map((g) => {
        const L = 1000 / (g.p * P.cad); const C = 1000 / (g.p * P.stride);
        const ok = pace(P.cad, P.stride) <= g.p + 1e-9;
        return `<tr><td class="${ok ? 'ok' : ''}">${g.lab}/km${g.done ? '' : ' next'}</td><td>${L.toFixed(2)} m</td><td>${Math.ceil(C)} spm</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // drag the point
  let drag = false;
  const toData = (e) => {
    const b = svg.getBoundingClientRect();
    const sx = ((e.clientX - b.left) / b.width) * geom.W; const sy = ((e.clientY - b.top) / b.height) * geom.H;
    const c = CX[0] + ((sx - geom.m.l) / (geom.W - geom.m.l - geom.m.r)) * (CX[1] - CX[0]);
    const l = LY[0] + ((geom.H - geom.m.b - sy) / (geom.H - geom.m.t - geom.m.b)) * (LY[1] - LY[0]);
    rc.set(Math.round(clamp(c, CX[0], CX[1])));
    rs.set(Math.round(clamp(l, LY[0], LY[1]) * 100) / 100);
  };
  svg.style.touchAction = 'pan-y';
  svg.style.cursor = 'crosshair';
  svg.addEventListener('pointerdown', (e) => { drag = true; svg.setPointerCapture(e.pointerId); toData(e); });
  svg.addEventListener('pointermove', (e) => { if (drag) toData(e); });
  svg.addEventListener('pointerup', () => { drag = false; });
  svg.addEventListener('pointercancel', () => { drag = false; });

  new ResizeObserver(() => draw()).observe(app);
  draw();
}

register({ 'one-step': initOneStep, 'pace-map': initPaceMap });

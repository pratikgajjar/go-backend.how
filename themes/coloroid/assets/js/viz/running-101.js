/*
 * running-101 — figures for "Running 101". Typographic, on the page colour,
 * no whiteboard frame. The reader types their own numbers.
 *
 *   progress    hero: my pace, goal by goal (numbers from the post)
 *   form-check  type your cadence, contact time, bounce and pace; a small
 *               runner moves with those numbers, and each metric lands in
 *               Garmin's percentile band. Suggests one metric to work on.
 *   footprints  goal time → step length you need, drawn as five seconds of
 *               footprints at your cadence and at 180 spm
 *   hr-zones    your max heart rate → the five zones from the post; type a
 *               run's average heart rate to see its zone
 *
 * Colour in this post means one thing: Garmin's percentile band
 * (red < 5%, orange 5–29%, green 30–69%, blue 70–95%, purple > 95%).
 * Everything else is ink on the page colour. Heart-rate zones use ink
 * density, darker = harder.
 */

import { h, s, register, clamp, REDUCED, onVisible } from './lib.js';

/* ---------------------------------------------------------------- shared */

const BAND = [
  { key: 'b0', name: 'bottom 5%', p: [0, 5] },
  { key: 'b1', name: '5th–29th percentile', p: [5, 30] },
  { key: 'b2', name: '30th–69th percentile', p: [30, 70] },
  { key: 'b3', name: '70th–95th percentile', p: [70, 95] },
  { key: 'b4', name: 'top 5%', p: [95, 100] },
];

/* Band edges from the tables in the post (Garmin manuals). */
const METRIC = {
  cad: { name: 'Cadence', unit: 'spm', up: true, edges: [150.5, 162.5, 173.5, 185.5] },
  gct: { name: 'Ground contact time', unit: 'ms', up: false, edges: [208, 240.5, 272.5, 305.5] },
  vo: { name: 'Vertical oscillation', unit: 'cm', up: false, edges: [6.4, 8.15, 9.75, 11.55] },
  vr: { name: 'Vertical ratio', unit: '%', up: false, edges: [6.1, 7.45, 8.65, 10.15] },
};

/** Band index 0 (worst) … 4 (best). */
function bandOf(m, v) {
  const M = METRIC[m];
  if (M.up) return M.edges.filter((e) => v > e).length;
  return 4 - M.edges.filter((e) => v >= e).length;
}
/** Position 0…100 on a bar where each band takes its share of runners. */
function posOf(m, v) {
  const M = METRIC[m]; const k = bandOf(m, v);
  const e = M.up ? M.edges : [...M.edges].reverse();
  const w = (a, b) => (M.up ? (v - a) / (b - a) : (a - v) / (a - b));
  let f;
  if (k === 0) f = w(e[0] - (e[1] - e[0]), e[0]);
  else if (k === 4) f = w(e[3], e[3] + (e[3] - e[2]));
  else f = w(e[k - 1], e[k]);
  const [p0, p1] = BAND[k].p;
  return p0 + clamp(f, 0.08, 0.92) * (p1 - p0);
}

function mmss(min) {
  let m = Math.floor(min); let sec = Math.round((min - m) * 60);
  if (sec === 60) { m += 1; sec = 0; }
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
/** "6:30" or "1:05:00" or "25" → minutes. */
function parseTime(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[0] + p[1] / 60;
  if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
  return NaN;
}

/** A labelled text field. onchange gets the raw string. */
function field(label, value, unit, onchange, { mode = 'decimal', width = 5, hint } = {}) {
  const input = h('input', { type: 'text', inputmode: mode, value, size: width, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
  input.addEventListener('input', () => onchange(input.value));
  const el = h('label', { class: 'v-r101-field' },
    h('span', { class: 'lab' }, label),
    h('span', { class: 'box' }, input, unit ? h('span', { class: 'unit' }, unit) : null),
    hint ? h('span', { class: 'hint' }, hint) : null);
  return { el, input, set(v) { input.value = v; onchange(String(v)); } };
}

function chips(items, onpick) {
  return h('div', { class: 'v-r101-chips' }, ...items.map(([label, v]) =>
    h('button', { type: 'button', class: 'v-r101-chip', onclick: () => onpick(v) }, label)));
}

/* =============================================================== HERO */

/* From the post: the 4K before the plan, "Result", and "Next Steps". */
const MILES = [
  { d: '4K', when: 'before the plan', t: '38:00', pace: 9.5, kind: 'done' },
  { d: '5K', when: 'Oct 2024', t: '~35:00', pace: 7, kind: 'done' },
  { d: '5K', when: 'Nov 15, 2024', t: '< 30:00', pace: 6, kind: 'done' },
  { d: '5K', when: 'Dec 4, 2024', t: '24:45', pace: 4.95, kind: 'done' },
  { d: '10K', when: 'Feb 6, 2025', t: '< 60:00', pace: 6, kind: 'ten' },
  { d: '5K', when: 'by 2026', t: '< 20:00', pace: 4, kind: 'next' },
];

function initProgress(fig, app) {
  const svg = s('svg', { role: 'img', 'aria-label': 'My running pace by goal: 9:30 per km before the plan, then 7:00, under 6:00, 4:57 for a 5K, a 10K under 60 minutes, and a sub-20 5K still ahead' });
  app.append(h('div', { class: 'v-r101-hero-big' },
    h('span', { class: 'n' }, '9:30'), h('span', { class: 'arr' }, '→'), h('span', { class: 'n' }, '4:57'), h('span', { class: 'u' }, 'min/km')),
  h('p', { class: 'v-r101-hero-sub' }, 'Four goals, one at a time, October 2024 to February 2025. The next one is a 5K under 20 minutes.'),
  svg);

  function draw() {
    const W = Math.max(300, app.clientWidth);
    const narrow = W < 560;
    const H = narrow ? 250 : 230;
    const m = { l: narrow ? 58 : 70, r: narrow ? 26 : 40, t: 40, b: 58 };
    const n = MILES.length;
    const x = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r);
    const y = (p) => m.t + ((p - 4) / (10 - 4)) * (H - m.t - m.b); // faster pace sits higher
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = '';
    for (const p of [4, 5, 6, 7, 8, 9, 10]) {
      o += `<line x1="38" x2="${W - 4}" y1="${y(p)}" y2="${y(p)}" class="v-r101-hair"/>`;
      o += `<text x="0" y="${y(p) + 3.5}" class="v-r101-t xs soft">${p}:00</text>`;
    }
    // ladder through the 5K results (and the 4K start)
    const lad = MILES.map((mi, i) => [mi, i]).filter(([mi]) => mi.kind === 'done');
    let d = `M${x(lad[0][1])},${y(lad[0][0].pace)}`;
    for (let k = 1; k < lad.length; k++) d += ` H${x(lad[k][1])} V${y(lad[k][0].pace)}`;
    o += `<path d="${d}" class="v-r101-ladder"/>`;
    const last = lad[lad.length - 1];
    o += `<path d="M${x(last[1])},${y(last[0].pace)} H${x(n - 1)} V${y(4)}" class="v-r101-ladder next"/>`;
    MILES.forEach((mi, i) => {
      const cx = x(i); const cy = y(mi.pace);
      if (mi.kind === 'ten') o += `<rect x="${cx - 6}" y="${cy - 6}" width="12" height="12" class="v-r101-dot"/>`;
      else o += `<circle cx="${cx}" cy="${cy}" r="${mi.kind === 'next' ? 6.5 : 6}" class="v-r101-dot ${mi.kind}"/>`;
      const up = mi.kind !== 'ten';
      o += `<text x="${cx}" y="${up ? cy - 12 : cy + 20}" text-anchor="middle" class="v-r101-t ${narrow ? 's' : 'm'} b halo">${mi.t}</text>`;
      o += `<text x="${cx}" y="${H - m.b + 26}" text-anchor="middle" class="v-r101-t s b">${mi.d}</text>`;
      const w = mi.when.split(', ');
      const lines = narrow ? (w.length > 1 ? [w[0], w[1]] : mi.when.split(' ').length > 2 ? [mi.when.split(' ').slice(0, 1).join(' '), mi.when.split(' ').slice(1).join(' ')] : [mi.when]) : [mi.when];
      lines.forEach((ln, k) => { o += `<text x="${cx}" y="${H - m.b + 40 + k * 12}" text-anchor="middle" class="v-r101-t xs soft">${ln}</text>`; });
    });
    o += `<text x="0" y="${m.t - 24}" class="v-r101-t xs soft">min/km, faster ↑</text>`;
    svg.innerHTML = o;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* ========================================================= FORM CHECK */

const SUGGEST = {
  cad: 'Run to a playlist with a beat a little above your cadence (see Music below), and raise it slowly.',
  gct: 'Build leg strength with calisthenics, and try landing closer to the forefoot.',
  vo: 'Push forward, not up. Keep the same pace with less bounce.',
  vr: 'Vertical ratio is bounce ÷ step length. Less bounce at the same step length lowers it.',
};

function initFormCheck(fig, app) {
  const P = { cad: 165, gct: 260, vo: 9.0, pace: 6.5 };
  const ok = { cad: true, gct: true, vo: true, pace: true };
  const slow = h('button', { type: 'button', class: 'v-r101-chip', 'aria-pressed': 'false' }, 'slow motion ×¼');
  const play = h('button', { type: 'button', class: 'v-r101-chip' }, REDUCED ? 'play' : 'pause');
  const runner = s('svg', { role: 'img', 'aria-label': 'A runner moving with the cadence, contact time and bounce you typed' });
  const step = h('p', { class: 'v-r101-stepline', 'aria-live': 'polite' });
  const bars = h('div', { class: 'v-r101-bars' });
  const focus = h('div', { class: 'v-r101-focus', 'aria-live': 'polite' });

  const num = (k, lo, hi) => (v) => { const n = parseFloat(v); ok[k] = Number.isFinite(n) && n >= lo && n <= hi; if (ok[k]) P[k] = n; update(); };
  const fCad = field('cadence', P.cad, 'spm', num('cad', 100, 230), { mode: 'numeric', width: 4 });
  const fGct = field('ground contact', P.gct, 'ms', num('gct', 120, 450), { mode: 'numeric', width: 4 });
  const fVo = field('vertical oscillation', P.vo.toFixed(1), 'cm', num('vo', 3, 18), { width: 4 });
  const fPace = field('pace', mmss(P.pace), '/km', (v) => { const t = parseTime(v); ok.pace = t >= 2.5 && t <= 15; if (ok.pace) P.pace = t; update(); }, { width: 5 });
  const presets = chips([
    ['sample runner', { cad: 165, gct: 260, vo: 9.0, pace: '6:30' }],
    ['my start: 120 spm, 9:30/km', { cad: 120, pace: '9:30' }],
  ], (v) => {
    if (v.cad != null) fCad.set(v.cad); if (v.gct != null) fGct.set(v.gct);
    if (v.vo != null) fVo.set(v.vo.toFixed(1)); if (v.pace != null) fPace.set(v.pace);
  });

  app.append(
    h('p', { class: 'v-r101-lede' }, 'Type the averages from one of your runs. Garmin Connect shows them under Running Dynamics.'),
    h('div', { class: 'v-r101-fields' }, fCad.el, fGct.el, fVo.el, fPace.el),
    presets,
    h('div', { class: 'v-r101-stage' }, h('div', { class: 'v-r101-stagectl' }, play, slow), runner),
    step, bars, focus,
    h('p', { class: 'v-r101-key' }, 'Colour = Garmin percentile band: ',
      ...BAND.map((b) => h('span', null, h('i', { class: b.key }), b.name.replace('percentile', '').trim()))),
  );

  /* body model --------------------------------------------------- */
  const G = { T: 0, gct: 0, fl: 0, rise: 0, dip: 0, v: 0, L: 0 };
  function model() {
    G.T = 60 / P.cad; G.gct = Math.min(P.gct / 1000, G.T); G.fl = G.T - G.gct;
    G.rise = (9.81 * G.fl ** 2) / 8; G.dip = Math.max(0, P.vo / 100 - G.rise);
    G.v = 1000 / (P.pace * 60); G.L = G.v * G.T;
  }
  function hipZ(t) {
    const u = ((t % G.T) + G.T) % G.T;
    if (u < G.gct) return -G.dip * Math.sin((Math.PI * u) / G.gct);
    const f = (u - G.gct) / G.fl; return G.rise * 4 * f * (1 - f);
  }
  /** Foot (x, lift) relative to the hip for a foot whose own clock is u in [0, 2T). */
  function foot(u) {
    const d = G.v * G.gct; const cyc = 2 * G.T;
    u = ((u % cyc) + cyc) % cyc;
    if (u < G.gct) return [d / 2 - G.v * u, 0, true];
    const w = (u - G.gct) / (cyc - G.gct);
    const x = -d / 2 + d * (1 - Math.cos(Math.PI * w)) / 2 - 0.28 * Math.sin(Math.PI * w) * (1 - w);
    return [x, 0.3 * Math.sin(Math.PI * w) ** 1.3, false];
  }
  const SEG = 0.5; const H0 = 0.88;
  function knee(hx, hy, fx, fy) {
    let dx = fx - hx; let dy = fy - hy; let D = Math.hypot(dx, dy);
    if (D > 2 * SEG * 0.999) { const k = (2 * SEG * 0.999) / D; dx *= k; dy *= k; D = 2 * SEG * 0.999; fx = hx + dx; fy = hy + dy; }
    const a = D / 2; const hh = Math.sqrt(Math.max(0, SEG * SEG - a * a));
    const mx = hx + dx / 2; const my = hy + dy / 2;
    let nx = -dy / D; let ny = dx / D; // perpendicular
    if (nx < 0) { nx = -nx; ny = -ny; } // knee points forward
    return [[mx + nx * hh, my + ny * hh], [fx, fy]];
  }

  let t = 0; let last = 0; let raf = 0; let running = !REDUCED; let visible = true; let rate = 1;
  function drawRunner() {
    const W = Math.max(280, runner.parentElement.clientWidth || 300);
    const S = W < 480 ? 88 : 104; const Hh = 1.95 * S; const gy = Hh - 12; const cx = W / 2 + 10;
    runner.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const X = (mx) => cx + mx * S; const Y = (mz) => gy - mz * S;
    const hz = H0 + hipZ(t);
    const hip = [0, hz];
    const lean = 0.12; const sh = [0.55 * Math.sin(lean), hz + 0.55 * Math.cos(lean)];
    let o = '';
    // ground: ticks slide back at running speed
    const off = (G.v * t) % 0.5;
    o += `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="v-r101-ground"/>`;
    for (let gx = -W / S; gx < W / S; gx += 0.5) { const px = X(gx - off); if (px > 0 && px < W) o += `<line x1="${px}" x2="${px - 6}" y1="${gy}" y2="${gy + 8}" class="v-r101-hair2"/>`; }
    // bounce guides: top and bottom of the hip path
    const top = Y(H0 + G.rise); const bot = Y(H0 - G.dip);
    o += `<line x1="${X(-0.9)}" x2="${X(0.75)}" y1="${top}" y2="${top}" class="v-r101-guide"/><line x1="${X(-0.9)}" x2="${X(0.75)}" y1="${bot}" y2="${bot}" class="v-r101-guide"/>`;
    o += `<text x="${X(0.8)}" y="${(top + bot) / 2 + 4}" class="v-r101-t s b ${BAND[bandOf('vo', P.vo)].key}-t">${P.vo.toFixed(1)} cm</text>`;
    const limb = (u, back) => {
      const [fx, fz, on] = foot(u);
      const [k, f] = knee(hip[0], hip[1], fx, fz);
      return `<path d="M${X(hip[0])},${Y(hip[1])} L${X(k[0])},${Y(k[1])} L${X(f[0])},${Y(f[1])} l${S * 0.13},0" class="v-r101-limb${back ? ' back' : ''}${on ? ' on' : ''}"/>`;
    };
    const arm = (ph, back) => {
      const a = 0.6 * Math.sin(ph); const e = [sh[0] + 0.28 * Math.sin(a), sh[1] - 0.28 * Math.cos(a)];
      const hnd = [e[0] + 0.24 * Math.cos(a * 0.6 + 0.2), e[1] + 0.24 * Math.sin(0.5 + a * 0.4)];
      return `<path d="M${X(sh[0])},${Y(sh[1])} L${X(e[0])},${Y(e[1])} L${X(hnd[0])},${Y(hnd[1])}" class="v-r101-limb arm${back ? ' back' : ''}"/>`;
    };
    const ph = (Math.PI * t) / G.T;
    o += limb(t + G.T, true) + arm(ph, true);
    o += `<line x1="${X(hip[0])}" y1="${Y(hip[1])}" x2="${X(sh[0])}" y2="${Y(sh[1])}" class="v-r101-limb torso"/>`;
    o += `<circle cx="${X(sh[0] + 0.03)}" cy="${Y(sh[1] + 0.17)}" r="${0.11 * S}" class="v-r101-head"/>`;
    o += limb(t, false) + arm(ph + Math.PI, false);
    // live state
    const u = ((t % G.T) + G.T) % G.T;
    const inAir = u >= G.gct && G.fl > 0.001;
    o += `<text x="4" y="${gy - 30}" class="v-r101-t s b">${inAir ? 'in the air' : 'foot on the ground'}</text>`;
    o += `<text x="4" y="${gy - 14}" class="v-r101-t xs soft">${rate < 1 ? 'slow motion, ×¼' : 'real time'}</text>`;
    runner.innerHTML = o;
  }
  function loop(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
    t += dt * rate; drawRunner();
    raf = running && visible ? requestAnimationFrame(loop) : 0;
  }
  function kick() { if (!raf && running && visible) { last = 0; raf = requestAnimationFrame(loop); } }
  play.addEventListener('click', () => { running = !running; play.textContent = running ? 'pause' : 'play'; if (running) kick(); });
  slow.addEventListener('click', () => { rate = rate === 1 ? 0.25 : 1; slow.setAttribute('aria-pressed', String(rate < 1)); if (!running) drawRunner(); });
  onVisible(fig, (v) => { visible = v; if (v) kick(); });

  /* readouts ------------------------------------------------------ */
  function update() {
    for (const [k, f] of [['cad', fCad], ['gct', fGct], ['vo', fVo], ['pace', fPace]]) f.el.classList.toggle('is-bad', !ok[k]);
    model();
    const vr = (P.vo / (G.L * 100)) * 100;
    step.innerHTML = G.fl > 0.001
      ? `One step lasts <b>${Math.round(G.T * 1000)} ms</b>: ${Math.round(G.gct * 1000)} ms on the ground, ${Math.round(G.fl * 1000)} ms in the air. At ${mmss(P.pace)}/km each step covers <b>${G.L.toFixed(2)} m</b>.`
      : `At ${Math.round(P.cad)} spm one step lasts ${Math.round(G.T * 1000)} ms, shorter than ${Math.round(P.gct)} ms of contact, so a foot is always on the ground. Each step covers <b>${G.L.toFixed(2)} m</b>.`;
    const vals = { cad: P.cad, gct: P.gct, vo: P.vo, vr };
    const show = { cad: `${Math.round(P.cad)} spm`, gct: `${Math.round(P.gct)} ms`, vo: `${P.vo.toFixed(1)} cm`, vr: `${vr.toFixed(1)}%` };
    bars.innerHTML = '';
    for (const k of ['cad', 'gct', 'vo', 'vr']) {
      const b = bandOf(k, vals[k]); const pos = posOf(k, vals[k]);
      const M = METRIC[k];
      const segs = BAND.map((bd) => `<span class="seg ${bd.key}" style="flex:${bd.p[1] - bd.p[0]}"></span>`).join('');
      bars.append(h('div', { class: 'v-r101-bar' },
        h('div', { class: 'top' }, h('span', { class: 'nm' }, M.name, k === 'vr' ? h('span', { class: 'sub' }, ` = ${P.vo.toFixed(1)} ÷ ${Math.round(G.L * 100)}`) : null),
          h('span', { class: `val ${BAND[b].key}-t` }, show[k])),
        h('div', { class: 'track', html: `${segs}<span class="you" style="left:${pos}%"></span>` }),
        h('div', { class: 'bot' }, h('span', null, `← ${M.up ? 'lower' : 'higher'}`), h('span', { class: `${BAND[b].key}-t` }, BAND[b].name), h('span', null, `${M.up ? 'higher' : 'lower'} →`))));
    }
    const order = ['cad', 'gct', 'vr', 'vo'];
    const worst = order.reduce((a, k) => (bandOf(k, vals[k]) < bandOf(a, vals[a]) ? k : a), order[0]);
    const wb = bandOf(worst, vals[worst]);
    focus.innerHTML = wb >= 3
      ? `<b>All four are in the top bands.</b> Keep the runs consistent and work on pace and distance.`
      : `<span class="lab">Work on first</span><b>${METRIC[worst].name}</b> (${BAND[wb].name}). ${SUGGEST[worst]}`;
    drawRunner();
  }

  new ResizeObserver(() => drawRunner()).observe(app);
  if (REDUCED) t = 0; // static first frame
  update();
  if (REDUCED) { t = G.gct + G.fl / 2; drawRunner(); }
  kick();
}

/* ========================================================= FOOTPRINTS */

const DIST = [['5K', 5], ['10K', 10], ['half', 21.0975], ['marathon', 42.195]];

function initFootprints(fig, app) {
  const P = { km: 5, min: 25, cad: 165 };
  const ok = { min: true, cad: true };
  const svg = s('svg', { role: 'img', 'aria-label': 'Five seconds of footprints at your cadence and at 180 spm, both reaching your goal pace' });
  const say = h('p', { class: 'v-r101-say', 'aria-live': 'polite' });
  const dists = h('div', { class: 'v-r101-chips', role: 'group', 'aria-label': 'Distance' });
  const dBtns = DIST.map(([lab, km]) => {
    const b = h('button', { type: 'button', class: 'v-r101-chip', onclick: () => { P.km = km; draw(); } }, lab);
    dists.append(b); return [b, km];
  });
  const fTime = field('goal time', '25:00', '', (v) => { const t = parseTime(v); ok.min = t > 0 && Number.isFinite(t); if (ok.min) P.min = t; draw(); }, { width: 7 });
  const fCad = field('your cadence', P.cad, 'spm', (v) => { const n = parseFloat(v); ok.cad = n >= 100 && n <= 230; if (ok.cad) P.cad = n; draw(); }, { mode: 'numeric', width: 4 });
  const mine = chips([['35:00', '35:00'], ['30:00', '30:00'], ['25:00', '25:00'], ['20:00', '20:00']], (v) => { P.km = 5; fTime.set(v); });

  app.append(
    h('div', { class: 'v-r101-fields' }, h('div', { class: 'v-r101-field' }, h('span', { class: 'lab' }, 'distance'), dists), fTime.el, fCad.el),
    h('div', { class: 'v-r101-row' }, h('span', { class: 'v-r101-plabel' }, 'my 5K goals:'), mine),
    svg, say);

  function draw() {
    fTime.el.classList.toggle('is-bad', !ok.min); fCad.el.classList.toggle('is-bad', !ok.cad);
    dBtns.forEach(([b, km]) => b.setAttribute('aria-pressed', String(km === P.km)));
    const pace = P.min / P.km; const v = 1000 / pace; // m/min
    const secs = 5; const reach = (v / 60) * secs;
    const rows = [[`you, ${Math.round(P.cad)} spm`, P.cad], ['180 spm', 180]];
    const W = Math.max(300, app.clientWidth);
    const m = { l: 14, r: 20 }; const rowH = 58; const H = 30 + rows.length * rowH + 26;
    const span = Math.max(reach * 1.06, 10);
    const X = (d) => m.l + (d / span) * (W - m.l - m.r);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = '';
    // metre scale
    const stepM = span > 40 ? 10 : 5;
    for (let d = 0; d <= span; d += stepM) {
      o += `<line x1="${X(d)}" x2="${X(d)}" y1="${H - 22}" y2="${H - 16}" class="v-r101-hair2"/><text x="${X(d)}" y="${H - 4}" text-anchor="middle" class="v-r101-t xs soft">${d} m</text>`;
    }
    o += `<line x1="${X(0)}" x2="${X(span)}" y1="${H - 22}" y2="${H - 22}" class="v-r101-hair2"/>`;
    // goal flag: where goal pace puts you after 5 s
    o += `<line x1="${X(reach)}" x2="${X(reach)}" y1="16" y2="${H - 22}" class="v-r101-flag"/>`;
    o += `<path d="M${X(reach)},16 l12,5 l-12,5 Z" class="v-r101-flagcloth"/>`;
    o += `<text x="${X(reach) - 6}" y="12" text-anchor="end" class="v-r101-t xs b">${reach.toFixed(1)} m in ${secs} s</text>`;
    rows.forEach(([lab, cad], r) => {
      const L = v / cad; const y0 = 30 + r * rowH + 26;
      const n = Math.floor((secs * cad) / 60 + 1e-9);
      o += `<text x="${m.l}" y="${y0 - 16}" class="v-r101-t s"><tspan class="b">${lab}</tspan> · ${L.toFixed(2)} m per step</text>`;
      for (let i = 1; i <= n; i++) {
        const fx = X(i * L); const up = i % 2 ? -7 : 7;
        o += `<ellipse cx="${fx - 5}" cy="${y0 + up}" rx="6" ry="3.2" class="v-r101-print"/><circle cx="${fx + 3.5}" cy="${y0 + up}" r="2.4" class="v-r101-print"/>`;
      }
      o += `<text x="${m.l}" y="${y0 + 22}" class="v-r101-t xs soft">${n} steps</text>`;
    });
    svg.innerHTML = o;
    const L1 = v / P.cad; const L2 = v / 180;
    say.innerHTML = `${P.km === 5 ? '5K' : DIST.find((d) => d[1] === P.km)[0]} in ${mmss(P.min)} is <b>${mmss(pace)}/km</b>, ${Math.round(v)} m per minute. ` +
      `At ${Math.round(P.cad)} spm that needs <b>${L1.toFixed(2)} m</b> per step; at 180 spm, <b>${L2.toFixed(2)} m</b>.`;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* ============================================================= HR ZONES */

/* Percent of max heart rate and effort, from the post. */
const ZONES = [
  { z: 1, hi: 0.65, eff: 'breathing easily, full sentences' },
  { z: 2, hi: 0.80, eff: 'easy to steady, complete sentences' },
  { z: 3, hi: 0.85, eff: 'moderate, winded if you talk' },
  { z: 4, hi: 0.92, eff: 'threshold, clipped sentences, about an hour' },
  { z: 5, hi: 1.00, eff: 'hard intervals to all-out sprints' },
];
function zoneTable(max) {
  let lo = Math.ceil(0.5 * max);
  return ZONES.map((z) => { const hi = Math.floor(z.hi * max); const r = { ...z, lo, hiB: hi }; lo = hi + 1; return r; });
}

function initHrZones(fig, app) {
  const P = { max: 180, run: 140 };
  const ok = { max: true, run: true };
  const zones = h('div', { class: 'v-r101-zones' });
  const say = h('p', { class: 'v-r101-say', 'aria-live': 'polite' });
  const fMax = field('max heart rate', P.max, 'bpm', (v) => { const n = parseFloat(v); ok.max = n >= 120 && n <= 230; if (ok.max) P.max = Math.round(n); draw(); }, { mode: 'numeric', width: 4 });
  const fAge = field('or your age', '', 'years', (v) => { const n = parseFloat(v); if (n >= 10 && n <= 90) fMax.set(220 - Math.round(n)); }, { mode: 'numeric', width: 3, hint: 'uses 220 − age' });
  const fRun = field('a run\'s average', P.run, 'bpm', (v) => { const n = parseFloat(v); ok.run = n >= 40 && n <= 240; if (ok.run) P.run = Math.round(n); draw(); }, { mode: 'numeric', width: 4 });
  app.append(h('div', { class: 'v-r101-fields' }, fMax.el, fAge.el, fRun.el), zones, say);

  function draw() {
    fMax.el.classList.toggle('is-bad', !ok.max); fRun.el.classList.toggle('is-bad', !ok.run);
    const zt = zoneTable(P.max);
    const zi = zt.findIndex((z) => P.run >= z.lo && P.run <= z.hiB);
    zones.innerHTML = '';
    const lo = zt[0].lo; const span = P.max - lo;
    const track = h('div', { class: 'track' });
    zt.forEach((z, k) => track.append(h('span', { class: `seg z${z.z}${k === zi ? ' is-you' : ''}`, style: `flex:${z.hiB - z.lo + 1}` }, h('b', null, `Z${z.z}`))));
    if (P.run >= lo && P.run <= P.max) track.append(h('span', { class: 'you', style: `left:${((P.run - lo + 0.5) / (span + 1)) * 100}%` }));
    zones.append(track);
    const list = h('ol', { class: 'rows' });
    zt.forEach((z, k) => list.append(h('li', { class: k === zi ? 'is-you' : '' },
      h('span', { class: `sw z${z.z}` }), h('span', { class: 'zn' }, `Zone ${z.z}`),
      h('span', { class: 'bpm' }, `${z.lo}–${z.hiB} bpm`), h('span', { class: 'eff' }, z.eff))));
    zones.append(list);
    if (zi >= 0) say.innerHTML = `A run at <b>${P.run} bpm</b> is <b>zone ${zt[zi].z}</b> for a max of ${P.max}: ${zt[zi].eff}.`;
    else if (P.run < lo) say.innerHTML = `A run at <b>${P.run} bpm</b> is below zone 1 (under 50% of ${P.max}).`;
    else say.innerHTML = `<b>${P.run} bpm</b> is above the max you entered. Your real max is probably higher than ${P.max}.`;
  }
  draw();
}

register({ progress: initProgress, 'form-check': initFormCheck, footprints: initFootprints, 'hr-zones': initHrZones });

/*
 * running-101 — figures for "Running 101". Typographic, on the page colour,
 * no whiteboard frame. The reader types their own numbers.
 *
 *   progress    hero: my pace, goal by goal (numbers from the post)
 *   form-check  guess where my 120 spm start sits, then type your own
 *               numbers; a runner moves with them, one metric highlighted
 *               at a time, and each lands in Garmin's percentile band
 *   footprints  your 5K today vs your goal as five seconds of footprints;
 *               pick more steps, longer steps, or both, and see the cost
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

/* Advice from the post, one line per metric. */
const SUGGEST = {
  cad: 'Run to a playlist with a beat a little above your cadence (see Music below), and raise it slowly.',
  gct: 'Build leg strength with calisthenics, and try landing closer to the forefoot.',
  vo: 'Push forward, not up. Keep the same pace with less bounce.',
  vr: 'Less bounce at the same step length lowers it.',
};
const ORDER = ['cad', 'gct', 'vo', 'vr'];
const ord = (n) => { const v = Math.round(n); const t = v % 100; return `${v}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`; };

/** A bare inline number field: input + unit. */
function inline(value, unit, label, onchange, { mode = 'decimal', width = 4 } = {}) {
  const input = h('input', { type: 'text', inputmode: mode, value, size: width, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
  input.addEventListener('input', () => onchange(input.value));
  const el = h('span', { class: 'v-r101-in' }, input, unit ? h('span', { class: 'unit' }, unit) : null);
  return { el, input, set(v) { input.value = v; onchange(String(v)); } };
}

/*
 * One runner, one metric at a time. The page opens on my own start
 * (120 spm) and asks the reader to guess where it sits before showing it.
 * Rows never move; picking a row changes what the runner highlights.
 */
function initFormCheck(fig, app) {
  const P = { cad: 120, gct: 260, vo: 9.0, pace: 9.5 };
  const ok = { cad: true, gct: true, vo: true, pace: true };
  let active = 'cad'; let gate = true; let quiz = null;

  /* ---- prompt ---- */
  const ask = h('p', { class: 'v-r101-ask', 'aria-live': 'polite' });
  const skip = h('button', { type: 'button', class: 'v-r101-link', onclick: () => reveal(null) }, 'skip, show me');
  const askBox = h('div', { class: 'v-r101-askbox' }, ask, skip);

  /* ---- runner stage ---- */
  const runner = s('svg', { role: 'img', 'aria-label': 'A runner moving with the numbers in the rows below' });
  const play = h('button', { type: 'button', class: 'v-r101-chip sm' }, REDUCED ? 'play' : 'pause');
  const slow = h('button', { type: 'button', class: 'v-r101-chip sm', 'aria-pressed': 'false' }, 'slow ×¼');
  const capText = h('span');
  const quizEl = h('span', { class: 'v-r101-quiz' });
  const cap = h('p', { class: 'v-r101-cap', 'aria-live': 'polite' }, capText, quizEl);
  const stage = h('div', { class: 'v-r101-stage' }, h('div', { class: 'v-r101-stagectl' }, play, slow), runner, cap);

  /* ---- rows ---- */
  const R = {};
  const num = (k, lo, hi) => (v) => { const n = parseFloat(v); ok[k] = Number.isFinite(n) && n >= lo && n <= hi; if (ok[k]) P[k] = n; update(); };
  const inputs = {
    cad: inline(P.cad, 'spm', 'cadence', num('cad', 100, 230), { mode: 'numeric' }),
    gct: inline(P.gct, 'ms', 'ground contact time', num('gct', 120, 450), { mode: 'numeric' }),
    vo: inline(P.vo.toFixed(1), 'cm', 'vertical oscillation', num('vo', 3, 18)),
    pace: inline(mmss(P.pace), '/km', 'pace', (v) => { const t = parseTime(v); ok.pace = t >= 2.5 && t <= 15; if (ok.pace) P.pace = t; update(); }, { width: 5 }),
  };
  const rows = h('div', { class: 'v-r101-rows' });
  for (const k of ORDER) {
    const nm = h('button', { type: 'button', class: 'nm', onclick: () => pick(k) }, METRIC[k].name);
    const first = h('span', { class: 'first' }, 'start here');
    const val = k === 'vr'
      ? h('span', { class: 'v-r101-vr' }, h('b', { class: 'vrv' }), h('span', { class: 'at' }, 'at pace'), inputs.pace.el)
      : inputs[k].el;
    const guessEl = h('span', { class: 'guess', hidden: true }, h('span', { class: 'gl' }, 'your guess'));
    const you = h('span', { class: 'you' });
    const track = h('div', { class: 'track' },
      ...BAND.map((b) => h('span', { class: `seg ${b.key}`, style: `flex:${b.p[1] - b.p[0]}` })), guessEl, you);
    const tag = h('span', { class: 'tag' });
    const row = h('div', { class: 'v-r101-mrow', 'data-k': k },
      h('div', { class: 'hd' }, nm, h('span', { class: 'sp' }), val),
      track, h('div', { class: 'tagline' }, tag, first));
    if (k === 'cad') track.append(h('span', { class: 'end l' }, 'bottom 5%'), h('span', { class: 'end r' }, 'top 5%'));
    R.ends = k === 'cad' ? track.querySelectorAll('.end') : R.ends;
    row.addEventListener('focusin', () => { if (!gate) pick(k); });
    R[k] = { row, track, you, tag, guessEl, first, vrv: row.querySelector('.vrv') };
    rows.append(row);
  }
  R.cad.track.addEventListener('click', (e) => {
    if (!gate) return;
    const b = R.cad.track.getBoundingClientRect();
    reveal(clamp(((e.clientX - b.left) / b.width) * 100, 0, 100));
  });

  app.append(askBox, stage, rows);

  function pick(k) { if (gate) return; active = k; update(); }

  function reveal(g) {
    gate = false;
    skip.hidden = true;
    if (g != null) { R.cad.guessEl.hidden = false; R.cad.guessEl.style.left = `${g}%`; }
    R.ends.forEach((e) => { e.hidden = true; });
    R.cad.row.querySelector('.tagline').style.marginTop = '0';
    const said = g != null ? `You guessed about the ${ord(g)} percentile. ` : '';
    ask.innerHTML = `${said}120 spm is in the <b>bottom 5%</b>: more than 95% of runners Garmin measured take more steps a minute. Cadence was the first metric I worked on. <b>Now type your own numbers into the rows.</b>`;
    update();
  }

  /* ---- body model (same as the post's formula) ---- */
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
    const max = 2 * SEG * 0.999;
    if (D > max) { dx *= max / D; dy *= max / D; D = max; fx = hx + dx; fy = hy + dy; }
    const hh = Math.sqrt(Math.max(0, SEG * SEG - (D / 2) ** 2));
    let nx = -dy / D; let ny = dx / D;
    if (nx < 0) { nx = -nx; ny = -ny; }
    return [[hx + dx / 2 + nx * hh, hy + dy / 2 + ny * hh], [fx, fy]];
  }

  let t = 0; let last = 0; let raf = 0; let running = !REDUCED; let visible = true; let rate = 1;
  function drawRunner() {
    const W = Math.max(280, stage.clientWidth || 300);
    const S = W < 480 ? 88 : 104; const Hh = 1.95 * S + 26; const gy = 1.95 * S - 8; const cx = W / 2;
    runner.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const X = (mx) => cx + mx * S; const Y = (mz) => gy - mz * S;
    const mode = gate ? 'cad' : active;
    const hz = H0 + hipZ(t); const hip = [0, hz];
    const lean = 0.12; const sh = [0.55 * Math.sin(lean), hz + 0.55 * Math.cos(lean)];
    const u = ((t % G.T) + G.T) % G.T; const inAir = u >= G.gct && G.fl > 0.001;
    let o = '';
    const off = (G.v * t) % 0.5;
    o += `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="v-r101-ground"/>`;
    for (let gx = -W / S; gx < W / S; gx += 0.5) { const px = X(gx - off); if (px > 0 && px < W) o += `<line x1="${px}" x2="${px - 6}" y1="${gy}" y2="${gy + 8}" class="v-r101-hair2"/>`; }
    const limb = (uu, back) => {
      const [fx, fz, on] = foot(uu);
      const [k, f] = knee(hip[0], hip[1], fx, fz);
      const hot = mode === 'gct' && on;
      return { on, fx: f[0], svg: `<path d="M${X(hip[0])},${Y(hip[1])} L${X(k[0])},${Y(k[1])} L${X(f[0])},${Y(f[1])} l${S * 0.13},0" class="v-r101-limb${back && !hot ? ' back' : ''}${hot ? ' hot' : ''}"/>` };
    };
    const arm = (ph, back) => {
      const a = 0.6 * Math.sin(ph); const e = [sh[0] + 0.28 * Math.sin(a), sh[1] - 0.28 * Math.cos(a)];
      const hnd = [e[0] + 0.24 * Math.cos(a * 0.6 + 0.2), e[1] + 0.24 * Math.sin(0.5 + a * 0.4)];
      return `<path d="M${X(sh[0])},${Y(sh[1])} L${X(e[0])},${Y(e[1])} L${X(hnd[0])},${Y(hnd[1])}" class="v-r101-limb arm${back ? ' back' : ''}"/>`;
    };
    const ph = (Math.PI * t) / G.T;
    const lb = limb(t + G.T, true); const lf = limb(t, false);
    o += lb.svg + arm(ph, true);
    o += `<line x1="${X(hip[0])}" y1="${Y(hip[1])}" x2="${X(sh[0])}" y2="${Y(sh[1])}" class="v-r101-limb torso"/>`;
    o += `<circle cx="${X(sh[0] + 0.03)}" cy="${Y(sh[1] + 0.17)}" r="${0.11 * S}" class="v-r101-head"/>`;
    o += lf.svg + arm(ph + Math.PI, false);
    const stanceX = lf.on ? lf.fx : lb.on ? lb.fx : null;
    // one highlight per view, labelled where it happens
    if (mode === 'cad') {
      if (u < Math.min(0.14, G.T * 0.4) && stanceX != null) {
        const r = 6 + (u / 0.14) * 16;
        o += `<circle cx="${X(stanceX)}" cy="${gy}" r="${r}" class="v-r101-ring"/>`;
      }
      o += `<text x="${X(-1.25)}" y="${gy + 22}" class="v-r101-t s b">a foot lands every ${Math.round(G.T * 1000)} ms</text>`;
    } else if (mode === 'gct') {
      if (inAir) o += `<text x="${X(0.35)}" y="${Y(0.35)}" class="v-r101-t s b">in the air</text>`;
      else if (stanceX != null) o += `<text x="${X(stanceX) + 16}" y="${gy - 6}" class="v-r101-t s b halo">on the ground</text>`;
    } else if (mode === 'vo') {
      const top = Y(H0 + G.rise); const bot = Y(H0 - G.dip);
      o += `<line x1="${X(-0.7)}" x2="${X(0.6)}" y1="${top}" y2="${top}" class="v-r101-guide"/><line x1="${X(-0.7)}" x2="${X(0.6)}" y1="${bot}" y2="${bot}" class="v-r101-guide"/>`;
      o += `<text x="${X(0.64)}" y="${(top + bot) / 2 + 4}" class="v-r101-t s b">${P.vo.toFixed(1)} cm up and down</text>`;
    } else if (mode === 'vr') {
      const y = gy + 16; const x0 = X(-G.L / 2); const x1 = X(G.L / 2);
      o += `<path d="M${x0},${y - 5} V${y + 5} M${x0},${y} H${x1} M${x1},${y - 5} V${y + 5}" class="v-r101-brk"/>`;
      o += `<text x="${x1 + 6}" y="${y + 4}" class="v-r101-t s b">step ${Math.round(G.L * 100)} cm</text>`;
      const bx = X(-0.55); const b0 = Y(H0 - G.dip); const b1 = Y(H0 + G.rise);
      o += `<path d="M${bx - 5},${b0} H${bx + 5} M${bx},${b0} V${b1} M${bx - 5},${b1} H${bx + 5}" class="v-r101-brk"/>`;
      o += `<text x="${bx - 8}" y="${(b0 + b1) / 2 + 4}" text-anchor="end" class="v-r101-t s b">bounce ${P.vo.toFixed(1)} cm</text>`;
    }
    if (rate < 1) o += `<text x="${W - 4}" y="${gy + 22}" text-anchor="end" class="v-r101-t xs soft">slow motion ×¼</text>`;
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

  /* ---- readouts ---- */
  function renderQuiz() {
    if (active !== 'vr' || gate) { quizEl.innerHTML = ''; return; }
    quizEl.innerHTML = '';
    const q = h('span', { class: 'q' }, ' Keep the bounce and take a longer step. Vertical ratio goes ');
    const ans = (a) => h('button', { type: 'button', class: 'v-r101-chip sm', 'aria-pressed': String(quiz === a), onclick: () => { quiz = a; renderQuiz(); } }, a);
    quizEl.append(q, ans('up'), ' ', ans('down'));
    if (quiz) quizEl.append(h('span', { class: 'fb' }, quiz === 'down' ? ' Yes. The same bounce is divided by a longer step.' : ' It goes down. The same bounce is divided by a longer step.'));
  }

  function update() {
    inputs.cad.input.readOnly = gate;
    for (const k of ['cad', 'gct', 'vo', 'pace']) inputs[k].el.classList.toggle('is-bad', !ok[k]);
    model();
    const vr = (P.vo / (G.L * 100)) * 100;
    const vals = { cad: P.cad, gct: P.gct, vo: P.vo, vr };
    const worst = ORDER.reduce((a, k) => (bandOf(k, vals[k]) < bandOf(a, vals[a]) ? k : a), 'cad');
    const needWork = bandOf(worst, vals[worst]) < 3;
    for (const k of ORDER) {
      const r = R[k]; const b = bandOf(k, vals[k]); const pos = posOf(k, vals[k]);
      const hidden = gate && k === 'cad';
      r.row.classList.toggle('is-locked', gate && k !== 'cad');
      r.row.classList.toggle('is-guessing', hidden);
      r.row.classList.toggle('is-active', !gate && k === active);
      r.you.hidden = hidden;
      r.you.style.left = `${pos}%`;
      r.tag.textContent = hidden ? 'tap the bar to guess' : BAND[b].name;
      r.tag.className = `tag ${hidden ? '' : `${BAND[b].key}-t`}`;
      const at = hidden ? 50 : pos;
      r.tag.style.left = at < 14 ? '0' : at > 86 ? 'auto' : `${at}%`;
      r.tag.style.right = at > 86 ? '0' : 'auto';
      r.tag.style.transform = at < 14 || at > 86 ? 'none' : 'translateX(-50%)';
      r.first.hidden = gate || !needWork || k !== worst;
      if (r.vrv) r.vrv.textContent = `${vr.toFixed(1)}%`;
      if (k === 'cad' && !r.guessEl.hidden) r.guessEl.classList.toggle('near', Math.abs(parseFloat(r.guessEl.style.left) - pos) < 24);
    }
    if (gate) {
      ask.innerHTML = 'I started at <b>120 steps a minute</b>. The runner below is moving at that cadence. Where do you think 120 spm sits among runners? <b>Tap the cadence bar.</b>';
      capText.innerHTML = '';
    } else {
      const k = active; const b = bandOf(k, vals[k]);
      let txt = '';
      if (k === 'cad') txt = `<b>${Math.round(P.cad)} steps a minute</b>, ${BAND[b].name} of runners.`;
      if (k === 'gct') txt = G.fl > 0.001 ? `Each foot stays down <b>${Math.round(G.gct * 1000)} ms</b> of a ${Math.round(G.T * 1000)} ms step, then ${Math.round(G.fl * 1000)} ms in the air.` : `A step lasts ${Math.round(G.T * 1000)} ms, less than ${Math.round(P.gct)} ms of contact, so a foot is always down.`;
      if (k === 'vo') txt = `The hip rises and falls <b>${P.vo.toFixed(1)} cm</b> every step.`;
      if (k === 'vr') txt = `<b>${P.vo.toFixed(1)} cm</b> of bounce for a <b>${Math.round(G.L * 100)} cm</b> step is ${vr.toFixed(1)}%, both drawn to scale. The step comes from your pace and cadence.`;
      if (needWork && k === worst) txt += ` ${SUGGEST[k]}`;
      capText.innerHTML = txt;
    }
    renderQuiz();
    drawRunner();
  }

  new ResizeObserver(() => drawRunner()).observe(stage);
  model();
  if (REDUCED) t = G.gct / 3;
  update();
  kick();
}

/* ========================================================= FOOTPRINTS */

/*
 * Today versus the goal, five seconds of footprints each. The reader picks
 * how to close the gap, then sees what it asks of the body.
 */
function initFootprints(fig, app) {
  const P = { now: 25, cad: 165, goal: 20 };
  const ok = { now: true, cad: true, goal: true };
  let how = null;
  const svg = s('svg', { role: 'img', 'aria-label': 'Five seconds of footprints today and at your goal pace' });
  const say = h('p', { class: 'v-r101-say', 'aria-live': 'polite' });
  const tm = (k) => (v) => { const x = parseTime(v); ok[k] = x > 5 && x < 120; if (ok[k]) P[k] = x; draw(); };
  const fNow = field('your 5K today', '25:00', '', tm('now'), { width: 6 });
  const fCad = field('your cadence', P.cad, 'spm', (v) => { const n = parseFloat(v); ok.cad = n >= 100 && n <= 230; if (ok.cad) P.cad = n; draw(); }, { mode: 'numeric', width: 4 });
  const fGoal = field('goal 5K', '20:00', '', tm('goal'), { width: 6 });
  const hows = [['more steps', 'steps'], ['longer steps', 'longer'], ['a bit of both', 'both']];
  const howEl = h('div', { class: 'v-r101-chips', role: 'group', 'aria-label': 'How to close the gap' });
  const howBtns = hows.map(([lab, k]) => { const b = h('button', { type: 'button', class: 'v-r101-chip', 'aria-pressed': 'false', onclick: () => { how = k; draw(); } }, lab); howEl.append(b); return [b, k]; });
  const mine = h('button', { type: 'button', class: 'v-r101-link', onclick: () => { fNow.set('24:45'); fGoal.set('20:00'); } }, 'use mine: 24:45 today, 20:00 next');

  app.append(
    h('div', { class: 'v-r101-fields' }, fNow.el, fCad.el, fGoal.el),
    h('p', { class: 'v-r101-row' }, mine),
    svg,
    h('div', { class: 'v-r101-row' }, h('span', { class: 'v-r101-plabel' }, 'How would you close the gap?'), howEl),
    say);

  function draw() {
    for (const [f, k] of [[fNow, 'now'], [fCad, 'cad'], [fGoal, 'goal']]) f.el.classList.toggle('is-bad', !ok[k]);
    howBtns.forEach(([b, k]) => b.setAttribute('aria-pressed', String(k === how)));
    const v0 = 5000 / P.now; const v1 = 5000 / P.goal; // m/min
    const L0 = v0 / P.cad; const r = v1 / v0;
    const faster = r > 1.0001;
    let c1 = P.cad; let L1 = L0;
    if (how === 'steps') c1 = P.cad * r;
    if (how === 'longer') L1 = L0 * r;
    if (how === 'both') { c1 = P.cad * Math.sqrt(r); L1 = L0 * Math.sqrt(r); }
    const secs = 5; const reach0 = (v0 / 60) * secs; const reach1 = (v1 / 60) * secs;
    const W = Math.max(300, app.clientWidth);
    const m = { l: 14, r: 20 }; const rowH = 64; const H = 24 + 2 * rowH + 30;
    const span = Math.max(reach0, reach1) * 1.07;
    const X = (d) => m.l + (d / span) * (W - m.l - m.r);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = '';
    const stepM = span > 40 ? 10 : 5;
    for (let d = 0; d <= span; d += stepM) o += `<line x1="${X(d)}" x2="${X(d)}" y1="${H - 22}" y2="${H - 16}" class="v-r101-hair2"/><text x="${X(d)}" y="${H - 4}" text-anchor="middle" class="v-r101-t xs soft">${d} m</text>`;
    o += `<line x1="${X(0)}" x2="${X(span)}" y1="${H - 22}" y2="${H - 22}" class="v-r101-hair2"/>`;
    const prints = (L, cad, y0, dim) => {
      let s2 = ''; const n = Math.floor((secs * cad) / 60 + 1e-9);
      for (let i = 1; i <= n; i++) { const fx = X(i * L); const up = i % 2 ? -7 : 7; s2 += `<ellipse cx="${fx - 5}" cy="${y0 + up}" rx="6" ry="3.2" class="v-r101-print${dim ? ' dim' : ''}"/><circle cx="${fx + 3.5}" cy="${y0 + up}" r="2.4" class="v-r101-print${dim ? ' dim' : ''}"/>`; }
      return s2;
    };
    const cb = (c) => BAND[bandOf('cad', c)].key;
    // today
    const y0 = 24 + 26;
    o += `<text x="${m.l}" y="${y0 - 16}" class="v-r101-t s"><tspan class="b">today</tspan> · ${Math.round(P.cad)} spm × ${L0.toFixed(2)} m</text>`;
    o += prints(L0, P.cad, y0, false);
    o += `<line x1="${X(reach0)}" x2="${X(reach0)}" y1="${y0 - 12}" y2="${y0 + 12}" class="v-r101-flag"/>`;
    // goal
    const y1 = y0 + rowH;
    o += `<line x1="${X(reach1)}" x2="${X(reach1)}" y1="${y0 - 12}" y2="${H - 22}" class="v-r101-flag"/><path d="M${X(reach1)},${y0 - 12} l12,5 l-12,5 Z" class="v-r101-flagcloth"/>`;
    if (faster) {
      o += `<path d="M${X(reach0)},${y0} H${X(reach1)}" class="v-r101-gap"/>`;
      o += `<text x="${X(reach1) - 6}" y="${y0 + 24}" text-anchor="end" class="v-r101-t xs b halo">${(reach1 - reach0).toFixed(1)} m short</text>`;
    }
    if (!how || !faster) {
      o += `<text x="${m.l}" y="${y1 - 16}" class="v-r101-t s"><tspan class="b">goal</tspan> · ${faster ? 'pick a way below' : 'not faster than today'}</text>`;
    } else {
      const cTxt = how === 'longer' ? `${Math.round(c1)} spm` : `<tspan class="hl ${cb(c1)}-t">${Math.round(c1)} spm</tspan>`;
      const lTxt = how === 'steps' ? `${L1.toFixed(2)} m` : `<tspan class="hl">${L1.toFixed(2)} m</tspan>`;
      o += `<text x="${m.l}" y="${y1 - 16}" class="v-r101-t s"><tspan class="b">goal</tspan> · ${cTxt} × ${lTxt}</text>`;
      o += prints(L1, c1, y1, false);
    }
    svg.innerHTML = o;
    if (!faster) { say.innerHTML = 'Set a goal time below your time today.'; return; }
    const pct = Math.round((r - 1) * 100);
    let txt = `A ${mmss(P.goal)} 5K needs <b>${pct}% more ground each minute</b> than ${mmss(P.now)}. `;
    if (how === 'steps') txt += `With the same ${L0.toFixed(2)} m step, cadence goes to <b class="${cb(c1)}-t">${Math.round(c1)} spm</b>, ${BAND[bandOf('cad', c1)].name} of runners.`;
    if (how === 'longer') txt += `At the same ${Math.round(P.cad)} spm, each step must grow from ${L0.toFixed(2)} m to <b>${L1.toFixed(2)} m</b>.`;
    if (how === 'both') txt += `Split evenly: <b class="${cb(c1)}-t">${Math.round(c1)} spm</b> (${BAND[bandOf('cad', c1)].name}) and <b>${L1.toFixed(2)} m</b> steps.`;
    if (!how) txt += 'Pick a way to close the gap.';
    say.innerHTML = txt;
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

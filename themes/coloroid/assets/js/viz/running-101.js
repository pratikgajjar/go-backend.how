/*
 * running-101 — figures for "Running 101", in the house style.
 *
 *   form-check  guess where my 120 spm start sits, then type your own
 *               numbers; a runner moves with them and highlights one
 *               metric at a time; each metric lands in Garmin's band
 *   footprints  your 5K today vs your goal as five seconds of footprints;
 *               pick more steps, longer steps, or both
 *   hr-zones    your max heart rate gives the post's five zones; type a
 *               run's average to see its zone
 *   progress    my pace, goal by goal (numbers from the post)
 *
 * Colour follows the site grammar. Garmin's five percentile bands are
 * redrawn as red (bottom 5%), light red (5–29), neutral (30–69), light
 * green (70–95), green (top 5%). Heart-rate zones are brown data, darker
 * for harder. Purple marks the reader's value, blue the controls.
 */

import { h, s, register, clamp, REDUCED, onVisible, btn, chips, ask, colorKey } from './lib.js';

/* ---------------------------------------------------------------- shared */

const BAND = [
  { key: 'b0', name: 'bottom 5%', p: [0, 5], c: 'c-bad' },
  { key: 'b1', name: '5th–29th percentile', p: [5, 30], c: 'c-bad' },
  { key: 'b2', name: '30th–69th percentile', p: [30, 70], c: '' },
  { key: 'b3', name: '70th–95th percentile', p: [70, 95], c: 'c-safe' },
  { key: 'b4', name: 'top 5%', p: [95, 100], c: 'c-safe' },
];
const BAND_KEY = colorKey([['v-r101-b0', 'bottom 5%'], ['v-r101-b1', '5th–29th'], ['v-r101-b2', '30th–69th'], ['v-r101-b3', '70th–95th'], ['v-r101-b4', 'top 5%']]);

/* Band edges from the tables in the post (Garmin manuals). */
const METRIC = {
  cad: { name: 'Cadence', short: 'cadence', unit: 'spm', up: true, edges: [150.5, 162.5, 173.5, 185.5] },
  gct: { name: 'Ground contact time', short: 'contact', unit: 'ms', up: false, edges: [208, 240.5, 272.5, 305.5] },
  vo: { name: 'Vertical oscillation', short: 'bounce', unit: 'cm', up: false, edges: [6.4, 8.15, 9.75, 11.55] },
  vr: { name: 'Vertical ratio', short: 'ratio', unit: '%', up: false, edges: [6.1, 7.45, 8.65, 10.15] },
};
const ORDER = ['cad', 'gct', 'vo', 'vr'];

function bandOf(m, v) {
  const M = METRIC[m];
  if (M.up) return M.edges.filter((e) => v > e).length;
  return 4 - M.edges.filter((e) => v >= e).length;
}
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
function parseTime(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[0] + p[1] / 60;
  if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
  return NaN;
}

let FID = 0;
/** Shared .wv-field: label, input, unit. */
function field(label, value, unit, onchange, { type = 'text', mode = 'decimal', min, max, step, size = 7 } = {}) {
  const id = `v-r101-f${++FID}`;
  const input = h('input', { id, type, inputmode: mode, value, min, max, step, size, spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('input', () => onchange(input.value));
  const el = h('div', { class: 'wv-field' }, h('label', { for: id }, label), input, unit ? h('span', null, unit) : null);
  return { el, input, set(v) { input.value = v; onchange(String(v)); } };
}
/** Five band segments with a purple marker. */
function bandBar() {
  const you = h('span', { class: 'v-r101-you' });
  const el = h('div', { class: 'v-r101-bar' }, ...BAND.map((b) => h('span', { class: `v-r101-${b.key}`, style: `flex:${b.p[1] - b.p[0]}` })), you);
  return { el, you };
}

/* ========================================================= FORM CHECK */

const SUGGEST = {
  cad: 'Run to a playlist with a beat a little above your cadence (see the music section), and raise it slowly.',
  gct: 'Build leg strength with calisthenics, and try landing closer to the forefoot.',
  vo: 'Push forward, not up. Keep the same pace with less bounce.',
  vr: 'Less bounce at the same step length lowers it.',
};

function initFormCheck(fig, app) {
  const P = { cad: 120, gct: 260, vo: 9.0, pace: 9.5 };
  const ok = { cad: true, gct: true, vo: true, pace: true };
  let active = 'cad'; let gate = true;

  /* predict, then see */
  const guess = ask(
    'I started at 120 steps a minute. Where does that sit among runners Garmin measured?',
    BAND.map((b) => [b.key, b.name]),
    'b0',
    (v, right) => {
      gate = false; update();
      return `${right ? 'Yes. ' : ''}120 spm is in the <b>bottom 5%</b>: more than 95% of runners take more steps a minute. Cadence was the first metric I worked on. Now type your own numbers into the rows below.`;
    },
  );

  /* runner */
  const runner = s('svg', { role: 'img', 'aria-label': 'A runner moving with the numbers in the rows below' });
  const pick = chips(ORDER.map((k) => [k, METRIC[k].name]), (k) => { active = k; update(); }, { value: 'cad', label: 'Metric to show on the runner' });
  const play = btn(REDUCED ? '▶ Play' : '❚❚ Pause', () => { running = !running; play.textContent = running ? '❚❚ Pause' : '▶ Play'; if (running) kick(); });
  const slow = btn('slow ×¼', () => { rate = rate === 1 ? 0.25 : 1; slow.setAttribute('aria-pressed', String(rate < 1)); if (!running) drawRunner(); }, { 'aria-pressed': 'false' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const quiz = ask('Keep the bounce and take a longer step. Vertical ratio goes…', [['up', 'up'], ['down', 'down']], 'down',
    () => 'Down. The same bounce is divided by a longer step.');

  /* rows */
  const num = (k, lo, hi) => (v) => { const n = parseFloat(v); ok[k] = Number.isFinite(n) && n >= lo && n <= hi; if (ok[k]) P[k] = n; if (k === 'cad' && gate) gate = false; update(); };
  const inputs = {
    cad: field('Cadence', P.cad, 'spm', num('cad', 100, 230), { type: 'number', mode: 'numeric', min: 100, max: 230 }),
    gct: field('Ground contact time', P.gct, 'ms', num('gct', 120, 450), { type: 'number', mode: 'numeric', min: 120, max: 450 }),
    vo: field('Vertical oscillation', P.vo.toFixed(1), 'cm', num('vo', 3, 18), { type: 'number', min: 3, max: 18, step: 0.1 }),
    pace: field('at pace', mmss(P.pace), '/km', (v) => { const t = parseTime(v); ok.pace = t >= 2.5 && t <= 15; if (ok.pace) P.pace = t; update(); }),
  };
  const R = {};
  const rows = h('div', { class: 'v-r101-rows' });
  for (const k of ORDER) {
    const bar = bandBar();
    const tag = h('span');
    const first = h('span', { class: 'wv-tag c-look' }, 'start here');
    const vrv = k === 'vr' ? h('b', { class: 'c-data' }) : null;
    const head = h('div', { class: 'v-r101-rhd' },
      k === 'vr' ? h('span', { class: 'v-r101-vr' }, h('b', null, 'Vertical ratio'), vrv, inputs.pace.el) : inputs[k].el,
      h('span', { class: 'wv-sp' }), first);
    const card = h('div', { class: 'wv-card v-r101-row' }, head, bar.el, h('div', { class: 'v-r101-tagline' }, tag));
    card.addEventListener('click', () => { if (gate || active === k) return; active = k; pick.set(k); update(); });
    R[k] = { card, bar, tag, first, vrv };
    rows.append(card);
  }

  app.append(guess.el,
    h('div', { class: 'wv-bar' }, pick.el, h('span', { class: 'wv-sp' }), play, slow),
    runner, note, quiz.el, rows,
    colorKey([['k-look', 'your value, the metric on the runner'], ['k-opt', 'controls'], ['k-data', 'computed']]),
    BAND_KEY.cloneNode(true),
    h('p', { class: 'wv-key' }, 'Bands are Garmin\'s percentiles, redrawn: red = bottom, green = top.'));

  /* body model */
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
  const INK = 'stroke:var(--ink);fill:none;stroke-linecap:round;stroke-linejoin:round';
  function drawRunner() {
    const W = Math.max(280, app.clientWidth || 300);
    const S = W < 480 ? 84 : 100; const gy = 1.9 * S; const Hh = gy + 28; const cx = W / 2;
    runner.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const X = (mx) => cx + mx * S; const Y = (mz) => gy - mz * S;
    const mode = gate ? 'cad' : active;
    const hz = H0 + hipZ(t); const hip = [0, hz];
    const lean = 0.12; const sh = [0.55 * Math.sin(lean), hz + 0.55 * Math.cos(lean)];
    const u = ((t % G.T) + G.T) % G.T; const inAir = u >= G.gct && G.fl > 0.001;
    let o = `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" class="rule-ink"/>`;
    const off = (G.v * t) % 0.5;
    for (let gx = -W / S; gx < W / S; gx += 0.5) { const px = X(gx - off); if (px > 0 && px < W) o += `<line x1="${px}" x2="${px - 6}" y1="${gy}" y2="${gy + 7}" class="rule-ink"/>`; }
    const limb = (uu, back) => {
      const [fx, fz, on] = foot(uu);
      const [k, f] = knee(hip[0], hip[1], fx, fz);
      const hot = mode === 'gct' && on;
      const st = hot ? 'stroke:var(--purple);stroke-width:9;fill:none;stroke-linecap:round;stroke-linejoin:round' : `${back ? 'stroke:var(--line)' : 'stroke:var(--ink)'};stroke-width:6.5;fill:none;stroke-linecap:round;stroke-linejoin:round`;
      return { on, fx: f[0], svg: `<path d="M${X(hip[0])},${Y(hip[1])} L${X(k[0])},${Y(k[1])} L${X(f[0])},${Y(f[1])} l${S * 0.13},0" style="${st}"/>` };
    };
    const arm = (ph, back) => {
      const a = 0.6 * Math.sin(ph); const e = [sh[0] + 0.28 * Math.sin(a), sh[1] - 0.28 * Math.cos(a)];
      const hnd = [e[0] + 0.24 * Math.cos(a * 0.6 + 0.2), e[1] + 0.24 * Math.sin(0.5 + a * 0.4)];
      return `<path d="M${X(sh[0])},${Y(sh[1])} L${X(e[0])},${Y(e[1])} L${X(hnd[0])},${Y(hnd[1])}" style="${back ? 'stroke:var(--line);fill:none;stroke-linecap:round;stroke-linejoin:round' : INK};stroke-width:5"/>`;
    };
    const ph = (Math.PI * t) / G.T;
    const lb = limb(t + G.T, true); const lf = limb(t, false);
    o += lb.svg + arm(ph, true);
    o += `<line x1="${X(hip[0])}" y1="${Y(hip[1])}" x2="${X(sh[0])}" y2="${Y(sh[1])}" style="${INK};stroke-width:8.5"/>`;
    o += `<circle cx="${X(sh[0] + 0.03)}" cy="${Y(sh[1] + 0.17)}" r="${0.11 * S}" style="fill:var(--ink)"/>`;
    o += lf.svg + arm(ph + Math.PI, false);
    const stanceX = lf.on ? lf.fx : lb.on ? lb.fx : null;
    const P_ = 'stroke:var(--purple);stroke-width:2;fill:none';
    if (mode === 'cad') {
      if (u < Math.min(0.14, G.T * 0.4) && stanceX != null) o += `<circle cx="${X(stanceX)}" cy="${gy}" r="${6 + (u / 0.14) * 16}" style="${P_};stroke-width:2.5"/>`;
      o += `<text x="${X(-1.3)}" y="${gy + 22}" class="t-s t-b t-look">a foot lands every ${Math.round(G.T * 1000)} ms</text>`;
    } else if (mode === 'gct') {
      if (inAir) o += `<text x="${X(0.35)}" y="${Y(0.35)}" class="t-s t-b t-look halo">in the air</text>`;
      else if (stanceX != null) o += `<text x="${X(stanceX) + 16}" y="${gy - 6}" class="t-s t-b t-look halo">on the ground</text>`;
    } else if (mode === 'vo') {
      const top = Y(H0 + G.rise); const bot = Y(H0 - G.dip);
      o += `<line x1="${X(-0.7)}" x2="${X(0.6)}" y1="${top}" y2="${top}" style="${P_};stroke-width:1.2;stroke-dasharray:3 3"/><line x1="${X(-0.7)}" x2="${X(0.6)}" y1="${bot}" y2="${bot}" style="${P_};stroke-width:1.2;stroke-dasharray:3 3"/>`;
      o += `<text x="${X(-0.74)}" y="${(top + bot) / 2 + 4}" text-anchor="end" class="t-s t-b t-look">${P.vo.toFixed(1)} cm</text>`;
    } else if (mode === 'vr') {
      const y = gy + 16; const x0 = X(-G.L / 2); const x1 = X(G.L / 2);
      o += `<path d="M${x0},${y - 5} V${y + 5} M${x0},${y} H${x1} M${x1},${y - 5} V${y + 5}" style="${P_}"/>`;
      o += `<text x="${x1 + 6}" y="${y + 4}" class="t-s t-b t-look">step ${Math.round(G.L * 100)} cm</text>`;
      const bx = X(-0.55); const b0 = Y(H0 - G.dip); const b1 = Y(H0 + G.rise);
      o += `<path d="M${bx - 5},${b0} H${bx + 5} M${bx},${b0} V${b1} M${bx - 5},${b1} H${bx + 5}" style="${P_}"/>`;
      o += `<text x="${bx - 8}" y="${(b0 + b1) / 2 + 4}" text-anchor="end" class="t-s t-b t-look">bounce ${P.vo.toFixed(1)} cm</text>`;
    }
    if (rate < 1) o += `<text x="${W - 4}" y="${gy + 22}" text-anchor="end" class="t-xs t-mute">slow motion ×¼</text>`;
    runner.innerHTML = o;
  }
  function loop(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
    t += dt * rate; drawRunner();
    raf = running && visible ? requestAnimationFrame(loop) : 0;
  }
  function kick() { if (!raf && running && visible) { last = 0; raf = requestAnimationFrame(loop); } }
  onVisible(fig, (v) => { visible = v; if (v) kick(); });

  function update() {
    for (const k of ['cad', 'gct', 'vo', 'pace']) inputs[k].input.setAttribute('aria-invalid', String(!ok[k]));
    model();
    const vr = (P.vo / (G.L * 100)) * 100;
    const vals = { cad: P.cad, gct: P.gct, vo: P.vo, vr };
    const worst = ORDER.reduce((a, k) => (bandOf(k, vals[k]) < bandOf(a, vals[a]) ? k : a), 'cad');
    const needWork = bandOf(worst, vals[worst]) < 3;
    for (const k of ORDER) {
      const r = R[k]; const b = bandOf(k, vals[k]);
      const hide = gate && k === 'cad';
      r.bar.you.hidden = hide;
      r.bar.you.style.left = `${posOf(k, vals[k])}%`;
      r.tag.className = hide ? 't-mute' : BAND[b].c;
      r.tag.innerHTML = hide ? 'answer the question above first' : `<b>${BAND[b].name}</b>`;
      r.card.classList.toggle('is-look', !gate && k === active);
      r.first.style.display = gate || !needWork || k !== worst ? 'none' : '';
      if (r.vrv) r.vrv.textContent = `${vr.toFixed(1)}%`;
    }
    const k = gate ? 'cad' : active; const b = bandOf(k, vals[k]);
    let txt = '';
    if (gate) txt = 'The runner is moving at 120 steps a minute.';
    else if (k === 'cad') txt = `<b>${Math.round(P.cad)} steps a minute</b>, ${BAND[b].name} of runners.`;
    else if (k === 'gct') txt = G.fl > 0.001 ? `Each foot stays down <b>${Math.round(G.gct * 1000)} ms</b> of a ${Math.round(G.T * 1000)} ms step, then ${Math.round(G.fl * 1000)} ms in the air.` : `A step lasts ${Math.round(G.T * 1000)} ms, less than ${Math.round(P.gct)} ms of contact, so a foot is always down.`;
    else if (k === 'vo') txt = `The hip rises and falls <b>${P.vo.toFixed(1)} cm</b> every step.`;
    else txt = `<b>${P.vo.toFixed(1)} cm</b> of bounce for a <b>${Math.round(G.L * 100)} cm</b> step is ${vr.toFixed(1)}%, both drawn to scale. The step comes from your pace and cadence.`;
    if (!gate && needWork && k === worst) txt += ` ${SUGGEST[k]}`;
    note.innerHTML = txt;
    quiz.el.hidden = gate || active !== 'vr';
    drawRunner();
  }

  new ResizeObserver(() => drawRunner()).observe(app);
  model();
  if (REDUCED) t = G.gct / 3;
  update();
  kick();
}

/* ========================================================= FOOTPRINTS */

function initFootprints(fig, app) {
  const P = { now: 25, cad: 165, goal: 20 };
  const ok = { now: true, cad: true, goal: true };
  let how = null;
  const svg = s('svg', { role: 'img', 'aria-label': 'Five seconds of footprints today and at your goal pace' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const tm = (k) => (v) => { const x = parseTime(v); ok[k] = x > 5 && x < 120; if (ok[k]) P[k] = x; draw(); };
  const fNow = field('5K today', '25:00', '', tm('now'), { size: 6 });
  const fCad = field('cadence', P.cad, 'spm', (v) => { const n = parseFloat(v); ok.cad = n >= 100 && n <= 230; if (ok.cad) P.cad = n; draw(); }, { type: 'number', mode: 'numeric', min: 100, max: 230 });
  const fGoal = field('goal 5K', '20:00', '', tm('goal'), { size: 6 });
  const mine = btn('use mine: 24:45 → 20:00', () => { fNow.set('24:45'); fGoal.set('20:00'); });
  const pick = chips([['steps', 'more steps'], ['longer', 'longer steps'], ['both', 'a bit of both']], (v) => { how = v; draw(); }, { label: 'How to close the gap' });

  app.append(
    h('div', { class: 'v-r101-fields' }, fNow.el, fCad.el, fGoal.el, mine),
    svg,
    h('p', { class: 'wv-q' }, 'How would you close the gap?'),
    pick.el, note,
    colorKey([['k-data', 'today'], ['k-gap', 'the gap'], ['k-look', 'what changes at the goal'], ['k-opt', 'your choice']]));

  function draw() {
    for (const [f, k] of [[fNow, 'now'], [fCad, 'cad'], [fGoal, 'goal']]) f.input.setAttribute('aria-invalid', String(!ok[k]));
    const v0 = 5000 / P.now; const v1 = 5000 / P.goal;
    const L0 = v0 / P.cad; const r = v1 / v0; const faster = r > 1.0001;
    let c1 = P.cad; let L1 = L0;
    if (how === 'steps') c1 = P.cad * r;
    if (how === 'longer') L1 = L0 * r;
    if (how === 'both') { c1 = P.cad * Math.sqrt(r); L1 = L0 * Math.sqrt(r); }
    const secs = 5; const reach0 = (v0 / 60) * secs; const reach1 = (v1 / 60) * secs;
    const W = Math.max(300, app.clientWidth);
    const m = { l: 6, r: 18 }; const rowH = 64; const H = 24 + 2 * rowH + 30;
    const span = Math.max(reach0, reach1) * 1.07;
    const X = (d) => m.l + (d / span) * (W - m.l - m.r);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = '';
    const stepM = span > 40 ? 10 : 5;
    for (let d = 0; d <= span; d += stepM) o += `<line x1="${X(d)}" x2="${X(d)}" y1="${H - 22}" y2="${H - 16}" class="rule-ink"/><text x="${X(d)}" y="${H - 4}" text-anchor="middle" class="t-xs t-mute">${d} m</text>`;
    o += `<line x1="${X(0)}" x2="${X(span)}" y1="${H - 22}" y2="${H - 22}" class="rule-ink"/>`;
    const prints = (L, cad, y0, col) => {
      let t = ''; const n = Math.floor((secs * cad) / 60 + 1e-9);
      for (let i = 1; i <= n; i++) { const fx = X(i * L); const up = i % 2 ? -7 : 7; t += `<ellipse cx="${fx - 5}" cy="${y0 + up}" rx="6" ry="3.2" style="fill:${col}"/><circle cx="${fx + 3.5}" cy="${y0 + up}" r="2.4" style="fill:${col}"/>`; }
      return t;
    };
    const y0 = 50; const y1 = y0 + rowH;
    o += `<text x="${m.l}" y="${y0 - 16}" class="t-s"><tspan class="t-b">today</tspan> · <tspan class="t-data t-b">${Math.round(P.cad)} spm × ${L0.toFixed(2)} m</tspan></text>`;
    o += prints(L0, P.cad, y0, 'var(--brown)');
    o += `<line x1="${X(reach0)}" x2="${X(reach0)}" y1="${y0 - 12}" y2="${y0 + 12}" class="rule-ink dash"/>`;
    o += `<line x1="${X(reach1)}" x2="${X(reach1)}" y1="${y0 - 12}" y2="${H - 22}" style="stroke:var(--ink);stroke-width:1.5;stroke-dasharray:4 3"/><path d="M${X(reach1)},${y0 - 12} l12,5 l-12,5 Z" style="fill:var(--ink)"/>`;
    if (faster) {
      o += `<path d="M${X(reach0)},${y0} H${X(reach1)}" style="stroke:var(--red);stroke-width:2.5;stroke-dasharray:3 3"/>`;
      o += `<text x="${X(reach1) - 6}" y="${y0 + 24}" text-anchor="end" class="t-xs t-b t-bad halo">${(reach1 - reach0).toFixed(1)} m short</text>`;
    }
    if (!how || !faster) {
      o += `<text x="${m.l}" y="${y1 - 16}" class="t-s"><tspan class="t-b">goal</tspan> · <tspan class="t-mute">${faster ? 'pick a way below' : 'not faster than today'}</tspan></text>`;
    } else {
      const cT = how === 'longer' ? `<tspan class="t-data t-b">${Math.round(c1)} spm</tspan>` : `<tspan class="t-look t-b">${Math.round(c1)} spm</tspan>`;
      const lT = how === 'steps' ? `<tspan class="t-data t-b">${L1.toFixed(2)} m</tspan>` : `<tspan class="t-look t-b">${L1.toFixed(2)} m</tspan>`;
      o += `<text x="${m.l}" y="${y1 - 16}" class="t-s"><tspan class="t-b">goal</tspan> · ${cT} × ${lT}</text>`;
      o += prints(L1, c1, y1, 'var(--purple)');
    }
    svg.innerHTML = o;
    if (!faster) { note.className = 'wv-note'; note.innerHTML = 'Set a goal time below your time today.'; return; }
    const pct = Math.round((r - 1) * 100);
    let txt = `A ${mmss(P.goal)} 5K needs <b>${pct}% more ground each minute</b> than ${mmss(P.now)}. `;
    const band = BAND[bandOf('cad', c1)];
    if (how === 'steps') txt += `With the same ${L0.toFixed(2)} m step, cadence goes to <b>${Math.round(c1)} spm</b>, <span class="${band.c}">${band.name}</span> of runners.`;
    if (how === 'longer') txt += `At the same ${Math.round(P.cad)} spm, each step must grow from ${L0.toFixed(2)} m to <b>${L1.toFixed(2)} m</b>.`;
    if (how === 'both') txt += `Split evenly: <b>${Math.round(c1)} spm</b> (<span class="${band.c}">${band.name}</span>) and <b>${L1.toFixed(2)} m</b> steps.`;
    if (!how) txt += 'Pick a way to close the gap.';
    note.className = 'wv-note';
    note.innerHTML = txt;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* ============================================================= HR ZONES */

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
  const bar = h('div', { class: 'v-r101-zbar' });
  const table = h('div', { class: 'wv-scroll' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const fMax = field('max heart rate', P.max, 'bpm', (v) => { const n = parseFloat(v); ok.max = n >= 120 && n <= 230; if (ok.max) P.max = Math.round(n); draw(); }, { type: 'number', mode: 'numeric', min: 120, max: 230 });
  const fAge = field('or age', '', '', (v) => { const n = parseFloat(v); if (n >= 10 && n <= 90) fMax.set(220 - Math.round(n)); }, { type: 'number', mode: 'numeric', min: 10, max: 90 });
  const fRun = field('a run\'s average', P.run, 'bpm', (v) => { const n = parseFloat(v); ok.run = n >= 40 && n <= 240; if (ok.run) P.run = Math.round(n); draw(); }, { type: 'number', mode: 'numeric', min: 40, max: 240 });
  app.append(h('div', { class: 'v-r101-fields' }, fMax.el, fAge.el, fRun.el), bar, note, table,
    colorKey([['v-r101-z1', 'zone 1'], ['v-r101-z3', 'zone 3'], ['v-r101-z5', 'zone 5'], ['k-look', 'your run'], ['k-opt', 'your numbers']]),
    h('p', { class: 'wv-key' }, 'Zones are heart-rate data, so they are brown: the stronger the brown, the harder the zone. The age field uses 220 − age.'));

  function draw() {
    fMax.input.setAttribute('aria-invalid', String(!ok.max)); fRun.input.setAttribute('aria-invalid', String(!ok.run));
    const zt = zoneTable(P.max);
    const zi = zt.findIndex((z) => P.run >= z.lo && P.run <= z.hiB);
    const lo = zt[0].lo; const span = P.max - lo;
    bar.innerHTML = '';
    zt.forEach((z) => bar.append(h('span', { class: `v-r101-z${z.z}`, style: `flex:${z.hiB - z.lo + 1}` }, h('b', { class: z.z >= 3 ? 't-board' : '' }, `Z${z.z}`))));
    if (P.run >= lo && P.run <= P.max) bar.append(h('span', { class: 'v-r101-you', style: `left:${((P.run - lo + 0.5) / (span + 1)) * 100}%` }));
    table.innerHTML = `<table class="wv-table"><thead><tr><th>zone</th><th>bpm</th><th>effort</th></tr></thead><tbody>${
      zt.map((z, k) => `<tr class="${k === zi ? 'is-look' : ''}"><td><b>${z.z}</b></td><td class="c-data">${z.lo}–${z.hiB}</td><td>${z.eff}</td></tr>`).join('')}</tbody></table>`;
    if (zi >= 0) note.innerHTML = `A run at <b>${P.run} bpm</b> is <b class="c-look">zone ${zt[zi].z}</b> for a max of ${P.max}: ${zt[zi].eff}.`;
    else if (P.run < lo) note.innerHTML = `A run at <b>${P.run} bpm</b> is below zone 1 (under 50% of ${P.max}).`;
    else note.innerHTML = `<b>${P.run} bpm</b> is above the max you entered. Your real max is probably higher than ${P.max}.`;
  }
  draw();
}

/* =============================================================== PROGRESS */

/* From the post: the 4K before training, "What changed", and the goals. */
const MILES = [
  { d: '4K', when: 'before training', t: '38:00', pace: 9.5, kind: 'done' },
  { d: '5K', when: 'Oct 2024', t: '~35:00', pace: 7, kind: 'done' },
  { d: '5K', when: 'Nov 15, 2024', t: '< 30:00', pace: 6, kind: 'done' },
  { d: '5K', when: 'Dec 4, 2024', t: '24:45', pace: 4.95, kind: 'done' },
  { d: '10K', when: 'Feb 6, 2025', t: '< 60:00', pace: 6, kind: 'ten' },
  { d: '5K', when: 'by 2026', t: '< 20:00', pace: 4, kind: 'next' },
];

function initProgress(fig, app) {
  const svg = s('svg', { role: 'img', 'aria-label': 'My running pace by goal: 9:30 per km before training, then 7:00, under 6:00, 4:57 for a 5K, a 10K under 60 minutes, and a sub-20 5K still ahead' });
  app.append(h('p', { class: 'wv-q' }, '9:30 → 4:57 min/km in four goals, October 2024 to February 2025'), svg,
    colorKey([['k-safe', 'goal reached'], ['k-pick', 'next goal I picked'], ['k-data', 'time and pace']]));

  function draw() {
    const W = Math.max(300, app.clientWidth);
    const narrow = W < 560;
    const H = narrow ? 250 : 230;
    const m = { l: narrow ? 58 : 70, r: narrow ? 26 : 40, t: 40, b: 58 };
    const n = MILES.length;
    const x = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r);
    const y = (p) => m.t + ((p - 4) / (10 - 4)) * (H - m.t - m.b);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let o = '';
    for (const p of [4, 5, 6, 7, 8, 9, 10]) {
      o += `<line x1="38" x2="${W - 4}" y1="${y(p)}" y2="${y(p)}" class="rule" style="stroke-dasharray:1 4"/>`;
      o += `<text x="0" y="${y(p) + 3.5}" class="t-xs t-mute">${p}:00</text>`;
    }
    o += `<text x="0" y="${m.t - 24}" class="t-xs t-mute">min/km, faster ↑</text>`;
    const lad = MILES.map((mi, i) => [mi, i]).filter(([mi]) => mi.kind === 'done');
    let d = `M${x(lad[0][1])},${y(lad[0][0].pace)}`;
    for (let k = 1; k < lad.length; k++) d += ` H${x(lad[k][1])} V${y(lad[k][0].pace)}`;
    o += `<path d="${d}" style="fill:none;stroke:var(--green);stroke-width:2.5;stroke-linejoin:round"/>`;
    const last = lad[lad.length - 1];
    o += `<path d="M${x(last[1])},${y(last[0].pace)} H${x(n - 1)} V${y(4)}" style="fill:none;stroke:var(--orange);stroke-width:2;stroke-dasharray:5 5"/>`;
    MILES.forEach((mi, i) => {
      const cx = x(i); const cy = y(mi.pace);
      const col = mi.kind === 'next' ? 'var(--orange)' : 'var(--green)';
      if (mi.kind === 'ten') o += `<rect x="${cx - 6}" y="${cy - 6}" width="12" height="12" style="fill:${col};stroke:var(--board);stroke-width:2"/>`;
      else if (mi.kind === 'next') o += `<circle cx="${cx}" cy="${cy}" r="6.5" style="fill:var(--orange-l);stroke:${col};stroke-width:2;stroke-dasharray:3 2.5"/>`;
      else o += `<circle cx="${cx}" cy="${cy}" r="6" style="fill:${col};stroke:var(--board);stroke-width:2.5"/>`;
      const up = mi.kind !== 'ten';
      o += `<text x="${cx}" y="${up ? cy - 12 : cy + 20}" text-anchor="middle" class="${narrow ? 't-s' : 't-m'} t-b t-data halo">${mi.t}</text>`;
      o += `<text x="${cx}" y="${H - m.b + 26}" text-anchor="middle" class="t-s t-b">${mi.d}</text>`;
      const lines = narrow ? (mi.when.includes(', ') ? mi.when.split(', ') : mi.when.split(' ').length > 2 ? [mi.when.split(' ')[0], mi.when.split(' ').slice(1).join(' ')] : [mi.when]) : [mi.when];
      lines.forEach((ln, k) => { o += `<text x="${cx}" y="${H - m.b + 40 + k * 12}" text-anchor="middle" class="t-xs t-mute">${ln}</text>`; });
    });
    svg.innerHTML = o;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

register({ progress: initProgress, 'form-check': initFormCheck, footprints: initFootprints, 'hr-zones': initHrZones });

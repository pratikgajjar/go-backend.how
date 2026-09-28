/*
 * Figures for "1B Payments/Day - TigerBeetle & PostgreSQL".
 *
 * Visual language: a ledger sheet. Squares are transfers (brown, data).
 * Green stamps are durable writes. Purple marks the entry you are looking
 * at. Blue is anything you can change. Red is waiting or cost.
 *
 *   one-batch     hero: one full request of 8,190 transfers, made durable
 *                 by TigerBeetle (one prepare) and by Postgres (one flush
 *                 per ~2.4 rows, measured), on a shared clock.
 *   batch-path    a ledger journal of one batch through a TigerBeetle
 *                 replica, with the data file and the LSM trees it writes.
 *   group-commit  Postgres WAL flushes on a strip chart: one flush at a
 *                 time, each covering every commit record inserted before
 *                 it started. A model fitted to the two measured runs.
 *
 * TigerBeetle facts are from the 0.16.78 source (src/config.zig,
 * constants.zig, vsr/journal.zig, vsr/superblock.zig, state_machine.zig,
 * lsm/groove.zig). Measured numbers are from the post.
 */
import { h, s, codeBlock, register, mulberry, clamp, fmt, esc, uid, REDUCED } from './lib.js';

/* ---------------------------------------------------------------- shared */

function key(items) {
  return h('div', { class: 'v-1b-key' }, ...items.map(([k, label]) => h('span', null, h('i', { class: `v-1b-sw-${k}` }), label)));
}

/** Blue segmented toggle. options: [[value, label]] */
function toggle(label, options, value, onchange) {
  const btns = options.map(([v, text]) => h('button', {
    type: 'button', class: 'v-1b-tg', 'aria-pressed': String(v === value),
    onclick: () => { set(v); onchange(v); },
  }, text));
  function set(v) { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v))); }
  const el = h('div', { class: 'v-1b-toggle', role: 'group', 'aria-label': label }, h('span', { class: 'v-1b-ctl-l' }, label), ...btns);
  return { el, set };
}

/** Blue labelled slider. */
function slider(label, { min, max, step = 1, value, show = String, oninput }) {
  const out = h('output');
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const sync = () => { out.textContent = show(+input.value); };
  input.addEventListener('input', () => { sync(); oninput(+input.value); });
  sync();
  return { el: h('label', { class: 'v-1b-slider' }, h('span', { class: 'v-1b-ctl-l' }, label), input, out), input, set(v) { input.value = v; sync(); } };
}

const tokens = (el) => {
  const cs = getComputedStyle(el);
  const g = (n) => cs.getPropertyValue(n).trim();
  return { paper: g('--paper'), ink: g('--ink'), mute: g('--mute'), line: g('--line'), brown: g('--brown'), brownL: g('--brown-l'), green: g('--green'), greenL: g('--green-l'), purple: g('--purple'), red: g('--red'), redL: g('--red-l') };
};

/* ============================================================== HERO */

const BATCH = 8190;
const COLS = 91; const ROWS = 90;            // 91 × 90 = 8,190
const TB_RATE = 48000;                       // transfers/s, measured sustained
const PG_RUNS = {
  ins: { label: 'INSERTs · 8 backends', rate: 13053, perRow: 4177054 / 1e7, what: 'single-row INSERTs, 8 backends' },
  xfer: { label: 'transfers · 10 backends', rate: 3356, perRow: 1517374 / 2e6, what: 'transfers, 10 backends' },
};

/* flush after row i when the running count of flushes steps up: exactly
 * floor(8,190 × perRow) flushes, spread evenly */
function flushEnds(perRow) {
  const ends = [];
  for (let i = 0; i < BATCH; i++) if (Math.floor((i + 1) * perRow) > Math.floor(i * perRow)) ends.push(i);
  if (ends[ends.length - 1] !== BATCH - 1) ends.push(BATCH - 1);
  return ends;
}

function initOneBatch(fig, app) {
  /* Predict, then see. The reader guesses how many durable writes Postgres
     needs for one full request; the grid then shows the answer, measured. */
  let run = 'ins'; let guess = null; let revealAt = null; let raf = 0;
  const GUESSES = [[8190, '8,190', 'one per commit'], [3400, 'about 3,400', ''], [100, 'about 100', ''], [1, '1', 'like TigerBeetle']];

  const sheet = (name) => {
    const cv = h('canvas', { class: 'v-1b-cv', role: 'img' });
    const tag = h('div', { class: 'v-1b-tag' });
    const sub = h('div', { class: 'v-1b-dim' });
    return { el: h('div', { class: 'v-1b-sheet' }, h('div', { class: 'v-1b-sheet-h' }, name, tag), h('div', { class: 'v-1b-cvwrap' }, cv), sub), cv, tag, sub };
  };
  const tb = sheet('TigerBeetle');
  const pg = sheet('PostgreSQL');
  const choices = GUESSES.map(([v, label, hint]) => h('button', { type: 'button', class: 'v-1b-tg', onclick: () => pick(v) }, label, hint ? h('span', { class: 'v-1b-hintx' }, ` · ${hint}`) : null));
  const ask = h('div', { class: 'v-1b-ask' },
    h('p', { class: 'v-1b-q' }, 'How many times must Postgres flush its WAL to make these 8,190 transfers durable?'),
    h('div', { class: 'v-1b-choices', role: 'group', 'aria-label': 'Your guess' }, ...choices));
  const answer = h('p', { class: 'v-1b-answer', 'aria-live': 'polite' });
  const tg = toggle('Postgres run', Object.entries(PG_RUNS).map(([k, v]) => [k, v.label]), run, (v) => { run = v; revealAt = 1; say(); draw(); });
  tg.el.hidden = true;

  app.append(
    h('p', { class: 'v-1b-lede' }, 'One full request: ', h('b', { class: 'c-data' }, '8,190 transfers'), ' × 128 B = 1 MiB. At a billion payments a day (11,574/s), that is 0.71 s of traffic. Each square is one transfer.'),
    ask,
    h('div', { class: 'v-1b-sheets' }, tb.el, pg.el),
    answer,
    tg.el,
  );

  function grid(p, marks, frame) {
    const T = tokens(fig);
    const dpr = window.devicePixelRatio || 1;
    const w = p.cv.parentElement.clientWidth;
    const cell = clamp(Math.floor((w / COLS) * 4) / 4, 2.4, 4.5);
    const gap = cell >= 4 ? 0.8 : 0.5;
    const W = cell * COLS; const H = cell * ROWS;
    p.cv.width = Math.round(W * dpr); p.cv.height = Math.round(H * dpr);
    p.cv.style.width = `${W}px`; p.cv.style.height = `${H}px`;
    const c = p.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = T.brown;
    for (let i = 0; i < BATCH; i++) c.fillRect((i % COLS) * cell, Math.floor(i / COLS) * cell, cell - gap, cell - gap);
    if (marks) {
      c.fillStyle = T.green;
      const mw = Math.max(1.2, cell * 0.34);
      for (const i of marks) c.fillRect((i % COLS) * cell + cell - gap - mw, Math.floor(i / COLS) * cell - gap / 2, mw, cell);
    }
    if (frame) {
      c.strokeStyle = T.green; c.lineWidth = 3; c.strokeRect(1.5, 1.5, W - 3, H - 3);
      c.lineWidth = 1; c.strokeRect(5.5, 5.5, W - 11, H - 11);
    }
  }

  function draw() {
    const R = PG_RUNS[run];
    const ends = flushEnds(R.perRow);
    const shown = revealAt == null ? 0 : Math.min(ends.length, Math.floor(revealAt * ends.length));
    grid(tb, null, revealAt != null);
    grid(pg, ends.slice(0, shown), false);
    const ms = (v) => `${fmt(v * 1000)} ms`;
    if (revealAt == null) {
      tb.tag.textContent = ''; pg.tag.textContent = '?';
      tb.sub.textContent = ''; pg.sub.textContent = '';
    } else {
      tb.tag.innerHTML = '<span class="v-1b-stamp">1 prepare · 2 writes</span>';
      pg.tag.innerHTML = `<span class="v-1b-stamp">${fmt(shown)} flushes</span>`;
      tb.sub.textContent = `${ms(BATCH / TB_RATE)} per batch at ${fmt(TB_RATE)}/s, measured`;
      pg.sub.textContent = `${ms(BATCH / R.rate)} at ${fmt(R.rate)}/s, measured (${R.what})`;
    }
    tb.cv.setAttribute('aria-label', 'TigerBeetle: 8,190 transfers made durable by one prepare, written in 2 writes');
    pg.cv.setAttribute('aria-label', revealAt == null ? 'PostgreSQL: 8,190 transfers, flushes hidden until you guess' : `PostgreSQL ${R.what}: ${fmt(ends.length)} WAL flushes for 8,190 rows`);
  }

  function say() {
    const R = PG_RUNS[run]; const n = flushEnds(R.perRow).length;
    const lead = run === 'ins' ? `${guess === 3400 ? '<b class="c-safe">Right.</b> ' : ''}Postgres flushed <b class="c-safe">${fmt(n)}</b> times for 8,190 single-row inserts, measured. ${guess === 8190 ? 'Not one per commit: ' : ''}with 8 backends, about 2.4 commits share each flush (Figure 2 shows how).`
      : `For transfers with 10 backends it is <b class="c-safe">${fmt(n)}</b> flushes: each transaction runs longer, so only about 1.3 commits share a flush.`;
    answer.innerHTML = `${lead} TigerBeetle made the whole request durable with <b class="c-safe">one prepare</b> before it ran any of it.`;
  }

  function pick(v) {
    guess = v;
    choices.forEach((b, i) => b.setAttribute('aria-pressed', String(GUESSES[i][0] === v)));
    say();
    tg.el.hidden = false;
    cancelAnimationFrame(raf);
    if (REDUCED) { revealAt = 1; draw(); return; }
    const t0 = performance.now();
    const loop = (now) => { revealAt = Math.min(1, (now - t0) / 900); draw(); if (revealAt < 1) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
  }

  draw();
  let lastW = app.clientWidth;
  new ResizeObserver(() => { if (Math.abs(app.clientWidth - lastW) > 4) { lastW = app.clientWidth; draw(); } }).observe(app);
  new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-force-dark', 'class'] });
}

/* ============================================================ GROUP COMMIT */

/* Measured in the post. `work` (µs) is fitted so the model's throughput
 * matches the measured run; `flush` is the measured fdatasync mean. */
const PRESETS = [
  { id: 'ins', label: '10M INSERTs · 8 backends', W: 8, work: 370, flush: 163,
    measured: { rate: 13053, perFlush: 1e7 / 4177054, busy: 681 / 766 } },
  { id: 'xfer', label: '2M transfers · 10 backends', W: 10, work: 2650, flush: 253,
    measured: { rate: 3356, perFlush: 2e6 / 1517374, busy: 0.64 } },
];

function lognormal(rnd, mean, cv = 0.5) {
  const sg = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(mean) - (sg * sg) / 2;
  const u1 = Math.max(rnd(), 1e-12); const u2 = rnd();
  return Math.exp(mu + sg * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
}

/**
 * One WAL flush at a time. A flush starts when the disk is free and at least
 * one commit record is waiting, and covers every commit record inserted
 * before it started (XLogFlush flushes up to the current insert position).
 */
function simulate(W, work, flush, commits = 12000, seed = 7) {
  const rnd = mulberry(seed);
  const ready = []; const began = [];
  const lanes = Array.from({ length: W }, () => []);
  for (let b = 0; b < W; b++) { began[b] = 0; ready[b] = lognormal(rnd, work); }
  const flushes = [];
  let free = 0; let done = 0;
  while (done < commits) {
    let t = Infinity;
    for (let b = 0; b < W; b++) t = Math.min(t, ready[b]);
    const start = Math.max(free, t);
    const end = start + flush;
    const members = [];
    for (let b = 0; b < W; b++) {
      if (ready[b] <= start) {
        lanes[b].push({ ws: began[b], rec: ready[b], fe: end, f: flushes.length });
        members.push(b);
        began[b] = end;
        ready[b] = end + lognormal(rnd, work);
      }
    }
    flushes.push({ s: start, e: end, m: members });
    done += members.length;
    free = end;
  }
  const warm = Math.min(60, Math.floor(flushes.length / 4));
  const t0 = flushes[warm].s; const t1 = flushes[flushes.length - 1].e;
  let n = 0;
  for (let k = warm; k < flushes.length; k++) n += flushes[k].m.length;
  const nf = flushes.length - warm;
  return { lanes, flushes, warm, rate: n / ((t1 - t0) / 1e6), perFlush: n / nf, busy: (nf * flush) / (t1 - t0) };
}

function initGroupCommit(fig, app) {
  const P = { W: 8, work: 370, flush: 163 };
  let sim = null; let win = null; let sel = 0;
  const base = simulate(8, 370, 163);            // the measured INSERT run
  const stage = h('div', { class: 'v-1b-strip' });
  const note = h('p', { class: 'v-1b-memo', 'aria-live': 'polite' });
  const totals = h('div', { class: 'v-1b-totals', 'aria-live': 'off' });

  const workFromPos = (v) => Math.round(50 * 100 ** (v / 1000) / 10) * 10;
  const workToPos = (w) => Math.round((1000 * Math.log(w / 50)) / Math.log(100));
  const us = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${Math.round(v)} µs`);

  const sW = slider('backends', { min: 1, max: 16, value: P.W, oninput: (v) => { P.W = v; update(); } });
  const sWork = slider('work per txn', { min: 0, max: 1000, value: workToPos(P.work), show: (v) => us(workFromPos(v)), oninput: (v) => { P.work = workFromPos(v); update(); } });
  const sFlush = slider('fdatasync', { min: 50, max: 1000, value: P.flush, show: us, oninput: (v) => { P.flush = v; update(); } });
  const tg = toggle('Measured run', PRESETS.map((p) => [p.id, p.label]), 'ins', (id) => {
    const p = PRESETS.find((q) => q.id === id);
    P.W = p.W; P.work = p.work; P.flush = p.flush;
    sW.set(p.W); sWork.set(workToPos(p.work)); sFlush.set(p.flush);
    update();
  });
  const more = h('details', { class: 'v-1b-more' }, h('summary', null, 'More inputs'), h('div', { class: 'v-1b-sliders' }, sWork.el, sFlush.el), tg.el);

  /* predict first: what does doubling the backends do to a flush? */
  const OPTS = [['fewer', 'fewer commits'], ['same', 'the same'], ['more', 'more commits']];
  const predictBtns = OPTS.map(([v, label]) => h('button', { type: 'button', class: 'v-1b-tg', onclick: () => predict(v) }, label));
  const verdict = h('p', { class: 'v-1b-answer', 'aria-live': 'polite' });
  const ask = h('div', { class: 'v-1b-ask' },
    h('p', { class: 'v-1b-q' }, 'Below: 8 backends, each flush 163 µs. Double the backends to 16. Each flush then carries…'),
    h('div', { class: 'v-1b-choices', role: 'group', 'aria-label': 'Your prediction' }, ...predictBtns), verdict);

  const prevB = h('button', { type: 'button', class: 'v-1b-btn', 'aria-label': 'Previous flush', onclick: () => pick(sel - 1) }, '◀');
  const nextB = h('button', { type: 'button', class: 'v-1b-btn', 'aria-label': 'Next flush', onclick: () => pick(sel + 1) }, '▶');
  const pos = h('span', { class: 'v-1b-pos' });

  app.append(
    ask,
    h('div', { class: 'v-1b-sliders' }, sW.el),
    stage,
    h('div', { class: 'v-1b-scrub' }, prevB, pos, nextB),
    note,
    totals,
    more,
  );

  function predict(v) {
    predictBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(OPTS[i][0] === v)));
    P.W = 16; sW.set(16); update();
    const right = v === 'more';
    verdict.innerHTML = `${right ? '<b class="c-safe">Right.</b>' : '<b class="c-bad">Not quite.</b>'} More: <b>${sim.perFlush.toFixed(1)}</b> commits per flush instead of <b>${base.perFlush.toFixed(1)}</b>, and ${fmt(sim.rate)} commits/s instead of ${fmt(base.rate)} in this model. A flush still takes 163 µs and still runs one at a time, so more backends are waiting when it starts. The model ignores CPU limits, and the benchmark VM had 4 vCPUs, so a real run would gain less.`;
  }

  const preset = () => PRESETS.find((p) => p.W === P.W && p.flush === P.flush && p.work === P.work);
  const visible = () => sim.flushes.map((q, j) => j).filter((j) => j >= sim.warm && sim.flushes[j].e <= win.t1);

  function update() {
    sim = P.W === 8 && P.work === 370 && P.flush === 163 ? base : simulate(P.W, P.work, P.flush);
    const span = clamp((18 * P.flush) / Math.max(sim.busy, 0.2), 1500, 30000);
    const t0 = sim.flushes[sim.warm].s;
    win = { t0, t1: t0 + span };
    const v = visible();
    sel = v.reduce((a, k) => (sim.flushes[k].m.length > sim.flushes[a].m.length ? k : a), v[0]);
    const pr = preset();
    tg.set(pr ? pr.id : null);
    draw();
    const m = pr?.measured;
    const row = (k, val, meas) => `<tr><th>${k}</th><td>${val}</td><td>${meas}</td></tr>`;
    totals.innerHTML = `<table><thead><tr><th></th><th>model</th><th>measured</th></tr></thead><tbody>${[
      row('commits per flush', sim.perFlush.toFixed(2), m ? m.perFlush.toFixed(2) : '—'),
      row('commits per second', fmt(sim.rate), m ? fmt(m.rate) : '—'),
      row('WAL busy flushing', `${Math.round(sim.busy * 100)}%`, m ? `${Math.round(m.busy * 100)}%` : '—'),
    ].join('')}</tbody></table>`;
  }

  function pick(k) {
    const v = visible();
    sel = clamp(k, v[0], v[v.length - 1]);
    draw();
  }

  /* fixed chart height: the lanes share one band, so the layout does not
     jump when the number of backends changes */
  function draw() {
    const width = Math.max(300, app.clientWidth);
    const phone = width < 600;
    const L = phone ? 30 : 86; const R = 8;
    const band = phone ? 250 : 300;
    const W = P.W;
    const pitch = band / 16 * Math.min(16 / W, 1.6);
    const laneH = Math.max(6, pitch * 0.76); const gap = pitch - laneH;
    const top = 30 + (band - W * pitch) / 2;
    const flushY = 30 + band + 8;
    const flushH = phone ? 22 : 26;
    const H = flushY + flushH + 26;
    const x = (t) => L + ((t - win.t0) / (win.t1 - win.t0)) * (width - L - R);
    const id = uid('gc');
    const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, role: 'img', 'aria-label': `Strip chart of ${W} Postgres backends and the WAL flushes they wait on` });
    svg.innerHTML = `<defs><clipPath id="${id}"><rect x="${L}" y="0" width="${width - L - R}" height="${H}"/></clipPath>
      <pattern id="${id}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="v-1b-hatch-bg"/><line x1="0" y1="0" x2="0" y2="5" class="v-1b-hatch-ln"/></pattern></defs>`;
    const f = sim.flushes[sel];
    const span = win.t1 - win.t0;
    const stepUs = span <= 2500 ? 250 : span <= 6000 ? 500 : span <= 12000 ? 1000 : span <= 25000 ? 2000 : 5000;
    for (let t = 0; t <= span + 1; t += stepUs) {
      const xx = x(win.t0 + t);
      if (!phone || (t / stepUs) % 2 === 0) svg.append(s('text', { x: xx, y: H - 6, class: 'v-1b-t-xs v-1b-t-mute', 'text-anchor': 'middle' }, `${+(t / 1000).toFixed(2)} ms`));
    }
    const body = s('g', { 'clip-path': `url(#${id})` });
    const late = new Set();
    const showLabels = laneH >= 9;
    for (let b = 0; b < W; b++) {
      const y = top + b * pitch;
      if (showLabels || b % 2 === 0) svg.append(s('text', { x: L - 6, y: y + laneH / 2 + 3.5, class: 'v-1b-t-xs', 'text-anchor': 'end' }, phone || W > 8 ? `b${b + 1}` : `backend ${b + 1}`));
      for (const ev of sim.lanes[b]) {
        if (ev.fe < win.t0 || ev.ws > win.t1) continue;
        const mine = ev.f === sel;
        const missed = ev.f === sel + 1 && ev.rec > f.s && ev.rec < f.e;
        if (missed) late.add(b);
        body.append(s('rect', { x: x(ev.ws), y, width: Math.max(0, x(ev.rec) - x(ev.ws)), height: laneH, class: 'v-1b-work' }));
        body.append(s('rect', {
          x: x(ev.rec), y, width: Math.max(0.8, x(ev.fe) - x(ev.rec)), height: laneH,
          class: mine ? 'v-1b-wait is-sel' : missed ? 'v-1b-wait is-late' : 'v-1b-wait', fill: mine ? null : `url(#${id}h)`,
        }));
        body.append(s('line', { x1: x(ev.fe), x2: x(ev.fe), y1: y - 1, y2: y + laneH + 1, class: 'v-1b-tick' }));
      }
    }
    svg.append(s('text', { x: L - 6, y: flushY + flushH / 2 + 4, class: 'v-1b-t-xs v-1b-t-b', 'text-anchor': 'end' }, phone ? 'WAL' : 'WAL flush'));
    sim.flushes.forEach((fl, k) => {
      if (fl.e < win.t0 || fl.s > win.t1) return;
      const x0 = x(fl.s); const w = Math.max(1, x(fl.e) - x0);
      const g = s('g', { class: `v-1b-flush${k === sel ? ' is-sel' : ''}` });
      g.append(s('rect', { x: x0 + 0.5, y: flushY, width: Math.max(0.5, w - 1), height: flushH, rx: 2 }));
      if (w >= 11) g.append(s('text', { x: x0 + w / 2, y: flushY + flushH / 2 + 4, 'text-anchor': 'middle', class: 'v-1b-t-xs v-1b-t-b' }, String(fl.m.length)));
      g.addEventListener('click', () => pick(k));
      body.append(g);
    });
    body.append(s('rect', { x: x(f.s), y: 22, width: Math.max(1, x(f.e) - x(f.s)), height: flushY + flushH - 20, class: 'v-1b-band' }));
    svg.append(body);
    /* the label sits on the selected flush, not in a legend */
    const cx = (x(f.s) + x(f.e)) / 2;
    const anchor = cx > width - 120 ? 'end' : cx < L + 120 ? 'start' : 'middle';
    svg.append(s('text', { x: anchor === 'end' ? x(f.e) : anchor === 'start' ? x(f.s) : cx, y: 16, class: 'v-1b-t-s v-1b-t-b v-1b-t-look', 'text-anchor': anchor },
      `one fdatasync → ${f.m.length} commit${f.m.length > 1 ? 's' : ''} durable`));
    stage.replaceChildren(svg);

    const v = visible(); const idx = v.indexOf(sel);
    pos.textContent = `flush ${idx + 1} of ${v.length} · tap any flush`;
    prevB.disabled = idx <= 0; nextB.disabled = idx >= v.length - 1;
    const who = f.m.map((b) => `b${b + 1}`).join(', ');
    note.innerHTML = `Purple: the backends this flush makes durable (${who}). Hatched red: time spent waiting for a flush.${late.size
      ? ` <span class="c-bad">${[...late].map((b) => `b${b + 1}`).join(', ')} inserted ${late.size > 1 ? 'their commit records' : 'its commit record'} just after it started, so ${late.size > 1 ? 'they wait' : 'it waits'} for the next one.</span>` : ''}`;
  }

  update();
  let lastW = app.clientWidth;
  new ResizeObserver(() => { if (Math.abs(app.clientWidth - lastW) > 4) { lastW = app.clientWidth; draw(); } }).observe(app);
  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input, summary')) return;
    if (e.key === 'ArrowRight') { pick(sel + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pick(sel - 1); e.preventDefault(); }
  });
}

/* ============================================================== BATCH PATH */

const OP = 1221;                                    // sample op number
const SLOT = OP % 1024;                             // 197
const SECTOR = Math.floor(SLOT / 16);               // 12

/* One sample transfer as the Go benchmark builds it. */
const TRANSFER = [
  ['id', 16, 4000017n, 'sequential in the benchmark'],
  ['debit_account_id', 16, 1337420n, 'one of the top 20% of accounts'],
  ['credit_account_id', 16, 7654321n, 'any account'],
  ['amount', 16, 1000n, ''],
  ['pending_id', 16, 0n, 'zero: not a two-phase transfer'],
  ['user_data_128', 16, 0n, ''],
  ['user_data_64', 8, 0n, ''],
  ['user_data_32', 4, 0n, ''],
  ['timeout', 4, 0n, ''],
  ['ledger', 4, 20n, ''],
  ['code', 2, 1n, ''],
  ['flags', 2, 0n, ''],
  ['timestamp', 8, 0n, 'zero: the primary sets it'],
];

function leBytes(v, n) {
  const out = [];
  for (let i = 0; i < n; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

function byteGrid() {
  const cells = [];
  TRANSFER.forEach(([name, n, v], fi) => {
    leBytes(v, n).forEach((b) => {
      cells.push(`<span class="v-1b-b${v ? ' is-val' : ''} f${fi % 2}" data-f="${fi}" title="${esc(name)}">${b.toString(16).padStart(2, '0')}</span>`);
    });
  });
  const legend = TRANSFER.map(([name, n, v], fi) =>
    `<button type="button" class="v-1b-fld${v ? ' is-val' : ''}" data-f="${fi}"><b>${esc(name)}</b> <span>${n} B</span>${v ? ` <em>${v}</em>` : ''}</button>`).join('');
  return `<div class="v-1b-bytes"><div class="v-1b-hex" role="img" aria-label="The 128 bytes of one Transfer, 16 per row, little-endian">${cells.join('')}</div>
    <div class="v-1b-flds">${legend}</div></div>
    <p class="v-1b-hint">One <code>Transfer</code>, 16 bytes per row, little-endian. Tap a field. Values are samples.</p>`;
}

/* The 33 LSM trees and what one transfer writes into them.
 * write(opts) returns bytes for this tree, or 0. */
const OPT = { ud: false, pending: false, history: false };
const GROOVES = [
  ['Transfer', [
    ['object', () => 128, 'the transfer, keyed by timestamp'],
    ['id', () => 32], ['debit_account_id', () => 32], ['credit_account_id', () => 32], ['amount', () => 32],
    ['ledger', () => 16], ['code', () => 16],
    ['pending_id', () => 0, 'only for posting or voiding'],
    ['user_data_128', (o) => (o.ud ? 32 : 0), 'optional: zero is not indexed'],
    ['user_data_64', (o) => (o.ud ? 16 : 0), 'optional: zero is not indexed'],
    ['user_data_32', (o) => (o.ud ? 16 : 0), 'optional: zero is not indexed'],
    ['expires_at', (o) => (o.pending ? 16 : 0), 'only for pending transfers with a timeout'],
    ['imported', () => 0, 'only for imported transfers'],
    ['closing', () => 0, 'only for closing transfers'],
  ]],
  ['Account', [
    ['object', () => 256, 'two new account versions, 128 B each'],
    ['id', () => 0, 'unchanged by a transfer'], ['user_data_128', () => 0, 'unchanged'], ['user_data_64', () => 0, 'unchanged'],
    ['user_data_32', () => 0, 'unchanged'], ['ledger', () => 0, 'unchanged'], ['code', () => 0, 'unchanged'],
    ['imported', () => 0, 'unchanged'], ['closed', () => 0, 'unchanged'],
  ]],
  ['AccountEvents', [
    ['object', () => 256, 'both balances after the transfer'],
    ['transfer_pending_status', () => 16, 'always indexed'],
    ['prunable', (o) => (o.history ? 0 : 8), 'set when neither account keeps history'],
    ['account_timestamp', (o) => (o.history ? 32 : 0), 'one entry per account with the history flag'],
    ['dr_account_id_expired', () => 0, 'only for expiry events'], ['cr_account_id_expired', () => 0, 'only for expiry events'],
    ['transfer_pending_id_expired', () => 0, 'only for expiry events'], ['ledger_expired', () => 0, 'only for expiry events'],
  ]],
  ['TransferPending', [
    ['object', (o) => (o.pending ? 16 : 0), 'only for pending transfers'],
    ['status', (o) => (o.pending ? 16 : 0), 'only for pending transfers'],
  ]],
];

function treeBoard(o) {
  let hit = 0; let bytes = 0; let total = 0;
  const cols = GROOVES.map(([name, trees]) => {
    total += trees.length;
    const on = []; const off = [];
    for (const [t, fn, why] of trees) {
      const b = fn(o);
      if (b) { hit++; bytes += b; on.push(`<li class="is-hit"><span>${esc(t)}</span><b>${b} B</b></li>`); } else off.push(`<li><span>${esc(t)}</span><i>${esc(why || '')}</i></li>`);
    }
    const rest = off.length ? `<details><summary>${off.length} not written</summary><ul>${off.join('')}</ul></details>` : '';
    return `<div class="v-1b-groove"><h6>${name} <span>${on.length} of ${trees.length}</span></h6><ul>${on.join('') || '<li class="v-1b-none">none</li>'}</ul>${rest}</div>`;
  }).join('');
  return { html: `<div class="v-1b-trees">${cols}</div>`, hit, bytes, total };
}

const MiB = 1048576;
const JOURNAL = [
  {
    label: 'Batch', at: ['client'], edge: ['req'], disk: 0, mem: 0,
    title: 'The client sends 8,190 transfers in one request', where: 'cmd/tb/transfers/main.go',
    body: () => `<p>8,190 × 128 B = <b class="c-data">1,048,320 B</b>. With the 256 B message header that is exactly 1 MiB, TigerBeetle's <code>message_size_max</code>. The benchmark sends full batches. (The Go client used here sends 8,190; current TigerBeetle docs list 8,189 per request.)</p>${byteGrid()}`,
  },
  {
    label: 'Prepare', at: ['wp'], edge: ['wp'], disk: MiB, mem: 0,
    title: `The primary writes the prepare to WAL slot ${SLOT}`, where: 'src/vsr/journal.zig · write_prepare',
    body: () => `${codeBlock([
      `op        = «${fmt(OP)}»   // next op number`,
      `slot      = ${fmt(OP)} % 1024 = «${SLOT}»`,
      `offset    = ${SLOT} × 1 MiB  // prepare ring`,
      'timestamp = assigned now, one per transfer',
      'journal.write_sectors(write_prepare_header, write, buffer, .prepares, offset);',
    ], [4])}<p>One 1 MiB write, submitted through <code>io_uring</code>. The data file is opened with <code>O_DIRECT</code> and <code>O_DSYNC</code>, so the write completes only when the device reports the data on stable storage. No <code>fsync</code> call follows.</p>`,
  },
  {
    label: 'Header', at: ['wh'], edge: ['wh'], durable: ['wp', 'wh'], disk: 4096, mem: 0,
    title: 'Then its header goes into the header ring', where: 'src/vsr/journal.zig · write_prepare_header',
    body: () => `${codeBlock([
      `sector = ${SLOT} / 16 = «${SECTOR}»   // 16 × 256 B per 4 KiB`,
      `write 4 KiB: headers of slots ${SECTOR * 16}–${SECTOR * 16 + 15}`,
      '// the prepare is now durable here',
    ], [0, 1])}<p>The header is written twice, inside the prepare and again here, so recovery can check one copy against the other. These two writes are the durable cost of the whole batch: <b class="c-safe">2 writes for 8,190 transfers</b>.</p>
    <p>The benchmark ran one replica. In a 6-replica cluster the primary also sends the prepare to the 5 backups, and commits once <b>3 of 6</b> replicas have written it.</p>`,
  },
  {
    label: 'Execute', at: ['trees'], edge: ['exec'], durable: ['wp', 'wh'], disk: 0, mem: 824 * 8190, trees: true,
    title: 'The state machine applies 8,190 transfers', where: 'src/state_machine.zig · create_transfer',
    body: () => '',
  },
  {
    label: 'Reply', at: ['client'], edge: ['rep'], durable: ['wp', 'wh'], disk: 0, mem: 0,
    title: 'One reply for the whole batch', where: 'src/vsr/replica.zig',
    body: () => `<p><code>create_transfers</code> replies only with the transfers that failed, so a clean batch gets a short reply. The syscall trace above shows <b class="c-data">14 <code>sendto</code></b> calls for 100,000 transfers, which is 13 batches: about one per batch.</p>
    <p>The <b>client replies</b> zone keeps the latest reply for each of up to 64 clients, 1 MiB each, so a retried request gets the same answer.</p>`,
  },
  {
    label: 'Compact', at: ['grid'], edge: ['grid'], durable: ['wp', 'wh', 'grid'], disk: null, mem: 0,
    title: 'Every 32 ops, tables move down to disk', where: 'src/lsm/compaction.zig',
    body: () => `${codeBlock([
      'bar   = 32 ops (lsm_compaction_ops)',
      'mutable   → immutable  // in memory, sorted',
      'immutable → level 0    // 512 KiB grid blocks',
      'level n   → level n+1  // 7 levels, ×8 each',
    ], [2, 3])}<p>Compaction does a slice of this work after every commit, so the cost is spread evenly over the ops. Each merge reads tables and writes them again one level down, so each value is written several times over its life. That, on top of up to 824 B per transfer, is where the measured <b class="c-bad">8.2×</b> comes from.</p>`,
  },
  {
    label: 'Checkpoint', at: ['sb'], edge: ['ckpt'], durable: ['wp', 'wh', 'grid', 'sb'], disk: 4 * 24 * 1024, mem: 0,
    title: 'Every 960 ops, a new superblock', where: 'src/vsr/superblock.zig',
    body: () => `${codeBlock([
      'every 960 ops        // ≈ 7.9M full-batch transfers',
      'write superblock × 4 (24 KiB each)',
      '  → points to manifest + free set in the grid',
      '// older WAL slots can now be reused',
    ], [1])}<p>The superblock is the root pointer to the grid. On startup a replica takes the newest superblock that has at least 2 good copies, then replays the WAL from that op. Because execution is deterministic, the replay rebuilds the same state. 960 ops fit in the 1,024-slot ring with room for the ops in flight.</p>`,
  },
];

const ZONES = [
  ['sb', 'superblock', '4 × 24 KiB'],
  ['wh', 'WAL headers', '1,024 × 256 B'],
  ['wp', 'WAL prepares', '1,024 × 1 MiB'],
  ['cr', 'client replies', '64 × 1 MiB'],
  ['grid', 'grid', '512 KiB blocks · ≈ 20 GB'],
];

const BP_LAYOUT = {
  wide: {
    vb: [900, 262],
    client: [10, 36, 140, 64], primary: [230, 16, 440, 104],
    sm: [246, 50, 190, 58], trees: [456, 50, 198, 58],
    fileY: 158, fileH: 70, fileX: 10, fileW: 880,
    zoneW: { sb: 0.13, wh: 0.14, wp: 0.24, cr: 0.16, grid: 0.33 },
  },
  tall: {
    vb: [360, 578],
    client: [10, 10, 340, 48], primary: [10, 96, 340, 158],
    sm: [24, 126, 312, 50], trees: [24, 190, 312, 52],
    fileY: 300, fileH: 250, fileX: 10, fileW: 340, vertical: true,
    zoneW: { sb: 0.15, wh: 0.15, wp: 0.24, cr: 0.16, grid: 0.30 },
  },
};

const bytesTxt = (b) => (b == null ? 'blocks' : b === 0 ? '—' : b >= MiB ? `${+(b / MiB).toFixed(b >= 10 * MiB ? 0 : 1)} MiB` : `${fmt(b / 1024)} KiB`);

function initBatchPath(fig, app) {
  const id = uid('bp');
  let L = null; let step = 0; let treeGuess = null;
  const stage = h('div', { class: 'v-1b-map' });
  const detail = h('div', { class: 'v-1b-detail', 'aria-live': 'polite' });

  /* the journal: one ledger line per step */
  const rows = JOURNAL.map((st, i) => h('tr', { tabindex: 0, role: 'button', 'aria-label': `Step ${i + 1}: ${st.label}`, onclick: () => go(i), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { go(i); e.preventDefault(); } } },
    h('td', { class: 'n' }, String(i + 1).padStart(2, '0')),
    h('td', null, st.label),
    h('td', { class: 'num' }, bytesTxt(st.disk)),
    h('td', { class: 'num' }, st.mem ? `≤ ${bytesTxt(st.mem)}` : '—')));
  const journal = h('table', { class: 'v-1b-journal' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'entry'), h('th', { class: 'num' }, 'disk'), h('th', { class: 'num' }, 'memory'))),
    h('tbody', null, ...rows),
    h('tfoot', null, h('tr', null, h('td'), h('td', { colspan: 3 }, 'durable before the reply: 2 writes'))));
  const backB = h('button', { type: 'button', class: 'v-1b-btn', 'aria-label': 'Previous entry', onclick: () => go(step - 1) }, '◀');
  const nextB = h('button', { type: 'button', class: 'v-1b-btn', 'aria-label': 'Next entry', onclick: () => go(step + 1) }, '▶');

  app.append(
    stage,
    key([['proc', 'process'], ['rest', 'data at rest'], ['data', 'bytes'], ['look', 'this entry'], ['stamp', 'durable'], ['opt', 'controls']]),
    h('div', { class: 'v-1b-bp' },
      h('div', { class: 'v-1b-bp-l' }, journal, h('div', { class: 'v-1b-scrub' }, backB, nextB, h('span', { class: 'v-1b-pos' }, 'or use ← →'))),
      detail),
  );

  function zoneRects() {
    const out = {}; let off = 0;
    for (const [z] of ZONES) {
      const f = L.zoneW[z];
      out[z] = L.vertical ? [L.fileX, L.fileY + off * L.fileH, L.fileW, f * L.fileH] : [L.fileX + off * L.fileW, L.fileY, f * L.fileW, L.fileH];
      off += f;
    }
    return out;
  }

  function drawMap() {
    const st = JOURNAL[step];
    const [W, H] = L.vb;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'A TigerBeetle replica: client, primary, and the zones of the data file' });
    svg.innerHTML = `<defs><marker id="${id}a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="v-1b-arrowhead"/></marker></defs>`;
    const on = (k) => st.at.includes(k);
    const box = (r, k, dashed) => s('rect', { x: r[0], y: r[1], width: r[2], height: r[3], class: `v-1b-box${dashed ? ' is-rest' : ''}${on(k) ? ' is-on' : ''}` });
    const label = (r, a, b) => [
      s('text', { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 - 3, class: 'v-1b-t-m v-1b-t-b', 'text-anchor': 'middle' }, a),
      s('text', { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 + 12, class: 'v-1b-t-xs v-1b-t-mute', 'text-anchor': 'middle' }, b)];
    svg.append(box(L.client, 'client'), ...label(L.client, 'Go client', L.vertical ? 'create_transfers · 8,190 per request' : '8,190 per request'));
    const [px, py, pw, ph] = L.primary;
    svg.append(box(L.primary, 'primary'));
    svg.append(s('text', { x: px + 10, y: py + 18, class: 'v-1b-t-s v-1b-t-b' }, 'tigerbeetle ', s('tspan', { class: 'v-1b-t-mute', style: 'font-weight:400' }, '· primary · one thread')));
    svg.append(box(L.sm, 'sm'), ...label(L.sm, 'state machine', 'balances · limits · ids'));
    svg.append(box(L.trees, 'trees', true), ...label(L.trees, '33 LSM trees', 'in-memory tables'));
    const [sx, sy, sw, sh] = L.sm; const [tx, ty, tw, th] = L.trees;
    svg.append(s('path', { d: L.vertical ? `M${sx + sw / 2} ${sy + sh} L${tx + tw / 2} ${ty}` : `M${sx + sw} ${sy + sh / 2} L${tx} ${ty + th / 2}`, class: `v-1b-edge${st.edge.includes('exec') ? ' is-on' : ''}` }));

    const Z = zoneRects();
    const durable = st.durable || [];
    for (const [k, n, sz] of ZONES) {
      const [x, y, w, hh] = Z[k];
      svg.append(s('rect', { x, y, width: w, height: hh, class: `v-1b-box is-rest${durable.includes(k) ? ' is-dur' : ''}${on(k) ? ' is-on' : ''}` }));
      const ny = L.vertical ? y + hh / 2 - 2 : y + hh / 2 - 10;
      svg.append(s('text', { x: x + w / 2, y: ny, class: 'v-1b-t-s v-1b-t-b', 'text-anchor': 'middle' }, n));
      svg.append(s('text', { x: x + w / 2, y: ny + 14, class: 'v-1b-t-xs v-1b-t-data', 'text-anchor': 'middle' }, sz));
      if (durable.includes(k)) {
        const cx = x + w - 38; const cy = L.vertical ? y + 13 : y + 1;
        svg.append(s('g', { class: 'v-1b-zstamp', transform: `rotate(-5 ${cx} ${cy})` },
          s('rect', { x: cx - 30, y: cy - 8, width: 60, height: 14, rx: 2 }),
          s('text', { x: cx, y: cy + 2.5, 'text-anchor': 'middle' }, 'DURABLE')));
      }
    }
    svg.append(s('text', { x: L.fileX, y: L.fileY + L.fileH + (L.vertical ? 18 : 20), class: 'v-1b-t-xs v-1b-t-b v-1b-t-up' }, '0_0.tigerbeetle ',
      s('tspan', { class: 'v-1b-t-mute', style: 'font-weight:400;text-transform:none;letter-spacing:0' }, L.vertical ? '· not to scale' : '· one file · 21 GB after the benchmark · not to scale')));

    const arrow = (d) => svg.append(s('path', { d, class: 'v-1b-arrow', 'marker-end': `url(#${id}a)` }));
    const tag = (x, y, text, anchor = 'start') => svg.append(s('text', { x, y, class: 'v-1b-t-xs v-1b-t-b v-1b-t-look v-1b-halo', 'text-anchor': anchor }, text));
    const [cx, cy, cw, ch] = L.client;
    for (const e of st.edge) {
      if (e === 'req') { arrow(L.vertical ? `M${cx + 130},${cy + ch} L${cx + 130},${py}` : `M${cx + cw},${cy + 22} L${px},${cy + 22}`); L.vertical ? tag(cx + 138, cy + ch + 24, '1 MiB request') : tag(cx + cw + 40, cy + 16, '1 MiB', 'middle'); }
      if (e === 'rep') { arrow(L.vertical ? `M${cx + 210},${py} L${cx + 210},${cy + ch}` : `M${px},${cy + 50} L${cx + cw},${cy + 50}`); L.vertical ? tag(cx + 218, cy + ch + 24, 'reply') : tag(cx + cw + 40, cy + 66, 'reply', 'middle'); }
      if (e === 'wp' || e === 'wh' || e === 'grid') {
        const [zx, zy, zw] = Z[e];
        const from = e === 'grid' ? [tx + tw / 2, ty + th] : [sx + sw / 2, sy + sh];
        const what = { wp: '1 MiB write', wh: '4 KiB write', grid: '512 KiB blocks' }[e];
        if (L.vertical) {
          const fx = from[0] + (e === 'grid' ? 60 : -40); const toX = zx + zw - 40;
          arrow(`M${fx},${py + ph} L${fx},${py + ph + 14} L${toX},${py + ph + 14} L${toX},${zy + 4}`);
          tag(fx + 8, py + ph + 30, what);
        } else {
          arrow(`M${from[0]},${py + ph} L${from[0]},${py + ph + 20} L${zx + zw / 2},${py + ph + 20} L${zx + zw / 2},${zy}`);
          tag(Math.max(from[0], zx + zw / 2) + 8, py + ph + 16, what);
        }
      }
      if (e === 'ckpt') {
        const [gx, gy] = Z.grid; const [zx, zy, zw, zh] = Z.sb;
        if (L.vertical) { arrow(`M${gx + 26},${gy + 10} C${gx + 2},${gy - 70} ${zx + 2},${zy + zh + 70} ${zx + 26},${zy + zh - 4}`); tag(zx + 34, zy + zh + 14, '4 × 24 KiB'); }
        else { arrow(`M${gx + 30},${gy} C${gx + 10},${gy - 34} ${zx + zw / 2},${zy - 34} ${zx + zw / 2},${zy}`); tag((gx + zx + zw / 2) / 2, gy - 30, 'new root: 4 × 24 KiB', 'middle'); }
      }
    }
    stage.replaceChildren(svg);
  }

  function drawDetail() {
    const st = JOURNAL[step];
    let body = st.body();
    if (st.trees && treeGuess == null) {
      body = `<p>First it prefetches both accounts of every transfer, and checks that each <code>id</code> is new. Then it writes values into the in-memory tables of the LSM trees. There are 33 trees.</p>
        <div class="v-1b-ask"><p class="v-1b-q">Guess first: how many of the 33 trees does one plain transfer write to?</p>
        <div class="v-1b-choices" role="group" aria-label="Your guess">${[33, 14, 11, 3].map((n) => `<button type="button" class="v-1b-tg" data-g="${n}">${n}</button>`).join('')}</div></div>`;
    } else if (st.trees) {
      const tb = treeBoard(OPT);
      const fb = treeGuess === 11 ? '<b class="c-safe">Right: 11 for the benchmark\'s transfer.</b>' : `<b class="c-bad">You guessed ${treeGuess}; the benchmark's transfer writes to 11.</b>`;
      body = `<p>First it prefetches what the batch needs: both accounts of every transfer, and a check that each <code>id</code> is new. Cache misses are reads from the grid. Then it updates two balances per transfer and writes values into the in-memory tables of the LSM trees. Change the transfer to see which trees it writes:</p>
        <div class="v-1b-opts" role="group" aria-label="Transfer options">
          <button type="button" class="v-1b-tg" data-o="ud" aria-pressed="${OPT.ud}">user_data set</button>
          <button type="button" class="v-1b-tg" data-o="pending" aria-pressed="${OPT.pending}">pending, with timeout</button>
          <button type="button" class="v-1b-tg" data-o="history" aria-pressed="${OPT.history}">accounts keep history</button>
        </div><p class="v-1b-answer">${fb} Zero fields in optional indexes are skipped, and a transfer does not change an account's indexes.</p>${tb.html}
        <p class="v-1b-sum"><b class="c-look">${tb.hit} of ${tb.total} trees</b> get a value: up to <b class="c-data">${tb.bytes} B</b> for one <b class="c-data">128 B</b> transfer, <b class="c-data">≤ ${bytesTxt(tb.bytes * 8190)}</b> for the batch. ${OPT.ud || OPT.pending || OPT.history ? '' : 'This is the benchmark\'s transfer. '}Two updates to the same account in one bar keep only the last version, so this is an upper bound.</p>`;
      rows[3].lastChild.textContent = `≤ ${bytesTxt(tb.bytes * 8190)}`;
    }
    detail.innerHTML = `<h4><span class="n">${String(step + 1).padStart(2, '0')}</span> ${esc(st.title)} <span class="where">${esc(st.where)}</span></h4>${body}`;
    detail.querySelectorAll('.v-1b-opts button').forEach((b) => b.addEventListener('click', () => { OPT[b.dataset.o] = !OPT[b.dataset.o]; drawDetail(); }));
    detail.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => { treeGuess = +b.dataset.g; drawDetail(); }));
    wireBytes();
  }

  function wireBytes() {
    const flds = detail.querySelectorAll('.v-1b-fld');
    if (!flds.length) return;
    const hint = detail.querySelector('.v-1b-hint');
    const show = (fi) => {
      detail.querySelectorAll('.v-1b-b').forEach((b) => b.classList.toggle('is-hot', b.dataset.f === String(fi)));
      flds.forEach((f) => f.classList.toggle('is-hot', f.dataset.f === String(fi)));
      const [name, n, v, why] = TRANSFER[fi];
      hint.innerHTML = `<b class="c-look">${esc(name)}</b>: ${n} bytes, value <b class="c-data">${v}</b>${why ? ` (${esc(why)})` : ''}.`;
    };
    flds.forEach((f) => { f.addEventListener('click', () => show(+f.dataset.f)); f.addEventListener('mouseenter', () => show(+f.dataset.f)); });
    detail.querySelectorAll('.v-1b-b').forEach((b) => b.addEventListener('click', () => show(+b.dataset.f)));
  }

  function go(i) {
    step = clamp(i, 0, JOURNAL.length - 1);
    rows.forEach((r, k) => { r.classList.toggle('is-cur', k === step); r.classList.toggle('is-past', k < step); if (k === step) r.setAttribute('aria-current', 'step'); else r.removeAttribute('aria-current'); });
    backB.disabled = step === 0; nextB.disabled = step === JOURNAL.length - 1;
    drawMap(); drawDetail();
  }

  function render() {
    const next = stage.clientWidth < 560 ? BP_LAYOUT.tall : BP_LAYOUT.wide;
    if (next === L) return;
    L = next;
    drawMap();
  }

  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') { go(step + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(step - 1); e.preventDefault(); }
  });
  L = stage.clientWidth < 560 ? BP_LAYOUT.tall : BP_LAYOUT.wide;
  go(0);
  new ResizeObserver(render).observe(stage);
}

register({ 'one-batch': initOneBatch, 'group-commit': initGroupCommit, 'batch-path': initBatchPath });

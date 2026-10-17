/*
 * Figures for "1B Payments/Day - TigerBeetle & PostgreSQL".
 * House style (walviz.css); this file only decides what each figure does.
 *
 *   one-batch     predict, then see: how many WAL flushes Postgres needs for
 *                 8,190 single-row commits (measured 0.42 per row), against
 *                 TigerBeetle's one prepare for a request of 8,190.
 *   group-commit  Postgres backends and WAL flushes on a timeline: one flush
 *                 at a time, each covering every commit record inserted before
 *                 it started. A model fitted to the two measured runs.
 *   batch-path    one create_transfers batch through a TigerBeetle replica:
 *                 the data-file zones, a journal of what each step writes, and
 *                 a guess-first view of the LSM trees one transfer touches.
 *
 * TigerBeetle facts are from the 0.16.78 source (src/config.zig,
 * constants.zig, vsr/journal.zig, vsr/superblock.zig, state_machine.zig,
 * lsm/groove.zig). Measured numbers are from the post.
 */
import { h, s, codeBlock, colorKey, range, chips, ask, register, mulberry, clamp, fmt, esc, uid, REDUCED } from './lib.js';

const tokens = (el) => {
  const cs = getComputedStyle(el);
  const g = (n) => cs.getPropertyValue(n).trim();
  return { line: g('--line'), brown: g('--brown'), green: g('--green') };
};

/* ================================================================ ONE BATCH */

const BATCH = 8190;
const COLS = 91; const ROWS = 90;            // 91 × 90 = 8,190
/* measured fdatasync calls per row (see the post) */
const PG_RUNS = {
  ins: { perRow: 4177054 / 1e7, what: 'single-row INSERTs, 8 backends' },
  xfer: { perRow: 1517374 / 2e6, what: 'transfers, 10 backends' },
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
  const run = 'ins'; let revealAt = null; let raf = 0;
  const panel = (name) => {
    const cv = h('canvas', { class: 'v-1b-cv', role: 'img' });
    const tag = h('span');
    return { el: h('div', { class: 'wv-card v-1b-sheet' }, h('h5', null, name, ' ', tag), h('div', { class: 'v-1b-cvwrap' }, cv)), cv, tag };
  };
  const tb = panel('TigerBeetle');
  const pg = panel('PostgreSQL');

  const question = ask('How many WAL flushes does Postgres need to make all 8,190 durable?',
    [[8190, '8,190 · one per commit'], [3400, 'about 3,400'], [100, 'about 100'], [1, '1 · like TigerBeetle']], 3400,
    (v, right) => {
      reveal();
      const n = flushEnds(PG_RUNS.ins.perRow).length;
      const x = flushEnds(PG_RUNS.xfer.perRow).length;
      return `${right ? '<b>Right.</b> ' : ''}<b>${fmt(n)}</b> flushes for 8,190 single-row inserts, at the measured rate. ${v === 8190 ? 'Not one per commit: with' : 'With'} 8 backends, about 2.4 commits share each flush. In the transfer run, where each transaction does more work, it would be ${fmt(x)}. TigerBeetle makes the whole request durable with <b>one prepare</b> before it runs any of it.`;
    });

  app.append(
    h('p', { class: 'v-1b-lede' }, 'Take ', h('b', { class: 'c-data' }, '8,190 rows'), ' of 128 B, one full TigerBeetle request (1 MiB). Each square is one row. Postgres commits each row in its own transaction from 8 backends, as in the INSERT run above.'),
    question.el,
    h('div', { class: 'v-1b-sheets' }, tb.el, pg.el),
    colorKey([['k-data', 'one row'], ['k-held', 'durable write (flush or prepare)']]),
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
    if (revealAt == null) {
      tb.tag.innerHTML = ''; pg.tag.innerHTML = '<span class="wv-tag">? flushes</span>';
    } else {
      tb.tag.innerHTML = '<span class="wv-tag c-safe">1 prepare · 2 writes</span>';
      pg.tag.innerHTML = `<span class="wv-tag c-safe">${fmt(shown)} flushes</span>`;
    }
    tb.cv.setAttribute('aria-label', 'TigerBeetle: 8,190 rows made durable by one prepare, written in 2 writes');
    pg.cv.setAttribute('aria-label', revealAt == null ? 'PostgreSQL: 8,190 rows, flushes hidden until you guess' : `PostgreSQL ${R.what}: ${fmt(ends.length)} WAL flushes for 8,190 rows`);
  }

  function reveal() {
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
  const M = PRESETS[0];                          // the measured INSERT run
  const P = { W: M.W, work: M.work, flush: M.flush };
  let sim = null; let win = null; let sel = 0;
  const base = simulate(M.W, M.work, M.flush);
  const stage = h('div', { class: 'v-1b-strip' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const fit = h('p', { class: 'v-1b-fit' });

  const rW = range('backends', { min: 1, max: 16, value: P.W, oninput: (v) => { P.W = v; update(); } });

  /* predict first: what does doubling the backends do to a flush? */
  const question = ask('Below: 8 backends, each flush 163 µs. Double the backends to 16. Each flush then carries…',
    [['fewer', 'fewer commits'], ['same', 'the same number'], ['more', 'more commits']], 'more',
    () => {
      rW.set(16);
      return `<b>${sim.perFlush.toFixed(1)}</b> commits per flush instead of <b>${base.perFlush.toFixed(1)}</b>, and ${fmt(sim.rate)} commits/s instead of ${fmt(base.rate)} in this model. A flush still takes 163 µs and still runs one at a time, so more backends are waiting when it starts. The benchmark VM had 4 vCPUs and the model ignores CPU limits, so a real run would gain less.`;
    });

  const prevB = h('button', { type: 'button', class: 'wv-btn', 'aria-label': 'Previous flush', onclick: () => pick(sel - 1) }, '◀ flush');
  const nextB = h('button', { type: 'button', class: 'wv-btn', 'aria-label': 'Next flush', onclick: () => pick(sel + 1) }, 'flush ▶');
  const pos = h('span', { class: 'wv-pos' });

  app.append(
    question.el,
    h('div', { class: 'wv-grid-ctrl' }, rW.el),
    stage,
    h('div', { class: 'wv-bar' }, prevB, pos, nextB),
    note,
    fit,
    colorKey([['k-run', 'waiting for a flush'], ['k-look', 'made durable by the selected flush'], ['k-gap', 'just missed it']]),
  );

  const visible = () => sim.flushes.map((q, j) => j).filter((j) => j >= sim.warm && sim.flushes[j].e <= win.t1);

  function update() {
    sim = P.W === M.W ? base : simulate(P.W, P.work, P.flush);
    const span = clamp((18 * P.flush) / Math.max(sim.busy, 0.2), 1500, 30000);
    const t0 = sim.flushes[sim.warm].s;
    win = { t0, t1: t0 + span };
    const v = visible();
    sel = v.reduce((a, k) => (sim.flushes[k].m.length > sim.flushes[a].m.length ? k : a), v[0]);
    draw();
    fit.innerHTML = P.W === M.W
      ? `Model: <b>${sim.perFlush.toFixed(2)}</b> commits per flush, <b>${fmt(sim.rate)}</b>/s. Measured with 8 backends: <b>${M.measured.perFlush.toFixed(2)}</b>, <b>${fmt(M.measured.rate)}</b>/s.`
      : `Model: <b>${sim.perFlush.toFixed(2)}</b> commits per flush, <b>${fmt(sim.rate)}</b>/s, the WAL busy ${Math.round(sim.busy * 100)}% of the time. Measured only with 8 backends.`;
  }

  function pick(k) {
    const v = visible();
    sel = clamp(k, v[0], v[v.length - 1]);
    draw();
  }

  /* fixed chart height: lanes share one band, so the layout does not jump
     when the number of backends changes */
  function draw() {
    const width = Math.max(300, app.clientWidth);
    const phone = width < 600;
    const L = phone ? 30 : 86; const R = 8;
    const band = phone ? 250 : 300;
    const W = P.W;
    const pitch = (band / 16) * Math.min(16 / W, 1.6);
    const laneH = Math.max(6, pitch * 0.72);
    const top = 30 + (band - W * pitch) / 2;
    const flushY = 30 + band + 8;
    const flushH = phone ? 22 : 26;
    const H = flushY + flushH + 26;
    const x = (t) => L + ((t - win.t0) / (win.t1 - win.t0)) * (width - L - R);
    const id = uid('gc');
    const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': `Timeline of ${W} Postgres backends and the WAL flushes they wait on` });
    svg.innerHTML = `<defs><clipPath id="${id}"><rect x="${L}" y="0" width="${width - L - R}" height="${H}"/></clipPath>
      <pattern id="${id}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" class="v-1b-hatch"/></pattern></defs>`;
    const f = sim.flushes[sel];
    const span = win.t1 - win.t0;
    const stepUs = span <= 2500 ? 250 : span <= 6000 ? 500 : span <= 12000 ? 1000 : span <= 25000 ? 2000 : 5000;
    for (let t = 0; t <= span + 1; t += stepUs) {
      const xx = x(win.t0 + t);
      if (!phone || (t / stepUs) % 2 === 0) svg.append(s('text', { x: xx, y: H - 6, class: 't-xs t-mute', 'text-anchor': 'middle' }, `${+(t / 1000).toFixed(2)} ms`));
    }
    const body = s('g', { 'clip-path': `url(#${id})` });
    const late = new Set();
    const showAll = laneH >= 9;
    for (let b = 0; b < W; b++) {
      const y = top + b * pitch;
      if (showAll || b % 2 === 0) svg.append(s('text', { x: L - 6, y: y + laneH / 2 + 3.5, class: 't-xs t-mute', 'text-anchor': 'end' }, phone || W > 8 ? `b${b + 1}` : `backend ${b + 1}`));
      body.append(s('line', { x1: L, x2: width - R, y1: y + laneH / 2, y2: y + laneH / 2, class: 'v-1b-lane' }));
      for (const ev of sim.lanes[b]) {
        if (ev.fe < win.t0 || ev.ws > win.t1) continue;
        const mine = ev.f === sel;
        const missed = ev.f === sel + 1 && ev.rec > f.s && ev.rec < f.e;
        if (missed) late.add(b);
        body.append(s('rect', {
          x: x(ev.rec), y, width: Math.max(0.8, x(ev.fe) - x(ev.rec)), height: laneH,
          class: mine ? 'v-1b-wait is-sel' : missed ? 'v-1b-wait is-late' : 'v-1b-wait', fill: mine || missed ? null : `url(#${id}h)`,
        }));
      }
    }
    svg.append(s('text', { x: L - 6, y: flushY + flushH / 2 + 4, class: 't-xs t-b', 'text-anchor': 'end' }, phone ? 'WAL' : 'WAL flush'));
    sim.flushes.forEach((fl, k) => {
      if (fl.e < win.t0 || fl.s > win.t1) return;
      const x0 = x(fl.s); const w = Math.max(1, x(fl.e) - x0);
      const g = s('g', { class: `v-1b-flush${k === sel ? ' is-sel' : ''}` });
      g.append(s('rect', { x: x0 + 0.5, y: flushY, width: Math.max(0.5, w - 1), height: flushH }));
      if (w >= 11) g.append(s('text', { x: x0 + w / 2, y: flushY + flushH / 2 + 4, 'text-anchor': 'middle', class: 't-xs t-b' }, String(fl.m.length)));
      g.addEventListener('click', () => pick(k));
      body.append(g);
    });
    svg.append(body);
    /* the label sits on the selected flush */
    const cx = (x(f.s) + x(f.e)) / 2;
    const anchor = cx > width - 120 ? 'end' : cx < L + 120 ? 'start' : 'middle';
    svg.append(s('text', { x: anchor === 'end' ? x(f.e) : anchor === 'start' ? x(f.s) : cx, y: 16, class: 't-s t-b t-look', 'text-anchor': anchor },
      `one fdatasync → ${f.m.length} commit${f.m.length > 1 ? 's' : ''} durable`));
    svg.append(s('line', { x1: cx, x2: cx, y1: 21, y2: flushY, class: 'v-1b-pin' }));
    stage.replaceChildren(svg);

    const v = visible(); const idx = v.indexOf(sel);
    pos.textContent = `${idx + 1} / ${v.length}`;
    prevB.disabled = idx <= 0; nextB.disabled = idx >= v.length - 1;
    const who = f.m.map((b) => `b${b + 1}`).join(', ');
    note.innerHTML = `<span class="k">Flush ${idx + 1}</span>Makes <b class="c-look">${f.m.length} commit${f.m.length > 1 ? 's' : ''}</b> durable (${who}).${late.size
      ? ` <span class="c-bad">${[...late].map((b) => `b${b + 1}`).join(', ')} inserted ${late.size > 1 ? 'their commit records' : 'its commit record'} just after it started, so ${late.size > 1 ? 'they wait' : 'it waits'} for the next one.</span>` : ''}`;
  }

  update();
  let lastW = app.clientWidth;
  new ResizeObserver(() => { if (Math.abs(app.clientWidth - lastW) > 4) { lastW = app.clientWidth; draw(); } }).observe(app);
  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input, summary, select')) return;
    if (e.key === 'ArrowRight') { pick(sel + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { pick(sel - 1); e.preventDefault(); }
  });
}

/* ============================================================== BATCH PATH */

const OP = 1221;                                    // sample op number
const SLOT = OP % 1024;                             // 197
const SECTOR = Math.floor(SLOT / 16);               // 12

/* The 33 LSM trees and what one transfer writes into them.
 * write(opts) returns bytes for this tree, or 0. */
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

const MiB = 1048576;
const JOURNAL = [
  {
    label: 'Batch', at: ['client'], edge: ['req'], disk: 0, mem: 0,
    title: 'The client sends 8,190 transfers in one request', where: 'cmd/tb/transfers/main.go',
    body: () => `<p>8,190 × 128 B = <b>1,048,320 B</b>. With the 256 B message header that is exactly 1 MiB, TigerBeetle's <code>message_size_max</code>. The benchmark sends full batches. (The Go client used here sends 8,190; current TigerBeetle docs list 8,189 per request.)</p><p>Every field of the benchmark's transfers that the client does not set, such as <code>pending_id</code> and the three <code>user_data</code> fields, is zero. That matters in step 4.</p>`,
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
    body: () => `<p><code>create_transfers</code> replies only with the transfers that failed, so a clean batch gets a short reply. The syscall trace above shows <b>14 <code>sendto</code></b> calls for 100,000 transfers, which is 13 batches: about one per batch.</p>
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
    ], [2, 3])}<p>Compaction does a slice of this work after every commit, so the cost is spread evenly over the ops. Each merge reads tables and writes them again one level down, so each value is written several times over its life. That, on top of up to 824 B per transfer, is where the measured <b>8.2×</b> comes from.</p>`,
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

function treeCards(o) {
  let hit = 0; let bytes = 0; let total = 0;
  const cards = GROOVES.map(([name, trees]) => {
    total += trees.length;
    const on = []; const off = [];
    for (const [t, fn, why] of trees) {
      const b = fn(o);
      if (b) { hit++; bytes += b; on.push(`<tr><td>${esc(t)}</td><td class="v-1b-num">${b} B</td></tr>`); } else off.push(`<tr><td>${esc(t)}</td><td>${esc(why || '')}</td></tr>`);
    }
    const rest = off.length ? `<details><summary>${off.length} not written</summary><table class="wv-table v-1b-trees"><tbody>${off.join('')}</tbody></table></details>` : '';
    return `<div class="wv-card"><h5>${name} · ${on.length} of ${trees.length}</h5><table class="wv-table v-1b-trees"><tbody>${on.join('') || '<tr><td>none</td></tr>'}</tbody></table>${rest}</div>`;
  }).join('');
  return { html: `<div class="wv-cards">${cards}</div>`, hit, bytes, total };
}

const bytesTxt = (b) => (b == null ? 'blocks' : b === 0 ? '—' : b >= MiB ? `${+(b / MiB).toFixed(b >= 10 * MiB ? 0 : 1)} MiB` : `${fmt(b / 1024)} KiB`);

function initBatchPath(fig, app) {
  const id = uid('bp');
  let L = null; let step = 0;
  const opt = { ud: false, pending: false, history: false };
  const stage = h('div', { class: 'v-1b-map' });
  const detail = h('div', { class: 'wv-insp', 'aria-live': 'polite' });

  /* built once so the reader's guess and toggles survive stepping away */
  const board = h('div');
  const optPick = chips([['ud', 'user_data set'], ['pending', 'pending, with timeout'], ['history', 'accounts keep history']],
    (vals) => { for (const k of Object.keys(opt)) opt[k] = vals.includes(k); drawBoard(); }, { multi: true, value: [], label: 'Transfer options' });
  const change = h('details', null, h('summary', null, 'Change the transfer'), optPick.el);
  let guessed = false;
  const treeAsk = ask('Guess first: how many of the 33 trees does one plain transfer write to?',
    [[33, '33'], [14, '14'], [11, '11'], [3, '3']], 11,
    (v, right) => {
      guessed = true; drawBoard();
      return `${right ? '<b>Right: 11</b>' : `<b>It is 11</b>`} for the benchmark's transfer. Zero fields in optional indexes are skipped, and a transfer does not change an account's indexes. Open <b>Change the transfer</b> below to set more fields.`;
    });
  const treeView = h('div', null, treeAsk.el, board);
  function drawBoard() {
    if (!guessed) { board.replaceChildren(); return; }
    const tc = treeCards(opt);
    board.innerHTML = '';
    const sum = h('p', { class: 'v-1b-sum' });
    sum.innerHTML = `<b>${tc.hit} of ${tc.total} trees</b> get a value: up to <b>${tc.bytes} B</b> for one 128 B transfer, <b>≤ ${bytesTxt(tc.bytes * 8190)}</b> for the batch. Two updates to the same account in one bar keep only the last version, so this is an upper bound.`;
    const cards = h('div'); cards.innerHTML = tc.html;
    board.append(sum, cards, change);
    rows[3].lastChild.textContent = `≤ ${bytesTxt(tc.bytes * 8190)}`;
  }

  const rows = JOURNAL.map((st, i) => h('tr', { tabindex: 0, class: 'v-1b-row', 'aria-label': `Step ${i + 1}: ${st.label}`, onclick: () => go(i), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { go(i); e.preventDefault(); } } },
    h('td', null, String(i + 1).padStart(2, '0')),
    h('td', null, st.label),
    h('td', { class: 'v-1b-num' }, bytesTxt(st.disk)),
    h('td', { class: 'v-1b-num' }, st.mem ? `≤ ${bytesTxt(st.mem)}` : '—')));
  const journal = h('table', { class: 'wv-table' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'step'), h('th', { class: 'v-1b-num' }, 'disk'), h('th', { class: 'v-1b-num' }, 'memory'))),
    h('tbody', null, ...rows));
  const backB = h('button', { type: 'button', class: 'wv-btn', 'aria-label': 'Previous step', onclick: () => go(step - 1) }, '◀ Back');
  const nextB = h('button', { type: 'button', class: 'wv-btn', 'aria-label': 'Next step', onclick: () => go(step + 1) }, 'Next ▶');
  const pos = h('span', { class: 'wv-pos' });

  app.append(
    stage,
    colorKey([['k-look', 'this step'], ['k-held', 'durable on disk']]),
    h('div', { class: 'v-1b-bp' },
      h('div', null, journal, h('div', { class: 'wv-bar v-1b-nav' }, backB, pos, h('span', { class: 'wv-sp' }), nextB)),
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
    svg.innerHTML = `<defs><marker id="${id}a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="v-1b-head"/></marker></defs>`;
    const on = (k) => st.at.includes(k);
    const box = (r, k, dashed) => s('g', { class: `node${on(k) ? ' is-focus' : ''}` }, s('rect', { x: r[0], y: r[1], width: r[2], height: r[3], class: `box${dashed ? ' dash' : ''}` }));
    const label = (r, a, b) => [
      s('text', { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 - 3, class: 't-m t-b', 'text-anchor': 'middle' }, a),
      s('text', { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 + 12, class: 't-xs t-mute', 'text-anchor': 'middle' }, b)];
    svg.append(box(L.client, 'client'), ...label(L.client, 'Go client', L.vertical ? 'create_transfers · 8,190 per request' : '8,190 per request'));
    const [px, py, pw, ph] = L.primary;
    svg.append(box(L.primary, 'primary'));
    svg.append(s('text', { x: px + 10, y: py + 18, class: 't-s t-b' }, 'tigerbeetle ', s('tspan', { class: 't-mute' }, '· primary · one thread')));
    svg.append(box(L.sm, 'sm'), ...label(L.sm, 'state machine', 'balances · limits · ids'));
    svg.append(box(L.trees, 'trees', true), ...label(L.trees, '33 LSM trees', 'in-memory tables'));
    const [sx, sy, sw, sh] = L.sm; const [tx, ty, tw, th] = L.trees;
    svg.append(s('path', { d: L.vertical ? `M${sx + sw / 2} ${sy + sh} L${tx + tw / 2} ${ty}` : `M${sx + sw} ${sy + sh / 2} L${tx} ${ty + th / 2}`, class: `edge${st.edge.includes('exec') ? ' flow' : ''}` }));

    const Z = zoneRects();
    const durable = st.durable || [];
    for (const [k, n, sz] of ZONES) {
      const [x, y, w, hh] = Z[k];
      svg.append(s('g', { class: `node${on(k) ? ' is-focus' : ''}` }, s('rect', { x, y, width: w, height: hh, class: `box dash${durable.includes(k) && !on(k) ? ' v-1b-dur' : ''}` })));
      const ny = L.vertical ? y + hh / 2 - 2 : y + hh / 2 - 10;
      svg.append(s('text', { x: x + w / 2, y: ny, class: 't-s t-b', 'text-anchor': 'middle' }, n));
      svg.append(s('text', { x: x + w / 2, y: ny + 14, class: 't-xs t-mute', 'text-anchor': 'middle' }, sz));
      if (durable.includes(k)) {
        svg.append(s('text', L.vertical ? { x: x + w - 8, y: y + hh / 2 + 4, class: 't-xs t-b t-safe', 'text-anchor': 'end' } : { x: x + w / 2, y: ny + 30, class: 't-xs t-b t-safe', 'text-anchor': 'middle' }, 'durable'));
      }
    }
    svg.append(s('text', { x: L.fileX, y: L.fileY + L.fileH + (L.vertical ? 18 : 20), class: 't-xs t-b t-up' }, '0_0.tigerbeetle ',
      s('tspan', { class: 't-mute' }, L.vertical ? '· not to scale' : '· one file · 21 GB after the benchmark · not to scale')));

    const arrow = (d) => svg.append(s('path', { d, class: 'v-1b-arrow', 'marker-end': `url(#${id}a)` }));
    const tag = (x, y, text, anchor = 'start') => svg.append(s('text', { x, y, class: 't-xs t-b t-look halo', 'text-anchor': anchor }, text));
    const [cx, cy, cw, ch] = L.client;
    for (const e of st.edge) {
      if (e === 'req') { arrow(L.vertical ? `M${cx + 130},${cy + ch} L${cx + 130},${py}` : `M${cx + cw},${cy + 22} L${px},${cy + 22}`); if (L.vertical) tag(cx + 138, cy + ch + 24, '1 MiB request'); else tag(cx + cw + 40, cy + 16, '1 MiB', 'middle'); }
      if (e === 'rep') { arrow(L.vertical ? `M${cx + 210},${py} L${cx + 210},${cy + ch}` : `M${px},${cy + 50} L${cx + cw},${cy + 50}`); if (L.vertical) tag(cx + 218, cy + ch + 24, 'reply'); else tag(cx + cw + 40, cy + 66, 'reply', 'middle'); }
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
        if (L.vertical) { arrow(`M${gx + 26},${gy + 10} C${gx + 2},${gy - 70} ${zx + 2},${zy + zh + 70} ${zx + 26},${zy + zh - 4}`); tag(zx + 34, zy + zh + 14, '4 × 24 KiB'); } else { arrow(`M${gx + 30},${gy} C${gx + 10},${gy - 34} ${zx + zw / 2},${zy - 34} ${zx + zw / 2},${zy}`); tag((gx + zx + zw / 2) / 2, gy - 30, 'new root: 4 × 24 KiB', 'middle'); }
      }
    }
    stage.replaceChildren(svg);
  }

  function drawDetail() {
    const st = JOURNAL[step];
    const head = `<h4><span>${String(step + 1).padStart(2, '0')} · ${esc(st.title)}</span><span class="where">${esc(st.where)}</span></h4>`;
    if (st.trees) {
      detail.innerHTML = `${head}<p>First it prefetches what the batch needs: both accounts of every transfer, and a check that each <code>id</code> is new. Cache misses are reads from the grid. Then it updates two balances per transfer and writes values into the in-memory tables of the LSM trees.</p>`;
      detail.append(treeView);
      return;
    }
    detail.innerHTML = head + st.body();
  }

  function go(i) {
    step = clamp(i, 0, JOURNAL.length - 1);
    rows.forEach((r, k) => { r.classList.toggle('is-look', k === step); if (k === step) r.setAttribute('aria-current', 'step'); else r.removeAttribute('aria-current'); });
    backB.disabled = step === 0; nextB.disabled = step === JOURNAL.length - 1;
    pos.textContent = `${step + 1} / ${JOURNAL.length}`;
    drawMap(); drawDetail();
  }

  function render() {
    const next = stage.clientWidth < 560 ? BP_LAYOUT.tall : BP_LAYOUT.wide;
    if (next === L) return;
    L = next;
    drawMap();
  }

  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input, summary, select')) return;
    if (e.key === 'ArrowRight') { go(step + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(step - 1); e.preventDefault(); }
  });
  L = stage.clientWidth < 560 ? BP_LAYOUT.tall : BP_LAYOUT.wide;
  go(0);
  new ResizeObserver(render).observe(stage);
}

register({ 'one-batch': initOneBatch, 'group-commit': initGroupCommit, 'batch-path': initBatchPath });

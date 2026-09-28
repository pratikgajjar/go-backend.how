/*
 * viz/the-tiger-style — figures for "The Tiger Style".
 *
 * House look (walviz.css + viz/lib.js). What differs per figure is the
 * interaction, and each one asks the reader to act before it shows:
 *
 *   ts-tripwire  one transfer, three faults, two assertions: predict where
 *                it stops, then watch; the 12-case grid fills as you try
 *   ts-struct    edit the 128-byte Transfer, predict which comptime
 *                assertion stops `zig build`, then see the build
 *   ts-napkin    guess which resource costs most per transfer at 8,189 per
 *                batch, then move the inputs of the sketch
 *   ts-queue     ordinary queue code → Tiger Style, one rule per step; tap
 *                the line you think each rule changes
 *
 * Facts: all 10 queue states compile with Zig 0.16 and pass `zig fmt
 * --check`; state 0 drops a transfer on a full queue and state 4 panics
 * (both run). Transfer fields and assertions from tigerbeetle
 * src/tigerbeetle.zig @ 47aeb22; all 16 ts-struct edits compiled with Zig
 * 0.16 to check offsets; the build error is real Zig 0.16 output. Napkin
 * costs are samples.
 */
import { h, s, btn, stepper, range, chips, ask, colorKey, codeBlock, register, clamp, fmt, tween, ease, REDUCED } from './lib.js';

const P = 'v-ts-';

/* ============================================================ TRIPWIRE */

const T = { req: 0.02, val: 0.17, commit: 0.33, A: 0.47, write: 0.55, read: 0.73, B: 0.81, use: 0.97 };
const FAULTS = [
  { id: 'input', at: 'req', label: 'debit = credit', long: 'the client sends debit = credit', tok: 'credit 1' },
  { id: 'bug', at: 'commit', label: 'timestamp = 0', long: 'a bug leaves timestamp = 0', tok: 'ts 0' },
  { id: 'disk', at: 'disk', label: 'bit flip', long: 'the disk flips bit 20 of amount', tok: 'amt 1,049,576' },
];
const STOPS = { val: 'validate', A: 'the assertion before the write', B: 'the assertion after the read', use: 'nowhere: it reaches use' };
const MODES = [[false, false], [true, false], [false, true], [true, true]];

function verdict(f, A, B) {
  if (f === 'input') return { stop: 'val', kind: 'ok', short: 'error code',
    text: 'Bad input is an <b>operating error</b>. <code>validate</code> returns <code>accounts_must_be_different</code>. No assertion fires, and none should.' };
  if (f === 'bug') {
    if (A) return { stop: 'A', kind: 'ok', short: 'stops early',
      text: 'The replica stops before the write, so the bad transfer never reaches disk. <b class="c-safe">A correctness bug became a liveness bug.</b>' };
    if (B) return { stop: 'B', kind: 'late', short: 'late',
      text: 'The bad transfer is written first. <b class="c-bad">Caught, but late</b>: every replica runs the same code, so they may all have written it.' };
    return { stop: 'use', kind: 'bad', short: 'silent', text: '<b class="c-bad">Nothing checks.</b> A transfer with no timestamp is stored and served as if it were correct.' };
  }
  if (B) return { stop: 'B', kind: 'ok', short: 'detected',
    text: 'The checksum no longer matches. Only a check after the read can see damage done at rest. <b class="c-safe">TigerBeetle repairs the block from another replica.</b>' };
  return { stop: 'use', kind: 'bad', short: 'silent',
    text: `${A ? 'The check before the write passed: the data was fine then. ' : ''}<b class="c-bad">Nothing checks after the read</b>, so the replica uses 1,049,576 instead of 1,000.` };
}

function initTripwire(fig, app) {
  const st = { f: 'bug', A: true, B: true, phase: 'done', guess: null };
  const seen = new Set(['bug|3']);
  const prompt = h('div', { class: 'wv-callout', 'aria-live': 'polite' });
  const svg = s('svg', { role: 'group', 'aria-label': 'Lifeline of one transfer with two assertions' });
  const out = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const grid = s('svg', { class: `${P}space`, viewBox: '0 0 420 160', role: 'group', 'aria-label': 'Cases you have tried' });
  const found = h('span');
  app.append(prompt, svg, out,
    h('div', { class: `${P}spacewrap` }, h('div', { class: 'wv-title' }, 'cases you have tried · ', found), grid),
    colorKey([['k-data', 'the transfer (sample values)'], ['k-gap', 'fault or harm'], ['k-safe', 'armed assertion, or caught'], ['k-opt', 'tap to change'], ['k-look', 'your prediction'], ['k-pick', "TigerBeetle's choice"]]));

  let tokT = 1; let cancel = () => {};
  const mode = () => MODES.findIndex(([a, b]) => a === st.A && b === st.B);

  function geom() {
    const W = app.clientWidth || 600;
    if (W < 600) { const x0 = 170; const y0 = 44; const y1 = 590; return { tall: true, Wd: 340, Hd: 624, pt: (t, o = 0) => [x0 + o, y0 + t * (y1 - y0)] }; }
    const x0 = 40; const x1 = 870; const y0 = 132; return { tall: false, Wd: 900, Hd: 262, pt: (t, o = 0) => [x0 + t * (x1 - x0), y0 + o] };
  }

  function draw() {
    const { tall, Wd, Hd, pt } = geom();
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Hd}`);
    const v = verdict(st.f, st.A, st.B);
    const fault = FAULTS.find((x) => x.id === st.f);
    const faultT = fault.at === 'disk' ? (T.write + T.read) / 2 : T[fault.at];
    const done = st.phase === 'done';
    const tt = st.phase === 'predict' ? T.req : T.req + (T[v.stop] - T.req) * tokT;
    const L = (a, b, c, d, cls) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" class="${cls}"/>`;
    const txt = (t, o, str, cls, anchor) => { const [x, y] = pt(t, o); return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${str}</text>`; };
    const lab = tall ? 'start' : 'middle'; const side = tall ? 1 : -1;
    let o = '';
    const harmDisk = done && ((st.f === 'bug' && !st.A) || st.f === 'disk');
    const [bx0, by0] = pt(T.write, -26); const [bx1, by1] = pt(T.read, 26);
    o += `<rect x="${Math.min(bx0, bx1)}" y="${Math.min(by0, by1)}" width="${Math.abs(bx1 - bx0)}" height="${Math.abs(by1 - by0)}" class="${P}disk${harmDisk ? ' is-bad' : ''}"/>`;
    o += txt((T.write + T.read) / 2, tall ? 34 : -34, harmDisk ? 'bad data at rest' : 'disk · at rest', `t-s ${harmDisk ? 't-bad t-b' : 't-mute'}`, lab);
    { const [a, b] = pt(T.req); const [c, d] = pt(T.use); o += L(a, b, c, d, `${P}life`); const [e, f] = pt(Math.max(T.req, tt)); o += L(a, b, e, f, `${P}life is-done`); }
    for (const [id, name] of [['req', 'request'], ['val', 'validate'], ['commit', 'commit'], ['write', 'write'], ['read', 'read'], ['use', 'use']]) {
      const bad = id === 'use' && done && v.kind === 'bad';
      const [a, b] = pt(T[id], -6); const [c, d] = pt(T[id], 6);
      o += L(a, b, c, d, `${P}tick${bad ? ' is-bad' : ''}`);
      o += txt(T[id], side * (tall ? 14 : 16), bad ? 'use · wrong data' : name, `t-s t-b${bad ? ' t-bad' : ''}`, lab);
    }
    if (v.stop === 'val' && done) {
      const [ax, ay] = pt(T.val, tall ? -10 : 10); const [bx, by] = pt(T.req, tall ? -10 : 10);
      o += `<path d="M${ax},${ay} Q${(ax + bx) / 2 + (tall ? -36 : 0)},${(ay + by) / 2 + (tall ? 0 : 36)} ${bx},${by}" class="${P}ret" marker-end="url(#${P}arr)"/>`;
      o += txt((T.val + T.req) / 2, tall ? -40 : 46, 'error code', 't-xs t-safe t-b', tall ? 'end' : 'middle');
    }
    for (const g of ['A', 'B']) {
      const armed = st[g]; const fired = done && v.stop === g;
      const [w0x, w0y] = pt(T[g], tall ? -40 : -64); const [w1x, w1y] = pt(T[g], tall ? 48 : 58);
      o += L(w0x, w0y, w1x, w1y, `${P}wire${armed ? ' is-armed' : ''}${fired ? ' is-fired' : ''}`);
      const [hx, hy] = pt(T[g], tall ? 64 : -80);
      const name = g === 'A' ? 'before write' : 'after read';
      o += `<g class="${P}handle${armed ? ' is-armed' : ''}" data-g="${g}" role="button" tabindex="0" aria-pressed="${armed}" aria-label="assert ${name}: ${armed ? 'armed' : 'off'}"><circle cx="${hx}" cy="${hy}" r="15"/><text x="${hx}" y="${hy + 4}" class="t-xs t-b" text-anchor="middle">${armed ? 'on' : 'off'}</text></g>`;
      o += tall ? `<text x="${hx + 20}" y="${hy - 3}" class="t-xs t-b">assert</text><text x="${hx + 20}" y="${hy + 10}" class="t-xs t-b">${name}</text>` : `<text x="${hx}" y="${hy - 22}" class="t-xs t-b" text-anchor="middle">assert ${name}</text>`;
      if (fired) {
        const ft = v.kind === 'late' ? 'fires, late' : st.f === 'disk' ? 'checksum mismatch' : 'fires · stops';
        const fc = `t-xs t-b ${v.kind === 'late' ? 't-bad' : 't-safe'}`;
        o += tall ? `<text x="${hx + 20}" y="${hy + 24}" class="${fc}">${ft}</text>` : txt(T[g], 72, ft, fc, 'middle');
      }
    }
    for (const f of FAULTS) {
      const t = f.at === 'disk' ? (T.write + T.read) / 2 : T[f.at];
      const [mx, my] = pt(t, tall ? -40 : 44); const sel = f.id === st.f;
      o += `<g class="${P}fault${sel ? ' is-sel' : ''}" data-f="${f.id}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="inject: ${f.long}"><rect x="${mx - 8}" y="${my - 8}" width="16" height="16" transform="rotate(45 ${mx} ${my})"/>`;
      o += tall ? `<text x="${mx - 16}" y="${my + 4}" class="t-xs t-bad" text-anchor="end">${f.label}</text></g>` : `<text x="${mx}" y="${my + 26}" class="t-xs t-bad" text-anchor="middle">${f.label}</text></g>`;
    }
    if (st.phase === 'predict') {
      for (const id of ['val', 'A', 'B', 'use']) {
        const [qx, qy] = pt(T[id], 0);
        o += `<g class="${P}guess" data-q="${id}" role="button" tabindex="0" aria-label="predict: it stops at ${STOPS[id]}"><circle cx="${qx}" cy="${qy}" r="13"/><text x="${qx}" y="${qy + 4.5}" class="t-m t-b" text-anchor="middle">?</text></g>`;
      }
    } else {
      const [kx, ky] = pt(tt, 0); const hurt = tt >= faultT - 0.001;
      o += `<g class="${P}tok${hurt ? ' is-bad' : ''}"><rect x="${kx - (tall ? 10 : 42)}" y="${ky - (tall ? 20 : 11)}" width="${tall ? 20 : 84}" height="${tall ? 40 : 22}"/>${tall ? '' : `<text x="${kx}" y="${ky + 4}" class="t-xs t-b ${hurt ? 't-bad' : 't-data'}" text-anchor="middle">${hurt ? fault.tok : 'transfer 7'}</text>`}</g>`;
      if (tall) o += `<text x="${kx - 16}" y="${ky + 4}" class="t-xs t-b ${hurt ? 't-bad' : 't-data'} halo" text-anchor="end">${hurt ? fault.tok : 'transfer 7'}</text>`;
    }
    svg.innerHTML = `<defs><marker id="${P}arr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" style="fill:var(--green)"/></marker></defs>${o}`;

    if (st.phase === 'predict') {
      prompt.innerHTML = `<b>${fault.long[0].toUpperCase()}${fault.long.slice(1)}</b>, with the assertion before the write <b>${st.A ? 'on' : 'off'}</b> and after the read <b>${st.B ? 'on' : 'off'}</b>. Where does the transfer stop? Tap a <b class="c-look">?</b> on the line.`;
      prompt.append(' ', btn('just run it', () => run(null)));
      out.hidden = true;
    } else {
      prompt.innerHTML = 'Tap a red <b class="c-bad">fault</b> to inject it, or an <b class="c-opt">on/off</b> switch to arm or disarm an assertion. Then predict where the transfer stops.';
      const g = st.guess ? (st.guess === v.stop ? `<b class="c-safe">You said ${STOPS[st.guess]}. Right.</b> ` : `<b class="c-bad">You said ${STOPS[st.guess]}.</b> It stops at ${STOPS[v.stop]}. `) : '';
      out.hidden = !done;
      out.className = `wv-note ${v.kind === 'ok' ? 'is-good' : 'is-bad'}`;
      out.innerHTML = g + v.text;
    }
    drawSpace();
  }

  function drawSpace() {
    let o = '';
    const cx = (j) => 160 + j * 66; const cy = (i) => 60 + i * 34;
    MODES.forEach(([a, b], j) => {
      for (const [k2, on] of [[0, a], [1, b]]) o += `<line x1="${cx(j) - 6 + k2 * 12}" x2="${cx(j) - 6 + k2 * 12}" y1="14" y2="34" class="${P}wire${on ? ' is-armed' : ''} is-mini"/>`;
    });
    o += `<text x="${cx(0) - 26}" y="28" class="t-xs t-mute" text-anchor="end">before · after</text>`;
    if (FAULTS.every((f) => seen.has(`${f.id}|3`))) o += `<rect x="${cx(3) - 30}" y="6" width="60" height="${cy(2) + 20 - 6}" class="${P}pickbox"/><text x="${cx(3)}" y="${cy(2) + 34}" class="t-xs t-pick t-b" text-anchor="middle">TigerBeetle</text>`;
    FAULTS.forEach((f, i) => {
      o += `<text x="${cx(0) - 26}" y="${cy(i) + 4}" class="t-xs" text-anchor="end">${f.label}</text>`;
      MODES.forEach(([a, b], j) => {
        const v = verdict(f.id, a, b); const known = seen.has(`${f.id}|${j}`);
        const cur = f.id === st.f && j === mode();
        o += `<g class="${P}cell ${known ? `is-${v.kind}` : 'is-unknown'}${cur ? ' is-cur' : ''}" data-f="${f.id}" data-m="${j}" role="button" tabindex="0" aria-label="${f.long}; before write ${a ? 'on' : 'off'}, after read ${b ? 'on' : 'off'}: ${known ? v.short : 'not tried yet'}"><circle cx="${cx(j)}" cy="${cy(i)}" r="10"/><text x="${cx(j)}" y="${cy(i) + (known ? 22 : 4)}" class="t-xs ${known ? (v.kind === 'ok' ? 't-safe' : 't-bad') : 't-mute t-b'}" text-anchor="middle">${known ? v.short : '?'}</text></g>`;
      });
    });
    grid.innerHTML = o;
    found.textContent = `${seen.size} of 12`;
  }

  function setCase(f, A, B) { st.f = f; st.A = A; st.B = B; st.phase = 'predict'; st.guess = null; cancel(); draw(); }
  function run(guess) {
    st.guess = guess; st.phase = 'run'; tokT = 0; cancel();
    cancel = tween(REDUCED ? 0 : 1400, (t) => { tokT = ease(t); draw(); }, () => { tokT = 1; st.phase = 'done'; seen.add(`${st.f}|${mode()}`); draw(); });
  }
  function act(e) {
    const hnd = e.target.closest(`.${P}handle`); const flt = e.target.closest(`.${P}fault`); const cell = e.target.closest(`.${P}cell`); const q = e.target.closest(`.${P}guess`);
    if (st.phase === 'run') return;
    if (q) run(q.dataset.q);
    else if (hnd) setCase(st.f, hnd.dataset.g === 'A' ? !st.A : st.A, hnd.dataset.g === 'B' ? !st.B : st.B);
    else if (flt) setCase(flt.dataset.f, st.A, st.B);
    else if (cell) { const [a, b] = MODES[+cell.dataset.m]; setCase(cell.dataset.f, a, b); }
  }
  for (const el of [svg, grid]) {
    el.addEventListener('click', act);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { act(e); e.preventDefault(); } });
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* ============================================================== STRUCT */

const TYPES = { u128: 16, u64: 8, u32: 4, u16: 2, u8: 1, TransferFlags: 2 };
const BASE = [
  ['id', 'u128'], ['debit_account_id', 'u128'], ['credit_account_id', 'u128'], ['amount', 'u128'],
  ['pending_id', 'u128'], ['user_data_128', 'u128'], ['user_data_64', 'u64'], ['user_data_32', 'u32'],
  ['timeout', 'u32'], ['ledger', 'u32'], ['code', 'u16'], ['flags', 'TransferFlags'], ['timestamp', 'u64'],
];
function fieldsOf(E) {
  let f = BASE.map(([n, t]) => [n, (n === 'amount' && E.amount) || (n === 'timeout' && E.timeout) ? 'u64' : t]);
  if (E.move) { const ts = f.pop(); f.splice(8, 0, ts); }
  if (E.add) f = [...f, ['user_data_8', 'u8']];
  return f;
}
function layout(fields) {
  const items = []; let off = 0; let al = 1;
  for (const [name, type] of fields) {
    const sz = TYPES[type]; al = Math.max(al, sz);
    if (off % sz) { const pad = sz - (off % sz); items.push({ pad: true, off, size: pad }); off += pad; }
    items.push({ name, type, off, size: sz }); off += sz;
  }
  const size = Math.ceil(off / al) * al;
  if (size > off) items.push({ pad: true, off, size: size - off });
  return { items, size, align: al, padBytes: items.filter((i) => i.pad).reduce((a, i) => a + i.size, 0) };
}
const CHECKS = [
  ['no_padding', 'assert(stdx.no_padding(Transfer));', (L) => L.padBytes === 0, (L) => `${L.padBytes} B of padding`],
  ['@sizeOf', 'assert(@sizeOf(Transfer) == 128);', (L) => L.size === 128, (L) => `size is ${L.size}`],
  ['@alignOf', 'assert(@alignOf(Transfer) == 16);', (L) => L.align === 16, (L) => `align is ${L.align}`],
];
const EDITS = [['amount', 'amount: u64'], ['timeout', 'timeout: u64'], ['move', 'move timestamp up'], ['add', '+ user_data_8: u8']];

function initStruct(fig, app) {
  const E = { amount: false, timeout: false, move: false, add: false };
  let built = { ...E };
  const edits = chips(EDITS, (vals) => { Object.keys(E).forEach((k) => { E[k] = vals.includes(k); }); edited(); }, { multi: true, value: [], label: 'Edits to Transfer' });
  const code = h('div');
  const map = h('div', { class: `${P}bytes`, role: 'img' });
  const buildBox = h('div');
  const why = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  app.append(
    h('div', { class: 'wv-title', style: 'margin-bottom:.4rem' }, 'Edit the struct'), edits.el,
    h('div', { class: 'wv-split' },
      h('div', null, h('div', { class: 'wv-title', style: 'margin-bottom:.35rem' }, 'transfer.zig · abridged'), code),
      h('div', null, h('div', { class: 'wv-title', style: 'margin-bottom:.35rem' }, 'bytes, 16 per row · from the last build'), map, buildBox)),
    why,
    colorKey([['k-data', 'field bytes'], ['k-gap', 'padding, or a failing assertion'], ['k-safe', 'assertion holds'], ['k-look', 'your edit'], ['k-opt', 'edits to try']]));

  function showCode(dirty) {
    const f = fieldsOf(E); const LB = layout(fieldsOf(built));
    const first = CHECKS.findIndex(([, , ok]) => !ok(LB));
    const lines = ['pub const Transfer = extern struct {']; const hot = [];
    for (const [n, t] of f) {
      if ((n === 'amount' && E.amount) || (n === 'timeout' && E.timeout) || (n === 'timestamp' && E.move) || n === 'user_data_8') hot.push(lines.length);
      lines.push(`    ${n}: «${t}»,`);
    }
    lines.push('', '    comptime {');
    CHECKS.forEach(([, c, ok, w], k) => {
      if (dirty) { lines.push(`        ${c}`); return; }
      const pass = ok(LB);
      const note = first >= 0 && k > first ? '// not reached' : pass ? '// ⟪holds⟫' : '// ⟦fails⟧';
      lines.push(`        ${c} ${note}`);
    });
    lines.push('    }', '};');
    code.innerHTML = codeBlock(lines, hot);
    return { LB, first };
  }

  function showMap(LB, dirty) {
    let o = '';
    for (let r = 0; r < LB.size / 16; r++) o += `<span class="${P}off${r >= 8 ? ' is-over' : ''}" style="grid-row:${r + 1}">${r * 16}</span>`;
    for (const it of LB.items) {
      let off = it.off; let left = it.size;
      while (left > 0) {
        const r = Math.floor(off / 16); const c = off % 16; const w = Math.min(left, 16 - c);
        o += `<span class="${it.pad ? `${P}pad` : `${P}fld`}${r >= 8 ? ' is-over' : ''}" style="grid-row:${r + 1};grid-column:${c + 2} / span ${w}" title="${it.pad ? 'padding' : `${it.name}: ${it.type}`}, ${w} B at ${off}">${it.pad ? (w >= 3 ? 'pad' : '') : off === it.off ? it.name : ''}</span>`;
        off += w; left -= w;
      }
    }
    map.innerHTML = o;
    map.classList.toggle('is-stale', dirty);
    map.setAttribute('aria-label', `${LB.size} bytes, ${LB.padBytes} bytes of padding`);
  }

  function buildOutput(LB, first, assertLine) {
    if (first < 0) return codeBlock(['$ zig build', '⟪(no output: all three assertions hold)⟫']);
    const c = CHECKS[first][1];
    return codeBlock(['$ zig build', '⟦lib/std/debug.zig:420:14: error: reached unreachable code⟧', '    if (!ok) unreachable; // assertion failure', '             ^~~~~~~~~~~',
      `transfer.zig:${assertLine}:15: note: called at comptime here`, `        ${c}`, `        ~~~~~~^${'~'.repeat(c.length - 8)}`], [5]);
  }

  function reason(B, LB) {
    const shipped = !B.amount && !B.timeout && !B.move && !B.add;
    if (shipped) return ['is-good', 'Six <code>u128</code> fields fill the first six rows, and the small fields pack the last two with no gap.'];
    if (B.amount && !B.timeout && !B.move && !B.add) return ['is-bad', '<code>pending_id</code> must start at a multiple of 16, so <b class="c-bad">8 bytes of padding</b> follow <code>amount</code>. The size is still 128, so <b>only <code>no_padding</code> catches it</b>. No field sets those bytes, so they can carry old memory into a checksum or onto the network: a buffer bleed.'];
    return ['is-bad', `Each field starts at a multiple of its own size, and the total rounds up to a multiple of 16: <b class="c-bad">${LB.size} bytes, ${LB.padBytes} of them padding</b>. The build stops at the first failing assertion, before any test runs.`];
  }

  function doBuild() {
    built = { ...E };
    const { LB, first } = showCode(false);
    showMap(LB, false);
    const [tone, text] = reason(built, LB);
    why.className = `wv-note ${tone}`; why.innerHTML = text;
    return { LB, first, line: f2line(first) };
  }
  const f2line = (first) => (first < 0 ? 0 : fieldsOf(E).length + 4 + first);

  function edited() {
    const { LB } = showCode(true);
    showMap(LB, true);
    const Lnew = layout(fieldsOf(E));
    const firstNew = CHECKS.findIndex(([, , ok]) => !ok(Lnew));
    const answer = firstNew < 0 ? 'none' : CHECKS[firstNew][0];
    const q = ask('Before you build: which assertion stops zig build?',
      [['none', 'none, it builds'], ...CHECKS.map(([id]) => [id, id])], answer,
      (v, right) => { const r = doBuild(); skip.remove(); return `${right ? '<b class="c-safe">Right.</b>' : `<b class="c-bad">It is ${answer === 'none' ? 'none: it builds' : answer}.</b>`}${buildOutput(r.LB, r.first, r.line)}`; });
    const skip = btn('build without guessing', () => { const r = doBuild(); buildBox.innerHTML = buildOutput(r.LB, r.first, r.line); });
    buildBox.replaceChildren(q.el, skip);
    why.className = 'wv-note'; why.innerHTML = 'Edited, not built. The byte map still shows the last build.';
  }

  const r0 = doBuild();
  buildBox.innerHTML = buildOutput(r0.LB, r0.first, r0.line);
}

/* ============================================================== NAPKIN */

const NET_RTT = 500e-6; const NET_BW = 1.25e9; const DISK_BW = 2e9;
const MISS = 100e-9; const MEM_BW = 20e9; const CPU = 100e-9; const SIZE = 128; const NMAX = 8189;
const RES = ['network', 'disk', 'memory', 'CPU'];

function tfmt(sec) {
  if (sec >= 1e-3) return `${+(sec * 1e3).toPrecision(2)} ms`;
  if (sec >= 1e-6) return `${+(sec * 1e6).toPrecision(3)} µs`;
  return `${+(sec * 1e9).toPrecision(3)} ns`;
}
function costs(n, fs, m) {
  return [NET_RTT / n + SIZE / NET_BW, fs / n + SIZE / DISK_BW, m * MISS + SIZE / MEM_BW, CPU].map((t, i) => ({ id: RES[i], t }));
}
/* fs/n + 128/disk_bw = m·MISS + 128/mem_bw  →  n = fs / (m·MISS + 128/mem_bw − 128/disk_bw) */
function crossover(fs, m) { const d = m * MISS + SIZE / MEM_BW - SIZE / DISK_BW; return d > 0 ? Math.round(fs / d) : Infinity; }

function initNapkin(fig, app) {
  const S = { n: NMAX, fs: 1e-3, m: 4 };
  let shown = false;
  const logv = (t, lo, hi) => lo * (hi / lo) ** (t / 1000);
  const logt = (v, lo, hi) => Math.round((Math.log(v / lo) / Math.log(hi / lo)) * 1000);
  const nOf = (t) => clamp(Math.round(logv(t, 1, NMAX)), 1, NMAX);
  const fsOf = (t) => +logv(t, 20e-6, 10e-3).toPrecision(2);
  const rn = range('transfers per batch', { min: 0, max: 1000, value: 1000, fmt: (t) => fmt(nOf(t)), oninput: (t) => { S.n = nOf(t); draw(); } });
  const rf = range('fsync', { min: 0, max: 1000, value: logt(1e-3, 20e-6, 10e-3), fmt: (t) => tfmt(fsOf(t)), oninput: (t) => { S.fs = fsOf(t); draw(); } });
  const rm = range('cache misses per transfer', { min: 1, max: 16, value: 4, oninput: (v) => { S.m = v; draw(); } });
  const q = ask('A batch of 8,189 transfers pays one 500 µs round trip and one 1 ms fsync, shared by every transfer in it. Each transfer also pays 4 cache misses of 100 ns and 100 ns of CPU. Which costs the most per transfer?',
    RES.map((r) => [r, r]), 'memory',
    (v, right) => { shown = true; controls.hidden = false; draw(); return right ? '<b>Right.</b> The fsync and the round trip are shared by 8,189 transfers; the cache misses are paid by each one.' : `<b>It is memory</b>, not ${v}. The fsync and the round trip are shared by 8,189 transfers; the cache misses are paid by each one.`; });
  const controls = h('div', { class: 'wv-grid-ctrl' }, rn.el, rf.el, rm.el);
  controls.hidden = true;
  const svg = s('svg', { class: `${P}chart`, role: 'img', 'aria-label': 'Per-transfer cost of each resource as the batch grows' });
  const read = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  read.hidden = true;
  app.append(q.el, controls, svg, read,
    colorKey([['k-line-ink', 'cost per transfer, by resource'], ['k-look', 'the largest cost'], ['k-opt', 'your batch size and inputs'], ['k-data', 'sample numbers']]));

  let G = null;
  function draw() {
    const Wd = Math.max(300, app.clientWidth);
    const Ht = clamp(Math.round(Wd * 0.46), 250, 340);
    const m = { l: 50, r: Wd < 520 ? 40 : 130, t: 16, b: 30 };
    const X1 = Math.log10(NMAX);
    const x = (n) => m.l + (Math.log10(n) / X1) * (Wd - m.l - m.r);
    const y = (t) => m.t + ((-2 - Math.log10(clamp(t, 1e-8, 1e-2))) / 6) * (Ht - m.t - m.b);
    G = { m, Wd, X1 };
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    let o = '';
    for (let e = -8; e <= -2; e++) {
      o += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" class="rule"/>`;
      o += `<text x="${m.l - 6}" y="${y(10 ** e) + 3.5}" class="t-xs t-mute" text-anchor="end">${tfmt(10 ** e)}</text>`;
    }
    for (const n of [1, 10, 100, 1000, NMAX]) o += `<text x="${x(n)}" y="${Ht - m.b + 14}" class="t-xs t-mute" text-anchor="${n === 1 ? 'start' : 'middle'}">${fmt(n)}</text>`;
    o += `<text x="${Wd - m.r}" y="${Ht - 2}" class="t-xs t-mute" text-anchor="end">transfers per batch →</text>`;
    o += `<rect x="${m.l}" y="${m.t}" width="${Wd - m.l - m.r}" height="${Ht - m.t - m.b}" class="rule-ink"/>`;
    if (!shown) {
      o += `<text x="${(m.l + Wd - m.r) / 2}" y="${Ht / 2}" class="t-s t-mute" text-anchor="middle">answer first</text>`;
      svg.innerHTML = o; return;
    }
    const cs = costs(S.n, S.fs, S.m);
    const top = cs.reduce((a, b) => (b.t > a.t ? b : a));
    const ns = []; for (let k = 0; k <= 120; k++) ns.push(10 ** ((k / 120) * X1));
    const DASH = ['7 4', '', '2 3', '10 3 2 3'];
    cs.forEach((c, k) => {
      o += `<polyline points="${ns.map((n) => `${x(n).toFixed(1)},${y(costs(n, S.fs, S.m)[k].t).toFixed(1)}`).join(' ')}" class="${P}curve${c.id === top.id ? ' is-hot' : ''}" style="${DASH[k] ? `stroke-dasharray:${DASH[k]}` : ''}"/>`;
    });
    const dm = crossover(S.fs, S.m);
    if (dm >= 1 && dm <= NMAX) {
      const cy = y(costs(dm, S.fs, S.m)[1].t); const by = Ht - m.b - 8;
      o += `<line x1="${x(dm)}" x2="${x(dm)}" y1="${cy}" y2="${by + 2}" class="edge-ctl"/><circle cx="${x(dm)}" cy="${cy}" r="3.5" style="fill:var(--ink)"/>`;
      o += `<text x="${x(dm) - 6}" y="${by}" class="t-xs halo" text-anchor="end">disk = memory at ${fmt(dm)}</text>`;
    }
    const cx = x(S.n);
    o += `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${Ht - m.b}" class="${P}cursor"/>`;
    const labs = cs.map((c) => ({ ...c, y: y(c.t) })).sort((a, b) => a.y - b.y);
    labs[0].ly = labs[0].y;
    for (let i = 1; i < labs.length; i++) labs[i].ly = Math.max(labs[i].y, labs[i - 1].ly + 13);
    const right = cx + 125 < Wd;
    for (const c of labs) {
      const hot = c.id === top.id;
      o += `<circle cx="${cx}" cy="${c.y}" r="${hot ? 4.5 : 3}" class="${P}dot${hot ? ' is-hot' : ''}"/>`;
      o += `<text x="${right ? cx + 8 : cx - 8}" y="${c.ly + 4}" class="t-xs t-b halo${hot ? ' t-look' : ''}" text-anchor="${right ? 'start' : 'end'}">${c.id} ${tfmt(c.t)}</text>`;
    }
    o += `<text x="${clamp(cx, m.l + 30, Wd - m.r - 30)}" y="${m.t - 4}" class="t-xs t-b halo" style="fill:var(--blue)" text-anchor="middle">n = ${fmt(S.n)}</text>`;
    svg.innerHTML = o;
    const total = cs.reduce((a, c) => a + c.t, 0);
    read.hidden = false;
    read.innerHTML = `At <b class="c-data">${fmt(S.n)}</b> per batch, <b class="c-look">${top.id}</b> costs the most: <b class="c-data">${tfmt(top.t)}</b> of <b class="c-data">${tfmt(total)}</b> per transfer, about <b class="c-data">${fmt(+(1 / total).toPrecision(2))}</b> transfers/s one batch at a time. One fsync costs as much as <b class="c-data">${fmt(S.fs / MISS)}</b> cache misses${dm <= NMAX ? `, but the batch shares it, so from about <b class="c-data">${fmt(dm)}</b> per batch the ${S.m} miss${S.m > 1 ? 'es' : ''} per transfer cost more.` : `. Even at ${fmt(NMAX)} per batch, the fsync share costs more than the misses.`}`;
  }

  let dragging = false;
  const fromX = (e) => {
    if (!shown) return;
    const b = svg.getBoundingClientRect();
    const t = clamp((((e.clientX - b.left) / b.width) * G.Wd - G.m.l) / (G.Wd - G.m.l - G.m.r), 0, 1);
    rn.set(Math.round(t * 1000));
  };
  svg.addEventListener('pointerdown', (e) => { if (!shown) return; dragging = true; svg.setPointerCapture(e.pointerId); fromX(e); });
  svg.addEventListener('pointermove', (e) => { if (dragging) fromX(e); });
  svg.addEventListener('pointerup', () => { dragging = false; });
  svg.addEventListener('pointercancel', () => { dragging = false; });
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* =============================================================== QUEUE */

/* Rows aligned to the final layout: [[fromStep, text|null], …]. Generated
   from the compiled states; state k = every row's text at step k. */
const HERO_ROWS = [
  [[0, null], [9, "/// A queue of transfers with a fixed capacity, allocated once at startup."]],
  [[0, "pub fn TransferQueue(comptime max_capacity: usize) type {"], [3, "pub fn TransferQueue(comptime max_capacity: u32) type {"], [8, "pub fn TransferQueue(comptime capacity_max: u32) type {"]],
  [[0, null], [2, "    comptime {"]],
  [[0, null], [2, "        assert(max_capacity > 0);"], [8, "        assert(capacity_max > 0);"]],
  [[0, null], [2, "        assert(max_capacity <= 8189);"], [8, "        assert(capacity_max <= 8189);"], [9, "        assert(capacity_max <= 8189); // One create_transfers batch."]],
  [[0, null], [2, "    }"]],
  [[0, "    return struct {"]],
  [[0, "        const Queue = @This();"]],
  [[0, ""]],
  [[0, "        buffer: []Transfer,"], [1, "        buffer: [max_capacity]Transfer = undefined,"], [8, "        buffer: [capacity_max]Transfer = undefined,"]],
  [[0, "        head: usize = 0,"], [3, "        head: u32 = 0,"], [8, "        head_index: u32 = 0,"]],
  [[0, "        len: usize = 0,"], [3, "        len: u32 = 0,"], [8, "        count: u32 = 0,"]],
  [[0, ""]],
  [[0, null], [9, "        /// The caller checks for space first, so a full queue here is a bug."]],
  [[0, "        pub fn push(queue: *Queue, transfer: Transfer) bool {"], [4, "        pub fn push(queue: *Queue, transfer: Transfer) void {"], [7, "        pub fn push(queue: *Queue, transfer: *const Transfer) void {"]],
  [[0, "            if (queue.len == max_capacity) return false;"], [4, "            assert(queue.len < max_capacity);"], [8, "            assert(queue.count < capacity_max);"]],
  [[0, null], [5, "            assert(transfer.id != 0);"]],
  [[0, null], [5, "            assert(transfer.timestamp == 0);"], [9, "            assert(transfer.timestamp == 0); // Set by the cluster, not the client."]],
  [[0, null], [5, ""]],
  [[0, "            const i = (queue.head + queue.len) % max_capacity;"], [8, "            const index = (queue.head_index + queue.count) % capacity_max;"]],
  [[0, "            queue.buffer[i] = transfer;"], [7, "            queue.buffer[i] = transfer.*;"], [8, "            queue.buffer[index] = transfer.*;"]],
  [[0, "            queue.len += 1;"], [8, "            queue.count += 1;"]],
  [[0, "            return true;"], [4, null], [5, "            assert(queue.len <= max_capacity);"], [8, "            assert(queue.count <= capacity_max);"]],
  [[0, "        }"]],
  [[0, ""]],
  [[0, null], [9, "        /// One check for the whole batch, then one push per transfer."]],
  [[0, "        pub fn push_batch(queue: *Queue, transfers: []const Transfer) void {"]],
  [[0, null], [6, "            assert(transfers.len <= max_capacity - queue.len);"], [8, "            assert(transfers.len <= capacity_max - queue.count);"]],
  [[0, "            for (transfers) |transfer| _ = queue.push(transfer);"], [4, "            for (transfers) |transfer| queue.push(transfer);"], [7, "            for (transfers) |*transfer| queue.push(transfer);"]],
  [[0, "        }"]],
  [[0, "    };"]],
  [[0, "}"]],
];
const STEPS = [
  { label: 'before', goal: null, rule: '', why: 'Ordinary code for a fixed-size queue. Nine rules follow, one per step.' },
  { label: 'memory', goal: 'safety', rule: 'Allocate all memory at startup.', why: 'The buffer becomes a fixed array inside the queue. Nothing allocates after startup, and the queue can never grow.' },
  { label: 'limits', goal: 'safety', rule: 'Put a limit on everything.', why: 'The build now fails if the capacity is 0 or larger than one <code>create_transfers</code> batch of 8,189.' },
  { label: 'sized types', goal: 'safety', rule: 'Use explicitly sized types.', why: '<code>u32</code>, not <code>usize</code>: the same size on every machine.' },
  { label: 'full = bug', goal: 'safety', rule: 'A full queue is a bug, so assert it.', why: 'Before, <code>push_batch</code> threw the <code>bool</code> away, so a full queue <b class="c-bad">dropped a transfer without a word</b>. Now the replica stops. We ran both: the old code lost the second transfer, the new code panics.' },
  { label: 'pre/post', goal: 'safety', rule: 'Assert arguments and postconditions.', why: '<code>push</code> no longer trusts its input, and it checks its own result.' },
  { label: 'batch', goal: 'performance', rule: 'Batch: check once per batch.', why: 'One assertion guards the whole batch before the loop, so the loop itself stays simple.' },
  { label: '*const', goal: 'developer experience', rule: 'Pass large arguments by *const.', why: 'A <code>Transfer</code> is 128 bytes. With <code>*const</code>, no call can copy it onto the stack by accident, and the loop takes a pointer to each element.' },
  { label: 'names', goal: 'developer experience', rule: 'Get the nouns right.', why: 'Qualifiers go last: <code>capacity_max</code>. An index and a count get names that say which, so <code>head_index + count</code> reads as a position.' },
  { label: 'say why', goal: 'developer experience', rule: 'Always say why.', why: 'The comments give reasons the code cannot: why a full queue is a bug, where 8,189 comes from, who sets the timestamp.' },
];
const rowAt = (row, k) => { let v = null; for (const [st, t] of row) if (st <= k) v = t; return v; };

function initQueue(fig, app) {
  const N = STEPS.length - 1;
  const meter = h('div', { class: `${P}meter`, 'aria-label': 'Rules applied, by goal' });
  const ruleBox = h('div', { class: 'wv-callout', 'aria-live': 'polite' });
  const code = h('div', { class: `${P}code` });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  let k = 0; let map = []; let flash = null;

  const changed = (step) => HERO_ROWS.map((r, i) => (rowAt(r, step) !== rowAt(r, step - 1) ? i : -1)).filter((i) => i >= 0);
  function targets(step) {
    const out = new Set();
    for (const i of changed(step)) {
      if (rowAt(HERO_ROWS[i], step - 1) !== null) { out.add(i); continue; }
      for (let j = i - 1; j >= 0; j--) if (rowAt(HERO_ROWS[j], step - 1) !== null) { out.add(j); break; }
      for (let j = i + 1; j < HERO_ROWS.length; j++) if (rowAt(HERO_ROWS[j], step - 1) !== null) { out.add(j); break; }
    }
    return out;
  }

  function render(i) {
    k = i; flash = null;
    map = HERO_ROWS.map((r, j) => [j, rowAt(r, i)]).filter(([, t]) => t !== null);
    const hot = new Set(i > 0 ? changed(i) : []);
    code.innerHTML = codeBlock(map.map(([, t]) => t), map.map(([j], n) => (hot.has(j) ? n : -1)).filter((n) => n >= 0));
    code.querySelectorAll('.ln').forEach((el) => { el.setAttribute('role', i < N ? 'button' : 'presentation'); el.tabIndex = i < N ? 0 : -1; });
    const goals = ['safety', 'performance', 'developer experience'];
    meter.innerHTML = goals.map((g, gi) => `<span><b>${gi + 1}</b> ${g} ${STEPS.map((st, j) => (st.goal === g ? `<i class="${j <= i ? 'is-on' : ''}"></i>` : '')).join('')}</span>`).join('');
    note.className = `wv-note${i > 0 ? ' is-good' : ''}`;
    note.innerHTML = i > 0 ? `<span class="k">rule ${i}</span>${STEPS[i].why}` : STEPS[0].why;
    ruleBox.innerHTML = i < N
      ? `<span class="wv-tag">${STEPS[i + 1].goal}</span> Next rule: <b>${STEPS[i + 1].rule}</b> Tap the line you think it changes, or press Next.`
      : 'All nine applied: <b>five for safety, one for performance, three for developer experience</b>, in that order. Tap <b>before</b> to compare.';
  }
  const stp = stepper(fig, STEPS, render, { interval: 3600 });
  app.append(stp.el, meter, ruleBox, code, note,
    colorKey([['k-look', 'lines the last rule changed'], ['k-gap', 'a wrong guess'], ['k-safe', 'rules applied'], ['k-opt', 'steps you can take']]));

  function tap(n) {
    if (k >= N) return;
    const row = map[n]?.[0];
    if (row == null) return;
    if (targets(k + 1).has(row)) { stp.go(k + 1); return; }
    const el = code.querySelectorAll('.ln')[n];
    el.classList.add('is-miss'); flash = n;
    ruleBox.lastChild.textContent = ' Not that line. Try again, or press Next.';
    setTimeout(() => { if (flash === n) el.classList.remove('is-miss'); }, 900);
  }
  code.addEventListener('click', (e) => { const ln = e.target.closest('.ln'); if (ln) tap([...code.querySelectorAll('.ln')].indexOf(ln)); });
  code.addEventListener('keydown', (e) => {
    const ln = e.target.closest('.ln');
    if (ln && (e.key === 'Enter' || e.key === ' ')) { tap([...code.querySelectorAll('.ln')].indexOf(ln)); e.preventDefault(); e.stopPropagation(); }
  });
  stp.go(0);
}

register({ 'ts-tripwire': initTripwire, 'ts-struct': initStruct, 'ts-napkin': initNapkin, 'ts-queue': initQueue });

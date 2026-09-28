/*
 * viz/the-tiger-style — figures for "The Tiger Style".
 *
 * Every figure is a pane of Zig source on the dark tiger page, and each one
 * asks the reader to do something before it shows the answer:
 *
 *   ts-hero      ordinary code → Tiger Style, one rule per step. The reader
 *                taps the line they think the rule changes, then sees the
 *                diff. A goal meter fills in order: safety, performance, DX.
 *   ts-tripwire  one transfer, three faults, two assertions. The reader
 *                predicts where it stops, then watches, and fills in the
 *                12-case grid by trying cases.
 *   ts-napkin    guess which resource costs most per transfer at 8,189 per
 *                batch, then explore the sketch.
 *   ts-struct    edit the 128-byte Transfer, predict which assertion stops
 *                `zig build`, then build.
 *
 * Facts: all 10 hero states compile with Zig 0.16 and pass `zig fmt
 * --check`; state 0 drops a transfer on a full queue and state 4 panics
 * (both run). Transfer fields and assertions from tigerbeetle
 * src/tigerbeetle.zig @ 47aeb22; all 16 ts-struct edits compiled with Zig
 * 0.16 to check offsets. Napkin costs are samples.
 */
import { h, s, register, clamp, fmt, tween, ease, REDUCED } from './lib.js';

const P = 'v-ts-';

function key(items) {
  return h('div', { class: `${P}key` }, ...items.map(([k, label]) => h('span', null, h('i', { class: `${P}k ${P}k--${k}` }), label)));
}
function btn(label, onclick, cls = '') {
  return h('button', { type: 'button', class: `${P}btn ${cls}`.trim(), onclick }, label);
}
const escH = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Leading spaces become padding, so a wrapped line keeps its indent. */
function indentStyle(raw) { const n = raw.length - raw.trimStart().length; return `padding-left:calc(${n}ch + 2.5ch);text-indent:-2.5ch`; }

function hiZig(line) {
  let t = escH(line);
  const c = t.indexOf('//');
  let tail = '';
  if (c >= 0) { tail = `<span class="${P}cm">${t.slice(c)}</span>`; t = t.slice(0, c); }
  t = t.replace(/\b(assert)\(/g, `<span class="${P}as">$1</span>(`)
    .replace(/\b(pub|fn|const|return|struct|comptime|for|type|void|bool|undefined|if|true|false)\b/g, `<span class="${P}kw">$1</span>`)
    .replace(/\b(u32|u64|u128|u16|u8|usize)\b/g, `<span class="${P}ty">$1</span>`)
    .replace(/\b(\d+)\b/g, `<span class="${P}nu">$1</span>`);
  return t + tail;
}

/* ================================================================ HERO */

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
  null,
  { goal: 'safety', rule: 'Allocate all memory at startup.', why: 'The buffer becomes a fixed array inside the queue. Nothing allocates after startup, and the queue can never grow.' },
  { goal: 'safety', rule: 'Put a limit on everything.', why: 'The build now fails if the capacity is 0 or larger than one <code>create_transfers</code> batch of 8,189.' },
  { goal: 'safety', rule: 'Use explicitly sized types.', why: '<code>u32</code>, not <code>usize</code>: the same size on every machine.' },
  { goal: 'safety', rule: 'A full queue is a bug, so assert it.', why: 'Before, <code>push_batch</code> threw the <code>bool</code> away, so a full queue <b class="c-bad">dropped a transfer without a word</b>. Now the replica stops. We ran both: the old code lost the second transfer, the new code panics.' },
  { goal: 'safety', rule: 'Assert arguments and postconditions.', why: '<code>push</code> no longer trusts its input, and it checks its own result.' },
  { goal: 'perf', rule: 'Batch: check once per batch.', why: 'One assertion guards the whole batch before the loop, so the loop itself stays simple.' },
  { goal: 'dx', rule: 'Pass large arguments by *const.', why: 'A <code>Transfer</code> is 128 bytes. With <code>*const</code>, no call can copy it onto the stack by accident, and the loop takes a pointer to each element.' },
  { goal: 'dx', rule: 'Get the nouns right.', why: 'Qualifiers go last: <code>capacity_max</code>. An index and a count get names that say which, so <code>head_index + count</code> reads as a position.' },
  { goal: 'dx', rule: 'Always say why.', why: 'The comments give reasons the code cannot: why a full queue is a bug, where 8,189 comes from, who sets the timestamp.' },
];
const GOALS = [['safety', 'safety'], ['perf', 'performance'], ['dx', 'developer experience']];
const rowAt = (row, k) => { let v = null; for (const [st, t] of row) if (st <= k) v = t; return v; };

function initHero(fig, app) {
  const N = STEPS.length - 1;
  let k = 0;            // state shown
  let phase = 'guess';  // guess | shown
  let misses = 0;
  let flash = null;

  const meter = h('div', { class: `${P}meter`, 'aria-label': 'Rules applied, by goal' });
  const prompt = h('div', { class: `${P}prompt`, 'aria-live': 'polite' });
  const code = h('div', { class: `${P}src ${P}grow`, role: 'group', 'aria-label': 'Zig source' });
  const rowEls = HERO_ROWS.map((row, i) => {
    const el = h('div', { class: `${P}ln`, 'data-row': i, tabindex: '-1' },
      h('span', { class: `${P}no` }), h('span', { class: `${P}tx` }), h('span', { class: `${P}tag` }));
    code.append(el);
    return el;
  });
  const bar = h('div', { class: `${P}hbar` });
  app.append(meter, prompt, code, bar);

  const changed = (step) => HERO_ROWS.map((r, i) => (rowAt(r, step) !== rowAt(r, step - 1) ? i : -1)).filter((i) => i >= 0);
  /** Rows the reader may tap for a step: changed rows that exist now, or the row next to an insertion. */
  function targets(step) {
    const out = new Set();
    for (const i of changed(step)) {
      if (rowAt(HERO_ROWS[i], step - 1) !== null) { out.add(i); continue; }
      for (let j = i - 1; j >= 0; j--) if (rowAt(HERO_ROWS[j], step - 1) !== null) { out.add(j); break; }
      for (let j = i + 1; j < HERO_ROWS.length; j++) if (rowAt(HERO_ROWS[j], step - 1) !== null) { out.add(j); break; }
    }
    return out;
  }

  function paint() {
    const hot = phase === 'shown' && k > 0 ? new Set(changed(k)) : new Set();
    let n = 0;
    rowEls.forEach((el, i) => {
      const t = rowAt(HERO_ROWS[i], k);
      const gone = t === null;
      el.classList.toggle('is-gone', gone);
      el.classList.toggle('is-hot', hot.has(i) && !gone);
      el.classList.toggle('is-miss', flash === i);
      el.classList.toggle('is-tappable', phase === 'guess' && k < N && !gone);
      if (!gone) n += 1;
      el.children[0].textContent = gone ? '' : String(n);
      el.children[1].innerHTML = gone ? '' : hiZig(t.trimStart()) || ' ';
      el.children[1].setAttribute('style', gone ? '' : indentStyle(t));
      el.children[2].textContent = flash === i ? 'not this one' : '';
      el.setAttribute('role', phase === 'guess' && k < N && !gone ? 'button' : 'presentation');
      el.tabIndex = phase === 'guess' && k < N && !gone ? 0 : -1;
    });
    // meter: one pip per rule, grouped by goal in order
    meter.innerHTML = GOALS.map(([g, name], gi) => {
      const pips = STEPS.map((st, j) => (st && st.goal === g ? `<i class="${j <= k ? 'is-on' : ''}${j === (phase === 'shown' ? k : k + 1) ? ' is-cur' : ''}"></i>` : '')).join('');
      return `<span class="${P}mg"><b>${gi + 1}</b> ${name} ${pips}</span>`;
    }).join('');
    // prompt
    if (k === 0 && phase === 'shown') {
      prompt.innerHTML = '';
    } else if (k === 0 && phase === 'guess') {
      prompt.innerHTML = `<span class="${P}pk">start</span>Ordinary code for a fixed-size queue. Apply nine rules, one at a time. <b>Rule 1 of ${N} · ${STEPS[1].rule}</b> Tap the line you think it changes.`;
    } else if (phase === 'guess') {
      prompt.innerHTML = `<span class="${P}pk">rule ${k + 1} of ${N}</span><b>${STEPS[k + 1].rule}</b> Tap the line you think it changes.${misses ? ` <span class="${P}t-mute">(${misses} miss${misses > 1 ? 'es' : ''})</span>` : ''}`;
    } else if (k === N) {
      prompt.innerHTML = `<span class="${P}pk">done</span>${STEPS[k].why} <b>Nine rules: five for safety, one for performance, three for developer experience.</b>`;
    } else {
      prompt.innerHTML = `<span class="${P}pk">rule ${k} of ${N}</span>${STEPS[k].why}`;
    }
    bar.replaceChildren(...[
      btn('◀ back', () => { if (phase === 'shown' && k > 0) { k -= 1; } else if (k > 0) { k -= 1; } phase = 'guess'; misses = 0; flash = null; paint(); }, k === 0 ? 'is-off' : ''),
      phase === 'guess' && k < N ? btn('show me', () => reveal()) : null,
      phase === 'shown' && k < N ? btn(`next rule ▶`, () => { phase = 'guess'; misses = 0; paint(); focusFirst(); }, `${P}go`) : null,
      k === N ? btn('before', () => { k = 0; phase = 'shown'; paintCompare(); }) : null,
      k === N ? btn('after', () => { k = N; phase = 'shown'; paint(); }, `${P}go`) : null,
      k === N || (k === 0 && phase === 'shown') ? btn('start over', () => { k = 0; phase = 'guess'; misses = 0; paint(); }) : null,
      k < N ? btn('skip to the end', () => { k = N; phase = 'shown'; paint(); }, `${P}quiet`) : null,
    ].filter(Boolean));
    bar.querySelectorAll('.is-off').forEach((b) => { b.disabled = true; });
  }
  function paintCompare() {
    paint();
    prompt.innerHTML = `<span class="${P}pk">before</span>The same queue before the nine rules. Press <b>after</b> to flip back.`;
    bar.replaceChildren(btn('before', () => {}, `${P}go`), btn('after', () => { k = N; paint(); }), btn('start over', () => { k = 0; phase = 'guess'; paint(); }));
  }
  function reveal() { k += 1; phase = 'shown'; flash = null; paint(); }
  function focusFirst() { /* keep focus in the code for keyboard users */ code.querySelector('[tabindex="0"]')?.focus({ preventScroll: true }); }
  function tap(i) {
    if (phase !== 'guess' || k >= N) return;
    if (targets(k + 1).has(i)) { reveal(); return; }
    misses += 1; flash = i; paint();
    setTimeout(() => { if (flash === i) { flash = null; paint(); } }, 900);
  }
  code.addEventListener('click', (e) => { const r = e.target.closest('[data-row]'); if (r) tap(+r.dataset.row); });
  code.addEventListener('keydown', (e) => {
    const r = e.target.closest('[data-row]');
    if (r && (e.key === 'Enter' || e.key === ' ')) { tap(+r.dataset.row); e.preventDefault(); }
  });
  paint();
}

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
  const prompt = h('p', { class: `${P}prompt`, 'aria-live': 'polite' });
  const svg = s('svg', { role: 'group', 'aria-label': 'Lifeline of one transfer with two assertions' });
  const out = h('p', { class: `${P}verdict`, 'aria-live': 'polite' });
  const grid = s('svg', { class: `${P}space`, viewBox: '0 0 420 160', role: 'group', 'aria-label': 'Cases you have tried' });
  const found = h('span');
  app.append(prompt, svg, out,
    h('div', { class: `${P}spacewrap` }, h('div', { class: `${P}lbl` }, 'cases you have tried · ', found), grid));

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
    const stopT = T[v.stop];
    const done = st.phase === 'done';
    const tt = st.phase === 'predict' ? T.req : T.req + (stopT - T.req) * tokT;
    const L = (a, b, c, d, cls) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" class="${cls}"/>`;
    const txt = (t, o, str, cls, anchor) => { const [x, y] = pt(t, o); return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${str}</text>`; };
    const lab = tall ? 'start' : 'middle'; const side = tall ? 1 : -1;
    let o = '';
    const harmDisk = done && ((st.f === 'bug' && !st.A) || st.f === 'disk');
    const [bx0, by0] = pt(T.write, -26); const [bx1, by1] = pt(T.read, 26);
    o += `<rect x="${Math.min(bx0, bx1)}" y="${Math.min(by0, by1)}" width="${Math.abs(bx1 - bx0)}" height="${Math.abs(by1 - by0)}" class="${P}disk${harmDisk ? ' is-bad' : ''}"/>`;
    o += txt((T.write + T.read) / 2, tall ? 34 : -34, harmDisk ? 'bad data at rest' : 'disk · at rest', `${P}t-s ${harmDisk ? `${P}t-bad` : `${P}t-mute`}`, lab);
    { const [a, b] = pt(T.req); const [c, d] = pt(T.use); o += L(a, b, c, d, `${P}life`); const [e, f] = pt(Math.max(T.req, tt)); o += L(a, b, e, f, `${P}life is-done`); }
    for (const [id, name] of [['req', 'request'], ['val', 'validate'], ['commit', 'commit'], ['write', 'write'], ['read', 'read'], ['use', 'use']]) {
      const bad = id === 'use' && done && v.kind === 'bad';
      const [a, b] = pt(T[id], -6); const [c, d] = pt(T[id], 6);
      o += L(a, b, c, d, `${P}tick${bad ? ' is-bad' : ''}`);
      o += txt(T[id], side * (tall ? 14 : 16), bad ? 'use · wrong data' : name, `${P}t-s ${P}t-b${bad ? ` ${P}t-bad` : ''}`, lab);
    }
    if (v.stop === 'val' && done) {
      const [ax, ay] = pt(T.val, tall ? -10 : 10); const [bx, by] = pt(T.req, tall ? -10 : 10);
      o += `<path d="M${ax},${ay} Q${(ax + bx) / 2 + (tall ? -36 : 0)},${(ay + by) / 2 + (tall ? 0 : 36)} ${bx},${by}" class="${P}ret" marker-end="url(#${P}arr)"/>`;
      o += txt((T.val + T.req) / 2, tall ? -40 : 46, 'error code', `${P}t-xs ${P}t-safe ${P}t-b`, tall ? 'end' : 'middle');
    }
    for (const g of ['A', 'B']) {
      const armed = st[g]; const fired = done && v.stop === g;
      const [w0x, w0y] = pt(T[g], tall ? -40 : -64); const [w1x, w1y] = pt(T[g], tall ? 48 : 58);
      o += L(w0x, w0y, w1x, w1y, `${P}wire${armed ? ' is-armed' : ''}${fired ? ' is-fired' : ''}`);
      const [hx, hy] = pt(T[g], tall ? 64 : -80);
      const name = g === 'A' ? 'before write' : 'after read';
      o += `<g class="${P}handle${armed ? ' is-armed' : ''}" data-g="${g}" role="button" tabindex="0" aria-pressed="${armed}" aria-label="assert ${name}: ${armed ? 'armed' : 'off'}"><circle cx="${hx}" cy="${hy}" r="15"/><text x="${hx}" y="${hy + 4}" text-anchor="middle">${armed ? 'on' : 'off'}</text></g>`;
      o += tall ? `<text x="${hx + 20}" y="${hy - 3}" class="${P}t-xs ${P}t-b">assert</text><text x="${hx + 20}" y="${hy + 10}" class="${P}t-xs ${P}t-b">${name}</text>` : `<text x="${hx}" y="${hy - 22}" class="${P}t-xs ${P}t-b" text-anchor="middle">assert ${name}</text>`;
      if (fired) {
        const ft = v.kind === 'late' ? 'fires, late' : st.f === 'disk' ? 'checksum mismatch' : 'fires · stops';
        const fc = `${P}t-xs ${P}t-b ${v.kind === 'late' ? `${P}t-bad` : `${P}t-safe`}`;
        o += tall ? `<text x="${hx + 20}" y="${hy + 24}" class="${fc}">${ft}</text>` : txt(T[g], 72, ft, fc, 'middle');
      }
    }
    for (const f of FAULTS) {
      const t = f.at === 'disk' ? (T.write + T.read) / 2 : T[f.at];
      const [mx, my] = pt(t, tall ? -40 : 44); const sel = f.id === st.f;
      o += `<g class="${P}fault${sel ? ' is-sel' : ''}" data-f="${f.id}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="inject: ${f.long}"><rect x="${mx - 8}" y="${my - 8}" width="16" height="16" transform="rotate(45 ${mx} ${my})"/>`;
      o += tall ? `<text x="${mx - 16}" y="${my + 4}" class="${P}t-xs ${P}t-bad" text-anchor="end">${f.label}</text></g>` : `<text x="${mx}" y="${my + 26}" class="${P}t-xs ${P}t-bad" text-anchor="middle">${f.label}</text></g>`;
    }
    // prediction targets
    if (st.phase === 'predict') {
      for (const id of ['val', 'A', 'B', 'use']) {
        const [qx, qy] = pt(T[id], 0);
        o += `<g class="${P}guess" data-q="${id}" role="button" tabindex="0" aria-label="predict: it stops at ${STOPS[id]}"><circle cx="${qx}" cy="${qy}" r="13"/><text x="${qx}" y="${qy + 4.5}" text-anchor="middle">?</text></g>`;
      }
    }
    // the transfer
    const [kx, ky] = pt(tt, 0); const hurt = st.phase !== 'predict' && tt >= faultT - 0.001;
    if (st.phase !== 'predict') {
      o += `<g class="${P}tok${hurt ? ' is-bad' : ''}"><rect x="${kx - (tall ? 10 : 42)}" y="${ky - (tall ? 20 : 11)}" width="${tall ? 20 : 84}" height="${tall ? 40 : 22}" rx="3"/>${tall ? '' : `<text x="${kx}" y="${ky + 4}" text-anchor="middle">${hurt ? fault.tok : 'transfer 7'}</text>`}</g>`;
      if (tall) o += `<text x="${kx - 16}" y="${ky + 4}" class="${P}t-xs ${P}t-b ${hurt ? `${P}t-bad` : `${P}t-data`} ${P}halo" text-anchor="end">${hurt ? fault.tok : 'transfer 7'}</text>`;
    }
    svg.innerHTML = `<defs><marker id="${P}arr" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" style="fill:var(--ts-green)"/></marker></defs>${o}`;

    if (st.phase === 'predict') {
      prompt.innerHTML = `<b>${fault.long[0].toUpperCase()}${fault.long.slice(1)}</b>, with the assertion before the write <b>${st.A ? 'on' : 'off'}</b> and after the read <b>${st.B ? 'on' : 'off'}</b>. Where does the transfer stop? Tap a <span class="c-look">?</span> <button type="button" class="${P}link" data-run>just run it</button>`;
      out.className = `${P}verdict`; out.innerHTML = '';
    } else {
      prompt.innerHTML = 'Tap a red fault to inject it. Tap <span class="c-opt">on/off</span> to arm or disarm an assertion. Then predict where it stops.';
      const g = st.guess ? (st.guess === v.stop ? `<b class="c-safe">You said ${STOPS[st.guess]}. Right.</b> ` : `<b class="c-bad">You said ${STOPS[st.guess]}.</b> It stops at ${STOPS[v.stop]}. `) : '';
      out.className = `${P}verdict${done ? ` is-${v.kind}` : ''}`;
      out.innerHTML = done ? g + v.text : '';
    }
    drawSpace();
  }

  function drawSpace() {
    let o = '';
    const cx = (j) => 160 + j * 66; const cy = (i) => 60 + i * 34;
    MODES.forEach(([a, b], j) => {
      for (const [k2, on] of [[0, a], [1, b]]) o += `<line x1="${cx(j) - 6 + k2 * 12}" x2="${cx(j) - 6 + k2 * 12}" y1="14" y2="34" class="${P}wire${on ? ' is-armed' : ''}" style="stroke-width:${on ? 2.5 : 1.2}"/>`;
    });
    o += `<text x="${cx(0) - 26}" y="28" class="${P}t-xs ${P}t-mute" text-anchor="end">before · after</text>`;
    const pickSeen = FAULTS.every((f) => seen.has(`${f.id}|3`));
    if (pickSeen) o += `<rect x="${cx(3) - 22}" y="6" width="44" height="${cy(2) + 20 - 6}" class="${P}pickbox"/><text x="${cx(3)}" y="${cy(2) + 34}" class="${P}t-xs ${P}t-pick ${P}t-b" text-anchor="middle">TigerBeetle</text>`;
    FAULTS.forEach((f, i) => {
      o += `<text x="${cx(0) - 26}" y="${cy(i) + 4}" class="${P}t-xs" text-anchor="end">${f.label}</text>`;
      MODES.forEach(([a, b], j) => {
        const v = verdict(f.id, a, b); const known = seen.has(`${f.id}|${j}`);
        const cur = f.id === st.f && j === mode();
        o += `<g class="${P}cell ${known ? `is-${v.kind}` : 'is-unknown'}${cur ? ' is-cur' : ''}" data-f="${f.id}" data-m="${j}" role="button" tabindex="0" aria-label="${f.long}; before write ${a ? 'on' : 'off'}, after read ${b ? 'on' : 'off'}: ${known ? v.short : 'not tried yet'}"><circle cx="${cx(j)}" cy="${cy(i)}" r="10"/><text x="${cx(j)}" y="${cy(i) + (known ? 22 : 4)}" text-anchor="middle">${known ? v.short : '?'}</text></g>`;
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
    const hnd = e.target.closest(`.${P}handle`); const flt = e.target.closest(`.${P}fault`); const cell = e.target.closest(`.${P}cell`);
    const q = e.target.closest(`.${P}guess`); const r = e.target.closest('[data-run]');
    if (st.phase === 'run') return;
    if (q) run(q.dataset.q);
    else if (r) run(null);
    else if (hnd) setCase(st.f, hnd.dataset.g === 'A' ? !st.A : st.A, hnd.dataset.g === 'B' ? !st.B : st.B);
    else if (flt) setCase(flt.dataset.f, st.A, st.B);
    else if (cell) { const [a, b] = MODES[+cell.dataset.m]; setCase(cell.dataset.f, a, b); }
  }
  for (const el of [svg, grid, prompt]) {
    el.addEventListener('click', act);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { act(e); e.preventDefault(); } });
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
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

function scrub({ label, value, lo, hi, log, int, show, onchange }) {
  const toT = (v) => (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo));
  const fromT = (t) => { t = clamp(t, 0, 1); let v = log ? lo * (hi / lo) ** t : lo + t * (hi - lo); if (int) v = Math.round(v); return clamp(v, lo, hi); };
  const el = h('span', { class: `${P}scrub`, role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': lo, 'aria-valuemax': hi });
  let v = value; let drag = null;
  const set = (nv, fire = true) => { v = nv; el.textContent = show(v); el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', show(v)); if (fire) onchange(v); };
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, t: toT(v) }; el.setPointerCapture(e.pointerId); el.classList.add('is-drag'); e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (drag) set(fromT(drag.t + (e.clientX - drag.x) / 220)); });
  const end = () => { drag = null; el.classList.remove('is-drag'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    set(int && !log ? clamp(v + d, lo, hi) : fromT(toT(v) + d * 0.04));
    e.preventDefault(); e.stopPropagation();
  });
  set(value, false);
  return { el, set };
}

function initNapkin(fig, app) {
  const S = { n: NMAX, fs: 1e-3, m: 4, guess: null };
  const nS = scrub({ label: 'transfers per batch', value: NMAX, lo: 1, hi: NMAX, log: true, int: true, show: fmt, onchange: (v) => { S.n = v; draw(); } });
  const fS = scrub({ label: 'fsync time', value: 1e-3, lo: 20e-6, hi: 10e-3, log: true, show: (v) => tfmt(+v.toPrecision(2)), onchange: (v) => { S.fs = +v.toPrecision(2); draw(); } });
  const mS = scrub({ label: 'cache misses per transfer', value: 4, lo: 1, hi: 16, int: true, show: String, onchange: (v) => { S.m = v; draw(); } });
  const ask = h('div', { class: `${P}ask` },
    h('p', null, 'A batch of ', h('b', null, '8,189'), ' transfers pays one 500 µs round trip and one 1 ms fsync, shared by every transfer in it. Each transfer also pays 4 cache misses of 100 ns and 100 ns of CPU. ', h('b', null, 'Which costs the most per transfer?')),
    h('div', { class: `${P}choices` }, ...RES.map((r) => btn(r, () => { S.guess = r; reveal(); }))));
  const sentence = h('p', { class: `${P}sentence` },
    'A batch of ', nS.el, ' transfers pays one ', h('b', null, '500 µs'), ' round trip and one ', fS.el, ' fsync. Each transfer then pays ', mS.el,
    ' cache misses of ', h('b', null, '100 ns'), ', ', h('b', null, '100 ns'), ' of CPU, and moves its ', h('b', null, '128 bytes'), ' over the network, the disk, and memory.');
  const svg = s('svg', { class: `${P}chart`, role: 'img', 'aria-label': 'Per-transfer cost of each resource as the batch grows' });
  const read = h('p', { class: `${P}verdict`, 'aria-live': 'polite' });
  const explore = h('div', { class: `${P}explore`, hidden: true }, sentence, h('p', { class: `${P}hint` }, 'Drag the blue numbers, or drag across the chart.'));
  app.append(ask, explore, svg, read);
  let shown = false;

  function reveal() { shown = true; ask.hidden = true; explore.hidden = false; draw(); }

  let G = null;
  function draw() {
    const Wd = Math.max(300, app.clientWidth);
    const Ht = clamp(Math.round(Wd * 0.46), 250, 340);
    const m = { l: 50, r: Wd < 520 ? 40 : 130, t: 14, b: 30 };
    const X1 = Math.log10(NMAX);
    const x = (n) => m.l + (Math.log10(n) / X1) * (Wd - m.l - m.r);
    const y = (t) => m.t + ((-2 - Math.log10(clamp(t, 1e-8, 1e-2))) / 6) * (Ht - m.t - m.b);
    G = { m, Wd, X1 };
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    const cs = costs(S.n, S.fs, S.m);
    const top = cs.reduce((a, b) => (b.t > a.t ? b : a));
    let o = '';
    for (let e = -8; e <= -2; e++) {
      o += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" class="${P}grid"/>`;
      o += `<text x="${m.l - 6}" y="${y(10 ** e) + 3.5}" class="${P}t-xs ${P}t-mute" text-anchor="end">${tfmt(10 ** e)}</text>`;
    }
    for (const n of [1, 10, 100, 1000, NMAX]) o += `<text x="${x(n)}" y="${Ht - m.b + 14}" class="${P}t-xs ${P}t-mute" text-anchor="${n === 1 ? 'start' : 'middle'}">${fmt(n)}</text>`;
    o += `<text x="${Wd - m.r}" y="${Ht - 2}" class="${P}t-xs ${P}t-mute" text-anchor="end">transfers per batch →</text>`;
    if (!shown) {
      o += `<text x="${(m.l + Wd - m.r) / 2}" y="${Ht / 2}" class="${P}t-s ${P}t-mute" text-anchor="middle">guess first</text>`;
      svg.innerHTML = o; read.innerHTML = ''; read.className = `${P}verdict`; return;
    }
    const ns = []; for (let k = 0; k <= 120; k++) ns.push(10 ** ((k / 120) * X1));
    const DASH = ['7 4', '', '2 3', '10 3 2 3'];
    cs.forEach((c, k) => {
      const hot = c.id === top.id;
      o += `<polyline points="${ns.map((n) => `${x(n).toFixed(1)},${y(costs(n, S.fs, S.m)[k].t).toFixed(1)}`).join(' ')}" class="${P}curve${hot ? ' is-hot' : ''}" style="${DASH[k] ? `stroke-dasharray:${DASH[k]}` : ''}"/>`;
    });
    const dm = crossover(S.fs, S.m);
    if (dm >= 1 && dm <= NMAX) {
      const cy = y(costs(dm, S.fs, S.m)[1].t); const by = Ht - m.b - 8;
      o += `<line x1="${x(dm)}" x2="${x(dm)}" y1="${cy}" y2="${by + 2}" class="${P}xline"/><circle cx="${x(dm)}" cy="${cy}" r="4" class="${P}xdot"/>`;
      o += `<text x="${x(dm) - 6}" y="${by}" class="${P}t-xs ${P}t-mute ${P}halo" text-anchor="end">disk = memory at ${fmt(dm)}</text>`;
    }
    // cursor + labels next to each curve (spread so they never overlap)
    const cx = x(S.n);
    o += `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${Ht - m.b}" class="${P}cursor"/>`;
    const labs = cs.map((c) => ({ ...c, y: y(c.t) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].ly = Math.max(labs[i].y, (labs[i - 1].ly ?? labs[i - 1].y) + 13);
    labs[0].ly = labs[0].y;
    const right = cx + 125 < Wd;
    for (const c of labs) {
      const hot = c.id === top.id;
      o += `<circle cx="${cx}" cy="${c.y}" r="${hot ? 4.5 : 3}" class="${P}dot${hot ? ' is-hot' : ''}"/>`;
      o += `<text x="${right ? cx + 8 : cx - 8}" y="${c.ly + 4}" class="${P}t-xs ${P}t-b ${P}halo${hot ? ` ${P}t-look` : ''}" text-anchor="${right ? 'start' : 'end'}">${c.id} ${tfmt(c.t)}</text>`;
    }
    o += `<text x="${clamp(cx, m.l + 30, Wd - m.r - 30)}" y="${m.t - 3}" class="${P}t-xs ${P}t-b ${P}t-opt ${P}halo" text-anchor="middle">n = ${fmt(S.n)}</text>`;
    svg.innerHTML = o;

    const total = cs.reduce((a, c) => a + c.t, 0);
    const g = S.guess && S.n === NMAX && S.fs === 1e-3 && S.m === 4 ? (S.guess === top.id ? `<b class="c-safe">You picked ${S.guess}. Right.</b> ` : `<b class="c-bad">You picked ${S.guess}.</b> `) : '';
    read.className = `${P}verdict`;
    read.innerHTML = `${g}At ${fmt(S.n)} per batch, <b class="c-look">${top.id}</b> costs the most: ${tfmt(top.t)} of ${tfmt(total)} per transfer. One fsync costs as much as <b class="c-data">${fmt(S.fs / MISS)}</b> cache misses${dm <= NMAX ? `, but it is shared by the batch, so from about <b class="c-data">${fmt(dm)}</b> transfers per batch the ${S.m} miss${S.m > 1 ? 'es' : ''} per transfer cost more.` : `. Even at ${fmt(NMAX)} per batch, the fsync share costs more than the misses.`}`;
  }

  let dragging = false;
  const fromX = (e) => {
    if (!shown) return;
    const b = svg.getBoundingClientRect();
    const t = clamp((((e.clientX - b.left) / b.width) * G.Wd - G.m.l) / (G.Wd - G.m.l - G.m.r), 0, 1);
    nS.set(clamp(Math.round(10 ** (t * G.X1)), 1, NMAX));
  };
  svg.addEventListener('pointerdown', (e) => { dragging = true; svg.setPointerCapture(e.pointerId); fromX(e); });
  svg.addEventListener('pointermove', (e) => { if (dragging) fromX(e); });
  svg.addEventListener('pointerup', () => { dragging = false; });
  svg.addEventListener('pointercancel', () => { dragging = false; });
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

function initStruct(fig, app) {
  const E = { amount: false, timeout: false, move: false, add: false };
  let built = { ...E };  // the layout the last build saw
  let dirty = false; let guess = null;
  const src = h('div', { class: `${P}src ${P}edit`, role: 'group', 'aria-label': 'Transfer source; tap the blue parts to edit' });
  const map = h('div', { class: `${P}bytes`, role: 'img' });
  const term = h('div', { class: `${P}term`, 'aria-live': 'polite' });
  const why = h('p', { class: `${P}verdict`, 'aria-live': 'polite' });
  const reset = h('button', { type: 'button', class: `${P}reset`, onclick: () => { Object.keys(E).forEach((k) => { E[k] = false; }); build(null); } }, 'as shipped');
  app.append(h('div', { class: `${P}struct` },
    h('div', null, h('div', { class: `${P}lbl` }, 'transfer.zig · abridged · tap the blue parts ', reset), src),
    h('div', null, h('div', { class: `${P}lbl` }, 'bytes, 16 per row · after the last build'), map, term)),
  why);

  src.addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (!b) return; E[b.dataset.edit] = !E[b.dataset.edit]; dirty = true; guess = null; paint(); });
  term.addEventListener('click', (e) => { const b = e.target.closest('[data-guess]'); if (b) build(b.dataset.guess === 'just' ? null : b.dataset.guess); });

  function build(g) { built = { ...E }; dirty = false; guess = g; paint(); }

  function paint() {
    const f = fieldsOf(E);
    const LB = layout(fieldsOf(built));
    const shipped = !E.amount && !E.timeout && !E.move && !E.add;
    reset.disabled = shipped && !dirty;
    const first = CHECKS.findIndex(([, , ok]) => !ok(LB));
    const lines = [['pub const Transfer = extern struct {', '']];
    for (const [n, t] of f) {
      let tx;
      if (n === 'amount' || n === 'timeout') tx = `    ${n}: <button type="button" class="${P}tok-btn${E[n] ? ' is-edited' : ''}" data-edit="${n}" aria-label="${n}: ${t}, tap to change">${t}</button>,`;
      else if (n === 'timestamp') tx = `    ${n}: <span class="${P}ty">${t}</span>, <button type="button" class="${P}tok-btn${E.move ? ' is-edited' : ''}" data-edit="move" aria-label="${E.move ? 'move timestamp back to the end' : 'move timestamp up'}">${E.move ? '↓ back' : '↑ move up'}</button>`;
      else if (n === 'user_data_8') tx = `    ${n}: <span class="${P}ty">u8</span>, <button type="button" class="${P}tok-btn is-edited" data-edit="add" aria-label="remove user_data_8">× remove</button>`;
      else tx = `    ${n}: <span class="${P}ty">${t}</span>,`;
      lines.push([tx, '']);
    }
    if (!E.add) lines.push([`    <button type="button" class="${P}tok-btn ${P}ghost" data-edit="add" aria-label="add field user_data_8: u8">+ user_data_8: u8</button>`, '']);
    lines.push(['', ''], ['    comptime {', '']);
    let assertLine = 0;
    CHECKS.forEach(([, c, ok, why2], k) => {
      let state = 'wait'; let note = '';
      if (!dirty) {
        const pass = ok(LB);
        state = first >= 0 && k > first ? 'skip' : pass ? 'ok' : 'bad';
        note = state === 'ok' ? 'holds' : state === 'bad' ? `fails: ${why2(LB)}` : pass ? 'not reached' : `not reached (${why2(LB)})`;
      }
      if (state === 'bad') assertLine = lines.length + 1;
      lines.push([`        <span class="${P}as">assert</span>${escH(c.slice(6))}${note ? ` <span class="${P}chk is-${state}">// ${note}</span>` : ''}`, dirty ? '' : `is-${state}`]);
    });
    lines.push(['    }', ''], ['};', '']);
    src.innerHTML = lines.map(([tx, cls], i) => `<div class="${P}ln ${cls}"><span class="${P}no">${i + 1}</span><span class="${P}tx" style="${indentStyle(tx)}">${tx.trimStart()}</span></div>`).join('');

    // byte map: always the last build
    const rows = LB.size / 16;
    let html = '';
    for (let r = 0; r < rows; r++) html += `<span class="${P}off${r >= 8 ? ' is-over' : ''}" style="grid-row:${r + 1}">${r * 16}</span>`;
    for (const it of LB.items) {
      let o = it.off; let left = it.size;
      while (left > 0) {
        const r = Math.floor(o / 16); const c = o % 16; const w = Math.min(left, 16 - c);
        html += `<span class="${it.pad ? `${P}pad` : `${P}fld`}${r >= 8 ? ' is-over' : ''}" style="grid-row:${r + 1};grid-column:${c + 2} / span ${w}" title="${it.pad ? 'padding' : `${it.name}: ${it.type}`}, ${w} B at ${o}">${it.pad ? (w >= 3 ? 'pad' : '') : o === it.off ? it.name : ''}</span>`;
        o += w; left -= w;
      }
    }
    map.innerHTML = html;
    map.classList.toggle('is-stale', dirty);
    map.setAttribute('aria-label', `${LB.size} bytes, ${LB.padBytes} bytes of padding`);

    if (dirty) {
      term.className = `${P}term is-ask`;
      term.innerHTML = `<div class="${P}cmd">$ zig build</div><div>Before you run it: which assertion stops the build?</div><div class="${P}choices">${
        ['none', ...CHECKS.map((c) => c[0])].map((g) => `<button type="button" class="${P}btn" data-guess="${g}">${g === 'none' ? 'none, it builds' : g}</button>`).join('')}<button type="button" class="${P}link" data-guess="just">just build</button></div>`;
    } else {
      const truth = first < 0 ? 'none' : CHECKS[first][0];
      const said = guess ? (guess === truth ? `<div class="c-safe"># you said ${guess}: right</div>` : `<div class="c-bad"># you said ${guess === 'none' ? 'it builds' : guess}</div>`) : '';
      if (first < 0) { term.className = `${P}term is-ok`; term.innerHTML = `<div class="${P}cmd">$ zig build</div><div class="c-safe">(no output: all three assertions hold)</div>${said}`; }
      else {
        const c = CHECKS[first][1];
        term.className = `${P}term is-bad`;
        term.innerHTML = `<div class="${P}cmd">$ zig build</div><pre><span class="c-bad">lib/std/debug.zig:420:14: error: reached unreachable code</span>\n    if (!ok) unreachable; // assertion failure\n             ^~~~~~~~~~~\ntransfer.zig:${assertLine}:15: note: called at comptime here\n        ${escH(c)}\n        ~~~~~~^${'~'.repeat(c.length - 8)}</pre>${said}`;
      }
    }

    // one short reason, only after a build
    if (dirty) { why.className = `${P}verdict`; why.innerHTML = 'Edited, not built. The byte map still shows the last build.'; return; }
    const B = built; const s2 = !B.amount && !B.timeout && !B.move && !B.add;
    let t;
    if (s2) t = 'Six <code>u128</code> fields fill the first six rows, and the small fields pack the last two with no gap.';
    else if (B.amount && !B.timeout && !B.move && !B.add) t = '<code>pending_id</code> must start at a multiple of 16, so <b class="c-bad">8 bytes of padding</b> follow <code>amount</code>. The size is still 128, so <b>only <code>no_padding</code> catches it</b>. No field sets those bytes, so they can carry old memory into a checksum or onto the network: a buffer bleed.';
    else t = `Each field starts at a multiple of its own size, and the total rounds up to a multiple of 16: <b class="c-bad">${LB.size} bytes, ${LB.padBytes} of them padding</b>. The build stops at the first failing assertion, before any test runs.`;
    why.className = `${P}verdict ${s2 ? 'is-ok' : 'is-bad'}`;
    why.innerHTML = t;
  }
  paint();
}

register({ 'ts-hero': initHero, 'ts-tripwire': initTripwire, 'ts-napkin': initNapkin, 'ts-struct': initStruct });

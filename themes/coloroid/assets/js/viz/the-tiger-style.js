/*
 * viz/the-tiger-style — figures for "The Tiger Style".
 *
 * House look (walviz.css + viz/lib.js). Each figure asks before it shows:
 *
 *   ts-struct  shrink amount to u64 and predict which comptime assertion
 *              stops `zig build`; then flip amount to compare the bytes
 *   ts-napkin  guess which resource costs most per transfer at 8,189 per
 *              batch, then drag the batch size
 *
 * Facts: Transfer fields and assertions from tigerbeetle src/tigerbeetle.zig
 * @ 47aeb22. With amount: u64, Zig 0.16 puts pending_id at 64, size stays
 * 128 and align 16, so only no_padding fails; the build error is real Zig
 * 0.16 output for a copy of the struct. Napkin costs are samples.
 */
import { h, s, chips, ask, colorKey, codeBlock, register, clamp, fmt, range } from './lib.js';

const P = 'v-ts-';

/* ============================================================== STRUCT */

const TYPES = { u128: 16, u64: 8, u32: 4, u16: 2, u8: 1, TransferFlags: 2 };
const BASE = [
  ['id', 'u128'], ['debit_account_id', 'u128'], ['credit_account_id', 'u128'], ['amount', 'u128'],
  ['pending_id', 'u128'], ['user_data_128', 'u128'], ['user_data_64', 'u64'], ['user_data_32', 'u32'],
  ['timeout', 'u32'], ['ledger', 'u32'], ['code', 'u16'], ['flags', 'TransferFlags'], ['timestamp', 'u64'],
];
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
  ['assert(stdx.no_padding(Transfer));', (L) => L.padBytes === 0, (L) => (L.padBytes ? `fails: ${L.padBytes} B of padding` : 'no padding')],
  ['assert(@sizeOf(Transfer) == 128);', (L) => L.size === 128, (L) => `size is ${L.size}`],
  ['assert(@alignOf(Transfer) == 16);', (L) => L.align === 16, (L) => `align is ${L.align}`],
];
/* Zig 0.16, `zig test` on a copy of the struct with amount: u64. */
const ZIG_ERR = [
  '$ zig build',
  '⟦lib/std/debug.zig:420:14: error: reached unreachable code⟧',
  '    if (!ok) unreachable; // assertion failure',
  '             ^~~~~~~~~~~',
  'transfer.zig:21:15: note: called at comptime here',
  '        assert(stdx.no_padding(Transfer));',
  '        ~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~',
];

function initStruct(fig, app) {
  const title = (t) => h('div', { class: 'wv-title', style: 'margin-bottom:.35rem' }, t);
  const map = h('div', { class: `${P}bytes`, role: 'img' });
  const checks = h('div');
  const outBox = h('div');
  const toggle = chips([['u128', 'amount: u128, as shipped'], ['u64', 'amount: u64']], (v) => show(v === 'u64'), { value: 'u128', label: 'Type of amount' });
  toggle.el.hidden = true;
  const q = ask('Change amount from u128 to u64. Which assertion stops zig build?',
    [['none', 'none, it builds'], ['pad', 'no_padding'], ['size', '@sizeOf == 128'], ['align', '@alignOf == 16']], 'pad',
    (v, right) => {
      toggle.el.hidden = false; toggle.set('u64'); show(true);
      return `${right ? '<b>Right.</b>' : '<b>It is no_padding.</b>'} <code>pending_id</code> must start at a multiple of 16, so 8 bytes of padding follow <code>amount</code>. The size is still 128 and the alignment still 16, so only <code>no_padding</code> catches it. No field sets those 8 bytes, so they can carry old memory into a checksum or onto the network: a buffer bleed.`;
    });
  app.append(q.el, toggle.el,
    h('div', { class: 'wv-split' },
      h('div', null, title('Transfer · bytes, 16 per row'), map),
      h('div', null, title('comptime'), checks,
        h('details', null, h('summary', null, 'zig build output'), outBox))),
    colorKey([['k-data', 'field bytes'], ['k-gap', 'padding, or the assertion that fails'], ['k-opt', 'what you can change']]));

  function show(u64) {
    const fields = BASE.map(([n, t]) => [n, n === 'amount' && u64 ? 'u64' : t]);
    const L = layout(fields);
    let o = '';
    for (let r = 0; r < L.size / 16; r++) o += `<span class="${P}off t-xs" style="grid-row:${r + 1}">${r * 16}</span>`;
    for (const it of L.items) {
      const r = Math.floor(it.off / 16); const c = it.off % 16;
      const label = it.pad ? 'pad' : it.name === 'amount' && u64 ? 'amount: u64' : it.name;
      o += `<span class="${it.pad ? `${P}pad` : `${P}fld`}" style="grid-row:${r + 1};grid-column:${c + 2} / span ${it.size}" title="${it.pad ? 'padding' : `${it.name}: ${it.type}`}, ${it.size} B at ${it.off}">${label}</span>`;
    }
    map.innerHTML = o;
    map.setAttribute('aria-label', `${L.size} bytes, ${L.padBytes} bytes of padding`);
    checks.innerHTML = codeBlock(CHECKS.flatMap(([c, ok, w]) => [c, ok(L) ? `    // ${w(L)}` : `    // ⟦${w(L)}⟧`]));
    outBox.innerHTML = codeBlock(L.padBytes ? ZIG_ERR : ['$ zig build', '(no output: all three assertions hold)']);
  }
  show(false);
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
  const nOf = (t) => clamp(Math.round(logv(t, 1, NMAX)), 1, NMAX);
  const rn = range('transfers per batch', { min: 0, max: 1000, value: 1000, fmt: (t) => fmt(nOf(t)), oninput: (t) => { S.n = nOf(t); draw(); } });
  const q = ask('A batch of 8,189 transfers pays one 500 µs round trip and one 1 ms fsync, shared by every transfer in it. Each transfer also pays 4 cache misses of 100 ns and 100 ns of CPU. Which costs the most per transfer?',
    RES.map((r) => [r, r]), 'memory',
    (v, right) => { shown = true; controls.hidden = false; draw(); return right ? '<b>Right.</b> The fsync and the round trip are shared by 8,189 transfers; the cache misses are paid by each one.' : `<b>It is memory</b>, not ${v}. The fsync and the round trip are shared by 8,189 transfers; the cache misses are paid by each one.`; });
  const controls = h('div', null, rn.el);
  controls.hidden = true;
  const svg = s('svg', { class: `${P}chart`, role: 'img', 'aria-label': 'Per-transfer cost of each resource as the batch grows' });
  const read = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  read.hidden = true;
  app.append(q.el, controls, svg, read,
    colorKey([['k-line-ink', 'cost per transfer, by resource'], ['k-look', 'the largest cost'], ['k-opt', 'the batch size you set']]));

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
    read.innerHTML = `At <b>${fmt(S.n)}</b> per batch, <b class="c-look">${top.id}</b> costs the most: <b>${tfmt(top.t)}</b> of <b>${tfmt(total)}</b> per transfer, about <b>${fmt(+(1 / total).toPrecision(2))}</b> transfers/s one batch at a time. One fsync costs as much as <b>${fmt(S.fs / MISS)}</b> cache misses${dm <= NMAX ? `, but the batch shares it, so from about <b>${fmt(dm)}</b> per batch the ${S.m} miss${S.m > 1 ? 'es' : ''} per transfer cost more.` : `. Even at ${fmt(NMAX)} per batch, the fsync share costs more than the misses.`}`;
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

register({ 'ts-struct': initStruct, 'ts-napkin': initNapkin });

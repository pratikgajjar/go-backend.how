/*
 * fdyno-dynamodb-on-foundationdb — figures for "fdyno: DynamoDB on FoundationDB".
 *
 *   fdy-access  pick an access pattern; both stores light up the keys it reads
 *   fdy-hot     where 24 new writes go, by key range (fdyno) and by hash
 *               (DynamoDB); the reader splits the busy shard and tries again
 *   fdy-write   one UpdateItem as one FDB transaction, step by step, while
 *               the write set fills up and then commits
 *   fdy-retry   predict, then try: a lost commit reply, a retry, receipts on/off
 *
 * Key layout, Query-to-range mapping, index maintenance, versionstamped stream
 * keys, receipts and the retry rule follow fdyno's internal/dynodb package.
 * Items, partition placement, shard boundaries, versions and IDs are samples.
 * The DynamoDB hash in fdy-hot is a stand-in (FNV-1a), not DynamoDB's.
 */

import { h, s, stepper, colorKey, chips, ask, btn, register, esc, mulberry } from './lib.js';

const P = 'v-fdy-';

/** Re-render when the figure crosses a width breakpoint. */
function onBreak(app, bp, cb) {
  let wide = app.clientWidth >= bp;
  new ResizeObserver(() => { const w = app.clientWidth >= bp; if (w !== wide) { wide = w; cb(wide); } }).observe(app);
  return wide;
}

/** A labelled row of chips. */
function pickRow(label, options, value, onpick) {
  const ch = chips(options, onpick, { value, label });
  return { el: h('div', { class: `${P}row` }, h('span', { class: `${P}lab` }, label), ch.el), ch };
}

const stat = (k, v, cls = '') => h('div', { class: `wv-stat ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

/* ================================================================ ACCESS */

/* Base items in FDB key order. */
const ITEMS = [
  { pk: 'CUST#41', sk: 'PROFILE', a: 'name=Asha' },
  { pk: 'CUST#42', sk: 'ORDER#2026-09-12#3', a: 'status=PAID' },
  { pk: 'CUST#42', sk: 'ORDER#2026-10-01#7', a: 'status=OPEN' },
  { pk: 'CUST#42', sk: 'ORDER#2026-10-17#9', a: 'status=OPEN' },
  { pk: 'CUST#42', sk: 'PROFILE', a: 'name=Ravi' },
  { pk: 'CUST#43', sk: 'ORDER#2026-10-05#8', a: 'status=PAID' },
  { pk: 'CUST#43', sk: 'PROFILE', a: 'name=Meera' },
  { pk: 'ORDER#9', sk: 'LINE#1', a: 'sku=TEA-250' },
  { pk: 'ORDER#9', sk: 'LINE#2', a: 'sku=MUG-01' },
];
/* ByStatus entries in FDB key order: status, createdAt, then the base key. */
const IDX = [
  { st: 'OPEN', t: 1790847000, base: 2 },
  { st: 'OPEN', t: 1792229400, base: 3 },
  { st: 'PAID', t: 1789205400, base: 1 },
  { st: 'PAID', t: 1791192600, base: 5 },
];
/* Sample placement. DynamoDB: hash of pk. FDB: contiguous key ranges. */
const DDB_PARTS = [
  { name: 'partition 1', pks: ['CUST#43', 'ORDER#9'] },
  { name: 'partition 2', pks: ['CUST#41'] },
  { name: 'partition 3', pks: ['CUST#42'] },
];
const DDB_GSI = [{ name: 'ByStatus partition 1', st: 'PAID' }, { name: 'ByStatus partition 2', st: 'OPEN' }];
const SHARDS = [
  { name: 'shard 1', items: [0, 1, 2, 3, 4] },
  { name: 'shard 2', items: [5, 6, 7, 8] },
  { name: 'shard 3', idx: [0, 1, 2, 3] },
];

const PATTERNS = [
  { id: 'A', label: 'A · profile', req: 'GetItem pk=CUST#42, sk=PROFILE', op: 'point read', read: [4], idx: [],
    why: 'One key, one point read. This is the cheapest request on both stores.' },
  { id: 'B', label: 'B · last 10 orders', req: 'Query pk=CUST#42, sk begins_with ORDER#, ScanIndexForward=false, Limit 10', op: 'reverse range read', read: [3, 2, 1], idx: [],
    why: 'begins_with becomes the prefix range i/CUST#42/ORDER#. Reverse order is the same range read backwards. It stops after 10 keys, or here at the end of the prefix after 3.' },
  { id: 'C', label: 'C · October', req: 'Query pk=CUST#42, sk BETWEEN ORDER#2026-10-01 AND ORDER#2026-10-31~', op: 'range read', read: [2, 3], idx: [],
    why: 'BETWEEN becomes the two ends of one range. Because the sort key starts with the date, a date range is a key range.' },
  { id: 'D', label: 'D · order lines', req: 'Query pk=ORDER#9', op: 'range read', read: [7, 8], idx: [],
    why: 'One item collection is one key prefix, so all lines of order 9 are adjacent.' },
  { id: 'E', label: 'E · open orders', req: 'Query IndexName=ByStatus, status=OPEN', op: 'range read on the index', read: [], idx: [0, 1],
    why: 'The GSI is a second sorted copy. Entries with status OPEN are adjacent and sorted by createdAt, so the oldest comes first.' },
  { id: 'F', label: 'no index: Scan + filter', req: 'Scan FilterExpression status = :open', op: 'range read over the whole table', read: [0, 1, 2, 3, 4, 5, 6, 7, 8], idx: [], keep: [2, 3],
    why: 'The filter runs after the read. Every item is read and 7 of 9 are dropped. On a large table this is many pages. Pattern E answers the same question by reading 2 keys.' },
];

function initAccess(fig, app) {
  let cur = 'B';
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const stats = h('div', { class: 'wv-stats' });
  const ddb = h('div', { class: `${P}panel` });
  const fdb = h('div', { class: `${P}panel` });
  const pick = pickRow('Access pattern', PATTERNS.map((p) => [p.id, p.label]), cur, (v) => { cur = v; paint(); });

  function rowState(p, i) {
    if (!p.read.includes(i)) return '';
    if (p.keep && !p.keep.includes(i)) return 'is-waste';
    return 'is-read';
  }
  function order(p, i) { const n = p.read.indexOf(i); return n < 0 ? '' : String(n + 1); }

  function paint() {
    const p = PATTERNS.find((x) => x.id === cur);
    const row = (cls, n, key, attr) => h('div', { class: `${P}key ${cls}` },
      h('span', { class: `${P}n` }, n), h('span', { class: `${P}k` }, key), h('span', { class: `${P}a` }, attr));
    const idxState = (j) => (p.idx.includes(j) ? 'is-read' : '');
    const idxOrder = (j) => { const n = p.idx.indexOf(j); return n < 0 ? '' : String(n + 1); };

    // DynamoDB side
    const parts = DDB_PARTS.map((pt) => {
      const rows = ITEMS.map((it, i) => ({ it, i })).filter(({ it }) => pt.pks.includes(it.pk));
      const hot = rows.some(({ i }) => p.read.includes(i));
      return h('div', { class: `${P}grp ${hot ? 'is-hot' : ''}` }, h('div', { class: `${P}gh` }, pt.name),
        ...rows.map(({ it, i }) => row(rowState(p, i), p.keep ? '' : order(p, i), `pk=${it.pk}  sk=${it.sk}`, it.a)));
    });
    const gsi = DDB_GSI.map((g) => {
      const ents = IDX.map((e, j) => ({ e, j })).filter(({ e }) => e.st === g.st);
      const hot = ents.some(({ j }) => p.idx.includes(j));
      return h('div', { class: `${P}grp ${hot ? 'is-hot' : ''}` }, h('div', { class: `${P}gh` }, g.name),
        ...ents.map(({ e, j }) => row(idxState(j), idxOrder(j), `status=${e.st}  createdAt=${e.t}`, `→ ${ITEMS[e.base].pk} ${ITEMS[e.base].sk}`)));
    });
    ddb.replaceChildren(h('h5', null, 'DynamoDB', h('span', null, 'partition = hash of pk')), ...parts,
      h('div', { class: `${P}sub` }, 'GSI ByStatus: its own table, partitioned by hash of status'), ...gsi);

    // FDB side
    const shards = SHARDS.map((sh) => {
      const rows = sh.items
        ? sh.items.map((i) => row(rowState(p, i), order(p, i), `Shop/i/${ITEMS[i].pk}/${ITEMS[i].sk}`, ITEMS[i].a))
        : sh.idx.map((j) => row(idxState(j), idxOrder(j), `Shop/x/ByStatus/${IDX[j].st}/${IDX[j].t}/${ITEMS[IDX[j].base].pk}/${ITEMS[IDX[j].base].sk}`, ''));
      const hot = sh.items ? sh.items.some((i) => p.read.includes(i)) : sh.idx.some((j) => p.idx.includes(j));
      return h('div', { class: `${P}grp ${hot ? 'is-hot' : ''}` }, h('div', { class: `${P}gh` }, `${sh.name}${sh.idx ? ' · index entries' : ''}`), ...rows);
    });
    fdb.replaceChildren(h('h5', null, 'FoundationDB', h('span', null, 'one sorted key space')), ...shards);

    const nRead = p.read.length + p.idx.length;
    const nRet = p.keep ? p.keep.length : nRead;
    const nParts = p.idx.length ? 1 : DDB_PARTS.filter((pt) => p.read.some((i) => pt.pks.includes(ITEMS[i].pk))).length;
    stats.replaceChildren(
      stat('FDB operation', p.op),
      stat('keys read', String(nRead)),
      stat('items returned', String(nRet), p.keep ? 'is-bad' : ''),
      stat('DynamoDB partitions', p.id === 'F' ? 'all' : String(nParts)),
    );
    note.innerHTML = `<code>${esc(p.req)}</code><br>${esc(p.why)}`;
    note.className = `wv-note ${p.keep ? 'is-bad' : ''}`;
  }

  app.append(pick.el, note, h('div', { class: `${P}cols` }, ddb, fdb), stats,
    colorKey([['k-look', 'read and returned, in read order'], ['k-gap', 'read, then dropped by the filter']]));
  paint();
}

/* =================================================================== HOT */

const fnv = (str) => { let x = 0x811c9dc5; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x; };
const BATCH = 24;
const POLICY = {
  cust: { label: 'pk = customer ID', bounds: ['CUST#2500', 'CUST#5000', 'CUST#7500'], lo: 'CUST#0000', hi: 'CUST#9999' },
  time: { label: 'pk = order time', bounds: ['2026-04-01', '2026-07-01', '2026-10-01'], lo: '2026-01-01', hi: 'now' },
};

function batchKeys(policy, n) {
  if (policy === 'cust') {
    const r = mulberry(1000 + n);
    return Array.from({ length: BATCH }, () => `CUST#${String(Math.floor(r() * 10000)).padStart(4, '0')}`);
  }
  const t0 = Date.UTC(2026, 9, 18, 10, 0, 0) + n * BATCH * 1000;
  return Array.from({ length: BATCH }, (_, i) => new Date(t0 + i * 1000).toISOString().slice(0, 19));
}

function initHot(fig, app) {
  let policy = 'time'; let bounds = [...POLICY.time.bounds]; let n = 0; let splits = 0;
  const bars = h('div', { class: `${P}bars` });
  const keys = h('p', { class: `${P}keys` });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const pick = pickRow('Partition key', [['cust', POLICY.cust.label], ['time', POLICY.time.label]], policy, (v) => { policy = v; reset(); });
  const split = btn('Split the busiest shard', () => doSplit());
  const again = btn('Reset', () => reset(), { class: 'wv-btn wv-btn--ghost' });

  function shardOf(k) { let i = 0; while (i < bounds.length && k >= bounds[i]) i++; return i; }
  function reset() { bounds = [...POLICY[policy].bounds]; n = 0; splits = 0; paint(); }
  function doSplit() {
    const ks = batchKeys(policy, n);
    const counts = bounds.map(() => 0).concat(0);
    ks.forEach((k) => counts[shardOf(k)]++);
    const busy = counts.indexOf(Math.max(...counts));
    const inBusy = ks.filter((k) => shardOf(k) === busy).sort();
    const mid = inBusy[Math.floor(inBusy.length / 2)];
    if (mid && !bounds.includes(mid)) { bounds.splice(busy, 0, mid); bounds.sort(); }
    splits++; n++;
    paint();
  }

  function barRow(label, count, hot) {
    const pct = (count / BATCH) * 100;
    return h('div', { class: `${P}bar ${hot ? 'is-hot' : ''}` },
      h('span', { class: `${P}bl` }, label),
      h('span', { class: `${P}bt` }, h('i', { style: `width:${pct}%` })),
      h('span', { class: `${P}bc` }, String(count)));
  }

  function paint() {
    const ks = batchKeys(policy, n);
    const pol = POLICY[policy];
    const counts = bounds.map(() => 0).concat(0);
    ks.forEach((k) => counts[shardOf(k)]++);
    const even = BATCH / counts.length;
    const edges = [pol.lo, ...bounds, pol.hi];
    const short = (k) => k.replace(/^2026-/, '').replace('T', ' ');
    const fdbRows = counts.map((c, i) => barRow(`shard ${i + 1}  ${short(edges[i])} … ${short(edges[i + 1])}`, c, c > 2 * even));
    const dd = [0, 0, 0, 0];
    ks.forEach((k) => dd[fnv(k) % 4]++);
    const ddbRows = dd.map((c, i) => barRow(`partition ${i + 1}`, c, c > 2 * 6));
    bars.replaceChildren(
      h('div', { class: `${P}bg` }, h('h5', null, 'fdyno on FDB', h('span', null, 'by key range')), ...fdbRows),
      h('div', { class: `${P}bg` }, h('h5', null, 'DynamoDB', h('span', null, 'by hash of pk')), ...ddbRows),
    );
    keys.textContent = `Next ${BATCH} writes: ${ks[0]}, ${ks[1]}, … ${ks[BATCH - 1]}`;
    const max = Math.max(...counts);
    if (policy === 'time') {
      note.className = 'wv-note is-bad';
      note.textContent = splits === 0
        ? `All ${max} writes go to the last shard: every new time is larger than every boundary. DynamoDB spreads the same keys because it hashes them. Try splitting.`
        : `After ${splits} split${splits > 1 ? 's' : ''} there are more shards, but the next ${BATCH} writes all go to the new last shard again. A split cannot spread a key that only grows.`;
    } else {
      note.className = 'wv-note is-good';
      note.textContent = `The busiest shard gets ${max} of ${BATCH} writes. Customer IDs fall all over the key space, so both stores spread the load.`;
    }
    split.disabled = bounds.length >= 7;
  }

  app.append(pick.el, h('div', { class: 'wv-bar' }, split, again), keys, bars, note,
    colorKey([['k-ink', 'writes per shard or partition'], ['k-gap', 'more than twice its even share']]));
  paint();
}

/* ================================================================= WRITE */

const NODES = {
  wide: {
    vb: [640, 256],
    n: {
      fdyno: { x: 8, y: 92, w: 132, h: 64, l: ['fdyno', 'FDB client lib'] },
      grv: { x: 236, y: 22, w: 150, h: 40, l: ['GRV proxy'] },
      sto: { x: 470, y: 22, w: 162, h: 40, l: ['storage servers'] },
      cp: { x: 236, y: 112, w: 150, h: 40, l: ['commit proxy'] },
      res: { x: 470, y: 112, w: 162, h: 40, l: ['resolvers'] },
      log: { x: 236, y: 202, w: 150, h: 46, l: ['transaction logs'], disk: true },
    },
    e: {
      'f-grv': 'M140,110 L236,48',
      'f-sto': 'M74,92 V8 H551 V22',
      'f-cp': 'M140,132 H236',
      'cp-res': 'M386,132 H470',
      'cp-log': 'M311,152 V202',
      'log-sto': 'M386,225 H600 V62',
    },
  },
  tall: {
    vb: [360, 392],
    n: {
      fdyno: { x: 105, y: 6, w: 150, h: 52, l: ['fdyno', 'FDB client lib'] },
      grv: { x: 24, y: 108, w: 140, h: 40, l: ['GRV proxy'] },
      sto: { x: 206, y: 108, w: 140, h: 40, l: ['storage servers'] },
      cp: { x: 24, y: 222, w: 140, h: 40, l: ['commit proxy'] },
      res: { x: 206, y: 222, w: 140, h: 40, l: ['resolvers'] },
      log: { x: 24, y: 334, w: 140, h: 46, l: ['transaction logs'], disk: true },
    },
    e: {
      'f-grv': 'M140,58 L100,108',
      'f-sto': 'M220,58 L264,108',
      'f-cp': 'M105,32 H10 V242 H24',
      'cp-res': 'M164,242 H206',
      'cp-log': 'M94,262 V334',
      'log-sto': 'M164,368 H356 V128 H346',
    },
  },
};

const ITEM_KEY = 'Shop/i/CUST#42/ORDER#2026-10-17#9';
const IDX_OLD = 'Shop/x/ByStatus/OPEN/1792229400/CUST#42/ORDER#2026-10-17#9';
const IDX_NEW = 'Shop/x/ByStatus/PAID/1792229400/CUST#42/ORDER#2026-10-17#9';

const WROWS = [
  { at: 1, op: 'read', key: 'Shop/mr', val: 'schema revision; matches the cached schema' },
  { at: 2, op: 'read', key: ITEM_KEY, val: 'status = OPEN' },
  { at: 3, op: 'set', key: ITEM_KEY, val: 'status = PAID' },
  { at: 3, op: 'clear', key: IDX_OLD, val: '' },
  { at: 3, op: 'set', key: IDX_NEW, val: 'projected item' },
  { at: 4, op: 'set', key: 'Shop/v/⟨versionstamp, filled at commit⟩', done: "Shop/v/⟨V', #0⟩", val: 'MODIFY, old + new image' },
  { at: 4, op: 'set', key: 'receipts/m/7f3c…e1', val: 'typed result for retries' },
  { at: 4, op: 'set', key: 'receipts/x/29870538/7f3c…e1', val: 'expiry index entry' },
];

const WSTEPS = [
  { label: 'Read version', nodes: ['fdyno', 'grv'], edges: ['f-grv'],
    text: 'fdyno asks a GRV proxy for a read version. Every read in this transaction sees the database at <b>V = 8,104,220,113</b>.',
    fail: 'If fdyno crashes now, nothing is stored. The client gets no reply and can retry.' },
  { label: 'Schema', nodes: ['fdyno'], edges: [],
    text: 'fdyno checks the table’s schema revision <code>mr</code> at V. Another request already read it at this exact version, so the cached value is reused and no storage read is needed. The key still joins the read set.',
    fail: 'Nothing is stored yet. If someone changes the schema before commit, the commit conflicts.' },
  { label: 'Old item', nodes: ['fdyno', 'sto'], edges: ['f-sto'],
    text: 'One point read returns the current item at V: <code>status = OPEN</code>. The condition, if any, is checked on this value.',
    fail: 'Nothing is stored yet.' },
  { label: 'Item + index', nodes: ['fdyno'], edges: [],
    text: 'fdyno buffers the new item. The index key <code>status</code> changed, so one GSI entry moves: clear the OPEN entry, set the PAID entry. These are local writes; nothing has left fdyno.',
    fail: 'If fdyno crashes now, the buffer is lost and nothing is stored.' },
  { label: 'Stream + receipt', nodes: ['fdyno'], edges: [],
    text: 'fdyno buffers a stream record under a versionstamped key, not filled in yet, and a receipt with the result under this request’s operation ID.',
    fail: 'If fdyno crashes now, nothing is stored.' },
  { label: 'Commit', nodes: ['fdyno', 'cp', 'res'], edges: ['f-cp', 'cp-res'],
    text: "fdyno sends the whole write set. The commit proxy gives it <b>V' = 8,104,223,907</b>. Resolvers check the two read keys: neither changed between V and V'.",
    fail: 'If one had changed, the commit fails with 1020 and fdyno runs all steps again at a newer V. If the reply is lost from here on, fdyno gets 1021: see Figure 4.' },
  { label: 'Log fsync', nodes: ['cp', 'log'], edges: ['cp-log'],
    text: "The transaction logs write all six mutations to disk, on two or three machines in <code>double</code> or <code>triple</code> mode. The versionstamp becomes V'. The transaction is now committed.",
    fail: 'From here on, a crash of fdyno or of one machine does not lose the write.' },
  { label: 'Visible', nodes: ['log', 'sto', 'fdyno'], edges: ['log-sto'],
    text: "Storage servers pull the mutations from the logs. A read at V' or later sees the item, both index changes, the stream record, and the receipt together. fdyno replies HTTP 200.",
    fail: 'A read below V′ sees none of them. No reader can see half of the write.' },
];

function initWrite(fig, app) {
  const stage = h('div');
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const fail = h('p', { class: `${P}fail` });
  const table = h('div', { class: `${P}ws` });
  let i = 0; let wide = app.clientWidth >= 620;
  let G = null;

  function draw() {
    const L = wide ? NODES.wide : NODES.tall;
    const svg = s('svg', { viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img', 'aria-label': 'FoundationDB roles and the path of one transaction' });
    const id = `fdyarr${Math.random().toString(36).slice(2, 7)}`;
    svg.append(s('defs', null, s('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L8,4 L0,8 z', style: 'fill:var(--ink)' }))));
    const edges = {}; const nodes = {};
    for (const [k, d] of Object.entries(L.e)) { edges[k] = s('path', { d, class: 'edge', 'marker-end': `url(#${id})` }); svg.append(edges[k]); }
    for (const [k, n] of Object.entries(L.n)) {
      const g = s('g', { class: 'node' });
      g.append(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, class: 'box' }));
      if (n.disk) g.append(s('rect', { x: n.x + 8, y: n.y + 26, width: n.w - 16, height: 14, class: `${P}disk` }), s('text', { x: n.x + n.w / 2, y: n.y + 36.5, class: 't-xs', 'text-anchor': 'middle' }, 'mutation log on disk'));
      n.l.forEach((t, j) => g.append(s('text', { x: n.x + n.w / 2, y: n.y + (n.disk ? 18 : n.h / 2 + 4 + (j - (n.l.length - 1) / 2) * 15), class: j ? 't-xs t-mute' : 't-s t-b', 'text-anchor': 'middle' }, t)));
      nodes[k] = g; svg.append(g);
    }
    stage.replaceChildren(svg);
    G = { edges, nodes };
  }

  function render(k) {
    i = k;
    const st = WSTEPS[k];
    for (const [name, g] of Object.entries(G.nodes)) {
      g.classList.toggle('is-focus', st.nodes.includes(name));
      g.classList.toggle('is-dim', !st.nodes.includes(name));
    }
    for (const [name, e] of Object.entries(G.edges)) {
      const on = st.edges.includes(name);
      e.classList.toggle('is-dim', !on);
      e.classList.toggle(`${P}on`, on);
    }
    note.innerHTML = st.text;
    fail.textContent = st.fail;
    const committed = k >= 6;
    const rows = WROWS.filter((r) => r.at <= k).map((r) => {
      const isRead = r.op === 'read';
      const state = isRead ? (committed ? 'checked' : 'read at V') : (committed ? 'committed' : 'buffered in fdyno');
      const cls = r.at === k ? `${P}new` : (committed && !isRead ? 'is-held' : '');
      const key = committed && r.done ? r.done : r.key;
      return `<div class="${P}wr ${cls}"><span class="${P}op">${r.op}</span><span class="${P}tk">${esc(key)}</span><span class="${P}wv">${esc(r.val)}${r.val ? ' · ' : ''}<b>${state}</b></span></div>`;
    });
    table.innerHTML = rows.length ? rows.join('') : `<div class="${P}wr"><span></span><span class="${P}wv">write set is empty</span></div>`;
  }

  const box = h('div');
  const st = stepper(box, WSTEPS, (k) => render(k));
  box.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation(); });
  box.tabIndex = -1;
  box.append(st.el, stage, note, fail, h('div', { class: `${P}wsh` }, 'Write set'), table,
    colorKey([['k-look', 'this step'], ['k-held', 'committed']]));
  app.append(box);
  draw();
  st.go(0);
  onBreak(app, 620, (w) => { wide = w; draw(); render(i); });
}

/* ================================================================= RETRY */

function initRetry(fig, app) {
  let op = 'add'; let reached = 'yes'; let rcpt = 'off';
  const out = h('div', { class: `${P}att` });
  const verdict = h('div', { class: 'wv-verdict', 'aria-live': 'polite' });
  const q = ask(
    'n = 5. fdyno runs UpdateItem ADD n 1. The commit reaches the logs, then the reply is lost (1021). FDB’s retry loop runs the function again, with no receipt. What is n now?',
    [[5, 'n = 5'], [6, 'n = 6'], [7, 'n = 7']], 7,
    (v, right) => (right
      ? 'Right. The second run reads n = 6, the value the first attempt committed, and adds 1 again. Below, turn receipts on.'
      : `It is 7. The first attempt committed n = 6. The second run reads 6 and adds 1 again. Below, turn receipts on.`),
  );
  const rOp = pickRow('Operation', [['add', 'ADD n 1'], ['set', 'SET status = PAID']], op, (v) => { op = v; paint(); });
  const rReached = pickRow('First commit', [['yes', 'reached the logs'], ['no', 'did not']], reached, (v) => { reached = v; paint(); });
  const rRcpt = pickRow('Receipts', [['off', 'off'], ['on', 'on']], rcpt, (v) => { rcpt = v; paint(); });

  function paint() {
    const add = op === 'add';
    const committed1 = reached === 'yes';
    const id = '7f3c…e1';
    const val = (n, st) => (add ? `n = ${n}` : `status = ${st}`);
    let n = 5; let status = 'OPEN'; let records = 0;
    const a1 = [];
    if (rcpt === 'on') a1.push(['', `id = ${id}, created once before the loop`], ['', 'skip receipt read: the id is new']);
    a1.push(['', `read item: ${val(5, 'OPEN')}`], ['', `write ${val(6, 'PAID')}`]);
    if (rcpt === 'on') a1.push(['', `write receipt ${id}`]);
    a1.push(['bad', 'commit → reply lost (1021)']);
    if (committed1) { n = 6; status = 'PAID'; records = 1; a1.push(['', 'the logs have it: committed']); } else a1.push(['', 'never reached the logs: not committed']);

    const a2 = [];
    let reply;
    if (rcpt === 'on' && committed1) {
      a2.push(['', `read receipt ${id}: found`], ['good', `return the stored result (${val(6, 'PAID')}); write nothing`]);
      reply = val(6, 'PAID');
    } else {
      if (rcpt === 'on') a2.push(['', `read receipt ${id}: absent`]);
      const nn = n + 1;
      a2.push(['', `read item: ${val(n, status)}`]);
      if (add) { a2.push([committed1 ? 'bad' : '', `write n = ${nn}`]); n = nn; records++; } else {
        if (status === 'PAID') a2.push(['', 'write status = PAID: same value, no stream record']); else { a2.push(['', 'write status = PAID']); records++; }
        status = 'PAID';
      }
      a2.push(['', 'commit → ok']);
      reply = val(n, status);
    }
    const card = (title, lines, cls) => h('div', { class: `wv-card ${cls}` }, h('h5', null, title),
      h('ul', { class: `${P}ul` }, ...lines.map(([c, t]) => h('li', { class: c ? `c-${c === 'good' ? 'safe' : 'bad'}` : '' }, t))));
    out.replaceChildren(card('Attempt 1', a1, ''), card('Attempt 2 (FDB retry)', a2, ''));
    const ok = add ? n === 6 : status === 'PAID';
    verdict.className = `wv-verdict ${ok ? 'is-good' : 'is-bad'}`;
    verdict.textContent = ok
      ? `Final item: ${val(n, status)}. ${records} stream record${records === 1 ? '' : 's'}. Client gets ${reply}. Applied once.`
      : `Final item: n = ${n}. ${records} stream records. Client gets ${reply}. The increment was applied twice.`;
  }

  app.append(q.el, h('div', { class: `${P}ctl` }, rOp.el, rReached.el, rRcpt.el), out, verdict,
    colorKey([['k-safe', 'correct'], ['k-gap', 'applied twice or lost reply']]));
  paint();
}

/* =================================================================== CDC */

/* Sample commit versions. SequenceNumber = 30-digit decimal of the 12-byte
   versionstamp: 8-byte commit version, 2-byte batch order (0 here), 2-byte
   user version. */
const seqOf = (v, u) => ((BigInt(v) << 32n) | BigInt(u)).toString().padStart(30, '0');
const vfmt = (v) => v.toLocaleString('en-US');
/* Sample hash values: h mod 2 picks the shard before the split, h mod 4 after. */
const HMOD = { 'CUST#41': 1, 'CUST#42': 2, 'CUST#43': 3 };
const SPLIT_V = 8104226000;
const RECS = [
  { id: 'w1', at: 0, v: 8104223907, u: 0, pk: 'CUST#42', ev: 'INSERT', old: true },
  { id: 'w2', at: 0, v: 8104224120, u: 0, pk: 'CUST#43', ev: 'MODIFY', old: true },
  { id: 'w3', at: 0, v: 8104224388, u: 0, pk: 'CUST#42', ev: 'MODIFY', old: true },
  { id: 't0', at: 1, v: 8104225001, u: 0, pk: 'CUST#41', ev: 'MODIFY' },
  { id: 't1', at: 1, v: 8104225001, u: 1, pk: 'CUST#42', ev: 'MODIFY' },
  { id: 'w4', at: 3, v: 8104226450, u: 0, pk: 'CUST#42', ev: 'MODIFY' },
  { id: 'w5', at: 3, v: 8104226702, u: 0, pk: 'CUST#43', ev: 'REMOVE' },
];
const shardOfRec = (r) => (r.v < SPLIT_V ? `0/${HMOD[r.pk] % 2}` : `1/${HMOD[r.pk] % 4}`);

const CSTEPS = [
  { label: 'Writes',
    text: 'Three single-item writes. Each record’s key holds its commit version, so each shard is in commit order. CUST#42 hashes to shard 0 and CUST#43 to shard 1 (sample hash values).' },
  { label: 'One transaction',
    text: 'A <code>TransactWriteItems</code> changes CUST#41 and CUST#42. Both records get the same commit version, 8,104,225,001, with user versions #0 and #1. They go to different shards, but no reader sees one without the other.' },
  { label: 'Consumer',
    text: 'A consumer reads shard 0 with one <code>GetRecords</code> call: one range read from its iterator, three records, in commit order. It saves the last sequence number as its checkpoint. Nobody has read shard 1 yet.' },
  { label: 'Split 2 → 4',
    text: '<code>UpdateStreamShardCount</code> to 4 commits at 8,104,226,000. That versionstamp is the boundary: old shards are sealed below it, new shards start above it. New shard j has parent j mod 2. CUST#42 (h mod 4 = 2) now writes to new shard 2, whose parent is old shard 0, where its earlier records are.' },
  { label: 'Trim',
    text: 'The trimmer deletes records older than the retention period from the start of each shard, and stores the first kept key as the trim head. Shard 0’s consumer had already read past it. Shard 1 had an unread record, so a <code>TRIM_HORIZON</code> iterator made before the trim now gets <code>TrimmedDataAccessException</code>.' },
];

function initCdc(fig, app) {
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const lanes = h('div', { class: `${P}lanes` });
  const seq = h('p', { class: `${P}seq` });

  function lane(key, k) {
    const [e, sh] = key.split('/').map(Number);
    const recs = RECS.filter((r) => r.at <= k && shardOfRec(r) === key);
    const sealed = e === 0 && k >= 3;
    const trimmed = k >= 4;
    const kids = [];
    // consumer on 0/0: read through t1 from step 2 on; consumer on 0/1: iterator at the start, made at step 2
    const readThrough = key === '0/0' && k >= 2 ? 't1' : null;
    let read = !!readThrough;
    if (key === '0/1' && k >= 2) kids.push(h('span', { class: `${P}it ${trimmed ? 'is-bad' : ''}` }, trimmed ? '▲ iterator: TrimmedDataAccessException' : '▲ iterator (TRIM_HORIZON)'));
    for (const r of recs) {
      const gone = trimmed && r.old;
      const cls = gone ? (key === '0/1' ? 'is-lost' : 'is-gone') : (r.at === k ? 'is-new' : (read ? 'is-read' : ''));
      kids.push(h('span', { class: `${P}rec ${cls}`, 'data-id': r.id, title: `SequenceNumber ${seqOf(r.v, r.u)}` },
        h('b', null, `${r.pk} ${r.ev}`), h('small', null, `V ${vfmt(r.v)} · #${r.u}`)));
      if (r.id === readThrough) { kids.push(h('span', { class: `${P}it is-good` }, '▲ checkpoint')); read = false; }
    }
    if (trimmed && key.startsWith('0/')) {
      const firstKept = recs.find((r) => !r.old);
      if (firstKept) kids.splice(kids.findIndex((x) => x.dataset && x.dataset.id === firstKept.id), 0, h('span', { class: `${P}th` }, '│ trim head'));
    }
    if (!recs.length && !kids.length) kids.push(h('span', { class: `${P}empty` }, 'no records yet'));
    const head = h('div', { class: `${P}lh` },
      h('b', null, `${e ? 'new' : 'old'} shard ${sh}`),
      e ? h('span', null, `parent: old shard ${sh % 2}`) : null,
      sealed ? h('span', null, `sealed at V ${vfmt(SPLIT_V)}`) : null);
    return h('div', { class: `${P}lane ${sealed ? 'is-sealed' : ''}` }, head, h('div', { class: `${P}track` }, ...kids));
  }

  function render(k) {
    const keys = ['0/0', '0/1', ...(k >= 3 ? ['1/0', '1/1', '1/2', '1/3'] : [])];
    lanes.replaceChildren(...keys.map((key) => lane(key, k)));
    note.innerHTML = CSTEPS[k].text;
    const fresh = RECS.filter((r) => r.at === k);
    seq.textContent = fresh.length
      ? `SequenceNumber of ${fresh[fresh.length - 1].pk}: ${seqOf(fresh[fresh.length - 1].v, fresh[fresh.length - 1].u)}`
      : '';
  }

  const box = h('div');
  const st = stepper(box, CSTEPS, (k) => render(k));
  box.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation(); });
  box.append(st.el, note, lanes, seq,
    colorKey([['k-data', 'stream record'], ['k-look', 'new in this step'], ['k-held', 'read by the consumer'], ['k-gap', 'deleted before anyone read it']]));
  app.append(box);
  st.go(0);
}

register({ 'fdy-access': initAccess, 'fdy-hot': initHot, 'fdy-write': initWrite, 'fdy-retry': initRetry, 'fdy-cdc': initCdc });

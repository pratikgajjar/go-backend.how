/*
 * Figures for "Building a pre-owned car platform with Valkey, part 2".
 * House style (walviz.css); this file only draws and wires interactions.
 *
 *   filter-sets      the reader switches filters; each is a row of car ids,
 *                    and the columns full in every row are the page
 *   listing-request  one query: miss, hit, sale, stale id (stepper)
 *   reco-order       predict Valkey writes on retrain; one set, two buyers
 *
 * Sample data: 12 cars, page size 3. Valkey replies were produced by running
 * the same commands on Valkey 9.1 with this data. LightFM scores are made up.
 */
import { h, colorKey, codeBlock, stepper, chips, ask, register, REDUCED } from './lib.js';

const P = 'v-vk2-';


// id, model, variant, make_id, city_id, price, has AMT (feature 20), body
const CARS = [
  [101, 'Nexon', 'XM', 10, 1, 775000, 1, 'SUV'],
  [102, 'Tiago', 'XZ', 10, 1, 455000, 1, 'hatch'],
  [103, 'Swift', 'VXI', 11, 1, 590000, 1, 'hatch'],
  [104, 'i20', 'Asta', 12, 1, 720000, 1, 'hatch'],
  [105, 'Creta', 'SX', 12, 1, 1150000, 1, 'SUV'],
  [106, 'Punch', 'Adventure', 10, 2, 610000, 1, 'SUV'],
  [107, 'Venue', 'S', 12, 1, 805000, 1, 'SUV'],
  [108, 'Altroz', 'XE', 10, 1, 520000, 0, 'hatch'],
  [109, 'Grand i10', 'Sportz', 12, 1, 430000, 1, 'hatch'],
  [110, 'Baleno', 'Zeta', 11, 2, 640000, 0, 'hatch'],
  [111, 'Nexon', 'XZ+', 10, 1, 690000, 1, 'SUV'],
  [112, 'Exter', 'SX', 12, 2, 560000, 1, 'SUV'],
].map(([id, model, variant, make, city, price, amt, body]) => ({ id, model, variant, make, city, price, amt, body }));
const CAR = Object.fromEntries(CARS.map((c) => [c.id, c]));
const lakh = (p) => `₹${(p / 100000).toFixed(2)} L`;

/* The sample request's four filter sets (ZRANGESTORE / ZUNIONSTORE outputs). */
const ROWS = [
  { id: 'city', key: 'car:city', f: 'city_id=1', test: (c) => c.city === 1 },
  { id: 'price', key: 'car:price', f: 'price 4–8 L', test: (c) => c.price >= 400000 && c.price <= 800000 },
  { id: 'make', key: 'car:make', f: 'make 10 ∪ 12', test: (c) => c.make === 10 || c.make === 12 },
  { id: 'amt', key: 'car:feature:20', f: 'AMT', test: (c) => c.amt === 1 },
];
const RESULT = CARS.filter((c) => ROWS.every((r) => r.test(c))).sort((a, b) => a.price - b.price);
const RES_IDS = new Set(RESULT.map((c) => c.id));

const HASH = '6d53b067e30c6df93d'; // sha1("city_id=1&features=20&make=10,12&price_max=800000&price_min=400000")[:18]
const KEY = `page:price:${HASH}`;
const CANON = 'city_id=1&features=20&make=10,12&price_max=800000&price_min=400000';


/* ------------------------------------------------------------ helpers */

/* Arrow keys step a figure; keep them from also reaching the site's
   post-to-post keyboard navigation on document. */
function holdArrows(fig) {
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') e.stopPropagation();
  });
}

const label = (text) => h('div', { class: `wv-title ${P}lab` }, text);
const name = (c) => `${c.model} ${lakh(c.price)}`;

/* Set strip: one row per set, one column per car. cell(r, c) → state class. */
function strip({ rows, cols, cell, rowCls = () => '' }) {
  const t = h('div', { class: `${P}strip`, style: `--n:${cols.length}` });
  t.append(h('div', { class: `${P}sl t-xs` }, 'car 101–112'),
    ...cols.map((c) => h('div', { class: `${P}sh t-xs` }, String(c.id).slice(1))));
  for (const r of rows) {
    t.append(h('div', { class: `${P}sl ${rowCls(r)}` }, h('b', { class: 't-s' }, r.key), h('span', { class: 't-xs' }, r.f)),
      ...cols.map((c) => { const [cls, title] = [].concat(cell(r, c)); return h('div', { class: `${P}sc ${cls || ''}`, title: title || '' }); }));
  }
  return t;
}

/* ========================================================= FILTER SETS */

function initFilterSets(fig, app) {
  const LABEL = { city: 'Mumbai', price: '₹4–8 L', make: 'Tata or Hyundai', amt: 'AMT' };
  let on = ROWS.map((r) => r.id);
  const pick = chips(ROWS.map((r) => [r.id, LABEL[r.id]]), (v) => { on = v; draw(); }, { value: on, multi: true, label: 'Filters' });
  const stripBox = h('div', { class: `${P}fs` });
  const out = h('p', { class: `${P}out`, 'aria-live': 'polite' });
  app.append(label('Filters · tap to switch'), pick.el, stripBox, out,
    colorKey([['k-ink', 'car is in that set'], ['k-look', 'in every set: on the page'], ['k-opt', 'filters you switch']]));

  function draw() {
    const rows = ROWS.filter((r) => on.includes(r.id));
    const page = CARS.filter((c) => rows.every((r) => r.test(c))).sort((a, b) => a.price - b.price);
    const ids = new Set(page.map((c) => c.id));
    const shown = rows.length ? rows : [{ id: 'none', key: 'car:price', f: 'no filter: every car', test: () => true }];
    stripBox.replaceChildren(strip({
      rows: [...shown, { id: 'res', key: 'the page', f: 'in every row' }], cols: CARS,
      rowCls: (r) => (r.id === 'res' ? 'is-res' : ''),
      cell: (r, c) => (r.id === 'res' ? (ids.has(c.id) ? 'is-look' : '') : (r.test(c) ? 'is-in' : '')),
    }));
    out.replaceChildren(h('b', { class: 'c-look' }, `${page.length} car${page.length === 1 ? '' : 's'}`),
      page.length ? `, cheapest first: ${page.map(name).join(' · ')}` : ': no car is in every set');
  }
  draw();
}

/* ========================================================= RECO ORDER */
const RECO_KEY = 'page:reco:921f36dad9ad8b977d'; // sha1("city_id=1")[:18]
const RECO_IDS = [101, 102, 103, 104, 105, 107, 108, 109, 111];
const SCORES = {
  A: {
    v1: { 107: 1.92, 101: 1.71, 111: 1.64, 105: 1.12, 104: 0.61, 103: 0.22, 108: 0.05, 102: -0.31, 109: -0.48 },
    v2: { 111: 1.88, 107: 1.80, 101: 1.52, 105: 1.30, 104: 0.44, 108: 0.12, 103: 0.09, 109: -0.36, 102: -0.40 },
  },
  B: {
    v1: { 102: 1.84, 109: 1.77, 108: 1.35, 103: 1.21, 104: 0.66, 111: 0.18, 101: -0.12, 107: -0.35, 105: -0.90 },
    v2: { 109: 1.95, 103: 1.49, 102: 1.41, 108: 1.38, 104: 0.52, 111: 0.30, 101: -0.08, 107: -0.41, 105: -0.97 },
  },
};
const BUYERS = [['A', 'Buyer A', 'browsed SUVs'], ['B', 'Buyer B', 'browsed hatchbacks']];
const PAGE = 3;


function initReco(fig, app) {
  let model = 'v1';
  let answered = false;
  const writes = h('span');
  const setBox = h('div', { class: `wv-card ${P}rest` },
    h('p', null, h('b', null, RECO_KEY), ' · set · 9 ids, no order, no scores', writes),
    h('div', { class: `${P}ids` }, ...RECO_IDS.map((id) => h('i', null, String(id)))));

  const lanes = BUYERS.map(([b, who, what]) => {
    const row = h('div', { class: `${P}lane` });
    const cells = {};
    for (const id of RECO_IDS) {
      const sc = h('span', { class: 't-xs' });
      const el = h('div', { class: `${P}rc`, title: `${CAR[id].model} ${CAR[id].variant}, ${CAR[id].body}` },
        h('b', null, String(id)), h('span', { class: 't-xs' }, CAR[id].model), sc);
      cells[id] = { el, sc };
      row.append(el);
    }
    return { b, row, cells, el: h('div', { class: `${P}lanebox` }, h('p', { class: 't-s' }, h('b', null, who), ` · ${what} · `, h('span', { class: 'c-look' }, 'first 3 = page 1')), row) };
  });

  const modelPick = chips([['v1', 'model 10:00'], ['v2', 'model 10:45, retrained']], (v) => { model = v; render(); }, { value: model, label: 'Model version' });
  const modelRow = h('div', { hidden: true }, label('Model in the web server'), modelPick.el);
  const q = ask('At 10:45 the model is retrained, and both buyers get a new order. How many Valkey keys must be rewritten?',
    [[0, '0'], [1, '1'], [2, 'one per buyer']], 0,
    () => {
      answered = true; model = 'v2'; modelPick.set('v2'); modelRow.hidden = false; setTimeout(render);
      return '<b>0.</b> The set holds members only. The web server computes the order on each request, so a retrain changes the rows below and writes nothing to Valkey. Switch the model back and forth.';
    });

  app.append(q.el, modelRow, setBox,
    h('p', { class: `t-s ${P}fan` }, '↓ SMEMBERS, then LightFM in the web server scores each id for this buyer'),
    ...lanes.map((l) => l.el),
    colorKey([['k-ink', 'car ids'], ['k-look', 'page 1 for this buyer'], ['k-opt', 'answer, model version']]));

  let first = true;
  function render() {
    for (const l of lanes) {
      const sc = SCORES[l.b][model];
      const ranked = [...RECO_IDS].sort((a, b) => sc[b] - sc[a]);
      const before = {};
      if (!first) for (const id of RECO_IDS) { const r = l.cells[id].el.getBoundingClientRect(); before[id] = [r.left, r.top]; }
      ranked.forEach((id, k) => {
        const c = l.cells[id];
        l.row.append(c.el);
        c.el.classList.toggle('is-page', k < PAGE);
        c.sc.textContent = sc[id].toFixed(2);
      });
      if (!first && !REDUCED) {
        for (const id of RECO_IDS) {
          const r = l.cells[id].el.getBoundingClientRect();
          const dx = before[id][0] - r.left; const dy = before[id][1] - r.top;
          if (Math.abs(dx) + Math.abs(dy) > 1) l.cells[id].el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.3,.7,.3,1)' });
        }
      }
    }
    first = false;
    writes.textContent = answered ? ' · unchanged by the retrain' : '';
  }
  render();
}

/* ==================================================== LISTING REQUEST */

// Terminal lines: [kind, text]. kind: c = command, r = reply, n = nil/miss,
// q = queued (not sent yet), m = comment.
const K = KEY;
const STEPS = [
  {
    label: 'Request', who: 'request 1', rt: 0, cmds: 0,
    title: 'The buyer applies four filters',
    text: `The view turns the query string into a canonical form: it drops <code>page</code> and <code>ordering</code>, sorts the keys, and sorts the ids. The key is <code>page:price:</code> plus the first 18 hex digits of its sha1.`,
    term: [['m', '# GET /listing/?make=12,10&price_max=800000&city_id=1&price_min=400000&features=20&ordering=price&page=1'], ['m', `# canonical: ${CANON}`], ['m', `# key: ${K}`]],
    strip: { read: 0 },
  },
  {
    label: 'Lookup', who: 'request 1', rt: 1, cmds: 2,
    title: 'Round trip 1: is the result cached?',
    text: 'Both commands go in one pipeline. The key does not exist, so this is a miss. <code>ZINTERSTORE</code> never stores an empty result, so a filter that matches no car misses on every request.',
    term: [['c', `ZCARD ${K}`], ['n', '(integer) 0'], ['c', `ZRANGE ${K} 0 2`], ['n', '(empty array)']],
    strip: { read: 0, res: 'nil' }, tone: 'bad',
  },
  {
    label: 'Filter sets', who: 'request 1', rt: 1, cmds: 2, queued: 5,
    title: 'Each filter reads one index',
    text: 'Each index is a sorted set of car ids scored by one attribute, so a range read is <code>O(log N + M)</code>. <code>make=10,12</code> is a union. These commands wait in the client pipeline.',
    term: [
      ['q', 'ZRANGESTORE tmp:6d53…:city car:city 1 1 BYSCORE'],
      ['q', 'ZRANGESTORE tmp:6d53…:price car:price 400000 800000 BYSCORE'],
      ['q', 'ZRANGESTORE tmp:6d53…:m10 car:make 10 10 BYSCORE'],
      ['q', 'ZRANGESTORE tmp:6d53…:m12 car:make 12 12 BYSCORE'],
      ['q', 'ZUNIONSTORE tmp:6d53…:make 2 tmp:6d53…:m10 tmp:6d53…:m12'],
    ],
    strip: { read: 4 },
  },
  {
    label: 'Intersect', who: 'request 1', rt: 2, cmds: 11,
    title: 'Round trip 2: intersect, store, read page 1',
    text: 'The cars in all four sets are the result. <code>WEIGHTS 1 0 0 0</code> keeps only the price as the score, so the stored set is already in price order.',
    term: [
      ['c', 'ZRANGESTORE … ZUNIONSTORE …  (5 commands above)'], ['r', '(integer) 9 · 10 · 5 · 5 · 10'],
      ['c', `ZINTERSTORE ${K} 4 tmp:6d53…:price tmp:6d53…:city tmp:6d53…:make car:feature:20 WEIGHTS 1 0 0 0`], ['r', '(integer) 5'],
      ['c', `EXPIRE ${K} 600`], ['r', '(integer) 1'],
      ['c', 'DEL tmp:6d53…:city tmp:6d53…:price tmp:6d53…:m10 tmp:6d53…:m12 tmp:6d53…:make'], ['r', '(integer) 5'],
      ['c', `ZRANGE ${K} 0 2`], ['r', '1) "109"  2) "102"  3) "111"'],
    ],
    strip: { read: 4, res: 'new' },
  },
  {
    label: 'Page 1', who: 'request 1', rt: 3, cmds: 12,
    title: 'Round trip 3: one HMGET for the whole page',
    text: 'A miss costs 3 round trips for 12 commands. Sent one by one, the same commands take 12 round trips.',
    term: [['c', 'HMGET car: 109 102 111'], ['r', '1) "{\\"id\\":109,\\"price\\":430000,\\"model_name\\":\\"Grand i10\\",…}"'], ['r', '2) "{\\"id\\":102,\\"price\\":455000,…}"'], ['r', '3) "{\\"id\\":111,\\"price\\":690000,…}"']],
    phone: [109, 102, 111], pageNo: 1, strip: { read: 4, res: 'ttl', ttl: 600 }, tone: 'good',
  },
  {
    label: 'Page 2', who: 'request 2', rt: 2, cmds: 3,
    title: 'Page 2, filters in another order: a hit',
    text: 'No index is read. Page <i>n</i> is <code>ZRANGE key (n−1)×size n×size−1</code>.',
    term: [['m', '# GET /listing/?city_id=1&features=20&make=10,12&price_min=400000&price_max=800000&ordering=price&page=2'], ['c', `ZCARD ${K}`], ['r', '(integer) 5'], ['c', `ZRANGE ${K} 3 5`], ['r', '1) "104"  2) "101"'], ['c', 'HMGET car: 104 101'], ['r', '1) "{\\"id\\":104,…}"  2) "{\\"id\\":101,…}"']],
    phone: [104, 101], pageNo: 2,
    strip: { read: 4, res: 'ttl', ttl: 540 }, tone: 'good',
    ask: { q: 'Same filters in another order, now page 2. Hit or miss?', opts: ['hit', 'miss'], right: 'hit', why: 'The canonical form sorts the keys and the ids, so the key is the same.' },
  },
  {
    label: 'Sold', who: 'CDC write', rt: 1, cmds: 5, cdc: true,
    title: 'Car 111 is sold',
    text: 'The change-log consumer removes 111 from the hash and from every index. The stored result is not an index, and it still holds 111 until its TTL ends.',
    term: [['m', '# change log: car 111 status → sold'], ['c', 'HDEL car: 111'], ['r', '(integer) 1'], ['c', 'ZREM car:price 111'], ['r', '(integer) 1'], ['c', 'ZREM car:city 111 · car:make 111 · car:feature:20 111'], ['r', '(integer) 1 · 1 · 1']],
    strip: { read: 4, res: 'ttl', ttl: 500, sold: true }, tone: 'bad',
  },
  {
    label: 'Stale id', who: 'request 3', rt: 2, cmds: 3,
    title: 'Page 1 again, before the TTL ends',
    text: 'Until the key expires, page 1 has 2 cars and the count says 5. A new query builds from the indexes, which no longer hold 111.',
    term: [['c', `ZCARD ${K}`], ['r', '(integer) 5'], ['c', `ZRANGE ${K} 0 2`], ['r', '1) "109"  2) "102"  3) "111"'], ['c', 'HMGET car: 109 102 111'], ['r', '1) "{\\"id\\":109,…}"  2) "{\\"id\\":102,…}"'], ['n', '3) (nil)']],
    phone: [109, 102], pageNo: 1, stale: true, strip: { read: 4, res: 'ttl', ttl: 480, sold: true }, tone: 'bad',
    ask: { q: 'Car 111 was just sold. The buyer opens page 1 again. How many cars does it show?', opts: ['3', '2', 'an error'], right: '2', why: 'The stored result still holds 111. HMGET returns nil for it, and the view skips it.' },
  },
];

function termLines(term) {
  const lines = []; const hot = [];
  for (const [k, t] of term) {
    if (k === 'c') lines.push(`> ${t}`);
    else if (k === 'q') { hot.push(lines.length); lines.push(`+ ${t}`); }
    else if (k === 'r') lines.push(`  ${t}`);
    else if (k === 'n') lines.push(`  ⟦${t}⟧`);
    else lines.push(`// ${t.replace(/^# /, '')}`);
  }
  return codeBlock(lines, hot);
}

function initListing(fig, app) {
  let cur = 0;
  const answers = {};
  const asks = {};
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const askBox = h('div');
  const term = h('div', { class: `${P}term` });
  const meter = h('p', { class: `t-s ${P}meter` });
  const stripBox = h('div', { class: `${P}lstrip` });
  const sees = h('p', { class: `${P}out` });
  const stp = stepper(fig, STEPS, (i) => { cur = i; render(); });
  holdArrows(fig);
  app.append(stp.el, note, askBox, label('valkey-cli'), term, meter, stripBox, sees,
    colorKey([['k-ink', 'car is in that index'], ['k-look', 'the stored result'], ['k-safe', 'hit'], ['k-gap', 'miss, sold car']]));

  function renderStrip(st) {
    const { read, res, ttl, sold } = st.strip;
    const rows = [...ROWS, { id: 'res', key: 'page:price:6d53…', f: res === 'new' || res === 'ttl' ? `zset · TTL ${ttl || 600} s` : 'not stored' }];
    stripBox.replaceChildren(label('Valkey: the four indexes and the stored result'),
      strip({
        rows, cols: CARS,
        rowCls: (r) => (r.id === 'res' ? `is-res${res === 'nil' ? ' is-miss' : ''}` : ''),
        cell: (r, c) => {
          if (r.id === 'res') {
            if (!res || res === 'nil' || !RES_IDS.has(c.id)) return '';
            return sold && c.id === 111 ? ['is-stale', '111 is still in the stored result'] : 'is-look';
          }
          if (sold && c.id === 111 && r.test(c)) return ['is-gone', 'removed by ZREM'];
          return read > 0 && r.test(c) ? 'is-in' : '';
        },
      }));
  }

  function render() {
    const st0 = STEPS[cur];
    const pending = st0.ask && !(cur in answers);
    const st = pending ? { ...st0, tone: null, term: st0.term.filter(([k]) => k === 'c' || k === 'm'), phone: null } : st0;
    note.className = `wv-note${st.tone ? ` is-${st.tone}` : ''}`;
    note.replaceChildren(h('span', { class: 'k' }, st.who), h('b', null, st.title));
    if (!pending) { const p = h('p'); p.innerHTML = st.text; note.append(p); }
    if (st0.ask) {
      asks[cur] ??= ask(`Guess first. ${st0.ask.q}`, st0.ask.opts.map((o) => [o, o]), st0.ask.right, (v) => {
        answers[cur] = v; setTimeout(render); return st0.ask.why;
      }).el;
      askBox.replaceChildren(asks[cur]);
    } else askBox.replaceChildren();
    term.innerHTML = termLines(st.term);
    meter.hidden = pending || !st.cmds;
    meter.textContent = `${st.who}: ${st.rt} round trip${st.rt === 1 ? '' : 's'}, ${st.cmds} commands${st.queued ? `, ${st.queued} more queued` : ''}`;
    renderStrip(st);
    if (st.phone) {
      sees.replaceChildren(h('b', { class: st.stale ? 'c-bad' : '' }, `Buyer sees page ${st.pageNo} of 2, ${st.phone.length} car${st.phone.length === 1 ? '' : 's'}`),
        `: ${st.phone.map((id) => name(CAR[id])).join(' · ')}${st.stale ? ' (111 is skipped)' : ''}`);
    } else sees.replaceChildren(h('span', { class: 't-s' }, st.cdc ? 'No buyer request in this step.' : 'The buyer is waiting for the page.'));
  }
  stp.go(0);
}

register({ 'filter-sets': initFilterSets, 'reco-order': initReco, 'listing-request': initListing });

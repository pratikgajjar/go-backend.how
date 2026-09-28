/*
 * Figures for "Building pre-owned Car Platform With Valkey - Part 2".
 * House style (walviz.css); this file only draws and wires interactions.
 *
 *   sql-joins        guess the joins for make=, then switch filters and see
 *                    the tables Django joins and the SQL it generates
 *   filter-sets      the reader switches filters; each is a row of car ids,
 *                    and the columns full in every row are the page
 *   keys             car: hash / car:price index, predict the reply
 *   listing-request  one query: miss, hit, sale, stale id (stepper)
 *   reco-order       predict Valkey writes on retrain; one set, two buyers
 *
 * Sample data: 12 cars. Valkey replies were produced by running the same
 * commands on Valkey 9.1 with this data; the SQL is what Django 6.1 +
 * django-filter 26.1 generate (SQLite backend, quotes removed).
 * LightFM scores are made up.
 */
import { h, s, colorKey, codeBlock, stepper, range, chips, ask, register, REDUCED, fmt } from './lib.js';

const P = 'v-vk2-';

/* ---------------------------------------------------------------- data */
/* ---------------------------------------------------------------- data */

const CITY = { 1: 'Mumbai', 2: 'Pune' };
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

/* Set strip: one row per set, one column per car. cell(r, c) → state class. */
function strip({ rows, cols, cell, rowCls = () => '' }) {
  const t = h('div', { class: `${P}strip`, style: `--n:${cols.length}` });
  t.append(h('div', { class: `${P}sl t-xs t-mute` }, 'cars 101–112'),
    ...cols.map((c) => h('div', { class: `${P}sh t-xs` }, String(c.id).slice(1))));
  for (const r of rows) {
    t.append(h('div', { class: `${P}sl ${rowCls(r)}` }, h('b', { class: 'c-data t-s' }, r.key), h('span', { class: 't-xs' }, r.f)),
      ...cols.map((c) => { const [cls, title] = [].concat(cell(r, c)); return h('div', { class: `${P}sc ${cls || ''}`, title: title || '' }); }));
  }
  return t;
}

/* What the buyer sees: a small listing screen built from cards. */
function screen(kids) {
  return h('div', { class: `wv-card ${P}screen` }, h('div', { class: `wv-title ${P}lab` }, 'car.com · listing page'), ...kids);
}
function carCard(c, extra = '') {
  return h('div', { class: `wv-card ${P}car` }, h('b', null, `${c.model} ${c.variant}`), h('span', { class: 'c-data t-s' }, `${lakh(c.price)}${extra} · #${c.id}`));
}

/* ========================================================= FILTER SETS */

function initFilterSets(fig, app) {
  const LABEL = { city: 'Mumbai', price: '₹4–8 L', make: 'Tata or Hyundai', amt: 'AMT' };
  let on = ROWS.map((r) => r.id);
  const pick = chips(ROWS.map((r) => [r.id, LABEL[r.id]]), (v) => { on = v; draw(); }, { value: on, multi: true, label: 'Filters' });
  const stripBox = h('div');
  const shot = h('div', { 'aria-live': 'polite' });
  const kv = h('dl', { class: 'wv-kv' });
  app.append(label('Filters · tap to switch'), pick.el,
    h('div', { class: `${P}two` }, stripBox, shot), kv,
    colorKey([['k-data', 'car is in that set'], ['k-look', 'in every set: on the page'], ['k-opt', 'filters you switch']]));

  function draw() {
    const rows = ROWS.filter((r) => on.includes(r.id));
    const page = CARS.filter((c) => rows.every((r) => r.test(c))).sort((a, b) => a.price - b.price);
    const ids = new Set(page.map((c) => c.id));
    const shown = rows.length ? rows : [{ id: 'none', key: 'car:price', f: 'no filter: every car', test: () => true }];
    stripBox.replaceChildren(strip({
      rows: [...shown, { id: 'res', key: 'the page', f: 'full columns' }], cols: CARS,
      rowCls: (r) => (r.id === 'res' ? 'is-res' : ''),
      cell: (r, c) => (r.id === 'res' ? (ids.has(c.id) ? 'is-look' : '') : (r.test(c) ? 'is-in' : '')),
    }));
    shot.replaceChildren(screen([
      h('b', null, `${page.length} car${page.length === 1 ? '' : 's'} · price ↑`),
      ...page.slice(0, 3).map((c) => carCard(c)),
      page.length > 3 ? h('span', { class: 't-s' }, `+ ${page.length - 3} more on page 2`) : null,
      page.length === 0 ? h('span', { class: 't-s' }, 'no car is in every set') : null,
    ].filter(Boolean)));
    kv.replaceChildren(h('dt', null, 'Valkey sets read'), h('dd', { class: 'c-data' }, String(Math.max(rows.length, 1))),
      h('dt', null, 'SQL queries'), h('dd', { class: 'c-safe' }, '0'));
  }
  draw();
}

/* ========================================================== SQL JOINS */

const SQL_FILTERS = [
  ['city', 'city_id=1'],
  ['price', 'price 2–4 L'],
  ['make', 'make=120,121'],
  ['model', 'model=121'],
  ['color', 'color=3'],
  ['features', 'features=20,21'],
];
// SQL-GEN-START (checked against Django output for every combination)
function composeSQL(on, distinct) {
  const joins = [];
  if (on.city) joins.push('INNER JOIN locality ON (car.locality_id = locality.id)');
  if (on.make || on.model) joins.push('INNER JOIN varient ON (car.varient_id = varient.id)');
  if (on.make) joins.push('INNER JOIN model ON (varient.model_id = model.id)');
  if (on.features) joins.push('INNER JOIN car_features ON (car.id = car_features.car_id)');
  const where = [];
  if (on.city) where.push('locality.city_id IN (1)');
  if (on.price) where.push('car.price >= 200000', 'car.price <= 400000');
  if (on.make) where.push('model.make_id IN (120, 121)');
  if (on.model) where.push('varient.model_id IN (121)');
  if (on.color) where.push('car.color_id IN (3)');
  if (on.features) where.push('car_features.feature_id IN (20, 21)');
  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}car.id, car.price, car.varient_id, car.color_id, car.locality_id FROM car`;
  if (joins.length) sql += ` ${joins.join(' ')}`;
  if (where.length) sql += ` WHERE ${where.length > 1 ? `(${where.join(' AND ')})` : where[0]}`;
  return `${sql} ORDER BY car.price ASC LIMIT 10 OFFSET 10`;
}
// SQL-GEN-END

const TABLES = {
  car: { cols: ['price', 'color_id', 'varient_id', 'locality_id'] },
  locality: { cols: ['city_id'] },
  city: { cols: ['id, name'] },
  varient: { cols: ['model_id'] },
  model: { cols: ['make_id'] },
  make: { cols: ['id, name'] },
  color: { cols: ['id, name'] },
  car_features: { cols: ['car_id, feature_id'] },
  features: { cols: ['id, name'] },
};
const T_EDGES = [['car', 'locality'], ['locality', 'city'], ['car', 'varient'], ['varient', 'model'], ['model', 'make'], ['car', 'color'], ['car', 'car_features'], ['car_features', 'features']];
const T_LAYOUT = {
  wide: {
    vb: [760, 330], w: 150, hh: 54,
    pos: { car: [10, 110], locality: [215, 10], city: [410, 10], varient: [215, 92], model: [410, 92], make: [605, 92], color: [215, 174], car_features: [215, 256], features: [410, 256] },
  },
  tall: {
    vb: [344, 372], w: 146, hh: 50, trunk: 22,
    pos: { car: [4, 4], locality: [40, 80], city: [196, 80], varient: [40, 156], model: [196, 156], make: [196, 232], color: [40, 232], car_features: [40, 308], features: [196, 308] },
  },
};

function joinState(on) {
  const joined = new Set(['car']);
  if (on.city) joined.add('locality');
  if (on.make || on.model) joined.add('varient');
  if (on.make) joined.add('model');
  if (on.features) joined.add('car_features');
  const used = {}; // table → column the WHERE reads
  if (on.city) used.locality = 'city_id';
  if (on.price) used.car = (used.car ? `${used.car}, ` : '') + 'price';
  if (on.make) used.model = 'make_id';
  if (on.model) used.varient = 'model_id';
  if (on.color) used.car = (used.car ? `${used.car}, ` : '') + 'color_id';
  if (on.features) used.car_features = 'feature_id';
  const named = new Set(); // tables the filter names but the ORM never reads
  if (on.city) named.add('city');
  if (on.make) named.add('make');
  if (on.color) named.add('color');
  if (on.features) named.add('features');
  return { joined, used, named };
}


function initSqlJoins(fig, app) {
  const on = { city: false, price: false, make: false, model: false, color: false, features: false };
  let distinct = false;
  let answered = false;
  const svgBox = h('div', { class: `${P}graph` });
  const sql = h('div');
  const facts = h('div', { class: `${P}facts`, 'aria-live': 'polite' });
  const filt = chips(SQL_FILTERS, (v) => { SQL_FILTERS.forEach(([k]) => { on[k] = v.includes(k); }); render(); }, { multi: true, value: [], label: 'Filters' });
  const filtRow = h('div', { hidden: true }, label('Filters in the request · switch any'), filt.el);
  const dBtn = h('button', { class: 'wv-btn', type: 'button', 'aria-pressed': 'false', onclick: () => { distinct = !distinct; dBtn.setAttribute('aria-pressed', String(distinct)); render(); } }, '.distinct()');
  const q = ask('The request filters by make=120,121. The make id is on the make table, two hops from car. How many tables does Django join to car?',
    [[1, '1'], [2, '2'], [3, '3']], 2,
    () => {
      answered = true;
      on.make = true;
      filt.set(['make']);
      filtRow.hidden = false;
      setTimeout(render);
      return '<b>2: varient and model.</b> The filter compares <code>model.make_id</code>, so the <code>make</code> table is never read. Now switch other filters on.';
    });
  app.append(q.el, filtRow, svgBox,
    h('div', { class: `${P}two` }, h('div', null, label('SQL from CarViewSet, page 2'), sql),
      h('div', null, facts, h('div', { class: 'wv-bar' }, h('span', { class: 'c-opt t-s' }, 'Queryset option'), dBtn))),
    colorKey([['k-look', 'joined table'], ['k-data', 'column the WHERE reads'], ['k-gap', 'duplicate rows'], ['k-safe', 'one row per car'], ['k-opt', 'answers and filters you pick']]));
  holdArrows(fig);
  const mq = window.matchMedia('(max-width: 620px)');
  mq.addEventListener?.('change', render);

  function render() {
    const L = mq.matches ? T_LAYOUT.tall : T_LAYOUT.wide;
    const { joined, used, named } = joinState(on);
    const svg = s('svg', { viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img', 'aria-label': `Tables read: ${[...joined].join(', ')}` });
    const box = (id) => { const [x, y] = L.pos[id]; return { x, y, w: L.w, h: L.hh }; };
    for (const [a, b] of T_EDGES) {
      const A = box(a); const B = box(b);
      let d;
      if (L.trunk && a === 'car') d = `M${L.trunk},${A.y + A.h} V${B.y + B.h / 2} H${B.x}`;
      else if (Math.abs(A.y - B.y) < 1) d = `M${A.x + A.w},${A.y + A.h / 2} H${B.x}`;
      else if (A.x + A.w <= B.x) { const mx = (A.x + A.w + B.x) / 2; d = `M${A.x + A.w},${A.y + A.h / 2} H${mx} V${B.y + B.h / 2} H${B.x}`; }
      else if (Math.abs(A.x - B.x) < 1) d = `M${A.x + A.w / 2},${A.y + A.h} V${B.y}`;
      else { const my = A.y + A.h + (B.y - A.y - A.h) / 2; d = `M${A.x + A.w / 2},${A.y + A.h} V${my} H${B.x + B.w / 2} V${B.y}`; }
      svg.append(s('path', { d, class: `edge ${P}e${joined.has(a) && joined.has(b) ? ' is-hot' : ''}` }));
    }
    for (const id of Object.keys(TABLES)) {
      const b = box(id);
      const g = s('g', { class: `${P}tb${joined.has(id) ? ' is-j' : ''}${named.has(id) ? ' is-n' : ''}` });
      g.append(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'box dash' }),
        s('text', { x: b.x + 10, y: b.y + 20, class: 't-m t-b' }, id));
      if (used[id]) {
        g.append(s('rect', { x: b.x + 6, y: b.y + 28, width: b.w - 12, height: 18, class: `${P}col` }),
          s('text', { x: b.x + 10, y: b.y + 41, class: 't-s t-data t-b' }, used[id]));
      } else {
        g.append(s('text', { x: b.x + 10, y: b.y + 41, class: 't-s t-mute' }, named.has(id) ? 'not joined' : TABLES[id].cols[0]));
      }
      svg.append(g);
    }
    svgBox.replaceChildren(svg);
    if (!answered) {
      sql.innerHTML = codeBlock(['SELECT … FROM car …']);
      facts.replaceChildren(h('p', { class: 't-s' }, 'The SQL and the joins appear after your guess.'));
      return;
    }
    const lines = composeSQL(on, distinct).replace(/ (INNER JOIN|WHERE|ORDER BY|LIMIT)/g, '\n$1').replace(/ AND /g, '\n   AND ').split('\n');
    sql.innerHTML = codeBlock(lines, lines.map((l, i) => (l.startsWith('INNER JOIN') ? i : -1)).filter((i) => i >= 0));
    const nj = joined.size - 1;
    const out = [h('p', null, h('b', null, `${nj} join${nj === 1 ? '' : 's'}`), `, ${joined.size} table${joined.size === 1 ? '' : 's'} read for one page.`)];
    if (named.size) out.push(h('p', null, 'Not joined: ', h('b', null, [...named].join(', ')), '. The filter only compares ids, and the id is already a column on the table before it.'));
    if (on.features) {
      out.push(distinct
        ? h('div', { class: 'wv-note is-good' }, 'DISTINCT: a car with both features is one row again, and count() counts it once.')
        : h('div', { class: 'wv-note is-bad' }, 'A car with both features (20 AMT, 21 sunroof) matches two car_features rows, so it appears twice on the page and count() counts it twice.'));
    }
    facts.replaceChildren(...out);
  }
  render();
}

/* =============================================================== KEYS */

const KEY_CARDS = {
  hash: {
    key: 'car:', type: 'hash', enc: 'hashtable', bytes: [87, 64],
    encNote: 'A hash stays listpack only while it has ≤ 512 fields and every value is ≤ 64 bytes.',
    rows: [['field', 'value'], ['101', '{"id":101,"price":775000,…}'], ['102', '{"id":102,"price":455000,…}'], ['109', '{"id":109,"price":430000,…}']],
    q: 'Car 999 does not exist. What does HMGET car: 101 102 999 return?',
    choices: [['nil', 'two values, then nil'], ['err', 'an error'], ['two', 'two values; 999 is skipped']], answer: 'nil',
    why: 'One reply per field asked for, in the same order. A missing field is nil, so the view must skip it.',
    reply: ['> HMGET car: 101 102 999', '1) «"{\\"id\\":101,\\"price\\":775000,…}"»', '2) «"{\\"id\\":102,\\"price\\":455000,…}"»', '3) ⟦(nil)⟧'],
  },
  zset: {
    key: 'car:price', type: 'sorted set', enc: 'listpack → skiplist',
    encNote: 'listpack up to 128 members; a real index has thousands of cars, so skiplist.',
    rows: [['member', 'score'], ['109', '430000'], ['102', '455000'], ['108', '520000'], ['…', '…'], ['105', '1150000']],
    q: 'ZRANGEBYSCORE car:price 400000 500000: which cars come back, in what order?',
    choices: [['price', '109, then 102'], ['id', '102, then 109'], ['all', 'every car, unsorted']], answer: 'price',
    why: 'Members come back in score order, and the score is the price: 109 at ₹4.30 L, then 102 at ₹4.55 L.',
    reply: ['> ZRANGEBYSCORE car:price 400000 500000 WITHSCORES', '1) «"109"»', '2) «"430000"»', '3) «"102"»', '4) «"455000"»'],
  },
};

function initKeys(fig, app) {
  const k = KEY_CARDS[fig.dataset.key || 'hash'];
  const [hd, ...body] = k.rows;
  const tbl = h('table', { class: 'wv-table' }, h('thead', null, h('tr', null, ...hd.map((c) => h('th', null, c)))),
    h('tbody', null, ...body.map((r) => h('tr', null, ...r.map((c) => h('td', { class: 'c-data' }, c))))));
  const parts = [
    h('p', null, h('b', { class: 'c-data' }, k.key), ` · ${k.type} · encoding: ${k.enc}`),
    h('div', { class: `${P}data` }, tbl),
  ];
  if (k.bytes) {
    const [n, lim] = k.bytes;
    parts.push(h('div', { class: `${P}bytes`, style: `--v:${n};--lim:${lim}` },
      h('div', { class: `${P}bbar` }, h('i'), h('span', { class: `${P}blim t-xs` }, `${lim} B limit`)),
      h('p', { class: 't-s' }, h('b', { class: 'c-data' }, `${n} B`), ` one value (car 101): over the limit, so ${k.enc}`)));
  }
  parts.push(h('p', { class: 't-s' }, k.encNote));
  const q = ask(k.q, k.choices, k.answer, () => `${k.why}${codeBlock(k.reply)}`);
  app.append(...parts, q.el, colorKey([['k-data', 'keys and values'], ['k-safe', 'right guess'], ['k-gap', 'nil, wrong guess'], ['k-opt', 'your answer']]));
}

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
  let groups = 50;
  let answered = false;
  const writes = h('span', { class: 'c-safe t-b' });
  const setBox = h('div', { class: `wv-card is-data ${P}rest` },
    h('p', null, h('b', { class: 'c-data' }, RECO_KEY), ' · set · 9 ids · intset: no order, no scores ', writes),
    h('div', { class: `${P}ids` }, ...RECO_IDS.map((id) => h('i', null, String(id)))));

  const lanes = BUYERS.map(([b, name, what]) => {
    const row = h('div', { class: `${P}lane` });
    const cells = {};
    for (const id of RECO_IDS) {
      const sc = h('span', { class: 't-xs' });
      const el = h('div', { class: `${P}rc`, title: `${CAR[id].model} ${CAR[id].variant}, ${CAR[id].body}` },
        h('b', null, String(id)), h('span', { class: 't-xs' }, CAR[id].model), sc);
      cells[id] = { el, sc };
      row.append(el);
    }
    return { b, row, cells, el: h('div', { class: `wv-card ${P}lanebox` }, h('p', null, h('b', null, name), ` · ${what} · `, h('span', { class: 'c-look' }, 'first 3 = page 1')), row) };
  });

  const modelPick = chips([['v1', 'model 10:00'], ['v2', 'model 10:45 · retrained']], (v) => { model = v; render(); }, { value: model, label: 'Model version' });
  const modelRow = h('div', { hidden: true }, label('Model in the web server'), modelPick.el);
  const q = ask('At 10:45 the model is retrained, and both buyers get a new order. How many Valkey keys must be rewritten?',
    [[0, '0'], [1, '1'], [2, 'one per buyer']], 0,
    () => {
      answered = true; model = 'v2'; modelPick.set('v2'); modelRow.hidden = false; setTimeout(render);
      return '<b>0.</b> The set holds members only. The web server computes the order on each request, so a retrain changes the rows below and writes nothing to Valkey.';
    });
  const code = h('div');
  const cmp = h('div', { class: 'wv-cards' });
  const slider = range('Buyer groups', { min: 1, max: 500, value: groups, fmt: fmt, oninput: (v) => { groups = v; renderCmp(); } });

  app.append(q.el, modelRow, setBox,
    h('p', { class: `t-s ${P}fan` }, '↓ SMEMBERS, then LightFM scores each id for this buyer'),
    ...lanes.map((l) => l.el),
    h('details', null, h('summary', null, 'The code for one request'), code),
    h('div', { class: `${P}gap` }, label('The other way: one stored order per buyer group')), slider.el, cmp,
    colorKey([['k-data', 'car ids'], ['k-look', 'page 1 for this buyer'], ['k-pick', 'what we store'], ['k-gap', 'cost of the other way'], ['k-opt', 'answers and controls']]));

  function renderCmp() {
    const n = RECO_IDS.length;
    cmp.replaceChildren(
      h('div', { class: 'wv-card is-pick' }, h('h5', null, 'One unordered set'), h('p', null, `1 key · ${n} ids`), h('p', { class: 'c-safe' }, '0 writes per retrain')),
      h('div', { class: 'wv-card is-bad' }, h('h5', null, 'One sorted set per buyer group'), h('p', null, `${fmt(groups)} keys · ${fmt(groups * n)} ids`),
        h('p', { class: 'c-bad' }, `${fmt(groups)} rewrites per retrain · ${fmt(groups * 32)} a day`)));
  }

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
    const pa = [...RECO_IDS].sort((a, b) => SCORES.A[model][b] - SCORES.A[model][a]).slice(0, PAGE);
    code.innerHTML = codeBlock([
      `ids = r.smembers("${RECO_KEY}")      # same 9 ids for everyone`,
      'scores = model.predict(user_idx, item_idx(ids))   # LightFM, in process',
      'ranked = [i for _, i in sorted(zip(scores, ids), reverse=True)]',
      `r.hmget("car:", *ranked[0:3])        # buyer A: «${pa.join(', ')}»`,
    ], [1]);
    writes.textContent = answered && model === 'v2' ? '· retrained: 0 writes' : '';
    renderCmp();
  }
  render();
}


// Terminal lines: [kind, text]. kind: c = command, r = reply, n = nil/miss,
// q = queued (not sent yet), m = comment.
const K = KEY;
const STEPS = [
  {
    label: 'Request', who: 'request 1', rt: 0, cmds: 0,
    title: 'The buyer applies four filters',
    text: `The view turns the query string into a canonical form: it drops <code>page</code> and <code>ordering</code>, sorts the keys, and sorts the ids. The key is <code>page:price:</code> plus the first 18 hex digits of its sha1.`,
    term: [['m', '# no Valkey command yet'], ['m', `# canonical: ${CANON}`], ['m', `# key: ${K}`]],
    phone: 'loading', url: 'make=12,10&price_max=800000&city_id=1&price_min=400000&features=20&ordering=price&page=1',
    strip: { read: 0 }, dim: ['strip'],
  },
  {
    label: 'Lookup', who: 'request 1', rt: 1, cmds: 2,
    title: 'Round trip 1: is the result cached?',
    text: 'Both commands go in one pipeline. The key does not exist, so this is a miss. <code>ZINTERSTORE</code> never stores an empty result, so a filter that matches no car misses on every request.',
    term: [['c', `ZCARD ${K}`], ['n', '(integer) 0'], ['c', `ZRANGE ${K} 0 2`], ['n', '(empty array)']],
    phone: 'loading', strip: { read: 0, res: 'nil' }, tone: 'bad',
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
    phone: 'loading', strip: { read: 4 }, dim: ['phone'],
  },
  {
    label: 'Intersect', who: 'request 1', rt: 2, cmds: 11,
    title: 'Round trip 2: intersect, store, read page 1',
    text: 'The full columns are the result. The weights keep only the price as the score, so the stored set is already in price order.',
    term: [
      ['c', 'ZRANGESTORE … ZUNIONSTORE …  (5 commands above)'], ['r', '(integer) 9 · 10 · 5 · 5 · 10'],
      ['c', `ZINTERSTORE ${K} 4 tmp:6d53…:price tmp:6d53…:city tmp:6d53…:make car:feature:20 WEIGHTS 1 0 0 0`], ['r', '(integer) 5'],
      ['c', `EXPIRE ${K} 600`], ['r', '(integer) 1'],
      ['c', 'DEL tmp:6d53…:city tmp:6d53…:price tmp:6d53…:m10 tmp:6d53…:m12 tmp:6d53…:make'], ['r', '(integer) 5'],
      ['c', `ZRANGE ${K} 0 2`], ['r', '1) "109"  2) "102"  3) "111"'],
    ],
    phone: 'loading', strip: { read: 4, res: 'new' }, weights: true, dim: ['phone'],
  },
  {
    label: 'Page 1', who: 'request 1', rt: 3, cmds: 12,
    title: 'Round trip 3: one HMGET for the whole page',
    text: 'A miss costs 3 round trips for 12 commands. Sent one by one, the same commands take 12 round trips.',
    term: [['c', 'HMGET car: 109 102 111'], ['r', '1) "{\\"id\\":109,\\"price\\":430000,\\"model_name\\":\\"Grand i10\\",…}"'], ['r', '2) "{\\"id\\":102,\\"price\\":455000,…}"'], ['r', '3) "{\\"id\\":111,\\"price\\":690000,…}"']],
    phone: [109, 102, 111], count: 5, pageNo: 1, strip: { read: 4, res: 'ttl', ttl: 600 }, tone: 'good', dim: ['strip'],
  },
  {
    label: 'Page 2', who: 'request 2', rt: 2, cmds: 3,
    title: 'Page 2, filters in another order: a hit',
    text: 'No index is read. Page <i>n</i> is <code>ZRANGE key (n−1)×size n×size−1</code>.',
    term: [['c', `ZCARD ${K}`], ['r', '(integer) 5'], ['c', `ZRANGE ${K} 3 5`], ['r', '1) "104"  2) "101"'], ['c', 'HMGET car: 104 101'], ['r', '1) "{\\"id\\":104,…}"  2) "{\\"id\\":101,…}"']],
    phone: [104, 101], count: 5, pageNo: 2, url: 'city_id=1&features=20&make=10,12&price_min=400000&price_max=800000&ordering=price&page=2',
    strip: { read: 4, res: 'ttl', ttl: 540 }, tone: 'good',
    ask: { q: 'Same filters in another order, now page 2. Hit or miss?', opts: ['hit', 'miss'], right: 'hit', why: 'The canonical form sorts the keys and the ids, so the key is the same.' },
  },
  {
    label: 'Sold', who: 'CDC write', rt: 1, cmds: 5, cdc: true,
    title: 'Car 111 is sold',
    text: 'The change-log consumer removes 111 from the hash and from every index. The stored result is not an index, and it still holds 111 until its TTL ends.',
    term: [['m', '# change log: car 111 status → sold'], ['c', 'HDEL car: 111'], ['r', '(integer) 1'], ['c', 'ZREM car:price 111'], ['r', '(integer) 1'], ['c', 'ZREM car:city 111 · car:make 111 · car:feature:20 111'], ['r', '(integer) 1 · 1 · 1']],
    phone: [104, 101], count: 5, pageNo: 2, strip: { read: 4, res: 'ttl', ttl: 500, sold: true }, tone: 'bad', dim: ['phone'],
  },
  {
    label: 'Stale id', who: 'request 3', rt: 2, cmds: 3,
    title: 'Page 1 again, before the TTL ends',
    text: 'Until the key expires, page 1 has 2 cars and the count says 5. A new query builds from the indexes, which no longer hold 111.',
    term: [['c', `ZCARD ${K}`], ['r', '(integer) 5'], ['c', `ZRANGE ${K} 0 2`], ['r', '1) "109"  2) "102"  3) "111"'], ['c', 'HMGET car: 109 102 111'], ['r', '1) "{\\"id\\":109,…}"  2) "{\\"id\\":102,…}"'], ['n', '3) (nil)']],
    phone: [109, 102, 111], count: 5, pageNo: 1, stale: true, url: 'city_id=1&features=20&make=10,12&price_min=400000&price_max=800000&ordering=price&page=1', strip: { read: 4, res: 'ttl', ttl: 480, sold: true }, tone: 'bad',
    ask: { q: 'Car 111 was just sold. The buyer opens page 1 again. How many cars does it show?', opts: ['3', '2', 'an error'], right: '2', why: 'The stored result still holds 111. HMGET returns nil for it, and the view skips it.' },
  },
];


function termLines(term) {
  const lines = []; const hot = [];
  for (const [k, t] of term) {
    if (k === 'c') lines.push(`> ${t}`);
    else if (k === 'q') { hot.push(lines.length); lines.push(`+ ${t}`); }
    else if (k === 'r') lines.push(`  «${t}»`);
    else if (k === 'n') lines.push(`  ⟦${t}⟧`);
    else lines.push(`// ${t.replace(/^# /, '')}`);
  }
  return codeBlock(lines, hot);
}

function initListing(fig, app) {
  let cur = 0;
  let weights = true;
  const answers = {};
  const asks = {};
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const shot = h('div');
  const term = h('div');
  const meter = h('div', { class: `${P}meter` });
  const stripBox = h('div', { class: `${P}lstrip` });
  const stp = stepper(fig, STEPS, (i) => { cur = i; render(); });
  holdArrows(fig);
  const askBox = h('div');
  app.append(stp.el, note, askBox,
    h('div', { class: `${P}lgrid` }, shot, h('div', null, label('valkey-cli'), term, meter)),
    stripBox,
    colorKey([['k-data', 'car ids, replies'], ['k-look', 'this step, the result'], ['k-safe', 'hit, fewer round trips'], ['k-gap', 'miss, stale id'], ['k-opt', 'answers, score switch']]));

  function renderShot(st, ids) {
    const url = st.url || STEPS.slice(0, cur + 1).reverse().find((x) => x.url).url;
    const kids = [h('p', { class: `t-xs c-data ${P}url` }, `/listing/?${url}`)];
    if (!ids || ids === 'loading') {
      kids.push(h('p', { class: 't-s' }, st.cdc ? 'no request from the buyer' : 'loading…'));
    } else {
      kids.push(h('b', { class: st.stale ? 'c-bad' : '' }, `${st.count} cars · page ${st.pageNo} of 2${st.stale ? ' · shows 2' : ''}`));
      for (const id of ids) {
        if (st.stale && id === 111) kids.push(h('div', { class: `wv-card is-bad ${P}car` }, h('b', null, '111 · nil'), h('span', { class: 't-s' }, 'sold; skipped')));
        else kids.push(carCard(CAR[id], ` · ${CITY[CAR[id].city]}`));
      }
    }
    const el = screen(kids);
    el.classList.toggle(`${P}dim`, !!st.dimShot);
    shot.replaceChildren(el);
  }

  function renderStrip(st) {
    const { read, res, ttl, sold } = st.strip;
    const rows = ROWS.map((r) => ({ ...r }));
    rows.push({ id: 'res', key: 'page:price:6d53…', f: res === 'new' || res === 'ttl' ? `zset · TTL ${ttl || 600} s` : 'not cached' });
    const kids = [label(cur <= 1 ? 'Valkey: the four filters (not read yet) and the result key' : 'Valkey: the cars each filter selects, and the stored result'),
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
      })];
    if (st.weights) {
      const sc = (c) => (weights ? c.price : c.price + c.city + c.make + 1);
      const order = [...RESULT].sort((a, b) => sc(a) - sc(b));
      kids.push(h('div', { class: 'wv-bar' }, h('span', { class: 'c-opt t-s' }, 'Scores in the result'),
        chips([[true, 'WEIGHTS 1 0 0 0'], [false, 'default: SUM']], (v) => { weights = v; render(); }, { value: weights, label: 'Scores' }).el),
      h('div', { class: `wv-note ${weights ? 'is-good' : 'is-bad'}` },
        h('p', null, order.map((c) => `${c.id} → ${sc(c)}`).join(' · ')),
        h('p', null, weights ? 'Score = price.'
          : 'Default AGGREGATE SUM: score = price + city_id + make_id + 1. The order survives here, but the score is no longer the price. In this query only make_id differs (10 or 12), so cars within 2 rupees of each other can change places.')));
    }
    stripBox.replaceChildren(...kids);
    stripBox.classList.toggle(`${P}dim`, !!st.dimStrip);
  }

  function render() {
    const st0 = STEPS[cur];
    const pending = st0.ask && !(cur in answers);
    const st = pending ? { ...st0, tone: null, term: st0.term.filter(([k]) => k === 'c'), rt: 0, cmds: 0 } : st0;
    note.className = `wv-note${st.tone ? ` is-${st.tone}` : ''}`;
    note.replaceChildren(h('span', { class: 'k' }, st.who), h('b', null, st.title));
    if (!pending) { const p = h('p'); p.innerHTML = st.text; note.append(p); }
    if (st0.ask) {
      asks[cur] ??= ask(`Guess first. ${st0.ask.q}`, st0.ask.opts.map((o) => [o, o]), st0.ask.right, (v) => {
        answers[cur] = v; setTimeout(render); return st0.ask.why;
      }).el;
      askBox.replaceChildren(asks[cur]);
    } else askBox.replaceChildren();
    const dim = pending ? ['strip'] : (st.dim || []);
    renderShot({ ...st, dimShot: dim.includes('phone') }, pending ? 'loading' : st.phone);
    term.innerHTML = termLines(st.term);
    const hit = st.tone === 'good';
    meter.hidden = pending;
    meter.replaceChildren(...[
      h('span', { class: `${P}trips`, title: 'filled: round trips used; hollow: extra round trips if each command were sent alone' },
        ...Array.from({ length: st.cmds }, (_, i) => h('i', { class: i < st.rt ? `is-rt${hit ? ' is-hit' : ''}` : '' }))),
      h('span', null, h('b', { class: hit ? 'c-safe' : '' }, String(st.rt)), ` round trip${st.rt === 1 ? '' : 's'} · `, h('b', null, String(st.cmds)), ' commands',
        st.queued ? h('span', { class: 'c-look' }, ` + ${st.queued} queued`) : null),
      st.cmds > st.rt ? h('p', { class: 't-s' }, `hollow: ${st.cmds - st.rt} more round trip${st.cmds - st.rt === 1 ? '' : 's'} if each command were sent alone`) : null,
    ].filter(Boolean));
    renderStrip({ ...st, dimStrip: dim.includes('strip') });
  }
  stp.go(0);
}

register({ 'filter-sets': initFilterSets, 'sql-joins': initSqlJoins, keys: initKeys, 'reco-order': initReco, 'listing-request': initListing });

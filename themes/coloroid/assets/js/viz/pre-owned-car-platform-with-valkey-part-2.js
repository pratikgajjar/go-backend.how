/*
 * Figures for "Building pre-owned Car Platform With Valkey - Part 2".
 *
 * One visual language for the whole post: what the buyer sees (a phone),
 * what the server sends (a valkey-cli transcript), and the "set strip":
 * one row per filter set, one column per car, so an intersection is a
 * column that is filled in every row.
 *
 *   filter-sets      the reader switches filters; each is a set row, and
 *                    the full columns are the page
 *   sql-joins        which tables each django-filter filter joins
 *   keys             one card per Valkey key shape (data-key=hash|zset)
 *   reco-order       one unordered set, ranked per buyer in the web server
 *   listing-request  one listing query: miss, hit, sale, stale id
 *
 * Sample data: 12 cars. Valkey replies were produced by running the same
 * commands on Valkey 9.1 with this data; the SQL is what Django 6.1 +
 * django-filter 26.1 generate (SQLite backend, quotes removed).
 * LightFM scores are made up.
 */
import { h, s, colorKey, register, REDUCED, fmt } from './lib.js';

const P = 'v-vk2-';

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

function root(fig) {
  fig.classList.add('v-vk2');
  return fig;
}
function segBtns(opts, get, set, cls = '') {
  const btns = opts.map(([k, label]) => h('button', {
    class: `${P}btn ${cls}`, type: 'button', 'aria-pressed': 'false', onclick: () => { set(k); sync(); },
  }, label));
  function sync() { btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i][0] === get()))); }
  sync();
  return { el: h('span', { class: `${P}seg` }, ...btns), sync };
}
function keyHold(fig) {
  // Arrow keys step the figure; stop them from reaching the site's
  // post-to-post keyboard navigation on document.
  return (fn) => fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      fn(e.key === 'ArrowRight' ? 1 : -1);
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

/* Set strip: one row per set, one column per car. */
function strip({ rows, cols, cell, head = true, rowCls = () => '' }) {
  const t = h('div', { class: `${P}strip`, style: `--n:${cols.length}`, role: 'table' });
  if (head) {
    t.append(h('div', { class: `${P}sl`, role: 'columnheader' }, h('span', null, 'cars 101–112')),
      ...cols.map((c) => h('div', { class: `${P}sh`, role: 'columnheader' }, String(c.id).slice(1))));
  }
  for (const r of rows) {
    t.append(h('div', { class: `${P}sl ${rowCls(r)}`, role: 'rowheader' }, h('b', null, r.key), h('span', null, r.f)),
      ...cols.map((c) => { const [cls, txt, title] = cell(r, c); return h('div', { class: `${P}sc ${cls}`, role: 'cell', title: title || '' }, txt || ''); }));
  }
  return t;
}

/* ========================================================= FILTER SETS */

/* The reader switches filters. Each switched-on filter is one set row;
   the cars whose column is full in every row are the page. */
function initFilterSets(fig, app) {
  root(fig);
  const on = { city: true, price: true, make: true, amt: true };
  const LABEL = { city: 'Mumbai', price: '₹4–8 L', make: 'Tata or Hyundai', amt: 'AMT' };
  const chips = ROWS.map((r) => h('button', {
    class: `${P}btn ${P}fchip`, type: 'button', 'aria-pressed': 'true',
    onclick: (e) => { on[r.id] = !on[r.id]; e.currentTarget.setAttribute('aria-pressed', String(on[r.id])); draw(); },
  }, LABEL[r.id]));
  const stripBox = h('div', { class: `${P}hsets` });
  const phone = h('div', { class: `${P}phone ${P}hphone`, 'aria-live': 'polite' });
  const count = h('div', { class: `${P}hcount` });
  app.append(
    h('div', { class: `${P}ctl` }, h('span', { class: `${P}lab` }, 'Filters · tap to switch'), h('div', { class: `${P}chips` }, ...chips)),
    h('div', { class: `${P}hmid` }, stripBox, phone),
    count,
    colorKey([['k-data', 'car is in that set'], ['k-look', 'in every set: on the page'], ['k-safe', 'no SQL on the read path'], ['k-opt', 'filters you switch']]),
  );

  function draw() {
    const rows = ROWS.filter((r) => on[r.id]);
    const page = CARS.filter((c) => rows.every((r) => r.test(c))).sort((a, b) => a.price - b.price);
    const ids = new Set(page.map((c) => c.id));
    const shown = rows.length ? rows : [{ id: 'none', key: 'car:price', f: 'no filter: every car', test: () => true }];
    stripBox.replaceChildren(strip({
      rows: [...shown, { id: 'res', key: 'the page', f: 'full columns' }], cols: CARS,
      rowCls: (r) => (r.id === 'res' ? 'is-res' : ''),
      cell: (r, c) => {
        if (r.id === 'res') return ids.has(c.id) ? ['is-look', ''] : ['', ''];
        return [r.test(c) ? 'is-in' : '', ''];
      },
    }));
    phone.replaceChildren(...[
      h('div', { class: `${P}pbar` }, 'car.com'),
      h('div', { class: `${P}pmeta` }, `${page.length} car${page.length === 1 ? '' : 's'} · price ↑`),
      ...page.slice(0, 3).map((c) => h('div', { class: `${P}pcard` }, h('b', null, `${c.model} ${c.variant}`), h('span', null, `${lakh(c.price)} · #${c.id}`))),
      page.length > 3 ? h('div', { class: `${P}small` }, `+ ${page.length - 3} more on page 2`) : null,
      page.length === 0 ? h('div', { class: `${P}small` }, 'no car is in every set') : null,
    ].filter(Boolean));
    count.replaceChildren(
      h('span', null, 'Valkey sets read: ', h('b', { class: `${P}data` }, String(Math.max(rows.length, 1)))),
      h('span', null, 'SQL queries: ', h('b', { class: `${P}good` }, '0')),
    );
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
  root(fig);
  const on = { city: false, price: false, make: false, model: false, color: false, features: false };
  let distinct = false;
  let answered = false;
  const chips = SQL_FILTERS.map(([k, label]) => h('button', {
    class: `${P}btn ${P}fchip`, type: 'button', 'aria-pressed': String(on[k]), onclick: (e) => { on[k] = !on[k]; e.currentTarget.setAttribute('aria-pressed', String(on[k])); render(); },
  }, label));
  const dBtn = h('button', { class: `${P}btn`, type: 'button', 'aria-pressed': 'false', onclick: () => { distinct = !distinct; dBtn.setAttribute('aria-pressed', String(distinct)); render(); } }, '.distinct()');
  const svgBox = h('div', { class: `${P}graph` });
  const sql = h('pre', { class: `${P}sql` });
  const facts = h('div', { class: `${P}facts`, 'aria-live': 'polite' });
  const chipRow = h('div', { class: `${P}ctl`, hidden: true }, h('span', { class: `${P}lab` }, 'Filters in the request · switch any'), h('div', { class: `${P}chips` }, ...chips));
  const ask = h('div', { class: `${P}ask` },
    h('p', null, h('b', null, 'Guess first. '), 'The request filters by ', h('code', null, 'make=120,121'), '. The make id sits on the ', h('code', null, 'make'), ' table, two hops from ', h('code', null, 'car'), '. How many tables does Django join to ', h('code', null, 'car'), '?'),
    h('div', { class: `${P}seg` }, ...['1', '2', '3'].map((n) => h('button', { class: `${P}btn`, type: 'button', onclick: () => answer(+n) }, n))));
  function answer(n) {
    answered = true;
    on.make = true;
    chips.forEach((b, k) => b.setAttribute('aria-pressed', String(on[SQL_FILTERS[k][0]])));
    ask.replaceChildren(h('p', null, h('b', { class: n === 2 ? `${P}good` : `${P}look` }, n === 2 ? 'Right: 2. ' : `2, not ${n}. `),
      h('code', null, 'varient'), ' and ', h('code', null, 'model'), '. The filter compares ', h('code', null, 'model.make_id'), ', so the ', h('code', null, 'make'), ' table is never read. Now switch other filters on.'));
    chipRow.hidden = false;
    render();
  }
  app.append(
    ask,
    chipRow,
    svgBox,
    h('div', { class: `${P}sqlgrid` }, h('div', null, h('div', { class: `${P}lab` }, 'SQL from CarViewSet, page 2'), sql),
      h('div', null, facts, h('div', { class: `${P}ctl` }, h('span', { class: `${P}lab` }, 'Queryset option'), dBtn))),
    colorKey([['k-look', 'joined table'], ['k-data', 'column the WHERE reads'], ['k-gap', 'duplicate rows'], ['k-safe', 'one row per car, right guess'], ['k-opt', 'answers and filters you pick']]),
  );
  const mq = window.matchMedia('(max-width: 620px)');
  mq.addEventListener?.('change', render);

  function render() {
    const L = mq.matches ? T_LAYOUT.tall : T_LAYOUT.wide;
    const { joined, used, named } = joinState(on);
    const svg = s('svg', { viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img', 'aria-label': `Tables read: ${[...joined].join(', ')}` });
    const box = (id) => { const [x, y] = L.pos[id]; return { x, y, w: L.w, h: L.hh }; };
    for (const [a, b] of T_EDGES) {
      const A = box(a); const B = box(b);
      const hot = joined.has(a) && joined.has(b);
      let d;
      if (L.trunk && a === 'car') d = `M${L.trunk},${A.y + A.h} V${B.y + B.h / 2} H${B.x}`;
      else if (Math.abs(A.y - B.y) < 1) d = `M${A.x + A.w},${A.y + A.h / 2} H${B.x}`;
      else if (A.x + A.w <= B.x) { const mx = (A.x + A.w + B.x) / 2; d = `M${A.x + A.w},${A.y + A.h / 2} H${mx} V${B.y + B.h / 2} H${B.x}`; }
      else if (Math.abs(A.x - B.x) < 1) d = `M${A.x + A.w / 2},${A.y + A.h} V${B.y}`;
      else { const my = A.y + A.h + (B.y - A.y - A.h) / 2; d = `M${A.x + A.w / 2},${A.y + A.h} V${my} H${B.x + B.w / 2} V${B.y}`; }
      svg.append(s('path', { d, class: `${P}edge${hot ? ' is-hot' : ''}` }));
    }
    for (const id of Object.keys(TABLES)) {
      const b = box(id);
      const isJ = joined.has(id);
      const isN = named.has(id);
      const g = s('g', { class: `${P}tbl${isJ ? ' is-j' : ''}${isN ? ' is-n' : ''}` });
      g.append(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 7 }));
      g.append(s('text', { x: b.x + 10, y: b.y + 20, class: `${P}tn` }, id));
      const col = used[id];
      if (col) {
        g.append(s('rect', { x: b.x + 6, y: b.y + 28, width: b.w - 12, height: 18, rx: 3, class: `${P}colbg` }));
        g.append(s('text', { x: b.x + 10, y: b.y + 41, class: `${P}tc is-used` }, col));
      } else {
        g.append(s('text', { x: b.x + 10, y: b.y + 41, class: `${P}tc` }, isN ? 'not joined' : TABLES[id].cols[0]));
      }
      svg.append(g);
    }
    svgBox.replaceChildren(svg);
    sql.textContent = composeSQL(on, distinct).replace(/ (INNER JOIN|WHERE|ORDER BY|LIMIT)/g, '\n$1').replace(/ AND /g, '\n   AND ');
    if (!answered) { facts.replaceChildren(h('p', { class: `${P}small` }, 'The SQL and the joins appear after your guess.')); sql.textContent = 'SELECT … FROM car …'; return; }
    const nj = joined.size - 1;
    const skip = [...named];
    const lines = [
      h('p', null, h('b', null, `${nj} join${nj === 1 ? '' : 's'}`), `, ${joined.size} table${joined.size === 1 ? '' : 's'} read for one page.`),
    ];
    if (skip.length) {
      lines.push(h('p', null, 'Not joined: ', h('b', null, skip.join(', ')),
        '. The filter only compares ids, and the id is already a column on the table before it.'));
    }
    if (on.features) {
      lines.push(distinct
        ? h('p', { class: `${P}ok` }, 'DISTINCT: a car with both features is one row again, and count() counts it once.')
        : h('p', { class: `${P}bad` }, 'A car with both features (20 AMT, 21 sunroof) matches two car_features rows, so it appears twice on the page and count() counts it twice.'));
    }
    facts.replaceChildren(...lines);
  }
  render();
}

/* =============================================================== KEYS */

const KEY_CARDS = {
  hash: {
    key: 'car:', type: 'hash', enc: 'hashtable',
    encNote: 'A hash stays listpack only while it has ≤ 512 fields and every value is ≤ 64 bytes.', bytes: [87, 64],
    ask: 'car 999 does not exist. What does HMGET return for it?',
    rows: [['field', 'value'], ['101', '{"id":101,"price":775000,…}'], ['102', '{"id":102,"price":455000,…}'], ['109', '{"id":109,"price":430000,…}']],
    cmd: 'HMGET car: 101 102 999',
    reply: ['1) "{\\"id\\":101,\\"price\\":775000,…}"', '2) "{\\"id\\":102,\\"price\\":455000,…}"', '3) (nil)'],
    nilLast: true,
  },
  zset: {
    key: 'car:price', type: 'sorted set', enc: 'listpack → skiplist',
    encNote: 'listpack up to 128 members; a real index has thousands of cars, so skiplist.',
    ask: 'which cars cost ₹4–5 L, and in what order?',
    rows: [['member', 'score'], ['109', '430000'], ['102', '455000'], ['108', '520000'], ['…', '…'], ['105', '1150000']],
    cmd: 'ZRANGEBYSCORE car:price 400000 500000 WITHSCORES',
    reply: ['1) "109"', '2) "430000"', '3) "102"', '4) "455000"'],
  },
};

function initKeys(fig, app) {
  root(fig);
  const k = KEY_CARDS[fig.dataset.key || 'hash'];
  const tbl = h('div', { class: `${P}kv` },
    ...k.rows.flatMap((r, i) => r.map((c) => h('span', { class: i === 0 ? 'hd' : '' }, c))));
  const replies = h('div', { class: `${P}kreply`, hidden: true },
    ...k.reply.map((r, i) => h('div', { class: `${P}tl is-rep${k.nilLast && i === k.reply.length - 1 ? ' is-nil' : ''}` }, r)));
  const run = h('button', { class: `${P}btn ${P}run`, type: 'button', onclick: () => { replies.hidden = false; run.disabled = true; run.textContent = 'ran'; } }, 'Run ▸');
  const extra = [];
  if (k.bytes) {
    // one value against the listpack limit
    const [n, lim] = k.bytes;
    extra.push(h('div', { class: `${P}bytes`, style: `--v:${n};--lim:${lim}` },
      h('div', { class: `${P}bbar` }, h('i'), h('span', { class: `${P}blim` }, `${lim} B limit`)),
      h('span', null, h('b', { class: `${P}data` }, `${n} B`), ` one value (car 101) · over the limit, so ${k.enc}`)));
  }
  app.append(h('div', { class: `${P}kcard` },
    h('div', { class: `${P}khead` }, h('b', { class: `${P}kname` }, k.key), h('span', { class: `${P}ktype` }, k.type), h('span', { class: `${P}kenc` }, `encoding: ${k.enc}`)),
    tbl, ...extra,
    h('p', { class: `${P}knote` }, k.encNote),
    h('p', { class: `${P}kq` }, h('b', null, 'Guess: '), k.ask),
    h('div', { class: `${P}term ${P}kterm` },
      h('div', { class: `${P}tl is-cmd` }, h('span', { class: `${P}pr` }, '> '), k.cmd, ' ', run),
      replies)));
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
  root(fig);
  let model = 'v1';
  let groups = 50;
  let guessed = false;
  const writes = h('span', { class: `${P}writes` });
  const setBox = h('div', { class: `${P}rset` },
    h('div', { class: `${P}rsethead` }, h('b', { class: `${P}kname` }, RECO_KEY), h('span', { class: `${P}ktype` }, 'set · 9 ids'), h('span', { class: `${P}kenc` }, 'intset: no order, no scores'), writes),
    h('div', { class: `${P}rids` }, ...RECO_IDS.map((id) => h('i', null, String(id)))));

  const lanes = BUYERS.map(([b, name, what]) => {
    const row = h('div', { class: `${P}lane` });
    const chips = {};
    for (const id of RECO_IDS) {
      const sc = h('small');
      const el = h('div', { class: `${P}rc`, title: `${CAR[id].model} ${CAR[id].variant}, ${CAR[id].body}` }, h('b', null, String(id)), h('span', null, CAR[id].model), sc);
      chips[id] = { el, sc };
      row.append(el);
    }
    const el = h('div', { class: `${P}lanebox` }, h('div', { class: `${P}lanehead` }, h('b', null, name), ` · ${what}`, h('span', { class: `${P}pg1` }, 'first 3 = page 1')), row);
    return { b, el, row, chips };
  });

  const ask = h('div', { class: `${P}ask` });
  const modelSeg = segBtns([['v1', 'model 10:00'], ['v2', 'model 10:45 · retrained']], () => model, (v) => { model = v; render(); });
  const modelRow = h('div', { class: `${P}ctl`, hidden: true }, h('span', { class: `${P}lab` }, 'Model in the web server'), modelSeg.el);
  function askView() {
    ask.replaceChildren(
      h('p', null, h('b', null, 'Guess first. '), 'At 10:45 the model is retrained, and both buyers get a new order. How many Valkey keys must be rewritten?'),
      h('div', { class: `${P}seg` }, ...[['0', 0], ['1', 1], ['one per buyer', 2]].map(([l, v]) => h('button', { class: `${P}btn`, type: 'button', onclick: () => guess(v) }, l))));
  }
  function guess(v) {
    guessed = true;
    ask.replaceChildren(h('p', null, h('b', { class: v === 0 ? `${P}good` : `${P}look` }, v === 0 ? 'Right: 0. ' : 'Zero. '),
      'The set holds members only. The order is computed in the web server on each request, so a retrain changes the lanes below and writes nothing to Valkey.'));
    modelRow.hidden = false;
    model = 'v2';
    modelSeg.sync();
    render();
  }

  const code = h('details', { class: `${P}det` }, h('summary', null, 'The code for one request'), h('pre', { class: `${P}code` }));
  const slider = h('input', { type: 'range', min: 1, max: 500, step: 1, value: groups, 'aria-label': 'Buyer groups' });
  const out = h('output');
  const cmp = h('div', { class: `${P}cmp` });
  slider.addEventListener('input', () => { groups = +slider.value; renderCmp(); });

  askView();
  app.append(
    ask, modelRow, setBox,
    h('div', { class: `${P}fan`, 'aria-hidden': 'true' }, 'SMEMBERS, then LightFM scores each id for this buyer'),
    ...lanes.map((l) => l.el),
    code,
    h('div', { class: `${P}range` }, h('label', null, 'The other way: store one sorted set per buyer group. Groups'), slider, out),
    cmp,
    colorKey([['k-data', 'car ids'], ['k-look', 'page 1 for this buyer'], ['k-pick', 'what we store'], ['k-gap', 'cost of the other way'], ['k-opt', 'answers and controls']]),
  );

  function renderCmp() {
    out.textContent = fmt(groups);
    const n = RECO_IDS.length;
    cmp.replaceChildren(
      h('div', { class: `${P}alt is-pick` }, h('b', null, 'One unordered set'), h('span', null, `1 key · ${n} ids`), h('span', { class: `${P}good` }, '0 writes per retrain')),
      h('div', { class: `${P}alt is-cost` }, h('b', null, 'One sorted set per buyer group'), h('span', null, `${fmt(groups)} keys · ${fmt(groups * n)} ids`),
        h('span', { class: `${P}bad` }, `${fmt(groups)} rewrites per retrain · ${fmt(groups * 32)} a day`)),
    );
  }

  let first = true;
  function render() {
    for (const l of lanes) {
      const sc = SCORES[l.b][model];
      const ranked = [...RECO_IDS].sort((a, b) => sc[b] - sc[a]);
      const before = {};
      if (!first) for (const id of RECO_IDS) { const r = l.chips[id].el.getBoundingClientRect(); before[id] = [r.left, r.top]; }
      ranked.forEach((id, k) => {
        const c = l.chips[id];
        l.row.append(c.el);
        c.el.classList.toggle('is-page', k < PAGE);
        c.sc.textContent = sc[id].toFixed(2);
      });
      if (!first && !REDUCED) {
        for (const id of RECO_IDS) {
          const r = l.chips[id].el.getBoundingClientRect();
          const dx = before[id][0] - r.left; const dy = before[id][1] - r.top;
          if (Math.abs(dx) + Math.abs(dy) > 1) l.chips[id].el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.3,.7,.3,1)' });
        }
      }
    }
    first = false;
    const pa = [...RECO_IDS].sort((a, b) => SCORES.A[model][b] - SCORES.A[model][a]).slice(0, PAGE);
    code.querySelector('pre').textContent = [
      `ids = r.smembers("${RECO_KEY}")      # same 9 ids for everyone`,
      'scores = model.predict(user_idx, item_idx(ids))   # LightFM, in process',
      'ranked = [i for _, i in sorted(zip(scores, ids), reverse=True)]',
      `r.hmget("car:", *ranked[0:3])        # buyer A: ${pa.join(', ')}`,
    ].join('\n');
    writes.textContent = guessed && model === 'v2' ? 'retrained: 0 writes' : '';
    writes.classList.toggle('is-flash', guessed && model === 'v2');
    renderCmp();
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
    phone: 'same', strip: { read: 4, res: 'ttl', ttl: 500, sold: true }, tone: 'bad', dim: ['phone'],
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

function initListing(fig, app) {
  root(fig);
  let cur = -1;
  let weights = true;
  let lastPhone = null;

  const stops = STEPS.map((st, k) => h('button', { class: `${P}stop`, type: 'button', onclick: () => go(k), 'aria-label': `Step ${k + 1}: ${st.label}` },
    h('span', { class: `${P}dot` }, String(k + 1)), h('span', { class: `${P}sl2` }, st.label)));
  const back = h('button', { class: `${P}btn ${P}nav`, type: 'button', onclick: () => go(cur - 1), 'aria-label': 'Previous step' }, '←');
  const next = h('button', { class: `${P}btn ${P}nav`, type: 'button', onclick: () => go(cur + 1), 'aria-label': 'Next step' }, '→');
  const route = h('div', { class: `${P}route` }, back, h('div', { class: `${P}stops`, role: 'group', 'aria-label': 'Steps' }, ...stops), next);

  const head = h('div', { class: `${P}step`, 'aria-live': 'polite' });
  const phone = h('div', { class: `${P}phone ${P}lphone` });
  const term = h('div', { class: `${P}term ${P}lterm` });
  const meter = h('div', { class: `${P}meter` });
  const stripBox = h('div', { class: `${P}lstrip` });

  app.append(route, head,
    h('div', { class: `${P}lgrid` }, phone, h('div', { class: `${P}lright` }, term, meter)),
    stripBox,
    colorKey([['k-data', 'car ids, replies'], ['k-look', 'this step, the result'], ['k-safe', 'hit, fewer round trips'], ['k-gap', 'miss, stale id'], ['k-opt', 'switch scores']]));
  keyHold(fig)((d) => go(cur + d));

  function renderPhone(st) {
    let ids = st.phone;
    if (ids === 'same') ids = lastPhone;
    else lastPhone = ids;
    const url = st.url || STEPS.slice(0, cur + 1).reverse().find((x) => x.url).url;
    const kids = [
      h('div', { class: `${P}pbar` }, st.cdc ? 'car.com · no request' : 'car.com'),
      h('div', { class: `${P}purl` }, `/listing/?${url}`),
      h('div', { class: `${P}pchips` }, ...['Mumbai', '₹4–8 L', 'Tata, Hyundai', 'AMT', 'price ↑'].map((t) => h('span', null, t))),
    ];
    if (ids === 'loading' || !ids) {
      kids.push(h('div', { class: `${P}pmeta` }, 'loading…'), h('div', { class: `${P}pskel` }), h('div', { class: `${P}pskel` }), h('div', { class: `${P}pskel` }));
    } else {
      kids.push(h('div', { class: `${P}pmeta${st.stale ? ` ${P}bad` : ''}` }, `${st.count} cars · page ${st.pageNo} of 2${st.stale ? ' · shows 2' : ''}`));
      for (const id of ids) {
        const c = CAR[id];
        if (st.stale && id === 111) { kids.push(h('div', { class: `${P}pcard is-nil` }, h('b', null, '111 · nil'), h('span', null, 'sold; skipped'))); continue; }
        kids.push(h('div', { class: `${P}pcard` }, h('b', null, `${c.model} ${c.variant}`), h('span', null, `${lakh(c.price)} · ${CITY[c.city]} · #${c.id}`)));
      }
    }
    phone.classList.toggle('is-idle', !!st.cdc);
    phone.replaceChildren(...kids);
  }

  function renderStrip(st) {
    const { read, res, ttl, sold } = st.strip;
    const rows = ROWS.map((r) => ({ ...r }));
    let resLabel = 'not cached';
    if (res === 'new' || res === 'ttl') resLabel = `zset · TTL ${ttl || 600} s`;
    rows.push({ id: 'res', key: 'page:price:6d53…', f: resLabel });
    const idx = cur;
    const g = strip({
      rows, cols: CARS,
      rowCls: (r) => (r.id === 'res' ? `is-res${res === 'nil' ? ' is-miss' : ''}` : (idx === 2 ? 'is-read' : '')),
      cell: (r, c) => {
        if (r.id === 'res') {
          if (!res || res === 'nil') return ['', ''];
          if (!RES_IDS.has(c.id)) return ['', ''];
          if (sold && c.id === 111) return ['is-stale', '', '111 is still in the stored result'];
          return ['is-look', ''];
        }
        if (sold && c.id === 111 && r.test(c)) return ['is-gone', '', 'removed by ZREM'];
        const on = read > 0 && r.test(c);
        return [on ? 'is-in' : '', ''];
      },
    });
    const kids = [h('div', { class: `${P}lab` }, idx <= 1 ? 'Valkey: the four filters (not read yet) and the result key' : 'Valkey: the cars each filter selects, and the stored result'), g];
    if (st.weights) {
      const sw = segBtns([[true, 'WEIGHTS 1 0 0 0'], [false, 'default: SUM']], () => weights, (v) => { weights = v; render(); });
      const sc = (c) => (weights ? c.price : c.price + c.city + c.make + 1);
      const order = [...RESULT].sort((a, b) => sc(a) - sc(b));
      kids.push(h('div', { class: `${P}ctl` }, h('span', { class: `${P}lab` }, 'Scores in the result'), sw.el),
        h('div', { class: `${P}scores${weights ? '' : ' is-bad'}` }, ...order.map((c) => h('span', null, h('b', null, String(c.id)), ` ${sc(c)}`))),
        h('p', { class: `${P}small ${weights ? '' : P + 'bad'}` }, weights
          ? 'Score = price.'
          : 'Default AGGREGATE SUM: score = price + city_id + make_id + 1. The order survives here, but the score is no longer the price. In this query only make_id differs (10 or 12), so cars within 2 rupees of each other can change places.'));
    }
    stripBox.replaceChildren(...kids);
  }

  const answers = {};
  function render() {
    const st0 = STEPS[cur];
    const pending = st0.ask && !(cur in answers);
    // Before the reader answers, show the question and hold back the outcome.
    const st = pending ? { ...st0, phone: 'loading', tone: null, term: st0.term.filter(([k]) => k === 'c'), rt: 0, cmds: 0, strip: st0.strip } : st0;
    meter.hidden = pending;
    head.className = `${P}step${st.tone ? ` is-${st.tone}` : ''}`;
    head.innerHTML = `<div class="${P}who">${st.who}</div><h4>${st.title}</h4>`;
    if (pending) {
      head.append(h('div', { class: `${P}ask` }, h('p', null, h('b', null, 'Guess first. '), st0.ask.q),
        h('div', { class: `${P}seg` }, ...st0.ask.opts.map((o) => h('button', { class: `${P}btn`, type: 'button', onclick: () => { answers[cur] = o; render(); } }, o)))));
    } else {
      if (st0.ask) {
        const ok = answers[cur] === st0.ask.right;
        head.append(h('p', { class: `${P}verdict` }, h('b', { class: ok ? `${P}good` : `${P}look` }, ok ? `Right: ${st0.ask.right}. ` : `${st0.ask.right}, not ${answers[cur]}. `), st0.ask.why));
      }
      const p = h('p'); p.innerHTML = st.text; head.append(p);
    }
    const dim = pending ? ['strip'] : (st.dim || []);
    phone.classList.toggle('is-dim', dim.includes('phone'));
    stripBox.classList.toggle('is-dim', dim.includes('strip'));
    renderPhone(st);
    term.replaceChildren(h('div', { class: `${P}thead` }, st.cdc ? 'valkey-cli · change-log consumer' : 'valkey-cli · web server'),
      ...st.term.map(([k, t]) => h('div', { class: `${P}tl ${{ c: 'is-cmd', r: 'is-rep', n: 'is-nil', q: 'is-q', m: 'is-cm' }[k]}` },
        k === 'c' || k === 'q' ? h('span', { class: `${P}pr` }, k === 'q' ? '+ ' : '> ') : null, t)));
    const hit = st.tone === 'good';
    meter.replaceChildren(...[
      h('span', { class: `${P}lab` }, st.who),
      h('span', { class: `${P}trips`, title: 'filled: round trips used; hollow: extra round trips if each command were sent alone' },
        ...Array.from({ length: st.cmds }, (_, i) => h('i', { class: i < st.rt ? `is-rt${hit ? ' is-hit' : ''}` : 'is-extra' }))),
      h('span', null, h('b', { class: hit ? `${P}good` : '' }, String(st.rt)), ` round trip${st.rt === 1 ? '' : 's'} · `, h('b', null, String(st.cmds)), ' commands',
        st.queued ? h('span', { class: `${P}q` }, ` + ${st.queued} queued`) : null),
      st.cmds > st.rt ? h('span', { class: `${P}small` }, `hollow: ${st.cmds - st.rt} more round trip${st.cmds - st.rt === 1 ? '' : 's'} if each command were sent alone`) : null].filter(Boolean));
    renderStrip(st);
  }

  function go(n) {
    n = Math.max(0, Math.min(STEPS.length - 1, n));
    if (n === cur) return;
    cur = n;
    stops.forEach((b, k) => {
      b.classList.toggle('is-past', k < cur);
      if (k === cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    back.disabled = cur === 0;
    next.disabled = cur === STEPS.length - 1;
    const sr = stops[cur].parentElement;
    const br = stops[cur].getBoundingClientRect(); const pr = sr.getBoundingClientRect();
    if (br.left < pr.left || br.right > pr.right) sr.scrollLeft += br.left - pr.left - pr.width / 3;
    render();
  }
  go(0);
}

register({ 'filter-sets': initFilterSets, 'sql-joins': initSqlJoins, keys: initKeys, 'reco-order': initReco, 'listing-request': initListing });

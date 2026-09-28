/*
 * Figures for "Building blazingly fast pre-owned car platform with Valkey – Part 1".
 *
 *   write-coverage  which writes each cache-invalidation hook can see
 *   change-path     one price change from UPDATE to the next GET, step by step
 *   fault-map       the same pipeline with the five failures from the text
 *
 * Checked against:
 *   - pratikgajjar/mysql-data-stream-kafka @ ea9296b (main.py): only_events,
 *     topic = table name, no message key, JSON value, position saved on exit
 *   - kafka-python 1.4.6: acks=1 default, random partition when key is None
 *   - mysql-replication 0.19: before_values / after_values / values
 *   - django-redis 6.0: key ":1:<key>", pickle then gzip, SET … PX <ms>
 *   - Django 6.1: QuerySet.update(), bulk_create(), bulk_update() send no post_save
 * Car id, prices, binlog positions and offsets are sample values.
 */
import { h, s, stepper, colorKey, codeBlock, register, uid } from './lib.js';

const P = 'v-car1-';

/* ------------------------------------------------------------ helpers */

/** Call rebuild('wide' | 'tall') now and whenever the app crosses 560px. */
function onLayout(app, rebuild) {
  let cur = null;
  const check = () => {
    const k = app.clientWidth < 560 ? 'tall' : 'wide';
    if (k !== cur) { cur = k; rebuild(k); }
  };
  if ('ResizeObserver' in window) new ResizeObserver(check).observe(app);
  check();
}

function markers(id) {
  const m = (name, color) => s('marker', { id: `${id}-${name}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L8,4 L0,8 z', style: `fill:var(--${color})` }));
  return s('defs', null, m('ink', 'ink'), m('green', 'green'), m('purple', 'purple'), m('red', 'red'), m('line', 'line'));
}

const pathD = (pts) => `M${pts.map((q) => q.join(',')).join(' L')}`;

/**
 * Draw a box with one or two sections. spec.a / spec.b are line arrays:
 * first line is the title, the rest are small labels, '@name' is a live value.
 */
function drawBox(rect, spec, split, refs, dashed) {
  const [x, y, w, hh] = rect;
  const g = s('g', { class: 'node' });
  g.append(s('rect', { x, y, width: w, height: hh, class: `box${dashed ? ' dash' : ''}` }));
  const secs = [];
  if (!spec.b) secs.push([x, y, w, hh, spec.a]);
  else if (split === 'v') secs.push([x, y, w, hh / 2, spec.a], [x, y + hh / 2, w, hh / 2, spec.b]);
  else secs.push([x, y, w / 2, hh, spec.a], [x + w / 2, y, w / 2, hh, spec.b]);
  if (spec.b) {
    g.append(split === 'v'
      ? s('line', { x1: x, x2: x + w, y1: y + hh / 2, y2: y + hh / 2, class: 'rule' })
      : s('line', { x1: x + w / 2, x2: x + w / 2, y1: y, y2: y + hh, class: 'rule' }));
  }
  for (const [sx, sy, sw, sh, lines] of secs) {
    const hs = lines.map((t, k) => (k === 0 ? 15 : 13));
    let yy = sy + sh / 2 - hs.reduce((a, b) => a + b, 0) / 2;
    lines.forEach((t, k) => {
      yy += hs[k];
      const live = t.startsWith('@');
      const te = s('text', { x: sx + sw / 2, y: yy - 3.5, 'text-anchor': 'middle', class: live ? 't-s t-b t-data' : k === 0 ? 't-m t-b' : 't-xs t-mute' }, live ? '' : t);
      if (live) refs[t.slice(1)] = te;
      g.append(te);
    });
  }
  return g;
}

/** A small data chip that slides between points. */
function chip(svg) {
  const g = s('g', { class: `${P}chip`, style: 'display:none' });
  const r = s('rect', { x: 0, y: -10, height: 20, rx: 2 });
  const t = s('text', { x: 0, y: 4, class: 't-s t-b', 'text-anchor': 'middle' });
  g.append(r, t);
  svg.append(g);
  return {
    show(x, y, label, kind = 'data') {
      t.textContent = label;
      const w = label.length * 7.3 + 14;
      r.setAttribute('x', -w / 2); r.setAttribute('width', w);
      g.setAttribute('class', `${P}chip is-${kind}`);
      g.style.display = '';
      g.style.transform = `translate(${x}px, ${y}px)`;
    },
    hide() { g.style.display = 'none'; },
  };
}

/* ====================================================== WRITE COVERAGE */

const HOOKS = [
  {
    id: 'signal', name: 'Model signals', chip: 'post_save',
    pros: ['Runs in the same process, right after save()'],
    cons: ['Sees only Django save() and create()', 'Cache code mixes with model code'],
  },
  {
    id: 'domain', name: 'Domain layer', chip: 'CarService',
    pros: ['Sees every Django write that goes through the service'],
    cons: ['The PHP portal and the scripts never call it', 'Each new code path must remember to'],
  },
  {
    id: 'binlog', name: 'Binlog reader', chip: 'binlog reader', pick: true,
    pros: ['Sees every committed row change, from any client', 'No cache code in the apps'],
    cons: ['Three new parts to run: producer, Kafka, consumer', 'The cache updates after the commit, not with it', 'Needs a rule per table to find the car id'],
  },
];

/* Sample writes. `lane` is the path the write takes to MySQL. */
const WRITES = [
  {
    id: 'save', lane: 'save', who: 'Inventory app', label: 'Edit owner', table: 'cars',
    code: ['car = Car.objects.get(id=«2323»)', 'car.owner = «2»', 'car.save()'],
    hit: { signal: 1, domain: 1, binlog: 1 },
    why: { signal: 'save() sends post_save after the UPDATE.' },
  },
  {
    id: 'update', lane: 'bulk', who: 'Inventory app', label: 'Swap a photo', table: 'car_images',
    code: ['CarImage.objects.filter(car_id=«2323», image_url=old)', '    .update(image_url=new)'],
    hit: { signal: 0, domain: 1, binlog: 1 },
    why: { signal: 'QuerySet.update() runs one UPDATE and sends no post_save.', domain: 'Caught, if this code calls the service instead of the ORM.' },
  },
  {
    id: 'bulk', lane: 'bulk', who: 'Inventory app', label: 'Add 4 photos', table: 'car_images',
    code: ['CarImage.objects.bulk_create([', '    CarImage(car_id=«2323», image_url=u) for u in urls])'],
    hit: { signal: 0, domain: 1, binlog: 1 },
    why: { signal: 'bulk_create() inserts in one query and sends no post_save.', domain: 'Caught, if this code calls the service instead of the ORM.' },
  },
  {
    id: 'ops', lane: 'ops', who: 'Ops portal', label: 'Mark sold', table: 'cars',
    code: ["UPDATE cars SET status = «'sold'» WHERE id = «2323»;"],
    hit: { signal: 0, domain: 0, binlog: 1 },
    why: { signal: 'The portal is a CakePHP app. Django never sees the write.', domain: 'The portal writes to MySQL directly and never calls the Django service.' },
  },
  {
    id: 'ds', lane: 'ds', who: 'Price script', label: 'Daily prices', table: 'cars',
    code: ['cur.executemany(', '    "UPDATE cars SET price = %s WHERE id = %s",', '    rows)                     // 10,000 cars'],
    hit: { signal: 0, domain: 0, binlog: 1 },
    why: { signal: 'A Python script with its own MySQL connection. No Django model runs.', domain: 'The script writes to MySQL directly and never calls the Django service.' },
  },
];

const COV = {
  wide: {
    vb: [960, 292],
    boxes: {
      inv: [10, 12, 330, 134], ops: [10, 162, 330, 54], ds: [10, 230, 330, 54],
      mysql: [430, 12, 210, 272], valkey: [760, 96, 190, 104],
    },
    titles: { inv: [22, 32], ops: [22, 194], ds: [22, 262] },
    domain: [22, 44, 78, 92],
    signal: [236, 56, 96, 24],
    tables: { cars: [446, 40, 178, 30], car_images: [446, 80, 178, 30], car_features: [446, 120, 178, 30] },
    binlog: [446, 206, 178, 60],
    binlogChip: [560, 250, 112, 26],
    lanes: {
      save: [[100, 68], [430, 68]], bulk: [[100, 114], [430, 114]],
      ops: [[340, 189], [430, 189]], ds: [[340, 257], [430, 257]],
    },
    laneLabels: { save: [112, 62], bulk: [112, 108] },
    commit: [[535, 154], [535, 206]], commitLabel: true,
    hookPath: {
      signal: [[284, 56], [284, 4], [855, 4], [855, 96]],
      domain: [[61, 44], [61, 4], [855, 4], [855, 96]],
      binlog: [[672, 263], [712, 263], [712, 170], [760, 170]],
    },
    miss: { save: [405, 68], bulk: [405, 114], ops: [385, 189], ds: [385, 257] },
  },
  tall: {
    vb: [360, 640],
    boxes: {
      inv: [8, 8, 296, 134], ops: [8, 154, 296, 46], ds: [8, 212, 296, 46],
      mysql: [8, 290, 344, 210], valkey: [8, 544, 344, 88],
    },
    titles: { inv: [20, 28], ops: [20, 182], ds: [20, 240] },
    domain: [20, 40, 64, 92],
    signal: [194, 54, 100, 24],
    tables: { cars: [22, 318, 150, 28], car_images: [22, 354, 150, 28], car_features: [22, 390, 150, 28] },
    binlog: [22, 430, 150, 56],
    binlogChip: [190, 445, 110, 26],
    lanes: {
      save: [[84, 66], [320, 66], [320, 290]], bulk: [[84, 112], [328, 112], [328, 290]],
      ops: [[304, 177], [336, 177], [336, 290]], ds: [[304, 235], [344, 235], [344, 290]],
    },
    laneLabels: { save: [92, 60], bulk: [92, 106] },
    commit: [[97, 418], [97, 430]],
    hookPath: {
      signal: [[244, 78], [244, 92], [180, 92], [180, 272], [4, 272], [4, 588], [8, 588]],
      domain: [[20, 86], [4, 86], [4, 588], [8, 588]],
      binlog: [[245, 471], [245, 544]],
    },
    miss: { save: [320, 272], bulk: [328, 272], ops: [336, 272], ds: [344, 272] },
  },
};

function initCoverage(fig, app) {
  const id = uid('car1c');
  let hook = 'binlog';
  let write = 'ops';
  let L; let refs;
  const stage = h('div');

  const hookBtns = HOOKS.map((hk) => h('button', {
    type: 'button', class: `wv-btn ${P}hook${hk.pick ? ` ${P}hook--pick` : ''}`,
    onclick: () => { hook = hk.id; paint(); },
  }, hk.name, hk.pick ? h('span', { class: `${P}ours` }, 'our pick') : null));
  const proscons = h('ul', { class: `${P}pc`, 'aria-live': 'polite' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });

  const table = h('table', { class: `wv-mini ${P}matrix` });
  const thead = h('tr', null, h('th', null, 'sample write'), ...HOOKS.map((hk) => h('th', { 'data-h': hk.id },
    h('button', { type: 'button', class: `${P}th`, onclick: () => { hook = hk.id; paint(); } }, hk.chip === 'binlog reader' ? 'binlog' : hk.chip))));
  const rows = WRITES.map((wr) => h('tr', { 'data-w': wr.id },
    h('td', null, h('button', { type: 'button', class: `${P}row`, onclick: () => { write = wr.id; paint(); } },
      h('b', null, wr.label), h('span', null, wr.who))),
    ...HOOKS.map((hk) => h('td', { 'data-h': hk.id, class: wr.hit[hk.id] ? 'ok' : 'bad' }, wr.hit[hk.id] ? '✓' : '✗'))));
  const total = h('tr', { class: `${P}total` }, h('td', null, 'writes seen'),
    ...HOOKS.map((hk) => h('td', { 'data-h': hk.id }, `${WRITES.filter((w) => w.hit[hk.id]).length} / ${WRITES.length}`)));
  table.append(h('thead', null, thead), h('tbody', null, ...rows, total));

  app.append(
    h('div', { class: `${P}bar` }, h('span', { class: `${P}lbl` }, 'Hook'), h('div', { class: 'wv-seg' }, ...hookBtns)),
    proscons, stage, note,
    h('div', { class: 'wv-scroll' }, table),
    colorKey([['k-opt', 'hook you can pick'], ['k-pick', 'the hook we chose'], ['k-look', 'this write'], ['k-data', 'rows'], ['k-safe', 'cache rebuilt'], ['k-gap', 'write missed, page stale']]),
  );

  function build(kind) {
    L = COV[kind];
    refs = { lanes: {}, tables: {}, hooks: {}, hookPaths: {} };
    const [W, H] = L.vb;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.getAttribute('aria-label') || 'Writers, MySQL and Valkey' });
    svg.append(markers(id));

    const b = L.boxes;
    for (const k of ['inv', 'ops', 'ds']) svg.append(s('rect', { x: b[k][0], y: b[k][1], width: b[k][2], height: b[k][3], class: 'box' }));
    const tt = (k, a, c) => s('text', { x: L.titles[k][0], y: L.titles[k][1], class: 't-m t-b' }, a, s('tspan', { class: 't-xs t-mute', dx: 8 }, c));
    svg.append(tt('inv', 'Inventory app', 'Django'), tt('ops', 'Ops portal', 'CakePHP'), tt('ds', 'Price scripts', 'Python + SQL'));

    // lanes into MySQL
    for (const [k, pts] of Object.entries(L.lanes)) {
      const p = s('path', { d: pathD(pts), class: 'edge', 'marker-end': `url(#${id}-ink)` });
      refs.lanes[k] = p;
      svg.append(p);
    }
    for (const [k, [x, y]] of Object.entries(L.laneLabels)) {
      svg.append(s('text', { x, y, class: 't-xs halo' }, k === 'save' ? 'save() · create()' : '.update() · bulk_create()'));
    }

    // MySQL with tables and binlog
    const [mx, my, mw, mh] = b.mysql;
    svg.append(s('rect', { x: mx, y: my, width: mw, height: mh, class: 'box' }));
    svg.append(s('text', { x: mx + 16, y: my + 20, class: 't-m t-b' }, 'MySQL', s('tspan', { class: 't-xs t-mute', dx: 8 }, 'primary')));
    for (const [t, [x, y, w, hh]] of Object.entries(L.tables)) {
      const g = s('g', { class: `${P}tbl` }, s('rect', { x, y, width: w, height: hh, class: 'box dash' }),
        s('text', { x: x + w / 2, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: 't-s' }, t));
      refs.tables[t] = g;
      svg.append(g);
    }
    const [bx, by, bw, bh] = L.binlog;
    svg.append(s('rect', { x: bx, y: by, width: bw, height: bh, class: 'box dash' }));
    svg.append(s('text', { x: bx + 12, y: by + 20, class: 't-s t-b' }, 'binlog'));
    refs.binlogRow = s('text', { x: bx + 12, y: by + 36, class: 't-xs t-data t-b' }, '');
    refs.binlogTbl = s('text', { x: bx + 12, y: by + 50, class: 't-xs t-data' }, '');
    svg.append(refs.binlogRow, refs.binlogTbl);
    svg.append(s('path', { d: pathD(L.commit), class: 'edge', 'marker-end': `url(#${id}-ink)` }));
    if (L.commitLabel) svg.append(s('text', { x: L.commit[0][0] + 6, y: (L.commit[0][1] + L.commit[1][1]) / 2 + 4, class: 't-xs t-mute' }, 'every commit'));

    // Valkey
    const [vx, vy, vw, vh] = b.valkey;
    svg.append(s('rect', { x: vx, y: vy, width: vw, height: vh, class: 'box' }));
    svg.append(s('text', { x: vx + vw / 2, y: vy + 22, 'text-anchor': 'middle', class: 't-m t-b' }, 'Valkey'));
    svg.append(s('text', { x: vx + vw / 2, y: vy + 42, 'text-anchor': 'middle', class: 't-s t-data t-b' }, ':1:dp:2323'));
    refs.vval = s('text', { x: vx + vw / 2, y: vy + 64, 'text-anchor': 'middle', class: 't-s t-b' }, '');
    refs.vsub = s('text', { x: vx + vw / 2, y: vy + 82, 'text-anchor': 'middle', class: 't-xs' }, '');
    svg.append(refs.vval, refs.vsub);

    // hook paths to Valkey (only the selected one shows)
    for (const [k, pts] of Object.entries(L.hookPath)) {
      const p = s('path', { d: pathD(pts), class: 'edge-ack', 'marker-end': `url(#${id}-green)` });
      refs.hookPaths[k] = p;
      svg.append(p);
    }

    // hook chips
    const hookChip = (k, [x, y, w, hh], label, vertical) => {
      const g = s('g', { class: `${P}hk` }, s('rect', { x, y, width: w, height: hh, rx: 2 }));
      if (vertical) {
        g.append(s('text', { x: x + w / 2, y: y + hh / 2 - 4, 'text-anchor': 'middle', class: 't-xs t-b' }, label));
        g.append(s('text', { x: x + w / 2, y: y + hh / 2 + 12, 'text-anchor': 'middle', class: 't-xs' }, 'domain'));
      } else g.append(s('text', { x: x + w / 2, y: y + hh / 2 + 4, 'text-anchor': 'middle', class: 't-s t-b' }, label));
      refs.hooks[k] = g;
      svg.append(g);
    };
    hookChip('domain', L.domain, 'CarService', true);
    hookChip('signal', L.signal, 'post_save');
    hookChip('binlog', L.binlogChip, 'reader');

    refs.miss = s('g', { class: `${P}miss` }, s('circle', { r: 9 }), s('text', { y: 4, 'text-anchor': 'middle', class: 't-s t-b' }, '✗'));
    svg.append(refs.miss);
    stage.replaceChildren(svg);
    paint();
  }

  function paint() {
    if (!refs) return;
    const wr = WRITES.find((w) => w.id === write);
    const hk = HOOKS.find((x) => x.id === hook);
    const caught = !!wr.hit[hook];

    hookBtns.forEach((bn, k) => bn.setAttribute('aria-pressed', String(HOOKS[k].id === hook)));
    proscons.replaceChildren(...hk.pros.map((t) => h('li', { class: 'pro' }, t)), ...hk.cons.map((t) => h('li', { class: 'con' }, t)));

    for (const [k, p] of Object.entries(refs.lanes)) {
      const on = k === wr.lane;
      p.setAttribute('class', on ? `edge ${P}hot` : 'edge is-dim');
      p.setAttribute('marker-end', `url(#${id}-${on ? 'purple' : 'ink'})`);
    }
    for (const [t, g] of Object.entries(refs.tables)) g.classList.toggle('is-hit', t === wr.table);
    refs.binlogRow.textContent = `${wr.id === 'bulk' ? 'Write_rows' : 'Update_rows'} event`;
    refs.binlogTbl.textContent = `table ${wr.table}`;
    for (const [k, g] of Object.entries(refs.hooks)) {
      const on = k === hook;
      g.setAttribute('class', `${P}hk${on ? (caught ? ' is-caught' : HOOKS.find((x) => x.id === k).pick ? ' is-pick' : ' is-opt') : ' is-off'}`);
    }
    for (const [k, p] of Object.entries(refs.hookPaths)) p.style.display = k === hook && caught ? '' : 'none';
    if (caught) {
      refs.miss.style.display = 'none';
      refs.vval.textContent = 'rebuilt';
      refs.vval.setAttribute('class', 't-s t-b t-safe');
      refs.vsub.textContent = 'fresh JSON';
      refs.vsub.setAttribute('class', 't-xs t-safe');
    } else {
      const [x, y] = L.miss[wr.lane];
      refs.miss.style.display = '';
      refs.miss.setAttribute('transform', `translate(${x},${y})`);
      refs.vval.textContent = 'old JSON';
      refs.vval.setAttribute('class', 't-s t-b t-bad');
      refs.vsub.textContent = 'stale up to 12 h (TTL)';
      refs.vsub.setAttribute('class', 't-xs t-bad');
    }

    const why = wr.why?.[hook] || (caught ? (hook === 'binlog' ? 'Every committed row change is in the binlog, whichever client wrote it.' : 'The write passes through the hook.') : '');
    note.className = `wv-note ${caught ? 'is-good' : 'is-bad'}`;
    note.innerHTML = `<span class="k">${wr.who}</span><b>${wr.label}</b>${codeBlock(wr.code)}<p><span class="${caught ? 'c-safe' : 'c-bad'}">${caught ? `${hk.name}: caught.` : `${hk.name}: missed.`}</span> ${why}${caught ? '' : ' The car page keeps the old JSON until its 12-hour TTL ends.'}</p>`;

    rows.forEach((r) => r.classList.toggle('is-sel', r.dataset.w === write));
    table.querySelectorAll('[data-h]').forEach((c) => c.classList.toggle('is-col', c.dataset.h === hook));
    table.querySelectorAll(`.${P}row`).forEach((bn, k) => bn.setAttribute('aria-pressed', String(WRITES[k].id === write)));
  }

  onLayout(app, build);
}

/* ======================================================== PIPELINE MAP */

const PIPE_NODES = {
  script: { a: ['price script', 'Python + SQL'] },
  mysql: { a: ['MySQL', '~10 tables'], b: ['binlog', '@pos'] },
  prod: { a: ['producer', 'binlog → Kafka'] },
  kafka: { a: ['Kafka', 'topic cars'], b: ['consumer offset', '@off'] },
  cons: { a: ['consumer', 'rebuild JSON'] },
  valkey: { a: ['Valkey', ':1:dp:2323'], b: ['price in JSON', '@price'] },
  api: { a: ['Django API', 'GET /listing/2323/'] },
  buyer: { a: ['buyer', 'from an ad'] },
};

/* [id, from, to, kind] kind: data | read | rebuild */
const PIPE_EDGES = [
  ['e1', 'script', 'mysql', 'data'], ['e2', 'mysql', 'prod', 'data'], ['e3', 'prod', 'kafka', 'data'],
  ['e4', 'kafka', 'cons', 'data'], ['e5', 'cons', 'valkey', 'data'], ['r1', 'cons', 'mysql', 'rebuild'],
  ['g1', 'buyer', 'api', 'read'], ['g2', 'api', 'valkey', 'read'],
];

const PIPE = {
  wide: {
    vb: [960, 262], split: 'v',
    nodes: {
      script: [10, 22, 130, 64], mysql: [180, 22, 160, 128], prod: [380, 86, 130, 64],
      kafka: [550, 22, 170, 128], cons: [770, 22, 180, 64], valkey: [770, 150, 180, 104],
      api: [320, 174, 220, 56], buyer: [10, 174, 160, 56],
    },
    anchors: {
      script: [75, 22], mysql: [260, 22], mysqlB: [260, 86], prod: [445, 86], kafka: [635, 22], kafkaB: [635, 86],
      cons: [860, 22], valkey: [860, 150], valkeyB: [860, 202], api: [430, 174], buyer: [90, 174],
    },
    edges: {
      e1: [[140, 54], [180, 54]], e2: [[340, 118], [380, 118]], e3: [[510, 118], [530, 118], [530, 54], [550, 54]],
      e4: [[720, 54], [770, 54]], e5: [[860, 86], [860, 150]], r1: [[800, 22], [800, 8], [300, 8], [300, 22]],
      g1: [[170, 202], [320, 202]], g2: [[540, 202], [770, 202]],
    },
    labels: [['reads the car rows', 550, 4, 'middle'], ['GET', 655, 196, 'middle']],
    durable: [['durable', 260, 164], ['durable', 635, 164]],
  },
  tall: {
    vb: [360, 632], split: 'h',
    nodes: {
      script: [10, 10, 300, 50], mysql: [10, 86, 300, 60], prod: [10, 172, 300, 50], kafka: [10, 248, 300, 60],
      cons: [10, 334, 300, 50], valkey: [10, 410, 300, 60], api: [10, 496, 300, 50], buyer: [10, 572, 300, 50],
    },
    anchors: {
      script: [160, 10], mysql: [85, 86], mysqlB: [235, 86], prod: [160, 172], kafka: [85, 248], kafkaB: [235, 248],
      cons: [160, 334], valkey: [85, 410], valkeyB: [235, 410], api: [160, 496], buyer: [160, 572],
    },
    edges: {
      e1: [[85, 60], [85, 86]], e2: [[235, 146], [235, 172]], e3: [[85, 222], [85, 248]], e4: [[85, 308], [85, 334]],
      e5: [[85, 384], [85, 410]], r1: [[310, 359], [342, 359], [342, 74], [130, 74], [130, 86]],
      g1: [[160, 572], [160, 546]], g2: [[160, 496], [160, 470]],
    },
    labels: [['reads', 350, 220, 'middle', true], ['GET', 168, 488, 'start']],
    durable: [],
  },
};

function pipeline(fig, stage, onBuilt) {
  const id = uid('car1p');
  const api = { L: null, nodes: {}, edges: {}, refs: {}, chip: null, svg: null };
  function build(kind) {
    const L = PIPE[kind];
    api.L = L; api.nodes = {}; api.edges = {}; api.refs = {};
    const [W, H] = L.vb;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.getAttribute('aria-label') || 'Change pipeline' });
    svg.append(markers(id));
    for (const [eid, , , k] of PIPE_EDGES) {
      const p = s('path', {
        d: pathD(L.edges[eid]), class: k === 'rebuild' ? 'edge-ctl' : 'edge',
        'marker-end': k === 'rebuild' ? `url(#${id}-line)` : `url(#${id}-ink)`,
      });
      p.dataset.kind = k;
      api.edges[eid] = p;
      svg.append(p);
    }
    for (const [t, x, y, a, rot] of L.labels) {
      svg.append(s('text', { x, y, class: 't-xs t-mute halo', 'text-anchor': a, transform: rot ? `rotate(-90 ${x} ${y})` : null }, t));
    }
    for (const [t, x, y] of L.durable) svg.append(s('text', { x, y, class: 't-xs t-safe t-up t-b', 'text-anchor': 'middle' }, t));
    for (const [nid, spec] of Object.entries(PIPE_NODES)) {
      const g = drawBox(L.nodes[nid], spec, L.split, api.refs, false);
      g.dataset.id = nid;
      api.nodes[nid] = g;
      svg.append(g);
    }
    api.chip = chip(svg);
    api.svg = svg;
    api.id = id;
    stage.replaceChildren(svg);
    onBuilt(api);
  }
  onLayout(stage.parentElement, build);
  return api;
}

function setEdge(api, eid, state) {
  const p = api.edges[eid];
  const kind = p.dataset.kind;
  const base = kind === 'rebuild' ? 'edge-ctl' : 'edge';
  p.setAttribute('class', `${base}${state === 'hot' ? ` ${P}hot` : state === 'dim' ? ' is-dim' : ''}`);
  const m = state === 'hot' ? 'purple' : kind === 'rebuild' ? 'line' : 'ink';
  p.setAttribute('marker-end', `url(#${api.id}-${m})`);
}

/* ----------------------------------------------------- one price change */

const POS0 = '000412 : 18411';
const POS1 = '000412 : 18807';
const OFF0 = 'p2 → 88,120';
const OFF1 = 'p2 → 88,121';
const MSG_BYTES = 296; // len(json.dumps(sample event)) for the row below

const CHANGE = [
  {
    label: 'Write', focus: ['script', 'mysql'], hot: ['e1'], chipAt: 'mysql', chip: 'price 510000',
    pos: POS1, off: OFF0, price: 'old',
    title: 'A script changes the price', where: 'price script → MySQL primary',
    body: () => `${codeBlock([
      'UPDATE cars SET price = «510000» WHERE id = «2323»;',
      'COMMIT;',
    ])}<p>MySQL appends one <code>Update_rows</code> event to the binlog, with the whole row before and after. Valkey still holds the JSON with <span class="c-bad">price 525,000</span>, so every request for car 2323 now gets the old price.</p>`,
  },
  {
    label: 'Read binlog', focus: ['mysql', 'prod'], hot: ['e2'], chipAt: 'prod', chip: 'UpdateRowsEvent',
    pos: POS1, off: OFF0, price: 'old',
    title: 'The producer reads the row event', where: 'producer · BinLogStreamReader',
    body: () => `${codeBlock([
      'stream = BinLogStreamReader(',
      '    connection_settings=config["mysql_config"],',
      '    server_id=100, blocking=True,',
      '    only_events=[WriteRowsEvent, UpdateRowsEvent],',
      `    log_file=«"mysql-bin.000412"», log_pos=«18411», resume_stream=True)`,
      'for binlog_event in stream:',
      '    for row in binlog_event.rows:',
      '        row["before_values"]   // {"id": 2323, …, "price": «525000»}',
      '        row["after_values"]    // {"id": 2323, …, "price": «510000»}',
    ], [3, 7, 8])}<p>The producer connects to MySQL as a replica and receives row events. This needs <code>binlog_format=ROW</code>, the default since MySQL 5.7.7. <span class="c-bad">The public library asks only for inserts and updates.</span> A deleted row, such as a removed photo, never reaches Kafka unless <code>DeleteRowsEvent</code> is added to <code>only_events</code>.</p>`,
  },
  {
    label: 'Send', focus: ['prod', 'kafka'], hot: ['e3'], chipAt: 'kafka', chip: 'p2 · 88,120',
    pos: POS1, off: OFF0, price: 'old',
    title: 'One JSON message per row', where: 'producer → Kafka topic cars',
    body: () => `${codeBlock([
      'producer.send(topic=«"cars"», value=«b\'{"schema": "carsdb", "table": "cars",',
      '    "type": "UpdateRowsEvent", "row": {"before_values": {…},',
      '    "after_values": {…, "price": 510000}}}\'»)',
      '// no key: kafka-python picks a random partition → p2, offset 88,120',
      '// acks=1 (default): the leader has it, followers may not yet',
    ], [3])}<p>The topic is the table name. For this sample row the value is ${MSG_BYTES} bytes of JSON. With no key, two changes to car 2323 can land in different partitions and arrive in any order. Sending the car id as the key keeps one car's changes in one partition, in order.</p>`,
  },
  {
    label: 'Map', focus: ['kafka', 'cons'], hot: ['e4'], chipAt: 'cons', chip: 'car 2323',
    pos: POS1, off: OFF0, price: 'old',
    title: 'The consumer finds the car id', where: 'consumer (sketch)',
    body: () => `${codeBlock([
      'CAR_ID = {                          // table → column with the car id',
      '    "cars":         lambda r: r["id"],',
      '    "car_images":   lambda r: r["car_id"],',
      '    "car_features": lambda r: r["car_id"],',
      '}',
      'msg = json.loads(record.value)      // p2, offset 88,120',
      'row = msg["row"].get("after_values") or msg["row"]["values"]',
      'car_id = CAR_ID[msg["table"]](row)  // «2323»',
    ], [1, 7])}<p>The binlog knows rows, not car pages. The consumer needs one rule per table to find the car id. When someone adds a table to the car page, they add a rule here.</p>`,
  },
  {
    label: 'Rebuild', focus: ['cons', 'valkey', 'mysql'], hot: ['r1', 'e5'], chipAt: 'valkey', chip: 'SET',
    pos: POS1, off: OFF0, price: 'new',
    title: 'Rebuild the JSON and write it to Valkey', where: 'consumer → MySQL, Valkey',
    body: () => `${codeBlock([
      'payload = build_car_json(2323)          // reads ~10 tables',
      'cache.set("dp:2323", payload, timeout=12 * 3600)',
      '// django-redis: pickle → gzip → one SET',
      'SET «:1:dp:2323» «1f 8b 08 00 …» PX «43200000»',
    ], [3])}<p>The consumer reads the car's current rows, not the values in the event, so a late or repeated event still writes the latest state. django-redis adds the <code>:1:</code> prefix (key version 1) and sends 12 hours as 43,200,000 ms. The cache now holds <span class="c-safe">price 510,000</span>. To invalidate instead, the consumer sends <code>DEL :1:dp:2323</code>.</p>`,
  },
  {
    label: 'Commit', focus: ['cons', 'kafka'], hot: [], chipAt: null,
    pos: POS1, off: OFF1, price: 'new', offHot: true,
    title: 'Commit the offset after the SET', where: 'consumer → Kafka',
    body: () => `${codeBlock([
      'cache.set(...)          // returned OK',
      'consumer.commit()       // p2: 88,120 → «88,121»',
    ], [1])}<p>The offset moves only after the SET returns. If the consumer dies between the two, Kafka hands out offset 88,120 again and the consumer builds the same JSON again. Delivery is at-least-once, and a rebuild is safe to repeat.</p>`,
  },
  {
    label: 'Serve', focus: ['buyer', 'api', 'valkey'], hot: ['g1', 'g2'], chipAt: 'api', chip: '200 · 510000', chipKind: 'safe',
    pos: POS1, off: OFF1, price: 'new',
    title: 'The next buyer gets the new price', where: 'buyer → Django API → Valkey',
    body: () => `${codeBlock([
      'GET /listing/2323/',
      'cache.get("dp:2323")    // GET :1:dp:2323 → gunzip → unpickle',
      '→ 200 {"id": 2323, "price": «510000», …}',
    ], [2])}<p>One key lookup and no MySQL query. The price was wrong from step 1 to step 5. That window is the lag of the pipeline: binlog, producer, Kafka, consumer.</p>`,
  },
];

function setPrice(api, state) {
  const t = api.refs.price;
  if (!t) return;
  t.textContent = state === 'new' ? '510,000 · fresh' : state === 'old' ? '525,000 · stale' : '510,000';
  t.setAttribute('class', `t-s t-b ${state === 'new' ? 't-safe' : state === 'old' ? 't-bad' : 't-data'}`);
  api.nodes.valkey.classList.toggle('is-bad', state === 'old');
}

function anchor(api, key) {
  return api.L.anchors[key] || api.L.anchors[key.replace(/B$/, '')];
}

function initChange(fig, app) {
  const stage = h('div');
  const insp = h('div', { class: 'wv-insp', 'aria-live': 'polite' });
  app.append(stage);
  let step = 0;
  let api;
  function show(i) {
    step = i;
    if (!api?.L) return;
    const st = CHANGE[i];
    for (const [nid, g] of Object.entries(api.nodes)) {
      g.classList.toggle('is-focus', st.focus.includes(nid));
      g.classList.toggle('is-dim', !st.focus.includes(nid) && !(nid === 'valkey' && st.price === 'old'));
    }
    for (const eid of Object.keys(api.edges)) setEdge(api, eid, st.hot.includes(eid) ? 'hot' : 'dim');
    api.refs.pos.textContent = st.pos;
    api.refs.off.textContent = st.off;
    api.refs.off.setAttribute('class', `t-s t-b ${st.offHot ? 't-safe' : 't-data'}`);
    setPrice(api, st.price);
    if (st.chipAt) {
      const [x, y] = anchor(api, st.chipAt);
      api.chip.show(x, y, st.chip, st.chipKind || 'data');
    } else api.chip.hide();
    insp.innerHTML = `<h4><span>${String(i + 1).padStart(2, '0')} · ${st.title}</span><span class="where">${st.where}</span></h4>${st.body()}`;
  }
  const bar = stepper(app, CHANGE, (i) => show(i));
  app.prepend(bar.el);
  app.append(colorKey([['k-look', 'this step'], ['k-data', 'sample data'], ['k-gap', 'stale cache'], ['k-safe', 'fresh cache, durable']]), insp);
  api = pipeline(fig, stage, (a) => { api = a; show(step); });
  bar.go(0);
}

/* ---------------------------------------------------------- fault map */

/* Order matches the numbered failure sections in the post. */
const FAULTS = [
  {
    node: 'cons', title: 'Consumer node fails', resume: 'kafkaB', resumeLabel: 'it resumes at the last committed offset',
    body: 'Kafka keeps the messages, for 7 days by default. On restart the consumer group reads from the last committed offset, so some cars are rebuilt twice, with the same result. Until it catches up, car pages keep the old JSON, at most until the 12-hour TTL removes the key.',
  },
  {
    node: 'prod', title: 'Producer node fails', resume: 'mysqlB', resumeLabel: 'it resumes at the saved binlog position',
    body: 'The binlog stays on the MySQL disk. The producer restarts from the binlog file and position it saved, and may send a few events again. The consumer rebuilds those cars twice, which is harmless. Nothing is lost while MySQL still has that binlog file.',
  },
  {
    node: 'valkey', title: 'Valkey server fails', resume: 'kafkaB', resumeLabel: 'the offset stays put, so the message is retried',
    body: 'The SET fails, so the consumer does not commit the offset and retries once Valkey is back. After a failover to a replica, the last writes before the failure can be missing, because replication is asynchronous. The 12-hour TTL limits how long such a key stays wrong.',
  },
  {
    node: 'kafka', title: 'Kafka broker fails', resume: 'kafka', resumeLabel: 'a follower becomes the leader of the partition',
    body: 'With replication factor 3, min.insync.replicas=2 and acks="all" on the producer, one broker can fail without losing a change. kafka-python defaults to acks=1: the leader confirms before any follower has the message, so a leader crash at that moment can drop one change. That car stays stale until its TTL ends.',
  },
  {
    node: 'mysql', title: 'MySQL fails', resume: 'mysqlB', resumeLabel: 'the producer resumes from its binlog position',
    body: 'A restart keeps the binlog files, and the producer reconnects where it stopped. If a binlog file is purged before the producer reads it, those changes are gone. Rebuild every active car with the management command, and keep enough binlog on disk to cover a long producer outage.',
  },
];

function initFaults(fig, app) {
  const stage = h('div');
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  app.append(stage, colorKey([['k-gap', 'failed part'], ['k-look', 'where it resumes'], ['k-safe', 'durable']]), note);
  let sel = -1;
  let api; let marks = [];

  function pick(k) {
    sel = k;
    if (!api?.L) return;
    marks.forEach((m, j) => m.classList.toggle('is-on', j === k));
    const f = FAULTS[k];
    const rnode = f.resume.replace(/B$/, '');
    for (const [nid, g] of Object.entries(api.nodes)) {
      g.classList.toggle('is-bad', nid === f.node);
      g.classList.toggle('is-focus', nid === rnode && nid !== f.node);
      g.classList.remove('is-dim');
    }
    api.refs.pos.setAttribute('class', `t-s t-b ${f.resume === 'mysqlB' ? 't-look' : 't-data'}`);
    api.refs.off.setAttribute('class', `t-s t-b ${f.resume === 'kafkaB' ? 't-look' : 't-data'}`);
    note.className = 'wv-note is-bad';
    note.innerHTML = `<span class="k">${k + 1}</span><b>${f.title}.</b> ${f.body} <span class="c-look">${f.resumeLabel[0].toUpperCase()}${f.resumeLabel.slice(1)}.</span>`;
  }
  function idle() {
    note.className = 'wv-note';
    note.innerHTML = '<span class="k">Faults</span>Tap a red number. The numbers match the sections below.';
  }

  api = pipeline(fig, stage, (a) => {
    api = a;
    a.refs.pos.textContent = POS1;
    a.refs.off.textContent = OFF1;
    setPrice(a, 'plain');
    for (const eid of Object.keys(a.edges)) setEdge(a, eid, 'plain');
    marks = FAULTS.map((f, k) => {
      const [x, y, w] = a.L.nodes[f.node];
      const cx = x + w - 12; const cy = a.L.nodes[f.node][1];
      const m = s('g', { class: 'mark', tabindex: 0, role: 'button', 'aria-label': `Failure ${k + 1}: ${f.title}` },
        s('circle', { cx, cy, r: 9 }), s('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle' }, String(k + 1)));
      m.addEventListener('click', () => pick(k));
      m.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(k); e.preventDefault(); } });
      a.svg.append(m);
      return m;
    });
    if (sel >= 0) pick(sel); else idle();
  });
}

register({ 'write-coverage': initCoverage, 'change-path': initChange, 'fault-map': initFaults });

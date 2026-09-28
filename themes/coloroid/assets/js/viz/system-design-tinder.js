/*
 * system-design-tinder — figures for "System Design - Tinder".
 *
 *   arch-paths     (Fig. 1) the architecture, one path at a time, hop by hop
 *                  at the reader's pace, with the post's peak rate and target.
 *   deck-hero      (Fig. 2) the reader swipes a precomputed deck and sees
 *                  what each swipe costs (one pop per 10 cards, small writes
 *                  per swipe) next to the offline work that built the deck.
 *   geo-reach      (Fig. 3) predict first, then explore how far 9 geohash
 *                  cells reach around one user for a radius, precision and
 *                  city. Real geohash encoding; spherical-Earth distances.
 *   swipe-race     (Fig. 4) two right swipes at once, as the Redis calls each
 *                  request sends. The reader predicts the outcome first.
 *   chat-timeline  (Fig. 5) the first message as Arjun's phone, the backend
 *                  and Riya's phone see it, event by event, with a fault to
 *                  pick and a check-yourself question at the end.
 *
 * House look only: shared tokens and components from walviz.css and lib.js.
 * The post CSS does layout and drawing.
 *
 * Checked outside the repo: geohash strings against pygeohash; hash slots
 * against CLUSTER KEYSLOT on Valkey 9.1; the CROSSSLOT reply against a
 * one-node Valkey cluster. IDs, names, times, scores and text are samples.
 */

import { h, s, range, register, clamp, esc, uid, stepper, chips, ask, colorKey, codeBlock, REDUCED } from './lib.js';

/* ---------------------------------------------------------------- shared */

const P = 'v-tdr-';

/** A labelled row of shared chips. */
function pickRow(label, options, value, onpick) {
  const ch = chips(options, onpick, { value, label });
  const el = h('div', { class: `${P}row` }, h('span', { class: `${P}lab` }, label), ch.el);
  return { el, set: ch.set };
}

function markers(id) {
  const m = (name, colour) => s('marker', { id: `${id}-${name}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L8,4 L0,8 z', style: `fill:var(${colour})` }));
  return s('defs', null, m('ink', '--ink'), m('look', '--purple'), m('mute', '--mute'));
}

/** Re-render when the figure crosses a width breakpoint. */
function onBreak(app, bp, cb) {
  let wide = app.clientWidth >= bp;
  new ResizeObserver(() => { const w = app.clientWidth >= bp; if (w !== wide) { wide = w; cb(); } }).observe(app);
}

/** A stepper that can be rebuilt when its steps change (keys stay scoped). */
function remountStepper(host, steps, onStep, opts) {
  const box = h('div');
  const st = stepper(box, steps, onStep, opts);
  box.append(st.el);
  host.replaceChildren(box);
  st.go(0);
  return st;
}

/* ================================================================ DECK */

/*
 * The reader swipes their own deck. Each tap shows the small writes it
 * costs; every tenth card shows the one pop that refills the phone. The
 * ranking work stays offline and never runs while they swipe.
 */
const DECK_SIZE = 200;
const PAGE = 10;
function sampleDeck() {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const used = new Set(); const out = [];
  let score = 0.93;
  while (out.length < DECK_SIZE) {
    const id = `u${Math.floor(rnd() * 9000) + 100}`;
    if (used.has(id)) continue;
    used.add(id);
    score -= 0.0015 + rnd() * 0.0025;
    out.push([id, Math.max(score, 0.05)]);
  }
  return out;
}
function initDeck(fig, app) {
  const deck = sampleDeck();
  const st = { redis: deck.slice(PAGE), phone: deck.slice(0, PAGE), swiped: 0, last: null };
  const face = h('div', { class: `${P}face` });
  const count = h('p', { class: `${P}small` });
  const nope = h('button', { class: 'wv-btn', type: 'button' }, '✕ Nope');
  const like = h('button', { class: 'wv-btn', type: 'button' }, '♥ Like');
  const zset = h('tbody');
  const more = h('p', { class: `${P}small` });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  nope.addEventListener('click', () => swipe('left'));
  like.addEventListener('click', () => swipe('right'));
  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select')) return;
    if (e.key === 'ArrowLeft') { swipe('left'); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowRight') { swipe('right'); e.preventDefault(); e.stopPropagation(); }
  });

  app.append(
    h('div', { class: 'wv-cards' },
      h('div', { class: 'wv-card' },
        h('h5', null, 'Your phone'),
        h('div', { class: `${P}phone` }, face, h('div', { class: `${P}btns` }, nope, like)),
        count, h('div', { style: 'height:.5rem' }), note),
      h('div', { class: 'wv-card is-data' },
        h('h5', null, 'Your deck in Redis'),
        h('p', { class: `${P}small c-data` }, 'deck:u42 · sorted set'),
        h('table', { class: 'wv-table' }, h('thead', null, h('tr', null, h('th', null, 'member'), h('th', null, 'score'))), zset),
        more),
      h('div', { class: 'wv-card' },
        h('h5', null, 'Built offline, every 15 min'),
        h('ol', { class: `${P}list` },
          h('li', null, 'Read 9 nearby geohash cells'),
          h('li', null, 'Keep up to 500 candidates'),
          h('li', null, 'Score each pair: ', h('code', null, 'P(A→B) × P(B→A) × fairness')),
          h('li', null, 'Write the top 200 into your deck')),
        h('p', { class: `${P}small` }, 'None of this runs while you swipe.'))),
    colorKey([['k-data', 'your deck: IDs and scores (samples)'], ['k-look', 'the next pop']]),
  );

  function render() {
    const top = st.phone[0];
    face.replaceChildren(...(top
      ? [h('span', { class: `${P}avatar` }), h('b', { class: 'c-data' }, top[0]), h('span', { class: 'c-data' }, `score ${top[1].toFixed(2)}`)]
      : [h('b', null, 'Deck empty'), h('span', null, 'The next offline run refills it.')]));
    count.textContent = `${st.phone.length} of ${PAGE} cards left on the phone · ${st.swiped} swiped`;
    const soon = st.phone.length <= 3;
    zset.replaceChildren(...st.redis.slice(0, 5).map(([id, sc]) => h('tr', { class: soon ? 'is-look' : '' }, h('td', { class: 'c-data' }, id), h('td', { class: 'c-data' }, sc.toFixed(3)))));
    more.textContent = st.redis.length > 5 ? `… ${st.redis.length - 5} more · ${st.redis.length} in Redis${soon ? ' · highlighted rows are the next pop' : ''}` : `${st.redis.length} in Redis`;
    nope.disabled = !top; like.disabled = !top;
    const L = st.last;
    note.className = 'wv-note';
    if (!L) note.innerHTML = `Opening the app popped your top ${PAGE} cards: <code>ZPOPMAX deck:u42 ${PAGE}</code>. No ranking ran. Swipe with the buttons or the arrow keys.`;
    else if (L.pop) note.innerHTML = `That was your last card on the phone, so the app popped ${PAGE} more: <code>ZPOPMAX deck:u42 ${PAGE}</code>. One read for the next ${PAGE} swipes.`;
    else note.innerHTML = L.dir === 'right'
      ? `Your right swipe is two small writes: <code>SADD right:u42 ${L.id}</code> and the match check in Fig. 4. The deck did not change.`
      : `Your left swipe is one small write: <code>SADD left:u42 ${L.id}</code>. The deck did not change.`;
  }
  function swipe(dir) {
    const top = st.phone.shift();
    if (!top) return;
    st.swiped++;
    st.last = { dir, id: top[0] };
    if (!st.phone.length && st.redis.length) {
      st.phone = st.redis.slice(0, PAGE); st.redis = st.redis.slice(PAGE);
      st.last.pop = true;
    }
    face.classList.add(dir === 'left' ? 'is-left' : 'is-right');
    setTimeout(() => { face.classList.remove('is-left', 'is-right'); render(); }, REDUCED ? 0 : 180);
  }
  render();
}

/* ========================================================== ARCH PATHS */

const AN = {
  phone: [10, 60, 110, 430, 'Mobile app', 'iOS / Android'],
  cdn: [160, 10, 130, 44, 'CDN', 'photos'],
  gw: [160, 90, 130, 200, 'API gateway', '+ service mesh'],
  ws: [160, 310, 130, 50, 'WS gateways', 'one socket per phone'],
  pubsub: [160, 380, 130, 44, 'Redis Pub/Sub', ''],
  kafka: [160, 450, 130, 50, 'Kafka', 'location topic', 1],
  prof: [340, 90, 150, 50, 'Profile svc', 'CRUD, photos'],
  rec: [340, 165, 150, 50, 'Recommendation svc', ''],
  swipe: [340, 240, 150, 50, 'Swipe svc', 'match check'],
  loc: [340, 450, 150, 50, 'Location processor', ''],
  pg: [540, 90, 170, 50, 'Postgres', 'users + read replicas', 1],
  deck: [540, 165, 170, 50, 'Redis · decks', 'sorted set per user', 1],
  swipes: [540, 240, 170, 50, 'Redis · swipes', 'likes, left, right', 1],
  scylla: [540, 310, 170, 50, 'ScyllaDB', 'messages', 1],
  geo: [540, 450, 170, 50, 'Redis · geohash sets', 'active:<cell>:<bucket>', 1],
  offline: [760, 90, 190, 130, 'Offline pipeline', 'every 15 min'],
  notif: [760, 310, 170, 50, 'Notification queue', '→ APNs / FCM'],
};
const AE = {
  cdn: [[120, 78], [140, 78], [140, 32], [160, 32]],
  gw: [[120, 190], [160, 190]],
  prof: [[290, 115], [340, 115]], rec: [[290, 190], [340, 190]], swipe: [[290, 265], [340, 265]],
  pg: [[490, 115], [540, 115]], deck: [[490, 190], [540, 190]], swipes: [[490, 265], [540, 265]],
  recsw: [[490, 205], [520, 205], [520, 250], [540, 250]],
  recpg: [[490, 175], [515, 175], [515, 130], [540, 130]],
  notif: [[490, 280], [527, 280], [527, 298], [845, 298], [845, 310]],
  push: [[845, 360], [845, 524], [65, 524], [65, 490]],
  ws: [[120, 335], [160, 335]], scylla: [[290, 335], [540, 335]],
  pub: [[205, 360], [205, 380]], sub: [[245, 380], [245, 360]],
  kafka: [[120, 475], [160, 475]], loc: [[290, 475], [340, 475]], geo: [[490, 475], [540, 475]],
  geooff: [[710, 475], [735, 475], [735, 205], [760, 205]],
  pgoff: [[710, 115], [760, 115]], offdeck: [[760, 180], [710, 180]],
};
const CTL = new Set(['push']);

/* Where each edge ends, so the current hop can light its target. */
const HOPTO = {
  cdn: 'cdn', gw: 'gw', prof: 'prof', rec: 'rec', swipe: 'swipe', pg: 'pg', deck: 'deck', swipes: 'swipes', recsw: 'swipes', recpg: 'pg',
  notif: 'notif', push: 'phone', ws: 'ws', scylla: 'scylla', pub: 'pubsub', sub: 'ws', kafka: 'kafka', loc: 'loc', geo: 'geo',
  geooff: 'offline', pgoff: 'offline', offdeck: 'deck',
};

/* Rates and targets are the ones derived in the post's requirements. */
const PATHS = {
  open: {
    label: 'Open the app', rate: 'peak rate not derived in the post', target: 'recommendations P99 < 100 ms',
    hops: [
      ['gw', 'Phone → API gateway', 'GET /recs'],
      ['rec', 'Gateway → Recommendation svc', ''],
      ['deck', 'Pop the top of your deck', 'ZPOPMAX deck:u42 10'],
      ['recsw', 'Drop anyone swiped since the deck was built', 'left:u42, right:u42'],
      ['recpg', 'Fetch 10 profiles from a read replica', ''],
      ['cdn', 'Photos load from the CDN', 'target P50 < 300 ms'],
    ],
  },
  swipe: {
    label: 'Swipe right', rate: '74,000 swipes/s at peak', target: 'match notification P99 < 500 ms',
    hops: [
      ['gw', 'Phone → API gateway', 'POST /swipe {target: "u7", dir: "right"}'],
      ['swipe', 'Gateway → Swipe svc', ''],
      ['swipes', 'Save the like and count the pair (Fig. 4)', 'MULTI · SADD likes:{u42:u7} u42 · SCARD · EXEC'],
      ['notif', 'On a match, queue one notification', ''],
      ['push', 'APNs / FCM tell both phones', '"It\'s a Match!"'],
    ],
  },
  message: {
    label: 'Send a message', rate: '5,500 messages/s at peak', target: 'delivery P99 < 200 ms',
    hops: [
      ['ws', 'Phone → its WebSocket gateway', ''],
      ['scylla', 'Store the message first', 'INSERT INTO messages … \'pending\''],
      ['pub', 'Publish to the recipient\'s channel', 'PUBLISH user:riya …'],
      ['sub', 'The recipient\'s gateway writes it to their socket', ''],
      [null, 'No ACK in time: push, then the phone syncs (Fig. 5)', ''],
    ],
  },
  location: {
    label: 'Location update', rate: '75,000 updates/s at peak', target: 'location lag < 5 min',
    hops: [
      ['kafka', 'Phone → Kafka, as a buffer', '{user_id, lat, lng}'],
      ['loc', 'The processor reads a batch', ''],
      ['geo', 'Move the user to their new cell (Fig. 3)', 'SREM active:dr5rd:… u42 · SADD active:dr5re:… u42'],
      ['geooff', 'Every 15 min: read candidates from 9 cells', 'SMEMBERS active:<cell>:<bucket> ×9'],
      ['pgoff', 'Join profile fields and preferences', ''],
      ['offdeck', 'Rank and write the top 200', 'ZADD deck:u42 0.91 u7 …'],
    ],
  },
};
function initArchPaths(fig, app) {
  const id = uid('tdr');
  let path = 'swipe'; let hop = 0;
  const stage = h('div');
  const load = h('dl', { class: 'wv-kv' });
  const stepHost = h('div');
  const cap = h('div', { class: 'wv-callout', 'aria-live': 'polite' });
  const trail = h('ol', { class: `${P}list` });
  const keyHost = h('div');
  const pick = pickRow('Follow', Object.entries(PATHS).map(([k, v]) => [k, v.label]), path, (k) => { path = k; mount(); });
  app.append(pick.el, load, h('div', { style: 'height:.6rem' }), stepHost, stage, cap, trail, keyHost);

  const nodeEls = {}; const edgeEls = {}; let numG = null; let wide = false;
  function build() {
    wide = app.clientWidth >= 700;
    stage.replaceChildren();
    numG = null;
    keyHost.replaceChildren(colorKey([...(wide ? [['k-ink', 'service (dashed: data at rest)']] : []), ['k-look', 'this hop'], ['k-data', 'commands and rates'], ['k-safe', 'latency target'], ['k-opt', 'paths']]));
    if (!wide) return;
    const svg = s('svg', { viewBox: '0 0 960 534', role: 'img', 'aria-label': fig.getAttribute('aria-label') });
    svg.append(markers(id));
    for (const [eid, pts] of Object.entries(AE)) {
      const e = s('path', { d: `M${pts.map((q) => q.join(',')).join(' L')}`, class: CTL.has(eid) ? 'edge-ctl' : 'edge' });
      edgeEls[eid] = e; svg.append(e);
    }
    for (const [nid, [x, y, w, hh, tt, sub, data]] of Object.entries(AN)) {
      const g = s('g', { class: 'node' },
        s('rect', { x, y, width: w, height: hh, class: `box${data ? ' dash' : ''}` }),
        s('text', { x: x + w / 2, y: y + (hh > 60 ? 26 : hh / 2 + (sub ? -2 : 4)), class: 't-s t-b', 'text-anchor': 'middle' }, tt));
      if (sub) g.append(s('text', { x: x + w / 2, y: y + (hh > 60 ? 42 : hh / 2 + 12), class: `t-xs ${data ? 't-data' : 't-mute'}`, 'text-anchor': 'middle' }, sub));
      nodeEls[nid] = g; svg.append(g);
    }
    numG = s('g'); svg.append(numG);
    stage.append(svg);
  }
  function mid(pts) {
    let best = [pts[0], pts[1]]; let len = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d > len) { len = d; best = [pts[i - 1], pts[i]]; }
    }
    return [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2];
  }
  function show(n) {
    const p = PATHS[path];
    hop = clamp(n, 0, p.hops.length - 1);
    const done = p.hops.slice(0, hop + 1).map((x) => x[0]).filter(Boolean);
    const cur = p.hops[hop][0] || done[done.length - 1];
    const seen = new Set(['phone', ...done.map((e) => HOPTO[e])]);
    if (numG) {
      Object.entries(nodeEls).forEach(([nid, g]) => {
        g.classList.toggle('is-focus', nid === HOPTO[cur]);
        g.classList.toggle('is-dim', !seen.has(nid));
      });
      Object.entries(edgeEls).forEach(([eid, e]) => {
        const isCur = eid === cur; const isDone = done.includes(eid);
        e.classList.toggle(`${P}cur`, isCur);
        e.classList.toggle('is-dim', !isDone);
        e.setAttribute('marker-end', isDone ? `url(#${id}-${isCur ? 'look' : 'ink'})` : '');
      });
      numG.replaceChildren();
      p.hops.slice(0, hop + 1).forEach(([eid], i) => {
        if (!eid) return;
        const [x, y] = mid(AE[eid]);
        numG.append(s('g', { class: `${P}num${i === hop ? ' is-cur' : ''}` }, s('circle', { cx: x, cy: y, r: 9 }), s('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 't-xs t-b t-board' }, String(i + 1))));
      });
    }
    const [, what, code] = p.hops[hop];
    cap.innerHTML = `<b>${hop + 1} · ${esc(what)}</b>${code ? `<br><code>${esc(code)}</code>` : ''}`;
    trail.replaceChildren(...(wide ? [] : p.hops.slice(0, hop).map(([, w]) => h('li', null, w))));
  }
  function mount() {
    const p = PATHS[path];
    load.innerHTML = `<dt>Peak load</dt><dd class="c-data">${esc(p.rate)}</dd><dt>Target</dt><dd class="c-safe">${esc(p.target)}</dd>`;
    remountStepper(stepHost, p.hops.map(([eid]) => ({ label: eid ? AN[HOPTO[eid]][4] : 'push + sync' })), (i) => show(i), { interval: 2600 });
  }
  build(); mount();
  onBreak(app, 700, () => { build(); show(hop); });
}

/* ============================================================ GEO REACH */

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const KM = (6371.0088 * Math.PI) / 180; // km per degree of latitude

/** Standard geohash: the cell string and its bounds in degrees. */
function geohash(lat, lon, p) {
  const la = [-90, 90]; const lo = [-180, 180];
  let even = true; let ch = 0; let n = 0; let out = '';
  while (out.length < p) {
    const r = even ? lo : la; const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = ch * 2 + 1; r[0] = mid; } else { ch *= 2; r[1] = mid; }
    even = !even;
    if (++n === 5) { out += B32[ch]; ch = 0; n = 0; }
  }
  return { hash: out, lat: la, lon: lo };
}

const CITIES = [
  { name: 'Mumbai', lat: 19.076, lon: 72.8777 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
];

function reachModel(u, p, r) {
  const g = geohash(u.lat, u.lon, p);
  const dlat = g.lat[1] - g.lat[0]; const dlon = g.lon[1] - g.lon[0];
  const kx = KM * Math.cos((u.lat * Math.PI) / 180);
  const W = dlon * kx; const H = dlat * KM;
  const ux = (u.lon - g.lon[0]) * kx; const uy = (u.lat - g.lat[0]) * KM; // km from the cell's SW corner
  const reach = Math.min(ux + W, 2 * W - ux, uy + H, 2 * H - uy);
  const inBlock = (x, y) => x >= -W && x <= 2 * W && y >= -H && y <= 2 * H;
  const N = 140; let inC = 0; let miss = 0; let outC = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = ux - r + (2 * r * (i + 0.5)) / N; const y = uy - r + (2 * r * (j + 0.5)) / N;
      if ((x - ux) ** 2 + (y - uy) ** 2 <= r * r) { inC++; if (!inBlock(x, y)) miss++; }
      const bx = -W + (3 * W * (i + 0.5)) / N; const by = -H + (3 * H * (j + 0.5)) / N;
      if ((bx - ux) ** 2 + (by - uy) ** 2 > r * r) outC++;
    }
  }
  let cells = 0;
  for (let i = Math.floor((ux - r) / W); i <= Math.floor((ux + r) / W); i++) {
    for (let j = Math.floor((uy - r) / H); j <= Math.floor((uy + r) / H); j++) {
      const nx = clamp(ux, i * W, (i + 1) * W); const ny = clamp(uy, j * H, (j + 1) * H);
      if ((nx - ux) ** 2 + (ny - uy) ** 2 <= r * r) cells++;
    }
  }
  const names = [];
  for (const dy of [1, 0, -1]) for (const dx of [-1, 0, 1]) {
    names.push({ dx, dy, hash: geohash((g.lat[0] + g.lat[1]) / 2 + dy * dlat, (g.lon[0] + g.lon[1]) / 2 + dx * dlon, p).hash });
  }
  return { g, W, H, ux, uy, reach, missed: miss / inC, over: outC / (N * N), cells, names };
}

/** Smallest cells (highest precision) whose 3×3 block holds the circle. */
function pickPrecision(u, r) {
  for (let p = 8; p >= 1; p--) if (reachModel(u, p, r).reach >= r) return p;
  return 1;
}
const kmTxt = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
function initGeoReach(fig, app) {
  const st = { city: 1, p: 5, r: 16, u: { ...CITIES[1] } };
  const id = uid('tdr');
  const stage = h('div', { class: `${P}map` });
  const keys = h('div', { 'aria-live': 'polite' });
  const say = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  let L = null; let svg = null; let M = null; let view = null;

  const cityC = pickRow('City', CITIES.map((x, i) => [i, x.name]), st.city, (i) => { st.city = i; st.u = { ...CITIES[i] }; where.set('city'); draw(); });
  const precC = pickRow('Precision', [4, 5, 6].map((p) => [p, String(p)]), st.p, (p) => { st.p = p; draw(); });
  const rad = range('Search radius', { min: 1, max: 50, value: st.r, fmt: (v) => `${v} km${v === 16 ? ' ≈ 10 mi' : ''}`, oninput: (v) => { st.r = v; draw(); } });
  const where = pickRow('User at', [['city', 'city centre'], ['c', 'cell centre'], ['k', 'cell corner']], 'city', (v) => {
    const g = geohash(st.u.lat, st.u.lon, st.p);
    if (v === 'c') st.u = { lat: (g.lat[0] + g.lat[1]) / 2, lon: (g.lon[0] + g.lon[1]) / 2 };
    else if (v === 'k') st.u = { lat: g.lat[1] - (g.lat[1] - g.lat[0]) * 0.02, lon: g.lon[1] - (g.lon[1] - g.lon[0]) * 0.02 };
    else st.u = { ...CITIES[st.city] };
    draw();
  });
  const ctl = h('div', null, cityC.el, precC.el, rad.el, where.el);
  const hint = h('p', { class: `${P}small` }, 'Drag the purple dot, or focus the map and use the arrow keys.');

  /* Predict first: most readers expect nine cells to cover a 10-mile circle. */
  const q = ask('Before you look: a user in New York searches within 10 miles (16 km). The code reads the 9 precision-5 cells around them. How much of that circle do the 9 cells cover?',
    [['all', 'All of it'], ['half', 'About half'], ['fifth', 'About a fifth']], 'fifth',
    (v, right) => (right ? '<b>Right: about a fifth.</b> The map below shows why.' : '<b>They cover about a fifth.</b> The map below shows why.'));
  q.el.addEventListener('click', (e) => { if (e.target.closest('.wv-chip')) reveal(); });
  function reveal() { [ctl, stage, hint, keys, say].forEach((el) => { el.hidden = false; }); draw(); }
  [ctl, stage, hint, keys, say].forEach((el) => { el.hidden = true; });

  app.append(q.el, ctl,
    h('div', { class: `${P}geo` }, h('div', null, stage, hint), h('div', { class: `${P}side` }, keys, say)),
    colorKey([['k-ink', 'search circle'], ['k-data', 'geohash cells and keys'], ['k-look', 'the user'], ['k-safe', 'guaranteed reach'], ['k-gap', 'missed area'], ['k-opt', 'controls'], ['k-pick', 'precision to use']]));

  function draw() {
    L = app.clientWidth < 700 ? { W: 360, H: 330 } : { W: 440, H: 400 };
    M = reachModel(st.u, st.p, st.r);
    const { W: cw, H: ch, ux, uy } = M;
    const r = st.r;
    const x0 = Math.min(-cw, ux - r); const x1 = Math.max(2 * cw, ux + r);
    const y0 = Math.min(-ch, uy - r); const y1 = Math.max(2 * ch, uy + r);
    const pad = 0.07 * Math.max(x1 - x0, y1 - y0);
    const MH = L.H - 24;
    const sc = Math.min(L.W / (x1 - x0 + 2 * pad), MH / (y1 - y0 + 2 * pad));
    const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
    const X = (x) => L.W / 2 + (x - cx) * sc;
    const Y = (y) => MH / 2 - (y - cy) * sc;
    view = { X, Y, sc, cx, cy, MH };

    if (!svg || svg.dataset.w !== String(L.W)) {
      svg = s('svg', { viewBox: `0 0 ${L.W} ${L.H}`, role: 'img', tabindex: 0, 'data-w': L.W });
      stage.replaceChildren(svg);
      wire();
    }
    svg.setAttribute('aria-label', `3 by 3 geohash block at precision ${st.p} around a user in ${CITIES[st.city].name}, with a ${r} km search circle`);
    svg.replaceChildren(markers(id), s('clipPath', { id: `${id}-c` }, s('rect', { x: 0, y: 0, width: L.W, height: MH })));
    const g = s('g', { 'clip-path': `url(#${id}-c)` });
    svg.append(g);
    g.append(s('rect', { x: 0, y: 0, width: L.W, height: MH, style: 'fill:var(--tint)' }));
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: r * sc, style: 'fill:var(--red-l)' }));
    g.append(s('rect', { x: X(-cw), y: Y(2 * ch), width: 3 * cw * sc, height: 3 * ch * sc, style: 'fill:var(--board)' }));
    if (cw * sc >= 4 && ch * sc >= 4) {
      const grid = [];
      for (let i = Math.floor((cx - L.W / 2 / sc) / cw); i <= Math.ceil((cx + L.W / 2 / sc) / cw); i++) grid.push(`M${X(i * cw).toFixed(1)},0 V${MH}`);
      for (let j = Math.floor((cy - MH / 2 / sc) / ch); j <= Math.ceil((cy + MH / 2 / sc) / ch); j++) grid.push(`M0,${Y(j * ch).toFixed(1)} H${L.W}`);
      g.append(s('path', { d: grid.join(' '), class: 'rule' }));
    }
    const bl = [];
    for (let i = -1; i <= 2; i++) bl.push(`M${X(i * cw)},${Y(-ch)} V${Y(2 * ch)}`);
    for (let j = -1; j <= 2; j++) bl.push(`M${X(-cw)},${Y(j * ch)} H${X(2 * cw)}`);
    g.append(s('path', { d: bl.join(' '), style: 'stroke:var(--brown);stroke-width:1.4;fill:none;stroke-dasharray:5 3' }));
    g.append(s('rect', { x: X(0), y: Y(ch), width: cw * sc, height: ch * sc, style: 'fill:none;stroke:var(--brown);stroke-width:2.6' }));
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: r * sc, style: 'fill:none;stroke:var(--ink);stroke-width:1.8' }));
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: M.reach * sc, style: 'fill:none;stroke:var(--green);stroke-width:2.4;stroke-dasharray:6 4' }));
    const top = Y(uy) - r * sc;
    g.append(s('text', { x: X(ux), y: top > 18 ? top - 6 : top + 16, class: 't-s t-b halo', 'text-anchor': 'middle' }, `search radius ${r} km`));
    g.append(s('text', { x: X(ux), y: Y(uy) + M.reach * sc + 15, class: 't-xs t-b t-safe halo', 'text-anchor': 'middle' }, `9 cells reach ${kmTxt(M.reach)} km`));
    g.append(s('text', { x: X(-cw) + 2, y: Y(2 * ch) - 5, class: 't-xs t-b t-data halo' }, `one cell: ${kmTxt(cw)} × ${kmTxt(ch)} km`));
    g.append(s('g', { class: `${P}user` },
      s('circle', { cx: X(ux), cy: Y(uy), r: 14, style: 'fill:transparent' }),
      s('circle', { cx: X(ux), cy: Y(uy), r: 6.5, style: 'fill:var(--purple);stroke:var(--board);stroke-width:2.5' })));
    const nice = [0.5, 1, 2, 5, 10, 20, 50].find((v) => v * sc >= 50) || 50;
    const by = L.H - 8;
    svg.append(s('path', { d: `M4,${by - 6} V${by} H${4 + nice * sc} V${by - 6}`, class: 'rule-ink' }),
      s('text', { x: 10 + nice * sc, y: by, class: 't-xs' }, `${nice} km`),
      s('text', { x: L.W - 4, y: by, class: 't-xs', 'text-anchor': 'end' }, `${CITIES[st.city].name} · ${Math.abs(st.u.lat).toFixed(2)}°${st.u.lat >= 0 ? 'N' : 'S'}`));

    const rows = [0, 1, 2].map((rI) => h('tr', null, ...M.names.slice(rI * 3, rI * 3 + 3).map((n) => h('td', { class: n.dx === 0 && n.dy === 0 ? 'c-look' : 'c-data' }, n.hash))));
    keys.replaceChildren(h('div', { class: 'wv-card is-data' }, h('h5', null, 'The 9 keys one request reads'),
      h('table', { class: `wv-table ${P}keys` }, h('tbody', null, ...rows)), h('code', null, 'SMEMBERS active:<cell>:<bucket>')));
    const ok = M.reach >= r;
    const missPct = Math.round(M.missed * 100);
    const pk = pickPrecision(st.u, r);
    if (ok) {
      say.className = 'wv-note is-good';
      say.innerHTML = `<b>The 9 cells hold the whole circle.</b> ${Math.round(M.over * 100)}% of the block lies outside it; those users are read, then dropped by the distance filter.${st.p !== pk ? ` Precision <span class="c-pick">${pk}</span> would hold it with smaller cells.` : ''}`;
    } else {
      say.className = 'wv-note is-bad';
      say.innerHTML = `<b>${missPct}% of the search circle is outside the 9 cells.</b> Users there are never candidates. At precision ${st.p}, covering the circle takes ${M.cells.toLocaleString('en-US')} cells, one <code>SMEMBERS</code> each. Here, precision <span class="c-pick">${pk}</span> is the smallest cell whose 3×3 block holds the circle.`;
    }
  }

  function toLatLon(px, py) {
    const g = M.g; const kx = KM * Math.cos((st.u.lat * Math.PI) / 180);
    const x = view.cx + (px - L.W / 2) / view.sc; const y = view.cy - (py - view.MH / 2) / view.sc;
    return { lat: g.lat[0] + y / KM, lon: g.lon[0] + x / kx };
  }
  function wire() {
    let dragging = false;
    const pt = (e) => { const b = svg.getBoundingClientRect(); return [((e.clientX - b.left) / b.width) * L.W, ((e.clientY - b.top) / b.height) * L.H]; };
    svg.addEventListener('pointerdown', (e) => {
      const [px, py] = pt(e);
      if (Math.hypot(px - view.X(M.ux), py - view.Y(M.uy)) > 28) return;
      dragging = true; svg.setPointerCapture(e.pointerId); e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const [px, py] = pt(e);
      st.u = toLatLon(clamp(px, 4, L.W - 4), clamp(py, 4, view.MH - 4));
      where.set(''); draw();
    });
    const end = () => { dragging = false; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      const g = M.g;
      st.u = { lat: st.u.lat + d[1] * (g.lat[1] - g.lat[0]) * 0.1, lon: st.u.lon + d[0] * (g.lon[1] - g.lon[0]) * 0.1 };
      where.set(''); draw();
    });
  }
  onBreak(app, 700, () => { if (!stage.hidden) draw(); });
}

/* =========================================================== SWIPE RACE */

const RACE = {
  cw: { label: 'check, then write', atomic: false },
  wc: { label: 'write, then check', atomic: false },
  tx: { label: 'MULTI/EXEC, one node', atomic: true },
  cl: { label: 'MULTI/EXEC, cluster', atomic: true, cluster: true },
  pk: { label: 'one key per pair', atomic: true, cluster: true, pick: true },
};
const ORDERS = ['AABB', 'ABAB', 'ABBA', 'BAAB', 'BABA', 'BBAA'];
const other = (u) => (u === 'A' ? 'B' : 'A');

/** Run one strategy for one order of calls. */
function race(kind, order) {
  const sets = { 'right:A': new Set(), 'right:B': new Set(), 'likes:{A:B}': new Set() };
  const rows = []; const res = { A: null, B: null }; const step = { A: 0, B: 0 };
  const seq = RACE[kind].atomic ? order[0] + other(order[0]) : order;
  for (const u of seq) {
    const o = other(u); const k = step[u]++;
    const check = () => (sets[`right:${o}`].has(u) ? 1 : 0);
    const write = () => { const had = sets[`right:${u}`].has(o); sets[`right:${u}`].add(o); return had ? 0 : 1; };
    if (kind === 'cw' || kind === 'wc') {
      const doCheck = (kind === 'cw') === (k === 0);
      if (doCheck) { const v = check(); res[u] = v === 1; rows.push({ u, lines: [`SISMEMBER right:${o} ${u}`], reply: String(v), tone: v ? 'look' : '' }); }
      else rows.push({ u, lines: [`SADD right:${u} ${o}`], reply: String(write()) });
    } else if (kind === 'tx') {
      const a = write(); const b = check(); res[u] = b === 1;
      rows.push({ u, tx: true, lines: [`SADD right:${u} ${o}`, `SISMEMBER right:${o} ${u}`], reply: `[${a}, ${b}]`, tone: b ? 'look' : '' });
    } else if (kind === 'cl') {
      res[u] = 'err';
      rows.push({ u, tx: true, lines: [`SADD right:${u} ${o}`, `SISMEMBER right:${o} ${u}`], reply: 'CROSSSLOT', tone: 'bad' });
    } else {
      const kk = 'likes:{A:B}';
      const added = sets[kk].has(u) ? 0 : 1; sets[kk].add(u); const n = sets[kk].size;
      res[u] = added === 1 && n === 2;
      rows.push({ u, tx: true, lines: [`SADD ${kk} ${u}`, `SCARD ${kk}`], reply: `[${added}, ${n}]`, tone: n === 2 ? 'look' : '' });
    }
  }
  const matches = (res.A === true) + (res.B === true);
  const err = res.A === 'err';
  return { rows, sets, res, matches, err, outcome: err ? 'err' : matches === 1 ? 'one' : matches === 0 ? 'none' : 'two' };
}

const OUTCOME = { one: ['One match', 'good'], none: ['Missed match', 'bad'], two: ['Two matches', 'bad'], err: ['Both swipes fail', 'bad'] };

function raceText(kind, r, order) {
  if (kind === 'cw') {
    return r.outcome === 'none'
      ? 'Both checks ran before either write, so both saw <code>0</code>. A and B like each other and never match. Reading from a replica that lags the primary does the same thing, even when the write goes first.'
      : `The second check ran after the first write, so it saw <code>1</code>. This order is safe only because ${order[0]} finished both calls first.`;
  }
  if (kind === 'wc') {
    return r.outcome === 'two'
      ? 'Both writes landed before both checks, so both saw <code>1</code>. Both requests call <code>create_match</code>: two conversations and two notifications, unless <code>create_match</code> is idempotent.'
      : `${order[0]} finished both calls before ${other(order[0])} wrote, so only ${other(order[0])} saw <code>1</code>. This order is safe by luck.`;
  }
  if (kind === 'tx') return 'Redis runs each <code>MULTI</code>/<code>EXEC</code> block with nothing in between. The second block always sees the first block\'s <code>SADD</code>, so exactly one request creates the match. In redis-py, <code>pipeline()</code> sends <code>MULTI</code>/<code>EXEC</code> by default.';
  if (kind === 'cl') return 'On Redis Cluster, <code>right:A</code> is in slot 10002 and <code>right:B</code> in slot 6001. A transaction may only touch keys in one slot, so <code>EXEC</code> returns <code>CROSSSLOT</code> and neither swipe is saved.';
  return 'Both users build the same key. Redis hashes only the part inside <code>{…}</code>, so the key has one slot and the transaction works on a cluster. Only the second <code>SADD</code> sees <code>SCARD</code> = 2.';
}
function initSwipeRace(fig, app) {
  const st = { kind: 'cw', order: 'ABAB', open: false };
  const known = {};
  const orderHost = h('div');
  const stage = h('div', { class: `${P}race`, role: 'img' });
  const askHost = h('div');
  const tally = h('p');
  const kindC = pickRow('Save a swipe by', Object.entries(RACE).map(([k, v]) => [k, v.pick ? `${v.label} (our pick)` : v.label]), st.kind, (k) => {
    st.kind = k; st.open = false;
    if (RACE[k].atomic) st.order = st.order[0] === 'B' ? 'BA' : 'AB';
    else if (st.order.length < 4) st.order = st.order === 'AB' ? 'ABAB' : 'BABA';
    draw();
  });
  app.append(kindC.el, orderHost, stage, askHost, tally,
    colorKey([['k-data', 'keys and replies'], ['k-look', 'a check that saw the like'], ['k-safe', 'one match'], ['k-gap', 'missed, doubled, or failed'], ['k-opt', 'options'], ['k-pick', 'our pick (one key per pair)']]));

  function draw() {
    const atomic = RACE[st.kind].atomic;
    const list = atomic ? ['AB', 'BA'] : ORDERS;
    const oc = pickRow(atomic ? 'Which EXEC lands first' : 'Order the calls land', list.map((o) => [o, atomic ? `${o[0]} first` : o.split('').join(' ')]), st.order, (o) => { st.order = o; st.open = false; draw(); });
    if (known[st.kind]) {
      oc.el.querySelectorAll('.wv-chip').forEach((b, i) => {
        const good = race(st.kind, list[i]).outcome === 'one';
        b.prepend(h('i', { class: `${P}dot ${good ? 'is-good' : 'is-bad'}`, 'aria-hidden': 'true' }));
      });
    }
    orderHost.replaceChildren(oc.el);

    const r = race(st.kind, st.order);
    stage.setAttribute('aria-label', `Calls to Redis for ${RACE[st.kind].label}, order ${st.order}`);
    const slotTxt = st.kind === 'cl' ? 'right:A → slot 10002 · right:B → slot 6001' : st.kind === 'pk' ? 'likes:{A:B} → slot 10309' : '';
    const base = slotTxt ? 3 : 2;
    const kids = [
      h('div', { class: `${P}who` }, h('b', null, 'A’s request'), h('br'), 'swipes right on B'),
      h('div', { class: `${P}mid` }, h('span', { class: 'wv-tag' }, RACE[st.kind].cluster ? 'cluster' : 'redis')),
      h('div', { class: `${P}who` }, h('b', null, 'B’s request'), h('br'), 'swipes right on A'),
    ];
    if (slotTxt) kids.push(h('p', { class: `${P}slots c-data`, style: 'grid-row:2' }, slotTxt));
    r.rows.forEach((row, k) => {
      const isA = row.u === 'A';
      const replyCls = !st.open ? 'c-look' : row.tone === 'look' ? 'c-look' : row.tone === 'bad' ? 'c-bad' : 'c-data';
      kids.push(h('div', { class: `wv-card ${P}call ${isA ? 'is-a' : 'is-b'}${st.open && row.tone === 'bad' ? ' is-bad' : ''}`, style: `grid-row:${base + k}` },
        row.tx ? h('div', null, 'MULTI … EXEC') : null,
        ...row.lines.map((ln) => h('code', null, ln)),
        h('div', { class: `${replyCls} ${P}reply` }, st.open ? `→ ${row.reply}` : '→ ?')));
      kids.push(h('div', { class: `${P}t`, style: `grid-row:${base + k}` }, `t${k + 1}`));
    });
    if (st.open) {
      ['A', 'B'].forEach((u) => {
        const v = r.res[u];
        const [t, tone] = v === 'err' ? ['Error', 'bad'] : v ? ['It’s a Match!', r.matches === 2 ? 'bad' : 'good'] : ['No match', r.outcome === 'none' ? 'bad' : ''];
        kids.push(h('div', { class: `wv-card ${P}end is-${u.toLowerCase()}${tone ? ` is-${tone}` : ''}`, style: `grid-row:${base + r.rows.length}` }, h('b', null, t)));
      });
      const keysShown = st.kind === 'pk' ? ['likes:{A:B}'] : ['right:A', 'right:B'];
      kids.push(h('div', { class: `wv-card ${P}state ${r.err ? 'is-bad' : st.kind === 'pk' ? 'is-pick' : 'is-data'}`, style: `grid-row:${base + r.rows.length + 1}` },
        h('code', null, r.err ? 'nothing saved' : keysShown.map((k) => `${k} = {${[...r.sets[k]].sort().join(', ')}}`).join('   '))));
    }
    stage.replaceChildren(...kids);

    const GUESS = [['none', 'No match'], ['one', 'One match'], ['two', 'Two matches'], ['err', 'An error']];
    const a = ask('Work it out from the calls. What do A and B end up with?', GUESS, r.outcome, (v, right) => {
      const [title] = OUTCOME[r.outcome];
      return `${right ? '<b>You got it.</b> ' : ''}<b>${title}.</b> ${raceText(st.kind, r, st.order)}`;
    });
    a.el.addEventListener('click', (e) => { if (e.target.closest('.wv-chip') && !st.open) { st.open = true; known[st.kind] = true; const keep = a.el; draw(); askHost.replaceChildren(keep); } });
    if (!st.open) askHost.replaceChildren(a.el);
    const counts = {};
    list.forEach((o) => { const k = race(st.kind, o).outcome; counts[k] = (counts[k] || 0) + 1; });
    tally.hidden = !st.open;
    tally.innerHTML = `<b>${list.length === 2 ? 'Both orders' : `All ${list.length} orders`}:</b> ${Object.entries(counts).map(([k, n]) => `<span class="${OUTCOME[k][1] === 'good' ? 'c-safe' : 'c-bad'}">${n} × ${OUTCOME[k][0].toLowerCase()}</span>`).join(', ')}.`;
  }
  draw();
}

/* ========================================================= CHAT TIMELINE */

const MSG = {
  conv: 'c7e24a1b…',
  id: '63329300-09b7-11f1-8de9-0242ac120002', // version-1 UUID, 2026-02-14 15:11:07.312 UTC
  text: 'Hi Riya! Coffee on Sunday?',
  matched: '2026-02-14 15:09:52+0000',
};
const SID = '63329300-…';

const NET = {
  ok: ['connected · gateway B', ''],
  restart: ['gateway B is restarting', 'bad'],
  dead: ['left Wi-Fi · old socket is dead', 'bad'],
  off: ['phone is off', 'bad'],
  back: ['online · new socket', ''],
};

/** Events for one fault. Each carries the state of both phones after it. */
function chatEvents(fault) {
  const E = [];
  const riyaNet = fault === 'restart' ? 'restart' : fault === 'offline' ? 'off' : 'ok';
  E.push({ t: '0 ms', who: 'Arjun’s phone', what: 'sends the message', short: '{"type":"msg", …}', code: `{"type": "msg", "conversation_id": "${MSG.conv}",\n "text": "${MSG.text}"}`,
    say: 'Gateway A makes the <code>message_id</code>: a version-1 UUID, because a <code>timeuuid</code> column accepts no other version.',
    a: 'sending', rn: riyaNet, rv: 'empty' });
  E.push({ t: '3 ms', who: 'gateway A', what: 'stores the row first', tone: 'safe',
    short: "INSERT INTO messages … 'pending'",
    code: `INSERT INTO messages (conversation_id, message_id, sender_id, content, status)\nVALUES (${MSG.conv}, ${MSG.id},\n        arjun, '${MSG.text}', 'pending');`,
    say: 'The message is <b class="c-safe">durable</b> in ScyllaDB. Only now does gateway A tell Arjun’s phone “sent”. Every later step may fail, because every later step can be redone from this row.',
    a: 'sent', rn: riyaNet, rv: 'empty' });
  const dropped = fault === 'restart' || fault === 'offline';
  E.push({ t: '4 ms', who: 'gateway A', what: dropped ? 'publishes; nobody is listening' : 'publishes to Riya’s channel', tone: dropped ? 'lost' : '',
    code: `PUBLISH user:riya '{"id":"${SID}", …}'  →  (integer) ${dropped ? 0 : 1}`,
    say: !dropped
      ? 'Redis hands the message to every subscriber connected <b>now</b> and keeps no copy.'
      : fault === 'restart'
        ? '<b class="c-bad">Gateway B is restarting for a deploy.</b> Nobody subscribes to <code>user:riya</code>, so Redis drops the message: Pub/Sub delivers at most once. The count cannot prove delivery either, because in Redis Cluster it covers only clients on the same node.'
        : '<b class="c-bad">Riya’s phone is off.</b> No gateway holds a socket for her, so nobody subscribes to <code>user:riya</code> and Redis drops the message.',
    a: 'sent', rn: riyaNet, rv: 'empty' });
  if (!fault) {
    E.push({ t: '5 ms', who: 'gateway B', what: 'writes the frame to Riya’s socket', code: 'conn.write(frame)',
      say: 'Riya’s phone stores the message under its <code>message_id</code> and shows it.', a: 'sent', rn: 'ok', rv: 'msg' });
    E.push({ t: '70 ms', who: 'Riya’s phone', what: 'ACKs; the row becomes delivered', tone: 'safe',
      short: "ACK → status = 'delivered'",
      code: `{"type": "ack", "id": "${SID}"}\nUPDATE messages SET status = 'delivered' WHERE …`,
      say: 'Only the phone’s ACK marks the row <b class="c-safe">delivered</b>. Arjun sees two ticks. (70 ms is a sample round trip.)', a: 'delivered', rn: 'ok', rv: 'msg' });
    return E;
  }
  if (fault === 'switch') {
    E.push({ t: '5 ms', who: 'gateway B', what: 'write() returns OK to a dead socket', tone: 'lost',
      code: 'conn.write(frame)   # OK: the bytes are in the kernel send buffer',
      say: '<b class="c-bad">Riya walked out of the café and her phone moved to mobile data.</b> Gateway B does not know yet. A successful write means only that the kernel took the bytes; Linux retransmits for 13 to 30 minutes before it reports the connection dead. So a successful write never means “delivered”.',
      a: 'sent', rn: 'dead', rv: 'empty' });
  }
  const netWait = fault === 'switch' ? 'dead' : riyaNet;
  E.push({ t: '5 s', who: 'gateway A', what: 'no ACK in time: queues a push',
    short: 'push_queue.publish({"user_id": "riya", …})',
    code: `push_queue.publish({"user_id": "riya", "type": "new_message",\n                    "preview": "${MSG.text}"})`,
    say: 'The row is still <code>pending</code>. Gateway A does not know why the ACK is missing, and it does not need to. It asks the phone to come and fetch. (5 s is a sample timeout.)',
    a: 'sent', rn: netWait, rv: 'empty' });
  E.push({ t: fault === 'offline' ? '5 s' : '5.3 s', who: 'APNs / FCM', what: fault === 'offline' ? 'holds the push for an offline phone' : 'shows a notification',
    code: `"Arjun: ${MSG.text}"`,
    say: fault === 'offline'
      ? 'The push service may hold the notification, deliver it late, or drop it. Nothing depends on it: the message is in ScyllaDB.'
      : 'A push is a hint to open the app. The message itself still comes from the store.',
    a: 'sent', rn: fault === 'offline' ? 'off' : 'back', rv: fault === 'offline' ? 'empty' : 'banner' });
  E.push({ t: fault === 'offline' ? '2 days' : '9 s', who: 'Riya’s phone', what: fault === 'offline' ? 'turns on, opens the app, syncs' : 'opens the app and syncs',
    short: 'SELECT … message_id > minTimeuuid(…) → 1 row',
    code: `SELECT message_id, sender_id, content FROM messages\n WHERE conversation_id = ${MSG.conv}\n   AND message_id > minTimeuuid('${MSG.matched}');\n-- 1 row`,
    say: 'On every (re)connect, the phone asks for messages newer than the newest one it has; for a new match, that is the match time. It stores messages by <code>message_id</code>, so if a live copy also arrives, the message still shows once.',
    a: 'sent', rn: 'back', rv: 'msg' });
  E.push({ t: fault === 'offline' ? '2 days' : '9.1 s', who: 'Riya’s phone', what: 'ACKs; the row becomes delivered', tone: 'safe',
    short: "ACK → status = 'delivered'",
    code: `{"type": "ack", "id": "${SID}"}\nUPDATE messages SET status = 'delivered' WHERE …`,
    say: 'Same ending as with no fault. The live path lost the message; <b class="c-safe">the stored row and the sync query brought it back.</b>',
    a: 'delivered', rn: 'back', rv: 'msg' });
  return E;
}

const FAULTS = [['', 'no fault'], ['restart', 'gateway B restarts'], ['switch', 'Wi-Fi → mobile data'], ['offline', 'phone off for days']];
function initChatTimeline(fig, app) {
  let fault = ''; let ev = chatEvents(fault);
  const phoneA = h('div', { class: `wv-card ${P}ph is-a` });
  const phoneB = h('div', { class: `wv-card ${P}ph is-b` });
  const log = h('ol', { class: `${P}events` });
  const now = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const askHost = h('div');
  const stepHost = h('div');
  const faultC = pickRow('Fault', FAULTS, fault, (f) => { fault = f; ev = chatEvents(f); mount(); });

  app.append(faultC.el, stepHost,
    h('div', { class: `${P}chat` }, phoneA, h('div', { class: `${P}log` }, log), phoneB),
    now, askHost,
    colorKey([['k-look', 'this event'], ['k-data', 'the message and commands'], ['k-safe', 'durable or delivered'], ['k-gap', 'where the live path loses it'], ['k-opt', 'faults to try']]));

  function phone(el, name, net, body) {
    const [nt, tone] = NET[net] || ['', ''];
    el.replaceChildren(...[h('h5', null, name), nt ? h('p', { class: `${P}small${tone ? ' c-bad' : ''}` }, nt) : null, h('div', { class: `${P}body` }, ...body)].filter(Boolean));
  }
  function show(i) {
    const e = ev[i];
    const status = { sending: 'sending…', sent: '✓ sent', delivered: '✓✓ delivered' }[e.a];
    phone(phoneA, 'Arjun', null, [h('div', { class: 'wv-card is-data' }, h('span', { class: 'c-data' }, MSG.text), h('br'), h('span', { class: e.a === 'delivered' ? 'c-safe' : '' }, status))]);
    const lost = ev.slice(0, i + 1).some((x) => x.tone === 'lost');
    const rb = e.rv === 'msg' ? [h('div', { class: 'wv-card is-data' }, h('span', { class: 'c-data' }, MSG.text))]
      : e.rv === 'banner' ? [h('div', { class: 'wv-card' }, h('b', null, 'Notification'), h('br'), `Arjun: ${MSG.text}`), h('p', { class: `${P}small` }, 'app closed')]
        : [h('p', { class: lost ? 'c-bad' : '' }, lost ? 'nothing arrived' : 'waiting…')];
    phone(phoneB, 'Riya', e.rn, rb);
    log.replaceChildren(...ev.slice(0, i + 1).map((x, k) => h('li', { class: k === i ? 'wv-card is-look' : '' },
      h('b', null, x.t), h('span', null, h('b', { class: x.tone === 'lost' ? 'c-bad' : x.tone === 'safe' ? 'c-safe' : '' }, x.who), ` ${x.what}`, h('br'), h('code', null, x.short || x.code)))));
    now.className = `wv-note${e.tone === 'lost' ? ' is-bad' : e.tone === 'safe' ? ' is-good' : ''}`;
    now.innerHTML = `<p>${e.say}</p>${codeBlock(e.code.split('\n'))}`;
    askHost.replaceChildren();
    if (fault && i === ev.length - 1) {
      askHost.append(ask('Check yourself: what brought the message back?',
        [['ps', 'Redis Pub/Sub'], ['push', 'The push notification'], ['row', 'The stored row and the sync query']], 'row',
        (v) => (v === 'row'
          ? '<b>Right.</b> ScyllaDB owns the guarantee. Pub/Sub keeps no copy, and the push only wakes the app.'
          : v === 'ps' ? '<b>Not Pub/Sub.</b> It delivers at most once and kept no copy; this is where the message was lost.'
            : '<b>Not the push.</b> It only wakes the app. The message came from the row, through the sync query.')).el);
    }
  }
  function mount() {
    remountStepper(stepHost, ev.map((x) => ({ label: x.t })), (i) => show(i), { interval: 3200 });
  }
  mount();
}

register({
  'deck-hero': initDeck,
  'arch-paths': initArchPaths,
  'geo-reach': initGeoReach,
  'swipe-race': initSwipeRace,
  'chat-timeline': initChatTimeline,
});

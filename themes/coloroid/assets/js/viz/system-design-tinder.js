/*
 * system-design-tinder — figures for "System Design - Tinder".
 *
 *   deck-hero      the reader swipes their own precomputed deck and sees
 *                  what each swipe costs (one write, one pop per 10 cards)
 *                  next to the offline work that built the deck.
 *   arch-paths     the architecture, one path at a time, hop by hop at the
 *                  reader's pace, with the post's peak rate and target.
 *   geo-reach      predict first, then explore: how far 9 geohash cells
 *                  reach around one user for a radius, precision and city.
 *                  Real geohash encoding; distances on a spherical Earth.
 *   swipe-race     two right swipes at once, as chat bubbles of Redis calls.
 *                  The reader predicts the outcome before the replies show.
 *   chat-timeline  the first message as Arjun's phone, the backend and
 *                  Riya's phone see it, event by event, with a fault to
 *                  pick and a check-yourself question at the end.
 *
 * Checked outside the repo: geohash strings against pygeohash; hash slots
 * against CLUSTER KEYSLOT on Valkey 9.1; the CROSSSLOT reply against a
 * one-node Valkey cluster. IDs, names, times, scores and text are samples.
 * Figures use frame="none"; the look is in css/viz/system-design-tinder.css.
 */

import { h, s, range, register, clamp, esc, uid } from './lib.js';

/* ---------------------------------------------------------------- shared */

const P = 'v-tdr-';
/** 'xs b data' → 'v-tdr-xs v-tdr-b v-tdr-data' */
const c = (names) => names.split(' ').filter(Boolean).map((n) => P + n).join(' ');

/** Row of blue option chips. options: [[value, label, extraClass?]]. */
function chips(label, options, value, onpick) {
  const btns = options.map(([v, text, extra]) => {
    const b = h('button', { class: `${P}chip${extra ? ` ${extra}` : ''}`, type: 'button', 'aria-pressed': String(v === value) }, text);
    b.dataset.v = String(v);
    b.addEventListener('click', () => { set(v); onpick(v); });
    return b;
  });
  function set(v) { btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v)))); }
  const el = h('div', { class: c('row') }, label ? h('span', { class: c('lab') }, label) : null,
    h('div', { class: c('chips'), role: 'group', 'aria-label': label || 'Options' }, ...btns));
  return { el, set };
}

function key(items) {
  return h('div', { class: c('key') }, ...items.map(([k, label]) => h('span', null, h('i', { class: k }), label)));
}

function markers(id) {
  const m = (name, colour) => s('marker', { id: `${id}-${name}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L8,4 L0,8 z', style: `fill:var(${colour})` }));
  return s('defs', null, m('ink', '--ink'), m('look', '--purple'), m('mute', '--mute'));
}

/** Re-render when the figure crosses a width breakpoint. */
function onBreak(app, bp, cb) {
  let wide = app.clientWidth >= bp;
  new ResizeObserver(() => { const w = app.clientWidth >= bp; if (w !== wide) { wide = w; cb(); } }).observe(app);
}

/* ================================================================= HERO */

/*
 * The reader swipes their own deck. Each tap shows the one write it costs;
 * every tenth card shows the one pop that refills the phone. The ranking
 * work stays on the offline side and never runs while they swipe.
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

function initDeckHero(fig, app) {
  const deck = sampleDeck();
  const st = { redis: deck.slice(PAGE), phone: deck.slice(0, PAGE), swiped: 0, last: null };
  const card = h('div', { class: c('hcard') });
  const onPhone = h('div', { class: c('hsub') });
  const nope = h('button', { class: `${P}hbtn is-no`, type: 'button', 'aria-label': 'Swipe left' }, '✕');
  const like = h('button', { class: `${P}hbtn is-yes`, type: 'button', 'aria-label': 'Swipe right' }, '♥');
  const list = h('ol', { class: c('zset') });
  const more = h('div', { class: c('hsub') });
  const cmd = h('div', { class: c('hcmd'), 'aria-live': 'polite' });
  nope.addEventListener('click', () => swipe('left'));
  like.addEventListener('click', () => swipe('right'));
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { swipe('left'); e.preventDefault(); }
    if (e.key === 'ArrowRight') { swipe('right'); e.preventDefault(); }
  });

  app.append(
    h('div', { class: c('hero') },
      h('section', { class: c('hzone is-phone') },
        h('h5', null, 'Your phone'),
        h('div', { class: c('hphone') }, card, h('div', { class: c('hbtns') }, nope, like)),
        onPhone, cmd),
      h('section', { class: c('hzone is-deck') },
        h('h5', null, 'Your deck in Redis'),
        h('div', { class: c('hkey') }, 'deck:u42 · sorted set'),
        list, more),
      h('section', { class: c('hzone is-off') },
        h('h5', null, 'Built offline, every 15 min'),
        h('ol', { class: c('hsteps') },
          h('li', null, 'Read 9 nearby geohash cells'),
          h('li', null, 'Keep up to 500 candidates'),
          h('li', null, 'Score each pair: ', h('span', { class: c('hmono') }, 'P(A→B) × P(B→A) × fairness')),
          h('li', null, 'Write the top 200 into your deck')),
        h('div', { class: c('hsub') }, 'None of this runs while you swipe.'))),
    key([['data', 'your deck: IDs and scores (samples)'], ['look', 'the next pop'], ['opt', 'your swipe']]),
  );

  function render() {
    const top = st.phone[0];
    if (top) {
      card.replaceChildren(h('div', { class: c('hface') }), h('b', null, top[0]), h('span', null, `score ${top[1].toFixed(2)}`));
      card.classList.remove('is-gone');
    }
    onPhone.textContent = `${st.phone.length} of ${PAGE} cards left on the phone · ${st.swiped} swiped`;
    list.replaceChildren(...st.redis.slice(0, 5).map(([id, sc], k) => h('li', { class: k < PAGE && st.phone.length <= 3 ? 'is-next' : '' }, h('span', null, id), h('span', null, sc.toFixed(3)))));
    more.textContent = st.redis.length > 5 ? `… ${st.redis.length - 5} more · ${st.redis.length} in Redis` : `${st.redis.length} in Redis`;
    const done = !st.phone.length;
    nope.disabled = done; like.disabled = done;
    if (done) card.replaceChildren(h('b', null, 'Deck empty'), h('span', null, 'The next offline run refills it.'));
    const L = st.last;
    if (!L) cmd.innerHTML = `Opening the app popped your top ${PAGE} cards: <code>ZPOPMAX deck:u42 ${PAGE}</code>. No ranking ran. Swipe with the buttons or the arrow keys.`;
    else if (L.pop) cmd.innerHTML = `That was your last card on the phone, so the app popped ${PAGE} more: <code>ZPOPMAX deck:u42 ${PAGE}</code>. One read for the next ${PAGE} swipes.`;
    else cmd.innerHTML = L.dir === 'right'
      ? `Your right swipe is two small writes: <code>SADD right:u42 ${L.id}</code> and the match check in Fig. 3. The deck did not change.`
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
    card.classList.add(dir === 'left' ? 'is-left' : 'is-right');
    setTimeout(() => { card.classList.remove('is-left', 'is-right'); render(); }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
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
      ['swipes', 'Save the like and count the pair (Fig. 3)', 'MULTI · SADD likes:{u42:u7} u42 · SCARD · EXEC'],
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
      [null, 'No ACK in time: push, then the phone syncs (Fig. 4)', ''],
    ],
  },
  location: {
    label: 'Location update', rate: '75,000 updates/s at peak', target: 'location lag < 5 min',
    hops: [
      ['kafka', 'Phone → Kafka, as a buffer', '{user_id, lat, lng}'],
      ['loc', 'The processor reads a batch', ''],
      ['geo', 'Move the user to their new cell (Fig. 2)', 'SREM active:dr5rd:… u42 · SADD active:dr5re:… u42'],
      ['geooff', 'Every 15 min: read candidates from 9 cells', 'SMEMBERS active:<cell>:<bucket> ×9'],
      ['pgoff', 'Join profile fields and preferences', ''],
      ['offdeck', 'Rank and write the top 200', 'ZADD deck:u42 0.91 u7 …'],
    ],
  },
};

function initArchPaths(fig, app) {
  const id = uid('tdr');
  let path = 'swipe'; let hop = 0;
  const stage = h('div', { class: c('arch') });
  const load = h('div', { class: c('load') });
  const cap = h('div', { class: c('hop'), 'aria-live': 'polite' });
  const trail = h('ol', { class: c('trail') });
  const back = h('button', { class: c('chip'), type: 'button', 'aria-label': 'Previous hop' }, '◀');
  const next = h('button', { class: c('chip'), type: 'button', 'aria-label': 'Next hop' }, 'Next hop ▶');
  back.addEventListener('click', () => go(hop - 1));
  next.addEventListener('click', () => go(hop + 1));
  const pick = chips('Follow', Object.entries(PATHS).map(([k, v]) => [k, v.label]), path, (k) => { path = k; go(0); });
  const keyHost = h('div');
  app.append(h('div', { class: c('ctl') }, pick.el), load, stage, h('div', { class: c('hoprow') }, back, cap, next), trail, keyHost);
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { go(hop + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(hop - 1); e.preventDefault(); }
  });

  const nodeEls = {}; const edgeEls = {}; let numG = null; let wide = false;
  function build() {
    wide = app.clientWidth >= 700;
    stage.replaceChildren();
    numG = null;
    keyHost.replaceChildren(key([...(wide ? [['ink', 'service'], ['dash', 'data at rest']] : []), ['look', 'this hop'], ['data', 'commands and rates'], ['safe', 'latency target'], ['opt', 'paths']]));
    if (!wide) return;
    const svg = s('svg', { viewBox: '0 0 960 534', role: 'img', 'aria-label': fig.getAttribute('aria-label') });
    svg.append(markers(id));
    for (const [eid, pts] of Object.entries(AE)) {
      const e = s('path', { d: `M${pts.map((q) => q.join(',')).join(' L')}`, class: `${P}edge${CTL.has(eid) ? ' is-ctl' : ''}` });
      edgeEls[eid] = e; svg.append(e);
    }
    for (const [nid, [x, y, w, hh, tt, sub, data]] of Object.entries(AN)) {
      const g = s('g', { class: `${P}node${data ? ' is-data' : ''}` },
        s('rect', { x, y, width: w, height: hh, rx: 10 }),
        s('text', { x: x + w / 2, y: y + (hh > 60 ? 26 : hh / 2 + (sub ? -2 : 4)), class: c('s b'), 'text-anchor': 'middle' }, tt));
      if (sub) g.append(s('text', { x: x + w / 2, y: y + (hh > 60 ? 42 : hh / 2 + 12), class: c(`xs ${data ? 'data mono' : 'mute'}`), 'text-anchor': 'middle' }, sub));
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
  function go(n) {
    const p = PATHS[path];
    hop = clamp(n, 0, p.hops.length - 1);
    const done = p.hops.slice(0, hop + 1).map((x) => x[0]).filter(Boolean);
    const cur = p.hops[hop][0] || done[done.length - 1];
    const seen = new Set(['phone', ...done.map((e) => HOPTO[e])]);
    if (numG) {
      Object.entries(nodeEls).forEach(([nid, g]) => {
        g.classList.toggle('is-on', nid === HOPTO[cur]);
        g.classList.toggle('is-off', !seen.has(nid));
      });
      Object.entries(edgeEls).forEach(([eid, e]) => {
        const isCur = eid === cur; const isDone = done.includes(eid);
        e.classList.toggle('is-on', isCur); e.classList.toggle('is-done', isDone && !isCur); e.classList.toggle('is-off', !isDone);
        e.setAttribute('marker-end', isDone ? `url(#${id}-${isCur ? 'look' : 'ink'})` : '');
      });
      numG.replaceChildren();
      p.hops.slice(0, hop + 1).forEach(([eid], i) => {
        if (!eid) return;
        const [x, y] = mid(AE[eid]);
        numG.append(s('g', { class: `${P}hopnum${i === hop ? ' is-cur' : ''}` }, s('circle', { cx: x, cy: y, r: 9 }), s('text', { x, y: y + 3.5, 'text-anchor': 'middle' }, String(i + 1))));
      });
    }
    load.innerHTML = `<span class="r">${esc(p.rate)}</span><span class="a">→</span><span class="g">${esc(p.target)}</span>`;
    const [, what, code] = p.hops[hop];
    cap.innerHTML = `<span class="n">${hop + 1} / ${p.hops.length}</span><b>${esc(what)}</b>${code ? `<code>${esc(code)}</code>` : ''}`;
    trail.replaceChildren(...(wide ? [] : p.hops.slice(0, hop).map(([, w]) => h('li', null, w))));
    back.disabled = hop === 0; next.disabled = hop === p.hops.length - 1;
  }
  build(); go(0);
  onBreak(app, 700, () => { build(); go(hop); });
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
  const stage = h('div', { class: c('map') });
  const quiz = h('div', { class: c('quiz') });
  const ctl = h('div', { class: c('ctl') });
  const keys = h('div', { class: c('keys'), 'aria-live': 'polite' });
  const say = h('div', { class: c('say'), 'aria-live': 'polite' });
  let L = null; let svg = null; let M = null; let view = null;

  const cityC = chips('City', CITIES.map((x, i) => [i, x.name]), st.city, (i) => { st.city = i; st.u = { ...CITIES[i] }; where.set('city'); draw(); });
  const precC = chips('Precision', [4, 5, 6].map((p) => [p, String(p)]), st.p, (p) => { st.p = p; draw(); });
  const rad = range('Search radius', { min: 1, max: 50, value: st.r, fmt: (v) => `${v} km${v === 16 ? ' ≈ 10 mi' : ''}`, oninput: (v) => { st.r = v; draw(); } });
  const where = chips('User at', [['city', 'city centre'], ['c', 'cell centre'], ['k', 'cell corner']], 'city', (v) => {
    const g = geohash(st.u.lat, st.u.lon, st.p);
    if (v === 'c') st.u = { lat: (g.lat[0] + g.lat[1]) / 2, lon: (g.lon[0] + g.lon[1]) / 2 };
    else if (v === 'k') st.u = { lat: g.lat[1] - (g.lat[1] - g.lat[0]) * 0.02, lon: g.lon[1] - (g.lon[1] - g.lon[0]) * 0.02 };
    else st.u = { ...CITIES[st.city] };
    draw();
  });

  ctl.append(cityC.el, precC.el, h('div', { class: c('row') }, h('div', { class: c('range') }, rad.el)), where.el);
  const hint = h('p', { class: c('hint') }, 'Drag the purple dot, or focus the map and use the arrow keys.');
  app.append(
    ctl,
    h('div', { class: c('geo-wrap') },
      h('div', null, quiz, stage, hint),
      h('div', { class: c('side') }, keys, say)),
    key([['ink', 'search circle'], ['data', 'geohash cells and keys'], ['look', 'the user'], ['safe', 'guaranteed reach'], ['bad', 'missed area'], ['opt', 'controls'], ['pick', 'precision to use']]),
  );

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
    svg.replaceChildren();
    svg.append(markers(id));
    const g = s('g');
    svg.append(g);
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: r * sc, style: 'fill:var(--red-l)' }));
    g.append(s('rect', { x: X(-cw), y: Y(2 * ch), width: 3 * cw * sc, height: 3 * ch * sc, style: 'fill:var(--card)' }));
    if (cw * sc >= 4 && ch * sc >= 4) {
      const grid = [];
      for (let i = Math.floor((cx - L.W / 2 / sc) / cw); i <= Math.ceil((cx + L.W / 2 / sc) / cw); i++) grid.push(`M${X(i * cw).toFixed(1)},0 V${MH}`);
      for (let j = Math.floor((cy - MH / 2 / sc) / ch); j <= Math.ceil((cy + MH / 2 / sc) / ch); j++) grid.push(`M0,${Y(j * ch).toFixed(1)} H${L.W}`);
      g.append(s('path', { d: grid.join(' '), style: 'stroke:var(--line);stroke-width:1;fill:none' }));
    }
    const bl = [];
    for (let i = -1; i <= 2; i++) bl.push(`M${X(i * cw)},${Y(-ch)} V${Y(2 * ch)}`);
    for (let j = -1; j <= 2; j++) bl.push(`M${X(-cw)},${Y(j * ch)} H${X(2 * cw)}`);
    g.append(s('path', { d: bl.join(' '), style: 'stroke:var(--brown);stroke-width:1.4;fill:none;stroke-dasharray:5 3' }));
    g.append(s('rect', { x: X(0), y: Y(ch), width: cw * sc, height: ch * sc, style: 'fill:none;stroke:var(--brown);stroke-width:2.6' }));
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: r * sc, style: 'fill:none;stroke:var(--ink);stroke-width:1.8' }));
    g.append(s('circle', { cx: X(ux), cy: Y(uy), r: M.reach * sc, style: 'fill:none;stroke:var(--green);stroke-width:2.4;stroke-dasharray:6 4' }));
    const top = Y(uy) - r * sc;
    g.append(s('text', { x: X(ux), y: top > 18 ? top - 6 : top + 16, class: c('s b halo'), 'text-anchor': 'middle' }, `search radius ${r} km`));
    g.append(s('text', { x: X(ux), y: Y(uy) + M.reach * sc + 15, class: c('xs b safe halo'), 'text-anchor': 'middle' }, `9 cells reach ${kmTxt(M.reach)} km`));
    g.append(s('text', { x: X(-cw) + 2, y: Y(2 * ch) - 5, class: c('xs b data halo') }, `one cell: ${kmTxt(cw)} × ${kmTxt(ch)} km`));
    g.append(s('g', { class: c('user') },
      s('circle', { cx: X(ux), cy: Y(uy), r: 14, style: 'fill:transparent' }),
      s('circle', { cx: X(ux), cy: Y(uy), r: 6.5, style: 'fill:var(--purple);stroke:var(--card);stroke-width:2.5' })));
    const nice = [0.5, 1, 2, 5, 10, 20, 50].find((v) => v * sc >= 50) || 50;
    const by = L.H - 8;
    svg.append(s('rect', { x: 0, y: MH, width: L.W, height: L.H - MH, style: 'fill:var(--card)' }),
      s('path', { d: `M8,${by - 6} V${by} H${8 + nice * sc} V${by - 6}`, style: 'stroke:var(--ink);stroke-width:1.3;fill:none' }),
      s('text', { x: 14 + nice * sc, y: by, class: c('xs') }, `${nice} km`),
      s('text', { x: L.W - 6, y: by, class: c('xs mute'), 'text-anchor': 'end' }, `${CITIES[st.city].name} · ${Math.abs(st.u.lat).toFixed(2)}°${st.u.lat >= 0 ? 'N' : 'S'}`));

    const ok = M.reach >= r;
    const missPct = Math.round(M.missed * 100);
    keys.innerHTML = `<div class="k">The 9 keys one request reads</div><div class="g">${M.names.map((n) => `<span class="${n.dx === 0 && n.dy === 0 ? 'is-me' : ''}">${n.hash}</span>`).join('')}</div><div class="m">SMEMBERS active:&lt;cell&gt;:&lt;bucket&gt;</div>`;
    const pk = pickPrecision(st.u, r);
    if (ok) {
      say.className = `${P}say is-good`;
      say.innerHTML = `<b>The 9 cells hold the whole circle.</b> ${Math.round(M.over * 100)}% of the block lies outside it; those users are read, then dropped by the distance filter.${st.p !== pk ? ` Precision <span class="pk">${pk}</span> would hold it with smaller cells.` : ''}`;
    } else {
      say.className = `${P}say is-bad`;
      say.innerHTML = `${guess ? `${guess} ` : ''}<b>${missPct}% of the search circle is outside the 9 cells.</b> Users there are never candidates. At precision ${st.p}, covering the circle takes ${M.cells.toLocaleString('en-US')} cells, one <code>SMEMBERS</code> each. Here, precision <span class="pk">${pk}</span> is the smallest cell whose 3×3 block holds the circle.`;
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
      e.preventDefault();
      const g = M.g;
      st.u = { lat: st.u.lat + d[1] * (g.lat[1] - g.lat[0]) * 0.1, lon: st.u.lon + d[0] * (g.lon[1] - g.lon[0]) * 0.1 };
      where.set(''); draw();
    });
  }
  /* Predict first: most readers expect nine cells to cover a 10-mile circle. */
  let guess = '';
  const opts = [['all', 'All of it'], ['half', 'About half'], ['fifth', 'About a fifth']];
  const qb = opts.map(([v, label]) => {
    const b = h('button', { class: c('chip'), type: 'button' }, label);
    b.addEventListener('click', () => {
      guess = v === 'fifth' ? '<span class="ok">Right: about a fifth.</span>' : `<span class="no">You guessed “${label.toLowerCase()}”. They cover about a fifth.</span>`;
      reveal();
      draw();
      guess = '';
    });
    return b;
  });
  quiz.append(h('p', { class: 'q' }, 'Before you look: a user in New York searches within 10 miles (16 km). The code reads the 9 precision-5 cells around them. How much of that circle do the 9 cells cover?'), h('div', { class: c('chips') }, ...qb));
  function reveal() { quiz.hidden = true; stage.hidden = false; hint.hidden = false; ctl.hidden = false; say.hidden = false; keys.hidden = false; }
  stage.hidden = true; hint.hidden = true; ctl.hidden = true; say.hidden = true; keys.hidden = true;
  draw();
  onBreak(app, 700, draw);
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
  const st = { kind: 'cw', order: 'ABAB', open: false, guess: null };
  const known = {};
  const stage = h('div', { class: c('race'), role: 'img' });
  const say = h('div', { class: c('say'), 'aria-live': 'polite' });
  const orderRow = h('div', { class: c('row') });
  const tally = h('p', { class: c('tally') });
  const kindC = chips('Save a swipe by', Object.entries(RACE).map(([k, v]) => [k, v.label, v.pick ? 'is-pick' : '']), st.kind, (k) => {
    st.kind = k; st.open = false;
    if (RACE[k].atomic) st.order = st.order[0] === 'B' ? 'BA' : 'AB';
    else if (st.order.length < 4) st.order = st.order === 'AB' ? 'ABAB' : 'BABA';
    draw();
  });
  app.append(h('div', { class: c('ctl') }, kindC.el, orderRow), stage, h('div', { style: 'height:.7rem' }), say, tally,
    key([['data', 'keys and replies'], ['look', 'a check that saw the like'], ['safe', 'one match'], ['bad', 'missed, doubled, or failed'], ['opt', 'options'], ['pick', 'our pick']]));

  function draw() {
    const atomic = RACE[st.kind].atomic;
    const list = atomic ? ['AB', 'BA'] : ORDERS;
    const oc = chips(atomic ? 'Which EXEC lands first' : 'Order the calls land', list.map((o) => {
      const rr = race(st.kind, o);
      return [o, atomic ? `${o[0]} first` : o.split('').join(' '), `is-${OUTCOME[rr.outcome][1]}`];
    }), st.order, (o) => { st.order = o; st.open = false; draw(); });
    if (known[st.kind]) oc.el.querySelectorAll('button').forEach((b) => b.prepend(h('span', { class: `${P}dot ${b.classList.contains('is-good') ? 'is-good' : 'is-bad'}`, 'aria-hidden': 'true' })));
    orderRow.replaceChildren(oc.el);

    const r = race(st.kind, st.order);
    stage.setAttribute('aria-label', `Calls to Redis for ${RACE[st.kind].label}, order ${st.order}: ${OUTCOME[r.outcome][0]}`);
    const kids = [
      h('div', { class: c('who') }, 'A’s request', h('small', null, 'swipes right on B')),
      h('div', { class: c('redis') }, RACE[st.kind].cluster ? 'Cluster' : 'Redis'),
      h('div', { class: c('who') }, 'B’s request', h('small', null, 'swipes right on A')),
    ];
    const slotTxt = st.kind === 'cl' ? 'right:A → slot 10002 · right:B → slot 6001' : st.kind === 'pk' ? 'likes:{A:B} → slot 10309' : '';
    const base = slotTxt ? 3 : 2;
    if (slotTxt) kids.push(h('div', { class: c('slots'), style: 'grid-row:2' }, slotTxt));
    r.rows.forEach((row, k) => {
      const isA = row.u === 'A';
      const bub = h('div', { class: `${P}bub ${isA ? 'is-a' : 'is-b'}${row.tone === 'bad' ? ' is-err' : ''}`, style: `grid-row:${base + k}` },
        row.tx ? h('span', { class: 'tx' }, 'MULTI … EXEC') : null,
        ...row.lines.map((ln) => h('div', null, ln)),
        st.open ? h('span', { class: `rep${row.tone === 'look' ? ' is-look' : row.tone === 'bad' ? ' is-bad' : ''}` }, `→ ${row.reply}`) : h('span', { class: 'rep is-q' }, '→ ?'));
      kids.push(bub, h('div', { class: c('t'), style: `grid-row:${base + k}` }, `t${k + 1}`));
    });
    if (!st.open) {
      const qs = [['none', 'No match'], ['one', 'One match'], ['two', 'Two matches'], ['err', 'An error']].map(([v, label]) => {
        const b = h('button', { class: c('chip'), type: 'button' }, label);
        b.addEventListener('click', () => { st.guess = v; st.open = true; known[st.kind] = true; draw(); });
        return b;
      });
      kids.push(h('div', { class: c('ask'), style: `grid-row:${base + r.rows.length}` }, h('p', null, 'Work it out from the calls. What do A and B end up with?'), h('div', { class: c('chips') }, ...qs),
        h('button', { class: c('skip'), type: 'button', onclick: () => { st.guess = null; st.open = true; known[st.kind] = true; draw(); } }, 'just show me')));
      stage.replaceChildren(...kids);
      say.hidden = true; tally.hidden = true;
      return;
    }
    say.hidden = false; tally.hidden = false;
    ['A', 'B'].forEach((u) => {
      const v = r.res[u];
      const [t, tone] = v === 'err' ? ['Error', 'bad'] : v ? ['It’s a Match!', r.matches === 2 ? 'bad' : 'good'] : ['No match', r.outcome === 'none' ? 'bad' : ''];
      kids.push(h('div', { class: `${P}end is-${u.toLowerCase()}${tone ? ` is-${tone}` : ''}`, style: `grid-row:${base + r.rows.length}` }, t));
    });
    const keysShown = st.kind === 'pk' ? ['likes:{A:B}'] : ['right:A', 'right:B'];
    kids.push(h('div', { class: `${P}state${r.err ? ' is-bad' : ''}`, style: `grid-row:${base + r.rows.length + 1}` }, r.err ? 'nothing saved' : keysShown.map((k) => `${k} = {${[...r.sets[k]].sort().join(', ')}}`).join('   ')));
    stage.replaceChildren(...kids);

    const [title, tone] = OUTCOME[r.outcome];
    say.className = `${P}say is-${tone}`;
    const GUESS = { none: 'no match', one: 'one match', two: 'two matches', err: 'an error' };
    const fb = st.guess == null ? '' : st.guess === r.outcome ? '<span class="ok">You got it.</span> ' : `<span class="no">You said “${GUESS[st.guess]}”.</span> `;
    say.innerHTML = `${fb}<b>${title}.</b> ${raceText(st.kind, r, st.order)}`;
    const counts = {};
    list.forEach((o) => { const k = race(st.kind, o).outcome; counts[k] = (counts[k] || 0) + 1; });
    tally.innerHTML = `<b>${list.length === 2 ? 'Both orders' : `All ${list.length} orders`}:</b> ${Object.entries(counts).map(([k, n]) => `<span class="${OUTCOME[k][1] === 'good' ? 'g' : 'r'}">${n} × ${OUTCOME[k][0].toLowerCase()}</span>`).join(', ')}.`;
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
    say: 'The message is <b class="ok">durable</b> in ScyllaDB. Only now does gateway A tell Arjun’s phone “sent”. Every later step may fail, because every later step can be redone from this row.',
    a: 'sent', rn: riyaNet, rv: 'empty' });
  const dropped = fault === 'restart' || fault === 'offline';
  E.push({ t: '4 ms', who: 'gateway A', what: dropped ? 'publishes; nobody is listening' : 'publishes to Riya’s channel', tone: dropped ? 'lost' : '',
    code: `PUBLISH user:riya '{"id":"${SID}", …}'  →  (integer) ${dropped ? 0 : 1}`,
    say: !dropped
      ? 'Redis hands the message to every subscriber connected <b>now</b> and keeps no copy.'
      : fault === 'restart'
        ? '<b class="no">Gateway B is restarting for a deploy.</b> Nobody subscribes to <code>user:riya</code>, so Redis drops the message: Pub/Sub delivers at most once. The count cannot prove delivery either, because in Redis Cluster it covers only clients on the same node.'
        : '<b class="no">Riya’s phone is off.</b> No gateway holds a socket for her, so nobody subscribes to <code>user:riya</code> and Redis drops the message.',
    a: 'sent', rn: riyaNet, rv: 'empty' });
  if (!fault) {
    E.push({ t: '5 ms', who: 'gateway B', what: 'writes the frame to Riya’s socket', code: 'conn.write(frame)',
      say: 'Riya’s phone stores the message under its <code>message_id</code> and shows it.', a: 'sent', rn: 'ok', rv: 'msg' });
    E.push({ t: '70 ms', who: 'Riya’s phone', what: 'ACKs; the row becomes delivered', tone: 'safe',
      short: "ACK → status = 'delivered'",
      code: `{"type": "ack", "id": "${SID}"}\nUPDATE messages SET status = 'delivered' WHERE …`,
      say: 'Only the phone’s ACK marks the row <b class="ok">delivered</b>. Arjun sees two ticks. (70 ms is a sample round trip.)', a: 'delivered', rn: 'ok', rv: 'msg' });
    return E;
  }
  if (fault === 'switch') {
    E.push({ t: '5 ms', who: 'gateway B', what: 'write() returns OK to a dead socket', tone: 'lost',
      code: 'conn.write(frame)   # OK: the bytes are in the kernel send buffer',
      say: '<b class="no">Riya walked out of the café and her phone moved to mobile data.</b> Gateway B does not know yet. A successful write means only that the kernel took the bytes; Linux retransmits for 13 to 30 minutes before it reports the connection dead. So a successful write never means “delivered”.',
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
    say: 'Same ending as with no fault. The live path lost the message; <b class="ok">the stored row and the sync query brought it back.</b>',
    a: 'delivered', rn: 'back', rv: 'msg' });
  return E;
}

const FAULTS = [['', 'no fault'], ['restart', 'gateway B restarts'], ['switch', 'Wi-Fi → mobile data'], ['offline', 'phone off for days']];

function initChatTimeline(fig, app) {
  let fault = ''; let ev = chatEvents(fault); let i = 0;
  const phoneA = h('div', { class: `${P}phone is-a` });
  const phoneB = h('div', { class: `${P}phone is-b` });
  const log = h('ol');
  const now = h('div', { class: `${P}say ${P}now`, 'aria-live': 'polite' });
  const ask = h('div', { class: c('ask2') });
  const ticks = h('div', { class: c('ticks'), role: 'group', 'aria-label': 'Events' });
  const pos = h('span', { class: c('pos') });
  const back = h('button', { class: c('chip'), type: 'button', 'aria-label': 'Previous event' }, '◀');
  const next = h('button', { class: c('chip'), type: 'button', 'aria-label': 'Next event' }, 'Next ▶');
  back.addEventListener('click', () => go(i - 1));
  next.addEventListener('click', () => go(i + 1));
  const faultC = chips('Fault', FAULTS, fault, (f) => { fault = f; ev = chatEvents(f); go(0, true); });

  app.append(h('div', { class: c('ctl') }, faultC.el, h('div', { class: c('steps') }, back, ticks, pos, next)),
    h('div', { class: c('chat') }, phoneA, h('div', { class: c('log') }, log), phoneB), now, ask,
    key([['look', 'this event'], ['data', 'commands and IDs'], ['safe', 'durable or delivered'], ['bad', 'where the live path loses it'], ['opt', 'faults to try']]));
  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); }
  });

  function phone(el, name, net, body) {
    const [nt, tone] = NET[net] || ['', ''];
    el.replaceChildren(...[h('div', { class: 'bar' }, h('i')), h('h5', null, name), nt ? h('div', { class: `net${tone ? ` is-${tone}` : ''}` }, nt) : null, h('div', { class: 'body' }, ...body)].filter(Boolean));
  }
  function go(n, rebuild) {
    i = clamp(n, 0, ev.length - 1);
    if (rebuild || ticks.children.length !== ev.length) {
      ticks.replaceChildren(...ev.map((e, k) => {
        const b = h('button', { class: `${P}tick${e.tone === 'lost' ? ' is-lost' : ''}`, type: 'button', 'aria-label': `${e.t}: ${e.who} ${e.what}` });
        b.addEventListener('click', () => go(k));
        return b;
      }));
    }
    [...ticks.children].forEach((b, k) => { b.classList.toggle('is-now', k === i); b.classList.toggle('is-past', k < i); b.setAttribute('aria-current', k === i ? 'step' : 'false'); });
    back.disabled = i === 0; next.disabled = i === ev.length - 1;
    pos.textContent = `${i + 1} / ${ev.length}`;
    const e = ev[i];
    const status = { sending: ['sending…', ''], sent: ['✓ sent', ''], delivered: ['✓✓ delivered', 'is-safe'] }[e.a];
    phone(phoneA, 'Arjun', null, [h('div', { class: `${P}msg is-out` }, MSG.text, h('span', { class: `st ${status[1]}` }, status[0]))]);
    const lost = ev.slice(0, i + 1).some((x) => x.tone === 'lost');
    const rb = e.rv === 'msg' ? [h('div', { class: `${P}msg is-in` }, MSG.text)]
      : e.rv === 'banner' ? [h('div', { class: `${P}banner` }, h('b', null, 'Tinder · now'), `Arjun: ${MSG.text}`), h('div', { class: `${P}empty` }, 'app closed')]
        : [h('div', { class: `${P}empty${lost ? ' is-bad' : ''}` }, lost ? 'nothing arrived' : 'waiting…')];
    phone(phoneB, 'Riya', e.rn, rb);
    log.replaceChildren(...ev.slice(0, i + 1).map((x, k) => h('li', { class: `${P}ev${k === i ? ' is-now' : ''}${x.tone === 'lost' ? ' is-lost' : ''}${x.tone === 'safe' ? ' is-safe' : ''}` },
      h('span', { class: 't' }, x.t), h('span', { class: 'w' }, h('b', null, x.who), ` ${x.what}`), h('span', { class: 'c' }, x.short || x.code))));
    now.className = `${P}say ${P}now${e.tone === 'lost' ? ' is-bad' : e.tone === 'safe' ? ' is-good' : ''}`;
    now.innerHTML = `<p>${e.say}</p><pre class="${P}code">${esc(e.code)}</pre>`;
    ask.replaceChildren();
    if (fault && i === ev.length - 1) {
      const fbk = h('p', { class: 'fb', 'aria-live': 'polite' });
      const opts = [['ps', 'Redis Pub/Sub'], ['push', 'The push notification'], ['row', 'The stored row and the sync query']].map(([v, label]) => {
        const b = h('button', { class: c('chip'), type: 'button' }, label);
        b.addEventListener('click', () => {
          fbk.innerHTML = v === 'row'
            ? '<span class="ok">Right.</span> ScyllaDB owns the guarantee. Pub/Sub keeps no copy, and the push only wakes the app.'
            : v === 'ps' ? '<span class="no">Not Pub/Sub.</span> It delivers at most once and kept no copy; this is where the message was lost.'
              : '<span class="no">Not the push.</span> It only wakes the app. The message came from the row, through the sync query.';
        });
        return b;
      });
      ask.append(h('p', { class: 'q' }, 'Check yourself: what brought the message back?'), h('div', { class: c('chips') }, ...opts), fbk);
    }
  }
  go(0, true);
}

register({
  'deck-hero': initDeckHero,
  'arch-paths': initArchPaths,
  'geo-reach': initGeoReach,
  'swipe-race': initSwipeRace,
  'chat-timeline': initChatTimeline,
});

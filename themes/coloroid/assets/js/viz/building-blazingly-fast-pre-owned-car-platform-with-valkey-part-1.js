/*
 * Figures for "Building blazingly fast pre-owned car platform with Valkey – Part 1".
 * House look (walviz.css + lib.js components). What is specific to this post is
 * the drawing and the interaction, not the chrome.
 *
 *   hook-sets         place each write in the smallest hook ring that sees it
 *   change-timeline   swimlanes: guess when the buyer sees the new price, then scrub
 *   outage-timeline   the same lanes: predict delayed or lost, then see where it resumes
 *
 * Checked against:
 *   - pratikgajjar/mysql-data-stream-kafka @ ea9296b (main.py): only_events,
 *     topic = table name, no message key, JSON value, position saved on exit
 *   - kafka-python 1.4.6: acks=1 default, random partition when key is None
 *   - mysql-replication 0.19: before_values / after_values / values
 *   - django-redis 6.0: key ":1:<key>", pickle then gzip, SET … PX <ms>
 *   - MySQL 8.0 docs: sync_binlog=1 and binlog_format=ROW are defaults since 5.7.7
 *   - Django 6.1: QuerySet.update(), bulk_create(), bulk_update() send no post_save
 * Car, prices, binlog positions and offsets are sample values.
 */
import { h, s, register, uid, clamp, REDUCED, colorKey, codeBlock, range, chips, ask } from './lib.js';

const P = 'v-car1-';
const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
const OLD = 525000;
const NEW = 510000;

/* ------------------------------------------------------------ helpers */

function onLayout(el, rebuild, at) {
  let cur = null;
  const check = () => {
    const k = el.clientWidth < at ? 'tall' : 'wide';
    if (k !== cur) { cur = k; rebuild(k); }
  };
  if ('ResizeObserver' in window) new ResizeObserver(check).observe(el);
  check();
}

/** Colour key with the shared key classes. items: [[token, label], …] */
const KEYCLS = { pick: 'k-pick', data: 'k-data', safe: 'k-safe', look: 'k-look', opt: 'k-opt', gap: 'k-gap', ink: 'k-ink' };
const key = (items) => colorKey(items.map(([k, label]) => [KEYCLS[k], label]));

/** Code lines: «x» data, ⟪x⟫ good, ⟦x⟧ bad, // comment. */
const code = (lines) => codeBlock(lines.map((l) => l.replace(/[«»]/g, '')));

/* ========================================================== HOOK RINGS */

/*
 * The reader places one concrete write at a time into the smallest ring
 * that sees it. Placed writes stay, so the coverage map builds up.
 */
const RINGS = {
  binlog: { title: 'Every committed write to MySQL', hook: 'the binlog reader' },
  domain: { title: 'Writes from the Django inventory app', hook: 'a domain layer' },
  signal: { title: 'save() and create()', hook: 'post_save' },
};
const ORDER = ['signal', 'domain', 'binlog'];

/* Sample writes, in the order the reader meets them. `set` = smallest ring. */
const WRITES = [
  {
    id: 'save', set: 'signal', who: 'Inventory app · Django', label: 'Edit owner',
    code: ['car = Car.objects.get(id=«2323»)', 'car.owner = «2»', 'car.save()'],
    why: 'save() sends post_save after the UPDATE, so every ring sees it.',
  },
  {
    id: 'update', set: 'domain', who: 'Inventory app · Django', label: 'Swap a photo',
    code: ['CarImage.objects.filter(car_id=«2323», image_url=old)', '    .update(image_url=new)'],
    why: 'QuerySet.update() runs one UPDATE and sends no post_save. A domain service sees it only if this code calls the service.',
  },
  {
    id: 'bulk', set: 'domain', who: 'Inventory app · Django', label: 'Add 4 photos',
    code: ['CarImage.objects.bulk_create([', '    CarImage(car_id=«2323», image_url=u) for u in urls])'],
    why: 'bulk_create() inserts in one query and sends no post_save either.',
  },
  {
    id: 'ops', set: 'binlog', who: 'Ops portal · CakePHP', label: 'Mark sold',
    code: ["UPDATE cars SET status = «'sold'» WHERE id = «2323»;"],
    why: 'The portal is a PHP app that writes to MySQL directly. No Django code runs, so only the binlog sees it.',
  },
  {
    id: 'ds', set: 'binlog', who: 'Price script · Python', label: 'Daily prices',
    code: ['cur.executemany(', '    "UPDATE cars SET price = %s WHERE id = %s",', '    rows)                  // 10,000 cars'],
    why: 'The script has its own MySQL connection. Only the binlog sees it.',
  },
];

function initHookSets(fig, app) {
  let k = 0; let answered = false; let right = 0;
  const rings = {}; const chipsIn = {}; const counts = {};

  const q = h('p', { class: 'wv-q' });
  const wcard = h('div', { class: 'wv-card is-look' });
  const fb = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const next = h('button', { type: 'button', class: 'wv-btn' });
  const show = h('button', { type: 'button', class: 'wv-btn wv-btn--ghost', onclick: () => choose(null) }, 'show me');
  next.addEventListener('click', () => (k >= WRITES.length - 1 ? finish() : load(k + 1)));

  const ring = (id, inner) => {
    const r = h('div', { class: `wv-card ${P}ring ${P}ring--${id}`, role: 'button', tabindex: 0, 'aria-label': `${RINGS[id].title}, seen by ${RINGS[id].hook}` },
      h('h5', null, RINGS[id].title), h('p', { class: `${P}ringsub` }, `seen by ${RINGS[id].hook}`, counts[id] = h('b')),
      chipsIn[id] = h('div', { class: `wv-chips ${P}placed` }), inner);
    const pick = (e) => { e.stopPropagation(); if (!answered && k < WRITES.length) choose(id); };
    r.addEventListener('click', pick);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(e); e.preventDefault(); } });
    rings[id] = r;
    return r;
  };
  const tree = ring('binlog', ring('domain', ring('signal')));
  const restart = h('button', { type: 'button', class: 'wv-btn wv-btn--ghost', onclick: () => reset() }, 'start over');

  tree.classList.add(`${P}tree`);
  app.append(h('div', { class: `${P}hookgrid` }, q, wcard, tree, fb, h('div', { class: 'wv-bar' }, show, next, restart)),
  key([['look', 'the write in your hand'], ['safe', 'the smallest ring that sees it'], ['gap', 'your guess, when wrong'], ['pick', 'the hook we chose']]));

  function load(i) {
    k = i; answered = false;
    const w = WRITES[i];
    q.innerHTML = `Write <b>${i + 1} of ${WRITES.length}</b>. Tap the smallest ring that sees it.`;
    wcard.innerHTML = `<h5>${w.label}</h5><p class="t-s">${w.who}</p>${code(w.code)}`;
    wcard.hidden = false; wcard.classList.add('is-look');
    fb.className = 'wv-note'; fb.hidden = true;
    next.hidden = true; show.hidden = false; restart.hidden = true;
    Object.values(rings).forEach((r) => r.classList.remove('is-good', 'is-bad', 'is-pick'));
    tree.classList.add('is-asking');
  }

  function place(w) {
    const c = h('button', { type: 'button', class: 'wv-chip', onclick: (e) => { e.stopPropagation(); review(w); } }, w.label);
    chipsIn[w.set].append(c);
    return c;
  }

  function choose(id) {
    const w = WRITES[k];
    answered = true;
    tree.classList.remove('is-asking');
    wcard.classList.remove('is-look');
    const ok = id === w.set;
    if (ok) right++;
    if (id && !ok) rings[id].classList.add('is-bad');
    rings[w.set].classList.add('is-good');
    place(w);
    fb.hidden = false;
    fb.className = `wv-note ${ok ? 'is-good' : 'is-bad'}`;
    fb.innerHTML = `<b>${ok ? 'Right.' : id ? `It lands in “${RINGS[w.set].title}”.` : `“${RINGS[w.set].title}”.`}</b> ${w.why}`;
    next.textContent = k >= WRITES.length - 1 ? 'See the count →' : 'Next write →';
    next.hidden = false; show.hidden = true;
  }

  function review(w) {
    fb.hidden = false;
    fb.className = 'wv-note';
    fb.innerHTML = `<b>${w.label}</b> (${w.who}). ${w.why}`;
  }

  function finish() {
    k = WRITES.length;
    Object.values(rings).forEach((r) => r.classList.remove('is-good', 'is-bad'));
    for (const id of ORDER) {
      const n = WRITES.filter((w) => ORDER.indexOf(w.set) <= ORDER.indexOf(id)).length;
      counts[id].textContent = ` · sees ${n} of ${WRITES.length}`;
    }
    rings.binlog.classList.add('is-pick');
    tree.classList.add('is-done');
    q.innerHTML = `You placed <b>${right} of ${WRITES.length}</b> in the right ring.`;
    wcard.hidden = true;
    fb.hidden = false;
    fb.className = 'wv-note';
    fb.innerHTML = '<b>Only the outer ring holds every write.</b> A hook sees the writes inside its ring. The binlog reader is the only hook every writer passes, so that is where we put it. Tap a placed write to read why it sits there.';
    next.hidden = true; show.hidden = true; restart.hidden = false;
  }

  function reset() {
    right = 0;
    Object.values(chipsIn).forEach((c) => c.replaceChildren());
    Object.values(counts).forEach((c) => { c.textContent = ''; });
    load(0);
  }
  load(0);
}

/* =========================================================== TIMELINE */

const LANES = ['script', 'MySQL', 'producer', 'Kafka', 'consumer', 'Valkey', 'buyer'];
const LANE_LABEL = { script: 'price script', MySQL: 'MySQL', producer: 'producer', Kafka: 'Kafka', consumer: 'consumer', Valkey: 'Valkey', buyer: 'buyer' };

/*
 * A scenario: events on lanes at ordinal x (order, not time), outage blocks,
 * and cache bands on the Valkey lane. Event kinds: ok | resume | fail | lost | wait | expire.
 * src: [x, lane] draws the connector from there; default is the previous event.
 */
const E = {
  commit: (x, src = [x - 0.65, 'script']) => ({
    x, lane: 'MySQL', tag: 'commit', src,
    title: 'The price script commits an UPDATE',
    body: `${code(['UPDATE cars SET price = «510000» WHERE id = «2323»;', 'COMMIT;'])}<p>MySQL appends one <code>Update_rows</code> event to the binlog, with the whole row before and after. Valkey still holds the JSON with ${inr(OLD)}.</p>`,
  }),
  read: (x, extra = {}) => ({
    x, lane: 'producer', tag: 'row event',
    title: 'The producer reads the row event',
    body: `${code([
      'stream = BinLogStreamReader(..., server_id=100, blocking=True,',
      '    only_events=[WriteRowsEvent, UpdateRowsEvent],',
      '    log_file=«"mysql-bin.000412"», log_pos=«18411», resume_stream=True)',
      'row["before_values"]   // {"id": 2323, …, "price": «525000»}',
      'row["after_values"]    // {"id": 2323, …, "price": «510000»}',
    ])}<p>The producer connects as a MySQL replica. This needs <code>binlog_format=ROW</code>, the default since MySQL 5.7.7. The public library asks only for inserts and updates, so a deleted row, such as a removed photo, never reaches Kafka unless <code>DeleteRowsEvent</code> is added.</p>`,
    ...extra,
  }),
  send: (x, extra = {}) => ({
    x, lane: 'Kafka', tag: 'p2 · 88,120',
    title: 'One JSON message on topic cars',
    body: `${code([
      'producer.send(topic=«"cars"», value=«b\'{"schema": "carsdb", "table": "cars",»',
      '    «"type": "UpdateRowsEvent", "row": {…, "price": 510000}}}\'»)',
      '// 296 bytes · no key: kafka-python picks a random partition',
    ])}<p>It lands on partition 2 at offset 88,120. With no key, two changes to one car can land in different partitions and arrive in any order. Sending the car id as the key keeps one car's changes in one partition, in order.</p>`,
    ...extra,
  }),
  map: (x, extra = {}) => ({
    x, lane: 'consumer', tag: 'car 2323',
    title: 'The consumer finds the car id (sketch)',
    body: `${code([
      'CAR_ID = {"cars": lambda r: r["id"],',
      '          "car_images": lambda r: r["car_id"],',
      '          "car_features": lambda r: r["car_id"]}',
      'row = msg["row"].get("after_values") or msg["row"]["values"]',
      'car_id = CAR_ID[msg["table"]](row)     // «2323»',
    ])}<p>The binlog knows rows, not car pages. The consumer needs one rule per table. When someone adds a table to the car page, they add a rule here.</p>`,
    ...extra,
  }),
  set: (x, extra = {}) => ({
    x, lane: 'Valkey', tag: 'SET',
    title: 'Rebuild the JSON and SET it',
    body: `${code([
      'payload = build_car_json(2323)        // reads ~10 tables on MySQL',
      'cache.set("dp:2323", payload, timeout=12 * 3600)',
      'SET «:1:dp:2323» «1f 8b 08 00 …» PX «43200000»   // pickle → gzip',
    ])}<p>The consumer reads the car's current rows, not the values in the event, so a late or repeated event still writes the latest state. django-redis adds the <code>:1:</code> version prefix and sends 12 hours as milliseconds.</p>`,
    ...extra,
  }),
  ack: (x, extra = {}) => ({
    x, lane: 'Kafka', tag: '88,121',
    title: 'Commit the offset after the SET',
    body: `${code(['consumer.commit()      // p2: 88,120 → «88,121»'])}<p>The offset moves only after the SET returns. If the consumer dies in between, Kafka hands out 88,120 again and the same JSON is built again. Delivery is at-least-once, and a rebuild is safe to repeat.</p>`,
    ...extra,
  }),
  get: (x) => ({
    x, lane: 'Valkey', tag: 'GET', src: [x - 0.6, 'buyer'],
    title: 'The next buyer gets the new price',
    body: `${code(['GET /listing/2323/', 'cache.get("dp:2323")   // GET :1:dp:2323 → gunzip → unpickle', `→ 200 {"id": 2323, "price": «${NEW}», …}`])}<p>One key lookup and no MySQL query. The red stretch on the Valkey lane, from the commit to the SET, is the lag of the pipeline.</p>`,
  }),
};

const NORMAL = {
  intro: 'Press play, drag the purple line, or tap a dot. The card shows what a buyer gets at that moment.',
  events: [E.commit(1), E.read(2), E.send(3), E.map(4), E.set(5), E.ack(6), E.get(7)],
  blocks: [],
  bands: [[0, 1, 'ok'], [1, 5, 'stale'], [5, 99, 'ok']],
};

const FAULTS = [
  {
    key: '1', name: '1 · Consumer', resume: 'The consumer resumes at the last committed offset.', ask: 3.4, answer: 'delayed',
    intro: 'The consumer node dies right after the change reaches Kafka.',
    why: 'Kafka keeps the message, and the consumer never committed its offset, so it reads the change after it restarts. Until then the page shows the old price.',
    events: [E.commit(1), E.read(2), E.send(3),
      { x: 5, lane: 'Kafka', tag: 'waits', kind: 'wait', src: null, title: 'The message waits in Kafka', body: '<p>Kafka keeps messages for 7 days by default (<code>log.retention.hours=168</code>). The committed offset for partition 2 is still 88,120. The car page shows the old price the whole time.</p>' },
      { ...E.map(7), kind: 'resume', tag: 'from 88,120', title: 'The consumer restarts at the committed offset', body: `${code(['// group resumes p2 at the committed offset', 'poll() → offset «88,120»'])}<p>Anything the consumer wrote before it died but did not commit is processed again. The rebuild gives the same JSON, so a repeat is harmless.</p>` },
      E.set(8), E.ack(9)],
    blocks: [['consumer', 3.4, 6.6]],
    bands: [[0, 1, 'ok'], [1, 8, 'stale'], [8, 99, 'ok']],
  },
  {
    key: '2', name: '2 · Producer', resume: 'The producer resumes at its saved binlog position.', ask: 1.4, answer: 'delayed',
    intro: 'The producer node dies right after the UPDATE commits.',
    why: 'The change waits in the binlog on the MySQL disk, and the producer resumes from its saved position.',
    events: [E.commit(1),
      { x: 3, lane: 'MySQL', tag: 'in binlog', kind: 'wait', src: null, title: 'The event stays in the binlog', body: '<p>The binlog file is on the MySQL disk. Nothing is lost while MySQL still has that file.</p>' },
      E.read(5, { kind: 'resume', tag: 'from 18411', title: 'The producer restarts at its saved position', src: [3, 'MySQL'] }),
      E.send(6), E.map(7), E.set(8), E.ack(9)],
    blocks: [['producer', 1.4, 4.6]],
    bands: [[0, 1, 'ok'], [1, 8, 'stale'], [8, 99, 'ok']],
    extra: 'Events after the saved position that were already sent go to Kafka a second time, and the consumer rebuilds those cars twice. The public library saves its position to a local file when it stops on a signal or an error.',
  },
  {
    key: '3', name: '3 · Valkey', resume: 'The offset was never committed, so the consumer retries the same message.', ask: 4.4, answer: 'delayed',
    intro: 'Valkey goes down just as the consumer is ready to write.',
    why: 'The SET fails, so the consumer does not commit the offset. It retries until Valkey is back.',
    events: [E.commit(1), E.read(2), E.send(3), E.map(4),
      { x: 5, lane: 'consumer', tag: 'SET ✗', kind: 'fail', title: 'SET fails, the offset stays', body: `${code(['cache.set(...)      // ⟦ConnectionError⟧', '// no commit: p2 stays at «88,120»'])}<p>The consumer does not commit the offset, so the change is not lost. It retries.</p>` },
      { x: 6.5, lane: 'consumer', tag: 'retry ✗', kind: 'fail', src: [5, 'consumer'], title: 'Retries fail while Valkey is down', body: '<p>While Valkey is down, the API cannot read the cache either. What a buyer sees then depends on the API\'s fallback.</p>' },
      E.set(8, { kind: 'resume', tag: 'SET ✓', src: [6.5, 'consumer'], title: 'Valkey is back and the retry succeeds', body: `${code(['SET «:1:dp:2323» «1f 8b 08 00 …» PX «43200000»   // ⟪OK⟫'])}<p>If Valkey failed over to a replica instead, the last writes before the failure can be missing, because replication is asynchronous. The 12-hour TTL limits how long such a key stays wrong.</p>` }),
      E.ack(9)],
    blocks: [['Valkey', 4.4, 7.6]],
    bands: [[0, 1, 'ok'], [1, 4.4, 'stale'], [4.4, 7.6, 'down'], [7.6, 8, 'stale'], [8, 99, 'ok']],
  },
  {
    key: '4a', name: "4 · Kafka, acks=1", ask: 3.5,
    resume: 'Nothing resumes: no part still has the change.',
    intro: 'The partition leader dies right after it confirms the message. The producer uses the kafka-python default, acks=1.', answer: 'lost',
    why: 'The leader confirmed before any follower copied the message, then died. The producer does not resend it, so car 2323 keeps the old price until its 12-hour TTL ends.',
    events: [E.commit(1), E.read(2),
      E.send(3, { tag: 'leader ack', title: 'The leader confirms alone', body: `${code(['KafkaProducer(bootstrap_servers=…)   // acks=«1» by default'])}<p>With <code>acks=1</code> the leader confirms before any follower has copied the message.</p>` }),
      { x: 5.2, lane: 'Kafka', tag: 'lost', kind: 'lost', title: 'The new leader never had the message', body: '<p>A follower becomes leader without the message. The producer already has its ack, so it does not resend. Nothing tells the consumer about the price change.</p>' },
      { x: 8, lane: 'Valkey', tag: 'TTL ends', kind: 'expire', src: null, title: 'The key expires 12 hours after its last SET', body: '<p>Car 2323 keeps the old price until its 12-hour TTL removes the key.</p>' }],
    blocks: [['Kafka', 3.5, 4.8]],
    bands: [[0, 1, 'ok'], [1, 8, 'stale'], [8, 99, 'gone']],
  },
  {
    key: '4b', name: "4 · Kafka, acks='all'", ask: 3.5,
    resume: 'The new leader already has the message, so the consumer reads it as usual.',
    intro: "The partition leader dies right after it confirms the message. The producer uses acks='all', and the topic has replication factor 3 and min.insync.replicas=2.", answer: 'delayed',
    why: 'An in-sync follower already had the message, so it becomes leader and the consumer reads the change a little later.',
    events: [E.commit(1), E.read(2),
      E.send(3, { tag: 'leader + follower', title: 'The leader confirms after a follower has it', body: `${code(["KafkaProducer(bootstrap_servers=…, acks=«'all'»)", '// topic: replication.factor=«3», min.insync.replicas=«2»'])}<p>The leader answers only after an in-sync follower has the message.</p>` }),
      { x: 5, lane: 'Kafka', tag: 'new leader', kind: 'resume', src: [3, 'Kafka'], title: 'A follower with the message takes over', body: '<p>The new leader has offset 88,120, so the consumer reads it as usual.</p>' },
      E.map(6), E.set(7), E.ack(8)],
    blocks: [['Kafka', 3.5, 4.8]],
    bands: [[0, 1, 'ok'], [1, 7, 'stale'], [7, 99, 'ok']],
  },
  {
    key: '5', name: '5 · MySQL', resume: 'The producer reconnects at its saved binlog position.', ask: 1.4, answer: 'delayed',
    intro: 'MySQL restarts right after the price UPDATE commits, before the producer reads it.',
    why: 'MySQL writes the commit to the binlog on disk before it confirms it (sync_binlog=1, the default since MySQL 5.7.7), so the restart keeps the change.',
    events: [E.commit(1),
      { x: 3, lane: 'MySQL', tag: 'in binlog', kind: 'wait', src: null, title: 'The event is on disk in the binlog', body: '<p>The restart drops the producer\'s connection. The binlog file with the UPDATE is still on the MySQL disk.</p>' },
      E.read(5, { kind: 'resume', tag: 'from 18411', title: 'The producer reconnects at its saved position', src: [3, 'MySQL'] }),
      E.send(6), E.map(7), E.set(8), E.ack(9)],
    blocks: [['MySQL', 1.4, 4.6]],
    bands: [[0, 1, 'ok'], [1, 8, 'stale'], [8, 99, 'ok']],
    extra: 'Binlog files survive a restart. If a file is purged before the producer reads it, those changes never reach Kafka: rebuild every active car with the management command.',
  },
];

const BAND_CARD = {
  ok: (after) => ({ price: after ? NEW : OLD, cls: 'is-ok', note: after ? 'new price · matches MySQL' : 'matches MySQL' }),
  stale: () => ({ price: OLD, cls: 'is-stale', note: `stale · MySQL has ${inr(NEW)}` }),
  down: () => ({ price: null, cls: 'is-down', note: 'Valkey is down · depends on the API fallback' }),
  gone: () => ({ price: null, cls: 'is-gone', note: 'key expired (TTL 12 h)' }),
};
const BAND_LABEL = { stale: 'serves the old price', down: 'down', gone: 'key expired' };

/*
 * Swimlane engine shared by Fig. 2 and Fig. 3, so the reader's map of the
 * lanes stays the same across both figures.
 *   opts.top      element above the controls
 *   opts.onDot(k) return true to take over a dot tap (guess mode)
 *   opts.onMove() called when the reader moves time
 *   opts.extra(k) html appended to step k's detail
 */
function timeline(fig, app, opts = {}) {
  const id = uid('car1t');
  let sc = null; let now = 0; let L = null; let kind = 'wide'; let playing = null;
  let revealTo = Infinity; let prompt = null; let guess = -1;
  const refs = {};
  const timed = opts.time !== false;
  const stage = h('div', { class: `${P}tl${timed ? '' : ' is-still'}` });
  const card = h('div', { class: `wv-card ${P}buyer`, 'aria-live': 'polite' },
    h('p', null, 'A buyer opening car 2323 now sees'),
    h('dl', { class: 'wv-kv' }, h('dt', null, 'price'), refs.price = h('dd'), h('dt', null, 'cache'), refs.cnote = h('dd')));
  const detail = h('div', { class: 'wv-insp', 'aria-live': 'polite' });
  const stepOf = (v) => { const n = sc ? sc.events.filter((e) => e.x <= v + 1e-6).length : 0; return n ? `step ${n}` : 'start'; };
  const rg = range('time', { min: 0, max: 10, step: 0.01, value: 0, fmt: stepOf, oninput: (v) => { stop(); moved(); setNow(v); } });
  const slider = rg.input;
  const play = h('button', { type: 'button', class: 'wv-btn' }, '▶ Play');
  const ctrl = h('div', { class: `wv-bar ${P}ctrl` }, play, rg.el);

  play.addEventListener('click', () => { moved(); if (playing) stop(); else start(); });

  app.append(...(opts.top ? [opts.top] : []), ...(timed ? [ctrl] : []),
    timed ? h('div', { class: `${P}tlgrid` }, stage, card) : stage, ...(opts.below ? [opts.below] : []), detail);

  const moved = () => opts.onMove?.();
  const xmax = () => Math.max(...sc.events.map((e) => e.x)) + 0.9;
  const limit = () => Math.min(xmax(), revealTo);

  function geom() {
    const wide = kind === 'wide';
    const W = wide ? 700 : 360;
    const lab = wide ? 96 : 70;
    const top = wide ? 30 : 16;
    const lh = wide ? 38 : 32;
    const vx = wide ? 16 : 0; // extra height on the Valkey lane for the band label
    const hOf = (ln) => lh + (ln === 'Valkey' ? vx + 8 : 0);
    const yOf = {}; let y = top;
    for (const ln of LANES) { yOf[ln] = y; y += hOf(ln); }
    const H = y + 6;
    const x0 = lab + 14; const x1 = W - 16;
    const X = (x) => x0 + (x / xmax()) * (x1 - x0);
    const Y = (ln) => yOf[ln] + lh / 2;
    return { wide, W, H, lab, top, lh, X, Y, yOf, hOf, x0, x1 };
  }

  function build() {
    if (!sc) return;
    L = geom();
    const { W, H, X, Y, lh, top, wide, yOf, hOf } = L;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.getAttribute('aria-label') || 'Timeline' });
    svg.append(s('defs', null,
      s('pattern', { id: `${id}-hatch`, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        s('rect', { width: 7, height: 7, class: `${P}hatchbg` }), s('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: `${P}hatchln` })),
      s('marker', { id: `${id}-a`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' }, s('path', { d: 'M0,0 L8,4 L0,8 z', class: `${P}arrowhead` }))));

    LANES.forEach((ln, k) => {
      svg.append(s('rect', { x: 0, y: yOf[ln], width: W, height: hOf(ln), class: `${P}lane${k % 2 ? ' odd' : ''}` }));
      svg.append(s('text', { x: 8, y: Y(ln) + 4, class: 't-s t-b' }, !wide && ln === 'script' ? 'script' : LANE_LABEL[ln]));
    });
    // cache bands on the Valkey lane, clipped at what the reader may see
    const by = Y('Valkey') + 13;
    for (const [a, b, st] of sc.bands) {
      if (st === 'ok') continue; // fresh is the normal state: no mark
      const xa = X(clamp(a, 0, limit())); const xb = X(clamp(b, 0, limit()));
      if (xb - xa < 1) continue;
      svg.append(s('rect', { x: xa, y: by, width: xb - xa, height: 6, rx: 2, class: `${P}band ${P}band--${st}`, fill: st === 'down' ? `url(#${id}-hatch)` : null }));
      const lbl = BAND_LABEL[st];
      if (wide && xb - xa > lbl.length * 6.2 + 10) svg.append(s('text', { x: xa + 4, y: by + 17, class: `t-xs t-b ${st === 'gone' ? '' : 't-bad'}` }, lbl));
    }
    const hidden = (x) => x > revealTo + 1e-6;
    // connectors
    refs.hops = sc.events.map((e, k) => {
      const src = e.src === undefined ? (k ? [sc.events[k - 1].x, sc.events[k - 1].lane] : null) : e.src;
      if (!src || hidden(e.x)) return [null, e.x];
      const [sx, sl] = src;
      const ax = X(sx); const ay = Y(sl); const bx = X(e.x); const byy = Y(e.lane);
      const d = Math.abs(ax - bx) < 0.5 ? `M${ax},${ay} L${bx},${byy + (byy > ay ? -11 : 11)}`
        : `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${byy} ${bx - 11},${byy}`;
      if (!sc.events.some((o) => o.x === sx && o.lane === sl)) svg.append(s('circle', { cx: ax, cy: ay, r: 3.2, class: `${P}origin` }));
      const p = s('path', { d, class: `${P}hop${e.kind === 'lost' ? ' is-lost' : ''}`, 'marker-end': `url(#${id}-a)` });
      svg.append(p);
      return [p, e.x];
    });
    // the unknown: fog over what the reader has not predicted yet
    if (revealTo < xmax()) {
      const fx = X(revealTo) + 6;
      svg.append(s('rect', { x: fx, y: top, width: W - fx, height: H - top - 6, class: `${P}fog` }));
      svg.append(s('text', { x: (fx + W) / 2, y: (top + H) / 2 + 12, 'text-anchor': 'middle', class: 't-xl t-b' }, '?'));
    }
    // outage blocks: the given in a question, so drawn above the fog
    for (const [ln, a, b] of sc.blocks) {
      svg.append(s('rect', { x: X(a), y: yOf[ln] + 3, width: X(b) - X(a), height: lh - 6, rx: 4, class: `${P}down`, fill: `url(#${id}-hatch)` }));
      svg.append(s('text', { x: (X(a) + X(b)) / 2, y: Y(ln) + 4, 'text-anchor': 'middle', class: 't-xs t-b t-bad t-up halo' }, 'down'));
    }
    // events
    refs.dots = sc.events.map((e, k) => {
      const g = s('g', { class: `${P}ev ${P}ev--${e.kind || 'ok'}${hidden(e.x) ? ' is-hidden' : ''}${k === guess ? ' is-guess' : ''}`, tabindex: hidden(e.x) ? -1 : 0, role: 'button', 'aria-label': `Step ${k + 1}: ${e.title}` });
      const cx = X(e.x); const cy = Y(e.lane);
      g.append(s('circle', { cx, cy, r: 10 }));
      g.append(s('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', class: 't-xs t-b n' }, e.kind === 'fail' || e.kind === 'lost' ? '✗' : String(k + 1)));
      if (wide) g.append(s('text', { x: cx, y: cy - 15, 'text-anchor': 'middle', class: 't-xs halo tag' }, k === guess ? 'your guess' : e.tag));
      const go = () => {
        if (opts.onDot?.(k)) return;
        stop(); moved(); setNow(e.x + 0.001);
      };
      g.addEventListener('click', go);
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { go(); ev.preventDefault(); } });
      svg.append(g);
      return g;
    });
    refs.cursor = s('g', { class: `${P}cursor`, display: timed ? null : 'none' },
      s('line', { x1: 0, x2: 0, y1: top - (wide ? 24 : 12), y2: H - 4 }),
      s('rect', { x: -5, y: top - (wide ? 28 : 16), width: 10, height: 10, rx: 2 }));
    svg.append(refs.cursor);
    if (timed) svg.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest(`.${P}ev`)) return;
      stop(); moved();
      const move = (e2) => {
        const r = svg.getBoundingClientRect();
        const vx = ((e2.clientX - r.left) / r.width) * W;
        setNow(clamp(((vx - L.x0) / (L.x1 - L.x0)) * xmax(), 0, limit()));
      };
      move(ev);
      svg.setPointerCapture(ev.pointerId);
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', () => svg.removeEventListener('pointermove', move), { once: true });
    });
    refs.svg = svg;
    stage.replaceChildren(svg);
    slider.max = limit();
    setNow(now);
  }

  const bandAt = (x) => sc.bands.find(([a, b]) => x >= a && x < b) || sc.bands[sc.bands.length - 1];

  function renderDetail(cur) {
    if (prompt) { detail.replaceChildren(prompt); return; }
    if (cur < 0) { detail.innerHTML = `<p>${sc.intro}</p>`; return; }
    const e = sc.events[cur];
    const tail = cur === sc.events.length - 1 && sc.extra ? `<div class="wv-note">${sc.extra}</div>` : '';
    const n = e.kind === 'fail' || e.kind === 'lost' ? '✗' : String(cur + 1).padStart(2, '0');
    detail.innerHTML = `<h4><span>${n} · ${e.title}</span><span class="where">${LANE_LABEL[e.lane]}</span></h4>${e.body}${tail}${opts.extra?.(cur) || ''}`;
    // words first, code on demand
    const pres = [...detail.querySelectorAll('pre.wv-code')];
    if (pres.length) {
      const d = h('details', null, h('summary', null, 'Show the code'), ...pres);
      detail.append(d);
    }
  }

  function setNow(x) {
    now = clamp(x, 0, limit());
    slider.value = now;
    if (!refs.svg) return;
    refs.cursor.setAttribute('transform', `translate(${L.X(now)},0)`);
    let cur = -1;
    sc.events.forEach((e, k) => {
      const done = e.x <= now + 1e-6;
      refs.dots[k].classList.toggle('is-done', done);
      if (done) cur = k;
    });
    refs.dots.forEach((d, k) => d.classList.toggle('is-cur', k === cur));
    refs.hops.forEach(([p, ex]) => p && p.classList.toggle('is-done', ex <= now + 1e-6));
    const [a, , st] = bandAt(now);
    const c = BAND_CARD[st](a > 0);
    refs.price.textContent = c.price == null ? '—' : inr(c.price);
    refs.price.className = c.cls === 'is-stale' ? 'c-bad' : '';
    refs.cnote.textContent = c.note;
    card.className = `wv-card ${P}buyer${c.cls === 'is-stale' || c.cls === 'is-down' ? ' is-bad' : ''}`;
    rg.el.querySelector('output').textContent = stepOf(now);
    renderDetail(cur);
  }

  function start() {
    if (now >= limit() - 0.01) setNow(0);
    play.textContent = '❚❚ Pause';
    if (REDUCED) {
      playing = setInterval(() => {
        const nx = sc.events.find((e) => e.x > now + 1e-6 && e.x <= limit());
        if (!nx) { stop(); return; }
        setNow(nx.x + 0.001);
      }, 1400);
      return;
    }
    let last = performance.now();
    const tick = (t) => {
      setNow(now + ((t - last) / 1000) * 0.8);
      last = t;
      if (now >= limit() - 0.001) { stop(); return; }
      playing = requestAnimationFrame(tick);
    };
    playing = requestAnimationFrame(tick);
  }
  function stop() {
    if (playing) { cancelAnimationFrame(playing); clearInterval(playing); }
    playing = null;
    play.textContent = '▶ Play';
  }

  onLayout(app, (k) => { kind = k; build(); }, 600);
  return {
    load(next, { at = 0, reveal = Infinity } = {}) { stop(); sc = next; now = at; revealTo = reveal; guess = -1; build(); },
    reveal(x) { revealTo = x; build(); },
    prompt(el) { prompt = el; if (sc && refs.svg) setNow(now); },
    guess(k) { guess = k; build(); },
    setNow(x) { stop(); setNow(x); },
    get now() { return now; },
  };
}

/* ------------------------------------------ Fig. 2: guess, then scrub */

function initChange(fig, app) {
  const SET = NORMAL.events.findIndex((e) => e.tag === 'SET');
  let mode = 'ask'; let guess = -1;
  const skip = h('button', { type: 'button', class: 'wv-btn wv-btn--ghost', onclick: () => { mode = 'watch'; t.prompt(null); } }, 'skip the guess');
  const askEl = h('div', { class: 'wv-callout' },
    h('p', null, h('b', null, 'Guess first. '), `The script has just changed the price to ${inr(NEW)}. At which step does a buyer first see it? Tap a dot.`), skip);
  const t = timeline(fig, app, {
    onDot(k) {
      if (mode !== 'ask') return false;
      guess = k; mode = 'watch';
      t.guess(k);
      t.prompt(h('div', { class: 'wv-callout' }, h('p', null, `You picked step ${k + 1}. Now press play, or drag the time slider, and watch the buyer's card.`)));
      return true;
    },
    onMove() { if (mode === 'watch') t.prompt(null); },
    extra(k) {
      if (k !== SET || guess < 0) return '';
      return guess === SET
        ? `<div class="wv-note"><b>You guessed step ${SET + 1}.</b> The card changes only when the consumer writes the new JSON.</div>`
        : `<div class="wv-note is-bad"><b>You guessed step ${guess + 1}.</b> The card changes only here, at step ${SET + 1}, when the consumer writes the new JSON. Until then Valkey serves the old one.</div>`;
    },
  });
  t.load(NORMAL);
  t.prompt(askEl);
  app.append(key([['look', 'now, and your guess'], ['gap', 'Valkey serves the old price']]));
}

/* ----------------------------------- Fig. 3: delayed or lost? */

const OUTCOMES = [['delayed', 'Delayed: buyers see the old price longer'], ['lost', 'Lost: no part still has the change']];

function initOutage(fig, app) {
  const faultChips = chips(FAULTS.map((f) => [f.key, f.name]), (k) => pick(FAULTS.find((f) => f.key === k)), { value: FAULTS[0].key, label: 'Failure' });
  const slot = h('div');
  let answered = false;
  const t = timeline(fig, app, { top: faultChips.el, below: slot, time: false, onMove() { if (answered) t.prompt(null); } });

  function pick(f) {
    answered = false;
    t.load(f, { at: f.ask, reveal: f.ask });
    t.prompt(h('p', null, 'Answer to see the rest of the timeline.'));
    const q = ask(`${f.intro} What happens to the price change?`, OUTCOMES, f.answer, (v, right) => {
      answered = true;
      t.reveal(Infinity);
      t.setNow(Infinity);
      t.prompt(h('p', null, 'Tap a dot to read that step.'));
      const said = OUTCOMES.find((o) => o[0] === f.answer)[1].split(':')[0].toLowerCase();
      return `<b>${right ? 'Right.' : `It is ${said}.`}</b> ${f.why} ${f.resume}`;
    });
    slot.replaceChildren(q.el);
  }
  pick(FAULTS[0]);
  app.append(key([['gap', 'part down, old price served, or change lost']]));
}

register({ 'hook-sets': initHookSets, 'change-timeline': initChange, 'outage-timeline': initOutage });

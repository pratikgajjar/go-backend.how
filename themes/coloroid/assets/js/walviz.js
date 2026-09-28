/*
 * walviz — interactive diagrams for "One Ring Buffer to ACK Them All".
 *
 * Widgets mount on <figure data-wv="…"> elements rendered by the walviz
 * shortcode. Each figure carries a static fallback image; the widget hides
 * it once it mounts. Loaded only on pages that use the shortcode.
 *
 *   map        system map: locator (data-focus), follow-one-row stepper
 *              (data-follow), numbered failure markers (data-failures)
 *   ring-walk  8-slot ring, out-of-order completion, contiguous walk
 *   ring-sim   live simulator at production sizes (4 × 1,000 slots)
 *   sizing     worker-count explorer: ceil(R × (E + P) / B)
 *   replay     crash after PUT: decode-time key vs LSN-range key
 *
 * Values in the figures come from the audited source (commit 22c3543).
 * LSNs, keys, and timestamps are illustrative.
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let UID = 0;

/* ---------------------------------------------------------------- utils */

function setAttrs(e, a) {
  if (!a) return;
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
}
function add(e, kids) {
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
const h = (tag, a, ...kids) => { const e = document.createElement(tag); setAttrs(e, a); return add(e, kids); };
const s = (tag, a, ...kids) => { const e = document.createElementNS(SVGNS, tag); setAttrs(e, a); return add(e, kids); };
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lsn = (n) => `${Math.floor(n / 2 ** 32).toString(16).toUpperCase()}/${(n % 2 ** 32).toString(16).toUpperCase()}`;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeBack = (t) => { const c = 1.4; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };

function btn(label, onclick, extra = {}) {
  return h('button', { class: 'wv-btn', type: 'button', onclick, ...extra }, label);
}

/** A code listing with optional highlighted lines. `// …` becomes a comment. */
function codeBlock(lines, hot = []) {
  const set = new Set(hot);
  const html = lines.map((ln, i) => {
    let t = esc(ln);
    const c = t.indexOf('//');
    if (c >= 0) t = `${t.slice(0, c)}<span class="cm">${t.slice(c)}</span>`;
    t = t.replace(/⟪(.+?)⟫/g, '<span class="ok">$1</span>').replace(/⟦(.+?)⟧/g, '<span class="bad">$1</span>').replace(/«(.+?)»/g, '<span class="dt">$1</span>');
    return `<span class="ln${set.has(i) ? ' is-hot' : ''}">${t || ' '}</span>`;
  }).join('');
  return `<pre class="wv-code"><code>${html}</code></pre>`;
}

/** Pause work while a figure is off screen. */
function onVisible(el, cb) {
  if (!('IntersectionObserver' in window)) { cb(true); return; }
  new IntersectionObserver((es) => es.forEach((e) => cb(e.isIntersecting)), { threshold: 0.15 }).observe(el);
}

/** Tween helper driven by requestAnimationFrame. */
function tween(ms, fn, done) {
  if (REDUCED || ms <= 0) { fn(1); done?.(); return () => {}; }
  let raf = 0; const t0 = performance.now();
  const loop = (now) => {
    const t = clamp((now - t0) / ms, 0, 1);
    fn(t);
    if (t < 1) raf = requestAnimationFrame(loop); else done?.();
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}

/** Diagonal ink hatch: "work in progress, not yet durable". */
function hatchDefs(id) {
  return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" style="fill:var(--board)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink);stroke-width:1.6"/></pattern>`;
}

/** Colour key row. items: [[keyClass, label], …] */
function colorKey(items) {
  return h('div', { class: 'wv-key' }, ...items.map(([k, label]) => h('span', null, h('i', { class: k }), label)));
}

/* ------------------------------------------------------------- stepper */

/**
 * Named step pills + Back / Play / Next. Keyboard: ← →.
 * onStep(i, prev) renders the state for step i.
 */
function stepper(root, steps, onStep, { interval = 3200 } = {}) {
  let i = -1;
  let timer = null;
  const pills = h('div', { class: 'wv-pills', role: 'group', 'aria-label': 'Steps' });
  const pillEls = steps.map((st, k) => {
    const p = h('button', { class: 'wv-pill', type: 'button', onclick: () => { stop(); go(k); } },
      h('span', { class: 'n' }, String(k + 1).padStart(2, '0')), st.label);
    pills.append(p);
    return p;
  });
  const back = btn('◀ Back', () => { stop(); go(i - 1); }, { 'aria-label': 'Previous step' });
  const play = btn('▶ Play', () => toggle(), { 'aria-pressed': 'false' });
  const next = btn('Next ▶', () => { stop(); go(i + 1); }, { 'aria-label': 'Next step' });
  const pos = h('span', { class: 'wv-pos', 'aria-live': 'polite' });
  const el = h('div', { class: 'wv-bar' }, pills, back, play, pos, h('span', { class: 'wv-sp' }), next);

  function go(n) {
    n = clamp(n, 0, steps.length - 1);
    if (n === i) return;
    const prev = i;
    i = n;
    pillEls.forEach((p, k) => {
      p.classList.toggle('is-past', k < i);
      if (k === i) p.setAttribute('aria-current', 'step'); else p.removeAttribute('aria-current');
    });
    const pr = pills.getBoundingClientRect();
    const er = pillEls[i].getBoundingClientRect();
    if (er.left < pr.left || er.right > pr.right) pills.scrollLeft += er.left - pr.left - pr.width / 3;
    back.disabled = i === 0;
    next.disabled = i === steps.length - 1;
    pos.textContent = `${i + 1} / ${steps.length}`;
    onStep(i, prev);
    if (i === steps.length - 1) stop();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    play.textContent = i === steps.length - 1 ? '↻ Replay' : '▶ Play';
    play.setAttribute('aria-pressed', 'false');
  }
  function toggle() {
    if (timer) { stop(); return; }
    if (i === steps.length - 1) go(0);
    timer = setInterval(() => go(i + 1), interval);
    play.textContent = '❚❚ Pause';
    play.setAttribute('aria-pressed', 'true');
  }
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') { stop(); go(i + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { stop(); go(i - 1); e.preventDefault(); }
  });
  onVisible(root, (v) => { if (!v && timer) stop(); });
  return { el, go, stop, get i() { return i; } };
}

/* ================================================================= MAP */

const MAP_NODES = {
  pg: { a: ['Postgres', 'WAL'], b: ['slot', 'confirmed_flush_lsn', '@lsn'] },
  rep: { a: ['replicator', 'decode pgoutput'], b: ['', 'status update'] },
  evc: { a: ['eventsCh', 'chan · cap 4,000'] },
  ring: { a: ['ring', '8,000 slots'] },
  seg: { a: ['segments', 'chan Segment'] },
  wrk: { a: ['workers ×4', 'Parquet + PUT'] },
  s3: { a: ['S3', 'PutObject'], b: ['objects', '@obj'] },
  ackseg: { a: ['ackSeg', 'chan Segment'] },
  walk: { a: ['walker', 'findHighestContiguous'] },
  ackch: { a: ['acked', 'ack.Position'] },
};

const MAP_EDGES = [
  ['d1', 'pg', 'rep', 'data'], ['d2', 'rep', 'evc', 'data'], ['d3', 'evc', 'ring', 'data'],
  ['d4', 'ring', 'seg', 'data'], ['d5', 'seg', 'wrk', 'data'], ['d6', 'wrk', 's3', 'data'],
  ['a1', 'wrk', 'ackseg', 'ack'], ['a2', 'ackseg', 'walk', 'ack'], ['a3', 'walk', 'ackch', 'ack'],
  ['a4', 'ackch', 'rep', 'ack'], ['a5', 'rep', 'pg', 'ack'], ['x1', 'ring', 'walk', 'ctl'],
];

const MAP_LAYOUT = {
  wide: {
    vb: [960, 282], split: 'v',
    proc: [136, 22, 682, 246], procLabel: [146, 16],
    nodes: {
      pg: [4, 40, 128, 210], rep: [152, 40, 120, 210], evc: [305, 60, 100, 50], ring: [440, 60, 100, 50],
      seg: [575, 60, 90, 50], wrk: [700, 60, 100, 50], s3: [840, 40, 110, 210],
      ackseg: [700, 180, 100, 50], walk: [450, 180, 140, 50], ackch: [305, 180, 100, 50],
    },
    edges: {
      d1: [[132, 85], [152, 85]], d2: [[272, 85], [305, 85]], d3: [[405, 85], [440, 85]],
      d4: [[540, 85], [575, 85]], d5: [[665, 85], [700, 85]], d6: [[800, 85], [840, 85]],
      a1: [[750, 110], [750, 180]], a2: [[700, 205], [590, 205]], a3: [[450, 205], [405, 205]],
      a4: [[305, 205], [272, 205]], a5: [[152, 205], [132, 205]], x1: [[490, 110], [490, 180]],
    },
    labels: [['readIdx', 497, 148, 'start', 't-mute'], ['PUT', 820, 78, 'middle', ''], ['ACK', 142, 198, 'middle', 't-safe t-b']],
    durable: [[68, 272], [895, 272]],
  },
  tall: {
    vb: [360, 590], split: 'h',
    proc: [4, 96, 352, 398], procLabel: [350, 488], procShort: true,
    nodes: {
      pg: [10, 10, 340, 70], rep: [14, 112, 332, 56], evc: [20, 196, 150, 44], ring: [20, 268, 150, 44],
      seg: [20, 340, 150, 44], wrk: [20, 412, 150, 44], s3: [10, 510, 340, 70],
      ackseg: [190, 412, 150, 44], walk: [190, 268, 150, 44], ackch: [190, 196, 150, 44],
    },
    edges: {
      d1: [[95, 80], [95, 112]], d2: [[95, 168], [95, 196]], d3: [[95, 240], [95, 268]],
      d4: [[95, 312], [95, 340]], d5: [[95, 384], [95, 412]], d6: [[95, 456], [95, 510]],
      a1: [[170, 434], [190, 434]], a2: [[265, 412], [265, 312]], a3: [[265, 268], [265, 240]],
      a4: [[265, 196], [265, 168]], a5: [[265, 112], [265, 80]], x1: [[170, 290], [190, 290]],
    },
    labels: [['PUT', 101, 488, 'start', ''], ['ACK', 271, 100, 'start', 't-safe t-b']],
    durable: [],
  },
};

/* Items match the numbered failure list in the article, in order. */
const FAILS = [
  ['s3', 'Crash after a successful PUT', 'The slot has not moved, so Postgres resends the rows and a second file holds them. Delivery is at-least-once.'],
  ['rep', 'Segment ends inside a transaction', 'The ACK is a change LSN, so after a restart Postgres resends that whole transaction, including rows already in S3.'],
  ['wrk', 'Upload fails three times', 'log.Fatal. On restart the slot replays everything after the last ACK.'],
  ['ring', 'Ring is full', 'The receiver waits for free space and eventsCh fills. The replicator blocks; after a minute /ready fails.'],
  ['rep', 'Replicator blocked for 60 s', 'No status updates while blocked, so Postgres drops the connection after wal_sender_timeout. WAL Cake reconnects from the slot.'],
  ['pg', 'Walsender killed or failover', 'The session ends; WAL Cake reconnects with backoff from confirmed_flush_lsn. /ready fails until it streams again.'],
  ['rep', 'TRUNCATE arrives', 'Logged only. The data lake never sees it.'],
  ['rep', 'Unchanged TOAST value', 'pgoutput sends a marker, and the row image stores the string "<TOAST>" instead of the value.'],
];

/* --- follow one row: pgoutput bytes for the sample INSERT --- */
function be(n, bytes) {
  const out = [];
  let v = BigInt(n);
  for (let i = 0; i < bytes; i++) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return out;
}
const utf8 = (t) => [...new TextEncoder().encode(t)];

const ROW = {
  walStart: 0x16B3748,
  serverEnd: 0x16C2F30,
  relid: 16417,
  cols: [['id', '9812'], ['ref', 'PAY-7F3K'], ['amount', '1250.00'], ['status', 'captured']],
  prevAck: 0x16A2F10,
  prefixLsn: 0x16C1A08,
};
function xlogFields() {
  const sendUs = (Date.UTC(2026, 4, 9, 6, 30, 45, 124) - Date.UTC(2000, 0, 1)) * 1000;
  const f = [
    ['h', "'w' XLogData", [0x77]],
    ['h', `WALStart ${lsn(ROW.walStart)}`, be(ROW.walStart, 8)],
    ['h', `ServerWALEnd ${lsn(ROW.serverEnd)}`, be(ROW.serverEnd, 8)],
    ['h', 'SendTime, µs since 2000-01-01', be(sendUs, 8)],
    ['p', "'I' Insert", [0x49]],
    ['p', `relation OID ${ROW.relid}`, be(ROW.relid, 4)],
    ['p', "'N' new tuple", [0x4e]],
    ['p', `${ROW.cols.length} columns`, be(ROW.cols.length, 2)],
  ];
  for (const [name, val] of ROW.cols) {
    f.push(['p', "'t' text value", [0x74]]);
    f.push(['p', `length ${utf8(val).length}`, be(utf8(val).length, 4)]);
    f.push(['v', `${name} = '${val}'`, utf8(val)]);
  }
  return f;
}
const PAYLOAD = xlogFields().filter((x) => x[0] !== 'h').reduce((n, x) => n + x[2].length, 0);
const ROW_LSN = ROW.walStart;

function hexDump() {
  const spans = xlogFields().map(([cls, label, bytes]) =>
    `<span class="fld ${cls}" tabindex="0" title="${esc(label)}" data-l="${esc(label)}">${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}</span>`).join(' ');
  return `<div class="wv-hex"><div class="row">${spans}</div></div>
  <div class="wv-legend"><span><i style="background:var(--tint2)"></i>XLogData header</span><span><i style="background:var(--board)"></i>pgoutput Insert</span><span><i style="background:var(--brown-l);border-color:var(--brown)"></i>column values</span><span class="hexlabel">Tap a field.</span></div>`;
}

const FOLLOW = [
  {
    label: 'Commit', at: ['pg', 'a'], via: [], token: 'row', chip: 'row 9812',
    title: 'A row commits in Postgres', where: 'payments · primary',
    body: () => `${codeBlock([
      'BEGIN;',
      'INSERT INTO payments (id, ref, amount, status)',
      "VALUES («9812», «'PAY-7F3K'», «1250.00», «'captured'»);",
      'COMMIT;',
    ])}<p>The row is <span class="c-safe">durable in the WAL</span>. The slot holds WAL from <code>${lsn(ROW.prevAck)}</code> onward, so Postgres keeps this row's WAL too.</p>`,
  },
  {
    label: 'Decode', at: ['rep', 'a'], via: ['d1'], token: 'row', chip: 'XLogData',
    title: 'pgoutput sends one XLogData frame', where: 'internal/replication/pg_replicator.go',
    body: () => `${hexDump()}${codeBlock([
      'xld, err := pglogrepl.ParseXLogData(data[1:])',
      'logicalMsg, err := pglogrepl.Parse(xld.WALData)',
      'r.proccessLogicalMsg(ctx, logicalMsg, xld.WALStart, ch)',
      `// WALStart = «${lsn(ROW.walStart)}», the LSN of this change`,
    ], [2, 3])}<p>The earlier <code>RelationMessage</code> for OID ${ROW.relid} maps the four columns. A row event keeps its change LSN; a commit event gets <code>TransactionEndLSN</code>.</p>`,
  },
  {
    label: 'Event', at: ['evc', 'a'], via: ['d2'], token: 'row', chip: '*CDCEvent',
    title: 'The decoder builds one heap object', where: 'internal/model/cdc_event.go',
    body: () => `${codeBlock([
      'ev := &model.CDCEvent{',
      '    Table:     «"payments"»,',
      '    Operation: «"insert"»,',
      '    After: map[string]any{',
      '        "id": «int64(9812)», "ref": «"PAY-7F3K"»,',
      '        "amount": «1250.0»,      // NUMERIC → float64',
      '        "status": «"captured"»,',
      '    },',
      '    Timestamp:  time.Now(),     // decode time',
      '    CommitTime: r.commitTime,   // from BEGIN: picks the day folder',
      `    LSN:       «0x${ROW_LSN.toString(16).toUpperCase()}»,        // ${lsn(ROW_LSN)}`,
      '}',
      'ch <- ev                      // eventsCh: blocks when 4,000 are queued',
    ], [5, 9, 10])}`,
  },
  {
    label: 'Admit', at: ['ring', 'a'], via: ['d3'], token: 'row', chip: 'slot 2143',
    title: 'Add stores one pointer in the ring', where: 'RingBuffer.Add',
    body: () => `${codeBlock([
      'w := rb.writeIdx.Load()                // 2143',
      'if w-rb.readIdx.Load() >= rb.size {    // 2143 − 2000 = 143 < 8000',
      '    return false',
      '}',
      'rb.buffer[w%rb.size] = event          // buffer[«2143»]',
      'rb.writeIdx.Add(1)                     // 2144',
    ], [0, 1, 4, 5])}<p>One goroutine calls <code>Add</code>. It is the only writer, so it needs no mutex and no compare-and-swap.</p>`,
  },
  {
    label: 'Cut', at: ['seg', 'a'], via: ['d4'], token: 'row', chip: 'S[2000,3000)',
    title: 'writeIdx reaches 3000: the receiver cuts a segment', where: 'RingBuffer.checkForNewSegment',
    body: () => `${codeBlock([
      'segment := Segment{StartIdx: «2000», EndIdx: «3000»}',
      'rb.lastSegIdx.Store(3000)',
      'rb.tracker.Set(2000, &segment)         // registered before dispatch',
      'rb.segments <- segment',
    ], [2])}<p>Our row is event 2143 of <code>[2000, 3000)</code>. The tracker knows this range before any worker sees it. The segment copies no events.</p>`,
  },
  {
    label: 'Encode', at: ['wrk', 'a'], via: ['d5'], token: 'row', chip: 'W2 · parquet',
    title: 'Worker W2 writes one Parquet row group', where: 'ParquetBatchProcessor.Process',
    body: () => `${codeBlock([
      '// collect 1,000 pointers from buffer[2000..2999]; drop commit events',
      'table      BYTE_ARRAY  dictionary + ZSTD   «"payments"»',
      'operation  BYTE_ARRAY  dictionary + ZSTD   «"insert"»',
      'timestamp  INT64       delta + ZSTD',
      `lsn        INT64       delta + ZSTD        «${ROW_LSN}»`,
      'before     BYTE_ARRAY  plain + ZSTD        ⟦(empty bytes)⟧',
      'after      BYTE_ARRAY  plain + ZSTD        «{"amount":1250,"id":9812,…}»',
    ], [4, 6])}<p>Encoding 1,000 events takes about 1.2 ms and allocates about 2.8 MB, with pooled ZSTD encoders.</p>`,
  },
  {
    label: 'PUT', at: ['s3', 'a'], via: ['d6'], token: 'row', chip: '200 OK', obj: true,
    title: 'One PutObject per date slice', where: 'S3Uploader.UploadBytes',
    body: () => `${codeBlock([
      'PutObject',
      '  Key:  «cdc/2026/05/09/1778308245891204-7.ZSTD.parquet»',
      '  Body: 13 KB',
      '⟪200 OK⟫',
    ], [1])}<p>The folder is the UTC commit date. The file name is the <b>last</b> event's decode time plus a sequence number. The row is now <span class="c-safe">durable in S3</span>, but the slot has not moved. <span class="c-bad">A crash here replays the row.</span></p>`,
  },
  {
    label: 'Walk', at: ['walk', 'a'], from: ['wrk', 'a'], via: ['a1', 'a2'], token: 'seg', chip: 'Segment{2000,3000}', obj: true,
    title: 'The walker crosses the finished prefix', where: 'RingBuffer.handleSegmentAck',
    body: () => `${codeBlock([
      'rb.ackSeg <- segment                    // worker → walker',
      'findHighestContiguous(2000, 2000)',
      '    tracker[2000].done = true',
      '    2000 == readIdx  → cross → read = 3000',
      '    tracker[3000] still running → stop',
      `lastEvent := rb.buffer[2999 % 8000]     // LSN «${lsn(ROW.prefixLsn)}»`,
      'rb.readIdx.Store(3000)                  // after the read',
      'rb.acked.Advance(lastEvent.LSN)',
    ], [3, 5, 6, 7])}<p>Earlier segments were already done, so the cursor crosses this one. The ACK position becomes the LSN of event 2999, the last event in the prefix.</p>`,
  },
  {
    label: 'Status', at: ['rep', 'b'], via: ['a3', 'a4'], token: 'ack', chip: lsn(ROW.prefixLsn), obj: true,
    title: 'One cumulative LSN goes to Postgres', where: 'pgReplicator.SendStandbyStatusUpdate',
    body: () => `${codeBlock([
      `lsn := acked.Load()                   // ${lsn(ROW.prefixLsn)}, read every loop`,
      `r.lastAckedLSN = ${lsn(ROW.prefixLsn)}`,
      'StandbyStatusUpdate{',
      `    WALWritePosition: ${lsn(ROW.prefixLsn)},`,
      `    WALFlushPosition: ${lsn(ROW.prefixLsn)},`,
      `    WALApplyPosition: ${lsn(ROW.prefixLsn)},`,
      '}',
    ], [4])}<p>The ACK names the end of the prefix, not our row. One number covers all 1,000 events.</p>`,
  },
  {
    label: 'Forget', at: ['pg', 'b'], via: ['a5'], token: 'ack', chip: lsn(ROW.prefixLsn), obj: true, acked: true,
    title: 'The slot advances: permission to forget', where: 'pg_replication_slots',
    body: () => `${codeBlock([
      'SELECT confirmed_flush_lsn FROM pg_replication_slots;',
      ' confirmed_flush_lsn',
      '---------------------',
      ` ⟪${lsn(ROW.prefixLsn)}⟫`,
    ])}<p>Our row at <code>${lsn(ROW_LSN)}</code> is now behind the slot. <span class="c-safe">This slot no longer holds that WAL</span>, and a later checkpoint can recycle it.</p>`,
  },
];

function initMap(fig) {
  const app = fig.querySelector('.wv-app');
  const focus = (fig.dataset.focus || '').split(',').map((x) => x.trim()).filter(Boolean);
  const follow = fig.dataset.follow === 'true';
  const failures = fig.dataset.failures === 'true';
  const uid = `wv${++UID}`;
  const stage = h('div');
  app.append(stage);

  let L = null;
  let svg; let tokenG; let lsnText; let objText;
  let step = -1;
  let cancelMove = () => {};
  let sel = -1;
  const nodeEls = {}; const edgeEls = {}; const markEls = [];

  const note = failures ? h('div', { class: 'wv-note', 'aria-live': 'polite' }) : null;
  const insp = follow ? h('div', { class: 'wv-insp', 'aria-live': 'polite' }) : null;

  function sections(id) {
    const [x, y, w, hh] = L.nodes[id];
    const sp = MAP_NODES[id];
    if (!sp.b) return { a: { x, y, w, h: hh, lines: sp.a } };
    if (L.split === 'v') return { a: { x, y, w, h: hh / 2, lines: sp.a }, b: { x, y: y + hh / 2, w, h: hh / 2, lines: sp.b } };
    return { a: { x, y, w: w / 2, h: hh, lines: sp.a }, b: { x: x + w / 2, y, w: w / 2, h: hh, lines: sp.b } };
  }
  const center = ([id, part]) => { const sc = sections(id)[part] || sections(id).a; return [sc.x + sc.w / 2, sc.y + sc.h / 2]; };

  function build() {
    const [W, H] = L.vb;
    svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.getAttribute('aria-label') || 'WAL Cake system map' });
    svg.append(s('defs', null,
      s('marker', { id: `${uid}-a`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M0,0 L8,4 L0,8 z', style: 'fill:var(--ink)' })),
      s('marker', { id: `${uid}-b`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M0,0 L8,4 L0,8 z', style: 'fill:var(--green)' }))));

    const [px, py, pw, ph] = L.proc;
    svg.append(s('rect', { x: px, y: py, width: pw, height: ph, class: 'rule dash', rx: 2 }));
    svg.append(L.procShort
      ? s('text', { x: L.procLabel[0], y: L.procLabel[1], class: 't-xs t-up t-b', 'text-anchor': 'end' }, 'wal-cake ', s('tspan', { class: 't-bad' }, '· memory, lost on crash'))
      : s('text', { x: L.procLabel[0], y: L.procLabel[1], class: 't-xs t-up t-b' }, 'wal-cake · one Go process ', s('tspan', { class: 't-bad' }, '· memory, lost on crash')));
    for (const [x, y] of L.durable) svg.append(s('text', { x, y, class: 't-xs t-safe t-up t-b', 'text-anchor': 'middle' }, 'durable'));

    const eg = s('g');
    for (const [id, from, to, kind] of MAP_EDGES) {
      const pts = L.edges[id];
      const cls = kind === 'data' ? 'edge' : kind === 'ack' ? 'edge-ack' : 'edge-ctl';
      const p = s('path', {
        d: `M${pts.map((q) => q.join(',')).join(' L')}`, class: cls,
        'marker-end': kind === 'ctl' ? null : `url(#${uid}-${kind === 'ack' ? 'b' : 'a'})`,
        'marker-start': kind === 'ctl' ? null : null,
      });
      p.dataset.from = from; p.dataset.to = to;
      edgeEls[id] = p;
      eg.append(p);
    }
    svg.append(eg);
    for (const [t, x, y, a, c] of L.labels) svg.append(s('text', { x, y, class: `t-xs ${c}`, 'text-anchor': a }, t));

    for (const id of Object.keys(MAP_NODES)) {
      const [x, y, w, hh] = L.nodes[id];
      const g = s('g', { class: 'node', 'data-id': id });
      if (id === 'wrk') {
        g.append(s('rect', { x: x + 6, y: y - 6, width: w, height: hh, class: 'box' }));
        g.append(s('rect', { x: x + 3, y: y - 3, width: w, height: hh, class: 'box' }));
      }
      g.append(s('rect', { x, y, width: w, height: hh, class: 'box' }));
      const sc = sections(id);
      if (sc.b) {
        g.append(L.split === 'v'
          ? s('line', { x1: x, x2: x + w, y1: sc.b.y, y2: sc.b.y, class: 'rule' })
          : s('line', { x1: sc.b.x, x2: sc.b.x, y1: y, y2: y + hh, class: 'rule' }));
      }
      for (const part of Object.values(sc)) {
        const lines = part.lines.filter((t, k) => t || k > 0).filter((t) => t !== '');
        const heights = lines.map((t, k) => (k === 0 && part.lines[0] ? 15 : 12.5));
        let yy = part.y + part.h / 2 - heights.reduce((a, b) => a + b, 0) / 2;
        lines.forEach((t, k) => {
          const isTitle = k === 0 && part.lines[0];
          yy += heights[k];
          const cls = t === '@lsn' ? 't-s t-b t-safe' : t === '@obj' ? 't-s t-b t-data' : isTitle ? 't-m t-b' : 't-xs t-mute';
          const te = s('text', { x: part.x + part.w / 2, y: yy - 3.5, class: cls, 'text-anchor': 'middle' },
            t === '@lsn' ? lsn(ROW.prevAck) : t === '@obj' ? '—' : t);
          if (t === '@lsn') lsnText = te;
          if (t === '@obj') objText = te;
          g.append(te);
        });
      }
      nodeEls[id] = g;
      svg.append(g);
    }

    if (failures) {
      const per = {}; const total = {};
      FAILS.forEach(([node]) => { total[node] = (total[node] || 0) + 1; });
      FAILS.forEach(([node], k) => {
        const n = per[node] = (per[node] || 0) + 1;
        const [x, y, w] = node === 'proc' ? L.proc : L.nodes[node];
        const cx = x + w - 12 - (total[node] - n) * 20;
        const cy = y;
        const m = s('g', { class: 'mark', tabindex: 0, role: 'button', 'aria-label': `Failure ${k + 1}: ${FAILS[k][1]}` },
          s('circle', { cx, cy, r: 8 }), s('text', { x: cx, y: cy + 3.2, 'text-anchor': 'middle' }, String(k + 1)));
        m.addEventListener('click', () => pick(k));
        m.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(k); e.preventDefault(); } });
        m.addEventListener('mouseenter', () => pick(k));
        markEls[k] = m;
        svg.append(m);
      });
    }

    tokenG = s('g', { class: 'token', style: 'display:none' });
    tokenG.append(s('rect', { x: 0, y: -10, height: 20, rx: 2 }), s('text', { x: 0, y: 4, class: 't-s t-b', 'text-anchor': 'middle' }));
    svg.append(tokenG);
    stage.replaceChildren(svg);
  }

  function pick(k) {
    sel = k;
    markEls.forEach((m, j) => m.classList.toggle('is-on', j === k));
    const [node, what, effect] = FAILS[k];
    Object.entries(nodeEls).forEach(([id, g]) => {
      g.classList.toggle('is-bad', id === node);
      g.classList.toggle('is-dim', id !== node && node !== 'proc');
    });
    note.className = 'wv-note is-bad';
    note.innerHTML = `<span class="k">#${k + 1}</span><b>${esc(what)}.</b> ${esc(effect)}`;
  }

  function applyFocus() {
    if (!focus.length) {
      if (!follow && !failures) Object.values(edgeEls).forEach((e) => { if (!e.classList.contains('edge-ctl')) e.classList.add('flow'); });
      return;
    }
    Object.entries(nodeEls).forEach(([id, g]) => g.classList.add(focus.includes(id) ? 'is-focus' : 'is-dim'));
    Object.values(edgeEls).forEach((e) => {
      const on = focus.includes(e.dataset.from) && focus.includes(e.dataset.to);
      e.classList.add(on ? 'flow' : 'is-dim');
    });
  }

  function chip(kind, text) {
    const r = tokenG.firstChild; const t = tokenG.lastChild;
    const w = text.length * 6.6 + 14;
    r.setAttribute('x', -w / 2); r.setAttribute('width', w);
    r.setAttribute('style', kind === 'row' ? 'fill:var(--brown-l);stroke:var(--brown)' : kind === 'seg' ? 'fill:var(--ink);stroke:var(--ink)' : 'fill:var(--green);stroke:var(--green)');
    t.setAttribute('style', kind === 'row' ? 'fill:var(--brown)' : 'fill:var(--board)');
    t.textContent = text;
    tokenG.style.display = '';
  }
  const place = ([x, y]) => tokenG.setAttribute('transform', `translate(${x},${y})`);
  /* the token rides on the top edge of the section, clear of its title */
  const perch = (at) => { const sc = sections(at[0])[at[1]] || sections(at[0]).a; return [sc.x + sc.w / 2, sc.y]; };

  function along(pts, t) {
    const seg = []; let total = 0;
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
    let want = t * total;
    for (let i = 0; i < seg.length; i++) {
      if (want <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? want / seg[i] : 1;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
      }
      want -= seg[i];
    }
    return pts[pts.length - 1];
  }

  function showStep(i, prev, animate) {
    step = i;
    const st = FOLLOW[i];
    Object.entries(nodeEls).forEach(([id, g]) => { g.classList.toggle('is-focus', id === st.at[0]); g.classList.remove('is-dim'); });
    Object.entries(edgeEls).forEach(([id, e]) => e.classList.toggle('flow', st.via.includes(id)));
    lsnText.textContent = lsn(st.acked ? ROW.prefixLsn : ROW.prevAck);
    objText.textContent = st.obj ? '+1 .parquet' : '—';
    chip(st.token, st.chip);
    cancelMove();
    const end = perch(st.at);
    if (animate && prev === i - 1 && prev >= 0) {
      const start = perch(st.from || FOLLOW[prev].at);
      const pts = [start, ...st.via.flatMap((id) => L.edges[id]), end];
      cancelMove = tween(900, (t) => place(along(pts, ease(t))));
    } else place(end);
    insp.innerHTML = `<h4><span>${String(i + 1).padStart(2, '0')} · ${esc(st.title)}</span><span class="where">${esc(st.where)}</span></h4>${st.body()}`;
    const hl = insp.querySelector('.hexlabel');
    insp.querySelectorAll('.fld').forEach((f) => {
      const show = () => { hl.textContent = f.dataset.l; insp.querySelectorAll('.fld').forEach((o) => o.classList.toggle('is-hot', o === f)); };
      f.addEventListener('mouseenter', show); f.addEventListener('focus', show);
    });
  }

  function render() {
    const next = app.clientWidth < 600 ? MAP_LAYOUT.tall : MAP_LAYOUT.wide;
    if (next === L) return;
    L = next;
    build();
    applyFocus();
    if (follow && step >= 0) showStep(step, -1, false);
    if (failures && sel >= 0) pick(sel);
  }

  render();
  new ResizeObserver(render).observe(app);

  if (failures) {
    app.append(colorKey([['k-gap', 'fault site'], ['k-line-ink', 'data'], ['k-line-green', 'ACK']]), h('div', { style: 'height:.6rem' }), note);
    note.innerHTML = '<span class="k">Faults</span>Tap a red marker. Numbers match the list below.';
  }
  if (follow) {
    const st = stepper(fig, FOLLOW, (i, prev) => showStep(i, prev, true), { interval: 3800 });
    app.prepend(st.el);
    app.append(colorKey([['k-line-ink', 'data path'], ['k-line-green', 'ACK path'], ['k-data', 'the sample row'], ['k-look', 'this step']]), insp);
    st.go(0);
  } else if (!failures && !focus.length) {
    app.append(colorKey([['k-line-ink', 'data path'], ['k-line-green', 'ACK path']]));
  }
}

/* ============================================================ RING WALK */

const RW = { size: 8, batch: 2 };
const evLsn = (k) => 0x1A000 + k * 0x40; // e1 → 0/1A040
const ADD_CODE = [
  'func (rb *RingBuffer) Add(event *model.CDCEvent) bool {',
  '    w := rb.writeIdx.Load()',
  '    if w-rb.readIdx.Load() >= rb.size {',
  '        return false',
  '    }',
  '    rb.buffer[w%rb.size] = event',
  '    rb.writeIdx.Add(1)',
  '    return true',
  '}',
];
const CUT_CODE = [
  '// receiver, right after Add (abridged)',
  'if writeIdx-lastSegIdx >= batchSize {',
  '    segment := Segment{StartIdx: lastSegPos, EndIdx: writePos}',
  '    rb.lastSegIdx.Store(writePos)',
  '    rb.tracker.Set(segment.StartIdx, &segment)',
  '    rb.segments <- segment',
  '}',
];
const WALK_CODE = [
  'func (rb *RingBuffer) findHighestContiguous(start, read int64) int64 {',
  '    s, ok := rb.tracker.Get(start)',
  '    if !ok { return read }',
  '    s.done = true',
  '    if s.StartIdx == read {',
  '        cur := s',
  '        for cur.done {',
  '            rb.tracker.Del(cur.StartIdx)',
  '            read = cur.EndIdx',
  '            next, ok := rb.tracker.Get(cur.EndIdx)',
  '            if !ok { break }',
  '            cur = next',
  '        }',
  '    }',
  '    return read',
  '}',
];

function ringWalkSteps() {
  const out = [];
  const st = { w: 0, s: 0, r: 0, segs: [], ack: null, wait: null, gone: [], del: [], fresh: [] };
  const snap = (label, code, hot, note, tone) => {
    out.push({ ...JSON.parse(JSON.stringify(st)), label, code, hot, note, tone });
    st.gone = []; st.del = []; st.fresh = [];
  };
  const seg = (id) => st.segs.find((x) => x.id === id);
  const cut = (id, start, wk) => { st.segs.push({ id, start, end: start + RW.batch, st: 'run', wk }); st.fresh.push(id); };
  const cross = (id) => { const x = seg(id); x.st = 'gone'; st.r = x.end; st.gone.push([x.start, x.end]); st.del.push(id); };

  snap('Empty', 'add', [],
    'Eight slots keep the picture small. (The real ring has <b>2 × concurrency × batchSize</b> slots.) <code>writeIdx</code>, <code>lastSegIdx</code>, and <code>readIdx</code> start at 0 and only move forward.');
  st.w = 8;
  snap('Admit', 'add', [1, 2, 5, 6],
    'The receiver calls <code>Add</code> for e1–e8. Each call writes <code>buffer[w % 8]</code>, then increments <code>writeIdx</code>. The single writer needs no lock.');
  st.s = 8;
  cut('S1', 0, 'W1'); cut('S2', 2, 'W2'); cut('S3', 4, 'W3'); cut('S4', 6, 'W4');
  snap('Cut', 'cut', [2, 3, 4, 5],
    'Every two events become a segment. The receiver registers each range in <code>tracker</code> <b>before</b> it sends the range to a worker. (The code cuts each segment right after its second <code>Add</code>; this view groups the cuts.)');
  st.wait = 'e9';
  snap('Full', 'add', [1, 2, 3],
    'e9 arrives. <code>w − r = 8 − 0 = 8 ≥ size</code>, so <code>Add</code> returns false. The receiver waits until the walker signals free space. <b>No slot is overwritten.</b>', 'bad');
  seg('S2').st = 'held';
  snap('S2 done', 'walk', [1, 3, 4, 14],
    'W2 finishes first. The walker marks S2 done. S2 starts at 2, but <code>readIdx</code> is 0. <b class="c-bad">S1 is a gap.</b> The cursor stays, and no ACK is sent.', 'bad');
  seg('S4').st = 'held';
  snap('S4 done', 'walk', [1, 3, 4, 14],
    'W4 finishes. S4 is done too, still behind the gap at S1 and S3. Two segments are durable in S3, yet Postgres keeps all of their WAL.');
  seg('S1').st = 'held';
  snap('S1 done', 'walk', [1, 3, 4, 5, 6],
    'W1 finishes. S1 starts at <code>readIdx</code> 0, so the walk begins.');
  cross('S1');
  snap('Cross S1', 'walk', [7, 8, 9, 11],
    'Delete S1 from the tracker. <code>read = 2</code>. The next entry, S2 at index 2, is already done, so the loop continues.');
  cross('S2');
  st.ack = 4;
  snap('Cross S2', 'walk', [6, 7, 8, 9, 14],
    'Delete S2. <code>read = 4</code>. S3 at index 4 is still running, so the loop stops at the new gap. <code>readIdx = 4</code>. <b class="c-safe">The ACK sends <code>buffer[3].LSN</code> = LSN(e4).</b>', 'good');
  st.wait = null;
  st.w = 12; st.s = 12;
  cut('S5', 8, 'W1'); cut('S6', 10, 'W2');
  snap('Wrap', 'add', [5, 6],
    'The walker moved <code>readIdx</code> and signalled the receiver. e9 goes to <code>buffer[8 % 8] = buffer[0]</code>. Logical indices keep growing; only the physical slot wraps. S5 and S6 go to the idle W1 and W2.');
  seg('S3').st = 'held';
  cross('S3'); cross('S4');
  st.ack = 8;
  snap('S3 done', 'walk', [4, 6, 7, 8, 9, 11, 14],
    'W3 finishes. One call crosses S3 <b>and</b> the waiting S4. <code>readIdx = 8</code>. S5 is still running, so the walk stops. <b class="c-safe">The ACK is LSN(e8).</b>', 'good');
  return out;
}

function initRingWalk(fig) {
  const app = fig.querySelector('.wv-app');
  const steps = ringWalkSteps();
  const N = RW.size;
  const C = 200; const R0 = 104; const R1 = 152;
  const ang = (i) => (i / N) * 360; // logical index → degrees (unbounded)
  const pt = (deg, r) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)];

  const hid = `wvh${++UID}`;
  const svg = s('svg', { viewBox: '0 0 400 400', role: 'img', 'aria-label': 'Eight-slot ring buffer with three cursors' });
  const defs = s('defs'); defs.innerHTML = hatchDefs(hid);
  const gSlots = s('g'); const gSegs = s('g'); const gHands = s('g'); const gOver = s('g');
  svg.append(defs, gSlots, gSegs, gHands, gOver);

  // static slot geometry
  const slotEls = [];
  for (let j = 0; j < N; j++) {
    const a0 = ang(j) + 0.8; const a1 = ang(j + 1) - 0.8;
    const [x0, y0] = pt(a0, R1); const [x1, y1] = pt(a1, R1); const [x2, y2] = pt(a1, R0); const [x3, y3] = pt(a0, R0);
    const path = s('path', { d: `M${x0},${y0} A${R1},${R1} 0 0 1 ${x1},${y1} L${x2},${y2} A${R0},${R0} 0 0 0 ${x3},${y3} Z`, class: 'anim f-free', style: 'stroke:var(--ink);stroke-width:1.3' });
    const [tx, ty] = pt(ang(j + 0.5), 133);
    const [ix, iy] = pt(ang(j + 0.5), 114);
    const name = s('text', { x: tx, y: ty + 5, class: 't-l t-b anim', 'text-anchor': 'middle' });
    const idx = s('text', { x: ix, y: iy + 3, class: 't-xs t-mute halo', 'text-anchor': 'middle' }, `[${j}]`);
    gSlots.append(path, name, idx);
    slotEls.push({ path, name });
  }
  gSlots.append(s('circle', { cx: C, cy: C, r: 4, style: 'fill:var(--ink)' }));

  // hands: tweened in JS so labels stay upright
  const HANDS = [
    { key: 'r', label: 'readIdx', len: 98, lab: 44, cls: 'stroke:var(--green);stroke-width:3.5', txt: 't-safe t-b' },
    { key: 's', label: 'lastSegIdx', len: 98, lab: 64, cls: 'stroke:var(--mute);stroke-width:1.4;stroke-dasharray:3 3', txt: 't-mute t-b' },
    { key: 'w', label: 'writeIdx', len: 98, lab: 84, cls: 'stroke:var(--ink);stroke-width:2', txt: 't-b' },
  ];
  const handEls = HANDS.map((hd) => {
    const line = s('line', { x1: C, y1: C, style: hd.cls, 'stroke-linecap': 'round' });
    const tip = s('circle', { r: 3, style: hd.key === 'r' ? 'fill:var(--green)' : 'fill:var(--ink)' });
    const t = s('text', { class: `t-xs ${hd.txt}`, 'text-anchor': 'middle' }, hd.key);
    gHands.append(line, tip, t);
    return { ...hd, line, tip, t, cur: 0 };
  });
  const setHand = (hd, deg) => {
    hd.cur = deg;
    const [x, y] = pt(deg, hd.len); const [lx, ly] = pt(deg, hd.lab);
    hd.line.setAttribute('x2', x); hd.line.setAttribute('y2', y);
    hd.tip.setAttribute('cx', x); hd.tip.setAttribute('cy', y);
    const [ox, oy] = pt(deg + 90, 7);
    hd.t.setAttribute('x', lx + (ox - C)); hd.t.setAttribute('y', ly + (oy - C) + 3);
  };
  handEls.forEach((hd) => setHand(hd, 0));
  let cancelHands = () => {};

  // side panel
  const stats = h('dl', { class: 'wv-kv' });
  const tracker = h('div');
  const code = h('div');
  const wal = h('div', { class: 'wv-wal' });
  const legend = colorKey([['k-data', 'admitted event'], ['k-run', 'PUT in flight'], ['k-held', 'in S3, waiting'], ['k-safe', 'reclaimed'], ['k-gap', 'the gap']]);
  legend.append(h('span', null, h('b', { class: 'c-safe' }, 'r'), ' readIdx · ', h('b', null, 'w'), ' writeIdx · ', h('b', { style: 'color:var(--mute)' }, 's'), ' lastSegIdx'));
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const left = h('div', null, svg, legend);
  const right = h('div', null, stats, h('div', { style: 'height:.6rem' }), tracker, h('div', { style: 'height:.6rem' }), code);
  const walBox = h('div', { style: 'margin-top:.8rem' },
    h('div', { class: 'wv-title', style: 'margin-bottom:.35rem' }, 'Postgres WAL: ', h('span', { class: 'c-data' }, 'held by the slot'), ' / ', h('span', { class: 'c-safe' }, 'free to recycle')), wal);

  function segOf(state, L) { return state.segs.find((x) => L >= x.start && L < x.end); }
  /* The gap: the running segment at readIdx while a later one already sits in S3. */
  function gapOf(state) {
    const head = state.segs.find((x) => x.start === state.r && x.st === 'run');
    return head && state.segs.some((x) => x.st === 'held') ? head.id : null;
  }

  function render(i, prev) {
    const st = steps[i];
    // slots
    for (let j = 0; j < N; j++) {
      let L = -1;
      for (let k = st.w - 1; k >= 0; k--) if (k % N === j) { L = k; break; }
      const el = slotEls[j];
      if (L < 0) { el.path.setAttribute('class', 'anim f-free'); el.name.textContent = ''; continue; }
      const justGone = st.gone.some(([a, b]) => L >= a && L < b);
      const live = L >= st.r;
      const sg = segOf(st, L);
      let cls = 'f-free'; let txt = 't-mute';
      if (justGone) { cls = 'f-gone'; txt = 't-board'; }
      else if (live && L >= st.s) { cls = 'f-adm'; txt = 't-data'; }
      else if (live && sg && sg.st === 'run') { cls = 'run'; txt = 'halo'; }
      else if (live && sg) { cls = 'f-held'; txt = 't-safe'; }
      el.path.setAttribute('class', `anim ${cls === 'run' ? '' : cls}`);
      el.path.style.fill = cls === 'run' ? `url(#${hid})` : '';
      el.name.textContent = `e${L + 1}`;
      el.name.setAttribute('class', `t-l t-b anim ${txt}`);
      el.name.style.opacity = live || justGone ? 1 : 0.3;
    }
    // segment brackets
    gSegs.replaceChildren();
    const gapId = gapOf(st);
    for (const sg of st.segs) {
      if (sg.st === 'gone' && !st.del.includes(sg.id)) continue;
      const a0 = ang(sg.start) + 2; const a1 = ang(sg.end) - 2;
      const [x0, y0] = pt(a0, 163); const [x1, y1] = pt(a1, 163);
      const isGap = sg.id === gapId;
      const stroke = isGap ? 'var(--red)' : sg.st === 'held' ? 'var(--green)' : sg.st === 'gone' ? 'var(--green)' : 'var(--ink)';
      gSegs.append(s('path', { d: `M${x0},${y0} A163,163 0 0 1 ${x1},${y1}`, style: `fill:none;stroke:${stroke};stroke-width:${sg.st === 'run' ? 4 : 3};${isGap ? 'stroke-dasharray:6 3;' : ''}${sg.st === 'gone' ? 'opacity:.4' : ''}` }));
      const [lx, ly] = pt(ang((sg.start + sg.end) / 2), 181);
      const lbl = isGap ? `${sg.id} gap` : sg.st === 'run' ? `${sg.id}·${sg.wk}` : sg.st === 'held' ? `${sg.id} ✓` : `${sg.id}`;
      gSegs.append(s('text', { x: lx, y: ly + 4, class: `t-s t-b ${isGap ? 't-bad' : sg.st === 'held' ? 't-safe' : sg.st === 'gone' ? 't-mute' : ''}`, 'text-anchor': 'middle' }, lbl));
    }
    // overlays
    gOver.replaceChildren();
    if (st.wait) {
      gOver.append(s('rect', { x: 296, y: 4, width: 100, height: 40, style: 'fill:var(--red-l);stroke:var(--red);stroke-width:1.5;stroke-dasharray:4 2' }));
      gOver.append(s('text', { x: 346, y: 21, class: 't-s t-b t-bad', 'text-anchor': 'middle' }, `${st.wait} waits`));
      gOver.append(s('text', { x: 346, y: 36, class: 't-xs t-bad', 'text-anchor': 'middle' }, 'Add → false'));
    }
    if (st.ack != null) {
      gOver.append(s('text', { x: C, y: C + 32, class: 't-xs t-safe t-up t-b halo', 'text-anchor': 'middle' }, 'ACK'));
      gOver.append(s('text', { x: C, y: C + 47, class: 't-s t-b t-safe halo', 'text-anchor': 'middle' }, lsn(evLsn(st.ack))));
    }
    // hands
    cancelHands();
    const from = handEls.map((hd) => hd.cur);
    const to = [ang(st.r), ang(st.s), ang(st.w)];
    const animate = prev >= 0 && Math.abs(i - prev) === 1;
    cancelHands = tween(animate ? 750 : 0, (t) => handEls.forEach((hd, k) => setHand(hd, from[k] + (to[k] - from[k]) * easeBack(t))));

    // stats
    const occ = st.w - st.r;
    stats.innerHTML = `
      <dt>writeIdx</dt><dd>${st.w}</dd>
      <dt>lastSegIdx</dt><dd>${st.s}</dd>
      <dt>readIdx</dt><dd class="c-safe">${st.r}</dd>
      <dt>w − r</dt><dd${occ >= N ? ' class="c-bad"' : ''}>${occ} / ${N}${occ >= N ? ' · full' : ''}</dd>
      <dt>confirmed_flush_lsn</dt><dd class="c-safe">${lsn(st.ack == null ? evLsn(0) : evLsn(st.ack))}</dd>`;
    // tracker
    const rows = st.segs.filter((x) => x.st !== 'gone' || st.del.includes(x.id)).sort((a, b) => a.start - b.start);
    tracker.innerHTML = `<table class="wv-table"><thead><tr><th>tracker key</th><th>EndIdx</th><th>done</th><th>owner</th></tr></thead><tbody>${
      rows.length ? rows.map((x) => `<tr class="${x.id === gapId ? 'is-gap' : x.st === 'run' ? 'is-run' : x.st === 'held' ? 'is-held' : ''}${st.fresh.includes(x.id) ? ' is-new' : ''}${st.del.includes(x.id) ? ' is-del' : ''}"><td>${x.start} · ${x.id}</td><td>${x.end}</td><td>${x.st === 'run' ? 'false' : 'true'}</td><td>${st.del.includes(x.id) ? 'Del()' : x.id === gapId ? `${x.wk} · gap` : x.st === 'run' ? x.wk : 'in S3, waits'}</td></tr>`).join('')
        : '<tr class="empty"><td colspan="4">empty</td></tr>'}</tbody></table>`;
    const src = st.code === 'add' ? ADD_CODE : st.code === 'cut' ? CUT_CODE : WALK_CODE;
    code.innerHTML = codeBlock(src, st.hot);
    // WAL retained by the slot
    const conf = st.ack == null ? 0 : st.ack;
    wal.innerHTML = Array.from({ length: 12 }, (_, k) => `<span class="${k < conf ? 'is-free' : ''}" title="${lsn(evLsn(k + 1))}">e${k + 1}</span>`).join('');
    note.innerHTML = `<span class="k">${String(i + 1).padStart(2, '0')}</span>${st.note}`;
    note.className = `wv-note${st.tone ? ` is-${st.tone}` : ''}`;
  }

  const stp = stepper(fig, steps, render, { interval: 3400 });
  app.append(stp.el, h('div', { class: 'wv-split' }, left, right), note, walBox);
  stp.go(0);
}

/* ============================================================ RING SIM */

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initRingSim(fig) {
  const app = fig.querySelector('.wv-app');
  const P = { R: 10000, W: 4, B: 1000, p50: 100, speed: 0.1 };
  const E = 1.2; // ms, Parquet encode (benchmark)
  const SIGMA = 0.298; // lognormal: assumed p99 ≈ 2 × p50
  const BYTES_PER_EVENT = 68;
  const WIN = 2000;
  let S; let rnd;

  function reset() {
    rnd = mulberry(42);
    const size = 2 * P.W * P.B;
    S = {
      t: 0, size, write: 0, read: 0, lastSeg: 0, evc: 0, cap: P.W * P.B, backlog: 0, acc: 0, produced: 0,
      backoff: 0, queue: [], tracker: new Map(), workers: Array.from({ length: P.W }, () => null), segs: [], id: 0,
      acks: [], ackLog: [], stall: 0, slowNext: false, ooo: 0, addFails: 0, blockedMs: 0,
    };
  }
  const sampleP = () => {
    const u = 1 - rnd(); const v = rnd();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return P.p50 * Math.exp(SIGMA * z);
  };

  function tick() {
    S.t += 1;
    const t = S.t;
    // workers finish → ackSeg → walker
    S.workers.forEach((sg, k) => {
      if (!sg || t < sg.tEnd) return;
      sg.done = true; sg.tDone = t; S.workers[k] = null;
      if (sg.start !== S.read) S.ooo += 1;
      if (sg.start === S.read) {
        const before = S.read;
        let cur = S.tracker.get(S.read);
        while (cur && cur.done) {
          S.tracker.delete(cur.start); cur.tGone = t; S.read = cur.end;
          cur = S.tracker.get(S.read);
        }
        S.acks.push({ t, read: S.read });
        S.ackLog.push({ t, n: S.read - before });
      }
    });
    dispatch();
    // Postgres produces; pgoutput fills eventsCh
    produceAndReceive();
  }
  // dispatch: idle workers receive from segments
  function dispatch() {
    const t = S.t;
    S.workers.forEach((sg, k) => {
      if (sg || !S.queue.length) return;
      const next = S.queue.shift();
      let p = S.slowNext ? 1200 : sampleP();
      S.slowNext = false;
      if (S.stall > t) p = Math.max(p, S.stall - t + sampleP() * 0.4);
      next.tStart = t; next.tEnd = t + E + p; next.p = p; next.wk = k;
      S.workers[k] = next;
    });
  }
  function produceAndReceive() {
    const t = S.t;
    S.acc += P.R / 1000;
    const n = Math.floor(S.acc); S.acc -= n; S.produced += n; S.backlog += n;
    const mv = Math.min(S.backlog, S.cap - S.evc); S.evc += mv; S.backlog -= mv;
    if (S.backlog > 0) S.blockedMs += 1;
    // receiver: Add until the ring is full; the walker wakes it when readIdx moves
    if (S.evc > 0) {
      const free = S.size - (S.write - S.read);
      const k = Math.min(S.evc, free);
      S.write += k; S.evc -= k;
      while (S.write - S.lastSeg >= P.B) {
        const sg = { id: ++S.id, start: S.lastSeg, end: S.lastSeg + P.B, done: false, tCut: t };
        S.lastSeg = sg.end; S.tracker.set(sg.start, sg); S.queue.push(sg); S.segs.push(sg);
      }
      if (S.evc > 0 && k === free) { S.addFails += 1; }
    }
    dispatch();
    trim();
  }
  function trim() {
    const t = S.t;
    // drop history outside the window
    if (S.segs.length > 80) S.segs = S.segs.filter((x) => !x.tGone || x.tGone > t - WIN);
    while (S.acks.length && S.acks[0].t < t - WIN) S.acks.shift();
    while (S.ackLog.length && S.ackLog[0].t < t - 1000) S.ackLog.shift();
  }

  /* --- view --- */
  const hid = `wvh${++UID}`;
  const dial = s('svg', { viewBox: '-8 -8 376 376', role: 'img', 'aria-label': 'Ring buffer simulator dial' });
  const gantt = s('svg', { role: 'img', 'aria-label': 'Worker timeline' });
  const statsEl = h('div', { class: 'wv-stats', 'aria-live': 'off' });
  const status = h('div', { class: 'wv-note', 'aria-live': 'polite' });

  const playB = btn('▶ Run', () => (running ? pause() : play()), { 'aria-pressed': 'false' });
  const resetB = btn('Reset', () => { reset(); draw(); });
  const speeds = [0.1, 0.25, 1];
  const speedBtns = speeds.map((v) => btn(`${v}×`, () => { P.speed = v; speedBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(speeds[k] === v))); }, { 'aria-pressed': String(v === P.speed) }));
  const slowB = btn('Slow PUT · 1.2 s', () => { S.slowNext = true; play(); }, { class: 'wv-btn wv-btn--bad' });
  const stallB = btn('S3 stall · 3 s', () => {
    S.stall = S.t + 3000;
    S.workers.forEach((sg) => { if (sg) sg.tEnd = Math.max(sg.tEnd, S.stall + sampleP() * 0.4); });
    play();
  }, { class: 'wv-btn wv-btn--bad' });

  function slider(label, min, max, stepv, key, show) {
    const out = h('output');
    const inp = h('input', { type: 'range', min, max, step: stepv, value: P[key], 'aria-label': label });
    const upd = () => { out.textContent = show(P[key]); };
    inp.addEventListener('input', () => { P[key] = +inp.value; upd(); if (key === 'W') { reset(); } draw(); });
    upd();
    return h('div', { class: 'wv-range' }, h('label', null, label), inp, out);
  }
  const ctrl = h('div', null,
    h('div', { class: 'wv-bar' }, playB, resetB, h('span', { class: 'wv-seg' }, ...speedBtns), h('span', { class: 'wv-sp' }), slowB, stallB),
    h('div', { class: 'wv-grid-ctrl' },
      slider('input rate', 1000, 40000, 1000, 'R', (v) => `${fmt(v)}/s`),
      slider('workers', 1, 8, 1, 'W', (v) => `${v} → ring ${fmt(2 * v * P.B)}`),
      slider('S3 PUT p50', 25, 400, 5, 'p50', (v) => `${v} ms`)));

  const legend = colorKey([['k-data', 'admitted, not cut'], ['k-run', 'PUT in flight'], ['k-held', 'in S3, waiting'], ['k-gap', 'the gap'], ['k-line-green', 'readIdx · ACK']]);

  app.append(ctrl,
    h('div', { class: 'wv-split', style: 'margin-top:.4rem' }, h('div', null, dial, legend), h('div', null, statsEl, h('div', { style: 'height:.6rem' }), status)),
    h('div', { style: 'margin-top:.9rem' }, h('div', { class: 'wv-title', style: 'margin-bottom:.35rem' }, 'Worker timeline · last 2 s of simulated time'), gantt));

  const DC = 180; const DR0 = 104; const DR1 = 142;
  const polar = (a, r) => [DC + r * Math.sin(a), DC - r * Math.cos(a)];
  function sector(i0, i1, r0, r1, cls, style = '') {
    const span = ((i1 - i0) / S.size) * 2 * Math.PI;
    if (span <= 0) return '';
    if (span >= 2 * Math.PI - 1e-6) {
      const mid = i0 + S.size / 2;
      return sector(i0, mid, r0, r1, cls, style) + sector(mid, i1, r0, r1, cls, style);
    }
    const a0 = ((i0 % S.size) / S.size) * 2 * Math.PI; const a1 = a0 + span;
    const lg = span > Math.PI ? 1 : 0;
    const [x0, y0] = polar(a0, r1); const [x1, y1] = polar(a1, r1); const [x2, y2] = polar(a1, r0); const [x3, y3] = polar(a0, r0);
    return `<path class="${cls}" style="${style}" d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r1},${r1} 0 ${lg} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${r0},${r0} 0 ${lg} 0 ${x3.toFixed(1)},${y3.toFixed(1)} Z"/>`;
  }
  function hand(idx, len, style, label, lr) {
    const a = ((idx % S.size) / S.size) * 2 * Math.PI;
    const [x, y] = polar(a, len); const [lx, ly] = polar(a, lr);
    return `<line x1="${DC}" y1="${DC}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" style="${style}" stroke-linecap="round"/><text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" class="t-xs t-b" text-anchor="middle" style="${label}">${label ? '' : ''}</text>`;
  }

  function drawDial() {
    let out = `<defs>${hatchDefs(hid)}</defs>`;
    out += sector(0, S.size, DR0, DR1, 'f-free', 'stroke:var(--ink);stroke-width:1.2');
    out += sector(S.lastSeg, S.write, DR0, DR1, 'f-adm', 'stroke:var(--brown);stroke-width:1');
    const anyHeld = [...S.tracker.values()].some((x) => x.done);
    for (const sg of S.tracker.values()) {
      const isGap = !sg.done && sg.start === S.read && anyHeld;
      const style = sg.done ? 'stroke:var(--green);stroke-width:1.5' : isGap ? `fill:url(#${hid});stroke:var(--red);stroke-width:2.5;stroke-dasharray:5 3` : `fill:url(#${hid});stroke:var(--ink);stroke-width:1.2`;
      out += sector(sg.start, sg.end, DR0 + 1, DR1 - 1, sg.done ? 'f-held' : '', style);
      const a = (((sg.start + sg.end) / 2 % S.size) / S.size) * 2 * Math.PI;
      const [lx, ly] = polar(a, (DR0 + DR1) / 2);
      const wk = S.workers.findIndex((x) => x === sg);
      const tone = sg.done ? 't-safe' : isGap ? 't-bad' : '';
      out += `<text x="${lx.toFixed(1)}" y="${(ly - 1).toFixed(1)}" class="t-s t-b halo ${tone}" text-anchor="middle">#${sg.id}</text>`;
      out += `<text x="${lx.toFixed(1)}" y="${(ly + 11).toFixed(1)}" class="t-xs t-b halo ${tone}" text-anchor="middle">${sg.done ? 'in S3 ✓' : isGap ? 'gap' : wk >= 0 ? `W${wk + 1}` : 'queued'}</text>`;
    }
    for (let k = 0; k < P.W; k++) {
      const a = (k / P.W) * 2 * Math.PI; const [x0, y0] = polar(a, DR0 - 6); const [x1, y1] = polar(a, DR1 + 6);
      out += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" style="stroke:var(--ink);stroke-width:1.2"/>`;
      const [tx, ty] = polar(a, DR1 + 16);
      out += `<text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="t-xs t-mute" text-anchor="middle">${fmt(k * P.B)}</text>`;
    }
    const aW = ((S.write % S.size) / S.size) * 2 * Math.PI;
    const aR = ((S.read % S.size) / S.size) * 2 * Math.PI;
    const [wx, wy] = polar(aW, DR1); const [rx, ry] = polar(aR, DR1);
    out += `<line x1="${DC}" y1="${DC}" x2="${wx.toFixed(1)}" y2="${wy.toFixed(1)}" style="stroke:var(--ink);stroke-width:1.6" stroke-linecap="round"/>`;
    out += `<line x1="${DC}" y1="${DC}" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}" style="stroke:var(--green);stroke-width:3.5" stroke-linecap="round"/>`;
    const [wlx, wly] = polar(aW, DR0 - 14); const [rlx, rly] = polar(aR, DR0 - 30);
    out += `<text x="${wlx.toFixed(1)}" y="${(wly + 3).toFixed(1)}" class="t-s t-b" text-anchor="middle">w</text>`;
    out += `<text x="${rlx.toFixed(1)}" y="${(rly + 3).toFixed(1)}" class="t-s t-b t-safe" text-anchor="middle">r</text>`;
    out += `<circle cx="${DC}" cy="${DC}" r="60" style="fill:var(--board);stroke:var(--line)"/>`;
    out += `<text x="${DC}" y="${DC - 22}" class="t-xs t-mute t-up" text-anchor="middle">sim time</text>`;
    out += `<text x="${DC}" y="${DC - 6}" class="t-l t-b" text-anchor="middle">${(S.t / 1000).toFixed(2)} s</text>`;
    out += `<text x="${DC}" y="${DC + 14}" class="t-xs t-mute t-up" text-anchor="middle">w − r</text>`;
    out += `<text x="${DC}" y="${DC + 30}" class="t-m t-b" text-anchor="middle">${fmt(S.write - S.read)}</text>`;
    dial.innerHTML = out;
    void hand;
  }

  function drawGantt() {
    const Wd = Math.max(300, gantt.parentElement.clientWidth);
    const rowH = 18; const lab = 34; const rows = P.W;
    const Ht = rows * rowH + rowH + 22;
    gantt.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    gantt.setAttribute('height', Ht);
    const t0 = S.t - WIN;
    const x = (t) => lab + ((t - t0) / WIN) * (Wd - lab - 6);
    let out = `<defs>${hatchDefs(`${hid}g`)}</defs>`;
    for (let k = 0; k < rows; k++) {
      const y = k * rowH;
      out += `<text x="0" y="${y + 13}" class="t-xs t-mute">W${k + 1}</text><line x1="${lab}" x2="${Wd - 6}" y1="${y + rowH - 0.5}" y2="${y + rowH - 0.5}" class="rule"/>`;
    }
    const ya = rows * rowH;
    out += `<text x="0" y="${ya + 13}" class="t-xs t-safe t-b">ACK</text>`;
    for (const sg of S.segs) {
      if (sg.tStart == null) continue;
      const endRun = Math.min(sg.tDone ?? S.t, S.t);
      if (endRun < t0 && (sg.tGone ?? S.t) < t0) continue;
      const y = sg.wk * rowH + 2;
      const xa = Math.max(lab, x(sg.tStart)); const xb = x(endRun);
      if (xb > lab) {
        out += `<rect x="${xa.toFixed(1)}" y="${y}" width="${Math.max(0, xb - xa).toFixed(1)}" height="${rowH - 5}" style="fill:url(#${hid}g);stroke:var(--ink);stroke-width:1.2"/>`;
        if (xb - xa > 28) out += `<text x="${(xa + 4).toFixed(1)}" y="${y + 10}" class="t-xs t-b halo">#${sg.id}</text>`;
      }
      if (sg.tDone != null) {
        const xc = Math.max(lab, x(sg.tDone)); const xd = x(Math.min(sg.tGone ?? S.t, S.t));
        if (xd - xc > 0.5) {
          out += `<rect x="${xc.toFixed(1)}" y="${y + 1}" width="${(xd - xc).toFixed(1)}" height="${rowH - 7}" class="f-held" style="stroke:var(--green);stroke-width:1.2"/>`;
          if (xd - xc > 70) out += `<text x="${(xc + 4).toFixed(1)}" y="${y + 10}" class="t-xs t-safe t-b">waits ${fmt((sg.tGone ?? S.t) - sg.tDone)} ms</text>`;
        }
      }
    }
    for (const a of S.acks) {
      const xa = x(a.t);
      if (xa < lab) continue;
      out += `<line x1="${xa.toFixed(1)}" x2="${xa.toFixed(1)}" y1="${ya + 2}" y2="${ya + rowH - 3}" style="stroke:var(--green);stroke-width:2.5"/>`;
    }
    for (let k = 0; k <= 4; k++) {
      const tt = t0 + (k * WIN) / 4; const xx = x(tt);
      out += `<line x1="${xx}" x2="${xx}" y1="0" y2="${ya + rowH}" class="rule" style="opacity:.5"/>`;
      out += `<text x="${xx}" y="${Ht - 4}" class="t-xs t-mute" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${k === 4 ? 'now' : `−${((WIN - (k * WIN) / 4) / 1000).toFixed(1)} s`}</text>`;
    }
    gantt.innerHTML = out;
  }

  function drawStats() {
    const rate = S.ackLog.reduce((a, b) => a + b.n, 0) * (1000 / Math.min(1000, Math.max(1, S.t)));
    const occ = (S.write - S.read) / S.size;
    const held = [...S.tracker.values()].filter((x) => x.done).length;
    const blocked = S.backlog > 0;
    const retained = (S.produced - S.read) * BYTES_PER_EVENT;
    const cell = (k, v, cls = '') => `<div class="wv-stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    statsEl.innerHTML = [
      cell('ACKed events/s', fmt(rate), rate >= P.R * 0.97 && S.t > 1500 ? 'is-good' : ''),
      cell('ring in use', `${Math.round(occ * 100)}%`, occ > 0.97 ? 'is-bad' : ''),
      cell('held behind gap', `${held}`),
      cell('pgoutput', blocked ? 'blocked' : 'streaming', blocked ? 'is-bad' : ''),
      cell('WAL retained', retained > 1e6 ? `${(retained / 1e6).toFixed(1)} MB` : `${fmt(retained / 1e3)} KB`),
      cell('confirmed_flush', lsn(0x16A0000 + S.read * BYTES_PER_EVENT), 'is-good'),
    ].join('');
    status.className = `wv-note${S.stall > S.t || blocked ? ' is-bad' : ''}`;
    const cap = (P.W * P.B) / ((E + P.p50) / 1000);
    let msg;
    if (S.stall > S.t) msg = `<b>S3 stall.</b> PUTs cannot finish. Workers hold their segments, the ring fills, <code>Add</code> returns false, and the receiver waits for free space. Then <code>eventsCh</code> fills and pgoutput blocks. No event is lost; WAL piles up in Postgres.`;
    else if (blocked) msg = `<b>Backpressure.</b> The ring is full and <code>eventsCh</code> holds ${fmt(S.evc)} of ${fmt(S.cap)} pointers. The replicator goroutine blocks on <code>ch &lt;- ev</code>. The receiver waits for the walker to free space.`;
    else if (held > 0) msg = `<b class="c-safe">${held} segment${held > 1 ? 's' : ''} in S3</b>, <b class="c-bad">behind a gap.</b> They finished before an earlier segment. <code>readIdx</code> waits at the gap, and the ACK names only the contiguous prefix.`;
    else msg = `${P.W} PUT${P.W > 1 ? 's' : ''} overlap. The napkin upper bound at p50 is <code>${P.W} × ${fmt(P.B)} / (${E} + ${P.p50}) ms = ${fmt(cap)}/s</code> for an input of ${fmt(P.R)}/s. PUT times are sampled from a lognormal with this p50 and an assumed p99 of 2 × p50.`;
    status.innerHTML = msg;
  }

  function draw() { drawDial(); drawGantt(); drawStats(); }

  let running = false; let visible = false; let raf = 0; let last = 0; let simCarry = 0;
  function frame(now) {
    if (!running || !visible) { raf = 0; return; }
    const dt = Math.min(100, now - last); last = now;
    simCarry += dt * P.speed;
    const n = Math.floor(simCarry); simCarry -= n;
    for (let k = 0; k < n; k++) tick();
    draw();
    raf = requestAnimationFrame(frame);
  }
  function play() {
    running = true; playB.textContent = '❚❚ Pause'; playB.setAttribute('aria-pressed', 'true');
    if (!raf && visible) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function pause() { running = false; playB.textContent = '▶ Run'; playB.setAttribute('aria-pressed', 'false'); }

  reset();
  // warm up so the first paint shows a busy ring
  for (let k = 0; k < 600; k++) tick();
  draw();
  new ResizeObserver(() => drawGantt()).observe(app);
  let autoplayed = false;
  onVisible(fig, (v) => {
    visible = v;
    if (v && !autoplayed && !REDUCED) { autoplayed = true; play(); }
    if (v && running && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
}

/* ============================================================== SIZING */

function initSizing(fig) {
  const app = fig.querySelector('.wv-app');
  const P = { R: 10000, B: 1000, E: 1, W: 4 };
  const PCT = [['50 ms', 50], ['100 ms', 100], ['200 ms', 200]];
  const PMAX = 500; const RMAX = 50000;
  const svg = s('svg', { role: 'img', 'aria-label': 'Workers needed across S3 PUT latency and input rate' });
  const read = h('div', { class: 'wv-read wv-note', 'aria-live': 'polite' });
  const table = h('div');

  function slider(label, min, max, stepv, key, show) {
    const out = h('output');
    const inp = h('input', { type: 'range', min, max, step: stepv, value: P[key], 'aria-label': label });
    const upd = () => { out.textContent = show(P[key]); };
    inp.addEventListener('input', () => { P[key] = +inp.value; upd(); draw(); });
    upd();
    return h('div', { class: 'wv-range' }, h('label', null, label), inp, out);
  }
  app.append(h('div', { class: 'wv-grid-ctrl' },
    slider('input rate R', 1000, 50000, 1000, 'R', (v) => `${fmt(v)}/s`),
    slider('batch B', 250, 4000, 250, 'B', (v) => `${fmt(v)} events`),
    slider('encode E', 1, 40, 1, 'E', (v) => `${v} ms`),
    slider('workers you run', 1, 8, 1, 'W', (v) => `${v}`)), svg,
    colorKey([['k-pick', 'capacity of the workers you run'], ['k-safe', 'enough workers'], ['k-gap', 'too few'], ['k-look', 'your cursor']]),
    h('div', { style: 'height:.6rem' }), read, table);

  const need = (R, p) => Math.ceil((R * ((P.E + p) / 1000)) / P.B);
  let geom = null; let hover = null;

  function draw() {
    const Wd = Math.max(300, app.clientWidth);
    const Ht = clamp(Math.round(Wd * 0.52), 280, 420);
    const m = { l: 44, r: 12, t: 28, b: 34 };
    const x = (p) => m.l + (p / PMAX) * (Wd - m.l - m.r);
    const y = (r) => Ht - m.b - (r / RMAX) * (Ht - m.t - m.b);
    geom = { x, y, m, Wd, Ht };
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    const Rk = (k, p) => (k * P.B) / ((P.E + p) / 1000);
    let out = `<defs><pattern id="wvh${fig.dataset.uid}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" style="fill:var(--red-l)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--red);stroke-width:1.5"/></pattern></defs>`;
    const ps = []; for (let p = 0; p <= PMAX; p += 5) ps.push(p);
    for (let k = 1; k <= 9; k++) {
      const up = ps.map((p) => [x(p), y(k === 9 ? RMAX : Math.min(RMAX, Rk(k, p)))]);
      const lo = ps.map((p) => [x(p), y(Math.min(RMAX, Rk(k - 1, p)))]).reverse();
      const fill = k === 9 ? `url(#wvh${fig.dataset.uid})` : `color-mix(in oklch, var(--ink) ${3 + k * 7}%, var(--board))`;
      out += `<path d="M${[...up, ...lo].map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' L')} Z" style="fill:${fill};stroke:none"/>`;
      // label near the right edge
      const pl = 470; const a = Math.min(RMAX, Rk(k - 1, pl)); const b = k === 9 ? RMAX : Math.min(RMAX, Rk(k, pl));
      if (y(a) - y(b) > 13) {
        out += `<text x="${x(pl)}" y="${((y(a) + y(b)) / 2 + 3.5).toFixed(1)}" class="t-xs t-b" text-anchor="middle" style="fill:${k >= 5 && k < 9 ? 'var(--board)' : k === 9 ? 'var(--red)' : 'var(--ink)'}">${k === 9 ? '9+' : k}</text>`;
      }
    }
    // frontier for the workers you run
    const fr = ps.map((p) => [x(p), y(Math.min(RMAX, Rk(P.W, p)))]);
    out += `<path d="M${fr.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' L')}" style="fill:none;stroke:var(--orange);stroke-width:3"/>`;
    const pl = 360; const fy = y(Math.min(RMAX, Rk(P.W, pl)));
    out += `<text x="${x(pl)}" y="${fy - 8}" class="t-s t-b t-pick halo" text-anchor="middle">capacity of ${P.W} worker${P.W > 1 ? 's' : ''}</text>`;
    // axes
    for (let r = 0; r <= RMAX; r += 10000) {
      out += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(r)}" y2="${y(r)}" class="rule" style="opacity:.35"/>`;
      out += `<text x="${m.l - 6}" y="${y(r) + 3}" class="t-xs t-mute" text-anchor="end">${r ? `${r / 1000}k` : '0'}</text>`;
    }
    for (let p = 0; p <= PMAX; p += 100) out += `<text x="${x(p)}" y="${Ht - m.b + 14}" class="t-xs t-mute" text-anchor="middle">${p}</text>`;
    out += `<text x="${Wd - m.r}" y="${Ht - 4}" class="t-xs t-mute" text-anchor="end">S3 PUT latency P (ms) →</text>`;
    out += `<text x="${m.l}" y="${m.t - 12}" class="t-xs t-mute">↑ input rate R (events/s)</text>`;
    out += `<rect x="${m.l}" y="${m.t}" width="${Wd - m.l - m.r}" height="${Ht - m.t - m.b}" class="rule-ink"/>`;
    // percentile guides and the target rate
    out += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(P.R)}" y2="${y(P.R)}" style="stroke:var(--ink);stroke-dasharray:5 4;stroke-width:1.2"/>`;
    for (const [name, p] of PCT) {
      out += `<line x1="${x(p)}" x2="${x(p)}" y1="${m.t}" y2="${Ht - m.b}" style="stroke:var(--ink);stroke-dasharray:2 3"/>`;
      out += `<text x="${x(p)}" y="${m.t - 3}" class="t-xs t-b" text-anchor="middle">${name}</text>`;
      const n = need(P.R, p);
      const ok = n <= P.W;
      out += `<circle cx="${x(p)}" cy="${y(P.R)}" r="10" style="fill:${ok ? 'var(--green)' : 'var(--red)'};stroke:var(--board);stroke-width:2"/>`;
      out += `<text x="${x(p)}" y="${y(P.R) + 3.5}" class="t-xs t-b t-board" text-anchor="middle">${n}</text>`;
    }
    if (hover) {
      const [hp, hr] = hover;
      out += `<line x1="${x(hp)}" x2="${x(hp)}" y1="${m.t}" y2="${Ht - m.b}" style="stroke:var(--purple);stroke-width:1.5"/>`;
      out += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(hr)}" y2="${y(hr)}" style="stroke:var(--purple);stroke-width:1.5"/>`;
      out += `<circle cx="${x(hp)}" cy="${y(hr)}" r="5" style="fill:var(--purple);stroke:var(--board);stroke-width:2"/>`;
    }
    svg.innerHTML = out;
    readout();
    tableOut();
  }

  function readout() {
    const [p, r] = hover || [200, P.R];
    const bt = (P.E + p) / 1000;
    const n = need(r, p);
    const ok = n <= P.W;
    read.className = `wv-read wv-note${ok ? '' : ' is-bad'}`;
    read.innerHTML = `<span class="k">${hover ? 'cursor' : '200 ms'}</span>R = ${fmt(r)}/s, P = ${Math.round(p)} ms → <code>ceil(${fmt(r)} × (${(P.E / 1000).toFixed(3)} + ${(p / 1000).toFixed(3)}) / ${fmt(P.B)})</code> = <code>ceil(${((r * bt) / P.B).toFixed(2)})</code> = <b>${n} worker${n > 1 ? 's' : ''}</b>. ${ok ? `<span class="c-safe">${P.W} workers carry ${fmt((P.W * P.B) / bt)}/s here.</span>` : `<b class="c-bad">${P.W} workers fall short</b>; the backlog grows by ${fmt(r - (P.W * P.B) / bt)} events/s.`}`;
  }
  function tableOut() {
    table.innerHTML = `<div class="wv-scroll"><table class="wv-mini"><thead><tr><th>PUT</th><th>E + P</th><th>1 worker</th><th>${P.W} workers</th><th>need</th></tr></thead><tbody>${
      PCT.map(([name, p]) => {
        const bt = (P.E + p) / 1000; const one = P.B / bt; const n = need(P.R, p);
        return `<tr><td>${name}</td><td>${bt.toFixed(3)} s</td><td>${fmt(one)}/s</td><td>${fmt(one * P.W)}/s</td><td class="${n > P.W ? 'bad' : 'ok'}">${n}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  svg.addEventListener('pointermove', (e) => {
    if (!geom) return;
    const b = svg.getBoundingClientRect();
    const sx = ((e.clientX - b.left) / b.width) * geom.Wd; const sy = ((e.clientY - b.top) / b.height) * geom.Ht;
    const p = ((sx - geom.m.l) / (geom.Wd - geom.m.l - geom.m.r)) * PMAX;
    const r = ((geom.Ht - geom.m.b - sy) / (geom.Ht - geom.m.t - geom.m.b)) * RMAX;
    if (p < 0 || p > PMAX || r < 0 || r > RMAX) { if (hover) { hover = null; draw(); } return; }
    hover = [p, Math.round(r / 100) * 100];
    draw();
  });
  svg.addEventListener('pointerleave', () => { hover = null; draw(); });
  fig.dataset.uid = String(++UID);
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

/* ============================================================== REPLAY */

function initReplay(fig) {
  const app = fig.querySelector('.wv-app');
  let mode = 'time';
  const first = 0x16A2F58; const lastL = ROW.prefixLsn;
  const pad = (n) => n.toString(16).toUpperCase().padStart(16, '0');
  const keyOld = { time: 'cdc/2026/05/09/1778308244772019-6.ZSTD.parquet', lsn: `cdc/2026/05/09/${pad(0x16953C0)}-${pad(ROW.prevAck)}.ZSTD.parquet` };
  const keyA = { time: 'cdc/2026/05/09/1778308245891204-7.ZSTD.parquet', lsn: `cdc/2026/05/09/${pad(first)}-${pad(lastL)}.ZSTD.parquet` };
  const keyB = { time: 'cdc/2026/05/09/1778308251066310-1.ZSTD.parquet', lsn: keyA.lsn };
  const range = `${lsn(first)} … ${lsn(lastL)}`;

  const STEPS = [
    { label: 'Running', proc: 'W2 encodes segment [2000, 3000)', ring: 'readIdx 2000 · 1,000 events in memory', slot: ROW.prevAck, objs: ['old'], note: 'The segment covers WAL ' + range + '. The slot is at the end of the previous prefix.' },
    { label: 'PUT ok', proc: 'PutObject → 200 OK', ring: 'ackSeg not sent yet', slot: ROW.prevAck, objs: ['old', 'A'], newObj: 'A', note: 'S3 holds the rows. The worker has not reported the segment to the walker yet.' },
    { label: 'Crash', proc: 'process exits', ring: 'ring, tracker, readIdx: gone', slot: ROW.prevAck, objs: ['old', 'A'], dead: true, note: 'An OOM kill, a lost node, or <code>log.Fatal</code> after three failed uploads ends the process. Everything in the ring was memory. The slot never heard about the PUT.' },
    { label: 'Restart', proc: 'getStartLSN → ' + lsn(ROW.prevAck), ring: 'new ring · indices restart at 0', slot: ROW.prevAck, objs: ['old', 'A'], note: '<code>getStartLSN</code> reads <code>confirmed_flush_lsn</code>. <code>StartReplication</code> resumes there, before the rows already in S3.' },
    { label: 'Replay', proc: 'decode the same 1,000 changes', ring: 'segment [0, 1000) · new Timestamp values', slot: ROW.prevAck, objs: ['old', 'A'], note: 'Postgres sends the same changes again. Each <code>CDCEvent</code> gets a new <code>time.Now()</code>.' },
    { label: 'PUT again', proc: 'PutObject', ring: 'segment [0, 1000)', slot: ROW.prevAck, objs: ['old', 'A', 'B'], newObj: 'B', second: true, note: '' },
    { label: 'ACK', proc: 'walker → acked → status update', ring: 'readIdx 1000', slot: lastL, objs: ['old', 'A', 'B'], note: 'The slot moves to ' + lsn(lastL) + '. Only now can Postgres forget this WAL.' },
  ];

  const lanes = h('div', { class: 'wv-lanes' });
  const verdict = h('div', { class: 'wv-verdict', 'aria-live': 'polite' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const modeBtns = [['time', 'Key = decode time (today)'], ['lsn', 'Key = LSN range (alternative)']].map(([m, t]) =>
    btn(t, () => { mode = m; modeBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === (m === 'time' ? 0 : 1)))); render(stp.i); }, { 'aria-pressed': String(m === mode) }));

  function render(i) {
    const st = STEPS[i];
    const dup = mode === 'time';
    const objs = st.objs.filter((o) => !(o === 'B' && !dup));
    const objHtml = objs.map((o) => {
      const key = o === 'old' ? keyOld[mode] : o === 'A' ? keyA[mode] : keyB[mode];
      const meta = o === 'old' ? 'previous prefix' : `rows ${range}`;
      const isDup = dup && st.objs.includes('B') && (o === 'A' || o === 'B');
      const cls = isDup ? 'is-dup' : st.newObj === o ? 'is-new' : '';
      return `<div class="obj ${cls}"><span class="key">${esc(key)}</span><span class="m">${meta}${isDup ? ' · duplicate' : ''}</span></div>`;
    }).join('');
    let put = '';
    if (st.second) {
      put = dup
        ? ''
        : `<div class="obj is-noop">PutObject <span class="key">${esc(keyA.lsn)}</span><span class="m">If-None-Match: * → 412 Precondition Failed → treat as success</span></div>`;
    }
    lanes.innerHTML = `
      <div class="wv-lane${st.dead ? ' is-dead' : ''}"><h5><span>wal-cake</span><span class="wv-tag ${st.dead ? 'c-bad' : 'c-safe'}">${st.dead ? 'down' : 'up'}</span></h5><div>${esc(st.proc)}</div><div class="sub">${esc(st.ring)}</div></div>
      <div class="wv-lane"><h5><span>Postgres slot</span></h5><div class="sub" style="margin:0">confirmed_flush_lsn</div><div class="big">${lsn(st.slot)}</div><div class="sub">${st.slot === lastL ? '<span class="c-safe">WAL for the segment can go</span>' : 'WAL for the segment is kept'}</div></div>
      <div class="wv-lane"><h5><span>S3 bucket</span><span>${objs.length} object${objs.length > 1 ? 's' : ''}</span></h5>${objHtml}${put}</div>`;
    const showVerdict = i >= 5;
    verdict.style.display = showVerdict ? '' : 'none';
    verdict.className = `wv-verdict ${dup ? 'is-bad' : 'is-good'}`;
    verdict.innerHTML = dup
      ? 'Two objects hold the same 1,000 rows. Readers of the prefix see duplicates.'
      : 'One object for this LSN range. The second PUT changes nothing.';
    note.innerHTML = `<span class="k">${String(i + 1).padStart(2, '0')}</span>${st.second
      ? (dup ? 'The key uses the last event\'s decode time. Replay decoded later, so the key is new and S3 stores a second copy.'
        : 'The key is the LSN range. S3 rejects the conditional write because the key exists. This needs the replay to cut the same batch boundaries; a timer-cut partial batch changes the range, and a table-format commit handles that case.')
      : st.note}`;
  }

  const stp = stepper(fig, STEPS, (i) => render(i), { interval: 3400 });
  app.append(h('div', { class: 'wv-bar' }, h('span', { class: 'c-opt', style: 'font-size:11px;letter-spacing:.06em;text-transform:uppercase' }, 'Pick a key scheme'), h('span', { class: 'wv-seg' }, ...modeBtns)), stp.el, lanes, h('div', { style: 'height:.6rem' }), verdict, h('div', { style: 'height:.6rem' }), note);
  stp.go(0);
}


/* ============================================================= OPTIONS */
/* Coda's grammar: black question, blue options, brown "how it works",
   green benefits, red costs, orange the choice, purple the callout. */

const OPTIONS = [
  {
    name: 'Debezium + Kafka Connect', how: 'pgoutput → Kafka topics → S3 sink connector',
    pro: ['Snapshots, offsets, and connector lifecycle are built in', 'A strong fit when Kafka already runs'],
    con: ['Kafka, Connect, and an S3 sink to operate', 'Rows land in Kafka first, then in S3'],
  },
  {
    name: 'Debezium Server', how: 'pgoutput → a sink inside one JVM process',
    pro: ['Debezium capture without Kafka', 'Recent releases ship an Apache Iceberg sink'],
    con: ['No plain Parquet-on-S3 sink: you write batching, file layout, and retries'],
  },
  {
    name: 'AWS DMS → S3', how: 'managed task writes CSV or Parquet',
    pro: ['Managed replication, Parquet output', 'No code for the common case'],
    con: ['A replication instance and a task model to operate', 'Less control over batch boundaries and the checkpoint'],
  },
  {
    name: 'Direct pgoutput', how: 'WAL Cake: pgoutput → ring → parallel PUTs', pick: true,
    pro: ['One Go binary, no broker', 'Each file holds one day of rows, under a day prefix', 'We own batch size, file layout, and the LSN we ACK'],
    con: ['We own reconnects, backpressure, and the checkpoint rule'],
  },
];

function initOptions(fig) {
  const app = fig.querySelector('.wv-app');
  const q = h('div', { class: 'wv-q' }, 'How do committed rows reach S3 as Parquet files split by day, and who tells Postgres when it may delete the WAL?');
  const grid = h('div', { class: 'wv-opts' });
  for (const o of OPTIONS) {
    grid.append(h('div', { class: `wv-opt${o.pick ? ' is-pick' : ''}` },
      o.pick ? h('span', { class: 'pick' }, 'our choice') : null,
      h('h5', null, o.name),
      h('div', { class: 'how' }, o.how),
      h('ul', null, ...o.pro.map((x) => h('li', { class: 'pro' }, x)), ...o.con.map((x) => h('li', { class: 'con' }, x)))));
  }
  const call = h('div', { class: 'wv-callout' },
    h('b', { class: 'c-look' }, 'The shared question. '),
    'Every option must decide when the replication slot may advance. The first three decide it inside a system you run next to Postgres. WAL Cake decides it with one ring buffer and one rule.');
  app.append(q, grid, call,
    colorKey([['k-ink', 'the question'], ['k-opt', 'options'], ['k-data', 'how it works'], ['k-safe', 'benefit'], ['k-gap', 'cost'], ['k-pick', 'our choice'], ['k-look', 'the key point']]));
}

/* =============================================================== mount */

const WIDGETS = { options: initOptions, map: initMap, 'ring-walk': initRingWalk, 'ring-sim': initRingSim, sizing: initSizing, replay: initReplay };

function mount() {
  document.querySelectorAll('figure[data-wv]').forEach((fig) => {
    const init = WIDGETS[fig.dataset.wv];
    if (!init || fig.classList.contains('wv-live')) return;
    try {
      fig.classList.add('wv-live');
      init(fig);
    } catch (err) {
      fig.classList.remove('wv-live');
      console.error('walviz:', fig.dataset.wv, err);
    }
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();

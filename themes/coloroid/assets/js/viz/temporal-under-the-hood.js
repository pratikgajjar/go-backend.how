/*
 * temporal-under-the-hood — figures for "Temporal — Under the Hood".
 *
 * Visual language: the paper trail. Temporal's event history is a receipt
 * tape, every SQL statement is a tally mark, and Postgres is where the
 * meter ticks. Figures sit on receipt paper (frame="none"), not on the
 * shared whiteboard sheet.
 *
 *   tuth-receipts  one order, two receipts (events vs checkpoints)
 *   tuth-request   a plain request and its failure points
 *   tuth-services  Temporal's services and the one database they share
 *   tuth-tape      the event history of one workflow; N activities
 *   tuth-trip      one activity as a sequence diagram with SQL tallies
 *   tuth-crash     the worker dies during step 3: replay vs checkpoints
 *   tuth-cost      SQL statements per unit of work, measured and fitted
 *   tuth-deploy    what you deploy for each system
 *
 * Behaviour follows Temporal v1.28.2 (service/history, common/persistence/sql),
 * Go SDK v1.34.0, and absurd.sql as of April 2026. Measured numbers are the
 * post's pg_stat_statements runs. Shard IDs, workers, and clock times are
 * sample values.
 */

import { h, s, codeBlock, register, esc, fmt, clamp } from './lib.js';

const P = 'v-tuth-';
let UID = 0;

/* ================================================================ shared */

/** Colour key. kinds: proc, table, data, look, safe, bad, opt, line, dash. */
function legend(items) {
  return h('div', { class: `${P}key` }, ...items.map(([k, label]) => h('span', null, h('i', { class: `${P}sw ${P}sw-${k}` }), label)));
}

/** Previous / next with a position readout. Arrow keys work inside the figure. */
function stepNav(fig, labels, onStep) {
  let i = -1;
  const prev = h('button', { class: `${P}btn`, type: 'button', 'aria-label': 'Previous step' }, '◀');
  const next = h('button', { class: `${P}btn`, type: 'button', 'aria-label': 'Next step' }, '▶');
  const pos = h('span', { class: `${P}pos`, 'aria-live': 'polite' });
  function go(n) {
    n = clamp(n, 0, labels.length - 1);
    if (n === i) return;
    i = n;
    prev.disabled = i === 0;
    next.disabled = i === labels.length - 1;
    pos.innerHTML = `<b>${i + 1}</b>/${labels.length} · ${esc(labels[i])}`;
    onStep(i);
  }
  prev.addEventListener('click', () => go(i - 1));
  next.addEventListener('click', () => go(i + 1));
  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); }
  });
  return { el: h('div', { class: `${P}nav` }, prev, pos, next), go, get i() { return i; } };
}

function slider(label, { min, max, step = 1, value, show, oninput }) {
  const out = h('output');
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const sync = () => { out.textContent = show(+input.value); };
  input.addEventListener('input', () => { sync(); oninput(+input.value); });
  sync();
  return { el: h('label', { class: `${P}slider` }, h('span', null, label), input, out), input };
}

/** Tally marks: groups of five. `mine` of them are drawn in the look colour. */
function tallyHTML(n, mine = 0, approx = false) {
  let out = approx ? '<span class="ap">≈</span>' : '';
  for (let k = 0; k < n; k++) {
    if (k && k % 5 === 0) out += '<span class="gap"></span>';
    out += `<span class="st${k >= n - mine ? ' is-new' : ''}${approx && k === n - 1 ? ' is-ap' : ''}"></span>`;
  }
  return `<span class="${P}tally">${out}</span>`;
}

function marker(id, color) {
  return s('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L8,4 L0,8 z', style: `fill:${color}` }));
}

/* ======================================================= static diagrams */

/*
 * A diagram spec has a wide and a tall layout. nodes: {x,y,w,h,kind,lines};
 * kind is 'proc' (solid) or 'db' (dashed). edges: {pts,label,lx,ly,anchor}.
 * marks: {x,y,n,bad,label,lx,ly,anchor}. notes: {x,y,text,cls,anchor}.
 */
function drawDiagram(L, label) {
  const [W, H] = L.vb;
  const id = `${P}m${++UID}`;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: `${P}diagram` });
  svg.append(s('defs', null, marker(id, 'var(--t-ink)')));
  for (const n of L.titles || []) svg.append(s('text', { x: n.x, y: n.y, class: `${P}t-title`, 'text-anchor': n.anchor || 'start' }, n.text));
  for (const r of L.rules || []) svg.append(s('path', { d: `M${r.map((q) => q.join(',')).join(' L')}`, class: `${P}rule` }));
  for (const e of L.edges) {
    svg.append(s('path', { d: `M${e.pts.map((q) => q.join(',')).join(' L')}`, class: `${P}edge`, 'marker-end': e.noArrow ? null : `url(#${id})` }));
    if (e.label) svg.append(s('text', { x: e.lx, y: e.ly, class: `${P}t-edge`, 'text-anchor': e.anchor || 'start' }, e.label));
  }
  for (const n of L.nodes) {
    const g = s('g');
    g.append(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, class: `${n.kind === 'db' ? `${P}db` : `${P}proc`}${n.tone ? ` is-${n.tone}` : ''}` }));
    const lines = n.lines;
    const total = 15 + (lines.length - 1) * 13;
    let y = n.y + n.h / 2 - total / 2 + 11;
    lines.forEach((t, k) => {
      g.append(s('text', { x: n.x + n.w / 2, y, class: k ? (n.tone ? `${P}t-${n.tone}` : `${P}t-sub`) : `${P}t-name`, 'text-anchor': 'middle' }, t));
      y += k ? 13 : 15;
    });
    svg.append(g);
  }
  for (const m of L.marks || []) {
    const g = m.k ? s('g', { class: `${P}hit${m.on ? ' is-on' : ''}`, role: 'button', tabindex: 0, 'data-k': m.k, 'aria-label': m.aria || m.label }) : svg;
    if (m.k) g.append(s('circle', { cx: m.x, cy: m.y, r: 18, class: `${P}hit-area` }));
    g.append(s('circle', { cx: m.x, cy: m.y, r: m.k ? 11 : 9, class: m.bad ? `${P}mk-bad` : `${P}mk` }));
    g.append(s('text', { x: m.x, y: m.y + 3.6, class: `${P}t-mk`, 'text-anchor': 'middle' }, String(m.n)));
    if (m.label) g.append(s('text', { x: m.lx, y: m.ly, class: m.bad ? `${P}t-bad` : `${P}t-sub`, 'text-anchor': m.anchor || 'start' }, m.label));
    if (m.k) svg.append(g);
  }
  for (const n of L.notes || []) svg.append(s('text', { x: n.x, y: n.y, class: n.cls, 'text-anchor': n.anchor || 'start' }, n.text));
  return svg;
}

function staticDiagram(spec, keyItems) {
  return (fig, app) => {
    const stage = h('div');
    let cur = null;
    const draw = () => {
      const L = app.clientWidth < (spec.breakAt || 560) ? spec.tall : spec.wide;
      if (L === cur) return;
      cur = L;
      stage.replaceChildren(drawDiagram(L, fig.getAttribute('aria-label') || ''));
    };
    app.append(stage, legend(keyItems));
    new ResizeObserver(draw).observe(app);
    draw();
  };
}

const REQUEST = {
  breakAt: 520,
  wide: {
    vb: [640, 196],
    nodes: [
      { x: 10, y: 24, w: 110, h: 52, lines: ['App', 'client'] },
      { x: 200, y: 24, w: 150, h: 52, lines: ['Backend', 'your service'] },
      { x: 470, y: 24, w: 160, h: 52, kind: 'db', lines: ['DB', 'your state'] },
      { x: 200, y: 132, w: 150, h: 52, lines: ['External', 'third-party API'] },
    ],
    edges: [
      { pts: [[120, 50], [198, 50]] },
      { pts: [[350, 50], [468, 50]] },
      { pts: [[275, 76], [275, 130]] },
    ],
    marks: [
      { x: 160, y: 50, n: 1 },
      { k: 'w', x: 410, y: 50, n: 2, bad: true, label: 'write fails', lx: 410, ly: 82, anchor: 'middle' },
      { k: 'x', x: 350, y: 24, n: '✕', bad: true, label: 'dies after 2', lx: 366, ly: 16, aria: 'Backend dies after step 2' },
      { k: 'c', x: 275, y: 104, n: 3, bad: true, label: 'call fails', lx: 294, ly: 108 },
    ],
  },
  tall: {
    vb: [360, 290],
    nodes: [
      { x: 105, y: 8, w: 150, h: 46, lines: ['App', 'client'] },
      { x: 105, y: 104, w: 150, h: 50, lines: ['Backend', 'your service'] },
      { x: 8, y: 232, w: 150, h: 50, kind: 'db', lines: ['DB', 'your state'] },
      { x: 202, y: 232, w: 150, h: 50, lines: ['External', 'third-party API'] },
    ],
    edges: [
      { pts: [[180, 54], [180, 102]] },
      { pts: [[140, 154], [85, 230]] },
      { pts: [[220, 154], [275, 230]] },
    ],
    marks: [
      { x: 180, y: 79, n: 1 },
      { k: 'w', x: 112, y: 192, n: 2, bad: true, label: 'write fails', lx: 96, ly: 196, anchor: 'end' },
      { k: 'x', x: 255, y: 104, n: '✕', bad: true, label: 'dies after 2', lx: 271, ly: 108, aria: 'Backend dies after step 2' },
      { k: 'c', x: 248, y: 192, n: 3, bad: true, label: 'call fails', lx: 264, ly: 196 },
    ],
  },
};

/* What each failure leaves behind, written next to the box it describes.
   Node order in REQUEST: App, Backend, DB, External. */
const REQ_OUT = {
  w: {
    subs: [null, ['returns an error', 'bad'], ['no row, or unknown', 'bad'], ['not called', '']],
    text: 'The app can retry the whole request. If the write timed out, the backend cannot tell whether it committed, so the retry must be safe to repeat.',
  },
  x: {
    subs: [null, ['gone', 'bad'], ['order row written', 'safe'], ['never called', 'bad']],
    text: 'The database says the order exists, and nothing records that step 3 is still owed. Nobody retries it.', bad: true,
  },
  c: {
    subs: [null, ['must retry later', 'bad'], ['order row written', 'safe'], ['call failed', 'bad']],
    text: 'The backend must remember to retry step 3, even if it restarts. That needs a durable record of what is owed, written with step 2: an outbox row, or a workflow engine\'s state.',
  },
};

function initRequest(fig, app) {
  let sel = null; let L = null;
  const stage = h('div');
  const out = h('p', { class: `${P}note`, 'aria-live': 'polite' });
  function draw() {
    const base = app.clientWidth < REQUEST.breakAt ? REQUEST.tall : REQUEST.wide;
    L = {
      ...base,
      nodes: base.nodes.map((n, k) => {
        const o = sel && REQ_OUT[sel].subs[k];
        return o ? { ...n, lines: [n.lines[0], o[0]], tone: o[1] || undefined } : n;
      }),
      marks: base.marks.map((m) => ({ ...m, on: m.k && m.k === sel })),
    };
    stage.replaceChildren(drawDiagram(L, fig.getAttribute('aria-label') || ''));
    stage.querySelectorAll('[data-k]').forEach((g) => {
      const pick = () => { sel = g.dataset.k; draw(); stage.querySelector(`[data-k="${sel}"]`)?.focus(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(); e.preventDefault(); } });
    });
    out.className = `${P}note${sel && REQ_OUT[sel].bad ? ' is-bad' : ''}`;
    out.innerHTML = sel ? REQ_OUT[sel].text : '<b>Tap a red mark.</b> Each box then shows what that failure leaves behind.';
  }
  let wasTall = null;
  new ResizeObserver(() => { const tall = app.clientWidth < REQUEST.breakAt; if (tall !== wasTall) { wasTall = tall; draw(); } }).observe(app);
  app.append(stage, out, legend([['proc', 'process'], ['table', 'data at rest'], ['bad', 'failure, or work lost'], ['safe', 'durable']]));
  draw();
}

const SERVICES = {
  wide: {
    vb: [900, 382],
    nodes: [
      { x: 340, y: 8, w: 220, h: 50, lines: ['your worker', 'your code · any number of replicas'] },
      { x: 150, y: 98, w: 600, h: 50, lines: ['frontend', 'gRPC · auth · rate limits · routing'] },
      { x: 150, y: 188, w: 180, h: 64, lines: ['history', 'workflow state', 'event history · timers'] },
      { x: 360, y: 188, w: 180, h: 64, lines: ['matching', 'task queues', 'dispatch to workers'] },
      { x: 570, y: 188, w: 180, h: 64, lines: ['worker service', "Temporal's own", 'system workflows'] },
      { x: 250, y: 302, w: 400, h: 70, kind: 'db', lines: ['Postgres', '37 tables: executions, history_node,', 'shards, tasks, timer_tasks, …'] },
    ],
    edges: [
      { pts: [[450, 58], [450, 96]], label: 'gRPC', lx: 458, ly: 82 },
      { pts: [[240, 148], [240, 186]] }, { pts: [[450, 148], [450, 186]] }, { pts: [[660, 148], [660, 186]] },
      { pts: [[240, 252], [330, 300]] }, { pts: [[450, 252], [450, 300]] }, { pts: [[660, 252], [570, 300]] },
    ],
    notes: [
      { x: 762, y: 214, text: 'stateless:', cls: `${P}t-sub`, anchor: 'start' },
      { x: 762, y: 228, text: 'add replicas', cls: `${P}t-sub`, anchor: 'start' },
      { x: 662, y: 341, text: 'all durable state', cls: `${P}t-safe` },
    ],
  },
  tall: {
    vb: [360, 520],
    nodes: [
      { x: 60, y: 8, w: 240, h: 50, lines: ['your worker', 'your code · many replicas'] },
      { x: 8, y: 92, w: 344, h: 50, lines: ['frontend', 'gRPC · auth · routing'] },
      { x: 40, y: 178, w: 280, h: 50, lines: ['history', 'workflow state · event history'] },
      { x: 40, y: 242, w: 280, h: 50, lines: ['matching', 'task queues · dispatch'] },
      { x: 40, y: 306, w: 280, h: 50, lines: ['worker service', "Temporal's own workflows"] },
      { x: 40, y: 420, w: 280, h: 70, kind: 'db', lines: ['Postgres', '37 tables', 'executions · history_node · …'] },
    ],
    edges: [
      { pts: [[180, 58], [180, 90]], label: 'gRPC', lx: 188, ly: 78 },
      { pts: [[20, 142], [20, 203], [38, 203]] },
      { pts: [[20, 142], [20, 267], [38, 267]] },
      { pts: [[20, 142], [20, 331], [38, 331]] },
      { pts: [[320, 203], [342, 203], [342, 455], [322, 455]], noArrow: true },
      { pts: [[320, 267], [342, 267]], noArrow: true },
      { pts: [[320, 331], [342, 331]], noArrow: true },
      { pts: [[342, 440], [322, 440]] },
    ],
    notes: [
      { x: 180, y: 384, text: 'stateless: add replicas to scale', cls: `${P}t-sub`, anchor: 'middle' },
      { x: 180, y: 510, text: 'all durable state', cls: `${P}t-safe`, anchor: 'middle' },
    ],
  },
};

const DEPLOY = {
  wide: {
    vb: [900, 330],
    titles: [{ x: 20, y: 20, text: 'TEMPORAL · your worker + 4 services' }, { x: 470, y: 20, text: 'ABSURD · your workers only' }],
    rules: [[[450, 8], [450, 322]]],
    nodes: [
      { x: 120, y: 38, w: 200, h: 46, lines: ['your worker', '1 or N'] },
      { x: 120, y: 112, w: 200, h: 40, lines: ['frontend'] },
      { x: 40, y: 180, w: 110, h: 40, lines: ['history'] },
      { x: 165, y: 180, w: 110, h: 40, lines: ['matching'] },
      { x: 290, y: 180, w: 110, h: 40, lines: ['worker svc'] },
      { x: 95, y: 254, w: 250, h: 58, kind: 'db', lines: ['Postgres', '37 tables'] },
      { x: 560, y: 38, w: 220, h: 46, lines: ['your worker', '1 or N'] },
      { x: 545, y: 254, w: 250, h: 58, kind: 'db', lines: ['Postgres', '5 tables per queue'] },
    ],
    edges: [
      { pts: [[220, 84], [220, 110]], label: 'gRPC', lx: 228, ly: 101 },
      { pts: [[170, 152], [95, 178]] }, { pts: [[220, 152], [220, 178]] }, { pts: [[270, 152], [345, 178]] },
      { pts: [[95, 220], [160, 252]] }, { pts: [[220, 220], [220, 252]] }, { pts: [[345, 220], [280, 252]] },
      { pts: [[670, 84], [670, 252]], label: 'SQL: stored procedures', lx: 680, ly: 172 },
    ],
  },
  tall: {
    vb: [360, 540],
    titles: [{ x: 8, y: 16, text: 'TEMPORAL · worker + 4 services' }, { x: 8, y: 334, text: 'ABSURD · workers only' }],
    rules: [[[8, 312], [352, 312]]],
    nodes: [
      { x: 80, y: 28, w: 200, h: 44, lines: ['your worker', '1 or N'] },
      { x: 80, y: 100, w: 200, h: 38, lines: ['frontend'] },
      { x: 8, y: 166, w: 108, h: 38, lines: ['history'] },
      { x: 126, y: 166, w: 108, h: 38, lines: ['matching'] },
      { x: 244, y: 166, w: 108, h: 38, lines: ['worker svc'] },
      { x: 55, y: 236, w: 250, h: 54, kind: 'db', lines: ['Postgres', '37 tables'] },
      { x: 80, y: 348, w: 200, h: 44, lines: ['your worker', '1 or N'] },
      { x: 55, y: 474, w: 250, h: 54, kind: 'db', lines: ['Postgres', '5 tables per queue'] },
    ],
    edges: [
      { pts: [[180, 72], [180, 98]], label: 'gRPC', lx: 188, ly: 90 },
      { pts: [[130, 138], [62, 164]] }, { pts: [[180, 138], [180, 164]] }, { pts: [[230, 138], [298, 164]] },
      { pts: [[62, 204], [120, 234]] }, { pts: [[180, 204], [180, 234]] }, { pts: [[298, 204], [240, 234]] },
      { pts: [[180, 392], [180, 472]], label: 'SQL: stored procedures', lx: 190, ly: 437 },
    ],
  },
};

/* ================================================== the event history */

const ACT = ['ProcessPayment', 'ReserveInventory', 'SendNotification'];
const actName = (k) => ACT[k - 1] || `Activity${k}`;

/** Events of a workflow with n activities, and the history_node batch each lands in. */
function historyOf(n) {
  const ev = [
    [1, 'WorkflowExecutionStarted'], [2, 'WorkflowTaskScheduled'], [3, 'WorkflowTaskStarted'], [4, 'WorkflowTaskCompleted'],
  ];
  for (let k = 1; k <= n; k++) {
    const b = 4 + 6 * (k - 1);
    ev.push([b + 1, `ActivityTaskScheduled · ${actName(k)}`], [b + 2, 'ActivityTaskStarted'], [b + 3, 'ActivityTaskCompleted'],
      [b + 4, 'WorkflowTaskScheduled'], [b + 5, 'WorkflowTaskStarted'], [b + 6, 'WorkflowTaskCompleted']);
  }
  ev.push([5 + 6 * n, 'WorkflowExecutionCompleted']);
  // batches: [1,2] [3], then per activity [b,b+1] [b+2..b+4] [b+5], then [4+6n, 5+6n]
  const node = {};
  const put = (ids) => ids.forEach((x) => { node[x] = ids[0]; });
  put([1, 2]); put([3]);
  for (let k = 1; k <= n; k++) { const b = 4 + 6 * (k - 1); put([b, b + 1]); put([b + 2, b + 3, b + 4]); put([b + 5]); }
  put([4 + 6 * n, 5 + 6 * n]);
  return { ev, node };
}

const WHY = ['workflow decided to run it', 'worker picked it up', 'worker returned the result', 'workflow wakes up again',
  'worker runs the workflow code', 'workflow made its next decision'];
const MEASURED_NODES = { 1: 6, 3: 12, 5: 18 };

function initTape(fig, app) {
  let n = 3;
  const read = h('div', { class: `${P}read`, 'aria-live': 'polite' });
  const tape = h('div', { class: `${P}tape`, role: 'list' });
  const sl = slider('activities, N', { min: 1, max: 10, value: n, show: (v) => String(v), oninput: (v) => { n = v; draw(); } });
  app.append(h('div', { class: `${P}ctl` }, sl.el), read, tape,
    legend([['data', 'event IDs, history_node rows'], ['look', 'the 6 events of one activity'], ['opt', 'control']]));

  function row(id, name, nodeId, isFirst, why) {
    return `<div class="${P}ev${why ? ' is-look' : ''}${isFirst ? ' is-first' : ''}" role="listitem">`
      + `<span class="nd">${isFirst ? `node ${nodeId}` : ''}</span><span class="id">${id}</span>`
      + `<span class="nm">${esc(name)}${why ? `<em>${esc(why)}</em>` : ''}</span></div>`;
  }
  function draw() {
    const { ev, node } = historyOf(n);
    const E = 4 + 6 * n + 1; const R = 3 + 3 * n;
    read.innerHTML = `<span><b>${E}</b> events = 4 + 6 × ${n} + 1</span><span><b>${R}</b> history_node rows = 3 + 3 × ${n}${MEASURED_NODES[n] ? ` <i>(measured: ${MEASURED_NODES[n]})</i>` : ''}</span>`;
    const show = (id) => n <= 4 || id <= 16 || id >= 5 + 6 * (n - 1);
    let html = ''; let hidden = false; let lastNode = -1;
    const head = (t) => `<div class="${P}grp">${esc(t)}</div>`;
    html += head('start and first workflow task · 4 events');
    for (const [id, name] of ev) {
      const k = Math.floor((id - 5) / 6) + 1; // activity index for ids 5..4+6n
      if (id >= 5 && id <= 4 + 6 * n && (id - 5) % 6 === 0) {
        if (show(id)) html += head(`activity ${k}: ${actName(k)} · 6 events`);
      }
      if (id === 5 + 6 * n) html += head('close · 1 event');
      if (!show(id)) {
        if (!hidden) {
          html += `<div class="${P}skip">activities 3–${n - 1}: the same 6 events each, IDs 17–${4 + 6 * (n - 1)}</div>`;
          hidden = true;
        }
        continue;
      }
      const first = node[id] !== lastNode;
      lastNode = node[id];
      const why = id >= 5 && id <= 10 ? WHY[id - 5] : '';
      html += row(id, name, node[id], first, why);
    }
    tape.innerHTML = html;
  }
  draw();
}

/* ======================================================== the receipts */

function initReceipts(fig, app) {
  const { ev } = historyOf(3);
  const line = (a, b = '', cls = '') => `<div class="ln ${cls}"><span>${a}</span><span>${b}</span></div>`;
  const t = `<div class="${P}rcpt"><div class="hd"><b>TEMPORAL</b><span>OrderFulfillmentWorkflow</span><span>3 activities · 1 order</span></div>`
    + `<div class="body">${ev.map(([id, name]) => `<div class="ev"><span class="id">${id}</span><span class="nm">${esc(name.replace(' · ', ' '))}</span></div>`).join('')}</div>`
    + `<div class="ft">${line('history events', '<b>23</b>')}${line('history_node rows', '<b>12</b>')}${line('tables touched', '<b>16</b> of 37')}${line('SQL statements', '<b>≈ 145</b>', 'big')}</div></div>`;
  const a = `<div class="${P}rcpt"><div class="hd"><b>ABSURD</b><span>order-fulfillment</span><span>3 steps · 1 order</span></div>`
    + `<div class="body">${[['t_', 'task row'], ['r_', 'run row'], ['c_', 'process-payment'], ['c_', 'reserve-inventory'], ['c_', 'send-notification']]
      .map(([id, name]) => `<div class="ev"><span class="id">${id}</span><span class="nm">${name}</span></div>`).join('')}</div>`
    + `<div class="ft">${line('checkpoints', '<b>3</b>')}${line('rows written', '<b>5</b>')}${line('tables touched', '<b>3</b> of 5')}${line('SQL statements', '<b>≈ 32</b>', 'big')}</div></div>`;
  app.innerHTML = `<div class="${P}pair">${t}${a}</div>`;
}

/* ===================================================== ONE ACTIVITY TRIP */

const LANES = [['worker', 'your worker'], ['fe', 'frontend'], ['hist', 'history'], ['match', 'matching'], ['pg', 'Postgres']];
const LX = { worker: 0.09, fe: 0.27, hist: 0.46, match: 0.66, pg: 0.87 };

const TABLES = [
  ['shards', 'shards'], ['cur', 'current_executions'], ['exe', 'executions'], ['hn', 'history_node'],
  ['aim', 'activity_info_maps'], ['tt', 'transfer_tasks'], ['tmr', 'timer_tasks'], ['mq', 'tasks, task_queues'],
];

const FENCE = (next) => [
  'BEGIN',
  'SELECT range_id FROM shards WHERE shard_id = «3» FOR SHARE',
  'SELECT … FROM current_executions WHERE … FOR UPDATE',
  'UPDATE current_executions SET …',
  'SELECT db_record_version, next_event_id FROM executions WHERE … FOR UPDATE',
  `UPDATE executions SET next_event_id = «${next}», data = «<blob>», …`,
];

const TRIP = [
  {
    label: 'Schedule', events: [4, 5],
    msgs: [
      { from: 'worker', to: 'hist', via: 'fe', label: 'RespondWorkflowTaskCompleted' },
      { from: 'hist', to: 'pg', db: 8, label: 'events 4–5, then tx 1' },
    ],
    call: 'Workflow code reaches <code>ExecuteActivity(ProcessPayment)</code>. The SDK sends one <code>ScheduleActivityTask</code> command. History appends two events, then runs one transaction.',
    sql: [
      'INSERT INTO history_node … node_id = «4»     // events 4–5',
      ...FENCE(6),
      'INSERT INTO activity_info_maps …             // ProcessPayment, scheduled',
      'INSERT INTO transfer_tasks …                 // ActivityTask → matching',
      'COMMIT',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 8],
    touch: { hn: 1, shards: 1, cur: 2, exe: 2, aim: 1, tt: 1 },
    note: 'Every transaction starts with the shard lock. If another History host took shard 3, it bumped <code>range_id</code> when it did. This check then fails, and this host stops writing.',
  },
  {
    label: 'Dispatch', events: [],
    msgs: [
      { from: 'hist', to: 'match', label: 'AddActivityTask' },
      { from: 'match', to: 'pg', db: 1, maybe: true, label: 'tasks, if no worker waits' },
    ],
    call: 'A loop in History reads <code>transfer_tasks</code> in ranges and calls Matching. If a worker is already long-polling, Matching hands the task over in memory. If not, it writes the task to <code>tasks</code> first.',
    sql: [
      '// transfer queue: one range read serves many workflows on the shard',
      'SELECT task_id, data FROM transfer_tasks',
      '  WHERE shard_id = «3» AND task_id >= $2 AND task_id < $3 ORDER BY task_id LIMIT $4',
      '// matching, only when no worker is waiting:',
      'INSERT INTO tasks …',
    ],
    hot: [4],
    touch: { mq: 1 },
    note: 'Workers never query Postgres; they long-poll Matching over gRPC. In the benchmark, <code>tasks</code> and <code>task_queues</code> average about 2 statements per activity, one per dispatch.',
  },
  {
    label: 'Start', events: [],
    msgs: [
      { from: 'match', to: 'hist', label: 'RecordActivityTaskStarted' },
      { from: 'hist', to: 'pg', db: 7, label: 'tx 2, no event' },
      { from: 'match', to: 'worker', via: 'fe', reply: true, label: 'the poll returns the task' },
    ],
    call: 'Before Matching answers the worker\'s poll, it calls History to record the start.',
    sql: [
      ...FENCE(6),
      'INSERT INTO activity_info_maps … ON CONFLICT DO UPDATE   // started, attempt 1',
      'INSERT INTO timer_tasks …                                // StartToClose, 30 s',
      'COMMIT',
    ],
    hot: [1, 2, 3, 4, 5, 6, 7],
    touch: { shards: 1, cur: 2, exe: 2, aim: 1, tmr: 1 },
    note: 'No history event yet. The activity has a retry policy (the server adds a default one), so History keeps <b>ActivityTaskStarted</b> in the <code>executions</code> blob and writes it when the activity closes. A retry adds no events.',
  },
  {
    label: 'Complete', events: [6, 7, 8],
    msgs: [
      { from: 'worker', to: 'hist', via: 'fe', label: 'RespondActivityTaskCompleted' },
      { from: 'hist', to: 'pg', db: 9, label: 'events 6–8, then tx 3' },
    ],
    call: 'The worker runs <code>ProcessPayment</code> and reports the result. History appends three events and schedules a workflow task, so the workflow can wake up.',
    sql: [
      'INSERT INTO history_node … node_id = «6»     // events 6–8',
      ...FENCE(9),
      'DELETE FROM activity_info_maps …             // activity closed',
      'INSERT INTO transfer_tasks …                 // WorkflowTask → matching',
      'INSERT INTO timer_tasks …                    // sticky ScheduleToStart, 5 s',
      'COMMIT',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 8, 9],
    touch: { hn: 1, shards: 1, cur: 2, exe: 2, aim: 1, tt: 1, tmr: 1 },
    note: 'The workflow task goes to this worker\'s <b>sticky queue</b>, because the worker still has the workflow in memory. The 5 s timer moves it to the normal queue if that worker does not pick it up.',
  },
  {
    label: 'Wake', events: [9],
    msgs: [
      { from: 'hist', to: 'match', label: 'AddWorkflowTask' },
      { from: 'match', to: 'hist', label: 'RecordWorkflowTaskStarted' },
      { from: 'hist', to: 'pg', db: 8, label: 'event 9, tx 4, read 4–9' },
      { from: 'match', to: 'pg', db: 1, maybe: true, label: 'tasks, if no worker waits' },
      { from: 'match', to: 'worker', via: 'fe', reply: true, label: 'events 4–9' },
    ],
    call: 'The transfer queue sends the workflow task to Matching, and the worker\'s poll picks it up. History records the start and reads the new events for the worker.',
    sql: [
      'INSERT INTO history_node … node_id = «9»     // event 9',
      ...FENCE(10),
      'INSERT INTO timer_tasks …                    // workflow task StartToClose, 10 s',
      'COMMIT',
      'SELECT … FROM history_node WHERE … node_id >= «4»   // events 4–9 for the worker',
      '// matching, only when no worker is waiting: INSERT INTO tasks …',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 9, 10],
    touch: { hn: 2, shards: 1, cur: 2, exe: 2, tmr: 1, mq: 1 },
    note: 'The worker is sticky, so History sends only the events after the last workflow task it started (event 3): events 4–9. A worker without the workflow in memory gets the full history and replays it.',
  },
  {
    label: 'Resume', events: [],
    msgs: [{ from: 'worker', to: 'worker', self: true, label: 'code continues to ReserveInventory' }],
    call: 'The SDK applies events 4–9 to the workflow in memory. <code>.Get()</code> returns the result stored in event 7, and the code runs until the next <code>ExecuteActivity</code>. That starts step 1 again, with events 10–11.',
    sql: null, touch: {}, note: '',
  },
];

/* Measured per-activity deltas (the post's N=1 vs N=5 table), by table. */
const TRIP_MEASURED = { shards: '4', cur: '8', exe: '8', hn: '4', aim: '3', tt: '2', tmr: '3', mq: '2.1' };

function initTrip(fig, app) {
  let cur = 0; let W = 0; let guess = 0;
  const GUESSES = [5, 15, 35, 80];
  const guessRow = h('div', { class: `${P}guess` }, h('span', null, 'Guess first. SQL statements for one activity:'),
    ...GUESSES.map((g) => {
      const b = h('button', { class: `${P}opt`, type: 'button', 'aria-pressed': 'false' }, `≈ ${g}`);
      b.addEventListener('click', () => {
        guess = g;
        guessRow.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        paint();
      });
      return b;
    }));
  const meter = h('div', { class: `${P}meter`, 'aria-live': 'polite' });
  const lanesHead = h('div', { class: `${P}lanes-h` });
  const seq = h('div', { class: `${P}seq` });
  const detail = h('div', { class: `${P}detail` });
  const bands = TRIP.map((st, k) => {
    const b = h('div', { class: `${P}band`, role: 'button', tabindex: 0, 'aria-label': `Step ${k + 1}: ${st.label}` });
    b.addEventListener('click', () => nav.go(k));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { nav.go(k); e.preventDefault(); } });
    seq.append(b);
    return b;
  });
  const nav = stepNav(fig, TRIP.map((t) => t.label), (i) => { cur = i; paint(); });
  app.append(guessRow, h('div', { class: `${P}bar` }, nav.el, meter), lanesHead, seq,
    legend([['proc', 'process'], ['table', 'database'], ['look', 'this step'], ['line', 'earlier steps'], ['data', 'SQL statements (tally), events']]));

  const totals = (upTo) => {
    const t = {};
    for (let k = 0; k <= upTo; k++) for (const [id, n] of Object.entries(TRIP[k].touch)) t[id] = (t[id] || 0) + n;
    return t;
  };

  function drawLanes() {
    const svg = s('svg', { viewBox: `0 0 ${W} 30`, class: `${P}lanes-svg`, 'aria-hidden': 'true' });
    for (const [id, name] of LANES) {
      const x = LX[id] * W; const w = Math.min(W * 0.18, 118);
      svg.append(s('rect', { x: x - w / 2, y: 2, width: w, height: 24, class: id === 'pg' ? `${P}db` : `${P}proc` }));
      svg.append(s('text', { x, y: 18, class: `${P}t-lane`, 'text-anchor': 'middle' }, W < 480 && id === 'worker' ? 'worker' : name));
    }
    lanesHead.replaceChildren(svg);
  }

  function drawBand(k) {
    const st = TRIP[k];
    const rowH = 34; const top = 22;
    const H = top + st.msgs.length * rowH + 4;
    const id = `${P}a${++UID}`;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `${P}band-svg`, 'aria-hidden': 'true' });
    svg.append(s('defs', null, marker(`${id}i`, 'var(--t-ink)'), marker(`${id}p`, 'var(--t-purple)')));
    for (const [lid] of LANES) svg.append(s('line', { x1: LX[lid] * W, x2: LX[lid] * W, y1: 0, y2: H, class: `${P}life` }));
    svg.append(s('text', { x: 4, y: 14, class: `${P}t-step` }, `${String(k + 1).padStart(2, '0')} ${st.label.toUpperCase()}`));
    const col = k === cur ? 'p' : 'i';
    st.msgs.forEach((m, r) => {
      const y = top + r * rowH + 18;
      const x1 = LX[m.from] * W; const x2 = LX[m.to] * W;
      if (m.self) {
        svg.append(s('path', { d: `M${x1},${y - 8} h26 v12 h-22`, class: `${P}msg${m.reply ? ' is-reply' : ''}`, 'marker-end': `url(#${id}${col})` }));
        svg.append(s('text', { x: x1 + 32, y: y, class: `${P}t-msg` }, m.label));
        return;
      }
      const dir = Math.sign(x2 - x1);
      svg.append(s('path', { d: `M${x1},${y} L${x2 - dir * 3},${y}`, class: `${P}msg${m.reply || m.maybe ? ' is-reply' : ''}`, 'marker-end': `url(#${id}${col})` }));
      if (m.via) svg.append(s('circle', { cx: LX[m.via] * W, cy: y, r: 3, class: `${P}via` }));
      const mid = (x1 + x2) / 2;
      svg.append(s('text', { x: m.db ? Math.min(mid, W - 8) : mid, y: y - 6, class: `${P}t-msg halo`, 'text-anchor': m.db && mid + 60 > W ? 'end' : 'middle' }, m.label));
      if (m.db) {
        // tally under the arrowhead: one stroke per SQL statement
        const n = m.db; const sp = 3.6; const gap = 4;
        const width = n * sp + Math.floor((n - 1) / 5) * gap;
        let x = x2 - width - 6;
        for (let j = 0; j < n; j++) {
          if (j && j % 5 === 0) x += gap;
          svg.append(s('line', { x1: x, x2: x, y1: y + 4, y2: y + 14, class: `${P}tick${m.maybe ? ' is-maybe' : ''}` }));
          x += sp;
        }
        svg.append(s('text', { x: x2 - 2, y: y + 14, class: `${P}t-tick`, 'text-anchor': 'start' }, `${m.maybe ? '≈' : ''}${n}`));
      }
    });
    return svg;
  }

  function detailHTML(i) {
    const st = TRIP[i];
    const tot = totals(i);
    const last = i === TRIP.length - 1;
    const ledger = TABLES.map(([id, name]) => {
      const n = tot[id] || 0; const add = st.touch[id] || 0;
      return `<div class="${P}lg${add ? ' is-on' : ''}${n ? '' : ' is-zero'}${last ? ' has-m' : ''}"><span class="nm">${name}</span>${tallyHTML(n, add, id === 'mq' && n > 0)}<span class="n">${id === 'mq' && n ? '≈ ' : ''}${n}</span>${last ? `<span class="m">${TRIP_MEASURED[id]}</span>` : ''}</div>`;
    }).join('') + (last ? `<div class="${P}lg has-m is-tot"><span class="nm">total</span><span></span><span class="n">≈ 34</span><span class="m">≈ 34</span></div>` : '');
    const body = st.sql
      ? codeBlock(st.sql, st.hot)
      : codeBlock([
        'workflow.ExecuteActivity(ctx, ProcessPayment, params).Get(ctx, &p)  // «result from event 7»',
        'workflow.ExecuteActivity(ctx, ReserveInventory, params).Get(ctx, &i) // step 1 again',
      ], [0, 1]) + '<p>The right column is the benchmark: the per-activity delta between N = 1 and N = 5. The four transactions account for all of it.</p>';
    const guessLine = i === TRIP.length - 1 && guess
      ? `<p class="${P}note ${Math.abs(guess - 34) <= 5 ? 'is-good' : ''}">You guessed <b>${guess}</b>. One activity costs <b>≈ 34</b> statements: four transactions, and each one starts with the same five fencing statements.</p>`
      : '';
    return `<p class="${P}call">${st.call}</p>${guessLine}`
      + `<div class="${P}split"><div>${body}</div><div class="${P}ledger"><div class="hd${last ? ' has-m' : ''}"><span>statements this activity, by table</span>${last ? '<span>source</span><span>measured</span>' : ''}</div>${ledger}</div></div>`
      + (st.note ? `<p class="${P}note">${st.note}</p>` : '');
  }

  function paint() {
    bands.forEach((b, k) => {
      b.classList.toggle('is-on', k === cur);
      b.classList.toggle('is-past', k < cur);
      b.classList.toggle('is-future', k > cur);
      if (W) b.replaceChildren(drawBand(k));
    });
    detail.innerHTML = detailHTML(cur);
    bands[cur].after(detail);
    const sum = Object.values(totals(cur)).reduce((a, b) => a + b, 0);
    const digits = String(sum).padStart(3, '0').split('').map((d) => `<i>${d}</i>`).join('');
    meter.innerHTML = `<span>SQL this activity</span><span class="dg">${cur >= 1 ? '<em>≈</em>' : ''}${digits}</span>${guess ? `<span class="${P}yours">your guess ${guess}</span>` : ''}`;
  }

  function resize() {
    const w = Math.round(seq.clientWidth);
    if (!w || w === W) return;
    W = w;
    drawLanes();
    paint();
  }
  new ResizeObserver(resize).observe(seq);
  nav.go(0);
  resize();
}

/* ========================================================= CRASH REPLAY */

const T_CODE = {
  det: [['sig', 'func Order(ctx workflow.Context) error {'], ['p', '    exec(ctx, ProcessPayment)'], ['i', '    exec(ctx, ReserveInventory)'],
    ['n', '    exec(ctx, SendNotification)'], ['ret', '    return nil'], ['end', '}']],
  clock: [['sig', 'func Order(ctx workflow.Context) error {'], ['p', '    exec(ctx, ProcessPayment)'], ['i', '    exec(ctx, ReserveInventory)'],
    ['if', '    if time.Now().Hour() < 12 {'], ['n', '        exec(ctx, SendNotification)'], ['else', '    } else {'],
    ['e', '        exec(ctx, SendEmail)'], ['fi', '    }'], ['ret', '    return nil'], ['end', '}']],
};
const A_CODE = {
  det: [['sig', 'func order(t *Task) error {'], ['p', '    step(t, "process-payment", pay)'], ['i', '    step(t, "reserve-inventory", reserve)'],
    ['n', '    step(t, "send-notification", notify)'], ['ret', '    return nil'], ['end', '}']],
  clock: [['sig', 'func order(t *Task) error {'], ['p', '    step(t, "process-payment", pay)'], ['i', '    step(t, "reserve-inventory", reserve)'],
    ['if', '    if time.Now().Hour() < 12 {'], ['n', '        step(t, "send-notification", notify)'], ['else', '    } else {'],
    ['e', '        step(t, "send-email", email)'], ['fi', '    }'], ['ret', '    return nil'], ['end', '}']],
};

/* Annotations go after the line, or on their own line when the column is narrow. */
function annotated(src, ann = {}, hot = [], narrow = false) {
  const lines = []; const idx = [];
  for (const [k, t] of src) {
    const on = hot.includes(k);
    if (on) idx.push(lines.length);
    if (ann[k] && narrow) {
      lines.push(t);
      if (on) idx.push(lines.length);
      lines.push(`${t.match(/^ */)[0]}  // ${ann[k]}`);
    } else lines.push(ann[k] ? `${t}  // ${ann[k]}` : t);
  }
  return codeBlock(lines, idx);
}

const T_BASE = [['ev', '1–16', 'earlier events'], ['ev', '17', 'ActivityTaskScheduled · SendNotification']];
const A_BASE = [['ev', 'c_', 'process-payment'], ['ev', 'c_', 'reserve-inventory']];

const CR_STOPS = [
  { label: 'run', t: '11:59:40' }, { label: 'crash', t: '11:59:41', bad: true }, { label: 'timeout', t: '12:00:10' },
  { label: 'retry', t: '12:00:11' }, { label: 'sticky', t: '12:00:16' }, { label: 'replay', t: '12:00:16' }, { label: 'result', t: '' },
];

/* One state per stop for each system. rows: [kind, id, text]; kind is
   ev (stored before), new (written now), task (pending timer or lease), bad. */
function crState(i, v) {
  const clock = v === 'clock';
  const first = clock ? { if: '⟪11:59 → true⟫' } : {};
  const T = { code: T_CODE[v], ann: first, hot: [], rows: [...T_BASE], tone: '', status: '' };
  const A = { code: A_CODE[v], ann: first, hot: [], rows: [...A_BASE], tone: '', status: '' };
  const tRetry = [['ev', '17', 'ActivityTaskScheduled · SendNotification'], ['ev', '18', 'ActivityTaskStarted · attempt 2'], ['ev', '19', 'ActivityTaskCompleted'], ['ev', '20', 'WorkflowTaskScheduled · sticky queue of A']];
  const tSticky = [['ev', '21', 'WorkflowTaskTimedOut · ScheduleToStart'], ['ev', '22', 'WorkflowTaskScheduled · normal queue']];
  const aDone = clock
    ? [['ev', 'c_', 'send-email'], ['bad', 'r_', 'run 1 · attempt 1 · failed'], ['ev', 'r_', 'run 2 · attempt 2 · completed']]
    : [['ev', 'c_', 'send-notification'], ['bad', 'r_', 'run 1 · attempt 1 · failed'], ['ev', 'r_', 'run 2 · attempt 2 · completed']];
  const aAnn = clock
    ? { p: '⟪checkpoint⟫', i: '⟪checkpoint⟫', if: '⟦12:00 → false⟧', e: '⟦runs⟧' }
    : { p: '⟪checkpoint⟫', i: '⟪checkpoint⟫', n: '⟦runs again⟧' };
  const aDoneNote = clock
    ? 'Done at 12:00:11. Attempt 1 may already have sent the notification, and attempt 2 sent an email.'
    : 'Done at 12:00:11.';
  const doneA = () => { A.status = 'completed'; A.rows.push(...aDone); A.note = aDoneNote; A.tone = clock ? 'bad' : ''; A.ann = aAnn; };

  switch (i) {
    case 0:
      T.hot = ['n']; T.status = 'worker A';
      T.rows.push(['task', 'timer', 'StartToClose · due 12:00:10']);
      T.note = 'Worker A runs <code>SendNotification</code>, attempt 1. History recorded the start in the <code>executions</code> blob. <b>ActivityTaskStarted</b> is written when the activity closes.';
      A.hot = ['n']; A.status = 'worker A';
      A.rows.push(['task', 'r_', 'run 1 · attempt 1 · running · lease until 12:00:10']);
      A.note = 'Worker A runs <code>send-notification</code>. The <code>reserve-inventory</code> checkpoint also extended the lease by 30 s.';
      break;
    case 1:
      T.status = 'down'; T.tone = 'bad';
      T.rows.push(['task', 'timer', 'StartToClose · due 12:00:10']);
      T.note = 'Worker A is killed partway through <code>SendNotification</code>. Nothing reaches Temporal. The copy of the workflow in worker A\'s memory is gone.';
      A.status = 'down'; A.tone = 'bad';
      A.rows.push(['task', 'r_', 'run 1 · attempt 1 · running · lease until 12:00:10']);
      A.note = 'Worker A is killed partway through <code>notify</code>. The run row still says running, with a lease until 12:00:10.';
      break;
    case 2:
      T.status = 'waiting';
      T.rows.push(['new', 'timer', 'fired · attempt 2 due 12:00:11 (1 s backoff)']);
      T.note = 'The StartToClose timer fires. History moves the activity to attempt 2 in the <code>executions</code> blob and sets a retry timer. The default retry policy waits 1 s. No history event is written.';
      A.status = 'worker B';
      A.rows.push(['bad', 'r_', 'run 1 · attempt 1 · failed · $ClaimTimeout'], ['new', 'r_', 'run 2 · attempt 2 · running · worker B']);
      A.note = 'Worker B calls <code>claim_task</code>. It sweeps the expired lease: <code>fail_run</code> marks run 1 failed and inserts run 2. The same call then claims run 2 with <code>FOR UPDATE SKIP LOCKED</code>.';
      break;
    case 3:
      T.status = 'worker B';
      T.rows = [T_BASE[0], ...tRetry.map((r, k) => (k ? ['new', r[1], r[2]] : r)), ['task', 'timer', 'sticky ScheduleToStart · due 12:00:16']];
      T.note = 'Worker B runs <code>SendNotification</code> again. Only the activity runs; no workflow code runs. When it completes, History writes events 18–20 and sends the workflow task to worker A\'s sticky queue.';
      A.status = 'completed'; A.tone = clock ? 'bad' : 'good';
      A.ann = aAnn;
      A.hot = clock ? ['p', 'i', 'if', 'e'] : ['p', 'i', 'n'];
      A.rows.push(...aDone.map((r, k) => (k === 0 || k === 2 ? ['new', r[1], r[2]] : r)));
      A.note = clock
        ? 'Worker B runs <code>order()</code> from the first line. The first two steps return their checkpoints. The clock now says 12:00, so the code takes the other branch and runs <code>send-email</code>, which has no checkpoint. <b class="bad">The customer may get a notification and an email.</b>'
        : 'Worker B runs <code>order()</code> from the first line. <code>step()</code> reads each checkpoint first. The first two return their stored results. <code>send-notification</code> has none, so its body runs again, and the result is saved. Then <code>complete_run</code> finishes the task.';
      break;
    case 4:
      T.status = 'waiting';
      T.rows = [T_BASE[0], ...tRetry, ...tSticky.map((r) => ['new', r[1], r[2]])];
      T.note = 'Nobody polls worker A\'s sticky queue. After 5 s (the SDK\'s <code>StickyScheduleToStartTimeout</code>), History writes events 21–22 and moves the workflow task to the normal queue.';
      doneA();
      break;
    case 5:
      T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['new', '23', 'WorkflowTaskStarted · worker B']];
      if (clock) {
        T.status = 'blocked'; T.tone = 'bad';
        T.ann = { p: '⟪events 5, 7⟫', i: '⟪events 11, 13⟫', if: '⟦12:00 → false⟧', e: '⟦event 17 differs⟧' };
        T.hot = ['p', 'i', 'if', 'e'];
        T.rows.push(['bad', '24', 'WorkflowTaskFailed · nondeterminism']);
        T.note = 'Worker B has no copy in memory, so it gets events 1–23 and runs <code>Order()</code> from the first line. At the <code>if</code>, the clock says 12:00, so the code asks for <code>SendEmail</code>. Event 17 says <code>SendNotification</code>. The SDK stops with <code>[TMPRL1100] nondeterministic workflow</code>. Temporal retries the workflow task, and the workflow stays open until you deploy a fix: <code>workflow.Now(ctx)</code> instead of <code>time.Now()</code>.';
      } else {
        T.status = 'completed'; T.tone = 'good';
        T.ann = { p: '⟪events 5, 7⟫', i: '⟪events 11, 13⟫', n: '⟪events 17, 19⟫' };
        T.hot = ['p', 'i', 'n', 'ret'];
        T.rows.push(['new', '24', 'WorkflowTaskCompleted'], ['new', '25', 'WorkflowExecutionCompleted']);
        T.note = 'Worker B has no copy in memory, so it gets events 1–23 and runs <code>Order()</code> from the first line. Each <code>exec()</code> matches its recorded events and returns the stored result. No activity runs again. The code returns, and History writes events 24–25.';
      }
      doneA();
      break;
    default:
      doneA();
      if (clock) {
        T.status = 'blocked'; T.tone = 'bad';
        T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['ev', '23', 'WorkflowTaskStarted'], ['bad', '24', 'WorkflowTaskFailed · nondeterminism']];
        T.note = '<b>Stopped at the change.</b> <code>SendNotification</code> started twice. <code>SendEmail</code> never ran. The workflow waits for a code fix.';
        A.tone = 'bad';
        A.note = '<b>Ran both branches.</b> <code>notify</code> started once and may have finished, and <code>email</code> ran once. Nothing checked the code between steps.';
      } else {
        T.status = 'completed'; T.tone = 'good';
        T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['ev', '23–25', 'workflow task · ExecutionCompleted']];
        T.note = '<b>Started twice:</b> <code>SendNotification</code>, and the code in <code>Order()</code>. <b>Ran once:</b> <code>ProcessPayment</code>, <code>ReserveInventory</code>.';
        A.tone = 'good';
        A.note = '<b>Started twice:</b> <code>notify</code>, and the code in <code>order()</code>. <b>Ran once:</b> <code>pay</code>, <code>reserve</code>.';
      }
  }
  return { T, A };
}

/* Predict, then see: in the clock variant the reader answers before the
   surprising stop is revealed. */
const PREDICT = {
  A: {
    at: 3, from: 2,
    q: 'Worker B runs <code>order()</code> again at 12:00:11. Which step body runs?',
    choices: [['send-notification', false], ['send-email', true], ['none: Absurd stops with an error', false]],
  },
  T: {
    at: 5, from: 4,
    q: 'Worker B replays <code>Order()</code> at 12:00:16, so the <code>if</code> takes the other branch. What happens?',
    choices: [['it runs SendEmail', false], ['it reuses the result in event 19', false], ['it stops with an error', true]],
  },
};

function initCrash(fig, app) {
  let v = 'det'; let i = 0;
  const answer = { T: null, A: null };
  const opts = [['det', 'deterministic'], ['clock', 'reads time.Now()']];
  const optBtns = opts.map(([k, label]) => {
    const b = h('button', { class: `${P}opt`, type: 'button', 'aria-pressed': String(k === v) }, label);
    b.addEventListener('click', () => { v = k; optBtns.forEach((o, j) => o.setAttribute('aria-pressed', String(opts[j][0] === v))); show(); });
    return b;
  });
  const ruler = h('div', { class: `${P}ruler`, role: 'group', 'aria-label': 'Timeline' });
  const stopEls = CR_STOPS.map((st, k) => {
    const b = h('button', { class: `${P}stop${st.bad ? ' is-bad' : ''}`, type: 'button' },
      h('span', { class: 'dot' }), h('span', { class: 'lb' }, st.label), h('span', { class: 'tm' }, st.t || '—'));
    b.addEventListener('click', () => nav.go(k));
    ruler.append(b);
    return b;
  });
  const banner = h('div', { class: `${P}banner`, 'aria-live': 'polite' });
  const col = (name) => {
    const el = h('div', { class: `${P}col` });
    const stamp = h('span', { class: `${P}stamp` });
    const codeEl = h('div');
    const rows = h('div', { class: `${P}rows` });
    const note = h('p', { class: `${P}note` });
    el.append(h('div', { class: `${P}col-h` }, h('b', null, name), stamp), codeEl, h('div', { class: `${P}store` }, rows), note);
    return { el, stamp, codeEl, rows, note };
  };
  const CT = col('Temporal'); const CA = col('Absurd');
  CT.rows.parentNode.prepend(h('span', { class: `${P}store-h` }, 'history_node · timer_tasks'));
  CA.rows.parentNode.prepend(h('span', { class: `${P}store-h` }, 'c_default · r_default'));
  const cols = h('div', { class: `${P}cols` }, CT.el, CA.el);
  const nav = stepNav(fig, CR_STOPS.map((x) => x.label), (k) => { i = k; show(); });

  app.append(h('div', { class: `${P}bar` }, h('div', { class: `${P}opts` }, h('span', null, 'code between steps'), ...optBtns), nav.el),
    ruler, banner, cols,
    legend([['look', 'this moment: code run, rows written'], ['data', 'stored rows'], ['safe', 'result reused, completed'], ['bad', 'failure, runs again'], ['opt', 'option']]));

  function paint(C, st) {
    C.stamp.textContent = st.status;
    C.stamp.className = `${P}stamp ${st.status === 'completed' ? 'is-safe' : st.status === 'down' || st.status === 'blocked' ? 'is-bad' : ''}`;
    C.el.classList.toggle('is-down', st.status === 'down');
    C.codeEl.innerHTML = annotated(st.code, st.ann, st.hot, C.el.clientWidth < 440);
    C.rows.innerHTML = st.rows.map(([k, id, t]) => `<div class="${P}row ${P}r-${k}"><span class="id">${esc(id)}</span>${esc(t)}</div>`).join('');
    C.note.className = `${P}note${st.tone === 'bad' ? ' is-bad' : st.tone === 'good' ? ' is-good' : ''}`;
    C.note.innerHTML = st.note;
  }
  /** Replace a column's note with the question; the state shown is the stop before. */
  function ask(C, sys) {
    const pr = PREDICT[sys];
    C.note.className = `${P}note ${P}ask`;
    C.note.innerHTML = `<b>Predict.</b> ${pr.q}`;
    const row = h('span', { class: `${P}choices` });
    pr.choices.forEach(([label], k) => {
      const b = h('button', { class: `${P}opt`, type: 'button' }, label);
      b.addEventListener('click', () => { answer[sys] = k; show(); });
      row.append(b);
    });
    C.note.append(row);
  }
  const verdict = (sys) => {
    const pr = PREDICT[sys]; const k = answer[sys];
    const ok = pr.choices[k][1];
    return `<span class="${P}verdict ${ok ? 'is-good' : 'is-bad'}">You said: ${esc(pr.choices[k][0])}. ${ok ? 'Right.' : 'Not quite.'}</span> `;
  };
  function show() {
    const gate = (sys) => v === 'clock' && i === PREDICT[sys].at && answer[sys] === null;
    const st = crState(i, v);
    const T = gate('T') ? crState(PREDICT.T.from, v).T : st.T;
    const A = gate('A') ? crState(PREDICT.A.from, v).A : st.A;
    const cs = CR_STOPS[i];
    stopEls.forEach((b, k) => { b.classList.toggle('is-on', k === i); b.classList.toggle('is-past', k < i); b.setAttribute('aria-current', k === i ? 'step' : 'false'); });
    banner.innerHTML = cs.t
      ? `<b>${cs.t}</b> <span>sample time</span>`
      : '<b>Result.</b> Both systems start the interrupted step twice, so step bodies must be idempotent. They differ on the code between steps: Temporal runs it again and checks it against history; Absurd runs it again and trusts it.';
    paint(CT, T); paint(CA, A);
    for (const [sys, C] of [['T', CT], ['A', CA]]) {
      if (v !== 'clock') continue;
      if (gate(sys)) ask(C, sys);
      else if (i === PREDICT[sys].at && answer[sys] !== null) C.note.insertAdjacentHTML('afterbegin', verdict(sys));
    }
  }
  let wasNarrow = null;
  new ResizeObserver(() => { const n = CT.el.clientWidth < 440; if (n !== wasNarrow) { wasNarrow = n; show(); } }).observe(cols);
  nav.go(0);
}

/* =========================================================== COST MODEL */

const MEASURED = { T: [[1, 75.7], [3, 144.8], [5, 214.0], [10, 385.2]], A: [[1, 17.7], [3, 32.0], [5, 46.1], [10, 81.2]] };
const MODEL = { T: (n) => 40 + 35 * n, A: (n) => 11 + 7 * n };
const RATES = [1, 10, 50, 100, 250, 500, 1000, 2500, 5000];
const NMAX = 30; const YMAX = 1100;

function initCost(fig, app) {
  const S = { n: 20, r: 6 };
  const svg = s('svg', { role: 'img', 'aria-label': 'SQL statements per unit of work against the number of activities or steps', class: `${P}chart` });
  const meters = h('div', { class: `${P}meters`, 'aria-live': 'polite' });
  const note = h('p', { class: `${P}note` });
  const rn = slider('activities per workflow, N', { min: 1, max: NMAX, value: S.n, show: (x) => String(x), oninput: (x) => { S.n = x; draw(); } });
  const rr = slider('your workflows per second', { min: 0, max: RATES.length - 1, value: S.r, show: (x) => `${fmt(RATES[x])}/s`, oninput: (x) => { S.r = x; draw(); } });
  app.append(h('div', { class: `${P}ctl` }, rn.el, rr.el), meters, svg, note,
    legend([['data', 'measured'], ['line', 'Temporal, fitted'], ['dash', 'Absurd, fitted'], ['look', 'your N'], ['opt', 'controls']]));

  const dial = (name, formula, per, total, meas) => `<div class="${P}dial"><div class="nm">${name}</div><div class="f">${formula} = <b>${fmt(per)}</b> per unit${meas ? ` · measured ${meas}` : ''}</div>`
    + `<div class="dg">${fmt(total).split('').map((c) => (c === ',' ? '<span class="cm">,</span>' : `<i>${c}</i>`)).join('')}<span class="u">SQL/s</span></div></div>`;

  function draw() {
    const Wd = Math.max(300, app.clientWidth);
    const Ht = Wd < 500 ? 280 : 320;
    const m = { l: 46, r: 16, t: 20, b: 36 };
    const x = (n) => m.l + (n / NMAX) * (Wd - m.l - m.r);
    const y = (q) => Ht - m.b - (q / YMAX) * (Ht - m.t - m.b);
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    let o = `<rect x="${x(10)}" y="${m.t}" width="${x(NMAX) - x(10)}" height="${Ht - m.t - m.b}" class="${P}extra"/>`;
    o += `<text x="${x(NMAX) - 6}" y="${Ht - m.b - 8}" class="${P}t-sub" text-anchor="end">not measured past N = 10</text>`;
    for (let q = 0; q <= YMAX; q += 200) {
      o += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(q)}" y2="${y(q)}" class="${P}grid"/>`;
      o += `<text x="${m.l - 6}" y="${y(q) + 3.5}" class="${P}t-sub" text-anchor="end">${q}</text>`;
    }
    for (let n = 0; n <= NMAX; n += 5) o += `<text x="${x(n)}" y="${Ht - m.b + 15}" class="${P}t-sub" text-anchor="middle">${n}</text>`;
    o += `<text x="${Wd - m.r}" y="${Ht - 4}" class="${P}t-sub" text-anchor="end">activities or steps per unit, N →</text>`;
    o += `<text x="${m.l}" y="${m.t - 7}" class="${P}t-sub">↑ SQL statements per unit</text>`;
    o += `<rect x="${m.l}" y="${m.t}" width="${Wd - m.l - m.r}" height="${Ht - m.t - m.b}" class="${P}axis"/>`;
    o += `<path d="M${x(0)},${y(MODEL.T(0))} L${x(NMAX)},${y(MODEL.T(NMAX))}" class="${P}fit"/>`;
    o += `<path d="M${x(0)},${y(MODEL.A(0))} L${x(NMAX)},${y(MODEL.A(NMAX))}" class="${P}fit is-dash"/>`;
    const tn = Wd < 500 ? 13 : 17;
    o += `<text x="${x(tn) + 8}" y="${y(MODEL.T(tn)) + 18}" class="${P}t-name halo">Temporal 40 + 35·N</text>`;
    o += `<text x="${x(NMAX) - 6}" y="${y(MODEL.A(NMAX - 2)) - 12}" class="${P}t-name halo" text-anchor="end">Absurd 11 + 7·N</text>`;
    for (const [n, q] of [...MEASURED.T, ...MEASURED.A]) o += `<circle cx="${x(n)}" cy="${y(q)}" r="4.5" class="${P}pt"/>`;
    const cx = x(S.n);
    o += `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${Ht - m.b}" class="${P}cursor"/>`;
    for (const f of [MODEL.T, MODEL.A]) o += `<circle cx="${cx}" cy="${y(f(S.n))}" r="5" class="${P}cur-pt"/>`;
    svg.innerHTML = o;

    const R = RATES[S.r]; const t = MODEL.T(S.n); const a = MODEL.A(S.n);
    const mt = MEASURED.T.find(([n]) => n === S.n); const ma = MEASURED.A.find(([n]) => n === S.n);
    meters.innerHTML = dial('Temporal', `40 + 35 × ${S.n}`, t, t * R, mt && mt[1]) + dial('Absurd', `11 + 7 × ${S.n}`, a, a * R, ma && ma[1]);
    note.innerHTML = `Your Postgres at ${fmt(R)} workflows/s. Temporal runs <b>${(t / a).toFixed(1)}×</b> as many statements; the ratio tends to 35 / 7 = 5 as N grows. This counts statements, not their cost.`;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

register({
  'tuth-receipts': initReceipts,
  'tuth-request': initRequest,
  'tuth-services': staticDiagram(SERVICES, [['proc', 'process you run'], ['table', 'database'], ['safe', 'durable state']]),
  'tuth-tape': initTape,
  'tuth-trip': initTrip,
  'tuth-crash': initCrash,
  'tuth-cost': initCost,
  'tuth-deploy': staticDiagram(DEPLOY, [['proc', 'process you run'], ['table', 'database']]),
});

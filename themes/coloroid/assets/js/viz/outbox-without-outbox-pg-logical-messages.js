/*
 * Figures for "The Outbox Without an Outbox".
 *
 * Visual language: the WAL is a strip of append-only tape. Records sit on
 * it at their LSN, to scale where the figure says so; the replication slot
 * is a green bookmark clipped to the tape. Figures render without the shared
 * whiteboard sheet (frame="none") and are styled in
 * css/viz/outbox-without-outbox-pg-logical-messages.css.
 *
 *   oxb-commit   end one transaction with COMMIT or ROLLBACK; see where the event goes
 *   oxb-ack-lsn  drag the slot along a real WAL layout; the restart rule decides each fate
 *   oxb-follow   one event, five envelopes: the same 225 bytes wrapped at each stop
 *   oxb-race     the reader plays Kafka, acking partitions in any order; two slot rules react
 *   oxb-replay   drag a crash onto the status-update timeline; count the duplicates
 *   oxb-backlog  your workload in, your outage budget out
 *
 * Design: one new idea per view, labels next to the things they name,
 * prediction or a reader action before each answer, detail on demand.
 *
 * LSNs, record sizes and frame bytes come from one run on PostgreSQL 17.7
 * (wal_level = logical, pgoutput proto_version 1, messages 'true'), read with
 * pg_waldump and a replication connection. The restart outcome of each ACK
 * choice, the backward-confirm behaviour, and slot invalidation under
 * max_slot_wal_keep_size were checked on the same server. Code refers to
 * github.com/fampay-inc/factlib at cd2934e.
 */
import { h, s, colorKey, codeBlock, register, esc, lsn, tween, ease, btn, uid, range, clamp, fmt } from './lib.js';

const hex2 = (b) => b.toString(16).padStart(2, '0');
const hexOf = (str) => str.match(/../g);
const utf8 = (t) => [...new TextEncoder().encode(t)].map(hex2);
const be = (n, bytes) => { const out = []; let v = BigInt(n); for (let i = 0; i < bytes; i++) { out.unshift(hex2(Number(v & 0xffn))); v >>= 8n; } return out; };
const T = (x, y, cls, text, anchor = 'start') => s('text', { x, y, class: cls, 'text-anchor': anchor }, text);
const arrowDefs = (id) => `<defs>
  <marker id="${id}-i" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--ink)"/></marker>
  <marker id="${id}-g" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--green)"/></marker>
  <marker id="${id}-p" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--purple)"/></marker>
  <pattern id="${id}-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" style="fill:var(--paper)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink);stroke-width:1.4"/></pattern>
</defs>`;
/** Holes along both edges of a tape band. */
function tapeBand(x0, x1, y, hgt) {
  const g = s('g');
  g.append(s('rect', { x: x0, y, width: x1 - x0, height: hgt, class: 'o-tape' }));
  for (let x = x0 + 7; x < x1 - 3; x += 14) {
    g.append(s('circle', { cx: x, cy: y + 4.5, r: 1.8, class: 'o-hole' }), s('circle', { cx: x, cy: y + hgt - 4.5, r: 1.8, class: 'o-hole' }));
  }
  return g;
}
/** Re-render on width class changes (phone vs desktop). */
function responsive(app, draw) {
  let V = null;
  const f = () => { const v = app.clientWidth < 600; if (v !== V) { V = v; draw(v); } };
  f();
  new ResizeObserver(f).observe(app);
  return () => V;
}

/* ------------------------------------------------------------ the sample */

/* Two requests at once. B (user-12346, xid 782) writes first; A (user-12345,
   xid 783) commits first. Decoding follows commit order: A, then B. */
const WAL = [
  { tx: 'B', kind: 'INSERT', at: 0x15A06F8, len: 83 },
  { tx: 'B', kind: 'index', at: 0x15A0750, len: 72 },
  { tx: 'B', kind: 'MESSAGE', at: 0x15A0798, len: 292 },
  { tx: 'A', kind: 'INSERT', at: 0x15A08C0, len: 83 },
  { tx: 'A', kind: 'index', at: 0x15A0918, len: 72 },
  { tx: 'A', kind: 'MESSAGE', at: 0x15A0960, len: 292 },
  { tx: 'A', kind: 'COMMIT', at: 0x15A0A88, len: 46 },
  { tx: 'B', kind: 'COMMIT', at: 0x15A0AB8, len: 46 },
];
const WAL_END = 0x15A0AE8;
const A_MSG_LSN = 0x15A0A88; // end of A's message record = WALStart of its M frame
const M_FRAME = 253;         // 1 + 1 + 8 + 14 + 4 + 225
const COMMIT_OF = { A: 0x15A0A88, B: 0x15A0AB8 };

const STREAM = [
  { tx: 'A', f: 'BEGIN', at: 0x15A0A88, note: 'xid 783' },
  { tx: 'A', f: 'MESSAGE', at: 0x15A0A88, note: '253 B frame' },
  { tx: 'A', f: 'COMMIT', at: 0x15A0AB8, note: 'end_lsn 0/15A0AB8' },
  { tx: 'B', f: 'BEGIN', at: 0x15A08C0, note: 'xid 782' },
  { tx: 'B', f: 'MESSAGE', at: 0x15A08C0, note: 'lower than A’s' },
  { tx: 'B', f: 'COMMIT', at: 0x15A0AE8, note: 'end_lsn 0/15A0AE8' },
];

/** Map a pointer event to SVG user coordinates. */
function svgPt(svg, e) {
  const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}
const details = (summary, ...kids) => h('details', { class: 'o-more' }, h('summary', null, summary), ...kids);
const bookmark = (y0, y1, label = 'slot') => {
  const g = s('g', { class: 'o-slot' });
  g.append(s('line', { x1: 0, x2: 0, y1: y0, y2: y1, class: 'o-slot-line' }),
    s('path', { d: `M0,${y0} l36,0 l-6,7 l6,7 l-36,0 z`, class: 'o-slot-flag' }),
    T(4, y0 + 10.5, 'o-xs o-b o-paper', label));
  return g;
};

/* ================================================================ COMMIT */

/* The reader ends one transaction with COMMIT or ROLLBACK and sees where
   the event goes. Both are true on Postgres 17.7: the message record is in
   WAL before COMMIT; ROLLBACK adds a 34-byte ABORT record, and decoding
   drops the transaction. */
const TXN = {
  wide: {
    vb: [960, 318], tape: [16, 944, 168, 50], rec: [178, 208],
    old: [['o', 30, 130], ['m', 130, 263, 'event'], ['c', 263, 285], ['o', 285, 400]],
    fresh: [['o', 400, 440, 'row'], ['o', 440, 472, 'idx'], ['m', 472, 605, 'event']],
    end: 605, commitW: 22, abortW: 18, slot0: 285,
    card: [330, 12, 420, 104],
    owl: [300, 252, 210, 50], kafka: [700, 252, 220, 50],
    ackPath: [[740, 252], [740, 238], [627, 238], [627, 224]],
  },
  tall: {
    vb: [360, 400], tape: [8, 352, 206, 46], rec: [214, 244],
    old: [['o', 14, 40], ['m', 40, 94, 'event'], ['c', 94, 104], ['o', 104, 150]],
    fresh: [['o', 150, 172, ''], ['o', 172, 190, ''], ['m', 190, 272, 'event']],
    end: 272, commitW: 12, abortW: 10, slot0: 104,
    card: [16, 12, 328, 104],
    owl: [16, 330, 152, 52], kafka: [192, 330, 152, 52],
    ackPath: [[284, 330], [284, 262]],
  },
};

function initCommit(fig, app) {
  const aid = uid('oxh');
  let state = 'open'; let L = null; let el = null; let cancel = () => {};
  const stage = h('div');
  const ask = h('p', { class: 'o-q' }, 'The row and the event are already in the WAL. End the transaction. Does the event reach Kafka?');
  const bC = btn('COMMIT', () => end('commit'), { class: 'wv-btn o-opt' });
  const bR = btn('ROLLBACK', () => end('rollback'), { class: 'wv-btn o-opt' });
  const bAgain = btn('↺ again', () => { state = 'open'; draw(L === TXN.tall); }, { class: 'wv-btn o-ghost' });
  const say = h('p', { class: 'o-note', 'aria-live': 'polite' });
  app.append(ask, h('div', { class: 'o-opts' }, bC, bR, bAgain), stage, say,
    colorKey([['k-data', 'event'], ['k-free', 'other WAL'], ['k-safe', 'slot, ack'], ['k-look', 'your transaction']]));

  function draw(vertical) {
    cancel();
    L = vertical ? TXN.tall : TXN.wide;
    const [W, H] = L.vb;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.getAttribute('aria-label') || '' });
    svg.innerHTML = arrowDefs(aid);
    const [tx0, tx1, ty, th] = L.tape; const [ry0, ry1] = L.rec;
    svg.append(T(tx0 + 4, ty - 8, 'o-s o-b', 'WAL'), T(tx1, ty - 8, 'o-xs o-mute', vertical ? 'LSN →' : 'append-only · LSN →', 'end'));
    svg.append(tapeBand(tx0, tx1, ty, th));
    const rec = ([k, x0, x1, label], extra = '') => {
      const g = s('g', { class: extra });
      g.append(s('rect', { x: x0, y: ry0, width: x1 - x0, height: ry1 - ry0, class: k === 'm' ? 'o-rec o-rec-msg' : k === 'c' ? 'o-rec o-rec-c' : 'o-rec' }));
      if (label) g.append(T((x0 + x1) / 2, (ry0 + ry1) / 2 + 4, `o-xs o-b${k === 'm' ? ' o-data' : ''}`, label, 'middle'));
      svg.append(g); return g;
    };
    L.old.forEach((r) => rec(r));
    const recyc = s('rect', { x: tx0, y: ty, width: 0, height: th, class: 'o-recyc' }); svg.append(recyc);
    const fresh = L.fresh.map((r) => rec(r, 'o-fresh'));
    const endRec = s('g'); svg.append(endRec);
    const ev = L.fresh[2];
    const evTag = T((ev[1] + ev[2]) / 2, ry1 + 16, 'o-xs o-b o-look', 'waits for COMMIT', 'middle'); svg.append(evTag);
    // the transaction card
    const [cx, cy, cw, ch] = L.card;
    svg.append(s('rect', { x: cx, y: cy, width: cw, height: ch, class: 'o-box o-look-box' }));
    const lines = ['BEGIN;', 'INSERT INTO users …;', 'SELECT pg_logical_emit_message(', "    true, 'payments-user', event);"];
    lines.forEach((ln, k) => svg.append(s('text', { x: cx + 12, y: cy + 22 + k * 19, class: `o-s o-pre${k >= 2 ? ' o-data o-b' : ''}` }, ln)));
    const last = s('text', { x: cx + 12, y: cy + 22 + 4 * 19, class: 'o-s o-b o-look' }, '▢ COMMIT or ROLLBACK?'); svg.append(last);
    for (const r of L.fresh.filter((x) => x[3] !== '' || true)) {
      const x = (r[1] + r[2]) / 2;
      if (r[3] === 'idx' || (vertical && r !== ev)) continue;
      svg.append(s('path', { d: `M${x},${cy + ch} L${x},${ry0 - 3}`, class: 'o-drop', 'marker-end': `url(#${aid}-p)` }));
    }
    // OwlPost and Kafka
    const box = ([x, y, w, hh], t1, cls) => {
      svg.append(s('rect', { x, y, width: w, height: hh, class: cls }), T(x + w / 2, y + 21, 'o-m o-b', t1, 'middle'));
      const sub = T(x + w / 2, y + 38, 'o-xs o-mute', '', 'middle'); svg.append(sub); return sub;
    };
    const owlSub = box(L.owl, 'OwlPost', 'o-box');
    const kafSub = box(L.kafka, 'Kafka', 'o-box o-dash');
    const [ox, oy, ow, oh] = L.owl; const [kx, ky, , kh] = L.kafka;
    const evx = (ev[1] + ev[2]) / 2;
    const read = s('path', { d: `M${evx},${ry1 + 22} L${clamp(evx, ox + 20, ox + ow - 20)},${oy}`, class: 'o-edge', 'marker-end': `url(#${aid}-i)` });
    const prod = s('path', { d: vertical ? `M${ox + ow},${oy + oh / 2} L${kx},${ky + kh / 2}` : `M${ox + ow},${oy + oh / 2} L${kx},${ky + kh / 2}`, class: 'o-edge', 'marker-end': `url(#${aid}-i)` });
    const ack = s('path', { d: `M${L.ackPath.map((q) => q.join(',')).join(' L')}`, class: 'o-edge-ack', 'marker-end': `url(#${aid}-g)` });
    const ackLab = vertical ? T(278, 300, 'o-xs o-safe o-b', 'ack → slot', 'end') : T(746, 246, 'o-xs o-safe o-b', 'ack → status update');
    [read, prod, ack, ackLab].forEach((x) => { x.style.opacity = 0; svg.append(x); });
    const slot = bookmark(ty - 16, ty + th + 6); slot.setAttribute('transform', `translate(${L.slot0},0)`); svg.append(slot);
    const recLab = T(tx0 + 4, ty + th + 16, 'o-xs o-safe o-b', ''); svg.append(recLab);
    stage.replaceChildren(svg);
    el = { svg, fresh, endRec, evTag, last, owlSub, kafSub, read, prod, ack, ackLab, slot, recyc, recLab };
    paint(state === 'open' ? 0 : 99);
  }

  function paint(t) {
    const e = el; const on = (a, b) => clamp((t - a) / (b - a), 0, 1);
    const open = state === 'open';
    bC.disabled = !open; bR.disabled = !open; bAgain.style.visibility = open ? 'hidden' : 'visible';
    bC.setAttribute('aria-pressed', String(state === 'commit')); bR.setAttribute('aria-pressed', String(state === 'rollback'));
    const [, , ty] = L.tape; const [ry0, ry1] = L.rec;
    e.endRec.replaceChildren();
    if (!open) {
      const w = state === 'commit' ? L.commitW : L.abortW;
      e.endRec.append(s('rect', { x: L.end, y: ry0, width: w, height: ry1 - ry0, class: state === 'commit' ? 'o-rec o-rec-c' : 'o-rec o-rec-abort' }));
      e.endRec.append(T(L.end + w, ty - 21, `o-xs o-b ${state === 'commit' ? '' : 'o-bad'}`, state === 'commit' ? 'COMMIT 46 B' : 'ABORT 34 B', 'end'));
    }
    e.last.textContent = open ? '▢ COMMIT or ROLLBACK?' : state === 'commit' ? 'COMMIT;' : 'ROLLBACK;';
    e.fresh.forEach((g) => g.classList.toggle('is-void', state === 'rollback'));
    e.evTag.textContent = open ? 'waits for COMMIT' : state === 'commit' ? 'decoded at COMMIT' : 'in WAL, never decoded';
    e.evTag.setAttribute('class', `o-xs o-b ${open ? 'o-look' : state === 'commit' ? 'o-data' : 'o-mute'}`);
    const c = state === 'commit';
    e.read.style.opacity = c ? on(0.2, 0.8) : 0;
    e.prod.style.opacity = c ? on(0.8, 1.4) : 0;
    e.ack.style.opacity = c ? on(1.4, 2.0) : 0; e.ackLab.style.opacity = e.ack.style.opacity;
    e.owlSub.textContent = open ? 'sees nothing yet' : c ? 'prefix payments-user ✓' : 'sees nothing';
    e.kafSub.textContent = open ? '' : c ? (on(0.8, 1.4) >= 1 ? '+1 record: user.created' : '') : 'nothing arrives';
    e.kafSub.setAttribute('class', `o-xs o-b ${c ? 'o-safe' : 'o-mute'}`);
    const slotTo = L.end + L.commitW;
    const x = c ? L.slot0 + (slotTo - L.slot0) * ease(on(2.0, 2.6)) : L.slot0;
    e.slot.setAttribute('transform', `translate(${x},0)`);
    const rc = c ? on(2.6, 3.0) : 0;
    e.recyc.setAttribute('width', Math.max(0, (x - L.tape[0]) * rc));
    e.recLab.textContent = rc > 0 ? (L === TXN.tall ? 'may be recycled' : 'Postgres may recycle this WAL') : '';
    say.innerHTML = open ? 'Both records were written when the statements ran. Nothing has been sent anywhere yet.'
      : c ? 'The COMMIT record makes the transaction visible to decoding. OwlPost reads the event, Kafka stores it, and the ack moves the slot. No outbox table was written, polled, or vacuumed.'
        : 'The event record stays in the WAL, but the ABORT record tells decoding to drop the whole transaction. OwlPost never sees it, and the WAL is recycled like any other.';
  }

  function end(which) {
    state = which;
    cancel();
    cancel = tween(which === 'commit' ? 3000 : 400, (k) => paint(k * (which === 'commit' ? 3 : 1)));
  }
  responsive(app, draw);
}

/* =============================================================== ACK LSN */

const CANDS = [
  { n: 1, at: A_MSG_LSN + M_FRAME, name: 'WALStart + len(WALData)', who: 'what factlib computes today',
    why: `<code>${lsn(A_MSG_LSN)}</code> + 253, the length of the pgoutput frame. <code>WALData</code> holds pgoutput bytes, not WAL bytes, so the sum is not a WAL position.` },
  { n: 2, at: A_MSG_LSN, name: 'WALStart', who: 'the message LSN',
    why: 'For a transactional message, <code>WALStart</code> is the end of the message record, where the COMMIT record starts.' },
  { n: 3, at: COMMIT_OF.A + 48, name: 'COMMIT end_lsn', who: 'after every message of A is acked',
    why: '<code>TransactionEndLSN</code> from A’s COMMIT frame. These rise in stream order.' },
];

function initAckLsn(fig, app) {
  const L0 = 0x15A06F8; const L1 = 0x15A0BD0;
  let ack = L0 + 16; let moved = false; let V = false; let G = null;
  const stage = h('div', { class: 'o-ruler' });
  const q = h('p', { class: 'o-q' }, 'A is in Kafka. B is still in flight. Drag the green slot to where OwlPost should confirm, then look under each COMMIT.');
  const jump = CANDS.map((c) => btn(h('span', null, h('b', null, `${c.n} `), h('code', null, c.name)), () => { set(c.at); }, { class: 'wv-btn o-opt' }));
  const verdict = h('div', { class: 'o-verdict', 'aria-live': 'polite' });
  const why = h('p', { class: 'o-note' });

  function draw(vertical) {
    V = vertical;
    const W = vertical ? 360 : 960; const H = vertical ? 640 : 272;
    const m0 = vertical ? 80 : 24; const m1 = vertical ? 612 : 936;
    const P = (l) => m0 + ((l - L0) / (L1 - L0)) * (m1 - m0);
    const inv = (v) => L0 + ((v - m0) / (m1 - m0)) * (L1 - L0);
    const TR = vertical ? { A: [84, 168], B: [184, 268] } : { A: [66, 104], B: [154, 192] };
    const box = (l0, l1, c0, c1) => (vertical ? { x: c0, y: P(l0), width: c1 - c0, height: P(l1) - P(l0) } : { x: P(l0), y: c0, width: P(l1) - P(l0), height: c1 - c0 });
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'WAL records of transactions A and B with a movable slot' });
    const aid = uid('oxa'); svg.innerHTML = arrowDefs(aid);
    for (const tx of ['A', 'B']) svg.append(s('rect', { ...box(L0, L1, TR[tx][0] - 7, TR[tx][1] + 7), class: 'o-tape' }));
    if (vertical) {
      svg.append(T(126, 24, 'o-m o-b', 'A', 'middle'), T(126, 38, 'o-xs o-mute', 'commits 1st', 'middle'), T(226, 24, 'o-m o-b', 'B', 'middle'), T(226, 38, 'o-xs o-mute', 'commits 2nd', 'middle'), T(4, 56, 'o-xs o-mute', 'LSN ↓'));
    } else {
      svg.append(s('text', { x: m0, y: TR.A[0] - 14, class: 'o-s' }, s('tspan', { class: 'o-b' }, 'A '), s('tspan', { class: 'o-mute' }, 'user-12345 · commits first · in Kafka')),
        s('text', { x: m0, y: TR.B[0] - 14, class: 'o-s' }, s('tspan', { class: 'o-b' }, 'B '), s('tspan', { class: 'o-mute' }, 'user-12346 · writes first, commits second · in flight')),
        T(m1, H - 4, 'o-xs o-mute', 'LSN →', 'end'));
    }
    const later = box(WAL_END, L1, TR.A[0], TR.B[1]);
    svg.append(s('rect', { ...later, class: 'o-later' }), vertical ? T(later.x + later.width / 2, later.y + later.height - 8, 'o-xs o-mute', 'later WAL', 'middle') : T(later.x + 6, TR.A[0] + 14, 'o-xs o-mute', 'later WAL'));
    for (const r of WAL) {
      const b = box(r.at, r.at + Math.ceil(r.len / 8) * 8, ...TR[r.tx]);
      svg.append(s('rect', { ...b, class: r.kind === 'MESSAGE' ? 'o-rec o-rec-msg' : r.kind === 'COMMIT' ? 'o-rec o-rec-c' : 'o-rec' }));
      const cx = b.x + b.width / 2; const cy = b.y + b.height / 2;
      if (r.kind === 'MESSAGE') svg.append(T(cx, cy + 4, 'o-xs o-data o-b', vertical ? 'event' : `event · ${r.len} B`, 'middle'));
      else if (r.kind !== 'COMMIT') svg.append(T(cx, cy + 3.5, 'o-xs', vertical ? '' : r.kind, 'middle'));
    }
    // COMMIT labels and fates, right next to each COMMIT record
    const fates = {};
    for (const tx of ['A', 'B']) {
      const b = box(COMMIT_OF[tx], COMMIT_OF[tx] + 48, ...TR[tx]);
      if (vertical) {
        svg.append(T(b.x + b.width / 2, b.y + b.height / 2 + 3.5, 'o-xs o-b', 'COMMIT', 'middle'));
        fates[tx] = T(276, b.y + b.height / 2 + 4, 'o-s o-b', '?', 'start');
      } else {
        svg.append(T(b.x + b.width / 2, TR[tx][1] + 20, 'o-xs o-b', 'COMMIT', 'middle'));
        fates[tx] = T(b.x + b.width / 2, TR[tx][1] + 34, 'o-s o-b', '?', 'middle');
      }
      svg.append(fates[tx]);
    }
    // candidate marks: numbered purple ticks on the axis
    for (const c of CANDS) {
      const v = P(c.at);
      const g = s('g', { class: 'o-cand', role: 'button', tabindex: -1 });
      if (vertical) g.append(s('circle', { cx: 68, cy: v, r: 7 }), T(68, v + 3.5, 'o-xs o-b o-paper', String(c.n), 'middle'), s('line', { x1: 72, x2: 272, y1: v, y2: v, class: 'o-candline' }));
      else g.append(s('circle', { cx: v, cy: TR.B[1] + 56, r: 8 }), T(v, TR.B[1] + 59.5, 'o-xs o-b o-paper', String(c.n), 'middle'), s('line', { x1: v, x2: v, y1: TR.A[0] - 8, y2: TR.B[1] + 48, class: 'o-candline' }));
      g.addEventListener('click', () => set(c.at));
      svg.append(g);
    }
    // the slot the reader drags
    const slot = s('g', { class: 'o-drag', tabindex: 0, role: 'slider', 'aria-label': 'Slot position (LSN)', 'aria-valuemin': L0, 'aria-valuemax': L1 });
    if (vertical) {
      slot.append(s('rect', { x: 66, y: -12, width: 220, height: 24, class: 'o-hit' }), s('line', { x1: 70, x2: 280, y1: 0, y2: 0, class: 'o-slot-line' }),
        s('path', { d: 'M2,-9 l54,0 l0,18 l-54,0 z', class: 'o-slot-flag' }), T(6, 4, 'o-xs o-b o-paper', 'slot ↕'));
    } else {
      slot.append(s('rect', { x: -12, y: 20, width: 24, height: TR.B[1] - 12, class: 'o-hit' }), s('line', { x1: 0, x2: 0, y1: 18, y2: TR.B[1] + 8, class: 'o-slot-line' }),
        s('path', { d: 'M0,4 l58,0 l-7,8 l7,8 l-58,0 z', class: 'o-slot-flag' }), T(5, 16, 'o-xs o-b o-paper', 'slot ↔'));
    }
    const lab = T(0, 0, 'o-s o-b o-safe', ''); svg.append(slot, lab);
    // dragging
    const toL = (e) => { const p = svgPt(svg, e); return clamp(inv(vertical ? p.y : p.x), L0, L1); };
    const snap = (l) => { for (const c of CANDS) if (Math.abs(P(l) - P(c.at)) < 9) return c.at; return Math.round(l / 8) * 8; };
    let drag = false;
    svg.addEventListener('pointerdown', (e) => { if (e.target.closest('.o-cand')) return; drag = true; svg.setPointerCapture(e.pointerId); set(snap(toL(e))); e.preventDefault(); });
    svg.addEventListener('pointermove', (e) => { if (drag) set(snap(toL(e))); });
    svg.addEventListener('pointerup', () => { drag = false; });
    slot.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 8, ArrowDown: 8, ArrowLeft: -8, ArrowUp: -8 }[e.key];
      if (d) { set(clamp(ack + d, L0, L1)); e.preventDefault(); e.stopPropagation(); }
      if (['1', '2', '3'].includes(e.key)) set(CANDS[+e.key - 1].at);
    });
    stage.replaceChildren(svg);
    G = { P, slot, lab, fates, vertical, W };
    paint();
  }

  function paint() {
    const { P, slot, lab, fates, vertical, W } = G;
    const v = P(ack);
    slot.setAttribute('transform', vertical ? `translate(0,${v})` : `translate(${v},0)`);
    slot.setAttribute('aria-valuenow', ack); slot.setAttribute('aria-valuetext', lsn(ack));
    lab.textContent = lsn(ack);
    if (vertical) { lab.setAttribute('x', 4); lab.setAttribute('y', v + 24); lab.setAttribute('text-anchor', 'start'); }
    else { const right = v > W * 0.8; lab.setAttribute('x', right ? v - 6 : v + 64); lab.setAttribute('y', 16); lab.setAttribute('text-anchor', right ? 'end' : 'start'); }
    // Postgres sends a transaction again iff its COMMIT starts at or after the slot.
    const againA = COMMIT_OF.A >= ack; const againB = COMMIT_OF.B >= ack;
    const set1 = (t, txt, cls) => { t.textContent = moved ? txt : '?'; t.setAttribute('class', `o-s o-b ${moved ? cls : 'o-look'}`); };
    set1(fates.A, againA ? 'sent again' : 'in Kafka ✓', againA ? '' : 'o-safe');
    set1(fates.B, againB ? 'sent again ✓' : 'LOST', againB ? 'o-safe' : 'o-bad');
    const c = CANDS.find((x) => x.at === ack);
    jump.forEach((b, k) => b.setAttribute('aria-pressed', String(CANDS[k].at === ack)));
    if (!moved) { verdict.className = 'o-verdict'; verdict.textContent = ''; why.innerHTML = 'The marks 1–3 are LSNs OwlPost can compute. Try each, or anywhere else.'; return; }
    if (!againB) { verdict.className = 'o-verdict is-bad'; verdict.textContent = 'B is lost. Its COMMIT is before the slot, so Postgres will not send B again, and Kafka never got it.'; }
    else if (againA) { verdict.className = 'o-verdict is-good'; verdict.textContent = 'Safe. Postgres sends A again once (consumers drop the copy by event.Id) and sends B.'; }
    else { verdict.className = 'o-verdict is-good'; verdict.textContent = 'Safe and exact. A is not repeated; B’s COMMIT starts at or after the slot, so B is sent again.'; }
    why.innerHTML = c ? `<b>${c.n} · ${esc(c.name)}</b>, ${esc(c.who)}: ${c.why}` : 'Rule: after a restart, Postgres sends a transaction again only if its COMMIT record starts at or after <code>confirmed_flush_lsn</code>.';
  }
  function set(l) { ack = l; moved = true; paint(); }

  const code = h('div', { html: codeBlock([
    'xld, _ := pglogrepl.ParseXLogData(msg.Data[1:])',
    `newXLogPos := xld.WALStart + pglogrepl.LSN(len(xld.WALData)) // 1: ⟦${lsn(A_MSG_LSN + M_FRAME)}⟧`,
    `newXLogPos := xld.WALStart                                   // 2: «${lsn(A_MSG_LSN)}»`,
    `txEnd := commitMsg.TransactionEndLSN                         // 3: «${lsn(COMMIT_OF.A + 48)}»`,
  ], [1]) });
  const stream = h('div', { class: 'o-scroll', html: `<table class="o-table"><thead><tr><th>#</th><th>frame</th><th>WALStart</th><th></th></tr></thead><tbody>${STREAM.map((r, j) => `<tr><td>${j + 1}</td><td><b>${r.tx}</b> ${r.f}</td><td class="c-data">${lsn(r.at)}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table><p class="o-small">B arrives second, but its message LSN is lower than A’s: message LSNs follow write order, the stream follows commit order.</p>` });
  app.append(q, stage, verdict, why, h('div', { class: 'o-opts o-jump' }, h('span', { class: 'o-lab' }, 'jump to'), ...jump),
    details('The code behind 1–3, and the frames in stream order', code, stream),
    colorKey([['k-data', 'event'], ['k-free', 'other WAL'], ['k-safe', 'slot / safe'], ['k-look', 'LSNs OwlPost can compute'], ['k-gap', 'lost'], ['k-opt', 'controls']]));
  responsive(app, draw);
}

/* ================================================================ FOLLOW */

/* One event, five envelopes. The 225 protobuf bytes stay in the same place
   on screen; each stop wraps them differently. Sizes are exact for event A. */
const EV = { id: '019e0b6e-6684-7b4d-9a61-2f8e4c0d5b17', payload: '{"id":"user-12345","email":"asha@example.com"}', ack: A_MSG_LSN + M_FRAME };
const CORE = [['id', 38], ['aggregate_type', 6], ['aggregate_id', 12], ['event_type', 14], ['payload', 48], ['created_at', 10], ['trace_info', 97]];
const PARTITION = 1; // murmur2("user-12345") % 6 (Kafka's default partitioner), sample 6-partition topic
const FORMS = [
  { stop: 'Emit', where: 'producer.go', wrap: [], coreFields: true,
    say: 'Emit marshals the event into <b>225 bytes of protobuf</b>. From here on these bytes do not change. Only the envelope around them does.',
    code: ['outboxEvent := &pb.OutboxEvent{Id: eventId.String(), AggregateType: "user", …}', 'protoBytes, _ := proto.Marshal(outboxEvent)   // «225 B»', 'a.conn.Exec(ctx, "SELECT pg_logical_emit_message(true, $1, $2::bytea)", a.prefix, protoBytes)'] },
  { stop: 'WAL', where: 'pg_waldump', wrap: [['XLogRecord', 24], ['data header', 5], ['xl_logical_message', 24], ['prefix "payments-user\\0"', 14]],
    total: 292, lsnFrom: 0x15A0960, lsnTo: A_MSG_LSN,
    say: 'Inside the transaction, the <code>SELECT</code> writes one <b>292-byte</b> WAL record at <code>0/15A0960</code>. It returns <code>0/15A0A88</code>, the end of the record. COMMIT (46 B) follows right there.' },
  { stop: 'pgoutput', where: 'walsender → OwlPost', wrap: [['XLogData header', 25], ["'M' + flags", 2], ['message LSN', 8], ['prefix', 14], ['length', 4]],
    total: 253, frame: true,
    say: 'At COMMIT, the walsender sends the record as a pgoutput MESSAGE. The frame after the XLogData header is <b>253 bytes</b>, and <code>WALStart</code> is <code>0/15A0A88</code>.' },
  { stop: 'OwlPost', where: 'wal.go · handleMessage', wrap: [], tag: true,
    say: `OwlPost keeps messages with prefix <code>payments-user</code>, unmarshals them, and tags the event with <code>WALStart + 253 = <span class="c-bad">${lsn(EV.ack)}</span></code>: a WAL position plus a frame length. Figure 3 shows why that is too far.`,
    code: ['newXLogPos := xld.WALStart + pglogrepl.LSN(len(xld.WALData))', `// «0/15A0A88» + «253» = ⟦${lsn(EV.ack)}⟧`, 'if ldm.Prefix == w.cfg.OutboxPrefix { w.handleMessage(ctx, ldm.Content, newXLogPos) }'] },
  { stop: 'Kafka', where: 'kafka.go · KafkaEventHandler', wrap: [['key "user-12345"', 10]], headers: true,
    say: `One record on topic <code>payments-user.user</code>. The key <code>user-12345</code> hashes to partition ${PARTITION} (a sample 6-partition topic), so every event for this user keeps its order.`,
    code: ['topic := fmt.Sprintf("%s.%s", event.OutboxPrefix, event.Outbox.AggregateType)', 'key := []byte(event.Outbox.AggregateId)', 'value, _ := proto.Marshal(&event.Outbox)   // «225 B» again'] },
  { stop: 'Ack', where: 'kafka.go → wal.go', wrap: [], back: true,
    say: `With <code>acks=all</code> stored, the callback hands back only the <code>LSN</code> header. Within a second a status update sets <code>confirmed_flush_lsn = ${lsn(EV.ack)}</code>, and Postgres may drop the WAL behind it.`,
    code: ['a.Ack(pos)                    // pos = the "LSN" header', 'w.xLogPos = *ackPos           // listenEventAck', `SendStandbyStatusUpdate(…)    // every 1 s: «${lsn(EV.ack)}»`] },
];

function initFollow(fig, app) {
  let i = 0; let V = false;
  const stops = FORMS.map((f, k) => btn(h('span', null, h('b', null, `${k + 1}`), ` ${f.stop}`), () => go(k), { class: 'o-stopbtn' }));
  const nav = h('div', { class: 'o-stops', role: 'group', 'aria-label': 'Stops' }, ...stops);
  const stage = h('div');
  const say = h('p', { class: 'o-note', 'aria-live': 'polite' });
  const more = h('div');
  function draw(vertical = V) {
    V = vertical;
    const f = FORMS[i];
    const W = vertical ? 360 : 960; const H = vertical ? 250 : 230;
    const k = vertical ? 0.98 : 2.6;              // px per byte, the same at every stop
    const c0 = vertical ? 100 : 250;              // the core starts here at every stop
    const y0 = 92; const hh = 46;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The event at stop ${i + 1}: ${f.stop}` });
    const aid = uid('oxe'); svg.innerHTML = arrowDefs(aid);
    // the core
    const coreW = 225 * k;
    if (f.coreFields) {
      let x = c0; const small = [];
      CORE.forEach(([name, n]) => {
        const w = n * k;
        svg.append(s('rect', { x, y: y0, width: w, height: hh, class: 'o-rec o-rec-msg' }));
        if (w >= name.length * 6.2 + 8) svg.append(T(x + w / 2, y0 + hh / 2 + 4, 'o-xs o-data o-b', name, 'middle'));
        else small.push([name, n, x + w / 2]);
        x += w;
      });
      // labels sit left of their leader; leftmost on the top row, so no leader crosses a label
      small.forEach(([name, n, lx], r) => {
        const ly = y0 + hh + 14 + r * 12;
        svg.append(s('line', { x1: lx, x2: lx, y1: y0 + hh, y2: ly - 9, class: 'o-leader' }), T(lx - 2, ly, 'o-xs o-data', `${name} · ${n} B`, 'end'));
      });
      svg.append(s('path', { d: `M${c0},${y0 - 4} L${c0},${y0 - 12} L${c0 + coreW},${y0 - 12} L${c0 + coreW},${y0 - 4}`, class: 'o-brace' }),
        T(c0 + coreW / 2, y0 - 18, 'o-s o-b o-data', '225 B protobuf · OutboxEvent', 'middle'));
    } else {
      svg.append(s('rect', { x: c0, y: y0, width: coreW, height: hh, class: 'o-rec o-rec-msg' }));
    }
    if (!f.coreFields) svg.append(T(c0 + coreW / 2, y0 + hh / 2 + 5, 'o-m o-b o-data', 'event · 225 B', 'middle'));
    // the envelope, to the left of the core; labels climb a staircase so none overlap
    const n = f.wrap.length;
    let x = c0 - f.wrap.reduce((m, [, b]) => m + Math.max(b * k, 3), 0);
    f.wrap.forEach(([name, b], j) => {
      const w = Math.max(b * k, 3);
      svg.append(s('rect', { x, y: y0, width: w, height: hh, class: 'o-rec o-env' }));
      const lx = x + w / 2; const ly = y0 - 12 - (n - 1 - j) * 13;
      svg.append(s('line', { x1: lx, x2: lx, y1: y0, y2: ly + 3, class: 'o-leader' }), T(lx - 2, ly, 'o-xs', `${name} · ${b} B`));
      x += w;
    });
    if (f.total) {
      const start = c0 - (f.total - 225) * k; const by = y0 + hh + 8;
      svg.append(s('path', { d: `M${start},${by - 4} L${start},${by + 4} L${c0 + coreW},${by + 4} L${c0 + coreW},${by - 4}`, class: 'o-brace' }),
        T((start + c0 + coreW) / 2, by + 18, 'o-s o-b', f.frame ? '253 B pgoutput MESSAGE' : '292 B WAL record', 'middle'));
    }
    if (f.lsnFrom) {
      svg.append(T(c0 - 67 * k, y0 + hh + 46, 'o-xs o-data o-b', `▲ ${lsn(f.lsnFrom)}`, 'start'), T(c0 + coreW, y0 + hh + 46, 'o-xs o-data o-b', `${lsn(f.lsnTo)} ▲`, 'end'));
    }
    if (f.frame) {
      const ws = c0 - 28 * k;
      svg.append(T(ws, y0 + hh + 46, 'o-xs o-data o-b', `▲ WALStart ${lsn(A_MSG_LSN)}`, 'start'));
    }
    if (f.tag) {
      svg.append(s('rect', { x: c0 - (vertical ? 92 : 190), y: y0 + 6, width: vertical ? 86 : 180, height: hh - 12, class: 'o-rec o-tagbad' }),
        T(c0 - (vertical ? 49 : 100), y0 + hh / 2 + 4, 'o-xs o-b o-bad', vertical ? lsn(EV.ack) : `XLogPos ${lsn(EV.ack)}`, 'middle'),
        T(c0 - (vertical ? 49 : 100), y0 - 10, 'o-xs', vertical ? 'XLogPos' : 'WALStart + 253', 'middle'));
    }
    if (f.headers) {
      const hs = ['event_id', 'event_type', `LSN ${lsn(EV.ack)}`, 'trace_id', 'span_id', 'parent_op', 'is_sampled'];
      svg.append(T(c0 - 10 * k - 6, y0 + hh / 2 + 4, 'o-xs o-mute', vertical ? '' : 'P1 ·', 'end'));
      let hx = vertical ? 10 : c0 - 10 * k; let hy = y0 + hh + 36;
      svg.append(T(hx, hy - 17, 'o-xs o-mute', vertical ? `headers · partition ${PARTITION}` : `headers · topic payments-user.user · partition ${PARTITION}`));
      for (const t of hs) {
        const w = t.length * 6.2 + 12;
        if (hx + w > W - 8) { hx = vertical ? 10 : c0 - 10 * k; hy += 20; }
        svg.append(s('rect', { x: hx, y: hy - 11, width: w, height: 16, rx: 8, class: t.startsWith('LSN') ? 'o-hdr is-lsn' : 'o-hdr' }), T(hx + w / 2, hy + 1, `o-xs${t.startsWith('LSN') ? ' o-b' : ''}`, t, 'middle'));
        hx += w + 5;
      }
    }
    if (f.back) {
      // only the LSN travels back; the slot jumps to it
      const ty = y0 + hh + 34;
      svg.append(tapeBand(c0 - 60 * k, c0 + coreW, ty, 30));
      const b = bookmark(ty - 12, ty + 34);
      b.setAttribute('transform', `translate(${c0 + coreW - 10},0)`);
      svg.append(b, T(c0 + coreW - 16, ty + 20, 'o-xs o-b o-safe', `confirmed_flush_lsn = ${lsn(EV.ack)}`, 'end'));
      svg.append(s('rect', { x: c0 + coreW - 118, y: y0 - 30, width: 110, height: 18, rx: 9, class: 'o-hdr is-lsn' }), T(c0 + coreW - 63, y0 - 17, 'o-xs o-b', `LSN ${lsn(EV.ack)}`, 'middle'),
        s('path', { d: `M${c0 + coreW - 63},${y0 - 12} C${c0 + coreW - 63},${ty - 30} ${c0 + coreW - 10},${ty - 30} ${c0 + coreW - 10},${ty - 14}`, class: 'o-edge-ack', 'marker-end': `url(#${aid}-g)` }));
      svg.querySelectorAll('.o-rec-msg').forEach((r) => r.classList.add('is-faded'));
    }
    stage.replaceChildren(svg);
  }
  function go(n) {
    i = clamp(n, 0, FORMS.length - 1);
    stops.forEach((b, k) => { b.setAttribute('aria-current', k === i ? 'step' : 'false'); b.classList.toggle('is-past', k < i); });
    draw();
    const f = FORMS[i];
    say.innerHTML = `<b class="o-stepn">${i + 1} · ${esc(f.stop)}</b> <span class="o-where">${esc(f.where)}</span><br>${f.say}`;
    more.replaceChildren();
    if (f.code) more.append(details('code', h('div', { html: codeBlock(f.code, [1]) })));
    if (i === 2) more.append(details('the bytes of this frame', h('div', { html: hexDump() })));
  }
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); }
  });
  app.append(nav, stage, say, more, colorKey([['k-data', 'the event’s 225 bytes'], ['k-free', 'envelope'], ['k-gap', 'the LSN from WALStart + 253'], ['k-safe', 'slot'], ['k-opt', 'stops']]));
  responsive(app, draw);
  go(0);
  more.addEventListener('mouseover', (e) => { const fld = e.target.closest('.o-fld'); if (fld) hot(fld); });
  more.addEventListener('focusin', (e) => { const fld = e.target.closest('.o-fld'); if (fld) hot(fld); });
  function hot(fld) { more.querySelectorAll('.o-fld').forEach((o) => o.classList.toggle('is-hot', o === fld)); const l = more.querySelector('.o-hexl .lab'); if (l) l.textContent = fld.dataset.l; }
}

/* The M frame exactly as received for event A, split into fields. */
const M_FIELDS = [
  ['p', "'M' logical message", ['4d']],
  ['p', 'flags 1 = transactional', ['01']],
  ['p', `message LSN ${lsn(A_MSG_LSN)}`, be(A_MSG_LSN, 8)],
  ['p', 'prefix "payments-user\\0"', [...utf8('payments-user'), '00']],
  ['p', 'content length 225', be(225, 4)],
  ['v', `field 1 id "${EV.id}"`, ['0a', '24', ...utf8(EV.id)]],
  ['v', 'field 2 aggregate_type "user"', ['12', '04', ...utf8('user')]],
  ['v', 'field 3 aggregate_id "user-12345"', ['1a', '0a', ...utf8('user-12345')]],
  ['v', 'field 4 event_type "user.created"', ['22', '0c', ...utf8('user.created')]],
  ['v', `field 5 payload ${EV.payload}`, ['2a', '2e', ...utf8(EV.payload)]],
  ['v', 'field 6 created_at 1778308245124811000 ns', hexOf('30f891c09ed5bdf4d618')],
  ['v', 'field 8 trace_info', hexOf('425f0a2034626639326633353737623334646136613363653932396430653065343733361210303066303637616130626139303262371a0f0a0a69735f73616d706c65641201311a180a09706172656e745f6f70120b687474702e736572766572')],
];
function hexDump() {
  const spans = M_FIELDS.map(([cls, label, bytes]) => {
    const shown = bytes.length > 20 ? `${bytes.slice(0, 10).join(' ')} … ${bytes.slice(-3).join(' ')}` : bytes.join(' ');
    return `<span class="o-fld ${cls}" tabindex="0" data-l="${esc(label)} · ${bytes.length} B">${shown}</span>`;
  }).join(' ');
  return `<div class="o-hex">${spans}</div><div class="o-hexl"><span><i></i>pgoutput header</span><span><i class="v"></i>protobuf</span><span class="lab">Hover or focus a field.</span></div>`;
}

/* ================================================================== RACE */

/* The reader plays Kafka: each partition acks its records in order, the
   partitions in any order. Two slots react to the same acks. Each event
   carries its message LSN (the safe choice in Figure 3); values are samples.
   Here a status update follows every ack. */
const RACE_L0 = 0x16B2848;
const RACE = [
  { e: 'e1', key: 'user-31', p: 0 }, { e: 'e2', key: 'user-20', p: 1 }, { e: 'e3', key: 'user-7', p: 2 },
  { e: 'e4', key: 'user-42', p: 1 }, { e: 'e5', key: 'user-63', p: 0 }, { e: 'e6', key: 'user-58', p: 2 },
].map((x, k) => ({ ...x, lsn: RACE_L0 + (k + 1) * 0x1F8 }));

function initRace(fig, app) {
  let acked = []; let crashed = false;
  const partBtns = [0, 1, 2].map((p) => btn('', () => ackNext(p), { class: 'o-part' }));
  const lanes = h('div', { class: 'o-lanes' });
  const say = h('p', { class: 'o-note', 'aria-live': 'polite' });
  const kill = btn('kill -9', () => { crashed = true; render(); }, { class: 'wv-btn o-crash' });
  const reset = btn('↺ start over', () => { acked = []; crashed = false; render(); }, { class: 'wv-btn o-ghost' });
  function ackNext(p) {
    if (crashed) return;
    const k = RACE.findIndex((x, j) => x.p === p && !acked.includes(j));
    if (k >= 0) { acked.push(k); render(); }
  }
  const slots = () => {
    let latest = RACE_L0; let prefix = RACE_L0;
    for (const k of acked) latest = Math.max(latest, RACE[k].lsn); // Postgres ignores a confirm that moves backwards
    for (let j = 0; j < RACE.length && acked.includes(j); j++) prefix = RACE[j].lsn;
    return { latest, prefix };
  };
  function lane(title, tag, slot) {
    const behind = (k) => RACE[k].lsn < slot;
    const idx = RACE.filter((_, k) => behind(k)).length;
    const cells = RACE.map((x, k) => {
      const inK = acked.includes(k); const gap = behind(k) && !inK;
      let res = '';
      if (crashed) {
        const again = x.lsn >= slot;
        res = inK && again ? '<span class="r">twice</span>' : inK ? '<span class="r ok">once</span>' : again ? '<span class="r ok">once</span>' : '<span class="r bad">LOST</span>';
      }
      return `<span class="o-cell ${inK ? 'is-ok' : 'is-fly'}${gap ? ' is-gap' : ''}${acked[acked.length - 1] === k && !crashed ? ' is-now' : ''}"><b>${x.e}</b><span>P${x.p}</span>${res}</span>`;
    });
    cells.splice(idx, 0, '<span class="o-bm"><span>slot</span></span>');
    const lost = RACE.some((x, k) => !acked.includes(k) && x.lsn < slot);
    return `<div class="o-lanebox${crashed && lost ? ' is-bad' : ''}"><div class="o-lanet"><b>${title}</b> <span>${tag}</span></div><div class="o-rtape">${cells.join('')}</div></div>`;
  }
  function render() {
    const { latest, prefix } = slots();
    partBtns.forEach((b, p) => {
      const q = RACE.map((x, k) => [x, k]).filter(([x]) => x.p === p);
      b.innerHTML = `<b>P${p}</b> ${q.map(([x, k]) => `<span class="${acked.includes(k) ? 'is-ok' : ''}">${x.e}</span>`).join('')}<small>${q.every(([, k]) => acked.includes(k)) ? 'done' : 'ack next →'}</small>`;
      b.disabled = crashed || q.every(([, k]) => acked.includes(k));
    });
    lanes.innerHTML = lane('Slot follows the latest ack', 'factlib main', latest) + lane('Slot follows the contiguous acked prefix', 'the fix', prefix);
    kill.disabled = crashed;
    const lostLatest = RACE.some((x, k) => !acked.includes(k) && x.lsn < latest);
    if (!acked.length && !crashed) say.innerHTML = 'You are Kafka. Each partition acks its own records in order; the partitions finish in any order. Click a partition to ack its next record, then press <b>kill -9</b>. Can you make an event disappear?';
    else if (!crashed) say.innerHTML = latest > prefix ? '<b class="c-bad">The two slots disagree.</b> The latest-ack slot has passed an event that Kafka has not stored.' : 'Both slots agree so far. Try acking P1 or P2 before P0.';
    else say.innerHTML = lostLatest
      ? '<b class="c-bad">The latest-ack slot lost an event:</b> it moved past a record Kafka never stored, and Postgres will not send it again. The prefix slot resends it; a few events arrive twice instead.'
      : 'Nothing is lost this time, because the acks you gave left no gap behind the latest ack. Start over and ack P1 or P2 first.';
  }
  app.append(say, h('div', { class: 'o-partrow' }, ...partBtns), lanes, h('div', { class: 'o-opts' }, kill, reset),
    details('the code of each rule', h('div', { class: 'o-cols' },
      h('div', { html: codeBlock(['// factlib main · listenEventAck', 'case ackPos := <-w.AckXLogPos:', '    w.xLogPos = *ackPos      // the latest ack wins', 'case <-ticker.C:             // every 1 s', '    w.SendStandbyStatusUpdate()'], [2]) }),
      h('div', { html: codeBlock(['// contiguous acked prefix', 'w.acked[lsn] = true', 'for len(w.pending) > 0 && w.acked[w.pending[0]] {', '    w.safe = w.pending[0]', '    delete(w.acked, w.pending[0])', '    w.pending = w.pending[1:]', '}'], [2, 3]) }))),
    colorKey([['k-run', 'in flight'], ['k-held', 'in Kafka'], ['k-safe', 'slot'], ['k-gap', 'behind the slot, not in Kafka'], ['k-opt', 'your moves']]));
  render();
}

/* ================================================================ REPLAY */

/* Status updates go out every second (listenEventAck's ticker). A crash at
   time c, after the tick at k = floor(c), resends everything acked after k:
   events read in (k − d, c − d]. Events read in (c − d, c] were in flight. */
function initReplay(fig, app) {
  const P = { c: 2.42, R: 10000 }; const d = 0.02;
  let V = false; let G = null;
  const stage = h('div');
  const stats = h('div', { class: 'o-stats', 'aria-live': 'polite' });
  const rate = range('your events/sec', { min: 500, max: 50000, step: 500, value: P.R, fmt, oninput: (v) => { P.R = v; paint(); } });
  function draw(vertical) {
    V = vertical;
    const W = vertical ? 360 : 960; const H = vertical ? 170 : 150;
    const x0 = vertical ? 14 : 40; const x1 = W - (vertical ? 14 : 40);
    const X = (t) => x0 + (t / 3) * (x1 - x0); const inv = (x) => ((x - x0) / (x1 - x0)) * 3;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Timeline of status updates and a crash you can drag' });
    const aid = uid('oxr'); svg.innerHTML = arrowDefs(aid);
    const ty = 50; const th = 44;
    svg.append(T(x0, 18, 'o-xs o-mute', 'events read from the WAL, by time →'), tapeBand(x0, x1, ty, th));
    const segs = s('g'); svg.append(segs);
    for (let t = 0; t <= 3; t++) svg.append(T(X(t), ty + th + 20, 'o-xs o-b o-safe', t === 0 ? '0 s' : `${t} s`, 'middle'));
    const ticks = s('g'); svg.append(ticks);
    const last = T(0, ty - 10, 'o-xs o-safe o-b', ''); svg.append(last);
    const crash = s('g', { class: 'o-drag', tabindex: 0, role: 'slider', 'aria-label': 'Crash time', 'aria-valuemin': 0.05, 'aria-valuemax': 2.95 });
    crash.append(s('rect', { x: -12, y: ty - 26, width: 24, height: th + 60, class: 'o-hit' }), s('line', { x1: 0, x2: 0, y1: ty - 20, y2: ty + th + 26, class: 'o-crashline' }),
      s('path', { d: `M-9,${ty + th + 26} l18,0 l-9,-10 z`, class: 'o-grip' }));
    const clab = T(0, ty + th + 44, 'o-s o-bad o-b', ''); crash.append(clab);
    svg.append(crash);
    let drag = false;
    const setc = (v) => { P.c = clamp(Math.round(v * 100) / 100, 0.05, 2.95); paint(); };
    svg.addEventListener('pointerdown', (e) => { drag = true; svg.setPointerCapture(e.pointerId); setc(inv(svgPt(svg, e).x)); e.preventDefault(); });
    svg.addEventListener('pointermove', (e) => { if (drag) setc(inv(svgPt(svg, e).x)); });
    svg.addEventListener('pointerup', () => { drag = false; });
    crash.addEventListener('keydown', (e) => { const k = { ArrowRight: 0.05, ArrowLeft: -0.05 }[e.key]; if (k) { setc(P.c + k); e.preventDefault(); e.stopPropagation(); } });
    stage.replaceChildren(svg);
    G = { X, segs, ticks, last, crash, clab, ty, th, W };
    paint();
  }
  function paint() {
    const { X, segs, ticks, last, crash, clab, ty, th, W } = G;
    const { c, R } = P; const k = Math.floor(c);
    segs.replaceChildren();
    const seg = (a, b, cls) => { if (b > a) segs.append(s('rect', { x: X(a), y: ty + 10, width: X(b) - X(a), height: th - 20, class: cls })); };
    seg(0, Math.max(0, k - d), 'o-seg-safe'); seg(Math.max(0, k - d), Math.max(0, c - d), 'o-seg-dup'); seg(Math.max(0, c - d), c, 'o-seg-fly');
    ticks.replaceChildren();
    for (let t = 0; t <= 3; t++) ticks.append(s('line', { x1: X(t), x2: X(t), y1: ty - 4, y2: ty + th + 4, class: t <= k ? 'o-tickline is-sent' : 'o-tickline' }));
    last.setAttribute('x', X(k) + 4); last.textContent = V ? `update · ${k} s` : `last status update · ${k} s`;
    crash.setAttribute('transform', `translate(${X(c)},0)`);
    crash.setAttribute('aria-valuenow', c); crash.setAttribute('aria-valuetext', `${c.toFixed(2)} seconds`);
    const right = X(c) > W * 0.7;
    clab.setAttribute('x', right ? -6 : 6); clab.setAttribute('text-anchor', right ? 'end' : 'start');
    clab.textContent = `kill -9 · ${c.toFixed(2)} s  (drag)`;
    const dup = Math.round(R * (c - k));
    stats.innerHTML = `<div class="o-stat is-dup"><span class="k">sent twice</span><span class="v">≈ ${fmt(dup)}</span><span class="u">${fmt(R)}/s × ${(c - k).toFixed(2)} s since the last update</span></div>
      <div class="o-stat is-ok"><span class="k">lost</span><span class="v">0</span><span class="u">the slot never passed an event Kafka did not store</span></div>`;
  }
  const dedupe = codeBlock([
    'INSERT INTO processed_events (id, processed_at)',
    `VALUES («'${EV.id}'», now())`,
    'ON CONFLICT (id) DO NOTHING;',
    '⟪INSERT 0 1⟫   -- first copy: handle it',
    '⟦INSERT 0 0⟧   -- second copy: skip it',
  ], [3, 4]);
  app.append(h('div', { class: 'o-ranges' }, rate.el), stage, stats,
    h('div', { class: 'o-cap' }, 'The consumer drops the second copy by event.Id, in the same transaction as its side effect'), h('div', { html: dedupe }),
    colorKey([['k-safe', 'confirmed'], ['k-gap', 'in Kafka, not confirmed'], ['k-run', 'in flight (20 ms)'], ['k-opt', 'drag / set']]));
  responsive(app, draw);
}

/* =============================================================== BACKLOG */

/* The reader enters their workload; the figure answers in time: how long
   Kafka can be down before each threshold. A stalled slot keeps the whole
   cluster's WAL. Postgres "10GB" = 10 GiB. */
const CAPS = [[0, 'off (-1)'], [10, '10GB'], [100, '100GB']];
function eventBytes(payload) {
  const data = 24 + 14 + payload;                // xl_logical_message + prefix + content
  const rec = 24 + (data > 255 ? 5 : 2) + data;  // XLogRecord + data header
  return Math.ceil(rec / 8) * 8 + 48;            // aligned, plus a 46 B COMMIT (aligned 48)
}
function initBacklog(fig, app) {
  const P = { eps: 10000, payload: 500, other: 5, cap: 1, disk: 500 };
  let V = false;
  const stage = h('div'); const verdict = h('div', { class: 'o-verdict', 'aria-live': 'polite' }); const math = h('p', { class: 'o-small' });
  const capBtns = CAPS.map(([, lab], k) => btn(h('code', null, lab), () => { P.cap = k; capBtns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === k))); draw(V); }, { 'aria-pressed': String(k === P.cap), class: 'wv-btn o-opt' }));
  const sl = [
    range('events/sec', { min: 500, max: 50000, step: 500, value: P.eps, fmt, oninput: (v) => { P.eps = v; draw(V); } }),
    range('payload', { min: 100, max: 10000, step: 100, value: P.payload, fmt: (v) => `${fmt(v)} B`, oninput: (v) => { P.payload = v; draw(V); } }),
    range('other WAL', { min: 0, max: 50, step: 1, value: P.other, fmt: (v) => `${v} MB/s`, oninput: (v) => { P.other = v; draw(V); } }),
    range('free disk', { min: 50, max: 2000, step: 50, value: P.disk, fmt: (v) => `${fmt(v)} GiB`, oninput: (v) => { P.disk = v; draw(V); } }),
  ];
  function draw(vertical) {
    V = vertical;
    const bpe = eventBytes(P.payload);
    const rate = P.eps * bpe + P.other * 1e6; // bytes per second
    const at = (gib) => (gib * 2 ** 30) / rate; // seconds until that much WAL is kept
    const cap = CAPS[P.cap][0];
    const marks = [[1, 'alert', 'look'], [5, 'page', 'look']];
    if (cap) marks.push([cap, `cap ${cap}GB`, 'bad']);
    marks.push([P.disk, 'disk full', 'bad']);
    const fail = Math.min(cap ? at(cap) : Infinity, at(P.disk));
    const W = vertical ? 360 : 960; const H = vertical ? 150 : 128;
    const x0 = vertical ? 12 : 30; const x1 = W - (vertical ? 12 : 30);
    const lo = Math.log10(30); const hi = Math.log10(7 * 86400);
    const X = (sec) => x0 + ((Math.log10(clamp(sec, 30, 7 * 86400)) - lo) / (hi - lo)) * (x1 - x0);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'How long Kafka can be down before each threshold' });
    const ty = 46; const th = 36;
    svg.append(T(x0, 16, 'o-xs o-mute', 'Kafka has been down for … (log scale) →'), tapeBand(x0, x1, ty, th));
    svg.append(s('rect', { x: x0, y: ty + 8, width: X(fail) - x0, height: th - 16, class: 'o-seg-safe' }));
    if (fail < 7 * 86400) svg.append(s('rect', { x: X(fail), y: ty + 8, width: x1 - X(fail), height: th - 16, class: 'o-seg-dup' }));
    for (const [sec, lab] of [[60, '1 min'], [600, '10 min'], [3600, '1 h'], [6 * 3600, '6 h'], [86400, '1 day'], [7 * 86400, '7 days']]) {
      svg.append(s('line', { x1: X(sec), x2: X(sec), y1: ty + th, y2: ty + th + 5, class: 'o-tick' }), T(X(sec), ty + th + 16, 'o-xs o-mute', lab, sec === 7 * 86400 ? 'end' : 'middle'));
    }
    const human = (sec) => (sec < 60 ? `${Math.round(sec)} s` : sec < 600 ? `${(sec / 60).toFixed(1)} min` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${(sec / 3600).toFixed(1)} h` : `${(sec / 86400).toFixed(1)} days`);
    let prevX = -99; let row = 0;
    marks.forEach(([g, lab, kind]) => {
      const sec = at(g); if (sec > 7 * 86400) return;
      const x = X(sec); row = x - prevX < (vertical ? 70 : 110) ? row + 1 : 0; prevX = x;
      const y = ty - 8 - row * 12;
      svg.append(s('line', { x1: x, x2: x, y1: y + 2, y2: ty + th, class: kind === 'bad' ? 'o-crashline' : 'o-markline' }),
        T(x, y, `o-xs o-b ${kind === 'bad' ? 'o-bad' : 'o-look'}`, `${lab} · ${human(sec)}`, x > W * 0.8 ? 'end' : x < W * 0.15 ? 'start' : 'middle'));
    });
    svg.append(T(x0, H - 6, 'o-xs o-safe o-b', `Kafka can be down for ${human(fail)} before something breaks`));
    stage.replaceChildren(svg);
    math.innerHTML = `${fmt(bpe)} B of WAL per event (record + COMMIT) × ${fmt(P.eps)}/s + ${P.other} MB/s other WAL = <b>${(rate / 1e6).toFixed(1)} MB/s</b> kept behind the slot.`;
    if (cap && at(cap) <= at(P.disk)) {
      verdict.className = 'o-verdict is-bad';
      verdict.textContent = `After ${human(at(cap))} the slot passes max_slot_wal_keep_size. At the next checkpoint Postgres invalidates it and removes the WAL; OwlPost can no longer stream, and those events need a backfill. Postgres keeps running.`;
    } else {
      verdict.className = 'o-verdict is-bad';
      verdict.textContent = `After ${human(at(P.disk))} pg_wal fills the disk. Postgres cannot write WAL and stops, and every writer on the cluster stops with it.`;
    }
  }
  app.append(h('div', { class: 'o-cap' }, 'Your workload'), h('div', { class: 'o-ranges' }, ...sl.slice(0, 3).map((x) => x.el)),
    h('div', { class: 'o-cap' }, 'Your settings'), h('div', { class: 'o-opts' }, h('span', { class: 'o-lab' }, 'max_slot_wal_keep_size'), ...capBtns), h('div', { class: 'o-ranges' }, sl[3].el),
    stage, verdict, math,
    colorKey([['k-held', 'safe to wait'], ['k-gap', 'past the first failure'], ['k-look', 'alert / page'], ['k-opt', 'your inputs']]));
  responsive(app, draw);
}

register({
  'oxb-commit': initCommit, 'oxb-ack-lsn': initAckLsn, 'oxb-follow': initFollow,
  'oxb-race': initRace, 'oxb-replay': initReplay, 'oxb-backlog': initBacklog,
});

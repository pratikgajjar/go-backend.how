/*
 * Figures for "The Outbox Without an Outbox".
 *
 * The WAL is a band; records sit on it at their LSN; the replication slot is
 * a green bookmark. Green means safe, red means lost; everything else is ink.
 *
 *   oxb-ack-lsn  drag the slot along a real WAL layout; the restart rule decides each fate
 *   oxb-race     the reader plays Kafka, acking partitions in any order; two slot rules react
 *   oxb-backlog  your write rate in, your outage budget out
 *
 * LSNs, record sizes and frame bytes come from one run on PostgreSQL 17.7
 * (wal_level = logical, pgoutput proto_version 1, messages 'true'). The
 * restart outcome of each ACK choice, the backward-confirm behaviour, and
 * slot invalidation under max_slot_wal_keep_size were checked on the same
 * server. Code refers to github.com/fampay-inc/factlib at cd2934e.
 */
import { h, s, colorKey, codeBlock, register, esc, lsn, btn, range, clamp, fmt, chips } from './lib.js';

const T = (x, y, cls, text, anchor = 'start') => s('text', { x, y, class: cls, 'text-anchor': anchor }, text);
/** The WAL band records sit on. */
const tapeBand = (x0, x1, y, hgt) => s('rect', { x: x0, y, width: x1 - x0, height: hgt, class: 'v-oxb-tape' });
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
const details = (summary, ...kids) => h('details', null, h('summary', null, summary), ...kids);
/* =============================================================== ACK LSN */

const CANDS = [
  { n: 1, at: A_MSG_LSN + M_FRAME, name: 'WALStart + len(WALData)', who: 'what factlib computes today',
    why: `<code>${lsn(A_MSG_LSN)}</code> + 253, the length of the pgoutput frame. <code>WALData</code> holds pgoutput bytes, not WAL bytes, so the sum is not a WAL position.` },
  { n: 2, at: A_MSG_LSN, name: 'WALStart', who: 'the message LSN',
    why: 'the end of A’s message record. A’s COMMIT starts at or after it, so a restart sends A again once.' },
  { n: 3, at: COMMIT_OF.A + 48, name: 'COMMIT end_lsn', who: 'after every message of A is acked',
    why: '<code>TransactionEndLSN</code> from A’s COMMIT frame. These rise in stream order.' },
];

function initAckLsn(fig, app) {
  const L0 = 0x15A06F8; const L1 = 0x15A0BD0;
  let ack = L0 + 16; let moved = false; let V = false; let G = null;
  const stage = h('div');
  const q = h('p', { class: 'wv-q' }, 'A is in Kafka. B is still in flight. Drag the green slot to where OwlPost should confirm, then look under each COMMIT.');
  const jump = chips(CANDS.map((c) => [c.at, `${c.n} · ${c.name}`]), (v) => set(v), { label: 'Jump to a mark' });
  const verdict = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const why = h('div', { class: 'wv-note' });

  function draw(vertical) {
    V = vertical;
    const W = vertical ? 360 : 960; const H = vertical ? 640 : 272;
    const m0 = vertical ? 80 : 24; const m1 = vertical ? 612 : 936;
    const P = (l) => m0 + ((l - L0) / (L1 - L0)) * (m1 - m0);
    const inv = (v) => L0 + ((v - m0) / (m1 - m0)) * (L1 - L0);
    const TR = vertical ? { A: [84, 168], B: [184, 268] } : { A: [66, 104], B: [154, 192] };
    const box = (l0, l1, c0, c1) => (vertical ? { x: c0, y: P(l0), width: c1 - c0, height: P(l1) - P(l0) } : { x: P(l0), y: c0, width: P(l1) - P(l0), height: c1 - c0 });
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'WAL records of transactions A and B with a movable slot' });
    for (const tx of ['A', 'B']) svg.append(s('rect', { ...box(L0, L1, TR[tx][0] - 7, TR[tx][1] + 7), class: 'v-oxb-tape' }));
    if (vertical) {
      svg.append(T(126, 24, 't-m t-b', 'A', 'middle'), T(126, 38, 't-xs t-mute', 'commits 1st', 'middle'), T(226, 24, 't-m t-b', 'B', 'middle'), T(226, 38, 't-xs t-mute', 'commits 2nd', 'middle'), T(4, 56, 't-xs t-mute', 'LSN ↓'));
    } else {
      svg.append(s('text', { x: m0, y: TR.A[0] - 14, class: 't-s' }, s('tspan', { class: 't-b' }, 'A '), s('tspan', { class: 't-mute' }, 'user-12345 · commits first · in Kafka')),
        s('text', { x: m0, y: TR.B[0] - 14, class: 't-s' }, s('tspan', { class: 't-b' }, 'B '), s('tspan', { class: 't-mute' }, 'user-12346 · writes first, commits second · in flight')),
        T(m1, H - 4, 't-xs t-mute', 'LSN →', 'end'));
    }
    const later = box(WAL_END, L1, TR.A[0], TR.B[1]);
    svg.append(s('rect', { ...later, class: 'v-oxb-later' }), vertical ? T(later.x + later.width / 2, later.y + later.height - 8, 't-xs t-mute', 'later WAL', 'middle') : T(later.x + 6, TR.A[0] + 14, 't-xs t-mute', 'later WAL'));
    for (const r of WAL) {
      const b = box(r.at, r.at + Math.ceil(r.len / 8) * 8, ...TR[r.tx]);
      svg.append(s('rect', { ...b, class: r.kind === 'COMMIT' ? 'v-oxb-rec v-oxb-rec-c' : 'v-oxb-rec' }));
      const cx = b.x + b.width / 2; const cy = b.y + b.height / 2;
      if (r.kind === 'MESSAGE') svg.append(T(cx, cy + 4, 't-xs t-b', vertical ? 'event' : `event · ${r.len} B`, 'middle'));
      else if (r.kind !== 'COMMIT') svg.append(T(cx, cy + 3.5, 't-xs', vertical ? '' : r.kind, 'middle'));
    }
    // COMMIT labels and fates, right next to each COMMIT record
    const fates = {};
    for (const tx of ['A', 'B']) {
      const b = box(COMMIT_OF[tx], COMMIT_OF[tx] + 48, ...TR[tx]);
      if (vertical) {
        svg.append(T(b.x + b.width / 2, b.y + b.height / 2 + 3.5, 't-xs t-b', 'COMMIT', 'middle'));
        fates[tx] = T(276, b.y + b.height / 2 + 4, 't-s t-b', '?', 'start');
      } else {
        svg.append(T(b.x + b.width / 2, TR[tx][1] + 20, 't-xs t-b', 'COMMIT', 'middle'));
        fates[tx] = T(b.x + b.width / 2, TR[tx][1] + 34, 't-s t-b', '?', 'middle');
      }
      svg.append(fates[tx]);
    }
    // candidate marks: numbered ticks on the axis
    for (const c of CANDS) {
      const v = P(c.at);
      const g = s('g', { class: 'v-oxb-cand', role: 'button', tabindex: -1 });
      if (vertical) g.append(s('circle', { cx: 68, cy: v, r: 7 }), T(68, v + 3.5, 't-xs t-b t-board', String(c.n), 'middle'), s('line', { x1: 72, x2: 272, y1: v, y2: v, class: 'v-oxb-candline' }));
      else g.append(s('circle', { cx: v, cy: TR.B[1] + 56, r: 8 }), T(v, TR.B[1] + 59.5, 't-xs t-b t-board', String(c.n), 'middle'), s('line', { x1: v, x2: v, y1: TR.A[0] - 8, y2: TR.B[1] + 48, class: 'v-oxb-candline' }));
      g.addEventListener('click', () => set(c.at));
      svg.append(g);
    }
    // the slot the reader drags
    const slot = s('g', { class: 'v-oxb-drag', tabindex: 0, role: 'slider', 'aria-label': 'Slot position (LSN)', 'aria-valuemin': L0, 'aria-valuemax': L1 });
    if (vertical) {
      slot.append(s('rect', { x: 66, y: -12, width: 220, height: 24, class: 'v-oxb-hit' }), s('line', { x1: 70, x2: 280, y1: 0, y2: 0, class: 'v-oxb-slot-line' }),
        s('path', { d: 'M2,-9 l54,0 l0,18 l-54,0 z', class: 'v-oxb-slot-flag' }), T(6, 4, 't-xs t-b t-board', 'slot ↕'));
    } else {
      slot.append(s('rect', { x: -12, y: 20, width: 24, height: TR.B[1] - 12, class: 'v-oxb-hit' }), s('line', { x1: 0, x2: 0, y1: 18, y2: TR.B[1] + 8, class: 'v-oxb-slot-line' }),
        s('path', { d: 'M0,4 l58,0 l-7,8 l7,8 l-58,0 z', class: 'v-oxb-slot-flag' }), T(5, 16, 't-xs t-b t-board', 'slot ↔'));
    }
    const lab = T(0, 0, 't-s t-b t-safe', ''); svg.append(slot, lab);
    // dragging
    const toL = (e) => { const p = svgPt(svg, e); return clamp(inv(vertical ? p.y : p.x), L0, L1); };
    const snap = (l) => { for (const c of CANDS) if (Math.abs(P(l) - P(c.at)) < 9) return c.at; return Math.round(l / 8) * 8; };
    let drag = false;
    svg.addEventListener('pointerdown', (e) => { if (e.target.closest('.v-oxb-cand')) return; drag = true; svg.setPointerCapture(e.pointerId); set(snap(toL(e))); e.preventDefault(); });
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
    const set1 = (t, txt, cls) => { t.textContent = moved ? txt : '?'; t.setAttribute('class', `t-s t-b ${moved ? cls : ''}`); };
    set1(fates.A, againA ? 'sent again' : 'in Kafka ✓', againA ? '' : 't-safe');
    set1(fates.B, againB ? 'sent again ✓' : 'LOST', againB ? 't-safe' : 't-bad');
    const c = CANDS.find((x) => x.at === ack);
    jump.set(c ? c.at : null);
    verdict.hidden = !moved;
    if (!moved) { verdict.textContent = ''; why.innerHTML = 'The marks 1–3 are LSNs OwlPost can compute. Try each, or anywhere else.'; return; }
    if (!againB) { verdict.className = 'wv-note'; verdict.textContent = 'B is lost. Its COMMIT is before the slot, so Postgres will not send B again, and Kafka never got it.'; }
    else if (againA) { verdict.className = 'wv-verdict is-good'; verdict.textContent = 'Safe. Postgres sends A again once (consumers drop the copy by event.Id) and sends B.'; }
    else { verdict.className = 'wv-verdict is-good'; verdict.textContent = 'Safe and exact. A is not repeated; B’s COMMIT starts at or after the slot, so B is sent again.'; }
    why.innerHTML = c ? `<b>${c.n} · ${esc(c.name)}</b>, ${esc(c.who)}: ${c.why}` : 'Rule: after a restart, Postgres sends a transaction again only if its COMMIT record starts at or after <code>confirmed_flush_lsn</code>.';
  }
  function set(l) { ack = l; moved = true; paint(); }

  const code = h('div', { html: codeBlock([
    'xld, _ := pglogrepl.ParseXLogData(msg.Data[1:])',
    `newXLogPos := xld.WALStart + pglogrepl.LSN(len(xld.WALData)) // 1: ⟦${lsn(A_MSG_LSN + M_FRAME)}⟧`,
    `newXLogPos := xld.WALStart                                   // 2: «${lsn(A_MSG_LSN)}»`,
    `txEnd := commitMsg.TransactionEndLSN                         // 3: «${lsn(COMMIT_OF.A + 48)}»`,
  ], [1]) });
  const stream = h('div', { class: 'wv-scroll', html: `<table class="wv-table"><thead><tr><th>#</th><th>frame</th><th>WALStart</th><th></th></tr></thead><tbody>${STREAM.map((r, j) => `<tr><td>${j + 1}</td><td><b>${r.tx}</b> ${r.f}</td><td>${lsn(r.at)}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table><p>B arrives second, but its message LSN is lower than A’s: message LSNs follow write order, the stream follows commit order.</p>` });
  app.append(q, stage, verdict, why, h('div', { class: 'wv-title v-oxb-gap' }, 'Jump to a mark'), jump.el,
    details('The code behind 1–3, and the frames in stream order', code, stream),
    colorKey([['k-safe', 'slot, safe'], ['k-gap', 'lost']]));
  responsive(app, draw);
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
  let acked = []; let crashed = false; let V = false;
  const partBtns = [0, 1, 2].map((p) => btn('', () => ackNext(p)));
  const stage = h('div');
  const say = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const kill = btn('kill -9', () => { if (crashed) { acked = []; crashed = false; } else crashed = true; render(); });
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
  /* One lane: six event cells on a WAL tape, the slot bookmark between them. */
  function lane(svg, y, W, title, slot) {
    const x0 = V ? 4 : 10; const x1 = W - x0; const gap = 16;
    const cw = (x1 - x0 - gap - 5 * 6) / 6;
    const behind = (k) => RACE[k].lsn < slot;
    const idx = RACE.filter((_, k) => behind(k)).length;
    svg.append(T(x0, y - 13, 't-s t-b', title));
    svg.append(tapeBand(x0, x1, y, 66));
    let x = x0 + 4; let sx = null;
    RACE.forEach((ev, k) => {
      if (k === idx) { sx = x + 4; x += gap; }
      const inK = acked.includes(k); const gapCell = behind(k) && !inK;
      const cell = s('rect', { x, y: y + 9, width: cw, height: 48, class: `v-oxb-cell${inK ? ' is-ok' : ''}${gapCell ? ' is-gap' : ''}` });
      svg.append(cell, T(x + cw / 2, y + 25, `t-s t-b${gapCell ? ' t-bad' : ''}`, ev.e, 'middle'), T(x + cw / 2, y + 38, 't-xs', `P${ev.p}`, 'middle'));
      if (crashed) {
        const again = ev.lsn >= slot;
        const r = inK && again ? ['twice', ''] : inK || again ? ['once', ''] : ['LOST', ' t-bad'];
        svg.append(T(x + cw / 2, y + 51, `t-xs t-b${r[1]}`, r[0], 'middle'));
      }
      x += cw + 6;
    });
    if (sx === null) sx = Math.min(x + 2, x1 - 2);
    // the slot goes on top, its flag below the band where no cell can cover it
    const fw = 34; const left = sx + fw > x1; // flip the flag near the right edge
    svg.append(s('line', { x1: sx, x2: sx, y1: y - 2, y2: y + 82, class: 'v-oxb-slot-line' }),
      s('path', { d: left ? `M${sx},${y + 68} l-${fw},0 l5,7 l-5,7 l${fw},0 z` : `M${sx},${y + 68} l${fw},0 l-5,7 l5,7 l-${fw},0 z`, class: 'v-oxb-slot-flag' }),
      T(left ? sx - 3 : sx + 3, y + 78.5, 't-xs t-b t-board', 'slot', left ? 'end' : 'start'));
  }
  function draw(vertical = V) {
    V = vertical;
    const W = vertical ? 360 : 960; const H = 224;
    const { latest, prefix } = slots();
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Two slots over the same six events' });
    lane(svg, 26, W, vertical ? 'Latest ack (factlib main)' : 'Slot follows the latest ack · factlib main', latest);
    lane(svg, 138, W, vertical ? 'Contiguous prefix (the fix)' : 'Slot follows the contiguous acked prefix · the fix', prefix);
    stage.replaceChildren(svg);
  }
  function render() {
    const { latest, prefix } = slots();
    partBtns.forEach((b, p) => {
      const q = RACE.map((x, k) => [x, k]).filter(([x]) => x.p === p);
      const done = q.every(([, k]) => acked.includes(k));
      b.innerHTML = `<b>P${p}</b> ${q.map(([x, k]) => (acked.includes(k) ? `<span class="c-safe">${x.e} ✓</span>` : x.e)).join(' ')} · ${done ? 'done' : 'ack next'}`;
      b.disabled = crashed || done;
    });
    draw();
    kill.textContent = crashed ? '↺ start over' : 'kill -9';
    kill.className = crashed ? 'wv-btn wv-btn--ghost' : 'wv-btn wv-btn--bad';
    const lostLatest = RACE.some((x, k) => !acked.includes(k) && x.lsn < latest);
    say.className = 'wv-note';
    if (!acked.length && !crashed) say.innerHTML = 'You are Kafka. Each partition acks its own records in order; the partitions finish in any order. Click a partition to ack its next record, then press <b>kill -9</b>. Can you make an event disappear?';
    else if (!crashed) say.innerHTML = latest > prefix ? '<b class="c-bad">The two slots disagree.</b> The latest-ack slot has passed an event that Kafka has not stored.' : 'Both slots agree so far. Try acking P1 or P2 before P0.';
    else {
      say.className = `wv-note ${lostLatest ? 'is-bad' : 'is-good'}`;
      say.innerHTML = lostLatest
        ? '<b>The latest-ack slot lost an event:</b> it moved past a record Kafka never stored, and Postgres will not send it again. The prefix slot resends it; a few events arrive twice instead.'
        : 'Nothing is lost this time, because the acks you gave left no gap behind the latest ack. Start over and ack P1 or P2 first.';
    }
  }
  app.append(say, h('div', { class: 'wv-bar' }, ...partBtns), stage, h('div', { class: 'wv-bar' }, kill),
    colorKey([['k-free', 'in flight'], ['k-held', 'in Kafka'], ['k-safe', 'slot'], ['k-gap', 'passed by the slot, not in Kafka']]));
  responsive(app, (v) => { V = v; render(); });
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
  const P = { eps: 10000, payload: 500, other: 5, cap: 1, disk: 500 }; // payload and free disk are fixed samples
  let V = false;
  const stage = h('div'); const verdict = h('div', { class: 'wv-verdict', 'aria-live': 'polite' }); const math = h('p', { class: 'v-oxb-gap' });
  const cap = chips(CAPS.map(([, lab], k) => [k, lab]), (k) => { P.cap = k; draw(V); }, { value: P.cap, label: 'max_slot_wal_keep_size' });
  const sl = [
    range('events/sec', { min: 500, max: 50000, step: 500, value: P.eps, fmt, oninput: (v) => { P.eps = v; draw(V); } }),
    range('other WAL', { min: 0, max: 50, step: 1, value: P.other, fmt: (v) => `${v} MB/s`, oninput: (v) => { P.other = v; draw(V); } }),
  ];
  function draw(vertical) {
    V = vertical;
    const bpe = eventBytes(P.payload);
    const rate = P.eps * bpe + P.other * 1e6; // bytes per second
    const at = (gib) => (gib * 2 ** 30) / rate; // seconds until that much WAL is kept
    const cap = CAPS[P.cap][0];
    const marks = [[1, 'alert', 'ink'], [5, 'page', 'ink']];
    if (cap) marks.push([cap, `cap ${cap}GB`, 'bad']);
    marks.push([P.disk, vertical ? 'disk full' : `disk full (${P.disk} GiB free)`, 'bad']);
    const fail = Math.min(cap ? at(cap) : Infinity, at(P.disk));
    const W = vertical ? 360 : 960; const H = vertical ? 150 : 128;
    const x0 = vertical ? 12 : 30; const x1 = W - (vertical ? 12 : 30);
    const lo = Math.log10(30); const hi = Math.log10(7 * 86400);
    const X = (sec) => x0 + ((Math.log10(clamp(sec, 30, 7 * 86400)) - lo) / (hi - lo)) * (x1 - x0);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'How long Kafka can be down before each threshold' });
    const ty = 46; const th = 36;
    svg.append(T(x0, 16, 't-xs t-mute', 'Kafka has been down for … (log scale) →'), tapeBand(x0, x1, ty, th));
    svg.append(s('rect', { x: x0, y: ty + 8, width: X(fail) - x0, height: th - 16, class: 'v-oxb-seg-safe' }));
    if (fail < 7 * 86400) svg.append(s('rect', { x: X(fail), y: ty + 8, width: x1 - X(fail), height: th - 16, class: 'v-oxb-seg-dup' }));
    for (const [sec, lab] of [[60, '1 min'], [600, '10 min'], [3600, '1 h'], [6 * 3600, '6 h'], [86400, '1 day'], [7 * 86400, '7 days']]) {
      svg.append(s('line', { x1: X(sec), x2: X(sec), y1: ty + th, y2: ty + th + 5, class: 'v-oxb-tick' }), T(X(sec), ty + th + 16, 't-xs t-mute', lab, sec === 7 * 86400 ? 'end' : 'middle'));
    }
    const human = (sec) => (sec < 60 ? `${Math.round(sec)} s` : sec < 600 ? `${(sec / 60).toFixed(1)} min` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${(sec / 3600).toFixed(1)} h` : `${(sec / 86400).toFixed(1)} days`);
    let prevX = -99; let row = 0;
    marks.forEach(([g, lab, kind]) => {
      const sec = at(g); if (sec > 7 * 86400) return;
      const x = X(sec); row = x - prevX < (vertical ? 70 : 110) ? row + 1 : 0; prevX = x;
      const y = ty - 8 - row * 12;
      svg.append(s('line', { x1: x, x2: x, y1: y + 2, y2: ty + th, class: kind === 'bad' ? 'v-oxb-crashline' : 'v-oxb-markline' }),
        T(x, y, `t-xs t-b${kind === 'bad' ? ' t-bad' : ''}`, `${lab} · ${human(sec)}`, x > W * 0.8 ? 'end' : x < W * 0.15 ? 'start' : 'middle'));
    });
    svg.append(T(x0, H - 6, 't-xs t-safe t-b', `Kafka can be down for ${human(fail)} before something breaks`));
    stage.replaceChildren(svg);
    math.innerHTML = `${fmt(bpe)} B of WAL per 500-byte event (record + COMMIT) × ${fmt(P.eps)}/s + ${P.other} MB/s other WAL = <b>${(rate / 1e6).toFixed(1)} MB/s</b> kept behind the slot.`;
    if (cap && at(cap) <= at(P.disk)) {
      verdict.className = 'wv-note';
      verdict.textContent = `After ${human(at(cap))} the slot passes max_slot_wal_keep_size. At the next checkpoint Postgres invalidates it and removes the WAL; OwlPost can no longer stream, and those events need a backfill. Postgres keeps running.`;
    } else {
      verdict.className = 'wv-note';
      verdict.textContent = `After ${human(at(P.disk))} pg_wal fills the disk. Postgres cannot write WAL and stops, and every writer on the cluster stops with it.`;
    }
  }
  app.append(h('div', { class: 'wv-grid-ctrl' }, ...sl.map((x) => x.el)),
    h('div', { class: 'wv-title v-oxb-gap' }, 'max_slot_wal_keep_size'), cap.el,
    stage, verdict, math,
    colorKey([['k-held', 'safe to wait'], ['k-gap', 'past the first failure']]));
  responsive(app, draw);
}

register({ 'oxb-ack-lsn': initAckLsn, 'oxb-race': initRace, 'oxb-backlog': initBacklog });

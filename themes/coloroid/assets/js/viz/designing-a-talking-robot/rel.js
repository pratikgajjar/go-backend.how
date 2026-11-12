/*
 * Reliability figures for "Designing a robot that talks with kids".
 *
 *   robot-ladder  fallbacks: pick a failure, watch recovery climb
 *                 thread → process → robot → OS image
 *   robot-split   local and cloud brains: one turn as two event logs
 *
 * Values (timers, counts, ranking, waits) come from the post. Sentences,
 * turn ids and answer times are samples.
 */

import { h, s, btn, colorKey, register, onVisible, REDUCED, tween } from '../lib.js';

const L = 'v-bot-rl-';
const S = 'v-bot-rs-';

/* ---------------------------------------------------------------- shared */

function arrowDefs(svg, cls) {
  const id = `${cls}a${Math.random().toString(36).slice(2, 7)}`;
  svg.append(s('defs', null, s('marker', {
    id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  }, s('path', { d: 'M0,1 L9,5 L0,9 z', class: `${cls}ah` }))));
  return `url(#${id})`;
}

/** Box with centred lines. First line bold. Returns { g, rect, texts }. */
function box(x, y, w, hh, lines, { dash = false, cls = '' } = {}) {
  const g = s('g', { class: `node ${cls}` });
  const rect = s('rect', { class: `box${dash ? ' dash' : ''}`, x, y, width: w, height: hh });
  g.append(rect);
  const lh = 13.5;
  const top = y + hh / 2 - ((lines.length - 1) * lh) / 2 + 4;
  const texts = lines.map((t, i) => {
    const el = s('text', { x: x + w / 2, y: top + i * lh, 'text-anchor': 'middle', class: i === 0 ? 't-s t-b' : 't-xs' }, t);
    g.append(el);
    return el;
  });
  return { g, rect, texts };
}

/* ============================================ Fig. robot-ladder (fallbacks) */

const RUNGS = [
  { name: 'thread', sub: 'retry, time out, fall back', y: 224 },
  { name: 'process', sub: 'restart one service', y: 168 },
  { name: 'robot', sub: 'reboot the robot', y: 112 },
  { name: 'OS image', sub: 'A/B slots, update check', y: 56 },
];
const RH = 44;
const RULES = {
  wait: 'Every wait has a timeout, and every timeout has a next step.',
  fast: 'A fast, explicit failure is better than a slow one.',
  data: 'No recovery may destroy the child\'s data.',
  small: 'Recovery starts with the smallest unit and moves up.',
};
const FAILS = [
  {
    id: 'loop', label: '20 fast crashes', where: 'any service', what: 'crash loop',
    stages: [
      { rung: 1, do: 'restart after a crash', wait: 'up to 20 fast crashes' },
      { rung: 2, do: 'robot reboots', wait: 'after a 15 s countdown' },
      { rung: 3, do: 'forced update check', wait: '2 reboots in 10 min' },
    ],
    why: 'A restart does not fix every bug. After 20 fast crashes, the robot counts down 15 s and reboots. After 2 forced reboots in 10 min, it forces an update check. The next step up, Android\'s automatic factory reset, is turned off.',
    rule: 'data',
  },
  {
    id: 'mic', label: 'Mic board silent', where: 'mic DSP board', what: 'no audio',
    stages: [{ rung: 1, do: 'restart speech service', wait: '15 s with no audio' }],
    why: 'If no audio arrives from the mic board for 15 s, the speech service exits. The launcher starts it again. While the robot sleeps, the board is also reset every 15 min, because it drifts in long sleep.',
    rule: 'wait',
  },
  {
    id: 'vision', label: 'Vision stuck', where: 'vision service', what: 'detector stuck',
    stages: [{ rung: 1, do: 'restart vision service', wait: 'stuck for 300 frames' }],
    why: 'If the detector is stuck for 300 frames, the vision service crashes itself on purpose. The launcher starts it again.',
    rule: 'fast',
  },
  {
    id: 'proc', label: 'Service dies', where: 'any service', what: 'process dies',
    stages: [{ rung: 1, do: 'launcher restarts it', wait: 'in a few seconds' }],
    why: 'The launcher watches every service. When one dies, the launcher starts it again in a few seconds.',
    rule: 'small',
  },
  {
    id: 'motor', label: 'Motor board no reply', where: 'motor board', what: 'no reply',
    stages: [
      { rung: 0, do: 'retry the power change', wait: '4 tries of 200 ms' },
      { rung: 2, do: 'robot reboots', wait: 'still no reply' },
    ],
    why: 'A power change to the motor board must get a reply. The robot tries 4 times, 200 ms each, then reboots. If the board\'s own firmware watchdog fires, the robot also reboots.',
    rule: 'wait',
  },
  {
    id: 'cloud', label: 'Cloud no answer', where: 'cloud chat', what: 'no answer',
    stages: [{ rung: 0, do: 'say a fallback line', wait: 'no answer in 9.5 s' }],
    why: 'The dialogue waits 9.5 s for the cloud, then the robot says a local fallback line. If the cloud link is down, it replies "offline" at once, so there is no wait.',
    rule: 'wait',
  },
  {
    id: 'state', label: 'Corrupt state file', where: 'dialogue state', what: 'corrupt file',
    stages: [{ rung: 0, do: 'load a backup copy', wait: 'checksum fails' }],
    why: 'Each user\'s dialogue state file has a checksum and 4 backup copies. If the checksum fails, the engine loads a backup copy, so the child\'s progress survives.',
    rule: 'data',
  },
  {
    id: 'update', label: 'Update fails', where: 'update', what: 'install fails',
    stages: [{ rung: 3, do: 'keep the running image', wait: 'install fails' }],
    why: 'An update writes the inactive A/B slot. If the install fails, the running image is untouched and the robot keeps working.',
    rule: 'data',
  },
];
const STAGE_MS = 1300;

function initLadder(fig, app) {
  let at = 0;
  let fail = FAILS[at];
  let shown = 0; // stages revealed (fail.stages.length + 1 = done)
  let timer = null;
  let barStop = () => {};

  const svg = s('svg', { viewBox: '0 0 360 330', role: 'img', 'aria-label': 'Recovery levels from bottom to top: thread, process, robot, OS image. Factory reset at the top is turned off.' });
  const ah = arrowDefs(svg, L);
  const climb = s('line', { class: `${L}climb`, x1: 186, x2: 186, y1: 284, y2: 284, 'marker-end': ah });
  const top = box(8, 8, 344, 36, [], { dash: true, cls: 'is-bad' });
  top.g.append(
    s('text', { x: 16, y: 23, class: 't-s t-b' }, 'factory reset'),
    s('text', { x: 16, y: 37, class: 't-xs' }, 'turned off'),
    s('text', { x: 200, y: 23, class: 't-xs t-b t-bad' }, 'never used'),
    s('text', { x: 200, y: 37, class: 't-xs' }, 'it forgets the child'),
  );
  const rungs = RUNGS.map((r) => {
    const b = box(8, r.y, 344, RH, []);
    const doT = s('text', { x: 200, y: r.y + 18, class: 't-xs t-b' });
    const waitT = s('text', { x: 200, y: r.y + 32, class: 't-xs' });
    const barBg = s('rect', { class: `${L}barbg`, x: 200, y: r.y + 36, width: 140, height: 3 });
    const bar = s('rect', { class: `${L}bar`, x: 200, y: r.y + 36, width: 0, height: 3 });
    const dot = s('circle', { class: `${L}dot`, cx: 186, cy: r.y + RH / 2, r: 4.5 });
    b.g.append(
      s('text', { x: 16, y: r.y + 19, class: 't-s t-b' }, r.name),
      s('text', { x: 16, y: r.y + 34, class: 't-xs' }, r.sub),
      doT, waitT, barBg, bar, dot,
    );
    return { ...b, doT, waitT, bar, barBg, dot };
  });
  const failBox = box(8, 284, 344, 38, [], { dash: true, cls: 'is-bad' });
  const failT1 = s('text', { x: 16, y: 299, class: 't-s t-b' });
  const failT2 = s('text', { x: 16, y: 313, class: 't-xs' });
  failBox.g.append(failT1, failT2, s('text', { x: 200, y: 306, class: 't-xs t-b t-bad' }, 'failure'));
  svg.append(top.g, ...rungs.map((r) => r.g), failBox.g, climb);

  const title = h('h5');
  const list = h('ol', { class: `${L}list` });
  const rule = h('p', { class: 'wv-note' });
  const log = h('p', { class: `${L}cap` }, 'Every recovery also writes an error code to the event log, and the event log goes to the cloud.');
  const panel = h('div', { class: `wv-card ${L}panel`, 'aria-live': 'polite' }, title, list, rule, log);

  function paint() {
    const done = shown > fail.stages.length;
    const live = Math.min(shown, fail.stages.length) - 1; // index of the stage on screen
    const byRung = new Map(fail.stages.map((st, k) => [st.rung, k]));
    const last = fail.stages[fail.stages.length - 1].rung;
    failT1.textContent = fail.where;
    failT2.textContent = fail.what;
    rungs.forEach((r, ri) => {
      const k = byRung.get(ri);
      const reached = k !== undefined && k <= live;
      const isCur = reached && k === live && !done;
      r.g.classList.toggle('is-focus', isCur);
      r.g.classList.toggle(`${L}ok`, done && ri === last);
      r.g.classList.toggle('is-dim', !reached);
      r.doT.textContent = reached ? fail.stages[k].do : '';
      r.waitT.textContent = reached ? fail.stages[k].wait : '';
      r.dot.style.display = reached ? '' : 'none';
      r.barBg.style.display = reached ? '' : 'none';
      r.bar.style.display = reached ? '' : 'none';
      if (reached && k < live) r.bar.setAttribute('width', 140);
      if (done && reached) r.bar.setAttribute('width', 140);
    });
    const topRung = live >= 0 ? fail.stages[live].rung : -1;
    climb.setAttribute('y2', topRung >= 0 ? RUNGS[topRung].y + RH / 2 + 6 : 284);
    climb.style.display = topRung >= 0 ? '' : 'none';
    climb.classList.toggle('is-done', done);

    title.textContent = fail.label;
    list.replaceChildren(...fail.stages.map((st, k) => h('li', { class: k <= live ? '' : `${L}later` },
      h('b', null, RUNGS[st.rung].name), ` · ${st.wait} → ${st.do}`)));
    rule.textContent = done ? fail.why : 'Recovery is climbing…';
    rule.className = `wv-note${done ? ' is-good' : ''}`;
    if (done) rule.prepend(h('span', { class: 'k' }, 'Rule'), RULES[fail.rule], h('br'));
  }

  function fillBar(k) {
    barStop();
    const r = rungs[fail.stages[k].rung];
    r.bar.setAttribute('width', 0);
    barStop = tween(STAGE_MS - 200, (t) => r.bar.setAttribute('width', 140 * t));
  }

  function stop() { clearTimeout(timer); timer = null; }
  function run() {
    stop();
    barStop();
    if (REDUCED) { shown = fail.stages.length + 1; paint(); return; }
    shown = 0;
    paint();
    const tick = () => {
      shown += 1;
      paint();
      if (shown <= fail.stages.length) { fillBar(shown - 1); timer = setTimeout(tick, STAGE_MS); } else timer = null;
    };
    timer = setTimeout(tick, 250);
  }

  // One button walks the 8 failures; each plays when it is shown.
  const next = btn('', () => {
    at = (at + 1) % FAILS.length;
    fail = FAILS[at];
    paintNext();
    run();
  });
  function paintNext() {
    next.textContent = `Next failure ▶ (${at + 1}/${FAILS.length})`;
    next.setAttribute('aria-label', `Next failure. Now showing ${at + 1} of ${FAILS.length}: ${fail.label}.`);
  }
  paintNext();
  app.append(
    h('div', { class: 'wv-bar' }, next),
    h('div', { class: `${L}grid` }, h('div', { class: `${L}svg` }, svg), h('div', null, panel)),
    colorKey([['k-gap', 'failure'], ['k-look', 'recovery in progress'], ['k-held', 'recovered']]),
  );
  shown = fail.stages.length + 1;
  paint();
  let started = false;
  onVisible(fig, (v) => {
    if (v && !started) { started = true; run(); }
    if (!v) stop();
  });
}

/* ============================================ Fig. robot-split (two event logs) */

/*
 * One turn as two append-only logs on one clock. A row is one moment.
 * L and R are the robot's and the cloud's events: [what happened, turn id].
 * `go` marks a message that crosses the network: 'r' robot → cloud,
 * 'l' cloud → robot. `cut` lists earlier events ([key, side]) that this event
 * discards: they stay in the log, struck through. `fx` folds the event into
 * the state, so both state strips come from the log alone. `rank` shows the
 * ranking rule at the moment it runs.
 * Times, sentences and turn ids are samples; waits and rules come from the post.
 */
const RANKS = ['command', 'script answer', 'other answer', 'fallback'];

const ev = {
  said: (t, turn, words, where) => ({ t, L: [`child said "${words}"${where ? ` (${where})` : ''}`, turn] }),
  send: (t, turn, words, extra = '') => ({
    t, L: [`sent words${extra} to cloud`, turn], go: 'r', R: [`got words${extra}`, turn],
    fx: (st) => st.tx.push([turn, 'child', words]),
  }),
  local: (t, turn, type) => ({ t, k: 'local', L: [`local rules: ${RANKS[type]}`, turn], fx: (st) => { st.buf = turn; } }),
  answer: (t, turn, type, mine = 'got cloud answer') => ({ t, k: 'ans', R: [`answer ready: ${RANKS[type]}`, turn], go: 'l', L: [mine, turn] }),
  rank: (t, turn, L, C, win) => ({ t, L: [`ranked: ${win === 'C' ? 'cloud' : 'local'} answer wins`, turn], rank: { L, C, win } }),
  commit: (t, turn) => ({ t, L: ['turn committed: saved to disk', turn], fx: (st) => { st.saved = turn; st.buf = null; st.wrote = true; } }),
  rollback: (t, turn) => ({ t, L: ['turn rolled back: state as before', turn], cut: [['local', 'L']], fx: (st) => { st.buf = null; } }),
  report: (t, turn, line, did = 'said') => ({
    t, L: [`told cloud what it ${did}`, turn], go: 'r', R: ['robot line written', turn],
    fx: (st) => st.tx.push([turn, 'robot', line]),
  }),
  keep: (t, turn) => ({ t, R: ['keeps turn', turn] }),
  drop: (t, turn, next) => ({ t, L: [`next request (${next}): drop turn`, turn], go: 'r', R: ['drops turn', turn], cut: [['ans', 'R']] }),
};

const CASES = [
  {
    id: 'local', label: 'Local only (command)', saved: 'c39',
    rows: [
      ev.said(0, 'c40', 'speak up', 'quiz'),
      ev.send(0, 'c40', 'speak up'),
      ev.local(2, 'c40', 0),
      { t: 800, L: ['waited 800 ms: no cloud answer', 'c40'] },
      ev.rank(800, 'c40', 0, null, 'L'),
      { t: 800, L: ['robot turns its volume up', 'c40'] },
      ev.commit(800, 'c40'),
      ev.report(900, 'c40', '(volume up)', 'did'),
    ],
  },
  {
    id: 'cloud', label: 'Cloud answer wins', saved: 'c39',
    rows: [
      ev.said(0, 'c40', 'a lion!', 'quiz'),
      ev.send(0, 'c40', 'a lion!'),
      ev.local(3, 'c40', 3),
      { t: 800, L: ['only a fallback: wait 1,000 ms more', 'c40'] },
      ev.answer(1400, 'c40', 2),
      ev.rank(1400, 'c40', 3, 2, 'C'),
      ev.rollback(1400, 'c40'),
      { t: 1400, L: ['robot says "Lions live in groups."', 'c40'] },
      ev.report(3500, 'c40', 'Lions live in groups.'),
      ev.keep(3500, 'c40'),
    ],
  },
  {
    id: 'same', label: 'Same type: local wins', saved: 'c39',
    rows: [
      ev.said(0, 'c40', 'speak up', 'quiz'),
      ev.send(0, 'c40', 'speak up'),
      ev.local(2, 'c40', 0),
      ev.answer(500, 'c40', 0),
      ev.rank(500, 'c40', 0, 0, 'L'),
      { t: 500, L: ['robot turns its volume up', 'c40'] },
      ev.commit(500, 'c40'),
      ev.report(600, 'c40', '(volume up)', 'did'),
      ev.drop('next', 'c40', 'c41'),
    ],
  },
  {
    id: 'late', label: 'Late answer (old turn id)', saved: 'c40', tx: [['c40', 'child', 'a lion!']],
    rows: [
      ev.said(0, 'c41', 'a zebra!', 'quiz'),
      ev.send(0, 'c41', 'a zebra!'),
      ev.local(3, 'c41', 1),
      { ...ev.answer(300, 'c40', 2, 'got answer for an old turn'), k: 'old' },
      { t: 300, L: ['not the current turn: ignored', 'c40'], cut: [['old', 'L']] },
      { t: 800, L: ['waited 800 ms: no answer for c41', 'c41'] },
      ev.rank(800, 'c41', 1, null, 'L'),
      { t: 800, L: ['robot says "Yes! Zebras have stripes."', 'c41'] },
      ev.commit(800, 'c41'),
      ev.report(2900, 'c41', 'Yes! Zebras have stripes.'),
    ],
  },
  {
    id: 'talk', label: 'Child still talking', saved: 'a90',
    rows: [
      ev.said(0, 'a91', 'I saw a tiger…', 'conversation'),
      ev.send(0, 'a91', 'I saw a tiger…'),
      ev.local(2, 'a91', 3),
      { t: 2, L: ['curious filler now; give up at 9.5 s', 'a91'] },
      ev.answer(1600, 'a91', 2),
      ev.rank(1600, 'a91', 3, 2, 'C'),
      ev.rollback(1600, 'a91'),
      { t: 1600, L: ['child still talking: answer waits', 'a91'] },
      { t: 2200, L: ['child stopped talking', 'a91'] },
      { t: 3200, L: ['quiet for 1 s: robot says "Tigers are the biggest cats!"', 'a91'] },
      ev.report(5400, 'a91', 'Tigers are the biggest cats!'),
      ev.keep(5400, 'a91'),
    ],
  },
  {
    id: 'alone', label: 'Local answered alone', saved: 'a90',
    rows: [
      ev.said(0, 'a91', 'what do tigers eat?', 'conversation'),
      ev.send(0, 'a91', 'what do tigers eat?'),
      ev.local(2, 'a91', 3),
      { t: 2, L: ['curious filler now; give up at 9.5 s', 'a91'] },
      { t: 9500, L: ['no cloud answer in 9.5 s', 'a91'] },
      { t: 9500, L: ['robot says the fallback line "I didn\'t get that."', 'a91'] },
      ev.commit(9500, 'a91'),
      ev.report(10800, 'a91', 'I didn\'t get that.'),
    ],
  },
  {
    id: 'settings', label: 'Settings', saved: 'a91',
    rows: [
      { t: 'before', R: ['parent set filler profile: slower'], fx: (st) => { st.set = 'slower'; } },
      { t: 'before', R: ['pushed settings'], go: 'l', L: ['got a settings copy'], fx: (st) => { st.copy = 'slower'; } },
      ev.said(0, 'a92', 'I saw a tiger', 'conversation'),
      ev.send(0, 'a92', 'I saw a tiger', ' + settings copy'),
      ev.local(2, 'a92', 3),
      { t: 2, L: ['curious filler for 1,500 ms (slower)', 'a92'] },
    ],
  },
];
const SPLIT_MS = 1100;
const tLabel = (t) => (typeof t === 'string' ? t : t.toLocaleString('en-US'));
const tLong = (t) => ({ before: 'before the turn', next: 'next turn' }[t] ?? `${tLabel(t)} ms`);

function initSplit(fig, app) {
  let sc = CASES[0];
  let n = sc.rows.length; // events shown; the full log until the figure is first seen
  let timer = null;
  let rowEls = [];

  const sr = (t) => h('span', { class: `${S}sr` }, t);
  const body = h('ol', { class: `${S}rows` });
  const stL = h('div', { class: `${S}state` });
  const stR = h('div', { class: `${S}state` });
  const log = h('div', { class: `${S}log`, role: 'group', 'aria-label': 'Two event logs: the robot on the left, the cloud on the right, time in ms down the middle.' },
    h('div', { class: `${S}row ${S}head`, 'aria-hidden': 'true' }, h('div', null, 'Robot (local)'), h('div', { class: `${S}t` }, 'ms'), h('div', null, 'Cloud')),
    body,
    h('div', { class: `${S}row ${S}foot` }, stL, h('div'), stR));
  const live = h('p', { class: `${S}sr`, 'aria-live': 'polite' });

  /** The ranking rule, drawn inside the event that applies it. */
  function rankList({ L: l, C: c, win }) {
    const tag = (side) => h('b', { class: `${S}tag${win === side ? ' is-win' : ''}` }, side === 'L' ? 'local' : 'cloud');
    return h('ol', { class: `${S}rank` },
      ...RANKS.map((name, i) => h('li', { class: i === l || i === c ? 'is-on' : '' }, `${i + 1} ${name} `, i === l ? tag('L') : '', i === c ? tag('C') : '')),
      h('li', { class: l === c ? 'is-on' : '' }, 'same type → local'));
  }

  function build() {
    let prev = null;
    rowEls = sc.rows.map((r) => {
      const cell = (side) => {
        const e = r[side];
        if (!e) return h('div', { class: `${S}c` });
        const card = h('div', { class: `${S}ev` }, sr(side === 'L' ? 'Robot: ' : 'Cloud: '), `${e[0]} `, e[1] ? h('span', { class: `${S}id` }, e[1]) : '');
        if (side === 'L' && r.rank) card.append(rankList(r.rank));
        return h('div', { class: `${S}c` }, card);
      };
      const mid = h('div', { class: `${S}t` }, h('span', { class: `${S}tt` }, r.t === prev ? '' : tLabel(r.t)), sr(`, ${tLong(r.t)}.`));
      prev = r.t;
      if (r.go) { mid.classList.add('has-arr'); mid.append(h('i', { class: `${S}arr is-${r.go}`, 'aria-hidden': 'true' })); }
      return h('li', { class: `${S}row` }, cell('L'), mid, cell('R'));
    });
    body.replaceChildren(...rowEls);
    input.max = sc.rows.length;
  }

  /** Replay the first k events into a fresh state: the strips are a fold over the log. */
  function fold(k) {
    const st = { saved: sc.saved, buf: null, wrote: false, tx: (sc.tx || []).map((x) => [...x]), set: 'default', copy: 'default' };
    const cut = new Set();
    sc.rows.slice(0, k).forEach((r) => {
      r.fx?.(st);
      r.cut?.forEach(([key, side]) => cut.add(`${sc.rows.findIndex((x) => x.k === key)}${side}`));
    });
    return { st, cut };
  }

  const pad = (lines, size) => { while (lines.length < size) lines.push(h('div', { 'aria-hidden': 'true' }, '\u00a0')); return lines; };

  function paint() {
    const N = sc.rows.length;
    const { st, cut } = fold(n);
    rowEls.forEach((li, i) => {
      li.classList.toggle('is-off', i >= n);
      li.classList.toggle('is-now', i === n - 1);
      [['L', 0], ['R', 2]].forEach(([side, col]) => {
        const card = li.children[col].firstChild;
        if (!card) return;
        const isCut = cut.has(`${i}${side}`);
        card.classList.toggle('is-cut', isCut);
        card.querySelector(`.${S}x`)?.remove();
        if (isCut) card.append(h('span', { class: `${S}sr ${S}x` }, ' (discarded)'));
      });
    });
    const id = (v) => h('span', { class: `${S}id` }, v);
    stL.replaceChildren(
      h('div', { class: `${S}sh` }, h('b', null, 'script position'), ' · robot writes'),
      h('div', { class: st.wrote ? `${S}ok` : '' }, 'saved: after turn ', id(st.saved)),
      h('div', null, 'buffer: ', st.buf ? h('span', null, 'turn ', id(st.buf)) : 'empty'),
      h('div', { class: `${S}ro` }, `settings copy: ${st.copy} (read-only)`),
    );
    const maxTx = fold(N).st.tx.length;
    stR.replaceChildren(
      h('div', { class: `${S}sh` }, h('b', null, 'transcript, settings'), ' · cloud writes'),
      h('div', { class: st.set !== 'default' ? `${S}ok` : '' }, `filler profile: ${st.set}`),
      ...pad(st.tx.map(([turn, who, text]) => h('div', null, id(turn), ` ${who}: "${text}"`)), maxTx),
    );
    input.value = n;
    const r = sc.rows[n - 1];
    out.textContent = r ? tLong(r.t) : 'start';
    input.setAttribute('aria-valuetext', `${n} of ${N} events, ${out.textContent}`);
    play.textContent = timer ? '❚❚ Pause' : n >= N ? '↻ Replay' : '▶ Play';
    play.setAttribute('aria-pressed', String(!!timer));
    live.textContent = r ? [r.L && `Robot: ${r.L[0]}${r.L[1] ? `, turn ${r.L[1]}` : ''}.`, r.R && `Cloud: ${r.R[0]}${r.R[1] ? `, turn ${r.R[1]}` : ''}.`].filter(Boolean).join(' ') : '';
  }

  function stop() { clearTimeout(timer); timer = null; paint(); }
  function tick() {
    n += 1;
    timer = n < sc.rows.length ? setTimeout(tick, SPLIT_MS) : null;
    paint();
  }
  function start() {
    clearTimeout(timer);
    if (n >= sc.rows.length) n = 0;
    timer = setTimeout(tick, n === 0 ? 250 : SPLIT_MS);
    paint();
  }

  const play = btn('▶ Play', () => (timer ? stop() : start()), { 'aria-pressed': 'false' });
  const input = h('input', { type: 'range', min: 0, max: sc.rows.length, step: 1, value: n, 'aria-label': 'Events shown, in time order' });
  const out = h('output');
  input.addEventListener('input', () => { clearTimeout(timer); timer = null; n = +input.value; paint(); });
  // One button walks the 7 cases; each new case plays from its start.
  let at = 0;
  const name = h('p', { class: `${S}name` });
  const next = btn('', () => {
    clearTimeout(timer); timer = null;
    at = (at + 1) % CASES.length;
    sc = CASES[at];
    paintNext();
    build();
    n = REDUCED ? sc.rows.length : 0;
    if (REDUCED) paint(); else start();
  });
  function paintNext() {
    next.textContent = `Next case ▶ (${at + 1}/${CASES.length})`;
    next.setAttribute('aria-label', `Next case. Now showing ${at + 1} of ${CASES.length}: ${sc.label}.`);
    name.textContent = sc.label;
  }
  paintNext();

  app.append(
    h('div', { class: `${S}ctl` },
      next,
      play,
      h('div', { class: 'wv-range' }, h('label', null, 'Time'), input, out)),
    name,
    log,
    live,
    colorKey([['k-look', 'newest event'], ['k-data', 'turn id'], ['k-held', 'answer used, state saved'], ['k-gap', 'discarded, kept in the log']]),
  );
  build();
  paint();
  let seen = false;
  onVisible(fig, (v) => {
    if (v && !seen && !REDUCED) { seen = true; n = 0; start(); }
    if (!v && timer) stop();
  });
}

register({ 'robot-ladder': initLadder, 'robot-split': initSplit });

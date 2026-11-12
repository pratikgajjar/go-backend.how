/*
 * Fig. robot-timing for "Designing a robot that talks with kids": one clock
 * for speech, face and body. A playable, scrubbable timeline of one sample
 * line, with a blocking mark and an interruption.
 *
 * Values from the robot (as stated in the post): marks fire when the audio
 * clock passes them, mouth shapes per phone, gaze applied every frame, a
 * blocking mark makes the audio wait, an interruption stops speech, queued
 * lines, animations and sounds, the LED bar holds "responding" for 0.5 s,
 * joint angles go to the motors 30 times a second.
 * Sample values: the lines, word times and mark names (made up).
 *
 * Cost: nothing runs while the figure is idle. Playback is one loop
 * (loop.js), at most 30 paints a second, and it draws the 3D view itself
 * (stage.renderNow), so the stage runs no loop of its own. It stops when
 * playback ends, when the figure leaves the screen and when the tab is
 * hidden. Scrubbing draws on demand through the shared makeStage.
 */

import { h, s, btn, range, colorKey, register, REDUCED, clamp } from '../lib.js';
import { makeStage, lazy3D } from '../designing-a-talking-robot.js';
import { RIG } from './innards.js';
import { playLoop } from './loop.js';
import { lipSync, laughMouth } from './face.js';

const P = 'v-bot-sy-';
const smooth01 = (t) => t * t * (3 - 2 * t);
const CH = 6.1; // approx. width of one 10px mono character, in SVG units

const tx = (x, y, str, cls = 't-xs', anchor = 'start', extra = {}) => s('text', { x, y, class: cls, 'text-anchor': anchor, ...extra }, str);

/* ------------------------------------------------------- the 3D robot */

/* Pose the model from the seven motor angles (the shared rig). With `now`
   (a frame of the figure's own loop) the stage draws at once; without it,
   it draws on demand. */
function poseStage(stage, ang, now) {
  if (!stage) return;
  for (let m = 0; m < 7; m++) RIG[m](stage.rot, ang[m]);
  if (now === undefined) stage.render(); else stage.renderNow(now);
}

/* Mount the real model in `view` when it nears the screen. Without WebGPU,
   lazy3D shows its message and a still of the robot (data-still). The view
   is passed as its root, so the figure's whole fallback image is not
   repeated inside the view. */
function mountRobot(fig, view, ready, camYaw = 0.35) {
  if (fig.dataset.still) {
    view.append(h('img', {
      class: 'wv-fallback', src: new URL(fig.dataset.still, document.baseURI).href,
      alt: 'The robot model in the garden, turned toward the child.', loading: 'lazy', decoding: 'async',
    }));
  }
  lazy3D(view, view, async () => {
    const stage = await makeStage(fig, view, new URL(fig.dataset.model || 'robot.glb', document.baseURI).href, { env: 'garden', aspect: 0.75 });
    stage.stopAuto();
    stage.aim({ yaw: camYaw, pitch: 0.1, target: [0, 0.2, 0], dist: 1.05 }, true);
    ready(stage);
  });
}

/* Wide or tall layout, from the figure's own width (the text column on
   desktop, the screen on a phone). Calls onChange when the mode flips. */
function widthMode(app, onChange) {
  const isWide = () => (app.clientWidth || window.innerWidth) >= 600;
  let wide = isWide();
  new ResizeObserver(() => { const w = isWide(); if (w !== wide) { wide = w; onChange(); } }).observe(app);
  return { get matches() { return wide; } };
}

/* The phones of a word, spread over its time: each has a mouth shape (m, a
   cell of the face atlas) and a rough openness for the timeline (vowels
   open, consonants mostly closed). */
const phones = (word, t0, t1) => lipSync(word, t0, t1).slice(0, -1);

/* =================================================== Fig. robot-timing */

const SC = 140; // px per second on the timeline
const L1 = [['Tigers', 0, 0.36], ['are', 0.36, 0.54], ['so', 0.54, 0.7], ['big,', 0.7, 0.98], ['wow!', 1.06, 1.4], ['What', 1.52, 1.74], ['did', 1.74, 1.92], ['you', 1.92, 2.12], ['see?', 2.12, 2.44]];
const L2 = [['Was', 0, 0.19], ['it', 0.19, 0.31], ['asleep?', 0.31, 0.81]];
const L1_END = 2.44, L2_END = 0.81, GAP = 0.4, HOLD = 0.5;
const L1_GEST = [[0, 'talk'], [1.06, 'up'], [1.52, 'ask'], [1.92, 'you']];

const POSES = {
  rest: () => [[0, 0], [0, 0]],
  talk: (t) => { const w = Math.sin(t * 2 * Math.PI * 1.3) * 9; return [[18 + w, 12], [18 - w, 12]]; },
  up: () => [[125, 25], [125, 25]],
  ask: () => [[55, 40], [55, 40]],
  you: () => [[82, -15], [10, 5]],
  laugh: (t) => { const w = Math.sin(t * 2 * Math.PI * 3) * 16; return [[38 + w, 22], [38 + w, 22]]; },
  idle: (t) => { const w = Math.sin(t * 2 * Math.PI * 0.4) * 3; return [[5 + w, 2], [5 + w, 2]]; },
};
const POSE_OF = { talk: 'talk', up: 'up', ask: 'ask', you: 'you', rest: 'rest', 'idle: listening': 'idle', 'laugh (blocking)': 'laugh' };

function buildScenario(kind) {
  const off = kind === 'block' ? 1.2 : 0;
  const cut = kind === 'stop' ? 1.62 : null;
  const l2 = off + L1_END + GAP;
  const sc = { kind, off, cut, words: [], marks: [], audio: [], eyes: [], arms: [], leds: [], phones: [], events: [] };
  const alive = (t) => cut === null || t < cut;
  const W = (list, base, line) => list.forEach(([w, a, b]) => sc.words.push({ w, t0: base + a, t1: base + b, line, cut: cut !== null && base + b > cut }));
  W(L1, off, 1);
  W(L2, l2, 2);
  for (const wd of sc.words) if (!wd.cut) sc.phones.push(...phones(wd.w, wd.t0, wd.t1).map((p) => ({ ...p, end: wd.t1 })));
  // phones of a word cut in the middle still play until the cut
  for (const wd of sc.words) if (wd.cut && wd.t0 < (cut ?? Infinity)) sc.phones.push(...phones(wd.w, wd.t0, wd.t1).filter((p) => p.t < cut).map((p) => ({ ...p, end: cut })));
  sc.phones.sort((a, b) => a.t - b.t);

  if (kind === 'block') {
    sc.marks.push({ t: 0, labels: ['laugh', '(blocking)'], block: true });
    sc.audio.push({ t0: 0, t1: off, label: 'audio waits for the laugh', cls: 'is-wait' });
    sc.eyes.push({ t0: 0, t1: off, label: 'laugh', mood: 'laugh' });
    sc.arms.push({ t0: 0, t1: off, label: 'laugh (blocking)' });
  }
  sc.marks.push({ t: off, labels: ['happy', 'talk'] });
  for (const [t, g] of L1_GEST.slice(1)) sc.marks.push({ t: off + t, labels: [g], cut: !alive(off + t) });
  sc.marks.push({ t: off + L1_END, labels: ['neutral', 'none'], cut: !alive(off + L1_END) });
  if (cut === null) sc.audio.push({ t0: off, t1: off + L1_END, label: '', line: 1 });
  else sc.audio.push({ t0: off, t1: cut, label: '', line: 1 }, { t0: cut, t1: off + L1_END, label: '', line: 1, cls: 'is-cut' });
  sc.audio.push({ t0: l2, t1: l2 + L2_END, label: cut !== null ? 'queued line: dropped' : '', line: 2, cls: cut !== null ? 'is-cut' : '' });

  const endAll = cut ?? l2 + L2_END;
  const T = endAll + HOLD + (cut !== null ? 1.0 : 0.6);
  sc.T = T;
  if (cut === null) {
    sc.marks.push({ t: l2, labels: ['curious', 'talk'] });
    sc.marks.push({ t: l2 + L2_END, labels: ['neutral', 'none'] });
    sc.eyes.push({ t0: off, t1: off + L1_END, label: 'happy', mood: 'happy' },
      { t0: off + L1_END, t1: l2, label: 'neutral', mood: 'neutral' },
      { t0: l2, t1: l2 + L2_END, label: 'curious', mood: 'curious' },
      { t0: l2 + L2_END, t1: T, label: 'neutral', mood: 'neutral' });
    L1_GEST.forEach(([t, g], k) => sc.arms.push({ t0: off + t, t1: off + (L1_GEST[k + 1]?.[0] ?? L1_END), label: g }));
    sc.arms.push({ t0: off + L1_END, t1: l2, label: 'rest' }, { t0: l2, t1: l2 + L2_END, label: 'talk' }, { t0: l2 + L2_END, t1: T, label: 'idle: listening' });
    sc.leds.push({ t0: off, t1: l2 + L2_END, label: 'responding' }, { t0: l2 + L2_END, t1: endAll + HOLD, label: 'holds 0.5 s', hold: true }, { t0: endAll + HOLD, t1: T, label: 'listening' });
  } else {
    sc.eyes.push({ t0: 0, t1: cut, label: 'happy', mood: 'happy' }, { t0: cut, t1: T, label: 'idle: listening', mood: 'neutral' });
    L1_GEST.forEach(([t, g], k) => { if (t < cut) sc.arms.push({ t0: t, t1: Math.min(cut, L1_GEST[k + 1]?.[0] ?? L1_END), label: g }); });
    sc.arms.push({ t0: cut, t1: T, label: 'idle: listening' });
    sc.leds.push({ t0: 0, t1: cut, label: 'responding' }, { t0: cut, t1: cut + HOLD, label: 'holds 0.5 s', hold: true }, { t0: cut + HOLD, t1: T, label: 'listening' });
  }

  // one-line notes, in time order
  const ev = sc.events;
  if (kind === 'block') {
    ev.push([0, 'Blocking mark "laugh" fires. The laugh plays, and the audio waits until the laugh ends.']);
    ev.push([off, 'The laugh ends. The audio starts, and "happy" and "talk" fire: happy eyes, a talking gesture.']);
  } else {
    ev.push([0, 'The audio starts. Marks "happy" and "talk" fire: happy eyes and mouth, a talking gesture.']);
  }
  ev.push([off + 1.06, 'Mark "up" fires on "wow": the arms go up. The eyes stay on the child.']);
  ev.push([off + 1.52, 'Mark "ask" fires on "What": a question gesture.']);
  if (cut !== null) {
    ev.push([cut, 'The child talks. The speech, the queued line, and every animation and sound they started stop at once.']);
    ev.push([cut + 0.02, 'The robot looks at the child. The listening idle takes over. The LED bar holds "responding" for 0.5 s.']);
    ev.push([cut + HOLD, 'The LED bar shows "listening". The marks after the stop never fire.']);
  } else {
    ev.push([off + 1.92, 'Mark "you" fires: a gesture toward the child.']);
    ev.push([off + L1_END, 'The line ends with "neutral" and "none": the face and arms reset.']);
    ev.push([l2, 'The queued line starts. The gap was under 0.5 s, so the LED bar stays on "responding".']);
    ev.push([l2 + L2_END, 'The last line ends. The listening idle takes over. The LED bar holds "responding" for 0.5 s.']);
    ev.push([l2 + L2_END + HOLD, 'The LED bar shows "listening".']);
  }
  return sc;
}

const ROWS = [
  ['marks', 32], ['audio', 22], ['mouth', 16], ['eyes', 20], ['arms', 20], ['gaze', 20], ['LEDs', 20],
];

function initTiming(fig, app) {
  const mq = widthMode(app, () => { drawTimeline(); paint(); });
  let sc = buildScenario('line');
  let t = 0;
  let els = null;
  let lastEv = -1;
  const pose = new Float32Array(7);
  const face = { mood: 'neutral', level: 1, lids: 0, mouth: null };
  pose[5] = 35; // sample: the child sits to the robot's left, so the body turns that way

  const note = h('p', { class: `${P}note`, 'aria-live': 'polite' });
  const tlHost = h('div', { class: `${P}tl` });
  const playBtn = btn('▶ Play', () => toggle(), { 'aria-pressed': 'false' });
  const scrub = range('time', { min: 0, max: sc.T, step: 0.01, value: 0, fmt: (v) => `${v.toFixed(2)} s`, oninput: (v) => { pause(); seek(v, true); } });
  // One button walks the 3 cases; a new case plays from its start.
  const CASES = [['line', 'Normal line'], ['block', 'Blocking laugh'], ['stop', 'Child interrupts']];
  let at = 0;
  const nextBtn = btn('', () => {
    pause();
    at = (at + 1) % CASES.length;
    sc = buildScenario(CASES[at][0]);
    scrub.input.max = sc.T;
    paintNext();
    drawTimeline();
    seek(0);
    if (!REDUCED) toggle();
  });
  function paintNext() {
    nextBtn.textContent = `Next case ▶ (${CASES[at][1]}, ${at + 1}/${CASES.length})`;
    nextBtn.setAttribute('aria-label', `Next case. Now showing ${at + 1} of ${CASES.length}: ${CASES[at][1]}.`);
  }
  paintNext();

  /* the real robot, turned toward the child, and a readout of the other tracks */
  const tag = h('span', { class: `${P}vtag` }, 'child ▸');
  const view = h('div', { class: `v-bot-view ${P}view` }, tag);
  let stage = null;
  const kv = {};
  const readout = h('dl', { class: `wv-kv ${P}kv` });
  for (const k of ['eyes', 'mouth', 'arms', 'gaze', 'LEDs']) { kv[k] = h('dd'); readout.append(h('dt', null, k), kv[k]); }
  const top = h('div', { class: `${P}top` }, view, h('div', null, note, readout));

  function layout() {
    const wide = mq.matches;
    const vbW = wide ? 760 : 360;
    const X0 = wide ? 62 : 50;
    return { wide, vbW, X0, W: vbW - X0 - 8 };
  }

  /* Marks and the interruption, each in a lane so that no label touches
     another label or a later flag's pole. A pole starts at its own lane and
     runs down, so a mark goes one lane below every earlier label that
     reaches its x. */
  function markLanes() {
    const items = sc.marks.map((m) => ({ ...m }));
    if (sc.cut !== null) items.push({ t: sc.cut, labels: ['child talks'], stop: true });
    items.sort((a, b) => a.t - b.t);
    let n = 1;
    items.forEach((m, i) => {
      const x = m.t * SC;
      m.end = x + 9 + Math.max(...m.labels.map((l) => l.length)) * CH;
      m.lane = 0;
      for (let j = 0; j < i; j++) if (items[j].end > x - 8) m.lane = Math.max(m.lane, items[j].lane + 1);
      n = Math.max(n, m.lane + 1);
    });
    return { items, n };
  }

  function drawTimeline() {
    const L = layout();
    const lanes = markLanes();
    let y = 16;
    const rowY = {};
    for (const [name, hh] of ROWS) {
      const rh = name === 'marks' ? 8 + 24 * lanes.n : hh;
      rowY[name] = [y, rh];
      y += rh + 4;
    }
    const H = y + 18;
    const svg = s('svg', { viewBox: `0 0 ${L.vbW} ${H}`, class: `${P}svg ${P}tlsvg`, role: 'img', 'aria-label': 'Timeline of one line. Rows: marks, audio, mouth, eyes, arms, gaze and LEDs. A playhead moves along the audio clock.' });
    const cid = `bot-sy-c${Math.random().toString(36).slice(2, 7)}`;
    svg.append(s('defs', null,
      s('clipPath', { id: cid }, s('rect', { x: L.X0, y: 0, width: L.W, height: H })),
      s('pattern', { id: `${cid}h`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('line', { class: `${P}hatch`, x1: 0, y1: 0, x2: 0, y2: 6 }))));
    for (const [name] of ROWS) {
      const [ry, rh] = rowY[name];
      svg.append(tx(4, ry + rh / 2 + 4, name, 't-xs t-b'), s('line', { class: 'rule', x1: L.X0, x2: L.X0 + L.W, y1: ry + rh + 2, y2: ry + rh + 2 }));
    }
    const clip = s('g', { 'clip-path': `url(#${cid})` });
    const inner = s('g');
    clip.append(inner);
    svg.append(clip);
    const X = (tt) => L.X0 + tt * SC;
    const segs = [];
    const seg = (row, a) => {
      const [ry, rh] = rowY[row];
      const g = s('g', { class: `${P}seg ${a.cls || ''} ${a.hold ? 'is-hold' : ''}` });
      const w = Math.max(1, (a.t1 - a.t0) * SC);
      const r = s('rect', { x: X(a.t0), y: ry, width: w, height: rh });
      if (a.cls === 'is-wait') r.setAttribute('style', `fill:url(#${cid}h)`);
      g.append(r);
      if (a.label && a.label.length * CH + 6 < w) g.append(tx(X(a.t0) + 4, ry + rh / 2 + 3.5, a.label, 't-xs halo'));
      inner.append(g);
      segs.push({ g, t0: a.t0, t1: a.t1 });
    };
    // audio: line boxes, then words on top
    sc.audio.forEach((a) => seg('audio', a));
    const words = sc.words.map((wd) => {
      const [ry, rh] = rowY.audio;
      const el = tx(X(wd.t0) + 2, ry + rh / 2 + 3.5, wd.w, `t-xs ${P}w ${wd.cut ? 'is-cut' : ''}`);
      inner.append(el);
      return { el, ...wd };
    });
    // mouth: one tick per phone
    {
      const [ry, rh] = rowY.mouth;
      let d = '';
      for (const p of sc.phones) d += `M${X(p.t).toFixed(1)},${ry + rh} v${-(rh - 2) * p.open}`;
      inner.append(s('path', { class: `${P}ticks`, d }));
    }
    sc.eyes.forEach((a) => seg('eyes', a));
    sc.arms.forEach((a) => seg('arms', a));
    seg('gaze', { t0: 0, t1: sc.T, label: 'look-at on the child, every frame' });
    sc.leds.forEach((a) => seg('LEDs', a));
    // marks: flags, and the interruption as a red line, each in its lane
    const flags = [];
    for (const m of lanes.items) {
      const [ry, rh] = rowY.marks;
      const top = ry + 24 * m.lane;
      const x = X(m.t);
      if (m.stop) {
        inner.append(s('line', { class: `${P}cut`, x1: x, x2: x, y1: top, y2: H - 18 }), tx(x + 4, top + 8, m.labels[0], 't-xs t-bad t-b'));
        continue;
      }
      const g = s('g', { class: `${P}flag ${m.cut ? 'is-cut' : ''} ${m.block ? 'is-block' : ''}` });
      g.append(s('line', { x1: x, y1: top, x2: x, y2: ry + rh + 2 }), s('path', { d: `M${x},${top} h7 l-2.5,3.5 l2.5,3.5 h-7 z` }));
      m.labels.forEach((lab, k) => g.append(tx(x + 9, top + 8 + k * 11, lab, 't-xs')));
      inner.append(g);
      flags.push({ g, t: m.t, cut: m.cut });
    }
    // axis
    for (let k = 0; k <= Math.floor(sc.T * 2); k++) {
      const x = X(k / 2);
      inner.append(s('line', { class: 'rule', x1: x, x2: x, y1: H - 16, y2: H - 12 }));
      if (k % 2 === 0) inner.append(tx(x + 2, H - 4, `${k / 2} s`, 't-xs t-mute'));
    }
    // playhead
    const ph = s('g', { class: `${P}phg` });
    ph.append(s('line', { x1: 0, x2: 0, y1: 2, y2: H - 18 }), s('path', { d: 'M-5,0 h10 l-5,6 z' }));
    inner.append(ph);
    // seek by pointer
    const hit = s('rect', { class: `${P}hit`, x: L.X0, y: 0, width: L.W, height: H });
    svg.append(hit);
    let drag = false, pend = null, praf = 0;
    const toT = (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * L.vbW;
      return clamp((vx - L.X0 + els.offset) / SC, 0, sc.T);
    };
    // one paint per display frame while dragging, however fast the pointer
    const seekSoon = (v) => { pend = v; if (!praf) praf = requestAnimationFrame(() => { praf = 0; seek(pend, true); }); };
    hit.addEventListener('pointerdown', (e) => { drag = true; hit.setPointerCapture(e.pointerId); pause(); seek(toT(e), true); });
    hit.addEventListener('pointermove', (e) => { if (drag) seekSoon(toT(e)); });
    hit.addEventListener('pointerup', () => { drag = false; });
    hit.addEventListener('pointercancel', () => { drag = false; });

    tlHost.replaceChildren(svg);
    top.classList.toggle('is-wide', L.wide);
    els = { L, inner, ph, segs, words, flags, offset: 0 };
  }

  /* Arm angles into pose[0..3]: the current gesture, blended from the last
     one over 0.22 s. */
  function poseAt(tt) {
    const idx = sc.arms.findIndex((a) => tt >= a.t0 && tt < a.t1);
    const cur = sc.arms[idx] ?? sc.arms[sc.arms.length - 1];
    const prev = idx > 0 ? sc.arms[idx - 1] : null;
    const now = POSES[POSE_OF[cur.label] || 'rest'](tt);
    const was = prev ? POSES[POSE_OF[prev.label] || 'rest'](tt) : now;
    const k = prev ? smooth01(clamp((tt - cur.t0) / 0.22, 0, 1)) : 1;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) pose[i * 2 + j] = was[i][j] + (now[i][j] - was[i][j]) * k;
  }

  /* Write a readout only when its text changes. */
  const shown = {};
  const put = (key, el, v) => { if (shown[key] !== v) { shown[key] = v; el.textContent = v; } };

  // now: a frame time from the playback loop (it then draws the 3D view too)
  function paint(now) {
    if (!els) return;
    const L = els.L;
    const span = sc.T * SC;
    els.offset = span <= L.W ? 0 : clamp(t * SC - L.W * 0.35, 0, span - L.W);
    els.inner.setAttribute('transform', `translate(${-els.offset} 0)`);
    els.ph.setAttribute('transform', `translate(${L.X0 + t * SC} 0)`);
    for (const sg of els.segs) {
      const st = t >= sg.t1 ? 1 : t >= sg.t0 ? 2 : 0;
      if (sg.st !== st) { sg.st = st; sg.g.classList.toggle('is-now', st === 2); sg.g.classList.toggle('is-past', st === 1); }
    }
    for (const w of els.words) {
      const st = (!w.cut && t >= w.t1 ? 1 : 0) | (t >= w.t0 && t < w.t1 && (sc.cut === null || t < sc.cut) ? 2 : 0);
      if (w.st !== st) { w.st = st; w.el.classList.toggle('is-said', (st & 1) > 0); w.el.classList.toggle('is-now', (st & 2) > 0); }
    }
    for (const f of els.flags) {
      const fired = !f.cut && t >= f.t;
      const st = fired ? (t - f.t < 0.3 ? 2 : 1) : 0;
      if (f.st !== st) { f.st = st; f.g.classList.toggle('is-fired', fired); f.g.classList.toggle('is-now', st === 2); }
    }
    // the robot
    const stopped = sc.cut !== null && t >= sc.cut;
    const eye = sc.eyes.find((a) => t >= a.t0 && t < a.t1);
    const led = sc.leds.find((a) => t >= a.t0 && t < a.t1);
    let phone = null;
    if (!stopped) for (const p of sc.phones) { if (p.t > t) break; if (t < p.end) phone = p; }
    const talking = phone !== null;
    // the face: the mood of the eyes track, one mouth shape per phone, the
    // laugh while the audio waits, and a neutral, listening face once the
    // child interrupts
    const mood = stopped ? 'neutral' : eye?.mood ?? 'neutral';
    face.mood = mood === 'neutral' ? 'rest' : mood; // the calm resting face
    face.mouth = face.mood === 'laugh' ? laughMouth(t - eye.t0) : talking ? phone.m : null;
    // before the line starts (time 0, not playing) the robot shows its resting face
    if (stage) stage.face = t <= 0 ? null : face;
    poseAt(t);
    poseStage(stage, pose, now);
    const arm = sc.arms.find((a) => t >= a.t0 && t < a.t1);
    put('eyes', kv.eyes, eye ? eye.label : '—');
    put('mouth', kv.mouth, face.mood === 'laugh' ? 'laughing' : talking ? 'moving, one shape per phone' : 'closed');
    put('arms', kv.arms, arm ? arm.label : '—');
    put('gaze', kv.gaze, 'on the child');
    put('LEDs', kv.LEDs, led ? (led.hold ? 'responding (hold)' : led.label) : '—');
    put('tag', tag, stopped ? 'child talks ▸' : 'child ▸');
    tag.classList.toggle('is-gap', stopped);
    // note
    let k = -1;
    sc.events.forEach(([et], i) => { if (t >= et) k = i; });
    if (k !== lastEv) { lastEv = k; note.textContent = k < 0 ? '' : `${sc.events[k][0].toFixed(2)} s · ${sc.events[k][1]}`; }
  }

  function seek(v, fromScrub = false) {
    t = clamp(v, 0, sc.T);
    if (!fromScrub || +scrub.input.value !== t) scrub.input.value = t;
    scrub.el.querySelector('output').textContent = `${t.toFixed(2)} s`;
    lastEv = -2;
    paint();
  }
  const scrubOut = scrub.el.querySelector('output');
  const play = playLoop(fig, (dt, now) => {
    t = Math.min(sc.T, t + dt);
    scrub.input.value = t;
    scrubOut.textContent = `${t.toFixed(2)} s`;
    paint(now);
    if (t >= sc.T) { pause(); return false; }
    return true;
  });
  function pause() {
    play.stop();
    playBtn.textContent = t >= sc.T ? '↻ Replay' : '▶ Play';
    playBtn.setAttribute('aria-pressed', 'false');
  }
  function toggle() {
    if (play.on) { pause(); return; }
    if (t >= sc.T) seek(0);
    playBtn.textContent = '❚❚ Pause';
    playBtn.setAttribute('aria-pressed', 'true');
    play.start();
  }

  app.append(
    h('div', { class: `${P}ctl` }, nextBtn, playBtn, scrub.el),
    top,
    tlHost,
    colorKey([['k-look', 'now: the playhead and what it fires'], ['k-run', 'audio waits (blocking mark)'], ['k-gap', 'stopped by the interruption']]),
  );
  drawTimeline();
  seek(REDUCED ? 1.1 : 0);
  mountRobot(fig, view, (st) => { stage = st; paint(); }, 0);
}

register({ 'robot-timing': initTiming });

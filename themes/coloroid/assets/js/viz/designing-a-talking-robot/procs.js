/*
 * robot-procs — the processes inside the one app, drawn inside the robot.
 *
 * The real robot model in X-ray, through the shared WebGPU stage. Each
 * process is a glowing node at the part it owns: speech at the mic array,
 * vision at the camera, body at the motor board, the cloud link at the main
 * board's Wi-Fi corner, and the rest on the main board's chips. All of them
 * run on the main board; the node shows the hardware each one drives. The
 * bus is the main board itself: every message is a light pulse from its
 * sender to the board's relay point and out to each listener, at the real
 * rates slowed down 5×. A small box in the top-right corner shows the bus
 * traffic, or the rates of the picked process. Power states stop processes
 * in reverse start order and start them in start order; the face and the LED bar go dark
 * when the display is off, and the whole robot dims in suspend.
 *
 * Rates from the robot: voice direction every 10 ms; camera pose every game
 * frame (30/s); the world model republishes people on each camera update;
 * faces once per finished frame, at most 30/s; audio chunks every 120 ms
 * while a child talks; metrics every 5 s. The conversation in the loop (when
 * the child talks, when transcripts and answers arrive) uses sample times.
 *
 * Cost: the 3D stage draws only when the camera, the selection or the power
 * state changes. Pulses and glows go on a 2D canvas over it, at most 30
 * frames a second, only while the figure is on screen and playing.
 */

import { h, s, btn, register, REDUCED } from '../lib.js';
import { playLoop } from './loop.js';
import { makeStage, lazy3D } from '../designing-a-talking-robot.js';
import { buildInnards, MAT } from './innards.js';

const P = 'v-bot-pc-';
const SLOW = 5; // drawing runs 5× slower than the robot
const TRAVEL = 60; // robot ms a pulse takes along one route (not to scale)
const LOOP = 5000; // the sample conversation repeats every 5 s of robot time
const TAU = 150; // ms, how fast a node's glow fades

/* ------------------------------------------------------------------ facts */

const PROCS = {
  speech: { n: 'speech', job: 'Audio from the mic array, voice activity, wake phrases, speech-to-text streaming.' },
  vision: { n: 'vision', job: 'Camera, face detection, tracking and recognition, QR codes.' },
  world: { n: 'world model', job: 'Who is where, who is talking, and who is engaged.' },
  dialogue: { n: 'dialogue', job: 'A local rule-based dialogue engine plus cloud conversation.' },
  body: { n: 'body', job: 'A game engine: face, animation, motors, LEDs and text-to-speech.' },
  cloud: { n: 'cloud link', job: 'The only connection to the cloud: MQTT, uploads and updates. It listens to the topics the cloud asks for, and puts events from the cloud on the bus.' },
  system: { n: 'system', job: 'Battery, CPU, memory and disk metrics.' },
  launcher: { n: 'launcher', job: 'Decides which services run in each power state. It checks them once a second and restarts any that died.' },
};
const ORDER = ['speech', 'vision', 'world', 'dialogue', 'body', 'cloud', 'system', 'launcher'];
const BUS = { n: 'bus', job: 'A small relay on the robot. Every process connects to it. It passes each message to the processes that listen to its topic, and stores nothing.' };

/*
 * Messages. every: period in ms; at: sample times within the 5 s loop (only
 * while running, during the sample conversation); none: on events only.
 */
const MSGS = [
  { from: 'speech', to: ['world'], what: 'voice direction', rate: '100/s', every: 10, phase: 3 },
  { from: 'speech', to: ['world'], what: 'voice activity, transcripts', rate: 'when someone talks', at: [600, 2400, 2780] },
  { from: 'speech', to: ['cloud'], what: 'audio chunks for speech-to-text', rate: 'every 120 ms while a child talks', at: range(720, 2400, 120) },
  { from: 'cloud', to: ['speech'], what: 'speech-to-text results', rate: 'partial and final', at: [1100, 1600, 2100, 2750] },
  { from: 'vision', to: ['world'], what: 'faces: box, head pose, who it is', rate: 'one per finished frame, up to 30/s', every: 1000 / 30, phase: 11 },
  { from: 'vision', to: ['dialogue', 'system'], what: 'QR codes', rate: 'when one is seen' },
  { from: 'body', to: ['vision', 'world', 'speech'], what: 'where the camera points, body angle', rate: '30/s, every game frame', every: 1000 / 30, phase: 0 },
  { from: 'body', to: ['speech'], what: 'motor noise ahead', rate: 'before a move', at: [3900] },
  { from: 'body', to: ['dialogue'], what: 'touch, pick-up and tilt', rate: 'when they happen' },
  { from: 'body', to: ['system'], what: 'battery level', rate: 'on change' },
  { from: 'world', to: ['dialogue', 'body', 'speech'], what: 'people: where they are, who talks, engagement', rate: '30/s, on each camera update', every: 1000 / 30, phase: 4 },
  { from: 'world', to: ['dialogue'], what: 'who said what', rate: 'after each sentence', at: [2800] },
  { from: 'dialogue', to: ['body'], what: 'lines to speak, with marks', rate: 'per line', at: [3730] },
  { from: 'dialogue', to: ['cloud'], what: 'chat requests, what the robot said', rate: 'per turn', at: [2830, 3760] },
  { from: 'dialogue', to: ['vision'], what: 'which detector to run', rate: 'when the talk needs one' },
  { from: 'cloud', to: ['dialogue'], what: 'chat answers, settings', rate: 'per turn', at: [3700] },
  { from: 'system', to: ['cloud'], what: 'metrics', rate: 'every 5 s', every: 5000, phase: 4500 },
  { from: 'launcher', to: ['system', 'cloud'], what: 'power state', rate: 'on change' },
];
const POWER_MSG = MSGS.findIndex((m) => m.what === 'power state');
function range(a, b, d) { const r = []; for (let t = a; t <= b; t += d) r.push(t); return r; }

/* How often each process sends, for the corner box. */
const RATE = { speech: '100+/s', vision: 'up to 30/s', world: '30/s', dialogue: 'on events', body: '30/s', cloud: 'on events', system: '1 per 5 s', launcher: 'on change' };
/* How many topics each process listens to. */
const TOPICS = Object.fromEntries(ORDER.map((k) => [k, MSGS.filter((m) => m.to.includes(k)).length]));

/* Start order. Stops run in reverse. The launcher and the bus always run. */
const START = ['cloud', 'system', 'dialogue', 'speech', 'vision', 'world', 'body'];
const STATES = {
  startup: { label: 'Startup', on: ['cloud', 'system', 'vision', 'body'], display: true, note: 'The face comes up first. Speech, the world model and dialogue start when the robot is ready to talk.' },
  running: { label: 'Running', on: START, display: true, note: 'Everything runs. One short conversation repeats every 5 s.' },
  light: { label: 'Light sleep', on: ['cloud', 'system', 'dialogue', 'body'], display: false, note: 'The robot sleeps with its display off. Nothing listens or looks.' },
  suspend: { label: 'Suspend', on: ['system', 'dialogue', 'body'], display: false, frozen: true, note: 'The chip suspends, so nothing runs. The motor board can wake it on a touch, a pick-up or the charger.' },
  silent: { label: 'Silent reboot', on: ['cloud', 'system', 'dialogue'], display: false, note: 'No game engine, so no face and no LEDs. The state ends with a reboot.' },
};
const STATE_KEYS = Object.keys(STATES);


/*
 * Where each node sits, in model space (metres, rest pose: x to the robot's
 * left, y up, z forward). hw: the part it owns, as its label says it.
 * side: which column its label goes in. parts: the parts that light up when
 * it is picked. The four processes without hardware of their own sit on the
 * main board's chips; the bus relay point sits on the board too.
 */
const MOTORS = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
const NODE = {
  speech: { at: [0, 0.3645, -0.004], hw: 'mic array', side: 1, parts: ['mic'] },
  vision: { at: [0, 0.349, 0.0225], hw: 'camera', side: 0, parts: ['camera'] },
  world: { at: [0.005, 0.142, -0.0425], hw: 'main board', side: 1, parts: ['main'] },
  dialogue: { at: [-0.016, 0.134, -0.0425], hw: 'main board', side: 0, parts: ['main'] },
  body: { at: [-0.012, 0.0495, 0.008], hw: 'motors, face, LEDs', side: 0, parts: ['mcu', 'projector', 'mirror', 'led', ...MOTORS] },
  cloud: { at: [0.029, 0.136, -0.0425], hw: 'Wi-Fi', side: 1, parts: ['main'] },
  system: { at: [0.005, 0.124, -0.0425], hw: 'main board', side: 1, parts: ['main'] },
  launcher: { at: [-0.036, 0.112, -0.042], hw: 'starts and stops', side: 0, parts: ['main'] },
  bus: { at: [-0.012, 0.113, -0.0428], hw: 'the main board', side: 1, parts: ['main'] },
};
/* The main board's outline (it glows when the bus is busy) and the five LEDs. */
const BOARD = [[-0.045, 0.155], [0.045, 0.155], [0.045, 0.105], [-0.045, 0.105]].map(([x, y]) => [x, y, -0.0442]);
const LEDS = [-2, -1, 0, 1, 2].map((i) => [i * 0.007, 0.1702, 0.0574]);
/* A tap on a part of the robot picks the process that owns it. */
const PART_PROC = { mic: 'speech', camera: 'vision', mcu: 'body', projector: 'body', mirror: 'body', led: 'body', main: 'bus' };
for (const m of MOTORS) PART_PROC[m] = 'body';

/* The studio light of the shared stage, as our own copy: the figure turns
   the face (face) down when the display is off and dims the robot
   (exposure) in suspend. */
const LOOK = {
  exposure: 1, face: 1, keySize: 0.15,
  lights: [
    [[-0.5, 0.62, 0.6], 9, [1, 0.97, 0.93], 3.2],
    [[0.85, 0.15, 0.5], 4, [0.92, 0.96, 1], 0.6],
    [[-0.75, 0.3, -0.6], 10, [1, 1, 1], 2],
    [[0.7, 0.45, -0.55], 10, [1, 1, 1], 1.8],
    ['up', 2.2, [0.9, 0.95, 1], 0.7],
    ['down', 1.6, [1, 0.94, 0.86], 0.18],
  ],
};
const DIM = 0.32; // exposure in suspend
/* Camera: a three-quarter view from the robot's left, a little above. */
const CAM = { wide: { yaw: 0.55, pitch: 0.2, target: [0, 0.19, -0.01], dist: 0.8 }, tall: { yaw: 0.5, pitch: 0.2, target: [0, 0.19, -0.01], dist: 0.84 } };

/* Routes: one per publisher → subscriber pair. The event-log copies to the
   cloud link show only when the cloud link or the bus is picked. */
const ROUTES = [];
const ROUTE_ID = {};
function addRoute(a, b, log) {
  const key = `${a}>${b}`;
  if (key in ROUTE_ID) return ROUTE_ID[key];
  ROUTE_ID[key] = ROUTES.length;
  ROUTES.push({ a, b, log });
  return ROUTES.length - 1;
}
for (const m of MSGS) m.routes = m.to.map((b) => addRoute(m.from, b, false));
for (const k of ORDER) if (k !== 'cloud') addRoute(k, 'cloud', true);

/* ----------------------------------------------------------------- figure */

function widthWatch(el, min, cb) {
  let wide = (el.clientWidth || el.parentElement?.clientWidth || 0) >= min;
  if ('ResizeObserver' in window) {
    new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      if (w && (w >= min) !== wide) { wide = w >= min; cb(); }
    }).observe(el);
  }
  return () => wide;
}

function initProcs(fig, app) {
  const isWide = widthWatch(app, 560, () => { view.classList.toggle('is-narrow', !isWide()); render(); if (stage) stage.aim(CAM[isWide() ? 'wide' : 'tall']); });
  const view = h('div', { class: `v-bot-view ${P}view` });
  const over = h('canvas', { class: `${P}over`, 'aria-hidden': 'true' });
  const leads = s('svg', { class: `${P}leads`, 'aria-hidden': 'true' });
  const labels = h('div', { class: `${P}labels`, role: 'group', 'aria-label': 'Processes. Pick one to see what it sends and listens to.' });
  const meterName = h('b'), meterLine1 = h('span'), meterLine2 = h('span', { class: `${P}msub` });
  const meter = h('p', { class: `${P}meter` }, h('span', null, meterName, meterLine1), meterLine2);
  const status = h('p', { class: `${P}status`, 'aria-live': 'polite' });
  const panel = h('div', { class: `${P}panel`, 'aria-live': 'polite' });
  view.classList.toggle('is-narrow', !isWide());
  const octx = over.getContext('2d');

  let stage = null;
  let sel = null, hover = null;
  let state = 'running';
  let live = new Set(STATES.running.on);
  let frozen = false;
  let timer = 0;
  let playing = !REDUCED;
  let T = 0; // robot time, ms
  let colors = {};
  let glow = null, ledGlow = null;
  let ow = 0, oh = 0, dpr = 1;
  const pp = {}; // projected nodes (CSS px in the view)
  let ppBoard = [], ppLeds = [];

  // message history: a ring buffer of (time, message index)
  const CAP = 4096;
  const evT = new Float64Array(CAP).fill(-1e9);
  const evM = new Uint8Array(CAP);
  let evN = 0;
  let lastEmit = -1e9;
  const act = Object.fromEntries([...ORDER, 'bus'].map((k) => [k, 0]));

  const isLive = (k) => k === 'launcher' || k === 'bus' || live.has(k);
  const displayOn = () => STATES[state].display && live.has('body');

  /* ------------------------------------------------- labels and node taps */
  const KEYS = [...ORDER, 'bus'];
  const labEls = {}, leadEls = {}, tapEls = {};
  for (const k of KEYS) {
    const name = k === 'bus' ? BUS.n : PROCS[k].n;
    const b = h('button', { type: 'button', class: `${P}lab3`, 'aria-pressed': 'false', 'aria-label': `${name}: show what it sends and listens to` },
      h('b', null, name), h('span', null, NODE[k].hw));
    const tap = h('button', { type: 'button', class: `${P}tap`, tabindex: '-1', 'aria-hidden': 'true' });
    for (const el of [b, tap]) {
      el.addEventListener('click', () => pick(sel === k ? null : k));
      el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hover = k; refocus(); } });
      el.addEventListener('pointerleave', () => { if (hover) { hover = null; refocus(); } });
    }
    b.addEventListener('keydown', (e) => { if (e.key === 'Escape') pick(null); });
    labEls[k] = b;
    tapEls[k] = tap;
    leadEls[k] = s('polyline', { class: `${P}lead` });
    leads.append(leadEls[k]);
  }
  labels.append(...KEYS.map((k) => tapEls[k]), ...KEYS.map((k) => labEls[k]));

  /* ------------------------------------------------------------ colours */
  function sprite(color, alpha) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.globalAlpha = alpha;
    g.fillRect(0, 0, 64, 64);
    return c;
  }
  function readColors() {
    const cs = getComputedStyle(fig);
    const tok = (n) => cs.getPropertyValue(n).trim() || '#000';
    colors = { ink: tok('--ink'), mute: tok('--mute'), brown: tok('--brown'), purple: tok('--purple'), board: tok('--board'), line: tok('--line') };
    glow = sprite(colors.brown, 0.75);
    ledGlow = sprite('#b9b4ff', 0.9);
  }

  /* ------------------------------------------------------- focus classes */
  const focusId = () => hover || sel;
  function refocus() {
    const f = focusId();
    for (const k of KEYS) {
      const peer = f && f !== k && (f === 'bus' || k === 'bus' || ROUTES.some((r) => !r.log && ((r.a === f && r.b === k) || (r.b === f && r.a === k))));
      labEls[k].classList.toggle('is-focus', k === f);
      labEls[k].classList.toggle('is-peer', !!peer && k !== 'bus');
      labEls[k].classList.toggle('is-off', !isLive(k));
      labEls[k].setAttribute('aria-pressed', String(k === sel));
      leadEls[k].classList.toggle('is-focus', k === f);
    }
    if (stage) {
      const want = new Set(f ? NODE[f].parts : []);
      const now = stage.selected;
      if (want.size !== now.size || [...want].some((p) => !now.has(p))) { stage.selected = want; stage.render(); }
    }
    paintMeter();
    render();
  }

  /* ------------------------------------------------------ the corner box */
  /** Messages a second on the bus, from the steady rates of the running senders. */
  function busRate() {
    if (frozen) return 0;
    let n = 0;
    for (const m of MSGS) if (m.every && isLive(m.from)) n += 1000 / m.every;
    return n;
  }
  let meterKey = '';
  function paintMeter() {
    const f = focusId();
    let name, l1, l2;
    if (f && f !== 'bus') {
      const n = TOPICS[f];
      name = PROCS[f].n;
      l1 = !isLive(f) ? ': stopped' : frozen ? ': paused' : `: sends ${RATE[f]}`;
      l2 = n ? `listens to ${n} topic${n > 1 ? 's' : ''}` : 'listens to nothing';
    } else {
      const r = busRate();
      name = 'bus';
      l1 = r >= 1 ? `: ${Math.round(r)} messages/s` : r ? ': 1 message per 5 s' : ': 0 messages/s';
      l2 = frozen ? 'suspended, nothing runs' : REDUCED ? 'at the real rates' : `pulses ${SLOW}× slower`;
    }
    const key = name + l1 + l2;
    if (key === meterKey) return;
    meterKey = key;
    meterName.textContent = name;
    meterLine1.textContent = l1;
    meterLine2.textContent = l2;
  }

  /* ---------------------------------------------------------- simulation */
  function emit(t, m) {
    evT[evN % CAP] = t;
    evM[evN % CAP] = m;
    evN++;
    lastEmit = t;
    const msg = MSGS[m];
    act[msg.from] += 0.5;
    act.bus += 0.08;
  }

  /** Emit every message published in (t0, t1], in time order, 20 ms at a time. */
  const scT = new Float64Array(64), scM = new Uint8Array(64);
  function advance(t0, t1) {
    for (let a = t0; a < t1; a += 20) step(a, Math.min(a + 20, t1));
    // a burst starts the glow at its level; it does not pile up
    for (const key in act) act[key] = Math.min(act[key], 6);
  }
  function step(t0, t1) {
    const k = Math.exp(-(t1 - t0) / TAU);
    for (const key in act) act[key] *= k;
    if (frozen) return;
    let n = 0;
    const talk = state === 'running' && live.size === START.length;
    const add = (t, i) => {
      if (n >= 64) return;
      let j = n++;
      while (j > 0 && scT[j - 1] > t) { scT[j] = scT[j - 1]; scM[j] = scM[j - 1]; j--; }
      scT[j] = t; scM[j] = i;
    };
    for (let i = 0; i < MSGS.length; i++) {
      const m = MSGS[i];
      if (!isLive(m.from)) continue;
      if (m.every) {
        for (let q = Math.ceil((t0 - m.phase) / m.every - 1e-9); m.phase + q * m.every <= t1; q++) {
          const t = m.phase + q * m.every;
          if (t > t0) add(t, i);
        }
      } else if (m.at && talk) {
        const base = Math.floor(t0 / LOOP) * LOOP;
        for (const b of [base, base + LOOP]) for (const a of m.at) { const t = b + a; if (t > t0 && t <= t1) add(t, i); }
      }
    }
    for (let j = 0; j < n; j++) emit(scT[j], scM[j]);
  }

  /* ---------------------------------------------------------- 3D overlay */

  /** After each 3D frame: project the nodes, place the labels, redraw. */
  function project() {
    for (const k of KEYS) pp[k] = stage.project('base', NODE[k].at);
    ppBoard = BOARD.map((p) => stage.project('base', p));
    ppLeds = LEDS.map((p) => stage.project('base', p));
    const W = stage.w, H = stage.h;
    if (W !== ow || H !== oh || dpr !== Math.min(window.devicePixelRatio || 1, 2)) {
      ow = W; oh = H; dpr = Math.min(window.devicePixelRatio || 1, 2);
      over.width = Math.round(W * dpr);
      over.height = Math.round(H * dpr);
      over.style.width = `${W}px`;
      over.style.height = `${H}px`;
      leads.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    placeLabels(W, H);
    drawOver();
  }

  /* Labels in two columns at the sides of the view, in the order of their
     nodes from top to bottom, with a leader line to each node. */
  function placeLabels(W, H) {
    const sides = [[], []];
    for (const k of KEYS) sides[NODE[k].side].push(k);
    const gap = 3;
    const roof = [4, meter.offsetTop + meter.offsetHeight + 6]; // the corner box sits top right
    sides.forEach((list, side) => {
      const floor = H - (side ? 46 : 4); // the zoom buttons sit bottom right
      list.sort((a, b) => pp[a].y - pp[b].y);
      const hs = list.map((k) => labEls[k].offsetHeight || 28);
      const y = list.map((k, i) => pp[k].y - hs[i] / 2);
      for (let i = 0; i < y.length; i++) y[i] = Math.max(y[i], i ? y[i - 1] + hs[i - 1] + gap : roof[side]);
      for (let i = y.length - 1; i >= 0; i--) y[i] = Math.min(y[i], i < y.length - 1 ? y[i + 1] - hs[i] - gap : floor - hs[i]);
      for (let i = 0; i < y.length; i++) y[i] = Math.max(y[i], i ? y[i - 1] + hs[i - 1] + gap : roof[side]);
      list.forEach((k, i) => {
        const el = labEls[k], w = el.offsetWidth || 80;
        const x = side ? W - 6 - w : 6;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y[i])}px)`;
        const ex = side ? x : x + w, ey = y[i] + hs[i] / 2;
        const q = pp[k];
        leadEls[k].setAttribute('points', `${ex.toFixed(1)},${ey.toFixed(1)} ${(ex + (side ? -8 : 8)).toFixed(1)},${ey.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`);
        tapEls[k].style.transform = `translate(${Math.round(q.x - 11)}px, ${Math.round(q.y - 11)}px)`;
      });
    });
    labels.classList.add('is-placed');
  }

  /** Where a pulse is, u of the way from a through the bus point to b. */
  function along(a, b, u) {
    const A = pp[a], B = pp[b], C = pp.bus;
    const l1 = Math.hypot(C.x - A.x, C.y - A.y), l2 = Math.hypot(B.x - C.x, B.y - C.y);
    const d = u * (l1 + l2);
    if (d <= l1) { const t = l1 ? d / l1 : 1; return [A.x + (C.x - A.x) * t, A.y + (C.y - A.y) * t, true]; }
    const t = l2 ? (d - l1) / l2 : 1;
    return [C.x + (B.x - C.x) * t, C.y + (B.y - C.y) * t, false];
  }

  function drawOver() {
    if (!stage || !ow) return;
    const c = octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, over.width, over.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = focusId();
    const dimK = frozen ? 0.45 : 1;

    // the bus: the main board's outline, brighter while messages pass
    const ba = 1 - Math.exp(-act.bus);
    c.beginPath();
    ppBoard.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.closePath();
    c.lineWidth = f === 'bus' ? 2.2 : 1.2;
    c.strokeStyle = f === 'bus' ? colors.purple : colors.brown;
    c.globalAlpha = (f === 'bus' ? 0.9 : 0.25 + 0.6 * ba) * dimK;
    c.stroke();

    // wires: every node to the bus point; the picked node's routes in purple
    const B = pp.bus;
    c.lineWidth = 1;
    c.setLineDash([]);
    for (const k of ORDER) {
      c.globalAlpha = (isLive(k) ? 0.3 : 0.12) * dimK * (f && f !== 'bus' ? 0.5 : 1);
      c.strokeStyle = colors.ink;
      c.beginPath(); c.moveTo(pp[k].x, pp[k].y); c.lineTo(B.x, B.y); c.stroke();
    }
    if (f && f !== 'bus') {
      const outs = new Set(), ins = new Set();
      for (const r of ROUTES) {
        if (r.log && f !== 'cloud') continue;
        if (r.a === f) outs.add(r.b);
        if (r.b === f && !r.log) ins.add(r.a);
      }
      c.strokeStyle = colors.purple;
      c.lineWidth = 2;
      c.globalAlpha = 0.95;
      c.beginPath(); c.moveTo(pp[f].x, pp[f].y); c.lineTo(B.x, B.y);
      for (const k of outs) { c.moveTo(B.x, B.y); c.lineTo(pp[k].x, pp[k].y); }
      c.stroke();
      c.setLineDash([4, 3]);
      c.lineWidth = 1.6;
      c.beginPath();
      for (const k of ins) if (!outs.has(k)) { c.moveTo(pp[k].x, pp[k].y); c.lineTo(B.x, B.y); }
      c.stroke();
      c.setLineDash([]);
    }

    // the LED bar, lit while the display is on
    if (displayOn() && !frozen) {
      c.globalAlpha = 1;
      for (const q of ppLeds) c.drawImage(ledGlow, q.x - 5, q.y - 5, 10, 10);
    }

    // nodes: a soft glow while busy, a ring that fills with brown
    const gs = 15;
    for (const k of KEYS) {
      const q = pp[k];
      const on = isLive(k);
      const a = on ? 1 - Math.exp(-act[k]) : 0;
      if (a > 0.02) { c.globalAlpha = a; c.drawImage(glow, q.x - gs, q.y - gs, gs * 2, gs * 2); }
      const r = k === 'bus' ? 3.2 : 4.6;
      c.globalAlpha = on ? dimK : 0.5;
      c.beginPath(); c.arc(q.x, q.y, r, 0, 2 * Math.PI);
      c.fillStyle = colors.board; c.fill();
      if (a > 0.02) { c.globalAlpha = a * 0.95; c.fillStyle = colors.brown; c.fill(); c.globalAlpha = on ? dimK : 0.5; }
      const hot = k === f;
      c.strokeStyle = hot ? colors.purple : on ? colors.ink : colors.mute;
      c.lineWidth = hot ? 2.4 : 1.4;
      if (!on) c.setLineDash([2, 2]);
      c.stroke();
      c.setLineDash([]);
    }
    if (REDUCED) { c.globalAlpha = 1; return; }

    // pulses in flight: sender → bus point → each listener
    for (const faded of [true, false]) {
      c.fillStyle = faded ? colors.mute : colors.brown;
      c.globalAlpha = faded ? 0.4 : 1;
      c.beginPath();
      for (let i = evN - 1; i >= 0 && i > evN - CAP; i--) {
        const age = T - evT[i % CAP];
        if (age > TRAVEL + 40) break;
        if (age > TRAVEL || age < 0) continue;
        const m = MSGS[evM[i % CAP]];
        const u = age / TRAVEL;
        for (let j = 0; j < m.routes.length; j++) {
          const rt = ROUTES[m.routes[j]];
          const rel = !f || f === 'bus' || rt.a === f || rt.b === f;
          if (rel === faded) continue;
          const [x, y, first] = along(rt.a, rt.b, u);
          if (!first && !isLive(rt.b)) continue; // nobody listens: the bus drops it
          c.moveTo(x + 2.4, y);
          c.arc(x, y, 2.4, 0, 2 * Math.PI);
        }
      }
      c.fill();
    }
    c.globalAlpha = 1;
  }

  function render() {
    drawOver();
  }

  /* --------------------------------------------------------------- panel */
  function paintPanel() {
    if (!sel) {
      panel.replaceChildren(h('p', { class: `${P}hint` }, 'Tap a process to see what it sends and listens to.'));
      return;
    }
    if (sel === 'bus') {
      panel.replaceChildren(h('div', { class: 'wv-insp' }, h('div', null,
        h('h4', null, 'bus', h('span', { class: 'where' }, 'always runs, on the main board')),
        h('p', null, BUS.job),
        h('p', null, 'Every pulse passes through it. It has no topics of its own.'))));
      return;
    }
    const p = PROCS[sel];
    const where = sel === 'launcher' ? 'always runs' : `runs in: ${STATE_KEYS.filter((k) => STATES[k].on.includes(sel)).map((k) => STATES[k].label.toLowerCase()).join(', ')}`;
    const outs = MSGS.filter((m) => m.from === sel);
    const ins = MSGS.filter((m) => m.to.includes(sel));
    const name = (k) => PROCS[k].n;
    const list = (items, fmt) => (items.length ? h('ul', { class: `${P}list` }, ...items.map(fmt)) : h('p', { class: `${P}none` }, 'nothing'));
    const insList = list(ins, (m) => h('li', null, h('span', { class: 'c-data' }, m.what), ` ← ${name(m.from)}`, h('span', { class: `${P}rate` }, ` · ${m.rate}`)));
    if (sel === 'cloud') insList.prepend(h('li', null, h('span', { class: 'c-data' }, 'topics the cloud asks for'), ', sent up to the cloud'));
    panel.replaceChildren(h('div', { class: 'wv-insp' }, h('div', null,
      h('h4', null, p.n, h('span', { class: 'where' }, where)),
      h('p', null, p.job),
      h('div', { class: `${P}cols` },
        h('div', null, h('p', { class: `${P}sub` }, 'sends', h('span', { class: `${P}rate` }, ' · solid line')),
          list(outs, (m) => h('li', null, h('span', { class: 'c-data' }, m.what), ` → ${m.to.map(name).join(', ')}`, h('span', { class: `${P}rate` }, ` · ${m.rate}`)))),
        h('div', null, h('p', { class: `${P}sub` }, 'listens to', h('span', { class: `${P}rate` }, ' · dashed line')), insList)))));
  }

  function pick(k) {
    sel = k;
    refocus();
    paintPanel();
  }

  /* --------------------------------------------------------- power state */
  /* The face and the robot's light ease toward these. */
  function lightGoal() {
    return { face: displayOn() && !frozen ? 1 : 0, exposure: frozen ? DIM : 1 };
  }
  function relight() {
    if (!stage) return;
    stage.render(); // its tick eases the light
  }

  function goState(next) {
    clearTimeout(timer);
    const from = state;
    state = next;
    const target = new Set(STATES[next].on);
    const stops = START.slice().reverse().filter((k) => live.has(k) && !target.has(k));
    const starts = START.filter((k) => !live.has(k) && target.has(k));
    const name = (k) => PROCS[k].n;
    const parts = [];
    if (stops.length) parts.push(`Stop ${stops.map(name).join(', ')} (reverse start order).`);
    if (starts.length) parts.push(`Start ${starts.map(name).join(', ')}.`);
    if (from !== next && !stops.length && !starts.length) parts.push('No process changes.');
    status.replaceChildren(h('span', null, STATES[next].note), parts.length ? h('span', { class: `${P}note` }, ` ${parts.join(' ')}`) : '');
    if (from !== next) {
      frozen = false;
      view.classList.remove('is-dim');
      emit(T, POWER_MSG);
    }
    const queue = [...stops.map((k) => ['stop', k]), ...starts.map((k) => ['start', k])];
    const done = () => { frozen = !!STATES[next].frozen; view.classList.toggle('is-dim', frozen); refocus(); relight(); kick(); };
    const stepQ = () => {
      const op = queue.shift();
      if (!op) { done(); return; }
      if (op[0] === 'stop') live.delete(op[1]); else live.add(op[1]);
      refocus();
      relight();
      timer = setTimeout(stepQ, 380);
    };
    if (REDUCED || !playing) { live = new Set(target); if (REDUCED) snapshot(); done(); } else timer = setTimeout(stepQ, 250);
    refocus();
    paintPanel();
    relight();
    kick();
  }

  /** Reduced motion: one still picture of the current state, from a 4 s run. */
  function snapshot() {
    evN = 0;
    for (const key in act) act[key] = 0;
    const f = frozen;
    frozen = !!STATES[state].frozen;
    T = 0;
    for (let t = 0; t < 4000; t += 50) advance(t, t + 50);
    T = 4000;
    frozen = f;
  }

  /* ---------------------------------------------------------------- loop */
  const loop = playLoop(fig, (dt) => {
    const t1 = T + (dt * 1000) / SLOW;
    advance(T, t1);
    T = t1;
    render();
    // suspended, no pulse in flight and no glow: nothing will change, so stop
    return !(frozen && T - lastEmit > TRAVEL + 40 && Object.values(act).every((a) => a < 0.01));
  });
  function kick() { if (playing && !REDUCED) loop.start(); }

  function setPlay(p) {
    playing = p;
    if (p) kick(); else { loop.stop(); render(); }
  }

  // One button walks the 5 power states in order.
  const nextBtn = btn('', () => {
    goState(STATE_KEYS[(STATE_KEYS.indexOf(state) + 1) % STATE_KEYS.length]);
    paintNext();
  });
  function paintNext() {
    const i = STATE_KEYS.indexOf(state);
    nextBtn.textContent = `Next state ▶ (${STATES[state].label}, ${i + 1}/${STATE_KEYS.length})`;
    nextBtn.setAttribute('aria-label', `Next power state. Now showing ${i + 1} of ${STATE_KEYS.length}: ${STATES[state].label}.`);
  }
  const ctl = h('div', { class: `${P}ctl` }, h('span', { class: `${P}lab` }, 'power state'), nextBtn);
  view.append(meter);
  app.append(ctl, status, view, panel);

  readColors();
  new MutationObserver(() => { readColors(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-force-dark', 'class'] });
  if (REDUCED) snapshot();
  goState('running');
  paintNext();
  paintPanel();
  setPlay(playing);
  render();

  /* The 3D robot. Without WebGPU the still image shows, and the labels
     become a plain row of buttons under it. Started after this script has
     run to its end: the stage code lives in the main file, which loads
     after this one. */
  if (!fig.dataset.face) fig.dataset.face = 'face.webp';
  queueMicrotask(() => lazy3D(fig, view, async () => {
    const look = { ...LOOK, ...lightGoal() };
    const parts = buildInnards().map((p) => (p.kind === MAT.led ? { ...p, kind: MAT.plastic } : p)); // the figure lights the LEDs itself
    stage = await makeStage(fig, view, new URL(fig.dataset.model || 'robot.glb', document.baseURI).href, {
      parts, look, far: 10,
      // a taller view on a phone
      get aspect() { return (view.clientWidth || 600) < 560 ? 1.08 : 0.66; },
    });
    stage.stopAuto();
    stage.xray = 1;
    let lastT = 0;
    stage.tick = (now) => {
      const goal = lightGoal();
      const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 1 / 30;
      lastT = now;
      const k = REDUCED ? 1 : 1 - Math.exp(-dt / 0.25);
      let busy = false;
      for (const key of ['face', 'exposure']) {
        const d = goal[key] - look[key];
        if (Math.abs(d) < 0.004) look[key] = goal[key];
        else { look[key] += d * k; busy = true; }
      }
      if (!busy) lastT = 0;
      return busy;
    };
    stage.afterRender = project;
    stage.onPick = (name) => pick(name ? PART_PROC[name] || null : null);
    view.append(over, leads, labels, meter);
    stage.aim(CAM[isWide() ? 'wide' : 'tall'], true);
    refocus();
  }));
  // without a 3D view (no WebGPU, or the model failed): labels as a row of buttons
  const fallbackObs = new MutationObserver(() => {
    if (view.classList.contains('v-bot-off')) {
      fallbackObs.disconnect();
      labels.classList.add('is-row');
      meter.classList.add('is-row');
      view.after(meter, labels);
    }
  });
  fallbackObs.observe(view, { attributes: true, attributeFilter: ['class'] });
}

register({ 'robot-procs': initProcs });

/*
 * System figures for "Designing a robot that talks with kids".
 *
 *   robot-wiring  the main board and its links: what each link carries and
 *                 how often, as one second of traffic, slowed down
 *   robot-bus     one message on the local bus: its three frames, the
 *                 relay's copies, and the sender dropping its own copy
 *   robot-procs   lives in procs.js (imported below)
 *
 * Values from the robot: 48 kHz 16-bit mono audio, voice direction every
 * 10 ms, 1280×720 camera frames at 30/s (NV21), game engine at 30 frames/s,
 * LED colours written only on change, motor frames at 30/s, 120 ms audio
 * chunks (3,840 bytes at 16 kHz), the 3-frame layout (topic, payload,
 * sender's process id). Sample values (made up): the topic name, the payload
 * size, the process id, the event and LED change times.
 */

import { h, s, btn, colorKey, register, REDUCED, ease, clamp } from '../lib.js';
import { playLoop } from './loop.js';
import './procs.js';

const WS = 'v-bot-sw-';
const BS = 'v-bot-sb-';

/* ---------------------------------------------------------------- shared */

function node(x, y, w, hh, lines, { cls = '', dash = false } = {}) {
  const g = s('g', { class: `node ${cls}` });
  const rect = s('rect', { class: `box${dash ? ' dash' : ''}`, x, y, width: w, height: hh });
  g.append(rect);
  const lh = 13;
  const top = y + hh / 2 - ((lines.length - 1) * lh) / 2 + 4;
  lines.forEach((t, i) => g.append(s('text', { x: x + w / 2, y: top + i * lh, 'text-anchor': 'middle', class: i === 0 ? 't-s t-b' : 't-xs' }, t)));
  return g;
}

function arrow(svg, cls) {
  const id = `${cls}a${Math.random().toString(36).slice(2, 7)}`;
  svg.append(s('defs', null, s('marker', {
    id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  }, s('path', { d: 'M0,1 L9,5 L0,9 z', class: `${cls}ah` }))));
  return `url(#${id})`;
}

/** Make an SVG group act as a button: click, Enter, Space. */
function pickable(g, label, onpick) {
  g.setAttribute('tabindex', '0');
  g.setAttribute('role', 'button');
  g.setAttribute('aria-label', label);
  g.classList.add('v-bot-pick');
  g.addEventListener('click', onpick);
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onpick(); }
  });
}

/**
 * Wide or tall layout by the figure's own width, not the viewport: the post
 * column is narrow. Same shape as a MediaQueryList: .matches and .onchange.
 */
function widthWatch(el, min) {
  const w = { matches: (el.clientWidth || el.parentElement?.clientWidth || 0) >= min, onchange: null };
  if ('ResizeObserver' in window) {
    new ResizeObserver(([e]) => {
      const m = e.contentRect.width >= min;
      if (e.contentRect.width && m !== w.matches) { w.matches = m; w.onchange?.(); }
    }).observe(el);
  }
  return w;
}

const kv = (rows) => h('dl', { class: 'wv-kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

/* ======================================================= robot-wiring */

/* dir +1: toward the main board. dir -1: from the main board out. */
const W_LINKS = {
  mic: {
    l: ['mic array', 'with DSP'], bus: 'USB', end: 'speech', side: 'a',
    title: 'Mic array → main board, over USB',
    rows: [
      ['carries', 'one clean audio channel, and the voice direction with voice activity'],
      ['how often', 'audio: 48,000 samples/s, 16-bit, mono (96 kB/s). Direction: every 10 ms, on a second USB link'],
      ['read by', 'the speech service'],
      ['stays on the DSP', 'echo cancellation, beamforming, noise suppression'],
    ],
  },
  cam: {
    l: ['camera'], bus: 'CSI', end: 'vision', side: 'a',
    title: 'Camera → main board, over CSI',
    rows: [
      ['carries', 'video frames, 1280×720'],
      ['how often', '30 frames/s, about 1.4 MB each (12 bits per pixel): about 41 MB/s'],
      ['read by', 'the vision service, which scales them to 640×360'],
      ['also', 'an I²C bus sets up the sensor'],
    ],
  },
  motor: {
    l: ['motor board', 'MCU · 7 motors'], bus: 'UART', end: 'game engine', side: 'a',
    title: 'Main board ⇄ motor board, over UART',
    rows: [
      ['down', 'seven motor positions and a timestamp, 30 frames/s'],
      ['up', 'events when they happen: touch, pick-up and tilt, battery level, motor stalls, errors, motor positions'],
      ['owned by', 'the game engine'],
      ['stays on the MCU', 'motor control. The board uses the timestamps to smooth motion between frames, and can wake the main chip'],
    ],
  },
  proj: {
    l: ['projector'], bus: 'display', end: 'game engine', side: 'b',
    title: 'Main board → projector, over the display output',
    rows: [
      ['carries', 'the face image. To Android, the projector is a display'],
      ['how often', 'a new frame 30 times a second, the game engine\u2019s frame rate'],
      ['written by', 'the game engine'],
      ['also', 'an I²C link for brightness and temperature'],
    ],
  },
  led: {
    l: ['LED bar'], bus: 'I²C', end: 'game engine', side: 'b',
    title: 'Main board → LED bar, over I²C',
    rows: [
      ['carries', 'LED colours'],
      ['how often', 'checked every frame (30/s), written only when a colour changes'],
      ['written by', 'the game engine'],
    ],
  },
  cloud: {
    l: ['cloud'], bus: 'Wi-Fi', end: 'cloud link', side: 'b', dash: true,
    title: 'Main board ⇄ cloud, over Wi-Fi',
    rows: [
      ['up', 'audio chunks while a child talks, chat requests, events'],
      ['down', 'transcripts, answers, settings'],
      ['how often', 'one 120 ms audio chunk (3,840 bytes at 16 kHz) about 8 times a second while the child talks'],
      ['owned by', 'the cloud link: MQTT over TLS, port 443'],
    ],
  },
};
const W_ORDER = ['mic', 'cam', 'motor', 'proj', 'led', 'cloud'];

const W_FLOWS = [
  { link: 'mic', lane: -1, dir: 1, label: 'audio', rate: '96 kB/s', cont: true },
  { link: 'mic', lane: 1, dir: 1, label: 'voice direction', rate: '100/s', every: 10, phase: 4 },
  { link: 'cam', lane: 0, dir: 1, label: 'video frames', rate: '30/s', every: 1000 / 30, phase: 9 },
  { link: 'motor', lane: -1, dir: -1, label: 'motor positions', rate: '30/s', every: 1000 / 30, phase: 21 },
  { link: 'motor', lane: 1, dir: 1, label: 'events', rate: 'touch (sample)', at: [620] },
  { link: 'proj', lane: 0, dir: -1, label: 'face frames', rate: '30/s', every: 1000 / 30, phase: 15 },
  { link: 'led', lane: 0, dir: -1, label: 'LED colours', rate: 'on change', at: [480] },
  { link: 'cloud', lane: 0, dir: -1, label: 'audio chunks', rate: 'every 120 ms', every: 120, phase: 120 },
];
for (const f of W_FLOWS) {
  if (f.every) { f.times = []; for (let t = f.phase; t < 1000; t += f.every) f.times.push(t); }
  else f.times = f.at || [];
}

const W_LAYOUT = {
  wide: {
    vb: [760, 420], dev: { w: 150, h: 50 }, board: { x: 290, y: 6, w: 180, h: 210 },
    pos: { mic: [10, 16], cam: [10, 86], motor: [10, 156], proj: [600, 16], led: [600, 86], cloud: [600, 156] },
    title: [380, 72], tl: { y: 246, x0: 200, x1: 750, row: 18, lab: 10, top: 26 },
  },
  tall: {
    vb: [360, 590], dev: { w: 110, h: 46 }, board: { x: 6, y: 110, w: 348, h: 84 },
    pos: { mic: [6, 6], cam: [125, 6], motor: [244, 6], proj: [6, 252], led: [125, 252], cloud: [244, 252] },
    title: [180, 150], tl: { y: 322, x0: 6, x1: 354, row: 30, lab: 6, top: 26 },
  },
};

const TRAVEL = 40; // ms a message takes to cross a link in the drawing
const SLOW = 10;

function initWiring(fig, app) {
  const mq = widthWatch(app, 600);
  const host = h('div', { class: `${WS}map` });
  const panel = h('div', { class: `${WS}panel`, 'aria-live': 'polite' });
  let sel = 'mic';
  let t = 0;
  let playing = !REDUCED;
  let M = null;
  // playback: one loop, at most 30 paints a second, none off screen
  const loop = playLoop(fig, (dt) => {
    t = (t + (dt * 1000) / SLOW) % 1000;
    paint();
  });

  const playBtn = btn('', () => setPlay(!playing), { 'aria-pressed': 'false' });
  const out = h('output', { class: `${WS}out` });
  const input = h('input', { type: 'range', min: 0, max: 999, step: 1, value: 0, 'aria-label': 'Time within one second, in milliseconds' });
  input.addEventListener('input', () => { setPlay(false); t = +input.value; paint(); });

  function setPlay(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚ Pause' : '▶ Play';
    playBtn.setAttribute('aria-pressed', String(p));
    if (p) loop.start(); else loop.stop();
  }

  function draw() {
    const L = W_LAYOUT[mq.matches ? 'wide' : 'tall'];
    const wide = mq.matches;
    const svg = s('svg', {
      viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img',
      'aria-label': 'The main board in the middle with six links: mic array over USB, camera over CSI, motor board over UART, projector over the display output, LED bar over I²C, and the cloud over Wi-Fi. Below, one second of messages on each link.',
    });
    const mk = arrow(svg, WS);
    const B = L.board;
    const links = {};
    const devs = {};
    const ends = {};

    // links first, so boxes sit on top
    const gLinks = s('g');
    const gPk = s('g');
    svg.append(gLinks);
    for (const id of W_ORDER) {
      const d = W_LINKS[id];
      const [x, y] = L.pos[id];
      const W = L.dev.w, H = L.dev.h;
      let a, b; // a: device end, b: board end
      if (wide) {
        const cy = y + H / 2;
        a = d.side === 'a' ? [x + W, cy] : [x, cy];
        b = d.side === 'a' ? [B.x, cy] : [B.x + B.w, cy];
      } else {
        const cx = x + W / 2;
        a = d.side === 'a' ? [cx, y + H] : [cx, y];
        b = d.side === 'a' ? [cx, B.y] : [cx, B.y + B.h];
      }
      const g = s('g', { class: `${WS}link` });
      const line = s('line', { class: 'edge', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      const hit = s('line', { class: `${WS}hit`, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      const lab = wide
        ? s('text', { x: (a[0] + b[0]) / 2, y: a[1] - 9, 'text-anchor': 'middle', class: 't-xs t-b halo' }, d.bus)
        : s('text', { x: a[0] + 10, y: (a[1] + b[1]) / 2 + 3, class: 't-xs t-b halo' }, d.bus);
      g.append(line, hit, lab);
      pickable(g, `${d.bus} link to the ${d.l[0]}`, () => select(id));
      gLinks.append(g);
      links[id] = { g, a, b, line };
    }
    svg.append(gPk);

    const board = s('g', { class: 'node' });
    board.append(s('rect', { class: 'box', x: B.x, y: B.y, width: B.w, height: B.h }));
    board.append(s('text', { x: L.title[0], y: L.title[1], 'text-anchor': 'middle', class: 't-s t-b' }, 'main board'));
    board.append(s('text', { x: L.title[0], y: L.title[1] + 14, 'text-anchor': 'middle', class: 't-xs' }, 'ARM + GPU · Android'));
    svg.append(board);
    for (const id of W_ORDER) {
      const d = W_LINKS[id];
      const { b } = links[id];
      const t1 = wide
        ? s('text', { x: d.side === 'a' ? b[0] + 6 : b[0] - 6, y: b[1] + 4, 'text-anchor': d.side === 'a' ? 'start' : 'end', class: 't-xs t-mute' }, d.end)
        : s('text', { x: b[0], y: d.side === 'a' ? b[1] + 14 : b[1] - 6, 'text-anchor': 'middle', class: 't-xs t-mute' }, d.end);
      svg.append(t1);
      ends[id] = t1;
    }
    for (const id of W_ORDER) {
      const d = W_LINKS[id];
      const [x, y] = L.pos[id];
      const g = node(x, y, L.dev.w, L.dev.h, d.l, { dash: d.dash });
      pickable(g, `${d.l[0]}: show what its link carries`, () => select(id));
      svg.append(g);
      devs[id] = g;
    }

    // packets: one pool per flow
    const flows = W_FLOWS.map((f) => {
      const { a, b } = links[f.link];
      const [p0, p1] = f.dir > 0 ? [a, b] : [b, a];
      const off = f.lane * 5;
      const ox = wide ? 0 : off, oy = wide ? off : 0;
      const P0 = [p0[0] + ox, p0[1] + oy], P1 = [p1[0] + ox, p1[1] + oy];
      const len = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
      if (f.cont) {
        const el = s('line', { class: `${WS}stream`, x1: P0[0], y1: P0[1], x2: P1[0], y2: P1[1] });
        gPk.append(el);
        return { f, el, len };
      }
      const pool = [];
      for (let i = 0; i < 6; i++) { const r = s('rect', { class: `${WS}pk`, width: 6, height: 6, x: -3, y: -3 }); r.style.display = 'none'; gPk.append(r); pool.push(r); }
      return { f, pool, P0, P1 };
    });

    // timeline
    const T = L.tl;
    const tx = (ms) => T.x0 + (ms / 1000) * (T.x1 - T.x0);
    const gT = s('g', { class: `${WS}tl` });
    gT.append(s('text', { x: T.lab, y: T.y, class: 't-xs t-b t-up' }, 'one second on each link · slowed down 10×'));
    for (const ms of [0, 250, 500, 750, 1000]) {
      gT.append(s('line', { class: 'rule', x1: tx(ms), y1: T.y + 22, x2: tx(ms), y2: T.y + T.top + W_FLOWS.length * T.row }));
      gT.append(s('text', { x: tx(ms), y: T.y + 18, 'text-anchor': ms === 0 ? 'start' : ms === 1000 ? 'end' : 'middle', class: 't-xs t-mute' }, ms === 1000 ? '1 s' : `${ms} ms`));
    }
    // the playhead: one line on wide screens, one short mark per track on phones
    const head = s('g', { class: `${WS}head` });
    if (wide) head.append(s('line', { x1: 0, y1: T.y + 22, x2: 0, y2: T.y + T.top + W_FLOWS.length * T.row }));
    else W_FLOWS.forEach((_, i) => { const y = T.y + T.top + i * T.row + 20; head.append(s('line', { x1: 0, y1: y - 9, x2: 0, y2: y + 9 })); });
    const rows = W_FLOWS.map((f, i) => {
      const y = T.y + T.top + i * T.row;
      const g = s('g', { class: `${WS}row` });
      const trackY = wide ? y + 9 : y + 20;
      g.append(s('rect', { class: `${WS}rowhit`, x: 0, y: y - 1, width: L.vb[0], height: T.row }));
      const labY = wide ? y + 12 : y + 9;
      const lab = s('text', { x: T.lab, y: labY, class: 't-xs halo' });
      lab.append(s('tspan', { class: 't-b' }, f.label), s('tspan', { class: 't-mute' }, ` · ${f.rate}`));
      g.append(lab);
      g.append(s('line', { class: 'rule', x1: T.x0, y1: trackY, x2: T.x1, y2: trackY }));
      let ticks = [];
      if (f.cont) {
        g.append(s('rect', { class: `${WS}cont`, x: T.x0, y: trackY - 3, width: T.x1 - T.x0, height: 6 }));
      } else {
        ticks = f.times.map((ms) => {
          const ln = s('line', { class: `${WS}tick`, x1: tx(ms), y1: trackY - 6, x2: tx(ms), y2: trackY + 6 });
          g.append(ln);
          return ln;
        });
        if (f.at) g.append(s('text', { x: tx(f.times[0]) + 5, y: trackY - 2, class: 't-xs t-data' }, 'sample'));
      }
      pickable(g, `${f.label}: ${f.rate}`, () => select(f.link));
      gT.append(g);
      return { g, ticks, f };
    });
    gT.append(head);
    svg.append(gT);

    host.replaceChildren(svg);
    M = { links, devs, ends, flows, rows, head, tx, mk };
    select(sel, true);
  }

  function paint() {
    if (!M) return;
    input.value = String(Math.round(t));
    out.textContent = `t = ${String(Math.round(t)).padStart(3, '\u2007')} ms`;
    const x = M.tx(t);
    M.head.setAttribute('transform', `translate(${x} 0)`);
    for (const fl of M.flows) {
      if (fl.el) {
        fl.el.style.strokeDashoffset = String(-((t / TRAVEL) * fl.len) % 8);
        continue;
      }
      let k = 0;
      for (const ti of fl.f.times) {
        for (const tt of [ti, ti - 1000]) {
          const age = t - tt;
          if (age < 0 || age >= TRAVEL || k >= fl.pool.length) continue;
          const u = age / TRAVEL;
          const r = fl.pool[k++];
          r.style.display = '';
          r.setAttribute('transform', `translate(${fl.P0[0] + (fl.P1[0] - fl.P0[0]) * u} ${fl.P0[1] + (fl.P1[1] - fl.P0[1]) * u})`);
        }
      }
      for (; k < fl.pool.length; k++) fl.pool[k].style.display = 'none';
    }
    for (const r of M.rows) r.ticks.forEach((ln, i) => ln.classList.toggle('is-past', r.f.times[i] <= t));
  }

  function select(id, quiet) {
    sel = id;
    if (!M) return;
    for (const k of W_ORDER) {
      const on = k === id;
      M.devs[k].classList.toggle('is-focus', on);
      M.links[k].g.classList.toggle('is-on', on);
      M.links[k].line.removeAttribute('marker-end');
      M.links[k].line.removeAttribute('marker-start');
      M.ends[k].classList.toggle('t-look', on);
      M.ends[k].classList.toggle('t-mute', !on);
    }
    // arrowheads on the selected link show which way data goes
    const dirs = new Set(W_FLOWS.filter((f) => f.link === id).map((f) => f.dir));
    const ln = M.links[id].line;
    if (dirs.has(1)) ln.setAttribute('marker-end', M.mk);
    if (dirs.has(-1)) ln.setAttribute('marker-start', M.mk);
    for (const r of M.rows) r.g.classList.toggle('is-on', r.f.link === id);
    const d = W_LINKS[id];
    panel.replaceChildren(h('p', { class: `${WS}ptitle` }, d.title), kv(d.rows));
    if (!quiet) paint();
  }

  const ctl = h('div', { class: `${WS}ctl` }, playBtn,
    h('div', { class: 'wv-range' }, h('label', null, 'time'), input, out));
  app.append(ctl, host,
    h('p', { class: `${WS}hint` }, 'Tap a device, a link or a row to see what the link carries.'),
    panel,
    colorKey([['k-data', 'messages'], ['k-look', 'selected link']]));
  mq.onchange = draw;
  draw();
  setPlay(playing);
  t = REDUCED ? 500 : 0;
  paint();
}

/* ========================================================== robot-bus */

/* Sample values (made up): the topic name and the process id. */
const TOPIC = 'vision.FaceLearnState';
const PID = 2417;
const PAYLOAD_LEN = 19;

/* One time line, in ms: send, the relay reads the topic, copies fan out,
   the sender drops its own copy. paint() draws any moment of it. */
const T = { send: 400, atRelay: 1300, fan: 1700, arrive: 2800, end: 3600 };
const BUS_TEXT = [
  'Vision sends one message to the relay.',
  'The relay sends a copy to each service that listens to the topic.',
  'Vision gets its own copy back. The sender id is its own, so it drops it.',
];

const BUS_LAYOUT = {
  wide: {
    vb: [760, 246],
    card: [160, 6, [200, 140, 100]],
    n: {
      vision: [10, 105, 180, 56, ['vision', `process ${PID}`, 'listens to this topic']],
      relay: [300, 113, 120, 40, ['relay']],
      dialogue: [560, 60, 190, 44, ['dialogue', 'listens to this topic']],
      cloud: [560, 111, 190, 44, ['cloud link', 'listens to this topic']],
      world: [560, 162, 190, 44, ['world model', 'listens to other topics']],
    },
    p: {
      send: 'M190,133 L300,133',
      dialogue: 'M420,123 C490,123 490,82 560,82',
      cloud: 'M420,133 L560,133',
      world: 'M420,143 C490,143 490,184 560,184',
      vision: 'M360,153 L360,236 L100,236 L100,161',
    },
    drop: [112, 204, 'start'],
    none: [466, 178, 'middle'],
  },
  tall: {
    vb: [360, 296],
    card: [4, 4, [166, 112, 74]],
    n: {
      vision: [90, 56, 180, 52, ['vision', `process ${PID}`, 'listens to this topic']],
      relay: [120, 150, 120, 36, ['relay']],
      dialogue: [4, 236, 112, 56, ['dialogue', 'listens to', 'this topic']],
      cloud: [124, 236, 112, 56, ['cloud link', 'listens to', 'this topic']],
      world: [244, 236, 112, 56, ['world model', 'listens to', 'other topics']],
    },
    p: {
      send: 'M180,108 L180,150',
      dialogue: 'M160,186 L160,210 L60,210 L60,236',
      cloud: 'M180,186 L180,236',
      world: 'M200,186 L200,210 L300,210 L300,236',
      vision: 'M120,168 L40,168 L40,82 L90,82',
    },
    drop: [48, 132, 'start'],
    none: [262, 204, 'middle'],
  },
};

function initBus(fig, app) {
  const mq = widthWatch(app, 600);
  const host = h('div', { class: `${BS}map` });
  const text = h('p', { class: `${BS}step` });
  let M = null;
  let t = T.end; // before the first play, show the whole story
  let fresh = true;

  // plays once when the figure first comes into view, and on Replay
  const loop = playLoop(fig, (dt) => {
    if (fresh) { fresh = false; t = 0; } else t = Math.min(T.end, t + dt * 1000);
    paint();
    return t < T.end;
  });

  function draw() {
    const L = BUS_LAYOUT[mq.matches ? 'wide' : 'tall'];
    const svg = s('svg', {
      viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img',
      'aria-label': `One message of three frames: the topic ${TOPIC}, a protobuf payload and the sender's process id ${PID}. Vision sends it to the relay. The relay sends a copy to the dialogue service and the cloud link, which listen to this topic. The world model listens to other topics and gets no copy. Vision listens to this topic too, gets its own copy back and drops it, because the process id is its own.`,
    });
    const mk = arrow(svg, BS);
    const mkInk = arrow(svg, `${BS}i`);

    // the message: three frames
    const [cx, cy, ws] = L.card;
    const frames = [['topic', TOPIC], ['protobuf payload', `${PAYLOAD_LEN} bytes`], ['sender id', String(PID)]];
    const segs = [];
    let x = cx;
    frames.forEach(([lab, val], i) => {
      const g = s('g', { class: `${BS}seg` },
        s('rect', { x, y: cy, width: ws[i] - 2, height: 38 }),
        s('text', { x: x + 6, y: cy + 14, class: 't-xs t-mute' }, lab),
        s('text', { x: x + 6, y: cy + 30, class: 't-s t-b' }, val));
      svg.append(g);
      segs.push(g);
      x += ws[i];
    });

    const paths = {};
    for (const [k, d] of Object.entries(L.p)) {
      const p = s('path', { class: `edge${k === 'world' ? ` ${BS}none` : ''}`, d, 'marker-end': mkInk });
      svg.append(p);
      paths[k] = p;
    }
    const nodes = {};
    for (const [k, [nx, ny, w, hh, lines]] of Object.entries(L.n)) {
      nodes[k] = node(nx, ny, w, hh, lines);
      svg.append(nodes[k]);
    }
    const label = ([lx, ly, anchor], str, cls) => {
      const el = s('text', { x: lx, y: ly, 'text-anchor': anchor, class: `t-xs t-b halo ${BS}mark ${cls}` }, str);
      svg.append(el);
      return el;
    };
    const none = label(L.none, 'no copy', 't-mute');
    const drop = label(L.drop, `own id ${PID}: dropped`, 't-bad');

    // a message on the move: the same three frames, small
    const mkTok = () => {
      const g = s('g', { class: `${BS}tok` });
      [0, 1, 2].forEach((i) => g.append(s('rect', { x: -13 + i * 9, y: -6, width: 8, height: 12, class: `${BS}tb` })));
      g.append(s('line', { x1: -16, y1: 8, x2: 16, y2: -8, class: `${BS}strike` }));
      svg.append(g);
      return g;
    };
    const toks = { send: mkTok(), dialogue: mkTok(), cloud: mkTok(), vision: mkTok() };
    host.replaceChildren(svg);
    M = { nodes, paths, toks, segs, none, drop, mk, mkInk };
    paint();
  }

  // a message stops just short of the box it reaches
  const place = (tok, p, u) => {
    const q = p.getPointAtLength((p.getTotalLength() - 17) * u);
    tok.style.display = '';
    tok.setAttribute('transform', `translate(${q.x} ${q.y})`);
  };

  function paint() {
    if (!M) return;
    // reduced motion: jump between the three moments, no travel
    const at = REDUCED ? (t < T.atRelay ? 0 : t < T.arrive ? T.atRelay : T.end) : t;
    const prog = (a, b) => clamp((at - a) / (b - a), 0, 1);
    const { nodes, paths, toks, segs } = M;
    const phase = at < T.atRelay ? 0 : at < T.arrive ? 1 : 2;
    const fan = at >= T.fan;
    const done = at >= T.arrive;
    const set = (el, cls, on) => el.classList.toggle(cls, !!on);

    set(nodes.vision, 'is-focus', phase !== 1);
    set(nodes.relay, 'is-focus', phase === 1);
    set(nodes.dialogue, 'is-focus', done);
    set(nodes.cloud, 'is-focus', done);
    set(nodes.world, 'is-dim', fan);
    const hot = { send: at >= T.send && !fan, dialogue: fan, cloud: fan, vision: fan };
    for (const [k, p] of Object.entries(paths)) {
      set(p, `${BS}hot`, hot[k]);
      p.setAttribute('marker-end', hot[k] ? M.mk : M.mkInk);
    }
    set(M.none, 'is-on', fan);
    set(M.drop, 'is-on', done);
    set(segs[0], 'is-hot', phase === 1);
    set(segs[2], 'is-bad', done);

    for (const tk of Object.values(toks)) tk.style.display = 'none';
    if (!fan) place(toks.send, paths.send, ease(prog(T.send, T.atRelay)));
    else for (const k of ['dialogue', 'cloud', 'vision']) place(toks[k], paths[k], ease(prog(T.fan, T.arrive)));
    set(toks.vision, `${BS}gone`, done);

    text.textContent = BUS_TEXT[phase];
  }

  const replay = btn('↻ Replay', () => { fresh = true; loop.start(); });
  app.append(h('div', { class: `${BS}ctl` }, replay, text), host,
    colorKey([['k-data', 'message'], ['k-look', 'now'], ['k-gap', 'dropped']]));
  mq.onchange = draw;
  draw();
  if (!REDUCED) loop.start();
}

register({ 'robot-wiring': initWiring, 'robot-bus': initBus });

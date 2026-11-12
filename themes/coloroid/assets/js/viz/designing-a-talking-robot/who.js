/*
 * Fig. 6 robot-who — "Who is talking": one scenario on a lawn, played in
 * two views side by side.
 *
 *   robot's view  a second stage whose camera sits in the robot's head
 *                 (80° wide, 16:9, head tilted up by NOD): the garden and
 *                 the children as the robot sees them, a box on each face
 *                 with the distance from its width, and a strip of
 *                 directions at the bottom with the voice estimate on it
 *   room view     the same scene from above and behind: the robot, three
 *                 seated toy children, a radio, and the data on the ground
 *
 * The voice on the ground of the room view:
 *
 *   direction ring  one bar per 5° bin around the robot; each 45 ms sample
 *                   adds to its bin and fades (1.5 s); teal inside a face's
 *                   cone, red outside every cone
 *   estimate        a soft orange wedge from the robot: the mean of the last
 *                   0.5 s of samples, as wide as their spread
 *   cones           each face's match cone, (1 − cos Δ) / 2 ≤ 0.075, about
 *                   ±31.8°; the cone that holds the estimate fills, and the
 *                   child's name lights up in both views
 *   sound           arcs leave the mouth of whoever talks (blue: the radio)
 *
 * Values from the robot: the match test and score, the 45 ms samples, the
 * voice-only person 1 m away and its decay (to 0.15 in 1 s, or 3 s while the
 * robot talks or turns), a face joining a voice-only person within 25°, the
 * 80° view, gaze inside ±27° and the engagement update every 500 ms.
 * Sample values: layout, direction noise, timings and sentences.
 *
 * Rendering: the shared stage draws the robot and the garden. This module
 * draws the children, the data and the props into the stage's last pass
 * through stage.overlay. The robot's view draws only the solid shapes, from
 * the same vertex buffers. The children's meshes are built once and copied
 * with a transform (toyKid); the scene is rebuilt and uploaded only when the
 * time changes. Both stages draw only while the scenario plays (at most
 * 30 fps) or the room view moves; a scrub draws once.
 */

import { h, btn, colorKey, REDUCED, clamp, mulberry } from '../lib.js';
import { lipSync, mouthAt } from './face.js';

const DEG = Math.PI / 180;
const MATCH = 0.075; // (1 − cos Δ) / 2 ≤ MATCH
const MATCH_DEG = Math.acos(1 - 2 * MATCH) / DEG; // 31.8°
const FOV_H = 80; // the world model's camera view, degrees
const FOV_V = 2 * Math.atan(Math.tan(40 * DEG) * 9 / 16) / DEG; // 16:9 frame
const JOIN_DEG = 25; // a new face joins a voice-only person this close
const GAZE_DEG = 27;
const SAMPLE_MS = 45;
const TICK = 10; // the mic array reports every 10 ms
const TAG_UP = 0.1; // name tags hang this far over the top of the head
const NOD = -12; // the robot tilts its head up (degrees) to look at seated children
let GY = 0; // height of the floor drawings: above the grass in the garden
let garden = false;

/* Child-tuned table: face width (share of the frame width) → metres. */
const FACE_TABLE = [[0.043, 2.0], [0.0559, 1.5], [0.066, 1.25], [0.0809, 1.0], [0.0991, 0.8], [0.112, 0.7], [0.1288, 0.6], [0.1521, 0.5], [0.1864, 0.4]];
function faceWidthAt(d) {
  const T = FACE_TABLE;
  if (d >= T[0][1]) return T[0][0];
  for (let i = 1; i < T.length; i++) {
    if (d >= T[i][1]) {
      const t = (d - T[i - 1][1]) / (T[i][1] - T[i - 1][1]);
      return T[i - 1][0] + t * (T[i][0] - T[i - 1][0]);
    }
  }
  return T[T.length - 1][0];
}

const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const dist = (a, b) => (1 - Math.cos((a - b) * DEG)) / 2;
const at = (deg, d, y = 0) => [Math.sin(deg * DEG) * d, y, Math.cos(deg * DEG) * d];
const fmtDeg = (a) => `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(Math.round(a))}°`;

/* ---------------------------------------------------------------- scenes */

const KIDS = [
  { id: 'ava', name: 'Ava', deg: -20, d: 1.0 },
  { id: 'leo', name: 'Leo', deg: 30, d: 0.85 },
  { id: 'sam', name: 'Sam', deg: 85, d: 1.0 },
];
const RADIO = { deg: 130, d: 1.5, mouth: 0.2 }; // a radio on the grass, off camera (sample)
const srgbHex = (hx) => [1, 3, 5].map((i) => { const c = parseInt(hx.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const nameOf = (id) => KIDS.find((k) => k.id === id)?.name ?? 'Radio';
const kidOf = (S, id) => S.kids.find((k) => k.id === id);

/* One scenario, about 33 s (sample timings and sentences). Each entry:
   [time in ms, what happens]. talk(…, answer) makes the robot answer when
   the words go to a child. */
const END = 33000;
const STILL = 8600; // the moment shown with reduced motion
const lookAt = (ids, to) => (S) => {
  for (const id of ids) {
    const k = kidOf(S, id);
    k.headGoal = to === 'robot' ? 0 : headToward(k, to === 'radio' ? at(RADIO.deg, RADIO.d) : kidPos(kidOf(S, to)));
  }
};
const SCRIPT = [
  [200, lookAt(['leo'], 'ava')],
  [200, lookAt(['ava'], 'leo')],
  [500, (S) => talk(S, 'leo', 1400, 'Did you see the tiger?')],
  [3000, (S) => talk(S, 'ava', 1200, 'It was so big!')],
  [4800, lookAt(['ava', 'leo'], 'robot')],
  [5600, (S) => talk(S, 'ava', 1800, 'Robot, can we play a game?', 'Yes! Let’s play I spy.')],
  [10400, (S) => talk(S, 'leo', 1400, 'I want to play too!', 'Great, two players.')],
  [14800, (S) => talk(S, 'sam', 1300, 'Can I play too?')],
  [17100, (S) => {
    const g = S.people.find((p) => p.ghost);
    S.robot.goal = g ? g.deg : KIDS[2].deg;
    note(S, 'The robot turns toward the voice to look for a face.');
  }],
  [19300, (S) => say(S, 'Hi, Sam! Now we have three.')],
  [21300, (S) => { S.robot.goal = 5; }],
  [22800, (S) => talk(S, 'ava', 1900, 'Me first!', (n) => `OK, ${n}, you start.`)],
  [23200, (S) => talk(S, 'leo', 1800, 'No, me first!', (n) => `OK, ${n}, you start.`)],
  [28000, (S) => talk(S, 'radio', 2200, 'And now, the weather.')],
  [28400, lookAt(['ava', 'leo'], 'radio')],
];

/* ------------------------------------------------------------ simulation */

function newState(seed = 1234) {
  const S = {
    t: 0, rnd: mulberry(seed),
    robot: { yaw: 0, goal: 0, speakUntil: -1 },
    kids: KIDS.map((k) => ({ ...k, head: 0, headGoal: 0, yawHist: [] })),
    people: [], // { id, kid|null, ghost, deg, born, conf, eng: { level, gaze, resp, decay } }
    sources: [], // { who, t0, t1, text, answer }
    utter: null,
    last: null, // last decision
    doa: null, // current raw direction (world, degrees)
    hist: [], // recent samples { deg, t }: the direction ring
    est: null, // direction estimate { deg, half, t }
    waves: [], // { who, t0 }
    said: null, // the robot's last sentence { text, t0, t1 }
    msg: null, // the last plain line of what the robot decides { text, cls }
    nextEng: 500, nextFace: 0, nextId: 1,
    events: SCRIPT.map(([t, fn]) => ({ t, fn })),
  };
  // the robot already knows the two children in front of it
  for (const id of ['ava', 'leo']) addPerson(S, kidOf(S, id));
  return S;
}

function addPerson(S, kid) {
  const p = { id: S.nextId++, kid: kid.id, ghost: false, deg: kid.deg, d: kid.d, eng: { level: 0.5, gaze: 1, resp: 0, decay: 0.8 } };
  for (let i = 0; i < 20; i++) kid.yawHist.push(kid.head);
  S.people.push(p);
  return p;
}
function makeGhost(S, deg) {
  return { id: S.nextId++, kid: null, ghost: true, deg, d: 1, born: S.t, conf: 1, eng: { level: 0, gaze: 0, resp: 0, decay: 0.8 } };
}

function talk(S, who, ms, text, answer = null) {
  S.sources.push({ who, t0: S.t, t1: S.t + ms, text, answer });
  S.waves.push({ who, t0: S.t });
}
function say(S, text, ms = 2000) {
  S.robot.speakUntil = S.t + ms;
  S.said = { text, t0: S.t, t1: S.t + ms };
}
function note(S, text, cls = '') { S.msg = { text, cls, t: S.t }; }

const kidPos = (k) => at(k.deg, k.d);
function headToward(k, p) {
  const [x, , z] = kidPos(k);
  const face0 = Math.atan2(-x, -z) / DEG; // facing the robot
  return wrap(Math.atan2(p[0] - x, p[2] - z) / DEG - face0);
}
function sourceDeg(S, who) {
  if (who === 'radio') return RADIO.deg;
  return kidOf(S, who).deg;
}
const inView = (S, deg) => Math.abs(wrap(deg - S.robot.yaw)) < FOV_H / 2;
const turning = (S) => Math.abs(wrap(S.robot.goal - S.robot.yaw)) > 0.5;
const speaking = (S) => S.t < S.robot.speakUntil;

/* The robot's face: while it speaks, one mouth shape per phone of its line
   (from the spelling, about 12 phones a second) and a mood for the line:
   curious for a question, happy otherwise. The mood stays 1.5 s after the
   line, then the face goes back to neutral. */
const robotFace = { mood: 'neutral', level: 1, lids: 0, mouth: null };
function faceOf(S) {
  const sd = S.said;
  robotFace.mood = 'neutral';
  robotFace.mouth = null;
  if (sd && S.t >= sd.t0 && S.t < sd.t1 + 1500) {
    robotFace.mood = sd.text.includes('?') ? 'curious' : 'happy';
    sd.lips ??= lipSync(sd.text, sd.t0 / 1000);
    if (S.t < sd.t1) robotFace.mouth = mouthAt(sd.lips, S.t / 1000, null);
  }
  return robotFace;
}

/* Score one person: Σ wᵢ cos Δᵢ / N over the samples in the cone. */
function scorePerson(deg, samples, used) {
  const N = samples.length;
  let sum = 0, n = 0;
  samples.forEach((s, i) => {
    if (dist(s, deg) <= MATCH) {
      sum += ((i + N) / (2 * N)) * Math.cos((s - deg) * DEG);
      used.add(i);
      n++;
    }
  });
  return { score: N ? sum / N : 0, n };
}
/* Unused samples vote for a voice-only person at the densest one. */
function scoreVoiceOnly(samples, used) {
  const N = samples.length;
  let best = -0.1, deg = null, n = 0;
  samples.forEach((a, i) => {
    if (used.has(i)) return;
    let sc = 0, c = 0;
    samples.forEach((b, j) => {
      if (used.has(j) || i === j || dist(a, b) > MATCH) return;
      sc += ((i + N) / (2 * N)) * Math.cos((a - b) * DEG);
      c++;
    });
    sc /= N;
    if (sc > best) { best = sc; deg = a; n = c + 1; }
  });
  return { score: Math.min(best, 1), deg, n };
}
function scoreAll(S, samples) {
  const used = new Set();
  const rows = S.people.map((p) => ({ p, ...scorePerson(p.deg, samples, used) }));
  const vo = scoreVoiceOnly(samples, used);
  return { rows, vo, N: samples.length };
}

function decide(S) {
  const u = S.utter;
  const sc = scoreAll(S, u.samples);
  let best = null;
  for (const r of sc.rows) if (r.score > 0 && (!best || r.score > best.score)) best = r;
  let winner;
  if (sc.vo.score > 0 && (!best || sc.vo.score > best.score)) {
    winner = makeGhost(S, sc.vo.deg);
    S.people.push(winner);
  } else if (best) {
    winner = best.p;
    if (winner.ghost) { winner.born = S.t; winner.conf = 1; }
  }
  const truth = [...new Set(u.parts.map((p) => p.who))];
  S.last = { t: S.t, winner, sc, truth };
  if (!winner) note(S, 'No samples, no match.');
  else if (winner.ghost) note(S, `No face in that direction. The words go to a voice-only person at ${fmtDeg(winner.deg)}.`, 'is-bad');
  else {
    const name = nameOf(winner.kid), r = sc.rows.find((x) => x.p === winner);
    note(S, `${truth.length > 1 ? 'Two voices, one transcript. ' : ''}The words go to ${name}: ${r.n} of ${sc.N} samples in ${name}’s cone.`, 'is-good');
    const ans = u.parts.find((p) => p.answer)?.answer;
    if (ans) {
      say(S, typeof ans === 'function' ? ans(name) : ans);
      winner.eng.resp = 1;
      winner.eng.decay = 0.985;
    }
  }
  S.utter = null;
}

/* The direction estimate: the mean of the samples in the last 0.5 s; its
   spread is the uncertainty (the width of the wedge). */
function estimate(S) {
  let sx = 0, sz = 0, n = 0;
  for (let i = S.hist.length - 1; i >= 0 && S.t - S.hist[i].t <= 500; i--) {
    sx += Math.sin(S.hist[i].deg * DEG); sz += Math.cos(S.hist[i].deg * DEG); n++;
  }
  if (!n) return;
  const R = Math.hypot(sx, sz) / n, sd = Math.sqrt(-2 * Math.log(Math.max(R, 1e-6))) / DEG;
  S.est = { deg: Math.atan2(sx, sz) / DEG, half: clamp(sd + 4, 5, 40), t: S.t };
}
/* How strong the estimate shows: full while samples come in, then gone in 0.6 s. */
const estA = (S) => (S.est ? clamp(1 - (S.t - S.est.t - 150) / 600, 0, 1) : 0);

function tick(S) {
  S.t += TICK;
  for (const e of S.events) if (!e.done && e.t <= S.t) { e.done = true; e.fn(S); }

  // robot body turn (sample speed), and head turns
  const dy = wrap(S.robot.goal - S.robot.yaw);
  S.robot.yaw = wrap(S.robot.yaw + Math.sign(dy) * Math.min(Math.abs(dy), Math.max(0.15, Math.min(0.6, Math.abs(dy) * 0.03))));
  for (const k of S.kids) {
    const dh = k.headGoal - k.head;
    k.head += Math.sign(dh) * Math.min(Math.abs(dh), 1.6);
  }

  // hearing: one direction every 10 ms from the loudest source
  let live = 0;
  for (const s of S.sources) if (S.t >= s.t0 && S.t < s.t1) live++;
  if (live) {
    const on = S.sources.filter((s) => S.t >= s.t0 && S.t < s.t1);
    // two at once: the louder voice wins the direction, and that changes
    // every half second or so
    if (!S.dom || !on.includes(S.dom)) S.dom = on[Math.floor(S.rnd() * on.length)];
    else if (on.length > 1 && S.rnd() < 0.02) S.dom = on[(on.indexOf(S.dom) + 1) % on.length];
    const g = Math.sqrt(-2 * Math.log(S.rnd() + 1e-9)) * Math.cos(2 * Math.PI * S.rnd());
    const off = S.rnd() < 0.04 ? (S.rnd() - 0.5) * 140 : g * 6;
    // the mic array turns with the body; the speech service adds the body
    // angle, so the direction is in room coordinates
    S.doa = Math.round(wrap(sourceDeg(S, S.dom.who) + off));
    if (!S.utter) S.utter = { t0: S.t, samples: [], parts: [], eos: 0, final: 0 };
    for (const s of on) if (!S.utter.parts.includes(s)) S.utter.parts.push(s);
    if (S.t % SAMPLE_MS < TICK) {
      S.utter.samples.push(S.doa);
      S.hist.push({ deg: S.doa, t: S.t });
      estimate(S);
    }
    for (const s of on) {
      let lastWave = null;
      for (const w of S.waves) if (w.who === s.who) lastWave = w;
      if (!lastWave || S.t - lastWave.t0 >= 300) S.waves.push({ who: s.who, t0: S.t });
    }
  } else {
    S.doa = null;
    S.dom = null;
    const u = S.utter;
    if (u && !u.eos) u.eos = S.t + 300; // end of speech
    if (u && u.eos && S.t >= u.eos && !u.final) u.final = S.t + 600; // final transcript (sample delay)
    if (u && u.final && S.t >= u.final) decide(S);
  }
  while (S.waves.length && S.t - S.waves[0].t0 >= 1000) S.waves.shift();
  while (S.hist.length && S.t - S.hist[0].t >= 4000) S.hist.shift();

  // seeing: faces in view every 100 ms
  if (S.t >= S.nextFace) {
    S.nextFace += 100;
    for (const k of S.kids) {
      if (!inView(S, k.deg)) continue;
      let p = S.people.find((q) => q.kid === k.id);
      if (!p) {
        const g = S.people.find((q) => q.ghost && Math.abs(wrap(q.deg - k.deg)) <= JOIN_DEG);
        if (g) {
          // the face joins the voice-only person; engagement starts at 0
          g.ghost = false; g.kid = k.id; g.joined = S.t;
          for (let i = 0; i < 20; i++) k.yawHist.push(k.head);
          p = g;
          S.joined = { t: S.t, kid: k, off: Math.abs(wrap(g.deg - k.deg)) };
          note(S, `The camera finds ${k.name}’s face ${Math.round(S.joined.off)}° from the voice-only person, inside 25°. The face joins it.`, 'is-good');
        } else p = addPerson(S, k);
      }
      p.deg = k.deg; p.d = k.d;
      k.yawHist.push(k.head);
      if (k.yawHist.length > 20) k.yawHist.shift();
    }
  }

  // engagement every 500 ms
  if (S.t >= S.nextEng) {
    S.nextEng += 500;
    for (const p of S.people) {
      if (p.ghost) continue;
      const k = kidOf(S, p.kid);
      const talking = S.sources.some((s) => s.who === k.id && S.t >= s.t0 && S.t < s.t1);
      if (!speaking(S) || !talking) p.eng.resp *= p.eng.decay;
      const mean = k.yawHist.reduce((a, b) => a + b, 0) / (k.yawHist.length || 1);
      p.eng.gaze = 0.5 * p.eng.gaze + 0.5 * (Math.abs(mean) < GAZE_DEG ? 1 : 0);
      p.eng.level = clamp(p.eng.resp + 0.65 * p.eng.gaze, 0, 1);
    }
  }

  // voice-only people fade: to 0.15 in 1 s, or in 3 s while the robot talks or turns
  for (const p of S.people) {
    if (!p.ghost) continue;
    const T = speaking(S) || turning(S) ? 3000 : 1000;
    p.conf = Math.exp((S.t - p.born) * Math.log(0.15) / T);
    p.slow = T > 1000;
  }
  const gone = S.people.filter((p) => p.ghost && p.conf < 0.15);
  if (gone.length) {
    S.people = S.people.filter((p) => !gone.includes(p));
    note(S, 'The voice-only person’s confidence is under 0.15, so it is removed.');
  }
}

/* ------------------------------------------------------------ geometry */

/** Growable float buffer. Writes go straight into the array: no garbage. */
function fbuf(n) {
  let a = new Float32Array(n), i = 0;
  const F = {
    get n() { return i; }, get data() { return a; },
    reset() { i = 0; },
    /** Make room for k more floats; returns the array to write into at F.n. */
    room(k) {
      if (i + k > a.length) {
        let m = a.length * 2;
        while (m < i + k) m *= 2;
        const b = new Float32Array(m);
        b.set(a.subarray(0, i));
        a = b;
      }
      return a;
    },
    adv(k) { i += k; },
    /** One triangle vertex: position, normal, rgba (rgb means alpha 1). */
    v(p, nn, c) {
      const d = F.room(10);
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = nn[0]; d[i + 4] = nn[1]; d[i + 5] = nn[2];
      d[i + 6] = c[0]; d[i + 7] = c[1]; d[i + 8] = c[2]; d[i + 9] = c.length > 3 ? c[3] : 1;
      i += 10;
    },
    /** One line (k 0) or dot (k 1) instance. */
    l(p, q, c, w, k) {
      const d = F.room(12);
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = q[0]; d[i + 4] = q[1]; d[i + 5] = q[2];
      d[i + 6] = c[0]; d[i + 7] = c[1]; d[i + 8] = c[2]; d[i + 9] = c[3]; d[i + 10] = w; d[i + 11] = k;
      i += 12;
    },
  };
  return F;
}

/** Scene builder: triangles (pos, normal, rgba) and lines/dots (instances). */
function builder() {
  const solid = fbuf(1 << 17), glass = fbuf(1 << 15), lines = fbuf(1 << 14);
  const B = {
    solid, glass, lines,
    reset() { solid.reset(); glass.reset(); lines.reset(); },
    tri(buf, a, b, c, na, nb, nc, ca, cb = ca, cc = ca) { buf.v(a, na, ca); buf.v(b, nb, cb); buf.v(c, nc, cc); },
    line(a, b, col, w) { lines.l(a, b, col, w, 0); },
    dot(a, col, w) { lines.l(a, a, col, w, 1); },
    poly(pts, col, w, closed = false) {
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) B.line(pts[i], pts[(i + 1) % pts.length], col, w);
    },
    /** Surface of revolution around the y axis at c. prof: [[r, y], …] bottom up. */
    lathe(buf, c, prof, col, seg = 20) {
      const N0 = prof.map((p, i) => {
        const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
        const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1;
        return [dy / l, -dr / l]; // outward normal in (r, y)
      });
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * 2 * Math.PI, a1 = ((s + 1) / seg) * 2 * Math.PI;
        for (let i = 0; i < prof.length - 1; i++) {
          const P = (k, a) => [c[0] + Math.sin(a) * prof[k][0], c[1] + prof[k][1], c[2] + Math.cos(a) * prof[k][0]];
          const Nn = (k, a) => [Math.sin(a) * N0[k][0], N0[k][1], Math.cos(a) * N0[k][0]];
          B.tri(buf, P(i, a0), P(i, a1), P(i + 1, a1), Nn(i, a0), Nn(i, a1), Nn(i + 1, a1), col);
          B.tri(buf, P(i, a0), P(i + 1, a1), P(i + 1, a0), Nn(i, a0), Nn(i + 1, a1), Nn(i + 1, a0), col);
        }
      }
    },
    sphere(buf, c, r, col, seg = 14) {
      const prof = [];
      const n = Math.ceil(seg / 2);
      for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; prof.push([Math.cos(a) * r, Math.sin(a) * r]); }
      B.lathe(buf, c, prof, col, seg);
    },
    /** Box centred at c, turned by yaw (radians) about y. */
    box(buf, c, size, yaw, col) {
      const [sx, sy, sz] = size.map((v) => v / 2), cs = Math.cos(yaw), sn = Math.sin(yaw);
      const R = (v) => [c[0] + v[0] * cs + v[2] * sn, c[1] + v[1], c[2] - v[0] * sn + v[2] * cs];
      const Rn = (v) => [v[0] * cs + v[2] * sn, v[1], -v[0] * sn + v[2] * cs];
      const F = [[[1, 0, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, -1]], [[0, 1, 0], [1, 0, 0]], [[0, -1, 0], [1, 0, 0]], [[0, 0, 1], [-1, 0, 0]], [[0, 0, -1], [1, 0, 0]]];
      for (const [n, u] of F) {
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => R([0, 1, 2].map((k) => (n[k] + u[k] * i + v[k] * j) * [sx, sy, sz][k])));
        const nn = Rn(n);
        B.tri(buf, q[0], q[1], q[2], nn, nn, nn, col);
        B.tri(buf, q[0], q[2], q[3], nn, nn, nn, col);
      }
    },
    /** Flat sector on the floor: angles in degrees, radii r0..r1, alpha fades out. */
    wedge(c, a0, a1, r0, r1, col, y = 0.004) {
      const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 3)), Z = [0, 0, 0];
      const fade = [...col.slice(0, 3), col[3] * 0.25];
      for (let i = 0; i < n; i++) {
        const p = (a, r) => [c[0] + Math.sin(a * DEG) * r, y, c[2] + Math.cos(a * DEG) * r];
        const u = a0 + ((a1 - a0) * i) / n, v = a0 + ((a1 - a0) * (i + 1)) / n;
        B.tri(glass, p(u, r0), p(v, r0), p(v, r1), Z, Z, Z, col, col, fade);
        B.tri(glass, p(u, r0), p(v, r1), p(u, r1), Z, Z, Z, col, fade, fade);
      }
    },
    ring(c, r, col, w, n = 72) {
      const a = [0, c[1], 0], b = [0, c[1], 0];
      for (let i = 0; i < n; i++) {
        const t0 = (i / n) * 2 * Math.PI, t1 = ((i + 1) / n) * 2 * Math.PI;
        a[0] = c[0] + Math.sin(t0) * r; a[2] = c[2] + Math.cos(t0) * r;
        b[0] = c[0] + Math.sin(t1) * r; b[2] = c[2] + Math.cos(t1) * r;
        lines.l(a, b, col, w, 0);
      }
    },
  };
  return B;
}

/* ------------------------------------------------------------ children */

/* Toy children: classic toy figures built from the parts of the LDraw
   parts library (CC BY 4.0): a round head with a printed face (no stud on
   top), moulded hair or a cap, the tapered torso, arms with C-shaped hands,
   the hips and two legs, seated (the legs turned 90° at the hip axle).
   Each part is scaled on its own to the proportions of a real 8-year-old,
   so the children are true to size next to the robot (0.39 m): head and
   hair about 0.20 m, a hand about 0.07 m across, shoulders about 0.27 m,
   legs 0.47 m from the hip axle to the sole. The scaled parts of one
   reference child are in kids.bin, next to the robot's model; each child is
   that child scaled so the top of its hair (seated) is at the height below
   (m). Forward is +z; the origin is on the ground under the hips. The face
   is printed on the head: eyes that blink, and a mouth that opens while
   the child talks.

   kids.bin: "KIDS", a uint32 n, n bytes of JSON (sizes, and per part its
   vertex and index counts, and the byte offset and length of two meshopt
   streams), then the streams. Vertices: 12 bytes each, int16 x, y, z
   (× q m), 2 spare bytes, int8 normal x, y, z (× 1/127), 1 spare byte.
   Indices: uint16 triangles. */
const SIZES = { leo: 0.69, ava: 0.67, sam: 0.66 };
const LOOKS = {
  ava: { age: 8, size: 'ava', skin: '#f3c9a8', hair: '#b4471f', shirt: '#f2c23f', pants: '#3f5bb0', shoe: '#2f2f3a', style: 'buns' },
  leo: { age: 8, size: 'leo', skin: '#7a4a30', hair: '#1d1b1a', shirt: '#37a463', pants: '#3a4560', shoe: '#e8e6e0', style: 'short', glasses: true },
  sam: { age: 8, size: 'sam', skin: '#d9a27a', hair: '#5b3a22', cap: '#d8433b', shirt: '#3f8fd6', pants: '#6a5890', shoe: '#2f2f3a', style: 'cap' },
};
const LOOKS_LIN = Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([n, c]) => [n, typeof c === 'string' && c[0] === '#' ? srgbHex(c) : c]))]));
let PARTS = null, DIMS = null; // set by loadKids
/** Load the children's parts; set each child's sizes (m). */
async function loadKids(url, meshopt) {
  if (PARTS) return;
  const buf = await (await fetch(url)).arrayBuffer(), dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x5344494b) throw new Error('kids.bin: not a parts file');
  const n = dv.getUint32(4, true), base = 8 + n;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n)));
  const parts = {};
  for (const m of meta.meshes) {
    const pos = new Float32Array(m.nv * 3), nrm = new Float32Array(m.nv * 3);
    const v = new DataView(meshopt(new Uint8Array(buf, base + m.v[0], m.v[1]), m.nv, 12, 'ATTRIBUTES').buffer);
    for (let i = 0; i < m.nv; i++) for (let c = 0; c < 3; c++) {
      pos[i * 3 + c] = v.getInt16(i * 12 + c * 2, true) * meta.q;
      nrm[i * 3 + c] = v.getInt8(i * 12 + 8 + c) / 127;
    }
    parts[m.name] = { pos, nrm, ix: new Uint16Array(meshopt(new Uint8Array(buf, base + m.i[0], m.i[1]), m.ni, 2, 'TRIANGLES').buffer) };
  }
  DIMS = Object.fromEntries(Object.entries(SIZES).map(([id, sit]) => {
    const s = sit / (meta.headBase + meta[`top_${LOOKS[id].style}`]);
    return [id, { sit, s, headY: meta.headBase * s, hh: meta.hh * s, R: meta.R * s, eye: meta.eye, mouth: meta.mouth }];
  }));
  PARTS = parts;
}
const dimsOf = (id) => DIMS[(LOOKS[id] || LOOKS.ava).size];
/** Heights of a seated child's face centre and mouth (for sound and taps). */
const kidFace = (id) => { const d = dimsOf(id); return { face: d.headY + d.hh * 0.5, mouth: d.headY + d.hh * d.mouth, top: d.sit }; };
const GLOSS = 2; // normals this long mark glossy plastic for the shader

const q2m = (t, q, s = [1, 1, 1]) => {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const mm = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const qy = (deg) => [0, Math.sin(deg * DEG / 2), 0, Math.cos(deg * DEG / 2)];
const qx = (deg) => [Math.sin(deg * DEG / 2), 0, 0, Math.cos(deg * DEG / 2)];
const I4 = q2m([0, 0, 0], [0, 0, 0, 1]);
const ptM = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
const nM = (M, n, g = 1) => [0, 1, 2].map((k) => (M[k] * n[0] + M[4 + k] * n[1] + M[8 + k] * n[2]) * g);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };

/** A box in frame M: centre c and size s in that frame, flat normals. */
function cube(B, buf, M, c, s, col, g = GLOSS) {
  const h = s.map((v) => v / 2);
  const F = [[[1, 0, 0], [0, 0, -1]], [[-1, 0, 0], [0, 0, 1]], [[0, 1, 0], [1, 0, 0]], [[0, -1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 0]], [[0, 0, -1], [-1, 0, 0]]];
  for (const [n, u] of F) {
    const v = cross3(n, u);
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => ptM(M, [0, 1, 2].map((k) => c[k] + (n[k] + u[k] * i + v[k] * j) * h[k])));
    const N = nM(M, n, g);
    B.tri(buf, q[0], q[1], q[2], N, N, N, col);
    B.tri(buf, q[0], q[2], q[3], N, N, N, col);
  }
}
/** Surface of revolution about frame M's y axis. prof: [[r, y], …] with the
    outside on the right going up; a0..a1: the arc (radians, 0 = +z). */
function rev(B, buf, M, prof, col, { seg = 20, a0 = 0, a1 = 2 * Math.PI, g = GLOSS } = {}) {
  const N0 = prof.map((p, i) => {
    const a = prof[Math.max(0, i - 1)], b = prof[Math.min(prof.length - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l];
  });
  const P = (k, a) => ptM(M, [Math.sin(a) * prof[k][0], prof[k][1], Math.cos(a) * prof[k][0]]);
  const Nn = (k, a) => nM(M, [Math.sin(a) * N0[k][0], N0[k][1], Math.cos(a) * N0[k][0]], g);
  for (let s = 0; s < seg; s++) {
    const u = a0 + ((a1 - a0) * s) / seg, v = a0 + ((a1 - a0) * (s + 1)) / seg;
    for (let i = 0; i < prof.length - 1; i++) {
      B.tri(buf, P(i, u), P(i, v), P(i + 1, v), Nn(i, u), Nn(i, v), Nn(i + 1, v), col);
      B.tri(buf, P(i, u), P(i + 1, v), P(i + 1, u), Nn(i, u), Nn(i + 1, v), Nn(i + 1, u), col);
    }
  }
}
function ball(B, buf, M, c, r, col, seg = 10, g = GLOSS) {
  const prof = [];
  for (let i = 0; i <= seg / 2; i++) { const a = -Math.PI / 2 + (i / (seg / 2)) * Math.PI; prof.push([Math.cos(a) * r, Math.sin(a) * r]); }
  rev(B, buf, mm(M, q2m(c, [0, 0, 0, 1])), prof, col, { seg, g });
}
/** A round rod from a to b (radius ra to rb), in frame M. */
function rod(B, buf, M, a, b, ra, rb, col, seg = 12, g = GLOSS) {
  const z = norm3(sub3(b, a)), x = norm3(cross3(Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], z)), y = cross3(z, x);
  for (let s = 0; s < seg; s++) {
    const d = (k) => { const t = (k / seg) * 2 * Math.PI; return [0, 1, 2].map((i) => x[i] * Math.cos(t) + y[i] * Math.sin(t)); };
    const d0 = d(s), d1 = d(s + 1);
    const p = (o, dd, r) => ptM(M, [0, 1, 2].map((i) => o[i] + dd[i] * r));
    const n0 = nM(M, d0, g), n1 = nM(M, d1, g);
    B.tri(buf, p(a, d0, ra), p(a, d1, ra), p(b, d1, rb), n0, n1, n1, col);
    B.tri(buf, p(a, d0, ra), p(b, d1, rb), p(b, d0, rb), n0, n1, n0, col);
  }
}
/* 2D shapes for the printed face: lists of [x, y] triangles. */
function ellipse2(cx, cy, rx, ry, n = 14) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, b = ((i + 1) / n) * 2 * Math.PI;
    t.push([cx, cy], [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry], [cx + Math.cos(b) * rx, cy + Math.sin(b) * ry]);
  }
  return t;
}
function band2(pts, w, closed = false) {
  const t = [];
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * w / 2, ny = (dx / l) * w / 2;
    t.push([a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] + nx, a[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]);
  }
  return t;
}
const arc2 = (cx, cy, r, a0, a1, n = 10) => Array.from({ length: n + 1 }, (_, i) => { const a = (a0 + ((a1 - a0) * i) / n) * DEG; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
/** Print 2D triangles on the front of the head cylinder (radius R) in frame H. */
function print(B, buf, H, tris, col, R, lift = 0.0015) {
  const map = ([x, y]) => { const z = Math.sqrt(Math.max(R * R - x * x, 0)); return [ptM(H, [x, y, z + lift]), nM(H, [x / R, 0, z / R], GLOSS)]; };
  for (let i = 0; i < tris.length; i += 3) {
    const [a, na] = map(tris[i]), [b, nb] = map(tris[i + 1]), [c, nc] = map(tris[i + 2]);
    B.tri(buf, a, b, c, na, nb, nc, col);
  }
}

/** One part, scaled by s, in colour col, into buf (gloss g: normal length). */
function part(buf, name, s, col, g) {
  const { pos, nrm, ix } = PARTS[name], n = ix.length * 10, d = buf.room(n), a = col.length > 3 ? col[3] : 1;
  let j = buf.n;
  for (let i = 0; i < ix.length; i++, j += 10) {
    const k = ix[i] * 3;
    d[j] = pos[k] * s; d[j + 1] = pos[k + 1] * s; d[j + 2] = pos[k + 2] * s;
    d[j + 3] = nrm[k] * g; d[j + 4] = nrm[k + 1] * g; d[j + 5] = nrm[k + 2] * g;
    d[j + 6] = col[0]; d[j + 7] = col[1]; d[j + 8] = col[2]; d[j + 9] = a;
  }
  buf.adv(n);
}
/** One side of a two-sided part (side −1 or +1 on x), scaled by s. */
function partSide(buf, name, s, col, g, side) {
  const { pos, nrm, ix } = PARTS[name], a = col.length > 3 ? col[3] : 1, keep = [];
  for (let i = 0; i < ix.length; i += 3) if ((pos[ix[i] * 3] + pos[ix[i + 1] * 3] + pos[ix[i + 2] * 3]) * side > 0) keep.push(i);
  const d = buf.room(keep.length * 30);
  let j = buf.n;
  for (const t of keep) for (let v = 0; v < 3; v++, j += 10) {
    const k = ix[t + v] * 3;
    d[j] = pos[k] * s; d[j + 1] = pos[k + 1] * s; d[j + 2] = pos[k + 2] * s;
    d[j + 3] = nrm[k] * g; d[j + 4] = nrm[k + 1] * g; d[j + 5] = nrm[k + 2] * g;
    d[j + 6] = col[0]; d[j + 7] = col[1]; d[j + 8] = col[2]; d[j + 9] = a;
  }
  buf.adv(keep.length * 30);
}
/** The shoulder pivot of one arm (side −1 or +1), from the top of the arm part. */
function shoulder(s, side) {
  const { pos } = PARTS.arms;
  let top = -1e9;
  for (let k = 0; k < pos.length; k += 3) if (pos[k] * side > 0) top = Math.max(top, pos[k + 1]);
  let x = 0, y = 0, z = 0, n = 0;
  for (let k = 0; k < pos.length; k += 3) if (pos[k] * side > 0 && pos[k + 1] > top - 0.02 / s) { x += pos[k]; y += pos[k + 1]; z += pos[k + 2]; n++; }
  return [(x / n) * s, (y / n) * s - 0.02, (z / n) * s];
}
/** One arm with its hand, in the child's own frame. */
function kidArm(buf, L, g, side) {
  const s = DIMS[L.size].s;
  partSide(buf, 'arms', s, L.shirt, g, side); partSide(buf, 'hands', s, L.skin, g, side);
}
/** The body below the head, in the child's own frame (origin on the ground
    under the hips), seated. */
function kidBody(buf, L, g) {
  const s = DIMS[L.size].s;
  part(buf, 'legs', s, L.pants, g); part(buf, 'feet', s, L.shoe, g); part(buf, 'hips', s, L.pants, g);
  part(buf, 'torso', s, L.shirt, g);
}
/** The head and its hair or cap, in the head's frame (origin at the base of the head). */
function kidShell(buf, L, g) {
  const s = DIMS[L.size].s;
  part(buf, 'head', s, L.skin, g);
  if (L.style === 'cap') { part(buf, 'hair_cap', s, L.cap, g); part(buf, 'hair_capHair', s, L.hair, g); }
  else part(buf, `hair_${L.style}`, s, L.hair, g);
}
/** The printed face on the head's front, in the head's frame. mouth: 0
    shut, 1–3 open. */
function kidPrint(B, buf, L, mouth, blink) {
  const d = DIMS[L.size], HD = I4, R = d.R, k = R / 0.08;
  // two oval eyes with a light spot, a smile
  const ink = [0.03, 0.03, 0.04], ey = d.eye * d.hh, ex = 0.32 * R;
  for (const sx of [-1, 1]) {
    print(B, buf, HD, ellipse2(sx * ex, ey, 0.075 * R, blink ? 0.018 * R : 0.11 * R), ink, R);
    if (!blink) print(B, buf, HD, ellipse2(sx * ex + 0.025 * R, ey + 0.04 * R, 0.028 * R, 0.028 * R, 8), [0.95, 0.95, 0.93], R, 0.0025);
    if (L.glasses) print(B, buf, HD, band2(arc2(sx * ex, ey, 0.2 * R, 0, 360, 16), 0.035 * R, true), ink, R, 0.002);
  }
  if (L.glasses) print(B, buf, HD, band2([[-0.12 * R, ey + 0.03 * R], [0.12 * R, ey + 0.03 * R]], 0.035 * R), ink, R, 0.002);
  const my = d.mouth * d.hh;
  if (mouth) {
    const dd = (0.006 + 0.0055 * mouth) * k, tr = [];
    const rim = arc2(0, 0, 1, 180, 360, 12).map(([x, y]) => [x * 0.3 * R, my + 0.004 + y * dd]);
    for (let i = 0; i < rim.length - 1; i++) tr.push([0, my + 0.004], rim[i], rim[i + 1]);
    print(B, buf, HD, tr, [0.28, 0.05, 0.07], R);
  } else {
    print(B, buf, HD, band2(arc2(0, my + 0.3 * R, 0.33 * R, 220, 320, 12), 0.05 * R), ink, R);
  }
}

/* Child meshes are built once per look (the face once per mouth and blink
   state), then copied into the frame's buffer with a transform. */
const meshes = new Map();
const SHOULDER = {};
const MB = builder();
function kidMesh(key, L, mouth, blink, face) {
  const g = face ? GLOSS : 1;
  const grab = (k, fn) => {
    if (!meshes.has(k)) { MB.solid.reset(); fn(); meshes.set(k, MB.solid.data.slice(0, MB.solid.n)); }
    return meshes.get(k);
  };
  return {
    body: grab(`${key}:body`, () => kidBody(MB.solid, L, g)),
    armR: grab(`${key}:armR`, () => kidArm(MB.solid, L, g, -1)),
    armL: grab(`${key}:armL`, () => kidArm(MB.solid, L, g, 1)),
    shell: grab(`${key}:shell`, () => kidShell(MB.solid, L, g)),
    face: face ? grab(`${key}:${mouth}:${blink ? 1 : 0}`, () => kidPrint(MB, MB.solid, L, mouth, blink)) : null,
  };
}
/* The radio: a toy transistor radio in the children's style. Its body is
   the blue of the figure's "radio" key; a cream grille, dark knobs, a warm
   dial, a silver handle and antenna. Built once per state (on: its lamp
   lights blue) in its own frame: x right, y up, +z the front. */
const RADIO_LOOK = Object.fromEntries(Object.entries({
  body: '#2f62c8', trim: '#24479a', grille: '#efe3c4', slat: '#c9b78f', knob: '#2b2a30',
  dial: '#f2cf78', needle: '#c8382e', metal: '#c9ced6', lampOn: '#9fd4ff', lampOff: '#3a4258',
}).map(([k, v]) => [k, srgbHex(v)]));
function radioMesh(on) {
  const k = `radio:${on ? 1 : 0}`;
  if (!meshes.has(k)) {
    const L = RADIO_LOOK, b = MB.solid;
    MB.solid.reset();
    cube(MB, b, I4, [0, 0.13, 0], [0.34, 0.2, 0.12], L.body);
    cube(MB, b, I4, [0, 0.235, 0], [0.32, 0.012, 0.11], L.trim); // top edge
    for (const x of [-0.13, 0.13]) for (const z of [-0.035, 0.035]) cube(MB, b, I4, [x, 0.015, z], [0.03, 0.03, 0.03], L.knob);
    // the speaker: a cream disc with slats
    rod(MB, b, I4, [-0.075, 0.13, 0.055], [-0.075, 0.13, 0.066], 0.068, 0.068, L.grille, 20, 1);
    for (const y of [-0.04, -0.02, 0, 0.02, 0.04]) {
      const w = 2 * Math.sqrt(0.06 ** 2 - y * y);
      cube(MB, b, I4, [-0.075, 0.13 + y, 0.067], [w, 0.006, 0.004], L.slat, 1);
    }
    // the dial with its needle, two knobs, the lamp
    cube(MB, b, I4, [0.085, 0.175, 0.062], [0.12, 0.045, 0.006], L.dial, 1);
    cube(MB, b, I4, [0.07, 0.175, 0.066], [0.005, 0.038, 0.003], L.needle, 1);
    for (const x of [0.055, 0.115]) rod(MB, b, I4, [x, 0.095, 0.058], [x, 0.095, 0.08], 0.019, 0.017, L.knob, 14);
    ball(MB, b, I4, [0.14, 0.215, 0.06], 0.008, on ? L.lampOn : L.lampOff, 8, on ? 0 : GLOSS);
    // the handle and the antenna
    for (const x of [-0.12, 0.12]) rod(MB, b, I4, [x, 0.24, 0], [x, 0.285, 0], 0.006, 0.006, L.metal, 8);
    rod(MB, b, I4, [-0.125, 0.285, 0], [0.125, 0.285, 0], 0.008, 0.008, L.metal, 10);
    rod(MB, b, I4, [0.15, 0.24, -0.04], [0.21, 0.4, -0.07], 0.005, 0.003, L.metal, 8);
    ball(MB, b, I4, [0.21, 0.4, -0.07], 0.007, L.metal, 8);
    meshes.set(k, MB.solid.data.slice(0, MB.solid.n));
  }
  return meshes.get(k);
}
/** Copy a cached mesh into dst through M; tint mixes the colour, over replaces it. */
function emit(dst, src, M, tint, over) {
  const n = src.length, d = dst.room(n);
  let j = dst.n;
  const [m0, m1, m2, , m4, m5, m6, , m8, m9, m10, , m12, m13, m14] = M;
  const ta = tint ? tint[3] : 0;
  for (let i = 0; i < n; i += 10, j += 10) {
    const x = src[i], y = src[i + 1], z = src[i + 2], a = src[i + 3], b = src[i + 4], c = src[i + 5];
    d[j] = m0 * x + m4 * y + m8 * z + m12; d[j + 1] = m1 * x + m5 * y + m9 * z + m13; d[j + 2] = m2 * x + m6 * y + m10 * z + m14;
    d[j + 3] = m0 * a + m4 * b + m8 * c; d[j + 4] = m1 * a + m5 * b + m9 * c; d[j + 5] = m2 * a + m6 * b + m10 * c;
    if (over) { d[j + 6] = over[0]; d[j + 7] = over[1]; d[j + 8] = over[2]; d[j + 9] = over[3]; continue; }
    d[j + 6] = src[i + 6] * (1 - ta) + (tint ? tint[0] * ta : 0);
    d[j + 7] = src[i + 7] * (1 - ta) + (tint ? tint[1] * ta : 0);
    d[j + 8] = src[i + 8] * (1 - ta) + (tint ? tint[2] * ta : 0);
    d[j + 9] = src[i + 9];
  }
  dst.adv(n);
}

/**
 * Draw one child. p: place on the ground; face: where the body faces
 * (degrees); look: colours (linear) or null for a see-through voice-only
 * person (ghost colour); headYaw: gaze (degrees, + turns to the child's
 * left); talk: mouth open 0..1; blink: eyes shut. Returns the face centre.
 */
function toyKid(buf, p, face, id, { headYaw = 0, talk = 0, blink = false, tint = null, ghost = null, arms = [0, 0] } = {}) {
  const mouth = talk > 0.05 ? 1 + Math.min(2, Math.floor(talk * 3)) : 0;
  const m = ghost ? kidMesh('ghost', LOOKS_LIN.ava, 0, false, false) : kidMesh(id, LOOKS_LIN[id], mouth, blink, true);
  const M = q2m(p, qy(face));
  emit(buf, m.body, M, tint, ghost);
  const sz = (LOOKS[ghost ? 'ava' : id] || LOOKS.ava).size, s = DIMS[sz].s;
  // arms swing forward about the shoulder (arms: degrees, right then left)
  for (const [i, side, mesh] of [[0, -1, m.armR], [1, 1, m.armL]]) {
    if (!arms[i]) { emit(buf, mesh, M, tint, ghost); continue; }
    const P = SHOULDER[`${sz}:${side}`] || (SHOULDER[`${sz}:${side}`] = shoulder(s, side));
    const A = mm(M, mm(q2m(P, qx(arms[i])), q2m([-P[0], -P[1], -P[2]], [0, 0, 0, 1])));
    emit(buf, mesh, A, tint, ghost);
  }
  const d = dimsOf(ghost ? 'ava' : id), HD = mm(M, q2m([0, d.headY, 0], qy(headYaw), [1, 1, 1]));
  const HN = talk > 0 ? mm(HD, q2m([0, 0, 0], qx(-3 * talk))) : HD; // a small nod while talking
  emit(buf, m.shell, HN, tint, ghost);
  if (m.face) emit(buf, m.face, HN, tint, ghost);
  return ptM(HN, [0, d.hh * 0.5, d.R]);
}

/* --------------------------------------------------------------- WebGPU */

const WGSL = /* wgsl */ `
struct U { vp: mat4x4f, eye: vec4f, size: vec4f, light: vec4f };
@group(0) @binding(0) var<uniform> u: U;

struct TOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) c: vec4f, @location(2) wp: vec3f };
@vertex fn vsTri(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> TOut {
  var o: TOut;
  o.pos = u.vp * vec4f(p, 1.0);
  o.n = n; o.c = c; o.wp = p;
  return o;
}
@fragment fn fsTri(i: TOut) -> @location(0) vec4f {
  if (dot(i.n, i.n) < 0.25) { return i.c; } // flat, unlit
  let N = normalize(i.n);
  let L = normalize(u.light.xyz);
  let V = normalize(u.eye.xyz - i.wp);
  let sky = mix(0.62, 1.0, N.y * 0.5 + 0.5);
  let key = max(dot(N, L), 0.0);
  let rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.12;
  // normals of length 2 mark toy plastic: a soft highlight from the key light
  let gl = clamp(length(i.n) - 1.0, 0.0, 1.0);
  let spec = pow(max(dot(N, normalize(L + V)), 0.0), 28.0) * 0.28 * gl;
  return vec4f(i.c.rgb * (0.55 * sky + 0.55 * key) + vec3f(rim + spec), i.c.a);
}

// Lines and dots are quads in screen space. Widths are CSS px (× dpr).
// uv: offset from the centre line (or dot centre) in device px; r: half width.
struct LOut { @builtin(position) pos: vec4f, @location(0) c: vec4f, @location(1) uv: vec2f, @location(2) @interpolate(flat) kr: vec2f };
@vertex fn vsLine(@builtin(vertex_index) vi: u32, @location(0) a: vec3f, @location(1) b: vec3f, @location(2) c: vec4f, @location(3) wk: vec2f) -> LOut {
  var Q = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let q = Q[vi];
  let half = u.size.xy * 0.5;
  let r = max(wk.x * u.size.z * 0.5, 0.5);
  let ca = u.vp * vec4f(a, 1.0);
  var o: LOut;
  o.c = c;
  o.kr = vec2f(wk.y, r);
  if (wk.y > 0.5) {
    let d = vec2f(q.x * 2.0 - 1.0, q.y) * (r + 1.0);
    o.pos = vec4f(ca.xy + d / half * ca.w, ca.z, ca.w);
    o.uv = d;
    return o;
  }
  let cb = u.vp * vec4f(b, 1.0);
  var d = cb.xy / cb.w * half - ca.xy / ca.w * half;
  if (dot(d, d) < 1e-8) { d = vec2f(1.0, 0.0); }
  d = normalize(d);
  let nrm = vec2f(-d.y, d.x);
  let base = select(ca, cb, q.x > 0.5);
  o.pos = vec4f(base.xy + nrm * q.y * (r + 1.0) / half * base.w, base.z, base.w);
  o.uv = vec2f(0.0, q.y * (r + 1.0));
  return o;
}
@fragment fn fsLine(i: LOut) -> @location(0) vec4f {
  let a = i.c.a * clamp(i.kr.y + 0.5 - length(i.uv), 0.0, 1.0);
  if (a <= 0.0) { discard; }
  return vec4f(i.c.rgb, a);
}`;

async function makeOverlay(getGPU) {
  const G = await getGPU();
  const { device } = G;
  const format = `${G.format}-srgb`;
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const mod = device.createShaderModule({ code: WGSL });
  const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
  const triBuf = { arrayStride: 40, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' }] };
  const lineBuf = {
    arrayStride: 48, stepMode: 'instance',
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' }, { shaderLocation: 3, offset: 40, format: 'float32x2' }],
  };
  const pipe = (vs, fs, buffers, write, bl) => device.createRenderPipeline({
    layout,
    vertex: { module: mod, entryPoint: vs, buffers },
    fragment: { module: mod, entryPoint: fs, targets: [{ format, ...(bl ? { blend: bl } : {}) }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: write, depthCompare: 'less-equal' },
    multisample: { count: 4 },
  });
  const P = {
    solid: pipe('vsTri', 'fsTri', [triBuf], true, null),
    glass: pipe('vsTri', 'fsTri', [triBuf], false, blend),
    lines: pipe('vsLine', 'fsLine', [lineBuf], false, blend),
  };
  const uniform = () => {
    const buf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { buf, bg: device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: buf } }] }) };
  };
  const U = { main: uniform(), cam: uniform() };
  const ub = new Float32Array(28);
  function setU(u, viewProj, eye, w, h, dpr) {
    ub.set(viewProj, 0);
    ub[16] = eye[0]; ub[17] = eye[1]; ub[18] = eye[2]; ub[19] = 1;
    ub[20] = w; ub[21] = h; ub[22] = dpr; ub[23] = 0;
    ub[24] = -0.45; ub[25] = 0.85; ub[26] = -0.3; ub[27] = 0;
    device.queue.writeBuffer(u.buf, 0, ub);
  }
  // vertex buffers are written only when the scene was rebuilt
  const vb = {};
  function upload(key, f, fresh) {
    const bytes = f.n * 4;
    if (!bytes) return null;
    if (!vb[key] || vb[key].size < bytes) {
      vb[key] = device.createBuffer({ size: Math.max(bytes, 65536) * 2, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      fresh = true;
    }
    if (fresh) device.queue.writeBuffer(vb[key], 0, f.data.buffer, 0, bytes);
    return vb[key];
  }
  return {
    draw(pass, cam, B, dpr, fresh) {
      setU(U.main, cam.viewProj, cam.eye, cam.w, cam.h, dpr);
      const s = upload('solid', B.solid, fresh), g = upload('glass', B.glass, fresh), l = upload('lines', B.lines, fresh);
      pass.setBindGroup(0, U.main.bg);
      if (s) { pass.setPipeline(P.solid); pass.setVertexBuffer(0, s); pass.draw(B.solid.n / 10); }
      if (g) { pass.setPipeline(P.glass); pass.setVertexBuffer(0, g); pass.draw(B.glass.n / 10); }
      if (l) { pass.setPipeline(P.lines); pass.setVertexBuffer(0, l); pass.draw(6, B.lines.n / 12); }
    },
    /** The solid shapes only (children, radio), for the robot's own camera.
        Call after draw(): it reuses the buffers draw() uploaded. */
    drawSolid(pass, cam, B) {
      if (!vb.solid || !B.solid.n) return;
      setU(U.cam, cam.viewProj, cam.eye, cam.w, cam.h, 1);
      pass.setBindGroup(0, U.cam.bg);
      pass.setPipeline(P.solid);
      pass.setVertexBuffer(0, vb.solid);
      pass.draw(B.solid.n / 10);
    },
  };
}

/* ------------------------------------------------------------- matrices */

const xf = (m, p) => {
  const [x, y, z, w = 1] = p;
  return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
};
/* ------------------------------------------------------------- the figure */

export function initWho3D(fig, app, { makeStage, lazy3D, getGPU, loadModel, tokenRGB, meshopt, P }) {
  /* Two views side by side: what the robot's camera sees (a second stage
     whose camera sits in the robot's head), and the room around it. */
  const camHost = h('div', { class: `${P}camview` });
  const boxes = h('canvas', { class: `${P}camboxes`, 'aria-hidden': 'true' });
  const subs = h('div', { class: `${P}subs`, 'aria-live': 'polite' });
  const camTag = h('span', { class: `${P}vtag` }, 'Robot’s view');
  camHost.append(boxes, camTag, subs);
  const view = h('div', { class: `${P}view ${P}room` });
  const labels = h('div', { class: `${P}labels`, 'aria-hidden': 'true' });
  view.append(labels, h('span', { class: `${P}vtag` }, 'Room view'));

  const playBtn = btn('▶ Play', () => setPlaying(!playing), { 'aria-pressed': 'false', class: `wv-btn ${P}wplay` });
  const scrub = h('input', { type: 'range', min: 0, max: END, step: 10, value: 0, 'aria-label': 'Time in the scenario' });
  const clock = h('output', { class: `${P}wtime` });
  // full screen: the whole figure, so the controls and the table come along
  const fsOn = () => document.fullscreenElement === fig || document.webkitFullscreenElement === fig;
  const fsBtn = btn('⛶ Full screen', () => {
    if (fsOn()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fig.requestFullscreen || fig.webkitRequestFullscreen)?.call(fig);
  }, { class: `wv-btn ${P}wfs`, 'aria-label': 'Full screen' });
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => {
    fsBtn.textContent = fsOn() ? '✕ Exit full screen' : '⛶ Full screen';
  });
  if (!(fig.requestFullscreen || fig.webkitRequestFullscreen)) fsBtn.hidden = true;
  scrub.addEventListener('input', () => { setPlaying(false); seek(+scrub.value); });
  const decideLine = h('div', { class: `wv-note ${P}decide`, 'aria-live': 'polite' });
  const tbody = h('tbody');
  const table = h('table', { class: `wv-table ${P}score` },
    h('thead', null, h('tr', null, h('th', null, 'person'), h('th', null, 'in cone'), h('th', null, 'score'), h('th', null, 'engagement'))), tbody);

  let S = newState(), stage = null, camStage = null, overlay = null, cam = null, camVP = null, colors = null;
  let playing = false, lastNow = -1;
  const B = builder();

  /* ---- time */
  function advanceTo(t) { while (S.t < t) tick(S); }
  function seek(ms) {
    ms = clamp(Math.round(ms / TICK) * TICK, 0, END);
    if (ms < S.t) { S = newState(); ver++; }
    advanceTo(ms);
    if (stage) { stage.rot.yaw = [0, S.robot.yaw * DEG, 0]; stage.face = faceOf(S); }
    paintText(true);
    kick();
  }
  function setPlaying(on) {
    if (on && S.t >= END) seek(0);
    playing = on;
    lastNow = -1;
    playBtn.textContent = on ? '❚❚ Pause' : S.t >= END ? '↻ Replay' : '▶ Play';
    playBtn.setAttribute('aria-pressed', String(on));
    if (on) kick();
  }
  function step(now) {
    if (lastNow < 0) lastNow = now;
    const dt = Math.min(now - lastNow, 100);
    lastNow = now;
    if (playing) {
      advanceTo(Math.min(END, S.t + dt));
      if (S.t >= END) { setPlaying(false); paintText(true); }
    }
    if (stage) { stage.rot.yaw = [0, S.robot.yaw * DEG, 0]; stage.face = faceOf(S); }
    paintText();
    // the stages draw only while the scenario plays (at most 30 fps)
    return playing;
  }

  /* ---- words: subtitles, the decision line, the table */
  let textAt = 0, subsHtml = '', lineText = '';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  function paintText(force = false) {
    const now = performance.now();
    if (!force && now - textAt < 200) return;
    textAt = now;
    scrub.value = String(S.t);
    clock.textContent = `${(S.t / 1000).toFixed(1)} / ${END / 1000} s`;
    // subtitles: who says what, kept 0.8 s after the words end
    const lines = [];
    for (const s of S.sources) {
      if (S.t < s.t0 || S.t > s.t1 + 800) continue;
      lines.push(`<span><b>${nameOf(s.who)}</b>${esc(s.text)}</span>`);
    }
    if (S.said && S.t >= S.said.t0 && S.t < S.said.t1 + 500) lines.push(`<span class="is-robot"><b>Robot</b>${esc(S.said.text)}</span>`);
    const sh = lines.slice(-2).join('<br>');
    if (sh !== subsHtml) { subsHtml = sh; subs.innerHTML = sh; }
    // one plain line of what the robot decides
    const msg = S.utter ? listening() : S.msg || { text: 'The robot listens.', cls: '' };
    if (msg.text + msg.cls !== lineText) {
      lineText = msg.text + msg.cls;
      decideLine.className = `wv-note ${P}decide ${msg.cls}`;
      decideLine.textContent = msg.text;
    }
    // score table: live while someone talks, else the last decision
    const sc = S.utter ? scoreAll(S, S.utter.samples) : S.last?.sc;
    const win = S.utter ? null : S.last?.winner;
    const who = (p) => (p.kid ? nameOf(p.kid) : `voice only ${fmtDeg(p.deg)}`);
    const rows = S.people.map((p) => {
      let r = sc?.rows.find((x) => x.p === p);
      if (!r && sc && p === win) r = sc.vo; // made by this decision
      const k = p.kid && kidOf(S, p.kid);
      return row([who(p), k && !inView(S, k.deg) ? h('small', null, 'out of view') : null], r ? `${r.n} / ${sc.N}` : '—', r ? r.score : null, p.ghost ? '—' : engCell(p.eng), p === win, p.ghost);
    });
    if (S.utter && sc.vo.score > 0) rows.push(row(`new voice only ${fmtDeg(sc.vo.deg)}`, `${sc.vo.n} / ${sc.N}`, sc.vo.score, '—', false, true));
    tbody.replaceChildren(...rows);
  }
  /* While someone talks: how many samples so far, and where most of them fall. */
  function listening() {
    const sc = scoreAll(S, S.utter.samples);
    let best = null;
    for (const r of sc.rows) if (r.n && (!best || r.n > best.n)) best = r;
    const where = sc.vo.n > (best?.n || 0) ? 'most outside every cone'
      : best ? `most in ${best.p.kid ? `${nameOf(best.p.kid)}’s` : 'the voice-only person’s'} cone` : '';
    return { text: `Listening: ${sc.N} samples${where ? `, ${where}` : ''}.`, cls: '' };
  }
  /* response and 0.65 × gaze, stacked, with a mark at the 0.5 line */
  function engCell(e) {
    const r = clamp(e.resp, 0, 1), g = clamp(0.65 * e.gaze, 0, 1 - r);
    return [
      h('span', { class: `${P}eng`, title: 'response + 0.65 × gaze' },
        h('i', { class: 'r', style: `width: ${(r * 100).toFixed(1)}%` }),
        h('i', { class: 'g', style: `left: ${(r * 100).toFixed(1)}%; width: ${(g * 100).toFixed(1)}%` }),
        h('b')),
      `${e.level.toFixed(2)}${e.level >= 0.5 ? ' ✓' : ''}`,
      h('small', null, `response ${e.resp.toFixed(2)} · gaze ${e.gaze.toFixed(2)}`),
    ];
  }
  function row(name, n, score, eng, win, gap) {
    const bar = h('span', { class: `${P}bar${gap ? ' is-gap' : ''}` }, h('i', { style: `width: ${Math.round(clamp(score ?? 0, 0, 1) * 100)}%` }));
    return h('tr', { class: win ? 'is-look' : '' }, h('td', null, ...[name].flat()), h('td', null, n),
      h('td', { class: `${P}sc` }, bar, score === null ? '—' : score.toFixed(2)), h('td', { class: `${P}sc` }, ...[eng].flat()));
  }

  /* ---- colours */
  function readColors() {
    const lin = (c) => c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    const t = (n) => lin(tokenRGB(fig, n));
    const mix = (a, b, k) => a.map((x, i) => x * (1 - k) + b[i] * k);
    const ink = t('--ink'), board = t('--board');
    const css = getComputedStyle(fig), tok = (n) => css.getPropertyValue(n).trim();
    colors = {
      ink, board, purple: t('--purple'), red: t('--red'), orange: t('--orange'), blue: t('--blue'), mix,
      dark: tokenRGB(fig, '--board').reduce((a, b) => a + b, 0) < 1.5,
      css: Object.fromEntries(['--ink', '--board', '--purple', '--orange', '--blue', '--red'].map((n) => [n.slice(2), tok(n)])),
    };
    colors.k = colors.dark ? 0.7 : 1; // see-through shapes: a little lighter on a dark page
    ver++;
    stage?.render();
    camStage?.render();
  }
  let ver = 0; // bumps when the scene must be rebuilt without a time step
  const rgba = (c, a) => [...c, a];

  /* The robot's camera: on the head, the head tilted up by NOD, turned with
     the body. */
  function camPose(yaw) {
    const piv = stage.piv.Camera || [0, 0.3456, 0.0643], hp = stage.piv.Helmet || [0, 0.2112, 0];
    const yawR = yaw * DEG, cn = Math.cos(NOD * DEG), sn = Math.sin(NOD * DEG);
    const ry = (v) => [Math.cos(yawR) * v[0] + Math.sin(yawR) * v[2], v[1], -Math.sin(yawR) * v[0] + Math.cos(yawR) * v[2]];
    const rel = [piv[0] - hp[0], piv[1] - hp[1], piv[2] - hp[2]];
    const camL = ry([rel[0], hp[1] + cn * rel[1] - sn * rel[2], sn * rel[1] + cn * rel[2]]);
    return { eye: [camL[0] + hp[0], camL[1], camL[2] + hp[2]], fwd: ry([0, -sn, cn]), up: ry([0, cn, sn]), rt: ry([1, 0, 0]) };
  }

  /* ---- the 3D scene (room view; the robot's view draws its solid part) */
  const bins = new Float32Array(72); // the direction ring: 5° bins
  function buildScene() {
    const C = colors;
    B.reset();
    const Z = [0, 0, 0];
    // in the garden, a pale disc under the drawings keeps them readable on the grass
    if (garden) {
      const n = 72;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
        const P0 = (a, r) => [Math.sin(a) * r, GY, Math.cos(a) * r];
        const c0 = rgba(C.board, C.dark ? 0.05 : 0.07), c1 = rgba(C.board, 0);
        B.tri(B.glass, [0, GY, 0], P0(a0, 1.2), P0(a1, 1.2), Z, Z, Z, c0, c0, c0);
        B.tri(B.glass, P0(a0, 1.2), P0(a0, 1.7), P0(a1, 1.7), Z, Z, Z, c0, c1, c1);
        B.tri(B.glass, P0(a0, 1.2), P0(a1, 1.7), P0(a1, 1.2), Z, Z, Z, c0, c1, c0);
      }
    }

    // the camera view: a see-through pyramid, 80° × 50°, 1.7 m long. Its
    // four faces are brightest at the robot and fade out with distance;
    // its edges are faint and fade the same way.
    const { eye: camP, fwd: fw, up: upv, rt } = camPose(S.robot.yaw);
    const L = 1.7, th = Math.tan((FOV_H / 2) * DEG), tv = Math.tan((FOV_V / 2) * DEG);
    const corner = (sx, sy) => [0, 1, 2].map((i) => camP[i] + (fw[i] + rt[i] * sx * th + upv[i] * sy * tv) * L);
    const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const WHITE = [1, 1, 1];
    {
      const Z = [0, 0, 0], near = rgba(WHITE, C.dark ? 0.06 : 0.07), far = rgba(WHITE, 0);
      for (let i = 0; i < 4; i++) B.tri(B.glass, camP, cs[i], cs[(i + 1) % 4], Z, Z, Z, near, far, far);
      const pt = (c, t) => [0, 1, 2].map((k) => camP[k] + (c[k] - camP[k]) * t);
      for (const c of cs) {
        for (let s = 0; s < 3; s++) B.line(pt(c, s / 3), pt(c, (s + 1) / 3), rgba(WHITE, [0.22, 0.1, 0.03][s]), 1);
      }
    }

    // the direction estimate: a soft wedge, as wide as its uncertainty
    const ea = estA(S), est = S.est;
    const lit = (p) => ea > 0.3 && !p.ghost && dist(est.deg, p.deg) <= MATCH;
    // match cones on the ground, one per person; the cone that holds the estimate fills
    for (const p of S.people) {
      const on = lit(p), col = p.ghost ? C.red : on ? C.mix(C.purple, WHITE, 0.35) : WHITE;
      const a = (p.ghost ? 0.22 * p.conf : on ? 0.4 : 0.12) * C.k;
      B.wedge([0, 0, 0], p.deg - MATCH_DEG, p.deg + MATCH_DEG, 0.3, 1.5, rgba(col, a), GY + 0.004);
      const la = p.ghost ? 0.7 * p.conf : on ? 1 : 0.7;
      for (const s of [-1, 1]) B.line(at(p.deg + s * MATCH_DEG, 0.3, GY + 0.005), at(p.deg + s * MATCH_DEG, 1.5, GY + 0.005), rgba(col, la), on ? 2 : 1.2);
    }
    if (ea > 0) softWedge(est.deg, est.half, 0.14, 1.5, C.orange, 0.7 * ea, GY + 0.008);

    // the direction ring: one bar per 5° bin, longer for more recent samples
    bins.fill(0);
    for (const s of S.hist) bins[((Math.round(wrap(s.deg) / 5) % 72) + 72) % 72] += Math.exp(-(S.t - s.t) / 1500);
    const R0 = 0.3;
    B.ring([0, GY + 0.009, 0], R0, rgba(WHITE, 0.75), 1, 96);
    for (let i = 0; i < 72; i++) {
      const w = bins[i];
      if (w < 0.03) continue;
      const deg = i * 5, len = 0.5 * (1 - Math.exp(-w / 2.5));
      const inCone = S.people.some((p) => !p.ghost && dist(deg, p.deg) <= MATCH);
      const a = clamp(0.35 + w * 0.3, 0, 0.95);
      B.wedge([0, 0, 0], deg - 2.2, deg + 2.2, R0 + 0.01, R0 + 0.01 + len, rgba(inCone ? C.mix(C.purple, WHITE, 0.35) : C.red, a), GY + 0.012);
    }

    // children
    for (const k of S.kids) {
      const p = kidPos(k);
      const face0 = Math.atan2(-p[0], -p[2]) / DEG;
      const src = S.sources.find((x) => x.who === k.id && S.t >= x.t0 && S.t < x.t1);
      const talkA = src ? 0.5 + 0.5 * Math.sin((S.t - src.t0) / 1000 * 2 * Math.PI * 4) : 0; // about 4 syllables a second
      const blink = (S.t + k.d * 2777) % 3900 < 130; // a blink every few seconds
      // hands move while the child talks: eased in and out, the two arms out of step
      const env = src ? clamp(Math.min(S.t - src.t0, src.t1 - S.t) / 350, 0, 1) : 0;
      const ph = (S.t / 1000) * 2 * Math.PI * 0.8 + k.deg * 0.1;
      const arms = env ? [-env * (10 + 8 * Math.sin(ph)), -env * (5 + 6 * Math.sin(ph * 1.3 + 2))] : [0, 0];
      k.hc = toyKid(B.solid, p, face0, k.id, { headYaw: k.head, talk: talkA, blink, arms });
    }
    // voice-only people: a see-through child at 1 m
    for (const p of S.people) {
      if (!p.ghost) continue;
      const q = at(p.deg, 1);
      toyKid(B.glass, q, Math.atan2(-q[0], -q[2]) / DEG, null, { ghost: rgba(C.red, 0.3 * p.conf) });
    }
    // a small radio on the grass, speaker toward the robot
    {
      const q = at(RADIO.deg, RADIO.d), ty = Math.atan2(-q[0], -q[2]) / DEG;
      const on = S.sources.some((x) => x.who === 'radio' && S.t >= x.t0 && S.t < x.t1);
      emit(B.solid, radioMesh(on), q2m(q, qy(ty)));
    }

    // sound: arcs that leave the mouth of whoever talks, toward the robot
    for (const w of S.waves) {
      const age = (S.t - w.t0) / 1000;
      const radio = w.who === 'radio';
      const src = radio ? at(RADIO.deg, RADIO.d, RADIO.mouth) : (() => { const p = kidPos(kidOf(S, w.who)); return [p[0], kidFace(w.who).mouth, p[2]]; })();
      const toward = Math.atan2(-src[0], -src[2]) / DEG;
      arc(src, 0.06 + age * 0.42, toward, 55, rgba(radio ? C.blue : C.orange, 0.85 * (1 - age)), 2);
    }
  }
  /** A flat wedge whose alpha falls off from its centre line to its edges and along r. */
  function softWedge(deg, half, r0, r1, col, a, y) {
    const n = 14, Z = [0, 0, 0];
    const p = (u, r) => [Math.sin(u * DEG) * r, y, Math.cos(u * DEG) * r];
    for (let i = 0; i < n; i++) {
      const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n;
      const k0 = (1 - u0 * u0) * a, k1 = (1 - u1 * u1) * a;
      const A = p(deg + u0 * half, r0), Bq = p(deg + u1 * half, r0), Cq = p(deg + u1 * half, r1), D = p(deg + u0 * half, r1);
      B.tri(B.glass, A, Bq, Cq, Z, Z, Z, rgba(col, k0), rgba(col, k1), rgba(col, k1 * 0.1));
      B.tri(B.glass, A, Cq, D, Z, Z, Z, rgba(col, k0), rgba(col, k1 * 0.1), rgba(col, k0 * 0.1));
    }
  }
  /** A horizontal arc of radius r around c, centred on `deg`, ±span degrees. */
  function arc(c, r, deg, span, col, w) {
    const n = 12;
    let a = null;
    for (let i = 0; i <= n; i++) {
      const u = (deg - span + (2 * span * i) / n) * DEG, b = [c[0] + Math.sin(u) * r, c[1], c[2] + Math.cos(u) * r];
      if (a) B.line(a, b, col, w);
      a = b;
    }
  }

  /* ---- labels in HTML (room view), placed each frame */
  const tags = {};
  function tag(id) {
    if (!tags[id]) { tags[id] = h('span', { class: `${P}rtag` }); labels.append(tags[id]); }
    return tags[id];
  }
  function project(p) {
    if (!cam) return null;
    const c = xf(cam.viewProj, p);
    if (c[3] <= 0) return null;
    return { x: (c[0] / c[3] * 0.5 + 0.5) * stage.w, y: (-c[1] / c[3] * 0.5 + 0.5) * stage.h };
  }
  let placed = [];
  function place(el, p, text, cls) {
    const s = project(p);
    if (!s) { el.hidden = true; return; }
    el.hidden = false;
    const c = `${P}rtag ${cls || ''}`;
    // measure only when the words or the style change: no layout each frame
    if (el.dataset.t !== text || el.dataset.c !== c) {
      el.innerHTML = text; el.dataset.t = text; el.className = c; el.dataset.c = c;
      el.classList.remove('has-lead');
      el.sz = [el.offsetWidth, el.offsetHeight];
    }
    placed.push({ el, x: s.x, y: s.y, w: el.sz[0], h: el.sz[1] });
  }
  /* Tags hang above their point. A tag that would cover another tag moves
     up (or to the side at the top edge), and a thin line leads back to its
     point. Nearer tags (lower on screen) go first. */
  function settle() {
    const box = [{ l: 0, t: 0, r: 96, b: 24 }], W = stage.w, Hh = stage.h; // the view's name, top left
    const hit = (r) => box.find((b) => r.l < b.r + 3 && r.r > b.l - 3 && r.t < b.b + 3 && r.b > b.t - 3);
    for (const t of placed.sort((a, b) => b.y - a.y)) {
      let x = clamp(t.x, t.w / 2 + 2, W - t.w / 2 - 2), y = clamp(t.y, t.h + 2, Hh);
      const R = () => ({ l: x - t.w / 2, r: x + t.w / 2, t: y - t.h, b: y });
      for (let n = 0, b; n < 8 && (b = hit(R())); n++) {
        if (b.t - 3 - t.h >= 0) y = b.t - 3;
        else x = clamp(t.x < (b.l + b.r) / 2 ? b.l - 3 - t.w / 2 : b.r + 3 + t.w / 2, t.w / 2 + 2, W - t.w / 2 - 2);
      }
      box.push(R());
      const dx = t.x - x, dy = Math.min(t.y, Hh) - y, lead = Math.hypot(dx, dy);
      t.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      t.el.classList.toggle('has-lead', dy > 0 && lead > 6); // a pseudo-element: the size does not change
      t.el.style.setProperty('--lead', `${lead.toFixed(1)}px`);
      t.el.style.setProperty('--ang', `${(-Math.atan2(dx, dy) / DEG).toFixed(1)}deg`);
    }
    placed = [];
  }
  function placeLabels() {
    const seen = new Set(), ea = estA(S);
    placed = [];
    for (const k of S.kids) {
      const p = kidPos(k);
      const person = S.people.find((q) => q.kid === k.id);
      const on = person && ea > 0.3 && dist(S.est.deg, person.deg) <= MATCH;
      const sub = !inView(S, k.deg) ? `<br><small>${person ? 'out of view' : 'not seen'}</small>` : '';
      place(tag(k.id), [p[0], kidFace(k.id).top + TAG_UP, p[2]], `<b>${k.name}</b>${sub}`, on ? 'is-on' : '');
      seen.add(k.id);
    }
    S.people.filter((p) => p.ghost).forEach((p, i) => {
      place(tag(`g${i}`), at(p.deg, 1, kidFace('ava').top + TAG_UP), `<b>voice only</b><br><small>${p.conf.toFixed(2)}</small>`, 'is-gap');
      seen.add(`g${i}`);
    });
    place(tag('radio'), at(RADIO.deg, RADIO.d, 0.42), '<b>radio</b>', 'is-radio');
    seen.add('radio');
    settle();
    for (const [id, el] of Object.entries(tags)) if (!seen.has(id)) el.hidden = true;
  }

  /* ---- the robot's view: face boxes, names and distances, and a strip of
     directions at the bottom (−40° … +40°) with the voice estimate on it.
     2D, drawn after the robot's camera draws. */
  let tagW = 0;
  function drawCamOverlay() {
    const W = camStage.w, H = camStage.h;
    if (!W || !camVP || !colors) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (boxes.width !== Math.round(W * dpr) || boxes.height !== Math.round(H * dpr)) {
      boxes.width = Math.round(W * dpr); boxes.height = Math.round(H * dpr);
      boxes.style.width = `${W}px`; boxes.style.height = `${H}px`;
    }
    const x = boxes.getContext('2d'), C = colors.css;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const scr = (p) => { const c = xf(camVP, p); return c[3] > 0 ? [(c[0] / c[3] * 0.5 + 0.5) * W, (-c[1] / c[3] * 0.5 + 0.5) * H] : null; };
    const ea = estA(S), yaw = S.robot.yaw, eyeY = camPose(yaw).eye[1];
    const xAt = (rel) => scr(at(yaw + rel, 3, eyeY - 3 * Math.tan(NOD * DEG)))?.[0] ?? W / 2;
    const small = W < 360;
    x.textBaseline = 'middle';
    x.textAlign = 'center';
    // faces: the box is the table's face width for that distance
    for (const k of S.kids) {
      if (!inView(S, k.deg) || !k.hc) continue;
      const s = scr(k.hc);
      if (!s) continue;
      const person = S.people.find((q) => q.kid === k.id);
      const on = person && ea > 0.3 && dist(S.est.deg, person.deg) <= MATCH;
      const fw = faceWidthAt(k.d) * W, [cx, cy] = s;
      x.lineWidth = on ? 3 : 1.6;
      x.strokeStyle = C.purple;
      x.strokeRect(cx - fw / 2, cy - fw / 2, fw, fw);
      // the name and distance above the box; the face width below it
      x.font = `700 ${small ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const t = `${k.name} · ${k.d.toFixed(1)} m`, tw = x.measureText(t).width + 8;
      const tx = clamp(cx, tw / 2 + 2, W - tw / 2 - 2);
      let ty = Math.max(9, cy - fw / 2 - 10), below = cy + fw / 2 + 10;
      // not under the view's name (top left): then the name goes below the box
      tagW ||= camTag.offsetWidth + 8;
      if (ty < 32 && tx - tw / 2 < tagW) { ty = below; below += 17; }
      x.fillStyle = on ? C.purple : C.board;
      x.fillRect(tx - tw / 2, ty - 8, tw, 16);
      if (!on) { x.lineWidth = 1; x.strokeRect(tx - tw / 2 + 0.5, ty - 7.5, tw - 1, 15); }
      x.fillStyle = on ? C.board : C.purple;
      x.fillText(t, tx, ty + 0.5);
      x.font = `600 ${small ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const fwT = `face ${(faceWidthAt(k.d) * 100).toFixed(0)}% wide`, ww = x.measureText(fwT).width + 6;
      x.globalAlpha = 0.85;
      x.fillStyle = C.board;
      x.fillRect(cx - ww / 2, below - 7, ww, 13);
      x.globalAlpha = 1;
      x.fillStyle = C.purple;
      x.fillText(fwT, cx, below);
    }
    // the strip of directions
    const sy = H - 16;
    x.globalAlpha = 0.82;
    x.fillStyle = C.board;
    x.fillRect(0, sy, W, 16);
    x.globalAlpha = 1;
    x.strokeStyle = C.ink;
    x.lineWidth = 1;
    for (let a = -40; a <= 40; a += 10) {
      const px = Math.round(xAt(a)) + 0.5;
      x.beginPath(); x.moveTo(px, sy); x.lineTo(px, sy + (a === 0 ? 7 : 4)); x.stroke();
    }
    if (ea > 0) {
      const rel = wrap(S.est.deg - yaw);
      x.globalAlpha = ea;
      if (Math.abs(rel) < FOV_H / 2) {
        // a soft bump as wide as the uncertainty, and a faint column up the view
        const x0 = xAt(clamp(rel - S.est.half, -44, 44)), x1 = xAt(clamp(rel + S.est.half, -44, 44)), xc = xAt(rel);
        const g = x.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, 'transparent'); g.addColorStop(0.5, C.orange); g.addColorStop(1, 'transparent');
        x.fillStyle = g;
        x.fillRect(Math.min(x0, x1), sy + 1, Math.abs(x1 - x0), 15);
        const col = x.createLinearGradient(0, sy, 0, sy - H * 0.45);
        col.addColorStop(0, C.orange); col.addColorStop(1, 'transparent');
        x.globalAlpha = ea * 0.28;
        x.fillStyle = col;
        x.fillRect(xc - 3, sy - H * 0.45, 6, H * 0.45);
        x.globalAlpha = ea;
        x.fillStyle = C.orange;
        x.fillRect(Math.round(xc) - 1, sy, 2, 16);
      } else {
        // outside the view: an arrow at the edge it is past
        const left = xAt(Math.sign(rel) * 30) < W / 2;
        x.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        x.textAlign = left ? 'left' : 'right';
        x.fillStyle = C.orange;
        x.fillText(left ? `◀ voice ${fmtDeg(rel)}` : `voice ${fmtDeg(rel)} ▶`, left ? 4 : W - 4, sy + 8);
      }
      x.globalAlpha = 1;
    }
  }

  /* ---- driver: the stage's frame loop, or our own without WebGPU */
  let raf = 0;
  function kick() {
    // the robot's view draws with the room view (stage.overlay marks it fresh)
    if (stage) { stage.render(); return; }
    // no 3D view: only the words change, about 30 times a second at most
    if (!raf) raf = requestAnimationFrame(function loop(now) { raf = 0; if (step(now)) raf = setTimeout(() => { raf = requestAnimationFrame(loop); }, 33); });
  }

  /* ---- dev only: print the measured heights of the robot and the children */
  async function scaleCheck() {
    const top = (a, y0 = 0) => { let m = -1; for (let i = 1; i < a.length; i += 10) m = Math.max(m, a[i]); return y0 + m; };
    const kids = KIDS.map((k) => { const m = kidMesh(k.id, LOOKS_LIN[k.id], 0, false, true); return `${k.name} ${Math.max(top(m.body), top(m.shell, dimsOf(k.id).headY)).toFixed(3)} m`; });
    // the robot: the model the stages already parsed (no second download)
    let robot = '?';
    try {
      const model = await loadModel(new URL(fig.dataset.model, document.baseURI).href);
      let y = -1;
      for (const p of model.parts) for (let i = 1; i < p.pos.length; i += 3) y = Math.max(y, p.pos[i]);
      robot = `${y.toFixed(3)} m`;
    } catch { /* no model */ }
    console.info(`[who] heights: robot ${robot}; seated children (top of hair): ${kids.join(', ')}`);
  }

  app.append(
    h('div', { class: `${P}wctl` }, playBtn, scrub, clock, fsBtn),
    h('div', { class: `${P}wgrid` }, view, camHost),
    decideLine,
    h('div', { class: `${P}tblwrap` }, table),
    colorKey([['k-pick', 'voice direction'], ['k-look', 'faces, their cones, samples in a cone'], ['k-gap', 'samples outside every cone, voice with no face'], ['k-opt', 'radio']]),
  );
  fig.__seek = (ms) => { setPlaying(false); seek(ms); }; // for screenshots
  seek(REDUCED ? STILL : 0);

  lazy3D(fig, view, async () => {
    try {
      overlay = await makeOverlay(getGPU);
      garden = fig.dataset.env === 'garden';
      GY = garden ? 0.035 : 0; // just over the short lawn by the robot
      const url = new URL(fig.dataset.model, document.baseURI).href;
      const kidsLoaded = loadKids(new URL('kids.bin', url), meshopt); // next to the robot's model
      // the room view: half as tall as wide. The eye stays low, so the
      // horizon shows, and on the baked lawn (reach: 6 m from the robot);
      // it never looks straight down (zoom: never so close that a child
      // leaves the frame)
      const room = { aspect: 0.5, orbit: { pitch: [0.05, 0.9], zoom: [0.6, 2], reach: 6 }, clear: { r: 1.7, y0: 0, y1: 0.8 } };
      // the scenery turns so the bay and the bridge lie behind the children
      const turn = 213 * DEG;
      stage = await makeStage(fig, view, url, garden ? { env: 'garden', envTurn: turn, ...room } : { far: 10, ...room });
      camStage = await makeStage(fig, camHost, url, { ...(garden ? { env: 'garden', envTurn: turn } : { far: 10 }), aspect: 9 / 16, parts: [] });
      await kidsLoaded;
    } catch (err) {
      camHost.hidden = true;
      throw err;
    }
    view.append(labels);
    stage.stopAuto();
    camStage.stopAuto();
    // the seated children and the radio shade the lawn (sun shadow and sky occlusion)
    // (three spheres each, as the lawn takes at most 11: hips, the legs (they
    // point at the robot), chest and head; the low ones also keep the grass
    // blades out from under the child)
    const blobs = [...KIDS.flatMap((k) => {
      const [x, , z] = kidPos(k), f = 1 - 0.3 / k.d;
      return [[x, 0.1, z, 0.19], [x * f, 0.03, z * f, 0.17], [x, 0.35, z, 0.16]];
    }),
      [...at(RADIO.deg, RADIO.d, 0.08), 0.08]];
    stage.blobs = camStage.blobs = () => blobs;
    readColors();
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { scaleCheck(); fig.__stage = stage; } // dev: for screenshots
    // a little wider than Fig. 1's lens: the children, the radio and the bay all fit
    stage.fov = 38 * DEG;
    stage.rot.head = [NOD * DEG, 0, 0];
    camStage.rot.head = [NOD * DEG, 0, 0];
    camStage.fov = FOV_V * DEG;
    // a low 3/4 view from the robot's side: the children face the viewer,
    // the radio is in view, the ring on the ground still reads, and the
    // bay and the bridge stand on the horizon behind them, as in Fig. 1
    // the room view keeps the far background sharp, so the bay and the bridge read
    stage.blur = 0.2;
    const fit = () => stage.aim({ yaw: -105 * DEG, pitch: 0.22, target: [0, 0.35, 0], dist: 3 }, true);
    fit();
    new ResizeObserver(() => fit()).observe(view);
    new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-force-dark', 'class'] });
    stage.tick = (now) => step(now);
    // rebuild the scene only when time moved or something else changed
    let built = '', camAt = '', camFresh = false;
    stage.overlay = (pass, c) => {
      if (!colors) return;
      cam = c;
      const key = `${S.t}|${ver}`;
      const fresh = key !== built;
      if (fresh) { buildScene(); built = key; }
      overlay.draw(pass, c, B, c.w / (stage.w || 1), fresh);
      if (fresh) camFresh = true;
    };
    // the robot's view draws in the same frame and the same queue submit
    stage.afterRender = () => {
      placeLabels();
      if (camFresh) { camFresh = false; camStage.renderNow(); }
    };
    stage.onPick = null;
    // the robot's view: its camera follows the robot's head
    camStage.overlay = (pass, c) => {
      if (!colors) return;
      camVP = c.viewProj;
      overlay.drawSolid(pass, c, B);
    };
    camStage.tick = () => {
      const key = `${S.robot.yaw.toFixed(2)}|${camStage.w}`;
      if (key === camAt) return false;
      camAt = key;
      camStage.rot.yaw = [0, S.robot.yaw * DEG, 0];
      const { eye, fwd } = camPose(S.robot.yaw);
      // the stage orbits a target: put the target 1 m ahead, the eye on the camera
      camStage.aim({ yaw: Math.atan2(-fwd[0], -fwd[2]), pitch: Math.asin(-fwd[1]), target: [eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]], dist: 1 }, true);
      return false;
    };
    camStage.afterRender = () => drawCamOverlay();
    stage.rot.yaw = [0, S.robot.yaw * DEG, 0];
    stage.face = faceOf(S);
    kick();
    if (!REDUCED) setPlaying(true);
  });
}

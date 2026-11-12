/*
 * The parts inside the robot's shell, for Fig. 1, as small low-poly models.
 *
 * The 3D model has only the outer shell, so these are stand-ins, not CAD:
 * sizes are typical for each kind of part, and places are plausible ones
 * inside the shell. Motors sit on the rig's joint axes. The motor that
 * swings an arm in and out sits inside the arm: its joint pivot lies in the
 * gap between the arm and the chest shells.
 *
 * Pure JS (no DOM), so a test can run it in Node:
 *
 *   buildInnards()           → [{ name, group, kind, pos, nrm, idx, inner }]
 *   ANCHOR[name]             → model-space point for callouts
 *   JOINTS                   → motor axes and ranges, for the Muscles view
 *   RIG[m](rot, deg)         → pose motor m of the stage's rig (one rig for all figures)
 *   makeEnclosure(shells)    → ray test against the shell meshes
 *   findLeaks(enc, parts)    → parts that are not at least 2 mm inside
 *
 * Units are metres, model space, rest pose (x left of the robot, y up,
 * z forward). Kinds are shader materials, see MAT.
 */

/* Materials (shader kind codes). */
export const MAT = {
  plastic: 5, // light plastic (connectors, servo horns)
  pcb: 6,     // green-black circuit board
  metal: 7,   // steel and aluminium
  chip: 8,    // black epoxy packages
  copper: 9,  // touch pads, mic cans
  glass: 10,  // lens glass
  led: 11,    // lit LEDs
  wrap: 12,   // battery wrap
  dark: 13,   // dark grey plastic (servo bodies, lens barrels)
  body: 3,    // projector housing (black)
  mirror: 14, // front-surface mirror
};

/* ------------------------------------------------------------ geometry */

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => mul(a, 1 / (Math.hypot(...a) || 1));
const clampv = (x, a, b) => Math.max(a, Math.min(b, x));

/** A frame: origin o, forward z, up y (made perpendicular to z), x = y × z. */
export function frame(o, z, y = [0, 1, 0]) {
  z = unit(z);
  y = unit(add(y, mul(z, -dot(y, z))));
  return { o, x: cross(y, z), y, z };
}
const toWorld = (F, p) => add(F.o, add(mul(F.x, p[0]), add(mul(F.y, p[1]), mul(F.z, p[2]))));
const dirWorld = (F, n) => add(mul(F.x, n[0]), add(mul(F.y, n[1]), mul(F.z, n[2])));

/** Box with rounded edges, centre c, full size s, radius r, in frame F. */
function box(F, c, s, r = 0) {
  const hs = s.map((v) => v / 2), rr = Math.min(r, ...hs), inner = hs.map((v) => v - rr);
  const axis = (k) => {
    const band = rr > 0 ? [0, 0.5, 1].map((t) => hs[k] - rr * t) : [hs[k]];
    return [...band.map((v) => -v), ...band.slice().reverse()];
  };
  const pos = [], nrm = [], idx = [];
  for (const [n, u, v] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) for (const sg of [-1, 1]) {
    const U = axis(u), V = axis(v), b = pos.length / 3;
    for (const a of U) for (const bb of V) {
      const q = [0, 0, 0];
      q[n] = sg * hs[n]; q[u] = a; q[v] = bb;
      const inn = q.map((x, k) => clampv(x, -inner[k], inner[k]));
      const d = q.map((x, k) => x - inn[k]), l = Math.hypot(...d);
      const nn = l > 1e-9 ? d.map((x) => x / l) : [0, 1, 2].map((k) => (k === n ? sg : 0));
      pos.push(...toWorld(F, add(c, inn.map((x, k) => x + nn[k] * rr))));
      nrm.push(...dirWorld(F, nn));
    }
    const nv = V.length;
    for (let i = 0; i + 1 < U.length; i++) for (let j = 0; j + 1 < nv; j++) {
      const p = b + i * nv + j;
      // wind each quad so it faces along +n
      if (sg > 0) idx.push(p, p + nv, p + nv + 1, p, p + nv + 1, p + 1);
      else idx.push(p, p + nv + 1, p + nv, p, p + 1, p + nv + 1);
    }
  }
  return { pos, nrm, idx };
}

/** Capped cylinder along the frame's z, base centre c, radius r, length h. */
function cyl(F, c, r, h, n = 18) {
  const pos = [], nrm = [], idx = [];
  const ring = (z, nz) => {
    const b = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, x = Math.cos(a), y = Math.sin(a);
      pos.push(...toWorld(F, [c[0] + x * r, c[1] + y * r, c[2] + z]));
      nrm.push(...dirWorld(F, nz === 0 ? [x, y, 0] : [0, 0, nz]));
    }
    return b;
  };
  const s0 = ring(0, 0), s1 = ring(h, 0);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(s0 + i, s0 + j, s1 + j, s0 + i, s1 + j, s1 + i); }
  for (const [z, nz] of [[0, -1], [h, 1]]) {
    const b = ring(z, nz), ci = pos.length / 3;
    pos.push(...toWorld(F, [c[0], c[1], c[2] + z])); nrm.push(...dirWorld(F, [0, 0, nz]));
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (nz > 0) idx.push(ci, b + i, b + j); else idx.push(ci, b + j, b + i); }
  }
  return { pos, nrm, idx };
}

/* --------------------------------------------------------------- parts */

// Each builder returns [[kind, geometry], …] in model space.
const camera = (F) => [
  [MAT.pcb, box(F, [0, 0, 0.0006], [0.014, 0.012, 0.0012], 0.0006)],
  [MAT.chip, box(F, [0, 0, 0.0032], [0.0085, 0.0085, 0.004], 0.0008)],
  [MAT.dark, cyl(F, [0, 0, 0.0052], 0.0032, 0.0034)],
  [MAT.metal, cyl(F, [0, 0, 0.0086], 0.0033, 0.0006)],
  [MAT.glass, cyl(F, [0, 0, 0.0086], 0.0023, 0.0009)],
];
/** A small projector engine: a block with the lens on its front end.
    F.z is the lens direction. */
const projector = (F) => [
  [MAT.body, box(F, [0, 0, 0], [0.034, 0.016, 0.032], 0.003)],
  [MAT.metal, box(F, [0, 0.0085, -0.002], [0.028, 0.001, 0.024], 0.0005)], // heat spreader on top
  [MAT.metal, cyl(F, [0, 0, 0.016], 0.0055, 0.006)],
  [MAT.glass, cyl(F, [0, 0, 0.0215], 0.0043, 0.0009)],
];
/** A flat front-surface mirror. F.z is its normal. */
const mirror = (F) => [
  [MAT.dark, box(F, [0, 0, -0.0009], [0.042, 0.034, 0.0014], 0.001)],
  [MAT.mirror, box(F, [0, 0, 0.00015], [0.04, 0.032, 0.0006], 0.0008)],
];
const micArray = (F) => {
  const out = [[MAT.pcb, box(F, [0, 0, 0], [0.05, 0.042, 0.0016], 0.002)], [MAT.chip, box(F, [0, 0, 0.0014], [0.009, 0.009, 0.0012], 0.0004)]];
  for (const [x, y] of [[-0.019, -0.015], [0.019, -0.015], [-0.019, 0.015], [0.019, 0.015]]) out.push([MAT.metal, cyl(F, [x, y, 0.0008], 0.0022, 0.0013, 12)]);
  return out;
};
const speaker = (F) => [
  [MAT.metal, cyl(F, [0, 0, 0], 0.009, 0.006)],
  [MAT.dark, cyl(F, [0, 0, 0.006], 0.016, 0.007, 24)],
  [MAT.chip, cyl(F, [0, 0, 0.013], 0.013, 0.0006, 24)],
];
const ledBar = (F) => {
  const out = [[MAT.pcb, box(F, [0, 0, 0], [0.038, 0.006, 0.0012], 0.0005)]];
  for (let i = -2; i <= 2; i++) out.push([MAT.led, box(F, [i * 0.007, 0, 0.0012], [0.0035, 0.0026, 0.0012], 0.0004)]);
  return out;
};
const mainBoard = (F) => [
  [MAT.pcb, box(F, [0, 0, 0], [0.09, 0.05, 0.0016], 0.002)],
  [MAT.chip, box(F, [-0.016, 0.004, 0.0016], [0.015, 0.015, 0.0016], 0.0005)], // SoC
  [MAT.chip, box(F, [0.005, 0.012, 0.0014], [0.012, 0.009, 0.0012], 0.0004)],  // RAM
  [MAT.chip, box(F, [0.005, -0.006, 0.0013], [0.011, 0.009, 0.001], 0.0004)],  // flash
  [MAT.metal, box(F, [0.029, 0.006, 0.0018], [0.014, 0.013, 0.002], 0.0004)],  // Wi-Fi can
  [MAT.plastic, box(F, [-0.036, -0.018, 0.0025], [0.012, 0.005, 0.0034], 0.0005)],
  [MAT.plastic, box(F, [0.03, -0.019, 0.0025], [0.016, 0.005, 0.0034], 0.0005)],
];
const motorBoard = (F) => [
  [MAT.pcb, box(F, [0, 0, 0], [0.07, 0.05, 0.0016], 0.002)],
  [MAT.chip, box(F, [-0.012, 0.002, 0.0014], [0.009, 0.009, 0.0012], 0.0004)],
  [MAT.plastic, box(F, [0.004, -0.019, 0.0024], [0.04, 0.005, 0.0032], 0.0005)],
  [MAT.plastic, box(F, [-0.027, 0.012, 0.0024], [0.006, 0.018, 0.0032], 0.0005)],
];
const imu = (F) => [[MAT.chip, box(F, [0, 0, 0.0005], [0.004, 0.004, 0.001], 0.0003)]];
const pad = (F) => [[MAT.copper, box(F, [0, 0, 0], [0.04, 0.022, 0.0008], 0.002)]];
const padB = (F) => [[MAT.copper, box(F, [0, 0, 0], [0.034, 0.022, 0.0008], 0.002)]];
const battery = (F) => [
  [MAT.wrap, box(F, [0, 0, 0], [0.056, 0.016, 0.028], 0.003)],
  [MAT.metal, box(F, [-0.0295, 0, 0], [0.003, 0.0145, 0.026], 0.001)],
  [MAT.metal, box(F, [0.0295, 0, 0], [0.003, 0.0145, 0.026], 0.001)],
];
/** A hobby-style servo. F.o is the output shaft at the horn, F.z the axis
    (body → horn), F.y the long side of the body. s scales it (arm motors
    are smaller). */
const servo = (s = 1) => (F) => {
  const w = 0.01 * s, l = 0.02 * s, h = 0.018 * s, off = 0.005 * s, c = 0.003 * s;
  return [
    [MAT.dark, box(F, [0, l / 2 - off, -(c + h / 2)], [w, l, h], 0.0012 * s)],
    [MAT.dark, box(F, [0, l / 2 - off, -c - 0.0045 * s], [w, l + 0.009 * s, 0.0014 * s], 0.0005)], // mounting tabs
    [MAT.metal, cyl(F, [0, 0, -c], 0.0028 * s, c, 14)],
    [MAT.plastic, cyl(F, [0, 0, 0], 0.0042 * s, 0.0012 * s, 16)],
    [MAT.plastic, box(F, [0, 0.005 * s, 0.0006 * s], [0.0034 * s, 0.013 * s, 0.0012 * s], 0.0006 * s)],
  ];
};

/* Light path of the face: the projector at the top of the head shines
   back and down to a mirror at the back of the head; the mirror reflects
   the image forward onto the back of the visor. The mirror normal is the
   half vector of the incoming and outgoing directions. */
const PROJ_C = [0, 0.338, -0.03];
const MIRROR_C = [0, 0.284, -0.088];
const VISOR_MID = [0, 0.288, 0.046];
const BEAM_IN = unit(add(MIRROR_C, mul(PROJ_C, -1)));
const LENS = add(PROJ_C, mul(BEAM_IN, 0.0225));
const MIRROR = { c: MIRROR_C, n: unit(add(unit(add(VISOR_MID, mul(MIRROR_C, -1))), mul(BEAM_IN, -1))) };
/** Points that outline the two beams, in model space (for the Face view). */
export const BEAM = (() => {
  const F = frame(MIRROR.c, MIRROR.n, [0, 0, -1]);
  const mir = [[-0.019, -0.015], [0.019, -0.015], [0.019, 0.015], [-0.019, 0.015]].map(([x, y]) => toWorld(F, [x, y, 0.0005]));
  const lF = frame(LENS, BEAM_IN);
  const lens = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => toWorld(lF, [Math.cos(i * Math.PI / 4) * 0.0043, Math.sin(i * Math.PI / 4) * 0.0043, 0]));
  // the lit area on the back of the visor (inside the dome)
  const visor = [[0, 0.333, 0.039], [0.05, 0.31, 0.045], [0.062, 0.285, 0.046], [0.05, 0.26, 0.046], [0, 0.243, 0.044],
    [-0.05, 0.26, 0.046], [-0.062, 0.285, 0.046], [-0.05, 0.31, 0.045]];
  return { lens, mir, visor, mirror: MIRROR.c };
})();

/* Where each part sits. group: the rig group it moves with. at: the
   callout anchor (default: the frame origin). */
const PLACE = {
  // just behind the camera window at the top of the face, looking forward
  camera: { group: 'head', make: camera, F: frame([0, 0.349, 0.0168], [0, 0, 1]), at: [0, 0.349, 0.022] },
  // projector at the top of the head, lens toward the mirror at the back
  projector: { group: 'head', make: projector, F: frame(PROJ_C, BEAM_IN) },
  mirror: { group: 'head', make: mirror, F: frame(MIRROR.c, MIRROR.n, [0, 0, -1]) },
  mic: { group: 'head', make: micArray, F: frame([0, 0.362, -0.004], [0, 1, 0], [0, 0, 1]) },
  speaker: { group: 'yaw', make: speaker, F: frame([0, 0.1, 0.042], [0, 0, 1]), at: [0, 0.1, 0.052] },
  led: { group: 'lean', make: ledBar, F: frame([0, 0.17, 0.056], [0, 0.18, 1]) },
  main: { group: 'lean', make: mainBoard, F: frame([0, 0.13, -0.0458], [0, 0, 1]) },
  mcu: { group: 'yaw', make: motorBoard, F: frame([0, 0.0478, 0.01], [0, 1, 0], [0, 0, -1]) },
  imu: { group: 'yaw', make: imu, F: frame([0.022, 0.0486, 0.022], [0, 1, 0], [0, 0, -1]) },
  touchF: { group: 'lean', make: pad, F: frame([0, 0.132, 0.0685], [0, 0.15, 1]) },
  touchB: { group: 'lean', make: padB, F: frame([0, 0.137, -0.0705], [0, 0.1, -1]) },
  battery: { group: 'base', make: battery, F: frame([0, 0.022, -0.045], [0, 0, 1]) },
  // servos: output shaft on the joint axis (see JOINTS)
  m0: { group: 'lean', make: servo(0.8), F: frame([0.066, 0.1811, 0.0015], [1, 0, 0], [0, -1, 0]) },
  m2: { group: 'lean', make: servo(0.8), F: frame([-0.066, 0.1811, 0.0015], [-1, 0, 0], [0, -1, 0]) },
  m1: { group: 'shL', make: servo(0.75), F: frame([0.094, 0.165, 0.009], [0, 0, 1], [0, -1, 0]) },
  m3: { group: 'shR', make: servo(0.75), F: frame([-0.094, 0.165, 0.009], [0, 0, 1], [0, -1, 0]) },
  m4: { group: 'lean', make: servo(), F: frame([0.012, 0.2112, 0], [1, 0, 0], [0, 0, -1]) },
  m5: { group: 'base', make: servo(), F: frame([0, 0.036, 0], [0, 1, 0], [0, 0, 1]) },
  m6: { group: 'yaw', make: servo(), F: frame([0.012, 0.069, 0], [1, 0, 0], [0, 0, 1]) },
};

export const ANCHOR = Object.fromEntries(Object.entries(PLACE).map(([k, p]) => [k, p.at || p.F.o]));

/** One mesh per (part, material). */
export function buildInnards() {
  const out = [];
  for (const [name, p] of Object.entries(PLACE)) {
    const byKind = new Map();
    for (const [kind, g] of p.make(p.F)) {
      if (!byKind.has(kind)) byKind.set(kind, { pos: [], nrm: [], idx: [] });
      const m = byKind.get(kind), b = m.pos.length / 3;
      m.pos.push(...g.pos); m.nrm.push(...g.nrm); m.idx.push(...g.idx.map((i) => i + b));
    }
    for (const [kind, m] of byKind) {
      out.push({ name, group: p.group, kind, inner: true, pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm), idx: new Uint32Array(m.idx) });
    }
  }
  return out;
}

/* Joints, as the rig turns them: a positive angle turns by +angle about
   axis (right hand), from the reference direction ref. Pivots are names in
   the model's pivot list. Ranges are the rig's (see the motor table). */
export const JOINTS = [
  { motor: 'm0', pivot: 'ShoulderL', axis: [-1, 0, 0], ref: [0, -1, 0], min: -55, max: 145, r: 0.045 },
  { motor: 'm2', pivot: 'ShoulderR', axis: [-1, 0, 0], ref: [0, -1, 0], min: -55, max: 145, r: 0.045 },
  { motor: 'm1', pivot: 'ArmL', axis: [0, 0, 1], ref: [0, -1, 0], min: -30, max: 60, r: 0.07 },
  { motor: 'm3', pivot: 'ArmR', axis: [0, 0, -1], ref: [0, -1, 0], min: -30, max: 60, r: 0.07 },
  { motor: 'm4', pivot: 'Helmet', axis: [1, 0, 0], ref: [0, 0, 1], min: -15, max: 15, r: 0.075 },
  { motor: 'm6', pivot: 'Chest', axis: [1, 0, 0], ref: [0, 1, 0], min: -15, max: 15, r: 0.065 },
  { motor: 'm5', pivot: 'Torso', axis: [0, 1, 0], ref: [0, 0, 1], min: -180, max: 180, r: 0.105 },
];
/* The rig: motor m at an angle in degrees sets the stage's group rotations
   (stage.rot). Motor order as in the motor table: left arm up, left arm
   out, right arm up, right arm out, head nod, body turn, body lean. */
const RAD = Math.PI / 180;
export const RIG = [
  (r, a) => { r.shL = [-a * RAD, 0, 0]; },
  (r, o) => { r.armL = [0, 0, Math.max(0, o) * RAD]; r.foreL = [0, 0, Math.min(0, o) * RAD]; },
  (r, a) => { r.shR = [-a * RAD, 0, 0]; },
  (r, o) => { r.armR = [0, 0, -Math.max(0, o) * RAD]; r.foreR = [0, 0, -Math.min(0, o) * RAD]; },
  (r, p) => { r.head = [p * RAD, 0, 0]; },
  (r, y) => { r.yaw = [0, y * RAD, 0]; },
  (r, l) => { r.lean = [l * RAD, 0, 0]; },
];

/** Points of a joint's arc (Rodrigues rotation of ref about axis). */
export function jointArc(j, piv, steps = 48) {
  const p = piv[j.pivot], k = unit(j.axis), out = [];
  for (let i = 0; i <= steps; i++) {
    const a = (j.min + ((j.max - j.min) * i) / steps) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const v = j.ref;
    const r = add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
    out.push(add(p, mul(r, j.r)));
  }
  return out;
}

/* ------------------------------------------------------ containment check */

/** Uniform grid over the shell triangles for ray queries. */
export function makeEnclosure(shells, cell = 0.006) {
  const tri = [];
  for (const s of shells) for (let t = 0; t < s.idx.length; t += 3) {
    for (let k = 0; k < 3; k++) { const i = s.idx[t + k] * 3; tri.push(s.pos[i], s.pos[i + 1], s.pos[i + 2]); }
  }
  const T = new Float64Array(tri), nT = T.length / 9;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], T[i + k]); hi[k] = Math.max(hi[k], T[i + k]); }
  for (let k = 0; k < 3; k++) { lo[k] -= cell; hi[k] += cell; }
  const n = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k]) / cell));
  const cells = new Map();
  const ci = (x, y, z) => (z * n[1] + y) * n[0] + x;
  for (let t = 0; t < nT; t++) {
    const b = t * 9, mn = [0, 1, 2].map((k) => Math.min(T[b + k], T[b + 3 + k], T[b + 6 + k])), mx = [0, 1, 2].map((k) => Math.max(T[b + k], T[b + 3 + k], T[b + 6 + k]));
    const a = mn.map((v, k) => Math.floor((v - lo[k]) / cell)), e = mx.map((v, k) => Math.floor((v - lo[k]) / cell));
    for (let z = a[2]; z <= e[2]; z++) for (let y = a[1]; y <= e[1]; y++) for (let x = a[0]; x <= e[0]; x++) {
      const c = ci(x, y, z);
      if (!cells.has(c)) cells.set(c, []);
      cells.get(c).push(t);
    }
  }
  /** Does a ray from o along unit d hit any triangle? (grid walk) */
  function hits(o, d) {
    let c = o.map((v, k) => Math.floor((v - lo[k]) / cell));
    if (c.some((v, k) => v < 0 || v >= n[k])) return false;
    const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tMax = d.map((v, k) => (v === 0 ? Infinity : ((c[k] + (v > 0 ? 1 : 0)) * cell + lo[k] - o[k]) / v));
    const tD = d.map((v) => (v === 0 ? Infinity : cell / Math.abs(v)));
    for (let guard = 0; guard < 400; guard++) {
      const list = cells.get(ci(c[0], c[1], c[2]));
      if (list) for (const t of list) {
        const b = t * 9;
        const e1 = [T[b + 3] - T[b], T[b + 4] - T[b + 1], T[b + 5] - T[b + 2]];
        const e2 = [T[b + 6] - T[b], T[b + 7] - T[b + 1], T[b + 8] - T[b + 2]];
        const pv = cross(d, e2), det = dot(e1, pv);
        if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det, tv = [o[0] - T[b], o[1] - T[b + 1], o[2] - T[b + 2]];
        const u = dot(tv, pv) * inv;
        if (u < 0 || u > 1) continue;
        const qv = cross(tv, e1), v = dot(d, qv) * inv;
        if (v < 0 || u + v > 1) continue;
        if (dot(e2, qv) * inv > 1e-7) return true;
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      c[k] += step[k];
      if (c[k] < 0 || c[k] >= n[k]) return false;
      tMax[k] += tD[k];
    }
    return false;
  }
  return { hits };
}

const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) DIRS.push(unit([x + 0.013, y + 0.021, z + 0.017])); // small skew: no ray runs along a grid plane
}

/**
 * Parts that are not at least `margin` inside the shell. Each vertex moves
 * out by the margin along its normal; that point counts as inside when rays
 * in at most `slack` of 26 directions escape. The slack covers the joint
 * gaps of the model (neck, shoulders), which let a few diagonal rays out; a
 * point just outside a wall loses 8 or more. Returns
 * [{ name, kind, out, of, at }].
 */
export function findLeaks(enc, parts, margin = 0.002, slack = 3) {
  const leaks = [];
  for (const p of parts) {
    const seen = new Set();
    let out = 0, of = 0, at = null;
    for (let i = 0; i < p.pos.length; i += 3) {
      const q = [p.pos[i] + p.nrm[i] * margin, p.pos[i + 1] + p.nrm[i + 1] * margin, p.pos[i + 2] + p.nrm[i + 2] * margin];
      const key = q.map((v) => Math.round(v * 2000)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      of++;
      let esc = 0;
      for (const d of DIRS) if (!enc.hits(q, d) && ++esc > slack) break;
      if (esc > slack) { out++; at ??= q.map((v) => +v.toFixed(4)); }
    }
    if (out) leaks.push({ name: p.name, kind: p.kind, out, of, at });
  }
  return leaks;
}

/** The projector and its mirror, for figures that only show the closed
    shell (they stay hidden inside it, but a selection outline can use them). */
export function headParts() {
  return buildInnards().filter((p) => p.name === 'projector' || p.name === 'mirror').map((p) => ({ ...p, inner: false }));
}

/*
 * The robot's face: moods, blinks and mouth shapes from one image (face.webp).
 *
 * The robot draws its face from a small 3D face rig: bones and blend shapes
 * move the brows, lids, lips, teeth and tongue, and a camera renders the
 * result onto the visor. The atlas holds still renders of that rig, posed
 * by the robot's own animation clips:
 *
 *   eyes   11 moods × 3 intensities, a half-closed and a closed lid for each
 *          mood (for blinks), and the eyes of a big laugh. A cell covers the
 *          brows, the eyes and the cheeks.
 *   mouth  the rest mouth, the mouth shapes for the 41 phones (phones that
 *          look the same share a shape: 22 shapes), and a resting mouth for
 *          the moods that have one.
 *   base   the whole face at rest.
 *
 * The shader starts from the base face. In the eye box it shows the eye cell
 * where that cell differs from the base, then the same for the mouth cell
 * in the mouth box, below the eyes (see faceWGSL). The face
 * state is two numbers (an eye cell and a mouth cell) in a uniform: a change
 * of expression costs only the frame that shows it, with no texture upload.
 */

/* Atlas layout in pixels. The face is 384 × 307; the eye and mouth cells are
   crops of it (the rects are in face pixels). */
export const FACE = {
  size: [2048, 2588],
  face: [384, 307],
  base: [0, 2106],
  eye: { rect: [30, 18, 354, 252], cols: 6, at: [0, 0] },
  mouth: { rect: [96, 168, 288, 288], cols: 8, at: [384, 2106] },
};

/* The robot's playback moods, in its own order. Intensity is 0..2. */
export const MOODS = ['neutral', 'happy', 'sad', 'angry', 'shy', 'surprised', 'afraid', 'concerned', 'confused', 'curious', 'embarrassed'];

/* Eye cells per mood: intensity 0, 1, 2, then lids half closed and closed. */
const EYE = [[0, 0, 0, 1, 2], [3, 4, 5, 6, 7], [8, 9, 10, 11, 12], [13, 14, 15, 16, 17], [18, 19, 20, 21, 22], [23, 24, 25, 26, 27], [28, 29, 30, 31, 32], [33, 34, 35, 36, 37], [38, 39, 40, 41, 42], [43, 44, 45, 46, 47], [48, 49, 50, 51, 52]];
const LAUGH_EYE = 53;
/* The resting face: relaxed lids (the calmest open-eye cell), then half and closed. */
const REST_EYE = [13, 16, 17];

/* The 41 phones the speech engine reports, in its order, then silence. */
export const PHONES = 'aa ae ah ao aw ax ay b ch d dx dh eh er ey f g hh ih iy jh k l m n ng ow oy p r s sh t th uh uw v w y z zh sil'.split(' ');
/* Mouth cell per phone (0 is the rest mouth). The rig's own phone shapes
   read as clenched teeth at figure size, so the figure uses softer cells:
   1 a small open smile, 2 a wide open smile, 28 a round "o", 7 closed lips,
   23 the smile for the other consonants. */
const VIS = [2, 1, 1, 2, 2, 1, 1, 7, 23, 23, 23, 23, 1, 1, 1, 23, 23, 1, 1, 23, 23, 23, 1, 7, 23, 23, 28, 28, 7, 1, 23, 28, 23, 23, 28, 28, 23, 28, 23, 23, 28, 0];
const PHONE_INDEX = new Map(PHONES.map((p, i) => [p, i]));
/* Resting mouth per mood (moods without one rest on a near one). */
const MOOD_MOUTH = { rest: 23, happy: 23, laugh: 24, sad: 25, angry: 26, afraid: 27, surprised: 28, curious: 29, confused: 29, shy: 30, embarrassed: 30, concerned: 31 };

const clamp3 = (l) => Math.min(2, Math.max(0, Math.round(l)));

/**
 * Eye cell for a mood, an intensity (0..2) and the lids (0 open, 1 half,
 * 2 closed). 'laugh' is the eyes of a big laugh (they blink as happy).
 */
export function eyeCell(mood = 'neutral', level = 1, lids = 0) {
  if (mood === 'laugh' && !lids) return LAUGH_EYE;
  if (mood === 'rest') return REST_EYE[Math.min(lids, 2)];
  const row = EYE[Math.max(0, MOODS.indexOf(mood === 'laugh' ? 'happy' : mood))];
  return lids >= 2 ? row[4] : lids >= 1 ? row[3] : row[clamp3(level)];
}

/** The resting mouth of a mood: the cell shown when the robot is not talking. */
export const moodMouth = (mood) => MOOD_MOUTH[mood] ?? 0;

/** Mouth cell for a phone name ('aa', 'sh', …); anything else is the rest mouth. */
export function mouthCell(phone) {
  const i = PHONE_INDEX.get(phone);
  return i === undefined || i === 41 ? 0 : VIS[i];
}

/* Spelling to phones, good enough for a figure: a few letter pairs, then one
   phone per letter. A real speech engine reports the phones with their times. */
const PAIRS = { th: 'th', sh: 'sh', ch: 'ch', ng: 'ng', ph: 'f', wh: 'w', ck: 'k', ee: 'iy', ea: 'iy', oo: 'uw', ou: 'aw', ow: 'ow', ai: 'ey', ay: 'ey', oi: 'oy', oy: 'oy', er: 'er', ar: 'aa', or: 'ao' };
const ONE = { a: 'ae', b: 'b', c: 'k', d: 'd', e: 'eh', f: 'f', g: 'g', h: 'hh', i: 'ih', j: 'jh', k: 'k', l: 'l', m: 'm', n: 'n', o: 'ao', p: 'p', q: 'k', r: 'r', s: 's', t: 't', u: 'ah', v: 'v', w: 'w', x: 'k', y: 'y', z: 'z' };
const VOWEL = new Set(['aa', 'ae', 'ah', 'ao', 'aw', 'ax', 'ay', 'eh', 'er', 'ey', 'ih', 'iy', 'ow', 'oy', 'uh', 'uw']);

/** Phones of one word, from its spelling. */
export function spell(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const two = PAIRS[w.slice(i, i + 2)];
    if (two) { out.push(two); i++; continue; }
    if (w[i] === 'e' && i === w.length - 1 && i > 1) continue; // a silent final e
    if (out.length && ONE[w[i]] === out[out.length - 1]) continue; // double letters
    out.push(ONE[w[i]]);
  }
  return out.length ? out : ['ah'];
}

/**
 * Mouth timeline for a line of text spoken from t0 to t1 (any time unit):
 * [{ t, m, open }] with the mouth cell and a rough openness (vowels open).
 * With no t1, phones last 1/12 of a second (t in seconds). The list ends
 * with the rest mouth at t1.
 */
export function lipSync(text, t0, t1) {
  const ph = [];
  for (const w of text.split(/\s+/)) if (/[a-z]/i.test(w)) ph.push(...spell(w), 'sil');
  ph.pop();
  const end = t1 ?? t0 + ph.length / 12;
  const step = (end - t0) / Math.max(1, ph.length);
  const out = ph.map((p, k) => ({ t: t0 + k * step, m: mouthCell(p), open: VOWEL.has(p) ? 0.85 : p === 'sil' ? 0 : 0.25 }));
  out.push({ t: end, m: 0, open: 0 });
  return out;
}

/** The mouth cell at time t in a lipSync() list, or `rest` outside it. */
export function mouthAt(list, t, rest = 0) {
  if (!list || !list.length || t < list[0].t || t >= list[list.length - 1].t) return rest;
  let lo = 0, hi = list.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) lo = mid; else hi = mid; }
  return list[lo].m;
}

/** Laugh mouth at time t (seconds): the big smile, open about 4 times a second. */
export const laughMouth = (t) => (Math.floor(t * 8) % 2 ? MOOD_MOUTH.laugh : mouthCell('aa'));

/* WGSL for the face. faceRGB(uv) is the face colour (gamma-encoded, 0..1)
   at uv (0..1 across the face plate). The eye cell is st.anim.x, the mouth
   cell st.anim.y. A cell shows where it differs from the base face, with a
   soft edge at its box. */
export function faceWGSL() {
  const f = (a) => a.map((x) => `${x}.0`).join(', ');
  const { size, face, base, eye, mouth } = FACE;
  return /* wgsl */ `
const FA = vec2f(${f(size)});
const FF = vec2f(${f(face)});
const FB = vec2f(${f(base)});
const ER = vec4f(${f(eye.rect)});
const EO = vec2f(${f(eye.at)});
const MR = vec4f(${f(mouth.rect)});
const MO = vec2f(${f(mouth.at)});
// 1 inside the box, falling to 0 over its outer 6 face pixels
fn boxW(p: vec2f, r: vec4f) -> f32 {
  let d = min(p - r.xy, r.zw - p);
  return clamp(min(d.x, d.y) / 6.0, 0.0, 1.0);
}
// one cell of the atlas, clamped half a pixel inside it
fn cellAt(o: vec2f, sz: vec2f, p: vec2f) -> vec3f {
  return textureSampleLevel(faceTex, faceSmp, (o + clamp(p, vec2f(0.5), sz - 0.5)) / FA, 0.0).rgb;
}
// a layer over c: shown where it differs from the base face b by more than
// about t (the image is lossy: equal pixels differ a little)
fn layer(c: vec3f, b: vec3f, l: vec3f, w: f32, t: f32) -> vec3f {
  let d = abs(l - b);
  return mix(c, l, w * smoothstep(t, t * 3.0, max(d.r, max(d.g, d.b))));
}
fn faceRGB(uv: vec2f) -> vec3f {
  let p = clamp(uv, vec2f(0.0), vec2f(1.0)) * FF;
  let b = cellAt(FB, FF, p);
  var c = b;
  let we = boxW(p, ER);
  if (we > 0.0) {
    let e = u32(st.anim.x);
    let sz = ER.zw - ER.xy;
    c = layer(c, b, cellAt(EO + vec2f(f32(e % ${eye.cols}u), f32(e / ${eye.cols}u)) * sz, sz, p - ER.xy), we, 0.006);
  }
  // the mouth layer stays clear of the eyes: below y 206 under them, below
  // y 156 in the gap between them (x 160..220)
  let top = mix(206.0, 156.0, 1.0 - smoothstep(22.0, 36.0, abs(p.x - 190.0)));
  let wm = boxW(p, MR) * smoothstep(top - 4.0, top + 4.0, p.y);
  if (wm > 0.0) {
    let m = u32(st.anim.y);
    let sz = MR.zw - MR.xy;
    c = layer(c, b, cellAt(MO + vec2f(f32(m % ${mouth.cols}u), f32(m / ${mouth.cols}u)) * sz, sz, p - MR.xy), wm, 0.02);
  }
  return c;
}
fn faceLinear(uv: vec2f) -> vec3f { return pow(faceRGB(uv), vec3f(2.2)); }
// The face on the plate, linear colour. lp: plate position (model space);
// dx, dy: its screen derivatives. When one screen pixel covers more than
// about one atlas pixel, four samples spread over the pixel (a rotated
// grid) stand in for mipmaps, so thin lines do not break up.
fn faceLin(lp: vec2f, dx: vec2f, dy: vec2f) -> vec3f {
  let k = vec2f(1.0 / (2.0 * st.face.z), -1.0 / (2.0 * st.face.w));
  let uv = (lp - st.face.xy) * k + 0.5;
  let du = dx * k;
  let dv = dy * k;
  if (max(length(du * FF), length(dv * FF)) < 1.2) { return faceLinear(uv); }
  return 0.25 * (faceLinear(uv + du * 0.125 + dv * 0.375) + faceLinear(uv - du * 0.125 - dv * 0.375)
    + faceLinear(uv + du * 0.375 - dv * 0.125) + faceLinear(uv - du * 0.375 + dv * 0.125));
}`;
}

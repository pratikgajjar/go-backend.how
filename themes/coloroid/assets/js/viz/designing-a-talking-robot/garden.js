/*
 * The robot outdoors: a lawn on a bluff over the bay, painted offline and
 * drawn live in raw WebGPU.
 *
 * The scenery is an original, stylized scene (rounded trees, soft grass
 * clumps, flowers, the bay, a suspension bridge, far hills and a fog bank),
 * built and rendered offline with a path tracer. The page gets three things
 * from that render:
 *
 *   plate   a 360° panorama from 0.8 m above the lawn, elevation +90° to
 *           −24° (plate-<day|dusk>[-s].avif)
 *   lawn    the lawn straight down from above, 10 × 10 m around the robot,
 *           with its light and shade baked in (lawn-<day|dusk>[-s].avif)
 *   lights  the sun and five soft lights fitted to the same scene, so the
 *           robot sits in the light of the place (BAKE below)
 *
 * Both images are graded and tone mapped offline (the robot's tone curve),
 * so they hold display colour and need no tone curve here.
 *
 * Live, a full-screen pass casts each view ray:
 *
 *   lawn    a round hilltop: flat out to hill r0, then it falls away as
 *           (r − r0)² / 2·Rc. The baked lawn covers it (the panorama's own
 *           lawn past the tiles). The lawn is a shadow catcher: the robot's
 *           sun shadow takes the sun's share of the light away, and its
 *           bulk takes some sky light away.
 *   far     every ray that misses the hill: the panorama in the ray's
 *           direction only, as a sky would be. Everything in it is far, so
 *           it holds still while the eye moves a few metres: no parallax
 *           to get wrong, no smears. The panorama drops by the angle that
 *           puts its own lawn edge (the bluff) on the hill's skyline seen
 *           along the view, so the bay always lies just past the hill.
 *           From near the lawn the drop is about zero. Every stage uses
 *           the same lawn and far scene, so all views of the place match.
 *   blades  near the robot, tens of thousands of short grass blades stand on
 *           the baked lawn and take their colour from it (dark at the root,
 *           light at the tip). They hide the robot's base a little and sway
 *           only while the user drags the view. None grow under the
 *           caller's low spheres (y < 0.15 m: where a child sits).
 *
 * The pass draws into a colour texture whose alpha holds the view depth. The
 * stage's lit pass then draws it as a background: a depth-of-field gather
 * (blur grows away from the focus distance, more in X-ray mode, where the
 * scene also dims), and frag_depth from the stored depth.
 *
 * Nothing stands near the robot, so nothing comes between the camera and
 * the robot when the user turns the view.
 *
 * The images load the first time a garden figure is built, for the current
 * theme only; a narrow screen gets the half-size set and fewer blades. They
 * are AVIF, with a WebP copy for a browser that cannot decode AVIF.
 *
 * API (used by makeStage):
 *   const g = makeGarden(G, { url, onReady, turn, neutral }) once per stage; url: next to the images;
 *                                             turn: the scenery's bearing offset (rad);
 *                                             neutral: see robotLook
 *   g.look(dark)                              robot lights: { exposure, face, keySize, lights, shadowR }
 *   g.sun(dark)                               world direction of the key light (casts the shadow)
 *   g.setDark(dark)                           theme
 *   g.resize(w, h, shadowView)                after the canvas or shadow map changes
 *   g.frame({ ... })                          per-frame uniforms
 *   g.encode(enc, frameBG)                    the garden pass
 *   g.background(pass)                        inside the lit pass, before the robot
 */

import { REDUCED, mulberry } from '../lib.js';

/* The capture point stands CAP.h above the lawn at the robot. The baked
   lawn comes in two tiles: a sharp one over [−S, S]² and a wide one over
   [−S2, S2]² (m). */
const CAP = { h: 0.8, S: 2.5, S2: 6 };

/* Baked offline with the images (see the bake notes): light 0 is the sun,
   then sky, ground and three soft lights round the horizon, as [world
   axis, sharpness, linear colour]. keyShare: the sun's share of the light
   on the lawn. haze: the X-ray dim colour; sky / ground: stand-in colours
   until the images land (display-linear). */
const BAKE = /* BAKE:start */ {
  day: {"file": "day", "exposure": 1.0, "keyShare": 0.615, "keySize": 0.05, "shadowR": 0.8, "width": 8192, "span": 1.98957, "haze": [0.259, 0.387, 0.322], "sky": [0.051, 0.283, 0.869], "ground": [0.039, 0.131, 0.003], "lights": [[[0.621, 0.6157, 0.4851], 24.0, [16.7403, 14.587, 11.2569]], [[0.0, 1.0, 0.0], 2.5, [0.0118, 0.2151, 1.5601]], [[0.0, -1.0, 0.0], 3.0, [0.1271, 0.298, 0.0]], [[0.8713, 0.342, -0.352], 4.0, [0.4029, 0.6561, 0.3561]], [[-0.7405, 0.342, -0.5785], 4.0, [0.3825, 0.7088, 0.56]], [[-0.1308, 0.342, 0.9305], 4.0, [0.4535, 0.7337, 0.3637]]]},
  dusk: {"file": "dusk", "exposure": 1.35, "keyShare": 0.491, "keySize": 0.07, "shadowR": 1.0, "width": 8192, "span": 1.98957, "haze": [0.354, 0.105, 0.131], "sky": [0.005, 0.007, 0.096], "ground": [0.026, 0.027, 0.0], "lights": [[[-0.8576, 0.1392, -0.4951], 24.0, [10.3631, 4.0579, 1.4346]], [[0.0, 1.0, 0.0], 2.5, [0.0, 0.0, 0.1506]], [[0.0, -1.0, 0.0], 3.0, [0.0381, 0.0306, 0.0]], [[-0.8138, 0.342, 0.4698], 4.0, [0.2725, 0.1284, 0.101]], [[0.8138, 0.342, 0.4698], 4.0, [0.0364, 0.0597, 0.0489]], [[0.0, 0.342, -0.9397], 4.0, [0.2852, 0.1196, 0.103]]]},
} /* BAKE:end */;

/* The lawn is a round hilltop: flat out to r0, then it falls away as
   (r − r0)² / 2Rc, down to HILL_FLOOR below the top: the scene's own
   lawn, flat for 9 m round the robot. */
const HILL = [9, 8], HILL_FLOOR = 40;
/* The panorama's own lawn edge (the bluff over the bay) as seen from the
   capture point (rad, below the horizon). */
const BLUFF = -1.6 * Math.PI / 180;
/* The hill's skyline (rad) seen from the eye along the heading (hx, hz):
   the far scene's bluff goes there, never higher than in the panorama and
   at most 0.8 rad lower. */
function skyline(eye, hx, hz, [r0, rc]) {
  let top = -Math.PI / 2;
  for (let i = 0; i < 240; i++) {
    const s = 0.05 * 4000 ** (i / 239), x = eye[0] + hx * s, z = eye[2] + hz * s;
    const k = Math.max(Math.hypot(x, z) - r0, 0), y = -k * k / (2 * rc);
    if (y > -HILL_FLOOR) top = Math.max(top, Math.atan2(y - eye[1], s));
  }
  return Math.min(Math.max(top, BLUFF - 0.8), BLUFF);
}

/* The robot as three spheres [x, y, z, r] (m), for its soft occlusion on the lawn. */
const BODY = [[0, 0.07, 0, 0.1], [0, 0.17, 0, 0.1], [0, 0.3, 0, 0.095]];

/* A direction turned about the vertical axis: its bearing grows by a (rad). */
const turnY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
/* neutral (0..1) takes the colour out of the lights, keeping their
   brightness, and lifts the soft dusk lights: a white robot then reads
   white in the dusk too, not navy under the blue sky. */
function robotLook(dark, turn, neutral = 0) {
  const b = dark ? BAKE.dusk : BAKE.day;
  const grey = (c) => {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return c.map((x) => x + (l - x) * neutral);
  };
  return {
    exposure: b.exposure, face: dark ? 1.05 : 1, keySize: b.keySize, shadowR: b.shadowR,
    // at dusk the soft lights (all but the sun) come up too
    lights: b.lights.map(([ax, sharp, rgb], i) => [turnY(ax, turn), sharp, grey(rgb), i && dark ? 1 + 7 * neutral : 1, 'world']),
  };
}

/* Blades: clumps round the robot, denser near it, none under its base.
   Two vec4 per blade: [x, z, facing, height] [width, lean, shade, tint]. */
const BLADE_R = [2.1, 2.7]; // blades shrink away between these radii (m)
function blades(n, rnd) {
  const out = new Float32Array(n * 8);
  let i = 0;
  while (i < n) {
    // a clump: a centre, then 5..12 blades round it
    const r = 0.12 + BLADE_R[1] * rnd() ** 1.35, a = rnd() * Math.PI * 2;
    const cx = Math.sin(a) * r, cz = Math.cos(a) * r;
    const k = 5 + Math.floor(rnd() * 8), lean = (rnd() - 0.5) * 0.9, tint = rnd();
    // a short lawn: 1.4–3 cm by the robot (the drawings of Fig. 6 sit at 3.5 cm)
    const tall = 0.014 + 0.016 * rnd();
    for (let j = 0; j < k && i < n; j++, i++) {
      const rr = 0.012 * Math.sqrt(rnd()), aa = rnd() * Math.PI * 2;
      const x = cx + Math.sin(aa) * rr, z = cz + Math.cos(aa) * rr;
      if (Math.hypot(x, z) < 0.115) { j--; i--; break; }
      out.set([x, z, aa + (rnd() - 0.5) * 1.2, tall * (0.6 + 0.5 * rnd()), 0.0022 + 0.0016 * rnd(), lean + (rnd() - 0.5) * 0.5, rnd(), tint], i * 8);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- shaders */

const ENV = /* wgsl */ `
struct Env {
  invVP: mat4x4f,
  eye: vec4f,   // w: angle of one pixel (rad)
  prm: vec4f,   // x: wind time (s), y: dusk 0..1, z: focus distance, w: X-ray 0..1
  proj: vec4f,  // x, y: projection terms for depth, z: max blur (px), w: blur gain
  haze: vec4f,  // X-ray dim colour
  cap: vec4f,   // x: capture height, y: wide lawn half size, z: sharp lawn half size, w: key share
  pano: vec4f,  // x: panorama width (px), y: its vertical span (rad, from +90°), z: wind on (0/1), w: scene turn (rad)
  sun: vec4f,   // xyz: key direction, w: number of spheres in body
  hill: vec4f,  // x: flat radius r0 (m), y: fall-off radius Rc (m), z: depth where the hill ends (m)
  look: vec4f,  // the far scene: x: skyline along the view (rad), y: the bluff in the panorama (rad)
  body: array<vec4f, 14>, // occluders [x, y, z, r]: the robot's 3 first, then the caller's
};`;

const PLATE_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f, view: mat4x4f, lightVP: mat4x4f, misc: vec4f };
${ENV}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> env: Env;
@group(1) @binding(1) var shTex: texture_depth_2d;
@group(1) @binding(2) var shSmp: sampler_comparison;
@group(1) @binding(3) var pano: texture_2d<f32>;
@group(1) @binding(4) var lawn: texture_2d<f32>;
@group(1) @binding(5) var smp: sampler;
@group(1) @binding(6) var<storage, read> inst: array<vec4f>;
@group(1) @binding(7) var lawn2: texture_2d<f32>;

const TAU = 6.2831853;
fn sunShadow(p: vec3f) -> f32 {
  let s = (frame.lightVP * vec4f(p, 1.0)).xyz;
  let uv = s.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv <= vec2f(0.0)) || any(uv >= vec2f(1.0)) || s.z >= 1.0) { return 1.0; }
  let ts = 2.0 / f32(textureDimensions(shTex).x);
  var l = 0.0;
  for (var i = 0; i < 12; i++) {
    let a = f32(i) * 2.3999632;
    let r = sqrt((f32(i) + 0.5) / 12.0) * ts;
    l += textureSampleCompareLevel(shTex, shSmp, uv + r * vec2f(cos(a), sin(a)), s.z - 0.002);
  }
  return l / 12.0;
}
// The baked light at p, as the robot changes it: its sun shadow takes the
// sun's share away; its bulk (a few spheres) takes some sky light away.
fn catcher(p: vec3f) -> f32 {
  let sh = sunShadow(p + vec3f(0.0, 0.002, 0.0));
  var occ = 0.0;
  var shB = 1.0;
  for (var j = 0; j < i32(env.sun.w); j++) {
    let s = env.body[j];
    let v = s.xyz - p;
    let l2 = dot(v, v);
    occ += s.w * s.w / l2 * max(v.y, 0.0) / sqrt(l2);
    // the caller's spheres (the children) are not in the shadow map: a soft sun shadow of each
    let tc = dot(v, env.sun.xyz);
    if (j >= 3 && tc > 0.0) {
      shB *= smoothstep(s.w * 0.4, s.w * 1.2 + tc * 0.06, length(v - env.sun.xyz * tc));
    }
  }
  let k = env.cap.w;
  return (1.0 - k * (1.0 - sh * shB)) * (1.0 - max(1.0 - k, 0.55) * clamp(occ * 2.2, 0.0, 0.9));
}
// the panorama in a direction seen from the capture point; lod in mip
// levels. Alpha holds the distance from the capture point (see depthOf).
// the scenery may stand turned about the robot by pano.w (bearing added)
fn lp(xz: vec2f) -> vec2f {
  let c = cos(env.pano.w);
  let s = sin(env.pano.w);
  return vec2f(xz.x * c - xz.y * s, xz.x * s + xz.y * c);
}
fn panoUV(d: vec3f) -> vec2f {
  let u = fract((atan2(d.x, d.z) - env.pano.w) / TAU + 0.5);
  return vec2f(u, clamp((1.5707963 - asin(clamp(d.y, -1.0, 1.0))) / env.pano.y, 0.0, 1.0));
}
fn photo(d: vec3f, lod: f32) -> vec3f { return textureSampleLevel(pano, smp, panoUV(d), lod).rgb; }
// the far scene: the panorama by direction only. Its bluff sits on the
// skyline.
fn far(d: vec3f, lod: f32) -> vec3f {
  let e = env.look.y + asin(clamp(d.y, -1.0, 1.0)) - env.look.x;
  let u = fract((atan2(d.x, d.z) - env.pano.w) / TAU + 0.5);
  return textureSampleLevel(pano, smp, vec2f(u, clamp((1.5707963 - e) / env.pano.y, 0.0, 1.0)), lod).rgb;
}
fn viewZ(p: vec3f) -> f32 { return -(frame.view * vec4f(p, 1.0)).z; }
// the hilltop: flat to r0, then falling as (r − r0)² / 2Rc
fn hillY(r: f32) -> f32 {
  let k = max(r - env.hill.x, 0.0);
  return -k * k / (2.0 * env.hill.y);
}
fn aboveHill(p: vec3f) -> f32 { return p.y - hillY(length(p.xz)); }
// distance along the view ray to the hill, or −1 if it misses (fixed loop
// counts, so texture derivatives after it stay in uniform control flow)
fn hitHill(e: vec3f, d: vec3f) -> f32 {
  let dy = min(d.y, -1e-5);
  let tp = max(-e.y / dy, 0.0);
  if (length((e + d * tp).xz) <= env.hill.x) { return select(-1.0, tp, d.y < -1e-5); }
  // below the flat top's plane: march down the slope to the floor, then halve
  let tm = min((e.y + env.hill.z) / -dy, 400.0);
  var a = tp;
  var b = -1.0;
  for (var k = 1; k <= 48; k++) {
    let t = tp + (tm - tp) * pow(f32(k) / 48.0, 2.0);
    if (b < 0.0) {
      if (aboveHill(e + d * t) <= 0.0) { b = t; } else { a = t; }
    }
  }
  if (b < 0.0) { return -1.0; }
  for (var k = 0; k < 10; k++) {
    let m = 0.5 * (a + b);
    if (aboveHill(e + d * m) > 0.0) { a = m; } else { b = m; }
  }
  return b;
}

struct Full { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> Full {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return Full(vec4f(p[i], 0.0, 1.0), p[i]);
}
@fragment fn plate(i: Full) -> @location(0) vec4f {
  let w = env.invVP * vec4f(i.ndc, 1.0, 1.0);
  let eye = env.eye.xyz;
  let d = normalize(w.xyz / w.w - eye);
  let C = vec3f(0.0, env.cap.x, 0.0);
  let S = env.cap.z;
  // the hill under this pixel (for far pixels too, so the lawn's
  // derivatives stay in uniform control flow)
  let th = hitHill(eye, d);
  let t = select(-eye.y / min(d.y, -1e-4), th, th >= 0.0);
  let p = eye + d * t;
  let uv = lp(p.xz) / (2.0 * S) + 0.5;
  let gm = vec2f(0.25);
  let gx = clamp(dpdx(uv), -gm, gm);
  let gy = clamp(dpdy(uv), -gm, gm);
  let pxA = env.eye.w;
  let texA = TAU / env.pano.x;

  let S2 = env.cap.y;
  let uv2 = lp(p.xz) / (2.0 * S2) + 0.5;
  let gx2 = clamp(dpdx(uv2), -gm, gm);
  let gy2 = clamp(dpdy(uv2), -gm, gm);
  let edge = max(abs(p.x), abs(p.z));
  var col = textureSampleGrad(lawn2, smp, uv2, gx2, gy2).rgb;
  let sharp = textureSampleGrad(lawn, smp, uv, gx, gy).rgb;
  let sky = far(d, log2(max(pxA / texA, 1.0)));
  if (th < 0.0) { return vec4f(sky, 70.0); }
  // the baked lawn near the robot, the panorama's lawn past the wide tile
  // (seen from the capture point, as if the ground were flat)
  if (edge < S) { col = mix(col, sharp, smoothstep(S, S * 0.8, edge)); }
  let fade = smoothstep(S2 * 0.85, S2, edge);
  if (fade > 0.0) {
    let rel = vec3f(p.x, 0.0, p.z) - C;
    col = mix(col, photo(normalize(rel), log2(max(t * pxA / length(rel) / texA, 1.0))), fade);
  }
  // on the slope: the light baked for flat ground, turned to the slope
  let r = max(length(p.xz), 1e-4);
  let sl = max(r - env.hill.x, 0.0) / env.hill.y;
  let n = normalize(vec3f(p.x / r * sl, 1.0, p.z / r * sl));
  let ky = max(env.sun.y, 0.12);
  let turnL = 1.0 - env.cap.w + env.cap.w * clamp(dot(n, env.sun.xyz) / ky, 0.0, 1.6);
  // a soft skyline: the last pixels before the far scene
  let a = smoothstep(0.0, 2.0 * pxA, dot(n, -d));
  return vec4f(mix(sky, col * catcher(p) * turnL, a), mix(70.0, min(viewZ(p), 70.0), a));
}

// Grass blades near the robot: a tapered strip of 7 vertices, rooted on
// the baked lawn and coloured from it.
fn windAt(x: f32, z: f32) -> f32 {
  let t = env.prm.x;
  return env.pano.z * (sin(t * 1.6 + x * 1.3 + z * 0.8) * 0.6 + sin(t * 2.9 + x * 3.1 - z * 1.9) * 0.25);
}
struct Bl { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) t: f32, @location(2) c: vec3f, @location(3) shade: f32 };
@vertex fn vsBlade(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Bl {
  let a = inst[ii * 2u];
  let b = inst[ii * 2u + 1u];
  var ts = array<f32, 7>(0.0, 0.0, 0.35, 0.35, 0.7, 0.7, 1.0);
  let t = ts[vi];
  let side = select(select(-1.0, 1.0, (vi & 1u) == 1u), 0.0, vi == 6u);
  let r = length(a.xy);
  var h = a.w * (1.0 - smoothstep(${BLADE_R[0]}, ${BLADE_R[1]}, r));
  // none under what sits on the lawn (the caller's low spheres)
  for (var j = 3; j < i32(env.sun.w); j++) {
    let o = env.body[j];
    if (o.y < 0.15 && length(a.xy - o.xz) < o.w) { h = 0.0; }
  }
  let face = vec2f(cos(a.z), sin(a.z));
  let wax = vec3f(-face.y, 0.0, face.x);
  let bend = b.y + windAt(a.x, a.y) * 0.8;
  let lean = bend * t * t * h;
  let p = vec3f(a.x, hillY(r), a.y) + wax * b.x * (1.0 - t * 0.92) * side
    + vec3f(face.x * lean, h * t * (1.0 - 0.3 * t * abs(bend)), face.y * lean);
  let S = env.cap.z;
  let ls = lp(a.xy);
  var base = textureSampleLevel(lawn2, smp, ls / (2.0 * env.cap.y) + 0.5, 0.0).rgb;
  if (max(abs(ls.x), abs(ls.y)) < S * 0.97) { base = textureSampleLevel(lawn, smp, ls / (2.0 * S) + 0.5, 1.5).rgb; }
  return Bl(frame.viewProj * vec4f(p, 1.0), p, t, base, b.z * 0.6 + b.w * 0.4);
}
@fragment fn blade(i: Bl) -> @location(0) vec4f {
  // dark at the root, light and a little warm at the tip; each clump its own shade
  let tip = i.c * vec3f(1.32, 1.28, 0.85) + vec3f(0.02, 0.028, 0.0);
  let c = mix(i.c * 0.4, tip, pow(i.t, 0.75)) * (0.82 + 0.36 * i.shade);
  return vec4f(c * catcher(i.wp), viewZ(i.wp));
}`;

/* Background in the lit pass: depth of field gather, X-ray dim, depth. */
const BG_WGSL = /* wgsl */ `
${ENV}
@group(0) @binding(0) var envTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> env: Env;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn coc(z: f32) -> f32 {
  return clamp(abs(1.0 - env.prm.z / max(z, 0.01)) * env.proj.w, 0.0, 1.0) * env.proj.z * (1.0 + 0.8 * env.prm.w);
}
struct Out { @location(0) c: vec4f, @builtin(frag_depth) d: f32 };
@fragment fn fs(@builtin(position) fp: vec4f) -> Out {
  let dims = vec2i(textureDimensions(envTex));
  let px = vec2i(fp.xy);
  let c0 = textureLoad(envTex, px, 0);
  let r0 = coc(c0.a);
  var sum = c0.rgb;
  var w = 1.0;
  if (r0 > 0.5) {
    for (var i = 0; i < 20; i++) {
      let t = (f32(i) + 0.5) / 20.0;
      let a = f32(i) * 2.3999632 + fract(sin(dot(fp.xy, vec2f(12.9898, 78.233))) * 43758.5) * 6.2831853;
      let off = vec2f(cos(a), sin(a)) * sqrt(t) * r0;
      let s = textureLoad(envTex, clamp(px + vec2i(off), vec2i(0), dims - vec2i(1)), 0);
      // a tap counts if its own blur reaches this pixel (sharp areas do not bleed)
      let k = clamp(coc(s.a) - length(off) + 1.0, 0.0, 1.0);
      sum += s.rgb * k;
      w += k;
    }
  }
  var col = sum / w;
  // a light, still film grain (it does not change from frame to frame)
  let gr = fract(sin(dot(floor(fp.xy), vec2f(41.37, 289.13))) * 43758.5) - 0.5;
  col *= 1.0 + gr * 0.035;
  // X-ray: the scene steps back so the parts inside read
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(vec3f(lum), env.haze.rgb, 0.5), 0.45 * env.prm.w);
  let z = max(c0.a, 0.06);
  return Out(vec4f(col, 1.0), clamp(env.proj.x + env.proj.y / z, 0.0, 0.99999));
}`;

/* Mip levels: each level is a 2 × 2 average of the one above. */
const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return V(vec4f(p[i], 0.0, 1.0), p[i] * vec2f(0.5, -0.5) + 0.5);
}
@fragment fn fs(i: V) -> @location(0) vec4f { return textureSampleLevel(src, smp, i.uv, 0.0); }`;

/* -------------------------------------------------------------- pipelines */

const FMT = 'rgba8unorm-srgb';
const cache = new WeakMap();
function pipelines(G) {
  if (cache.has(G.device)) return cache.get(G.device);
  const { device } = G;
  const F = GPUShaderStage.FRAGMENT, V = GPUShaderStage.VERTEX;
  const envBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: V | F, buffer: {} },
      { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: F, sampler: { type: 'comparison' } },
      { binding: 3, visibility: F, texture: {} },
      { binding: 4, visibility: V | F, texture: {} },
      { binding: 5, visibility: V | F, sampler: {} },
      { binding: 6, visibility: V, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: V | F, texture: {} },
    ],
  });
  const bgBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: F, buffer: {} },
    ],
  });
  const mod = device.createShaderModule({ code: PLATE_WGSL });
  const bgMod = device.createShaderModule({ code: BG_WGSL });
  const mipMod = device.createShaderModule({ code: MIP_WGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [G.frameBGL, envBGL] });
  const target = [{ format: 'rgba16float' }];
  const ms = { count: 4 };
  const P = {
    envBGL, bgBGL,
    plate: device.createRenderPipeline({
      layout, vertex: { module: mod, entryPoint: 'vsFull' },
      fragment: { module: mod, entryPoint: 'plate', targets: target },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: ms,
    }),
    blade: device.createRenderPipeline({
      layout, vertex: { module: mod, entryPoint: 'vsBlade' },
      fragment: { module: mod, entryPoint: 'blade', targets: target },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: ms,
    }),
    bg: device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgBGL] }),
      vertex: { module: bgMod, entryPoint: 'vs' },
      fragment: { module: bgMod, entryPoint: 'fs', targets: [{ format: `${G.format}-srgb` }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'always' },
      multisample: { count: 4 },
    }),
    mip: device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipMod, entryPoint: 'vs' },
      fragment: { module: mipMod, entryPoint: 'fs', targets: [{ format: FMT }] },
      primitive: { topology: 'triangle-list' },
    }),
    // the panorama wraps round in x; anisotropic, so the lawn stays crisp at grazing angles
    smp: device.createSampler({ addressModeU: 'repeat', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8 }),
    mipSmp: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    shSmp: device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }),
  };
  cache.set(G.device, P);
  return P;
}

/* ------------------------------------------------------------- the images */

const srgbByte = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

/* A one-texel stand-in until an image lands. */
function stub(device, rgb) {
  const tex = device.createTexture({ size: [1, 1], format: FMT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([...rgb.map(srgbByte), 255]), { bytesPerRow: 4 }, [1, 1]);
  return tex;
}

function mips(device, P, enc, tex, levels) {
  for (let l = 1; l < levels; l++) {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(P.mip);
    pass.setBindGroup(0, device.createBindGroup({
      layout: P.mip.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }, { binding: 1, resource: P.mipSmp }],
    }));
    pass.draw(3);
    pass.end();
  }
}

/* The image type: '.avif' if this browser decodes a 1 × 1 AVIF, else '.webp'.
   Tested once per page. */
const AVIF1 = 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAIwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAK21kYXQSAAoIGAAGiAhoNCAyFR/3h4UV3///4sAAAJA1jjwuUfbc/A==';
let extP = null;
function imageExt() {
  extP ??= createImageBitmap(new Blob([Uint8Array.from(atob(AVIF1), (c) => c.charCodeAt(0))], { type: 'image/avif' }))
    .then((b) => { b.close(); return '.avif'; }, () => '.webp');
  return extP;
}

const textures = new WeakMap(); // device → Map(url → Promise of GPUTexture)
function loadTexture(device, P, url) {
  if (!textures.has(device)) textures.set(device, new Map());
  const m = textures.get(device);
  if (!m.has(url)) {
    m.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`garden ${r.status}`);
      return r.blob();
    }).then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })).then((bmp) => {
      const { width: w, height: h } = bmp;
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      const U = GPUTextureUsage;
      const tex = device.createTexture({ size: [w, h], format: FMT, mipLevelCount: levels, usage: U.TEXTURE_BINDING | U.COPY_DST | U.RENDER_ATTACHMENT });
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [w, h]);
      bmp.close();
      const enc = device.createCommandEncoder();
      mips(device, P, enc, tex, levels);
      device.queue.submit([enc.finish()]);
      return tex;
    }));
    m.get(url).catch(() => m.delete(url));
  }
  return m.get(url);
}

/* ------------------------------------------------------------------ stage */

const bladeBufs = new WeakMap(); // device → { buf, n }
export function makeGarden(G, { url, onReady, turn = 0, neutral = 0 } = {}) {
  const { device } = G;
  const P = pipelines(G);
  // phones get the half-size images and fewer blades
  const small = Math.min(window.innerWidth, screen.width || 1e4) < 600;
  const base = url || document.baseURI;
  const stubs = {
    day: [stub(device, BAKE.day.sky), stub(device, BAKE.day.ground), stub(device, BAKE.day.ground)],
    dusk: [stub(device, BAKE.dusk.sky), stub(device, BAKE.dusk.ground), stub(device, BAKE.dusk.ground)],
  };
  const loaded = {};
  if (!bladeBufs.has(device)) {
    const n = small ? 36000 : 96000, arr = blades(n, mulberry(20240611));
    const buf = device.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, arr);
    bladeBufs.set(device, { buf, n });
  }
  const grass = bladeBufs.get(device);
  const envBuf = device.createBuffer({ size: 448, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  let tex = null, plateBG = null, bgBG = null, shadowView = null, dark = false, bake = BAKE.day, ch = 1;
  const u = new Float32Array(108); // uniforms, reused every frame
  function bind() {
    if (!shadowView) return;
    const [pano, lawn, lawn2] = loaded[bake.file] || stubs[bake.file];
    plateBG = device.createBindGroup({
      layout: P.envBGL,
      entries: [
        { binding: 0, resource: { buffer: envBuf } }, { binding: 1, resource: shadowView }, { binding: 2, resource: P.shSmp },
        { binding: 3, resource: pano.createView() }, { binding: 4, resource: lawn.createView() }, { binding: 5, resource: P.smp },
        { binding: 6, resource: { buffer: grass.buf } }, { binding: 7, resource: lawn2.createView() },
      ],
    });
  }
  // the images for one theme, once; the stage draws again when they land
  function load(b) {
    if (loaded[b.file] !== undefined) return;
    loaded[b.file] = null;
    const sfx = small ? '-s' : '';
    imageExt().then((ext) => Promise.all([`plate-${b.file}${sfx}`, `lawn-${b.file}${sfx}`, `lawn2-${b.file}${sfx}`].map((f) => loadTexture(device, P, new URL(f + ext, base).href))))
      .then((t) => { loaded[b.file] = t; if (bake === b) bind(); onReady?.(); })
      .catch((err) => { delete loaded[b.file]; console.warn('viz: garden', err); });
  }
  const g = {
    look(d) { return robotLook(d, turn, neutral); },
    sun(d) { return turnY((d ? BAKE.dusk : BAKE.day).lights[0][0], turn); },
    setDark(d) { dark = d; bake = d ? BAKE.dusk : BAKE.day; load(bake); bind(); },
    resize(width, height, sv) {
      for (const x of tex ? Object.values(tex) : []) x.destroy();
      ch = height; shadowView = sv;
      const RT = GPUTextureUsage.RENDER_ATTACHMENT;
      tex = {
        ms: device.createTexture({ size: [width, height], format: 'rgba16float', usage: RT, sampleCount: 4 }),
        col: device.createTexture({ size: [width, height], format: 'rgba16float', usage: RT | GPUTextureUsage.TEXTURE_BINDING }),
        d: device.createTexture({ size: [width, height], format: 'depth24plus', usage: RT, sampleCount: 4 }),
      };
      bgBG = device.createBindGroup({ layout: P.bgBGL, entries: [{ binding: 0, resource: tex.col.createView() }, { binding: 1, resource: { buffer: envBuf } }] });
      bind();
    },
    /** f: { invViewProj, eye, proj (4×4), time (s), focus (m), xray, dpr, blobs ([x, y, z, r] spheres that shade the lawn, or null) } */
    frame(f) {
      u.set(f.invViewProj, 0);
      u.set([...f.eye, 2 * Math.atan(1 / f.proj[5]) / ch], 16);
      u.set([f.time || 0, dark ? 1 : 0, f.focus, f.xray], 20);
      // depth = proj[10]·(−z)/z + proj[14]/z, written as −m10 + m14 / z
      u.set([-f.proj[10], f.proj[14], 4.5 * f.dpr * (f.blur ?? 1), 0.9], 24);
      u.set([...bake.haze, 1], 28);
      u.set([CAP.h, CAP.S2, CAP.S, bake.keyShare], 32);
      u.set([bake.width / (small ? 2 : 1), bake.span, REDUCED ? 0 : 1, turn], 36);
      const occ = f.blobs ? BODY.concat(f.blobs).slice(0, 14) : BODY;
      u.set([...turnY(bake.lights[0][0], turn), occ.length], 40);
      // the view's heading: the ray through the middle of the screen
      const m = f.invViewProj, iw = 1 / (m[11] + m[15]);
      const fx = (m[8] + m[12]) * iw - f.eye[0], fz = (m[10] + m[14]) * iw - f.eye[2], fl = Math.hypot(fx, fz) || 1;
      const hx = fl > 1e-6 ? fx / fl : 0, hz = fl > 1e-6 ? fz / fl : 1;
      u.set([HILL[0], HILL[1], HILL_FLOOR, 0], 44);
      u.set([skyline(f.eye, hx, hz, HILL), BLUFF, 0, 0], 48);
      occ.forEach((s, i) => u.set(s, 52 + i * 4));
      device.queue.writeBuffer(envBuf, 0, u);
    },
    encode(enc, frameBG) {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: tex.ms.createView(), resolveTarget: tex.col.createView(), clearValue: [0, 0, 0, 70], loadOp: 'clear', storeOp: 'discard' }],
        depthStencilAttachment: { view: tex.d.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setBindGroup(0, frameBG);
      pass.setBindGroup(1, plateBG);
      pass.setPipeline(P.plate);
      pass.draw(3);
      pass.setPipeline(P.blade);
      pass.draw(7, grass.n);
      pass.end();
    },
    background(pass) {
      pass.setPipeline(P.bg);
      pass.setBindGroup(0, bgBG);
      pass.draw(3);
    },
  };
  load(bake);
  return g;
}

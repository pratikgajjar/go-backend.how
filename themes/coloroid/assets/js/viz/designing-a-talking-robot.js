/*
 * designing-a-talking-robot — figures for "Designing a robot that talks with kids".
 *
 *   robot-parts   X-ray of the model: parts inside, their buses, guided stops
 *   robot-turn    one sentence through the services on the bus
 *   robot-who     who is talking: a room in 3D (who.js)
 *   robot-motors  motor poses and the frame sent to the motor board
 *
 * The model is split into moving parts. Pivots use metres. The curved visor
 * is fitted to the helmet opening. The face (moods, blinks, mouth shapes)
 * comes from renders of the robot's own face rig (face.js).
 * Raw WebGPU only: no rendering library and no WebGL fallback.
 */

import { h, s, colorKey, codeBlock, range, chips, btn, register, onVisible, REDUCED, clamp } from './lib.js';
import { initWho3D } from './designing-a-talking-robot/who.js';
import { makeGarden } from './designing-a-talking-robot/garden.js';
import { buildInnards, headParts, ANCHOR, BEAM, JOINTS, RIG, jointArc, makeEnclosure, findLeaks } from './designing-a-talking-robot/innards.js';
import './designing-a-talking-robot/rel.js';
import './designing-a-talking-robot/sync.js';
import { FRAME_MS, wakeIn } from './designing-a-talking-robot/loop.js';
import { FACE, faceWGSL, eyeCell, moodMouth } from './designing-a-talking-robot/face.js';
import { MeshoptDecoder } from './meshopt-decoder.js';
// The real 3D robot for figures in their own modules (sync.js).
/* Shared 3D for the post's modules (who.js, rel.js, sync.js, …): one GPU
   device for the page (getGPU), one parse per model URL (loadModel), one
   garden scene per device. A stage draws only while it is on screen and
   something changed, at most 30 times a second (a drag draws at once).
   Modules may import these, or take
   them from the register() call below. */
export { makeStage, lazy3D, getGPU, loadModel, tokenRGB };
import './designing-a-talking-robot/sys.js';

const P = 'v-bot-';
const DEG = Math.PI / 180;

/* ------------------------------------------------------ WebGPU renderer */
/*
 * A small renderer written for this post, in raw WebGPU and WGSL. No 3D
 * library. Each frame has six passes:
 *
 *   shadow   depth of every part, seen from the key light (2048² map)
 *   prepass  view-space normal, part code (id, kind, selected) and depth
 *   ao       ambient occlusion: 12 taps in the hemisphere around the normal
 *   blur     a 4 × 4 blur that keeps depth and normal edges
 *   lit      4× MSAA forward pass: physically based matte plastic, lit by
 *            soft studio lights, with soft shadows and the face
 *   output   linear colour to the sRGB canvas
 *
 * The studio lights are spherical Gaussians (soft round light sources). The
 * diffuse and the GGX highlight of such a light have short closed forms, so a
 * big soft box costs about as much as a point light. The lights stay fixed to
 * the camera, as in a product photo. Picking reads one texel of the part-code
 * texture. Selection and page colours follow CSS tokens; the robot keeps its
 * own colours in both themes.
 */

const GEO_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f, view: mat4x4f, lightVP: mat4x4f, misc: vec4f };
struct Part { model: mat4x4f, code: u32 };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> part: Part;
struct VOut { @builtin(position) pos: vec4f, @location(0) n: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * part.model * vec4f(p, 1.0);
  o.n = (frame.view * part.model * vec4f(n, 0.0)).xyz;
  return o;
}
struct FOut { @location(0) n: vec4f, @location(1) code: u32 };
@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> FOut {
  var n = normalize(i.n);
  if (!ff) { n = -n; }
  return FOut(vec4f(n, 1.0), part.code);
}
@vertex fn vsShadow(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return frame.lightVP * part.model * vec4f(p, 1.0);
}`;

const AO_WGSL = /* wgsl */ `
struct AO {
  proj: vec4f,     // P00, P11, near, far
  prm: vec4f,      // radius (m), power, bias (m)
  toLight: mat4x4f, // view space to the key light's clip space
  sh: vec4f,       // shadow map size, uv per metre, depth range × light size, normal offset (m)
  key: vec4f,      // key light direction, view space
};
@group(0) @binding(0) var nTex: texture_2d<f32>;
@group(0) @binding(1) var dTex: texture_depth_2d;
@group(0) @binding(2) var<uniform> u: AO;
@group(0) @binding(3) var aoTex: texture_2d<f32>;
@group(1) @binding(0) var shTex: texture_depth_2d;
@group(1) @binding(1) var shSmp: sampler_comparison;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn lin(d: f32) -> f32 { let n = u.proj.z; let f = u.proj.w; return n * f / (f - d * (f - n)); }

// Soft shadow (PCSS): find the mean blocker depth, then filter over a disc
// whose size grows with the gap between blocker and receiver.
fn shadow(P: vec3f, N: vec3f, rot: f32) -> f32 {
  let nl = abs(dot(N, u.key.xyz));
  let s = (u.toLight * vec4f(P + N * u.sh.w * (1.0 + 2.0 * (1.0 - nl)), 1.0)).xyz;
  let uv = s.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv <= vec2f(0.0)) || any(uv >= vec2f(1.0)) || s.z >= 1.0) { return 1.0; }
  let size = u.sh.x;
  let zr = s.z - 0.0003;
  let search = 0.03 * u.sh.y;
  var bz = 0.0;
  var bn = 0.0;
  for (var i = 0; i < 8; i++) {
    let r = sqrt((f32(i) + 0.5) / 8.0) * search;
    let a = f32(i) * 2.3999632 + rot;
    let q = vec2i(clamp(uv + r * vec2f(cos(a), sin(a)), vec2f(0.0), vec2f(0.9999)) * size);
    let z = textureLoad(shTex, q, 0);
    if (z < zr) { bz += z; bn += 1.0; }
  }
  if (bn == 0.0) { return 1.0; }
  let pen = clamp((zr - bz / bn) * u.sh.z * u.sh.y, 1.5 / size, search);
  var lit = 0.0;
  for (var i = 0; i < 12; i++) {
    let r = sqrt((f32(i) + 0.5) / 12.0) * pen;
    let a = f32(i) * 2.3999632 + rot;
    lit += textureSampleCompareLevel(shTex, shSmp, uv + r * vec2f(cos(a), sin(a)), zr);
  }
  return lit / 12.0;
}

// Half resolution. r: ambient occlusion from 12 taps in the hemisphere around
// the normal, g: key light shadow, b: view depth (for the blur and the
// upsample). Both use a 4 × 4 ordered pattern that the blur removes.
@fragment fn ao(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let h = vec2i(fp.xy);
  let dims = vec2f(textureDimensions(dTex));
  let c = min(h * 2, vec2i(dims) - vec2i(1));
  let d = textureLoad(dTex, c, 0);
  if (d >= 1.0) { return vec4f(1.0, 1.0, 100.0, 1.0); }
  let z = lin(d);
  let ndc = (vec2f(c) + 0.5) / dims * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let P = vec3f(ndc.x * z / u.proj.x, ndc.y * z / u.proj.y, -z);
  let N = normalize(textureLoad(nTex, c, 0).xyz);
  // tangent frame around N (Duff et al. 2017)
  let sg = select(-1.0, 1.0, N.z >= 0.0);
  let a = -1.0 / (sg + N.z);
  let b = N.x * N.y * a;
  let T = vec3f(1.0 + sg * N.x * N.x * a, sg * b, -sg * N.x);
  let B = vec3f(b, sg + N.y * N.y * a, -N.y);
  var bayer = array<f32, 16>(0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  let rot = bayer[(h.x & 3) + 4 * (h.y & 3)] / 16.0 * 6.2831853;
  let R = u.prm.x;
  var occ = 0.0;
  for (var i = 0; i < 12; i++) {
    let t = (f32(i) + 0.5) / 12.0;
    let ph = f32(i) * 2.3999632 + rot;
    let r = sqrt(t);
    let len = mix(0.15, 1.0, fract(f32(i) * 0.618034 + 0.3));
    let q = P + (T * (r * cos(ph)) + B * (r * sin(ph)) + N * sqrt(1.0 - t)) * (R * len);
    let qn = vec2f(q.x * u.proj.x, q.y * u.proj.y) / -q.z;
    let qc = vec2i((qn * vec2f(0.5, -0.5) + 0.5) * dims);
    if (any(qc < vec2i(0)) || any(qc >= vec2i(dims))) { continue; }
    let sz = lin(textureLoad(dTex, qc, 0));
    // only occluders within the radius count: a part well in front (an arm
    // over the chest) must not leave a half-resolution dark band at its edge
    if (sz < -q.z - u.prm.z) { occ += 1.0 - smoothstep(0.5 * R, 1.5 * R, abs(z - sz)); }
  }
  let ao = pow(clamp(1.0 - occ / 12.0, 0.0, 1.0), u.prm.y);
  return vec4f(ao, shadow(P, N, rot), z, 1.0);
}

// 4 × 4 blur that stops at depth and normal edges
@fragment fn blur(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let c = vec2i(fp.xy);
  let dm = vec2i(textureDimensions(aoTex)) - vec2i(1);
  let fm = vec2i(textureDimensions(nTex)) - vec2i(1);
  let m0 = textureLoad(aoTex, c, 0);
  if (m0.b >= 99.0) { return m0; }
  let z0 = m0.b;
  let n0 = textureLoad(nTex, min(c * 2, fm), 0).xyz;
  var s = vec2f(0.0);
  var w = 0.0;
  for (var y = -2; y < 2; y++) {
    for (var x = -2; x < 2; x++) {
      let q = clamp(c + vec2i(x, y), vec2i(0), dm);
      let m = textureLoad(aoTex, q, 0);
      let n = textureLoad(nTex, min(q * 2, fm), 0).xyz;
      let k = max(1.0 - abs(m.b - z0) / (0.012 * z0), 0.0) * pow(max(dot(n, n0), 0.0), 8.0) + 1e-4;
      s += m.rg * k;
      w += k;
    }
  }
  return vec4f(s / w, z0, 1.0);
}`;

const LIT_WGSL = /* wgsl */ `
struct Frame { viewProj: mat4x4f, view: mat4x4f, lightVP: mat4x4f, misc: vec4f };
struct Part { model: mat4x4f, code: u32 };
struct Style {
  board: vec4f, look: vec4f, body: vec4f, plate: vec4f, // linear colours
  params: vec4f, // x: outline px, y: X-ray (0..1), z: exposure, w: face brightness
  face: vec4f,   // face plate centre x, y and half size x, y (model space)
  anim: vec4f,   // x: eye cell, y: mouth cell of the face atlas (face.js)
  ink: vec4f,    // page ink (linear), for the X-ray shell
  lights: array<vec4f, 12>, // 6 × (view-space axis, sharpness), (colour, 0); light 0 casts the shadow
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> part: Part;
@group(2) @binding(0) var<uniform> st: Style;
@group(2) @binding(1) var idTex: texture_2d<u32>;
@group(2) @binding(2) var aoTex: texture_2d<f32>; // r: occlusion, g: key shadow
@group(2) @binding(3) var faceTex: texture_2d<f32>;
@group(2) @binding(4) var faceSmp: sampler;
${faceWGSL()}

const PI = 3.14159265;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) n: vec3f, @location(1) vp: vec3f, @location(2) lp: vec2f,
};
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  let wp = part.model * vec4f(p, 1.0);
  let wn = normalize((part.model * vec4f(n, 0.0)).xyz);
  o.pos = frame.viewProj * wp;
  o.n = (frame.view * vec4f(wn, 0.0)).xyz;
  o.vp = (frame.view * wp).xyz;
  let kind = (part.code >> 8u) & 15u;
  o.lp = select(p.xy, p.xz, kind == 4u); // face plate: x/y, ground: x/z
  return o;
}

fn toLin(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

// Khronos PBR Neutral tone mapping: base colours stay true, highlights roll off.
fn neutral(c0: vec3f) -> vec3f {
  var c = c0;
  let x = min(c.r, min(c.g, c.b));
  c -= select(0.04, x - 6.25 * x * x, x < 0.08);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < 0.76) { return c; }
  let d = 0.24;
  let np = 1.0 - d * d / (peak + d - 0.76);
  c *= np / peak;
  return mix(c, vec3f(np), 1.0 - 1.0 / (0.15 * (peak - np) + 1.0));
}

// Spherical Gaussian lights. Irradiance fit and the warped GGX lobe after
// M. Pettineo, "SG Series" (2016).
fn sgIrr(ax: vec3f, l: f32, n: vec3f) -> f32 {
  let mu = dot(ax, n);
  let e1 = exp(-l);
  let e2 = e1 * e1;
  let rl = 1.0 / l;
  let sc = 1.0 + 2.0 * e2 - rl;
  let bi = (e1 - e2) * rl - e2;
  let x = sqrt(1.0 - sc);
  let x0 = 0.36 * mu;
  let x1 = x / 1.44;
  var y = clamp(mu, 0.0, 1.0);
  if (abs(x0) <= x1) { y = (x0 + x1) * (x0 + x1) / x; }
  return max(sc * y + bi, 0.0) * 2.0 * PI * rl * (1.0 - e2);
}
fn sgDot(a1: vec3f, l1: f32, a2: vec3f, l2: f32) -> f32 {
  let um = length(l1 * a1 + l2 * a2);
  return 2.0 * PI * exp(um - l1 - l2) * (1.0 - exp(-2.0 * um)) / um;
}
fn sgSpec(ax: vec3f, l: f32, n: vec3f, v: vec3f, alpha: f32, f0: f32) -> f32 {
  let m2 = alpha * alpha;
  let nv = max(dot(n, v), 1e-3);
  let w = reflect(-v, n);
  let nl = clamp(dot(n, w), 0.0, 1.0);
  let d = sgDot(w, 2.0 / (m2 * 4.0 * nv), ax, l) / (PI * m2);
  let g = 1.0 / ((nl + sqrt(m2 + (1.0 - m2) * nl * nl)) * (nv + sqrt(m2 + (1.0 - m2) * nv * nv)));
  let f = f0 + (1.0 - f0) * pow(1.0 - clamp(dot(w, normalize(w + v)), 0.0, 1.0), 5.0);
  return d * g * f * nl;
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  // the face plate's footprint, while control flow is still uniform
  let fdx = dpdx(i.lp);
  let fdy = dpdy(i.lp);
  let dims = vec2i(textureDimensions(idTex));
  let c = clamp(vec2i(i.pos.xy), vec2i(0), dims - vec2i(1));
  let code = part.code;
  let kind = (code >> 8u) & 15u;
  let sel = (code & 4096u) != 0u;

  // selection outline: only on the selected part, where it meets anything else
  if (sel) {
    let o = i32(st.params.x);
    var offs = array<vec2i, 8>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1), vec2i(1, 1), vec2i(-1, 1), vec2i(1, -1), vec2i(-1, -1));
    for (var k = 0; k < 8; k++) {
      let q = clamp(c + offs[k] * o, vec2i(0), dims - vec2i(1));
      if ((textureLoad(idTex, q, 0).r & 255u) != (code & 255u)) { return vec4f(st.look.rgb, 1.0); }
    }
  }

  var N = normalize(i.n);
  if (!ff) { N = -N; }
  let V = normalize(-i.vp);
  // occlusion and shadow come from a half-size map: of its 2 × 2 nearest
  // texels, trust the ones at this fragment's depth
  let hd = vec2i(textureDimensions(aoTex));
  let hp = i.pos.xy * 0.5 - 0.5;
  let h0 = vec2i(floor(hp));
  let hf = hp - floor(hp);
  let z = -i.vp.z;
  var mw = vec2f(0.0);
  var ws = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let m = textureLoad(aoTex, clamp(h0 + o, vec2i(0), hd - vec2i(1)), 0);
    let bw = select(1.0 - hf.x, hf.x, o.x == 1) * select(1.0 - hf.y, hf.y, o.y == 1);
    let w = (bw + 1e-3) / (0.002 * z + abs(m.b - z));
    mw += m.rg * w;
    ws += w;
  }
  let ao = mw.x / ws;
  let sh = mw.y / ws;

  // ground: the page colour, darkened by the key shadow and contact occlusion
  if (kind == 4u) {
    let r = length(i.lp);
    let fade = 1.0 - smoothstep(0.18, 0.5, r);
    let blob = 0.2 * exp(-pow(r / 0.1, 2.0));
    let dark = clamp(((1.0 - sh) * 0.4 + (1.0 - ao) * 0.6) * fade + blob, 0.0, 0.85);
    return vec4f(st.board.rgb * (1.0 - dark), 1.0);
  }

  // Matte plastic: very rough, so highlights spread into soft, low sheens.
  // Satin-matte plastic shell (roughness 0.6). Inner parts (Fig. 1) have
  // their own materials: kind 6 circuit board, 7 metal, 8 chip, 9 copper,
  // 10 lens glass, 11 lit LED, 12 battery wrap, 13 dark plastic.
  var albedo = st.body.rgb;
  var rough = 0.6;
  var metal = 0.0;
  switch (kind) {
    case 3u: { albedo = vec3f(0.03); rough = 0.45; }
    case 14u: { albedo = vec3f(0.92); rough = 0.06; metal = 1.0; }
    case 5u: { albedo = vec3f(0.62); rough = 0.55; }
    case 6u: { albedo = vec3f(0.018, 0.06, 0.035); rough = 0.4; }
    case 7u: { albedo = vec3f(0.72, 0.72, 0.74); rough = 0.35; metal = 1.0; }
    case 8u: { albedo = vec3f(0.022); rough = 0.5; }
    case 9u: { albedo = vec3f(0.95, 0.62, 0.42); rough = 0.4; metal = 1.0; }
    case 10u: { albedo = vec3f(0.01, 0.012, 0.02); rough = 0.08; }
    case 11u: { return vec4f(neutral(vec3f(1.6, 1.5, 1.75)), 1.0); }
    case 12u: { albedo = vec3f(0.05, 0.16, 0.45); rough = 0.45; }
    case 13u: { albedo = vec3f(0.06); rough = 0.5; }
    case 1u: { rough = 0.32; }
    default: {}
  }
  if (sel) { albedo = mix(albedo, st.look.rgb, 0.45); }
  let alpha = rough * rough;
  let nv = max(dot(N, V), 0.0);
  let fv = 0.04 + 0.96 * pow(1.0 - nv, 5.0) * (1.0 - rough) * (1.0 - rough);
  let f0 = mix(0.04, 0.9, metal);

  // Burley diffuse per light (its axis stands in for L), so rough plastic
  // does not look chalky at grazing angles. Occlusion darkens the soft
  // lights only; the key light gets its shadow, not AO, so creases stay thin.
  var irr = vec3f(0.0);
  var spec = vec3f(0.0);
  let dao = mix(1.0, ao, 0.6);
  let fdv = pow(1.0 - nv, 5.0);
  for (var k = 0; k < 6; k++) {
    let a = st.lights[k * 2];
    let col = st.lights[k * 2 + 1].rgb * select(1.0, sh, k == 0);
    let H = normalize(a.xyz + V);
    let fd90 = 0.5 + 2.0 * rough * pow(dot(a.xyz, H), 2.0);
    let nl = clamp(dot(N, a.xyz), 0.0, 1.0);
    let burley = (1.0 + (fd90 - 1.0) * pow(1.0 - nl, 5.0)) * (1.0 + (fd90 - 1.0) * fdv);
    irr += col * sgIrr(a.xyz, a.w, N) * burley * select(dao, 1.0, k == 0);
    spec += col * sgSpec(a.xyz, a.w, N, V, alpha, f0);
  }
  spec *= mix(vec3f(1.0), albedo, metal);
  let so = mix(ao, 1.0, 0.5);

  var col: vec3f;
  if (kind == 1u) {
    // face plate: the projected face glows through satin plastic
    let face = faceLin(i.lp, fdx, fdy);
    // The face is emitted light: it keeps the art's own colours (no tone
    // curve), dims a little at the rim, and gets a soft, low reflection on top.
    let glow = face * st.params.w * (0.92 + 0.08 * nv) * mix(1.0, ao, 0.25);
    return vec4f(min(glow * (1.0 - 0.5 * fv) + neutral(spec * so * st.params.z), vec3f(1.0)), 1.0);
  } else {
    col = albedo * (1.0 - metal) / PI * irr * (1.0 - fv) + spec * so * mix(0.6, 1.0, metal);
  }
  return vec4f(neutral(col * st.params.z), 1.0);
}

// X-ray shell, drawn last with blending and no depth writes. As params.y goes
// from 0 to 1, the plain lit shell turns into a see-through ghost in the page
// ink: nearly clear where it faces the eye, darker where it turns away, so the
// outline still reads. The visor keeps its face, dimmed.
@fragment fn ghost(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let fdx = dpdx(i.lp);
  let fdy = dpdy(i.lp);
  let kind = (part.code >> 8u) & 15u;
  var N = normalize(i.n);
  if (!ff) { N = -N; }
  let V = normalize(-i.vp);
  let nv = clamp(abs(dot(N, V)), 0.0, 1.0);
  let x = st.params.y;
  var irr = vec3f(0.0);
  for (var k = 0; k < 6; k++) {
    let a = st.lights[k * 2];
    irr += st.lights[k * 2 + 1].rgb * sgIrr(a.xyz, a.w, N);
  }
  let rim = pow(1.0 - nv, 2.5);
  if (kind == 1u) {
    let face = faceLin(i.lp, fdx, fdy) * st.params.w;
    return vec4f(face, mix(1.0, 0.3 + 0.4 * rim, x));
  }
  let shade = neutral(st.body.rgb / PI * irr * st.params.z);
  return vec4f(mix(shade, st.ink.rgb, x), mix(1.0, 0.035 + 0.5 * rim, x));
}`;

const OUT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let c = clamp(textureLoad(src, vec2i(fp.xy), 0).rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308)), 1.0);
}`;

/* Column-major 4×4 matrices; clip depth 0..1 as WebGPU expects. */
const M4 = {
  id() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  /** a · b, into o when given (o must not be a or b). */
  mul(a, b, o = new Float32Array(16)) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = v;
    }
    return o;
  },
  t(x, y, z) { const m = M4.id(); m[12] = x; m[13] = y; m[14] = z; return m; },
  rx(a) { const m = M4.id(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
  ry(a) { const m = M4.id(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
  rz(a) { const m = M4.id(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  persp(fovy, aspect, n, f) {
    const m = new Float32Array(16), t = 1 / Math.tan(fovy / 2);
    m[0] = t / aspect; m[5] = t; m[10] = f / (n - f); m[11] = -1; m[14] = (n * f) / (n - f);
    return m;
  },
  /** Orthographic box of half size r, depth n..f in front of the eye. */
  ortho(r, n, f) {
    const m = M4.id();
    m[0] = m[5] = 1 / r; m[10] = -1 / (f - n); m[14] = -n / (f - n);
    return m;
  },
  lookAt(e, c, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = nrm(sub(e, c)), x = nrm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]);
  },
  apply(m, p) {
    const x = p[0], y = p[1], z = p[2];
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15],
    ];
  },
  /** General inverse (cofactors). */
  inv(m) {
    const o = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const d = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    o.set([
      a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03,
      a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01,
      a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00,
      a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00,
    ].map((x) => x * d));
    return o;
  },
};

/* Pivot groups, parent before child. Each motor turns one group. */
const GROUPS = [
  ['base', 'Base', null], ['yaw', 'Torso', null], ['lean', 'Chest', 'yaw'], ['head', 'Helmet', 'lean'],
  ['face', 'Helmet', 'head'], ['shL', 'ShoulderL', 'lean'], ['armL', 'ArmL', 'shL'], ['foreL', 'ForeArmL', 'armL'],
  ['shR', 'ShoulderR', 'lean'], ['armR', 'ArmR', 'shR'], ['foreR', 'ForeArmR', 'armR'],
];
const GROUP_PIVOT = Object.fromEntries(GROUPS.map(([g, p]) => [g, p]));
const PART_GROUP = {
  ground: 'base', Base: 'base', Torso: 'yaw', Chest: 'lean', Helmet: 'head', visor: 'face', eyes: 'face',
  ArmL: 'armL', ForeArmL: 'foreL', ArmR: 'armR', ForeArmR: 'foreR', projector: 'head',
};
/* Part kinds in the shader: 0 shell, 1 visor (face), 2 eyes, 3 projector,
   4 ground, 5 stand-in block (plain matte grey). */
const PART_KIND = { visor: 1, eyes: 2, projector: 3, ground: 4 };

function groupWorlds(piv, rot) {
  const W = {};
  for (const [g, pk, parent] of GROUPS) {
    const p = piv[pk];
    const pp = parent ? piv[GROUP_PIVOT[parent]] : [0, 0, 0];
    const r = rot[g] || [0, 0, 0];
    const local = M4.mul(
      M4.t(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]),
      M4.mul(M4.rx(r[0]), M4.mul(M4.ry(r[1]), M4.rz(r[2]))),
    );
    W[g] = parent ? M4.mul(W[parent], local) : local;
  }
  return W;
}

/** One meshopt stream (EXT_meshopt_compression), decoded into a fresh
    array (the decoder writes from the start of target.buffer). */
function meshopt(src, count, size, mode, filter) {
  const out = new Uint8Array(count * size);
  MeshoptDecoder.decodeGltfBuffer(out, count, size, src, mode, filter);
  return out;
}

/* GLB → parts in model space. Quantized, interleaved attributes and node
   scale/offset are decoded on the CPU into plain float arrays. The file's
   buffer views are meshopt-compressed; each is decoded once, here. */
const COMP = {
  5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767],
  5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 0], 5126: [4, 'getFloat32', 0],
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const bin = 20 + jsonLen + 8;
  // per buffer view: [DataView, byte offset of the view in it]
  const views = json.bufferViews.map((bv) => {
    const e = bv.extensions?.EXT_meshopt_compression;
    if (!e) return [dv, bin + (bv.byteOffset || 0)];
    const out = meshopt(new Uint8Array(buf, bin + (e.byteOffset || 0), e.byteLength), e.count, e.byteStride, e.mode, e.filter);
    return [new DataView(out.buffer), 0];
  });
  function read(ai, Out) {
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const [src, at] = views[a.bufferView];
    const [size, get, max] = COMP[a.componentType];
    const n = NCOMP[a.type];
    const stride = bv.byteStride || size * n;
    const base = at + (a.byteOffset || 0);
    const out = new Out(a.count * n);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) {
      let v = src[get](base + i * stride + c * size, true);
      if (a.normalized && max) v = Math.max(v / max, -1);
      out[i * n + c] = v;
    }
    return out;
  }
  const sc = json.scenes[json.scene || 0];
  const parts = [];
  for (const ni of sc.nodes) {
    const nd = json.nodes[ni];
    if (nd.mesh === undefined) continue;
    const pr = json.meshes[nd.mesh].primitives[0];
    const pos = read(pr.attributes.POSITION, Float32Array);
    const nrm = read(pr.attributes.NORMAL, Float32Array);
    const t = nd.translation || [0, 0, 0];
    const sc3 = nd.scale || [1, 1, 1];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = pos[i + k] * sc3[k] + t[k];
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
    const part = { name: nd.name, pos, nrm, idx: read(pr.indices, Uint32Array) };
    parts.push(windOut(nd.name === 'visor' ? domeNormals(part) : sc.extras?.subdivided ? pnPart(part) : smoothPart(part)));
  }
  return { parts, piv: sc.extras.pivots };
}

/* The visor is a fine dome, but a fan of long triangles runs from the camera
   notch to its middle and bends the normals into a visible wedge. A smooth
   height field z = f(x, y) (a degree-4 polynomial, least squares) fits the
   dome; its normals replace the mesh normals where the mesh lies on it, so the
   rim keeps its own. */
function domeNormals(p) {
  const { pos, nrm } = p, n = pos.length / 3, D = 4;
  const terms = [];
  for (let i = 0; i <= D; i++) for (let j = 0; i + j <= D; j++) terms.push([i, j]);
  const T = terms.length, lo = [1e9, 1e9], hi = [-1e9, -1e9];
  for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], pos[i * 3 + k]); hi[k] = Math.max(hi[k], pos[i * 3 + k]); }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], h = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2];
  const uv = (i) => [(pos[i * 3] - c[0]) / h[0], (pos[i * 3 + 1] - c[1]) / h[1]];
  // normal equations, front-facing points only
  const A = Array.from({ length: T }, () => new Float64Array(T + 1));
  for (let i = 0; i < n; i++) {
    if (nrm[i * 3 + 2] < 0.5) continue;
    const [x, y] = uv(i), f = terms.map(([a, b]) => x ** a * y ** b);
    for (let r = 0; r < T; r++) { A[r][T] += f[r] * pos[i * 3 + 2]; for (let q = 0; q < T; q++) A[r][q] += f[r] * f[q]; }
  }
  for (let col = 0; col < T; col++) {
    let pv = col;
    for (let r = col + 1; r < T; r++) if (Math.abs(A[r][col]) > Math.abs(A[pv][col])) pv = r;
    [A[col], A[pv]] = [A[pv], A[col]];
    for (let r = 0; r < T; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let q = col; q <= T; q++) A[r][q] -= f * A[col][q];
    }
  }
  const co = A.map((row, r) => row[T] / row[r]);
  const out = new Float32Array(nrm);
  for (let i = 0; i < n; i++) {
    const [x, y] = uv(i);
    let z = 0, dx = 0, dy = 0;
    terms.forEach(([a, b], t) => {
      z += co[t] * x ** a * y ** b;
      if (a) dx += co[t] * a * x ** (a - 1) * y ** b / h[0];
      if (b) dy += co[t] * b * x ** a * y ** (b - 1) / h[1];
    });
    const l = Math.hypot(dx, dy, 1), f = [-dx / l, -dy / l, 1 / l];
    const off = Math.abs(z - pos[i * 3 + 2]); // metres off the dome
    const w = nrm[i * 3 + 2] < 0.2 ? 0 : Math.min(1, Math.max(0, (0.003 - off) / 0.002));
    const m = [0, 1, 2].map((k) => nrm[i * 3 + k] * (1 - w) + f[k] * w), ml = Math.hypot(...m) || 1;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = m[k] / ml;
  }
  return { ...p, nrm: out };
}

/* The shader flips normals on back faces, so each triangle must wind
   counter-clockwise around the side its normals face. Some source triangles
   (all of the visor) wind the other way: turn those round. */
function windOut(p) {
  const { pos, nrm, idx } = p;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = nrm[a] + nrm[b] + nrm[c], ny = nrm[a + 1] + nrm[b + 1] + nrm[c + 1], nz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  }
  return p;
}

/* The shell is a low-poly game model, so its curves show facets. Two steps on
   load make them smooth without a bigger download:
   1. Smooth normals: each corner averages the normals of the faces around the
      same point that bend less than CREASE from its own face. Real hard edges
      stay hard.
   2. Curved subdivision (PN triangles): each triangle splits into four. The
      new points move onto the cubic surface that the normals describe, so the
      outline bends too. Edges on a crease stay straight, so no cracks open. */
const CREASE = Math.cos((50 * Math.PI) / 180);
// Numeric keys (no strings): a point welded to 50 µm, and a normal rounded
// to 1/500. Both fit in a double exactly.
const Q16 = 65536;
const posKey = (P, i) => (Math.round(P[i * 3] * 2e4) + 32768) * Q16 * Q16 + (Math.round(P[i * 3 + 1] * 2e4) + 32768) * Q16 + Math.round(P[i * 3 + 2] * 2e4) + 32768;
const nrmKey = (x, y, z) => ((Math.round(x * 500) + 512) * 1024 + Math.round(y * 500) + 512) * 1024 + Math.round(z * 500) + 512;
function weld(P, n) {
  const ids = new Map(), out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = posKey(P, i);
    let g = ids.get(k);
    if (g === undefined) { g = ids.size; ids.set(k, g); }
    out[i] = g;
  }
  return [out, ids.size];
}
function smoothPart(p, levels = 2) {
  const { pos, idx } = p;
  const nT = idx.length / 3;
  const [gid, nG] = weld(pos, pos.length / 3);
  // area-weighted face normals (and unit ones), and the faces around each welded point
  const fn = new Float64Array(nT * 3), fu = new Float64Array(nT * 3);
  const cnt = new Uint32Array(nG + 1);
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
    fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
    fu[t * 3] = x / l; fu[t * 3 + 1] = y / l; fu[t * 3 + 2] = z / l;
    for (let k = 0; k < 3; k++) cnt[gid[idx[t * 3 + k]] + 1]++;
  }
  for (let g = 0; g < nG; g++) cnt[g + 1] += cnt[g];
  const around = new Uint32Array(nT * 3), fill = cnt.slice(0, nG);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) around[fill[gid[idx[t * 3 + k]]]++] = t;
  // one output vertex per corner, merged when position and normal match
  const P = [], N = [], I = [];
  const vmap = new Map();
  for (let t = 0; t < nT; t++) {
    const fx = fu[t * 3], fy = fu[t * 3 + 1], fz = fu[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k], g = gid[v];
      let sx = 0, sy = 0, sz = 0;
      for (let j = cnt[g]; j < cnt[g + 1]; j++) {
        const u = around[j] * 3;
        if (fu[u] * fx + fu[u + 1] * fy + fu[u + 2] * fz < CREASE) continue;
        sx += fn[u]; sy += fn[u + 1]; sz += fn[u + 2];
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      let nx = sx / l, ny = sy / l, nz = sz / l;
      // keep the source normal's side
      if (nx * p.nrm[v * 3] + ny * p.nrm[v * 3 + 1] + nz * p.nrm[v * 3 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const mk = g * 2 ** 30 + nrmKey(nx, ny, nz);
      let o = vmap.get(mk);
      if (o === undefined) {
        o = P.length / 3; vmap.set(mk, o);
        P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); N.push(nx, ny, nz);
      }
      I.push(o);
    }
  }
  let mesh = [P, N, I];
  for (let l = 0; l < levels; l++) mesh = pnSplit(...mesh);
  return { name: p.name, pos: new Float32Array(mesh[0]), nrm: new Float32Array(mesh[1]), idx: new Uint32Array(mesh[2]) };
}

/** The shell file is already subdivided, with its own hard-edge normals. One
    PN level on top makes it as smooth as two baked levels at a third of the
    download. Edges where the normals split stay straight, so seams stay sharp. */
function pnPart(p) {
  const [P, N, I] = pnSplit(Array.from(p.pos), Array.from(p.nrm), Array.from(p.idx));
  return { name: p.name, pos: new Float32Array(P), nrm: new Float32Array(N), idx: new Uint32Array(I) };
}

/** One level of PN-triangle subdivision: every triangle becomes four. */
function pnSplit(P, N, I) {
  P = P.slice(); N = N.slice();
  const nV = P.length / 3;
  const [wid] = weld(P, nV);
  const nk = new Float64Array(nV);
  for (let v = 0; v < nV; v++) nk[v] = nrmKey(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
  // An edge is smooth when both sides use the same normals at both ends.
  // side[edge] = [normal at lower point, normal at higher point], or null.
  const side = new Map();
  const eKey = (a, b) => (wid[a] < wid[b] ? wid[a] * 2 ** 26 + wid[b] : wid[b] * 2 ** 26 + wid[a]);
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = I[t + k], b = I[t + ((k + 1) % 3)], key = eKey(a, b);
    const lo = wid[a] <= wid[b] ? a : b, hi = lo === a ? b : a;
    const s = side.get(key);
    if (s === undefined) side.set(key, [nk[lo], nk[hi]]);
    else if (s && (s[0] !== nk[lo] || s[1] !== nk[hi])) side.set(key, null);
  }
  const mids = new Map(), out = [];
  const mid = (a, b) => {
    const mk = a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a;
    let m = mids.get(mk);
    if (m !== undefined) return m;
    const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], pb = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
    const na = [N[a * 3], N[a * 3 + 1], N[a * 3 + 2]], nb = [N[b * 3], N[b * 3 + 1], N[b * 3 + 2]];
    const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let q = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    if (side.get(eKey(a, b)) !== null) {
      // cubic Bezier edge: b1 = (2a + b - (d.na) na) / 3, b2 = (2b + a + (d.nb) nb) / 3
      const wa = dot(d, na), wb = dot(d, nb);
      q = q.map((v, i) => v + (3 / 8) * (-(wa * na[i]) + wb * nb[i]) / 3);
    }
    // quadratic normal at the middle of the edge
    const s = [na[0] + nb[0], na[1] + nb[1], na[2] + nb[2]];
    const dd = dot(d, d) || 1, v = (2 * dot(d, s)) / dd;
    let h = s.map((x, i) => x - v * d[i]);
    const hl = Math.hypot(...h) || 1; h = h.map((x) => x / hl);
    let n = [0, 1, 2].map((i) => 0.25 * na[i] + 0.5 * h[i] + 0.25 * nb[i]);
    const nl = Math.hypot(...n) || 1; n = n.map((x) => x / nl);
    m = P.length / 3;
    P.push(...q); N.push(...n);
    mids.set(mk, m);
    return m;
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return [P, N, out];
}

/* The robot's own colours (sRGB 0..1) and the face plate in model space:
   centre x, y and half width, half height. The face in the atlas (face.js,
   384 × 307) has the same aspect as this rect, at the scale of the real
   face seen through the visor. */
const ROBOT = {
  body: [0x2a / 255, 0x85 / 255, 0x98 / 255],
  plate: [0xce / 255, 0xdc / 255, 0xe6 / 255],
  face: [0, 0.28583, 0.07962, 0.0636],
};

/* A flat disk on the floor, for the contact shadow. */
function diskPart(name, r, y) {
  const n = 48, pos = [0, y, 0], nrm = [0, 1, 0], idx = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    nrm.push(0, 1, 0);
    if (i < n) idx.push(0, i + 2, i + 1);
  }
  return { name, pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint32Array(idx) };
}

/* One queue submit for the stages drawn in one task: a stage that draws
   another from its hooks (for example a second view of the same scene,
   through stage.renderNow in afterRender) sends both command buffers at
   once. Each stage has its own uniform buffers, so the order of their
   writeBuffer calls does not matter. */
let pending = null;
function submit(device, cmd) {
  if (pending) pending.push(cmd);
  else device.queue.submit([cmd]);
}
function oneSubmit(device, fn) {
  if (pending) { fn(); return; }
  pending = [];
  try { fn(); } finally {
    const cmds = pending;
    pending = null;
    if (cmds.length) device.queue.submit(cmds);
  }
}

let gpuP = null;
function getGPU() {
  if (!gpuP) {
    gpuP = (async () => {
      if (!navigator.gpu) throw new Error('no-webgpu');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no-webgpu');
      const device = await adapter.requestDevice();
      // A lost device cannot be reused: the next stage asks for a new one.
      device.lost.then(() => { gpuP = null; });
      device.addEventListener?.('uncapturederror', (e) => console.error('viz: WebGPU', e.error?.message || e.error));
      const format = navigator.gpu.getPreferredCanvasFormat();
      const U = GPUShaderStage, F = U.FRAGMENT;
      const bgl = (...entries) => device.createBindGroupLayout({ entries: entries.map((e, binding) => ({ binding, visibility: F, ...e })) });
      const layout = (...bgls) => device.createPipelineLayout({ bindGroupLayouts: bgls });
      const tex = (sampleType) => ({ texture: { sampleType } });
      const frameBGL = bgl({ visibility: U.VERTEX | F, buffer: {} });
      const partBGL = bgl({ visibility: U.VERTEX | F, buffer: { hasDynamicOffset: true } });
      const aoBGL = bgl(tex('unfilterable-float'), tex('depth'), { buffer: {} });
      const shBGL = bgl(tex('depth'), { sampler: { type: 'comparison' } });
      const blurBGL = bgl(tex('unfilterable-float'), tex('depth'), { buffer: {} }, tex('unfilterable-float'));
      const litBGL = bgl({ buffer: {} }, tex('uint'), tex('unfilterable-float'), tex('float'), { sampler: { type: 'filtering' } });
      const outBGL = bgl(tex('unfilterable-float'));
      const geoMod = device.createShaderModule({ code: GEO_WGSL });
      const aoMod = device.createShaderModule({ code: AO_WGSL });
      const litMod = device.createShaderModule({ code: LIT_WGSL });
      const outMod = device.createShaderModule({ code: OUT_WGSL });
      const vbuf = (loc) => ({ arrayStride: 12, attributes: [{ shaderLocation: loc, offset: 0, format: 'float32x3' }] });
      const tri = { topology: 'triangle-list', cullMode: 'none' };
      const geo = device.createRenderPipeline({
        layout: layout(frameBGL, partBGL),
        vertex: { module: geoMod, entryPoint: 'vs', buffers: [vbuf(0), vbuf(1)] },
        fragment: { module: geoMod, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'r32uint' }] },
        primitive: tri,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      });
      const shadow = device.createRenderPipeline({
        layout: layout(frameBGL, partBGL),
        vertex: { module: geoMod, entryPoint: 'vsShadow', buffers: [vbuf(0)] },
        primitive: tri,
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
      });
      const full = (mod, entryPoint, bgls, fmt) => device.createRenderPipeline({
        layout: layout(...bgls),
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint, targets: [{ format: fmt }] },
        primitive: { topology: 'triangle-list' },
      });
      const ao = full(aoMod, 'ao', [aoBGL, shBGL], 'rgba16float');
      const blur = full(aoMod, 'blur', [blurBGL], 'rgba16float');
      const out = full(outMod, 'fs', [outBGL], format);
      const lit = device.createRenderPipeline({
        layout: layout(frameBGL, partBGL, litBGL),
        vertex: { module: litMod, entryPoint: 'vs', buffers: [vbuf(0), vbuf(1)] },
        fragment: { module: litMod, entryPoint: 'fs', targets: [{ format: `${format}-srgb` }] },
        primitive: tri,
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        multisample: { count: 4 },
      });
      // See-through shells (X-ray): same pass as lit, blended, no depth
      // writes, front faces only so each shell shows one layer.
      const ghost = device.createRenderPipeline({
        layout: layout(frameBGL, partBGL, litBGL),
        vertex: { module: litMod, entryPoint: 'vs', buffers: [vbuf(0), vbuf(1)] },
        fragment: {
          module: litMod, entryPoint: 'ghost',
          targets: [{
            format: `${format}-srgb`,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        multisample: { count: 4 },
      });
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
      return { device, format, frameBGL, partBGL, aoBGL, shBGL, blurBGL, litBGL, outBGL, geo, shadow, ao, blur, lit, ghost, out, sampler, shadowSampler };
    })();
    // Do not cache a failure (for example an adapter request during a GPU
    // process restart); a later figure may try again.
    gpuP.catch(() => { gpuP = null; });
  }
  return gpuP;
}

const modelCache = new Map();
function loadModel(url) {
  if (!modelCache.has(url)) {
    modelCache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`model ${r.status}`);
      return r.arrayBuffer();
    }).then(parseGLB));
  }
  return modelCache.get(url);
}

/* The face atlas (face.js): fetched and decoded once per URL. An image of
   another size (an old copy in the browser cache) is fetched once more past
   the cache. */
const faceCache = new Map();
function loadFace(url) {
  if (!faceCache.has(url)) {
    const get = (cache) => fetch(url, { cache }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((b) => createImageBitmap(b));
    const fits = (bmp) => bmp.width === FACE.size[0] && bmp.height === FACE.size[1];
    const p = get('default').then((bmp) => (fits(bmp) ? bmp : get('reload')))
      .then((bmp) => (fits(bmp) ? bmp : Promise.reject(new Error(`face image is ${bmp.width} × ${bmp.height}`))));
    p.catch(() => faceCache.delete(url)); // a later stage may try again
    faceCache.set(url, p);
  }
  return faceCache.get(url);
}

/* One face texture per GPU device, shared by every stage on the page. It
   shows the plain plate colour until the atlas arrives, then the image is
   copied in once. Expressions are uniforms, so it never changes again. */
const faceTextures = new WeakMap();
function faceTexture(device, url) {
  let f = faceTextures.get(device);
  if (!f) {
    const tex = device.createTexture({
      size: FACE.size, format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const enc = device.createCommandEncoder();
    const [r, g, b] = ROBOT.plate;
    enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a: 1 } }] }).end();
    device.queue.submit([enc.finish()]);
    f = { tex, view: tex.createView(), ready: null };
    faceTextures.set(device, f);
  }
  if (url && !f.ready) {
    const ready = loadFace(url).then((bmp) => {
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: f.tex }, FACE.size);
    });
    ready.catch((err) => { if (f.ready === ready) f.ready = null; console.warn('viz: face image', err); });
    f.ready = ready;
  }
  return f;
}

/** Resolve a CSS colour token on the figure to [r, g, b] in 0..1. */
function tokenRGB(el, name) {
  const v = getComputedStyle(el).getPropertyValue(name).trim() || '#000';
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#000';
  x.fillStyle = v;
  x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function onThemeChange(cb) {
  new MutationObserver(cb).observe(document.documentElement, { attributes: true, attributeFilter: ['data-force-dark', 'class'] });
}

/* The studio, in view space (x right, y up, z toward the camera). Each light
   is a soft round source: direction, sharpness (higher is smaller), colour and
   strength. 'up' and 'down' follow the world. The first light casts the
   shadow; keySize is the tangent of its angular radius. */
const STUDIO = {
  exposure: 1, face: 1, keySize: 0.15,
  lights: [
    [[-0.5, 0.62, 0.6], 9, [1, 0.97, 0.93], 3.2],  // key: soft box up and to the left
    [[0.85, 0.15, 0.5], 4, [0.92, 0.96, 1], 0.6],  // fill: right
    [[-0.75, 0.3, -0.6], 10, [1, 1, 1], 2],        // rim: back left
    [[0.7, 0.45, -0.55], 10, [1, 1, 1], 1.8],      // rim: back right
    ['up', 2.2, [0.9, 0.95, 1], 0.7],              // big soft box overhead
    ['down', 1.6, [1, 0.94, 0.86], 0.18],          // bounce from the floor
  ],
};
/* Shadow map box: centre, half size and depth range (metres). */
const SHADOW = { centre: [0, 0.18, 0], r: 0.62, near: 1.2, far: 2.8 };
const srgbLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const nrm3 = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
/** A world direction in view space (column-major view matrix). */
const toView = (view, d) => nrm3([0, 1, 2].map((r) => view[r] * d[0] + view[4 + r] * d[1] + view[8 + r] * d[2]));

/**
 * A WebGPU stage in a figure. State the caller sets: rot[group] = [x, y, z]
 * radians, selected (Set of part names), target, dist, xray (0..1), fov
 * (vertical field of view, radians; default 30°).
 * Hooks: tick(now) → still animating?, afterRender(), onPick(partName),
 * onVisibility(visible). Methods: render(), stopAuto(), aim(view, instant),
 * project(group, point), and w / h (CSS size of the canvas).
 *
 * opts.parts replaces the default projector block with the caller's own
 * extra meshes ({ name, pos, nrm, idx }, e.g. from innards.js), each
 * with optional group (pivot group it moves with; default from PART_GROUP,
 * else 'base'), kind (shader kind, see PART_KIND) and inner (true: drawn only
 * when xray > 0, hidden inside the shell otherwise).
 *
 * X-ray: when xray > 0 the model's shells leave the depth, shadow and pick
 * passes and are drawn last as a see-through ghost; inner parts appear.
 *
 * opts.far sets the far clip plane (metres, default 5). Hook overlay(pass,
 * { viewProj, eye, w, h }) draws extra geometry at the end of the lit pass
 * (4× MSAA, sRGB colour, depth24plus), so the robot hides it.
 *
 * opts.env = 'garden' puts the robot on a lawn in a procedural garden (see
 * garden.js): day in the light theme, dusk in the dark one, sunlight and its
 * shadow, a soft depth-of-field background. The floor disk is not drawn, and
 * the far plane moves to 90 m. Scenery between the eye and opts.clear
 * ({ r, y0, y1 }: a cylinder round the robot that must stay in view;
 * default the robot only) fades out.
 *
 * opts.orbit limits the camera: { pitch: [min, max] (radians), zoom: [min,
 * max], reach (m) }. reach caps the zoom so the eye stays that close to the
 * robot, measured flat on the ground; in the garden it defaults to 2.3 m,
 * inside the clearing, where nothing tall stands.
 *
 * opts.body ([r, g, b], sRGB 0..1) replaces the robot's body colour.
 * opts.envNeutral (0..1) takes the colour out of the garden's light on the
 * robot (see garden.js), so a white body reads white at dusk too.
 *
 * opts.look replaces the studio lights (same shape as STUDIO), and
 * opts.board ([r, g, b], sRGB 0..1) replaces the page colour behind the
 * robot and on the floor disk.
 *
 * stage.face sets the expression: { mood, level (0..2), lids (0 open, 1
 * half, 2 closed), mouth (a mouth cell, see face.js), eye (an eye cell that
 * replaces mood, level and lids) }, or null for the
 * resting face (relaxed eyes, small smile). Blinks play on top of it.
 * opts.aspect (height / width) sets a fixed canvas shape, at most 460 px high.
 */
async function makeStage(fig, host, url, opts = {}) {
  const G = await getGPU();
  const model = await loadModel(url);
  const { device } = G;
  // the garden scene (garden.glb, next to the robot model unless
  // opts.envUrl says otherwise) loads once per page; draw again when it lands
  const env = opts.env === 'garden'
    ? makeGarden(G, {
      url: opts.envUrl || new URL('garden.glb', url).href,
      clear: opts.clear,
      turn: opts.envTurn || 0,
      neutral: opts.envNeutral,
      // before the stage exists its first draw already has the scene
      onReady: () => { try { stage.render(); } catch { /* not built yet */ } },
    })
    : null;
  let look = opts.look || STUDIO;
  const piv = model.piv;
  const parts = [
    ...model.parts.filter((p) => p.name !== 'eyes').map((p) => ({ ...p, shell: true })),
    // default: the projector at the top of the head and its mirror
    ...(opts.parts || headParts()),
    diskPart('ground', 0.7, -0.001),
  ];
  const meshes = parts.map((p) => {
    const mk = (arr, usage) => {
      const b = device.createBuffer({ size: Math.ceil(arr.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, arr);
      return b;
    };
    return {
      name: p.name, pos: mk(p.pos, GPUBufferUsage.VERTEX), nrm: mk(p.nrm, GPUBufferUsage.VERTEX), idx: mk(p.idx, GPUBufferUsage.INDEX), count: p.idx.length,
      group: p.group || PART_GROUP[p.name] || 'base', kind: p.kind ?? PART_KIND[p.name] ?? 0, inner: !!p.inner, shell: !!p.shell,
    };
  });
  // One id per part name (a part may have one mesh per material), so the
  // outline and picking treat a part as one thing.
  const names = [...new Set(meshes.map((m) => m.name))];
  meshes.forEach((m) => { m.pid = names.indexOf(m.name) + 1; });
  const SLOT = 256;
  const UB = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const frameBuf = device.createBuffer({ size: 256, usage: UB });
  const partBuf = device.createBuffer({ size: SLOT * meshes.length, usage: UB });
  const styleBuf = device.createBuffer({ size: 320, usage: UB });
  const aoBuf = device.createBuffer({ size: 128, usage: UB });
  const pickBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const frameBG = device.createBindGroup({ layout: G.frameBGL, entries: [{ binding: 0, resource: { buffer: frameBuf } }] });
  const partBG = device.createBindGroup({ layout: G.partBGL, entries: [{ binding: 0, resource: { buffer: partBuf, size: 80 } }] });
  // CPU-side uniform data, allocated once and reused every frame
  const styleArr = new Float32Array(80), frameArr = new Float32Array(52), aoArr = new Float32Array(32), invView = new Float32Array(16);
  const partArr = new ArrayBuffer(SLOT * meshes.length);
  const partMat = meshes.map((m, i) => new Float32Array(partArr, i * SLOT, 16));
  const partCode = meshes.map((m, i) => new Uint32Array(partArr, i * SLOT + 64, 1));
  const unpivot = meshes.map((m) => { const p = model.piv[GROUP_PIVOT[m.group]]; return M4.t(-p[0], -p[1], -p[2]); });

  // Drop a canvas left by an earlier start, so only one view shows.
  host.querySelectorAll(`canvas.${P}gl`).forEach((c) => c.remove());
  // hidden until its first real frame: an unpainted WebGPU canvas shows black
  const canvas = h('canvas', { class: `${P}gl`, style: 'visibility: hidden' });
  host.prepend(canvas);
  const ctx = canvas.getContext('webgpu');
  if (!ctx) { canvas.remove(); throw new Error('no-webgpu'); }
  // The lit pass resolves straight into an sRGB view of the canvas. Where
  // the browser has no such view, it resolves into a texture and a last pass
  // encodes sRGB.
  const srgb = `${G.format}-srgb`;
  let direct = false;
  try {
    device.pushErrorScope('validation');
    ctx.configure({ device, format: G.format, alphaMode: 'opaque', viewFormats: [srgb] });
    ctx.getCurrentTexture().createView({ format: srgb });
    direct = !(await device.popErrorScope());
  } catch { await device.popErrorScope().catch(() => {}); }
  try {
    if (!direct) ctx.configure({ device, format: G.format, alphaMode: 'opaque' });
  } catch (err) { canvas.remove(); throw err; }

  let tex = null, tv = null, bgs = null, dpr = 1, cssW = 0, cssH = 0, shadowSize = 2048;
  function makeTargets() {
    for (const t of tex ? Object.values(tex) : []) t.destroy();
    const size = [canvas.width, canvas.height];
    const T = GPUTextureUsage, RT = T.RENDER_ATTACHMENT, TB = T.TEXTURE_BINDING;
    const mk = (format, usage, extra = {}) => device.createTexture({ size, format, usage, ...extra });
    const half = size.map((x) => Math.max(1, Math.ceil(x / 2)));
    shadowSize = canvas.width >= 1000 ? 2048 : 1024;
    tex = {
      n: mk('rgba16float', RT | TB),
      id: mk('r32uint', RT | TB | T.COPY_SRC),
      d: mk('depth24plus', RT | TB),
      aoRaw: mk('rgba16float', RT | TB, { size: half }),
      ao: mk('rgba16float', RT | TB, { size: half }),
      msc: mk(srgb, RT, { sampleCount: 4 }),
      msd: mk('depth24plus', RT, { sampleCount: 4 }),
      sh: device.createTexture({ size: [shadowSize, shadowSize], format: 'depth32float', usage: RT | TB }),
    };
    if (!direct) tex.col = mk(srgb, RT | TB);
    const bg = (layout, ...res) => device.createBindGroup({ layout, entries: res.map((resource, binding) => ({ binding, resource })) });
    const v = (t) => t.createView();
    // one view per target, made once here instead of every frame
    tv = Object.fromEntries(Object.entries(tex).map(([k, t]) => [k, v(t)]));
    bgs = {
      ao: bg(G.aoBGL, v(tex.n), v(tex.d), { buffer: aoBuf }),
      sh: bg(G.shBGL, v(tex.sh), G.shadowSampler),
      blur: bg(G.blurBGL, v(tex.n), v(tex.d), { buffer: aoBuf }, v(tex.aoRaw)),
      lit: bg(G.litBGL, { buffer: styleBuf }, v(tex.id), v(tex.ao), faceAtlas.view, G.sampler),
    };
    if (!direct) bgs.out = bg(G.outBGL, v(tex.col));
    env?.resize(canvas.width, canvas.height, v(tex.sh));
  }

  const NEAR = 0.05, FAR = opts.far || (env ? 90 : 5);
  const colors = {};
  function paint() {
    colors.board = opts.board || tokenRGB(fig, '--board');
    colors.look = tokenRGB(fig, '--purple');
    colors.ink = tokenRGB(fig, '--ink');
    for (const k of ['board', 'look', 'ink']) colors[`${k}Lin`] = colors[k].map(srgbLin);
    colors.clear = [...colors.boardLin, 1];
    if (env) {
      const dark = luma(colors.board) < 0.5;
      env.setDark(dark);
      look = env.look(dark);
    }
    stage.render();
  }
  const bodyLin = (opts.body || ROBOT.body).map(srgbLin), plateLin = ROBOT.plate.map(srgbLin);
  function writeStyle(view) {
    const st = styleArr;
    const put = (i, c, w = 1) => { st[i * 4] = c[0]; st[i * 4 + 1] = c[1]; st[i * 4 + 2] = c[2]; st[i * 4 + 3] = w; };
    put(0, colors.boardLin); put(1, colors.lookLin); put(2, bodyLin); put(3, plateLin);
    put(4, [Math.max(1, Math.round(dpr * 1.5)), stage.xray, look.exposure], look.face);
    st.set(ROBOT.face, 20);
    const fc = stage.face, mood = fc?.mood ?? 'rest'; // at rest: relaxed eyes and a small smile
    // fc.eye: an eye cell set directly (a clip's own face); a blink still wins
    const eye = fc?.eye != null && !blinkLids ? fc.eye : eyeCell(mood, fc?.level ?? 1, Math.max(fc?.lids ?? 0, blinkLids));
    put(6, [eye, fc?.mouth ?? moodMouth(mood), 0], 0);
    put(7, colors.inkLin);
    const up = [view[4], view[5], view[6]];
    look.lights.forEach(([ax, sharp, rgb, k, space], i) => {
      const a = ax === 'up' ? up : ax === 'down' ? up.map((x) => -x) : space === 'world' ? toView(view, ax) : nrm3(ax);
      put(8 + i * 2, a, sharp);
      put(9 + i * 2, rgb.map((x) => x * k), 0);
    });
    device.queue.writeBuffer(styleBuf, 0, st);
  }

  // the shared face atlas: the plate colour until the image loads
  const faceAtlas = faceTexture(device, fig.dataset.face ? new URL(fig.dataset.face, document.baseURI).href : null);

  let yaw = 0.45, pitch = 0.12, auto = !REDUCED, visible = false, raf = 0, dirty = true;
  let W = null, viewProj = null;

  let shown = false;
  function draw() {
    if (!shown) { canvas.style.visibility = ''; shown = true; }
    const d = stage.dist * Math.min(zoom, zoomCap());
    const eye = [
      stage.target[0] + Math.sin(yaw) * Math.cos(pitch) * d,
      stage.target[1] + Math.sin(pitch) * d,
      stage.target[2] + Math.cos(yaw) * Math.cos(pitch) * d,
    ];
    const view = M4.lookAt(eye, stage.target, [0, 1, 0]);
    const proj = M4.persp(stage.fov || 30 * DEG, canvas.width / canvas.height, NEAR, FAR);
    viewProj = M4.mul(proj, view);
    // The studio key light turns with the camera; the garden sun stays put in
    // the world. Its shadow map is an orthographic box around the robot and
    // the floor near it.
    const key = look.lights[0];
    const kw = key[4] === 'world' ? nrm3(key[0]) : (() => {
      const k = nrm3(key[0]);
      return [0, 1, 2].map((r) => k[0] * view[r * 4] + k[1] * view[r * 4 + 1] + k[2] * view[r * 4 + 2]);
    })();
    const kv = toView(view, kw);
    const shR = look.shadowR || SHADOW.r;
    const c = SHADOW.centre, le = c.map((x, k) => x + kw[k] * 2);
    const lightVP = M4.mul(M4.ortho(shR, SHADOW.near, SHADOW.far), M4.lookAt(le, c, Math.abs(kw[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
    writeStyle(view);
    const fb = frameArr;
    fb.set(viewProj, 0);
    fb.set(view, 16);
    fb.set(lightVP, 32);
    device.queue.writeBuffer(frameBuf, 0, fb);
    // occlusion and shadow work in view space: view → world → light clip
    invView.set([view[0], view[4], view[8], 0, view[1], view[5], view[9], 0, view[2], view[6], view[10], 0, eye[0], eye[1], eye[2], 1]);
    const ab = aoArr;
    // AO radius 1.5 cm, power 1, bias 3 mm
    ab.set([proj[0], proj[5], NEAR, FAR, 0.015, 1.0, 0.003, 0], 0);
    M4.mul(lightVP, invView, ab.subarray(8, 24));
    ab.set([shadowSize, 1 / (2 * shR), (SHADOW.far - SHADOW.near) * look.keySize, 2 * shR / shadowSize], 24);
    ab.set([kv[0], kv[1], kv[2], 0], 28);
    device.queue.writeBuffer(aoBuf, 0, ab);

    W = groupWorlds(piv, stage.rot);
    if (stage.lift) for (const g in W) W[g][13] += stage.lift; // the robot stands on something (Fig. 3: a stump)
    meshes.forEach((m, i) => {
      M4.mul(W[m.group], unpivot[i], partMat[i]);
      partCode[i][0] = m.pid | (m.kind << 8) | (stage.selected.has(m.name) ? 4096 : 0);
    });
    device.queue.writeBuffer(partBuf, 0, partArr);

    const groundY = W.base[13] - 0.001;
    const below = eye[1] < groundY; // seen from below: no floor
    const enc = device.createCommandEncoder();
    const depth = (view, store = 'store') => ({ view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: store });
    const target = (view, clear = [0, 0, 0, 0]) => ({ view, clearValue: clear, loadOp: 'clear', storeOp: 'store' });
    // X-ray: shells leave the solid passes and come back as a ghost at the
    // end of the lit pass; the inner parts show only then.
    const xr = stage.xray;
    const solid = (m) => (m.inner ? xr > 0 : !(xr > 0 && m.shell));
    const noGround = (m) => solid(m) && m.name !== 'ground';
    const withGround = (m) => solid(m) && (m.name !== 'ground' || (!below && !env));
    const meshPass = (pass, pipe, nrm, keep, bg2, end = true) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, frameBG);
      if (bg2) pass.setBindGroup(2, bg2);
      meshes.forEach((m, i) => {
        if (!keep(m)) return;
        pass.setBindGroup(1, partBG, [i * SLOT]);
        pass.setVertexBuffer(0, m.pos);
        if (nrm) pass.setVertexBuffer(1, m.nrm);
        pass.setIndexBuffer(m.idx, 'uint32');
        pass.drawIndexed(m.count);
      });
      if (end) pass.end();
    };
    const fullPass = (pipe, bg, view, bg1) => {
      const pass = enc.beginRenderPass({ colorAttachments: [target(view, [1, 1, 1, 1])] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      if (bg1) pass.setBindGroup(1, bg1);
      pass.draw(3);
      pass.end();
    };
    meshPass(enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: depth(tv.sh) }), G.shadow, false, noGround);
    meshPass(enc.beginRenderPass({ colorAttachments: [target(tv.n), target(tv.id)], depthStencilAttachment: depth(tv.d) }), G.geo, true, withGround);
    fullPass(G.ao, bgs.ao, tv.aoRaw, bgs.sh);
    fullPass(G.blur, bgs.blur, tv.ao);
    if (env) {
      env.frame({
        invViewProj: M4.inv(viewProj), eye, proj, time: windT, blobs: stage.blobs?.(),
        focus: Math.hypot(...eye.map((x, k) => x - stage.target[k])), xray: xr, dpr, cssW, blur: stage.blur ?? 1,
      });
      env.encode(enc, frameBG);
    }
    const litPass = enc.beginRenderPass({
      colorAttachments: [{ view: tv.msc, resolveTarget: direct ? ctx.getCurrentTexture().createView({ format: srgb }) : tv.col, clearValue: colors.clear, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: depth(tv.msd, 'discard'),
    });
    env?.background(litPass);
    meshPass(litPass, G.lit, true, withGround, bgs.lit, false);
    if (xr > 0) meshPass(litPass, G.ghost, true, (m) => m.shell, bgs.lit, false);
    stage.overlay?.(litPass, { viewProj, eye, w: canvas.width, h: canvas.height });
    litPass.end();
    if (!direct) fullPass(G.out, bgs.out, ctx.getCurrentTexture().createView());
    submit(device, enc.finish());
  }

  /* Camera moves (aim): yaw, pitch, target and distance ease toward the goal
     with a 0.14 s time constant; zoom eases back to 1. Dragging cancels. */
  let goal = null, lastFly = 0;
  const wrapPi = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  function fly(now) {
    if (!goal) return false;
    const dt = lastFly ? Math.min((now - lastFly) / 1000, 0.1) : 1 / 60;
    lastFly = now;
    const k = REDUCED || goal.instant ? 1 : 1 - Math.exp(-dt / 0.14);
    const dy = wrapPi(goal.yaw - yaw);
    yaw += dy * k;
    pitch += (goal.pitch - pitch) * k;
    for (let i = 0; i < 3; i++) stage.target[i] += (goal.target[i] - stage.target[i]) * k;
    stage.dist += (goal.dist - stage.dist) * k;
    const near = Math.abs(dy) < 1e-3 && Math.abs(goal.pitch - pitch) < 1e-3 && Math.abs(goal.dist - stage.dist) < 1e-4
      && goal.target.every((v, i) => Math.abs(v - stage.target[i]) < 1e-4);
    if (near || k === 1) {
      yaw = goal.yaw; pitch = goal.pitch; stage.dist = goal.dist;
      goal.target.forEach((v, i) => { stage.target[i] = v; });
      goal = null;
    }
    return true;
  }

  /* Zoom is a dolly: zoom eases toward zoomGoal (0.12 s time constant). */
  let lastZoom = 0;
  function dolly(now) {
    if (Math.abs(zoomGoal - zoom) < 1e-4) { zoom = zoomGoal; lastZoom = 0; return false; }
    const dt = lastZoom ? Math.min((now - lastZoom) / 1000, 0.1) : 1 / 60;
    lastZoom = now;
    const k = REDUCED ? 1 : 1 - Math.exp(-dt / 0.12);
    zoom += (zoomGoal - zoom) * k;
    return true;
  }

  /* Frames on demand. Nothing moves: no frames at all. A drag or a pinch
     draws on the next display frame. Everything else (camera moves, zoom
     buttons, a figure's tick, render() calls) draws at most 30 times a
     second: the motion data is 30 fps. Off screen or in a hidden tab: no
     work. The grass sways only while the user drags the view. */
  let lost = false, lastDraw = -1e9, urgent = false, wait = 0, windT = 0, lastWind = 0;
  function queue() {
    if (raf || !visible || lost || document.hidden) return;
    if (urgent && wait) { clearTimeout(wait); wait = 0; }
    if (wait) return;
    const left = urgent ? 0 : wakeIn(lastDraw);
    if (left > 1) wait = setTimeout(() => { wait = 0; queue(); }, left);
    else raf = requestAnimationFrame(frame);
  }
  // ext: a figure's own loop draws this frame (stage.renderNow), already at
  // most 30 times a second; then the stage asks no frames for itself, except
  // for camera moves.
  function frame(now, ext = false) {
    raf = 0;
    now = now ?? performance.now();
    if (!visible || lost || document.hidden || !canvas.isConnected) return;
    // The cap runs on the display clock: rAF times are whole display frames,
    // so a frame less than one 30 fps step after the last waits for the next.
    if (!urgent && !ext && now - lastDraw < FRAME_MS - 3) { raf = requestAnimationFrame(frame); return; }
    if (auto) { yaw += 0.24 * Math.min(now - lastDraw, 100) / 1000; dirty = true; }
    const flying = fly(now);
    const zooming = dolly(now);
    const busy = stage.tick?.(now) || false;
    if (dirty || busy || flying || zooming || blinkT0 >= 0) {
      blink(now);
      if (drag?.moved || pinch) windT += Math.min(now - lastWind, 50) / 1000;
      lastWind = now;
      lastDraw = now;
      urgent = dirty = false;
      // a stage drawn from this one's hooks (stage.renderNow in afterRender)
      // goes into the same queue submit
      oneSubmit(device, () => { draw(); stage.afterRender?.(); });
    }
    // tick() may call render() and queue a frame already; queue() never queues two.
    if (auto || goal || zooming || (!ext && (busy || blinkT0 >= 0))) queue();
  }

  let pickBusy = false;
  async function pick(px, py) {
    if (pickBusy || !tex || lost) return null;
    pickBusy = true;
    try {
      // CSS px → texel, from the canvas's real on-screen size.
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / (r.width || cssW || 1), sy = canvas.height / (r.height || cssH || 1);
      const x = clamp(Math.floor(px * sx), 0, canvas.width - 1), y = clamp(Math.floor(py * sy), 0, canvas.height - 1);
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex.id, origin: { x, y } }, { buffer: pickBuf, bytesPerRow: 256 }, { width: 1, height: 1 });
      device.queue.submit([enc.finish()]);
      await pickBuf.mapAsync(GPUMapMode.READ);
      const code = new Uint32Array(pickBuf.getMappedRange(0, 4))[0];
      pickBuf.unmap();
      const i = (code & 255) - 1;
      return i >= 0 && names[i] ? names[i] : null;
    } catch (err) {
      if (!lost) console.error('viz: pick', err);
      return null;
    } finally { pickBusy = false; }
  }

  /* Zoom moves the camera along its line to the target, so the robot stays
     centred. Only a pinch zooms: a trackpad pinch (the browser sends it as
     ctrl + wheel), two fingers on a touch screen, or the + and − buttons. A
     plain wheel still scrolls the page, so the figure never traps scrolling. */
  let zoom = 1, zoomGoal = 1;
  const orbit = { pitch: env ? [0.03, 0.8] : [-0.35, 0.8], zoom: [0.45, 1.8], reach: env ? 2.3 : Infinity, ...opts.orbit };
  const ZOOM_MIN = orbit.zoom[0];
  // the farthest zoom: orbit.zoom[1], or less where the eye would leave the
  // clearing (orbit.reach, flat distance from the robot)
  function zoomCap() {
    const flat = stage.dist * Math.cos(pitch), off = Math.hypot(stage.target[0], stage.target[2]);
    return clamp(flat > 1e-3 ? (orbit.reach - off) / flat : Infinity, ZOOM_MIN, orbit.zoom[1]);
  }
  function setZoom(z, instant = false) {
    const n = clamp(z, ZOOM_MIN, zoomCap());
    if (n === zoomGoal) return;
    zoomGoal = n;
    if (instant) { zoom = n; urgent = true; } // a pinch draws at once
    syncZoom();
    stage.render();
  }
  // at a limit the button is disabled, and its title says so
  function syncZoom() {
    zoomIn.disabled = zoomGoal <= ZOOM_MIN + 1e-6;
    zoomOut.disabled = zoomGoal >= zoomCap() - 1e-6;
    zoomIn.title = zoomIn.disabled ? 'Closest zoom' : 'Zoom in';
    zoomOut.title = zoomOut.disabled ? 'Farthest zoom' : 'Zoom out';
  }
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setZoom(zoomGoal * Math.exp(clamp(dy, -60, 60) * 0.005), true);
  }, { passive: false });
  const zoomIn = btn('+', () => setZoom(zoomGoal / 1.3), { 'aria-label': 'Zoom in', title: 'Zoom in' });
  const zoomOut = btn('−', () => setZoom(zoomGoal * 1.3), { 'aria-label': 'Zoom out', title: 'Zoom out' });
  host.querySelectorAll(`.${P}zoom`).forEach((z) => z.remove());
  const zoomBar = h('div', { class: `${P}zoom`, role: 'group', 'aria-label': 'Zoom' }, zoomIn, zoomOut);

  let drag = null, pinch = null;
  const touches = new Map();
  const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
  const lift = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.pointerType === 'touch') touches.set(e.pointerId, [e.clientX, e.clientY]);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    auto = false;
    goal = null;
    if (touches.size === 2) { drag = null; pinch = { d: spread(), z: zoom }; return; }
    if (touches.size > 2) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw, pitch, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size >= 2) { setZoom(pinch.z * pinch.d / spread(), true); return; }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    yaw = drag.yaw - dx * 0.01;
    pitch = clamp(drag.pitch + dy * 0.006, orbit.pitch[0], orbit.pitch[1]);
    urgent = true;
    stage.render();
  });
  canvas.addEventListener('pointerup', async (e) => {
    lift(e);
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    // a new pitch may lower the zoom cap: keep the buttons true to it
    if (d.moved) { zoomGoal = Math.min(zoomGoal, zoomCap()); zoom = Math.min(zoom, zoomGoal); syncZoom(); }
    if (d.moved || !stage.onPick) return;
    const r = canvas.getBoundingClientRect();
    const name = await pick(e.clientX - r.left, e.clientY - r.top);
    // empty space and the floor pick nothing: the figure clears its selection
    stage.onPick(name && name !== 'ground' ? name : null);
  });
  canvas.addEventListener('pointercancel', (e) => { lift(e); drag = null; });

  function resize() {
    if (lost) return;
    cssW = host.clientWidth || 300;
    // default about 3:2 in the 800 px text column; never taller than 520 px
    cssH = Math.round(opts.aspect ? Math.min(cssW * opts.aspect, 520) : clamp(cssW * 0.68, 300, 520));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    makeTargets();
    paint();
  }

  /* Blink: the lids of the current mood close and open over 5 frames, 33 ms
     apart, every 2.5–6 s. A blink never asks for frames by itself: it
     starts only in a frame that draws anyway (a drag, a camera move,
     playback), then runs to its end. An idle robot keeps its eyes open and
     the GPU idle. */
  const BLINK = [1, 2, 2, 1, 1];
  let blinkLids = 0, blinkAt = Infinity, blinkT0 = -1;
  const nextBlink = (now) => { blinkAt = now + 2500 + Math.random() * 3500; };
  function blink(now) {
    if (blinkT0 < 0) {
      if (now < blinkAt) return;
      // long idle: wait a little after activity starts, not blink at once
      if (now - blinkAt > 1000) { blinkAt = now + 600 + Math.random() * 2000; return; }
      blinkT0 = now;
    }
    const f = Math.floor((now - blinkT0) / 33);
    if (f < BLINK.length) { blinkLids = BLINK[f]; return; }
    blinkLids = 0; blinkT0 = -1; nextBlink(now);
  }

  const stage = {
    piv, rot: {}, selected: new Set(), target: [0, 0.19, 0], dist: 1.2, xray: 0, fov: 30 * DEG,
    get w() { return cssW; },
    get h() { return cssH; },
    render() { dirty = true; queue(); },
    /** Draw now, from the caller's own rAF loop (one loop for a figure). */
    renderNow(now = performance.now()) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      clearTimeout(wait); wait = 0;
      dirty = true;
      frame(now, true);
    },
    stopAuto() { auto = false; },
    face: null,
    /** Ease the camera to { yaw, pitch, target: [x, y, z], dist }. */
    aim(v, instant = false) {
      auto = false;
      goal = { ...v, target: [...v.target], instant };
      lastFly = 0;
      // a new framing starts at zoom 1; later + / − still work during the move
      zoomGoal = 1;
      if (instant || REDUCED) zoom = 1;
      if (zoomIn) syncZoom();
      if (instant) fly(performance.now());
      stage.render();
    },
    /** CSS pixel position of a point given in a group's local frame. */
    project(group, p) {
      if (!W || !viewProj) return { x: -99, y: -99 };
      const c = M4.apply(viewProj, M4.apply(W[group], p));
      return { x: (c[0] / c[3] * 0.5 + 0.5) * cssW, y: (-c[1] / c[3] * 0.5 + 0.5) * cssH };
    },
  };

  onThemeChange(paint);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paint);
  // Width changes (layout) and devicePixelRatio changes (zoom, other screen).
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth, d = Math.min(2, window.devicePixelRatio || 1);
    if (w && (w !== cssW || d !== dpr)) resize();
  });
  ro.observe(host);
  window.addEventListener('resize', () => { if (Math.min(2, window.devicePixelRatio || 1) !== dpr) resize(); });
  faceAtlas.ready?.then(() => { if (!lost) { stage.render(); if (!REDUCED) nextBlink(performance.now()); } }, () => {});
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) (fig.__stages ||= []).push(stage); // dev: for screenshots
  resize();
  host.append(zoomBar);
  draw();
  onVisible(fig, (vis) => {
    visible = vis;
    if (!vis) { clearTimeout(wait); wait = 0; }
    stage.onVisibility?.(vis);
    if (vis) stage.render();
  });
  // back from a hidden tab: finish whatever was waiting
  document.addEventListener('visibilitychange', () => { if (!document.hidden) queue(); });
  device.lost.then((info) => {
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(wait);
    ro.disconnect();
    for (const t of tex ? Object.values(tex) : []) t.destroy();
    tex = null;
    if (info?.reason === 'destroyed') return;
    host.querySelectorAll(`.${P}labels`).forEach((l) => { l.hidden = true; });
    zoomBar.remove();
    canvas.replaceWith(h('p', { class: `${P}load` }, 'The GPU device was lost. Reload the page to see the model.'));
  });
  return stage;
}

/** Mount a 3D figure when it nears the screen. Without WebGPU, show the image. */
function lazy3D(fig, host, start) {
  const msg = h('p', { class: `${P}load` }, 'Loading the 3D model…');
  host.append(msg);
  let started = false;
  onVisible(fig, (vis) => {
    if (!vis || started) return;
    started = true;
    start().then(() => msg.remove()).catch((err) => {
      // Remove any half-built 3D view, then show the still image once.
      host.querySelectorAll(`canvas.${P}gl, .${P}still, .${P}zoom`).forEach((c) => c.remove());
      host.querySelectorAll(`.${P}labels`).forEach((l) => { l.hidden = true; });
      const img = fig.querySelector('.wv-fallback')?.cloneNode();
      if (img) { img.classList.remove('wv-fallback'); img.classList.add(`${P}still`); }
      msg.textContent = err?.message === 'no-webgpu'
        ? 'This 3D view needs WebGPU, and this browser does not have it. Here is a still image of the same model.'
        : `The 3D model could not load (${err?.message || err}). Here is a still image of the same model.`;
      if (err?.message !== 'no-webgpu') console.error('viz:', fig.dataset.viz, err);
      host.classList.add(`${P}off`);
      if (img) host.prepend(img);
    });
  });
}

/* ------------------------------------------------- Fig. 1 robot-parts */

/* The parts inside the shell come from innards.js: small low-poly models,
   placed at least 2 mm inside the shell (a dev check below proves it).

   Cables, from the part to the board it plugs into (model space, metres).
   flow: 'in' data runs toward the board, 'out' away from it, 'both' both
   ways (no pulse). */
const WIRES = {
  cam: { bus: 'MIPI CSI', flow: 'in', labAt: 0.22, pts: [[0, 0.349, 0.016], [-0.025, 0.33, 0.005], [-0.03, 0.27, -0.02], [-0.012, 0.24, -0.038], [-0.012, 0.155, -0.045]] },
  proj: { bus: 'display', flow: 'out', labAt: 0.55, pts: [[-0.017, 0.338, -0.03], [-0.035, 0.3, -0.045], [-0.004, 0.24, -0.04], [-0.004, 0.155, -0.045]] },
  mic: { bus: 'USB', flow: 'both', pts: [[0.02, 0.361, -0.02], [0.035, 0.33, -0.03], [0.035, 0.28, -0.04], [0.004, 0.24, -0.04], [0.004, 0.155, -0.045]] },
  spk: { bus: 'audio', flow: 'out', pts: [[-0.004, 0.1, 0.042], [-0.03, 0.1, 0], [-0.03, 0.16, -0.03], [-0.02, 0.24, -0.038], [0.04, 0.29, -0.035], [0.04, 0.33, -0.025], [0.02, 0.361, -0.015]] },
  led: { bus: 'I²C', flow: 'out', pts: [[0.019, 0.17, 0.0555], [0.03, 0.15, 0.03], [0.03, 0.15, -0.044]] },
  uart: { bus: 'UART', flow: 'both', pts: [[0.02, 0.049, -0.012], [0.02, 0.07, -0.03], [0.02, 0.105, -0.045]] },
  touchF: { flow: 'in', pts: [[-0.015, 0.123, 0.067], [-0.025, 0.11, 0.06], [-0.025, 0.049, 0.03]] },
  touchB: { flow: 'in', pts: [[-0.015, 0.128, -0.07], [-0.03, 0.1, -0.06], [-0.03, 0.049, -0.01]] },
  bat: { flow: 'in', pts: [[0, 0.031, -0.04], [0, 0.047, -0.012]] },
  m0: { flow: 'both', pts: [[0.056, 0.169, 0.0015], [0.045, 0.15, 0.01], [0.045, 0.07, 0.01], [0.03, 0.049, 0.015]] },
  m1: { flow: 'both', pts: [[0.094, 0.154, 0], [0.09, 0.175, 0], [0.07, 0.177, 0.002], [0.05, 0.15, 0.014], [0.05, 0.07, 0.014], [0.034, 0.049, 0.02]] },
  m2: { flow: 'both', pts: [[-0.056, 0.169, 0.0015], [-0.045, 0.15, 0.01], [-0.045, 0.07, 0.01], [-0.03, 0.049, 0.015]] },
  m3: { flow: 'both', pts: [[-0.094, 0.154, 0], [-0.09, 0.175, 0], [-0.07, 0.177, 0.002], [-0.05, 0.15, 0.014], [-0.05, 0.07, 0.014], [-0.034, 0.049, 0.02]] },
  m4: { flow: 'both', pts: [[0, 0.206, -0.004], [0.012, 0.19, 0.02], [0.012, 0.049, 0.02]] },
  m5: { flow: 'both', pts: [[0.005, 0.026, 0.015], [0.005, 0.047, 0.012]] },
  m6: { flow: 'both', pts: [[0, 0.064, 0.006], [0, 0.0486, 0.006]] },
};

/* The leak check runs only on a local preview, or with ?vizdev in the URL. */
const DEV = /^(localhost|127\.|\[::1\])/.test(location.hostname) || location.search.includes('vizdev');

/* Guided stops, in the order of the parts table in the post. Each stop
   frames its parts (camera yaw, pitch, target, distance), lights its wires,
   and numbers its callouts to match the card. An item is [part, label, text]
   with an optional anchor point (default: the part's centre). */
const STOPS = {
  face: {
    label: 'Face', parts: ['projector', 'mirror'], wires: ['proj'], cam: [1.35, 0.1, [0, 0.29, -0.005], 0.6],
    lead: 'The projector at the top of the head shines toward the back of the head. A mirror there reflects the image forward onto the visor.',
    items: [
      ['projector', 'projector', 'A small DLP projector. Its lens points back, at the mirror. To Android it is a display. Its controller also has an I²C link for brightness and temperature.'],
      ['mirror', 'mirror', 'An angled mirror at the back of the head. It turns the image forward onto the back of the visor.'],
      ['visor', 'visor', 'Curved plastic. The face is pre-warped for the curve and flipped in software so it reads the right way after the mirror.', [0, 0.29, 0.058]],
    ],
  },
  eyes: {
    label: 'Eyes', parts: ['camera'], wires: ['cam'], cam: [0.6, 0.18, [0, 0.32, 0.01], 0.52],
    lead: 'One HD camera sits in a notch above the face. There is no depth sensor.',
    items: [['camera', 'camera', 'Frames go to the main chip over MIPI CSI, the chip’s camera interface. An I²C bus sets up the sensor.']],
  },
  ears: {
    label: 'Ears', parts: ['mic', 'speaker'], wires: ['mic', 'spk'], cam: [0.8, 0.12, [0, 0.23, -0.01], 0.95],
    lead: 'Sound in and sound out both pass through one board with its own DSP.',
    items: [
      ['mic', 'mic array', 'Cancels echo, forms a beam toward the voice and suppresses noise. One clean channel goes to the main chip over USB, with the voice direction every 10 ms.'],
      ['speaker', 'speaker', 'Sound for the speaker goes down the same USB link. An amplifier on the mic array board drives it, so the DSP has the robot’s own voice to cancel.'],
    ],
  },
  muscles: {
    label: 'Muscles', parts: ['mcu', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], wires: ['uart', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'],
    cam: [0.6, 0.15, [0, 0.17, 0], 1.15],
    lead: 'Seven motors run on their own microcontroller board, not on the main chip.',
    items: [
      ['mcu', 'motor board', 'Gets seven positions over a UART 30 times a second. Sends back positions, stalls and errors.'],
      ['m0', 'arms · 0–3', 'Two motors per arm: up/down swings about 200°, in/out about 90°.'],
      ['m4', 'nod · 4', 'Nods the head ±15°. No motor turns the head left and right.'],
      ['m5', 'turn · 5', 'Turns everything above the base, a full turn.'],
      ['m6', 'lean · 6', 'Leans the torso ±15°.'],
    ],
  },
  touch: {
    label: 'Touch', parts: ['touchF', 'touchB', 'imu', 'battery'], wires: ['touchF', 'touchB', 'bat', 'uart'],
    cam: [1.3, 0.2, [0, 0.11, 0], 0.85],
    lead: 'The motor board also reads the touch pads, the IMU and the battery. Events go to the main chip on the same UART.',
    items: [
      ['touchF', 'front pad', 'A capacitive pad on the front of the chest. The motor board reports each touch and release.'],
      ['touchB', 'back pad', 'A second pad on the back.'],
      ['imu', 'IMU', 'On the motor board. It reports tilt, pick-up and put-down as events.'],
      ['battery', 'battery', 'The motor board reports its level and temperature.'],
    ],
  },
  lights: {
    label: 'Lights', parts: ['led'], wires: ['led'], cam: [0.4, 0.12, [0, 0.16, 0.02], 0.7],
    lead: 'A row of RGB LEDs behind a slot on the chest shows state, such as listening or sleeping.',
    items: [['led', 'LED bar', 'LED driver chips on an I²C bus. The game engine writes the colours every frame, on the same timeline as the face.']],
  },
  brain: {
    label: 'Brain', parts: ['main'], wires: ['cam', 'proj', 'mic', 'led', 'uart'], cam: [0.7, 0.14, [0, 0.2, 0], 1.0],
    lead: 'Every part reaches the main board over one link. Real-time work runs on its own chip: sound on the DSP, motors and sensors on the motor board.',
    items: [
      ['main', 'main board', 'A quad-core ARM chip with a mobile GPU, Wi-Fi and Android.'],
      ['camera', 'camera', 'MIPI CSI, frames in.'],
      ['projector', 'projector', 'Display link, the face out.'],
      ['mic', 'mic array', 'USB, sound in and out.'],
      ['led', 'LED bar', 'I²C, colours out.'],
      ['mcu', 'motor board', 'UART, positions out and events in.'],
    ],
  },
};
const NONE_CAM = [0.45, 0.12, [0, 0.19, 0], 1.2];
/* A tap on the plain shell picks the stop for what is inside it. */
const SHELL_STOP = {
  Helmet: 'face', visor: 'face', Chest: 'brain', Torso: 'muscles', Base: 'muscles',
  ArmL: 'muscles', ForeArmL: 'muscles', ArmR: 'muscles', ForeArmR: 'muscles',
};
const BLOCK_STOP = {};
for (const [k, st] of Object.entries(STOPS)) for (const p of st.parts) BLOCK_STOP[p] ??= k;
BLOCK_STOP.mcu = 'muscles';

/** Convex hull of screen points, as an SVG points string. */
function hull2(pts) {
  const p = pts.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/* Dev check: every part at least 2 mm inside the shell. A leak fails
   loudly: a console error (viz-check fails on it) and a red note. */
async function checkLeaks(fig, app, url, blocks) {
  const model = await loadModel(url);
  const t0 = performance.now();
  const enc = makeEnclosure(model.parts);
  const leaks = findLeaks(enc, blocks);
  // cables: warn only, they are drawn lines, not parts
  const wireLeaks = findLeaks(enc, Object.entries(WIRES).map(([name, w]) => {
    const pos = [];
    for (let i = 1; i < w.pts.length; i++) for (let t = 0; t < 1; t += 0.2) pos.push(...w.pts[i - 1].map((v, k) => v + (w.pts[i][k] - v) * t));
    return { name: `wire ${name}`, kind: 0, pos, nrm: new Float32Array(pos.length) };
  }), 0);
  const ms = Math.round(performance.now() - t0);
  if (wireLeaks.length) console.warn(`viz: cables outside the shell: ${wireLeaks.map((l) => `${l.name} at ${l.at}`).join('; ')}`);
  if (!leaks.length) { console.info(`viz: all ${blocks.length} part meshes are 2 mm or more inside the shell (${ms} ms)`); return; }
  console.error('viz: parts outside the shell (2 mm margin)', leaks);
  app.prepend(h('p', { class: 'wv-note is-bad' }, `Dev check: ${leaks.map((l) => `${l.name} (${l.out} points)`).join(', ')} not 2 mm inside the shell.`));
}

function initParts(fig, app) {
  const view = h('div', { class: `${P}view` });
  const labels = h('div', { class: `${P}labels`, 'aria-hidden': 'true' });
  const over = s('svg', { class: `${P}over`, 'aria-hidden': 'true' });
  const card = h('div', { class: `wv-card is-look ${P}card`, 'aria-live': 'polite' });
  let cur = 'face';
  let stage = null;
  const stop = () => STOPS[cur];

  const pick = chips([...Object.entries(STOPS).map(([k, p]) => [k, p.label]), ['none', 'Whole robot']], (k) => select(k), { value: cur, label: 'Part' });
  const hint = h('p', { class: `${P}hint` }, 'Drag to turn. Pinch, or Ctrl + scroll, to zoom. Tap a part to select it; tap empty space to clear.');

  // wires: a base line, a moving pulse for one-way links, and the bus name
  const wireG = s('g');
  const arcG = s('g', { class: `${P}arcs` });
  const leadG = s('g');
  const beamG = s('g', { class: `${P}beams` });
  const beam1 = s('polygon', { class: `${P}beam` }), beam2 = s('polygon', { class: `${P}beam` });
  beamG.append(beam1, beam2);
  over.append(beamG, wireG, arcG, leadG);
  // Muscles: each motor's axis (dashed) and its range (arc)
  const arcEls = JOINTS.map((j) => {
    const arc = s('polyline', { class: `${P}arc` });
    const ax = s('line', { class: `${P}axis` });
    arcG.append(arc, ax);
    return { j, arc, ax, pts: null };
  });
  const wireEls = {};
  for (const [k, w] of Object.entries(WIRES)) {
    const line = s('polyline', { class: `${P}wire` });
    const flow = w.flow !== 'both' && !REDUCED ? s('polyline', { class: `${P}flow${w.flow === 'out' ? ' is-out' : ''}` }) : null;
    const lab = w.bus ? s('text', { class: `t-xs halo ${P}buslab`, 'text-anchor': 'middle' }, w.bus) : null;
    wireG.append(line);
    if (flow) wireG.append(flow);
    wireEls[k] = { line, flow, lab };
  }
  for (const k of Object.keys(WIRES)) if (wireEls[k].lab) wireG.append(wireEls[k].lab);

  // numbered callouts: HTML label, SVG leader line and dot
  const callEls = [];
  function makeCallouts() {
    labels.replaceChildren();
    leadG.replaceChildren();
    callEls.length = 0;
    (stop()?.items || []).forEach(([part, text, , at], i) => {
      const el = h('span', { class: `${P}call` }, h('b', null, String(i + 1)), text);
      const line = s('polyline', { class: `${P}lead` });
      const dot = s('circle', { class: `${P}ldot`, r: 3 });
      labels.append(el);
      leadG.append(line, dot);
      callEls.push({ el, line, dot, at: at || ANCHOR[part], w: 0 });
    });
  }

  function renderCard() {
    const st = stop();
    card.classList.toggle('is-look', !!st);
    if (!st) {
      card.replaceChildren(h('h5', null, 'Whole robot'), h('p', null, 'The closed shell, as a child sees it. Pick a part above, or tap the robot, to look inside.'));
      return;
    }
    card.replaceChildren(
      h('h5', null, st.label),
      h('p', null, st.lead),
      h('ol', { class: `${P}list` }, ...st.items.map(([, name, text]) => h('li', null, h('b', null, name), ' ', text))),
    );
  }

  function select(k, instant = false) {
    cur = STOPS[k] ? k : 'none';
    pick.set(cur);
    renderCard();
    makeCallouts();
    if (!stage) return;
    const st = stop();
    const on = new Set(st ? st.wires : []);
    for (const [w, el] of Object.entries(wireEls)) {
      for (const e of [el.line, el.flow, el.lab]) e?.classList.toggle('is-on', on.has(w));
    }
    arcG.classList.toggle('is-on', cur === 'muscles');
    beamG.classList.toggle('is-on', cur === 'face');
    pulse();
    stage.selected = new Set(st ? st.parts : []);
    const [yaw, pitch, target, dist] = st ? st.cam : NONE_CAM;
    stage.aim({ yaw, pitch, target, dist }, instant);
  }

  // text equivalent of the wiring
  const sr = h('ul', { class: 'wv-sr' },
    h('li', null, 'Camera to main board: MIPI CSI.'),
    h('li', null, 'Projector to main board: display link.'),
    h('li', null, 'Mic array to main board: USB. The speaker is driven by the mic array board.'),
    h('li', null, 'LED bar to main board: I2C.'),
    h('li', null, 'Motor board to main board: UART. The seven motors, the two touch pads, the IMU and the battery connect to the motor board.'));

  app.append(pick.el, h('div', { class: `${P}cols ${P}cols-1` }, h('div', null, view, hint), card),
    colorKey([['k-look', 'selected part, its wires and labels'], ['k-ink', 'see-through shell and other parts']]), sr);
  renderCard();
  // The wire pulses (a CSS animation) repaint the overlay every display
  // frame, so they run only for 4 s after the figure comes on screen or the
  // reader picks, taps or points at it. Then they hold still.
  let pulseT = 0, pulseAt = 0;
  function pulse() {
    const now = performance.now();
    if (now - pulseAt < 300) return;
    pulseAt = now;
    fig.classList.remove(`${P}paused`);
    clearTimeout(pulseT);
    pulseT = setTimeout(() => fig.classList.add(`${P}paused`), 4000);
  }
  onVisible(fig, (v) => {
    if (v) { pulseAt = 0; pulse(); return; }
    clearTimeout(pulseT);
    fig.classList.add(`${P}paused`);
  });
  view.addEventListener('pointermove', pulse);
  view.addEventListener('pointerdown', pulse);

  lazy3D(fig, view, async () => {
    const url = new URL(fig.dataset.model, document.baseURI).href;
    const blocks = buildInnards();
    stage = await makeStage(fig, view, url, { parts: blocks, env: 'garden' });
    if (DEV) setTimeout(() => checkLeaks(fig, app, url, blocks), 1500);
    // hidden until the first X-ray frame places them
    over.style.opacity = labels.style.opacity = '0';
    view.append(over, labels);

    let lastT = 0;
    stage.tick = (now) => {
      const want = stop() ? 1 : 0;
      if (stage.xray === want) { lastT = 0; return false; }
      const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 1 / 60;
      lastT = now;
      const step = REDUCED ? 1 : dt / 0.3;
      stage.xray = want > stage.xray ? Math.min(want, stage.xray + step) : Math.max(want, stage.xray - step);
      return true;
    };

    const proj = (p) => stage.project('base', p);
    stage.afterRender = () => {
      const W = stage.w, H = stage.h;
      over.setAttribute('viewBox', `0 0 ${W} ${H}`);
      over.style.opacity = labels.style.opacity = String(stage.xray);
      if (!stage.xray) return;
      for (const [k, w] of Object.entries(WIRES)) {
        const el = wireEls[k];
        const pts = w.pts.map(proj);
        const str = pts.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
        el.line.setAttribute('points', str);
        el.flow?.setAttribute('points', str);
        if (el.lab) {
          // bus name 40% of the way from the part (labAt moves it)
          const seg = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
          let d = seg.reduce((a, b) => a + b, 0) * (w.labAt ?? 0.4), i = 0;
          while (i < seg.length - 1 && d > seg[i]) d -= seg[i++];
          const t = seg[i] ? d / seg[i] : 0;
          el.lab.setAttribute('x', (pts[i].x + (pts[i + 1].x - pts[i].x) * t).toFixed(1));
          el.lab.setAttribute('y', (pts[i].y + (pts[i + 1].y - pts[i].y) * t + 3).toFixed(1));
        }
      }
      if (cur === 'muscles') for (const a of arcEls) {
        a.pts ??= jointArc(a.j, stage.piv);
        const q = a.pts.map(proj);
        a.arc.setAttribute('points', q.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' '));
        const pv = stage.piv[a.j.pivot], k = a.j.axis;
        const e0 = proj(pv.map((v, i) => v - k[i] * 0.022)), e1 = proj(pv.map((v, i) => v + k[i] * 0.022));
        a.ax.setAttribute('x1', e0.x.toFixed(1)); a.ax.setAttribute('y1', e0.y.toFixed(1));
        a.ax.setAttribute('x2', e1.x.toFixed(1)); a.ax.setAttribute('y2', e1.y.toFixed(1));
      }
      // Face: the light path, projector → mirror → visor (two soft beams)
      if (cur === 'face') {
        beam1.setAttribute('points', hull2([...BEAM.lens, ...BEAM.mir].map(proj)));
        beam2.setAttribute('points', hull2([...BEAM.mir, ...BEAM.visor].map(proj)));
      }
      // callouts: labels in a column on the side of their part, kept in
      // the order of the parts from top to bottom, 22 px apart
      const sides = [[], []];
      for (const c of callEls) {
        c.p = proj(c.at);
        sides[c.p.x < W / 2 ? 0 : 1].push(c);
      }
      sides.forEach((list, side) => {
        list.sort((a, b) => a.p.y - b.p.y);
        let y = -1e9;
        for (const c of list) { c.y = clamp(Math.max(c.p.y, y + 22), 12, H - 12); y = c.y; }
        for (let j = list.length - 2; j >= 0; j--) list[j].y = Math.min(list[j].y, list[j + 1].y - 22);
        for (const c of list) {
          if (!c.w) c.w = c.el.offsetWidth;
          const x = side ? W - 6 - c.w : 6;
          const end = side ? x - 2 : x + c.w + 2;
          c.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(c.y - 9)}px)`;
          c.line.setAttribute('points', `${c.p.x.toFixed(1)},${c.p.y.toFixed(1)} ${end.toFixed(1)},${c.y.toFixed(1)}`);
          c.dot.setAttribute('cx', c.p.x.toFixed(1));
          c.dot.setAttribute('cy', c.p.y.toFixed(1));
        }
      });
    };
    stage.onPick = (name) => select(BLOCK_STOP[name] || SHELL_STOP[name] || 'none');
    select(cur, true);
  });
}

/* -------------------------------------------------- Fig. 2 robot-turn */

function boxText(x, y, w, hgt, lines, cls = '') {
  const g = s('g', { class: `node ${cls}` });
  g.append(s('rect', { class: 'box', x, y, width: w, height: hgt }));
  const lh = 13.5;
  const top = y + hgt / 2 - ((lines.length - 1) * lh) / 2 + 4;
  lines.forEach((t, i) => g.append(s('text', { x: x + w / 2, y: top + i * lh, 'text-anchor': 'middle', class: i === 0 ? 't-s t-b' : 't-xs' }, t)));
  return g;
}

const TURN_MAP = {
  wide: {
    vb: [760, 300],
    nodes: {
      xmos: { x: 10, y: 20, w: 112, h: 46, l: ['mic array', 'with DSP'] },
      cam: { x: 10, y: 100, w: 112, h: 46, l: ['camera'] },
      body: { x: 10, y: 196, w: 112, h: 84, l: ['projector', 'speaker', 'motors'] },
      audio: { x: 152, y: 20, w: 118, h: 46, l: ['speech'] },
      vision: { x: 152, y: 100, w: 118, h: 46, l: ['vision'] },
      unity: { x: 152, y: 196, w: 118, h: 84, l: ['game engine', 'face · TTS', 'motors · LEDs'] },
      fusion: { x: 352, y: 20, w: 118, h: 46, l: ['world model'] },
      brain: { x: 352, y: 100, w: 118, h: 60, l: ['dialogue', 'local rules'] },
      logger: { x: 352, y: 210, w: 118, h: 46, l: ['cloud link'] },
      cloud: { x: 560, y: 150, w: 190, h: 130, l: ['cloud', 'speech-to-text', 'chat router', 'LLM'], kind: 'cloud' },
    },
    bus: { x: 300, y: 12, w: 22, h: 276, vertical: true },
    edges: {
      xa: [[122, 43], [152, 43]], cv: [[122, 123], [152, 123]], ub: [[152, 238], [122, 238]],
      a: [[270, 43], [300, 43]], v: [[270, 123], [300, 123]], u: [[270, 238], [300, 238]],
      f: [[322, 43], [352, 43]], b: [[322, 130], [352, 130]], l: [[322, 233], [352, 233]],
      c: [[470, 233], [560, 233]],
    },
    cLab: [515, 225],
  },
  tall: {
    vb: [360, 500],
    nodes: {
      xmos: { x: 6, y: 6, w: 110, h: 46, l: ['mic array', 'with DSP'] },
      cam: { x: 125, y: 6, w: 110, h: 46, l: ['camera'] },
      body: { x: 244, y: 6, w: 110, h: 60, l: ['projector', 'speaker', 'motors'] },
      audio: { x: 6, y: 96, w: 110, h: 46, l: ['speech'] },
      vision: { x: 125, y: 96, w: 110, h: 46, l: ['vision'] },
      unity: { x: 244, y: 96, w: 110, h: 56, l: ['game engine', 'face · motors'] },
      fusion: { x: 6, y: 240, w: 110, h: 46, l: ['world model'] },
      brain: { x: 125, y: 240, w: 110, h: 56, l: ['dialogue', 'local rules'] },
      logger: { x: 244, y: 240, w: 110, h: 46, l: ['cloud link'] },
      cloud: { x: 125, y: 350, w: 229, h: 140, l: ['cloud', 'speech-to-text', 'chat router', 'LLM'], kind: 'cloud' },
    },
    bus: { x: 6, y: 186, w: 348, h: 20, vertical: false },
    edges: {
      xa: [[61, 52], [61, 96]], cv: [[180, 52], [180, 96]], ub: [[299, 96], [299, 66]],
      a: [[61, 142], [61, 186]], v: [[180, 142], [180, 186]], u: [[299, 152], [299, 186]],
      f: [[61, 206], [61, 240]], b: [[180, 206], [180, 240]], l: [[299, 206], [299, 240]],
      c: [[299, 286], [299, 350]],
    },
    cLab: [312, 322],
  },
};

/* Canonical edge direction is the order of points above. dir -1 reverses. */
const TURN = [
  {
    label: 'Hear', clock: '0.00 s', nodes: ['xmos', 'audio'], edges: [['xa', 1]],
    text: 'The mic array cancels echo and points a beam at the voice. The speech service gets one clean channel, plus the direction of the voice every 10 ms.',
    code: [
      '// USB audio from the mic array',
      'one clean channel at «16 kHz»',
      'cut into chunks of «120 ms»',
      '',
      '// USB control read, every 10 ms',
      'voice direction: «-24°»',
    ],
    hot: [2, 5],
  },
  {
    label: 'Stream', clock: '0.12 s', nodes: ['audio', 'logger', 'cloud'], edges: [['a', 1], ['l', 1], ['c', 1]],
    text: 'Speech leaves as messages on the local bus. The cloud link is the only service that talks to the cloud. It forwards the audio over MQTT.',
    code: [
      'audio chunk {',
      '  state: «start of speech»   // then speech, end of speech',
      '  audio: «3,840 bytes»       // one 120 ms buffer',
      '  utterance id: «6f1c…»',
      '}',
      '// cloud link → MQTT → cloud speech-to-text',
    ],
    hot: [1, 2],
  },
  {
    label: 'Transcribe', clock: '2.40 s', nodes: ['cloud', 'logger', 'audio'], edges: [['c', -1], ['l', -1], ['a', -1]],
    text: 'The final transcript comes back the same way. The speech service publishes it for the rest of the robot.',
    code: [
      'transcript {',
      '  final: «true»',
      '  text: «"i saw a tiger at the zoo today"»',
      '  confidence: «0.93»',
      '}',
    ],
    hot: [2],
  },
  {
    label: 'Who', clock: '2.45 s', nodes: ['audio', 'vision', 'fusion'], edges: [['a', 1], ['v', 1], ['f', 1]],
    text: 'The world model has the words, the voice directions and the tracked faces. It gives the words to the face whose direction matches the voice.',
    code: [
      'person said {',
      '  text: «"i saw a tiger at the zoo today"»',
      '  person: face «#2»   // voice within ~31° of this face',
      '}',
    ],
    hot: [2],
  },
  {
    label: 'Race', clock: '2.46 s', nodes: ['fusion', 'brain', 'logger', 'cloud'], edges: [['f', -1], ['b', 1], ['b', -1], ['l', 1], ['c', 1]],
    text: 'The dialogue service sends the cloud request first, then runs its local rules on the same words. Here no local rule matches, so the local answer is only a fallback.',
    code: [
      'chat request {',
      '  text: «"i saw a tiger at the zoo today"»',
      '  activity: «open chat»   turn id: «a91…»',
      '}                          // → MQTT → cloud chat router',
      'local rules: no match → ⟦fallback⟧',
    ],
    hot: [1, 4],
  },
  {
    label: 'Filler', clock: '2.47 s', nodes: ['brain', 'unity', 'body'], edges: [['b', -1], ['u', -1], ['ub', 1]],
    text: 'In open conversation the dialogue service does not wait. It sends a filler at once, and the robot looks curious for at least 1 s.',
    code: [
      'robot says {',
      '  kind: «filler»',
      '  markup: «<mark name="anim:curious"/>»',
      '}',
    ],
    hot: [1, 2],
  },
  {
    label: 'Answer', clock: '3.90 s', nodes: ['cloud', 'logger', 'brain'], edges: [['c', -1], ['l', -1], ['b', 1]],
    text: 'The cloud answer arrives over MQTT. The dialogue service holds it until the child has been quiet for 1 s, then plays it as a second turn.',
    code: [
      'chat answer {',
      '  turn id: «a91…»',
      '  text: «"Tigers are the biggest cats! …"»',
      '}',
    ],
    hot: [2],
  },
  {
    label: 'Speak', clock: '4.90 s', nodes: ['brain', 'unity', 'body', 'logger', 'cloud'], edges: [['b', -1], ['u', -1], ['ub', 1], ['l', 1], ['c', 1]],
    text: 'The game engine speaks with on-device TTS, moves the mouth, and drives the motors at 30 frames per second. The cloud is told what the robot said.',
    code: [
      'robot says { text: «"Tigers are the biggest cats! …"» }',
      '// TTS at 48 kHz → phones → «41» mouth shapes',
      '// character → 7 motors, «30» frames/s',
      'chat notify { said: «"Tigers are …"» }   // keeps the cloud transcript right',
    ],
    hot: [0, 3],
  },
];

function initTurn(fig, app) {
  const mq = matchMedia('(min-width: 700px)');
  const host = h('div', { class: `${P}map` });
  const panel = h('div', { class: `${P}panel` });
  const clock = h('span', { class: `${P}clock` });
  let mapEls = null;
  let cur = 0;

  function draw() {
    const L = TURN_MAP[mq.matches ? 'wide' : 'tall'];
    const svg = s('svg', { viewBox: `0 0 ${L.vb[0]} ${L.vb[1]}`, role: 'img', 'aria-label': 'Robot services around the local bus. Devices on one side, services on both sides of the bus, the cloud link connected to the cloud over MQTT.' });
    const id = `bot-arrow-${Math.random().toString(36).slice(2, 7)}`;
    svg.append(s('defs', null, s('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,1 L9,5 L0,9 z', class: `${P}ah` }))));
    const b = L.bus;
    const busG = s('g', { class: `node ${P}busbar` });
    busG.append(s('rect', { class: 'box', x: b.x, y: b.y, width: b.w, height: b.h }));
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    busG.append(s('text', { x: bx, y: by + 4, 'text-anchor': 'middle', class: 't-xs t-b', transform: b.vertical ? `rotate(-90 ${bx} ${by})` : null }, 'ZeroMQ proxy  :5678 → :6789'));
    svg.append(busG);
    const edges = {};
    for (const [k, pts] of Object.entries(L.edges)) {
      const line = s('line', { class: 'edge', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] });
      svg.append(line);
      edges[k] = line;
    }
    svg.append(s('text', { x: L.cLab[0], y: L.cLab[1], 'text-anchor': 'middle', class: 't-xs halo' }, 'MQTT'));
    const nodes = {};
    for (const [k, n] of Object.entries(L.nodes)) {
      const g = boxText(n.x, n.y, n.w, n.h, n.l, n.kind === 'cloud' ? `${P}cloud` : '');
      if (n.kind === 'cloud') g.querySelector('rect').classList.add('dash');
      svg.append(g);
      nodes[k] = g;
    }
    host.replaceChildren(svg);
    mapEls = { nodes, edges, marker: id };
    paint();
  }

  function paint() {
    if (!mapEls) return;
    const st = TURN[cur];
    const on = new Set(st.nodes);
    for (const [k, g] of Object.entries(mapEls.nodes)) {
      g.classList.toggle('is-focus', on.has(k));
      g.classList.toggle('is-dim', !on.has(k));
    }
    const dirs = new Map();
    for (const [k, d] of st.edges) dirs.set(k, (dirs.get(k) || 0) | (d > 0 ? 1 : 2));
    for (const [k, line] of Object.entries(mapEls.edges)) {
      const d = dirs.get(k) || 0;
      line.classList.toggle('is-dim', !d);
      line.classList.toggle(`${P}hot`, !!d);
      line.removeAttribute('marker-end');
      line.removeAttribute('marker-start');
      const m = `url(#${mapEls.marker})`;
      if (d & 1) line.setAttribute('marker-end', m);
      if (d & 2) line.setAttribute('marker-start', m);
    }
  }

  // One Play/Pause walks the 8 steps; a thin strip shows where the turn is.
  // A tap on the strip, or ← →, jumps to a step.
  // time on a step: long enough to read its text (about 4 words a second)
  const stepMs = (i) => clamp(1500 + TURN[i].text.split(/\s+/).length * 250, 3500, 9000);
  const last = TURN.length - 1;
  let timer = 0;
  const playBtn = btn('▶ Play', () => (timer ? halt() : play()), { 'aria-pressed': 'false' });
  const ticks = TURN.map(() => h('i'));
  const strip = h('div', { class: `${P}ticks`, 'aria-hidden': 'true' }, ...ticks);
  strip.addEventListener('click', (e) => {
    const r = strip.getBoundingClientRect();
    halt();
    show(clamp(Math.floor(((e.clientX - r.left) / r.width) * TURN.length), 0, last));
  });
  const pos = h('span', { class: 'wv-pos' });
  function paintBtn() {
    playBtn.textContent = timer ? '❚❚ Pause' : cur === last ? '↻ Replay' : '▶ Play';
    playBtn.setAttribute('aria-pressed', String(!!timer));
  }
  function halt() { clearTimeout(timer); timer = 0; paintBtn(); }
  function advance() {
    show(cur + 1);
    timer = cur < last ? setTimeout(advance, stepMs(cur)) : 0;
    paintBtn();
  }
  function play() {
    if (cur === last) show(0);
    timer = setTimeout(advance, stepMs(cur));
    paintBtn();
  }

  function show(i) {
    cur = i;
    const st = TURN[i];
    clock.textContent = `t = ${st.clock}`;
    pos.textContent = `${i + 1} / ${TURN.length}`;
    ticks.forEach((t, k) => { t.className = k < i ? 'is-past' : k === i ? 'is-now' : ''; });
    panel.replaceChildren(h('p', { class: `${P}step` }, h('b', null, `${st.label}. `), st.text));
    panel.insertAdjacentHTML('beforeend', codeBlock(st.code, st.hot));
    paint();
    paintBtn();
  }

  fig.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select')) return;
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    halt();
    show(clamp(cur + d, 0, last));
    e.preventDefault();
  });
  onVisible(fig, (v) => { if (!v && timer) halt(); });
  panel.setAttribute('aria-live', 'polite');
  app.append(h('div', { class: `wv-bar ${P}turnbar` }, playBtn, strip, pos), h('div', { class: `${P}clockrow` }, clock, h('span', { class: `${P}hint` }, 'sample times for one turn')), host, panel,
    colorKey([['k-look', 'active process and message path'], ['k-data', 'real field names; values are samples']]));
  mq.addEventListener?.('change', draw);
  draw();
  show(0);
}

/* --------------------------------------------------- Fig. 3 robot-who */

/* The room in 3D lives in designing-a-talking-robot/who.js (initWho3D). */

/* ------------------------------------------------ Fig. 4 robot-motors */

const S14 = 16383;
const wrap01 = (x) => x - Math.floor(x);
/* Each motor: slider range in rig degrees, how to pose the rig (RIG, shared
   with the timing figure), and the 0..1 value sent to the motor board
   (production robots). */
const MOTORS = [
  {
    id: 0, name: 'Left arm up', min: -55, max: 145, v: 0, fmt: (a) => `${a}° ${a >= 0 ? 'forward/up' : 'back'}`,
    pose: RIG[0],
    s: (a) => (a <= 90 ? 0.73 * clamp((a + 55) / 145, 0, 1) : 0.73 + 0.27 * clamp((a - 90) / 55, 0, 1)),
  },
  {
    id: 1, name: 'Left arm out', min: -30, max: 60, v: 0, fmt: (o) => (o >= 0 ? `${o}° out` : `${-o}° elbow in`),
    pose: RIG[1],
    s: (o) => { const seq = o >= 0 ? (o === 0 ? 0.75 : 0.75 * ((60 - o) / 60)) : 0.75 + 0.25 * (-o / 30); return 1 - seq; },
  },
  {
    id: 2, name: 'Right arm up', min: -55, max: 145, v: 0, fmt: (a) => `${a}° ${a >= 0 ? 'forward/up' : 'back'}`,
    pose: RIG[2],
    s: (a) => (a <= 90 ? 0.73 * clamp((a + 55) / 145, 0, 1) : 0.73 + 0.27 * clamp((a - 90) / 55, 0, 1)),
  },
  {
    id: 3, name: 'Right arm out', min: -30, max: 60, v: 0, fmt: (o) => (o >= 0 ? `${o}° out` : `${-o}° elbow in`),
    pose: RIG[3],
    s: (o) => { const seq = o >= 0 ? (o === 0 ? 0.76 : 0.76 * ((60 - o) / 60)) : 0.76 + 0.24 * (-o / 30); return 1 - seq; },
  },
  {
    id: 4, name: 'Head nod', min: -15, max: 15, v: 0, fmt: (p) => `${p > 0 ? '+' : ''}${p}° ${p > 0 ? 'down' : p < 0 ? 'up' : ''}`,
    pose: RIG[4],
    s: (p) => clamp(0.5 + p / 30, 0, 1),
  },
  {
    id: 5, name: 'Body turn', min: -180, max: 180, v: 0, fmt: (y) => `${y > 0 ? '+' : ''}${y}° yaw`,
    pose: RIG[5],
    s: (y) => 1 - wrap01(0.5 - y / 359.998),
  },
  {
    id: 6, name: 'Body lean', min: -15, max: 15, v: 0, fmt: (l) => `${l > 0 ? '+' : ''}${l}° ${l > 0 ? 'forward' : l < 0 ? 'back' : ''}`,
    pose: RIG[6],
    s: (l) => clamp(0.5 + l / 30, 0, 1),
  },
];

/* Which parts light up for each motor, and which motor a tap selects. */
const MOTOR_PARTS = [['ArmL', 'ForeArmL'], ['ArmL', 'ForeArmL'], ['ArmR', 'ForeArmR'], ['ArmR', 'ForeArmR'], ['Helmet', 'projector'], ['Torso'], ['Chest']];
const PART_MOTOR = { ArmL: 0, ForeArmL: 1, ArmR: 2, ForeArmR: 3, Helmet: 4, visor: 4, eyes: 4, Chest: 6, Torso: 5, Base: 5 };

/* Motion tracks contain only seven angle values per frame, with generic labels.
 * Interpolate at display refresh rate; the robot-frame readout remains 30 Hz. */
function clipAt(clip, fps, t) {
  const frame = clamp(t * fps, 0, clip.frames.length - 1);
  const i = Math.floor(frame), j = Math.min(i + 1, clip.frames.length - 1), f = frame - i;
  return clip.frames[i].map((a, m) => {
    const b = clip.frames[j][m];
    const d = m === 5 ? ((b - a + 540) % 360) - 180 : b - a;
    return a + d * f;
  });
}
const smooth01 = (t) => t * t * (3 - 2 * t);
const poseMix = (a, b, t) => a.map((v, m) => {
  const d = m === 5 ? ((b[m] - v + 540) % 360) - 180 : b[m] - v;
  return v + d * t;
});

/* The YouTube IFrame API script loads only after a reader clicks Play on the dance. */
let ytApi = null;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytApi ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => { ytApi = null; reject(new Error('YouTube API')); };
    document.head.append(tag);
  });
  return ytApi;
}

function initPuppet(fig, app) {
  const view = h('div', { class: `${P}view` });
  const vals = MOTORS.map((m) => m.v);
  const uid = Math.random().toString(36).slice(2, 7);
  let stage = null, library = null;
  // The table is gauge and control. During playback a motion drives the seven
  // row sliders. Dragging a row pauses playback and the pose holds; Play then
  // resumes from the time bar and blends from the pose set by hand.
  let sel = -1, hand = null, blendFrom = null, blendAt = 0, soundWait = false;
  const TS0 = 41_210; // sample timestamp shown in the motor frame
  let ts = TS0, playing = false, elapsed = 0, lastTick = -1;
  let playlist = [], duration = 0, startPose = [...vals], current = '';
  const BLEND = 0.5;
  // A dance with a song: the robot starts the animation and the song together.
  // Here the song plays from its official video, and the video's clock drives
  // the motion, so the two stay in step through pauses, seeks and buffering.
  let yt = null, ytReady = false, ytWait = 0, songLive = false, songFailed = false, muted = false, songAt = -1;
  // The video is small: it is there for the song, in a corner of the 3D view.
  const ytBox = h('div', { class: `${P}yt` });
  ytBox.hidden = true;
  view.append(ytBox);
  const motionsUrl = new URL(fig.dataset.motions, document.baseURI);
  // The shorter motions play their own sound from the robot's behaviour
  // trees. A sound file loads only when its motion plays. While a sound
  // plays, its clock drives the motion, as the video does for the song.
  const soundExt = new Audio().canPlayType('audio/webm; codecs="opus"') ? 'webm' : 'm4a';
  const sounds = new Map(); // clip id → { el, live, asked, last, failed }
  function soundFor(clip) {
    let s = sounds.get(clip.id);
    if (!s) {
      const el = new Audio();
      el.preload = 'none';
      el.muted = muted;
      el.src = new URL(`${clip.sound}.${soundExt}`, motionsUrl).href;
      s = { el, live: false, asked: 0, last: -1, failed: false };
      el.addEventListener('playing', () => { s.live = true; s.last = -1; });
      for (const ev of ['waiting', 'pause', 'ended']) el.addEventListener(ev, () => { s.live = false; });
      el.addEventListener('error', () => { s.failed = true; s.live = false; });
      sounds.set(clip.id, s);
    }
    return s;
  }
  // Pause every sound but `keep`, and forget play requests.
  function hushSounds(keep = null) {
    for (const s of sounds.values()) {
      if (s === keep) continue;
      if (!s.el.paused) s.el.pause();
      s.asked = 0;
      s.live = false;
    }
    soundWait = false;
  }

  /* ---- controls: motion, play, mute, time */
  const motionId = `${P}motion-${uid}`;
  const motion = h('select', { id: motionId, disabled: true }, h('option', null, 'Loading motions…'));
  const choice = h('label', { class: 'wv-field', for: motionId }, 'Motion', motion);
  const play = btn('▶ Play', () => (playing ? pause() : start()), { disabled: true, 'aria-pressed': 'false' });
  const mute = btn('Mute', () => {
    muted = !muted;
    if (ytReady) { if (muted) yt.mute(); else yt.unMute(); }
    for (const s of sounds.values()) s.el.muted = muted;
    mute.textContent = muted ? 'Unmute' : 'Mute';
    mute.setAttribute('aria-pressed', String(muted));
  }, { 'aria-pressed': 'false' });
  mute.hidden = true;
  const scrub = range('Time', { min: 0, max: 1, step: 0.1, value: 0, fmt: (v) => `${v.toFixed(1)} s`, oninput: (v) => seek(v) });
  scrub.input.setAttribute('aria-label', 'Playback time');
  scrub.input.disabled = true;
  const scrubOut = scrub.el.querySelector('output');
  const status = h('p', { class: `${P}hint`, 'aria-live': 'off' });
  if (REDUCED) play.title = 'Animation is off (reduced motion)';
  motion.addEventListener('change', () => {
    const was = playing;
    stop();
    prepare();
    if (was) start(); // a new choice while playing plays at once
    paintText();
  });
  const controls = h('div', { class: `${P}ctl ${P}ctl-1` }, choice, play, mute, scrub.el);

  /* ---- the seven motors: one slider per row, and the frame sent to the board */
  const frameBox = h('div', { class: `${P}frame` });
  const rows = [], rigText = [], posCells = [], knobs = [];
  // A spot on a slider track, as a CSS length: the 12 px thumb centre at fraction f.
  const knobAt = (f) => `calc(6px + ${f.toFixed(4)} * (100% - 12px))`;
  // A compact panel beside the 3D view: name, slider, angle, 14-bit value.
  const panel = h('div', { class: `${P}mpanel`, role: 'group', 'aria-label': 'Motors' },
    h('div', { class: `${P}mhead`, 'aria-hidden': 'true' },
      h('span', null, 'motor'), h('span', null, 'angle · 14-bit')),
    ...MOTORS.map((m, i) => {
      rigText[i] = h('span', { class: `${P}deg`, 'aria-hidden': 'true' });
      const k = knobs[i] = h('input', {
        type: 'range', class: `${P}knob`, min: m.min, max: m.max, step: 1, value: m.v, 'aria-label': `${m.name} angle`,
      });
      // the 0° mark on the track; the fill runs from it to the angle
      k.style.setProperty('--m', knobAt((0 - m.min) / (m.max - m.min)));
      k.addEventListener('focus', () => pick(i));
      k.addEventListener('pointerdown', () => pick(i));
      k.addEventListener('input', () => moveBy(i, +k.value));
      posCells[i] = h('span', { class: `${P}mpos`, 'aria-hidden': 'true' });
      rows[i] = h('div', { class: `${P}mrow` },
        h('span', { class: `${P}mname` }, h('b', null, String(m.id)), m.name), k, rigText[i], posCells[i]);
      // a tap anywhere on the row picks its slider
      rows[i].addEventListener('click', (e) => { if (e.target !== k) k.focus({ preventScroll: true }); });
      return rows[i];
    }),
  );
  // Pick a row: highlight it and outline its parts on the model.
  function pick(i) {
    if (sel === i) return;
    sel = i;
    paint();
  }
  // A drag pauses playback and holds the pose.
  function moveBy(i, v) {
    if (playing) pause();
    sel = i;
    vals[i] = v;
    hand = [...vals];
    blendFrom = null;
    if (stage) stage.face = null;
    poseRig();
    textSoon();
  }
  // The frame line also keeps its nodes during playback.
  const timeText = h('span', { class: 'dt' });
  const valueText = MOTORS.map(() => h('span', { class: 'dt' }));
  const frameLine = h('span', { class: 'ln is-hot' }, 'frame { time: ', timeText, ' ms, positions: [');
  valueText.forEach((v, i) => { if (i) frameLine.append(', '); frameLine.append(v); });
  frameLine.append('] }');
  // No <code> inside: the site sizes `pre code` to its content on phones, and this line must wrap.
  frameBox.append(h('pre', { class: 'wv-code' },
    h('span', { class: 'ln' }, h('span', { class: 'cm' }, '// once per frame, 30 frames/s')), frameLine));

  function positions() { return MOTORS.map((m, i) => Math.floor(clamp(m.s(vals[i]), 0, 1) * S14)); }

  /* ---- playback */
  // "All" plays the short motions in a row. A dance with a song plays alone.
  function chosen() {
    if (!library) return [];
    return motion.value === 'all' ? library.clips.filter((c) => !c.song) : library.clips.filter((c) => c.id === motion.value);
  }
  const songItem = () => (playlist.length === 1 && playlist[0].clip.song ? playlist[0] : null);
  function prepare() {
    startPose = [...vals];
    playlist = [];
    let end = 0;
    for (const c of chosen()) {
      const begin = end;
      const hold = c.song ? begin : begin + BLEND; // a song dance blends in over its own first seconds
      end = hold + c.seconds;
      playlist.push({ clip: c, start: begin, hold, end });
    }
    duration = end + BLEND;
    const s = songItem();
    if (s) duration = Math.max(duration, s.clip.song.seconds || 0);
    elapsed = 0;
    hushSounds();
    mute.hidden = !(s || playlist.some((it) => it.clip.sound));
    ytBox.hidden = !(s && yt);
    scrub.input.max = duration.toFixed(1);
    scrub.input.disabled = !playlist.length;
  }

  // The video player exists only after the reader's first click on Play.
  function makePlayer(song) {
    ytBox.hidden = false;
    const slot = h('div');
    ytBox.replaceChildren(slot);
    loadYT().then((YT) => {
      yt = new YT.Player(slot, {
        host: 'https://www.youtube-nocookie.com',
        videoId: song.youtube,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, start: Math.floor(song.from) },
        events: {
          onReady: () => {
            ytReady = true;
            if (muted) yt.mute();
            if (playing && songItem()) { yt.seekTo(song.from + elapsed, true); yt.playVideo(); }
          },
          onStateChange: (ev) => onVideo(ev.data),
          onError: () => { songFailed = true; songLive = false; },
        },
      });
    }).catch(() => { songFailed = true; ytBox.hidden = true; });
  }
  // Player states: 1 playing, 2 paused, 3 buffering. Its own controls work too.
  function onVideo(state) {
    songLive = state === 1;
    if (state === 1) {
      songAt = -1;
      if (!playing && songItem()) start(true);
    }
    if (state === 2 && playing && songItem()) pause(true);
  }
  function start(fromVideo = false) {
    if (!stage || !library || REDUCED || playing) return;
    if (!playlist.length || elapsed >= duration || (hand && elapsed === 0)) prepare(); // the motion blends in from the pose you set
    else if (hand) { blendFrom = hand; blendAt = elapsed; } // resume at the time bar, blending from the pose you set
    hand = null;
    if (!playlist.length) return;
    playing = true;
    sel = -1;
    lastTick = -1;
    play.textContent = '❚❚ Pause';
    play.setAttribute('aria-pressed', 'true');
    const s = songItem();
    if (s && !songFailed && !fromVideo) {
      ytWait = performance.now();
      if (!yt) makePlayer(s.clip.song);
      else if (ytReady) {
        const want = s.clip.song.from + elapsed;
        if (Math.abs(yt.getCurrentTime() - want) > 0.3) yt.seekTo(want, true);
        yt.playVideo();
      }
    }
    stage.render();
  }
  function pause(fromVideo = false) {
    playing = false;
    lastTick = -1;
    hushSounds();
    if (!fromVideo && ytReady && songItem()) yt.pauseVideo();
    play.textContent = elapsed > 0 && elapsed < duration ? '▶ Resume' : '▶ Play';
    play.setAttribute('aria-pressed', 'false');
    paint();
  }
  function stop() {
    if (playing) pause();
    playlist = [];
    elapsed = 0;
    play.textContent = '▶ Play';
    play.setAttribute('aria-pressed', 'false');
    current = '';
    if (stage) stage.face = null;
  }
  // Drag the time bar to any moment, playing or paused.
  function seek(v) {
    if (!library || !stage) return;
    if (!playlist.length) prepare();
    elapsed = clamp(v, 0, duration);
    hand = null;
    blendFrom = null;
    hushSounds(); // a playing motion asks its sound again, at the new time
    // seekTo() starts a video that has not played yet, so seek only a started one.
    const s = songItem();
    if (s && ytReady && [1, 2, 3].includes(yt.getPlayerState())) { yt.seekTo(s.clip.song.from + elapsed, true); songAt = -1; }
    if (!playing) play.textContent = elapsed > 0 && elapsed < duration ? '▶ Resume' : '▶ Play';
    applyPose(elapsed);
    poseRig();
    textSoon();
  }
  // The pose at time e of the playlist: blend in, play each clip, then rest.
  const clipFace = { mood: 'neutral', lids: 0, mouth: null, eye: null }; // mouth: the mood's own
  // The face cells of a clip at time t: one atlas eye cell and one mouth cell
  // per frame (face.js), the cells nearest to the clip's own face animation.
  const CELL = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function clipCells(c, t) {
    if (!c.eyeCells) { clipFace.eye = null; clipFace.mouth = null; return; }
    const f = clamp(Math.round(t * library.fps), 0, c.eyeCells.length - 1);
    clipFace.eye = CELL.indexOf(c.eyeCells[f]);
    clipFace.mouth = CELL.indexOf(c.mouthCells[f]);
  }
  function applyPose(e) {
    let pose, eyes = 0, mood = 'neutral';
    const item = playlist.find((it) => e < it.end);
    clipFace.eye = null; clipFace.mouth = null;
    if (item) {
      const i = playlist.indexOf(item), c = item.clip, t = e - item.hold;
      if (/dance|celebrat/i.test(`${c.id} ${c.label}`)) mood = 'happy';
      clipCells(c, Math.max(0, t));
      const prev = i === 0 ? startPose : clipAt(playlist[i - 1].clip, library.fps, playlist[i - 1].clip.seconds);
      if (c.song) {
        pose = poseMix(prev, clipAt(c, library.fps, t), smooth01(clamp(t / (c.blendIn || BLEND), 0, 1)));
        // The same animation moves the eyelids: 0 open … 3 closed.
        if (c.eyes) eyes = +c.eyes[clamp(Math.round(t * library.fps), 0, c.eyes.length - 1)];
      } else if (e < item.hold) {
        pose = poseMix(prev, clipAt(c, library.fps, 0), smooth01(clamp((e - item.start) / BLEND, 0, 1)));
      } else pose = clipAt(c, library.fps, t);
      current = c.label;
    } else if (playlist.length) {
      const tail = playlist[playlist.length - 1];
      const last = clipAt(tail.clip, library.fps, tail.clip.seconds);
      pose = poseMix(last, MOTORS.map((m) => m.v), smooth01(clamp((e - tail.end) / BLEND, 0, 1)));
      current = 'Rest';
    } else return;
    if (blendFrom) {
      const k = (e - blendAt) / BLEND;
      if (k >= 1 || k < -0.6) blendFrom = null; // blend done, or the video jumped back
      else pose = poseMix(blendFrom, pose, smooth01(clamp(k, 0, 1)));
    }
    for (let i = 0; i < 7; i++) vals[i] = clamp(pose[i], MOTORS[i].min, MOTORS[i].max);
    ts = TS0 + Math.round(e * 30) * 33;
    // the clip's eyelids (0 open … 3 closed) on the half and closed lids
    clipFace.mood = mood;
    clipFace.lids = [0, 1, 1, 2][eyes] ?? 0;
    if (stage) stage.face = clipFace;
  }

  /* ---- paint */
  let lastText = 0, textTimer = 0;
  function paintText() {
    lastText = performance.now();
    clearTimeout(textTimer);
    textTimer = 0;
    const pos = positions();
    timeText.textContent = String(ts % 65535);
    let st = current && playlist.length ? `${current} · ${elapsed.toFixed(1)} / ${duration.toFixed(1)} s` : '';
    if (soundWait) st = 'Loading the sound…';
    if (songItem()) {
      if (playing && !songLive && !songFailed) {
        st = ytReady && performance.now() - ytWait > 4000 ? 'Press play in the video to start the song.' : 'Loading the song…';
      } else if (songFailed) st += ' · the video cannot play here, so the motion plays alone';
    }
    status.textContent = st || (REDUCED ? 'Playback is off for reduced motion. Drag the time bar or a motor row.' : 'Press Play, or drag the time bar.');
    scrub.input.value = String(elapsed);
    scrubOut.textContent = `${elapsed.toFixed(1)} s`;
    MOTORS.forEach((m, i) => {
      const hot = i === sel;
      rows[i].className = hot ? `${P}mrow is-look` : `${P}mrow`;
      valueText[i].className = hot ? 'ok' : 'dt';
      valueText[i].textContent = String(pos[i]);
      const a = Math.round(vals[i]), angle = m.fmt(a);
      if (knobs[i].getAttribute('aria-valuetext') !== angle) {
        rigText[i].textContent = `${a}°`;
        rigText[i].title = angle;
        knobs[i].setAttribute('aria-valuetext', angle);
      }
      if (posCells[i].textContent !== String(pos[i])) posCells[i].textContent = String(pos[i]);
    });
  }
  function textSoon() {
    const wait = 100 - (performance.now() - lastText);
    if (wait <= 0) paintText();
    else if (!textTimer) textTimer = setTimeout(paintText, wait);
  }
  // The sliders follow the pose every frame, so during playback they move by themselves.
  function paintKnobs() {
    MOTORS.forEach((m, i) => {
      const v = String(Math.round(vals[i]));
      if (knobs[i].value !== v) knobs[i].value = v;
      const z = (0 - m.min) / (m.max - m.min), p = (vals[i] - m.min) / (m.max - m.min);
      knobs[i].style.setProperty('--a', knobAt(Math.min(z, p)));
      knobs[i].style.setProperty('--b', knobAt(Math.max(z, p)));
    });
  }
  function poseRig(render = true) {
    paintKnobs();
    if (!stage) return;
    for (let i = 0; i < 7; i++) MOTORS[i].pose(stage.rot, vals[i]);
    stage.selected = new Set(sel >= 0 ? MOTOR_PARTS[sel] : []);
    if (render) stage.render();
  }
  function paint() { poseRig(); paintText(); }

  // The sound of the playlist item at time e, when it has one: start it at
  // the right moment, hold the pose while it loads, and follow its clock.
  function followSound(prev, dt, now) {
    const e = prev + dt;
    const it = playlist.find((x) => e < x.end);
    const s = it?.clip.sound ? soundFor(it.clip) : null;
    hushSounds(s);
    if (!s || s.failed || s.el.ended) return e;
    if (s.el.preload === 'none') { s.el.preload = 'auto'; s.el.load(); } // fetch during the blend in
    const t = e - it.hold;
    if (t < 0) return e;
    const len = Number.isFinite(s.el.duration) ? s.el.duration : Infinity;
    if (t >= len - 0.05) return e; // the sound is over; the motion runs on
    if (!s.asked) {
      s.asked = now;
      s.el.currentTime = t;
      s.el.play().catch(() => { s.failed = true; });
    }
    if (!s.live) {
      if (now - s.asked > 2500) { s.failed = true; return e; } // too slow: no sound this time
      soundWait = true;
      return prev; // hold the pose while the sound loads
    }
    const at = s.el.currentTime;
    if (at !== s.last) {
      s.last = at;
      const err = at - t;
      return Math.abs(err) > 0.25 ? it.hold + at : e + err * 0.3;
    }
    return e;
  }

  app.append(controls, status,
    h('div', { class: `${P}pup` }, view,
      h('div', { class: `${P}pside` }, panel, frameBox, h('p', { class: `${P}hint` }, 'Drag a row to move that motor.'))),
    colorKey([['k-look', 'the motor you move'], ['k-data', 'values sent to the motor board']]));
  paint();

  // Only angle tracks enter the site. Original source files stay outside it.
  fetch(motionsUrl).then((r) => {
    if (!r.ok) throw new Error(`motions ${r.status}`);
    return r.json();
  }).then((data) => {
    if (!data.clips?.length || !Number.isFinite(data.fps) || data.fps <= 0) throw new Error('invalid motion data');
    library = data;
    const opt = (c) => h('option', { value: c.id }, c.label);
    const songs = data.clips.filter((c) => c.song);
    motion.replaceChildren(...songs.map(opt), h('option', { value: 'all' }, 'All short motions'),
      ...data.clips.filter((c) => !c.song).map(opt));
    motion.value = songs[0]?.id ?? 'all';
    motion.disabled = false;
    play.disabled = REDUCED || !stage;
    prepare();
    paintText();
  }).catch(() => {
    motion.replaceChildren(h('option', null, 'Motions unavailable'));
    status.textContent = 'Motions are unavailable. The motor rows still work.';
  });

  lazy3D(fig, view, async () => {
    // A square view beside the motor panel; a little shorter on phones,
    // so the robot and the motor rows fit on one screen.
    stage = await makeStage(fig, view, new URL(fig.dataset.model, document.baseURI).href, {
      env: 'garden', get aspect() { return view.clientWidth < 400 ? 0.86 : 1; },
    });
    stage.stopAuto();
    stage.dist = 1.05;
    play.disabled = REDUCED || !library;
    stage.onVisibility = (vis) => { if (!vis) lastTick = -1; };
    // A tap on a part focuses its motor's row slider.
    stage.onPick = (name) => {
      const m = PART_MOTOR[name];
      if (m === undefined) { pick(-1); return; }
      knobs[m].focus({ preventScroll: true });
      pick(m);
    };
    stage.tick = (now) => {
      if (!playing) return false;
      const s = songItem(), dt = lastTick >= 0 ? Math.min((now - lastTick) / 1000, 0.1) : 0;
      lastTick = now;
      if (s && !songFailed) {
        if (ytReady && songLive) {
          // The player reports its time in steps. The frame clock fills the
          // gaps, small errors are eased out, and a seek in the video snaps.
          elapsed += dt;
          const at = yt.getCurrentTime() - s.clip.song.from;
          if (at !== songAt) {
            songAt = at;
            const err = at - elapsed;
            elapsed = Math.abs(err) > 0.25 ? at : elapsed + err * 0.3;
          }
          elapsed = Math.max(0, elapsed);
        } // else the video is loading or buffering: hold the pose
      } else elapsed = followSound(elapsed, dt, now);
      applyPose(elapsed);
      poseRig(false);
      if (elapsed >= duration) { elapsed = duration; current = ''; stage.face = null; pause(); return true; }
      textSoon();
      return true;
    };
    paint();
  });
}

register({
  'robot-parts': initParts, 'robot-turn': initTurn, 'robot-motors': initPuppet,
  'robot-who': (fig, app) => initWho3D(fig, app, { makeStage, lazy3D, getGPU, loadModel, tokenRGB, meshopt, P }),
});

/*
 * cat-stereogram-dark-mode — one figure: where your eyes aim when you fuse
 * the cat pair, and what you see at each vergence angle.
 *
 * Geometry (top view, eyes at z = 0, page at z = D, eye gap e, cats at ±s/2):
 *   the left eye aims at page point xL = D·tan(θ/2) − e/2, the right eye at −xL.
 *   Each eye centres its view on its own aim point, so the left eye sees a page
 *   point x at x − xL and the right eye sees it at x + xL.
 *   Cross-eyed fusion: xL = s/2, sight lines meet at f = D·e / (e + s).
 *   Parallel fusion:   xL = −s/2, sight lines meet at f = D·e / (e − s), only if s < e.
 *
 * Cat outline measured from cat-stereogram.png (7016 × 4960 px, cats 2,501.5 px
 * apart). Units below are image pixels relative to the left cat's body centre.
 */
import { h, s, colorKey, range, register, clamp } from './lib.js';

const SEP_PX = 2501.5;
const CAT_W = 1907 / SEP_PX; // body outer diameter / cat spacing = 0.762
const CAT = {
  head: { cy: -1240, r: 354.5, w: 121 },
  body: { r: 887, w: 133 },
  ear: 'M-224,-1858 L-275,-1545 L-180,-1620 Z',
  whiskers: [[-716, -1338, -406, -1273], [-716, -1273, -406, -1265], [-709, -1195, -406, -1253]],
  tail: 'M-6,947 L-6,1137 C-6,1247 -106,1287 -206,1284 C-356,1277 -556,1057 -756,1037 C-926,1022 -1056,1157 -1056,1338',
};
const PRESETS = [
  { id: 'phone', label: 'Phone', s: 21, D: 35 },
  { id: 'laptop', label: 'Laptop', s: 54, D: 55 },
  { id: 'print', label: 'A4 print', s: 106, D: 40 },
];
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const mm = (v) => `${Math.round(v)} mm`;

/** One cat outline. side = 1 for the left cat (has the tail), -1 for the mirrored right cat. */
function catShape(side, cls) {
  const g = s('g', { class: cls });
  g.append(
    s('circle', { cx: 0, cy: CAT.head.cy, r: CAT.head.r, 'stroke-width': CAT.head.w }),
    s('circle', { cx: 0, cy: 0, r: CAT.body.r, 'stroke-width': CAT.body.w }),
    s('path', { d: CAT.ear, class: 'v-cs-fill' }),
    ...CAT.whiskers.map(([x1, y1, x2, y2]) => s('line', { x1, y1, x2, y2, 'stroke-width': 34 })),
  );
  if (side === 1) g.append(s('path', { d: CAT.tail, 'stroke-width': 97 }));
  return g;
}

function initFuse(fig, app) {
  const st = { s: 106, D: 40, e: 63, u: 0 }; // u = xL / s: where the left eye lands, in cat spacings
  let preset = 'print';

  /* ---------- geometry ---------- */
  const Dmm = () => st.D * 10;
  const xL = () => st.u * st.s;
  const theta = () => 2 * deg(Math.atan((xL() + st.e / 2) / Dmm()));
  const setTheta = (t) => { st.u = (Dmm() * Math.tan(rad(t) / 2) - st.e / 2) / st.s; };
  const thCross = () => 2 * deg(Math.atan((st.s / 2 + st.e / 2) / Dmm()));
  const thPar = () => 2 * deg(Math.atan((st.e / 2 - st.s / 2) / Dmm()));
  const thPage = () => 2 * deg(Math.atan(st.e / 2 / Dmm()));
  const meet = () => { const t = Math.tan(rad(theta()) / 2); return t > 1e-6 ? st.e / 2 / t : Infinity; };
  const TOL = 0.05; // the eyes lock on once the middle pair is this close (fraction of spacing)
  function state() {
    const u = st.u;
    if (theta() < -0.05) return 'out';
    if (Math.abs(u) < TOL / 2) return 'page';
    if (Math.abs(u - 0.5) < TOL / 2) return 'cross';
    if (Math.abs(u + 0.5) < TOL / 2) return 'par';
    if (u > 0.5) return 'over';
    if (u < -0.5) return 'overpar';
    return u > 0 ? 'crossing' : 'relaxing';
  }

  /* ---------- controls ---------- */
  const presetBtns = PRESETS.map((p) => h('button', {
    class: 'wv-btn', type: 'button', 'aria-pressed': String(p.id === preset),
    onclick: () => { preset = p.id; sep.set(p.s); dist.set(p.D); fuseCross(); },
  }, `${p.label} · ${p.s} mm`));
  const sep = range('Cats apart', { min: 10, max: 120, step: 1, value: st.s, fmt: (v) => `${v} mm`, oninput: (v) => { st.s = v; manual(); } });
  const dist = range('Eyes to page', { min: 20, max: 80, step: 1, value: st.D, fmt: (v) => `${v} cm`, oninput: (v) => { st.D = v; manual(); } });
  const eye = range('Eye gap', { min: 50, max: 75, step: 1, value: st.e, fmt: (v) => `${v} mm`, oninput: (v) => { st.e = v; render(); } });
  const aim = range('Vergence', { min: -3, max: 30, step: 0.05, value: 0, fmt: (v) => `${v.toFixed(1)}°`, oninput: (v) => { setTheta(v); render(false); } });
  aim.el.classList.add('v-cs-aim');
  const bCross = h('button', { class: 'wv-btn v-cs-go', type: 'button', onclick: () => fuseCross() }, 'Cross to fuse');
  const bPar = h('button', { class: 'wv-btn v-cs-go', type: 'button', onclick: () => { st.u = -0.5; render(); } }, 'Look through to fuse');
  const bPage = h('button', { class: 'wv-btn v-cs-go', type: 'button', onclick: () => { st.u = 0; render(); } }, 'Look at the page');
  function fuseCross() { st.u = 0.5; render(); }
  function manual() {
    preset = PRESETS.find((p) => p.s === st.s && p.D === st.D)?.id ?? null;
    render();
  }

  /* ---------- top view ---------- */
  const TW = 320; const PAGE_Y = 78; const EYE_Y = 336; const CX = 160; const KX = 1.12; // px per mm across
  const top = s('svg', { viewBox: `0 0 ${TW} 372`, role: 'img', 'aria-label': 'Top view: two eyes, the page with two cats, and the lines of sight' });
  const gTop = s('g');
  top.append(gTop);

  /* ---------- what you see ---------- */
  const VW = 330; const VK = 100; const VCY = 84; // 100 px per cat spacing
  const view = s('svg', { viewBox: `0 0 ${VW} 186`, role: 'img', 'aria-label': 'What you see: the copies of each cat from each eye' });
  const gView = s('g');
  view.append(gView);

  const stats = h('dl', { class: 'wv-kv' });
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const key = colorKey([['k-data', 'the printed cats'], ['k-look', 'where the eyes aim, the fused cat'], ['k-safe', 'fused'], ['k-gap', 'not possible'], ['k-opt', 'controls']]);
  key.append(h('span', null, 'solid: left eye · dashed: right eye'));

  function renderTop(stt) {
    const D = Dmm();
    const KY = (EYE_Y - PAGE_Y) / D; // px per mm in depth
    const X = (x) => CX + x * KX;
    const Z = (z) => EYE_Y - z * KY;
    const g = gTop; g.replaceChildren();
    const hit = xL();
    const fused = stt === 'cross' || stt === 'par';
    // page and behind-page area
    g.append(
      s('rect', { x: 8, y: 6, width: TW - 16, height: PAGE_Y - 6, class: 'v-cs-behind' }),
      s('text', { x: 14, y: 20, class: 't-xs t-mute t-up' }, 'behind the page'),
      s('line', { x1: 8, y1: PAGE_Y, x2: TW - 8, y2: PAGE_Y, class: 'rule-ink' }),
      s('text', { x: TW - 12, y: PAGE_Y - 6, class: 't-xs t-up t-b', 'text-anchor': 'end' }, 'page'),
    );
    // cats on the page, seen edge-on (labels go on top of the sight lines)
    const labels = [];
    const tight = st.s * KX < 80; // stagger the labels when the cats sit close together
    [[-1, 'left cat'], [1, 'right cat']].forEach(([sd, lbl]) => {
      const cx = sd * st.s / 2;
      const on = fused && Math.abs(Math.abs(hit) - st.s / 2) < st.s * 0.03;
      g.append(s('rect', { x: X(cx - CAT_W * st.s / 2), y: PAGE_Y - 5, width: CAT_W * st.s * KX, height: 10, class: on ? 'v-cs-cat is-on' : 'v-cs-cat' }));
      labels.push(s('text', { x: X(cx), y: PAGE_Y + (tight && sd > 0 ? 34 : 20), class: 't-xs t-data t-b halo', 'text-anchor': tight ? (sd < 0 ? 'end' : 'start') : 'middle' }, lbl));
    });
    // lines of sight
    const eyes = [[-st.e / 2, hit, 'L'], [st.e / 2, -hit, 'R']];
    const f = meet();
    const bad = stt === 'out';
    for (const [ex, px] of eyes) {
      g.append(s('line', { x1: X(ex), y1: EYE_Y, x2: X(px), y2: PAGE_Y, class: bad ? 'v-cs-sight is-bad' : 'v-cs-sight' }));
      if (f > D) { // extend behind the page
        const zEnd = Number.isFinite(f) ? Math.min(f, D + (PAGE_Y - 8) / KY) : D + (PAGE_Y - 8) / KY;
        const xEnd = ex + (px - ex) * (zEnd / D);
        g.append(s('line', { x1: X(px), y1: PAGE_Y, x2: X(xEnd), y2: Z(zEnd), class: `v-cs-sight dash${bad ? ' is-bad' : ''}` }));
      }
      g.append(s('circle', { cx: X(px), cy: PAGE_Y, r: 4.5, class: bad ? 'v-cs-hit is-bad' : 'v-cs-hit' }));
    }
    g.append(...labels);
    // where the lines meet
    if (f < D) {
      g.append(s('circle', { cx: CX, cy: Z(f), r: 6, class: 'v-cs-meet' }));
      g.append(s('text', { x: CX + 11, y: Z(f) + 4, class: 't-s t-b t-look halo' }, `finger · ${mm(f)}`));
    } else if (Number.isFinite(f) && Z(f) > 8) {
      g.append(s('circle', { cx: CX, cy: Z(f), r: 5, class: 'v-cs-meet' }));
      g.append(s('text', { x: CX + 10, y: Z(f) + 4, class: 't-xs t-b t-look halo' }, `${mm(f - D)} behind`));
    }
    // eyes
    for (const [ex, , lbl] of eyes) {
      g.append(s('circle', { cx: X(ex), cy: EYE_Y, r: 9, class: 'box' }));
      g.append(s('circle', { cx: X(ex), cy: EYE_Y - 5, r: 3, style: 'fill:var(--ink)' }));
      g.append(s('text', { x: X(ex), y: EYE_Y + 24, class: 't-s t-b', 'text-anchor': 'middle' }, lbl));
    }
    g.append(s('text', { x: CX, y: EYE_Y + 24, class: 't-xs t-mute', 'text-anchor': 'middle' }, `${st.e} mm`));
    g.append(s('text', { x: 12, y: EYE_Y + 24, class: 't-xs t-mute' }, `widths ×${(KX / KY).toFixed(1)}`));
    // distance tick
    g.append(s('line', { x1: 16, y1: PAGE_Y + 30, x2: 16, y2: EYE_Y - 10, class: 'rule' }));
    g.append(s('text', { x: 22, y: (PAGE_Y + EYE_Y) / 2 + 30, class: 't-xs t-mute' }, `${st.D} cm`));
  }

  function renderView(stt) {
    const g = gView; g.replaceChildren();
    const k = VK / SEP_PX;
    const u = st.u;
    // copies: [x in cat spacings, eye, which cat]
    const copies = [
      [-0.5 - u, 'L', 1], [0.5 - u, 'L', -1],
      [-0.5 + u, 'R', 1], [0.5 + u, 'R', -1],
    ];
    const fused = stt === 'cross' || stt === 'par';
    const merged = stt === 'page';
    const bad = stt === 'out';
    const field = 1.62;
    const vis = copies.filter(([x]) => Math.abs(x) < field);
    // draw
    for (const [x, eyeL, side] of vis) {
      const isMid = fused && !bad && Math.abs(x) < TOL;
      const cls = `v-cs-copy${isMid ? ' is-fused' : ''}${bad ? ' is-bad' : ''}${eyeL === 'R' && !isMid ? ' is-r' : ''}`;
      const cg = catShape(side, cls);
      cg.setAttribute('transform', `translate(${VW / 2 + x * VK},${VCY}) scale(${k * side},${k})`);
      g.append(cg);
    }
    // labels
    const groups = [];
    for (const c of vis) {
      const gx = groups.find((gg) => Math.abs(gg.x - c[0]) < TOL);
      if (gx) gx.eyes.push(c[1]); else groups.push({ x: c[0], eyes: [c[1]] });
    }
    for (const gg of groups) {
      const both = gg.eyes.length > 1;
      const txt = both ? (fused && !bad ? 'L+R · fused' : 'L+R') : gg.eyes[0];
      const tone = bad ? 't-bad' : both && fused ? 't-look' : 't-data';
      g.append(s('text', { x: VW / 2 + gg.x * VK, y: 176, class: `t-xs t-b halo ${tone}`, 'text-anchor': 'middle' }, txt));
    }
    if (st.u > 0.02 && !bad) {
      g.append(s('rect', { x: VW / 2 - 3, y: 150, width: 6, height: 16, rx: 3, class: 'v-cs-finger' }));
    }
    return groups.length;
  }

  function render(syncAim = true) {
    // keep the slider range around the useful angles
    const lo = Math.min(-3, Math.floor(thPar() - 2));
    const hi = Math.max(Math.ceil(thCross() * 1.3), Math.ceil(thPage() * 1.6));
    aim.input.min = lo; aim.input.max = hi;
    if (syncAim) { aim.input.value = theta().toFixed(2); }
    aim.el.querySelector('output').textContent = `${theta().toFixed(1)}°`;
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(PRESETS[i].id === preset)));
    bPar.classList.toggle('wv-btn--bad', st.s >= st.e);

    const stt = state();
    renderTop(stt);
    const n = renderView(stt);
    const f = meet(); const D = Dmm();
    let where;
    if (stt === 'out') where = '<span class="c-bad">never: the eyes turn outward</span>';
    else if (!Number.isFinite(f)) where = 'never: the lines are parallel';
    else if (Math.abs(f - D) < 1) where = 'on the page';
    else if (f < D) where = `<span class="c-look">${mm(f)}</span> from your eyes, ${mm(D - f)} before the page`;
    else where = `${mm(f - D)} behind the page`;
    stats.innerHTML = `
      <dt>Eyes meet</dt><dd>${where}</dd>
      <dt>Vergence</dt><dd>${theta().toFixed(1)}° <span class="v-cs-sub">(page ${thPage().toFixed(1)}°, fuse ${thCross().toFixed(1)}° crossed${st.s < st.e ? ` or ${thPar().toFixed(1)}° relaxed` : ''})</span></dd>
      <dt>Extra turn</dt><dd>${Math.abs(100 * 2 * xL() / D).toFixed(1)} Δ ${xL() >= 0 ? 'inward' : 'outward'} <span class="v-cs-sub">from the page</span></dd>
      <dt>You see</dt><dd${stt === 'cross' || stt === 'par' ? ' class="c-safe"' : ''}>${stt === 'out' ? '—' : `${n} cats`}</dd>`;

    const fc = (st.e * D) / (st.e + st.s);
    const T = {
      page: ['Eyes aim at the page. Both eyes see each cat in the same place, so you see two cats.', ''],
      crossing: ['The eyes cross in front of the page. Each eye\'s view slides the opposite way, so every cat doubles and you see four. Keep crossing until the middle two meet.', ''],
      cross: [`<b class="c-safe">Fused.</b> The left eye's right cat lands on the right eye's left cat. The middle cat gets both ears and both sets of whiskers, one from each eye, and the tail from the right eye. Your eyes point at ${mm(fc)}, but the cats are ${mm(D)} away, so they look blurred until focus relaxes back to the page while the eyes stay crossed.`, 'good'],
      over: ['Crossed too far. The middle pair has passed each other. Move the finger back toward the page.', ''],
      relaxing: ['The eyes aim behind the page. Each eye\'s view slides outward, so you see four cats. Keep relaxing until the middle two meet.', ''],
      par: [`<b class="c-safe">Fused.</b> The left eye's left cat lands on the right eye's right cat. The eyes aim ${Number.isFinite(f) ? mm(f - D) + ' behind the page' : 'straight ahead'}, which works only because the cats are closer together (${st.s} mm) than your eyes (${st.e} mm).`, 'good'],
      overpar: ['Relaxed past the fused point. The middle pair has passed each other.', ''],
      out: [`<b class="c-bad">Not possible for most people.</b> The cats are ${st.s} mm apart and your eyes ${st.e} mm, so looking through would need the eyes to turn outward. Eyes turn only a little past parallel. Cross them instead.`, 'bad'],
    }[stt];
    note.innerHTML = T[0];
    note.className = `wv-note${T[1] ? ` is-${T[1]}` : ''}`;
  }

  app.append(
    h('div', { class: 'wv-bar v-cs-presets' }, h('span', { class: 'v-cs-plabel' }, 'Where the pair is:'), ...presetBtns),
    h('div', { class: 'wv-grid-ctrl' }, sep.el, dist.el, eye.el),
    h('div', { class: 'v-cs-aimrow' }, aim.el, h('div', { class: 'wv-seg' }, bPage, bCross, bPar)),
    h('div', { class: 'wv-split v-cs-stage' },
      h('div', null, h('div', { class: 'v-cs-cap' }, 'From above'), top),
      h('div', null, h('div', { class: 'v-cs-cap' }, 'What you see'), view, h('div', { style: 'height:.7rem' }), stats)),
    note,
    key,
  );
  st.u = 0.5;
  render();
}

register({ 'free-fusion': initFuse });

/*
 * cat-stereogram-dark-mode — a pair of cats the reader can fuse on screen.
 *
 *   try    the pair at a spacing the reader picks, where to hold a fingertip
 *          for that spacing, and what the fused view should look like
 *   depth  the same pair with the heads shifted sideways, so the fused head
 *          sits in front of or behind the body
 *
 * The cat outline is measured from cat-stereogram.png (7016 × 4960 px, cats
 * 2,501.5 px apart). Units in CAT are image pixels from the body centre of
 * the left cat. The right cat is the mirror image without the tail.
 *
 * Colour: red = left eye, cyan = right eye, white = both eyes. On black,
 * red + cyan add up to white, so parts both eyes see turn white.
 */
import { h, s, register, clamp } from './lib.js';

const CAT = {
  head: { cy: -1240, r: 354.5, w: 121 },
  body: { r: 887, w: 133 },
  ear: 'M-224,-1858 L-275,-1545 L-180,-1620 Z',
  whiskers: [[-716, -1338, -406, -1273], [-716, -1273, -406, -1265], [-709, -1195, -406, -1253]],
  tail: 'M-6,947 L-6,1137 C-6,1247 -106,1287 -206,1284 C-356,1277 -556,1057 -756,1037 C-926,1022 -1056,1157 -1056,1338',
  top: 1858, bottom: 1386, left: 1104, right: 953, // extents incl. stroke
};
const CAT_H = CAT.top + CAT.bottom;
const EYE_GAP = 63; // mm, mean adult interpupillary distance (Dodgson 2004)

/* Rough screen model for the fingertip hint. Labelled "about" in the UI. */
const SCREEN = window.matchMedia('(pointer: coarse)').matches
  ? { mmPerPx: 0.166, D: 350, name: 'phone' }  // iPhone 14: 64.6 mm / 390 CSS px
  : { mmPerPx: 0.2, D: 550, name: 'computer' }; // 14" MacBook Pro: 302 mm / 1512 CSS px

/**
 * One cat. side 1 = left cat (tail), -1 = mirrored right cat.
 * headDx shifts the head, ear and whiskers sideways, in image pixels.
 */
function cat(side, { x, y, k, headDx = 0, cls = '' }) {
  const g = s('g', { class: `v-cs-cat ${cls}`, transform: `translate(${x},${y}) scale(${k * side},${k})` });
  const head = s('g', { transform: `translate(${headDx},0)` },
    s('circle', { cx: 0, cy: CAT.head.cy, r: CAT.head.r, 'stroke-width': CAT.head.w }),
    s('path', { d: CAT.ear, class: 'v-cs-solid' }),
    ...CAT.whiskers.map(([x1, y1, x2, y2]) => s('line', { x1, y1, x2, y2, 'stroke-width': 34 })));
  g.append(head, s('circle', { cx: 0, cy: 0, r: CAT.body.r, 'stroke-width': CAT.body.w }));
  if (side === 1) g.append(s('path', { d: CAT.tail, 'stroke-width': 97 }));
  return g;
}

/** Keep an SVG's viewBox in CSS pixels, so a spacing in px is a spacing on screen. */
function sized(el, onSize) {
  let w = 0;
  const ro = new ResizeObserver(([e]) => {
    const nw = Math.round(e.contentRect.width);
    if (nw && nw !== w) { w = nw; onSize(w); }
  });
  ro.observe(el);
}

function layout(W) {
  const catH = clamp(W * 0.36, 112, 190);
  const k = catH / CAT_H;
  const bodyW = 2 * CAT.right * k;
  const min = Math.ceil(bodyW * 1.12);
  const max = Math.floor(W - 24 - (CAT.left + CAT.right) * k);
  return { catH, k, min, max, def: clamp(Math.round(bodyW * 1.45), min, max) };
}

/* ================================================================ TRY */

function initTry(fig, app) {
  let W = 0; let L = null; let sp = 0; // spacing in CSS px
  let showView = false;

  const stage = h('div', { class: 'v-cs-stage' });
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'Two white cats on black. Cross your eyes until you see three.' });
  const guide = s('svg', { class: 'v-cs-guide', role: 'img', 'aria-label': 'Where to hold a fingertip for this spacing' });
  stage.append(pair, guide);

  const slider = h('input', { type: 'range', step: 1, 'aria-label': 'Space between the cats' });
  const out = h('output');
  const hint = h('p', { class: 'v-cs-hint', 'aria-live': 'polite' });
  const toggle = h('button', { type: 'button', class: 'v-cs-btn', 'aria-expanded': 'false' }, 'What should I see?');
  const view = h('div', { class: 'v-cs-view', hidden: true });
  const viewSvg = s('svg', { class: 'v-cs-three', role: 'img', 'aria-label': 'Three cats. The middle cat has both ears, both sets of whiskers, and the tail.' });
  view.append(viewSvg,
    h('p', null, 'Three cats. The middle one is the two printed cats on top of each other, so it has both ears, both sets of whiskers, and the tail. The outer two are each seen by one eye.'),
    h('p', { class: 'v-cs-key' },
      h('span', null, h('i', { class: 'k-l' }), 'left eye'),
      h('span', null, h('i', { class: 'k-r' }), 'right eye'),
      h('span', null, h('i', { class: 'k-both' }), 'both eyes')));

  app.append(stage,
    h('div', { class: 'v-cs-ctl' },
      h('label', null, h('span', null, 'Cats apart'), slider, out),
      toggle),
    hint, view);

  slider.addEventListener('input', () => { sp = +slider.value; draw(); });
  toggle.addEventListener('click', () => {
    showView = !showView;
    view.hidden = !showView;
    toggle.setAttribute('aria-expanded', String(showView));
    toggle.textContent = showView ? 'Hide' : 'What should I see?';
    if (showView) drawView();
  });

  function draw() {
    const { k, catH } = L;
    const H = Math.round(catH + 44);
    pair.setAttribute('viewBox', `0 0 ${W} ${H}`);
    pair.style.height = `${H}px`;
    const cx = W / 2 + (CAT.left - CAT.right) * k / 2; // centre the pair including the tail
    const y = 22 + CAT.top * k;
    pair.replaceChildren(
      cat(1, { x: cx - sp / 2, y, k, cls: 'is-print' }),
      cat(-1, { x: cx + sp / 2, y, k, cls: 'is-print' }));
    out.textContent = `${sp} px`;
    drawGuide();
  }

  function drawGuide() {
    const sMM = sp * SCREEN.mmPerPx;
    const D = SCREEN.D;
    const f = (D * EYE_GAP) / (EYE_GAP + sMM); // where the lines of sight cross
    const x0 = 40; const x1 = W - 40; const cy = 46;
    const lat = 34 / EYE_GAP; // px per mm across, stretched so the lines are visible
    const X = (z) => x0 + ((x1 - x0) * z) / D;
    const eL = cy - (EYE_GAP / 2) * lat; const eR = cy + (EYE_GAP / 2) * lat;
    const cL = cy - (sMM / 2) * lat; const cR = cy + (sMM / 2) * lat;
    guide.setAttribute('viewBox', `0 0 ${W} 108`);
    guide.style.height = '108px';
    const fx = X(f);
    guide.replaceChildren(
      s('line', { x1: x1, y1: cy - 26, x2: x1, y2: cy + 26, class: 'v-cs-screen' }),
      s('circle', { cx: x1, cy: cL, r: 3.2, class: 'v-cs-dot' }),
      s('circle', { cx: x1, cy: cR, r: 3.2, class: 'v-cs-dot' }),
      // left eye (top) to the right cat (bottom), right eye to the left cat
      s('line', { x1: x0, y1: eL, x2: x1, y2: cR, class: 'v-cs-ray is-l' }),
      s('line', { x1: x0, y1: eR, x2: x1, y2: cL, class: 'v-cs-ray is-r' }),
      s('circle', { cx: x0, cy: eL, r: 6, class: 'v-cs-eye is-l' }),
      s('circle', { cx: x0, cy: eR, r: 6, class: 'v-cs-eye is-r' }),
      s('text', { x: x0 - 14, y: eL + 4, class: 'v-cs-t is-l', 'text-anchor': 'end' }, 'L'),
      s('text', { x: x0 - 14, y: eR + 4, class: 'v-cs-t is-r', 'text-anchor': 'end' }, 'R'),
      s('circle', { cx: fx, cy, r: 5.5, class: 'v-cs-tip' }),
      s('text', { x: fx, y: cy - 22, class: 'v-cs-t is-tip', 'text-anchor': 'middle' }, 'fingertip'),
      s('line', { x1: x0, y1: 88, x2: fx, y2: 88, class: 'v-cs-dim' }),
      s('line', { x1: fx, y1: 88, x2: x1, y2: 88, class: 'v-cs-dim is-faint' }),
      s('text', { x: (x0 + fx) / 2, y: 101, class: 'v-cs-t is-dim', 'text-anchor': 'middle' }, `${Math.round(f / 10)} cm`),
      s('text', { x: x1, y: 101, class: 'v-cs-t is-dim', 'text-anchor': 'end' }, `screen at ${Math.round(D / 10)} cm`),
    );
    const through = sMM < EYE_GAP - 5;
    hint.innerHTML = `On a ${SCREEN.name} the cats are now about <b>${Math.round(sMM)} mm</b> apart. `
      + `Hold a fingertip about <b>${Math.round(f / 10)} cm</b> from your eyes and look at it. `
      + `The cats behind it split into four. Move the fingertip until the middle two meet. `
      + (sp <= L.min + 4 ? 'This is the easiest spacing.' : 'Closer together is easier.')
      + (through ? ' The cats are narrower than your eyes, so looking through the screen also works.' : '');
  }

  function drawView() {
    const k = L.k * 0.8; const gap = Math.min(L.min * 0.8 * 1.3, (W - 24) / 2 - CAT.left * k);
    const H = Math.round(CAT_H * k + 30);
    viewSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    viewSvg.style.height = `${H}px`;
    const cx = W / 2; const y = 14 + CAT.top * k;
    // crossed: left eye sees left cat at -1 gap, right cat at 0; right eye mirrors it
    viewSvg.replaceChildren(
      s('rect', { width: W, height: H, class: 'v-cs-black' }),
      s('g', { class: 'v-cs-eyeimg is-l' }, cat(1, { x: cx - gap, y, k }), cat(-1, { x: cx, y, k })),
      s('g', { class: 'v-cs-eyeimg is-r' }, cat(1, { x: cx, y, k }), cat(-1, { x: cx + gap, y, k })));
  }

  sized(stage, (w) => {
    W = w;
    const frac = L ? (sp - L.min) / Math.max(1, L.max - L.min) : null;
    L = layout(W);
    slider.min = L.min; slider.max = L.max;
    sp = frac == null ? L.def : Math.round(L.min + frac * (L.max - L.min));
    slider.value = sp;
    draw();
    if (showView) drawView();
  });
}

/* ============================================================== DEPTH */

function initDepth(fig, app) {
  let W = 0; let L = null; let d = 0; // head offset per cat, CSS px

  const stage = h('div', { class: 'v-cs-stage' });
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'Two cats whose heads can be moved sideways' });
  stage.append(pair);
  const slider = h('input', { type: 'range', min: -8, max: 8, step: 1, value: 0, 'aria-label': 'Move the heads' });
  const out = h('output');
  const note = h('p', { class: 'v-cs-hint', 'aria-live': 'polite' });
  app.append(stage, h('div', { class: 'v-cs-ctl' }, h('label', null, h('span', null, 'Heads'), slider, out)), note);
  slider.addEventListener('input', () => { d = +slider.value; draw(); });

  function draw() {
    const { k, catH } = L;
    const H = Math.round(catH + 44);
    pair.setAttribute('viewBox', `0 0 ${W} ${H}`);
    pair.style.height = `${H}px`;
    const sp = L.def;
    const cx = W / 2 + (CAT.left - CAT.right) * k / 2;
    const y = 22 + CAT.top * k;
    // positive d moves the left head left and the right head right: heads further apart
    const dx = -d / k;
    pair.replaceChildren(
      cat(1, { x: cx - sp / 2, y, k, headDx: dx, cls: 'is-print' }),
      cat(-1, { x: cx + sp / 2, y, k, headDx: dx, cls: 'is-print' }));
    const gapTxt = d === 0 ? 'same place' : `${Math.abs(2 * d)} px ${d > 0 ? 'further apart' : 'closer together'}`;
    out.textContent = d === 0 ? 'flat' : `${d > 0 ? '+' : '−'}${Math.abs(2 * d)} px`;
    if (d === 0) {
      note.innerHTML = 'Heads and bodies are the same distance apart, so the fused cat is flat. Move the heads, then fuse the pair again.';
    } else {
      const front = d > 0;
      note.innerHTML = `The heads are ${gapTxt} than the bodies. `
        + `With crossed eyes the head sits <b>${front ? 'in front of' : 'behind'}</b> the body. `
        + `Looking through, it sits <b>${front ? 'behind' : 'in front of'}</b> it.`;
    }
  }

  sized(stage, (w) => { W = w; L = layout(W); draw(); });
}

register({ try: initTry, depth: initDepth });

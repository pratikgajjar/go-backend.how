/*
 * cat-stereogram-dark-mode — three figures, each built around what the
 * reader has to do with their own eyes.
 *
 *   try    the pair on screen and a coach: the reader reports what they see
 *          (2, 3, 4 cats, a blur) and gets the one next move. Four cats are
 *          told apart by the tails: side by side = not crossed enough, one
 *          cat apart = crossed too far.
 *   aim    predict, then see: where the fingertip goes when the cats move
 *          apart, and which pair you can fuse by looking through.
 *   depth  predict, then fuse: heads moved apart, does the head float in
 *          front of the body or behind it?
 *
 * Cat outline measured from cat-stereogram.png (7016 × 4960 px, cats
 * 2,501.5 px apart). CAT units are image pixels from the left cat's body
 * centre; the right cat is the mirror image without the tail.
 *
 * Colour: red = left eye, cyan = right eye, white = the printed cats and
 * anything both eyes see. The page's link colour marks the one thing to
 * look at in each view.
 */
import { h, s, register, clamp, tween } from './lib.js';

const CAT = {
  head: { cy: -1240, r: 354.5, w: 121 },
  body: { r: 887, w: 133 },
  ear: 'M-224,-1858 L-275,-1545 L-180,-1620 Z',
  whiskers: [[-716, -1338, -406, -1273], [-716, -1273, -406, -1265], [-709, -1195, -406, -1253]],
  tail: 'M-6,947 L-6,1137 C-6,1247 -106,1287 -206,1284 C-356,1277 -556,1057 -756,1037 C-926,1022 -1056,1157 -1056,1338',
  tailEnd: [-1056, 1338],
  top: 1858, bottom: 1386, left: 1104, right: 953, // extents incl. stroke
};
const CAT_H = CAT.top + CAT.bottom;
const EYE_GAP = 63; // mm, mean adult interpupillary distance (Dodgson 2004)

/* Rough screen model for fingertip distances. The UI says "about". */
const SCREEN = window.matchMedia('(pointer: coarse)').matches
  ? { mmPerPx: 0.166, D: 350, name: 'phone' }  // iPhone 14: 64.6 mm / 390 CSS px
  : { mmPerPx: 0.2, D: 550, name: 'computer' }; // 14" MacBook Pro: 302 mm / 1512 CSS px
const fingerMM = (sMM, D = SCREEN.D) => (D * EYE_GAP) / (EYE_GAP + sMM);
const cm = (mm) => `${Math.round(mm / 10)} cm`;

/* ------------------------------------------------------------ drawing */

/** One cat. side 1 = left cat (tail), -1 = mirrored right cat. */
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

/**
 * What the two eyes see when each eye's aim moves u cat-spacings inward
 * (u = 0: both on the screen, 0.5: fused by crossing). x is in spacings.
 */
const copies = (u) => [
  { x: -0.5 - u, eye: 'l', side: 1 }, { x: 0.5 - u, eye: 'l', side: -1 },
  { x: -0.5 + u, eye: 'r', side: 1 }, { x: 0.5 + u, eye: 'r', side: -1 },
];

/** Keep an SVG's viewBox in CSS pixels, so px in the drawing are px on screen. */
function sized(el, onSize) {
  let w = 0;
  new ResizeObserver(([e]) => {
    const nw = Math.round(e.contentRect.width);
    if (nw && nw !== w) { w = nw; onSize(w); }
  }).observe(el);
}

function layout(W) {
  const catH = clamp(W * 0.36, 112, 190);
  const k = catH / CAT_H;
  const bodyW = 2 * CAT.right * k;
  const min = Math.ceil(bodyW * 1.12);
  const max = Math.floor(W - 24 - (CAT.left + CAT.right) * k);
  return { catH, k, min, max, def: clamp(Math.round(bodyW * 1.45), min, max) };
}

/** The printed pair, centred, white on black. */
function drawPair(svg, W, L, sp, headDx = 0) {
  const H = Math.round(L.catH + 44);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;
  const cx = W / 2 + ((CAT.left - CAT.right) * L.k) / 2;
  const y = 22 + CAT.top * L.k;
  svg.replaceChildren(
    cat(1, { x: cx - sp / 2, y, k: L.k, headDx, cls: 'is-print' }),
    cat(-1, { x: cx + sp / 2, y, k: L.k, headDx, cls: 'is-print' }));
}

const btn = (label, onclick, cls = 'v-cs-btn', extra = {}) =>
  h('button', { type: 'button', class: cls, onclick, ...extra }, label);

/* ================================================================ TRY
 * The reader tries to fuse the pair above and reports what they see.
 * Each answer gets one picture of that view and one next move.
 */

function initTry(fig, app) {
  let W = 0; let L = null; let sp = 0;

  const stage = h('div', { class: 'v-cs-stage' });
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'Two white cats on black' });
  stage.append(pair);

  const slider = h('input', { type: 'range', step: 1, 'aria-label': 'Space between the cats' });
  const ease = h('div', { class: 'v-cs-ease' },
    h('span', null, 'easier'), slider, h('span', null, 'harder'));
  const coach = h('div', { class: 'v-cs-coach', 'aria-live': 'polite' });
  app.append(stage, ease, coach);

  slider.addEventListener('input', () => { sp = +slider.value; drawPair(pair, W, L, sp); go(state); });

  /** A small picture of one view, drawn at the same scale ratio as the pair above. */
  function view(u, { mark = null, eyes = false, label } = {}) {
    const PW = 320; const k = L.k * 0.8; const g = sp * 0.8;
    const scale = Math.min(1, (PW - 16) / ((2 * u + 1) * g + (CAT.left + CAT.right) * k));
    const kk = k * scale; const gg = g * scale;
    const top = mark === 'meet' ? 26 : 10;
    const PH = Math.round(CAT_H * kk + top + (mark === 'tails' || eyes ? 30 : 12));
    const svg = s('svg', { viewBox: `0 0 ${PW} ${PH}`, class: 'v-cs-mini', role: 'img', 'aria-label': label });
    const cx = PW / 2; const y = top + CAT.top * kk;
    svg.append(s('rect', { width: PW, height: PH, class: 'v-cs-black' }));
    const cs = copies(u);
    if (eyes) {
      svg.append(
        s('g', { class: 'v-cs-eyeimg is-l' }, ...cs.filter((c) => c.eye === 'l').map((c) => cat(c.side, { x: cx + c.x * gg, y, k: kk }))),
        s('g', { class: 'v-cs-eyeimg is-r' }, ...cs.filter((c) => c.eye === 'r').map((c) => cat(c.side, { x: cx + c.x * gg, y, k: kk }))));
      const lab = (x, t, cls) => s('text', { x, y: PH - 9, class: `v-cs-t ${cls}`, 'text-anchor': 'middle' }, t);
      svg.append(lab(cx - gg, 'left', 'is-l'), lab(cx, 'both', 'is-w'), lab(cx + gg, 'right', 'is-r'));
    } else {
      // dedupe copies that land on the same spot (u = 0)
      const seen = new Set();
      for (const c of cs) {
        const key = `${c.x.toFixed(3)}:${c.side}`;
        if (seen.has(key)) continue;
        seen.add(key);
        svg.append(cat(c.side, { x: cx + c.x * gg, y, k: kk, cls: 'is-print' }));
      }
    }
    if (mark === 'tails') {
      for (const c of cs.filter((q) => q.side === 1)) {
        const tx = cx + c.x * gg + CAT.tailEnd[0] * kk; const ty = y + CAT.tailEnd[1] * kk;
        svg.append(s('line', { x1: tx, y1: ty + 4, x2: tx, y2: ty + 11, class: 'v-cs-hi-line' }),
          s('text', { x: tx, y: ty + 23, class: 'v-cs-t is-hi', 'text-anchor': 'middle' }, 'tail'));
      }
    }
    if (mark === 'meet') {
      // the middle two cats, and which way they have to move
      const inner = cs.filter((c) => Math.abs(c.x) < Math.abs(u) + 0.5 - 1e-6).map((c) => cx + c.x * gg).sort((a, b) => a - b);
      const [a, b] = inner;
      const yA = 14;
      const dir = 1;
      const arrow = (x, d) => s('path', { d: `M${x - 9 * d},${yA} L${x + 3 * d},${yA} M${x - 1 * d},${yA - 4} L${x + 3 * d},${yA} L${x - 1 * d},${yA + 4}`, class: 'v-cs-hi-line' });
      svg.append(arrow(a, dir), arrow(b, -dir));
    }
    return svg;
  }

  /* Coach states. Each view: one picture at most, one sentence, one choice. */
  const S = {
    ask: () => ({
      q: `Hold a fingertip about ${cm(fingerMM(sp * SCREEN.mmPerPx))} from your eyes, between you and the cats. Look at the fingertip, not the cats. How many cats are behind it?`,
      choices: [['2', 'two'], ['4', 'four'], ['3', 'three'], ['a blur', 'blur']],
      round: true,
    }),
    two: () => ({
      pic: view(0, { label: 'Two cats' }),
      say: 'Your eyes are still on the screen. Bring the fingertip closer to your eyes and keep looking at it.',
      choices: [['Try again', 'ask']],
    }),
    four: () => ({
      q: 'Look at the tails. Which picture matches?',
      picks: [
        [view(0.25, { mark: 'tails', label: 'Four cats, the two tails side by side' }), 'Tails side by side', 'under'],
        [view(0.75, { mark: 'tails', label: 'Four cats, the tails one cat apart' }), 'Tails one cat apart', 'over'],
      ],
    }),
    under: () => ({
      pic: view(0.25, { mark: 'meet', label: 'The middle two cats need to move together' }),
      say: 'Not crossed enough yet. Move the fingertip a little closer to your eyes, keep looking at it, and the middle two slide together.',
      choices: [['Try again', 'ask']],
    }),
    over: () => ({
      pic: view(0.75, { mark: 'meet', label: 'The middle two cats have passed each other and need to slide back together' }),
      say: 'Crossed too far: the middle two have passed each other. Move the fingertip back toward the screen, and they slide back together.',
      choices: [['Try again', 'ask']],
    }),
    three: () => ({
      q: 'Check the middle cat. How many ears does it have?',
      choices: [['1', 'oneear'], ['2', 'fused']],
      round: true,
    }),
    oneear: () => ({
      say: 'Then two of the four cats overlap but have not lined up yet. Look at the tails.',
      choices: [['Compare the tails', 'four']],
    }),
    fused: () => ({
      pic: view(0.5, { eyes: true, label: 'Three cats: the left eye gives the red parts, the right eye the cyan parts, and both eyes see the white rings' }),
      say: 'Fused. Each eye gives the middle cat one ear and one set of whiskers, and the right eye gives the tail. Take the fingertip away and hold the cross. The cat sharpens when focus settles on the screen.',
      choices: [['Start over', 'ask']],
    }),
    blur: () => ({
      say: 'That is normal at first. Your eyes point at the fingertip, so the cats are out of focus. Hold still for a few seconds. If it stays hard, move the slider above toward "easier".',
      choices: [['Try again', 'ask']],
    }),
  };

  let state = 'ask';
  function go(next) {
    state = next;
    const st = S[next]();
    const kids = [];
    if (st.q) kids.push(h('p', { class: 'v-cs-q' }, st.q));
    if (st.pic) kids.push(st.pic);
    if (st.say) kids.push(h('p', { class: 'v-cs-say' }, st.say));
    if (st.choices) {
      kids.push(h('div', { class: `v-cs-choices${st.round ? ' is-round' : ''}` },
        ...st.choices.map(([label, to]) => btn(label, () => go(to), st.round ? 'v-cs-chip' : 'v-cs-btn'))));
    }
    if (st.picks) {
      kids.push(h('div', { class: 'v-cs-picks' },
        ...st.picks.map(([pic, label, to]) => h('button', { type: 'button', class: 'v-cs-pick', onclick: () => go(to) }, pic, h('span', null, label)))));
    }
    coach.replaceChildren(...kids);
  }

  sized(stage, (w) => {
    W = w;
    const frac = L ? (sp - L.min) / Math.max(1, L.max - L.min) : null;
    L = layout(W);
    slider.min = L.min; slider.max = L.max;
    sp = frac == null ? L.def : Math.round(L.min + frac * (L.max - L.min));
    slider.value = sp;
    drawPair(pair, W, L, sp);
    go(state);
  });
}

/* ================================================================ AIM
 * Seen from above: two eyes, the screen, two lines of sight.
 * Two questions, answered before the drawing moves, then free play.
 */

function initAim(fig, app) {
  const D = SCREEN.D;
  const st = { s: 20, mode: 'cross', hide: false };
  let W = 0;
  const svg = s('svg', { class: 'v-cs-top', role: 'img', 'aria-label': 'Seen from above: two eyes, the screen with two cats, and the lines of sight' });
  const panel = h('div', { class: 'v-cs-qa', 'aria-live': 'polite' });
  const play = h('div', { class: 'v-cs-play', hidden: true });
  const slider = h('input', { type: 'range', min: 10, max: 110, step: 1, value: st.s, 'aria-label': 'Space between the cats, in mm' });
  const modeBtns = [['cross', 'Cross'], ['through', 'Look through']].map(([m, label]) =>
    btn(label, () => { st.mode = m; draw(); }, 'v-cs-tab', { 'aria-pressed': 'false', 'data-m': m }));
  play.append(h('label', null, 'Cats apart', slider), h('span', { class: 'v-cs-tabs' }, ...modeBtns));
  app.append(svg, panel, play);
  slider.addEventListener('input', () => { st.s = +slider.value; draw(); });

  let cancel = () => {};
  function animate(to, ms, done) {
    cancel();
    const from = st.s;
    cancel = tween(ms, (t) => { st.s = from + (to - from) * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); draw(); }, done);
  }

  function draw() {
    if (!W) return;
    const x0 = 44; const x1 = x0 + (W - x0 - 24) * 0.56; const xMax = W - 10;
    const sc = (x1 - x0) / D; const lat = sc * 1.5;
    const half = (Math.max(EYE_GAP, 110) / 2) * lat;
    const cy = Math.max(half, 40) + 26; const H = Math.round(cy + Math.max(half, 40) + 30);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.height = `${H}px`;
    const X = (z) => x0 + z * sc;
    const yE = [cy - (EYE_GAP / 2) * lat, cy + (EYE_GAP / 2) * lat]; // left eye on top
    const yC = [cy - (st.s / 2) * lat, cy + (st.s / 2) * lat];       // left cat on top
    const k = [];
    k.push(s('line', { x1, y1: cy - half - 8, x2: x1, y2: cy + half + 8, class: 'v-cs-scr' }),
      s('text', { x: x1, y: cy - half - 14, class: 'v-cs-t2', 'text-anchor': 'middle' }, `screen, ${cm(D)} away`),
      s('text', { x: x1, y: cy + half + 26, class: 'v-cs-t2 is-soft', 'text-anchor': 'middle' }, `cats ${Math.round(st.s)} mm apart`));
    const cross = st.mode === 'cross';
    const aim = cross ? [yC[1], yC[0]] : [yC[0], yC[1]];
    const rays = [];
    let meet = null; let fail = false;
    if (cross) meet = { z: fingerMM(st.s, D), front: true };
    else if (st.s < EYE_GAP) meet = { z: (D * EYE_GAP) / (EYE_GAP - st.s), front: false };
    else fail = true;
    ['l', 'r'].forEach((eye, i) => {
      rays.push(s('line', { x1: x0, y1: yE[i], x2: x1, y2: aim[i], class: `v-cs-ray is-${eye}` }));
      if (!cross && !st.hide) {
        // continue behind the screen, clipped to the drawing
        const dx = x1 - x0; const dy = aim[i] - yE[i];
        const t = (xMax - x0) / dx;
        const tEnd = meet ? Math.min(t, (X(meet.z) - x0) / dx) : t;
        rays.push(s('line', { x1, y1: aim[i], x2: x0 + dx * tEnd, y2: yE[i] + dy * tEnd, class: `v-cs-ray is-${eye} is-behind` }));
      }
    });
    k.push(...rays);
    k.push(s('circle', { cx: x1, cy: yC[0], r: 3.5, class: 'v-cs-catdot' }), s('circle', { cx: x1, cy: yC[1], r: 3.5, class: 'v-cs-catdot' }));
    k.push(s('circle', { cx: x0, cy: yE[0], r: 7, class: 'v-cs-eye2 is-l' }), s('circle', { cx: x0, cy: yE[1], r: 7, class: 'v-cs-eye2 is-r' }),
      s('text', { x: x0 - 12, y: yE[0] - 12, class: 'v-cs-t2 is-l' }, 'left eye'),
      s('text', { x: x0 - 12, y: yE[1] + 22, class: 'v-cs-t2 is-r' }, 'right eye'));
    if (meet && !(st.hide && !cross)) {
      const mx = X(meet.z);
      if (mx <= xMax) {
        k.push(s('circle', { cx: mx, cy, r: 6, class: meet.front ? 'v-cs-finger' : 'v-cs-meet' }));
        k.push(s('text', { x: mx, y: cy - 14, class: 'v-cs-t2 is-hi', 'text-anchor': meet.front ? 'middle' : 'end' },
          meet.front ? `fingertip, ${cm(meet.z)}` : `eyes meet ${cm(meet.z - D)} behind`));
      } else {
        k.push(s('text', { x: xMax, y: cy - 10, class: 'v-cs-t2 is-hi', 'text-anchor': 'end' },
          `eyes meet ${(meet.z - D) >= 1000 ? `${((meet.z - D) / 1000).toFixed(1)} m` : cm(meet.z - D)} behind →`));
      }
    }
    if (fail && !st.hide) {
      k.push(s('text', { x: x1 - 10, y: cy + 4, class: 'v-cs-t2 is-bad', 'text-anchor': 'end' }, '✕ eyes would turn outward'));
    }
    svg.replaceChildren(...k);
    modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === st.mode)));
    slider.value = Math.round(st.s);
  }

  const QS = [
    {
      q: 'The cats move further apart. Where does the fingertip have to go?',
      a: [['Closer to my eyes', true], ['Closer to the screen', false]],
      then: (ok) => {
        animate(90, 1600);
        return `${ok ? 'Yes.' : 'The other way.'} Wider cats need the eyes to cross more, so the lines of sight cross nearer to your face: from ${cm(fingerMM(20, D))} to ${cm(fingerMM(90, D))} here.`;
      },
    },
    {
      q: 'Now look through the screen instead of crossing. Which pair can you fuse?',
      a: [['Cats 2 cm apart', true], ['Cats 10 cm apart, like the print', false]],
      before: () => { st.mode = 'through'; st.hide = true; animate(20, 500); },
      then: (ok) => {
        st.hide = false;
        animate(106, 2200);
        return `${ok ? 'Yes, only' : 'Only'} the 2 cm pair. Looking through, each eye aims at the cat on its own side, so the lines of sight meet behind the screen, and only while the cats are closer together than your eyes. At 10 cm the eyes would have to turn outward.`;
      },
    },
  ];

  function ask(i) {
    const Q = QS[i];
    Q.before?.();
    panel.replaceChildren(
      h('p', { class: 'v-cs-qn' }, `${i + 1} of ${QS.length}`),
      h('p', { class: 'v-cs-q2' }, Q.q),
      h('div', { class: 'v-cs-answers' }, ...Q.a.map(([label, ok]) => btn(label, () => answer(i, ok), 'v-cs-ans'))));
  }
  function answer(i, ok) {
    const text = QS[i].then(ok);
    const last = i === QS.length - 1;
    panel.replaceChildren(
      h('p', { class: 'v-cs-qn' }, `${i + 1} of ${QS.length}`),
      h('p', { class: 'v-cs-q2' }, QS[i].q),
      h('p', { class: `v-cs-said ${ok ? 'is-ok' : 'is-miss'}` }, text),
      last ? h('p', { class: 'v-cs-soft' }, 'Now move the cats and switch methods yourself.')
        : btn('Next question', () => ask(i + 1), 'v-cs-ans'));
    if (last) play.hidden = false;
  }

  sized(svg, (w) => { W = w; draw(); });
  ask(0);
}

/* ============================================================== DEPTH
 * Heads moved apart. The reader predicts front or behind, fuses the pair,
 * then sees the answer.
 */

function side(where) {
  // a side view: you on the left, the screen, the body on it, the head in front or behind
  const g = s('svg', { viewBox: '0 -8 150 72', class: 'v-cs-side', 'aria-hidden': 'true' });
  const hx = where === 'front' ? 78 : 122;
  g.append(
    s('circle', { cx: 14, cy: 34, r: 6, class: 'v-cs-side-eye' }),
    s('text', { x: 14, y: 58, class: 'v-cs-t3', 'text-anchor': 'middle' }, 'you'),
    s('line', { x1: 100, y1: 6, x2: 100, y2: 60, class: 'v-cs-side-scr' }),
    s('circle', { cx: 100, cy: 40, r: 11, class: 'v-cs-side-body' }),
    s('circle', { cx: hx, cy: 18, r: 7, class: 'v-cs-side-head' }),
    s('text', { x: hx, y: 5, class: 'v-cs-t3 is-hi', 'text-anchor': 'middle' }, 'head'));
  return g;
}

function initDepth(fig, app) {
  let W = 0; let L = null; let d = 6; // px each head moves; + = heads further apart
  const stage = h('div', { class: 'v-cs-stage' });
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'The cat pair with the heads moved sideways' });
  stage.append(pair);
  const panel = h('div', { class: 'v-cs-depth', 'aria-live': 'polite' });
  app.append(stage, panel);
  const draw = () => { if (L) drawPair(pair, W, L, L.def, -d / L.k); };

  function predict() {
    d = 6; draw();
    panel.replaceChildren(
      h('p', { class: 'v-cs-q' }, 'The heads are now 12 px further apart than the bodies. When you fuse this pair with crossed eyes, where will the head be?'),
      h('div', { class: 'v-cs-cards' },
        ...[['front', 'In front of the body'], ['behind', 'Behind the body']].map(([w, label]) =>
          h('button', { type: 'button', class: 'v-cs-card', onclick: () => look(w) }, side(w), h('span', null, label)))));
  }
  function look(guess) {
    panel.replaceChildren(
      h('p', { class: 'v-cs-q' }, `You said ${guess === 'front' ? 'in front' : 'behind'}. Fuse the pair with crossed eyes and look at the head.`),
      btn('I looked. Show the answer', () => reveal(guess), 'v-cs-btn'));
  }
  function reveal(guess) {
    const ok = guess === 'front';
    panel.replaceChildren(
      h('div', { class: 'v-cs-answer' }, side('front'),
        h('p', null, h('b', null, ok ? 'In front, as you said. ' : 'In front. '),
          'Parts that are further apart need the eyes to cross more, and more crossing reads as nearer. Looking through, the same pair puts the head behind the body.')),
      h('p', { class: 'v-cs-soft' }, 'Try the other two:'),
      h('div', { class: 'v-cs-tabs' },
        ...[[6, 'Heads apart'], [0, 'Flat'], [-6, 'Heads together']].map(([v, label]) => {
          const b = btn(label, () => { d = v; draw(); sync(); }, 'v-cs-tab', { 'data-v': v });
          return b;
        })),
      h('p', { class: 'v-cs-say v-cs-depthsay' }));
    sync();
  }
  function sync() {
    panel.querySelectorAll('.v-cs-tab').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === d)));
    const say = panel.querySelector('.v-cs-depthsay');
    if (say) {
      say.textContent = d === 0 ? 'Flat: heads and bodies are the same distance apart.'
        : d > 0 ? 'Crossed: the head floats in front. Looking through: behind.'
          : 'Crossed: the head sits behind. Looking through: in front.';
    }
  }

  sized(stage, (w) => { W = w; L = layout(W); draw(); });
  predict();
}

register({ try: initTry, aim: initAim, depth: initDepth });

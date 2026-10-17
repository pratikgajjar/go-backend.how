/*
 * cat-stereogram-dark-mode — three figures, each built around what the
 * reader does with their own eyes.
 *
 *   try    the pair on screen and a coach: the reader reports what they see
 *          (2, 3, 4 cats, a blur) and gets one picture of that view and one
 *          next move. Four cats are told apart by the tails: side by side =
 *          not crossed enough, one cat apart = crossed too far.
 *   aim    predict, then see: where the fingertip goes when the cats move
 *          apart, and which pair you can fuse by looking through.
 *   depth  predict, then fuse: heads moved apart, does the head sit in front
 *          of the body or behind it?
 *
 * Cat outline measured from cat-stereogram.png (7016 × 4960 px, cats
 * 2,501.5 px apart). CAT units are image pixels from the left cat's body
 * centre; the right cat is the mirror image without the tail.
 *
 * Colour: ink for the cats and the lines of sight; purple for the one
 * thing to look at in a view (tails, arrows, fingertip, moving head); red
 * for "not possible". Only the fused view needs the two eyes told apart:
 * they have no colour in the site grammar, so orange stands for the left
 * eye and blue for the right. Each view keeps to two accents, and the key
 * lists only what the current view shows.
 */
import { h, s, register, clamp, tween, range, chips, ask, colorKey } from './lib.js';

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
const EYE_KEY = [['k-pick', 'left eye'], ['k-opt', 'right eye']];

/* ------------------------------------------------------------ drawing */

/** One cat. side 1 = left cat (tail), -1 = mirrored right cat. */
function cat(side, { x, y, k, headDx = 0, cls = 'is-ink', rings = false }) {
  const g = s('g', { class: `v-cs-cat ${cls}`, transform: `translate(${x},${y}) scale(${k * side},${k})` });
  const head = s('g', { transform: `translate(${headDx},0)` },
    s('circle', { cx: 0, cy: CAT.head.cy, r: CAT.head.r, 'stroke-width': CAT.head.w }));
  if (!rings) {
    head.append(s('path', { d: CAT.ear, class: 'v-cs-solid' }),
      ...CAT.whiskers.map(([x1, y1, x2, y2]) => s('line', { x1, y1, x2, y2, 'stroke-width': 34 })));
  }
  g.append(head, s('circle', { cx: 0, cy: 0, r: CAT.body.r, 'stroke-width': CAT.body.w }));
  if (side === 1 && !rings) g.append(s('path', { d: CAT.tail, 'stroke-width': 97 }));
  return g;
}

/** What the eyes see when each eye's aim moves u cat-spacings inward (0.5 = fused by crossing). */
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
  const catH = clamp(W * 0.34, 108, 180);
  const k = catH / CAT_H;
  const bodyW = 2 * CAT.right * k;
  const min = Math.ceil(bodyW * 1.12);
  const max = Math.floor(W - 16 - (CAT.left + CAT.right) * k);
  return { catH, k, min, max, def: clamp(Math.round(bodyW * 1.45), min, max) };
}

/** The pair, centred. */
function drawPair(svg, W, L, sp, headDx = 0) {
  const H = Math.round(L.catH + 28);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;
  const cx = W / 2 + ((CAT.left - CAT.right) * L.k) / 2;
  const y = 12 + CAT.top * L.k;
  svg.replaceChildren(
    cat(1, { x: cx - sp / 2, y, k: L.k, headDx }),
    cat(-1, { x: cx + sp / 2, y, k: L.k, headDx }));
}

const btn = (label, onclick) => h('button', { type: 'button', class: 'wv-btn', onclick }, label);

/* ================================================================ TRY */

function initTry(fig, app) {
  let W = 0; let L = null; let sp = 0;
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'Two cats, side by side' });
  const spacing = range('Cats apart', {
    min: 60, max: 400, value: 120,
    fmt: (v) => `${Math.round(v * SCREEN.mmPerPx)} mm`,
    oninput: (v) => { sp = v; drawPair(pair, W, L, sp); go(state); },
  });
  const coach = h('div', { class: 'v-cs-coach', 'aria-live': 'polite' });
  let key = h('div');
  app.append(h('div', { class: 'wv-grid-ctrl' }, spacing.el), pair, coach, key);

  /** A small picture of one view, drawn at the reader's spacing. */
  function view(u, { mark = null, eyes = false, label } = {}) {
    const PW = 320; const k = L.k * 0.8; const g = sp * 0.8;
    const fit = Math.min(1, (PW - 16) / ((2 * u + 1) * g + (CAT.left + CAT.right) * k));
    const kk = k * fit; const gg = g * fit;
    const top = mark === 'meet' ? 26 : 8;
    const PH = Math.round(CAT_H * kk + top + (mark === 'tails' || eyes ? 30 : 10));
    const svg = s('svg', { viewBox: `0 0 ${PW} ${PH}`, class: 'v-cs-mini', role: 'img', 'aria-label': label });
    const cx = PW / 2; const y = top + CAT.top * kk;
    const cs = copies(u);
    if (eyes) {
      for (const c of cs) svg.append(cat(c.side, { x: cx + c.x * gg, y, k: kk, cls: c.eye === 'l' ? 'is-l' : 'is-r' }));
      // the rings of the middle cat are seen by both eyes
      svg.append(cat(1, { x: cx, y, k: kk, rings: true }));
      const lab = (x, t, cls) => s('text', { x, y: PH - 8, class: `t-xs t-b ${cls}`, 'text-anchor': 'middle' }, t);
      svg.append(lab(cx - gg, 'left eye', 't-pick'), lab(cx, 'both', ''), lab(cx + gg, 'right eye', 'v-cs-t-r'));
    } else {
      const seen = new Set();
      for (const c of cs) {
        const id = `${c.x.toFixed(3)}:${c.side}`;
        if (!seen.has(id)) { seen.add(id); svg.append(cat(c.side, { x: cx + c.x * gg, y, k: kk })); }
      }
    }
    if (mark === 'tails') {
      for (const c of cs.filter((q) => q.side === 1)) {
        const tx = cx + c.x * gg + CAT.tailEnd[0] * kk; const ty = y + CAT.tailEnd[1] * kk;
        svg.append(s('line', { x1: tx, y1: ty + 4, x2: tx, y2: ty + 11, class: 'v-cs-look' }),
          s('text', { x: tx, y: ty + 23, class: 't-xs t-b t-look', 'text-anchor': 'middle' }, 'tail'));
      }
    }
    if (mark === 'meet') {
      // the middle two cats, and the way they have to move
      const [a, b] = cs.filter((c) => Math.abs(c.x) < Math.abs(u) + 0.5 - 1e-6).map((c) => cx + c.x * gg).sort((p, q) => p - q);
      const arrow = (x, d) => s('path', { d: `M${x - 9 * d},14 L${x + 3 * d},14 M${x - 1 * d},10 L${x + 3 * d},14 L${x - 1 * d},18`, class: 'v-cs-look' });
      svg.append(arrow(a, 1), arrow(b, -1));
    }
    return svg;
  }

  const S = {
    ask: () => ({
      q: `Hold a fingertip about ${cm(fingerMM(sp * SCREEN.mmPerPx))} from your eyes, between you and the cats. Look at the fingertip. Do not look at the cats. How many cats are behind it?`,
      chips: [['two', '2'], ['four', '4'], ['three', '3'], ['blur', 'a blur']],
    }),
    two: () => ({
      pic: view(0, { label: 'Two cats' }),
      say: 'Your eyes are still on the screen. Bring the fingertip closer to your eyes and keep looking at it.',
      back: 'Try again',
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
      say: 'Your eyes are not crossed enough yet. Move the fingertip a little closer to your eyes and keep looking at it. The middle two cats move toward each other.',
      back: 'Try again',
    }),
    over: () => ({
      pic: view(0.75, { mark: 'meet', label: 'The middle two cats have passed each other and need to slide back' }),
      say: 'Your eyes are crossed too far. The middle two cats have passed each other. Move the fingertip back toward the screen, and they move back together.',
      back: 'Try again',
    }),
    three: () => ({
      q: 'Check the middle cat. How many ears does it have?',
      chips: [['oneear', '1'], ['fused', '2']],
    }),
    oneear: () => ({
      say: 'Then two of the four cats overlap but have not lined up yet. Look at the tails.',
      back: 'Compare the tails', to: 'four',
    }),
    fused: () => ({
      pic: view(0.5, { eyes: true, label: 'Three cats: the left eye gives the orange parts, the right eye the blue parts, and both eyes see the rings of the middle cat' }),
      say: '<b>The cats are fused.</b> Each eye gives the middle cat one ear and one set of whiskers, and the right eye gives the tail. Take the fingertip away and keep your eyes crossed. The cat comes into focus when your eyes focus on the screen again.',
      back: 'Start over', key: [['k-ink', 'both eyes'], ...EYE_KEY],
    }),
    blur: () => ({
      say: 'That is normal at first. Your eyes point at the fingertip, so the cats are out of focus. Hold still for a few seconds. If it stays hard, move <b>Cats apart</b> to the left.',
      back: 'Try again',
    }),
  };

  let state = 'ask';
  function go(next) {
    state = next;
    const st = S[next]();
    const kids = [];
    if (st.q) {
      const block = h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, st.q));
      if (st.chips) block.append(chips(st.chips, (v) => go(v), { label: 'Your answer' }).el);
      if (st.picks) {
        block.append(h('div', { class: 'wv-chips v-cs-picks' },
          ...st.picks.map(([pic, label, to]) => h('button', { type: 'button', class: 'wv-chip v-cs-pick', onclick: () => go(to) }, pic, h('span', null, label)))));
      }
      kids.push(block);
    }
    if (st.pic) kids.push(st.pic);
    if (st.say) kids.push(h('div', { class: `wv-note${st.tone ? ` is-${st.tone}` : ''}`, html: st.say }));
    if (st.back) kids.push(h('div', { class: 'wv-bar v-cs-back' }, btn(st.back, () => go(st.to ?? 'ask'))));
    coach.replaceChildren(...kids);
    const marks = ['four', 'under', 'over'].includes(next);
    const nk = colorKey(st.key ?? [['k-ink', 'the cats'], ...(marks ? [['k-look', 'look here']] : [])]);
    key.replaceWith(nk); key = nk;
  }

  sized(pair, (w) => {
    W = w;
    const frac = L ? (sp - L.min) / Math.max(1, L.max - L.min) : null;
    L = layout(W);
    spacing.input.min = L.min; spacing.input.max = L.max;
    sp = frac == null ? L.def : Math.round(L.min + frac * (L.max - L.min));
    spacing.input.value = sp;
    spacing.el.querySelector('output').textContent = `${Math.round(sp * SCREEN.mmPerPx)} mm`;
    drawPair(pair, W, L, sp);
    go(state);
  });
}

/* ================================================================ AIM */

function initAim(fig, app) {
  const D = SCREEN.D;
  const st = { s: 20, mode: 'cross', hide: false };
  let W = 0;
  const svg = s('svg', { class: 'v-cs-top', role: 'img', 'aria-label': 'Seen from above: two eyes, the screen with two cats, and the lines of sight' });
  const qs = h('div', { class: 'v-cs-qs' });
  const spacing = range('Cats apart', { min: 10, max: 110, value: st.s, fmt: (v) => `${Math.round(v)} mm`, oninput: (v) => { cancel(); st.s = v; draw(); } });
  const mode = chips([['cross', 'Cross'], ['through', 'Look through']], (v) => { st.mode = v; draw(); }, { value: 'cross', label: 'How you aim' });
  const play = h('div', { class: 'wv-grid-ctrl' }, spacing.el, mode.el);
  play.style.display = 'none';
  let key = h('div');
  app.append(svg, qs, play, key);

  let cancel = () => {};
  function animate(to, ms) {
    cancel();
    const from = st.s;
    cancel = tween(ms, (t) => { st.s = from + (to - from) * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); draw(); });
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
    const k = [
      s('line', { x1, y1: cy - half - 8, x2: x1, y2: cy + half + 8, class: 'v-cs-scr' }),
      s('text', { x: x1, y: cy - half - 14, class: 't-s', 'text-anchor': 'middle' }, `screen, ${cm(D)} away`),
      s('text', { x: x1, y: cy + half + 26, class: 't-s', 'text-anchor': 'middle' }, `cats ${Math.round(st.s)} mm apart`),
    ];
    const cross = st.mode === 'cross';
    const aim = cross ? [yC[1], yC[0]] : [yC[0], yC[1]];
    let meet = null; let fail = false;
    if (cross) meet = { z: fingerMM(st.s, D), front: true };
    else if (st.s < EYE_GAP) meet = { z: (D * EYE_GAP) / (EYE_GAP - st.s), front: false };
    else fail = true;
    [0, 1].forEach((i) => {
      k.push(s('line', { x1: x0, y1: yE[i], x2: x1, y2: aim[i], class: 'v-cs-ray' }));
      if (!cross && !st.hide) {
        const dx = x1 - x0; const dy = aim[i] - yE[i];
        const tMax = (xMax - x0) / dx;
        const tEnd = meet ? Math.min(tMax, (X(meet.z) - x0) / dx) : tMax;
        k.push(s('line', { x1, y1: aim[i], x2: x0 + dx * tEnd, y2: yE[i] + dy * tEnd, class: 'v-cs-ray dash' }));
      }
    });
    k.push(s('circle', { cx: x1, cy: yC[0], r: 3.5, class: 'v-cs-catdot' }), s('circle', { cx: x1, cy: yC[1], r: 3.5, class: 'v-cs-catdot' }),
      s('circle', { cx: x0, cy: yE[0], r: 7, class: 'v-cs-eye' }), s('circle', { cx: x0, cy: yE[1], r: 7, class: 'v-cs-eye' }),
      s('text', { x: x0 - 12, y: yE[0] - 12, class: 't-s t-b' }, 'left eye'),
      s('text', { x: x0 - 12, y: yE[1] + 22, class: 't-s t-b' }, 'right eye'));
    if (meet && !(st.hide && !cross)) {
      const mx = X(meet.z);
      const behind = meet.z - D;
      if (mx <= xMax) {
        k.push(s('circle', { cx: mx, cy, r: 6, class: meet.front ? 'v-cs-finger' : 'v-cs-meet' }),
          s('text', { x: mx, y: cy - 14, class: 't-s t-b t-look halo', 'text-anchor': meet.front ? 'middle' : 'end' },
            meet.front ? `fingertip, ${cm(meet.z)}` : `eyes meet ${cm(behind)} behind`));
      } else {
        k.push(s('text', { x: xMax, y: cy - 10, class: 't-s t-b t-look halo', 'text-anchor': 'end' },
          `eyes meet ${behind >= 1000 ? `${(behind / 1000).toFixed(1)} m` : cm(behind)} behind →`));
      }
    }
    if (fail && !st.hide) k.push(s('text', { x: x1 - 10, y: cy + 4, class: 't-s t-b t-bad halo', 'text-anchor': 'end' }, '✕ eyes would turn outward'));
    svg.replaceChildren(...k);
    const shown = meet && !(st.hide && !cross);
    const nk = colorKey([['k-ink', 'lines of sight'], ...(shown ? [['k-look', 'where they meet']] : []), ...(fail && !st.hide ? [['k-gap', 'not possible']] : [])]);
    key.replaceWith(nk); key = nk;
    spacing.input.value = Math.round(st.s);
    spacing.el.querySelector('output').textContent = `${Math.round(st.s)} mm`;
    mode.set(st.mode);
  }

  const q1 = ask('1 of 2 · The cats move further apart. Where does the fingertip have to go?',
    [['eyes', 'Closer to my eyes'], ['screen', 'Closer to the screen']], 'eyes',
    (v, right) => {
      animate(90, 1600);
      setTimeout(showQ2, 0);
      return `${right ? 'Yes.' : 'The other way.'} Cats further apart need the eyes to cross more, so the lines of sight cross nearer to your face: from ${cm(fingerMM(20, D))} to ${cm(fingerMM(90, D))} here.`;
    });
  const q2 = ask('2 of 2 · Now look through the screen instead of crossing. Which pair can you fuse?',
    [['2', 'Cats 2 cm apart'], ['10', 'Cats 10 cm apart, like the print']], '2',
    (v, right) => {
      st.hide = false;
      animate(106, 2200);
      play.style.display = '';
      return `${right ? 'Yes, only' : 'Only'} the 2 cm pair. Looking through, each eye aims at the cat on its own side, so the lines of sight meet behind the screen, and only while the cats are closer together than your eyes. At 10 cm the eyes would have to turn outward. Now move the cats and switch methods yourself.`;
    });
  let q2shown = false;
  function showQ2() {
    if (q2shown) return;
    q2shown = true;
    const next = btn('Next question', () => {
      next.remove();
      st.mode = 'through'; st.hide = true; animate(20, 500);
      qs.append(q2.el);
    });
    qs.append(h('div', { class: 'wv-bar' }, next));
  }
  qs.append(q1.el);
  sized(svg, (w) => { W = w; draw(); });
}

/* ============================================================== DEPTH */

function sideView(where) {
  // you on the left, the screen, the body on it, the head in front or behind
  const hx = where === 'front' ? 78 : 122;
  return s('svg', { viewBox: '0 -8 150 77', class: 'v-cs-side', 'aria-hidden': 'true' },
    s('circle', { cx: 14, cy: 34, r: 6, class: 'v-cs-side-line' }),
    s('text', { x: 14, y: 58, class: 't-xs', 'text-anchor': 'middle' }, 'you'),
    s('line', { x1: 100, y1: 6, x2: 100, y2: 54, class: 'v-cs-side-line dash' }),
    s('circle', { cx: 100, cy: 40, r: 11, class: 'v-cs-side-line' }),
    s('text', { x: 100, y: 66, class: 't-xs', 'text-anchor': 'middle' }, 'body'),
    s('circle', { cx: hx, cy: 18, r: 7, class: 'v-cs-side-head' }),
    s('text', { x: hx, y: 4, class: 't-xs t-b t-look', 'text-anchor': 'middle' }, 'head'));
}

function initDepth(fig, app) {
  let W = 0; let L = null; let d = 6; // px each head moves; + = heads further apart
  const pair = s('svg', { class: 'v-cs-pair', role: 'img', 'aria-label': 'The cat pair with the heads moved sideways' });
  const draw = () => { if (L) drawPair(pair, W, L, L.def, -d / L.k); };
  const after = h('div');
  const say = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const heads = chips([[6, 'Heads apart'], [0, 'Flat'], [-6, 'Heads together']], (v) => { d = v; draw(); sync(); }, { value: 6, label: 'Move the heads' });
  function sync() {
    say.innerHTML = d === 0 ? 'The pair is flat. Heads and bodies are the same distance apart.'
      : d > 0 ? 'Heads 12 px further apart. With crossed eyes the head is <b>in front</b>. Looking through, it is behind.'
        : 'Heads 12 px closer together. With crossed eyes the head is <b>behind</b>. Looking through, it is in front.';
  }
  const q = ask('The heads are 12 px further apart than the bodies. Guess first, then fuse the pair with crossed eyes. Is the head in front of the body or behind it?',
    [['front', h('span', { class: 'v-cs-choice' }, sideView('front'), 'In front of the body')],
      ['behind', h('span', { class: 'v-cs-choice' }, sideView('behind'), 'Behind the body')]],
    'front',
    (v, right) => {
      after.hidden = false;
      return `${right ? '<b>In front, as you guessed.</b>' : '<b>In front.</b>'} Parts that are further apart need the eyes to cross more, and the brain sees more crossing as nearer. Looking through, the same pair puts the head behind the body.`;
    });
  after.append(h('p', { class: 'v-cs-then' }, 'Now try the other two, and fuse each one:'), heads.el, say);
  after.hidden = true;
  const key = colorKey([['k-ink', 'the printed cats'], ['k-look', 'the part that moves']]);
  app.append(pair, q.el, after, key);
  sync();
  sized(pair, (w) => { W = w; L = layout(W); draw(); });
}

register({ try: initTry, aim: initAim, depth: initDepth });

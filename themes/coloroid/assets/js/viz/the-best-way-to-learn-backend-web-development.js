/*
 * Figure for "The Best Way to Learn Backend Web Development".
 *
 * one-stack, in "Start With One Stack". The reader remembers: a stack takes
 * 4–6 months to feel comfortable (the post's own timeline), so switching
 * sooner means no stack gets there. The reader makes the choice the essay
 * argues about, before any bricks appear, and twelve month-bricks regroup
 * into one column per stack.
 *
 * Chrome is the shared house style (walviz.css, viz/lib.js). Drawing uses
 * ink plus two accents: purple for the window, red for a switch.
 */
import { h, s, chips, colorKey, register, REDUCED } from './lib.js';

const P = 'v-bwl-';
const HOPS = ['Python', 'Node.js', 'Go', 'Java'];
const WIN = [4, 6]; // "Feel comfortable in your stack: 4-6 months"

const SAY = {
  1: [true, 'Twelve stacks. Each one stops at month 1. None reaches the window.'],
  2: [true, 'Six stacks. Each one stops at month 2. None reaches the window.'],
  3: [true, 'Four stacks. Each one stops at month 3, one month short of the window.'],
  4: [true, 'Three stacks. Each one stops at month 4, the bottom edge of the window, and starts again.'],
  6: [false, 'Two stacks. Each one runs to month 6, the top of the window, so you get comfortable in each even if it takes the full six months.'],
  12: [false, 'One stack. You are comfortable by month 6, then you have six more months to learn the same stack in more depth.'],
};

function initOneStack(fig, app) {
  let every = null;
  let narrow = null;
  let bricks = []; let top; let names; let marks;
  const stage = h('div');
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' }, 'Pick how often you would switch. The bricks appear after you choose.');
  const pick = chips([1, 2, 3, 4, 6, 12].map((n) => [n, n === 12 ? 'never' : n === 1 ? 'every month' : `every ${n} months`]),
    (n) => { const first = every === null; every = n; layout(first); }, { label: 'Switch stacks every how many months' });

  const G = () => (narrow
    ? { W: 360, c0: 8, c1: 220, lab: 232, bh: 17, top: 8 }
    : { W: 640, c0: 8, c1: 420, lab: 440, bh: 20, top: 10 });

  function build() {
    const g = G();
    const step = g.bh + 3;
    const base = g.top + 12 * step;
    const yOf = (m) => base - m * step;
    const svg = s('svg', { viewBox: `0 0 ${g.W} ${base + 36}`, role: 'img', 'aria-label': 'Twelve monthly bricks grouped into one column per stack, against the months 4 to 6 window for feeling comfortable in a stack' });
    svg.append(s('rect', { x: g.c0, y: yOf(WIN[1]), width: g.c1 - g.c0, height: yOf(WIN[0]) - yOf(WIN[1]), class: `${P}win` }));
    svg.append(s('text', { x: g.lab, y: yOf(5) - 3, class: 't-s t-b t-look' }, narrow ? 'comfortable' : 'comfortable in your stack'));
    svg.append(s('text', { x: g.lab, y: yOf(5) + 11, class: 't-xs' }, 'months 4–6'));
    svg.append(s('line', { x1: g.c0, x2: g.c1, y1: base + 1.5, y2: base + 1.5, class: 'rule-ink' }));
    marks = s('g'); names = s('g'); top = s('text', { class: 't-xs t-b', 'text-anchor': 'middle' });
    svg.append(marks, names);
    bricks = Array.from({ length: 12 }, () => {
      const r = s('rect', { height: g.bh, class: `box ${P}brick` });
      svg.append(r);
      return r;
    });
    svg.append(top);
    stage.replaceChildren(svg);
    layout(true);
  }

  function layout(instant) {
    const g = G();
    const step = g.bh + 3;
    const base = g.top + 12 * step;
    bricks.forEach((r) => r.classList.toggle('is-shown', every !== null));
    if (every === null) return;
    const k = 12 / every;
    const gap = k > 6 ? 3 : narrow ? 8 : 14;
    const cw = Math.min(narrow ? 30 : 44, (g.c1 - g.c0 - 16 - (k - 1) * gap) / k);
    const gw = k * cw + (k - 1) * gap;
    const gx = g.c0 + (g.c1 - g.c0 - gw) / 2;
    const colX = (c) => gx + c * (cw + gap);
    bricks.forEach((r, i) => {
      const c = Math.floor(i / every); const row = i % every;
      r.setAttribute('width', cw);
      r.style.transition = instant || REDUCED ? 'none' : '';
      r.style.transform = `translate(${colX(c)}px, ${base - (row + 1) * step + 1.5}px)`;
    });
    top.setAttribute('x', gx + gw / 2);
    top.setAttribute('y', base - every * step - 7);
    top.textContent = every === 12 ? 'month 12' : `each stops at month ${every}`;
    marks.replaceChildren();
    if (k > 1 && k <= 6) {
      for (let c = 1; c < k; c++) marks.append(s('text', { x: colX(c) - gap / 2, y: base - step / 2 + 4, class: 't-s t-bad t-b', 'text-anchor': 'middle' }, '↺'));
    }
    names.replaceChildren();
    const fits = k > 1 && k <= 4 && HOPS.slice(0, k).every((n) => n.length * 6.4 < cw + gap - 2);
    const label = (x, t) => names.append(s('text', { x, y: base + 16, class: 't-xs', 'text-anchor': 'middle' }, t));
    if (k === 1) label(colX(0) + cw / 2, 'one stack, all year');
    else if (fits) HOPS.slice(0, k).forEach((n, c) => label(colX(c) + cw / 2, n));
    else label(gx + gw / 2, `${k} stacks`);
    names.append(s('text', { x: g.c0, y: base + 32, class: 't-xs t-mute' }, k > 1 ? 'one brick = one month in one stack · ↺ switch' : 'one brick = one month in one stack'));
    const [bad, text] = SAY[every];
    note.className = `wv-note${bad ? ' is-bad' : ''}`;
    note.textContent = text;
  }

  app.append(
    h('p', { class: 'wv-q' }, 'You have twelve months. How often can you switch stacks and still get comfortable in one?'),
    pick.el, stage, note,
    colorKey([['k-look', 'the window to reach'], ['k-gap', '↺ a switch: back to month 0']]),
  );
  new ResizeObserver(() => {
    const n = app.clientWidth < 560;
    if (n !== narrow) { narrow = n; build(); }
  }).observe(app);
  narrow = app.clientWidth < 560; build();
}

register({ 'one-stack': initOneStack });

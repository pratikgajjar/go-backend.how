/*
 * Figures for "The Best Way to Learn Backend Web Development".
 *
 * One unit across the post: a brick is one month spent in one stack. The
 * milestones are the post's own timeline table (months in a stack, 2–3
 * hours a day). Nothing here is measured; the figures let the reader test
 * the post's model against a choice they make or against their own months.
 *
 *   one-stack      in "Start With One Stack". "Twelve months: how often can you switch and still
 *                  get comfortable?" The reader picks the interval; the same
 *                  twelve bricks regroup into stacks.
 *   where-you-are  three short questions about the reader's months, week,
 *                  and projects, each answered next to its own small
 *                  picture, then one next step for the next hour.
 */
import { h, s, register, REDUCED } from './lib.js';

const P = 'v-bwl-';

/* From the post's "Timeline Nobody Wants to Hear" table. */
const MILESTONES = [
  { from: 1, to: 2, name: 'first working API' },
  { from: 4, to: 6, name: 'comfortable in your stack' },
  { from: 6, to: 9, name: 'portfolio-worthy project' },
  { from: 9, to: 12, name: 'ready for junior roles' },
  { from: 24, to: 36, name: 'no longer feel like an imposter' },
];
const HOPS = ['Python', 'Node.js', 'Go', 'Java'];

function watchWidth(el, cb) {
  let last = null;
  const run = () => {
    const narrow = el.clientWidth < 560;
    if (narrow !== last) { last = narrow; cb(narrow); }
  };
  run();
  new ResizeObserver(run).observe(el);
}

function chips(options, value, onpick, label) {
  const wrap = h('div', { class: `${P}chips`, role: 'group', 'aria-label': label });
  const btns = options.map(([text, v]) => {
    const b = h('button', { type: 'button', class: `${P}chip`, 'aria-pressed': String(v === value) }, text);
    b.addEventListener('click', () => {
      btns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      onpick(v);
    });
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

const mo = (n) => `${n} month${n === 1 ? '' : 's'}`;

/* =========================================================== ONE STACK */

const HERO_SAY = {
  1: 'Twelve stacks. Each one stops at month 1 and starts again. None gets comfortable.',
  2: 'Six stacks. Each one stops at month 2. None gets comfortable.',
  3: 'Four stacks. Each one stops at month 3, one month short. None gets comfortable.',
  4: 'Three stacks. Each one touches month 4, the start of the window, and starts again.',
  6: 'Two stacks, each comfortable by month 6. Neither reaches junior roles at months 9–12. This is the post\'s six-month commitment.',
  12: 'One stack. Comfortable at months 4–6, and in the junior-roles window by months 9–12.',
};

function initOneStack(fig, app) {
  let every = 3;
  let narrow = false;
  let svg; let bricks = []; let groupLabel; let names; let marks;
  const say = h('p', { class: `${P}say`, 'aria-live': 'polite' });
  const q = h('p', { class: `${P}q` }, 'You have twelve months. How often can you switch stacks and still get comfortable in one?');
  const pick = chips([1, 2, 3, 4, 6, 12].map((n) => [n === 12 ? 'never' : n === 1 ? 'monthly' : `every ${n}`, n]), every, (n) => { every = n; layout(); }, 'Switch stacks every how many months');
  const stage = h('div', { class: `${P}stage` });

  const G = () => (narrow
    ? { W: 360, ax: 22, c0: 34, c1: 214, lab: 226, bh: 17, top: 26 }
    : { W: 680, ax: 44, c0: 62, c1: 440, lab: 460, bh: 20, top: 30 });

  function build() {
    const g = G();
    const step = g.bh + 3;
    const base = g.top + 12 * step;
    const yOf = (m) => base - m * step;
    svg = s('svg', { viewBox: `0 0 ${g.W} ${base + 40}`, role: 'img', 'aria-label': 'Twelve monthly bricks grouped into stacks, against the months 4 to 6 window for feeling comfortable in a stack' });

    // the one highlight: the comfortable window
    svg.append(s('rect', { x: g.c0 - 8, y: yOf(6), width: g.lab - g.c0, height: yOf(4) - yOf(6), class: `${P}win` }));
    svg.append(s('text', { x: g.lab, y: yOf(5) - 2, class: `${P}t ${P}b ${P}purple` }, narrow ? 'comfortable' : 'comfortable in your stack'));
    svg.append(s('text', { x: g.lab, y: yOf(5) + 11, class: `${P}t ${P}xs` }, 'months 4–6'));
    // receding context: junior roles
    svg.append(s('rect', { x: g.c0 - 8, y: yOf(12), width: g.lab - g.c0, height: yOf(9) - yOf(12), class: `${P}ctx` }));
    svg.append(s('text', { x: g.lab, y: yOf(10.5) - 2, class: `${P}t ${P}mute` }, narrow ? 'junior roles' : 'ready for junior roles'));
    svg.append(s('text', { x: g.lab, y: yOf(10.5) + 11, class: `${P}t ${P}xs ${P}mute` }, 'months 9–12'));
    // axis: months in the current stack
    svg.append(s('line', { x1: g.ax, x2: g.ax, y1: yOf(12), y2: base, class: `${P}axis` }));
    [0, 3, 6, 9, 12].forEach((m) => svg.append(s('text', { x: g.ax - 5, y: yOf(m) + 4, class: `${P}t ${P}xs ${P}mute`, 'text-anchor': 'end' }, String(m))));
    svg.append(s('line', { x1: g.ax, x2: g.lab - 8, y1: base + 1.5, y2: base + 1.5, class: `${P}axis` }));

    marks = s('g');
    names = s('g');
    svg.append(marks, names);
    bricks = Array.from({ length: 12 }, () => {
      const r = s('rect', { x: 0, y: 0, height: g.bh, class: `${P}brick` });
      svg.append(r);
      return r;
    });
    // "one brick = one month", labelled once, next to a brick
    groupLabel = s('text', { class: `${P}t ${P}xs ${P}b`, 'text-anchor': 'middle' });
    svg.append(groupLabel);
    stage.replaceChildren(svg);
    layout(true);
  }

  function layout(instant) {
    const g = G();
    const step = g.bh + 3;
    const base = g.top + 12 * step;
    const k = 12 / every;
    const gap = k > 6 ? 3 : narrow ? 7 : 12;
    const cw = Math.min(narrow ? 30 : 44, (g.c1 - g.c0 - (k - 1) * gap) / k);
    const gw = k * cw + (k - 1) * gap;
    const gx = g.c0 + (g.c1 - g.c0 - gw) / 2;
    const colX = (c) => gx + c * (cw + gap);
    bricks.forEach((r, i) => {
      const c = Math.floor(i / every); const row = i % every;
      r.setAttribute('width', cw);
      r.style.transition = instant || REDUCED ? 'none' : '';
      r.style.transform = `translate(${colX(c)}px, ${base - (row + 1) * step + 1.5}px)`;
      r.classList.toggle('is-in', row >= 4 && row < 6);
    });
    groupLabel.setAttribute('x', gx + gw / 2);
    groupLabel.setAttribute('y', base - every * step - 8);
    groupLabel.textContent = every === 12 ? 'month 12' : k === 1 ? '' : `each stops at month ${every}`;
    marks.replaceChildren();
    if (k > 1 && k <= 6) {
      for (let c = 1; c < k; c++) marks.append(s('text', { x: colX(c) - gap / 2, y: base - step / 2 + 4, class: `${P}t ${P}xs ${P}red`, 'text-anchor': 'middle' }, '↺'));
    }
    names.replaceChildren();
    const fits = k > 1 && k <= 4 && HOPS.slice(0, k).every((n) => n.length * 6.4 < cw + gap - 2);
    if (k === 1) names.append(s('text', { x: colX(0) + cw / 2, y: base + 16, class: `${P}t ${P}xs`, 'text-anchor': 'middle' }, 'one stack, all year'));
    else if (fits) HOPS.slice(0, k).forEach((n, c) => names.append(s('text', { x: colX(c) + cw / 2, y: base + 16, class: `${P}t ${P}xs`, 'text-anchor': 'middle' }, n)));
    else names.append(s('text', { x: gx + gw / 2, y: base + 16, class: `${P}t ${P}xs`, 'text-anchor': 'middle' }, `${k} stacks`));
    names.append(s('text', { x: g.ax, y: base + 32, class: `${P}t ${P}xs ${P}mute` }, 'one brick = one month in one stack'));
    say.textContent = HERO_SAY[every];
    say.classList.toggle('is-good', every >= 6);
  }

  app.append(q, pick, stage, say);
  watchWidth(app, (n) => { narrow = n; build(); });
}

/* ======================================================= WHERE YOU ARE */

function slider(min, max, value, oninput, label) {
  const el = h('input', { type: 'range', min, max, step: 1, value, class: `${P}slide`, 'aria-label': label });
  el.addEventListener('input', () => oninput(+el.value));
  return el;
}

function initWhereYouAre(fig, app) {
  const st = { total: 8, stack: 3, tut: 60, built: -1 };
  let narrow = false;

  /* --- 1. your months --- */
  const totalOut = h('b', { class: `${P}val` });
  const stackOut = h('b', { class: `${P}val` });
  const totalIn = slider(0, 36, st.total, (v) => { st.total = v; if (st.stack > v) { st.stack = v; stackIn.value = v; } drawMonths(); drawNext(); }, 'Months learning backend');
  const stackIn = slider(0, 36, st.stack, (v) => { st.stack = Math.min(v, st.total); stackIn.value = st.stack; drawMonths(); drawNext(); }, 'Months in your current stack');
  const monthsPic = h('div', { class: `${P}pic` });
  const monthsSay = h('p', { class: `${P}say`, 'aria-live': 'polite' });

  function drawMonths() {
    const { total, stack } = st;
    const off = total - stack;
    totalOut.textContent = mo(total);
    stackOut.textContent = mo(stack);
    const next = MILESTONES.find((m) => stack < m.to);
    const span = Math.max(12, total + 1, next ? off + next.to + 1 : 0);
    const W = narrow ? 360 : 680; const x0 = 2; const x1 = W - 2;
    const mw = (x1 - x0) / span; const xOf = (m) => x0 + m * mw;
    const yB = 22; const bh = 20; const yN = yB + bh + 30;
    const svg = s('svg', { viewBox: `0 0 ${W} ${yN + 34}`, role: 'img', 'aria-label': `${off} months in earlier stacks, ${stack} in this one` });
    for (let m = 0; m < total; m++) {
      svg.append(s('rect', { x: xOf(m) + 1, y: yB, width: Math.max(1, mw - 2), height: bh, class: `${P}brick${m < off ? ' is-before' : ''}` }));
    }
    svg.append(s('line', { x1: x0, x2: x1, y1: yB + bh + 2, y2: yB + bh + 2, class: `${P}axis ${P}thin` }));
    const seg = (a, b, text, short, cls) => {
      if (b <= a) return;
      const w = (b - a) * mw; const t = w > text.length * 6.4 + 4 ? text : w > short.length * 6.4 ? short : '';
      if (t) svg.append(s('text', { x: xOf((a + b) / 2), y: yB + bh + 15, class: `${P}t ${P}xs ${cls}`, 'text-anchor': 'middle' }, t));
    };
    seg(0, off, `earlier stacks · ${off} mo`, `${off} mo`, `${P}red`);
    seg(off, total, `this stack · ${stack} mo`, `${stack} mo`, '');
    const xh = xOf(total);
    svg.append(s('line', { x1: xh, x2: xh, y1: yB - 6, y2: yB + bh + 4, class: `${P}here` }));
    svg.append(s('text', { x: xh, y: yB - 9, class: `${P}t ${P}xs ${P}b`, 'text-anchor': xh < 30 ? 'start' : xh > x1 - 30 ? 'end' : 'middle' }, 'you'));
    // the one highlight: the next milestone, placed on your own calendar
    if (next && total > 0) {
      const a = xOf(off + next.from); const b = xOf(off + next.to);
      svg.append(s('rect', { x: a, y: yN, width: Math.max(3, b - a), height: 10, class: `${P}next` }));
      const label = `${stack >= next.from ? 'now' : 'next'}: ${next.name}`;
      const right = b + 6 + label.length * 6.4 < x1;
      svg.append(s('text', { x: right ? b + 6 : a - 6, y: yN + 9, class: `${P}t ${P}xs ${P}b ${P}purple`, 'text-anchor': right ? 'start' : 'end' }, label));
      svg.append(s('text', { x: right ? b + 6 : a - 6, y: yN + 23, class: `${P}t ${P}xs`, 'text-anchor': right ? 'start' : 'end' }, `months ${off + next.from}–${off + next.to} of your calendar`));
    }
    monthsPic.replaceChildren(svg);
    if (total === 0) monthsSay.textContent = 'You are at the start. The timeline begins the day you pick a stack.';
    else if (!next) monthsSay.textContent = `${mo(stack)} in one stack. You are past every row of the timeline.`;
    else if (off > 0) monthsSay.innerHTML = `${stack >= next.from ? 'Now' : 'Next'}: <b>${next.name}</b>. Without the switch it would sit at months ${next.from}–${next.to} of your calendar; the ${mo(off)} in earlier stacks pushed it to ${off + next.from}–${off + next.to}. The concepts came with you. The syntax, idioms, and debugging habits started again.`;
    else monthsSay.innerHTML = `${stack >= next.from ? 'Now' : 'Next'}: <b>${next.name}</b>, at months ${next.from}–${next.to}. No switch, so nothing moved.`;
  }

  /* --- 2. your week --- */
  const tutOut = h('b', { class: `${P}val` });
  const tutIn = slider(0, 100, st.tut, (v) => { st.tut = v; drawWeek(); drawNext(); }, 'Percent of learning time in tutorials');
  tutIn.step = 10;
  const weekPic = h('div', { class: `${P}week` });
  const weekSay = h('p', { class: `${P}say`, 'aria-live': 'polite' });
  function drawWeek() {
    const t = st.tut; tutOut.textContent = `${t}%`;
    weekPic.replaceChildren(
      h('span', { class: `${P}wk-tut`, style: `width:${t}%` }, t >= 25 ? 'tutorials' : ''),
      h('span', { class: `${P}wk-build`, style: `width:${100 - t}%` }, 100 - t >= 25 ? 'building' : ''),
      h('i', { class: `${P}wk-mark`, style: 'left:30%' }, h('em', null, 'the post: 30%')),
    );
    weekSay.innerHTML = t <= 30
      ? `<span class="${P}good">That matches 30/70.</span> Most of your week is building.`
      : `${t - 30} points above the post's 30%. The learning happens in the other part, when the tutorial ends and you are alone with a blank screen.`;
  }

  /* --- 3. what you have built --- */
  const BUILT = [['nothing of my own yet', 0], ['tutorial projects', 1], ['my own project', 2], ['my own project, deployed', 3]];
  const builtPick = chips(BUILT, st.built, (v) => { st.built = v; drawNext(); }, 'What you have built');

  /* --- your next hour --- */
  const next = h('div', { class: `${P}hour`, 'aria-live': 'polite' });
  function drawNext() {
    const { total, stack, tut, built } = st;
    let t;
    if (built < 0) t = 'Pick an answer to question 3 to see it.';
    else if (total === 0) t = 'Pick one stack: Python and Django, Node.js and Express, or Go with Gin or Chi. Install it and get a hello-world API running.';
    else if (built <= 1) t = 'Start the URL shortener from scratch with one endpoint: <code>POST /shorten</code> stores a URL and returns a short code. Get stuck, read the docs, work it out.';
    else if (tut > 30) t = `Close the tutorial. Spend the hour on the next row of the shortener's feature table instead; that moves your ${tut}% toward 30.`;
    else if (stack < 6) t = `Keep going in this stack. Month 6 of it is month ${total - stack + 6} of your calendar; do not switch before then.`;
    else if (built === 2) t = 'Add the next row of the feature table: redirects with the right status code, click tracking, then 1,000 requests a second.';
    else if (stack >= 9) t = 'The timeline puts junior roles at months 9–12 of a stack. Send one application, then add a feature to the shortener.';
    else t = 'Add a row from the feature table. Portfolio-worthy work shows at months 6–9 of a stack.';
    next.innerHTML = `<span class="${P}hour-k">Your next hour</span>${t}`;
    next.classList.toggle('is-wait', built < 0);
  }

  const step = (n, question, ...rest) => h('section', { class: `${P}step` }, h('span', { class: `${P}n` }, String(n)), h('div', null, h('p', { class: `${P}ask` }, ...question), ...rest));
  app.append(
    step(1, ['I have been learning backend for ', totalOut, '.'], totalIn,
      h('p', { class: `${P}ask` }, 'The last ', stackOut, ' were in my current language and framework.'), stackIn, monthsPic, monthsSay),
    step(2, ['About ', tutOut, ' of my learning time is tutorials, courses, and videos.'], tutIn, weekPic, weekSay),
    step(3, ['So far I have built…'], builtPick),
    next,
  );
  const redraw = () => { drawMonths(); drawWeek(); drawNext(); };
  watchWidth(app, (n) => { narrow = n; redraw(); });
}

register({ 'one-stack': initOneStack, 'where-you-are': initWhereYouAre });

/*
 * viz/lib — shared helpers for per-post interactive figures.
 *
 * A post's figures live in assets/js/viz/<post-slug>.js and mount on
 * <figure data-viz="kind"> elements rendered by the `viz` shortcode:
 *
 *   import { h, s, stepper, register } from './lib.js';
 *   register({ 'my-kind': (fig, app) => { app.append(...); } });
 *
 * Styling comes from assets/css/walviz.css (.wv-* classes, colour tokens)
 * plus an optional assets/css/viz/<post-slug>.css.
 */

export const SVGNS = 'http://www.w3.org/2000/svg';
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const uid = (p = 'v') => `${p}${++UID}`;
let UID = 0;

/* ---------------------------------------------------------------- utils */

export function setAttrs(e, a) {
  if (!a) return;
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
}
export function add(e, kids) {
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
export const h = (tag, a, ...kids) => { const e = document.createElement(tag); setAttrs(e, a); return add(e, kids); };
export const s = (tag, a, ...kids) => { const e = document.createElementNS(SVGNS, tag); setAttrs(e, a); return add(e, kids); };
export const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lsn = (n) => `${Math.floor(n / 2 ** 32).toString(16).toUpperCase()}/${(n % 2 ** 32).toString(16).toUpperCase()}`;
export const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const easeBack = (t) => { const c = 1.4; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };

export function btn(label, onclick, extra = {}) {
  return h('button', { class: 'wv-btn', type: 'button', onclick, ...extra }, label);
}

/** A code listing with optional highlighted lines. `// …` becomes a comment. */
export function codeBlock(lines, hot = []) {
  const set = new Set(hot);
  const html = lines.map((ln, i) => {
    let t = esc(ln);
    const c = t.indexOf('//');
    if (c >= 0) t = `${t.slice(0, c)}<span class="cm">${t.slice(c)}</span>`;
    t = t.replace(/⟪(.+?)⟫/g, '<span class="ok">$1</span>').replace(/⟦(.+?)⟧/g, '<span class="bad">$1</span>').replace(/«(.+?)»/g, '<span class="dt">$1</span>');
    return `<span class="ln${set.has(i) ? ' is-hot' : ''}">${t || ' '}</span>`;
  }).join('');
  return `<pre class="wv-code"><code>${html}</code></pre>`;
}

/** Pause work while a figure is off screen. */
export function onVisible(el, cb) {
  if (!('IntersectionObserver' in window)) { cb(true); return; }
  new IntersectionObserver((es) => es.forEach((e) => cb(e.isIntersecting)), { threshold: 0.15 }).observe(el);
}

/** Tween helper driven by requestAnimationFrame. */
export function tween(ms, fn, done) {
  if (REDUCED || ms <= 0) { fn(1); done?.(); return () => {}; }
  let raf = 0; const t0 = performance.now();
  const loop = (now) => {
    const t = clamp((now - t0) / ms, 0, 1);
    fn(t);
    if (t < 1) raf = requestAnimationFrame(loop); else done?.();
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}

/** Diagonal ink hatch: "work in progress, not yet durable". */
export function hatchDefs(id) {
  return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" style="fill:var(--board)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink);stroke-width:1.6"/></pattern>`;
}

/** Colour key row. items: [[keyClass, label], …] */
export function colorKey(items) {
  return h('div', { class: 'wv-key' }, ...items.map(([k, label]) => h('span', null, h('i', { class: k }), label)));
}

/* ------------------------------------------------------------- stepper */

/**
 * Named step pills + Back / Play / Next. Keyboard: ← →.
 * onStep(i, prev) renders the state for step i.
 */
export function stepper(root, steps, onStep, { interval = 3200 } = {}) {
  let i = -1;
  let timer = null;
  const pills = h('div', { class: 'wv-pills', role: 'group', 'aria-label': 'Steps' });
  const pillEls = steps.map((st, k) => {
    const p = h('button', { class: 'wv-pill', type: 'button', onclick: () => { stop(); go(k); } },
      h('span', { class: 'n' }, String(k + 1).padStart(2, '0')), st.label);
    pills.append(p);
    return p;
  });
  const back = btn('◀ Back', () => { stop(); go(i - 1); }, { 'aria-label': 'Previous step' });
  const play = btn('▶ Play', () => toggle(), { 'aria-pressed': 'false' });
  const next = btn('Next ▶', () => { stop(); go(i + 1); }, { 'aria-label': 'Next step' });
  const pos = h('span', { class: 'wv-pos', 'aria-live': 'polite' });
  const el = h('div', { class: 'wv-bar' }, pills, back, play, pos, h('span', { class: 'wv-sp' }), next);

  function go(n) {
    n = clamp(n, 0, steps.length - 1);
    if (n === i) return;
    const prev = i;
    i = n;
    pillEls.forEach((p, k) => {
      p.classList.toggle('is-past', k < i);
      if (k === i) p.setAttribute('aria-current', 'step'); else p.removeAttribute('aria-current');
    });
    const pr = pills.getBoundingClientRect();
    const er = pillEls[i].getBoundingClientRect();
    if (er.left < pr.left || er.right > pr.right) pills.scrollLeft += er.left - pr.left - pr.width / 3;
    back.disabled = i === 0;
    next.disabled = i === steps.length - 1;
    pos.textContent = `${i + 1} / ${steps.length}`;
    if (!timer) play.textContent = i === steps.length - 1 ? '↻ Replay' : '▶ Play';
    onStep(i, prev);
    if (i === steps.length - 1) stop();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    play.textContent = i === steps.length - 1 ? '↻ Replay' : '▶ Play';
    play.setAttribute('aria-pressed', 'false');
  }
  function toggle() {
    if (timer) { stop(); return; }
    if (i === steps.length - 1) go(0);
    timer = setInterval(() => go(i + 1), interval);
    play.textContent = '❚❚ Pause';
    play.setAttribute('aria-pressed', 'true');
  }
  root.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight') { stop(); go(i + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { stop(); go(i - 1); e.preventDefault(); }
  });
  onVisible(root, (v) => { if (!v && timer) stop(); });
  return { el, go, stop, get i() { return i; } };
}

/** Seeded PRNG for repeatable simulations. */
export function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Labelled range input. Returns { el, input, set(v) }. */
export function range(label, { min, max, step = 1, value, fmt: f = String, oninput }) {
  const out = h('output');
  const input = h('input', { type: 'range', min, max, step, value });
  const sync = () => { out.textContent = f(+input.value); };
  input.addEventListener('input', () => { sync(); oninput?.(+input.value); });
  sync();
  const el = h('div', { class: 'wv-range' }, h('label', null, label), input, out);
  return { el, input, set(v) { input.value = v; sync(); oninput?.(+v); } };
}

/**
 * Choice chips. options: [[value, label], …]. multi toggles several.
 * Returns { el, value, set(v) }. Selected chips are aria-pressed (blue).
 */
export function chips(options, onpick, { value = null, multi = false, label } = {}) {
  let cur = multi ? new Set(value ?? []) : value;
  const els = options.map(([v, text]) => h('button', {
    class: 'wv-chip', type: 'button', onclick: () => pick(v),
  }, text));
  const el = h('div', { class: 'wv-chips', role: 'group', 'aria-label': label }, ...els);
  function paint() {
    options.forEach(([v], i) => els[i].setAttribute('aria-pressed', String(multi ? cur.has(v) : cur === v)));
  }
  function pick(v) {
    if (multi) { if (cur.has(v)) cur.delete(v); else cur.add(v); } else cur = v;
    paint(); onpick?.(multi ? [...cur] : cur);
  }
  paint();
  return { el, get value() { return multi ? [...cur] : cur; }, set(v) { cur = multi ? new Set(v) : v; paint(); } };
}

/**
 * Predict-then-see. The reader picks an answer before seeing it.
 * choices: [[value, label], …]; answer: correct value; explain(value, right) → html.
 */
export function ask(question, choices, answer, explain) {
  const note = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  note.hidden = true;
  const els = choices.map(([v, text]) => h('button', { class: 'wv-chip', type: 'button', onclick: () => pick(v) }, text));
  function pick(v) {
    const right = v === answer;
    choices.forEach(([c], i) => {
      els[i].disabled = true;
      els[i].classList.toggle('is-right', c === answer);
      els[i].classList.toggle('is-wrong', c === v && !right);
    });
    note.hidden = false;
    note.className = `wv-note ${right ? 'is-good' : 'is-bad'}`;
    note.innerHTML = explain(v, right);
  }
  function reset() {
    els.forEach((e) => { e.disabled = false; e.classList.remove('is-right', 'is-wrong'); });
    note.hidden = true;
  }
  const el = h('div', { class: 'wv-ask' }, h('p', { class: 'q' }, question), h('div', { class: 'wv-chips' }, ...els), note);
  return { el, reset };
}

/* ---------------------------------------------------------------- mount */

const WIDGETS = {};

/**
 * Register widgets by kind. init(fig, app) receives the <figure> and its
 * .wv-app container; data-* params from the shortcode are on fig.dataset.
 */
export function register(widgets) {
  Object.assign(WIDGETS, widgets);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}

function mount() {
  document.querySelectorAll('figure[data-viz]').forEach((fig) => {
    const init = WIDGETS[fig.dataset.viz];
    if (!init || fig.classList.contains('wv-live')) return;
    try {
      fig.classList.add('wv-live');
      init(fig, fig.querySelector('.wv-app'));
    } catch (err) {
      fig.classList.remove('wv-live');
      console.error('viz:', fig.dataset.viz, err);
    }
  });
}

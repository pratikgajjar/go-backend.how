/*
 * Figures for "Lost SSH Access to EC2". Both use one map: the user data,
 * the two marker files cloud-init checks, and authorized_keys. The map stays
 * in place; only the state changes, so the reader's picture carries from
 * Fig. 1 to Fig. 2.
 *
 *   lssh-restart  predict: a new key in user data, then a restart. Do you get
 *                 in? See the launch marker that blocks it, then add the
 *                 override and see the second marker that lets it through.
 *   lssh-again    predict: a second recovery with the same once line. See
 *                 the .once marker from the first recovery block it, then
 *                 switch to always.
 *
 * Paths, module names and log lines come from cloud-init 26.1 on Ubuntu
 * 24.04 (container, NoCloud seed). Key comments are samples.
 */
import { h, s, btn, ask, colorKey, uid, register } from './lib.js';

/* ------------------------------------------------------------- helpers */

const path = (pts) => `M${pts.map((p) => p.join(',')).join(' L')}`;
function onLayout(el, cb) {
  let mode = '';
  const check = () => {
    const m = el.clientWidth && el.clientWidth < 600 ? 'tall' : 'wide';
    if (m !== mode) { mode = m; cb(m); }
  };
  new ResizeObserver(check).observe(el);
  check();
}
/** Key glyph: bow, shaft, two teeth. tone: ink | safe | bad | mute. */
function keyGlyph(x, y, tone) {
  return s('g', { class: `v-lssh-kg is-${tone}`, transform: `translate(${x},${y})` },
    s('circle', { cx: 0, cy: 0, r: 7 }), s('path', { d: 'M7,0 H30 M23,0 V6 M27,0 V5' }));
}
/** File outline with a folded corner. Files are data at rest, so dashed. */
function fileCard(x, y, w, hh, tone) {
  const f = 12;
  return s('path', { class: `v-lssh-file is-${tone}`, d: `M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + hh} H${x} Z M${x + w - f},${y} V${y + f} H${x + w}` });
}
const T = (x, y, t, cls = '', a = 'start') => s('text', { x, y, class: cls, 'text-anchor': a }, t);
const TONE = { bad: 't-bad', safe: 't-safe', mute: 't-mute', ink: '' };

/* ------------------------------------------------------------ the map */

const LAYOUT = {
  wide: {
    vb: [900, 260],
    doc: [10, 70, 200, 118],
    a: [300, 8, 320, 104], b: [300, 146, 320, 104],
    ak: [690, 50, 200, 140], prompt: [690, 222],
    railA: [[210, 129], [250, 129], [250, 60], [292, 60]], stopA: [292, 60],
    railB: [[250, 129], [250, 198], [296, 198]],
    out: [[620, 198], [655, 198], [655, 150], [686, 150]],
  },
  tall: {
    vb: [360, 620],
    doc: [80, 4, 200, 112],
    a: [30, 144, 320, 104], b: [30, 290, 320, 104],
    ak: [30, 428, 320, 140], prompt: [30, 604],
    railA: [[80, 60], [12, 60], [12, 196], [24, 196]], stopA: [24, 196],
    railB: [[12, 196], [12, 342], [26, 342]],
    out: [[190, 394], [190, 424]],
  },
};

/**
 * One state of the map.
 *   key      name of the key in user data
 *   line     the cloud_final_modules line in user data, or null
 *   a        launch marker: 'unknown' | 'bad' (exists, the point) | 'quiet' (exists, context)
 *   b        null (empty slot) | 'default' | 'once-run' | 'once-skip' | 'always-run' | 'unknown'
 *   keys     [[comment, tone]] lines in authorized_keys
 *   prompt   [text, tone]
 */
function drawMap(stage, L, st, id) {
  const [W, H] = L.vb; const tall = L === LAYOUT.tall;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': st.label });
  svg.innerHTML = `<defs><marker id="${id}-g" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="v-lssh-ah"/></marker></defs>`;

  // user data
  const [dx, dy, dw, dh] = L.doc;
  svg.append(fileCard(dx, dy, dw, dh, 'ink'));
  svg.append(T(dx + 14, dy + 22, 'user data', 't-m t-b'));
  svg.append(keyGlyph(dx + 22, dy + 48, 'ink'));
  svg.append(T(dx + 62, dy + 52, st.key, 't-s'));
  if (st.line) {
    svg.append(T(dx + 14, dy + 78, 'cloud_final_modules:', 't-xs'));
    svg.append(T(dx + 14, dy + 94, `- ${st.line}`, 't-xs t-b'));
  }

  // init stage: users_groups, once per instance
  svg.append(s('path', { d: path(L.railA), class: 'edge' }));
  const [ax, ay, aw, ah] = L.a;
  const aBad = st.a === 'bad';
  if (st.a !== 'unknown') { const [sx, sy] = L.stopA; svg.append(s('path', { d: `M${sx - 2},${sy - 14} V${sy + 14}`, class: `v-lssh-stop is-${aBad ? 'bad' : 'ink'}` })); }
  svg.append(fileCard(ax, ay, aw, ah, aBad ? 'bad' : 'ink'));
  svg.append(T(ax + 14, ay + 22, 'init stage · users_groups', 't-m t-b'));
  svg.append(T(ax + 14, ay + 40, 'once per instance, marker:', 't-xs'));
  svg.append(T(ax + 14, ay + 58, tall ? '…/instances/<id>/sem/' : '/var/lib/cloud/instances/<id>/sem/', 't-s'));
  svg.append(T(ax + 14, ay + 74, 'config_users_groups', 't-s t-b'));
  if (st.a !== 'unknown') svg.append(T(ax + aw - 14, ay + ah - 10, 'exists since launch → skip', `t-s t-b ${aBad ? 't-bad' : ''}`, 'end'));
  else svg.append(T(ax + aw - 14, ay + ah - 10, 'exists?', 't-s t-mute', 'end'));

  // final stage slot
  const [bx, by, bw, bh] = L.b;
  const B = st.b;
  if (B === 'default') {
    svg.append(s('rect', { x: bx, y: by, width: bw, height: bh, class: 'rule dash' }));
    svg.append(T(bx + bw / 2, by + bh / 2 - 4, 'final stage: its default list', 't-s', 'middle'));
    svg.append(T(bx + bw / 2, by + bh / 2 + 14, 'has no users-groups', 't-s', 'middle'));
  } else if (B) {
    const run = B.endsWith('run'); const always = B.startsWith('always');
    const tone = B === 'unknown' ? 'ink' : run ? 'safe' : 'bad';
    svg.append(s('path', { d: path(L.railB), class: run ? 'edge-ack' : 'edge', 'marker-end': run ? `url(#${id}-g)` : null }));
    if (B === 'once-skip') { const [ex, ey] = L.railB[L.railB.length - 1]; svg.append(s('path', { d: `M${ex},${ey - 14} V${ey + 14}`, class: 'v-lssh-stop is-bad' })); }
    svg.append(fileCard(bx, by, bw, bh, B === 'once-run' || always ? 'absent' : tone));
    svg.append(T(bx + 14, by + 22, `final stage · users-groups`, 't-m t-b'));
    if (always) {
      svg.append(T(bx + 14, by + 40, 'always, marker:', 't-xs'));
      svg.append(T(bx + 14, by + 64, 'none', 't-s t-b'));
      svg.append(T(bx + bw - 14, by + bh - 10, 'nothing to find → run', 't-s t-b t-safe', 'end'));
    } else {
      svg.append(T(bx + 14, by + 40, 'once, marker:', 't-xs'));
      svg.append(T(bx + 14, by + 58, '/var/lib/cloud/sem/', 't-s'));
      svg.append(T(bx + 14, by + 74, 'config_users_groups.once', 't-s t-b'));
      const say = { 'once-run': 'not there yet → run', 'once-skip': 'exists since recovery 1 → skip', unknown: 'exists?' }[B];
      svg.append(T(bx + bw - 14, by + bh - 10, say, `t-s t-b ${TONE[tone] || 't-mute'}`, 'end'));
    }
    if (run) svg.append(s('path', { d: path(L.out), class: 'edge-ack', 'marker-end': `url(#${id}-g)` }));
  }

  // authorized_keys
  const [kx, ky, kw, kh] = L.ak;
  svg.append(fileCard(kx, ky, kw, kh, 'ink'));
  svg.append(T(kx + 14, ky + 22, 'authorized_keys', 't-m t-b'));
  st.keys.forEach(([name, tone], i) => {
    const yy = ky + 50 + i * 28;
    svg.append(keyGlyph(kx + 22, yy, tone));
    svg.append(T(kx + 62, yy + 4, name, `t-s ${tone === 'ink' ? '' : `t-b ${TONE[tone]}`}`));
  });
  const [px, py] = L.prompt;
  svg.append(T(px, py, st.prompt[0], `t-s t-b ${TONE[st.prompt[1]]}`));
  stage.replaceChildren(svg);
}

/**
 * A predict-then-see figure on the map: a question, a reveal, one action.
 * states: { ask, seen, done }; text: { q, choices, answer, seen, act, done }.
 */
function mapFigure(app, states, text) {
  const id = uid('lssh');
  const stage = h('div', { class: 'v-lssh-svg' });
  const bar = h('div', { class: 'wv-bar' });
  let st = 'ask'; let L = null;
  const draw = () => L && drawMap(stage, L, states[st], id);

  const q = ask(text.q, text.choices, text.answer, () => { st = 'seen'; draw(); controls(); return text.seen; });
  // Answering disables the chips and replacing a button drops focus to the
  // page, where main.js maps arrow keys to the previous/next post. Move focus
  // to the next control instead.
  function controls() {
    if (st === 'seen') {
      const act = btn(text.act, () => { st = 'done'; draw(); controls(); });
      bar.replaceChildren(act);
      act.focus({ preventScroll: true });
    }
    else if (st === 'done') {
      const again = btn('Start over', () => { st = 'ask'; q.reset(); draw(); controls(); q.el.querySelector('.wv-chip').focus({ preventScroll: true }); }, { class: 'wv-btn wv-btn--ghost' });
      bar.replaceChildren(h('div', { class: 'wv-note', html: text.done }), again);
      again.focus({ preventScroll: true });
    } else bar.replaceChildren();
  }
  app.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); });
  app.append(q.el, bar, stage, colorKey([['k-gap', 'marker exists: skip'], ['k-held', 'no marker: run']]));
  onLayout(stage, (m) => { L = LAYOUT[m]; draw(); });
}

/* ================================================================ Fig. 1 */

function initRestart(fig, app) {
  const old = ['old@laptop', 'ink'];
  mapFigure(app, {
    ask: { label: 'User data with a new key; whether the users_groups marker exists is not shown yet', key: 'new@laptop', line: null, a: 'unknown', b: null, keys: [old, ['new@laptop ?', 'mute']], prompt: ['$ ssh -i new … ?', 'mute'] },
    seen: { label: 'The users_groups marker from launch exists, so the module skips and the new key is not added', key: 'new@laptop', line: null, a: 'bad', b: 'default', keys: [old, ['new: not added', 'bad']], prompt: ['Permission denied (publickey)', 'bad'] },
    done: { label: 'With the override, users-groups runs in the final stage under a marker that does not exist yet, and the new key is added', key: 'new@laptop', line: '[users-groups, once]', a: 'bad', b: 'once-run', keys: [old, ['new@laptop', 'safe']], prompt: ['ubuntu@ip-172-31-5-20:~$', 'safe'] },
  }, {
    q: 'Your new public key is in the user data. You start the instance. Do you get in?',
    choices: [['yes', 'Yes, cloud-init adds it'], ['no', 'No']],
    answer: 'no',
    seen: 'You do not get in. Cloud-init reads the new user data on this boot, but the module that writes keys, <code>users_groups</code>, ran at launch and left a marker file. The marker is still there, so the module skips.',
    act: 'Add the cloud_final_modules line ▶',
    done: 'The line runs the same module again in the final stage, under a different marker file that does not exist yet. So it runs and appends your key.',
  });
}

/* ================================================================ Fig. 2 */

function initAgain(fig, app) {
  const had = [['old@laptop', 'ink'], ['new@laptop', 'ink']];
  mapFigure(app, {
    ask: { label: 'A second recovery with the same once line; whether the .once marker exists is not shown yet', key: 'third@laptop', line: '[users-groups, once]', a: 'quiet', b: 'unknown', keys: [...had, ['third@laptop ?', 'mute']], prompt: ['$ ssh -i third … ?', 'mute'] },
    seen: { label: 'The .once marker from the first recovery exists, so users-groups skips and the third key is not added', key: 'third@laptop', line: '[users-groups, once]', a: 'quiet', b: 'once-skip', keys: [...had, ['third: not added', 'bad']], prompt: ['Permission denied (publickey)', 'bad'] },
    done: { label: 'With always, users-groups keeps no marker, runs, and adds the third key', key: 'third@laptop', line: '[users-groups, always]', a: 'quiet', b: 'always-run', keys: [...had, ['third@laptop', 'safe']], prompt: ['ubuntu@ip-172-31-5-20:~$', 'safe'] },
  }, {
    q: 'A year later you lose the new key too. You repeat the steps with a third key and the same [users-groups, once] line. Do you get in?',
    choices: [['yes', 'Yes, it worked last time'], ['no', 'No']],
    answer: 'no',
    seen: 'You do not get in. The <code>.once</code> marker from the first recovery is still on the root volume, so cloud-init skips the module and still logs <code>SUCCESS: config-users-groups previously ran</code>.',
    act: 'Change once to always ▶',
    done: '<code>always</code> keeps no marker, so the module runs. It also runs on every later boot until you clear the user data, and adds this key back even if you delete it.',
  });
}

register({ 'lssh-restart': initRestart, 'lssh-again': initAgain });

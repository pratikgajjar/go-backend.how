/*
 * Figures for "Lost SSH Access to EC2". House look (.wv) and shared
 * components; this file only decides what each figure does.
 *
 *   lssh-hero    predict: "your key is in user data and you restart; do you
 *                get in?", then see the marker file that says no, then add
 *                the override and see the second marker that says yes
 *   lssh-play    be cloud-init: for three modules, find the marker file on
 *                the disk and choose run or skip; then one question about a
 *                second recovery
 *   lssh-choose  answer two questions about your instance, get the line to
 *                use, and see what it does on the next three boots
 *
 * Log lines, paths, and byte counts come from cloud-init 26.1 on Ubuntu
 * 24.04, run in a container with a NoCloud seed in place of IMDS. Instance
 * ID and key bodies are samples.
 */
import { h, s, btn, ask, chips, codeBlock, colorKey, uid, register } from './lib.js';

const IID = 'i-0a1b2c3d4e5f60718';
const AK = '/home/ubuntu/.ssh/authorized_keys';

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
/** Key glyph: bow, shaft, two teeth. tone: data | safe | bad | mute. */
function keyGlyph(x, y, tone) {
  return s('g', { class: `v-lssh-kg is-${tone}`, transform: `translate(${x},${y})` },
    s('circle', { cx: 0, cy: 0, r: 8 }), s('path', { d: 'M8,0 H34 M26,0 V7 M31,0 V6' }));
}
/** File outline with a folded corner; `cls` picks the drawing style. */
function fileCard(x, y, w, hh, cls) {
  const f = 12;
  return s('path', { class: `v-lssh-file ${cls}`, d: `M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + hh} H${x} Z M${x + w - f},${y} V${y + f} H${x + w}` });
}
/** main.js maps ← → on the document to prev/next post; keep keys in the figure. */
const keep = (e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); };

/* ================================================================ hero */

const HERO = {
  wide: {
    vb: [900, 250],
    doc: [10, 80, 160, 90],
    a: [300, 8, 320, 100], b: [300, 142, 320, 100],
    ak: [690, 70, 200, 110], prompt: [690, 212],
    railA: [[170, 125], [230, 125], [230, 58], [292, 58]], stopA: [292, 58],
    railB: [[230, 125], [230, 192], [296, 192]],
    out: [[620, 192], [655, 192], [655, 140], [686, 140]],
  },
  tall: {
    vb: [360, 560],
    doc: [100, 4, 160, 84],
    a: [30, 120, 320, 100], b: [30, 266, 320, 100],
    ak: [30, 400, 320, 104], prompt: [30, 540],
    railA: [[100, 46], [12, 46], [12, 170], [24, 170]], stopA: [24, 170],
    railB: [[12, 170], [12, 316], [26, 316]],
    out: [[190, 366], [190, 396]],
  },
};

function initHero(fig, app) {
  const id = uid('lsshh');
  let st = 'ask'; let L = null;
  const stage = h('div', { class: 'v-lssh-svg' });
  const next = h('div', { class: 'wv-bar' });
  const T = (x, y, t, cls = '', a = 'start') => s('text', { x, y, class: cls, 'text-anchor': a }, t);

  const q = ask('Your new public key is in the user data. You start the instance. Do you get in?',
    [['yes', 'Yes, cloud-init adds it'], ['no', 'No']], 'no',
    () => {
      st = 'plain'; draw(); controls();
      return 'You do not get in. Cloud-init reads the new key on every boot, but the module that writes keys, <code>users_groups</code>, ran at launch and left a marker file. The marker is still there, so the module skips.';
    });

  function controls() {
    if (st === 'plain') {
      next.replaceChildren(btn('Add cloud_final_modules: [users-groups, once] ▶', () => { st = 'fixed'; draw(); controls(); }));
    } else if (st === 'fixed') {
      next.replaceChildren(
        h('div', { class: 'wv-note is-good' }, 'The override runs the same module again under a different marker file, one that does not exist yet. So the module runs and appends your key.'),
        btn('Start over', () => { st = 'ask'; q.reset(); draw(); controls(); }, { class: 'wv-btn wv-btn--ghost' }));
    } else next.replaceChildren();
  }

  function draw() {
    const [W, H] = L.vb; const tall = L === HERO.tall;
    const shown = st !== 'ask'; const fixed = st === 'fixed';
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'User data with your new key, two cloud-init marker files, and authorized_keys' });
    svg.innerHTML = `<defs><marker id="${id}-g" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="v-lssh-ah"/></marker></defs>`;

    const [dx, dy, dw, dh] = L.doc;
    svg.append(fileCard(dx, dy, dw, dh, 'is-data'));
    svg.append(T(dx + 14, dy + 22, 'user data', 't-m t-b'));
    svg.append(keyGlyph(dx + 24, dy + 50, 'data'));
    svg.append(T(dx + 68, dy + 55, 'new key', 't-s t-b t-data'));

    svg.append(s('path', { d: path(L.railA), class: 'edge' }));
    if (shown) { const [sx, sy] = L.stopA; svg.append(s('path', { d: `M${sx - 2},${sy - 14} V${sy + 14}`, class: 'v-lssh-stop' })); }

    const [ax, ay, aw, ah] = L.a;
    svg.append(fileCard(ax, ay, aw, ah, shown ? 'is-bad' : 'is-data'));
    svg.append(T(ax + 14, ay + 22, 'users_groups · once per instance', 't-m t-b'));
    svg.append(T(ax + 14, ay + 44, tall ? '…/instances/<id>/sem/' : '/var/lib/cloud/instances/<id>/sem/', 't-s t-data'));
    svg.append(T(ax + 14, ay + 60, 'config_users_groups', 't-s t-b t-data'));
    svg.append(T(ax + aw - 14, ay + ah - 12, shown ? 'exists since launch → skip' : 'marker file: ?', `t-s t-b ${shown ? 't-bad' : 't-mute'}`, 'end'));

    const [bx, by, bw, bh] = L.b;
    if (fixed) {
      svg.append(s('path', { d: path(L.railB), class: 'edge-ack', 'marker-end': `url(#${id}-g)` }));
      svg.append(fileCard(bx, by, bw, bh, 'is-absent'));
      svg.append(T(bx + 14, by + 22, 'users-groups · once', 't-m t-b'));
      svg.append(T(bx + 14, by + 44, '/var/lib/cloud/sem/', 't-s t-data'));
      svg.append(T(bx + 14, by + 60, 'config_users_groups.once', 't-s t-b t-data'));
      svg.append(T(bx + bw - 14, by + bh - 12, 'not there yet → run', 't-s t-b t-safe', 'end'));
      svg.append(s('path', { d: path(L.out), class: 'edge-ack', 'marker-end': `url(#${id}-g)` }));
    } else if (shown) {
      svg.append(s('rect', { x: bx, y: by, width: bw, height: bh, class: 'rule dash' }));
      svg.append(T(bx + bw / 2, by + bh / 2 - 4, 'final stage: its default list', 't-s t-mute', 'middle'));
      svg.append(T(bx + bw / 2, by + bh / 2 + 14, 'has no users-groups', 't-s t-mute', 'middle'));
    }

    const [kx, ky, kw, kh] = L.ak;
    svg.append(fileCard(kx, ky, kw, kh, 'is-data'));
    svg.append(T(kx + 14, ky + 22, 'authorized_keys', 't-m t-b'));
    svg.append(keyGlyph(kx + 22, ky + 50, 'data'));
    svg.append(T(kx + 64, ky + 55, 'old@laptop', 't-s t-data'));
    svg.append(keyGlyph(kx + 22, ky + 80, fixed ? 'safe' : shown ? 'bad' : 'mute'));
    svg.append(T(kx + 64, ky + 85, fixed ? 'new@laptop' : shown ? 'new: not added' : 'new@laptop ?', `t-s t-b ${fixed ? 't-safe' : shown ? 't-bad' : 't-mute'}`));
    const [px, py] = L.prompt;
    svg.append(T(px, py, fixed ? 'ubuntu@ip-172-31-5-20:~$' : shown ? 'Permission denied (publickey)' : '$ ssh … → ?', `t-s t-b ${fixed ? 't-safe' : shown ? 't-bad' : 't-mute'}`));
    stage.replaceChildren(svg);
  }

  app.append(q.el, next, stage,
    colorKey([['k-data', 'your key, files'], ['k-gap', 'marker exists: skip'], ['k-held', 'no marker: run'], ['k-opt', 'your answer']]));
  onLayout(stage, (m) => { L = HERO[m]; draw(); });
}

/* ======================================================== play cloud-init */

/* Tree rows: [id, text]. Rows with `later` stay blank until they exist. */
const TREE = [
  ['r1', '/var/lib/cloud/'],
  ['inst', `├── instances/${IID}/sem/`],
  ['cug', '│   ├── config_users_groups'],
  ['more', '│   └── … 18 more markers from launch'],
  ['gsem', '└── sem/'],
  ['spo', '    ├── config_scripts_per_once.once'],
  ['cugo', '    └── config_users_groups.once', 'later'],
  ['gap', ''],
  ['akd', AK],
  ['k1', '    «ssh-ed25519 …Pcno old@laptop»'],
  ['k2', '    «ssh-ed25519 …Iosi new@laptop»', 'later'],
];

const MODULES = [
  {
    stage: 'init', name: 'update_hostname', freq: 'always', marker: null, answer: 'run', row: null,
    right: '<code>always</code> keeps no marker file, so there is nothing to find. It runs on every boot.',
    log: ['Running config-update_hostname using lock (<cloudinit.helpers.DummyLock …>)'],
  },
  {
    stage: 'init', name: 'users_groups', freq: 'once-per-instance', marker: `/var/lib/cloud/instances/${IID}/sem/config_users_groups`, answer: 'skip', row: 'cug',
    right: 'The file has been there since launch, and a stop and start keeps the instance ID. So the module skips, even though your new key is in the config.',
    log: ['Running module users_groups with frequency once-per-instance', '⟦config-users_groups already ran (freq=once-per-instance)⟧'],
  },
  {
    stage: 'final', name: 'users-groups', freq: 'once', marker: '/var/lib/cloud/sem/config_users_groups.once', answer: 'run', row: 'gsem', from: 'your cloud_final_modules',
    right: 'No such file, so the module runs. It writes the marker first, then appends your key: the file grows from 92 to 184 bytes.',
    log: ['⟪Writing to /var/lib/cloud/sem/config_users_groups.once - wb: [644] 24 bytes⟫', `⟪Writing to ${AK} - wb: [600] 184 bytes⟫`],
    adds: ['cugo', 'k2'],
  },
];
const RETRIEVE = {
  q: 'Months later you lose this key too. You repeat the same steps with a third key. On that boot, does users-groups (once) run?',
  answer: 'skip',
  right: 'The <code>.once</code> file from today is still on the disk, so cloud-init skips the module and logs SUCCESS. <code>once</code> means once per disk, not once per recovery. Fig. 3 picks the line for your case.',
  log: ['⟦config-users-groups already ran (freq=once)⟧', 'finish: modules-final/config-users-groups: SUCCESS: config-users-groups previously ran'],
};

function initPlay(fig, app) {
  let k = 0; // 0..2 modules, 3 retrieval
  const results = [];
  const table = h('table', { class: 'wv-table' });
  const askBox = h('div');
  const tree = h('div');
  const log = h('div');

  const exists = (rid, row) => !row[2] || MODULES.slice(0, results.length).some((m) => m.adds?.includes(rid));

  function drawTree(hot, fresh = []) {
    const lines = []; const hotIdx = [];
    TREE.forEach((row, i) => {
      const [rid, text] = row;
      if (!exists(rid, row)) { lines.push(''); return; }
      lines.push(fresh.includes(rid) ? `⟪${text.replace(/[«»]/g, '')}⟫` : text);
      if (rid === hot) hotIdx.push(i);
    });
    tree.innerHTML = codeBlock(lines, hotIdx);
  }

  function drawTable(hl = k) {
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'module'), h('th', null, 'frequency'), h('th', null, 'result'))),
      h('tbody', null, ...MODULES.map((m, i) => {
        const r = results[i];
        return h('tr', { class: i === hl ? 'is-look' : r === 'skip' ? 'is-gap' : r ? 'is-held' : '' },
          h('td', null, h('b', null, m.name), h('br'), `${m.stage} stage`), h('td', null, m.freq.replace('once-per-instance', 'once per instance')),
          h('td', null, r ? (r === 'run' ? 'ran' : 'skipped') : '—'));
      })));
  }

  function render() {
    drawTable();
    drawTree(null);
    const isQ = k === MODULES.length;
    const item = isQ ? RETRIEVE : MODULES[k];
    const question = isQ ? RETRIEVE.q : `${item.name} (${item.freq})${item.from ? `, from ${item.from}` : ''}. ${item.marker ? 'Find its marker file in the tree. Run or skip?' : 'It has no marker file. Run or skip?'}`;
    const a = ask(question, [['run', 'Run'], ['skip', 'Skip']], item.answer, (v, right) => {
      if (!isQ) results.push(item.answer);
      log.innerHTML = codeBlock(item.log, [item.log.length - 1]);
      drawTree(isQ ? 'cugo' : item.row, isQ ? [] : item.adds || []);
      k += 1;
      drawTable(-1);
      const label = k < MODULES.length ? 'Next module ▶' : k === MODULES.length ? 'One more question ▶' : 'Play again';
      askBox.append(h('div', { class: 'wv-bar' }, btn(label, () => {
        if (k > MODULES.length) { k = 0; results.length = 0; log.innerHTML = codeBlock(['(nothing yet)']); }
        render();
      }, k > MODULES.length ? { class: 'wv-btn wv-btn--ghost' } : {})));
      return `<b>${right ? 'Right.' : `It ${item.answer === 'run' ? 'runs' : 'skips'}.`}</b> ${item.right}`;
    });
    askBox.replaceChildren(
      item.marker ? h('dl', { class: 'wv-kv' }, h('dt', null, 'marker'), h('dd', null, h('code', null, item.marker))) : null,
      h('div', { style: 'height:.5rem' }),
      a.el);
  }

  fig.addEventListener('keydown', keep);
  log.innerHTML = codeBlock(['(nothing yet)']);
  app.append(
    h('p', { class: 'wv-q' }, 'You are cloud-init on the recovery boot. Before each module runs, you check the disk for its marker file.'),
    h('div', { class: 'v-lssh-play' },
      h('div', { class: 'v-lssh-a-q' }, table),
      h('div', { class: 'v-lssh-a-t wv-card' }, h('h5', null, 'the disk (root volume)'), tree),
      h('div', { class: 'v-lssh-a-a' }, askBox),
      h('div', { class: 'v-lssh-a-l wv-card' }, h('h5', null, 'cloud-init.log'), log)),
    colorKey([['k-opt', 'your choice'], ['k-look', 'this module / the file to check'], ['k-data', 'keys'], ['k-held', 'runs, written'], ['k-gap', 'skipped']]));
  render();
}

/* ======================================================== choose a line */

/* Three boots for each line, from the container runs. keys: [name, state]. */
const STRIP = {
  once: [
    { t: 'this boot', v: 'key added', tone: 'good', keys: [['old', ''], ['new', 'added']], mk: '.once written' },
    { t: 'next boot, if you forget to clear', v: 'no change', tone: '', keys: [['old', ''], ['new', '']], mk: '.once found', cost: 'final stage runs only users-groups' },
    { t: 'a later recovery', v: 'skipped', tone: 'bad', keys: [['old', ''], ['new', ''], ['newer', 'missing']], mk: '.once found → skip' },
  ],
  always: [
    { t: 'this boot', v: 'key added', tone: 'good', keys: [['old', ''], ['new', 'added']], mk: 'no marker' },
    { t: 'next boot, if you forget to clear', v: 'rewritten', tone: '', keys: [['old', ''], ['new', '']], mk: 'no marker', cost: 're-adds keys you delete; final stage runs only users-groups' },
    { t: 'a later recovery', v: 'key added', tone: 'good', keys: [['old', ''], ['new', ''], ['newer', 'added']], mk: 'no marker' },
  ],
};

function advise(prior, clear) {
  if (prior === 'no' && clear === 'yes') return ['once', 'Its marker does not exist on this disk yet, so it runs. This is the line AWS documents. <code>always</code> would work too.'];
  if (prior === 'no') return ['once', 'If the override stays in user data, <code>once</code> does nothing on later boots, so a key you remove later stays removed. The final stage still skips its other modules until you clear it.'];
  if (clear === 'yes') return ['always', '<code>once</code> could find a marker from the earlier recovery and skip without an error. <code>always</code> keeps no marker, so it runs.'];
  return ['always', '<code>once</code> could find a marker from the earlier recovery. <code>always</code> runs, but until you clear the user data it adds this key back on every boot, even after you delete it. Set a reminder.'];
}

function initChoose(fig, app) {
  const ans = { prior: null, clear: null };
  let view = null;
  const result = h('div', { 'aria-live': 'polite' });

  function question(name, label, hint, opts) {
    const c = chips(opts, (v) => { ans[name] = v; view = null; render(); }, { label: label.replace(/<[^>]+>/g, '') });
    return h('div', null, h('p', { class: 'wv-q', html: label }), hint ? h('p', { html: hint }) : null, h('div', { style: 'height:.4rem' }), c.el);
  }

  function strip(line) {
    return h('div', { class: 'wv-cards' }, ...STRIP[line].map((b) => h('div', { class: `wv-card${b.tone ? ` is-${b.tone}` : ''}` },
      h('h5', null, b.t),
      h('p', null, h('b', { class: b.tone === 'good' ? 'c-safe' : b.tone === 'bad' ? 'c-bad' : '' }, b.v)),
      h('p', null, ...b.keys.flatMap(([n, st], i) => [i ? ' · ' : '', h('span', { class: st === 'added' ? 'c-safe' : st === 'missing' ? 'c-bad' : 'c-data' }, st === 'added' ? `+${n}` : st === 'missing' ? `✗ ${n}` : n)])),
      h('p', { class: 'c-data' }, b.mk),
      b.cost ? h('p', { class: 'c-bad' }, b.cost) : null)));
  }

  function render() {
    if (!ans.prior || !ans.clear) { result.replaceChildren(h('div', { class: 'wv-note' }, 'Answer both questions to see the line.')); return; }
    const [pick, why] = advise(ans.prior, ans.clear);
    const line = view || pick;
    const other = line === 'once' ? 'always' : 'once';
    result.replaceChildren(
      h('div', { class: `wv-card${line === pick ? ' is-pick' : ''}` },
        h('h5', null, line === pick ? 'in step 3, use' : 'for comparison'),
        h('div', { html: codeBlock(['cloud_final_modules:', `- [users-groups, ${line}]`]) })),
      h('div', { style: 'height:.6rem' }),
      h('div', { class: 'wv-note', html: line === pick ? why : `This is the other line, for comparison. For your answers, use <code>${pick}</code>.` }),
      h('div', { style: 'height:.6rem' }),
      strip(line),
      h('div', { class: 'wv-bar', style: 'margin-top:.7rem' }, btn(`See ${other} instead`, () => { view = other; render(); }, { class: 'wv-btn wv-btn--ghost' })));
  }

  fig.addEventListener('keydown', keep);
  app.append(
    question('prior', 'Has this disk been recovered before with <code>[users-groups, once]</code>?', 'An image made from such a disk carries the marker too, unless <code>cloud-init clean</code> ran first.', [['no', 'No'], ['yes', 'Yes'], ['unsure', 'Not sure']]),
    question('clear', 'Will you clear the user data as soon as you are back in?', null, [['yes', 'Yes'], ['forget', 'I might forget']]),
    result,
    colorKey([['k-opt', 'your answers'], ['k-pick', 'the line to use'], ['k-data', 'keys, markers'], ['k-held', 'key added'], ['k-gap', 'problem']]));
  render();
}

register({ 'lssh-hero': initHero, 'lssh-play': initPlay, 'lssh-choose': initChoose });

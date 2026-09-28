/*
 * Figures for "Lost SSH Access to EC2".
 *
 * Each figure asks the reader to do one thing:
 *
 *   lssh-hero    predict: "your key is in user data and you restart; do you
 *                get in?", then see the marker file that says no, then add
 *                the override and see the second marker that says yes
 *   lssh-play    be cloud-init: for three modules, find the marker file on
 *                the disk and choose run or skip; then one question about a
 *                second recovery
 *   lssh-choose  answer two questions about your instance, get the line to
 *                paste, and see what it does on the next three boots
 *
 * Log lines, paths, and byte counts come from cloud-init 26.1 on Ubuntu
 * 24.04, run in a container with a NoCloud seed in place of IMDS. Instance
 * ID and key bodies are samples.
 */
import { h, s, esc, uid, register } from './lib.js';

const IID = 'i-0a1b2c3d4e5f60718';
const AK = '/home/ubuntu/.ssh/authorized_keys';

/* ------------------------------------------------------------- helpers */

function key(items) {
  return h('div', { class: 'v-lssh-key' }, ...items.map(([k, label]) => h('span', null, h('i', { class: `k-${k}` }), label)));
}
function logHtml(lines) {
  return lines.map(([t, tone = '']) => `<span class="v-lssh-ll${tone ? ` t-${tone}` : ''}">${esc(t)}</span>`).join('');
}
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
function keyGlyph(x, y, cls) {
  return s('g', { class: `v-lssh-kg ${cls}`, transform: `translate(${x},${y})` },
    s('circle', { cx: 0, cy: 0, r: 8 }), s('path', { d: 'M8,0 H34 M26,0 V7 M31,0 V6' }));
}
function fileCard(x, y, w, hh, cls) {
  const f = 12;
  return s('path', { class: `v-lssh-file ${cls}`, d: `M${x},${y} H${x + w - f} L${x + w},${y + f} V${y + hh} H${x} Z M${x + w - f},${y} V${y + f} H${x + w}` });
}
/** Stop ← → from reaching main.js, which maps them to prev/next post. */
const keep = (e) => { e.stopPropagation(); };

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
  let st = 'ask'; let guess = null; let L = null;
  const stage = h('div', { class: 'v-lssh-hsvg' });
  const q = h('p', { class: 'v-lssh-hq' });
  const acts = h('div', { class: 'v-lssh-hacts' });
  const say = h('p', { class: 'v-lssh-hsay', 'aria-live': 'polite' });

  const T = (x, y, t, cls = '', a = 'start') => s('text', { x, y, class: cls, 'text-anchor': a }, t);

  function draw() {
    const [W, H] = L.vb; const tall = L === HERO.tall;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'User data with your new key, two cloud-init marker files, and authorized_keys' });
    svg.innerHTML = `<defs><marker id="${id}-g" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="v-lssh-m-safe"/></marker></defs>`;
    const shown = st !== 'ask';
    const fixed = st === 'fixed';

    const [dx, dy, dw, dh] = L.doc;
    svg.append(fileCard(dx, dy, dw, dh, 'is-data'));
    svg.append(T(dx + 14, dy + 22, 'user data', 't-b'));
    svg.append(keyGlyph(dx + 24, dy + 50, 'is-data'));
    svg.append(T(dx + 68, dy + 55, 'new key', 't-data t-s t-b'));

    svg.append(s('path', { d: path(L.railA), class: 'v-lssh-rail' }));
    if (shown) { const [sx, sy] = L.stopA; svg.append(s('path', { d: `M${sx - 2},${sy - 14} V${sy + 14}`, class: 'v-lssh-stop' })); }

    const [ax, ay, aw, ah] = L.a;
    svg.append(fileCard(ax, ay, aw, ah, shown ? (fixed ? 'is-bad is-quiet' : 'is-bad') : 'is-plain'));
    svg.append(T(ax + 14, ay + 22, 'users_groups · once per instance', 't-b'));
    svg.append(T(ax + 14, ay + 44, tall ? '…/instances/<id>/sem/' : '/var/lib/cloud/instances/<id>/sem/', 't-data t-s'));
    svg.append(T(ax + 14, ay + 60, 'config_users_groups', 't-data t-s t-b'));
    svg.append(T(ax + aw - 14, ay + ah - 12, shown ? 'exists since launch → skip' : 'marker file: ?', `${shown ? 't-bad' : 't-mute'} t-s t-b`, 'end'));

    if (fixed) {
      svg.append(s('path', { d: path(L.railB), class: 'v-lssh-rail is-safe', 'marker-end': `url(#${id}-g)` }));
      const [bx, by, bw, bh] = L.b;
      svg.append(fileCard(bx, by, bw, bh, 'is-absent'));
      svg.append(T(bx + 14, by + 22, 'users-groups · once', 't-b'));
      svg.append(T(bx + 14, by + 44, '/var/lib/cloud/sem/', 't-data t-s'));
      svg.append(T(bx + 14, by + 60, 'config_users_groups.once', 't-data t-s t-b'));
      svg.append(T(bx + bw - 14, by + bh - 12, 'not there yet → run', 't-safe t-s t-b', 'end'));
      svg.append(s('path', { d: path(L.out), class: 'v-lssh-rail is-safe', 'marker-end': `url(#${id}-g)` }));
    } else if (shown) {
      const [bx, by, bw, bh] = L.b;
      svg.append(s('rect', { x: bx, y: by, width: bw, height: bh, rx: 4, class: 'v-lssh-ghost' }));
      svg.append(T(bx + bw / 2, by + bh / 2 - 4, 'final stage: its default list', 't-mute t-s', 'middle'));
      svg.append(T(bx + bw / 2, by + bh / 2 + 14, 'has no users-groups', 't-mute t-s', 'middle'));
    }

    const [kx, ky, kw, kh] = L.ak;
    svg.append(fileCard(kx, ky, kw, kh, 'is-plain'));
    svg.append(T(kx + 14, ky + 22, 'authorized_keys', 't-b'));
    svg.append(keyGlyph(kx + 22, ky + 50, 'is-data'));
    svg.append(T(kx + 64, ky + 55, 'old@laptop', 't-data t-s'));
    svg.append(keyGlyph(kx + 22, ky + 80, fixed ? 'is-safe' : shown ? 'is-bad' : 'is-mute'));
    svg.append(T(kx + 64, ky + 85, fixed ? 'new@laptop' : shown ? 'new: not added' : 'new@laptop ?', `${fixed ? 't-safe' : shown ? 't-bad' : 't-mute'} t-s t-b`));
    const [px, py] = L.prompt;
    svg.append(T(px, py, fixed ? 'ubuntu@ip-172-31-5-20:~$' : shown ? 'Permission denied (publickey)' : '$ ssh … → ?', `${fixed ? 't-safe' : shown ? 't-bad' : 't-mute'} t-s t-b`));
    stage.replaceChildren(svg);
  }

  function btn(label, onclick, cls = '') { return h('button', { type: 'button', class: `v-lssh-hb ${cls}`, onclick }, label); }

  function render() {
    if (st === 'ask') {
      q.textContent = 'Your new public key is in the user data. You start the instance. Do you get in?';
      acts.replaceChildren(btn('Yes, cloud-init adds it', () => { guess = true; st = 'plain'; render(); }), btn('No', () => { guess = false; st = 'plain'; render(); }));
      say.innerHTML = '';
    } else if (st === 'plain') {
      q.textContent = 'You do not get in.';
      say.innerHTML = `${guess ? 'Most people expect yes. ' : 'Right. '}Cloud-init reads the new key on every boot. But the module that writes keys, <code>users_groups</code>, ran at launch and left a marker file. The marker is still there, so the module skips.`;
      acts.replaceChildren(btn('Add cloud_final_modules: [users-groups, once]', () => { st = 'fixed'; render(); }, 'is-go'));
    } else {
      q.textContent = 'The override gets you in.';
      say.innerHTML = 'It runs the same module again under a different marker file, one that does not exist yet. So the module runs and appends your key.';
      acts.replaceChildren(btn('Start over', () => { st = 'ask'; render(); }, 'is-quiet'));
    }
    if (L) draw();
  }

  app.append(q, say, acts, stage,
    key([['data', 'your key, files'], ['bad', 'marker exists: skip'], ['safe', 'no marker: run'], ['opt', 'your answer']]));
  onLayout(stage, (m) => { L = HERO[m]; draw(); });
  render();
}

/* ======================================================== play cloud-init */

/*
 * Tree rows: [id, prefix, name]. Rows marked `later` stay blank (same height)
 * until they exist, so the layout never moves.
 */
const TREE = [
  ['r1', '', '/var/lib/cloud/'],
  ['inst', '├── ', `instances/${IID}/sem/`],
  ['cug', '│   ├── ', 'config_users_groups'],
  ['more', '│   └── ', '… 18 more markers from launch'],
  ['gsem', '└── ', 'sem/'],
  ['spo', '    ├── ', 'config_scripts_per_once.once'],
  ['cugo', '    └── ', 'config_users_groups.once', 'later'],
  ['gap', '', ''],
  ['akd', '', '/home/ubuntu/.ssh/authorized_keys'],
  ['k1', '    ', 'ssh-ed25519 …Pcno old@laptop'],
  ['k2', '    ', 'ssh-ed25519 …Iosi new@laptop', 'later'],
];

const MODULES = [
  {
    stage: 'init', name: 'update_hostname', freq: 'always', marker: null, answer: 'run', row: null,
    right: '<code>always</code> keeps no marker file, so there is nothing to find. It runs on every boot.',
    log: [['Running config-update_hostname using lock (<cloudinit.helpers.DummyLock …>)']],
  },
  {
    stage: 'init', name: 'users_groups', freq: 'once-per-instance', marker: `/var/lib/cloud/instances/${IID}/sem/config_users_groups`, answer: 'skip', row: 'cug',
    right: 'The file has been there since launch, and a stop and start keeps the instance ID. So the module skips, even though your new key is in the config.',
    log: [['Running module users_groups with frequency once-per-instance'], ['config-users_groups already ran (freq=once-per-instance)', 'bad']],
  },
  {
    stage: 'final', name: 'users-groups', freq: 'once', marker: '/var/lib/cloud/sem/config_users_groups.once', answer: 'run', row: 'gsem', from: 'your cloud_final_modules',
    right: 'No such file, so the module runs. It writes the marker first, then appends your key: the file grows from 92 to 184 bytes.',
    log: [['Writing to /var/lib/cloud/sem/config_users_groups.once - wb: [644] 24 bytes', 'good'], [`Writing to ${AK} - wb: [600] 184 bytes`, 'good']],
    adds: ['cugo', 'k2'],
  },
];
const RETRIEVE = {
  q: 'Months later you lose this key too. You repeat the same steps with a third key. On that boot, does users-groups (once) run?',
  answer: 'skip',
  right: 'The <code>.once</code> file from today is still on the disk, so cloud-init skips the module and logs SUCCESS. <code>once</code> means once per disk, not once per recovery. Fig. 2 picks the line for your case.',
  log: [['config-users-groups already ran (freq=once)', 'bad'], ['finish: modules-final/config-users-groups: SUCCESS: config-users-groups previously ran']],
};

function initPlay(fig, app) {
  let k = 0; // 0..2 modules, 3 retrieval, 4 done
  const answers = [];
  const queue = h('ol', { class: 'v-lssh-queue' });
  const ask = h('div', { class: 'v-lssh-ask' });
  const tree = h('pre', { class: 'v-lssh-tree', 'aria-label': 'Files on the root volume' });
  const log = h('pre', { class: 'v-lssh-log', 'aria-live': 'polite' });

  function exists(rid) {
    const row = TREE.find((r) => r[0] === rid);
    if (!row[3]) return true;
    return MODULES.slice(0, answers.length).some((m) => m.adds?.includes(rid));
  }

  function drawTree(hot, fresh = []) {
    tree.innerHTML = TREE.map(([rid, pre, name]) => {
      if (!name) return '<span class="v-lssh-tr"> </span>';
      const on = exists(rid);
      const cls = [rid === hot ? 'is-hot' : '', fresh.includes(rid) ? 'is-new' : '', rid.startsWith('k') ? 'is-key' : ''].join(' ');
      return `<span class="v-lssh-tr ${cls}">${on ? `<span class="pre">${esc(pre)}</span><span class="nm">${esc(name)}</span>` : ' '}</span>`;
    }).join('');
  }

  function drawQueue() {
    queue.replaceChildren(...MODULES.map((m, i) => {
      const done = i < answers.length;
      return h('li', { class: `v-lssh-mod${i === k ? ' is-now' : ''}${done ? ' is-done' : ''}` },
        h('span', { class: 'st' }, m.stage),
        h('span', { class: 'nm' }, m.name),
        h('span', { class: 'fq' }, m.freq),
        done ? h('span', { class: `res ${m.answer === 'run' ? 't-safe' : 't-bad'}` }, m.answer === 'run' ? 'ran' : 'skipped') : null);
    }));
  }

  function choose(a) {
    const isQ = k === MODULES.length;
    const item = isQ ? RETRIEVE : MODULES[k];
    const ok = a === item.answer;
    const lead = ok ? '<b class="t-safe">Right.</b> ' : `<b class="t-bad">It ${item.answer === 'run' ? 'runs' : 'skips'}.</b> `;
    if (!isQ) answers.push(a);
    ask.innerHTML = '';
    ask.append(h('p', { class: 'v-lssh-fb', html: lead + item.right }));
    log.innerHTML = logHtml(item.log);
    drawTree(isQ ? 'cugo' : item.row, isQ ? [] : item.adds || []);
    k += 1;
    drawQueue();
    if (k <= MODULES.length) {
      ask.append(h('button', { type: 'button', class: 'v-lssh-pb is-next', onclick: () => render() }, k === MODULES.length ? 'One more question ▶' : 'Next module ▶'));
    } else {
      ask.append(h('button', { type: 'button', class: 'v-lssh-pb is-quiet', onclick: () => { k = 0; answers.length = 0; log.innerHTML = ''; render(); } }, 'Play again'));
    }
    ask.querySelector('button')?.focus({ preventScroll: true });
  }

  function render() {
    drawQueue();
    drawTree(null);
    ask.innerHTML = '';
    if (k < MODULES.length) {
      const m = MODULES[k];
      ask.append(
        h('p', { class: 'v-lssh-mq' }, h('b', null, `${m.name}`), ` · ${m.freq}`, m.from ? h('span', { class: 'from' }, ` (from ${m.from})`) : null),
        h('p', { class: 'v-lssh-mp' }, m.marker ? h('span', null, 'Its marker file: ', h('code', { class: 't-data' }, m.marker)) : h('span', null, 'Its marker file: ', h('i', null, 'none, for always'))),
        h('p', { class: 'v-lssh-mh' }, m.marker ? 'Look for it in the tree. Run or skip?' : 'Run or skip?'),
        h('div', { class: 'v-lssh-pbs' },
          h('button', { type: 'button', class: 'v-lssh-pb', onclick: () => choose('run') }, 'Run'),
          h('button', { type: 'button', class: 'v-lssh-pb', onclick: () => choose('skip') }, 'Skip')));
    } else {
      ask.append(h('p', { class: 'v-lssh-mq' }, RETRIEVE.q),
        h('div', { class: 'v-lssh-pbs' },
          h('button', { type: 'button', class: 'v-lssh-pb', onclick: () => choose('run') }, 'Run'),
          h('button', { type: 'button', class: 'v-lssh-pb', onclick: () => choose('skip') }, 'Skip')));
    }
  }

  fig.addEventListener('keydown', keep);
  app.append(
    h('p', { class: 'v-lssh-role' }, 'You are cloud-init on the recovery boot. Before each module runs, you check the disk for its marker file.'),
    h('div', { class: 'v-lssh-play' },
      h('div', { class: 'v-lssh-a-q' }, h('div', { class: 'v-lssh-cap' }, 'modules on this boot'), queue),
      h('div', { class: 'v-lssh-a-t' }, h('div', { class: 'v-lssh-cap' }, 'the disk (root volume)'), tree),
      h('div', { class: 'v-lssh-a-a' }, ask),
      h('div', { class: 'v-lssh-a-l' }, h('div', { class: 'v-lssh-cap' }, 'cloud-init.log'), log)),
    key([['opt', 'your choice'], ['look', 'the file to check'], ['data', 'paths, keys'], ['safe', 'runs, written'], ['bad', 'skipped']]));
  render();
}

/* ======================================================== choose a line */

/* Three boots for each line, from the container runs. keys: [name, state]. */
const STRIP = {
  once: [
    { t: 'this boot', v: 'key added', tone: 'safe', keys: [['old', ''], ['new', 'added']], mk: '.once written', mkTone: 'data' },
    { t: 'next boot, if you forget to clear', v: 'no change', tone: '', keys: [['old', ''], ['new', '']], mk: '.once found', mkTone: 'data', cost: 'final stage runs only users-groups' },
    { t: 'a later recovery', v: 'skipped', tone: 'bad', keys: [['old', ''], ['new', ''], ['newer', 'missing']], mk: '.once found → skip', mkTone: 'bad' },
  ],
  always: [
    { t: 'this boot', v: 'key added', tone: 'safe', keys: [['old', ''], ['new', 'added']], mk: 'no marker', mkTone: '' },
    { t: 'next boot, if you forget to clear', v: 'rewritten', tone: '', keys: [['old', ''], ['new', '']], mk: 'no marker', mkTone: '', cost: 're-adds keys you delete; final stage runs only users-groups' },
    { t: 'a later recovery', v: 'key added', tone: 'safe', keys: [['old', ''], ['new', ''], ['newer', 'added']], mk: 'no marker', mkTone: '' },
  ],
};

function advise(prior, clear) {
  if (prior === 'no' && clear === 'yes') {
    return ['once', 'Its marker does not exist on this disk yet, so it runs. This is the line AWS documents. <code>always</code> would work too.'];
  }
  if (prior === 'no') {
    return ['once', 'If the override stays in user data, <code>once</code> does nothing on later boots, so a key you remove later stays removed. The final stage still skips its other modules until you clear it.'];
  }
  if (clear === 'yes') {
    return ['always', '<code>once</code> could find a marker from the earlier recovery and skip without an error. <code>always</code> keeps no marker, so it runs.'];
  }
  return ['always', '<code>once</code> could find a marker from the earlier recovery. <code>always</code> runs, but until you clear the user data it adds this key back on every boot, even after you delete it. Set a reminder.'];
}

function initChoose(fig, app) {
  const ans = { prior: null, clear: null };
  let view = null;
  const result = h('div', { class: 'v-lssh-res', 'aria-live': 'polite' });

  function group(name, label, hint, opts) {
    const g = h('div', { class: 'v-lssh-qg', role: 'radiogroup', 'aria-label': label.replace(/<[^>]+>/g, '') });
    const btns = opts.map(([v, t]) => h('button', { type: 'button', class: 'v-lssh-chip', role: 'radio', 'aria-checked': 'false', onclick: () => {
      ans[name] = v; view = null;
      btns.forEach((b, i) => b.setAttribute('aria-checked', String(opts[i][0] === v)));
      render();
    } }, t));
    g.append(...btns);
    return h('div', { class: 'v-lssh-q' }, h('p', { class: 'v-lssh-ql', html: label }), hint ? h('p', { class: 'v-lssh-qh', html: hint }) : null, g);
  }

  function strip(line) {
    return h('div', { class: 'v-lssh-strip' }, ...STRIP[line].map((b) => h('div', { class: `v-lssh-boot${b.tone ? ` is-${b.tone}` : ''}` },
      h('div', { class: 'bt' }, b.t),
      h('div', { class: `bv t-${b.tone || 'ink'}` }, b.v),
      h('div', { class: 'bk' }, ...b.keys.map(([n, st]) => h('span', { class: `v-lssh-kk${st ? ` is-${st}` : ''}` }, st === 'added' ? `+ ${n}` : st === 'missing' ? `✗ ${n}` : n))),
      h('div', { class: `bm${b.mkTone ? ` t-${b.mkTone}` : ''}` }, b.mk),
      b.cost ? h('div', { class: 'bc t-bad' }, b.cost) : null)));
  }

  function render() {
    if (!ans.prior || !ans.clear) {
      result.className = 'v-lssh-res is-wait';
      result.replaceChildren(h('p', null, 'Answer both questions to see the line.'));
      return;
    }
    const [pick, why] = advise(ans.prior, ans.clear);
    const line = view || pick;
    const other = line === 'once' ? 'always' : 'once';
    result.className = 'v-lssh-res';
    result.replaceChildren(
      h('div', { class: 'v-lssh-snip' },
        h('span', { class: 'lbl' }, line === pick ? 'in step 3, use' : 'for comparison'),
        h('code', null, `cloud_final_modules:\n- [users-groups, ${line}]`)),
      line === pick ? h('p', { class: 'v-lssh-why', html: why }) : h('p', { class: 'v-lssh-why' }, `This is the other line, for comparison. For your answers, use ${pick}.`),
      strip(line),
      h('button', { type: 'button', class: 'v-lssh-link', onclick: () => { view = other; render(); } }, `See ${other} instead`));
  }

  fig.addEventListener('keydown', keep);
  app.append(
    group('prior', 'Has this disk been recovered before with <code>[users-groups, once]</code>?', 'An image made from such a disk carries the marker too, unless <code>cloud-init clean</code> ran first.', [['no', 'No'], ['yes', 'Yes'], ['unsure', 'Not sure']]),
    group('clear', 'Will you clear the user data as soon as you are back in?', null, [['yes', 'Yes'], ['forget', 'I might forget']]),
    result,
    key([['opt', 'your answers'], ['pick', 'the line to use'], ['data', 'keys, markers'], ['safe', 'key added'], ['bad', 'problem']]));
  render();
}

register({ 'lssh-hero': initHero, 'lssh-play': initPlay, 'lssh-choose': initChoose });

/*
 * temporal-under-the-hood — figures for "Temporal — Under the Hood".
 *
 * House look (walviz.css); this file only decides what each figure does.
 * The recurring drawing: every SQL statement is a tally mark on the way to
 * Postgres.
 *
 *   tuth-request  pick where a request with two writes fails; each box shows
 *                 what is left behind
 *   tuth-trip     guess, then one activity as a sequence diagram with tallies
 *   tuth-crash    the worker dies during step 3: replay vs checkpoints,
 *                 with predict-then-see in the clock variant
 *   tuth-cost     SQL statements per unit of work, measured and fitted, at
 *                 the reader's own N and rate
 *
 * Behaviour follows Temporal v1.28.2 (service/history, common/persistence/sql),
 * Go SDK v1.34.0, and absurd.sql as of April 2026. Measured numbers are the
 * post's pg_stat_statements runs. Shard IDs, workers, and clock times are
 * sample values.
 */

import { h, s, uid, stepper, colorKey, codeBlock, range, chips, ask, register, esc, fmt } from './lib.js';

const P = 'v-tuth-';

const REQUEST = {
  breakAt: 520,
  wide: {
    vb: [640, 196],
    nodes: [
      { x: 10, y: 24, w: 110, h: 52, lines: ['App', 'client'] },
      { x: 200, y: 24, w: 150, h: 52, lines: ['Backend', 'your service'] },
      { x: 470, y: 24, w: 160, h: 52, kind: 'db', lines: ['DB', 'your state'] },
      { x: 200, y: 132, w: 150, h: 52, lines: ['External', 'third-party API'] },
    ],
    edges: [
      { pts: [[120, 50], [198, 50]] },
      { pts: [[350, 50], [468, 50]] },
      { pts: [[275, 76], [275, 130]] },
    ],
    marks: [
      { x: 160, y: 50, n: 1 },
      { k: 'w', x: 410, y: 50, n: 2, bad: true, label: 'write fails', lx: 410, ly: 82, anchor: 'middle' },
      { k: 'x', x: 350, y: 24, n: '✕', bad: true, label: 'dies after 2', lx: 366, ly: 16, aria: 'Backend dies after step 2' },
      { k: 'c', x: 275, y: 104, n: 3, bad: true, label: 'call fails', lx: 294, ly: 108 },
    ],
  },
  tall: {
    vb: [360, 290],
    nodes: [
      { x: 105, y: 8, w: 150, h: 46, lines: ['App', 'client'] },
      { x: 105, y: 104, w: 150, h: 50, lines: ['Backend', 'your service'] },
      { x: 8, y: 232, w: 150, h: 50, kind: 'db', lines: ['DB', 'your state'] },
      { x: 202, y: 232, w: 150, h: 50, lines: ['External', 'third-party API'] },
    ],
    edges: [
      { pts: [[180, 54], [180, 102]] },
      { pts: [[140, 154], [85, 230]] },
      { pts: [[220, 154], [275, 230]] },
    ],
    marks: [
      { x: 180, y: 79, n: 1 },
      { k: 'w', x: 112, y: 192, n: 2, bad: true, label: 'write fails', lx: 96, ly: 196, anchor: 'end' },
      { k: 'x', x: 255, y: 104, n: '✕', bad: true, label: 'dies after 2', lx: 271, ly: 108, aria: 'Backend dies after step 2' },
      { k: 'c', x: 248, y: 192, n: 3, bad: true, label: 'call fails', lx: 264, ly: 196 },
    ],
  },
};

/* What each failure leaves behind, written next to the box it describes.
   Node order in REQUEST: App, Backend, DB, External. */
const REQ_OUT = {
  w: {
    subs: [null, ['returns an error', 'bad'], ['no row, or unknown', 'bad'], ['not called', '']],
    text: 'The app can retry the whole request. If the write timed out, the backend cannot tell whether it committed, so the retry must be safe to repeat.',
  },
  x: {
    subs: [null, ['gone', 'bad'], ['order row written', 'safe'], ['never called', 'bad']],
    text: 'The database says the order exists, and nothing records that step 3 still needs to run. Nobody retries it.', bad: true,
  },
  c: {
    subs: [null, ['must retry later', 'bad'], ['order row written', 'safe'], ['call failed', 'bad']],
    text: 'The backend must remember to retry step 3, even if it restarts. That needs a durable record of the work still to do, written with step 2: an outbox row, or a workflow engine\'s state.',
  },
};


const LANES = [['worker', 'your worker'], ['fe', 'frontend'], ['hist', 'history'], ['match', 'matching'], ['pg', 'Postgres']];
const LX = { worker: 0.09, fe: 0.27, hist: 0.46, match: 0.66, pg: 0.87 };

const TABLES = [
  ['shards', 'shards'], ['cur', 'current_executions'], ['exe', 'executions'], ['hn', 'history_node'],
  ['aim', 'activity_info_maps'], ['tt', 'transfer_tasks'], ['tmr', 'timer_tasks'], ['mq', 'tasks, task_queues'],
];

const FENCE = (next) => [
  'BEGIN',
  'SELECT range_id FROM shards WHERE shard_id = «3» FOR SHARE',
  'SELECT … FROM current_executions WHERE … FOR UPDATE',
  'UPDATE current_executions SET …',
  'SELECT db_record_version, next_event_id FROM executions WHERE … FOR UPDATE',
  `UPDATE executions SET next_event_id = «${next}», data = «<blob>», …`,
];

const TRIP = [
  {
    label: 'Schedule', events: [4, 5],
    msgs: [
      { from: 'worker', to: 'hist', via: 'fe', label: 'RespondWorkflowTaskCompleted' },
      { from: 'hist', to: 'pg', db: 8, label: 'events 4–5, then tx 1' },
    ],
    call: 'Workflow code reaches <code>ExecuteActivity(ProcessPayment)</code>. The SDK sends one <code>ScheduleActivityTask</code> command. History appends two events, then runs one transaction.',
    sql: [
      'INSERT INTO history_node … node_id = «4»     // events 4–5',
      ...FENCE(6),
      'INSERT INTO activity_info_maps …             // ProcessPayment, scheduled',
      'INSERT INTO transfer_tasks …                 // ActivityTask → matching',
      'COMMIT',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 8],
    touch: { hn: 1, shards: 1, cur: 2, exe: 2, aim: 1, tt: 1 },
    note: 'Every transaction starts with the shard lock. If another History host acquired shard 3, it incremented <code>range_id</code> when it did. This check then fails, and this host stops writing.',
  },
  {
    label: 'Dispatch', events: [],
    msgs: [
      { from: 'hist', to: 'match', label: 'AddActivityTask' },
      { from: 'match', to: 'pg', db: 1, maybe: true, label: 'tasks, if no worker waits' },
    ],
    call: 'A loop in History reads <code>transfer_tasks</code> in ranges and calls Matching. If a worker is already long-polling, Matching hands the task over in memory. If not, it writes the task to <code>tasks</code> first.',
    sql: [
      '// transfer queue: one range read serves many workflows on the shard',
      'SELECT task_id, data FROM transfer_tasks',
      '  WHERE shard_id = «3» AND task_id >= $2 AND task_id < $3 ORDER BY task_id LIMIT $4',
      '// matching, only when no worker is waiting:',
      'INSERT INTO tasks …',
    ],
    hot: [4],
    touch: { mq: 1 },
    note: 'Workers never query Postgres; they long-poll Matching over gRPC. In the benchmark, <code>tasks</code> and <code>task_queues</code> average about 2 statements per activity, one per dispatch.',
  },
  {
    label: 'Start', events: [],
    msgs: [
      { from: 'match', to: 'hist', label: 'RecordActivityTaskStarted' },
      { from: 'hist', to: 'pg', db: 7, label: 'tx 2, no event' },
      { from: 'match', to: 'worker', via: 'fe', reply: true, label: 'the poll returns the task' },
    ],
    call: 'Before Matching answers the worker\'s poll, it calls History to record the start.',
    sql: [
      ...FENCE(6),
      'INSERT INTO activity_info_maps … ON CONFLICT DO UPDATE   // started, attempt 1',
      'INSERT INTO timer_tasks …                                // StartToClose, 30 s',
      'COMMIT',
    ],
    hot: [1, 2, 3, 4, 5, 6, 7],
    touch: { shards: 1, cur: 2, exe: 2, aim: 1, tmr: 1 },
    note: 'No history event yet. The activity has a retry policy (the server adds a default one), so History keeps <b>ActivityTaskStarted</b> in the <code>executions</code> blob and writes it when the activity closes. A retry adds no events.',
  },
  {
    label: 'Complete', events: [6, 7, 8],
    msgs: [
      { from: 'worker', to: 'hist', via: 'fe', label: 'RespondActivityTaskCompleted' },
      { from: 'hist', to: 'pg', db: 9, label: 'events 6–8, then tx 3' },
    ],
    call: 'The worker runs <code>ProcessPayment</code> and reports the result. History appends three events and schedules a workflow task, so the workflow code can continue.',
    sql: [
      'INSERT INTO history_node … node_id = «6»     // events 6–8',
      ...FENCE(9),
      'DELETE FROM activity_info_maps …             // activity closed',
      'INSERT INTO transfer_tasks …                 // WorkflowTask → matching',
      'INSERT INTO timer_tasks …                    // sticky ScheduleToStart, 5 s',
      'COMMIT',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 8, 9],
    touch: { hn: 1, shards: 1, cur: 2, exe: 2, aim: 1, tt: 1, tmr: 1 },
    note: 'The workflow task goes to this worker\'s <b>sticky queue</b>, because the worker still has the workflow in memory. The 5 s timer moves it to the normal queue if that worker does not pick it up.',
  },
  {
    label: 'Wake', events: [9],
    msgs: [
      { from: 'hist', to: 'match', label: 'AddWorkflowTask' },
      { from: 'match', to: 'hist', label: 'RecordWorkflowTaskStarted' },
      { from: 'hist', to: 'pg', db: 8, label: 'event 9, tx 4, read 4–9' },
      { from: 'match', to: 'pg', db: 1, maybe: true, label: 'tasks, if no worker waits' },
      { from: 'match', to: 'worker', via: 'fe', reply: true, label: 'events 4–9' },
    ],
    call: 'The transfer queue sends the workflow task to Matching, and the worker\'s poll picks it up. History records the start and reads the new events for the worker.',
    sql: [
      'INSERT INTO history_node … node_id = «9»     // event 9',
      ...FENCE(10),
      'INSERT INTO timer_tasks …                    // workflow task StartToClose, 10 s',
      'COMMIT',
      'SELECT … FROM history_node WHERE … node_id >= «4»   // events 4–9 for the worker',
      '// matching, only when no worker is waiting: INSERT INTO tasks …',
    ],
    hot: [0, 2, 3, 4, 5, 6, 7, 9, 10],
    touch: { hn: 2, shards: 1, cur: 2, exe: 2, tmr: 1, mq: 1 },
    note: 'The worker is sticky, so History sends only the events after the last workflow task it started (event 3): events 4–9. A worker without the workflow in memory gets the full history and replays it.',
  },
  {
    label: 'Resume', events: [],
    msgs: [{ from: 'worker', to: 'worker', self: true, label: 'code continues to ReserveInventory' }],
    call: 'The SDK applies events 4–9 to the workflow in memory. <code>.Get()</code> returns the result stored in event 7, and the code runs until the next <code>ExecuteActivity</code>. That starts step 1 again, with events 10–11.',
    sql: null, touch: {}, note: '',
  },
];

/* Measured per-activity deltas (the post's N=1 vs N=5 table), by table. */
const TRIP_MEASURED = { shards: '4', cur: '8', exe: '8', hn: '4', aim: '3', tt: '2', tmr: '3', mq: '2.1' };


const T_CODE = {
  det: [['sig', 'func Order(ctx workflow.Context) error {'], ['p', '    exec(ctx, ProcessPayment)'], ['i', '    exec(ctx, ReserveInventory)'],
    ['n', '    exec(ctx, SendNotification)'], ['ret', '    return nil'], ['end', '}']],
  clock: [['sig', 'func Order(ctx workflow.Context) error {'], ['p', '    exec(ctx, ProcessPayment)'], ['i', '    exec(ctx, ReserveInventory)'],
    ['if', '    if time.Now().Hour() < 12 {'], ['n', '        exec(ctx, SendNotification)'], ['else', '    } else {'],
    ['e', '        exec(ctx, SendEmail)'], ['fi', '    }'], ['ret', '    return nil'], ['end', '}']],
};
const A_CODE = {
  det: [['sig', 'func order(t *Task) error {'], ['p', '    step(t, "process-payment", pay)'], ['i', '    step(t, "reserve-inventory", reserve)'],
    ['n', '    step(t, "send-notification", notify)'], ['ret', '    return nil'], ['end', '}']],
  clock: [['sig', 'func order(t *Task) error {'], ['p', '    step(t, "process-payment", pay)'], ['i', '    step(t, "reserve-inventory", reserve)'],
    ['if', '    if time.Now().Hour() < 12 {'], ['n', '        step(t, "send-notification", notify)'], ['else', '    } else {'],
    ['e', '        step(t, "send-email", email)'], ['fi', '    }'], ['ret', '    return nil'], ['end', '}']],
};


const T_BASE = [['ev', '1–16', 'earlier events'], ['ev', '17', 'ActivityTaskScheduled · SendNotification']];
const A_BASE = [['ev', 'c_', 'process-payment'], ['ev', 'c_', 'reserve-inventory']];

const CR_STOPS = [
  { label: 'Run', t: '11:59:40' }, { label: 'Crash', t: '11:59:41', bad: true }, { label: 'Timeout', t: '12:00:10' },
  { label: 'Retry', t: '12:00:11' }, { label: 'Sticky', t: '12:00:16' }, { label: 'Replay', t: '12:00:16' }, { label: 'Result', t: '' },
];

/* One state per stop for each system. rows: [kind, id, text]; kind is
   ev (stored before), new (written now), task (pending timer or lease), bad. */
function crState(i, v) {
  const clock = v === 'clock';
  const first = clock ? { if: '11:59 → true' } : {};
  const T = { code: T_CODE[v], ann: first, hot: [], rows: [...T_BASE], tone: '', status: '' };
  const A = { code: A_CODE[v], ann: first, hot: [], rows: [...A_BASE], tone: '', status: '' };
  const tRetry = [['ev', '17', 'ActivityTaskScheduled · SendNotification'], ['ev', '18', 'ActivityTaskStarted · attempt 2'], ['ev', '19', 'ActivityTaskCompleted'], ['ev', '20', 'WorkflowTaskScheduled · sticky queue of A']];
  const tSticky = [['ev', '21', 'WorkflowTaskTimedOut · ScheduleToStart'], ['ev', '22', 'WorkflowTaskScheduled · normal queue']];
  const aDone = clock
    ? [['ev', 'c_', 'send-email'], ['bad', 'r_', 'run 1 · attempt 1 · failed'], ['ev', 'r_', 'run 2 · attempt 2 · completed']]
    : [['ev', 'c_', 'send-notification'], ['bad', 'r_', 'run 1 · attempt 1 · failed'], ['ev', 'r_', 'run 2 · attempt 2 · completed']];
  const aAnn = clock
    ? { p: 'checkpoint', i: 'checkpoint', if: '⟦12:00 → false⟧', e: '⟦runs⟧' }
    : { p: 'checkpoint', i: 'checkpoint', n: 'runs again' };
  const aDoneNote = clock
    ? 'Done at 12:00:11. Attempt 1 may already have sent the notification, and attempt 2 sent an email.'
    : 'Done at 12:00:11.';
  const doneA = () => { A.status = 'completed'; A.rows.push(...aDone); A.note = aDoneNote; A.tone = clock ? 'bad' : ''; A.ann = aAnn; };

  switch (i) {
    case 0:
      T.hot = ['n']; T.status = 'worker A';
      T.rows.push(['task', 'timer', 'StartToClose · due 12:00:10']);
      T.note = 'Worker A runs <code>SendNotification</code>, attempt 1. History recorded the start in the <code>executions</code> blob. <b>ActivityTaskStarted</b> is written when the activity closes.';
      A.hot = ['n']; A.status = 'worker A';
      A.rows.push(['task', 'r_', 'run 1 · attempt 1 · running · lease until 12:00:10']);
      A.note = 'Worker A runs <code>send-notification</code>. The <code>reserve-inventory</code> checkpoint also extended the lease by 30 s.';
      break;
    case 1:
      T.status = 'down'; T.tone = 'bad';
      T.rows.push(['task', 'timer', 'StartToClose · due 12:00:10']);
      T.note = 'Worker A is killed partway through <code>SendNotification</code>. Nothing reaches Temporal. The copy of the workflow in worker A\'s memory is gone.';
      A.status = 'down'; A.tone = 'bad';
      A.rows.push(['task', 'r_', 'run 1 · attempt 1 · running · lease until 12:00:10']);
      A.note = 'Worker A is killed partway through <code>notify</code>. The run row still says running, with a lease until 12:00:10.';
      break;
    case 2:
      T.status = 'waiting';
      T.rows.push(['new', 'timer', 'fired · attempt 2 due 12:00:11 (1 s backoff)']);
      T.note = 'The StartToClose timer fires. History moves the activity to attempt 2 in the <code>executions</code> blob and sets a retry timer. The default retry policy waits 1 s. No history event is written.';
      A.status = 'worker B';
      A.rows.push(['bad', 'r_', 'run 1 · attempt 1 · failed · $ClaimTimeout'], ['new', 'r_', 'run 2 · attempt 2 · running · worker B']);
      A.note = 'Worker B calls <code>claim_task</code>. It sweeps the expired lease: <code>fail_run</code> marks run 1 failed and inserts run 2. The same call then claims run 2 with <code>FOR UPDATE SKIP LOCKED</code>.';
      break;
    case 3:
      T.status = 'worker B';
      T.rows = [T_BASE[0], ...tRetry.map((r, k) => (k ? ['new', r[1], r[2]] : r)), ['task', 'timer', 'sticky ScheduleToStart · due 12:00:16']];
      T.note = 'Worker B runs <code>SendNotification</code> again. Only the activity runs; no workflow code runs. When it completes, History writes events 18–20 and sends the workflow task to worker A\'s sticky queue.';
      A.status = 'completed'; A.tone = clock ? 'bad' : '';
      A.ann = aAnn;
      A.hot = clock ? ['p', 'i', 'if', 'e'] : ['p', 'i', 'n'];
      A.rows.push(...aDone.map((r, k) => (k === 0 || k === 2 ? ['new', r[1], r[2]] : r)));
      A.note = clock
        ? 'Worker B runs <code>order()</code> from the first line. The first two steps return their checkpoints. The clock now says 12:00, so the code takes the other branch and runs <code>send-email</code>, which has no checkpoint. <b class="c-bad">The customer may get a notification and an email.</b>'
        : 'Worker B runs <code>order()</code> from the first line. <code>step()</code> reads each checkpoint first. The first two return their stored results. <code>send-notification</code> has none, so its body runs again, and the result is saved. Then <code>complete_run</code> finishes the task.';
      break;
    case 4:
      T.status = 'waiting';
      T.rows = [T_BASE[0], ...tRetry, ...tSticky.map((r) => ['new', r[1], r[2]])];
      T.note = 'Nobody polls worker A\'s sticky queue. After 5 s (the SDK\'s <code>StickyScheduleToStartTimeout</code>), History writes events 21–22 and moves the workflow task to the normal queue.';
      doneA();
      break;
    case 5:
      T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['new', '23', 'WorkflowTaskStarted · worker B']];
      if (clock) {
        T.status = 'blocked'; T.tone = 'bad';
        T.ann = { p: 'events 5, 7', i: 'events 11, 13', if: '⟦12:00 → false⟧', e: '⟦event 17 differs⟧' };
        T.hot = ['p', 'i', 'if', 'e'];
        T.rows.push(['bad', '24', 'WorkflowTaskFailed · nondeterminism']);
        T.note = 'Worker B has no copy in memory, so it gets events 1–23 and runs <code>Order()</code> from the first line. At the <code>if</code>, the clock says 12:00, so the code asks for <code>SendEmail</code>. Event 17 says <code>SendNotification</code>. The SDK stops with <code>[TMPRL1100] nondeterministic workflow</code>. Temporal retries the workflow task, and the workflow stays open until you deploy a fix: <code>workflow.Now(ctx)</code> instead of <code>time.Now()</code>.';
      } else {
        T.status = 'completed';
        T.ann = { p: 'events 5, 7', i: 'events 11, 13', n: 'events 17, 19' };
        T.hot = ['p', 'i', 'n', 'ret'];
        T.rows.push(['new', '24', 'WorkflowTaskCompleted'], ['new', '25', 'WorkflowExecutionCompleted']);
        T.note = 'Worker B has no copy in memory, so it gets events 1–23 and runs <code>Order()</code> from the first line. Each <code>exec()</code> matches its recorded events and returns the stored result. No activity runs again. The code returns, and History writes events 24–25.';
      }
      doneA();
      break;
    default:
      doneA();
      if (clock) {
        T.status = 'blocked'; T.tone = 'bad';
        T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['ev', '23', 'WorkflowTaskStarted'], ['bad', '24', 'WorkflowTaskFailed · nondeterminism']];
        T.note = '<b>Stopped at the change.</b> <code>SendNotification</code> started twice. <code>SendEmail</code> never ran. The workflow waits for a code fix.';
        A.tone = 'bad';
        A.note = '<b>Ran both branches.</b> <code>notify</code> started once and may have finished, and <code>email</code> ran once. Nothing checked the code between steps.';
      } else {
        T.status = 'completed';
        T.rows = [T_BASE[0], ...tRetry, ...tSticky, ['ev', '23–25', 'workflow task · ExecutionCompleted']];
        T.note = '<b>Started twice:</b> <code>SendNotification</code>, and the code in <code>Order()</code>. <b>Ran once:</b> <code>ProcessPayment</code>, <code>ReserveInventory</code>.';
        A.note = '<b>Started twice:</b> <code>notify</code>, and the code in <code>order()</code>. <b>Ran once:</b> <code>pay</code>, <code>reserve</code>.';
      }
  }
  return { T, A };
}

/* Predict, then see: in the clock variant the reader answers before the
   surprising stop is revealed. */
const PREDICT = {
  A: {
    at: 3, from: 2,
    q: 'Worker B runs <code>order()</code> again at 12:00:11. Which step body runs?',
    choices: [['send-notification', false], ['send-email', true], ['none: Absurd stops with an error', false]],
  },
  T: {
    at: 5, from: 4,
    q: 'Worker B replays <code>Order()</code> at 12:00:16, so the <code>if</code> takes the other branch. What happens?',
    choices: [['it runs SendEmail', false], ['it reuses the result in event 19', false], ['it stops with an error', true]],
  },
};


const MEASURED = { T: [[1, 75.7], [3, 144.8], [5, 214.0], [10, 385.2]], A: [[1, 17.7], [3, 32.0], [5, 46.1], [10, 81.2]] };
const MODEL = { T: (n) => 40 + 35 * n, A: (n) => 11 + 7 * n };
const RATES = [1, 10, 50, 100, 250, 500, 1000, 2500, 5000];
const NMAX = 30; const YMAX = 1100;


/* ================================================================ shared */

/* The stepper handles ← →; keep them from reaching the page's post navigation. */
function keepArrows(fig) {
  fig.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation(); });
}

/** Tally marks in groups of five; the last `mine` are this step's. */
function tallyHTML(n, mine = 0, approx = false) {
  let out = approx ? '<span class="c-data">≈</span>' : '';
  for (let k = 0; k < n; k++) {
    if (k && k % 5 === 0) out += '<span class="gap"></span>';
    out += `<span class="st${k >= n - mine ? ' is-new' : ''}"></span>`;
  }
  return `<span class="${P}tally">${out}</span>`;
}

function marker(id, color) {
  return s('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L8,4 L0,8 z', style: `fill:${color}` }));
}

const TONE = {
  bad: 'fill:var(--red-l);stroke:var(--red);stroke-width:2',
  safe: 'fill:var(--green-l);stroke:var(--green);stroke-width:2',
};

/*
 * A diagram spec has a wide and a tall layout. nodes: {x,y,w,h,kind,lines,tone};
 * kind 'db' draws a dashed box (data at rest). marks with k are clickable.
 */
function drawDiagram(L, label) {
  const [W, H] = L.vb;
  const id = uid('tuth');
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  svg.append(s('defs', null, marker(id, 'var(--ink)')));
  for (const e of L.edges) {
    svg.append(s('path', { d: `M${e.pts.map((q) => q.join(',')).join(' L')}`, class: 'edge', 'marker-end': e.noArrow ? null : `url(#${id})` }));
    if (e.label) svg.append(s('text', { x: e.lx, y: e.ly, class: 't-xs t-mute', 'text-anchor': e.anchor || 'start' }, e.label));
  }
  for (const n of L.nodes) {
    const g = s('g', { class: 'node' });
    g.append(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, class: n.kind === 'db' ? 'box dash' : 'box', style: n.tone ? TONE[n.tone] : null }));
    const total = 15 + (n.lines.length - 1) * 13;
    let y = n.y + n.h / 2 - total / 2 + 11;
    n.lines.forEach((t, k) => {
      const cls = !k ? 't-m t-b' : n.tone === 'bad' ? 't-xs t-b t-bad' : n.tone === 'safe' ? 't-xs t-b t-safe' : 't-xs t-mute';
      g.append(s('text', { x: n.x + n.w / 2, y, class: cls, 'text-anchor': 'middle' }, t));
      y += k ? 13 : 15;
    });
    svg.append(g);
  }
  for (const m of L.marks || []) {
    const g = s('g', m.k
      ? { class: `mark${m.on ? ' is-on' : ''}`, role: 'button', tabindex: 0, 'data-k': m.k, 'aria-label': m.aria || m.label }
      : { class: 'mark', style: 'cursor:default' });
    if (m.k) g.append(s('circle', { cx: m.x, cy: m.y, r: 18, class: `${P}hit` }));
    g.append(s('circle', { cx: m.x, cy: m.y, r: m.k ? 11 : 9, style: m.bad ? null : 'fill:var(--ink)' }));
    g.append(s('text', { x: m.x, y: m.y + 3.6, 'text-anchor': 'middle' }, String(m.n)));
    svg.append(g);
    if (m.label) svg.append(s('text', { x: m.lx, y: m.ly, class: `t-s t-b halo ${m.bad ? 't-bad' : 't-mute'}`, 'text-anchor': m.anchor || 'start' }, m.label));
  }
  return svg;
}

function initRequest(fig, app) {
  let sel = null;
  const stage = h('div');
  const out = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  function draw() {
    const base = app.clientWidth < REQUEST.breakAt ? REQUEST.tall : REQUEST.wide;
    const L = {
      ...base,
      nodes: base.nodes.map((n, k) => {
        const o = sel && REQ_OUT[sel].subs[k];
        return o ? { ...n, lines: [n.lines[0], o[0]], tone: o[1] || undefined } : n;
      }),
      marks: base.marks.map((m) => ({ ...m, on: m.k && m.k === sel })),
    };
    stage.replaceChildren(drawDiagram(L, fig.getAttribute('aria-label') || ''));
    stage.querySelectorAll('[data-k]').forEach((g) => {
      const pick = () => { sel = g.dataset.k; draw(); stage.querySelector(`[data-k="${sel}"]`)?.focus(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { pick(); e.preventDefault(); } });
    });
    out.className = `wv-note${sel && REQ_OUT[sel].bad ? ' is-bad' : ''}`;
    out.innerHTML = sel ? REQ_OUT[sel].text : '<span class="k">Try it</span>Tap a red mark. Each box then shows what that failure leaves behind.';
  }
  let wasTall = null;
  new ResizeObserver(() => { const tall = app.clientWidth < REQUEST.breakAt; if (tall !== wasTall) { wasTall = tall; draw(); } }).observe(app);
  app.append(stage, colorKey([['k-ink', 'solid box: process · dashed: data at rest'], ['k-gap', 'failure, or work lost'], ['k-held', 'durable']]),
    h('div', { style: 'height:.6rem' }), out);
  draw();
}

/* ===================================================== ONE ACTIVITY TRIP */

function initTrip(fig, app) {
  let cur = 0; let W = 0; let guess = 0;
  const q = ask('Guess first. How many SQL statements does one activity cost?',
    [[5, '≈ 5'], [15, '≈ 15'], [35, '≈ 35'], [80, '≈ 80']], 35,
    (v, right) => { guess = v; paint(); return right ? 'Close. Step through to see where the ≈ 34 come from.' : `The source says ≈ 34. Step through to see where they come from.`; });
  const stat = h('div', { class: 'wv-stats', 'aria-live': 'polite' });
  const lanesHead = h('div', { class: `${P}lanes` });
  const seq = h('div');
  const detail = h('div', { class: `wv-card ${P}detail` });
  const bands = TRIP.map((st, k) => {
    const b = h('div', { class: `${P}band`, role: 'button', tabindex: 0, 'aria-label': `Step ${k + 1}: ${st.label}` });
    b.addEventListener('click', () => { nav.stop(); nav.go(k); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { nav.go(k); e.preventDefault(); } });
    seq.append(b);
    return b;
  });
  const nav = stepper(fig, TRIP, (i) => { cur = i; paint(); }, { interval: 4200 });
  keepArrows(fig);
  app.append(q.el, nav.el, stat, h('div', { style: 'height:.6rem' }), lanesHead, seq,
    colorKey([['k-look', 'this step'], ['k-data', 'SQL statements, one tally mark each']]));

  const totals = (upTo) => {
    const t = {};
    for (let k = 0; k <= upTo; k++) for (const [id, n] of Object.entries(TRIP[k].touch)) t[id] = (t[id] || 0) + n;
    return t;
  };

  function drawLanes() {
    const svg = s('svg', { viewBox: `0 0 ${W} 30`, 'aria-hidden': 'true' });
    for (const [id, name] of LANES) {
      const x = LX[id] * W; const w = Math.min(W * 0.18, 118);
      svg.append(s('rect', { x: x - w / 2, y: 2, width: w, height: 24, class: id === 'pg' ? 'box dash' : 'box' }));
      svg.append(s('text', { x, y: 18, class: 't-s t-b', 'text-anchor': 'middle' }, W < 480 && id === 'worker' ? 'worker' : name));
    }
    lanesHead.replaceChildren(svg);
  }

  function drawBand(k) {
    const st = TRIP[k];
    const rowH = 34; const top = 22;
    const H = top + st.msgs.length * rowH + 4;
    const id = uid('tuth');
    const on = k === cur;
    const ink = on ? 'var(--purple)' : 'var(--ink)';
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    svg.append(s('defs', null, marker(id, ink)));
    for (const [lid] of LANES) svg.append(s('line', { x1: LX[lid] * W, x2: LX[lid] * W, y1: 0, y2: H, class: 'rule dash' }));
    svg.append(s('text', { x: 4, y: 14, class: `t-xs t-b t-up${on ? ' t-look' : ''}` }, `${String(k + 1).padStart(2, '0')} ${st.label}`));
    st.msgs.forEach((m, r) => {
      const y = top + r * rowH + 18;
      const x1 = LX[m.from] * W; const x2 = LX[m.to] * W;
      const line = `fill:none;stroke:${ink};stroke-width:${on ? 2.4 : 1.6}`;
      if (m.self) {
        svg.append(s('path', { d: `M${x1},${y - 8} h26 v12 h-22`, style: line, 'marker-end': `url(#${id})` }));
        svg.append(s('text', { x: x1 + 32, y, class: `t-xs${on ? ' t-b' : ''}` }, m.label));
        return;
      }
      const dir = Math.sign(x2 - x1);
      svg.append(s('path', { d: `M${x1},${y} L${x2 - dir * 3},${y}`, style: line, class: m.reply || m.maybe ? 'dash' : null, 'marker-end': `url(#${id})` }));
      if (m.via) svg.append(s('circle', { cx: LX[m.via] * W, cy: y, r: 3, style: `fill:var(--board);stroke:${ink};stroke-width:1.4` }));
      const mid = (x1 + x2) / 2;
      svg.append(s('text', { x: m.db ? Math.min(mid, W - 8) : mid, y: y - 6, class: `t-xs halo${on ? ' t-b' : ''}`, 'text-anchor': m.db && mid + 60 > W ? 'end' : 'middle' }, m.label));
      if (m.db) {
        const n = m.db; const sp = 3.6; const gap = 4;
        const width = n * sp + Math.floor((n - 1) / 5) * gap;
        let x = x2 - width - 6;
        for (let j = 0; j < n; j++) {
          if (j && j % 5 === 0) x += gap;
          svg.append(s('line', { x1: x, x2: x, y1: y + 4, y2: y + 14, style: 'stroke:var(--brown);stroke-width:1.8', class: m.maybe ? 'dash' : null }));
          x += sp;
        }
        svg.append(s('text', { x: x2 - width - 10, y: y + 14, class: 't-xs t-b t-data', 'text-anchor': 'end' }, `${m.maybe ? '≈' : ''}${n} SQL`));
      }
    });
    return svg;
  }

  function detailHTML(i) {
    const st = TRIP[i];
    const tot = totals(i);
    const last = i === TRIP.length - 1;
    const rows = TABLES.map(([id, name]) => {
      const n = tot[id] || 0; const add = st.touch[id] || 0;
      return `<tr${add ? ' class="is-look"' : ''}><td>${name}</td><td>${tallyHTML(n, add, id === 'mq' && n > 0)}</td><td class="c-data">${id === 'mq' && n ? '≈ ' : ''}${n}</td>${last ? `<td class="c-data">${TRIP_MEASURED[id]}</td>` : ''}</tr>`;
    }).join('') + (last ? '<tr><td><b>total</b></td><td></td><td class="c-data"><b>≈ 34</b></td><td class="c-data"><b>≈ 34</b></td></tr>' : '');
    const table = `<div class="wv-scroll"><table class="wv-table"><thead><tr><th>table</th><th>this activity</th><th>${last ? 'source' : ''}</th>${last ? '<th>measured</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
    const body = st.sql
      ? codeBlock(st.sql, st.hot)
      : codeBlock([
        'workflow.ExecuteActivity(ctx, ProcessPayment, params).Get(ctx, &p)  // «result from event 7»',
        'workflow.ExecuteActivity(ctx, ReserveInventory, params).Get(ctx, &i) // step 1 again',
      ], [0, 1]);
    const guessLine = last && guess
      ? `<div class="wv-note">You guessed <b>≈ ${guess}</b>. One activity costs <b>≈ 34</b> statements: four transactions, and each starts with the same five fencing statements.</div>`
      : '';
    return `<p>${st.call}</p>${guessLine}<div class="${P}split"><div>${body}</div>${table}</div>${st.note ? `<div class="wv-note">${st.note}</div>` : ''}`;
  }

  function paint() {
    bands.forEach((b, k) => {
      b.classList.toggle('is-on', k === cur);
      b.classList.toggle('is-future', k > cur);
      if (W) b.replaceChildren(drawBand(k));
    });
    detail.innerHTML = detailHTML(cur);
    bands[cur].after(detail);
    const sum = Object.values(totals(cur)).reduce((a, b) => a + b, 0);
    stat.innerHTML = `<div class="wv-stat"><span class="k">SQL so far, this activity</span><span class="v c-data">${cur >= 1 ? '≈ ' : ''}${sum}</span></div>`;
  }

  function resize() {
    const w = Math.round(seq.clientWidth);
    if (!w || w === W) return;
    W = w;
    drawLanes();
    paint();
  }
  new ResizeObserver(resize).observe(seq);
  nav.go(0);
  resize();
}

/* ========================================================= CRASH REPLAY */

/* Annotations go after the line, or on their own line when the card is narrow. */
function annotated(src, ann = {}, hot = [], narrow = false) {
  const lines = []; const idx = [];
  for (const [k, t] of src) {
    const on = hot.includes(k);
    if (on) idx.push(lines.length);
    if (ann[k] && narrow) {
      lines.push(t);
      if (on) idx.push(lines.length);
      lines.push(`${t.match(/^ */)[0]}  // ${ann[k]}`);
    } else lines.push(ann[k] ? `${t}  // ${ann[k]}` : t);
  }
  return codeBlock(lines, idx);
}

function initCrash(fig, app) {
  let v = 'det'; let i = 0;
  const answer = { T: null, A: null };
  const opt = chips([['det', 'deterministic'], ['clock', 'reads time.Now()']], (x) => { v = x; show(); }, { value: v, label: 'Code between steps' });
  const banner = h('div', { class: 'wv-note', 'aria-live': 'polite' });
  const card = (name) => {
    const el = h('div', { class: 'wv-card' });
    const tag = h('span', { class: 'wv-tag' });
    const codeEl = h('div');
    const rows = h('div', { class: 'wv-scroll' });
    const note = h('div');
    el.append(h('h5', { class: `${P}card-h` }, h('span', null, name), tag), codeEl, rows, note);
    return { el, tag, codeEl, rows, note };
  };
  const CT = card('Temporal · history_node, timer_tasks'); const CA = card('Absurd · c_default, r_default');
  const cols = h('div', { class: `wv-cards ${P}cols` }, CT.el, CA.el);
  const nav = stepper(fig, CR_STOPS, (k) => { i = k; show(); }, { interval: 5200 });
  keepArrows(fig);
  app.append(h('div', { class: 'wv-field' }, h('label', null, 'Code between steps'), opt.el), nav.el, banner, h('div', { style: 'height:.6rem' }), cols,
    colorKey([['k-look', 'this moment: code that runs, rows written'], ['k-gap', 'failure, or work done twice']]));

  function paint(C, st) {
    C.tag.textContent = st.status;
    C.tag.className = `wv-tag${st.status === 'down' || st.status === 'blocked' ? ' c-bad' : ''}`;
    C.el.className = `wv-card${st.status === 'down' ? ' is-bad' : ''}`;
    C.codeEl.innerHTML = annotated(st.code, st.ann, st.hot, C.el.clientWidth < 440);
    C.rows.innerHTML = `<table class="wv-table"><tbody>${st.rows.map(([k, id, t]) => `<tr${k === 'new' ? ' class="is-look"' : ''}><td class="${k === 'bad' ? 'c-bad' : 't-b'}">${esc(id)}</td><td${k === 'bad' ? ' class="c-bad"' : ''}>${k === 'task' ? 'pending · ' : ''}${esc(t)}</td></tr>`).join('')}</tbody></table>`;
    C.note.className = `wv-note${st.tone === 'bad' ? ' is-bad' : ''}`;
    C.note.innerHTML = st.note;
  }
  const gate = (sys) => v === 'clock' && i === PREDICT[sys].at && answer[sys] === null;
  function askIn(C, sys) {
    const pr = PREDICT[sys];
    const correct = pr.choices.findIndex(([, ok]) => ok);
    const qq = ask(pr.q.replace(/<\/?code>/g, ''), pr.choices.map(([label], k) => [k, label]), correct,
      (k) => { answer[sys] = k; setTimeout(show, 900); return pr.choices[k][1] ? 'Right. Showing what happens…' : 'Not quite. Showing what happens…'; });
    C.note.className = '';
    C.note.replaceChildren(qq.el);
  }
  function show() {
    const st = crState(i, v);
    const T = gate('T') ? crState(PREDICT.T.from, v).T : st.T;
    const A = gate('A') ? crState(PREDICT.A.from, v).A : st.A;
    const cs = CR_STOPS[i];
    banner.className = 'wv-note';
    banner.innerHTML = cs.t
      ? `<span class="k">${cs.t}</span>sample time`
      : '<span class="k">Result</span>Both systems start the interrupted step twice, so step bodies must be idempotent. They differ on the code between steps: Temporal runs it again and checks it against history; Absurd runs it again and does not check it.';
    paint(CT, T); paint(CA, A);
    for (const [sys, C] of [['T', CT], ['A', CA]]) {
      if (v !== 'clock' || i !== PREDICT[sys].at) continue;
      if (gate(sys)) askIn(C, sys);
      else {
        const k = answer[sys]; const ok = PREDICT[sys].choices[k][1];
        C.note.insertAdjacentHTML('afterbegin', `<b>You said: ${esc(PREDICT[sys].choices[k][0])}. ${ok ? 'Right.' : 'Not quite.'}</b> `);
      }
    }
  }
  let wasNarrow = null;
  new ResizeObserver(() => { const n = CT.el.clientWidth < 440; if (n !== wasNarrow) { wasNarrow = n; show(); } }).observe(cols);
  nav.go(0);
}

/* =========================================================== COST MODEL */

function initCost(fig, app) {
  const S = { n: 20, r: 6 };
  const svg = s('svg', { role: 'img', 'aria-label': 'SQL statements per workflow against the number of activities' });
  const stats = h('div', { class: 'wv-stats', 'aria-live': 'polite' });
  const note = h('div', { class: 'wv-note' });
  const rn = range('activities per workflow, N', { min: 1, max: NMAX, value: S.n, oninput: (x) => { S.n = x; draw(); } });
  const rr = range('your units per second', { min: 0, max: RATES.length - 1, value: S.r, fmt: (x) => `${fmt(RATES[x])}/s`, oninput: (x) => { S.r = x; draw(); } });
  app.append(h('div', { class: 'wv-grid-ctrl' }, rn.el, rr.el), stats, h('div', { style: 'height:.6rem' }), svg,
    colorKey([['k-data', 'measured runs'], ['k-line-ink', 'fitted line'], ['k-look', 'your N']]),
    h('div', { style: 'height:.6rem' }), note);

  function draw() {
    const Wd = Math.max(300, app.clientWidth);
    const Ht = Wd < 500 ? 280 : 320;
    const m = { l: 46, r: 16, t: 20, b: 36 };
    const x = (n) => m.l + (n / NMAX) * (Wd - m.l - m.r);
    const y = (q) => Ht - m.b - (q / YMAX) * (Ht - m.t - m.b);
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
    let o = `<rect x="${x(10)}" y="${m.t}" width="${x(NMAX) - x(10)}" height="${Ht - m.t - m.b}" style="fill:var(--tint)"/>`;
    o += `<text x="${x(NMAX) - 6}" y="${Ht - m.b - 8}" class="t-xs t-mute" text-anchor="end">not measured past N = 10</text>`;
    for (let q = 0; q <= YMAX; q += 200) {
      o += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(q)}" y2="${y(q)}" class="rule" style="opacity:.5"/>`;
      o += `<text x="${m.l - 6}" y="${y(q) + 3.5}" class="t-xs t-mute" text-anchor="end">${q}</text>`;
    }
    for (let n = 0; n <= NMAX; n += 5) o += `<text x="${x(n)}" y="${Ht - m.b + 15}" class="t-xs t-mute" text-anchor="middle">${n}</text>`;
    o += `<text x="${Wd - m.r}" y="${Ht - 4}" class="t-xs t-mute" text-anchor="end">activities or steps per unit, N →</text>`;
    o += `<text x="${m.l}" y="${m.t - 7}" class="t-xs t-mute">↑ SQL statements per unit</text>`;
    o += `<rect x="${m.l}" y="${m.t}" width="${Wd - m.l - m.r}" height="${Ht - m.t - m.b}" class="rule-ink"/>`;
    o += `<path d="M${x(0)},${y(MODEL.T(0))} L${x(NMAX)},${y(MODEL.T(NMAX))}" style="fill:none;stroke:var(--ink);stroke-width:2"/>`;
    o += `<path d="M${x(0)},${y(MODEL.A(0))} L${x(NMAX)},${y(MODEL.A(NMAX))}" style="fill:none;stroke:var(--ink);stroke-width:2;stroke-dasharray:7 4"/>`;
    const tn = Wd < 500 ? 13 : 17;
    o += `<text x="${x(tn) + 8}" y="${y(MODEL.T(tn)) + 18}" class="t-s t-b halo">Temporal 40 + 35·N</text>`;
    o += `<text x="${x(NMAX) - 6}" y="${y(MODEL.A(NMAX - 2)) - 12}" class="t-s t-b halo" text-anchor="end">Absurd 11 + 7·N</text>`;
    o += `<text x="${x(10) - 9}" y="${y(385.2) - 6}" class="t-xs t-b t-data halo" text-anchor="end">measured</text>`;
    for (const [n, q] of [...MEASURED.T, ...MEASURED.A]) o += `<circle cx="${x(n)}" cy="${y(q)}" r="4.5" style="fill:var(--brown-l);stroke:var(--brown);stroke-width:1.8"/>`;
    const cx = x(S.n);
    o += `<line x1="${cx}" x2="${cx}" y1="${m.t}" y2="${Ht - m.b}" style="stroke:var(--purple);stroke-width:1.5"/>`;
    const left = S.n > NMAX * 0.7;
    for (const [f, dy] of [[MODEL.T, -7], [MODEL.A, 17]]) {
      o += `<circle cx="${cx}" cy="${y(f(S.n))}" r="5" style="fill:var(--purple);stroke:var(--board);stroke-width:2"/>`;
      o += `<text x="${cx + (left ? -9 : 9)}" y="${y(f(S.n)) + dy}" class="t-s t-b t-look halo" text-anchor="${left ? 'end' : 'start'}">${fmt(f(S.n))}</text>`;
    }
    svg.innerHTML = o;

    const R = RATES[S.r]; const t = MODEL.T(S.n); const a = MODEL.A(S.n);
    const mt = MEASURED.T.find(([n]) => n === S.n); const ma = MEASURED.A.find(([n]) => n === S.n);
    const stat = (k, v, cls = 'c-data') => `<div class="wv-stat"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
    stats.innerHTML = stat('Temporal, your Postgres', `${fmt(t * R)}/s`) + stat('Absurd, your Postgres', `${fmt(a * R)}/s`);
    const meas = mt ? ` Measured at N = ${S.n}: ${mt[1]} and ${ma[1]}.` : '';
    note.innerHTML = `40 + 35 × ${S.n} = ${fmt(t)} and 11 + 7 × ${S.n} = ${fmt(a)} statements per unit, so Temporal runs <b>${(t / a).toFixed(1)}×</b> as many.${meas} The ratio tends to 35 / 7 = 5 as N grows. These are statement counts. They do not include the time each statement takes.`;
  }
  new ResizeObserver(() => draw()).observe(app);
  draw();
}

register({
  'tuth-request': initRequest,
  'tuth-trip': initTrip,
  'tuth-crash': initCrash,
  'tuth-cost': initCost,
});

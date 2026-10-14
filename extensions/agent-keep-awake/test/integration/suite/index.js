// @ts-check
'use strict';

/**
 * Native acceptance tests for the delivered primary controls: Off, Keep awake (Manual) and the
 * selectable-but-Unavailable Auto mode.
 *
 * They run inside a real, isolated VS Code extension host (see ../runTest.js) against the real
 * operating system and use only what a person has: the contributed commands (selectMode, keepAwake,
 * autoMode, turnOff, plus the timed toggleSession and stopSession aliases), the exported
 * getState/startKeepAwake/stopKeepAwake, and the OS power state measured by a separate Node process.
 *
 * There is deliberately no language model, chat participant, tool or hook in this file. Manual
 * protection must work with no model, sign-in, hook or network service, and the retired @awake route is
 * not a stand-in for Auto. Production Auto is Unavailable, so the Auto cases that need real native
 * Copilot work are reported BLOCKED and are never counted as passing. The coordinator's owner-ID
 * algorithm is unit-tested elsewhere; that is algorithm evidence, not native Auto evidence.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const vscode = require('vscode');
const { isAlive } = require('../../os/probe');

const EXTENSION_ID = 'apkola29.agent-keep-awake';
const GREEN = 'testing.iconPassed';
const WINDOWS = process.platform === 'win32';
const HOUR_MS = 60 * 60_000;
const TEST_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 60_000;
// Linux can run a GNOME session helper beside systemd-inhibit; every other platform runs exactly one helper.
const MAX_HELPERS = process.platform === 'linux' ? 2 : 1;

const AUTO_NATIVE_BLOCKED_REASON =
  'Production Auto is Unavailable: no verified native hook profile, IPC bridge or adapter is delivered (plan Stage B/C). ' +
  'Unit-level owner-ID coverage is algorithm evidence only, never native Auto evidence.';

/** Auto acceptance cases that need a real native Copilot run. A12 is exercised below for its Unavailable branch only. */
/** @type {readonly (readonly [string, string])[]} */
const AUTO_NATIVE_BLOCKED = [
  ['A01', 'arming Auto while idle shows Auto: Waiting with no helper'],
  ['A02', 'a normal native Copilot prompt is protected from reasoning through tools'],
  ['A03', 'a silent long command or research is not released early'],
  ['A04', 'a successful tool ends while its parent stays held'],
  ['A05', 'tool or provider errors leave no orphaned or falsely active owner'],
  ['A06', 'a parent with overlapping subagents holds until the last real owner settles'],
  ['A07', 'a Stop rejected by another hook never claims completion or drops protection'],
  ['A08', 'user cancellation of native Copilot has a proven release path'],
  ['A09', 'duplicate, reordered and stale hook events cannot release early or reacquire after Off'],
  ['A10', 'old end events cannot release a newer prompt in the same session'],
  ['A11', 'turning Auto on mid-chat warns that the existing work is untracked'],
  ['A13', 'IPC client death, broker reload or an inaccessible pipe fails visibly without altering native chat'],
  ['A14', 'the safety deadline shows an expiry warning and is never labelled completed'],
  ['A15', 'Off while native Copilot runs stops protection without cancelling or modifying Copilot'],
  ['A16', 'a valid old hook event received while Off keeps it Off']
];

/** @type {ReturnType<typeof import('../../../src/extension').activate>} */
let api;
/** @typedef {ReturnType<typeof api.getState>} State */
/** @type {Map<string, import('../../os/processes').ProcessIdentity>} */
const ownedHelpers = new Map();
/** @type {Set<number>} */
const activeHelperPids = new Set();

/** A test that exceeded its bound; the run stops because its body may still be acting on the editor. */
class TestTimeout extends Error {}

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @template T
 * @param {PromiseLike<T>} work
 * @param {number} ms
 * @param {string} label
 * @param {boolean} [abortsRun]
 * @returns {Promise<T>}
 */
function bounded(work, ms, label, abortsRun = false) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const message = `Timed out after ${ms} ms: ${label}`;
      reject(abortsRun ? new TestTimeout(message) : new Error(message));
    }, ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([work, limit])).finally(() => clearTimeout(timer));
}

/**
 * Runs a registered command and waits for it, within a bound. Explanatory toasts never block a command.
 * @param {string} name
 * @param {unknown[]} args
 * @returns {Promise<unknown>}
 */
function command(name, ...args) {
  return bounded(Promise.resolve(vscode.commands.executeCommand(`agentKeepAwake.${name}`, ...args)),
    COMMAND_TIMEOUT_MS, `command agentKeepAwake.${name}`);
}

/**
 * Runs a command without waiting for it. Used for pickers that wait for a human choice, and to observe
 * state while a startup is still pending.
 * @param {string} name
 * @param {unknown[]} args
 */
function launch(name, ...args) {
  /** @type {{done: boolean, error: unknown, promise: Promise<void>}} */
  const run = { done: false, error: undefined, promise: Promise.resolve() };
  run.promise = Promise.resolve(vscode.commands.executeCommand(`agentKeepAwake.${name}`, ...args)).then(
    () => { run.done = true; },
    (/** @type {unknown} */ error) => { run.done = true; run.error = error; }
  );
  return run;
}

/** @param {string} script @param {string} modulePath @param {unknown} value */
async function nodeWorker(script, modulePath, value) {
  const node = process.env.AKA_TEST_NODE;
  assert.ok(node, 'runner supplies an actual Node binary; never spawn another editor');
  /** @type {string} */
  const output = await new Promise((resolve, reject) => {
    execFile(node, ['-e', script, modulePath, JSON.stringify(value)],
      { encoding: 'utf8', windowsHide: true, timeout: 65_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
  });
  return /** @type {unknown} */ (JSON.parse(output));
}

/**
 * Birth markers of live processes, measured outside the extension host so a slow query cannot stall helper events.
 * @param {number[]} pids
 * @returns {Promise<import('../../os/processes').ProcessIdentity[]>}
 */
async function identities(pids) {
  const marks = await nodeWorker(
    'console.log(JSON.stringify(JSON.parse(process.argv[2]).map(p=>require(process.argv[1]).identity(p)).filter(Boolean)))',
    path.join(__dirname, '..', '..', 'os', 'processes.js'), pids
  );
  assert.ok(Array.isArray(marks), 'helper identities must be an array');
  /** @type {import('../../os/processes').ProcessIdentity[]} */
  const verified = [];
  for (const mark of marks) {
    assert.ok(mark && typeof mark === 'object' && typeof mark.pid === 'number' && pids.includes(mark.pid) &&
      typeof mark.birth === 'string' && mark.birth, 'helper identity must include its process birth marker');
    verified.push({ pid: mark.pid, birth: mark.birth });
  }
  return verified;
}

/** Records every helper the extension reports, with its birth marker, so the outer runner can clean up scoped. */
async function rememberHelpers() {
  const currentPids = api.getState().pids;
  const pids = currentPids.filter(pid => !activeHelperPids.has(pid));
  activeHelperPids.clear();
  for (const pid of currentPids) activeHelperPids.add(pid);
  if (!pids.length) return;
  const marks = await identities(pids);
  // A helper that exited while it was being measured may have handed its PID to a stranger; record live helpers only.
  const live = new Set(api.getState().pids);
  for (const mark of marks) {
    if (live.has(mark.pid)) ownedHelpers.set(`${mark.pid}:${mark.birth}`, mark);
  }
  const workspace = process.env.AKA_TEST_WORKSPACE;
  assert.ok(workspace);
  fs.writeFileSync(path.join(workspace, 'owned-helpers.json'), JSON.stringify([...ownedHelpers.values()]));
}

/** @param {number[]} [pids] */
async function nativeState(pids = []) {
  await rememberHelpers();
  const state = await nodeWorker(
    'console.log(JSON.stringify(require(process.argv[1]).probe(JSON.parse(process.argv[2]))))',
    path.join(__dirname, '..', '..', 'os', 'probe.js'), pids
  );
  assert.ok(state && typeof state === 'object' && 'system' in state && typeof state.system === 'boolean' &&
    'display' in state && typeof state.display === 'boolean' && 'raw' in state && typeof state.raw === 'string',
  'power worker must return a valid measured state');
  return { system: state.system, display: state.display, raw: state.raw };
}

/** @param {string} key @param {unknown} value */
const set = (key, value) => vscode.workspace.getConfiguration('agentKeepAwake')
  .update(key, value, vscode.ConfigurationTarget.Global);

/**
 * What no observable state may ever claim, whatever the mode or the platform.
 * @param {State} state
 */
function assertTruthful(state) {
  const seen = () => JSON.stringify(state);
  assert.ok(state.pids.length <= MAX_HELPERS, `one backend per window, never a helper per click: ${seen()}`);
  if (state.statusColor === GREEN) {
    assert.equal(state.confirmed, true, `green is only ever an OS-confirmed hold: ${seen()}`);
  }
  if (state.confirmed) {
    assert.ok(state.desired && state.pids.length > 0, `a confirmed hold needs a desired owner and a live helper: ${seen()}`);
  }
  if (state.mode === 'off') {
    assert.ok(!state.desired && !state.confirmed && state.ownerCount === 0 && state.pids.length === 0, `Off holds nothing: ${seen()}`);
  }
  if (state.state === 'starting') assert.match(state.statusText, /Starting/, seen());
  if (state.state === 'failed') assert.match(state.statusText, /Failed/, seen());
  if (state.state === 'unverified') {
    assert.equal(state.confirmed, false, seen());
    assert.match(state.statusText, /Unverified/, seen());
  }
  if (state.mode === 'auto' && state.state === 'unavailable') assert.match(state.statusText, /Auto: Unavailable/, seen());
}

/**
 * Polls without recording helpers, so a startup is observed while it is still starting.
 * @param {() => boolean} condition
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 */
async function waitQuick(condition, options = {}) {
  const { timeoutMs = 15_000, intervalMs = 25, label = 'the test condition' } = options;
  const end = Date.now() + timeoutMs;
  for (;;) {
    assertTruthful(api.getState());
    if (condition()) return;
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}: ${JSON.stringify(api.getState())}`);
    await sleep(intervalMs);
  }
}

/**
 * @param {() => boolean} condition
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 */
async function waitFor(condition, options) {
  await waitQuick(condition, options);
  await rememberHelpers();
}

/** Everything Off promises: no hold, no helper, no deadline and nothing green. */
function assertOff() {
  const state = api.getState();
  assert.equal(state.supported, true);
  assert.equal(state.mode, 'off');
  assert.equal(state.state, 'off');
  assert.equal(state.desired, false);
  assert.equal(state.confirmed, false);
  assert.equal(state.ownerCount, 0);
  assert.equal(state.durationMs, 0);
  assert.equal(state.expiresAt, 0);
  assert.equal(state.statusColor, undefined);
  assert.equal(state.backendState, 'off');
  assert.deepEqual(state.pids, []);
  assert.deepEqual(state.helpers, []);
  assert.equal(state.keepsDisplayOn, WINDOWS, 'Windows combines system and display requests; other platforms leave the display alone');
  activeHelperPids.clear();
}

/** Auto selected while Unavailable: idle, never green, and holding nothing. */
function assertAutoUnavailable() {
  const state = api.getState();
  assert.equal(state.mode, 'auto');
  assert.equal(state.state, 'unavailable');
  assert.equal(state.desired, false);
  assert.equal(state.confirmed, false);
  assert.equal(state.ownerCount, 0);
  assert.equal(state.statusColor, undefined);
  assert.equal(state.backendState, 'off');
  assert.deepEqual(state.pids, []);
  assert.deepEqual(state.helpers, []);
  assert.equal(state.auto.status, 'unavailable');
  assert.ok(state.auto.reason.length > 0, 'Auto: Unavailable must say why and point to Keep awake');
  activeHelperPids.clear();
}

/**
 * A live Manual hold. Windows is acknowledged by the native call; macOS and Linux have no OS acknowledgement,
 * so their hold is shown as Unverified and is never asserted green or OS-confirmed.
 * @param {number} durationMs 0 means until turned off
 * @returns {State}
 */
function assertManual(durationMs) {
  const state = api.getState();
  assert.equal(state.mode, 'manual');
  assert.equal(state.desired, true);
  assert.equal(state.ownerCount, 1);
  assert.equal(state.durationMs, durationMs);
  assert.equal(state.backendState, 'on');
  assert.ok(state.pids.length >= 1 && state.helpers.length >= 1, `a live hold has a live helper: ${JSON.stringify(state)}`);
  assert.equal(state.keepsDisplayOn, WINDOWS);
  assert.equal(state.error, '');
  if (durationMs === 0) assert.equal(state.expiresAt, 0, 'an until-off hold has no deadline');
  else assert.ok(state.expiresAt > Date.now(), 'a timed hold shows a future deadline');
  if (WINDOWS) {
    assert.equal(state.state, 'on');
    assert.equal(state.confirmed, true);
    assert.equal(state.statusColor, GREEN);
  } else {
    assert.equal(state.state, 'unverified');
    assert.equal(state.confirmed, false);
    assert.notEqual(state.statusColor, GREEN);
  }
  return state;
}

async function waitForHold() {
  await waitFor(() => {
    const state = api.getState();
    return state.mode === 'manual' && state.backendState === 'on' && state.state === (WINDOWS ? 'on' : 'unverified');
  }, { timeoutMs: 40_000, label: 'a live Manual hold' });
}

/**
 * Starts Manual through a real entry point and waits for the hold. Entry points that report an outcome
 * (keepAwake, startKeepAwake) must agree with the visible state: true means native-confirmed, never merely wanted.
 * @param {() => Promise<unknown>} start
 * @param {boolean} [reportsOutcome] false for aliases that only toggle, such as toggleSession
 */
async function startManual(start, reportsOutcome = true) {
  const answer = await start();
  if (reportsOutcome) {
    assert.equal(typeof answer, 'boolean', 'a Manual start reports whether native protection was confirmed');
    assert.equal(api.getState().confirmed, answer, 'true means native-confirmed; false means failed, unverified or cancelled');
  }
  await waitForHold();
}

/** @param {number[]} pids helper PIDs reported by the extension */
async function assertOsHold(pids) {
  const held = await nativeState(pids);
  assert.equal(held.system, true, held.raw);
  assert.equal(held.display, WINDOWS, `${held.raw}: Windows needs the combined system+display request; other platforms never force the display on`);
}

/** @param {number[]} pids helper PIDs that must be gone, with their OS request */
async function assertReleased(pids) {
  assertOff();
  await waitFor(() => pids.every(pid => !isAlive(pid)), { label: 'every owned helper to exit' });
  const after = await nativeState(pids);
  assert.equal(after.system, false, after.raw);
  assert.equal(after.display, false, after.raw);
}

/**
 * Kills one helper this extension started, after proving the PID still names the process recorded at startup.
 * @param {number} pid
 */
async function killOwnedHelper(pid) {
  const recorded = [...ownedHelpers.values()].find(mark => mark.pid === pid);
  assert.ok(recorded, 'a test may only kill a helper recorded with its birth marker');
  const [current] = await identities([pid]);
  assert.ok(current && current.birth === recorded.birth, 'the PID must still be the helper recorded at startup');
  process.kill(pid);
}

/**
 * Drives the real mode picker with the keyboard commands a user's keys run.
 * @param {number} index 0 Off, 1 Keep awake, 2 Auto - Copilot activity
 */
async function chooseMode(index) {
  const picker = launch('selectMode');
  await sleep(700);
  try {
    assert.equal(picker.done, false, 'selectMode must wait for a choice');
    for (let step = 0; step < index; step++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  } catch (error) {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    throw error;
  }
  return picker;
}

/** Returns the fixture to Off and its default settings. Only this extension's own holds and settings are touched. @param {boolean} keepHold */
async function resetFixture(keepHold) {
  /** @type {unknown[]} */
  const errors = [];
  /** @param {string} label @param {() => unknown} step */
  const attempt = async (label, step) => {
    try {
      await bounded(Promise.resolve(step()), 20_000, label);
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt('close pickers', () => vscode.commands.executeCommand('workbench.action.closeQuickOpen'));
  if (!keepHold) {
    await attempt('turn Off', () => command('turnOff'));
    await attempt('stop the hold', () => api.stopKeepAwake());
  }
  await attempt('reset Duration (Hours)', () => set('durationHours', undefined));
  await attempt('reset status item visibility', () => set('showStatusBarItem', undefined));
  if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed.');
}

async function run() {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext);
  api = await ext.activate();
  // A hold that already exists would be mistaken for somebody else's power request in the baseline below.
  assertOff();
  const baseline = await nativeState();
  console.log(`INFO power baseline: ${baseline.raw}`);
  if (WINDOWS && (baseline.system || baseline.display)) {
    const reason = 'INCONCLUSIVE: Windows already has an ambient system/display power request. Close other sleep blockers and retest; this run cannot prove acquire/release.';
    const workspace = process.env.AKA_TEST_WORKSPACE;
    // Lets the outer runner report this as inconclusive rather than as a generic failure; it is still never a pass.
    if (workspace) fs.writeFileSync(path.join(workspace, 'inconclusive.json'), JSON.stringify({ reason, baseline }));
    throw new Error(reason);
  }

  /** @type {{name: string, fn: () => Promise<void>, timeoutMs: number, keepsHold: boolean}[]} */
  const tests = [];
  /** @param {string} name @param {() => Promise<void>} fn @param {{timeoutMs?: number, keepsHold?: boolean}} [options] */
  const test = (name, fn, options = {}) =>
    tests.push({ name, fn, timeoutMs: options.timeoutMs ?? TEST_TIMEOUT_MS, keepsHold: Boolean(options.keepsHold) });

  // ---- Off and idle safety --------------------------------------------------------------------------------

  test('M01 startup is Off: no helper, no model, no chat participant, nothing to cancel', async () => {
    assertOff();
    const state = api.getState();
    assert.equal(state.version, ext.packageJSON.version, 'the loaded code is the packaged version');
    assert.equal(state.auto.status, 'unavailable', 'production Auto declares itself Unavailable');
    assert.equal(Reflect.has(api, 'participant'), false, 'primary protection never routes through a chat participant');
    assert.equal(Reflect.has(api, 'handleRequest'), false);
    const contributes = ext.packageJSON.contributes ?? {};
    assert.equal(contributes.chatParticipants, undefined, 'the retired @awake route contributes nothing');
    assert.equal(contributes.languageModelTools, undefined);
    assert.equal(ext.packageJSON.enabledApiProposals, undefined);
  });

  test('M01 old enabled/mode settings in a real user profile cannot revive editor-wide protection', async () => {
    const config = vscode.workspace.getConfiguration('agentKeepAwake');
    assert.equal(config.get('enabled'), true, 'runner seeds actual old user settings before activation');
    assert.equal(config.get('mode'), 'always');
    await sleep(300);
    assertOff();
  });

  test('M01 ordinary document edits cannot activate protection', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'ordinary editor use' });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), 'change\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await sleep(300);
    assertOff();
  });

  test('M01 workspace file writes cannot activate protection', async () => {
    const workspace = process.env.AKA_TEST_WORKSPACE;
    assert.ok(workspace);
    fs.writeFileSync(path.join(workspace, 'not-a-hold.txt'), 'ordinary file write\n');
    await sleep(1_000);
    assertOff();
  });

  test('M01 an ordinary running task cannot activate protection', async () => {
    /** @type {vscode.EventEmitter<number | void>} */
    const close = new vscode.EventEmitter();
    /** @type {vscode.EventEmitter<string>} */
    const write = new vscode.EventEmitter();
    let opened = false;
    const task = new vscode.Task(
      { type: 'agentKeepAwakeTest' }, vscode.TaskScope.Workspace,
      'ordinary work', 'agent-keep-awake-tests',
      new vscode.CustomExecution(async () => ({
        onDidWrite: write.event, onDidClose: close.event,
        open: () => { opened = true; write.fire('ordinary task\r\n'); },
        close: () => close.fire(undefined)
      }))
    );
    /** @type {vscode.TaskExecution | undefined} */
    let execution;
    let ended = false;
    const endedSubscription = vscode.tasks.onDidEndTask(event => {
      if (event.execution === execution) ended = true;
    });
    try {
      execution = await vscode.tasks.executeTask(task);
      await waitFor(() => opened);
      await sleep(1_000);
      assert.equal(ended, false, 'the ordinary task must still be running');
      assertOff();
    } finally {
      try {
        if (execution) {
          execution.terminate();
          await waitFor(() => ended);
        }
      } finally {
        endedSubscription.dispose();
        close.dispose();
        write.dispose();
      }
    }
  });

  test('M01 hiding the control while Off acquires nothing', async () => {
    try {
      await set('showStatusBarItem', false);
      await sleep(300);
      assertOff();
    } finally {
      await set('showStatusBarItem', undefined);
    }
  });

  test('M01 OS power state is unchanged by ordinary editor work', async () => {
    const after = await nativeState();
    assert.equal(after.system, baseline.system);
    assert.equal(after.display, baseline.display);
    assertOff();
  });

  // ---- Delivered controls ---------------------------------------------------------------------------------

  test('primary controls and aliases are registered; persistent legacy switches are not', async () => {
    const commands = await vscode.commands.getCommands(true);
    /** @type {string[]} */
    const contributed = (ext.packageJSON.contributes?.commands ?? []).map((/** @type {{command: string}} */ item) => item.command);
    for (const name of ['selectMode', 'keepAwake', 'autoMode', 'turnOff', 'toggleSession', 'stopSession']) {
      assert.ok(commands.includes(`agentKeepAwake.${name}`), `agentKeepAwake.${name} is registered`);
      assert.ok(contributed.includes(`agentKeepAwake.${name}`), `agentKeepAwake.${name} is contributed in the manifest`);
    }
    for (const id of contributed) assert.ok(commands.includes(id), `${id} is contributed but not registered`);
    for (const name of ['enable', 'disable', 'toggle']) {
      assert.ok(!commands.includes(`agentKeepAwake.${name}`), `the old persistent ${name} switch must stay removed`);
    }
    // Diagnostics change nothing, and Off is idempotent from Off.
    await command('showLog');
    await command('showStatus');
    await command('turnOff');
    await command('stopSession');
    assertOff();
  });

  test('selectMode opens the mode picker and dismissing it changes nothing', async () => {
    const picker = launch('selectMode');
    try {
      await sleep(700);
      assert.equal(picker.done, false, 'selectMode waits for a choice instead of changing mode by itself');
      assertOff();
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    }
    await bounded(picker.promise, 20_000, 'selectMode to finish after the picker closed');
    assert.equal(picker.error, undefined);
    assertOff();
  });

  test('selectMode drives Off, unavailable Auto and Keep awake from the real picker', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      const auto = await chooseMode(2);
      await bounded(auto.promise, 30_000, 'the Auto choice to finish');
      assert.equal(auto.error, undefined);
      assertAutoUnavailable();

      const keep = await chooseMode(1);
      await bounded(keep.promise, 60_000, 'the Keep awake choice to finish');
      assert.equal(keep.error, undefined);
      await waitForHold();
      const held = assertManual(0);
      pids = held.pids;
      await assertOsHold(pids);

      const off = await chooseMode(0);
      await bounded(off.promise, 30_000, 'the Off choice to finish');
      assert.equal(off.error, undefined);
      assertOff();
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  test('chooseDuration offers one-off durations and leaves Duration (Hours) alone', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await set('durationHours', 3);
      const picker = launch('chooseDuration');
      await sleep(700);
      assert.equal(picker.done, false, 'chooseDuration waits for a choice');
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await bounded(picker.promise, 60_000, 'the duration choice to finish');
      assert.equal(picker.error, undefined);
      await waitForHold();
      const held = assertManual(30 * 60_000);
      pids = held.pids;
      assert.ok(held.expiresAt <= Date.now() + 30 * 60_000);
      assert.equal(vscode.workspace.getConfiguration('agentKeepAwake').get('durationHours'), 3, 'a one-off choice leaves the setting alone');
      await command('turnOff');
      assertOff();
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      api.stopKeepAwake();
      await set('durationHours', undefined);
    }
    await assertReleased(pids);
  });

  // ---- Manual: Keep awake -----------------------------------------------------------------------------------

  test('M02/M03 Keep awake lasts until Off, ignores Duration (Hours), and holds one real combined OS request', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await set('durationHours', 2);
      const clicks = Promise.all([command('keepAwake'), command('keepAwake')]);
      await clicks;
      await waitForHold();
      const held = assertManual(0);
      pids = held.pids;
      assert.equal(held.expiresAt, 0, 'the primary control has no expiry even when the timed setting is 2 hours');
      await assertOsHold(pids);
      assert.ok(pids.every(pid => isAlive(pid)));

      await startManual(() => command('keepAwake'));
      const again = assertManual(0);
      assert.deepEqual(again.pids, pids, 'selecting Keep awake again keeps the same hold');
      assert.equal(again.generation, held.generation);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
      await set('durationHours', undefined);
    }
    await assertReleased(pids);
  });

  test('M02/M03 the timed command uses the one-hour default, shows its deadline, and stopSession is Off', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      const clickedAt = Date.now();
      await startManual(() => command('toggleSession'), false);
      const held = assertManual(HOUR_MS);
      pids = held.pids;
      assert.ok(held.expiresAt >= clickedAt + HOUR_MS, 'one click starts the one-hour default deadline');
      assert.ok(held.expiresAt <= Date.now() + HOUR_MS);
      await assertOsHold(pids);

      await command('stopSession');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  test('M05 Duration (Hours) changes affect only the next session and never move an active deadline', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await set('durationHours', 2);
      const before = Date.now();
      await startManual(() => command('toggleSession'), false);
      const held = assertManual(2 * HOUR_MS);
      pids = held.pids;
      assert.ok(held.expiresAt >= before + 2 * HOUR_MS);

      await set('durationHours', 0);
      const after = api.getState();
      assert.equal(after.expiresAt, held.expiresAt, 'live settings do not silently extend an active session');
      assert.equal(after.durationMs, held.durationMs);
      assert.equal(after.generation, held.generation);
      assert.deepEqual(after.pids, pids);
      assert.equal(after.confirmed, held.confirmed);

      await command('toggleSession');
      assertOff();
    } finally {
      api.stopKeepAwake();
      await set('durationHours', undefined);
    }
    await assertReleased(pids);
  });

  test('M02 a zero-hour setting makes the timed command live until Off with no expiry', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await set('durationHours', 0);
      await startManual(() => command('toggleSession'), false);
      const held = assertManual(0);
      pids = held.pids;
      assert.equal(held.expiresAt, 0);
      await assertOsHold(pids);

      await command('toggleSession');
      assertOff();
    } finally {
      api.stopKeepAwake();
      await set('durationHours', undefined);
    }
    await assertReleased(pids);
  });

  test('M04 timed expiry stops once, clears green, releases the helper and is not revived by a stale timer', async () => {
    const durationMs = 15_000;
    /** @type {number[]} */
    let pids = [];
    try {
      const requestedAt = Date.now();
      await startManual(() => api.startKeepAwake(durationMs));
      const held = assertManual(durationMs);
      pids = held.pids;
      assert.ok(held.expiresAt >= requestedAt + durationMs, 'the deadline is derived from the requested duration');
      assert.ok(held.expiresAt <= Date.now() + durationMs);

      await waitFor(() => api.getState().mode === 'off', {
        timeoutMs: durationMs + 20_000, label: 'the deadline to release the hold'
      });
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
    await sleep(2_000);
    assertOff();
  }, { timeoutMs: 120_000 });

  test('M06 rapid double clicks and Off during startup never leak a helper, an owner or a false green', async () => {
    /** @type {number[]} */
    const launched = [];
    /** @type {number[]} */
    let pids = [];
    try {
      for (const stop of ['turnOff', 'stopSession', 'turnOff']) {
        const first = command('keepAwake');
        void first.catch(() => undefined);
        await waitQuick(() => api.getState().pids.length > 0, { timeoutMs: 10_000, intervalMs: 5, label: 'the helper to launch' });
        const starting = api.getState();
        assert.equal(starting.mode, 'manual');
        assert.equal(starting.state, 'starting', 'nothing is confirmed while the helper is still starting');
        assert.equal(starting.confirmed, false);
        assert.equal(starting.statusColor, undefined);
        assert.equal(starting.ownerCount, 1);
        launched.push(...starting.pids);

        const second = command('keepAwake');
        assert.deepEqual(api.getState().pids, starting.pids, 'a second click never launches a second helper');
        assert.equal(api.getState().ownerCount, 1);
        const stopped = command(stop);
        const [firstAnswer, secondAnswer] = await Promise.all([first, second, stopped]);
        assert.equal(firstAnswer, false, 'a startup cancelled by Off is never reported as confirmed');
        assert.equal(secondAnswer, false);
        assertOff();
      }
      await waitFor(() => launched.every(pid => !isAlive(pid)), { label: 'every transient helper to exit' });
      const idle = await nativeState(launched);
      assert.equal(idle.system, false, idle.raw);
      assert.equal(idle.display, false, idle.raw);
      await sleep(1_500);
      assertOff();

      await startManual(() => command('keepAwake'));
      const healthy = assertManual(0);
      pids = healthy.pids;
      await assertOsHold(pids);
      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  test('M09 hiding the control keeps a live hold, and Off stays reachable by command', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await startManual(() => command('keepAwake'));
      const held = assertManual(0);
      pids = held.pids;

      await set('showStatusBarItem', false);
      await sleep(500);
      const hidden = api.getState();
      assert.equal(hidden.mode, 'manual');
      assert.equal(hidden.confirmed, held.confirmed);
      assert.equal(hidden.statusColor, held.statusColor);
      assert.equal(hidden.generation, held.generation);
      assert.deepEqual(hidden.pids, pids);
      assert.ok(pids.every(pid => isAlive(pid)), 'hiding the control releases nothing');
      await assertOsHold(pids);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
      await set('showStatusBarItem', undefined);
    }
    await assertReleased(pids);
  });

  // ---- Auto is Unavailable in production --------------------------------------------------------------------

  test('A12 unavailable Auto is idle, never green and helper-free, and Off stays reachable', async () => {
    try {
      assert.equal(await command('autoMode'), false, 'unavailable Auto reports that it was not armed');
      assertAutoUnavailable();
      await sleep(1_500);
      assertAutoUnavailable();
      const idle = await nativeState();
      assert.equal(idle.system, baseline.system);
      assert.equal(idle.display, baseline.display);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
  });

  test('A12 Keep awake stays usable after an unavailable Auto attempt', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      assert.equal(await command('autoMode'), false);
      assertAutoUnavailable();
      await startManual(() => command('keepAwake'));
      const held = assertManual(0);
      pids = held.pids;
      await assertOsHold(pids);
      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  test('A12 selecting unavailable Auto cannot replace or drop a live Manual hold or its deadline', async () => {
    /** @type {number[]} */
    let pids = [];
    try {
      await startManual(() => command('toggleSession'), false);
      const before = assertManual(HOUR_MS);
      pids = before.pids;

      assert.equal(await command('autoMode'), false, 'unavailable Auto reports that it was not armed');
      const after = assertManual(HOUR_MS);
      assert.equal(after.generation, before.generation, 'the hold keeps its identity');
      assert.equal(after.instanceId, before.instanceId);
      assert.equal(after.expiresAt, before.expiresAt, 'the deadline is not reset by the Auto attempt');
      assert.deepEqual(after.pids, pids);
      assert.match(after.notice, /unavailable|not available/i, 'the preserved hold says why Auto was not selected');
      assert.ok(pids.every(pid => isAlive(pid)));
      await assertOsHold(pids);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  test('A12 selecting unavailable Auto during Manual startup neither cancels nor duplicates it', async () => {
    /** @type {number[]} */
    let pids = [];
    const start = launch('keepAwake');
    try {
      await waitQuick(() => api.getState().pids.length > 0, { timeoutMs: 10_000, intervalMs: 5, label: 'the helper to launch' });
      const starting = api.getState();
      assert.equal(starting.mode, 'manual');
      assert.equal(starting.confirmed, false);
      pids = starting.pids;

      assert.equal(await command('autoMode'), false);
      const during = api.getState();
      assert.equal(during.mode, 'manual', 'an Auto attempt cannot replace a pending Manual startup');
      assert.equal(during.generation, starting.generation);
      assert.deepEqual(during.pids, starting.pids, 'no second helper is launched');

      await bounded(start.promise, 60_000, 'the Manual startup to settle');
      assert.equal(start.error, undefined);
      await waitForHold();
      const held = assertManual(0);
      assert.deepEqual(held.pids, starting.pids);
      assert.equal(held.generation, starting.generation);
      await assertOsHold(held.pids);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(pids);
  });

  // ---- Failure ----------------------------------------------------------------------------------------------

  test('P01 a killed helper clears green, a bounded retry restores one helper, and Off still cleans up', async () => {
    /** @type {number[]} */
    const everyHelper = [];
    try {
      await startManual(() => command('keepAwake'));
      const held = assertManual(0);
      everyHelper.push(...held.pids);
      for (const pid of held.pids) await killOwnedHelper(pid);

      // Wait for the loss itself to be noticed (not for `confirmed`, which macOS and Linux never report).
      await waitQuick(() => api.getState().state !== held.state, {
        timeoutMs: 10_000, intervalMs: 10, label: 'the lost helper to be noticed'
      });
      const lost = api.getState();
      assert.equal(lost.confirmed, false);
      assert.notEqual(lost.statusColor, GREEN, 'green clears as soon as the helper is gone');
      assert.equal(lost.mode, 'manual', 'losing the helper is not the user turning Keep awake off');
      assert.equal(lost.desired, true, 'the owner is retained for bounded backend recovery');
      assert.equal(lost.ownerCount, 1);
      assert.ok(['starting', 'failed'].includes(lost.state), `not claimed as held while the helper is gone: ${lost.state}`);

      await waitForHold();
      const restored = assertManual(0);
      everyHelper.push(...restored.pids);
      assert.ok(restored.pids.every(pid => !held.pids.includes(pid)), 'a new helper replaced the killed one');
      assert.equal(restored.generation, held.generation, 'recovery is not a new selection');
      await assertOsHold(restored.pids);

      await command('turnOff');
      assertOff();
    } finally {
      api.stopKeepAwake();
    }
    await assertReleased(everyHelper);
  }, { timeoutMs: 120_000 });

  // ---- Final: real editor close -----------------------------------------------------------------------------

  test('M07 leave Keep awake on until Off, with no timer, for the outer runner to prove real editor-close cleanup', async () => {
    await startManual(() => command('keepAwake'));
    const held = assertManual(0);
    await assertOsHold(held.pids);
    const workspace = process.env.AKA_TEST_WORKSPACE;
    assert.ok(workspace);
    fs.writeFileSync(path.join(workspace, 'shutdown-check.json'), JSON.stringify({
      pids: held.pids, baseline, platform: process.platform,
      mode: held.mode, state: held.state, durationMs: held.durationMs, expiresAt: held.expiresAt
    }));
  }, { keepsHold: true });

  console.log(`\nAgent Keep-Awake native control tests (VS Code ${vscode.version}, ${process.platform}/${process.arch}, extension ${ext.packageJSON.version})`);
  const suiteStarted = Date.now();
  let failures = 0;
  let passed = 0;
  let abortedBy = '';
  try {
    for (const t of tests) {
      if (abortedBy) {
        failures++;
        console.error(`NOT RUN ${t.name} (${abortedBy})`);
        continue;
      }
      const started = Date.now();
      let ok = false;
      try {
        await bounded(t.fn(), t.timeoutMs, t.name, true);
        ok = true;
        passed++;
        console.log(`PASS ${t.name} (${Date.now() - started} ms)`);
      } catch (err) {
        failures++;
        console.error(`FAIL ${t.name} (${Date.now() - started} ms)`, err);
        if (err instanceof TestTimeout) abortedBy = `the run stopped after "${t.name}" timed out`;
      }
      try {
        await resetFixture(ok && t.keepsHold);
      } catch (err) {
        failures++;
        console.error(`FAIL fixture cleanup after ${t.name}`, err);
      }
    }
  } finally {
    await set('durationHours', undefined);
    await set('showStatusBarItem', undefined);
  }

  console.log('\nBLOCKED Auto actual-native acceptance cases (not run, not counted as passing):');
  for (const [id, what] of AUTO_NATIVE_BLOCKED) console.log(`BLOCKED ${id} ${what}`);
  console.log(`  reason: ${AUTO_NATIVE_BLOCKED_REASON}`);
  console.log('INFO not exercised by this single-window suite: M08 two-window ownership and P05 footprint (npm run test:os), ' +
    'P04 unattended idle (test/os/verify-idle-windows.ps1), P02 Unverified status (macOS/Linux hosts only), ' +
    'A12 beyond the production-Unavailable branch (hooks-disabled and untrusted-workspace variants).');
  console.log(`${passed} passing, ${failures} failing, ${AUTO_NATIVE_BLOCKED.length} blocked (${Math.round((Date.now() - suiteStarted) / 1000)} s)`);
  if (failures) throw new Error(`${failures} native control test(s) failed`);
}

module.exports = { run };

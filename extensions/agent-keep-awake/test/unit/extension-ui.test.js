// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { builtinModules } = require('module');
const { EventEmitter } = require('events');

const SRC = path.join(__dirname, '..', '..', 'src');
const COORDINATOR_FILE = path.join(SRC, 'activityCoordinator.js');
const AUTO_REASON = 'No native lifecycle/cancellation/correlation profile validated; use Keep awake.';
const PRESERVED_NOTICE = `Auto is unavailable; Keep awake remains active. ${AUTO_REASON}`;
const GREEN = 'testing.iconPassed';
const HOUR_MS = 60 * 60_000;
const COMMANDS = [
  'selectMode', 'keepAwake', 'autoMode', 'turnOff',
  'toggleSession', 'chooseDuration', 'openSettings', 'stopSession', 'showStatus', 'showLog'
];

/**
 * @typedef {object} Snapshot
 * @property {string} mode
 * @property {string} state
 * @property {boolean} desired
 * @property {boolean} confirmed
 * @property {number} ownerCount
 * @property {number} generation
 * @property {string} instanceId
 * @property {number} durationMs
 * @property {number} expiresAt
 * @property {string} error
 * @property {string} notice
 * @property {{ status: string, harness: string, reason: string }} auto
 * @property {string} backendState
 * @property {number[]} pids
 * @property {string[]} helpers
 *
 * @typedef {{ label: string, description?: string, detail?: string, [key: string]: unknown }} PickItem
 * @typedef {{ level: 'info' | 'warn' | 'error', text: string, actions: string[] }} Toast
 *
 * @typedef {object} StatusItem
 * @property {string} text
 * @property {unknown} tooltip
 * @property {unknown} color
 * @property {unknown} backgroundColor
 * @property {string} command
 * @property {string} name
 * @property {{ label: string, role?: string } | undefined} accessibilityInformation
 * @property {boolean} visible
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => void} dispose
 */

/**
 * Objects built inside the extension's vm realm have foreign prototypes; compare their JSON shape.
 * @param {unknown} value
 * @returns {any}
 */
const plain = value => JSON.parse(JSON.stringify(value));

/** @param {string} text */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const flush = () => new Promise(resolve => setImmediate(resolve));

/** @param {unknown} work */
async function completesPromptly(work) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const outcome = await Promise.race([
    Promise.resolve(work).then(() => 'done'),
    new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 250); })
  ]);
  clearTimeout(timer);
  return outcome === 'done';
}

/** @returns {Snapshot} */
function off() {
  return {
    mode: 'off', state: 'off', desired: false, confirmed: false, ownerCount: 0, generation: 1,
    instanceId: 'instance-under-test', durationMs: 0, expiresAt: 0, error: '', notice: '',
    auto: { status: 'unavailable', harness: 'VS Code Local/Copilot', reason: AUTO_REASON },
    backendState: 'off', pids: [], helpers: []
  };
}

/** @param {number} [durationMs] @returns {Snapshot} */
function starting(durationMs = 0) {
  return { ...off(), mode: 'manual', state: 'starting', desired: true, ownerCount: 1, durationMs, backendState: 'starting', pids: [4242] };
}

/** @param {number} [durationMs] @returns {Snapshot} */
function manualOn(durationMs = 0) {
  return {
    ...starting(durationMs), state: 'on', confirmed: true, backendState: 'on', helpers: ['powershell'],
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0
  };
}

/** @param {string} [error] @returns {Snapshot} */
function failed(error = 'Windows PowerShell (powershell.exe) was not found.') {
  return { ...off(), mode: 'manual', state: 'failed', desired: true, ownerCount: 1, error, backendState: 'error' };
}

/** @param {number} [durationMs] @returns {Snapshot} */
function unverified(durationMs = 0) {
  return {
    ...starting(durationMs), state: 'unverified', backendState: 'on', helpers: ['caffeinate'],
    notice: 'The helper is running, but its native power assertion is unverified. Process survival is not confirmation.'
  };
}

/** @returns {Snapshot} */
function autoUnavailable() {
  return { ...off(), mode: 'auto', state: 'unavailable', notice: AUTO_REASON };
}

/** @returns {Snapshot} */
function autoWaiting() {
  return { ...off(), mode: 'auto', state: 'waiting', auto: { status: 'verified', harness: 'VS Code Local/Copilot', reason: '' } };
}

/** @returns {Snapshot} */
function autoLimited() {
  const reason = 'Only part of the lifecycle is observed.';
  return { ...off(), mode: 'auto', state: 'limited', notice: reason, auto: { status: 'limited', harness: 'VS Code Local/Copilot', reason } };
}

/** @returns {Snapshot} */
function autoOn() {
  return {
    ...manualOn(), mode: 'auto', ownerCount: 2,
    auto: { status: 'verified', harness: 'VS Code Local/Copilot', reason: '' }
  };
}

const scenes = { off, starting, manualOn, failed, unverified, autoUnavailable, autoWaiting, autoLimited, autoOn };

/** Stand-in for src/activityCoordinator.js that follows the agreed contract and exposes the shadowed off(). */
class FakeCoordinator extends EventEmitter {
  /** @param {unknown} backend @param {Record<string, any>} options */
  constructor(backend, options) {
    super();
    this.backend = backend;
    this.options = options;
    /** @type {string[]} */
    this.calls = [];
    /** @type {Snapshot & Record<string, unknown>} */
    this.snapshot = off();
    this.autoResult = false;
    /** @type {'confirm' | 'fail' | 'unverified' | 'throw' | 'hold'} */
    this.startBehavior = 'confirm';
    /** @type {((confirmed: boolean) => void) | undefined} */
    this.settleStart = undefined;
    /** @type {string[]} */
    this.order = [];
  }

  /** @param {Partial<Snapshot> & Record<string, unknown>} next */
  show(next) {
    this.snapshot = { ...this.snapshot, ...next };
    this.emit('change', this.getState());
  }

  /** Deliberately shares nested arrays/objects so the frontend must copy what it exposes. */
  getState() {
    return { ...this.snapshot };
  }

  /** @param {number} [durationMs] @returns {Promise<boolean>} */
  async manual(durationMs = 0) {
    this.calls.push(`manual:${durationMs}`);
    switch (this.startBehavior) {
      case 'throw':
        throw new Error('helper exploded');
      case 'fail':
        this.show(failed());
        return false;
      case 'unverified':
        this.show(unverified(durationMs));
        return false;
      case 'hold':
        this.show(starting(durationMs));
        return await new Promise(resolve => {
          this.settleStart = confirmed => {
            this.settleStart = undefined;
            this.show(confirmed ? manualOn(durationMs) : off());
            resolve(confirmed);
          };
        });
      default:
        this.show(starting(durationMs));
        this.show(manualOn(durationMs));
        return true;
    }
  }

  /**
   * Same name as EventEmitter.off(event, listener), which an unsubscribe by mistake would hit.
   * @param {...unknown} args
   * @returns {any}
   */
  off(...args) {
    if (args.length) throw new Error('ActivityCoordinator.off() is the Off mode; use removeListener to unsubscribe');
    this.calls.push('off');
    this.settleStart?.(false);
    this.show(off());
  }

  /** @returns {boolean} */
  auto() {
    this.calls.push('auto');
    if (this.autoResult) {
      this.show(autoWaiting());
      return true;
    }
    if (this.snapshot.mode === 'manual' && this.snapshot.state !== 'off') {
      this.show({ notice: PRESERVED_NOTICE });
    } else {
      this.show(autoUnavailable());
    }
    return false;
  }

  dispose() {
    this.calls.push('dispose');
    this.order.push('coordinator');
  }
}

class FakeBackend extends EventEmitter {
  constructor() {
    super();
    this.state = 'off';
    this.error = '';
    /** Makes the next acquire fail the way a missing helper does. */
    this.failWith = '';
    /** @type {number[]} */
    this.pids = [];
    /** @type {string[]} */
    this.activeHelpers = [];
    /** @type {{ call: string, display?: boolean }[]} */
    this.calls = [];
  }

  /** @param {{ display?: boolean }} [options] */
  acquire(options = {}) {
    this.calls.push({ call: 'acquire', display: Boolean(options.display) });
    if (this.failWith) {
      this.error = this.failWith;
      this.setState('error');
      return;
    }
    this.setState('starting');
    setImmediate(() => {
      if (this.state !== 'starting') return;
      this.pids = [4242];
      this.activeHelpers = ['fake'];
      this.setState('on');
    });
  }

  release() {
    this.calls.push({ call: 'release' });
    this.error = '';
    this.pids = [];
    this.activeHelpers = [];
    this.setState('off');
  }

  resetFailures() { this.calls.push({ call: 'resetFailures' }); }

  dispose() {
    this.calls.push({ call: 'dispose' });
    this.release();
    this.removeAllListeners();
  }

  /** @param {string} value */
  setState(value) {
    this.state = value;
    this.emit('change', value);
  }
}

/**
 * @param {{
 *   durationHours?: unknown, showStatusBarItem?: boolean, trusted?: boolean, platform?: NodeJS.Platform,
 *   version?: string, realCoordinator?: boolean
 * }} [options]
 */
function fixture(options = {}) {
  const platform = options.platform ?? process.platform;
  const version = options.version ?? '1.1.0-test';
  const trusted = options.trusted ?? true;
  /** @type {Record<string, unknown>} */
  const config = { durationHours: 1, showStatusBarItem: true };
  if ('durationHours' in options) config.durationHours = options.durationHours;
  if (options.showStatusBarItem !== undefined) config.showStatusBarItem = options.showStatusBarItem;

  /** @type {string[]} */
  const order = [];
  /** @type {string[]} */
  const forbidden = [];
  /** @type {string[]} */
  const forbiddenRequires = [];
  /** @type {Record<'debug' | 'info' | 'warn' | 'error', string[]>} */
  const logs = { debug: [], info: [], warn: [], error: [] };
  /** @type {Toast[]} */
  const messages = [];
  /** @type {{ items: PickItem[], options: Record<string, unknown> }[]} */
  const picks = [];
  /** @type {unknown[][]} */
  const executed = [];
  /** @type {Map<string, (...args: unknown[]) => unknown>} */
  const commands = new Map();
  /** @type {Set<(event: { affectsConfiguration: (name: string) => boolean }) => void>} */
  const configListeners = new Set();
  /** @type {FakeCoordinator[]} */
  const coordinators = [];
  /** @type {{ id?: string, alignment?: number }} */
  const statusArgs = {};
  const timers = { timeouts: 0, intervals: 0 };
  let logShown = 0;
  /** @type {(number | ((items: PickItem[]) => PickItem | undefined) | undefined)[]} */
  let chooseQueue = [];
  /** @type {(toast: Toast) => unknown} */
  let toast = () => undefined;
  const backend = new FakeBackend();

  const Coordinator = class extends FakeCoordinator {
    /** @param {unknown} b @param {Record<string, any>} o */
    constructor(b, o) {
      super(b, o);
      this.order = order;
      coordinators.push(this);
    }
  };

  /** @type {StatusItem} */
  const status = {
    text: '', tooltip: '', color: undefined, backgroundColor: undefined, command: '', name: '',
    accessibilityInformation: undefined, visible: false,
    show() { this.visible = true; },
    hide() { this.visible = false; },
    dispose() { order.push('status'); }
  };

  /** @param {Toast['level']} level */
  const show = level => (/** @type {string} */ text, /** @type {string[]} */ ...actions) => {
    const entry = { level, text, actions };
    messages.push(entry);
    return Promise.resolve(toast(entry));
  };

  const fakeProcess = Object.create(process, { platform: { value: platform, enumerable: true } });
  class ThemeColor { constructor(/** @type {string} */ id) { this.id = id; } }
  const vscode = {
    ThemeColor,
    StatusBarAlignment: { Right: 1 },
    get chat() { forbidden.push('chat'); throw new Error('the primary controls must not touch vscode.chat'); },
    get lm() { forbidden.push('lm'); throw new Error('the primary controls must not touch vscode.lm'); },
    get authentication() { forbidden.push('authentication'); throw new Error('no authentication is needed'); },
    workspace: {
      get isTrusted() { return trusted; },
      getConfiguration: () => ({
        get: (/** @type {string} */ key, /** @type {unknown} */ fallback) => key in config ? config[key] : fallback
      }),
      onDidChangeConfiguration: (/** @type {(event: { affectsConfiguration: (name: string) => boolean }) => void} */ listener) => {
        configListeners.add(listener);
        return { dispose: () => { configListeners.delete(listener); } };
      }
    },
    window: {
      createOutputChannel: () => ({
        debug: (/** @type {string} */ m) => { logs.debug.push(m); },
        info: (/** @type {string} */ m) => { logs.info.push(m); },
        warn: (/** @type {string} */ m) => { logs.warn.push(m); },
        error: (/** @type {string} */ m) => { logs.error.push(m); },
        show() { logShown++; },
        dispose() { order.push('log'); }
      }),
      createStatusBarItem: (/** @type {string} */ id, /** @type {number} */ alignment) => {
        statusArgs.id = id;
        statusArgs.alignment = alignment;
        return status;
      },
      showInformationMessage: show('info'),
      showWarningMessage: show('warn'),
      showErrorMessage: show('error'),
      showQuickPick: async (/** @type {PickItem[]} */ items, /** @type {Record<string, unknown>} */ pickOptions) => {
        picks.push({ items, options: pickOptions });
        const next = chooseQueue.shift();
        if (typeof next === 'function') return next(items);
        return typeof next === 'number' ? items[next] : undefined;
      }
    },
    commands: {
      registerCommand: (/** @type {string} */ id, /** @type {(...args: unknown[]) => unknown} */ handler) => {
        commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (/** @type {unknown[]} */ ...args) => { executed.push(args); }
    }
  };

  /** @param {boolean} allowBuiltins */
  function makeRequire(allowBuiltins) {
    return (/** @type {string} */ name) => {
      if (name === 'vscode') return vscode;
      if (name === './keepAwake') return { KeepAwake: class { constructor() { return backend; } } };
      if (name === './activityCoordinator') {
        return { ActivityCoordinator: options.realCoordinator ? load('activityCoordinator.js', true).ActivityCoordinator : Coordinator };
      }
      if (allowBuiltins && builtinModules.includes(name.replace(/^node:/, ''))) return require(name);
      forbiddenRequires.push(name);
      throw new Error(`Unexpected module ${name}`);
    };
  }

  /** @param {string} filename @param {boolean} [allowBuiltins] @returns {Record<string, any>} */
  function load(filename, allowBuiltins = false) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(SRC, filename), 'utf8'), {
      module,
      exports: module.exports,
      process: fakeProcess,
      setTimeout: (/** @type {Parameters<typeof setTimeout>} */ ...args) => { timers.timeouts++; return setTimeout(...args); },
      clearTimeout,
      setInterval: (/** @type {Parameters<typeof setInterval>} */ ...args) => { timers.intervals++; return setInterval(...args); },
      clearInterval,
      require: makeRequire(allowBuiltins)
    }, { filename: path.join(SRC, filename) });
    return module.exports;
  }

  /** @type {{ dispose: () => void }[]} */
  const subscriptions = [];
  const activate = load('extension.js').activate;
  const api = activate({ subscriptions, extension: { packageJSON: { version } } });
  const coordinator = coordinators[0];

  /** @param {string} name */
  async function run(name) {
    const handler = commands.get(`agentKeepAwake.${name}`);
    assert.ok(handler, `agentKeepAwake.${name} must be registered`);
    return await handler();
  }

  /** @param {unknown} value */
  const colorId = value => value instanceof ThemeColor ? value.id : value;

  return {
    api, backend, coordinator, coordinators, status, statusArgs, commands, executed, messages, picks, logs, config,
    order, forbidden, forbiddenRequires, timers, subscriptions, run, flush, version,
    get logShown() { return logShown; },
    /** Queues what the next quick picks answer: an index, a chooser function, or undefined to cancel. */
    choose(/** @type {(number | ((items: PickItem[]) => PickItem | undefined) | undefined)[]} */ ...next) { chooseQueue = next; },
    /** @param {(toast: Toast) => unknown} handler */
    answerToastsWith(handler) { toast = handler; },
    /** @param {string} key @param {unknown} value */
    setConfig(key, value) {
      config[key] = value;
      for (const listener of [...configListeners]) listener({ affectsConfiguration: name => name === 'agentKeepAwake' });
    },
    view() {
      return {
        text: status.text,
        color: colorId(status.color),
        background: colorId(status.backgroundColor),
        tooltip: String(status.tooltip),
        label: status.accessibilityInformation?.label ?? '',
        role: status.accessibilityInformation?.role
      };
    },
    dispose() { for (const subscription of subscriptions) subscription.dispose(); }
  };
}

test('activation gives the coordinator the one backend exactly per contract and stays Off', () => {
  const f = fixture({ platform: 'win32' });
  try {
    assert.equal(f.coordinators.length, 1);
    assert.equal(f.coordinator.backend, f.backend, 'only the coordinator owns the native backend');
    assert.equal(f.coordinator.options.keepDisplayOn, true);
    assert.equal(f.coordinator.options.nativeAcknowledgement, true);
    assert.deepEqual(plain(f.coordinator.options.autoCapability), {
      status: 'unavailable', harness: 'VS Code Local/Copilot', reason: AUTO_REASON
    });
    f.coordinator.options.log('info', 'from the coordinator');
    f.coordinator.options.log('warn', 'a warning');
    f.coordinator.options.log('error', 'an error');
    f.coordinator.options.log('debug', 'a detail');
    assert.deepEqual([f.logs.info.includes('from the coordinator'), f.logs.warn, f.logs.error, f.logs.debug],
      [true, ['a warning'], ['an error'], ['a detail']], 'the coordinator logs as log(level, message) into this output channel');
    assert.deepEqual(f.coordinator.calls, [], 'opening a window requests no mode and no power');
    assert.deepEqual(f.backend.calls, [], 'the frontend never drives the backend itself');
    assert.equal(f.view().text, '$(coffee) @awake ready');
    assert.equal(f.api.getState().mode, 'off');
  } finally { f.dispose(); }
});

test('only Windows keeps the display on and has a native acknowledgement', () => {
  for (const platform of /** @type {const} */ (['linux', 'darwin'])) {
    const f = fixture({ platform });
    try {
      assert.equal(f.coordinator.options.keepDisplayOn, false, platform);
      assert.equal(f.coordinator.options.nativeAcknowledgement, false, platform);
      assert.equal(f.api.getState().keepsDisplayOn, false, platform);
    } finally { f.dispose(); }
  }
});

test('the loaded version is written to the log so an installed package can be told from a loaded one', () => {
  const f = fixture({ version: '1.1.0' });
  try {
    assert.ok(f.logs.info.some(line => /^Keep Awake 1\.1\.0 loaded\./.test(line)), JSON.stringify(f.logs.info));
  } finally { f.dispose(); }
});

test('the primary commands and the existing timed/stop aliases are all registered, and only those', () => {
  const f = fixture();
  try {
    assert.deepEqual([...f.commands.keys()].sort(), COMMANDS.map(name => `agentKeepAwake.${name}`).sort());
    assert.equal(f.statusArgs.id, 'agentKeepAwake.status');
    assert.equal(f.status.name, 'Agent Keep-Awake');
    assert.equal(f.status.command, 'agentKeepAwake.selectMode');
    assert.equal(f.status.visible, true);
  } finally { f.dispose(); }
});

test('the primary controls never load the legacy chat route, touch chat or language-model APIs, or read credentials', async () => {
  const f = fixture();
  try {
    for (const name of COMMANDS) {
      if (name === 'selectMode' || name === 'chooseDuration') f.choose(undefined);
      await f.run(name);
    }
    assert.deepEqual(f.forbiddenRequires, []);
    assert.deepEqual(f.forbidden, []);
    assert.equal('participant' in f.api, false);
    assert.equal('handleRequest' in f.api, false);
  } finally { f.dispose(); }
});

test('the status item opens a picker of Off, Keep awake until Off, unavailable Auto, then a timed option', async () => {
  const f = fixture();
  try {
    f.choose(undefined);
    await f.run('selectMode');
    assert.equal(f.picks.length, 1);
    const [offItem, keepItem, autoItem, timedItem, ...rest] = f.picks[0].items;
    assert.deepEqual(rest, [], 'four simple choices');
    assert.match(offItem.label, /\bOff\b/);
    assert.match(String(offItem.detail), /Other apps may still keep/i);
    assert.match(String(offItem.detail), /never cancels Copilot/i);
    assert.match(keepItem.label, /Keep awake/);
    assert.match(`${keepItem.description} ${keepItem.detail}`, /until I turn it off/i);
    assert.match(String(keepItem.detail), /no Copilot, hooks, model or sign-in/i);
    assert.match(autoItem.label, /Auto - Copilot activity/);
    assert.match(String(autoItem.description), /Unavailable/);
    assert.ok(String(autoItem.detail).includes(AUTO_REASON), 'the coordinator reason explains why Auto is unavailable');
    assert.match(timedItem.label, /set time/i);
    assert.deepEqual(f.coordinator.calls, [], 'dismissing the picker changes nothing');
  } finally { f.dispose(); }
});

test('each picker choice makes exactly one coordinator request, and Keep awake never uses the duration setting', async () => {
  for (const [index, expected] of /** @type {[number, string[]][]} */ ([[0, ['off']], [1, ['manual:0']], [2, ['auto']]])) {
    const f = fixture({ durationHours: 2 });
    try {
      f.choose(index);
      await f.run('selectMode');
      assert.deepEqual(f.coordinator.calls, expected, `picker item ${index}`);
      assert.deepEqual(f.timers, { timeouts: 0, intervals: 0 }, 'the frontend needs no timer; the coordinator owns deadlines');
    } finally { f.dispose(); }
  }
});

test('the timed picker option leads to the one-off durations', async () => {
  const f = fixture({ durationHours: 8 });
  try {
    f.choose(3, items => items.find(item => item.durationMs === 30 * 60_000));
    await f.run('selectMode');
    assert.equal(f.picks.length, 2);
    assert.deepEqual(f.coordinator.calls, ['manual:1800000']);
    assert.equal(f.config.durationHours, 8, 'a one-off choice leaves the setting alone');
  } finally { f.dispose(); }
});

test('the picker marks the current mode', async () => {
  const f = fixture();
  try {
    /** @param {Snapshot} scene @param {number} index */
    const currentAt = async (scene, index) => {
      f.coordinator.show(scene);
      f.choose(undefined);
      await f.run('selectMode');
      const items = f.picks[f.picks.length - 1].items;
      items.forEach((item, i) => assert.equal(/Current/.test(`${item.description}`), i === index, `${scene.mode}/${scene.state} item ${i}`));
    };
    await currentAt(scenes.off(), 0);
    await currentAt(scenes.manualOn(0), 1);
    await currentAt(scenes.autoUnavailable(), 2);
    await currentAt(scenes.manualOn(HOUR_MS), 3);
  } finally { f.dispose(); }
});

test('Keep awake is indefinite, starts once and turns green only when the coordinator confirms it', async () => {
  const f = fixture();
  try {
    f.coordinator.startBehavior = 'hold';
    const starting = f.run('keepAwake');
    await f.flush();
    assert.deepEqual(f.coordinator.calls, ['manual:0']);
    assert.match(f.view().text, /^\$\(sync~spin\) Keep Awake: Starting\.\.\.$/);
    assert.equal(f.view().color, undefined, 'startup cannot falsely show green');
    assert.match(f.view().tooltip, /not confirmed yet/i);
    assert.match(f.view().label, /not confirmed/i);
    f.coordinator.settleStart?.(true);
    assert.equal(await starting, true);
    assert.equal(f.view().text, '$(coffee)', 'the ready text is removed while protection is confirmed');
    assert.equal(f.view().color, GREEN);
    assert.deepEqual(f.messages, [], 'a successful start needs no dialog');
    assert.deepEqual(f.timers, { timeouts: 0, intervals: 0 });
  } finally { f.dispose(); }
});

test('Off from the middle of a startup clears the spinner and reports no error', async () => {
  const f = fixture();
  try {
    f.coordinator.startBehavior = 'hold';
    const starting = f.run('keepAwake');
    await f.flush();
    await f.run('turnOff');
    assert.equal(await starting, false);
    assert.equal(f.view().text, '$(coffee) @awake ready');
    assert.deepEqual(f.messages, [], 'a cancelled startup is not an error');
  } finally { f.dispose(); }
});

test('the timed command uses Duration (Hours), one click, and toggles Off while Keep awake is active', async () => {
  const f = fixture({ durationHours: 2 });
  try {
    await f.run('toggleSession');
    assert.deepEqual(f.coordinator.calls, [`manual:${2 * HOUR_MS}`]);
    assert.equal(f.picks.length, 0, 'no picker for the one-click timed command');
    assert.equal(f.api.getState().confirmed, true);
    await f.run('toggleSession');
    assert.deepEqual(f.coordinator.calls, [`manual:${2 * HOUR_MS}`, 'off']);
    assert.equal(f.view().text, '$(coffee) @awake ready');
  } finally { f.dispose(); }
});

test('Duration (Hours) 0 to 24 converts exactly, including fractions and zero for until-off', async () => {
  for (const [hours, expected] of /** @type {[number, number][]} */ ([
    [0, 0], [0.5, 1_800_000], [1, 3_600_000], [1.1, 3_960_000], [24, 86_400_000]
  ])) {
    const f = fixture({ durationHours: hours });
    try {
      await f.run('toggleSession');
      assert.deepEqual(f.coordinator.calls, [`manual:${expected}`], `${hours} hours`);
    } finally { f.dispose(); }
  }
});

test('invalid Duration (Hours) is reported visibly and never starts a default session', async () => {
  for (const value of [-1, NaN, Infinity, '2', null, 24.1, 1e-9]) {
    const f = fixture({ durationHours: value });
    try {
      await f.run('toggleSession');
      assert.deepEqual(f.coordinator.calls, [], `${String(value)} must not start protection`);
      assert.ok(f.messages.some(m => m.level === 'error' && /duration|hours/i.test(m.text)), String(value));
      assert.ok(f.logs.error.some(line => /duration|hours/i.test(line)));
      assert.equal(f.view().text, '$(coffee) @awake ready');
    } finally { f.dispose(); }
  }
});

test('changing Duration (Hours) never alters an active hold and applies to the next timed session only', async () => {
  const f = fixture({ durationHours: 2 });
  try {
    await f.run('toggleSession');
    const expiresAt = f.api.getState().expiresAt;
    assert.ok(expiresAt > 0);
    f.setConfig('durationHours', 4);
    assert.deepEqual(f.coordinator.calls, [`manual:${2 * HOUR_MS}`], 'the setting change did not touch the active hold');
    assert.equal(f.api.getState().expiresAt, expiresAt);
    await f.run('toggleSession');
    await f.run('toggleSession');
    assert.deepEqual(f.coordinator.calls, [`manual:${2 * HOUR_MS}`, 'off', `manual:${4 * HOUR_MS}`]);
  } finally { f.dispose(); }
});

test('the duration picker keeps its one-off choices and the until-off choice', async () => {
  const f = fixture({ durationHours: 3 });
  try {
    f.choose(undefined);
    await f.run('chooseDuration');
    assert.deepEqual(plain(f.picks[0].items.map(item => item.durationMs)).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b),
      [0, 30 * 60_000, HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS]);
    assert.deepEqual(f.coordinator.calls, []);
    f.choose(items => items.find(item => item.durationMs === 4 * HOUR_MS));
    await f.run('chooseDuration');
    f.choose(items => items.find(item => item.durationMs === 0));
    await f.run('chooseDuration');
    assert.deepEqual(f.coordinator.calls, [`manual:${4 * HOUR_MS}`, 'manual:0']);
    assert.equal(f.config.durationHours, 3);
  } finally { f.dispose(); }
});

test('Turn Off and Stop Timed Session both go Off, even with the status item hidden', async () => {
  for (const name of ['turnOff', 'stopSession']) {
    const f = fixture();
    try {
      await f.run('keepAwake');
      f.setConfig('showStatusBarItem', false);
      assert.equal(f.status.visible, false);
      assert.deepEqual(f.coordinator.calls, ['manual:0'], 'hiding the control releases nothing');
      assert.equal(f.api.getState().confirmed, true);
      await f.run(name);
      assert.deepEqual(f.coordinator.calls, ['manual:0', 'off'], name);
      assert.equal(f.api.getState().mode, 'off');
      f.setConfig('showStatusBarItem', true);
      assert.equal(f.status.visible, true);
    } finally { f.dispose(); }
  }
});

test('Off only releases this extension: it never cancels or touches native Copilot work', async () => {
  const f = fixture();
  try {
    await f.run('keepAwake');
    await f.run('turnOff');
    f.choose(0);
    await f.run('selectMode');
    assert.deepEqual(f.executed, [], 'no cancel, stop or chat command is executed');
    assert.deepEqual(f.forbidden, []);
    assert.deepEqual(f.coordinator.calls, ['manual:0', 'off', 'off']);
  } finally { f.dispose(); }
});

/**
 * Display-only coverage. Production Auto is always Unavailable; the waiting, limited and confirmed Auto rows only
 * prove how the frontend would present a coordinator that reported them. They are not evidence of native Auto.
 * @type {{ name: string, scene: () => Snapshot, text: string, color?: string, background?: string, tooltip: RegExp[], label: RegExp[] }[]}
 */
const DISPLAYS = [
  {
    name: 'off', scene: scenes.off, text: '$(coffee) @awake ready',
    tooltip: [/Mode: Off\./, /so your computer can sleep/, /Other apps may still keep it awake/, /Opening VS Code never turns this on/, /Auto - Copilot activity is unavailable in this build/],
    label: [/Off\. Your computer can sleep/]
  },
  {
    name: 'starting', scene: () => scenes.starting(0), text: '$(sync~spin) Keep Awake: Starting...',
    tooltip: [/Mode: Keep awake\. Starting\./, /not confirmed yet/, /not protected/],
    label: [/Keep awake is starting/, /not confirmed/]
  },
  {
    name: 'confirmed until off', scene: () => scenes.manualOn(0), text: '$(coffee)', color: GREEN,
    tooltip: [/Mode: Keep awake\. On, confirmed\./, /until you turn it off or close this window/, /No expiry timer is running/, /Off never cancels Copilot/],
    label: [/Keep awake is on and confirmed/, /until you turn it off/, /being kept awake/]
  },
  {
    name: 'confirmed Auto', scene: scenes.autoOn, text: '$(coffee)', color: GREEN,
    tooltip: [/Mode: Auto - Copilot activity\. On, confirmed\./, /2 tracked/, /Harness: VS Code Local\/Copilot/],
    label: [/Auto - Copilot activity is on and confirmed/]
  },
  {
    name: 'failed', scene: () => scenes.failed('helper is missing'), text: '$(warning) Keep Awake: Failed', background: 'statusBarItem.errorBackground',
    tooltip: [/Mode: Keep awake\. Failed\./, /your computer can sleep/i, /Error: helper is missing/, /Off, then Keep awake to try again/],
    label: [/Keep awake failed\. Your computer can sleep/]
  },
  {
    name: 'unverified', scene: () => scenes.unverified(0), text: '$(warning) Keep Awake: Unverified', background: 'statusBarItem.warningBackground',
    tooltip: [/Mode: Keep awake\. Unverified\./, /has not confirmed/, /may not prevent sleep/],
    label: [/Keep awake is unverified/, /has not confirmed/]
  },
  {
    name: 'Auto unavailable', scene: scenes.autoUnavailable, text: '$(warning) Auto: Unavailable', background: 'statusBarItem.warningBackground',
    tooltip: [/Mode: Auto - Copilot activity\. Unavailable\./, new RegExp(escapeRegExp(AUTO_REASON)), /Nothing is keeping your computer awake/, /Keep awake instead/],
    label: [/Auto is unavailable\. Your computer can sleep/, /Keep awake/]
  },
  {
    name: 'Auto waiting', scene: scenes.autoWaiting, text: '$(coffee) Auto: Waiting',
    tooltip: [/Mode: Auto - Copilot activity\. Waiting\./, /no sleep request is held yet/, /already running are not covered/],
    label: [/Auto is waiting for Copilot activity/, /Nothing is protecting your computer/]
  },
  {
    name: 'Auto limited', scene: scenes.autoLimited, text: '$(warning) Auto: Limited', background: 'statusBarItem.warningBackground',
    tooltip: [/Mode: Auto - Copilot activity\. Limited\./, /some cases are not covered/],
    label: [/Auto has limited coverage/]
  }
];

for (const display of DISPLAYS) {
  test(`status display: ${display.name}`, () => {
    const f = fixture({ platform: 'linux' });
    try {
      f.coordinator.show(display.scene());
      const view = f.view();
      assert.equal(view.text, display.text);
      assert.equal(view.color, display.color, 'only a confirmed hold is green');
      assert.equal(view.background, display.background);
      assert.equal(view.role, 'button');
      for (const pattern of display.tooltip) assert.match(view.tooltip, pattern, 'tooltip');
      for (const pattern of display.label) assert.match(view.label, pattern, 'screen-reader label');
      assert.equal(f.status.command, 'agentKeepAwake.selectMode');
    } finally { f.dispose(); }
  });
}

test('green requires state.confirmed, never a mode, state name or desired hold alone', () => {
  const f = fixture();
  try {
    for (const scene of [
      { ...scenes.manualOn(), confirmed: false },
      { ...scenes.manualOn(), confirmed: false, state: 'starting' },
      { ...scenes.autoWaiting(), desired: true },
      scenes.unverified(0),
      { ...scenes.off(), state: 'mystery' }
    ]) {
      f.coordinator.show(scene);
      assert.equal(f.view().color, undefined, `${scene.mode}/${scene.state}`);
      assert.notEqual(f.view().text, '$(coffee)', `${scene.mode}/${scene.state}`);
    }
    f.coordinator.show({ ...scenes.autoLimited(), confirmed: true, desired: true });
    assert.equal(f.view().color, GREEN, 'a confirmed hold is green even with limited coverage');
    assert.match(f.view().tooltip, /limited/i);
  } finally { f.dispose(); }
});

test('a timed hold names its deadline and a coordinator notice is shown', () => {
  const f = fixture();
  try {
    const scene = scenes.manualOn(HOUR_MS);
    f.coordinator.show({ ...scene, notice: PRESERVED_NOTICE });
    const when = new Date(scene.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    assert.ok(f.view().tooltip.includes(`until ${when}`), f.view().tooltip);
    assert.doesNotMatch(f.view().tooltip, /No expiry timer is running|until you turn it off/);
    assert.match(f.view().label, new RegExp(`until ${escapeRegExp(when)}`));
    assert.ok(f.view().tooltip.includes(`Notice: ${PRESERVED_NOTICE}`), f.view().tooltip);
  } finally { f.dispose(); }
});

test('a notice that repeats the explanation already shown is not printed twice', () => {
  const f = fixture();
  try {
    f.coordinator.show(scenes.autoUnavailable());
    assert.equal(f.view().tooltip.split(AUTO_REASON).length - 1, 1, f.view().tooltip);
    assert.doesNotMatch(f.view().tooltip, /Notice:/);
  } finally { f.dispose(); }
});

test('Auto names its harness and, when tracking, the safeguard deadline for tracked work', () => {
  const f = fixture();
  try {
    for (const scene of [scenes.autoUnavailable(), scenes.autoWaiting(), scenes.autoLimited()]) {
      f.coordinator.show(scene);
      assert.match(f.view().tooltip, /Harness: VS Code Local\/Copilot/, `${scene.state}`);
    }
    const tracking = { ...scenes.autoOn(), expiresAt: Date.now() + 24 * HOUR_MS };
    f.coordinator.show(tracking);
    const when = new Date(tracking.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    assert.match(f.view().tooltip, /Harness: VS Code Local\/Copilot/);
    assert.ok(f.view().tooltip.includes(`Safeguard: protection for tracked work stops by ${when}`), f.view().tooltip);
    assert.match(f.view().tooltip, /work may still be running/);
    f.coordinator.show(scenes.manualOn(0));
    assert.doesNotMatch(f.view().tooltip, /Harness|Safeguard/, 'Keep awake is not tied to any harness');
  } finally { f.dispose(); }
});

test('Windows boundaries are explicit, and absent on other platforms', () => {
  const windows = fixture({ platform: 'win32' });
  const linux = fixture({ platform: 'linux' });
  try {
    for (const scene of [scenes.off(), scenes.manualOn(0), scenes.starting(0)]) {
      windows.coordinator.show(scene);
      linux.coordinator.show(scene);
      assert.match(windows.view().tooltip, /On Windows, protection also keeps the screen on/, `${scene.state}`);
      assert.match(windows.view().tooltip, /Modern Standby/);
      assert.match(windows.view().tooltip, /AC power/);
      assert.match(windows.view().tooltip, /lid.*power button.*Sleep.*policy/);
      assert.doesNotMatch(linux.view().tooltip, /Windows|screen|Modern Standby/i, `${scene.state}`);
    }
  } finally { windows.dispose(); linux.dispose(); }
});

test('selecting Auto while it is unavailable and Keep awake is on keeps the hold and says so', async () => {
  const f = fixture();
  try {
    await f.run('keepAwake');
    const before = plain(f.api.getState());
    assert.equal(await f.run('autoMode'), false);
    assert.deepEqual(f.coordinator.calls, ['manual:0', 'auto'], 'Auto is attempted and Off is never called');
    const after = f.api.getState();
    assert.equal(after.mode, 'manual');
    assert.equal(after.confirmed, true);
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.generation, before.generation);
    assert.equal(f.view().color, GREEN, 'the preserved hold stays visible');
    const toast = f.messages[f.messages.length - 1];
    assert.equal(toast.level, 'warn');
    assert.match(toast.text, /Auto - Copilot activity is unavailable/);
    assert.ok(toast.text.includes(AUTO_REASON));
    assert.match(toast.text, /Keep awake is still on and was not changed/);
    assert.match(toast.text, /Turn Off/);
    assert.ok(f.view().tooltip.includes(`Notice: ${PRESERVED_NOTICE}`), f.view().tooltip);
  } finally { f.dispose(); }
});

test('selecting unavailable Auto from Off explains it, shows a non-green warning and fabricates nothing', async () => {
  const f = fixture();
  try {
    f.choose(2);
    await f.run('selectMode');
    assert.deepEqual(f.coordinator.calls, ['auto'], 'no manual hold and no helper is requested');
    assert.deepEqual(f.backend.calls, []);
    const toast = f.messages[f.messages.length - 1];
    assert.equal(toast.level, 'warn');
    assert.match(toast.text, /Auto - Copilot activity is unavailable/);
    assert.ok(toast.text.includes(AUTO_REASON));
    assert.match(toast.text, /Nothing is keeping your computer awake/);
    assert.equal(f.view().text, '$(warning) Auto: Unavailable');
    assert.equal(f.view().color, undefined);
    await f.run('turnOff');
    assert.equal(f.view().text, '$(coffee) @awake ready', 'Off is always reachable from the warning');
  } finally { f.dispose(); }
});

test('after an unavailable Auto attempt the status item stays actionable: Keep awake and Off are one pick away', async () => {
  const f = fixture({ showStatusBarItem: false });
  try {
    f.choose(2);
    await f.run('selectMode');
    assert.equal(f.view().text, '$(warning) Auto: Unavailable');
    assert.equal(f.status.command, 'agentKeepAwake.selectMode', 'the warning still opens the picker');
    f.choose(undefined);
    await f.run('selectMode');
    const items = f.picks[f.picks.length - 1].items;
    assert.match(String(items[2].description), /Current/, 'the picker shows Auto as the selected mode');
    f.choose(1);
    await f.run('selectMode');
    assert.equal(f.api.getState().mode, 'manual');
    assert.equal(f.view().color, GREEN, 'Keep awake works straight from the Auto warning');
    f.choose(2);
    await f.run('selectMode');
    assert.equal(f.api.getState().mode, 'manual', 'a second Auto attempt does not drop the hold');
    f.choose(0);
    await f.run('selectMode');
    assert.equal(f.api.getState().mode, 'off', 'Off works with the status item hidden');
    assert.deepEqual(f.coordinator.calls, ['auto', 'manual:0', 'auto', 'off']);
  } finally { f.dispose(); }
});

test('display only: an armed Auto raises no unavailable warning and shows Auto: Waiting (no native Auto exists in this build)', async () => {
  const f = fixture();
  try {
    f.coordinator.autoResult = true;
    assert.equal(await f.run('autoMode'), true);
    assert.deepEqual(f.messages, []);
    assert.equal(f.view().text, '$(coffee) Auto: Waiting');
    assert.equal(f.view().color, undefined);
  } finally { f.dispose(); }
});

test('explanatory toasts never block the command that raised them', async () => {
  const f = fixture();
  try {
    f.answerToastsWith(() => new Promise(() => { /* the user never dismisses it */ }));
    assert.equal(await completesPromptly(f.run('autoMode')), true, 'autoMode');
    assert.equal(await completesPromptly(f.run('showStatus')), true, 'showStatus');
    f.coordinator.startBehavior = 'fail';
    assert.equal(await completesPromptly(f.run('keepAwake')), true, 'a failed start');
  } finally { f.dispose(); }
});

test('Keep awake works in Restricted Mode and Auto stays unavailable there', async () => {
  const f = fixture({ trusted: false });
  try {
    assert.equal(await f.run('keepAwake'), true);
    assert.deepEqual(f.messages, [], 'no trust prompt or error for the fixed local power request');
    assert.equal(f.view().color, GREEN);
    assert.equal(await f.run('autoMode'), false);
    assert.equal(f.api.getState().mode, 'manual');
    assert.deepEqual(f.coordinator.calls, ['manual:0', 'auto']);
  } finally { f.dispose(); }
});

test('a coordinator failure is shown once, visibly, with the reason and without a green icon', async () => {
  const f = fixture();
  try {
    f.coordinator.startBehavior = 'fail';
    assert.equal(await f.run('keepAwake'), false);
    assert.equal(f.view().text, '$(warning) Keep Awake: Failed');
    assert.equal(f.view().color, undefined);
    assert.deepEqual(f.messages.map(m => m.level), ['error']);
    assert.match(f.messages[0].text, /Keep Awake could not start\. Your computer can sleep\./);
    assert.match(f.messages[0].text, /Windows PowerShell \(powershell\.exe\) was not found\./);

    f.coordinator.startBehavior = 'throw';
    assert.equal(await f.run('keepAwake'), false, 'a rejected start does not reject the command');
    assert.match(f.messages[1].text, /Keep Awake could not start\. Your computer can sleep\. helper exploded/);
    await f.run('turnOff');
    assert.equal(f.view().text, '$(coffee) @awake ready', 'Off recovers from Failed');
  } finally { f.dispose(); }
});

test('an unverified start is a visible warning, not an error dialog and not green', async () => {
  const f = fixture({ platform: 'linux' });
  try {
    f.coordinator.startBehavior = 'unverified';
    assert.equal(await f.run('keepAwake'), false);
    assert.equal(f.view().text, '$(warning) Keep Awake: Unverified');
    assert.equal(f.view().color, undefined);
    assert.deepEqual(f.messages, []);
    assert.equal(f.api.getState().confirmed, false);
  } finally { f.dispose(); }
});

test('the status item follows every coordinator change without polling', () => {
  const f = fixture();
  try {
    for (const [scene, text] of /** @type {[Snapshot, string][]} */ ([
      [scenes.starting(0), '$(sync~spin) Keep Awake: Starting...'],
      [scenes.manualOn(0), '$(coffee)'],
      [scenes.failed(), '$(warning) Keep Awake: Failed'],
      [scenes.off(), '$(coffee) @awake ready']
    ])) {
      f.coordinator.show(scene);
      assert.equal(f.view().text, text);
    }
    assert.deepEqual(f.timers, { timeouts: 0, intervals: 0 });
  } finally { f.dispose(); }
});

test('Show Status summarises the mode and protection, and its Show Log action opens the log', async () => {
  const f = fixture({ platform: 'win32' });
  try {
    f.answerToastsWith(toast => toast.actions[0]);
    await f.run('keepAwake');
    await f.run('showStatus');
    await f.flush();
    const toast = f.messages[f.messages.length - 1];
    assert.equal(toast.level, 'info');
    assert.match(toast.text, /Mode: Keep awake\. On, confirmed\./);
    assert.match(toast.text, /screen on/);
    assert.deepEqual(toast.actions, ['Show Log']);
    assert.equal(f.logShown, 1);
    await f.run('showLog');
    assert.equal(f.logShown, 2);
  } finally { f.dispose(); }
});

test('Configure Duration opens the extension setting', async () => {
  const f = fixture();
  try {
    await f.run('openSettings');
    assert.deepEqual(f.executed, [['workbench.action.openSettings', '@ext:apkola29.agent-keep-awake duration']]);
  } finally { f.dispose(); }
});

test('getState merges the sanitized coordinator snapshot with status, version and display fields', () => {
  const f = fixture({ platform: 'win32', version: '1.1.0' });
  try {
    f.coordinator.show({
      ...scenes.manualOn(), pids: [11, 12], helpers: ['powershell'], notice: 'a notice',
      capability: 'SECRET-CAPABILITY', endpoint: '\\\\.\\pipe\\secret-endpoint'
    });
    assert.deepEqual(plain(f.api.getState()), {
      supported: true, version: '1.1.0', keepsDisplayOn: true,
      mode: 'manual', state: 'on', desired: true, confirmed: true, ownerCount: 1, generation: 1,
      instanceId: 'instance-under-test', durationMs: 0, expiresAt: 0, error: '', notice: 'a notice',
      auto: { status: 'unavailable', harness: 'VS Code Local/Copilot', reason: AUTO_REASON },
      backendState: 'on', pids: [11, 12], helpers: ['powershell'],
      statusText: '$(coffee)', statusColor: GREEN
    });
    const state = f.api.getState();
    state.pids.push(99);
    state.helpers.length = 0;
    state.auto.reason = 'tampered';
    assert.deepEqual(f.coordinator.snapshot.pids, [11, 12], 'callers receive copies');
    assert.deepEqual(f.coordinator.snapshot.helpers, ['powershell']);
    assert.equal(f.coordinator.snapshot.auto.reason, AUTO_REASON);
  } finally { f.dispose(); }
});

test('getState reports Off with an undefined status color and falls back to safe values for odd coordinator data', () => {
  const f = fixture({ platform: 'linux' });
  try {
    const idle = f.api.getState();
    assert.equal(idle.supported, true);
    assert.equal(idle.keepsDisplayOn, false);
    assert.equal(idle.mode, 'off');
    assert.equal(idle.statusText, '$(coffee) @awake ready');
    assert.equal(idle.statusColor, undefined);

    f.coordinator.show({ expiresAt: /** @type {any} */ (null), error: /** @type {any} */ (undefined), pids: /** @type {any} */ ('x'), helpers: /** @type {any} */ (null) });
    const odd = f.api.getState();
    assert.equal(odd.expiresAt, 0);
    assert.equal(odd.error, '');
    assert.deepEqual(plain(odd.pids), []);
    assert.deepEqual(plain(odd.helpers), []);
  } finally { f.dispose(); }
});

test('the extension API is only getState and the two test aliases for manual and off', async () => {
  const f = fixture();
  try {
    assert.deepEqual(Object.keys(f.api).sort(), ['getState', 'startKeepAwake', 'stopKeepAwake']);
    assert.equal(await f.api.startKeepAwake(90_000), true);
    assert.equal(f.api.getState().durationMs, 90_000);
    f.api.stopKeepAwake();
    assert.deepEqual(f.coordinator.calls, ['manual:90000', 'off']);
    assert.equal(await f.api.startKeepAwake(0), true);
    assert.deepEqual(f.coordinator.calls.slice(-1), ['manual:0']);
  } finally { f.dispose(); }
});

test('disposal releases the coordinator before the status item and log, and later changes are ignored', () => {
  const f = fixture();
  f.dispose();
  assert.deepEqual(f.order, ['coordinator', 'status', 'log']);
  assert.deepEqual(f.coordinator.calls, ['dispose'], 'unsubscribing never calls the shadowed EventEmitter.off alias');
  f.status.text = 'sentinel';
  f.coordinator.emit('change', scenes.manualOn(0));
  assert.equal(f.status.text, 'sentinel', 'the closed status item is not rendered again');
});

test('hiding the status item is a setting change only, and showing it again restores it', () => {
  const f = fixture({ showStatusBarItem: false });
  try {
    assert.equal(f.status.visible, false);
    assert.deepEqual(f.coordinator.calls, []);
    f.setConfig('showStatusBarItem', true);
    assert.equal(f.status.visible, true);
  } finally { f.dispose(); }
});

const REAL = { skip: fs.existsSync(COORDINATOR_FILE) ? false : 'src/activityCoordinator.js has not been delivered yet' };

test('with the real coordinator the frontend wiring starts Off, holds once, preserves Manual on Auto and releases on Off', REAL, async () => {
  const f = fixture({ platform: 'win32', realCoordinator: true });
  try {
    assert.equal(f.backend.calls.length, 0, 'startup holds nothing');
    assert.equal(f.api.getState().mode, 'off');
    assert.equal(f.api.getState().confirmed, false);
    assert.equal(await f.run('keepAwake'), true);
    assert.deepEqual(f.backend.calls.filter(c => c.call === 'acquire'), [{ call: 'acquire', display: true }],
      'one acquire that requests the Windows display hold');
    const held = f.api.getState();
    assert.equal(held.mode, 'manual');
    assert.equal(held.confirmed, true);
    assert.equal(held.expiresAt, 0);
    assert.equal(f.view().color, GREEN);
    assert.equal(await f.run('autoMode'), false);
    const preserved = f.api.getState();
    assert.equal(preserved.mode, 'manual');
    assert.equal(preserved.confirmed, true);
    assert.equal(preserved.generation, held.generation);
    assert.equal(preserved.auto.status, 'unavailable');
    assert.equal(preserved.auto.reason, AUTO_REASON);
    assert.match(String(preserved.notice), /\S/, 'the coordinator explains the preserved hold');
    assert.equal(f.backend.calls.filter(c => c.call === 'acquire').length, 1);
    await f.run('turnOff');
    assert.equal(f.api.getState().mode, 'off');
    assert.equal(f.backend.calls[f.backend.calls.length - 1].call, 'release');
    assert.equal(f.view().text, '$(coffee) @awake ready');
    await f.run('autoMode');
    assert.equal(f.view().text, '$(warning) Auto: Unavailable');
    assert.equal(f.backend.calls.filter(c => c.call === 'acquire').length, 1, 'unavailable Auto from Off requests no power');
  } finally {
    f.dispose();
    assert.equal(f.backend.state, 'off', 'disposing the coordinator releases the backend');
  }
});

test('with the real coordinator rapid Keep awake clicks share one native acquisition', REAL, async () => {
  const f = fixture({ platform: 'win32', realCoordinator: true });
  try {
    assert.deepEqual(await Promise.all([f.run('keepAwake'), f.run('keepAwake'), f.run('keepAwake')]), [true, true, true]);
    assert.equal(f.backend.calls.filter(c => c.call === 'acquire').length, 1, 'one helper, however many clicks');
    assert.equal(f.api.getState().ownerCount, 1);
  } finally { f.dispose(); }
});

test('with the real coordinator a timed command carries its deadline and a setting change leaves it alone', REAL, async () => {
  const f = fixture({ platform: 'win32', realCoordinator: true, durationHours: 2 });
  try {
    const before = Date.now();
    await f.run('toggleSession');
    const held = f.api.getState();
    assert.equal(held.mode, 'manual');
    assert.equal(held.confirmed, true);
    assert.equal(held.durationMs, 2 * HOUR_MS);
    assert.ok(held.expiresAt >= before + 2 * HOUR_MS && held.expiresAt <= Date.now() + 2 * HOUR_MS, String(held.expiresAt));
    assert.ok(f.view().tooltip.includes(`until ${new Date(held.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`));
    f.setConfig('durationHours', 4);
    assert.equal(f.api.getState().expiresAt, held.expiresAt);
    assert.equal(f.api.getState().generation, held.generation);
    await f.run('toggleSession');
    const off = f.api.getState();
    assert.equal(off.mode, 'off');
    assert.equal(off.expiresAt, 0);
    assert.equal(f.backend.calls[f.backend.calls.length - 1].call, 'release');
  } finally { f.dispose(); }
});

test('with the real coordinator a missing helper is a visible Failed state that Off clears', REAL, async () => {
  const f = fixture({ platform: 'win32', realCoordinator: true });
  try {
    f.backend.failWith = 'Windows PowerShell (powershell.exe) was not found.';
    assert.equal(await f.run('keepAwake'), false);
    assert.equal(f.api.getState().state, 'failed');
    assert.equal(f.view().text, '$(warning) Keep Awake: Failed');
    assert.equal(f.view().color, undefined);
    assert.match(f.view().tooltip, /Error: Windows PowerShell \(powershell\.exe\) was not found\./);
    assert.deepEqual(f.messages.map(m => m.level), ['error']);
    assert.match(f.messages[0].text, /Keep Awake could not start\. Your computer can sleep\. Windows PowerShell/);
    await f.run('turnOff');
    assert.equal(f.api.getState().mode, 'off');
    assert.equal(f.view().text, '$(coffee) @awake ready');
  } finally { f.dispose(); }
});

test('with the real coordinator a macOS or Linux hold stays Unverified: a warning, never green, never an error dialog', REAL, async () => {
  const f = fixture({ platform: 'linux', realCoordinator: true });
  try {
    assert.equal(await f.run('keepAwake'), false, 'only a native acknowledgement counts as success');
    const state = f.api.getState();
    assert.equal(state.state, 'unverified');
    assert.equal(state.desired, true);
    assert.equal(state.confirmed, false);
    assert.equal(f.view().text, '$(warning) Keep Awake: Unverified');
    assert.equal(f.view().color, undefined);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.backend.calls.filter(c => c.call === 'acquire'), [{ call: 'acquire', display: false }]);
    await f.run('turnOff');
    assert.equal(f.view().text, '$(coffee) @awake ready');
  } finally { f.dispose(); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const models = Array.from({ length: 8 }, (_, i) => ({
    model: `model-${i + 1}`, totalTokens: (i + 1) * 1000, totalCredits: (8 - i) * 10,
    estCredits: i === 0 ? 5 : 0, inputTokens: (i + 1) * 900, outputTokens: (i + 1) * 100,
    cacheReadTokens: 0, calls: i + 1, pendingCalls: 0, sources: ['cli'], byTool: { 'Copilot agent / CLI': (8 - i) * 10 },
  }));
  return {
    provider: 'githubCopilot', cycle: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    sortBy: 'tokens', models, totals: { totalTokens: 36000, totalCredits: 360, estCredits: 5, calls: 36 },
    diagnostics: { errors: [], notes: [] },
  };
}

function emitter() {
  const handlers = new Set();
  return {
    listen: (handler) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    async fire(value) { for (const handler of [...handlers]) await handler(value); },
    get count() { return handlers.size; },
  };
}

function harness(result = fixture()) {
  const commands = new Map();
  const picks = [];
  const statusItems = [];
  const errors = [];
  const logs = [];
  const sessions = emitter();
  const configuration = emitter();
  const settings = { provider: 'githubCopilot', cycleResetDay: 1, sortBy: 'tokens', claudeConfigDirs: [] };
  const storage = new Map();
  let scans = 0;
  let failure;
  let delayedScan;
  let disposedWorkers = 0;
  class WorkerClient {
    run() {
      scans += 1;
      if (failure) return Promise.reject(failure);
      return delayedScan ? delayedScan : Promise.resolve(result);
    }
    stop() { return Promise.resolve(); }
    dispose() { disposedWorkers += 1; return Promise.resolve(); }
  }
  class QuickPick {
    constructor() {
      this.items = [];
      this.selectedItems = [];
      this.visible = false;
      this.disposed = false;
      this.triggerButton = emitter();
      this.accept = emitter();
      this.hidden = emitter();
      picks.push(this);
    }
    onDidTriggerButton(fn) { return this.triggerButton.listen(fn); }
    onDidAccept(fn) { return this.accept.listen(fn); }
    onDidHide(fn) { return this.hidden.listen(fn); }
    show() { this.visible = true; }
    hide() { this.visible = false; this.hidden.fire(); }
    dispose() { this.disposed = true; }
  }
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    window: {
      createStatusBarItem(id, alignment, priority) {
        const item = { id, alignment, priority, visible: false, show() { this.visible = true; }, dispose() { this.visible = false; } };
        statusItems.push(item);
        return item;
      },
      createQuickPick: () => new QuickPick(),
      createOutputChannel: () => ({ appendLine: (message) => logs.push(message), dispose() {} }),
      showErrorMessage: (message) => { errors.push(message); return Promise.resolve(); },
      showInformationMessage: () => Promise.resolve(),
      setStatusBarMessage: () => ({ dispose() {} }),
      registerWebviewViewProvider: () => { throw new Error('Compact activation must not register a docked panel'); },
      createWebviewPanel: () => { throw new Error('Compact action must not open an editor dashboard'); },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => settings[key] ?? fallback,
        update: async (key, value) => { settings[key] = value; },
      }),
      onDidChangeConfiguration: (fn) => configuration.listen(fn),
    },
    authentication: {
      getAccounts: async () => [],
      onDidChangeSessions: (fn) => sessions.listen(fn),
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    env: { clipboard: { writeText: async () => {} } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension.js'), 'utf8'), {
    module,
    exports: module.exports,
    __dirname: root,
    require: (id) => id === 'vscode' ? vscode : id === './lib/worker-client'
      ? { UsageWorkerClient: WorkerClient } : id.startsWith('./') ? require(path.join(root, id)) : require(id),
    console, setTimeout, clearTimeout,
  }, { filename: 'extension.js' });
  const context = {
    globalStorageUri: { scheme: 'file', authority: '', fsPath: path.join(os.tmpdir(), 'aucm-ui-test', 'User', 'globalStorage', 'tracker') },
    globalState: { get: (key) => storage.get(key), update: async (key, value) => { storage.set(key, value); } },
    subscriptions: [],
  };
  module.exports.activate(context);
  return {
    commands, picks, statusItems, errors, logs, settings,
    get scans() { return scans; },
    get disposedWorkers() { return disposedWorkers; },
    fail(error) { failure = error; },
    delay(promise) { delayedScan = promise; },
    async settle() { for (let i = 0; i < 4; i++) await tick(); },
    async dispose() {
      await module.exports.deactivate();
      for (const subscription of context.subscriptions) subscription.dispose();
    },
  };
}

test('default UI is an untrusted native hover with only the top five models, not a docked panel', async () => {
  const h = harness();
  try {
    await h.settle();
    const item = h.statusItems[0];
    assert.equal(item.visible, true);
    assert.equal(item.command, 'aiUsageCreditsMeter.show');
    assert.equal(item.accessibilityInformation.label, 'GH Copilot Usage Tracker');
    assert.match(item.text, /Copilot/);
    assert.match(item.text, /360 credits/);
    assert.equal(item.tooltip.isTrusted, false);
    assert.equal(item.tooltip.supportHtml, false);
    assert.match(item.tooltip.value, /GitHub Copilot/);
    assert.match(item.tooltip.value, /Highest-used model/);
    assert.match(item.tooltip.value, /model-1/);
    assert.doesNotMatch(item.tooltip.value, /model-6/);
    assert.match(item.tooltip.value, /not an account-wide bill/);
  } finally { await h.dispose(); }
});

test('click opens a small popup with close, focus-loss dismissal and reusable cached summary', async () => {
  const h = harness();
  try {
    await h.settle();
    const shown = await h.commands.get('aiUsageCreditsMeter.show')();
    const pick = h.picks[0];
    assert.equal(pick.visible, true);
    assert.equal(pick.ignoreFocusOut, false);
    assert.equal(pick.items.length, 6);
    assert.equal(pick.items[0].label, '1. model-8');
    assert.equal(pick.items[5].expand, true);
    assert.ok(pick.buttons.some((b) => b.iconPath.id === 'close'));
    assert.match(shown.title, /360 credits/);
    assert.match(shown.title, /^GH Copilot Usage Tracker/);
    assert.equal(h.scans, 1, 'click reuses the startup summary instead of creating another scan');
    await h.commands.get('aiUsageCreditsMeter.show')();
    assert.equal(h.picks.length, 1, 'repeated clicks do not leak popups');
    await pick.triggerButton.fire(pick.buttons.find((b) => b.iconPath.id === 'close'));
    assert.equal(pick.visible, false);
    assert.equal(pick.disposed, true);
    assert.equal(pick.triggerButton.count, 0);
    assert.equal(pick.accept.count, 0);
    assert.equal(pick.hidden.count, 0);
    await h.commands.get('aiUsageCreditsMeter.show')();
    assert.equal(h.picks.length, 2);
    h.picks[1].hide();
    assert.equal(h.picks[1].disposed, true);
  } finally { await h.dispose(); }
});

test('popup sort and optional expansion stay in the compact UI and do not reread the usage stores', async () => {
  const h = harness();
  try {
    await h.settle();
    await h.commands.get('aiUsageCreditsMeter.show')();
    const pick = h.picks[0];
    await pick.triggerButton.fire(pick.buttons.find((b) => b.iconPath.id === 'arrow-swap'));
    assert.equal(pick.items[0].label, '1. model-1');
    pick.selectedItems = [pick.items.find((item) => item.expand)];
    await pick.accept.fire();
    assert.equal(pick.visible, true);
    assert.equal(pick.items.length, 8);
    assert.equal(h.scans, 1);
    assert.equal(h.errors.length, 0);
  } finally { await h.dispose(); }
});

test('untrusted model text in a hover cannot create markdown links or HTML', async () => {
  const result = fixture();
  result.models[0].model = 'unsafe|<img> [run](command:execute)';
  const h = harness(result);
  try {
    await h.settle();
    const tooltip = h.statusItems[0].tooltip;
    assert.equal(tooltip.isTrusted, false);
    assert.equal(tooltip.supportHtml, false);
    assert.doesNotMatch(tooltip.value, /unsafe\|<img>|\[run\]\(command:/);
    assert.ok(tooltip.value.includes('unsafe\\|\\<img\\>'));
  } finally { await h.dispose(); }
});

test('closing a loading popup prevents late updates and deactivation releases it and the worker', async () => {
  const h = harness();
  try {
    await h.settle();
    let finish;
    h.delay(new Promise((resolve) => { finish = resolve; }));
    const refreshing = h.commands.get('aiUsageCreditsMeter.refresh')();
    await tick();
    const opening = h.commands.get('aiUsageCreditsMeter.show')();
    await tick();
    const pick = h.picks[0];
    pick.hide();
    finish(fixture());
    await refreshing;
    await opening;
    assert.equal(pick.disposed, true);
    assert.deepEqual(pick.items, []);
  } finally {
    await h.dispose();
    assert.equal(h.disposedWorkers, 1);
    assert.equal(h.statusItems[0].visible, false);
  }
});

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

function claudeSection({ transcripts = 3, count = 6, errors = [] } = {}) {
  const models = Array.from({ length: count }, (_, i) => ({
    model: `claude-model-${i + 1}`, totalTokens: (i + 1) * 2000000, totalCredits: (i + 1) * 150, estCredits: 0,
    inputTokens: (i + 1) * 1900000, outputTokens: (i + 1) * 100000, cacheReadTokens: 0, calls: (i + 1) * 10,
    pendingCalls: 0, sources: ['claude'], byTool: { 'Claude Code': (i + 1) * 150 },
  }));
  const sum = (key) => models.reduce((total, m) => total + m[key], 0);
  return {
    provider: 'claudeCode', cycle: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    sortBy: 'tokens', models,
    totals: { totalTokens: sum('totalTokens'), totalCredits: sum('totalCredits'), estCredits: 0, calls: sum('calls') },
    diagnostics: { errors, notes: [], claudeTranscripts: transcripts },
  };
}

function bothFixture(options = {}) {
  const copilot = options.copilot || fixture();
  return {
    provider: 'both', cycle: copilot.cycle, sortBy: 'tokens',
    githubCopilot: copilot,
    claudeCode: options.claude || claudeSection(options),
  };
}

function harness(result = fixture(), options = {}) {
  const commands = new Map();
  const picks = [];
  const statusItems = [];
  const errors = [];
  const logs = [];
  const copied = [];
  const runs = [];
  const panels = [];
  const sessions = emitter();
  const configuration = emitter();
  const settings = { provider: 'githubCopilot', cycleResetDay: 1, sortBy: 'tokens', claudeConfigDirs: [], ...options.settings };
  const storage = new Map();
  let scans = 0;
  let accountLookups = 0;
  let failure;
  let delayedScan;
  let disposedWorkers = 0;
  class WorkerClient {
    run(opts) {
      scans += 1;
      runs.push(opts);
      if (failure) return Promise.reject(failure);
      if (options.respond) return Promise.resolve().then(() => options.respond(opts));
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
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1 },
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
      showWarningMessage: () => Promise.resolve(),
      setStatusBarMessage: () => ({ dispose() {} }),
      registerWebviewViewProvider: () => { throw new Error('Compact activation must not register a docked panel'); },
      createWebviewPanel: (id, title, column, panelOptions) => {
        if (!options.dashboard) throw new Error('Compact action must not open an editor dashboard');
        const panel = { id, title, panelOptions, webview: { html: '' } };
        panels.push(panel);
        return panel;
      },
      withProgress: (progressOptions, task) => task(),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => settings[key] ?? fallback,
        update: async (key, value) => { settings[key] = value; },
      }),
      onDidChangeConfiguration: (fn) => configuration.listen(fn),
    },
    authentication: {
      getAccounts: async () => { accountLookups += 1; return []; },
      onDidChangeSessions: (fn) => sessions.listen(fn),
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    env: { clipboard: { writeText: async (text) => { copied.push(text); } } },
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
    commands, picks, statusItems, errors, logs, settings, copied, runs, panels, configuration, sessions,
    get scans() { return scans; },
    get accountLookups() { return accountLookups; },
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

test('both providers: one untrusted hover lists Copilot credits and Claude Code tokens in separate sections', async () => {
  const h = harness(bothFixture(), { settings: { provider: 'both' } });
  try {
    await h.settle();
    assert.equal(h.runs[0].provider, 'both');
    assert.equal(h.scans, 1, 'both providers use one worker scan');
    const item = h.statusItems[0];
    assert.match(item.text, /Copilot/);
    assert.match(item.text, /360 credits/);
    assert.equal(item.tooltip.isTrusted, false);
    assert.equal(item.tooltip.supportHtml, false);
    const text = item.tooltip.value;
    assert.ok(text.indexOf('GitHub Copilot') < text.indexOf('Claude Code'));
    assert.match(text, /\| Highest-used model \| Credits \|/);
    assert.match(text, /\| Highest-used model \| Tokens \| API value \|/);
    assert.match(text, /\*\*42\.0M tokens\*\* · ≈\$31\.50 API value/);
    assert.match(text, /\| claude-model-6 \| 12\.0M \| ≈\$9\.00 \|/);
    assert.doesNotMatch(text, /claude-model-1(?!\d)/, 'only the five highest Claude models are listed');
    assert.doesNotMatch(text, /\| model-6 \|/, 'only the five highest Copilot models are listed');
    assert.match(text, /\n---\n/);
    assert.match(text, /API list-price estimates from local transcripts, not subscription charges or limits/);
    assert.match(text, /under-report output tokens, so treat them as a lower bound/);
    assert.match(text, /not an account-wide bill/);
  } finally { await h.dispose(); }
});

test('Claude Code is not listed when no local transcripts exist', async () => {
  const h = harness(bothFixture({ transcripts: 0, count: 0 }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    assert.doesNotMatch(h.statusItems[0].tooltip.value, /Claude/);
    await h.commands.get('aiUsageCreditsMeter.show')();
    const items = h.picks[0].items;
    assert.equal(items.length, 6);
    assert.ok(items.every((entry) => entry.kind === undefined), 'a single section has no separators');
  } finally { await h.dispose(); }
});

test('Claude Code becomes the primary view when Copilot has no usage', async () => {
  const copilot = fixture();
  copilot.models = [];
  copilot.totals = { totalTokens: 0, totalCredits: 0, estCredits: 0, calls: 0 };
  const h = harness(bothFixture({ copilot }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    const item = h.statusItems[0];
    assert.match(item.text, /Claude 42\.0M tokens/);
    assert.doesNotMatch(item.tooltip.value, /GitHub account|No GitHub sign-in/);
    assert.match(item.tooltip.value, /Local Claude Code transcripts on this device/);
    assert.doesNotMatch(item.tooltip.value, /Highest-used model \| Credits/);
  } finally { await h.dispose(); }
});

test('Claude-only provider shows tokens and API value without asking for a GitHub account', async () => {
  const h = harness(claudeSection(), { settings: { provider: 'claudeCode' } });
  try {
    await h.settle();
    assert.equal(h.runs[0].provider, 'claudeCode');
    assert.equal(h.accountLookups, 0);
    const item = h.statusItems[0];
    assert.match(item.text, /Claude 42\.0M tokens/);
    assert.match(item.tooltip.value, /Claude Code · Oct 1–Nov 1 UTC/);
    assert.match(item.tooltip.value, /≈\$31\.50 API value/);
    assert.doesNotMatch(item.tooltip.value, /GitHub account/);
  } finally { await h.dispose(); }
});

test('an unknown provider setting falls back to the combined default', async () => {
  const h = harness(bothFixture(), { settings: { provider: 'not-a-provider' } });
  try {
    await h.settle();
    assert.equal(h.runs[0].provider, 'both');
  } finally { await h.dispose(); }
});

test('popup groups rows by provider, expands both sections and copies a labelled Claude row', async () => {
  const h = harness(bothFixture(), { settings: { provider: 'both' } });
  try {
    await h.settle();
    const shown = await h.commands.get('aiUsageCreditsMeter.show')();
    const pick = h.picks[0];
    const rows = Array.from(pick.items, (entry) => (entry.kind === -1 ? `section:${entry.label}` : entry.label));
    assert.deepEqual(rows, [
      'section:GitHub Copilot', '1. model-8', '2. model-7', '3. model-6', '4. model-5', '5. model-4',
      'section:Claude Code · API list-price estimates',
      '1. claude-model-6', '2. claude-model-5', '3. claude-model-4', '4. claude-model-3', '5. claude-model-2',
      '$(list-unordered) Show all 14 models',
    ]);
    assert.match(shown.title, /^GH Copilot Usage Tracker · ≈360 credits · Claude 42\.0M tokens$/);
    assert.equal(pick.placeholder, 'GitHub Copilot + Claude Code · Oct 1–Nov 1 UTC · tokens · local history');
    assert.equal(h.scans, 1);

    pick.selectedItems = [pick.items.find((entry) => entry.expand)];
    await pick.accept.fire();
    assert.equal(pick.items.length, 16, 'two section headings plus all eight Copilot and six Claude models');
    assert.equal(h.scans, 1);

    pick.selectedItems = [pick.items.find((entry) => entry.label === '1. claude-model-6')];
    await pick.accept.fire();
    assert.deepEqual(h.copied, ['Claude Code 1. claude-model-6: 12.0M tokens · ≈$9.00 API value']);
    assert.equal(pick.visible, false);
  } finally { await h.dispose(); }
});

test('Claude Code read problems are labelled in the hover and counted in the popup', async () => {
  const h = harness(bothFixture({ errors: ['claude transcript x.jsonl: unreadable'] }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    assert.ok(h.statusItems[0].tooltip.value.includes('⚠ Partial data (Claude Code): claude transcript x\\.jsonl\\: unreadable'));
    await h.commands.get('aiUsageCreditsMeter.show')();
    assert.equal(h.picks[0].items[0].label, '$(warning) Partial data — 1 issue(s)');
  } finally { await h.dispose(); }
});

test('detailed dashboard renders each visible provider section and escapes untrusted model names', async () => {
  const result = bothFixture();
  result.claudeCode.models[0].model = '<script>alert(1)</script>';
  const h = harness(result, { settings: { provider: 'both' }, dashboard: true });
  try {
    await h.settle();
    await h.commands.get('aiUsageCreditsMeter.openDashboard')();
    const panel = h.panels[0];
    assert.equal(panel.panelOptions.enableScripts, false);
    assert.equal(panel.panelOptions.localResourceRoots.length, 0);
    assert.match(panel.webview.html, /<h2>GitHub Copilot<\/h2>/);
    assert.match(panel.webview.html, /<h2>Claude Code<\/h2>/);
    assert.match(panel.webview.html, /<th class="num">API value<\/th>/);
    assert.match(panel.webview.html, /GitHub Copilot \+ Claude Code/);
    assert.doesNotMatch(panel.webview.html, /<script>alert/);
    assert.match(panel.webview.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(panel.webview.html, /Content-Security-Policy/);
  } finally { await h.dispose(); }
});

test('Copilot stays listed beside a Claude Code section that has transcripts but no usage this cycle', async () => {
  const copilot = fixture();
  copilot.models = [];
  copilot.totals = { totalTokens: 0, totalCredits: 0, estCredits: 0, calls: 0 };
  copilot.diagnostics.notes = ['no Copilot CLI session store'];
  const h = harness(bothFixture({ copilot, claude: claudeSection({ transcripts: 3, count: 0 }) }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    const item = h.statusItems[0];
    assert.match(item.text, /Copilot 0 credits/, 'old Claude transcripts must not take over the status label');
    assert.match(item.tooltip.value, /GitHub Copilot · Oct 1–Nov 1 UTC/);
    assert.match(item.tooltip.value, /Claude Code · Oct 1–Nov 1 UTC/);
    assert.match(item.tooltip.value, /No usage recorded this cycle/);
  } finally { await h.dispose(); }
});

test('each section reports its own first problem so a Copilot note cannot hide a Claude Code error', async () => {
  const copilot = fixture();
  copilot.diagnostics.notes = ['no Copilot CLI session store'];
  const claude = claudeSection({ errors: ['claude transcript x.jsonl: unreadable'] });
  claude.diagnostics.notes = ['no list price for: claude-x (tokens counted, value unavailable)'];
  const h = harness(bothFixture({ copilot, claude }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    const text = h.statusItems[0].tooltip.value;
    assert.ok(text.includes('⚠ Partial data (GitHub Copilot): no Copilot CLI session store'));
    assert.ok(text.includes('⚠ Partial data (Claude Code): claude transcript x\\.jsonl\\: unreadable'), 'errors come before notes');
    assert.doesNotMatch(text, /no list price/, 'only the first problem of a section is shown in the hover');
    await h.commands.get('aiUsageCreditsMeter.show')();
    assert.equal(h.picks[0].items[0].label, '$(warning) Partial data — 3 issue(s)');
  } finally { await h.dispose(); }
});

test('a failing combined scan falls back to GitHub Copilot alone and reports Claude Code as unreadable', async () => {
  const copilot = fixture();
  const h = harness(copilot, {
    settings: { provider: 'both' },
    respond: (opts) => {
      if (opts.provider === 'both') throw new Error('Usage worker stopped unexpectedly (1)');
      return copilot;
    },
  });
  try {
    await h.settle();
    assert.deepEqual(Array.from(h.runs, (run) => run.provider), ['both', 'githubCopilot']);
    const item = h.statusItems[0];
    assert.match(item.text, /Copilot 360 credits/);
    assert.ok(item.tooltip.value.includes('⚠ Partial data (Claude Code): Claude Code usage could not be read in this scan'));
    assert.doesNotMatch(item.tooltip.value, /worker stopped/, 'internal error text and paths are not shown in the hover');
    assert.equal(h.errors.length, 0, 'the working Copilot result is shown instead of an error');
    await h.commands.get('aiUsageCreditsMeter.refresh')();
    assert.deepEqual(Array.from(h.runs, (run) => run.provider), ['both', 'githubCopilot', 'both', 'githubCopilot'],
      'a manual refresh tries the combined scan again');
  } finally { await h.dispose(); }
});

test('cancelled or rejected scans are not mistaken for a Claude Code failure', async () => {
  for (const message of ['GitHub sign-in changed; the previous usage scan was cancelled', 'Too many usage scans are pending; wait for the current scan']) {
    const h = harness(fixture(), { settings: { provider: 'both' }, respond: () => { throw new Error(message); } });
    try {
      await h.settle();
      await assert.rejects(h.commands.get('aiUsageCreditsMeter.refresh')(), new RegExp(message.slice(0, 12)));
      assert.ok(Array.from(h.runs).every((run) => run.provider === 'both'), `no Copilot-only retry for: ${message}`);
    } finally { await h.dispose(); }
  }
});

test('untrusted text is shortened, cannot autolink or render icons, and never shows local paths', async () => {
  const result = bothFixture();
  result.githubCopilot.models[0].model = 'https://evil%2Eexample/path';
  result.githubCopilot.models[7].model = '$(trash) icon';
  result.claudeCode.models[5].model = `long-${'x'.repeat(500)}`;
  result.githubCopilot.diagnostics.notes = ['no session store at C:\\Users\\Jane Doe\\OneDrive - Contoso\\.copilot\\session-store.db'];
  result.claudeCode.diagnostics.errors = ["claude transcript a.jsonl: EPERM, open 'C:\\Users\\Jane Doe\\.claude\\projects\\p\\a.jsonl'\n    at stack line"];
  const h = harness(result, { settings: { provider: 'both' } });
  try {
    await h.settle();
    const text = h.statusItems[0].tooltip.value;
    assert.doesNotMatch(text, /https:\/\//, 'a URL-like model name cannot become a link');
    assert.ok(text.includes('https\\://evil%2Eexample'));
    assert.doesNotMatch(text, /x{100}/, 'long model names are shortened');
    assert.doesNotMatch(text, /Jane|Users|Contoso|OneDrive|stack line/, 'local paths, user names and stack lines are not shown');
    assert.ok(text.includes('no session store at session-store\\.db'));
    assert.ok(text.includes("open 'a\\.jsonl'"));
    await h.commands.get('aiUsageCreditsMeter.show')();
    const labels = Array.from(h.picks[0].items, (item) => item.label);
    assert.ok(labels.some((label) => label.includes('\\$(trash) icon')), 'icon syntax in a model name is escaped');
    assert.ok(labels.every((label) => label.length < 120), 'popup labels are shortened');
  } finally { await h.dispose(); }
});

test('scan failures show one sanitised line, not a stack trace or a local path', async () => {
  const h = harness(fixture(), { settings: { provider: 'githubCopilot' } });
  try {
    await h.settle();
    h.fail(new Error("EPERM: open 'C:\\Users\\Jane Doe\\.copilot\\x.db'\n    at Object.open (node:fs:1:1)\n    at C:\\Users\\Jane Doe\\ext\\lib\\aggregate.js:1:1"));
    await assert.rejects(h.commands.get('aiUsageCreditsMeter.refresh')(), /EPERM/);
    assert.match(String(h.statusItems[0].tooltip), /EPERM/);
    for (const shown of [String(h.statusItems[0].tooltip), h.errors[0]]) {
      assert.doesNotMatch(shown, /Jane|Users|at Object/);
    }
  } finally { await h.dispose(); }
});

test('settings that are not the documented shape are ignored instead of reaching the worker', async () => {
  const absolute = path.join(os.tmpdir(), 'aucm-claude-config');
  const cases = [
    [{ provider: ['both'], claudeConfigDirs: { not: 'an array' } }, 'both', []],
    [{ provider: 5, claudeConfigDirs: 'C:\\single' }, 'both', []],
    [{ provider: 'both', claudeConfigDirs: [absolute, 'relative', 3, '', null] }, 'both', [absolute]],
    [{ provider: 'both', claudeConfigDirs: ['\\\\.\\pipe\\x', '\\\\?\\C:\\x', '//./x', '//?/x', absolute] }, 'both', [absolute]],
  ];
  for (const [settings, provider, dirs] of cases) {
    const h = harness(bothFixture(), { settings });
    try {
      await h.settle();
      assert.equal(h.runs[0].provider, provider);
      assert.deepEqual(Array.from(h.runs[0].claudeDirs), dirs);
    } finally { await h.dispose(); }
  }
});

test('the reset day and ranking settings are reduced to plain values the worker can receive', async () => {
  const cases = [
    [{ cycleResetDay: { evil: true }, sortBy: ['x'] }, 1, 'tokens'],
    [{ cycleResetDay: '15', sortBy: { toString: null } }, 1, 'tokens'],
    [{ cycleResetDay: 15.7, sortBy: 'credits' }, 15, 'credits'],
    [{ cycleResetDay: 99, sortBy: 'unknown' }, 28, 'tokens'],
    [{ cycleResetDay: 0, sortBy: 'tokens' }, 1, 'tokens'],
  ];
  for (const [settings, resetDay, sortBy] of cases) {
    const h = harness(bothFixture(), { settings: { provider: 'both', ...settings } });
    try {
      await h.settle();
      assert.equal(h.runs[0].resetDay, resetDay);
      assert.equal(h.runs[0].sortBy, sortBy);
      assert.doesNotThrow(() => structuredClone(h.runs[0]), 'the options survive the structured clone to the worker');
    } finally { await h.dispose(); }
  }
});

test('Claude Code models without a counted transcript still produce a section, never an empty view', async () => {
  const copilot = fixture();
  copilot.models = [];
  copilot.totals = { totalTokens: 0, totalCredits: 0, estCredits: 0, calls: 0 };
  const h = harness(bothFixture({ copilot, claude: claudeSection({ transcripts: 0, count: 2 }) }), { settings: { provider: 'both' } });
  try {
    await h.settle();
    const item = h.statusItems[0];
    assert.match(item.text, /Claude/);
    assert.match(item.tooltip.value, /Claude Code · Oct 1–Nov 1 UTC/);
    assert.equal(h.errors.length, 0);
    await h.commands.get('aiUsageCreditsMeter.show')();
    assert.ok(h.picks[0].items.some((entry) => entry.label === '1. claude-model-2'));
  } finally { await h.dispose(); }
});

test('a Claude Code section that could not be read is described as unavailable, not as empty', async () => {
  const copilot = fixture();
  const h = harness(copilot, {
    settings: { provider: 'both' }, dashboard: true,
    respond: (opts) => {
      if (opts.provider === 'both') throw new Error('Usage worker stopped unexpectedly (1)');
      return copilot;
    },
  });
  try {
    await h.settle();
    const text = h.statusItems[0].tooltip.value;
    assert.match(text, /Claude Code · Oct 1–Nov 1 UTC\n\*\*Not available in this scan\*\*/);
    assert.doesNotMatch(text, /No usage recorded this cycle/);
    const shown = await h.commands.get('aiUsageCreditsMeter.show')();
    assert.match(shown.title, /· Claude unavailable$/);
    assert.ok(h.picks[0].items.some((entry) => entry.label === '$(warning) Claude Code usage could not be read in this scan'));
    assert.ok(h.picks[0].items.every((entry) => !/No Claude Code usage recorded/.test(entry.label)));
    await h.commands.get('aiUsageCreditsMeter.openDashboard')();
    const html = h.panels[0].webview.html;
    assert.match(html, /Usage could not be read in this scan\. Run Refresh to try again\./);
    assert.doesNotMatch(html, /No usage found for this billing cycle/);
  } finally { await h.dispose(); }
});

test('a scan cancelled before it started is retried once while it is current, and not when superseded', async () => {
  const both = bothFixture();
  let calls = 0;
  const retried = harness(both, {
    settings: { provider: 'both' },
    respond: () => { calls += 1; if (calls === 1) throw new Error('Usage scan was cancelled'); return both; },
  });
  try {
    await retried.settle();
    assert.deepEqual(Array.from(retried.runs, (run) => run.provider), ['both', 'both'], 'the retry is a combined scan, not a Copilot-only fallback');
    assert.ok(retried.statusItems[0].tooltip.value.includes('Claude Code'));
    assert.equal(retried.errors.length, 0);
  } finally { await retried.dispose(); }

  const stuck = harness(both, { settings: { provider: 'both' }, respond: () => { throw new Error('Usage scan was cancelled'); } });
  try {
    await stuck.settle();
    assert.deepEqual(Array.from(stuck.runs, (run) => run.provider), ['both', 'both'], 'one retry, then the cancellation is reported');
    assert.match(String(stuck.statusItems[0].tooltip), /cancelled/);
  } finally { await stuck.dispose(); }

  let rejectFirst;
  let started = 0;
  const superseded = harness(both, {
    settings: { provider: 'both' },
    respond: () => { started += 1; return started === 1 ? new Promise((resolve, reject) => { rejectFirst = reject; }) : both; },
  });
  try {
    await superseded.settle();
    await superseded.configuration.fire({ affectsConfiguration: () => true });
    await superseded.settle();
    rejectFirst(new Error('Usage scan was cancelled'));
    await superseded.settle();
    assert.equal(started, 2, 'the superseded scan is not run again');
    assert.ok(superseded.statusItems[0].tooltip.value.includes('Claude Code'));
  } finally { await superseded.dispose(); }
});

test('only a scan made under the current settings can switch later scans to Copilot alone', async () => {
  const copilot = fixture();
  const stopped = () => new Error('Usage worker stopped unexpectedly (1)');
  const control = harness(copilot, {
    settings: { provider: 'both' },
    respond: (opts) => { if (opts.provider === 'both') throw stopped(); return copilot; },
  });
  try {
    await control.settle();
    await control.commands.get('aiUsageCreditsMeter.compute')();
    assert.deepEqual(Array.from(control.runs, (run) => run.provider), ['both', 'githubCopilot', 'githubCopilot'],
      'after a current scan fails, later scans read Copilot alone until a refresh');
  } finally { await control.dispose(); }

  let rejectFirst;
  let started = 0;
  const h = harness(copilot, {
    settings: { provider: 'both' },
    respond: (opts) => {
      started += 1;
      if (started === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
      return opts.provider === 'both' ? bothFixture({ copilot }) : copilot;
    },
  });
  try {
    await h.settle();
    await h.configuration.fire({ affectsConfiguration: () => true });
    await h.settle();
    rejectFirst(stopped());
    await h.settle();
    const before = h.runs.length;
    await h.commands.get('aiUsageCreditsMeter.compute')();
    assert.equal(h.runs[before].provider, 'both', 'a failure from a superseded scan did not latch Copilot-only mode');
  } finally { await h.dispose(); }
});

test('a scan requested after deactivation is refused instead of starting a new worker', async () => {
  const h = harness(bothFixture(), { settings: { provider: 'both' } });
  await h.settle();
  const compute = h.commands.get('aiUsageCreditsMeter.compute');
  const scans = h.scans;
  await h.dispose();
  await assert.rejects(compute(), /Usage tracker deactivated/);
  assert.equal(h.scans, scans, 'no worker request was made after deactivation');
});

test('hostile text is cut on character boundaries, loses control characters and keeps ordinary prose intact', async () => {
  const result = bothFixture();
  // model-4 and model-5 rank inside the top five of both the hover (by credits) and the popup (by tokens).
  result.githubCopilot.models[4].model = `${'x'.repeat(78)}😀tail`;
  result.githubCopilot.models[3].model = 'plain\u001b[31m\u0007 \u202ereversed';
  result.claudeCode.diagnostics.notes = ['compared tokens / credits / cost on 2026/10/15 and/or 1/2'];
  const h = harness(result, { settings: { provider: 'both' } });
  try {
    await h.settle();
    const text = h.statusItems[0].tooltip.value;
    assert.ok(text.includes('plain\\[31m reversed'), 'the hostile name is shown without its control characters');
    assert.ok(text.includes(`${'x'.repeat(78)}…`), 'the long name is cut before the emoji, not through it');
    assert.doesNotMatch(text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate halves');
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/, 'no control or bidirectional characters');
    assert.ok(text.includes('compared tokens / credits / cost on 2026/10/15 and/or 1/2'), 'ordinary prose is not treated as a path');
    await h.commands.get('aiUsageCreditsMeter.show')();
    const labels = Array.from(h.picks[0].items, (entry) => `${entry.label}\n${entry.copyText || ''}`);
    assert.ok(labels.some((label) => label.includes('plain[31m reversed')), 'the popup lists the hostile model');
    for (const label of labels) {
      assert.doesNotMatch(label, /[\ud800-\udbff](?![\udc00-\udfff])/);
      assert.doesNotMatch(label, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
    }
  } finally { await h.dispose(); }
});

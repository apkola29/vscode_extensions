// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..', '..');
const LEGACY_CHAT_REQUIRE = /require\(\s*['"](?:\.{1,2}\/)+chat(?:\.js)?['"]\s*\)/;

/** @param {boolean} [runDiagnostics] */
async function activateWithLegacySettings(runDiagnostics = false) {
  const calls = {
    acquire: 0, release: 0, manual: 0, off: 0, auto: 0, dispose: 0,
    authentication: 0, secrets: 0, chat: 0, lm: 0, chatRequire: 0, showLog: 0
  };
  class Backend extends EventEmitter {
    constructor() {
      super();
      this.state = 'off';
      this.error = '';
      this.activeHelpers = [];
      this.pids = [];
    }
    acquire() { calls.acquire++; this.state = 'on'; }
    release() { calls.release++; this.state = 'off'; }
    resetFailures() {}
    dispose() { this.release(); this.removeAllListeners(); }
  }
  /** Contract stand-in for src/activityCoordinator.js: counts requests, never touches the backend. */
  class Coordinator extends EventEmitter {
    /** @param {unknown} backend @param {Record<string, unknown>} options */
    constructor(backend, options) {
      super();
      this.backend = backend;
      this.options = options;
    }
    getState() {
      return {
        mode: 'off', state: 'off', desired: false, confirmed: false, ownerCount: 0, generation: 1, instanceId: 'test',
        durationMs: 0, expiresAt: 0, error: '', notice: '',
        auto: { status: 'unavailable', harness: 'VS Code Local/Copilot', reason: 'unavailable for this test' },
        backendState: 'off', pids: [], helpers: []
      };
    }
    manual() { calls.manual++; return Promise.resolve(true); }
    /** @returns {any} */
    off() { calls.off++; }
    auto() { calls.auto++; return false; }
    dispose() { calls.dispose++; this.removeAllListeners(); }
  }
  const disposable = { dispose() {} };
  /** @type {Map<string, () => void | Promise<void>>} */
  const commands = new Map();
  const legacy = { enabled: true, mode: 'always', activityTimeoutMinutes: 30 };
  const vscode = {
    get authentication() {
      calls.authentication++;
      throw new Error('The extension must not access authentication');
    },
    get chat() {
      calls.chat++;
      throw new Error('The primary controls must not use the chat API');
    },
    get lm() {
      calls.lm++;
      throw new Error('The primary controls must not use the language model API');
    },
    window: {
      createOutputChannel: () => ({
        ...disposable, info() {}, debug() {}, warn() {}, error() {}, show() { calls.showLog++; }
      }),
      createStatusBarItem: () => ({ ...disposable, show() {}, hide() {} }),
      showInformationMessage: () => Promise.resolve('Show Log'),
      showWarningMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined)
    },
    workspace: {
      isTrusted: false,
      getConfiguration: () => ({
        get: (/** @type {string} */ key, /** @type {unknown} */ defaultValue) => Reflect.get(legacy, key) ?? defaultValue,
        inspect: () => undefined
      }),
      onDidChangeConfiguration: () => disposable
    },
    commands: {
      registerCommand: (/** @type {string} */ name, /** @type {() => void | Promise<void>} */ handler) => {
        commands.set(name, handler);
        return disposable;
      },
      executeCommand: () => Promise.resolve()
    },
    env: {},
    StatusBarAlignment: { Right: 1 },
    ExtensionKind: { Workspace: 2 },
    ThemeColor: class { constructor(/** @type {string} */ id) { this.id = id; } },
    MarkdownString: class {},
    ConfigurationTarget: { Global: 1, Workspace: 2 }
  };
  const entry = path.join(root, 'src', 'extension.js');
  const exports = {};
  const module = { exports };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    module,
    exports,
    process,
    require: (/** @type {string} */ name) => {
      if (name === 'vscode') return vscode;
      if (name === './keepAwake') return { KeepAwake: Backend };
      if (name === './activityCoordinator') return { ActivityCoordinator: Coordinator };
      if (name === './chat') calls.chatRequire++;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  }, { filename: entry });
  const activate = Reflect.get(module.exports, 'activate');
  /** @type {{ dispose: () => void }[]} */
  const subscriptions = [];
  const instance = activate({
    subscriptions,
    get secrets() {
      calls.secrets++;
      throw new Error('The extension must not access stored credentials');
    },
    extension: { extensionKind: 1, packageJSON: { version: 'test' } }
  });
  if (runDiagnostics) {
    const state = instance.getState();
    assert.equal(state.supported, true);
    assert.equal(state.mode, 'off');
    assert.equal(state.confirmed, false);
    assert.equal(state.protectionMode, undefined, 'the participant-era protection mode is gone');
    for (const name of ['agentKeepAwake.showStatus', 'agentKeepAwake.showLog']) {
      const command = commands.get(name);
      assert.ok(command, `${name} must be registered`);
      await command();
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  for (const subscription of subscriptions) subscription.dispose();
  return calls;
}

test('opening VS Code never requests a sleep block, even with old always/enabled settings in a Restricted workspace', async () => {
  const calls = await activateWithLegacySettings();
  assert.equal(calls.acquire, 0, 'nothing acquires power at startup');
  assert.equal(calls.manual, 0, 'no Keep awake request at startup');
  assert.equal(calls.auto, 0, 'no Auto request at startup');
  assert.equal(calls.off, 0, 'startup is Off without needing to turn anything off');
});

test('startup, status and logs require no authentication, stored credentials, chat or language-model access', async () => {
  const calls = await activateWithLegacySettings(true);
  assert.equal(calls.authentication, 0);
  assert.equal(calls.secrets, 0);
  assert.equal(calls.chat, 0);
  assert.equal(calls.lm, 0);
  assert.equal(calls.chatRequire, 0, 'the legacy chat controller is never loaded');
  assert.equal(calls.showLog, 2, 'both diagnostic commands work without signing in');
  assert.equal(calls.acquire, 0);
  assert.equal(calls.manual, 0);
  assert.equal(calls.dispose, 1, 'disposing the extension disposes the coordinator that owns the backend');
});

test('the manifest must not offer always/editor-activity sleep blocking', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const properties = pkg.contributes.configuration.properties;
  assert.equal(properties['agentKeepAwake.mode'], undefined);
  assert.equal(properties['agentKeepAwake.enabled'], undefined, 'no persistent on switch across editor restarts');
  assert.equal(properties['agentKeepAwake.activityTimeoutMinutes'], undefined);
});

test('no automated release or push-triggered CI remains before user UAT approval', () => {
  assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', 'release.yml')), false);
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request):/m);
});

test('no production source requires the legacy chat controller', () => {
  const sources = fs.readdirSync(path.join(root, 'src'), { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.js') && path.basename(file) !== 'chat.js');
  assert.ok(sources.includes('extension.js'));
  for (const file of sources) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(text, LEGACY_CHAT_REQUIRE, `src/${file} must not load the retired @awake route`);
  }
});

test('the package ships the OS backend and coordinator but not the retired chat route or the plan', () => {
  const ignoredPaths = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  for (const needed of ['src/keepAwake.js', 'src/activityCoordinator.js', 'src/extension.js']) {
    assert.ok(!ignoredPaths.includes(needed), `${needed} must be packaged`);
  }
  assert.ok(ignoredPaths.includes('src/chat.js'), 'the legacy chat controller stays unbundled');
  assert.ok(ignoredPaths.includes('IMPLEMENTATION_PLAN.md'), 'the working plan is not shipped');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.chatParticipants, undefined);
  assert.equal(pkg.enabledApiProposals, undefined, 'no proposed/private API is required');
});

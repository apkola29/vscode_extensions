// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');

const COMMANDS = [
  'selectMode', 'keepAwake', 'autoMode', 'turnOff',
  'toggleSession', 'chooseDuration', 'openSettings', 'stopSession', 'showStatus', 'showLog'
];

/** @typedef {{ command: string, title: string, category?: string, enablement?: string }} ContributedCommand */

test('has no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
});

test('activates lazily after start-up and runs on the local machine first', () => {
  assert.deepEqual(pkg.activationEvents, ['onStartupFinished']);
  assert.equal(pkg.extensionKind[0], 'ui');
  assert.equal(pkg.main, './src/extension.js');
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
});

test('is the 1.1.1 documentation preview, and the lockfile root metadata agrees without touching dependencies', () => {
  assert.equal(pkg.version, '1.1.1');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const rootEntry = lock.packages[''];
  assert.equal(rootEntry.name, pkg.name);
  assert.equal(rootEntry.version, pkg.version);
  assert.equal(rootEntry.dependencies, undefined);
  assert.deepEqual(rootEntry.devDependencies, pkg.devDependencies);
  assert.deepEqual(rootEntry.engines, pkg.engines);
});

test('contributes only commands and settings: no chat participant, tool, hook or proposed API', () => {
  assert.deepEqual(Object.keys(pkg.contributes).sort(), ['commands', 'configuration']);
  assert.equal(pkg.contributes.chatParticipants, undefined, 'the @awake route is retired');
  assert.equal(pkg.enabledApiProposals, undefined);
  assert.equal(pkg.engines.vscode, '^1.95.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.95.0');
  assert.deepEqual(pkg.extensionKind, ['ui'], 'prevent local workstation sleep, not a remote server');
});

test('the frontend source loads only the backend and coordinator and avoids chat, model, credential and timer APIs', () => {
  const required = [...extensionSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]).sort();
  assert.deepEqual(required, ['./activityCoordinator', './keepAwake', 'vscode']);
  assert.doesNotMatch(extensionSource, /createChatParticipant|handleRequest|participant|PARTICIPANT_ID/i);
  assert.doesNotMatch(extensionSource, /vscode\.(chat|lm|authentication)\b|\.secrets\b|sendRequest|registerTool/);
  assert.doesNotMatch(extensionSource, /\bset(Timeout|Interval)\b/, 'the coordinator owns every deadline; the frontend never polls');
});

test('every contributed command is registered, and vice versa', () => {
  const contributed = pkg.contributes.commands.map((/** @type {ContributedCommand} */ c) => c.command).sort();
  const registered = [...extensionSource.matchAll(/registerCommand\(`\$\{SECTION\}\.(\w+)`/g)].map(m => `agentKeepAwake.${m[1]}`);
  for (const id of contributed) {
    assert.ok(registered.includes(id), `${id} is contributed but not registered`);
  }
  const internalOnly = registered.filter(id => !contributed.includes(id));
  assert.deepEqual(internalOnly, [], 'no undeclared activation commands');
});

test('the mode commands and the existing timed/stop aliases are contributed with unique, readable titles', () => {
  /** @type {ContributedCommand[]} */
  const commands = pkg.contributes.commands;
  assert.deepEqual(commands.map(c => c.command).sort(), COMMANDS.map(name => `agentKeepAwake.${name}`).sort());
  const titles = commands.map(c => c.title);
  assert.equal(new Set(titles.map(title => title.toLowerCase())).size, titles.length, 'every title is unique');
  for (const command of commands) {
    assert.equal(command.category, 'Agent Keep-Awake', command.command);
    assert.equal(command.title, command.title.trim(), command.command);
    assert.match(command.title, /^[A-Z]/, command.command);
    assert.ok(command.title.length >= 4 && command.title.length <= 60, `${command.command}: ${command.title}`);
  }
  /** @param {string} name */
  const titleOf = name => String(commands.find(c => c.command === `agentKeepAwake.${name}`)?.title);
  assert.match(titleOf('turnOff'), /Turn Off/);
  assert.match(titleOf('stopSession'), /Turn Off/, 'the stop alias says it is the common Off');
  assert.match(titleOf('keepAwake'), /Keep Awake/i);
  assert.match(titleOf('autoMode'), /Auto - Copilot Activity \(Unavailable\)/, 'the palette does not imply Auto works in this build');
  assert.match(titleOf('toggleSession'), /Duration/i, 'the timed alias keeps using the Duration (Hours) setting');
});

test('Off is always reachable: no command is gated, and no menu or keybinding can hide it', () => {
  for (const command of pkg.contributes.commands) {
    assert.equal(command.enablement, undefined, command.command);
  }
  assert.equal(pkg.contributes.menus, undefined, 'no commandPalette when-clause hides turnOff or stopSession');
});

test('every setting read by the code is declared with a default', () => {
  const declared = pkg.contributes.configuration.properties;
  const used = [...extensionSource.matchAll(/\.get\('(\w+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['durationHours', 'showStatusBarItem']);
  for (const key of used) {
    const decl = declared[`agentKeepAwake.${key}`];
    assert.ok(decl, `agentKeepAwake.${key} is not declared`);
    assert.notEqual(decl.default, undefined, `agentKeepAwake.${key} has no default`);
  }
});

test('the preview cannot enable persistent or heuristic sleep prevention, and a workspace cannot override its settings', () => {
  const p = pkg.contributes.configuration.properties;
  assert.deepEqual(Object.keys(p).sort(), ['agentKeepAwake.durationHours', 'agentKeepAwake.showStatusBarItem']);
  assert.equal(p['agentKeepAwake.showStatusBarItem'].default, true);
  assert.equal(p['agentKeepAwake.durationHours'].default, 1);
  assert.equal(p['agentKeepAwake.durationHours'].minimum, 0);
  assert.equal(p['agentKeepAwake.durationHours'].maximum, 24);
  assert.equal(p['agentKeepAwake.durationHours'].scope, 'application', 'workspace files cannot silently request unlimited protection');
  assert.equal(p['agentKeepAwake.showStatusBarItem'].scope, 'application', 'a trusted repository cannot silently hide an active hold');
});

test('the settings describe the timed command and visibility truthfully', () => {
  const p = pkg.contributes.configuration.properties;
  const duration = p['agentKeepAwake.durationHours'].markdownDescription;
  assert.match(duration, /timed/i);
  assert.match(duration, /\*\*0\*\*/);
  assert.match(duration, /until you turn it off/i);
  assert.match(duration, /next (timed )?session only/i);
  assert.match(duration, /never turns Keep Awake on automatically/i);
  assert.match(duration, /Keep awake choice/i, 'the main Keep awake choice does not use the setting');
  const visibility = p['agentKeepAwake.showStatusBarItem'].markdownDescription;
  assert.match(visibility, /Off|Turn Off/);
  assert.match(visibility, /hiding.*(does not|never).*(turns? off|releases?)/i);
});

test('Restricted Mode keeps Keep awake and Off usable while documenting that Auto is unavailable', () => {
  const untrusted = pkg.capabilities.untrustedWorkspaces;
  assert.equal(untrusted.supported, 'limited');
  assert.match(untrusted.description, /Keep awake/);
  assert.match(untrusted.description, /Off/);
  assert.match(untrusted.description, /Auto/);
  assert.match(untrusted.description, /unavailable/i);
  assert.equal(pkg.capabilities.virtualWorkspaces, true);
});

test('the marketplace description does not promise Auto protection', () => {
  assert.match(pkg.description, /Keep awake/i);
  assert.match(pkg.description, /Auto/);
  assert.match(pkg.description, /unavailable/i);
  assert.doesNotMatch(pkg.description, /Timed sessions start off/);
});

test('the packaged extension excludes tests, docs and tooling', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
  for (const entry of ['test/**', 'docs/**', 'node_modules/**', '.github/**']) {
    assert.ok(ignore.includes(entry), `.vscodeignore should contain ${entry}`);
  }
});

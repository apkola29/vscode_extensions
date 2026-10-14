// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** @param {string} reply */
function load(reply) {
  /** @type {string[]} */
  const commands = [];
  const module = { exports: {} };
  const filename = path.join(__dirname, '..', 'os', 'processes.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    process: { platform: 'win32', pid: 1234, env: { SystemRoot: 'C:\\Windows' } },
    require: (/** @type {string} */ name) => name === './probe' ? {
      isAlive: () => true,
      run: (/** @type {string} */ _file, /** @type {string[]} */ args) => { commands.push(args.at(-1) || ''); return reply; }
    } : require(name)
  }, { filename });
  return {
    identity: Reflect.get(module.exports, 'identity'),
    stop: Reflect.get(module.exports, 'stop'),
    stopChildren: Reflect.get(module.exports, 'stopChildren'),
    commands
  };
}

test('test cleanup does not kill a recorded PID whose process birth identity changed', () => {
  const api = load('12345');
  api.stop({ pid: 321, birth: '54321' });
  assert.equal(api.commands.length, 1);
  assert.doesNotMatch(api.commands[0], /Stop-Process/);
});

test('a matching test helper is stopped by specific PID only', () => {
  const api = load('12345');
  api.stop({ pid: 321, birth: '12345' });
  assert.equal(api.commands.length, 2);
  assert.match(api.commands[1], /Stop-Process -Id 321 -Force/);
  assert.match(api.commands[1], /\$ErrorActionPreference='Stop'/);
  assert.doesNotMatch(api.commands[1], /Stop-Process -Name|taskkill|\/IM/);
});

test('owned-child cleanup is rooted at this runner and excludes the cleanup process', () => {
  const api = load('');
  api.stopChildren();
  assert.match(api.commands[0], /Stop-Owned 1234/);
  assert.match(api.commands[0], /ProcessId -ne \$PID/);
  assert.match(api.commands[0], /ParentProcessId -eq \$root/);
  assert.match(api.commands[0], /CreationDate -ge \$birth/);
  assert.match(api.commands[0], /\$parent\.CreationDate -ne \$birth/);
  assert.match(api.commands[0], /\$ErrorActionPreference='Stop'/);
  assert.match(api.commands[0], /Stop-Owned 1234 \$runner\.CreationDate/);
  assert.doesNotMatch(api.commands[0], /Stop-Process -Name|taskkill|\/IM/);
});

test('invalid process identities fail instead of becoming success-shaped cleanup checks', () => {
  assert.throws(() => load('garbage').identity(321), /identity response/);
  assert.throws(() => load('12345').identity(-1), /Invalid test process PID/);
  assert.equal(load('NONE').identity(321), undefined);
  const api = load('12345');
  api.identity(321);
  assert.match(api.commands[0], /\$ErrorActionPreference='Stop'/);
});

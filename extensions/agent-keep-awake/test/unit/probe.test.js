// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * @param {(file: string, args: string[]) => string} execute
 * @param {NodeJS.Platform} [platform]
 */
function loadProbe(execute, platform = 'win32') {
  const module = { exports: {} };
  const filename = path.join(__dirname, '..', 'os', 'probe.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    process: { platform, env: { SystemRoot: 'C:\\Windows' } },
    require: (/** @type {string} */ name) =>
      name === 'child_process' ? { execFileSync: execute } : require(name)
  }, { filename });
  return Reflect.get(module.exports, 'probe');
}

test('failed OS commands throw instead of looking like a released power request', () => {
  for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'darwin', 'linux'])) {
    const probe = loadProbe(() => { throw new Error('Access denied'); }, platform);
    assert.throws(() => probe(), /Access denied/);
  }
});

test('malformed OS responses cannot count as successful release verification', () => {
  for (const output of ['bad output', '0 -1', '0 1.5', '0 4294967296', '0 1 unexpected']) {
    const probe = loadProbe(() => output);
    assert.throws(() => probe(), /query failed/i, output);
  }
});

test('valid OS bit flags distinguish system and display requirements', () => {
  for (const value of [0, 1, 3]) {
    const probe = loadProbe(() => `0 ${value}`);
    const state = probe();
    assert.equal(state.system, Boolean(value & 1));
    assert.equal(state.display, Boolean(value & 2));
  }
});

/** @param {string[]} assertions */
function macOutput(assertions) {
  return [
    'Assertion status system-wide:',
    '   PreventSystemSleep              0',
    `   PreventUserIdleSystemSleep      ${assertions.some(line => line.includes('PreventUserIdleSystemSleep')) ? 1 : 0}`,
    `   PreventUserIdleDisplaySleep     ${assertions.some(line => line.includes('PreventUserIdleDisplaySleep')) ? 1 : 0}`,
    'Listed by owning process:',
    ...assertions
  ].join('\n');
}

/** @param {unknown[][]} rows */
function linuxOutput(rows) {
  return JSON.stringify({ type: 'a(ssssuu)', data: [rows] });
}

test('malformed macOS assertion output cannot count as successful release', () => {
  for (const output of [
    '', 'bad output',
    'Assertion status system-wide:\nListed by owning process:',
    macOutput(['pid 321(caffeinate): malformed assertion']),
    macOutput([]).replace('Listed by owning process:', 'PreventUserIdleSystemSleep 1\nListed by owning process:')
  ]) {
    const probe = loadProbe(() => output, 'darwin');
    assert.throws(() => probe([321]), /query failed/i, output);
  }
});

test('macOS probes distinguish global assertions from the requested helper PIDs', () => {
  const assertions = [
    'pid 321(caffeinate): [0x0000000100000001] 00:00:03 PreventUserIdleSystemSleep named: "caffeinate command-line tool"',
    'pid 999(caffeinate): [0x0000000100000002] 00:00:03 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"'
  ];
  for (const output of [macOutput(assertions), macOutput(assertions).replace(/ {2,}/g, '\t')]) {
    const probe = loadProbe(() => output, 'darwin');
    const held = probe([321]);
    assert.equal(held.system, true);
    assert.equal(held.display, false);
    assert.equal(probe([999]).display, true);
    assert.equal(probe([32]).system, false);
    assert.equal(probe().system, true, 'global baseline must detect a real system assertion');
    assert.equal(probe().display, true);
  }
  const released = loadProbe(() => macOutput([]), 'darwin')([321]);
  assert.equal(released.system, false);
  assert.equal(released.display, false);
});

test('malformed or truncated Linux inhibitor output cannot count as successful release', () => {
  for (const output of [
    '', 'bad output',
    'null', '{"type":"a(ssssuu)","data":',
    '{"type":"a(ssssuu)","data":[]}',
    linuxOutput([['sleep', 'Other app', 'Work']]),
    linuxOutput([['invalid', 'Other app', 'Work', 'block', 1000, 321]]),
    linuxOutput([['sleep', 'Other app', 'Work', 'block', '1000', 321]]),
    linuxOutput([['sleep', 'Other app', 'Work', 'block', 1000, -1]])
  ]) {
    const probe = loadProbe(() => output, 'linux');
    assert.throws(() => probe([321]), /query failed/i, output);
  }
});

test('Linux probes match the PID field, not another window, a UID, or a delay inhibitor', () => {
  const rows = [
    ['sleep:idle', 'Agent Keep-Awake', 'Coding chat', 'block', 1000, 321],
    ['sleep', 'Agent Keep-Awake', 'Coding chat', 'block', 1000, 999],
    ['sleep', 'Other app', 'Background work', 'delay', 321, 456]
  ];
  const probe = loadProbe((file, args) => {
    assert.equal(file, 'busctl');
    assert.ok(args.includes('--system') && args.includes('--json=short'));
    assert.equal(args.at(-1), 'ListInhibitors');
    return linuxOutput(rows);
  }, 'linux');
  assert.equal(probe([321]).system, true);
  assert.equal(probe([321]).display, true);
  assert.equal(probe([999]).display, false);
  assert.equal(probe([1000]).system, false, 'a UID must not be mistaken for a helper PID');
  assert.equal(probe([456]).system, false, 'delay is not a persistent sleep block');
  assert.equal(probe().system, true);
  assert.equal(probe().display, true);
  const released = loadProbe(() => linuxOutput(rows.slice(1)), 'linux')([321]);
  assert.equal(released.system, false, 'another window must not mask release of this helper');
  assert.equal(released.display, false);
});

test('Linux probes accept logind shutdown inhibitors without treating them as sleep blocks', () => {
  const probe = loadProbe(() => linuxOutput([
    ['shutdown', 'Other app', 'Saving data', 'block', 1000, 777],
    ['shutdown:sleep', 'Other app', 'Saving data', 'delay', 1000, 888]
  ]), 'linux');
  assert.equal(probe().system, false);
  assert.equal(probe().display, false);
  assert.equal(probe([777]).system, false);
});

test('a valid empty Linux inhibitor list reports a released request', () => {
  for (const output of [linuxOutput([]), `${linuxOutput([])}\n`, JSON.stringify({ type: 'a(ssssuu)', data: [[]] }, null, 2)]) {
    const state = loadProbe(() => output, 'linux')([321]);
    assert.equal(state.system, false);
    assert.equal(state.display, false);
  }
});

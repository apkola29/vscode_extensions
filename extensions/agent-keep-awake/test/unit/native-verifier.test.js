// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** @param {{system: boolean, display: boolean, raw: string}} baseline */
async function runWithAmbientRequest(baseline) {
  let constructed = 0;
  /** @type {string[]} */
  const output = [];
  /** @type {(value: number) => void} */
  let finish = () => {};
  const finished = new Promise(/** @param {(value: number) => void} resolve */ resolve => { finish = resolve; });
  const fakeProcess = {
    platform: 'win32', arch: 'x64', version: 'test', argv: [], execPath: 'node',
    exitCode: 0,
    exit: (/** @type {number | undefined} */ code) => finish(code ?? fakeProcess.exitCode)
  };
  const filename = path.join(__dirname, '..', 'os', 'verify-os.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename), process: fakeProcess,
    console: {
      log: (/** @type {unknown[]} */ ...args) => output.push(args.map(String).join(' ')),
      error: (/** @type {unknown[]} */ ...args) => output.push(args.map(String).join(' '))
    },
    setTimeout: (/** @type {() => void} */ callback) => {
      queueMicrotask(callback);
      return { unref() {} };
    },
    require: (/** @type {string} */ name) => {
      if (name === '../../src/keepAwake') return {
        KeepAwake: class {
          constructor() { constructed++; this.state = 'error'; this.error = 'No native call should occur'; }
          acquire() {}
          dispose() {}
        }
      };
      if (name === './probe') return { probe: () => baseline, isWindowsAdmin: () => false };
      if (name === 'child_process') return { spawn: () => { throw new Error('Unexpected native launch'); } };
      return require(name);
    }
  }, { filename });
  return { code: await finished, constructed, output };
}

test('native verification reports an ambient system hold as inconclusive before constructing a helper', async () => {
  const result = await runWithAmbientRequest({ system: true, display: false, raw: 'ambient system' });
  assert.equal(result.code, 1);
  assert.equal(result.constructed, 0);
  assert.ok(result.output.some(line => /INCONCLUSIVE/.test(line)));
  assert.ok(!result.output.some(line => /^PASS/.test(line)));
});

test('native verification also refuses an ambient display hold', async () => {
  const result = await runWithAmbientRequest({ system: false, display: true, raw: 'ambient display' });
  assert.equal(result.code, 1);
  assert.equal(result.constructed, 0);
  assert.ok(result.output.some(line => /INCONCLUSIVE/.test(line)));
});

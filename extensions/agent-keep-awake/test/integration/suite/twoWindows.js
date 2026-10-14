// @ts-check
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function run() {
  const root = process.env.AKA_TWO_WINDOW_ROOT;
  const role = process.env.AKA_TWO_WINDOW_ROLE;
  assert.ok(root && (role === 'a' || role === 'b'));
  const extension = vscode.extensions.getExtension('apkola29.agent-keep-awake');
  assert.ok(extension);
  /** @type {ReturnType<typeof import('../../../src/extension').activate>} */
  const api = await extension.activate();
  assert.equal(api.getState().mode, 'off');
  assert.equal(api.getState().desired, false);
  assert.deepEqual(api.getState().pids, []);
  await vscode.commands.executeCommand('agentKeepAwake.keepAwake');
  const state = api.getState();
  assert.equal(state.mode, 'manual');
  assert.equal(state.confirmed, true);
  assert.equal(state.backendState, 'on');
  assert.equal(state.durationMs, 0);
  assert.equal(state.expiresAt, 0);
  assert.equal(state.statusColor, 'testing.iconPassed');
  assert.ok(state.pids.length);
  const filename = path.join(root, `${role}-ready.json`);
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify({ pids: state.pids }));
  fs.renameSync(`${filename}.tmp`, filename);
  const deadline = Date.now() + 5 * 60_000;
  try {
    while (!fs.existsSync(path.join(root, `${role}-close`))) {
      if (Date.now() > deadline) throw new Error('The two-window test supervisor did not request cleanup.');
      assert.equal(api.getState().confirmed, true);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    api.stopKeepAwake();
    throw error;
  }
  // Leave the real hold owned by the window; extension-host shutdown must release it.
}

module.exports = { run };

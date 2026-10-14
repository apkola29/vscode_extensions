// @ts-check
'use strict';

const vscode = require('vscode');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  /** @type {Set<() => void>} */
  const finishers = new Set();
  let active = 0;
  context.subscriptions.push(vscode.lm.registerTool('agent_keep_awake_test_wait', {
    async invoke(_options, token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      active++;
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            subscription.dispose();
            finishers.delete(finish);
            resolve(undefined);
          };
          const subscription = token.onCancellationRequested(() => {
            if (settled) return;
            settled = true;
            subscription.dispose();
            finishers.delete(finish);
            reject(new vscode.CancellationError());
          });
          finishers.add(finish);
          if (token.isCancellationRequested) {
            subscription.dispose();
            finishers.delete(finish);
            settled = true;
            reject(new vscode.CancellationError());
          }
        });
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Awaited tool finished.')]);
      } finally {
        active--;
      }
    }
  }));
  return {
    get active() { return active; },
    finish() { for (const finish of [...finishers]) finish(); }
  };
}

module.exports = { activate };

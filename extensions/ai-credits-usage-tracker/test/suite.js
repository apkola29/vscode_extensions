'use strict';
// Runs inside the real VS Code extension host (launched by test/run.js).
const fs = require('fs');
const vscode = require('vscode');

exports.run = async function run() {
  const out = { ok: false, checks: {} };
  try {
    const manifest = JSON.parse(fs.readFileSync(require('node:path').join(process.env.AUCM_SOURCE_DIR, 'package.json'), 'utf8'));
    const ext = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    out.checks.extensionFound = !!ext;
    out.checks.extensionPath = ext.extensionPath;
    out.checks.noDockedPanelContribution = !ext.packageJSON.contributes.viewsContainers && !ext.packageJSON.contributes.views;
    out.checks.noPanelOpeningChatButton = !ext.packageJSON.contributes.menus['chat/input/status'];
    out.checks.compactCommandContributed = ext.packageJSON.contributes.commands.some((c) => c.command === 'aiUsageCreditsMeter.show');
    out.checks.defaultProvider = ext.packageJSON.contributes.configuration.properties['aiUsageCreditsMeter.provider'].default;
    try { require('node:sqlite'); out.checks.nodeSqliteInExtensionHost = true; } catch { out.checks.nodeSqliteInExtensionHost = false; }
    await ext.activate();
    out.checks.activated = ext.isActive;
    out.runtime = { vscode: vscode.version, electron: process.versions.electron, node: process.versions.node };

    const cmds = await vscode.commands.getCommands(true);
    out.checks.commandsRegistered = cmds.includes('aiUsageCreditsMeter.openDashboard')
      && cmds.includes('aiUsageCreditsMeter.connectAccount')
      && cmds.includes('aiUsageCreditsMeter.refresh')
      && cmds.includes('aiUsageCreditsMeter.selectProvider')
      && cmds.includes('aiUsageCreditsMeter.show') && cmds.includes('aiUsageCreditsMeter.compute');

    let t = Date.now();
    const r = await vscode.commands.executeCommand('aiUsageCreditsMeter.compute');
    out.firstRunMs = Date.now() - t;
    t = Date.now();
    const r2 = await vscode.commands.executeCommand('aiUsageCreditsMeter.compute');
    out.cachedRunMs = Date.now() - t;
    out.checks.workerCompletedAggregation = !!r.diagnostics.timings && Number.isFinite(r.diagnostics.elapsedMs);
    out.checks.noErrors = r.diagnostics.errors.length === 0;
    out.cycle = r.cycle;
    out.top = r2.models.slice(0, 5).map((m) => ({ model: m.model, totalTokens: Math.round(m.totalTokens), totalCredits: Math.round(m.totalCredits), byTool: m.byTool }));
    out.totals = r2.totals;
    out.diagnostics = r2.diagnostics;

    const shown = await vscode.commands.executeCommand('aiUsageCreditsMeter.show');
    out.popup = { title: shown.title, items: shown.items };
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    out.ok = Object.entries(out.checks).every(([k, v]) => ['extensionPath', 'defaultProvider'].includes(k) || v === true)
      && out.checks.defaultProvider === 'githubCopilot'
      && shown.items.length > 0;
  } catch (e) {
    out.error = e.stack;
  }
  fs.writeFileSync(process.env.AUCM_TEST_OUT, JSON.stringify(out, null, 2));
  if (!out.ok) throw new Error(`integration test failed: ${out.error || 'checks failed'}`);
};

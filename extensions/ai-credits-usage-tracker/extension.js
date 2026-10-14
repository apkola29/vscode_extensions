'use strict';
const path = require('path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { UsageWorkerClient } = require('./lib/worker-client');
const { githubIdentity, connectGitHub } = require('./lib/github-identity');

const TRACKER_NAME = 'GH Copilot Usage Tracker';
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const credits = (n) => Math.round(n).toLocaleString('en-US');
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const PROVIDERS = {
  githubCopilot: { label: 'GitHub Copilot', description: 'Copilot Chat, agent-host, SDK and CLI local usage', icon: 'copilot' },
  claudeCode: { label: 'Claude Code', description: 'Claude Code local transcript usage (preview)', icon: 'claude' },
};
let output;
let currentUserDirs;
let extensionState;
let statusItem;
let compactPick;
let latestPreview;
let previewRequest;
let previewGeneration = 0;
let disposed = false;

// ---------- background aggregation ----------
let workerClient;
function runAggregation(opts) {
  if (!workerClient) workerClient = new UsageWorkerClient(path.join(__dirname, 'lib', 'worker.js'), {
    onError: () => {
      output?.appendLine('Usage worker cleanup failed');
      vscode.window.showErrorMessage(`${TRACKER_NAME} could not stop its worker. Reload the window before retrying.`);
    },
  });
  return workerClient.run(opts);
}

function compute(sortBy) {
  const cfg = vscode.workspace.getConfiguration('aiUsageCreditsMeter');
  const provider = cfg.get('provider', 'githubCopilot');
  return runAggregation({
    provider,
    sortBy: sortBy || cfg.get('sortBy', 'tokens'),
    resetDay: cfg.get('cycleResetDay', 1),
    claudeDirs: cfg.get('claudeConfigDirs', []),
    vscodeUserDirs: currentUserDirs,
  });
}

async function selectProvider() {
  const cfg = vscode.workspace.getConfiguration('aiUsageCreditsMeter');
  const current = cfg.get('provider', 'githubCopilot');
  const picked = await vscode.window.showQuickPick(Object.entries(PROVIDERS).map(([id, p]) => ({
    label: `$(${p.icon}) ${p.label}`,
    description: id === current ? 'Current provider' : undefined,
    detail: p.description,
    id,
  })), {
    title: `${TRACKER_NAME}: Select Chat Provider`,
    placeHolder: 'Choose the provider whose local usage should be tracked',
  });
  if (!picked || picked.id === current) return picked?.id || current;
  await cfg.update('provider', picked.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${TRACKER_NAME} is now connected to ${PROVIDERS[picked.id].label}.`);
  output?.appendLine(`[${new Date().toISOString()}] provider changed: ${current} -> ${picked.id}`);
  return picked.id;
}

async function accountIdentity() {
  if (vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('provider', 'githubCopilot') !== 'githubCopilot') {
    return { status: 'notApplicable', label: 'Claude Code local transcripts' };
  }
  try {
    return await githubIdentity(vscode.authentication, extensionState.get('githubAccountId'));
  } catch {
    output?.appendLine('GitHub sign-in metadata was unavailable; no identity was assumed');
    return { status: 'unavailable', label: 'GitHub sign-in could not be verified; showing local device usage only' };
  }
}

async function connectAccount() {
  const accounts = await vscode.authentication.getAccounts('github');
  let account = accounts.length === 1 ? accounts[0] : undefined;
  if (accounts.length > 1) {
    const selected = await vscode.window.showQuickPick(accounts.map((a) => ({ label: a.label, account: a })), {
      title: 'Select the GitHub account you use with Copilot',
    });
    if (!selected) return;
    account = selected.account;
  }
  const identity = await connectGitHub(vscode.authentication, account);
  await extensionState.update('githubAccountId', identity.id);
  invalidatePreview();
  await refreshPreview();
}

// ---------- UI ----------
const markdownText = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()#+.!|<>]/g, '\\$&');
const previewKey = () => {
  const cfg = vscode.workspace.getConfiguration('aiUsageCreditsMeter');
  return JSON.stringify({
    provider: cfg.get('provider', 'githubCopilot'),
    resetDay: cfg.get('cycleResetDay', 1),
    claudeDirs: cfg.get('claudeConfigDirs', []),
    accountId: extensionState.get('githubAccountId'),
  });
};

function hoverSummary(result, identity) {
  const provider = PROVIDERS[result.provider] || { label: result.provider };
  const hasEstimate = result.totals.estCredits > 0.5;
  const lines = [
    `**${TRACKER_NAME}**`,
    `${markdownText(provider.label)} · ${day(result.cycle.start)}–${day(result.cycle.end)} UTC`,
    `**${hasEstimate ? '≈' : ''}${credits(result.totals.totalCredits)} credits** · ${fmt(result.totals.totalTokens)} tokens`,
    '',
    '| Highest-used model | Credits |',
    '| :--- | ---: |',
  ];
  for (const model of [...result.models].sort((a, b) => b.totalCredits - a.totalCredits).slice(0, 5)) {
    lines.push(`| ${markdownText(model.model)} | ${model.estCredits > 0.5 ? '≈' : ''}${credits(model.totalCredits)} |`);
  }
  if (!result.models.length) lines.push('| No usage recorded yet | — |');
  const issues = [...(result.diagnostics.errors || []), ...(result.diagnostics.notes || [])];
  if (issues.length) lines.push('', `⚠ Partial data: ${markdownText(issues[0])}`);
  if (identity.status === 'signedIn') lines.push('', `GitHub account: ${markdownText(identity.label)}`);
  else lines.push('', markdownText(identity.label));
  lines.push('', '*Local device history, not an account-wide bill. Click for a compact list.*');
  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.isTrusted = false;
  tooltip.supportHtml = false;
  return tooltip;
}

function invalidatePreview() {
  previewGeneration += 1;
  latestPreview = undefined;
  previewRequest = undefined;
  if (statusItem) {
    statusItem.text = '$(pie-chart) Copilot usage';
    statusItem.tooltip = `${TRACKER_NAME} — click for usage; the summary refreshes when opened.`;
  }
}

async function refreshPreview(force = false) {
  const key = previewKey();
  if (previewRequest?.key === key) return previewRequest.promise;
  if (!force && latestPreview?.key === key && Date.now() - latestPreview.updatedAt < 60000) return latestPreview;
  const generation = ++previewGeneration;
  if (statusItem) {
    statusItem.text = '$(loading~spin) Copilot usage';
    statusItem.tooltip = `${TRACKER_NAME} — reading local usage. Click to open the small popup.`;
  }
  const promise = Promise.all([compute(), accountIdentity()]).then(([result, identity]) => {
    const preview = { result, identity, key, updatedAt: Date.now() };
    if (!disposed && generation === previewGeneration && previewKey() === key) {
      latestPreview = preview;
      statusItem.text = `$(pie-chart) ${result.provider === 'claudeCode' ? 'Claude' : 'Copilot'} ${fmt(result.totals.totalCredits)} credits`;
      statusItem.tooltip = hoverSummary(result, identity);
      output?.appendLine(`Compact summary ready: ${result.models.length} model(s)`);
    }
    return preview;
  }, (error) => {
    if (!disposed && generation === previewGeneration) {
      statusItem.text = '$(warning) Copilot usage';
      statusItem.tooltip = `${TRACKER_NAME} — unable to load usage: ${error.message}. Click to retry.`;
      output?.appendLine('Compact usage summary failed to load');
    }
    throw error;
  }).finally(() => {
    if (previewRequest?.promise === promise) previewRequest = undefined;
  });
  previewRequest = { key, promise };
  return promise;
}

const html = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dashboardShell = (body, title = TRACKER_NAME) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none';">
<title>${html(title)}</title><style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px 34px 42px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
    font: 13px/1.45 var(--vscode-font-family); }
  main { max-width: 1080px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
  .meter { width: 38px; height: 38px; color: var(--vscode-charts-blue); flex: none; }
  h1 { margin: 0; font-size: 24px; line-height: 1.15; font-weight: 600; letter-spacing: -.01em; }
  .subtitle { margin: 5px 0 0; color: var(--vscode-descriptionForeground); }
  .summary { display: flex; flex-wrap: wrap; gap: 28px; padding: 16px 0 20px; border-top: 1px solid var(--vscode-widget-border);
    border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 24px; }
  .metric { min-width: 150px; }
  .metric strong { display: block; font-size: 20px; font-weight: 600; }
  .metric span { color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; }
  caption { text-align: left; font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  th { text-align: left; color: var(--vscode-descriptionForeground); font-weight: 600; padding: 9px 10px; border-bottom: 1px solid var(--vscode-widget-border); }
  td { padding: 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent); vertical-align: top; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .model { font-family: var(--vscode-editor-font-family); font-weight: 600; }
  .source { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .warning { padding: 10px 12px; margin: 0 0 18px; color: var(--vscode-editorWarning-foreground);
    background: var(--vscode-inputValidation-warningBackground); border-left: 3px solid var(--vscode-inputValidation-warningBorder); }
  .loading { display: grid; min-height: 55vh; place-items: center; text-align: center; color: var(--vscode-descriptionForeground); }
  .spinner { width: 28px; height: 28px; margin: 0 auto 14px; border: 3px solid var(--vscode-widget-border);
    border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style></head><body><main>${body}</main></body></html>`;
};
const meterSvg = `<svg class="meter" viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M24 6A18 18 0 0 0 6 24c0 5.1 2.1 9.8 5.5 13.1l2.8-2.8A14 14 0 1 1 38 24c0 3.9-1.6 7.4-4.3 9.9l2.8 2.9A18 18 0 0 0 24 6Z"/><path fill="currentColor" d="m31.8 14.2-10 8.1a4.5 4.5 0 1 0 4 4l8.1-10c1.2-1.5-.6-3.3-2.1-2.1Z"/></svg>`;

function renderDashboard(result, identity) {
  const t = result.totals;
  const provider = PROVIDERS[result.provider] || { label: result.provider || 'Configured provider' };
  const issues = [...(result.diagnostics.errors || []), ...(result.diagnostics.notes || [])];
  const warning = issues.length
    ? `<div class="warning"><strong>Incomplete data:</strong> ${html(issues.slice(0, 5).join(' · '))}${issues.length > 5 ? ` · +${issues.length - 5} more` : ''}</div>`
    : '';
  const rows = result.models.map((m, i) => {
    const approximate = m.estCredits > 0.5 ? '≈' : '';
    const sources = Object.entries(m.byTool || {}).filter(([, c]) => c > 0.005)
      .sort((a, b) => b[1] - a[1]).map(([tool, c]) => `${tool} ${fmt(c)}`).join(' · ');
    return `<tr><td class="num">${i + 1}</td><td><div class="model">${html(m.model)}</div><div class="source">${html(sources || m.sources.join(', '))}</div></td>
      <td class="num">${approximate}${html(fmt(m.totalTokens))}</td><td class="num">${approximate}${html(credits(m.totalCredits))}</td>
      <td class="num">${html(usd(m.totalCredits))}</td><td class="num">${html(m.calls)}</td></tr>`;
  }).join('');
  return dashboardShell(`<header>${meterSvg}<div><h1>${TRACKER_NAME}</h1>
    <p class="subtitle">${html(provider.label)} · ${html(day(result.cycle.start))} – ${html(day(result.cycle.end))} UTC · ranked by ${html(result.sortBy)}</p></div></header>
    <p id="github-identity" class="source">${identity ? html(identity.status === 'signedIn' ? `VS Code GitHub account: ${identity.label}` : identity.label) : ''}</p>
    <p class="source">Local device usage, not an account-wide bill. Untagged historical requests cannot be attributed to a GitHub account.</p>
    ${warning}<section class="summary" aria-label="Billing-cycle totals">
      <div class="metric"><strong>≈${html(fmt(t.totalTokens))}</strong><span>tokens</span></div>
      <div class="metric"><strong>≈${html(credits(t.totalCredits))}</strong><span>AI credits</span></div>
      <div class="metric"><strong>${html(usd(t.totalCredits))}</strong><span>estimated list cost</span></div>
      <div class="metric"><strong>${html(t.calls)}</strong><span>completed calls</span></div>
    </section><table><caption>Usage by model</caption><thead><tr><th class="num">#</th><th>Model</th>
      <th class="num">Tokens</th><th class="num">Credits</th><th class="num">Cost</th><th class="num">Calls</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No usage found for this billing cycle.</td></tr>'}</tbody></table>`);
}

async function openDashboard() {
  const providerId = vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('provider', 'githubCopilot');
  const provider = PROVIDERS[providerId] || PROVIDERS.githubCopilot;
  output?.appendLine(`[${new Date().toISOString()}] openDashboard command invoked; provider=${providerId}`);
  let panel;
  try {
    panel = vscode.window.createWebviewPanel(
      'aiUsageCreditsMeter.dashboard',
      TRACKER_NAME,
      vscode.ViewColumn.Active,
      { enableScripts: false, localResourceRoots: [] },
    );
  } catch (e) {
    output?.appendLine(`Unable to create dashboard panel: ${e.stack || e.message}`);
    vscode.window.showWarningMessage(`${TRACKER_NAME} could not open a dashboard here. Opening the quick list instead.`);
    return show();
  }
  panel.webview.html = dashboardShell(`<div class="loading" aria-live="polite"><div><div class="spinner"></div>
    <strong>Reading ${html(provider.label)} usage…</strong><p>The first scan can take several seconds; later opens are cached.</p></div></div>`);
  try {
    const [result, identity] = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `${TRACKER_NAME}: reading configured provider usage`,
      cancellable: false,
    }, () => Promise.all([compute(), accountIdentity()]));
    panel.webview.html = renderDashboard(result, identity);
    output?.appendLine(`Dashboard populated: ${result.models.length} model(s), ${Math.round(result.totals.totalCredits)} credits`);
    return { title: panel.title, provider: result.provider, items: result.models.map((m) => m.model), diagnostics: result.diagnostics };
  } catch (e) {
    output?.appendLine(`Dashboard failed: ${e.stack || e.message}`);
    panel.webview.html = dashboardShell(`<header>${meterSvg}<div><h1>${TRACKER_NAME}</h1></div></header>
      <div class="warning"><strong>Unable to read usage:</strong> ${html(e.message)}</div>`);
    vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${e.message}`);
    throw e;
  }
}

async function show() {
  if (compactPick) {
    compactPick.show();
    return { title: compactPick.title, items: compactPick.items.map((item) => item.label) };
  }
  const qp = vscode.window.createQuickPick();
  compactPick = qp;
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = false;
  qp.title = TRACKER_NAME;
  qp.placeholder = 'Reading local usage…';
  let sortBy = vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('sortBy', 'tokens');
  const sortButton = { iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: 'Toggle ranking: tokens / credits' };
  const refreshButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh' };
  const closeButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Close' };
  qp.buttons = [sortButton, refreshButton, closeButton];
  let hidden = false;
  let loadGeneration = 0;
  let showAll = false;

  const load = async (force = false) => {
    const generation = ++loadGeneration;
    qp.busy = true;
    try {
      const preview = await refreshPreview(force);
      if (hidden || generation !== loadGeneration) return;
      if (preview.key !== previewKey()) return load();
      const r = preview.result;
      const t = r.totals;
      qp.title = `${TRACKER_NAME} · ${t.estCredits > 0.5 ? '≈' : ''}${credits(t.totalCredits)} credits`;
      qp.placeholder = `${(PROVIDERS[r.provider] || {}).label || r.provider} · ${day(r.cycle.start)}–${day(r.cycle.end)} UTC · ${sortBy} · local history`;
      const sorted = [...r.models].sort((a, b) => sortBy === 'credits'
        ? b.totalCredits - a.totalCredits : b.totalTokens - a.totalTokens);
      const rows = (showAll ? sorted : sorted.slice(0, 5)).map((model, i) => ({
        label: `${i + 1}. ${model.model}`,
        description: `${model.estCredits > 0.5 ? '≈' : ''}${credits(model.totalCredits)} credits · ${fmt(model.totalTokens)} tokens`,
        model,
      }));
      if (!rows.length) rows.push({ label: 'No usage recorded for this cycle yet' });
      if (!showAll && sorted.length > rows.length) {
        rows.push({ label: `$(list-unordered) Show all ${sorted.length} models`, expand: true });
      }
      const issueCount = (r.diagnostics.errors || []).length + (r.diagnostics.notes || []).length;
      if (issueCount) rows.unshift({ label: `$(warning) Partial data — ${issueCount} issue(s)`, alwaysShow: true });
      qp.items = rows;
    } catch (e) {
      if (!hidden && generation === loadGeneration) {
        qp.placeholder = `Failed to read usage: ${e.message}`;
        qp.items = [{ label: '$(warning) Usage could not be loaded. Use Refresh to retry.', alwaysShow: true }];
        vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${e.message}`);
      }
    } finally {
      if (!hidden && generation === loadGeneration) qp.busy = false;
    }
  };

  const subscriptions = [];
  subscriptions.push(qp.onDidTriggerButton(async (b) => {
    if (b === closeButton) { qp.hide(); return; }
    if (b === sortButton) sortBy = sortBy === 'tokens' ? 'credits' : 'tokens';
    await load(b === refreshButton);
  }));
  subscriptions.push(qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    if (sel?.expand) { showAll = true; await load(); return; }
    if (sel && sel.model) {
      await vscode.env.clipboard.writeText(`${sel.label}: ${sel.description}`);
      vscode.window.setStatusBarMessage(`Copied usage for ${sel.model.model}`, 3000);
    }
    qp.hide();
  }));
  subscriptions.push(qp.onDidHide(() => {
    hidden = true;
    if (compactPick === qp) compactPick = undefined;
    for (const subscription of subscriptions) subscription.dispose();
    qp.dispose();
  }));
  qp.show();
  await load();
  return { title: hidden ? TRACKER_NAME : qp.title, items: hidden ? [] : qp.items.map((i) => i.label) };
}

function activate(context) {
  const storageUri = context.globalStorageUri;
  if (!['file', 'vscode-userdata'].includes(storageUri.scheme) || storageUri.authority || !path.isAbsolute(storageUri.fsPath)) {
    throw new Error('This tracker requires local VS Code user storage');
  }
  extensionState = context.globalState;
  disposed = false;
  output = vscode.window.createOutputChannel(TRACKER_NAME);
  output.appendLine(`[${new Date().toISOString()}] extension activated`);
  currentUserDirs = [path.resolve(storageUri.fsPath, '..', '..')];
  statusItem = vscode.window.createStatusBarItem('aiUsageCreditsMeter.status', vscode.StatusBarAlignment.Right, 50);
  statusItem.name = TRACKER_NAME;
  statusItem.text = '$(pie-chart) Copilot usage';
  statusItem.tooltip = `${TRACKER_NAME} — reading the local summary.`;
  statusItem.command = 'aiUsageCreditsMeter.show';
  statusItem.accessibilityInformation = { label: TRACKER_NAME, role: 'button' };
  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('aiUsageCreditsMeter.connectAccount', () => connectAccount().catch((e) => {
      vscode.window.showErrorMessage(`GitHub sign-in was not completed: ${e.message}`);
    })),
    vscode.commands.registerCommand('aiUsageCreditsMeter.refresh', () => refreshPreview(true).catch((e) => {
      vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${e.message}`);
      throw e;
    })),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id !== 'github') return;
      workerClient?.stop(new Error('GitHub sign-in changed; the previous usage scan was cancelled'));
      invalidatePreview();
      refreshPreview().catch(() => { output?.appendLine('Could not refresh summary after GitHub sign-in changed'); });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('aiUsageCreditsMeter')) return;
      invalidatePreview();
      refreshPreview().catch(() => { output?.appendLine('Could not refresh summary after tracker settings changed'); });
    }),
    vscode.commands.registerCommand('aiUsageCreditsMeter.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('aiUsageCreditsMeter.selectProvider', () => selectProvider()),
    vscode.commands.registerCommand('aiUsageCreditsMeter.show', () => show()),
    vscode.commands.registerCommand('aiUsageCreditsMeter.compute', (sortBy) => compute(typeof sortBy === 'string' ? sortBy : undefined)),
  );
  statusItem.show();
  refreshPreview().catch(() => { output?.appendLine('Initial compact summary could not be loaded'); });
}

function deactivate() {
  disposed = true;
  previewGeneration += 1;
  latestPreview = undefined;
  previewRequest = undefined;
  compactPick?.hide();
  compactPick = undefined;
  statusItem?.dispose();
  statusItem = undefined;
  return workerClient?.dispose();
}

module.exports = { activate, deactivate };

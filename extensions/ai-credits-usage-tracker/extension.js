'use strict';
const path = require('path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const { UsageWorkerClient } = require('./lib/worker-client');
const { githubIdentity, connectGitHub } = require('./lib/github-identity');

const TRACKER_NAME = 'AI Credits Usage Tracker';
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const credits = (n) => Math.round(n).toLocaleString('en-US');
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const PROVIDERS = {
  both: {
    label: 'GitHub Copilot + Claude Code',
    description: 'Copilot credits plus local Claude Code tokens in separate sections; Claude appears only when its transcripts exist',
    icon: 'layers',
  },
  githubCopilot: { label: 'GitHub Copilot', description: 'Copilot Chat, agent-host, SDK and CLI local usage', icon: 'copilot' },
  claudeCode: { label: 'Claude Code', description: 'Claude Code (VS Code extension and CLI) local transcript usage, priced at API list rates', icon: 'claude' },
};
const DEFAULT_PROVIDER = 'both';
const configuredProvider = () => {
  const value = vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('provider', DEFAULT_PROVIDER);
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value) ? value : DEFAULT_PROVIDER;
};
// Only absolute directory strings are passed on; anything else in the setting is ignored. Windows device paths
// (\\.\ and \\?\) name devices and pipes rather than folders, so they are never scanned.
const WINDOWS_DEVICE_PATH = /^[\\/]{2}[.?][\\/]/;
const configuredClaudeDirs = () => {
  const value = vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('claudeConfigDirs', []);
  return Array.isArray(value)
    ? value.filter((dir) => typeof dir === 'string' && dir.length > 0 && dir.length <= 1024
      && path.isAbsolute(dir) && !WINDOWS_DEVICE_PATH.test(dir)).slice(0, 8)
    : [];
};
// Settings reach the worker through structured cloning, so only plain values of the documented shape are passed on.
const configuredSortBy = (value) => (value === 'credits' || value === 'tokens' ? value : 'tokens');
const configuredResetDay = () => {
  const value = vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('cycleResetDay', 1);
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value) || 1, 1), 28) : 1;
};
const sectionsOf = (result) => (result.provider === 'both' ? [result.githubCopilot, result.claudeCode] : [result]);
// Claude Code is listed only when its transcripts exist (or could not be read), so users without it see no empty section.
function visibleSections(result) {
  const sections = sectionsOf(result);
  if (result.provider !== 'both') return sections;
  const [copilot, claude] = sections;
  const claudeFound = claude.diagnostics.claudeTranscripts > 0 || claude.diagnostics.errors.length > 0 || claude.models.length > 0;
  const copilotFound = copilot.models.length > 0 || copilot.diagnostics.errors.length > 0;
  // Claude Code stands in for the Copilot section only when it has usage this cycle and Copilot has none.
  return [copilotFound || claude.models.length === 0 ? copilot : undefined, claudeFound ? claude : undefined].filter(Boolean);
}
const isClaude = (section) => section.provider === 'claudeCode';
const apiValue = (creditAmount) => (creditAmount > 0 ? `≈${usd(creditAmount)}` : 'n/a');
const byValue = (a, b) => (b.totalCredits - a.totalCredits) || (b.totalTokens - a.totalTokens);
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
  if (disposed) throw new Error('Usage tracker deactivated');
  if (!workerClient) workerClient = new UsageWorkerClient(path.join(__dirname, 'lib', 'worker.js'), {
    onError: () => {
      output?.appendLine('Usage worker cleanup failed');
      vscode.window.showErrorMessage(`${TRACKER_NAME} could not stop its worker. Reload the window before retrying.`);
    },
  });
  return workerClient.run(opts);
}

// After a failed combined scan, later scans read GitHub Copilot alone, so unreadable data from one provider cannot
// hide the other. A manual refresh or a settings/sign-in change tries the combined scan again.
let claudeScanFailed = false;
const isCancellation = (error) => /^(?:Usage scan was cancelled|GitHub sign-in changed|Usage tracker|Too many usage scans|Usage worker cleanup failed)/
  .test(String((error && error.message) || ''));

function unavailableClaudeSection(copilot) {
  const totals = {
    totalTokens: 0, exactTokens: 0, estTokens: 0, inputTokens: 0, outputTokens: 0, totalCredits: 0, exactCredits: 0,
    estCredits: 0, premiumRequests: 0, calls: 0, pendingCalls: 0, byTool: {},
  };
  return {
    provider: 'claudeCode', cycle: copilot.cycle, sortBy: copilot.sortBy, models: [], totals, unavailable: true,
    diagnostics: {
      errors: ['Claude Code usage could not be read in this scan, so only GitHub Copilot is shown. Use Refresh to retry.'],
      notes: [], claudeTranscripts: 0,
    },
  };
}

// A scan that was cancelled before it started (another scan stalled ahead of it and the worker was stopped) is run
// once more while it is still the current one; it is not evidence about the data it was meant to read.
async function runScan(options, provider, generation) {
  try {
    return await runAggregation({ ...options, provider });
  } catch (error) {
    if (disposed || generation !== previewGeneration || !/^Usage scan was cancelled/.test(String((error && error.message) || ''))) throw error;
    return runAggregation({ ...options, provider });
  }
}

async function compute(sortBy) {
  const generation = previewGeneration;
  const cfg = vscode.workspace.getConfiguration('aiUsageCreditsMeter');
  const options = {
    sortBy: configuredSortBy(sortBy || cfg.get('sortBy', 'tokens')),
    resetDay: configuredResetDay(),
    claudeDirs: configuredClaudeDirs(),
    vscodeUserDirs: currentUserDirs,
  };
  const provider = configuredProvider();
  if (provider !== 'both') return runScan(options, provider, generation);
  if (!claudeScanFailed) {
    try {
      return await runScan(options, provider, generation);
    } catch (error) {
      if (disposed || isCancellation(error)) throw error;
      // Only a scan made under the current settings may switch later scans to Copilot alone.
      if (generation === previewGeneration) claudeScanFailed = true;
      output?.appendLine('The combined usage scan failed; reading GitHub Copilot alone');
    }
  }
  const copilot = await runScan(options, 'githubCopilot', generation);
  return {
    provider: 'both', cycle: copilot.cycle, sortBy: copilot.sortBy,
    githubCopilot: copilot, claudeCode: unavailableClaudeSection(copilot),
  };
}

async function selectProvider() {
  const cfg = vscode.workspace.getConfiguration('aiUsageCreditsMeter');
  const current = configuredProvider();
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
  if (configuredProvider() === 'claudeCode') {
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
const markdownText = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()#+.!|<>:]/g, '\\$&');
// Local paths, user names and stack traces stay out of the UI: only the first line is kept and any path is reduced
// to its last segment. Model names are shortened and cannot render $(icon) glyphs.
const PATH_PATTERN = /(?<![\w.:])(?:[A-Za-z]:)?[\\/](?=[^\s\\/])(?:[^\\/'"`<>|\r\n]+[\\/])+[^\\/'"`<>|\r\n]*/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
// Text is shortened on a code-point boundary so a surrogate pair is never split.
const clip = (text, limit) => {
  if (text.length <= limit) return text;
  const end = /[\ud800-\udbff]/.test(text[limit - 2]) ? limit - 2 : limit - 1;
  return `${text.slice(0, end)}…`;
};
const displayText = (value, limit = 200) => clip(
  String(value).split(/\r?\n/, 1)[0].replace(PATH_PATTERN, (match) => match.split(/[\\/]/).pop()).replace(CONTROL_CHARS, ' '),
  limit,
);
const modelText = (name, limit = 80) => clip(String(name).replace(CONTROL_CHARS, ''), limit);
const iconSafe = (text) => String(text).replace(/\$\(/g, '\\$(');
const previewKey = () => JSON.stringify({
  provider: configuredProvider(),
  resetDay: configuredResetDay(),
  claudeDirs: configuredClaudeDirs(),
  accountId: extensionState.get('githubAccountId'),
});

function hoverSection(section) {
  const label = markdownText((PROVIDERS[section.provider] || { label: section.provider }).label);
  const heading = `${label} · ${day(section.cycle.start)}–${day(section.cycle.end)} UTC`;
  if (section.unavailable) return [heading, '**Not available in this scan**'];
  const ranked = [...section.models].sort(byValue).slice(0, 5);
  if (isClaude(section)) {
    const lines = [
      heading,
      `**${fmt(section.totals.totalTokens)} tokens** · ${apiValue(section.totals.totalCredits)} API value`,
      '',
      '| Highest-used model | Tokens | API value |',
      '| :--- | ---: | ---: |',
    ];
    for (const model of ranked) lines.push(`| ${markdownText(modelText(model.model))} | ${fmt(model.totalTokens)} | ${apiValue(model.totalCredits)} |`);
    if (!ranked.length) lines.push('| No usage recorded this cycle | — | — |');
    return lines;
  }
  const hasEstimate = section.totals.estCredits > 0.5;
  const lines = [
    heading,
    `**${hasEstimate ? '≈' : ''}${credits(section.totals.totalCredits)} credits** · ${fmt(section.totals.totalTokens)} tokens`,
    '',
    '| Highest-used model | Credits |',
    '| :--- | ---: |',
  ];
  for (const model of ranked) lines.push(`| ${markdownText(modelText(model.model))} | ${model.estCredits > 0.5 ? '≈' : ''}${credits(model.totalCredits)} |`);
  if (!ranked.length) lines.push('| No usage recorded yet | — |');
  return lines;
}

function hoverSummary(result, identity) {
  const sections = visibleSections(result);
  const lines = [`**${TRACKER_NAME}**`];
  if (sections.length > 1) lines.push('');
  sections.forEach((section, index) => {
    if (index > 0) lines.push('', '---', '');
    lines.push(...hoverSection(section));
  });
  // One issue per section, errors before notes, so a routine Copilot note never hides a Claude Code problem.
  for (const section of sections) {
    const [first] = [...(section.diagnostics.errors || []), ...(section.diagnostics.notes || [])];
    if (first === undefined) continue;
    const source = sections.length > 1 ? ` (${markdownText((PROVIDERS[section.provider] || {}).label || section.provider)})` : '';
    lines.push('', `⚠ Partial data${source}: ${markdownText(displayText(first))}`);
  }
  if (sections.some((section) => !isClaude(section))) {
    if (identity.status === 'signedIn') lines.push('', `GitHub account: ${markdownText(identity.label)}`);
    else lines.push('', markdownText(identity.label));
  } else {
    lines.push('', 'Local Claude Code transcripts on this device');
  }
  lines.push('');
  if (sections.some(isClaude)) {
    lines.push('*Claude Code values are API list-price estimates from local transcripts, not subscription charges or limits. Transcripts under-report output tokens, so treat them as a lower bound.*', '');
  }
  lines.push('*Local device history, not an account-wide bill. Click for a compact list.*');
  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.isTrusted = false;
  tooltip.supportHtml = false;
  return tooltip;
}

function statusLabel(result) {
  const [primary] = visibleSections(result);
  return isClaude(primary)
    ? `$(pie-chart) Claude ${fmt(primary.totals.totalTokens)} tokens`
    : `$(pie-chart) Copilot ${fmt(primary.totals.totalCredits)} credits`;
}

function invalidatePreview() {
  previewGeneration += 1;
  latestPreview = undefined;
  previewRequest = undefined;
  claudeScanFailed = false;
  if (statusItem) {
    statusItem.text = '$(pie-chart) Copilot usage';
    statusItem.tooltip = `${TRACKER_NAME} — click for usage; the summary refreshes when opened.`;
  }
}

async function refreshPreview(force = false) {
  if (force) claudeScanFailed = false;
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
      statusItem.text = statusLabel(result);
      statusItem.tooltip = hoverSummary(result, identity);
      output?.appendLine(`Compact summary ready: ${visibleSections(result).map((s) => `${s.models.length} ${s.provider} model(s)`).join(', ')}`);
    }
    return preview;
  }, (error) => {
    if (!disposed && generation === previewGeneration) {
      statusItem.text = '$(warning) Copilot usage';
      statusItem.tooltip = `${TRACKER_NAME} — unable to load usage: ${displayText(error.message)}. Click to retry.`;
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
  h2 { margin: 34px 0 14px; font-size: 18px; font-weight: 600; }
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

function dashboardSection(section, heading) {
  const t = section.totals;
  const claude = isClaude(section);
  const issues = [...(section.diagnostics.errors || []), ...(section.diagnostics.notes || [])];
  const warning = issues.length
    ? `<div class="warning"><strong>Incomplete data:</strong> ${html(issues.slice(0, 5).map((issue) => displayText(issue)).join(' · '))}${issues.length > 5 ? ` · +${issues.length - 5} more` : ''}</div>`
    : '';
  if (section.unavailable) return `${heading}${warning}<p class="source">Usage could not be read in this scan. Run Refresh to try again.</p>`;
  const rows = section.models.map((m, i) => {
    const approximate = !claude && m.estCredits > 0.5 ? '≈' : '';
    const sources = Object.entries(m.byTool || {}).filter(([, c]) => c > 0.005)
      .sort((a, b) => b[1] - a[1]).map(([tool, c]) => `${tool} ${fmt(c)}`).join(' · ');
    const name = `<td class="num">${i + 1}</td><td><div class="model">${html(modelText(m.model))}</div><div class="source">${html(sources || m.sources.join(', '))}</div></td>`;
    return claude
      ? `<tr>${name}<td class="num">${html(fmt(m.totalTokens))}</td><td class="num">${html(apiValue(m.totalCredits))}</td><td class="num">${html(m.calls)}</td></tr>`
      : `<tr>${name}
      <td class="num">${approximate}${html(fmt(m.totalTokens))}</td><td class="num">${approximate}${html(credits(m.totalCredits))}</td>
      <td class="num">${html(usd(m.totalCredits))}</td><td class="num">${html(m.calls)}</td></tr>`;
  }).join('');
  const metrics = claude
    ? `<div class="metric"><strong>${html(fmt(t.totalTokens))}</strong><span>tokens (including cache)</span></div>
      <div class="metric"><strong>${html(apiValue(t.totalCredits))}</strong><span>API list-price value</span></div>
      <div class="metric"><strong>${html(t.calls)}</strong><span>assistant messages</span></div>`
    : `<div class="metric"><strong>≈${html(fmt(t.totalTokens))}</strong><span>tokens</span></div>
      <div class="metric"><strong>${t.estCredits > 0.5 ? '≈' : ''}${html(credits(t.totalCredits))}</strong><span>AI credits</span></div>
      <div class="metric"><strong>${html(usd(t.totalCredits))}</strong><span>estimated list cost</span></div>
      <div class="metric"><strong>${html(t.calls)}</strong><span>completed calls</span></div>`;
  const columns = claude
    ? '<th class="num">#</th><th>Model</th><th class="num">Tokens</th><th class="num">API value</th><th class="num">Messages</th>'
    : '<th class="num">#</th><th>Model</th><th class="num">Tokens</th><th class="num">Credits</th><th class="num">Cost</th><th class="num">Calls</th>';
  return `${heading}${warning}<section class="summary" aria-label="Billing-cycle totals">${metrics}</section>
    <table><caption>Usage by model</caption><thead><tr>${columns}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${claude ? 5 : 6}">No usage found for this billing cycle.</td></tr>`}</tbody></table>`;
}

function renderDashboard(result, identity) {
  const sections = visibleSections(result);
  const labels = sections.map((s) => (PROVIDERS[s.provider] || { label: s.provider || 'Configured provider' }).label).join(' + ');
  const { cycle, sortBy } = sections[0];
  const body = sections.map((section) => dashboardSection(
    section,
    sections.length > 1 ? `<h2>${html((PROVIDERS[section.provider] || {}).label || section.provider)}</h2>` : '',
  )).join('');
  const hasCopilot = sections.some((s) => !isClaude(s));
  return dashboardShell(`<header>${meterSvg}<div><h1>${TRACKER_NAME}</h1>
    <p class="subtitle">${html(labels)} · ${html(day(cycle.start))} – ${html(day(cycle.end))} UTC · ranked by ${html(sortBy)}</p></div></header>
    ${hasCopilot
    ? `<p id="github-identity" class="source">${identity ? html(identity.status === 'signedIn' ? `VS Code GitHub account: ${identity.label}` : identity.label) : ''}</p>`
    : '<p id="github-identity" class="source">Local Claude Code transcripts on this device</p>'}
    ${hasCopilot ? '<p class="source">Local device usage, not an account-wide bill. Untagged historical requests cannot be attributed to a GitHub account.</p>' : ''}
    ${sections.some(isClaude) ? '<p class="source">Claude Code values are API list-price estimates from local transcripts, not subscription charges or limits. Transcripts under-report output tokens, so treat them as a lower bound.</p>' : ''}
    ${body}`);
}

async function openDashboard() {
  const providerId = configuredProvider();
  const provider = PROVIDERS[providerId];
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
    const sections = visibleSections(result);
    output?.appendLine(`Dashboard populated: ${sections.map((s) => `${s.models.length} ${s.provider} model(s)`).join(', ')}`);
    return {
      title: panel.title, provider: result.provider,
      items: sections.flatMap((s) => s.models.map((m) => m.model)),
      diagnostics: sections.map((s) => s.diagnostics),
    };
  } catch (e) {
    output?.appendLine(`Dashboard failed: ${e.stack || e.message}`);
    panel.webview.html = dashboardShell(`<header>${meterSvg}<div><h1>${TRACKER_NAME}</h1></div></header>
      <div class="warning"><strong>Unable to read usage:</strong> ${html(displayText(e.message))}</div>`);
    vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${displayText(e.message)}`);
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
  let sortBy = configuredSortBy(vscode.workspace.getConfiguration('aiUsageCreditsMeter').get('sortBy', 'tokens'));
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
      const sections = visibleSections(r);
      const multiple = sections.length > 1;
      const headline = (section) => (isClaude(section)
        ? (section.unavailable ? 'Claude unavailable' : `${multiple ? 'Claude ' : ''}${fmt(section.totals.totalTokens)} tokens`)
        : `${section.totals.estCredits > 0.5 ? '≈' : ''}${credits(section.totals.totalCredits)} credits`);
      qp.title = `${TRACKER_NAME} · ${sections.map(headline).join(' · ')}`;
      const labels = sections.map((s) => (PROVIDERS[s.provider] || {}).label || s.provider).join(' + ');
      qp.placeholder = `${labels} · ${day(sections[0].cycle.start)}–${day(sections[0].cycle.end)} UTC · ${sortBy} · local history`;
      const describe = (section, model) => (isClaude(section)
        ? `${fmt(model.totalTokens)} tokens · ${apiValue(model.totalCredits)} API value`
        : `${model.estCredits > 0.5 ? '≈' : ''}${credits(model.totalCredits)} credits · ${fmt(model.totalTokens)} tokens`);
      const rows = [];
      let modelCount = 0;
      let shownCount = 0;
      for (const section of sections) {
        const sorted = [...section.models].sort((a, b) => sortBy === 'credits'
          ? b.totalCredits - a.totalCredits : b.totalTokens - a.totalTokens);
        const shown = showAll ? sorted : sorted.slice(0, 5);
        modelCount += sorted.length;
        shownCount += shown.length;
        const sectionLabel = (PROVIDERS[section.provider] || {}).label || section.provider;
        if (multiple) {
          rows.push({
            label: isClaude(section) ? `${sectionLabel} · API list-price estimates` : sectionLabel,
            kind: vscode.QuickPickItemKind.Separator,
          });
        }
        shown.forEach((model, i) => {
          const plain = `${i + 1}. ${modelText(model.model)}`;
          const label = iconSafe(plain);
          const description = describe(section, model);
          rows.push({ label, description, model, copyText: `${multiple ? `${sectionLabel} ` : ''}${plain}: ${description}` });
        });
        if (!shown.length) {
          rows.push({
            label: section.unavailable
              ? '$(warning) Claude Code usage could not be read in this scan'
              : `No ${isClaude(section) ? 'Claude Code ' : ''}usage recorded for this cycle yet`,
          });
        }
      }
      if (!showAll && modelCount > shownCount) {
        rows.push({ label: `$(list-unordered) Show all ${modelCount} models`, expand: true });
      }
      const issueCount = sections.reduce((n, s) => n + (s.diagnostics.errors || []).length + (s.diagnostics.notes || []).length, 0);
      if (issueCount) rows.unshift({ label: `$(warning) Partial data — ${issueCount} issue(s)`, alwaysShow: true });
      qp.items = rows;
    } catch (e) {
      if (!hidden && generation === loadGeneration) {
        qp.placeholder = `Failed to read usage: ${displayText(e.message)}`;
        qp.items = [{ label: '$(warning) Usage could not be loaded. Use Refresh to retry.', alwaysShow: true }];
        vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${displayText(e.message)}`);
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
      await vscode.env.clipboard.writeText(sel.copyText);
      vscode.window.setStatusBarMessage(`Copied usage for ${iconSafe(modelText(sel.model.model))}`, 3000);
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
      vscode.window.showErrorMessage(`GitHub sign-in was not completed: ${displayText(e.message)}`);
    })),
    vscode.commands.registerCommand('aiUsageCreditsMeter.refresh', () => refreshPreview(true).catch((e) => {
      vscode.window.showErrorMessage(`${TRACKER_NAME} failed: ${displayText(e.message)}`);
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
  claudeScanFailed = false;
  compactPick?.hide();
  compactPick = undefined;
  statusItem?.dispose();
  statusItem = undefined;
  const worker = workerClient;
  workerClient = undefined;
  return worker?.dispose();
}

module.exports = { activate, deactivate };

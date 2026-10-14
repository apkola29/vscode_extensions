'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TITLE = 'GH Copilot Usage Tracker';
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const codeExe = process.env.VSCODE_EXE || path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
const vsixIndex = process.argv.indexOf('--vsix');
const vsix = vsixIndex >= 0 ? path.resolve(process.argv[vsixIndex + 1]) : undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Set([undefined]);
    this.contexts = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context;
        this.contexts.set(`${message.sessionId || ''}:${context.id}`, { sessionId: message.sessionId, contextId: context.id });
      }
      if (message.method === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(`${message.sessionId || ''}:${message.params.executionContextId}`);
      }
      if (message.method === 'Runtime.executionContextsCleared') {
        for (const [key, context] of this.contexts) if (context.sessionId === message.sessionId) this.contexts.delete(key);
      }
      if (message.method === 'Target.attachedToTarget') {
        const sessionId = message.params.sessionId;
        this.sessions.add(sessionId);
        this.send('Runtime.enable', {}, sessionId).catch((e) => console.error(`Runtime attachment: ${e.message}`));
      }
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('CDP socket closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate(expression, sessionId, contextId) {
    const result = await this.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async shortcut(key, code, modifiers, windowsVirtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(fn, timeout, description) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-toolbar-'));
  const port = await freePort();
  const userData = path.join(tmp, 'user-data');
  const extensionsDir = path.join(tmp, 'extensions');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete env[key];
  if (vsix) {
    const quote = (s) => `"${s}"`;
    const install = [path.join(path.dirname(codeExe), 'bin', 'code.cmd'), '--user-data-dir', userData,
      '--extensions-dir', extensionsDir, '--install-extension', vsix, '--force', '--do-not-sync'].map(quote).join(' ');
    const installed = cp.spawnSync(install, { env, shell: true, encoding: 'utf8' });
    if (installed.status !== 0) throw new Error(`Isolated VSIX install failed: ${installed.stderr || installed.stdout}`);
  }
  const child = cp.spawn(codeExe, [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    ...(!vsix ? [`--extensionDevelopmentPath=${root}`] : []),
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-telemetry', '--disable-updates', '--new-window',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupOutput = '';
  const retainStartupOutput = (chunk) => { startupOutput = (startupOutput + chunk.toString()).slice(-3000); };
  child.stdout.on('data', retainStartupOutput);
  child.stderr.on('data', retainStartupOutput);
  let cdp;
  let passed = false;
  let result;
  try {
    const page = await until(async () => {
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Isolated VS Code exited during startup (${child.exitCode}): ${startupOutput}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const pages = await response.json();
        return pages.find((p) => p.type === 'page' && /workbench\.html/.test(p.url));
      } catch (e) {
        if (e.cause?.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNRESET') return null;
        throw e;
      }
    }, 90000, 'the isolated VS Code renderer');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await until(() => cdp.evaluate(`!!document.querySelector('.monaco-workbench')`), 60000, 'the workbench');
    const buttonExpression = `(() => {
      const button = Array.from(document.querySelectorAll('.statusbar-item'))
        .find(e => e.id.includes('aiUsageCreditsMeter.status') || e.id.includes(${JSON.stringify(extensionId)})
          || e.getAttribute('aria-label') === ${JSON.stringify(TITLE)}
          || Array.from(e.querySelectorAll('[aria-label]')).some(child => child.getAttribute('aria-label') === ${JSON.stringify(TITLE)}));
      if (!button) return null;
      const r = button.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, name: button.getAttribute('aria-label') || button.title,
        loading: !!button.querySelector('.codicon-loading') };
    })()`;
    const button = await until(async () => {
      const value = await cdp.evaluate(buttonExpression);
      return value && !value.loading ? value : null;
    }, 150000, 'the status-bar tracker summary');
    const layoutExpression = `(() => {
      const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0
        && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
      return { panelVisible: visible(document.querySelector('.part.panel')),
        editorTabs: Array.from(document.querySelectorAll('.tabs-container .tab')).map(e => e.textContent) };
    })()`;
    const initialLayout = await cdp.evaluate(layoutExpression);
    console.log('Hovering the native GitHub Copilot usage status item');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    const hoverExpression = `(() => {
      const hover = Array.from(document.querySelectorAll('.monaco-hover')).find(e =>
        e.getBoundingClientRect().width > 0 && e.textContent.includes(${JSON.stringify(TITLE)}));
      if (!hover) return null;
      return { provider: hover.textContent.includes('GitHub Copilot'), topModels: hover.querySelectorAll('tbody tr').length,
        deviceScope: hover.textContent.includes('not an account-wide bill'), height: hover.getBoundingClientRect().height };
    })()`;
    const hover = await until(() => cdp.evaluate(hoverExpression), 15000, 'the small native hover table');
    assert.equal(hover.provider, true);
    assert.equal(hover.deviceScope, true);
    assert.ok(hover.topModels > 0 && hover.topModels <= 5);
    assert.ok(hover.height < 600);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 80, y: 80 });
    await until(async () => !(await cdp.evaluate(hoverExpression)), 10000, 'hover dismissal when the pointer leaves');
    const click = async (coordinates) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coordinates.x, y: coordinates.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coordinates.x, y: coordinates.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coordinates.x, y: coordinates.y, button: 'left', clickCount: 1 });
    };
    const popupExpression = `(() => {
      const popup = document.querySelector('.quick-input-widget');
      if (!popup || getComputedStyle(popup).display === 'none' || !popup.getBoundingClientRect().height) return null;
      if (!popup.textContent.includes(${JSON.stringify(TITLE)})) return null;
      const close = Array.from(popup.querySelectorAll('.action-label')).find(e => e.title === 'Close' || e.getAttribute('aria-label') === 'Close');
      const r = close?.getBoundingClientRect();
      return { height: popup.getBoundingClientRect().height,
        creditRows: Array.from(popup.querySelectorAll('.monaco-list-row')).filter(e => e.textContent.includes('credits')).length,
        close: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null };
    })()`;
    console.log('Clicking the actual status item, then exercising close, Escape and click-away');
    await click(button);
    const popup = await until(async () => {
      const value = await cdp.evaluate(popupExpression);
      return value?.creditRows ? value : null;
    }, 30000, 'the compact usage popup');
    assert.ok(popup.height < 600);
    assert.ok(popup.creditRows > 0 && popup.creditRows <= 5);
    assert.ok(popup.close);
    assert.deepEqual(await cdp.evaluate(layoutExpression), initialLayout, 'Opening the popup must not reveal a panel or change editors');
    await click(popup.close);
    await until(async () => !(await cdp.evaluate(popupExpression)), 10000, 'close-button dismissal');
    await click(button);
    await until(() => cdp.evaluate(popupExpression), 10000, 'the reopened popup');
    await cdp.shortcut('Escape', 'Escape', 0, 27);
    await until(async () => !(await cdp.evaluate(popupExpression)), 10000, 'Escape dismissal');
    await click(button);
    await until(() => cdp.evaluate(popupExpression), 10000, 'the popup before click-away');
    await click({ x: 100, y: 100 });
    await until(async () => !(await cdp.evaluate(popupExpression)), 10000, 'click-away dismissal');
    assert.deepEqual(await cdp.evaluate(layoutExpression), initialLayout);
    result = { passed: true, mode: vsix ? 'installed-vsix' : 'source',
      nativeHover: hover, hoverDismissesOnMouseLeave: true,
      compactPopup: { creditRows: popup.creditRows, height: popup.height },
      closeButtonWorks: true, escapeCloses: true, clickAwayCloses: true, noPanelOrEditorOpened: true };
    passed = true;
  } catch (error) {
    if (cdp) {
      try {
        const diagnostic = await cdp.evaluate(`({
          statusItems: Array.from(document.querySelectorAll('.statusbar-item')).map(e => ({
            id: e.id, className: e.className, visible: e.getBoundingClientRect().width > 0,
            tracker: e.textContent.includes('credits')
          })),
          trackerTooltipVisible: Array.from(document.querySelectorAll('.monaco-hover')).some(e => e.textContent.includes(${JSON.stringify(TITLE)}))
        })`);
        fs.writeFileSync(path.join(tmp, 'ui-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
      } catch (diagnosticError) { console.error(`Could not capture scoped UI diagnostic: ${diagnosticError.message}`); }
    }
    throw error;
  } finally {
    const escapedTmp = tmp.replace(/'/g, "''");
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Record ownership before closing Chromium. Match creation times again before stopping anything so a
    // reused PID can never cause an unrelated user's process to be terminated.
    const inspect = cp.spawnSync(powershell, ['-NoProfile', '-Command', `
      $ErrorActionPreference='Stop'
      $all=@(Get-CimInstance Win32_Process)
      $owned=[System.Collections.Generic.HashSet[int]]::new()
      foreach($p in $all) {
        if($p.Name -eq 'Code.exe' -and $p.CommandLine -and $p.CommandLine.IndexOf('${escapedTmp}',[StringComparison]::OrdinalIgnoreCase) -ge 0) {[void]$owned.Add([int]$p.ProcessId)}
      }
      do {
        $changed=$false
        foreach($p in $all) {
          if($owned.Contains([int]$p.ParentProcessId) -and $owned.Add([int]$p.ProcessId)) {$changed=$true}
        }
      } while($changed)
      $records=@($all | Where-Object {$owned.Contains([int]$_.ProcessId)} | ForEach-Object {
        @{id=[int]$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o')}
      })
      ConvertTo-Json -InputObject $records -Compress
      exit 0
    `], { encoding: 'utf8', windowsHide: true });
    const owned = inspect.status === 0 ? JSON.parse(inspect.stdout.trim()) : [];
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (e) {
        if (!/closed|timeout/i.test(e.message)) console.error(`Closing isolated browser: ${e.message}`);
      }
    }
    await sleep(2000);
    if (inspect.status !== 0) throw new Error(`Could not identify isolated test processes: ${inspect.stderr || inspect.error?.message}`);
    const stop = cp.spawnSync(powershell, ['-NoProfile', '-Command', `
      $ErrorActionPreference='Stop'
      $all=@(Get-CimInstance Win32_Process)
      $records=ConvertFrom-Json '${JSON.stringify(owned)}'
      foreach($record in $records) {
        $p=$all | Where-Object {$_.ProcessId -eq $record.id}
        if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $record.created) {
          try {Stop-Process -Id $record.id -ErrorAction Stop}
          catch {
            if(Get-Process -Id $record.id -ErrorAction SilentlyContinue) {throw}
          }
        }
      }
      exit 0
    `], { encoding: 'utf8', windowsHide: true });
    if (stop.status !== 0) throw new Error(`Could not stop isolated test processes: ${stop.stderr || stop.error?.message}`);
    await sleep(1500);
    if (passed) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 });
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) throw e;
        const cleaned = cp.spawnSync(powershell, ['-NoProfile', '-Command', `
          $ErrorActionPreference='Stop'
          $target='${escapedTmp}'
          for($attempt=0;$attempt -lt 10;$attempt++) {
            if(-not (Test-Path -LiteralPath $target)){exit 0}
            try {Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop; exit 0}
            catch {if($attempt -eq 9){throw}; Start-Sleep -Milliseconds 500}
          }
        `], { encoding: 'utf8', windowsHide: true });
        if (cleaned.status !== 0 || fs.existsSync(tmp)) throw new Error(`Could not remove isolated test data: ${cleaned.stderr || e.message}`);
      }
      console.log(JSON.stringify({ ...result, isolatedProcessesStopped: true }, null, 2));
    } else console.error(`Toolbar reproduction logs retained at ${tmp}`);
  }
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });

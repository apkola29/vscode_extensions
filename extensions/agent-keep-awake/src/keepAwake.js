// @ts-check
'use strict';

/**
 * OS-level "keep the machine awake" backend.
 *
 * Pure Node.js (no `vscode` import) so it can be unit-tested and verified on real
 * operating systems outside of VS Code. It holds a power request through a tiny,
 * OS-provided helper process that:
 *   - uses ~0% CPU (it blocks on I/O; there is no polling),
 *   - never changes power settings (nothing to restore if anything goes wrong),
 *   - dies on its own if VS Code dies (no orphaned sleep blockers):
 *       Windows: PowerShell calls SetThreadExecutionState, then waits for stdin EOF.
 *       macOS:   `caffeinate -i -w <pid>` exits when the extension host exits.
 *       Linux:   `systemd-inhibit` / `gnome-session-inhibit` run `cat`, which exits on stdin EOF.
 */

const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const READY_TOKEN = 'READY';
const WHO = 'VS Code (Agent Keep-Awake)';
const WHY = 'Keeping the machine awake while AI agents work in VS Code';

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_DISPLAY_REQUIRED = 0x00000002;

/**
 * @typedef {'off' | 'starting' | 'on' | 'error'} KeepAwakeState
 *
 * @typedef {object} HelperSpec
 * @property {string} id            Short name used in logs, e.g. "powershell".
 * @property {string} command       Executable to spawn.
 * @property {string[]} args
 * @property {boolean} waitForReady When true the helper prints READY once the request is held.
 *
 * @typedef {object} PlatformInfo
 * @property {NodeJS.Platform} platform
 * @property {boolean} display      Also keep the display on.
 * @property {number} pid           PID to watch (the extension host).
 * @property {NodeJS.ProcessEnv} env
 * @property {(p: string) => boolean} exists
 */

/**
 * PowerShell script that holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED (| ES_DISPLAY_REQUIRED) on its
 * main thread until stdin closes. P/Invoke is defined with Reflection.Emit, so nothing is
 * compiled or written to disk. The working set is trimmed twice once the process is idle
 * (just after start-up and again after PowerShell's deferred start-up work) so the idle helper
 * stays at a few MB. Contains no double quotes, which keeps command-line quoting trivial.
 * @param {boolean} display
 */
function windowsScript(display) {
  const flags = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (display ? ES_DISPLAY_REQUIRED : 0)) >>> 0;
  const pinvoke = (/** @type {string} */ name, /** @type {string} */ ret, /** @type {string} */ arg) =>
    `$t.DefinePInvokeMethod('${name}','kernel32.dll',$m,[Reflection.CallingConventions]::Standard,[${ret}],[Type[]]@([${arg}]),` +
    `[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Auto).SetImplementationFlags('PreserveSig')`;
  return [
    "$ErrorActionPreference='Stop'",
    "$b=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly((New-Object Reflection.AssemblyName('AgentKeepAwake')),[Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "$t=$b.DefineDynamicModule('AgentKeepAwake').DefineType('AgentKeepAwake.Native','Public,Abstract,Sealed')",
    "$m=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl,HideBySig'",
    pinvoke('SetThreadExecutionState', 'uint32', 'uint32'),
    pinvoke('K32EmptyWorkingSet', 'bool', 'IntPtr'),
    '$n=$t.CreateType()',
    `if($n::SetThreadExecutionState([uint32]${flags}) -eq 0){[Console]::Error.WriteLine('SetThreadExecutionState failed');exit 3}`,
    `[Console]::Out.WriteLine('${READY_TOKEN}');[Console]::Out.Flush()`,
    '$i=[Console]::OpenStandardInput();$r=$i.ReadAsync((New-Object byte[] 1),0,1)',
    'foreach($w in 2000,45000,-1){if($r.Wait($w)){break};[GC]::Collect();[void]$n::K32EmptyWorkingSet([IntPtr](-1))}'
  ].join(';');
}

/**
 * Finds an executable on PATH (or returns undefined).
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string) => boolean} exists
 * @param {NodeJS.Platform} platform
 */
function which(name, env, exists, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH || env.Path || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    const candidate = pathApi.join(dir, name);
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Works out which helper process(es) to run on this OS.
 * @param {PlatformInfo} info
 * @returns {{ helpers: HelperSpec[], error?: string }}
 */
function buildHelpers(info) {
  const { platform, display, pid, env, exists } = info;

  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    const candidates = [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
    let command = candidates.find(exists) || which('powershell.exe', env, exists, platform) || which('pwsh.exe', env, exists, platform);
    if (!command) {
      return { helpers: [], error: 'Windows PowerShell (powershell.exe) was not found.' };
    }
    return {
      helpers: [{
        id: 'powershell',
        command,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsScript(display)],
        waitForReady: true
      }]
    };
  }

  if (platform === 'darwin') {
    const command = ['/usr/bin/caffeinate'].find(exists) || which('caffeinate', env, exists, platform);
    if (!command) {
      return { helpers: [], error: 'caffeinate was not found (it ships with macOS in /usr/bin).' };
    }
    return {
      helpers: [{ id: 'caffeinate', command, args: ['-i', ...(display ? ['-d'] : []), '-w', String(pid)], waitForReady: false }]
    };
  }

  // Linux and other Unix-likes. Inside a Flatpak sandbox the host tools are reached through flatpak-spawn.
  const flatpak = Boolean(env.FLATPAK_ID) || exists('/.flatpak-info');
  /** @type {HelperSpec[]} */
  const helpers = [];
  /** @param {string} id @param {string[]} args */
  const add = (id, args) => {
    if (flatpak) {
      helpers.push({ id, command: 'flatpak-spawn', args: ['--host', '--watch-bus', id, ...args], waitForReady: false });
      return;
    }
    const command = which(id, env, exists, platform);
    if (command) {
      helpers.push({ id, command, args, waitForReady: false });
    }
  };
  // systemd-logind: honoured by logind itself, KDE Plasma, and most non-GNOME desktops.
  add('systemd-inhibit', [`--what=${display ? 'sleep:idle' : 'sleep'}`, `--who=${WHO}`, `--why=${WHY}`, '--mode=block', 'cat']);
  // GNOME (and GNOME-session based desktops) decide on automatic suspend from session inhibitors.
  add('gnome-session-inhibit', ['--app-id', 'code', '--reason', WHY, '--inhibit', display ? 'suspend:idle' : 'suspend', 'cat']);
  if (helpers.length === 0) {
    return { helpers, error: 'Neither systemd-inhibit nor gnome-session-inhibit was found on this system.' };
  }
  return { helpers };
}

/**
 * @typedef {object} KeepAwakeOptions
 * @property {NodeJS.Platform} [platform]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [pid]
 * @property {(p: string) => boolean} [exists]
 * @property {typeof childProcess.spawn} [spawn]
 * @property {(level: 'info' | 'warn' | 'error' | 'debug', message: string) => void} [log]
 * @property {typeof setTimeout} [setTimer]
 * @property {typeof clearTimeout} [clearTimer]
 * @property {() => number} [now]
 * @property {number} [readyGraceMs]      Helpers without a READY token count as holding once alive this long.
 * @property {number} [readyTimeoutMs]    Give up waiting for READY after this long and retry.
 * @property {number} [healthyAfterMs]    A helper alive this long resets its failure count.
 * @property {number} [maxQuickFailures]  Consecutive start-up failures before a helper is given up on.
 * @property {number} [retryBaseMs]
 * @property {number} [retryMaxMs]
 */

/**
 * @typedef {object} HelperRun
 * @property {HelperSpec} spec
 * @property {import('child_process').ChildProcess | undefined} child
 * @property {boolean} ready
 * @property {number} startedAt
 * @property {number} failures
 * @property {'running' | 'retrying' | 'failed'} status
 * @property {string} lastError
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 */

class KeepAwake extends EventEmitter {
  /** @param {KeepAwakeOptions} [options] */
  constructor(options = {}) {
    super();
    this._platform = options.platform || process.platform;
    this._env = options.env || process.env;
    this._pid = options.pid || process.pid;
    this._exists = options.exists || ((/** @type {string} */ p) => { try { return fs.existsSync(p); } catch { return false; } });
    this._spawn = options.spawn || childProcess.spawn;
    this._log = options.log || (() => { /* silent */ });
    this._setTimer = options.setTimer || setTimeout;
    this._clearTimer = options.clearTimer || clearTimeout;
    this._now = options.now || Date.now;
    this._readyGraceMs = options.readyGraceMs ?? 1000;
    this._readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
    this._healthyAfterMs = options.healthyAfterMs ?? 60_000;
    this._maxQuickFailures = options.maxQuickFailures ?? 5;
    this._retryBaseMs = options.retryBaseMs ?? 1000;
    this._retryMaxMs = options.retryMaxMs ?? 60_000;

    this._wanted = false;
    this._display = false;
    /** @type {Map<string, HelperRun>} */
    this._runs = new Map();
    /** Helpers that failed in a way retrying will not fix (e.g. not installed), with the reason. */
    /** @type {Map<string, string>} */
    this._unavailable = new Map();
    /** @type {KeepAwakeState} */
    this._state = 'off';
    this._error = '';
    this._disposed = false;
    this._generation = 0;
  }

  /** @returns {KeepAwakeState} */
  get state() { return this._state; }

  /** Human readable reason for the 'error' state. */
  get error() { return this._error; }

  /** Whether the display is (requested to be) kept on as well. */
  get display() { return this._display; }

  /** PIDs of running helper processes (for diagnostics and tests). */
  get pids() {
    return [...this._runs.values()].map(r => r.child && r.child.pid).filter(/** @returns {p is number} */ p => typeof p === 'number');
  }

  /** Ids of helpers currently holding a power request. */
  get activeHelpers() {
    return [...this._runs.values()].filter(r => r.ready).map(r => r.spec.id);
  }

  /**
   * Starts keeping the machine awake (idempotent).
   * @param {{ display?: boolean }} [options]
   */
  acquire(options = {}) {
    if (this._disposed) {
      return;
    }
    const display = Boolean(options.display);
    if (this._wanted && display === this._display) {
      return;
    }
    const generation = ++this._generation;
    if (this._wanted) {
      this._log('info', `Display setting changed (keep display on: ${display}); restarting helper.`);
      this._stopAll();
    }
    this._wanted = true;
    this._display = display;
    this._error = '';
    const { helpers, error } = buildHelpers({ platform: this._platform, display, pid: this._pid, env: this._env, exists: this._exists });
    const usable = helpers.filter(h => !this._unavailable.has(h.id));
    if (usable.length === 0) {
      this._error = error || [...this._unavailable].map(([id, reason]) => `${id}: ${reason}`).join('; ') || 'No keep-awake helper is available.';
      this._log('error', this._error);
      this._setState('error');
      return;
    }
    this._setState('starting');
    for (const spec of usable) {
      // State listeners may synchronously release, dispose, or replace this acquisition.
      if (!this._wanted || this._disposed || generation !== this._generation) {
        return;
      }
      /** @type {HelperRun} */
      const run = { spec, child: undefined, ready: false, startedAt: 0, failures: 0, status: 'running', lastError: '', timer: undefined };
      this._runs.set(spec.id, run);
      this._start(run);
    }
  }

  /** Stops keeping the machine awake (idempotent). */
  release() {
    this._wanted = false;
    this._generation++;
    this._stopAll();
    this._error = '';
    this._setState('off');
  }

  /**
   * Forgets helpers that previously failed for good and, if keep-awake is wanted but in the
   * 'error' state, tries again. Call on explicit user actions (turning it on, changing settings).
   */
  resetFailures() {
    this._unavailable.clear();
    if (this._wanted && this._state === 'error') {
      const display = this._display;
      this.release();
      this.acquire({ display });
    }
  }

  dispose() {
    this._disposed = true;
    this.release();
    this.removeAllListeners();
  }

  /** @param {HelperRun} run */
  _start(run) {
    const { spec } = run;
    run.ready = false;
    run.status = 'running';
    run.startedAt = this._now();
    this._log('debug', `Starting ${spec.id}: ${spec.command} ${spec.args.map(a => (a.length > 80 ? a.slice(0, 77) + '...' : a)).join(' ')}`);
    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = this._spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: false });
    } catch (err) {
      this._onExit(run, undefined, null, null, /** @type {Error} */ (err));
      return;
    }
    run.child = child;
    let stderr = '';
    let stdout = '';

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      if (run.child !== child || run.ready || !spec.waitForReady) {
        return;
      }
      stdout = (stdout + chunk.toString()).slice(-256);
      if (stdout.includes(READY_TOKEN)) {
        this._markReady(run);
      }
    });
    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2048);
    });
    // Writing to a helper that has died must never throw inside the extension host.
    child.stdin?.on('error', () => { /* ignore EPIPE */ });
    child.on('error', err => this._onExit(run, child, null, null, err, stderr));
    child.on('exit', (code, signal) => this._onExit(run, child, code, signal, undefined, stderr));
    child.on('spawn', () => {
      if (run.child !== child) {
        return;
      }
      this._log('info', `${spec.id} started (pid ${child.pid}).`);
      if (!spec.waitForReady) {
        this._schedule(run, this._readyGraceMs, () => this._markReady(run));
      }
    });
    if (spec.waitForReady) {
      this._schedule(run, this._readyTimeoutMs, () => {
        if (run.child === child && !run.ready) {
          this._log('warn', `${spec.id} did not report ready within ${Math.round(this._readyTimeoutMs / 1000)}s; restarting it.`);
          run.lastError = 'Timed out waiting for the helper to start.';
          this._kill(run);
          this._handleFailure(run, true);
        }
      });
    }
  }

  /** @param {HelperRun} run */
  _markReady(run) {
    if (run.ready || !this._wanted || !run.child) {
      return;
    }
    run.ready = true;
    this._clearRunTimer(run);
    this._log('info', `${run.spec.id} is holding the power request${this._display ? ' (display kept on)' : ''}.`);
    this._refreshState();
  }

  /**
   * @param {HelperRun} run
   * @param {import('child_process').ChildProcess | undefined} child
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   * @param {Error} [err]
   * @param {string} [stderr]
   */
  _onExit(run, child, code, signal, err, stderr = '') {
    if (child && run.child !== child) {
      return; // Stale event from a process we already replaced or stopped.
    }
    if (run.status === 'failed' || run.status === 'retrying') {
      return; // 'error' and 'exit' can both fire for one process.
    }
    const wasReady = run.ready;
    run.child = undefined;
    run.ready = false;
    this._clearRunTimer(run);
    if (!this._wanted || this._runs.get(run.spec.id) !== run) {
      return;
    }
    const detail = (stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    const enoent = /** @type {NodeJS.ErrnoException | undefined} */ (err)?.code === 'ENOENT';
    run.lastError = err ? `${err.message}` : `exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`;
    this._log(wasReady ? 'warn' : 'error', `${run.spec.id} ${run.lastError}`);
    // Retrying cannot fix a missing binary or PowerShell Constrained Language Mode (set by IT policy).
    if (enoent || /language mode/i.test(stderr)) {
      if (/language mode/i.test(stderr)) {
        run.lastError = 'PowerShell is in Constrained Language Mode (set by your organisation), which blocks the Windows power API call.';
      }
      this._giveUp(run);
      return;
    }
    const aliveFor = this._now() - run.startedAt;
    if (aliveFor >= this._healthyAfterMs) {
      run.failures = 0;
    }
    this._handleFailure(run, !wasReady);
  }

  /**
   * @param {HelperRun} run
   * @param {boolean} duringStartup
   */
  _handleFailure(run, duringStartup) {
    run.failures += 1;
    const othersHolding = [...this._runs.values()].some(r => r !== run && r.ready);
    // A secondary helper that cannot even start (e.g. gnome-session-inhibit outside GNOME) is not worth retrying.
    if (duringStartup && othersHolding) {
      this._giveUp(run);
      return;
    }
    if (duringStartup && run.failures >= this._maxQuickFailures) {
      this._giveUp(run);
      return;
    }
    const delay = Math.min(this._retryBaseMs * 2 ** (run.failures - 1), this._retryMaxMs);
    run.status = 'retrying';
    this._log('info', `Restarting ${run.spec.id} in ${Math.round(delay / 1000)}s (attempt ${run.failures + 1}).`);
    this._schedule(run, delay, () => {
      if (this._wanted && this._runs.get(run.spec.id) === run) {
        this._start(run);
      }
    });
    this._refreshState();
  }

  /** @param {HelperRun} run */
  _giveUp(run) {
    run.status = 'failed';
    this._unavailable.set(run.spec.id, run.lastError);
    this._log('warn', `Giving up on ${run.spec.id}.`);
    this._refreshState();
  }

  _refreshState() {
    if (!this._wanted) {
      return;
    }
    const runs = [...this._runs.values()];
    if (runs.some(r => r.ready)) {
      this._error = '';
      this._setState('on');
    } else if (runs.some(r => r.status !== 'failed')) {
      this._setState('starting');
    } else {
      this._error = runs.map(r => `${r.spec.id}: ${r.lastError}`).join('; ') || 'Could not start a keep-awake helper.';
      this._setState('error');
    }
  }

  /** @param {KeepAwakeState} state */
  _setState(state) {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.emit('change', state);
  }

  _stopAll() {
    for (const run of this._runs.values()) {
      this._clearRunTimer(run);
      run.status = 'failed';
      this._kill(run);
    }
    this._runs.clear();
  }

  /** @param {HelperRun} run */
  _kill(run) {
    const child = run.child;
    run.child = undefined;
    run.ready = false;
    if (!child) {
      return;
    }
    try { child.stdin?.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
    this._log('debug', `Stopped ${run.spec.id} (pid ${child.pid}).`);
  }

  /**
   * @param {HelperRun} run
   * @param {number} ms
   * @param {() => void} fn
   */
  _schedule(run, ms, fn) {
    this._clearRunTimer(run);
    run.timer = this._setTimer(() => {
      run.timer = undefined;
      fn();
    }, ms);
  }

  /** @param {HelperRun} run */
  _clearRunTimer(run) {
    if (run.timer !== undefined) {
      this._clearTimer(run.timer);
      run.timer = undefined;
    }
  }
}

module.exports = { KeepAwake, buildHelpers, windowsScript, which, READY_TOKEN, WHO, WHY };

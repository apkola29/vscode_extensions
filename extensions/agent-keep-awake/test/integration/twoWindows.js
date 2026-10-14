// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');
const { probe, isAlive } = require('../os/probe');
const { identity, stop, stopChildren } = require('../os/processes');

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

async function worker() {
  const scratch = process.env.AKA_TWO_WINDOW_ROOT;
  const role = process.env.AKA_TWO_WINDOW_ROLE;
  const executable = process.env.AKA_TWO_WINDOW_CODE;
  if (!scratch || !executable || !['a', 'b'].includes(role || '')) {
    throw new Error('Invalid isolated two-window test environment.');
  }
  const profile = path.join(scratch, String(role));
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
    extensionTestsPath: path.join(__dirname, 'suite', 'twoWindows.js'),
    extensionTestsEnv: {
      AKA_TWO_WINDOW_ROOT: scratch,
      AKA_TWO_WINDOW_ROLE: String(role)
    },
    launchArgs: [
      path.join(profile, 'workspace'),
      '--new-window',
      '--user-data-dir', path.join(profile, 'user-data'),
      '--extensions-dir', path.join(profile, 'extensions'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
}

/** @param {string} root @param {string} role @param {string} executable */
function startWorker(root, role, executable) {
  const child = spawn(process.execPath, [__filename, '--worker'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AKA_TWO_WINDOW_ROOT: root,
      AKA_TWO_WINDOW_ROLE: role,
      AKA_TWO_WINDOW_CODE: executable
    }
  });
  /** @type {{child: import('child_process').ChildProcess, exited: boolean, error?: Error}} */
  const run = { child, exited: false };
  child.stdout.on('data', chunk => process.stdout.write(`[window ${role}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[window ${role}] ${chunk}`));
  child.on('error', error => { run.error = error; run.exited = true; });
  child.on('exit', code => {
    run.exited = true;
    if (code !== 0) run.error = new Error(`Window ${role} test worker exited with code ${code}.`);
  });
  return run;
}

/** @param {() => boolean} condition @param {string} label @param {number} [timeout] */
async function waitFor(condition, label, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}

/** @param {string} root @param {string} role @param {ReturnType<typeof startWorker>} run */
async function ready(root, role, run) {
  const filename = path.join(root, `${role}-ready.json`);
  await waitFor(() => {
    if (run.error) throw run.error;
    if (run.exited && !fs.existsSync(filename)) throw new Error(`Window ${role} exited before acquiring protection.`);
    return fs.existsSync(filename);
  }, `window ${role} to acquire its own hold`);
  /** @type {unknown} */
  const result = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!result || typeof result !== 'object' || !('pids' in result) || !Array.isArray(result.pids) ||
    !result.pids.length || !result.pids.every(pid => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)) {
    throw new Error(`Window ${role} provided invalid helper metadata.`);
  }
  /** @type {import('../os/processes').ProcessIdentity[]} */
  const marks = [];
  for (const pid of result.pids) {
    const mark = identity(pid);
    if (!mark) throw new Error(`Window ${role} helper ${pid} is not alive.`);
    marks.push(mark);
  }
  return marks;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This combined-display two-window acceptance check is Windows-only.');
  const baseline = probe();
  console.log(`INFO baseline: ${baseline.raw}`);
  if (baseline.system || baseline.display) {
    throw new Error('INCONCLUSIVE: another power request would mask two-window acquisition/release attribution.');
  }
  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    cachePath: process.env.VSCODE_TEST_CACHE || path.join(os.tmpdir(), 'agent-keep-awake-vscode-test')
  });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-awake-two-windows-'));
  /** @type {ReturnType<typeof startWorker>[]} */
  const workers = [];
  /** @type {import('../os/processes').ProcessIdentity[]} */
  const marks = [];
  /** @type {unknown} */
  let failure;
  try {
    for (const role of ['a', 'b']) {
      const profile = path.join(scratch, role);
      fs.mkdirSync(path.join(profile, 'workspace'), { recursive: true });
      fs.mkdirSync(path.join(profile, 'user-data', 'User'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'user-data', 'User', 'settings.json'), JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'chat.disableAIFeatures': true,
        'workbench.startupEditor': 'none'
      }));
    }
    const first = startWorker(scratch, 'a', executable);
    workers.push(first);
    const firstMarks = await ready(scratch, 'a', first);
    marks.push(...firstMarks);
    const second = startWorker(scratch, 'b', executable);
    workers.push(second);
    const secondMarks = await ready(scratch, 'b', second);
    marks.push(...secondMarks);
    if (firstMarks.some(a => secondMarks.some(b => a.pid === b.pid))) throw new Error('Two windows unexpectedly share a native helper PID.');
    const both = probe();
    if (!both.system || !both.display) throw new Error(`Combined power protection not measured: ${both.raw}`);
    console.log('PASS two real isolated VS Code windows each own distinct acknowledged helpers.');

    fs.writeFileSync(path.join(scratch, 'a-close'), '');
    await waitFor(() => first.exited, 'first real editor to exit', 30_000);
    if (first.error) throw first.error;
    await waitFor(() => firstMarks.every(mark => !isAlive(mark.pid)), 'first window helper cleanup', 15_000);
    if (second.exited || second.error || secondMarks.some(mark => identity(mark.pid)?.birth !== mark.birth)) {
      throw new Error('Closing the first editor affected the second editor or its helper.');
    }
    const one = probe();
    if (!one.system || !one.display) throw new Error(`Second window lost protection when the first closed: ${one.raw}`);
    console.log('PASS closing the first editor releases only its helper; the second retains system/display protection.');

    fs.writeFileSync(path.join(scratch, 'b-close'), '');
    await waitFor(() => second.exited, 'second real editor to exit', 30_000);
    if (second.error) throw second.error;
    await waitFor(() => secondMarks.every(mark => !isAlive(mark.pid)), 'last window helper cleanup', 15_000);
    const after = probe();
    if (after.system || after.display) throw new Error(`Last editor close did not restore baseline: ${after.raw}`);
    console.log('PASS last real editor close leaves no owned helper or system/display request.');
  } catch (error) {
    failure = error;
  } finally {
    /** @type {unknown[]} */
    const errors = [];
    for (const role of ['a', 'b']) {
      try { fs.writeFileSync(path.join(scratch, `${role}-close`), ''); } catch (error) { errors.push(error); }
    }
    try { await waitFor(() => workers.every(run => run.exited), 'worker cleanup', 15_000); } catch (error) { errors.push(error); }
    try { stopChildren(); } catch (error) { errors.push(error); }
    for (const mark of marks) {
      try {
        if (identity(mark.pid)?.birth === mark.birth) {
          stop(mark);
          errors.push(new Error(`Recorded helper ${mark.pid} survived normal editor cleanup and was stopped.`));
        }
      } catch (error) { errors.push(error); }
    }
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (error) { errors.push(error); }
    if (errors.length) {
      if (failure) errors.push(failure);
      failure = new AggregateError(errors, 'Two-window validation or scoped cleanup failed.');
    }
  }
  if (failure) throw failure;
}

(process.argv.includes('--worker') ? worker() : main()).catch(error => {
  console.error('Two-window acceptance failed:', error);
  process.exitCode = 1;
});

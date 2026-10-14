// @ts-check
'use strict';

/**
 * Real-OS verification of the keep-awake backend. No mocks: it holds an actual power request and
 * asks the operating system whether it is in effect (see probe.js for how each OS is queried).
 *
 * Usage: node test/os/verify-os.js [--quick]
 */

const { spawn } = require('child_process');
const path = require('path');
const { KeepAwake } = require('../../src/keepAwake');
const { probe, footprint, isAlive, isWindowsAdmin, run } = require('./probe');

const QUICK = process.argv.includes('--quick');
const SAMPLE_MS = QUICK ? 10_000 : 30_000;

/** @type {{ name: string, status: 'PASS' | 'FAIL' | 'INFO', detail: string }[]} */
const results = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

/** @param {string} name @param {string} detail */
function info(name, detail) {
  results.push({ name, status: 'INFO', detail });
  console.log(`INFO  ${name}  [${detail}]`);
}

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) {
      return true;
    }
    await sleep(100);
  }
  return predicate();
}

/** @param {InstanceType<typeof KeepAwake>} ka */
function settled(ka) {
  return waitFor(() => ka.state === 'on' || ka.state === 'error', 120_000);
}

/** @param {number} pid */
function forceKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Starts a separate Node process that acquires keep-awake, so it can be killed abruptly. */
function startOwnerProcess() {
  const backendPath = JSON.stringify(path.join(__dirname, '..', '..', 'src', 'keepAwake.js'));
  const code = `
    const { KeepAwake } = require(${backendPath});
    const ka = new KeepAwake();
    ka.on('change', s => {
      if (s === 'on') console.log('PIDS ' + JSON.stringify(ka.pids));
      if (s === 'error') { console.log('ERROR ' + ka.error); process.exit(2); }
    });
    ka.acquire();
    setInterval(() => {}, 1 << 30);`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  /** @type {Promise<number[]>} */
  const pids = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      const m = /PIDS (\[.*\])/.exec(buf);
      if (m) {
        resolve(JSON.parse(m[1]));
      } else if (/ERROR /.test(buf)) {
        reject(new Error(buf));
      }
    });
    child.on('exit', c => reject(new Error(`owner process exited early (${c}): ${buf}`)));
  });
  return { child, pids };
}

async function main() {
  console.log(`Agent Keep-Awake OS verification on ${process.platform}/${process.arch}, node ${process.version}${QUICK ? ' (quick)' : ''}\n`);
  const admin = process.platform === 'win32' && isWindowsAdmin();
  if (process.platform === 'win32') {
    info('elevated', String(admin));
  }
  const baseline = probe();
  info('baseline', baseline.raw);
  if (process.platform === 'win32' && (baseline.system || baseline.display)) {
    throw new Error('INCONCLUSIVE: an ambient system/display power request prevents exclusive native acquire/release verification. No test helper was started.');
  }
  const canCheckRelease = process.platform !== 'win32' || !baseline.system;
  const canCheckDisplay = process.platform !== 'win32' || !baseline.display;

  /** @type {string[]} */
  const logs = [];
  const ka = new KeepAwake({ log: (level, message) => logs.push(`[${level}] ${message}`) });

  // 1. Acquire and verify at OS level.
  const t0 = Date.now();
  ka.acquire({ display: false });
  await settled(ka);
  check('helper starts and holds the request', ka.state === 'on', `${ka.state} after ${Date.now() - t0}ms ${ka.error}`);
  if (ka.state !== 'on') {
    console.log(logs.join('\n'));
    return finish();
  }
  const [pid] = ka.pids;
  info('helper', `${ka.activeHelpers.join('+')} pid ${ka.pids.join(',')}`);
  const held = probe(ka.pids);
  check('OS reports a system-sleep block', held.system, held.raw);
  if (canCheckDisplay) {
    check('display is not forced on by default', !held.display, held.raw);
  }
  if (admin) {
    const requests = run('powercfg', ['/requests']);
    const systemSection = requests.split(/\r?\n\r?\n/).find(s => /^SYSTEM:/m.test(s)) || '';
    check('powercfg /requests lists the helper under SYSTEM', /powershell\.exe/i.test(systemSection), systemSection.replace(/\s+/g, ' ').trim());
  }

  // 2. Footprint.
  await sleep(3_000);
  const f1 = footprint(pid);
  await sleep(SAMPLE_MS);
  const f2 = footprint(pid);
  const cpuPct = ((f2.cpu - f1.cpu) / (SAMPLE_MS / 1000)) * 100;
  info('footprint', `resident ${f2.rssMB.toFixed(1)} MB, CPU ${(f2.cpu - f1.cpu).toFixed(3)}s over ${SAMPLE_MS / 1000}s (${cpuPct.toFixed(3)}%)`);
  check('idle CPU is effectively zero (< 0.5%)', cpuPct < 0.5, `${cpuPct.toFixed(3)}%`);
  check('idle memory is small (< 64 MB resident)', f2.rssMB < 64, `${f2.rssMB.toFixed(1)} MB`);

  // 3. Release.
  const pidsBefore = ka.pids;
  ka.release();
  const gone = await waitFor(() => pidsBefore.every(p => !isAlive(p)), 10_000);
  check('helper exits on release', gone, pidsBefore.join(','));
  await sleep(500);
  if (canCheckRelease) {
    const released = probe(pidsBefore);
    check('OS no longer reports the block', !released.system, released.raw);
  }

  // 4. Display mode.
  ka.acquire({ display: true });
  await settled(ka);
  const disp = probe(ka.pids);
  check('display mode also blocks display sleep', ka.state === 'on' && disp.display && disp.system, disp.raw);
  ka.release();
  await sleep(500);

  // 5. Self-healing.
  ka.acquire({ display: false });
  await settled(ka);
  const victim = ka.pids[0];
  forceKill(victim);
  const healed = await waitFor(() => ka.state === 'on' && ka.pids.length > 0 && !ka.pids.includes(victim), 60_000);
  check('helper is restarted if something kills it', healed, `old ${victim}, new ${ka.pids.join(',')}`);
  check('OS reports the block again after restart', probe(ka.pids).system);

  // 6. Two VS Code windows at once.
  const second = new KeepAwake();
  second.acquire();
  await settled(second);
  ka.release();
  await sleep(500);
  check('request stays in effect while another window holds it', probe(second.pids).system);
  const secondPids = second.pids;
  second.dispose();
  await waitFor(() => secondPids.every(p => !isAlive(p)), 10_000);
  await sleep(500);
  if (canCheckRelease) {
    check('request released when the last window lets go', !probe(secondPids).system);
  }

  // 7. Orphan safety: kill the owning process abruptly; the helper must not outlive it.
  const owner = startOwnerProcess();
  /** @type {number[]} */
  let helperPids = [];
  try {
    helperPids = await owner.pids;
  } catch (err) {
    check('owner process acquired', false, String(err));
  }
  if (helperPids.length) {
    check('crash test: OS reports the block', probe(helperPids).system);
    forceKill(/** @type {number} */ (owner.child.pid));
    const cleaned = await waitFor(() => helperPids.every(p => !isAlive(p)), 20_000);
    check('helper exits by itself when VS Code is killed (no orphaned sleep block)', cleaned, helperPids.join(','));
    await sleep(500);
    if (canCheckRelease) {
      const after = probe(helperPids);
      check('crash test: OS no longer reports the block', !after.system, after.raw);
    }
  }

  ka.dispose();
  if (results.some(r => r.status === 'FAIL')) {
    console.log('\nBackend log:\n' + logs.join('\n'));
  }
  return finish();
}

function finish() {
  const failed = results.filter(r => r.status === 'FAIL').length;
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 200).unref();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

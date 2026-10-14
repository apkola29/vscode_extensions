// @ts-check
'use strict';

/**
 * Launches a clean, isolated VS Code (fresh user-data and extensions folders) with only this
 * extension loaded and runs ./suite inside its extension host. The suite drives the delivered
 * controls (Off, Keep awake, unavailable Auto); no model, chat participant or test double is loaded.
 * Its last case leaves an until-off Keep awake hold running so this runner can prove that a real
 * editor close releases the helper and its OS power request.
 *
 * Environment:
 *   VSCODE_TEST_VERSION            VS Code version to test against ('stable', 'insiders' or e.g. '1.95.0')
 *   VSCODE_TEST_CACHE              where to cache downloaded VS Code builds (default: OS temp folder)
 *   VSCODE_TEST_RUN_TIMEOUT_MS     watchdog for the whole run (default: 8 minutes)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { isAlive, probe } = require('../os/probe');
const { identity, stop, stopChildren } = require('../os/processes');

const RUN_TIMEOUT_MS = Number(process.env.VSCODE_TEST_RUN_TIMEOUT_MS || 8 * 60_000);

/** @param {string} workspace */
function recordedHelpers(workspace) {
  const filename = path.join(workspace, 'owned-helpers.json');
  if (!fs.existsSync(filename)) return [];
  /** @type {unknown} */
  const values = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(values)) throw new Error('Invalid recorded helper list.');
  /** @type {import('../os/processes').ProcessIdentity[]} */
  const marks = [];
  for (const value of /** @type {unknown[]} */ (values)) {
    if (!value || typeof value !== 'object' || !('pid' in value) || typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 || !('birth' in value) || typeof value.birth !== 'string') {
      throw new Error('Invalid recorded helper process identity.');
    }
    marks.push({ pid: value.pid, birth: value.birth });
  }
  return marks;
}

async function main() {
  if (!Number.isSafeInteger(RUN_TIMEOUT_MS) || RUN_TIMEOUT_MS <= 0) {
    throw new Error('VSCODE_TEST_RUN_TIMEOUT_MS must be a positive integer.');
  }
  const root = path.resolve(__dirname, '..', '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-keep-awake-it-'));
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# scratch workspace for integration tests\n');
  const userData = path.join(scratch, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  // The old editor-wide settings are seeded on purpose: a real profile may still contain them and they must stay inert.
  // AI features are disabled so no model, sign-in or Copilot service can take part in any case.
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'agentKeepAwake.enabled': true,
    'agentKeepAwake.mode': 'always',
    'telemetry.telemetryLevel': 'off',
    'chat.disableAIFeatures': true
  }));

  const version = process.env.VSCODE_TEST_VERSION || 'stable';
  console.log(`Running integration tests against VS Code ${version}`);
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {unknown} */
  let failure;
  try {
    const cachePath = process.env.VSCODE_TEST_CACHE || path.join(os.tmpdir(), 'agent-keep-awake-vscode-test');
    const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath });
    const execution = runTests({
      version,
      cachePath,
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      extensionTestsEnv: { AKA_TEST_WORKSPACE: workspace, AKA_TEST_NODE: process.execPath },
      launchArgs: [
        workspace,
        '--user-data-dir', userData,
        '--extensions-dir', path.join(scratch, 'extensions'),
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes'
      ]
    });
    await Promise.race([
      execution,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`VS Code integration run exceeded ${RUN_TIMEOUT_MS / 1000} seconds.`)), RUN_TIMEOUT_MS);
      })
    ]);
    const shutdown = JSON.parse(fs.readFileSync(path.join(workspace, 'shutdown-check.json'), 'utf8'));
    if (!Array.isArray(shutdown.pids) || !shutdown.pids.length ||
      !shutdown.pids.every((/** @type {unknown} */ pid) => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)) {
      throw new Error('The integration suite did not provide valid shutdown helper PIDs.');
    }
    // The proof is only meaningful for a live, until-off Manual hold: a timer or Off could have released it earlier.
    if (shutdown.platform !== process.platform || shutdown.mode !== 'manual' ||
      shutdown.durationMs !== 0 || shutdown.expiresAt !== 0) {
      throw new Error(`The integration suite did not leave an until-off Keep awake hold for the shutdown proof: ${JSON.stringify({
        platform: shutdown.platform, mode: shutdown.mode, durationMs: shutdown.durationMs, expiresAt: shutdown.expiresAt
      })}`);
    }
    const deadline = Date.now() + 15_000;
    while (shutdown.pids.some((/** @type {number} */ pid) => isAlive(pid))) {
      if (Date.now() > deadline) {
        for (const mark of recordedHelpers(workspace)) stop(mark);
        throw new Error('A helper survived the isolated VS Code shutdown and was cleaned up.');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const after = probe(shutdown.pids);
    // On Windows this is machine-wide; the suite proved a clean ambient baseline before it started any hold.
    if (after.system) throw new Error(`Shutdown did not release system protection: ${after.raw}`);
    if (after.display) throw new Error(`Shutdown left display protection behind: ${after.raw}`);
    console.log('PASS real VS Code shutdown releases the live Keep awake helper and its power request');
  } catch (error) {
    failure = error;
    // An ambient power request makes every acquire/release claim unprovable: say so instead of a generic failure.
    try {
      const marker = path.join(workspace, 'inconclusive.json');
      if (fs.existsSync(marker)) {
        const { reason, baseline } = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (typeof reason === 'string' && reason.startsWith('INCONCLUSIVE')) {
          failure = new Error(`${reason} Ambient baseline: ${baseline?.raw}. Nothing was proven or disproven.`);
        }
      }
    } catch (markerError) {
      console.error('Could not read the inconclusive marker:', markerError);
    }
  } finally {
    clearTimeout(timer);
    /** @type {unknown[]} */
    const cleanupErrors = [];
    try {
      stopChildren();
    } catch (error) {
      cleanupErrors.push(error);
    }
    /** @type {import('../os/processes').ProcessIdentity[]} */
    let marks = [];
    try {
      marks = recordedHelpers(workspace);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const mark of marks) {
      try {
        const current = identity(mark.pid);
        if (current?.birth === mark.birth) {
          console.warn(`Cleaning up stranded test helper PID ${mark.pid}.`);
          stop(mark);
          failure ||= new Error('A recorded test helper remained alive after the editor exited.');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      for (const error of cleanupErrors) console.error('Test process cleanup failed:', error);
      failure ||= new AggregateError(cleanupErrors, 'One or more test process cleanup stages failed.');
    }
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      console.error(`Could not remove isolated test profile ${scratch}:`, error);
      failure ||= error;
    }
  }
  if (failure) throw failure;
}

main().catch(err => {
  console.error('Integration tests failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

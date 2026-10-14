// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KeepAwake, buildHelpers, windowsScript, which } = require('../../src/keepAwake');
const { createClock, createSpawn } = require('./helpers');

const WIN_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** @param {string[]} paths */
const existsIn = paths => (/** @type {string} */ p) => paths.includes(p);

/**
 * @param {Partial<import('../../src/keepAwake').KeepAwakeOptions>} [overrides]
 */
function setup(overrides = {}) {
  const clock = createClock();
  const sp = createSpawn();
  /** @type {string[]} */
  const states = [];
  /** @type {string[]} */
  const logs = [];
  const ka = new KeepAwake({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PATH: '' },
    pid: 4242,
    exists: existsIn([WIN_PS]),
    spawn: sp.spawn,
    log: (level, message) => logs.push(`${level}: ${message}`),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...overrides
  });
  ka.on('change', s => states.push(s));
  return { ka, clock, sp, states, logs };
}

test.describe('buildHelpers', () => {
  test('windows uses System32 Windows PowerShell with a READY handshake', () => {
    const { helpers, error } = buildHelpers({ platform: 'win32', display: false, pid: 1, env: { SystemRoot: 'C:\\Windows' }, exists: existsIn([WIN_PS]) });
    assert.equal(error, undefined);
    assert.equal(helpers.length, 1);
    const [h] = helpers;
    assert.equal(h.command, WIN_PS);
    assert.deepEqual(h.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(h.waitForReady, true);
    assert.ok(h.args[4].includes('SetThreadExecutionState([uint32]2147483649)'), 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED');
  });

  test('windows display flag adds ES_DISPLAY_REQUIRED', () => {
    assert.ok(windowsScript(true).includes('[uint32]2147483651'));
    assert.ok(windowsScript(false).includes('[uint32]2147483649'));
  });

  test('windows script is command-line safe and never touches disk or settings', () => {
    for (const display of [false, true]) {
      const s = windowsScript(display);
      assert.ok(!s.includes('"'), 'no double quotes');
      assert.ok(!/powercfg|Add-Type|Set-Content|Out-File|Registry/i.test(s), 'no settings changes, no compilation, no files');
      assert.match(s, /SetImplementationFlags\('PreserveSig'\)/);
      assert.match(s, /OpenStandardInput\(\)/, 'waits for stdin EOF so it dies with VS Code');
      assert.ok(s.length < 2000);
    }
  });

  test('windows falls back to PowerShell on PATH, then pwsh, else reports an error', () => {
    const env = { SystemRoot: 'D:\\Win', PATH: 'C:\\tools;C:\\pwsh' };
    const ps = buildHelpers({ platform: 'win32', display: false, pid: 1, env, exists: existsIn(['C:\\tools\\powershell.exe']) });
    assert.equal(ps.helpers[0].command, 'C:\\tools\\powershell.exe');
    const pwsh = buildHelpers({ platform: 'win32', display: false, pid: 1, env, exists: existsIn(['C:\\pwsh\\pwsh.exe']) });
    assert.equal(pwsh.helpers[0].command, 'C:\\pwsh\\pwsh.exe');
    const none = buildHelpers({ platform: 'win32', display: false, pid: 1, env, exists: () => false });
    assert.equal(none.helpers.length, 0);
    assert.match(String(none.error), /PowerShell/);
  });

  test('macOS uses caffeinate bound to the extension host pid', () => {
    const sys = buildHelpers({ platform: 'darwin', display: false, pid: 777, env: {}, exists: existsIn(['/usr/bin/caffeinate']) });
    assert.deepEqual(sys.helpers[0], { id: 'caffeinate', command: '/usr/bin/caffeinate', args: ['-i', '-w', '777'], waitForReady: false });
    const disp = buildHelpers({ platform: 'darwin', display: true, pid: 777, env: {}, exists: existsIn(['/usr/bin/caffeinate']) });
    assert.deepEqual(disp.helpers[0].args, ['-i', '-d', '-w', '777']);
    const none = buildHelpers({ platform: 'darwin', display: false, pid: 1, env: { PATH: '/bin' }, exists: () => false });
    assert.match(String(none.error), /caffeinate/);
  });

  test('linux uses systemd-inhibit and gnome-session-inhibit wrapping cat', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' };
    const both = buildHelpers({ platform: 'linux', display: false, pid: 1, env, exists: existsIn(['/usr/bin/systemd-inhibit', '/usr/bin/gnome-session-inhibit']) });
    assert.deepEqual(both.helpers.map(h => h.id), ['systemd-inhibit', 'gnome-session-inhibit']);
    const [sd, gn] = both.helpers;
    assert.equal(sd.command, '/usr/bin/systemd-inhibit');
    assert.ok(sd.args.includes('--what=sleep'));
    assert.ok(sd.args.includes('--mode=block'));
    assert.equal(sd.args[sd.args.length - 1], 'cat', 'cat exits on stdin EOF, releasing the inhibitor if VS Code dies');
    assert.deepEqual(gn.args.slice(-3), ['--inhibit', 'suspend', 'cat']);
    const disp = buildHelpers({ platform: 'linux', display: true, pid: 1, env, exists: existsIn(['/usr/bin/systemd-inhibit', '/usr/bin/gnome-session-inhibit']) });
    assert.ok(disp.helpers[0].args.includes('--what=sleep:idle'));
    assert.deepEqual(disp.helpers[1].args.slice(-3), ['--inhibit', 'suspend:idle', 'cat']);
  });

  test('linux with only one tool, or none', () => {
    const env = { PATH: '/usr/bin' };
    const one = buildHelpers({ platform: 'linux', display: false, pid: 1, env, exists: existsIn(['/usr/bin/systemd-inhibit']) });
    assert.deepEqual(one.helpers.map(h => h.id), ['systemd-inhibit']);
    const none = buildHelpers({ platform: 'linux', display: false, pid: 1, env, exists: () => false });
    assert.equal(none.helpers.length, 0);
    assert.match(String(none.error), /systemd-inhibit/);
  });

  test('linux inside Flatpak reaches host tools through flatpak-spawn', () => {
    const r = buildHelpers({ platform: 'linux', display: false, pid: 1, env: { FLATPAK_ID: 'com.visualstudio.code' }, exists: () => false });
    assert.deepEqual(r.helpers.map(h => h.command), ['flatpak-spawn', 'flatpak-spawn']);
    assert.deepEqual(r.helpers[0].args.slice(0, 4), ['--host', '--watch-bus', 'systemd-inhibit', '--what=sleep']);
  });

  test('which() searches PATH entries in order', () => {
    assert.equal(which('x', { PATH: '/a:/b' }, existsIn(['/b/x']), 'linux'), '/b/x');
    assert.equal(which('x.exe', { Path: 'C:\\a;C:\\b' }, existsIn(['C:\\a\\x.exe']), 'win32'), 'C:\\a\\x.exe');
    assert.equal(which('x', {}, () => true, 'linux'), undefined);
  });
});

test.describe('KeepAwake lifecycle', () => {
  test('release from the starting event prevents all helper spawning', () => {
    const { ka, sp, clock } = setup();
    ka.on('change', state => {
      if (state === 'starting') ka.release();
    });
    ka.acquire();
    assert.equal(ka.state, 'off');
    assert.equal(sp.children.length, 0);
    ka.dispose();
    assert.equal(clock.pending(), 0);
  });

  test('reentrant acquire with another display option does not spawn stale helpers', () => {
    const { ka, sp } = setup();
    ka.on('change', state => {
      if (state === 'starting' && !ka.display) ka.acquire({ display: true });
    });
    ka.acquire({ display: false });
    assert.equal(sp.children.length, 1);
    assert.ok(sp.last().args[4].includes('2147483651'));
    ka.dispose();
  });

  test('dispose forbids reacquiring from the synchronous off event', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    sp.last().spawned().ready();
    ka.on('change', state => {
      if (state === 'off') ka.acquire();
    });
    ka.dispose();
    assert.equal(ka.state, 'off');
    assert.equal(sp.children.length, 1);
    assert.equal(sp.last().killed, true);
    assert.equal(clock.pending(), 0);
  });

  test('acquire spawns one hidden helper and turns on after READY', () => {
    const { ka, sp, states } = setup();
    ka.acquire();
    assert.equal(ka.state, 'starting');
    assert.equal(sp.children.length, 1);
    const child = sp.last();
    assert.equal(child.options.windowsHide, true);
    assert.deepEqual(child.options.stdio, ['pipe', 'pipe', 'pipe']);
    child.spawned();
    assert.equal(ka.state, 'starting', 'Windows helper waits for READY');
    child.ready();
    assert.equal(ka.state, 'on');
    assert.deepEqual(states, ['starting', 'on']);
    assert.deepEqual(ka.activeHelpers, ['powershell']);
    assert.deepEqual(ka.pids, [child.pid]);
  });

  test('acquire is idempotent', () => {
    const { ka, sp } = setup();
    ka.acquire();
    ka.acquire();
    ka.acquire({ display: false });
    assert.equal(sp.children.length, 1);
  });

  test('release closes stdin, kills the helper and ignores its late exit', () => {
    const { ka, sp, clock, states } = setup();
    ka.acquire();
    const child = sp.last().spawned().ready();
    ka.release();
    assert.equal(child.stdin.ended, true);
    assert.equal(child.killed, true);
    assert.equal(ka.state, 'off');
    child.exit(null, 'SIGTERM');
    clock.advance(120_000);
    assert.equal(sp.children.length, 1, 'no respawn after release');
    assert.deepEqual(states, ['starting', 'on', 'off']);
    assert.equal(clock.pending(), 0, 'no timers left behind');
  });

  test('changing the display option restarts the helper with new flags', () => {
    const { ka, sp } = setup();
    ka.acquire({ display: false });
    const first = sp.last().spawned().ready();
    ka.acquire({ display: true });
    assert.equal(first.killed, true);
    assert.equal(sp.children.length, 2);
    assert.ok(sp.last().args[4].includes('2147483651'));
    assert.equal(ka.display, true);
  });

  test('a helper that dies later is restarted with backoff', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    sp.last().spawned().ready();
    clock.advance(5_000);
    sp.last().exit(1);
    assert.equal(ka.state, 'starting');
    clock.advance(999);
    assert.equal(sp.children.length, 1);
    clock.advance(1);
    assert.equal(sp.children.length, 2, 'restarted after 1s');
    sp.last().spawned().ready();
    assert.equal(ka.state, 'on');
    clock.advance(1_000);
    sp.last().exit(1);
    clock.advance(1_999);
    assert.equal(sp.children.length, 2);
    clock.advance(1);
    assert.equal(sp.children.length, 3, 'second restart waits 2s');
  });

  test('a helper that ran healthily for a while restarts quickly again', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    sp.last().spawned().ready();
    sp.last().exit(1);
    clock.advance(1_000);
    sp.last().spawned().ready();
    clock.advance(10 * 60_000);
    sp.last().exit(1);
    clock.advance(1_000);
    assert.equal(sp.children.length, 3, 'failure count was reset');
  });

  test('repeated start-up failures end in an error, remembered until resetFailures()', () => {
    const { ka, sp, clock, states } = setup();
    ka.acquire();
    for (let i = 0; i < 5; i++) {
      sp.last().spawned().writeStderr('boom\n').exit(1);
      clock.advance(60_000);
    }
    assert.equal(sp.children.length, 5);
    assert.equal(ka.state, 'error');
    assert.match(ka.error, /powershell: exited with code 1: boom/);
    assert.equal(states[states.length - 1], 'error');
    ka.release();
    ka.acquire();
    assert.equal(sp.children.length, 5, 'does not respawn a helper known to fail');
    assert.equal(ka.state, 'error');
    ka.resetFailures();
    assert.equal(sp.children.length, 6, 'explicit retry');
    sp.last().spawned().ready();
    assert.equal(ka.state, 'on');
  });

  test('missing executable fails immediately without retries', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    const err = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    sp.last().emit('error', err);
    assert.equal(ka.state, 'error');
    assert.match(ka.error, /ENOENT/);
    clock.advance(600_000);
    assert.equal(sp.children.length, 1);
  });

  test('PowerShell Constrained Language Mode is reported clearly and not retried', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    sp.last().spawned().writeStderr('Cannot invoke method. Method invocation is supported only on core types in this language mode.\n').exit(1);
    assert.equal(ka.state, 'error');
    assert.match(ka.error, /Constrained Language Mode/);
    clock.advance(600_000);
    assert.equal(sp.children.length, 1);
  });

  test('a helper that never reports READY is restarted after the timeout', () => {
    const { ka, sp, clock } = setup({ readyTimeoutMs: 10_000 });
    ka.acquire();
    const stuck = sp.last().spawned();
    clock.advance(10_000);
    assert.equal(stuck.killed, true);
    clock.advance(1_000);
    assert.equal(sp.children.length, 2);
    stuck.exit(1);
    sp.last().spawned().ready();
    assert.equal(ka.state, 'on', 'late exit of the stuck helper is ignored');
  });

  test('spawn throwing synchronously is handled as a failure', () => {
    let calls = 0;
    const { ka, clock } = setup({ spawn: /** @type {any} */ (() => { calls++; throw new Error('EPERM'); }) });
    ka.acquire();
    assert.equal(ka.state, 'starting');
    clock.advance(600_000);
    assert.equal(calls, 5);
    assert.equal(ka.state, 'error');
  });

  test('caffeinate-style helpers count as holding once alive for the grace period', () => {
    const { ka, sp, clock } = setup({ platform: 'darwin', exists: existsIn(['/usr/bin/caffeinate']) });
    ka.acquire();
    assert.deepEqual(sp.last().args, ['-i', '-w', '4242']);
    sp.last().spawned();
    clock.advance(999);
    assert.equal(ka.state, 'starting');
    clock.advance(1);
    assert.equal(ka.state, 'on');
  });

  test('linux: a secondary helper that cannot start is dropped while the other holds', () => {
    const { ka, sp, clock } = setup({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exists: existsIn(['/usr/bin/systemd-inhibit', '/usr/bin/gnome-session-inhibit'])
    });
    ka.acquire();
    const [sd, gn] = sp.children;
    sd.spawned();
    gn.spawned();
    gn.exit(1); // e.g. no GNOME session bus: fails within milliseconds
    clock.advance(1_000); // systemd-inhibit passes its grace period; gnome-session-inhibit is retried once
    assert.equal(ka.state, 'on');
    assert.equal(sp.children.length, 3);
    sp.last().spawned().exit(1);
    clock.advance(600_000);
    assert.equal(sp.children.length, 3, 'gnome-session-inhibit dropped while systemd-inhibit holds');
    assert.equal(ka.state, 'on');
    assert.deepEqual(ka.activeHelpers, ['systemd-inhibit']);
    ka.release();
    ka.acquire();
    assert.equal(sp.children.length, 4);
    assert.ok(sp.last().args.includes('--mode=block'), 'only systemd-inhibit next time');
  });

  test('the original failure reason is kept when a failed helper is skipped', () => {
    const { ka, sp } = setup();
    ka.acquire();
    sp.last().emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    ka.release();
    ka.acquire();
    assert.equal(ka.state, 'error');
    assert.match(ka.error, /^powershell: spawn powershell\.exe ENOENT$/);
  });

  test('dispose stops everything and ignores later calls', () => {
    const { ka, sp, clock } = setup();
    ka.acquire();
    const child = sp.last().spawned().ready();
    ka.dispose();
    assert.equal(child.killed, true);
    assert.equal(ka.state, 'off');
    ka.acquire();
    clock.advance(600_000);
    assert.equal(sp.children.length, 1);
  });

  test('errors writing to a dead helper stdin are swallowed', () => {
    const { ka, sp } = setup();
    ka.acquire();
    const child = sp.last().spawned().ready();
    assert.doesNotThrow(() => child.stdin.emit('error', new Error('EPIPE')));
  });
});

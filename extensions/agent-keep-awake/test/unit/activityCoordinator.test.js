// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ActivityCoordinator } = require('../../src/activityCoordinator');
const { KeepAwake } = require('../../src/keepAwake');
const { createClock, createSpawn } = require('./helpers');

const MAX_HOLD_MS = 24 * 60 * 60_000;
const MOCK_CAPABILITY = Object.freeze({
  status: /** @type {const} */ ('verified'),
  harness: 'unit-mock-only',
  reason: 'Synthetic ownership tests, not native Copilot lifecycle evidence.'
});

class FakeBackend extends EventEmitter {
  constructor() {
    super();
    /** @type {import('../../src/keepAwake').KeepAwakeState} */
    this.state = 'off';
    this.error = '';
    /** @type {number[]} */
    this.pids = [];
    /** @type {string[]} */
    this.activeHelpers = [];
    /** @type {{display?: boolean}[]} */
    this.acquisitions = [];
    this.releases = 0;
    this.disposals = 0;
    this.resets = 0;
    this.wanted = false;
    this.throwAcquire = false;
    this.throwRelease = false;
    /** @type {(() => void) | undefined} */
    this.afterAcquire = undefined;
  }

  /** @param {{display?: boolean}} [options] */
  acquire(options = {}) {
    this.acquisitions.push({ ...options });
    this.wanted = true;
    if (this.throwAcquire) throw new Error('PRIVATE_BACKEND_DETAIL');
    this.change('starting');
    this.afterAcquire?.();
  }

  release() {
    this.releases++;
    this.wanted = false;
    this.change('off');
    if (this.throwRelease) throw new Error('PRIVATE_RELEASE_DETAIL');
  }

  resetFailures() { this.resets++; }

  dispose() {
    this.disposals++;
    this.release();
    this.removeAllListeners();
  }

  /** @param {import('../../src/keepAwake').KeepAwakeState} state @param {string} [error] */
  change(state, error = '') {
    this.state = state;
    this.error = error;
    this.pids = state === 'starting' || state === 'on' ? [7001] : [];
    this.activeHelpers = state === 'on' ? ['fake-system'] : [];
    this.emit('change', state);
  }
}

/** @param {Partial<import('../../src/activityCoordinator').ActivityCoordinatorOptions>} [options] */
function setup(options = {}) {
  const clock = createClock();
  const backend = new FakeBackend();
  /** @type {string[]} */
  const logs = [];
  /** @type {import('../../src/activityCoordinator').ActivityCoordinatorState[]} */
  const changes = [];
  const coordinator = new ActivityCoordinator(backend, {
    instanceId: 'window-A',
    keepDisplayOn: true,
    nativeAcknowledgement: true,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...options
  });
  coordinator.on('change', state => changes.push(state));
  return { coordinator, backend, clock, logs, changes };
}

/**
 * @param {InstanceType<typeof ActivityCoordinator>} coordinator
 * @param {Partial<import('../../src/activityCoordinator').ActivityOwner>} [overrides]
 * @returns {import('../../src/activityCoordinator').ActivityOwner}
 */
function owner(coordinator, overrides = {}) {
  const state = coordinator.getState();
  return {
    instanceId: state.instanceId,
    generation: state.generation,
    adapter: 'unit-adapter',
    sessionId: 'session-1',
    operationId: 'root-1',
    kind: 'root',
    ...overrides
  };
}

/** @param {import('../../src/activityCoordinator').ActivityLease | undefined} lease */
function requireLease(lease) {
  assert.ok(lease, 'a verified mock profile accepts valid metadata');
  return lease;
}

test.describe('ActivityCoordinator capability and snapshots', () => {
  test('starts Off without a helper, timer, or implicit owner', () => {
    const { coordinator, backend, clock } = setup();
    const state = coordinator.getState();
    assert.equal(state.mode, 'off');
    assert.equal(state.state, 'off');
    assert.equal(state.desired, false);
    assert.equal(state.confirmed, false);
    assert.equal(state.ownerCount, 0);
    assert.equal(state.durationMs, 0);
    assert.equal(state.expiresAt, 0);
    assert.equal(state.error, '');
    assert.equal(state.notice, '');
    assert.equal(state.backendState, 'off');
    assert.equal(state.instanceId, 'window-A');
    assert.ok(Number.isSafeInteger(state.generation));
    assert.equal(state.auto.status, 'unavailable');
    assert.deepEqual(state.pids, []);
    assert.deepEqual(state.helpers, []);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    assert.equal(backend.listenerCount('change'), 1);
    coordinator.dispose();
  });

  test('default Auto is unavailable and idle, not a mock-supported production adapter', () => {
    const { coordinator, backend, clock } = setup();
    assert.equal(coordinator.auto(), false);
    assert.equal(coordinator.getState().mode, 'auto');
    assert.equal(coordinator.getState().state, 'unavailable');
    assert.equal(coordinator.begin(owner(coordinator)), undefined);
    assert.equal(coordinator.getState().desired, false);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('limited capability is advisory and cannot accept owners', () => {
    const { coordinator, backend, clock } = setup({
      autoCapability: { status: 'limited', harness: 'incomplete-profile', reason: 'Terminal events are missing.' }
    });
    assert.equal(coordinator.auto(), false);
    assert.equal(coordinator.getState().state, 'limited');
    assert.equal(coordinator.begin(owner(coordinator)), undefined);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('a verified mock profile arms Waiting without polling or acquiring', () => {
    const { coordinator, backend, clock, changes } = setup({ autoCapability: MOCK_CAPABILITY });
    assert.equal(coordinator.auto(), true);
    const state = coordinator.getState();
    const changeCount = changes.length;
    assert.equal(state.state, 'waiting');
    assert.match(state.notice, /subsequent|next|already-running/i);
    assert.equal(coordinator.auto(), true);
    assert.equal(coordinator.getState().generation, state.generation);
    assert.equal(changes.length, changeCount);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('unavailable Auto preserves a confirmed manual hold, deadline, and generation', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual(30_000);
    backend.change('on');
    assert.equal(await pending, true);
    const before = coordinator.getState();
    const timers = clock.setTimerCalls;
    assert.equal(coordinator.auto(), false);
    const after = coordinator.getState();
    assert.equal(after.mode, 'manual');
    assert.equal(after.state, 'on');
    assert.equal(after.generation, before.generation);
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.ownerCount, 1);
    assert.equal(after.confirmed, true);
    assert.match(after.notice, /unavailable|not available/i);
    assert.equal(backend.releases, 0);
    assert.equal(clock.setTimerCalls, timers);
    coordinator.dispose();
  });

  test('unavailable Auto also preserves an in-flight manual startup', async () => {
    const { coordinator, backend } = setup();
    const pending = coordinator.manual();
    assert.equal(coordinator.auto(), false);
    assert.equal(coordinator.manual(), pending);
    backend.change('on');
    assert.equal(await pending, true);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    coordinator.dispose();
  });

  test('limited Auto preserves Manual rather than silently dropping protection', async () => {
    const { coordinator, backend } = setup({
      autoCapability: { status: 'limited', harness: 'unit-limited', reason: 'Not a terminal observer.' }
    });
    const pending = coordinator.manual();
    backend.change('on');
    await pending;
    assert.equal(coordinator.auto(), false);
    assert.equal(coordinator.getState().mode, 'manual');
    assert.equal(coordinator.getState().confirmed, true);
    assert.match(coordinator.getState().notice, /limited/i);
    assert.equal(backend.releases, 0);
    coordinator.dispose();
  });

  test('generated instance identities are distinct and bounded', () => {
    const first = new ActivityCoordinator(new FakeBackend());
    const second = new ActivityCoordinator(new FakeBackend());
    assert.notEqual(first.getState().instanceId, second.getState().instanceId);
    assert.match(first.getState().instanceId, /^[A-Za-z0-9_.:-]{1,128}$/);
    first.dispose();
    second.dispose();
  });

  test('state snapshots copy capability and backend diagnostics', async () => {
    /** @type {import('../../src/activityCoordinator').AutoCapability} */
    const capability = { ...MOCK_CAPABILITY };
    const { coordinator, backend } = setup({ autoCapability: capability });
    capability.reason = 'mutated outside coordinator';
    const pending = coordinator.manual();
    backend.change('on');
    await pending;
    const snapshot = coordinator.getState();
    snapshot.auto.reason = 'mutated snapshot';
    snapshot.pids.push(9999);
    snapshot.helpers.push('not-owned');
    assert.equal(coordinator.getState().auto.reason, MOCK_CAPABILITY.reason);
    assert.deepEqual(coordinator.getState().pids, [7001]);
    assert.deepEqual(coordinator.getState().helpers, ['fake-system']);
    coordinator.dispose();
  });
});

test.describe('ActivityCoordinator manual ownership', () => {
  test('default Manual waits for acknowledgement and then has no expiry timer', async () => {
    const { coordinator, backend, clock, changes } = setup();
    let settled = false;
    const pending = coordinator.manual();
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(coordinator.getState().mode, 'manual');
    assert.equal(coordinator.getState().state, 'starting');
    assert.equal(coordinator.getState().desired, true);
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().expiresAt, 0);
    assert.deepEqual(backend.acquisitions, [{ display: true }]);
    assert.equal(clock.pending(), 1, 'only the bounded startup timer');
    backend.change('on');
    assert.equal(await pending, true);
    assert.equal(coordinator.getState().state, 'on');
    assert.equal(clock.pending(), 0);
    assert.ok(changes.every(state => state.confirmed === (state.state === 'on')));
    coordinator.dispose();
  });

  test('same-duration concurrent Manual calls share startup and do not restart a timer', async () => {
    const { coordinator, backend, clock } = setup();
    const first = coordinator.manual(60_000);
    const before = coordinator.getState();
    const timers = clock.setTimerCalls;
    clock.advance(1_000);
    assert.equal(coordinator.manual(60_000), first);
    assert.equal(coordinator.getState().generation, before.generation);
    assert.equal(coordinator.getState().expiresAt, before.expiresAt);
    assert.equal(clock.setTimerCalls, timers);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.resets, 1);
    backend.change('on');
    assert.equal(await first, true);
    coordinator.dispose();
  });

  test('same active Manual duration does not extend its deadline', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual(5_000);
    backend.change('on');
    await pending;
    const before = coordinator.getState();
    const timers = clock.setTimerCalls;
    clock.advance(1_000);
    assert.equal(await coordinator.manual(5_000), true);
    assert.equal(coordinator.getState().expiresAt, before.expiresAt);
    assert.equal(coordinator.getState().generation, before.generation);
    assert.equal(clock.setTimerCalls, timers);
    clock.advance(4_000);
    assert.equal(coordinator.getState().mode, 'off');
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('changing a requested duration replaces its deadline without a power gap', async () => {
    const { coordinator, backend, clock } = setup();
    const first = coordinator.manual(30_000);
    backend.change('on');
    await first;
    clock.advance(1_000);
    assert.equal(await coordinator.manual(5_000), true);
    assert.equal(coordinator.getState().expiresAt, clock.now() + 5_000);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 1);
    assert.equal(await coordinator.manual(), true);
    assert.equal(coordinator.getState().durationMs, 0);
    assert.equal(coordinator.getState().expiresAt, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('a superseded manual startup resolves false without extending backend startup', async () => {
    const { coordinator, backend, clock } = setup();
    const first = coordinator.manual(60_000);
    clock.advance(500);
    const second = coordinator.manual();
    assert.notEqual(first, second);
    assert.equal(await first, false);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 1);
    backend.change('on');
    assert.equal(await second, true);
    coordinator.dispose();
  });

  test('manual duration validation is integer-only and never changes an existing hold', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual(60_000);
    backend.change('on');
    await pending;
    const before = coordinator.getState();
    const timers = clock.setTimerCalls;
    for (const invalid of [-1, 0.5, NaN, Infinity, MAX_HOLD_MS + 1, '1000', null, {}]) {
      const value = /** @type {number} */ (/** @type {unknown} */ (invalid));
      assert.equal(await coordinator.manual(value), false);
      assert.equal(coordinator.getState().durationMs, before.durationMs);
      assert.equal(coordinator.getState().expiresAt, before.expiresAt);
      assert.equal(coordinator.getState().generation, before.generation);
      assert.equal(coordinator.getState().confirmed, true);
      assert.equal(clock.setTimerCalls, timers);
      assert.equal(backend.acquisitions.length, 1);
      assert.equal(backend.releases, 0);
    }
    assert.match(coordinator.getState().notice, /duration|milliseconds/i);
    coordinator.dispose();
  });

  test('invalid duration from Off cannot acquire or create timers', async () => {
    const { coordinator, backend, clock } = setup();
    assert.equal(await coordinator.manual(-1), false);
    assert.equal(coordinator.getState().mode, 'off');
    assert.equal(coordinator.getState().desired, false);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('a full 24-hour manual duration is accepted and expires exactly once', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual(MAX_HOLD_MS);
    backend.change('on');
    await pending;
    clock.advance(MAX_HOLD_MS - 1);
    assert.equal(coordinator.getState().confirmed, true);
    clock.advance(1);
    assert.equal(coordinator.getState().state, 'off');
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('expiry during startup settles false and late readiness cannot reactivate it', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual(1);
    clock.advance(1);
    assert.equal(await pending, false);
    assert.equal(coordinator.getState().mode, 'off');
    assert.equal(clock.pending(), 0);
    backend.change('on');
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(coordinator.getState().desired, false);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('Off invalidates generation, is release-idempotent, and settles startup', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual();
    const generation = coordinator.getState().generation;
    coordinator.off();
    assert.equal(await pending, false);
    assert.ok(coordinator.getState().generation > generation);
    coordinator.off();
    assert.equal(backend.releases, 1);
    assert.equal(coordinator.getState().state, 'off');
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('display policy is captured at construction and fixed for every acquisition', async () => {
    const options = { keepDisplayOn: false };
    const { coordinator, backend } = setup(options);
    options.keepDisplayOn = true;
    for (let i = 0; i < 2; i++) {
      const pending = coordinator.manual();
      backend.change('on');
      await pending;
      coordinator.off();
    }
    assert.deepEqual(backend.acquisitions, [{ display: false }, { display: false }]);
    coordinator.dispose();
  });
});

test.describe('ActivityCoordinator truthful backend state', () => {
  test('backend startup error remains Failed with desired ownership intact', async () => {
    const { coordinator, backend, clock, logs } = setup();
    backend.afterAcquire = () => backend.change('error', 'Native helper unavailable.');
    assert.equal(await coordinator.manual(), false);
    const state = coordinator.getState();
    assert.equal(state.state, 'failed');
    assert.equal(state.desired, true);
    assert.equal(state.confirmed, false);
    assert.equal(state.ownerCount, 1);
    assert.match(state.error, /helper unavailable/i);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 0);
    assert.ok(logs.every(message => !message.includes('Native helper unavailable.')));
    coordinator.dispose();
  });

  test('default startup deadline is 10 seconds, with visible failure and later recovery', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual();
    clock.advance(9_999);
    assert.equal(coordinator.getState().state, 'starting');
    clock.advance(1);
    assert.equal(await pending, false);
    assert.equal(coordinator.getState().state, 'failed');
    assert.equal(coordinator.getState().desired, true);
    assert.equal(coordinator.getState().confirmed, false);
    assert.match(coordinator.getState().error, /10|timed out|deadline/i);
    assert.equal(clock.pending(), 0);
    assert.equal(backend.releases, 0, 'the backend owns its bounded recovery attempts');
    backend.change('on');
    assert.equal(coordinator.getState().state, 'on');
    assert.equal(coordinator.getState().error, '');
    assert.equal(await coordinator.manual(), true);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('repeated Starting notifications and calls do not extend a custom startup deadline', async () => {
    const { coordinator, backend, clock } = setup({ startupTimeoutMs: 500 });
    const pending = coordinator.manual();
    clock.advance(499);
    backend.change('starting');
    assert.equal(coordinator.manual(), pending);
    clock.advance(1);
    assert.equal(await pending, false);
    assert.equal(coordinator.getState().state, 'failed');
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('helper loss clears confirmation immediately and a backend retry may recover', async () => {
    const { coordinator, backend, clock } = setup();
    const pending = coordinator.manual();
    backend.change('on');
    await pending;
    backend.change('starting');
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(coordinator.getState().state, 'starting');
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(clock.pending(), 1);
    backend.change('on');
    assert.equal(coordinator.getState().confirmed, true);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('error and unexpected Off never remain green or discard active owners', async () => {
    const { coordinator, backend } = setup();
    const pending = coordinator.manual();
    backend.change('on');
    await pending;
    for (const state of /** @type {const} */ (['error', 'off'])) {
      backend.change(state, 'Power assertion lost.');
      assert.equal(coordinator.getState().state, 'failed');
      assert.equal(coordinator.getState().confirmed, false);
      assert.equal(coordinator.getState().desired, true);
      assert.equal(coordinator.getState().ownerCount, 1);
      backend.change('starting');
      backend.change('on');
      assert.equal(coordinator.getState().state, 'on');
    }
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('non-Windows-style process survival is Unverified, never native confirmation', async () => {
    const { coordinator, backend, clock } = setup({ nativeAcknowledgement: false, keepDisplayOn: false });
    const pending = coordinator.manual();
    backend.change('on');
    assert.equal(await pending, false);
    assert.equal(coordinator.getState().state, 'unverified');
    assert.equal(coordinator.getState().desired, true);
    assert.equal(coordinator.getState().confirmed, false);
    assert.deepEqual(coordinator.getState().helpers, ['fake-system']);
    assert.equal(clock.pending(), 0);
    coordinator.off();
    assert.equal(backend.releases, 1);
    coordinator.dispose();
  });

  test('a throwing acquisition fails without leaking raw backend details to logs', async () => {
    const { coordinator, backend, clock, logs } = setup();
    backend.throwAcquire = true;
    assert.equal(await coordinator.manual(), false);
    assert.equal(coordinator.getState().state, 'failed');
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(clock.pending(), 0);
    assert.ok(logs.every(message => !message.includes('PRIVATE_BACKEND_DETAIL')));
    coordinator.off();
    assert.equal(coordinator.getState().desired, false);
    coordinator.dispose();
  });

  test('throwing cleanup cannot strand coordinator timers or revive desired ownership', async () => {
    const { coordinator, backend, clock, logs } = setup();
    const pending = coordinator.manual(30_000);
    backend.change('on');
    await pending;
    backend.throwRelease = true;
    assert.doesNotThrow(() => coordinator.off());
    assert.equal(coordinator.getState().state, 'off');
    assert.equal(coordinator.getState().desired, false);
    assert.equal(clock.pending(), 0);
    assert.doesNotThrow(() => coordinator.dispose());
    assert.ok(logs.every(message => !message.includes('PRIVATE_RELEASE_DETAIL')));
  });

  test('diagnostic logger failures cannot affect power ownership', async () => {
    const { coordinator, backend, clock } = setup({ log: () => { throw new Error('closed output channel'); } });
    const pending = coordinator.manual(1_000);
    backend.change('on');
    assert.equal(await pending, true);
    assert.doesNotThrow(() => coordinator.off());
    assert.equal(backend.wanted, false);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });
});

test.describe('ActivityCoordinator verified mock owner algorithm (not native Auto)', () => {
  test('one backend acquisition aggregates root, tool, subagent, and reason leases', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const root = requireLease(coordinator.begin(owner(coordinator)));
    const tool = requireLease(coordinator.begin(owner(coordinator, { kind: 'tool', operationId: 'tool-1', parentId: 'root-1' })));
    const subagent = requireLease(coordinator.begin(owner(coordinator, { kind: 'subagent', operationId: 'agent-1', parentId: 'root-1' })));
    const reason = requireLease(coordinator.begin(owner(coordinator, { kind: 'reason', operationId: 'reason-1' })));
    backend.change('on');
    assert.equal(coordinator.getState().ownerCount, 4);
    assert.equal(coordinator.getState().confirmed, true);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(clock.pending(), 1, 'one nearest-expiry timer, no polling');
    for (const lease of [root, tool, subagent]) assert.equal(coordinator.end(lease), true);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(backend.releases, 0);
    assert.equal(coordinator.end(reason), true);
    assert.equal(backend.releases, 1);
    assert.equal(coordinator.getState().state, 'waiting');
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('duplicate begins return the same immutable lease and never extend a root', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const metadata = owner(coordinator);
    const lease = requireLease(coordinator.begin(metadata));
    backend.change('on');
    const timers = clock.setTimerCalls;
    const deadline = coordinator.getState().expiresAt;
    clock.advance(60_000);
    assert.equal(coordinator.begin({ ...metadata }), lease);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().expiresAt, deadline);
    assert.equal(clock.setTimerCalls, timers);
    assert.equal(Object.isFrozen(lease), true);
    metadata.operationId = 'mutated-outside';
    assert.equal(lease.operationId, 'root-1');
    assert.equal(coordinator.end(lease), true);
    coordinator.dispose();
  });

  test('identity is scoped by adapter, session, kind, and operation rather than raw counters', () => {
    const { coordinator, backend } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const variants = [
      {},
      { adapter: 'another-adapter' },
      { sessionId: 'another-session' },
      { kind: /** @type {const} */ ('reason') },
      { operationId: 'another-root' },
      { adapter: 'unit:adapter', sessionId: 'session' },
      { adapter: 'unit', sessionId: 'adapter:session' }
    ];
    const leases = variants.map(variant => requireLease(coordinator.begin(owner(coordinator, variant))));
    assert.equal(coordinator.getState().ownerCount, variants.length);
    assert.equal(backend.acquisitions.length, 1);
    for (const lease of leases) assert.equal(coordinator.end(lease), true);
    assert.equal(backend.releases, 1);
    coordinator.dispose();
  });

  test('wrong instance, stale generation, Off, and Manual cannot accept an Auto owner', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    const old = owner(coordinator);
    assert.equal(coordinator.begin(old), undefined);
    coordinator.auto();
    assert.equal(coordinator.begin(old), undefined);
    assert.equal(coordinator.begin(owner(coordinator, { instanceId: 'another-window' })), undefined);
    assert.equal(coordinator.begin(owner(coordinator, { generation: coordinator.getState().generation + 1 })), undefined);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    const pending = coordinator.manual();
    assert.equal(coordinator.begin(owner(coordinator)), undefined);
    backend.change('on');
    await pending;
    coordinator.dispose();
  });

  test('malformed, oversized, content-bearing, and control-character metadata is rejected', () => {
    const { coordinator, backend, clock, logs } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const valid = owner(coordinator);
    const invalid = [
      null, undefined, [], {}, 'PRIVATE_PROMPT',
      { ...valid, adapter: '' },
      { ...valid, sessionId: 'x'.repeat(129) },
      { ...valid, operationId: 'PRIVATE\nPROMPT' },
      { ...valid, operationId: 'space separated' },
      { ...valid, kind: 'token' },
      { ...valid, generation: NaN },
      { ...valid, generation: 1.5 },
      { ...valid, generation: '1' },
      { ...valid, parentId: '' },
      { ...valid, parentId: 'x'.repeat(129) },
      { ...valid, prompt: 'PRIVATE_PROMPT' },
      { ...valid, transcript_path: 'PRIVATE_TRANSCRIPT' }
    ];
    for (const value of invalid) {
      assert.equal(coordinator.begin(/** @type {import('../../src/activityCoordinator').ActivityOwner} */ (value)), undefined);
    }
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(backend.acquisitions.length, 0);
    assert.equal(clock.pending(), 0);
    assert.ok(logs.every(message => !/PRIVATE|session-1|root-1|window-A/.test(message)));
    assert.ok(logs.length < invalid.length, 'repetitive rejection warnings are bounded');
    coordinator.dispose();
  });

  test('unknown, copied, cross-window, and duplicate end calls cannot release another owner', () => {
    const first = setup({ autoCapability: MOCK_CAPABILITY });
    const second = setup({ autoCapability: MOCK_CAPABILITY });
    first.coordinator.auto();
    second.coordinator.auto();
    const lease = requireLease(first.coordinator.begin(owner(first.coordinator)));
    const other = requireLease(second.coordinator.begin(owner(second.coordinator)));
    assert.equal(first.coordinator.end(/** @type {import('../../src/activityCoordinator').ActivityLease} */ ({})), false);
    assert.equal(first.coordinator.end({ ...lease }), false, 'leases are opaque object identities');
    assert.equal(first.coordinator.end(other), false);
    assert.equal(first.coordinator.getState().ownerCount, 1);
    assert.equal(first.coordinator.end(lease), true);
    assert.equal(first.coordinator.end(lease), false);
    assert.equal(first.backend.releases, 1);
    first.coordinator.dispose();
    second.coordinator.dispose();
  });

  test('completed identities cannot be replayed to reacquire in the same generation', () => {
    const { coordinator, backend } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const metadata = owner(coordinator);
    const lease = requireLease(coordinator.begin(metadata));
    assert.equal(coordinator.end(lease), true);
    assert.equal(coordinator.begin(metadata), undefined);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(coordinator.getState().ownerCount, 0);
    coordinator.dispose();
  });

  test('an old root ending cannot end a newer overlapping operation in the same session', () => {
    const { coordinator, backend } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const old = requireLease(coordinator.begin(owner(coordinator)));
    const current = requireLease(coordinator.begin(owner(coordinator, { operationId: 'root-2' })));
    coordinator.end(old);
    assert.equal(coordinator.end(old), false);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(backend.releases, 0);
    coordinator.end(current);
    assert.equal(backend.releases, 1);
    coordinator.dispose();
  });

  test('ending a parent retains its independently tracked children and original safeguard', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const root = requireLease(coordinator.begin(owner(coordinator)));
    backend.change('on');
    const deadline = coordinator.getState().expiresAt;
    clock.advance(MAX_HOLD_MS - 1_000);
    const tool = requireLease(coordinator.begin(owner(coordinator, { kind: 'tool', operationId: 'tool-1', parentId: 'root-1' })));
    const child = requireLease(coordinator.begin(owner(coordinator, { kind: 'subagent', operationId: 'agent-1', parentId: 'tool-1' })));
    coordinator.end(root);
    coordinator.end(tool);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().expiresAt, deadline);
    assert.equal(backend.releases, 0);
    clock.advance(1_000);
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(coordinator.end(child), false);
    assert.equal(backend.releases, 1);
    assert.match(coordinator.getState().notice, /safeguard|24.hour/i);
    assert.match(coordinator.getState().notice, /may still be running/i);
    assert.doesNotMatch(coordinator.getState().notice, /completed/i);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('a child arriving after parent end inherits the retained parent deadline', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const root = requireLease(coordinator.begin(owner(coordinator)));
    const deadline = coordinator.getState().expiresAt;
    coordinator.end(root);
    clock.advance(1_000);
    const child = requireLease(coordinator.begin(owner(coordinator, { kind: 'subagent', operationId: 'agent-1', parentId: 'root-1' })));
    assert.equal(coordinator.getState().expiresAt, deadline);
    assert.equal(backend.acquisitions.length, 2);
    coordinator.end(child);
    coordinator.dispose();
  });

  test('missing, ambiguous, self, and cross-session parents are not inferred', () => {
    const { coordinator } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    requireLease(coordinator.begin(owner(coordinator)));
    for (const overrides of [
      { kind: /** @type {const} */ ('root'), parentId: 'root-1', operationId: 'root-2' },
      { kind: /** @type {const} */ ('tool'), parentId: 'missing', operationId: 'tool-1' },
      { kind: /** @type {const} */ ('tool'), parentId: 'tool-1', operationId: 'tool-1' },
      { kind: /** @type {const} */ ('tool'), parentId: 'root-1', operationId: 'tool-1', sessionId: 'other-session' }
    ]) {
      assert.equal(coordinator.begin(owner(coordinator, overrides)), undefined);
    }
    requireLease(coordinator.begin(owner(coordinator, { kind: 'reason' })));
    assert.equal(coordinator.begin(owner(coordinator, { kind: 'tool', operationId: 'tool-1', parentId: 'root-1' })), undefined);
    assert.equal(coordinator.getState().ownerCount, 2);
    coordinator.dispose();
  });

  test('expiry releases only expired roots and reschedules only the nearest deadline', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const first = requireLease(coordinator.begin(owner(coordinator)));
    backend.change('on');
    clock.advance(60_000);
    const second = requireLease(coordinator.begin(owner(coordinator, { operationId: 'root-2' })));
    const timers = clock.setTimerCalls;
    assert.equal(clock.pending(), 1);
    assert.equal(coordinator.begin(owner(coordinator, { operationId: 'root-2' })), second);
    assert.equal(clock.setTimerCalls, timers);
    clock.advance(MAX_HOLD_MS - 60_000);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.end(first), false);
    assert.equal(backend.releases, 0);
    assert.equal(coordinator.getState().expiresAt, second.expiresAt);
    assert.equal(clock.pending(), 1);
    clock.advance(60_000);
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('an expired root or descendant cannot be revived by late activity', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const metadata = owner(coordinator);
    requireLease(coordinator.begin(metadata));
    backend.change('on');
    clock.advance(MAX_HOLD_MS);
    assert.equal(coordinator.begin(metadata), undefined);
    assert.equal(coordinator.begin(owner(coordinator, { kind: 'tool', operationId: 'late-tool', parentId: 'root-1' })), undefined);
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('Auto to Manual replaces all owners without releasing or reacquiring power', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const lease = requireLease(coordinator.begin(owner(coordinator)));
    backend.change('on');
    const generation = coordinator.getState().generation;
    assert.equal(await coordinator.manual(), true);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().mode, 'manual');
    assert.ok(coordinator.getState().generation > generation);
    assert.equal(coordinator.end(lease), false);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('Auto startup to Manual shares the backend startup without a protection gap', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    requireLease(coordinator.begin(owner(coordinator)));
    clock.advance(1_000);
    const pending = coordinator.manual();
    assert.equal(clock.pending(), 1, 'old Auto expiry is removed, startup is preserved');
    backend.change('on');
    assert.equal(await pending, true);
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    coordinator.dispose();
  });

  test('verified mock Auto replaces Manual with idle Waiting, not unobserved protection', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    const pending = coordinator.manual(60_000);
    assert.equal(coordinator.auto(), true);
    assert.equal(await pending, false);
    assert.equal(coordinator.getState().state, 'waiting');
    assert.equal(coordinator.getState().desired, false);
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('Off clears all leases and rejects old metadata even after Auto is rearmed', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    const metadata = owner(coordinator);
    const lease = requireLease(coordinator.begin(metadata));
    coordinator.off();
    assert.equal(coordinator.end(lease), false);
    assert.equal(coordinator.begin(metadata), undefined);
    coordinator.auto();
    assert.equal(coordinator.begin(metadata), undefined);
    assert.equal(coordinator.getState().state, 'waiting');
    assert.equal(clock.pending(), 0);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('active ownership is bounded and rejected overflow leaves existing leases intact', () => {
    const { coordinator, backend } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    for (let i = 0; i < 1_024; i++) {
      requireLease(coordinator.begin(owner(coordinator, { operationId: `root-${i}` })));
    }
    assert.equal(coordinator.begin(owner(coordinator, { operationId: 'overflow' })), undefined);
    assert.equal(coordinator.getState().ownerCount, 1_024);
    assert.match(coordinator.getState().notice, /limit|capacity/i);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.off();
    coordinator.auto();
    requireLease(coordinator.begin(owner(coordinator, { operationId: 'fresh' })));
    assert.equal(coordinator.getState().ownerCount, 1);
    coordinator.dispose();
  });

  test('completed identity history is bounded rather than evicting stale-event protection', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    backend.afterAcquire = () => backend.change('on');
    for (let i = 0; i < 4_096; i++) {
      const lease = requireLease(coordinator.begin(owner(coordinator, { operationId: `root-${i}` })));
      assert.equal(coordinator.end(lease), true);
    }
    assert.equal(coordinator.begin(owner(coordinator, { operationId: 'history-overflow' })), undefined);
    assert.equal(coordinator.begin(owner(coordinator, { operationId: 'root-0' })), undefined);
    assert.equal(coordinator.getState().ownerCount, 0);
    assert.equal(clock.pending(), 0);
    assert.match(coordinator.getState().notice, /limit|capacity/i);
    coordinator.dispose();
  });

  test('500 begin/end cycles return owners, timers, and listeners to baseline', () => {
    const { coordinator, backend, clock, logs } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    backend.afterAcquire = () => backend.change('on');
    for (let i = 0; i < 500; i++) {
      const lease = requireLease(coordinator.begin(owner(coordinator, { operationId: `operation-private-${i}` })));
      assert.equal(coordinator.end(lease), true);
      assert.equal(coordinator.end(lease), false);
      assert.equal(coordinator.getState().ownerCount, 0);
      assert.equal(coordinator.getState().state, 'waiting');
      assert.equal(clock.pending(), 0);
      assert.equal(backend.listenerCount('change'), 1);
    }
    assert.equal(backend.acquisitions.length, 500);
    assert.equal(backend.releases, 500);
    assert.ok(logs.every(message => !/operation-private|window-A|session-1|unit-adapter/.test(message)));
    coordinator.dispose();
    assert.equal(backend.listenerCount('change'), 0);
    assert.equal(coordinator.listenerCount('change'), 0);
    assert.equal(clock.pending(), 0);
  });
});

test.describe('ActivityCoordinator reentrancy and stale callbacks', () => {
  test('Auto cannot report armed after a synchronous listener turns Off or disposes it', () => {
    for (const dispose of [false, true]) {
      const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
      coordinator.on('change', state => {
        if (state.mode === 'auto') {
          if (dispose) coordinator.dispose();
          else coordinator.off();
        }
      });
      assert.equal(coordinator.auto(), false);
      assert.equal(coordinator.getState().mode, 'off');
      assert.equal(backend.acquisitions.length, 0);
      assert.equal(clock.pending(), 0);
      coordinator.dispose();
    }
  });

  test('EventEmitter listener removal does not invoke the no-argument power Off command', async () => {
    const { coordinator, backend } = setup();
    const listener = () => {};
    coordinator.on('change', listener);
    const pending = coordinator.manual();
    backend.change('on');
    await pending;
    assert.equal(coordinator.off('change', listener), coordinator);
    assert.equal(coordinator.listenerCount('change'), 1);
    assert.equal(coordinator.getState().confirmed, true);
    assert.equal(backend.releases, 0);
    assert.equal(coordinator.off(), undefined);
    assert.equal(coordinator.getState().state, 'off');
    coordinator.dispose();
  });

  test('Off during synchronous Starting cannot leave a lease, timer, or reacquisition', async () => {
    const { coordinator, backend, clock } = setup();
    coordinator.on('change', state => {
      if (state.state === 'starting') coordinator.off();
    });
    assert.equal(await coordinator.manual(60_000), false);
    assert.equal(coordinator.getState().state, 'off');
    assert.equal(backend.wanted, false);
    assert.equal(clock.pending(), 0);
    assert.ok(backend.acquisitions.length <= 1);
    coordinator.dispose();
  });

  test('dispose during Starting prevents all later calls and synchronous Off reacquisition', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.on('change', state => {
      if (state.state === 'starting') coordinator.dispose();
      if (state.state === 'off') void coordinator.manual();
    });
    assert.equal(await coordinator.manual(60_000), false);
    assert.equal(await coordinator.manual(), false);
    assert.equal(coordinator.auto(), false);
    assert.equal(coordinator.begin(owner(coordinator)), undefined);
    assert.equal(coordinator.getState().state, 'off');
    assert.equal(backend.wanted, false);
    assert.equal(backend.disposals, 1);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
    assert.equal(backend.disposals, 1);
  });

  test('a reentrant same-duration Manual call uses the existing startup promise', async () => {
    const { coordinator, backend } = setup();
    /** @type {Promise<boolean> | undefined} */
    let reentrant;
    coordinator.on('change', state => {
      if (state.state === 'starting') reentrant = coordinator.manual();
    });
    const pending = coordinator.manual();
    assert.equal(reentrant, pending);
    backend.change('on');
    assert.equal(await pending, true);
    assert.equal(backend.acquisitions.length, 1);
    coordinator.dispose();
  });

  test('reentrant Auto to Manual invalidates the returned Auto lease without releasing power', async () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    /** @type {Promise<boolean> | undefined} */
    let manual;
    coordinator.on('change', state => {
      if (state.mode === 'auto' && state.state === 'starting') manual = coordinator.manual();
    });
    assert.equal(coordinator.begin(owner(coordinator)), undefined);
    backend.change('on');
    assert.equal(await manual, true);
    assert.equal(coordinator.getState().mode, 'manual');
    assert.equal(backend.acquisitions.length, 1);
    assert.equal(backend.releases, 0);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });

  test('late callbacks from cleared startup and expiry timers cannot affect a replacement session', async () => {
    const clock = createClock();
    /** @type {(() => void)[]} */
    const callbacks = [];
    const setTimer = /** @type {typeof setTimeout} */ ((/** @type {() => void} */ fn, /** @type {number | undefined} */ ms) => {
      callbacks.push(() => fn());
      return clock.setTimer(fn, ms);
    });
    const { coordinator, backend } = setup({ now: clock.now, setTimer, clearTimer: clock.clearTimer });
    const old = coordinator.manual(1_000);
    const stale = callbacks.slice();
    coordinator.off();
    assert.equal(await old, false);
    const current = coordinator.manual(30_000);
    backend.change('on');
    assert.equal(await current, true);
    const deadline = coordinator.getState().expiresAt;
    for (const callback of stale) callback();
    assert.equal(coordinator.getState().state, 'on');
    assert.equal(coordinator.getState().expiresAt, deadline);
    assert.equal(backend.acquisitions.length, 2);
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 1);
    coordinator.dispose();
  });

  test('last-owner release can reentrantly start fresh work without stale cleanup stopping it', () => {
    const { coordinator, backend, clock } = setup({ autoCapability: MOCK_CAPABILITY });
    coordinator.auto();
    backend.afterAcquire = () => backend.change('on');
    const first = requireLease(coordinator.begin(owner(coordinator)));
    /** @type {import('../../src/activityCoordinator').ActivityLease | undefined} */
    let next;
    coordinator.on('change', state => {
      if (state.state === 'waiting' && !next) {
        next = coordinator.begin(owner(coordinator, { operationId: 'root-2' }));
      }
    });
    coordinator.end(first);
    assert.ok(next);
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().state, 'on');
    assert.equal(backend.wanted, true);
    assert.equal(backend.acquisitions.length, 2);
    assert.equal(backend.releases, 1);
    assert.equal(clock.pending(), 1);
    coordinator.dispose();
  });
});

test.describe('ActivityCoordinator with the real KeepAwake class and fake child processes', () => {
  test('Windows READY, crash retry, and cleanup use the existing backend only', async () => {
    const clock = createClock();
    const sp = createSpawn();
    const backend = new KeepAwake({
      platform: 'win32',
      exists: () => true,
      spawn: sp.spawn,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBaseMs: 100,
      readyTimeoutMs: 1_000
    });
    const coordinator = new ActivityCoordinator(backend, {
      keepDisplayOn: true, nativeAcknowledgement: true,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
    });
    const pending = coordinator.manual();
    assert.equal(sp.children.length, 1);
    assert.match(sp.last().args[4], /2147483651/);
    const first = sp.last().spawned().ready();
    assert.equal(await pending, true);
    first.exit(1);
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(coordinator.getState().desired, true);
    clock.advance(100);
    assert.equal(sp.children.length, 2);
    const replacement = sp.last().spawned().ready();
    assert.equal(coordinator.getState().confirmed, true);
    coordinator.dispose();
    assert.equal(replacement.stdin.ended, true);
    assert.equal(replacement.killed, true);
    first.ready().exit(1);
    clock.advance(100_000);
    assert.equal(sp.children.length, 2);
    assert.equal(clock.pending(), 0);
    assert.equal(backend.listenerCount('change'), 0);
  });

  test('caffeinate survival still reports Unverified, without claiming native Auto', async () => {
    const clock = createClock();
    const sp = createSpawn();
    const backend = new KeepAwake({
      platform: 'darwin', exists: () => true, spawn: sp.spawn,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
    });
    const coordinator = new ActivityCoordinator(backend, {
      keepDisplayOn: false, nativeAcknowledgement: false,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
    });
    const pending = coordinator.manual();
    sp.last().spawned();
    clock.advance(1_000);
    assert.equal(await pending, false);
    assert.equal(backend.state, 'on');
    assert.equal(coordinator.getState().state, 'unverified');
    assert.equal(coordinator.getState().confirmed, false);
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
    assert.equal(sp.last().killed, true);
  });

  test('bounded backend failures never erase Auto owners or cancel unrelated work', () => {
    const clock = createClock();
    const sp = createSpawn();
    const backend = new KeepAwake({
      platform: 'win32', exists: () => true, spawn: sp.spawn,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      retryBaseMs: 1, readyTimeoutMs: 100, maxQuickFailures: 2
    });
    const coordinator = new ActivityCoordinator(backend, {
      autoCapability: MOCK_CAPABILITY, nativeAcknowledgement: true,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
    });
    coordinator.auto();
    const lease = requireLease(coordinator.begin(owner(coordinator)));
    sp.last().spawned().exit(1);
    clock.advance(1);
    sp.last().spawned().exit(1);
    assert.equal(coordinator.getState().state, 'failed');
    assert.equal(coordinator.getState().ownerCount, 1);
    assert.equal(coordinator.getState().confirmed, false);
    clock.advance(1_000);
    assert.equal(sp.children.length, 2);
    assert.equal(coordinator.end(lease), true);
    assert.equal(backend.state, 'off');
    assert.equal(clock.pending(), 0);
    coordinator.dispose();
  });
});

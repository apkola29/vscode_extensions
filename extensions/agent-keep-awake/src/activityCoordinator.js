// @ts-check
'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const MAX_HOLD_MS = 24 * 60 * 60_000;
const STARTUP_TIMEOUT_MS = 10_000;
const MAX_OWNERS = 1_024;
const MAX_IDENTITIES = 4_096;
const OWNER_FIELDS = new Set(['instanceId', 'generation', 'adapter', 'sessionId', 'operationId', 'kind', 'parentId']);
const UNAVAILABLE = Object.freeze({
  status: /** @type {const} */ ('unavailable'),
  harness: 'none',
  reason: 'No verified native Copilot activity adapter is available. Use Keep awake.'
});

/**
 * @typedef {'off' | 'manual' | 'auto'} ActivityMode
 * @typedef {'off' | 'starting' | 'on' | 'failed' | 'unverified' | 'waiting' | 'unavailable' | 'limited'} ActivityState
 * @typedef {'info' | 'warn' | 'error' | 'debug'} LogLevel
 *
 * @typedef {object} AutoCapability
 * @property {'unavailable' | 'limited' | 'verified'} status
 * @property {string} harness
 * @property {string} reason
 *
 * @typedef {object} ActivityOwner
 * @property {string} instanceId
 * @property {number} generation
 * @property {string} adapter
 * @property {string} sessionId
 * @property {string} operationId
 * @property {'root' | 'tool' | 'subagent' | 'reason'} kind
 * @property {string} [parentId] Verified parent operation identity in the same adapter/session.
 *
 * @typedef {Readonly<ActivityOwner & {expiresAt: number}>} ActivityLease
 *
 * @typedef {Pick<InstanceType<typeof import('./keepAwake').KeepAwake>,
 *   'state' | 'error' | 'pids' | 'activeHelpers' | 'acquire' | 'release'> &
 *   Pick<InstanceType<typeof EventEmitter>, 'on' | 'removeListener'> &
 *   Partial<Pick<InstanceType<typeof import('./keepAwake').KeepAwake>, 'resetFailures' | 'dispose'>>} ActivityBackend
 *
 * @typedef {object} ActivityCoordinatorOptions
 * @property {(level: LogLevel, message: string) => void} [log]
 * @property {boolean} [keepDisplayOn]
 * @property {boolean} [nativeAcknowledgement] Backend On represents a native acknowledgement, not process survival.
 * @property {() => number} [now]
 * @property {typeof setTimeout} [setTimer]
 * @property {typeof clearTimeout} [clearTimer]
 * @property {number} [startupTimeoutMs]
 * @property {string} [instanceId]
 * @property {AutoCapability} [autoCapability] A capability declaration, not an adapter or lifecycle proof.
 *
 * @typedef {object} ActivityCoordinatorState
 * @property {ActivityMode} mode
 * @property {ActivityState} state
 * @property {boolean} desired
 * @property {boolean} confirmed
 * @property {number} ownerCount
 * @property {number} generation
 * @property {string} instanceId
 * @property {number} durationMs Zero means indefinite Manual, or no manual duration.
 * @property {number} expiresAt Zero means no deadline; Auto reports the nearest owner safeguard.
 * @property {string} error
 * @property {string} notice
 * @property {AutoCapability} auto
 * @property {import('./keepAwake').KeepAwakeState} backendState
 * @property {number[]} pids
 * @property {string[]} helpers
 *
 * @typedef {{at: number, handle?: ReturnType<typeof setTimeout>}} ScheduledTimer
 * @typedef {{promise: Promise<boolean>, resolve: (confirmed: boolean) => void}} ManualWait
 */

/** @param {unknown} value @returns {value is string} */
function validId(value) {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

/** @param {unknown} value @returns {value is number} */
function validDuration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_HOLD_MS;
}

/**
 * Read only bounded metadata data properties; never retain the caller's envelope or execute getters.
 * @param {unknown} value
 * @returns {ActivityOwner | undefined}
 */
function readOwner(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > OWNER_FIELDS.size || keys.some(key => typeof key !== 'string' || !OWNER_FIELDS.has(key))) return undefined;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !('value' in fields[key]))) return undefined;
    /** @type {unknown} */
    const instanceId = fields.instanceId?.value;
    /** @type {unknown} */
    const generation = fields.generation?.value;
    /** @type {unknown} */
    const adapter = fields.adapter?.value;
    /** @type {unknown} */
    const sessionId = fields.sessionId?.value;
    /** @type {unknown} */
    const operationId = fields.operationId?.value;
    /** @type {unknown} */
    const kind = fields.kind?.value;
    /** @type {unknown} */
    const parentId = fields.parentId?.value;
    if (!validId(instanceId) || !validId(adapter) || !validId(sessionId) || !validId(operationId) ||
      typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 ||
      (kind !== 'root' && kind !== 'tool' && kind !== 'subagent' && kind !== 'reason') ||
      (parentId !== undefined && (!validId(parentId) || kind === 'root' || parentId === operationId))) return undefined;
    return { instanceId, generation, adapter, sessionId, operationId, kind, ...(parentId === undefined ? {} : { parentId }) };
  } catch {
    return undefined;
  }
}

/** @param {ActivityOwner} owner */
function ownerKey(owner) {
  return JSON.stringify([owner.instanceId, owner.generation, owner.adapter, owner.sessionId, owner.kind, owner.operationId]);
}

class ActivityCoordinator extends EventEmitter {
  /**
   * Owns this backend exclusively. Production Stage A passes an unavailable Auto capability.
   * @param {ActivityBackend} backend
   * @param {ActivityCoordinatorOptions} [options]
   */
  constructor(backend, options = {}) {
    super();
    const instanceId = options.instanceId ?? randomUUID();
    if (!validId(instanceId)) throw new TypeError('Keep Awake requires a bounded window instance identity.');
    const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > MAX_HOLD_MS) {
      throw new RangeError('Keep Awake startup timeout must be a positive, bounded integer in milliseconds.');
    }
    const capability = options.autoCapability ?? UNAVAILABLE;
    this._auto = /** @type {AutoCapability} */ (
      capability && ['unavailable', 'limited', 'verified'].includes(capability.status) &&
      typeof capability.harness === 'string' && capability.harness.length > 0 && capability.harness.length <= 128 &&
      typeof capability.reason === 'string' && capability.reason.length <= 512
        ? { status: capability.status, harness: capability.harness, reason: capability.reason }
        : { ...UNAVAILABLE }
    );
    this._backend = backend;
    this._instanceId = instanceId;
    this._keepDisplayOn = options.keepDisplayOn ?? process.platform === 'win32';
    this._nativeAcknowledgement = options.nativeAcknowledgement ?? process.platform === 'win32';
    this._log = options.log ?? (() => {});
    this._now = options.now ?? Date.now;
    this._setTimer = options.setTimer ?? setTimeout;
    this._clearTimer = options.clearTimer ?? clearTimeout;
    this._startupTimeoutMs = startupTimeoutMs;
    /** @type {ActivityMode} */
    this._mode = 'off';
    this._generation = 0;
    this._durationMs = 0;
    this._manualExpiresAt = 0;
    this._notice = '';
    this._failure = '';
    this._startupExpired = false;
    this._powerWanted = false;
    this._powerVersion = 0;
    this._disposed = false;
    this._observedBackendState = backend.state;
    /** @type {Map<string, ActivityLease>} */
    this._owners = new Map();
    /** Completed identities retain parent deadlines and prevent replay until the next generation. */
    /** @type {Map<string, ActivityLease>} */
    this._identities = new Map();
    /** @type {WeakMap<ActivityLease, string>} */
    this._leaseKeys = new WeakMap();
    /** @type {Set<string>} */
    this._warnings = new Set();
    /** @type {ScheduledTimer | undefined} */
    this._expiryTimer = undefined;
    /** @type {ScheduledTimer | undefined} */
    this._startupTimer = undefined;
    /** @type {ManualWait | undefined} */
    this._manualWait = undefined;
    this._lastSnapshot = JSON.stringify(this.getState());
    this._onBackendChange = () => {
      if (!this._disposed) this._observeBackend();
    };
    backend.on('change', this._onBackendChange);
  }

  /**
   * Returns the same promise for an identical pending Manual request.
   * The result is native confirmation, not merely desired ownership or helper survival.
   * @param {number} [durationMs]
   * @returns {Promise<boolean>}
   */
  manual(durationMs = 0) {
    if (this._disposed) return Promise.resolve(false);
    if (!validDuration(durationMs)) {
      this._reject('invalid-duration', 'Keep Awake duration must be an integer from 0 to 24 hours in milliseconds.');
      return Promise.resolve(false);
    }
    this._expireIfDue();
    if (this._disposed) return Promise.resolve(false);
    if (this._mode === 'manual' && this._durationMs === durationMs) {
      return this._manualWait?.promise ?? Promise.resolve(this.getState().confirmed);
    }
    this._settleManual(false);
    this._nextGeneration();
    this._mode = 'manual';
    this._durationMs = durationMs;
    this._manualExpiresAt = durationMs === 0 ? 0 : this._now() + durationMs;
    this._notice = '';
    /** @type {(confirmed: boolean) => void} */
    let resolve = () => {};
    const promise = new Promise(/** @param {(confirmed: boolean) => void} finish */ finish => { resolve = finish; });
    this._manualWait = { promise, resolve };
    this._scheduleExpiry();
    this._reconcile();
    this._writeLog('info', 'manual-selected');
    return promise;
  }

  /** @overload @returns {void} */
  /**
   * @overload
   * @param {string | symbol} eventName
   * @param {Parameters<EventEmitter['removeListener']>[1]} listener
   * @returns {this}
   */
  /**
   * With no arguments release protection only, never native chat. Preserve EventEmitter's listener overload.
   * @param {string | symbol} [eventName]
   * @param {Parameters<EventEmitter['removeListener']>[1]} [listener]
   * @returns {this | undefined}
   */
  off(eventName, listener) {
    if (eventName !== undefined) {
      if (!listener) throw new TypeError('An event listener is required.');
      return this.removeListener(eventName, listener);
    }
    if (!this._disposed) this._turnOff('');
  }

  /** @returns {boolean} Whether a verified capability is armed. */
  auto() {
    if (this._disposed) return false;
    this._expireIfDue();
    if (this._disposed) return false;
    if (this._mode === 'manual' && this._auto.status !== 'verified') {
      this._reject('auto-unavailable', `Auto is ${this._auto.status}; Keep awake remains active. ${this._auto.reason}`);
      return false;
    }
    if (this._mode === 'auto') return this._acceptsAuto();
    this._settleManual(false);
    this._nextGeneration();
    this._mode = 'auto';
    this._durationMs = 0;
    this._manualExpiresAt = 0;
    this._notice = this._auto.status === 'verified'
      ? 'Auto tracks subsequent observed work only. Already-running work needs Keep awake.'
      : this._auto.reason;
    this._scheduleExpiry();
    this._reconcile();
    this._writeLog('info', 'auto-selected');
    return this._acceptsAuto();
  }

  /**
   * A verified mock capability exercises ownership only; this method does not discover native activity.
   * @param {ActivityOwner} owner
   * @returns {ActivityLease | undefined}
   */
  begin(owner) {
    if (!this._acceptsAuto()) return undefined;
    const metadata = readOwner(owner);
    if (!metadata) return this._reject('invalid-metadata');
    this._expireIfDue();
    if (!this._acceptsAuto()) return undefined;
    if (metadata.instanceId !== this._instanceId || metadata.generation !== this._generation) {
      return this._reject('stale-identity');
    }
    const key = ownerKey(metadata);
    const previous = this._identities.get(key);
    if (previous) {
      if (previous.parentId !== metadata.parentId) return this._reject('conflicting-parent');
      return this._owners.get(key) === previous ? previous : undefined;
    }
    if (this._owners.size >= MAX_OWNERS || this._identities.size >= MAX_IDENTITIES) {
      return this._reject('owner-limit', 'Auto reached its bounded operation limit. Use Keep awake, or turn Off before rearming Auto.');
    }
    const now = this._now();
    let expiresAt = now + MAX_HOLD_MS;
    if (metadata.parentId !== undefined) {
      let parent;
      for (const candidate of this._identities.values()) {
        if (candidate.adapter !== metadata.adapter || candidate.sessionId !== metadata.sessionId ||
          candidate.operationId !== metadata.parentId) continue;
        if (parent) return this._reject('ambiguous-parent');
        parent = candidate;
      }
      if (!parent) return this._reject('unknown-parent');
      if (parent.expiresAt <= now) return this._reject('expired-parent');
      expiresAt = parent.expiresAt;
    }
    const lease = Object.freeze({ ...metadata, expiresAt });
    this._owners.set(key, lease);
    this._identities.set(key, lease);
    this._leaseKeys.set(lease, key);
    this._scheduleExpiry();
    this._reconcile();
    this._writeLog('debug', 'owner-began');
    // A synchronous backend/change listener may have switched modes or disposed us.
    return this._acceptsAuto() && this._owners.get(key) === lease ? lease : undefined;
  }

  /** @param {ActivityLease} lease @returns {boolean} */
  end(lease) {
    if (!this._acceptsAuto() || !lease || typeof lease !== 'object') return false;
    this._expireIfDue();
    const key = this._leaseKeys.get(lease);
    if (!this._acceptsAuto() || key === undefined || this._owners.get(key) !== lease) return false;
    this._owners.delete(key);
    this._scheduleExpiry();
    this._reconcile();
    this._writeLog('debug', 'owner-ended');
    return true;
  }

  /** @returns {ActivityCoordinatorState} */
  getState() {
    const ownerCount = this._ownerCount();
    const desired = ownerCount > 0;
    const backendState = this._backend.state;
    const confirmed = desired && this._powerWanted && backendState === 'on' &&
      this._nativeAcknowledgement && !this._failure && !this._startupExpired;
    /** @type {ActivityState} */
    let state;
    if (this._mode === 'off') state = 'off';
    else if (this._mode === 'auto' && this._auto.status !== 'verified') state = this._auto.status;
    else if (!desired) state = 'waiting';
    else if (this._failure || this._startupExpired || backendState === 'error') state = 'failed';
    else if (confirmed) state = 'on';
    else if (this._powerWanted && backendState === 'on') state = 'unverified';
    else if (this._startupTimer || backendState === 'starting') state = 'starting';
    else state = 'failed';
    const unverified = state === 'unverified'
      ? 'The helper is running, but its native power assertion is unverified. Process survival is not confirmation.'
      : '';
    return {
      mode: this._mode, state, desired, confirmed, ownerCount,
      generation: this._generation, instanceId: this._instanceId,
      durationMs: this._durationMs, expiresAt: this._nearestDeadline(),
      error: state === 'failed' ? this._failure || this._backend.error || 'Keep Awake protection is not active.' : '',
      notice: [this._notice, unverified].filter(Boolean).join(' '),
      auto: { ...this._auto },
      backendState, pids: [...this._backend.pids], helpers: [...this._backend.activeHelpers]
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._settleManual(false);
    this._nextGeneration();
    this._mode = 'off';
    this._durationMs = 0;
    this._manualExpiresAt = 0;
    this._notice = '';
    this._failure = '';
    this._startupExpired = false;
    this._clearExpiry();
    this._clearStartup();
    this._powerWanted = false;
    this._powerVersion++;
    this._backend.removeListener('change', this._onBackendChange);
    try {
      if (this._backend.dispose) this._backend.dispose();
      else this._backend.release();
    } catch {
      this._writeLog('warn', 'backend-cleanup-failed');
    }
    this._publish();
    this.removeAllListeners();
  }

  _acceptsAuto() {
    return !this._disposed && this._mode === 'auto' && this._auto.status === 'verified';
  }

  _ownerCount() {
    return this._disposed ? 0 : this._mode === 'manual' ? 1 : this._acceptsAuto() ? this._owners.size : 0;
  }

  _nextGeneration() {
    this._generation++;
    this._owners.clear();
    this._identities.clear();
    this._leaseKeys = new WeakMap();
    this._warnings.clear();
  }

  /** @param {string} notice */
  _turnOff(notice) {
    this._settleManual(false);
    this._nextGeneration();
    this._mode = 'off';
    this._durationMs = 0;
    this._manualExpiresAt = 0;
    this._notice = notice;
    this._clearExpiry();
    this._reconcile();
    this._writeLog('info', 'off-selected');
  }

  _reconcile() {
    const desired = this._ownerCount() > 0;
    if (desired && !this._powerWanted) {
      const version = ++this._powerVersion;
      this._powerWanted = true;
      this._failure = '';
      this._startupExpired = false;
      this._armStartup();
      try {
        this._backend.resetFailures?.();
        if (!this._disposed && this._powerWanted && this._powerVersion === version) {
          this._backend.acquire({ display: this._keepDisplayOn });
        }
      } catch {
        if (!this._disposed && this._powerWanted && this._powerVersion === version) {
          this._fail('Keep Awake could not start its native helper.', 'backend-acquire-failed');
        }
      }
      if (!this._disposed && this._powerWanted && this._powerVersion === version) this._observeBackend();
    } else if (!desired && this._powerWanted) {
      this._powerWanted = false;
      this._powerVersion++;
      this._failure = '';
      this._startupExpired = false;
      this._clearStartup();
      this._settleManual(false);
      try { this._backend.release(); } catch { this._writeLog('warn', 'backend-release-failed'); }
    } else if (desired) {
      this._observeBackend();
    } else {
      this._failure = '';
      this._startupExpired = false;
      this._clearStartup();
    }
    this._publish();
  }

  _observeBackend() {
    const state = this._backend.state;
    const previous = this._observedBackendState;
    this._observedBackendState = state;
    if (this._powerWanted && this._ownerCount() > 0) {
      if (state === 'on') {
        this._failure = '';
        this._startupExpired = false;
        this._clearStartup();
        this._settleManual(this._nativeAcknowledgement);
      } else if (state === 'error') {
        this._fail(this._backend.error || 'Keep Awake could not start its native helper.', 'backend-error');
      } else if (state === 'off') {
        this._fail(this._failure || 'Keep Awake protection was lost. Your computer can sleep.', 'backend-off');
      } else {
        if (previous !== 'starting') {
          this._failure = '';
          this._startupExpired = false;
          this._armStartup();
        }
        if (this._startupExpired || this._failure) this._settleManual(false);
      }
    }
    this._publish();
  }

  /** @param {string} error @param {string} category */
  _fail(error, category) {
    this._failure = error;
    this._clearStartup();
    this._settleManual(false);
    if (!this._warnings.has(category)) {
      this._warnings.add(category);
      this._writeLog('warn', category);
    }
  }

  /** @param {boolean} confirmed */
  _settleManual(confirmed) {
    const wait = this._manualWait;
    this._manualWait = undefined;
    wait?.resolve(confirmed);
  }

  _armStartup() {
    if (this._startupTimer || this._disposed || !this._powerWanted) return;
    /** @type {ScheduledTimer} */
    const timer = { at: this._now() + this._startupTimeoutMs };
    this._startupTimer = timer;
    timer.handle = this._setTimer(() => {
      if (this._startupTimer !== timer || this._disposed || !this._powerWanted || !this._ownerCount()) return;
      this._startupTimer = undefined;
      this._startupExpired = true;
      this._fail(`Keep Awake did not confirm protection within ${this._startupTimeoutMs} ms. Use Off to stop or retry.`, 'startup-deadline');
      this._publish();
    }, this._startupTimeoutMs);
    if (this._startupTimer !== timer) this._clearTimer(timer.handle);
  }

  _clearStartup() {
    const timer = this._startupTimer;
    this._startupTimer = undefined;
    if (timer?.handle !== undefined) this._clearTimer(timer.handle);
  }

  _nearestDeadline() {
    if (this._mode === 'manual') return this._manualExpiresAt;
    let nearest = 0;
    for (const lease of this._owners.values()) {
      if (!nearest || lease.expiresAt < nearest) nearest = lease.expiresAt;
    }
    return nearest;
  }

  _scheduleExpiry() {
    const at = this._nearestDeadline();
    if (this._expiryTimer?.at === at) return;
    this._clearExpiry();
    if (!at || this._disposed) return;
    /** @type {ScheduledTimer} */
    const timer = { at };
    this._expiryTimer = timer;
    timer.handle = this._setTimer(() => {
      if (this._expiryTimer !== timer || this._disposed) return;
      this._expiryTimer = undefined;
      this._expire();
    }, Math.max(0, at - this._now()));
    if (this._expiryTimer !== timer) this._clearTimer(timer.handle);
  }

  _clearExpiry() {
    const timer = this._expiryTimer;
    this._expiryTimer = undefined;
    if (timer?.handle !== undefined) this._clearTimer(timer.handle);
  }

  _expireIfDue() {
    const at = this._nearestDeadline();
    if (at && at <= this._now()) this._expire();
  }

  _expire() {
    if (this._disposed) return;
    const now = this._now();
    if (this._mode === 'manual' && this._manualExpiresAt && this._manualExpiresAt <= now) {
      this._turnOff('The timed Keep awake session expired.');
      return;
    }
    let expired = 0;
    if (this._acceptsAuto()) {
      for (const [key, lease] of this._owners) {
        if (lease.expiresAt <= now) {
          this._owners.delete(key);
          expired++;
        }
      }
      if (expired) {
        this._notice = 'The 24-hour activity safeguard expired; work may still be running. Use Keep awake.';
        this._writeLog('warn', `safeguard-expired count=${expired}`);
      }
    }
    this._scheduleExpiry();
    this._reconcile();
  }

  /** @param {string} category @param {string} [notice] @returns {undefined} */
  _reject(category, notice = '') {
    if (!this._warnings.has(category)) {
      this._warnings.add(category);
      this._writeLog('warn', category);
    }
    if (notice && this._notice !== notice) {
      this._notice = notice;
      this._publish();
    }
    return undefined;
  }

  /** @param {LogLevel} level @param {string} category */
  _writeLog(level, category) {
    try { this._log(level, `[coordinator] ${category}; owners=${this._ownerCount()}.`); } catch { /* diagnostics cannot affect ownership */ }
  }

  _publish() {
    const state = this.getState();
    const snapshot = JSON.stringify(state);
    if (snapshot === this._lastSnapshot) return;
    this._lastSnapshot = snapshot;
    this.emit('change', state);
  }
}

module.exports = { ActivityCoordinator };

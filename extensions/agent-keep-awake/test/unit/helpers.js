// @ts-check
'use strict';

const { EventEmitter } = require('events');

/** Deterministic replacement for setTimeout/clearTimeout/Date.now. */
function createClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  const clock = {
    now: () => now,
    /** @type {any} */
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      clock.setTimerCalls++;
      return id;
    },
    /** @type {any} */
    clearTimer: (/** @type {number} */ id) => { timers.delete(id); },
    setTimerCalls: 0,
    pending: () => timers.size,
    /** Advances time, firing due timers in order (including ones scheduled while advancing). */
    advance(/** @type {number} */ ms) {
      const target = now + ms;
      for (;;) {
        let dueId;
        let due;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.at)) {
            dueId = id;
            due = t;
          }
        }
        if (!due || dueId === undefined) {
          break;
        }
        timers.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
    }
  };
  return clock;
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
  }
  end() { this.ended = true; }
}

let fakePid = 4000;

class FakeChild extends EventEmitter {
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {any} options
   */
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.pid = ++fakePid;
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killed = false;
  }
  kill() {
    this.killed = true;
    return true;
  }
  // Test helpers -----------------------------------------------------------
  spawned() { this.emit('spawn'); return this; }
  ready() { this.stdout.emit('data', Buffer.from('READY\r\n')); return this; }
  /** @param {string} text */
  writeStderr(text) { this.stderr.emit('data', Buffer.from(text)); return this; }
  /** @param {number | null} code @param {string | null} [signal] */
  exit(code, signal = null) { this.emit('exit', code, signal); return this; }
}

/** Returns a spawn() replacement that records every FakeChild it creates. */
function createSpawn() {
  /** @type {FakeChild[]} */
  const children = [];
  /** @type {any} */
  const spawn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    const child = new FakeChild(command, args, options);
    children.push(child);
    return child;
  };
  return { spawn, children, last: () => children[children.length - 1] };
}

module.exports = { createClock, createSpawn, FakeChild };

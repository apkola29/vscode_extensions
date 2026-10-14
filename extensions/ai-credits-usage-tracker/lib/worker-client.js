'use strict';
const { Worker } = require('node:worker_threads');

class UsageWorkerClient {
  constructor(workerPath, { timeoutMs = 120000, idleMs = 30000, maxPending = 4, createWorker, onError = () => {} } = {}) {
    this.workerPath = workerPath;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.maxPending = maxPending;
    this.createWorker = createWorker || ((p) => new Worker(p, {
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
    }));
    this.onError = onError;
    this.pending = new Map();
    this.nextId = 0;
    this.worker = undefined;
    this.idleTimer = undefined;
    this.stopping = Promise.resolve();
    this.cleanupFailed = false;
    this.disposed = false;
  }

  start() {
    const worker = this.createWorker(this.workerPath);
    this.worker = worker;
    worker.on('message', (message) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (typeof message.error === 'string') request.reject(new Error(message.error));
      else if (message.result && typeof message.result === 'object') request.resolve(message.result);
      else request.reject(new Error('Invalid response from usage worker'));
      if (this.pending.size === 0) this.scheduleIdle();
    });
    worker.on('error', (error) => {
      if (this.worker === worker) this.stop(error);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.stop(new Error(`Usage worker stopped unexpectedly (${code})`));
    });
    return worker;
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(new Error('Idle usage worker closed')), this.idleMs);
    this.idleTimer.unref?.();
  }

  async run(opts) {
    await this.stopping;
    if (this.cleanupFailed) throw new Error('Usage worker cleanup failed; reload the window before retrying');
    if (this.disposed) throw new Error('Usage tracker has been disposed');
    const key = JSON.stringify(opts);
    for (const request of this.pending.values()) if (request.key === key) return request.promise;
    if (this.pending.size >= this.maxPending) throw new Error('Too many usage scans are pending; wait for the current scan');
    clearTimeout(this.idleTimer);
    const worker = this.worker || this.start();
    const id = ++this.nextId;
    let resolve;
    let reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const timer = setTimeout(() => this.stop(new Error('Timed out reading provider usage; the worker was stopped')), this.timeoutMs);
    this.pending.set(id, { key, promise, resolve, reject, timer });
    try { worker.postMessage({ id, opts }); } catch (error) { this.stop(error); }
    return promise;
  }

  stop(error = new Error('Usage scan was cancelled')) {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (worker) {
      this.stopping = this.stopping.then(() => worker.terminate()).catch((e) => {
        this.cleanupFailed = true;
        this.onError(e);
      });
    }
    return this.stopping;
  }

  dispose() {
    this.disposed = true;
    return this.stop(new Error('Usage tracker deactivated'));
  }
}

module.exports = { UsageWorkerClient };

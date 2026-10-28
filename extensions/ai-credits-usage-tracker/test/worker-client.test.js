'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageWorkerClient } = require('../lib/worker-client');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TestWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.terminations = 0;
  }
  postMessage(message) { this.messages.push(message); }
  async terminate() { this.terminations += 1; this.emit('exit', 0); return 0; }
  reply(result) { this.emit('message', { id: this.messages[this.messages.length - 1].id, result }); }
}

function client(opts = {}) {
  const workers = [];
  const service = new UsageWorkerClient('internal-worker-path', {
    timeoutMs: 1000,
    idleMs: 1000,
    createWorker: () => { const worker = new TestWorker(); workers.push(worker); return worker; },
    ...opts,
  });
  return { service, workers };
}

test('repeated identical scans share one worker request', async () => {
  const { service, workers } = client();
  const a = service.run({ provider: 'githubCopilot' });
  const b = service.run({ provider: 'githubCopilot' });
  await tick();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 1);
  workers[0].reply({ models: [] });
  assert.deepEqual(await a, await b);
  assert.equal(service.pending.size, 0);
  await service.dispose();
  assert.equal(workers[0].terminations, 1);
});

test('timeouts terminate the stalled worker and a retry gets a new worker', async () => {
  const { service, workers } = client({ timeoutMs: 20 });
  await assert.rejects(service.run({ provider: 'githubCopilot' }), /Timed out/);
  await service.stopping;
  assert.equal(workers[0].terminations, 1);
  assert.equal(service.pending.size, 0);
  const next = service.run({ provider: 'githubCopilot' });
  await tick();
  assert.equal(workers.length, 2);
  workers[1].reply({ recovered: true });
  assert.deepEqual(await next, { recovered: true });
  await service.dispose();
});

test('a timeout or crash blames the request that was running; requests queued behind it are cancelled instead', async () => {
  for (const failure of ['timeout', 'crash']) {
    const { service, workers } = client({ timeoutMs: failure === 'timeout' ? 25 : 1000 });
    const running = service.run({ sortBy: 'credits' }).catch((error) => error);
    const queued = service.run({ sortBy: 'tokens' }).catch((error) => error);
    await tick();
    if (failure === 'crash') workers[0].emit('error', new Error('fixture worker failed'));
    const [first, second] = await Promise.all([running, queued]);
    assert.match(first.message, failure === 'timeout' ? /Timed out/ : /fixture worker failed/);
    assert.equal(second.message, 'Usage scan was cancelled', `${failure}: the queued request is not blamed`);
    await service.stopping;
    const next = service.run({ sortBy: 'tokens' });
    await tick();
    assert.equal(workers.length, 2, `${failure}: the retry gets a fresh worker`);
    workers[1].reply({ ok: true });
    assert.deepEqual(await next, { ok: true });
    await service.dispose();
  }
});

test('an explicit stop gives every pending request the reason it was given', async () => {
  const { service } = client();
  const a = service.run({ sortBy: 'credits' }).catch((error) => error);
  const b = service.run({ sortBy: 'tokens' }).catch((error) => error);
  await tick();
  await service.stop(new Error('GitHub sign-in changed; the previous usage scan was cancelled'));
  assert.deepEqual((await Promise.all([a, b])).map((error) => error.message), [
    'GitHub sign-in changed; the previous usage scan was cancelled',
    'GitHub sign-in changed; the previous usage scan was cancelled',
  ]);
  await service.dispose();
});

test('a request that cannot be serialized fails alone; the running scan and its worker are unaffected', async () => {
  const workers = [];
  class CloneWorker extends TestWorker {
    postMessage(message) {
      if (message.opts.bad) throw Object.assign(new Error('value could not be cloned'), { name: 'DataCloneError' });
      if (message.opts.broken) throw new Error('worker channel closed');
      super.postMessage(message);
    }
  }
  const service = new UsageWorkerClient('internal-worker-path', {
    timeoutMs: 1000,
    idleMs: 1000,
    createWorker: () => { const worker = new CloneWorker(); workers.push(worker); return worker; },
  });
  const healthy = service.run({ sortBy: 'credits' });
  const bad = service.run({ bad: true });
  await assert.rejects(bad, /could not be cloned/);
  assert.equal(service.pending.size, 1, 'only the request that could not be sent was removed');
  assert.equal(workers.length, 1, 'the worker was not replaced');
  assert.equal(workers[0].terminations, 0);
  workers[0].reply({ credits: 3 });
  assert.deepEqual(await healthy, { credits: 3 });
  await assert.rejects(service.run({ bad: true }), /could not be cloned/);
  assert.equal(service.pending.size, 0, 'a failed send leaves nothing pending');

  // Any other send failure means the channel itself is suspect, so everything pending fails and the worker is replaced.
  const running = service.run({ sortBy: 'tokens' }).catch((error) => error);
  await tick();
  const broken = service.run({ broken: true }).catch((error) => error);
  const [first, second] = await Promise.all([running, broken]);
  assert.match(first.message, /channel closed|cancelled|deactivated/);
  assert.match(second.message, /channel closed/);
  await service.stopping;
  assert.equal(service.pending.size, 0);
  await service.dispose();
});

test('a request holding a value that cannot be cloned fails alone on the real worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-real-worker-clone-'));
  const service = new UsageWorkerClient(path.join(__dirname, '..', 'lib', 'worker.js'), { idleMs: 1000, timeoutMs: 10000 });
  try {
    const options = { provider: 'githubCopilot', copilotHome: path.join(root, 'empty'), vscodeUserDirs: [] };
    const healthy = service.run(options);
    const bad = service.run({ ...options, copilotHome: path.join(root, 'other'), unclonable: () => {} });
    await assert.rejects(bad, (error) => error.name === 'DataCloneError');
    assert.deepEqual((await healthy).models, [], 'the scan already running still completes');
    assert.equal(service.pending.size, 0);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the request queue is bounded and deactivation cancels pending work', async () => {
  const { service, workers } = client({ maxPending: 2 });
  const a = service.run({ sortBy: 'credits' });
  const b = service.run({ sortBy: 'tokens' });
  const rejectedA = assert.rejects(a, /deactivated/);
  const rejectedB = assert.rejects(b, /deactivated/);
  await tick();
  await assert.rejects(service.run({ sortBy: 'third' }), /Too many/);
  await service.dispose();
  await Promise.all([rejectedA, rejectedB]);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
  assert.equal(service.pending.size, 0);
  await assert.rejects(service.run({}), /disposed/);
});

test('idle workers are stopped rather than retaining their cache indefinitely', async () => {
  const { service, workers } = client({ idleMs: 15 });
  const request = service.run({});
  await tick();
  workers[0].reply({ models: [] });
  await request;
  await sleep(60);
  await service.stopping;
  assert.equal(workers[0].terminations, 1);
  assert.equal(service.worker, undefined);
  await service.dispose();
});

test('worker errors and old exit events cannot cancel a replacement worker', async () => {
  const { service, workers } = client();
  const failed = service.run({});
  const rejection = assert.rejects(failed, /fixture worker failed/);
  await tick();
  workers[0].emit('error', new Error('fixture worker failed'));
  await rejection;
  await service.stopping;
  const next = service.run({});
  await tick();
  workers[0].emit('exit', 1);
  workers[1].reply({ models: ['ok'] });
  assert.deepEqual(await next, { models: ['ok'] });
  await service.dispose();
});

test('a worker cleanup failure blocks further scans and is explicitly reported', async () => {
  const errors = [];
  const { service, workers } = client({ onError: (e) => errors.push(e.message) });
  const request = service.run({});
  await tick();
  workers[0].reply({ models: [] });
  await request;
  workers[0].terminate = async () => { throw new Error('fixture cleanup failure'); };
  await service.stop();
  assert.deepEqual(errors, ['fixture cleanup failure']);
  await assert.rejects(service.run({}), /cleanup failed/);
  await service.dispose();
});

test('the real worker has bounded memory and releases its thread after idle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-real-worker-'));
  const service = new UsageWorkerClient(path.join(__dirname, '..', 'lib', 'worker.js'), {
    idleMs: 25, timeoutMs: 5000,
  });
  try {
    const result = await service.run({
      provider: 'githubCopilot', copilotHome: path.join(root, 'empty'), vscodeUserDirs: [],
    });
    assert.deepEqual(result.models, []);
    const worker = service.worker;
    assert.ok(worker.threadId > 0);
    assert.equal(worker.resourceLimits.maxOldGenerationSizeMb, 512);
    assert.equal(worker.resourceLimits.maxYoungGenerationSizeMb, 32);
    await sleep(150);
    await service.stopping;
    assert.equal(worker.threadId, -1);
    assert.equal(service.worker, undefined);
    assert.equal(service.pending.size, 0);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

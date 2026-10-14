'use strict';
// Runs the aggregation off the extension host thread. Requests are serialized so the shared file cache
// in lib/aggregate.js is never pruned by one run while another is still using it.
const { parentPort } = require('worker_threads');
const { aggregateUsage } = require('./aggregate');

let queue = Promise.resolve();
parentPort.on('message', ({ id, opts }) => {
  queue = queue.then(async () => {
    try {
      parentPort.postMessage({ id, result: await aggregateUsage(opts) });
    } catch (e) {
      parentPort.postMessage({ id, error: (e && e.stack) || String(e) });
    }
  });
});

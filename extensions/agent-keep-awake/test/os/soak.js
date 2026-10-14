// @ts-check
'use strict';

/**
 * Long-running footprint measurement of the keep-awake helper.
 * Usage: node test/os/soak.js [minutes=10]
 */

const { KeepAwake } = require('../../src/keepAwake');
const { probe, footprint } = require('./probe');

const minutes = Number(process.argv[2] || 10);
/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const ka = new KeepAwake();
  ka.acquire();
  const t0 = Date.now();
  while (ka.state !== 'on' && ka.state !== 'error' && Date.now() - t0 < 120_000) {
    await sleep(100);
  }
  if (ka.state !== 'on') {
    throw new Error(`helper did not start: ${ka.error}`);
  }
  const pid = ka.pids[0];
  console.log(`helper ${ka.activeHelpers.join('+')} pid ${pid} ready in ${Date.now() - t0}ms; OS: ${probe(ka.pids).raw}`);
  await sleep(60_000);
  const start = footprint(pid);
  const startedAt = Date.now();
  const end = startedAt + (minutes - 1) * 60_000;
  let peak = start.rssMB;
  while (Date.now() < end) {
    await sleep(60_000);
    const f = footprint(pid);
    peak = Math.max(peak, f.rssMB);
    console.log(`t+${Math.round((Date.now() - t0) / 60_000)}min  rss ${f.rssMB.toFixed(1)} MB  cpu ${f.cpu.toFixed(3)}s`);
  }
  const last = footprint(pid);
  const seconds = (Date.now() - startedAt) / 1000;
  const cpu = last.cpu - start.cpu;
  console.log(`\nSteady state over ${(seconds / 60).toFixed(1)} min (after the first minute):`);
  console.log(`  CPU used: ${cpu.toFixed(3)} s  => ${((cpu / seconds) * 100).toFixed(4)}% of one core`);
  console.log(`  Resident memory: ${last.rssMB.toFixed(1)} MB (peak ${peak.toFixed(1)} MB)`);
  console.log(`  Still holding: ${probe(ka.pids).raw}`);
  ka.dispose();
  setTimeout(() => process.exit(0), 300);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

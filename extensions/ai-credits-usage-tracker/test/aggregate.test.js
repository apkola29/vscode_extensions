'use strict';
// Fixture tests for the edge cases found in review. Run: node --test test/aggregate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { aggregateUsage, billingCycle, replayChatSession, normalizeClaudeModel, normalizeModel, claudePrice } = require('../lib/aggregate');

const NOW = new Date('2026-10-15T00:00:00Z');
const nano = (credits) => credits * 1e9;
const ev = (type, timestamp, data) => JSON.stringify({ type, timestamp, id: Math.random().toString(36).slice(2), data });
const metrics = (calls, inputTokens, outputTokens, credits) => ({ requests: { count: calls, cost: calls }, usage: { inputTokens, outputTokens }, totalNanoAiu: nano(credits) });

// Fixture files get a fixed in-cycle mtime so the tests do not depend on the host clock (files older than the
// billing-cycle start are skipped by design).
function touch(file, when = NOW) {
  fs.utimesSync(file, when, when);
  return file;
}

function writeSession(home, id, lines) {
  const dir = path.join(home, 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  touch(file);
}

function writeChat(userDir, ws, name, content, mtime) {
  const dir = path.join(userDir, 'workspaceStorage', ws, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  // Test chat fixtures represent GitHub Copilot unless a test explicitly supplies another responder.
  const tagged = content.split(/\r?\n/).map((line) => {
    if (!line) return line;
    try {
      const o = JSON.parse(line);
      const session = o.kind === 0 ? o.v : o;
      if (session && typeof session === 'object' && session.responderUsername === undefined) session.responderUsername = 'GitHub Copilot';
      return JSON.stringify(o);
    } catch { return line; }
  }).join('\n');
  fs.writeFileSync(f, tagged);
  touch(f, mtime || NOW);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-'));
  const home = path.join(root, '.copilot');
  const userDir = path.join(root, 'Code', 'User');

  // A: run straddles the cycle start (call on Sep 30 and Oct 1, shutdown Oct 1) with a checkpoint before the start.
  writeSession(home, 'A', [
    ev('assistant.message', '2026-09-30T21:00:00.000Z', { model: 'claude-x' }),
    ev('session.usage_checkpoint', '2026-09-30T22:00:00.000Z', { totalNanoAiu: nano(100) }),
    ev('assistant.message', '2026-10-01T01:00:00.000Z', { model: 'claude-x' }),
    ev('session.shutdown', '2026-10-01T02:00:00.000Z', { totalNanoAiu: nano(150), modelMetrics: { 'claude-x': metrics(2, 2000, 200, 150) } }),
  ]);
  // B: clean resume with cumulative modelMetrics plus a malformed (null) model entry.
  writeSession(home, 'B', [
    ev('assistant.message', '2026-10-02T01:00:00.000Z', { model: 'gpt-y' }),
    ev('session.shutdown', '2026-10-02T02:00:00.000Z', { totalNanoAiu: nano(10), modelMetrics: { 'gpt-y': metrics(1, 100, 10, 10) } }),
    ev('assistant.message', '2026-10-03T01:00:00.000Z', { model: 'gpt-y' }),
    ev('session.shutdown', '2026-10-03T02:00:00.000Z', { totalNanoAiu: nano(25), modelMetrics: { 'gpt-y': metrics(2, 300, 30, 25), bad: null } }),
  ]);
  // C: live session — one call covered by a checkpoint, one after it (pending).
  writeSession(home, 'C', [
    ev('assistant.message', '2026-10-10T01:00:00.000Z', { model: 'claude-x' }),
    ev('session.usage_checkpoint', '2026-10-10T02:00:00.000Z', { totalNanoAiu: nano(7) }),
    ev('assistant.message', '2026-10-10T03:00:00.000Z', { model: 'claude-x' }),
  ]);

  // VS Code: s1 copied into two workspace stores plus a stale legacy .json; kind-2 truncation; non-array requests; agent-host turn.
  const req = { timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'copilot/claude-x', promptTokens: 1000, completionTokens: 100, copilotCredits: 5 };
  const s1 = [
    JSON.stringify({ kind: 0, v: { sessionId: 's1', requests: [] } }),
    JSON.stringify({ kind: 2, k: ['requests'], v: [{ ...req, copilotCredits: 999 }] }),
    JSON.stringify({ kind: 2, k: ['requests'], i: 0, v: [req] }),
  ].join('\n');
  writeChat(userDir, 'w1', 's1.jsonl', s1, new Date('2026-10-06T00:00:00Z'));
  writeChat(userDir, 'w2', 's1.jsonl', s1, new Date('2026-10-07T00:00:00Z'));
  writeChat(userDir, 'w1', 's1.json', JSON.stringify({ sessionId: 's1', requests: [req] }), new Date('2026-10-05T12:00:00Z'));
  writeChat(userDir, 'w1', 's2.json', JSON.stringify({ sessionId: 's2', requests: { not: 'an array' } }));
  writeChat(userDir, 'w1', 's3.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 's3', requests: [{ ...req, copilotCredits: 1, modelTotals: [] }] } }));
  return { root, home, userDir };
}

test('billing cycle boundaries (UTC, configurable reset day)', () => {
  assert.deepEqual(billingCycle(NOW, 1), { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') });
  assert.deepEqual(billingCycle(NOW, 20), { start: new Date('2026-09-20T00:00:00Z'), end: new Date('2026-10-20T00:00:00Z') });
});

test('cycle-boundary proration only discounts the first in-window checkpoint step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-boundary-later-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'I', [
      ev('session.usage_checkpoint', '2026-09-30T20:00:00.000Z', { totalNanoAiu: nano(50) }),
      ev('assistant.message', '2026-09-30T21:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-09-30T22:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T01:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T02:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T03:00:00.000Z', { model: 'claude-x' }),
      ev('session.usage_checkpoint', '2026-10-01T04:00:00.000Z', { totalNanoAiu: nano(100) }),
      ev('assistant.message', '2026-10-02T01:00:00.000Z', { model: 'claude-x' }),
      ev('session.usage_checkpoint', '2026-10-02T02:00:00.000Z', { totalNanoAiu: nano(150) }),
    ]);
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [], includeClaudeCode: false });
    const cx = r.models.find((m) => m.model === 'claude-x');
    assert.ok(cx);
    assert.ok(Math.abs(cx.estCredits - 80) < 1e-6, `first 50cr step is prorated 3/5 (=30), later 50cr stays whole: expected 80, got ${cx.estCredits}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the newest copy wins when the same VS Code session exists in stable and Insiders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-cross-profile-'));
  try {
    const stable = path.join(root, 'Code', 'User');
    const insiders = path.join(root, 'Code - Insiders', 'User');
    const one = { timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'm', promptTokens: 10, completionTokens: 1, copilotCredits: 5 };
    const two = { timestamp: Date.parse('2026-10-06T00:00:00Z'), modelId: 'm', promptTokens: 20, completionTokens: 2, copilotCredits: 7 };
    writeChat(stable, 'w', 'same.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'same', requests: [one] } }), new Date('2026-10-05T00:00:00Z'));
    writeChat(insiders, 'w', 'same.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'same', requests: [one, two] } }), new Date('2026-10-07T00:00:00Z'));
    const r = await aggregateUsage({ now: NOW, copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [stable, insiders], includeClaudeCode: false });
    const m = r.models.find((x) => x.model === 'm');
    assert.ok(m);
    assert.equal(m.credits, 12);
    assert.equal(m.calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay honours kind-2 truncation index', () => {
  const s = replayChatSession([
    JSON.stringify({ kind: 0, v: { requests: [1, 2, 3] } }),
    JSON.stringify({ kind: 2, k: ['requests'], i: 1, v: [9] }),
  ].join('\n'));
  assert.deepEqual(s.requests, [1, 9]);
});

test('edge cases: straddling run, cumulative resumes, malformed data, duplicates, agent-host turns, live sessions', async () => {
  const { root, home, userDir } = fixture();
  try {
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [userDir], includeClaudeCode: false });
    const byModel = Object.fromEntries(r.models.map((m) => [m.model, m]));
    assert.deepEqual(r.diagnostics.errors, []);
    assert.equal(byModel.bad, undefined, 'null modelMetrics entry must not create a row');

    const gpt = byModel['gpt-y'];
    assert.equal(gpt.calls, 2);
    assert.equal(gpt.inputTokens, 300);
    assert.equal(gpt.outputTokens, 30);
    assert.ok(Math.abs(gpt.credits - 25) < 1e-9, 'cumulative resumes counted once');
    assert.ok(gpt.estCredits < 1e-9);

    const cx = byModel['claude-x'];
    assert.equal(cx.calls, 2, 'the normal VS Code request and the unrelated agent-host request are exact; copied files are deduped');
    assert.ok(Math.abs(cx.credits - 6) < 1e-9);
    assert.ok(Math.abs(cx.estCredits - 57) < 1e-9, 'straddling run bounded by checkpoint (50) + live checkpoint (7)');
    assert.equal(cx.pendingCalls, 1);
    assert.equal(r.diagnostics.straddlingRuns, 1);
    assert.equal(r.diagnostics.vscodeDuplicateFiles, 2);
    assert.equal(r.diagnostics.vscodeAgentHostSkipped, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('indexed DB session is not double counted with its shutdown event', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-db-'));
  const home = path.join(root, '.copilot');
  try {
    fs.mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, 'session-store.db'));
    db.exec(`CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, initiator TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT)`);
    db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('D', 'claude-x', 'user', 10, 1, 0, 0, 0, nano(2), 1, '2026-10-04T00:00:00.000Z');
    db.close();
    writeSession(home, 'D', [
      ev('assistant.message', '2026-10-04T00:00:00.000Z', { model: 'claude-x' }),
      ev('session.shutdown', '2026-10-04T00:01:00.000Z', { totalNanoAiu: nano(2), modelMetrics: { 'claude-x': metrics(1, 10, 1, 2) } }),
    ]);
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [], includeClaudeCode: false });
    const cx = r.models.find((m) => m.model === 'claude-x');
    assert.equal(cx.calls, 1);
    assert.ok(Math.abs(cx.credits - 2) < 1e-9);
    assert.ok(cx.estCredits < 1e-9);
    assert.deepEqual(cx.sources, ['cli']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file cache reuses unchanged files and picks up appended events', async () => {
  const { root, home, userDir } = fixture();
  try {
    const opts = { now: NOW, copilotHome: home, vscodeUserDirs: [userDir], includeClaudeCode: false };
    const first = await aggregateUsage(opts);
    const again = await aggregateUsage(opts);
    assert.deepEqual(again.totals, first.totals);
    assert.ok(again.diagnostics.cachedFiles > 0);
    // Live session C reaches a new checkpoint: +5 credits, and its last call is no longer pending.
    fs.appendFileSync(path.join(home, 'session-state', 'C', 'events.jsonl'),
      ev('session.usage_checkpoint', '2026-10-10T04:00:00.000Z', { totalNanoAiu: nano(12) }) + '\n');
    const changed = await aggregateUsage(opts);
    assert.ok(Math.abs(changed.totals.totalCredits - first.totals.totalCredits - 5) < 1e-9);
    assert.equal(changed.totals.pendingCalls, first.totals.pendingCalls - 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude model ids normalize to the Copilot form and map to list prices', () => {
  assert.equal(normalizeClaudeModel('claude-opus-4-8-20260301'), 'claude-opus-4.8');
  assert.equal(normalizeClaudeModel('claude-opus-5-5'), 'claude-opus-5.5');
  assert.equal(normalizeClaudeModel('claude-3-5-haiku-20241022'), 'claude-haiku-3.5');
  assert.equal(normalizeClaudeModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4.5');
  assert.equal(normalizeClaudeModel('claude-opus-4-1@20250805'), 'claude-opus-4.1');
  assert.equal(normalizeClaudeModel('claude-opus-4-6[1m]'), 'claude-opus-4.6');
  assert.equal(normalizeClaudeModel('claude-sonnet-4-20250514'), 'claude-sonnet-4');
  const input = (m) => (claudePrice(m) || {}).input;
  assert.equal(input('claude-opus-5.5'), 4);
  assert.equal(input('claude-opus-5'), 5);
  assert.equal(input('claude-opus-4.8'), 5);
  assert.equal(input('claude-opus-4.1'), 15);
  assert.equal(input('claude-opus-4'), 15);
  assert.equal(input('claude-sonnet-5'), 2);
  assert.equal(input('claude-sonnet-5.5'), 2);
  assert.equal(input('claude-sonnet-4.5'), 3);
  assert.equal(input('claude-haiku-4.5'), 1);
  assert.equal(input('claude-haiku-3.5'), 0.8);
  assert.equal(claudePrice('gpt-5'), null);
  assert.equal(claudePrice('claude-sonnet-5.5').cacheRead, 0.1);
});

test('Claude Code transcripts: dedupe, pricing, filtering, and separate sections next to Copilot rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-claude-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'E', [
      ev('assistant.message', '2026-10-06T00:00:00.000Z', { model: 'claude-opus-4.8' }),
      ev('session.shutdown', '2026-10-06T00:01:00.000Z', { totalNanoAiu: nano(3), modelMetrics: { 'claude-opus-4.8': metrics(1, 50, 5, 3) } }),
    ]);
    const proj = path.join(root, 'claude', 'projects', 'c--work-proj');
    fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
    const asst = (id, req, model, usage, timestamp, extra = {}) => JSON.stringify({
      type: 'assistant', timestamp, sessionId: 'claude-s1', requestId: req, message: { id, model, role: 'assistant', usage }, ...extra,
    });
    const opusUsage = (out) => ({ input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } });
    const final = asst('m1', 'r1', 'claude-opus-4-8-20260301', opusUsage(10), '2026-10-03T00:00:02.000Z');
    fs.writeFileSync(path.join(proj, 'sess1.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: '2026-10-03T00:00:00.000Z', sessionId: 'claude-s1', message: { role: 'user', content: 'hi' } }),
      asst('m1', 'r1', 'claude-opus-4-8-20260301', opusUsage(4), '2026-10-03T00:00:01.000Z'),
      final,
      asst('m2', 'r2', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } }, '2026-10-04T00:00:00.000Z'),
      asst('m3', 'r3', 'claude-opus-4-1-20250805', { input_tokens: 10, output_tokens: 1 }, '2026-10-05T00:00:00.000Z', { costUSD: 0.5 }),
      asst('m4', 'r4', '<synthetic>', { input_tokens: 0, output_tokens: 0 }, '2026-10-05T00:00:00.000Z'),
      asst('m5', 'r5', 'claude-opus-4-8-20260301', { input_tokens: 999, output_tokens: 999 }, '2026-09-20T00:00:00.000Z'),
      asst('m6', 'r6', 'claude-opus-4-8-20260301', { input_tokens: 7, output_tokens: 7 }, '2026-10-06T00:00:00.000Z', { sessionId: 'E' }),
      asst('m7', 'r7', 'claude-opus-4-8-20260301', { input_tokens: 5, output_tokens: 5 }, '2026-10-06T00:00:00.000Z', { isApiErrorMessage: true }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(proj, 'sess2.jsonl'), final + '\n'); // resumed session copies earlier messages
    fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'agent-1.jsonl'),
      asst('m8', 'r8', 'claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 100 }, '2026-10-07T00:00:00.000Z') + '\n');

    const both = await aggregateUsage({ now: NOW, provider: 'both', copilotHome: home, vscodeUserDirs: [], claudeDirs: [path.join(root, 'claude')] });
    const r = both.claudeCode;
    const byModel = Object.fromEntries(r.models.map((m) => [m.model, m]));
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    assert.deepEqual(r.diagnostics.errors, []);
    assert.equal(r.diagnostics.claudeFiles, 3);
    assert.equal(r.diagnostics.claudeMessages, 4);
    assert.equal(r.diagnostics.claudeDuplicates, 2);
    assert.equal(r.diagnostics.claudeSkippedCopilotSessions, 1);
    assert.equal(byModel['<synthetic>'], undefined);

    const opus = byModel['claude-opus-4.8'];
    assert.equal(opus.calls, 1, 'one deduplicated Claude message; the Copilot call stays in the Copilot section');
    assert.equal(opus.inputTokens, 1300);
    assert.equal(opus.outputTokens, 10, 'keeps the complete streamed usage, not the partial line');
    assert.equal(opus.byTool['Copilot agent / CLI'], undefined);
    assert.ok(close(opus.byTool['Claude Code'], 0.25), '$5/$25, cache read $0.50, 5m write $6.25');
    assert.ok(close(byModel['claude-sonnet-5'].credits, 0.055), '1h cache writes at $4/M');
    assert.ok(close(byModel['claude-opus-4.1'].credits, 50), 'costUSD wins when present');
    assert.ok(close(byModel['claude-haiku-4.5'].credits, 0.15), 'subagent transcripts are included');
    assert.ok(close(r.totals.byTool['Claude Code'], 50.455));
    assert.equal(r.totals.byTool['Copilot agent / CLI'], undefined);

    const copilotOpus = both.githubCopilot.models.find((m) => m.model === 'claude-opus-4.8');
    assert.equal(copilotOpus.calls, 1);
    assert.equal(copilotOpus.inputTokens, 50);
    assert.equal(copilotOpus.byTool['Claude Code'], undefined);
    assert.ok(close(both.githubCopilot.totals.byTool['Copilot agent / CLI'], 3));
    assert.equal(both.githubCopilot.totals.byTool['Claude Code'], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Fixes from the gpt-6.1-sol / claude-sonnet-5.5 / gemini-3.8-flash review round ----

test('prototype-polluting mutation paths are rejected', () => {
  const before = Object.prototype.polluted;
  const lines = [
    JSON.stringify({ kind: 0, v: { requests: [{ a: 1 }] } }),
    JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: true }),
    JSON.stringify({ kind: 1, k: [['__proto__'], 'polluted3'], v: true }),
    JSON.stringify({ kind: 1, k: ['requests', 0, 'constructor', 'polluted2'], v: true }),
    JSON.stringify({ kind: 3, k: ['__proto__', 'toString'] }),
  ].join('\n');
  const s = replayChatSession(lines);
  assert.equal(Object.prototype.polluted, before, 'a kind-1 mutation to __proto__ must not reach Object.prototype');
  assert.equal(Object.prototype.polluted3, undefined, 'non-primitive keys coercing to __proto__ must also be rejected');
  assert.equal(s.requests[0].polluted2, undefined, 'a path through .constructor must not be followed either');
  assert.equal(typeof Object.prototype.toString, 'function', 'a kind-3 delete of __proto__.toString must be rejected too');
});

test('a broken workspace directory does not drop all other VS Code chat usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-baddir-'));
  try {
    const userDir = path.join(root, 'Code', 'User');
    const req = { timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'good-model', promptTokens: 10, completionTokens: 1, copilotCredits: 1 };
    writeChat(userDir, 'w1', 'good.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'good', requests: [req] } }));
    // w2's "chatSessions" is a FILE, not a directory: fs.readdirSync on it throws ENOTDIR.
    fs.mkdirSync(path.join(userDir, 'workspaceStorage', 'w2'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'w2', 'chatSessions'), 'not a directory');
    const r = await aggregateUsage({ now: NOW, copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [userDir], includeClaudeCode: false });
    assert.deepEqual(r.diagnostics.errors, []);
    assert.ok(r.models.some((m) => m.model === 'good-model'), 'the good workspace must still be read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forked VS Code chat sessions: true completion time wins the cycle, duplicates across files are deduped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-fork-'));
  try {
    const userDir = path.join(root, 'Code', 'User');
    // Completed in September (previous cycle); copied into a fork made in October with a rewritten `timestamp`
    // but the same `responseTimestamp` (verified against real forked sessions: fork keeps responseTimestamp).
    const sepMsg = { requestId: 'r1', timestamp: Date.parse('2026-10-03T00:00:00Z'), responseTimestamp: Date.parse('2026-09-15T00:00:05Z'), modelId: 'm', promptTokens: 100, completionTokens: 10, copilotCredits: 5 };
    // Completed in October; also present in both the original and the fork.
    const octMsg = { requestId: 'r2', timestamp: Date.parse('2026-10-03T00:00:01Z'), responseTimestamp: Date.parse('2026-10-02T00:00:05Z'), modelId: 'm', promptTokens: 200, completionTokens: 20, copilotCredits: 9 };
    writeChat(userDir, 'w1', 'orig.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'orig', requests: [sepMsg, octMsg] } }), new Date('2026-10-02T00:00:10Z'));
    const forkedSep = { ...sepMsg, requestId: 'r1-fork', timestamp: Date.parse('2026-10-05T00:00:00Z') };
    const forkedOct = { ...octMsg, requestId: 'r2-fork', timestamp: Date.parse('2026-10-05T00:00:01Z') };
    writeChat(userDir, 'w1', 'forked.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'forked', requests: [forkedSep, forkedOct] } }), new Date('2026-10-05T00:00:10Z'));

    const r = await aggregateUsage({ now: NOW, copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [userDir], includeClaudeCode: false });
    const m = r.models.find((x) => x.model === 'm');
    assert.equal(r.diagnostics.vscodeRequests, 1, 'only the October message counts; the September one must not leak into this cycle from either copy');
    assert.equal(r.diagnostics.vscodeDuplicateRequests, 1, 'the October message appears in both files and must be deduped');
    assert.ok(m);
    assert.equal(m.calls, 1);
    assert.equal(m.credits, 9);
    assert.equal(m.inputTokens, 200);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a model with its own zero-credit rate does not inherit the global average during gap reconciliation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-zerocredit-'));
  try {
    const home = path.join(root, '.copilot');
    // Establishes paid-model's and free-model's own per-call rates (10 credits/call and 0 credits/call).
    writeSession(home, 'P', [ev('session.shutdown', '2026-10-04T00:00:00.000Z', { totalNanoAiu: nano(30), modelMetrics: { 'paid-model': metrics(3, 300, 30, 30) } })]);
    writeSession(home, 'F', [ev('session.shutdown', '2026-10-04T00:00:00.000Z', { totalNanoAiu: nano(0), modelMetrics: { 'free-model': metrics(3, 300, 30, 0) } })]);
    // A live session with an unexplained credit gap whose only tagged calls are free-model (no exact data of its own).
    writeSession(home, 'G', [
      ev('assistant.message', '2026-10-06T01:00:00.000Z', { model: 'free-model' }),
      ev('session.usage_checkpoint', '2026-10-06T02:00:00.000Z', { totalNanoAiu: nano(8) }),
    ]);
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [], includeClaudeCode: false });
    const free = r.models.find((x) => x.model === 'free-model');
    const unattributed = r.models.find((x) => x.model === 'unattributed');
    assert.ok(free);
    assert.equal(free.estCredits, 0, 'free-model has its own 0-credit exact rate, so it must not absorb a share of the gap');
    assert.ok(unattributed);
    assert.ok(Math.abs(unattributed.estCredits - 8) < 1e-9, 'with no model it can be correctly attributed to, the gap must not silently inflate free-model');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale or missing pre-cycle checkpoint does not let pre-cycle usage leak into this cycle\'s estimate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-boundary-'));
  try {
    const home = path.join(root, '.copilot');
    // base checkpoint (50cr) is stale: 2 of the next 5 calls happen before Oct 1, with no later pre-cycle
    // checkpoint to account for them, so a naive (top-base) gap would wrongly bill them to October.
    writeSession(home, 'H', [
      ev('session.usage_checkpoint', '2026-09-20T00:00:00.000Z', { totalNanoAiu: nano(50) }),
      ev('assistant.message', '2026-09-25T00:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-09-28T00:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T09:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T12:00:00.000Z', { model: 'claude-x' }),
      ev('assistant.message', '2026-10-01T18:00:00.000Z', { model: 'claude-x' }),
      ev('session.usage_checkpoint', '2026-10-02T00:00:00.000Z', { totalNanoAiu: nano(100) }),
    ]);
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [], includeClaudeCode: false });
    const cx = r.models.find((m) => m.model === 'claude-x');
    assert.ok(cx);
    assert.ok(Math.abs(cx.estCredits - 30) < 1e-6, `gross gap is 50cr; 3 of the 5 bracketing calls are in-window, so only 30cr (60%) belongs to October, got ${cx.estCredits}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude "-latest" model aliases normalize and price the same as their dated/dotted form', () => {
  assert.equal(normalizeClaudeModel('claude-3-7-sonnet-latest'), 'claude-sonnet-3.7');
  assert.equal(normalizeClaudeModel('claude-3-5-haiku-latest'), 'claude-haiku-3.5');
  assert.equal(claudePrice('claude-sonnet-3.7').input, claudePrice(normalizeClaudeModel('claude-3-7-sonnet-latest')).input);
});

test('an empty Copilot DB does not suppress an available agent-host chat record', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-empty-db-'));
  try {
    const home = path.join(root, '.copilot');
    const userDir = path.join(root, 'Code', 'User');
    fs.mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, 'session-store.db'));
    db.exec(`CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, initiator TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT)`);
    db.close();
    const req = {
      timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'agent-model',
      promptTokens: 100, completionTokens: 10, copilotCredits: 7, modelTotals: [],
    };
    writeChat(userDir, 'w', 'agent.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'agent', requests: [req] } }));
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [userDir], includeClaudeCode: false });
    assert.equal(r.totals.totalCredits, 7);
    assert.equal(r.diagnostics.vscodeAgentHostSkipped, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a matching checkpoint-only live session suppresses its duplicate agent-host chat record', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-live-dedupe-'));
  try {
    const home = path.join(root, '.copilot');
    const userDir = path.join(root, 'Code', 'User');
    fs.mkdirSync(home, { recursive: true });
    const db = new DatabaseSync(path.join(home, 'session-store.db'));
    db.exec(`CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, initiator TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT)`);
    db.close();
    writeSession(home, 'live-session', [
      ev('assistant.message', '2026-10-05T00:00:00.000Z', { model: 'agent-model' }),
      ev('session.usage_checkpoint', '2026-10-05T00:01:00.000Z', { totalNanoAiu: nano(7) }),
    ]);
    const req = {
      timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'agent-model',
      promptTokens: 100, completionTokens: 10, copilotCredits: 7, modelTotals: [],
    };
    writeChat(userDir, 'w', 'live-session.jsonl',
      JSON.stringify({ kind: 0, v: { sessionId: 'live-session', requests: [req] } }));
    writeChat(userDir, 'w', 'forked-live-session.jsonl',
      JSON.stringify({ kind: 0, v: { sessionId: 'forked-live-session', requests: [{ ...req }] } }));
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [userDir], includeClaudeCode: false });
    assert.equal(r.totals.totalCredits, 7);
    assert.equal(r.diagnostics.vscodeAgentHostSkipped, 2);
    assert.equal(r.totals.byTool['VS Code chat'] || 0, 0);
    assert.equal(r.totals.byTool['Copilot agent / CLI'], 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed shutdown metric does not reset the cumulative baseline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-null-metric-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'J', [
      ev('assistant.message', '2026-10-02T00:00:00.000Z', { model: 'm' }),
      ev('session.shutdown', '2026-10-02T00:01:00.000Z', { totalNanoAiu: nano(10), modelMetrics: { m: metrics(1, 100, 10, 10) } }),
      ev('session.shutdown', '2026-10-03T00:01:00.000Z', { totalNanoAiu: nano(10), modelMetrics: { m: null } }),
      ev('assistant.message', '2026-10-04T00:00:00.000Z', { model: 'm' }),
      ev('session.shutdown', '2026-10-04T00:01:00.000Z', { totalNanoAiu: nano(30), modelMetrics: { m: metrics(2, 300, 30, 30) } }),
    ]);
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [], includeClaudeCode: false });
    const m = r.models.find((x) => x.model === 'm');
    assert.ok(m);
    assert.equal(m.credits, 30);
    assert.equal(m.calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed model tags and non-finite numeric fields cannot abort or poison totals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-malformed-'));
  try {
    const home = path.join(root, '.copilot');
    const userDir = path.join(root, 'Code', 'User');
    writeSession(home, 'K', [
      ev('assistant.message', '2026-10-03T00:00:00.000Z', { model: { toString: null } }),
      ev('session.usage_checkpoint', '2026-10-03T00:01:00.000Z', { totalNanoAiu: nano(4) }),
    ]);
    const req = {
      timestamp: Date.parse('2026-10-04T00:00:00Z'), modelId: 'm',
      promptTokens: '-5', completionTokens: 'bad', copilotCredits: '1e309',
    };
    writeChat(userDir, 'w', 'bad-numbers.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'bad', requests: [req] } }));
    writeChat(userDir, 'w', 'good-1.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'good-1', requests: [] } }));
    writeChat(userDir, 'w', 'good-2.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'good-2', requests: [] } }));
    const r = await aggregateUsage({ now: NOW, copilotHome: home, vscodeUserDirs: [userDir], includeClaudeCode: false });
    assert.ok(Number.isFinite(r.totals.totalCredits));
    assert.ok(Number.isFinite(r.totals.totalTokens));
    assert.equal(r.models.find((x) => x.model === 'm').credits, 0);
    assert.equal(r.diagnostics.vscodeInvalidNumbers, 3);
    assert.equal(r.diagnostics.notes.filter((n) => n.includes('invalid VS Code chat numeric')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider selection isolates GitHub Copilot from Claude Code data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-provider-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'copilot-session', [
      ev('assistant.message', '2026-10-05T00:00:00.000Z', { model: 'copilot-model' }),
      ev('session.shutdown', '2026-10-05T00:01:00.000Z', {
        totalNanoAiu: nano(4), modelMetrics: { 'copilot-model': metrics(1, 100, 10, 4) },
      }),
    ]);
    const project = path.join(root, 'claude', 'projects', 'p');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'claude.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: '2026-10-06T00:00:00.000Z', sessionId: 'claude-session', requestId: 'r',
      message: { id: 'm', model: 'claude-haiku-4-5-20251001', role: 'assistant', usage: { input_tokens: 1000, output_tokens: 100 } },
    }) + '\n');

    const github = await aggregateUsage({
      now: NOW, provider: 'githubCopilot', copilotHome: home, vscodeUserDirs: [], claudeDirs: [path.join(root, 'claude')],
    });

    assert.equal(github.provider, 'githubCopilot');
    assert.ok(github.models.some((m) => m.model === 'copilot-model'));
    assert.equal(github.models.some((m) => m.model === 'claude-haiku-4.5'), false);
    assert.equal(github.diagnostics.claudeFiles, 0);

    const claude = await aggregateUsage({
      now: NOW, provider: 'claudeCode', copilotHome: home, vscodeUserDirs: [], claudeDirs: [path.join(root, 'claude')],
    });
    assert.equal(claude.provider, 'claudeCode');
    assert.ok(claude.models.some((m) => m.model === 'claude-haiku-4.5'));
    assert.equal(claude.models.some((m) => m.model === 'copilot-model'), false);
    assert.equal(claude.diagnostics.cliRows, 0);
    assert.equal(claude.diagnostics.claudeMessages, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported providers are rejected before any usage store is read', async () => {
  await assert.rejects(aggregateUsage({ provider: 'unsupported-provider' }), /Unsupported chat provider/);
});

test('the parsed-file cache is bounded even with many usage sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-cache-bound-'));
  try {
    const userDir = path.join(root, 'Code', 'User');
    for (let i = 0; i < 270; i++) {
      writeChat(userDir, 'w', `session-${i}.jsonl`, JSON.stringify({
        kind: 0, v: { sessionId: `session-${i}`, requests: [] },
      }));
    }
    const result = await aggregateUsage({
      now: NOW, provider: 'githubCopilot', copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [userDir],
    });
    assert.ok(result.diagnostics.cachedFiles <= 256, 'the cache never exceeds its limit');
    assert.ok(result.diagnostics.cachedFiles >= 240, 'the cache is still used up to its limit');
    const again = await aggregateUsage({
      now: NOW, provider: 'githubCopilot', copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [userDir],
    });
    assert.ok(again.diagnostics.cacheHits >= 240, 'a full cache keeps its files instead of re-reading every file each scan');
    assert.ok(again.diagnostics.cachedFiles <= 256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider "both" returns separate Copilot and Claude Code sections without merging or double counting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-both-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'E', [
      ev('assistant.message', '2026-10-06T00:00:00.000Z', { model: 'claude-opus-4.8' }),
      ev('session.shutdown', '2026-10-06T00:01:00.000Z', { totalNanoAiu: nano(3), modelMetrics: { 'claude-opus-4.8': metrics(1, 50, 5, 3) } }),
    ]);
    const project = path.join(root, 'claude', 'projects', 'demo-project');
    fs.mkdirSync(project, { recursive: true });
    const message = (id, sessionId, timestamp) => JSON.stringify({
      type: 'assistant', timestamp, sessionId, requestId: `req-${id}`,
      message: {
        id, model: 'claude-opus-4-8-20260301', role: 'assistant',
        usage: {
          input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
    fs.writeFileSync(path.join(project, 'claude-session.jsonl'), [
      message('own', 'claude-session', '2026-10-07T00:00:00.000Z'),
      message('copilot-owned', 'E', '2026-10-06T00:00:30.000Z'),
      message('previous-cycle', 'claude-session', '2026-09-20T00:00:00.000Z'),
      'not json {',
    ].join('\n') + '\n');
    // Claude Code keeps superseded copies of a transcript; their messages must not be counted twice.
    fs.writeFileSync(path.join(project, 'claude-session.orphaned-1760000000-ab12.jsonl'),
      message('own', 'claude-session', '2026-10-07T00:00:00.000Z') + '\n');

    const r = await aggregateUsage({ now: NOW, provider: 'both', copilotHome: home, vscodeUserDirs: [], claudeDirs: [path.join(root, 'claude')] });
    assert.equal(r.provider, 'both');
    assert.equal(r.githubCopilot.provider, 'githubCopilot');
    assert.equal(r.claudeCode.provider, 'claudeCode');

    const copilot = r.githubCopilot.models.find((m) => m.model === 'claude-opus-4.8');
    assert.equal(copilot.calls, 1);
    assert.equal(copilot.credits, 3);
    assert.equal(copilot.byTool['Claude Code'], undefined, 'Copilot usage of a Claude model stays in the Copilot section');
    assert.equal(r.githubCopilot.diagnostics.claudeTranscripts, 0);
    assert.equal(r.githubCopilot.totals.byTool['Claude Code'], undefined);

    assert.deepEqual(r.claudeCode.models.map((m) => m.model), ['claude-opus-4.8']);
    const claude = r.claudeCode.models[0];
    assert.equal(claude.calls, 1, 'one message: duplicates, Copilot-owned and previous-cycle messages are excluded');
    assert.equal(claude.totalTokens, 1310);
    assert.ok(Math.abs(claude.totalCredits - 0.25) < 1e-9);
    assert.equal(claude.byTool['Copilot agent / CLI'], undefined);
    assert.equal(r.claudeCode.diagnostics.claudeTranscripts, 2);
    assert.equal(r.claudeCode.diagnostics.claudeDuplicates, 1);
    assert.equal(r.claudeCode.diagnostics.claudeSkippedCopilotSessions, 1);
    assert.equal(r.claudeCode.diagnostics.cliRows, 0);
    assert.deepEqual(r.claudeCode.diagnostics.errors, []);
    assert.equal(r.cycle.start, r.githubCopilot.cycle.start);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider "both" reports no Claude Code transcripts when none exist and leaves Copilot usage intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-no-claude-'));
  try {
    const home = path.join(root, '.copilot');
    writeSession(home, 'copilot-session', [
      ev('assistant.message', '2026-10-05T00:00:00.000Z', { model: 'copilot-model' }),
      ev('session.shutdown', '2026-10-05T00:01:00.000Z', {
        totalNanoAiu: nano(4), modelMetrics: { 'copilot-model': metrics(1, 100, 10, 4) },
      }),
    ]);
    fs.mkdirSync(path.join(root, 'empty-claude', 'projects'), { recursive: true });
    for (const claudeDirs of [[path.join(root, 'missing-claude')], [path.join(root, 'empty-claude')]]) {
      const r = await aggregateUsage({ now: NOW, provider: 'both', copilotHome: home, vscodeUserDirs: [], claudeDirs });
      assert.equal(r.claudeCode.diagnostics.claudeTranscripts, 0);
      assert.deepEqual(r.claudeCode.models, []);
      assert.deepEqual(r.claudeCode.diagnostics.errors, []);
      assert.deepEqual(r.githubCopilot.models.map((m) => m.model), ['copilot-model']);
      assert.equal(r.githubCopilot.totals.totalCredits, 4);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Claude Code transcript hardening (adversarial review round) ----
const claudeUsage = {
  input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
};
const claudeLine = ({ id = null, request = id === null ? null : `req-${id}`, session = 'claude-session', at = '2026-10-07T00:00:00.000Z',
  model = 'claude-opus-4-8-20260301', usage = claudeUsage, content, ...extra }) => JSON.stringify({
  type: 'assistant', timestamp: at, sessionId: session, ...(request === null ? {} : { requestId: request }),
  message: { ...(id === null ? {} : { id }), model, role: 'assistant', ...(content === undefined ? {} : { content }), usage }, ...extra,
});
function claudeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-claude-edge-'));
  const project = path.join(root, 'claude', 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    const file = path.join(project, name);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    touch(file);
  }
  return { root, claude: path.join(root, 'claude') };
}
const claudeOnly = (fx, extra = {}) => aggregateUsage({
  now: NOW, provider: 'claudeCode', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [], claudeDirs: [fx.claude], ...extra,
});

test('Claude transcripts: oversized records are skipped without losing neighbours; records spanning read chunks are parsed', async () => {
  const wide = 'é€😀'.repeat(60000); // multi-byte text that crosses several 64 KiB stream chunks
  const fx = claudeFixture({
    'big.jsonl': [
      claudeLine({ id: 'before' }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-07T00:00:00.000Z', message: { usage: {} }, blob: 'x'.repeat(9 * 1024 * 1024) }),
      claudeLine({ id: 'wide', content: wide }),
      claudeLine({ id: 'after' }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 3);
    assert.equal(r.diagnostics.claudeOversizedRecords, 1);
    assert.ok(r.diagnostics.notes.some((note) => /1 oversized Claude Code transcript record/.test(note)));
    assert.deepEqual(r.diagnostics.errors, []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: equal-size duplicates keep the later record and never drop a recorded cost', async () => {
  const same = { input_tokens: 100, output_tokens: 10 };
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: 'cost-last', usage: same }), claudeLine({ id: 'cost-last', usage: same, costUSD: 0.5 }),
      claudeLine({ id: 'cost-first', usage: same, costUSD: 0.5 }), claudeLine({ id: 'cost-first', usage: same }),
      // Same total tokens, reclassified as cheaper cache reads by the later record.
      claudeLine({ id: 'reclassified', usage: { input_tokens: 1000, output_tokens: 10 } }),
      claudeLine({ id: 'reclassified', usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 1000 } }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 3);
    assert.ok(Math.abs(r.totals.totalCredits - (50 + 50 + 0.075)) < 1e-9, `credits ${r.totals.totalCredits}`);
    assert.equal(r.diagnostics.claudeDuplicates, 3);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: id-less copies are deduplicated by content and ids containing delimiters stay distinct', async () => {
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: null }),
      claudeLine({ id: 'a:b', request: 'c', at: '2026-10-08T00:00:00.000Z' }),
      claudeLine({ id: 'a', request: 'b:c', at: '2026-10-09T00:00:00.000Z' }),
      claudeLine({ id: null, at: '2026-10-10T00:00:00.000Z' }),
    ],
    'a.orphaned-1760000000-ab12.jsonl': [claudeLine({ id: null })],
  });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 4, 'the orphaned copy of the first id-less message is not counted again');
    assert.equal(r.diagnostics.claudeDuplicates, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: absurd numeric values cannot produce infinite or NaN totals', async () => {
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: 'huge-cost', costUSD: Number.MAX_VALUE }),
      claudeLine({ id: 'huge-tokens', usage: { input_tokens: 1e300, output_tokens: 10 } }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    for (const value of [r.totals.totalCredits, r.totals.totalTokens, r.diagnostics.claudeCredits]) assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(r.totals.totalCredits - (0.25 + 0.025)) < 1e-9, 'an absurd recorded cost falls back to the list price');
    assert.equal(r.totals.totalTokens, 1310 + 10);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: overlapping configured roots count each transcript once', async () => {
  const fx = claudeFixture({});
  try {
    const nested = path.join(fx.claude, 'projects', 'p', 'projects', 'q');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'x.jsonl'), `${claudeLine({ id: 'only' })}\n`);
    touch(path.join(nested, 'x.jsonl'));
    const r = await aggregateUsage({
      now: NOW, provider: 'claudeCode', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [],
      claudeDirs: [fx.claude, path.join(fx.claude, 'projects', 'p')],
    });
    assert.equal(r.diagnostics.claudeTranscripts, 1);
    assert.equal(r.diagnostics.claudeFiles, 1);
    assert.equal(r.totals.calls, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('provider "both" leaves Claude transcripts of VS Code chat sessions to the Copilot section', async () => {
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: 'copilot-owned', session: 'shared-vscode', at: '2026-10-05T00:00:01.000Z' }),
      claudeLine({ id: 'claude-owned', session: 'claude-only', at: '2026-10-05T00:00:02.000Z' }),
    ],
  });
  try {
    const userDir = path.join(fx.root, 'Code', 'User');
    const request = { timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'copilot/claude-opus-4.8', promptTokens: 1000, completionTokens: 100, copilotCredits: 5 };
    writeChat(userDir, 'w1', 'shared.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'shared-vscode', requests: [request] } }));
    const r = await aggregateUsage({
      now: NOW, provider: 'both', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [userDir], claudeDirs: [fx.claude],
    });
    assert.equal(r.githubCopilot.totals.totalCredits, 5);
    assert.equal(r.githubCopilot.diagnostics.vscodeRequests, 1);
    assert.equal(r.claudeCode.totals.calls, 1);
    assert.equal(r.claudeCode.diagnostics.claudeSkippedCopilotSessions, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a call that names no provider returns separate sections, never one merged total', async () => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'm' })] });
  try {
    writeSession(path.join(fx.root, '.copilot'), 'S', [
      ev('assistant.message', '2026-10-06T00:00:00.000Z', { model: 'claude-opus-4.8' }),
      ev('session.shutdown', '2026-10-06T00:01:00.000Z', { totalNanoAiu: nano(3), modelMetrics: { 'claude-opus-4.8': metrics(1, 50, 5, 3) } }),
    ]);
    const base = { now: NOW, copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [], claudeDirs: [fx.claude] };
    const r = await aggregateUsage(base);
    assert.equal(r.provider, 'both');
    assert.equal(r.githubCopilot.totals.totalCredits, 3);
    assert.ok(Math.abs(r.claudeCode.totals.totalCredits - 0.25) < 1e-9);
    assert.equal(r.models, undefined, 'there is no merged model list');
    assert.equal((await aggregateUsage({ ...base, includeClaudeCode: false })).provider, 'githubCopilot');
    assert.equal((await aggregateUsage({ ...base, includeGitHubCopilot: false })).provider, 'claudeCode');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude price list covers Fable/Mythos and the Haiku 5.5 long-prompt tier', async () => {
  assert.equal(normalizeClaudeModel('claude-fable-5-1'), 'claude-fable-5.1');
  assert.equal(normalizeClaudeModel('claude-mythos-5-20260801'), 'claude-mythos-5');
  assert.deepEqual([claudePrice('claude-fable-5.1').input, claudePrice('claude-fable-5.1').cacheRead, claudePrice('claude-fable-5.1').output], [10, 0.25, 50]);
  assert.equal(claudePrice('claude-fable-5').cacheRead, 1);
  assert.equal(claudePrice('claude-mythos-5.1').cacheWrite1h, 20);
  assert.equal(claudePrice('claude-haiku-5.5').input, 0.1);
  assert.equal(claudePrice('claude-haiku-5.5').longPrompt.input, 0.5);
  assert.equal(claudePrice('claude-haiku-4.5').input, 1, 'Haiku 4.5 keeps its own rates');
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: 'short', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 50000 } }),
      claudeLine({ id: 'long', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 150000 } }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    assert.ok(Math.abs(r.totals.totalCredits - (0.11 + 1.05)) < 1e-9, `credits ${r.totals.totalCredits}`);
    assert.deepEqual(r.diagnostics.notes, []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: tool-result spill files and MCP task state are not treated as transcripts', async () => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'real' })] });
  try {
    const session = path.join(fx.claude, 'projects', 'p', 'a');
    for (const [dir, name] of [['tool-results', 'spill.jsonl'], ['mcp-tasks', 'task.jsonl'], ['subagents', 'agent-1.jsonl']]) {
      fs.mkdirSync(path.join(session, dir), { recursive: true });
      fs.writeFileSync(path.join(session, dir, name), `${claudeLine({ id: `from-${dir}`, at: '2026-10-08T00:00:00.000Z' })}\n`);
      touch(path.join(session, dir, name));
    }
    const r = await claudeOnly(fx);
    assert.equal(r.diagnostics.claudeTranscripts, 2, 'the session transcript and its subagent transcript');
    assert.equal(r.totals.calls, 2);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('hostile model ids are capped and cannot make normalization expensive', async () => {
  let started = Date.now();
  normalizeClaudeModel('['.repeat(300000));
  assert.ok(Date.now() - started < 1500, 'bracket-heavy ids normalize in linear time');
  assert.ok(normalizeClaudeModel('x'.repeat(5000)).length <= 128);
  assert.equal(normalizeClaudeModel('global.anthropic.claude-sonnet-4-5-v1:0'), 'claude-sonnet-4.5');
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'hostile', model: 'x['.repeat(100000) })] });
  try {
    started = Date.now();
    const r = await claudeOnly(fx);
    assert.ok(Date.now() - started < 5000, 'a hostile transcript cannot stall the scan');
    assert.equal(r.totals.calls, 1);
    assert.ok(r.models[0].model.length <= 128, 'the model name kept for display is bounded');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: a malformed record never discards the valid records around it', async () => {
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: 'before' }),
      claudeLine({ id: 'odd-numbers', usage: { input_tokens: { toString: null }, output_tokens: [1], cache_read_input_tokens: true, cache_creation_input_tokens: 'many' } }),
      claudeLine({ id: 'odd-time', at: { toString: null } }),
      claudeLine({ id: 'after' }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    assert.deepEqual(r.diagnostics.errors, []);
    assert.equal(r.totals.calls, 3, 'before, after and the record whose numbers were unusable (counted with zero tokens)');
    assert.equal(r.totals.totalTokens, 1310 + 1310);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('VS Code chat records with unusable numbers are reported, not fatal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-fixture-odd-chat-'));
  try {
    const userDir = path.join(root, 'Code', 'User');
    const good = { timestamp: Date.parse('2026-10-05T00:00:00Z'), modelId: 'copilot/m', promptTokens: 10, completionTokens: 1, copilotCredits: 2 };
    const odd = { ...good, timestamp: good.timestamp + 1, promptTokens: { toString: null }, copilotCredits: 'lots' };
    writeChat(userDir, 'w', 'odd.jsonl', JSON.stringify({ kind: 0, v: { sessionId: 'odd', requests: [good, odd] } }));
    const r = await aggregateUsage({ now: NOW, provider: 'githubCopilot', copilotHome: path.join(root, '.copilot'), vscodeUserDirs: [userDir] });
    assert.deepEqual(r.diagnostics.errors, []);
    assert.equal(r.totals.totalCredits, 2);
    assert.ok(r.diagnostics.vscodeInvalidNumbers >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude transcripts: ties prefer the more recently written copy, whatever order the files are read in', async () => {
  for (const [active, orphan] of [['a.jsonl', 'a.orphaned-1760000000-ab12.jsonl'], ['z.jsonl', 'a.orphaned-1760000000-ab12.jsonl']]) {
    const fx = claudeFixture({
      [active]: [claudeLine({ id: 'm', usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 1000 } })],
      [orphan]: [claudeLine({ id: 'm', usage: { input_tokens: 1000, output_tokens: 10 } })],
    });
    try {
      touch(path.join(fx.claude, 'projects', 'p', orphan), new Date('2026-10-14T00:00:00Z'));
      const r = await claudeOnly(fx);
      assert.equal(r.totals.calls, 1);
      assert.ok(Math.abs(r.totals.totalCredits - 0.075) < 1e-9, `${active} vs ${orphan}: credits ${r.totals.totalCredits}`);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('Claude transcripts: distinct requests and very long distinct ids are never merged', async () => {
  const longId = (suffix) => `${'x'.repeat(200)}${suffix}`;
  const fx = claudeFixture({
    'a.jsonl': [
      claudeLine({ id: null, request: 'r1' }), claudeLine({ id: null, request: 'r2' }),
      claudeLine({ id: longId('A'), request: 'r' }), claudeLine({ id: longId('B'), request: 'r' }),
      claudeLine({ id: 'same', request: longId('1') }), claudeLine({ id: 'same', request: longId('2') }),
    ],
  });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 6);
    assert.equal(r.diagnostics.claudeDuplicates, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: a config directory reached through a link is read once', async (t) => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'only' })] });
  try {
    const alias = path.join(fx.root, 'alias');
    try { fs.symlinkSync(fx.claude, alias, 'junction'); } catch { t.skip('links cannot be created here'); return; }
    const r = await aggregateUsage({
      now: NOW, provider: 'claudeCode', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [], claudeDirs: [fx.claude, alias],
    });
    assert.equal(r.diagnostics.claudeTranscripts, 1);
    assert.equal(r.totals.calls, 1);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('model names from files cannot carry terminal control or bidirectional characters', async () => {
  assert.equal(normalizeModel('GPT-5\u001b[2J\u0007'), 'gpt-5[2j');
  assert.equal(normalizeModel('\u0007\u202e'), 'unknown');
  assert.equal(normalizeModel('copilot/\u202egpt-5'), 'gpt-5');
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'esc', model: 'claude-opus-4-8\u001b[31m\u0007\u202e-evil' })] });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.models.length, 1);
    assert.equal(r.models[0].model, 'claude-opus-4-8[31m-evil');
    assert.doesNotMatch(r.models[0].model, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unreadable Claude Code folders are reported once, by error code, without naming the project folder', async (t) => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'ok' })] });
  try {
    for (const secret of ['C--Users-bob-secret-merger', 'C--Users-bob-other-client']) {
      fs.mkdirSync(path.join(fx.claude, 'projects', secret), { recursive: true });
    }
    const real = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (dir, ...rest) => {
      if (path.basename(path.dirname(String(dir))) === 'projects' && /secret|other/.test(String(dir))) {
        const error = new Error(`EPERM: operation not permitted, scandir '${dir}'`);
        error.code = 'EPERM';
        throw error;
      }
      return real.call(fs, dir, ...rest);
    });
    const r = await claudeOnly(fx);
    assert.deepEqual(Array.from(r.diagnostics.errors), ['Claude Code transcripts folder could not be read (EPERM)']);
    assert.equal(r.totals.calls, 1, 'readable folders are still counted');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: a short id that looks like a digest never merges with the long id it resembles', async () => {
  const long = 'x'.repeat(200);
  const lookalike = `sha256:${crypto.createHash('sha256').update(long).digest('hex')}`;
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: long, request: 'r' }), claudeLine({ id: lookalike, request: 'r' })] });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 2);
    assert.equal(r.diagnostics.claudeDuplicates, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude transcripts: the record size limit excludes the line ending, for LF and CRLF alike', async () => {
  const limit = 8 * 1024 * 1024;
  const sized = (id, bytes) => {
    const probe = claudeLine({ id, content: '' });
    return claudeLine({ id, content: 'a'.repeat(bytes - Buffer.byteLength(probe)) });
  };
  assert.equal(Buffer.byteLength(sized('probe', limit)), limit);
  const fx = claudeFixture({});
  try {
    const file = path.join(fx.claude, 'projects', 'p', 'edge.jsonl');
    fs.writeFileSync(file, [
      `${sized('exact-lf', limit)}\n`, `${sized('exact-crlf', limit)}\r\n`,
      `${sized('over-lf', limit + 1)}\n`, `${sized('over-crlf', limit + 1)}\r\n`,
      `${claudeLine({ id: 'after' })}\n`,
    ].join(''));
    touch(file);
    const r = await claudeOnly(fx);
    assert.equal(r.totals.calls, 3, 'the two records exactly at the limit and the small record after them are counted');
    assert.equal(r.diagnostics.claudeOversizedRecords, 2, 'only the two records one byte over the limit are skipped');
    assert.deepEqual(r.diagnostics.errors, []);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a chat session whose responder is Claude is not taken for GitHub Copilot by an agent-host marker alone', async () => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'm1', session: 'claude-session' })] });
  try {
    const userDir = path.join(fx.root, 'Code', 'User');
    const base = { timestamp: Date.parse('2026-10-05T00:00:00Z'), promptTokens: 100, completionTokens: 10, copilotCredits: 7 };
    const session = (sessionId, responderUsername, request) => JSON.stringify({ kind: 0, v: { sessionId, responderUsername, requests: [{ ...base, ...request }] } });
    writeChat(userDir, 'w', 'copilot-agent.jsonl', session('copilot-agent', 'GitHub Copilot', { modelId: 'agent-model', modelTotals: [] }));
    writeChat(userDir, 'w', 'claude-agent.jsonl', session('claude-session', 'Claude Code', { timestamp: base.timestamp + 1, modelId: 'agent-model', modelTotals: [] }));
    writeChat(userDir, 'w', 'copilot-model.jsonl', session('copilot-model', 'Claude Code', { timestamp: base.timestamp + 2, modelId: 'copilot/claude-x' }));
    const r = await aggregateUsage({
      now: NOW, provider: 'both', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [userDir], claudeDirs: [fx.claude],
    });
    assert.equal(r.githubCopilot.totals.calls, 2, 'the Copilot responder and the explicit copilot/ model id are counted');
    assert.equal(r.githubCopilot.totals.totalCredits, 14);
    assert.equal(r.githubCopilot.diagnostics.vscodeOtherProviderSessions, 1, 'the Claude responder session is left out');
    assert.equal(r.claudeCode.totals.calls, 1, 'its Claude Code transcript is not suppressed as a Copilot session');
    assert.equal(r.claudeCode.diagnostics.claudeSkippedCopilotSessions, 0);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Claude Code usage from a model without a list price keeps its tokens and reports the value as unavailable', async () => {
  const fx = claudeFixture({ 'a.jsonl': [claudeLine({ id: 'x', model: 'claude-unreleased-9' })] });
  try {
    const r = await claudeOnly(fx);
    assert.equal(r.totals.totalTokens, 1310);
    assert.equal(r.totals.totalCredits, 0);
    assert.ok(r.diagnostics.notes.some((note) => /no list price for: claude-unreleased-9 \(tokens counted, value unavailable\)/.test(note)));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('CLAUDE_CONFIG_DIR names one directory, even when its path contains a comma', async () => {
  const fx = claudeFixture({});
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const configured = path.join(fx.root, 'with,comma', 'claude');
    const project = path.join(configured, 'projects', 'p');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'a.jsonl'), `${claudeLine({ id: 'comma' })}\n`);
    touch(path.join(project, 'a.jsonl'));
    process.env.CLAUDE_CONFIG_DIR = configured;
    const r = await aggregateUsage({ now: NOW, provider: 'claudeCode', copilotHome: path.join(fx.root, '.copilot'), vscodeUserDirs: [] });
    assert.equal(r.totals.calls, 1);
    assert.equal(r.diagnostics.claudeTranscripts, 1);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

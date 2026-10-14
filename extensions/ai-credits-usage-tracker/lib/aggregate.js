'use strict';
// Read-only aggregation of AI usage (tokens + AI credits) by model for the current billing cycle.
//
// Sources (all local, nothing leaves the machine):
//   cli     ~/.copilot/session-store.db  assistant_usage_events — exact per-call tokens + nano-AIU for indexed sessions
//   cli*    ~/.copilot/session-state/<id>/events.jsonl  session.shutdown.modelMetrics — exact per-model data for finished runs not yet indexed
//   est     same events.jsonl — session-level cumulative credits (usage_checkpoint/shutdown) minus exact data, allocated to models
//           using the per-call model tag on assistant.message events (runs that ended without a clean shutdown, live sessions)
//   vscode  <User>/workspaceStorage/*/chatSessions/*.jsonl — VS Code-native chat requests: completionTokens, copilotCredits, promptTokens
//   claude  <claude config>/projects/**/*.jsonl — Claude Code transcripts: per-message tokens, priced at Anthropic list rates

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// total_nano_aiu / 1e9 = GitHub AI Credits (1 credit = $0.01 under the 2026-06-01 usage-based billing model).
const NANO_PER_CREDIT = 1e9;
const METRICS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'credits', 'premiumRequests'];
const TOOL_OF_SOURCE = { cli: 'Copilot agent / CLI', 'cli*': 'Copilot agent / CLI', est: 'Copilot agent / CLI', vscode: 'VS Code chat', claude: 'Claude Code' };

// Copilot allowances reset at 00:00 UTC on the 1st of each calendar month; resetDay is configurable for other cycles.
function billingCycle(now = new Date(), resetDay = 1) {
  const day = Math.min(Math.max(Math.trunc(resetDay) || 1, 1), 28);
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (now < start) start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
  return { start, end };
}

const nonNegativeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const normalizeModel = (m) => typeof m === 'string' && m.trim()
  ? m.trim().replace(/^copilot\//i, '').toLowerCase()
  : 'unknown';
const inWindow = (ms, win) => Number.isFinite(ms) && ms >= win.start.getTime() && ms < win.end.getTime();
const zero = () => Object.fromEntries(METRICS.map((k) => [k, 0]));

// Parsed-file cache for the lifetime of the process (the extension keeps one worker alive), reused while a
// file's size and mtime are unchanged. Entries not touched by the latest run are pruned.
const fileCache = new Map();
const MAX_CACHED_FILES = 256;
let runId = 0;
async function cachedParse(file, st, parse) {
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    hit.runId = runId;
    fileCache.delete(file);
    fileCache.set(file, hit);
    return hit.value;
  }
  const value = await parse();
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, runId });
  while (fileCache.size > MAX_CACHED_FILES) fileCache.delete(fileCache.keys().next().value);
  return value;
}
function pruneCache() {
  for (const [k, v] of fileCache) if (v.runId !== runId) fileCache.delete(k);
}

class Totals {
  constructor() { this.byModel = new Map(); }
  bucket(model) {
    const key = normalizeModel(model);
    if (!this.byModel.has(key)) {
      this.byModel.set(key, {
        model: key, ...zero(), estCredits: 0, estTokens: 0, estCalls: 0, pendingCalls: 0,
        cliCalls: 0, cliCredits: 0, cliTokens: 0, byTool: {}, sources: new Set(),
      });
    }
    return this.byModel.get(key);
  }
  addTool(b, source, credits) {
    const tool = TOOL_OF_SOURCE[source] || source;
    b.byTool[tool] = (b.byTool[tool] || 0) + (credits || 0);
  }
  addExact(model, m, source, sess) {
    const b = this.bucket(model);
    for (const k of METRICS) b[k] += nonNegativeNumber(m[k]);
    b.sources.add(source);
    this.addTool(b, source, m.credits);
    // Per-call rates for reconciliation come from Copilot agent/CLI data only (VS Code rows are per request,
    // Claude rows are list-price estimates).
    if (source === 'cli' || source === 'cli*') {
      b.cliCalls += nonNegativeNumber(m.calls);
      b.cliCredits += nonNegativeNumber(m.credits);
      b.cliTokens += nonNegativeNumber(m.inputTokens) + nonNegativeNumber(m.outputTokens);
    }
    if (sess) {
      const e = sess.exact.get(b.model) || { credits: 0, calls: 0, tokens: 0 };
      e.credits += nonNegativeNumber(m.credits);
      e.calls += nonNegativeNumber(m.calls);
      e.tokens += nonNegativeNumber(m.inputTokens) + nonNegativeNumber(m.outputTokens);
      sess.exact.set(b.model, e);
    }
  }
}

function defaultVSCodeUserDirs() {
  const base = process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return ['Code', 'Code - Insiders'].map((f) => path.join(base || '', f, 'User')).filter((d) => fs.existsSync(d));
}

function openStore(copilotHome, diag) {
  const dbPath = path.join(copilotHome, 'session-store.db');
  if (!fs.existsSync(dbPath)) { diag.notes.push(`no session store at ${dbPath}`); return null; }
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    diag.notes.push(`node:sqlite unavailable (${e.message}); indexed CLI history skipped`);
    return null;
  }
}

const getSession = (sessions, id) => {
  if (!sessions.has(id)) sessions.set(id, { id, exact: new Map(), points: [], messages: [], lastExactAt: -Infinity });
  return sessions.get(id);
};

// ---------- Source 1: Copilot CLI / SDK session store (exact, per call) ----------
function readCopilotStore(db, win, totals, sessions, diag) {
  const indexed = new Map(); // sessionId -> last indexed call (ms)
  if (!db) return indexed;
  // One read transaction so `indexed` and `rows` come from the same snapshot (a session indexed in between
  // would otherwise be counted from both the DB and its shutdown event).
  db.exec('BEGIN');
  let rows;
  try {
    for (const r of db.prepare('SELECT session_id, MAX(created_at) AS last_at FROM assistant_usage_events GROUP BY session_id').all()) {
      indexed.set(r.session_id, Date.parse(r.last_at));
    }
    rows = db.prepare(`
      SELECT session_id, model, initiator, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, total_nano_aiu, request_multiplier
      FROM assistant_usage_events
      WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)`)
      .all(win.start.toISOString(), win.end.toISOString());
  } finally {
    db.exec('COMMIT');
  }
  for (const r of rows) {
    totals.addExact(r.model, {
      calls: 1,
      inputTokens: r.input_tokens || 0,
      outputTokens: r.output_tokens || 0,
      cacheReadTokens: r.cache_read_tokens || 0,
      cacheWriteTokens: r.cache_write_tokens || 0,
      reasoningTokens: r.reasoning_tokens || 0,
      credits: (r.total_nano_aiu || 0) / NANO_PER_CREDIT,
      premiumRequests: r.initiator === 'user' ? r.request_multiplier || 0 : 0,
    }, 'cli', getSession(sessions, r.session_id));
  }
  diag.cliRows = rows.length;
  return indexed;
}

// ---------- Source 2: Copilot CLI / SDK session-state events ----------
async function readEvents(file) {
  const shutdowns = [];
  const points = []; // cumulative session totals: { ts, nano }
  const messages = []; // one assistant.message per API call: [model, ms]
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const isShutdown = line.includes('"type":"session.shutdown"');
    if (isShutdown || line.includes('"type":"session.usage_checkpoint"')) {
      try {
        const o = JSON.parse(line);
        if (isShutdown) shutdowns.push({ timestamp: o.timestamp, data: { modelMetrics: o.data && o.data.modelMetrics } });
        if (o.data && Number.isFinite(o.data.totalNanoAiu)) points.push({ ts: Date.parse(o.timestamp), nano: o.data.totalNanoAiu });
      } catch { /* partial trailing line */ }
    } else if (line.includes('"type":"assistant.message"')) {
      try {
        const o = JSON.parse(line);
        if (o.data && typeof o.data.model === 'string' && o.data.model.trim()) messages.push([o.data.model, Date.parse(o.timestamp)]);
      } catch { /* partial trailing line */ }
    }
  }
  return { shutdowns, points, messages };
}

const flatMetrics = (m) => {
  const x = m && typeof m === 'object' ? m : {};
  const u = (x.usage && typeof x.usage === 'object') ? x.usage : {};
  const r = (x.requests && typeof x.requests === 'object') ? x.requests : {};
  return {
    calls: nonNegativeNumber(r.count), premiumRequests: nonNegativeNumber(r.cost),
    inputTokens: nonNegativeNumber(u.inputTokens), outputTokens: nonNegativeNumber(u.outputTokens),
    cacheReadTokens: nonNegativeNumber(u.cacheReadTokens), cacheWriteTokens: nonNegativeNumber(u.cacheWriteTokens),
    reasoningTokens: nonNegativeNumber(u.reasoningTokens),
    credits: nonNegativeNumber(x.totalNanoAiu) / NANO_PER_CREDIT,
  };
};

// modelMetrics are cumulative across clean resumes (each shutdown re-emits prior totals), so count only the
// delta since the previous shutdown and attribute it to that shutdown's timestamp. A run that straddles the
// cycle start is left to reconcileSessions(), which bounds it with checkpoints and marks it estimated.
function addShutdownDeltas(shutdowns, messages, win, totals, sess, diag) {
  let prev = {};
  let prevAt = -Infinity;
  for (const s of shutdowns) {
    const at = Date.parse(s.timestamp);
    const cur = (s.data && s.data.modelMetrics && typeof s.data.modelMetrics === 'object') ? s.data.modelMetrics : {};
    const straddles = messages.some(([, ms]) => ms > prevAt && ms <= at && ms < win.start.getTime());
    if (inWindow(at, win) && !straddles) {
      for (const [model, m] of Object.entries(cur)) {
        if (!m || typeof m !== 'object') continue;
        const now = flatMetrics(m);
        const before = flatMetrics(prev[model]);
        const delta = Object.fromEntries(Object.keys(now).map((k) => [k, Math.max(0, now[k] - before[k])]));
        if (Object.values(delta).some((v) => v > 0)) totals.addExact(model, delta, 'cli*', sess);
      }
    } else if (inWindow(at, win)) {
      diag.straddlingRuns += 1;
    }
    const nextPrev = { ...prev };
    for (const [model, m] of Object.entries(cur)) if (m && typeof m === 'object') nextPrev[model] = m;
    prev = nextPrev;
    prevAt = at;
  }
}

function compareWithDb(db, sessionId, shutdown, validation) {
  const rows = db.prepare(`
    SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(total_nano_aiu) AS n,
           SUM(CASE WHEN initiator = 'user' THEN request_multiplier ELSE 0 END) AS p
    FROM assistant_usage_events WHERE session_id = ? GROUP BY model`).all(sessionId);
  const mm = (shutdown.data && shutdown.data.modelMetrics) || {};
  const ok = rows.length === Object.keys(mm).length && rows.every((r) => {
    const m = mm[r.model];
    return m && m.usage && m.usage.inputTokens === r.i && m.usage.outputTokens === r.o
      && m.totalNanoAiu === r.n && ((m.requests && m.requests.cost) || 0) === r.p;
  });
  validation.compared += 1;
  if (ok) validation.matched += 1;
  else if (validation.mismatches.length < 3) validation.mismatches.push({ sessionId, db: rows, shutdown: mm });
}

async function scanSessionState(db, copilotHome, win, indexed, totals, sessions, diag, validate) {
  const dir = path.join(copilotHome, 'session-state');
  if (!fs.existsSync(dir)) return;
  const validation = { compared: 0, matched: 0, mismatches: [] };
  for (const id of fs.readdirSync(dir)) {
    const file = path.join(dir, id, 'events.jsonl');
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < win.start.getTime()) continue;
    diag.sessionDirsScanned += 1;
    try {
      const sess = getSession(sessions, id);
      const { shutdowns, points, messages } = await cachedParse(file, st, () => readEvents(file));
      sess.points = points;
      sess.messages = messages;
      if (indexed.has(id)) {
        sess.lastExactAt = indexed.get(id);
        if (validate && db && shutdowns.length) {
          const last = shutdowns[shutdowns.length - 1];
          const lastAt = Date.parse(last.timestamp);
          if (!messages.some(([, ms]) => ms > lastAt)) compareWithDb(db, id, last, validation);
        }
      } else if (shutdowns.length) {
        diag.backfilledSessions += 1;
        addShutdownDeltas(shutdowns, messages, win, totals, sess, diag);
        sess.lastExactAt = Date.parse(shutdowns[shutdowns.length - 1].timestamp);
      }
    } catch (e) {
      diag.errors.push(`session ${id}: ${e.message}`);
    }
  }
  if (validate) diag.validation = validation;
}

// Reconcile exact per-model data against the session's cumulative credit total. Anything the per-model data does
// not explain (runs that ended without a clean shutdown, or live runs past their last checkpoint) is allocated
// to models by the per-call model tags, weighted by each model's observed credits-per-call, and marked estimated.
function reconcileSessions(sessions, win, totals, diag) {
  const rates = new Map([...totals.byModel.values()].map((b) => [b.model, { calls: b.cliCalls, credits: b.cliCredits, tokens: b.cliTokens }]));
  const all = [...rates.values()].reduce((a, x) => ({ calls: a.calls + x.calls, credits: a.credits + x.credits, tokens: a.tokens + x.tokens }), { calls: 0, credits: 0, tokens: 0 });
  const creditsPerCall = (m) => { const x = rates.get(m); return x && x.calls ? x.credits / x.calls : (all.calls ? all.credits / all.calls : 1); };

  // Converting a session's unexplained credit gap into an approximate token count needs a tokens-per-credit
  // ratio, but cache-hit rates vary enormously both by model and by how cache-friendly one particular session
  // is (a single long thread that keeps resending the same huge context is far more cache-heavy than the
  // model's overall average), so prefer, in order: (1) this model's own exact ratio *within this same
  // session*, (2) this model's exact ratio across all sessions/sources, (3) a global blended ratio.
  const exactByModel = new Map([...totals.byModel.values()].map((b) => [b.model, { credits: b.credits, tokens: b.inputTokens + b.outputTokens }]));
  const globalExact = [...exactByModel.values()].reduce((a, x) => ({ credits: a.credits + x.credits, tokens: a.tokens + x.tokens }), { credits: 0, tokens: 0 });
  const modelTokensPerCredit = (m) => {
    const x = exactByModel.get(m);
    if (x && x.credits > 0) return x.tokens / x.credits;
    return globalExact.credits ? globalExact.tokens / globalExact.credits : 0;
  };
  const tokensPerCredit = (sess, m) => {
    const e = sess.exact.get(m);
    if (e && e.credits > 0) return e.tokens / e.credits;
    return modelTokensPerCredit(m);
  };

  for (const sess of sessions.values()) {
    let base = 0;
    let baseAt = -Infinity;
    let top = null;
    let firstInWindow = null;
    let firstInWindowAt = Infinity;
    let coveredUntil = sess.lastExactAt;
    for (const p of sess.points) {
      if (p.ts < win.start.getTime()) { if (p.nano >= base) { base = p.nano; baseAt = p.ts; } }
      else if (p.ts < win.end.getTime()) {
        if (top === null || p.nano > top) top = p.nano;
        if (p.ts < firstInWindowAt) { firstInWindowAt = p.ts; firstInWindow = p.nano; }
        coveredUntil = Math.max(coveredUntil, p.ts);
      }
    }
    const exactCredits = [...sess.exact.values()].reduce((s, e) => s + e.credits, 0);
    let sessionCredits = top === null ? 0 : Math.max(0, top - base) / NANO_PER_CREDIT;
    if (top !== null && sessionCredits > 0) {
      // The gap (base..top) spans from the last pre-cycle checkpoint (or this session's very start, if there
      // isn't one) to the first in-window checkpoint. When that bracket mixes messages from both sides of the
      // cycle boundary — a stale/missing pre-cycle checkpoint under-counts `base` — prorate the gap by the
      // in-window share of bracketing calls instead of crediting all of it to this cycle. Checkpoints are
      // normally far finer-grained than this, so the common case (no pre-cycle messages in the bracket) is
      // unaffected: `before` is 0 and this reduces to the original `sessionCredits` exactly.
      const bracket = sess.messages.filter(([, ms]) => ms > baseAt && ms <= firstInWindowAt);
      const before = bracket.filter(([, ms]) => ms < win.start.getTime()).length;
      if (bracket.length > 0 && before > 0) {
        const firstStep = Math.max(0, firstInWindow - base);
        const laterSteps = Math.max(0, top - Math.max(firstInWindow, base));
        const inWindowShare = before < bracket.length ? 1 - before / bracket.length : 0;
        sessionCredits = (firstStep * inWindowShare + laterSteps) / NANO_PER_CREDIT;
      }
    }
    diag.cliSessionCredits += Math.max(sessionCredits, exactCredits);

    const covered = new Map();
    for (const [model, ms] of sess.messages) {
      if (!inWindow(ms, win)) continue;
      const key = normalizeModel(model);
      if (ms <= coveredUntil) covered.set(key, (covered.get(key) || 0) + 1);
      else { totals.bucket(key).pendingCalls += 1; diag.pendingCalls += 1; }
    }

    const gap = sessionCredits - exactCredits;
    if (gap <= 1e-6) continue;
    const unaccounted = new Map([...covered].map(([m, n]) => [m, Math.max(0, n - ((sess.exact.get(m) || {}).calls || 0))]));
    let weights = new Map([...unaccounted].map(([m, n]) => [m, n * creditsPerCall(m)]));
    let wsum = [...weights.values()].reduce((s, w) => s + w, 0);
    if (!wsum) {
      weights = new Map([...covered].map(([m, n]) => [m, n * creditsPerCall(m)]));
      wsum = [...weights.values()].reduce((s, w) => s + w, 0);
    }
    if (!wsum) weights = new Map([['unattributed', 1]]), wsum = 1;
    for (const [m, w] of weights) {
      if (!w) continue;
      const share = gap * (w / wsum);
      const b = totals.bucket(m);
      b.estCredits += share;
      b.estTokens += share * tokensPerCredit(sess, m);
      b.estCalls += unaccounted.get(m) || 0;
      totals.addTool(b, 'est', share);
      if (gap > 0.5) b.sources.add('est');
    }
    diag.estimatedCredits += gap;
    if (gap > 0.5) diag.reconciledSessions += 1;
  }
}

// ---------- Source 3: VS Code-native chat sessions ----------
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafePath(p) {
  return Array.isArray(p) && p.every((k) => (typeof k === 'string' || Number.isInteger(k)) && !UNSAFE_KEYS.has(String(k)));
}
function getPath(obj, p) {
  return p.reduce((o, k) => {
    if (o === null || o === undefined || !Object.prototype.hasOwnProperty.call(o, k)) throw new Error('invalid mutation path');
    return o[k];
  }, obj);
}
function setPath(obj, p, v) { getPath(obj, p.slice(0, -1))[p[p.length - 1]] = v; }

// Chat session mutation log: kind 0 = snapshot, 1 = set at path, 2 = truncate-at-i then push, 3 = delete at path.
// `box` holds the in-progress state so both the in-memory (string) and streaming (file) replayers below can
// share this single-line applier without duplicating the mutation logic.
function applyMutationLine(box, line) {
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  // Untrusted mutation paths must never be allowed to reach Object.prototype (e.g. {"k":["__proto__","x"]}).
  if (o.kind !== 0 && !isSafePath(o.k)) return;
  try {
    if (o.kind === 0) box.state = o.v;
    else if (o.kind === 1) setPath(box.state, o.k, o.v);
    else if (o.kind === 2) {
      const arr = getPath(box.state, o.k);
      if (o.i !== undefined && o.i !== null) arr.splice(o.i);
      if (Array.isArray(o.v)) arr.push(...o.v);
    } else if (o.kind === 3) {
      const parent = getPath(box.state, o.k.slice(0, -1));
      const key = o.k[o.k.length - 1];
      if (Array.isArray(parent)) parent.splice(key, 1); else delete parent[key];
    }
  } catch { /* tolerate unknown or partial mutations */ }
}

function replayChatSession(text) {
  const box = { state: null };
  for (const line of text.split(/\r?\n/)) applyMutationLine(box, line);
  return box.state;
}

// Stream the append log instead of loading one string: large histories can exceed V8's string-length limit.
async function replayChatSessionFile(file) {
  const box = { state: null };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) applyMutationLine(box, line);
  return box.state;
}

function listDir(dir, diag, label) {
  try { return fs.readdirSync(dir); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') diag.errors.push(`${label} ${dir}: ${e.message}`);
    return [];
  }
}
function chatSessionFiles(userDir, diag) {
  const out = [];
  const ws = path.join(userDir, 'workspaceStorage');
  for (const h of listDir(ws, diag, 'VS Code storage')) {
    const d = path.join(ws, h, 'chatSessions');
    for (const f of listDir(d, diag, 'VS Code chat sessions')) out.push(path.join(d, f));
  }
  const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
  for (const f of listDir(empty, diag, 'VS Code empty-window sessions')) out.push(path.join(empty, f));
  return out.filter((f) => /\.jsonl?$/.test(f));
}

// Only the fields needed for aggregation are kept, so cached entries stay small.
async function summarizeChatSession(file) {
  const session = file.endsWith('.jsonl') ? await replayChatSessionFile(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
  const requests = session && Array.isArray(session.requests) ? session.requests : [];
  let invalidNumbers = 0;
  const number = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
    if (value !== undefined && value !== null) invalidNumbers += 1;
    return 0;
  };
  return {
    sessionId: session && typeof session.sessionId === 'string' ? session.sessionId : null,
    responderUsername: session && typeof session.responderUsername === 'string' ? session.responderUsername : '',
    get invalidNumbers() { return invalidNumbers; },
    requests: requests
      .filter((r) => r && typeof r === 'object' && (r.promptTokens != null || r.completionTokens != null || r.copilotCredits != null))
      .map((r) => ({
        // Forking/duplicating a session rewrites `timestamp` to the fork time but keeps `responseTimestamp` as
        // the true original completion time (verified against real forked sessions on this machine); prefer it
        // so a forked copy of old messages doesn't get billed to whichever cycle the fork happened in.
        effectiveTimestamp: Number.isFinite(r.responseTimestamp) ? r.responseTimestamp : r.timestamp,
        model: r.modelId || ((r.result && r.result.metadata) || {}).resolvedModel,
        githubCopilot: /^copilot\//i.test(String(r.modelId || ''))
          || Array.isArray(r.modelTotals)
          || (session && session.responderUsername === 'GitHub Copilot'),
        promptTokens: number(r.promptTokens), // final-round context size: a lower bound on billed input
        completionTokens: number(r.completionTokens),
        copilotCredits: number(r.copilotCredits),
        agentHost: Array.isArray(r.modelTotals),
      })),
  };
}

async function readVSCodeChat(userDirs, win, totals, diag, coveredCliSessionIds) {
  // Shared across all user dirs (not reset per dir) so a session copied between Code and Code - Insiders, or
  // forked within the same store, is only ever counted once.
  const seenSessions = new Set();
  const seenRequests = new Set();
  const summaries = [];
  // Collect stable + Insiders together before sorting: otherwise whichever user directory is visited first
  // wins, even when the other product has a newer copy of the same session.
  const files = userDirs.flatMap((userDir) => chatSessionFiles(userDir, diag))
    .map((f) => { try { return { f, st: fs.statSync(f) }; } catch { return null; } })
    .filter((x) => x && x.st.mtimeMs >= win.start.getTime())
    .sort((a, b) => (b.st.mtimeMs - a.st.mtimeMs) || (Number(b.f.endsWith('.jsonl')) - Number(a.f.endsWith('.jsonl'))));
  for (const { f, st } of files) {
    const fileId = path.basename(f).replace(/\.jsonl?$/, '');
    if (seenSessions.has(fileId)) { diag.vscodeDuplicateFiles += 1; continue; }
    try {
      const summary = await cachedParse(f, st, () => summarizeChatSession(f));
      diag.vscodeInvalidNumbers += summary.invalidNumbers;
      const sessionId = summary.sessionId || fileId;
      if (seenSessions.has(sessionId)) { diag.vscodeDuplicateFiles += 1; continue; }
      seenSessions.add(fileId);
      seenSessions.add(sessionId);
      if (!summary.requests.some((r) => r.githubCopilot)) {
        diag.vscodeOtherProviderSessions += 1;
        continue;
      }
      diag.vscodeSessionFiles += 1;
      summaries.push({ sessionId, requests: summary.requests.filter((r) => r.githubCopilot) });
    } catch (e) {
      diag.errors.push(`chat session ${fileId}: ${e.message}`);
    }
  }
  const signature = (r) => `${r.effectiveTimestamp}|${r.promptTokens}|${r.completionTokens}|${r.copilotCredits}`;
  // Build this before counting anything: a fork can be newer and therefore encountered before the covered
  // original. Covered signatures make suppression independent of file order and rewritten session IDs.
  const coveredAgentHostRequests = new Set();
  for (const { sessionId, requests } of summaries) {
    if (!coveredCliSessionIds.has(sessionId)) continue;
    for (const r of requests) if (r.agentHost && inWindow(r.effectiveTimestamp, win)) coveredAgentHostRequests.add(signature(r));
  }
  for (const { sessionId, requests } of summaries) {
    for (const r of requests) {
      if (!inWindow(r.effectiveTimestamp, win)) continue;
      const dedupeKey = signature(r);
      // Agent-host turns already covered by matching CLI/session-state data, including copies in forks whose
      // session IDs were rewritten, must not be counted as a second tool source.
      if (r.agentHost && (coveredCliSessionIds.has(sessionId) || coveredAgentHostRequests.has(dedupeKey))) {
        diag.vscodeAgentHostSkipped += 1;
        continue;
      }
      // Forking a session copies its requests (new requestId, rewritten `timestamp`) but keeps the exact
      // same token/credit numbers, so this content signature catches the duplicate even across files.
      if (seenRequests.has(dedupeKey)) { diag.vscodeDuplicateRequests += 1; continue; }
      seenRequests.add(dedupeKey);
      totals.addExact(r.model, {
        calls: 1, inputTokens: r.promptTokens, outputTokens: r.completionTokens, credits: r.copilotCredits,
      }, 'vscode');
      diag.vscodeRequests += 1;
      diag.vscodeCredits += r.copilotCredits;
    }
  }
  if (diag.vscodeInvalidNumbers > 0) {
    diag.notes.push(`${diag.vscodeInvalidNumbers} invalid VS Code chat numeric value(s) were ignored`);
  }
}

// ---------- Source 4: Claude Code transcripts ----------
// Anthropic list prices, USD per 1M tokens. Opus 4.7–5, Opus 5.5 and Sonnet 5 were checked against GitHub
// AI-credit billing for the same models and match to the cent; Claude Code usage is shown at these rates.
const CLAUDE_PRICES = [
  [/^claude-opus-5\.5(?![.\d])/, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }],
  [/^claude-opus-(4\.[5-9]|5)(?![.\d])/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  [/^claude-opus-(4|4\.[01]|3)(?![.\d])/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 }],
  [/^claude-sonnet-5\.5(?![.\d])/, { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
  [/^claude-sonnet-5(?![.\d])/, { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
  [/^claude-sonnet-(4|3\.5|3\.7)(?![\d])/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }],
  [/^claude-haiku-4(?![\d])/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }],
  [/^claude-haiku-3\.5(?![\d])/, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 }],
  [/^claude-haiku-3(?![.\d])/, { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite5m: 0.3, cacheWrite1h: 0.5 }],
];
const claudePrice = (model) => (CLAUDE_PRICES.find(([re]) => re.test(model)) || [])[1] || null;

// Anthropic / Bedrock / Vertex ids -> the dotted form Copilot uses, so the same model shares one row
// (claude-opus-4-8-20260301 -> claude-opus-4.8, claude-3-5-haiku-20241022 -> claude-haiku-3.5).
function normalizeClaudeModel(id) {
  let m = String(id || '').toLowerCase().trim()
    .replace(/^(?:[a-z]{2,4}\.)?anthropic[./]/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-(?:latest|\d{8})$/, '');
  let x;
  if ((x = m.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/))) m = `claude-${x[1]}-${x[2]}.${x[3]}`;
  else if ((x = m.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/))) m = `claude-${x[3]}-${x[1]}.${x[2]}`;
  else if ((x = m.match(/^claude-(\d+)-(opus|sonnet|haiku)$/))) m = `claude-${x[2]}-${x[1]}`;
  return m;
}

function defaultClaudeDirs() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return [path.join(os.homedir(), '.config', 'claude'), path.join(os.homedir(), '.claude')];
}

function listJsonl(dir, out = [], diag) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') diag.errors.push(`Claude Code projects ${dir}: ${e.message}`);
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out, diag);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function readClaudeTranscript(file) {
  const entries = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o && o.message;
    const u = msg && msg.usage;
    if (!u || typeof u !== 'object' || o.isApiErrorMessage || (o.type && o.type !== 'assistant')) continue;
    if (typeof msg.model !== 'string' || !msg.model.trim() || msg.model === '<synthetic>') continue;
    const cacheWrite = nonNegativeNumber(u.cache_creation_input_tokens);
    const cacheWrite1h = Math.min(cacheWrite, nonNegativeNumber(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
    entries.push({
      key: msg.id ? `${msg.id}:${o.requestId || ''}` : null,
      ts: Date.parse(o.timestamp),
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      model: msg.model,
      input: nonNegativeNumber(u.input_tokens),
      output: nonNegativeNumber(u.output_tokens),
      cacheRead: nonNegativeNumber(u.cache_read_input_tokens),
      cacheWrite,
      cacheWrite1h,
      costUSD: Number.isFinite(o.costUSD) ? o.costUSD : null,
    });
  }
  return entries;
}

async function readClaudeCode(dirs, win, totals, diag, copilotSessionIds) {
  const seenDirs = new Set();
  // Streaming writes several lines per assistant message and resumed sessions copy earlier messages into a new
  // file, so each message (id + requestId) is counted once, keeping its most complete usage.
  const best = new Map();
  const unkeyed = [];
  for (const dir of dirs) {
    const projects = path.resolve(dir, 'projects');
    if (seenDirs.has(projects.toLowerCase()) || !fs.existsSync(projects)) continue;
    seenDirs.add(projects.toLowerCase());
    for (const f of listJsonl(projects, [], diag)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < win.start.getTime()) continue;
      try {
        const entries = await cachedParse(f, st, () => readClaudeTranscript(f));
        diag.claudeFiles += 1;
        for (const e of entries) {
          if (!inWindow(e.ts, win)) continue;
          if (e.sessionId && copilotSessionIds.has(e.sessionId)) { diag.claudeSkippedCopilotSessions += 1; continue; }
          if (!e.key) { unkeyed.push(e); continue; }
          const prev = best.get(e.key);
          const size = (x) => x.input + x.output + x.cacheRead + x.cacheWrite;
          if (prev) diag.claudeDuplicates += 1;
          if (!prev || size(e) > size(prev)) best.set(e.key, e);
        }
      } catch (err) {
        diag.errors.push(`claude transcript ${path.basename(f)}: ${err.message}`);
      }
    }
  }
  const unpriced = new Set();
  for (const e of [...best.values(), ...unkeyed]) {
    const model = normalizeClaudeModel(e.model);
    const p = claudePrice(model);
    let credits = 0;
    if (e.costUSD !== null && e.costUSD > 0) credits = e.costUSD * 100;
    else if (p) {
      credits = (e.input * p.input + e.cacheRead * p.cacheRead + (e.cacheWrite - e.cacheWrite1h) * p.cacheWrite5m
        + e.cacheWrite1h * p.cacheWrite1h + e.output * p.output) / 1e6 * 100;
    } else unpriced.add(model);
    totals.addExact(model, {
      calls: 1,
      inputTokens: e.input + e.cacheRead + e.cacheWrite,
      outputTokens: e.output,
      cacheReadTokens: e.cacheRead,
      cacheWriteTokens: e.cacheWrite,
      credits,
    }, 'claude');
    diag.claudeMessages += 1;
    diag.claudeCredits += credits;
  }
  if (unpriced.size) diag.notes.push(`no list price for: ${[...unpriced].join(', ')} (tokens counted, credits 0)`);
}

async function aggregateUsage(opts = {}) {
  if (opts.provider !== undefined && opts.provider !== 'githubCopilot' && opts.provider !== 'claudeCode') {
    throw new Error('Unsupported chat provider');
  }
  const t0 = Date.now();
  runId += 1;
  const win = billingCycle(opts.now || new Date(), opts.resetDay || 1);
  const provider = opts.provider === 'claudeCode' ? 'claudeCode' : opts.provider === 'githubCopilot' ? 'githubCopilot' : null;
  const includeGitHubCopilot = provider ? provider === 'githubCopilot' : opts.includeGitHubCopilot !== false;
  const includeClaudeCode = provider ? provider === 'claudeCode' : opts.includeClaudeCode !== false;
  const copilotHome = opts.copilotHome || process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const userDirs = opts.vscodeUserDirs || defaultVSCodeUserDirs();
  const claudeDirs = includeClaudeCode ? (opts.claudeDirs && opts.claudeDirs.length ? opts.claudeDirs : defaultClaudeDirs()) : [];
  const totals = new Totals();
  const sessions = new Map();
  const diag = {
    cliRows: 0, sessionDirsScanned: 0, backfilledSessions: 0, straddlingRuns: 0, reconciledSessions: 0, pendingCalls: 0,
    cliSessionCredits: 0, estimatedCredits: 0, vscodeSessionFiles: 0, vscodeDuplicateFiles: 0, vscodeDuplicateRequests: 0,
    vscodeInvalidNumbers: 0, vscodeOtherProviderSessions: 0, vscodeRequests: 0,
    vscodeCredits: 0, vscodeAgentHostSkipped: 0, claudeFiles: 0, claudeMessages: 0, claudeDuplicates: 0,
    claudeSkippedCopilotSessions: 0, claudeCredits: 0, notes: [], errors: [], timings: {},
  };

  // Each source is isolated so one unreadable store cannot discard the others.
  let indexed = new Map();
  let ts = Date.now();
  let db = null;
  if (includeGitHubCopilot) {
    db = openStore(copilotHome, diag);
    try {
      try { indexed = readCopilotStore(db, win, totals, sessions, diag); } catch (e) { diag.errors.push(`session store: ${e.message}`); }
      try { await scanSessionState(db, copilotHome, win, indexed, totals, sessions, diag, !!opts.validate); } catch (e) { diag.errors.push(`session-state: ${e.message}`); }
    } finally {
      if (db) db.close();
    }
  }
  diag.timings.copilotMs = Date.now() - ts; ts = Date.now();
  // Suppress an agent-host chat record only when its *matching session* has authoritative DB/shutdown metrics
  // or a checkpoint in this cycle. A global "some CLI data exists" flag drops unrelated chat records, while
  // ignoring checkpoint-only live sessions counts the same usage again during reconciliation.
  const coveredCliSessionIds = new Set([...sessions]
    .filter(([, sess]) => sess.exact.size > 0 || sess.points.some((p) => inWindow(p.ts, win)))
    .map(([id]) => id));
  if (includeGitHubCopilot) {
    try { await readVSCodeChat(userDirs, win, totals, diag, coveredCliSessionIds); } catch (e) { diag.errors.push(`vscode chat: ${e.message}`); }
  }
  diag.timings.vscodeMs = Date.now() - ts; ts = Date.now();
  if (includeClaudeCode) {
    try { await readClaudeCode(claudeDirs, win, totals, diag, new Set([...sessions.keys(), ...indexed.keys()])); } catch (e) { diag.errors.push(`claude code: ${e.message}`); }
  }
  diag.timings.claudeMs = Date.now() - ts; ts = Date.now();
  if (includeGitHubCopilot) reconcileSessions(sessions, win, totals, diag);
  diag.timings.reconcileMs = Date.now() - ts;
  pruneCache();
  diag.cachedFiles = fileCache.size;

  const sortBy = opts.sortBy === 'credits' ? 'credits' : 'tokens';
  const models = [...totals.byModel.values()]
    .map(({ cliCalls, cliCredits, cliTokens, ...b }) => ({
      ...b,
      sources: [...b.sources].sort(),
      exactTokens: b.inputTokens + b.outputTokens,
      totalTokens: b.inputTokens + b.outputTokens + b.estTokens,
      totalCredits: b.credits + b.estCredits,
    }))
    .sort((a, b) => (sortBy === 'credits' ? b.totalCredits - a.totalCredits : b.totalTokens - a.totalTokens) || b.pendingCalls - a.pendingCalls);
  const sum = (k) => models.reduce((s, m) => s + m[k], 0);
  const byTool = {};
  for (const m of models) for (const [tool, c] of Object.entries(m.byTool)) byTool[tool] = (byTool[tool] || 0) + c;
  diag.elapsedMs = Date.now() - t0;
  return {
    provider: provider || (includeGitHubCopilot && includeClaudeCode ? 'all' : includeClaudeCode ? 'claudeCode' : 'githubCopilot'),
    cycle: { start: win.start.toISOString(), end: win.end.toISOString() },
    sortBy,
    models,
    totals: {
      totalTokens: sum('totalTokens'), exactTokens: sum('exactTokens'), estTokens: sum('estTokens'),
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      totalCredits: sum('totalCredits'), exactCredits: sum('credits'), estCredits: sum('estCredits'),
      premiumRequests: sum('premiumRequests'), calls: sum('calls'), pendingCalls: sum('pendingCalls'),
      byTool,
    },
    diagnostics: diag,
  };
}

module.exports = { aggregateUsage, billingCycle, normalizeModel, normalizeClaudeModel, claudePrice, replayChatSession };

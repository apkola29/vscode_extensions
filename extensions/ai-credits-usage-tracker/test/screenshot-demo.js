'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEMO_ACCOUNT = 'demo-user';
const DEMO_MODELS = [
  { model: 'claude-opus-5.5', input: 3000000, output: 100000, credits: 1200 },
  { model: 'gpt-6.1-sol', input: 2000000, output: 50000, credits: 800 },
  { model: 'claude-sonnet-5.5', input: 1000000, output: 30000, credits: 300 },
  { model: 'gemini-3.8-flash', input: 500000, output: 15000, credits: 150 },
  { model: 'gpt-5-mini', input: 300000, output: 10000, credits: 50 },
];

// Synthetic Claude Code transcript messages (Anthropic model ids as written to ~/.claude/projects), priced by the tracker.
const DEMO_CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', model: 'claude-sonnet-5.5', messages: 300, input: 1500, output: 2000, cacheRead: 150000, cacheWrite: 5000 },
  { id: 'claude-opus-5-5', model: 'claude-opus-5.5', messages: 120, input: 1200, output: 1800, cacheRead: 90000, cacheWrite: 4000 },
  { id: 'claude-haiku-4-5-20251001', model: 'claude-haiku-4.5', messages: 200, input: 800, output: 900, cacheRead: 40000, cacheWrite: 2000 },
  { id: 'claude-sonnet-4-5-20250929', model: 'claude-sonnet-4.5', messages: 30, input: 1000, output: 1500, cacheRead: 60000, cacheWrite: 3000 },
];

function writeDemoClaudeTranscript(claudeHome, now) {
  const project = path.join(claudeHome, 'projects', 'demo-project');
  fs.mkdirSync(project, { recursive: true });
  const lines = [];
  let index = 0;
  for (const spec of DEMO_CLAUDE_MODELS) {
    for (let n = 0; n < spec.messages; n++) {
      index += 1;
      lines.push(JSON.stringify({
        type: 'assistant',
        sessionId: 'demo-claude-session',
        requestId: `demo-request-${index}`,
        timestamp: new Date(now.getTime() - 1000 - index * 10).toISOString(),
        message: {
          id: `demo-message-${index}`,
          role: 'assistant',
          model: spec.id,
          usage: {
            input_tokens: spec.input,
            output_tokens: spec.output,
            cache_read_input_tokens: spec.cacheRead,
            cache_creation_input_tokens: spec.cacheWrite,
            cache_creation: { ephemeral_5m_input_tokens: spec.cacheWrite, ephemeral_1h_input_tokens: 0 },
          },
        },
      }));
    }
  }
  fs.writeFileSync(path.join(project, 'demo-claude-session.jsonl'), `${lines.join('\n')}\n`);
}

// Synthetic Copilot and Claude Code stores plus an isolated profile's settings. Used for documentation captures and
// for exercising an exact packaged VSIX; nothing here touches the real user's data or GitHub account.
function prepareSyntheticStores(tmp, userData, now = new Date()) {
  const copilotHome = path.join(tmp, 'demo-copilot');
  const claudeHome = path.join(tmp, 'demo-claude');
  fs.mkdirSync(copilotHome);
  fs.mkdirSync(claudeHome);
  const db = new DatabaseSync(path.join(copilotHome, 'session-store.db'));
  try {
    db.exec(`CREATE TABLE assistant_usage_events (
      session_id TEXT, model TEXT, initiator TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT
    )`);
    const insert = db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const item of DEMO_MODELS) {
      insert.run('demo-session', item.model, 'user', item.input, item.output, 0, 0, 0,
        item.credits * 1e9, 1, now.toISOString());
    }
  } finally { db.close(); }
  writeDemoClaudeTranscript(claudeHome, now);
  const user = path.join(userData, 'User');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
    'aiUsageCreditsMeter.provider': 'both',
    'aiUsageCreditsMeter.sortBy': 'credits',
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'window.zoomLevel': 0,
    'workbench.tips.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
  }, null, 2));
  return { copilotHome, claudeHome };
}

function prepareScreenshotDemo(tmp, source, userData, now = new Date()) {
  const demoExtension = path.join(tmp, 'demo-extension');
  fs.mkdirSync(demoExtension);
  for (const entry of ['package.json', 'extension.js', 'lib', 'media']) {
    fs.cpSync(path.join(source, entry), path.join(demoExtension, entry), { recursive: true });
  }
  const stores = prepareSyntheticStores(tmp, userData, now);

  // This substitution exists only in a disposable development copy. No real GitHub authentication provider,
  // credential, account label, or user store is accessed while creating the public documentation images.
  fs.writeFileSync(path.join(demoExtension, 'lib', 'github-identity.js'), `'use strict';
module.exports = {
  githubIdentity: async () => ({ status: 'signedIn', id: 'demo-account', label: ${JSON.stringify(DEMO_ACCOUNT)} }),
  connectGitHub: async () => { throw new Error('Account changes are disabled in screenshot-only demo mode'); },
};\n`);
  return { demoExtension, ...stores };
}

module.exports = { DEMO_ACCOUNT, DEMO_MODELS, DEMO_CLAUDE_MODELS, prepareSyntheticStores, prepareScreenshotDemo };

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

function prepareScreenshotDemo(tmp, source, userData, now = new Date()) {
  const demoExtension = path.join(tmp, 'demo-extension');
  const copilotHome = path.join(tmp, 'demo-copilot');
  const claudeHome = path.join(tmp, 'demo-claude');
  fs.mkdirSync(demoExtension);
  fs.mkdirSync(copilotHome);
  fs.mkdirSync(claudeHome);
  for (const entry of ['package.json', 'extension.js', 'lib', 'media']) {
    fs.cpSync(path.join(source, entry), path.join(demoExtension, entry), { recursive: true });
  }
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

  // This substitution exists only in a disposable development copy. No real GitHub authentication provider,
  // credential, account label, or user store is accessed while creating the public documentation images.
  fs.writeFileSync(path.join(demoExtension, 'lib', 'github-identity.js'), `'use strict';
module.exports = {
  githubIdentity: async () => ({ status: 'signedIn', id: 'demo-account', label: ${JSON.stringify(DEMO_ACCOUNT)} }),
  connectGitHub: async () => { throw new Error('Account changes are disabled in screenshot-only demo mode'); },
};\n`);
  const user = path.join(userData, 'User');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
    'aiUsageCreditsMeter.provider': 'githubCopilot',
    'aiUsageCreditsMeter.sortBy': 'credits',
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'window.zoomLevel': 0,
    'workbench.tips.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
  }, null, 2));
  return { demoExtension, copilotHome, claudeHome };
}

module.exports = { DEMO_ACCOUNT, DEMO_MODELS, prepareScreenshotDemo };

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('public manifest contains approved attribution and a real open-source license', () => {
  assert.equal(manifest.publisher, 'apkola29');
  assert.equal(manifest.author, 'apkola29');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.repository.url, 'https://github.com/apkola29/vscode_extensions.git');
  assert.equal(manifest.repository.directory, 'extensions/ai-credits-usage-tracker');
  assert.equal(manifest.displayName, 'AI Credits Usage Tracker');
  assert.equal(manifest.name, 'ai-usage-credits-meter', 'existing Marketplace installs keep their extension identity');
  assert.match(manifest.description, /GitHub Copilot usage/);
  assert.match(manifest.description, /Claude Code/);
  for (const keyword of ['copilot', 'github-copilot', 'claude-code']) {
    assert.ok(manifest.keywords.includes(keyword), `the name no longer says Copilot, so "${keyword}" stays a search keyword`);
  }
  assert.doesNotMatch(manifest.description, /https?:\/\/|github\.com/i, 'repository links belong in dedicated metadata, not the short description');
  assert.ok(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('MIT License'));
});

test('Marketplace icon is original PNG rather than an unsupported SVG', () => {
  assert.equal(manifest.icon, 'media/icon.png');
  const icon = fs.readFileSync(path.join(root, manifest.icon));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
});

test('VSIX packaging is allowlisted and cannot pick up local tests, profiles or credentials', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(ignore, [
    '**', '!package.json', '!README.md', '!CHANGELOG.md', '!LICENSE', '!extension.js', '!lib/**', '!media/**',
  ]);
  assert.equal(manifest.enabledApiProposals, undefined);
  assert.equal(manifest.contributes.viewsContainers, undefined);
  assert.equal(manifest.contributes.menus['chat/input/status'], undefined);
  assert.equal(manifest.contributes.configuration.properties['aiUsageCreditsMeter.provider'].default, 'both');
  assert.deepEqual(manifest.contributes.configuration.properties['aiUsageCreditsMeter.provider'].enum, ['both', 'githubCopilot', 'claudeCode']);
});

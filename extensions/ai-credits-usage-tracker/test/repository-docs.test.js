'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { aggregateUsage, claudePrice } = require('../lib/aggregate');
const { DEMO_ACCOUNT, DEMO_MODELS, DEMO_CLAUDE_MODELS, prepareScreenshotDemo } = require('./screenshot-demo');

const project = path.resolve(__dirname, '..');
const repository = path.resolve(project, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));

test('both extension projects have independent README, license, changelog and correct monorepo metadata', () => {
  const landing = fs.readFileSync(path.join(repository, 'README.md'), 'utf8');
  for (const directory of ['agent-keep-awake', 'ai-credits-usage-tracker']) {
    const root = path.join(repository, 'extensions', directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
      assert.ok(fs.statSync(path.join(root, file)).isFile(), `${directory}/${file}`);
    }
    assert.equal(pkg.repository.url, 'https://github.com/apkola29/vscode_extensions.git');
    assert.equal(pkg.repository.directory, `extensions/${directory}`);
    assert.doesNotMatch(pkg.description, /https?:\/\/|github\.com/i);
    assert.ok(landing.includes(`extensions/${directory}/README.md`), `root README links ${directory}`);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8').split(/\r?\n/, 1)[0], `# ${pkg.displayName}`);
  }
  assert.ok(landing.includes('## Repository structure'));
});

test('the Marketplace README clearly describes GitHub Copilot usage and compatible extension identity', () => {
  const readme = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
  assert.equal(readme.split(/\r?\n/, 1)[0], `# ${manifest.displayName}`);
  assert.match(readme, /Track your GitHub Copilot usage by model/);
  assert.match(readme, /Copilot Chat in VS Code, Copilot agent sessions, the Copilot SDK, and Copilot CLI/);
  assert.match(readme, /not an official GitHub product or an account-wide billing report/);
  assert.ok(readme.includes(`apkola29.${manifest.name}`));
  assert.ok(readme.includes(`ai-usage-credits-meter-${manifest.version}.vsix`));
  assert.ok(readme.includes('https://marketplace.visualstudio.com/items?itemName=apkola29.ai-usage-credits-meter'));
});

test('the READMEs explain how Claude Code usage appears, what it measures and what it cannot show', () => {
  const readme = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
  const landing = fs.readFileSync(path.join(repository, 'README.md'), 'utf8');
  assert.match(readme, /## Claude Code usage/);
  assert.match(readme, /Claude Code extension for VS Code/);
  assert.match(readme, /API list-price/);
  assert.match(readme, /subscription (charge|limit)/i);
  assert.match(readme, /Remote|WSL/);
  assert.match(readme, /lower bound/);
  assert.match(readme, /best-effort/);
  assert.match(readme, /~\/\.claude\/projects/);
  assert.match(readme, /30 days/);
  assert.match(readme, /`both`/);
  assert.match(landing, /Claude Code/);
});

test('public overview pages do not link to missing local documentation or excluded private notes', () => {
  const overviews = [
    'README.md', 'PRIVACY.md', 'SECURITY.md', 'PUBLISHING.md',
    path.join('extensions', 'agent-keep-awake', 'README.md'),
    path.join('extensions', 'ai-credits-usage-tracker', 'README.md'),
  ];
  for (const file of overviews) {
    const absolute = path.join(repository, file);
    const text = fs.readFileSync(absolute, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z\d+.-]*:|^#/i.test(href)) continue;
      const target = path.resolve(path.dirname(absolute), decodeURIComponent(href.split('#')[0]));
      assert.ok(!path.relative(repository, target).startsWith('..'), `${file}: link leaves the repository`);
      assert.ok(fs.existsSync(target), `${file}: missing link target ${href}`);
      assert.doesNotMatch(href, /IMPLEMENTATION_PLAN|PROGRESS\.md|FEASIBILITY\.md/);
    }
  }
});

test('documentation screenshots are bounded PNGs without text, account or EXIF metadata', () => {
  const screenshots = path.join(project, 'media', 'screenshots');
  const names = ['status-bar.png', 'usage-hover.png', 'usage-popup.png'];
  assert.deepEqual(fs.readdirSync(screenshots).sort(), [...names].sort());
  for (const name of names) {
    const png = fs.readFileSync(path.join(screenshots, name));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.readUInt32BE(16) >= 100 && png.readUInt32BE(16) <= 2048);
    assert.ok(png.readUInt32BE(20) >= 20 && png.readUInt32BE(20) <= 1200);
    let offset = 8;
    const chunks = [];
    while (offset < png.length) {
      assert.ok(offset + 12 <= png.length, `${name}: incomplete PNG chunk`);
      const size = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      assert.ok(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type),
        `${name}: unexpected metadata chunk ${type}`);
      assert.ok(offset + size + 12 <= png.length, `${name}: invalid PNG chunk size`);
      chunks.push(type);
      offset += size + 12;
    }
    assert.equal(chunks[0], 'IHDR');
    assert.equal(chunks.at(-1), 'IEND');
    assert.ok(chunks.includes('IDAT'));
    assert.equal(offset, png.length);
  }
  for (const file of [path.join(repository, 'README.md'), path.join(project, 'README.md')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /synthetic usage and a fictional demo account/);
    for (const name of names.filter((n) => file === path.join(project, 'README.md') || n !== 'status-bar.png')) {
      assert.match(text, new RegExp(`!\\[[^\\]]+\\]\\([^\\s)]+/${name.replace('.', '\\.')}\\)`));
    }
  }
});

test('screenshot fixtures read only isolated synthetic usage and never change the released identity module', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-screenshot-fixture-'));
  const identityPath = path.join(project, 'lib', 'github-identity.js');
  const productionIdentity = fs.readFileSync(identityPath, 'utf8');
  try {
    const userData = path.join(tmp, 'user-data');
    const now = new Date('2026-10-14T12:00:00Z');
    const demo = prepareScreenshotDemo(tmp, project, userData, now);
    for (const directory of Object.values(demo)) {
      assert.ok(!path.relative(tmp, directory).startsWith('..'));
    }
    const summary = await aggregateUsage({
      now,
      provider: 'both',
      copilotHome: demo.copilotHome,
      vscodeUserDirs: [path.join(userData, 'User')],
      claudeDirs: [demo.claudeHome],
      sortBy: 'credits',
    });
    const copilot = summary.githubCopilot;
    assert.deepEqual(copilot.models.map((m) => m.model), DEMO_MODELS.map((m) => m.model));
    assert.deepEqual(copilot.models.map((m) => m.totalCredits), DEMO_MODELS.map((m) => m.credits));
    assert.equal(copilot.totals.totalCredits, 2500);
    assert.equal(copilot.diagnostics.cliRows, DEMO_MODELS.length);
    assert.equal(copilot.diagnostics.vscodeRequests, 0);
    assert.deepEqual(copilot.diagnostics.errors, []);

    const claude = summary.claudeCode;
    const priced = (spec) => {
      const price = claudePrice(spec.model);
      return spec.messages * (spec.input * price.input + spec.cacheRead * price.cacheRead
        + spec.cacheWrite * price.cacheWrite5m + spec.output * price.output) / 1e6 * 100;
    };
    assert.deepEqual(claude.models.map((m) => m.model), DEMO_CLAUDE_MODELS.map((m) => m.model));
    DEMO_CLAUDE_MODELS.forEach((spec, index) => {
      assert.ok(Math.abs(claude.models[index].totalCredits - priced(spec)) < 1e-6, `${spec.model} API value`);
      assert.equal(claude.models[index].totalTokens, spec.messages * (spec.input + spec.output + spec.cacheRead + spec.cacheWrite));
      assert.equal(claude.models[index].calls, spec.messages);
    });
    assert.equal(claude.diagnostics.claudeSkippedCopilotSessions, 0);
    assert.deepEqual(claude.diagnostics.errors, []);
    assert.deepEqual(claude.diagnostics.notes, []);
    const identity = require(path.join(demo.demoExtension, 'lib', 'github-identity.js'));
    assert.deepEqual(await identity.githubIdentity(), { status: 'signedIn', id: 'demo-account', label: DEMO_ACCOUNT });
    await assert.rejects(identity.connectGitHub(), /disabled in screenshot-only demo mode/);
    assert.equal(fs.readFileSync(identityPath, 'utf8'), productionIdentity);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

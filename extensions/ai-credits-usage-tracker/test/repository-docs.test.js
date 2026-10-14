'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

'use strict';
// Integration test against the installed VS Code, in an isolated throwaway profile.
//   node test/run.js                 -> loads this folder as a development extension
//   node test/run.js --vsix <file>   -> installs the packaged .vsix and tests exactly what ships
//   add --agents                     -> run the same test in VS Code's Agents/Sessions window
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codeExe = process.env.VSCODE_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const codeCli = path.join(path.dirname(codeExe), 'bin', 'code.cmd');
const vsixArg = process.argv.indexOf('--vsix');
const vsix = vsixArg > 0 ? path.resolve(process.argv[vsixArg + 1]) : null;
const agentsMode = process.argv.includes('--agents');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aucm-test-'));
const userData = path.join(tmp, 'user-data');
const extsDir = path.join(tmp, 'extensions');
const resultFile = path.join(tmp, 'result.json');

const env = { ...process.env, AUCM_TEST_OUT: resultFile };
env.AUCM_SOURCE_DIR = path.resolve(__dirname, '..');
for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) delete env[k];

let devPath = path.resolve(__dirname, '..');
let testsPath = path.join(__dirname, 'suite.js');
if (vsix) {
  const q = (s) => `"${s}"`;
  const install = [codeCli, '--user-data-dir', userData, '--extensions-dir', extsDir, '--install-extension', vsix, '--force'].map(q).join(' ');
  const res = cp.spawnSync(install, { env, shell: true, encoding: 'utf8' });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); process.exit(1); }
  if (agentsMode) {
    // The Agents/Sessions window uses a separate profile registry and ignores user extensions installed into
    // this throwaway profile. Load the exact extracted VSIX directory as the development extension instead;
    // the files are still byte-for-byte what the package installed.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const installed = fs.readdirSync(extsDir).find((name) => name.startsWith(`${manifest.publisher}.${manifest.name}-`));
    if (!installed) { console.error('packaged extension was not extracted'); process.exit(1); }
    devPath = path.join(extsDir, installed);
    testsPath = path.join(devPath, '.integration-suite.js');
    fs.copyFileSync(path.join(__dirname, 'suite.js'), testsPath);
  } else {
    // An empty runner extension hosts the tests so `require('vscode')` resolves to a known extension.
    devPath = path.join(tmp, 'runner');
    fs.mkdirSync(devPath);
    fs.writeFileSync(path.join(devPath, 'package.json'), JSON.stringify({ name: 'aucm-test-runner', publisher: 'test', version: '0.0.0', engines: { vscode: '*' } }));
    testsPath = path.join(devPath, 'suite.js');
    fs.copyFileSync(path.join(__dirname, 'suite.js'), testsPath);
  }
}

const args = [
  `--extensionDevelopmentPath=${devPath}`,
  `--extensionTestsPath=${testsPath}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${extsDir}`,
  '--disable-extension', 'GitHub.copilot-chat',
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window',
];
if (agentsMode) args.push('--agents');

const walk = (dir, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else if (e.name.endsWith('.log')) acc.push(p);
  }
  return acc;
};

const child = cp.spawn(codeExe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
child.stdout.on('data', (d) => { tail = (tail + d).slice(-4000); });
child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
const timer = setTimeout(() => { console.error('timeout: killing VS Code test instance'); child.kill(); }, 240000);
child.on('exit', (exitCode) => {
  clearTimeout(timer);
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  const ours = walk(path.join(userData, 'logs'))
    .flatMap((f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => `${path.basename(f)}: ${l}`))
    .filter((l) => /ai-usage-credits-meter|aiUsageCreditsMeter|chat\/input\/status/i.test(l));
  const problems = ours.filter((l) => /\[(warning|error)\]/i.test(l));
  const passed = exitCode === 0 && !!result && result.ok && problems.length === 0;
  console.log(JSON.stringify({ passed, mode: `${vsix ? 'vsix' : 'development'}${agentsMode ? '-agents' : ''}`, exitCode, result, logProblems: problems, processTail: result ? undefined : tail }, null, 2));
  if (passed) {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { console.error(`test passed; deferred cleanup for locked directory ${tmp}`); }
  } else console.error(`artifacts kept in ${tmp}`);
  process.exit(passed ? 0 : 1);
});

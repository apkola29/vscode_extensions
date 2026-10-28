#!/usr/bin/env node
'use strict';
// Usage: node scripts/cli.js [--provider both|githubCopilot|claudeCode] [--sort tokens|credits] [--validate] [--json] [--reset-day N]
const { aggregateUsage } = require('../lib/aggregate');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
// Names come from files on disk; terminal control characters must never reach the console.
const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

function print(r) {
  console.log(`GH Copilot Usage Tracker · ${r.provider} · billing cycle (UTC): ${r.cycle.start.slice(0, 10)} -> ${r.cycle.end.slice(0, 10)} · sorted by ${r.sortBy} (≈ = includes estimate)`);
  if (r.provider === 'claudeCode') console.log('Claude Code credits are API list-price estimates from local transcripts, not subscription charges or limits.');
  console.log('rank  model                 tokens  (exact | est)        output    credits (exact | est)       ~USD  calls pending  by tool');
  r.models.forEach((m, i) => {
    const approx = m.estCredits > 0.5 ? '≈' : ' ';
    const tools = Object.entries(m.byTool).filter(([, c]) => c > 0.005).map(([t, c]) => `${t} ${fmt(c)}`).join(', ');
    console.log([
      String(i + 1).padStart(4), ' ', plain(m.model).padEnd(20),
      `${approx}${fmt(m.totalTokens)}`.padStart(9), `(${fmt(m.exactTokens)} | ${fmt(m.estTokens)})`.padEnd(17),
      fmt(m.outputTokens).padStart(8),
      `${approx}${Math.round(m.totalCredits)}`.padStart(9), `(${Math.round(m.credits)} | ${Math.round(m.estCredits)})`.padEnd(16),
      `$${(m.totalCredits / 100).toFixed(2)}`.padStart(9), String(m.calls).padStart(6), String(m.pendingCalls).padStart(7), ' ', tools,
    ].join(' '));
  });
  const t = r.totals;
  console.log(`TOTAL ≈${fmt(t.totalTokens)} tokens (exact ${fmt(t.exactTokens)}, est ${fmt(t.estTokens)}); ${t.estCredits > 0.5 ? '≈' : ''}${Math.round(t.totalCredits)} credits (exact ${Math.round(t.exactCredits)}, est ${Math.round(t.estCredits)}) ≈ $${(t.totalCredits / 100).toFixed(2)}; ${t.calls} calls; ${t.pendingCalls} calls since last checkpoint`);
  console.log('by tool: ' + Object.entries(t.byTool).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${Math.round(c)} credits`).join(' · '));
  console.log('diagnostics:', JSON.stringify(r.diagnostics));
}

(async () => {
  const result = await aggregateUsage({
    provider: value('--provider', 'both'),
    sortBy: value('--sort', 'tokens'), validate: flag('--validate'), resetDay: Number(value('--reset-day', 1)),
  });
  if (flag('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  const sections = result.provider === 'both' ? [result.githubCopilot, result.claudeCode] : [result];
  sections.forEach((section, index) => {
    if (index > 0) console.log('');
    if (result.provider === 'both' && section.provider === 'claudeCode'
      && !section.diagnostics.claudeTranscripts && !section.diagnostics.errors.length) {
      console.log('Claude Code · no local transcripts found');
      return;
    }
    print(section);
  });
})().catch((e) => { console.error(e); process.exit(1); });

// @ts-check
'use strict';

/**
 * Asks the operating system which power requests are in effect. Shared by the OS verification
 * script and the VS Code integration tests.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * @param {string} file
 * @param {string[]} args
 */
function run(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', SYSTEMD_COLORS: '0' }
  });
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

function isWindowsAdmin() {
  return /True/.test(run(PS, ['-NoProfile', '-NonInteractive', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']));
}

// CallNtPowerInformation(SystemExecutionState = 16) works without admin rights.
const WIN_QUERY = [
  "$b=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly((New-Object Reflection.AssemblyName('Q')),[Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "$t=$b.DefineDynamicModule('Q').DefineType('Q.N','Public,Abstract,Sealed')",
  "$m=[Reflection.MethodAttributes]'Public,Static,PinvokeImpl,HideBySig'",
  "$t.DefinePInvokeMethod('CallNtPowerInformation','powrprof.dll',$m,[Reflection.CallingConventions]::Standard,[int],[Type[]]@([int],[IntPtr],[int],[IntPtr],[int]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Auto).SetImplementationFlags('PreserveSig')",
  '$n=$t.CreateType()',
  '$p=[Runtime.InteropServices.Marshal]::AllocHGlobal(4)',
  '$s=$n::CallNtPowerInformation(16,[IntPtr]::Zero,0,$p,4)',
  "[Console]::Out.WriteLine(('{0} {1}' -f $s,[uint32][Runtime.InteropServices.Marshal]::ReadInt32($p)))"
].join(';');

/**
 * @param {number[]} [pids] Omit for a global baseline; provide for helper-specific checks.
 * Windows reports machine-wide state even when PIDs are provided.
 * @returns {{ system: boolean, display: boolean, raw: string }}
 */
function probe(pids = []) {
  if (process.platform === 'win32') {
    const out = run(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WIN_QUERY]).trim();
    const match = /^0\s+(\d+)$/.exec(out);
    const value = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(value) || value > 0xffffffff) {
      throw new Error(`OS execution-state query failed: ${out}`);
    }
    return { system: (value & 1) !== 0, display: (value & 2) !== 0, raw: `SystemExecutionState=0x${value.toString(16).padStart(8, '0')}` };
  }
  if (process.platform === 'darwin') {
    const out = run('pmset', ['-g', 'assertions']);
    const lines = out.split(/\r?\n/).map(line => line.trim());
    const summaryIndex = lines.indexOf('Assertion status system-wide:');
    const ownersIndex = lines.indexOf('Listed by owning process:');
    if (summaryIndex < 0 || ownersIndex <= summaryIndex) {
      throw new Error('OS assertion query failed: missing pmset sections');
    }
    const summary = lines.slice(summaryIndex + 1, ownersIndex);
    /** @param {string} name */
    function readFlag(name) {
      const entries = summary.filter(entry => entry.split(/\s+/, 1)[0] === name);
      const match = entries.length === 1 && new RegExp(`^${name}\\s+(\\d+)$`).exec(entries[0]);
      if (!match || !Number.isSafeInteger(Number(match[1]))) {
        throw new Error(`OS assertion query failed: invalid ${name} status`);
      }
      return Number(match[1]) > 0;
    }
    const systemFlag = readFlag('PreventSystemSleep');
    const idleSystemFlag = readFlag('PreventUserIdleSystemSleep');
    const displayFlag = readFlag('PreventUserIdleDisplaySleep');
    const assertions = lines.slice(ownersIndex + 1).filter(line => /^pid\b/.test(line)).map(line => {
      const match = /^pid\s+(\d+)\(.+\):\s+\[0x[0-9a-fA-F]+\]\s+\d+(?::\d+){1,2}\s+(\S+)(?:\s|$)/.exec(line);
      const pid = match ? Number(match[1]) : NaN;
      if (!match || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
        throw new Error('OS assertion query failed: malformed owner assertion');
      }
      return { pid, type: match[2], raw: line };
    });
    if (!pids.length) {
      return {
        system: systemFlag || idleSystemFlag,
        display: displayFlag,
        raw: `pmset assertions: system=${Number(systemFlag || idleSystemFlag)}, display=${Number(displayFlag)}`
      };
    }
    const mine = assertions.filter(assertion => pids.includes(assertion.pid));
    return {
      system: mine.some(assertion => ['PreventSystemSleep', 'PreventUserIdleSystemSleep'].includes(assertion.type)),
      display: mine.some(assertion => assertion.type === 'PreventUserIdleDisplaySleep'),
      raw: mine.map(assertion => assertion.raw).join(' | ') || 'no assertions from helper'
    };
  }
  // Structured output avoids localized tables and UID/PID ambiguity.
  const out = run('busctl', [
    '--system', '--no-pager', '--json=short', 'call',
    'org.freedesktop.login1', '/org/freedesktop/login1',
    'org.freedesktop.login1.Manager', 'ListInhibitors'
  ]);
  /** @type {unknown} */
  let reply;
  try {
    reply = JSON.parse(out);
  } catch (error) {
    throw new Error('OS inhibitor query failed: invalid busctl JSON', { cause: error });
  }
  if (reply === null || typeof reply !== 'object' ||
    !('type' in reply) || reply.type !== 'a(ssssuu)' ||
    !('data' in reply) || !Array.isArray(reply.data) ||
    reply.data.length !== 1 || !Array.isArray(reply.data[0])) {
    throw new Error('OS inhibitor query failed: invalid logind reply');
  }
  const inhibitors = reply.data[0].map((/** @type {unknown} */ row) => {
    if (!Array.isArray(row) || row.length !== 6) {
      throw new Error('OS inhibitor query failed: invalid inhibitor record');
    }
    /** @type {unknown[]} */
    const values = row;
    const [what, who, why, mode, uid, pid] = values;
    if (typeof who !== 'string' || typeof why !== 'string' ||
      typeof what !== 'string' || typeof mode !== 'string' ||
      !['block', 'block-weak', 'delay', 'delay-weak'].includes(mode) ||
      typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0 || uid > 0xffffffff ||
      typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
      throw new Error('OS inhibitor query failed: malformed inhibitor fields');
    }
    const flags = what.split(':');
    if (flags.some(flag => !['shutdown', 'sleep', 'idle'].includes(flag) && !/^handle-[a-z]+(?:-[a-z]+)*$/.test(flag))) {
      throw new Error('OS inhibitor query failed: invalid inhibitor flags');
    }
    return { pid, mode, flags };
  });
  const mine = pids.length ? inhibitors.filter(inhibitor => pids.includes(inhibitor.pid)) : inhibitors;
  const blocking = mine.filter(inhibitor => inhibitor.mode === 'block' || inhibitor.mode === 'block-weak');
  return {
    system: blocking.some(inhibitor => inhibitor.flags.includes('sleep')),
    display: blocking.some(inhibitor => inhibitor.flags.includes('idle')),
    raw: mine.map(inhibitor => `pid ${inhibitor.pid}: ${inhibitor.flags.join(':')} (${inhibitor.mode})`).join(' | ') ||
      (pids.length ? 'no inhibitors from helper' : 'no inhibitors')
  };
}

/**
 * CPU seconds used so far and resident memory of a process.
 * @param {number} pid
 * @returns {{ cpu: number, rssMB: number }}
 */
function footprint(pid) {
  if (process.platform === 'win32') {
    const out = run(PS, ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${pid}; [Console]::Out.WriteLine(('{0} {1}' -f $p.TotalProcessorTime.TotalSeconds,($p.WorkingSet64/1MB)).Replace(',','.'))`]).trim();
    const [cpu, rss] = out.split(/\s+/).map(Number);
    return { cpu, rssMB: rss };
  }
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    return { cpu: ticks / 100, rssMB: (Number(fields[21]) * 4096) / 1048576 };
  }
  const out = run('ps', ['-o', 'rss=,time=', '-p', String(pid)]).trim();
  const [rssKb, time] = out.split(/\s+/);
  const cpu = time.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0);
  return { cpu, rssMB: Number(rssKb) / 1024 };
}

module.exports = { probe, footprint, isAlive, isWindowsAdmin, run };

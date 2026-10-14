// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { isAlive, run } = require('./probe');

/** @typedef {{pid: number, birth: string}} ProcessIdentity */
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** @param {number} pid @returns {ProcessIdentity | undefined} */
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid test process PID.');
  if (process.platform === 'win32') {
    const birth = run(PS, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){[Console]::Out.WriteLine($p.CreationDate.ToUniversalTime().Ticks.ToString())}else{[Console]::Out.WriteLine('NONE')}`
    ]).trim();
    if (birth === 'NONE') return undefined;
    if (!/^\d+$/.test(birth)) throw new Error('Invalid Windows process identity response.');
    return { pid, birth };
  }
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const birth = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!birth || !/^\d+$/.test(birth)) throw new Error('Invalid Linux process identity response.');
    return { pid, birth };
  }
  try {
    const birth = run('ps', ['-p', String(pid), '-o', 'lstart=,comm=']).trim().replace(/\s+/g, ' ');
    if (!birth) throw new Error('Invalid process identity response.');
    return { pid, birth };
  } catch (error) {
    if (!isAlive(pid)) return undefined;
    throw error;
  }
}

/** @param {ProcessIdentity} mark */
function stop(mark) {
  const current = identity(mark.pid);
  if (!current || current.birth !== mark.birth) return;
  if (process.platform === 'win32') {
    if (!/^\d+$/.test(mark.birth)) throw new Error('Invalid Windows birth marker.');
    run(PS, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${mark.pid}'; if($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq '${mark.birth}'){Stop-Process -Id ${mark.pid} -Force -ErrorAction Stop}`
    ]);
  } else {
    try {
      process.kill(mark.pid, 'SIGKILL');
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error;
    }
  }
}

/** Stop descendants of this dedicated test runner, never other editor instances. */
function stopChildren() {
  if (process.platform === 'win32') {
    run(PS, ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference='Stop'",
      'function Stop-Owned([int]$root,[DateTime]$birth){',
      '$parent=Get-CimInstance Win32_Process -Filter (\'ProcessId=\'+$root)',
      'if(!$parent -or $parent.CreationDate -ne $birth){return}',
      '$children=@(Get-CimInstance Win32_Process -Filter (\'ParentProcessId=\'+$root) | Where-Object {$_.ProcessId -ne $PID -and $_.CreationDate -ge $birth})',
      'foreach($child in $children){',
      'Stop-Owned $child.ProcessId $child.CreationDate',
      '$live=Get-CimInstance Win32_Process -Filter (\'ProcessId=\'+$child.ProcessId)',
      'if($live -and $live.ParentProcessId -eq $root -and $live.CreationDate -eq $child.CreationDate){',
      'try{Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop}catch{',
      '$remaining=Get-CimInstance Win32_Process -Filter (\'ProcessId=\'+$child.ProcessId)',
      'if($remaining -and $remaining.CreationDate -eq $child.CreationDate){throw}',
      '}',
      '}',
      '}',
      '}',
      `$runner=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'`,
      "if(!$runner){throw 'Test runner identity is unavailable'}",
      `Stop-Owned ${process.pid} $runner.CreationDate`
    ].join(';')]);
    return;
  }
  const rows = run('ps', ['-eo', 'pid=,ppid=']).trim().split(/\r?\n/).map(row => row.trim().split(/\s+/).map(Number));
  /** @type {Set<number>} */
  const seen = new Set([process.pid]);
  /** @type {ProcessIdentity[]} */
  const marks = [];
  /** @param {number} parent */
  const visit = parent => {
    for (const [pid, ppid] of rows) {
      if (ppid !== parent || seen.has(pid) || !Number.isSafeInteger(pid) || pid <= 0) continue;
      seen.add(pid);
      visit(pid);
      const mark = identity(pid);
      if (mark) marks.push(mark);
    }
  };
  visit(process.pid);
  for (const mark of marks) stop(mark);
}

module.exports = { identity, stop, stopChildren };

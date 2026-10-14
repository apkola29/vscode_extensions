param(
  [ValidateRange(60, 1200)]
  [int]$Seconds = 240
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This unattended idle test requires Windows.' }

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class AwakeIdleTestNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct LastInput { public UInt32 Size; public UInt32 Tick; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PowerStatus {
        public byte ACLineStatus, BatteryFlag, BatteryPercent, SaverFlag;
        public UInt32 BatteryLifeTime, BatteryFullLifeTime;
    }
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("kernel32.dll")] public static extern UInt32 GetTickCount();
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetSystemPowerStatus(out PowerStatus status);
    [DllImport("powrprof.dll")]
    public static extern UInt32 PowerGetActiveScheme(IntPtr key, out IntPtr scheme);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("powrprof.dll")]
    public static extern UInt32 PowerReadACValueIndex(IntPtr key, ref Guid scheme, ref Guid subgroup, ref Guid setting, out UInt32 value);
    [DllImport("powrprof.dll")]
    public static extern UInt32 PowerReadDCValueIndex(IntPtr key, ref Guid scheme, ref Guid subgroup, ref Guid setting, out UInt32 value);
    public static double IdleSeconds() {
        var info = new LastInput { Size = 8 };
        if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("GetLastInputInfo failed");
        return unchecked(GetTickCount() - info.Tick) / 1000.0;
    }
}
'@

$source = [AwakeIdleTestNative+PowerStatus]::new()
if (-not [AwakeIdleTestNative]::GetSystemPowerStatus([ref]$source)) {
  throw 'GetSystemPowerStatus failed.'
}
if ($source.ACLineStatus -ne 1) {
  throw 'INCONCLUSIVE: this long-run idle test requires AC power. Modern Standby battery policy may terminate power requests.'
}

$schemePointer = [IntPtr]::Zero
if ([AwakeIdleTestNative]::PowerGetActiveScheme([IntPtr]::Zero, [ref]$schemePointer) -ne 0) {
  throw 'Could not read the active power scheme.'
}
try {
  $scheme = [guid][Runtime.InteropServices.Marshal]::PtrToStructure($schemePointer, [type][guid])
} finally {
  [void][AwakeIdleTestNative]::LocalFree($schemePointer)
}
$sleepGroup = [guid]'238c9fa8-0aad-41ed-83f4-97be242c8f20'
$sleepSetting = [guid]'29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
$displayGroup = [guid]'7516b95f-f776-4464-8c53-06167f40cc99'
$displaySetting = [guid]'3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e'
[uint32]$sleepTimeout = 0
[uint32]$displayTimeout = 0
if ([AwakeIdleTestNative]::PowerReadACValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$sleepGroup, [ref]$sleepSetting, [ref]$sleepTimeout) -ne 0 -or
    [AwakeIdleTestNative]::PowerReadACValueIndex([IntPtr]::Zero, [ref]$scheme, [ref]$displayGroup, [ref]$displaySetting, [ref]$displayTimeout) -ne 0) {
  throw 'Could not read the existing idle policy.'
}
$requiredIdle = [Math]::Max($sleepTimeout, $displayTimeout)
if ($sleepTimeout -eq 0 -or $displayTimeout -eq 0 -or $Seconds -le $requiredIdle) {
  throw "INCONCLUSIVE: both idle policies must be finite and the test must exceed them. Sleep=$sleepTimeout, display=$displayTimeout, test=$Seconds seconds."
}

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$probePath = Join-Path $PSScriptRoot 'probe.js'
function Read-PowerState {
  $text = & $node -e 'console.log(JSON.stringify(require(process.argv[1]).probe()))' $probePath
  if ($LASTEXITCODE -ne 0) { throw 'Native power-state probe failed.' }
  $result = $text | ConvertFrom-Json
  if ($result.system -isnot [bool] -or $result.display -isnot [bool]) {
    throw 'Malformed native power-state result.'
  }
  return $result
}

$baseline = Read-PowerState
Write-Output "INFO baseline: $($baseline.raw); existing idle policy: sleep=$sleepTimeout, display=$displayTimeout seconds; AC power."
if ($baseline.system -or $baseline.display) {
  throw 'INCONCLUSIVE: another application already holds a system/display request. No idle-test helper was started; attribution requires a clean baseline.'
}
$program = @'
const {KeepAwake}=require(process.argv[1]);
const backend=new KeepAwake();
let announced=false;
backend.on('change',()=>{
  if(backend.state==='on'&&!announced){announced=true;console.log('READY '+JSON.stringify(backend.pids));}
  if(backend.state==='error'){console.error(backend.error);backend.dispose();process.exitCode=1;process.stdin.destroy();}
});
process.stdin.resume();
process.stdin.on('end',()=>backend.dispose());
backend.acquire({display:true});
'@
$startInfo = [Diagnostics.ProcessStartInfo]::new($node)
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.ArgumentList.Add('-e')
$startInfo.ArgumentList.Add($program)
$startInfo.ArgumentList.Add((Join-Path $root 'src\keepAwake.js'))
$owner = [Diagnostics.Process]::new()
$owner.StartInfo = $startInfo
$started = $false
$marks = @()
$checked = $false
$failure = $null
try {
  $started = $owner.Start()
  if (-not $started) { throw 'Could not start the dedicated idle-test owner.' }
  $ready = $owner.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(15000) -or $ready.Result -notlike 'READY *') {
    throw 'The dedicated idle-test helper did not acknowledge protection.'
  }
  $pids = $ready.Result.Substring(6) | ConvertFrom-Json
  foreach ($helperPid in $pids) {
    if ($helperPid -isnot [long] -and $helperPid -isnot [int]) { throw 'Invalid helper PID.' }
    $helper = Get-CimInstance Win32_Process -Filter "ProcessId=$helperPid"
    if (-not $helper) { throw 'The acknowledged idle-test helper is missing.' }
    $marks += @{ Pid = $helperPid; Birth = $helper.CreationDate }
  }
  if (-not $marks.Count) { throw 'The idle test acquired no helper.' }
  $held = Read-PowerState
  if (-not $held.system -or -not $held.display) { throw "Combined system/display hold was not measured: $($held.raw)" }
  $begin = Get-Date
  Write-Output "INFO combined protection acknowledged: $($held.raw). Idle soak begins $($begin.ToString('o')); no input is simulated."
  Start-Sleep -Seconds $Seconds
  $end = Get-Date
  $idle = [AwakeIdleTestNative]::IdleSeconds()
  $held = Read-PowerState
  $events = @()
  try {
    $events = @(Get-WinEvent -FilterHashtable @{
      LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power';
      Id = @(42, 506); StartTime = $begin; EndTime = $end
    } -MaxEvents 20)
  } catch {
    if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
  }
  if ($events.Count) {
    $events | Select-Object TimeCreated, Id, Message | Format-List | Out-Host
    throw 'FAILED: Windows entered sleep/Modern Standby during the active combined request.'
  }
  if ($idle -le $requiredIdle) {
    throw "INCONCLUSIVE: input was received during the test. Actual idle=$idle seconds, required>$requiredIdle."
  }
  if (-not $held.system -or -not $held.display -or $owner.HasExited) {
    throw 'FAILED: protection was no longer held after the unattended interval.'
  }
  $checked = $true
  Write-Output "PASS $Seconds-second unattended interval; actual idle=$idle seconds; no sleep/Modern Standby events; combined flags remained $($held.raw)."
} catch {
  $failure = $_.Exception
} finally {
  $cleanupErrors = [Collections.Generic.List[Exception]]::new()
  try {
    if ($started -and -not $owner.HasExited) {
      $owner.StandardInput.Close()
      if (-not $owner.WaitForExit(10000)) {
        $owner.Kill($true)
        [void]$owner.WaitForExit(5000)
        $cleanupErrors.Add([InvalidOperationException]::new('The dedicated idle-test owner did not exit normally; its owned tree was terminated.'))
      }
    }
  } catch {
    $cleanupErrors.Add($_.Exception)
  }
  try {
    $owner.Dispose()
  } catch {
    $cleanupErrors.Add($_.Exception)
  }
  foreach ($mark in $marks) {
    try {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($mark.Pid)"
      if ($current -and $current.CreationDate -eq $mark.Birth) {
        Stop-Process -Id $mark.Pid -Force -ErrorAction Stop
        $cleanupErrors.Add([InvalidOperationException]::new("The dedicated idle-test helper $($mark.Pid) survived normal cleanup and was stopped by its recorded identity."))
      }
    } catch {
      $cleanupErrors.Add($_.Exception)
    }
  }
  if ($cleanupErrors.Count) {
    if ($failure) { $cleanupErrors.Add($failure) }
    throw [AggregateException]::new('Idle-test validation or owned-process cleanup failed.', $cleanupErrors)
  }
}
if ($failure) { throw $failure }
$released = Read-PowerState
if ($released.system -ne $baseline.system -or $released.display -ne $baseline.display) {
  throw "INCONCLUSIVE: other power requests changed during the test. Baseline=$($baseline.raw), final=$($released.raw). Dedicated helper exit was verified."
}
if ($checked) { Write-Output "PASS scoped helper cleanup; native power state restored to baseline $($released.raw)." }

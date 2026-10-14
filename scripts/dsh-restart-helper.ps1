# dsh-restart-helper.ps1 -- the DETACHED process that actually performs the restart.
#
# Why a separate file: this code was first interpolated into the main script via a
# here-string, and PowerShell's quoting mangled it into a parse error. A static
# file with no interpolation, taking parameters from environment variables, is far
# more reliable.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI codepage (GBK on a Chinese Windows), so non-ASCII comments or strings get
# mangled into syntax errors. Keeping this file pure ASCII removes that whole class
# of failure. Chinese documentation lives in README.md instead.
#
# Launched detached by restart-dsh.ps1 with:
#   DSH_RESTART_APP    absolute path to the application executable
#   DSH_RESTART_LOG    absolute path to the log file
#   DSH_RESTART_DELAY  seconds to wait before stopping the old instance

$ErrorActionPreference = 'Continue'

$app = $env:DSH_RESTART_APP
$log = $env:DSH_RESTART_LOG
$delay = 4
if ($env:DSH_RESTART_DELAY) { $delay = [int]$env:DSH_RESTART_DELAY }

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Write-Log ('helper: starting; will stop the old instance in {0}s' -f $delay)
Start-Sleep -Seconds $delay

Write-Log 'helper: stopping running DeepSeek Harness processes'
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$waited = 0
while ($waited -lt 30) {
  if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
  $waited++
}
Start-Sleep -Seconds 2
Write-Log ('helper: old instance gone (waited {0}s)' -f $waited)

if (-not (Test-Path -LiteralPath $app)) {
  Write-Log ('helper: FATAL application not found, not launching: {0}' -f $app)
  exit 3
}

Write-Log 'helper: launching new instance'
try {
  $proc = Start-Process -FilePath $app -PassThru
  Write-Log ('helper: launched PID {0}' -f $proc.Id)
} catch {
  Write-Log ('helper: FATAL launch failed: {0}' -f $_.Exception.Message)
  exit 4
}

Write-Log 'helper: done'
exit 0

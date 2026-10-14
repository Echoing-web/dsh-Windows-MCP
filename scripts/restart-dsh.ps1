# restart-dsh.ps1 -- restart DeepSeek Harness for real-machine verification.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system ANSI
# codepage (GBK here), so non-ASCII content becomes syntax errors. See README.md
# for the Chinese explanation.
#
# Why this script exists:
#   1. Plugin code changes only take effect after a restart, and a restart ends the
#      running session. Stopping and starting the app from inside that session would
#      kill the launcher too, leaving the app unable to come back. So this script
#      starts a DETACHED helper (dsh-restart-helper.ps1) that outlives the session
#      and performs the actual restart.
#   2. Every step is logged so the restart can be reviewed afterwards.
#   3. The app path is validated first, and a failed launch exits with its own code
#      and a clear log line instead of silently leaving an app that will not open.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-dsh.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-dsh.ps1 -DelaySeconds 6
#
# Parameters:
#   -AppPath       application executable (inferred from the running process by default)
#   -DelaySeconds  seconds to wait before stopping the old instance (default 4)
#   -LogFile       log path (default %TEMP%\dsh-restart.log)

param(
  [string]$AppPath = '',
  [int]$DelaySeconds = 4,
  [string]$LogFile = (Join-Path $env:TEMP 'dsh-restart.log')
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

if (-not $AppPath) {
  # Prefer an explicit env var, then discovery from the running process. No hardcoded
  # install path: this repo must work from any checkout on any machine.
  if ($env:DSH_RESTART_APP) {
    $AppPath = $env:DSH_RESTART_APP
  } else {
    $proc = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($proc -and $proc.ExecutablePath) { $AppPath = $proc.ExecutablePath }
  }
}

if (-not $AppPath) {
  Write-Log 'FATAL could not determine the DSH executable. Set DSH_RESTART_APP to its full path, or pass -AppPath.'
  exit 2
}

if (-not (Test-Path -LiteralPath $AppPath)) {
  Write-Log "FATAL application not found: $AppPath"
  exit 2
}

$helper = Join-Path $PSScriptRoot 'dsh-restart-helper.ps1'
if (-not (Test-Path -LiteralPath $helper)) {
  Write-Log "FATAL helper script not found: $helper"
  exit 2
}

Write-Log "restarting: $AppPath (delay ${DelaySeconds}s, log $LogFile)"

$env:DSH_RESTART_APP = $AppPath
$env:DSH_RESTART_LOG = $LogFile
$env:DSH_RESTART_DELAY = [string]$DelaySeconds

Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helper `
  -WindowStyle Hidden

Write-Log 'detached helper started; this session may end now. See this log for the result.'

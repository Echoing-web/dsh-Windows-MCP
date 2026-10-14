@echo off
REM dsh-restart-task.cmd -- launcher used by the "DSH-Restart-Verify" scheduled task.
REM
REM Why a .cmd and not the .ps1 directly: passing a quoted path plus arguments
REM through `schtasks /TR` fights with cmd quoting ("Invalid argument/option" was
REM the result). A tiny batch file with plain paths sidesteps that entirely.
REM
REM A scheduled task is used rather than Start-Process because the harness runs a
REM command inside a job object: a "detached" child is still killed when the turn
REM ends. Task Scheduler runs this under the service, outside any job object, so
REM the restart survives the session it was launched from.
REM
REM ASCII only, for the same codepage reason as the .ps1 files.
REM
REM Paths are NOT hardcoded: the app path comes from DSH_RESTART_APP (set it in the
REM task environment, or rely on the helper's own discovery), and the helper path is
REM derived from this script's own location (%~dp0) so the repo works from any checkout.

if "%DSH_RESTART_APP%"=="" (
  echo [dsh-restart-task] DSH_RESTART_APP is not set. Set it to the full path of
  echo                     the DSH executable, e.g. C:\path\to\DeepSeek Harness.exe
  exit /b 2
)
if "%DSH_RESTART_LOG%"=="" set DSH_RESTART_LOG=%TEMP%\dsh-restart.log
if "%DSH_RESTART_DELAY%"=="" set DSH_RESTART_DELAY=3

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-restart-helper.ps1"

#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_exe="$root/bundle/xp-thermal-service.exe"

if ! command -v powershell.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
  printf '%s\n' 'This script must run from WSL with Windows interop enabled.' >&2
  exit 1
fi

(cd "$root" && npm run build && npm run package:win)

source_windows="$(wslpath -w "$source_exe")"
source_windows="${source_windows//\'/\'\'}"

read -r -d '' powershell_script <<'POWERSHELL' || true
$ErrorActionPreference = 'Stop'
$service = 'xpthermalprintservice'
$install = 'C:\ProgramData\XPThermalService'
$target = Join-Path $install 'xp-thermal-service.exe'
$winsw = Join-Path $install 'xpthermalprintservice.exe'
$source = '__SOURCE_PATH__'
$log = Join-Path $install 'logs\local-deploy.log'

try {

if (-not (Test-Path -LiteralPath $source)) { throw "Build output not found: $source" }
if (-not (Test-Path -LiteralPath $winsw)) { throw "WinSW not found: $winsw" }

& $winsw stop | Out-Null
if ($LASTEXITCODE -ne 0) { throw "WinSW failed to stop $service (exit $LASTEXITCODE)" }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $state = (Get-Service -Name $service -ErrorAction Stop).Status
  if ($state -eq 'Stopped') { break }
  Start-Sleep -Milliseconds 500
}
if ((Get-Service -Name $service).Status -ne 'Stopped') { throw "Service did not stop within 30 seconds" }

# Avoid probing a stale fallback port from the prior process.
Remove-Item (Join-Path $install 'active_port.txt') -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $source -Destination $target -Force
& $winsw start | Out-Null
if ($LASTEXITCODE -ne 0) { throw "WinSW failed to start $service (exit $LASTEXITCODE)" }

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-Path (Join-Path $install 'active_port.txt')) {
    $port = [int](Get-Content (Join-Path $install 'active_port.txt') -Raw)
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
      Set-Content -Path $log -Value "Deployed and healthy on http://127.0.0.1:$port"
      exit 0
    } catch { }
  }
  Start-Sleep -Seconds 1
}

throw "Service did not become healthy within 60 seconds; check $install\logs"
} catch {
  $_ | Out-String | Set-Content -Path $log
  throw
}
POWERSHELL

powershell_script="${powershell_script/__SOURCE_PATH__/$source_windows}"
encoded="$(printf '%s' "$powershell_script" | iconv -t UTF-16LE | base64 -w 0)"
printf '%s\n' 'Approve the Windows UAC prompt to replace and restart the service.'
export XP_THERMAL_DEPLOY_SCRIPT="$encoded"
set +e
powershell.exe -NoProfile -Command '$process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $env:XP_THERMAL_DEPLOY_SCRIPT"; exit $process.ExitCode'
status=$?
set -e
powershell.exe -NoProfile -Command "Get-Content 'C:\\ProgramData\\XPThermalService\\logs\\local-deploy.log' -ErrorAction SilentlyContinue"
exit "$status"

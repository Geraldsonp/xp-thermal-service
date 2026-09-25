# Run this from an ELEVATED PowerShell (Run as Administrator)
# It builds inside WSL then replaces the Windows service in-place.
$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) { throw "Re-run this script as Administrator (right-click PowerShell -> Run as Administrator)." }

$service = 'xpthermalprintservice'
$install = 'C:\ProgramData\XPThermalService'
$target = Join-Path $install 'xp-thermal-service.exe'
$winsw = Join-Path $install 'xpthermalprintservice.exe'
$wslProject = '/home/gperez/src/xp-thermal-service'

Write-Host "[1/3] Building in WSL..."
wsl bash -ic "cd $wslProject && npm run build && npm run package:win"
if ($LASTEXITCODE -ne 0) { throw "WSL build failed (exit $LASTEXITCODE)" }

$source = (wsl wslpath -w "$wslProject/bundle/xp-thermal-service.exe").Trim()
if (-not (Test-Path -LiteralPath $source)) { throw "Build output not found: $source" }
if (-not (Test-Path -LiteralPath $winsw)) { throw "WinSW not found: $winsw" }

Write-Host "[2/3] Stopping service..."
& $winsw stop | Out-Null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if ((Get-Service -Name $service -ErrorAction SilentlyContinue).Status -eq 'Stopped') { break }
  Start-Sleep -Milliseconds 500
}
if ((Get-Service -Name $service).Status -ne 'Stopped') { throw "Service did not stop within 30s" }

Remove-Item (Join-Path $install 'active_port.txt') -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $source -Destination $target -Force
Write-Host "Replaced $target"

Write-Host "[3/3] Starting service..."
& $winsw start | Out-Null
if ($LASTEXITCODE -ne 0) { throw "WinSW start failed (exit $LASTEXITCODE)" }

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-Path (Join-Path $install 'active_port.txt')) {
    $port = [int](Get-Content (Join-Path $install 'active_port.txt') -Raw)
    try {
      Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 | Out-Null
      Write-Host "Deployed and healthy on http://127.0.0.1:$port" -ForegroundColor Green
      exit 0
    } catch {}
  }
  Start-Sleep -Seconds 1
}
throw "Service did not become healthy within 60s; check $install\logs"

# XP Thermal Print Service — one-line installer
# Downloads the self-contained zip and registers the Windows service.
#
# Usage (run as Administrator):
#   powershell -ExecutionPolicy Bypass -File install.ps1 `
#       -DownloadUrl "https://<your-host>/xp-thermal-service.zip"
#
# The download URL is required. The script exits non-zero on any failure — it
# never reports success for a half-finished upgrade.

param(
    [Parameter(Mandatory = $true)][string]$DownloadUrl,
    [switch]$Silent
)

$ErrorActionPreference = "Stop"

$ServiceId = "xpthermalprintservice"
$AppExe = "xp-thermal-service.exe"
$WinswExe = "xpthermalprintservice.exe"
$WinswXml = "xpthermalprintservice.xml"

# The service falls back upward when its configured port is busy, exactly as
# scripts\install.ps1 does, so the health probe scans the same range.
$HealthPorts = 9100..9110

# ProgramData is normally C:\ProgramData but can be redirected, or missing
# from the environment block entirely when the installer is launched from a
# service / scheduled task / restricted shell. (Same fallback as the full
# scripts\install.ps1.)
$ProgramDataRoot = $env:ProgramData
if (-not $ProgramDataRoot) { $ProgramDataRoot = "$env:ALLUSERSPROFILE" }
if (-not $ProgramDataRoot) { $ProgramDataRoot = "$env:SystemDrive\ProgramData" }
if (-not $ProgramDataRoot) { $ProgramDataRoot = "C:\ProgramData" }
$InstallPath = "$ProgramDataRoot\XPThermalService"

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step([string]$msg) {
    if (-not $Silent) { Write-Host "  [*] $msg" }
}

# Every failure goes through here so no code path can fall through to the
# success message. Exit code 1 = the install did not complete.
function Fail([string]$msg) {
    if (-not $Silent) { Write-Host "  [!] $msg" -ForegroundColor Red }
    exit 1
}

if (-not (Test-Administrator)) {
    Write-Host "This installer must run as Administrator." -ForegroundColor Red
    exit 1
}

# ── 1. Robustly stop and remove any existing service ─────────────────
#
# "sc stop" returns as soon as the SCM accepts the request, not when the
# service is down, and "sc delete" only MARKS a service for deletion — the
# registration survives until the last open handle closes and still answers
# Get-Service (re-registering then fails with error 1072). So: stop, WAIT,
# delete, WAIT. (Proven pattern from scripts\install.ps1.)

function Wait-ServiceStopped([string]$Name, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-ServiceGone([string]$Name, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Seconds 1
    }
    return (Get-Service -Name $Name -ErrorAction SilentlyContinue) -eq $null
}

$existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Stopping the existing service..."
    sc.exe stop $ServiceId | Out-Null
    if (-not (Wait-ServiceStopped $ServiceId 30)) {
        Write-Step "Service did not stop within 30s - forcing..."
    }

    # Force-kill the exe images. taskkill writes failures to stderr; through
    # cmd the two streams are merged before PowerShell sees them, which keeps
    # a stderr redirect from becoming a terminating error under
    # $ErrorActionPreference = "Stop". (Same trick as Stop-ProcessHard in
    # scripts\install.ps1.)
    cmd /c "taskkill /F /T /IM $AppExe 2>nul" | Out-Null
    cmd /c "taskkill /F /T /IM $WinswExe 2>nul" | Out-Null
    if (-not (Wait-ServiceStopped $ServiceId 30)) {
        Fail "The existing service would not stop; aborting rather than installing over a running copy."
    }

    Write-Step "Removing the existing service registration..."
    sc.exe delete $ServiceId | Out-Null
    if (-not (Wait-ServiceGone $ServiceId 30)) {
        Fail "Service '$ServiceId' is still registered 30s after deletion (marked for delete; something holds a handle - close services.msc / Event Viewer and retry)."
    }
}

# A force-killed leaf leaves data\service.lock with a fresh heartbeat; the new
# instance would then wait ~20s for a handover that is never coming and exit.
# Safe to remove only after nothing of ours is running - which the waits above
# guaranteed.
$lockPath = Join-Path $InstallPath "data\service.lock"
if (Test-Path $lockPath) {
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    Write-Step "Cleared a stale instance lock."
}

# ── 2. Download ────────────────────────────────────────────────────────
$zip = Join-Path $env:TEMP "xp-thermal-service.zip"
if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
Write-Step "Downloading $DownloadUrl ..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zip -UseBasicParsing -ErrorAction Stop
}
catch {
    Fail "Download failed: $($_.Exception.Message)"
}

# ── 3. Validate the zip BEFORE touching the install directory ────────
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipArchive = $null
try {
    $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($zip)
}
catch {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Fail "The downloaded file is not a readable zip archive: $($_.Exception.Message)"
}
$entries = @($zipArchive.Entries | ForEach-Object { $_.FullName })
$zipArchive.Dispose()
foreach ($required in @($AppExe, $WinswExe, $WinswXml, "config.json")) {
    if ($entries -notcontains $required) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Fail "The zip is missing '$required' - not the expected bundle. Aborting."
    }
}

# ── 4. Extract into the install directory ─────────────────────────────
$tmp = Join-Path $env:TEMP ("xpthermal-" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $zip -DestinationPath $tmp -Force
New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
$configPath = Join-Path $InstallPath "config.json"
$hasExistingConfig = Test-Path $configPath

# The release carries a ready-to-run config.json for fresh installs. Preserve
# local printer, API-key, and deployment settings on upgrades.
Get-ChildItem -Path $tmp -Force |
    Where-Object { -not $hasExistingConfig -or $_.Name -ne "config.json" } |
    Copy-Item -Destination $InstallPath -Recurse -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

# ── 5. Ready configuration ─────────────────────────────────────────────
if (-not $hasExistingConfig) {
    Write-Step "Installed bundled config.json. Pick your printer in the dashboard."
}

# ── 6. Register + start via winsw, checking every exit code ──────────
$winsw = Join-Path $InstallPath $WinswExe
if (-not (Test-Path $winsw)) { Fail "$WinswExe not found in $InstallPath - the bundle is incomplete." }
if (-not (Test-Path (Join-Path $InstallPath $WinswXml))) {
    Fail "$WinswXml not found next to $WinswExe - WinSW registers whatever descriptor sits beside it; without it the service would come up with the wrong or no configuration."
}

Write-Step "Registering the Windows service..."
& $winsw install | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "winsw install failed with exit code $LASTEXITCODE." }

sc.exe config $ServiceId start= delayed-auto
if ($LASTEXITCODE -ne 0) { Fail "sc.exe config failed with exit code $LASTEXITCODE." }

& $winsw start | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "winsw start failed with exit code $LASTEXITCODE." }

# ── 7. Verify: service Running AND /health answering ─────────────────
Write-Step "Waiting for the service to report Running..."
$running = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { $running = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $running) {
    $status = (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue).Status
    Fail "Service did not reach Running within 30s (status: $status). Check $($InstallPath)\logs."
}

Write-Step "Waiting for the local /health endpoint..."
$healthy = $false
$healthPort = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    foreach ($port in $HealthPorts) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $healthy = $true; $healthPort = $port; break }
        }
        catch {
            # An HTTP error response still proves the service is listening;
            # only "no response at all" means it is not up yet.
            if ($_.Exception.Response) { $healthy = $true; $healthPort = $port; break }
        }
    }
    if ($healthy) { break }
    Start-Sleep -Seconds 1
}
if (-not $healthy -or -not $healthPort) {
    Fail "The service is Running but /health never answered on ports $($HealthPorts[0])-$($HealthPorts[-1]) within 60s. Check $($InstallPath)\logs."
}

# ── 8. Success — only reachable after every check above passed ───────
# Use the port that actually answered /health: when 9100 was busy the
# service fell back to 9101+, and a hardcoded 9100 would open a dead page.
$DashboardUrl = "http://127.0.0.1:$healthPort/dashboard"
if (-not $Silent) {
    Write-Host ""
    Write-Host "  Installed and verified. Open $DashboardUrl to find and select your receipt printer." -ForegroundColor Green
    Start-Process $DashboardUrl
}

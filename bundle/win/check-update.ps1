# XP Thermal Service — auto-updater (corre como SYSTEM, sin ventana)
# Lo registra bundle/win/install.ps1 como tarea XPThermalServiceUpdater cada 6h.
# Solo chequea version.json en R2 y, si hay versión mayor, re-ejecuta el
# instalador en -Silent. No toca config.json ni printers (el instalador preserva).
#
# Seguridad: corre como SYSTEM con -WindowStyle Hidden, nunca pide UAC.
# Si la cola tiene trabajo pendiente, se salta esta pasada y reintenta en 6h.

$ErrorActionPreference = "Continue"

$ProgramDataRoot = $env:ProgramData
if (-not $ProgramDataRoot) { $ProgramDataRoot = "C:\ProgramData" }
$InstallPath = "$ProgramDataRoot\XPThermalService"
$LogFile = "$InstallPath\logs\updater.log"
$VersionStamp = "$InstallPath\installed-version.json"
$InstallerPath = "$InstallPath\install.ps1"
# ponytail: URL fija, sin canal beta/stable hasta que haga falta
$ManifestUrl = "https://posfiles.geraldsonperez.dev/thermal-service/version.json"

function Write-UpdaterLog([string]$msg) {
    try {
        $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "$ts [updater] $msg" | Out-File -Append $LogFile -Encoding utf8 -ErrorAction SilentlyContinue
        $lines = Get-Content $LogFile -Tail 500 -ErrorAction SilentlyContinue
        if ($lines) { $lines | Set-Content $LogFile -ErrorAction SilentlyContinue }
    } catch {}
}

function Get-LocalVersion {
    if (Test-Path $VersionStamp) {
        try { return (Get-Content $VersionStamp -Raw -ErrorAction Stop | ConvertFrom-Json).version } catch {}
    }
    return $null
}

function Compare-Versions([string]$a, [string]$b) {
    # $true si $b es más nueva que $a. Compara por segmentos numéricos.
    try {
        $pa = ($a -replace '^v','').Split('.') | ForEach-Object { [int]($_ -replace '\D.*','') }
        $pb = ($b -replace '^v','').Split('.') | ForEach-Object { [int]($_ -replace '\D.*','') }
        for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
            $x = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
            $y = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
            if ($y -gt $x) { return $true }
            if ($y -lt $x) { return $false }
        }
        return $false
    } catch { return ($a -ne $b) }
}

function Test-QueueIdle {
    # No reiniciar una till en mitad de un turno: si hay trabajo encolado,
    # se salta esta pasada. /health responde en 9100-9110.
    foreach ($port in 9100..9110) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            $body = $r.Content | ConvertFrom-Json -ErrorAction Stop
            $pending = [int]$body.queue.pending + [int]$body.queue.processing
            return ($pending -eq 0)
        } catch {
            if ($_.Exception.Response) { return $true } # HTTP vivo = idle a efectos de update
        }
    }
    return $true # servicio caído = nada que interrumpir, el instalador lo levanta
}

try {
    $local = Get-LocalVersion
    $manifest = Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing -Headers @{'Cache-Control'='no-cache'} -TimeoutSec 20 -ErrorAction Stop | Select-Object -ExpandProperty Content | ConvertFrom-Json
    $remote = $manifest.version
    if (-not $remote) { Write-UpdaterLog "manifest sin version, salgo"; exit 0 }
    if ($local -and -not (Compare-Versions $local $remote)) { exit 0 } # ya estamos al día

    Write-UpdaterLog "update disponible: local=$local remote=$remote"

    if (-not (Test-QueueIdle)) { Write-UpdaterLog "cola con trabajo, reintento en la proxima pasada"; exit 0 }

    $zipUrl = $manifest.zipUrl
    if (-not $zipUrl) { Write-UpdaterLog "manifest sin zipUrl, salgo"; exit 0 }

    # El instalador debe existir localmente (lo deja cada install). Si falta,
    # se descarga el publicado junto al manifest.
    $installerUrl = $manifest.installerUrl
    if ((-not (Test-Path $InstallerPath)) -and $installerUrl) {
        try {
            Invoke-WebRequest -Uri $installerUrl -OutFile $InstallerPath -UseBasicParsing -ErrorAction Stop
        } catch { Write-UpdaterLog "no pude traer install.ps1: $($_.Exception.Message)"; exit 0 }
    }
    if (-not (Test-Path $InstallerPath)) { Write-UpdaterLog "sin install.ps1 local, salgo"; exit 0 }

    Write-UpdaterLog "ejecutando instalador -Silent..."
    $p = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallerPath`" -DownloadUrl `"$zipUrl`" -Silent" -Wait -PassThru
    Write-UpdaterLog "instalador termino con codigo $($p.ExitCode)"
} catch {
    Write-UpdaterLog "check fallido (red/R2?): $($_.Exception.Message)"
}

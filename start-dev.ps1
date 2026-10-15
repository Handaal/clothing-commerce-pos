<#
.SYNOPSIS
    Dev-only launcher for the Clothing Commerce POS and its local Commerce API.

.DESCRIPTION
    Brings up the full local dev stack in the right order:
        Docker  ->  Supabase  ->  Commerce API (:3000)  ->  POS (Vite + Electron)

    The API and POS each run `pnpm dev`, which is long-running, so this script
    launches them in their own PowerShell windows and leaves them open. Close
    those windows (or Ctrl+C in them) to stop the servers. Supabase keeps
    running across sessions; stop it with `pnpm supabase:stop` in the API repo.

    FOR LOCAL DEVELOPMENT ONLY. Do not use for packaged/production runs.

.PARAMETER SkipApi
    Don't start the Commerce API (use when it's already running).

.PARAMETER SkipPos
    Don't start the POS (use when it's already running).

.EXAMPLE
    .\start-dev.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipApi,
    [switch]$SkipPos
)

$ErrorActionPreference = 'Stop'

# --- Paths -------------------------------------------------------------------
$PosDir = $PSScriptRoot
$ApiDir = Join-Path (Split-Path $PosDir -Parent) 'clothing-commerce-api'
$HealthUrl = 'http://localhost:3000/api/v1/health'
$ViteUrl = 'http://127.0.0.1:5173'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[x] $msg" -ForegroundColor Red; exit 1 }

# Returns $true if something is already listening on the given loopback TCP port.
function Test-PortInUse([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(400)
        return ($ok -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (-not (Test-Path $ApiDir)) {
    Fail "Commerce API repo not found at: $ApiDir (expected as a sibling of the POS repo)."
}

# NOTE: native tools (docker, pnpm, supabase) often write warnings to stderr.
# Under $ErrorActionPreference='Stop' PowerShell turns that stderr into a thrown
# error even on success, so every native call below is routed through cmd.exe
# (which swallows stderr internally) and judged only by its real exit code.
function Invoke-Native([string]$CommandLine) {
    & cmd /c "$CommandLine 2>nul"
    return $LASTEXITCODE
}

# --- 1. Docker ---------------------------------------------------------------
Write-Step 'Checking Docker engine'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker CLI not found on PATH. Install/start Docker Desktop and re-run this script.'
}
if ((Invoke-Native 'docker info') -ne 0) {
    Fail 'Docker engine is not reachable. Start Docker Desktop and re-run this script.'
}
Write-Ok 'Docker is running'

# --- 2. Supabase -------------------------------------------------------------
Write-Step 'Checking Supabase local stack'
Push-Location $ApiDir
try {
    $status = (& cmd /c 'pnpm supabase:status 2>nul') | Out-String
    if ($status -match 'DB_URL') {
        Write-Ok 'Supabase stack is already up'
    } else {
        Write-Warn2 'Supabase not up - starting it (this can take a minute)...'
        if ((Invoke-Native 'pnpm supabase:start') -ne 0) { Fail 'Supabase failed to start.' }
        Write-Ok 'Supabase started'
    }
} finally {
    Pop-Location
}

# --- 3. Commerce API ---------------------------------------------------------
if ((-not $SkipApi) -and (Test-PortInUse 3000)) {
    Write-Step 'Commerce API'
    Write-Warn2 'Port 3000 already in use - assuming the API is running; skipping it.'
    $SkipApi = $true
}
if (-not $SkipApi) {
    Write-Step 'Starting Commerce API (pnpm dev) in a new window'
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$ApiDir'; Write-Host 'Commerce API (dev)' -ForegroundColor Cyan; pnpm dev"
    ) | Out-Null

    Write-Host '    waiting for API health' -NoNewline
    $apiOk = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $apiOk = $true; break }
        } catch {}
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    if ($apiOk) { Write-Ok "API healthy at $HealthUrl" }
    else { Write-Warn2 "API did not report healthy yet - check its window. Continuing." }
} else {
    Write-Step 'Skipping Commerce API (--SkipApi)'
}

# --- 4. POS (Vite + Electron) ------------------------------------------------
if ((-not $SkipPos) -and (Test-PortInUse 5173)) {
    Write-Step 'POS'
    Write-Warn2 'Port 5173 already in use - assuming the POS is running; skipping it.'
    $SkipPos = $true
}
if (-not $SkipPos) {
    Write-Step 'Starting POS (pnpm dev) in a new window'
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$PosDir'; Write-Host 'Clothing Commerce POS (dev)' -ForegroundColor Cyan; pnpm dev"
    ) | Out-Null

    Write-Host '    waiting for Vite' -NoNewline
    $viteOk = $false
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $ViteUrl -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $viteOk = $true; break }
        } catch {}
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    if ($viteOk) { Write-Ok "Vite up at $ViteUrl - Electron will open shortly after main compiles" }
    else { Write-Warn2 'Vite did not come up yet - check the POS window.' }
} else {
    Write-Step 'Skipping POS (--SkipPos)'
}

Write-Host "`nDev stack launch complete." -ForegroundColor Green
Write-Host "API and POS run in their own windows; close them to stop." -ForegroundColor DarkGray
Write-Host "Supabase stays up across sessions (stop with 'pnpm supabase:stop' in the API repo)." -ForegroundColor DarkGray

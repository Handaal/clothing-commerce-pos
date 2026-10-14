<#
.SYNOPSIS
    Dev-only stopper for the Clothing Commerce POS and local Commerce API.

.DESCRIPTION
    Shuts down the processes that start-dev.ps1 launched:
        - the "Commerce API (dev)" window and its pnpm/next tree
        - the "Clothing Commerce POS (dev)" window and its pnpm/vite/electron tree

    It targets those windows by the title markers start-dev.ps1 sets, then falls
    back to killing whatever is still listening on :3000 / :5173 plus any stray
    electron.exe. Supabase is LEFT RUNNING on purpose (it is shared and slow to
    boot); pass -StopSupabase to shut it down too.

    FOR LOCAL DEVELOPMENT ONLY.

.PARAMETER StopSupabase
    Also stop the local Supabase stack (pnpm supabase:stop in the API repo).

.EXAMPLE
    .\stop-dev.ps1
.EXAMPLE
    .\stop-dev.ps1 -StopSupabase
#>
[CmdletBinding()]
param(
    [switch]$StopSupabase
)

$ErrorActionPreference = 'Stop'

$PosDir = $PSScriptRoot
$ApiDir = Join-Path (Split-Path $PosDir -Parent) 'clothing-commerce-api'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Info($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }

# Recursively stop a process and all of its descendants (children first).
function Stop-Tree([int]$ProcId) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcId" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Tree ([int]$_.ProcessId) }
    Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue
}

# PIDs listening on a given loopback TCP port.
function Get-PortOwnerPid([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

# --- 1. Kill the launcher windows by their title markers ---------------------
Write-Step 'Stopping dev windows (API + POS) by title marker'
$markers = @('Commerce API (dev)', 'Clothing Commerce POS (dev)')
$killed = 0
foreach ($m in $markers) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) }
    foreach ($p in $procs) {
        Write-Info "closing window: $m (pid $($p.ProcessId))"
        Stop-Tree ([int]$p.ProcessId)
        $killed++
    }
}
if ($killed -eq 0) { Write-Info 'no marked dev windows found' } else { Write-Ok "$killed window tree(s) stopped" }

# --- 2. Fallback: free the ports + any stray Electron ------------------------
Write-Step 'Clearing leftover port holders and Electron'
foreach ($port in 3000, 5173) {
    $owners = Get-PortOwnerPid $port
    foreach ($procId in $owners) {
        Write-Info "killing pid $procId on port $port"
        Stop-Tree ([int]$procId)
    }
}
$electrons = Get-Process electron -ErrorAction SilentlyContinue
if ($electrons) {
    Write-Info "stopping $(($electrons | Measure-Object).Count) electron process(es)"
    $electrons | Stop-Process -Force -ErrorAction SilentlyContinue
}
Write-Ok 'ports 3000 / 5173 cleared'

# --- 3. Optionally stop Supabase ---------------------------------------------
if ($StopSupabase) {
    Write-Step 'Stopping Supabase local stack'
    if (Test-Path $ApiDir) {
        Push-Location $ApiDir
        try {
            & cmd /c 'pnpm supabase:stop 2>nul' | Out-Null
            Write-Ok 'Supabase stopped'
        } finally {
            Pop-Location
        }
    } else {
        Write-Info "API repo not found at $ApiDir; skipping Supabase stop"
    }
} else {
    Write-Step 'Leaving Supabase running'
    Write-Info 'pass -StopSupabase to shut it down too'
}

Write-Host "`nDev stack stopped." -ForegroundColor Green

<#
.SYNOPSIS
  Installs (or reconfigures) the IBS Intelligence API as a Windows service via nssm.

.DESCRIPTION
  The API has been running as `npm start` in a console window. That window is the
  whole production availability story: selecting text in it suspends the process,
  Ctrl+C kills it, and logging off ends it. This replaces it with a real service
  that starts at boot, restarts on crash, and keeps rotating logs.

  Run this ON THE SERVER, from an elevated PowerShell. It is idempotent - run it
  again after a `npm run build` or a config change and it will reconfigure the
  existing service rather than fail.

  Requires nssm on PATH. If it is missing, download the 64-bit build from
  https://nssm.cc/download and put nssm.exe somewhere on PATH (C:\Windows\System32
  is fine), then re-run.

.PARAMETER ServiceName
  Windows service name. Defaults to IBSiNewsApi.

.EXAMPLE
  .\install-service.ps1
  .\install-service.ps1 -ServiceName IBSiNewsApi
#>

[CmdletBinding()]
param(
    [string]$ServiceName = 'IBSiNewsApi'
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell - installing a service needs administrator rights.'
    }
}

function Invoke-Nssm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    # nssm writes its own errors to stderr and still exits 0 for some verbs, so
    # the output is captured and surfaced rather than trusted silently.
    $output = & nssm.exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Arguments -join ' ') failed: $output"
    }
}

Assert-Admin

# Derived rather than hard-coded, so this works whether the repo sits on C:\ or
# is reached over the Z: mapping.
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entryPoint = Join-Path $projectRoot 'dist\server.js'
$logDirectory = Join-Path $projectRoot 'logs'

if (-not (Get-Command nssm.exe -ErrorAction SilentlyContinue)) {
    throw 'nssm.exe is not on PATH. Download the 64-bit build from https://nssm.cc/download and place nssm.exe on PATH, then re-run.'
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe is not on PATH.' }

if (-not (Test-Path $entryPoint)) {
    throw "$entryPoint does not exist. Run `npm run build` first - the service runs the compiled output, not the TypeScript."
}

if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
}

Write-Host "project : $projectRoot"
Write-Host "node    : $node"
Write-Host "entry   : $entryPoint"
Write-Host ""

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service '$ServiceName' exists - reconfiguring."
    if ($existing.Status -eq 'Running') {
        Write-Host 'Stopping it first.'
        Invoke-Nssm stop $ServiceName
    }
} else {
    Write-Host "Installing service '$ServiceName'."
    Invoke-Nssm install $ServiceName $node
}

Invoke-Nssm set $ServiceName Application $node
Invoke-Nssm set $ServiceName AppParameters $entryPoint
Invoke-Nssm set $ServiceName AppDirectory $projectRoot
Invoke-Nssm set $ServiceName DisplayName 'IBS Intelligence News API'
Invoke-Nssm set $ServiceName Description 'Node API serving the IBSi News mobile app (proxied to https://dev.ibsintelligence.com).'
Invoke-Nssm set $ServiceName Start SERVICE_AUTO_START

# Postgres is local and the service must not race it on boot. Delayed start
# costs a few seconds and avoids a restart loop while the database comes up.
Invoke-Nssm set $ServiceName DelayedAutostart 1

# Restart on any unexpected exit, with a pause so a crash loop does not spin.
Invoke-Nssm set $ServiceName AppExit Default Restart
Invoke-Nssm set $ServiceName AppRestartDelay 5000
# nssm treats an exit inside this window as a failed start; the default 1500ms
# is short enough that a slow database connection looks like a crash loop.
Invoke-Nssm set $ServiceName AppThrottle 10000

# server.ts handles SIGINT and SIGTERM, closing the HTTP server and the pg pool
# before exiting, with its own 10s force-exit. On Windows nssm's console stop
# method is what Node sees as SIGINT, so it is left enabled (AppStopMethodSkip 0)
# and given 15s - longer than the app's own timer, so the graceful path always
# wins and nssm never has to terminate the process outright.
Invoke-Nssm set $ServiceName AppStopMethodSkip 0
Invoke-Nssm set $ServiceName AppStopMethodConsole 15000

Invoke-Nssm set $ServiceName AppStdout (Join-Path $logDirectory 'api.out.log')
Invoke-Nssm set $ServiceName AppStderr (Join-Path $logDirectory 'api.err.log')
# Without rotation these grow without bound; pino logs every request.
Invoke-Nssm set $ServiceName AppRotateFiles 1
Invoke-Nssm set $ServiceName AppRotateOnline 1
Invoke-Nssm set $ServiceName AppRotateBytes 10485760

Write-Host ''
Write-Host 'Starting service...'
Invoke-Nssm start $ServiceName

Start-Sleep -Seconds 3
$service = Get-Service -Name $ServiceName
Write-Host "Status: $($service.Status)"

Write-Host ''
Write-Host 'Smoke test:'
try {
    $health = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 10
    Write-Host "  /health -> status=$($health.status) database=$($health.database)"
} catch {
    Write-Warning "  /health did not answer: $_"
    Write-Warning "  Check $logDirectory\api.err.log"
}

Write-Host ''
Write-Host 'Done. Useful commands:'
Write-Host "  nssm restart $ServiceName        # after npm run build"
Write-Host "  nssm stop $ServiceName"
Write-Host "  nssm status $ServiceName"
Write-Host "  nssm edit $ServiceName           # GUI for every setting above"
Write-Host "  Get-Content $logDirectory\api.err.log -Tail 50 -Wait"

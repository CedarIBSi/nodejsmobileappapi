<#
.SYNOPSIS
  Builds the API and restarts the Windows service, then smoke-tests it.

.DESCRIPTION
  The deploy runbook, as a script. Run it ON THE SERVER from an elevated
  PowerShell after pulling changes.

  The smoke tests at the end are the ones that matter: an old process serving
  stale code answers /v1/subscription/verify-purchase with 404 rather than 401,
  which is how a "deployed" change that never actually took hold gets caught.

.EXAMPLE
  .\deploy.ps1
#>

[CmdletBinding()]
param(
    [string]$ServiceName = 'IBSiNewsApi',
    [string]$BaseUrl = 'http://localhost:3000'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell - restarting a service needs administrator rights.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot

Write-Host '== Building =='
& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed - not restarting the service, so the running version is left alone.' }

Write-Host ''
Write-Host '== Restarting service =='
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    throw "Service '$ServiceName' is not installed. Run scripts\install-service.ps1 first."
}
& nssm.exe restart $ServiceName | Out-Host

Start-Sleep -Seconds 4

Write-Host ''
Write-Host '== Smoke tests =='

function Test-Endpoint {
    param([string]$Path, [int]$Expected, [string]$Method = 'GET', [string]$Note = '')
    $uri = "$BaseUrl$Path"
    $code = $null
    # Deliberately not using -SkipHttpErrorCheck: that is PowerShell 7 only, and
    # this server runs Windows PowerShell 5.1, where any 4xx throws. Two of the
    # tests below expect a 401, so the status has to be recovered from the
    # exception's response. This shape works on both 5.1 and 7.
    try {
        $arguments = @{
            Uri             = $uri
            Method          = $Method
            TimeoutSec      = 15
            UseBasicParsing = $true
        }
        if ($Method -eq 'POST') {
            $arguments.Body = '{}'
            $arguments.ContentType = 'application/json'
        }
        $code = [int](Invoke-WebRequest @arguments).StatusCode
    } catch {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
        } else {
            Write-Host ("  {0,-45} ERROR {1}" -f $Path, $_.Exception.Message) -ForegroundColor Red
            return
        }
    }
    $ok = $code -eq $Expected
    $colour = if ($ok) { 'Green' } else { 'Red' }
    $line = "  {0,-45} {1} (expected {2}) {3}" -f $Path, $code, $Expected, $Note
    Write-Host $line -ForegroundColor $colour
}

Test-Endpoint -Path '/health' -Expected 200
Test-Endpoint -Path '/v1/subscription/plans' -Expected 200
Test-Endpoint -Path '/v1/subscription/verify-purchase' -Expected 401 -Method 'POST' -Note '404 here means stale code is still serving'
Test-Endpoint -Path '/v1/subscription/status' -Expected 401 -Method 'GET'
Test-Endpoint -Path '/v1/events' -Expected 200

Write-Host ''
Write-Host "Logs: Get-Content $projectRoot\logs\api.err.log -Tail 50 -Wait"

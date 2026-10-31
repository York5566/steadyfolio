param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS with npm, then run this launcher again.' }
if ([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 5173) { throw 'Port 5173 is already in use. Open http://127.0.0.1:5173/zh-Hant/ if the preview is running, or stop the existing server first.' }
if (-not (Test-Path -LiteralPath '.dev.vars')) {
    $secret = & node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
    $settings = (Get-Content -LiteralPath '.dev.vars.example' -Raw).Replace('replace-with-a-random-secret-at-least-32-characters', $secret)
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.dev.vars'), $settings, [System.Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& npm.cmd run db:local
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $SkipBuild) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
Write-Host 'Open http://127.0.0.1:5173/zh-Hant/ . Keep this window open; Ctrl+C stops the preview.'
& npx.cmd wrangler dev --ip 127.0.0.1 --port 5173
exit $LASTEXITCODE

param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$destination = Join-Path $root ('release/verified-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $destination) { throw 'Verification destination already exists.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256Hash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$prefix = [System.IO.Path]::GetFullPath($destination) + [System.IO.Path]::DirectorySeparatorChar
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $zip.Entries) {
        $resolved = [System.IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        if (-not $resolved.StartsWith($prefix,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path.' }
        if ($entry.FullName -match '(^|/)(node_modules|data-private|\.wrangler|\.git)(/|$)' -or $entry.FullName -in @('.dev.vars','.env','wrangler.deploy.json')) { throw 'Private or generated file in archive.' }
    }
    $entryCount = $zip.Entries.Count
} finally { $zip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath,$destination)
$manifest = Get-Content -LiteralPath (Join-Path $destination 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($entryCount -ne ($manifest.Count + 1)) { throw 'Unexpected archive entries.' }
foreach ($file in $manifest) {
    $path = Join-Path $destination $file.path
    if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-Sha256Hash $path) -ne $file.sha256) { throw "Manifest mismatch: $($file.path)" }
}
$result = [ordered]@{testedAt=[DateTime]::UtcNow.ToString('o');archive=[System.IO.Path]::GetFileName($archivePath);archiveSha256=(Get-Sha256Hash $archivePath);verifiedFiles=$manifest.Count;excludedPrivateFiles=$true;freshInstall=$false;testAndBuild=$false;productionAudit=$false;scope='Fresh local ZIP extraction, npm install, unit tests, static build and audit. Not cloud deployment.'}
Push-Location $destination
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Fresh dependency install failed.' }
    $result.freshInstall = $true
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Fresh tests or build failed.' }
    $result.testAndBuild = $true
    & npm.cmd audit --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'Dependency audit failed.' }
    $result.productionAudit = $true
} finally {
    Pop-Location
    [System.IO.File]::WriteAllText(($archivePath + '.verification.json'),($result | ConvertTo-Json),[System.Text.UTF8Encoding]::new($false))
}
Write-Host "Verified $($manifest.Count) archived files and fresh installation: $destination"

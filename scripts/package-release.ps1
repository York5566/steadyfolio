$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$root = (Get-Location).Path
function Get-Sha256Hash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
if (-not (Test-Path -LiteralPath 'dist/zh-Hant/index.html')) { throw 'Run npm run check before packaging.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$release = Join-Path $root 'release'
[System.IO.Directory]::CreateDirectory($release) | Out-Null
$name = 'Steadyfolio-Web-1.0.0-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$destination = Join-Path $release ($name + '.zip')
$files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
foreach ($folder in @('.github','src','worker','migrations','scripts','tests','public','examples','dist')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $folder) -File -Force -Recurse) {
        if ($file.FullName -notmatch '[\\/]__pycache__[\\/]' -and $file.Extension -ne '.pyc') { $files.Add($file) }
    }
}
foreach ($pattern in @('*.md','*.cmd','package.json','package-lock.json','tsconfig.json','vite.config.ts','vitest.config.ts','index.html','wrangler.jsonc','.gitignore','.env.example','.dev.vars.example')) {
    foreach ($file in Get-ChildItem -Path (Join-Path $root $pattern) -File -Force) { $files.Add($file) }
}
foreach ($name in @('api-smoke.json','static-site.json','ui-checks.json','data-source-correction.json','automatic-market-smoke.json','automatic-ui.json','current-market-smoke.json','current-market-before-us-close.json','fetch-fixes-ui.json','desktop-zh.jpg','mobile-zh.jpg','mobile-en.jpg')) {
    $path = Join-Path $root ('acceptance/' + $name)
    if (Test-Path -LiteralPath $path) { $files.Add((Get-Item -LiteralPath $path)) }
}
$archive = [System.IO.Compression.ZipFile]::Open($destination,[System.IO.Compression.ZipArchiveMode]::Create)
$manifest = [System.Collections.Generic.List[object]]::new()
try {
    foreach ($file in $files | Sort-Object FullName -Unique) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        if ($relative -match '(^|/)(node_modules|data-private|\.wrangler|\.git)(/|$)' -or $relative -eq '.dev.vars' -or $relative -eq '.env' -or $relative -eq 'wrangler.deploy.json') { throw "Excluded file: $relative" }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $manifest.Add([pscustomobject]@{path=$relative;bytes=$file.Length;sha256=(Get-Sha256Hash $file.FullName)})
    }
    $entry = $archive.CreateEntry('release-manifest.json')
    $writer = [System.IO.StreamWriter]::new($entry.Open(),[System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($manifest | ConvertTo-Json -Depth 3)) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
$checksum = Get-Sha256Hash $destination
[System.IO.File]::WriteAllText(($destination + '.sha256'), "$checksum  $([System.IO.Path]::GetFileName($destination))`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Packaged $($manifest.Count) files: $destination"
Write-Host "SHA256: $checksum"

[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $repo
$destRoot = Join-Path $repo 'extensions'

$map = [ordered]@{
    'instacloud-extension'         = 'instacloud'
    'obsidian-panel'               = 'obsidian-panel'
    'openchamber-instabox-matrix'  = 'instabox-matrix'
    'openchamber-shardx-workspace' = 'shardx-workspace'
    'openwith-matrix'              = 'openwith-matrix'
}

$excludeDirs = @('.git', 'node_modules', '_temp', '.turbo', '.cache')
$excludeFiles = @('*.log', '*.tmp', '*.tsbuildinfo', '.env', '.env.*')

function Test-Excluded([string]$relativePath) {
    $parts = $relativePath -split '[\\/]'
    foreach ($dir in $excludeDirs) {
        if ($parts -contains $dir) { return $true }
    }
    $leaf = Split-Path $relativePath -Leaf
    foreach ($pattern in $excludeFiles) {
        if ($leaf -like $pattern) { return $true }
    }
    return $false
}

function Get-SnapshotFiles([string]$base) {
    $baseFull = (Resolve-Path -LiteralPath $base).Path
    Get-ChildItem -LiteralPath $baseFull -Recurse -File -Force | Where-Object {
        $relative = $_.FullName.Substring($baseFull.Length).TrimStart('\', '/')
        -not (Test-Excluded $relative)
    }
}

function Get-RelativeMap([string]$base) {
    $baseFull = (Resolve-Path -LiteralPath $base).Path
    $result = @{}
    foreach ($file in (Get-SnapshotFiles $base)) {
        $relative = $file.FullName.Substring($baseFull.Length).TrimStart('\', '/')
        $result[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    return $result
}

$failures = 0

foreach ($sourceName in $map.Keys) {
    $source = Join-Path $root $sourceName
    $target = Join-Path $destRoot $map[$sourceName]
    $label = $map[$sourceName]

    if (-not (Test-Path -LiteralPath $source)) {
        Write-Host "MISSING SOURCE   $source"
        $failures++
        continue
    }

    if ($Check) {
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Host "MISSING SNAPSHOT $target"
            $failures++
            continue
        }

        $sourceMap = Get-RelativeMap $source
        $targetMap = Get-RelativeMap $target
        $targetMap.Remove('SOURCE.json') | Out-Null

        $all = @($sourceMap.Keys + $targetMap.Keys | Sort-Object -Unique)
        $differences = 0
        foreach ($relative in $all) {
            $inSource = $sourceMap.ContainsKey($relative)
            $inTarget = $targetMap.ContainsKey($relative)
            if (-not $inSource) {
                Write-Host "ONLY SNAPSHOT    $label/$relative"
                $differences++
            } elseif (-not $inTarget) {
                Write-Host "ONLY SOURCE      $label/$relative"
                $differences++
            } elseif ($sourceMap[$relative] -ne $targetMap[$relative]) {
                Write-Host "CHANGED          $label/$relative"
                $differences++
            }
        }

        if ($differences -eq 0) {
            Write-Host "OK               $label ($($sourceMap.Count) files)"
        } else {
            $failures++
        }
    } else {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        $arguments = @($source, $target, '/E', '/XD') + $excludeDirs + @('/XF') + $excludeFiles + @('/NFL', '/NDL', '/NJH', '/NJS', '/NP')
        & robocopy @arguments | Out-Null
        if ($LASTEXITCODE -ge 8) {
            Write-Host "FAILED           $label (robocopy $LASTEXITCODE)"
            $failures++
        } else {
            Write-Host "SYNCED           $label"
        }
    }
}

if ($failures -gt 0) {
    Write-Host ""
    Write-Host "$failures extension(s) need attention."
    exit 1
}

Write-Host ""
Write-Host "All extensions are in sync."

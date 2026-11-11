# dsh-ego-browser-cli installer
# Installs the runtime payload and registers it in a DSH profile.
# Usage: powershell -File install.ps1 [-Profile desktop] [-DshHome C:\path]
# Never elevates. Successful upgrades retain the previous payload and manifest.

[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
    [switch]$Force
)

$ErrorActionPreference = "Stop"
function Write-Step($msg) { Write-Host "  $msg" }
function Require-Object($value, $label) {
    if ($value -isnot [pscustomobject]) { throw "$label must be a JSON object" }
}
function Read-Manifest($path, $label) {
    $raw = [System.IO.File]::ReadAllText($path)
    # Windows PowerShell can unwrap a one-element root array while parsing.
    if (-not $raw.TrimStart().StartsWith("{")) { throw "$label must be a JSON object" }
    $value = $raw | ConvertFrom-Json
    Require-Object $value $label
    return $value
}

Write-Host "dsh-ego-browser-cli installer"
$stage = $null
$backup = $null
$oldPayloadMoved = $false
$oldManifestMoved = $false
$newPayloadMoved = $false
$newManifestMoved = $false
$committed = $false
try {
    # Validate every runtime file and both manifests before creating any install files.
    $source = $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $source "index.js") -PathType Leaf)) {
        $source = Split-Path -Parent $source
    }
    $payloadFiles = @("index.js", "proxy.js", "package.json", "cordis.patch.yml", "LICENSE")
    foreach ($file in $payloadFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
            throw "required source payload missing: $file (in $source)"
        }
    }
    $sourcePkg = Read-Manifest (Join-Path $source "package.json") "source package.json"
    if ($sourcePkg.name -cne "dsh-ego-browser-cli") { throw "unexpected source package name" }

    $profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile
    if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) { throw "profile not found: $profileDir" }
    $pkgPath = Join-Path $profileDir "package.json"
    if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) { throw "profile package.json not found: $pkgPath" }
    $pkg = Read-Manifest $pkgPath "profile package.json"
    foreach ($entry in @(@($pkg, "dependencies"), @($pkg, "dsh"))) {
        if ($null -eq $entry[0].($entry[1])) {
            $entry[0] | Add-Member -NotePropertyName $entry[1] -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        Require-Object $entry[0].($entry[1]) $entry[1]
    }
    if ($null -eq $pkg.dsh.profile) {
        $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    Require-Object $pkg.dsh.profile "dsh.profile"
    if ($null -ne $pkg.dsh.profile.bundles -and $pkg.dsh.profile.bundles -isnot [array]) {
        throw "dsh.profile.bundles must be a JSON array"
    }
    $bundles = @()
    if ($null -ne $pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
    if ($bundles -cnotcontains "dsh-ego-browser-cli") { $bundles += "dsh-ego-browser-cli" }
    $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue ([object[]]$bundles) -Force

    $modules = Join-Path $profileDir "node_modules"
    $target = Join-Path $modules "dsh-ego-browser-cli"
    if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "payload target must be a directory: $target"
    }
    $depValue = "file:$($target -replace '\\', '/')"
    $pkg.dependencies | Add-Member -NotePropertyName "dsh-ego-browser-cli" -NotePropertyValue $depValue -Force
    # Serialize the parsed object directly: nested arrays stay arrays, including
    # one-element bundles, and unrelated bundles properties are never rewritten.
    $json = ConvertTo-Json -InputObject $pkg -Depth 100

    $id = [guid]::NewGuid().ToString("N")
    $stage = Join-Path $profileDir ".dsh-ego-browser-cli.stage.$id"
    $backup = Join-Path $profileDir ".dsh-ego-browser-cli.backup.$id"
    $stagedPayload = Join-Path $stage "payload"
    New-Item -ItemType Directory -Path $stagedPayload -Force | Out-Null
    foreach ($file in $payloadFiles) {
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $stagedPayload $file)
    }
    [System.IO.File]::WriteAllText((Join-Path $stage "package.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
    New-Item -ItemType Directory -Path $modules -Force | Out-Null
    New-Item -ItemType Directory -Path $backup | Out-Null

    # Same-filesystem moves, with rollback for caught errors. These two paths
    # cannot be swapped together atomically across an OS crash or power loss.
    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination (Join-Path $backup "payload")
        $oldPayloadMoved = $true
    }
    Move-Item -LiteralPath $pkgPath -Destination (Join-Path $backup "package.json")
    $oldManifestMoved = $true
    Move-Item -LiteralPath $stagedPayload -Destination $target
    $newPayloadMoved = $true
    Move-Item -LiteralPath (Join-Path $stage "package.json") -Destination $pkgPath
    $newManifestMoved = $true
    $committed = $true
    Write-Step "installed plugin files -> $target"
    Write-Step "registered bundle and dependency in $pkgPath"
    Write-Step "previous manifest and payload (when present): $backup"
} catch {
    $committed = $false
    $failure = $_
    try {
        if ($newManifestMoved) { Remove-Item -LiteralPath $pkgPath -Force }
        if ($newPayloadMoved) { Remove-Item -LiteralPath $target -Recurse -Force }
        if ($oldManifestMoved) { Move-Item -LiteralPath (Join-Path $backup "package.json") -Destination $pkgPath }
        if ($oldPayloadMoved) { Move-Item -LiteralPath (Join-Path $backup "payload") -Destination $target }
    } catch {
        Write-Host "ERROR: rollback failed: $_. Recovery files: $backup"
    }
    Write-Host "ERROR: $failure"
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        try { Remove-Item -LiteralPath $stage -Recurse -Force } catch { Write-Warning "could not remove staging directory: $stage" }
    }
}
if (-not $committed) { exit 1 }
Write-Step "no skill installed (permission-only plugin)"
$egoFound = $null
foreach ($candidate in @(
    (Join-Path $env:USERPROFILE ".local\share\ego\active_version_dir\ego-browser.exe"),
    (Join-Path $env:USERPROFILE ".local\bin\ego-browser")
)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $egoFound = $candidate; break }
}
if (-not $egoFound) {
    $cmd = Get-Command ego-browser -ErrorAction SilentlyContinue
    if ($cmd) { $egoFound = $cmd.Source }
}
if ($egoFound) {
    Write-Step "ego-browser found: $egoFound"
} else {
    Write-Host "NOTE: ego-browser was not found on this machine."
    Write-Host "      Install Ego Lite from https://lite.ego.app/ and finish its onboarding."
    Write-Host "      The plugin resolves it at startup, so finish that first."
}
Write-Host "Done. Restart DeepSeek Harness to load the plugin."
Write-Host "After restart, the 'ego_browser' tool becomes available."
Write-Host "For manual rollback, restore package.json and payload from $backup."

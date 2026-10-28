# dsh-ego-browser-cli installer
#
# Installs the plugin into a DSH profile and wires it into that profile's
# package.json (both `dependencies` and `dsh.profile.bundles`). Idempotent:
# re-running upgrades the files in place and backs up package.json once.
#
# Usage:
#   pwsh -File install.ps1                      # default profile: desktop
#   pwsh -File install.ps1 -Profile tui         # another profile
#   pwsh -File install.ps1 -SkillDir C:\path    # custom skill location
#   pwsh -File install.ps1 -NoSkill             # skip the skill
#
# Never elevates. Fails loudly instead of guessing a path.

[CmdletBinding()]
param(
    [string]$Profile = "desktop",
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }),
    [string]$SkillDir = "",
    [switch]$NoSkill,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "  $msg" }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Write-Host "dsh-ego-browser-cli installer" -ForegroundColor Cyan
Write-Host ""

# ---- locate source ----
# Works both in the repo layout (script in scripts/, payload one level up) and
# when the script is copied next to the payload.
$source = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $source "index.js") -PathType Leaf)) {
    $parent = Split-Path -Parent $source
    if ($parent -and (Test-Path -LiteralPath (Join-Path $parent "index.js") -PathType Leaf)) {
        $source = $parent
    } else {
        Fail "index.js not found next to install.ps1 or one level up (looked in $PSScriptRoot and $parent). Run the script from the unpacked package."
    }
}

# ---- validate profile ----
$profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile
if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
    $available = @()
    $profilesRoot = Join-Path $DshHome "profiles"
    if (Test-Path -LiteralPath $profilesRoot) {
        $available = Get-ChildItem -LiteralPath $profilesRoot -Directory | Select-Object -ExpandProperty Name
    }
    Fail "profile '$Profile' not found at $profileDir. Available: $(if ($available) { $available -join ', ' } else { '(none)' })"
}
Write-Step "profile: $profileDir"

# ---- target dir (a normal dependency directory, so Node resolution finds it) ----
$target = Join-Path (Join-Path $profileDir "node_modules") "dsh-ego-browser-cli"
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($file in @("index.js", "package.json", "cordis.patch.yml", "LICENSE")) {
    $from = Join-Path $source $file
    if (Test-Path -LiteralPath $from -PathType Leaf) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $target $file) -Force
    }
}
$skillSource = Join-Path $source "skill\SKILL.md"
if (Test-Path -LiteralPath $skillSource -PathType Leaf) {
    New-Item -ItemType Directory -Force -Path (Join-Path $target "skill") | Out-Null
    Copy-Item -LiteralPath $skillSource -Destination (Join-Path $target "skill\SKILL.md") -Force
}
Write-Step "installed plugin files -> $target"

# ---- wire package.json (dependencies + bundles) ----
$pkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $pkgPath -PathType Leaf)) {
    Fail "profile package.json not found: $pkgPath"
}

# Rendered new package.json; written only when it differs from the current one.
$backup = ""
$newPkgPath = "$pkgPath.new.$PID"

$raw = [System.IO.File]::ReadAllText($pkgPath)
$pkg = $raw | ConvertFrom-Json

if ($null -eq $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}

$depValue = "file:$($target -replace '\\', '/')"
$alreadyDep = $pkg.dependencies.PSObject.Properties.Name -contains "dsh-ego-browser-cli"
if ($alreadyDep) {
    $pkg.dependencies."dsh-ego-browser-cli" = $depValue
} else {
    $pkg.dependencies | Add-Member -NotePropertyName "dsh-ego-browser-cli" -NotePropertyValue $depValue
}
Write-Step "dependency: dsh-ego-browser-cli = $depValue"

$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains "dsh-ego-browser-cli") {
    $bundles += "dsh-ego-browser-cli"
    $pkg.dsh.profile.bundles = $bundles
    Write-Step "bundle registered"
} else {
    Write-Step "bundle already registered"
}

# ConvertTo-Json collapses a single-element array into a bare string, which
# would silently break the bundle list. Re-splice the bundles value as a real
# JSON array, matching either an existing array or the collapsed string form.
$bundleJson = ($bundles | ForEach-Object { '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"' }) -join ', '
$json = $pkg | ConvertTo-Json -Depth 32
$json = [regex]::Replace(
    $json,
    '("bundles"\s*:\s*)(\[[^\]]*\]|"(?:[^"\\]|\\.)*")',
    ('${1}[' + $bundleJson + ']')
)

if ((Test-Path -LiteralPath $newPkgPath -PathType Leaf)) { Remove-Item -LiteralPath $newPkgPath -Force }
[System.IO.File]::WriteAllText($newPkgPath, $json)

$current = [System.IO.File]::ReadAllText($pkgPath)
if ($current -ceq $json) {
    Remove-Item -LiteralPath $newPkgPath -Force
    Write-Step "package.json already up to date"
} else {
    $backup = "$pkgPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $pkgPath -Destination $backup
    Move-Item -LiteralPath $newPkgPath -Destination $pkgPath -Force
    Write-Step "package.json updated (backup: $(Split-Path -Leaf $backup))"
}

# ---- install the skill ----
if (-not $NoSkill) {
    if (-not $SkillDir) {
        $SkillDir = Join-Path (Join-Path $env:USERPROFILE ".agents\skills") "ego-browser-cli"
    }
    New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
    $skillTarget = Join-Path $SkillDir "SKILL.md"

    # Ego Lite can expose its bundled skill as a junction; replace it rather than
    # writing through the link.
    if (Test-Path -LiteralPath $SkillDir) {
        $item = Get-Item -LiteralPath $SkillDir -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            if (Test-Path -LiteralPath $skillTarget -PathType Leaf) {
                Copy-Item -LiteralPath $skillTarget -Destination (Join-Path $SkillDir "SKILL.official.md") -Force
            }
            [System.IO.Directory]::Delete($SkillDir, $false)
            New-Item -ItemType Directory -Path $SkillDir | Out-Null
            Write-Step "replaced skill junction with a local directory"
        }
    }
    if (Test-Path -LiteralPath $skillSource -PathType Leaf) {
        Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Force
        Write-Step "skill installed -> $skillTarget"
    }
} else {
    Write-Step "skill skipped (-NoSkill)"
}

# ---- verify ego-browser is discoverable ----
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

Write-Host ""
if ($egoFound) {
    Write-Step "ego-browser found: $egoFound"
} else {
    Write-Host "NOTE: ego-browser was not found on this machine." -ForegroundColor Yellow
    Write-Host "      Install Ego Lite from https://lite.ego.app/ and finish its onboarding." -ForegroundColor Yellow
    Write-Host "      The plugin resolves it at startup, so finish that first." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Restart DeepSeek Harness to load the plugin." -ForegroundColor Green
Write-Host "After restart, the 'ego_browser' tool becomes available." -ForegroundColor Green
Write-Host ""
if ($backup) {
    Write-Host "Rollback: restore $backup over package.json, delete $target, then restart."
} else {
    Write-Host "Rollback: delete $target and remove the dsh-ego-browser-cli entry from"
    Write-Host "          $pkgPath, then restart."
}

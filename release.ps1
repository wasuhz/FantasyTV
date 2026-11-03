# Publish a new FantasyTV: bumps the version, builds the signed APK, and puts it on
# github.com/wasuhz/FantasyTV-releases. Every TV running FantasyTV sees it within 6 hours (or at its next start)
# and offers "Update available - OK: update now".
#
#   .\release.ps1 "What's new, one line"            # 1.0.20 -> 1.0.21
#   .\release.ps1 "Big change" -Version 1.1.0       # pick the version name yourself
# Blocked by "running scripts is disabled"? powershell -ExecutionPolicy Bypass -File .\release.ps1 "What's new"
param(
    [Parameter(Mandatory = $true)][string]$Notes,
    [string]$Version
)
$ErrorActionPreference = 'Stop'
$repo = 'wasuhz/FantasyTV-releases'
$root = $PSScriptRoot
$gradle = Join-Path $root 'android\app\build.gradle'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'

if (-not (Test-Path (Join-Path $root '..\FantasyTV-keys\keystore.properties'))) {
    throw 'The release key (..\FantasyTV-keys) is missing. Updates must be signed with the same key every time.'
}

# Bump: versionCode goes up by one; versionName is -Version, or the minor number goes up.
$text = Get-Content $gradle -Raw
$code = [int]([regex]::Match($text, 'versionCode (\d+)').Groups[1].Value) + 1
$old = [regex]::Match($text, "versionName '([^']+)'").Groups[1].Value
if (-not $Version) { $p = $old.Split('.'); $p[-1] = [int]$p[-1] + 1; $Version = $p -join '.' }   # 1.0.20 -> 1.0.21
$text = $text -replace 'versionCode \d+', "versionCode $code" -replace "versionName '[^']+'", "versionName '$Version'"
[IO.File]::WriteAllText($gradle, $text)   # no BOM
Write-Host "FantasyTV $old -> $Version (code $code)"

Push-Location (Join-Path $root 'android')
try { .\gradlew.bat assembleRelease -q; if ($LASTEXITCODE) { throw 'Build failed' } } finally { Pop-Location }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item (Join-Path $root 'android\app\build\outputs\apk\release\app-release.apk') (Join-Path $dist 'FantasyTV.apk') -Force
[ordered]@{
    versionCode = $code
    versionName = $Version
    notes       = $Notes
    apk         = "https://github.com/$repo/releases/download/v$Version/FantasyTV.apk"
} | ConvertTo-Json | Set-Content (Join-Path $dist 'latest.json') -Encoding ascii

& $gh release create "v$Version" (Join-Path $dist 'FantasyTV.apk') (Join-Path $dist 'latest.json') --repo $repo --title "FantasyTV $Version" --notes $Notes
if ($LASTEXITCODE) { throw 'Publishing to GitHub failed (the version bump is still in build.gradle)' }

git -C $root add android/app/build.gradle
git -C $root commit -m "Release $Version" | Out-Null
Write-Host "Published FantasyTV $Version. Download: https://github.com/$repo/releases/latest/download/FantasyTV.apk"

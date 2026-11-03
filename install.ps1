# Builds the FantasyTV app and installs it on a TV over adb, then opens it.
#   .\install.ps1 192.168.x.x:5555    # that TV (adb connect it first)
#   .\install.ps1                      # the TV saved in .tv (one line, "address:5555"; git ignores it)
param([string]$Tv)
$ErrorActionPreference = 'Stop'
if (-not $Tv -and (Test-Path "$PSScriptRoot\.tv")) { $Tv = (Get-Content "$PSScriptRoot\.tv" -TotalCount 1).Trim() }
if (-not $Tv) { throw 'Which TV? Pass its address (.\install.ps1 192.168.x.x:5555) or save it in a .tv file next to this script.' }
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot'   # Gradle 8 needs JDK 17, not Android Studio's newer one
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
cmd /c "`"$PSScriptRoot\android\gradlew.bat`" -p `"$PSScriptRoot\android`" assembleRelease --console=plain -q"
if ($LASTEXITCODE) { throw 'Build failed' }
& $adb -s $Tv install -r "$PSScriptRoot\android\app\build\outputs\apk\release\app-release.apk"
& $adb -s $Tv shell am start -S -n com.fantasytv.app/.MainActivity

# Starts the FantasyTV test server on http://localhost:8765/ (and your PC's Wi-Fi address, for the phone remote).
# Uses the JDK that Android Studio already installed. Ctrl+C stops it.
param([int]$Port = 8765)
Set-Location $PSScriptRoot
$java = (Get-Command java -ErrorAction SilentlyContinue).Source
if (-not $java) { $java = 'C:\Program Files\Android\Android Studio\jbr\bin\java.exe' }
& $java server/Server.java $Port

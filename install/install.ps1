# PodDirector installer for Windows (per-user, no admin rights needed).
#   - copies the extension to %APPDATA%\Adobe\CEP\extensions\PodDirector
#   - unblocks the bundled ffmpeg / whisper executables (downloaded zips are "blocked" by Windows)
#   - enables loading unsigned CEP extensions (PlayerDebugMode) for Premiere's CEP runtimes
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$name   = "PodDirector"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$name"
$source = Join-Path $PSScriptRoot $name

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

if (Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue) {
  Say "Premiere Pro is running. Please save your work and close it, then press Enter to continue." Yellow
  [void](Read-Host)
}

if ($Uninstall) {
  if (Test-Path $target) { Remove-Item $target -Recurse -Force; Say "Removed $target" Green }
  else { Say "PodDirector is not installed." }
  Say "Your presets and transcripts in Documents\PodDirector were left in place."
  exit 0
}

if (-not (Test-Path (Join-Path $source "CSXS\manifest.xml"))) {
  Say "Can't find the PodDirector folder next to this installer ($source)." Red
  exit 1
}

Say "Installing PodDirector to $target ..." Cyan
New-Item -ItemType Directory -Force -Path $target | Out-Null
# Mirror the folder (removes files from older versions).
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Say "Copy failed (robocopy code $LASTEXITCODE)." Red; exit 1 }

Get-ChildItem -Path $target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

foreach ($v in 9..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}

# Quick self-test of the bundled tools.
$ff = Join-Path $target "vendor\ffmpeg\win32-x64\ffmpeg.exe"
$wh = Join-Path $target "vendor\whisper\win32-x64\whisper-cli.exe"
try { & $ff -hide_banner -version | Select-Object -First 1 | Out-Null; Say "  ffmpeg ........ OK" Green } catch { Say "  ffmpeg ........ could not run ($ff)" Yellow }
if (Test-Path $wh) { Say "  transcriber ... OK" Green } else { Say "  transcriber ... missing" Yellow }

Say ""
Say "Done! Start Premiere Pro, then open:  Window > Extensions > PodDirector" Green

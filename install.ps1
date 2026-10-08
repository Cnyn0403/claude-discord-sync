# Install claude-discord-sync on Windows, then run its setup (PowerShell):
#   irm https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.ps1 | iex
# A specific release:  $env:CDS_VERSION = 'v0.2.0'; irm ... | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar

$repo = 'Cnyn0403/claude-discord-sync'
$asset = 'claude-discord-sync-windows-x64.exe'
$base = if ($env:CDS_VERSION) { "https://github.com/$repo/releases/download/$($env:CDS_VERSION)" } else { "https://github.com/$repo/releases/latest/download" }
$dir = Join-Path $env:LOCALAPPDATA 'claude-discord-sync'
$exe = Join-Path $dir 'claude-discord-sync.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "Downloading $asset..."
Invoke-WebRequest "$base/$asset" -OutFile "$exe.new" -UseBasicParsing
$sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing).Content)
$line = $sums -split "`n" | Where-Object { ($_ -split '\s+')[1] -eq $asset } | Select-Object -First 1
$expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
$actual = (Get-FileHash "$exe.new" -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) {
  Remove-Item -Force "$exe.new"
  throw "Checksum mismatch for $asset; aborting."
}

# Stop the daemon so it restarts on the new version. Sessions started with ccd keep running:
# a running .exe can't be overwritten, but it can be renamed out of the way.
Get-CimInstance Win32_Process -Filter "Name='claude-discord-sync.exe'" |
  Where-Object { $_.CommandLine -match ' daemon' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
if (Test-Path $exe) { Move-Item -Force $exe "$exe.old" }
Move-Item -Force "$exe.new" $exe

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir").TrimStart(';'), 'User')
}
if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
Write-Host "Installed $exe"

& $exe setup

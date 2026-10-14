# Build the desktop shell (debug) and run it against THIS checkout, in an isolated instance.
#   .\desktop\dev.ps1                 build + run on port 3601
#   .\desktop\dev.ps1 -NoBuild        run the last build
#   .\desktop\dev.ps1 -Port 3650
#   .\desktop\dev.ps1 -DebugPort 9333   WebView2 DevTools protocol on 127.0.0.1 (for automated checks)
# Isolation: the server runs as CODEMAN_INSTANCE=sbdev (own data dir ~/.codeman-sbdev and tmux socket
# codeman-sbdev inside WSL, so it never sees your real Codeman sessions) and the shell reads
# desktop\dev-config.json instead of %LOCALAPPDATA%\Switchboard\config.json.
# Close the window to stop the server; tmux sessions of the sbdev instance stay.
param([int]$Port = 3601, [switch]$NoBuild, [int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$wslRoot = (wsl.exe --exec wslpath -a ($root.Path -replace '\\', '/')).Trim()
if (-not $wslRoot) { throw 'Could not translate the checkout path for WSL (is WSL installed?)' }

$env:Path += ';' + (Join-Path $env:USERPROFILE '.cargo\bin')
# Keep build output out of the checkout (it is large and not part of the product).
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'Switchboard\build-target' }

if (-not $NoBuild) {
  Push-Location (Join-Path $PSScriptRoot 'src-tauri')
  # cargo writes progress to stderr; that must not count as an error, only the exit code does.
  $ErrorActionPreference = 'Continue'
  try { cargo tauri build --debug --no-bundle; if ($LASTEXITCODE -ne 0) { throw 'build failed' } } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
}

$config = [ordered]@{
  port          = $Port
  start_command = "$wslRoot/desktop/wsl/bin/start"
  stop_command  = "$wslRoot/desktop/wsl/bin/stop"
} | ConvertTo-Json
$configFile = Join-Path $PSScriptRoot 'dev-config.json'
[IO.File]::WriteAllText($configFile, $config)

$env:SWITCHBOARD_CONFIG = $configFile
$env:CODEMAN_INSTANCE = 'sbdev'
$env:SWITCHBOARD_DEV = '1'
$env:SWITCHBOARD_APP_DIR = $wslRoot
$env:SWITCHBOARD_HOME = '~/.switchboard-dev'
$env:WSLENV = 'CODEMAN_INSTANCE:SWITCHBOARD_DEV:SWITCHBOARD_APP_DIR:SWITCHBOARD_HOME'
if ($DebugPort -gt 0) { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort" }
Start-Process -FilePath (Join-Path $env:CARGO_TARGET_DIR 'debug\switchboard-desktop.exe')

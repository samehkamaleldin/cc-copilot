# cc-copilot bootstrap installer (Windows / PowerShell)
#
#   irm https://raw.githubusercontent.com/<you>/cc-copilot/main/install.ps1 | iex
#
# Clones (or updates) the repo, installs dependencies, adds the `cc-copilot`
# command to your PATH, then prints the next steps.

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host "Error: $m" -ForegroundColor Red; exit 1 }

$RepoUrl    = if ($env:CC_COPILOT_REPO) { $env:CC_COPILOT_REPO } else { "https://github.com/your-org/cc-copilot.git" }
$InstallDir = if ($env:CC_COPILOT_HOME) { $env:CC_COPILOT_HOME } else { Join-Path $HOME ".cc-copilot\app" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node (>=20) is required. Install from https://nodejs.org" }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Die "git is required." }
$nodeMajor = (node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 20) { Die "node >= 20 required (found $(node -v))." }

if (Test-Path (Join-Path $InstallDir ".git")) {
  Info "Updating cc-copilot in $InstallDir"
  git -C $InstallDir pull --ff-only
} else {
  Info "Cloning cc-copilot into $InstallDir"
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  git clone --depth 1 $RepoUrl $InstallDir
}

Info "Installing dependencies"
Push-Location $InstallDir
npm install --omit=dev --no-fund --no-audit
Pop-Location

# Create a shim batch file on PATH (WindowsApps user dir or ~/bin).
$BinDir = Join-Path $HOME "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cliPath = Join-Path $InstallDir "bin\cli.mjs"
$cmd = "@echo off`r`nnode `"$cliPath`" %*`r`n"
Set-Content -Path (Join-Path $BinDir "cc-copilot.cmd") -Value $cmd -Encoding ASCII
Info "Created $BinDir\cc-copilot.cmd"

# Add ~/bin to the user PATH if missing.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  Info "Added $BinDir to your user PATH (restart your terminal)."
}

Write-Host ""
Write-Host "cc-copilot installed." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  cc-copilot auth        # one-time GitHub Copilot login"
Write-Host "  cc-copilot install     # configure Claude Code + start the service"
Write-Host ""
Write-Host "Then just run:  claude"

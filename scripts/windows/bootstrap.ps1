Param(
  [string]$NodeWingetId = "OpenJS.NodeJS.LTS"
)

# Best-effort bootstrap for Windows:
# - If node/npm are missing, try to install Node.js LTS via winget
# - Then run repo dependency install script
#
# This is NOT guaranteed to be fully unattended:
# - winget may prompt for agreements/UAC depending on your system/policies.
# - winget may be unavailable on some Windows installations.
#
# Run from PowerShell.

function Has-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "m3uHandler Windows bootstrap"
Write-Host "If this script is blocked by PowerShell execution policy, run it with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\\windows\\bootstrap.ps1"
Write-Host ""

if (-not (Has-Command "node") -or -not (Has-Command "npm")) {
  Write-Warning "node/npm not found. Attempting to install Node.js LTS via winget ($NodeWingetId)..."

  if (-not (Has-Command "winget")) {
    Write-Error "winget is not available on this system. Install 'App Installer' from Microsoft Store or install Node.js manually from https://nodejs.org/."
    exit 1
  }

  # winget may prompt for agreements/UAC depending on system policy
  winget install --id $NodeWingetId --source winget

  if ($LASTEXITCODE -ne 0) {
    Write-Error "winget install failed (exit=$LASTEXITCODE). Install Node.js manually from https://nodejs.org/ and re-run this script."
    exit 1
  }

  # Refresh PATH in current session (best-effort)
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machinePath + ";" + $userPath)
}

Write-Host "Installing repo dependencies..."
node scripts/install-deps.js

if ($LASTEXITCODE -ne 0) {
  Write-Error "Dependency installation failed."
  exit 1
}

Write-Host "Done. You can now run (from the repo folder):"
Write-Host "  npm run gui"
Write-Host ""
Write-Host "If you just installed Node.js, open a NEW PowerShell window to ensure PATH is refreshed."

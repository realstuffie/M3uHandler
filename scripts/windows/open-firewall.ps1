Param(
  [int]$Port = 5177,
  [string]$RuleName = "m3uHandler GUI"
)

# Run this script from an elevated PowerShell (Run as Administrator).
# It will create (or update) an inbound firewall rule to allow the GUI port.

Write-Host "Adding Windows Firewall rule '$RuleName' for TCP port $Port ..."

# Remove existing rule with same name to avoid duplicates
netsh advfirewall firewall delete rule name="$RuleName" > $null 2>&1

# Add rule
netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow protocol=TCP localport=$Port

if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to add firewall rule. Make sure you are running PowerShell as Administrator."
  exit 1
}

Write-Host "Firewall rule added: $RuleName (TCP $Port)"
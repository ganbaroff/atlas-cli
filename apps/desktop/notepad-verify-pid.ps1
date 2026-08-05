param(
  [Parameter(Mandatory = $true)][int]$TargetPid
)

$ErrorActionPreference = 'Stop'
try {
  $p = Get-Process -Id $TargetPid -ErrorAction Stop
  @{
    pid = $p.Id
    name = $p.ProcessName
    path = try { $p.Path } catch { '' }
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  Write-Error "pid_not_found"
  exit 2
}

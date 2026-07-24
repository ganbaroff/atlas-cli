# CEO-gated live apply for Atlas llm_spend telemetry (M6 b1).
# Usage (requires psql or Supabase SQL editor):
#   $env:DATABASE_URL = "<postgres connection string>"
#   .\db\apply-llm-spend.ps1
#
# Order is mandatory: base table first, then correlation_id additive column.

param(
  [string]$DatabaseUrl = $env:DATABASE_URL
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not $DatabaseUrl) {
  Write-Error "Set DATABASE_URL or pass -DatabaseUrl"
}

$files = @(
  (Join-Path $Root 'db\llm_spend.sql'),
  (Join-Path $Root 'db\llm_spend_correlation_id.sql')
)

foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Error "Missing $f" }
  Write-Host "Applying $f ..."
  & psql $DatabaseUrl -v ON_ERROR_STOP=1 -f $f
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "OK — llm_spend + correlation_id applied."

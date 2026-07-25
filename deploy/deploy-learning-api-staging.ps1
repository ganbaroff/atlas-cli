# Deploy Atlas learning API to Cloud Run STAGING only.
# Requires: gcloud auth, Secret Manager secret (no key in repo/YAML).
#
#   $env:PROJECT_ID = "your-gcp-project"
#   ./deploy/deploy-learning-api-staging.ps1

param(
  [string]$ProjectId = $env:PROJECT_ID,
  [string]$Region = "us-central1",
  [string]$ServiceName = "atlas-learning-api-staging",
  [string]$SecretName = "atlas-learning-api-key-staging"
)

if (-not $ProjectId) {
  Write-Error "Set PROJECT_ID or pass -ProjectId"
  exit 1
}

$ErrorActionPreference = "Stop"
$Image = "gcr.io/$ProjectId/$ServiceName"

Write-Host "Enabling required APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project=$ProjectId --quiet

if (-not (gcloud secrets describe $SecretName --project=$ProjectId 2>$null)) {
  $Key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
  Write-Host "Creating Secret Manager secret $SecretName (value not printed)"
  $Key | gcloud secrets create $SecretName --project=$ProjectId --data-file=- --replication-policy=automatic
} else {
  Write-Host "Secret $SecretName already exists - reusing latest version"
}

Write-Host "Building image $Image ..."
gcloud builds submit --project=$ProjectId --tag $Image -f Dockerfile.learning-api .

Write-Host "Deploying $ServiceName to Cloud Run staging..."
gcloud run deploy $ServiceName `
  --project=$ProjectId `
  --image=$Image `
  --region=$Region `
  --no-allow-unauthenticated `
  --set-secrets="ATLAS_LEARNING_API_KEY=${SecretName}:latest" `
  --set-env-vars="NODE_ENV=production,ATLAS_LEARNING_STATE_DIR=/tmp/atlas-learning" `
  --min-instances=0 `
  --max-instances=2 `
  --memory=512Mi `
  --timeout=60 `
  --port=8080 `
  --quiet

$url = gcloud run services describe $ServiceName --project=$ProjectId --region=$Region --format="value(status.url)"
Write-Host "Staging URL: $url"
Write-Host "Fetch API key: gcloud secrets versions access latest --secret=$SecretName --project=$ProjectId"

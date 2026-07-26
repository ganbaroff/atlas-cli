# Deploy Atlas learning API to Cloud Run STAGING only.
# Auth model: public Cloud Run ingress + app-level Bearer (ATLAS_LEARNING_API_KEY).
# Do NOT use --no-allow-unauthenticated — VOLAURA sends custom Bearer, not Google ID token.
#
#   $env:PROJECT_ID = "volaura-inc"
#   ./deploy/deploy-learning-api-staging.ps1

param(
  [string]$ProjectId = $env:PROJECT_ID,
  [string]$Region = "us-central1",
  [string]$ServiceName = "atlas-learning-api-staging",
  [string]$SecretName = "atlas-learning-api-key-staging",
  [string]$ReceiptsBucket = "atlas-learning-receipts-staging"
)

if (-not $ProjectId) {
  Write-Error "Set PROJECT_ID or pass -ProjectId"
  exit 1
}

$ErrorActionPreference = "Stop"
$Image = "gcr.io/$ProjectId/$ServiceName"
$BucketUri = "gs://$ReceiptsBucket"

Write-Host "Enabling required APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com storage.googleapis.com --project=$ProjectId --quiet

$secretExists = $false
try {
  gcloud secrets describe $SecretName --project=$ProjectId --quiet 2>$null | Out-Null
  $secretExists = $true
} catch {
  $secretExists = $false
}

if (-not $secretExists) {
  $KeyBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($KeyBytes)
  $Key = [Convert]::ToBase64String($KeyBytes)
  $tmp = Join-Path $env:TEMP "atlas-staging-key.txt"
  [IO.File]::WriteAllText($tmp, $Key)
  Write-Host "Creating Secret Manager secret $SecretName (value not printed)"
  gcloud secrets create $SecretName --project=$ProjectId --data-file=$tmp --replication-policy=automatic
  Remove-Item $tmp -Force
} else {
  Write-Host "Secret $SecretName already exists - reusing latest version"
}

if (-not (gsutil ls -b $BucketUri 2>$null)) {
  Write-Host "Creating GCS receipts bucket $BucketUri"
  gsutil mb -p $ProjectId -l $Region $BucketUri
}

Write-Host "Building image $Image (local docker; cloudbuild optional) ..."
docker build -f Dockerfile.learning-api -t "${Image}:latest" .
docker push "${Image}:latest"

Write-Host "Deploying $ServiceName (public ingress + app Bearer; maxScale=1 staging containment)..."
gcloud run deploy $ServiceName `
  --project=$ProjectId `
  --image="${Image}:latest" `
  --region=$Region `
  --allow-unauthenticated `
  --set-secrets="ATLAS_LEARNING_API_KEY=${SecretName}:latest" `
  --set-env-vars="NODE_ENV=production,ATLAS_LEARNING_STATE_DIR=/tmp/atlas-learning,ATLAS_LEARNING_RECEIPTS_BUCKET=$ReceiptsBucket" `
  --min-instances=0 `
  --max-instances=1 `
  --concurrency=1 `
  --memory=512Mi `
  --timeout=60 `
  --port=8080 `
  --quiet

$projectNumber = gcloud projects describe $ProjectId --format="value(projectNumber)"
$computeSa = "${projectNumber}-compute@developer.gserviceaccount.com"
gsutil iam ch "serviceAccount:${computeSa}:objectAdmin" $BucketUri

$url = gcloud run services describe $ServiceName --project=$ProjectId --region=$Region --format="value(status.url)"
Write-Host "Staging URL: $url"
Write-Host "Receipts bucket: $BucketUri"
Write-Host "Fetch API key: gcloud secrets versions access latest --secret=$SecretName --project=$ProjectId"

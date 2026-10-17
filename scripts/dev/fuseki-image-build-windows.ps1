param([string]$Root, [string]$Image, [string]$Docker, [string]$Bun, [string]$TagModule, [string]$Admission)
$ErrorActionPreference = 'Continue'
$taskTagModule = if ($TagModule) { $TagModule } else { Join-Path $Root 'scripts/dev/fuseki-image.ts' }
$taskAdmission = if ($Admission) { $Admission } else { Join-Path $Root 'scripts/qa/host-admission.ts' }
$taskDockerfile = Join-Path $Root 'infra/jena/Dockerfile'
function Assert-ImageInputs {
  & $Bun --eval 'const {fusekiImageTag}=await import(process.argv[1]); if(fusekiImageTag(process.argv[2])!==process.argv[3]) process.exit(1);' $taskTagModule $Root $Image
  if ($LASTEXITCODE -ne 0) { throw 'Fuseki inputs changed during image preparation' }
}
$taskMutex = New-Object System.Threading.Mutex($false, ('Global\rezics-fuseki-' + ($Image -replace '[^a-zA-Z0-9]', '-')))
$taskAcquired = $false
try {
  try { $taskAcquired = $taskMutex.WaitOne(600000) }
  catch [System.Threading.AbandonedMutexException] { $taskAcquired = $true }
  if (-not $taskAcquired) { throw 'Image build lock wait exceeded 600 seconds' }
  Assert-ImageInputs
  $global:LASTEXITCODE = $null
  & $Docker image inspect $Image *> $null
  if ($null -eq $LASTEXITCODE) { throw 'Docker inspection did not return a process exit code' }
  if ($LASTEXITCODE -eq 0) { Write-Output "Image present: $Image"; exit 0 }
  Write-Output "Building image: $Image"
  Remove-Item Env:REZICS_STACK_PROFILE -ErrorAction SilentlyContinue
  & $Bun $taskAdmission --gib 4 -- $Docker build --progress plain --file $taskDockerfile --tag $Image $Root
  if ($LASTEXITCODE -ne 0) { throw "Image build failed ($LASTEXITCODE)" }
  try { Assert-ImageInputs }
  catch { & $Docker image rm $Image; throw }
} finally {
  if ($taskAcquired) { $taskMutex.ReleaseMutex() }
  $taskMutex.Dispose()
}

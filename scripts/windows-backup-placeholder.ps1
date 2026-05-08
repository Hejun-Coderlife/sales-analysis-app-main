Param(
  [string]$ProjectRoot = ".",
  [string]$BackupRoot = "C:\apps\backups"
)

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$sourceRoot = Resolve-Path $ProjectRoot
$target = Join-Path $BackupRoot "sales-app-$timestamp"

Write-Host "Preparing backup target: $target"
New-Item -ItemType Directory -Path $target -Force | Out-Null

$pathsToBackup = @(
  "data",
  "backend\data",
  ".env"
)

foreach ($relativePath in $pathsToBackup) {
  $source = Join-Path $sourceRoot $relativePath
  if (Test-Path $source) {
    $dest = Join-Path $target $relativePath
    $destParent = Split-Path $dest -Parent
    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    Copy-Item -Path $source -Destination $dest -Recurse -Force
    Write-Host "Backed up: $relativePath"
  } else {
    Write-Host "Skipped missing path: $relativePath"
  }
}

Write-Host "Backup completed (placeholder script): $target"

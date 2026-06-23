# copy_source.ps1
# Script to copy Laravel files into desktop_wrapper/src, omitting unnecessary/recursive folders

$ErrorActionPreference = "Stop"

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$SrcDir = Join-Path $PSScriptRoot "src"

# Create src folder if it doesn't exist
if (-not (Test-Path $SrcDir)) {
    New-Item -ItemType Directory -Path $SrcDir | Out-Null
}

$ExcludeDirs = @(
    ".git",
    "desktop_wrapper",
    "node_modules",
    ".composer",
    ".config",
    "storage/logs",
    "storage/framework/cache/data"
)

Write-Host "Syncing files using robocopy..."
$exitCode = 0
try {
    # robocopy returns exit codes 0-7 for success. 8+ indicates error.
    & robocopy "$ProjectDir" "$SrcDir" /MIR /XD $ExcludeDirs /R:1 /W:1 /NDL /NFL /NJH /NJS
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = $LASTEXITCODE
}

if ($exitCode -ge 8) {
    throw "robocopy failed with exit code $exitCode"
}

# Re-create empty folders that are required but might have been excluded/emptied
$StorageFolders = @(
    "storage/app/public",
    "storage/framework/cache",
    "storage/framework/sessions",
    "storage/framework/views",
    "storage/logs"
)

foreach ($Folder in $StorageFolders) {
    $FolderPath = Join-Path $SrcDir $Folder
    if (-not (Test-Path $FolderPath)) {
        New-Item -ItemType Directory -Path $FolderPath -Force | Out-Null
    }
}

# Copy desktop env configuration to src/.env
Copy-Item -Path (Join-Path $PSScriptRoot ".env.desktop") -Destination (Join-Path $SrcDir ".env") -Force

# Delete the public/storage symlink in the destination folder to avoid electron-builder packing failures
$DestSymlink = Join-Path $SrcDir "public/storage"
if (Test-Path $DestSymlink) {
    Write-Host "Removing public/storage symlink from destination..."
    Remove-Item -Force $DestSymlink
}

Write-Host "Laravel source copied successfully!"

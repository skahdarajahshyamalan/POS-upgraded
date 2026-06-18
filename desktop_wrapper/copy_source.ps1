# copy_source.ps1
# Script to copy Laravel files into desktop_wrapper/src, omitting unnecessary/recursive folders

$ErrorActionPreference = "Stop"

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$SrcDir = Join-Path $PSScriptRoot "src"

# Create src folder if it doesn't exist
if (Test-Path $SrcDir) {
    Write-Host "Cleaning existing src folder..."
    Remove-Item -Recurse -Force $SrcDir
}
New-Item -ItemType Directory -Path $SrcDir | Out-Null

$ExcludeList = @(
    ".git",
    "desktop_wrapper",
    "node_modules",
    ".composer",
    ".config",
    "storage/logs",
    "storage/framework/cache/data"
)

Write-Host "Copying files to $SrcDir..."

# Get all child items in the project root
$Items = Get-ChildItem -Path $ProjectDir

foreach ($Item in $Items) {
    $Name = $Item.Name
    
    # Check if this name is in our exclude list
    if ($ExcludeList -contains $Name) {
        continue
    }
    
    $DestPath = Join-Path $SrcDir $Name
    
    if ($Item.PSIsContainer) {
        # Copy directory recursively
        Copy-Item -Path $Item.FullName -Destination $DestPath -Recurse -Force
    } else {
        # Copy file
        Copy-Item -Path $Item.FullName -Destination $DestPath -Force
    }
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
